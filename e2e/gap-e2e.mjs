/**
 * 격차(gap) E2E — 기기별 안내 문구 분기와 모의(mock) 고지, 공개 페이지 전반.
 *
 * PC 는 웹 후원(PIN)만, 모바일은 문자후원이 먼저이고 그 아래 웹 후원(#web)도 함께 쓴다(점검 F H-1).
 * 그래서 문자 후원 안내(첫 문자·계좌 1회 등록·sms 링크)는 PC 에 새면 안 되고,
 * 모바일에는 문자·웹 두 방법이 모두 보여야 한다. 한쪽 문구가 반대편에 새면 후원자가 잘못된 방법을 따라간다.
 */
import {
  launch, createReporter, bodyText, missingOf, gotoReady,
  BASE, SEED, desktop, mobile, assertServerUp,
} from './_helpers.mjs';

await assertServerUp();
const r = createReporter('격차 — 기기별 안내 · 모의 고지 · 공개 페이지');
const b = await launch();
const SHOP = `${BASE}/c/${SEED.merchant1Code}`;
const digitsOf = (t) => t.replace(/[^0-9]/g, '');

try {
  // ══════════════ 1. PC 후원 페이지 ══════════════
  const dctx = await b.newContext(desktop);
  const pc = await dctx.newPage();
  await gotoReady(pc, SHOP);
  const pcT = await bodyText(pc);

  r.ok('PC: 모의 결제 고지', pcT.includes('현재 모의(mock) 결제 상태입니다'));
  r.ok('PC: 실제 출금이 없다는 고지', pcT.includes('실제 출금은 일어나지 않습니다'));
  r.ok('PC: 유튜브 댓글 등 옛 방송 고지가 없다', !/유튜브|방송/.test(pcT));
  r.ok('PC: 웹 기준 안내 문구', pcT.includes('웹 후원 방법') && pcT.includes('후원 금액을 고릅니다'));
  r.ok('PC: 번호 입력 단계 안내', pcT.includes('휴대전화 번호를 입력합니다'));
  r.ok('PC: PIN 출금 단계 안내', pcT.includes('PIN 을 입력하면 출금됩니다'));
  r.ok('PC: 유효시간 자동취소 안내', pcT.includes('유효시간 안에 입력하지 않으면 자동 취소됩니다'));
  r.ok('PC: 문자 기준 안내가 새지 않는다', !pcT.includes('첫 문자를 보내면 오는 안내') && !pcT.includes('문자 후원 방법'));
  r.ok('PC: 첫 문자 고지가 새지 않는다', !pcT.includes('처음 보내는 문자는 후원되지 않습니다'));
  // 모바일 전용 블록은 DOM 에는 있고 CSS(sm:hidden)로 감춰지므로 '보이는지'로 확인한다.
  r.ok(
    'PC: 문자용 계좌 등록 단계 제목은 보이지 않는다',
    !(await pc.getByText('계좌를 1회 등록합니다', { exact: true }).isVisible().catch(() => false)),
  );
  r.ok('PC: 모바일 하단 고정바가 보이지 않는다', (await pc.locator('div.fixed.inset-x-0.bottom-0:visible').count()) === 0);
  r.ok('PC: sms 링크가 보이지 않는다', (await pc.locator('a[href^="sms:"]:visible').count()) === 0);
  await dctx.close();

  // ══════════════ 2. 모바일 후원 페이지 ══════════════
  const mctx = await b.newContext(mobile);
  const m = await mctx.newPage();
  await gotoReady(m, SHOP);
  const mT = await bodyText(m);

  r.ok('모바일: 문자 기준 안내 유지', mT.includes('첫 문자를 보내면 오는 안내'));
  r.ok('모바일: 첫 문자는 후원되지 않는다는 고지', mT.includes('처음 보내는 문자는 후원되지 않습니다'));
  r.ok('모바일: 계좌 1회 등록 안내', mT.includes('계좌를 1회 등록합니다'));
  r.ok('모바일: 계좌번호 원문 미저장 고지', mT.includes('계좌번호 원문은 저장하지 않고'));
  r.ok('모바일: PIN 출금 단계 안내', mT.includes('PIN 을 입력하면 출금됩니다'));
  // 옛 "결제된 메시지만 방송에 표시" 고지 → 출금된 후원만 기관에 반영된다는 고지
  r.ok('모바일: 출금된 후원만 반영된다는 고지', mT.includes('출금되지 않은 요청은 반영되지 않습니다'));
  r.ok('모바일: 방송·유튜브 안내가 없다', !/유튜브|방송/.test(mT));
  {
    // 문자 후원 방법이 웹 후원 방법보다 먼저 나온다.
    const iSms = mT.indexOf('문자 후원 방법');
    const iWeb = mT.indexOf('웹 후원 방법');
    r.ok('모바일: 문자 후원 방법 → 웹 후원 방법 순서', iSms >= 0 && iWeb > iSms, `문자=${iSms} 웹=${iWeb}`);
  }
  r.ok('모바일: 웹 후원 패널(#web)이 보인다', await m.locator('#web button:has-text("웹으로 후원하기")').isVisible());
  r.ok('모바일: PC용 패널 제목이 보이지 않는다', !mT.includes(`${SEED.merchant1Name} 후원하기`));
  r.ok('모바일: PC용 작은 번호 안내가 보이지 않는다', !mT.includes('휴대폰에서 이 번호로 문자를 보내 후원할 수도 있습니다'));
  await mctx.close();

  // ══════════════ 3. 대표번호+키워드 기관 / 번호 미배정 기관 (모바일) ══════════════
  const m2ctx = await b.newContext(mobile);
  const m2 = await m2ctx.newPage();
  await gotoReady(m2, `${BASE}/c/${SEED.merchant2Code}`);
  const m2T = await bodyText(m2);
  const assigned = m2T.includes('후원 문자 번호가 아직 배정되지 않았습니다') ? false : digitsOf(m2T).includes(SEED.merchant2Mo);
  if (assigned) {
    r.ok('모바일: 대표번호+키워드 기관도 후원 문자 번호 카드가 나온다', m2T.includes('함께걷는복지재단 후원 문자 번호'));
    const href = (await m2.locator('a[href^="sms:"]').first().getAttribute('href')) ?? '';
    // 대표번호를 나눠 쓰는 기관은 문자 본문 앞에 기관 키워드가 미리 들어가야 접수된다.
    r.ok('모바일: 대표번호 기관의 sms 링크에 키워드가 미리 들어간다', decodeURIComponent(href).includes(`body=${SEED.merchant2Keyword} `), href);
  } else {
    r.ok(
      '모바일: 번호 미배정이면 웹 후원을 안내한다',
      m2T.includes('후원 문자 번호가 아직 배정되지 않았습니다') && m2T.includes('아래에서 웹으로 후원하실 수 있습니다'),
      m2T.slice(0, 160),
    );
    r.ok('모바일: 번호 미배정이어도 웹 후원 패널이 보인다', await m2.locator('#web button:has-text("웹으로 후원하기")').isVisible());
  }
  await m2ctx.close();

  // ══════════════ 4. 공개 페이지 스모크 ══════════════
  const pctx = await b.newContext(desktop);
  const p = await pctx.newPage();

  const PUBLIC = [
    ['/', '기브싸인'],
    ['/how-it-works', '이용방법'],
    ['/faq', null],
    ['/support', '문의 접수'],
    ['/login', null],
    ['/signup', null],
    ['/terms', null],
  ];
  for (const [path, needle] of PUBLIC) {
    await gotoReady(p, `${BASE}${path}`);
    const t = await bodyText(p);
    const alive = t.length > 100 && !t.includes('Application error');
    r.ok(`공개 페이지 ${path} 가 열린다`, needle ? alive && t.includes(needle) : alive, needle ?? '');
  }

  // 메인 헤더의 공통 요소
  await gotoReady(p, BASE);
  const home = await bodyText(p);
  {
    const miss = missingOf(home, ['이용방법', '고객센터']);
    r.ok('메인에 이용방법·고객센터 진입점이 있다', miss.length === 0, miss.join(','));
  }
  // 공개 푸터: 브랜드 표기와 테스트 환경 고지(mock/SAFE_MODE 일 때만)
  r.ok('공개 푸터 브랜드 표기(기브싸인 GIVESIGN)', home.includes('기브싸인 GIVESIGN') && !home.includes('GiveSign(기브싸인)'));
  r.ok('공개 푸터 테스트 환경 고지(mock)', home.includes('현재 테스트 환경이라 실제 출금과 문자 발송이 일어나지 않습니다'));

  // 공개 메뉴 "후원내역" → 로그인 없이 번호로 조회하는 시트
  const lookupBtn = p.locator('button:visible:has-text("후원내역")').first();
  r.ok('후원내역 진입점이 있다', (await lookupBtn.count()) > 0 && !home.includes('결제확인'));
  const sheet = p.locator('[role=dialog]:has(input[name=phone])');
  r.ok('후원내역 시트는 처음에 닫혀 있다', !(await sheet.isVisible()));
  await lookupBtn.click().catch(() => {});
  await p.waitForTimeout(800);
  if (await sheet.isVisible()) {
    const sheetText = await sheet.innerText();
    r.ok('후원내역 시트가 열린다', await sheet.locator('input[name=phone]').isVisible());
    r.ok('회원가입·로그인 없이 조회한다는 안내', sheetText.includes('회원가입이나 로그인은 필요하지 않습니다'));
  } else {
    r.ok('후원내역 시트가 열린다', false, '시트를 열지 못함');
  }
  await pctx.close();
} catch (e) {
  r.ok('스크립트가 끝까지 실행된다', false, String(e?.message ?? e).slice(0, 200));
} finally {
  await b.close();
}

r.finish();
