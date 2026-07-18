/**
 * T2.1 — trigger engine: registry sync + system-event/webhook fire + dedupe.
 *
 * Per-test temp dir via CLEMENTINE_HOME (BINDING) so we never touch real
 * state — set BEFORE any src import so BASE_DIR resolves into the temp home.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-trigger-engine-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const {
  syncWorkflowTriggerRegistry,
  fireWorkflowSystemEvent,
  fireWorkflowWebhook,
  recoverPendingWorkflowTriggerEvents,
  closeWorkflowTriggerDbForTest,
  workflowWebhookResponseDisposition,
  workflowTriggerFilterMatches,
  workflowInputsFromTriggerPayload,
} = await import('./workflow-trigger-engine.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const ENGINE_MODULE_URL = pathToFileURL(path.join(process.cwd(), 'src/execution/workflow-trigger-engine.ts')).href;

async function waitForFiles(files: string[], timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!files.every((file) => {
    try { return readFileSync(file, 'utf-8').length >= 0; } catch { return false; }
  })) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${files.join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForChild(proc: ChildProcess): Promise<void> {
  let stderr = '';
  proc.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const [code] = await once(proc, 'close') as [number | null];
  assert.equal(code, 0, stderr);
}

function triggerChild(code: string, extraEnv: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEMENTINE_HOME: TMP_HOME,
      CLEM_TRIGGER_ENGINE_URL: ENGINE_MODULE_URL,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writeWorkflow(name: string, frontmatterLines: string[]): void {
  const dir = path.join(WORKFLOWS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: test workflow ${name}`, 'enabled: true', ...frontmatterLines, '---', '', '## step: only', 'Do the thing.', ''].join('\n'),
    'utf-8',
  );
}

function queuedRuns(): Array<{ workflow: string; inputs?: Record<string, string> }> {
  let files: string[] = [];
  try { files = readdirSync(WORKFLOW_RUNS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')));
}

function triggerEventRows(workflowName: string): Array<{
  state: string;
  run_id: string | null;
  attempt_count: number;
  last_error: string | null;
}> {
  const database = new Database(path.join(TMP_HOME, 'state', 'workflow-triggers.db'), { readonly: true });
  try {
    return database.prepare(`
      SELECT e.state, e.run_id, e.attempt_count, e.last_error
      FROM workflow_trigger_events e
      JOIN workflow_triggers t ON t.id = e.trigger_id
      WHERE t.workflow_name = ?
      ORDER BY e.fired_at
    `).all(workflowName) as Array<{
      state: string;
      run_id: string | null;
      attempt_count: number;
      last_error: string | null;
    }>;
  } finally {
    database.close();
  }
}

test('webhook response disposition reports queued, pending, and failed ingestion honestly', () => {
  assert.deepEqual(workflowWebhookResponseDisposition([
    { workflowName: 'a', triggerId: 't-a', status: 'queued', runId: 'r-a' },
  ]), { httpStatus: 200, ok: true, pending: false });
  assert.deepEqual(workflowWebhookResponseDisposition([
    { workflowName: 'a', triggerId: 't-a', status: 'readiness_blocked' },
  ]), { httpStatus: 202, ok: false, pending: true });
  assert.deepEqual(workflowWebhookResponseDisposition([
    { workflowName: 'a', triggerId: 't-a', status: 'queued', runId: 'r-a' },
    { workflowName: 'b', triggerId: 't-b', status: 'error', message: 'disk full' },
  ]), { httpStatus: 503, ok: false, pending: true });
});

test('sync + system_event fire: a subscribed workflow queues a run; same dedupe key never fires twice', () => {
  writeWorkflow('on-new-lead', [
    'trigger:',
    '  events:',
    '    - type: crm.lead.created',
    '      dedupeKey: "lead-{{payload.id}}"',
    'steps:',
    '  - id: only',
    '    prompt: Handle the new lead {{input.name}}.',
    'inputs:',
    '  name:',
    '    type: string',
  ]);
  const synced = syncWorkflowTriggerRegistry();
  assert.ok(synced.synced >= 1, 'trigger row synced');

  const first = fireWorkflowSystemEvent('crm.lead.created', { id: 'L-1', name: 'Acme' });
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'queued');
  assert.ok(first[0].runId);
  assert.deepEqual(triggerEventRows('on-new-lead').map((row) => row.state), ['enqueued']);
  const runs = queuedRuns().filter((r) => r.workflow === 'on-new-lead');
  assert.equal(runs.length, 1);
  // declared input bound from the payload — code-level, no LLM
  assert.equal(runs[0].inputs?.name, 'Acme');

  // same dedupe key (payload id) → deduped at the EVENT layer, even with a different payload body
  const second = fireWorkflowSystemEvent('crm.lead.created', { id: 'L-1', name: 'Acme Renamed' });
  assert.equal(second[0].status, 'deduped_event');
  assert.equal(queuedRuns().filter((r) => r.workflow === 'on-new-lead').length, 1);

  // a NEW lead fires again
  const third = fireWorkflowSystemEvent('crm.lead.created', { id: 'L-2', name: 'Globex' });
  assert.equal(third[0].status, 'queued');
});

test('filter mismatch → filtered, no run; unsubscribed event type → no results', () => {
  writeWorkflow('on-vip-lead', [
    'trigger:',
    '  events:',
    '    - type: crm.lead.scored',
    '      filter:',
    '        tier: vip',
    'steps:',
    '  - id: only',
    '    prompt: Greet the VIP.',
  ]);
  syncWorkflowTriggerRegistry();

  const miss = fireWorkflowSystemEvent('crm.lead.scored', { id: 'L-9', tier: 'standard' });
  assert.equal(miss.find((r) => r.workflowName === 'on-vip-lead')?.status, 'filtered');
  assert.equal(queuedRuns().filter((r) => r.workflow === 'on-vip-lead').length, 0);

  const hit = fireWorkflowSystemEvent('crm.lead.scored', { id: 'L-10', tier: 'vip' });
  assert.equal(hit.find((r) => r.workflowName === 'on-vip-lead')?.status, 'queued');

  assert.deepEqual(fireWorkflowSystemEvent('nobody.subscribes', { x: 1 }), []);
});

test('malformed durable trigger filters fail closed instead of becoming match-all', () => {
  writeWorkflow('bad-filter', [
    'trigger:',
    '  events:',
    '    - type: crm.bad-filter',
    '      filter:',
    '        tier: vip',
  ]);
  syncWorkflowTriggerRegistry();
  const database = new Database(path.join(TMP_HOME, 'state', 'workflow-triggers.db'));
  try {
    database.prepare("UPDATE workflow_triggers SET filter_json = '{' WHERE workflow_name = ?").run('bad-filter');
  } finally {
    database.close();
  }

  const result = fireWorkflowSystemEvent('crm.bad-filter', { tier: 'vip' });

  assert.equal(result[0]?.status, 'error');
  assert.match(result[0]?.message ?? '', /failed closed|unreadable/i);
  assert.equal(queuedRuns().filter((run) => run.workflow === 'bad-filter').length, 0);
  assert.deepEqual(triggerEventRows('bad-filter'), []);
});

test('readiness-blocked receipt stays pending and recovers after the capability is restored', () => {
  writeWorkflow('on-readiness-block', [
    'trigger:',
    '  events:',
    '    - type: crm.readiness.block',
    'steps:',
    '  - id: merge',
    '    prompt: Merge evidence.',
    '    deterministic:',
    '      runner: missing.py',
  ]);
  syncWorkflowTriggerRegistry();

  const fired = fireWorkflowSystemEvent('crm.readiness.block', { id: 'B-1' });
  const row = fired.find((r) => r.workflowName === 'on-readiness-block');
  assert.equal(row?.status, 'readiness_blocked');
  assert.match(row?.message ?? '', /missing\.py/);
  assert.equal(queuedRuns().filter((r) => r.workflow === 'on-readiness-block').length, 0);
  const pending = triggerEventRows('on-readiness-block');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].state, 'pending');
  assert.equal(pending[0].run_id, null);
  assert.equal(pending[0].attempt_count, 1);
  assert.match(pending[0].last_error ?? '', /missing\.py/);

  // Restore readiness, simulate a process restart, then recover the durable
  // pending receipt without requiring the provider to redeliver the event.
  const scriptsDir = path.join(WORKFLOWS_DIR, 'on-readiness-block', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(path.join(scriptsDir, 'missing.py'), 'print("{}")\n', 'utf-8');
  closeWorkflowTriggerDbForTest();
  const recovered = recoverPendingWorkflowTriggerEvents({ force: true });
  assert.equal(recovered.find((result) => result.workflowName === 'on-readiness-block')?.status, 'queued');
  const accepted = triggerEventRows('on-readiness-block');
  assert.equal(accepted[0].state, 'enqueued');
  assert.ok(accepted[0].run_id);
  assert.equal(accepted[0].attempt_count, 2);
  assert.equal(accepted[0].last_error, null);

  const replay = fireWorkflowSystemEvent('crm.readiness.block', { id: 'B-1' });
  assert.equal(replay.find((result) => result.workflowName === 'on-readiness-block')?.status, 'deduped_event');
});

test('replacing a trigger terminally cancels its pending receipts instead of executing stale payloads', () => {
  writeWorkflow('on-obsolete-trigger', [
    'trigger:',
    '  events:',
    '    - type: crm.obsolete',
    'steps:',
    '  - id: blocked',
    '    prompt: Handle it.',
    '    deterministic:',
    '      runner: missing.py',
  ]);
  syncWorkflowTriggerRegistry();
  assert.equal(
    fireWorkflowSystemEvent('crm.obsolete', { id: 'old' })
      .find((result) => result.workflowName === 'on-obsolete-trigger')?.status,
    'readiness_blocked',
  );

  writeWorkflow('on-obsolete-trigger', ['trigger:', '  manual: true']);
  syncWorkflowTriggerRegistry();

  assert.equal(triggerEventRows('on-obsolete-trigger')[0]?.state, 'cancelled');
  assert.equal(
    recoverPendingWorkflowTriggerEvents({ force: true })
      .some((result) => result.workflowName === 'on-obsolete-trigger'),
    false,
  );
  assert.equal(queuedRuns().filter((run) => run.workflow === 'on-obsolete-trigger').length, 0);
});

test('disable cannot clear an active receipt claim while its run is being installed', async () => {
  writeWorkflow('on-claim-disable-race', [
    'trigger:',
    '  events:',
    '    - type: crm.claim.disable.race',
    'steps:',
    '  - id: only',
    '    prompt: Process the claimed delivery.',
  ]);
  syncWorkflowTriggerRegistry();

  const readyFile = path.join(TMP_HOME, 'claim-disable-race.ready');
  const releaseFile = path.join(TMP_HOME, 'claim-disable-race.release');
  const fireResultFile = path.join(TMP_HOME, 'claim-disable-race.fire.json');
  const syncStartedFile = path.join(TMP_HOME, 'claim-disable-race.sync-started');
  const syncResultFile = path.join(TMP_HOME, 'claim-disable-race.sync.json');
  const fireProcess = triggerChild(`
    const { writeFileSync } = await import('node:fs');
    const engine = await import(process.env.CLEM_TRIGGER_ENGINE_URL);
    const result = engine.fireWorkflowSystemEvent('crm.claim.disable.race', { id: 'claim-race-1' });
    writeFileSync(process.env.CLEM_TRIGGER_RESULT, JSON.stringify(result), 'utf-8');
  `, {
    CLEMENTINE_TEST_TRIGGER_AFTER_CLAIM_READY: readyFile,
    CLEMENTINE_TEST_TRIGGER_AFTER_CLAIM_RELEASE: releaseFile,
    CLEM_TRIGGER_RESULT: fireResultFile,
  });
  const fireDone = waitForChild(fireProcess);
  await waitForFiles([readyFile]);

  // The ready marker is written after claiming. That claim must still own the
  // write generation while queue installation is in flight; otherwise a sync
  // process could cancel it and clear its claim token before acceptance.
  const lockProbe = new Database(path.join(TMP_HOME, 'state', 'workflow-triggers.db'));
  try {
    lockProbe.pragma('busy_timeout = 0');
    assert.throws(() => lockProbe.exec('BEGIN IMMEDIATE'), /database is locked/i);
  } finally {
    try { lockProbe.exec('ROLLBACK'); } catch { /* BEGIN was correctly refused. */ }
    lockProbe.close();
  }

  writeWorkflow('on-claim-disable-race', ['trigger:', '  manual: true']);
  const syncProcess = triggerChild(`
    const { writeFileSync } = await import('node:fs');
    const engine = await import(process.env.CLEM_TRIGGER_ENGINE_URL);
    writeFileSync(process.env.CLEM_TRIGGER_SYNC_STARTED, 'started', 'utf-8');
    const result = engine.syncWorkflowTriggerRegistry();
    writeFileSync(process.env.CLEM_TRIGGER_RESULT, JSON.stringify(result), 'utf-8');
  `, {
    CLEM_TRIGGER_SYNC_STARTED: syncStartedFile,
    CLEM_TRIGGER_RESULT: syncResultFile,
  });
  const syncDone = waitForChild(syncProcess);
  await waitForFiles([syncStartedFile]);

  // Let the claimant finish. The waiting disable linearizes after SQLite
  // acceptance, so this already-accepted occurrence remains executable.
  writeFileSync(releaseFile, 'release', 'utf-8');
  await Promise.all([fireDone, syncDone]);

  const fireResults = JSON.parse(readFileSync(fireResultFile, 'utf-8')) as Array<{
    workflowName: string;
    status: string;
  }>;
  const syncResult = JSON.parse(readFileSync(syncResultFile, 'utf-8')) as { removed: number };
  assert.equal(
    fireResults.find((result) => result.workflowName === 'on-claim-disable-race')?.status,
    'queued',
  );
  assert.ok(syncResult.removed >= 1, 'the replacement disabled the old trigger generation');
  assert.equal(queuedRuns().filter((run) => run.workflow === 'on-claim-disable-race').length, 1);
  assert.deepEqual(triggerEventRows('on-claim-disable-race').map((row) => row.state), ['enqueued']);
});

