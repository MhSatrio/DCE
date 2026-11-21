import { createRequire } from 'node:module';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require_ = createRequire(import.meta.url);
const relayCore = require_('../../server/relay-core.cjs') as {
  createRelay: (o: Record<string, unknown>) => Server;
  fetchImage: (url: string, o?: { allowPrivate?: boolean; allowHttp?: boolean }) => Promise<
    { ok: true; bytes: Buffer; mime: string } | { ok: false; reason: string; retryable: boolean }
  >;
  sniffImage: (buf: Buffer) => { kind: string; mime: string } | null;
};

/** A valid PNG signature followed by padding (enough to be recognised, small to keep the test quick). */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);

let base = '';
let server: Server;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, type: string, body: Buffer | string, headers: Record<string, string> = {}) => {
      res.writeHead(code, { 'content-type': type, ...headers });
      res.end(body);
    };
    switch (req.url) {
      case '/a.png': return send(200, 'image/png', PNG);
      case '/b.jpg': return send(200, 'application/octet-stream', JPEG);
      case '/page': return send(200, 'image/png', '<!doctype html><html><body>not an image</body></html>');
      case '/svg': return send(200, 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      case '/missing': return send(404, 'text/plain', 'nope');
      case '/busy': return send(503, 'text/plain', 'later');
      case '/redirect': return send(302, 'text/plain', '', { location: '/a.png' });
      case '/loop': return send(302, 'text/plain', '', { location: '/loop' });
      case '/big': return send(200, 'image/png', Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(26 * 1024 * 1024)]));
      default: return send(404, 'text/plain', 'unknown');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });

describe('recognising the image (by its bytes, never by name or type)', () => {
  it('accepts JPEG, PNG, GIF and WebP signatures', () => {
    expect(relayCore.sniffImage(JPEG)?.mime).toBe('image/jpeg');
    expect(relayCore.sniffImage(PNG)?.mime).toBe('image/png');
    expect(relayCore.sniffImage(Buffer.from('GIF89a....'))?.mime).toBe('image/gif');
    expect(relayCore.sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))?.mime).toBe('image/webp');
  });
  it('refuses everything else, including a page or an SVG pretending to be an image', () => {
    expect(relayCore.sniffImage(Buffer.from('<!doctype html>'))).toBeNull();
    expect(relayCore.sniffImage(Buffer.from('<svg></svg>'))).toBeNull();
    expect(relayCore.sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe('downloading one image (fetchImage)', () => {
  const opts = { allowPrivate: true, allowHttp: true };

  it('downloads a PNG and a JPEG whatever the server says their type is', async () => {
    const png = await relayCore.fetchImage(`${base}/a.png`, opts);
    expect(png.ok && png.mime).toBe('image/png');
    expect(png.ok && png.bytes.equals(PNG)).toBe(true);
    const jpg = await relayCore.fetchImage(`${base}/b.jpg`, opts);
    expect(jpg.ok && jpg.mime).toBe('image/jpeg');
  });

  it('follows a redirect to the image', async () => {
    const r = await relayCore.fetchImage(`${base}/redirect`, opts);
    expect(r.ok && r.mime).toBe('image/png');
  });

  it('says why a web page is not an image, and refuses SVG (it can contain scripts)', async () => {
    const page = await relayCore.fetchImage(`${base}/page`, opts);
    expect(!page.ok && page.reason).toMatch(/web page, not to an image/);
    expect(!page.ok && page.retryable).toBe(false);
    const svg = await relayCore.fetchImage(`${base}/svg`, opts);
    expect(!svg.ok && svg.reason).toMatch(/SVG files are not downloaded/);
  });

  it('reports a missing image as not retryable, and a busy server as retryable', async () => {
    const missing = await relayCore.fetchImage(`${base}/missing`, opts);
    expect(!missing.ok && missing.reason).toMatch(/not found \(HTTP 404\)/);
    expect(!missing.ok && missing.retryable).toBe(false);
    const busy = await relayCore.fetchImage(`${base}/busy`, opts);
    expect(!busy.ok && busy.retryable).toBe(true);
  });

  it('stops a redirect loop after five hops', async () => {
    const r = await relayCore.fetchImage(`${base}/loop`, opts);
    expect(!r.ok && r.reason).toMatch(/redirects too many times/);
  });

  it('refuses an image larger than 25 MB', async () => {
    const r = await relayCore.fetchImage(`${base}/big`, opts);
    expect(!r.ok && r.reason).toMatch(/larger than 25 MB/);
  }, 30000);

  it('refuses plain http unless the test mode allows it, and refuses private addresses (the mock is on 127.0.0.1)', async () => {
    const plain = await relayCore.fetchImage(`${base}/a.png`, {});
    expect(!plain.ok && plain.reason).toMatch(/Only https/);
    const priv = await relayCore.fetchImage(`${base}/a.png`, { allowHttp: true, allowPrivate: false });
    expect(!priv.ok && priv.reason).toMatch(/private network/);
  });

  it('refuses a bad address', async () => {
    const r = await relayCore.fetchImage('not a url', opts);
    expect(!r.ok && r.reason).toMatch(/not a valid web address/);
  });
});

describe('POST /image on the relay', () => {
  let relay: Server;
  let relayBase = '';
  beforeAll(async () => {
    relay = relayCore.createRelay({ origins: [], allowPrivateFetch: true }) as Server;
    await new Promise<void>((r) => relay.listen(0, '127.0.0.1', () => r()));
    relayBase = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  });
  afterAll(() => { relay.close(); });

  const post = async (body: string) => {
    const res = await fetch(`${relayBase}/image`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return res.json() as Promise<{ ok: boolean; mime?: string; base64?: string; error?: string; retryable?: boolean }>;
  };

  it('returns the image as base64 with its type', async () => {
    const j = await post(JSON.stringify({ url: `${base}/a.png` }));
    expect(j.ok).toBe(true);
    expect(j.mime).toBe('image/png');
    expect(Buffer.from(j.base64 ?? '', 'base64').equals(PNG)).toBe(true);
  });

  it('answers a refusal as a readable message, not as a crash', async () => {
    const j = await post(JSON.stringify({ url: `${base}/missing` }));
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/not found/);
    expect(j.retryable).toBe(false);
  });

  it('needs a JSON body with a url', async () => {
    const res = await fetch(`${relayBase}/image`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(res.status).toBe(400);
  });

  it('advertises the image feature on /health', async () => {
    const res = await fetch(`${relayBase}/health`);
    const j = await res.json() as { features: string[] };
    expect(j.features).toContain('image');
  });
});
