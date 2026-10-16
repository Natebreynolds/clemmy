/** Controlled HTTP coverage: one run-inventory generation per catalog request. */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs, { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-console-inventory-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
const { registerConsoleRoutes } = await import('./console-routes.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { _resetWorkflowRunInventoryForTests } = await import('../execution/workflow-run-inventory.js');
const { resetEventLog } = await import('../runtime/harness/eventlog.js');

test.beforeEach(() => {
  // Only this module's disposable fixture directories are eligible for reset.
  for (const dir of [WORKFLOWS_DIR, WORKFLOW_RUNS_DIR]) {
    assert.ok(dir.startsWith(TEST_HOME + path.sep));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  _resetWorkflowRunInventoryForTests();
});
test.after(() => {
  resetEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function boot() {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => true, {
    getRuntime: () => ({ listPendingApprovals: () => [] }),
  } as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise(resolve => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function seed(slug: string, name: string, status = 'running'): string {
  writeWorkflow(slug, { name, description: 'Controlled read-only catalog fixture.', enabled: true,
    trigger: { manual: true }, steps: [{ id: 'read', prompt: 'Read the fixture.', sideEffect: 'read' }] });
  const file = path.join(WORKFLOW_RUNS_DIR, `${slug}-latest.json`);
  writeFileSync(file, JSON.stringify({ id: `${slug}-latest`, workflow: name, status,
    createdAt: '2026-10-16T01:00:00.000Z', stepOutputs: { read: 'fixture-output'.repeat(2_000) } }));
  return file;
}

type WorkflowView = {
  name: string;
  lastRunStatus?: string;
  lastRun?: { status: string };
  proof: { evidence: { latestRun: { status: string; id: string } | null } };
};

async function getWorkflows(url: string): Promise<WorkflowView[]> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return (await response.json() as { workflows: WorkflowView[] }).workflows;
}

for (const route of ['/api/console/workflows', '/api/console/workflows/home']) {
  test(`${route} scans run metadata once per request and reuses only unchanged JSON`, async t => {
    const files = Array.from({ length: 4 }, (_, i) => seed(`inventory-${i}`, `Inventory ${i}`));
    for (let i = 0; i < 4; i++) writeFileSync(path.join(WORKFLOW_RUNS_DIR, `inventory-${i}-old.json`),
      JSON.stringify({ id: `inventory-${i}-old`, workflow: `Inventory ${i}`, status: 'completed',
        createdAt: '2026-10-15T01:00:00.000Z', finishedAt: '2026-10-15T02:00:00.000Z' }));
    // A compiled project sharing a display name must still stay off the catalog.
    writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'inventory-private-compiled.json'), JSON.stringify({
      id: 'inventory-private-compiled', workflow: 'Inventory 0', status: 'completed',
      createdAt: '2026-10-16T03:00:00.000Z', workflowDefinitionSnapshot: {
        version: 3, scope: 'compiled', compilerId: 'project_graph_v2', definition: { private: 'not catalog evidence' },
      },
    }));
    const corpusSize = 9;
    const h = await boot();
    const reads = t.mock.method(fs, 'readFileSync');
    const stats = t.mock.method(fs, 'statSync');
    const listings = t.mock.method(fs, 'readdirSync');
    syncBuiltinESMExports();
    const isRun = (value: unknown): value is string => typeof value === 'string'
      && path.dirname(value) === WORKFLOW_RUNS_DIR && value.endsWith('.json');
    const counts = () => ({
      reads: reads.mock.calls.filter(c => isRun(c.arguments[0])).length,
      stats: stats.mock.calls.filter(c => isRun(c.arguments[0])).length,
      listings: listings.mock.calls.filter(c => c.arguments[0] === WORKFLOW_RUNS_DIR).length,
    });
    const resetCounts = () => { reads.mock.resetCalls(); stats.mock.resetCalls(); listings.mock.resetCalls(); };
    try {
      await getWorkflows(h.url + route);
      const cold = counts();
      resetCounts();
      const warm = await getWorkflows(h.url + route);
      const warmCounts = counts();
      t.diagnostic(JSON.stringify({ route, workflows: 4, runFiles: corpusSize, cold, warm: warmCounts }));
      assert.deepEqual(warmCounts, { reads: 0, stats: corpusSize, listings: 1 });
      assert.equal(warm.length, 4);
      assert.equal(warm.find(w => w.name === 'Inventory 0')?.proof.evidence.latestRun?.id, 'inventory-0-latest');

      // Same-sized replacement, old mtime: the next request must still see it.
      const file = files[0]!;
      const before = statSync(file);
      const next = readFileSync(file, 'utf8').replace('"running"', '"success"');
      const replacement = file + '.replacement';
      writeFileSync(replacement, next);
      utimesSync(replacement, before.atime, before.mtime);
      renameSync(replacement, file);
      resetCounts();
      const changed = await getWorkflows(h.url + route);
      assert.deepEqual(counts(), { reads: 1, stats: corpusSize + 1, listings: 1 });
      const updated = changed.find(w => w.name === 'Inventory 0')!;
      assert.equal(updated.proof.evidence.latestRun?.status, 'success');
      assert.equal(route.endsWith('/home') ? updated.lastRun?.status : updated.lastRunStatus, 'success');
      resetCounts();
      await getWorkflows(h.url + route);
      assert.deepEqual(counts(), { reads: 0, stats: corpusSize, listings: 1 });
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      await h.close();
    }
  });
}

test('a request cannot memoize an older proof under a later run generation', async t => {
  const file = seed('coherent-proof', 'Coherent proof');
  const h = await boot();
  try {
    await getWorkflows(h.url + '/api/console/workflows');
    const originalStat = fs.statSync;
    let replaced = false;
    t.mock.method(fs, 'statSync', (...args: Parameters<typeof fs.statSync>) => {
      const value = Reflect.apply(originalStat, fs, args);
      if (!replaced && args[0] === file) {
        replaced = true;
        const record = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(file + '.replacement', JSON.stringify({ ...record, status: 'completed', finishedAt: '2026-10-16T02:00:00.000Z' }));
        renameSync(file + '.replacement', file);
      }
      return value;
    });
    syncBuiltinESMExports();
    const first = (await getWorkflows(h.url + '/api/console/workflows')).find(w => w.name === 'Coherent proof')!;
    assert.equal(replaced, true);
    assert.equal(first.lastRunStatus, 'running');
    assert.equal(first.proof.evidence.latestRun?.status, 'running');
    const next = (await getWorkflows(h.url + '/api/console/workflows')).find(w => w.name === 'Coherent proof')!;
    assert.equal(next.lastRunStatus, 'completed');
    assert.equal(next.proof.evidence.latestRun?.status, 'completed', 'new records cannot hit a memo issued for older records');
    const warm = (await getWorkflows(h.url + '/api/console/workflows')).find(w => w.name === 'Coherent proof')!;
    assert.equal(warm.proof.evidence.latestRun?.status, 'completed');
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    await h.close();
  }
});
