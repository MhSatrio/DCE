import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFillPrompt, parseFillOutput, parsePlaceholders, sourceTextOf } from '../../src/connector/fill';
import { getPath, asText, columnLabel, guessType } from '../../src/connector/paths';
import { isConnectorEvent, pageOf, rowIdOf, type ConnectorEvent } from '../../src/connector/events';

const relay = createRequire(import.meta.url)('../../server/relay-core.cjs') as {
  createFetcher: (o: { allowPrivate?: boolean }) => {
    apiCall: (p: { url: string; method?: string; headers?: Record<string, string>; body?: string; hosts: string[]; timeoutMs?: number }) => Promise<{ ok: boolean; status: number; body?: string; error?: string; blocked?: string }>;
  };
};

describe('placeholders and the Gemini prompt', () => {
  it('reads each placeholder once, with its description', () => {
    const p = parsePlaceholders('Write {{summary|two short sentences in plain English}} and a hook {{hook}}. Again {{summary|other}}.');
    expect(p).toEqual([
      { key: 'summary', description: 'two short sentences in plain English' },
      { key: 'hook', description: '' },
    ]);
  });

  it('ignores text that is not a placeholder', () => {
    expect(parsePlaceholders('No placeholders here, only {single braces} and {{ not closed')).toEqual([]);
  });

  it('shows the instructions with column names, and includes the source text', () => {
    const fields = parsePlaceholders('Summarise: {{summary|two sentences}}');
    const src = sourceTextOf({ title: 'Hello', url: 'https://example.org/a', excerpt: 'Short.', body: 'The body text.' });
    const p = buildFillPrompt('Summarise: {{summary|two sentences}}', fields, src);
    expect(p.user).toContain('Summarise: [summary]');
    expect(p.user).not.toContain('{{summary');
    expect(p.user).toContain('- summary: two sentences');
    expect(p.user).toContain('Title: Hello');
    expect(p.user).toContain('The body text.');
    expect(p.system).toContain('keys: summary');
  });

  it('takes the source text of an article and of a product', () => {
    expect(sourceTextOf({ title: 'A', excerpt: 'E', body: 'B' }).text).toBe('E\n\nB');
    const prod = sourceTextOf({ name: 'Centrifuge', shortDescription: 'Benchtop.', advantages: ['quiet', 'fast'], limitations: ['small'] });
    expect(prod.title).toBe('Centrifuge');
    expect(prod.text).toContain('Advantages: quiet; fast');
    expect(prod.text).toContain('Limitations: small');
  });
});

describe('checking what Gemini returned', () => {
  const fields = parsePlaceholders('{{summary|two sentences}} {{hook|one line}}');

  it('accepts a complete answer, even inside a code fence', () => {
    const r = parseFillOutput('```json\n{"summary": " Two sentences. ", "hook": "A hook"}\n```', fields);
    expect(r.problems).toEqual([]);
    expect(r.values).toEqual({ summary: 'Two sentences.', hook: 'A hook' });
  });

  it('reports each missing or empty column, and writes nothing for a partial answer', () => {
    const r = parseFillOutput('{"summary": "Only this one", "hook": ""}', fields);
    expect(r.problems).toEqual(['“hook” is empty.']);
  });

  it('refuses an answer that is not a JSON object', () => {
    expect(parseFillOutput('I cannot help with that.', fields).problems).toEqual(['Gemini did not return the expected JSON object.']);
    expect(parseFillOutput('["a","b"]', fields).problems).toEqual(['Gemini did not return the expected JSON object.']);
  });

  it('refuses a value longer than 5000 characters', () => {
    const r = parseFillOutput(JSON.stringify({ summary: 'x'.repeat(5001), hook: 'ok' }), fields);
    expect(r.problems[0]).toMatch(/too long/);
  });
});

