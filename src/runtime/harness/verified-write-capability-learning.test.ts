/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/verified-write-capability-learning.test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-verified-write-learning-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const learning = await import('./verified-write-capability-learning.js');
const manifests = await import('./capability-manifest.js');
const indexed = await import('./indexed-capability-catalog.js');
const learnedStore = await import('../../memory/verified-write-capability-store.js');
const toolContracts = await import('../../tools/tool-contract-store.js');
const eventlog = await import('./eventlog.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');

type VerifiedWriteCapabilityRecordV1 = import('../../memory/verified-write-capability-store.js').VerifiedWriteCapabilityRecordV1;
type AuthorizedLocalPlanningDefinitionV1 = import('./local-planning-capability.js').AuthorizedLocalPlanningDefinitionV1;
type CapabilityManifestStore = import('./capability-manifest-store.js').CapabilityManifestStore;
type CanonicalVerifiedWriteCapability = import('./verified-write-capability-learning.js').CanonicalVerifiedWriteCapability;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const origin = {
  version: 1 as const,
  sessionId: 'write-learning-origin',
  sourceUserSeq: 7,
  acceptedTaskId: 'task:write-learning-origin#7',
  logicalToolCallId: 'write-call-7',
  receiptId: `write-evidence:v1:${'1'.repeat(64)}`,
  hostBindingDigest: '2'.repeat(64),
  terminalEventId: 'terminal-write-7',
};

const alias = learnedStore.verifiedWriteAliasForPhrase('Create one safe workspace');
assert.ok(alias);

const LOCAL_CAPABILITY_REF = 'cap:local:space_save:reversible';
const LOCAL_SCHEMA_FINGERPRINT = digest('space-save-schema');
const LOCAL_REGISTRY_FINGERPRINT = digest('space-save-semantics');
const localEnvelopeFingerprint = toolContracts.digestSchema({
  version: 1,
  provenance: 'authorized_local_registry',
  name: 'space_save',
  carrier: 'work_call',
  schemaFingerprint: LOCAL_SCHEMA_FINGERPRINT,
  registrySemanticsFingerprint: LOCAL_REGISTRY_FINGERPRINT,
});
const localManifestDigest = toolContracts.digestSchema({
  version: 1,
  provenance: 'authorized_local_registry',
  capabilityRef: LOCAL_CAPABILITY_REF,
  envelopeFingerprint: localEnvelopeFingerprint,
});

const localDefinition: AuthorizedLocalPlanningDefinitionV1 = {
  version: 1,
  provenance: 'authorized_local_registry',
  name: 'space_save',
  carrier: 'work_call',
  capabilityRef: LOCAL_CAPABILITY_REF,
  schemaFingerprint: LOCAL_SCHEMA_FINGERPRINT,
  registrySemanticsFingerprint: LOCAL_REGISTRY_FINGERPRINT,
  envelopeFingerprint: localEnvelopeFingerprint,
  consequence: 'local_artifact',
  reversibility: 'reversible',
  destructive: false,
  accountIdentity: 'local_registry:host',
  safeMode: null,
  descriptor: {
    id: LOCAL_CAPABILITY_REF,
    effect: 'local_write',
    purpose: 'persist_workspace',
    acceptedInputKinds: ['evidence'],
    producedOutputKinds: ['created_resource'],
    applicableDeliverableKinds: ['workspace'],
    inputShape: 'workspace_definition',
    outputShape: 'created_resource',
    outputKind: 'created_resource',
    deliverableKind: 'workspace',
    destinationPosture: 'create_new',
    evidenceKinds: ['local_commit_receipt'],
    handleRequired: true,
    readbackRequired: false,
    accountScope: 'local_registry:host',
    manifestDigest: localManifestDigest,
    advisoryRoles: ['destination'],
  },
};

const localRecord: VerifiedWriteCapabilityRecordV1 = {
  version: 1,
  klass: 'capability_only',
  aliasDigest: alias.aliasDigest,
  terms: alias.terms,
  origin,
  bindingKind: 'local_envelope',
  providerKind: 'authorized_local_registry',
  capabilityRef: localDefinition.capabilityRef,
  operationId: localDefinition.name,
  effect: 'local_write',
  accountIdentity: 'local_registry:host',
  localEnvelopeFingerprint: localDefinition.envelopeFingerprint,
};

