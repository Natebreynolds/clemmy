/**
 * Run: npx tsx --test src/spaces/runner.test.ts
 *
 * Guards Space declaration validation, durable migration decisions, refresh
 * projection, and the release containment that keeps local runner/CLI bodies
 * zero-process until they are compiled into the shared durable call kernel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-runner-test-'));

const runner = await import('./runner.js');
const { seedLegacySpaceTrustApproval } = await import('./legacy-space-trust.fixture.js');
const store = await import('./store.js');
const dataStore = await import('./data-store.js');
const workspaceDb = await import('./workspace-db.js');
const runnerTrust = await import('./space-data-runner-trust.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const operationalTelemetry = await import('../runtime/operational-telemetry.js');
const capabilityCatalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const capabilityManifests = await import('../runtime/harness/capability-manifest.js');

const CURRENT_READ_OPERATION = 'PROOF_SPACE_RUNTIME_READ_CURRENT';
const CURRENT_WRITE_OPERATION = 'PROOF_SPACE_RUNTIME_WRITE_CURRENT';
const STALE_READ_OPERATION = 'PROOF_SPACE_RUNTIME_READ_STALE';
const UNREGISTERED_OPERATION = 'PROOF_SPACE_RUNTIME_READ_UNREGISTERED';

function installEffectFixture(
  operationId: string,
  effect: 'read' | 'external_write',
  lifecycle: 'current' | 'revoked' = 'current',
): void {
  const fingerprint = createHash('sha256')
    .update(`space-runner:${operationId}:${effect}`, 'utf8')
    .digest('hex');
  const manifest = capabilityManifests.attachSemanticContract({
    version: 1,
    manifestId: `manifest.space.runner.${operationId.toLowerCase()}`,
    providerKind: 'composio',
    operationId,
    providerIdentity: 'provider.space-runner-fixture',
    providerVersion: 'fixture.1',
    operationVersion: '1',
    definitionFingerprint: fingerprint,
    effect,
    accountId: 'account.space-runner-fixture',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: effect === 'read' ? 'read_bounded_records' : 'bounded_write',
    acceptedInputKinds: ['scope'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'space.runner.test', issuedAt: '2026-08-27T00:00:00.000Z', trusted: true },
    lifecycle: { state: lifecycle },
    advisoryRoles: [effect === 'read' ? 'source' : 'write'],
  });
  const factory = capabilityCatalogs.peekHostCapabilityCatalogFactory()
    ?? capabilityCatalogs.createHostCapabilityCatalogFactory();
  factory.register({
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    advisoryRoles: manifest.advisoryRoles,
    manifestDigest: capabilityManifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => { throw new Error('effect fixture must never own provider I/O'); },
  });
  capabilityCatalogs.installHostCapabilityCatalogFactory(factory);
}

installEffectFixture(CURRENT_READ_OPERATION, 'read');
installEffectFixture(CURRENT_WRITE_OPERATION, 'external_write');
installEffectFixture(STALE_READ_OPERATION, 'read', 'revoked');

test('importing the Workspace runner registers trust recovery without opening the event log', async () => {
  // Registration used to enqueue an unowned setImmediate scan. Besides making
  // imports mutate durable state, that callback could collide with a foreground
  // v55 migration. Boot recovery now has an explicit daemon-owned phase.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(existsSync(eventlog.HARNESS_DB_PATH), false);
});

function writeRunner(slug: string, file: string, body: string, exec = false): void {
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, file);
  writeFileSync(p, body, 'utf-8');
  if (exec) chmodSync(p, 0o755);
}

/** Reconstruct an old approved row without firing the resolution listener.
 * Historical trust cannot unlock the retired executor. */
async function approveInstalledRunnerFixture(
  slug: string,
  source: Parameters<typeof runner.runSpaceDataSource>[1],
): Promise<void> {
  const card = seedLegacySpaceTrustApproval(slug, source);
  eventlog.openEventLog().prepare(`
    UPDATE pending_approvals
       SET status = 'resolved', resolution = 'approved', resolver = ?, resolved_at = ?
     WHERE approval_id = ? AND status = 'pending'
  `).run('runner-fixture-trust', new Date().toISOString(), card.approvalId);
}

