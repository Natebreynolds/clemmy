/**
 * Production typed dispatcher. Route comes from durable semantic disposition
 * and the claim-linked admitted graph. Process-global port peeks and
 * construct-specific caller conditionals are not authority.
 */
import { turnGraphFromShadowEvent } from '../graph/turn-graph-shadow.js';
import { appendEvent, getTurnGraphEventForSource, listEvents } from '../harness/eventlog.js';
import {
  commitUnadmittedSemanticTurn,
  commitUnsupportedTypedExecutionTurn,
} from '../harness/record-accepted-source-graph.js';
import {
  runAdmittedSourceGraph,
  type ConstructRunResult,
} from '../harness/admitted-construct-run.js';
import type { TurnIdentity } from '../harness/turn-outcome.js';
import { readSemanticDisposition } from './semantic-disposition.js';
import {
  clarifyingOpenSlotQuestionForSource,
  admittedProposalClaimsNoTypedWork,
  hostOnlySketchForSource,
  readClaimLinkedSemanticInterpretation,
} from './interpret-accepted-source.js';
import { parkDependencyRequest } from '../harness/dependency-request.js';
import { describeGoalCatalogGap, selectGoalCatalog } from '../harness/connected-goal-catalog.js';
import { disposeGate } from '../gate-reason.js';
import { commitTurnOutcome } from '../harness/delivery-committer.js';
import {
  presentationEventFromCompletionData,
  turnOutcomeId,
  type PresentationEvent,
  type TurnOutcome,
} from '../harness/turn-outcome.js';
import { assessControlComplexity, generalSchedulerForbidden } from '../harness/control-complexity.js';
import { runDirectNodeInvocation } from '../harness/direct-invocation.js';
import { createHash } from 'node:crypto';
import { scheduleCliInventoryExpansion } from '../local-capability-enumeration.js';
import { PUBLIC_RUN_FAILURE_TEXT } from '../harness/public-presentation.js';
import { renderTypedControlState } from '../harness/typed-control-state.js';

/** The accepted source's own words, as the user wrote them. */
function objectiveForSource(
  identity: Pick<TurnIdentity, 'sessionId' | 'sourceUserSeq'>,
): string {
  try {
    const source = listEvents(identity.sessionId, {
      sinceSeq: identity.sourceUserSeq - 1,
      types: ['user_input_received'],
      limit: 1,
    }).find((event) => event.seq === identity.sourceUserSeq);
    const display = source?.data.displayText;
    if (typeof display === 'string' && display.trim()) return display;
    return typeof source?.data.text === 'string' ? source.data.text : '';
  } catch {
    return '';
  }
}

function graphPromisesWrite(graph: { effectCeiling?: string }): boolean {
  const ceiling = graph.effectCeiling;
  return ceiling === 'external_write' || ceiling === 'local_write';
}

function graphPromisesUnknown(graph: { effectCeiling?: string }): boolean {
  return graph.effectCeiling === 'unknown' || graph.effectCeiling === 'admin';
}

function stopUnboundWork(
  identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>,
  graph: { effectCeiling?: string },
): Extract<TypedSourceDispatch, { kind: 'blocked' }> {
  const write = graphPromisesWrite(graph);
  const text = write
    ? 'I could not bind that change to an exact connected contract, so I stopped before changing anything. Connect the app or name the exact destination if you want me to continue.'
    : 'I could not bind that to an exact connected contract, so I stopped before doing anything. Connect the app or name the exact contract if you want me to continue.';
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity: {
      sessionId: identity.sessionId,
      turn: identity.turn,
      sourceUserSeq: identity.sourceUserSeq,
    },
    status: 'blocked',
    resumable: true,
    presentation: { kind: 'blocked', text },
  });
  return { kind: 'blocked', text };
}

