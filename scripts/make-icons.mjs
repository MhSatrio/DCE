/**
 * Renders the real VierApparatus icon.svg to PNGs (Chromium) and packs build/icon.ico (PNG-compressed entries) and
 * build/icon.png (512 px, used by the window and Linux). Run once: node scripts/make-icons.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromiumPath } from '../tests/e2e/lib.mjs';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(root + 'build', { recursive: true });
const svg = readFileSync(root + 'public/icon.svg', 'utf8');
const browser = await chromium.launch({ executablePath: chromiumPath() });
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function png(size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = [];
for (const s of sizes) pngs.push([s, await png(s)]);
writeFileSync(root + 'build/icon.png', await png(512));
await browser.close();

// ICO container: header + directory + PNG images
const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
let offset = 6 + 16 * pngs.length;
const dir = [], data = [];
for (const [s, buf] of pngs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(s >= 256 ? 0 : s, 0); e.writeUInt8(s >= 256 ? 0 : s, 1); e.writeUInt8(0, 2); e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(buf.length, 8); e.writeUInt32LE(offset, 12);
  dir.push(e); data.push(buf); offset += buf.length;
}
writeFileSync(root + 'build/icon.ico', Buffer.concat([head, ...dir, ...data]));
console.log('icons written:', sizes.join(', '), '+ 512 png');
