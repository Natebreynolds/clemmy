/**
 * Run: npx tsx --test src/runtime/harness/mutation-verification-contract.test.ts
 *
 * Mutation verification is adapter-declared and host-derived.  The business
 * graph never gains verifier nodes; a frozen mutation binding names the one
 * exact read capability and the closed structural projections needed to prove
 * identity or content.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  documentedComposioMutationVerification,
  documentedComposioReadbackVerification,
  validateDocumentedComposioVerification,
} from '../../integrations/composio/operation-semantics.js';
import type { CapabilityManifestV1 } from './capability-manifest.js';
import {
  deriveMutationVerificationRecipe,
  projectMutationVerificationIntent,
  projectReadbackVerificationResult,
  type MutationVerificationRecipeV1,
} from './mutation-verification-contract.js';
import {
  bindingDigestOf,
  type CanonicalCatalogIdentityV1,
  type RegisteredHostCapability,
} from './host-capability-catalog-factory.js';

const WRAPPER_CREATE_INPUT = {
  type: 'object', additionalProperties: false, required: [],
  properties: {
    title: { type: 'string' },
    folder_id: { type: 'string' },
    folder_name: { type: 'string' },
  },
};
const WRAPPER_VALUES_UPDATE_INPUT = {
  type: 'object', additionalProperties: false,
  required: ['spreadsheet_id', 'range', 'values'],
  properties: {
    spreadsheet_id: { type: 'string' },
    range: { type: 'string' },
    values: { type: 'array', items: { type: 'array' } },
    value_input_option: { type: 'string' },
  },
};
const WRAPPER_BATCH_GET_INPUT = {
  type: 'object', additionalProperties: false, required: ['spreadsheet_id'],
  properties: {
    spreadsheet_id: { type: 'string' },
    ranges: { type: 'array', items: { type: 'string' } },
  },
};
const WRAPPER_ENVELOPE_OUTPUT = {
  type: 'object', additionalProperties: false,
  required: ['data', 'successful'],
  properties: {
    data: { type: 'object' },
    error: {},
    successful: { type: 'boolean' },
  },
};

const STALE_RAW_CREATE_INPUT = {
  type: 'object', additionalProperties: false, required: ['title'],
  properties: { title: { type: 'string' } },
};
const STALE_RAW_CREATE_OUTPUT = {
  type: 'object', additionalProperties: false, required: ['spreadsheetId'],
  properties: { spreadsheetId: { type: 'string' } },
};
const STALE_RAW_UPDATE_INPUT = {
  type: 'object', additionalProperties: false, required: ['spreadsheetId', 'requests'],
  properties: {
    spreadsheetId: { type: 'string' },
    requests: { type: 'array', items: { type: 'object' } },
  },
};
const STALE_RAW_READ_INPUT = {
  type: 'object', additionalProperties: false, required: ['spreadsheetId'],
  properties: { spreadsheetId: { type: 'string' }, ranges: { type: 'array' } },
};

const MACHINERY_CREATE = documentedComposioMutationVerification('GOOGLESHEETS_CREATE_GOOGLE_SHEET1');
const MACHINERY_UPDATE = documentedComposioMutationVerification('GOOGLESHEETS_VALUES_UPDATE');
const MACHINERY_READ = documentedComposioReadbackVerification('GOOGLESHEETS_BATCH_GET');
if (!MACHINERY_CREATE || !MACHINERY_UPDATE || !MACHINERY_READ) {
  throw new Error('the exact Sheets verification declarations must exist');
}

test('only the three exact current Sheets wrapper operations claim verifier authority', () => {
  assert.equal(MACHINERY_CREATE.proof, 'resource_identity_v1');
  assert.equal(MACHINERY_CREATE.resultEnvelope, 'successful_data_envelope_v1');
  assert.equal(MACHINERY_UPDATE.proof, 'exact_content_v1');
  assert.equal(MACHINERY_UPDATE.target.pointers[0], '/spreadsheet_id');
  assert.equal(MACHINERY_UPDATE.expectedContent?.projection.kind, 'exact_single_range_values_v1');
  assert.equal(MACHINERY_UPDATE.resultEnvelope, 'successful_data_envelope_v1');
  assert.equal(MACHINERY_READ.requestTargetPointers[0], '/spreadsheet_id');
  assert.equal(MACHINERY_READ.responseTarget?.kind, 'request_bound_success_v1');
  assert.equal(MACHINERY_READ.resultEnvelope, 'successful_data_envelope_v1');

  assert.equal(documentedComposioMutationVerification('GOOGLESHEETS_BATCH_UPDATE'), null,
    'the deprecated operation never regains verification authority');

  // Lookalikes were never authorized and still are not.
  for (const lookalike of [
    'CX_GOOGLESHEETS_BATCH_GET',
    'GOOGLESHEETS_BATCH_GET_BY_DATA_FILTER',
    'GOOGLESHEETS_BATCH_UPDATE_VALUES',
    'GOOGLESHEETS_VALUES_UPDATE_EXTRA',
    'AIRTABLE_BATCH_GET',
  ]) {
    assert.equal(documentedComposioReadbackVerification(lookalike), null);
    assert.equal(documentedComposioMutationVerification(lookalike), null);
  }
});

test('declarations validate the current wrapper schemas and reject every retired raw shape', () => {
  const current = [
    ['GOOGLESHEETS_CREATE_GOOGLE_SHEET1', WRAPPER_CREATE_INPUT],
    ['GOOGLESHEETS_VALUES_UPDATE', WRAPPER_VALUES_UPDATE_INPUT],
    ['GOOGLESHEETS_BATCH_GET', WRAPPER_BATCH_GET_INPUT],
  ] as const;
  for (const [operationId, inputSchema] of current) {
    assert.ok(validateDocumentedComposioVerification({
      operationId,
      inputSchema,
      outputSchema: WRAPPER_ENVELOPE_OUTPUT,
    }), `${operationId} must validate against its current provider wrapper`);
  }

  assert.equal(validateDocumentedComposioVerification({
    operationId: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1',
    inputSchema: STALE_RAW_CREATE_INPUT,
    outputSchema: WRAPPER_ENVELOPE_OUTPUT,
  }), null, 'the retired required-title create input does not match the current wrapper');
  assert.equal(validateDocumentedComposioVerification({
    operationId: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1',
    inputSchema: WRAPPER_CREATE_INPUT,
    outputSchema: STALE_RAW_CREATE_OUTPUT,
  }), null, 'a raw top-level spreadsheetId cannot stand in for the wrapper envelope');
  assert.equal(validateDocumentedComposioVerification({
    operationId: 'GOOGLESHEETS_VALUES_UPDATE',
    inputSchema: STALE_RAW_UPDATE_INPUT,
    outputSchema: WRAPPER_ENVELOPE_OUTPUT,
  }), null, 'camelCase spreadsheetId/requests cannot resurrect the retired update declaration');
  assert.equal(validateDocumentedComposioVerification({
    operationId: 'GOOGLESHEETS_BATCH_GET',
    inputSchema: STALE_RAW_READ_INPUT,
    outputSchema: WRAPPER_ENVELOPE_OUTPUT,
  }), null, 'camelCase read arguments cannot acquire verifier authority');
  assert.equal(validateDocumentedComposioVerification({
    operationId: 'GOOGLESHEETS_BATCH_GET',
    inputSchema: WRAPPER_BATCH_GET_INPUT,
    outputSchema: { type: 'object', properties: { data: { type: 'object' } } },
  }), null, 'opaque data without an explicit successful acknowledgement is not readback proof');
  assert.equal(validateDocumentedComposioVerification({
    operationId: 'GOOGLESHEETS_BATCH_GET',
    inputSchema: WRAPPER_BATCH_GET_INPUT,
    outputSchema: {
      ...WRAPPER_ENVELOPE_OUTPUT,
      properties: {
        ...WRAPPER_ENVELOPE_OUTPUT.properties,
        spreadsheetId: { type: 'string' },
      },
    },
  }), null, 'a hybrid wrapper/raw schema is drift, not compatible verifier authority');
});

function manifest(input: {
  id: string;
  effect: 'read' | 'external_write';
  account?: string;
  providerIdentity?: string;
  verification?: CapabilityManifestV1['externalDefinition'] extends infer _T ? unknown : never;
}): CapabilityManifestV1 {
  const verification = input.id === 'create'
    ? { mutation: MACHINERY_CREATE }
    : input.id === 'update'
      ? { mutation: MACHINERY_UPDATE }
      : input.id === 'read'
        ? { readback: MACHINERY_READ }
        : undefined;
  return {
    version: 1,
    manifestId: `manifest:${input.id}`,
    providerKind: 'composio',
    operationId: `OP_${input.id.toUpperCase()}`,
    providerIdentity: input.providerIdentity ?? 'provider-neutral-fixture',
    providerVersion: 'v1',
    operationVersion: '1',
    definitionFingerprint: input.id.padEnd(64, 'a').slice(0, 64),
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: input.id.padEnd(64, 'b').slice(0, 64),
      providerOutputSchemaObserved: true,
      providerOutputSchemaDigest: input.id.padEnd(64, 'c').slice(0, 64),
      semanticName: input.id,
      behaviorHints: { readOnly: null, destructive: null, idempotent: null, openWorld: null },
      ...(verification ? { verification } : {}),
    },
    effect: input.effect,
    destination: { family: 'ledger', posture: input.id === 'create' ? 'create_new' : 'named_existing' },
    accountId: input.account ?? 'acct-1',
    idempotency: { required: input.effect === 'external_write', policy: input.effect === 'external_write' ? 'key_before_dispatch' : 'none' },
    reconciliation: { supported: input.effect === 'external_write', policy: input.effect === 'external_write' ? 'exact_artifact' : 'none' },
    outputContract: { kind: input.effect === 'read' ? 'records' : 'created_resource' },
    purpose: input.effect === 'read' ? 'verify_created_resource' : 'persist_collection',
    acceptedInputKinds: input.effect === 'read' ? ['created_resource'] : ['records'],
    producedOutputKinds: input.effect === 'read' ? ['records'] : ['created_resource'],
    applicableDeliverableKinds: ['ledger'],
    evidenceContract: { kinds: input.effect === 'read' ? ['payload'] : ['receipt', 'readback'], readbackRequired: input.effect === 'external_write' },
    readbackContract: input.effect === 'external_write'
      ? { required: true, contentDigestRequired: input.id === 'update' }
      : undefined,
    provenance: { issuer: 'host:test', issuedAt: '1970-01-01T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    argumentCompiler: { id: 'compiler', version: '1' },
    invokePortId: `port:${input.id}`,
    ...(input.effect === 'external_write' ? { reconcilePortId: `reconcile:${input.id}` } : {}),
  };
}

function entry(source: CapabilityManifestV1): RegisteredHostCapability {
  return {
    capabilityId: source.manifestId,
    toolName: source.operationId,
    schemaVersion: source.operationVersion,
    schemaDigest: source.definitionFingerprint,
    effect: source.effect,
    destination: source.destination,
    account: source.accountId,
    manifestDigest: source.definitionFingerprint,
    providerKind: source.providerKind,
    liveFingerprint: source.definitionFingerprint,
    manifest: source,
    invoke: async () => ({}),
  };
}

function canonical(candidate: RegisteredHostCapability): CanonicalCatalogIdentityV1 {
  const source = candidate.manifest!;
  return {
    capabilityId: candidate.capabilityId,
    manifestId: source.manifestId,
    manifestDigest: candidate.manifestDigest!,
    operationId: source.operationId,
    schemaVersion: source.operationVersion,
    schemaDigest: source.definitionFingerprint,
    providerKind: source.providerKind,
    providerVersion: source.providerVersion,
    liveFingerprint: candidate.liveFingerprint!,
    account: source.accountId,
    effect: source.effect,
    destination: source.destination ?? null,
    idempotency: source.idempotency,
    reconciliation: source.reconciliation,
    invokePortId: source.invokePortId,
    reconcilePortId: source.reconcilePortId,
    argumentCompiler: source.argumentCompiler,
  };
}

test('one exact same-provider/account/family verifier freezes; ambiguity and lookalikes refuse', () => {
  const mutation = manifest({ id: 'create', effect: 'external_write' });
  const verifier = manifest({ id: 'read', effect: 'read' });
  const base = {
    acceptedTaskId: 'task:s#1',
    workContractId: `expected-work:v1:${'a'.repeat(64)}`,
    ownerRequirementId: 'create_sheet',
    ownerBindingDigest: 'b'.repeat(64),
    mutation,
    canonicalIdentityOf: canonical,
  };
  const exact = deriveMutationVerificationRecipe({ ...base, catalog: [entry(mutation), entry(verifier)] });
  assert.equal(exact.ok, true, exact.ok ? '' : exact.detail);
  if (!exact.ok) return;
  assert.equal(exact.recipe.proof, 'resource_identity_v1');
  assert.equal(exact.recipe.verifier.operationId, verifier.operationId);

  const generic = manifest({ id: 'generic', effect: 'read' });
  assert.equal(deriveMutationVerificationRecipe({ ...base, catalog: [entry(generic)] }).ok, false);
  const foreign = manifest({ id: 'read', effect: 'read', account: 'acct-2' });
  assert.equal(deriveMutationVerificationRecipe({ ...base, catalog: [entry(foreign)] }).ok, false);
  const ambiguous = deriveMutationVerificationRecipe({
    ...base,
    catalog: [entry(verifier), entry({ ...verifier, manifestId: 'manifest:read-2' })],
  });
  assert.equal(ambiguous.ok, false);
});

test('wrapper projections bind exact id/range/values and require provider acknowledgement', () => {
  const create = MACHINERY_CREATE;
  const update = MACHINERY_UPDATE;
  const read = MACHINERY_READ;
  const created = projectMutationVerificationIntent({
    contract: create,
    providerArguments: { title: 'Gate' },
    authoritativeResult: { spreadsheetId: 'sheet-1', spreadsheetUrl: 'https://example.invalid/sheet-1' },
    phase: 'settled_result',
    providerAcknowledged: true,
  });
  assert.deepEqual(created, { ok: true, resourceId: 'sheet-1', expectedContent: null, verifierStaticArgs: {} });
  assert.equal(projectMutationVerificationIntent({
    contract: create,
    providerArguments: { title: 'Gate' },
    authoritativeResult: { spreadsheetId: 'sheet-1' },
    phase: 'settled_result',
    providerAcknowledged: false,
  }).ok, false, 'an unwrapped/raw id is not enough to prove a create');

  const updateArguments = {
    spreadsheet_id: 'sheet-1',
    range: 'Sheet1!A1:C1',
    values: [['check', 'result', 'timestamp']],
    value_input_option: 'RAW',
  };
  assert.equal(projectMutationVerificationIntent({
    contract: update,
    providerArguments: updateArguments,
    authoritativeResult: null,
    phase: 'pre_dispatch',
  }).ok, true, 'dependency target admission is derived before the provider result exists');
  assert.equal(projectMutationVerificationIntent({
    contract: update,
    providerArguments: updateArguments,
    authoritativeResult: { updatedCells: 3 },
    phase: 'settled_result',
    providerAcknowledged: false,
  }).ok, false, 'post-settlement projection still requires the declared wrapper acknowledgement');

  const intended = projectMutationVerificationIntent({
    contract: update,
    providerArguments: updateArguments,
    authoritativeResult: { updatedCells: 3 },
    phase: 'settled_result',
    providerAcknowledged: true,
  });
  assert.equal(intended.ok, true);
  if (!intended.ok) return;
  assert.deepEqual(intended.verifierStaticArgs, { ranges: ['Sheet1!A1:C1'] });
  const observed = projectReadbackVerificationResult({
    contract: read,
    providerArguments: { spreadsheet_id: 'sheet-1', ranges: ['Sheet1!A1:C1'] },
    authoritativeResult: {
      valueRanges: [{ range: 'Sheet1!A1:C1', values: [['check', 'result', 'timestamp']] }],
    },
    requireContent: true,
    providerAcknowledged: true,
  });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.resourceId, intended.resourceId);
  assert.deepEqual(observed.observedContent, intended.expectedContent);
  assert.equal(projectReadbackVerificationResult({
    contract: read,
    providerArguments: { spreadsheet_id: 'sheet-1', ranges: ['Sheet1!A1:C1'] },
    authoritativeResult: {
      valueRanges: [{ range: 'Sheet1!A1:C1', values: [['check', 'result', 'timestamp']] }],
    },
    requireContent: true,
    providerAcknowledged: false,
  }).ok, false, 'a request echo plus opaque payload is not proof without the success envelope');
  assert.deepEqual(projectReadbackVerificationResult({
    contract: read,
    providerArguments: { spreadsheet_id: 'sheet-1' },
    authoritativeResult: { valueRanges: [] },
    requireContent: false,
    providerAcknowledged: true,
  }), { ok: true, resourceId: 'sheet-1', observedContent: null },
  'a successful request-bound read proves identity even when a new sheet has no values');
  assert.equal(projectReadbackVerificationResult({
    contract: read,
    providerArguments: { spreadsheet_id: 'sheet-1', ranges: ['Sheet1!A1:C1'] },
    authoritativeResult: { valueRanges: [] },
    requireContent: true,
    providerAcknowledged: true,
  }).ok, false, 'the same empty read cannot prove exact mutation content');
});

test('the node-binding digest covers the complete frozen recipe', () => {
  const mutation = manifest({ id: 'create', effect: 'external_write' });
  const verifier = manifest({ id: 'read', effect: 'read' });
  const derived = deriveMutationVerificationRecipe({
    acceptedTaskId: 'task:s#1',
    workContractId: `expected-work:v1:${'a'.repeat(64)}`,
    ownerRequirementId: 'create_sheet',
    ownerBindingDigest: 'b'.repeat(64),
    mutation,
    catalog: [entry(verifier)],
    canonicalIdentityOf: canonical,
  });
  assert.equal(derived.ok, true);
  if (!derived.ok) return;
  const body = {
    nodeId: 'create_sheet', capabilityId: mutation.manifestId,
    providerOperationId: mutation.operationId, logicalToolName: mutation.operationId.toLowerCase(),
    toolName: mutation.operationId, schemaVersion: '1', schemaDigest: mutation.definitionFingerprint,
    argumentDigest: 'd'.repeat(64), account: mutation.accountId,
    effect: 'external_write' as const, destination: mutation.destination,
    verification: derived.recipe,
  };
  const original = bindingDigestOf(body);
  const tampered: MutationVerificationRecipeV1 = {
    ...derived.recipe,
    verifierStaticArgs: { ranges: ['A9:A9'] },
  };
  assert.notEqual(bindingDigestOf({ ...body, verification: tampered }), original);
});
