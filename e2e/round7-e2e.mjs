/**
 * 7차 E2E — 고객센터 문의 채널 일원화 + 관리자 문의 관리 + 기본 보안.
 *  - /support 접수 → 접수번호 발급 → 같은 게스트는 같은 스레드로 이어짐
 *  - 최고관리자 문의 목록 검색·유형/상태/경로 필터 → 상세 답변 등록
 *  - 로그인 CSRF 차단, /api/health 공개 응답 축소
 */
import {
  launch, createReporter, bodyText, missingOf, gotoReady, loginAdmin,
  BASE, desktop, assertServerUp,
} from './_helpers.mjs';

await assertServerUp();
const r = createReporter('7차 — 문의 채널 · 관리자 문의 · 보안');
const b = await launch();
const STAMP = `E2E-${Date.now()}`;

try {
  // ══════════════ 1. 공개 고객센터 접수 폼 ══════════════
  const gctx = await b.newContext(desktop);
  const g = await gctx.newPage();
  await gotoReady(g, `${BASE}/support`);
  const supportText = await bodyText(g);

  r.ok('/support 페이지가 열린다', supportText.includes('문의 접수'));
  r.ok('문의 전 확인 안내', supportText.includes('문의 전에 확인해 주세요'));
  r.ok('문의 유형 select', (await g.locator('select[name=category]').count()) > 0);
  {
    const opts = await g.locator('select[name=category] option').allInnerTexts();
    const miss = missingOf(opts.join('|'), [
      '결제 취소 · 환불', '계좌 등록 · 자동출금 동의', '결제 오류 · 중복 결제',
      '방송 노출 · 메시지 표시', '부적절한 이용 신고', '사회복지기관 가입 · 정산', '기타 문의',
    ]);
    r.ok('문의 유형 7종', miss.length === 0, miss.join(','));
  }
  r.ok('거래번호 입력칸', (await g.locator('input[name=transactionNo]').count()) > 0);
  r.ok('문의 내용 입력칸', (await g.locator('textarea[name=content]').count()) > 0);
  r.ok('접수 버튼', (await g.locator('button:has-text("문의 접수하기")').count()) > 0);
  r.ok('자주 찾는 안내 링크', (await g.locator('a[href="/how-it-works"]').count()) > 0);

  // 유형 미선택/짧은 내용 → 검증 메시지
  await g.selectOption('select[name=category]', 'PAYMENT');
  await g.fill('textarea[name=content]', '짧음');
  await g.locator('button:has-text("문의 접수하기")').click();
  await g.waitForTimeout(1500);
  {
    // 브라우저 기본 검증(minLength=10)이 먼저 막고, 뚫려도 서버가 같은 문구로 되돌린다.
    const t = await bodyText(g);
    const blocked = !t.includes('문의가 접수되었습니다') || t.includes('문의 내용을 10자 이상 입력해 주세요.');
    r.ok('10자 미만은 접수되지 않는다', blocked, t.slice(0, 120));
    r.ok('10자 미만 검증은 minLength 로도 걸려 있다', (await g.getAttribute('textarea[name=content]', 'minlength')) === '10');
  }

  // 정상 접수
  await g.fill('textarea[name=content]', `${STAMP} 결제가 두 번 된 것 같아 확인 부탁드립니다.`);
  await g.fill('input[name=transactionNo]', 'TRD-20260819-E2ETEST');
  await g.locator('button:has-text("문의 접수하기")').click();
  await g.waitForTimeout(2500);
  const doneText = await bodyText(g);
  r.ok('문의가 접수된다', doneText.includes('문의가 접수되었습니다'), doneText.slice(0, 160));
  r.ok('접수번호가 발급된다', doneText.includes('접수번호'));
  r.ok(
    '없는 거래번호는 연결 실패를 안내한다',
    doneText.includes('해당하는 후원 내역을 찾지 못해'),
  );
  const ticket = (doneText.match(/접수번호\s*\n?\s*([0-9A-Za-z]{20,})/) ?? [])[1] ?? null;
  r.ok('접수번호 값을 읽을 수 있다', Boolean(ticket), ticket ?? doneText.slice(0, 120));

  // 같은 게스트(쿠키 유지)가 다시 접수하면 같은 스레드로 이어진다
  await g.locator('button:has-text("새 문의 작성")').click();
  await g.waitForTimeout(1500);
  await g.selectOption('select[name=category]', 'ETC');
  await g.fill('textarea[name=content]', `${STAMP} 추가로 하나 더 여쭤봅니다. 답변 부탁드립니다.`);
  await g.locator('button:has-text("문의 접수하기")').click();
  await g.waitForTimeout(2500);
  const second = await bodyText(g);
  r.ok('두 번째 접수도 성공한다', second.includes('문의가 접수되었습니다'));
  if (ticket) r.ok('같은 게스트는 같은 접수번호(스레드)로 이어진다', second.includes(ticket));

  await gctx.close();

  // ══════════════ 2. 최고관리자 문의 관리 ══════════════
  const actx = await b.newContext(desktop);
  const a = await actx.newPage();
  await loginAdmin(a);
  await gotoReady(a, `${BASE}/admin/inquiries`);
  const listText = await bodyText(a);

  r.ok('최고관리자는 문의 관리 화면을 볼 수 있다', listText.includes('문의 관리'));
  r.ok('문의 목록에 접수 건이 보인다', listText.includes(STAMP), listText.slice(0, 200));
  r.ok('검색 입력칸(q)', (await a.locator('input[name=q]').count()) > 0);
  r.ok('상태 필터', (await a.locator('select[name=status]').count()) > 0);
  r.ok('문의 유형 필터', (await a.locator('select[name=category]').count()) > 0);
  r.ok('접수 경로 필터', (await a.locator('select[name=source]').count()) > 0);
  {
    const opts = await a.locator('select[name=source] option').allInnerTexts();
    r.ok('접수 경로 옵션(문의 창·고객센터 폼)', opts.join('|').includes('고객센터 폼') && opts.join('|').includes('문의 창'));
  }

  // 검색이 실제로 걸리는지
  await a.fill('input[name=q]', STAMP);
  await a.locator('button:has-text("조회")').first().click();
  await a.waitForTimeout(2000);
  r.ok('검색어로 문의가 걸러진다', (await bodyText(a)).includes(STAMP));

  // 상세 → 답변 등록
  const row = a.locator('table a[href^="/admin/inquiries/"]').first();
  r.ok('목록에서 상세로 들어갈 수 있다', (await row.count()) > 0);
  if (await row.count()) {
    await row.click();
    await a.waitForTimeout(2500);
    const detail = await bodyText(a);
    r.ok('상세 화면이 열린다', detail.includes('문의 상세'), detail.slice(0, 140));
    r.ok('대화 내용에 접수 본문이 있다', detail.includes(STAMP));
    r.ok('답변 입력칸', (await a.locator('textarea[name=body]').count()) > 0);
    r.ok('연결된 거래 안내', detail.includes('연결된 거래') || detail.includes('찾지 못했습니다'));

    a.once('dialog', (d) => d.accept());
    await a.fill('textarea[name=body]', `${STAMP} 확인 후 안내드립니다. 중복 결제는 자동 취소됩니다.`);
    await a.locator('button:has-text("답변 등록")').click();
    await a.waitForTimeout(3000);
    const answered = await bodyText(a);
    r.ok('답변이 등록된다', answered.includes('답변을 등록했습니다') || answered.includes('관리자'), answered.slice(0, 160));

    await gotoReady(a, `${BASE}/admin/inquiries`);
    const after = await bodyText(a);
    r.ok('목록 최근 메시지에 [답변] 표시', after.includes('[답변]'));
    r.ok('상태가 답변 완료로 바뀐다', after.includes('답변 완료'));
  }
  await actx.close();

  // ══════════════ 3. 보안 ══════════════
  // 3-1. 로그인 CSRF: 외부 Origin 은 거부
  const csrf = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
    body: JSON.stringify({ email: 'admin@givesign.kr', password: 'givesign1234!' }),
  });
  r.ok('로그인 CSRF: 외부 Origin 은 403', csrf.status === 403, `status=${csrf.status}`);
  r.ok('로그인 CSRF: 거부 메시지', (await csrf.text()).includes('허용되지 않은 요청입니다'));

  // 3-2. /api/health 공개 응답은 최소 정보만
  const health = await fetch(`${BASE}/api/health`);
  const healthJson = await health.json();
  r.ok('/api/health 는 200', health.ok, `status=${health.status}`);
  r.ok('/api/health 공개 응답은 ok 만 담는다', Object.keys(healthJson).join(',') === 'ok', Object.keys(healthJson).join(','));
  r.ok('/api/health 에 연동사 정보가 새지 않는다', !('providers' in healthJson) && !('safeMode' in healthJson));

  // 3-3. 관리자 화면은 비로그인 접근 시 로그인으로 보낸다
  const nctx = await b.newContext(desktop);
  const n = await nctx.newPage();
  await gotoReady(n, `${BASE}/admin/settlements`);
  r.ok('비로그인 관리자 접근은 로그인으로 리다이렉트', n.url().includes('/login'), n.url());
  await gotoReady(n, `${BASE}/studio/settlement`);
  r.ok('비로그인 스튜디오 접근은 로그인으로 리다이렉트', n.url().includes('/login'), n.url());
  await nctx.close();
} catch (e) {
  r.ok('스크립트가 끝까지 실행된다', false, String(e?.message ?? e).slice(0, 200));
} finally {
  await b.close();
}

r.finish();
