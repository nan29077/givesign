/**
 * 문자 앱 열기 링크(sms:) — 2026-11-12 4차 K1.
 *
 * 본문 채우기 구분자가 기기마다 다르다:
 *  - iOS     : sms:번호&body=본문
 *  - Android : sms:번호?body=본문
 * 그 밖(PC 등)은 안드로이드 형식을 쓰되 화면이 "휴대폰에서 열어 주세요" 와 후원페이지 버튼을 함께 보인다.
 */
export type SmsPlatform = 'ios' | 'android' | 'other';

export function smsPlatform(userAgent: string | null | undefined): SmsPlatform {
  const ua = userAgent ?? '';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

export function smsHref(number: string, body: string, platform: SmsPlatform): string {
  const to = (number ?? '').replace(/[^\d+]/g, '');
  const enc = encodeURIComponent(body ?? '');
  return platform === 'ios' ? `sms:${to}&body=${enc}` : `sms:${to}?body=${enc}`;
}
