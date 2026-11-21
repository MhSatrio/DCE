import { describe, expect, it } from 'vitest';
import { cleanTrace, hardenAlpha, traceToSvg } from '../../src/assets/tools';
import { colorsOf, parseSvg } from '../../src/assets/svgdoc';

const W = 120, H = 90;

/** A dark silhouette (body and head) on a transparent background. */
function silhouette(): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const body = (x - 60) ** 2 / 900 + (y - 50) ** 2 / 400 < 1;
    const head = (x - 60) ** 2 + (y - 22) ** 2 < 150;
    if (body || head) { data[i] = 70; data[i + 1] = 70; data[i + 2] = 85; data[i + 3] = 255; }
  }
  return { width: W, height: H, data };
}

/** Dark ink ring on white paper. */
function lineDrawing(): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const d = Math.hypot(x - 60, y - 45);
    const ink = d > 30 && d < 34;
    data[i] = data[i + 1] = data[i + 2] = ink ? 20 : 255;
    data[i + 3] = 255;
  }
  return { width: W, height: H, data };
}

describe('cleaning the tracer output', () => {
  it('a silhouette on a transparent background traces to one visible shape with no invisible layer and no stroke', () => {
    const svg = traceToSvg(silhouette(), 'medium', 'areas');
    expect(svg).not.toMatch(/opacity="0/);
    expect(svg).not.toMatch(/stroke/);
    const doc = parseSvg(svg);
    expect(doc.paths.length).toBe(1);
    expect(colorsOf(doc)[0].color).toBe('#464655');
  });

  it('line art keeps only the ink as outline shapes (the white paper is removed)', () => {
    const svg = traceToSvg(lineDrawing(), 'medium', 'line');
    const doc = parseSvg(svg);
    expect(doc.paths.length).toBeGreaterThan(0);
    expect(doc.paths.every((p) => /rgb\((\d+),/.test(p.attrs.fill ?? '') === false || Number(/rgb\((\d+)/.exec(p.attrs.fill ?? '')![1]) < 100)).toBe(true);
    expect(svg).not.toMatch(/stroke/);
  });

  it('removes a path whose opacity is zero, and strips strokes from the others', () => {
    const raw = '<svg viewBox="0 0 10 10"><path fill="rgb(0,0,0)" stroke="rgb(0,0,0)" stroke-width="1" opacity="0" d="M0 0 L5 0 L5 5 Z" /><path fill="rgb(200,30,30)" stroke="rgb(200,30,30)" stroke-width="1" opacity="1" d="M1 1 L4 1 L4 4 Z" /></svg>';
    const clean = cleanTrace(raw, 'areas');
    expect(clean).not.toMatch(/opacity="0"/);
    expect(clean).not.toMatch(/stroke/);
    expect(clean).toContain('rgb(200,30,30)');
  });

  it('a half-transparent rim is made hard (transparent below 50 %, opaque above), so it adds no grey layer', () => {
    const img = { width: 2, height: 1, data: new Uint8ClampedArray([10, 10, 10, 100, 10, 10, 10, 200]) };
    const h = hardenAlpha(img);
    expect(h.data[3]).toBe(0);
    expect(h.data[7]).toBe(255);
  });
});
