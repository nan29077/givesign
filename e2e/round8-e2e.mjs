/**
 * 8차 E2E — 정산 탭(현황·지급 내역·계좌·원장) / 원천징수 미리보기 / 주민등록번호 수집 / 정산 계좌 / 금칙어.
 *
 * 정산은 "정산 요청" 없이 지정 지급일 자동 지급으로 바뀌었고, 원천징수 미리보기는 지급 내역 탭의
 * "다음 지급 예정" 카드에 있다. 미리보기가 실제 계산식(소득세 3% + 지방소득세 10%, 10원 미만 절사,
 * 소액부징수)과 같은 함수를 쓰는지가 핵심이다. 옛 계산식(3.3% 일괄)이 되살아나면 여기서 잡힌다.
 *
 * 시드 기관은 고유번호(사업자번호)가 있어 원천징수 "해당 없음" 이다. 그 표시를 먼저 확인하고,
 * 기관 정보 화면에서 고유번호를 비워 원천징수 대상(개인) 기관으로 바꾼 뒤 계산 안내를 검증한다.
 * (스크립트마다 재시드하므로 다른 스크립트에 영향이 없다)
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
    const tabs = (await p.locator('nav[aria-label="정산 관리 메뉴"] a').allInnerTexts()).map((t) => t.trim());
    const miss = missingOf(tabs.join('|'), ['정산 현황', '지급 내역', '정산 계좌', '정산 원장']);
    r.ok('탭 4종(현황·지급 내역·계좌·원장)', miss.length === 0 && tabs.length === 4, tabs.join(','));
    r.ok('옛 "정산 요청" 탭이 없다', !tabs.includes('정산 요청'));
  }
  r.ok('현재 탭 표시(aria-current)', (await p.locator('nav[aria-label="정산 관리 메뉴"] a[aria-current="page"]').count()) === 1);
  {
    const miss = missingOf(overview, ['정산 가능금', '정산 보류금', '정산 완료금']);
    r.ok('요약 타일 3종', miss.length === 0, miss.join(','));
  }

  // ══════════════ 2. 지급 내역 탭 — 원천징수 미리보기 ══════════════
  const PAYOUT = `${BASE}/studio/settlement?tab=payout`;
  const wonAfter = (text, label) => {
    const m = text.match(new RegExp(`${label}\\s*([\\d,]+)원`));
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };

  // ── 2-1. 사업자(고유번호 있음) 기관: 원천징수 해당 없음
  await gotoReady(p, PAYOUT);
  let pay = await bodyText(p);
  r.ok('지급 내역 탭이 열린다', pay.includes('다음 지급 예정'));
  r.ok('정산 요청이 필요 없다는 안내', pay.includes('정산 요청은 필요하지 않습니다'));
  r.ok('사업자 기관: 원천징수 해당 없음 표시', pay.includes('해당 없음 (사업자 · 세금계산서 대상)'));
  r.ok('사업자 기관: 원천징수하지 않는다는 안내', pay.includes('사업자 사회복지기관은 원천징수하지 않습니다'));
  r.ok('사업자 기관: 소득세 줄이 없다', !pay.includes('소득세 (3%)'));
  {
    const base = wonAfter(pay, '다음 회차 지급 대상');
    const net = wonAfter(pay, '실지급 예상');
    r.ok('사업자 기관: 실지급 예상 = 지급 대상 전액', base !== null && net === base, `대상=${base} 실지급=${net}`);
  }
  r.ok('지급 이력 표', pay.includes('지급 이력'));
  if (pay.includes('지급 이력이 없습니다')) {
    r.ok('지급 이력이 없으면 빈 상태를 안내한다', true);
  } else {
    const miss = missingOf(pay, ['회차 생성일', '상태', '정산금', '원천징수', '실지급액']);
    r.ok('지급 이력 표 헤더', miss.length === 0, miss.join(','));
  }
  await gotoReady(p, `${BASE}/studio/settlement?tab=account`);
  r.ok('사업자 기관: 원천징수 신고 정보(주민번호) 입력이 없다', !(await bodyText(p)).includes('원천징수 신고 정보'));

  // ── 2-2. 고유번호를 비워 원천징수 대상(개인) 기관으로 전환 (기관 정보 화면)
  await gotoReady(p, `${BASE}/studio/profile`);
  await p.fill('input[name=businessNo]', '');
  await p.locator('button[type=submit]:has-text("기관 정보 저장")').click();
  await p.waitForTimeout(2500);
  await gotoReady(p, PAYOUT);
  pay = await bodyText(p);
  {
    const miss = missingOf(pay, ['소득세 (3%)', '지방소득세 (소득세의 10%)', '원천징수 합계', '실지급 예상']);
    r.ok('개인 기관: 원천징수 항목별 미리보기', miss.length === 0, miss.join(','));
  }
  r.ok('개인 기관: 신고 정보 미등록이면 등록을 안내한다', pay.includes('원천징수 신고 정보를 등록해 주세요'));

  // ── 2-3. 정산 계좌 탭에서 원천징수 신고용 주민등록번호 등록
  await gotoReady(p, `${BASE}/studio/settlement?tab=account`);
  const accText = await bodyText(p);
  r.ok('개인 기관: 원천징수 신고 정보 섹션', accText.includes('원천징수 신고 정보'));
  r.ok('주민등록번호 안내', accText.includes('주민등록번호 (원천징수 신고용)'));
  r.ok('주민번호 앞 6자리 입력칸', (await p.locator('input[placeholder="앞 6자리"]').count()) > 0);
  r.ok('주민번호 뒤 7자리는 가려진다', (await p.locator('input[placeholder="뒤 7자리"][type=password]').count()) > 0);
  r.ok('주민번호 수집 동의 체크박스', (await p.locator('input[name=residentAgree]').count()) > 0);
  r.ok('주민번호 결합 hidden 필드', (await p.locator('input[type=hidden][name=resident]').count()) > 0);
  await p.fill('input[placeholder="앞 6자리"]', '900101');
  await p.fill('input[placeholder="뒤 7자리"]', '1234568'); // 검증 숫자가 맞는 시험용 번호
  await p.check('input[name=residentAgree]');
  await p.locator('button[type=submit]:has-text("신고 정보 저장")').click();
  await p.waitForTimeout(2500);
  await gotoReady(p, `${BASE}/studio/settlement?tab=account`);
  {
    const t = await bodyText(p);
    r.ok('주민번호는 마스킹으로만 다시 보인다', t.includes('900101-1') && !t.includes('9001011234568') && !t.includes('1234568'));
  }

  // ── 2-4. 신고 정보가 있으면 계산 방식 안내 + 실제 계산 결과
  await gotoReady(p, PAYOUT);
  pay = await bodyText(p);
  r.ok('원천징수 계산 방식 안내', pay.includes('원천징수 계산 방식'));
  r.ok('소액부징수 기준이 안내된다', pay.includes('소액부징수'));
  r.ok('10원 미만 절사 규칙이 안내된다', pay.includes('10원 미만 절사'));
  r.ok('옛 3.3% 일괄 계산 흔적이 없다', !pay.includes('3.3%'));
  {
    // 화면 값으로 2단계 계산식을 다시 계산해 맞춰 본다.
    const base = wonAfter(pay, '다음 회차 지급 대상');
    const incomeTax = base === null ? null : Math.floor((base * 3) / 100 / 10) * 10;
    const exempt = incomeTax !== null && incomeTax < 1000;
    const localTax = exempt || incomeTax === null ? 0 : Math.floor(incomeTax / 10 / 10) * 10;
    const total = exempt ? 0 : (incomeTax ?? 0) + localTax;
    r.ok('다음 회차 지급 대상 금액이 표시된다', base !== null && base > 0, String(base));
    r.ok('소득세 = 지급 대상 × 3% (10원 미만 절사, 소액부징수면 0원)', wonAfter(pay, '소득세 \\(3%\\)') === (exempt ? 0 : incomeTax));
    r.ok('지방소득세 = 소득세 × 10% (10원 미만 절사)', wonAfter(pay, '지방소득세 \\(소득세의 10%\\)') === localTax);
    if (exempt) {
      // 시드 잔액은 소득세 1,000원 미만 구간이다.
      r.ok('소액 구간은 원천징수 0원(소액부징수)으로 표시된다', pay.includes('0원 (소액부징수)'));
    } else {
      r.ok('원천징수 합계 = 소득세 + 지방소득세', wonAfter(pay, '원천징수 합계') === total);
    }
    r.ok('실지급 예상 = 지급 대상 − 원천징수', wonAfter(pay, '실지급 예상') === (base ?? 0) - total);
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
  // 금칙어는 결제를 막지 않고 후원 내역·문자에 노출되는 내용만 가린다(방송 노출 단계는 없어졌다).
  r.ok('금칙어 적용 방식 안내(결제는 막지 않는다)', mod.includes('금칙어는 결제를 막지 않고 기록만 가립니다') && mod.includes('결제는 그대로 접수됩니다'));
  r.ok('방송 노출 안내가 없다', !mod.includes('방송'));
  r.ok('금칙어 미리보기(테스터)', mod.includes('금칙어 미리보기'));
  r.ok('금칙어 입력칸', (await p.locator('input[name=word]').count()) > 0);
  {
    const opts = await p.locator('select[name=action] option').allInnerTexts();
    const miss = missingOf(opts.join('|'), ['마스킹 (별표 처리)', '표시 (기록만)']);
    r.ok('처리 방식 2종(마스킹·표시)', miss.length === 0 && opts.length === 2, opts.join('|'));
    r.ok('차단(결제 접수 거부) 방식은 새로 고를 수 없다', !opts.some((o) => o.includes('차단')));
  }
  r.ok('기본 비속어 세트 버튼', (await p.locator('button:has-text("기본 비속어 세트 추가")').count()) > 0);
  r.ok('전역 금칙어 섹션', mod.includes('전역 금칙어'));
  r.ok('차단된 후원자 섹션', mod.includes('차단된 후원자'));

  // 실제 추가 → 목록 반영 → 사용 중지 → 삭제(보관) → 같은 단어 재등록으로 되살리기
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

    // 삭제는 브라우저 confirm 이 아니라 화면 확인창(role=dialog)을 거친다.
    await p.locator('tr', { hasText: WORD }).first().locator('button:has-text("삭제")').first().click();
    const dlg = p.locator('[role=dialog]');
    await dlg.waitFor({ timeout: 10_000 });
    r.ok('삭제 확인창이 뜬다', (await dlg.innerText()).includes(WORD));
    await dlg.locator('button:has-text("확인")').click();
    // (행이 목록에서 빠지면서 확인창도 함께 사라지므로 완료 문구 대신 목록으로 확인한다)
    await p.waitForTimeout(3000);
    await p.keyboard.press('Escape');
    await gotoReady(p, `${BASE}/studio/moderation`);
    // 등록 성공 안내 문구에 단어가 남으므로 목록 행 수로 확인한다.
    r.ok('금칙어를 삭제할 수 있다(목록에서 사라진다)', (await p.locator('tr', { hasText: WORD }).count()) === 0);

    await p.fill('input[name=word]', WORD);
    await p.selectOption('select[name=action]', 'MASK');
    await p.locator('button:has-text("금칙어 추가")').click();
    await p.waitForTimeout(2500);
    await gotoReady(p, `${BASE}/studio/moderation`);
    r.ok('보관한 금칙어는 다시 등록하면 되살아난다', (await p.locator('tr', { hasText: WORD }).count()) === 1);
  }

  await ctx.close();
} catch (e) {
  r.ok('스크립트가 끝까지 실행된다', false, String(e?.message ?? e).slice(0, 200));
} finally {
  await b.close();
}

r.finish();
