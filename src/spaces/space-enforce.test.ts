/**
 * Run: npx tsx --test src/spaces/space-enforce.test.ts
 *
 * The Space authoring-reliability gate (mirror of workflow-enforce tests):
 * auto-repair preserves intent, validation blocks real runtime failures, and a
 * clean thin Space passes untouched. Temp CLEMENTINE_HOME so runner-file checks
 * resolve against a scratch dir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-enforce-test-'));

const enforce = await import('./space-enforce.js');
const store = await import('./store.js');
const capabilityCatalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const capabilityManifests = await import('../runtime/harness/capability-manifest.js');

const CURRENT_READ_OPERATION = 'PROOF_SPACE_AUTHORING_READ_CURRENT';
const CURRENT_WRITE_OPERATION = 'PROOF_SPACE_AUTHORING_WRITE_CURRENT';
const STALE_READ_OPERATION = 'PROOF_SPACE_AUTHORING_READ_STALE';
const UNREGISTERED_OPERATION = 'PROOF_SPACE_AUTHORING_READ_UNREGISTERED';

function installEffectFixture(
  operationId: string,
  effect: 'read' | 'external_write',
  lifecycle: 'current' | 'revoked' = 'current',
): void {
  const fingerprint = createHash('sha256')
    .update(`space-enforce:${operationId}:${effect}`, 'utf8')
    .digest('hex');
  const manifest = capabilityManifests.attachSemanticContract({
    version: 1,
    manifestId: `manifest.space.enforce.${operationId.toLowerCase()}`,
    providerKind: 'composio',
    operationId,
    providerIdentity: 'provider.space-enforce-fixture',
    providerVersion: 'fixture.1',
    operationVersion: '1',
    definitionFingerprint: fingerprint,
    effect,
    accountId: 'account.space-enforce-fixture',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: effect === 'read' ? 'read_bounded_records' : 'bounded_write',
    acceptedInputKinds: ['scope'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'space.enforce.test', issuedAt: '2026-08-27T00:00:00.000Z', trusted: true },
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

function writeRunner(slug: string, file: string) {
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), 'process.stdout.write("{}")', 'utf-8');
}

test('clean thin space passes untouched (no repairs, no errors)', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'clean',
    dataSources: [{ id: 'pull', composioSlug: CURRENT_READ_OPERATION }],
    actions: [],
  });
  assert.equal(prep.ok, true);
  assert.equal(prep.repairs.length, 0);
  assert.equal(prep.errors.length, 0);
});

test('prepare rejects ambiguous identities before a caller can smoke, refresh, or dispatch', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'identity-gate',
    dataSources: [
      { id: '   ', composioSlug: CURRENT_READ_OPERATION },
      { id: ' pull', composioSlug: CURRENT_READ_OPERATION },
      { id: 'pull', composioSlug: CURRENT_READ_OPERATION },
      { id: 'pull', composioSlug: CURRENT_READ_OPERATION },
      { id: '_meta', composioSlug: CURRENT_READ_OPERATION },
      { id: 'x'.repeat(121), composioSlug: CURRENT_READ_OPERATION },
      { id: 'control\u0001source', composioSlug: CURRENT_READ_OPERATION },
    ],
    actions: [
      { id: '', composioSlug: CURRENT_WRITE_OPERATION },
      { id: 'send ', composioSlug: CURRENT_WRITE_OPERATION },
      { id: 'send', composioSlug: CURRENT_WRITE_OPERATION },
      { id: 'send', composioSlug: CURRENT_WRITE_OPERATION },
      { id: 'y'.repeat(121), composioSlug: CURRENT_WRITE_OPERATION },
      { id: 'control\u0001action', composioSlug: CURRENT_WRITE_OPERATION },
    ],
  });
  assert.equal(prep.ok, false);
  const errors = prep.errors.join('\n');
  assert.match(errors, /Data source .*non-whitespace/i);
  assert.match(errors, /Data source .*leading or trailing whitespace/i);
  assert.match(errors, /Duplicate data source id "pull"/i);
  assert.match(errors, /reserved id "_meta"/i);
  assert.match(errors, /Data source .*120 character/i);
  assert.match(errors, /Data source .*control character/i);
  assert.match(errors, /Action .*non-whitespace/i);
  assert.match(errors, /Action .*leading or trailing whitespace/i);
  assert.match(errors, /Duplicate action id "send"/i);
  assert.match(errors, /Action .*120 character/i);
  assert.match(errors, /Action .*control character/i);
});

test('prepare preserves valid prototype-shaped source and action identities', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'identity-prototype',
    dataSources: [
      { id: '__proto__', composioSlug: CURRENT_READ_OPERATION },
      { id: 'constructor', composioSlug: CURRENT_READ_OPERATION },
      { id: 'prototype', composioSlug: CURRENT_READ_OPERATION },
    ],
    actions: [
      { id: '__proto__', composioSlug: CURRENT_WRITE_OPERATION },
      { id: 'constructor', composioSlug: CURRENT_WRITE_OPERATION },
      { id: 'prototype', composioSlug: CURRENT_WRITE_OPERATION },
    ],
  });
  assert.equal(prep.ok, true, prep.errors.join('\n'));
  assert.deepEqual(
    prep.dataSources.map((source) => source.id),
    ['__proto__', 'constructor', 'prototype'],
  );
  assert.deepEqual(
    prep.actions.map((action) => action.id),
    ['__proto__', 'constructor', 'prototype'],
  );
});

test('auto-repair coerces confirm:true on a send-like action', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'sendy',
    dataSources: [],
    actions: [{ id: 'write_record', label: 'Write record', composioSlug: CURRENT_WRITE_OPERATION }],
  });
  assert.equal(prep.ok, true);
  assert.equal(prep.actions[0].confirm, true);
  assert.match(prep.repairs.join(' '), /confirm:true/);
});

test('auto-repair marks every opaque runner action as approval-required', () => {
  writeRunner('local-approval', 'approve-post.mjs');
  const prep = enforce.prepareSpaceForWrite({
    slug: 'local-approval',
    dataSources: [],
    actions: [{
      id: 'approve_post',
      label: 'Approve locally',
      runner: 'approve-post.mjs',
      argsTemplate: { external: false },
      confirm: false,
    }],
  });
  assert.equal(prep.ok, true);
  assert.equal(prep.actions[0].confirm, true);
  assert.equal(prep.repairs.some((repair) => /confirm:true/.test(repair)), true);
});

test('auto-repair drops a bad timezone (keeps the source)', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'tz',
    dataSources: [{ id: 'pull', composioSlug: CURRENT_READ_OPERATION, schedule: '0 7 * * *', timezone: 'Mars/Phobos' }],
    actions: [],
  });
  assert.equal(prep.ok, true);
  assert.equal(prep.dataSources[0].timezone, undefined);
  assert.match(prep.repairs.join(' '), /invalid timezone/i);
});

test('auto-repair drops a redundant runner when both backends are declared', () => {
  writeRunner('both', 'r.mjs');
  const prep = enforce.prepareSpaceForWrite({
    slug: 'both',
    dataSources: [],
    actions: [{ id: 'act', composioSlug: CURRENT_WRITE_OPERATION, runner: 'r.mjs' }],
  });
  assert.equal(prep.actions[0].runner, undefined);
  assert.equal(prep.actions[0].composioSlug, CURRENT_WRITE_OPERATION);
});

test('auto-repair drops a redundant data-source runner when both backends are declared', () => {
  writeRunner('both-source', 'r.mjs');
  const prep = enforce.prepareSpaceForWrite({
    slug: 'both-source',
    dataSources: [{ id: 'pull', composioSlug: CURRENT_READ_OPERATION, runner: 'r.mjs' }],
    actions: [],
  });
  assert.equal(prep.ok, true);
  assert.equal(prep.dataSources[0].runner, undefined);
  assert.equal(prep.dataSources[0].composioSlug, CURRENT_READ_OPERATION);
  assert.match(prep.repairs.join(' '), /Data source "pull".*dropped the runner/);
});

test('Composio data sources must be provably read-only at authoring time', () => {
  const read = enforce.prepareSpaceForWrite({
    slug: 'read-source',
    dataSources: [{ id: 'events', composioSlug: CURRENT_READ_OPERATION }],
    actions: [],
  });
  assert.equal(read.ok, true, read.errors.join('\n'));

  for (const composioSlug of [
    CURRENT_WRITE_OPERATION,
    STALE_READ_OPERATION,
    UNREGISTERED_OPERATION,
  ]) {
    const unsafe = enforce.prepareSpaceForWrite({
      slug: 'unsafe-source',
      dataSources: [{ id: 'pull', composioSlug }],
      actions: [],
    });
    assert.equal(unsafe.ok, false, `${composioSlug} must not become an automatic refresh`);
    assert.match(
      unsafe.errors.join(' '),
      /Data source "pull".*provably read-only.*action/i,
    );
  }
});

test('ERROR: source with no backend blocks the save', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'nob', dataSources: [{ id: 'pull' }], actions: [],
  });
  assert.equal(prep.ok, false);
  // The corrective must name all THREE supported backends, not two.
  assert.match(prep.errors.join(' '), /declares no backend/);
  assert.match(prep.errors.join(' '), /cli_argv/);
});

test('ERROR: runner file that is not on disk blocks the save', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'missing', dataSources: [{ id: 'pull', runner: 'nope.mjs' }], actions: [],
  });
  assert.equal(prep.ok, false);
  assert.match(prep.errors.join(' '), /doesn.t exist/);
});

test('an opaque data-source runner is rejected even when its staged file exists', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'staged',
    dataSources: [{ id: 'pull', runner: 'new.mjs' }],
    actions: [],
    availableRunnerFiles: new Set(['new.mjs']),
  });
  assert.equal(prep.ok, false);
  assert.match(prep.errors.join(' '), /opaque runner|read-only Composio/i);
});

test('an installed runner declaration survives metadata/view saves but remains approval-gated at runtime', () => {
  writeRunner('legacy-preserved', 'pull.mjs');
  const existingDataSources = [{
    id: 'pull',
    runner: 'pull.mjs',
    schedule: '0 7 * * *',
    timezone: 'America/Los_Angeles',
  }];
  const prep = enforce.prepareSpaceForWrite({
    slug: 'legacy-preserved',
    dataSources: existingDataSources,
    existingDataSources,
    actions: [],
  });

  assert.equal(prep.ok, true, prep.errors.join('\n'));
  assert.deepEqual(prep.dataSources, existingDataSources);
  assert.match(
    prep.warnings.join(' '),
    /legacy runner.*preserved.*entrypoint hash.*approval.*helpers.*outside the digest/i,
  );
});

test('legacy compatibility cannot introduce a new runner source or swap its runner filename', () => {
  writeRunner('legacy-narrow', 'old.mjs');
  writeRunner('legacy-narrow', 'new.mjs');
  const existingDataSources = [{ id: 'pull', runner: 'old.mjs' }];

  const added = enforce.prepareSpaceForWrite({
    slug: 'legacy-narrow',
    dataSources: [
      ...existingDataSources,
      { id: 'new-source', runner: 'new.mjs' },
    ],
    existingDataSources,
    actions: [],
  });
  assert.equal(added.ok, false);
  assert.match(added.errors.join(' '), /new-source.*opaque runner|new-source.*read-only Composio/i);

  const swapped = enforce.prepareSpaceForWrite({
    slug: 'legacy-narrow',
    dataSources: [{ id: 'pull', runner: 'new.mjs' }],
    existingDataSources,
    actions: [],
  });
  assert.equal(swapped.ok, false);
  assert.match(swapped.errors.join(' '), /pull.*opaque runner|pull.*read-only Composio/i);
});

test('ERROR: runner declarations must be filenames under data/, not paths', () => {
  const viewDir = store.resolveInSpace('runner-paths', 'view');
  mkdirSync(viewDir, { recursive: true });
  writeFileSync(path.join(viewDir, 'evil.mjs'), 'process.stdout.write("{}")', 'utf-8');

  const prep = enforce.prepareSpaceForWrite({
    slug: 'runner-paths',
    dataSources: [{ id: 'pull', runner: '../view/evil.mjs' }],
    actions: [{ id: 'act', runner: '../view/evil.mjs' }],
  });

  assert.equal(prep.ok, false);
  assert.match(prep.errors.join(' '), /Data source "pull".*not a path/);
  assert.match(prep.errors.join(' '), /Action "act".*not a path/);
});

test('ERROR: invalid cron on a scheduled source blocks the save', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'badcron', dataSources: [{ id: 'pull', composioSlug: CURRENT_READ_OPERATION, schedule: 'every morning' }], actions: [],
  });
  assert.equal(prep.ok, false);
  assert.match(prep.errors.join(' '), /invalid schedule/);
});

test('ERROR: action with no backend blocks the save', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'noact', dataSources: [], actions: [{ id: 'x', label: 'Do thing' }],
  });
  assert.equal(prep.ok, false);
  assert.match(prep.errors.join(' '), /neither a composio_slug nor a runner/);
});

// --- cli_argv schema/runtime parity ------------------------------------------
// space_save advertises and parses data_sources[].cli_argv,
// workspaceDataSourceSafetyError deliberately admits it, and runSource executes
// it — but only behind the exact-argv trust grant. checkSpaceForWrite used to
// recognise only runner|composio_slug, so a fully valid frozen CLI declaration
// was rejected as having no backend and could never reach its one-time,
// digest-bound approval. These fail against v3.6.2.

test('cli_argv is a valid data-source backend and survives normalization', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'cliargv',
    dataSources: [{ id: 'sf_pull', cliArgv: ['sf', 'data', 'query', '--query', 'SELECT Id FROM Opportunity'] }],
    actions: [],
  });
  assert.equal(prep.ok, true, `a frozen CLI declaration must be admitted: ${prep.errors.join(' | ')}`);
  assert.equal(prep.errors.length, 0);
  // The exact argv must survive intact — the approval digest is bound to it.
  assert.deepEqual(
    prep.dataSources[0].cliArgv,
    ['sf', 'data', 'query', '--query', 'SELECT Id FROM Opportunity'],
  );
});

test('cli_argv is admitted for review, never vouched as safe to run unattended', async () => {
  // Parity means the declaration reaches the trust authority, NOT that the save
  // authorises execution. The safety policy returns no error precisely because
  // the one-time human approval happens later, at spawn time.
  const policy = await import('./space-execution-policy.js');
  assert.equal(
    policy.workspaceDataSourceSafetyError({ id: 'sf_pull', cliArgv: ['sf', 'org', 'list'] }),
    null,
  );
  // And the trust tool that owns that decision is a distinct, named authority.
  assert.equal(typeof policy.SPACE_CLI_SOURCE_TRUST_TOOL, 'string');
  assert.ok(policy.SPACE_CLI_SOURCE_TRUST_TOOL.length > 0);
});

test('an ACTION still cannot be cli_argv-backed (no runtime can execute one)', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'cliact',
    dataSources: [{ id: 'pull', composioSlug: CURRENT_READ_OPERATION }],
    actions: [{ id: 'send', cliArgv: ['sf', 'data', 'create'] } as never],
  });
  assert.equal(prep.ok, false, 'actions have no cli_argv runtime; admitting one would be unrunnable');
  assert.match(prep.errors.join(' '), /Action "send" declares neither/);
});
