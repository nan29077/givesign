import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const source = await readFile(new URL('../public/givesign-mark-v5.svg', import.meta.url));

async function transparentMark(size) {
  return sharp(source).resize(size, size, { fit: 'contain' }).png().toBuffer();
}

const icon512 = await transparentMark(512);
await writeFile(new URL('../public/givesign-icon-v5.png', import.meta.url), icon512);


const appleMark = await sharp(source).resize(372, 372, { fit: 'contain' }).png().toBuffer();
const appleIcon = await sharp({
  create: { width: 512, height: 512, channels: 4, background: '#fff8e7' },
})
  .composite([{ input: appleMark, gravity: 'center' }])
  .png()
  .toBuffer();
await writeFile(new URL('../public/apple-touch-icon-v5.png', import.meta.url), appleIcon);

const sizes = [16, 32, 48, 64];
const images = await Promise.all(sizes.map((size) => transparentMark(size)));
const headerSize = 6 + sizes.length * 16;
let offset = headerSize;
const header = Buffer.alloc(headerSize);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);

sizes.forEach((size, index) => {
  const entry = 6 + index * 16;
  header.writeUInt8(size === 256 ? 0 : size, entry);
  header.writeUInt8(size === 256 ? 0 : size, entry + 1);
  header.writeUInt8(0, entry + 2);
  header.writeUInt8(0, entry + 3);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[index].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
});

await writeFile(new URL('../public/favicon.ico', import.meta.url), Buffer.concat([header, ...images]));
