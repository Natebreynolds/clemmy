import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  getProactivityPolicySnapshot,
  type ProactivityPolicySnapshot,
} from '../../agents/proactivity-policy.js';
import {
  appendTurnGraphEventOnce,
  getSession,
  getTurnGraphEventForSource,
  listEvents,
  type EventRow,
} from '../harness/eventlog.js';
import type { TurnIdentity } from '../harness/turn-outcome.js';
import type { TaskContinuationContext } from '../../types.js';
import {
  rehydrateConsumedClarificationContext,
  verifyDurableClarificationContext,
  verifiedAcceptedControlSemanticInput,
} from '../harness/task-continuity-runtime.js';
import {
  compileTurnGraph,
  snapshotTurnGraphPolicy,
  validateTurnGraph,
} from './turn-graph-compiler.js';
import type {
  AdmittedTurnSemantics,
  DurableAcceptedTurnGraphPersistenceTicket,
} from './admitted-turn-semantics.js';
import {
  inspectDurableAcceptedTurnGraphPersistenceTicket,
  isAdmittedTurnSemantics,
} from './admitted-turn-semantics.js';
import type {
  TurnGraphIR,
  TurnGraphPolicySnapshot,
  TurnGraphSurface,
} from './turn-graph-ir.js';

export interface RecordTurnGraphShadowInput {
  identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>;
  surface?: TurnGraphSurface;
  allowedToolNames?: readonly string[];
  excludedToolNames?: readonly string[];
  /** Exact-source runtime continuation context. A non-decline compiles from
   * its durable A/Q/B capsule; only the independently parsed fresh clause of
   * `declined_with_new_task` may exclude A. B remains the immutable graph
   * parent and accepted-task identity in either case. */
  verifiedTaskContinuation?: TaskContinuationContext;
  /** Injection seam for callers/tests that already captured the policy. */
  policy?: TurnGraphPolicySnapshot | ProactivityPolicySnapshot;
  /** Opaque admitted semantics. When present, compile is typed-only. */
  admitted?: AdmittedTurnSemantics;
  /** Precompiled graph from compileAdmittedTurn. Persisted as-is. */
  graph?: TurnGraphIR;
  /** Unforgeable binding from the durable semantic compiler. */
  persistenceTicket?: DurableAcceptedTurnGraphPersistenceTicket;
}

interface TaskContinuationLineage {
  packetId: string;
  parentSourceUserSeq: number;
  parentAcceptedTaskId: string;
  consumingSourceUserSeq: number;
  acceptedTaskId: string;
  disposition: TaskContinuationContext['disposition'];
}

// Keep the graph reader off attempt-identity's dispatch-ledger module cycle.
// This is the accepted-task protocol's public deterministic identity formula;
// production pins compare it to acceptedTaskIdFor at the authority boundary.
export function sessionHasPriorRetrieveOrAct(sessionId: string, beforeSourceUserSeq: number): boolean {
  if (!sessionId.trim() || !Number.isSafeInteger(beforeSourceUserSeq) || beforeSourceUserSeq <= 0) {
    return false;
  }
  return listEvents(sessionId, { types: ['turn_graph_compiled'] }).some((event) => {
    const source = event.data?.sourceUserSeq;
    const route = event.data?.route;
    return typeof source === 'number'
      && Number.isSafeInteger(source)
      && source > 0
      && source < beforeSourceUserSeq
      && (route === 'retrieve' || route === 'act');
  });
}

function lineageAcceptedTaskId(sessionId: string, sourceUserSeq: number): string {
  return `task:${sessionId}#${sourceUserSeq}`;
}

function continuationLineageFor(
  sessionId: string,
  context: TaskContinuationContext,
): TaskContinuationLineage {
  return {
    packetId: context.packetId,
    parentSourceUserSeq: context.parentSourceUserSeq,
    parentAcceptedTaskId: lineageAcceptedTaskId(sessionId, context.parentSourceUserSeq),
    consumingSourceUserSeq: context.consumingSourceUserSeq,
    acceptedTaskId: lineageAcceptedTaskId(sessionId, context.consumingSourceUserSeq),
    disposition: context.disposition,
  };
}

