import { renderTemplateString } from './binding';
import type { DceNode } from './types';

/**
 * Custom rendering plugins (build-time extension point).
 *
 * A plugin is plain TypeScript registered at start-up — never code loaded from a template or a data file (imported
 * designs cannot run scripts). A node of type `plugin` names a registered plugin and carries its parameters:
 *
 *   { "type": "plugin", "plugin": { "name": "progress", "value": "{{content.progress}}", "max": 100 }, … }
 *
 * `resolve` is pure: it receives the node and the data scope and returns drawing commands for the node's box.
 */
export type PluginCtx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export interface PluginDrawable {
  draw(ctx: PluginCtx, w: number, h: number): void;
  /** Optional SVG body (in the node's local box). Without it the SVG export leaves the element out. */
  svg?(w: number, h: number): string;
}

export interface RenderPlugin {
  name: string;
  label: string;
  /** Default parameters used when the plugin is added from the editor. */
  defaults: Record<string, unknown>;
  resolve(node: DceNode, scope: Record<string, unknown> | null): PluginDrawable | { error: string };
}

const registry = new Map<string, RenderPlugin>();
export const registerPlugin = (p: RenderPlugin): void => { registry.set(p.name, p); };
export const getPlugin = (name: unknown): RenderPlugin | undefined => (typeof name === 'string' ? registry.get(name) : undefined);
export const listPlugins = (): RenderPlugin[] => [...registry.values()];

const num = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const colour = (v: unknown, d: string) => (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v) ? v : d);

/** Built-in example: a horizontal progress bar driven by a field, e.g. value "{{content.progress}}" of max 100. */
registerPlugin({
  name: 'progress',
  label: 'Progress bar',
  defaults: { value: '{{content.progress}}', max: 100, color: '#4570B6', track: '#CAEBFB' },
  resolve(node, scope) {
    const p = node.plugin ?? { name: 'progress' };
    const raw = scope ? renderTemplateString(String(p.value ?? ''), scope).text : String(p.value ?? '50');
    const max = Math.max(1, num(p.max, 100));
    const v = Math.min(max, Math.max(0, num(raw, scope ? 0 : max / 2)));
    if (scope && raw.trim() === '') return { error: 'Progress value is empty' };
    const color = colour(p.color, '#4570B6'), track = colour(p.track, '#CAEBFB');
    const frac = v / max;
    return {
      draw(ctx, w, h) {
        const r = h / 2;
        ctx.fillStyle = track; ctx.beginPath(); ctx.roundRect(0, 0, w, h, r); ctx.fill();
        if (frac > 0) { ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(0, 0, Math.max(h, w * frac), h, r); ctx.fill(); }
      },
      svg(w, h) {
        const r = h / 2;
        return `<rect width="${w}" height="${h}" rx="${r}" fill="${track}"/>${frac > 0 ? `<rect width="${Math.max(h, w * frac)}" height="${h}" rx="${r}" fill="${color}"/>` : ''}`;
      },
    };
  },
});
