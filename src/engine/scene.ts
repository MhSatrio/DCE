import { renderTemplateString, scopeOf } from './binding';
import { evalCondition, isEmpty, lookup } from './expr';
import { getPlugin, type PluginDrawable } from './plugins';
import { layoutText, type FontSpec, type TextLayout } from './textfit';
import type { DceNode, ImageFit, Issue, NjsDoc, NodeConstraints, Placeholder, RenderData } from './types';

export type ImageLike = ImageBitmap | HTMLImageElement | OffscreenCanvas | HTMLCanvasElement;

export interface SceneEnv {
  /** Decoded images by normalised reference (asset id / name / URL). `null` = failed to load. */
  images: Map<string, ImageLike | null>;
}

export type ItemKind = 'rect' | 'ellipse' | 'line' | 'polygon' | 'star' | 'path' | 'text' | 'image' | 'plugin';

export interface TextItem {
  layout: TextLayout;
  font: FontSpec;
  color: string;
  align: 'left' | 'center' | 'right';
  vAlign: 'top' | 'middle' | 'bottom';
  decoration: 'none' | 'underline' | 'line-through';
  padding: number;
}

export interface ImageItem {
  ref: string | null;
  bitmap: ImageLike | null;
  fit: ImageFit;
  focalX: number;
  focalY: number;
  placeholder: boolean;
  label: string;
}

export interface Item {
  id: string;
  name: string;
  kind: ItemKind;
  cx: number; cy: number; w: number; h: number;
  rotation: number;
  opacity: number;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  dash?: number[];
  radius: number;
  sides: number;
  points: number;
  innerRatio: number;
  path?: DceNode['path'];
  text?: TextItem;
  image?: ImageItem;
  custom?: PluginDrawable;
}

export interface Scene {
  width: number;
  height: number;
  background: string | null;
  items: Item[];
  issues: Issue[];
}

const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]{3,20}|transparent|none)$/i;
export function safeColor(v: unknown, fallback: string | null): string | null {
  if (typeof v !== 'string') return fallback;
  const s = v.trim();
  if (!COLOR_RE.test(s)) return fallback;
  if (s === 'none' || s === 'transparent') return null;
  return s;
}

export function normRef(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  let t = s.trim();
  if (!t) return null;
  if (t.startsWith('asset:')) t = t.slice(6);
  return t || null;
}

function placeholderMap(doc: NjsDoc): Map<string, Placeholder> {
  const m = new Map<string, Placeholder>();
  for (const p of doc.placeholders ?? []) m.set(p.key, p);
  return m;
}

function defaultsOf(map: Map<string, Placeholder>): Map<string, string> {
  const d = new Map<string, string>();
  for (const [k, p] of map) if (p.default_value !== undefined && p.default_value !== '') d.set(k, p.default_value);
  return d;
}

interface Ctx {
  scope: Record<string, unknown> | null;
  ph: Map<string, Placeholder>;
  defaults: Map<string, string>;
  env: SceneEnv;
  issues: Issue[];
}

function note(ctx: Ctx, level: Issue['level'], node: DceNode, message: string): void {
  ctx.issues.push({ level, nodeId: node.id, nodeName: node.name, message });
}

export function isBoundVisible(node: DceNode, scope: Record<string, unknown> | null, issues?: Issue[]): boolean {
  const expr = node.binding?.visible?.expr;
  if (!expr || !scope) return true;
  const r = evalCondition(expr, scope);
  if (r.error) issues?.push({ level: 'warning', nodeId: node.id, nodeName: node.name, message: `Visibility condition "${expr}" is invalid (${r.error}); showing the element.` });
  return r.value;
}

/** Which image references does this node need for this record? */
export function imageRefsFor(node: DceNode, scope: Record<string, unknown> | null): { primary: string | null; fallback: string | null } {
  const c: NodeConstraints = node.constraints ?? {};
  const own = normRef(node.src?.assetId ?? node.src?.url);
  const b = node.binding?.image;
  if (b && scope) {
    const v = lookup(scope, b.key);
    const primary = !isEmpty(v) ? normRef(typeof v === 'string' ? v : Array.isArray(v) ? v[0] : String(v)) : null;
    const fallback = normRef(b.fallback) ?? normRef(c.fallbackAssetId) ?? own;
    return { primary, fallback };
  }
  return { primary: own, fallback: normRef(c.fallbackAssetId) };
}

function walk(nodes: DceNode[], fn: (n: DceNode, parentHidden: boolean) => void, hidden = false): void {
  for (const n of nodes) {
    const h = hidden || !n.visible;
    fn(n, h);
    if (n.children) walk(n.children, fn, h);
  }
}

