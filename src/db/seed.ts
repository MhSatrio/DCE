import { slugify } from '../engine/binding';
import { makeNode, newDoc, syncPlaceholders, uid } from '../engine/njs';
import type { DceNode, NjsDoc } from '../engine/types';
import { STATUSES } from './fields';
import { loadRecords, newRecord, saveTemplate, storeAssetBlob } from './repo';
import { db, getSetting, setSetting, type BatchConfig, type ContentRecord, type FieldDef } from './schema';

type C = OffscreenCanvasRenderingContext2D;

const PALETTE = { brand: '#4570B6', sky: '#CAEBFB', ink: '#231F20', white: '#FFFFFF', mid: '#8FB0DB', pale: '#E8F4FB' };

function rr(c: C, x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string, lw = 0): void {
  c.beginPath(); c.roundRect(x, y, w, h, r);
  c.fillStyle = fill; c.fill();
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.stroke(); }
}
function circ(c: C, x: number, y: number, r: number, fill: string, stroke?: string, lw = 0): void {
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
  c.fillStyle = fill; c.fill();
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.stroke(); }
}

const DRAW: Record<string, (c: C) => void> = {
  centrifuge(c) {
    rr(c, 170, 360, 460, 270, 36, PALETTE.brand);
    c.beginPath(); c.ellipse(400, 360, 230, 70, 0, 0, Math.PI * 2); c.fillStyle = PALETTE.mid; c.fill();
    c.beginPath(); c.ellipse(400, 352, 190, 48, 0, 0, Math.PI * 2); c.fillStyle = PALETTE.ink; c.fill();
    circ(c, 400, 352, 14, PALETTE.sky);
    rr(c, 230, 530, 150, 56, 10, PALETTE.ink); rr(c, 244, 544, 70, 28, 4, PALETTE.sky);
    circ(c, 470, 558, 18, PALETTE.sky); circ(c, 530, 558, 18, PALETTE.white);
    rr(c, 150, 630, 500, 30, 10, PALETTE.ink);
  },
  balance(c) {
    rr(c, 160, 560, 480, 80, 18, PALETTE.ink);
    rr(c, 190, 590, 160, 30, 6, PALETTE.sky);
    rr(c, 230, 250, 340, 310, 12, 'rgba(202,235,251,0.55)', PALETTE.brand, 6);
    rr(c, 290, 470, 220, 18, 8, PALETTE.brand);
    circ(c, 400, 445, 34, PALETTE.mid);
    rr(c, 392, 488, 16, 72, 4, PALETTE.ink);
    circ(c, 560, 600, 14, PALETTE.brand);
  },
  evaporator(c) {
    c.strokeStyle = PALETTE.ink; c.lineWidth = 16; c.lineCap = 'round';
    c.beginPath(); c.moveTo(330, 280); c.lineTo(520, 400); c.stroke();
    c.strokeStyle = PALETTE.brand; c.lineWidth = 36;
    c.beginPath(); c.moveTo(420, 300); c.lineTo(560, 400); c.stroke();
    circ(c, 250, 420, 100, 'rgba(202,235,251,0.8)', PALETTE.brand, 8);
    circ(c, 640, 430, 70, 'rgba(202,235,251,0.8)', PALETTE.brand, 8);
    rr(c, 160, 560, 400, 110, 30, PALETTE.ink);
    c.beginPath(); c.ellipse(360, 560, 200, 26, 0, 0, Math.PI * 2); c.fillStyle = PALETTE.mid; c.fill();
    rr(c, 600, 250, 30, 190, 8, PALETTE.ink);
  },
  incubator(c) {
    rr(c, 190, 220, 420, 440, 26, PALETTE.brand);
    rr(c, 220, 250, 360, 330, 14, PALETTE.pale, PALETTE.ink, 8);
    for (const y of [330, 410, 490]) rr(c, 236, y, 328, 10, 4, PALETTE.mid);
    rr(c, 548, 360, 14, 120, 7, PALETTE.ink);
    rr(c, 250, 600, 130, 38, 8, PALETTE.ink); rr(c, 262, 610, 70, 18, 3, PALETTE.sky);
    circ(c, 470, 619, 14, PALETTE.sky); circ(c, 520, 619, 14, PALETTE.white);
    rr(c, 220, 660, 60, 26, 6, PALETTE.ink); rr(c, 520, 660, 60, 26, 6, PALETTE.ink);
  },
  pipette(c) {
    c.save(); c.translate(400, 400); c.rotate(-0.38);
    rr(c, -50, -300, 100, 70, 18, PALETTE.ink);          // plunger
    rr(c, -34, -240, 68, 130, 12, PALETTE.mid);
    rr(c, -62, -120, 124, 360, 46, PALETTE.brand);       // body
    rr(c, -34, -70, 68, 90, 8, PALETTE.sky);             // display
    rr(c, -62, 220, 124, 36, 6, PALETTE.ink);
    c.beginPath(); c.moveTo(-26, 256); c.lineTo(26, 256); c.lineTo(5, 380); c.lineTo(-5, 380); c.closePath();
    c.fillStyle = PALETTE.pale; c.fill(); c.strokeStyle = PALETTE.ink; c.lineWidth = 5; c.stroke();
    c.restore();
  },
  stirrer(c) {
    rr(c, 170, 560, 460, 90, 22, PALETTE.ink);
    c.beginPath(); c.ellipse(400, 560, 230, 38, 0, 0, Math.PI * 2); c.fillStyle = PALETTE.brand; c.fill();
    circ(c, 250, 610, 14, PALETTE.sky); circ(c, 560, 610, 14, PALETTE.white);
    c.beginPath(); c.moveTo(280, 250); c.lineTo(520, 250); c.lineTo(500, 530); c.lineTo(300, 530); c.closePath();
    c.fillStyle = 'rgba(202,235,251,0.75)'; c.fill(); c.strokeStyle = PALETTE.ink; c.lineWidth = 8; c.stroke();
    c.beginPath(); c.moveTo(293, 380); c.lineTo(507, 380); c.lineTo(500, 530); c.lineTo(300, 530); c.closePath();
    c.fillStyle = PALETTE.mid; c.globalAlpha = 0.6; c.fill(); c.globalAlpha = 1;
    rr(c, 350, 500, 100, 20, 10, PALETTE.ink);
  },
};

