import { describe, expect, it } from 'vitest';
import * as M from '../../src/editor/model';
import { makeNode, newDoc } from '../../src/engine/njs';

const box = (name: string, x: number, y: number, w = 100, h = 50, extra = {}) => makeNode('rect', { name, x, y, width: w, height: h, ...extra });
const mk = () => {
  const d = newDoc('t', 1000, 800);
  d.nodes = [box('a', 0, 0), box('b', 200, 100), box('c', 400, 300), box('d', 700, 600)];
  M.renumber(d.nodes);
  return d;
};
const id = (d: ReturnType<typeof mk>, name: string) => d.nodes.find((n) => n.name === name)!.id;

describe('document model operations', () => {
  it('groups and ungroups while keeping z-order and a correct bounding box', () => {
    const d = mk();
    const g = M.groupSelection(d, [id(d, 'b'), id(d, 'c')])!;
    expect(g).toBeTruthy();
    expect(d.nodes.map((n) => n.name)).toEqual(['a', 'Group', 'd']);
    const grp = d.nodes[1];
    expect(grp.children!.map((c) => c.name)).toEqual(['b', 'c']);
    expect([grp.x, grp.y, grp.width, grp.height]).toEqual([200, 100, 300, 250]);
    expect(M.topGroupOf(d, id({ nodes: grp.children } as never, 'b'))?.id).toBe(grp.id);
    const kids = M.ungroup(d, grp.id);
    expect(kids).toHaveLength(2);
    expect(d.nodes.map((n) => n.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a selected group is treated as one unit; a group cannot be grouped away empty', () => {
    const d = mk();
    M.groupSelection(d, [id(d, 'a'), id(d, 'b')]);
    const g = d.nodes.find((n) => n.type === 'group')!;
    expect(M.topLevelSelection(d, M.leafIdsOf(g)).map((n) => n.id)).toEqual([g.id]);
    expect(M.groupSelection(d, [id(d, 'c')])).toBeNull();
    M.removeNodes(d, [g.id]);
    expect(d.nodes.map((n) => n.name)).toEqual(['c', 'd']);
  });

  it('reorders: front / back / forward / backward', () => {
    const d = mk();
    M.reorder(d, [id(d, 'a')], 'front');
    expect(d.nodes.map((n) => n.name)).toEqual(['b', 'c', 'd', 'a']);
    M.reorder(d, [id(d, 'a')], 'backward');
    expect(d.nodes.map((n) => n.name)).toEqual(['b', 'c', 'a', 'd']);
    M.reorder(d, [id(d, 'd')], 'back');
    expect(d.nodes.map((n) => n.name)).toEqual(['d', 'b', 'c', 'a']);
    M.reorder(d, [id(d, 'd')], 'forward');
    expect(d.nodes.map((n) => n.name)).toEqual(['b', 'd', 'c', 'a']);
    expect(d.nodes.map((n) => n.layer)).toEqual([0, 1, 2, 3]);
  });

  it('moveRelative (layer drag & drop) refuses to drop a group into itself', () => {
    const d = mk();
    M.groupSelection(d, [id(d, 'b'), id(d, 'c')]);
    const g = d.nodes.find((n) => n.type === 'group')!;
    expect(M.moveRelative(d, g.id, g.children![0].id, 'above')).toBe(false);
    expect(M.moveRelative(d, id(d, 'a'), id(d, 'd'), 'above')).toBe(true);
    expect(d.nodes.map((n) => n.name)).toEqual(['Group', 'd', 'a']);
  });

  it('aligns to the canvas / selection and distributes evenly', () => {
    const d = mk();
    M.alignNodes(d, [id(d, 'b')], 'center', 'canvas');
    expect(d.nodes[1].x).toBe(450);
    M.alignNodes(d, [id(d, 'a'), id(d, 'c')], 'right', 'selection');
    expect(d.nodes[0].x + d.nodes[0].width).toBe(500);
    expect(d.nodes[2].x + d.nodes[2].width).toBe(500);
    const e = mk();
    M.distributeNodes(e, [id(e, 'a'), id(e, 'b'), id(e, 'd')], 'h');
    const xs = ['a', 'b', 'd'].map((n) => e.nodes.find((x) => x.name === n)!.x);
    expect(xs[1] - (xs[0] + 100)).toBeCloseTo(xs[2] - (xs[1] + 100), 5);
  });

  it('rotated bounding boxes are axis-aligned and duplicates get fresh ids', () => {
    const b = M.rotatedBox({ x: 0, y: 0, width: 100, height: 100, rotation: 45 } as never);
    expect(b.w).toBeCloseTo(141.42, 1);
    const d = mk();
    const created = M.duplicateNodes(d, [id(d, 'a')], 10);
    expect(created).toHaveLength(1);
    expect(d.nodes).toHaveLength(5);
    expect(new Set(d.nodes.map((n) => n.id)).size).toBe(5);
    expect(d.nodes[1].x).toBe(10);
  });
});