function parkUnboundRead(
  identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>,
): Extract<TypedSourceDispatch, { kind: 'needs_input' }> {
  const parked = parkDependencyRequest({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    turn: identity.turn,
    kind: 'capability_contract_missing',
  });
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity: {
      sessionId: identity.sessionId,
      turn: identity.turn,
      sourceUserSeq: identity.sourceUserSeq,
    },
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: parked.text },
  });
  return { kind: 'needs_input', text: parked.text };
}

/**
 * After the semantic port participates, the turn stays on this kernel.
 * Conversation is only converse-first (direct_reply) or a host-only sketch.
 */
function stopUnboundParticipated(
  identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>,
  graph: { effectCeiling?: string } | null,
): Extract<TypedSourceDispatch, { kind: 'blocked' | 'needs_input' }> {
  // This is the one place a participated turn is KNOWN to have failed to bind,
  // and it is therefore where we learn the catalog may have been incomplete.
  // Some carriers are a control plane rather than a capability list — a local
  // program is indexed as one row while its subcommands are the capabilities —
  // so a selection over that catalog can only refuse. Refusing is right;
  // guessing would be worse. But never ASKING makes the refusal permanent, and
  // it reads as principled while being false.
  //
  // Deliberately here and not inside the binder: that is a pure selector, run
  // more than once per turn and called directly by tests, and giving it a side
  // effect would fire this repeatedly for one ask. Detached because this turn
  // has already failed — probing costs seconds and cannot save it, but the
  // answer is durable, so it buys every later ask.
  try { scheduleCliInventoryExpansion(objectiveForSource(identity)); } catch { /* best effort */ }
  if (graph && (graphPromisesWrite(graph) || graphPromisesUnknown(graph))) {
    return unboundConstructConnectionPark(identity) ?? stopUnboundWork(identity, graph);
  }
  return parkUnboundRead(identity);
}

/**
 * Park only a real missing connection. Consequential writes never fall through
 * to the conversation loop (north-star cutover: no fallback across cores).
 */
function unboundConstructConnectionPark(
  identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>,
): Extract<TypedSourceDispatch, { kind: 'needs_input' }> | null {
  try {
    const source = listEvents(identity.sessionId, {
      sinceSeq: identity.sourceUserSeq - 1,
      types: ['user_input_received'],
      limit: 1,
    }).find((event) => event.seq === identity.sourceUserSeq);
    const objective = typeof source?.data.displayText === 'string' && source.data.displayText.trim()
      ? source.data.displayText
      : typeof source?.data.text === 'string' ? source.data.text : '';
    const graph = turnGraphFromShadowEvent(getTurnGraphEventForSource(identity.sessionId, identity.sourceUserSeq));
    const construct = graph?.classification.goalConstraints?.construct;
    const collection = graph?.classification.goalConstraints?.collection;
    const hasDestination = Boolean(graph?.classification.goalConstraints?.destination)
      || ((graph?.classification.goalConstraints?.destinations?.length ?? 0) > 0);
    const connectionShaped = construct === 'collect_then_construct'
      || (collection?.projection.length ?? 0) > 0
      || (construct === 'single_act' && hasDestination);
    const gaps = connectionShaped ? selectGoalCatalog(objective).gaps : [];
    if (gaps.length === 0) return null;
    const gate = disposeGate({
      posture: 'authorized_reversible',
      missingCredentialConnection: { capabilityId: `family:${gaps[0]}` },
    });
    if (gate.status !== 'needs_input') return null;
    const question = describeGoalCatalogGap(gaps, { projection: collection?.projection });
    parkDependencyRequest({
      sessionId: identity.sessionId,
      sourceUserSeq: identity.sourceUserSeq,
      turn: identity.turn,
      kind: 'connection_missing',
      text: question,
    });
    commitTurnOutcome({
      version: 2,
      id: turnOutcomeId(identity),
      identity: {
        sessionId: identity.sessionId,
        turn: identity.turn,
        sourceUserSeq: identity.sourceUserSeq,
      },
      status: 'needs_input',
      resumable: true,
      needs: { kind: 'input' },
      presentation: { kind: 'question', text: question },
    });
    return { kind: 'needs_input', text: question };
  } catch {
    return null;
  }
}