test('disable preserves durable queue acceptance when a claimant dies before its SQLite commit', async () => {
  writeWorkflow('on-claim-crash-before-commit', [
    'trigger:',
    '  events:',
    '    - type: crm.claim.crash.before.commit',
    'steps:',
    '  - id: only',
    '    prompt: Process the accepted delivery.',
  ]);
  syncWorkflowTriggerRegistry();

  const readyFile = path.join(TMP_HOME, 'claim-crash-before-commit.ready');
  const neverReleaseFile = path.join(TMP_HOME, 'claim-crash-before-commit.release');
  const fireProcess = triggerChild(`
    const engine = await import(process.env.CLEM_TRIGGER_ENGINE_URL);
    engine.fireWorkflowSystemEvent('crm.claim.crash.before.commit', { id: 'crash-1' });
  `, {
    CLEMENTINE_TEST_TRIGGER_AFTER_QUEUE_READY: readyFile,
    CLEMENTINE_TEST_TRIGGER_AFTER_QUEUE_RELEASE: neverReleaseFile,
  });
  const fireClosed = once(fireProcess, 'close') as Promise<[number | null, NodeJS.Signals | null]>;
  await waitForFiles([readyFile]);
  assert.equal(queuedRuns().filter((run) => run.workflow === 'on-claim-crash-before-commit').length, 1);

  // The run and immutable receipt marker are durable, but the encompassing
  // SQLite transaction has not accepted the receipt. Abrupt death rolls the
  // claim back to pending and models the exact cross-store crash boundary.
  assert.equal(fireProcess.kill('SIGKILL'), true);
  const [, signal] = await fireClosed;
  assert.equal(signal, 'SIGKILL');
  assert.deepEqual(triggerEventRows('on-claim-crash-before-commit').map((row) => row.state), ['pending']);

  writeWorkflow('on-claim-crash-before-commit', ['trigger:', '  manual: true']);
  const syncResult = syncWorkflowTriggerRegistry();
  assert.ok(syncResult.removed >= 1);

  const accepted = triggerEventRows('on-claim-crash-before-commit');
  assert.equal(accepted[0]?.state, 'enqueued');
  assert.ok(accepted[0]?.run_id, 'durable queue proof was promoted before stale-pending cancellation');
  assert.equal(queuedRuns().filter((run) => run.workflow === 'on-claim-crash-before-commit').length, 1);
});

