import { API_BASE_PATH } from './index';
import { orderedCategories } from './registry';
import type { ApiEndpoint } from './types';

/**
 * OpenAPI 3.1 문서 생성.
 *
 * 손으로 쓰지 않고 레지스트리에서 만든다. 문서 화면과 같은 값을 읽으므로
 * 화면과 규격 파일이 어긋날 수 없다. 새 엔드후원금를 레지스트리에 등록하면
 * 여기에도 자동으로 올라온다.
 *
 * 준비 중(PLANNED) 항목도 포함하되 `deprecated` 가 아니라 설명 첫 줄에 명시한다.
 * 빼 버리면 사회복지기관이 "문서에는 있는데 규격 파일에는 없다"고 혼란스러워한다.
 */
export function buildOpenApiDocument(baseUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const category of orderedCategories()) {
    for (const endpoint of category.endpoints ?? []) {
      const path = `${API_BASE_PATH}${endpoint.path}`;
      paths[path] ??= {};
      paths[path][endpoint.method.toLowerCase()] = operationOf(category.title, endpoint);
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: '기브싸인 사회복지기관 API',
      version: '1.0.0',
      description:
        '사회복지기관 사이트에 기브싸인을 연동하는 API 입니다. ' +
        '상태가 "준비 중"인 항목은 아직 호출되지 않으며 규격이 바뀔 수 있습니다.',
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Authorization: Bearer {API 키}' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', example: false },
            code: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths,
  };
}

function operationOf(categoryTitle: string, endpoint: ApiEndpoint) {
  const statusLine =
    endpoint.status === 'LIVE'
      ? ''
      : endpoint.status === 'BETA'
        ? '[베타] 규격이 바뀔 수 있습니다. '
        : '[준비 중] 아직 제공되지 않습니다. 규격은 예고이며 바뀔 수 있습니다. ';

  const declared = (endpoint.params ?? [])
    .filter((p) => p.in !== 'body')
    .map((p) => ({
      name: p.name,
      in: p.in === 'header' ? 'header' : p.in,
      required: Boolean(p.required) || p.in === 'path',
      description: p.description,
      schema: schemaOf(p.type),
      ...(p.example ? { example: p.example } : {}),
    }));

  // 경로에 `{id}` 같은 자리가 있는데 params 에 적어 두지 않은 엔드후원금가 있다.
  // OpenAPI 는 경로 변수가 parameters 에 없으면 잘못된 문서로 보고, 코드 생성기가
  // 호출할 수 없는 클라이언트를 만든다. 빠진 것은 여기서 채워 넣는다.
  const pathVars = [...endpoint.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  const missing = pathVars
    .filter((name) => !declared.some((p) => p.in === 'path' && p.name === name))
    .map((name) => ({
      name,
      in: 'path' as const,
      required: true,
      description: `경로 변수 ${name}`,
      schema: { type: 'string' },
    }));

  const parameters = [...missing, ...declared];

  const bodyParams = (endpoint.params ?? []).filter((p) => p.in === 'body');
  const requestBody =
    bodyParams.length > 0
      ? {
          required: bodyParams.some((p) => p.required),
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: bodyParams.filter((p) => p.required).map((p) => p.name),
                properties: Object.fromEntries(
                  bodyParams.map((p) => [p.name, { ...schemaOf(p.type), description: p.description }]),
                ),
              },
            },
          },
        }
      : undefined;

  return {
    tags: [categoryTitle],
    summary: endpoint.summary,
    description: [statusLine + (endpoint.description ?? ''), ...(endpoint.notes ?? [])].filter(Boolean).join('\n\n'),
    operationId: `${endpoint.method.toLowerCase()}${endpoint.path.replace(/[^A-Za-z0-9]+/g, '_')}`,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: {
      '200': {
        description: '성공',
        ...(endpoint.responseExample
          ? { content: { 'application/json': { example: safeParse(endpoint.responseExample) } } }
          : {}),
      },
      '400': { description: '요청 오류', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      '401': { description: '인증 실패', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    ...(endpoint.signed ? { 'x-signature-required': true } : {}),
    ...(endpoint.sandboxOnly ? { 'x-sandbox-only': true } : {}),
    'x-status': endpoint.status,
  };
}

/**
 * 레지스트리의 타입 표기를 OpenAPI 스키마로 옮긴다.
 *
 * 예전에는 number 만 integer 로 바꾸고 나머지를 전부 string 으로 내보냈다.
 * boolean·배열·날짜가 모두 문자열로 나가서, 코드 생성기가 만든 클라이언트는
 * `true` 를 `"true"` 로 보내 서버가 거절했다.
 */
function schemaOf(type: string): Record<string, unknown> {
  switch (type) {
    case 'number':
      return { type: 'integer' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object':
      return { type: 'object', additionalProperties: true };
    case 'string[]':
      return { type: 'array', items: { type: 'string' } };
    case 'number[]':
      return { type: 'array', items: { type: 'integer' } };
    case 'ISO8601':
      return { type: 'string', format: 'date-time' };
    default:
      return { type: 'string' };
  }
}

/** 예시 문자열이 JSON 이 아니어도 문서 생성이 멈추지 않게 한다. */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
