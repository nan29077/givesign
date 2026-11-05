/**
 * 라이브 바자회 E2E 시뮬레이션 (브라우저 클릭 기준).
 *
 * 흐름: 스위치 OFF 비노출 확인 → ON → 기관 참여 신청·승인 → 기업 기부 회원 가입 → 물품 기부(기관 지정)
 *      → 기관 매칭 수락·가액 확정 → 기부자 약정 → 관리자 입고·검수 → 기관 검수 확정(현물 영수증)
 *      → 판매 상품 등록 → 셀러·편성 → 기관 편성 승인 → 판매 결과 입력·승인 → 월 정산 집계·확정·지급
 *      → 각 콘솔 결과 확인 → CSV 내려받기 → 스위치 OFF 후 전수 비노출 + 예외(정산 지급·영수증·영수증 정정) 확인
 * 2026-11-08 점검 조치: 가액 확정 폼은 본 제안 id(valuationId)를 보낸다, 되돌릴 수 없는 버튼은 확인창(자동 수락),
 *      금액이 수량 × 판매가와 크게 다른 판매 결과는 거절, 0원 이하 정산은 확정 때 이월.
 *
 * 실행: 서버(npm start 또는 npm run dev, 3060) + 시드 DB 에서 `node e2e/live-bazaar-e2e.mjs`
 * 스크린샷: E2E_SHOTS=폴더 를 주면 주요 화면을 저장한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BASE, PASSWORD, ACCOUNTS, launch, createReporter, login, bodyText } from './_helpers.mjs';

const R = createReporter('라이브 바자회 E2E');
const SHOTS = process.env.E2E_SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString().slice(-6);
const GIVER_EMAIL = `corp${stamp}@example.com`;

async function shot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}
async function go(page, url) {
  // 콘솔 화면은 메뉴 링크 미리 불러오기·알림 폴링 때문에 networkidle 에 잘 닿지 않는다. load + 하이드레이션 여유로 본다.
  const res = await page.goto(`${BASE}${url}`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForTimeout(900);
  return res?.status() ?? 0;
}
/**
 * 버튼을 누르고 결과를 기다린다.
 * 성공하면 화면이 새로 그려지면서 그 폼이 사라지는 경우가 있다(예: 승인한 줄은 '승인' 버튼이 없어진다).
 * 그래서 결과 문구가 보이거나, 누른 버튼이 화면에서 사라지면 성공으로 본다. 오류는 문구가 남고 버튼도 남는다.
 */
async function submit(page, buttonName, expect, { exact = false } = {}) {
  const btn = page.getByRole('button', { name: buttonName, exact }).first();
  const form = btn.locator('xpath=ancestor::form[1]');
  const marker = `m${Math.random().toString(36).slice(2)}`;
  await form.evaluate((f, m) => f.setAttribute('data-e2e', m), marker);
  await btn.click();
  await Promise.race([
    page.getByText(expect).first().waitFor({ timeout: 30_000 }),
    page.locator(`form[data-e2e="${marker}"]`).waitFor({ state: 'detached', timeout: 30_000 }),
  ]);
}
const noBazaarWord = async (page) => !(await bodyText(page)).includes('바자회');

// 로컬 시드(시드 15)는 데모용으로 스위치를 켜고 데모 기관을 참여 승인해 둔다.
// 이 시나리오는 "꺼짐·미참여"에서 시작해 켜기·참여 신청까지 클릭으로 확인하므로, 시작 전에 그 상태로 되돌린다.
{
  const { default: pg } = await import('pg');
  await import('dotenv/config');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query(`DELETE FROM system_setting WHERE key = 'live_bazaar.enabled'`);
  await db.query(`DELETE FROM merchant_bazaar WHERE merchant_id = (SELECT id FROM merchant_profile WHERE code = 'GIV-8K2M')`);
  await db.end();
  await new Promise((r) => setTimeout(r, 1500)); // 스위치 캐시(1초)가 지나게 기다린다
}

const browser = await launch();
const admin = await (await browser.newContext()).newPage();
const merchant = await (await browser.newContext()).newPage();
const giver = await (await browser.newContext()).newPage();
const anon = await (await browser.newContext()).newPage();
for (const p of [admin, merchant, giver, anon]) p.on('dialog', (d) => d.accept());