async function drawProduct(kind: string, accent: string): Promise<Blob> {
  const c = new OffscreenCanvas(800, 800);
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(400, 380, 60, 400, 400, 420);
  g.addColorStop(0, '#FFFFFF'); g.addColorStop(1, PALETTE.sky);
  ctx.fillStyle = g; ctx.fillRect(0, 0, 800, 800);
  circ(ctx, 400, 420, 300, 'rgba(255,255,255,0.7)');
  ctx.fillStyle = 'rgba(35,31,32,0.08)'; ctx.beginPath(); ctx.ellipse(400, 690, 260, 22, 0, 0, Math.PI * 2); ctx.fill();
  DRAW[kind](ctx);
  rr(ctx, 40, 40, 14, 120, 7, accent);
  return c.convertToBlob({ type: 'image/png' });
}

export const SAMPLE_FIELDS: FieldDef[] = [
  { id: 'sample_category', key: 'category', label: 'Category', type: 'select', options: ['Separation', 'Weighing', 'Evaporation', 'Incubation', 'Liquid handling', 'Mixing'], order: 10 },
  { id: 'sample_description', key: 'description', label: 'Description', type: 'longtext', order: 11 },
  { id: 'sample_accent', key: 'accent_color', label: 'Accent Color', type: 'text', order: 12 },
  { id: 'sample_discount', key: 'discount', label: 'Discount', type: 'text', order: 13 },
  { id: 'sample_specs', key: 'specs', label: 'Highlights', type: 'text', order: 14 },
  { id: 'sample_cta', key: 'cta', label: 'CTA', type: 'text', order: 15 },
];

