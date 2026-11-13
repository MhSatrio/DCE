import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composePost } from '../../src/pipeline/compose';
import { normUrl, parseFeed, parsePage, parseSitemap, sniffFeed, toCandidates, urlAllowedBySource } from '../../src/pipeline/extract';
import { GeminiError, pickModel, withBackoff } from '../../src/pipeline/gemini';
import { assemblePost, checkEdited, checkRules, cleanHashtags, DEFAULT_BANNED, numbersIn, parseJsonLoose, type Draft } from '../../src/pipeline/guard';
import { DEFAULT_CONFIG, dueDecision, EMPTY_STATE, localDay, normaliseModel, pickCandidates, publishDueAt, sourceOrder, usedUrls, atLocalTime } from '../../src/pipeline/plan';

const relay = createRequire(import.meta.url)('../../server/relay-core.cjs') as {
  parseRobots: (t: string) => unknown[]; robotsAllows: (g: unknown[], p: string) => boolean; isPrivateIp: (ip: string) => boolean;
  createFetcher: (o: { allowPrivate?: boolean }) => { fetchPage: (u: string, h: string[]) => Promise<{ ok: boolean; status: number; body?: string; error?: string; blocked?: string; url?: string }> };
};

// ------------------------------------------------------------------------------------------------ extraction
describe('sitemaps, feeds and pages', () => {
  const urlset = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>https://x.org/</loc><lastmod>2026-01-01</lastmod></url>
    <url><loc>https://x.org/articles/a</loc><lastmod>2026-03-01T00:00:00Z</lastmod></url>
    <url><loc>https://x.org/articles/b/?utm_source=z#top</loc><lastmod>2026-05-01</lastmod></url>
    <url><loc>https://x.org/about</loc></url>
    <url><loc>https://other.com/articles/c</loc></url></urlset>`;
  it('recognises the document type', () => {
    expect(sniffFeed(urlset)).toBe('urlset');
    expect(sniffFeed('<sitemapindex><sitemap><loc>https://x.org/s.xml</loc></sitemap></sitemapindex>')).toBe('index');
    expect(sniffFeed('<rss version="2.0"><channel></channel></rss>')).toBe('feed');
    expect(sniffFeed('<html></html>')).toBe('unknown');
  });
  it('lists urls and child sitemaps', () => {
    expect(parseSitemap(urlset).entries).toHaveLength(5);
    const idx = parseSitemap('<sitemapindex><sitemap><loc>https://x.org/1.xml</loc></sitemap><sitemap><loc><![CDATA[https://x.org/2.xml]]></loc></sitemap></sitemapindex>');
    expect(idx.kind).toBe('index');
    expect(idx.entries.map((e) => e.loc)).toEqual(['https://x.org/1.xml', 'https://x.org/2.xml']);
  });
  it('turns entries into candidates: same site, rules applied, newest first, tracking removed', () => {
    const c = toCandidates(parseSitemap(urlset).entries, 'https://x.org', '/articles/', '');
    expect(c.map((x) => x.url)).toEqual(['https://x.org/articles/b', 'https://x.org/articles/a']);
    expect(toCandidates(parseSitemap(urlset).entries, 'https://www.x.org', '', '/about').map((x) => x.url)).not.toContain('https://x.org/about');
    expect(toCandidates(parseSitemap(urlset).entries, 'https://x.org', '', '').some((x) => x.url === 'https://x.org')).toBe(false); // home page
  });
  it('include / exclude patterns, including regular expressions', () => {
    expect(urlAllowedBySource('https://x.org/blog/a', '/blog/, /news/', '')).toBe(true);
    expect(urlAllowedBySource('https://x.org/shop/a', '/blog/, /news/', '')).toBe(false);
    expect(urlAllowedBySource('https://x.org/blog/draft-1', '/blog/', 'draft')).toBe(false);
    expect(urlAllowedBySource('https://x.org/blog/2026/a', 're:/blog/\\d{4}/', '')).toBe(true);
  });
  it('normUrl is the never-twice key', () => {
    expect(normUrl('https://X.org/a/?utm_medium=e&id=2#h')).toBe('https://x.org/a/?id=2');
    expect(normUrl('https://x.org/a/')).toBe(normUrl('https://x.org/a'));
  });
  it('reads RSS and Atom', () => {
    const rss = parseFeed(`<rss><channel><item><title>Hello &amp; welcome</title><link>https://x.org/p1</link><description><![CDATA[<p>Short <b>text</b></p>]]></description><pubDate>Mon, 02 Mar 2026 10:00:00 GMT</pubDate><enclosure url="https://x.org/i.jpg"/></item></channel></rss>`);
    expect(rss[0]).toMatchObject({ loc: 'https://x.org/p1', title: 'Hello & welcome', summary: 'Short text', image: 'https://x.org/i.jpg' });
    const atom = parseFeed(`<feed><entry><title>T</title><link rel="alternate" href="https://x.org/p2"/><updated>2026-01-01T00:00:00Z</updated></entry></feed>`);
    expect(atom[0].loc).toBe('https://x.org/p2');
  });
  it('reads title, description, image and the visible paragraphs of a page', () => {
    const html = `<html><head><title>Fallback | Site</title><meta property="og:title" content="Real &amp; true"><meta property="og:description" content="About it"><meta property="og:image" content="/img/a.jpg"><link rel="canonical" href="/x"></head>
      <body><nav><p>menu junk</p></nav><main><h1>Heading</h1><p>First paragraph with <a href="#">a link</a>.</p><script>var p='<p>no</p>'</script><p>Second one.</p></main><footer><p>footer junk</p></footer></body></html>`;
    const p = parsePage(html, 'https://x.org/articles/a');
    expect(p.title).toBe('Real & true');
    expect(p.description).toBe('About it');
    expect(p.image).toBe('https://x.org/img/a.jpg');
    expect(p.canonical).toBe('https://x.org/x');
    expect(p.text).toContain('First paragraph with a link.');
    expect(p.text).toContain('Second one.');
    expect(p.text).not.toMatch(/junk|var p/);
  });
});

