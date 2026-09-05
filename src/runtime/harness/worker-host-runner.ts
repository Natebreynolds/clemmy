/** Worker packets use the same host loop and exact call admission as the
 * parent, in their own existing session/source namespace. No child can mutate
 * the parent's root, model-batch ordinals or logical run_worker settlement. */
import { createHash } from 'node:crypto';
import { Runner, type Agent } from '@openai/agents';
import type { RuntimeContextValue } from '../../types.js';
import type { McpToolScope } from '../mcp-tool-scope.js';
import type { DispatchLeaseRef } from './dispatch-lease.js';
import { buildWorkerJobPrompt, workerPacketKey, type WorkerToolInput } from '../../agents/worker-job-packet.js';
import { normalizeWorkerOutput } from '../../agents/worker-output.js';
import { acceptedTaskIdFor, currentLogicalCall } from './attempt-identity.js';
import { resolveEffectiveProviderForModel } from './byo-providers.js';
import {
  appendEvent, beginRunAttempt, createSession, finishRunAttempt, getSession,
  listEvents, recordRunAttemptUserInput,
} from './eventlog.js';
import {
  defaultToolCallsPerTurn, harnessRunContextStorage, ToolCallsCounter, withHarnessRunContext,
} from './brackets.js';

export async function runPacketWorkerWithHost(input: {
  buildAgent: (child: { sessionId: string; sourceUserSeq: number }) => Promise<Agent<RuntimeContextValue>>;
  input: WorkerToolInput;
  modelId: string;
  parentSessionId: string;
  sourceUserSeq: number;
  maxTurns: number;
  mcpToolScope: McpToolScope | null;
  dispatchLease?: DispatchLeaseRef;
  signal?: AbortSignal;
}): Promise<string> {
  const parent = harnessRunContextStorage.getStore();
  const parentTaskId = acceptedTaskIdFor(input.parentSessionId, input.sourceUserSeq);
  const parentCall = currentLogicalCall();
  const source = listEvents(input.parentSessionId, {
    sinceSeq: input.sourceUserSeq - 1, types: ['user_input_received'], limit: 1,
  }).find((event) => event.seq === input.sourceUserSeq && event.role === 'user');
  if (!source || !parentCall || parentCall.acceptedTaskId !== parentTaskId) {
    return 'ERROR: worker packet has no exact accepted parent call; no worker ran.';
  }
  const packetKey = workerPacketKey(input.input);
  const packetDigest = createHash('sha256').update(JSON.stringify(input.input)).digest('hex');
  const lineage = {
    parentSessionId: input.parentSessionId, parentSourceUserSeq: source.seq,
    parentAcceptedTaskId: parentTaskId, parentLogicalCallId: parentCall.logicalToolCallId,
    packetKey, packetDigest, item: input.input.item,
  };
  const childId = `sess-worker-${createHash('sha256').update(JSON.stringify(lineage)).digest('hex').slice(0, 40)}`;
  const session = getSession(childId) ?? createSession({
    id: childId, kind: 'agent', title: `Worker: ${input.input.item}`,
    metadata: { source: 'delegated_worker', workerScope: true, ...lineage },
  });
  const attempt = beginRunAttempt(session.id);
  const prompt = buildWorkerJobPrompt(input.input);
  // This is delegated packet provenance, not a human approval. External
  // mutations are refused by the same tool edge before any consent card.
  const childSource = recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', parentEventId: source.id,
    data: { text: prompt, delegatedWorker: { ...lineage, composeOnly: true, packet: input.input } },
  });
  appendEvent({ sessionId: input.parentSessionId, turn: 0, role: 'system', type: 'worker_started',
    data: { ...lineage, model: input.modelId, provider: resolveEffectiveProviderForModel(input.modelId),
      role: input.input.intent, childSessionId: session.id, childSourceUserSeq: childSource.seq, childAttemptId: attempt.attemptId } });
  let completed = false;
  try {
    return await withHarnessRunContext({
      sessionId: session.id, sourceUserSeq: childSource.seq, runAttemptId: attempt.attemptId,
      counter: new ToolCallsCounter(Math.max(defaultToolCallsPerTurn(), input.maxTurns * 4)),
      workerScope: true, mcpToolScope: input.mcpToolScope,
      guardrailScopeId: `${session.id}::worker`, behaviorScopeId: `${session.id}::turn:1`,
      ...(input.dispatchLease ?? parent?.dispatchLease ? { dispatchLease: input.dispatchLease ?? parent!.dispatchLease } : {}),
    }, async () => {
      const agent = await input.buildAgent({ sessionId: session.id, sourceUserSeq: childSource.seq });
      const { hostRunRunner } = await import('./host-turn-runner.js');
      const outcome = await hostRunRunner(new Runner({ groupId: input.parentSessionId }) as never,
        agent, [{ type: 'message', role: 'user', content: prompt }] as never, {
          maxTurns: input.maxTurns, hostTurnEngine: 'host_v1',
          context: { sessionId: session.id, sourceUserSeq: childSource.seq, turn: 1 },
          ...(input.signal ? { signal: input.signal } : {}),
        } as never);
      if (outcome.hasInterruptions || outcome.terminal?.status === 'blocked') {
        return `ERROR: worker ${input.input.item}: ${outcome.terminal?.reason ?? 'worker_requires_parent_action'}. ${String(outcome.finalOutput ?? '')}`;
      }
      const text = normalizeWorkerOutput(outcome);
      completed = !/^\s*(?:ERROR|PARTIAL):/i.test(text);
      return text;
    });
  } catch (error) {
    // A child failure is an item result, never an exception that can poison
    // the parent's still-open coordinator call or force checkpoint re-entry.
    return `ERROR: worker ${input.input.item}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    finishRunAttempt(attempt, completed ? 'completed' : 'failed');
  }
}
