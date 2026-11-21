import { describe, expect, it } from 'vitest';
import { CUTOUT_PREFIX, collectImageRefs, cutoutBaseRef, imageRefsFor, isCutoutRef } from '../../src/engine/scene';
import type { DceNode, NjsDoc } from '../../src/engine/types';

const node = (binding?: DceNode['binding'], src?: DceNode['src']): DceNode => ({
  id: 'img1', type: 'image', name: 'Product image', x: 0, y: 0, width: 100, height: 100, rotation: 0,
  visible: true, locked: false, opacity: 1, layer: 0, style: {}, binding, src,
} as unknown as DceNode);

const scope = { content: { image_url: 'https://cdn.example/product.png', image_asset: 'asset-7' } };

describe('the background-removal flag of an image binding', () => {
  it('a field value gets the cut-out prefix only when the flag is on', () => {
    const on = imageRefsFor(node({ image: { key: 'content.image_url', cutout: true } }), scope);
    expect(on.primary).toBe(`${CUTOUT_PREFIX}https://cdn.example/product.png`);
    const off = imageRefsFor(node({ image: { key: 'content.image_url' } }), scope);
    expect(off.primary).toBe('https://cdn.example/product.png');
  });

  it('the fallback image is cut out too, so the frame never mixes the two looks', () => {
    const r = imageRefsFor(node({ image: { key: 'content.image_url', fallback: 'asset-9', cutout: true } }), { content: {} });
    expect(r.primary).toBeNull();
    expect(r.fallback).toBe(`${CUTOUT_PREFIX}asset-9`);
  });

  it('an image that is not taken from a field is never cut out by this flag', () => {
    const r = imageRefsFor(node(undefined, { assetId: 'asset-3' }), null);
    expect(r.primary).toBe('asset-3');
    expect(isCutoutRef(r.primary ?? '')).toBe(false);
  });

  it('the prefix can be taken off again, and a plain reference is left alone', () => {
    expect(cutoutBaseRef(`${CUTOUT_PREFIX}asset-7`)).toBe('asset-7');
    expect(cutoutBaseRef('asset-7')).toBe('asset-7');
    expect(isCutoutRef('asset-7')).toBe(false);
  });

  it('the batch collects the cut-out references of each record', () => {
    const doc = { nodes: [node({ image: { key: 'content.image_url', cutout: true } })] } as unknown as NjsDoc;
    const refs = collectImageRefs(doc, { content: { image_url: 'https://cdn.example/a.png' } } as never);
    expect(refs.primary).toEqual([`${CUTOUT_PREFIX}https://cdn.example/a.png`]);
  });
});