test.after(() => {
  indexed._setVerifiedWriteResolverForTests(null);
  learnedStore.closeVerifiedWriteCapabilityStoreForTests();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('terminal gate accepts only the exact published done adjudication', () => {
  const exact = {
    origin,
    publicationStatus: 'published',
    acceptedTaskId: origin.acceptedTaskId,
    terminalEventId: origin.terminalEventId,
    presentationStatus: 'done',
    adjudicatedStatus: 'done',
  };
  assert.equal(learning.verifiedWriteTerminalGate(exact), true);
  assert.equal(learning.verifiedWriteTerminalGate({ ...exact, publicationStatus: 'legacy' }), false,
    'terminal missing/legacy is not proof');
  assert.equal(learning.verifiedWriteTerminalGate({ ...exact, terminalEventId: 'tampered' }), false,
    'a different terminal winner is not proof');
  assert.equal(learning.verifiedWriteTerminalGate({ ...exact, presentationStatus: 'blocked' }), false);
  assert.equal(learning.verifiedWriteTerminalGate({ ...exact, adjudicatedStatus: 'needs_verification' }), false);
  assert.equal(learning.verifiedWriteTerminalGate({ ...exact, adjudicatedStatus: 'blocked' }), false);
});

test('local proof is revoked by current schema, envelope, effect, or account drift', () => {
  const binding = {
    bindingKind: 'local_envelope' as const,
    toolName: localRecord.operationId,
    effect: 'local_write' as const,
  };
  assert.equal(learning.verifiedWriteLocalIdentityIsCurrent({
    record: localRecord,
    binding,
    definition: localDefinition,
  }), true);
  assert.equal(learning.verifiedWriteLocalIdentityIsCurrent({
    record: localRecord,
    binding,
    definition: { ...localDefinition, schemaFingerprint: digest('registry-drift') },
  }), false);
  assert.equal(learning.verifiedWriteLocalIdentityIsCurrent({
    record: localRecord,
    binding,
    definition: { ...localDefinition, envelopeFingerprint: digest('envelope-drift') },
  }), false);
  assert.equal(learning.verifiedWriteLocalIdentityIsCurrent({
    record: localRecord,
    binding,
    definition: { ...localDefinition, accountIdentity: 'local_registry:host', descriptor: {
      ...localDefinition.descriptor,
      effect: 'read',
    } },
  }), false);
});

test('current local identity enters the primary planning card with zero invocation, approval, or source replay', async () => {
  const { observeCurrentLocalPlanningDefinition } = await import('./local-planning-capability.js');
  const observed = await observeCurrentLocalPlanningDefinition({ name: 'space_save', carrier: 'work_call' });
  assert.equal(observed.ok, true, observed.ok ? '' : observed.reason);
  if (!observed.ok) throw new Error('the current Space registry definition could not be observed');
  indexed._setVerifiedWriteResolverForTests(async () => [{
    record: { ...localRecord, localEnvelopeFingerprint: observed.definition.envelopeFingerprint },
    hostBinding: {} as CanonicalVerifiedWriteCapability['hostBinding'],
    currentLocalDefinition: observed.definition,
  }]);
  try {
    const session = eventlog.createSession({ id: 'verified-write-current-planning', kind: 'chat' });
    const source = eventlog.appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'Create one safe workspace' },
    });
    const primed = await semantic.primePrimaryModelPlanningCatalog({
      sessionId: session.id,
      sourceUserSeq: source.seq,
    });
    assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
    if (!primed.ok) return;
    assert.ok(primed.planning.capabilities.some((descriptor) => (
      descriptor.id === localRecord.capabilityRef
    )), 'a current reobserved identity, rather than a historical call, is citable');

    const db = eventlog.openEventLog();
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ?
    `).get(session.id, source.seq) as { n: number }).n, 0,
    'planning does not invoke the learned capability');
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = ?
    `).get(session.id) as { n: number }).n, 0,
    'historical success supplies no approval or consent');
    assert.equal(eventlog.listEvents(session.id, { types: ['capability_resolution'] })
      .filter((event) => event.data.sourceUserSeq === source.seq).length, 0,
    'cross-turn supply does not widen or synthesize sourceUserSeq replay');
  } finally {
    indexed._setVerifiedWriteResolverForTests(null);
  }
});

function writeManifest(input: { accountId: string; effect: 'external_write' | 'local_write' }) {
  return manifests.attachSemanticContract({
    version: 1,
    manifestId: 'cap:provider:create_workspace',
    providerKind: 'local_registry',
    operationId: 'CREATE_WORKSPACE',
    providerIdentity: 'fixture-provider-v1',
    providerVersion: '1',
    operationVersion: '1',
    definitionFingerprint: digest(`definition:${input.accountId}:${input.effect}`),
    effect: input.effect,
    destination: { family: 'workspace', posture: 'create_new' },
    accountId: input.accountId,
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: true, policy: 'exact_artifact' },
    outputContract: { kind: 'created_resource' },
    evidenceContract: { kinds: ['receipt'], readbackRequired: false },
    provenance: { issuer: 'host:test', issuedAt: '2026-08-27T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['destination'],
  });
}

test('catalog join is exact on provider, operation, effect, account, and refuses ambiguity', () => {
  const manifest = writeManifest({ accountId: 'account-a', effect: 'external_write' });
  const installed = { manifest, digest: manifests.capabilityManifestDigest(manifest) };
  const store = { list: () => [installed] } as unknown as CapabilityManifestStore;
  const catalogRecord: VerifiedWriteCapabilityRecordV1 = {
    ...localRecord,
    bindingKind: 'catalog_manifest',
    providerKind: manifest.providerKind,
    capabilityRef: manifest.manifestId,
    operationId: manifest.operationId,
    effect: 'external_write',
    accountIdentity: manifest.accountId,
    localEnvelopeFingerprint: null,
  };
  assert.equal(indexed.currentManifestsForVerifiedWrite(store, catalogRecord).length, 1);
  assert.equal(indexed.currentManifestsForVerifiedWrite(store, {
    ...catalogRecord,
    accountIdentity: 'account-b',
  }).length, 0);
  assert.equal(indexed.currentManifestsForVerifiedWrite(store, {
    ...catalogRecord,
    effect: 'local_write',
  }).length, 0);
  const ambiguous = { list: () => [installed, installed] } as unknown as CapabilityManifestStore;
  assert.equal(indexed.currentManifestsForVerifiedWrite(ambiguous, catalogRecord).length, 2,
    'the caller sees ambiguity and therefore cannot choose by store order');
});
