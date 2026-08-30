/**
 * Run:
 *   node scripts/run-tests-isolated.mjs \
 *     src/journeys/balanced-user-stops-competitive-acceptance.test.ts
 *
 * Causal pin for the reversible-create member of the balanced user-stop
 * corpus. The test follows the production catalog risk adapter into the sole
 * consent reducer. Provider and operation identities, plus catalog insertion
 * order, are generated so an app/tool registration cannot make it pass.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import {
  attachSemanticContract,
  capabilityManifestDigest,
  type CapabilityManifestV1,
} from '../runtime/harness/capability-manifest.js';
import {
  createCapabilityManifestStore,
  type CapabilityManifestStore,
} from '../runtime/harness/capability-manifest-store.js';
import {
  createHostCapabilityCatalogFactory,
  type HostCapabilityCatalogFactory,
  type RegisteredHostCapability,
} from '../runtime/harness/host-capability-catalog-factory.js';
import {
  loadCatalogManifestExternalRiskAttestationV1,
  type CatalogManifestExternalRiskBindingV1,
} from '../runtime/harness/external-capability-risk-loader.js';
import {
  evaluateInteractiveConsentV1,
  type CapabilityRiskAttestationV1,
  type ExactWorkCoverageV1,
  type InteractiveConsentDecisionV1,
} from '../runtime/harness/interactive-consent-policy.js';

const INPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['tab_name', 'records'],
  properties: {
    tab_name: { type: 'string' },
    records: { type: 'array', items: { type: 'object' } },
  },
  additionalProperties: false,
});
const INPUT_SCHEMA_DIGEST = createHash('sha256')
  .update(closedCanonicalJson(INPUT_SCHEMA), 'utf8')
  .digest('hex');

const ATOMIC_CONTENT = Object.freeze({
  version: 1 as const,
  compiler: Object.freeze({
    version: 1 as const,
    kind: 'tabular_record_set_v1' as const,
    namePointer: '/tab_name',
    recordsPointer: '/records',
    recordsEncoding: 'json_or_value' as const,
    selector: 'a1_grid_v1' as const,
  }),
  resultIdentity: Object.freeze({
    version: 1 as const,
    kind: 'pointer_resource_identity_v1' as const,
    idPointers: Object.freeze(['/resource_id']),
    handlePointers: Object.freeze(['/resource_url']),
    handleTemplate: Object.freeze({
      version: 1 as const,
      kind: 'prefix_suffix_v1' as const,
      prefix: 'https://example.invalid/resources/',
      suffix: '',
    }),
  }),
  evidence: Object.freeze(['receipt', 'content_commit'] as const),
});

function digest(value: unknown): string {
  return createHash('sha256').update(closedCanonicalJson(value), 'utf8').digest('hex');
}

function generatedToken(seed: number): string {
  // Deliberately excludes familiar provider, app, and CRUD vocabulary.
  const alphabet = 'QZXJKVBP';
  return Array.from({ length: 6 }, (_, index) =>
    alphabet[(seed * 5 + index * 3) % alphabet.length]).join('');
}

function generatedManifest(
  seed: number,
  overrides: Partial<CapabilityManifestV1> = {},
): CapabilityManifestV1 {
  const token = generatedToken(seed);
  const operationId = `OP_${token}_${seed}`;
  return attachSemanticContract({
    version: 1,
    manifestId: `cap:generated:${token.toLowerCase()}:${seed}`,
    providerKind: seed % 2 === 0 ? 'native_mcp' : 'composio',
    operationId,
    providerIdentity: `provider:${token.toLowerCase()}`,
    providerVersion: `surface-${seed}`,
    operationVersion: '1',
    definitionFingerprint: seed.toString(16).padStart(64, '0'),
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: INPUT_SCHEMA_DIGEST,
      providerOutputSchemaObserved: true,
      semanticName: operationId,
      behaviorHints: {
        readOnly: false,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
    },
    effect: 'external_write',
    operationSemantics: {
      version: 1,
      reversibility: 'reversible',
      atomicInputContent: ATOMIC_CONTENT,
    },
    destination: { family: `artifact:${token.toLowerCase()}`, posture: 'create_new' },
    accountId: `account:${token.toLowerCase()}`,
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: true, policy: 'exact_artifact' },
    outputContract: { kind: 'created_resource' },
    purpose: 'persist_collection',
    acceptedInputKinds: ['records'],
    producedOutputKinds: ['created_resource'],
    applicableDeliverableKinds: [`artifact:${token.toLowerCase()}`],
    evidenceContract: { kinds: ['receipt', 'content_commit'], readbackRequired: false },
    provenance: {
      issuer: 'journey:balanced-stops-generated-fixture',
      issuedAt: '2026-08-27T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    ...overrides,
  });
}

function catalogEntry(manifest: CapabilityManifestV1): RegisteredHostCapability {
  return {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    ...(manifest.destination ? { destination: manifest.destination } : {}),
    account: manifest.accountId,
    advisoryRoles: manifest.advisoryRoles,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    providerInputSchemaDigest: INPUT_SCHEMA_DIGEST,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({ ok: true }),
    reconcile: async () => ({ exists: false }),
  };
}

function authorityFor(manifests: readonly CapabilityManifestV1[]): {
  manifestStore: CapabilityManifestStore;
  catalogFactory: HostCapabilityCatalogFactory;
  observe: (manifest: CapabilityManifestV1) => {
    definitionFingerprint: string;
    providerVersion: string;
    operationVersion: string;
    accountId: string;
    observedAt: number;
  };
} {
  return {
    manifestStore: createCapabilityManifestStore(manifests),
    catalogFactory: createHostCapabilityCatalogFactory(manifests.map(catalogEntry)),
    observe: (manifest) => ({
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      accountId: manifest.accountId,
      observedAt: Date.now(),
    }),
  };
}

function bindingFor(manifest: CapabilityManifestV1): CatalogManifestExternalRiskBindingV1 {
  return {
    bindingKind: 'catalog_manifest',
    capabilityId: manifest.manifestId,
    providerInputSchemaDigest: INPUT_SCHEMA_DIGEST,
    schemaFingerprint: manifest.definitionFingerprint,
    accountId: manifest.accountId,
    invokePortId: manifest.invokePortId,
    operationId: manifest.operationId,
    manifestId: manifest.manifestId,
    manifestDigest: capabilityManifestDigest(manifest),
    effect: manifest.effect,
  };
}

type Evaluation =
  | { status: 'loader_refusal'; reason: string }
  | { status: 'consent_decision'; decision: InteractiveConsentDecisionV1 };

function evaluateGeneratedCreate(input: {
  manifest: CapabilityManifestV1;
  cohort: readonly CapabilityManifestV1[];
}): Evaluation {
  const manifest = input.manifest;
  const destination = {
    posture: manifest.destination?.posture ?? 'not_applicable',
    digest: digest({
      manifestId: manifest.manifestId,
      accountId: manifest.accountId,
      destination: manifest.destination ?? null,
    }),
  } as const;
  const loaded = loadCatalogManifestExternalRiskAttestationV1({
    version: 1,
    binding: bindingFor(manifest),
    inputSchema: INPUT_SCHEMA,
    destination,
    callSignals: { outboundDelivery: null },
    safety: 'admissible',
  }, authorityFor(input.cohort));
  if (!loaded.ok) return { status: 'loader_refusal', reason: loaded.reason };

  const projection = loaded.attestation.projection;
  const call: CapabilityRiskAttestationV1 = {
    version: 1,
    source: { kind: 'accepted_turn', id: 'source:generated', digest: 'a'.repeat(64) },
    acceptedTaskId: 'task:generated',
    bindingDigest: digest({ operationId: manifest.operationId, cohort: input.cohort.length }),
    logicalToolCallId: `call:${manifest.manifestId}`,
    operationId: manifest.operationId,
    argumentDigest: digest({ tab_name: 'Accepted rows', records: [{ id: 1 }] }),
    schemaFingerprint: manifest.definitionFingerprint,
    effect: projection.effect,
    accountId: manifest.accountId,
    destination,
    cardinality: { kind: 'once' },
    risk: projection.risk,
    semanticBasis: projection.semanticBasis,
    safety: projection.safety,
  };
  const coverage: ExactWorkCoverageV1 = {
    version: 1,
    source: call.source,
    acceptedTaskId: call.acceptedTaskId,
    contractId: 'contract:generated',
    requirementId: 'write_once',
    requirementDigest: digest({ operationId: manifest.operationId, effect: call.effect }),
    semanticScope: {
      operationId: call.operationId,
      schemaFingerprint: call.schemaFingerprint,
      effect: call.effect,
      accountId: call.accountId,
      destination: call.destination,
      cardinality: call.cardinality,
      semanticBasis: call.semanticBasis,
    },
    callBinding: {
      logicalToolCallId: call.logicalToolCallId,
      argumentDigest: call.argumentDigest,
      bindingDigest: call.bindingDigest,
    },
    reservationKey: digest({ contract: 'contract:generated', requirement: 'write_once' }),
  };
  return {
    status: 'consent_decision',
    decision: evaluateInteractiveConsentV1({
      call,
      coverage,
      userGrant: null,
      readiness: { kind: 'ready' },
      crossing: 'not_started',
      reservationAlreadyClaimed: false,
    }),
  };
}

test('generated exact reversible creates stay card-free under catalog-order permutations', () => {
  const manifests = Array.from({ length: 6 }, (_, index) => generatedManifest(index + 1));
  for (let rotation = 0; rotation < manifests.length; rotation += 1) {
    const ordered = [
      ...manifests.slice(rotation),
      ...manifests.slice(0, rotation),
    ];
    for (const manifest of manifests) {
      assert.deepEqual(evaluateGeneratedCreate({ manifest, cohort: ordered }), {
        status: 'consent_decision',
        decision: {
          kind: 'proceed',
          basis: 'exact_reversible_work',
          authorityDigest: digest({ operationId: manifest.operationId, effect: 'external_write' }),
          reservationKey: digest({ contract: 'contract:generated', requirement: 'write_once' }),
        },
      }, JSON.stringify({ rotation, providerKind: manifest.providerKind, operationId: manifest.operationId }));
    }
  }
});

test('incomplete, irreversible, destructive, and ambiguous creates retain typed stops', () => {
  const { operationSemantics: _omittedSemantics, ...missingFields } = generatedManifest(101);
  const missing = missingFields as CapabilityManifestV1;
  const irreversible = generatedManifest(102, {
    operationSemantics: { version: 1, reversibility: 'irreversible' },
  });
  const destructiveBase = generatedManifest(103);
  const destructive = generatedManifest(103, {
    operationSemantics: { version: 1, reversibility: 'irreversible' },
    externalDefinition: {
      ...destructiveBase.externalDefinition!,
      behaviorHints: {
        ...destructiveBase.externalDefinition!.behaviorHints,
        destructive: true,
      },
    },
  });
  const namedExisting = generatedManifest(104, {
    operationSemantics: { version: 1, reversibility: 'reversible' },
    destination: { family: 'artifact:generated', posture: 'named_existing' },
  });

  assert.deepEqual(evaluateGeneratedCreate({ manifest: missing, cohort: [missing] }), {
    status: 'consent_decision',
    decision: { kind: 'repair', reason: 'risk_unknown' },
  });
  for (const manifest of [irreversible, destructive]) {
    const evaluated = evaluateGeneratedCreate({ manifest, cohort: [manifest] });
    assert.equal(evaluated.status, 'consent_decision');
    if (evaluated.status !== 'consent_decision') continue;
    assert.equal(evaluated.decision.kind, 'needs_user');
    if (evaluated.decision.kind !== 'needs_user') continue;
    assert.equal(evaluated.decision.need, 'approval');
  }
  assert.deepEqual(evaluateGeneratedCreate({ manifest: namedExisting, cohort: [namedExisting] }), {
    status: 'consent_decision',
    decision: { kind: 'repair', reason: 'risk_unknown' },
  });

  const ambiguous = generatedManifest(105);
  const siblingBase = generatedManifest(106);
  const sibling = generatedManifest(106, {
    // Ambiguity is scoped to the exact provider/account tuple. A same-named
    // operation on another provider or account is independently bindable.
    providerKind: ambiguous.providerKind,
    operationId: ambiguous.operationId,
    providerIdentity: ambiguous.providerIdentity,
    accountId: ambiguous.accountId,
    externalDefinition: {
      ...siblingBase.externalDefinition!,
      semanticName: ambiguous.operationId,
    },
  });
  assert.deepEqual(
    evaluateGeneratedCreate({ manifest: ambiguous, cohort: [sibling, ambiguous] }),
    { status: 'loader_refusal', reason: 'catalog_binding_mismatch' },
  );
});

test('a stale callable row cannot lower consent from current manifest semantics', () => {
  const manifest = generatedManifest(201);
  const authority = authorityFor([manifest]);
  authority.catalogFactory.forget(manifest.manifestId);
  authority.catalogFactory.register({
    ...catalogEntry(manifest),
    // The manifest remains current and digest-valid, but this materialized row
    // attests a different live definition. Ordering or shape cannot heal it.
    liveFingerprint: 'f'.repeat(64),
  });
  const loaded = loadCatalogManifestExternalRiskAttestationV1({
    version: 1,
    binding: bindingFor(manifest),
    inputSchema: INPUT_SCHEMA,
    destination: {
      posture: 'create_new',
      digest: digest({
        manifestId: manifest.manifestId,
        accountId: manifest.accountId,
        destination: manifest.destination,
      }),
    },
    callSignals: { outboundDelivery: null },
    safety: 'admissible',
  }, authority);
  assert.deepEqual(loaded, { ok: false, reason: 'catalog_binding_mismatch' });
});
