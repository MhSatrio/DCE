/**
 * Cloud destinations for the Batch Runner, called through the local relay so that credentials are never sent by the
 * screen to anything but this computer and the service itself:
 *  - Cloudflare R2 (S3-compatible): a signed PUT of one object (AWS Signature Version 4, region "auto").
 *  - Google Drive: sign-in with a loopback OAuth flow (PKCE; the redirect comes back to this relay), folder lookup,
 *    folder listing, and upload of one file (created, or replaced when a file of the same name is already there).
 * Nothing here stores a secret on disk: the refresh token goes back to the app, which keeps it encrypted.
 */
const crypto = require('node:crypto');

const DEFAULTS = {
  driveBase: 'https://www.googleapis.com',
  oauthBase: 'https://oauth2.googleapis.com',
  authBase: 'https://accounts.google.com',
};

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
/** RFC 3986 encoding (S3 signs the encoded path, and encodes ! ' ( ) * too). */
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** AWS Signature Version 4 for one S3 request (PUT with `body`, or DELETE). Returns the URL and the headers to send. */
function signedS3Put({ method = 'PUT', endpoint, bucket, key, accessKeyId, secretAccessKey, contentType, body = Buffer.alloc(0), region = 'auto', now = new Date() }) {
  const url = new URL(endpoint);
  const path = `/${rfc3986(bucket)}/${key.split('/').map(rfc3986).join('/')}`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');        // 20260115T093000Z
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (contentType) headers['content-type'] = contentType;
  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const canonicalHeaders = names.map((k) => `${k}:${String(headers[k]).trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, dateStamp), region), 's3'), 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: `${url.origin}${path}`, headers: { ...headers, authorization } };
}

/** The Drive folder id of a folder link, or of a bare id. Null when the text is neither. */
function parseFolderRef(input) {
  const text = String(input || '').trim();
  const link = /drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders\/|open\?id=|.*[?&]id=)([A-Za-z0-9_-]{10,})/.exec(text);
  if (link) return link[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(text) ? text : null;
}

/** Escapes a value for a Drive search query (names are quoted with single quotes). */
const driveQuote = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function createCloud(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const pendingAuth = new Map();   // state -> { clientId, clientSecret, verifier, redirectUri, created }
  const doneAuth = new Map();      // state -> { ok, refreshToken, accessToken, expiresIn } | { ok: false, error }

  const gapi = async (method, url, token, extra = {}) => {
    let res;
    try {
      res = await fetch(url, { method, headers: { authorization: `Bearer ${token}`, ...(extra.headers || {}) }, body: extra.body });
    } catch (e) {
      return { ok: false, status: 0, json: null, error: `Cannot reach Google (${e instanceof Error ? e.message : String(e)}).` };
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    const error = res.ok ? '' : (json?.error?.message || text.slice(0, 200) || `HTTP ${res.status}`);
    return { ok: res.ok, status: res.status, json, error };
  };

  const driveError = (r, what) => {
    if (r.status === 401) return `Google refused the sign-in for ${what}. Connect Google Drive again in Settings.`;
    if (r.status === 403) return `No permission to ${what}. The signed-in account needs edit access to the folder.`;
    if (r.status === 404) return `${what[0].toUpperCase()}${what.slice(1)} not found. Check the link, or share the folder with the signed-in account.`;
    return `Google Drive answered: ${r.error}`;
  };

  async function tokenRequest(form) {
    let res;
    try {
      res = await fetch(`${cfg.oauthBase}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
    } catch (e) {
      return { ok: false, error: `Cannot reach Google's sign-in service (${e instanceof Error ? e.message : String(e)}).` };
    }
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.access_token) return { ok: false, error: json?.error_description || json?.error || `HTTP ${res.status}` };
    return { ok: true, accessToken: json.access_token, refreshToken: json.refresh_token, expiresIn: json.expires_in };
  }

  /** Starts a sign-in: returns the Google page to open. The redirect comes back to this relay (loopback only). */
  function oauthStart({ clientId, clientSecret, host }) {
    if (!clientId || !clientSecret) return { ok: false, error: 'Enter the client ID and the client secret of your Google OAuth client first.' };
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(host || ''))) return { ok: false, error: 'The sign-in must come from this computer.' };
    const state = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const redirectUri = `http://${host}/google/callback`;
    pendingAuth.set(state, { clientId, clientSecret, verifier, redirectUri, created: Date.now() });
    const q = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
      scope: 'https://www.googleapis.com/auth/drive', access_type: 'offline', prompt: 'consent',
      state, code_challenge: challenge, code_challenge_method: 'S256',
    });
    return { ok: true, state, authUrl: `${cfg.authBase}/o/oauth2/v2/auth?${q.toString()}` };
  }

  /** The redirect from Google: exchanges the code for tokens and keeps the result until the app asks for it. */
  async function oauthCallback(query) {
    const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:24px"><h2>${title}</h2><p>${text}</p></body>`;
    const pending = pendingAuth.get(query.state);
    if (!pending) return { status: 400, html: page('Sign-in expired', 'Start “Connect Google Drive” again in DCE.') };
    if (Date.now() - pending.created > 10 * 60_000) {
      pendingAuth.delete(query.state);
      doneAuth.set(query.state, { ok: false, error: 'The sign-in took longer than 10 minutes. Start “Connect Google Drive” again.' });
      return { status: 400, html: page('Sign-in expired', 'Start “Connect Google Drive” again in DCE.') };
    }
    // the state stays registered until the code is exchanged, so a result asked meanwhile says "still going", not "unknown"
    if (pending.busy) return { status: 200, html: page('Already connecting', 'This sign-in is being completed. You can close this window.') };
    pending.busy = true;
    const finish = (result) => { doneAuth.set(query.state, result); pendingAuth.delete(query.state); };
    if (query.error) { finish({ ok: false, error: `Google said: ${query.error}` }); return { status: 200, html: page('Not connected', 'Google did not grant access. You can close this window and try again in DCE.') }; }
    const r = await tokenRequest({ code: String(query.code || ''), client_id: pending.clientId, client_secret: pending.clientSecret, redirect_uri: pending.redirectUri, grant_type: 'authorization_code', code_verifier: pending.verifier });
    if (!r.ok) { finish({ ok: false, error: r.error }); return { status: 200, html: page('Not connected', r.error) }; }
    if (!r.refreshToken) { finish({ ok: false, error: 'Google did not return a refresh token. Remove DCE from your Google account permissions and connect again.' }); return { status: 200, html: page('Not connected', 'Google gave no refresh token. Remove DCE in your Google account and connect again.') }; }
    finish({ ok: true, refreshToken: r.refreshToken, accessToken: r.accessToken, expiresIn: r.expiresIn });
    return { status: 200, html: page('Google Drive connected', 'You can close this window and return to DCE.') };
  }

  /** The app polls this until the sign-in has finished; the result is handed over once. */
  function oauthResult(state) {
    if (doneAuth.has(state)) { const r = doneAuth.get(state); doneAuth.delete(state); return r; }
    if (pendingAuth.has(state)) return { ok: true, pending: true };
    return { ok: false, error: 'This sign-in is unknown or has expired. Start it again.' };
  }

  /** One cloud request. `route` is the path after /cloud (for example "/r2/put"). */
  async function handle(route, p) {
    switch (route) {
      case '/r2/put': {
        const body = Buffer.from(String(p.body || ''), 'base64');
        if (!p.endpoint || !p.bucket || !p.accessKeyId || !p.secretAccessKey || !p.key) return { ok: false, status: 400, error: 'The R2 connection is incomplete (address, bucket, key id, secret).' };
        let url;
        try { url = new URL(String(p.endpoint)); } catch { return { ok: false, status: 400, error: 'The R2 address is not a valid URL.' }; }
        if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) return { ok: false, status: 400, error: 'The R2 address must start with https://.' };
        const signed = signedS3Put({ endpoint: url.origin, bucket: String(p.bucket), key: String(p.key), accessKeyId: String(p.accessKeyId), secretAccessKey: String(p.secretAccessKey), contentType: p.contentType, body });
        let res;
        try { res = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body }); }
        catch (e) { return { ok: false, status: 0, error: `Cannot reach R2 (${e instanceof Error ? e.message : String(e)}).` }; }
        const text = await res.text().catch(() => '');
        if (!res.ok) return { ok: false, status: res.status, error: res.status === 403 ? 'R2 refused the upload: check the key id, the secret and that the key may write to this bucket.' : `R2 answered HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}` };
        return { ok: true, status: res.status, etag: res.headers.get('etag') || '' };
      }
      case '/r2/delete': {
        if (!p.endpoint || !p.bucket || !p.accessKeyId || !p.secretAccessKey || !p.key) return { ok: false, status: 400, error: 'The R2 connection is incomplete (address, bucket, key id, secret).' };
        let url;
        try { url = new URL(String(p.endpoint)); } catch { return { ok: false, status: 400, error: 'The R2 address is not a valid URL.' }; }
        if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) return { ok: false, status: 400, error: 'The R2 address must start with https://.' };
        const signed = signedS3Put({ method: 'DELETE', endpoint: url.origin, bucket: String(p.bucket), key: String(p.key), accessKeyId: String(p.accessKeyId), secretAccessKey: String(p.secretAccessKey) });
        let res;
        try { res = await fetch(signed.url, { method: 'DELETE', headers: signed.headers }); }
        catch (e) { return { ok: false, status: 0, error: `Cannot reach R2 (${e instanceof Error ? e.message : String(e)}).` }; }
        await res.text().catch(() => '');
        // a file that is already gone is what was wanted: it counts as deleted
        if (res.status === 404) return { ok: true, status: 404, existed: false };
        if (!res.ok) return { ok: false, status: res.status, error: res.status === 403 ? 'R2 refused the delete: check the key id, the secret and that the key may delete in this bucket.' : `R2 answered HTTP ${res.status} when deleting the file.` };
        return { ok: true, status: res.status, existed: true };
      }
      case '/google/oauth/start': return oauthStart(p);
      case '/google/oauth/result': return oauthResult(String(p.state || ''));
      case '/google/token': {
        const r = await tokenRequest({ client_id: String(p.clientId || ''), client_secret: String(p.clientSecret || ''), refresh_token: String(p.refreshToken || ''), grant_type: 'refresh_token' });
        return r.ok ? { ok: true, accessToken: r.accessToken, expiresIn: r.expiresIn } : { ok: false, error: r.error };
      }
      case '/drive/folder': {
        const id = parseFolderRef(p.input);
        if (!id) return { ok: false, error: 'That is not a Google Drive folder link or id. Paste the link of the folder (drive.google.com/drive/folders/…).' };
        const r = await gapi('GET', `${cfg.driveBase}/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,capabilities(canAddChildren)&supportsAllDrives=true`, p.accessToken);
        if (!r.ok) return { ok: false, error: driveError(r, 'the folder') };
        if (r.json?.mimeType !== 'application/vnd.google-apps.folder') return { ok: false, error: 'That link is a file, not a folder.' };
        if (r.json?.capabilities?.canAddChildren === false) return { ok: false, error: `The signed-in account cannot add files to “${r.json.name}”.` };
        return { ok: true, id: r.json.id, name: r.json.name };
      }
      case '/drive/folders': {
        const parent = p.parentId && p.parentId !== 'root' ? parseFolderRef(p.parentId) : 'root';
        if (!parent) return { ok: false, error: 'Invalid parent folder.' };
        const q = `mimeType='application/vnd.google-apps.folder' and trashed=false and '${parent}' in parents`;
        const r = await gapi('GET', `${cfg.driveBase}/drive/v3/files?${new URLSearchParams({ q, fields: 'files(id,name),nextPageToken', pageSize: '100', orderBy: 'name', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', ...(p.pageToken ? { pageToken: String(p.pageToken) } : {}) })}`, p.accessToken);
        if (!r.ok) return { ok: false, error: driveError(r, 'the folder list') };
        return { ok: true, folders: r.json?.files || [], nextPageToken: r.json?.nextPageToken || '' };
      }
      case '/drive/upload': {
        const folder = parseFolderRef(p.folderId);
        if (!folder) return { ok: false, error: 'No Drive folder is chosen for the upload.' };
        const bytes = Buffer.from(String(p.body || ''), 'base64');
        const mime = String(p.mimeType || 'application/octet-stream');
        const name = String(p.name || '').trim();
        if (!name) return { ok: false, error: 'The file has no name.' };
        // a file of the same name in the folder is replaced (no duplicates when a batch is run again)
        const find = await gapi('GET', `${cfg.driveBase}/drive/v3/files?${new URLSearchParams({ q: `name='${driveQuote(name)}' and '${folder}' in parents and trashed=false`, fields: 'files(id)', pageSize: '2', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' })}`, p.accessToken);
        if (!find.ok) return { ok: false, error: driveError(find, 'the folder') };
        const existing = find.json?.files?.[0]?.id;
        let up;
        if (existing) {
          up = await gapi('PATCH', `${cfg.driveBase}/upload/drive/v3/files/${encodeURIComponent(existing)}?uploadType=media&supportsAllDrives=true&fields=id`, p.accessToken, { headers: { 'content-type': mime }, body: bytes });
        } else {
          const boundary = `dce${crypto.randomBytes(10).toString('hex')}`;
          const meta = JSON.stringify({ name, parents: [folder], mimeType: mime });
          const multipart = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
            bytes,
            Buffer.from(`\r\n--${boundary}--`),
          ]);
          up = await gapi('POST', `${cfg.driveBase}/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id`, p.accessToken, { headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body: multipart });
        }
        if (!up.ok) return { ok: false, error: driveError(up, 'upload the file') };
        const id = up.json?.id;
        if (!id) return { ok: false, error: 'Google Drive did not return the id of the file.' };
        if (p.makePublic !== false) {
          const share = await gapi('POST', `${cfg.driveBase}/drive/v3/files/${encodeURIComponent(id)}/permissions?supportsAllDrives=true`, p.accessToken, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'reader', type: 'anyone' }) });
          if (!share.ok) return { ok: false, error: `The file was uploaded but could not be made public: ${share.error}. Its link would not open for others.` };
        }
        return { ok: true, id, replaced: !!existing, url: `https://drive.google.com/uc?export=view&id=${encodeURIComponent(id)}` };
      }
      default:
        return { ok: false, status: 404, error: `Unknown cloud request ${route}.` };
    }
  }

  return { handle, oauthCallback, oauthResult, pendingAuth, doneAuth };
}

module.exports = { createCloud, signedS3Put, parseFolderRef };
