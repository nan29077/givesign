import { requireAdmin, writeAudit } from '@/server/auth';
import { isSameOrigin } from '@/server/request-guard';
import { prisma } from '@/server/db';
import { decrypt } from '@/lib/crypto';
import { kstMonthEndKey } from '@/lib/datetime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 원천징수 지급명세서 산출 자료 다운로드.
 *
 * 지급 완료(PAID)된 기간별 내역을 CSV 로 내려준다. 국세청 사업소득 지급명세서 작성에 쓴다.
 * 주민등록번호는 파기 전에만 값이 있으며, 파기 후에는 마스킹만 남는다(회계 기록은 유지).
 *
 * ?from=YYYY-MM-DD&to=YYYY-MM-DD  (지급일 기준, 미지정 시 이번 달)
 *
 * ── 접근통제 ────────────────────────────────────────────────────────────
 * 이 파일에는 **주민등록번호 원문**이 들어간다.
 * 특정 등급만 배제하는 블랙리스트 방식은 등급이 추가되거나 기본값이 바뀌면 바로 뚫린다
 * (AdminPermission 기본값은 READ_ONLY 다). 반드시 화이트리스트로 유지할 것.
 */
const ALLOWED_PERMISSIONS = new Set(['SUPER_ADMIN', 'FINANCE']);

function csvCell(v: string): string {
  const needsQuote = /[",\n]/.test(v) || /^[=+\-@]/.test(v);
  const safe = /^[=+\-@]/.test(v) ? `'${v}` : v;
  return needsQuote ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export async function GET(req: Request) {
  // 이 GET 은 주민등록번호를 복호화하고 열람 이력(SETTLEMENT_WITHHOLDING_EXPORT)을 남긴다.
  // 동일 출처 검사가 없으면 로그인한 재무 관리자가 악성 페이지를 여는 것만으로
  // (<img src=...>) 주민번호가 복호화되고, 본인이 하지도 않은 반출 기록이 감사로그에 쌓인다.
  // 그 로그는 "누가 주민번호를 내려받았는가" 의 법적 근거라 오염되면 되돌릴 수 없다.
  if (!isSameOrigin(req)) {
    return new Response('허용되지 않은 요청입니다.', { status: 403 });
  }

  // 미인증 요청이 500 으로 떨어지지 않도록 여기서 401 로 정리한다.
  const admin = await requireAdmin().catch(() => null);
  if (!admin) return new Response('관리자 로그인이 필요합니다.', { status: 401 });
  if (!ALLOWED_PERMISSIONS.has(String(admin.adminPermission))) {
    return new Response('원천징수 자료는 재무(FINANCE) 또는 최고관리자만 내려받을 수 있습니다.', { status: 403 });
  }

  const url = new URL(req.url);
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const ym = kst.toISOString().slice(0, 7);
  const from = url.searchParams.get('from') || `${ym}-01`;
  // 월말은 달마다 다르다. `${ym}-31` 로 두면 2월에 2026-02-31 → 2026-03-03 으로
  // 넘어가 다음 달 초 지급건이 이번 달 원천징수 자료에 섞여 신고가 틀어진다.
  const to = url.searchParams.get('to') || kstMonthEndKey(ym);
  // JS 는 2026-02-31 같은 날짜를 오류로 보지 않고 2026-03-03 으로 굴려버린다.
  // 그대로 두면 다음 달 초 지급건이 이번 달 원천징수 신고 자료에 섞여 들어간다.
  // 형식뿐 아니라 "달력에 실제로 있는 날짜"인지까지 확인한다.
  const isRealDate = (s: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const probe = new Date(Date.UTC(y, m - 1, d));
    return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
  };
  if (!isRealDate(from) || !isRealDate(to)) {
    return new Response(
      `조회 기간이 올바르지 않습니다. 달력에 있는 날짜를 YYYY-MM-DD 형식으로 입력해 주세요. (요청: ${from} ~ ${to})`,
      { status: 400 },
    );
  }

  const start = new Date(`${from}T00:00:00+09:00`);
  // 종료일은 "다음날 0시 미만" 으로 잡는다.
  //
  // 예전에는 23:59:59.000 이하로 조회했는데 paidAt 은 밀리초까지 기록되므로
  // 23:59:59.001 ~ .999 사이에 지급 확정된 건은 그 달에도, 다음 달에도 잡히지 않았다.
  // 스튜디오 화면에는 보이는데 국세청 신고 자료에서만 영원히 빠지는 사각지대였다.
  const endExclusive = new Date(new Date(`${to}T00:00:00+09:00`).getTime() + 24 * 60 * 60 * 1000);
  if (start >= endExclusive) {
    return new Response('시작일이 종료일보다 늦습니다.', { status: 400 });
  }

  const reqs = await prisma.settlementRequest.findMany({
    where: { status: 'PAID', paidAt: { gte: start, lt: endExclusive } },
    orderBy: { paidAt: 'asc' },
    select: {
      id: true, amount: true, withholding: true, incomeTax: true, localTax: true, payoutAmount: true,
      paidAt: true, residentEnc: true, residentMasked: true, residentPurgedAt: true,
      withholdingFiledAt: true,
      merchant: { select: { displayName: true, code: true } },
    },
  });

  // 주민등록번호 원문이 조직 밖으로 나가는 순간이다. 누가·언제·몇 건을 받았는지 반드시 남긴다.
  await writeAudit({
    adminUserId: admin.id,
    action: 'SETTLEMENT_WITHHOLDING_EXPORT',
    targetType: 'SettlementRequest',
    after: {
      from,
      to,
      rows: reqs.length,
      residentPlaintextRows: reqs.filter((r) => r.residentEnc).length,
      permission: admin.adminPermission,
    },
  });

  const header = [
    '지급일', '사회복지기관', '코드', '지급총액(과세소득)',
    '소득세(3%)', '지방소득세(10%)', '원천징수합계', '실지급액',
    '주민등록번호', '주민번호상태', '원천징수신고',
  ];
  const lines = [header.join(',')];
  for (const r of reqs) {
    // 파기 전이면 원문을, 파기 후면 마스킹만 노출한다.
    const resident = r.residentEnc ? decrypt(r.residentEnc) : (r.residentMasked ?? '');
    const state = r.residentPurgedAt ? '파기됨' : r.residentEnc ? '보관중' : '미입력';
    lines.push(
      [
        r.paidAt ? new Date(r.paidAt.getTime() + 9 * 3600_000).toISOString().slice(0, 10) : '',
        r.merchant.displayName,
        r.merchant.code,
        r.amount.toString(),
        r.incomeTax.toString(),
        r.localTax.toString(),
        r.withholding.toString(),
        r.payoutAmount.toString(),
        resident,
        state,
        r.withholdingFiledAt ? '완료' : '대기',
      ]
        .map(csvCell)
        .join(','),
    );
  }

  const body = '﻿' + lines.join('\r\n') + '\r\n';
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="givesign-withholding-${from}_${to}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
