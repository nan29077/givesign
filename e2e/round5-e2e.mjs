/**
 * 5차 E2E — 사회복지기관 스튜디오 셸·내비게이션 구조.
 *  - 사이드바 그룹/메뉴가 현재 정보구조 그대로인지
 *  - 각 메뉴가 실제로 열리고 제목이 맞는지
 *  - 모바일 햄버거 열고 닫기
 *  - 정산 계좌는 별도 메뉴가 아니라 정산 관리 안의 탭으로 통합됐는지
 *  - 메시지페이에서 삭제한 유튜브·방송·오버레이 화면이 메뉴에도 없고 주소로도 열리지 않는지
 */
import { launch, createReporter, loginMerchant, bodyText, textOf, missingOf, BASE, desktop, mobile, assertServerUp } from './_helpers.mjs';

await assertServerUp();
const r = createReporter('5차 — 기관 콘솔 셸·내비게이션');
const b = await launch();

// 기능 플래그(FEATURE_*)와 무관하게 항상 있는 그룹·메뉴만 기준으로 삼는다.
const GROUPS = ['현황', '발굴·안내', '모금', '전자문서', '정산·영수증', '계정'];
// [메뉴 이름, 주소, 화면 제목(h1)]
const MENUS = [
  ['대시보드', '/studio', '대시보드'],
  ['후원 내역', '/studio/charges', '후원 내역'],
  ['정기후원', '/studio/recurring', '정기후원'],
  ['문자 관리', '/studio/messages', '문자 관리'],
  ['캠페인', '/studio/campaigns', '캠페인'],
  ['후원페이지', '/studio/donation-page', '후원페이지'],
  ['후원 설정', '/studio/settings', '후원 설정'],
  ['금칙어·차단', '/studio/moderation', '금칙어 · 차단'],
  ['신고', '/studio/reports', '신고 내역'],
  ['정산 관리', '/studio/settlement', '정산 관리'],
  ['기부금영수증', '/studio/receipts', '기부금영수증'],
  ['기관 정보', '/studio/profile', '기관 정보'],
];
// 메시지페이(유튜브 방송 후원)에서 삭제한 화면
const REMOVED = [
  ['유튜브 채널 연결', '/studio/youtube'],
  ['방송·오버레이', '/studio/overlay'],
];

try {
  const ctx = await b.newContext(desktop);
  const page = await ctx.newPage();
  await loginMerchant(page);

  // ── 1. 사이드바 구조
  const nav = await textOf(page, 'aside');
  r.ok('사이드바가 렌더된다', nav.length > 0);
  {
    const miss = missingOf(nav, GROUPS);
    r.ok(`그룹 제목 ${GROUPS.length}종(${GROUPS.join('·')})`, miss.length === 0, miss.join(','));
  }
  {
    const miss = missingOf(nav, MENUS.map(([label]) => label));
    r.ok(`메뉴 ${MENUS.length}종이 모두 있다`, miss.length === 0, miss.join(','));
  }
  r.ok('내비: 정산 계좌는 별도 메뉴가 아니다', !nav.includes('정산 계좌'));
  r.ok('내비: 옛 "프로필·코드" 메뉴는 없다', !nav.includes('프로필·코드'));
  r.ok('내비: 옛 "프로필 설정" 대신 "기관 정보" 메뉴다', !nav.includes('프로필 설정') && nav.includes('기관 정보'));
  for (const [label] of REMOVED) r.ok(`내비: 삭제된 "${label}" 메뉴가 없다`, !nav.includes(label));
  r.ok('내비: 방송·오버레이·TTS 용어가 없다', !/방송|오버레이|TTS|유튜브/.test(nav));

  // ── 2. 셸 상단/하단
  r.ok('상단 제목이 사회복지기관 관리자', (await bodyText(page)).includes('사회복지기관 관리자'));
  r.ok('사이드바에 역할 표기(기관 관리자)', nav.includes('기관 관리자'));
  r.ok('사이드바 하단 메인으로 링크', (await page.locator('aside a[href="/"]').count()) > 0);
  r.ok(
    '사이드바 하단 로그아웃 폼',
    (await page.locator('aside form[action="/api/auth/logout"] button[type=submit]').count()) > 0,
  );

  // ── 3. 각 메뉴 href 와 실제 이동
  for (const [label, href] of MENUS) {
    const linkCount = await page.locator(`aside a[href="${href}"]`).count();
    r.ok(`메뉴 링크 존재: ${label} → ${href}`, linkCount > 0);
  }

  for (const [label, href, title] of MENUS) {
    const res = await page.goto(`${BASE}${href}`, { waitUntil: 'domcontentloaded' });
    const t = await bodyText(page);
    const notError = res?.status() === 200 && !t.includes('Application error');
    const h1 = (await page.locator('main h1').allInnerTexts()).map((x) => x.trim());
    r.ok(`${label} 화면이 열린다`, notError && h1.includes(title), `status=${res?.status()} h1=${h1.join('/')}`);
  }

  for (const [label, href] of REMOVED) {
    r.ok(`삭제된 메뉴 링크가 없다: ${label}`, (await page.locator(`aside a[href="${href}"]`).count()) === 0);
    const res = await page.goto(`${BASE}${href}`, { waitUntil: 'domcontentloaded' });
    r.ok(`삭제된 화면은 열리지 않는다(404): ${label}`, res?.status() === 404, `status=${res?.status()}`);
  }

  // ── 4. 정산 계좌는 정산 관리 탭으로 통합(리다이렉트)
  await page.goto(`${BASE}/studio/settlement/account`, { waitUntil: 'domcontentloaded' });
  r.ok('정산 계좌 URL 은 정산 관리 탭으로 통합된다', page.url().includes('/studio/settlement?tab=account'), page.url());

  await ctx.close();

  // ── 5. 모바일 햄버거
  const mctx = await b.newContext(mobile);
  const m = await mctx.newPage();
  await loginMerchant(m);
  const burger = m.locator('button[aria-label="메뉴"]');
  r.ok('모바일: 햄버거 버튼이 보인다', await burger.isVisible());
  r.ok('모바일: 기본은 닫힘(aria-expanded=false)', (await burger.getAttribute('aria-expanded')) === 'false');
  await burger.click();
  await m.waitForTimeout(300);
  r.ok('모바일: 클릭하면 열린다', (await burger.getAttribute('aria-expanded')) === 'true');
  r.ok('모바일: 열린 메뉴에 대시보드가 보인다', await m.locator('aside a[href="/studio"]').first().isVisible());
  const closeBtn = m.locator('button[aria-label="메뉴 닫기"]');
  r.ok('모바일: 닫기(배경) 버튼이 있다', (await closeBtn.count()) > 0);
  await burger.click();
  await m.waitForTimeout(300);
  r.ok('모바일: 닫힌다', (await burger.getAttribute('aria-expanded')) === 'false');
  await mctx.close();
} catch (e) {
  r.ok('스크립트가 끝까지 실행된다', false, String(e?.message ?? e).slice(0, 200));
} finally {
  await b.close();
}

r.finish();
