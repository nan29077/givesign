import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  API_CATEGORIES,
  allEndpoints,
  endpointCounts,
  findCategory,
  orderedCategories,
} from '@/server/api-docs';

/**
 * API 문서 레지스트리 검증.
 *
 * 핵심은 마지막 테스트다 — **실제 라우트가 레지스트리에 없으면 실패한다.**
 * 이 장치가 없으면 새 API 를 만들면서 문서를 빠뜨리게 되고, 몇 달 뒤 문서와 코드가 어긋난다.
 */

const PARTNER_ROUTE_ROOT = path.join(process.cwd(), 'src/app/api/partner/v1');

/** `src/app/api/partner/v1/**\/route.ts` 를 훑어 실제 경로 목록을 만든다. */
function collectRoutePaths(dir: string, prefix = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...collectRoutePaths(path.join(dir, entry.name), `${prefix}/${entry.name}`));
    } else if (entry.name === 'route.ts' || entry.name === 'route.tsx') {
      out.push(prefix === '' ? '/' : prefix);
    }
  }
  return out;
}

/** 동적 세그먼트 표기를 맞춘다. Next 의 `[id]` 와 문서의 `{id}` 는 같은 것으로 본다. */
function normalize(routePath: string): string {
  return routePath.replace(/\[([^\]]+)\]/g, '{$1}').replace(/\{[^}]+\}/g, '{param}');
}

describe('API 문서 레지스트리', () => {
  it('카테고리 slug 가 중복되지 않는다', () => {
    const slugs = API_CATEGORIES.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('카테고리 order 가 중복되지 않는다', () => {
    const orders = API_CATEGORIES.map((c) => c.order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('카테고리 slug 는 URL 에 쓸 수 있는 형태다', () => {
    for (const category of API_CATEGORIES) {
      expect(category.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('정적 라우트 partner-api 와 slug 가 겹치지 않는다', () => {
    // `/studio/docs/partner-api` 는 규격서 원문 화면이다. 같은 slug 를 쓰면 가려진다.
    expect(findCategory('partner-api')).toBeUndefined();
  });

  it('order 순으로 정렬된다', () => {
    const orders = orderedCategories().map((c) => c.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('엔드포인트 경로가 슬래시로 시작한다', () => {
    for (const { endpoint } of allEndpoints()) {
      expect(endpoint.path.startsWith('/')).toBe(true);
    }
  });

  it('같은 메서드·경로가 두 번 등록되지 않는다', () => {
    const keys = allEndpoints().map(({ endpoint }) => `${endpoint.method} ${endpoint.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('쓰기 요청(POST/PATCH/DELETE)은 서명을 요구한다', () => {
    for (const { endpoint } of allEndpoints()) {
      if (endpoint.method === 'GET') continue;
      expect(endpoint.signed, `${endpoint.method} ${endpoint.path}`).toBe(true);
    }
  });

  it('상태 집계가 실제 개수와 맞는다', () => {
    const counts = endpointCounts();
    expect(counts.total).toBe(counts.live + counts.beta + counts.planned);
    expect(counts.total).toBe(allEndpoints().length);
  });

  it('제공 중인 엔드포인트 목록이 실제 구현과 일치한다', () => {
    const live = allEndpoints()
      .filter(({ endpoint }) => endpoint.status === 'LIVE')
      .map(({ endpoint }) => `${endpoint.method} ${endpoint.path}`)
      .sort();
    expect(live).toEqual(
      [
        'GET /ping',
        'GET /charges',
        'POST /charges/ack',
        'POST /charges/shipment',
        // 샌드박스 (2단계)
        'POST /sandbox/mo',
        'POST /sandbox/charges/{transactionNo}/succeed',
        'POST /sandbox/charges/{transactionNo}/fail',
        'GET /sandbox/outbox',
        'POST /sandbox/reset',
        'POST /sandbox/webhooks/fire',
        // MT 발송 v1 (3단계)
        'POST /mt/messages',
        'GET /mt/messages',
        'GET /mt/messages/{id}',
        'GET /mt/templates',
        'POST /mt/templates',
        'GET /mt/quota',
        // 웹훅 (4단계)
        'POST /webhooks',
        'GET /webhooks',
        'DELETE /webhooks/{id}',
        'POST /webhooks/{id}/test',
        'GET /webhooks/deliveries',
        'POST /webhooks/deliveries/{id}/retry',
        // 상품·후원자 (5단계)
        'GET /products',
        'POST /products',
        'PATCH /products/{id}',
        'DELETE /products/{id}',
        'PATCH /products/{id}/stock',
        'POST /products/bulk',
        'GET /products/{id}/options',
        'GET /payers/{payerRef}',
        'POST /payers/link',
        'GET /payers/{payerRef}/charges',
        'DELETE /payers/link/{payerRef}',
        // 정산·통계·도구 (6단계)
        'GET /settlements',
        'GET /settlements/{id}',
        'GET /settlements/{id}/export',
        'GET /fees',
        'GET /stats/daily',
        'GET /stats/products',
        'GET /stats/messages',
        'GET /openapi.json',
      ].sort(),
    );
  });

  it('샌드박스 엔드포인트는 모두 테스트 키 전용으로 표시되어 있다', () => {
    const sandboxEndpoints = allEndpoints().filter(({ endpoint }) => endpoint.path.startsWith('/sandbox/'));
    expect(sandboxEndpoints.length).toBeGreaterThan(0);
    for (const { endpoint } of sandboxEndpoints) {
      expect(endpoint.sandboxOnly, `${endpoint.method} ${endpoint.path}`).toBe(true);
    }
  });

  /**
   * 문서 누락 방지 장치.
   * 새 `/api/partner/v1` 라우트를 만들고 레지스트리에 등록하지 않으면 여기서 실패한다.
   */
  it('실제 라우트가 모두 레지스트리에 등록되어 있다', () => {
    const actual = collectRoutePaths(PARTNER_ROUTE_ROOT).map(normalize);
    const documented = new Set(allEndpoints().map(({ endpoint }) => normalize(endpoint.path)));

    const missing = actual.filter((p) => !documented.has(p));
    expect(
      missing,
      `레지스트리에 없는 라우트입니다. src/server/api-docs/registry.ts 에 추가해 주세요: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  /** 반대 방향. LIVE 로 표시했는데 라우트가 없으면 사회복지기관이 호출하다 404 를 만난다. */
  it('LIVE 로 표시한 엔드포인트는 실제 라우트가 있다', () => {
    const actual = new Set(collectRoutePaths(PARTNER_ROUTE_ROOT).map(normalize));
    const liveMissing = allEndpoints()
      .filter(({ endpoint }) => endpoint.status === 'LIVE')
      .map(({ endpoint }) => normalize(endpoint.path))
      .filter((p) => !actual.has(p));

    expect(liveMissing, `LIVE 인데 라우트가 없습니다: ${liveMissing.join(', ')}`).toEqual([]);
  });
});
