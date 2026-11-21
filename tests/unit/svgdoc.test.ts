import { describe, expect, it } from 'vitest';
import {
  boundsOf, colorInput, colorsOf, deleteAnchor, deletePath, insertAnchor, midOf, moveAnchor, moveHandle, parseSvg, parsePathData, replaceColor, serializeSvg, setFill, anchorsOf, viewBoxOf, withViewBox,
} from '../../src/assets/svgdoc';
import { traceToSvg } from '../../src/assets/tools';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">' +
  '<path fill="rgb(255,0,0)" d="M 1 1 L 9 1 L 9 9 Z" />' +
  '<path fill="#00ff00" d="M 2 2 C 2 4 4 6 6 6 Z" />' +
  '</svg>';

/** The point at t of a cubic (for checking that an inserted anchor does not change the curve). */
const bez = (p0: { x: number; y: number }, c1: { x: number; y: number }, c2: { x: number; y: number }, p: { x: number; y: number }, t: number) => {
  const u = 1 - t;
  return { x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p.x, y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p.y };
};

describe('reading and writing paths', () => {
  it('reads the sub-paths, the segments and the closing of a path', () => {
    const doc = parseSvg(SVG);
    expect(doc.paths).toHaveLength(2);
    expect(doc.paths[0].subs[0].start).toEqual({ x: 1, y: 1 });
    expect(doc.paths[0].subs[0].segs.map((s) => s.kind)).toEqual(['L', 'L']);
    expect(doc.paths[0].subs[0].closed).toBe(true);
    expect(doc.paths[1].subs[0].segs[0].kind).toBe('C');
  });

  it('writes the same geometry back: reading the written text gives the same document', () => {
    const doc = parseSvg(SVG);
    const again = parseSvg(serializeSvg(doc));
    expect(again.paths).toEqual(doc.paths);
    expect(serializeSvg(doc)).toContain('viewBox="0 0 10 10"');
  });

  it('keeps the text around the paths and the colours of each path', () => {
    const out = serializeSvg(parseSvg(SVG));
    expect(out.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">')).toBe(true);
    expect(out.endsWith('</svg>')).toBe(true);
    expect(out).toContain('fill="rgb(255,0,0)"');
    expect(out).toContain('fill="#00ff00"');
  });

  it('understands relative commands', () => {
    const subs = parsePathData('M10 10 l5 0 l0 5 c0 1 1 2 2 2 z');
    expect(subs[0].start).toEqual({ x: 10, y: 10 });
    expect(subs[0].segs[0]).toEqual({ kind: 'L', p: { x: 15, y: 10 } });
    expect(subs[0].segs[1]).toEqual({ kind: 'L', p: { x: 15, y: 15 } });
    expect(subs[0].segs[2]).toEqual({ kind: 'C', c1: { x: 15, y: 16 }, c2: { x: 16, y: 17 }, p: { x: 17, y: 17 } });
    expect(subs[0].closed).toBe(true);
  });

  it('keeps a quadratic curve as the same curve, written as a cubic', () => {
    const [sub] = parsePathData('M0 0 Q 5 10 10 0');
    const seg = sub.segs[0];
    expect(seg.kind).toBe('C');
    if (seg.kind !== 'C') return;
    expect(seg.c1.x).toBeCloseTo(10 / 3, 6);
    expect(seg.c1.y).toBeCloseTo(20 / 3, 6);
    expect(seg.c2.x).toBeCloseTo(20 / 3, 6);
    expect(seg.p).toEqual({ x: 10, y: 0 });
  });

  it('reads the real tracer output (what the Trace to SVG tool writes) and writes it back', () => {
    const w = 16, h = 16;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4; const inside = x >= 4 && x < 12 && y >= 4 && y < 12;
      px[i] = inside ? 200 : 255; px[i + 1] = inside ? 30 : 255; px[i + 2] = inside ? 30 : 255; px[i + 3] = 255;
    }
    const svg = traceToSvg({ width: w, height: h, data: px }, 'medium');
    const doc = parseSvg(svg);
    expect(doc.paths.length).toBeGreaterThan(0);
    expect(parseSvg(serializeSvg(doc)).paths).toEqual(doc.paths);
  });

  it('a text without paths has no paths and is kept as it is', () => {
    const doc = parseSvg('<svg><rect width="2" height="2"/></svg>');
    expect(doc.paths).toHaveLength(0);
    expect(serializeSvg(doc)).toBe('<svg><rect width="2" height="2"/></svg>');
  });
});

