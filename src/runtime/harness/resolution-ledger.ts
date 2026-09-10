/**
 * Durable expected-vs-observed authority for one accepted task.
 *
 * Expected work comes only from the exact, hash-verified TurnGraph persisted for
 * the accepted user source. Observed work comes only from host boundaries that
 * saw a logical business call. Neither artifact contains objective prose,
 * provider payloads, or a catalog of tools.
 *
 * The normalized rows are the state-machine authority. Mirror events are
 * inserted in the SAME IMMEDIATE transaction, then published after commit. That
 * closes the old check-then-append race: an operation and finalization are
 * serialized, and an operation can never appear after a finalized count.
 */
import { createHash } from 'node:crypto';
import { classifyTool, type ToolKind } from '../../agents/tool-taxonomy.js';
import type { TurnGraphIR, TurnGraphNode } from '../graph/turn-graph-ir.js';
import { turnGraphFromShadowEvent } from '../graph/turn-graph-shadow.js';
import {
  getSession,
  getTurnGraphEventForSource,
  insertInternalEventInTransaction,
  openEventLog,
  publishCommittedInternalEvent,
  type EventRow,
} from './eventlog.js';
import { acceptedTaskIdFor } from './attempt-identity.js';
import { isHostTurnEngine, selectTurnEngine } from './turn-engine-selection.js';
import { readSemanticDisposition } from '../semantic-boundary/semantic-disposition.js';
import {
  actionTopologyRoleForRuntimeCall,
  canonicalRuntimeEffectiveToolName,
  classifyRuntimeToolEffect,
  unwrapRuntimeEffectiveToolIdentity,
  type RuntimeToolEffect,
} from './tool-effect.js';
import { loadExpectedWorkContract } from './expected-work-contract.js';
import {
  isDeterministicImplicitRetrieveContract,
  matchExpectedWork,
  type ExpectedWorkMatchResult,
} from './expected-work-matcher.js';
import { projectObservedExpectedWorkHistory } from './expected-work-observed-projector.js';
import { ensureGraphCallAuthorityInTransaction } from './accepted-turn-call-authority.js';
import { proveHostPlannedResolutionCoexistenceInTransaction } from './host-planned-resolution-coexistence.js';

export const RESOLUTION_OPERATION_EVENT = 'resolution_operation' as const;
export const RESOLUTION_FINALIZED_EVENT = 'resolution_finalized' as const;

type WorkKind = 'conversation' | 'retrieve' | 'execute' | 'fanout';
export type ObservedReversibility =
  | 'read_only'
  | 'reversible'
  | 'irreversible'
  | 'not_applicable'
  | 'unknown';

export interface AcceptedTaskExpectation {
  version: 1;
  acceptedTaskId: string;
  identity: { sessionId: string; sourceUserSeq: number; turn: number };
  graphEventId: string;
  graphId: string;
  graphHash: string;
  compilerVersion: string;
  route: TurnGraphIR['classification']['route'];
  workNodeId?: string;
  workKind: WorkKind;
  effectCeiling: TurnGraphIR['effectCeiling'];
  externalEffectRequested: boolean;
  externalEffectKinds: string[];
}

export type ExpectedTaskState =
  | { status: 'ok'; expectation: AcceptedTaskExpectation; graph: TurnGraphIR }
  | { status: 'missing'; reason: string }
  | { status: 'ambiguous'; reason: string };

function workNodes(graph: TurnGraphIR): TurnGraphNode[] {
  const nodes = graph.nodes.filter((node) =>
    node.kind === 'retrieve' || node.kind === 'execute' || node.kind === 'fanout');
  // Collect-then-construct compiles prerequisite reads plus the construct
  // write. Authority still names one primary work node: the write, not a
  // transform/extract execute that precedes it.
  if (graph.classification.multiItem.collectThenConstruct) {
    const writes = nodes.filter((node) =>
      node.kind === 'execute'
      && (
        node.capabilityRole === 'destination'
        || node.capabilityRole === 'create'
        || node.effect.kind === 'external_write'
        || node.effect.kind === 'local_write'
        || node.effect.kind === 'admin'
      ));
    if (writes.length === 1) return writes;
    return nodes.filter((node) => node.kind === 'execute');
  }
  return nodes;
}

/**
 * A compound accepted task still needs one task-level resolution owner even
 * though its immutable expected-work contract owns several member calls. The
 * graph compiler already emits that owner: one runtime verification
 * rendezvous with an all-success edge from every primary work node.
 *
 * Do not infer an aggregate merely from there being several nodes. A missing,
 * partial, alternative, or competing join is ambiguous and retains the
 * historical refusal. This projection changes only the multi-node case; the
 * zero/one-node contract remains byte-for-byte identical.
 */
function aggregateWorkOwner(
  graph: TurnGraphIR,
  candidates: readonly TurnGraphNode[],
): TurnGraphNode | null {
  if (candidates.length < 2) return null;
  const verifyNodes = graph.nodes.filter((node) => node.kind === 'verify');
  if (verifyNodes.length !== 1) return null;
  const verify = verifyNodes[0]!;
  if (verify.joinMode === 'any' || verify.runner.kind !== 'runtime') return null;

  const candidateIds = new Set(candidates.map((node) => node.id));
  if (candidateIds.size !== candidates.length) return null;
  const incoming = graph.edges.filter((edge) => edge.target === verify.id);
  if (incoming.length !== candidateIds.size) return null;
  const covered = new Set<string>();
  for (const edge of incoming) {
    if (
      edge.when !== 'success'
      || !candidateIds.has(edge.source)
      || covered.has(edge.source)
    ) return null;
    covered.add(edge.source);
  }
  return covered.size === candidateIds.size ? verify : null;
}

/**
 * Typed expected-work requirements are discharged only by a binder that
 * writes call bindings: the interactive host engine's carrier admission, or
 * the typed construct run behind a participated source. This is an engine
 * CAPABILITY question — which writers will run for this session — never a
 * session-name test. A non-conversational graph without such a writer is not
 * executable authority: it must hold before execution instead of being
 * reinterpreted as conversation-shaped work.
 */
function expectedWorkBinderPresent(
  sessionId: string,
  sourceUserSeq: number,
  graph: TurnGraphIR,
): boolean {
  try {
    const session = getSession(sessionId);
    if (!session) return false;
    const sessionKind = session.kind;
    // The interactive host engine is the fresh-turn owner for chat AND
    // execution sessions alike (selectTurnEngine ignores kind for a fresh
    // source), and its carrier admission writes call bindings for both. Live
    // 2026-09-01: a system authoring turn (kind execution via bridge:cron,
    // graph surface 'direct') had its ADMITTED one-op plan refused at persist
    // three times because this predicate only recognized chat.
    if (
      (sessionKind === 'chat' || sessionKind === 'execution')
      && isHostTurnEngine(selectTurnEngine({ sessionKind }))
    ) return true;
    // Background and cron are the two non-interactive surfaces whose
    // execution owner constructs the action expected-work carrier before it
    // exposes business tools (both the standard agent and the full Claude SDK
    // brain mount work_call from the activated source). Require the exact,
    // hash-validated graph to agree with the live immutable session kind: a
    // generic legacy-sdk label, a workflow controller, or an agent session is
    // not evidence that this writer exists.
    if (
      sessionKind === 'execution'
      && graph.source.sessionKind === 'execution'
      && (graph.source.surface === 'background' || graph.source.surface === 'cron')
    ) return true;
    // A DELEGATED WORKER CHILD (worker-host-runner: kind 'agent', metadata
    // source 'delegated_worker') runs under the same interactive host engine
    // and mounts the same work_call carrier from its own activated source
    // (sub-agents buildWorkerAgent). Its writes are the parent's per-item
    // requirement delegated to it (expected-work-delegation.ts, 2026-09-09);
    // the binding writer is present by construction, exactly as for chat.
    if (
      sessionKind === 'agent'
      && (session.metadata as { source?: unknown } | undefined)?.source === 'delegated_worker'
      && isHostTurnEngine(selectTurnEngine({ sessionKind: 'chat' }))
    ) return true;
    return readSemanticDisposition(sessionId, sourceUserSeq)?.participation === 'participated';
  } catch {
    // An unreadable session store or unconfigurable engine cannot prove that
    // a binding writer will run. Refuse the work graph below.
    return false;
  }
}

