import { describe, it, expect } from 'vitest';
import { decodeNodes, encodeNodes, MAX_PASTED_NODES } from '../../src/editor/clipboardNodes';
import { makeNode } from '../../src/engine/njs';

describe('design objects on the system clipboard', () => {
  it('round-trips real objects through text', () => {
    const rect = makeNode('rect', { name: 'Card', x: 10, y: 20, w: 300, h: 120 });
    const text = makeNode('text', { name: 'Title', x: 30, y: 40 });
    const back = decodeNodes(encodeNodes([rect, text]));
    expect(back).not.toBeNull();
    expect(back!.map((n) => n.type)).toEqual(['rect', 'text']);
    expect(back![0]).toMatchObject({ name: 'Card', x: 10, y: 20, w: 300, h: 120 });
    expect(back![0].id).toBe(rect.id);                         // ids are made new when pasted (cloneWithNewIds), not here
  });

  it('ignores anything that is not a DCE payload: plain text, other JSON, a newer version, broken JSON', () => {
    expect(decodeNodes('')).toBeNull();
    expect(decodeNodes('just some copied words')).toBeNull();
    expect(decodeNodes('{"a":1}')).toBeNull();
    expect(decodeNodes('{"dceClipboard":2,"nodes":[]}')).toBeNull();
    expect(decodeNodes('{"dceClipboard":1,"nodes":')).toBeNull();
    expect(decodeNodes('{"dceClipboard":1,"nodes":[]}')).toBeNull();                 // nothing to paste
  });

  it('refuses objects that do not pass the design schema, so a pasted text can never corrupt a design', () => {
    expect(decodeNodes('{"dceClipboard":1,"nodes":[{"type":"not-a-real-type"}]}')).toBeNull();
    expect(decodeNodes('{"dceClipboard":1,"nodes":["x"]}')).toBeNull();
    expect(decodeNodes('{"dceClipboard":1,"nodes":[{"id":"a","type":"rect","x":"far left"}]}')).toBeNull();
  });

  it('refuses a payload with too many objects or too much text', () => {
    const many = Array.from({ length: MAX_PASTED_NODES + 1 }, () => makeNode('rect'));
    expect(decodeNodes(encodeNodes(many))).toBeNull();
    expect(decodeNodes('{"dceClipboard":1,"nodes":[],"pad":"' + 'x'.repeat(2_100_000) + '"}')).toBeNull();
  });
});
