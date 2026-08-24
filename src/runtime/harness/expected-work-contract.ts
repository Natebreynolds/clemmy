/**
 * Immutable expected-work authority for one exact accepted source.
 *
 * Expected operations are fixed before business dispatch and never inferred
 * from calls that happened to run.  This first bounded slice deliberately
 * compiles only the two topologies the host already knows exactly:
 * conversation (zero work) and retrieval (one complete-set read).  Arbitrary
 * action topology must arrive through the explicit validated proposal API;
 * wiring that API to a bounded model planner is a later cutover.
 *
 * Write effects are requested outcomes, not permission. Runtime tool
 * admission, approval and effect classification remain dispatch authority.
 */
import type Database from 'better-sqlite3';
import type { TurnGraphIR } from '../graph/turn-graph-ir.js';
import { validateTurnGraph } from '../graph/turn-graph-compiler.js';
import { assertAuthorityConsistency } from '../graph/accepted-goal.js';
import {
  WORK_TOPOLOGY_MAX_OPERATIONS,
  WORK_TOPOLOGY_MAX_UNIVERSE_MEMBERS,
  WORK_TOPOLOGY_MAX_UNIVERSES,
  WORK_TOPOLOGY_VERSION,
  canonicalWorkTopologyJson,
  isBoundedWorkTopologyJsonPointer,
  resolveWorkTopologyJsonPointer,
  validateWorkTopology,
  workTopologyDigest,
  workTopologySha256,
  type WorkTopologyCardinalityV1,
  type WorkTopologyCoverageV1,
  type WorkTopologyEffectV1,
  type WorkTopologyOperationV1,
  type WorkTopologyUniverseV1,
  type WorkTopologyV1,
} from '../graph/work-topology.js';
import { BoundaryError } from '../boundary-error.js';
import { armAcceptedTaskAuthority } from './accepted-task-authority.js';
import { openEventLog } from './eventlog.js';
import { expectedTaskFor } from './resolution-ledger.js';

export const EXPECTED_WORK_CONTRACT_VERSION = WORK_TOPOLOGY_VERSION;
export const EXPECTED_WORK_MAX_OPERATIONS = WORK_TOPOLOGY_MAX_OPERATIONS;
export const EXPECTED_WORK_MAX_UNIVERSES = WORK_TOPOLOGY_MAX_UNIVERSES;
export const EXPECTED_WORK_MAX_UNIVERSE_MEMBERS = WORK_TOPOLOGY_MAX_UNIVERSE_MEMBERS;

/** Backward-compatible names. The types and runtime grammar have one owner in
 * runtime/graph/work-topology.ts. */
export type ExpectedWorkEffectV1 = WorkTopologyEffectV1;
export type ExpectedWorkCoverageV1 = WorkTopologyCoverageV1;
export type ExpectedWorkCardinalityV1 = WorkTopologyCardinalityV1;
export type ExpectedWorkOperationV1 = WorkTopologyOperationV1;
export type ExpectedWorkUniverseV1 = WorkTopologyUniverseV1;
export type ExpectedWorkProposalV1 = WorkTopologyV1;

export type ExpectedWorkPlannerSourceV1 = 'deterministic' | 'structured_model';

export interface AcceptedTaskWorkContractV1 extends ExpectedWorkProposalV1 {
  contractId: string;
  identity: {
    sessionId: string;
    sourceUserSeq: number;
    turn: number;
  };
  acceptedTaskId: string;
  graphEventId: string;
  graphId: string;
  graphHash: string;
  /** Digest of the normalized operations+universes value. Older durable rows
   * predate this field; every newly frozen contract includes it. */
  topologyHash?: string;
  plannerSource: ExpectedWorkPlannerSourceV1;
}

export type ExpectedWorkProposalValidation =
  | { ok: true; proposal: ExpectedWorkProposalV1 }
  | { ok: false; errors: string[] };

/**
 * A collect-then-construct request with a communication effect has two
 * distinct mutations: construct the artifact, then deliver its verified
 * handle. The graph already carries both facts, so this boundary never needs
 * provider names or another prose classifier to recognize the compound shape.
 */
export function requiresPostConstructCommunicationDelivery(graph: TurnGraphIR): boolean {
  return graph.classification.multiItem.collectThenConstruct
    && graph.classification.externalEffectKinds.includes('communication');
}

