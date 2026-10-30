/**
 * PGlite 소켓 서버만 단독으로 띄운다 (테스트·CI·헤드리스 검증용).
 *
 * `npm run preview` 는 DB + Next 앱을 함께 띄우지만, 테스트는 DB 만 필요하다.
 * 사용: node tools/pglite-server.mjs [--memory]
 *   - 기본은 .givesign-pglite-test 디렉터리에 저장, --memory 면 메모리에만 둔다.
 *   - 포트는 PGLITE_PORT(기본 5463).
 */
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.env.PGLITE_PORT ?? 5463);
const memory = process.argv.includes('--memory');
const dataDir = memory ? undefined : path.resolve(process.cwd(), process.env.PGLITE_DATA_DIR ?? '.givesign-pglite-test');

const db = memory ? new PGlite() : new PGlite(dataDir);
await db.waitReady;
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 100 });
await server.start();
console.log(`[pglite] listening on 127.0.0.1:${port} (${memory ? 'memory' : dataDir})`);

const stop = async () => {
  await server.stop().catch(() => {});
  await db.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
