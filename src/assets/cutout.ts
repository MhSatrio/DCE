/**
 * Background removal, pure (no DOM). The background is learned from the picture's border, then the region of it that
 * touches the border is made transparent.
 *
 *  - Colours are compared in CIE L*a*b* (perceptual distance ΔE76), not in RGB: a light grey and a white differ the way the
 *    eye sees them.
 *  - The background is several colours (k-means over the border), each with its own radius from the spread of its pixels.
 *    A backdrop that changes gently is covered; a product of a different colour is not. A colour that covers less than 4 %
 *    of the border is taken to be part of the object.
 *  - The removal is a flood fill from the border through the backdrop mask. The mask is the colour distance smoothed over
 *    3×3, so noise does not punch holes in the backdrop. An outline, which is not backdrop, stops the fill, so a white area
 *    enclosed by the outline stays (the platter of a balance, a highlight).
 *  - `enclosed` removes every backdrop-coloured area, enclosed or not. That is what a line drawing needs (the white inside a
 *    drawn flask). It would also remove light parts of a photographed product, so it is off by default.
 *  - Pixels on the edge of the removed area get a soft alpha, so the cut is not a hard step.
 *
 * Known limits: a product whose colour is close to the backdrop (clear glass on a blue backdrop, a white plastic tube on a
 * white backdrop) cannot be told apart by colour alone. Such areas need a manual correction.
 */

export interface Lab { L: Float32Array; a: Float32Array; b: Float32Array }
type Vec = [number, number, number];

/** sRGB bytes → CIE L*a*b* (D65). */
export function toLab(src: Uint8ClampedArray, n: number): Lab {
  const lin = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; lin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  for (let i = 0; i < n; i++) {
    const r = lin[src[i * 4]], g = lin[src[i * 4 + 1]], b = lin[src[i * 4 + 2]];
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const fx = f(x), fy = f(y), fz = f(z);
    L[i] = 116 * fy - 16; A[i] = 500 * (fx - fy); B[i] = 200 * (fy - fz);
  }
  return { L, a: A, b: B };
}

const dE = (p: Vec, q: Vec) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

export interface BackdropColour { centre: Vec; radius: number }

/** k-means over the border colours (deterministic start points, far apart). Each kept colour gets its own radius. */
export function backdropColours(samples: Vec[], minRadius: number, k = 6, iterations = 12): BackdropColour[] {
  if (samples.length === 0) return [];
  const centres: Vec[] = [samples[0].slice() as Vec];
  while (centres.length < k) {
    let best = samples[0], bestD = -1;
    for (const s of samples) {
      const d = Math.min(...centres.map((c) => dE(s, c)));
      if (d > bestD) { bestD = d; best = s; }
    }
    if (bestD < 1) break;
    centres.push(best.slice() as Vec);
  }
  const assign = new Int32Array(samples.length);
  for (let it = 0; it < iterations; it++) {
    const sums = centres.map(() => [0, 0, 0]);
    const counts = new Array(centres.length).fill(0);
    for (let s = 0; s < samples.length; s++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < centres.length; c++) { const d = dE(samples[s], centres[c]); if (d < bd) { bd = d; bi = c; } }
      assign[s] = bi;
      counts[bi]++;
      sums[bi][0] += samples[s][0]; sums[bi][1] += samples[s][1]; sums[bi][2] += samples[s][2];
    }
    for (let c = 0; c < centres.length; c++) if (counts[c]) centres[c] = [sums[c][0] / counts[c], sums[c][1] / counts[c], sums[c][2] / counts[c]];
  }
  const total = samples.length;
  const out: BackdropColour[] = [];
  centres.forEach((centre, c) => {
    const mine: number[] = [];
    for (let s = 0; s < samples.length; s++) if (assign[s] === c) mine.push(dE(samples[s], centre));
    if (mine.length / total < 0.04) return;
    mine.sort((p, q) => p - q);
    const spread = mine[Math.floor(mine.length * 0.95)] ?? 0;
    out.push({ centre, radius: Math.max(minRadius, spread * 1.25) });
  });
  if (out.length === 0 && centres.length) out.push({ centre: centres[0], radius: minRadius });
  return out;
}

/** Tolerance (the UI's 5–120) → the smallest radius of a backdrop colour (ΔE76). 40 → about 12. */
export function radiusFor(tolerance: number): number {
  return 2 + Math.max(0, tolerance) * 0.25;
}

/** A 3×3 mean of one plane (at the edges only the pixels that exist are averaged). */
export function blur3(P: Float32Array, w: number, h: number): Float32Array {
  const o = new Float32Array(P.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) { s += P[yy * w + xx]; c++; }
    }
    o[y * w + x] = s / c;
  }
  return o;
}

/**
 * RGBA pixels with the background made transparent. `tolerance` (5–120, as in Assets): how far a colour may be from the
 * background. `enclosed`: also remove background-coloured areas that do not touch the border.
 */
export function cutoutPixels(src: Uint8ClampedArray, w: number, h: number, tolerance: number, enclosed = false): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src);
  const n = w * h;
  if (n === 0) return out;
  const { L, a, b } = toLab(src, n);
  const at = (i: number): Vec => [L[i], a[i], b[i]];

  // the border ring is the backdrop's sample; transparent pixels of the source are not backdrop, they are already empty
  const ring = Math.max(1, Math.round(Math.min(w, h) * 0.02));
  const ringCount = w * h - Math.max(0, w - 2 * ring) * Math.max(0, h - 2 * ring);
  const step = Math.max(1, Math.floor(ringCount / 3000));
  const samples: Vec[] = [];
  let seen = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!(x < ring || y < ring || x >= w - ring || y >= h - ring)) continue;
    const i = y * w + x;
    if (src[i * 4 + 3] >= 16 && seen++ % step === 0) samples.push(at(i));
  }
  const colours = backdropColours(samples, radiusFor(tolerance));

  // how many radii a pixel is away from the nearest backdrop colour (at most 1: it is backdrop)
  const near = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (src[i * 4 + 3] < 16) { near[i] = 0; continue; }
    const p = at(i);
    let best = Infinity;
    for (const c of colours) { const d = dE(p, c.centre) / c.radius; if (d < best) best = d; }
    near[i] = best;
  }
  // the backdrop mask: smoothed, so that noise does not punch holes in the backdrop
  const mask = blur3(near, w, h);

  const bg = new Uint8Array(n);
  if (enclosed) {
    for (let i = 0; i < n; i++) if (mask[i] <= 1) bg[i] = 1;
  } else {
    const queue = new Int32Array(n);
    let head = 0, tail = 0;
    const seed = (i: number) => { if (!bg[i] && mask[i] <= 1 && near[i] <= 1.5) { bg[i] = 1; queue[tail++] = i; } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    const join = (q: number) => { if (!bg[q] && mask[q] <= 1) { bg[q] = 1; queue[tail++] = q; } };
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      if (x > 0) join(i - 1);
      if (x < w - 1) join(i + 1);
      if (i >= w) join(i - w);
      if (i < n - w) join(i + w);
    }
  }

  // transparent where the background is; a soft edge on the object pixels that touch it
  for (let i = 0; i < n; i++) {
    if (bg[i]) { out[i * 4 + 3] = 0; continue; }
    if (near[i] > 2) continue;
    const x = i % w;
    const touches = (x > 0 && bg[i - 1]) || (x < w - 1 && bg[i + 1]) || (i >= w && bg[i - w]) || (i < n - w && bg[i + w]);
    if (touches) out[i * 4 + 3] = Math.round(out[i * 4 + 3] * Math.min(1, Math.max(0, near[i] - 1)));
  }
  return out;
}
