import { db } from './schema';
import { walkNodes } from '../engine/njs';
import { bytesToBase64, type FontPayload } from '../engine/fonts';
import type { NjsDoc } from '../engine/types';

/** The database fonts that a design's text uses: their files for the renderers, and the CSS that embeds them in SVG / HTML. */
export async function customFontPayloads(doc: NjsDoc): Promise<{ payloads: FontPayload[]; css: string }> {
  const used = new Set<string>();
  for (const n of walkNodes(doc.nodes)) if (n.type === 'text' && n.style.fontFamily) used.add(n.style.fontFamily as string);
  const rows = (await db.fonts.toArray()).filter((f) => used.has(f.family));
  const payloads: FontPayload[] = [];
  let css = '';
  for (const r of rows) {
    const data = await r.blob.arrayBuffer();
    payloads.push({ family: r.family, weight: r.weight, style: r.style, data });
    css += `@font-face{font-family:'${r.family.replace(/'/g, '')}';font-style:${r.style};font-weight:${r.weight};src:url(data:font/woff2;base64,${bytesToBase64(new Uint8Array(data))});}`;
  }
  return { payloads, css };
}