/**
 * Workflow prompt/graph nodes have a different, already-durable execution
 * owner: getWorkflowHarnessSession stamps the session with the exact workflow
 * and step identity before the accepted source exists, and the workflow runner
 * constrains the node's tool/result surface itself. That owner does not write
 * interactive expected-work bindings, so treating its graph as an unsupported
 * binderless chat deadlocks every legitimate workflow node at logical-call
 * admission.
 *
 * Session kind alone is deliberately insufficient. A legacy/bare workflow
 * session (including the binderless fail-closed pin) has none of these
 * host-authored metadata facts and remains refused.
 */
function workflowGraphExecutionOwnerPresent(
  sessionId: string,
  graph: TurnGraphIR,
): boolean {
  try {
    const session = getSession(sessionId);
    const metadata = session?.metadata;
    return Boolean(
      session?.kind === 'workflow'
      && graph.source.sessionKind === 'workflow'
      && metadata?.source === 'workflow'
      && typeof metadata.workflowName === 'string'
      && metadata.workflowName.trim()
      && typeof metadata.workflowRunId === 'string'
      && metadata.workflowRunId.trim()
      && typeof metadata.stepId === 'string'
      && metadata.stepId.trim()
      && typeof metadata.sessionIdSuffix === 'string'
      && metadata.sessionIdSuffix.trim()
    );
  } catch {
    return false;
  }
}

/** Load the one accepted-source graph and project only its authority fields. */
export function expectedTaskFor(sessionId: string, sourceUserSeq: number): ExpectedTaskState {
  let graphEvent: EventRow | null;
  try {
    graphEvent = getTurnGraphEventForSource(sessionId, sourceUserSeq);
  } catch (error) {
    return { status: 'ambiguous', reason: `turn graph store unreadable: ${String(error)}` };
  }
  if (!graphEvent) return { status: 'missing', reason: 'no persisted turn graph for accepted task' };
  const graph = turnGraphFromShadowEvent(graphEvent);
  if (!graph) return { status: 'ambiguous', reason: 'persisted turn graph failed identity or hash validation' };

  const candidates = workNodes(graph);
  const aggregate = candidates.length > 1 ? aggregateWorkOwner(graph, candidates) : null;
  const nonConversational = graph.classification.route !== 'direct_reply';
  const binderPresent = !nonConversational
    || expectedWorkBinderPresent(sessionId, sourceUserSeq, graph);
  const workflowExecutionOwner = nonConversational
    && workflowGraphExecutionOwnerPresent(sessionId, graph);
  // A missing binder cannot weaken a persisted work graph into conversation.
  // Conversation has no expected-work obligations; this graph does. Until the
  // selected engine proves it can write those bindings, or the exact workflow
  // graph owner proves its separately constrained execution surface, there is
  // no authority to start execution.
  if (nonConversational && !binderPresent && !workflowExecutionOwner) {
    return {
      status: 'ambiguous',
      reason: 'non-conversational graph has no expected-work binding writer',
    };
  }
  // The workflow runner, not the interactive work_call binder, owns calls and
  // settlement for this exact node. Preserve the historical conversation-
  // shaped resolution projection only for that typed owner; the durable graph
  // remains recorded and every physical crossing still traverses the ordinary
  // logical/settlement/approval walls.
  if (workflowExecutionOwner && !binderPresent) {
    return {
      status: 'ok',
      graph,
      expectation: {
        version: 1,
        acceptedTaskId: acceptedTaskIdFor(sessionId, sourceUserSeq),
        identity: { ...graph.identity },
        graphEventId: graphEvent.id,
        graphId: graph.graphId,
        graphHash: graph.compiler.graphHash,
        compilerVersion: graph.compiler.version,
        route: graph.classification.route,
        workKind: 'conversation',
        effectCeiling: graph.effectCeiling,
        externalEffectRequested: graph.classification.externalEffectRequested,
        externalEffectKinds: [...graph.classification.externalEffectKinds].sort(),
      },
    };
  }
  if (candidates.length > 1 && !aggregate) {
    return {
      status: 'ambiguous',
      reason: `turn graph contains ${candidates.length} primary work nodes without one exact verification rendezvous`,
    };
  }
  if (nonConversational && candidates.length !== 1 && !aggregate) {
    return { status: 'ambiguous', reason: 'non-conversational graph has no unique work node' };
  }
  const work = aggregate ?? candidates[0];
  const workKind: WorkKind = aggregate
    ? 'execute'
    : work
      ? work.kind as Exclude<WorkKind, 'conversation'>
      : 'conversation';
  return {
    status: 'ok',
    graph,
    expectation: {
      version: 1,
      acceptedTaskId: acceptedTaskIdFor(sessionId, sourceUserSeq),
      identity: { ...graph.identity },
      graphEventId: graphEvent.id,
      graphId: graph.graphId,
      graphHash: graph.compiler.graphHash,
      compilerVersion: graph.compiler.version,
      route: graph.classification.route,
      ...(work ? { workNodeId: work.id } : {}),
      workKind,
      effectCeiling: graph.effectCeiling,
      externalEffectRequested: graph.classification.externalEffectRequested,
      externalEffectKinds: [...graph.classification.externalEffectKinds].sort(),
    },
  };
}

function canonical(value: unknown, depth = 0, seen = new Set<object>()): string {
  if (depth > 8) return '"[depth]"';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(String(value));
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.slice(0, 64).map((entry) => canonical(entry, depth + 1, seen)).join(',')}]`;
  } else {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort().slice(0, 64);
    result = `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key], depth + 1, seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return result;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function argumentShape(args: unknown): { keys: string[]; digest: string } {
  const keys = args && typeof args === 'object' && !Array.isArray(args)
    ? Object.keys(args as Record<string, unknown>).sort().slice(0, 64)
    : [];
  return { keys, digest: sha256(canonical(args)) };
}

function effectForToolKind(kind: ToolKind): RuntimeToolEffect | undefined {
  switch (kind) {
    case 'read': return 'read';
    case 'execute': return 'compute';
    case 'write': return 'local_write';
    case 'send': return 'external_write';
    case 'admin': return 'admin';
    default: return undefined;
  }
}

