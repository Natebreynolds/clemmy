/**
 * Run: node scripts/run-tests-isolated.mjs src/spaces/source-refresh-backoff.test.ts
 *
 * A scheduled data source that keeps failing tells the owner once, then backs
 * off. The scheduler pins drive the real processSpaceSchedules → the real
 * refreshSpaceData → the real read kernel; only the provider edge is a fixture
 * port, and the local-script source fails exactly as a live one does.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-backoff-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const eventlog = await import('../runtime/harness/eventlog.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const externalCatalog = await import('../execution/workflow-step-external-catalog.js');
const readAuthority = await import('./space-read-authority.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const composio = await import('../integrations/composio/client.js');
const notifications = await import('../runtime/notifications.js');
const intent = await import('../runtime/notification-intent.js');
const store = await import('./store.js');
const runner = await import('./runner.js');
const { seedLegacySpaceTrustApproval } = await import('./legacy-space-trust.fixture.js');
const sched = await import('./scheduler.js');
const backoff = await import('./source-refresh-backoff.js');
const workspaceDb = await import('./workspace-db.js');

const STATE_FILE = path.join(TEST_HOME, 'state', 'space-schedule-state.json');

test.after(() => {
  composio._setConnectedToolkitsSnapshotForTests(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  readAuthority._setExactSpaceReadCatalogPreparerForTests(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const digest = (label: string): string => createHash('sha256').update(label, 'utf8').digest('hex');

/** A provider read whose edge is a fixture port the test can break and mend. */
function installSwitchableRead(operationId: string): {
  bodies: () => number;
  fail: (message: string) => void;
  mend: () => void;
} {
  let failure: string | null = null;
  let bodies = 0;
  const manifest = manifests.attachSemanticContract({
    version: 1,
    manifestId: `manifest.space.backoff.${operationId.toLowerCase()}`,
    providerKind: 'composio',
    operationId,
    providerIdentity: 'runtime.test',
    providerVersion: 'runtime.1',
    operationVersion: '1',
    externalDefinition: {
      version: 1, providerInputSchemaDigest: digest(`input:${operationId}`), semanticName: operationId,
      behaviorHints: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    },
    definitionFingerprint: digest(`schema:${operationId}`),
    effect: 'read',
    accountId: `account.space.${operationId}`,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'read_bounded_records',
    acceptedInputKinds: ['scope'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'host.test', issuedAt: '2026-08-22T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source'],
  });
  assert.equal(ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(manifest),
    {
      invoke: async () => {
        bodies += 1;
        if (failure) throw new Error(failure);
        return { data: { records: [{ id: `record.${bodies}` }] }, successful: true };
      },
    },
  ).ok, true);
  const factory = catalogs.peekHostCapabilityCatalogFactory() ?? catalogs.createHostCapabilityCatalogFactory();
  const entry: catalogs.RegisteredHostCapability = {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => {
      throw new Error('catalog invoke must not own the workspace crossing');
    },
  };
  factory.register(entry);
  catalogs.installHostCapabilityCatalogFactory(factory);
  composio._setConnectedToolkitsSnapshotForTests([{
    slug: operationId.split('_')[0]!.toLowerCase(), connectionId: manifest.accountId, status: 'ACTIVE',
  }]);
  const manifestStore = manifestStores.createCapabilityManifestStore();
  assert.equal(manifestStore.install(manifest).ok, true);
  manifestStores.installCapabilityManifestStore(manifestStore);
  // Refreshes revalidate a provider definition on every occurrence. Supply
  // fixture metadata at that boundary while keeping the real catalog compiler,
  // independent observation, durable read kernel and result settlement.
  const definition = {
    identifier: operationId, schemaDigest: digest(`input:${operationId}`), accountIdentity: manifest.accountId,
    definitionFingerprint: manifest.definitionFingerprint, outputSchemaDigest: null,
    providerOperationVersion: manifest.operationVersion, invokePortId: manifest.invokePortId,
    schema: { type: 'object' }, fingerprint: digest(`source-schema:${operationId}`), outputSchema: null,
  };
  readAuthority._setExactSpaceReadCatalogPreparerForTests(input => externalCatalog.prepareWorkflowStepExternalCatalog(input, {
    manifestStore, catalogFactory: factory,
    revalidate: async () => ({ ok: true, definitions: new Map([[operationId.toLowerCase(), definition]]) }),
    refresh: () => { factory.register(entry); }, ready: ids => ids.every(id => Boolean(factory.get(id))),
  }));
  return {
    bodies: () => bodies,
    fail: (message) => { failure = message; },
    mend: () => { failure = null; },
  };
}

