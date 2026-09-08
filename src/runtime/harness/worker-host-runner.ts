import { parseTaskMode } from './task-mode.js';
import { discoveryGovernor } from './discovery-governor.js';
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
  const inheritedMode = parseTaskMode(source.data.taskMode);
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
  // Execute grants remain parent-owned: children retain the exact parent mode
  // as provenance and receive an explicit investigation ceiling of their own.
  const childSource = recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', parentEventId: source.id,
    data: {
      text: prompt,
      ...(inheritedMode?.kind === 'plan' || inheritedMode?.kind === 'execute'
        ? { taskMode: { version: 1, kind: 'plan' }, delegatedWorker: { ...lineage, composeOnly: true, packet: input.input, parentTaskMode: inheritedMode, authority: 'investigation_only' } }
        : { delegatedWorker: { ...lineage, composeOnly: true, packet: input.input } }),
    },
  });
  // A worker is an accepted task of its own. Without this baseline discovery
  // policy its tool_search is denied (task_not_initialized) and its reads are
  // refused as unproven — live 2026-09-08: an inbox triage delegated to two
  // mailbox workers came back 0/2 with nothing done. Same door the parent
  // turn walks through; the live boundary still fails closed on misuse.
  try {
    discoveryGovernor.initializeTask({
      claimKeyVersion: 'exact_request_v1',
      sessionId: session.id,
      sourceUserSeq: childSource.seq,
      knownCapability: false,
    });
  } catch { /* the live boundary fails closed if discovery is attempted anyway */ }
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
      // Attribution is the EXECUTED route, never the plan: a rate-limit fallover
      // (`turn_model_routed` routeKind harness_fallover in the CHILD session) can
      // move this worker to another family. Live 2026-09-05: Codex quota at
      // 100%, all sixteen worker turns ran on Claude, and every worker label
      // still said codex. The parent's `worker_result` reads this event.
      try {
        // THIS attempt only: the child session id is deterministic per lineage,
        // so a replayed dispatch reuses it and an earlier attempt's fallover
        // must not label this run.
        const routed = listEvents(session.id, { types: ['turn_model_routed'], sinceSeq: childSource.seq - 1 });
        const last = routed.length ? routed[routed.length - 1]!.data as { model?: unknown; provider?: unknown; routeKind?: unknown; fallover?: unknown } : undefined;
        const executedModel = typeof last?.model === 'string' && last.model ? last.model : input.modelId;
        const executedProvider = typeof last?.provider === 'string' && last.provider
          ? last.provider
          : resolveEffectiveProviderForModel(executedModel);
        appendEvent({ sessionId: input.parentSessionId, turn: 0, role: 'system', type: 'worker_model_executed', data: {
          ...lineage, executed: true, childSessionId: session.id,
          plannedModel: input.modelId, plannedProvider: resolveEffectiveProviderForModel(input.modelId),
          model: executedModel, effectiveModel: executedModel, provider: executedProvider,
          fallover: last?.fallover === true || last?.routeKind === 'harness_fallover',
        } });
      } catch { /* attribution is best-effort telemetry, never a result */ }
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
