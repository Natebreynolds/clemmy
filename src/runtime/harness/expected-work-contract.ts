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
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TurnGraphIR } from '../graph/turn-graph-ir.js';
import { validateTurnGraph } from '../graph/turn-graph-compiler.js';
import { BoundaryError } from '../boundary-error.js';
import { armAcceptedTaskAuthority } from './accepted-task-authority.js';
import { openEventLog } from './eventlog.js';
import { expectedTaskFor } from './resolution-ledger.js';

export const EXPECTED_WORK_CONTRACT_VERSION = 1 as const;
export const EXPECTED_WORK_MAX_OPERATIONS = 32 as const;
export const EXPECTED_WORK_MAX_UNIVERSES = 16 as const;
export const EXPECTED_WORK_MAX_UNIVERSE_MEMBERS = 2_048 as const;

export type ExpectedWorkEffectV1 =
  | 'read'
  | 'compute'
  | 'local_write'
  | 'external_write'
  | 'admin';
export type ExpectedWorkCoverageV1 =
  | 'single'
  /** One bounded caller-selected set, not proof that the whole provider source
   * was exhausted. The exact requested members are bound at dispatch. */
  | 'accepted_set'
  | 'complete_set'
  /** The graph knows one read is owed, while the resolved operation and its
   * arguments decide whether point evidence or collection exhaustion applies. */
  | 'resolved_operation';

export type ExpectedWorkCardinalityV1 =
  | { kind: 'once' }
  | { kind: 'each'; universeId: string }
  /** One provider call covers the complete finite accepted universe. */
  | { kind: 'set'; universeId: string };

export interface ExpectedWorkOperationV1 {
  id: string;
  effect: ExpectedWorkEffectV1;
  /** Reads state whether one answer or the complete source is owed. */
  coverage?: ExpectedWorkCoverageV1;
  dependsOn: string[];
  /** Structural data lineage. Every entry must also be a dependency. */
  dataFrom: string[];
  cardinality: ExpectedWorkCardinalityV1;
}

export type ExpectedWorkUniverseV1 =
  | {
      id: string;
      seal: 'accepted_input';
      members: string[];
    }
  | {
      id: string;
      seal: 'complete_source_receipt';
      producedBy: string;
    };

export interface ExpectedWorkProposalV1 {
  version: typeof EXPECTED_WORK_CONTRACT_VERSION;
  operations: ExpectedWorkOperationV1[];
  universes: ExpectedWorkUniverseV1[];
}

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
  plannerSource: ExpectedWorkPlannerSourceV1;
}

export type ExpectedWorkProposalValidation =
  | { ok: true; proposal: ExpectedWorkProposalV1 }
  | { ok: false; errors: string[] };

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

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
const MEMBER_PATTERN = /^\S(?:[\s\S]{0,254}\S)?$/;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

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

function validId(value: unknown, label: string, errors: string[]): value is string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    errors.push(`${label} must be a bounded stable id`);
    return false;
  }
  return true;
}

function stringList(value: unknown, label: string, errors: string[]): string[] | null {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return null;
  }
  const result: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (!validId(entry, `${label}[${index}]`, errors)) continue;
    result.push(entry);
  }
  if (new Set(result).size !== result.length) errors.push(`${label} contains duplicate ids`);
  return [...result].sort();
}

export function canonicalExpectedWorkJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalExpectedWorkJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalExpectedWorkJson(record[key])}`)
    .join(',')}}`;
}