// ------------------------------------------------------------------------------------------------ guardrails
const src = { url: 'https://x.org/articles/a', text: 'Lab pipettes should be calibrated every 12 months. A typical set costs $120. Accuracy of 0.5% is common.' };
const opts = { maxChars: 500, bannedPhrases: DEFAULT_BANNED };
const good: Draft = { hook: 'Is your pipette still accurate?', lines: ['Calibrate every 12 months.', 'Accuracy of 0.5% is common.'], cta: 'Read the full guide.', hashtags: ['Lab', '#Pipettes', 'science'] };

describe('post assembly and rules', () => {
  it('puts the source link in, from code', () => {
    const { text, beforeLink } = assemblePost(good, src.url);
    expect(text).toContain(`\n${src.url}\n`);
    expect(text.endsWith('#Lab #Pipettes #science')).toBe(true);
    expect(beforeLink).not.toContain('http');
  });
  it('accepts a good draft', () => { expect(checkRules(good, src, opts).every((r) => r.ok)).toBe(true); });
  const fails = (d: Draft, rule: string) => checkRules(d, src, opts).find((r) => r.rule === rule)!.ok === false;
  it('rejects medical claims and outcome promises', () => {
    expect(fails({ ...good, lines: ['Guaranteed accurate results.', 'Calibrate often.'] }, 'claims')).toBe(true);
    expect(fails({ ...good, lines: ['It cures bad data.', 'Calibrate often.'] }, 'claims')).toBe(true);
    expect(fails({ ...good, lines: ['A 100% safe method.', 'Calibrate often.'] }, 'claims')).toBe(true);
    expect(fails({ ...good, lines: ['Accurate enough.', 'We cure nothing.'] }, 'claims')).toBe(true);
    expect(fails({ ...good, lines: ['Procure supplies.', 'Calibrate often.'] }, 'claims')).toBe(false); // whole words only
  });
  it('rejects invented numbers and prices but accepts the ones in the source', () => {
    expect(fails({ ...good, lines: ['Costs just $99.', 'Calibrate often.'] }, 'numbers')).toBe(true);
    expect(fails({ ...good, lines: ['Save 30% today.', 'Calibrate often.'] }, 'numbers')).toBe(true);
    expect(fails({ ...good, lines: ['A set costs $120.', 'Calibrate every 12 months.'] }, 'numbers')).toBe(false);
    expect(fails({ ...good, lines: ['Three simple tips.', 'Step 2 matters.'] }, 'numbers')).toBe(false); // single digits are not claims
    expect(numbersIn('Rp 1.500.000 and 12,5%')).toEqual(expect.arrayContaining(['1500000', '12.5']));
    expect(numbersIn('$1,200 or 1200')).toEqual(['1200']);
  });
  it('checks length, hashtags, structure and links', () => {
    expect(fails({ ...good, lines: ['x'.repeat(260), 'y'.repeat(260)] }, 'length')).toBe(true);
    expect(fails({ ...good, hashtags: ['a', 'b'] }, 'hashtags')).toBe(true);
    expect(fails({ ...good, hashtags: ['a', 'b', 'c', 'd', 'e', 'f'] }, 'hashtags')).toBe(true);
    expect(fails({ ...good, lines: ['only one'] }, 'structure')).toBe(true);
    expect(fails({ ...good, cta: 'Visit https://evil.example now' }, 'link')).toBe(true);
    expect(cleanHashtags(['#A b!', 'a B', 'x'])).toEqual(['#Ab', '#x']);
  });
  it('re-checks a human-edited post', () => {
    const { text } = assemblePost(good, src.url);
    expect(checkEdited(text, src, opts).every((r) => r.ok)).toBe(true);
    expect(checkEdited(text.replace('Calibrate', 'Guaranteed calibration'), src, opts).some((r) => r.rule === 'claims' && !r.ok)).toBe(true);
    expect(checkEdited(text.replace(src.url, 'https://evil.example/x'), src, opts).some((r) => r.rule === 'link' && !r.ok)).toBe(true);
  });
  it('parses model JSON leniently', () => {
    expect(parseJsonLoose<{ a: number }>('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose<{ a: number }>('Sure! {"a":2} done')).toEqual({ a: 2 });
    expect(parseJsonLoose('nope')).toBeNull();
  });
});

describe('write → check → rewrite loop (fake models)', () => {
  const s = { title: 'Pipettes', url: src.url, summary: '', text: src.text };
  const o = { ...opts, voice: 'plain' };
  const json = (d: Draft) => JSON.stringify(d);
  it('publishes a draft that passes both checks', async () => {
    const r = await composePost(s, o, { write: async () => json(good), verify: async () => '{"ok":true,"issues":[]}' });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.guard.verifier?.ok).toBe(true); expect(r.guard.attempts).toBe(1); }
  });
  it('feeds rule failures back to the writer and accepts the second draft', async () => {
    const prompts: string[] = [];
    let n = 0;
    const r = await composePost(s, o, {
      write: async (p) => { prompts.push(p.user); return json(n++ === 0 ? { ...good, lines: ['Guaranteed results.', 'Calibrate often.'] } : good); },
      verify: async () => '{"ok":true,"issues":[]}',
    });
    expect(r.ok).toBe(true);
    expect(prompts[1]).toContain('rejected');
    expect(prompts[1]).toMatch(/guaranteed/i);
  });
  it('rejects when the reviewer model finds an unsupported claim, three times in a row', async () => {
    let writes = 0;
    const r = await composePost(s, o, { write: async () => { writes++; return json(good); }, verify: async () => '{"ok":false,"issues":["Not in the source: pipettes are waterproof"]}' });
    expect(r.ok).toBe(false);
    expect(writes).toBe(3);
    if (!r.ok) expect(r.reason).toMatch(/waterproof/);
  });
  it('fails closed when the reviewer answers with garbage', async () => {
    const r = await composePost(s, o, { write: async () => json(good), verify: async () => 'I think it is fine' });
    expect(r.ok).toBe(false);
  });
  it('does not swallow quota errors: the run must be retried, not published unchecked', async () => {
    await expect(composePost(s, o, { write: async () => json(good), verify: async () => { throw new GeminiError('quota', 'slow down', 429); } })).rejects.toBeInstanceOf(GeminiError);
  });
  it('backs off on quota errors and gives up on bad keys at once', async () => {
    let n = 0; const waits: number[] = [];
    const v = await withBackoff(async () => { if (++n < 3) throw new GeminiError('quota', 'q', 429); return 'ok'; }, { sleep: async (ms) => { waits.push(ms); } });
    expect(v).toBe('ok'); expect(waits).toEqual([2000, 6000]);
    let m = 0;
    await expect(withBackoff(async () => { m++; throw new GeminiError('auth', 'bad key', 403); }, { sleep: async () => undefined })).rejects.toThrow('bad key');
    expect(m).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------ plan
describe('schedule and selection', () => {
  const day = new Date(2026, 10, 12, 0, 0).getTime();
  const at = (h: number, m = 0) => day + (h * 60 + m) * 60_000;
  const cfg = { ...DEFAULT_CONFIG, enabled: true, dailyTime: '09:00' };
  it('runs once a day after the daily time, and catches up when opened late', () => {
    expect(dueDecision(cfg, EMPTY_STATE, at(8, 59)).run).toBe(false);
    expect(dueDecision(cfg, EMPTY_STATE, at(9, 0))).toEqual({ run: true, trigger: 'schedule' });
    expect(dueDecision(cfg, EMPTY_STATE, at(17))).toEqual({ run: true, trigger: 'schedule' });
    expect(dueDecision(cfg, { ...EMPTY_STATE, day: localDay(at(9)), done: true, attempts: 1, lastAttempt: at(9) }, at(10)).run).toBe(false);
    expect(dueDecision(cfg, { ...EMPTY_STATE, day: localDay(at(9)), done: true }, at(9) + 24 * 3600_000).run).toBe(true);
    expect(dueDecision({ ...cfg, enabled: false }, EMPTY_STATE, at(12)).run).toBe(false);
  });
  it('retries after 5 minutes, three attempts a day at most', () => {
    const st = { ...EMPTY_STATE, day: localDay(at(9)), done: false, attempts: 1, lastAttempt: at(9) };
    expect(dueDecision(cfg, st, at(9, 4)).run).toBe(false);
    expect(dueDecision(cfg, st, at(9, 5))).toEqual({ run: true, trigger: 'retry' });
    expect(dueDecision(cfg, { ...st, attempts: 3 }, at(12)).run).toBe(false);
  });
  it('publish time is today if far enough ahead, otherwise tomorrow', () => {
    const c = { ...cfg, publish: 'time' as const, publishTime: '12:00' };
    expect(publishDueAt({ ...cfg, publish: 'queue' }, at(9))).toBeUndefined();
    expect(publishDueAt(c, at(9))).toBe(new Date(atLocalTime(localDay(at(9)), '12:00')).toISOString());
    expect(new Date(publishDueAt(c, at(11, 59))!).getDate()).toBe(new Date(at(9)).getDate() + 1);
  });
  it('never repeats a URL; simulated posts only block while simulating', () => {
    const posts = [{ url: 'a', status: 'sent' as const }, { url: 'b', status: 'simulated' as const }, { url: 'c', status: 'failed' as const }, { url: 'd', status: 'rejected' as const }];
    expect([...usedUrls(posts, 'auto')].sort()).toEqual(['a', 'd']);
    expect([...usedUrls(posts, 'simulation')].sort()).toEqual(['a', 'b', 'd']);
  });
  it('sources take turns; sections rotate', () => {
    const mk = (id: string, t: number) => ({ id, name: id, baseUrl: '', feedUrl: '', include: '', exclude: '', enabled: true, simulationOnly: false, created_at: t });
    const order = sourceOrder([mk('s1', 1), mk('s2', 2), { ...mk('s3', 3), enabled: false }], [{ sourceId: 's1', created_at: 100 }]);
    expect(order.map((s) => s.id)).toEqual(['s2', 's1']);
    const c = (u: string) => ({ loc: u, url: u });
    const picked = pickCandidates([c('https://x.org/articles/1'), c('https://x.org/articles/2'), c('https://x.org/topics/3')], new Set(['https://x.org/articles/1']), 'https://x.org/articles/0', 2);
    expect(picked.map((x) => x.url)).toEqual(['https://x.org/topics/3', 'https://x.org/articles/2']);
  });
});

// ------------------------------------------------------------------------------------------------ relay: robots.txt, politeness, safety
describe('model choice', () => {
  it('Auto takes the newest Flash model: stable before preview, never lite / image / embedding / thinking', () => {
    expect(pickModel(['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-preview-image-generation', 'gemini-2.5-pro'])).toBe('gemini-3.8-flash');
    expect(pickModel(['gemini-2.5-flash-preview-09-2025', 'gemini-2.5-flash'])).toBe('gemini-2.5-flash');
    expect(pickModel(['gemini-2.5-flash-lite', 'gemini-2.5-pro'])).toBe('gemini-2.5-pro');
    expect(pickModel(['embedding-001'])).toBeUndefined();
    expect(pickModel([])).toBeUndefined();
  });
  it('an empty setting means Auto; a models/ prefix is removed', () => {
    expect(normaliseModel('')).toBe('auto');
    expect(normaliseModel(undefined)).toBe('auto');
    expect(normaliseModel(' models/gemini-3.8-flash ')).toBe('gemini-3.8-flash');
  });
});

describe('robots.txt', () => {
  const rb = relay.parseRobots(`User-agent: *\nDisallow: /admin\nDisallow: /articles?q=\nAllow: /admin/public\n\nUser-agent: DCE-ContentBot\nDisallow: /private/\n`);
  it('uses the group written for us and longest-match rules', () => {
    expect(relay.robotsAllows(rb, '/admin')).toBe(true); // our own group has no /admin rule
    expect(relay.robotsAllows(rb, '/private/x')).toBe(false);
    const star = relay.parseRobots(`User-agent: *\nDisallow: /admin\nDisallow: /articles?q=\nAllow: /admin/public\nDisallow: /*.pdf$`);
    expect(relay.robotsAllows(star, '/admin/secret')).toBe(false);
    expect(relay.robotsAllows(star, '/admin/public/x')).toBe(true);
    expect(relay.robotsAllows(star, '/articles?q=cats')).toBe(false);
    expect(relay.robotsAllows(star, '/articles/cats')).toBe(true);
    expect(relay.robotsAllows(star, '/files/a.pdf')).toBe(false);
    expect(relay.robotsAllows(star, '/files/a.pdf.html')).toBe(true);
  });
  it('treats several user-agent lines as one group and empty Disallow as allow-all', () => {
    const g = relay.parseRobots('User-agent: GPTBot\nUser-agent: *\nAllow: /\nDisallow: /video/5469/\n');
    expect(relay.robotsAllows(g, '/video/5469/x')).toBe(false);
    expect(relay.robotsAllows(g, '/video/1/')).toBe(true);
    expect(relay.robotsAllows(relay.parseRobots('User-agent: *\nDisallow:\n'), '/anything')).toBe(true);
    expect(relay.robotsAllows([], '/x')).toBe(true);
  });
  it('knows private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '100.64.0.1']) expect(relay.isPrivateIp(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111']) expect(relay.isPrivateIp(ip), ip).toBe(false);
  });
});

describe('polite fetching', () => {
  let server: Server; let base = ''; const hits: { path: string; at: number }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push({ path: req.url ?? '', at: Date.now() });
      const send = (code: number, type: string, body: string, h: Record<string, string> = {}) => { res.writeHead(code, { 'content-type': type, ...h }); res.end(body); };
      if (req.url === '/robots.txt') return send(200, 'text/plain', 'User-agent: *\nDisallow: /secret\n');
      if (req.url === '/page') return send(200, 'text/html', '<p>hello</p>');
      if (req.url === '/page2') return send(200, 'text/html', '<p>two</p>');
      if (req.url === '/secret') return send(200, 'text/html', 'should never be read');
      if (req.url === '/bin') return send(200, 'application/pdf', '%PDF');
      if (req.url === '/gone') return send(404, 'text/html', 'no');
      if (req.url === '/jump') return send(302, 'text/plain', '', { location: 'http://example.org/elsewhere' });
      send(404, 'text/plain', 'x');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); });

  it('reads an allowed page, never a robots-disallowed one, and waits at least 1 s between requests', async () => {
    const f = relay.createFetcher({ allowPrivate: true });
    const hosts = ['127.0.0.1'];
    hits.length = 0;
    const a = await f.fetchPage(`${base}/page`, hosts);
    expect(a).toMatchObject({ ok: true, status: 200, body: '<p>hello</p>' });
    const s = await f.fetchPage(`${base}/secret`, hosts);
    expect(s).toMatchObject({ ok: false, blocked: 'robots' });
    expect(hits.some((h) => h.path === '/secret')).toBe(false);
    const b = await f.fetchPage(`${base}/page2`, hosts);
    expect(b.ok).toBe(true);
    for (let i = 1; i < hits.length; i++) expect(hits[i].at - hits[i - 1].at, `${hits[i - 1].path} → ${hits[i].path}`).toBeGreaterThanOrEqual(1000);
    expect(hits.filter((h) => h.path === '/robots.txt')).toHaveLength(1); // cached
  }, 20_000);

  it('only reads configured hosts, text types, and refuses redirects to other hosts', async () => {
    const f = relay.createFetcher({ allowPrivate: true });
    expect(await f.fetchPage(`${base}/page`, ['example.com'])).toMatchObject({ ok: false, blocked: 'host' });
    expect(await f.fetchPage(`${base}/bin`, ['127.0.0.1'])).toMatchObject({ ok: false });
    expect(await f.fetchPage(`${base}/gone`, ['127.0.0.1'])).toMatchObject({ ok: false, status: 404 });
    expect(await f.fetchPage(`${base}/jump`, ['127.0.0.1'])).toMatchObject({ ok: false, blocked: 'host' });
    expect(await f.fetchPage('file:///etc/passwd', ['127.0.0.1'])).toMatchObject({ ok: false, blocked: 'scheme' });
  }, 30_000);

  it('refuses local addresses by default (no SSRF)', async () => {
    const f = relay.createFetcher({});
    expect(await f.fetchPage(`${base}/page`, ['127.0.0.1'])).toMatchObject({ ok: false, blocked: 'private' });
    expect(await f.fetchPage('http://localhost:1/x', ['localhost'])).toMatchObject({ ok: false, blocked: 'private' });
  });
});