describe('editing the vectors', () => {
  it('moving an anchor moves its handles with it, and nothing else', () => {
    const doc = parseSvg('<svg><path d="M 0 0 C 0 5 5 5 5 0 C 5 -5 10 -5 10 0" /></svg>');
    const moved = moveAnchor(doc, 0, 0, 1, 2, 3);
    const [a, b] = moved.paths[0].subs[0].segs;
    expect(a.kind === 'C' && a.p).toEqual({ x: 7, y: 3 });
    expect(a.kind === 'C' && a.c2).toEqual({ x: 7, y: 8 });
    expect(b.kind === 'C' && b.c1).toEqual({ x: 7, y: -2 });
    expect(moved.paths[0].subs[0].start).toEqual({ x: 0, y: 0 });
    expect(doc.paths[0].subs[0].segs[0]).not.toEqual(a);          // the original is not changed
  });

  it('moving a handle moves only that handle', () => {
    const doc = parseSvg('<svg><path d="M 0 0 C 0 5 5 5 5 0" /></svg>');
    const moved = moveHandle(doc, 0, 0, 0, 'c1', 1, 1);
    const seg = moved.paths[0].subs[0].segs[0];
    expect(seg.kind === 'C' && seg.c1).toEqual({ x: 1, y: 6 });
    expect(seg.kind === 'C' && seg.c2).toEqual({ x: 5, y: 5 });
    expect(seg.kind === 'C' && seg.p).toEqual({ x: 5, y: 0 });
  });

  it('inserting an anchor on a curve keeps the curve where it was', () => {
    const doc = parseSvg('<svg><path d="M 0 0 C 0 10 10 10 10 0" /></svg>');
    const before = doc.paths[0].subs[0].segs[0];
    if (before.kind !== 'C') throw new Error('expected a curve');
    const orig = bez({ x: 0, y: 0 }, before.c1, before.c2, before.p, 0.5);
    const after = insertAnchor(doc, 0, 0, 0, 0.5).paths[0].subs[0];
    expect(after.segs).toHaveLength(2);
    const mid = after.segs[0];
    if (mid.kind !== 'C') throw new Error('expected a curve');
    expect(mid.p.x).toBeCloseTo(orig.x, 6);
    expect(mid.p.y).toBeCloseTo(orig.y, 6);
    // the two halves still end at the old end point
    expect(after.segs[1].p).toEqual({ x: 10, y: 0 });
  });

  it('inserting an anchor on a straight line puts it at the middle', () => {
    const doc = parseSvg('<svg><path d="M 0 0 L 10 0" /></svg>');
    const after = insertAnchor(doc, 0, 0, 0).paths[0].subs[0];
    expect(anchorsOf(after)).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }]);
  });

  it('deleting an anchor removes the segment that arrives at it', () => {
    const doc = parseSvg('<svg><path d="M 0 0 L 5 0 L 10 0 L 10 5" /></svg>');
    const after = deleteAnchor(doc, 0, 0, 2);
    expect(anchorsOf(after.paths[0].subs[0])).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 5 }]);
  });

  it('deleting a path removes it and keeps the rest of the text', () => {
    const doc = parseSvg(SVG);
    const after = deletePath(doc, 0);
    expect(after.paths).toHaveLength(1);
    const text = serializeSvg(after);
    expect(text).not.toContain('rgb(255,0,0)');
    expect(text).toContain('#00ff00');
    expect(text.startsWith('<svg xmlns=')).toBe(true);
    expect(text.endsWith('</svg>')).toBe(true);
  });

  it('colours: the palette counts the fills; a recolour changes every path of that colour; a single path can be set', () => {
    const doc = parseSvg('<svg><path fill="rgb(255,0,0)" d="M0 0 L1 0 L1 1 Z"/><path fill="#ff0000" d="M2 2 L3 2 L3 3 Z"/><path fill="#00ff00" d="M4 4 L5 4 L5 5 Z"/></svg>');
    expect(colorsOf(doc)).toEqual([{ color: '#ff0000', count: 2 }, { color: '#00ff00', count: 1 }]);
    const recolored = replaceColor(doc, '#ff0000', '#0000ff');
    expect(colorsOf(recolored)).toEqual([{ color: '#0000ff', count: 2 }, { color: '#00ff00', count: 1 }]);
    const one = setFill(doc, 2, '#123456');
    expect(one.paths[2].attrs.fill).toBe('#123456');
    expect(doc.paths[2].attrs.fill).toBe('#00ff00');
  });
});

describe('helpers for the editor', () => {
  it('reads the box from the viewBox, else from width and height, else not at all', () => {
    expect(viewBoxOf('<svg viewBox="0 0 24 12"><path d="M0 0"/></svg>')).toEqual({ x: 0, y: 0, w: 24, h: 12 });
    expect(viewBoxOf('<svg width="30px" height="20"><path d="M0 0"/></svg>')).toEqual({ x: 0, y: 0, w: 30, h: 20 });
    expect(viewBoxOf('<svg><rect width="2" height="2"/></svg>')).toBeNull();
  });

  it('the box around the drawing covers every anchor and handle', () => {
    const doc = parseSvg('<svg><path d="M 2 3 C 10 -4 6 8 12 5 L 0 9" /></svg>');
    expect(boundsOf(doc)).toEqual({ x: 0, y: -4, w: 12, h: 13 });
    expect(boundsOf(parseSvg('<svg></svg>'))).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });

  it('an SVG without a size gets a viewBox around its drawing; one with a size is left as it is', () => {
    const bare = parseSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M 2 3 L 10 7" /></svg>');
    const fixed = withViewBox(bare);
    expect(viewBoxOf(serializeSvg(fixed))).toEqual({ x: 2, y: 3, w: 8, h: 4 });
    expect(withViewBox(fixed)).toBe(fixed);
    const sized = parseSvg('<svg width="5" height="5"><path d="M 0 0 L 1 1" /></svg>');
    expect(withViewBox(sized)).toBe(sized);
  });

  it('the middle of a segment is where the curve is at half way (the same point as inserting an anchor)', () => {
    const doc = parseSvg('<svg><path d="M 0 0 L 10 0 C 10 10 20 10 20 0" /></svg>');
    const sub = doc.paths[0].subs[0];
    expect(midOf(sub, 0)).toEqual({ x: 5, y: 0 });
    const m = midOf(sub, 1);
    const seg = insertAnchor(doc, 0, 0, 1).paths[0].subs[0].segs[1];
    if (seg.kind !== 'C') throw new Error('expected a curve');
    expect(m.x).toBeCloseTo(seg.p.x, 9);
    expect(m.y).toBeCloseTo(seg.p.y, 9);
  });

  it('a colour becomes #rrggbb for the colour input; a colour it cannot read becomes black', () => {
    expect(colorInput('rgb(255, 0, 16)')).toBe('#ff0010');
    expect(colorInput('#ABC')).toBe('#aabbcc');
    expect(colorInput('#00FF00')).toBe('#00ff00');
    expect(colorInput('currentColor')).toBe('#000000');
  });
});
