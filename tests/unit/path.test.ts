import { describe, expect, it } from 'vitest';
import { pathD } from '../../src/engine/draw';
import { makeNode } from '../../src/engine/njs';
import { autoHandle, bezierAt, fromWorld, nearestOnPath, removeAnchor, smoothAll, splitSegment, toWorld, type WorldPath } from '../../src/editor/path';

const tri = (): WorldPath => ({ a: [[0, 0], [100, 0], [100, 100]], h: [null, null, null], closed: true });
const node = () => { const n = makeNode('path', { x: 0, y: 0, width: 1, height: 1 }); fromWorld(n, tri()); return n; };

describe('Bézier paths', () => {
  it('world ⇄ node conversion round-trips and refits the box to anchors + handles', () => {
    const n = node();
    expect([n.x, n.y, n.width, n.height]).toEqual([0, 0, 100, 100]);
    const wp = toWorld(n);
    expect(wp.a).toEqual([[0, 0], [100, 0], [100, 100]]);
    wp.h[1] = { inn: [60, -40], out: [140, 40] };         // handles stick out of the anchors' box
    fromWorld(n, wp);
    expect([n.x, n.y, n.width, n.height]).toEqual([0, -40, 140, 140]);
    expect(toWorld(n).h[1]).toEqual({ inn: [60, -40], out: [140, 40] });
    expect(toWorld(n).a[0]).toEqual([0, 0]);
  });

  it('rotation is baked into the points when converting', () => {
    const n = node();
    n.rotation = 90;
    const wp = toWorld(n);
    fromWorld(n, wp);
    expect(n.rotation).toBe(0);
    expect(Math.round(toWorld(n).a[1][0])).toBe(Math.round(wp.a[1][0]));
    expect(Math.round(toWorld(n).a[1][1])).toBe(Math.round(wp.a[1][1]));
  });

  it('emits SVG path data: L for corners, C where a handle exists, Z when closed', () => {
    const n = node();
    expect(pathD({ path: n.path, w: n.width, h: n.height })).toBe('M0 0L100 0L100 100L0 0Z');
    const wp = smoothAll(toWorld(n));
    fromWorld(n, wp);
    const d = pathD({ path: n.path, w: n.width, h: n.height });
    expect(d.startsWith('M')).toBe(true);
    expect((d.match(/C/g) ?? []).length).toBe(3);
    expect(d.endsWith('Z')).toBe(true);
    const open = { path: { points: [[0, 0], [1, 1]] as [number, number][], closed: false }, w: 10, h: 10 };
    expect(pathD(open)).toBe('M0 0L10 10');
    expect(pathD({ path: { points: [[0, 0]], closed: false }, w: 1, h: 1 })).toBe('');
  });

  it('auto handles run through the neighbours; splitting keeps the curve; removal drops an anchor', () => {
    const wp = tri();
    const h = autoHandle(wp, 1);
    expect(h.out[0] - 100).toBeCloseTo(-(h.inn[0] - 100), 6); // symmetric around the anchor
    const curved = smoothAll(wp);
    const [p0, p1, p2, p3] = [curved.a[0], curved.h[0]!.out, curved.h[1]!.inn, curved.a[1]];
    const before = bezierAt(p0, p1, p2, p3, 0.4);
    const { wp: split, index } = splitSegment(curved, 0, 0.4);
    expect(split.a).toHaveLength(4);
    expect(split.a[index][0]).toBeCloseTo(before[0], 6);
    expect(split.a[index][1]).toBeCloseTo(before[1], 6);
    expect(removeAnchor(split, index).a).toHaveLength(3);
    const hit = nearestOnPath(wp, [50, 4]);
    expect(hit?.seg).toBe(0);
    expect(hit!.dist).toBeLessThan(5);
  });
});
