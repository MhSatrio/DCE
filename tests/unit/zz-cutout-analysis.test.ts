import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync, crc32 } from 'node:zlib';
import { describe, it } from 'vitest';
import { cutoutPixels } from '../../src/assets/cutout';
import { cutoutPixels as oldCutout } from '../../src/assets/tools';

const DIR = 'C:/Users/satri/AppData/Local/Temp/claude/7f6d85dfeffc2f4c/9fb51c84-1d27-4f4b-96c7-f245d2e11b3a/scratchpad/cutout';

/** PNG (8-bit RGB or RGBA, no interlace) → RGBA. */
function decodePng(buf: Buffer): { w: number; h: number; data: Uint8ClampedArray } {
  let p = 8, w = 0, h = 0, ct = 6;
  const idat: Buffer[] = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); ct = body[9]; }
    if (type === 'IDAT') idat.push(body);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp;
  const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const rawv = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v: number;
      if (f === 0) v = rawv;
      else if (f === 1) v = rawv + a;
      else if (f === 2) v = rawv + b;
      else if (f === 3) v = rawv + ((a + b) >> 1);
      else { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v = rawv + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[y * stride + x] = v & 255;
    }
  }
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = out[i * bpp]; rgba[i * 4 + 1] = out[i * bpp + 1]; rgba[i * 4 + 2] = out[i * bpp + 2];
    rgba[i * 4 + 3] = bpp === 4 ? out[i * bpp + 3] : 255;
  }
  return { w, h, data: rgba };
}

/** RGBA → PNG, composited over magenta so removed background is obvious. */
function encodeCompositePng(w: number, h: number, rgba: Uint8ClampedArray): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, al = rgba[i + 3] / 255;
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(rgba[i] * al + 255 * (1 - al));
      raw[o + 1] = Math.round(rgba[i + 1] * al + 0 * (1 - al));
      raw[o + 2] = Math.round(rgba[i + 2] * al + 255 * (1 - al));
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe('analysis (scratch)', () => {
  it('runs the old and the new cut-out on the product photos', () => {
    for (const f of readdirSync(DIR).filter((n) => /^src\d+\.png$/.test(n)).sort()) {
      const img = decodePng(readFileSync(`${DIR}/${f}`));
      const t0 = Date.now();
      const neu = cutoutPixels(img.data, img.w, img.h, 40, false);
      const ms = Date.now() - t0;
      const enc = cutoutPixels(img.data, img.w, img.h, 40, true);
      const old = oldCutout(img.data, img.w, img.h, 40);
      const frac = (a: Uint8ClampedArray) => { let z = 0; for (let i = 3; i < a.length; i += 4) if (a[i] < 128) z++; return (z / (a.length / 4)).toFixed(3); };
      console.log(`${f} ${img.w}x${img.h} new-removed=${frac(neu)} enclosed-removed=${frac(enc)} old-removed=${frac(old)} ms=${ms}`);
      const base = f.replace('.png', '');
      writeFileSync(`${DIR}/${base}-new.png`, encodeCompositePng(img.w, img.h, neu));
      writeFileSync(`${DIR}/${base}-enc.png`, encodeCompositePng(img.w, img.h, enc));
      writeFileSync(`${DIR}/${base}-old.png`, encodeCompositePng(img.w, img.h, old));
    }
  }, 300000);
});
