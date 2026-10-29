import 'server-only';
import { headers } from 'next/headers';

function isLocal(value: string | undefined) {
  if (!value) return true;
  try {
    const hostname = new URL(value).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
  } catch {
    return true;
  }
}

/** 운영 URL은 환경값을, 로컬 터널 미리보기는 현재 공개 요청 호스트를 사용한다. */
export async function getPublicBaseUrl() {
  const configured = process.env.NEXT_PUBLIC_SITE_URL || process.env.APP_BASE_URL;
  if (!isLocal(configured)) return configured!.replace(/\/$/, '');

  const h = await headers();
  const host = h.get('x-forwarded-host')?.split(',')[0]?.trim() || h.get('host');
  if (!host) return (configured || 'http://localhost:3060').replace(/\/$/, '');
  const forwardedProto = h.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const protocol = forwardedProto === 'http' || forwardedProto === 'https'
    ? forwardedProto
    : host.includes('localhost') || host.startsWith('127.') ? 'http' : 'https';
  return `${protocol}://${host}`;
}