describe('reading event values', () => {
  it('reads nested values by dot path and shows lists as text', () => {
    const payload = { title: 'T', author: { name: 'Ana' }, tags: ['a', 'b'], image: null };
    expect(getPath(payload, 'author.name')).toBe('Ana');
    expect(getPath(payload, 'author.missing')).toBeUndefined();
    expect(asText(getPath(payload, 'tags'))).toBe('a, b');
    expect(asText(getPath(payload, 'image'))).toBe('');
    expect(asText(getPath(payload, 'author'))).toBe('{"name":"Ana"}');
  });

  it('names columns and guesses their types', () => {
    expect(columnLabel('post_text')).toBe('Post text');
    expect(guessType('url', '')).toBe('url');
    expect(guessType('image', '')).toBe('url');
    expect(guessType('body', 'short')).toBe('longtext');
    expect(guessType('name', 'Short name')).toBe('text');
    expect(guessType('name', 'x'.repeat(201))).toBe('longtext');
  });

  it('accepts only well-formed events and reads the page of each kind', () => {
    const article: ConnectorEvent = { id: 7, createdAt: 't', type: 'article.published', entityId: 'a1', payload: { title: 'Hello', url: 'https://x.org/articles/hello', excerpt: 'Short', image: 'https://x.org/i.jpg' } };
    expect(isConnectorEvent(article)).toBe(true);
    expect(isConnectorEvent({ id: 'nope', type: 'x', entityId: 'y', payload: {} })).toBe(false);
    expect(isConnectorEvent(null)).toBe(false);
    expect(pageOf(article)).toEqual({ url: 'https://x.org/articles/hello', title: 'Hello', excerpt: 'Short', image: 'https://x.org/i.jpg' });
    const product: ConnectorEvent = { id: 8, createdAt: 't', type: 'product.reviewed', entityId: 'p9', payload: { name: 'Centrifuge', url: 'https://x.org/products/c', shortDescription: 'Benchtop.', imageUrl: 'https://x.org/c.jpg' } };
    expect(pageOf(product).title).toBe('Centrifuge');
    expect(pageOf(product).image).toBe('https://x.org/c.jpg');
    expect(rowIdOf(product)).toBe('product.reviewed:p9');
  });
});

describe('the generic HTTP call (relay /http)', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redir') { res.writeHead(302, { location: '/echo' }); return res.end(); }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null, body }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('sends the method, the headers and the body to an allowed host, and returns the answer', async () => {
    const f = relay.createFetcher({ allowPrivate: true });
    const r = await f.apiCall({ url: `${base}/echo?x=1`, method: 'POST', headers: { Authorization: 'Bearer t0ken', 'content-type': 'application/json' }, body: '{"hello":"world"}', hosts: ['127.0.0.1'] });
    expect(r.ok).toBe(true);
    const got = JSON.parse(r.body!);
    expect(got).toMatchObject({ method: 'POST', url: '/echo?x=1', authorization: 'Bearer t0ken', body: '{"hello":"world"}' });
  });

  it('refuses hosts that are not in the connection, and methods that are not allowed', async () => {
    const f = relay.createFetcher({ allowPrivate: true });
    expect(await f.apiCall({ url: `${base}/echo`, hosts: ['example.org'] })).toMatchObject({ ok: false, blocked: 'host' });
    expect(await f.apiCall({ url: `${base}/echo`, method: 'TRACE', hosts: ['127.0.0.1'] })).toMatchObject({ ok: false, blocked: 'method' });
  });

  it('does not follow redirects', async () => {
    const f = relay.createFetcher({ allowPrivate: true });
    const r = await f.apiCall({ url: `${base}/redir`, hosts: ['127.0.0.1'] });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(302);
    expect(r.error).toMatch(/does not follow redirects/);
  });

  it('requires https outside the tests, and never reaches a private address', async () => {
    const f = relay.createFetcher({});
    expect(await f.apiCall({ url: `${base}/echo`, hosts: ['127.0.0.1'] })).toMatchObject({ ok: false, blocked: 'scheme' });
    const priv = await f.apiCall({ url: 'https://127.0.0.1/echo', hosts: ['127.0.0.1'] });
    expect(priv.ok).toBe(false);
    expect(priv.status).toBe(0);
  });
});