function reversibilityFor(
  kind: ToolKind,
  effect: RuntimeToolEffect,
): ObservedReversibility {
  switch (kind) {
    case 'read': return 'read_only';
    case 'write': return 'reversible';
    case 'send':
    case 'admin': return 'irreversible';
    case 'execute': return 'not_applicable';
    default:
      if (effect === 'read') return 'read_only';
      if (effect === 'local_write') return 'reversible';
      if (effect === 'external_write' || effect === 'admin') return 'irreversible';
      if (effect === 'compute') return 'not_applicable';
      return 'unknown';
  }
}

export interface ResolvedOperationFact {
  nodeId: string;
  operationId: string;
  resolvedTool: string;
  logicalToolCallId: string;
  physicalDispatchId?: string;
  effectKind: RuntimeToolEffect;
  reversibility: ObservedReversibility;
  effectSource: string;
  argumentKeys: string[];
  argumentDigest: string;
  outcomeKind?: string;
  dispatchState?: 'not_started' | 'dispatched';
}

export interface RecordResolvedOperationInput {
  sessionId: string;
  sourceUserSeq: number;
  turn?: number;
  /** Must be the unique work node in the persisted graph. */
  nodeId: string;
  /** Stable logical operation label. Production uses logicalToolCallId. */
  operationId: string;
  resolvedTool: string;
  args?: unknown;
  logicalToolCallId: string;
  physicalDispatchId?: string;
  outcomeKind?: string;
  dispatchState?: 'not_started' | 'dispatched';
}

export type RecordResolvedOperationTransactionResult =
  | { status: 'inserted'; fact: ResolvedOperationFact; event: EventRow }
  | { status: 'existing'; fact: ResolvedOperationFact }
  | { status: 'not_ready' | 'conflict'; reason: string };

interface ResolutionRow {
  accepted_task_id: string;
  graph_event_id: string;
  graph_id: string;
  graph_hash: string;
  compiler_version: string;
  route: AcceptedTaskExpectation['route'];
  work_node_id: string | null;
  work_kind: WorkKind;
  effect_ceiling: string;
  external_effect_requested: number;
  external_effect_kinds_json: string;
  state: 'open' | 'finalized' | 'legacy_ambiguous';
  operation_count: number;
  operations_digest: string | null;
  expectations_satisfied: number | null;
  opened_at: string;
  finalized_at: string | null;
}

function rowMatchesExpectation(row: ResolutionRow, expected: AcceptedTaskExpectation): boolean {
  return row.accepted_task_id === expected.acceptedTaskId
    && row.graph_event_id === expected.graphEventId
    && row.graph_id === expected.graphId
    && row.graph_hash === expected.graphHash
    && row.compiler_version === expected.compilerVersion
    && row.route === expected.route
    && row.work_node_id === (expected.workNodeId ?? null)
    && row.work_kind === expected.workKind
    && row.effect_ceiling === expected.effectCeiling
    && row.external_effect_requested === (expected.externalEffectRequested ? 1 : 0)
    && row.external_effect_kinds_json === JSON.stringify(expected.externalEffectKinds);
}

/**
 * Keep the accepted-turn call root single-owned.
 *
 * Ordinary graph execution continues to create/advance the turn_graph root.
 * A foreground host turn that durably admitted plan_task already owns host_v1;
 * its resolution is topology/evidence only, so the exact DB proof skips graph
 * root creation without mutating the host root.
 */
function ensureResolutionCallAuthorityInTransaction(
  db: ReturnType<typeof openEventLog>,
  expected: AcceptedTaskExpectation,
  row: ResolutionRow,
): void {
  if (proveHostPlannedResolutionCoexistenceInTransaction({
    db,
    sessionId: expected.identity.sessionId,
    sourceUserSeq: expected.identity.sourceUserSeq,
    phase: 'existing',
  })) return;
  ensureGraphCallAuthorityInTransaction(db, {
    sessionId: expected.identity.sessionId,
    sourceUserSeq: expected.identity.sourceUserSeq,
    acceptedTaskId: expected.acceptedTaskId,
    graphEventId: expected.graphEventId,
    graphHash: expected.graphHash,
    compilerVersion: expected.compilerVersion,
    effectCeiling: expected.effectCeiling,
    resolutionState: row.state,
    openedAt: row.opened_at,
    finalizedAt: row.finalized_at,
  });
}

