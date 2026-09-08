import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-run-projection-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1',
  CLEMMY_TEST_DISABLE_LIVE_MODELS: '1', MCP_AUTO_IMPORT_ENABLED: 'false', EMBEDDINGS_DISABLED: 'true' });
mkdirSync(path.join(home, 'state'), { recursive: true });
const log = await import('../runtime/harness/eventlog.js');
const api = await import('./sessions-api.js');
const { createWorkflowRunStatusReader } = await import('./workflow-run-status.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

function record(runId: string, status: string, extra: Record<string, unknown> = {}) {
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({ id: runId, workflow: `Flow ${runId}`, status, ...extra }));
}
function step(runId: string, stepId: string, status: 'active' | 'paused' | 'completed' = 'completed', userId = 'fixture-owner') {
  const row = log.createSession({ id: `workflow:${runId}:${stepId}`, kind: 'workflow', channel: 'workflow', userId,
    title: `Flow ${runId}::${stepId}`, metadata: { source: 'workflow', workflowRunId: runId, workflowName: `Flow ${runId}`, stepId } });
  return log.updateSession(row.id, { status });
}
function detail(id: string) { const out = api.getUnifiedSessionDetail(`harness:${id}`); assert.ok(out); return out; }

test('list/detail/PATCH expose the same known steps and real inter-step running record', () => {
  const run = 'projection-gap'; const a = step(run, 'a'); const b = step(run, 'b'); record(run, 'running');
  const expected = [`harness:${a.id}`, `harness:${b.id}`];
  const listed = api.buildUnifiedSessionList({ includeArchived: true, limit: 500 }).find(row => row.id === `harness:${a.id}` || row.id === `harness:${b.id}`);
  assert.ok(listed); assert.equal(listed.status, 'active'); assert.deepEqual(listed.runSteps?.map(row => row.id), expected);
  for (const row of [detail(a.id).session, detail(b.id).session, api.patchUnifiedSession(`harness:${a.id}`, { pinned: true })!]) {
    assert.equal(row.status, 'active'); assert.deepEqual(row.runSteps?.map(item => item.id), expected);
    assert.deepEqual(row.runCoverage, { version: 1, kind: 'known_steps', state: 'available' });
    assert.equal(row.continuable, false);
    assert.equal(row.createdAt, a.createdAt);
  }
});

test('parked run remains waiting; a real terminal then outranks a stale active sibling', () => {
  const run = 'projection-parked'; const a = step(run, 'a', 'active'); record(run, 'parked');
  assert.equal(detail(a.id).session.status, 'paused');
  record(run, 'completed');
  assert.equal(detail(a.id).session.status, 'completed');
  assert.equal(log.getSession(a.id)?.status, 'active', 'projection never updates or claims the executor');
});

for (const status of ['failed', 'error', 'blocked', 'completed_with_errors', 'cancelled']) {
  test(`durable ${status} is not rounded to a completed step`, () => {
    const run = `projection-${status}`; const a = step(run, 'a'); record(run, status);
    assert.equal(detail(a.id).session.status, status === 'cancelled' ? 'cancelled' : 'failed');
  });
}

for (const control of ['missing', 'corrupt', 'wrong-id', 'future-status', 'symlink'] as const) {
  test(`${control} run evidence reports unknown coverage without claiming Completed`, () => {
    const run = `projection-${control}`; const a = step(run, 'a');
    if (control === 'corrupt') writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${run}.json`), '{broken');
    if (control === 'wrong-id') record(run, 'completed', { id: 'different-run' });
    if (control === 'future-status') record(run, 'unknown-future-status');
    if (control === 'symlink') {
      const outside = path.join(home, 'external-record.json'); writeFileSync(outside, JSON.stringify({ id: run, workflow: 'unrelated', status: 'completed' }));
      symlinkSync(outside, path.join(WORKFLOW_RUNS_DIR, `${run}.json`));
    }
    const expectedReason = control === 'missing' ? 'record_missing' : control === 'corrupt' ? 'record_corrupt'
      : control === 'future-status' ? 'unrecognized_status' : 'identity_mismatch';
    for (const row of [detail(a.id).session, api.patchUnifiedSession(`harness:${a.id}`, { pinned: true })!]) {
      assert.equal(row.status, 'unknown'); assert.equal(row.runCoverage?.state, 'unavailable');
      assert.equal(row.runCoverage?.reason, expectedReason); assert.equal(row.runSteps?.length, 1);
    }
  });
}

test('step addresses and transcript aggregation exclude internal/foreign execution members', () => {
  const run = 'projection-membership'; const a = step(run, 'a'); const foreign = step(run, 'foreign', 'completed', 'other-owner');
  const hidden = log.createSession({ id: 'agent:private-run-member', kind: 'workflow', channel: 'agent', userId: 'fixture-owner',
    metadata: { source: 'workflow', workflowRunId: run, workflowName: `Flow ${run}`, stepId: 'hidden' } });
  for (const row of [foreign, hidden]) log.appendEvent({ sessionId: row.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'PRIVATE_MEMBER_SENTINEL' } });
  log.appendEvent({ sessionId: a.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Public requested work.' } });
  record(run, 'completed');
  const own = detail(a.id); assert.deepEqual(own.session.runSteps?.map(row => row.id), [`harness:${a.id}`]);
  assert.ok(!JSON.stringify(own).includes('PRIVATE_MEMBER_SENTINEL'));
  api.patchUnifiedSession(`harness:${a.id}`, { pinned: true });
  assert.notEqual(log.getSession(foreign.id)?.metadata.pinned, true); assert.notEqual(log.getSession(hidden.id)?.metadata.pinned, true);
});

test('ordinary typed Plan chat remains its own session with no aggregate control or coverage', () => {
  const chat = log.createSession({ kind: 'chat', userId: 'fixture-owner', channel: 'desktop' });
  log.appendEvent({ sessionId: chat.id, turn: 1, role: 'user', type: 'user_input_received', data: {
    text: 'Plan this task.', taskMode: { version: 1, kind: 'plan' }, userId: 'fixture-owner' } });
  const own = detail(chat.id); assert.equal(own.session.runSteps, undefined); assert.equal(own.session.runCoverage, undefined);
  assert.equal(own.session.continuable, true); assert.deepEqual(own.turns[0]?.taskMode, { version: 1, kind: 'plan' });
});

test('run status reads memoize only within a request and refresh on the next request', () => {
  const run = 'projection-memo'; record(run, 'running');
  const read = createWorkflowRunStatusReader(); assert.equal(read(run).status, 'active');
  record(run, 'completed'); assert.equal(read(run).status, 'active');
  assert.equal(createWorkflowRunStatusReader()(run).status, 'completed');
  const result = read(run); result.runCoverage.state = 'unavailable';
  assert.equal(read(run).runCoverage.state, 'available', 'callers cannot mutate cached coverage');
  assert.equal(read('../not-a-run').runCoverage.reason, 'identity_mismatch');
});
