/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/beta-closure-adversarial.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-beta-adv-'));

const {
  canonicalizeSheetGrid,
  canonicalizeSheetScalar,
  gridEquals,
  installProductionTransport,
  invokeForSealedManifest,
  normalizeSheetGrid,
  reconcileForSealedManifest,
} = await import('./production-capability-adapters.js');
const { productionCapabilityManifests } = await import('./production-capability-catalog.js');
const { sealGraphNodeInvocationEnvelope } = await import('./graph-node-envelope.js');
const {
  groundingDescriptorViewDigest,
  groundingDescriptorViewFromHost,
} = await import('../semantic-boundary/turn-semantic-proposal.js');
const { hostDescriptorFromRegistered } = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const { capabilityManifestDigest } = await import('./capability-manifest.js');

const identity = { sessionId: 'sess-adv', sourceUserSeq: 1, acceptedTaskId: 'task-1' };

function manifestByPurpose(purpose: string) {
  const manifest = productionCapabilityManifests().find((entry) => entry.purpose === purpose);
  assert.ok(manifest);
  return manifest;
}

test.afterEach(() => {
  installProductionTransport(null);
});

test('nested envelope mutation after seal does not change the frozen predecessor', () => {
  const nested = { records: [{ title: 'a', count: 4 }] };
  const sealed = sealGraphNodeInvocationEnvelope({
    version: 1,
    identity,
    goal: { objective: 'x', revision: 0, criteria: [] },
    node: { id: 'op-write', role: 'destination' },
    cardinality: { count: 1, fields: ['title'] },
    predecessors: [{ nodeId: 'op-transform', role: 'transform', value: nested }],
    expectedOutput: { kind: 'created_resource' },
    binding: {
      capabilityId: 'cap:host_create:destination',
      manifestDigest: 'b'.repeat(64),
      schemaDigest: 'a'.repeat(64),
      account: 'acct:beta:sheets:v1',
      effect: 'external_write',
    },
  });
  const prior = sealed.predecessors[0]?.value as { records: Array<{ title: string; count: number }> };
  assert.throws(() => {
    prior.records[0]!.title = 'mutated';
  }, TypeError);
  nested.records[0]!.title = 'mutated';
  nested.records[0]!.count = 99;
  assert.equal((sealed.predecessors[0]?.value as { records: Array<{ title: string }> }).records[0]?.title, 'a');
  assert.equal((sealed.predecessors[0]?.value as { records: Array<{ count: number }> }).records[0]?.count, 4);
});

test('numeric and string sheet cells stay distinct through canonicalize and readback', () => {
  const numeric = canonicalizeSheetGrid([{ score: 4, ok: true, missing: null, name: 'row' }]);
  const stringed = canonicalizeSheetGrid([{ score: '4', ok: true, missing: null, name: 'row' }]);
  assert.equal(canonicalizeSheetScalar(4), 4);
  assert.equal(canonicalizeSheetScalar('4'), '4');
  assert.equal(gridEquals(numeric, stringed), false);
  const readback = normalizeSheetGrid({
    spreadsheetId: 'sheet-1',
    valueRanges: [{
      values: [
        ['score', 'ok', 'missing', 'name'],
        [4, true, null, 'row'],
      ],
    }],
  });
  assert.equal(gridEquals(numeric, readback), true);
  assert.equal(gridEquals(stringed, readback), false);
});

test('unknown create with no reconciliation never invokes create again', async () => {
  const dest = manifestByPurpose('persist_collection');
  let calls = 0;
  installProductionTransport(async () => {
    calls += 1;
    throw new Error('should not probe or recreate');
  });
  const recovered = await reconcileForSealedManifest(dest)({ intendedDigest: 'a'.repeat(64) });
  assert.equal(dest.reconciliation.supported, false);
  assert.equal(dest.reconciliation.policy, 'uncertain_if_absent');
  assert.equal(recovered.exists, false);
  assert.equal(calls, 0);
});

test('account mismatch refuses before the sealed transport is used', async () => {
  const source = manifestByPurpose('locate_source');
  let calls = 0;
  installProductionTransport(async () => {
    calls += 1;
    return { locator: 'x' };
  });
  await assert.rejects(
    () => invokeForSealedManifest(source)({
      nodeId: 'op-source',
      role: 'source',
      payload: null,
      envelope: sealGraphNodeInvocationEnvelope({
        version: 1,
        identity,
        goal: { objective: 'find rows', revision: 0, criteria: [] },
        node: { id: 'op-source', role: 'source' },
        cardinality: { count: 1, fields: ['title'] },
        predecessors: [],
        expectedOutput: { kind: 'locator' },
        binding: {
          capabilityId: source.manifestId,
          manifestDigest: capabilityManifestDigest(source),
          schemaDigest: source.definitionFingerprint,
          account: 'acct:other',
          effect: 'read',
        },
      }),
      identity,
      binding: {
        capabilityId: source.manifestId,
        toolName: source.operationId,
        schemaVersion: source.operationVersion,
        schemaDigest: source.definitionFingerprint,
        args: {},
        account: 'acct:other',
        effect: 'read',
        invoke: async () => ({}),
      },
    }),
    /account/,
  );
  assert.equal(calls, 0);
});

test('judge digest covers only GroundingDescriptorViewV1 bytes', () => {
  const manifest = manifestByPurpose('locate_source');
  const host = hostDescriptorFromRegistered({
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    destination: manifest.destination,
    account: manifest.accountId,
    advisoryRoles: manifest.advisoryRoles,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({}),
  });
  assert.ok(host);
  const view = groundingDescriptorViewFromHost(host);
  assert.equal('manifestDigest' in view, false);
  assert.equal('inputShape' in view, false);
  const extra = { ...view, secret: 'not-shown' };
  assert.notEqual(
    groundingDescriptorViewDigest([view]),
    groundingDescriptorViewDigest([extra as typeof view]),
  );
});