function ensureOpenResolution(
  db: ReturnType<typeof openEventLog>,
  expected: AcceptedTaskExpectation,
): ResolutionRow {
  let row = db.prepare(
    `SELECT * FROM accepted_task_resolutions WHERE session_id = ? AND source_user_seq = ?`,
  ).get(expected.identity.sessionId, expected.identity.sourceUserSeq) as ResolutionRow | undefined;
  if (!row) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO accepted_task_resolutions
        (session_id, source_user_seq, accepted_task_id, graph_event_id, graph_id,
         graph_hash, compiler_version, route, work_node_id, work_kind,
         effect_ceiling, external_effect_requested, external_effect_kinds_json,
         state, revision, operation_count, opened_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, 0, ?)
    `).run(
      expected.identity.sessionId,
      expected.identity.sourceUserSeq,
      expected.acceptedTaskId,
      expected.graphEventId,
      expected.graphId,
      expected.graphHash,
      expected.compilerVersion,
      expected.route,
      expected.workNodeId ?? null,
      expected.workKind,
      expected.effectCeiling,
      expected.externalEffectRequested ? 1 : 0,
      JSON.stringify(expected.externalEffectKinds),
      now,
    );
    row = db.prepare(
      `SELECT * FROM accepted_task_resolutions WHERE session_id = ? AND source_user_seq = ?`,
    ).get(expected.identity.sessionId, expected.identity.sourceUserSeq) as ResolutionRow;
  }
  if (!rowMatchesExpectation(row, expected)) {
    throw new Error('accepted task resolution conflicts with its persisted graph');
  }
  ensureResolutionCallAuthorityInTransaction(db, expected, row);
  if (row.state === 'legacy_ambiguous') throw new Error('accepted task resolution is ambiguous');
  return row;
}

/** Same-transaction admission seam for logical calls and provider crossings. */
export function ensureAcceptedTaskResolutionOpenInTransaction(
  db: ReturnType<typeof openEventLog>,
  expected: AcceptedTaskExpectation,
): boolean {
  return ensureOpenResolution(db, expected).state === 'open';
}

function physicalDispatchBelongs(
  db: ReturnType<typeof openEventLog>,
  expected: AcceptedTaskExpectation,
  logicalToolCallId: string,
  physicalDispatchId: string,
  resolvedTool: string,
): boolean {
  const row = db.prepare(`
    SELECT tool_name, state FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
       AND accepted_task_id = ? AND logical_tool_call_id = ?
       AND physical_dispatch_id = ?
     LIMIT 1
  `).get(
    expected.identity.sessionId,
    expected.identity.sourceUserSeq,
    expected.acceptedTaskId,
    logicalToolCallId,
    physicalDispatchId,
  ) as { tool_name: string; state: string } | undefined;
  return row?.tool_name === resolvedTool && row.state === 'returned';
}

/**
 * Recover the effect already frozen by the host before provider execution.
 *
 * Settlement deliberately records the peeled provider action (rather than its
 * dynamic or MCP carrier). Reclassifying that bare spelling here loses the
 * carrier provenance which admitted the call: a provider action can look like
 * a local write even though the immutable expected-work binding admitted an
 * external write. Only an exact three-way identity match (binding, logical
 * call, accepted task) may project the frozen effect. An unbound observation
 * keeps the existing classifier.
 */
interface FrozenOperationAuthority {
  effect: Exclude<RuntimeToolEffect, 'unknown'>;
  reversibility: ObservedReversibility;
  source: 'expected_work_binding' | 'write_evidence_binding';
}

function frozenOperationAuthority(
  db: ReturnType<typeof openEventLog>,
  expected: AcceptedTaskExpectation,
  logicalToolCallId: string,
  resolvedTool: string,
): FrozenOperationAuthority | null {
  const row = db.prepare(`
    SELECT b.tool_name AS binding_tool_name,
           b.argument_digest AS binding_argument_digest,
           b.effect_kind AS effect_kind,
           l.tool_name AS logical_tool_name,
           l.argument_digest AS logical_argument_digest,
           w.effect_kind AS write_effect_kind,
           w.reversibility AS write_reversibility,
           w.tool_name AS write_tool_name,
           w.argument_digest AS write_argument_digest
      FROM expected_work_call_bindings b
      JOIN logical_tool_calls l
        ON l.session_id = b.session_id
       AND l.source_user_seq = b.source_user_seq
       AND l.logical_tool_call_id = b.logical_tool_call_id
      LEFT JOIN write_evidence_bindings w
        ON w.session_id = b.session_id
       AND w.source_user_seq = b.source_user_seq
       AND w.accepted_task_id = b.accepted_task_id
       AND w.logical_tool_call_id = b.logical_tool_call_id
     WHERE b.session_id = ? AND b.source_user_seq = ?
       AND b.accepted_task_id = ? AND b.logical_tool_call_id = ?
       AND l.accepted_task_id = b.accepted_task_id
     LIMIT 1
  `).get(
    expected.identity.sessionId,
    expected.identity.sourceUserSeq,
    expected.acceptedTaskId,
    logicalToolCallId,
  ) as {
    binding_tool_name: string;
    binding_argument_digest: string;
    effect_kind: string;
    logical_tool_name: string;
    logical_argument_digest: string;
    write_effect_kind: string | null;
    write_reversibility: string | null;
    write_tool_name: string | null;
    write_argument_digest: string | null;
  } | undefined;
  if (
    !row
    || row.binding_tool_name !== resolvedTool
    || row.logical_tool_name !== resolvedTool
    || row.binding_argument_digest !== row.logical_argument_digest
  ) return null;
  let effect: Exclude<RuntimeToolEffect, 'unknown'>;
  switch (row.effect_kind) {
    case 'read':
    case 'compute':
    case 'local_write':
    case 'external_write':
    case 'admin':
      effect = row.effect_kind;
      break;
    default:
      return null;
  }
  if (
    row.write_effect_kind === effect
    && row.write_tool_name === resolvedTool
    && row.write_argument_digest === row.binding_argument_digest
    && (row.write_reversibility === 'reversible' || row.write_reversibility === 'irreversible')
  ) {
    return {
      effect,
      reversibility: row.write_reversibility,
      source: 'write_evidence_binding',
    };
  }
  return {
    effect,
    reversibility: effect === 'read'
      ? 'read_only'
      : effect === 'compute'
        ? 'not_applicable'
        : effect === 'local_write'
          ? 'reversible'
          : 'unknown',
    source: 'expected_work_binding',
  };
}

/**
 * Record one host-observed business operation.
 *
 * The caller names a capability and supplies its ephemeral arguments; the host
 * derives effective tool, effect and reversibility. Raw arguments are discarded
 * after structural keys and a content digest are computed.
 */
export function recordResolvedOperationInTransaction(
  db: ReturnType<typeof openEventLog>,
  input: RecordResolvedOperationInput,
): RecordResolvedOperationTransactionResult {
  const expectedState = expectedTaskFor(input.sessionId, input.sourceUserSeq);
  if (expectedState.status !== 'ok') {
    return {
      status: expectedState.status === 'missing' ? 'not_ready' : 'conflict',
      reason: expectedState.reason,
    };
  }
  const expected = expectedState.expectation;
  if (!expected.workNodeId || input.nodeId !== expected.workNodeId) {
    return { status: 'conflict', reason: 'operation does not belong to the accepted work node' };
  }
  if (!input.operationId.trim() || !input.logicalToolCallId.trim() || !input.resolvedTool.trim()) {
    return { status: 'conflict', reason: 'operation identity is incomplete' };
  }

  const effective = unwrapRuntimeEffectiveToolIdentity(input.resolvedTool, input.args);
  const resolvedTool = canonicalRuntimeEffectiveToolName(
    effective.toolName?.trim() || input.resolvedTool.trim(),
  );
  if (!resolvedTool) return { status: 'conflict', reason: 'resolved tool identity is unsafe' };
  const runtime = classifyRuntimeToolEffect(input.resolvedTool, input.args);
  const taxonomy = classifyTool(resolvedTool, { args: effective.args });
  const inferredEffect = runtime.effect === 'unknown'
    ? effectForToolKind(taxonomy) ?? 'unknown'
    : runtime.effect;
  const frozen = frozenOperationAuthority(
    db,
    expected,
    input.logicalToolCallId,
    resolvedTool,
  );
  const effectKind = frozen?.effect ?? inferredEffect;
  const reversibility = frozen?.reversibility ?? reversibilityFor(taxonomy, effectKind);
  const effectSource = frozen
    ? frozen.source
    : runtime.effect === 'unknown' ? 'taxonomy' : runtime.source;
  const shape = argumentShape(effective.args);
  const resolution = ensureOpenResolution(db, expected);
  if (resolution.state !== 'open') {
    return { status: 'not_ready', reason: `accepted task resolution is ${resolution.state}` };
  }
  if (
    input.physicalDispatchId
    && !physicalDispatchBelongs(
      db,
      expected,
      input.logicalToolCallId,
      input.physicalDispatchId,
      resolvedTool,
    )
  ) {
    return { status: 'conflict', reason: 'physical dispatch does not belong to this operation' };
  }
  if (
    input.physicalDispatchId
    && (
      input.dispatchState === 'not_started'
      || (
        input.outcomeKind !== undefined
        && input.outcomeKind !== 'succeeded'
        && input.outcomeKind !== 'empty_result'
      )
    )
  ) {
    return { status: 'conflict', reason: 'operation outcome conflicts with its physical dispatch' };
  }

  const existing = db.prepare(`
    SELECT * FROM accepted_task_operations
     WHERE session_id = ? AND source_user_seq = ?
       AND (operation_id = ? OR logical_tool_call_id = ?)
     LIMIT 1
  `).get(
    input.sessionId,
    input.sourceUserSeq,
    input.operationId,
    input.logicalToolCallId,
  ) as OperationRow | undefined;
  if (existing) {
    const fact = operationFact(existing);
    const exact = fact.nodeId === expected.workNodeId
      && fact.operationId === input.operationId
      && fact.logicalToolCallId === input.logicalToolCallId
      && fact.resolvedTool === resolvedTool
      && fact.effectKind === effectKind
      && fact.reversibility === reversibility
      && fact.argumentDigest === shape.digest
      && (fact.physicalDispatchId ?? undefined) === input.physicalDispatchId;
    return exact
      ? { status: 'existing', fact }
      : { status: 'conflict', reason: 'operation identity conflicts with an existing observation' };
  }

  const mirror = insertInternalEventInTransaction(db, {
    sessionId: input.sessionId,
    turn: expected.identity.turn,
    role: 'system',
    type: RESOLUTION_OPERATION_EVENT,
    data: {
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: expected.acceptedTaskId,
      graphId: expected.graphId,
      graphHash: expected.graphHash,
      nodeId: expected.workNodeId,
      operationId: input.operationId,
      resolvedTool,
      logicalToolCallId: input.logicalToolCallId,
      ...(input.physicalDispatchId ? { physicalDispatchId: input.physicalDispatchId } : {}),
      effectKind,
      reversibility,
      effectSource,
      argumentKeys: shape.keys,
      argumentDigest: shape.digest,
      ...(input.physicalDispatchId
        ? { outcomeKind: input.outcomeKind ?? 'succeeded', dispatchState: 'dispatched' }
        : input.outcomeKind ? { outcomeKind: input.outcomeKind } : {}),
      ...(!input.physicalDispatchId && input.dispatchState
        ? { dispatchState: input.dispatchState }
        : {}),
    },
  });
  db.prepare(`
    INSERT INTO accepted_task_operations
      (session_id, source_user_seq, operation_id, logical_tool_call_id,
       graph_node_id, resolved_tool, effect_kind, reversibility,
       effect_source, argument_keys_json, argument_digest,
       physical_dispatch_id, outcome_kind, dispatch_state, recorded_at,
       operation_event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.sessionId,
    input.sourceUserSeq,
    input.operationId,
    input.logicalToolCallId,
    expected.workNodeId,
    resolvedTool,
    effectKind,
    reversibility,
    effectSource,
    JSON.stringify(shape.keys),
    shape.digest,
    input.physicalDispatchId ?? null,
    input.physicalDispatchId ? input.outcomeKind ?? 'succeeded' : input.outcomeKind ?? null,
    input.physicalDispatchId ? 'dispatched' : input.dispatchState ?? null,
    mirror.createdAt,
    mirror.id,
  );
  return {
    status: 'inserted',
    fact: {
      nodeId: expected.workNodeId,
      operationId: input.operationId,
      resolvedTool,
      logicalToolCallId: input.logicalToolCallId,
      ...(input.physicalDispatchId ? { physicalDispatchId: input.physicalDispatchId } : {}),
      effectKind,
      reversibility,
      effectSource,
      argumentKeys: shape.keys,
      argumentDigest: shape.digest,
      ...(input.physicalDispatchId
        ? { outcomeKind: input.outcomeKind ?? 'succeeded', dispatchState: 'dispatched' }
        : input.outcomeKind ? { outcomeKind: input.outcomeKind } : {}),
      ...(!input.physicalDispatchId && input.dispatchState
        ? { dispatchState: input.dispatchState }
        : {}),
    },
    event: mirror,
  };
}

