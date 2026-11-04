/**
 * 서식 파일 등록 + 원본 미리보기·편집 — 화면 흐름 확인.
 *
 *  1. 등록 화면에 기존 서식(PDF)을 올리면 그 자리에서 원본 미리보기 편집기가 열린다(서식 이름 자동 채움)
 *  2. 원래 글자를 고치고(원본 글꼴 판정), 새 글을 넣어 끌어 옮기고, 후원자 화면·원본 비교를 본다
 *  3. [서식 등록] 한 번으로 서식과 고친 결과가 함께 저장된다
 *  4. 서식 화면에서 이어서 고치고 [서식 저장] — 넓은 화면 편집도 같은 기록을 연다
 *
 * 실행: 서버(3060)가 떠 있는 상태에서 `node e2e/pdf-form-edit.mjs` (E2E_SHOTS=폴더 로 화면 저장)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { BASE, launch, loginMerchant, gotoReady } from './_helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, '..', 'tests', 'fixtures', 'pdf-form', 'libreoffice-form.pdf');
const SHOT_DIR = process.env.E2E_SHOTS ?? '';
const shot = async (page, name) => {
  if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, name), fullPage: false });
};

// 최신 브라우저에만 있는 기능(Map.getOrInsertComputed)을 끈 상태로 돈다. pdf.js 기본 빌드는 이 기능이
// 없으면 미리보기를 못 그린다(2026-11-04 실제 장애). 호환 빌드를 쓰는지 여기서 늘 확인한다.
const browser = await launch({ args: ['--js-flags=--no-js-upsert'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const previewDone = () =>
  page.waitForResponse((r) => r.url().includes('/api/studio/pdf-form/preview') && r.status() === 200, { timeout: 30_000 });

try {
  assert.equal(await page.evaluate(() => typeof Map.prototype.getOrInsertComputed), 'undefined');
  await loginMerchant(page);

  // 1. 올리면 바로 미리보기 편집기
  await gotoReady(page, `${BASE}/studio/documents/new?type=file`);
  await page.locator('input[type=file][accept*=".hwp"]').setInputFiles(FIXTURE);
  const amount = page.locator('button[title^="후원 금액"]');
  await amount.waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('input[name=name]').inputValue(), 'libreoffice-form');
  console.log('PASS 올리자마자 미리보기 편집기 · 서식 이름 자동 채움');
  await page.locator('input[name=name]').fill(`원본편집 ${Date.now().toString().slice(-6)}`);
  await shot(page, '1-uploaded.png');

  // 2. 고치기
  await amount.click();
  const input = page.locator('input[maxlength="500"]');
  await input.waitFor();
  const before = await input.inputValue();
  assert.match(before, /10,000/);
  await page.getByText(/^원본 글꼴 · NotoSansCJKkr-Regular 11pt/).waitFor({ timeout: 5_000 });
  const p1 = previewDone();
  await input.fill(before.replace('10,000', '20,000'));
  await input.press('Enter');
  await p1;
  console.log('PASS 글자 고치기 — 원본 글꼴 판정 · 실제 결과 다시 그림');

  // 새 글 넣고 끌어 옮기기
  await page.getByRole('button', { name: '새 글 넣기' }).click();
  const canvas = page.locator('#pdf-edit-page-1 canvas');
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + 90, box.y + 420);
  const addInput = page.locator('input[maxlength="500"]');
  await addInput.waitFor();
  await addInput.fill('후원자 서명:');
  await addInput.press('Enter');
  await page.getByRole('button', { name: '글자 고치기' }).click();
  const added = page.locator('button[title="눌러서 고치기 · 끌어서 옮기기"]');
  await added.waitFor();
  const a = await added.boundingBox();
  await page.mouse.move(a.x + 10, a.y + 5);
  await page.mouse.down();
  await page.mouse.move(a.x + 60, a.y + 45, { steps: 6 });
  await page.mouse.up();
  const moved = await added.boundingBox();
  assert.ok(Math.abs(moved.x - a.x - 50) < 6 && Math.abs(moved.y - a.y - 40) < 6, `moved ${JSON.stringify([a, moved])}`);
  await page.getByText('수정한 곳 2').waitFor();
  console.log('PASS 새 글 넣기 · 끌어서 옮기기');

  // 후원자 화면 · 원본 비교
  await page.getByRole('button', { name: '후원자 화면' }).click();
  await page.getByText('후원자·서명자가 보는 서식').waitFor();
  await shot(page, '2-phone.png');
  await page.getByRole('button', { name: '편집', exact: true }).click();
  const cmp = page.getByRole('button', { name: '원본과 비교' });
  await cmp.hover();
  await page.mouse.down();
  await page.getByText('고치기 전 원본입니다').waitFor();
  await page.mouse.up();
  console.log('PASS 후원자 화면 · 원본 비교');
  await shot(page, '3-edited.png');

  // 3. 등록 한 번으로 함께 저장
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: '서식 등록' }).click();
  await page.waitForURL(/\/studio\/documents\/[A-Z0-9]{26}$/, { timeout: 30_000 });
  const templateUrl = page.url();
  await page.getByText(/원본 위 수정 2곳을 반영했습니다/).waitFor({ timeout: 15_000 }).catch(() => null);
  await page.getByText('수정한 곳 2').waitFor({ timeout: 30_000 });
  console.log('PASS 서식 등록 — 고친 결과 함께 저장', templateUrl);

  // 4. 서식 화면에서 이어서 고치기
  await page.locator('button[title^="후원 금액"]').waitFor({ timeout: 30_000 });
  const title = page.locator('button[title="후원 약정서"]');
  await title.click();
  const t = page.locator('input[maxlength="500"]');
  await t.fill('후원 약정서 (정기)');
  await t.press('Enter');
  await page.getByText('수정한 곳 3').waitFor();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: '서식 저장' }).click();
  await page.getByText(/원본 위 수정 3곳을 반영했습니다/).waitFor({ timeout: 30_000 });
  console.log('PASS 서식 화면에서 이어서 고치고 저장');
  await shot(page, '4-detail.png');

  const href = await page.locator('a', { hasText: '고친 서식' }).first().getAttribute('href');
  assert.match(href ?? '', /^\/api\/media\/[a-f0-9]{32}\.pdf/);
  const res = await page.request.get(`${BASE}${href}`);
  assert.equal(res.status(), 200);
  assert.equal(res.headers()['content-type'], 'application/pdf');
  console.log('PASS 고친 서식 내려받기');

  // 넓은 화면 편집도 같은 기록
  await gotoReady(page, `${templateUrl}/edit`);
  await page.getByText('수정한 곳 3').waitFor({ timeout: 30_000 });
  console.log('PASS 넓은 화면 편집 — 같은 기록');

  assert.deepEqual(errors, []);
  console.log('ALL PASS');
} catch (err) {
  if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, 'fail.png'), fullPage: true }).catch(() => undefined);
  console.error('FAIL', err);
  console.error('page errors', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
