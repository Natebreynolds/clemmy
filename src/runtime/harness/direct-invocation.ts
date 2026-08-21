/**
 * Direct runner: one fully bound NodeInvocationPlan, no graph scheduler.
 * Shares reservation / dispatch / settlement / Outcome with every other mode.
 */
import { turnGraphFromShadowEvent } from '../graph/turn-graph-shadow.js';
import { bindAdmittedNodeCapability } from './graph-node-capability.js';
import { getTurnGraphEventForSource, listEvents } from './eventlog.js';
import { commitTurnOutcome } from './delivery-committer.js';
import { turnOutcomeId, type TurnIdentity } from './turn-outcome.js';
import { resolveRuntimeCapabilityCatalog } from './host-capability-catalog-factory.js';
import { parkDependencyRequest } from './dependency-request.js';
import type { ConstructRunResult } from './admitted-construct-run.js';

export async function runDirectNodeInvocation(identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>): Promise<ConstructRunResult> {
  const empty = (error: string): ConstructRunResult => ({
    status: 'blocked',
    providerCalls: { sourceRead: 0, collectionRead: 0, transform: 0, create: 0, readback: 0 },
    handles: {},
    error,
  });
  const event = getTurnGraphEventForSource(identity.sessionId, identity.sourceUserSeq);
  const graph = turnGraphFromShadowEvent(event);
  if (!graph) return empty('direct_invocation: no admitted graph');
  const work = graph.nodes.filter((node) => (
    (node.kind === 'retrieve' || node.kind === 'execute')
    && Boolean(node.operationId || node.capabilityRole)
  ));
  if (work.length !== 1) {
    return empty(`direct_invocation: expected one executable node, found ${work.length}`);
  }
  const node = work[0]!;
  const catalog = resolveRuntimeCapabilityCatalog();
  const acceptedText = String(listEvents(identity.sessionId, { types: ['user_input_received'] })
    .find((row) => row.seq === identity.sourceUserSeq)?.data.text ?? '');
  const bound = bindAdmittedNodeCapability({
    node,
    graph,
    acceptedText,
    catalog,
  });
  if (!bound.ok) {
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
    return { ...empty(parked.text), status: 'blocked', error: parked.text };
  }
  const value = await bound.binding.invoke({
    nodeId: node.id,
    role: node.capabilityRole ?? 'lookup',
    payload: acceptedText,
    identity: { sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq, acceptedTaskId: '' },
    binding: bound.binding,
  });
  const text = typeof value === 'string'
    ? value
    : (value && typeof value === 'object' && typeof (value as { handle?: string }).handle === 'string'
      ? String((value as { handle: string }).handle)
      : JSON.stringify(value ?? ''));
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity: {
      sessionId: identity.sessionId,
      turn: identity.turn,
      sourceUserSeq: identity.sourceUserSeq,
    },
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text: text.trim() || 'Read completed.' },
  });
  return {
    status: 'success',
    providerCalls: { sourceRead: 1, collectionRead: 0, transform: 0, create: 0, readback: 0 },
    handles: { [node.id]: text },
    published: true,
    artifactHandle: text,
  };
}