interface ContractRow {
  session_id: string;
  source_user_seq: number;
  accepted_task_id: string;
  contract_version: number;
  contract_id: string;
  graph_event_id: string;
  graph_id: string;
  graph_hash: string;
  planner_source: ExpectedWorkPlannerSourceV1;
  contract_json: string;
  operation_count: number;
  universe_count: number;
  fixed_at: string;
}

interface AuthorityContractRow {
  accepted_task_id: string;
  graph_event_id: string;
  graph_id: string;
  graph_hash: string;
  work_contract_id: string | null;
  state: 'armed' | 'manifested_verifying' | 'terminal' | 'conflict';
  revision: number;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export const isBoundedJsonPointer = isBoundedWorkTopologyJsonPointer;
export const resolveJsonPointer = resolveWorkTopologyJsonPointer;

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errors: string[],
): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) errors.push(`${label} contains unknown field ${key}`);
  }
}

export const canonicalExpectedWorkJson = canonicalWorkTopologyJson;
export const expectedWorkDigest = workTopologySha256;

/** Validate and canonicalize an untrusted planner proposal. */
export function validateExpectedWorkProposal(value: unknown): ExpectedWorkProposalValidation {
  const validated = validateWorkTopology(value);
  return validated.ok
    ? { ok: true, proposal: validated.topology }
    : validated;
}

/** The only topologies V1 can derive without another reasoning result. */
export function compileDeterministicExpectedWorkProposal(
  graph: TurnGraphIR,
): ExpectedWorkProposalV1 | null {
  if (!validateTurnGraph(graph).ok) return null;
  if (graph.classification.route === 'direct_reply') {
    return { version: EXPECTED_WORK_CONTRACT_VERSION, operations: [], universes: [] };
  }
  if (graph.classification.route === 'act' && graph.classification.multiItem.collectThenConstruct) {
    // The V1 deterministic compiler owns only one construct write. Freezing
    // that smaller topology would erase the later communication effect. A
    // complete structured proposal must name and order both effects instead.
    if (requiresPostConstructCommunicationDelivery(graph)) return null;
    const retrieves = graph.nodes.filter((node) => node.kind === 'retrieve' && node.effect.kind === 'read');
    const execute = graph.nodes.find((node) => node.kind === 'execute');
    if (retrieves.length === 0 || !execute) return null;
    const writeEffect = execute.effect.kind === 'local_write' || execute.effect.kind === 'admin'
      ? execute.effect.kind
      : 'external_write';
    const countedCollection = graph.classification.goalConstraints?.collection;
    const readOps = retrieves.map((retrieve, index) => {
      const prior = retrieves[index - 1];
      const collectsAcceptedSet = index === retrieves.length - 1
        && (countedCollection?.count ?? 0) > 0;
      return {
        id: retrieve.id,
        effect: 'read' as const,
        // Locator reads remain unresolved: a source URL cannot seal the
        // collection. The final aggregate read for an accepted counted
        // collect-then-construct goal is different. The graph already owns
        // the immutable set cardinality/projection, so this requirement must
        // bind as collection evidence instead of escaping through the
        // unbound-read fallback.
        coverage: collectsAcceptedSet
          ? 'complete_set' as const
          : 'resolved_operation' as const,
        dependsOn: prior ? [prior.id] : [],
        dataFrom: prior ? [prior.id] : [],
        cardinality: { kind: 'once' as const },
      };
    });
    const lastReadId = retrieves[retrieves.length - 1]!.id;
    return {
      version: EXPECTED_WORK_CONTRACT_VERSION,
      operations: [
        ...readOps,
        {
          id: execute.id,
          effect: writeEffect,
          dependsOn: [lastReadId],
          dataFrom: [lastReadId],
          cardinality: { kind: 'once' },
        },
      ],
      universes: [],
    };
  }
  if (graph.classification.route !== 'retrieve') return null;
  const reads = graph.nodes.filter((node) => node.kind === 'retrieve' && node.effect.kind === 'read');
  if (reads.length !== 1) return null;
  return {
    version: EXPECTED_WORK_CONTRACT_VERSION,
    operations: [{
      id: reads[0]!.id,
      effect: 'read',
      coverage: 'resolved_operation',
      dependsOn: [],
      dataFrom: [],
      cardinality: { kind: 'once' },
    }],
    universes: [],
  };
}

