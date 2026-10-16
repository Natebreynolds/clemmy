/** Real HTTP history controls: slim reads keep the existing public contract. */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs, { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-desktop-history-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const { registerConsoleRoutes } = await import('./console-routes.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { _resetWorkflowRunInventoryForTests } = await import('../execution/workflow-run-inventory.js');
const { resetEventLog } = await import('../runtime/harness/eventlog.js');

test.beforeEach(() => {
  for (const dir of [WORKFLOWS_DIR, WORKFLOW_RUNS_DIR]) {
    assert.ok(dir.startsWith(home + path.sep));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  _resetWorkflowRunInventoryForTests();
});
test.after(() => { resetEventLog(); rmSync(home, { recursive: true, force: true }); });

async function boot() {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => true, { getRuntime: () => ({ listPendingApprovals: () => [] }) } as never,
    { serveLegacyAtRoot: false });
  const server: Server = await new Promise(resolve => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function catalog() {
  return writeWorkflow('fixture-history', { name: 'Fixture History', description: 'Controlled history only.',
    enabled: true, trigger: { manual: true }, steps: [{ id: 'read', prompt: 'Read the fixture.', sideEffect: 'read' }] });
}
function run(id: string, fields: Record<string, unknown> = {}) {
  const file = path.join(WORKFLOW_RUNS_DIR, `${id}.json`);
  writeFileSync(file, JSON.stringify({ id, workflow: 'Fixture History', status: 'running',
    createdAt: '2026-10-16T01:00:00.000Z', ...fields }));
  return file;
}
async function history(url: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return (await response.json() as { runs: Array<Record<string, unknown>> }).runs;
}

test('desktop workflow history reuses unchanged records and observes preserved-mtime replacement, deletion and corruption', async t => {
  catalog();
  const files = Array.from({ length: 24 }, (_, i) => run(`history-${String(i).padStart(2, '0')}`, {
    workflow: i % 2 ? 'Unrelated Workflow' : 'Fixture History',
    createdAt: `2026-10-16T01:${String(i).padStart(2, '0')}:00.000Z`,
    error: 'initial note', inputs: { privateInput: 'not public' },
    stepOutputs: { read: 'retained private output'.repeat(2_000) },
  }));
  const fixedTime = new Date('2026-10-16T01:00:00.000Z');
  utimesSync(files[22], fixedTime, fixedTime);
  const h = await boot();
  const reads = t.mock.method(fs, 'readFileSync');
  syncBuiltinESMExports();
  const count = () => reads.mock.calls.filter(call => typeof call.arguments[0] === 'string'
    && path.dirname(call.arguments[0]) === WORKFLOW_RUNS_DIR && call.arguments[0].endsWith('.json')).length;
  try {
    const url = h.url + '/api/console/workflows/fixture-history/runs?limit=50';
    const cold = await history(url);
    assert.equal(cold.length, 12);
    assert.equal(cold[0].id, 'history-22');
    assert.equal(count(), 24);
    reads.mock.resetCalls();
    assert.deepEqual(await history(url), cold);
    assert.equal(count(), 0, 'a warm desktop poll does not parse all retained execution bytes again');

    const file = files[22];
    const before = statSync(file);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const text = JSON.stringify({ ...raw, status: 'blocked', error: 'changed note' });
    assert.equal(Buffer.byteLength(text), before.size);
    const replacement = file + '.replacement';
    writeFileSync(replacement, text);
    utimesSync(replacement, before.atime, before.mtime);
    renameSync(replacement, file);
    assert.equal(statSync(file).mtimeMs, before.mtimeMs);
    reads.mock.resetCalls();
    const changed = await history(url);
    assert.equal(changed[0].status, 'blocked');
    assert.equal(changed[0].error, 'changed note');
    assert.equal(count(), 1);

    rmSync(file);
    writeFileSync(files[20], '{');
    reads.mock.resetCalls();
    const removed = await history(url);
    assert.equal(removed.some(item => item.id === 'history-22' || item.id === 'history-20'), false);
    assert.equal(removed.length, 10);
    assert.equal(count(), 1, 'only the corrupt replacement is re-read; deleted projections are evicted');
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); await h.close();
  }
});

test('desktop history preserves aliases, order, limits, terminal attention and the public field allowlist', async () => {
  catalog();
  run('older-by-slug', { workflow: 'fixture-history', status: 'completed',
    createdAt: '2026-10-15T01:00:00.000Z', finishedAt: '2026-10-15T02:00:00.000Z' });
  run('newer-blocked', { status: 'blocked_mutation', createdAt: '2026-10-16T02:00:00.000Z',
    error: 'x'.repeat(2_500), inputs: { privateInput: 'not public' }, output: 'private output',
    stepOutputs: { privateStep: 'not public' }, mutationContractSnapshot: { privateContract: 'not public' },
    workflowDefinitionSnapshot: { version: 1, definition: { privateDefinition: 'not public' } },
    capabilityBlock: { tool: 'fixture_read', reason: 'not-connected', privateEvidence: 'not public' },
    mutationBlock: { stepId: 'read', state: 'uncertain', providerRedispatched: false, privateEvidence: 'not public' },
  });
  for (const version of [2, 3]) run(`compiled-${version}`, { createdAt: '2026-10-16T03:00:00.000Z',
    workflowDefinitionSnapshot: { version, scope: 'compiled', compilerId: `project_graph_v${version - 1}` } });
  run('unrelated', { workflow: 'Other', createdAt: '2026-10-16T04:00:00.000Z' });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'array.json'), '[]');
  const h = await boot();
  try {
    const url = h.url + '/api/console/workflows/fixture-history/runs';
    const rows = await history(url);
    assert.deepEqual(rows.map(item => item.id), ['newer-blocked', 'older-by-slug']);
    assert.equal(rows[0].needsAttention, true);
    assert.equal((rows[0].error as string).length, 2_000);
    assert.deepEqual(rows[0].capabilityBlock, { tool: 'fixture_read', reason: 'not-connected' });
    assert.deepEqual(rows[0].mutationBlock, { stepId: 'read', state: 'uncertain', providerRedispatched: false });
    for (const key of ['inputs', 'output', 'stepOutputs', 'stepOutputKeys', 'workflowDefinitionSnapshot', 'mutationContractSnapshot']) {
      assert.equal(key in rows[0], false, key);
    }
    assert.deepEqual((await history(url + '?limit=1')).map(item => item.id), ['newer-blocked']);
    const named = await history(h.url + '/api/console/workflows/' + encodeURIComponent('Fixture History') + '/runs');
    assert.deepEqual(named, rows);
    assert.equal((await fetch(h.url + '/api/console/workflows/unknown/runs')).status, 404);
    rmSync(WORKFLOW_RUNS_DIR, { recursive: true });
    assert.deepEqual(await history(url), []);
  } finally { await h.close(); }
});

test('desktop history reports an unreadable run directory as an error rather than a successful empty history', async t => {
  catalog(); run('read-failure');
  const h = await boot();
  await history(h.url + '/api/console/workflows/fixture-history/runs');
  const original = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (...args) => {
    if (args[0] === WORKFLOW_RUNS_DIR) throw Object.assign(new Error('controlled directory read failure'), { code: 'EACCES' });
    return Reflect.apply(original, fs, args);
  });
  syncBuiltinESMExports();
  try {
    const response = await fetch(h.url + '/api/console/workflows/fixture-history/runs');
    assert.equal(response.status, 500);
    assert.equal('runs' in await response.json(), false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await h.close(); }
});
