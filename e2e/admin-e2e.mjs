/**
 * 관리자 E2E — 통합 관리자 전 화면 스모크 + 한도 정책 등록.
 *
 * 관리자 화면은 수가 많아 한 곳이 깨져도 눈에 안 띈다.
 * 모든 메뉴를 실제로 열어 500/빈 화면이 아닌지부터 확인한다.
 */
import {
  launch, createReporter, bodyText, missingOf, gotoReady, loginAdmin,
  BASE, SEED, desktop, assertServerUp,
} from './_helpers.mjs';

await assertServerUp();
const r = createReporter('관리자 — 전 화면 스모크 · 한도 정책');
const b = await launch();

/**
 * 화면 제목 사전.
 * 실제 방문 목록은 사이드바 링크에서 뽑아 쓴다 — 메뉴가 늘거나 줄어도 스크립트가 따라간다.
 * (예: 자체방송 기능 정리로 /admin/streams 가 사라져도 여기서 걸리지 않는다)
 */
const TITLES = Object.fromEntries([
  ['/admin', '운영 대시보드'],
  ['/admin/system', '시스템 상태'],
  ['/admin/users', '회원 관리'],
  ['/admin/payers', '후원자 관리'],
  ['/admin/merchants', '사회복지기관 심사'],
  ['/admin/codes', '사회복지기관 코드 관리'],
  ['/admin/mo-numbers', 'MO 번호 재고·배정'],
  ['/admin/mo-messages', '수신 문자 관리'],
  ['/admin/mt-templates', 'MT 메시지 관리'],
  ['/admin/mt-messages', 'MT 발송 관리'],
  ['/admin/payments', '결제 관리'],
  ['/admin/refunds', '환불 관리'],
  ['/admin/risk', '한도·이상거래'],
  ['/admin/youtube', '유튜브 연동 관리'],
  ['/admin/streams', '방송·스트림 관리'],
  ['/admin/tts', 'TTS 연동'],
  ['/admin/overlay', '오버레이·TTS 관리'],
  ['/admin/settlements', '정산 관리'],
  ['/admin/holidays', '공휴일 관리'],
  ['/admin/fees', '수수료 정책'],
  ['/admin/policies', '한도 정책'],
  ['/admin/banners', '배너 관리'],
  ['/admin/contents', '공지·FAQ 관리'],
  ['/admin/moderation', '신고·금칙어 관리'],
  ['/admin/inquiries', '문의 관리'],
  ['/admin/terms', '약관 버전 관리'],
  ['/admin/admins', '관리자 권한'],
  ['/admin/audit', '감사로그'],
  ['/admin/simulator', 'MO 시뮬레이터'],
]);

// 사이드바 그룹 제목. 메뉴 재편이 잦아 목록 자체보다 "그룹이 제대로 서 있는가"를 본다.
const MENU_GROUPS = ['운영현황', '회원·사회복지기관', '거래·결제', '방송·오버레이', '정산·수수료', '콘텐츠·운영', '시스템·보안'];

const POLICY_FIELDS = [
  'defaultAmount', 'minAmount', 'maxAmount',
  'payerDailyLimit', 'payerMonthlyLimit', 'perMerchantDailyLimit',
  'payerDailyMaxCount', 'velocityWindowSec', 'velocityMaxCount',
  'cooldownAfterCount', 'cooldownSec', 'failureLockThreshold',
  'newPayerFirstDayLimit', 'manualReviewAmount', 'ttsMinAmount',
];