test('a stale pre-receipt trigger snapshot cannot queue after its generation is disabled', async () => {
  writeWorkflow('on-stale-trigger-generation', [
    'trigger:',
    '  events:',
    '    - type: crm.stale.trigger.generation',
    'steps:',
    '  - id: only',
    '    prompt: Process the delivery.',
  ]);
  syncWorkflowTriggerRegistry();

  const readyFile = path.join(TMP_HOME, 'stale-generation.ready');
  const releaseFile = path.join(TMP_HOME, 'stale-generation.release');
  const resultFile = path.join(TMP_HOME, 'stale-generation.result.json');
  const fireProcess = triggerChild(`
    const { writeFileSync } = await import('node:fs');
    const engine = await import(process.env.CLEM_TRIGGER_ENGINE_URL);
    const result = engine.fireWorkflowSystemEvent('crm.stale.trigger.generation', { id: 'stale-1' });
    writeFileSync(process.env.CLEM_TRIGGER_RESULT, JSON.stringify(result), 'utf-8');
  `, {
    CLEMENTINE_TEST_TRIGGER_BEFORE_RECEIPT_READY: readyFile,
    CLEMENTINE_TEST_TRIGGER_BEFORE_RECEIPT_RELEASE: releaseFile,
    CLEM_TRIGGER_RESULT: resultFile,
  });
  const fireDone = waitForChild(fireProcess);
  await waitForFiles([readyFile]);

  // The child has selected the old enabled row but has not installed its
  // receipt. Disable that exact generation before allowing ingestion to resume.
  writeWorkflow('on-stale-trigger-generation', ['trigger:', '  manual: true']);
  const syncResult = syncWorkflowTriggerRegistry();
  assert.ok(syncResult.removed >= 1);
  writeFileSync(releaseFile, 'release', 'utf-8');
  await fireDone;

  const results = JSON.parse(readFileSync(resultFile, 'utf-8')) as Array<{
    workflowName: string;
    status: string;
  }>;
  assert.equal(
    results.find((result) => result.workflowName === 'on-stale-trigger-generation')?.status,
    'error',
  );
  assert.equal(queuedRuns().filter((run) => run.workflow === 'on-stale-trigger-generation').length, 0);
  assert.deepEqual(triggerEventRows('on-stale-trigger-generation'), []);
});

