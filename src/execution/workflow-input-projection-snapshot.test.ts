import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clem-input-projection-snapshot-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { reconcileAwaitingInputWorkflowRunProjections: reconcile } = await import('./workflow-awaiting-input-projection.js');
const { readWorkflowEvents } = await import('./workflow-events.js');
const { getNotification } = await import('../runtime/notifications.js');
const events = await import('../runtime/harness/eventlog.js');

test.beforeEach(() => {
  fs.rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
});
test.after(() => { events.closeEventLog(); fs.rmSync(home, { recursive: true, force: true }); });

function record(id: string, status = 'awaiting_input') {
  return { id, workflow: 'Snapshot perf workflow', status,
    finishedAt: status === 'awaiting_input' ? undefined : '2026-09-02T05:15:52.918Z',
    awaitingInput: status === 'awaiting_input' ? {
      questionId: `question:${id}`, question: 'Which workspace should I use?', stepId: 'select',
      sessionId: `workflow:${id}:select`, sessionIdSuffix: 'select', askedAt: '2026-09-02T05:15:52.918Z',
      answer: undefined as string | undefined,
    } : undefined };
}
function save(value: ReturnType<typeof record>) {
  const file = path.join(WORKFLOW_RUNS_DIR, `${value.id}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}
function observeRunStorage(t: TestContext) {
  const originalFsync = fs.fsyncSync;
  const open = t.mock.method(fs, 'openSync');
  const mkdir = t.mock.method(fs, 'mkdirSync');
  const flushedPaths: string[] = [];
  const flush = t.mock.method(fs, 'fsyncSync', (fd: number) => {
    const opened = open.mock.calls.findLast(call => call.result === fd)?.arguments[0];
    assert.equal(typeof opened, 'string', 'every flushed descriptor must have an observed pathname');
    flushedPaths.push(String(opened));
    originalFsync(fd);
  });
  const writes = t.mock.method(fs, 'writeFileSync');
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const runPath = (value: unknown) => typeof value === 'string' && value.startsWith(WORKFLOW_RUNS_DIR);
  return {
    opens: () => open.mock.calls.filter(call => runPath(call.arguments[0])),
    directories: () => mkdir.mock.calls.filter(call => runPath(call.arguments[0])),
    writes: () => writes.mock.calls.filter(call => runPath(call.arguments[0])),
    // Capture the path while the descriptor is live; later unrelated opens can
    // reuse its numeric fd, so whole-call arrays alone cannot identify a flush.
    flush, flushedPaths,
  };
}

test('repeated historical inventories never create a run lock or fsync retained records', (t) => {
  const statuses = ['blocked', 'completed', 'cancelled', 'error', 'blocked_readiness', 'dry_run'];
  const originals = new Map<string, Buffer>();
  for (let index = 0; index < 146; index += 1) {
    const file = save(record(`historical-${index}`, statuses[index % statuses.length]));
    originals.set(file, fs.readFileSync(file));
  }
  // An unrelated historical record may have corrupt/live ownership evidence;
  // inventory has no reason to wait on it or reclaim it.
  const lock = path.join(WORKFLOW_RUNS_DIR, 'historical-0.json.record-lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'unexpected-owner-evidence'), 'preserve');
  const observed = observeRunStorage(t);
  for (let pass = 0; pass < 3; pass += 1) {
    assert.deepEqual(reconcile(), { scanned: 146, projected: 0, skipped: 146, failed: [] });
  }
  assert.equal(observed.opens().filter(call => String(call.arguments[0]).includes('.record-lock')
    || call.arguments[0] === WORKFLOW_RUNS_DIR).length, 0,
  'snapshot reads must not open lock owner or directory fds');
  assert.equal(observed.directories().length, 0);
  assert.equal(observed.writes().length, 0);
  assert.deepEqual(observed.flushedPaths.filter(value => value.startsWith(WORKFLOW_RUNS_DIR)), [],
    'the separate notification-store read lock must not be confused with run-record fsyncs');
  assert.equal(fs.readFileSync(path.join(lock, 'unexpected-owner-evidence'), 'utf8'), 'preserve');
  for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(file), bytes);
});

test('eligible input projection still acquires and fsyncs its strict lock and durably deduplicates the question', (t) => {
  const current = record('eligible-question');
  const file = save(current);
  const observed = observeRunStorage(t);
  const first = reconcile({ runId: current.id });
  assert.deepEqual(first, { scanned: 1, projected: 1, skipped: 0, failed: [] });
  assert.ok(observed.directories().some(call => call.arguments[0] === `${file}.record-lock`));
  assert.ok(observed.flushedPaths.some(value => value.includes('.record-lock.owner-')));
  if (process.platform !== 'win32') assert.ok(observed.flushedPaths.includes(`${file}.record-lock`));
  assert.equal(fs.existsSync(`${file}.record-lock`), false);
  assert.equal(getNotification(current.awaitingInput!.questionId)?.metadata?.runId, current.id);
  assert.equal(reconcile({ runId: current.id }).projected, 1);
  assert.equal(readWorkflowEvents(current.workflow, current.id).filter(event => event.kind === 'run_paused').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'awaiting_input');
});

test('a candidate answered or cancelled after the snapshot is rechecked under lock before any projection', (t) => {
  const originalMkdir = fs.mkdirSync;
  const originalWrite = fs.writeFileSync;
  const originalRename = fs.renameSync;
  let target = '';
  let replacement: ReturnType<typeof record>;
  let crossed = false;
  t.mock.method(fs, 'mkdirSync', (...args: Parameters<typeof fs.mkdirSync>) => {
    if (args[0] === `${target}.record-lock` && !crossed) {
      crossed = true;
      originalWrite(`${target}.transition`, JSON.stringify(replacement));
      originalRename(`${target}.transition`, target);
    }
    return originalMkdir(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const status of ['running', 'cancelled']) {
    const prior = record(`race-${status}`);
    target = save(prior);
    replacement = { ...prior, status, awaitingInput: { ...prior.awaitingInput!, answer: 'Already answered.' } };
    crossed = false;
    assert.deepEqual(reconcile({ runId: prior.id }), { scanned: 1, projected: 0, skipped: 1, failed: [] });
    assert.equal(crossed, true, 'the mutation must occur after snapshot selection, during lock acquisition');
    assert.equal(getNotification(prior.awaitingInput!.questionId), undefined);
    assert.equal(readWorkflowEvents(prior.workflow, prior.id).length, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), JSON.parse(JSON.stringify(replacement)));
  }
});
