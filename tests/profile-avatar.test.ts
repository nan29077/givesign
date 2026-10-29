import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 프로필 이미지.
 * 기브싸인은 50종 개별 캐릭터 대신 기관 마스코트 한 장을 기본 프로필로 쓴다.
 * 화면이 참조하는 파일이 실제로 있는지만 확인한다.
 */
describe('기본 프로필 이미지', () => {
  it('기본 마스코트 이미지가 존재한다', () => {
    expect(existsSync(join(process.cwd(), 'public', 'assets', 'givesign', 'mascot.png'))).toBe(true);
  });
});
