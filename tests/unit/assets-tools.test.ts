import { describe, expect, it } from 'vitest';
import { cutoutPixels, traceToSvg } from '../../src/assets/tools';

/** A white canvas with a solid red square in the middle, and optionally a white hole inside the square. */
function scene(w: number, h: number, hole: boolean): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const inSquare = x >= 3 && x < w - 3 && y >= 3 && y < h - 3;
    const inHole = hole && x >= 6 && x < w - 6 && y >= 6 && y < h - 6;
    const white = !inSquare || inHole;
    px[i] = white ? 255 : 200; px[i + 1] = white ? 255 : 20; px[i + 2] = white ? 255 : 20; px[i + 3] = 255;
  }
  return px;
}
const alphaAt = (px: Uint8ClampedArray, w: number, x: number, y: number) => px[(y * w + x) * 4 + 3];

describe('background removal (cutoutPixels)', () => {
  it('makes the background that touches the border transparent and keeps the subject opaque', () => {
    const w = 20, h = 20;
    const out = cutoutPixels(scene(w, h, false), w, h, 40);
    expect(alphaAt(out, w, 0, 0)).toBe(0);            // corner: background
    expect(alphaAt(out, w, 1, 10)).toBe(0);           // along the edge
    expect(alphaAt(out, w, 10, 10)).toBe(255);        // the red square
  });

  it('keeps an enclosed area of the background colour (a hole is not connected to the border)', () => {
    const w = 20, h = 20;
    const out = cutoutPixels(scene(w, h, true), w, h, 40);
    expect(alphaAt(out, w, 0, 0)).toBe(0);
    expect(alphaAt(out, w, 10, 10)).toBe(255);        // the white hole inside the square stays
  });

  it('a larger tolerance removes more: a colour that is close to the background goes too', () => {
    const w = 20, h = 20;
    const px = scene(w, h, false);
    for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) { const i = (y * w + x) * 4; px[i] = px[i + 1] = px[i + 2] = 235; }   // light grey: 20 away from white
    const tight = cutoutPixels(px, w, h, 10);
    const loose = cutoutPixels(px, w, h, 90);
    expect(alphaAt(tight, w, 10, 10)).toBe(255);
    expect(alphaAt(loose, w, 10, 10)).toBeLessThan(255);
  });

  it('an empty image comes back empty', () => {
    expect(cutoutPixels(new Uint8ClampedArray(0), 0, 0, 40).length).toBe(0);
  });
});

describe('image to SVG (traceToSvg)', () => {
  it('traces a flat graphic into SVG code with its colour, and the code is plain text', () => {
    const w = 24, h = 24;
    const svg = traceToSvg({ width: w, height: h, data: scene(w, h, false) }, 'medium');
    expect(svg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
    expect(svg).toContain('<path');
    expect(svg).toMatch(/fill="rgb\(20[0-9],\d+,\d+\)"|fill="#c[0-9a-f]/i);   // a reddish fill from the square
  });

  it('a higher detail setting keeps more colours than a low one', () => {
    const w = 24, h = 24;
    const low = traceToSvg({ width: w, height: h, data: scene(w, h, true) }, 'low');
    const high = traceToSvg({ width: w, height: h, data: scene(w, h, true) }, 'high');
    expect(high.length).toBeGreaterThanOrEqual(low.length);
  });
});
