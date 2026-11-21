import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require_ = createRequire(import.meta.url);
const { createRelay } = require_('../../server/relay-core.cjs') as { createRelay: (o: Record<string, unknown>) => Server };
const { signedS3Put, parseFolderRef } = require_('../../server/cloud.cjs') as {
  signedS3Put: (o: Record<string, unknown>) => { url: string; headers: Record<string, string> };
  parseFolderRef: (s: string) => string | null;
};

describe('Drive folder references', () => {
  it('reads the id from a folder link, with or without the account number, and accepts a bare id', () => {
    expect(parseFolderRef('https://drive.google.com/drive/folders/1AbCdEf_GhIjKlMn?usp=sharing')).toBe('1AbCdEf_GhIjKlMn');
    expect(parseFolderRef('https://drive.google.com/drive/u/0/folders/1AbCdEf_GhIjKlMn')).toBe('1AbCdEf_GhIjKlMn');
    expect(parseFolderRef('https://drive.google.com/open?id=1AbCdEf_GhIjKlMn')).toBe('1AbCdEf_GhIjKlMn');
    expect(parseFolderRef('1AbCdEf_GhIjKlMn')).toBe('1AbCdEf_GhIjKlMn');
  });
  it('refuses text that is neither a folder link nor an id', () => {
    expect(parseFolderRef('https://example.com/folder')).toBeNull();
    expect(parseFolderRef('hello world')).toBeNull();
    expect(parseFolderRef('')).toBeNull();
  });
});

