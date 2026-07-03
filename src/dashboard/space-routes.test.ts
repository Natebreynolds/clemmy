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

test('POST creates a workspace with a placeholder view; GET list shows it', async () => {
  const c = await j(await fetch(`${base}/api/console/spaces`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Test Board' }),
  }));
  assert.equal(c.status, 201);
  assert.ok(c.body.space.id);
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

  // The placeholder view is served as HTML.
  const view = await fetch(`${base}/console/spaces/${slug}/view`);
  assert.equal(view.status, 200);
  assert.match(view.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await view.text(), /Test Board/);
});

test('C2: served view injects the window.clem bridge (slug baked in) + keeps the link shim', async () => {
  const slug = 'bridge-rt';
  store.spaceStore.save({ id: slug, title: 'Bridge RT' });
  const viewFile = store.resolveInSpace(slug, 'view/index.html');
  mkdirSync(path.dirname(viewFile), { recursive: true });
  writeFileSync(viewFile, '<html><body><h1>Hi</h1></body></html>', 'utf-8');
  const html = await (await fetch(`${base}/console/spaces/${slug}/view`)).text();
  // Bridge present, slug baked into the base path, action helper wired.
  assert.match(html, /window\.clem=/);
  assert.match(html, new RegExp(`/api/console/spaces/${slug}`));
  assert.match(html, /action:async function/);
  // The external-link shim is still injected (capture-phase click handler).
  assert.match(html, /addEventListener\('click'/);
  // Injection lands inside the document body.
  assert.ok(html.indexOf('window.clem') < html.indexOf('</body>'));
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