// ------------------------------------------------------------------------------------------------ channels, sync, stop
import { channelPropKey, channelTitle, reconcileChannels, serviceLabel } from '../../src/pipeline/channels';
import { mergeRowData, postToData, STATUS_LABEL } from '../../src/pipeline/sync';
import { linked, sleepAbortable, StoppedError } from '../../src/pipeline/abort';
import type { PostRow } from '../../src/db/schema';

describe('Buffer channels', () => {
  it('derives unique property keys from service and name', () => {
    const taken = new Set<string>();
    expect(channelPropKey({ service: 'instagram', name: 'vierapparatus' }, taken)).toBe('BUFFER_CHANNEL_ID_INSTAGRAM_VIERAPPARATUS');
    taken.add('BUFFER_CHANNEL_ID_INSTAGRAM_VIERAPPARATUS');
    expect(channelPropKey({ service: 'instagram', name: 'vierapparatus' }, taken)).toBe('BUFFER_CHANNEL_ID_INSTAGRAM_VIERAPPARATUS_2');
    expect(channelPropKey({ service: 'linkedin', name: 'Vier Apparatus!' }, new Set())).toBe('BUFFER_CHANNEL_ID_LINKEDIN_VIER_APPARATUS');
  });
  it('matches saved ids to the live list, flags stale ones and returns the new channels', () => {
    const live = [
      { id: 'a1', name: 'vierapparatus', service: 'instagram', org: 'Vier' },
      { id: 'b2', name: 'Vier Apparatus', service: 'linkedin', org: 'Vier' },
      { id: 'c3', name: 'vierapparatus', service: 'instagram', org: 'Other' },
    ];
    const r = reconcileChannels([{ key: 'BUFFER_CHANNEL_ID_INSTAGRAM', id: 'a1' }, { key: 'OLD', id: 'gone' }], live);
    expect(r.linked.map((x) => x.key)).toEqual(['BUFFER_CHANNEL_ID_INSTAGRAM']);
    expect(r.stale).toEqual(['OLD']);
    expect(r.fresh.map((c) => c.id)).toEqual(['b2', 'c3']);
  });
  it('a channel saved twice is linked once and the duplicate is flagged', () => {
    const r = reconcileChannels([{ key: 'K1', id: 'a1' }, { key: 'K2', id: 'a1' }], [{ id: 'a1', name: 'x', service: 'instagram', org: '' }]);
    expect(r.linked.length).toBe(1);
    expect(r.stale).toEqual(['K2']);
  });
  it('labels show the service and the name, not the key', () => {
    expect(channelTitle({ key: 'BUFFER_CHANNEL_ID_LINKEDIN_VIER', meta: { service: 'linkedin', name: 'Vier', org: '' } })).toBe('LinkedIn · Vier');
    expect(channelTitle({ key: 'BUFFER_CHANNEL_ID_OLD_ONE' })).toBe('OLD ONE');
    expect(serviceLabel('googlebusiness')).toBe('Google Business');
    expect(serviceLabel('mastodon')).toBe('Mastodon');
  });
});