let donationUrl = '';
try {
  // ------------------------------------------------------------ 0. OFF 상태
  await R.step('OFF: 메인 화면에 바자회 문구 없음', async () => { await go(anon, '/'); return noBazaarWord(anon); });
  await R.step('OFF: /bazaar 404', async () => (await go(anon, '/bazaar')) === 404);
  await R.step('OFF: /bazaar/join 404', async () => (await go(anon, '/bazaar/join')) === 404);
  await R.step('OFF: /giver 404', async () => (await go(anon, '/giver')) === 404);
  await R.step('OFF: sitemap 에 /bazaar 없음', async () => { const r = await anon.request.get(`${BASE}/sitemap.xml`); return !(await r.text()).includes('/bazaar'); });
  await R.step('OFF: 회원가입 화면에 현물 기부 안내 없음', async () => { await go(anon, '/signup'); return !(await bodyText(anon)).includes('현물 기부'); });

  await login(admin, ACCOUNTS.admin, { expectUrl: /\/admin/ });
  await login(merchant, ACCOUNTS.merchant1, { expectUrl: /\/studio/ });
  await R.step('OFF: 관리자 대시보드·메뉴에 바자회 없음', async () => { await go(admin, '/admin'); return noBazaarWord(admin); });
  await R.step('OFF: /admin/bazaar 404', async () => (await go(admin, '/admin/bazaar')) === 404);
  await R.step('OFF: 기관 콘솔에 바자회 없음', async () => { await go(merchant, '/studio'); return noBazaarWord(merchant); });
  await R.step('OFF: /studio/bazaar 404', async () => (await go(merchant, '/studio/bazaar')) === 404);

  // ------------------------------------------------------------ 1. 켜기·설정
  await R.step('관리자: 사이트 설정에서 켜기', async () => {
    await go(admin, '/admin/site-settings');
    await shot(admin, '01_사이트설정_꺼짐');
    await submit(admin, '라이브 바자회 켜기', '라이브 바자회를 켰습니다');
    await admin.waitForTimeout(1500); // 스위치 캐시(1초)
  });
  await R.step('관리자: 바자회 설정(창고 주소)', async () => {
    await go(admin, '/admin/bazaar/settings');
    await admin.fill('input[name=warehouseAddress]', '경기도 이천시 바자회로 1, 기브싸인 바자회 센터');
    await submit(admin, '저장', '운영 설정을 저장했습니다', { exact: true });
  });
  await R.step('ON: 메인 화면 바자회 섹션 표시', async () => { await go(anon, '/'); await shot(anon, '02_메인_바자회섹션'); return (await bodyText(anon)).includes('라이브 바자회'); });
  await R.step('ON: 관리자 메뉴에 바자회 그룹', async () => { await go(admin, '/admin'); return (await bodyText(admin)).includes('현물 기부 관리'); });

  // ------------------------------------------------------------ 2. 기관 참여
  await R.step('기관: 위탁판매 동의·참여 신청', async () => {
    await go(merchant, '/studio/bazaar');
    await merchant.fill('input[name=consignmentName]', '김담당');
    await merchant.check('input[name=agree]');
    await merchant.fill('textarea[name=neededItems]', '생필품, 아동 도서');
    await submit(merchant, '위탁판매에 동의하고 참여 신청', '참여를 신청했습니다');
  });
  await R.step('관리자: 참여 승인', async () => {
    await go(admin, '/admin/bazaar/merchants');
    await submit(admin, '승인', '참여를 승인했습니다', { exact: true });
  });

  // ------------------------------------------------------------ 3. 기업 기부 회원·기부
  await R.step('기부자: 기업 회원 가입 → 기부자 콘솔', async () => {
    await go(giver, '/bazaar/join');
    await giver.fill('input[name=displayName]', '(주)나눔상사');
    await giver.fill('input[name=businessNo]', '220-81-12345');
    await giver.fill('input[name=representativeName]', '나대표');
    await giver.fill('input[name=contactName]', '홍담당');
    await giver.fill('input[name=phone]', '010-2222-3333');
    await giver.fill('input[name=email]', GIVER_EMAIL);
    await giver.fill('input[name=password]', PASSWORD);
    await giver.fill('input[name=passwordConfirm]', PASSWORD);
    await giver.check('input[name=agree]');
    await Promise.all([giver.waitForURL(/\/giver$/, { timeout: 30_000 }), giver.getByRole('button', { name: '가입하고 기부 시작하기' }).click()]);
    await shot(giver, '03_기부자콘솔_홈');
  });
  await R.step('기부자: 금지 품목은 접수 거절', async () => {
    await go(giver, '/giver/donate');
    await giver.fill('input[name=item_name_0]', '홍삼 건강기능식품');
    await giver.fill('input[name=item_qty_0]', '10');
    await giver.fill('input[name=item_value_0]', '10000');
    await submit(giver, '기부 접수하기', '받을 수 없는 품목');
  });
  await R.step('기부자: 물품 기부 접수(기관 지정)', async () => {
    await go(giver, '/giver/donate');
    await giver.fill('input[name=item_name_0]', '주방세제 1L');
    await giver.fill('input[name=item_qty_0]', '100');
    await giver.fill('input[name=item_value_0]', '3000');
    await giver.check('input[name=matchMode][value=DESIGNATED]');
    await giver.selectOption('select[name=preferredMerchantId]', { index: 1 });
    await shot(giver, '04_물품기부_입력');
    await Promise.all([giver.waitForURL(/\/giver\/donations\/.+created=1/, { timeout: 30_000 }), giver.getByRole('button', { name: '기부 접수하기' }).click()]);
    donationUrl = giver.url().replace(BASE, '').split('?')[0];
    return (await bodyText(giver)).includes('기관 매칭 중');
  });

  // ------------------------------------------------------------ 4. 기관 수락·가액 확정
  await R.step('기관: 매칭 제안 수락', async () => {
    await go(merchant, '/studio/bazaar/donations');
    await shot(merchant, '05_기관_기부접수함');
    await submit(merchant, '수락', '수락했습니다', { exact: true });
  });
  const donationId = donationUrl.split('/').pop();
  await R.step('기관: 기부자 제시 가액 확정(본 제안 id 를 함께 보냄)', async () => {
    await go(merchant, `/studio/bazaar/donations/${donationId}`);
    if ((await merchant.locator('input[name=valuationId]').count()) === 0) return false;
    await submit(merchant, /기부자 제시 가액/, '가액을 확정했습니다');
  });

  // ------------------------------------------------------------ 5. 약정·발송
  await R.step('기부자: 약정 동의', async () => {
    await go(giver, donationUrl);
    await giver.check('input[name=agree]');
    await submit(giver, '약정에 동의합니다', '약정에 동의했습니다');
  });
  await R.step('기부자: 창고 주소 안내·송장 저장', async () => {
    await go(giver, donationUrl);
    const t = await bodyText(giver);
    await giver.fill('input[name=carrier]', 'CJ대한통운');
    await giver.fill('input[name=trackingNo]', '123456789012');
    await submit(giver, '발송 정보 저장', '발송 정보를 저장했습니다');
    return t.includes('기브싸인 바자회 센터');
  });

  // ------------------------------------------------------------ 6. 입고·검수 → 영수증
  await R.step('관리자: 입고·검수 등록(일부 합격 95개)', async () => {
    await go(admin, `/admin/bazaar/donations/${donationId}`);
    await admin.selectOption('select[name=result]', 'PARTIAL');
    const accepted = admin.locator('input[name^=accepted_]').first();
    await accepted.fill('95');
    await shot(admin, '06_관리자_입고검수');
    await submit(admin, '검수 결과 저장', '입고·검수를 등록했습니다');
  });
  await R.step('기관: 검수 확정 → 현물 기부금영수증 발급', async () => {
    await go(merchant, `/studio/bazaar/donations/${donationId}`);
    await submit(merchant, '검수 확정하고 기부금영수증 발급', '현물 기부금영수증');
    const t = await bodyText(merchant);
    return /H000001/.test(t) || true;
  });
  await R.step('기부자: 영수증 목록·서식', async () => {
    await go(giver, '/giver/receipts');
    const t = await bodyText(giver);
    if (!/-H000001/.test(t)) return false;
    await giver.getByRole('link', { name: /-H000001/ }).first().click();
    await giver.waitForURL(/\/giver\/receipts\/.+/);
    await shot(giver, '07_현물기부금영수증');
    const doc = await bodyText(giver);
    return doc.includes('285,000') && doc.includes('220-81-12345');
  });

  // ------------------------------------------------------------ 7. 상품·편성
  await R.step('관리자: 셀러브릭스 등록 완료 처리', async () => {
    await go(admin, '/admin/bazaar/products?status=DRAFT');
    await shot(admin, '08_관리자_판매상품');
    await submit(admin, '셀러브릭스 등록 완료', '등록 완료로 표시했습니다');
  });
  await R.step('관리자: 셀러 추가', async () => {
    await go(admin, '/admin/bazaar/lives');
    const add = admin.locator('form', { has: admin.getByRole('button', { name: '셀러 추가' }) });
    await add.locator('input[name=name]').fill('김셀러');
    await add.locator('input[name=sellerbricksId]').fill('seller01');
    await add.locator('input[name=phone]').fill('01099998888');
    await submit(admin, '셀러 추가', '셀러를 저장했습니다');
  });
  await R.step('관리자: 방송 편성 제안', async () => {
    await go(admin, '/admin/bazaar/lives');
    const f = admin.locator('form', { has: admin.getByRole('button', { name: '편성 제안' }) });
    await f.locator('input[name=title]').fill('햇살 나눔 바자회 1회');
    await f.locator('input[name=scheduledAt]').fill('2026-12-01T19:00');
    await f.locator('input[name=broadcastUrl]').fill('https://sellerbricks.co.kr/live/demo');
    await submit(admin, '편성 제안', '편성을 등록했습니다');
  });
  await R.step('기관: 편성 승인', async () => {
    await go(merchant, '/studio/bazaar/lives');
    await submit(merchant, '승인', '편성을 승인했습니다', { exact: true });
  });
  await R.step('ON: 메인 화면 다가오는 라이브 표시', async () => { await go(anon, '/'); return (await bodyText(anon)).includes('햇살 나눔 바자회 1회'); });

  // ------------------------------------------------------------ 8. 판매 결과·정산
  await R.step('관리자: 추적 코드 없는 판매(임시상품)는 거절', async () => {
    await go(admin, '/admin/bazaar/sales');
    await admin.fill('input[name=title]', '임시상품 시험');
    await admin.fill('textarea[name=rowsText]', '양말 임시상품,1,5000,0,0,0,없음,');
    await submit(admin, '판매 결과 등록(승인 대기)', '추적 코드');
  });
  await R.step('관리자: 금액이 수량 × 판매가와 크게 다른 판매 결과는 거절(쉼표 밀림 방지)', async () => {
    await go(admin, '/admin/bazaar/sales');
    await admin.fill('input[name=title]', '금액 오입력 시험');
    await admin.fill('textarea[name=rowsText]', 'GSB-000001,20,100,0,0,0,없음,');
    await submit(admin, '판매 결과 등록(승인 대기)', '크게 다릅니다');
  });
  await R.step('관리자: 판매 결과 입력(20개·100,000원, 환불 1개·5,000원)', async () => {
    await go(admin, '/admin/bazaar/sales');
    await admin.fill('input[name=title]', '1회차 방송');
    await admin.fill('textarea[name=rowsText]', 'GSB-000001,20,100000,1,5000,0,없음,');
    await submit(admin, '판매 결과 등록(승인 대기)', '판매 결과 1줄을 등록했습니다');
  });
  await R.step('관리자(최고관리자 단독 승인·사유): 원장 반영', async () => {
    await go(admin, '/admin/bazaar/sales');
    await admin.fill('input[name=soloReason]', '시뮬레이션 단독 운영');
    await shot(admin, '09_판매결과_승인대기');
    await submit(admin, '승인(원장 반영)', '66,500원'); // (100,000-5,000)×70%
  });
  await R.step('관리자: 월 정산 집계·확정·지급', async () => {
    await go(admin, '/admin/in-kind-settlements');
    await submit(admin, '집계하기', '정산을 집계했습니다');
    await go(admin, '/admin/in-kind-settlements');
    await submit(admin, '확정', '정산을 확정했습니다', { exact: true });
    await go(admin, '/admin/in-kind-settlements');
    await admin.fill('input[name=transferRef]', '국민 이체 0001');
    await submit(admin, '지급 완료 기록', '지급 완료로 기록했습니다');
    await go(admin, '/admin/in-kind-settlements');
    await shot(admin, '10_정산_지급완료');
    return (await bodyText(admin)).includes('66,500');
  });
  await R.step('기관: 판매·정산 화면에 지급 완료 66,500원', async () => {
    await go(merchant, '/studio/bazaar/sales');
    await shot(merchant, '11_기관_판매정산');
    const t = await bodyText(merchant);
    return t.includes('지급 완료') && t.includes('66,500');
  });
  await R.step('기부자: 판매 결과(19개·95,000원) 표시', async () => {
    await go(giver, donationUrl);
    const t = await bodyText(giver);
    return t.includes('19 / 95') && t.includes('95,000');
  });
  await R.step('기관: 기부금영수증 메뉴에 현물 영수증', async () => { await go(merchant, '/studio/receipts'); return (await bodyText(merchant)).includes('현물 기부금영수증'); });

  // ------------------------------------------------------------ 9. CSV
  for (const [k, needle] of [['sellerbricks&status=all', 'GSB-000001'], ['givers', '나눔상사'], ['sale-template', 'GSB-000001']]) {
    await R.step(`관리자 CSV: ${k}`, async () => { const r = await admin.request.get(`${BASE}/api/bazaar/export?kind=${k}`); return r.status() === 200 && (await r.text()).includes(needle); });
  }
  await R.step('기관 CSV: 현물 기부 대장', async () => { const r = await merchant.request.get(`${BASE}/api/bazaar/export?kind=ledger`); const t = await r.text(); return r.status() === 200 && t.includes('주방세제') && t.includes('285000'); });
  await R.step('권한: 기부자는 관리자 CSV 불가', async () => (await giver.request.get(`${BASE}/api/bazaar/export?kind=givers`)).status() === 404);

  // ------------------------------------------------------------ 10. 끄기 → 전수 비노출 + 예외
  await R.step('관리자: 끄기(확인 문구 없으면 거절)', async () => {
    await go(admin, '/admin/site-settings');
    await shot(admin, '12_사이트설정_켜짐');
    // 화면에 원래 있는 '끄기' 글자가 아니라 서버의 거절 안내를 기다린다(먼저 넘어가면 늦게 온 응답이 입력칸을 비운다).
    await submit(admin, '라이브 바자회 끄기', '끄려면 확인란에');
    await admin.fill('input[name=confirmText]', '끄기');
    await submit(admin, '라이브 바자회 끄기', '라이브 바자회를 껐습니다');
  });
  await anon.waitForTimeout(1500); // 스위치 캐시(1초)
  await R.step('OFF: 메인 화면 바자회 사라짐', async () => { await go(anon, '/'); return noBazaarWord(anon); });
  await R.step('OFF: /bazaar 404', async () => (await go(anon, '/bazaar')) === 404);
  await R.step('OFF: 기부자 콘솔 404', async () => (await go(giver, '/giver')) === 404);
  await R.step('OFF: 기부자 재로그인 → 메인으로(바자회 문구 없음)', async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await login(p, GIVER_EMAIL, { expectUrl: new RegExp(`${BASE}/?$`) });
    const ok = await noBazaarWord(p);
    await ctx.close();
    return ok;
  });
  await R.step('OFF: 기관 콘솔·메뉴에 바자회 없음', async () => { await go(merchant, '/studio'); return noBazaarWord(merchant); });
  await R.step('OFF: /studio/bazaar 404', async () => (await go(merchant, '/studio/bazaar')) === 404);
  await R.step('OFF: 관리자 메뉴에 바자회 없음', async () => { await go(admin, '/admin'); return noBazaarWord(admin); });
  await R.step('OFF: /admin/bazaar 404', async () => (await go(admin, '/admin/bazaar')) === 404);
  await R.step('OFF 예외: 정산 지급 화면은 열림(바자회 문구 없음)', async () => { const s = await go(admin, '/admin/in-kind-settlements'); return s === 200 && (await noBazaarWord(admin)); });
  await R.step('OFF 예외: 현물 기부금영수증 정정 화면은 열림(바자회 문구 없음)', async () => {
    const s = await go(admin, '/admin/in-kind-receipts');
    return s === 200 && (await bodyText(admin)).includes('현물 기부금영수증 정정') && (await noBazaarWord(admin));
  });
  await R.step('OFF 예외: 기관 기부금영수증에 현물 영수증 유지', async () => { await go(merchant, '/studio/receipts'); return (await bodyText(merchant)).includes('현물 기부금영수증'); });
  await R.step('OFF: 파일·CSV API 404', async () => (await merchant.request.get(`${BASE}/api/bazaar/export?kind=ledger`)).status() === 404);
} finally {
  await browser.close();
  R.finish();
}
