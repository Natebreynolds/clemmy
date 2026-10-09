/**
 * Run: CLEMMY_TEST_REAL_BROWSER=1 node scripts/run-tests-isolated.mjs src/dashboard/space-view-live-data.test.ts
 *
 * A page that registers clem.onData receives new data in place over its
 * private channel: the served bridge asks the host to subscribe, and a pushed
 * dataset reaches the callback and replaces window.__SPACE_DATA__. Runs the
 * exact served document in a real installed browser; skipped otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-live-data-test-'));
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const store = await import('../spaces/store.js');
const { composeServedWorkspaceView } = await import('./space-routes.js');
const preview = await import('../spaces/space-preview.js');

const hostPage = (slug: string) => `<!doctype html><html><body>
<iframe id="frame" sandbox="allow-scripts" src="view.html" style="width:600px;height:400px;border:0"></iframe>
<script>(function(){
var C='clementine.workspace.rpc.v1',S=${JSON.stringify(slug)},frame=document.getElementById('frame'),pinned=false;
window.addEventListener('message',function(e){var m=e.data;if(!m||m.channel!==C||m.kind!=='bootstrap'||pinned)return;pinned=true;
var rpc=new MessageChannel(),gesture=new MessageChannel();
rpc.port1.onmessage=function(pe){var r=pe.data;if(!r||r.kind!=='request')return;
if(r.op==='subscribe'){rpc.port1.postMessage({channel:C,version:1,kind:'response',workspaceId:S,id:r.id,ok:true,result:{subscribed:true}});
rpc.port1.postMessage({channel:C,version:1,kind:'push',workspaceId:S,op:'data',data:{n:2}});
rpc.port1.postMessage({channel:C,version:1,kind:'push',workspaceId:'another-space',op:'data',data:{n:99}});}};
rpc.port1.start();frame.contentWindow.postMessage({channel:C,version:1,kind:'bootstrap_ack',workspaceId:S,documentId:m.documentId},'*',[rpc.port2,gesture.port2]);});
})();</script></body></html>`;

test('a page registered with clem.onData receives pushed data in place', { skip: process.env.CLEMMY_TEST_REAL_BROWSER !== '1' }, async () => {
  const browser = preview.findPreviewBrowser();
  assert.ok(browser, 'CLEMMY_TEST_REAL_BROWSER=1 needs an installed Chromium-family browser');
  const slug = 'live-data-check';
  store.spaceStore.save({ id: slug, title: 'Live data check', viewContent: '<p>live</p>' });
  // The page reports what it received as an uncaught error, which the browser
  // logs to stderr; a callback that never runs leaves no such line.
  const authored = '<!doctype html><html><body><script>'
    + 'clem.onData(function(d){setTimeout(function(){throw new Error("PUSHED " + d.n + " " + window.__SPACE_DATA__.n);});});'
    + '</script></body></html>';
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-live-data-page-'));
  try {
    writeFileSync(path.join(dir, 'view.html'), composeServedWorkspaceView(slug, authored), 'utf8');
    writeFileSync(path.join(dir, 'index.html'), hostPage(slug), 'utf8');
    const shot = path.join(dir, 'shot.png');
    const child = spawn(browser!, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${path.join(dir, 'profile')}`, '--window-size=640,480',
      '--virtual-time-budget=4000', '--enable-logging=stderr', '--v=0',
      `--screenshot=${shot}`, pathToFileURL(path.join(dir, 'index.html')).href,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    child.stderr!.on('data', (chunk: Buffer) => { log += chunk.toString('utf8'); });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 30_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    assert.ok(existsSync(shot), 'the browser rendered the page');
    const problems = preview.pageProblemsFromBrowserLog(log).join('\n');
    assert.match(problems, /PUSHED 2 2/, 'the callback got the pushed data and the planted dataset was replaced');
    assert.doesNotMatch(problems, /PUSHED 99/, 'a push addressed to another Space is ignored');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
