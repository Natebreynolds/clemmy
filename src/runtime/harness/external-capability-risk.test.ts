/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/external-capability-risk.test.ts */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  projectExternalCapabilityRiskV1,
  type ExternalCapabilityEffect,
  type ExternalCapabilityRiskInputV1,
} from './external-capability-risk.js';

const digest = (letter: string): string => letter.repeat(64);

function riskInput(options: {
  semanticName?: string;
  effect?: ExternalCapabilityEffect;
  providerKind?: ExternalCapabilityRiskInputV1['manifest']['providerKind'];
  documentedSemantic?: ExternalCapabilityRiskInputV1['documentedSemantic'];
  readOnly?: boolean | null;
  destructive?: boolean | null;
  idempotent?: boolean | null;
  openWorld?: boolean | null;
  outboundDelivery?: boolean | null;
} = {}): ExternalCapabilityRiskInputV1 {
  const semanticName = options.semanticName ?? 'CREATE_RECORD';
  const effect = options.effect ?? 'external_write';
  const providerKind = options.providerKind ?? 'composio';
  const operationId = `EXACT_${semanticName}`;
  const providerIdentity = providerKind === 'composio'
    ? 'external-catalog-instance'
    : 'configured-protocol-instance';
  const providerVersion = 'provider-version-1';
  const operationVersion = 'operation-version-1';
  const schemaFingerprint = digest('c');
  const accountId = 'account-1';
  return {
    version: 1,
    manifest: {
      manifestVersion: 1,
      manifestId: 'manifest-1',
      manifestDigest: digest('a'),
      providerKind,
      providerIdentity,
      providerVersion,
      operationId,
      operationVersion,
      schemaFingerprint,
      accountId,
      effect,
      destination: {
        digest: digest('d'),
        posture: effect === 'read'
          ? 'not_applicable'
          : semanticName.startsWith('CREATE') ? 'create_new' : 'named_existing',
      },
    },
    liveDefinition: {
      definitionDigest: digest('b'),
      providerKind,
      providerIdentity,
      providerVersion,
      operationId,
      operationVersion,
      schemaFingerprint,
      accountId,
      semanticName,
    },
    behaviorHints: {
      readOnly: options.readOnly ?? null,
      destructive: options.destructive ?? null,
      idempotent: options.idempotent ?? null,
      openWorld: options.openWorld ?? null,
    },
    callSignals: {
      outboundDelivery: options.outboundDelivery ?? null,
    },
    documentedSemantic: options.documentedSemantic ?? null,
    safety: 'admissible',
  };
}

function projected(input: unknown) {
  const result = projectExternalCapabilityRiskV1(input);
  if (!result.ok) assert.fail(`projection refused: ${result.reason}`);
  return result.projection;
}

test('generic reads and ordinary create/update project without provider or tool allowlists', () => {
  for (const semanticName of [
    'GET_POST_CONTENT',
    'LIST_EVENT_CREATE_RULES',
    'POST_PARAMETERIZED_SEARCH',
  ]) {
    assert.deepEqual(projected(riskInput({ semanticName, effect: 'read' })).risk, {
      reversibility: 'read_only', consequence: 'read', destructive: false,
    }, semanticName);
  }

  for (const [semanticName, consequence] of [
    ['CREATE_RECORD', 'create'],
    ['UPDATE_RECORD', 'update'],
    ['CREATE_REPLY_DRAFT', 'create'],
  ] as const) {
    assert.deepEqual(projected(riskInput({ semanticName })).risk, {
      reversibility: 'ordinary_non_destructive', consequence, destructive: false,
    }, semanticName);
  }

  const native = projected(riskInput({
    semanticName: 'UPDATE_RECORD',
    providerKind: 'native_mcp',
  }));
  assert.deepEqual(native.risk, {
    reversibility: 'ordinary_non_destructive', consequence: 'update', destructive: false,
  });
});

