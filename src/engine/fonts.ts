import jostNormalUrl from '@fontsource-variable/jost/files/jost-latin-wght-normal.woff2?url';
import jostItalicUrl from '@fontsource-variable/jost/files/jost-latin-wght-italic.woff2?url';
import { clearMeasureCache } from './textfit';

export const JOST_URLS = { normal: jostNormalUrl, italic: jostItalicUrl };

export interface FontPayload {
  family: string;
  weight: string;   // '400' or a range '100 900'
  style: 'normal' | 'italic';
  data: ArrayBuffer;
}

const fontSet = (): FontFaceSet => (typeof document !== 'undefined' ? document.fonts : (self as unknown as { fonts: FontFaceSet }).fonts);
const registered = new Set<string>();

export async function registerFontData(f: FontPayload): Promise<void> {
  const key = `${f.family}|${f.weight}|${f.style}|${f.data.byteLength}`;
  if (registered.has(key)) return;
  registered.add(key);
  const face = new FontFace(f.family, f.data, { weight: f.weight, style: f.style });
  await face.load();
  fontSet().add(face);
  clearMeasureCache();
}

let jostPromise: Promise<void> | null = null;
/** Registers the bundled Jost (variable weight, normal + italic) for canvas use. Idempotent. */
export function ensureJost(): Promise<void> {
  if (!jostPromise) {
    jostPromise = (async () => {
      const [n, i] = await Promise.all([
        fetch(JOST_URLS.normal).then((r) => r.arrayBuffer()),
        fetch(JOST_URLS.italic).then((r) => r.arrayBuffer()),
      ]);
      await registerFontData({ family: 'Jost', weight: '100 900', style: 'normal', data: n });
      await registerFontData({ family: 'Jost', weight: '100 900', style: 'italic', data: i });
    })();
  }
  return jostPromise;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

/** @font-face CSS embedding Jost so SVG/HTML exports are self-contained. Main thread only (cached). */
let jostCss: string | null = null;
export async function jostFontCss(): Promise<string> {
  if (jostCss) return jostCss;
  const [n, i] = await Promise.all([
    fetch(JOST_URLS.normal).then((r) => r.arrayBuffer()),
    fetch(JOST_URLS.italic).then((r) => r.arrayBuffer()),
  ]);
  const face = (b: ArrayBuffer, style: string) =>
    `@font-face{font-family:'Jost';font-style:${style};font-weight:100 900;src:url(data:font/woff2;base64,${bytesToBase64(new Uint8Array(b))}) format('woff2');}`;
  jostCss = face(n, 'normal') + face(i, 'italic');
  return jostCss;
}
