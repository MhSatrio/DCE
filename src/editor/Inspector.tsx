import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalSpaceBetween, AlignLeft, AlignRight,
  AlignStartHorizontal, AlignStartVertical, AlignVerticalSpaceBetween, AlignCenter, Bold, ImagePlus, Italic, Link2Off, Plus, Strikethrough, Underline, X,
} from 'lucide-react';
import { allFields } from '../db/fields';
import { recordsStore } from '../db/repo';
import { db } from '../db/schema';
import { validateExpr } from '../engine/expr';
import { getPlugin } from '../engine/plugins';
import { buildItem, fontOf } from '../engine/scene';
import { estimateCapacity } from '../engine/textfit';
import type { DceNode, NodeConstraints, OverflowPolicy, Placeholder, PlaceholderType } from '../engine/types';
import { AssetPicker } from '../ui/AssetPicker';
import { IconBtn, Tabs } from '../ui/kit';
import { useStore } from '../ui/store';
import { AssetThumb } from '../ui/Thumb';
import { ColorField, Num, Section, Seg } from './controls';
import type { EditorController } from './controller';

type Tab = 'design' | 'data' | 'fit' | 'template';

function useFieldOptions(ctrl: EditorController) {
  const custom = useStore(recordsStore, (s) => s.fields);
  const doc = useStore(ctrl.store, (s) => s.doc);
  return useMemo(() => {
    const content = allFields(custom).map((f) => ({ key: `content.${f.key}`, label: f.label, type: f.type }));
    const vars = doc.placeholders.filter((p) => p.key.startsWith('template.')).map((p) => ({ key: p.key, label: p.label || p.key, type: p.type as string }));
    return [...content, ...vars];
  }, [custom, doc.placeholders]);
}

function FieldSelect(props: { value: string; onChange: (key: string) => void; options: { key: string; label: string; type: string }[]; placeholder?: string; label: string }) {
  return (
    <label className="fld"><span>{props.label}</span>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value)} aria-label={props.label}>
        <option value="">{props.placeholder ?? '— not bound —'}</option>
        {props.options.map((o) => <option key={o.key} value={o.key}>{o.label}  ·  {o.key}</option>)}
        {props.value && !props.options.some((o) => o.key === props.value) && <option value={props.value}>{props.value}</option>}
      </select>
    </label>
  );
}