export type TypedExecutionHold = NonNullable<ConstructRunResult['hold']>;

export type TypedSourceDispatch =
  | { kind: 'conversation'; capabilityRoute: 'direct_reply' | 'retrieve' | 'act' }
  | { kind: 'typed'; result: ConstructRunResult }
  | { kind: 'blocked'; text: string }
  | { kind: 'needs_input'; text: string }
  | {
      kind: 'held';
      hold: TypedExecutionHold;
    };

function parkClarifyingOpenSlot(
  identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>,
  clarifying: string,
): Extract<TypedSourceDispatch, { kind: 'needs_input' }> {
  parkDependencyRequest({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    turn: identity.turn,
    kind: 'user_input',
    text: clarifying,
  });
  appendEvent({
    sessionId: identity.sessionId,
    turn: identity.turn,
    role: 'system',
    type: 'awaiting_user_input',
    data: { question: clarifying, sourceUserSeq: identity.sourceUserSeq },
  });
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity: {
      sessionId: identity.sessionId,
      turn: identity.turn,
      sourceUserSeq: identity.sourceUserSeq,
    },
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: clarifying },
  });
  return { kind: 'needs_input', text: clarifying };
}

function exactPersistedPresentation(
  identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>,
): PresentationEvent | null {
  const event = listEvents(identity.sessionId, {
    sinceSeq: identity.sourceUserSeq,
    types: ['conversation_completed'],
  }).find((candidate) => (
    candidate.turn === identity.turn
    && candidate.data.sourceUserSeq === identity.sourceUserSeq
  ));
  if (!event) return null;
  const presentation = presentationEventFromCompletionData(event.data);
  if (
    !presentation
    || presentation.identity.sessionId !== identity.sessionId
    || presentation.identity.turn !== identity.turn
    || presentation.identity.sourceUserSeq !== identity.sourceUserSeq
  ) return null;
  return presentation;
}

function safeFallbackOutcome(
  identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>,
  status: Extract<ConstructRunResult['status'], 'blocked' | 'failed' | 'uncertain'>,
): TurnOutcome {
  const owned = {
    sessionId: identity.sessionId,
    turn: identity.turn,
    sourceUserSeq: identity.sourceUserSeq,
  };
  if (status === 'failed') {
    return {
      version: 2,
      id: turnOutcomeId(owned),
      identity: owned,
      status: 'failed',
      resumable: false,
      presentation: { kind: 'error', text: PUBLIC_RUN_FAILURE_TEXT },
    };
  }
  if (status === 'uncertain') {
    return {
      version: 2,
      id: turnOutcomeId(owned),
      identity: owned,
      status: 'uncertain',
      resumable: true,
      presentation: {
        kind: 'blocked',
        text: renderTypedControlState({ status: 'uncertain' }),
      },
    };
  }
  return {
    version: 2,
    id: turnOutcomeId(owned),
    identity: owned,
    status: 'blocked',
    resumable: false,
    presentation: {
      kind: 'blocked',
      text: 'I could not safely complete and verify every required step, so I stopped without reporting the task as done. The technical details are available in the activity log.',
    },
  };
}

