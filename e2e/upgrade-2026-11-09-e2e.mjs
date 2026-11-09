/**
 * 2026-11-09 3영역 고도화(1~5차) 새 화면 스모크 — 기관·후원자·관리자·공개.
 * 화면이 열리고(4xx/5xx 없음), 페이지 오류·콘솔 오류가 없고, 핵심 문구가 보이고, 모바일에서 가로로 넘치지 않는지 본다.
 * 문구는 화면 제목 수준만 본다(데이터에 따라 달라지는 숫자는 보지 않는다).
 */
import { launch, createReporter, login, loginMerchant, loginAdmin, bodyText, BASE, desktop, mobile, assertServerUp, ACCOUNTS, SEED } from './_helpers.mjs';

await assertServerUp();
const r = createReporter('2026-11-09 3영역 고도화 화면');
const browser = await launch();

async function visit(page, path, needles, label, { expectStatus } = {}) {
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
  const status = res?.status() ?? 500;
  if (expectStatus) r.ok(`${label} ${path} — 상태 ${status}(기대 ${expectStatus})`, status === expectStatus);
  else r.ok(`${label} ${path} — 상태 ${status}`, status < 400);
  r.ok(`${label} ${path} — 문구`, missing.length === 0, missing.join(', '));
  r.ok(`${label} ${path} — 페이지·콘솔 오류 없음`, errors.length === 0, errors.slice(0, 3).join(' | '));
  if (label === '모바일') r.ok(`${label} ${path} — 가로 넘침 없음`, !overflow);
}

// ── 기관 콘솔 ──────────────────────────────────────────────
const STUDIO = [
  // 1차
  ['/studio/inbox', ['승인 대기함']],
  ['/studio/recurring?recovery=ACTION_REQUIRED', ['정기후원']],
  ['/studio/reports?tab=funnel', []],
  ['/studio/content/review', []],
  ['/studio/supporters', []],
  // 2차
  ['/studio/donors', []],
  ['/studio/deposits', ['입금']],
  ['/studio/journeys', ['자동 안내']],
  // 3차
  ['/studio/weekly', []],
  ['/studio/goals', ['목표']],
  ['/studio/content/performance', []],
  ['/studio/content/assets', []],
  ['/studio/impact', []],
  ['/studio/reports/legal', ['법령 서식과 대조 필요']],
  // 4차
  ['/studio/campaigns/new', []],
  ['/studio/campaigns/new?mode=full', []],
  ['/studio/start', []],
  ['/studio/inquiries', []],
  ['/studio/agreements/bundles', []],
  ['/studio/document-billing', []],
  ['/studio/qr', []],
  ['/studio', []],
];

for (const [label, opts] of [['PC', desktop], ['모바일', mobile]]) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await loginMerchant(page);
  for (const [path, needles] of STUDIO) await visit(page, path, needles, label);

  // 캠페인 상세(첫 캠페인) — 기간·목표 바꾸기, 홍보물
  await page.goto(`${BASE}/studio/campaigns`, { waitUntil: 'networkidle' });
  const href = await page.locator('a[href^="/studio/campaigns/"]').evaluateAll((as) =>
    as.map((a) => a.getAttribute('href')).find((h) => h && /^\/studio\/campaigns\/[^/?]+$/.test(h) && !h.endsWith('/new')),
  );
  if (href) await visit(page, href, [], label);
  else r.ok(`${label} 캠페인 상세 링크`, false, '시드 캠페인을 찾지 못함');
  await ctx.close();
}

// ── 통합 후원자 화면 ────────────────────────────────────────
for (const [label, opts] of [['PC', desktop], ['모바일', mobile]]) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await login(page, ACCOUNTS.payer, { expectUrl: /\/(my)?$/ });
  for (const path of ['/my', '/my/recurring', '/my/notifications', '/my/documents', '/my/receipts', '/my/agreements']) {
    await visit(page, path, [], label);
  }
  await ctx.close();
}

// ── 기관 후원 회원 화면(비로그인 → 로그인 안내) · 공개 ─────────
{
  const ctx = await browser.newContext(mobile);
  const page = await ctx.newPage();
  const code = SEED.merchant1Code;
  for (const path of [`/donate/${code}`, `/donate/${code}/my/recurring`, `/donate/${code}/my/settings`, `/donate/${code}/my/receipts`]) {
    await visit(page, path, [], '모바일');
  }
  // 없는 토큰 — 오류 화면이어야 하고 500 이 아니어야 한다
  for (const path of ['/r/recover/nonexistent-token', '/mo/nonexistent-token', '/sign/bundle/nonexistent-token']) {
    const res = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    r.ok(`공개 ${path} — 잘못된 토큰은 500 아님`, (res?.status() ?? 500) < 500);
  }
  await ctx.close();
}

// ── 관리자 ────────────────────────────────────────────────
{
  const ctx = await browser.newContext(desktop);
  const page = await ctx.newPage();
  await loginAdmin(page);
  await visit(page, '/admin', [], '관리자');
  await visit(page, '/admin/fundraising', [], '관리자');
  await visit(page, '/admin/automation?tab=jobs', ['/api/cron/outbound', '/api/cron/weekly-plan', '/api/cron/inquiry-auto'], '관리자');
  await ctx.close();
}

await browser.close();
r.finish();