const FONTS_GENERIC = ['sans-serif', 'serif', 'monospace'];
const WEIGHTS: [number, string][] = [[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold']];

/** "How much text fits?" — measured with the real font, box size, line height and constraints. */
function CapacityHint({ n }: { n: DceNode }) {
  const c = n.constraints ?? {};
  const info = useMemo(() => {
    const st = n.style, f = fontOf(st), pad = st.padding ?? 0;
    const w = Math.max(1, n.width - pad * 2), h = Math.max(1, n.height - pad * 2), lh = st.lineHeight || 1.2;
    const cur = estimateCapacity(f, f.size, w, h, lh, c.maxLines);
    let shrink: ReturnType<typeof estimateCapacity> | null = null, minSize = 0;
    if (c.overflow === 'auto_shrink') {
      const hi = c.maxFontSize && c.maxFontSize > 0 ? c.maxFontSize : f.size;
      minSize = Math.min(c.minFontSize && c.minFontSize > 0 ? c.minFontSize : Math.max(6, Math.round(hi * 0.4)), hi);
      shrink = estimateCapacity(f, minSize, w, h, lh, c.maxLines);
    }
    return { cur, shrink, minSize, size: f.size };
  }, [n.width, n.height, n.style, c.maxLines, c.overflow, c.minFontSize, c.maxFontSize]);
  const cap = (x: number) => (c.maxChars && c.maxChars > 0 ? Math.min(x, c.maxChars) : x);
  const shown = info.shrink ?? info.cur;
  const limit = cap(shown.chars);
  const words = (x: { words: number; chars: number }, chars: number) => Math.round(x.words * (chars / Math.max(1, x.chars)));
  return (
    <div className="callout" aria-label="Text capacity" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div><b>Fits about {cap(info.cur.chars)} characters (≈ {words(info.cur, cap(info.cur.chars))} words)</b> at {info.size}px, in {info.cur.lines} line{info.cur.lines === 1 ? '' : 's'} of ≈ {info.cur.charsPerLine}.</div>
      {info.shrink && <div>With auto-shrink down to {info.minSize}px: about <b>{limit} characters (≈ {words(shown, limit)} words)</b>. Longer text is cut with “…”.</div>}
      {!info.shrink && c.overflow !== 'expand' && <div className="small">Longer text {c.overflow === 'hide' ? 'hides the element' : c.overflow === 'truncate' ? 'is cut with “…”' : 'overflows the frame (set Fit → Overflow to shrink / cut / expand)'}.</div>}
      <div className="small muted">Estimate for typical English prose; it depends on font, size, weight, letter spacing, line height, padding and the frame area.</div>
    </div>
  );
}

/** The value the preview record actually produces here: length, and whether it was shrunk or cut. */
function LiveFit({ ctrl, n }: { ctrl: EditorController; n: DceNode }) {
  const previewOn = useStore(ctrl.store, (s) => s.previewOn);
  useStore(ctrl.store, (s) => s.rev);
  useStore(ctrl.store, (s) => s.previewRecordId);
  if (!previewOn) return null;
  const data = ctrl.data();
  if (!data) return null;
  const { item } = buildItem(n, ctrl.doc(), data, ctrl.env);
  const L = item?.text?.layout;
  if (!L) return <div className="small muted">Preview record: this element is hidden for it.</div>;
  const chars = L.lines.join('').length;
  return <div className="small">Preview record: <b>{chars}</b> characters shown over {L.lines.length} line{L.lines.length === 1 ? '' : 's'} at <b>{Math.round(L.fontSize * 10) / 10}px</b>{L.shrunk ? ' (shrunk to fit)' : ''}{L.truncated ? ' — cut with “…”' : ''}{L.overflowed ? ' — overflows the frame' : ''}.</div>;
}

// ---------------------------------------------------------------- Design
function DesignTab({ ctrl, n, onGoto }: { ctrl: EditorController; n: DceNode; onGoto: (t: Tab) => void }) {
  const doc = useStore(ctrl.store, (s) => s.doc);
  const fonts = useLiveQuery(() => db.fonts.toArray(), [], []);
  const families = useMemo(() => ['Jost', ...new Set((fonts ?? []).map((f) => f.family)), ...FONTS_GENERIC], [fonts]);
  const [picker, setPicker] = useState(false);
  const set = (fn: (x: DceNode) => void, coalesce?: string) => ctrl.updateNode(n.id, fn, { coalesce: coalesce ? `${n.id}:${coalesce}` : undefined });
  const st = n.style;
  const palette = doc.constraints.palette ?? [];
  const isShape = ['rect', 'ellipse', 'polygon', 'star', 'path'].includes(n.type);
  const isText = n.type === 'text';
  const isImg = n.type === 'image' || n.type === 'frame';
  const locked = n.locked;
  const bound = !!n.binding?.text;
  const layerSection = (
    <Section title="Position & size">
      <label className="fld"><span>Name</span><input value={n.name} onChange={(e) => set((x) => { x.name = e.target.value; }, 'name')} aria-label="Layer name" /></label>
      <div className="grid2">
        <Num label="X" value={n.x} onChange={(v) => set((x) => { x.x = v; }, 'x')} disabled={locked || n.type === 'group'} suffix="px" />
        <Num label="Y" value={n.y} onChange={(v) => set((x) => { x.y = v; }, 'y')} disabled={locked || n.type === 'group'} suffix="px" />
        <Num label="Width" value={n.width} min={2} onChange={(v) => set((x) => { x.width = v; }, 'w')} disabled={locked || n.type === 'group'} suffix="px" />
        <Num label="Height" value={n.height} min={2} onChange={(v) => set((x) => { x.height = v; }, 'h')} disabled={locked || n.type === 'group'} suffix="px" />
        <Num label="Rotation" value={n.rotation} min={-360} max={360} onChange={(v) => set((x) => { x.rotation = v; }, 'rot')} disabled={locked || n.type === 'group'} suffix="°" />
        <Num label="Opacity" value={Math.round((n.opacity ?? 1) * 100)} min={0} max={100} onChange={(v) => set((x) => { x.opacity = v / 100; }, 'op')} suffix="%" />
      </div>
    </Section>
  );
  return (
    <>
      {!isText && layerSection}
      {isShape && (
        <Section title="Appearance">
          {n.type !== 'path' || n.path?.closed ? <ColorField label="Fill" value={st.fill} allowNone palette={palette} onChange={(v) => set((x) => { x.style.fill = v; }, 'fill')} /> : null}
          <ColorField label="Stroke" value={st.stroke} allowNone palette={palette} onChange={(v) => set((x) => { x.style.stroke = v; if (v !== 'none' && !(x.style.strokeWidth ?? 0)) x.style.strokeWidth = 2; }, 'stroke')} />
          <div className="grid2">
            <Num label="Stroke width" value={st.strokeWidth ?? 0} min={0} max={200} onChange={(v) => set((x) => { x.style.strokeWidth = v; }, 'sw')} />
            {n.type === 'rect' && <Num label="Corner radius" value={st.cornerRadius ?? 0} min={0} max={2000} onChange={(v) => set((x) => { x.style.cornerRadius = v; }, 'cr')} />}
            {n.type === 'polygon' && <Num label="Sides" value={n.sides ?? 6} min={3} max={24} onChange={(v) => set((x) => { x.sides = Math.round(v); }, 'sides')} />}
            {n.type === 'star' && <Num label="Points" value={n.points ?? 5} min={3} max={24} onChange={(v) => set((x) => { x.points = Math.round(v); }, 'pts')} />}
            {n.type === 'star' && <Num label="Inner radius" value={Math.round((n.innerRatio ?? 0.45) * 100)} min={10} max={95} suffix="%" onChange={(v) => set((x) => { x.innerRatio = v / 100; }, 'ir')} />}
          </div>
        </Section>
      )}
      {n.type === 'path' && (
        <Section title="Bézier path">
          <div className="muted small">{n.path?.points.length ?? 0} points. With the Pen tool, click for a corner and click-and-drag for a curve.</div>
          <div className="row wrap">
            <button className="btn sm primary" onClick={() => ctrl.startPathEdit(n.id)}>Edit points (Enter)</button>
            <button className="btn sm" onClick={() => ctrl.pathSmoothAll()}>Smooth all</button>
            <button className="btn sm" onClick={() => ctrl.pathCornerAll()}>All corners</button>
          </div>
          <label className="chk"><input type="checkbox" checked={!!n.path?.closed} onChange={() => ctrl.pathToggleClosed()} /> Closed shape</label>
        </Section>
      )}
      {n.type === 'line' && (
        <Section title="Line">
          <ColorField label="Colour" value={st.stroke} palette={palette} onChange={(v) => set((x) => { x.style.stroke = v; }, 'stroke')} />
          <Num label="Thickness" value={st.strokeWidth ?? 4} min={1} max={200} onChange={(v) => set((x) => { x.style.strokeWidth = v; x.height = Math.max(12, v + 6); }, 'sw')} />
        </Section>
      )}

      {isText && (
        <>
          <Section title="Text">
            {bound ? (
              <div className="callout" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="bind-dot" /> <span className="grow">Text comes from data: <code>{n.binding!.text!.template}</code></span>
                <button className="btn sm" onClick={() => onGoto('data')}>Change…</button>
              </div>
            ) : (
              <label className="fld"><span>Text (type here, or bind it to a field on the Data tab)</span>
                <textarea rows={3} aria-label="Text content" value={n.text ?? ''} onChange={(e) => set((x) => { x.text = e.target.value; }, 'text')} />
              </label>
            )}
            <div className="grid2">
              <label className="fld"><span>Font</span><select value={st.fontFamily ?? 'Jost'} aria-label="Font family" onChange={(e) => set((x) => { x.style.fontFamily = e.target.value; })}>{families.map((f) => <option key={f}>{f}</option>)}</select></label>
              <label className="fld"><span>Weight (boldness)</span><select value={st.fontWeight ?? 400} aria-label="Font weight" onChange={(e) => set((x) => { x.style.fontWeight = Number(e.target.value); })}>{WEIGHTS.map(([w, name]) => <option key={w} value={w}>{name} · {w}</option>)}</select></label>
              <Num label="Size" value={st.fontSize ?? 32} min={4} max={800} onChange={(v) => set((x) => { x.style.fontSize = v; }, 'fs')} suffix="px" />
              <Num label="Letter spacing" value={st.letterSpacing ?? 0} min={-10} max={60} step={0.5} onChange={(v) => set((x) => { x.style.letterSpacing = v; }, 'ls')} suffix="px" />
              <Num label="Line height" value={st.lineHeight ?? 1.2} min={0.6} max={4} step={0.05} onChange={(v) => set((x) => { x.style.lineHeight = v; }, 'lh')} suffix="×" />
              <Num label="Padding" value={st.padding ?? 0} min={0} max={400} onChange={(v) => set((x) => { x.style.padding = v; }, 'pad')} suffix="px" />
            </div>
            <div className="muted small">Letter spacing = space between letters. Line height = space between lines. Padding = inner margin of the frame.</div>
            <div className="fld"><span>Style</span>
              <div className="seg" role="group" aria-label="Style">
                <button className={(st.fontWeight ?? 400) >= 600 ? 'on' : ''} aria-label="Bold" aria-pressed={(st.fontWeight ?? 400) >= 600} title="Bold (toggles weight 700 / 400)" onClick={() => set((x) => { x.style.fontWeight = (x.style.fontWeight ?? 400) >= 600 ? 400 : 700; })}><Bold size={14} /> Bold</button>
                <button className={st.fontStyle === 'italic' ? 'on' : ''} aria-label="Italic" aria-pressed={st.fontStyle === 'italic'} title="Italic" onClick={() => set((x) => { x.style.fontStyle = x.style.fontStyle === 'italic' ? 'normal' : 'italic'; })}><Italic size={14} /> Italic</button>
                <button className={st.decoration === 'underline' ? 'on' : ''} aria-label="Underline" aria-pressed={st.decoration === 'underline'} title="Underline" onClick={() => set((x) => { x.style.decoration = x.style.decoration === 'underline' ? 'none' : 'underline'; })}><Underline size={14} /></button>
                <button className={st.decoration === 'line-through' ? 'on' : ''} aria-label="Strikethrough" aria-pressed={st.decoration === 'line-through'} title="Strikethrough" onClick={() => set((x) => { x.style.decoration = x.style.decoration === 'line-through' ? 'none' : 'line-through'; })}><Strikethrough size={14} /></button>
              </div>
            </div>
            <div className="row wrap">
              <Seg label="Horizontal" value={st.textAlign ?? 'left'} onChange={(v) => set((x) => { x.style.textAlign = v; })} options={[{ value: 'left', label: <AlignLeft size={14} />, title: 'Align left' }, { value: 'center', label: <AlignCenter size={14} />, title: 'Align centre' }, { value: 'right', label: <AlignRight size={14} />, title: 'Align right' }]} />
              <Seg label="Vertical" value={st.verticalAlign ?? 'top'} onChange={(v) => set((x) => { x.style.verticalAlign = v; })} options={[{ value: 'top', label: <AlignStartHorizontal size={14} />, title: 'Align top' }, { value: 'middle', label: <AlignCenterHorizontal size={14} />, title: 'Align middle' }, { value: 'bottom', label: <AlignEndHorizontal size={14} />, title: 'Align bottom' }]} />
            </div>
            <ColorField label="Text colour" value={st.fill} palette={palette} onChange={(v) => set((x) => { x.style.fill = v; }, 'fill')} />
          </Section>
          <Section title="How much fits">
            <CapacityHint n={n} />
            <LiveFit ctrl={ctrl} n={n} />
            <div className="small muted">Change the limits on the <b>Fit</b> tab.</div>
          </Section>
          {layerSection}
        </>
      )}

      {isImg && (
        <Section title={n.type === 'frame' ? 'Image frame' : 'Image'}>
          <div className="row">
            {n.src?.assetId ? <AssetThumb id={n.src.assetId} size={48} className="lg" /> : <span className="muted small">No static image{n.type === 'frame' ? ' (design-time placeholder)' : ''}</span>}
            <button className="btn sm" onClick={() => setPicker(true)}><ImagePlus size={14} /> {n.src?.assetId ? 'Change' : 'Choose'}…</button>
            {n.src?.assetId && <button className="btn sm ghost" onClick={() => set((x) => { delete x.src; })}>Clear</button>}
          </div>
          <Num label="Corner radius" value={st.cornerRadius ?? 0} min={0} max={4000} onChange={(v) => set((x) => { x.style.cornerRadius = v; }, 'cr')} />
          <ColorField label="Border" value={st.stroke} allowNone palette={palette} onChange={(v) => set((x) => { x.style.stroke = v; if (v !== 'none' && !(x.style.strokeWidth ?? 0)) x.style.strokeWidth = 2; }, 'stroke')} />
          {picker && <AssetPicker current={n.src?.assetId} onPick={(id) => set((x) => { x.src = { assetId: id }; })} onClose={() => setPicker(false)} />}
        </Section>
      )}
      {n.type === 'plugin' && <PluginSection ctrl={ctrl} n={n} />}
      {n.type === 'group' && <Section title="Group"><div className="muted small">{(n.children ?? []).length} elements. Opacity and the visibility condition apply to the whole group. Ungroup with Ctrl+Shift+G to edit members.</div></Section>}
    </>
  );
}

function PluginSection({ ctrl, n }: { ctrl: EditorController; n: DceNode }) {
  const [text, setText] = useState(() => JSON.stringify(n.plugin ?? {}, null, 2));
  const [err, setErr] = useState('');
  const known = !!getPlugin(n.plugin?.name);
  return (
    <Section title="Render plugin">
      <div className="muted small">{known ? <>Plugin <b>{String(n.plugin?.name)}</b></> : <span style={{ color: 'var(--danger)' }}>Unknown plugin “{String(n.plugin?.name)}” — the element is skipped when rendering.</span>} Parameters may contain <code>{'{{content.field}}'}</code>.</div>
      <textarea className="mono" rows={7} aria-label="Plugin parameters (JSON)" value={text} onChange={(e) => {
        setText(e.target.value);
        try {
          const v = JSON.parse(e.target.value) as DceNode['plugin'];
          if (!v || typeof v !== 'object' || typeof v.name !== 'string') throw new Error('Needs an object with a "name".');
          setErr(''); ctrl.updateNode(n.id, (x) => { x.plugin = v; }, { coalesce: `${n.id}:plugin` });
        } catch (er) { setErr(er instanceof Error ? er.message : 'Invalid JSON'); }
      }} />
      {err && <div className="callout err" role="alert">{err}</div>}
    </Section>
  );
}

// ---------------------------------------------------------------- Data (bindings)
/** `{{content.title}}` becomes `content.title`; anything more complex becomes ''. */
function singleKey(tpl: string | undefined): string {
  const m = /^\s*\{\{\s*([A-Za-z_][\w.]*)\s*\}\}\s*$/.exec(tpl ?? '');
  return m ? m[1] : '';
}

function DataTab({ ctrl, n }: { ctrl: EditorController; n: DceNode }) {
  const opts = useFieldOptions(ctrl);
  const set = (fn: (x: DceNode) => void, co?: string) => ctrl.updateNode(n.id, fn, { coalesce: co ? `${n.id}:${co}` : undefined });
  const b = n.binding ?? {};
  const expr = b.visible?.expr ?? '';
  const exprErr = expr ? validateExpr(expr) : null;
  const imageOpts = opts.filter((o) => o.type === 'image' || o.type === 'text' || o.type === 'url');
  const [fallbackPicker, setFallbackPicker] = useState(false);
  const colorOpts = opts.filter((o) => o.type === 'text' || o.type === 'color');
  const isImg = n.type === 'image' || n.type === 'frame';
  const unbind = (k: 'text' | 'image' | 'fill' | 'visible') => set((x) => { if (x.binding) { delete x.binding[k]; if (!Object.keys(x.binding).length) delete x.binding; } });
  return (
    <>
      <div className="sect"><div className="callout">Bound elements show a <span className="bind-dot" /> and a dashed outline in the design view. Turn on <b>Data preview</b> in the toolbar to see real values.</div></div>
      {n.type === 'text' && (
        <Section title="Text from data">
          <FieldSelect label="Bound field" value={singleKey(b.text?.template)} options={opts} placeholder={b.text ? '— custom template (see below) —' : '— not bound: static text —'}
            onChange={(key) => set((x) => {
              if (!key) { if (x.binding) { delete x.binding.text; if (!Object.keys(x.binding).length) delete x.binding; } return; }
              x.binding = { ...(x.binding ?? {}), text: { template: `{{${key}}}`, fallback: x.binding?.text?.fallback } };
            })} />
          {b.text && <label className="fld"><span>Fallback when the value is missing</span><input aria-label="Text fallback" value={b.text.fallback ?? ''} onChange={(e) => set((x) => { if (x.binding?.text) x.binding.text.fallback = e.target.value; }, 'fb')} /></label>}
          <details open={!!b.text && !singleKey(b.text.template)}>
            <summary className="small" style={{ cursor: 'pointer' }}>Advanced: mix fixed text, several fields and filters</summary>
            <label className="fld" style={{ marginTop: 6 }}><span>Template, e.g. <code>Model {'{{content.title|upper}}'} — {'{{content.category}}'}</code></span>
              <textarea rows={2} aria-label="Binding template" value={b.text?.template ?? ''} placeholder="{{content.title}}" onChange={(e) => set((x) => { const v = e.target.value; if (!v) { if (x.binding) { delete x.binding.text; if (!Object.keys(x.binding).length) delete x.binding; } } else x.binding = { ...(x.binding ?? {}), text: { template: v, fallback: x.binding?.text?.fallback } }; }, 'tpl')} />
            </label>
            <div className="muted small">Filters: <code>|upper</code> <code>|lower</code> <code>|title</code> <code>|truncate:40</code> <code>|default:N/A</code> <code>|number:2</code> <code>|date</code></div>
          </details>
          {b.text && <button className="btn sm" onClick={() => unbind('text')}><Link2Off size={14} /> Remove binding (back to static text)</button>}
        </Section>
      )}
      {isImg && (
        <Section title="Image binding">
          <FieldSelect label="Image field" value={b.image?.key ?? ''} options={imageOpts} onChange={(key) => set((x) => { if (!key) { if (x.binding) { delete x.binding.image; if (!Object.keys(x.binding).length) delete x.binding; } } else x.binding = { ...(x.binding ?? {}), image: { key, fallback: x.binding?.image?.fallback } }; })} />
          {b.image && (
            <div className="fld"><span>Fallback image (used when the record has none)</span>
              <div className="row">{b.image.fallback ? <AssetThumb id={b.image.fallback} size={36} /> : <span className="muted small">None</span>}
                <button className="btn sm" onClick={() => setFallbackPicker(true)}>Choose…</button>
                {b.image.fallback && <button className="btn sm ghost" onClick={() => set((x) => { if (x.binding?.image) delete x.binding.image.fallback; })}>Clear</button>}
              </div>
              {fallbackPicker && <AssetPicker current={b.image.fallback} onPick={(id) => set((x) => { if (x.binding?.image) x.binding.image.fallback = id; })} onClose={() => setFallbackPicker(false)} />}
            </div>
          )}
          {b.image && <button className="btn sm" onClick={() => unbind('image')}><Link2Off size={14} /> Remove image binding</button>}
        </Section>
      )}
      {n.type !== 'group' && n.type !== 'image' && n.type !== 'frame' && (
        <Section title={n.type === 'text' ? 'Text colour binding' : 'Fill colour binding'}>
          <FieldSelect label="Colour field" value={b.fill?.key ?? ''} options={colorOpts} onChange={(key) => set((x) => { if (!key) { if (x.binding) { delete x.binding.fill; if (!Object.keys(x.binding).length) delete x.binding; } } else x.binding = { ...(x.binding ?? {}), fill: { key, fallback: x.binding?.fill?.fallback ?? x.style.fill } }; })} />
          {b.fill && <ColorField label="Fallback colour" value={b.fill.fallback} onChange={(v) => set((x) => { if (x.binding?.fill) x.binding.fill.fallback = v; }, 'ffb')} />}
          {b.fill && <button className="btn sm" onClick={() => unbind('fill')}><Link2Off size={14} /> Remove colour binding</button>}
        </Section>
      )}
      <Section title="Conditional visibility">
        <label className="fld"><span>Show only when… (safe expression)</span>
          <input aria-label="Visibility condition" value={expr} placeholder='exists(content.discount)' className="mono" onChange={(e) => set((x) => { const v = e.target.value; if (!v) { if (x.binding) { delete x.binding.visible; if (!Object.keys(x.binding).length) delete x.binding; } } else x.binding = { ...(x.binding ?? {}), visible: { expr: v } }; }, 'expr')} />
        </label>
        {exprErr && <div className="callout err" role="alert">{exprErr}</div>}
        <FieldSelect label="Quick: show when field exists" value="" options={opts.filter((o) => o.key.startsWith('content.'))} placeholder="Choose a field…" onChange={(key) => key && set((x) => { x.binding = { ...(x.binding ?? {}), visible: { expr: `exists(${key})` } }; })} />
        <div className="muted small">Examples: <code>exists(content.discount)</code>, <code>content.status == "Approved"</code>, <code>!empty(content.badge) &amp;&amp; content.price &gt; 100</code>. No code is ever executed.</div>
        {expr && <button className="btn sm" onClick={() => unbind('visible')}><Link2Off size={14} /> Remove condition</button>}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Fit (constraints)
const POLICIES: { value: OverflowPolicy; label: string; hint: string }[] = [
  { value: 'multiline', label: 'Multi-line', hint: 'Wrap inside the frame; never resize.' },
  { value: 'auto_shrink', label: 'Auto-shrink', hint: 'Reduce font size until it fits (down to the minimum).' },
  { value: 'truncate', label: 'Truncate', hint: 'Cut with an ellipsis (…).' },
  { value: 'expand', label: 'Expand', hint: 'Grow the frame downwards to fit.' },
  { value: 'hide', label: 'Hide', hint: 'Hide the element when empty or too long.' },
];

function FitTab({ ctrl, n }: { ctrl: EditorController; n: DceNode }) {
  const [picker, setPicker] = useState(false);
  const set = (fn: (c: NodeConstraints) => void, co?: string) => ctrl.updateNode(n.id, (x) => { x.constraints = { ...(x.constraints ?? {}) }; fn(x.constraints); }, { coalesce: co ? `${n.id}:${co}` : undefined });
  const c = n.constraints ?? {};
  if (n.type === 'text') {
    const policy = c.overflow ?? 'multiline';
    return (
      <>
        <Section title="How much fits"><CapacityHint n={n} /><LiveFit ctrl={ctrl} n={n} /></Section>
        <Section title="Dynamic text constraints">
          <label className="fld"><span>Overflow policy</span>
            <select aria-label="Overflow policy" value={policy} onChange={(e) => set((x) => { x.overflow = e.target.value as OverflowPolicy; })}>{POLICIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
          </label>
          <div className="muted small">{POLICIES.find((p) => p.value === policy)?.hint}</div>
          <div className="grid2">
            <Num label="Max characters" value={c.maxChars} min={0} onChange={(v) => set((x) => { x.maxChars = v || undefined; }, 'mc')} />
            <Num label="Max lines" value={c.maxLines} min={0} onChange={(v) => set((x) => { x.maxLines = v || undefined; }, 'ml')} />
            <Num label="Min font size" value={c.minFontSize} min={0} onChange={(v) => set((x) => { x.minFontSize = v || undefined; }, 'mnf')} suffix="px" />
            <Num label="Max font size" value={c.maxFontSize} min={0} onChange={(v) => set((x) => { x.maxFontSize = v || undefined; }, 'mxf')} suffix="px" />
            {policy === 'expand' && <Num label="Max frame height" value={c.maxExpandHeight} min={0} onChange={(v) => set((x) => { x.maxExpandHeight = v || undefined; }, 'meh')} suffix="px" />}
          </div>
          <label className="fld"><span>Fallback text (when empty)</span><input aria-label="Fallback text" value={c.fallbackText ?? ''} onChange={(e) => set((x) => { x.fallbackText = e.target.value || undefined; }, 'ft')} /></label>
          <div className="muted small">Auto-shrink starts at <b>max font size</b> (or the size above if empty) and never goes below <b>min font size</b>. Empty numbers mean “no limit”.</div>
        </Section>
      </>
    );
  }
  if (n.type === 'image' || n.type === 'frame') {
    return (
      <Section title="Image constraints">
        <Seg label="Fit" value={c.fit ?? 'cover'} onChange={(v) => set((x) => { x.fit = v; })} options={[{ value: 'cover', label: 'Cover', title: 'Cover (crop to fill)' }, { value: 'contain', label: 'Contain', title: 'Contain (letterbox)' }, { value: 'fill', label: 'Fill', title: 'Fill (stretch)' }, { value: 'crop', label: 'Crop', title: 'Centre crop at natural size' }]} />
        <div className="grid2">
          <Num label="Focal point X" value={Math.round((c.focalX ?? 0.5) * 100)} min={0} max={100} suffix="%" onChange={(v) => set((x) => { x.focalX = v / 100; }, 'fx')} />
          <Num label="Focal point Y" value={Math.round((c.focalY ?? 0.5) * 100)} min={0} max={100} suffix="%" onChange={(v) => set((x) => { x.focalY = v / 100; }, 'fy')} />
        </div>
        <label className="fld"><span>When the image is missing</span>
          <select aria-label="Missing image behaviour" value={c.missing ?? (n.type === 'frame' ? 'placeholder' : 'hide')} onChange={(e) => set((x) => { x.missing = e.target.value as NodeConstraints['missing']; })}>
            <option value="hide">Hide the element</option><option value="placeholder">Show a neutral placeholder</option><option value="error">Fail the record (error)</option>
          </select>
        </label>
        <div className="fld"><span>Fallback image</span>
          <div className="row">{c.fallbackAssetId ? <AssetThumb id={c.fallbackAssetId} size={36} /> : <span className="muted small">None</span>}
            <button className="btn sm" onClick={() => setPicker(true)}>Choose…</button>
            {c.fallbackAssetId && <button className="btn sm ghost" onClick={() => set((x) => { delete x.fallbackAssetId; })}>Clear</button>}
          </div>
          {picker && <AssetPicker current={c.fallbackAssetId} onPick={(id) => set((x) => { x.fallbackAssetId = id; })} onClose={() => setPicker(false)} />}
        </div>
      </Section>
    );
  }
  return <div className="sect muted">Constraints apply to text and image elements.</div>;
}

// ---------------------------------------------------------------- Template (canvas + placeholders)
const PRESETS = [[1080, 1080], [1080, 1350], [1080, 1920], [1920, 1080], [1200, 630], [1500, 500]];

function TemplateTab({ ctrl }: { ctrl: EditorController }) {
  const doc = useStore(ctrl.store, (s) => s.doc);
  const [w, setW] = useState(doc.canvas.width), [h, setH] = useState(doc.canvas.height);
  const setPh = (key: string, fn: (p: Placeholder) => void) => ctrl.commit((d) => { const p = d.placeholders.find((x) => x.key === key); if (p) fn(p); }, { coalesce: `ph:${key}` });
  const addVar = () => {
    let i = 1; while (doc.placeholders.some((p) => p.key === `template.variable_${i}`)) i++;
    ctrl.commit((d) => { d.placeholders.push({ key: `template.variable_${i}`, type: 'color', label: `Variable ${i}`, required: false, default_value: '#4570B6' }); });
  };
  return (
    <>
      <Section title="Canvas">
        <div className="row wrap">{PRESETS.map(([pw, ph]) => <button key={`${pw}x${ph}`} className={`btn sm ${doc.canvas.width === pw && doc.canvas.height === ph ? 'primary' : ''}`} onClick={() => { setW(pw); setH(ph); ctrl.setCanvas({ width: pw, height: ph }); }}>{pw}×{ph}</button>)}</div>
        <div className="grid2">
          <Num label="Width" value={w} min={16} max={8192} suffix="px" onChange={setW} />
          <Num label="Height" value={h} min={16} max={8192} suffix="px" onChange={setH} />
        </div>
        <div className="row"><button className="btn sm" disabled={w === doc.canvas.width && h === doc.canvas.height} onClick={() => ctrl.setCanvas({ width: Math.round(w), height: Math.round(h) })}>Apply size</button><span className="muted small">Existing elements keep their position.</span></div>
        <ColorField label="Background" value={doc.canvas.background} allowNone palette={doc.constraints.palette} onChange={(v) => ctrl.setCanvas({ background: v })} />
        <Num label="Snap grid" value={doc.constraints.snapGrid ?? 10} min={0} max={200} suffix="px" onChange={(v) => ctrl.commit((d) => { d.constraints.snapGrid = v; }, { coalesce: 'grid' })} />
      </Section>
      <Section title="Brand palette">
        <div className="swatches">
          {(doc.constraints.palette ?? []).map((c, i) => <button key={c + i} style={{ background: c }} title={`${c} — click to remove`} aria-label={`Remove ${c}`} onClick={() => ctrl.commit((d) => { d.constraints.palette = (d.constraints.palette ?? []).filter((_, j) => j !== i); })} />)}
          <input type="color" aria-label="Add palette colour" style={{ width: 24, height: 22 }} onChange={(e) => ctrl.commit((d) => { d.constraints.palette = [...new Set([...(d.constraints.palette ?? []), e.target.value.toUpperCase()])]; })} />
        </div>
      </Section>
      <Section title={`Placeholders (${doc.placeholders.length})`}>
        <div className="muted small">Every field your bindings use. Set labels, defaults and validation; “Required” makes a record fail instead of rendering a blank.</div>
        <div className="row"><button className="btn sm" onClick={() => ctrl.syncPlaceholdersNow()}>Sync from bindings</button><button className="btn sm" onClick={addVar}><Plus size={13} /> Template variable</button></div>
        {doc.placeholders.map((p) => (
          <div key={p.key} className="panel" style={{ padding: 8 }}>
            <div className="row"><code className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.key}</code>
              <IconBtn icon={<X size={14} />} label={`Remove placeholder ${p.key}`} onClick={() => ctrl.commit((d) => { d.placeholders = d.placeholders.filter((x) => x.key !== p.key); })} /></div>
            <div className="grid2" style={{ marginTop: 6 }}>
              <label className="fld"><span>Label</span><input value={p.label} aria-label={`${p.key} label`} onChange={(e) => setPh(p.key, (x) => { x.label = e.target.value; })} /></label>
              <label className="fld"><span>Type</span><select value={p.type} aria-label={`${p.key} type`} onChange={(e) => setPh(p.key, (x) => { x.type = e.target.value as PlaceholderType; })}>{['text', 'image', 'color', 'boolean', 'number', 'date'].map((t) => <option key={t}>{t}</option>)}</select></label>
              <label className="fld"><span>Default value</span><input value={p.default_value ?? ''} aria-label={`${p.key} default`} onChange={(e) => setPh(p.key, (x) => { x.default_value = e.target.value || undefined; })} /></label>
              <Num label="Max length" value={p.max_length} min={0} onChange={(v) => setPh(p.key, (x) => { x.max_length = v || undefined; })} />
            </div>
            <label className="chk small" style={{ marginTop: 6 }}><input type="checkbox" checked={p.required} onChange={(e) => setPh(p.key, (x) => { x.required = e.target.checked; })} /> Required</label>
          </div>
        ))}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- arrange (alignment)
export function ArrangeBar({ ctrl }: { ctrl: EditorController }) {
  const sel = useStore(ctrl.store, (s) => s.selection);
  const dis = sel.length === 0;
  const B = (icon: React.ReactNode, label: string, fn: () => void, d = dis) => <IconBtn key={label} icon={icon} label={label} onClick={fn} disabled={d} />;
  return (
    <div className="row wrap" style={{ gap: 0, padding: '6px 8px', borderBottom: '1px solid var(--line)' }} role="toolbar" aria-label="Align and distribute">
      {B(<AlignStartVertical size={15} />, 'Align left', () => ctrl.align('left'))}
      {B(<AlignCenterVertical size={15} />, 'Align horizontal centre', () => ctrl.align('center'))}
      {B(<AlignEndVertical size={15} />, 'Align right', () => ctrl.align('right'))}
      {B(<AlignStartHorizontal size={15} />, 'Align top', () => ctrl.align('top'))}
      {B(<AlignCenterHorizontal size={15} />, 'Align vertical middle', () => ctrl.align('middle'))}
      {B(<AlignEndHorizontal size={15} />, 'Align bottom', () => ctrl.align('bottom'))}
      {B(<AlignHorizontalSpaceBetween size={15} />, 'Distribute horizontally', () => ctrl.distribute('h'), sel.length < 3)}
      {B(<AlignVerticalSpaceBetween size={15} />, 'Distribute vertically', () => ctrl.distribute('v'), sel.length < 3)}
    </div>
  );
}

export function Inspector({ ctrl }: { ctrl: EditorController }) {
  const sel = useStore(ctrl.store, (s) => s.selection);
  const doc = useStore(ctrl.store, (s) => s.doc);
  const [tab, setTab] = useState<Tab>('design');
  const top = useMemo(() => {
    if (sel.length === 0) return null;
    const g = sel.length > 1 ? null : null;
    void g;
    const nodes = doc.nodes;
    // a fully selected group is inspected as the group
    const grp = nodes.find((n) => n.type === 'group' && sel.length > 0 && (n.children ?? []).length > 0 && collect(n).length === sel.length && collect(n).every((id) => sel.includes(id)));
    if (grp) return grp;
    if (sel.length === 1) return ctrl.getNode(sel[0]);
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, doc]);
  const effective: Tab = !top && tab !== 'template' ? 'design' : tab;
  return (
    <div className="ed-inspector" aria-label="Inspector">
      <ArrangeBar ctrl={ctrl} />
      <Tabs tabs={[{ id: 'design', label: 'Design' }, { id: 'data', label: 'Data' }, { id: 'fit', label: 'Fit' }, { id: 'template', label: 'Template' }]} value={effective} onChange={setTab} />
      {effective === 'template' ? <TemplateTab ctrl={ctrl} /> : !top ? (
        <div className="sect muted">{sel.length > 1 ? `${sel.length} elements selected. Use the align and distribute buttons above, or group them with Ctrl+G.` : 'Select an element to edit it, or draw one with the tools on the left. The Template tab holds canvas size, background and placeholders.'}</div>
      ) : effective === 'design' ? <DesignTab ctrl={ctrl} n={top} key={top.id} onGoto={setTab} />
        : effective === 'data' ? <DataTab ctrl={ctrl} n={top} key={top.id} /> : <FitTab ctrl={ctrl} n={top} key={top.id} />}
    </div>
  );
}

function collect(n: DceNode): string[] { return n.type === 'group' ? (n.children ?? []).flatMap(collect) : [n.id]; }