interface Product { kind: string; title: string; category: string; description: string; accent: string; discount: string; specs: string; status: string; date: string; tags: string[] }

const PRODUCTS: Product[] = [
  { kind: 'centrifuge', title: 'Laboratory Centrifuge', category: 'Separation', accent: '#4570B6', discount: '-15%', status: 'Approved', date: '2026-11-10', tags: ['benchtop', 'sample prep'],
    description: 'Benchtop centrifuge for routine sample preparation. Variable speed, programmable run time and imbalance detection keep everyday separations simple and repeatable.',
    specs: 'Variable speed  •  Digital timer  •  Imbalance detection' },
  { kind: 'balance', title: 'Analytical Balance', category: 'Weighing', accent: '#231F20', discount: '', status: 'Approved', date: '2026-11-12', tags: ['precision', 'weighing'],
    description: 'Draft-shielded analytical balance for accurate sample and reagent weighing, with a clear backlit display and simple one-key tare.',
    specs: 'Draft shield  •  One-key tare  •  Backlit display' },
  { kind: 'evaporator', title: 'Rotary Evaporator', category: 'Evaporation', accent: '#4570B6', discount: '-10%', status: 'Approved', date: '2026-11-15', tags: ['solvent', 'distillation'],
    description: 'Rotary evaporator for gentle solvent removal under reduced pressure. Heated water bath, adjustable rotation and a vertical condenser for efficient recovery.',
    specs: 'Heated bath  •  Adjustable rotation  •  Vertical condenser' },
  { kind: 'incubator', title: 'Laboratory Incubator', category: 'Incubation', accent: '#365A97', discount: '', status: 'Draft', date: '2026-11-18', tags: ['culture', 'temperature'],
    description: 'Forced-convection laboratory incubator with a stable, evenly distributed temperature for cell, microbial and general culture work.',
    specs: 'Even temperature  •  Adjustable shelves  •  Glass inner door' },
  { kind: 'pipette', title: 'Micropipette', category: 'Liquid handling', accent: '#4570B6', discount: '-5%', status: 'Approved', date: '2026-11-20', tags: ['pipetting', 'accuracy'],
    description: 'Adjustable-volume micropipette with a light plunger action and a clear volume display, designed for comfortable, repeatable liquid handling.',
    specs: 'Adjustable volume  •  Light plunger  •  Autoclavable tip cone' },
  { kind: 'stirrer', title: 'Magnetic Stirrer', category: 'Mixing', accent: '#231F20', discount: '', status: 'In review', date: '2026-11-24', tags: ['mixing', 'hotplate'],
    description: 'Compact magnetic stirrer with hotplate for mixing and gentle heating of solutions. Stable speed control and a chemical-resistant top plate.',
    specs: 'Hotplate  •  Stable speed control  •  Chemical-resistant plate' },
];

function T(type: DceNode['type'], over: Partial<DceNode>): DceNode { return makeNode(type, over); }

