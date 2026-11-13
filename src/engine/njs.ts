import { z } from 'zod';
import { extractKeys } from './binding';
import { validateExpr } from './expr';
import {
  NJS_FORMAT, NJS_VERSION,
  type DceNode, type NjsDoc, type Placeholder, type PlaceholderType,
} from './types';

export const uid = (): string =>
  (globalThis.crypto && 'randomUUID' in globalThis.crypto)
    ? globalThis.crypto.randomUUID()
    : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

// ---------- validation (unknown properties are preserved via passthrough) ----------

const finite = z.number().refine(Number.isFinite, 'must be a finite number');

const nodeSchema: z.ZodType<DceNode> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    type: z.enum(['rect', 'ellipse', 'line', 'text', 'image', 'polygon', 'star', 'frame', 'path', 'group', 'plugin']),
    name: z.string().default(''),
    x: finite.default(0), y: finite.default(0),
    width: finite.default(0), height: finite.default(0),
    rotation: finite.default(0),
    visible: z.boolean().default(true),
    locked: z.boolean().default(false),
    opacity: z.number().min(0).max(1).default(1),
    layer: z.number().default(0),
    style: z.object({}).passthrough().default({}),
    children: z.array(nodeSchema).optional(),
  }).passthrough() as unknown as z.ZodType<DceNode>,
);

const placeholderSchema = z.object({
  key: z.string().min(1),
  type: z.enum(['text', 'image', 'color', 'boolean', 'number', 'date']).default('text'),
  label: z.string().default(''),
  required: z.boolean().default(false),
}).passthrough();

export const njsSchema = z.object({
  format: z.literal(NJS_FORMAT),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  meta: z.object({
    id: z.string().min(1),
    name: z.string().default('Untitled'),
    author: z.string().default(''),
    created_at: z.string().default(''),
    updated_at: z.string().default(''),
  }).passthrough(),
  canvas: z.object({
    width: z.number().min(1).max(16384),
    height: z.number().min(1).max(16384),
    background: z.string().default('#FFFFFF'),
  }).passthrough(),
  placeholders: z.array(placeholderSchema).default([]),
  nodes: z.array(nodeSchema).default([]),
  assets: z.array(z.object({ id: z.string(), name: z.string().default('') }).passthrough()).default([]),
  constraints: z.object({}).passthrough().default({}),
}).passthrough();

// ---------- migrations ----------

type Migration = { from: string; to: string; run: (doc: Record<string, unknown>) => Record<string, unknown> };

/**
 * Ordered migrations. 0.9.0 was a pre-release layout used only to exercise this mechanism
 * (canvas.bg → canvas.background, top-level `layers` → `nodes`); real files are written as 1.0.0.
 */
export const MIGRATIONS: Migration[] = [
  {
    from: '0.9.0', to: '1.0.0',
    run: (d) => {
      const out = { ...d } as Record<string, unknown>;
      const canvas = { ...((d.canvas as Record<string, unknown>) ?? {}) };
      if ('bg' in canvas && !('background' in canvas)) { canvas.background = canvas.bg; delete canvas.bg; }
      out.canvas = canvas;
      if (Array.isArray(d.layers) && !Array.isArray(d.nodes)) { out.nodes = d.layers; delete out.layers; }
      out.version = '1.0.0';
      return out;
    },
  },
];

const cmpVer = (a: string, b: string): number => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

export class NjsError extends Error {
  constructor(message: string, public issues: string[] = []) { super(message); }
}

export function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  let doc = raw;
  let guard = 0;
  while (typeof doc.version === 'string' && cmpVer(doc.version, NJS_VERSION) < 0 && guard++ < 20) {
    const m = MIGRATIONS.find((x) => x.from === doc.version) ?? MIGRATIONS.find((x) => cmpVer(x.from, doc.version as string) <= 0 && cmpVer(x.to, doc.version as string) > 0);
    if (!m) break;
    doc = m.run(doc);
  }
  return doc;
}

