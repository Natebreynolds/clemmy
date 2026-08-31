import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AUTOMATION_OPPORTUNITY_PROPOSAL_DB,
  WORK_TABLES,
  classifyPackagedFirstBootAddedFile,
  isExactApprovalResolutionAuditAppend,
  isPackagedCapabilityAcquisitionMissingDetail,
  isExactDaemonLeaseOwnerRecord,
  isExactLegacyApprovalRetirement,
  isExactRecoveredWorkflowRunProjection,
  isExactStarterWorkspaceOfferSeed,
  isExactV314WorkspaceAuditCarrier,
  isExactV314FixtureMachineIdCandidate,
  isExactV314TriggerRegistry,
  normalizePackagedLogicalJson,
  notificationDeliverySettlement,
  packagedRuntimeEnvironment,
  prepareExitedPackagedDaemonLeaseCleanup,
  runPackagedV314DaemonRehearsal,
  sanitizePackagedGateEnvironment,
  seedPackagedGateState,
} from './rehearse-v314-packaged-daemon.mts';
import { V314_GATE_MACHINE_ID } from './rehearse-v314-upgrade.mts';

const PROVABLY_DEAD_PID = 2_147_483_647;
const LEASE_TOKEN = '123e4567-e89b-42d3-a456-426614174000';
const LEASE_STARTED_AT = '2026-08-30T12:00:00.000Z';

function writeDaemonLeaseFixture(input: {
  home: string;
  pid?: number;
  token?: string;
  startedAt?: string;
}): void {
  const pid = input.pid ?? PROVABLY_DEAD_PID;
  const token = input.token ?? LEASE_TOKEN;
  const startedAt = input.startedAt ?? LEASE_STARTED_AT;
  mkdirSync(path.join(input.home, 'daemon.lock'), { recursive: true });
  writeFileSync(path.join(input.home, 'daemon.pid'), `${pid}\n`);
  writeFileSync(path.join(input.home, 'daemon.lock', `owner-${token}.json`), JSON.stringify({
    version: 1,
    pid,
    token,
    startedAt,
  }));
}

function writeNotificationState(
  home: string,
  notifications: Array<Record<string, unknown>>,
  queue: Array<Record<string, unknown>> = [],
): void {
  const state = path.join(home, 'state');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'notifications.json'), JSON.stringify(notifications));
  writeFileSync(path.join(state, 'notification-delivery-queue.json'), JSON.stringify(queue));
}

function desktopDeliveredNotification(input: {
  id: string;
  kind: 'system' | 'workflow';
  title: string;
  metadata: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ...input,
    body: 'Recovery detail',
    createdAt: '2026-08-30T12:00:00.000Z',
    read: false,
    deliveredAt: '2026-08-30T12:00:01.000Z',
    deliveredDestinations: ['derived-desktop'],
    deliveryPlan: {
      version: 1,
      destinationIds: ['derived-desktop'],
      destinationAuthorityDigests: { 'derived-desktop': 'a'.repeat(64) },
      boundAt: '2026-08-30T12:00:00.000Z',
    },
    deliveryPlanCompletedAt: '2026-08-30T12:00:01.000Z',
  };
}

function recoveredWorkflowActivity(runId: string, workflowName: string, ordinal: number) {
  const createdAt = `2026-08-30T12:00:0${ordinal}.000Z`;
  const completedAt = `2026-08-30T12:00:1${ordinal}.000Z`;
  const error = `Workflow "${workflowName}" is disabled — approve/enable it before it can run.`;
  return {
    id: runId,
    sessionId: `workflow:${runId}`,
    channel: 'workflow',
    source: 'workflow',
    title: `Workflow: ${workflowName}`,
    input: `Starting workflow "${workflowName}"`,
    status: 'failed',
    createdAt,
    updatedAt: completedAt,
    completedAt,
    error,
    events: [{
      id: `10000000-0000-4000-8000-00000000000${ordinal}`,
      type: 'received',
      message: 'Run received.',
      createdAt,
    }, {
      id: `20000000-0000-4000-8000-00000000000${ordinal}`,
      type: 'failed',
      message: `Workflow failed before start: ${error}`,
      createdAt: completedAt,
      data: {},
    }],
  };
}

test('packaged work accounting includes schema-v69 model-result projection receipts', () => {
  assert.ok(
    WORK_TABLES.includes('logical_model_result_projection_receipts'),
    'a receipt created or removed on the second boot must make the packaged fixed-point gate fail',
  );
});