export function buildSampleDoc(logoAssetId: string, fallbackId: string): NjsDoc {
  const doc = newDoc('Product Announcement', 1080, 1080, '#FFFFFF');
  doc.meta.description = 'Sample 1080 × 1080 product announcement bound to the Content Plan fields.';
  const card = (over: Partial<DceNode>) => T('rect', over);
  const bandTop = card({ name: 'Header band', x: 0, y: 0, width: 1080, height: 128, style: { fill: '#CAEBFB' } });
  const bandBind = card({ name: 'Brand strip', x: 0, y: 120, width: 1080, height: 8, style: { fill: '#4570B6' }, binding: { fill: { key: 'template.primary_color', fallback: '#4570B6' } } });
  const logo = T('image', { name: 'VierApparatus icon', x: 56, y: 36, width: 56, height: 56, src: { assetId: logoAssetId }, constraints: { fit: 'contain', missing: 'hide' } });
  const brand = T('text', { name: 'Brand name', x: 126, y: 40, width: 400, height: 48, text: 'VierApparatus', style: { fontSize: 34, fontWeight: 600, fill: '#231F20', verticalAlign: 'middle' } });
  const chipBg = T('rect', { name: 'Category chip', x: 56, y: 172, width: 260, height: 40, style: { fill: '#4570B6', cornerRadius: 20 }, binding: { fill: { key: 'content.accent_color', fallback: '#4570B6' } } });
  const chipTx = T('text', {
    name: 'Category', x: 56, y: 172, width: 260, height: 40, text: 'CATEGORY',
    style: { fontSize: 18, fontWeight: 600, fill: '#FFFFFF', textAlign: 'center', verticalAlign: 'middle', letterSpacing: 2 },
    binding: { text: { template: '{{content.category|upper}}', fallback: 'LABORATORY' } },
    constraints: { overflow: 'auto_shrink', minFontSize: 12, maxLines: 1 },
  });
  const title = T('text', {
    name: 'Title', x: 56, y: 236, width: 440, height: 190, text: 'Product name',
    style: { fontSize: 64, fontWeight: 600, fill: '#231F20', lineHeight: 1.08, verticalAlign: 'top' },
    binding: { text: { template: '{{content.title}}', fallback: 'Product name' } },
    constraints: { overflow: 'auto_shrink', minFontSize: 28, maxLines: 3, maxChars: 60 },
  });
  const rule = card({ name: 'Accent rule', x: 56, y: 442, width: 96, height: 8, style: { fill: '#4570B6', cornerRadius: 4 }, binding: { fill: { key: 'content.accent_color', fallback: '#4570B6' } } });
  const desc = T('text', {
    name: 'Description', x: 56, y: 470, width: 440, height: 230, text: 'Short scientific description of the product.',
    style: { fontSize: 26, fontWeight: 400, fill: '#231F20', lineHeight: 1.4 },
    binding: { text: { template: '{{content.description}}', fallback: 'Description coming soon.' } },
    constraints: { overflow: 'auto_shrink', minFontSize: 16, maxLines: 8, maxChars: 260 },
  });
  const imgBg = card({ name: 'Image backdrop', x: 536, y: 172, width: 488, height: 528, style: { fill: '#CAEBFB', cornerRadius: 28 } });
  const frame = T('frame', {
    name: 'Product image', x: 544, y: 180, width: 472, height: 512, style: { cornerRadius: 22 },
    binding: { image: { key: 'content.image_asset', fallback: fallbackId } },
    constraints: { fit: 'cover', focalX: 0.5, focalY: 0.5, missing: 'placeholder', fallbackAssetId: fallbackId },
  });
  const star = T('star', { name: 'Badge star', x: 868, y: 140, width: 190, height: 190, points: 12, innerRatio: 0.82, style: { fill: '#231F20' } });
  const badgeTx = T('text', {
    name: 'Discount', x: 878, y: 200, width: 170, height: 70, text: '-10%',
    style: { fontSize: 44, fontWeight: 700, fill: '#FFFFFF', textAlign: 'center', verticalAlign: 'middle' },
    binding: { text: { template: '{{content.discount}}', fallback: '' } },
    constraints: { overflow: 'auto_shrink', minFontSize: 20, maxLines: 1 },
  });
  const badge = T('group', { name: 'Discount badge', children: [star, badgeTx], x: 868, y: 140, width: 190, height: 190, binding: { visible: { expr: 'exists(content.discount)' } } });
  const strip = card({ name: 'Highlights panel', x: 56, y: 744, width: 968, height: 150, style: { fill: '#F6F8FA', stroke: '#D3DCE8', strokeWidth: 2, cornerRadius: 20 } });
  const hlLabel = T('text', { name: 'Highlights label', x: 90, y: 768, width: 300, height: 26, text: 'HIGHLIGHTS', style: { fontSize: 16, fontWeight: 600, fill: '#4570B6', letterSpacing: 3 } });
  const hl = T('text', {
    name: 'Highlights', x: 90, y: 800, width: 900, height: 70, text: 'Highlight  •  Highlight  •  Highlight',
    style: { fontSize: 30, fontWeight: 500, fill: '#231F20', verticalAlign: 'top' },
    binding: { text: { template: '{{content.specs}}', fallback: '' } },
    constraints: { overflow: 'auto_shrink', minFontSize: 18, maxLines: 2 },
  });
  const footer = card({ name: 'Footer band', x: 0, y: 936, width: 1080, height: 144, style: { fill: '#231F20' } });
  const cta = T('text', {
    name: 'CTA', x: 56, y: 962, width: 620, height: 92, text: 'Request a quote',
    style: { fontSize: 40, fontWeight: 600, fill: '#FFFFFF', verticalAlign: 'middle' },
    binding: { text: { template: '{{content.cta|default:Request a quote}}', fallback: 'Request a quote' } },
    constraints: { overflow: 'auto_shrink', minFontSize: 22, maxLines: 2 },
  });
  const contact = T('text', { name: 'Contact', x: 700, y: 962, width: 324, height: 92, text: 'Contact VierApparatus', style: { fontSize: 24, fontWeight: 500, fill: '#CAEBFB', textAlign: 'right', verticalAlign: 'middle' } });
  doc.nodes = [bandTop, bandBind, logo, brand, chipBg, chipTx, title, rule, desc, imgBg, frame, badge, strip, hlLabel, hl, footer, cta, contact];
  doc.nodes.forEach((n, i) => (n.layer = i));
  doc.placeholders = syncPlaceholders(doc).map((p) => {
    const set = (over: Partial<typeof p>) => Object.assign(p, over);
    switch (p.key) {
      case 'content.title': set({ label: 'Product Title', required: true, type: 'text', max_length: 60, overflow_strategy: 'auto_shrink', min_font_size: 28 }); break;
      case 'content.description': set({ label: 'Scientific Description', type: 'text', max_length: 260, default_value: '' }); break;
      case 'content.category': set({ label: 'Category', type: 'text' }); break;
      case 'content.image_asset': set({ label: 'Product Image', type: 'image', required: false }); break;
      case 'content.accent_color': set({ label: 'Accent Colour', type: 'color', default_value: '#4570B6' }); break;
      case 'content.discount': set({ label: 'Discount', type: 'text' }); break;
      case 'content.specs': set({ label: 'Highlights', type: 'text' }); break;
      case 'content.cta': set({ label: 'Call to action', type: 'text', default_value: 'Request a quote' }); break;
      case 'template.primary_color': set({ label: 'Primary colour', type: 'color', default_value: '#4570B6' }); break;
    }
    return p;
  });
  return doc;
}