test('send, delete, and admin evidence remains explicitly high consequence', () => {
  assert.deepEqual(projected(riskInput({ semanticName: 'SEND_DRAFT' })).risk, {
    reversibility: 'irreversible', consequence: 'send', destructive: false,
  });
  assert.deepEqual(projected(riskInput({ semanticName: 'DELETE_RECORD' })).risk, {
    reversibility: 'unknown', consequence: 'delete', destructive: true,
  });
  const admin = projected(riskInput({ semanticName: 'ROTATE_API_KEY', effect: 'admin' }));
  assert.equal(admin.effect, 'admin');
  assert.deepEqual(admin.risk, {
    reversibility: 'unknown', consequence: 'admin', destructive: false,
  });

  // Argument-derived delivery upgrades an otherwise ordinary event create;
  // an exact proof of no outbound delivery keeps the reversible-looking create
  // in the honest ordinary class without claiming provider rollback exists.
  assert.deepEqual(projected(riskInput({
    semanticName: 'CREATE_EVENT',
    outboundDelivery: true,
  })).risk, {
    reversibility: 'irreversible', consequence: 'send', destructive: false,
  });
  assert.deepEqual(projected(riskInput({
    semanticName: 'CREATE_EVENT',
    outboundDelivery: false,
  })).risk, {
    reversibility: 'ordinary_non_destructive', consequence: 'create', destructive: false,
  });
});

test('declared hints can raise risk or admit an unopposed read but never downgrade contrary evidence', () => {
  assert.deepEqual(projected(riskInput({
    semanticName: 'CONVERSATIONS_HISTORY',
    effect: 'read',
    readOnly: true,
  })).risk, {
    reversibility: 'read_only', consequence: 'read', destructive: false,
  });
  assert.deepEqual(projected(riskInput({
    semanticName: 'DELETE_RECORD',
    readOnly: true,
  })).risk, {
    reversibility: 'unknown', consequence: 'delete', destructive: true,
  });
  assert.deepEqual(projected(riskInput({
    semanticName: 'UPDATE_RECORD',
    destructive: true,
  })).risk, {
    reversibility: 'unknown', consequence: 'update', destructive: true,
  });
  assert.deepEqual(projected(riskInput({
    semanticName: 'SEND_MESSAGE',
    idempotent: true,
  })).risk, {
    reversibility: 'irreversible', consequence: 'send', destructive: false,
  });
});

test('exact host-reviewed semantics outrank name shape without hiding live conflicts', () => {
  const documentedCreate = riskInput({
    semanticName: 'FLURBLE_RESOURCE',
    documentedSemantic: {
      sourceDigest: digest('e'),
      effect: 'external_write',
      reversibility: 'reversible',
      consequence: 'create',
      destructive: false,
    },
  });
  assert.deepEqual(projected(documentedCreate).risk, {
    reversibility: 'reversible', consequence: 'create', destructive: false,
  });

  const documentedOddRead = riskInput({
    semanticName: 'DELETE_SHAPED_RESEARCH_SNAPSHOT',
    effect: 'read',
    documentedSemantic: {
      sourceDigest: digest('f'),
      effect: 'read',
      reversibility: 'read_only',
      consequence: 'read',
      destructive: false,
    },
  });
  assert.deepEqual(projected(documentedOddRead).risk, {
    reversibility: 'read_only', consequence: 'read', destructive: false,
  });

  const mismatch = structuredClone(documentedCreate);
  mismatch.documentedSemantic!.effect = 'read';
  assert.deepEqual(projectExternalCapabilityRiskV1(mismatch), {
    ok: false, reason: 'effect_conflict',
  });

  const changedLiveDeclaration = structuredClone(documentedOddRead);
  changedLiveDeclaration.behaviorHints.destructive = true;
  assert.deepEqual(projectExternalCapabilityRiskV1(changedLiveDeclaration), {
    ok: false, reason: 'semantic_conflict',
  });
});

test('unknown, mixed, and manifest-effect conflicts remain typed repair inputs', () => {
  assert.deepEqual(projected(riskInput({ semanticName: 'SYNC_RESOURCE' })).risk, {
    reversibility: 'unknown', consequence: 'unknown', destructive: false,
  });
  assert.deepEqual(projected(riskInput({ semanticName: 'CREATE_AND_UPDATE_RESOURCE' })).risk, {
    reversibility: 'unknown', consequence: 'unknown', destructive: false,
  });
  assert.deepEqual(projectExternalCapabilityRiskV1(riskInput({
    semanticName: 'DELETE_RESOURCE',
    effect: 'read',
  })), { ok: false, reason: 'effect_conflict' });
  assert.deepEqual(projectExternalCapabilityRiskV1(riskInput({
    semanticName: 'GET_RESOURCE',
    effect: 'external_write',
  })), { ok: false, reason: 'effect_conflict' });
  assert.deepEqual(projectExternalCapabilityRiskV1(riskInput({
    semanticName: 'ROTATE_API_KEY',
    effect: 'external_write',
  })), { ok: false, reason: 'effect_conflict' });
});