test('packaged fixture machine identity accepts only the exact bounded regular file', () => {
  const bytes = `${V314_GATE_MACHINE_ID}\n`;
  const exact = {
    present: true,
    regularFile: true,
    symbolicLink: false,
    byteLength: Buffer.byteLength(bytes),
    bytes,
  };
  assert.equal(isExactV314FixtureMachineIdCandidate(exact), true);
  assert.equal(isExactV314FixtureMachineIdCandidate({ ...exact, present: false }), false);
  assert.equal(isExactV314FixtureMachineIdCandidate({ ...exact, regularFile: false }), false);
  assert.equal(isExactV314FixtureMachineIdCandidate({ ...exact, symbolicLink: true }), false);
  assert.equal(isExactV314FixtureMachineIdCandidate({ ...exact, byteLength: exact.byteLength + 1 }), false);
  assert.equal(isExactV314FixtureMachineIdCandidate({ ...exact, bytes: `${V314_GATE_MACHINE_ID}!` }), false);
});

test('packaged gate preserves the preseeded fixture identity and refuses missing or mismatched identity', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-v314-machine-id-test-'));
  const exactHome = path.join(root, 'exact');
  const missingHome = path.join(root, 'missing');
  const mismatchHome = path.join(root, 'mismatch');
  const expected = `${V314_GATE_MACHINE_ID}\n`;
  try {
    for (const home of [exactHome, missingHome, mismatchHome]) {
      mkdirSync(path.join(home, 'state'), { recursive: true });
    }
    const exactPath = path.join(exactHome, 'state', 'machine-id');
    writeFileSync(exactPath, expected, { encoding: 'utf8', flag: 'wx' });
    seedPackagedGateState(exactHome);
    assert.equal(readFileSync(exactPath, 'utf8'), expected, 'the copied v3.14 identity was overwritten');

    assert.throws(
      () => seedPackagedGateState(missingHome),
      /machine-id is missing or unreadable/,
    );
    writeFileSync(path.join(mismatchHome, 'state', 'machine-id'), 'x'.repeat(expected.length), {
      encoding: 'utf8',
      flag: 'wx',
    });
    assert.throws(
      () => seedPackagedGateState(mismatchHome),
      /does not match the deterministic fixture identity/,
    );
    for (const home of [missingHome, mismatchHome]) {
      assert.equal(existsSync(path.join(home, 'state', 'proactivity-policy.json')), false);
      assert.equal(existsSync(path.join(home, 'state', 'memory-maintenance-state.json')), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packaged gate environment drops checkout, npm lifecycle, credential, and test authority', () => {
  const checkout = process.cwd();
  const safeBin = path.join(os.tmpdir(), 'clem-packaged-safe-bin');
  const cleaned = sanitizePackagedGateEnvironment({
    PATH: [path.join(checkout, 'node_modules', '.bin'), safeBin].join(path.delimiter),
    PWD: checkout,
    OLDPWD: checkout,
    INIT_CWD: checkout,
    NODE_OPTIONS: '--import checkout-preload.mjs',
    NODE_PATH: path.join(checkout, 'node_modules'),
    NODE_TEST_CONTEXT: 'child-v8',
    npm_package_name: 'clemmy',
    npm_lifecycle_event: 'test:packaged-upgrade',
    npm_config_local_prefix: checkout,
    CLEMMY_TEST_ISOLATED_HOME: '1',
    CLEMENTINE_RESOURCES_PATH: checkout,
    MCP_AUTO_IMPORT_ENABLED: 'true',
    OPENAI_API_KEY: 'must-not-cross',
    SAFE_RELEASE_FLAG: 'retained',
  });
  assert.equal(cleaned.PATH, safeBin);
  assert.equal(cleaned.SAFE_RELEASE_FLAG, 'retained');
  for (const key of [
    'PWD', 'OLDPWD', 'INIT_CWD', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_TEST_CONTEXT',
    'npm_package_name', 'npm_lifecycle_event', 'npm_config_local_prefix',
    'CLEMMY_TEST_ISOLATED_HOME', 'CLEMENTINE_RESOURCES_PATH', 'MCP_AUTO_IMPORT_ENABLED', 'OPENAI_API_KEY',
  ]) assert.equal(cleaned[key], undefined, `${key} leaked into the packaged gate`);
});

test('packaged daemon and exercise PATH is the exact empty gate directory', () => {
  const home = path.join(os.tmpdir(), 'clem-packaged-runtime-home');
  const emptyPath = path.join(os.tmpdir(), 'clem-packaged-runtime-empty-path');
  const runtime = packagedRuntimeEnvironment({
    PATH: ['/usr/local/bin', '/opt/salesforce/bin', path.join(process.cwd(), 'node_modules/.bin')]
      .join(path.delimiter),
    Path: '/host/mixed-case-path',
    HOME: '/host/home',
    OPENAI_API_KEY: 'must-not-cross',
    SAFE_RELEASE_FLAG: 'retained',
  }, home, emptyPath);
  assert.equal(runtime.PATH, emptyPath);
  assert.equal(runtime.HOME, home);
  assert.equal(runtime.CLEMENTINE_HOME, home);
  assert.equal(runtime.CLEMMY_CLI_DISCOVERY_WARMUP, 'off');
  assert.equal(runtime.CLEMMY_PROSPECTIVE_MEMORY, 'off');
  assert.equal(runtime.CLEMMY_WORKFLOW_RUN_LANE, 'off');
  assert.equal(runtime.OPENAI_API_KEY, undefined);
  assert.equal(runtime.SAFE_RELEASE_FLAG, 'retained');
  assert.deepEqual(Object.keys(runtime).filter((key) => key.toLowerCase() === 'path'), ['PATH']);
  assert.doesNotMatch(runtime.PATH ?? '', /salesforce|node_modules/);
});

test('first-boot added-file classifier is closed over causal recovery, seed, scheduler, and owner paths', () => {
  const eventFile = 'vault/00-System/workflows/upgrade-rehearsal-workflow/runs/run-1/events.jsonl';
  const recovery = new Set([eventFile]);
  const cases = [
    ['cron/daemon-state.json', 'recovery_projection'],
    [eventFile, 'recovery_projection'],
    ['state/check-in-templates/seed-friday-wrap.json', 'deterministic_boot_seed'],
    ['state/space-schedule-state.json', 'scheduler_observation'],
    ['daemon.lock/owner-123e4567-e89b-12d3-a456-426614174000.json', 'ephemeral_process_owner'],
    ['daemon.pid.123.123e4567-e89b-12d3-a456-426614174000.tmp', 'ephemeral_process_owner'],
  ] as const;
  for (const [file, category] of cases) {
    assert.equal(classifyPackagedFirstBootAddedFile(file, recovery), category, file);
  }
  assert.equal(classifyPackagedFirstBootAddedFile('state/runs.json', recovery), 'unexpected');
  assert.equal(classifyPackagedFirstBootAddedFile(
    'state/runs.json',
    recovery,
    { recoveredWorkflowRuns: true },
  ), 'recovery_projection');
  assert.equal(classifyPackagedFirstBootAddedFile('state/starter-workspace-offer.json', recovery), 'unexpected');
  assert.equal(classifyPackagedFirstBootAddedFile(
    'state/starter-workspace-offer.json',
    recovery,
    { starterWorkspaceOffer: true },
  ), 'deterministic_boot_seed');
  for (const file of [
    'state/reviewed-cli-scan.json',
    'state/capability-catalog.json',
    'spaces/upgrade-rehearsal-space/data.json',
    'state/operational-telemetry.json',
    'vault/00-System/workflows/other/SKILL.md',
  ]) assert.equal(classifyPackagedFirstBootAddedFile(file, recovery), 'unexpected', file);

  const lease = {
    version: 1,
    pid: 123,
    token: '123e4567-e89b-12d3-a456-426614174000',
    startedAt: '2026-08-30T12:00:00.000Z',
  };
  assert.equal(isExactDaemonLeaseOwnerRecord(lease, 123, lease.token), true);
  assert.equal(isExactDaemonLeaseOwnerRecord({ ...lease, pid: 124 }, 123, lease.token), false);
  assert.equal(isExactDaemonLeaseOwnerRecord({ ...lease, extra: true }, 123, lease.token), false);
});

test('recovered workflow activity projection accepts exactly two failed recoveries, one exercise, and a stable boot two', () => {
  const workflowName = 'upgrade-rehearsal-workflow';
  const scheduleId = 'trigger-schedule';
  const eventId = 'trigger-event';
  const exerciseId = 'trigger-exercise';
  const first = [
    recoveredWorkflowActivity(scheduleId, workflowName, 1),
    recoveredWorkflowActivity(eventId, workflowName, 2),
  ];
  const exercise = {
    id: exerciseId,
    sessionId: `workflow:${exerciseId}`,
    channel: 'workflow',
    source: 'workflow',
    title: `Workflow: ${workflowName}`,
    input: `Running workflow "${workflowName}"`,
    status: 'completed',
    createdAt: '2026-08-30T12:00:20.000Z',
    updatedAt: '2026-08-30T12:00:21.000Z',
    completedAt: '2026-08-30T12:00:21.000Z',
    outputPreview: 'completed',
    events: [{
      id: '30000000-0000-4000-8000-000000000001',
      type: 'received',
      message: 'Run received.',
      createdAt: '2026-08-30T12:00:20.000Z',
    }, {
      id: '40000000-0000-4000-8000-000000000001',
      type: 'completed',
      message: 'Completed',
      createdAt: '2026-08-30T12:00:21.000Z',
      data: {},
    }],
  };
  const postExercise = [...structuredClone(first), exercise];
  const expected = {
    workflowName,
    recoveredRunIds: [scheduleId, eventId],
    exerciseRunId: exerciseId,
    exerciseOutputPreview: 'completed',
  };
  assert.equal(isExactRecoveredWorkflowRunProjection(
    first,
    postExercise,
    structuredClone(postExercise),
    expected,
  ), true);
  assert.equal(isExactRecoveredWorkflowRunProjection(
    first.slice(0, 1),
    postExercise,
    structuredClone(postExercise),
    expected,
  ), false, 'missing recovered row');
  assert.equal(isExactRecoveredWorkflowRunProjection(
    [...first, recoveredWorkflowActivity('extra', workflowName, 3)],
    postExercise,
    structuredClone(postExercise),
    expected,
  ), false, 'extra recovered row');
  const wrong = structuredClone(first);
  wrong[0]!.status = 'completed';
  assert.equal(isExactRecoveredWorkflowRunProjection(
    wrong,
    postExercise,
    structuredClone(postExercise),
    expected,
  ), false, 'wrong recovered terminal state');
  assert.equal(isExactRecoveredWorkflowRunProjection(
    first,
    postExercise,
    [...structuredClone(postExercise), { ...exercise, id: 'boot-two-extra' }],
    expected,
  ), false, 'boot two extra execution');
  for (const [label, mutate] of [
    ['extra exercise field', (row: Record<string, unknown>) => { row.error = 'should not exist'; }],
    ['wrong exercise input', (row: Record<string, unknown>) => { row.input = 'wrong'; }],
    ['wrong exercise output', (row: Record<string, unknown>) => { row.outputPreview = 'wrong'; }],
    ['extra exercise event', (row: Record<string, unknown>) => {
      (row.events as unknown[]).push({ type: 'status' });
    }],
    ['wrong exercise event message', (row: Record<string, unknown>) => {
      ((row.events as Array<Record<string, unknown>>)[1]!).message = 'Done-ish';
    }],
  ] as const) {
    const wrongPost = structuredClone(postExercise) as Array<Record<string, unknown>>;
    mutate(wrongPost.find((row) => row.id === exerciseId)!);
    assert.equal(isExactRecoveredWorkflowRunProjection(
      first,
      wrongPost,
      structuredClone(wrongPost),
      expected,
    ), false, label);
  }
});

test('starter workspace one-shot seed rejects missing, extra, wrong, and boot-two-drifting rows', () => {
  const valid = {
    offeredAt: null,
    reason: 'already-has-workspaces',
    at: '2026-08-30T12:00:00.000Z',
  };
  assert.equal(isExactStarterWorkspaceOfferSeed(valid, structuredClone(valid), structuredClone(valid)), true);
  assert.equal(isExactStarterWorkspaceOfferSeed(null, valid, valid), false, 'missing row');
  assert.equal(isExactStarterWorkspaceOfferSeed({ ...valid, extra: true }, valid, valid), false, 'extra field');
  assert.equal(isExactStarterWorkspaceOfferSeed({ ...valid, reason: 'offered' }, valid, valid), false, 'wrong row');
  assert.equal(isExactStarterWorkspaceOfferSeed(valid, valid, { ...valid, at: '2026-08-30T12:00:01.000Z' }), false, 'boot two drift');
});

test('workspace audit carrier is one bounded exact-v3.14 append, never an absent or vacuous file', () => {
  const valid = `${JSON.stringify({
    ts: '2026-08-30T12:00:00.000Z',
    method: 'FIXTURE',
    path: '/upgrade-rehearsal/v3.14',
    outcome: 'ok',
    bytes: 0,
    note: 'Bounded exact-v3.14 workspace audit carrier.',
  })}\n`;
  assert.equal(isExactV314WorkspaceAuditCarrier(valid), true);
  assert.equal(isExactV314WorkspaceAuditCarrier(null), false, 'missing carrier');
  assert.equal(isExactV314WorkspaceAuditCarrier(''), false, 'empty carrier');
  assert.equal(isExactV314WorkspaceAuditCarrier(`${valid}${valid}`), false, 'extra row');
  assert.equal(isExactV314WorkspaceAuditCarrier(valid.replace('FIXTURE', 'PUT')), false, 'wrong row');
});

test('global audit proof requires the exact recovery and exercise approval appends plus boot-two stability', () => {
  const before = `${JSON.stringify({ at: '2026-08-30T11:00:00.000Z', kind: 'approval_resolved' })}\n`;
  const expected = {
    at: '2026-08-30T12:00:00.000Z',
    sessionId: 'upgrade-rehearsal-approval-owner-v314',
    approvalId: 'approval-v314',
    subject: 'Pending read-only fixture approval',
    tool: 'fixture_read',
    resolution: 'cancelled_by_system',
    resolvedBy: 'reaper-dead-session',
  };
  const append = `${JSON.stringify({ kind: 'approval_resolved', ...expected })}\n`;
  const first = `${before}${append}`;
  const exerciseExpected = {
    at: '2026-08-30T12:01:00.000Z',
    sessionId: 'exercise-session',
    approvalId: 'exercise-approval',
    subject: 'Approve exact automation opportunity: Packaged upgrade durable project',
    tool: 'automation_opportunity_review_decision',
    resolution: 'approved',
    resolvedBy: 'human.packaged-upgrade',
  };
  const exerciseRequestExpected = {
    at: '2026-08-30T12:00:59.000Z',
    kind: 'automation_opportunity_review' as const,
    sessionId: 'exercise-session',
    seq: 7,
    turn: 0,
    projectionId: 'exercise-projection',
    proposalId: 'exercise-proposal',
    proposalRevision: 2,
    proposalDigest: 'a'.repeat(64),
    tool: 'automation_opportunity_review_decision' as const,
    subject: 'Approve exact automation opportunity: Packaged upgrade durable project',
    approvalId: 'exercise-approval',
    pendingActionId: null,
    resumeKey: 'automation-opportunity-review:exercise',
  };
  const exerciseRequestAppend = `${JSON.stringify(exerciseRequestExpected)}\n`;
  const exerciseAppend = `${JSON.stringify({ kind: 'approval_resolved', ...exerciseExpected })}\n`;
  const postExercise = `${first}${exerciseRequestAppend}${exerciseAppend}`;
  assert.equal(isExactApprovalResolutionAuditAppend(
    before,
    first,
    postExercise,
    postExercise,
    expected,
    exerciseRequestExpected,
    exerciseExpected,
  ), true);
  assert.equal(isExactApprovalResolutionAuditAppend(
    before,
    before,
    postExercise,
    postExercise,
    expected,
    exerciseRequestExpected,
    exerciseExpected,
  ), false, 'missing appended row');
  assert.equal(isExactApprovalResolutionAuditAppend(
    before,
    `${first}${append}`,
    postExercise,
    postExercise,
    expected,
    exerciseRequestExpected,
    exerciseExpected,
  ), false, 'extra first-boot row');
  const wrong = `${before}${JSON.stringify({ kind: 'approval_resolved', ...expected, resolvedBy: 'wrong' })}\n`;
  assert.equal(isExactApprovalResolutionAuditAppend(
    before,
    wrong,
    `${wrong}${exerciseRequestAppend}${exerciseAppend}`,
    `${wrong}${exerciseRequestAppend}${exerciseAppend}`,
    expected,
    exerciseRequestExpected,
    exerciseExpected,
  ), false, 'wrong appended row');
  assert.equal(isExactApprovalResolutionAuditAppend(
    before,
    first,
    first,
    first,
    expected,
    exerciseRequestExpected,
    exerciseExpected,
  ), false, 'missing exercise row');
  const missingResolution = `${first}${exerciseRequestAppend}`;
  assert.equal(isExactApprovalResolutionAuditAppend(
    before,
    first,
    missingResolution,
    missingResolution,
    expected,
    exerciseRequestExpected,
    exerciseExpected,
  ), false, 'missing exercise resolution');
  assert.equal(isExactApprovalResolutionAuditAppend(
    before,
    first,
    `${postExercise}${exerciseAppend}`,
    `${postExercise}${exerciseAppend}`,
    expected,
    exerciseRequestExpected,
    exerciseExpected,
  ), false, 'extra exercise row');
  const wrongExercise = `${first}${exerciseRequestAppend}${JSON.stringify({
    kind: 'approval_resolved',
    ...exerciseExpected,
    approvalId: 'wrong-exercise-approval',
  })}\n`;
  assert.equal(isExactApprovalResolutionAuditAppend(
    before,
    first,
    wrongExercise,
    wrongExercise,
    expected,
    exerciseRequestExpected,
    exerciseExpected,
  ), false, 'wrong exercise row');
  const wrongKindRequest = `${first}${JSON.stringify({
    ...exerciseRequestExpected,
    kind: 'custom_probe',
  })}\n${exerciseAppend}`;
  assert.equal(isExactApprovalResolutionAuditAppend(
    before,
    first,
    wrongKindRequest,
    wrongKindRequest,
    expected,
    exerciseRequestExpected,
    exerciseExpected,
  ), false, 'wrong exercise request kind');
  const nonApprovalExtra = `${postExercise}${JSON.stringify({
    at: '2026-08-30T12:02:00.000Z',
    kind: 'custom_probe',
  })}\n`;
  assert.equal(isExactApprovalResolutionAuditAppend(
    before,
    first,
    nonApprovalExtra,
    nonApprovalExtra,
    expected,
    exerciseRequestExpected,
    exerciseExpected,
  ), false, 'non-approval extra exercise row');
  assert.equal(isExactApprovalResolutionAuditAppend(
    before,
    first,
    postExercise,
    `${postExercise}${append}`,
    expected,
    exerciseRequestExpected,
    exerciseExpected,
  ), false, 'boot two append');
});

test('packaged rehearsal reclaims only its exact dead owner and cleanup is idempotent', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-packaged-dead-lease-'));
  let stopCalls = 0;
  try {
    writeDaemonLeaseFixture({ home });
    const cleanup = prepareExitedPackagedDaemonLeaseCleanup({
      home,
      expectedPid: PROVABLY_DEAD_PID,
      expectedToken: LEASE_TOKEN,
      expectedStartedAt: LEASE_STARTED_AT,
      runInstalledDaemonStop: () => {
        stopCalls += 1;
        rmSync(path.join(home, 'daemon.pid'), { force: true });
        rmSync(path.join(home, 'daemon.lock'), { recursive: true, force: true });
      },
    });
    assert.deepEqual(cleanup(), {
      cleaned: true,
      alreadyClean: false,
    });
    assert.equal(existsSync(path.join(home, 'daemon.pid')), false);
    assert.equal(existsSync(path.join(home, 'daemon.lock')), false);
    assert.deepEqual(cleanup(), {
      cleaned: false,
      alreadyClean: true,
    });
    assert.equal(stopCalls, 2, 'the installed daemon stop path remains a safe idempotent operation');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('packaged rehearsal cannot clear mismatched, live, or structurally unsafe lease evidence', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-packaged-unsafe-lease-'));
  let stopCalls = 0;
  const runner = (): void => { stopCalls += 1; };
  try {
    const mismatched = path.join(root, 'mismatched');
    writeDaemonLeaseFixture({ home: mismatched });
    assert.throws(() => prepareExitedPackagedDaemonLeaseCleanup({
      home: mismatched,
      expectedPid: PROVABLY_DEAD_PID,
      expectedToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      expectedStartedAt: LEASE_STARTED_AT,
      runInstalledDaemonStop: runner,
    }), /not the exact exited owner/);
    assert.equal(existsSync(path.join(mismatched, 'daemon.pid')), true);

    const live = path.join(root, 'live');
    writeDaemonLeaseFixture({ home: live, pid: process.pid });
    assert.throws(() => prepareExitedPackagedDaemonLeaseCleanup({
      home: live,
      expectedPid: process.pid,
      expectedToken: LEASE_TOKEN,
      expectedStartedAt: LEASE_STARTED_AT,
      runInstalledDaemonStop: runner,
    }), /while PID .* is live or unreadable/);
    assert.equal(existsSync(path.join(live, 'daemon.pid')), true);

    const unsafe = path.join(root, 'unsafe');
    writeDaemonLeaseFixture({ home: unsafe });
    writeFileSync(path.join(unsafe, 'daemon.lock', 'unexpected-owner-evidence'), 'unsafe');
    assert.throws(() => prepareExitedPackagedDaemonLeaseCleanup({
      home: unsafe,
      expectedPid: PROVABLY_DEAD_PID,
      expectedToken: LEASE_TOKEN,
      expectedStartedAt: LEASE_STARTED_AT,
      runInstalledDaemonStop: runner,
    }), /not the exact exited owner/);
    assert.equal(existsSync(path.join(unsafe, 'daemon.lock', 'unexpected-owner-evidence')), true);
    assert.equal(stopCalls, 0, 'no stop command may run without an exact dead-owner proof');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packaged rehearsal never reports cleanup success when daemon stop leaves the lease behind', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-packaged-false-clean-'));
  try {
    writeDaemonLeaseFixture({ home });
    const cleanup = prepareExitedPackagedDaemonLeaseCleanup({
      home,
      expectedPid: PROVABLY_DEAD_PID,
      expectedToken: LEASE_TOKEN,
      expectedStartedAt: LEASE_STARTED_AT,
      runInstalledDaemonStop: () => undefined,
    });
    assert.throws(
      () => cleanup(),
      /installed packaged daemon stop did not remove the exact stale PID\/owner lease/,
    );
    assert.equal(existsSync(path.join(home, 'daemon.pid')), true);
    assert.equal(existsSync(path.join(home, 'daemon.lock')), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('logical projection normalizes only proven scheduler and daemon cursors', () => {
  assert.deepEqual(normalizePackagedLogicalJson('cron/daemon-state.json', {
    lastHealthyTickAt: '2026-08-30T12:00:00.000Z',
    lastCronEvaluatedAtMs: 10,
    pendingCronOccurrences: { exact: true },
  }), { pendingCronOccurrences: { exact: true } });
  assert.deepEqual(normalizePackagedLogicalJson('cron/workflow-schedule-state.json', {
    lastEvaluatedAtMs: 10,
    pendingOccurrences: { exact: true },
  }), { pendingOccurrences: { exact: true } });
  assert.deepEqual(normalizePackagedLogicalJson('state/space-schedule-state.json', {
    lastEvaluatedAtMs: 10,
    lastRunByMinute: {},
    lastReengageByKey: {},
    pausedRetryBySlug: {},
  }), { lastRunByMinute: {}, lastReengageByKey: {}, pausedRetryBySlug: {} });
  for (const file of [
    'state/reviewed-cli-scan.json',
    'state/capability-catalog.json',
    'spaces/upgrade-rehearsal-space/data.json',
    'state/operational-telemetry.json',
  ]) {
    const exact = { lastEvaluatedAtMs: 10, exact: true } as const;
    assert.deepEqual(normalizePackagedLogicalJson(file, exact), exact, file);
  }
});

test('legacy approval file permits only one exact pending-to-rejected retirement', () => {
  const before = [
    { id: 'legacy-approval-v314-pending', status: 'pending', state: '{"fixture":true}' },
    { id: 'legacy-approval-v314-approved', status: 'approved', state: '{"fixture":true}' },
  ];
  const first = [
    { ...before[0], status: 'rejected' },
    { ...before[1] },
  ];
  assert.equal(isExactLegacyApprovalRetirement(before, first, structuredClone(first)), true);
  assert.equal(isExactLegacyApprovalRetirement(before, [
    { ...first[0], state: '{"changed":true}' },
    first[1],
  ], structuredClone(first)), false);
  assert.equal(isExactLegacyApprovalRetirement(before, [before[0], before[1]], [before[0], before[1]]), false);
});

test('v3.14 registry truth is one system event while schedule proof remains out of registry', () => {
  const event = {
    id: 'system-event',
    kind: 'system_event',
    event_type: 'upgrade.rehearsal.never-fired',
    schedule: null,
    timezone: null,
  };
  assert.equal(isExactV314TriggerRegistry([event]), true);
  assert.equal(isExactV314TriggerRegistry([event, {
    ...event, kind: 'schedule', event_type: null, schedule: '0 0 1 1 *', timezone: 'UTC',
  }]), false);
  assert.equal(AUTOMATION_OPPORTUNITY_PROPOSAL_DB, 'state/automation-opportunities/automation-opportunities.db');
});

test('packaged exercise is a package-root driver with no Clementine source import', () => {
  const fixture = readFileSync(path.join(process.cwd(), 'scripts', 'rehearse-v314-packaged-exercise.mjs'), 'utf8');
  assert.match(fixture, /installedRoot, 'dist'/);
  assert.doesNotMatch(fixture, /(?:from\s+|import\()(['"])(?:\.\.\/)*src\//);
  assert.doesNotMatch(fixture, /node_modules\/\.bin|--import\s+tsx/);
});

test('packaged acquisition proof accepts only canonical missing diagnostics', () => {
  assert.equal(
    isPackagedCapabilityAcquisitionMissingDetail('no live-read carrier adapters are configured'),
    true,
  );
  assert.equal(
    isPackagedCapabilityAcquisitionMissingDetail('no current attested read capability matched the objective'),
    true,
  );
  assert.equal(isPackagedCapabilityAcquisitionMissingDetail('configured carrier adapters are unavailable'), false);
  assert.equal(isPackagedCapabilityAcquisitionMissingDetail('missing'), false);
});

test('packaged notification settlement requires durable desktop receipts, not an empty queue alone', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-v314-desktop-settlement-test-'));
  const notifications = [
    {
      id: 'upgrade-rehearsal-notification-v314',
      kind: 'system',
      title: 'v3.14 migration fixture',
      body: 'Preserved local-only fixture',
      createdAt: '2026-08-07T22:43:08.000Z',
      read: false,
      silent: true,
      metadata: { release: 'v3.14.0', fixture: true },
    },
    desktopDeliveredNotification({
      id: 'restart-recovery',
      kind: 'system',
      title: 'A chat task was interrupted by a restart',
      metadata: {
        sessionId: 'upgrade-rehearsal-active-chat-v314',
        reason: 'interrupted_by_restart',
      },
    }),
    ...['scheduled', 'event'].map((suffix) => desktopDeliveredNotification({
      id: `workflow-upgrade-${suffix}-disabled`,
      kind: 'workflow',
      title: 'Workflow not run: upgrade-rehearsal-workflow',
      metadata: { workflow: 'upgrade-rehearsal-workflow', runId: `upgrade-${suffix}` },
    })),
    desktopDeliveredNotification({
      id: 'approval-system-cancelled-upgrade',
      kind: 'system',
      title: 'Approval closed with its ended session',
      metadata: {
        sessionId: 'upgrade-rehearsal-approval-owner-v314',
        approvalResolution: 'cancelled_by_system',
      },
    }),
  ];
  try {
    writeNotificationState(home, notifications);
    const settled = notificationDeliverySettlement(home);
    assert.equal(settled.settled, true);
    assert.equal(settled.queueLength, 0);
    assert.equal(settled.desktopReceiptIds.length, 4);
    assert.equal(settled.legacyFixturePreserved, true);
    assert.equal(settled.setupPromptPresent, false);

    const lostReceipt = structuredClone(notifications);
    delete lostReceipt[1]?.deliveredDestinations;
    writeNotificationState(home, lostReceipt);
    const missing = notificationDeliverySettlement(home);
    assert.equal(missing.settled, false, 'an empty cursor is not proof that its notification was delivered');
    assert.deepEqual(missing.missingDesktopReceiptIds, ['restart-recovery']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('packed candidate migrates and recovers an exact v3.14 home once across two daemon processes', { timeout: 600_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-v314-packaged-daemon-test-'));
  try {
    const report = await runPackagedV314DaemonRehearsal({ rehearsalRoot: root, keep: true });
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter((check) => !check.ok), null, 2));
    assert.equal(report.checks.every((check) => check.ok), true);
    assert.equal(report.boots.length, 2);
    assert.equal(report.boots.every((boot) =>
      boot.ready && boot.recoverySettled && boot.notificationDeliverySettled && boot.cleanExit), true);
    assert.deepEqual(report.boots[0]?.build, report.boots[1]?.build);
    assert.equal(report.boots[0]?.build.packaged, true);
    assert.equal(report.boots[0]?.build.schemaVersion, report.boots[0]?.build.expectedSchemaVersion);
    assert.equal(report.exercise.workflowRunStatus, 'completed');
    assert.equal(report.exercise.proposalRevision, 3);
    assert.equal(report.exercise.advancementStage, 'blocked');
    assert.equal(report.exercise.advancementBlockedCode, 'capability_acquisition_missing');
    assert.ok(report.exercise.modelRequests.length >= 2);
    assert.equal(report.secondBootWorkDelta.total, 0);
    assert.equal(report.postExerciseStateDigest, report.secondBootStateDigest);
    assert.deepEqual(report.secondBootLogicalStateDiff, {
      sqliteSchemasChanged: [],
      sqliteTablesAdded: [],
      sqliteTablesRemoved: [],
      sqliteTablesChanged: [],
      filesAdded: [],
      filesRemoved: [],
      filesChanged: [],
    });
    assert.equal(existsSync(report.paths.packageEntry), true);
    assert.equal(existsSync(report.paths.report), true);
  } finally {
    const resolved = path.resolve(root);
    const temp = path.resolve(os.tmpdir());
    assert.ok(resolved.startsWith(`${temp}${path.sep}`));
    rmSync(resolved, { recursive: true, force: true });
  }
});
