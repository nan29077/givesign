/** 이전 결제 서비스 전용 콘텐츠가 공개 화면에 섞이지 않게 한다. */
export function isLegacyDonationContent(content: { title: string; body: string }): boolean { return /게임 캐시|포인트 충전/.test(content.title + '\n' + content.body); }
