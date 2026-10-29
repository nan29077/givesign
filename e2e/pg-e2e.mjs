/**
 * 문자PG 전환 E2E — 자동 정산 · 포인트 지급 처리 · 연동 API.
 *
 * 오버레이·유튜브 화면이 사라진 뒤의 **현재 제품**을 기준으로 새로 쓴 스크립트다.
 * 검증 범위
 *   1) 사회복지기관: 문자 관리에서 포인트 지급 처리(일괄) UI 가 뜨는가
 *   2) 사회복지기관: 정산 관리가 "지급 내역"(자동 지급) 구조인가, 정산 요청 폼이 사라졌는가
 *   3) 사회복지기관: 연동 API 탭에서 키 발급·폐기가 되는가
 *   4) 사회복지기관: 후원 항목 관리 — 기본 설정(FEATURE_GOODS 꺼짐)에서 실물·문서·배송 UI 가 숨는가
 *   5) 사회복지기관: MO 안내문자를 감사문자와 따로 설정할 수 있는가
 *   6) 사회복지기관: 주문·배송·문서 화면이 기본 설정에서 404 인가
 *   7) 관리자: 수수료 정책에 지급일(영업일) 항목이 있는가
 *   8) 관리자: 자동 지급 현황(예정/완료/실패/보류)이 보이는가
 *   9) 관리자: 상품·주문 모니터링이 보이는가
 *  10) 삭제된 화면(오버레이·방송)이 정말 사라졌는가
 */
import {
  BASE, launch, createReporter, loginMerchant, loginAdmin,
  bodyText, gotoReady, desktop,
} from './_helpers.mjs';

const r = createReporter('문자PG 전환 E2E');
const browser = await launch();