async function approveLocalRunner(slug: string, source: Parameters<typeof runner.runSpaceDataSource>[1]): Promise<void> {
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, source.runner!), 'process.stdout.write("{}");', 'utf-8');
  const card = seedLegacySpaceTrustApproval(slug, source);
  eventlog.openEventLog().prepare(`
    UPDATE pending_approvals
       SET status = 'resolved', resolution = 'approved', resolver = ?, resolved_at = ?
     WHERE approval_id = ? AND status = 'pending'
  `).run('backoff-fixture', new Date().toISOString(), card.approvalId);
}

function noticesFor(slug: string): ReturnType<typeof notifications.loadNotifications> {
  return notifications.loadNotifications().filter((row) =>
    row.metadata?.source === backoff.SPACE_SOURCE_NOTICE_SOURCE && row.metadata?.workspaceId === slug);
}

function observationCount(slug: string, sourceId: string): number {
  return workspaceDb.listWorkspaceDatasetObservations(slug, { sourceKey: sourceId, limit: 500 }).length;
}

function persistedStreak(key: string): Record<string, unknown> | undefined {
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as { sourceStreakByKey?: Record<string, Record<string, unknown>> };
  return state.sourceStreakByKey?.[key];
}

const hour = (base: string, n: number): Date => new Date(Date.parse(base) + n * 60 * 60_000);

// ─── Pure policy ─────────────────────────────────────────────────────────────

const IDENTITY = { declarationDigest: 'decl-1', connectionDigest: null };

test('the same failure code tells once after three in a row; a different code may tell once more', () => {
  let streak: ReturnType<typeof backoff.recordSourceRefreshFailure>['streak'] | undefined;
  const tells: boolean[] = [];
  const codes = ['local_runner', 'local_runner', 'local_runner', 'local_runner', 'provider_error', 'provider_error', 'provider_error', 'provider_error', 'local_runner', 'local_runner', 'local_runner'] as const;
  codes.forEach((code, index) => {
    const recorded = backoff.recordSourceRefreshFailure(streak, {
      code,
      error: `failure ${index}`,
      at: hour('2026-06-10T00:00:00.000Z', index),
      identity: IDENTITY,
      okObservationId: null,
    });
    streak = recorded.streak;
    tells.push(recorded.tell);
  });
  assert.deepEqual(
    tells,
    [false, false, true, false, false, false, true, false, false, false, false],
    'each code is told once per streak, after it repeats three times',
  );
  assert.equal(streak!.failures, codes.length, 'the streak counts every failure whatever the code');
  assert.deepEqual(streak!.told, ['local_runner', 'provider_error']);
});

test('the wait grows with the streak and never exceeds its ceilings', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 30].map(backoff.skipsAfterFailures),
    [0, 0, 1, 3, 7, 15, 31, 63, 63, 63],
  );
  const recorded = backoff.recordSourceRefreshFailure(undefined, {
    code: 'provider_error', error: 'x', at: new Date('2026-06-10T00:00:00.000Z'), identity: IDENTITY, okObservationId: null,
  }).streak;
  const held = { ...recorded, skipsRemaining: 63 };
  assert.equal(backoff.passOverDueOccurrence(held, { now: new Date('2026-06-11T00:00:00.000Z'), occurrences: 1 }).hold, true);
  const week = backoff.passOverDueOccurrence(held, { now: new Date(Date.parse('2026-06-10T00:00:00.000Z') + backoff.MAX_HOLD_MS), occurrences: 1 });
  assert.equal(week.hold, false, 'a held source is still tried at least once a week');
  const caughtUp = backoff.passOverDueOccurrence({ ...recorded, skipsRemaining: 3 }, { now: new Date('2026-06-10T05:00:00.000Z'), occurrences: 5 });
  assert.equal(caughtUp.hold, true);
  assert.equal(caughtUp.streak.skipsRemaining, 0, 'a catch-up window spends every occurrence it stands for');
});