test('queue I/O failure leaves the receipt retryable instead of permanently deduped', () => {
  writeWorkflow('on-queue-retry', [
    'trigger:',
    '  events:',
    '    - type: crm.queue.retry',
    '      dedupeKey: "retry-{{payload.id}}"',
    'steps:',
    '  - id: only',
    '    prompt: Process the event.',
  ]);
  syncWorkflowTriggerRegistry();

  const backup = `${WORKFLOW_RUNS_DIR}-queue-retry-backup`;
  renameSync(WORKFLOW_RUNS_DIR, backup);
  writeFileSync(WORKFLOW_RUNS_DIR, 'not-a-directory', 'utf-8');
  try {
    const failed = fireWorkflowSystemEvent('crm.queue.retry', { id: 'Q-1' });
    const result = failed.find((entry) => entry.workflowName === 'on-queue-retry');
    assert.equal(result?.status, 'error');
    assert.match(result?.message ?? '', /ENOTDIR|not a directory/i);
    const pending = triggerEventRows('on-queue-retry');
    assert.equal(pending[0].state, 'pending');
    assert.equal(pending[0].attempt_count, 1);
  } finally {
    rmSync(WORKFLOW_RUNS_DIR, { force: true });
    renameSync(backup, WORKFLOW_RUNS_DIR);
  }

  // A provider redelivery may retry immediately even while autonomous recovery
  // observes backoff. Acceptance closes the receipt; only then does it dedupe.
  const retried = fireWorkflowSystemEvent('crm.queue.retry', { id: 'Q-1' });
  assert.equal(retried.find((entry) => entry.workflowName === 'on-queue-retry')?.status, 'queued');
  const accepted = triggerEventRows('on-queue-retry');
  assert.equal(accepted[0].state, 'enqueued');
  assert.equal(accepted[0].attempt_count, 2);
  const replay = fireWorkflowSystemEvent('crm.queue.retry', { id: 'Q-1' });
  assert.equal(replay.find((entry) => entry.workflowName === 'on-queue-retry')?.status, 'deduped_event');
});