const hasPython = (() => {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

// A node runner that echoes its own env + the stdin payload back as JSON.
const ENV_ECHO_MJS = `
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const p = (() => { try { return JSON.parse(input || '{}'); } catch { return {}; } })();
  process.stdout.write(JSON.stringify({
    electron: process.env.ELECTRON_RUN_AS_NODE ?? null,
    slug: process.env.CLEMENTINE_SPACE_SLUG ?? null,
    lang: process.env.LANG ?? null,
    pathHasWellKnown: (process.env.PATH || '').split(':').some((d) => d === '/usr/local/bin' || d === '/opt/homebrew/bin'),
    sawSecret: process.env.SPACE_TEST_SECRET ?? null,
    payloadSlug: p.slug ?? null,
    payloadRunner: p.runner ?? null,
  }));
});
`;

test('node (.mjs) compatibility entrypoint is zero-body without shared durable authority', async () => {
  const slug = 'env-node';
  writeRunner(slug, 'echo.mjs', ENV_ECHO_MJS);
  // A daemon secret present at spawn time MUST NOT reach agent-authored code.
  process.env.SPACE_TEST_SECRET = 'leak-canary';
  try {
    const res = await runner.runScript(slug, 'echo.mjs');
    assert.equal(res.ok, false);
    assert.equal(res.ok ? undefined : res.provenNoDispatch, true);
    assert.match(res.ok ? '' : res.error, /no shared durable call authority/i);
  } finally {
    delete process.env.SPACE_TEST_SECRET;
  }
});

test('runner extras cannot turn the compatibility entrypoint into authority', async () => {
  const slug = 'payload-identity';
  writeRunner(slug, 'echo.mjs', ENV_ECHO_MJS);

  const res = await runner.runScript(slug, 'echo.mjs', {
    slug: '../other-space',
    runner: '../view/evil.mjs',
    customInput: true,
  });

  assert.equal(res.ok, false);
  assert.equal(res.ok ? undefined : res.provenNoDispatch, true);
  assert.match(res.ok ? '' : res.error, /no shared durable call authority/i);
});

test('shell (.sh) compatibility entrypoint is zero-body', async () => {
  const slug = 'env-sh';
  writeRunner(slug, 'echo.sh', `#!/bin/bash\nprintf '{"electron":"%s","slug":"%s"}' "\${ELECTRON_RUN_AS_NODE:-}" "$CLEMENTINE_SPACE_SLUG"\n`);
  const res = await runner.runScript(slug, 'echo.sh');
  assert.equal(res.ok, false);
  assert.equal(res.ok ? undefined : res.provenNoDispatch, true);
  assert.match(res.ok ? '' : res.error, /no shared durable call authority/i);
});

test('python (.py) compatibility entrypoint is zero-body', { skip: !hasPython }, async () => {
  const slug = 'env-py';
  writeRunner(slug, 'echo.py', `import json,os\nprint(json.dumps({"slug": os.environ.get("CLEMENTINE_SPACE_SLUG"), "rows": [1,2]}))\n`);
  const res = await runner.runScript(slug, 'echo.py');
  assert.equal(res.ok, false);
  assert.equal(res.ok ? undefined : res.provenNoDispatch, true);
  assert.match(res.ok ? '' : res.error, /no shared durable call authority/i);
});

test('runner output parsing is unreachable without shared durable authority', async () => {
  const slug = 'bad-json';
  writeRunner(slug, 'r.mjs', `process.stdout.write('not json at all');`);
  const res = await runner.runScript(slug, 'r.mjs');
  assert.equal(res.ok, false);
  assert.equal(res.ok ? undefined : res.provenNoDispatch, true);
  assert.match((res as { error: string }).error, /no shared durable call authority/i);
});

test('refreshSpaceData refuses malformed hand-written manifest JSON before running sources', async () => {
  const slug = 'bad-manifest-refresh';
  const dir = store.resolveSpaceDir(slug);
  mkdirSync(path.join(dir, 'data'), { recursive: true });
  writeFileSync(path.join(dir, 'data', 'r.mjs'), `process.stdout.write(JSON.stringify({rows:[1]}));`, 'utf-8');
  writeFileSync(path.join(dir, 'space.json'), JSON.stringify({
    id: slug,
    title: 'Bad Manifest Refresh',
    dataSources: [{ id: 'pull', runner: 'r.mjs', composio_args_json: '{not json' }],
  }), 'utf-8');

  const res = await runner.refreshSpaceData(slug, 'pull');
  assert.equal(res[0].ok, false);
  assert.match(res[0].error ?? '', /workspace manifest is invalid/);
  assert.match(res[0].error ?? '', /composio_args_json is not valid JSON/);
});

test('runtime refuses unsafe Composio sources and contains exact reads until shared durable authority exists', async () => {
  let dispatches = 0;
  runner._setSpaceComposioDispatchForTests(async (toolSlug, _args) => {
    dispatches += 1;
    return {
      ok: true as const,
      result: { toolSlug },
      connectionId: 'ca-proof',
      identity: 'proof@example.test',
    };
  });
  try {
    for (const composioSlug of [
      CURRENT_WRITE_OPERATION,
      STALE_READ_OPERATION,
      UNREGISTERED_OPERATION,
    ]) {
      const res = await runner.runSpaceDataSource('runtime-source-policy', {
        id: 'pull',
        composioSlug,
      });
      assert.equal(res.ok, false, `${composioSlug} must fail closed`);
      assert.match(res.ok ? '' : res.error, /provably read-only/i);
    }
    assert.equal(dispatches, 0, 'unsafe refresh declarations never cross the provider boundary');

    const read = await runner.runSpaceDataSource('runtime-source-policy', {
      id: 'events',
      composioSlug: CURRENT_READ_OPERATION,
    });
    assert.equal(read.ok, false);
    assert.match(read.ok ? '' : read.error, /no shared durable call authority/i);
    assert.equal(read.ok ? undefined : read.provenNoDispatch, true);
    assert.equal(dispatches, 0, 'an exact read has no raw Space-provider fallback');
  } finally {
    runner._setSpaceComposioDispatchForTests(null);
  }
});

test('runtime refuses opaque runner-backed data sources before spawning', async () => {
  const slug = 'runner-data-source-disabled';
  writeRunner(
    slug,
    'pull.mjs',
    `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./spawned.txt', import.meta.url), 'yes');
process.stdout.write('[]');`,
  );

  const res = await runner.runSpaceDataSource(slug, {
    id: 'pull',
    runner: 'pull.mjs',
  });

  assert.equal(res.ok, false);
  assert.match(res.ok ? '' : res.error, /opaque runner|read-only Composio/i);
  assert.equal(
    (await import('node:fs')).existsSync(store.resolveInSpace(slug, 'data/spawned.txt')),
    false,
  );
});

test('an installed legacy runner reports its missing executor without creating a futile card', async () => {
  const slug = 'legacy-runner-unavailable';
  const source = { id: 'pull', runner: 'pull.mjs', schedule: '0 7 * * *' };
  writeRunner(slug, source.runner, 'process.stdout.write("{}");');
  store.spaceStore.save({ id: slug, title: 'Legacy runner', dataSources: [source] });
  for (const options of [{}, { requestFreshTrustApproval: true }]) {
    const result = await runner.runSpaceDataSource(slug, source, options);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unexpected execution');
    assert.equal(result.provenNoDispatch, true);
    assert.equal(result.code, 'local_runner');
    assert.equal(result.pendingApprovalId, undefined);
    assert.match(result.error, /supported executor.*another approval cannot/i);
  }
  assert.equal(approvalRegistry.listPending({ sessionId: `space-${slug}`, status: 'any' }).length, 0);
  assert.equal(eventlog.listEvents(`space-${slug}`, { types: ['approval_requested'] }).length, 0);
});

test('daemon-owned runner-trust recovery consumes an offline decision without spawning', async () => {
  const slug = 'legacy-runner-trust-boot-recovery';
  const source = { id: 'pull', runner: 'pull.mjs' };
  writeRunner(
    slug,
    source.runner,
    `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./boot-recovered.txt', import.meta.url), 'yes');
process.stdout.write('{}');`,
  );
  store.spaceStore.save({
    id: slug,
    title: 'Legacy runner trust boot recovery',
    dataSources: [source],
  });

  const approvalId = seedLegacySpaceTrustApproval(slug, source, true).approvalId;

  // Simulate a decision committed by another process while the daemon and its
  // live resolution listener were offline.
  const resolvedAt = new Date().toISOString();
  eventlog.openEventLog().prepare(`
    UPDATE pending_approvals
       SET status = 'resolved', resolution = 'approved', resolver = ?, resolved_at = ?
     WHERE approval_id = ? AND status = 'pending'
  `).run('runner-trust-offline-test', resolvedAt, approvalId);

  assert.equal(runnerTrust.recoverResolvedRunnerTrustApprovals(), 1);
  assert.equal(approvalRegistry.get(approvalId!)?.consumedAt !== null, true);
  assert.equal(runnerTrust.recoverResolvedRunnerTrustApprovals(), 0, 'the durable resume claim is one-shot');

  const recoveredPath = store.resolveInSpace(slug, 'data/boot-recovered.txt');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(existsSync(recoveredPath), false);
});

test('unsupported frozen CLI sources never ask for trust, including drift and missing binaries', async () => {
  const slug = 'cli-source-unavailable';
  const sentinel = path.join(process.env.CLEMENTINE_HOME!, 'unsupported-cli-executed');
  const source = { id: 'pull', cliArgv: ['node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'bad')`] };
  for (const declaration of [source, { ...source, schedule: '*/5 * * * *' }, { ...source, cliArgv: ['definitely-not-installed', '--version'] }]) {
    store.spaceStore.save({ id: slug, title: 'CLI unavailable', dataSources: [declaration] });
    const result = await runner.runSpaceDataSource(slug, declaration, { requestFreshTrustApproval: true });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unexpected execution');
    assert.equal(result.code, 'local_command');
    assert.equal(result.provenNoDispatch, true);
    assert.equal(result.pendingApprovalId, undefined);
    assert.match(result.error, /another approval cannot/i);
    assert.equal(approvalRegistry.listPending({ sessionId: `space-${slug}`, status: 'any' }).length, 0);
  }
  const tampered = await runner.runSpaceDataSource(slug, source);
  assert.equal(tampered.ok, false);
  assert.match(tampered.ok ? '' : tampered.error, /does not exactly match its installed CLI declaration/i);
  assert.equal(existsSync(sentinel), false);
});

test('a pinned legacy entrypoint digest does not unlock the retired raw runner', async () => {
  const slug = 'verified-entrypoint-contained';
  const file = 'pull.mjs';
  writeRunner(slug, file, "process.stdout.write('{}');");
  const target = store.resolveInSpace(slug, `data/${file}`);
  const expectedSha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
  const result = await runner.runScript(slug, file, undefined, { expectedSha256 });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.provenNoDispatch, true);
  assert.match(result.ok ? '' : result.error, /no shared durable call authority/i);
});

test('runner-trust resolution reports once while both approval and rejection remain zero-process', async () => {
  for (const resolution of ['approved', 'rejected'] as const) {
    const slug = `legacy-runner-trust-note-${resolution}`;
    const source = { id: 'pull', runner: 'pull.mjs' };
    writeRunner(
      slug,
      'pull.mjs',
      `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./decision-spawned.txt', import.meta.url), 'yes');
process.stdout.write('{}');`,
    );
    store.spaceStore.save({
      id: slug,
      title: `Legacy runner trust note ${resolution}`,
      dataSources: [source],
    });

    const approvalId = seedLegacySpaceTrustApproval(slug, source, true).approvalId;
    assert.equal(approvalRegistry.resolve(approvalId, resolution, 'runner-trust-note-test').ok, true);

    const spawnedPath = store.resolveInSpace(slug, 'data/decision-spawned.txt');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const current = dataStore.readData(slug) as {
      _meta?: { pull?: {
        status?: string;
        approvalId?: string;
        approvalResolution?: string;
        approvalResolvedAt?: string;
        error?: string;
      } };
    };
    assert.equal(
      (await import('node:fs')).existsSync(spawnedPath),
      false,
      'neither a trust approval nor rejection carries process authority',
    );
    const note = dataStore.listNotes(slug).find((item) => (
      item.meta?.approvalId === approvalId && item.meta?.status === resolution
    ));
    assert.ok(note);
    assert.equal(note.meta?.status, resolution);
    if (resolution === 'approved') {
      assert.equal((current._meta?.pull as { ok?: boolean } | undefined)?.ok, false);
      assert.equal(approvalRegistry.get(approvalId)?.consumedAt !== null, true);
      assert.match(note.text, /refresh.*resum/i);
      const outcome = eventlog.listEvents(`space-${slug}`, {
        types: ['user_input_received'],
      }).find((event) => (
        event.data.synthetic === true
        && event.data.source === 'outcome'
        && event.data.sourceLabel === 'workspace refresh'
        && event.data.sourceId === `${approvalId}:${source.id}`
      ));
      assert.ok(outcome, 'Workspace refresh reports through the unified async Outcome edge');
      assert.equal(outcome.data.status, 'failed');
      assert.match(String(outcome.data.text ?? ''), /could not refresh|activity log/i);
      assert.equal(
        eventlog.listEvents(`space-${slug}`, { types: ['conversation_completed'] })
          .some((event) => event.data.approvalId === approvalId),
        false,
        'async approval work never fabricates a foreground turn terminal',
      );
    } else {
      assert.equal(current._meta?.pull?.status, 'error');
      assert.equal(current._meta?.pull?.approvalId, approvalId);
      assert.equal(current._meta?.pull?.approvalResolution, 'rejected');
      assert.match(current._meta?.pull?.approvalResolvedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
      assert.match(current._meta?.pull?.error ?? '', /You declined approval .* on \d{4}-\d{2}-\d{2}.*not executed/i);
      assert.equal(note.meta?.staleDataStatus, true);
      assert.match(note.text, /You declined approval .*not executed/i);
      assert.equal(
        workspaceDb.listWorkspaceDatasetObservations(slug, {
          sourceKey: source.id,
          limit: 10,
        }).some((observation) => observation.status === 'awaiting_approval'),
        false,
      );
    }
  }
});

test('contained approved refresh reports a safe async Outcome without entering runner diagnostics', async () => {
  const slug = 'legacy-runner-trust-safe-failure';
  const source = { id: 'pull', runner: 'pull.mjs' };
  writeRunner(
    slug,
    source.runner,
    `process.stderr.write('provider-secret-diagnostic'); process.exit(7);`,
  );
  store.spaceStore.save({
    id: slug,
    title: 'Legacy runner safe failure',
    dataSources: [source],
  });

  const approvalId = seedLegacySpaceTrustApproval(slug, source, true).approvalId;
  assert.equal(approvalRegistry.resolve(approvalId!, 'approved', 'safe-failure-test').ok, true);

  let outcome: ReturnType<typeof eventlog.listEvents>[number] | undefined;
  // The process-wide corpus runs many child-process suites concurrently; the
  // approved runner can be scheduler-starved even though the async outcome is
  // healthy. This is a polling guard, not a three-second product SLA.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    outcome = eventlog.listEvents(`space-${slug}`, { types: ['user_input_received'] })
      .find((event) => (
        event.data.synthetic === true
        && event.data.source === 'outcome'
        && event.data.sourceId === `${approvalId}:${source.id}`
      ));
    if (outcome) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(outcome);
  assert.equal(outcome.data.status, 'failed');
  assert.match(String(outcome.data.text ?? ''), /activity log for technical details/i);
  assert.match(String(outcome.data.text ?? ''), /needs a supported executor/i);
  assert.doesNotMatch(String(outcome.data.text ?? ''), /then (?:try again|retry)/i);
  assert.doesNotMatch(String(outcome.data.text ?? ''), /provider-secret-diagnostic/);
  assert.equal(
    eventlog.listEvents(`space-${slug}`, { types: ['conversation_completed'] })
      .some((event) => event.data.approvalId === approvalId),
    false,
  );
  const diagnostics = operationalTelemetry.listOperationalEvents({
    source: 'workspace',
    type: 'workspace_data_refresh_failed',
    workspaceId: slug,
    limit: 20,
  });
  assert.ok(
    diagnostics.every((event) => !JSON.stringify(event.payload).includes('provider-secret-diagnostic')),
    'runner-controlled diagnostics are impossible because the body never starts',
  );
});

test('an expired historical card stays expired and cannot be renewed into a missing executor', async () => {
  const slug = 'legacy-expired-no-renewal';
  const source = { id: 'pull', runner: 'pull.mjs' };
  writeRunner(slug, source.runner, 'process.stdout.write("{}");');
  store.spaceStore.save({ id: slug, title: 'Expired', dataSources: [source] });
  const card = seedLegacySpaceTrustApproval(slug, source);
  eventlog.openEventLog().prepare('UPDATE pending_approvals SET expires_at = ? WHERE approval_id = ?')
    .run('2000-01-01T00:00:00.000Z', card.approvalId);
  for (const requestFreshTrustApproval of [false, true]) {
    const result = await runner.runSpaceDataSource(slug, source, { requestFreshTrustApproval });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /expired.*another approval/i);
    assert.equal(approvalRegistry.listPending({ sessionId: `space-${slug}`, status: 'pending' }).length, 0);
  }
  assert.equal(approvalRegistry.get(card.approvalId)?.resolution, 'expired');
  assert.equal(approvalRegistry.listPending({ sessionId: `space-${slug}`, status: 'any' }).length, 1);
});

test('retiring a historical pending card closes its waiting observation and does not touch another source', async () => {
  const slug = 'legacy-pending-retirement';
  const source = { id: 'pull', runner: 'pull.mjs' };
  const sibling = { id: 'other', runner: 'other.mjs' };
  writeRunner(slug, source.runner, 'process.stdout.write("{}");');
  writeRunner(slug, sibling.runner, 'process.stdout.write("{}");');
  store.spaceStore.save({ id: slug, title: 'Pending', dataSources: [source, sibling] });
  const card = seedLegacySpaceTrustApproval(slug, source, true);
  const other = seedLegacySpaceTrustApproval(slug, sibling, true);
  await runner.runSpaceDataSource(slug, source);
  assert.equal(approvalRegistry.get(card.approvalId)?.resolution, 'cancelled_by_system');
  assert.equal(approvalRegistry.get(other.approvalId)?.status, 'pending');
  const observations = workspaceDb.listWorkspaceDatasetObservations(slug, { sourceKey: source.id, limit: 10 });
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.status, 'error');
  assert.equal(observations[0]?.provenance.approvalId, card.approvalId);
  const before = JSON.stringify(dataStore.listNotes(slug));
  await runner.runSpaceDataSource(slug, source);
  assert.equal(JSON.stringify(dataStore.listNotes(slug)), before, 'retirement is idempotent');
});

test('runner entrypoint and schedule drift cannot reuse a grant or generate a new futile card', async () => {
  const slug = 'legacy-runner-drift';
  const source = { id: 'pull', runner: 'pull.mjs', schedule: '0 7 * * *' };
  writeRunner(slug, source.runner, 'process.stdout.write("{}");');
  store.spaceStore.save({ id: slug, title: 'Drift', dataSources: [source] });
  await approveInstalledRunnerFixture(slug, source);
  const sentinel = store.resolveInSpace(slug, 'data/should-not-execute');
  writeRunner(slug, source.runner, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'bad');`);
  for (const current of [source, { ...source, schedule: '*/5 * * * *' }]) {
    store.spaceStore.update(slug, { dataSources: [current] });
    const result = await runner.runSpaceDataSource(slug, current);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /no shared durable call authority/i);
    assert.equal(approvalRegistry.listPending({ sessionId: `space-${slug}`, status: 'pending' }).length, 0);
  }
  assert.equal(existsSync(sentinel), false);
  assert.equal(approvalRegistry.listPending({ sessionId: `space-${slug}`, status: 'any' }).length, 1);
});

test('runner-backed actions cannot execute without approval authority', async () => {
  const slug = 'runner-action-needs-approval';
  writeRunner(
    slug,
    'act.mjs',
    `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./dispatched.txt', import.meta.url), 'yes');
process.stdout.write(JSON.stringify({ok:true}));`,
  );

  const res = await runner.runSpaceAction(
    slug,
    { id: 'refresh-looking-name', label: 'Refresh rows', runner: 'act.mjs' },
    {},
  );

  assert.equal(res.ok, false);
  assert.match(res.ok ? '' : res.error, /approval/i);
  assert.equal(
    (await import('node:fs')).existsSync(store.resolveInSpace(slug, 'data/dispatched.txt')),
    false,
    'an opaque runner is never launched on the immediate path',
  );
});

test('Composio actions require approval when applicable and shared durable authority in every case', async () => {
  let dispatches = 0;
  runner._setSpaceComposioDispatchForTests(async (toolSlug, _args) => {
    dispatches += 1;
    return {
      ok: true as const,
      result: { toolSlug },
      connectionId: 'ca-proof',
      identity: 'proof@example.test',
    };
  });
  try {
    for (const composioSlug of [
      CURRENT_WRITE_OPERATION,
      STALE_READ_OPERATION,
      UNREGISTERED_OPERATION,
    ]) {
      const res = await runner.runSpaceAction(
        'runtime-action-policy',
        { id: 'act', composioSlug },
        {},
      );
      assert.equal(res.ok, false, `${composioSlug} must require approval`);
      assert.match(res.ok ? '' : res.error, /approval/i);
    }
    assert.equal(dispatches, 0);

    const read = await runner.runSpaceAction(
      'runtime-action-policy',
      { id: 'list', composioSlug: CURRENT_READ_OPERATION },
      {},
    );
    assert.equal(read.ok, false);
    assert.match(read.ok ? '' : read.error, /no shared durable call authority/i);
    assert.equal(read.ok ? undefined : read.provenNoDispatch, true);
    assert.equal(dispatches, 0);
  } finally {
    runner._setSpaceComposioDispatchForTests(null);
  }
});

test('concurrent same-space local refreshes both remain contained without projecting runner data', async () => {
  const slug = 'refresh-serial';
  const alphaSource = { id: 'alpha', runner: 'alpha.mjs' };
  const betaSource = { id: 'beta', runner: 'beta.mjs' };
  store.spaceStore.save({
    id: slug,
    title: 'Refresh Serial',
    dataSources: [alphaSource, betaSource],
  });
  writeRunner(slug, alphaSource.runner, `setTimeout(() => process.stdout.write(JSON.stringify({rows:[{id:'alpha'}]})), 80);`);
  writeRunner(slug, betaSource.runner, `setTimeout(() => process.stdout.write(JSON.stringify({rows:[{id:'beta'}]})), 20);`);
  await approveInstalledRunnerFixture(slug, alphaSource);
  await approveInstalledRunnerFixture(slug, betaSource);
  try {
    const [alpha, beta] = await Promise.all([
      runner.refreshSpaceData(slug, 'alpha'),
      runner.refreshSpaceData(slug, 'beta'),
    ]);

    assert.equal(alpha[0].ok, false);
    assert.equal(beta[0].ok, false);
    assert.match(alpha[0].error ?? '', /no shared durable call authority/i);
    assert.match(beta[0].error ?? '', /no shared durable call authority/i);
    const data = dataStore.readData(slug) as Record<string, unknown>;
    assert.equal(Object.hasOwn(data, 'alpha'), false);
    assert.equal(Object.hasOwn(data, 'beta'), false);
    assert.equal((data._meta as Record<string, { ok?: boolean }>).alpha.ok, false);
    assert.equal((data._meta as Record<string, { ok?: boolean }>).beta.ok, false);
  } finally {
    runner._resetSpaceRefreshQueuesForTest();
  }
});

test('contained sibling sources persist bounded error observations and retry without duplicates', async () => {
  const slug = 'refresh-partial-batch';
  const smallSource = { id: 'small', runner: 'small.mjs' };
  const oversizedSource = { id: 'oversized', runner: 'oversized.mjs' };
  store.spaceStore.save({
    id: slug,
    title: 'Refresh Partial Batch',
    dataSources: [smallSource, oversizedSource],
  });
  writeRunner(slug, smallSource.runner, `process.stdout.write(JSON.stringify({rows:[{id:'kept',value:42}]}));`);
  writeRunner(slug, oversizedSource.runner, `process.stdout.write(JSON.stringify({payload:'x'.repeat(6*1024*1024)}));`);
  await approveInstalledRunnerFixture(slug, smallSource);
  await approveInstalledRunnerFixture(slug, oversizedSource);
  try {
    for (const batchId of ['partial-batch-first', 'partial-batch-retry']) {
      const results = await runner.refreshSpaceData(slug, undefined, {
        cause: 'scheduled',
        refreshId: 'stable-refresh',
        batchId,
      });
      assert.equal(results.length, 2);
      assert.equal(results[0]?.sourceId, 'small');
      assert.equal(results[0]?.ok, false);
      assert.match(results[0]?.error ?? '', /no shared durable call authority/i);
      assert.equal(results[1]?.sourceId, 'oversized');
      assert.equal(results[1]?.ok, false);
      assert.match(results[1]?.error ?? '', /no shared durable call authority/i);
      assert.equal(
        results.every((result) => result.write?.ok === true),
        true,
        JSON.stringify(results),
      );
    }

    const data = dataStore.readData(slug) as Record<string, unknown>;
    assert.equal(Object.hasOwn(data, 'small'), false);
    assert.equal(Object.hasOwn(data, 'oversized'), false);
    assert.equal(
      (data._meta as Record<string, { ok?: boolean | null }>).small.ok,
      false,
    );
    assert.equal(
      (data._meta as Record<string, { ok?: boolean | null }>).oversized.ok,
      false,
    );
    assert.equal(
      workspaceDb.listWorkspaceDatasetObservations(slug, {
        sourceKey: 'small',
        limit: 10,
      }).length,
      1,
      'contained source retry reuses its durable error observation',
    );
    const oversized = workspaceDb.listWorkspaceDatasetObservations(slug, {
      sourceKey: 'oversized',
      limit: 10,
    });
    assert.equal(oversized.length, 1, 'contained sibling retry reuses its error observation');
    assert.equal(oversized[0]?.status, 'error');
  } finally {
    runner._resetSpaceRefreshQueuesForTest();
  }
});

test('contained refresh preserves a 2.7.5 baseline and dedupes its error observation', async () => {
  const slug = 'refresh-temporal-baseline';
  const source = { id: 'campaigns', runner: 'campaigns.mjs' };
  store.spaceStore.save({
    id: slug,
    title: 'Refresh Temporal Baseline',
    dataSources: [source],
  });
  const legacy = {
    campaigns: { rows: [{ id: 'campaign-1', spend: 10, status: 'active' }] },
    _meta: { campaigns: { refreshedAt: '2026-06-01T00:00:00.000Z', ok: true } },
  };
  assert.equal(dataStore.writeData(slug, legacy).ok, true);

  writeRunner(slug, source.runner, `process.stdout.write(JSON.stringify({rows:[{id:'campaign-1',spend:15,status:'paused'}]}));`);
  await approveInstalledRunnerFixture(slug, source);
  try {
    const first = await runner.refreshSpaceData(slug, 'campaigns', {
      cause: 'manual',
      refreshId: 'manual-refresh-1',
      batchId: 'manual-batch-1',
    });
    assert.equal(first[0]?.ok, false);
    assert.match(first[0]?.error ?? '', /no shared durable call authority/i);
    assert.match(first[0]?.observationId ?? '', /^[a-f0-9-]{36}$/i);

    const afterFirst = workspaceDb.listWorkspaceDatasetObservations(slug, {
      sourceKey: 'campaigns',
      limit: 10,
    });
    assert.equal(afterFirst.length, 2);
    assert.equal(afterFirst[0]?.cause, 'manual');
    assert.equal(afterFirst[0]?.status, 'error');
    assert.equal(afterFirst[1]?.cause, 'legacy_import');
    assert.equal(afterFirst[0]?.previousObservationId, afterFirst[1]?.id);
    assert.deepEqual(
      (dataStore.readData(slug) as { campaigns?: unknown }).campaigns,
      legacy.campaigns,
      'the last successful projection remains visible during containment',
    );

    const same = await runner.refreshSpaceData(slug, 'campaigns', {
      cause: 'manual',
      refreshId: 'manual-refresh-2',
      batchId: 'manual-batch-2',
    });
    assert.equal(same[0]?.ok, false);
    const replay = await runner.refreshSpaceData(slug, 'campaigns', {
      cause: 'manual',
      refreshId: 'manual-refresh-2',
      batchId: 'manual-batch-replayed',
    });
    assert.equal(replay[0]?.ok, false);
    assert.equal(replay[0]?.observationId, same[0]?.observationId);
    assert.equal(
      workspaceDb.listWorkspaceDatasetObservations(slug, {
        sourceKey: 'campaigns',
        limit: 10,
      }).length,
      3,
      'same refresh identity reuses its observation after restart/retry',
    );
  } finally {
    runner._resetSpaceRefreshQueuesForTest();
  }
});

test('refreshSpaceData does not advance lastRefreshedAt when every source fails', async () => {
  const slug = 'refresh-failed-stamp';
  const oldSuccess = '2026-06-01T00:00:00.000Z';
  store.spaceStore.save({
    id: slug,
    title: 'Refresh Failed Stamp',
    dataSources: [{ id: 'bad', runner: 'bad.mjs' }],
  });
  store.spaceStore.update(slug, { lastRefreshedAt: oldSuccess });
  writeRunner(slug, 'bad.mjs', `process.stderr.write('source broke'); process.exit(2);`);
  const res = await runner.refreshSpaceData(slug);

  assert.equal(res[0].ok, false);
  assert.equal(store.spaceStore.get(slug)?.lastRefreshedAt, oldSuccess);
  const data = dataStore.readData(slug) as Record<string, unknown>;
  assert.equal(((data._meta as Record<string, { ok?: boolean }>).bad).ok, false);
  runner._resetSpaceRefreshQueuesForTest();
});

test('no-output runner is contained before output handling', async () => {
  const slug = 'no-output';
  writeRunner(slug, 'r.mjs', `process.exit(0);`);
  const res = await runner.runScript(slug, 'r.mjs');
  assert.equal(res.ok, false);
  assert.equal(res.ok ? undefined : res.provenNoDispatch, true);
  assert.match((res as { error: string }).error, /no shared durable call authority/i);
});

test('non-zero runner is contained before its stderr can execute', async () => {
  const slug = 'nonzero';
  writeRunner(slug, 'r.mjs', `process.stderr.write('boom happened'); process.exit(3);`);
  const res = await runner.runScript(slug, 'r.mjs');
  assert.equal(res.ok, false);
  assert.equal(res.ok ? undefined : res.provenNoDispatch, true);
  assert.match((res as { error: string }).error, /no shared durable call authority/i);
  assert.doesNotMatch((res as { error: string }).error, /boom happened/);
});

test('an otherwise valid legacy filename is contained before interpreter selection', async () => {
  const slug = 'bad-ext';
  writeRunner(slug, 'data.txt', `whatever`);
  const res = await runner.runScript(slug, 'data.txt');
  assert.equal(res.ok, false);
  assert.equal(res.ok ? undefined : res.provenNoDispatch, true);
  assert.match((res as { error: string }).error, /no shared durable call authority/i);
});

test('runner path traversal is refused even if the target file exists inside the workspace', async () => {
  const slug = 'runner-path-traversal';
  const viewDir = store.resolveInSpace(slug, 'view');
  mkdirSync(viewDir, { recursive: true });
  writeFileSync(path.join(viewDir, 'evil.mjs'), `process.stdout.write(JSON.stringify({ran:true}));`, 'utf-8');

  const res = await runner.runScript(slug, '../view/evil.mjs');

  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /runner must be a filename under data\//);
});

test('a frozen CLI source that is a reviewed read is compiled into its operation and redeemed at the shared kernel door', async () => {
  const { CLI_CATALOG } = await import('../integrations/cli-catalog/catalog.js');
  const entry = CLI_CATALOG.find((candidate) => candidate.reviewedRead);
  assert.ok(entry?.reviewedRead);
  const reviewed = entry.reviewedRead;
  const required = reviewed.arguments.find((argument) => argument.required)!;
  const head = [entry.command, ...reviewed.argvPrefix.filter((token) => !token.startsWith('-'))];
  const argv = [...head, required.token, 'SELECT Id FROM Opportunity LIMIT 5', ...reviewed.argvPrefix.filter((token) => token.startsWith('-'))];

  const slug = 'cli-source-reviewed-read';
  const source = { id: 'opportunities', cliArgv: argv };
  store.spaceStore.save({ id: slug, title: 'Reviewed read source', dataSources: [source] });

  // A reviewed read needs execution authority, never an unrelated trust card.
  const approved = await runner.runSpaceDataSource(slug, source);
  assert.equal(approved.ok, false);
  assert.equal(approved.ok ? undefined : approved.provenNoDispatch, true);
  assert.match(
    approved.ok ? '' : approved.error,
    new RegExp(`refresh "${reviewed.operationId}" is unavailable: no shared durable call authority`),
  );
  assert.doesNotMatch(approved.ok ? '' : approved.error, /local CLI/);

  // A line the reviewed read cannot carry is refused by the exact token.
  const stray = { id: 'stray', cliArgv: [...head, required.token, 'SELECT Id FROM Lead', '--result-format', 'csv'] };
  store.spaceStore.save({ id: slug, title: 'Reviewed read source', dataSources: [source, stray] });
  const refused = await runner.runSpaceDataSource(slug, stray);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok ? undefined : refused.provenNoDispatch, true);
  assert.match(refused.ok ? '' : refused.error, new RegExp(`names the reviewed read ${reviewed.operationId} but cannot be carried by it: option "--result-format"`));
  assert.equal(approvalRegistry.listPending({ sessionId: `space-${slug}`, status: 'any' }).length, 0);
});

test('a newly reviewed CLI read does not erase an older explicit denial', async () => {
  const { CLI_CATALOG } = await import('../integrations/cli-catalog/catalog.js');
  const entry = CLI_CATALOG.find(candidate => candidate.reviewedRead)!;
  const reviewed = entry.reviewedRead!;
  const required = reviewed.arguments.find(argument => argument.required)!;
  const source = { id: 'rows', cliArgv: [entry.command, ...reviewed.argvPrefix, required.token, 'SELECT Id FROM Opportunity LIMIT 5'] };
  const slug = 'reviewed-read-historical-denial';
  store.spaceStore.save({ id: slug, title: 'Historical denial', dataSources: [source] });
  const card = seedLegacySpaceTrustApproval(slug, source, true);
  assert.equal(approvalRegistry.resolve(card.approvalId, 'rejected', 'owner-fixture').ok, true);
  const before = JSON.stringify(approvalRegistry.get(card.approvalId));
  for (const requestFreshTrustApproval of [false, true]) {
    const result = await runner.runSpaceDataSource(slug, source, { requestFreshTrustApproval });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /You declined approval/);
    assert.equal(JSON.stringify(approvalRegistry.get(card.approvalId)), before);
  }
  assert.equal(approvalRegistry.listPending({ sessionId: `space-${slug}`, status: 'any' }).length, 1);
});

test('a reviewed read stores what the command produced: parsed JSON on a clean exit, a named failure otherwise', () => {
  const ESC = String.fromCharCode(27);
  const envelope = {
    version: 1,
    status: 'exited',
    operationId: 'salesforce_sf_soql_query',
    executableRealpath: '/usr/local/lib/sf/bin/sf',
    argv: ['data', 'query', '--json', '--query', 'SELECT Id FROM Opportunity'],
    exitCode: 0,
    signal: null,
    stdout: '{"status":0,"result":{"records":[{"Id":"006"}],"totalSize":1,"done":true}}',
    stderr: ` >   Warning: ${ESC}[92mupdate available${ESC}[39m\n`,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
  // The kernel hands the carrier envelope back wrapped; the Space keeps the payload.
  const clean = runner.reviewedCliSourceResult({ ok: true, data: { complete: true, result: envelope } });
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.ok ? clean.data : null, { status: 0, result: { records: [{ Id: '006' }], totalSize: 1, done: true } });

  // A non-zero exit is a failed refresh that names the exit and the stderr tail, ANSI stripped.
  const failed = runner.reviewedCliSourceResult({
    ok: true,
    data: { complete: true, result: { ...envelope, status: 'nonzero_exit', exitCode: 1, stderr: `${ESC}[31mERROR${ESC}[39m: No default org found` } },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.ok ? '' : failed.error, 'reviewed read salesforce_sf_soql_query nonzero_exit (exit 1): ERROR: No default org found');

  // Anything that is not the carrier envelope passes through unchanged.
  const composio = runner.reviewedCliSourceResult({ ok: true, data: { complete: true, result: { data: { value: [] } } } });
  assert.deepEqual(composio, { ok: true, data: { complete: true, result: { data: { value: [] } } } });
  const refused = runner.reviewedCliSourceResult({ ok: false, error: 'refused', provenNoDispatch: true });
  assert.deepEqual(refused, { ok: false, error: 'refused', provenNoDispatch: true });
});
