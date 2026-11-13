import { beforeAll, describe, expect, it } from 'vitest';
import { evalCondition, ExprError, parseExpr, validateExpr } from '../../src/engine/expr';
import { renderFilename, renderTemplateString, slugify, UniqueNames } from '../../src/engine/binding';
import { layoutText, wrapText, type FontSpec } from '../../src/engine/textfit';
import { MIGRATIONS, makeNode, newDoc, NjsError, parseNjs, roundTrip, serializeNjs, syncPlaceholders, usedBindingKeys } from '../../src/engine/njs';
import { buildScene } from '../../src/engine/scene';
import { sceneToSvg } from '../../src/engine/svg';
import { jpegToPdf } from '../../src/engine/pdf';
import type { RenderData } from '../../src/engine/types';

// A fake canvas whose text width is exactly 0.5 × fontSize per character, so layouts are exact.
beforeAll(() => {
  class FakeCtx {
    font = '10px x'; letterSpacing = '0px';
    measureText(s: string) { const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10); return { width: s.length * size * 0.5 }; }
  }
  (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = class { getContext() { return new FakeCtx(); } };
});

const F: FontSpec = { family: 'Jost', size: 20, weight: 400, style: 'normal', letterSpacing: 0 };
const data = (content: Record<string, unknown>): RenderData => ({ content, template: { primary_color: '#4570B6' }, batch: { index: 1, total: 1 } });

describe('safe expressions', () => {
  const scope = { content: { discount: '-10%', status: 'Approved', price: 120, tags: ['a', 'b'], empty: '', zero: 0 }, template: {} };
  it.each([
    ['content.discount', true], ['!content.discount', false], ['exists(content.discount)', true], ['exists(content.nope)', false],
    ['content.status == "Approved"', true], ["content.status != 'Draft'", true], ['content.price > 100 && content.price < 200', true],
    ['content.price >= 121', false], ['empty(content.empty)', true], ['content.zero', false], ['len(content.tags) == 2', true],
    ['content.tags contains "b"', true], ['content.status contains "prov"', true], ['not content.empty or content.zero', true],
    ['(content.price > 1000 || content.discount) && content.status == "Approved"', true],
  ])('%s → %s', (src, expected) => { expect(evalCondition(src, scope).value).toBe(expected); });

  it('rejects code-like input and never evaluates it', () => {
    for (const bad of ['constructor.constructor("return 1")()', 'alert(1)', 'a; b', '1 +', 'content.price ==']) {
      expect(validateExpr(bad)).not.toBeNull();
    }
    expect(() => parseExpr('process.exit(1)')).toThrow(ExprError);
  });

  it('does not walk the prototype chain', () => {
    expect(evalCondition('content.constructor', scope).value).toBe(false);
    expect(evalCondition('content.__proto__', scope).value).toBe(false);
  });

  it('invalid expressions fall back to visible with an error message', () => {
    const r = evalCondition('content.x ==', scope);
    expect(r.value).toBe(true);
    expect(r.error).toBeTruthy();
  });
});

describe('bindings', () => {
  it('resolves tokens, filters and reports missing values', () => {
    const scope = { content: { title: 'Rotary evaporator', price: 1234.5, date: '2026-11-05', empty: '' } };
    const r = renderTemplateString('{{content.title|upper}} — {{content.price|number:1}} ({{content.date|date}}) {{content.nope}}', scope);
    expect(r.text).toBe('ROTARY EVAPORATOR — 1,234.5 (5 Nov 2026) ');
    expect(r.missing).toEqual(['content.nope']);
    expect(renderTemplateString('{{content.empty|default:N/A}}', scope).text).toBe('N/A');
    expect(renderTemplateString('{{content.title|truncate:6}}', scope).text).toBe('Rotar…');
  });
  it('uses placeholder defaults for missing values', () => {
    const r = renderTemplateString('{{content.cta}}', { content: {} }, new Map([['content.cta', 'Request a quote']]));
    expect(r.text).toBe('Request a quote');
    expect(r.missing).toEqual([]);
  });
  it('slugifies and builds unique, safe file names', () => {
    expect(slugify('  Ünïcode Centrifuge #2 ')).toBe('unicode-centrifuge-2');
    const d = data({ slug: 'a/b:c', title: 'Hello World' });
    expect(renderFilename('{{content.slug}}.png', d, 'png')).toBe('a-b-c.png');
    expect(renderFilename('{{index:4}}-{{content.title|slug}}', d, 'jpg')).toBe('0001-hello-world.jpg');
    expect(renderFilename('{{content.missing}}', d, 'png')).toMatch(/^record-001\.png$/);
    const u = new UniqueNames();
    expect([u.take('a.png'), u.take('A.png'), u.take('a.png'), u.take('b.png')]).toEqual(['a.png', 'A-2.png', 'a-3.png', 'b.png']);
  });
});

