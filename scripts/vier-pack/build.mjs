// Generates the VierApparatus vector pack: 50 SVG files with transparent backgrounds, in the brand palette.
// Every shape is a filled <path> made of straight lines and cubic curves only, so the vector editor can edit every point.
// Run: node scripts/vier-pack/build.mjs   (writes assets-pack/VierAsset/*.svg)
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'assets-pack', 'VierAsset');
export const COL = { brand: '#4570b6', sky: '#caebfb', ink: '#231f20', grey: '#a7b0bb', mid: '#8fb3e4', white: '#ffffff', deep: '#2f5a9a' };
const K = 0.5523;
const r2 = (n) => Math.round(n * 100) / 100;
// ------------------------------------------------------------------------------------------------ geometry → path data
const circleD = (cx, cy, r) => `M${r2(cx + r)} ${r2(cy)}C${r2(cx + r)} ${r2(cy + K * r)} ${r2(cx + K * r)} ${r2(cy + r)} ${r2(cx)} ${r2(cy + r)}C${r2(cx - K * r)} ${r2(cy + r)} ${r2(cx - r)} ${r2(cy + K * r)} ${r2(cx - r)} ${r2(cy)}C${r2(cx - r)} ${r2(cy - K * r)} ${r2(cx - K * r)} ${r2(cy - r)} ${r2(cx)} ${r2(cy - r)}C${r2(cx + K * r)} ${r2(cy - r)} ${r2(cx + r)} ${r2(cy - K * r)} ${r2(cx + r)} ${r2(cy)}Z`;
const polyD = (pts) => `M${pts.map(([x, y]) => `${r2(x)} ${r2(y)}`).join('L')}Z`;
/** A rectangle with rounded corners (points along each corner). */
function roundRectPts(x, y, w, h, r, n = 4) {
  const pts = [];
  const corner = (cx, cy, a0) => { for (let i = 0; i <= n; i++) { const a = a0 + (Math.PI / 2) * (i / n); pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
  corner(x + w - r, y + r, -Math.PI / 2);
  corner(x + w - r, y + h - r, 0);
  corner(x + r, y + h - r, Math.PI / 2);
  corner(x + r, y + r, Math.PI);
  return pts;
}
/** A rotated rectangle's corners. */
function rotRect(cx, cy, w, h, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}
/** Points on a circle arc from a0 to a1 (radians). */
const arcPts = (cx, cy, r, a0, a1, n = 24) => Array.from({ length: n + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
/** One straight thick segment as a polygon. */
function segPoly([x1, y1], [x2, y2], w) {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (w / 2), ny = (dx / len) * (w / 2);
  return [[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]];
}
// ------------------------------------------------------------------------------------------------ elements
/** A list of elements: { d, fill, rule? }. Helpers return arrays that are concatenated. */
const E = (d, fill, rule) => ({ d, fill, rule });
const circle = (cx, cy, r, fill) => [E(circleD(cx, cy, r), fill)];
const ring = (cx, cy, ro, ri, fill) => [E(`${circleD(cx, cy, ro)}${circleD(cx, cy, ri)}`, fill, 'evenodd')];
const poly = (pts, fill) => [E(polyD(pts), fill)];
const rect = (x, y, w, h, fill, r = 0) => (r ? poly(roundRectPts(x, y, w, h, r), fill) : poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], fill));
/** A thick line (a bond, a branch, a stroke) as one element per segment plus round caps. */
const stroke = (pts, w, fill) => {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) out.push(...poly(segPoly(pts[i], pts[i + 1], w), fill));
  for (const p of pts) out.push(...circle(p[0], p[1], w / 2, fill));
  return out;
};
/** A filled shape with holes: outer points, then each hole's points (even-odd). */
const withHoles = (outer, holes, fill) => [E([polyD(outer), ...holes.map(polyD)].join(''), fill, 'evenodd')];
const cubicLeaf = (fill) => [E('M100 18C158 58 166 132 100 184C34 132 42 58 100 18Z', fill)];
function svgDoc(elements) {
  const body = elements.map((e) => `<path fill="${e.fill}"${e.rule ? ` fill-rule="${e.rule}"` : ''} d="${e.d}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">${body}</svg>\n`;
}
// ------------------------------------------------------------------------------------------------ science equipment
const C = COL;
const I = {};
I['Microscope'] = () => [
  ...rect(40, 164, 120, 16, C.ink, 5),
  ...rect(116, 74, 16, 92, C.brand, 5),
  ...stroke([[124, 74], [96, 44]], 14, C.brand),
  ...poly(rotRect(84, 34, 26, 62, -32), C.ink),
  ...rect(70, 14, 28, 12, C.ink, 3),
  ...rect(74, 110, 78, 9, C.sky, 3),
  ...rect(96, 119, 14, 6, C.grey),
  ...circle(144, 126, 9, C.brand),
];
I['Centrifuge'] = () => [
  ...ring(100, 100, 74, 60, C.brand),
  ...circle(100, 100, 60, C.sky),
  ...poly(arcPts(100, 100, 52, 0, Math.PI * 2, 8).slice(0, 8), C.grey),
  ...circle(100, 100, 12, C.ink),
  ...rect(20, 176, 160, 10, C.ink, 3),
  ...rect(86, 68, 28, 8, C.white),
];
I['Micropipette'] = () => [
  ...rect(88, 14, 24, 56, C.brand, 5),
  ...rect(82, 64, 36, 22, C.ink, 4),
  ...rect(90, 84, 20, 46, C.sky, 2),
  ...poly([[96, 130], [104, 130], [100, 170]], C.ink),
  ...circle(100, 182, 5, C.brand),
  ...circle(100, 26, 3, C.sky),
];
I['Test tube rack'] = () => [
  ...rect(20, 150, 160, 12, C.ink, 4),
  ...rect(40, 42, 14, 110, C.grey, 4), ...rect(93, 42, 14, 110, C.grey, 4), ...rect(146, 42, 14, 110, C.grey, 4),
  ...rect(50, 46, 16, 92, C.sky, 8), ...rect(104, 46, 16, 92, C.brand, 8), ...rect(156, 46, 16, 92, C.sky, 8),
  ...rect(28, 36, 38, 10, C.ink, 4), ...rect(81, 36, 38, 10, C.ink, 4), ...rect(134, 36, 38, 10, C.ink, 4),
];
I['Test tube'] = () => [
  ...rect(82, 20, 36, 14, C.ink, 4),
  ...rect(88, 28, 24, 130, C.sky, 6),
  ...poly(arcPts(100, 158, 12, 0, Math.PI, 12).map(([x, y]) => [x, y]).concat([[88, 158]]), C.brand),
  ...rect(88, 110, 24, 48, C.brand, 0),
  ...circle(100, 160, 12, C.brand),
];
I['Erlenmeyer flask'] = () => [
  ...rect(88, 18, 24, 50, C.ink, 3),
  ...poly([[88, 66], [112, 66], [162, 170], [38, 170]], C.sky),
  ...poly([[60, 124], [140, 124], [162, 170], [38, 170]], C.brand),
  ...rect(30, 166, 140, 10, C.ink, 4),
];
I['Beaker'] = () => [
  ...poly([[52, 40], [148, 40], [148, 170], [52, 170]], C.sky),
  ...poly([[52, 96], [148, 96], [148, 170], [52, 170]], C.brand),
  ...rect(40, 34, 120, 8, C.ink, 3),
  ...rect(40, 166, 120, 8, C.ink, 3),
  ...rect(146, 60, 14, 4, C.ink), ...rect(146, 80, 10, 4, C.ink), ...rect(146, 100, 14, 4, C.ink), ...rect(146, 120, 10, 4, C.ink),
];
I['Round-bottom flask'] = () => [
  ...rect(88, 14, 24, 60, C.ink, 3),
  ...rect(84, 70, 32, 16, C.sky, 2),
  ...circle(100, 130, 52, C.sky),
  ...circle(100, 140, 40, C.brand),
  ...rect(90, 60, 20, 16, C.sky),
];
I['Burette'] = () => [
  ...rect(90, 22, 20, 124, C.sky, 4),
  ...rect(96, 40, 8, 96, C.brand, 2),
  ...rect(84, 14, 32, 10, C.ink, 3),
  ...rect(91, 146, 18, 10, C.ink),
  ...poly([[100, 156], [96, 176], [104, 176]], C.ink),
  ...rect(40, 176, 120, 10, C.ink, 4),
];
I['Petri dish'] = () => [
  ...circle(100, 100, 74, C.sky),
  ...ring(100, 100, 74, 64, C.brand),
  ...circle(78, 84, 9, C.brand), ...circle(118, 74, 6, C.brand), ...circle(124, 118, 11, C.brand), ...circle(86, 126, 5, C.brand),
];
I['Analytical balance'] = () => [
  ...rect(24, 150, 152, 26, C.ink, 4),
  ...rect(76, 58, 48, 8, C.grey, 2),
  ...rect(84, 66, 32, 40, C.grey, 2),
  ...circle(100, 60, 6, C.brand),
  ...rect(40, 110, 120, 14, C.sky, 3),
  ...rect(64, 128, 72, 10, C.brand, 2),
  ...rect(52, 160, 96, 6, C.grey),
];
I['Incubator'] = () => [
  ...rect(30, 24, 140, 152, C.sky, 14),
  ...rect(44, 38, 112, 124, C.white, 8),
  ...rect(54, 52, 92, 96, C.mid, 4),
  ...rect(66, 110, 22, 10, C.brand, 2), ...rect(96, 110, 22, 10, C.brand, 2),
  ...rect(132, 64, 6, 22, C.ink, 2),
  ...rect(40, 180, 120, 8, C.ink, 3),
];
I['Water bath'] = () => [
  ...rect(20, 84, 160, 90, C.brand, 10),
  ...rect(30, 94, 140, 70, C.sky, 6),
  ...poly([[60, 92], [70, 78], [80, 92]], C.grey), ...poly([[118, 92], [128, 78], [138, 92]], C.grey),
  ...rect(146, 56, 22, 14, C.ink, 3),
  ...rect(30, 176, 140, 8, C.ink, 3),
];
I['Magnetic stirrer'] = () => [
  ...rect(22, 110, 156, 62, C.ink, 10),
  ...rect(34, 122, 132, 38, C.grey, 6),
  ...ring(100, 141, 24, 12, C.sky),
  ...rect(146, 128, 22, 8, C.brand, 3),
  ...rect(146, 144, 22, 8, C.brand, 3),
  ...rect(26, 60, 148, 14, C.sky, 5),
  ...stroke([[100, 74], [100, 110]], 4, C.grey),
  ...rect(88, 38, 24, 24, C.white, 6),
];
I['Vortex mixer'] = () => [
  ...rect(40, 120, 120, 56, C.ink, 14),
  ...ring(100, 100, 40, 30, C.brand),
  ...circle(100, 100, 30, C.sky),
  ...rect(50, 150, 22, 10, C.brand, 3),
  ...circle(100, 100, 12, C.brand),
  ...stroke([[138, 70], [158, 52]], 6, C.grey),
];
I['Syringe'] = () => [
  ...rect(20, 97, 26, 6, C.grey, 2),
  ...poly([[20, 97], [12, 100], [20, 103]], C.grey),
  ...rect(44, 84, 104, 32, C.sky, 6),
  ...rect(52, 92, 88, 16, C.white, 4),
  ...rect(46, 92, 4, 16, C.brand),
  ...rect(146, 80, 10, 40, C.ink, 3),
  ...rect(156, 96, 34, 8, C.grey, 2),
  ...rect(186, 86, 8, 28, C.ink, 3),
  ...rect(64, 94, 2, 12, C.brand), ...rect(82, 94, 2, 12, C.brand), ...rect(100, 94, 2, 12, C.brand), ...rect(118, 94, 2, 12, C.brand),
];
I['Thermometer'] = () => [
  ...rect(86, 14, 28, 130, C.sky, 14),
  ...rect(94, 40, 12, 110, C.brand, 6),
  ...circle(100, 164, 26, C.brand),
  ...circle(100, 164, 16, C.mid),
  ...rect(118, 36, 14, 4, C.ink), ...rect(118, 60, 10, 4, C.ink), ...rect(118, 84, 14, 4, C.ink), ...rect(118, 108, 10, 4, C.ink),
];
I['Spectrophotometer'] = () => [
  ...rect(18, 110, 164, 70, C.ink, 10),
  ...rect(36, 56, 40, 52, C.sky, 6),
  ...rect(58, 74, 2, 36, C.brand),
  ...rect(100, 56, 64, 36, C.mid, 4),
  ...rect(112, 70, 40, 8, C.white, 2),
  ...circle(140, 134, 10, C.brand),
  ...rect(30, 130, 60, 14, C.grey, 3),
];
I['Microplate'] = () => {
  const els = [...rect(18, 36, 164, 128, C.ink, 14), ...rect(30, 48, 140, 104, C.sky, 6)];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) els.push(...circle(52 + c * 22, 72 + r * 22, 8, C.brand));
  return els;
};
I['pH meter'] = () => [
  ...rect(30, 118, 140, 56, C.ink, 12),
  ...rect(46, 130, 66, 30, C.sky, 6),
  ...rect(120, 130, 40, 12, C.brand, 3),
  ...rect(96, 40, 8, 80, C.grey, 4),
  ...circle(100, 40, 14, C.grey),
  ...circle(100, 40, 8, C.sky),
];
// ------------------------------------------------------------------------------------------------ science: trees, molecules, cells
const tipY = 46;
I['Phylogenetic tree'] = () => {
  const leaves = [[28, tipY], [72, tipY], [116, tipY], [160, tipY]];
  const els = [];
  els.push(...stroke([[50, 92], [50, tipY]], 4, C.ink), ...stroke([[94, 92], [94, tipY]], 4, C.ink));
  els.push();
  els.push(...stroke([[50, 92], [116, 92]], 4, C.ink), ...stroke([[116, 92], [116, tipY]], 4, C.ink), ...stroke([[160, 92], [160, tipY]], 4, C.ink));
  els.push(...stroke([[28, 92], [72, 92]], 4, C.ink), ...stroke([[28, 92], [28, tipY]], 4, C.ink));
  els.push(...stroke([[72, 92], [72, tipY]], 4, C.ink));
  els.push();
  els.push(...stroke([[94, 130], [94, 176]], 4, C.ink));
  els.push(...stroke([[50, 130], [140, 130]], 4, C.ink), ...stroke([[50, 130], [50, 92]], 4, C.ink), ...stroke([[140, 130], [140, 92]], 4, C.ink));
  for (const [x, y] of leaves) els.push(...circle(x, y, 8, C.brand));
  els.push(...circle(50, 92, 5, C.mid), ...circle(140, 92, 5, C.mid), ...circle(94, 130, 6, C.mid), ...circle(94, 176, 6, C.brand));
  return els;
};
I['Phylogenetic tree radial'] = () => {
  const els = [];
  const cx = 100, cy = 100, leaves = 9;
  for (let i = 0; i < leaves; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / leaves;
    const x = cx + 76 * Math.cos(a), y = cy + 76 * Math.sin(a);
    els.push(...stroke([[cx + 22 * Math.cos(a), cy + 22 * Math.sin(a)], [x, y]], 4, i % 2 ? C.brand : C.ink));
    els.push(...circle(x, y, 7, i % 2 ? C.brand : C.mid));
  }
  for (let i = 0; i < leaves; i += 3) {
    const a = -Math.PI / 2 + ((i + 1) * 2 * Math.PI) / leaves;
    els.push(...stroke([[cx + 22 * Math.cos(a), cy + 22 * Math.sin(a)], [cx + 40 * Math.cos(a), cy + 40 * Math.sin(a)]], 4, C.ink));
  }
  els.push(...circle(cx, cy, 16, C.sky), ...ring(cx, cy, 16, 9, C.brand));
  return els;
};
I['Cladogram'] = () => [
  ...stroke([[30, 170], [30, 60]], 4, C.ink), ...stroke([[30, 60], [110, 60]], 4, C.ink), ...stroke([[30, 110], [90, 110]], 4, C.ink),
  ...stroke([[90, 110], [90, 40]], 4, C.ink), ...stroke([[90, 40], [170, 40]], 4, C.ink), ...stroke([[90, 80], [170, 80]], 4, C.ink),
  ...circle(30, 60, 7, C.brand), ...circle(110, 60, 6, C.mid), ...circle(90, 110, 6, C.mid), ...circle(90, 40, 6, C.mid),
  ...circle(170, 20, 7, C.brand), ...circle(170, 40, 7, C.brand), ...circle(170, 80, 7, C.brand), 
];
I['Node network'] = () => {
  const pts = [[40, 50], [100, 30], [160, 60], [60, 120], [130, 120], [100, 170], [170, 160], [30, 170]];
  const els = [];
  const links = [[0, 1], [1, 2], [0, 3], [1, 4], [2, 4], [3, 5], [4, 5], [4, 6], [5, 7], [3, 7]];
  for (const [a, b] of links) els.push(...stroke([pts[a], pts[b]], 4, C.grey));
  pts.forEach(([x, y], i) => els.push(...circle(x, y, i % 3 === 0 ? 12 : 9, i % 3 === 0 ? C.brand : C.mid)));
  return els;
};
const molBond = (a, b, w = 7) => stroke([a, b], w, C.grey);
I['Molecule water'] = () => [...molBond([100, 100], [62, 128]), ...molBond([100, 100], [138, 128]), ...circle(100, 100, 30, C.brand), ...circle(62, 128, 18, C.sky), ...circle(138, 128, 18, C.sky)];
I['Molecule carbon dioxide'] = () => [...molBond([36, 100], [100, 100], 8), ...molBond([100, 100], [164, 100], 8), ...circle(100, 100, 24, C.ink), ...circle(36, 100, 22, C.brand), ...circle(164, 100, 22, C.brand)];
I['Molecule methane'] = () => [
  ...molBond([100, 100], [100, 40], 6), ...molBond([100, 100], [160, 100], 6), ...molBond([100, 100], [40, 100], 6), ...molBond([100, 100], [100, 160], 6),
  ...circle(100, 100, 26, C.ink), ...circle(100, 34, 14, C.sky), ...circle(166, 100, 14, C.sky), ...circle(34, 100, 14, C.sky), ...circle(100, 166, 14, C.sky),
];
I['Benzene ring'] = () => {
  const hex = Array.from({ length: 6 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 3; return [100 + 62 * Math.cos(a), 100 + 62 * Math.sin(a)]; });
  const els = [];
  for (let i = 0; i < 6; i++) els.push(...molBond(hex[i], hex[(i + 1) % 6], 8));
  hex.forEach(([x, y]) => els.push(...circle(x, y, 14, C.ink)));
  // the double bonds, drawn as an inner ring
  const inner = Array.from({ length: 6 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 3; return [100 + 38 * Math.cos(a), 100 + 38 * Math.sin(a)]; });
  for (let i = 0; i < 6; i += 2) els.push(...molBond(inner[i], inner[(i + 1) % 6], 5));
  return els;
};
I['Glucose ring'] = () => {
  const hex = Array.from({ length: 6 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 3; return [100 + 58 * Math.cos(a), 100 + 58 * Math.sin(a)]; });
  const els = [];
  for (let i = 0; i < 6; i++) els.push(...molBond(hex[i], hex[(i + 1) % 6], 8));
  hex.forEach(([x, y], i) => { els.push(...circle(x, y, 10, C.ink)); els.push(...molBond([x, y], [x + 26 * Math.cos(-Math.PI / 2 + (i * Math.PI) / 3), y + 26 * Math.sin(-Math.PI / 2 + (i * Math.PI) / 3)], 5)); els.push(...circle(x + 38 * Math.cos(-Math.PI / 2 + (i * Math.PI) / 3), y + 38 * Math.sin(-Math.PI / 2 + (i * Math.PI) / 3), 7, C.brand)); });
  return els;
};
I['DNA helix'] = () => {
  const els = [];
  const pts = (ph) => Array.from({ length: 60 }, (_, i) => { const t = (i / 59) * Math.PI * 3; return [100 + 42 * Math.sin(t + ph), 14 + (i / 59) * 172]; });
  const a = pts(0), b = pts(Math.PI);
  els.push(...stroke(a, 7, C.brand), ...stroke(b, 7, C.mid));
  for (let i = 0; i < 60; i += 6) {
    const [x1, y1] = a[i], [x2, y2] = b[i];
    if (Math.abs(x1 - x2) > 12) els.push(...stroke([[x1, y1], [x2, y2]], 4, C.grey));
  }
  return els;
};
I['DNA base pairs'] = () => {
  const els = [];
  for (let i = 0; i < 6; i++) {
    const y = 26 + i * 28, dx = [40, 22, 52, 30, 46, 18][i];
    els.push(...stroke([[100 - dx, y], [100, y]], 8, C.brand), ...stroke([[100, y], [100 + dx, y]], 8, C.mid));
    els.push(...circle(100 - dx, y, 9, C.brand), ...circle(100 + dx, y, 9, C.mid));
    els.push(...circle(100, y, 4, C.white));
  }
  return els;
};
I['Animal cell'] = () => [
  ...ring(100, 100, 84, 74, C.brand), ...circle(100, 100, 74, C.sky),
  ...circle(100, 96, 28, C.brand), ...circle(100, 96, 12, C.ink),
  ...rect(40, 126, 26, 12, C.ink, 6, ).map((e) => e), ...rect(128, 60, 26, 12, C.ink, 6), ...rect(124, 124, 24, 12, C.ink, 6), ...rect(46, 62, 22, 11, C.ink, 5),
  ...circle(70, 150, 5, C.mid), ...circle(140, 150, 4, C.mid), 
];
I['Plant cell'] = () => [
  ...rect(20, 24, 160, 152, C.brand, 10), ...rect(30, 34, 140, 132, C.sky, 6),
  ...circle(118, 96, 26, C.mid), ...circle(116, 94, 10, C.ink),
  ...rect(44, 52, 40, 22, C.brand, 10), ...rect(44, 128, 40, 22, C.brand, 10), ...rect(102, 136, 36, 18, C.brand, 9),
  ...rect(60, 96, 14, 4, C.grey), ...rect(146, 56, 14, 4, C.grey),
];
I['Bacterium rod'] = () => [...rect(38, 84, 124, 40, C.brand, 20), ...rect(54, 92, 92, 10, C.sky, 5), ...circle(152, 104, 4, C.ink)];
I['Bacteria cluster'] = () => [...circle(70, 70, 32, C.brand), ...circle(128, 72, 30, C.mid), ...circle(100, 124, 32, C.brand), ...circle(66, 66, 6, C.sky), ...circle(124, 64, 5, C.sky), ...circle(98, 118, 6, C.sky)];
I['Spiral bacterium'] = () => {
  const pts = Array.from({ length: 80 }, (_, i) => { const t = (i / 79) * Math.PI * 4; return [40 + (i / 79) * 120, 100 + 26 * Math.sin(t)]; });
  return stroke(pts, 12, C.brand);
};
I['Virus'] = () => {
  const els = [...circle(100, 100, 46, C.brand), ...circle(100, 100, 34, C.sky)];
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI * 2) / 12;
    els.push(...stroke([[100 + 46 * Math.cos(a), 100 + 46 * Math.sin(a)], [100 + 72 * Math.cos(a), 100 + 72 * Math.sin(a)]], 8, C.mid));
    els.push(...circle(100 + 74 * Math.cos(a), 100 + 74 * Math.sin(a), 10, C.brand));
  }
  return els;
};
I['Atom'] = () => {
  const els = [];
  for (const rot of [0, 60, -60]) {
    const pts = Array.from({ length: 96 }, (_, i) => { const t = (i / 96) * Math.PI * 2; const x = 74 * Math.cos(t), y = 30 * Math.sin(t); const a = (rot * Math.PI) / 180; return [100 + x * Math.cos(a) - y * Math.sin(a), 100 + x * Math.sin(a) + y * Math.cos(a)]; });
    els.push(...stroke([...pts, pts[0]], 4, C.grey));
    els.push(...circle(pts[24][0], pts[24][1], 8, C.brand));
  }
  els.push(...circle(100, 100, 18, C.ink), ...circle(92, 94, 6, C.brand), ...circle(108, 108, 6, C.mid));
  return els;
};
I['Neuron'] = () => [
  ...circle(100, 100, 26, C.brand), ...circle(100, 100, 12, C.sky),
  ...stroke([[100, 74], [100, 30]], 7, C.brand), ...stroke([[126, 100], [170, 100]], 7, C.brand), ...stroke([[74, 100], [30, 110]], 6, C.brand),
  ...stroke([[100, 126], [84, 172]], 6, C.brand), ...stroke([[118, 120], [150, 160]], 5, C.brand),
  ...circle(100, 30, 6, C.mid), ...circle(170, 100, 6, C.mid), ...circle(30, 110, 5, C.mid), ...circle(84, 172, 5, C.mid), ...circle(150, 160, 5, C.mid),
];
I['Chromosome'] = () => [
  ...stroke([[78, 28], [100, 100]], 22, C.brand), ...stroke([[122, 28], [100, 100]], 22, C.brand),
  ...stroke([[100, 100], [78, 172]], 22, C.mid), ...stroke([[100, 100], [122, 172]], 22, C.mid),
  ...circle(78, 28, 14, C.ink), ...circle(122, 28, 14, C.ink), ...circle(78, 172, 14, C.ink), ...circle(122, 172, 14, C.ink),
];
I['Leaf'] = () => [...cubicLeaf(C.brand), ...stroke([[100, 30], [100, 170]], 5, C.sky), ...stroke([[100, 70], [70, 56]], 4, C.sky), ...stroke([[100, 96], [132, 82]], 4, C.sky), ...stroke([[100, 120], [70, 106]], 4, C.sky)];
I['Lipid bilayer'] = () => {
  const els = [];
  for (let i = 0; i < 9; i++) {
    const x = 22 + i * 22;
    els.push(...circle(x, 60, 8, C.brand), ...circle(x, 140, 8, C.brand));
    els.push(...stroke([[x, 68], [x, 92]], 4, C.grey), ...stroke([[x, 108], [x, 132]], 4, C.grey));
  }
  els.push();
  return els;
};
I['Protein chain'] = () => {
  const pts = Array.from({ length: 9 }, (_, i) => [24 + i * 21, 100 + (i % 2 ? -32 : 32)]);
  const els = stroke(pts, 8, C.grey);
  pts.forEach(([x, y], i) => els.push(...circle(x, y, 12, i % 3 === 0 ? C.brand : C.mid)));
  return els;
};
// ------------------------------------------------------------------------------------------------ charts and symbols
I['Bar chart'] = () => [
  ...rect(30, 20, 4, 160, C.ink), ...rect(30, 176, 150, 4, C.ink),
  ...rect(46, 110, 22, 66, C.mid, 3), ...rect(78, 80, 22, 96, C.brand, 3), ...rect(110, 56, 22, 120, C.brand, 3), ...rect(142, 96, 22, 80, C.mid, 3),
];
I['Growth curve'] = () => {
  const pts = Array.from({ length: 30 }, (_, i) => { const t = i / 29; return [24 + t * 152, 170 - 130 * (1 - Math.exp(-4 * t))]; });
  return [...stroke(pts, 7, C.brand), ...circle(pts[29][0], pts[29][1], 9, C.ink), ...rect(24, 176, 156, 4, C.ink)];
};
I['Pie chart'] = () => {
  const els = [];
  const slices = [[0, 0.45, C.brand], [0.45, 0.75, C.mid], [0.75, 1, C.sky]];
  for (const [a0, a1, col] of slices) {
    const pts = [[100, 100], ...arcPts(100, 100, 72, a0 * Math.PI * 2 - Math.PI / 2, a1 * Math.PI * 2 - Math.PI / 2, 24)];
    els.push(...poly(pts, col));
  }
  return els;
};
I['Water drop'] = () => [E('M100 18C128 58 164 98 164 132C164 162 136 184 100 184C64 184 36 162 36 132C36 98 72 58 100 18Z', C.brand)];
I['Pipette drops'] = () => [
  ...rect(88, 14, 24, 84, C.sky, 6), ...rect(82, 92, 36, 14, C.brand, 4),
  ...poly([[96, 106], [104, 106], [100, 122]], C.brand),
  ...circle(100, 146, 9, C.brand), ...circle(100, 170, 7, C.mid), ...circle(100, 186, 4, C.sky),
];
I['Test tube bubbles'] = () => [
  ...rect(84, 22, 32, 146, C.sky, 14),
  ...rect(90, 80, 20, 88, C.brand, 9),
  ...circle(100, 40, 10, C.brand), ...circle(96, 66, 5, C.brand),
  ...circle(72, 56, 6, C.mid), ...circle(132, 46, 4, C.mid),
  ...rect(78, 16, 44, 10, C.ink, 4),
];
I['Lab flask bubbles'] = () => [
  ...rect(90, 16, 20, 56, C.sky, 3),
  ...poly([[90, 72], [110, 72], [160, 168], [40, 168]], C.sky),
  ...poly([[70, 128], [130, 128], [160, 168], [40, 168]], C.brand),
  ...circle(100, 96, 6, C.white), ...circle(118, 118, 4, C.white), ...circle(84, 110, 5, C.mid),
  ...rect(30, 166, 140, 10, C.ink, 4),
];
// ------------------------------------------------------------------------------------------------ build
export const PACK = Object.keys(I);
function build() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const name of PACK) {
    const els = I[name]().filter((e) => e.d && e.d.length > 4);
    writeFileSync(join(OUT, `${name}.svg`), svgDoc(els));
  }
  console.log(`wrote ${PACK.length} files to ${OUT}`);
}
build();