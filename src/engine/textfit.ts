import type { NodeConstraints, OverflowPolicy } from './types';

export interface FontSpec {
  family: string;
  size: number;
  weight: number;
  style: string;
  letterSpacing: number;
}

export function fontString(f: FontSpec, size = f.size): string {
  const fam = f.family.replace(/["\\]/g, '');
  return `${f.style} ${f.weight} ${size}px "${fam}", Jost, system-ui, sans-serif`;
}

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

let mctx: Ctx2D | null = null;
function measureCtx(): Ctx2D {
  if (!mctx) {
    mctx = typeof OffscreenCanvas !== 'undefined'
      ? (new OffscreenCanvas(8, 8).getContext('2d') as OffscreenCanvasRenderingContext2D)
      : (document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D);
  }
  return mctx;
}

const widthCache = new Map<string, number>();
const layoutCache = new Map<string, TextLayout>();
export const textStats = { measureCalls: 0, measureHits: 0, layoutHits: 0, layoutMisses: 0 };

/** Must be called whenever a font finishes loading: cached widths of the fallback font are stale. */
export function clearMeasureCache(): void {
  widthCache.clear();
  layoutCache.clear();
}

export function textWidth(f: FontSpec, size: number, s: string): number {
  const key = `${f.style}|${f.weight}|${size}|${f.letterSpacing}|${f.family}|${s}`;
  const hit = widthCache.get(key);
  textStats.measureCalls++;
  if (hit !== undefined) { textStats.measureHits++; return hit; }
  const c = measureCtx();
  c.font = fontString(f, size);
  (c as { letterSpacing?: string }).letterSpacing = `${f.letterSpacing}px`;
  const w = c.measureText(s).width;
  if (widthCache.size > 60000) widthCache.clear();
  widthCache.set(key, w);
  return w;
}

export function wrapText(text: string, f: FontSpec, size: number, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    if (para === '') { out.push(''); continue; }
    const words = para.split(/ +/).filter((w) => w !== '');
    let line = '';
    for (const word of words) {
      const cand = line ? `${line} ${word}` : word;
      if (textWidth(f, size, cand) <= maxW) { line = cand; continue; }
      if (line) { out.push(line); line = ''; }
      if (textWidth(f, size, word) <= maxW) { line = word; continue; }
      // a single word wider than the frame: break by characters
      let chunk = '';
      for (const ch of Array.from(word)) {
        if (chunk && textWidth(f, size, chunk + ch) > maxW) { out.push(chunk); chunk = ch; } else chunk += ch;
      }
      line = chunk;
    }
    out.push(line);
  }
  return out;
}

function ellipsize(line: string, f: FontSpec, size: number, maxW: number): string {
  let s = line.replace(/[\s.,;:!?-]+$/, '');
  while (s.length > 0 && textWidth(f, size, s + '…') > maxW) s = s.slice(0, -1).trimEnd();
  return s + '…';
}

export interface TextLayoutParams {
  text: string;
  font: FontSpec;
  lineHeight: number;
  /** Inner box (frame minus padding). */
  width: number;
  height: number;
  constraints: NodeConstraints;
}

export interface TextLayout {
  lines: string[];
  fontSize: number;
  lineHeightPx: number;
  contentHeight: number;
  hidden: boolean;
  truncated: boolean;
  shrunk: boolean;
  overflowed: boolean;
  /** Inner height after the 'expand' policy. */
  frameHeight: number;
  reason?: string;
}

/**
 * Predictable text fitting. Steps: apply max-chars → measure with the real canvas font → compare to the
 * frame and max-lines → shrink in 0.5px steps (binary search) down to the minimum → fall back to the
 * overflow policy (ellipsis / hide). Results are memoised.
 */
export function layoutText(p: TextLayoutParams): TextLayout {
  const key = JSON.stringify([p.text, p.font, p.lineHeight, p.width, p.height, p.constraints]);
  const hit = layoutCache.get(key);
  if (hit) { textStats.layoutHits++; return hit; }
  textStats.layoutMisses++;
  const res = compute(p);
  if (layoutCache.size > 5000) layoutCache.clear();
  layoutCache.set(key, res);
  return res;
}

function compute(p: TextLayoutParams): TextLayout {
  const c = p.constraints;
  const policy: OverflowPolicy = c.overflow ?? 'multiline';
  const base = p.font.size;
  const empty = (hidden: boolean, reason?: string): TextLayout => ({
    lines: [], fontSize: base, lineHeightPx: base * p.lineHeight, contentHeight: 0, hidden,
    truncated: false, shrunk: false, overflowed: false, frameHeight: p.height, reason,
  });

  let text = p.text;
  if (text.trim() === '') return empty(policy === 'hide', 'empty');

  let truncated = false;
  if (c.maxChars && c.maxChars > 0 && Array.from(text).length > c.maxChars) {
    if (policy === 'hide') return empty(true, `longer than ${c.maxChars} characters`);
    text = Array.from(text).slice(0, Math.max(1, c.maxChars - 1)).join('').trimEnd() + '…';
    truncated = true;
  }

  const maxLines = c.maxLines && c.maxLines > 0 ? c.maxLines : Infinity;
  const heightCapped = policy !== 'multiline' && policy !== 'expand';
  const capAt = (size: number): number => {
    const byHeight = heightCapped ? Math.max(1, Math.floor(p.height / (size * p.lineHeight) + 1e-6)) : Infinity;
    return Math.min(maxLines, byHeight);
  };
  const attempt = (size: number) => {
    const lines = wrapText(text, p.font, size, p.width);
    return { lines, fits: lines.length <= capAt(size) };
  };
  const finish = (size: number, lines: string[], flags: Partial<TextLayout>): TextLayout => {
    const lhPx = size * p.lineHeight;
    const contentHeight = lines.length * lhPx;
    let frameHeight = p.height;
    if (policy === 'expand') {
      frameHeight = Math.max(p.height, contentHeight);
      if (c.maxExpandHeight && c.maxExpandHeight > 0) frameHeight = Math.min(frameHeight, Math.max(p.height, c.maxExpandHeight));
    }
    return {
      lines, fontSize: size, lineHeightPx: lhPx, contentHeight, hidden: false, truncated, shrunk: size < base,
      overflowed: contentHeight > frameHeight + 0.5, frameHeight, ...flags,
    };
  };
  const clampLines = (size: number, lines: string[]): string[] => {
    const cap = capAt(size);
    if (lines.length <= cap) return lines;
    const out = lines.slice(0, cap);
    out[cap - 1] = ellipsize(out[cap - 1], p.font, size, p.width);
    truncated = true;
    return out;
  };

  switch (policy) {
    case 'auto_shrink': {
      const hi = Math.max(c.maxFontSize && c.maxFontSize > 0 ? c.maxFontSize : base, 1);
      const lo = Math.min(c.minFontSize && c.minFontSize > 0 ? c.minFontSize : Math.max(6, Math.round(hi * 0.4)), hi);
      let a = attempt(hi);
      if (a.fits) return finish(hi, a.lines, {});
      let lowN = Math.round(lo * 2), highN = Math.round(hi * 2); // half-pixel steps
      let best = lowN;
      while (lowN <= highN) {
        const mid = (lowN + highN) >> 1;
        if (attempt(mid / 2).fits) { best = mid; lowN = mid + 1; } else highN = mid - 1;
      }
      const size = best / 2;
      a = attempt(size);
      if (a.fits) return finish(size, a.lines, {});
      return finish(size, clampLines(size, a.lines), {}); // still too long at the minimum → ellipsis
    }
    case 'truncate': {
      const a = attempt(base);
      return finish(base, clampLines(base, a.lines), {});
    }
    case 'hide': {
      const a = attempt(base);
      if (!a.fits) return empty(true, 'does not fit');
      return finish(base, a.lines, {});
    }
    case 'expand': {
      const a = attempt(base);
      const lines = Number.isFinite(maxLines) ? clampLines(base, a.lines) : a.lines;
      return finish(base, lines, {});
    }
    case 'multiline':
    default: {
      const a = attempt(base);
      const lines = Number.isFinite(maxLines) ? clampLines(base, a.lines) : a.lines;
      return finish(base, lines, {});
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Capacity estimate: "how much text fits in this frame?" — measured with the real font, not guessed from the size.

const FILLER = ('laboratory instruments measure each sample with careful precision while the quick operator records '
  + 'stable results and compares every reading against the calibrated reference before storing the final report for '
  + 'review by the whole research group at the end of a long working day').split(' ');

export interface Capacity { lines: number; chars: number; words: number; charsPerLine: number }

/**
 * Largest amount of typical English prose (average word ≈ 6 letters) that fits the frame at `size`, honouring the
 * frame height and an optional max-lines limit. Real text with many wide letters (W, M) fits a little less, narrow ones
 * (i, l) a little more — it is an estimate, shown as "about".
 */
export function estimateCapacity(f: FontSpec, size: number, width: number, height: number, lineHeight: number, maxLines?: number): Capacity {
  const byHeight = Math.max(1, Math.floor(height / (size * lineHeight) + 1e-6));
  const lines = Math.min(maxLines && maxLines > 0 ? maxLines : Infinity, byHeight);
  const words: string[] = [];
  for (let i = 0; i < 1200; i++) words.push(FILLER[i % FILLER.length]);
  let lo = 0, hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (wrapText(words.slice(0, mid).join(' '), f, size, width).length <= lines) lo = mid; else hi = mid - 1;
  }
  const text = words.slice(0, lo).join(' ');
  return { lines, words: lo, chars: text.length, charsPerLine: Math.round(text.length / Math.max(1, Math.min(lines, wrapText(text, f, size, width).length))) };
}
