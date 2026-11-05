/**
 * 6차 E2E — 후원 페이지(/c/[code]) 화면 분기 + 웹 후원 PIN 인증 전 구간.
 *
 * PC 는 웹 후원 패널이 먼저(금액·메모 → 번호 → PIN 링크 문자 → PIN 입력 → 완료) 나오고 문자 번호는 안내만,
 * 모바일은 후원 문자 번호로 문자를 보내는 흐름이 먼저, 그 아래 웹 후원 패널(#web)이 나온다(점검 F H-1).
 * 두 갈래가 각각 살아있는지 본다. (/mock/pg/pin 은 결제사 모의 화면이라 "결제" 용어를 그대로 쓴다)
 */
import {
  launch, createReporter, bodyText, missingOf, findPinLink, gotoReady,
  BASE, SEED, desktop, mobile, assertServerUp,
} from './_helpers.mjs';

await assertServerUp();
const r = createReporter('6차 — 후원 페이지 · 웹 후원 PIN 전 구간');
const b = await launch();
const SHOP = `${BASE}/c/${SEED.merchant1Code}`;

/** 속도 제한 창(기본 60초, 에포크 기준 고정 창)의 다음 경계까지 기다린다. */
async function waitNextVelocityWindow(windowSec = 60) {
  const ms = windowSec * 1000 - (Date.now() % (windowSec * 1000)) + 1000;
  console.log(`  (속도 제한 창 대기 ${Math.ceil(ms / 1000)}초)`);
  await new Promise((res) => setTimeout(res, ms));
}

/** 웹 후원 패널의 첫 번째 후원 항목(금액 칩)을 고른다. 칩은 "항목명 + 금액" 두 줄 버튼이다. */
async function pickFirstAmount(page) {
  await page.locator('#web button:has(span.block):has-text("원")').first().click();
  await page.waitForTimeout(150);
}

