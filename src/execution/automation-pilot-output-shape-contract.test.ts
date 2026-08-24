import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkflowCanonicalEntityResultProjection } from '../memory/workflow-result-projection-contract.js';
import { fingerprintSchema } from '../tools/tool-contract-store.js';
import {
  attestAutomationPilotOutputShape,
  validateAutomationPilotAuthoringOutputShape,
} from './automation-pilot-output-shape-contract.js';
import type {
  AutomationPilotAuthoringRequestV1,
  AutomationPilotAuthoringResultV1,
} from './automation-pilot-advancement-control-plane.js';

const DIGEST = 'a'.repeat(64);

function outputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      records: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: { type: 'string' },
            name: { type: 'string' },
            observed_at: { type: 'string' },
          },
          required: ['key', 'name', 'observed_at'],
        },
      },
      next_cursor: { type: ['string', 'null'] },
      exhausted: { type: 'boolean' },
    },
    required: ['records', 'exhausted'],
  };
}

function request(schema: Record<string, unknown> | null = outputSchema()): AutomationPilotAuthoringRequestV1 {
  return {
    version: 1,
    requestId: 'automation-pilot-authoring:test',
    advancementId: 'automation-pilot-advancement:test',
    proposal: {
      proposalId: 'proposal.test',
      revision: 2,
      digest: DIGEST,
      opportunity: {} as AutomationPilotAuthoringRequestV1['proposal']['opportunity'],
    },
    acceptedSource: { sessionId: 'chat.test', sourceUserSeq: 1 },
    requirement: {
      phaseId: 'read-result',
      requirementId: 'bounded-read',
      requirementDigest: DIGEST,
      effect: 'read',
    },
    workspaceSelection: {
      version: 1,
      workspaceId: 'records-workspace',
      expectedWorkspaceRevision: 1,
      expectedWorkspaceDigest: DIGEST,
      bindingId: 'binding:test',
      role: 'primary',
    },
    acquisition: {
      version: 1,
      capabilityId: 'capability.test',
      capabilityIdentityDigest: DIGEST,
      manifestDigest: DIGEST,
      providerKind: 'live_registry',
      operationId: 'records.read',
      providerIdentity: 'runtime.test',
      providerVersion: '1',
      operationVersion: '1',
      accountId: 'account.test',
      definitionFingerprint: DIGEST,
      schemaFingerprint: 'b'.repeat(32),
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      ...(schema ? {
        outputShape: {
          source: 'carrier_declared',
          schemaFingerprint: fingerprintSchema(schema),
          schema,
        },
      } : {}),
      invokePortId: 'invoke.test',
      argumentCompiler: { id: 'compiler.test', version: '1' },
    },
    authority: {
      workspaceMutation: 'none',
      providerSelection: 'none',
      businessInvoke: 'none',
      pilotDecision: 'none',
      queue: 'none',
      schedule: 'none',
      recurrence: 'none',
      permittedOutput: 'typed_pilot_contract_candidate_only',
    },
  };
}

function result(): AutomationPilotAuthoringResultV1 {
  return {
    version: 1,
    requestId: 'automation-pilot-authoring:test',
    requestDigest: DIGEST,
    contract: {
      phaseId: 'read-result',
      requirementId: 'bounded-read',
      workflowInputs: { scope: { type: 'string', required: true } },
      arguments: {
        scope: {
          source: { kind: 'workflow_input', key: 'scope' },
          required: true,
          type: 'string',
        },
        cursor: {
          source: { kind: 'continuation_cursor' },
          required: false,
          type: 'string',
        },
      },
      evidence: {
        requiredPaths: ['records'],
        nonEmptyPaths: ['records'],
        minItems: { records: 1 },
      },
      completeness: {
        kind: 'finite_exhaustive',
        exhaustedPath: 'exhausted',
        evidencePaths: ['records'],
      },
      continuation: {
        kind: 'cursor',
        cursorArgument: 'cursor',
        nextCursorPath: 'next_cursor',
        exhaustedPath: 'exhausted',
        maxPages: 3,
      },
      resultProjection: createWorkflowCanonicalEntityResultProjection({
        recordsPath: 'records',
        fields: [
          { field: 'key', recordPath: 'key', type: 'string', required: true, sensitivity: 'public', confidence: 1 },
          { field: 'name', recordPath: 'name', type: 'string', required: true, sensitivity: 'public', confidence: 1 },
        ],
        sourceRecord: {
          idPath: 'key',
          observedAt: { kind: 'record_path', path: 'observed_at' },
        },
        entityKind: 'generic-record',
        identityRules: [{
          ruleId: 'by-key',
          fields: ['key'],
          normalizers: ['trim'],
          exactIdentifierNamespace: 'generic-key',
        }],
        resolutionPolicy: {
          policyId: 'exact-key',
          mergeThreshold: 10,
          distinctThreshold: 2,
          ambiguityMargin: 1,
          weights: { defaultExactIdentifierMatch: 10, defaultCompoundSignalMatch: 0 },
        },
        fieldResolution: {
          kind: 'retain_all_evidence',
          selection: 'highest_confidence_then_newest',
          conflict: 'mark_conflicting_for_review',
        },
        provenance: { kind: 'workflow_page_record', retainSourceSnapshots: true },
        partition: {
          kind: 'workflow_run',
          coverageItems: 'source_record_occurrences',
          denominator: 'settled_record_count',
          completion: 'closed_authority_exhaustion',
        },
        bounds: {
          maxPages: 3,
          maxRecordsPerPage: 10,
          maxRecords: 30,
          maxPageBytes: 100_000,
          maxRecordBytes: 10_000,
          maxTotalBytes: 300_000,
        },
      }),
      workspaceBindingSelection: request().workspaceSelection,
    },
    workflowInputs: { scope: 'bounded.scope' },
  };
}

