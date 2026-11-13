import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

export const OUT = fileURLToPath(new URL('./out/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const results = [];
export function report() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(`  ✗ ${f.name}\n      ${f.detail}`);
  return failed.length;
}

export async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, detail: e instanceof Error ? e.message.split('\n')[0] : String(e) });
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message.split('\n').slice(0, 3).join('\n      ') : e}`);
  }
}

export function eq(a, b, msg = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
export function ok(cond, msg) { if (!cond) throw new Error(msg); }
export function near(a, b, tol, msg = '') { if (Math.abs(a - b) > tol) throw new Error(`${msg} expected ≈${b} (±${tol}), got ${a}`); }

/** Reads a whole object store straight from IndexedDB (independent of the app code). */
export async function dump(page, store) {
  return page.evaluate((st) => new Promise((resolve, reject) => {
    const req = indexedDB.open('dce');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(st, 'readonly');
      const all = tx.objectStore(st).getAll();
      all.onsuccess = () => {
        const rows = all.result.map((r) => { const c = { ...r }; for (const k of Object.keys(c)) if (c[k] instanceof Blob) c[k] = `[blob ${c[k].size}]`; return c; });
        db.close(); resolve(rows);
      };
      all.onerror = () => reject(all.error);
    };
  }), store);
}

export const editorDoc = (page) => page.evaluate(() => structuredClone(window.__dceEditor.doc()));
export const editorState = (page) => page.evaluate(() => { const s = window.__dceEditor.store.get(); return { selection: s.selection, zoom: s.zoom, tool: s.tool, canUndo: s.canUndo, canRedo: s.canRedo, dirty: s.dirty, previewOn: s.previewOn }; });

/** Scene → page coordinates for the open editor. */
export async function toPage(page, x, y) {
  return page.evaluate(([sx, sy]) => {
    const c = window.__dceEditor;
    const p = c.sceneToScreen(sx, sy);
    const r = document.querySelector('[data-testid=canvas-host]').getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, [x, y]);
}

export async function drag(page, from, to, steps = 8) {
  const a = await toPage(page, from[0], from[1]);
  const b = await toPage(page, to[0], to[1]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
  await page.waitForTimeout(80);
}

export async function waitIdle(page, ms = 250) { await page.waitForTimeout(ms); }

/** First differing path between two JSON values (for readable failures). */
export function firstDiff(a, b, path = '$') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
  }
  return `${path}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`;
}

import { deflateSync, crc32 } from 'node:zlib';
/** A valid solid-colour PNG (RGB, 8-bit). */
export function makePng(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; } }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
