/** Local, uncommitted UI preview against the installed daemon. Credentials stay server-side. */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WEBHOOK_PORT, WEBHOOK_SECRET } from '../src/config.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = `http://127.0.0.1:${WEBHOOK_PORT}`;
if (!WEBHOOK_SECRET) throw new Error('Local preview requires the existing Clementine account.');
const { preview: createPreview } = await import(pathToFileURL(path.join(root, 'apps/console-web/node_modules/vite/dist/node/index.js')).href);

function localOnly(req, res, next) {
  const address = req.socket.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
    res.writeHead(403); res.end('Local preview only.'); return;
  }
  next();
}

const proxy = (route, admin = false) => ({
  target: upstream,
  changeOrigin: true,
  headers: { origin: upstream, ...(admin ? { authorization: `Bearer ${WEBHOOK_SECRET}` } : {}) },
});

const consolePreview = await createPreview({
  root: path.join(root, 'apps/console-web'),
  configFile: path.join(root, 'apps/console-web/vite.config.ts'),
  preview: { host: '127.0.0.1', port: 5174, strictPort: true,
    proxy: Object.fromEntries(['/api', '/dashboard', '/console/vendor', '/console/icon.png'].map(route => [route, proxy(route, true)])) },
  plugins: [{ name: 'clem-local-preview', configurePreviewServer(server) { server.middlewares.use(localOnly); } }],
});

const mobilePreview = await createPreview({
  root: path.join(root, 'apps/mobile-web'),
  configFile: path.join(root, 'apps/mobile-web/vite.config.ts'),
  preview: { host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: { '/m/auth': proxy('/m/auth'), '/m/api': proxy('/m/api'), '/api/console': proxy('/api/console', true) } },
  plugins: [{ name: 'clem-local-mobile-preview', configurePreviewServer(server) {
    server.middlewares.use(localOnly);
    // Keep the normal pairing ceremony and device proof; name only this
    // explicitly paired browser so it is recognisable in Apps & devices.
    server.middlewares.use(async (req, res, next) => {
      if (req.method !== 'POST' || req.url?.split('?')[0] !== '/m/auth/pair') { next(); return; }
      try {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 64_000) { res.writeHead(413); res.end(); return; }
        }
        const input = JSON.parse(body);
        const response = await fetch(`${upstream}/m/auth/pair`, {
          method: 'POST', headers: { 'content-type': 'application/json', origin: upstream },
          body: JSON.stringify({ ...input, deviceLabel: 'FRAMEWORK-TEST UI preview' }),
          signal: AbortSignal.timeout(15_000),
        });
        const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
        const cookies = response.headers.getSetCookie();
        if (cookies.length) headers['set-cookie'] = cookies;
        res.writeHead(response.status, headers);
        res.end(await response.text());
      } catch {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'The preview could not finish pairing. Try again when Clem is ready.' }));
      }
    });
    server.middlewares.use('/__preview/pair', async (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      try {
        const response = await fetch(`${upstream}/api/console/mobile-access/qr`, {
          headers: { authorization: `Bearer ${WEBHOOK_SECRET}` }, signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error('Open Apps & devices in Clementine to check pairing readiness.');
        const target = new URL(response.headers.get('x-target-url') ?? '');
        const pair = target.searchParams.get('pair');
        if (!pair) throw new Error('Clementine did not return a pairing link.');
        res.writeHead(302, { location: `/m/?pair=${encodeURIComponent(pair)}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        res.end();
      } catch (error) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end(error instanceof Error ? error.message : 'Pairing is temporarily unavailable.');
      }
    });
  } }],
});

const preview = http.createServer((req, res) => localOnly(req, res, async () => {
  if (req.url?.split('?')[0] === '/__preview/status') {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    let connected = false;
    try {
      const health = await fetch(`${upstream}/api/console/build-info`, {
        headers: { authorization: `Bearer ${WEBHOOK_SECRET}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (health.ok) {
        const build = await health.json();
        connected = /^[a-f0-9]{64}$/.test(build.sourceFingerprint ?? '');
      } else {
        await health.body?.cancel();
      }
    } catch { /* The installed app may be restarting independently. */ }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ connected }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src http://127.0.0.1:5173 http://127.0.0.1:5174" });
  res.end(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Clem · Experience preview</title><style>
    *{box-sizing:border-box}body{margin:0;background:#eeeae4;color:#24221e;font:14px system-ui,sans-serif}header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 22px;border-bottom:1px solid #d8d1c8;background:#faf8f5;flex-wrap:wrap}header strong{font-size:16px}header small{color:#696157}nav{display:flex;gap:6px}button,a{font:inherit}button{padding:9px 16px;border:1px solid #d8d1c8;border-radius:8px;background:#fff;color:#403b34;cursor:pointer}button[aria-pressed=true]{background:#28241e;color:#fff;border-color:#28241e}main{padding:18px}iframe{display:block;background:#faf7f2;border:0;width:100%;height:calc(100vh - 112px);min-height:640px;border-radius:10px;box-shadow:0 12px 36px #24221e12}main.mobile iframe{width:393px;max-width:100%;height:852px;margin:0 auto;border-radius:28px;border:7px solid #24221e}p{margin:0}a{color:#a33f08;text-underline-offset:3px}a:focus-visible,button:focus-visible{outline:3px solid #b7460b;outline-offset:3px}@media(max-width:560px){header{padding:12px}main{padding:8px}header small{display:block;margin-top:4px}main.mobile iframe{border-width:3px}}
    </style></head><body><header><div><strong>Clem · Experience preview</strong> <small>Uncommitted · <span id="live-status" role="status">Checking live connection…</span></small></div><nav aria-label="Preview layout"><button type="button" data-view="desktop" aria-pressed="true">Desktop</button><button type="button" data-view="mobile" aria-pressed="false">Mobile</button></nav><a href="http://127.0.0.1:5173/__preview/pair" target="_blank" rel="noopener">Pair mobile preview</a></header><main><iframe title="Clementine desktop preview" src="http://127.0.0.1:5174/console/chat"></iframe></main><script>
    const panel=document.querySelector('main'),frame=document.querySelector('iframe');
    async function refreshStatus(){let connected=false;try{connected=(await(await fetch('/__preview/status',{cache:'no-store'})).json()).connected===true}catch{}document.getElementById('live-status').textContent=connected?'Connected to your running Clem':'Clem is offline · waiting for the installed app';}
    refreshStatus();setInterval(refreshStatus,10000);
    for(const button of document.querySelectorAll('[data-view]'))button.addEventListener('click',()=>{const mobile=button.dataset.view==='mobile';panel.className=mobile?'mobile':'';frame.src=mobile?'http://127.0.0.1:5173/m/':'http://127.0.0.1:5174/console/chat';frame.title=mobile?'Clementine mobile preview':'Clementine desktop preview';for(const peer of document.querySelectorAll('[data-view]'))peer.setAttribute('aria-pressed',String(peer===button));});
    </script></body></html>`);
}));
await new Promise(resolve => preview.listen(5180, '127.0.0.1', resolve));
console.log('Experience preview: http://127.0.0.1:5180');
console.log('Desktop: http://127.0.0.1:5174/console/chat');
console.log('Mobile: http://127.0.0.1:5173/m/');
async function close() { preview.close(); await Promise.all([new Promise(resolve => consolePreview.httpServer.close(resolve)), new Promise(resolve => mobilePreview.httpServer.close(resolve))]); process.exit(0); }
process.on('SIGINT', close); process.on('SIGTERM', close);