export function recordResolvedOperation(input: RecordResolvedOperationInput): boolean {
  const db = openEventLog();
  let event: EventRow | null = null;
  try {
    const commit = db.transaction((): RecordResolvedOperationTransactionResult => {
      const result = recordResolvedOperationInTransaction(db, input);
      if (result.status === 'inserted') event = result.event;
      return result;
    });
    const result = commit.immediate();
    if (result.status === 'inserted' && event) publishCommittedInternalEvent(event);
    return result.status === 'inserted';
  } catch {
    return false;
  }
}

interface OperationRow {
  graph_node_id: string;
  operation_id: string;
  resolved_tool: string;
  logical_tool_call_id: string;
  physical_dispatch_id: string | null;
  effect_kind: RuntimeToolEffect;
  reversibility: ObservedReversibility;
  effect_source: string;
  argument_keys_json: string;
  argument_digest: string;
  outcome_kind: string | null;
  dispatch_state: 'not_started' | 'dispatched' | null;
}

function operationFact(row: OperationRow): ResolvedOperationFact {
  let argumentKeys: string[] = [];
  try {
    const parsed = JSON.parse(row.argument_keys_json) as unknown;
    if (Array.isArray(parsed)) argumentKeys = parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch { /* malformed structural metadata fails to an empty projection */ }
  return {
    nodeId: row.graph_node_id,
    operationId: row.operation_id,
    resolvedTool: row.resolved_tool,
    logicalToolCallId: row.logical_tool_call_id,
    ...(row.physical_dispatch_id ? { physicalDispatchId: row.physical_dispatch_id } : {}),
    effectKind: row.effect_kind,
    reversibility: row.reversibility,
    effectSource: row.effect_source,
    argumentKeys,
    argumentDigest: row.argument_digest,
    ...(row.outcome_kind ? { outcomeKind: row.outcome_kind } : {}),
    ...(row.dispatch_state ? { dispatchState: row.dispatch_state } : {}),
  };
}

export function resolvedOperationsFor(sessionId: string, sourceUserSeq: number): ResolvedOperationFact[] {
  try {
    return (openEventLog().prepare(`
      SELECT * FROM accepted_task_operations
       WHERE session_id = ? AND source_user_seq = ?
       ORDER BY recorded_at, operation_id
    `).all(sessionId, sourceUserSeq) as OperationRow[]).map(operationFact);
  } catch {
    return [];
  }
}

function operationsDigest(operations: ResolvedOperationFact[]): string {
  return sha256(canonical(operations.map((operation) => ({
    nodeId: operation.nodeId,
    operationId: operation.operationId,
    resolvedTool: operation.resolvedTool,
    logicalToolCallId: operation.logicalToolCallId,
    physicalDispatchId: operation.physicalDispatchId ?? null,
    effectKind: operation.effectKind,
    reversibility: operation.reversibility,
    argumentDigest: operation.argumentDigest,
    outcomeKind: operation.outcomeKind ?? null,
    dispatchState: operation.dispatchState ?? null,
  }))));
}

function expectationSatisfied(
  expected: AcceptedTaskExpectation,
  operations: ResolvedOperationFact[],
): boolean {
  if (expected.workKind === 'conversation') return true;
  if (operations.length === 0) return false;
  if (expected.route === 'retrieve') {
    return operations.some((operation) => operation.effectKind === 'read');
  }
  if (expected.externalEffectRequested || expected.effectCeiling === 'external_write' || expected.effectCeiling === 'admin') {
    return operations.some((operation) =>
      operation.effectKind === 'external_write' || operation.effectKind === 'admin');
  }
  // An action may legitimately be a calculation, a local edit, or a read-only
  // tool invocation whose result is the requested deliverable. Semantic branch
  // completeness remains the independent completion judge's job until the graph
  // compiler emits one child node per requested branch.
  return operations.some((operation) => operation.effectKind !== 'unknown');
}

/**
 * Is the accepted task's own work still in flight?
 *
 * Asked of ANY open row, this gate let one stray bookkeeping call — a discovery
 * probe, an abandoned attempt — hold a fully discharged contract unverifiable,
 * and the user was told their completed work could not be verified while the
 * files provably existed (live 2026-08-11 run 6; reproduced deterministically).
 *
 * So when the accepted task ACTIVATED expected work, bindings are authoritative
 * about what is contract work, and only unsettled CONTRACT-BOUND calls (and
 * crossings beneath them) may block. A contract-bound call still in flight
 * still blocks — nothing about the fail-closed posture on real work changes.
 *
 * Everywhere else — no contract, or a contract whose work is not binding-
 * tracked (deterministic conversation/retrieve turns carry no bindings) — the
 * original any-open-row rule stands byte for byte. Narrowing it there would
 * loosen a gate on turns that have no other guard.
 */
function hasUnsettledToolWorkInTransaction(
  db: ReturnType<typeof openEventLog>,
  expected: AcceptedTaskExpectation,
): boolean {
  const identity = [expected.identity.sessionId, expected.identity.sourceUserSeq] as const;
  const bindingTracked = Boolean(db.prepare(`
    SELECT 1 FROM accepted_task_authority
     WHERE session_id = ? AND source_user_seq = ?
       AND expected_work_required = 1 AND work_contract_id IS NOT NULL
     LIMIT 1
  `).get(...identity));
  const row = bindingTracked
    ? db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM logical_tool_calls l
             JOIN expected_work_call_bindings b
               ON b.session_id = l.session_id
              AND b.source_user_seq = l.source_user_seq
              AND b.logical_tool_call_id = l.logical_tool_call_id
            WHERE l.session_id = ? AND l.source_user_seq = ?
              AND l.state != 'settled') AS logical_n,
          (SELECT COUNT(*) FROM physical_dispatches p
             JOIN expected_work_call_bindings b
               ON b.session_id = p.session_id
              AND b.source_user_seq = p.source_user_seq
              AND b.logical_tool_call_id = p.logical_tool_call_id
            WHERE p.session_id = ? AND p.source_user_seq = ?
              AND p.state = 'started') AS dispatch_n
      `).get(...identity, ...identity) as { logical_n: number; dispatch_n: number }
    : db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM logical_tool_calls
            WHERE session_id = ? AND source_user_seq = ? AND state != 'settled') AS logical_n,
          (SELECT COUNT(*) FROM physical_dispatches
            WHERE session_id = ? AND source_user_seq = ? AND state = 'started') AS dispatch_n
      `).get(...identity, ...identity) as { logical_n: number; dispatch_n: number };
  if (row.dispatch_n > 0) return true;
  if (row.logical_n === 0) return false;
  // COMPLETED FAILURES ARE NOT IN-FLIGHT (live 2026-08-19 sess …707149:
  // a bound workflow_update RETURNED ok:false, zero physical dispatches, its
  // logical row stayed 'open' forever, and a turn whose goal was achieved by
  // a different settled call was labeled blocked — "unsettled logical or
  // physical work"). An open row is in-flight only while its call could
  // still land: with NO started dispatch and a durable failure return, the
  // attempt is over. Rows with a started dispatch keep blocking — that is
  // the double-send protection and it stays absolute.
  const openRows = db.prepare(`
    SELECT logical_tool_call_id FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND state != 'settled'
  `).all(...identity) as Array<{ logical_tool_call_id: string }>;
  for (const open of openRows) {
    const dispatched = db.prepare(`
      SELECT 1 FROM physical_dispatches
       WHERE session_id = ? AND logical_tool_call_id = ? LIMIT 1
    `).get(expected.identity.sessionId, open.logical_tool_call_id);
    if (dispatched) return true;
    const failedReturn = db.prepare(`
      SELECT 1 FROM events
       WHERE session_id = ? AND type = 'tool_returned'
         AND json_extract(data_json, '$.callId') = ?
         AND json_extract(data_json, '$.ok') IN (0, 'false')
       LIMIT 1
    `).get(expected.identity.sessionId, open.logical_tool_call_id);
    if (!failedReturn) return true;
  }
  return false;
}