test('recovery closes the crash window from a terminal run receipt without queueing twice', () => {
  writeWorkflow('on-crash-window', [
    'trigger:',
    '  events:',
    '    - type: crm.crash.window',
    '      dedupeKey: "crash-{{payload.id}}"',
    'steps:',
    '  - id: only',
    '    prompt: Process the event.',
  ]);
  syncWorkflowTriggerRegistry();
  const first = fireWorkflowSystemEvent('crm.crash.window', { id: 'C-1' })
    .find((entry) => entry.workflowName === 'on-crash-window');
  assert.equal(first?.status, 'queued');
  assert.ok(first?.runId);

  const runFile = path.join(WORKFLOW_RUNS_DIR, `${first!.runId}.json`);
  const run = JSON.parse(readFileSync(runFile, 'utf-8')) as Record<string, unknown>;
  assert.equal(typeof run.triggerReceiptId, 'string');
  run.status = 'completed';
  writeFileSync(runFile, JSON.stringify(run, null, 2), 'utf-8');

  // Simulate a process dying after the durable run write but before recording
  // SQLite acceptance. The run has already become terminal by recovery time.
  const database = new Database(path.join(TMP_HOME, 'state', 'workflow-triggers.db'));
  try {
    database.prepare(`
      UPDATE workflow_trigger_events
      SET state = 'pending', run_id = NULL, enqueued_at = NULL,
          claim_token = NULL, claim_expires_at = NULL, next_attempt_at = NULL
      WHERE id = ?
    `).run(run.triggerReceiptId);
  } finally {
    database.close();
  }

  const countBefore = queuedRuns().filter((entry) => entry.workflow === 'on-crash-window').length;
  const recovered = recoverPendingWorkflowTriggerEvents({ force: true })
    .find((entry) => entry.workflowName === 'on-crash-window');
  assert.equal(recovered?.status, 'duplicate_run');
  assert.equal(recovered?.runId, first?.runId);
  assert.equal(queuedRuns().filter((entry) => entry.workflow === 'on-crash-window').length, countBefore);
  assert.equal(triggerEventRows('on-crash-window')[0].state, 'enqueued');
});