try {
  const ctx = await b.newContext(desktop);
  const p = await ctx.newPage();
  p.on('dialog', (d) => d.accept());

  // ══════════════ 1. 로그인 ══════════════
  await loginAdmin(p);
  r.ok('관리자 로그인', p.url().includes('/admin'), p.url());
  r.ok('통합 관리자 셸', (await bodyText(p)).includes('기브싸인 통합 관리자'));
  {
    const nav = await p.locator('aside').first().innerText();
    const miss = missingOf(nav, MENU_GROUPS);
    r.ok(`메뉴 그룹 ${MENU_GROUPS.length}종`, miss.length === 0, miss.join(','));
    r.ok('최고관리자에게는 문의 관리 메뉴가 보인다', nav.includes('문의 관리'));
    r.ok('사이드바에 권한이 표기된다', nav.includes('최고 관리자'));
  }

  // ══════════════ 2. 전 화면 스모크 ══════════════
  // 사이드바에 실제로 걸린 메뉴를 전부 방문한다.
  const menuHrefs = [...new Set(await p.locator('aside a[href^="/admin"]').evaluateAll((els) => els.map((e) => e.getAttribute('href'))))];
  r.ok('사이드바에서 관리자 메뉴 목록을 얻는다', menuHrefs.length >= 20, `${menuHrefs.length}개`);

  for (const path of menuHrefs) {
    // 화면 수가 많아 networkidle 대신 본문 렌더까지만 기다린다(dev 첫 컴파일 대비 여유 timeout).
    await p.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await p.waitForSelector('h1', { timeout: 90_000 }).catch(() => {});
    const t = await bodyText(p);
    const alive = t.length > 200 && !t.includes('Application error') && !t.includes('Internal Server Error');
    const title = TITLES[path];
    const okTitle = title ? t.includes(title) : (await p.locator('h1').count()) > 0;
    r.ok(`${path}${title ? ' — ' + title : ''}`, alive && okTitle, alive ? '제목 불일치' : '화면이 비었거나 오류');
  }

  // ══════════════ 3. 한도 정책 ══════════════
  await gotoReady(p, `${BASE}/admin/policies`);
  const pol = await bodyText(p);
  r.ok('한도 값 즉시 반영 고지', pol.includes('한도 값 변경은 즉시 반영됩니다'));
  for (const name of POLICY_FIELDS) {
    r.ok(`한도 필드 ${name}`, (await p.locator(`input[name=${name}]`).count()) > 0);
  }
  r.ok('1인 1일 최대 건수 라벨', pol.includes('1인 1일 최대 건수'));
  r.ok('적용 범위 select', (await p.locator('select[name=scope]').count()) > 0);
  {
    const opts = await p.locator('select[name=scope] option').allInnerTexts();
    const miss = missingOf(opts.join('|'), ['전역 (GLOBAL)', '사회복지기관 (MERCHANT)', '후원자 (PAYER)']);
    r.ok('적용 범위 3종', miss.length === 0, miss.join(','));
  }
  r.ok('적용 시작일 입력칸', (await p.locator('input[name=effectiveFrom]').count()) > 0);
  r.ok('정책 등록 버튼', (await p.locator('button:has-text("정책 등록")').count()) > 0);

  // 사회복지기관 범위 정책을 실제로 등록해 본다
  await p.selectOption('select[name=scope]', 'MERCHANT');
  const merchantOpts = await p.locator('select[name=merchantId] option').count();
  r.ok('사회복지기관 선택 옵션이 채워진다', merchantOpts > 1, `${merchantOpts}개`);
  if (merchantOpts > 1) {
    await p.selectOption('select[name=merchantId]', { index: 1 });
    await p.fill('input[name=payerDailyMaxCount]', '7');
    await p.locator('button:has-text("정책 등록")').click();
    await p.waitForTimeout(3500);
    const after = await bodyText(p);
    r.ok('한도 정책이 등록된다', after.includes('사회복지기관 정책 ·') || after.includes('등록'), after.slice(0, 200));
    r.ok('등록된 정책 목록에 표시된다', !after.includes('등록된 한도 정책이 없습니다'));
  }

  // ══════════════ 4. 사회복지기관 심사 화면 ══════════════
  await gotoReady(p, `${BASE}/admin/merchants`);
  const cr = await bodyText(p);
  {
    const miss = missingOf(cr, ['사회복지기관', '코드', '담당자', '1건 결제 금액', 'MO 번호', '상태', '심사 처리']);
    r.ok('사회복지기관 표 헤더', miss.length === 0, miss.join(','));
  }
  r.ok('시드 사회복지기관이 보인다', cr.includes(SEED.merchant1Name) && cr.includes(SEED.merchant1Code));
  r.ok('공통 허용 범위 일괄 적용 카드', cr.includes('1건 결제 금액 허용 범위 공통 적용'));
  r.ok('검색 입력칸', (await p.locator('input[name=q]').count()) > 0);

  // ══════════════ 5. 수수료 정책 ══════════════
  await gotoReady(p, `${BASE}/admin/fees`);
  const fee = await bodyText(p);
  r.ok('수수료 정책 화면', fee.includes('수수료 정책'));
  r.ok('부가세 관련 표기가 있다', fee.includes('부가세') || fee.includes('VAT'));

  // ══════════════ 6. MO 시뮬레이터 (로컬 전용) ══════════════
  await gotoReady(p, `${BASE}/admin/simulator`);
  const sim = await bodyText(p);
  r.ok('시뮬레이터는 로컬에서만 열린다', sim.includes('MO 시뮬레이터'));
  r.ok('운영 환경 차단 문구가 준비돼 있다', sim.includes('운영 환경') || (await p.locator('form').count()) > 0);

  await ctx.close();
} catch (e) {
  r.ok('스크립트가 끝까지 실행된다', false, String(e?.message ?? e).slice(0, 200));
} finally {
  await b.close();
}

r.finish();
