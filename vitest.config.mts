import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // DB 를 공유하므로 파일 간 병렬 실행을 막는다.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(root, 'src'),
    },
  },
});