function dispatchPersistedRunResult(
  identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>,
  result: ConstructRunResult,
): TypedSourceDispatch {
  let presentation = result.terminal ?? exactPersistedPresentation(identity);
  if (result.status === 'held') {
    // A terminal winner, if one raced this activation, supersedes its local
    // recovery hold. Otherwise there is deliberately no public response yet.
    if (!presentation) {
      return {
        kind: 'held',
        hold: result.hold ?? {
          owner: 'host',
          wake: 'recovery',
          reason: 'recovery_pending',
        },
      };
    }
  } else if (!presentation) {
    // Defense in depth for direct runners and future ordinary stop branches:
    // an admitted non-success cannot escape without an exact public winner.
    if (result.status === 'success') {
      return {
        kind: 'held',
        hold: { owner: 'host', wake: 'recovery', reason: 'recovery_pending' },
      };
    }
    presentation = commitTurnOutcome(safeFallbackOutcome(identity, result.status)).presentation;
  }

  if (!presentation) {
    return {
      kind: 'held',
      hold: { owner: 'host', wake: 'recovery', reason: 'recovery_pending' },
    };
  }
  if (presentation.status === 'done' && presentation.kind === 'answer') {
    const {
      error: _privateError,
      hold: _privateHold,
      ...safeResult
    } = result;
    return {
      kind: 'typed',
      result: {
        ...safeResult,
        status: 'success',
        artifactHandle: presentation.text,
        published: true,
        terminal: presentation,
      },
    };
  }
  if (presentation.status === 'needs_input') {
    return { kind: 'needs_input', text: presentation.text };
  }
  return { kind: 'blocked', text: presentation.text };
}

const SUPPORTED_CONSTRUCTS = new Set([
  'collect_then_construct',
  'single_act',
  'fanout',
  'retrieve',
  'collect',
  'none',
]);

export function typedGraphHasExecutableOperations(graph: {
  nodes: ReadonlyArray<{ operationId?: string; capabilityRole?: string }>;
}): boolean {
  // A role stamp is a sketch. Typed dispatch starts only when a node is bound
  // to an exact operation. Otherwise a participated turn parks or blocks —
  // it does not enter another executor empty-handed.
  return graph.nodes.some((node) => Boolean(node.operationId));
}