test('sync preserves multiple filters for the same workflow event type', () => {
  writeWorkflow('on-regional-lead', [
    'trigger:',
    '  events:',
    '    - type: crm.lead.regional',
    '      filter:',
    '        region: east',
    '      dedupeKey: "east-{{payload.id}}"',
    '    - type: crm.lead.regional',
    '      filter:',
    '        region: west',
    '      dedupeKey: "west-{{payload.id}}"',
    'steps:',
    '  - id: only',
    '    prompt: Handle {{input.region}} lead.',
    'inputs:',
    '  region:',
    '    type: string',
  ]);
  syncWorkflowTriggerRegistry();

  const east = fireWorkflowSystemEvent('crm.lead.regional', { id: 'R-1', region: 'east' })
    .filter((r) => r.workflowName === 'on-regional-lead');
  assert.equal(east.filter((r) => r.status === 'queued').length, 1);
  assert.equal(east.filter((r) => r.status === 'filtered').length, 1);

  const west = fireWorkflowSystemEvent('crm.lead.regional', { id: 'R-2', region: 'west' })
    .filter((r) => r.workflowName === 'on-regional-lead');
  assert.equal(west.filter((r) => r.status === 'queued').length, 1);
  assert.equal(west.filter((r) => r.status === 'filtered').length, 1);
});