function parseContinuationLineage(value: unknown): TaskContinuationLineage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const dispositions = new Set<TaskContinuationContext['disposition']>([
    'affirmed', 'declined', 'declined_with_new_task', 'selected', 'provided',
  ]);
  if (
    typeof row.packetId !== 'string'
    || !row.packetId
    || typeof row.parentSourceUserSeq !== 'number'
    || !Number.isSafeInteger(row.parentSourceUserSeq)
    || Number(row.parentSourceUserSeq) <= 0
    || typeof row.parentAcceptedTaskId !== 'string'
    || typeof row.consumingSourceUserSeq !== 'number'
    || !Number.isSafeInteger(row.consumingSourceUserSeq)
    || Number(row.consumingSourceUserSeq) <= 0
    || typeof row.acceptedTaskId !== 'string'
    || !dispositions.has(row.disposition as TaskContinuationContext['disposition'])
    || Object.keys(row).some((key) => ![
      'packetId',
      'parentSourceUserSeq',
      'parentAcceptedTaskId',
      'consumingSourceUserSeq',
      'acceptedTaskId',
      'disposition',
    ].includes(key))
  ) return null;
  return row as unknown as TaskContinuationLineage;
}

function sameContinuationLineage(
  left: TaskContinuationLineage,
  right: TaskContinuationLineage,
): boolean {
  return left.packetId === right.packetId
    && left.parentSourceUserSeq === right.parentSourceUserSeq
    && left.parentAcceptedTaskId === right.parentAcceptedTaskId
    && left.consumingSourceUserSeq === right.consumingSourceUserSeq
    && left.acceptedTaskId === right.acceptedTaskId
    && left.disposition === right.disposition;
}

/**
 * Read the exact closed IR carried by a durable shadow event.
 *
 * The bridge and the provider lane can both observe one accepted source. The
 * event is the only graph they may share; compiling again creates two subtly
 * different contracts (approval resume used to do exactly that). This decoder
 * verifies identity, metadata and the content address before the graph can be
 * handed to an executor or an evidence authority.
 */
export function turnGraphFromShadowEvent(event: EventRow | null): TurnGraphIR | null {
  if (!event || event.type !== 'turn_graph_compiled') return null;
  const graph = event.data.graph as TurnGraphIR | undefined;
  if (!graph || typeof graph !== 'object') return null;
  if (
    graph.identity.sessionId !== event.sessionId
    || graph.identity.turn !== event.turn
    || graph.identity.sourceUserSeq !== event.data.sourceUserSeq
    || graph.graphId !== event.data.graphId
    || graph.compiler.graphHash !== event.data.graphHash
  ) return null;
  const rawLineage = event.data.taskContinuationLineage;
  if (rawLineage !== undefined) {
    const lineage = parseContinuationLineage(rawLineage);
    const source = acceptedSource(graph.identity);
    const sourceText = source ? acceptedText(source) : '';
    if (!lineage || !source || !sourceText) return null;
    const durable = rehydrateConsumedClarificationContext({
      sessionId: event.sessionId,
      sourceUserSeq: graph.identity.sourceUserSeq,
      answer: sourceText,
    });
    if (
      !durable
      || !sameContinuationLineage(
        lineage,
        continuationLineageFor(event.sessionId, durable),
      )
    ) return null;
    const semanticText = graphSemanticText(sourceText, graph.identity, durable, source);
    const expectedInputHash = createHash('sha256').update(semanticText, 'utf8').digest('hex');
    if (graph.source.inputHash !== expectedInputHash) return null;
  } else {
    const source = acceptedSource(graph.identity);
    const sourceText = source ? acceptedText(source) : '';
    const semanticText = source
      ? graphSemanticText(sourceText, graph.identity, undefined, source)
      : sourceText;
    if (
      !sourceText
      || graph.source.inputHash !== createHash('sha256').update(semanticText, 'utf8').digest('hex')
    ) return null;
  }
  const validation = validateTurnGraph(graph);
  if (!validation.ok) return null;
  const cloned = structuredClone(graph);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  };
  freeze(cloned);
  return cloned;
}

function acceptedSource(identity: RecordTurnGraphShadowInput['identity']): EventRow | null {
  return listEvents(identity.sessionId, {
    sinceSeq: identity.sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  }).find((event) => event.seq === identity.sourceUserSeq) ?? null;
}