function contractMaterial(contract: Omit<AcceptedTaskWorkContractV1, 'contractId'>): unknown {
  return {
    version: contract.version,
    identity: contract.identity,
    acceptedTaskId: contract.acceptedTaskId,
    graphEventId: contract.graphEventId,
    graphId: contract.graphId,
    graphHash: contract.graphHash,
    ...(contract.topologyHash ? { topologyHash: contract.topologyHash } : {}),
    plannerSource: contract.plannerSource,
    operations: contract.operations,
    universes: contract.universes,
  };
}

function buildContract(input: {
  proposal: ExpectedWorkProposalV1;
  plannerSource: ExpectedWorkPlannerSourceV1;
  expected: Extract<ReturnType<typeof expectedTaskFor>, { status: 'ok' }>;
}): AcceptedTaskWorkContractV1 {
  const body: Omit<AcceptedTaskWorkContractV1, 'contractId'> = {
    version: EXPECTED_WORK_CONTRACT_VERSION,
    identity: { ...input.expected.expectation.identity },
    acceptedTaskId: input.expected.expectation.acceptedTaskId,
    graphEventId: input.expected.expectation.graphEventId,
    graphId: input.expected.expectation.graphId,
    graphHash: input.expected.expectation.graphHash,
    topologyHash: workTopologyDigest(input.proposal),
    plannerSource: input.plannerSource,
    operations: input.proposal.operations,
    universes: input.proposal.universes,
  };
  return {
    ...body,
    contractId: `expected-work:v1:${expectedWorkDigest(canonicalExpectedWorkJson(contractMaterial(body)))}`,
  };
}

function validateContractValue(value: unknown): AcceptedTaskWorkContractV1 | null {
  if (!plainRecord(value)) return null;
  const errors: string[] = [];
  exactKeys(value, [
    'version', 'contractId', 'identity', 'acceptedTaskId', 'graphEventId',
    'graphId', 'graphHash', 'topologyHash', 'plannerSource', 'operations', 'universes',
  ], 'contract', errors);
  if (!plainRecord(value.identity)) return null;
  exactKeys(value.identity, ['sessionId', 'sourceUserSeq', 'turn'], 'contract.identity', errors);
  if (typeof value.identity.sessionId !== 'string' || !value.identity.sessionId.trim()) return null;
  if (!Number.isSafeInteger(value.identity.sourceUserSeq) || Number(value.identity.sourceUserSeq) <= 0) return null;
  if (!Number.isSafeInteger(value.identity.turn) || Number(value.identity.turn) < 0) return null;
  for (const field of ['acceptedTaskId', 'graphEventId', 'graphId'] as const) {
    if (typeof value[field] !== 'string' || !value[field]) errors.push(`contract.${field} is invalid`);
  }
  if (typeof value.graphHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.graphHash)) {
    errors.push('contract.graphHash is invalid');
  }
  if (value.topologyHash !== undefined && (
    typeof value.topologyHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.topologyHash)
  )) errors.push('contract.topologyHash is invalid');
  if (value.plannerSource !== 'deterministic' && value.plannerSource !== 'structured_model') {
    errors.push('contract.plannerSource is invalid');
  }
  const proposal = validateExpectedWorkProposal({
    version: value.version,
    operations: value.operations,
    universes: value.universes,
  });
  if (!proposal.ok) errors.push(...proposal.errors);
  if (
    proposal.ok
    && value.topologyHash !== undefined
    && value.topologyHash !== workTopologyDigest(proposal.proposal)
  ) errors.push('contract.topologyHash does not match the normalized topology');
  if (errors.length > 0 || !proposal.ok) return null;
  const body: Omit<AcceptedTaskWorkContractV1, 'contractId'> = {
    version: EXPECTED_WORK_CONTRACT_VERSION,
    identity: {
      sessionId: value.identity.sessionId,
      sourceUserSeq: Number(value.identity.sourceUserSeq),
      turn: Number(value.identity.turn),
    },
    acceptedTaskId: String(value.acceptedTaskId),
    graphEventId: String(value.graphEventId),
    graphId: String(value.graphId),
    graphHash: String(value.graphHash),
    ...(typeof value.topologyHash === 'string' ? { topologyHash: value.topologyHash } : {}),
    plannerSource: value.plannerSource as ExpectedWorkPlannerSourceV1,
    operations: proposal.proposal.operations,
    universes: proposal.proposal.universes,
  };
  const contractId = `expected-work:v1:${expectedWorkDigest(canonicalExpectedWorkJson(contractMaterial(body)))}`;
  if (value.contractId !== contractId) return null;
  return { ...body, contractId };
}

