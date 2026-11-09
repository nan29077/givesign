import { requireMerchant, writeAudit } from '@/server/auth';
import { isSameOrigin } from '@/server/request-guard';
import { kstDateKey } from '@/lib/datetime';
import { logger } from '@/lib/logger';
import { INTERNAL_FILE_KINDS, LEGAL_FILE_LABEL, buildLegalCsv, buildLegalPdf, isLegalFileKind } from '@/server/services/legal-report-files';
import { markLegalPrepared } from '@/server/services/legal-reports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 법정 서류 내려받기 (2026-11-09 3차 H2).
 *
 *   POST /api/studio/reports/legal   (form: kind, year, reason — 내부용만 사유 필수)
 *
 * - 모든 내려받기는 감사로그(LEGAL_REPORT_DOWNLOAD)를 남긴다. 감사로그를 남기지 못하면 파일도 내보내지 않는다.
 * - 내부용(수입 명세 마스킹 이름·영수증 발급 대장)은 금전 권한 = 기관 콘솔 계정(기관당 1개) + 사유. 원문 이름·연락처·주민번호는 없다.
 * - 결과 보고서(PDF·CSV)·공개용 판을 내려받으면 그해 "법정 서류 준비" 알림을 닫는다.
 */
export async function GET() {
  return new Response('POST 로만 내려받을 수 있습니다. 기관 콘솔의 법정 서류 화면에서 다시 시도해 주세요.', { status: 405, headers: { Allow: 'POST' } });
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return new Response('허용되지 않은 요청입니다.', { status: 403 });
  let merchantId: string;
  let userId: string;
  try {
    const me = await requireMerchant();
    merchantId = me.merchantId;
    userId = me.id;
  } catch {
    return new Response('로그인이 필요합니다.', { status: 401 });
  }
  const form = await req.formData().catch(() => null);
  const field = (k: string) => {
    const v = form?.get(k);
    return typeof v === 'string' ? v.trim() : '';
  };
  const kind = field('kind');
  const year = Number(field('year'));
  const nowYear = Number(kstDateKey().slice(0, 4));
  if (!isLegalFileKind(kind)) return new Response('서류 종류가 올바르지 않습니다.', { status: 400 });
  if (!Number.isInteger(year) || year < 2020 || year > nowYear) return new Response('연도가 올바르지 않습니다.', { status: 400 });
  const internal = INTERNAL_FILE_KINDS.includes(kind);
  const reason = field('reason').slice(0, 200);
  if (internal && reason.length < 2) return new Response('내부용 자료는 내려받는 사유를 적어 주세요.', { status: 400 });

  try {
    const isPdf = kind === 'report-pdf' || kind === 'public-pdf';
    const out = isPdf ? await buildLegalPdf(merchantId, year, kind) : await buildLegalCsv(merchantId, year, kind as Parameters<typeof buildLegalCsv>[2]);
    await writeAudit({
      actorUserId: userId,
      action: 'LEGAL_REPORT_DOWNLOAD',
      targetType: 'MerchantProfile',
      targetId: merchantId,
      after: { kind, label: LEGAL_FILE_LABEL[kind], year, rows: out.rows, internal, ...(internal ? { reason } : {}) },
    });
    if (kind === 'report-pdf' || kind === 'report-csv' || kind === 'public-pdf' || kind === 'public-csv') await markLegalPrepared(merchantId, year).catch(() => undefined);
    const body = 'bytes' in out ? Buffer.from(out.bytes) : out.content;
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': isPdf ? 'application/pdf' : 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${out.fileName}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    logger.error('법정 서류 만들기 실패', { merchantId, kind, message: (e as Error).message });
    return new Response('서류를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.', { status: 500 });
  }
}