describe('table sync', () => {
  const post = { id: 'p1', title: 'Hello', sourceName: 'Lab', url: 'https://x.org/a', status: 'sent', text: 'T', detail: 'd', model: 'gemini-3.8-flash', channels: [{ key: 'K', label: 'LinkedIn · Vier', postId: 'buf1' }], created_at: Date.UTC(2026, 10, 12) } as unknown as PostRow;
  it('maps a post to the pipeline columns', () => {
    const d = postToData(post);
    expect(d.name).toBe('Hello');
    expect(d.status).toBe('Sent to Buffer');
    expect(d.post_id).toBe('buf1');
    expect(d.channels).toBe('LinkedIn · Vier (buf1)');
  });
  it('keeps the columns the user added and overwrites the pipeline columns', () => {
    const merged = mergeRowData({ name: 'old', notes: 'my note', status: 'Simulated' }, postToData(post));
    expect(merged.notes).toBe('my note');
    expect(merged.name).toBe('Hello');
    expect(merged.status).toBe('Sent to Buffer');
  });
  it('every post status has a label', () => {
    expect(Object.keys(STATUS_LABEL).sort()).toEqual(['failed', 'pending', 'rejected', 'sent', 'simulated']);
  });
});

describe('stop and time limits', () => {
  it('a wait ends early with StoppedError when the run is stopped', async () => {
    const ctl = new AbortController();
    const p = sleepAbortable(5000, ctl.signal);
    setTimeout(() => ctl.abort(), 10);
    await expect(p).rejects.toBeInstanceOf(StoppedError);
  });
  it('a wait finishes normally when nothing stops it', async () => {
    await expect(sleepAbortable(5, undefined)).resolves.toBeUndefined();
  });
  it('a linked signal fires when the parent aborts, and after its own time limit', async () => {
    const parent = new AbortController();
    const l = linked(parent.signal, 60_000);
    parent.abort();
    expect(l.signal.aborted).toBe(true);
    const t = linked(undefined, 10);
    await new Promise((r) => setTimeout(r, 40));
    expect(t.signal.aborted).toBe(true);
    expect(t.timedOut()).toBe(true);
    l.done();
    t.done();
  });
});
