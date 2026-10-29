'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';

/**
 * body 바로 아래로 옮겨 그리는 포털.
 *
 * 왜 필요한가
 *  - 콘솔 레이아웃의 본문(`main.console-content`)은 `position:relative; z-index:1` 이라
 *    그 안에서 아무리 큰 z-index 를 줘도 **그 상자 안에서만** 높아진다.
 *    상단 헤더(z-40)는 형제 스택이라 항상 본문 위에 그려지고, 본문 안의 모달은
 *    z-90 이든 z-95 든 헤더에 가려진다(클릭도 헤더가 가로챈다).
 *  - 전체 화면을 덮어야 하는 요소(확인 알림창 · 확대 보기 · 저장 토스트)는
 *    이 포털을 거쳐 body 밑으로 올려 그린다.
 *
 * 서버 렌더 결과에는 아무것도 넣지 않는다(하이드레이션 불일치 방지).
 * 마운트된 뒤에만 실제로 그린다.
 */
/** 구독할 것이 없다. 서버/클라이언트 스냅샷 차이만으로 마운트 여부를 판단한다. */
const noSubscribe = () => () => {};

export function Portal({ children }: { children: React.ReactNode }) {
  // 서버에서는 false, 클라이언트에서 하이드레이션이 끝나면 true.
  const mounted = React.useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );

  if (!mounted || typeof document === 'undefined') return null;
  return createPortal(children, document.body);
}