/**
 * True when every settled call this source owns is control-role bookkeeping
 * (status probes, output queries, asks). One settled non-control call — a
 * business read, a continued page, a discovery probe of a business
 * capability — means real tool activity happened and the zero-work terminal
 * door must stay closed. Wrapped carriers whose inner identity cannot be
 * re-derived from the stored name classify as business, which fails closed.
 */
function sourceSettledOnlyControlCallsInTransaction(
  db: ReturnType<typeof openEventLog>,
  sessionId: string,
  sourceUserSeq: number,
): boolean {
  const rows = db.prepare(`
    SELECT l.tool_name AS tool_name
      FROM logical_call_settlements s
      JOIN logical_tool_calls l
        ON l.session_id = s.session_id
       AND l.source_user_seq = s.source_user_seq
       AND l.logical_tool_call_id = s.logical_tool_call_id
     WHERE s.session_id = ? AND s.source_user_seq = ?
  `).all(sessionId, sourceUserSeq) as Array<{ tool_name: string }>;
  return rows.every((row) => actionTopologyRoleForRuntimeCall(row.tool_name, undefined) === 'control');
}

/**
 * The zero-work terminal door for the deterministic retrieve contract.
 *
 * The once-read is AT-MOST-once: the contract bounds what work may count, it
 * never mandates work occur. A turn that recorded no business operation and
 * settled nothing beyond control-role bookkeeping did no work — the reply is
 * the terminal. One settled non-control call (a continued page, a discovery
 * probe of a business capability) keeps the door closed: real tool activity
 * must still discharge or hold.
 */
function zeroWorkRetrieveTerminalInTransaction(input: {
  db: ReturnType<typeof openEventLog>;
  contract: Extract<ReturnType<typeof loadExpectedWorkContract>, { status: 'ok' }>['contract'];
  match: ExpectedWorkMatchResult;
  operationCount: number;
  sessionId: string;
  sourceUserSeq: number;
}): boolean {
  return input.match.status === 'incomplete'
    && input.operationCount === 0
    && isDeterministicImplicitRetrieveContract(input.contract)
    && sourceSettledOnlyControlCallsInTransaction(input.db, input.sessionId, input.sourceUserSeq);
}

export type ExpectedWorkResolutionFinalization =
  | {
      status: 'finalized' | 'replayed';
      match: ExpectedWorkMatchResult;
      resolution: FinalizedResolution;
    }
  | { status: 'incomplete'; match: ExpectedWorkMatchResult }
  | { status: 'conflict'; match?: ExpectedWorkMatchResult; reason?: string }
  | { status: 'not_ready' | 'storage_error'; reason: string };

function deterministicExpectedWorkMatch(input: {
  contract: Extract<ReturnType<typeof loadExpectedWorkContract>, { status: 'ok' }>['contract'];
}): { status: 'ok'; match: ExpectedWorkMatchResult } | { status: 'storage_error'; reason: string } {
  const projected = projectObservedExpectedWorkHistory({
    contract: input.contract,
    // Matching happens against the exact set the surrounding IMMEDIATE
    // transaction is proposing to freeze. This flag is tentative until the
    // resolution CAS below succeeds.
    finalized: true,
  });
  if (projected.status !== 'ok') return projected;
  return { status: 'ok', match: matchExpectedWork(input.contract, projected.history) };
}

