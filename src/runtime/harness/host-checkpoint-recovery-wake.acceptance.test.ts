/**
 * Release pins for private host checkpoint recovery.
 *
 * These tests deliberately enter through the production host_v1/runTurn and
 * runConversation seams. A local checkpoint-store failure is never a user
 * decision, and a Clementine-owned writer is ordinary host work rather than a
 * provider mutation.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-recovery-wake-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-host-recovery-wake\n', 'utf8');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const envelopes = await import('../../agents/capability-envelope.js');
const { HostRecoveryState } = await import('./host-turn-runner.js');
const { runConversation, runTurn } = await import('./loop.js');
const { HarnessSession } = await import('./session.js');
const restartRecovery = await import('./restart-recovery.js');
const { getLocalRuntimeTools } = await import('../../tools/local-runtime-tools.js');
const focusMemory = await import('../../memory/focus.js');
const memoryDatabase = await import('../../memory/db.js');

test.after(() => {
  eventlog.closeEventLog();
  memoryDatabase.closeMemoryDb();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const textMessage = (text: string) => ({
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text }],
});

const functionCall = (callId: string, name: string, args: Record<string, unknown>) => ({
  type: 'function_call',
  callId,
  name,
  arguments: JSON.stringify(args),
});

async function* testModelStream(
  this: { getResponse: (request: unknown) => Promise<{
    usage?: Record<string, unknown>;
    output?: unknown[];
    responseId?: string;
  }> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const output = response.output ?? [];
  yield { type: 'response_started' } as never;
  yield {
    type: 'model',
    event: {
      type: 'finish',
      finishReason: output.some((item) => (
        (item as { type?: unknown }).type === 'function_call'
      )) ? 'tool_calls' : 'stop',
    },
  } as never;
  yield {
    type: 'response_done',
    response: {
      id: response.responseId ?? 'host-recovery-test-response',
      usage: {
        inputTokens: Number(response.usage?.inputTokens ?? 0),
        outputTokens: Number(response.usage?.outputTokens ?? 0),
        totalTokens: Number(response.usage?.totalTokens ?? 0),
      },
      output,
    },
  } as never;
}

function recordingModel(responses: readonly (readonly unknown[])[]) {
  let callCount = 0;
  const requests: unknown[] = [];
  return {
    calls: () => callCount,
    requests,
    async getResponse(request: unknown) {
      requests.push(request);
      const output = responses[Math.min(callCount, responses.length - 1)] ?? [];
      callCount += 1;
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [...output],
        responseId: `host-recovery-response-${callCount}`,
      };
    },
    getStreamedResponse: testModelStream,
  };
}

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('legacy Runner.run must not own a host_v1 acceptance');
  };
  return runner;
}

function bindSurface(
  sessionId: string,
  agent: object,
  tools: Array<{ name?: unknown; description?: unknown; parameters?: unknown }>,
): void {
  const sealed = envelopes.sealAgentCapabilityUniverse({
    sessionId,
    universeTools: tools,
    activeToolNames: tools.flatMap((entry) => (
      typeof entry.name === 'string' ? [entry.name] : []
    )),
    policyHash: 'host-checkpoint-recovery-wake-v1',
    budget: {
      maxUncachedTokens: 1_000,
      maxModelCalls: 8,
      maxToolCalls: 8,
      maxElapsedMs: 20_000,
    },
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  if (!sealed.ok) throw new Error(sealed.errors.join('; '));
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
}

function functionResultCount(request: unknown, callId: string): number {
  const input = (request as { input?: unknown } | null)?.input;
  if (!Array.isArray(input)) return 0;
  return input.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    const row = item as { type?: unknown; callId?: unknown; call_id?: unknown };
    return row.type === 'function_call_result'
      && (row.callId === callId || row.call_id === callId);
  }).length;
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

test('the in-process recovery timer privately finalizes, adopts, and continues a post-body hold', async () => {
  const session = eventlog.createSession({
    id: 'host-checkpoint-timer-recovery',
    kind: 'chat',
  });
  const callId = 'timer-local-read';
  let bodies = 0;
  const configuredTool = brackets.wrapToolForHarness({
    type: 'function',
    name: 'task_list',
    description: 'Return one exact local task record.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    needsApproval: async () => false,
    invoke: async () => {
      bodies += 1;
      return { records: [{ id: 'task-1', title: 'Wake exact checkpoint recovery' }] };
    },
  });
  const finalReply = 'I found the task and finished the local recovery normally.';
  const model = recordingModel([
    [functionCall(callId, 'task_list', {})],
    [textMessage(JSON.stringify({
      summary: finalReply,
      reply: finalReply,
      done: true,
      nextAction: 'completed',
      reason: null,
    }))],
  ]);
  const agent = { model, instructions: 'Use the exact configured tool.', tools: [configuredTool] };
  bindSurface(session.id, agent, [configuredTool]);

  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TEMP TRIGGER reject_timer_projection_receipt
    BEFORE INSERT ON logical_model_result_projection_receipts
    WHEN NEW.session_id = '${session.id}' AND NEW.call_id = '${callId}'
    BEGIN
      SELECT RAISE(ABORT, 'fixture timer projection receipt unavailable');
    END
  `);
  let held: Awaited<ReturnType<typeof runConversation>>;
  try {
    held = await runConversation({
      sessionId: session.id,
      input: 'List the one exact local task and report it back.',
      turnEngine: 'host_v1',
      judgeCompletion: false,
      agent: agent as never,
      makeRunner: () => throwingRunner() as never,
      maxTurns: 4,
      maxSteps: 2,
      suppressMemoryCapture: true,
    });
  } finally {
    // The first host attempt and its immediate exact retry both see the
    // failure. The scheduled owner runs only after runConversation returns.
    db.exec('DROP TRIGGER IF EXISTS reject_timer_projection_receipt');
  }

  assert.equal(held.status, 'held', JSON.stringify(held));
  assert.deepEqual(held.hold, {
    owner: 'host',
    wake: 'recovery',
    reason: 'recovery_pending',
  });
  assert.equal(bodies, 1);
  assert.equal(model.calls(), 1);
  const initiallySaved = HarnessSession.load(session.id)?.loadRecoveryState();
  assert.ok(initiallySaved);
  assert.equal(HostRecoveryState.fromString(initiallySaved!).phase, 'finalize');
  assert.equal(eventlog.listEvents(session.id, {
    types: ['conversation_completed', 'awaiting_user_input', 'approval_requested'],
  }).length, 0, 'the private hold emits no terminal, question, or approval card');

  await waitFor(
    () => HarnessSession.load(session.id)?.loadRecoveryState() === null
      && eventlog.listEvents(session.id, { types: ['conversation_completed'] }).length === 1,
    'the scheduled finalize/continue owner to publish the ordinary answer',
  );

  assert.equal(bodies, 1, 'timer recovery never re-enters the settled body');
  assert.equal(model.calls(), 2, 'only one ordinary post-checkpoint model continuation runs');
  assert.equal(functionResultCount(model.requests[1], callId), 1,
    'the continuation sees the exact settled result once');
  assert.deepEqual(db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_call_settlements
        WHERE session_id = ? AND logical_tool_call_id = ?) AS settlements,
      (SELECT COUNT(*) FROM logical_model_result_projection_receipts
        WHERE session_id = ? AND call_id = ?) AS receipts,
      (SELECT COUNT(*) FROM accepted_model_batch_checkpoints
        WHERE session_id = ? AND disposition = 'ready') AS checkpoints,
      (SELECT COUNT(*) FROM pending_approvals
        WHERE session_id = ?) AS approvals
  `).get(
    session.id,
    callId,
    session.id,
    callId,
    session.id,
    session.id,
  ), { settlements: 1, receipts: 1, checkpoints: 1, approvals: 0 });
  const terminals = eventlog.listEvents(session.id, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.data.reply, finalReply);
  assert.doesNotMatch(JSON.stringify(terminals),
    /durable tool-result checkpoint|checkpoint could not be verified|recorded call state|reconcil/i);
  assert.equal(eventlog.listEvents(session.id, {
    types: ['awaiting_user_input', 'approval_requested', 'approval_required', 'request_approval'],
  }).length, 0);
});

test('a real focus_set stays host-only through production host_v1 and reaches the next model once', async () => {
  const session = eventlog.createSession({
    id: 'host-only-focus-set-lifecycle',
    kind: 'chat',
  });
  const sourceText = 'Pin the release recovery audit as our current working focus.';
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: sourceText },
  });
  const rawFocus = getLocalRuntimeTools().find((candidate) => candidate.name === 'focus_set');
  assert.ok(rawFocus, 'the production local runtime must expose focus_set');
  const focusTool = brackets.wrapToolForHarness(rawFocus!);
  const callId = 'host-only-focus-set';
  const model = recordingModel([
    [functionCall(callId, 'focus_set', {
      resource_ref: 'project:release-recovery-audit',
      title: 'Release recovery audit',
      summary: 'Verify private checkpoint recovery across Clementine tools.',
      resource_kind: 'project',
    })],
    [textMessage('Pinned the release recovery audit as our current focus.')],
  ]);
  const agent = { model, instructions: 'Use the exact configured tool.', tools: [focusTool] };
  bindSurface(session.id, agent, [focusTool]);

  const outcome = await runTurn({
    sessionId: session.id,
    input: sourceText,
    sourceUserSeq: source.seq,
    reuseRecordedUserInput: true,
    suppressMemoryCapture: true,
    turnEngine: 'host_v1',
    agent: agent as never,
    makeRunner: () => throwingRunner() as never,
    maxTurns: 4,
  });

  assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
  assert.equal(outcome.finalOutput, 'Pinned the release recovery audit as our current focus.');
  assert.equal(model.calls(), 2);
  assert.equal(functionResultCount(model.requests[1], callId), 1,
    'the exact host-only result appears once in the next model request');
  const focus = focusMemory.getFocusSnapshot();
  assert.equal(focus.active?.resource_ref, 'project:release-recovery-audit');
  assert.equal(focus.active?.related_session_id, session.id,
    'the real handler binds its durable write to the ambient chat session');
  assert.equal(focus.parked.length, 0,
    'one body created one focus; a duplicate body would have parked its first row');

  const db = eventlog.openEventLog();
  assert.deepEqual(db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_call_settlements
        WHERE session_id = ? AND source_user_seq = ?
          AND logical_tool_call_id = ? AND outcome_kind = 'succeeded') AS settlements,
      (SELECT COUNT(*) FROM logical_model_result_projection_receipts
        WHERE session_id = ? AND source_user_seq = ? AND call_id = ?) AS receipts,
      (SELECT COUNT(*) FROM accepted_model_batch_checkpoints
        WHERE session_id = ? AND source_user_seq = ?
          AND disposition = 'ready') AS checkpoints,
      (SELECT COUNT(*) FROM pending_approvals
        WHERE session_id = ?) AS approvals,
      (SELECT COUNT(*) FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ?
          AND execution_site = 'provider') AS provider_dispatches
  `).get(
    session.id,
    source.seq,
    callId,
    session.id,
    source.seq,
    callId,
    session.id,
    source.seq,
    session.id,
    session.id,
    source.seq,
  ), {
    settlements: 1,
    receipts: 1,
    checkpoints: 1,
    approvals: 0,
    provider_dispatches: 0,
  });
  assert.deepEqual(db.prepare(`
    SELECT binding_kind, effect, account_id, manifest_id
      FROM host_call_capability_bindings
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).all(session.id, source.seq, callId), [{
    binding_kind: 'local_envelope',
    effect: 'host_only',
    account_id: '',
    manifest_id: '',
  }]);
  assert.equal(eventlog.listEvents(session.id, {
    types: ['external_write', 'awaiting_user_input', 'approval_requested', 'approval_required'],
  }).length, 0, 'the Clem-owned write opens no provider or user-consent lane');
});

test('boot recovery dispatches an exact saved checkpoint owner even after an earlier external write landed', async () => {
  const session = eventlog.createSession({
    id: 'host-checkpoint-boot-after-external-write',
    kind: 'chat',
    channel: 'discord',
  });
  const sourceText = 'Use the result already owned by this accepted request and finish normally.';
  const attempt = eventlog.beginRunAttempt(session.id, {
    runId: 'host-checkpoint-boot-after-external-write-run',
  });
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: sourceText },
  }, { armRunInFlight: true });
  assert.ok(HarnessSession.load(session.id)?.runInFlightSince());

  // This is the restart policy's durable landed-write oracle. The full
  // provider/physical-row/body fixture lives in the provider-neutral journey;
  // here the earlier write is intentionally a distinct, already-landed call in
  // the same accepted source. Recovery owns only the later local result, so it
  // must not replay either body merely because generic restart policy observes
  // write risk elsewhere in the interrupted window.
  let externalBodies = 0;
  const landEarlierExternalWrite = (): void => {
    externalBodies += 1;
    eventlog.appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'system',
      type: 'external_write_succeeded',
      data: {
        tool: 'composio_execute_tool',
        callId: 'already-landed-provider-write',
        canonicalCallId: 'already-landed-provider-write',
        sourceUserSeq: source.seq,
      },
    });
  };
  landEarlierExternalWrite();

  const callId = 'post-write-local-result';
  let localBodies = 0;
  const configuredTool = brackets.wrapToolForHarness({
    type: 'function',
    name: 'task_list',
    description: 'Return the exact post-write local result.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    needsApproval: async () => false,
    invoke: async () => {
      localBodies += 1;
      return { records: [{ id: 'post-write', status: 'ready' }] };
    },
  });
  const finalReply = 'The already-owned result is ready; I finished without repeating the write.';
  const model = recordingModel([
    [functionCall(callId, 'task_list', {})],
    [textMessage(finalReply)],
  ]);
  const agent = { model, instructions: 'Continue from exact recovered history.', tools: [configuredTool] };
  bindSurface(session.id, agent, [configuredTool]);
  const turnOptions = {
    sessionId: session.id,
    input: sourceText,
    sourceUserSeq: source.seq,
    reuseRecordedUserInput: true as const,
    suppressMemoryCapture: true,
    turnEngine: 'host_v1' as const,
    agent: agent as never,
    makeRunner: () => throwingRunner() as never,
    maxTurns: 4,
  };

  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TEMP TRIGGER reject_boot_projection_receipt
    BEFORE INSERT ON logical_model_result_projection_receipts
    WHEN NEW.session_id = '${session.id}' AND NEW.call_id = '${callId}'
    BEGIN
      SELECT RAISE(ABORT, 'fixture boot projection receipt unavailable');
    END
  `);
  let held: Awaited<ReturnType<typeof runTurn>>;
  try {
    held = await runTurn(turnOptions);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS reject_boot_projection_receipt');
  }
  assert.equal(held.status, 'held', JSON.stringify(held));
  assert.equal(localBodies, 1);
  assert.equal(externalBodies, 1);
  assert.equal(model.calls(), 1);
  const persisted = HarnessSession.load(session.id)?.loadRecoveryState();
  assert.ok(persisted);
  const exactRestartState = HostRecoveryState.fromString(persisted!);
  assert.equal(exactRestartState.phase, 'finalize');
  assert.equal(exactRestartState.sessionId, session.id);
  assert.equal(exactRestartState.sourceUserSeq, source.seq);
  // Round-trip the only private bytes a fresh process receives.
  HarnessSession.load(session.id)?.saveRecoveryState(exactRestartState.toString());

  let settleDispatch!: (value: Awaited<ReturnType<typeof runTurn>>) => void;
  let rejectDispatch!: (error: unknown) => void;
  const dispatched = new Promise<Awaited<ReturnType<typeof runTurn>>>((resolve, reject) => {
    settleDispatch = resolve;
    rejectDispatch = reject;
  });
  let dispatches = 0;
  const summary = restartRecovery.recoverInterruptedChatRuns(Date.now, async (restart) => {
    try {
      dispatches += 1;
      assert.deepEqual({
        sessionId: restart.sessionId,
        sourceUserSeq: restart.sourceUserSeq,
        acceptedInput: restart.acceptedInput,
        surface: restart.surface,
        channel: restart.channel,
      }, {
        sessionId: session.id,
        sourceUserSeq: source.seq,
        acceptedInput: sourceText,
        surface: 'discord',
        channel: 'discord',
      });
      const finalized = await runTurn(turnOptions);
      assert.equal(finalized.status, 'held', JSON.stringify(finalized));
      const continuationBytes = HarnessSession.load(session.id)?.loadRecoveryState();
      assert.ok(continuationBytes);
      assert.equal(HostRecoveryState.fromString(continuationBytes!).phase, 'continue');
      assert.equal(localBodies, 1, 'boot finalization cannot re-enter the local body');
      assert.equal(externalBodies, 1, 'boot finalization cannot repeat the earlier provider write');
      assert.equal(model.calls(), 1, 'finalization performs no model replay');

      const completed = await runTurn(turnOptions);
      settleDispatch(completed);
    } catch (error) {
      rejectDispatch(error);
      throw error;
    }
  });
  const record = summary.records.find((candidate) => candidate.sessionId === session.id);
  assert.ok(record, JSON.stringify(summary));
  assert.equal(record!.autoResumed, true, JSON.stringify(record));
  assert.equal(record!.autoResumeSkipped, undefined);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const completed = await Promise.race([
    dispatched,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('boot checkpoint dispatcher did not finish')), 4_000);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  assert.equal(completed.finalOutput, finalReply);
  assert.equal(dispatches, 1);
  assert.equal(localBodies, 1);
  assert.equal(externalBodies, 1);
  assert.equal(model.calls(), 2,
    'only the ordinary post-adoption continuation reaches the model');
  assert.equal(functionResultCount(model.requests[1], callId), 1);
  assert.equal(HarnessSession.load(session.id)?.loadRecoveryState(), null);

  const decision = eventlog.listEvents(session.id, {
    types: ['restart_recovery_decision'],
  }).at(-1);
  assert.equal(decision?.data.exactCheckpointRecovery, true);
  assert.equal(decision?.data.externalWritesSinceInterrupt, 1);
  assert.equal(decision?.data.autoResume, true,
    'the exact checkpoint owner overrides only the generic replay ban');
  assert.equal(eventlog.listEvents(session.id, {
    types: ['conversation_completed', 'awaiting_user_input', 'approval_requested', 'approval_required'],
  }).length, 0, 'boot recovery emits no generic retry banner, question, or approval card');
  assert.doesNotMatch(JSON.stringify(eventlog.listEvents(session.id)),
    /Reply `continue`|durable tool-result checkpoint|checkpoint could not be verified|recorded call state/i);
});
