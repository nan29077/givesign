/**
 * 2026-11-06 고도화 화면 스모크 (기관·관리자).
 * 새 화면이 열리고(4xx/5xx 없음), 페이지 오류·콘솔 오류가 없고, 핵심 문구가 보이는지 확인한다.
 */
import { launch, createReporter, loginMerchant, loginAdmin, bodyText, BASE, desktop, mobile, assertServerUp } from './_helpers.mjs';

await assertServerUp();
const r = createReporter('2026-11-06 자동화 고도화 화면');
const browser = await launch();

async function visit(page, path, needles, label) {
  const errors = [];
  const onErr = (e) => errors.push(String(e.message ?? e));
  const onConsole = (m) => { if (m.type() === 'error' && !/favicon|404 \(Not Found\)/.test(m.text())) errors.push(m.text()); };
  page.on('pageerror', onErr);
  page.on('console', onConsole);
  const res = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(300);
  const text = await bodyText(page);
  const missing = needles.filter((n) => !text.includes(n));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  page.off('pageerror', onErr);
  page.off('console', onConsole);
  r.ok(`${label} ${path} — 상태 ${res?.status()}`, (res?.status() ?? 500) < 400);
  r.ok(`${label} ${path} — 문구`, missing.length === 0, missing.join(', '));
  r.ok(`${label} ${path} — 페이지·콘솔 오류 없음`, errors.length === 0, errors.slice(0, 3).join(' | '));
  if (label === '모바일') r.ok(`${label} ${path} — 가로 넘침 없음`, !overflow);
}

for (const [label, opts] of [['PC', desktop], ['모바일', mobile]]) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await loginMerchant(page);
  await visit(page, '/studio/inbox', ['승인 대기함', '자동화 준비도'], label);
  await visit(page, '/studio/journeys', ['자동 안내', '후원 감사', '연말 감사장', '봉사 전날 안내'], label);
  await visit(page, '/studio/documents?tab=purposes', ['용도'], label);
  await visit(page, '/studio/documents/issued', ['발급'], label);
  await visit(page, '/studio/volunteers/postings', ['모집'], label);
  await visit(page, '/studio/content', ['콘텐츠'], label);
  await visit(page, '/studio/channels', ['유튜브', '틱톡'], label);
  // 사이드바 '승인 대기함'은 PC 에서 항상 보인다. 모바일 대시보드 띠는 처리할 일·필수 누락이 있을 때만 그린다.
  await visit(page, '/studio', label === 'PC' ? ['승인 대기함'] : [], label);
  await ctx.close();
}

{
  const ctx = await browser.newContext(desktop);
  const page = await ctx.newPage();
  await loginAdmin(page);
  await visit(page, '/admin/automation?tab=jobs', ['/api/cron/events', '/api/cron/receipts', '재시도 소진'], '관리자');
  await visit(page, '/admin/automation?tab=content', ['콘텐츠'], '관리자');
  await ctx.close();
}

await browser.close();
r.finish();
