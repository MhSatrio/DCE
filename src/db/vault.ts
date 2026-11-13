/**
 * Secret storage. API keys are encrypted with AES-256-GCM before they touch IndexedDB. The key is a NON-EXTRACTABLE
 * CryptoKey kept in its own small database ("dce-vault"): JavaScript (including this app) can ask the browser to
 * encrypt / decrypt with it but can never read the key bytes, and exporting the main database shows only ciphertext.
 *
 * Honest limits: this protects against casual viewing, screenshots, database dumps and backups. It does not protect
 * against malware or a malicious browser extension running inside the same browser profile, and clearing site data
 * destroys the key (stored secrets then cannot be recovered — enter them again).
 */
const DB_NAME = 'dce-vault';
const STORE = 'keys';
const PREFIX = 'v1';

let keyPromise: Promise<CryptoKey> | null = null;

function openVault(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadOrCreateKey(): Promise<CryptoKey> {
  const db = await openVault();
  const existing = await new Promise<CryptoKey | undefined>((res, rej) => {
    const r = db.transaction(STORE).objectStore(STORE).get('device');
    r.onsuccess = () => res(r.result as CryptoKey | undefined);
    r.onerror = () => rej(r.error);
  });
  if (existing) { db.close(); return existing; }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(key, 'device');
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  db.close();
  return key;
}

const deviceKey = (): Promise<CryptoKey> => (keyPromise ??= loadOrCreateKey());

const b64 = (b: ArrayBuffer | Uint8Array) => { const u = b instanceof Uint8Array ? b : new Uint8Array(b); let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const isEncrypted = (s: string | undefined): boolean => !!s && s.startsWith(PREFIX + '.');

export async function encryptSecret(plain: string, key?: CryptoKey): Promise<string> {
  const k = key ?? (await deviceKey());
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(plain));
  return `${PREFIX}.${b64(iv)}.${b64(ct)}`;
}

export async function decryptSecret(token: string, key?: CryptoKey): Promise<string> {
  const [v, iv, ct] = token.split('.');
  if (v !== PREFIX || !iv || !ct) throw new Error('Not an encrypted value.');
  const k = key ?? (await deviceKey());
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, k, unb64(ct));
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error('This secret cannot be decrypted on this browser (the vault key is gone). Enter it again.');
  }
}

/** For tests: a throw-away key so Node's WebCrypto can be exercised without IndexedDB. */
export const testKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