function acceptedText(event: EventRow): string {
  const displayText = typeof event.data.displayText === 'string' ? event.data.displayText.trim() : '';
  const text = typeof event.data.text === 'string' ? event.data.text.trim() : '';
  return displayText || text;
}

function graphSemanticText(
  sourceText: string,
  identity: RecordTurnGraphShadowInput['identity'],
  context?: TaskContinuationContext,
  source?: EventRow,
): string {
  // A conversational Yes is not a fresh semantic task. Rehydrate the exact
  // frozen send only after the registry proves this accepted source is the
  // addressed response that resolved it. This makes the graph/expected-work
  // contract an act/external_write contract instead of direct_reply/zero-op.
  const acceptedControl = source
    ? verifiedAcceptedControlSemanticInput(source, identity)
    : null;
  if (acceptedControl) return acceptedControl;
  if (
    !context
    || context.consumingSourceUserSeq !== identity.sourceUserSeq
    || context.answer !== sourceText
  ) return sourceText;
  if (context.disposition === 'declined_with_new_task') {
    if (typeof context.activeTaskInput !== 'string' || !context.activeTaskInput.trim()) {
      return sourceText;
    }
    const normalizedSource = sourceText.replace(/\s+/g, ' ').trim();
    const normalizedActive = context.activeTaskInput.replace(/\s+/g, ' ').trim();
    return normalizedSource.includes(normalizedActive) ? normalizedActive : sourceText;
  }
  if (context.disposition === 'declined') return sourceText;
  // affirmed / selected / provided: the answer resolves the parent ask's open
  // slot, so THE TASK IS THE CANONICAL A/Q/B CAPSULE. In particular Q may
  // contain the model's corrected interpretation or destination (live:
  // "amplify" meant Apify and Nate meant nathan.reynolds@scorpion.co). Omitting
  // it would correctly recover the action ceiling while still executing the
  // wrong task. Classifying the bare answer routed a
  // full action turn as a zero-op retrieve — "Highest value would be perfect"
  // compiled with ceiling read while the run pulled Salesforce data, built a
  // draft, and needed to send it (live 2026-08-12, seq 44061), which severed
  // the send from every authority YOLO auto-approve rides on. Compile route,
  // effect ceiling, and contract from the composite instead.
  if (
    typeof context.retrievalQuery === 'string'
    && context.retrievalQuery.trim()
    && context.parentInput.trim()
    && context.question.trim()
  ) {
    return context.retrievalQuery.trim();
  }
  return sourceText;
}

function isGraphPolicy(value: RecordTurnGraphShadowInput['policy']): value is TurnGraphPolicySnapshot {
  return Boolean(value && 'version' in value && value.version === 'turn-policy-v1');
}

function suppliedGraphMatchesAcceptedSource(input: {
  graph: TurnGraphIR;
  identity: RecordTurnGraphShadowInput['identity'];
  graphId: string;
  sourceText: string;
}): boolean {
  const validation = validateTurnGraph(input.graph);
  return validation.ok
    && input.graph.identity.sessionId === input.identity.sessionId
    && input.graph.identity.turn === input.identity.turn
    && input.graph.identity.sourceUserSeq === input.identity.sourceUserSeq
    && input.graph.graphId === input.graphId
    && input.graph.source.inputHash === createHash('sha256')
      .update(input.sourceText, 'utf8')
      .digest('hex');
}

/**
 * Compile and persist the observational graph for one exact accepted chat turn.
 *
 * Ordinary observations remain best-effort. A supplied continuation is
 * execution-sensitive because it can raise the effect ceiling, so unverifiable
 * A/Q/B lineage returns null and the provider admission boundary fails closed.
 * This function never performs external work.
 */
/** Closed refusal vocabulary. Host-owned strings only — never model or source
 *  text: reasons land in logs and durable turn outcomes, and free text in a
 *  durable discriminator is the exact class two prior reviews caught. */
export type TurnGraphShadowRefusalReason =
  | 'session_missing'
  | 'source_missing'
  | 'continuation_unverified'
  | 'ticket_invalid'
  | 'prior_lineage_mismatch'
  | 'prior_undecodable'
  | 'prior_source_mismatch'
  | 'provenance_digest_mismatch'
  | 'graph_hash_mismatch'
  | 'admitted_without_graph'
  | 'compile_validation_failed'
  | 'append_failed'
  | 'internal_error';

