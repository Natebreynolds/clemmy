/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/host-call-approval-policy.test.ts */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attachSemanticContract,
  capabilityManifestDigest,
  type CapabilityManifestV1,
} from './capability-manifest.js';
import type { HostCallAttestation } from './accepted-turn-call-authority.js';
import type { AcceptedTaskWorkContractV1 } from './expected-work-contract.js';
import {
  evaluateAcceptedTaskSingleSheetCreateApproval,
  type ExactHostCreateApprovalInput,
} from './host-call-approval-policy.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import type { AcceptedTaskExpectation } from './resolution-ledger.js';
import type { TurnGraphIR } from '../graph/turn-graph-ir.js';

const SESSION_ID = 'approval-policy-sheet';
const SOURCE_USER_SEQ = 7;
const ACCEPTED_TASK_ID = `task:${SESSION_ID}#${SOURCE_USER_SEQ}`;
const GRAPH_ID = 'graph:approval-policy-sheet';
const GRAPH_EVENT_ID = 'evt:approval-policy-sheet';
const GRAPH_HASH = 'a'.repeat(64);
const WRITE_REQUIREMENT = 'write_once';

function sheetManifest(overrides: Partial<CapabilityManifestV1> = {}): CapabilityManifestV1 {
  return attachSemanticContract({
    version: 1,
    manifestId: 'manifest:googlesheets:sheet-from-json',
    providerKind: 'composio',
    operationId: 'GOOGLESHEETS_SHEET_FROM_JSON',
    providerIdentity: 'composio:googlesheets',
    providerVersion: '2026-08-23',
    operationVersion: '1',
    definitionFingerprint: 'b'.repeat(64),
    effect: 'external_write',
    destination: { family: 'spreadsheet', posture: 'create_new' },
    accountId: 'account:googlesheets:owner',
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: true, policy: 'exact_artifact' },
    outputContract: { kind: 'created_spreadsheet' },
    evidenceContract: { kinds: ['receipt'], readbackRequired: true },
    provenance: { issuer: 'host-call-approval-policy:test', issuedAt: '2026-08-23T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['create'],
    ...overrides,
  });
}

