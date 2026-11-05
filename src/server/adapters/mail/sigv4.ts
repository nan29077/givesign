import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 (node:crypto 직접 구현).
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 *
 * @aws-sdk/client-sesv2 를 설치하지 않고 SES v2 HTTP API 를 부르기 위해 둔다. 서명 대상 헤더는
 * host · content-type · x-amz-content-sha256 · x-amz-date (+ 세션 토큰이 있으면 x-amz-security-token).
 * 테스트가 @smithy/signature-v4(클라이언트 S3 가 쓰는 서명기)와 같은 값을 내는지 대조한다.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | null;
}

export interface SignInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  date?: Date;
}

const sha256Hex = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const hmac = (key: Buffer | string, v: string) => createHmac('sha256', key).update(v, 'utf8').digest();

/** RFC 3986 인코딩 (AWS 규칙: 경로 세그먼트·쿼리 값) */
function encodeRfc3986(v: string) {
  return encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function amzDate(d: Date) {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

export function signingKey(secret: string, dateStamp: string, region: string, service: string) {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/** 서명된 헤더(Authorization 포함)를 돌려준다. 원래 헤더도 포함한다. */
export function signRequest(input: SignInput): Record<string, string> {
  const u = new URL(input.url);
  const date = input.date ?? new Date();
  const xAmzDate = amzDate(date);
  const dateStamp = xAmzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  headers.host = u.host;
  headers['x-amz-date'] = xAmzDate;
  headers['x-amz-content-sha256'] = payloadHash;
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken;

  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((k) => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = signedNames.join(';');
  const canonicalPath = u.pathname.split('/').map((seg) => encodeRfc3986(decodeURIComponent(seg))).join('/') || '/';
  const canonicalQuery = [...u.searchParams.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [input.method.toUpperCase(), canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', xAmzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(input.credentials.secretAccessKey, dateStamp, input.region, input.service)).update(stringToSign, 'utf8').digest('hex');

  const out: Record<string, string> = { ...headers };
  delete out.host; // fetch 가 채운다(같은 값)
  out.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}