export function expectedWorkDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hasCycle(operations: readonly ExpectedWorkOperationV1[]): boolean {
  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const operation = byId.get(id);
    for (const dependency of operation?.dependsOn ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return operations.some((operation) => visit(operation.id));
}

/** Validate and canonicalize an untrusted planner proposal. */
export function validateExpectedWorkProposal(value: unknown): ExpectedWorkProposalValidation {
  const errors: string[] = [];
  if (!plainRecord(value)) return { ok: false, errors: ['proposal must be an object'] };
  exactKeys(value, ['version', 'operations', 'universes'], 'proposal', errors);
  if (value.version !== EXPECTED_WORK_CONTRACT_VERSION) errors.push('proposal version must be 1');
  if (!Array.isArray(value.operations)) errors.push('proposal operations must be an array');
  if (!Array.isArray(value.universes)) errors.push('proposal universes must be an array');
  const rawOperations = Array.isArray(value.operations) ? value.operations : [];
  const rawUniverses = Array.isArray(value.universes) ? value.universes : [];
  if (rawOperations.length > EXPECTED_WORK_MAX_OPERATIONS) {
    errors.push(`proposal exceeds ${EXPECTED_WORK_MAX_OPERATIONS} operations`);
  }
  if (rawUniverses.length > EXPECTED_WORK_MAX_UNIVERSES) {
    errors.push(`proposal exceeds ${EXPECTED_WORK_MAX_UNIVERSES} universes`);
  }

  const operations: ExpectedWorkOperationV1[] = [];
  for (const [index, raw] of rawOperations.entries()) {
    const label = `operation[${index}]`;
    if (!plainRecord(raw)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    exactKeys(raw, ['id', 'effect', 'coverage', 'dependsOn', 'dataFrom', 'cardinality'], label, errors);
    const idOk = validId(raw.id, `${label}.id`, errors);
    const effectOk = raw.effect === 'read'
      || raw.effect === 'compute'
      || raw.effect === 'local_write'
      || raw.effect === 'external_write'
      || raw.effect === 'admin';
    if (!effectOk) errors.push(`${label}.effect is invalid`);
    const hasCoverage = Object.prototype.hasOwnProperty.call(raw, 'coverage');
    const coverageOk = raw.coverage === 'single'
      || raw.coverage === 'accepted_set'
      || raw.coverage === 'complete_set'
      || raw.coverage === 'resolved_operation';
    if (raw.effect === 'read' && !coverageOk) errors.push(`${label}.coverage is required for reads`);
    if (raw.effect !== 'read' && hasCoverage) errors.push(`${label}.coverage is only valid for reads`);
    const dependsOn = stringList(raw.dependsOn, `${label}.dependsOn`, errors);
    const dataFrom = stringList(raw.dataFrom, `${label}.dataFrom`, errors);
    if (!plainRecord(raw.cardinality)) {
      errors.push(`${label}.cardinality must be an object`);
      continue;
    }
    const cardinality = raw.cardinality;
    if (cardinality.kind === 'once') {
      exactKeys(cardinality, ['kind'], `${label}.cardinality`, errors);
    } else if (cardinality.kind === 'each' || cardinality.kind === 'set') {
      exactKeys(cardinality, ['kind', 'universeId'], `${label}.cardinality`, errors);
      validId(cardinality.universeId, `${label}.cardinality.universeId`, errors);
    } else {
      errors.push(`${label}.cardinality.kind is invalid`);
    }
    if (!idOk || !effectOk || !dependsOn || !dataFrom) continue;
    if (raw.effect === 'read' && dataFrom.length > 0) {
      errors.push(`${label}.dataFrom is not valid for a source read`);
    }
    for (const source of dataFrom) {
      if (!dependsOn.includes(source)) errors.push(`${label}.dataFrom ${source} must also be a dependency`);
    }
    if (
      raw.effect === 'read'
      && (
        (raw.coverage === 'accepted_set' && cardinality.kind !== 'set')
        || (cardinality.kind === 'set' && raw.coverage !== 'accepted_set')
        || (raw.coverage === 'complete_set' && cardinality.kind !== 'once')
        || (cardinality.kind === 'each' && raw.coverage !== 'single')
      )
    ) {
      errors.push(`${label}.coverage and cardinality describe different read sets`);
    }
    if (cardinality.kind !== 'once' && cardinality.kind !== 'each' && cardinality.kind !== 'set') continue;
    operations.push({
      id: String(raw.id),
      effect: raw.effect as ExpectedWorkEffectV1,
      ...(raw.effect === 'read' && coverageOk
        ? { coverage: raw.coverage as ExpectedWorkCoverageV1 }
        : {}),
      dependsOn,
      dataFrom,
      cardinality: cardinality.kind === 'once'
        ? { kind: 'once' }
        : { kind: cardinality.kind, universeId: String(cardinality.universeId) },
    });
  }

  const universes: ExpectedWorkUniverseV1[] = [];
  for (const [index, raw] of rawUniverses.entries()) {
    const label = `universe[${index}]`;
    if (!plainRecord(raw)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    const idOk = validId(raw.id, `${label}.id`, errors);
    if (raw.seal === 'accepted_input') {
      exactKeys(raw, ['id', 'seal', 'members'], label, errors);
      if (!Array.isArray(raw.members) || raw.members.length === 0) {
        errors.push(`${label}.members must contain at least one accepted item`);
        continue;
      }
      if (raw.members.length > EXPECTED_WORK_MAX_UNIVERSE_MEMBERS) {
        errors.push(`${label}.members exceeds ${EXPECTED_WORK_MAX_UNIVERSE_MEMBERS}`);
      }
      const members: string[] = [];
      for (const [memberIndex, member] of raw.members.entries()) {
        if (typeof member !== 'string' || !MEMBER_PATTERN.test(member)) {
          errors.push(`${label}.members[${memberIndex}] must be a bounded nonblank id`);
        } else {
          members.push(member);
        }
      }
      if (new Set(members).size !== members.length) errors.push(`${label}.members contains duplicates`);
      if (idOk) {
        universes.push({ id: String(raw.id), seal: 'accepted_input', members: [...members].sort() });
      }
    } else if (raw.seal === 'complete_source_receipt') {
      exactKeys(raw, ['id', 'seal', 'producedBy'], label, errors);
      const producerOk = validId(raw.producedBy, `${label}.producedBy`, errors);
      if (idOk && producerOk) {
        universes.push({
          id: String(raw.id),
          seal: 'complete_source_receipt',
          producedBy: String(raw.producedBy),
        });
      }
    } else {
      exactKeys(raw, ['id', 'seal', 'members', 'producedBy'], label, errors);
      errors.push(`${label}.seal is invalid`);
    }
  }

  const operationIds = new Set<string>();
  for (const operation of operations) {
    if (operationIds.has(operation.id)) errors.push(`duplicate operation id ${operation.id}`);
    operationIds.add(operation.id);
  }
  const universeIds = new Set<string>();
  for (const universe of universes) {
    if (universeIds.has(universe.id)) errors.push(`duplicate universe id ${universe.id}`);
    if (operationIds.has(universe.id)) errors.push(`id ${universe.id} is shared by an operation and universe`);
    universeIds.add(universe.id);
  }
  const byOperation = new Map(operations.map((operation) => [operation.id, operation]));
  for (const operation of operations) {
    for (const dependency of operation.dependsOn) {
      if (!byOperation.has(dependency)) errors.push(`${operation.id} depends on missing operation ${dependency}`);
      if (dependency === operation.id) errors.push(`${operation.id} cannot depend on itself`);
    }
    for (const source of operation.dataFrom) {
      if (!byOperation.has(source)) errors.push(`${operation.id} reads data from missing operation ${source}`);
    }
    if (operation.cardinality.kind !== 'once' && !universeIds.has(operation.cardinality.universeId)) {
      errors.push(`${operation.id} references missing universe ${operation.cardinality.universeId}`);
    }
  }
  if (hasCycle(operations)) errors.push('operation dependencies must be acyclic');

  for (const universe of universes) {
    const consumers = operations.filter((operation) =>
      operation.cardinality.kind !== 'once' && operation.cardinality.universeId === universe.id);
    if (consumers.length === 0) errors.push(`universe ${universe.id} has no cardinality consumer`);
    if (universe.seal === 'complete_source_receipt') {
      const producer = byOperation.get(universe.producedBy);
      if (
        !producer
        || producer.effect !== 'read'
        || producer.coverage !== 'complete_set'
        || producer.cardinality.kind !== 'once'
      ) {
        errors.push(`universe ${universe.id} requires one complete-set source-read producer`);
      }
      if (consumers.some((consumer) => consumer.id === universe.producedBy)) {
        errors.push(`universe ${universe.id} cannot be produced by its own each-cardinality consumer`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)].sort() };
  return {
    ok: true,
    proposal: {
      version: EXPECTED_WORK_CONTRACT_VERSION,
      operations: [...operations].sort((left, right) => left.id.localeCompare(right.id)),
      universes: [...universes].sort((left, right) => left.id.localeCompare(right.id)),
    },
  };
}

/** The only topologies V1 can derive without another reasoning result. */
export function compileDeterministicExpectedWorkProposal(
  graph: TurnGraphIR,
): ExpectedWorkProposalV1 | null {
  if (!validateTurnGraph(graph).ok) return null;
  if (graph.classification.route === 'direct_reply') {
    return { version: EXPECTED_WORK_CONTRACT_VERSION, operations: [], universes: [] };
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
    'graphId', 'graphHash', 'plannerSource', 'operations', 'universes',
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
  if (value.plannerSource !== 'deterministic' && value.plannerSource !== 'structured_model') {
    errors.push('contract.plannerSource is invalid');
  }
  const proposal = validateExpectedWorkProposal({
    version: value.version,
    operations: value.operations,
    universes: value.universes,
  });
  if (!proposal.ok) errors.push(...proposal.errors);
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

function validateActionProposalForGraph(
  proposal: ExpectedWorkProposalV1,
  graph: TurnGraphIR,
): string[] {
  const errors: string[] = [];
  if (graph.classification.route !== 'act') errors.push('explicit action contracts require an action graph');
  if (proposal.operations.length === 0) errors.push('an action contract cannot contain zero operations');
  if (!proposal.operations.some((operation) => operation.effect !== 'read')) {
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

/** Freeze conversation/retrieve without invoking any provider. */
export function freezeDeterministicExpectedWorkContract(input: {
  sessionId: string;
  sourceUserSeq: number;
}): FreezeExpectedWorkContractResult {
  const expected = exactExpectedTask(input);
  if ('status' in expected && expected.status !== 'ok') return expected;
  const proposal = compileDeterministicExpectedWorkProposal(expected.graph);
  if (!proposal) {
    return { status: 'planning_required', reason: 'action topology requires one explicit bounded proposal' };
  }
  const validated = validateExpectedWorkProposal(proposal);
  if (!validated.ok) return { status: 'invalid', reason: validated.errors.join('; ') };
  return freezePreparedContract({
    ...input,
    contract: buildContract({
      proposal: validated.proposal,
      plannerSource: 'deterministic',
      expected,
    }),
  });
}

export type RequireKnownExpectedWorkContractResult =
  | { status: 'bound'; contract: AcceptedTaskWorkContractV1 }
  | { status: 'action_deferred' };

/**
 * Staged production cutover. Direct and retrieve have exact host-known
 * topology, so they bind before provider construction. Actions deliberately
 * continue unchanged until the bounded planner seam can supply their topology;
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
