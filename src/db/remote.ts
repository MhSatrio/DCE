import { relayBase } from '../cloud/client';

/**
 * Images that a template takes from a web address in a record field. The address is read at render time: the image is
 * downloaded first (directly when the server allows it, otherwise through the local helper, which has no CORS limit),
 * and the bytes are then drawn like any other image. A small cache keeps an image that several records share.
 */

export type RemoteImage = { ok: true; blob: Blob } | { ok: false; reason: string };

const MAX_CACHE = 80;
const cache = new Map<string, Blob>();
const isWeb = (u: string) => /^https?:\/\//i.test(u);

/** The image at an address (https, or a data: / blob: address that is already local). */
export async function remoteImage(address: string): Promise<RemoteImage> {
  const key = address.trim();
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return { ok: true, blob: hit }; }
  const got = await download(key);
  if (got.ok) {
    cache.set(key, got.blob);
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
  }
  return got;
}

/**
 * A Google Drive share link (drive.google.com/file/d/ID/view, …/open?id=ID, …/uc?id=ID) as the address that sends the file
 * itself. Null for any other address.
 */
export function directDriveAddress(address: string): string | null {
  const m = /drive\.google\.com\/(?:file\/d\/|open\?(?:[^#]*&)?id=|uc\?(?:[^#]*&)?id=)([A-Za-z0-9_-]{10,})/.exec(address.trim());
  return m ? `https://drive.usercontent.google.com/download?id=${m[1]}&export=download` : null;
}

/** A file name for an imported image: the last part of the address when it is a file name, else the type's extension. */
export function imageNameFor(address: string, mime: string): string {
  const drive = /drive\.google\.com\/(?:file\/d\/|open\?(?:[^#]*&)?id=|uc\?(?:[^#]*&)?id=)([A-Za-z0-9_-]{10,})/.exec(address.trim());
  const ext = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' } as Record<string, string>)[mime] ?? '';
  if (drive) return `Google Drive image ${drive[1].slice(0, 8)}${ext}`;
  let last = '';
  try { last = decodeURIComponent(new URL(address).pathname.split('/').pop() ?? ''); } catch { /* not a URL */ }
  if (/\.(png|jpe?g|webp|gif)$/i.test(last)) return last;
  return `${last && last !== 'view' ? last : 'Web image'}${ext}`;
}

const DRIVE_SHARE = 'Google Drive did not send the file. Open the sharing settings of the file and choose “Anyone with the link”, then paste the link again.';

async function download(address: string): Promise<RemoteImage> {
  const drive = directDriveAddress(address);
  const target = drive ?? address;
  if (!isWeb(target)) {
    try {
      const r = await fetch(target);
      if (!r.ok) return { ok: false, reason: `The address answered HTTP ${r.status}.` };
      return { ok: true, blob: await r.blob() };
    } catch { return { ok: false, reason: 'The image address could not be read.' }; }
  }
  // 1) directly, when the server allows it (CORS)
  try {
    const r = await fetch(target, { mode: 'cors', credentials: 'omit' });
    // an answer that came back (CORS allowed it) is the address's own answer: a missing file is said so, as HTTP 404
    if (!r.ok) return { ok: false, reason: drive && (r.status === 401 || r.status === 403) ? DRIVE_SHARE : `The address answered HTTP ${r.status}.` };
    const blob = await r.blob();
    if (blob.type.startsWith('image/') && blob.size > 0) return { ok: true, blob };
  } catch { /* not allowed for a web page: the local helper downloads it instead */ }
  // 2) through the local helper, which checks the address and the bytes
  let res: Response;
  try {
    res = await fetch(`${await relayBase()}/image`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: target }) });
  } catch {
    return { ok: false, reason: 'The local helper is not running, so the image could not be downloaded. Start the app (in a browser, run “npm run relay”).' };
  }
  const j = await res.json().catch(() => null) as { ok?: boolean; mime?: string; base64?: string; error?: string } | null;
  if (!j?.ok || !j.base64) {
    const reason = j?.error ?? 'The local helper gave no image.';
    // Google sends a page instead of the file when the file is not shared for anyone to read
    return { ok: false, reason: drive && /web page|HTTP 40[13]/.test(reason) ? DRIVE_SHARE : reason };
  }
  return { ok: true, blob: new Blob([base64Bytes(j.base64)], { type: j.mime }) };
}

function base64Bytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Only for tests: forgets every downloaded image. */
export function clearRemoteImages(): void { cache.clear(); }
