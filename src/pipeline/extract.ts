/**
 * Pure parsers for the content pipeline (no DOM, no network — easy to test).
 *
 * Why sitemap / feed first and HTML second:
 *  - a sitemap (or RSS feed) is the site's own machine-readable list of pages, with the date each one changed — one request
 *    lists hundreds of URLs, it does not break when the page design changes and it is what the site invites crawlers to use;
 *  - scraping a listing page (“/blog”) needs CSS selectors that rot, paginates, and often renders with JavaScript;
 *  - the HTML of a single chosen page is read only to get title / description / image (Open Graph tags, stable by convention)
 *    and the visible paragraphs, which are the only facts the model is allowed to use.
 */

export interface SitemapEntry { loc: string; lastmod?: string; title?: string; summary?: string; image?: string }
export type FeedKind = 'urlset' | 'index' | 'feed' | 'unknown';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', eacute: 'é' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return Number.isFinite(code) ? String.fromCodePoint(code) : m; } catch { return m; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const unwrap = (s: string) => decodeEntities(s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')).trim();
const tag = (block: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? unwrap(m[1]) : undefined;
};
const blocks = (xml: string, name: string): string[] => {
  const out: string[] = [];
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi');
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1]);
  return out;
};

export function sniffFeed(xml: string): FeedKind {
  const head = xml.slice(0, 4000).toLowerCase();
  if (head.includes('<sitemapindex')) return 'index';
  if (head.includes('<urlset')) return 'urlset';
  if (head.includes('<rss') || head.includes('<feed') || head.includes('<rdf:rdf')) return 'feed';
  return 'unknown';
}

/** <urlset> → page entries; <sitemapindex> → child sitemap entries. */
export function parseSitemap(xml: string): { kind: 'urlset' | 'index'; entries: SitemapEntry[] } {
  const index = sniffFeed(xml) === 'index';
  const entries: SitemapEntry[] = [];
  for (const b of blocks(xml, index ? 'sitemap' : 'url')) {
    const loc = tag(b, 'loc');
    if (!loc) continue;
    entries.push({ loc, lastmod: tag(b, 'lastmod'), image: tag(b, 'image:loc') });
  }
  return { kind: index ? 'index' : 'urlset', entries };
}

/** RSS 2.0 <item> and Atom <entry>. */
export function parseFeed(xml: string): SitemapEntry[] {
  const out: SitemapEntry[] = [];
  for (const b of [...blocks(xml, 'item'), ...blocks(xml, 'entry')]) {
    let loc = tag(b, 'link');
    if (!loc || !/^https?:/i.test(loc)) {
      const href = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i.exec(b);
      loc = href ? decodeEntities(href[1]) : tag(b, 'guid');
    }
    if (!loc || !/^https?:/i.test(loc)) continue;
    const media = /<(?:media:content|media:thumbnail|enclosure)\b[^>]*\burl=["']([^"']+)["']/i.exec(b);
    const summary = tag(b, 'description') ?? tag(b, 'summary') ?? tag(b, 'content:encoded');
    out.push({
      loc, title: tag(b, 'title'), lastmod: tag(b, 'pubDate') ?? tag(b, 'updated') ?? tag(b, 'published') ?? tag(b, 'dc:date'),
      summary: summary ? htmlToText(summary).slice(0, 500) : undefined, image: media ? decodeEntities(media[1]) : undefined,
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ URLs

const TRACKING = /^(utm_|fbclid$|gclid$|mc_|ref$)/i;
/** The "never twice" key: no hash, no tracking parameters, no trailing slash, lower-case host. */
export function normUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (TRACKING.test(k)) x.searchParams.delete(k);
    x.hostname = x.hostname.toLowerCase();
    let s = x.toString();
    if (x.pathname !== '/' && s.endsWith('/') && !x.search) s = s.slice(0, -1);
    else if (x.pathname === '/' && !x.search) s = s.replace(/\/$/, '');
    return s;
  } catch { return u.trim(); }
}

const patterns = (raw: string): string[] => raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
function matchOne(url: string, pat: string): boolean {
  if (pat.startsWith('re:')) { try { return new RegExp(pat.slice(3), 'i').test(url); } catch { return false; } }
  return url.toLowerCase().includes(pat.toLowerCase());
}
export function urlAllowedBySource(url: string, include: string, exclude: string): boolean {
  const inc = patterns(include), exc = patterns(exclude);
  if (exc.some((p) => matchOne(url, p))) return false;
  return inc.length === 0 || inc.some((p) => matchOne(url, p));
}

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, '');
export const hostOf = (u: string): string => { try { return new URL(u).hostname; } catch { return ''; } };

export interface Candidate extends SitemapEntry { url: string }

/** Sitemap / feed entries → candidate pages of the source: same site, matching the include / exclude rules, not the home page. */
export function toCandidates(entries: SitemapEntry[], baseUrl: string, include: string, exclude: string): Candidate[] {
  const base = bareHost(hostOf(baseUrl));
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const root = normUrl(baseUrl);
  entries.forEach((e) => {
    if (bareHost(hostOf(e.loc)) !== base) return;
    const url = normUrl(e.loc);
    if (url === root || seen.has(url) || !urlAllowedBySource(url, include, exclude)) return;
    seen.add(url);
    out.push({ ...e, url });
  });
  const t = (c: Candidate) => { const n = Date.parse(c.lastmod ?? ''); return Number.isNaN(n) ? -Infinity : n; };
  return out.map((c, i) => ({ c, i })).sort((a, b) => t(b.c) - t(a.c) || a.i - b.i).map((x) => x.c);
}

// ------------------------------------------------------------------------------------------------ HTML

export interface PageInfo { title: string; description: string; image: string; canonical: string; text: string }

function attrs(tagText: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (let m = re.exec(tagText); m; m = re.exec(tagText)) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

export function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(a|b|i|u|em|strong|span|code|small|sup|sub|mark|abbr|font|cite)\b[^>]*>/gi, '').replace(/<[^>]+>/g, ' ')).replace(/[ \t\r\f\v ]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
}

const abs = (u: string, page: string): string => { try { return u ? new URL(u, page).href : ''; } catch { return ''; } };

/** Title, description, image and the readable paragraphs of one page. */
export function parsePage(html: string, pageUrl: string): PageInfo {
  const meta: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const k = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (k && a.content !== undefined && !(k in meta)) meta[k] = a.content;
  }
  let canonical = '';
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) { const a = attrs(m[0]); if ((a.rel || '').toLowerCase() === 'canonical' && a.href) { canonical = abs(a.href, pageUrl); break; } }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const title = (meta['og:title'] || (titleTag ? htmlToText(titleTag) : '') || (h1 ? htmlToText(h1) : '')).replace(/\s+/g, ' ').trim();
  const description = (meta['og:description'] || meta.description || meta['twitter:description'] || '').replace(/\s+/g, ' ').trim();
  const image = abs(meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || '', pageUrl);

  // readable text: drop page furniture, prefer <main> / <article>
  let body = html.replace(/<(script|style|noscript|svg|template|iframe|nav|header|footer|aside|form|button|details)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body) ?? /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(body);
  if (main) body = main[1];
  const parts: string[] = [];
  for (const m of body.matchAll(/<(h[1-3]|p|li|blockquote|figcaption|td|dd)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = htmlToText(m[2]).replace(/\s+/g, ' ').trim();
    if (t.length >= 3 && parts[parts.length - 1] !== t) parts.push(t);
  }
  return { title, description, image, canonical, text: parts.join('\n').slice(0, 6000) };
}