export const SAMPLE_TEMPLATE_NAME = 'Product Announcement';

export function defaultBatchConfig(templateId = ''): BatchConfig {
  return {
    templateId, database: 'content_plan', selection: 'filtered',
    filter: { join: 'and', conditions: [{ id: uid(), field: 'status', op: 'eq', value: 'Approved' }] },
    format: 'png', pdfMode: 'separate', outW: 1080, outH: 1080, quality: 0.92, transparent: false,
    filenamePattern: '{{content.slug}}.png', includeManifest: true, concurrency: 0,
  };
}

export async function seedSampleData(): Promise<void> {
  const created: string[] = [];
  const assetIds: string[] = [];
  const icon = await (await fetch('/icon.svg')).blob();
  const logo = await storeAssetBlob(new Blob([await icon.text()], { type: 'image/svg+xml' }), 'VierApparatus icon.svg', { category: 'Brand', tags: ['logo', 'brand'], sample: true });
  created.push(logo.id);
  const word = await (await fetch('/brand/vier-black.svg')).text();
  await storeAssetBlob(new Blob([word], { type: 'image/svg+xml' }), 'VierApparatus wordmark.svg', { category: 'Brand', tags: ['logo', 'wordmark'], sample: true });
  for (const p of PRODUCTS) {
    const blob = await drawProduct(p.kind, p.accent);
    const a = await storeAssetBlob(blob, `${slugify(p.title)}.png`, { category: 'Product illustrations', tags: ['sample', p.category.toLowerCase()], sample: true });
    assetIds.push(a.id);
  }
  const fallback = assetIds[0];
  await db.fields.bulkPut(SAMPLE_FIELDS);
  const now = Date.now();
  const recs: ContentRecord[] = PRODUCTS.map((p, i) => newRecord({
    title: p.title, status: p.status, publish_date: p.date, image_asset: assetIds[i], tags: p.tags,
    content: `# ${p.title}\n\n${p.description}\n\n- Category: **${p.category}**\n- ${p.specs.split('  •  ').join('\n- ')}\n\n_Fictional catalogue entry used for demonstration._`,
    created_at: now + i, updated_at: now + i, sample: true,
    data: { category: p.category, description: p.description, accent_color: p.accent, discount: p.discount, specs: p.specs, cta: 'Request a quote' },
  }));
  const doc = buildSampleDoc(logo.id, fallback);
  const tpl = await saveTemplate(doc, { description: doc.meta.description });
  if (tpl) await db.templates.update(tpl.id, { sample: true });
  for (const r of recs) r.template_ref = tpl?.id ?? '';
  await db.records.bulkPut(recs);
  await setSetting('batch.config', defaultBatchConfig(tpl?.id ?? ''));
  await setSetting('seeded', true);
  await loadRecords();
}

