import { readFile } from 'node:fs/promises';
import path from 'node:path';
export const size = { width: 512, height: 512 };
export const contentType = 'image/png';
export default async function Icon() {
  return new Response(new Uint8Array(await readFile(path.join(process.cwd(), 'public/givesign-icon-v7.png'))), { headers: { 'Content-Type': contentType } });
}
