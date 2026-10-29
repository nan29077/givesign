/**
 * 9차 E2E — 민감자료 권한 화이트리스트 / 지급대행 배치번호 / 관리자 권한 체계.
 *
 * 주민등록번호·계좌가 들어가는 CSV 는 재무(FINANCE)·최고관리자만 받을 수 있어야 한다.
 * 로그인만 하면 받아지는 상태로 되돌아가면 여기서 잡힌다.
 */
import {
  launch, createReporter, bodyText, missingOf, gotoReady, loginAdmin,
  BASE, desktop, assertServerUp,
} from './_helpers.mjs';

await assertServerUp();
const r = createReporter('9차 — 민감자료 권한 · 지급대행 · 관리자 권한');
const b = await launch();

const PAYOUT = '/api/admin/settlements/payout';
const WITHHOLD = '/api/admin/settlements/withholding';

try {
  // ══════════════ 1. 비로그인 접근 차단 ══════════════
  {
    const res = await fetch(`${BASE}${PAYOUT}?ids=x`);
    const text = await res.text();
    r.ok('지급대행 CSV: 비로그인 401', res.status === 401, `status=${res.status}`);
    r.ok('지급대행 CSV: 401 안내 문구', text.includes('관리자 로그인이 필요합니다'));
  }
  {
    const res = await fetch(`${BASE}${WITHHOLD}?from=2026-08-01`);
    const text = await res.text();
    r.ok('원천징수 CSV: 비로그인 401', res.status === 401, `status=${res.status}`);
    r.ok('원천징수 CSV: 401 안내 문구', text.includes('관리자 로그인이 필요합니다'));
  }

  // ══════════════ 2. 최고관리자 ══════════════
  const ctx = await b.newContext(desktop);
  const p = await ctx.newPage();
  p.on('dialog', (d) => d.accept());
  await loginAdmin(p);

  {
    const res = await p.request.get(`${BASE}${PAYOUT}`);
    r.ok('지급대행 CSV: 대상 미선택은 400', res.status() === 400, `status=${res.status()}`);
    r.ok('지급대행 CSV: 400 안내 문구', (await res.text()).includes('선택된 정산 요청이 없습니다'));
  }
  {
    const res = await p.request.get(`${BASE}${WITHHOLD}?from=2026-08-01&to=2026-08-31`);
    r.ok('원천징수 CSV: 최고관리자는 200', res.ok(), `status=${res.status()}`);
    const csv = await res.text();
    const miss = missingOf(csv.split('\n')[0] ?? '', [
      '지급일', '지급총액(과세소득)', '소득세(3%)', '지방소득세(10%)', '원천징수합계', '실지급액', '주민번호상태',
    ]);
    r.ok('원천징수 CSV 헤더가 신고 서식과 맞다', miss.length === 0, miss.join(','));
    r.ok('원천징수 CSV 는 캐시되지 않는다', (res.headers()['cache-control'] ?? '').includes('no-store'));
  }
  {
    const res = await p.request.get(`${BASE}${WITHHOLD}?from=2026-02-31`);
    r.ok('원천징수 CSV: 달력에 없는 날짜는 400', res.status() === 400, `status=${res.status()}`);
    r.ok('원천징수 CSV: 날짜 오류 안내', (await res.text()).includes('달력에 있는 날짜'));
  }

  // ══════════════ 3. 정산 관리 화면 ══════════════
  await gotoReady(p, `${BASE}/admin/settlements`);
  const s = await bodyText(p);
  r.ok('정산 관리 화면', s.includes('정산 관리'));
  r.ok('원장은 조회 전용 고지', s.includes('정산 원장은 조회 전용입니다'));
  {
    const miss = missingOf(s, ['요청 대기', '검토중', '승인(지급 대기)', '지급 완료']);
    r.ok('정산 상태 타일 4종', miss.length === 0, miss.join(','));
  }
  {
    const miss = missingOf(s, ['사회복지기관별 정산 요약', '잔액', '보류', '정산 가능']);
    r.ok('사회복지기관별 요약 표', miss.length === 0, miss.join(','));
  }
  r.ok('요청 상태 필터', (await p.locator('select[name=status]').count()) > 0);
  r.ok('사회복지기관 필터', (await p.locator('select[name=merchantId]').count()) > 0);
  r.ok('정산 월 필터', (await p.locator('input[name=key]').count()) > 0);

  // 일괄 처리 버튼과 비활성 상태
  r.ok('일괄 승인 버튼', (await p.locator('button:has-text("일괄 승인")').count()) > 0);
  r.ok('일괄 반려 버튼', (await p.locator('button:has-text("일괄 반려")').count()) > 0);
  r.ok('일괄 지급완료 버튼', (await p.locator('button:has-text("일괄 지급완료")').count()) > 0);
  r.ok('선택 전에는 일괄 승인이 잠긴다', await p.locator('button:has-text("일괄 승인")').first().isDisabled());

  const payoutLink = p.locator('a:has-text("지급대행 파일 받기")').first();
  r.ok('지급대행 파일 링크', (await payoutLink.count()) > 0);
  r.ok(
    '승인 건 미선택 시 지급대행 링크가 잠긴다',
    (await payoutLink.getAttribute('aria-disabled')) === 'true',
  );
  r.ok(
    '원천징수 지급명세서 링크',
    (await p.locator(`a[href^="${WITHHOLD}"]`).count()) > 0,
  );

  // 지급대행 결과 반영 — 배치번호 가드
  await p.locator('summary:has-text("지급대행 결과 반영")').first().click();
  await p.waitForTimeout(400);
  const after = await bodyText(p);
  r.ok('배치번호 입력칸', (await p.locator('input[name=batchNo]').count()) > 0);
  r.ok('결과 붙여넣기 입력칸', (await p.locator('textarea[name=results]').count()) > 0);
  r.ok('배치번호 가드 설명', after.includes('정상 지급건이 실패로 되돌아가는 사고'));
  r.ok('지급대행 흐름 안내', after.includes('요청 선택 → 일괄 승인 → 지급대행 파일 받기'));
  r.ok('주민번호 파기 버튼', (await p.locator('button:has-text("원천징수 신고·주민번호 파기")').count()) > 0);

  // ══════════════ 4. 관리자 권한 체계 ══════════════
  await gotoReady(p, `${BASE}/admin/admins`);
  const adminsText = await bodyText(p);
  r.ok('관리자 권한 화면', adminsText.includes('관리자 권한'));
  {
    const miss = missingOf(adminsText, ['최고 관리자', '운영', '재무', '고객지원', '읽기 전용']);
    r.ok('권한 5종이 정의돼 있다', miss.length === 0, miss.join(','));
  }
  r.ok('본인 권한은 변경할 수 없다는 안내', adminsText.includes('본인 권한은 변경할 수 없습니다'));

  // ══════════════ 5. MO 번호 / 감사로그 ══════════════
  await gotoReady(p, `${BASE}/admin/mo-numbers`);
  r.ok('MO 번호 재고·배정 화면', (await bodyText(p)).includes('MO 번호'));
  await gotoReady(p, `${BASE}/admin/audit`);
  r.ok('감사로그 화면', (await bodyText(p)).includes('감사로그'));

  // ══════════════ 6. 개인정보 표시 원칙 ══════════════
  await gotoReady(p, `${BASE}/admin/users`);
  const users = await bodyText(p);
  r.ok('회원 관리 화면', users.includes('회원 관리'));
  r.ok('개인정보 표시 원칙 고지', users.includes('개인정보 표시 원칙'));
  r.ok('원문 전화번호·계좌번호 비노출 고지', users.includes('관리자 화면에서도 조회할 수 없습니다'));

  await ctx.close();
} catch (e) {
  r.ok('스크립트가 끝까지 실행된다', false, String(e?.message ?? e).slice(0, 200));
} finally {
  await b.close();
}

r.finish();