test('a changed declaration or connection restarts the tries but keeps what was told', () => {
  const told = backoff.recordSourceRefreshFailure({
    failures: 2, code: 'provider_error', codeFailures: 2, error: '', firstFailedAt: '2026-06-10T00:00:00.000Z',
    lastFailedAt: '2026-06-10T02:00:00.000Z', skipsRemaining: 0, told: [], declarationDigest: 'decl-1',
    connectionDigest: 'conn-1', okObservationId: null,
  }, { code: 'provider_error', error: '', at: new Date('2026-06-10T03:00:00.000Z'), identity: { declarationDigest: 'decl-1', connectionDigest: 'conn-1' }, okObservationId: null });
  assert.equal(told.tell, true);
  assert.equal(backoff.sourceIdentityChanged(told.streak, { declarationDigest: 'decl-1', connectionDigest: 'conn-1' }), false);
  assert.equal(backoff.sourceIdentityChanged(told.streak, { declarationDigest: 'decl-2', connectionDigest: 'conn-1' }), true);
  assert.equal(backoff.sourceIdentityChanged(told.streak, { declarationDigest: 'decl-1', connectionDigest: 'conn-2' }), true);
  assert.equal(
    backoff.sourceIdentityChanged(told.streak, { declarationDigest: 'decl-1', connectionDigest: null }),
    false,
    'an unknown connection registry is not a change',
  );
  const restarted = backoff.restartAfterChange(told.streak, { declarationDigest: 'decl-2', connectionDigest: 'conn-1' });
  assert.equal(restarted.skipsRemaining, 0);
  assert.equal(restarted.failures, 0);
  const again = backoff.recordSourceRefreshFailure(restarted, {
    code: 'provider_error', error: '', at: new Date('2026-06-10T04:00:00.000Z'), identity: { declarationDigest: 'decl-2', connectionDigest: 'conn-1' }, okObservationId: null,
  });
  assert.equal(again.tell, false, 'the same reason is not told twice in one streak');
});

test('persisted streaks keep only well-formed rows', () => {
  const read = backoff.readSourceRefreshStreaks({
    good: {
      failures: 3, code: 'local_runner', codeFailures: 3, error: 'e', firstFailedAt: 'a', lastFailedAt: 'b',
      skipsRemaining: 1, told: ['local_runner', 'made_up'], declarationDigest: 'd', connectionDigest: null, okObservationId: null,
    },
    unknownCode: { failures: 1, code: 'made_up', codeFailures: 1, firstFailedAt: 'a', lastFailedAt: 'b', skipsRemaining: 0, declarationDigest: 'd' },
    negative: { failures: -1, code: 'shaping', codeFailures: 1, firstFailedAt: 'a', lastFailedAt: 'b', skipsRemaining: 0, declarationDigest: 'd' },
    notAnObject: 'x',
  });
  assert.deepEqual(Object.keys(read), ['good']);
  assert.deepEqual(read.good?.told, ['local_runner']);
});

// ─── The real scheduler ──────────────────────────────────────────────────────

