import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AUTOMATION_OPPORTUNITY_PROPOSAL_DB,
  WORK_TABLES,
  classifyPackagedFirstBootAddedFile,
  isPackagedCapabilityAcquisitionMissingDetail,
  isExactDaemonLeaseOwnerRecord,
  isExactLegacyApprovalRetirement,
  isExactV314FixtureMachineIdCandidate,
  isExactV314TriggerRegistry,
  normalizePackagedLogicalJson,
  notificationDeliverySettlement,
  packagedRuntimeEnvironment,
  runPackagedV314DaemonRehearsal,
  sanitizePackagedGateEnvironment,
  seedPackagedGateState,
} from './rehearse-v314-packaged-daemon.mts';
import { V314_GATE_MACHINE_ID } from './rehearse-v314-upgrade.mts';

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