function readContractRow(
  db: Database.Database,
  sessionId: string,
  sourceUserSeq: number,
): ContractRow | undefined {
  return db.prepare(`
    SELECT * FROM accepted_task_work_contracts
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, sourceUserSeq) as ContractRow | undefined;
}

function readAuthorityRow(
  db: Database.Database,
  sessionId: string,
  sourceUserSeq: number,
): AuthorityContractRow | undefined {
  return db.prepare(`
    SELECT accepted_task_id, graph_event_id, graph_id, graph_hash,
           work_contract_id, state, revision
      FROM accepted_task_authority
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, sourceUserSeq) as AuthorityContractRow | undefined;
}

function rowContract(row: ContractRow): AcceptedTaskWorkContractV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.contract_json);
  } catch {
    return null;
  }
  const contract = validateContractValue(parsed);
  if (!contract) return null;
  if (
    row.contract_version !== EXPECTED_WORK_CONTRACT_VERSION
    || row.contract_id !== contract.contractId
    || row.session_id !== contract.identity.sessionId
    || row.source_user_seq !== contract.identity.sourceUserSeq
    || row.accepted_task_id !== contract.acceptedTaskId
    || row.graph_event_id !== contract.graphEventId
    || row.graph_id !== contract.graphId
    || row.graph_hash !== contract.graphHash
    || row.planner_source !== contract.plannerSource
    || row.operation_count !== contract.operations.length
    || row.universe_count !== contract.universes.length
    || row.contract_json !== canonicalExpectedWorkJson(contract)
  ) return null;
  return contract;
}

function boundedReason(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 180);
}

export type LoadExpectedWorkContractResult =
  | { status: 'ok'; contract: AcceptedTaskWorkContractV1 }
  | { status: 'missing' }
  | { status: 'conflict' | 'corrupt' | 'storage_error'; reason: string };

