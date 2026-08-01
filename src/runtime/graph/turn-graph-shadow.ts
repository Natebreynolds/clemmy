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
import {
  compileTurnGraph,
  snapshotTurnGraphPolicy,
} from './turn-graph-compiler.js';
import type {
  TurnGraphPolicySnapshot,
  TurnGraphSurface,
} from './turn-graph-ir.js';

export interface RecordTurnGraphShadowInput {
  identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>;
  surface?: TurnGraphSurface;
  allowedToolNames?: readonly string[];
  excludedToolNames?: readonly string[];
  /** Injection seam for callers/tests that already captured the policy. */
  policy?: TurnGraphPolicySnapshot | ProactivityPolicySnapshot;
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

function isGraphPolicy(value: RecordTurnGraphShadowInput['policy']): value is TurnGraphPolicySnapshot {
  return Boolean(value && 'version' in value && value.version === 'turn-policy-v1');
}

/**
 * Compile and persist the observational graph for one exact accepted chat turn.
 *
 * This function is intentionally fail-open. It never changes routing, prompts,
 * tools, approvals, execution, or the public terminal, and any compiler/DB
 * failure is swallowed so the v3.6 path remains byte-for-byte authoritative.
 */
export function recordTurnGraphShadow(input: RecordTurnGraphShadowInput): EventRow | null {
  try {
    const session = getSession(input.identity.sessionId);
    if (!session || session.kind !== 'chat') return null;
    const source = acceptedSource(input.identity);
    if (!source || source.turn !== input.identity.turn) return null;
    const graphId = `turn-graph:v1:${input.identity.sourceUserSeq}`;
    const prior = getTurnGraphEventForSource(
      input.identity.sessionId,
      input.identity.sourceUserSeq,
    );
    if (prior) {
      return prior.turn === source.turn
        && prior.parentEventId === source.id
        && prior.data.graphId === graphId
        ? prior
        : null;
    }

    const text = acceptedText(source);
    const policy = isGraphPolicy(input.policy)
      ? input.policy
      : snapshotTurnGraphPolicy(input.policy ?? getProactivityPolicySnapshot());
    const startedAt = performance.now();
    const compiled = compileTurnGraph({
      identity: input.identity,
      input: text,
      sessionKind: session.kind,
      surface: input.surface ?? 'direct',
      policy,
      allowedToolNames: input.allowedToolNames,
      excludedToolNames: input.excludedToolNames,
    });
    if (!compiled.validation.ok) return null;
    const compileMs = Number((performance.now() - startedAt).toFixed(3));
    const graph = compiled.graph;
    const authorityRequirements = [...new Set(graph.nodes
      .map((node) => node.authority.requirement)
      .filter((requirement) => requirement !== 'none'))].sort();
    const capabilityKinds = [...new Set(graph.nodes
      .flatMap((node) => node.capabilities.map((capability) => capability.kind)))].sort();

    return appendTurnGraphEventOnce({
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
        graph,
      },
    }).event;
  } catch {
    return null;
  }
}