test('webhook fire: disabling a workflow stops delivery without deleting its durable receipts', () => {
  writeWorkflow('on-form-submit', [
    'trigger:',
    '  webhookPath: form-submit',
    'steps:',
    '  - id: only',
    '    prompt: Process the form.',
  ]);
  syncWorkflowTriggerRegistry();

  const fired = fireWorkflowWebhook('form-submit', { email: 'a@b.co' });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].status, 'queued');

  // Disable the workflow: sync soft-disables the trigger so the hook stops
  // firing, but its accepted/pending inbox history cannot cascade away.
  const dir = path.join(WORKFLOWS_DIR, 'on-form-submit');
  const skill = readFileSync(path.join(dir, 'SKILL.md'), 'utf-8').replace('enabled: true', 'enabled: false');
  writeFileSync(path.join(dir, 'SKILL.md'), skill, 'utf-8');
  const after = syncWorkflowTriggerRegistry();
  assert.ok(after.removed >= 1, 'workflow trigger disabled');
  assert.deepEqual(fireWorkflowWebhook('form-submit', { email: 'c@d.co' }), []);
  assert.equal(triggerEventRows('on-form-submit').length, 1, 'durable trigger receipt retained while disabled');
});

test('a webhook delivered with no daemon persists a durable receipt that boot recovery drains (never a silent drop)', () => {
  writeWorkflow('on-daemon-down-hook', [
    'trigger:',
    '  webhookPath: daemon-down-hook',
    'steps:',
    '  - id: merge',
    '    prompt: Merge.',
    '    deterministic:',
    '      runner: missing.py',
  ]);
  syncWorkflowTriggerRegistry();

  // No daemon runs in this test; the webhook engine still persists a durable
  // receipt. Dispatch is readiness-blocked here, so the receipt stays pending
  // and the HTTP disposition is 202 accepted-for-durable-execution — never a
  // 5xx that a non-retrying producer would drop (the bug the removed route gate
  // caused for every event in standalone `clementine webhook` mode).
  const fired = fireWorkflowWebhook('daemon-down-hook', { id: 'D-1' });
  assert.equal(fired[0].status, 'readiness_blocked');
  assert.deepEqual(
    workflowWebhookResponseDisposition(fired),
    { httpStatus: 202, ok: false, pending: true },
  );
  const pending = triggerEventRows('on-daemon-down-hook');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].state, 'pending');
  assert.equal(queuedRuns().filter((r) => r.workflow === 'on-daemon-down-hook').length, 0);

  // Boot the daemon: capability present, recovery tick drains the durable
  // receipt without the producer having to redeliver the event.
  const scriptsDir = path.join(WORKFLOWS_DIR, 'on-daemon-down-hook', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(path.join(scriptsDir, 'missing.py'), 'print("{}")\n', 'utf-8');
  closeWorkflowTriggerDbForTest();
  const recovered = recoverPendingWorkflowTriggerEvents({ force: true });
  assert.equal(recovered.find((r) => r.workflowName === 'on-daemon-down-hook')?.status, 'queued');
  const accepted = triggerEventRows('on-daemon-down-hook');
  assert.equal(accepted[0].state, 'enqueued');
  assert.ok(accepted[0].run_id);
  assert.equal(queuedRuns().filter((r) => r.workflow === 'on-daemon-down-hook').length, 1);
});

