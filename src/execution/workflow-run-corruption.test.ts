import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-run-corruption-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMENTINE_WORKFLOW_HARNESS_POLL_MS = '20';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-workflow-run-corruption\n', 'utf-8');

const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { appendWorkflowEvent, listPendingRuns } = await import('./workflow-events.js');
const {
  processWorkflowRuns,
  reconcilePendingWorkflowRuns,
} = await import('./workflow-runner.js');
const { runWorkflowWatchdog } = await import('./workflow-watchdog.js');
const { getRun, startRun } = await import('../runtime/run-events.js');
const { listNotifications } = await import('../runtime/notifications.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('malformed queued/running records converge on boot and tick to one blocked card with zero dispatch', async () => {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const queuedId = 'malformed-queued';
  const runningId = 'malformed-running';
  const queuedPath = path.join(WORKFLOW_RUNS_DIR, `${queuedId}.json`);
  const runningPath = path.join(WORKFLOW_RUNS_DIR, `${runningId}.json`);
  const queuedBytes = `{"id":"${queuedId}","workflow":"Queue Fixture","status":"queued"`;
  const runningBytes = `{"id":"${runningId}","workflow":"Running Fixture","status":"running"`;
  writeFileSync(queuedPath, queuedBytes, 'utf-8');
  writeFileSync(runningPath, runningBytes, 'utf-8');

  // Durable event roots make these look resumable to the legacy boot scan.
  // The canonical record decoder must suppress both phantom live entries.
  appendWorkflowEvent('Queue Fixture', queuedId, { kind: 'run_started' });
  appendWorkflowEvent('Running Fixture', runningId, { kind: 'run_started' });
  startRun({
    id: runningId,
    sessionId: `workflow:${runningId}`,
    channel: 'workflow',
    source: 'workflow',
    title: 'Workflow: Running Fixture',
    message: 'Running workflow "Running Fixture"',
  });

  let providerOrModelDispatches = 0;
  const assistant = {
    respond: async () => {
      providerOrModelDispatches += 1;
      throw new Error('corrupt workflow record must never reach the model/provider');
    },
  };

  // Two boot replays, two ordinary drain ticks, and two independent watchdog
  // ticks exercise every production convergence route and their idempotence.
  reconcilePendingWorkflowRuns();
  reconcilePendingWorkflowRuns();
  await processWorkflowRuns(assistant as never);
  await processWorkflowRuns(assistant as never);
  runWorkflowWatchdog(Date.parse('2026-08-22T12:00:00.000Z'));
  runWorkflowWatchdog(Date.parse('2026-08-22T12:01:00.000Z'));

  assert.equal(providerOrModelDispatches, 0);
  assert.equal(readFileSync(queuedPath, 'utf-8'), queuedBytes);
  assert.equal(readFileSync(runningPath, 'utf-8'), runningBytes);
  assert.deepEqual(listPendingRuns(), [], 'corrupt records never paint phantom queued/running work');

  const markers = readdirSync(path.join(WORKFLOW_RUNS_DIR, '.run-record-quarantine'))
    .filter((entry) => entry.endsWith('.json'));
  assert.equal(markers.length, 2, 'one immutable marker per corrupt path+byte generation');
  for (const markerFile of markers) {
    const markerText = readFileSync(
      path.join(WORKFLOW_RUNS_DIR, '.run-record-quarantine', markerFile),
      'utf-8',
    );
    assert.equal(markerText.includes(queuedBytes), false);
    assert.equal(markerText.includes(runningBytes), false);
  }

  const corruptionCards = listNotifications(1_000).filter(
    (notification) => notification.metadata?.errorCategory === 'workflow_run_record_corrupt',
  );
  assert.equal(corruptionCards.length, 2, 'boot/tick/watchdog replay creates one card per corrupt generation');
  assert.equal(new Set(corruptionCards.map((card) => card.id)).size, 2);
  assert.ok(corruptionCards.every((card) => card.silent !== true), 'blocked cards remain visible in desktop/mobile Inbox');
  assert.ok(corruptionCards.every((card) => card.metadata?.provenNoDispatch === true));
  assert.ok(corruptionCards.every((card) => card.metadata?.needsAttention === true));

  const runningActivity = getRun(runningId);
  assert.equal(runningActivity?.status, 'blocked');
  assert.equal(runningActivity?.needsAttention, true);
  assert.equal(
    runningActivity?.events.filter((event) => event.type === 'blocked').length,
    1,
    'the existing running Activity receives exactly one terminal blocked event',
  );
});