test('identity is exact and the semantic-basis digest covers every closed authority byte', () => {
  const input = riskInput({ semanticName: 'UPDATE_RECORD', idempotent: false });
  const first = projected(input);
  assert.match(first.semanticBasis.digest, /^[a-f0-9]{64}$/);

  // Canonical object ordering does not affect the digest.
  const reordered = {
    safety: input.safety,
    documentedSemantic: input.documentedSemantic,
    callSignals: input.callSignals,
    behaviorHints: input.behaviorHints,
    liveDefinition: {
      semanticName: input.liveDefinition.semanticName,
      accountId: input.liveDefinition.accountId,
      schemaFingerprint: input.liveDefinition.schemaFingerprint,
      operationVersion: input.liveDefinition.operationVersion,
      operationId: input.liveDefinition.operationId,
      providerVersion: input.liveDefinition.providerVersion,
      providerIdentity: input.liveDefinition.providerIdentity,
      providerKind: input.liveDefinition.providerKind,
      definitionDigest: input.liveDefinition.definitionDigest,
    },
    manifest: {
      destination: input.manifest.destination,
      effect: input.manifest.effect,
      accountId: input.manifest.accountId,
      schemaFingerprint: input.manifest.schemaFingerprint,
      operationVersion: input.manifest.operationVersion,
      operationId: input.manifest.operationId,
      providerVersion: input.manifest.providerVersion,
      providerIdentity: input.manifest.providerIdentity,
      providerKind: input.manifest.providerKind,
      manifestDigest: input.manifest.manifestDigest,
      manifestId: input.manifest.manifestId,
      manifestVersion: input.manifest.manifestVersion,
    },
    version: input.version,
  };
  assert.equal(projected(reordered).semanticBasis.digest, first.semanticBasis.digest);

  // Idempotency does not lower consent risk, but it remains an exact current
  // definition fact and therefore changes the semantic authority digest.
  const hintChanged = structuredClone(input);
  hintChanged.behaviorHints.idempotent = true;
  const second = projected(hintChanged);
  assert.deepEqual(second.risk, first.risk);
  assert.notEqual(second.semanticBasis.digest, first.semanticBasis.digest);

  const identityChanged = structuredClone(input);
  identityChanged.manifest.providerIdentity = 'another-current-instance';
  identityChanged.liveDefinition.providerIdentity = 'another-current-instance';
  assert.notEqual(
    projected(identityChanged).semanticBasis.digest,
    first.semanticBasis.digest,
  );

  const drifted = structuredClone(input);
  drifted.liveDefinition.accountId = 'different-account';
  assert.deepEqual(projectExternalCapabilityRiskV1(drifted), {
    ok: false, reason: 'identity_mismatch',
  });
});

test('the projector accepts only the closed data shape and never evaluates accessors', () => {
  const extra = riskInput();
  (extra as unknown as Record<string, unknown>).surprise = true;
  assert.deepEqual(projectExternalCapabilityRiskV1(extra), {
    ok: false, reason: 'malformed_input',
  });

  const nestedExtra = riskInput();
  (nestedExtra.behaviorHints as unknown as Record<string, unknown>).providerOverride = false;
  assert.deepEqual(projectExternalCapabilityRiskV1(nestedExtra), {
    ok: false, reason: 'malformed_input',
  });

  let getterRan = false;
  const accessor = riskInput() as unknown as Record<string, unknown>;
  Object.defineProperty(accessor, 'safety', {
    enumerable: true,
    get() {
      getterRan = true;
      return 'admissible';
    },
  });
  assert.deepEqual(projectExternalCapabilityRiskV1(accessor), {
    ok: false, reason: 'malformed_input',
  });
  assert.equal(getterRan, false);
});
