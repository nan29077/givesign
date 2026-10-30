import { cookies } from 'next/headers';
import { ATTRIBUTION_COOKIE, decodeAttribution, type Attribution } from '@/lib/attribution';

/** 요청 쿠키에서 유입 경로를 읽는다. 없거나 형식이 틀리면 null. */
export async function currentAttribution(): Promise<Attribution | null> {
  try {
    const jar = await cookies();
    return decodeAttribution(jar.get(ATTRIBUTION_COOKIE)?.value);
  } catch {
    return null;
  }
}