export async function ensureSeeded(): Promise<void> {
  if (await getSetting('seeded', false)) return;
  if ((await db.records.count()) > 0 || (await db.templates.count()) > 0) { await setSetting('seeded', true); return; }
  await seedSampleData();
}

/** Synthetic records for load tests and demos — clearly marked as sample. */
export async function generateDemoRecords(n: number): Promise<number> {
  const assets = (await db.assets.filter((a) => a.category === 'Product illustrations').toArray()).map((a) => a.id);
  const tpl = await db.templates.filter((t) => !!t.sample).first();
  const out: ContentRecord[] = [];
  const base = Date.now();
  const adj = ['Compact', 'Advanced', 'Digital', 'Heavy-duty', 'Portable', 'Precision', 'Programmable', 'Dual-channel'];
  for (let i = 0; i < n; i++) {
    const p = PRODUCTS[i % PRODUCTS.length];
    const title = `${adj[(i >> 3) % adj.length]} ${p.title} ${100 + i}`;
    out.push(newRecord({
      title, slug: `${slugify(title)}`, status: STATUSES[i % STATUSES.length], publish_date: `2026-${String(11 + (i % 2)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
      image_asset: assets[i % PRODUCTS.length] ?? '', template_ref: tpl?.id ?? '', tags: [...p.tags], created_at: base + i, updated_at: base + i, sample: true,
      content: `# ${title}\n\n${p.description}`,
      data: { category: p.category, description: p.description, accent_color: p.accent, discount: i % 3 === 0 ? `-${5 + (i % 4) * 5}%` : '', specs: p.specs, cta: 'Request a quote' },
    }));
  }
  for (let i = 0; i < out.length; i += 1000) await db.records.bulkPut(out.slice(i, i + 1000));
  if (!(await db.fields.get('sample_category'))) await db.fields.bulkPut(SAMPLE_FIELDS);
  await loadRecords();
  return out.length;
}