/** Parse + version-check + migrate + validate. Throws NjsError with readable issues. */
export function parseNjs(input: unknown): { doc: NjsDoc; warnings: string[] } {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try { raw = JSON.parse(input); } catch (e) { throw new NjsError('Not valid JSON: ' + (e instanceof Error ? e.message : String(e))); }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new NjsError('A .njs file must contain a JSON object.');
  const o = raw as Record<string, unknown>;
  const warnings: string[] = [];
  if (o.format !== NJS_FORMAT) throw new NjsError(`Not a DCE design file (format is "${String(o.format)}", expected "${NJS_FORMAT}").`);
  if (typeof o.version !== 'string') throw new NjsError('The file has no version.');
  if (cmpVer(o.version, NJS_VERSION) > 0) {
    const major = Number(o.version.split('.')[0]), cur = Number(NJS_VERSION.split('.')[0]);
    if (major > cur) throw new NjsError(`This file was made with a newer DCE (format ${o.version}); this build reads up to ${NJS_VERSION}.`);
    warnings.push(`File version ${o.version} is newer than ${NJS_VERSION}; unknown properties are preserved.`);
  }
  const migrated = migrate(o);
  if (migrated.version !== o.version) warnings.push(`Migrated from ${String(o.version)} to ${String(migrated.version)}.`);
  const r = njsSchema.safeParse(migrated);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new NjsError('The design file is invalid.', issues);
  }
  const doc = r.data as unknown as NjsDoc;
  // unique ids + deterministic layer order
  const seen = new Set<string>();
  const fix = (nodes: DceNode[]) => {
    nodes.sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0));
    nodes.forEach((n, i) => {
      if (seen.has(n.id)) { n.id = uid(); warnings.push(`Duplicate node id replaced for "${n.name}".`); }
      seen.add(n.id);
      n.layer = i;
      if (n.children) fix(n.children);
    });
  };
  fix(doc.nodes);
  for (const n of walkNodes(doc.nodes)) {
    const ex = n.binding?.visible?.expr;
    if (ex) { const err = validateExpr(ex); if (err) warnings.push(`"${n.name}": visibility condition is invalid (${err}).`); }
  }
  return { doc, warnings };
}

export function* walkNodes(nodes: DceNode[]): Generator<DceNode> {
  for (const n of nodes) { yield n; if (n.children) yield* walkNodes(n.children); }
}

// ---------- construction ----------

export function newDoc(name: string, width: number, height: number, background = '#FFFFFF'): NjsDoc {
  const now = new Date().toISOString();
  return {
    format: NJS_FORMAT,
    version: NJS_VERSION,
    meta: { id: uid(), name, author: 'VierApparatus', created_at: now, updated_at: now },
    canvas: { width, height, background },
    placeholders: [],
    nodes: [],
    assets: [],
    constraints: { snapGrid: 10, palette: ['#4570B6', '#CAEBFB', '#231F20', '#FFFFFF'] },
  };
}

