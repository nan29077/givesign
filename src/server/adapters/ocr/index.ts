import type { AdapterInfo } from '../types';

/**
 * OCR(글자 읽기) 어댑터 — 4차 I(서류로 기본 정보 채우기)·J(스캔본 서식 자동 인식) 공용.
 *
 *  - recognize(buffer, mime) → { lines: [{ text, box: { page, x, y, w, h }, confidence }] }
 *  - box 는 쪽 왼쪽 위 기준 비율(0~1)이다(쪽 크기·해상도와 무관). page 는 1부터.
 *  - confidence 0~1. 낮은 줄은 화면이 노란색으로 표시하고 자동 확정하지 않는다.
 *  - mock 은 외부를 부르지 않고 빈 결과 + mock 표시를 돌려준다(읽은 척하지 않는다).
 *
 * 실연동 공급자는 이 파일에 붙인다(4차 I). 어댑터는 DB 를 만지지 않는다.
 */

export interface OcrLine {
  text: string;
  box: { page: number; x: number; y: number; w: number; h: number };
  confidence: number;
}

export interface OcrResult {
  lines: OcrLine[];
  /** mock 공급자 결과(글자를 읽지 않았다) */
  mock?: boolean;
}

export interface OcrAdapter {
  info(): AdapterInfo;
  recognize(buffer: Uint8Array, mime: string): Promise<OcrResult>;
}

export const mockOcrAdapter: OcrAdapter = {
  info() {
    return { provider: 'mock', mode: 'mock', missingCredentials: [] };
  },
  async recognize() {
    return { lines: [], mock: true };
  },
};

export function getOcrAdapter(): OcrAdapter {
  return mockOcrAdapter;
}
