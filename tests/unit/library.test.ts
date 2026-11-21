import { describe, expect, it } from 'vitest';
import { marksBetween, majorStep } from '../../src/editor/Rulers';
import { folderNames, UNFILED } from '../../src/db/assetFolders';
import { VIER_PACK_FOLDER, vierPack } from '../../src/assets/vierPack';
import { parseSvg, serializeSvg } from '../../src/assets/svgdoc';

describe('rulers', () => {
  it('labels every step that is at least 64 screen pixels apart, so the marks never crowd', () => {
    expect(majorStep(1)).toBe(100);      // 100 px apart at 100 %
    expect(majorStep(0.5)).toBe(200);    // at 50 %, 100 would be 50 px apart (too close); 200 is 100 px
    expect(majorStep(4)).toBe(20);       // 20 * 4 = 80 px
    for (const z of [0.05, 0.3, 1, 2.5, 8]) expect(majorStep(z) * z).toBeGreaterThanOrEqual(64 - 1e-9);
  });

  it('marks cover the visible scene range and nothing beyond it', () => {
    expect(marksBetween(-12, 26, 10)).toEqual([-20, -10, 0, 10, 20]);
    expect(marksBetween(0, 0, 5)).toEqual([0]);
  });
});

describe('asset folders', () => {
  it('lists the saved folders and the folders that hold assets, once each, sorted', () => {
    const assets = [{ category: 'Lab' }, { category: 'Brand' }, { category: 'Lab' }];
    expect(folderNames(assets, ['Empty', 'Lab'])).toEqual(['Brand', 'Empty', 'Lab']);
  });

  it('an asset without a folder counts as “Uncategorised”', () => {
    expect(folderNames([{ category: '' }], [])).toEqual([UNFILED]);
  });
});

describe('the VierApparatus vector pack', () => {
  it('has 50 drawings in the VierAsset folder, with unique names', () => {
    expect(VIER_PACK_FOLDER).toBe('VierAsset');
    expect(vierPack.length).toBe(50);
    expect(new Set(vierPack.map((f) => f.name)).size).toBe(50);
  });

  it('every drawing is made of filled paths only, so the vector editor can edit each point', () => {
    for (const f of vierPack) {
      const body = f.svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
      expect(body, f.name).not.toMatch(/<(rect|circle|ellipse|line|polyline|polygon|g|text|use|image)\b/);
      expect(body, f.name).not.toMatch(/stroke/);
      const doc = parseSvg(f.svg);
      expect(doc.paths.length, f.name).toBeGreaterThan(0);
      expect(parseSvg(serializeSvg(doc)).paths, f.name).toEqual(doc.paths);
    }
  });

  it('has a transparent background: no path covers the whole picture', () => {
    for (const f of vierPack) {
      const doc = parseSvg(f.svg);
      for (const p of doc.paths) {
        const pts = p.subs.flatMap((s) => [s.start, ...s.segs.map((g) => g.p)]);
        const wide = Math.max(...pts.map((q) => q.x)) - Math.min(...pts.map((q) => q.x));
        const high = Math.max(...pts.map((q) => q.y)) - Math.min(...pts.map((q) => q.y));
        expect(wide >= 199 && high >= 199, `${f.name} has a full-size background shape`).toBe(false);
      }
    }
  });
});
