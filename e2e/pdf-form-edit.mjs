/**
 * 원본 서식 위에서 고치기 — 화면 흐름 확인.
 *
 *  1. 기관 담당자가 기존 서식(PDF)을 올려 파일 서식을 등록한다 → 편집 화면으로 바로 이동
 *  2. 원래 글자를 눌러 고치고(원본 글꼴 판정), 새 글을 넣고, 저장한다
 *  3. 서식 화면에 "수정 반영됨" 이 보이고, 고친 서식 PDF 를 내려받을 수 있다
 *
 * 실행: 서버(3060)가 떠 있는 상태에서 `node e2e/pdf-form-edit.mjs`
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { BASE, launch, loginMerchant, gotoReady } from './_helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, '..', 'tests', 'fixtures', 'pdf-form', 'libreoffice-form.pdf');
const SHOT_DIR = process.env.E2E_SHOTS ?? '';

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

try {
  await loginMerchant(page);

  // 1. 등록
  await gotoReady(page, `${BASE}/studio/documents/new?type=file`);
  const name = `원본편집 ${Date.now().toString().slice(-6)}`;
  await page.locator('input[name=name]').fill(name);
  await page.locator('input[type=file]').first().setInputFiles(FIXTURE);
  await page.getByText('원본 위에서 고칠 수 있습니다').waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: '서식 등록' }).click();
  await page.waitForURL(/\/studio\/documents\/[^/]+\/edit$/, { timeout: 30_000 });
  const templateUrl = page.url().replace(/\/edit$/, '');
  console.log('PASS 등록 후 편집 화면으로 이동', page.url());

  // 2. 원래 글자 고치기
  const amount = page.locator('button[title^="후원 금액"]');
  await amount.waitFor({ timeout: 30_000 });
  await amount.click();
  const input = page.locator('input[maxlength="500"]');
  await input.waitFor();
  const before = await input.inputValue();
  assert.match(before, /10,000/);
  await page.getByText(/^원본 글꼴 · NotoSansCJKkr-Regular 11pt/).waitFor({ timeout: 5_000 });
  await input.fill(before.replace('10,000', '20,000'));
  await input.press('Enter');
  console.log('PASS 글자 고치기 — 원본 글꼴 판정');

  // 새 글 넣기
  await page.getByRole('button', { name: '새 글 넣기' }).click();
  const pageBox = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(pageBox.x + 90, pageBox.y + 420);
  const addInput = page.locator('input[maxlength="500"]');
  await addInput.waitFor();
  await addInput.fill('후원자 서명:');
  await addInput.press('Enter');
  console.log('PASS 새 글 넣기');

  // 실제 결과가 다시 그려질 때까지 기다린 뒤 저장
  await page.getByText('수정한 곳 2').waitFor();
  await page.waitForResponse((r) => r.url().includes('/pdf-preview') && r.status() === 200, { timeout: 30_000 }).catch(() => null);
  await page.getByRole('button', { name: '저장' }).click();
  await page.getByText(/저장했습니다\. 수정 2곳/).waitFor({ timeout: 30_000 });
  const saved = await page.getByText(/저장했습니다\. 수정 2곳/).innerText();
  assert.match(saved, /원래 글자 \d+자를 지웠습니다/);
  console.log('PASS 저장 —', saved);
  if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, 'pdf-editor.png'), fullPage: false });

  // 3. 서식 화면
  await gotoReady(page, templateUrl);
  await page.getByText(/수정 2곳 반영됨/).waitFor();
  const href = await page.locator('a', { hasText: '고친 서식' }).first().getAttribute('href');
  assert.match(href ?? '', /^\/api\/media\/[a-f0-9]{32}\.pdf/);
  const res = await page.request.get(`${BASE}${href}`);
  assert.equal(res.status(), 200);
  assert.equal(res.headers()['content-type'], 'application/pdf');
  console.log('PASS 고친 서식 내려받기', href);

  assert.deepEqual(errors, []);
  console.log('ALL PASS');
} catch (err) {
  if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, 'pdf-editor-fail.png'), fullPage: true }).catch(() => undefined);
  console.error('FAIL', err);
  console.error('page errors', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
