'use strict';
/**
 * DCE relay core — a tiny, dependency-free local helper.
 *
 * Used by the desktop app (started automatically) and by `npm run relay` for the browser build.
 * It exists because two things a browser page cannot do on its own:
 *   POST /buffer  — forward Buffer GraphQL calls (api.buffer.com sends no CORS headers);
 *   POST /fetch   — read PUBLIC web pages politely for the content pipeline (other sites send no CORS headers either).
 *
 * Security properties:
 *  - the caller binds it to 127.0.0.1 only — not reachable from other machines;
 *  - /buffer forwards ONLY to the fixed upstream host (default https://api.buffer.com); a request cannot choose the target;
 *  - /fetch only reads http(s) hosts that the app names in `hosts` (the sources you configured), re-checks that list on every
 *    redirect, refuses private / loopback / link-local addresses at connect time (no SSRF, no DNS rebinding), obeys robots.txt,
 *    waits at least 1.1 s between two requests to the same host, caps size (3 MB) and time (15 s), accepts only text types;
 *  - CORS is granted only to http(s)://localhost and http(s)://127.0.0.1 origins (plus `origins`);
 *  - API keys arrive per request in the Authorization header and are never stored or logged; bodies are capped at 1 MB.
 */
const { createServer } = require('node:http');
const https = require('node:https');
const http = require('node:http');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');
const { createCloud } = require('./cloud.cjs');

// ------------------------------------------------------------------------------------------------ polite fetching

const UA = 'DCE-ContentBot/1.1 (local desktop app; obeys robots.txt; max 1 request/second)';
const ROBOTS_TOKEN = 'dce-contentbot';
const MAX_PAGE = 3_000_000;
const TEXT_TYPE = /^(text\/|application\/(xml|json|rss\+xml|atom\+xml|xhtml\+xml)|.+\+xml)/i;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    if (m) return isPrivateIp(m[1]);
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  return true;
}

/** robots.txt → groups of { agents, rules:[{allow,pattern}], delay }. */
function parseRobots(text) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], delay: 0 }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if (cur && (key === 'allow' || key === 'disallow')) {
      lastWasAgent = false;
      if (val) cur.rules.push({ allow: key === 'allow', pattern: val });
    } else if (cur && key === 'crawl-delay') {
      lastWasAgent = false;
      const n = Number(val); if (Number.isFinite(n) && n > 0) cur.delay = n;
    } else lastWasAgent = false;
  }
  return groups;
}

function patternToRegex(p) {
  const end = p.endsWith('$');
  const body = (end ? p.slice(0, -1) : p).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + body + (end ? '$' : ''));
}

function groupFor(groups) {
  return groups.find((g) => g.agents.some((a) => a !== '*' && ROBOTS_TOKEN.includes(a))) || groups.find((g) => g.agents.includes('*')) || null;
}

