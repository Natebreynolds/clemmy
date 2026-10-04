#!/usr/bin/env node
/** Real Electron frame events, with a synthetic provider and no external
 * requests. This is native-policy regression evidence, not live Browserbase
 * or installed-app acceptance. Run with Node from any working directory. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../../..', 'output/browserbase-live-view');

if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'clem-browser-navigation-'));
  try {
    require('esbuild').buildSync({ entryPoints: [path.resolve(__dirname, '../src/browser-viewer-navigation-policy.ts')],
      bundle: true, platform: 'node', format: 'cjs', outfile: path.join(scratch, 'policy.cjs') });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = require('node:child_process').spawnSync(require('electron'), [__filename, scratch],
      { env, stdio: 'inherit', timeout: 45000 });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
} else {
  const { app, BrowserWindow, session } = require('electron');
  app.on('window-all-closed', () => {}); // One process exercises several isolated windows.
  const scratch = process.argv[2];
  app.setPath('userData', path.join(scratch, 'electron-profile'));
  const policy = require(path.join(scratch, 'policy.cjs'));
  const timeout = setTimeout(() => { console.error('Browser navigation smoke timed out'); app.exit(1); }, 40000);
  let server;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  (async () => {
    await app.whenReady();
    fs.mkdirSync(output, { recursive: true });
    const localRequests = [];
    server = require('node:http').createServer((req, res) => {
      localRequests.push(req.url);
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>Browser viewer fixture</title><style>body{margin:0;background:#f7f3ed;font:20px system-ui}h1{font-size:22px;padding:16px}iframe{border:0;width:100%;height:480px}</style><h1>Controlled Browserbase viewer frame</h1><button id="mount">Watch</button><div id="viewer"></div><script>document.querySelector("#mount").onclick=()=>{const f=document.createElement("iframe");f.title="Browser view";f.sandbox="allow-scripts allow-same-origin allow-forms allow-popups";f.src="https://www.browserbase.com/devtools-fullscreen/?token=synthetic-fixture";document.querySelector("#viewer").append(f)}</script>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const cases = [
      { name: 'old-rule-blank', before: true, rendered: false },
      { name: 'viewer-renders', rendered: true },
      { name: 'provider-redirect-renders', redirect: 'https://www.browserbase.com/view?token=synthetic-renewal', rendered: true },
      { name: 'replacement-redirect-renders', replace: true, redirect: 'https://www.browserbase.com/view?token=synthetic-renewal', rendered: true },
      { name: 'local-redirect-blocked', redirect: `${origin}/console/escape-target`, rendered: false },
      { name: 'external-redirect-blocked', redirect: 'https://example.com/escape-target', rendered: false },
      { name: 'workspace-mount-blocked', workspace: true, rendered: false },
    ];
    const results = [];
    for (const fixture of cases) {
      const events = [];
      const intercepted = [];
      const ses = session.fromPartition(`browser-viewer-smoke-${fixture.name}-${Date.now()}`);
      // All HTTPS is served locally, including the escaped-host negative case.
      // Block every other remote request before it can reach the network.
      ses.webRequest.onBeforeRequest((details, callback) => {
        const url = new URL(details.url);
        callback({ cancel: url.protocol !== 'https:' && url.origin !== origin });
      });
      ses.protocol.handle('https', async request => {
        intercepted.push(request.url);
        if (fixture.replace && request.url.includes('synthetic-fixture')) await pause(300);
        if (fixture.redirect && request.url.includes(fixture.replace ? 'synthetic-replacement' : 'synthetic-fixture')) {
          if (fixture.replace) await pause(100);
          return new Response(null, { status: 302, headers: { Location: fixture.redirect } });
        }
        return new Response('<!doctype html><body style="margin:0;background:#dbe9d9;color:#18301b;font:32px system-ui;padding:24px">Controlled viewer pixels rendered</body>',
          { headers: { 'Content-Type': 'text/html' } });
      });
      const win = new BrowserWindow({ show: false, width: 900, height: 700,
        webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false } });
      const wc = win.webContents;
      const guard = policy.createBrowserViewerNavigationGuard();
      const input = event => ({ targetUrl: event.url, isMainFrame: event.isMainFrame,
        frame: event.frame, initiator: event.initiator, mainFrame: wc.mainFrame, trustedOrigins: new Set([origin]) });
      const record = (kind, event, decision) => events.push({ kind, decision,
        isMainFrame: event.isMainFrame, initiallyEmpty: !event.frame?.url,
        directParent: event.frame?.parent?.frameTreeNodeId === wc.mainFrame.frameTreeNodeId,
        dashboardInitiator: event.initiator?.frameTreeNodeId === wc.mainFrame.frameTreeNodeId });
      wc.on('will-frame-navigate', event => {
        guard.prune(new Set(wc.mainFrame.framesInSubtree.map(frame => frame.frameTreeNodeId)));
        const decision = fixture.before ? 'unhandled' : guard.navigation(input(event));
        const allowed = decision === 'allow' || (decision === 'unhandled' && new URL(event.url).origin === origin);
        if (!allowed) event.preventDefault();
        record('navigation', event, allowed ? 'allow' : 'block');
      });
      wc.on('will-redirect', event => {
        const decision = guard.redirect(input(event));
        if (decision === 'block') event.preventDefault();
        record('redirect', event, decision);
      });
      const settled = (isMainFrame, processId, routingId, mainDocumentCommitted = false) => {
        if (isMainFrame) { if (mainDocumentCommitted) guard.clear(); return; }
        const frames = wc.mainFrame.framesInSubtree;
        guard.settled(processId, routingId, frames.find(f => f.processId === processId && f.routingId === routingId)?.frameTreeNodeId);
        guard.prune(new Set(frames.map(f => f.frameTreeNodeId)));
      };
      wc.on('did-frame-navigate', (_e, _u, _c, _t, main, pid, rid) => settled(main, pid, rid, true));
      wc.on('did-fail-load', (_e, _c, _t, _u, main, pid, rid) => settled(main, pid, rid));
      wc.on('did-fail-provisional-load', (_e, _c, _t, _u, main, pid, rid) => settled(main, pid, rid));
      wc.on('destroyed', () => guard.clear());
      try {
        await win.loadURL(origin + (fixture.workspace ? '/console/spaces/fixture/view/' : '/console/chat'));
        await wc.executeJavaScript('document.querySelector("#mount").click()');
        if (fixture.replace) {
          for (let attempt = 0; attempt < 40 && !intercepted.length; attempt++) await pause(10);
          assert.ok(intercepted.length, 'replacement must cancel an in-flight first viewer request');
          await wc.executeJavaScript('document.querySelector("iframe").src="https://www.browserbase.com/view?token=synthetic-replacement"');
        }
        for (let attempt = 0; attempt < 40; attempt++) {
          if (fixture.rendered ? wc.mainFrame.frames[0]?.url.startsWith('https://www.browserbase.com/')
            : events.some(event => event.decision === 'block')) break;
          await pause(50);
        }
        const frame = wc.mainFrame.frames[0];
        const text = frame?.url ? await frame.executeJavaScript('document.body.innerText') : '';
        assert.equal(text.includes('Controlled viewer pixels rendered'), fixture.rendered, fixture.name);
        if (fixture.redirect) {
          assert.ok(events.some(event => event.kind === 'redirect' && event.decision === (fixture.rendered ? 'allow' : 'block')), fixture.name);
        }
        if (!fixture.rendered) {
          assert.ok(!frame?.url, `${fixture.name}: rejected frame must not commit`);
          assert.ok(!intercepted.some(url => url.includes('escape-target')), `${fixture.name}: escaped HTTPS target was requested`);
        }
        if (fixture.name === 'viewer-renders' || fixture.before) {
          await pause(100);
          fs.writeFileSync(path.join(output, `${fixture.name}.png`), (await wc.capturePage()).toPNG());
        }
        results.push({ name: fixture.name, pass: true, rendered: fixture.rendered, events });
      } finally { win.destroy(); }
    }
    assert.ok(!localRequests.some(url => url.includes('escape-target')), 'no redirected localhost request should reach the server');
    const receipt = { electron: process.versions.electron, liveProvider: false, installedApp: false, results };
    fs.writeFileSync(path.join(output, 'native-navigation-smoke.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt));
    await new Promise(resolve => server.close(resolve));
    clearTimeout(timeout);
    app.exit(0);
  })().catch(error => { console.error(error.stack); server?.close(); clearTimeout(timeout); app.exit(1); });
}