export function makeNode(type: DceNode['type'], over: Partial<DceNode> = {}): DceNode {
  const base: DceNode = {
    id: uid(), type, name: defaultName(type),
    x: 100, y: 100, width: 200, height: 120, rotation: 0,
    visible: true, locked: false, opacity: 1, layer: 0, style: {},
  };
  switch (type) {
    case 'rect': base.style = { fill: '#4570B6', cornerRadius: 0 }; break;
    case 'ellipse': base.style = { fill: '#CAEBFB' }; base.height = 200; break;
    case 'polygon': base.style = { fill: '#4570B6' }; base.sides = 6; base.width = 160; base.height = 160; break;
    case 'star': base.style = { fill: '#4570B6' }; base.points = 5; base.innerRatio = 0.45; base.width = 160; base.height = 160; break;
    case 'line': base.style = { stroke: '#231F20', strokeWidth: 4 }; base.height = 12; base.width = 240; break;
    case 'text':
      base.text = 'Text'; base.width = 360; base.height = 80;
      base.style = { fill: '#231F20', fontFamily: 'Jost', fontSize: 40, fontWeight: 500, fontStyle: 'normal', textAlign: 'left', verticalAlign: 'top', lineHeight: 1.2, letterSpacing: 0, decoration: 'none', padding: 0 };
      base.constraints = { overflow: 'multiline' };
      break;
    case 'image': base.width = 320; base.height = 320; base.style = {}; base.constraints = { fit: 'cover', focalX: 0.5, focalY: 0.5, missing: 'hide' }; break;
    case 'frame': base.width = 320; base.height = 320; base.style = { cornerRadius: 0 }; base.constraints = { fit: 'cover', focalX: 0.5, focalY: 0.5, missing: 'placeholder' }; break;
    case 'path': base.style = { fill: 'none', stroke: '#231F20', strokeWidth: 4 }; base.path = { points: [], closed: false }; break;
    case 'group': base.children = []; break;
    case 'plugin': base.plugin = { name: 'progress', value: '{{content.progress}}', max: 100 }; base.width = 360; base.height = 24; break;
  }
  return { ...base, ...over, style: { ...base.style, ...(over.style ?? {}) } };
}

function defaultName(type: DceNode['type']): string {
  return { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', text: 'Text', image: 'Image', polygon: 'Polygon', star: 'Star', frame: 'Image frame', path: 'Path', group: 'Group', plugin: 'Plugin' }[type];
}

// ---------- placeholders ----------

const IMAGE_HINT = /image|photo|logo|picture|thumbnail/i;

/** Keys used by bindings (content.* / template.*), with the kind of value expected. */
export function usedBindingKeys(doc: NjsDoc): { key: string; type: PlaceholderType }[] {
  const map = new Map<string, PlaceholderType>();
  const add = (key: string, type: PlaceholderType) => { if (/^(content|template)\./.test(key) && !map.has(key)) map.set(key, type); };
  for (const n of walkNodes(doc.nodes)) {
    const b = n.binding;
    if (!b) continue;
    if (b.text) for (const k of extractKeys(b.text.template)) add(k, IMAGE_HINT.test(k) ? 'image' : 'text');
    if (b.image) add(b.image.key, 'image');
    if (b.fill) add(b.fill.key, 'color');
    if (b.visible) for (const m of b.visible.expr.matchAll(/\b((?:content|template)\.[A-Za-z_][A-Za-z0-9_]*)/g)) add(m[1], 'text');
    if (n.type === 'text' && n.text) for (const k of extractKeys(n.text)) add(k, 'text');
  }
  return [...map].map(([key, type]) => ({ key, type }));
}

/** Adds missing placeholder entries, keeps the user's edits, flags nothing destructive. */
export function syncPlaceholders(doc: NjsDoc): Placeholder[] {
  const existing = new Map(doc.placeholders.map((p) => [p.key, p]));
  const out: Placeholder[] = [...doc.placeholders];
  for (const { key, type } of usedBindingKeys(doc)) {
    if (existing.has(key)) continue;
    const label = key.replace(/^(content|template)\./, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    out.push({ key, type, label, required: false });
  }
  return out;
}

/** Placeholder constraints are mirrored onto text nodes bound to the key at design time. */
export function touch(doc: NjsDoc): NjsDoc {
  doc.meta.updated_at = new Date().toISOString();
  return doc;
}

export function cloneDoc<T>(d: T): T {
  return structuredClone(d);
}

/** Layer numbers are z-order indices; keep them consistent at every nesting level. */
export function renumberLayers(nodes: DceNode[]): void {
  nodes.forEach((n, i) => { n.layer = i; if (n.children) renumberLayers(n.children); });
}

export function serializeNjs(doc: NjsDoc): string {
  const copy = cloneDoc(doc);
  renumberLayers(copy.nodes);
  return JSON.stringify(copy, null, 2);
}

/** Round-trip helper used by tests: parse(serialize(doc)) must equal doc. */
export function roundTrip(doc: NjsDoc): NjsDoc {
  return parseNjs(serializeNjs(doc)).doc;
}