test('attested live output schema admits exact paginated entity paths without a business sample', () => {
  const attested = attestAutomationPilotOutputShape({ request: request(), requestDigest: DIGEST });
  assert.equal(attested.ok, true, JSON.stringify(attested));
  if (!attested.ok) return;
  assert.equal(attested.receipt.source, 'carrier_declared');
  assert.equal(attested.receipt.schemaFingerprint, fingerprintSchema(outputSchema()));
  assert.deepEqual(validateAutomationPilotAuthoringOutputShape({
    receipt: attested.receipt,
    result: result(),
  }), { ok: true });
});

test('missing or fingerprint-drifted output metadata fails closed', () => {
  const missing = attestAutomationPilotOutputShape({ request: request(null), requestDigest: DIGEST });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, 'output_shape_unavailable');

  const drifted = request();
  drifted.acquisition.outputShape!.schemaFingerprint = 'c'.repeat(32);
  const drift = attestAutomationPilotOutputShape({ request: drifted, requestDigest: DIGEST });
  assert.equal(drift.ok, false);
  if (!drift.ok) assert.equal(drift.code, 'output_shape_drift');
});

test('invented record, cursor, and optional exhaustion paths are refused', async (t) => {
  const attested = attestAutomationPilotOutputShape({ request: request(), requestDigest: DIGEST });
  assert.equal(attested.ok, true);
  if (!attested.ok) return;

  await t.test('invented record path', () => {
    const candidate = result();
    candidate.contract.resultProjection!.fields[1]!.recordPath = 'invented_name';
    const checked = validateAutomationPilotAuthoringOutputShape({ receipt: attested.receipt, result: candidate });
    assert.equal(checked.ok, false);
    if (!checked.ok) assert.equal(checked.code, 'output_shape_unproven');
  });

  await t.test('invented next cursor path', () => {
    const candidate = result();
    if (candidate.contract.continuation?.kind === 'cursor') {
      candidate.contract.continuation.nextCursorPath = 'invented_cursor';
    }
    const checked = validateAutomationPilotAuthoringOutputShape({ receipt: attested.receipt, result: candidate });
    assert.equal(checked.ok, false);
  });

  await t.test('optional exhaustion truth', () => {
    const schema = outputSchema();
    (schema.required as string[]) = ['records'];
    const optional = attestAutomationPilotOutputShape({ request: request(schema), requestDigest: DIGEST });
    assert.equal(optional.ok, true);
    if (!optional.ok) return;
    const checked = validateAutomationPilotAuthoringOutputShape({ receipt: optional.receipt, result: result() });
    assert.equal(checked.ok, false);
    if (!checked.ok) assert.match(checked.reason, /optional/);
  });
});

test('unsupported schema composition is never treated as path proof', () => {
  const schema = outputSchema();
  (schema.properties as Record<string, unknown>).records = {
    oneOf: [{ type: 'array', items: { type: 'object' } }],
  };
  const attested = attestAutomationPilotOutputShape({ request: request(schema), requestDigest: DIGEST });
  assert.equal(attested.ok, true);
  if (!attested.ok) return;
  const checked = validateAutomationPilotAuthoringOutputShape({ receipt: attested.receipt, result: result() });
  assert.equal(checked.ok, false);
  if (!checked.ok) assert.match(checked.reason, /unsupported schema composition/);
});
