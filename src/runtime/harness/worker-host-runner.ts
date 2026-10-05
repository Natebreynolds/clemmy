import { withAcceptedSourceSessionContext } from './source-session-context.js';
import { qualifyWorkerOutput, workerCallRecord, type WorkerCallRecord } from './worker-call-record.js';
import { expectedWorkPlanLines } from './expected-work-admission.js';
import { loadExpectedWorkContract } from './expected-work-contract.js';
import { parseTaskMode } from './task-mode.js';
import { creditDelegatedExpectedWork, delegableExpectedWorkForItem, delegateExpectedWorkToChild, type DelegableExpectedWork } from './expected-work-delegation.js';
import { discoveryGovernor } from './discovery-governor.js';
import { primePrimaryModelPlanningCatalog, type HostFreshPlanningContextV1 } from '../semantic-boundary/admit-and-compile-accepted-source.js';
/** Worker packets use the same host loop and exact call admission as the
 * parent, in their own existing session/source namespace. No child can mutate
 * the parent's root, model-batch ordinals or logical run_worker settlement. */
import { createHash } from 'node:crypto';
import { Runner, type Agent } from '@openai/agents';
import type { RuntimeContextValue } from '../../types.js';
import type { McpToolScope } from '../mcp-tool-scope.js';
import type { DispatchLeaseRef } from './dispatch-lease.js';
import { buildWorkerJobPrompt, workerPacketKey, workerResultIndicatesFailure, type WorkerToolInput } from '../../agents/worker-job-packet.js';
import { normalizeWorkerOutput } from '../../agents/worker-output.js';
import { prepareWorkerResultShares } from './worker-retained-results.js';
import { resolveLocalRetainedOutputRead } from './retained-output-read.js';
import { acceptedTaskIdFor, currentLogicalCall } from './attempt-identity.js';
import { resolveEffectiveProviderForModel } from './byo-providers.js';
import {
  appendEvent, beginRunAttempt, createSession, finishRunAttempt, getSession, getToolOutput,
  listEvents, recordRunAttemptUserInput,
} from './eventlog.js';
import {
  defaultToolCallsPerTurn, harnessRunContextStorage, ToolCallsCounter, withHarnessRunContext,
} from './brackets.js';
import pino from 'pino';
import { workerComposeOnlyActions } from '../../agents/worker-parent-actions.js';

const workerLogger = pino({ name: 'worker-host-runner' });

