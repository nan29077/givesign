/**
 * E2E 공통 도우미.
 *
 * 목적: 브라우저 수준(실제 클릭·입력)으로 화면이 깨졌는지 확인한다.
 * 단위 테스트(tests/*.test.ts)가 서버 로직을 보는 것과 역할이 다르다.
 *
 * 실행 전제
 *  - 개발 서버가 떠 있어야 한다: npm run dev  (기본 http://localhost:3060)
 *  - 시드 계정이 있어야 한다: npm run db:reset && npm run db:seed
 *  - 크로미움: 기본은 Playwright 가 설치한 브라우저를 쓴다.
 *    (컨테이너처럼 사전 설치본을 쓰는 환경은 E2E_CHROMIUM 으로 경로를 넘긴다)
 */
import fs from 'node:fs';
import { chromium } from 'playwright';

export const BASE = process.env.E2E_BASE ?? 'http://localhost:3060';
export const PASSWORD = 'givesign1234!';

export const ACCOUNTS = {
  admin: 'admin@givesign.kr',
  merchant1: 'merchant1@givesign.kr',
  merchant2: 'merchant2@givesign.kr',
  payer: 'payer@givesign.kr',
};

/** 시드 고정값 */
export const SEED = {
  merchant1Code: 'GIV-8K2M',
  merchant2Code: 'GIV-3QP7',
  merchant1Name: '햇살종합사회복지관',
  merchant1Mo: '158812341234',
  merchant2Mo: '158812345678',
  merchant2Keyword: 'GIV3QP7',
  payerPhone: '010-1234-5678',
};

const PREINSTALLED = '/opt/pw-browsers/chromium';

/** 환경에 맞는 크로미움으로 브라우저를 띄운다. */
export async function launch(options = {}) {
  const explicit = process.env.E2E_CHROMIUM;
  const executablePath = explicit || (fs.existsSync(PREINSTALLED) ? PREINSTALLED : undefined);
  return chromium.launch({ ...(executablePath ? { executablePath } : {}), ...options });
}

/**
 * 결과 수집기.
 * ok(name, pass, detail) 로 한 건씩 쌓고, finish() 로 요약 출력 + 종료코드를 정한다.
 */
export function createReporter(title) {
  const results = [];
  const ok = (name, pass, detail = '') => {
    results.push({ name, pass: Boolean(pass), detail });
    console.log(`${pass ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
    return Boolean(pass);
  };

  /** 예외가 나도 스크립트 전체가 죽지 않게 감싼다. */
  const step = async (name, fn) => {
    try {
      const value = await fn();
      if (value === false) return ok(name, false, '조건 불충족');
      return ok(name, true);
    } catch (e) {
      return ok(name, false, String(e?.message ?? e).slice(0, 180));
    }
  };

  const finish = () => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n──────── ${title} ────────`);
    console.log(`총 ${results.length}건 · 성공 ${results.length - failed.length}건 · 실패 ${failed.length}건`);
    if (failed.length) {
      console.log('실패 목록:');
      for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' | ' + f.detail : ''}`);
    }
    process.exitCode = failed.length ? 1 : 0;
    return failed.length;
  };

  return { ok, step, finish, results };
}

/** 로그인. 성공하면 목적지 URL 로 이동한 상태가 된다. */
export async function login(page, email, { expectUrl = /\/(studio|admin|my|)$/ } = {}) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', PASSWORD);
  await Promise.all([
    page.waitForURL(expectUrl, { timeout: 20_000 }),
    page.click('button[type=submit]'),
  ]);
}

export const loginMerchant = (page) => login(page, ACCOUNTS.merchant1, { expectUrl: /\/studio/ });
export const loginAdmin = (page) => login(page, ACCOUNTS.admin, { expectUrl: /\/admin/ });

/** 페이지 전체 텍스트 */
export const bodyText = (page) => page.locator('body').innerText();

/**
 * 하이드레이션까지 끝난 상태로 이동한다.
 * dev 서버는 첫 진입에서 컴파일이 끼어들어 domcontentloaded 직후에는
 * 클릭이 먹지 않는 경우가 있어 networkidle 을 기준으로 삼는다.
 */
export async function gotoReady(page, url, { timeout = 45_000 } = {}) {
  await page.goto(url, { waitUntil: 'networkidle', timeout });
  await page.waitForTimeout(200);
}

/** 특정 영역 텍스트 (없으면 빈 문자열) */
export async function textOf(page, selector) {
  const n = await page.locator(selector).count();
  if (!n) return '';
  return page.locator(selector).first().innerText();
}

/** 여러 문구가 모두 들어있는지 */
export const includesAll = (haystack, needles) => needles.every((n) => haystack.includes(n));

/** 없는 문구 목록을 돌려준다 (실패 사유 출력용) */
export const missingOf = (haystack, needles) => needles.filter((n) => !haystack.includes(n));

/** 데스크톱/모바일 컨텍스트 */
export const desktop = { viewport: { width: 1500, height: 950 } };
export const mobile = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

/**
 * 관리자 화면의 "개발용 모의 발송함" 을 읽어 최근 MT 본문을 돌려준다.
 * mock MT 어댑터는 메모리에만 적재하므로 이 화면이 유일한 확인 경로다.
 * (보안링크 토큰은 마스킹되지만 PIN 링크의 session 파라미터는 그대로 보인다)
 */
export async function readMockOutbox(browser) {
  const ctx = await browser.newContext(desktop);
  try {
    const page = await ctx.newPage();
    await loginAdmin(page);
    await page.goto(`${BASE}/admin/mt-messages`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    return await bodyText(page);
  } finally {
    await ctx.close();
  }
}

/** 모의 발송함에서 PIN 입력 링크를 찾아낸다. 없으면 null. */
export async function findPinLink(browser, { attempts = 8, waitMs = 1200 } = {}) {
  const re = /https?:\/\/[^\s)]*\/mock\/pg\/pin\?session=[A-Za-z0-9._-]+/;
  for (let i = 0; i < attempts; i += 1) {
    const text = await readMockOutbox(browser);
    const found = text.match(re);
    if (found) return found[0];
    await new Promise((res) => setTimeout(res, waitMs));
  }
  return null;
}

/** 서버가 떠 있는지 먼저 확인한다. 안 떠 있으면 즉시 종료(원인 파악 시간 절약). */
export async function assertServerUp() {
  const res = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!res) {
    console.error(`[중단] ${BASE} 에 접속할 수 없습니다. 다른 터미널에서 npm run dev 를 먼저 실행하세요.`);
    process.exit(2);
  }
}