/**
 * The checked variant: every refusal names itself.
 *
 * recordTurnGraphShadow had ~13 silent `return null` paths, so a caller could
 * only report "admitted graph persist failed" with no reason — which is what
 * made the 2026-08-25 workflow-step deaths (a repaired, ADMITTED plan refused
 * at persist against a digestless legacy prior) cost hours to attribute. The
 * legacy nullable wrapper below is kept for fixtures and non-diagnostic
 * callers; production admission paths call this and thread the reason.
 */
export function recordTurnGraphShadowChecked(
  input: RecordTurnGraphShadowInput,
): { ok: true; event: EventRow } | { ok: false; reason: TurnGraphShadowRefusalReason } {
  try {
    const session = getSession(input.identity.sessionId);
    // Every lane that dispatches through the settlement spine needs a
    // persisted graph — the dispatch ledger refuses logical calls without one.
    // The old chat-only gate predated that requirement and turned the FIRST
    // tool call of every background/workflow/execution run into
    // LogicalCallPreDispatchAuthorityError (live 2026-08-11:
    // long-horizon-manifest died in 8.9s on `background:bg-*`). Authority,
    // contracts, and terminal adjudication remain chat-scoped at their own
    // seams (loop.ts / claude-agent-brain / delivery-committer kind checks);
    // the graph itself is lane-neutral dispatch admission.
    if (!session) return { ok: false, reason: 'session_missing' };
    const source = acceptedSource(input.identity);
    if (!source || source.turn !== input.identity.turn) return { ok: false, reason: 'source_missing' };
    const sourceText = acceptedText(source);
    const verifiedContinuation = input.verifiedTaskContinuation
      ? verifyDurableClarificationContext({
          sessionId: input.identity.sessionId,
          sourceUserSeq: input.identity.sourceUserSeq,
          answer: sourceText,
          context: input.verifiedTaskContinuation,
        })
      : undefined;
    // Continuation semantics can raise the route/effect ceiling. A stale or
    // caller-forged A/Q/B capsule therefore fails closed instead of compiling
    // the bare answer and later admitting work under contradictory authority.
    if (input.verifiedTaskContinuation && !verifiedContinuation) return { ok: false, reason: 'continuation_unverified' };
    const lineage = verifiedContinuation
      ? continuationLineageFor(input.identity.sessionId, verifiedContinuation)
      : undefined;
    const graphId = `turn-graph:v1:${input.identity.sourceUserSeq}`;
    const durablePersistence = input.graph && input.persistenceTicket
      ? inspectDurableAcceptedTurnGraphPersistenceTicket({
          ticket: input.persistenceTicket,
          graph: input.graph,
        })
      : null;
    if (input.persistenceTicket && !durablePersistence) return { ok: false, reason: 'ticket_invalid' };
    const prior = getTurnGraphEventForSource(
      input.identity.sessionId,
      input.identity.sourceUserSeq,
    );
    if (prior) {
      const priorLineage = prior.data.taskContinuationLineage === undefined
        ? undefined
        : parseContinuationLineage(prior.data.taskContinuationLineage);
      if (lineage && (!priorLineage || !sameContinuationLineage(lineage, priorLineage))) {
        return { ok: false, reason: 'prior_lineage_mismatch' };
      }
      const priorGraph = turnGraphFromShadowEvent(prior);
      if (
        !priorGraph
        || prior.turn !== source.turn
        || prior.parentEventId !== source.id
        || prior.data.graphId !== graphId
      ) return { ok: false, reason: 'prior_undecodable' };

      // A typed admit/compile caller supplies the exact graph it intends to
      // persist. Reusing an older graph solely because it shares the source
      // identity can otherwise resurrect a legacy regex-derived action graph
      // after the semantic model has classified the same source as
      // conversation (or vice versa). Exact graph equality is therefore part
      // of replay authority for precompiled turns. Ordinary legacy observers
      // still dedupe their first graph without recompiling on another surface.
      if (input.graph) {
        if (!suppliedGraphMatchesAcceptedSource({
          graph: input.graph,
          identity: input.identity,
          graphId,
          sourceText,
        })) return { ok: false, reason: 'prior_source_mismatch' };
        if (durablePersistence) {
          if (
            prior.data.semanticProvenanceDigest
              !== durablePersistence.semanticProvenanceDigest
          ) return { ok: false, reason: 'provenance_digest_mismatch' };
        } else if (input.graph.compiler.graphHash !== priorGraph.compiler.graphHash) {
          return { ok: false, reason: 'graph_hash_mismatch' };
        }
      } else if (input.admitted) {
        // Admitted semantics must arrive through the atomic precompile seam;
        // accepting an opaque admission beside a pre-existing legacy graph
        // provides no graph hash with which to prove equivalence.
        return { ok: false, reason: 'admitted_without_graph' };
      }
      return { ok: true, event: prior };
    }

    const text = graphSemanticText(
      sourceText,
      input.identity,
      verifiedContinuation ?? undefined,
      source,
    );
    const policy = isGraphPolicy(input.policy)
      ? input.policy
      : snapshotTurnGraphPolicy(input.policy ?? getProactivityPolicySnapshot());
    const startedAt = performance.now();
    if (input.admitted !== undefined && !isAdmittedTurnSemantics(input.admitted)) {
      return { ok: false, reason: 'ticket_invalid' };
    }
    const compiled = input.graph
      ? {
          graph: input.graph,
          validation: suppliedGraphMatchesAcceptedSource({
            graph: input.graph,
            identity: input.identity,
            graphId,
            sourceText,
          })
            ? validateTurnGraph(input.graph)
            : {
                ok: false,
                errors: ['Precompiled graph does not match the exact accepted source.'],
                warnings: [],
                nodeCount: input.graph.nodes.length,
                edgeCount: input.graph.edges.length,
              },
        }
      : compileTurnGraph({
          identity: input.identity,
          input: text,
          sessionKind: session.kind,
          surface: input.surface ?? 'direct',
          policy,
          allowedToolNames: input.allowedToolNames,
          excludedToolNames: input.excludedToolNames,
          ...(input.admitted ? { admitted: input.admitted } : {}),
          signals: {
            continueHostedWorld: sessionHasPriorRetrieveOrAct(
              input.identity.sessionId,
              input.identity.sourceUserSeq,
            ),
          },
        });
    if (!compiled.validation.ok) return { ok: false, reason: 'compile_validation_failed' };
    const compileMs = Number((performance.now() - startedAt).toFixed(3));
    const graph = compiled.graph;
    const authorityRequirements = [...new Set(graph.nodes
      .map((node) => node.authority.requirement)
      .filter((requirement) => requirement !== 'none'))].sort();
    const capabilityKinds = [...new Set(graph.nodes
      .flatMap((node) => node.capabilities.map((capability) => capability.kind)))].sort();

    const appended = appendTurnGraphEventOnce({
      sessionId: input.identity.sessionId,
      turn: input.identity.turn,
      sourceUserSeq: input.identity.sourceUserSeq,
      data: {
        shadow: true,
        graphId: graph.graphId,
        graphVersion: graph.version,
        compilerVersion: graph.compiler.version,
        graphHash: graph.compiler.graphHash,
        policyHash: graph.compiler.policyHash,
        sourceUserSeq: input.identity.sourceUserSeq,
        route: graph.classification.route,
        fastPath: graph.fastPath,
        effectCeiling: graph.effectCeiling,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        compileMs,
        authorityRequirements,
        capabilityKinds,
        warnings: compiled.validation.warnings,
        ...(durablePersistence ? {
          semanticProvenanceDigest: durablePersistence.semanticProvenanceDigest,
        } : {}),
        ...(lineage ? { taskContinuationLineage: lineage } : {}),
        graph,
      },
    }).event;
    if (!appended) return { ok: false, reason: 'append_failed' };
    return { ok: true, event: appended };
  } catch {
    // Load-bearing blanket catch: this runs inside brain prepare, and a throw
    // here would take the turn down harder than a refusal. Reason construction
    // above is throw-free by design.
    return { ok: false, reason: 'internal_error' };
  }
}

/** Legacy nullable shape, kept for fixtures and non-diagnostic callers.
 *  Production admission paths use the checked variant and thread the reason. */
export function recordTurnGraphShadow(input: RecordTurnGraphShadowInput): EventRow | null {
  const result = recordTurnGraphShadowChecked(input);
  return result.ok ? result.event : null;
}
