import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('../../dist/', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

export function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH; // any Chromium / Chrome executable
  const base = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  for (const v of ['chromium-1248', 'chromium-1234']) {
    const p = join(base, v, 'chrome-win64', 'chrome.exe');
    if (existsSync(p)) return p;
    const q = join(base, v, 'chrome-win', 'chrome.exe');
    if (existsSync(q)) return q;
  }
  return undefined;
}

export async function startServer(port = 0) {
  const server = createServer(async (req, res) => {
    let path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^([/\\])+/, '');
    if (!path || path.endsWith('/')) path += 'index.html';
    let file = join(ROOT, path);
    if (!file.startsWith(ROOT) || !existsSync(file)) file = join(ROOT, 'index.html');
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

export async function launch({ viewport = { width: 1480, height: 900 }, headless = true } = {}) {
  const { server, url } = await startServer();
  const browser = await chromium.launch({ executablePath: chromiumPath(), headless, args: ['--enable-features=SharedArrayBuffer'] });
  const context = await browser.newContext({ viewport, acceptDownloads: true, locale: 'en-US', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message} @ ${(e.stack ?? '').split(String.fromCharCode(10)).slice(1, 4).join(' <- ')}`));
  await page.goto(url + '/#/');
  await page.waitForSelector('.sidebar', { timeout: 30000 });
  return { page, context, browser, errors, url, close: async () => { await browser.close(); server.close(); } };
}