test('a local-script source that fails the same way every hour tells once, then backs off', async () => {
  const slug = 'framework-test-backoff-script';
  const source = { id: 'pipeline', runner: 'refresh.mjs', schedule: '0 * * * *' };
  store.spaceStore.save({ id: slug, title: 'FRAMEWORK-TEST Pipeline Board', dataSources: [source] });
  await approveLocalRunner(slug, source);
  const key = `${slug}:pipeline`;
  const base = '2026-06-20T08:00:00.000Z';
  try {
    for (let n = 0; n < 2; n += 1) {
      const tick = await sched.processSpaceSchedules(hour(base, n));
      assert.equal(tick.errors, 1);
      assert.equal(tick.told, 0);
    }
    assert.equal(noticesFor(slug).length, 0, 'two failures are not yet a pattern');

    const third = await sched.processSpaceSchedules(hour(base, 2));
    assert.equal(third.errors, 1);
    assert.equal(third.told, 1);
    const [notice, ...extra] = noticesFor(slug);
    assert.ok(notice, 'the third failure in a row with the same code tells the owner');
    assert.equal(extra.length, 0);
    assert.match(notice.title, /"pipeline" in FRAMEWORK-TEST Pipeline Board isn't refreshing/);
    assert.match(notice.body, /failed its last 3 scheduled refreshes the same way/);
    assert.match(notice.body, /Why: It runs a local script \(refresh\.mjs\)/);
    assert.match(notice.body, /What would fix it: Ask Clem to rebuild this source/);
    assert.doesNotMatch(notice.body, /shared durable call authority|kernel/i, 'plain words, not the engine refusal');
    assert.equal(notice.metadata?.failureCode, 'local_runner');
    assert.equal(notice.silent, undefined, 'the notice is delivered like any finished report');
    assert.equal(intent.classifyNotification(notice), 'finished', 'told once, never a badge');
    assert.equal(intent.isAwaitingUser(notice), false);

    const observed = observationCount(slug, 'pipeline');
    const fourth = await sched.processSpaceSchedules(hour(base, 3));
    assert.equal(fourth.heldBack, 1, 'the next occurrence is passed over');
    assert.equal(fourth.errors, 0);
    assert.equal(observationCount(slug, 'pipeline'), observed, 'a held occurrence does not refresh');

    const fifth = await sched.processSpaceSchedules(hour(base, 4));
    assert.equal(fifth.errors, 1, 'the one after that is tried');
    assert.equal(persistedStreak(key)?.skipsRemaining, 3, 'and the wait grows');
    for (let n = 5; n < 8; n += 1) {
      assert.equal((await sched.processSpaceSchedules(hour(base, n))).heldBack, 1);
    }
    const ninth = await sched.processSpaceSchedules(hour(base, 8));
    assert.equal(ninth.errors, 1);
    assert.equal(noticesFor(slug).length, 1, 'the same failure is never told twice');
    assert.equal(
      workspaceDb.listWorkspaceDatasetObservations(slug, { sourceKey: 'pipeline', limit: 500 })
        .filter((row) => row.cause === 'scheduled').length,
      5,
      'nine scheduled hours cost five refreshes',
    );
  } finally {
    store.spaceStore.archive(slug);
  }
});

test('a failing provider source recovers on its first success and a later streak tells again', async () => {
  const slug = 'framework-test-backoff-provider';
  const read = installSwitchableRead('FRAMEWORKTEST_LIST_RECORDS');
  read.fail('fixture provider is down');
  store.spaceStore.save({
    id: slug,
    title: 'FRAMEWORK-TEST Records',
    dataSources: [{ id: 'records', composioSlug: 'FRAMEWORKTEST_LIST_RECORDS', composioArgs: { limit: 5 }, schedule: '0 * * * *' }],
  });
  const key = `${slug}:records`;
  const base = '2026-06-21T08:00:00.000Z';
  try {
    for (let n = 0; n < 3; n += 1) await sched.processSpaceSchedules(hour(base, n));
    assert.equal(read.bodies(), 3, `each failing hour really called the app: ${JSON.stringify(workspaceDb.listWorkspaceDatasetObservations(slug, { sourceKey: 'records', limit: 3 }).map(row => row.error))}`);
    const [notice] = noticesFor(slug);
    assert.ok(notice);
    assert.equal(notice.metadata?.failureCode, 'provider_error');
    assert.match(notice.body, /Why: The app returned an error for FRAMEWORKTEST_LIST_RECORDS\./);
    assert.match(notice.body, /Details: .*fixture provider is down/, 'the provider\'s own words ride along as detail');

    assert.equal((await sched.processSpaceSchedules(hour(base, 3))).heldBack, 1);
    assert.equal(read.bodies(), 3, 'backing off stops calling the app');

    read.mend();
    const recovered = await sched.processSpaceSchedules(hour(base, 4));
    assert.equal(recovered.fired, 1);
    assert.equal(persistedStreak(key), undefined, 'the first success clears the streak');
    assert.equal((await sched.processSpaceSchedules(hour(base, 5))).fired, 1, 'and the normal cadence resumes');
    assert.equal(read.bodies(), 5);

    read.fail('fixture provider is down');
    for (let n = 6; n < 9; n += 1) await sched.processSpaceSchedules(hour(base, n));
    assert.equal(noticesFor(slug).length, 2, 'a new streak after a success is told again, once');
  } finally {
    store.spaceStore.archive(slug);
  }
});

test('a success from any path, a changed declaration, or a changed connection ends the wait', async () => {
  const slug = 'framework-test-backoff-change';
  const read = installSwitchableRead('FRAMEWORKTEST_GET_ROWS');
  composio._setConnectedToolkitsSnapshotForTests([
    { slug: 'frameworktest', connectionId: 'conn-fixture-1', status: 'ACTIVE' },
  ]);
  const declared = { id: 'rows', composioSlug: 'FRAMEWORKTEST_GET_ROWS', composioArgs: { limit: 5 }, schedule: '0 * * * *' };
  store.spaceStore.save({ id: slug, title: 'FRAMEWORK-TEST Rows', dataSources: [declared] });
  const key = `${slug}:rows`;
  const base = '2026-06-22T08:00:00.000Z';
  const failThreeHours = async (from: number): Promise<void> => {
    read.fail('fixture rows are unavailable');
    for (let n = from; n < from + 3; n += 1) await sched.processSpaceSchedules(hour(base, n));
    assert.equal(persistedStreak(key)?.skipsRemaining, 1, 'the source is backing off');
  };
  try {
    // A manual refresh that succeeds ends the streak for the scheduler too.
    await failThreeHours(0);
    read.mend();
    const manual = await runner.refreshSpaceData(slug, 'rows', { cause: 'manual' });
    assert.equal(manual[0]?.ok, true);
    const afterManual = await sched.processSpaceSchedules(hour(base, 3));
    assert.equal(afterManual.heldBack, 0, 'the next occurrence is not held after a manual success');
    assert.equal(afterManual.fired, 1);
    assert.equal(persistedStreak(key), undefined);

    // A changed declaration is tried at once, off the schedule.
    await failThreeHours(4);
    read.mend();
    store.spaceStore.save({ id: slug, title: 'FRAMEWORK-TEST Rows', dataSources: [{ ...declared, composioArgs: { limit: 10 } }] });
    const beforeEdit = read.bodies();
    const offSchedule = new Date(Date.parse(hour(base, 6).toISOString()) + 20 * 60_000);
    const edited = await sched.processSpaceSchedules(offSchedule);
    assert.equal(read.bodies(), beforeEdit + 1, 'the edited source is refreshed right away');
    assert.equal(edited.fired, 1);
    assert.equal(persistedStreak(key), undefined);

    // A changed app connection is tried at once too.
    await failThreeHours(7);
    read.mend();
    composio._setConnectedToolkitsSnapshotForTests([
      { slug: 'frameworktest', connectionId: 'conn-fixture-2', status: 'ACTIVE' },
    ]);
    const beforeReconnect = read.bodies();
    const reconnected = await sched.processSpaceSchedules(new Date(Date.parse(hour(base, 9).toISOString()) + 20 * 60_000));
    assert.equal(read.bodies(), beforeReconnect + 1, 'a reconnected app is tried right away');
    assert.equal(reconnected.fired, 1);
    assert.equal(persistedStreak(key), undefined);
  } finally {
    composio._setConnectedToolkitsSnapshotForTests(null);
    store.spaceStore.archive(slug);
  }
});

test('the failing-source notice routes exactly like a workflow outcome', async () => {
  const notice = backoff.sourceStreakNotice({
    spaceId: 'framework-test-route',
    spaceTitle: 'FRAMEWORK-TEST Route',
    source: { id: 'feed', composioSlug: 'FRAMEWORKTEST_LIST_RECORDS', schedule: '0 * * * *' },
    streak: {
      failures: 3, code: 'provider_error', codeFailures: 3, error: 'fixture', firstFailedAt: '2026-06-10T00:00:00.000Z',
      lastFailedAt: '2026-06-10T02:00:00.000Z', skipsRemaining: 1, told: ['provider_error'], declarationDigest: 'd',
      connectionDigest: null, okObservationId: null,
    },
  });
  const record = { ...notice, kind: 'system' as const, createdAt: '2026-06-10T02:00:00.000Z', read: false };
  const outcome = {
    id: 'workflow-run-route-completed', kind: 'workflow' as const, title: 'Workflow completed: route', body: 'done',
    createdAt: '2026-06-10T02:00:00.000Z', read: false, metadata: { workflow: 'route', runId: 'run-route' },
  };
  assert.deepEqual(
    notifications.getNotificationDestinationsForRecord(record).map((row) => row.id),
    notifications.getNotificationDestinationsForRecord(outcome).map((row) => row.id),
    'desktop, phone and chat channels resolve the same way for both',
  );
  assert.equal(intent.isWorthNotifying(record), true, 'a phone may be told: it is a finished report');
  const { notificationDeliveryInternalsForTest } = await import('../runtime/notification-delivery.js');
  assert.deepEqual(notificationDeliveryInternalsForTest.buildPushCopy(record), {
    title: 'FRAMEWORK-TEST Route isn\'t refreshing',
    body: 'Tap to see why and what would fix it.',
  });
});

function saveFailingSources(slug: string, ids: string[]) {
  const sources = ids.map(id => ({ id, runner: `${id}.mjs`, schedule: '0 * * * *' }));
  store.spaceStore.save({ id: slug, title: `FRAMEWORK-TEST ${slug}`, dataSources: sources });
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  for (const source of sources) writeFileSync(path.join(dir, source.runner), 'process.stdout.write("{}");');
  return sources;
}

test('simultaneous failures form one report per Space, preserve every source, and concurrent ticks do not repeat it', async () => {
  const a = 'framework-group-a';
  const b = 'framework-group-b';
  const first = saveFailingSources(a, ['pipeline', 'transcripts']);
  saveFailingSources(b, ['contacts']);
  const base = '2026-06-23T08:00:00.000Z';
  try {
    await sched.processSpaceSchedules(hour(base, 0));
    await sched.processSpaceSchedules(hour(base, 1));
    const results = await Promise.all([
      sched.processSpaceSchedules(hour(base, 2)),
      sched.processSpaceSchedules(hour(base, 2)),
    ]);
    assert.equal(results.reduce((n, result) => n + result.told, 0), 2, 'two reports, not three source alerts');
    assert.equal(results.reduce((n, result) => n + result.errors, 0), 3, 'each due source ran once');
    const [group, ...extra] = noticesFor(a);
    assert.ok(group);
    assert.equal(extra.length, 0);
    assert.deepEqual(group.metadata?.sourceIds, ['pipeline', 'transcripts']);
    assert.equal(group.metadata?.failedSourceCount, 2);
    assert.match(group.body ?? '', /"pipeline" source/);
    assert.match(group.body ?? '', /"transcripts" source/);
    assert.equal((group.body?.match(/What would fix it:/g) ?? []).length, 2);
    assert.equal(noticesFor(b).length, 1, 'unrelated Spaces remain independently actionable');
    for (const source of first) {
      assert.deepEqual(persistedStreak(`${a}:${source.id}`)?.told, ['local_runner']);
      assert.equal(observationCount(a, source.id), 3);
    }
    const next = await sched.processSpaceSchedules(hour(base, 3));
    assert.equal(next.heldBack, 3, 'grouping does not change per-source backoff');
    assert.equal(next.told, 0);
    assert.equal(noticesFor(a).length, 1);
    const { notificationDeliveryInternalsForTest } = await import('../runtime/notification-delivery.js');
    assert.deepEqual(notificationDeliveryInternalsForTest.buildPushCopy(group), {
      title: `2 sources in FRAMEWORK-TEST ${a} aren't refreshing`,
      body: 'Tap to see each source and what would fix it.',
    });
  } finally { store.spaceStore.archive(a); store.spaceStore.archive(b); }
});

test('a partial notification write retains a durable group and retries it without rerunning held sources', async () => {
  const slug = 'framework-group-delivery-recovery';
  const sources = saveFailingSources(slug, ['rows', 'activity']);
  const base = '2026-06-24T08:00:00.000Z';
  try {
    await sched.processSpaceSchedules(hour(base, 0));
    await sched.processSpaceSchedules(hour(base, 1));
    notifications._failNextNotificationDeliveryQueueWriteForTest(new Error('fixture queue write failed'));
    const [failed] = await Promise.all([
      sched.processSpaceSchedules(hour(base, 2)),
      sched.retryPausedSpaces(hour(base, 2)),
    ]);
    assert.equal(failed.told, 0, 'failed queue admission is not successful notification admission');
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const pending = Object.values(saved.pendingSourceNotices) as Array<{ id: string; createdAt: string; metadata: Record<string, unknown> }>;
    assert.equal(pending.length, 1, 'the paused retry did not overwrite the pending generation');
    const original = pending[0]!;
    assert.equal(original.metadata.failedSourceCount, 2);
    assert.equal(original.createdAt, hour(base, 2).toISOString());
    const before = sources.map(source => observationCount(slug, source.id));
    // Restore from disk on the next tick, before any source is due. Reject
    // routing fields not owned by this failure-report outbox on restore.
    saved.pendingSourceNotices[original.id].metadata.destinationIds = ['unrelated-destination'];
    writeFileSync(STATE_FILE, JSON.stringify(saved));
    const recovered = await sched.processSpaceSchedules(new Date(Date.parse(base) + (2 * 60 + 1) * 60_000));
    assert.equal(recovered.told, 1);
    assert.deepEqual(sources.map(source => observationCount(slug, source.id)), before);
    const [notice, ...others] = noticesFor(slug);
    assert.equal(others.length, 0);
    assert.equal(notice?.id, original.id);
    assert.equal(notice?.createdAt, original.createdAt);
    assert.equal(notice?.metadata?.destinationIds, undefined);
    assert.equal(notifications.listQueuedNotificationDeliveries().filter(job => job.notificationId === original.id).length, 1);
    assert.deepEqual(JSON.parse(readFileSync(STATE_FILE, 'utf8')).pendingSourceNotices, {});
    assert.equal((await sched.processSpaceSchedules(new Date(Date.parse(base) + (2 * 60 + 2) * 60_000))).told, 0);
  } finally { store.spaceStore.archive(slug); }
});

test('group identity is order independent, retains mixed causes, and keeps singleton ids compatible', () => {
  const base = {
    failures: 3, codeFailures: 3, error: 'fixture detail', firstFailedAt: '2026-06-25T00:00:00.000Z',
    lastFailedAt: '2026-06-25T02:00:00.000Z', skipsRemaining: 1, told: [], declarationDigest: 'd',
    connectionDigest: null, okObservationId: null,
  };
  const a = { spaceId: 'same-space', spaceTitle: 'Same Space', source: { id: 'a', runner: 'a.mjs' },
    streak: { ...base, code: 'local_runner' as const } };
  const b = { ...a, source: { id: 'b', composioSlug: 'FIXTURE_LIST_RECORDS' },
    streak: { ...base, code: 'provider_error' as const } };
  const first = backoff.sourceStreakGroupNotice([a, b]);
  assert.deepEqual(backoff.sourceStreakGroupNotice([b, a, a]), first);
  assert.deepEqual(backoff.sourceStreakGroupNotice([a]), backoff.sourceStreakNotice(a));
  assert.equal(first.metadata.failureCode, undefined, 'mixed causes cannot pretend to be one cause');
  assert.deepEqual((first.metadata.failures as Array<{ failureCode: string }>).map(row => row.failureCode), ['local_runner', 'provider_error']);
  assert.notEqual(backoff.sourceStreakGroupNotice([a, { ...b, streak: { ...b.streak, firstFailedAt: '2026-06-26T00:00:00.000Z' } }]).id, first.id);
  assert.throws(() => backoff.sourceStreakGroupNotice([a, { ...b, spaceId: 'another-space' }]), /cannot cross Spaces/);
});