/** Every image reference needed to render `doc` for `data` (hidden nodes are skipped). */
export function collectImageRefs(
  doc: NjsDoc, data: RenderData | null,
): { primary: string[]; fallback: string[]; pairs: { primary: string | null; fallback: string | null }[] } {
  const primary = new Set<string>();
  const fallback = new Set<string>();
  const pairs: { primary: string | null; fallback: string | null }[] = [];
  const scope = data ? scopeOf(data) : null;
  walk(doc.nodes, (n, parentHidden) => {
    if (parentHidden || (n.type !== 'image' && n.type !== 'frame')) return;
    if (!isBoundVisible(n, scope)) return;
    const r = imageRefsFor(n, scope);
    pairs.push(r);
    if (r.primary) primary.add(r.primary);
    if (r.fallback) fallback.add(r.fallback);
  });
  return { primary: [...primary], fallback: [...fallback], pairs };
}

export function fontOf(style: DceNode['style']): FontSpec {
  return {
    family: style.fontFamily || 'Jost',
    size: style.fontSize || 32,
    weight: style.fontWeight || 400,
    style: style.fontStyle || 'normal',
    letterSpacing: style.letterSpacing || 0,
  };
}

function baseItem(n: DceNode, kind: ItemKind): Item {
  const stroke = safeColor(n.style.stroke, null);
  return {
    id: n.id, name: n.name, kind,
    cx: n.x + n.width / 2, cy: n.y + n.height / 2, w: n.width, h: n.height,
    rotation: n.rotation || 0, opacity: n.opacity ?? 1,
    fill: safeColor(n.style.fill, null),
    stroke: stroke && (n.style.strokeWidth ?? 0) > 0 ? stroke : null,
    strokeWidth: n.style.strokeWidth ?? 0,
    dash: n.style.strokeDash && n.style.strokeDash.length ? n.style.strokeDash : undefined,
    radius: n.style.cornerRadius ?? 0,
    sides: Math.max(3, Math.round(n.sides ?? 6)),
    points: Math.max(3, Math.round(n.points ?? 5)),
    innerRatio: n.innerRatio ?? 0.45,
    path: n.path,
  };
}

/**
 * Resolves one node into a drawable item. `scope === null` is "design mode": no data, static content only.
 * Never throws: every problem becomes an Issue and the element degrades gracefully.
 */