function exactInput(options: {
  manifest?: CapabilityManifestV1;
  outerToolName?: string;
  proposal?: unknown;
  omitProposal?: boolean;
  destinationPosture?: 'create_new' | 'named_existing';
  omitDestinationBinding?: boolean;
  contractCardinality?: 'once' | 'each';
  priorRequirementBindings?: number;
  reserved?: boolean;
  addSecondMutation?: boolean;
  directOperationCarrier?: boolean;
} = {}): ExactHostCreateApprovalInput {
  const manifest = options.manifest ?? sheetManifest();
  const manifestDigest = capabilityManifestDigest(manifest);
  const innerArgs = {
    title: 'Santa Clarita Restaurants',
    sheet_name: 'Restaurants',
    sheet_json: [
      { name: 'A', rating: 4.8 },
      { name: 'B', rating: 4.7 },
    ],
  };
  const outerToolName = options.outerToolName ?? 'work_call';
  const outerArgs: Record<string, unknown> = {
    proposal: options.proposal === undefined ? null : options.proposal,
    requirement_id: WRITE_REQUIREMENT,
    universe_item_id: null,
    universe_selector: null,
    name: options.directOperationCarrier ? manifest.operationId : 'composio_execute_tool',
    args_json: JSON.stringify(options.directOperationCarrier
      ? innerArgs
      : {
          tool_slug: manifest.operationId,
          arguments: JSON.stringify(innerArgs),
          connected_account_id: null,
        }),
  };
  if (options.omitProposal) delete outerArgs.proposal;
  const logical = durableLogicalCallContract(ACCEPTED_TASK_ID, outerToolName, outerArgs);
  assert.ok(logical);
  const attestation: HostCallAttestation = {
    sessionId: SESSION_ID,
    sourceUserSeq: SOURCE_USER_SEQ,
    acceptedTaskId: ACCEPTED_TASK_ID,
    sourceEventId: 'source-event',
    sourceEventDigest: 'c'.repeat(64),
    logicalToolCallId: 'sheet-create-call',
    toolName: logical.toolName,
    argumentDigest: logical.argumentDigest,
    effect: 'external_write',
    bindingKind: 'catalog_manifest',
    capabilityId: manifest.manifestId,
    schemaFingerprint: manifest.definitionFingerprint,
    accountId: manifest.accountId,
    invokePortId: manifest.invokePortId,
    operationId: manifest.operationId,
    manifestId: manifest.manifestId,
    manifestDigest,
    bindingDigest: 'd'.repeat(64),
    engineVersion: 'host_v1',
    surfaceVersion: 'configured_harness_capability_surface_v1',
    authorityDigest: 'e'.repeat(64),
    authorityRevision: 0,
    surfaceDigest: 'f'.repeat(64),
    catalogRevisionDigest: '1'.repeat(64),
    bindingRevisionDigest: '2'.repeat(64),
  };
  const destinationPosture = options.destinationPosture ?? 'create_new';
  const destination = {
    posture: destinationPosture,
    family: 'workbook',
    handleRequired: true,
    ...(!options.omitDestinationBinding
      ? {
          binding: {
            manifestId: manifest.manifestId,
            manifestDigest,
            accountId: manifest.accountId,
            operationId: manifest.operationId,
            schemaVersion: manifest.operationVersion,
            definitionFingerprint: manifest.definitionFingerprint,
            effect: 'external_write',
            posture: destinationPosture,
          },
        }
      : {}),
  } as const;
  const graph = {
    graphId: GRAPH_ID,
    compiler: { graphHash: GRAPH_HASH },
    classification: {
      route: 'act',
      externalEffectRequested: true,
      multiItem: { collectThenConstruct: true },
      goalConstraints: {
        construct: 'collect_then_construct',
        destinations: [destination],
        destination,
      },
    },
    effectCeiling: 'external_write',
  } as unknown as TurnGraphIR;
  const expectation = {
    version: 1,
    acceptedTaskId: ACCEPTED_TASK_ID,
    identity: { sessionId: SESSION_ID, sourceUserSeq: SOURCE_USER_SEQ, turn: 1 },
    graphEventId: GRAPH_EVENT_ID,
    graphId: GRAPH_ID,
    graphHash: GRAPH_HASH,
    compilerVersion: 'turn-graph-shadow-v2',
    route: 'act',
    workNodeId: WRITE_REQUIREMENT,
    workKind: 'execute',
    effectCeiling: 'external_write',
    externalEffectRequested: true,
    externalEffectKinds: ['write'],
  } satisfies AcceptedTaskExpectation;
  const operations: AcceptedTaskWorkContractV1['operations'] = [
    {
      id: 'read_once',
      effect: 'read',
      coverage: 'resolved_operation',
      dependsOn: [],
      dataFrom: [],
      cardinality: { kind: 'once' },
    },
    {
      id: WRITE_REQUIREMENT,
      effect: 'external_write',
      dependsOn: ['read_once'],
      dataFrom: ['read_once'],
      cardinality: options.contractCardinality === 'each'
        ? { kind: 'each', universeId: 'records' }
        : { kind: 'once' },
    },
    ...(options.addSecondMutation
      ? [{
          id: 'write_again',
          effect: 'external_write' as const,
          dependsOn: [WRITE_REQUIREMENT],
          dataFrom: [WRITE_REQUIREMENT],
          cardinality: { kind: 'once' as const },
        }]
      : []),
  ];
  const contract: AcceptedTaskWorkContractV1 = {
    version: 1,
    contractId: 'expected-work:v1:sheet-create',
    identity: { sessionId: SESSION_ID, sourceUserSeq: SOURCE_USER_SEQ, turn: 1 },
    acceptedTaskId: ACCEPTED_TASK_ID,
    graphEventId: GRAPH_EVENT_ID,
    graphId: GRAPH_ID,
    graphHash: GRAPH_HASH,
    plannerSource: 'deterministic',
    operations,
    universes: options.contractCardinality === 'each'
      ? [{ id: 'records', seal: 'accepted_input', members: ['A'] }]
      : [],
  };
  const reservationKey = `${contract.contractId}\0${WRITE_REQUIREMENT}`;
  return {
    outerToolName,
    outerArgs,
    logicalToolName: manifest.operationId,
    logicalArgs: innerArgs,
    attestation,
    manifest,
    authority: {
      expectation,
      graph,
      contract,
      priorRequirementBindings: options.priorRequirementBindings ?? 0,
    },
    reservedInBatch: options.reserved ? new Set([reservationKey]) : new Set(),
  };
}

