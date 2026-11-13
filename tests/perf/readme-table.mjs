/** Replaces the benchmark block in README.md with the numbers from tests/perf/out/results.json. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const R = JSON.parse(readFileSync(root + 'tests/perf/out/results.json', 'utf8'));
const r = R.results;
const b100 = r['batch: 100 records → PNG ZIP'], b1k = r['batch: 1000 records → PNG ZIP'], b1w = r['batch: same 100 records with ONE worker'], b10k = r['batch@10k-records: 1000 records → PNG ZIP'];
const k = (p, name) => r[`${p}: ${name}`];
const rows = [
  ['Seed 1,000 / 10,000 records (bulk IndexedDB write)', `${r['add 1,000 demo records (ms)']} ms / ${r['add 10,000 demo records (2 × 5,000) (ms)']} ms`],
  ['Grid ready after reload — 1,000 / 11,006 records', `${k('1k', 'grid ready after reload (ms)')} ms / ${k('10k', 'grid ready after reload (ms)')} ms`],
  ['Rows in the DOM (virtualised) — 1,000 / 11,006 records', `${k('1k', 'rows in DOM / total')} / ${k('10k', 'rows in DOM / total')}`],
  ['Smooth scroll, 90 px/frame — p50 / p95 frame (1k)', `${k('1k', 'smooth scroll 90 px/frame × 120 frames').p50} ms / ${k('1k', 'smooth scroll 90 px/frame × 120 frames').p95} ms`],
  ['Smooth scroll, 90 px/frame — p50 / p95 frame (11k)', `${k('10k', 'smooth scroll 90 px/frame × 120 frames').p50} ms / ${k('10k', 'smooth scroll 90 px/frame × 120 frames').p95} ms`],
  ['Jump-scroll top→bottom in 121 frames (worst case) — p50 / p95 (11k)', `${k('10k', 'jump-scroll top→bottom (121 frames, worst case)').p50} ms / ${k('10k', 'jump-scroll top→bottom (121 frames, worst case)').p95} ms`],
  ['Search a phrase, typing → filtered grid (includes a 150 ms debounce) — 1,000 / 11,006 records', `${k('1k', 'search "Rotary Evaporator 10" (ms, matches)')} / ${k('10k', 'search "Rotary Evaporator 10" (ms, matches)')}`],
  ['Sort 1,000 / 11,006 records by title (header click → re-sorted grid)', `${k('1k', 'sort by title (ms)')} ms / ${k('10k', 'sort by title (ms)')} ms`],
  ['Indexed filter (Status = Draft) on 11,006 records, Batch page', r['10k: indexed filter Status=Draft → matches']],
  ['Open a template in the editor → first paint', `${r['template open → first paint in editor (ms)']} ms`],
  ['One record → 1080×1080 PNG on the main thread (preview)', r['single record render, main thread, 1080×1080 → PNG'].replace(/^.*rendered in /, '')],
  ['100 records → PNG ZIP (4 workers)', `${b100.wallMs} ms wall, **${b100.perSecond}/s**, ${b100.zipMB} MB`],
  ['100 records, 1 worker', `${b1w.wallMs} ms wall, ${b1w.perSecond}/s`],
  ['1,000 records → PNG ZIP (4 workers)', `${b1k.wallMs} ms wall, **${b1k.perSecond}/s**, ${b1k.zipMB} MB, main-thread JS heap peak ${b1k.peakMainJsHeapMB} MB, whole browser process tree peak ${b1k.peakBrowserProcessTreeMB} MB`],
  ['1,000 records while 11,006 are stored', `${b10k.wallMs} ms wall, ${b10k.perSecond}/s, JS heap peak ${b10k.peakMainJsHeapMB} MB, process tree peak ${b10k.peakBrowserProcessTreeMB} MB`],
];
const m = R.machine;
const block = `Machine: ${m.cpu}, ${m.logicalCores} logical cores, ${m.ramGB} GB RAM · headless Chromium **without GPU** (software rasterisation) · ${R.when.slice(0, 10)}.
The sample template has 18 elements (shapes, 5 text frames with auto-shrink, one 800×800 image, one logo).
Target from the brief — ≥ 5 simple 1080×1080 PNG renders per second — is exceeded roughly ten-fold; a heavier template (more
images, large auto-shrink paragraphs) will be slower, and nothing here is a promise for such templates.

| Measurement | Result |
|---|---|
${rows.map(([a, v]) => `| ${a} | ${v} |`).join('\n')}

"Jump-scroll" teleports ~90 rows per frame and is a stress test, not a normal scroll. Frame times are dominated by software
rasterisation in headless Chromium (CPU profile of the 1k grid: about two thirds of the time is native paint and layout, JS is the smaller part); on a GPU-backed browser they are lower.
Memory: finished ZIP chunks are folded into Blobs, so the main-thread JS heap stayed ≈ ${b1k.peakMainJsHeapMB} MB for a 250 MB archive
(it was ≈ 265 MB before that change). Worker memory is inside the "process tree" figure.`;
let readme = readFileSync(root + 'README.md', 'utf8');
readme = readme.replace(/<!-- BENCH:START -->[\s\S]*<!-- BENCH:END -->/, '@@BENCH@@').replace('@@BENCH@@', `<!-- BENCH:START -->\n${block}\n<!-- BENCH:END -->`);
writeFileSync(root + 'README.md', readme);
console.log('README.md benchmark block updated');