describe('R2 upload signature (AWS Signature Version 4)', () => {
  const body = Buffer.from('hello');
  const signed = signedS3Put({
    endpoint: 'https://acc123.r2.cloudflarestorage.com', bucket: 'images', key: 'batch/rotary evaporator.png',
    accessKeyId: 'AKID', secretAccessKey: 'SECRET', contentType: 'image/png', body, now: new Date('2026-11-15T10:00:00Z'),
  });
  it('signs the request for region auto and service s3, with the payload hash and the date', () => {
    expect(signed.url).toBe('https://acc123.r2.cloudflarestorage.com/images/batch/rotary%20evaporator.png');
    expect(signed.headers['x-amz-date']).toBe('20261115T100000Z');
    expect(signed.headers['x-amz-content-sha256']).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(signed.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/20261115\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });
  it('changes when the content changes (a different file cannot reuse another signature)', () => {
    const other = signedS3Put({ endpoint: 'https://acc123.r2.cloudflarestorage.com', bucket: 'images', key: 'batch/rotary evaporator.png', accessKeyId: 'AKID', secretAccessKey: 'SECRET', contentType: 'image/png', body: Buffer.from('bye'), now: new Date('2026-11-15T10:00:00Z') });
    expect(other.headers.authorization).not.toBe(signed.headers.authorization);
  });
});

describe('cloud routes through the relay (mock Google and mock R2, no internet)', () => {
  let mock: Server; let mockBase = '';
  let relay: Server; let relayBase = '';
  const seen: { method: string; url: string; headers: Record<string, string | undefined>; body: string }[] = [];
  const files = new Map<string, string>();   // name -> id, in the mock Drive folder
  let nextId = 1;

  beforeAll(async () => {
    mock = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers as Record<string, string>, body });
        const json = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        const u = new URL(req.url ?? '/', 'http://x');
        if (u.pathname === '/token') {
          const form = new URLSearchParams(body);
          // a slow exchange (as with the real Google service): the answer comes after a moment
          if (form.get('code') === 'CODE-SLOW') return setTimeout(() => json(200, { access_token: 'AT3', refresh_token: 'RT1', expires_in: 3600 }), 800);
          if (form.get('grant_type') === 'authorization_code') return json(200, { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 });
          return json(200, { access_token: 'AT2', expires_in: 3600 });
        }
        if (u.pathname.startsWith('/bucket/')) { res.writeHead(200, { etag: '"e1"' }); return res.end(); }
        if (u.pathname === '/drive/v3/files/FOLDER123456' && req.method === 'GET') return json(200, { id: 'FOLDER123456', name: 'Campaign', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } });
        if (u.pathname === '/drive/v3/files/NOTAFOLDER1' && req.method === 'GET') return json(404, { error: { message: 'File not found' } });
        if (u.pathname === '/drive/v3/files' && req.method === 'GET') {
          const q = u.searchParams.get('q') ?? '';
          const m = /name='([^']*)'/.exec(q);
          const id = m && files.get(m[1].replace(/\\'/g, "'"));
          return json(200, { files: id ? [{ id }] : [] });
        }
        if (u.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
          const name = /"name":"([^"]+)"/.exec(body)?.[1] ?? 'x';
          const id = `FILE${nextId++}ABCDEF`;
          files.set(name, id);
          return json(200, { id });
        }
        if (u.pathname.startsWith('/upload/drive/v3/files/') && req.method === 'PATCH') return json(200, { id: u.pathname.split('/').pop() });
        if (u.pathname.endsWith('/permissions')) return json(200, { id: 'perm' });
        json(404, { error: { message: 'mock: not found' } });
      });
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
    relay = createRelay({ origins: [], allowPrivateFetch: true, cloud: { driveBase: mockBase, oauthBase: mockBase, authBase: mockBase } });
    await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
    relayBase = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  });
  afterAll(() => { relay.close(); mock.close(); });

  const post = async (route: string, body: unknown) => {
    const r = await fetch(`${relayBase}/cloud${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return (await r.json()) as Record<string, unknown>;
  };

  it('uploads an object to R2 with a signed PUT, and reports the failure of a wrong secret', async () => {
    const ok = await post('/r2/put', { endpoint: mockBase, bucket: 'bucket', key: 'batch/a.png', accessKeyId: 'AK', secretAccessKey: 'SK', contentType: 'image/png', body: Buffer.from('PNG').toString('base64') });
    expect(ok.ok).toBe(true);
    const put = seen.find((s) => s.method === 'PUT' && s.url === '/bucket/batch/a.png');
    expect(put).toBeDefined();
    expect(put!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\//);
    expect(put!.body).toBe('PNG');
    const bad = await post('/r2/put', { endpoint: 'http://127.0.0.1:1', bucket: 'b', key: 'k', accessKeyId: 'a', secretAccessKey: 's', body: '' });
    expect(bad.ok).toBe(false);
  });

  it('a Drive folder link is resolved; a file or a missing folder gets a plain message', async () => {
    const ok = await post('/drive/folder', { accessToken: 'AT', input: 'https://drive.google.com/drive/folders/FOLDER123456' });
    expect(ok).toEqual({ ok: true, id: 'FOLDER123456', name: 'Campaign' });
    const missing = await post('/drive/folder', { accessToken: 'AT', input: 'NOTAFOLDER1' });
    expect(missing.ok).toBe(false);
    expect(String(missing.error)).toMatch(/not found/);
  });

  it('uploads into the folder, makes the file readable by link, and replaces a file of the same name instead of duplicating it', async () => {
    const first = await post('/drive/upload', { accessToken: 'AT', folderId: 'FOLDER123456', name: 'rotary.jpg', mimeType: 'image/jpeg', body: Buffer.from('JPEG1').toString('base64') });
    expect(first.ok).toBe(true);
    expect(first.url).toBe(`https://drive.google.com/uc?export=view&id=${first.id}`);
    expect(first.replaced).toBe(false);
    const again = await post('/drive/upload', { accessToken: 'AT', folderId: 'FOLDER123456', name: 'rotary.jpg', mimeType: 'image/jpeg', body: Buffer.from('JPEG2').toString('base64') });
    expect(again.ok).toBe(true);
    expect(again.replaced).toBe(true);
    expect(again.id).toBe(first.id);
    expect(seen.some((s) => s.url.includes('/permissions') && s.body.includes('"anyone"'))).toBe(true);
  });

  it('the sign-in: a link is made, Google sends the code back to the relay, the app takes the refresh token once', async () => {
    const start = await post('/google/oauth/start', { clientId: 'CID', clientSecret: 'CS' });
    expect(start.ok).toBe(true);
    const authUrl = new URL(String(start.authUrl));
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('access_type')).toBe('offline');
    expect(authUrl.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/google\/callback$/);
    const state = String(start.state);
    const back = await fetch(`${relayBase}/google/callback?code=C0DE&state=${state}`);
    expect(back.status).toBe(200);
    const pending = await post('/google/oauth/result', { state: 'other' });
    expect(pending.ok).toBe(false);
    const done = await post('/google/oauth/result', { state });
    expect(done).toMatchObject({ ok: true, refreshToken: 'RT1', accessToken: 'AT1' });
    const again = await post('/google/oauth/result', { state });
    expect(again.ok).toBe(false);   // handed over once
  });

  it('a result asked while the browser code is still being exchanged says the sign-in is going on, not that it is unknown', async () => {
    const start = await post('/google/oauth/start', { clientId: 'CID', clientSecret: 'CS' });
    const state = String(start.state);
    const callback = fetch(`${relayBase}/google/callback?code=CODE-SLOW&state=${state}`);
    await new Promise((r) => setTimeout(r, 200));
    const during = await post('/google/oauth/result', { state });
    expect(during).toMatchObject({ ok: true, pending: true });
    await callback;
    const after = await post('/google/oauth/result', { state });
    expect(after).toMatchObject({ ok: true, refreshToken: 'RT1' });
  });

  it('a refresh token gives a new access token', async () => {
    const r = await post('/google/token', { clientId: 'CID', clientSecret: 'CS', refreshToken: 'RT1' });
    expect(r).toMatchObject({ ok: true, accessToken: 'AT2' });
  });
});
