import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { buildOpenApiDocument } from '@/server/api-docs/openapi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/partner/v1/openapi.json
 *
 * OpenAPI 3.1 규격 파일. Postman·코드 생성기에 그대로 넣을 수 있다.
 * 레지스트리에서 생성하므로 문서 화면과 항상 같은 내용이다.
 *
 * 인증을 걸지 않는다. 규격 자체는 비밀이 아니고, 연동을 시작하기 전에
 * 도구에 먼저 넣어 보는 경우가 많아 키를 요구하면 오히려 막힌다.
 */
export async function GET() {
  return NextResponse.json(buildOpenApiDocument(env.baseUrl), {
    headers: { 'cache-control': 'no-store' },
  });
}