describe('text fitting', () => {
  it('wraps greedily and breaks over-long words', () => {
    // 20px font → 10px per char; width 100 = 10 chars
    expect(wrapText('hello brave new world', F, 20, 100)).toEqual(['hello', 'brave new', 'world']);
    expect(wrapText('supercalifragilistic', F, 20, 100)).toEqual(['supercalif', 'ragilistic']);
    expect(wrapText('a\n\nb', F, 20, 100)).toEqual(['a', '', 'b']);
  });
  const base = (text: string, c: Record<string, unknown>, over: Partial<{ width: number; height: number }> = {}) =>
    layoutText({ text, font: F, lineHeight: 1.2, width: over.width ?? 100, height: over.height ?? 48, constraints: c });

  it('auto_shrink picks the largest size that fits and respects the minimum', () => {
    const fit = base('hello brave new world', { overflow: 'auto_shrink', minFontSize: 8 }, { width: 100, height: 48 });
    expect(fit.fontSize).toBeLessThan(20);
    expect(fit.fontSize).toBeGreaterThanOrEqual(8);
    expect(fit.lines.length * fit.lineHeightPx).toBeLessThanOrEqual(48 + 0.01);
    const tooLong = base('x'.repeat(400), { overflow: 'auto_shrink', minFontSize: 18 }, { width: 100, height: 48 });
    expect(tooLong.fontSize).toBe(18);
    expect(tooLong.lines[tooLong.lines.length - 1].endsWith('…')).toBe(true);
  });
  it('truncate adds an ellipsis, maxLines is honoured', () => {
    const t = base('hello brave new world again and again', { overflow: 'truncate' }, { width: 100, height: 48 });
    expect(t.lines).toHaveLength(2);
    expect(t.lines[1].endsWith('…')).toBe(true);
    const m = base('one two three four five six seven', { overflow: 'multiline', maxLines: 2 }, { width: 100, height: 400 });
    expect(m.lines).toHaveLength(2);
  });
  it('expand grows the frame; hide hides oversize or empty text; maxChars truncates', () => {
    const e = base('hello brave new world again', { overflow: 'expand' }, { width: 100, height: 24 });
    expect(e.frameHeight).toBeGreaterThan(24);
    expect(base('hello brave new world again and more', { overflow: 'hide' }, { width: 100, height: 24 }).hidden).toBe(true);
    expect(base('', { overflow: 'hide' }).hidden).toBe(true);
    expect(base('', {}).hidden).toBe(false);
    const c = base('abcdefghijklmnop', { maxChars: 8, overflow: 'multiline' });
    expect(c.lines.join('')).toBe('abcdefg…');
    expect(base('abcdefghijklmnop', { maxChars: 8, overflow: 'hide' }).hidden).toBe(true);
  });
  it('is deterministic and cached', () => {
    const a = base('same text again', { overflow: 'auto_shrink' });
    const b = base('same text again', { overflow: 'auto_shrink' });
    expect(b).toBe(a);
  });
});

describe('.njs format', () => {
  const doc = () => {
    const d = newDoc('Test', 800, 600);
    d.nodes = [
      makeNode('rect', { name: 'bg', x: 0, y: 0, width: 800, height: 600, extra_flag: { keep: true } }),
      makeNode('text', { name: 'Title', text: 'Hi', binding: { text: { template: '{{content.title}}', fallback: 'None' } } }),
      makeNode('group', { name: 'Badge', binding: { visible: { expr: 'exists(content.discount)' } }, children: [makeNode('star'), makeNode('text', { text: '{{content.discount}}' })] }),
    ];
    d.futureField = { a: 1 };
    return d;
  };
  it('round-trips without losing information, including unknown properties', () => {
    const d = doc();
    const back = roundTrip(d);
    expect(back.nodes.map((n) => n.name)).toEqual(['bg', 'Title', 'Badge']);
    expect((back.nodes[0] as Record<string, unknown>).extra_flag).toEqual({ keep: true });
    expect((back as Record<string, unknown>).futureField).toEqual({ a: 1 });
    expect(back.nodes[2].children).toHaveLength(2);
    expect(JSON.parse(serializeNjs(back))).toEqual(JSON.parse(serializeNjs(d)));
  });
  it('validates and explains problems', () => {
    expect(() => parseNjs('nope')).toThrow(NjsError);
    expect(() => parseNjs({ format: 'other' })).toThrow(/Not a DCE design/);
    const bad = JSON.parse(serializeNjs(doc())); bad.canvas.width = -5;
    expect(() => parseNjs(bad)).toThrow(NjsError);
    const newer = JSON.parse(serializeNjs(doc())); newer.version = '9.0.0';
    expect(() => parseNjs(newer)).toThrow(/newer/);
    const minor = JSON.parse(serializeNjs(doc())); minor.version = '1.7.0';
    expect(parseNjs(minor).warnings.join(' ')).toMatch(/newer/);
  });
  it('migrates the pre-release layout', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    const old = { format: 'vierapparatus-dce', version: '0.9.0', meta: { id: 'x', name: 'Old' }, canvas: { width: 100, height: 100, bg: '#fff' }, layers: [makeNode('rect')] };
    const { doc: d, warnings } = parseNjs(old);
    expect(d.version).toBe('1.0.0');
    expect(d.canvas.background).toBe('#fff');
    expect(d.nodes).toHaveLength(1);
    expect(warnings.join(' ')).toMatch(/Migrated/);
  });
  it('derives placeholders from bindings', () => {
    const keys = usedBindingKeys(doc()).map((k) => k.key);
    expect(keys).toEqual(expect.arrayContaining(['content.title', 'content.discount']));
    const d = doc(); d.placeholders = syncPlaceholders(d);
    expect(d.placeholders.map((p) => p.key)).toContain('content.title');
  });
});