test('a redelivery revives a cancelled receipt instead of black-holing its dedupe slot', () => {
  const eventTrigger = [
    'trigger:',
    '  events:',
    '    - type: crm.revive',
    '      dedupeKey: "rev-{{payload.id}}"',
    'steps:',
    '  - id: merge',
    '    prompt: Merge.',
    '    deterministic:',
    '      runner: missing.py',
  ];
  writeWorkflow('on-revive', eventTrigger);
  syncWorkflowTriggerRegistry();

  // First delivery is readiness-blocked, so it lands as a durable PENDING
  // receipt occupying its UNIQUE(trigger_id, dedupe_key) slot.
  const blocked = fireWorkflowSystemEvent('crm.revive', { id: 'X-1' });
  assert.equal(blocked.find((r) => r.workflowName === 'on-revive')?.status, 'readiness_blocked');
  assert.equal(triggerEventRows('on-revive')[0]?.state, 'pending');

  // Replace the trigger (disable/re-enable cycle): sync terminally CANCELS the
  // pending receipt but leaves the row — and its dedupe slot — in place.
  writeWorkflow('on-revive', ['trigger:', '  manual: true']);
  syncWorkflowTriggerRegistry();
  assert.equal(triggerEventRows('on-revive')[0]?.state, 'cancelled');

  // Restore the SAME trigger (same type + dedupeKey → same deterministic row id)
  // and its capability. A legitimate redelivery of the same dedupe key must NOT
  // ON CONFLICT DO NOTHING onto the cancelled row and be rejected forever; it
  // revives that receipt to a fresh pending delivery and dispatches once.
  const scriptsDir = path.join(WORKFLOWS_DIR, 'on-revive', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(path.join(scriptsDir, 'missing.py'), 'print("{}")\n', 'utf-8');
  writeWorkflow('on-revive', eventTrigger);
  syncWorkflowTriggerRegistry();

  const revived = fireWorkflowSystemEvent('crm.revive', { id: 'X-1' });
  assert.equal(revived.find((r) => r.workflowName === 'on-revive')?.status, 'queued');
  const rows = triggerEventRows('on-revive');
  assert.equal(rows.length, 1, 'the cancelled receipt was revived in place, not duplicated');
  assert.equal(rows[0].state, 'enqueued');
  assert.ok(rows[0].run_id);
  assert.equal(queuedRuns().filter((r) => r.workflow === 'on-revive').length, 1);

  // Exactly-once still holds: another redelivery of the same key now dedupes.
  const again = fireWorkflowSystemEvent('crm.revive', { id: 'X-1' });
  assert.equal(again.find((r) => r.workflowName === 'on-revive')?.status, 'deduped_event');
  assert.equal(queuedRuns().filter((r) => r.workflow === 'on-revive').length, 1);
});

test('workflowTriggerFilterMatches: dot-paths and strict equality', () => {
  assert.equal(workflowTriggerFilterMatches({ 'lead.tier': 'vip' }, { lead: { tier: 'vip' } }), true);
  assert.equal(workflowTriggerFilterMatches({ 'lead.tier': 'vip' }, { lead: { tier: 'std' } }), false);
  assert.equal(workflowTriggerFilterMatches({ count: 3 }, { count: 3 }), true);
  assert.equal(workflowTriggerFilterMatches({ count: 3 }, { count: '3' }), false);
  assert.equal(workflowTriggerFilterMatches({}, { anything: true }), true);
});

test('workflowInputsFromTriggerPayload: binds declared inputs only; `payload` input gets the JSON', () => {
  const def = {
    name: 'x', description: '', enabled: true, trigger: {}, steps: [],
    inputs: { url: { type: 'string' as const }, payload: {}, missing: {} },
  };
  const inputs = workflowInputsFromTriggerPayload(def, { url: 'https://a.co', extra: 'ignored', nested: { no: 1 } });
  assert.equal(inputs.url, 'https://a.co');
  assert.equal(typeof inputs.payload, 'string');
  assert.ok(inputs.payload.includes('https://a.co'));
  assert.equal('missing' in inputs, false);
  assert.equal('extra' in inputs, false);
});

test('webhook ingestion failure returns a retryable error instead of masquerading as no subscriber', () => {
  closeWorkflowTriggerDbForTest();
  const databaseFile = path.join(TMP_HOME, 'state', 'workflow-triggers.db');
  const backupFile = `${databaseFile}.ingestion-test-backup`;
  renameSync(databaseFile, backupFile);
  mkdirSync(databaseFile);
  try {
    const results = fireWorkflowWebhook('form-submit', { email: 'retry@example.com' });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'error');
    assert.match(results[0].message ?? '', /before a durable receipt could be confirmed/);
    assert.deepEqual(
      workflowWebhookResponseDisposition(results),
      { httpStatus: 503, ok: false, pending: true },
    );
  } finally {
    closeWorkflowTriggerDbForTest();
    rmSync(databaseFile, { recursive: true, force: true });
    renameSync(backupFile, databaseFile);
  }
});
