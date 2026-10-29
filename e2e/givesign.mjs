/**
 * 기브싸인 사회복지기관 도메인 E2E — 후원페이지 · 캠페인 · 공개 화면.
 *
 *   node e2e/givesign.mjs            (서버: npm run dev 또는 npm run preview, 시드 완료 상태)
 *
 * 확인하는 것
 *  1) 홈에 구브랜드 문구가 없다.
 *  2) 기관 담당자가 후원페이지 제목을 저장하면 다시 열어도 남아 있다.
 *  3) 캠페인을 만들고 "모금 시작"하면 공개 후원페이지와 캠페인 상세에 보이고, 문자 링크에 MO 번호가 있다.
 *  4) 비로그인 방문자는 기관 설정 화면에 들어가지 못하고 공개 페이지는 볼 수 있다.
 *  5) 캠페인을 비공개로 돌리면 공개 페이지에서 사라진다.
 *  6) 모바일 폭에서 가로 넘침이 없다.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BASE, SEED, launch, loginMerchant, bodyText, gotoReady } from './_helpers.mjs';

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
fs.mkdirSync('output/qa', { recursive: true });
const stamp = Date.now().toString(36).slice(-4).toUpperCase();
const campaignTitle = `이웃의 따뜻한 한 끼 (검수 ${stamp})`;
const campaignCode = `검수${stamp}`;
const pageTitle = `기브싸인 저장 검증 후원페이지 ${stamp}`;

try {
  // 1) 홈
  await gotoReady(page, BASE);
  const home = await bodyText(page);
  assert.match(home, /기브싸인/);
  assert.doesNotMatch(home, /메시지페이|MessagePay|포인트 충전|토네이도/);
  await page.screenshot({ path: 'output/qa/home-desktop.png', fullPage: true });

  // 2) 후원페이지 설정 저장
  await loginMerchant(page);
  await gotoReady(page, `${BASE}/studio/donation-page`);
  await page.locator('input[name=title]').fill(pageTitle);
  const published = page.locator('input[name=published]');
  if (!(await published.isChecked())) await published.check();
  await page.getByRole('button', { name: '후원페이지 저장', exact: true }).click();
  await page.getByText(/후원페이지를 저장/).waitFor({ timeout: 15_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('input[name=title]').inputValue(), pageTitle);

  // 3) 캠페인 생성 → 모금 시작
  await gotoReady(page, `${BASE}/studio/campaigns/new`);
  await page.locator('input[name=title]').fill(campaignTitle);
  await page.locator('input[name=code]').fill(campaignCode);
  await page.locator('input[name=summary]').fill('사회복지기관 캠페인 생성과 공개를 확인하는 테스트입니다.');
  await page.locator('input[name=goalAmount]').fill('1000000');
  const today = new Date(Date.now() + 9 * 3600000);
  const ymd = (d) => d.toISOString().slice(0, 10);
  await page.locator('input[name=startsOn]').fill(ymd(new Date(today.getTime() - 86_400_000)));
  await page.locator('input[name=endsOn]').fill(ymd(new Date(today.getTime() + 60 * 86_400_000)));
  await page.locator('textarea[name=usagePlan]').fill('도시락 재료와 전달 활동에 사용합니다.');
  await page.getByRole('button', { name: '캠페인 만들기', exact: true }).click();
  await page.waitForURL(/\/studio\/campaigns\/[^/]+$/, { timeout: 20_000 });
  const editUrl = page.url();

  await gotoReady(page, `${BASE}/studio/campaigns`);
  // 캠페인 카드: 제목(h2)에서 가장 가까운 카드 컨테이너
  const card = (title) => page.locator('h2', { hasText: title }).locator('xpath=ancestor::*[.//button][1]');
  const row = card(campaignTitle);
  await row.getByRole('button', { name: '모금 시작', exact: true }).click();
  await page.getByRole('button', { name: '확인', exact: true }).click();
  await page.getByText(/모금 중|ACTIVE/).first().waitFor({ timeout: 15_000 });

  // 공개 후원페이지
  await gotoReady(page, `${BASE}/donate/${SEED.merchant1Code}`);
  const donate = await bodyText(page);
  assert.match(donate, new RegExp(pageTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await page.getByRole('link', { name: new RegExp(campaignTitle.slice(0, 10)) }).first().click();
  await page.waitForURL('**/campaigns/**', { timeout: 20_000 });
  assert.match(await bodyText(page), /도시락 재료와 전달 활동/);
  const sms = await page.locator('a[href^="sms:"]').first().getAttribute('href');
  assert.match(sms ?? '', /^sms:0505/);
  assert.match(decodeURIComponent(sms ?? ''), new RegExp(campaignCode));
  await page.screenshot({ path: 'output/qa/campaign-desktop.png', fullPage: true });

  // 4) 비로그인 접근 제어
  const anon = await browser.newContext();
  const ap = await anon.newPage();
  await ap.goto(`${BASE}/studio/donation-page`, { waitUntil: 'domcontentloaded' });
  assert.match(ap.url(), /\/login/);
  await ap.goto(`${BASE}/my/recurring/new?merchant=GIV-8K2M`, { waitUntil: 'domcontentloaded' });
  assert.match(ap.url(), /\/login\?next=%2Fmy%2Frecurring%2Fnew/);
  await ap.goto(`${BASE}/donate/GIV-8K2M`, { waitUntil: 'domcontentloaded' });
  assert.match(await ap.locator('body').innerText(), new RegExp(pageTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await anon.close();

  // 5) 비공개로 돌리기 → 공개 페이지에서 사라짐
  await gotoReady(page, `${BASE}/studio/campaigns`);
  const row2 = card(campaignTitle);
  await row2.getByRole('button', { name: '비공개', exact: true }).click();
  const confirm = page.getByRole('button', { name: '확인', exact: true });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await page.waitForTimeout(1200);
  await gotoReady(page, `${BASE}/donate/GIV-8K2M`);
  assert.doesNotMatch(await bodyText(page), new RegExp(campaignTitle.slice(0, 10)));

  // 정리: 제목 원복(시드 값과 비슷하게)
  await gotoReady(page, `${BASE}/studio/donation-page`);
  await page.locator('input[name=title]').fill('작은 나눔이 이웃의 든든한 한 끼가 됩니다');
  await page.getByRole('button', { name: '후원페이지 저장', exact: true }).click();
  await page.getByText(/후원페이지를 저장/).waitFor({ timeout: 15_000 });

  // 6) 모바일 폭
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoReady(page, BASE);
  await page.screenshot({ path: 'output/qa/home-mobile.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile overflow');

  console.log(`PASS: 후원페이지 저장, 캠페인 생성/모금 시작/비공개, 공개 화면과 문자 링크, 비로그인 접근 제어, 모바일 레이아웃 (${editUrl})`);
} finally {
  await browser.close();
}
