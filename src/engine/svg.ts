import { imageRect, pathD, polygonPoints, starPoints } from './draw';
import type { Item, Scene } from './scene';

export interface SvgOptions {
  /** Returns a data: URI (or external URL) for an image item's bitmap, or null to draw a placeholder. */
  imageUri?: (it: Item) => string | null;
  /** CSS (@font-face rules) embedded in <defs><style> so the file is self-contained. */
  fontCss?: string;
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const num = (n: number) => String(Math.round(n * 1000) / 1000);
const pts = (a: [number, number][]) => a.map(([x, y]) => `${num(x)},${num(y)}`).join(' ');

function paint(it: Item): string {
  let s = ` fill="${it.fill ? esc(it.fill) : 'none'}"`;
  if (it.stroke && it.strokeWidth > 0) {
    s += ` stroke="${esc(it.stroke)}" stroke-width="${num(it.strokeWidth)}" stroke-linejoin="round"`;
    if (it.dash) s += ` stroke-dasharray="${it.dash.join(' ')}"`;
  }
  return s;
}

function shapeMarkup(it: Item): string {
  const { w, h } = it;
  switch (it.kind) {
    case 'rect': {
      const r = Math.min(it.radius, w / 2, h / 2);
      return `<rect width="${num(w)}" height="${num(h)}"${r > 0 ? ` rx="${num(r)}"` : ''}${paint(it)}/>`;
    }
    case 'ellipse': return `<ellipse cx="${num(w / 2)}" cy="${num(h / 2)}" rx="${num(w / 2)}" ry="${num(h / 2)}"${paint(it)}/>`;
    case 'line': return it.stroke ? `<line x1="0" y1="${num(h / 2)}" x2="${num(w)}" y2="${num(h / 2)}"${paint({ ...it, fill: null })}/>` : '';
    case 'polygon': return `<polygon points="${pts(polygonPoints(w, h, it.sides))}"${paint(it)}/>`;
    case 'star': return `<polygon points="${pts(starPoints(w, h, it.points, it.innerRatio))}"${paint(it)}/>`;
    case 'path': {
      const d = pathD(it);
      if (!d) return '';
      const closed = !!it.path?.closed;
      return `<path d="${d}"${paint(closed ? it : { ...it, fill: null })} stroke-linecap="round"/>`;
    }
    default: return '';
  }
}

export function sceneToSvg(scene: Scene, opts: SvgOptions = {}): string {
  const out: string[] = [];
  const defs: string[] = [];
  if (opts.fontCss) defs.push(`<style>${opts.fontCss}</style>`);
  let clipN = 0;

  scene.items.forEach((it) => {
    const tf = `translate(${num(it.cx)} ${num(it.cy)})${it.rotation ? ` rotate(${num(it.rotation)})` : ''} translate(${num(-it.w / 2)} ${num(-it.h / 2)})`;
    const op = it.opacity < 1 ? ` opacity="${num(it.opacity)}"` : '';
    let body = '';
    if (it.kind === 'text' && it.text) {
      const t = it.text, L = t.layout;
      const innerH = it.h - t.padding * 2;
      const y0 = t.padding + (t.vAlign === 'top' ? 0 : t.vAlign === 'middle' ? (innerH - L.contentHeight) / 2 : innerH - L.contentHeight);
      const x = t.align === 'left' ? t.padding : t.align === 'center' ? it.w / 2 : it.w - t.padding;
      const anchor = t.align === 'left' ? 'start' : t.align === 'center' ? 'middle' : 'end';
      const fam = esc(t.font.family.replace(/["\\]/g, ''));
      const deco = t.decoration !== 'none' ? ` text-decoration="${t.decoration}"` : '';
      const ls = t.font.letterSpacing ? ` letter-spacing="${num(t.font.letterSpacing)}"` : '';
      body = L.lines.map((line, i) => line
        ? `<text x="${num(x)}" y="${num(y0 + i * L.lineHeightPx + L.lineHeightPx / 2)}" text-anchor="${anchor}" dominant-baseline="central" xml:space="preserve" font-family="'${fam}', Jost, sans-serif" font-size="${num(L.fontSize)}" font-weight="${t.font.weight}" font-style="${t.font.style}"${ls}${deco} fill="${esc(t.color)}">${esc(line)}</text>`
        : '').join('');
    } else if (it.kind === 'image' && it.image) {
      const im = it.image;
      const r = Math.min(it.radius, it.w / 2, it.h / 2);
      const uri = im.bitmap && opts.imageUri ? opts.imageUri(it) : null;
      if (uri && im.bitmap) {
        const bm = im.bitmap as { width: number; height: number };
        const g = imageRect(bm.width, bm.height, it.w, it.h, im.fit, im.focalX, im.focalY);
        const id = `clip${clipN++}`;
        defs.push(`<clipPath id="${id}"><rect width="${num(it.w)}" height="${num(it.h)}"${r > 0 ? ` rx="${num(r)}"` : ''}/></clipPath>`);
        body = `<g clip-path="url(#${id})"><image href="${esc(uri)}" x="${num(g.dx)}" y="${num(g.dy)}" width="${num(g.dw)}" height="${num(g.dh)}" preserveAspectRatio="none"/></g>`;
      } else {
        body = `<rect width="${num(it.w)}" height="${num(it.h)}"${r > 0 ? ` rx="${num(r)}"` : ''} fill="#E8EDF3"/>`;
      }
      if (it.stroke && it.strokeWidth > 0) {
        body += `<rect width="${num(it.w)}" height="${num(it.h)}"${r > 0 ? ` rx="${num(r)}"` : ''} fill="none" stroke="${esc(it.stroke)}" stroke-width="${num(it.strokeWidth)}"/>`;
      }
    } else if (it.kind === 'plugin') {
      body = it.custom?.svg?.(it.w, it.h) ?? '';
    } else {
      body = shapeMarkup(it);
    }
    if (body) out.push(`<g transform="${tf}"${op} data-node="${esc(it.id)}">${body}</g>`);
  });

  const bg = scene.background ? `<rect width="${num(scene.width)}" height="${num(scene.height)}" fill="${esc(scene.background)}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${num(scene.width)}" height="${num(scene.height)}" viewBox="0 0 ${num(scene.width)} ${num(scene.height)}">${defs.length ? `<defs>${defs.join('')}</defs>` : ''}${bg}${out.join('')}</svg>`;
}
