/**
 * Mock PIN 입력 화면 주소 생성기.
 *
 * 결제 어댑터(index.ts / hecto.ts)가 모두 참조하므로 별도 모듈로 둔다.
 * (hecto.ts 가 index.ts 에서 런타임 값을 가져오면 순환 참조가 생긴다)
 *
 * 실제 연동 시에는 결제사가 내려주는 인증창 URL 이 이 자리를 대신하고,
 * `/mock/pg/pin` 화면은 제거된다.
 */
export const MOCK_PIN_PATH = '/mock/pg/pin';

export function mockPinUrl(sessionId: string): string {
  return `${MOCK_PIN_PATH}?session=${encodeURIComponent(sessionId)}`;
}