try {
  // ══════════════ 1. 사회복지기관 — 문자 관리 포인트 지급 ══════════════
  const mctx = await browser.newContext(desktop);
  const m = await mctx.newPage();
  await loginMerchant(m);

  await gotoReady(m, `${BASE}/studio/charges`);
  const charges = await bodyText(m);
  r.ok('문자 관리 화면이 뜬다', charges.includes('문자 관리') || charges.includes('후원 내역'), charges.slice(0, 120));
  r.ok('지급 대기 경고가 없다(후원 건은 처리할 것이 없다)', !charges.includes('지급 대기 ') || !/지급 대기 \d+건/.test(charges));
  r.ok('CSV 내려받기 링크가 있다', charges.includes('CSV') || (await m.locator('a[href*="/api/studio/charges/export"]').count()) > 0);
  r.ok('구버전(오버레이) 흔적이 없다', !charges.includes('오버레이') && !charges.includes('크리에이터'));

  // ══════════════ 2. 사회복지기관 — 정산(자동 지급) ══════════════
  await gotoReady(m, `${BASE}/studio/settlement?tab=payout`);
  const payout = await bodyText(m);
  r.ok('지급 내역 탭이 있다', payout.includes('지급 내역'));
  r.ok('다음 지급 예정 안내가 있다', payout.includes('다음 지급 예정'));
  r.ok('지급 주기(D+N)가 표시된다', /결제일 \+ 영업일 \d+일/.test(payout), payout.slice(0, 160));
  r.ok('정산 요청 폼이 사라졌다', !payout.includes('요청 금액') && !payout.includes('정산 요청을 접수'));
  r.ok('자동 지급 안내가 있다', payout.includes('자동 지급') || payout.includes('자동으로 지급'));

  await gotoReady(m, `${BASE}/studio/settlement?tab=overview`);
  const overview = await bodyText(m);
  r.ok('정산 캘린더가 뜬다', overview.includes('정산 예정') && overview.includes('지급 완료'));
  r.ok('별도 출금 요청 불필요 안내', overview.includes('별도 출금 요청은 필요하지 않습니다'));

  // ══════════════ 3. 사회복지기관 — 연동 API 키 ══════════════
  await gotoReady(m, `${BASE}/studio/settings?tab=api`);
  const api = await bodyText(m);
  r.ok('연동 API 탭이 있다', api.includes('연동 API'));
  r.ok('선택 기능임을 명시한다', api.includes('선택 기능'));
  r.ok('엔드포인트가 안내된다', api.includes('/api/partner/v1/charges'));

  await r.step('연동 키를 발급하면 값이 1회 노출된다', async () => {
    await m.fill('input[name="name"]', 'E2E 테스트 키');
    await m.getByRole('button', { name: '키 발급' }).click();
    await m.waitForTimeout(1500);
    const after = await bodyText(m);
    if (!after.includes('gs_live_')) throw new Error('발급된 키가 보이지 않음');
    if (!after.includes('지금만 확인 가능')) throw new Error('1회 노출 안내가 없음');
    return true;
  });

  await r.step('발급한 키를 폐기할 수 있다', async () => {
    await gotoReady(m, `${BASE}/studio/settings?tab=api`);
    await m.getByRole('button', { name: '폐기', exact: true }).first().click();
    await m.getByRole('button', { name: '확인', exact: true }).click();
    await m.waitForTimeout(1500);
    const after = await bodyText(m);
    if (!after.includes('폐기됨')) throw new Error('폐기 표시가 없음');
    return true;
  });

  // ══════════════ 4. 후원 항목 관리 (상품 기능은 기본 꺼짐 — FEATURE_GOODS) ══════════════
  await gotoReady(m, `${BASE}/studio/products`);
  const items = await bodyText(m);
  r.ok('후원 항목 관리 화면이 뜬다', items.includes('후원 항목 관리'));
  r.ok('기본 설정에서는 실물·문서 탭이 없다', !items.includes('실물 상품') && !items.includes('문서 상품'));
  r.ok('후원 항목 탭과 보관함만 있다', items.includes('후원 항목') && items.includes('보관함'));
  r.ok('시드 후원 항목이 보인다', items.includes('따뜻한 한 끼') && items.includes('겨울 난방비'));
  r.ok('포인트 지급 안내가 없다', !items.includes('지급은 사회복지기관이 합니다'));

  await r.step('상품 기능이 꺼져 있으면 실물 등록 주소로 들어가도 후원 항목 등록으로 처리된다', async () => {
    await gotoReady(m, `${BASE}/studio/products/new?kind=physical`);
    const t = await bodyText(m);
    if (!t.includes('후원 항목 등록')) throw new Error('후원 항목 등록 화면이 아님');
    if (t.includes('재고') || t.includes('배송비')) throw new Error('실물 전용 입력이 보임');
    return true;
  });

  await r.step('후원 항목을 새로 등록할 수 있다', async () => {
    const name = `E2E 항목 ${Date.now() % 100000}`;
    await gotoReady(m, `${BASE}/studio/products/new?kind=digital`);
    await m.locator('input[name="name"]').fill(name);
    await m.locator('input[name="amount"]').fill('12000');
    await m.getByRole('button', { name: '후원 항목 등록' }).click();
    await m.waitForTimeout(1800);
    await gotoReady(m, `${BASE}/studio/products`);
    const after = await bodyText(m);
    if (!after.includes(name)) throw new Error('등록한 항목이 보이지 않음');
    return true;
  });

  await gotoReady(m, `${BASE}/studio/settings?tab=shipping`);
  const shipTab = await bodyText(m);
  r.ok('배송 정책 탭은 기본 설정에서 보이지 않는다(후원 금액 탭으로 돌아감)', !shipTab.includes('기본 배송비') && shipTab.includes('후원 설정'));

  // ══════════════ 5. MO 안내문자 (감사문자와 별개) ══════════════
  await gotoReady(m, `${BASE}/studio/settings?tab=message`);
  const guide = await bodyText(m);
  r.ok('안내 문자 탭이 있다', guide.includes('MO 안내 문자') && guide.includes('감사 문자'));
  r.ok('두 문자의 발송 시점 차이를 안내한다', guide.includes('두 문자는 나가는 시점이 다릅니다'));
  r.ok('치환자 안내가 있다', guide.includes('{사회복지기관}') && guide.includes('{상품목록}'));
  r.ok('미리보기가 있다', guide.includes('현재 설정으로 발송되는 문자'));
  r.ok('링크 직접 입력 금지 안내가 있다', guide.includes('링크는 직접 넣을 수 없습니다'));

  await r.step('MO 안내문자에 링크를 넣으면 저장되지 않는다', async () => {
    await m.fill('textarea[name="moGuideMtMessage"]', '지금 후원 http://evil.example.com');
    await m.locator('form').filter({ has: m.locator('textarea[name="moGuideMtMessage"]') }).getByRole('button', { name: '저장', exact: true }).click();
    await m.waitForTimeout(1500);
    const after = await bodyText(m);
    if (!after.includes('링크를 넣을 수 없습니다')) throw new Error('링크가 저장을 통과함');
    return true;
  });

  // ══════════════ 6. 주문 · 배송 · 문서 (기본 설정에서는 404) ══════════════
  await r.step('상품 기능이 꺼져 있으면 /studio/orders 와 /studio/documents 는 열리지 않는다', async () => {
    const res1 = await m.goto(`${BASE}/studio/orders`, { waitUntil: 'domcontentloaded' });
    const res2 = await m.goto(`${BASE}/studio/documents`, { waitUntil: 'domcontentloaded' });
    if (res1?.status() !== 404 || res2?.status() !== 404) throw new Error(`orders=${res1?.status()} documents=${res2?.status()}`);
    return true;
  });

  // ══════════════ 7. 삭제된 화면 ══════════════
  for (const dead of ['/studio/overlay', '/studio/youtube', '/admin/overlay', '/admin/streams']) {
    await r.step(`삭제된 화면 ${dead} 은 열리지 않는다`, async () => {
      const res = await m.goto(`${BASE}${dead}`, { waitUntil: 'domcontentloaded' });
      const status = res?.status() ?? 0;
      if (status === 200) {
        const t = await bodyText(m);
        // 404 페이지가 200 으로 렌더되는 경우도 있어 본문으로 한 번 더 본다.
        if (!/찾을 수 없|404|Not Found/i.test(t)) throw new Error(`아직 살아 있음 (${status})`);
      }
      return true;
    });
  }
  await mctx.close();

  // ══════════════ 8. 관리자 — 수수료 정책 지급일 ══════════════
  const actx = await browser.newContext(desktop);
  const a = await actx.newPage();
  await loginAdmin(a);

  await gotoReady(a, `${BASE}/admin/fees`);
  const fees = await bodyText(a);
  r.ok('수수료 정책 화면이 뜬다', fees.includes('새 정책 등록'));
  r.ok('지급일(영업일) 입력이 있다', fees.includes('지급일 (영업일)'));
  r.ok('전역/사회복지기관 범위를 고를 수 있다', fees.includes('전역 (모든 사회복지기관)') && fees.includes('사회복지기관 개별'));
  r.ok('지급일 입력 필드 존재', (await a.locator('input[name="settlementDays"]').count()) > 0);

  await r.step('전역 지급일을 D+3 으로 일괄 지정할 수 있다', async () => {
    await a.selectOption('select[name="scope"]', 'GLOBAL');
    await a.fill('input[name="settlementDays"]', '3');
    a.once('dialog', (d) => d.accept());
    await a.getByRole('button', { name: '정책 등록' }).click();
    await a.waitForTimeout(2000);
    const after = await bodyText(a);
    if (!after.includes('지급일 결제일 + 3영업일')) throw new Error('등록 결과 문구 없음');
    return true;
  });

  // ══════════════ 9. 관리자 — 자동 지급 현황 ══════════════
  await gotoReady(a, `${BASE}/admin/settlements`);
  const settle = await bodyText(a);
  r.ok('자동 지급 현황 섹션이 있다', settle.includes('자동 지급 현황'));
  r.ok('오늘 지급 예정/완료 지표가 있다', settle.includes('오늘 지급 예정') && settle.includes('오늘 지급 완료'));
  r.ok('지급 실패·보류 지표가 있다', settle.includes('지급 실패') && settle.includes('지급 보류'));
  r.ok('수동 실행 버튼이 있다', settle.includes('자동 지급 지금 실행'));
  r.ok('지급대행 mock 고지가 있다', settle.includes('지급대행 연동은 아직 mock'));
  r.ok('원장 append-only 고지가 유지된다', settle.includes('정산 원장은 조회 전용입니다'));

  // ══════════════ 10. 관리자 — 상품·주문 모니터링 ══════════════
  await gotoReady(a, `${BASE}/admin/products`);
  const adminProducts = await bodyText(a);
  r.ok('상품·주문 모니터링 화면이 뜬다', adminProducts.includes('상품 · 주문'));
  r.ok('배송 상태 지표가 있다', adminProducts.includes('배송 준비') && adminProducts.includes('발송 완료'));
  r.ok('재고 부족 지표가 있다', adminProducts.includes('재고 부족'));
  r.ok('기관 후원 항목이 보인다', adminProducts.includes('따뜻한 한 끼'));
  r.ok('배송지 원문 비노출 안내가 있다', adminProducts.includes('배송지 원문은 이 화면에 표시하지 않습니다'));
  r.ok('상품 종류로 걸러낼 수 있다', adminProducts.includes('비실물') && adminProducts.includes('실물'));

  // ══════════════ 11. 공개 — 약관 ══════════════
  await gotoReady(a, `${BASE}/terms`);
  const terms = await bodyText(a);
  r.ok('이용약관이 뜬다', terms.includes('서비스 이용약관'));
  r.ok('후원은 기부이며 구매가 아니라는 조항이 있다', terms.includes('상품이나 서비스의 구매가 아닙니다'));
  r.ok('선불전자지급수단 비해당 명시', terms.includes('선불전자지급수단'));
  r.ok('영수증 무효·재발급 조항이 있다', terms.includes('무효 처리되고') && terms.includes('다시 발급'));
  r.ok('미성년자 한도 조항이 있다', terms.includes('미성년자'));

  await actx.close();
} finally {
  await browser.close();
  r.finish();
}