function expectedWorkContractStillBoundInTransaction(
  db: ReturnType<typeof openEventLog>,
  contract: Extract<ReturnType<typeof loadExpectedWorkContract>, { status: 'ok' }>['contract'],
): boolean {
  return Boolean(db.prepare(`
    SELECT 1
      FROM accepted_task_authority a
      JOIN accepted_task_work_contracts c
        ON c.session_id = a.session_id
       AND c.source_user_seq = a.source_user_seq
       AND c.contract_id = a.work_contract_id
     WHERE a.session_id = ? AND a.source_user_seq = ?
       AND a.accepted_task_id = ?
       AND a.graph_event_id = ? AND a.graph_id = ? AND a.graph_hash = ?
       AND a.state != 'conflict'
       AND c.accepted_task_id = ?
       AND c.graph_event_id = ? AND c.graph_id = ? AND c.graph_hash = ?
       AND c.contract_id = ?
     LIMIT 1
  `).get(
    contract.identity.sessionId,
    contract.identity.sourceUserSeq,
    contract.acceptedTaskId,
    contract.graphEventId,
    contract.graphId,
    contract.graphHash,
    contract.acceptedTaskId,
    contract.graphEventId,
    contract.graphId,
    contract.graphHash,
    contract.contractId,
  ));
}

/**
 * Typed pre-close admission for the deterministic expected-work cutover.
 *
 * Incomplete/conflicting work never closes the accepted task. A later host
 * repair can therefore add evidence under the same task. Exact replay after a
 * restart is idempotent, but only after count, digest and contract match all
 * recompute from durable rows. Action topology remains staged and is refused
 * here until its production scheduler supplies the missing bindings.
 */
export function finalizeResolutionAgainstExpectedWork(input: {
  sessionId: string;
  sourceUserSeq: number;
  turn?: number;
}): ExpectedWorkResolutionFinalization {
  const loaded = loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
  if (loaded.status === 'missing') {
    return { status: 'not_ready', reason: 'accepted task has no immutable expected-work contract' };
  }
  if (loaded.status === 'storage_error') {
    return { status: 'storage_error', reason: loaded.reason };
  }
  if (loaded.status !== 'ok') {
    return { status: 'conflict', reason: `expected-work contract is ${loaded.status}: ${loaded.reason}` };
  }
  const expectedState = expectedTaskFor(input.sessionId, input.sourceUserSeq);
  if (expectedState.status !== 'ok') {
    return {
      status: expectedState.status === 'missing' ? 'not_ready' : 'conflict',
      reason: expectedState.reason,
    };
  }
  const expected = expectedState.expectation;
  if (
    loaded.contract.acceptedTaskId !== expected.acceptedTaskId
    || loaded.contract.graphEventId !== expected.graphEventId
    || loaded.contract.graphId !== expected.graphId
    || loaded.contract.graphHash !== expected.graphHash
  ) {
    return { status: 'conflict', reason: 'expected-work contract does not match accepted resolution authority' };
  }

  const db = openEventLog();
  let mirror: EventRow | null = null;
  try {
    const commit = db.transaction((): ExpectedWorkResolutionFinalization => {
      if (!expectedWorkContractStillBoundInTransaction(db, loaded.contract)) {
        return { status: 'conflict', reason: 'expected-work contract lost its exact authority binding' };
      }
      const resolution = ensureOpenResolution(db, expected);
      const operations = (db.prepare(`
        SELECT * FROM accepted_task_operations
         WHERE session_id = ? AND source_user_seq = ?
         ORDER BY recorded_at, operation_id
      `).all(input.sessionId, input.sourceUserSeq) as OperationRow[]).map(operationFact);
      const digest = operationsDigest(operations);
      const adjudicated = deterministicExpectedWorkMatch({ contract: loaded.contract });
      if (adjudicated.status !== 'ok') return adjudicated;
      // Freshness honesty for the zero-read case is owned by terminal
      // preparation, which gates BEFORE this close so a held turn remains
      // repairable.
      const zeroWorkTerminal = zeroWorkRetrieveTerminalInTransaction({
        db,
        contract: loaded.contract,
        match: adjudicated.match,
        operationCount: operations.length,
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
      });
      if (resolution.state === 'finalized') {
        if (
          resolution.operation_count !== operations.length
          || resolution.operations_digest !== digest
          || resolution.expectations_satisfied !== 1
          || (adjudicated.match.status !== 'complete' && !zeroWorkTerminal)
        ) {
          return {
            status: 'conflict',
            match: adjudicated.match,
            reason: 'finalized resolution does not replay against its exact contract and digest',
          };
        }
        return {
          status: 'replayed',
          match: adjudicated.match,
          resolution: {
            operationCount: operations.length,
            operationsDigest: digest,
            expectationsSatisfied: true,
          },
        };
      }
      if (resolution.state !== 'open') {
        return { status: 'conflict', reason: `accepted task resolution is ${resolution.state}` };
      }
      if (hasUnsettledToolWorkInTransaction(db, expected)) {
        return { status: 'not_ready', reason: 'accepted task still has unsettled logical or physical work' };
      }
      if (adjudicated.match.status === 'incomplete' && !zeroWorkTerminal) {
        return { status: 'incomplete', match: adjudicated.match };
      }
      if (adjudicated.match.status === 'conflict') {
        return { status: 'conflict', match: adjudicated.match };
      }

      mirror = insertInternalEventInTransaction(db, {
        sessionId: input.sessionId,
        turn: expected.identity.turn,
        role: 'system',
        type: RESOLUTION_FINALIZED_EVENT,
        data: {
          sourceUserSeq: input.sourceUserSeq,
          acceptedTaskId: expected.acceptedTaskId,
          graphId: expected.graphId,
          graphHash: expected.graphHash,
          workContractId: loaded.contract.contractId,
          operationCount: operations.length,
          operationsDigest: digest,
          expectationsSatisfied: true,
          expectedWorkMatch: zeroWorkTerminal
            ? 'zero_work'
            : adjudicated.match.status !== 'complete'
              ? 'conversation_shaped'
              : 'complete',
        },
      });
      const updated = db.prepare(`
        UPDATE accepted_task_resolutions
           SET state = 'finalized', revision = revision + 1,
               operation_count = ?, operations_digest = ?, expectations_satisfied = 1,
               finalized_at = ?, finalize_event_id = ?
         WHERE session_id = ? AND source_user_seq = ? AND state = 'open'
      `).run(
        operations.length,
        digest,
        mirror.createdAt,
        mirror.id,
        input.sessionId,
        input.sourceUserSeq,
      );
      if (updated.changes !== 1) throw new Error('expected-work resolution finalization lost its CAS');
      ensureResolutionCallAuthorityInTransaction(db, expected, {
        ...resolution,
        state: 'finalized',
        operation_count: operations.length,
        operations_digest: digest,
        expectations_satisfied: 1,
        finalized_at: mirror.createdAt,
      });
      return {
        status: 'finalized',
        match: adjudicated.match,
        resolution: {
          operationCount: operations.length,
          operationsDigest: digest,
          expectationsSatisfied: true,
        },
      };
    });
    const result = commit.immediate();
    if (result.status === 'finalized' && mirror) publishCommittedInternalEvent(mirror);
    return result;
  } catch (error) {
    return {
      status: 'storage_error',
      reason: String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 240),
    };
  }
}

/**
 * Atomically freeze the observed set for an accepted task.
 *
 * This does not yet publish a user terminal. The common terminal committer will
 * consume this state only after every lane records logical operations and the
 * manifest-backed adjudicator replaces the legacy requirement reader.
 */
