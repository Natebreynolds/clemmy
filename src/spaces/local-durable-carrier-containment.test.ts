/**
 * Production-shaped containment for legacy Space runner/CLI declarations.
 * Human trust and the retired workflow-mutation receipt are migration records,
 * not accepted logical/physical call authority. Until Space declarations are
 * compiled into the shared durable kernel, every production entrypoint is
 * zero-process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-local-containment-'));

const runner = await import('./runner.js');
const scheduler = await import('./scheduler.js');
const gate = await import('./space-action-gate.js');
const store = await import('./store.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const receipts = await import('../execution/workflow-call-receipts.js');

function writeMarkerRunner(slug: string, file: string, marker: string): string {
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, file);
  writeFileSync(
    target,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'spawned'); process.stdout.write('{}');`,
    'utf8',
  );
  return target;
}

function approvePendingWithoutResume(approvalId: string): void {
  const changed = eventlog.openEventLog().prepare(`
    UPDATE pending_approvals
       SET status = 'resolved', resolution = 'approved', resolver = ?, resolved_at = ?
     WHERE approval_id = ? AND status = 'pending'
  `).run('local-containment-fixture', new Date().toISOString(), approvalId);
  assert.equal(changed.changes, 1);
}

async function approveSourceTrust(
  slug: string,
  source: Parameters<typeof runner.runSpaceDataSource>[1],
): Promise<string> {
  const pending = await runner.runSpaceDataSource(slug, source);
  assert.equal(pending.ok, false);
  assert.equal(pending.ok ? undefined : pending.provenNoDispatch, true);
  const card = approvals.listPending({
    sessionId: `space-${slug}`,
    status: 'pending',
  }).find((row) => row.args?.sourceId === source.id);
  assert.ok(card);
  approvePendingWithoutResume(card.approvalId);
  return card.approvalId;
}

test('Space runner production module has no raw process or legacy receipt execution body', () => {
  const source = readFileSync(new URL('./runner.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /spawnSandboxedScript|node:child_process|executeWorkflowCallMutation/);
  assert.match(source, /no shared durable call authority was supplied/);
  assert.match(source, /return \{ replayed: false \}/);
});

test('manual refresh keeps approved runner and CLI declarations zero-process', async () => {
  const runnerSlug = 'manual-local-runner-contained';
  const runnerMarker = path.join(process.env.CLEMENTINE_HOME!, 'manual-runner-spawned.txt');
  const runnerSource = { id: 'pull', runner: 'pull.mjs' };
  store.spaceStore.save({ id: runnerSlug, title: 'Manual runner', dataSources: [runnerSource] });
  writeMarkerRunner(runnerSlug, runnerSource.runner, runnerMarker);
  await approveSourceTrust(runnerSlug, runnerSource);

  const runnerResult = await runner.refreshSpaceData(runnerSlug, runnerSource.id, { cause: 'manual' });
  assert.equal(runnerResult[0]?.ok, false);
  assert.match(runnerResult[0]?.error ?? '', /no shared durable call authority/i);
  assert.equal(existsSync(runnerMarker), false);

  const cliSlug = 'manual-local-cli-contained';
  const cliMarker = path.join(process.env.CLEMENTINE_HOME!, 'manual-cli-spawned.txt');
  const cliSource = {
    id: 'pull',
    cliArgv: [
      'node',
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(cliMarker)}, 'spawned'); process.stdout.write('{}')`,
    ],
  };
  store.spaceStore.save({ id: cliSlug, title: 'Manual CLI', dataSources: [cliSource] });
  await approveSourceTrust(cliSlug, cliSource);

  const cliResult = await runner.refreshSpaceData(cliSlug, cliSource.id, { cause: 'manual' });
  assert.equal(cliResult[0]?.ok, false);
  assert.match(cliResult[0]?.error ?? '', /no shared durable call authority/i);
  assert.equal(existsSync(cliMarker), false);
});

test('scheduled refresh keeps an approved local runner zero-process', async () => {
  const slug = 'scheduled-local-runner-contained';
  const marker = path.join(process.env.CLEMENTINE_HOME!, 'scheduled-runner-spawned.txt');
  const source = { id: 'pull', runner: 'pull.mjs', schedule: '* * * * *' };
  store.spaceStore.save({ id: slug, title: 'Scheduled runner', dataSources: [source] });
  writeMarkerRunner(slug, source.runner, marker);
  await approveSourceTrust(slug, source);

  const result = await scheduler.processSpaceSchedules(new Date('2026-08-25T18:01:00.000Z'));
  assert.equal(result.fired, 0);
  assert.equal(result.errors, 1);
  assert.equal(existsSync(marker), false);
  store.spaceStore.archive(slug);
});

test('paused-space retry keeps an approved local runner zero-process', async () => {
  const slug = 'retry-local-runner-contained';
  const marker = path.join(process.env.CLEMENTINE_HOME!, 'retry-runner-spawned.txt');
  const source = { id: 'pull', runner: 'pull.mjs' };
  store.spaceStore.save({ id: slug, title: 'Retry runner', dataSources: [source] });
  writeMarkerRunner(slug, source.runner, marker);
  await approveSourceTrust(slug, source);
  store.spaceStore.update(slug, { status: 'paused' });

  const pausedAt = Date.parse(store.spaceStore.get(slug)!.updatedAt);
  const result = await scheduler.retryPausedSpaces(new Date(pausedAt + 10 * 60_000));
  assert.deepEqual(result, { examined: 1, reactivated: 0, stillPaused: 1 });
  assert.equal(store.spaceStore.get(slug)?.status, 'paused');
  assert.equal(existsSync(marker), false);
  store.spaceStore.archive(slug);
});

test('approved runner action and its stale legacy receipt are both zero-process', async () => {
  const slug = 'approved-local-action-contained';
  const marker = path.join(process.env.CLEMENTINE_HOME!, 'approved-action-spawned.txt');
  const action = { id: 'publish', label: 'Publish', runner: 'act.mjs', confirm: true };
  const callerArgs = { recordId: 'row-1' };
  const rec = store.spaceStore.save({ id: slug, title: 'Approved action', actions: [action] });
  writeMarkerRunner(slug, action.runner, marker);
  const pending = gate.enqueueSpaceActionApproval(rec, action, callerArgs);
  approvePendingWithoutResume(pending.approvalId);

  await receipts.executeWorkflowCallMutation({
    workflowSlug: runner.SPACE_ACTION_MUTATION_WORKFLOW_SLUG,
    runId: pending.approvalId,
    stepId: action.id,
    itemKey: slug,
    tool: `space-runner:${action.runner}`,
    args: callerArgs,
  }, async () => ({ ok: true, data: { legacy: 'receipt' } }));

  assert.deepEqual(
    runner.replaySpaceActionMutation(slug, action, pending.approvalId),
    { replayed: false },
    'a committed legacy wrapper row is never upgraded into shared-kernel authority',
  );
  const result = await runner.runSpaceAction(slug, action, callerArgs, {
    approvalId: pending.approvalId,
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.provenNoDispatch, true);
  assert.match(result.ok ? '' : result.error, /no shared durable call authority/i);
  assert.equal(existsSync(marker), false);
});
