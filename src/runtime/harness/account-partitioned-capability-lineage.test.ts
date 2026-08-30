/**
 * Run: node scripts/run-tests-isolated.mjs --test-concurrency=1 \
 *   src/runtime/harness/account-partitioned-capability-lineage.test.ts
 *
 * Live shape, provider-neutral: one operation is connected through accounts A
 * and B. Selecting A, then B, then A again must retain two parallel current
 * authorities. An account switch is not provider-definition drift and must
 * never supersede the other account's manifest.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-account-lineage-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const eventlog = await import('./eventlog.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const destinations = await import('./destination-binding.js');
const manifests = await import('./capability-manifest-store.js');
const observations = await import('./independent-capability-observation.js');
const provisioning = await import('./proof-provisioned-catalog.js');
const production = await import('./production-capability-adapters.js');
const schemas = await import('../../tools/composio-schema-cache.js');
const composio = await import('../../integrations/composio/client.js');
const { digestSchema } = await import('../../tools/tool-contract-store.js');

const OPERATION = 'FIXTURE_CREATE_RESOURCE';
const BASE_REF = `cap:resolved:${OPERATION.toLowerCase()}`;
const ACCOUNT_A = 'connection-account-a';
const ACCOUNT_B = 'connection-account-b';
const INPUT_V1 = {
  type: 'object',
  additionalProperties: false,
  required: ['body'],
  properties: { body: { type: 'string' } },
};
const INPUT_V2 = {
  type: 'object',
  additionalProperties: false,
  required: ['body', 'revision'],
  properties: {
    body: { type: 'string' },
    revision: { type: 'integer' },
  },
};

let currentInput: Readonly<Record<string, unknown>> = INPUT_V1;
let currentVersion = 'fixture-v1';

function proofTurn(label: string, accountIdentity: string) {
  const session = eventlog.createSession({ id: `account-lineage-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `create the exact fixture through ${accountIdentity}` },
  });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'capability_resolution',
    data: {
      sourceUserSeq: source.seq,
      authoritativeForTask: true,
      entries: [{
        intent: 'foreground tool_search disclosed this exact live operation',
        kind: 'composio',
        identifier: OPERATION,
        status: 'proven',
        connection: 'active',
        accountIdentity,
        effectClass: 'write',
      }],
    },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

async function publish(label: string, accountIdentity: string) {
  const identity = proofTurn(label, accountIdentity);
  const result = await provisioning.registerProofProvisionedCapabilities(
    identity,
    {
      allowedIdentifiers: [OPERATION],
      expectedSchemaDigests: [{
        identifier: OPERATION,
        schemaDigest: digestSchema(currentInput as Record<string, unknown>),
      }],
    },
  );
  return { ...result, identity };
}

function currentEntries() {
  return catalogs.peekHostCapabilityCatalogFactory()?.snapshot().filter((entry) => (
    entry.manifest?.operationId === OPERATION
    && entry.manifest.lifecycle.state === 'current'
  )) ?? [];
}

test.before(() => {
  eventlog.resetEventLog();
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  production.installProductionTransport(async () => ({}));
  composio.__test__.setConnectedAccountsLoader(async () => [
    {
      id: ACCOUNT_A,
      status: 'ACTIVE',
      user_id: 'fixture-user',
      toolkit: { slug: 'fixture' },
    },
    {
      id: ACCOUNT_B,
      status: 'ACTIVE',
      user_id: 'fixture-user',
      toolkit: { slug: 'fixture' },
    },
  ]);
  schemas.resetToolSchemaCache();
  schemas._setToolSchemaLoaderForTests(async (identifier) => (
    identifier === OPERATION
      ? {
          inputParameters: currentInput,
          outputParameters: null,
          providerObservedAt: Date.now(),
          providerOperationVersion: currentVersion,
        }
      : null
  ));
});

test.after(() => {
  schemas._setToolSchemaLoaderForTests(null);
  schemas.resetToolSchemaCache();
  composio.__test__.setConnectedAccountsLoader(null);
  production.installProductionTransport(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifests.installCapabilityManifestStore(null);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('A -> B -> A keeps both account identities current and citable', async () => {
  const firstA = await publish('first-a', ACCOUNT_A);
  assert.equal(firstA.refusal, undefined, JSON.stringify(firstA));
  const aRef = currentEntries().find((entry) => entry.account === ACCOUNT_A)?.capabilityId;
  assert.equal(aRef, BASE_REF, 'one-account first touch retains the compatible base ref');
  assert.ok(firstA.registered.includes(aRef!), JSON.stringify(firstA));

  const firstB = await publish('first-b', ACCOUNT_B);
  assert.equal(firstB.refusal, undefined, JSON.stringify(firstB));
  const afterB = currentEntries();
  assert.deepEqual(
    new Set(afterB.map((entry) => entry.account)),
    new Set([ACCOUNT_A, ACCOUNT_B]),
    'publishing B must not retire A',
  );
  const bRef = afterB.find((entry) => entry.account === ACCOUNT_B)?.capabilityId;
  assert.ok(bRef && bRef !== aRef, 'each account has one exact capability identity');
  assert.ok(firstB.registered.includes(bRef), JSON.stringify(firstB));

  const secondA = await publish('second-a', ACCOUNT_A);
  assert.equal(secondA.refusal, undefined, JSON.stringify(secondA));
  assert.ok(secondA.registered.includes(aRef!), 'returning to A republishes exact current authority');
  assert.deepEqual(
    new Set(currentEntries().map((entry) => entry.account)),
    new Set([ACCOUNT_A, ACCOUNT_B]),
  );
  assert.equal(
    catalogs.canonicalResolvedCapabilityId(OPERATION.toLowerCase(), ACCOUNT_A),
    aRef,
  );
  assert.equal(
    catalogs.canonicalResolvedCapabilityId(OPERATION.toLowerCase(), ACCOUNT_B),
    bRef,
  );
  assert.equal(
    catalogs.canonicalResolvedCapabilityId(OPERATION.toLowerCase()),
    BASE_REF,
    'without an account the host does not guess between parallel identities',
  );

  const frozen = catalogs.freezeCatalogSnapshotForPlanAdmission(secondA.identity);
  assert.equal(frozen.ok, true, JSON.stringify(frozen));
  if (!frozen.ok) return;
  const selectedDestination = destinations.bindExecutableDestination({
    requestedEffect: 'external_write',
    destinationPosture: 'create_new',
    candidateIds: [aRef!],
    catalog: frozen.entries,
  });
  assert.equal(selectedDestination.ok, true, JSON.stringify(selectedDestination));
  if (!selectedDestination.ok) return;
  assert.equal(selectedDestination.binding.accountId, ACCOUNT_A);
  const bound = frozen.catalog.bind({
    node: {
      id: 'write-fixture',
      kind: 'execute',
      capabilityRole: 'destination',
      effect: { kind: 'external_write' },
      capabilities: [{ kind: 'tool', resolution: 'explicit', names: [aRef!] }],
    },
    graph: {
      effectCeiling: 'external_write',
      classification: {
        goalConstraints: {
          destination: {
            family: 'fixture',
            posture: 'create_new',
            handleRequired: false,
            binding: selectedDestination.binding,
          },
        },
      },
    } as never,
    acceptedText: 'create the exact fixture through account A',
  });
  assert.ok(bound, 'the frozen exact account lineage must remain bindable');
  assert.equal(bound?.account, ACCOUNT_A);
  assert.equal(bound?.capabilityId, aRef);
});

test('same-account definition drift supersedes only that account', async () => {
  const before = currentEntries();
  const oldA = before.find((entry) => entry.account === ACCOUNT_A)!;
  const stableB = before.find((entry) => entry.account === ACCOUNT_B)!;
  currentInput = INPUT_V2;
  currentVersion = 'fixture-v2';

  const drifted = await publish('drift-a', ACCOUNT_A);
  assert.equal(drifted.refusal, undefined, JSON.stringify(drifted));
  const after = currentEntries();
  const nextA = after.find((entry) => entry.account === ACCOUNT_A);
  const nextB = after.find((entry) => entry.account === ACCOUNT_B);
  assert.ok(nextA, JSON.stringify({
    drifted,
    catalog: catalogs.peekHostCapabilityCatalogFactory()?.snapshot().map((entry) => ({
      id: entry.capabilityId,
      account: entry.account,
      operation: entry.manifest?.operationId,
    })),
    manifests: manifests.peekCapabilityManifestStore()?.list().map((entry) => ({
      id: entry.manifest.manifestId,
      account: entry.manifest.accountId,
      operation: entry.manifest.operationId,
      lifecycle: entry.manifest.lifecycle,
    })),
  }));
  assert.ok(nextB);
  assert.notEqual(nextA.capabilityId, oldA.capabilityId);
  assert.ok(drifted.registered.includes(nextA.capabilityId), JSON.stringify(drifted));
  assert.equal(nextB.capabilityId, stableB.capabilityId, 'A drift cannot supersede B');
  assert.equal(
    manifests.peekCapabilityManifestStore()?.get(oldA.capabilityId)?.manifest.lifecycle.state,
    'superseded',
  );
  assert.equal(
    manifests.peekCapabilityManifestStore()?.get(stableB.capabilityId)?.manifest.lifecycle.state,
    'current',
  );

  currentInput = INPUT_V1;
  currentVersion = 'fixture-v1';
  const reverted = await publish('revert-a', ACCOUNT_A);
  assert.equal(reverted.refusal, undefined, JSON.stringify(reverted));
  const revertedA = currentEntries().find((entry) => entry.account === ACCOUNT_A);
  assert.ok(revertedA);
  assert.notEqual(revertedA.capabilityId, oldA.capabilityId,
    'v1 -> v2 -> v1 cannot reuse a superseded durable identity');
  assert.notEqual(revertedA.capabilityId, nextA.capabilityId);
  assert.equal(
    manifests.peekCapabilityManifestStore()?.get(nextA.capabilityId)?.manifest.lifecycle.state,
    'superseded',
  );
  assert.equal(
    currentEntries().find((entry) => entry.account === ACCOUNT_B)?.capabilityId,
    stableB.capabilityId,
  );
});

test('a requested account never resolves to another account’s legacy base row', () => {
  const rows = currentEntries();
  const a = rows.find((entry) => entry.account === ACCOUNT_A)!;
  const b = rows.find((entry) => entry.account === ACCOUNT_B)!;
  assert.notEqual(a.capabilityId, b.capabilityId);
  assert.equal(
    catalogs.canonicalResolvedCapabilityId(OPERATION.toLowerCase(), ACCOUNT_A),
    a.capabilityId,
  );
  assert.equal(
    catalogs.canonicalResolvedCapabilityId(OPERATION.toLowerCase(), ACCOUNT_B),
    b.capabilityId,
  );
});

test('concurrent same-account publication converges on one current identity', async () => {
  const priorB = currentEntries().find((entry) => entry.account === ACCOUNT_B)?.capabilityId;
  const [left, right] = await Promise.all([
    publish('concurrent-a-left', ACCOUNT_A),
    publish('concurrent-a-right', ACCOUNT_A),
  ]);
  assert.equal(left.refusal, undefined, JSON.stringify(left));
  assert.equal(right.refusal, undefined, JSON.stringify(right));
  const rows = currentEntries();
  const currentA = rows.filter((entry) => entry.account === ACCOUNT_A);
  assert.equal(currentA.length, 1, JSON.stringify(currentA.map((entry) => entry.capabilityId)));
  assert.ok(left.registered.includes(currentA[0]!.capabilityId));
  assert.ok(right.registered.includes(currentA[0]!.capabilityId));
  assert.equal(
    rows.find((entry) => entry.account === ACCOUNT_B)?.capabilityId,
    priorB,
    'concurrent A refresh cannot perturb B',
  );
});

test('a stale observation publisher cannot overwrite the current account lineage', () => {
  const current = observations.peekIndependentCapabilityObservation(OPERATION, ACCOUNT_A);
  assert.ok(current);
  const before = observations.observationDigestOf(current);
  const staleExpected = {
    ...current,
    operationVersion: 'stale-concurrent-version',
  };
  const refused = observations.compareAndSetIndependentCapabilityObservation({
    expected: staleExpected,
    next: {
      operationId: OPERATION,
      accountId: ACCOUNT_A,
      definitionFingerprint: current.definitionFingerprint,
      providerVersion: current.providerVersion,
      operationVersion: current.operationVersion,
      observedAt: Date.now(),
      origin: 'independent',
      observe: () => ({
        operationId: OPERATION,
        accountId: ACCOUNT_A,
        definitionFingerprint: current.definitionFingerprint,
        providerVersion: current.providerVersion,
        operationVersion: current.operationVersion,
        observedAt: Date.now(),
      }),
    },
  });
  assert.deepEqual(refused, { ok: false, reason: 'identity_changed' });
  assert.equal(
    observations.observationDigestOf(
      observations.peekIndependentCapabilityObservation(OPERATION, ACCOUNT_A)!,
    ),
    before,
  );
});