function withGatewayMutation(
  input: ExactHostCreateApprovalInput,
  mutation: Record<string, unknown>,
): ExactHostCreateApprovalInput {
  const gateway = JSON.parse(String(input.outerArgs.args_json)) as Record<string, unknown>;
  return {
    ...input,
    outerArgs: {
      ...input.outerArgs,
      args_json: JSON.stringify({ ...gateway, ...mutation }),
    },
  };
}

test('the exact graph-bound once reversible create_new Google Sheet is covered by its accepted task', () => {
  const decision = evaluateAcceptedTaskSingleSheetCreateApproval(exactInput());
  assert.equal(decision.status, 'covered');
  if (decision.status === 'covered') {
    assert.equal(decision.reservationKey, `expected-work:v1:sheet-create\0${WRITE_REQUIREMENT}`);
  }
});

test('the real broker carrier is exact and wrong gateway name, slug, account, args, or fields retain approval', () => {
  const wrongName = exactInput();
  wrongName.outerArgs = { ...wrongName.outerArgs, name: 'foreign_execute_tool' };
  for (const [label, input] of [
    ['wrong gateway name', wrongName],
    ['wrong slug', withGatewayMutation(exactInput(), { tool_slug: 'GOOGLESHEETS_VALUES_UPDATE' })],
    ['wrong account', withGatewayMutation(exactInput(), { connected_account_id: 'account:other' })],
    ['wrong inner args', withGatewayMutation(exactInput(), { arguments: JSON.stringify({ title: 'Other' }) })],
    ['unknown gateway field', withGatewayMutation(exactInput(), { surprise: true })],
  ] as const) {
    assert.equal(
      evaluateAcceptedTaskSingleSheetCreateApproval(input).status,
      'approval_required',
      label,
    );
  }
});

test('the exception never applies to direct carriers, new proposals, existing destinations, or unbound destinations', () => {
  for (const [label, input] of [
    ['direct call_tool', exactInput({ outerToolName: 'call_tool' })],
    ['ordinary work_call missing proposal', exactInput({ omitProposal: true })],
    ['model proposal', exactInput({ proposal: { version: 1, operations: [], universes: [] } })],
    ['named existing', exactInput({ destinationPosture: 'named_existing' })],
    ['missing exact destination binding', exactInput({ omitDestinationBinding: true })],
  ] as const) {
    assert.equal(
      evaluateAcceptedTaskSingleSheetCreateApproval(input).status,
      'approval_required',
      label,
    );
  }
});

test('update, email/share, delete-like, unknown, and native lookalikes retain approval', () => {
  const variants: Array<[string, CapabilityManifestV1]> = [
    ['update', sheetManifest({ operationId: 'GOOGLESHEETS_VALUES_UPDATE' })],
    ['email/share', sheetManifest({ operationId: 'GMAIL_SEND_EMAIL', destination: { family: 'email', posture: 'create_new' } })],
    ['delete', sheetManifest({ operationId: 'GOOGLESHEETS_DELETE_SPREADSHEET' })],
    ['unknown', sheetManifest({ operationId: 'ACME_TRANSFORM_BLOB' })],
    ['native lookalike', sheetManifest({ providerKind: 'native_mcp' })],
  ];
  for (const [label, manifest] of variants) {
    assert.equal(
      evaluateAcceptedTaskSingleSheetCreateApproval(exactInput({ manifest })).status,
      'approval_required',
      label,
    );
  }
});

test('batch/per-item work, multiple mutations, a prior claim, and a same-frame second create retain approval', () => {
  for (const [label, input] of [
    ['per-item cardinality', exactInput({ contractCardinality: 'each' })],
    ['multiple mutations', exactInput({ addSecondMutation: true })],
    ['prior durable claim', exactInput({ priorRequirementBindings: 1 })],
    ['same-frame second claim', exactInput({ reserved: true })],
  ] as const) {
    assert.equal(
      evaluateAcceptedTaskSingleSheetCreateApproval(input).status,
      'approval_required',
      label,
    );
  }
});
