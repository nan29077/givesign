/**
 * 5차 E2E — 사회복지기관 스튜디오 셸·내비게이션 구조.
 *  - 사이드바 그룹/메뉴가 현재 정보구조 그대로인지
 *  - 각 메뉴가 실제로 열리고 제목이 맞는지
 *  - 모바일 햄버거 열고 닫기
 *  - 정산 계좌는 별도 메뉴가 아니라 정산 관리 안의 탭으로 통합됐는지
 */
import { launch, createReporter, loginMerchant, bodyText, textOf, missingOf, BASE, desktop, mobile, assertServerUp } from './_helpers.mjs';

await assertServerUp();
const r = createReporter('5차 — 스튜디오 셸·내비게이션');
const b = await launch();

const GROUPS = ['현황', '방송', '운영', '정산', '계정'];
const MENUS = [
  ['대시보드', '/studio', '사회복지기관 관리자'],
  ['후원 내역', '/studio/charges', '후원 내역'],
  ['문자 관리', '/studio/messages', null],
  ['유튜브 채널 연결', '/studio/youtube', '유튜브 채널 연결'],
  ['방송·오버레이', '/studio/overlay', '방송·오버레이'],
  ['결제 설정', '/studio/settings', '결제 설정'],
  ['금칙어·차단', '/studio/moderation', '금칙어 · 차단'],
  ['신고', '/studio/reports', null],
  ['정산 관리', '/studio/settlement', '정산 관리'],
  ['프로필 설정', '/studio/profile', '설정'],
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
    r.ok('그룹 제목 5종(현황·방송·운영·정산·계정)', miss.length === 0, miss.join(','));
  }
  {
    const miss = missingOf(nav, MENUS.map(([label]) => label));
    r.ok('메뉴 10종이 모두 있다', miss.length === 0, miss.join(','));
  }
  r.ok('내비: 정산 계좌는 별도 메뉴가 아니다', !nav.includes('정산 계좌'));
  r.ok('내비: 옛 "프로필·코드" 메뉴는 없다', !nav.includes('프로필·코드'));
  r.ok('내비: 프로필 설정 메뉴가 있다', nav.includes('프로필 설정'));

  // ── 2. 셸 상단/하단
  r.ok('상단 제목이 사회복지기관 관리자', (await bodyText(page)).includes('사회복지기관 관리자'));
  r.ok('사이드바에 역할 표기(사회복지기관)', nav.includes('사회복지기관'));
  r.ok('사이드바 하단 메인으로 링크', (await page.locator('aside a[href="/"]').count()) > 0);
  r.ok(
    '사이드바 하단 로그아웃 폼',
    (await page.locator('aside form[action="/api/auth/logout"] button[type=submit]').count()) > 0,
  );

  // ── 3. 각 메뉴 href 와 실제 이동
  for (const [label, href, title] of MENUS) {
    const linkCount = await page.locator(`aside a[href="${href}"]`).count();
    r.ok(`메뉴 링크 존재: ${label} → ${href}`, linkCount > 0);
  }

  for (const [label, href, title] of MENUS) {
    await page.goto(`${BASE}${href}`, { waitUntil: 'domcontentloaded' });
    const t = await bodyText(page);
    const notError = !t.includes('Application error') && !t.includes('500');
    if (title) {
      r.ok(`${label} 화면이 열린다`, notError && t.includes(title), title);
    } else {
      r.ok(`${label} 화면이 열린다`, notError);
    }
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
