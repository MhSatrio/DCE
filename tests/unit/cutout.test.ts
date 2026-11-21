import { describe, expect, it } from 'vitest';
import { backdropColours, blur3, cutoutPixels, radiusFor, toLab } from '../../src/assets/cutout';

const W = 60, H = 60;
const idx = (x: number, y: number) => (y * W + x) * 4;
/** Fills a canvas with `bg(x, y)` and paints `fg` over the rectangle [x0,x1)×[y0,y1). */
function canvas(bg: (x: number, y: number) => [number, number, number], fg?: { x0: number; x1: number; y0: number; y1: number; rgb: [number, number, number] }, noise = 0): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = idx(x, y);
    let c = bg(x, y);
    if (fg && x >= fg.x0 && x < fg.x1 && y >= fg.y0 && y < fg.y1) c = fg.rgb;
    for (let k = 0; k < 3; k++) px[i + k] = Math.max(0, Math.min(255, Math.round(c[k] + (noise ? rnd() * noise : 0))));
    px[i + 3] = 255;
  }
  return px;
}
const alpha = (px: Uint8ClampedArray, x: number, y: number) => px[idx(x, y) + 3];
const white = () => [255, 255, 255] as [number, number, number];

describe('colour model', () => {
  it('converts sRGB to CIE L*a*b*: white is L 100 with no colour, red is about L 53, a 80, b 67', () => {
    const px = new Uint8ClampedArray([255, 255, 255, 255, 255, 0, 0, 255]);
    const lab = toLab(px, 2);
    expect(lab.L[0]).toBeCloseTo(100, 0);
    expect(Math.abs(lab.a[0])).toBeLessThan(0.5);
    expect(Math.abs(lab.b[0])).toBeLessThan(0.5);
    expect(lab.L[1]).toBeCloseTo(53.2, 0);
    expect(lab.a[1]).toBeCloseTo(80, 0);
    expect(lab.b[1]).toBeCloseTo(67, 0);
  });

  it('learns each backdrop colour from the border, and keeps a colour that covers at least 4 % of it', () => {
    const samples: [number, number, number][] = [];
    for (let i = 0; i < 300; i++) samples.push([95 + (i % 3) * 0.2, 0, 0]);       // white-ish backdrop
    for (let i = 0; i < 300; i++) samples.push([60, 0, -40]);                         // blue backdrop
    const cols = backdropColours(samples, radiusFor(40));
    expect(cols.length).toBe(2);
    const near = (c: [number, number, number], target: number) => Math.abs(c[0] - target) < 2;
    expect(cols.some((c) => near(c.centre, 95))).toBe(true);
    expect(cols.some((c) => near(c.centre, 60))).toBe(true);
  });

  it('smooths a plane over 3×3 (the edges average the pixels that exist)', () => {
    const P = new Float32Array([0, 0, 0, 0, 9, 0, 0, 0, 0]);
    const s = blur3(P, 3, 3);
    expect(s[4]).toBeCloseTo(1, 5);      // centre: (9 / 9)
    expect(s[0]).toBeCloseTo(9 / 4, 5);  // corner: 9 over the four pixels it sees
  });
});

describe('removing the background', () => {
  it('removes a white backdrop and keeps a grey object of the same brightness family (a platter)', () => {
    // a light grey platter with a dark rim: the rim stops the fill, the platter inside stays
    const px = canvas(white, { x0: 18, x1: 42, y0: 18, y1: 42, rgb: [200, 200, 200] });
    for (let y = 18; y < 42; y++) for (let x = 18; x < 42; x++) if (x === 18 || x === 41 || y === 18 || y === 41) { const i = idx(x, y); px[i] = px[i + 1] = px[i + 2] = 60; }
    const out = cutoutPixels(px, W, H, 40);
    expect(alpha(out, 1, 1)).toBe(0);            // the white backdrop
    expect(alpha(out, 30, 30)).toBe(255);        // the platter
  });

  it('follows a gently changing (gradient) backdrop, which a single colour cannot describe', () => {
    const grad = (x: number) => [255 - x * 1.2, 255 - x * 0.6, 255] as [number, number, number];   // white → light blue across the image
    const px = canvas(grad, { x0: 22, x1: 38, y0: 22, y1: 38, rgb: [200, 30, 30] });
    const out = cutoutPixels(px, W, H, 40);
    expect(alpha(out, 2, 30)).toBe(0);           // the gradient, left side
    expect(alpha(out, 57, 30)).toBe(0);          // the gradient, right side
    expect(alpha(out, 30, 30)).toBe(255);        // the red object
  });

  it('is not thrown off by noise in the backdrop (the mask is smoothed)', () => {
    const px = canvas(white, { x0: 20, x1: 40, y0: 20, y1: 40, rgb: [200, 30, 30] }, 6);
    const out = cutoutPixels(px, W, H, 40);
    let removed = 0, total = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (x >= 20 && x < 40 && y >= 20 && y < 40) continue;
      total++; if (alpha(out, x, y) < 128) removed++;
    }
    expect(removed / total).toBeGreaterThan(0.97);
    expect(alpha(out, 30, 30)).toBe(255);
  });

  it('keeps a white area enclosed by the outline, unless `enclosed` (line art) asks for it', () => {
    const px = canvas(white, { x0: 14, x1: 46, y0: 14, y1: 46, rgb: [40, 40, 40] });
    for (let y = 18; y < 42; y++) for (let x = 18; x < 42; x++) { const i = idx(x, y); px[i] = px[i + 1] = px[i + 2] = 255; }   // white inside the outline
    const photo = cutoutPixels(px, W, H, 40, false);
    expect(alpha(photo, 1, 1)).toBe(0);
    expect(alpha(photo, 30, 30)).toBe(255);
    const line = cutoutPixels(px, W, H, 40, true);
    expect(alpha(line, 30, 30)).toBe(0);          // the white inside is removed for a line drawing
    expect(alpha(line, 14, 30)).toBe(255);        // the outline stays
  });

  it('a larger tolerance removes more: a light grey that is far from white goes at 90 and stays at 10', () => {
    const px = canvas(white, { x0: 18, x1: 42, y0: 18, y1: 42, rgb: [225, 225, 225] });
    expect(alpha(cutoutPixels(px, W, H, 10), 30, 30)).toBe(255);
    expect(alpha(cutoutPixels(px, W, H, 90), 30, 30)).toBe(0);
  });
});