/** Longest matching rule wins; on a tie Allow wins; no matching rule = allowed. */
function robotsAllows(groups, pathWithQuery) {
  const g = groupFor(groups);
  if (!g) return true;
  let best = null;
  for (const r of g.rules) {
    if (!patternToRegex(r.pattern).test(pathWithQuery)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bare = (h) => h.toLowerCase().replace(/^www\./, '');
const hostAllowed = (host, hosts) => hosts.some((h) => { const a = bare(h), b = bare(host); return a === b || b.endsWith('.' + a); });

function createFetcher(opts = {}) {
  const allowPrivate = !!opts.allowPrivate; // tests only: the mock site lives on 127.0.0.1
  const minDelay = Math.max(1100, opts.minDelayMs || 0);
  const lastAt = new Map();
  const chains = new Map();
  const robots = new Map(); // origin → { at, groups, disallowAll }

  function throttle(host, delayMs) {
    const prev = chains.get(host) || Promise.resolve();
    const next = prev.then(async () => {
      const wait = (lastAt.get(host) || 0) + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt.set(host, Date.now());
    });
    chains.set(host, next.catch(() => undefined));
    return next;
  }

  function lookup(hostname, options, cb) {
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return cb(err);
      const list = Array.isArray(address) ? address : [{ address, family }];
      if (!allowPrivate && list.some((a) => isPrivateIp(a.address))) return cb(new Error('Refusing to connect to a private or local address.'));
      return Array.isArray(address) ? cb(null, address) : cb(null, address, family);
    });
  }

  function rawGet(u) {
    // an IP literal never reaches the DNS lookup below, so it is checked here too
    const literal = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(literal) && isPrivateIp(literal)) return Promise.reject(new Error('Refusing to connect to a private or local address.'));
    return new Promise((resolve, reject) => {
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request(u, {
        method: 'GET', timeout: 15_000, lookup,
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5', 'accept-encoding': 'gzip, deflate, br' },
      }, (res) => {
        const status = res.statusCode || 0;
        const headers = res.headers;
        if (status >= 300 && status < 400 && headers.location) { res.resume(); return resolve({ status, headers, body: '' }); }
        const type = String(headers['content-type'] || '');
        if (status < 300 && type && !TEXT_TYPE.test(type)) { res.destroy(); return resolve({ status, headers, body: '', badType: type }); }
        let stream = res;
        const enc = String(headers['content-encoding'] || '').toLowerCase();
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks = []; let size = 0, over = false;
        stream.on('data', (c) => { size += c.length; if (size > MAX_PAGE) { over = true; res.destroy(); stream.destroy(); } else chunks.push(c); });
        stream.on('end', () => resolve({ status, headers, body: Buffer.concat(chunks).toString('utf8') }));
        stream.on('close', () => { if (over) resolve({ status, headers, body: Buffer.concat(chunks).toString('utf8'), truncated: true }); });
        stream.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('Timed out after 15 s.')));
      req.on('error', reject);
      req.end();
    });
  }

  async function robotsFor(u, hosts) {
    const cached = robots.get(u.origin);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached;
    await throttle(u.host, minDelay);
    const r = await rawGet(new URL('/robots.txt', u.origin));
    let entry;
    if (r.status >= 500) entry = { at: Date.now(), groups: [], disallowAll: true };        // server trouble: be conservative
    else if (r.status >= 400 || r.badType) entry = { at: Date.now(), groups: [], disallowAll: false }; // no robots.txt = allowed
    else entry = { at: Date.now(), groups: parseRobots(r.body), disallowAll: false };
    void hosts;
    robots.set(u.origin, entry);
    return entry;
  }

  /** Reads one public page. Never throws: errors come back as { ok:false, error, blocked? }. */
  async function fetchPage(url, hosts) {
    let u;
    try { u = new URL(url); } catch { return { ok: false, status: 0, error: 'Not a valid URL.' }; }
    for (let hop = 0; hop < 4; hop++) {
      if (!/^https?:$/.test(u.protocol)) return { ok: false, status: 0, error: 'Only http(s) pages can be read.', blocked: 'scheme' };
      if (!Array.isArray(hosts) || !hostAllowed(u.hostname, hosts)) return { ok: false, status: 0, error: `${u.hostname} is not one of your configured sources.`, blocked: 'host' };
      if (!allowPrivate && (u.hostname === 'localhost' || net.isIP(u.hostname) && isPrivateIp(u.hostname))) return { ok: false, status: 0, error: 'Local and private addresses are not allowed.', blocked: 'private' };
      try {
        const rb = await robotsFor(u, hosts);
        if (rb.disallowAll || !robotsAllows(rb.groups, u.pathname + u.search)) {
          return { ok: false, status: 0, error: `robots.txt of ${u.host} does not allow reading ${u.pathname}${u.search}.`, blocked: 'robots' };
        }
        const g = groupFor(rb.groups);
        await throttle(u.host, Math.max(minDelay, Math.min(10, (g && g.delay) || 0) * 1000));
        const r = await rawGet(u);
        if (r.status >= 300 && r.status < 400 && r.headers.location) { u = new URL(r.headers.location, u); continue; }
        if (r.badType) return { ok: false, status: r.status, error: `Unsupported content type (${r.badType}).` };
        if (r.status < 200 || r.status >= 300) return { ok: false, status: r.status, error: `HTTP ${r.status} from ${u.host}.` };
        return { ok: true, status: r.status, url: u.href, contentType: String(r.headers['content-type'] || ''), body: r.body, truncated: !!r.truncated };
      } catch (e) {
        return { ok: false, status: 0, error: `Could not reach ${u.host}: ${e && e.message ? e.message : e}` };
      }
    }
    return { ok: false, status: 0, error: 'Too many redirects.' };
  }

  /**
   * One request of the generic HTTP connector (any method, a text body, custom headers). Only to the hosts the connection names,
   * over https (http only in tests), never to private addresses, and redirects are not followed. Never throws.
   */
  async function apiCall(p) {
    let u;
    try { u = new URL(p.url); } catch { return { ok: false, status: 0, error: 'Not a valid address.', blocked: 'url' }; }
    if (!(u.protocol === 'https:' || (allowPrivate && u.protocol === 'http:'))) return { ok: false, status: 0, error: 'Only https:// addresses can be called.', blocked: 'scheme' };
    if (!Array.isArray(p.hosts) || !hostAllowed(u.hostname, p.hosts)) return { ok: false, status: 0, error: `${u.hostname} is not an allowed host for this connection.`, blocked: 'host' };
    const method = String(p.method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return { ok: false, status: 0, error: 'Method not allowed.', blocked: 'method' };
    const headers = {};
    for (const [k, v] of Object.entries(p.headers || {}).slice(0, 20)) {
      const name = String(k).toLowerCase();
      if (!/^[a-z0-9-]{1,60}$/.test(name) || ['host', 'content-length', 'connection', 'transfer-encoding', 'cookie'].includes(name)) continue;
      headers[name] = String(v).slice(0, 2000);
    }
    const body = p.body == null ? null : Buffer.from(String(p.body), 'utf8');
    if (body && body.length > 1_000_000) return { ok: false, status: 0, error: 'The request body is larger than 1 MB.', blocked: 'size' };
    const timeoutMs = Math.min(30_000, Math.max(1_000, Number(p.timeoutMs) || 20_000));
    const lib = u.protocol === 'http:' ? http : https;
    try {
      const r = await new Promise((resolve, reject) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        const req = lib.request(u, { method, timeout: timeoutMs, lookup, headers: body ? { ...headers, 'content-length': body.length } : headers }, (res) => {
          const chunks = []; let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size > MAX_PAGE) { finish({ status: res.statusCode || 0, contentType: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks).toString('utf8'), truncated: true }); res.destroy(); }
            else chunks.push(c);
          });
          res.on('end', () => finish({ status: res.statusCode || 0, contentType: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks).toString('utf8'), truncated: false }));
          res.on('error', (e) => { if (!done) reject(e); });
        });
        req.on('timeout', () => req.destroy(new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s.`)));
        req.on('error', (e) => { if (!done) reject(e); });
        if (body) req.write(body);
        req.end();
      });
      const redirected = r.status >= 300 && r.status < 400;
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        contentType: r.contentType,
        body: r.body,
        truncated: r.truncated,
        ...(redirected ? { error: 'The server redirected the request. The connector does not follow redirects; use the exact address.' } : {}),
      };
    } catch (e) {
      return { ok: false, status: 0, error: `Could not reach ${u.host}: ${e && e.message ? e.message : e}` };
    }
  }

  return { fetchPage, apiCall };
}

// ------------------------------------------------------------------------------------------------ the relay

// ------------------------------------------------------------------------------------------------ images for the batch

const IMAGE_MAX = 25 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 30_000;
const IMAGE_REDIRECTS = 5;
const IMAGE_PER_HOST = 3;
const IMAGE_UA = 'DCE-ImageFetch/1.0 (local desktop app; downloads the image linked in your records)';
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const hostSlots = new Map();

/** At most IMAGE_PER_HOST downloads at a time from one host. Resolves to the function that frees the slot. */
function takeImageSlot(host) {
  return new Promise((resolve) => {
    const s = hostSlots.get(host) || { active: 0, queue: [] };
    hostSlots.set(host, s);
    const go = () => { s.active++; resolve(() => { s.active--; const next = s.queue.shift(); if (next) next(); }); };
    if (s.active < IMAGE_PER_HOST) go(); else s.queue.push(go);
  });
}

/** The kind of image the bytes are, judged from their first bytes only (never from the name or the server's type). */
function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'jpeg', mime: 'image/jpeg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return { kind: 'png', mime: 'image/png' };
  if (buf.length >= 6) { const g = buf.toString('latin1', 0, 6); if (g === 'GIF87a' || g === 'GIF89a') return { kind: 'gif', mime: 'image/gif' }; }
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { kind: 'webp', mime: 'image/webp' };
  return null;
}

/** Why bytes that are not an accepted image were refused, in words for the person. */
function imageRefusal(buf) {
  const head = buf.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'The link leads to a web page, not to an image. Use the direct address of the image file.';
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'SVG files are not downloaded: they can contain scripts. Use a PNG, JPEG, WebP or GIF.';
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp' && /avif|avis|heic|heix|mif1/.test(buf.toString('latin1', 8, 12))) return 'This image is AVIF or HEIC, which is not supported. Use a JPEG, PNG, WebP or GIF.';
  return 'The file is not a JPEG, PNG, WebP or GIF image.';
}

const statusReason = (s) => {
  if (s === 404) return 'The image was not found (HTTP 404). Check the address.';
  if (s === 403) return 'The server refused to send the image (HTTP 403).';
  if (s === 410) return 'The image has been removed (HTTP 410).';
  if (s === 429) return 'The server is busy (HTTP 429). Try again later.';
  if (s >= 500) return `The server had an error (HTTP ${s}). Try again later.`;
  return `The server answered HTTP ${s}.`;
};

/** One GET of an image address. Private addresses are refused at connect time (after DNS), so no name can reach them. */
function getImageOnce(u, allowPrivate) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'http:' ? http : https;
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    // an IP literal never reaches the DNS lookup, so it is checked here
    const literal = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(literal) && isPrivateIp(literal)) { const e = new Error('private address'); e.code = 'PRIVATE'; return reject(e); }
    const req = lib.request(u, {
      method: 'GET', timeout: IMAGE_TIMEOUT_MS,
      lookup: (hostname, options, cb) => dns.lookup(hostname, options, (err, address, family) => {
        if (err) return cb(err);
        const list = Array.isArray(address) ? address : [{ address, family }];
        if (!allowPrivate && list.some((a) => isPrivateIp(a.address))) { const e = new Error('private address'); e.code = 'PRIVATE'; return cb(e); }
        return Array.isArray(address) ? cb(null, address) : cb(null, address, family);
      }),
      headers: { 'user-agent': IMAGE_UA, accept: 'image/jpeg,image/png,image/webp,image/gif;q=0.9,*/*;q=0.1', 'accept-encoding': 'identity' },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) { res.resume(); return finish(resolve, { status, location: res.headers.location }); }
      if (status !== 200) { res.resume(); return finish(resolve, { status }); }
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > IMAGE_MAX) { finish(resolve, { status, tooBig: true }); res.destroy(); } else chunks.push(c); });
      res.on('end', () => finish(resolve, { status, body: Buffer.concat(chunks) }));
      res.on('error', (e) => finish(reject, e));
      res.on('aborted', () => finish(reject, new Error('the connection was closed')));
    });
    req.on('timeout', () => req.destroy(new Error(`no answer within ${IMAGE_TIMEOUT_MS / 1000} s`)));
    req.on('error', (e) => finish(reject, e));
    req.end();
  });
}

/**
 * Downloads one image for the batch: https only (http only in tests), no private address, at most 5 redirects, each one
 * checked again, 30 s and 25 MB at most. Returns { ok, bytes, mime } or { ok: false, reason, retryable }.
 */
async function fetchImage(rawUrl, { allowPrivate = false, allowHttp = false } = {}) {
  const fail = (reason, retryable = false) => ({ ok: false, reason, retryable });
  let u;
  try { u = new URL(String(rawUrl || '').trim()); } catch { return fail('The address is not a valid web address.'); }
  for (let hop = 0; hop <= IMAGE_REDIRECTS; hop++) {
    if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return fail('Only https:// addresses can be downloaded.');
    const release = await takeImageSlot(u.host);
    let r;
    try { r = await getImageOnce(u, allowPrivate); }
    catch (e) {
      release();
      if (e && e.code === 'PRIVATE') return fail('The address points into a private network, which is not allowed.');
      return fail(`The image could not be downloaded (${e instanceof Error ? e.message : String(e)}).`, true);
    }
    release();
    if (r.location) { try { u = new URL(r.location, u); } catch { return fail('The server redirected to an invalid address.'); } continue; }
    if (r.tooBig) return fail(`The image is larger than ${IMAGE_MAX / 1024 / 1024} MB.`);
    if (r.status !== 200) return fail(statusReason(r.status), r.status === 429 || r.status >= 500);
    const sniffed = sniffImage(r.body);
    if (!sniffed) return fail(imageRefusal(r.body));
    return { ok: true, bytes: r.body, mime: sniffed.mime };
  }
  return fail('The link redirects too many times.');
}

function createRelay(opts = {}) {
  const upstream = new URL(opts.upstream || 'https://api.buffer.com');
  const extra = opts.origins || [];
  const MAX_BODY = 1_000_000;
  const fetcher = createFetcher({ allowPrivate: opts.allowPrivateFetch, minDelayMs: opts.minDelayMs });
  // cloud destinations (R2, Google Drive): the test options point Google at a local mock and allow plain http for it
  const cloud = createCloud({ ...(opts.cloud || {}), allowHttp: !!opts.allowPrivateFetch });
  const CLOUD_MAX = 40 * 1024 * 1024;
  const allowed = (o) => !!o && (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) || extra.includes(o));

  return createServer((req, res) => {
    const o = req.headers.origin;
    if (allowed(o)) {
      res.setHeader('access-control-allow-origin', o);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
      res.setHeader('access-control-max-age', '600');
    }
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (o && !allowed(o)) return json(403, { error: 'Origin not allowed.' });
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && req.url === '/health') return json(200, { ok: true, upstream: upstream.origin, features: ['buffer', 'fetch', 'http', 'cloud', 'image'] });
    // the Google sign-in comes back here (127.0.0.1 only): the tokens wait in memory until the app takes them
    if (req.method === 'GET' && req.url.startsWith('/google/callback')) {
      const q = Object.fromEntries(new URL(req.url, 'http://127.0.0.1').searchParams);
      return cloud.oauthCallback(q).then((r) => { res.writeHead(r.status, { 'content-type': 'text/html; charset=utf-8' }); res.end(r.html); });
    }
    if (req.method === 'POST' && req.url.startsWith('/cloud/')) {
      const route = req.url.slice('/cloud'.length);
      const chunks = []; let size = 0; let tooBig = false;
      req.on('data', (c) => { size += c.length; if (size > CLOUD_MAX) { tooBig = true; req.destroy(); } else chunks.push(c); });
      req.on('end', async () => {
        if (res.writableEnded) return;
        if (tooBig) return json(413, { ok: false, error: 'The file is larger than the 40 MB limit of one upload.' });
        let p;
        try { p = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return json(400, { ok: false, error: 'The request body must be JSON.' }); }
        p.host = req.headers.host || '';   // set by the server, never taken from the request body
        try { return json(200, await cloud.handle(route, p)); }
        catch (e) { return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
      });
      return;
    }
    if (req.method !== 'POST' || (req.url !== '/buffer' && req.url !== '/fetch' && req.url !== '/http' && req.url !== '/image')) return json(404, { error: 'Not found. POST /buffer, POST /fetch, POST /http, POST /image or GET /health.' });
    const isFetch = req.url === '/fetch';
    const isApi = req.url === '/http';
    const isImage = req.url === '/image';
    const auth = req.headers.authorization;
    if (!isFetch && !isApi && !isImage && (!auth || !/^Bearer\s+\S+$/.test(auth))) return json(401, { error: 'Missing Authorization: Bearer <Buffer API key>.' });

    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { json(413, { error: 'Body too large.' }); req.destroy(); } else chunks.push(c); });
    req.on('end', async () => {
      if (res.writableEnded) return;
      const body = Buffer.concat(chunks);
      if (isApi) {
        let p;
        try { p = JSON.parse(body.toString('utf8')); } catch { return json(400, { ok: false, error: 'Body must be JSON: { url, method, headers, body, hosts }.' }); }
        if (!p || typeof p.url !== 'string' || !Array.isArray(p.hosts)) return json(400, { ok: false, error: 'Body must be JSON: { url, method, headers, body, hosts }.' });
        return json(200, await fetcher.apiCall({ ...p, hosts: p.hosts.filter((h) => typeof h === 'string') }));
      }
      if (isFetch) {
        let p;
        try { p = JSON.parse(body.toString('utf8')); } catch { return json(400, { ok: false, error: 'Body must be JSON: { url, hosts }.' }); }
        if (!p || typeof p.url !== 'string' || !Array.isArray(p.hosts)) return json(400, { ok: false, error: 'Body must be JSON: { url, hosts }.' });
        return json(200, await fetcher.fetchPage(p.url, p.hosts.filter((h) => typeof h === 'string')));
      }
      if (isImage) {
        let p;
        try { p = JSON.parse(body.toString('utf8')); } catch { return json(400, { ok: false, error: 'Body must be JSON: { url }.' }); }
        const got = await fetchImage(p && typeof p.url === 'string' ? p.url : '', { allowPrivate: !!opts.allowPrivateFetch, allowHttp: !!opts.allowPrivateFetch });
        if (!got.ok) return json(200, { ok: false, error: got.reason, retryable: got.retryable });
        return json(200, { ok: true, mime: got.mime, bytes: got.bytes.length, base64: got.bytes.toString('base64') });
      }
      const send = upstream.protocol === 'http:' ? http.request : https.request;
      const up = send({
        hostname: upstream.hostname, port: upstream.port || undefined, path: upstream.pathname || '/', method: 'POST', timeout: 30_000,
        headers: { 'content-type': 'application/json', authorization: auth, 'content-length': body.length, accept: 'application/json' },
      }, (ur) => {
        res.writeHead(ur.statusCode || 502, { 'content-type': ur.headers['content-type'] || 'application/json' });
        ur.pipe(res);
      });
      up.on('timeout', () => up.destroy(new Error('Upstream timeout')));
      up.on('error', (e) => { if (!res.headersSent) json(502, { error: `Could not reach Buffer: ${e.message}` }); else res.end(); });
      up.end(body);
    });
  });
}

module.exports = { createRelay, createFetcher, parseRobots, robotsAllows, isPrivateIp, UA, fetchImage, sniffImage };
