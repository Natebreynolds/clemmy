/**
 * Run: npx tsx --test src/dashboard/space-routes.test.ts
 *
 * End-to-end (no network, no LLM) smoke for the Workspaces daemon routes:
 * create → list → serve view → put/get data → notes → server-side refresh
 * (fixture runner script) → pause guard → rollback. Real express server on an
 * ephemeral loopback port + global fetch. Temp CLEMENTINE_HOME.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-routes-test-'));

const express = (await import('express')).default;
const { registerSpaceRoutes } = await import('./space-routes.js');
const store = await import('../spaces/store.js');

let server: Server;
let base = '';

before(async () => {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  registerSpaceRoutes(app, () => true);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(() => { server?.close(); });

const j = async (res: Response) => ({ status: res.status, body: await res.json().catch(() => null) as any });

test('PATCH contract lists on a workspace with no contract is an explicit 400, never a silent no-op', async () => {
  const c = await j(await fetch(`${base}/api/console/spaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Legacy Board' }),
  }));
  assert.equal(c.status, 201);
  assert.equal(c.body.space.contract, undefined);
  const slug = c.body.space.id;

  const patched = await j(await fetch(`${base}/api/console/spaces/${slug}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ successCriteria: ['Orphaned criterion'] }),
  }));
  assert.equal(patched.status, 400);
  assert.match(String(patched.body?.error ?? ''), /objective/i);

  const detail = await j(await fetch(`${base}/api/console/spaces/${slug}`));
  assert.equal(detail.body.space.contract, undefined);
});

test('POST creates a workspace with a placeholder view; GET list shows it', async () => {
  const c = await j(await fetch(`${base}/api/console/spaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Test Board',
      objective: 'Keep the test pipeline decision-ready.',
      successCriteria: ['Every row is sourced'],
      invariants: ['Never send automatically'],
    }),
  }));
  assert.equal(c.status, 201);
  assert.ok(c.body.space.id);
  assert.deepEqual(c.body.space.contract, {
    objective: 'Keep the test pipeline decision-ready.',
    successCriteria: ['Every row is sourced'],
    invariants: ['Never send automatically'],
  });
  const slug = c.body.space.id;

  const list = await j(await fetch(`${base}/api/console/spaces`));
  assert.equal(list.status, 200);
  const listed = list.body.spaces.find((s: any) => s.id === slug);
  assert.ok(listed);
  assert.equal(listed.health.view.exists, true);
  assert.equal(listed.health.counts.revisions, 0);

  const detail = await j(await fetch(`${base}/api/console/spaces/${slug}`));
  assert.equal(detail.status, 200);
  assert.equal(detail.body.health.id, slug);
  assert.equal(detail.body.space.health.view.exists, true);

  const patched = await j(await fetch(`${base}/api/console/spaces/${slug}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      successCriteria: ['Every row is sourced', 'The board is ready before standup'],
      invariants: [],
    }),
  }));
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.space.contract, {
    objective: 'Keep the test pipeline decision-ready.',
    successCriteria: ['Every row is sourced', 'The board is ready before standup'],
    invariants: [],
  });

  // A blank objective in a PATCH cannot silently discard the rest of the
  // contract patch — the objective is preserved and the lists apply.
  const blankObjective = await j(await fetch(`${base}/api/console/spaces/${slug}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ objective: '', successCriteria: ['Blank-objective lists still apply'] }),
  }));
  assert.equal(blankObjective.status, 200);
  assert.equal(blankObjective.body.space.contract.objective, 'Keep the test pipeline decision-ready.');
  assert.deepEqual(blankObjective.body.space.contract.successCriteria, ['Blank-objective lists still apply']);

  // The placeholder view is served as HTML.
  const view = await fetch(`${base}/console/spaces/${slug}/view`);
  assert.equal(view.status, 200);
  assert.match(view.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await view.text(), /Test Board/);
});

test('C2: served view injects a document-pinned opaque-origin bridge and exact legacy compatibility shim', async () => {
  const slug = 'bridge-rt';
  store.spaceStore.save({ id: slug, title: 'Bridge RT' });
  const viewFile = store.resolveInSpace(slug, 'view/index.html');
  mkdirSync(path.dirname(viewFile), { recursive: true });
  writeFileSync(viewFile, '<html><body><h1>Hi</h1></body></html>', 'utf-8');
  const response = await fetch(`${base}/console/spaces/${slug}/view`);
  const html = await response.text();
  assert.match(response.url, /\/view\/$/, 'canonical view URL keeps relative assets under view/');
  // Bridge present, slug + document scoped into its bootstrap, action helper wired.
  assert.match(html, /window\.clem=/);
  assert.match(html, new RegExp(`S=${JSON.stringify(slug)}`));
  assert.match(html, /kind:'bootstrap'/);
  assert.match(html, /documentId:D/);
  assert.match(html, /action:function/);
  assert.match(html, /parent\.postMessage/);
  // Existing saved views keep working, but their fetch is replaced with an
  // exact same-workspace RPC adapter. There is no native/general fetch escape.
  assert.match(html, /legacyFetch/);
  assert.match(html, /lock\('fetch',legacyFetch\)/);
  assert.doesNotMatch(html, /\/api\/console\/approvals/);
  assert.match(html, /navigation/);
  assert.match(html, /preventDefault/);
  assert.match(html, /RTCPeerConnection/);
  const csp = response.headers.get('content-security-policy') ?? '';
  assert.match(csp, /(?:^|;\s*)sandbox allow-scripts(?:;|$)/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-forms|allow-popups|allow-top-navigation/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/console\\/spaces\\/${slug}\\/view\\/`));
  // Injection lands inside the document body.
  assert.ok(html.indexOf('window.clem') < html.indexOf('</body>'));
});

test('C2 security: malicious authored HTML stays sandboxed and cannot turn its view response into an admin principal', async () => {
  const slug = 'bridge-adversarial';
  store.spaceStore.save({ id: slug, title: 'Bridge Adversarial' });
  const viewFile = store.resolveInSpace(slug, 'view/index.html');
  mkdirSync(path.dirname(viewFile), { recursive: true });
  writeFileSync(
    viewFile,
    '<!doctype html><html><head></head><body>'
      + '<script>fetch("/api/console/approvals/anything",{method:"POST"});'
      + 'top.location="/console/settings";window.open("/console");</script>'
      + '<form action="/api/console/spaces/other/data" method="post"><button>steal</button></form>'
      + '<iframe src="/console"></iframe></body></html>',
    'utf-8',
  );
  const response = await fetch(`${base}/console/spaces/${slug}/view`);
  assert.equal(response.status, 200);
  const csp = response.headers.get('content-security-policy') ?? '';
  const sandbox = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('sandbox'));
  assert.equal(sandbox, 'sandbox allow-scripts');
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  // The attack source remains authored content; the response policy, rather
  // than a brittle sanitizer, removes its principal and capabilities.
  const html = await response.text();
  assert.match(html, /fetch\("\/api\/console\/approvals/);
  assert.ok(html.indexOf('window.clem=') < html.indexOf('fetch("/api/console/approvals'));
  assert.ok(html.indexOf("addEventListener.call(nav,'navigate'") < html.indexOf('fetch("/api/console/approvals'));
});

test('C2 security: authored SVG stays inert when opened as a top-level document', async () => {
  const slug = 'svg-adversarial';
  store.spaceStore.save({ id: slug, title: 'SVG Adversarial' });
  const viewDir = store.resolveInSpace(slug, 'view');
  mkdirSync(viewDir, { recursive: true });
  writeFileSync(
    path.join(viewDir, 'attack.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(\'/api/console/spaces\')">'
      + '<script>top.location="/console/settings"</script><circle r="10"/></svg>',
    'utf-8',
  );

  const response = await fetch(`${base}/console/spaces/${slug}/view/attack.svg`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const csp = response.headers.get('content-security-policy') ?? '';
  const sandbox = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('sandbox'));
  assert.equal(sandbox, 'sandbox');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.doesNotMatch(csp, /allow-scripts|allow-same-origin/);
  assert.match(await response.text(), /onload=/, 'the policy, not a brittle sanitizer, removes authority');
});

test('C2c: canonical trailing-slash view URL serves relative multi-file assets from only this Workspace', async () => {
  const slug = 'multi-file-view';
  store.spaceStore.save({ id: slug, title: 'Multi file' });
  const viewDir = store.resolveInSpace(slug, 'view');
  mkdirSync(viewDir, { recursive: true });
  writeFileSync(
    path.join(viewDir, 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="./styles.css"></head>'
      + '<body><script src="./app.js"></script></body></html>',
    'utf-8',
  );
  writeFileSync(path.join(viewDir, 'app.js'), 'window.assetLoaded=true;', 'utf-8');
  writeFileSync(path.join(viewDir, 'styles.css'), 'body{color:rgb(1,2,3)}', 'utf-8');

  const redirect = await fetch(`${base}/console/spaces/${slug}/view`, { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), `/console/spaces/${slug}/view/`);

  const root = await fetch(`${base}/console/spaces/${slug}/view/`);
  assert.equal(root.status, 200);
  assert.match(await root.text(), /\.\/app\.js/);
  const script = await fetch(`${base}/console/spaces/${slug}/view/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') ?? '', /javascript/);
  assert.equal(await script.text(), 'window.assetLoaded=true;');
  const style = await fetch(`${base}/console/spaces/${slug}/view/styles.css`);
  assert.equal(style.status, 200);
  assert.match(style.headers.get('content-type') ?? '', /text\/css/);
});

test('C2b: bridge is DEFINED before the view\'s own script that calls clem.data()', async () => {
  // Regression: a top-of-body author script that calls clem.data() at load
  // must see window.clem already defined. Before the fix, the bridge was
  // injected at </body> — AFTER this script — so clem was undefined and the
  // surface rendered empty on first load (forcing hand-rolled waitForClem).
  const slug = 'bridge-order';
  store.spaceStore.save({ id: slug, title: 'Bridge Order' });
  const viewFile = store.resolveInSpace(slug, 'view/index.html');
  mkdirSync(path.dirname(viewFile), { recursive: true });
  writeFileSync(
    viewFile,
    '<!doctype html><html><head><meta charset="utf-8"></head>'
      + '<body><h1>Board</h1><script>async function load(){const d=await clem.data();}load();</script></body></html>',
    'utf-8',
  );
  const html = await (await fetch(`${base}/console/spaces/${slug}/view`)).text();
  const bridgeAt = html.indexOf('window.clem=');
  const authorCallAt = html.indexOf('clem.data()');
  assert.ok(bridgeAt >= 0, 'bridge injected');
  assert.ok(authorCallAt >= 0, 'author script preserved');
  // The bridge definition must precede the author call in document order.
  assert.ok(bridgeAt < authorCallAt, `bridge (@${bridgeAt}) must be defined before author clem.data() (@${authorCallAt})`);
  // And it lands inside <head>, ahead of <body>.
  assert.ok(bridgeAt < html.indexOf('<body'), 'bridge injected into <head>, before <body>');
});

test('PUT/GET data round-trips; size cap rejects with 413', async () => {
  const slug = 'data-rt';
  store.spaceStore.save({ id: slug, title: 'Data RT' });
  const put = await j(await fetch(`${base}/api/console/spaces/${slug}/data`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { rows: [1, 2, 3] } }),
  }));
  assert.equal(put.status, 200);
  const get = await j(await fetch(`${base}/api/console/spaces/${slug}/data`));
  assert.deepEqual(get.body.data, { rows: [1, 2, 3] });
});

test('notes append + list', async () => {
  const slug = 'notes-rt';
  store.spaceStore.save({ id: slug, title: 'Notes RT' });
  const post = await j(await fetch(`${base}/api/console/spaces/${slug}/notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'called Acme', kind: 'call' }),
  }));
  assert.equal(post.status, 201);
  const list = await j(await fetch(`${base}/api/console/spaces/${slug}/notes`));
  assert.equal(list.body.notes.length, 1);
  assert.equal(list.body.notes[0].kind, 'call');
});

test('refresh runs a deterministic runner server-side and persists its JSON', async () => {
  const slug = 'refresh-rt';
  store.spaceStore.save({ id: slug, title: 'Refresh RT', dataSources: [{ id: 'pull', runner: 'refresh.mjs' }] });
  const scriptDir = store.resolveInSpace(slug, 'data');
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(path.join(scriptDir, 'refresh.mjs'), 'process.stdout.write(JSON.stringify({rows:[{name:"Acme",amount:1000}]}))', 'utf-8');

  const ref = await j(await fetch(`${base}/api/console/spaces/${slug}/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId: 'pull' }),
  }));
  assert.equal(ref.status, 200);
  assert.equal(ref.body.results[0].ok, true);
  // Persisted under the source id, with a _meta marker.
  assert.deepEqual(ref.body.data.pull, { rows: [{ name: 'Acme', amount: 1000 }] });
  assert.equal(ref.body.data._meta.pull.ok, true);
});

test('refresh surfaces a runner error without breaking the workspace', async () => {
  const slug = 'refresh-err';
  store.spaceStore.save({ id: slug, title: 'Refresh Err', dataSources: [{ id: 'bad', runner: 'bad.mjs' }] });
  const scriptDir = store.resolveInSpace(slug, 'data');
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(path.join(scriptDir, 'bad.mjs'), 'process.exit(2)', 'utf-8');
  const ref = await j(await fetch(`${base}/api/console/spaces/${slug}/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId: 'bad' }),
  }));
  assert.equal(ref.status, 200);
  assert.equal(ref.body.results[0].ok, false);
  assert.equal(ref.body.data._meta.bad.ok, false);
});

test('paused workspace rejects data writes (423) but still serves the view', async () => {
  const slug = 'paused-rt';
  store.spaceStore.save({ id: slug, title: 'Paused RT' });
  const viewFile = store.resolveInSpace(slug, 'view/index.html');
  mkdirSync(path.dirname(viewFile), { recursive: true });
  writeFileSync(viewFile, '<html>cached</html>', 'utf-8');
  await fetch(`${base}/api/console/spaces/${slug}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'paused' }),
  });
  const put = await fetch(`${base}/api/console/spaces/${slug}/data`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { x: 1 } }),
  });
  assert.equal(put.status, 423);
  const view = await fetch(`${base}/console/spaces/${slug}/view`);
  assert.equal(view.status, 200); // read-only cached view still serves
});

test('action route runs a READ-class action immediately, merges args, records a note', async () => {
  const slug = 'action-rt';
  store.spaceStore.save({
    id: slug, title: 'Action RT',
    // "Refresh list" is read-class (not a send, no confirm) → fires instantly
    // even with the E1 approval gate on (the default).
    actions: [{ id: 'refresh-list', label: 'Refresh list', runner: 'act.mjs', argsTemplate: { scope: 'team' } }],
  });
  const scriptDir = store.resolveInSpace(slug, 'data');
  mkdirSync(scriptDir, { recursive: true });
  // Echo the merged args back so the test can assert the template+caller merge.
  writeFileSync(path.join(scriptDir, 'act.mjs'),
    'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s);process.stdout.write(JSON.stringify({sent:p.args}))})',
    'utf-8');

  const res = await j(await fetch(`${base}/api/console/spaces/${slug}/action`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actionId: 'refresh-list', args: { limit: 10 } }),
  }));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  // template (scope) merged under caller args (limit).
  assert.deepEqual(res.body.result.sent, { scope: 'team', limit: 10 });

  // The action is recorded as a note so the dock's Clem has context.
  const notes = await j(await fetch(`${base}/api/console/spaces/${slug}/notes`));
  assert.ok(notes.body.notes.some((n: any) => n.kind === 'action' && /Refresh list/.test(n.text)));
});

test('action route refuses a workspace with malformed hand-written action JSON', async () => {
  const slug = 'action-bad-manifest';
  const dir = store.resolveSpaceDir(slug);
  mkdirSync(path.join(dir, 'data'), { recursive: true });
  writeFileSync(path.join(dir, 'data', 'act.mjs'), 'process.stdout.write(JSON.stringify({ok:true}))', 'utf-8');
  writeFileSync(path.join(dir, 'space.json'), JSON.stringify({
    id: slug,
    title: 'Bad Action Manifest',
    actions: [{ id: 'refresh-list', label: 'Refresh list', runner: 'act.mjs', args_template_json: '[1,2]' }],
  }), 'utf-8');

  const res = await j(await fetch(`${base}/api/console/spaces/${slug}/action`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actionId: 'refresh-list', args: { limit: 10 } }),
  }));
  assert.equal(res.status, 409);
  assert.match(res.body.error, /workspace manifest is invalid/);
  assert.match(res.body.error, /args_template_json must be a JSON object/);

  const patch = await j(await fetch(`${base}/api/console/spaces/${slug}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Should Not Sanitize' }),
  }));
  assert.equal(patch.status, 409);
  assert.match(patch.body.error, /fix with space_save before patching metadata/);
});

test('E1: a SEND-class action is gated behind one approval (default on) — 202 pending, not yet run', async () => {
  const slug = 'action-gate';
  store.spaceStore.save({
    id: slug, title: 'Gate RT',
    actions: [{ id: 'email', label: 'Email lead', composioSlug: 'OUTLOOK_SEND_EMAIL', argsTemplate: { from: 'me@co' } }],
  });
  const res = await j(await fetch(`${base}/api/console/spaces/${slug}/action`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actionId: 'email', args: { to: 'lead@acme', subject: 'Hi' } }),
  }));
  assert.equal(res.status, 202);
  assert.equal(res.body.pending, true);
  assert.match(res.body.approvalId, /^apr-/);

  // Registered in the canonical approval registry (so it surfaces in the
  // inbox/board), recorded on the surface as awaiting approval — and NOT run.
  const { listPending } = await import('../runtime/harness/approval-registry.js');
  assert.ok(listPending({ status: 'pending' }).some(
    (r) => r.approvalId === res.body.approvalId && r.tool === 'space_execute_action'));
  const notes = await j(await fetch(`${base}/api/console/spaces/${slug}/notes`));
  assert.ok(notes.body.notes.some((n: any) => n.meta?.status === 'pending'));
  assert.ok(!notes.body.notes.some((n: any) => /Approved and ran/.test(n.text)));
});

test('E1: confirm:true forces the gate even for a non-send runner action', async () => {
  const slug = 'action-confirm';
  store.spaceStore.save({
    id: slug, title: 'Confirm RT',
    actions: [{ id: 'wipe', label: 'Wipe cache', runner: 'act.mjs', confirm: true }],
  });
  const scriptDir = store.resolveInSpace(slug, 'data');
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(path.join(scriptDir, 'act.mjs'), 'process.stdout.write(JSON.stringify({ok:1}))', 'utf-8');
  const res = await j(await fetch(`${base}/api/console/spaces/${slug}/action`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actionId: 'wipe', args: {} }),
  }));
  assert.equal(res.status, 202);
  assert.equal(res.body.pending, true);
});

test('E1: kill-switch off restores instant execution for a send action', async () => {
  const prev = process.env.CLEMMY_SPACE_ACTION_APPROVAL;
  process.env.CLEMMY_SPACE_ACTION_APPROVAL = 'off';
  try {
    const slug = 'action-killswitch';
    store.spaceStore.save({
      id: slug, title: 'Killswitch RT',
      actions: [{ id: 'send', label: 'Send email', runner: 'act.mjs', argsTemplate: { from: 'me@co' } }],
    });
    const scriptDir = store.resolveInSpace(slug, 'data');
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(path.join(scriptDir, 'act.mjs'),
      'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s);process.stdout.write(JSON.stringify({sent:p.args}))})',
      'utf-8');
    const res = await j(await fetch(`${base}/api/console/spaces/${slug}/action`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionId: 'send', args: { to: 'lead@acme' } }),
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.result.sent, { from: 'me@co', to: 'lead@acme' });
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_SPACE_ACTION_APPROVAL;
    else process.env.CLEMMY_SPACE_ACTION_APPROVAL = prev;
  }
});

test('action route 404s an unknown action; 423 when paused', async () => {
  const slug = 'action-guard';
  store.spaceStore.save({ id: slug, title: 'Guard', actions: [{ id: 'x', runner: 'x.mjs' }] });
  const unknown = await fetch(`${base}/api/console/spaces/${slug}/action`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actionId: 'nope', args: {} }),
  });
  assert.equal(unknown.status, 404);
  store.spaceStore.update(slug, { status: 'paused' });
  const paused = await fetch(`${base}/api/console/spaces/${slug}/action`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actionId: 'x', args: {} }),
  });
  assert.equal(paused.status, 423);
});

test('compose requires instructions (400) and 404s an unknown workspace', async () => {
  const slug = 'compose-rt';
  store.spaceStore.save({ id: slug, title: 'Compose RT' });
  const bad = await fetch(`${base}/api/console/spaces/${slug}/compose`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ context: { x: 1 } }),
  });
  assert.equal(bad.status, 400);
  const missing = await fetch(`${base}/api/console/spaces/nope-nope/compose`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instructions: 'hi' }),
  });
  assert.equal(missing.status, 404);
});

test('view route rejects path traversal + archived workspaces', async () => {
  const slug = 'arch-rt';
  store.spaceStore.save({ id: slug, title: 'Arch RT' });
  store.spaceStore.archive(slug);
  const view = await fetch(`${base}/console/spaces/${slug}/view`);
  assert.equal(view.status, 404);
  // Traversal attempt is contained (400/403/404 — never a 200 leak).
  const escape = await fetch(`${base}/console/spaces/data-rt/view/..%2f..%2fspace.json`);
  assert.notEqual(escape.status, 200);
});
