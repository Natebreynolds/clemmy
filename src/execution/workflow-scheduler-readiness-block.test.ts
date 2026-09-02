/**
 * Run: npx tsx --test src/execution/workflow-scheduler-readiness-block.test.ts
 *
 * Exact regression for the 2026-08-31 Friday dashboard incident. A typed,
 * deterministic queue-readiness refusal must become one durable no-effect
 * occurrence and one truthful migration notice on the first scheduler pass.
 * It must not be retried four times and then mislabeled as daemon downtime.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-scheduler-readiness-block-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const {
  classifyScheduledReadinessBlock,
  processWorkflowSchedules,
  reconcileLegacyScheduledReadinessHolds,
} = await import('./workflow-scheduler.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { addNotification, loadNotifications } = await import('../runtime/notifications.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const {
  CRON_RUNS_DIR,
  WORKFLOW_RUNS_DIR,
} = await import('../tools/shared.js');
const {
  queueWorkflowRun,
  readWorkflowTriggerReceiptAcceptance,
  registerWorkflowRunDrainKick,
} = await import('../tools/workflow-run-queue.js');

const SCHEDULE_STATE_FILE = path.join(path.dirname(CRON_RUNS_DIR), 'workflow-schedule-state.json');
const WORKFLOW_SLUG = 'friday-dashboard-daily-refresh';
const DUE = new Date('2026-08-31T14:00:00.000Z'); // 07:00 America/Los_Angeles

function runRecords(): Array<Record<string, unknown>> {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return [];
  return readdirSync(WORKFLOW_RUNS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(
      readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8'),
    ) as Record<string, unknown>);
}

test.beforeEach(() => {
  registerWorkflowRunDrainKick(null);
  rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  rmSync(SCHEDULE_STATE_FILE, { force: true });
  rmSync(path.join(TEST_HOME, 'state', 'notifications.json'), { force: true });
  rmSync(path.join(TEST_HOME, 'state', 'notification-delivery-queue.json'), { force: true });
  mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
});

test.after(() => {
  registerWorkflowRunDrainKick(null);
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('pure classifier separates deterministic readiness from transient enqueue failures', () => {
  assert.equal(classifyScheduledReadinessBlock({
    status: 'error',
    message: 'temporary record lock timeout',
  }), null, 'thrown/transient queue failures stay on the scheduler retry path');

  const migration = classifyScheduledReadinessBlock({
    status: 'blocked_readiness',
    blockers: [{
      kind: 'script',
      name: 'refresh.mjs',
      stepIds: ['pull'],
      reason: 'workflow_raw_subprocess_authority_unrepresented: deterministic.runner has no shared exact authority',
    }],
  });
  assert.equal(migration?.kind, 'migration_required');
  assert.equal(migration?.code, 'workflow_raw_subprocess_authority_unrepresented');

  const capability = classifyScheduledReadinessBlock({
    status: 'blocked_readiness',
    blockers: [{ kind: 'skill', name: 'installed-later', reason: 'skill is missing' }],
  });
  assert.equal(capability?.kind, 'capability_required');
  assert.equal(capability?.code, 'workflow_readiness_blocked');
});

test('a schedule whose runner script is missing creates one readiness-blocked occurrence and never false-catches-up', async () => {
  writeWorkflow(WORKFLOW_SLUG, {
    name: WORKFLOW_SLUG,
    description: 'Read-only daily refresh of the Friday dashboard.',
    enabled: true,
    trigger: {
      schedule: '0 7 * * *',
      timezone: 'America/Los_Angeles',
      manual: true,
    },
    resources: {
      salesforce_org: {
        id: 'salesforce_org',
        kind: 'account',
        cli: 'sf',
        account: 'owner@example.com',
        required: true,
      },
    },
    steps: [{
      id: 'pull',
      prompt: '',
      deterministic: { runner: 'refresh.mjs' },
      sideEffect: 'read',
      output: { type: 'object', required_keys: ['ok'] },
    }],
  });
  // refresh.mjs is deliberately absent: a missing owner script is a readiness block.

  const drainKicks: string[][] = [];
  registerWorkflowRunDrainKick((ids) => drainKicks.push([...ids]));

  const first = await processWorkflowSchedules(DUE);
  assert.deepEqual(first.blocked, [WORKFLOW_SLUG]);
  assert.deepEqual(first.fired, []);
  assert.deepEqual(first.held, []);
  assert.deepEqual(drainKicks, [], 'a readiness-blocked occurrence never wakes execution');

  const records = runRecords();
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.status, 'blocked_readiness');
  assert.equal(record.source, 'schedule');
  assert.equal(record.workflow, WORKFLOW_SLUG);
  assert.equal(record.workflowSlug, WORKFLOW_SLUG);
  assert.equal(record.startedAt, undefined);
  assert.equal(record.catchupDisposition, undefined, 'a readiness block is never a Resume/Skip catch-up');
  assert.equal(record.catchupHeldAt, undefined);
  assert.deepEqual(record.scheduledReadinessBlock, {
    protocol: 'workflow_schedule_readiness_block_v1',
    blockedAt: record.createdAt,
    provenNoDispatch: true,
  });
  const readiness = record.readiness as {
    ok?: boolean;
    blockers?: Array<{ name?: string; reason?: string }>;
  };
  assert.equal(readiness.ok, false);
  assert.equal(readiness.blockers?.[0]?.name, 'refresh.mjs');
  assert.match(readiness.blockers?.[0]?.reason ?? '', /missing from scripts\//);
  assert.doesNotMatch(readiness.blockers?.[0]?.reason ?? '', /raw_subprocess/);
  const receipt = `workflow-schedule:v1:${WORKFLOW_SLUG}:${DUE.getTime()}`;
  assert.equal(readWorkflowTriggerReceiptAcceptance(receipt), record.id);

  const notices = loadNotifications().filter((notification) =>
    notification.metadata?.workflow === WORKFLOW_SLUG);
  assert.equal(notices.length, 1, 'one exact occurrence owns one notice');
  const notice = notices[0];
  assert.equal(notice.id, `system-workflow-readiness-blocked-${record.id}`);
  assert.equal(notice.metadata?.errorCategory, 'workflow_schedule_readiness_blocked');
  assert.equal(notice.metadata?.provenNoDispatch, true);
  assert.equal(notice.metadata?.needsAttention, true);
  assert.match(notice.body, /fix the listed definition or capability/);
  assert.match(notice.body, /not resumable/i);
  assert.doesNotMatch(notice.body, /Clementine was unavailable|Resume or Skip/i);

  // The daemon's normal 15-second retry and the next minute both remain inert.
  // The exact receipt and handled watermark close replay without another card.
  const sameMinute = await processWorkflowSchedules(new Date('2026-08-31T14:00:15.000Z'));
  const nextMinute = await processWorkflowSchedules(new Date('2026-08-31T14:01:00.000Z'));
  assert.deepEqual(sameMinute.blocked, []);
  assert.deepEqual(nextMinute.blocked, []);
  assert.equal(runRecords().length, 1);
  assert.equal(
    loadNotifications().filter((notification) => notification.metadata?.workflow === WORKFLOW_SLUG).length,
    1,
  );
  assert.equal(
    loadNotifications().some((notification) =>
      notification.metadata?.errorCategory === 'workflow_enqueue_failed'
      || notification.metadata?.errorCategory === 'workflow_schedule_catchup_held'),
    false,
  );
});

