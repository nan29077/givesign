/**
 * 격차(gap) E2E — 기기별 안내 문구 분기와 모의(mock) 고지, 공개 페이지 전반.
 *
 * PC 는 화면에서 바로 결제, 모바일은 문자 발송이라 안내 문구가 서로 달라야 한다.
 * 한쪽 문구가 반대편에 새면 후원자가 잘못된 방법을 따라가게 되므로 여기서 막는다.
 */
import {
  launch, createReporter, bodyText, missingOf, gotoReady,
  BASE, SEED, desktop, mobile, assertServerUp,
} from './_helpers.mjs';

await assertServerUp();
const r = createReporter('격차 — 기기별 안내 · 모의 고지 · 공개 페이지');
const b = await launch();
const SHOP = `${BASE}/c/${SEED.merchant1Code}`;

try {
  // ══════════════ 1. PC 결제 페이지 ══════════════
  const dctx = await b.newContext(desktop);
  const pc = await dctx.newPage();
  await gotoReady(pc, SHOP);
  const pcT = await bodyText(pc);

  r.ok('PC: 모의 결제 고지', pcT.includes('현재 모의(mock) 결제 상태입니다'));
  r.ok('PC: 실제 출금이 없다는 고지', pcT.includes('실제 출금이나 유튜브 댓글 등록은 일어나지 않습니다'));
  r.ok('PC: 웹 기준 안내 문구', pcT.includes('금액과 응원 메시지를 고릅니다'));
  r.ok('PC: 번호 입력 단계 안내', pcT.includes('휴대전화 번호를 입력합니다'));
  r.ok('PC: PIN 결제 단계 안내', pcT.includes('PIN 을 입력하면 결제됩니다'));
  r.ok('PC: 유효시간 자동취소 안내', pcT.includes('유효시간 안에 입력하지 않으면 자동 취소됩니다'));
  r.ok('PC: 문자 기준 안내가 새지 않는다', !pcT.includes('첫 문자를 보내면 오는 안내'));
  // 모바일 전용 블록은 DOM 에는 있고 CSS(sm:hidden)로 감춰지므로 '보이는지'로 확인한다.
  r.ok(
    'PC: 문자용 계좌 등록 단계 제목은 보이지 않는다',
    !(await pc.getByText('계좌를 1회 등록합니다', { exact: true }).isVisible().catch(() => false)),
  );
  r.ok('PC: 모바일 하단 고정바가 보이지 않는다', (await pc.locator('div.fixed.inset-x-0.bottom-0:visible').count()) === 0);
  r.ok('PC: sms 링크가 보이지 않는다', (await pc.locator('a[href^="sms:"]:visible').count()) === 0);
  await dctx.close();

  // ══════════════ 2. 모바일 결제 페이지 ══════════════
  const mctx = await b.newContext(mobile);
  const m = await mctx.newPage();
  await gotoReady(m, SHOP);
  const mT = await bodyText(m);

  r.ok('모바일: 문자 기준 안내 유지', mT.includes('첫 문자를 보내면 오는 안내'));
  r.ok('모바일: 첫 문자는 결제되지 않는다는 고지', mT.includes('처음 보내는 문자는 결제되지 않습니다'));
  r.ok('모바일: 계좌 1회 등록 안내', mT.includes('계좌를 1회 등록합니다'));
  r.ok('모바일: 계좌번호 원문 미저장 고지', mT.includes('계좌번호 원문은 저장하지 않고'));
  r.ok('모바일: PIN 결제 단계 안내', mT.includes('PIN 을 입력하면 결제됩니다'));
  r.ok('모바일: 결제된 결제만 방송에 나간다는 고지', mT.includes('결제되지 않은 메시지는 표시되지 않습니다'));
  r.ok('모바일: 웹 기준 안내가 보이지 않는다', (await m.locator('p:has-text("금액과 응원 메시지를 고릅니다"):visible').count()) === 0);
  r.ok('모바일: PC 결제 패널이 보이지 않는다', (await m.locator('h2:has-text("님에게 결제하기"):visible, div.hidden.sm\\:block:visible').count()) === 0);
  await mctx.close();

  // ══════════════ 3. 번호 미배정 사회복지기관(모바일) ══════════════
  const m2ctx = await b.newContext(mobile);
  const m2 = await m2ctx.newPage();
  await gotoReady(m2, `${BASE}/c/${SEED.merchant2Code}`);
  const m2T = await bodyText(m2);
  const assigned = m2T.includes('전용 결제 수신번호') || m2T.includes(SEED.merchant2Mo);
  if (assigned) {
    r.ok('모바일: 대표번호+키워드 사회복지기관도 결제 안내가 나온다', true);
  } else {
    r.ok(
      '모바일: 번호 미배정이면 PC 이용을 안내한다',
      m2T.includes('결제 수신번호가 아직 배정되지 않았습니다') && m2T.includes('PC 에서는 지금도 결제하실 수 있습니다'),
      m2T.slice(0, 160),
    );
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
  r.ok('결제확인 진입점이 있다', home.includes('결제확인'));

  // 결제확인 시트(로그인 없이 번호로 조회)
  await p.locator('a[href="#lookup"], button:has-text("결제확인")').first().click().catch(() => {});
  await p.waitForTimeout(1200);
  const sheet = await bodyText(p);
  if (sheet.includes('결제확인')) {
    r.ok('결제확인 시트가 열린다', (await p.locator('input[name=phone]').count()) > 0 || sheet.includes('휴대전화 번호'));
    r.ok('회원가입·로그인 없이 조회한다는 안내', sheet.includes('회원가입이나 로그인은 필요하지 않습니다') || sheet.includes('로그인 없이'));
  } else {
    r.ok('결제확인 시트가 열린다', false, '시트를 열지 못함');
  }
  await pctx.close();
} catch (e) {
  r.ok('스크립트가 끝까지 실행된다', false, String(e?.message ?? e).slice(0, 200));
} finally {
  await b.close();
}

r.finish();