/** Rehydrate and revalidate identity, graph binding, canonical bytes and hash. */
export function loadExpectedWorkContract(
  sessionId: string,
  sourceUserSeq: number,
): LoadExpectedWorkContractResult {
  try {
    const db = openEventLog();
    const authority = readAuthorityRow(db, sessionId, sourceUserSeq);
    const row = readContractRow(db, sessionId, sourceUserSeq);
    if (!authority && !row) return { status: 'missing' };
    if (!authority) return { status: 'corrupt', reason: 'expected-work contract has no accepted authority' };
    if (authority.state === 'conflict') return { status: 'conflict', reason: 'accepted task authority is conflicted' };
    if (!authority.work_contract_id && !row) return { status: 'missing' };
    if (!authority.work_contract_id || !row) {
      return { status: 'corrupt', reason: 'expected-work marker and contract row disagree' };
    }
    const contract = rowContract(row);
    if (!contract) return { status: 'corrupt', reason: 'expected-work contract bytes or address are invalid' };
    if (
      authority.work_contract_id !== contract.contractId
      || authority.accepted_task_id !== contract.acceptedTaskId
      || authority.graph_event_id !== contract.graphEventId
      || authority.graph_id !== contract.graphId
      || authority.graph_hash !== contract.graphHash
    ) return { status: 'corrupt', reason: 'expected-work contract does not match accepted authority' };
    const expected = expectedTaskFor(sessionId, sourceUserSeq);
    if (
      expected.status !== 'ok'
      || expected.expectation.acceptedTaskId !== contract.acceptedTaskId
      || expected.expectation.graphEventId !== contract.graphEventId
      || expected.expectation.graphId !== contract.graphId
      || expected.expectation.graphHash !== contract.graphHash
    ) return { status: 'corrupt', reason: 'expected-work contract no longer matches its exact graph' };
    return { status: 'ok', contract };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export type FreezeExpectedWorkContractResult =
  | { status: 'fixed' | 'replayed'; contract: AcceptedTaskWorkContractV1 }
  | { status: 'planning_required' | 'invalid' | 'missing' | 'conflict' | 'storage_error'; reason: string };

const COMPOUND_DELIVERY_TOPOLOGY_ERROR =
  'a collect-then-construct communication must freeze exactly source read -> construct write -> verification read -> terminal external write';

function hasOnlyDependency(operation: ExpectedWorkOperationV1, dependencyId: string): boolean {
  return operation.dependsOn.length === 1 && operation.dependsOn[0] === dependencyId;
}

function hasOnlyDataSource(operation: ExpectedWorkOperationV1, sourceId: string): boolean {
  return operation.dataFrom.length === 1 && operation.dataFrom[0] === sourceId;
}

/**
 * V1 has no provider or semantic-operation roles, so the only honest complete
 * compound contract is the exact four-stage DAG. The first write is defined
 * structurally as construction; the verified readback is its sole successor;
 * the final external write is delivery and consumes only that verification.
 */
function hasCompletePostConstructCommunicationTopology(
  proposal: ExpectedWorkProposalV1,
): boolean {
  if (proposal.operations.length !== 4 || proposal.universes.length !== 0) return false;
  if (proposal.operations.some((operation) => operation.cardinality.kind !== 'once')) return false;

  const reads = proposal.operations.filter((operation) => operation.effect === 'read');
  const writes = proposal.operations.filter((operation) => (
    operation.effect === 'local_write' || operation.effect === 'external_write'
  ));
  if (reads.length !== 2 || writes.length !== 2) return false;

  const terminalCandidates = writes.filter((operation) => (
    operation.effect === 'external_write'
    && !proposal.operations.some((candidate) => candidate.dependsOn.includes(operation.id))
  ));
  if (terminalCandidates.length !== 1) return false;
  const terminal = terminalCandidates[0]!;
  if (
    terminal.dependsOn.length !== 1
    || terminal.dataFrom.length !== 1
    || terminal.dependsOn[0] !== terminal.dataFrom[0]
  ) return false;

  const verification = reads.find((operation) => operation.id === terminal.dependsOn[0]);
  if (!verification || verification.dataFrom.length !== 0) return false;

  const construct = writes.find((operation) => operation.id !== terminal.id);
  if (!construct || !hasOnlyDependency(verification, construct.id)) return false;

  const source = reads.find((operation) => operation.id !== verification.id);
  if (!source || source.dependsOn.length !== 0 || source.dataFrom.length !== 0) return false;
  if (!hasOnlyDependency(construct, source.id) || !hasOnlyDataSource(construct, source.id)) return false;

  return hasOnlyDependency(terminal, verification.id)
    && hasOnlyDataSource(terminal, verification.id);
}

function validateActionProposalForGraph(
  proposal: ExpectedWorkProposalV1,
  graph: TurnGraphIR,
): string[] {
  const errors: string[] = [];
  const readOnlyRetrieve = graph.classification.route === 'retrieve'
    && graph.effectCeiling === 'read'
    && proposal.operations.every((operation) => operation.effect === 'read' || operation.effect === 'compute');
  if (graph.classification.route !== 'act' && !readOnlyRetrieve) {
    errors.push('explicit action contracts require an action graph');
  }
  if (proposal.operations.length === 0) errors.push('an action contract cannot contain zero operations');
  // `tool_intent` is an admitted planning uncertainty, not an affirmative
  // mutation. Its model-owned proposal may legitimately resolve the unknown
  // topology to a read. A typed action (including every direct external
  // effect), however, cannot be weakened to observation-only work.
  // An admitted READ ceiling is the exception, not a weakening: the model
  // authored read-only semantics, the judges entailed them, and the clamp
  // sealed a read ceiling — a vocabulary intent classifier may not override
  // that exact authority to refuse the single-read act (write ceilings stay
  // protected by the explicit outcome checks below).
  const affirmativeAction = (graph.classification.messageIntent === 'action'
    || graph.classification.externalEffectRequested)
    && graph.effectCeiling !== 'read';
  if (
    affirmativeAction
    && !proposal.operations.some((operation) => operation.effect !== 'read')
  ) {
    errors.push('an action graph cannot be weakened to read-only work');
  }
  if (proposal.operations.some((operation) => operation.coverage === 'resolved_operation')) {
    errors.push('resolved_operation coverage is host-only and unavailable to structured action proposals');
  }
  if (
    graph.classification.externalEffectRequested
    && !proposal.operations.some((operation) => operation.effect === 'external_write')
  ) errors.push('the accepted external effect requires an external-write outcome');
  for (const requiredEffect of ['local_write', 'external_write', 'admin'] as const) {
    if (
      graph.effectCeiling === requiredEffect
      && !proposal.operations.some((operation) => operation.effect === requiredEffect)
    ) errors.push(`the accepted ${requiredEffect} ceiling requires the same outcome effect`);
  }
  if (
    graph.effectCeiling === 'compute'
    && !proposal.operations.some((operation) => operation.effect === 'compute')
  ) errors.push('the accepted compute effect requires a compute outcome');
  if (
    requiresPostConstructCommunicationDelivery(graph)
    && !hasCompletePostConstructCommunicationTopology(proposal)
  ) errors.push(COMPOUND_DELIVERY_TOPOLOGY_ERROR);
  if (graph.classification.multiItem.collectThenConstruct) {
    if (proposal.operations.some((operation) => (
      operation.effect !== 'read' && operation.cardinality.kind !== 'once'
    ))) {
      errors.push('a collect-then-construct graph cannot freeze per-item writes');
    }
    if (!proposal.operations.some((operation) => (
      operation.effect !== 'read' && operation.cardinality.kind === 'once'
    ))) {
      errors.push('a collect-then-construct graph requires one once-cardinality write');
    }
  } else if (
    graph.classification.multiItem.detected
    && !proposal.operations.some((operation) => operation.cardinality.kind !== 'once')
  ) errors.push('the accepted fanout shape requires an each-cardinality operation');
  return errors;
}

function poisonAuthority(
  db: Database.Database,
  input: { sessionId: string; sourceUserSeq: number },
  row: AuthorityContractRow,
): void {
  if (row.state !== 'armed' && row.state !== 'manifested_verifying') return;
  db.prepare(`
    UPDATE accepted_task_authority
       SET state = 'conflict', revision = revision + 1, updated_at = ?
     WHERE session_id = ? AND source_user_seq = ?
       AND state = ? AND revision = ?
  `).run(
    new Date().toISOString(),
    input.sessionId,
    input.sourceUserSeq,
    row.state,
    row.revision,
  );
}

/** Transaction-local primitive shared by deterministic freezing and the
 * fused action-call admission. The caller owns an IMMEDIATE transaction. */
export function freezePreparedExpectedWorkContractInTransaction(
  db: Database.Database,
  input: {
  sessionId: string;
  sourceUserSeq: number;
  contract: AcceptedTaskWorkContractV1;
  },
): FreezeExpectedWorkContractResult {
      const authority = readAuthorityRow(db, input.sessionId, input.sourceUserSeq);
      if (!authority) return { status: 'missing', reason: 'accepted task authority is not armed' };
      if (authority.state === 'conflict') {
        return { status: 'conflict', reason: 'accepted task authority is already conflicted' };
      }
      if (
        authority.accepted_task_id !== input.contract.acceptedTaskId
        || authority.graph_event_id !== input.contract.graphEventId
        || authority.graph_id !== input.contract.graphId
        || authority.graph_hash !== input.contract.graphHash
      ) {
        poisonAuthority(db, input, authority);
        return { status: 'conflict', reason: 'expected-work contract does not refine the accepted graph' };
      }
      const existing = readContractRow(db, input.sessionId, input.sourceUserSeq);
      if (existing) {
        const prior = rowContract(existing);
        if (
          prior
          && prior.contractId === input.contract.contractId
          && authority.work_contract_id === prior.contractId
        ) return { status: 'replayed', contract: prior };
        poisonAuthority(db, input, authority);
        return { status: 'conflict', reason: 'a different or unreadable expected-work contract already won' };
      }
      if (authority.work_contract_id) {
        poisonAuthority(db, input, authority);
        return { status: 'conflict', reason: 'accepted authority names a missing expected-work contract' };
      }
      if (authority.state !== 'armed') {
        return { status: 'conflict', reason: `expected work cannot first freeze from ${authority.state}` };
      }
      const at = new Date().toISOString();
      db.prepare(`
        INSERT INTO accepted_task_work_contracts
          (session_id, source_user_seq, accepted_task_id, contract_version,
           contract_id, graph_event_id, graph_id, graph_hash, planner_source,
           contract_json, operation_count, universe_count, fixed_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.sessionId,
        input.sourceUserSeq,
        input.contract.acceptedTaskId,
        input.contract.contractId,
        input.contract.graphEventId,
        input.contract.graphId,
        input.contract.graphHash,
        input.contract.plannerSource,
        canonicalExpectedWorkJson(input.contract),
        input.contract.operations.length,
        input.contract.universes.length,
        at,
      );
      const bound = db.prepare(`
        UPDATE accepted_task_authority
           SET work_contract_id = ?, revision = revision + 1, updated_at = ?
         WHERE session_id = ? AND source_user_seq = ?
           AND state = 'armed' AND revision = ? AND work_contract_id IS NULL
      `).run(
        input.contract.contractId,
        at,
        input.sessionId,
        input.sourceUserSeq,
        authority.revision,
      );
      if (bound.changes !== 1) throw new Error('expected-work contract lost its authority CAS');
      return { status: 'fixed', contract: input.contract };
}

function freezePreparedContract(input: {
  sessionId: string;
  sourceUserSeq: number;
  contract: AcceptedTaskWorkContractV1;
}): FreezeExpectedWorkContractResult {
  try {
    const db = openEventLog();
    const transaction = db.transaction((): FreezeExpectedWorkContractResult =>
      freezePreparedExpectedWorkContractInTransaction(db, input));
    return transaction.immediate();
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export type PrepareActionExpectedWorkContractResult =
  | { status: 'prepared'; contract: AcceptedTaskWorkContractV1 }
  | { status: 'invalid' | 'missing' | 'conflict'; reason: string };

/** Pure-with-respect-to-work-contract preparation for the fused action seam.
 * Accepted graph/authority must already exist; this function writes neither a
 * contract nor a call binding. */
export function prepareActionExpectedWorkContract(input: {
  sessionId: string;
  sourceUserSeq: number;
  proposal: unknown;
}): PrepareActionExpectedWorkContractResult {
  const expected = expectedTaskFor(input.sessionId, input.sourceUserSeq);
  if (expected.status !== 'ok') {
    return {
      status: expected.status === 'missing' ? 'missing' : 'conflict',
      reason: expected.reason,
    };
  }
  const validated = validateExpectedWorkProposal(input.proposal);
  if (!validated.ok) return { status: 'invalid', reason: validated.errors.join('; ') };
  const graphErrors = validateActionProposalForGraph(validated.proposal, expected.graph);
  if (graphErrors.length > 0) return { status: 'invalid', reason: graphErrors.join('; ') };
  return {
    status: 'prepared',
    contract: buildContract({
      proposal: validated.proposal,
      plannerSource: 'structured_model',
      expected,
    }),
  };
}

function exactExpectedTask(input: {
  sessionId: string;
  sourceUserSeq: number;
}): Extract<ReturnType<typeof expectedTaskFor>, { status: 'ok' }> | FreezeExpectedWorkContractResult {
  const expected = expectedTaskFor(input.sessionId, input.sourceUserSeq);
  if (expected.status !== 'ok') {
    return {
      status: expected.status === 'missing' ? 'missing' : 'conflict',
      reason: expected.reason,
    };
  }
  const armed = armAcceptedTaskAuthority(input);
  if (armed.status !== 'armed' && armed.status !== 'existing') {
    const failure = armed as Extract<typeof armed, { reason: string }>;
    return {
      status: armed.status === 'missing' ? 'missing' : armed.status,
      reason: failure.reason,
    };
  }
  return expected;
}

export function freezeDeterministicExpectedWorkContract(input: {
  sessionId: string;
  sourceUserSeq: number;
}): FreezeExpectedWorkContractResult {
  const expected = exactExpectedTask(input);
  if ('status' in expected && expected.status !== 'ok') return expected;
  let proposal = compileDeterministicExpectedWorkProposal(expected.graph);
  if (!proposal) {
    return { status: 'planning_required', reason: 'action topology requires one explicit bounded proposal' };
  }
  const validated = validateExpectedWorkProposal(proposal);
  if (!validated.ok) return { status: 'invalid', reason: validated.errors.join('; ') };
  const consistent = assertAuthorityConsistency({
    graph: expected.graph,
    contract: validated.proposal,
  });
  if (!consistent.ok) return { status: 'invalid', reason: consistent.reason };
  return freezePreparedContract({
    ...input,
    contract: buildContract({
      proposal: validated.proposal,
      plannerSource: 'deterministic',
      expected,
    }),
  });
}

/**
 * Freeze the exact normalized topology already hash-bound into the graph that
 * the foreground model authored through plan_task. No second compiler may
 * project a smaller once-only DAG and erase explicit each/set cardinality.
 */
export function freezePrimaryModelExpectedWorkContract(input: {
  sessionId: string;
  sourceUserSeq: number;
}): FreezeExpectedWorkContractResult {
  const expected = exactExpectedTask(input);
  if ('status' in expected && expected.status !== 'ok') return expected;
  const graphTopology = expected.graph.workTopology;
  if (!graphTopology) {
    return {
      status: 'planning_required',
      reason: 'the foreground plan graph has no exact accepted work topology',
    };
  }
  const validated = validateExpectedWorkProposal(graphTopology.topology);
  if (!validated.ok) return { status: 'invalid', reason: validated.errors.join('; ') };
  const topologyHash = workTopologyDigest(validated.proposal);
  if (topologyHash !== graphTopology.topologyHash) {
    return { status: 'invalid', reason: 'the foreground plan topology does not match its graph-bound digest' };
  }
  const consistent = assertAuthorityConsistency({
    graph: expected.graph,
    contract: validated.proposal,
  });
  if (!consistent.ok) return { status: 'invalid', reason: consistent.reason };
  return freezePreparedContract({
    ...input,
    contract: buildContract({
      proposal: validated.proposal,
      plannerSource: 'structured_model',
      expected,
    }),
  });
}

export type RequireKnownExpectedWorkContractResult =
  | { status: 'bound'; contract: AcceptedTaskWorkContractV1 }
  | { status: 'action_deferred' };

/**
 * Staged production cutover. Direct, retrieve, and collect-then-construct
 * acts have exact host-known topology, so they bind before provider
 * construction. Other actions stay deferred until an explicit proposal;
 * this helper never guesses one and never calls a provider itself.
 */
export function requireKnownExpectedWorkContract(input: {
  sessionId: string;
  sourceUserSeq: number;
}): RequireKnownExpectedWorkContractResult {
  const result = freezeDeterministicExpectedWorkContract(input);
  if (result.status === 'fixed' || result.status === 'replayed') {
    return { status: 'bound', contract: result.contract };
  }
  if (result.status === 'planning_required') return { status: 'action_deferred' };
  const failure = result as Extract<FreezeExpectedWorkContractResult, { reason: string }>;
  throw new BoundaryError({
    kind: result.status === 'conflict' || result.status === 'invalid'
      ? 'state.read_corrupted'
      : 'state.write_failed',
    retryable: result.status !== 'conflict' && result.status !== 'invalid',
    userMessage: 'I could not safely start that turn because its local work contract was unavailable. Please retry.',
    operatorMessage: `expected-work contract admission ${result.status}: ${failure.reason}`,
    context: {
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      expectedWorkStatus: result.status,
    },
  });
}

/**
 * Persist a later structured planner result. This API validates and freezes;
 * it does not invoke a model and it never infers a smaller action topology.
 */
export function freezeActionExpectedWorkContract(input: {
  sessionId: string;
  sourceUserSeq: number;
  proposal: unknown;
}): FreezeExpectedWorkContractResult {
  const expected = exactExpectedTask(input);
  if ('status' in expected && expected.status !== 'ok') return expected;
  const prepared = prepareActionExpectedWorkContract(input);
  if (prepared.status !== 'prepared') return prepared;
  return freezePreparedContract({
    ...input,
    contract: prepared.contract,
  });
}
