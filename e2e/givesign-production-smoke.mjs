import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const base = 'http://localhost:3060';
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  for (const route of ['/', '/business', '/how-it-works', '/login', '/donate/GIV-8K2M', '/c/GIV-8K2M']) {
    const res = await page.goto(base + route, { waitUntil: 'networkidle' });
    assert.equal(res.status(), 200, route);
    assert.match(await page.locator('body').innerText(), /기브싸인|햇살종합사회복지관/);
  }
  await page.goto(base + '/login');
  await page.getByRole('button', { name: /사회복지기관 테스트 로그인/ }).click();
  await page.waitForURL('**/studio');
  assert.ok((await context.cookies()).some(c => c.name === 'givesign_session'));
  await page.goto(base + '/studio/campaigns');
  const editPath = await page.getByRole('link', { name: '수정', exact: true }).first().getAttribute('href');
  assert.ok(editPath);
  const other = await browser.newContext();
  const op = await other.newPage();
  await op.goto(base + '/login');
  await op.locator('input[name=email]').fill('merchant2@givesign.kr');
  await op.locator('input[name=password]').fill('givesign1234!');
  await op.getByRole('button', { name: '로그인', exact: true }).click();
  await op.waitForURL('**/studio');
  const denied = await op.goto(base + editPath);
  assert.equal(denied.status(), 404, 'other institution cannot edit campaigns');
  await other.close();
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await adminPage.goto(base + '/login');
  await adminPage.getByRole('button', { name: /최고관리자로 로그인/ }).click();
  await adminPage.waitForURL('**/admin');
  const admin = await adminPage.goto(base + '/admin/fundraising');
  assert.equal(admin.status(), 200);
  assert.match(await adminPage.locator('body').innerText(), /모금 현황/);
  await adminContext.close();
  await page.goto(base);
  await page.screenshot({ path: 'output/qa/home-desktop-final.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'output/qa/home-mobile-final.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  console.log('PASS: production pages, institution and admin test login, isolated cookie, cross-institution edit denied, mobile layout');
} finally { await browser.close(); }