export async function runPacketWorkerWithHost(input: {
  buildAgent: (child: { sessionId: string; sourceUserSeq: number; hostFreshPlanning?: HostFreshPlanningContextV1; delegatedExpectedWork?: DelegableExpectedWork }) => Promise<Agent<RuntimeContextValue>>;
  input: WorkerToolInput;
  modelId: string;
  parentSessionId: string;
  sourceUserSeq: number;
  maxTurns: number;
  mcpToolScope: McpToolScope | null;
  dispatchLease?: DispatchLeaseRef;
  signal?: AbortSignal;
  /** Outside actions this worker was refused because only its parent may run them. */
  onParentActions?: (tools: string[]) => void;
  /** The host's record of the calls this worker made, once it has run. */
  onCallRecord?: (record: WorkerCallRecord) => void;
}): Promise<string> {
  const notStarted = (reason: string): string => {
    input.onCallRecord?.({ byTool: {}, businessCallSucceeded: false, businessCallAttempted: false, effectsMayHaveRun: false, successfulRead: false });
    return reason;
  };
  const parent = harnessRunContextStorage.getStore();
  const parentTaskId = acceptedTaskIdFor(input.parentSessionId, input.sourceUserSeq);
  const parentCall = currentLogicalCall();
  const source = listEvents(input.parentSessionId, {
    sinceSeq: input.sourceUserSeq - 1, types: ['user_input_received'], limit: 1,
  }).find((event) => event.seq === input.sourceUserSeq && event.role === 'user');
  if (!source || !parentCall || parentCall.acceptedTaskId !== parentTaskId) {
    return notStarted('ERROR: worker packet has no exact accepted parent call; no worker ran.');
  }
  const inheritedMode = parseTaskMode(source.data.taskMode);
  let retainedResultShares;
  try {
    retainedResultShares = prepareWorkerResultShares(input.parentSessionId, input.input.retainedResultIds ?? [], id => {
      const resolved = resolveLocalRetainedOutputRead(input.parentSessionId, id);
      return resolved.receipt ?? getToolOutput(input.parentSessionId, resolved.callId);
    });
  } catch (error) {
    return notStarted(`ERROR: ${error instanceof Error ? error.message : String(error)} No worker ran.`);
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
    metadata: { source: 'delegated_worker', workerScope: true, ...lineage, retainedResultShares },
  });
  const attempt = beginRunAttempt(session.id);
  const prompt = buildWorkerJobPrompt(input.input);
  // This is delegated packet provenance, not a human approval. External
  // mutations are refused by the same tool edge before any consent card.
  // Execute grants remain parent-owned: children retain the exact parent mode
  // as provenance and receive an explicit investigation ceiling of their own.
  // WORKERS WRITE THEIR ITEM. When the parent's frozen contract delegates
  // this exact item (a per-item requirement whose sealed universe holds it),
  // the child gets its own derived contract below and keeps the parent's
  // execute authority for that one item; the plan ceiling stays for a plan
  // parent and for a child the contract does not name (owner 2026-09-09).
  const delegable = delegableExpectedWorkForItem({
    parentSessionId: input.parentSessionId,
    parentSourceUserSeq: source.seq,
    expectedWork: input.input.expectedWork ?? null,
    item: input.input.item,
  });
  const investigationOnly = inheritedMode?.kind === 'plan'
    || (inheritedMode?.kind === 'execute' && !delegable);
  const childSource = recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', parentEventId: source.id,
    data: {
      text: prompt,
      ...(investigationOnly
        ? { taskMode: { version: 1, kind: 'plan' }, delegatedWorker: { ...lineage, composeOnly: true, packet: input.input, parentTaskMode: inheritedMode, authority: 'investigation_only' } }
        : { delegatedWorker: { ...lineage, composeOnly: true, packet: input.input, ...(inheritedMode ? { parentTaskMode: inheritedMode } : {}), ...(delegable ? { authority: 'delegated_item', delegatedRequirementId: delegable.requirementId } : {}) } }),
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
  let delegation: Awaited<ReturnType<typeof delegateExpectedWorkToChild>> | null = null;
  appendEvent({ sessionId: input.parentSessionId, turn: 0, role: 'system', type: 'worker_started',
    data: { ...lineage, model: input.modelId, provider: resolveEffectiveProviderForModel(input.modelId),
      role: input.input.intent, childSessionId: session.id, childSourceUserSeq: childSource.seq, childAttemptId: attempt.attemptId } });
  let completed = false;
  // Qualify before closing the child attempt so it agrees with the parent
  // receipt/reuse disposition. Preserve the worker's prose as partial evidence.
  const withCallRecord = (reply: string): string => {
    let record: WorkerCallRecord | undefined;
    try {
      record = workerCallRecord(session.id, childSource.seq);
      const contract = loadExpectedWorkContract(session.id, childSource.seq);
      if (delegable || contract.status !== 'missing') {
        // A missing/corrupt child freeze must not erase a known delegated
        // requirement. A valid zero-work contract remains tool-free, so
        // it cannot override failed business-call evidence either.
        if (contract.status !== 'ok') record.requiredWork = 'pending';
        else if (delegable || contract.contract.operations.length > 0) {
          const requirements = expectedWorkPlanLines({ sessionId: session.id, sourceUserSeq: childSource.seq });
          record.requiredWork = requirements.length > 0
            && requirements.length === contract.contract.operations.length
            && requirements.every((line) => line.state === 'satisfied') ? 'satisfied' : 'pending';
        }
      }
    } catch { record = undefined; /* missing evidence cannot certify completion */ }
    try { if (record) input.onCallRecord?.(record); } catch { /* evidence delivery cannot promote completion */ }
    const qualified = qualifyWorkerOutput(reply, record);
    completed = !workerResultIndicatesFailure(qualified);
    return qualified;
  };
  try {
    return await withAcceptedSourceSessionContext({ sessionId: session.id, sourceUserSeq: childSource.seq }, () => withHarnessRunContext({
      // The child's own accepted turn: plan_task (a delegated child plans its
      // item itself) requires the exact turn in the run context.
      sessionId: session.id, sourceUserSeq: childSource.seq, turn: 1, runAttemptId: attempt.attemptId,
      counter: new ToolCallsCounter(Math.max(defaultToolCallsPerTurn(), input.maxTurns * 4)),
      workerScope: true, mcpToolScope: input.mcpToolScope,
      guardrailScopeId: `${session.id}::worker`, behaviorScopeId: `${session.id}::turn:1`,
      ...(input.dispatchLease ?? parent?.dispatchLease ? { dispatchLease: input.dispatchLease ?? parent!.dispatchLease } : {}),
    }, async () => {
      // The child primes its own planning catalog so its tool_search can stage
      // provider candidates and disclose executable refs — the parent's door.
      let hostFreshPlanning: HostFreshPlanningContextV1 | undefined;
      try {
        const primed = await primePrimaryModelPlanningCatalog({ sessionId: session.id, sourceUserSeq: childSource.seq });
        if (primed.ok) hostFreshPlanning = primed.planning;
        else workerLogger.warn({ reason: primed.reason, childId: session.id }, 'worker planning catalog did not prime — provider discovery will be unavailable to this worker');
      } catch (err) {
        workerLogger.warn({ err, childId: session.id }, 'worker planning catalog priming threw');
      }
      // The child's surface is built for the delegated item (work_call carrier)
      // from the parent's PROVEN contract; the derived contract itself is
      // frozen once the host has armed the child's source (onHostArmed below),
      // because the host records the child's graph when it arms and refuses a
      // graph that exists before it (preaccepted_graph_execution_owner).
      const agent = await input.buildAgent({ sessionId: session.id, sourceUserSeq: childSource.seq, ...(hostFreshPlanning ? { hostFreshPlanning } : {}), ...(delegable ? { delegatedExpectedWork: delegable } : {}) });
      const onHostArmed = delegable
        ? async () => {
            // The host re-arms its surface on every model step; delegate once.
            if (delegation) return;
            delegation = await delegateExpectedWorkToChild({
              parentSessionId: input.parentSessionId, parentSourceUserSeq: source.seq,
              childSessionId: session.id, childSourceUserSeq: childSource.seq, childTurn: 1,
              item: input.input.item, delegable,
              resolvedTools: String(input.input.resolvedTools ?? '').split(/[,\s]+/).map((name) => name.trim()).filter(Boolean),
              ...(hostFreshPlanning ? { planning: hostFreshPlanning } : {}),
            });
            if (delegation.status !== 'delegated') {
              workerLogger.warn({ childId: session.id, item: input.input.item, reason: delegation.reason }, 'expected-work delegation refused — the child\'s work_call will refuse without a contract');
              appendEvent({ sessionId: input.parentSessionId, turn: 0, role: 'system', type: 'expected_work_delegation_refused',
                data: { sourceUserSeq: source.seq, childSessionId: session.id, universeItemId: input.input.item, requirementId: delegable.requirementId, reason: delegation.reason } });
            }
          }
        : undefined;
      const { hostRunRunner, HostRecoveryState } = await import('./host-turn-runner.js');
      // A PROVEN WRITE IS CREDITED EVEN WHEN THE CHILD DIES AFTER IT.
      // The child can settle its item and then trip its tool ceiling, be
      // killed, or abort; hostRunRunner throws and the normal-return path
      // never runs. Crediting only on clean return lost the completion and the
      // parent re-dispatched the item, writing it twice (review 2026-09-09).
      // The credit reads the child's OWN discharged binding, so it stays a
      // proof, not an assumption — and it can never mask the child's error.
      const creditDelegatedItem = (): void => {
        if (delegation?.status !== 'delegated') return;
        try {
          const credit = creditDelegatedExpectedWork({
            parentSessionId: input.parentSessionId, parentSourceUserSeq: source.seq,
            childSessionId: session.id, childSourceUserSeq: childSource.seq,
            requirementId: delegation.requirementId, item: delegation.item, effect: delegable?.effect,
          });
          workerLogger.info({ childId: session.id, item: input.input.item, credit: credit.status }, 'delegated expected-work credit');
        } catch (error) {
          workerLogger.warn({ err: error, childId: session.id, item: input.input.item }, 'delegated expected-work credit threw');
        }
      };
      let outcome;
      try {
        const runner = new Runner({ groupId: input.parentSessionId });
        const options = {
          maxTurns: input.maxTurns, hostTurnEngine: 'host_v1',
          context: { sessionId: session.id, sourceUserSeq: childSource.seq, turn: 1 },
          ...(input.signal ? { signal: input.signal } : {}),
          ...(onHostArmed ? { onHostArmed } : {}),
        };
        outcome = await hostRunRunner(runner as never,
          agent, [{ type: 'message', role: 'user', content: prompt }] as never, options as never);
        const resumed = new Set<string>();
        // Recovery is an unfinished child, not its answer. Re-enter the exact
        // checkpoint: it carries the step index, no-progress budget and balanced
        // tool history, so already-settled commands are not dispatched again.
        // Bound store-recovery churn as well as the host's cumulative turn cap.
        while (outcome.hold && outcome.serializedRecoveryState) {
          const blob = outcome.serializedRecoveryState;
          const digest = createHash('sha256').update(blob).digest('hex');
          if (resumed.has(digest) || resumed.size >= input.maxTurns * 2 + 2) break;
          if (input.signal?.aborted) break;
          resumed.add(digest);
          const recovery = HostRecoveryState.fromString(blob);
          outcome = await hostRunRunner(runner as never, agent, recovery as never, options as never);
        }
      } finally {
        creditDelegatedItem();
      }
      // Attribution is the EXECUTED route, never the plan: a rate-limit fallover
      // (`turn_model_routed` routeKind harness_fallover in the CHILD session) can
      // move this worker to another family. Live 2026-09-05: Codex quota at
      // 100%, all sixteen worker turns ran on Claude, and every worker label
      // still said codex. The parent's `worker_result` reads this event.
      try {
        // THIS attempt only: the child session id is deterministic per lineage,
        // so a replayed dispatch reuses it and an earlier attempt's fallover
        // must not label this run.
        const responses = listEvents(session.id, { types: ['worker_model_response_completed'], sinceSeq: childSource.seq - 1 })
          .filter(event => event.data.sourceUserSeq === childSource.seq && event.data.runAttemptId === attempt.attemptId);
        const last = responses.at(-1)?.data;
        if (typeof last?.model === 'string' && last.model && typeof last.provider === 'string' && last.provider !== 'unknown') {
          appendEvent({ sessionId: input.parentSessionId, turn: 0, role: 'system', type: 'worker_model_executed', data: {
            ...lineage, executed: true, childSessionId: session.id,
            childSourceUserSeq: childSource.seq, childAttemptId: attempt.attemptId,
            evidenceKind: 'completed_model_response', modelCallId: last.modelCallId,
            plannedModel: input.modelId, plannedProvider: resolveEffectiveProviderForModel(input.modelId),
            model: last.model, effectiveModel: last.model, provider: last.provider,
            fallover: responses.some(event => event.data.fallover === true),
          } });
        }
      } catch { /* attribution is best-effort telemetry, never a result */ }
      if (outcome.hold || outcome.hasInterruptions || outcome.terminal) {
        return withCallRecord(`ERROR: worker ${input.input.item}: ${outcome.terminal?.reason ?? outcome.hold?.reason ?? 'worker_requires_parent_action'}. ${String(outcome.finalOutput ?? '')}`);
      }
      const text = normalizeWorkerOutput(outcome.finalOutput);
      input.onParentActions?.(workerComposeOnlyActions({ sessionId: session.id, sinceSeq: childSource.seq }));
      return withCallRecord(text);
    }), { newlyAccepted: true });
  } catch (error) {
    // A child failure is an item result, never an exception that can poison
    // the parent's still-open coordinator call or force checkpoint re-entry.
    return withCallRecord(`ERROR: worker ${input.input.item}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    finishRunAttempt(attempt, completed ? 'completed' : 'failed');
  }
}