function resolveNode(n: DceNode, ctx: Ctx, parentOpacity: number): Item | null {
  const scope = ctx.scope;
  if (!isBoundVisible(n, scope, ctx.issues)) return null;
  const opacity = parentOpacity * (n.opacity ?? 1);
  const c: NodeConstraints = n.constraints ?? {};

  switch (n.type) {
    case 'rect': case 'ellipse': case 'line': case 'polygon': case 'star': case 'path': {
      const it = baseItem(n, n.type);
      it.opacity = opacity;
      const b = n.binding?.fill;
      if (b && scope) {
        const v = lookup(scope, b.key);
        const col = safeColor(v, undefined as never);
        if (isEmpty(v)) {
          note(ctx, 'warning', n, `Fill binding ${b.key} is empty; using ${b.fallback ?? 'the static fill'}.`);
          it.fill = safeColor(b.fallback, it.fill);
        } else if (col === (undefined as never)) {
          note(ctx, 'warning', n, `Fill binding ${b.key} is not a valid colour ("${String(v)}"); using the fallback.`);
          it.fill = safeColor(b.fallback, it.fill);
        } else it.fill = col;
      }
      if (n.type === 'line') { it.fill = null; if (!it.stroke) { it.stroke = safeColor(n.style.fill, '#231F20'); it.strokeWidth = n.style.strokeWidth || 2; } }
      return it;
    }
    case 'image': case 'frame': {
      const it = baseItem(n, 'image');
      it.opacity = opacity;
      const refs = imageRefsFor(n, scope);
      let ref = refs.primary;
      let bitmap = ref ? ctx.env.images.get(ref) ?? null : null;
      if (!bitmap && refs.fallback) { ref = refs.fallback; bitmap = ctx.env.images.get(ref) ?? null; }
      const missing = c.missing ?? (n.type === 'frame' ? 'placeholder' : 'hide');
      let placeholder = false;
      if (!bitmap) {
        if (scope === null) placeholder = true; // design mode
        else {
          const key = n.binding?.image?.key;
          const ph = key ? ctx.ph.get(key) : undefined;
          const msg = refs.primary ? `Image "${refs.primary}" could not be loaded` : key ? `Image field ${key} is empty` : 'No image selected';
          if (missing === 'error' || ph?.required) { note(ctx, 'error', n, `${msg}.`); return null; }
          note(ctx, 'warning', n, `${msg}.`);
          if (missing === 'hide') return null;
          placeholder = true;
        }
      }
      it.image = {
        ref, bitmap, placeholder,
        fit: c.fit ?? 'cover', focalX: c.focalX ?? 0.5, focalY: c.focalY ?? 0.5,
        label: n.binding?.image?.key ?? (n.type === 'frame' ? 'Image frame' : 'Image'),
      };
      return it;
    }
    case 'text': {
      const it = baseItem(n, 'text');
      it.opacity = opacity;
      const s = n.style;
      const font = fontOf(s);
      const pad = s.padding ?? 0;
      let tpl = n.binding?.text?.template ?? n.text ?? '';
      let text = tpl;
      if (scope) {
        const r = renderTemplateString(tpl, scope, ctx.defaults);
        text = r.text;
        if (r.missing.length) {
          const fb = n.binding?.text?.fallback ?? c.fallbackText;
          for (const key of r.missing) {
            const req = ctx.ph.get(key)?.required;
            if (req && !fb) note(ctx, 'error', n, `Required value ${key} is missing.`);
            else note(ctx, 'warning', n, `Value ${key} is missing${fb ? '; using fallback text' : ''}.`);
          }
          if (fb && (text.trim() === '' || r.missing.length === r.tokens)) text = fb;
        }
        tpl = text;
      }
      const layout = layoutText({
        text, font, lineHeight: s.lineHeight || 1.2,
        width: Math.max(1, n.width - pad * 2), height: Math.max(1, n.height - pad * 2), constraints: c,
      });
      if (layout.hidden) {
        if (scope) note(ctx, 'warning', n, `Text hidden (${layout.reason ?? 'policy'}).`);
        return null;
      }
      if (scope && layout.truncated) note(ctx, 'warning', n, 'Text was truncated to fit.');
      if (scope && layout.overflowed && c.overflow !== 'expand') note(ctx, 'warning', n, 'Text overflows its frame.');
      const h = layout.frameHeight + pad * 2;
      it.h = h;
      it.cy = n.y + h / 2;
      it.text = {
        layout, font, color: safeColor(n.binding?.fill && scope ? lookup(scope, n.binding.fill.key) : s.fill, '#231F20') ?? '#231F20',
        align: s.textAlign ?? 'left', vAlign: s.verticalAlign ?? 'top', decoration: s.decoration ?? 'none', padding: pad,
      };
      void tpl;
      return it;
    }
    case 'plugin': {
      const plugin = getPlugin(n.plugin?.name);
      if (!plugin) { note(ctx, 'warning', n, `Unknown render plugin "${String(n.plugin?.name)}" — element skipped.`); return null; }
      const r = plugin.resolve(n, scope);
      if ('error' in r) { note(ctx, 'warning', n, r.error + '.'); return null; }
      const it = baseItem(n, 'plugin');
      it.opacity = opacity;
      it.custom = r;
      return it;
    }
    default:
      return null;
  }
}

function flatten(nodes: DceNode[], ctx: Ctx, out: Item[], parentOpacity: number): void {
  for (const n of nodes) {
    if (!n.visible) continue;
    if (n.type === 'group') {
      if (!isBoundVisible(n, ctx.scope, ctx.issues)) continue;
      flatten(n.children ?? [], ctx, out, parentOpacity * (n.opacity ?? 1));
      continue;
    }
    try {
      const it = resolveNode(n, ctx, parentOpacity);
      if (it) out.push(it);
    } catch (e) {
      note(ctx, 'error', n, `Could not render element: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Builds the drawable scene for a template + record. `data === null` → design mode. */
export function buildScene(doc: NjsDoc, data: RenderData | null, env: SceneEnv): Scene {
  const ph = placeholderMap(doc);
  const ctx: Ctx = { scope: data ? scopeOf(data) : null, ph, defaults: defaultsOf(ph), env, issues: [] };
  const items: Item[] = [];
  flatten(doc.nodes, ctx, items, 1);
  return {
    width: doc.canvas.width, height: doc.canvas.height,
    background: safeColor(doc.canvas.background, null), items, issues: ctx.issues,
  };
}

/** Resolves a single node (editor use): returns null when hidden. */
export function buildItem(node: DceNode, doc: NjsDoc, data: RenderData | null, env: SceneEnv): { item: Item | null; issues: Issue[] } {
  const ph = placeholderMap(doc);
  const ctx: Ctx = { scope: data ? scopeOf(data) : null, ph, defaults: defaultsOf(ph), env, issues: [] };
  const item = resolveNode(node, ctx, 1);
  return { item, issues: ctx.issues };
}
