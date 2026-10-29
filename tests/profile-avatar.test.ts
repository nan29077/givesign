import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { avatarIndexFromSeed, normalizeAvatarIndex } from '@/components/profile/generated-avatar';

describe('개별 프로필 캐릭터', () => {
  it('0~49의 저장된 배정값을 그대로 유지한다', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(normalizeAvatarIndex(index, '다른-시드')).toBe(index);
    }
  });

  it('잘못된 배정값은 계정 시드 기반의 안정적인 값으로 복구한다', () => {
    const expected = avatarIndexFromSeed('user-123');
    expect(normalizeAvatarIndex(null, 'user-123')).toBe(expected);
    expect(normalizeAvatarIndex(-1, 'user-123')).toBe(expected);
    expect(normalizeAvatarIndex(50, 'user-123')).toBe(expected);
  });

  it('50개 PNG가 합본이 아닌 서로 다른 개별 파일로 존재한다', () => {
    const hashes = new Set<string>();
    for (let number = 1; number <= 50; number += 1) {
      const filename = `avatar-${String(number).padStart(2, '0')}.png`;
      const image = readFileSync(join(process.cwd(), 'public', 'avatars', 'givesign-v2', filename));
      expect(image.subarray(1, 4).toString('ascii')).toBe('PNG');
      hashes.add(createHash('sha256').update(image).digest('hex'));
    }
    expect(hashes.size).toBe(50);
  });
});
