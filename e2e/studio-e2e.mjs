/**
 * 스튜디오 기능 실동작 E2E.
 *  - 유튜브 채널 연결(mock OAuth) → 라이브 조회 → 연결 해제 → 재연결
 *  - 오버레이 URL 발급/재발급, 알림 꾸미기(효과·테마·TTS) 저장
 *  - 스트림 키 발급
 *  - 결제 설정(결제 금액·감사문자·결제 페이지) 저장, 프로필 저장
 */
import {
  launch, createReporter, bodyText, missingOf, gotoReady, loginMerchant,
  BASE, SEED, desktop, assertServerUp,
} from './_helpers.mjs';

await assertServerUp();
const r = createReporter('스튜디오 — 유튜브 · 오버레이 · 스트림 · 설정');
const b = await launch();

try {
  const ctx = await b.newContext(desktop);
  const p = await ctx.newPage();
  p.on('dialog', (d) => d.accept());
  await loginMerchant(p);

  // ══════════════ 1. 유튜브 채널 연결 ══════════════
  await gotoReady(p, `${BASE}/studio/youtube`);
  let yt = await bodyText(p);
  r.ok('유튜브 채널 연결 화면', yt.includes('유튜브 채널 연결'));
  r.ok('모의 연동 고지', yt.includes('현재 모의(mock) 연동 상태입니다'));
  r.ok('연결 전 안내', yt.includes('아직 연결된 채널이 없습니다') || yt.includes('다른 채널로 다시 연결'));
  r.ok('채팅 표시 형식 안내', yt.includes('채팅에 표시되는 형식'));
  r.ok('전송 결과 이력 섹션', yt.includes('최근 전송 결과'));

  const connectBtn = p.locator('a:has-text("구글 계정으로 채널 연결"), a:has-text("다른 채널로 다시 연결")').first();
  r.ok('채널 연결 버튼', (await connectBtn.count()) > 0);
  await connectBtn.click();
  await p.waitForTimeout(2000);
  const consent = await bodyText(p);
  r.ok('모의 동의 화면으로 이동한다', consent.includes('테스트용 모의 동의 화면입니다'), p.url());
  r.ok('요청 권한이 안내된다', consent.includes('기브싸인가 요청하는 권한'));
  r.ok('허용/거부 선택지가 있다', (await p.locator('a:has-text("채널 연결 허용")').count()) > 0 && (await p.locator('a:has-text("거부")').count()) > 0);

  await p.locator('a:has-text("채널 연결 허용")').click();
  await p.waitForTimeout(3000);
  yt = await bodyText(p);
  r.ok('채널이 연결된다', yt.includes('유튜브 채널을 연결했습니다.'), yt.slice(0, 160));
  r.ok('연결된 채널명이 보인다', yt.includes('기브싸인 테스트 채널'));
  r.ok('연결 상태 배지', yt.includes('연결됨'));
  r.ok('채널 ID 가 표시된다', yt.includes('채널 ID'));

  // 라이브 조회
  await p.locator('button:has-text("현재 라이브 방송 조회")').click();
  await p.waitForTimeout(3000);
  yt = await bodyText(p);
  r.ok('라이브 조회가 동작한다', yt.includes('방송 제목') || yt.includes('아직 조회된 라이브 방송이 없습니다'), yt.slice(0, 160));

  // 연결 해제 → 재연결
  await p.locator('button:has-text("연결 해제")').click();
  await p.waitForTimeout(3000);
  yt = await bodyText(p);
  r.ok('연결을 해제할 수 있다', yt.includes('연결 해제') || yt.includes('미연결'), yt.slice(0, 160));

  await p.locator('a:has-text("구글 계정으로 채널 연결"), a:has-text("다른 채널로 다시 연결")').first().click();
  await p.waitForTimeout(1500);
  await p.locator('a:has-text("채널 연결 허용")').click();
  await p.waitForTimeout(3000);
  r.ok('해제 후 다시 연결된다', (await bodyText(p)).includes('유튜브 채널을 연결했습니다.'));

  // 동의 거부 경로
  await p.locator('a:has-text("구글 계정으로 채널 연결"), a:has-text("다른 채널로 다시 연결")').first().click();
  await p.waitForTimeout(1500);
  await p.locator('a:has-text("거부")').click();
  await p.waitForTimeout(3000);
  r.ok('동의를 거부하면 안내된다', (await bodyText(p)).includes('채널 연결 동의가 거부되었습니다.'));

  // ══════════════ 2. 오버레이 URL 발급 · 설정 저장 ══════════════
  await gotoReady(p, `${BASE}/studio/overlay`);
  let ov = await bodyText(p);
  r.ok('OBS 연결 섹션', ov.includes('OBS 연결'));
  r.ok('등록 방법 안내(접이식)', ov.includes('자세한 등록 방법'));
  r.ok('토큰 원문 미보관 안내', ov.includes('토큰은 해시로만 저장되어'));

  const issueBtn = p.locator('button:has-text("URL 재발급"), button:has-text("URL 발급")').first();
  r.ok('URL 발급/재발급 버튼', (await issueBtn.count()) > 0);
  await issueBtn.click();
  await p.waitForTimeout(3500);
  ov = await bodyText(p);
  r.ok('새 브라우저 소스 URL 이 발급된다', ov.includes('새 브라우저 소스 URL을 발급했습니다'), ov.slice(0, 200));
  r.ok('발급 직후 1회만 표시된다는 안내', ov.includes('이 값은 지금 한 번만 표시됩니다'));

  // 알림 꾸미기 (효과 · 테마 · TTS)
  r.ok('효과 선택 섹션', ov.includes('효과 선택'));
  {
    const miss = missingOf(ov, ['기본', '하트', '별', '코인', '폭죽', '꽃가루', '없음']);
    r.ok('효과 7종', miss.length === 0, miss.join(','));
  }
  r.ok('테마 섹션', ov.includes('테마'));
  {
    const miss = missingOf(ov, ['기브싸인 기본', '미니멀', '네온']);
    r.ok('테마 3종', miss.length === 0, miss.join(','));
  }
  r.ok('TTS 섹션', ov.includes('TTS 읽어주기'));
  r.ok('TTS 스위치', (await p.locator('button[role=switch]').count()) > 0);
  r.ok('고급 설정(금액 구간)', ov.includes('고급 설정'));

  // 세부 표시 설정 펼치고 저장
  await p.locator('summary:has-text("세부 표시 설정")').first().click();
  await p.waitForTimeout(500);
  const detail = await bodyText(p);
  {
    const miss = missingOf(detail, ['오버레이 표시', '결제 금액 표시', '메시지 표시', '익명 처리', '화면 위치', '표시 시간 (ms)', '최대 글자 수']);
    r.ok('세부 표시 설정 항목', miss.length === 0, miss.join(','));
  }
  await p.selectOption('select[name=position]', 'TOP_RIGHT');
  await p.fill('input[name=durationMs]', '8000');
  await p.locator('button:has-text("설정 저장")').first().click();
  await p.waitForTimeout(3500);
  r.ok('오버레이 설정이 저장된다', (await bodyText(p)).includes('오버레이 설정을 저장했습니다'));

  await gotoReady(p, `${BASE}/studio/overlay`);
  await p.locator('summary:has-text("세부 표시 설정")').first().click();
  await p.waitForTimeout(400);
  r.ok('저장한 표시 위치가 유지된다', (await p.inputValue('select[name=position]')) === 'TOP_RIGHT');
  r.ok('저장한 표시 시간이 유지된다', (await p.inputValue('input[name=durationMs]')) === '8000');

  // ══════════════ 3. 자체 방송(RTMPS) — 기능이 있을 때만 검증 ══════════════
  await gotoReady(p, `${BASE}/studio/overlay`);
  const st = await bodyText(p);
  if (st.includes('자체 방송')) {
    const keyBtn = p.locator('button:has-text("스트림 키 재발급"), button:has-text("스트림 키 발급")').first();
    r.ok('스트림 키 발급 버튼', (await keyBtn.count()) > 0);
    await keyBtn.click();
    await p.waitForTimeout(3500);
    const st2 = await bodyText(p);
    r.ok('스트림 키가 발급된다', st2.includes('발급 시각') || st2.includes('사용 중'), st2.slice(0, 160));
  } else {
    // 자체방송 기능을 정리한 경우 — 잔재가 남아 화면이 깨지지 않았는지만 확인한다.
    r.ok('자체 방송 기능이 없으면 스트림 키 UI 도 남아있지 않다', (await p.locator('button:has-text("스트림 키")').count()) === 0);
  }

  // ══════════════ 4. 결제 설정 ══════════════
  await gotoReady(p, `${BASE}/studio/settings`);
  const set = await bodyText(p);
  {
    const miss = missingOf(set, ['결제 금액', '감사문자', '결제 모드', '문자번호', '결제 페이지']);
    r.ok('결제 설정 탭 5종', miss.length === 0, miss.join(','));
  }
  r.ok('문자 1건당 결제 금액 입력칸', (await p.locator('input[name=chargeAmount]').count()) > 0);
  await p.fill('input[name=chargeAmount]', '4000');
  await p.locator('button:has-text("결제 금액 저장")').click();
  await p.waitForTimeout(3500);
  r.ok('결제 금액이 저장된다', (await p.inputValue('input[name=chargeAmount]')) === '4000' || (await bodyText(p)).includes('4,000원'));

  await gotoReady(p, `${BASE}/studio/settings?tab=thanks`);
  const th = await bodyText(p);
  r.ok('감사문자 탭', th.includes('감사 문자 내용 설정'));
  r.ok('치환자 안내', th.includes('사용할 수 있는 치환자'));
  await p.fill('textarea[name=thanksMtMessage]', '{후원자}님 고맙습니다! {금액} 잘 받았습니다.');
  await p.locator('button:has-text("감사 문자 저장")').click();
  await p.waitForTimeout(3500);
  r.ok('감사 문자가 저장된다', (await bodyText(p)).includes('고맙습니다'));

  await gotoReady(p, `${BASE}/studio/settings?tab=payment`);
  const pay = await bodyText(p);
  r.ok('결제 모드 탭은 읽기 전용', pay.includes('읽기 전용') && pay.includes('사회복지기관이 변경할 수 없습니다'));

  await gotoReady(p, `${BASE}/studio/settings?tab=number`);
  const num = await bodyText(p);
  r.ok('문자번호 탭에 수신번호가 보인다', num.includes('MO 수신번호'));
  r.ok('배정된 번호가 표시된다', num.includes(SEED.merchant1Mo) || num.includes('배정된 수신번호가 없습니다'));

  await gotoReady(p, `${BASE}/studio/settings?tab=page`);
  const pg = await bodyText(p);
  r.ok('결제 페이지 탭', pg.includes('결제 페이지 꾸미기'));
  r.ok('배너 프리셋 선택', (await p.locator('input[name=bannerPreset]').count()) >= 5);
  r.ok('라이브 플랫폼 선택', (await p.locator('input[name=livePlatform]').count()) >= 3);
  await p.fill('textarea[name=description]', 'E2E 소개 문구입니다.');
  await p.locator('button:has-text("결제 페이지 설정 저장")').click();
  await p.waitForTimeout(3500);
  {
    // textarea 값은 innerText 에 안 잡히므로 저장 안내와 입력값으로 확인한다.
    const saved = await bodyText(p);
    r.ok('결제 페이지 설정이 저장된다', saved.includes('결제 페이지 설정을 저장했습니다'), saved.slice(-160));
    r.ok('저장한 소개 문구가 유지된다', (await p.inputValue('textarea[name=description]')) === 'E2E 소개 문구입니다.');
  }

  // ══════════════ 5. 프로필 ══════════════
  await gotoReady(p, `${BASE}/studio/profile`);
  const pr = await bodyText(p);
  r.ok('프로필 화면', pr.includes('채널 상태') && pr.includes('프로필 수정'));
  r.ok('사회복지기관 코드가 보인다', pr.includes(SEED.merchant1Code));
  r.ok('표시명 입력칸', (await p.locator('input[name=displayName]').count()) > 0);
  await p.fill('input[name=channelName]', 'E2E 채널');
  await p.locator('button:has-text("프로필 저장")').click();
  await p.waitForTimeout(3500);
  r.ok('프로필이 저장된다', (await p.inputValue('input[name=channelName]')) === 'E2E 채널');

  // ══════════════ 6. 결제 페이지 반영 확인 ══════════════
  const shop = await ctx.newPage();
  await gotoReady(shop, `${BASE}/c/${SEED.merchant1Code}`);
  const sh = await bodyText(shop);
  r.ok('결제 페이지에 채널명이 반영된다', sh.includes('E2E 채널'));
  r.ok('결제 페이지에 소개 문구가 반영된다', sh.includes('E2E 소개 문구입니다.'));
  await shop.close();

  await ctx.close();
} catch (e) {
  r.ok('스크립트가 끝까지 실행된다', false, String(e?.message ?? e).slice(0, 200));
} finally {
  await b.close();
}

r.finish();
