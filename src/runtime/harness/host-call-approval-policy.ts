/**
 * Narrow accepted-task approval for one routine external create.
 *
 * The production host keeps a fail-closed approval floor for every write and
 * admin call.  This module proves the sole exception currently owned by the
 * product contract: the exact accepted request may authorize one reversible
 * `create_new` Google Sheet when that create is already bound to the accepted
 * graph, deterministic once-cardinality work contract, and current catalog
 * manifest.  It is intentionally not a general reversible-write policy.
 */
import { capabilityManifestDigest, currentCapabilityManifest, type CapabilityManifestV1 } from './capability-manifest.js';
import type { HostCallAttestation } from './accepted-turn-call-authority.js';
import { documentedComposioOperationSemantic } from '../../integrations/composio/operation-semantics.js';
import { loadExpectedWorkContract, type AcceptedTaskWorkContractV1 } from './expected-work-contract.js';
import { openEventLog } from './eventlog.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import { expectedTaskFor, type AcceptedTaskExpectation } from './resolution-ledger.js';
import {
  isPlainOrClementineLocalTool,
  isTrustedComposioGateway,
} from './runtime-tool-identity.js';
import type { TurnGraphIR } from '../graph/turn-graph-ir.js';
import { exactActivatedPlanTaskAuthority } from './plan-task-post-settlement.js';

export type AcceptedTaskCreateApprovalDecision =
  | { status: 'covered'; reservationKey: string }
  | { status: 'approval_required'; reason: string };

export interface AcceptedTaskCreateApprovalAuthoritySnapshot {
  expectation: AcceptedTaskExpectation;
  graph: TurnGraphIR;
  contract: AcceptedTaskWorkContractV1;
  priorRequirementBindings: number;
}