describe('render plugins', () => {
  it('the built-in progress plugin resolves from data, degrades safely and exports SVG', () => {
    const d = newDoc('P', 400, 100);
    d.nodes = [
      makeNode('plugin', { name: 'bar', x: 0, y: 0, width: 200, height: 20, plugin: { name: 'progress', value: '{{content.pct}}', max: 100 } }),
      makeNode('plugin', { name: 'ghost', plugin: { name: 'does-not-exist' } }),
    ];
    const s = buildScene(d, data({ pct: 25 }), { images: new Map() });
    expect(s.items.map((i) => i.name)).toEqual(['bar']);
    expect(s.issues.some((i) => /Unknown render plugin/.test(i.message))).toBe(true);
    expect(sceneToSvg(s)).toContain('width="50"'); // 25% of 200
    const empty = buildScene(d, data({}), { images: new Map() });
    expect(empty.items.find((i) => i.name === 'bar')).toBeUndefined();
    expect(empty.issues.some((i) => /Progress value is empty/.test(i.message))).toBe(true);
  });
});

describe('scene resolution', () => {
  const mk = () => {
    const d = newDoc('S', 400, 300);
    d.placeholders = [{ key: 'content.title', type: 'text', label: 'Title', required: true }, { key: 'content.cta', type: 'text', label: 'CTA', required: false, default_value: 'Go' }];
    d.nodes = [
      makeNode('text', { name: 'Title', x: 0, y: 0, width: 300, height: 60, text: 'x', binding: { text: { template: '{{content.title}}' } } }),
      makeNode('text', { name: 'CTA', x: 0, y: 100, width: 300, height: 60, text: 'x', binding: { text: { template: '{{content.cta}}' } } }),
      makeNode('rect', { name: 'Badge', binding: { visible: { expr: 'exists(content.discount)' } } }),
      makeNode('rect', { name: 'Accent', binding: { fill: { key: 'content.accent', fallback: '#123456' } } }),
      makeNode('frame', { name: 'Photo', binding: { image: { key: 'content.photo' } }, constraints: { missing: 'placeholder' } }),
    ];
    return d;
  };
  it('missing required value is an error; defaults and fallbacks never throw', () => {
    const s = buildScene(mk(), data({}), { images: new Map() });
    expect(s.issues.some((i) => i.level === 'error' && /Required value content.title/.test(i.message))).toBe(true);
    const cta = s.items.find((i) => i.name === 'CTA')!;
    expect(cta.text!.layout.lines.join('')).toBe('Go');
    expect(s.items.find((i) => i.name === 'Badge')).toBeUndefined();
    expect(s.items.find((i) => i.name === 'Accent')!.fill).toBe('#123456');
    expect(s.items.find((i) => i.name === 'Photo')!.image!.placeholder).toBe(true);
  });
  it('conditional visibility, colour validation and hidden nodes', () => {
    const d = mk(); d.nodes[3].visible = true; d.nodes[0].visible = false;
    const s = buildScene(d, data({ title: 'T', discount: '-5%', accent: 'url(javascript:1)' }), { images: new Map() });
    expect(s.items.find((i) => i.name === 'Badge')).toBeDefined();
    expect(s.items.find((i) => i.name === 'Title')).toBeUndefined();
    expect(s.items.find((i) => i.name === 'Accent')!.fill).toBe('#123456');
  });
  it('is deterministic and produces valid-looking SVG / PDF', () => {
    const d = mk();
    const a = sceneToSvg(buildScene(d, data({ title: 'A <b> & "q"' }), { images: new Map() }));
    const b = sceneToSvg(buildScene(d, data({ title: 'A <b> & "q"' }), { images: new Map() }));
    expect(a).toBe(b);
    expect(a).toContain('A &lt;b&gt; &amp; &quot;q&quot;');
    expect(a.startsWith('<?xml')).toBe(true);
    const pdf = jpegToPdf(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), 100, 50);
    const txt = new TextDecoder('latin1').decode(pdf);
    expect(txt.startsWith('%PDF-1.4')).toBe(true);
    expect(txt).toContain('/MediaBox [0 0 75 37.5]');
    expect(txt.trimEnd().endsWith('%%EOF')).toBe(true);
    const start = Number(/startxref\n(\d+)/.exec(txt)![1]);
    expect(txt.slice(start, start + 4)).toBe('xref');
  });
});
