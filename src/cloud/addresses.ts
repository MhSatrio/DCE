/**
 * A link on a Cloudflare development address (pub-….r2.dev) is the same file under the bucket's own public address, when that
 * address is a custom domain: the path (the file's key) is kept. Returns that address, or null when the link needs no change.
 * Pure: the caller checks that the file is really there before it uses the new address.
 */
export function sameFileAt(link: string, currentBase: string): string | null {
  let u: URL;
  let base: URL;
  try { u = new URL(link); base = new URL(currentBase); } catch { return null; }
  if (!/\.r2\.dev$/i.test(u.hostname)) return null;                                          // not a development address
  if (/\.r2\.dev$/i.test(base.hostname) || base.hostname === u.hostname) return null;         // the bucket's address is one too, or the same
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}${u.pathname}${u.search}`;
}