export interface ExactHostCreateApprovalInput {
  outerToolName: string;
  outerArgs: Record<string, unknown>;
  logicalToolName: string;
  logicalArgs: Record<string, unknown>;
  attestation: HostCallAttestation;
  manifest: CapabilityManifestV1;
  authority: AcceptedTaskCreateApprovalAuthoritySnapshot;
  reservedInBatch: ReadonlySet<string>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(String(value));
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function decodedObject(value: unknown): Record<string, unknown> | null {
  let decoded = value;
  if (typeof decoded === 'string') {
    try {
      decoded = JSON.parse(decoded) as unknown;
    } catch {
      return null;
    }
  }
  return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
    ? decoded as Record<string, unknown>
    : null;
}

function approvalRequired(reason: string): AcceptedTaskCreateApprovalDecision {
  return { status: 'approval_required', reason };
}

function exactDestinationBindingMatches(input: ExactHostCreateApprovalInput): boolean {
  const destinations = input.authority.graph.classification.goalConstraints?.destinations;
  const projected = input.authority.graph.classification.goalConstraints?.destination;
  const sinks = destinations && destinations.length > 0
    ? destinations
    : projected
      ? [projected]
      : [];
  if (sinks.length !== 1) return false;
  const sink = sinks[0]!;
  const binding = sink.binding;
  if (sink.posture !== 'create_new' || !binding) return false;
  return binding.manifestId === input.attestation.manifestId
    && binding.manifestDigest === input.attestation.manifestDigest
    && binding.accountId === input.attestation.accountId
    && binding.operationId === input.attestation.operationId
    && binding.schemaVersion === input.manifest.operationVersion
    && binding.definitionFingerprint === input.attestation.schemaFingerprint
    && binding.effect === 'external_write'
    && binding.posture === 'create_new';
}

/** Prove the business payload carried by work_call. The model-visible broker
 * shape is normally `work_call -> composio_execute_tool -> {tool_slug,
 * arguments}`; an already-resolved direct catalog identifier remains a valid
 * compatibility shape, but receives no weaker checks. */
function exactWorkCarrierMatches(input: ExactHostCreateApprovalInput): boolean {
  const carrierName = typeof input.outerArgs.name === 'string'
    ? input.outerArgs.name.trim()
    : '';
  const carrierArgs = decodedObject(input.outerArgs.args_json);
  if (!carrierName || !carrierArgs) return false;

  if (carrierName === input.attestation.operationId) {
    return canonicalJson(carrierArgs) === canonicalJson(input.logicalArgs);
  }
  if (!isTrustedComposioGateway(carrierName)) return false;
  const allowedGatewayKeys = new Set(['tool_slug', 'arguments', 'connected_account_id']);
  if (Object.keys(carrierArgs).some((key) => !allowedGatewayKeys.has(key))) return false;
  if (carrierArgs.tool_slug !== input.attestation.operationId) return false;
  const selectedAccount = carrierArgs.connected_account_id;
  if (
    selectedAccount !== undefined
    && selectedAccount !== null
    && selectedAccount !== input.attestation.accountId
  ) return false;
  const businessArgs = carrierArgs.arguments === null
    ? {}
    : decodedObject(carrierArgs.arguments);
  return Boolean(
    businessArgs
    && canonicalJson(businessArgs) === canonicalJson(input.logicalArgs),
  );
}

/** Pure decision over already-loaded durable authority. Any uncertainty keeps
 * the host's ordinary approval floor. */
export function evaluateAcceptedTaskSingleSheetCreateApproval(
  input: ExactHostCreateApprovalInput,
): AcceptedTaskCreateApprovalDecision {
  const { attestation, authority } = input;
  if (!isPlainOrClementineLocalTool(input.outerToolName, 'work_call')) {
    return approvalRequired('the call is not the accepted-work carrier');
  }
  if (attestation.bindingKind !== 'catalog_manifest' || attestation.effect !== 'external_write') {
    return approvalRequired('the exact call is not a catalog-bound external write');
  }
  const outerContract = durableLogicalCallContract(
    attestation.acceptedTaskId,
    input.outerToolName,
    input.outerArgs,
  );
  if (
    !outerContract
    || outerContract.toolName !== attestation.toolName
    || outerContract.argumentDigest !== attestation.argumentDigest
  ) return approvalRequired('the outer logical-call identity does not match its attestation');

  const allowedOuterKeys = new Set([
    'proposal',
    'requirement_id',
    'universe_item_id',
    'universe_selector',
    'seal_amendment',
    'name',
    'args_json',
  ]);
  if (Object.keys(input.outerArgs).some((key) => !allowedOuterKeys.has(key))) {
    return approvalRequired('the work carrier contains an unknown field');
  }
  if (
    input.outerArgs.proposal !== null
    || input.outerArgs.universe_item_id !== null
    || input.outerArgs.universe_selector !== null
    || (input.outerArgs.seal_amendment !== undefined && input.outerArgs.seal_amendment !== null)
  ) return approvalRequired('the work carrier is not the exact frozen once-cardinality call');
  if (!exactWorkCarrierMatches(input)) {
    return approvalRequired('the work carrier does not reproduce the exact trusted gateway invocation');
  }

  const manifest = currentCapabilityManifest(input.manifest);
  const semantic = manifest
    ? documentedComposioOperationSemantic(manifest.operationId)
    : null;
  if (
    !manifest
    || manifest.providerKind !== 'composio'
    || manifest.effect !== 'external_write'
    || manifest.destination?.posture !== 'create_new'
    || manifest.operationId !== input.logicalToolName
    || manifest.operationId !== attestation.operationId
    || manifest.manifestId !== attestation.manifestId
    || capabilityManifestDigest(manifest) !== attestation.manifestDigest
    || manifest.definitionFingerprint !== attestation.schemaFingerprint
    || manifest.accountId !== attestation.accountId
    || manifest.invokePortId !== attestation.invokePortId
    || semantic?.effect !== 'write'
    || semantic.reversibility !== 'reversible'
    || semantic.consequence !== 'create'
    || semantic.rootArtifact?.provider !== 'googlesheets'
  ) return approvalRequired('the current manifest is not the documented reversible Google Sheet constructor');

  const expected = authority.expectation;
  const graph = authority.graph;
  if (
    expected.acceptedTaskId !== attestation.acceptedTaskId
    || expected.identity.sessionId !== attestation.sessionId
    || expected.identity.sourceUserSeq !== attestation.sourceUserSeq
    || expected.graphEventId !== authority.contract.graphEventId
    || expected.graphId !== authority.contract.graphId
    || expected.graphHash !== authority.contract.graphHash
    || graph.graphId !== expected.graphId
    || graph.compiler.graphHash !== expected.graphHash
    || graph.classification.route !== 'act'
    || graph.classification.externalEffectRequested !== true
    || graph.classification.multiItem.collectThenConstruct !== true
    || graph.classification.goalConstraints?.construct !== 'collect_then_construct'
    || graph.effectCeiling !== 'external_write'
    || !exactDestinationBindingMatches(input)
  ) return approvalRequired('the accepted graph does not bind this exact single create-new destination');

  const contract = authority.contract;
  const mutations = contract.operations.filter((operation) => (
    operation.effect === 'local_write'
    || operation.effect === 'external_write'
    || operation.effect === 'admin'
  ));
  const write = mutations.length === 1 ? mutations[0] : undefined;
  const foregroundPlanActivated = contract.plannerSource === 'structured_model'
    && exactActivatedPlanTaskAuthority({
      sessionId: attestation.sessionId,
      sourceUserSeq: attestation.sourceUserSeq,
      acceptedTaskId: attestation.acceptedTaskId,
      graphEventId: contract.graphEventId,
      graphId: contract.graphId,
      graphHash: contract.graphHash,
      contractId: contract.contractId,
    });
  if (
    (contract.plannerSource !== 'deterministic' && !foregroundPlanActivated)
    || contract.acceptedTaskId !== attestation.acceptedTaskId
    || !write
    || write.effect !== 'external_write'
    || write.cardinality.kind !== 'once'
    || input.outerArgs.requirement_id !== write.id
  ) return approvalRequired('the exact activated contract does not own one external create');

  const reservationKey = `${contract.contractId}\0${write.id}`;
  if (authority.priorRequirementBindings !== 0 || input.reservedInBatch.has(reservationKey)) {
    return approvalRequired('the accepted task has already claimed its one create');
  }
  return { status: 'covered', reservationKey };
}

/** Load and revalidate the exact graph/contract rows before consulting the
 * pure policy. Storage failure is approval-required, never authorization. */
export function acceptedTaskSingleSheetCreateApproval(input: Omit<
  ExactHostCreateApprovalInput,
  'authority'
>): AcceptedTaskCreateApprovalDecision {
  try {
    const expected = expectedTaskFor(input.attestation.sessionId, input.attestation.sourceUserSeq);
    if (expected.status !== 'ok') return approvalRequired(`accepted task authority is ${expected.status}`);
    const loaded = loadExpectedWorkContract(
      input.attestation.sessionId,
      input.attestation.sourceUserSeq,
    );
    if (loaded.status !== 'ok') return approvalRequired(`expected-work authority is ${loaded.status}`);
    const row = openEventLog().prepare(`
      SELECT COUNT(*) AS n
        FROM expected_work_call_bindings
       WHERE session_id = ? AND source_user_seq = ?
         AND accepted_task_id = ? AND contract_id = ?
         AND requirement_id = ? AND effect_kind = 'external_write'
    `).get(
      input.attestation.sessionId,
      input.attestation.sourceUserSeq,
      input.attestation.acceptedTaskId,
      loaded.contract.contractId,
      String(input.outerArgs.requirement_id ?? ''),
    ) as { n: number };
    return evaluateAcceptedTaskSingleSheetCreateApproval({
      ...input,
      authority: {
        expectation: expected.expectation,
        graph: expected.graph,
        contract: loaded.contract,
        priorRequirementBindings: row.n,
      },
    });
  } catch {
    return approvalRequired('accepted task approval authority is unreadable');
  }
}
