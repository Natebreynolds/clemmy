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

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-continuation-owner-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_WATCHER_JUDGE = 'off';
process.env.CLEMMY_EVAL_AUTO_PROMOTE = 'off';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-host-recovery-wake\n', 'utf8');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const envelopes = await import('../../agents/capability-envelope.js');
const { HostRecoveryState, _setHostObjectiveJudgeForTests } = await import('./host-turn-runner.js');
const { runConversation } = await import('./loop.js');
const { HarnessSession } = await import('./session.js');
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
    policyHash: 'host-checkpoint-continuation-owner-v1',
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

test('timer and immediate checkpoint continuation share one exact-source activation, retaining the judge budget', async () => {
  const session = eventlog.createSession({ id: 'continuation-timer-immediate-owner', kind: 'chat' });
  const sourceText = 'Find the exact local task and report its title back to me.';
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: sourceText } });
  const callId = 'continuation-owned-local-read';
  let bodies = 0;
  const configuredTool = brackets.wrapToolForHarness({
    type: 'function', name: 'task_list', description: 'Return one exact local task record.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    needsApproval: async () => false,
    invoke: async () => { bodies += 1; return { records: [{ id: 'task-1', title: 'Release recovery audit' }] }; },
  });
  const finalReply = 'The task is Release recovery audit.';
  const model = recordingModel([
    [textMessage('I will find the requested task and report its title.')],
    [functionCall(callId, 'task_list', {})],
    [textMessage(finalReply)],
  ]);
  const agent = { model, instructions: 'Use the exact configured local tool.', tools: [configuredTool] };
  bindSurface(session.id, agent, [configuredTool]);
  let judges = 0;
  _setHostObjectiveJudgeForTests(async () => {
    judges += 1;
    return judges === 1
      ? { done: false, reason: 'The reply promises a lookup but contains no task title.' }
      : { done: true, reason: 'The exact local result contains the reported task title.' };
  });
  const db = eventlog.openEventLog();
  db.exec(`CREATE TEMP TRIGGER reject_continuation_owner_projection
    BEFORE INSERT ON logical_model_result_projection_receipts
    WHEN NEW.session_id = '${session.id}' AND NEW.call_id = '${callId}'
    BEGIN SELECT RAISE(ABORT, 'fixture exact checkpoint unavailable'); END`);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let continuingBuilders = 0;
  const options = {
    sessionId: session.id, sourceUserSeq: source.seq, input: sourceText,
    turnEngine: 'host_v1' as const, judgeCompletion: true,
    // This real production capability-construction seam precedes runTurn's
    // checkpoint adoption. Holding here reproduces the live window in which a
    // second wake still sees the same durable continue blob.
    buildAgent: async () => {
      const blob = HarnessSession.load(session.id)?.loadRecoveryState();
      if (blob && HostRecoveryState.fromString(blob).phase === 'continue') {
        continuingBuilders += 1;
        await gate;
      }
      return agent as never;
    },
    makeRunner: () => throwingRunner() as never,
    maxTurns: 8, maxSteps: 2, suppressMemoryCapture: true,
  };
  let joined: Promise<Awaited<ReturnType<typeof runConversation>>> | undefined;
  try {
    const held = await runConversation(options);
    assert.equal(held.status, 'held', JSON.stringify(held));
    assert.equal(bodies, 1);
    assert.equal(judges, 1, 'the real first verdict spent one continuation');
    const blob = HarnessSession.load(session.id)?.loadRecoveryState();
    assert.ok(blob);
    assert.equal(HostRecoveryState.fromString(blob).objectiveJudgeContinuations, 1);
    db.exec('DROP TRIGGER reject_continuation_owner_projection');
    await waitFor(() => continuingBuilders > 0, 'timer recovery reaching ready immediate continuation');
    // A separate same-source recovery caller must join the active timer owner.
    // Let the original 250ms timer interval elapse while adoption stays gated;
    // the old map deletion starts another capability/model activation here.
    joined = runConversation(options);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(continuingBuilders, 1, 'one exact source may have only one active continuation builder');
    assert.equal(model.calls(), 2, 'no second primary request starts before the owner adopts its checkpoint');
  } finally {
    db.exec('DROP TRIGGER IF EXISTS reject_continuation_owner_projection');
    release();
  }
  try {
    assert.ok(joined);
    const result = await joined;
    assert.equal(result.status, 'completed', JSON.stringify(result));
    await waitFor(() => eventlog.listEvents(session.id, { types: ['conversation_completed'] }).length === 1,
      'one typed terminal');
    const finalModelCalls = model.calls();
    const finalJudges = judges;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(model.calls(), finalModelCalls, 'no late primary request after terminal');
    assert.equal(judges, finalJudges, 'no late completion judge after terminal');
    assert.equal(model.calls(), 3, 'promise, one read, one final reply');
    assert.equal(judges, 2);
    assert.equal(bodies, 1, 'the settled tool body is never replayed');
    assert.equal(functionResultCount(model.requests[2], callId), 1);
    assert.deepEqual(eventlog.listEvents(session.id, { types: ['goal_alignment_judged'] })
      .filter((event) => event.data.kind === 'completion').map((event) => event.data.continuationsUsed), [0, 1],
      'phase-continue adoption preserves the source budget rather than resetting it');
    assert.equal(HarnessSession.load(session.id)?.loadRecoveryState(), null);
    const terminals = eventlog.listEvents(session.id, { types: ['conversation_completed'] });
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.data.sourceUserSeq, source.seq);
    assert.equal(terminals[0]?.data.reply, finalReply);
    assert.equal(eventlog.listEvents(session.id, { types: ['approval_requested', 'awaiting_user_input'] }).length, 0);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM logical_call_settlements
      WHERE session_id = ? AND logical_tool_call_id = ?`).get(session.id, callId) as { n: number }).n, 1);
  } finally { _setHostObjectiveJudgeForTests(null); }
});
