/**
 * 10차 E2E — 알림 버튼 / 방송 닉네임 / 영업일 5일 정산주기 표시 / 공휴일 관리 / 오버레이 파이프라인.
 *
 * "사회복지기관이 정산을 요청하면 최고관리자 알림함에 실제로 꽂히는가" 를
 * 화면 클릭만으로 끝까지 확인한다.
 */
import {
  launch, createReporter, bodyText, missingOf, gotoReady, login, loginAdmin, loginMerchant,
  ACCOUNTS, BASE, SEED, desktop, mobile, assertServerUp,
} from './_helpers.mjs';

await assertServerUp();
const r = createReporter('10차 — 알림 · 정산주기 · 공휴일 · 오버레이');
const b = await launch();

const bellOf = (page) => page.locator('button[aria-label^="알림"], button[aria-label^="읽지 않은 알림"]').first();

try {
  // ══════════════ 1. 알림 버튼 노출 위치 ══════════════
  {
    const ctx = await b.newContext(desktop);
    const p = await ctx.newPage();

    // 비로그인 메인에는 알림 버튼이 없다
    await gotoReady(p, BASE);
    r.ok('비로그인 메인에는 알림 버튼이 없다', (await bellOf(p).count()) === 0);

    await login(p, ACCOUNTS.payer, { expectUrl: /\/(my|)$/ });
    await gotoReady(p, BASE);
    r.ok('로그인하면 메인 우측 상단에 알림 버튼이 생긴다', (await bellOf(p).count()) === 1);
    r.ok('알림 버튼이 보인다', await bellOf(p).isVisible());
    r.ok('알림 버튼은 접힘 상태로 시작한다', (await bellOf(p).getAttribute('aria-expanded')) === 'false');

    await bellOf(p).click();
    await p.waitForTimeout(1200);
    const panel = await bodyText(p);
    r.ok('클릭하면 알림함이 열린다', (await bellOf(p).getAttribute('aria-expanded')) === 'true');
    r.ok('알림함 제목', panel.includes('알림'));
    r.ok('알림함 안내 문구', panel.includes('최근 알림을 한곳에서 확인하세요.'));
    r.ok('알림함 닫기 버튼', (await p.locator('button[aria-label="알림 닫기"]').count()) > 0);
    r.ok('알림이 없으면 빈 상태를 안내한다', panel.includes('새 알림이 없습니다.') || panel.includes('분 전') || panel.includes('방금 전'));

    // 알림 API 가 살아있는지
    const api = await p.request.get(`${BASE}/api/notifications`);
    r.ok('알림 API 응답 200', api.ok(), `status=${api.status()}`);
    const json = await api.json().catch(() => ({}));
    r.ok('알림 API 는 items·unreadCount 를 준다', 'items' in json && 'unreadCount' in json, Object.keys(json).join(','));
    await ctx.close();
  }

  // 모바일에서는 햄버거 왼쪽에 위치한다
  {
    const ctx = await b.newContext(mobile);
    const p = await ctx.newPage();
    await login(p, ACCOUNTS.payer, { expectUrl: /\/(my|)$/ });
    await gotoReady(p, BASE);
    const bell = bellOf(p);
    r.ok('모바일: 알림 버튼이 보인다', (await bell.count()) === 1 && (await bell.isVisible()));
    const burger = p.locator('header button[aria-label="메뉴"], header button[aria-label="메뉴 열기"]').first();
    if (await burger.count()) {
      const bellBox = await bell.boundingBox();
      const burgerBox = await burger.boundingBox();
      r.ok('모바일: 알림 버튼이 햄버거 왼쪽에 있다', bellBox && burgerBox && bellBox.x < burgerBox.x, `${bellBox?.x} < ${burgerBox?.x}`);
    } else {
      r.ok('모바일: 햄버거 버튼을 찾았다', false, '헤더에서 햄버거를 찾지 못함');
    }
    await ctx.close();
  }

  // ══════════════ 1-2. 방송 닉네임 (마이페이지 + 결제 페이지 안내) ══════════════
  {
    const ctx = await b.newContext(desktop);
    const p = await ctx.newPage();
    await login(p, ACCOUNTS.payer, { expectUrl: /\/(my|)$/ });

    await gotoReady(p, `${BASE}/my/account`);
    const acc = await bodyText(p);
    r.ok('마이페이지에 방송 닉네임 섹션이 있다', acc.includes('방송 닉네임'), acc.slice(0, 160));
    r.ok('닉네임 안내 문구', acc.includes('방송 오버레이·유튜브 채팅에 표시되는 이름'));
    r.ok('닉네임 입력칸', (await p.locator('input[name=nickname]').count()) > 0);
    r.ok('방송 표시 미리보기', acc.includes('방송·유튜브 채팅에 이렇게 표시됩니다'));
    r.ok('과거 결제는 그대로 남는다는 안내', acc.includes('이미 접수된 결제는 그때 표시된 이름이 그대로 남습니다'));

    // 설정 전에는 번호 끝 4자리 기본 이름이 보인다
    r.ok('설정 전에는 끝 4자리 안내가 나온다', acc.includes('번호 끝 4자리(5678)'), acc.slice(0, 200));
    // 시드 후원자는 닉네임을 이미 정해 뒀으므로 미리보기에는 그 이름이 그대로 나온다.
    r.ok('저장된 닉네임이 미리보기에 나온다', acc.includes('테스트후원자님이 3,000원을 결제하셨습니다'), acc.slice(0, 200));

    // 실제로 저장해 본다
    const NICK = 'E2E밤톨이';
    await p.fill('input[name=nickname]', NICK);
    await p.locator('button:has-text("닉네임 저장")').click();
    await p.waitForTimeout(3000);
    const saved = await bodyText(p);
    r.ok('닉네임이 저장된다', saved.includes('닉네임이 저장되었습니다'), saved.slice(-200));
    r.ok('저장한 닉네임이 유지된다', (await p.inputValue('input[name=nickname]')) === NICK);
    r.ok('미리보기가 새 닉네임으로 바뀐다', saved.includes(`${NICK}님이`), '미리보기 문구 불일치');

    // 길이 제한(2~10자)
    await p.fill('input[name=nickname]', '가'.repeat(11));
    await p.waitForTimeout(300);
    r.ok('10자 초과는 화면에서 막힌다', (await bodyText(p)).includes('10자 이내'));

    // 결제 페이지 안내 배너
    await gotoReady(p, `${BASE}/c/${SEED.merchant1Code}`);
    const shop = await bodyText(p);
    r.ok('결제 페이지에 닉네임 안내가 뜬다', shop.includes(`방송에 ${NICK} 님으로 표시됩니다`), shop.slice(0, 200));
    r.ok('닉네임 변경 링크', (await p.locator('a[href="/my/account#nickname"]').count()) > 0);

    // 비로그인 방문자에게는 안내하지 않는다
    const anon = await b.newContext(desktop);
    const ap = await anon.newPage();
    await gotoReady(ap, `${BASE}/c/${SEED.merchant1Code}`);
    const anonText = await bodyText(ap);
    r.ok('비로그인 방문자에게는 닉네임 안내가 없다', !anonText.includes('닉네임 설정하기') && !anonText.includes('님으로 표시됩니다'));
    await anon.close();

    await ctx.close();
  }

  // ══════════════ 2. 정산 현황 — 영업일 5일 안내 + 캘린더 ══════════════
  const cctx = await b.newContext(desktop);
  const c = await cctx.newPage();
  c.on('dialog', (d) => d.accept());
  await loginMerchant(c);

  r.ok('스튜디오 헤더에도 알림 버튼이 있다', (await bellOf(c).count()) === 1);

  await gotoReady(c, `${BASE}/studio/settlement`);
  const ov = await bodyText(c);
  {
    const miss = missingOf(ov, [
      '정산은 결제일로부터',
      '영업일 5일 후',
      '토요일·일요일과 공휴일',
      '연휴가 끼면 그만큼 정산일이 뒤로 밀립니다',
      '오늘 결제되면',
      '금·토·일 결제분',
    ]);
    r.ok('정산 주기 안내가 정산 현황 상단에 있다', miss.length === 0, miss.join(','));
  }
  r.ok('예시(8월 3일 결제 → 8월 10일 정산)가 안내된다', ov.includes('8월 3일(월) 결제 → 8월 10일(월) 정산'));
  r.ok('금·토·일은 다음 주 금요일 정산이라고 안내한다', ov.includes('다음 주 금요일에 정산됩니다'));
  r.ok('결제일 → 정산일이 실제 날짜로 계산돼 표시된다', /\d+월 \d+일 \(.\) 정산/.test(ov), ov.slice(0, 120));
  {
    const miss = missingOf(ov, ['결제 (결제 완료)', '정산 예정', '지급 완료', '공휴일 (영업일 제외)']);
    r.ok('캘린더 범례가 결제·정산을 구분한다', miss.length === 0, miss.join(','));
  }
  {
    const miss = missingOf(ov, ['일', '월', '화', '수', '목', '금', '토']);
    r.ok('캘린더 요일 머리글', miss.length === 0, miss.join(','));
  }
  r.ok('캘린더 이전/다음 달 이동', (await c.locator('a[aria-label="이전 달"], a[aria-label="다음 달"]').count()) >= 2);
  r.ok('결제 건수가 날짜별로 찍힌다', /결제 \d+건/.test(ov), '시드 결제이 이번 달에 없으면 비어 있을 수 있음');
  r.ok('정산 예정일이 날짜 아래 표시된다', ov.includes('→') && ov.includes('정산'));

  // ══════════════ 3. 정산 요청 → 최고관리자 알림 ══════════════
  await gotoReady(c, `${BASE}/studio/settlement?tab=request`);
  const hasForm = (await c.locator('input[name=amount]').count()) > 0;
  r.ok('정산 요청 폼이 열린다', hasForm);
  let requested = false;
  if (hasForm) {
    await c.fill('input[placeholder="앞 6자리"]', '901010');
    await c.fill('input[placeholder="뒤 7자리"]', '1234560');
    await c.check('input[name=residentAgree]');
    await c.fill('textarea[name=memo]', 'E2E 정산 요청');
    const amount = await c.inputValue('input[name=amount]');
    await c.locator('button:has-text("정산 요청")').click();
    await c.waitForTimeout(4000);
    const res = await bodyText(c);
    // 접수 직후 화면이 갱신되므로 토스트가 아니라 요청 내역 행으로 확인한다.
    requested = (await c.locator('tr', { hasText: 'E2E 정산 요청' }).count()) > 0;
    r.ok('정산 요청이 접수된다', requested, res.slice(-300));
    r.ok('요청 내역 표에 요청 건이 생긴다', !res.includes('정산 요청 내역이 없습니다'));
    r.ok('요청 금액이 그대로 기록된다', res.includes(Number(amount).toLocaleString('ko-KR')), amount);
    r.ok('요청 즉시 정산 가능금이 0원으로 잠긴다', res.includes('현재 정산 가능한 금액이 없습니다'));
    // 소액부징수(원천징수 0원)일 때 "-0원" 으로 찍히면 안 된다.
    r.ok('원천징수 0원이 "-0원" 으로 표시되지 않는다', !res.includes('-0원'), res.slice(-200));
  }
  await cctx.close();

  // 최고관리자 알림함에 실제로 꽂혔는가
  const actx = await b.newContext(desktop);
  const a = await actx.newPage();
  a.on('dialog', (d) => d.accept());
  await loginAdmin(a);
  await gotoReady(a, `${BASE}/admin`);

  const adminBell = bellOf(a);
  r.ok('관리자 헤더에도 알림 버튼이 있다', (await adminBell.count()) === 1);
  if (requested) {
    const label = await adminBell.getAttribute('aria-label');
    r.ok('최고관리자에게 읽지 않은 알림이 잡힌다', (label ?? '').startsWith('읽지 않은 알림'), label ?? '');
    await adminBell.click();
    await a.waitForTimeout(1500);
    const panel = await bodyText(a);
    r.ok('알림함에 정산 요청 알림이 들어온다', panel.includes('새 정산 요청이 접수되었습니다'), panel.slice(0, 200));
    r.ok('알림에 정산 관리 바로가기가 걸린다', (await a.locator('a[href="/admin/settlements"]').count()) > 0);

    const apiRes = await a.request.get(`${BASE}/api/notifications`);
    const j = await apiRes.json().catch(() => ({ items: [], unreadCount: 0 }));
    r.ok('알림 API 에도 미읽음이 잡힌다', (j.unreadCount ?? 0) > 0, `unread=${j.unreadCount}`);

    await a.locator('button:has-text("모두 읽음")').first().click();
    await a.waitForTimeout(1500);
    r.ok('모두 읽음 처리가 된다', ((await bellOf(a).getAttribute('aria-label')) ?? '') === '알림');

    await gotoReady(a, `${BASE}/admin/settlements`);
    const sl = await bodyText(a);
    r.ok('관리자 정산 목록에도 요청이 올라온다', sl.includes('바람소리') && sl.includes('요청'), sl.slice(0, 160));
    r.ok('요청 행에 원천징수·실지급 열이 있다', sl.includes('원천징수') && sl.includes('실지급'));
  }

  // ══════════════ 4. 공휴일 관리 ══════════════
  await gotoReady(a, `${BASE}/admin/holidays`);
  const h = await bodyText(a);
  r.ok('공휴일 관리 화면', h.includes('공휴일 관리'));
  r.ok('정산일 계산 규칙 안내', h.includes('정산일 계산 규칙'));
  r.ok('날짜 입력칸', (await a.locator('input[name=date]').count()) > 0);
  r.ok('명칭 입력칸', (await a.locator('input[name=name]').count()) > 0);
  r.ok('메모 입력칸', (await a.locator('input[name=memo]').count()) > 0);
  {
    const opts = await a.locator('select[name=kind] option').allInnerTexts();
    const miss = missingOf(opts.join('|'), ['법정공휴일', '대체공휴일', '임시공휴일', '은행 휴무일']);
    r.ok('공휴일 종류 4종', miss.length === 0, miss.join(','));
  }
  r.ok('연도 이동 링크', (await a.locator('a[href*="/admin/holidays?year="]').count()) >= 2);

  const HOLI = '2026-12-24';
  await a.fill('input[name=date]', HOLI);
  await a.fill('input[name=name]', 'E2E 임시공휴일');
  await a.selectOption('select[name=kind]', 'TEMPORARY');
  await a.locator('button:has-text("공휴일 등록")').click();
  await a.waitForTimeout(3000);
  const added = await bodyText(a);
  r.ok('공휴일을 등록할 수 있다', added.includes('E2E 임시공휴일'), added.slice(0, 200));
  r.ok('등록 결과가 한글 날짜로 안내된다', added.includes('12월 24일'));

  const hrow = a.locator('tr', { hasText: 'E2E 임시공휴일' }).first();
  if (await hrow.count()) {
    await hrow.locator('button:has-text("삭제")').first().click();
    await a.waitForTimeout(3000);
    r.ok('공휴일을 삭제할 수 있다', (await a.locator('tr', { hasText: 'E2E 임시공휴일' }).count()) === 0);
  }
  await actx.close();

  // ══════════════ 5. 오버레이 파이프라인 (OBS·PRISM 브라우저 소스) ══════════════
  const octx = await b.newContext(desktop);
  const o = await octx.newPage();
  o.on('dialog', (d) => d.accept());
  await loginMerchant(o);
  await gotoReady(o, `${BASE}/studio/overlay`);
  const ot = await bodyText(o);

  r.ok('방송·오버레이 화면', ot.includes('방송·오버레이'));
  r.ok('OBS·PRISM 브라우저 소스 안내', ot.includes('OBS 또는 PRISM') && ot.includes('브라우저'));
  r.ok('권장 크기 안내(1920x1080)', ot.includes('1920x1080'));
  r.ok('발급 상태 표시', ot.includes('발급 상태'));
  r.ok('현재 연결 수 표시', ot.includes('현재 연결'));
  r.ok('브라우저 소스 URL 표시칸', (await o.locator('input[readonly]').count()) > 0);
  r.ok('테스트 결제 버튼', (await o.locator('button:has-text("테스트 결제 보내기")').count()) > 0);

  const previewHref = await o.locator('a:has-text("새 탭에서 미리보기")').first().getAttribute('href');
  r.ok('미리보기 링크가 있다', Boolean(previewHref), previewHref ?? '');
  const merchantId = (previewHref ?? '').match(/\/overlay\/([A-Za-z0-9]+)/)?.[1] ?? null;
  r.ok('오버레이 주소에서 사회복지기관 ID 를 얻는다', Boolean(merchantId), merchantId ?? '');

  if (merchantId) {
    const ov2 = await octx.newPage();
    await ov2.goto(`${BASE}/overlay/${merchantId}?preview=1&debug=1`, { waitUntil: 'domcontentloaded' });
    await ov2.waitForTimeout(4000);
    const dbg = await bodyText(ov2);
    r.ok('오버레이 화면이 SSE 로 연결된다', dbg.includes('연결됨'), dbg.slice(0, 120));

    // 테스트 결제 발사 → 오버레이에 배너가 뜬다
    await o.locator('button:has-text("테스트 결제 보내기")').click();
    await ov2.waitForTimeout(4000);
    const shown = await bodyText(ov2);
    r.ok('테스트 결제이 오버레이에 표시된다', shown.includes('테스트 후원자') && shown.includes('결제하셨습니다'), shown.slice(0, 160));
    r.ok('금액이 표시된다', shown.includes('3,000원'));
    r.ok('테스트 배지가 붙는다', shown.includes('테스트'));
    r.ok('메시지가 표시된다', shown.includes('오늘 방송 재미있어요'));
    r.ok('오버레이 브랜드 표기', shown.includes('GIVESIGN'));

    r.ok('스튜디오에 테스트 결제 안내가 뜬다', (await bodyText(o)).includes('실제 결제와 정산에는 반영되지 않습니다'));

    // 토큰 없이 접근하면 막힌다
    const bad = await octx.newPage();
    await bad.goto(`${BASE}/overlay/${merchantId}`, { waitUntil: 'domcontentloaded' });
    await bad.waitForTimeout(800);
    r.ok('토큰 없는 오버레이 접근은 차단된다', (await bodyText(bad)).includes('접근 권한이 없습니다'));
    await bad.close();
    await ov2.close();
  }
  await octx.close();
} catch (e) {
  r.ok('스크립트가 끝까지 실행된다', false, String(e?.message ?? e).slice(0, 200));
} finally {
  await b.close();
}

r.finish();
