/**
 * 8차 E2E — 정산 탭 개편 / 원천징수 미리보기 / 주민등록번호 수집 / 정산 계좌 / 금칙어.
 *
 * 정산 요청 화면의 원천징수 표시는 실제 계산식(소득세 3% + 지방소득세 10%, 소액부징수)과
 * 같은 함수를 쓰는지가 핵심이다. 옛 계산식(3.3% 일괄)이 되살아나면 여기서 잡힌다.
 */
import {
  launch, createReporter, bodyText, missingOf, gotoReady, loginMerchant,
  BASE, desktop, assertServerUp,
} from './_helpers.mjs';

await assertServerUp();
const r = createReporter('8차 — 정산 탭 · 원천징수 · 금칙어');
const b = await launch();

try {
  const ctx = await b.newContext(desktop);
  const p = await ctx.newPage();
  p.on('dialog', (d) => d.accept());
  await loginMerchant(p);

  // ══════════════ 1. 정산 관리 탭 구조 ══════════════
  await gotoReady(p, `${BASE}/studio/settlement`);
  const overview = await bodyText(p);
  r.ok('정산 관리 화면', overview.includes('정산 관리'));
  {
    const miss = missingOf(overview, ['정산 현황', '정산 요청', '정산 계좌', '정산 원장']);
    r.ok('탭 4종', miss.length === 0, miss.join(','));
  }
  r.ok('현재 탭 표시(aria-current)', (await p.locator('nav[aria-label="정산 관리 메뉴"] a[aria-current="page"]').count()) === 1);
  {
    const miss = missingOf(overview, ['정산 가능금', '정산 보류금', '정산 완료금']);
    r.ok('요약 타일 3종', miss.length === 0, miss.join(','));
  }

  // ══════════════ 2. 정산 요청 탭 — 원천징수 미리보기 ══════════════
  await gotoReady(p, `${BASE}/studio/settlement?tab=request`);
  const req = await bodyText(p);
  r.ok('정산 요청 탭이 열린다', req.includes('정산 요청'));
  {
    const miss = missingOf(req, [
      '정산 가능금',
      '소득세 (3%)',
      '지방소득세 (소득세의 10%)',
      '원천징수 합계',
      '실지급 예상',
    ]);
    r.ok('원천징수 항목별 미리보기 5줄', miss.length === 0, miss.join(','));
  }
  r.ok('원천징수 계산 방식 안내', req.includes('원천징수 계산 방식'));
  r.ok('소액부징수 기준이 안내된다', req.includes('소액부징수'));
  r.ok('10원 미만 절사 규칙이 안내된다', req.includes('10원 미만 절사'));

  // 시드 잔액(11,648원)은 소득세 340원 → 1,000원 미만이라 소액부징수 0원이어야 한다.
  r.ok('소액 구간은 원천징수 0원(소액부징수)으로 표시된다', req.includes('0원 (소액부징수)'));
  r.ok('옛 3.3% 일괄 계산 흔적이 없다', !req.includes('3.3%'));

  // 요청 폼 · 주민등록번호
  const hasForm = (await p.locator('input[name=amount]').count()) > 0;
  r.ok('정산 요청 폼 또는 계좌 인증 안내가 나온다', hasForm || req.includes('정산 계좌 인증이 필요합니다'));
  if (hasForm) {
    r.ok('요청 금액 입력칸', true);
    r.ok('주민등록번호 안내', req.includes('주민등록번호 (원천징수 신고용)'));
    r.ok('주민번호 앞 6자리 입력칸', (await p.locator('input[placeholder="앞 6자리"]').count()) > 0);
    r.ok('주민번호 뒤 7자리는 가려진다', (await p.locator('input[placeholder="뒤 7자리"][type=password]').count()) > 0);
    r.ok('주민번호 수집 동의 체크박스', (await p.locator('input[name=residentAgree]').count()) > 0);
    r.ok('주민번호 결합 hidden 필드', (await p.locator('input[type=hidden][name=resident]').count()) > 0);
    r.ok('메모 입력칸', (await p.locator('textarea[name=memo]').count()) > 0);
    r.ok('정산 요청 버튼', (await p.locator('button:has-text("정산 요청")').count()) > 0);
  }
  r.ok('정산 요청 내역 표', req.includes('정산 요청 내역'));
  if (req.includes('정산 요청 내역이 없습니다')) {
    r.ok('요청 내역이 없으면 빈 상태를 안내한다', true);
  } else {
    const miss = missingOf(req, ['요청일', '상태', '요청금', '원천징수', '실지급액']);
    r.ok('요청 내역 표 헤더', miss.length === 0, miss.join(','));
  }

  // ══════════════ 3. 정산 계좌 탭 ══════════════
  await gotoReady(p, `${BASE}/studio/settlement?tab=account`);
  const acc = await bodyText(p);
  r.ok('정산 계좌 탭이 열린다', acc.includes('정산 계좌'));
  r.ok('은행 선택', (await p.locator('select[name=bankCode]').count()) > 0);
  r.ok('예금주 입력칸', (await p.locator('input[name=holderName]').count()) > 0);
  r.ok('계좌번호 입력칸', (await p.locator('input[name=account]').count()) > 0);
  r.ok('계좌 등록/변경 버튼', (await p.locator('button:has-text("계좌 등록"), button:has-text("계좌 변경")').count()) > 0);
  r.ok('실명확인 mock 단계 고지', acc.includes('계좌 실명확인은 아직 mock 단계입니다'));

  // ══════════════ 4. 정산 원장 탭 ══════════════
  await gotoReady(p, `${BASE}/studio/settlement?tab=ledger`);
  const led = await bodyText(p);
  r.ok('정산 원장 탭이 열린다', led.includes('정산 원장'));

  // ══════════════ 5. 금칙어 · 차단 ══════════════
  await gotoReady(p, `${BASE}/studio/moderation`);
  const mod = await bodyText(p);
  r.ok('금칙어 화면이 열린다', mod.includes('금칙어 · 차단'));
  r.ok('필터 적용 시점 안내', mod.includes('필터는 방송 노출 전에 적용됩니다'));
  r.ok('금칙어 미리보기(테스터)', mod.includes('금칙어 미리보기'));
  r.ok('금칙어 입력칸', (await p.locator('input[name=word]').count()) > 0);
  {
    const opts = await p.locator('select[name=action] option').allInnerTexts();
    const miss = missingOf(opts.join('|'), ['마스킹 (별표 처리)', '차단 (결제 접수 거부)', '표시 (기록만)']);
    r.ok('처리 방식 3종', miss.length === 0, miss.join(','));
  }
  r.ok('기본 비속어 세트 버튼', (await p.locator('button:has-text("기본 비속어 세트 추가")').count()) > 0);
  r.ok('전역 금칙어 섹션', mod.includes('전역 금칙어'));
  r.ok('차단된 후원자 섹션', mod.includes('차단된 후원자'));

  // 실제 추가 → 목록 반영 → 사용 중지 → 삭제
  const WORD = `E2E금칙어${Date.now() % 100000}`;
  await p.fill('input[name=word]', WORD);
  await p.selectOption('select[name=action]', 'MASK');
  await p.locator('button:has-text("금칙어 추가")').click();
  await p.waitForTimeout(2500);
  const added = await bodyText(p);
  r.ok('금칙어가 목록에 추가된다', added.includes(WORD), added.slice(0, 160));

  const row = p.locator('tr', { hasText: WORD }).first();
  if (await row.count()) {
    await row.locator('button:has-text("사용 중지")').first().click();
    await p.waitForTimeout(2500);
    r.ok('금칙어를 사용 중지할 수 있다', (await bodyText(p)).includes('다시 사용'));

    await p.locator('tr', { hasText: WORD }).first().locator('button:has-text("삭제")').first().click();
    await p.waitForTimeout(4000);
    // 등록 성공 안내 문구에 단어가 남으므로 목록 행 수로 확인한다.
    r.ok('금칙어를 삭제할 수 있다', (await p.locator('tr', { hasText: WORD }).count()) === 0);
  }

  await ctx.close();
} catch (e) {
  r.ok('스크립트가 끝까지 실행된다', false, String(e?.message ?? e).slice(0, 200));
} finally {
  await b.close();
}

r.finish();