function finalizeResolutionLegacy(input: {
  sessionId: string;
  sourceUserSeq: number;
  turn?: number;
}): boolean {
  const expectedState = expectedTaskFor(input.sessionId, input.sourceUserSeq);
  if (expectedState.status !== 'ok') return false;
  const expected = expectedState.expectation;
  const db = openEventLog();
  let mirror: EventRow | null = null;
  try {
    const commit = db.transaction((): boolean => {
      const resolution = ensureOpenResolution(db, expected);
      if (resolution.state !== 'open') return false;
      // A zero-crossing refusal is still a logical call. Freezing while any
      // logical call lacks its normalized settlement would let terminal truth
      // race a pre-dispatch gate just as surely as an in-flight provider call.
      if (hasUnsettledToolWorkInTransaction(db, expected)) return false;
      const operations = (db.prepare(`
        SELECT * FROM accepted_task_operations
         WHERE session_id = ? AND source_user_seq = ?
         ORDER BY recorded_at, operation_id
      `).all(input.sessionId, input.sourceUserSeq) as OperationRow[]).map(operationFact);
      const digest = operationsDigest(operations);
      const satisfied = expectationSatisfied(expected, operations);
      mirror = insertInternalEventInTransaction(db, {
        sessionId: input.sessionId,
        turn: expected.identity.turn,
        role: 'system',
        type: RESOLUTION_FINALIZED_EVENT,
        data: {
          sourceUserSeq: input.sourceUserSeq,
          acceptedTaskId: expected.acceptedTaskId,
          graphId: expected.graphId,
          graphHash: expected.graphHash,
          operationCount: operations.length,
          operationsDigest: digest,
          expectationsSatisfied: satisfied,
        },
      });
      const updated = db.prepare(`
        UPDATE accepted_task_resolutions
           SET state = 'finalized', revision = revision + 1,
               operation_count = ?, operations_digest = ?, expectations_satisfied = ?,
               finalized_at = ?, finalize_event_id = ?
         WHERE session_id = ? AND source_user_seq = ? AND state = 'open'
      `).run(
        operations.length,
        digest,
        satisfied ? 1 : 0,
        mirror.createdAt,
        mirror.id,
        input.sessionId,
        input.sourceUserSeq,
      );
      if (updated.changes !== 1) throw new Error('resolution finalization lost its CAS');
      ensureResolutionCallAuthorityInTransaction(db, expected, {
        ...resolution,
        state: 'finalized',
        operation_count: operations.length,
        operations_digest: digest,
        expectations_satisfied: satisfied ? 1 : 0,
        finalized_at: mirror.createdAt,
      });
      return true;
    });
    const finalized = commit.immediate();
    if (finalized && mirror) publishCommittedInternalEvent(mirror);
    return finalized;
  } catch {
    return false;
  }
}

/** Compatibility wrapper. Contracted deterministic turns use the typed
 * pre-close admission above; uncontracted/action turns retain the staged
 * legacy path until action topology is cut over. Exact replay remains `false`
 * here for callers whose historical boolean means "I performed the close". */
export function finalizeResolution(input: {
  sessionId: string;
  sourceUserSeq: number;
  turn?: number;
}): boolean {
  const contract = loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
  if (contract.status === 'ok') {
    return finalizeResolutionAgainstExpectedWork(input).status === 'finalized';
  }
  if (contract.status !== 'missing') return false;
  return finalizeResolutionLegacy(input);
}

export interface FinalizedResolution {
  operationCount: number;
  operationsDigest: string;
  expectationsSatisfied: boolean;
}

export type FrozenResolutionState =
  | {
      status: 'ok';
      resolution: FinalizedResolution;
      operations: ResolvedOperationFact[];
    }
  | { status: 'missing'; reason: string }
  | { status: 'ambiguous'; reason: string };

/**
 * Rehydrate the frozen operation set as one integrity-checked artifact.
 *
 * Reading the finalization row and operations independently can manufacture a
 * false zero-operation success if either read fails or rows are damaged after
 * close. A frozen resolution is usable only when count, digest, and the
 * graph-derived expectation verdict all recompute byte-for-byte.
 */
export function frozenResolutionFor(
  sessionId: string,
  sourceUserSeq: number,
): FrozenResolutionState {
  const expectedState = expectedTaskFor(sessionId, sourceUserSeq);
  if (expectedState.status !== 'ok') {
    return {
      status: expectedState.status,
      reason: `accepted task expectation is ${expectedState.status}: ${expectedState.reason}`,
    };
  }
  try {
    const db = openEventLog();
    const row = db.prepare(`
      SELECT state, operation_count, operations_digest, expectations_satisfied
        FROM accepted_task_resolutions
       WHERE session_id = ? AND source_user_seq = ?
    `).get(sessionId, sourceUserSeq) as ResolutionRow | undefined;
    if (!row || row.state !== 'finalized') {
      return { status: 'missing', reason: 'accepted task resolution is not finalized' };
    }
    if (!row.operations_digest || row.expectations_satisfied === null) {
      return { status: 'ambiguous', reason: 'finalized resolution lacks its frozen verdict' };
    }
    const operations = (db.prepare(`
      SELECT * FROM accepted_task_operations
       WHERE session_id = ? AND source_user_seq = ?
       ORDER BY recorded_at, operation_id
    `).all(sessionId, sourceUserSeq) as OperationRow[]).map(operationFact);
    const digest = operationsDigest(operations);
    if (operations.length !== row.operation_count || digest !== row.operations_digest) {
      return { status: 'ambiguous', reason: 'frozen operation count or digest does not match its rows' };
    }
    const contract = loadExpectedWorkContract(sessionId, sourceUserSeq);
    if (contract.status !== 'ok' && contract.status !== 'missing') {
      return {
        status: 'ambiguous',
        reason: `frozen expected-work contract is ${contract.status}: ${contract.reason}`,
      };
    }
    let recomputedSatisfied: boolean;
    if (contract.status === 'ok') {
      const adjudicated = deterministicExpectedWorkMatch({ contract: contract.contract });
      if (adjudicated.status !== 'ok') {
        return { status: 'ambiguous', reason: adjudicated.reason };
      }
      recomputedSatisfied = adjudicated.match.status === 'complete'
        || zeroWorkRetrieveTerminalInTransaction({
          db,
          contract: contract.contract,
          match: adjudicated.match,
          operationCount: operations.length,
          sessionId,
          sourceUserSeq,
        });
    } else {
      recomputedSatisfied = expectationSatisfied(expectedState.expectation, operations);
    }
    if (recomputedSatisfied !== (row.expectations_satisfied === 1)) {
      return { status: 'ambiguous', reason: 'frozen expectation verdict does not match the accepted graph' };
    }
    return {
      status: 'ok',
      resolution: {
        operationCount: row.operation_count,
        operationsDigest: row.operations_digest,
        expectationsSatisfied: recomputedSatisfied,
      },
      operations,
    };
  } catch (error) {
    return { status: 'ambiguous', reason: `resolution store unreadable: ${String(error)}` };
  }
}

export function finalizedResolutionFor(
  sessionId: string,
  sourceUserSeq: number,
): FinalizedResolution | null {
  const state = frozenResolutionFor(sessionId, sourceUserSeq);
  return state.status === 'ok' ? state.resolution : null;
}

export function resolutionIsFinalized(sessionId: string, sourceUserSeq: number): boolean {
  return finalizedResolutionFor(sessionId, sourceUserSeq) !== null;
}