try {
  // ══════════════════════════════ PC ══════════════════════════════
  const ctx = await b.newContext(desktop);
  const pc = await ctx.newPage();
  await gotoReady(pc, SHOP);
  const pcText = await bodyText(pc);

  r.ok('PC: 사회복지기관 이름이 보인다', pcText.includes(SEED.merchant1Name));
  r.ok('PC: 웹 후원 패널 제목', pcText.includes(`${SEED.merchant1Name} 후원하기`));
  // 배너 미설정 기관은 프리셋 WebP 5종 중 하나가 기관별로 고정 적용된다.
  r.ok(
    'PC: 기본 배너(프리셋)가 적용된다',
    (await pc.locator('header img[src*="/assets/givesign/presets/banner-"]').count()) > 0,
  );
  r.ok('PC: 옛 기본 배너 경로를 쓰지 않는다', (await pc.locator('header img[src*="givesign-live-banner-"]').count()) === 0);
  r.ok('PC: 모의 결제 안내가 보인다', pcText.includes('현재 모의(mock) 결제 상태입니다'));
  r.ok('PC: 최근 후원 섹션', pcText.includes('최근 후원') && !pcText.includes('최근 결제'));
  r.ok('PC: 이용 한도 안내', pcText.includes('이용 한도 안내'));
  r.ok('PC: 신고·문의 링크', (await pc.locator('a[href="/support"]').count()) > 0);

  // PC 는 "웹 후원 방법" 4단계만 (문자 후원 방법은 모바일 전용)
  {
    const miss = missingOf(pcText, [
      '웹 후원 방법',
      '후원 금액을 고릅니다',
      '휴대전화 번호를 입력합니다',
      'PIN 을 입력하면 출금됩니다',
      '후원이 반영됩니다',
    ]);
    r.ok('PC: 웹 후원 방법 4단계', miss.length === 0, miss.join(','));
  }
  r.ok('PC: 방송·유튜브 안내가 없다', !/유튜브|방송에 표시/.test(pcText));
  r.ok('PC: 문자 후원 방법(모바일 전용)은 노출되지 않는다', !pcText.includes('문자 후원 방법') && !pcText.includes('첫 문자를 보내면 오는 안내'));
  r.ok('PC: 모바일용 큰 번호 카드가 없다', !pcText.includes(`${SEED.merchant1Name} 후원 문자 번호`));
  {
    // PC 에서는 문자를 보낼 수 없으므로 번호만 작게 안내한다.
    const digits = pcText.replace(/[^0-9]/g, '');
    r.ok('PC: 후원 문자 번호 안내(번호만)', pcText.includes('후원 문자 번호') && digits.includes(SEED.merchant1Mo));
  }
  r.ok('PC: sms 링크가 보이지 않는다', (await pc.locator('a[href^="sms:"]:visible').count()) === 0);

  // ── 1단계: 금액·메시지
  const startBtn = pc.locator('#web button:has-text("웹으로 후원하기")');
  r.ok('PC: 웹 후원 시작 버튼이 1개만 보인다', (await startBtn.count()) === 1 && (await startBtn.isVisible()));
  await startBtn.click();
  await pc.waitForSelector('text=1. 금액·메시지', { timeout: 20_000 }).catch(() => {});
  await pc.waitForTimeout(300);
  const composeText = await bodyText(pc);
  {
    const miss = missingOf(composeText, ['1. 금액·메시지', '2. 번호 입력', '3. PIN 입력', '4. 결제 완료']);
    r.ok('PC: 4단계 진행 표시가 나온다', miss.length === 0, miss.join(','));
  }
  r.ok('PC: 후원 금액 단계', composeText.includes('후원 금액'));
  r.ok('PC: 메모(선택) 입력', composeText.includes('메모 (선택)'));
  r.ok('PC: 직접입력 칩', (await pc.locator('button:has-text("직접입력")').count()) > 0);
  r.ok('PC: 메시지 입력창(200자)', (await pc.locator('textarea[maxlength="200"]').count()) > 0);

  // 처음에는 금액이 선택되어 있지 않아 다음 단계로 갈 수 없다.
  const pending = pc.locator('#web button:has-text("후원 금액을 선택해 주세요")');
  r.ok('PC: 금액을 고르기 전에는 다음 버튼이 막혀 있다', (await pending.count()) === 1 && (await pending.isDisabled()));
  await pickFirstAmount(pc);
  await pc.locator('textarea[maxlength="200"]').fill('E2E 자동 검증 결제입니다');
  await pc.waitForTimeout(200);
  const cta = pc.locator('button:has-text("후원 진행 (번호 입력)")');
  r.ok('PC: 금액·메시지를 채우면 다음 버튼이 활성화된다', (await cta.count()) > 0 && (await cta.isEnabled()));

  // ── 2단계: 번호 입력
  await cta.click();
  await pc.waitForSelector('input[name=phone]', { timeout: 20_000 }).catch(() => {});
  await pc.waitForTimeout(300);
  const phoneInput = pc.locator('input[name=phone]');
  r.ok('PC: 휴대전화 번호 입력칸', (await phoneInput.count()) > 0);
  r.ok(
    'PC: 이 단계에서는 출금되지 않는다는 안내',
    (await bodyText(pc)).includes('이 단계에서는 출금되지 않습니다'),
  );
  r.ok('PC: 이전 단계로 돌아가는 버튼', (await pc.locator('button:has-text("금액·메시지 다시 고르기")').count()) > 0);

  await phoneInput.fill(SEED.payerPhone);
  // 시드는 실제 흐름(handleMoInbound)으로 이 번호의 후원 4건을 방금 만들었다.
  // 그래서 재시드 직후에는 속도 제한(60초 창 3건, Redis velocity:<payer>:<창>)이 이미 차 있어 거절된다.
  // 속도 제한 자체는 이 스크립트의 검사 대상이 아니므로, run-all 이 카운터를 비우지 않았으면
  // (단독 실행) 다음 창이 열릴 때까지 기다린다.
  if (process.env.E2E_COUNTERS_CLEARED !== '1') await waitNextVelocityWindow();
  await pc.locator('button:has-text("PIN 입력 링크 문자로 받기")').click();

  // ── 3단계: PIN 링크 발송 대기 (서버 액션 응답을 기다린다)
  await pc
    .waitForSelector('#web :text("PIN 번호 입력 링크를 문자로 발송했습니다"), #web [role=alert]', { timeout: 15_000 })
    .catch(() => {});
  const waitText = await pc.locator('#web').innerText();
  r.ok('PC: PIN 링크 발송 안내가 뜬다', waitText.includes('PIN 번호 입력 링크를 문자로 발송했습니다'), waitText.slice(0, 300));
  r.ok('PC: 남은 유효시간이 표시된다', /남은 유효시간 \d{2}:\d{2}/.test(waitText));
  r.ok('PC: 등록된 번호라 계좌 등록 단계로 빠지지 않는다', !waitText.includes('결제수단 등록이 필요합니다'));

  // ── 문자로 받은 PIN 링크를 관리자 모의 발송함에서 찾는다
  const pinUrl = await findPinLink(b);
  r.ok('문자로 PIN 입력 링크가 발송됐다', Boolean(pinUrl), pinUrl ?? '모의 발송함에서 링크를 찾지 못함');

  if (pinUrl) {
    const pinPage = await ctx.newPage();
    await gotoReady(pinPage, pinUrl);
    const pinText = await bodyText(pinPage);
    r.ok('PIN 화면: 결제 PIN 인증 제목', pinText.includes('결제 PIN 인증'));
    r.ok('PIN 화면: 모의 화면 고지', pinText.includes('[MOCK] 실제 결제사 화면이 아닙니다'));
    r.ok('PIN 화면: 입력 시 출금된다는 고지', pinText.includes('PIN 입력 시 출금됩니다'));
    r.ok('PIN 화면: 사회복지기관·메시지 확인', pinText.includes(SEED.merchant1Name) && pinText.includes('E2E 자동 검증 결제입니다'));

    const pinInput = pinPage.locator('input[placeholder="000000"]');
    r.ok('PIN 화면: 6자리 입력칸', (await pinInput.count()) > 0);
    const submit = pinPage.locator('button:has-text("PIN 입력하고 결제하기")');
    r.ok('PIN 미입력 상태에서는 제출이 막힌다', await submit.isDisabled());

    await pinInput.fill('123456');
    await pinPage.waitForTimeout(200);
    r.ok('6자리를 넣으면 제출이 열린다', await submit.isEnabled());
    await submit.click();
    await pinPage.waitForTimeout(3000);
    const doneText = await bodyText(pinPage);
    r.ok('PIN 화면: 결제 완료로 바뀐다', doneText.includes('결제가 완료되었습니다'), doneText.slice(0, 160));
    r.ok('PIN 화면: 거래번호가 표시된다', doneText.includes('거래번호'));

    // 같은 링크 재사용 차단
    await gotoReady(pinPage, pinUrl);
    r.ok('PIN 링크는 1회용이다', (await bodyText(pinPage)).includes('이미 처리된 인증입니다'));
    await pinPage.close();

    // ── 4단계: 결제 페이지 화면이 폴링으로 완료를 감지한다
    await pc.waitForTimeout(6000);
    const finalText = await bodyText(pc);
    r.ok('PC: 후원 페이지가 완료 상태로 전환된다', finalText.includes('후원이 완료되었습니다'), finalText.slice(0, 160));
    r.ok('PC: 거래번호가 표시된다', finalText.includes('거래번호'));
    r.ok('PC: 한 번 더 후원하기 버튼', (await pc.locator('button:has-text("한 번 더 후원하기")').count()) > 0);

    // 완료 건이 최근 후원 목록에 올라온다
    const fresh = await ctx.newPage();
    await gotoReady(fresh, SHOP);
    r.ok('완료된 후원이 최근 후원에 노출된다', (await bodyText(fresh)).includes('E2E 자동 검증 결제입니다'));
    await fresh.close();
  }

  await ctx.close();

  // ══════════════════════════════ 모바일 ══════════════════════════════
  const mctx = await b.newContext(mobile);
  const m = await mctx.newPage();
  await gotoReady(m, SHOP);
  const mText = await bodyText(m);

  r.ok('모바일: 후원 문자 번호 카드', mText.includes(`${SEED.merchant1Name} 후원 문자 번호`));
  {
    // 화면은 1588-1234-1234 처럼 끊어 보여 주고 DB 에는 하이픈 없이 저장한다.
    // 서식이 바뀌어도 깨지지 않게 숫자만 남겨 비교한다.
    const digits = mText.replace(/[^0-9]/g, '');
    r.ok('모바일: 배정된 MO 번호가 보인다', digits.includes(SEED.merchant1Mo), '화면에서 번호를 찾지 못함');
  }
  r.ok('모바일: 번호 복사 버튼', (await m.locator('button:has-text("번호 복사")').count()) > 0);
  r.ok('모바일: sms 링크로 문자 앱을 연다', (await m.locator(`a[href^="sms:"]`).count()) > 0);
  {
    const bar = m.locator('div.fixed.inset-x-0.bottom-0');
    r.ok('모바일: 하단 고정 후원 바', (await bar.count()) > 0 && (await bar.isVisible()));
    r.ok('모바일: 하단 바에 웹 후원(#web)·문자후원하기', (await bar.locator('a[href="#web"]').count()) > 0 && (await bar.locator('a[href^="sms:"]').count()) > 0);
  }
  r.ok('모바일: 첫 문자 안내', mText.includes('처음 보내는 문자는 후원되지 않습니다'));
  {
    const miss = missingOf(mText, [
      '문자 후원 방법',
      '계좌를 1회 등록합니다',
      '후원 문자를 보냅니다',
      'PIN 을 입력하면 출금됩니다',
      '후원이 반영됩니다',
    ]);
    r.ok('모바일: 문자 후원 방법 4단계', miss.length === 0, miss.join(','));
  }
  r.ok('모바일: 방송·유튜브 안내가 없다', !/유튜브|방송에 표시/.test(mText));
  // 예전에는 웹 패널이 sm 이상에서만 보여 휴대폰에서 웹 후원이 불가능했다(점검 F H-1).
  {
    const webStart = m.locator('#web button:has-text("웹으로 후원하기")');
    r.ok('모바일: 웹 후원 패널(#web)도 보인다', (await webStart.count()) === 1 && (await webStart.isVisible()));
  }
  r.ok('모바일: PC용 패널 제목은 숨는다', !mText.includes(`${SEED.merchant1Name} 후원하기`));
  await mctx.close();

  // ══════════════ 미등록 후원자 → 등록 화면 (후원 내역 표시 이름 입력) ══════════════
  {
    const rctx = await b.newContext(desktop);
    const rp = await rctx.newPage();
    await gotoReady(rp, SHOP);
    await rp.locator('#web button:has-text("웹으로 후원하기")').click();
    await rp.waitForSelector('text=1. 금액·메시지', { timeout: 20_000 }).catch(() => {});
    await pickFirstAmount(rp);
    await rp.locator('textarea[maxlength="200"]').fill('첫 결제 시도입니다');
    await rp.locator('button:has-text("후원 진행 (번호 입력)")').click();
    await rp.waitForSelector('input[name=phone]', { timeout: 20_000 }).catch(() => {});

    // 시드에 없는 번호 → 등록 안내 문자가 나간다
    const NEW_PHONE = '010-7788-4321';
    await rp.fill('input[name=phone]', NEW_PHONE);
    await rp.locator('button:has-text("PIN 입력 링크 문자로 받기")').click();
    await rp.waitForTimeout(3000);
    r.ok('미등록 번호는 결제수단 등록 안내로 넘어간다', (await bodyText(rp)).includes('결제수단 등록이 필요합니다'));

    // 이 경로는 본인확인(인증번호)을 거치지 않는다.
    // 그래서 가입 링크를 화면으로 돌려주면 남의 번호를 적어 넣은 사람이 그 링크를 그대로 가져간다.
    // 링크는 번호 주인만 받을 수 있는 문자로만 나가야 한다.
    r.ok('등록 창 열기 버튼이 없다', (await rp.locator('button:has-text("결제수단 등록 창 열기")').count()) === 0);
    r.ok('문자로만 보낸다고 안내한다', (await bodyText(rp)).includes('문자로만 보냅니다'));
    r.ok('화면 어디에도 가입 링크가 없다', !(await rp.content()).includes('/r/'));

    // 등록 화면 검증은 문자로 나간 링크를 받아서 이어 간다(로컬 전용 모의 발송함).
    const outbox = await rp.evaluate(async (base) => {
      const res = await fetch(`${base}/api/dev/outbox`);
      return res.json();
    }, BASE);
    const guide = (outbox?.outbox ?? []).find((m) => String(m.text).includes('/r/'));
    r.ok('등록 안내 문자에 가입 링크가 담겨 나간다', Boolean(guide), '모의 발송함에서 링크를 찾지 못함');

    const link = guide ? String(guide.text).match(/https?:\/\/\S*\/r\/[A-Za-z0-9_-]+/)?.[0] : null;
    const reg = link ? await rctx.newPage() : null;
    if (reg) {
      await gotoReady(reg, link);
      await reg.waitForTimeout(500);
      const regText = await bodyText(reg);
      r.ok('등록 화면이 열린다', regText.includes('계좌 등록과 이용 동의'), regText.slice(0, 160));

      // 후원 내역에 표시될 이름 (선택 입력)
      r.ok('표시 이름 입력칸이 있다', regText.includes('후원 내역에 표시될 이름 (선택)'));
      r.ok('방송·유튜브 안내가 없다', !/유튜브|방송/.test(regText));
      const nickInput = reg.locator('input[aria-label="후원 내역에 표시될 이름"]');
      r.ok('닉네임 입력 필드', (await nickInput.count()) > 0);
      r.ok('미입력 시 끝 4자리 안내', regText.includes('번호 끝 4자리(4321)'), regText.slice(0, 240));
      r.ok('후원 내역 표시 미리보기', regText.includes('후원 내역에 이렇게 표시됩니다'));
      // 기관 화면·후원 내역에서 실제로 쓰는 이름과 같아야 한다(자동 생성 이름은 끝 4자리로 표시된다).
      r.ok('기본 이름 미리보기가 후원 내역 표기와 같다', regText.includes('4321님이 3,000원을 후원했습니다'));
      r.ok('미리보기에 후원자 접두사가 붙지 않는다', !regText.includes('후원자4321님이'));
      r.ok('나중에 바꿀 수 있다는 안내', regText.includes('마이페이지에서 언제든지 바꿀 수 있습니다'));

      // 입력하면 미리보기가 즉시 바뀐다
      await nickInput.fill('밤톨이');
      await reg.waitForTimeout(400);
      r.ok('닉네임을 넣으면 미리보기가 바뀐다', (await bodyText(reg)).includes('밤톨이님이 3,000원을 후원했습니다'));

      // 길이 제한(2~10자)
      await nickInput.fill('가'.repeat(11));
      await reg.waitForTimeout(400);
      r.ok('10자를 넘기면 경고가 뜬다', (await bodyText(reg)).includes('10자 이내'));
      await nickInput.fill('');
      await reg.waitForTimeout(300);
      r.ok('비우면 다시 기본 이름 미리보기로 돌아간다', (await bodyText(reg)).includes('4321님이 3,000원을'));

      await reg.close();
    }
    await rctx.close();
  }

  // ══════════════════════════════ 잘못된 코드 ══════════════════════════════
  const nctx = await b.newContext(desktop);
  const n = await nctx.newPage();
  await gotoReady(n, `${BASE}/c/GIV-XXXX`);
  r.ok('없는 코드는 안내 화면을 보여준다', (await bodyText(n)).includes('사회복지기관을 찾을 수 없습니다'));
  await nctx.close();
} catch (e) {
  r.ok('스크립트가 끝까지 실행된다', false, String(e?.message ?? e).slice(0, 200));
} finally {
  await b.close();
}

r.finish();