export async function dispatchAdmittedSource(
  identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>,
): Promise<TypedSourceDispatch> {
  const disposition = readSemanticDisposition(identity.sessionId, identity.sourceUserSeq);
  const event = getTurnGraphEventForSource(identity.sessionId, identity.sourceUserSeq);
  const graph = turnGraphFromShadowEvent(event);
  if (!disposition || disposition.participation !== 'participated') {
    const route = graph?.classification.route;
    return {
      kind: 'conversation',
      capabilityRoute: route === 'act' || route === 'retrieve' ? route : 'direct_reply',
    };
  }
  const clarifying = clarifyingOpenSlotQuestionForSource(identity.sessionId, identity.sourceUserSeq);
  if (clarifying) return parkClarifyingOpenSlot(identity, clarifying);
  if (!graph) {
    return stopUnboundParticipated(identity, null);
  }
  if (disposition.outcome === 'blocked' || disposition.outcome === 'unavailable') {
    return stopUnboundParticipated(identity, graph);
  }
  if (graph.classification.route === 'direct_reply') {
    return { kind: 'conversation', capabilityRoute: 'direct_reply' };
  }
  if (hostOnlySketchForSource(identity.sessionId, identity.sourceUserSeq)) {
    return { kind: 'conversation', capabilityRoute: 'direct_reply' };
  }
  if (!typedGraphHasExecutableOperations(graph)) {
    // "Unbound work" requires CLAIMED work. An admitted proposal with zero
    // typed operations claimed nothing to bind — the walls below exist for
    // claimed-but-unbindable plans. Zero-op turns run the gated model loop,
    // where every actual call still meets its own effect gate; a write
    // cannot happen ungated there. (Live 2026-08-25: three honest zero-op
    // shapes in a row blocked or parked a fully-specified workflow step.)
    if (admittedProposalClaimsNoTypedWork(identity.sessionId, identity.sourceUserSeq)) {
      const route = graph.classification.route;
      return {
        kind: 'conversation',
        capabilityRoute: route === 'act' || route === 'retrieve' ? route : 'direct_reply',
      };
    }
    return stopUnboundParticipated(identity, graph);
  }
  const construct = graph.classification.goalConstraints?.construct ?? 'none';
  if (!SUPPORTED_CONSTRUCTS.has(construct) && construct !== 'none') {
    return { kind: 'blocked', text: commitUnsupportedTypedExecutionTurn(identity).text };
  }
  const executableCount = graph.nodes.filter((node) => Boolean(node.operationId)
    && (node.kind === 'retrieve' || node.kind === 'execute')).length;
  const sourceDigest = createHash('sha256').update(`${identity.sessionId}:${identity.sourceUserSeq}`).digest('hex');
  const complexity = assessControlComplexity({
    acceptedSourceDigest: sourceDigest,
    goal: {
      construct,
      route: graph.classification.route,
      destinations: graph.classification.goalConstraints?.destinations,
      destination: graph.classification.goalConstraints?.destination,
      collection: graph.classification.goalConstraints?.collection,
    },
    executableNodeCount: executableCount,
  });
  const executionStartedAt = Date.now();
  const result = generalSchedulerForbidden(complexity.mode)
    ? await runDirectNodeInvocation(identity)
    : await runAdmittedSourceGraph(identity);
  // PHASE WALL-CLOCK TRUTH (binding flag 2026-08-19: elapsed time is a
  // user-facing signal — a 21-minute collect-into-sheet run is a defect
  // regardless of outcome). One ledger row per typed run: how long the host
  // admission took, what the model ceremony cost (0 on the fast lane), and
  // how long execution ran. Telemetry only; outside every digest.
  try {
    const record = readClaimLinkedSemanticInterpretation(identity.sessionId, identity.sourceUserSeq)?.record;
    const executionMs = Date.now() - executionStartedAt;
    const hostAdmissionMs = record?.hostAdmissionMs ?? 0;
    const modelCeremonyMs = record?.hostAdmissionMs !== undefined ? 0 : (record?.latencyMs ?? 0);
    appendEvent({
      sessionId: identity.sessionId,
      turn: identity.turn,
      role: 'system',
      type: 'turn_phase_timings',
      data: {
        sourceUserSeq: identity.sourceUserSeq,
        lane: record?.hostAdmissionMs !== undefined ? 'host_compile' : 'model_ceremony',
        hostAdmissionMs,
        modelCeremonyMs,
        executionMs,
        totalMs: hostAdmissionMs + modelCeremonyMs + executionMs,
        runStatus: result.status,
      },
    });
  } catch { /* timing truth must never break a run */ }
  // A successful HOST-COMPILED run is a deterministic workflow by
  // construction — proven capabilities, frozen schemas, digest-bound args,
  // re-provable at dispatch. Record it as a candidate so Clem can SUGGEST
  // saving it; the user owns the workflow designation, never auto-created.
  try {
    const record = readClaimLinkedSemanticInterpretation(identity.sessionId, identity.sourceUserSeq)?.record;
    if (result.status === 'success' && record?.hostCompilerVersion) {
      const raw = record.raw as { goal?: { objective?: string } } | null;
      appendEvent({
        sessionId: identity.sessionId,
        turn: identity.turn,
        role: 'system',
        type: 'workflow_candidate_recorded',
        data: {
          sourceUserSeq: identity.sourceUserSeq,
          objective: raw?.goal?.objective ?? '',
          hostCompilerVersion: record.hostCompilerVersion,
          hostCompileDigest: record.hostCompileDigest ?? null,
          operationIds: (record.groundingVerdicts ?? []).map((verdict) => verdict.operationId),
          capabilityRefs: (record.groundingVerdicts ?? []).map((verdict) => verdict.capabilityRef),
        },
      });
    }
  } catch { /* candidate recording must never break a run */ }
  if (result.status === 'blocked' && result.error === 'durable_graph_authority_mismatch') {
    return { kind: 'blocked', text: commitUnadmittedSemanticTurn(identity).text };
  }
  if (result.status === 'blocked' && result.error === 'unsupported_typed_topology') {
    return { kind: 'blocked', text: commitUnsupportedTypedExecutionTurn(identity).text };
  }
  return dispatchPersistedRunResult(identity, result);
}
