/**
 * NEVER-RESTING on the host lane: the per-activation tool ceiling is a
 * checkpoint cadence, not an ending.
 *
 * A frame larger than the activation budget commits the calls that ran,
 * closes the untouched siblings, propagates the typed limit, and the
 * conversation runner re-enters the SAME accepted source in a fresh
 * activation without a user message. The attempt cap still parks.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-ceiling-continue-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.HARNESS_BUDGET_PRESET = 'unlimited';
process.env.CLEMMY_CHAT_AUTO_CONTINUE_CAP = '2';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-host-ceiling-continue\n', 'utf8');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const envelopes = await import('../../agents/capability-envelope.js');
const { runConversationContinuingPastToolCallsLimit: runConversation } = await import('./loop.js');
const { HarnessSession } = await import('./session.js');
const memoryDatabase = await import('../../memory/db.js');

test.after(() => {
  eventlog.closeEventLog();
  memoryDatabase.closeMemoryDb();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const textMessage = (text: string) => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
const functionCall = (callId: string, name: string, args: Record<string, unknown>) => ({ type: 'function_call', callId, name, arguments: JSON.stringify(args) });
const done = (reply: string) => textMessage(JSON.stringify({ summary: reply, reply, done: true, nextAction: 'completed', reason: null }));

async function* testModelStream(this: { getResponse: (request: unknown) => Promise<{ usage?: unknown; output?: unknown[]; responseId?: string }> }, request: unknown) {
  const response = await this.getResponse(request);
  yield { type: 'response_started' } as never;
  yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
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
      return { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output: [...output], responseId: `ceiling-response-${callCount}` };
    },
    getStreamedResponse: testModelStream,
  };
}

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => { throw new Error('legacy Runner.run must not own a host_v1 activation'); };
  return runner;
}

function bindSurface(sessionId: string, agent: object, tools: Array<{ name?: unknown }>): void {
  const sealed = envelopes.sealAgentCapabilityUniverse({
    sessionId, universeTools: tools,
    activeToolNames: tools.flatMap((entry) => (typeof entry.name === 'string' ? [entry.name] : [])),
    policyHash: 'host-ceiling-continue-v1',
    budget: { maxUncachedTokens: 1_000, maxModelCalls: 16, maxToolCalls: 64, maxElapsedMs: 20_000 },
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  if (!sealed.ok) throw new Error(sealed.errors.join('; '));
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
}

function fixture() {
  // A registry-known read: the host admits it without a plan or a capability
  // manifest, so the only bound in play is the activation ceiling.
  const saved: string[] = [];
  const saveNote = brackets.wrapToolForHarness({
    type: 'function', name: 'task_list',
    description: 'Return the exact local task list.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    needsApproval: async () => false,
    invoke: async (_context: unknown, _input: unknown, details: unknown) => {
      const callId = (details as { toolCall?: { callId?: string } } | undefined)?.toolCall?.callId ?? 'unknown';
      saved.push(callId);
      return { records: [{ id: callId }] };
    },
  });
  return { saved, saveNote };
}

const guides = (sessionId: string) => eventlog.listEvents(sessionId, { types: ['guardrail_tripped'] }).map((event) => event.data as Record<string, unknown>);

test('a frame past the activation ceiling finishes in the next activation without a user message', async () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const { saved, saveNote } = fixture();
  const model = recordingModel([
    [1, 2, 3, 4, 5].map((n) => functionCall(`note-${n}`, 'task_list', {})),
    // The resumed activation sees the not-started dispositions and re-issues
    // exactly the remainder under fresh call ids.
    [4, 5].map((n) => functionCall(`note-${n}-again`, 'task_list', {})),
    [done('All five notes are saved.')],
  ]);
  const agent = { model, instructions: 'Use the exact configured tool.', tools: [saveNote] };
  bindSurface(session.id, agent, [saveNote]);

  const result = await runConversation({
    sessionId: session.id,
    input: 'List the local tasks five times and report back.',
    turnEngine: 'host_v1',
    judgeCompletion: false,
    agent: agent as never,
    makeRunner: () => throwingRunner() as never,
    maxTurns: 6,
    toolCallsPerTurn: 3,
    suppressMemoryCapture: true,
  });

  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.deepEqual(saved, ['note-1', 'note-2', 'note-3', 'note-4-again', 'note-5-again'], 'every call runs exactly once across two activations');
  assert.ok(model.calls() >= 3, 'one frame, at least one continuation frame, one answer');
  const kinds = guides(session.id).map((row) => row.kind);
  assert.ok(kinds.includes('tool_calls_limit'), JSON.stringify(kinds));
  const resumes = guides(session.id).filter((row) => row.kind === 'budget_checkpoint_auto_resume');
  assert.equal(resumes.length, 1, JSON.stringify(resumes));
  assert.equal(resumes[0]!.resume, true);
  assert.ok(Number(resumes[0]!.settledThisActivation) >= 1, 'progress is read from the ledger');
  assert.notEqual(HarnessSession.load(session.id)?.sessionRow.status, 'failed');
  assert.equal(eventlog.listEvents(session.id, { types: ['conversation_completed'] }).length, 1);
  assert.equal(eventlog.listEvents(session.id, { types: ['user_input_received'] }).length, 1, 'the continuation is host-owned, not a synthetic user message');
});

test('the attempt cap still parks a run that keeps tripping its ceiling', async () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const { saved, saveNote } = fixture();
  let batch = 0;
  const model = {
    calls: () => batch,
    async getResponse() {
      batch += 1;
      // Always more work than one activation can hold.
      return { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [1, 2, 3].map((n) => functionCall(`b${batch}-${n}`, 'task_list', {})), responseId: `cap-${batch}` };
    },
    getStreamedResponse: testModelStream,
  };
  const agent = { model, instructions: 'Use the exact configured tool.', tools: [saveNote] };
  bindSurface(session.id, agent, [saveNote]);

  const result = await runConversation({
    sessionId: session.id,
    input: 'Keep listing the local tasks.',
    turnEngine: 'host_v1',
    judgeCompletion: false,
    agent: agent as never,
    makeRunner: () => throwingRunner() as never,
    maxTurns: 6,
    toolCallsPerTurn: 1,
    suppressMemoryCapture: true,
  });

  assert.equal(result.status, 'limit_exceeded', JSON.stringify(result));
  assert.equal(result.limitKind, 'tool_calls');
  assert.ok(saved.length >= 3, 'one activation plus two resumes each ran work');
  assert.equal(guides(session.id).filter((row) => row.kind === 'tool_calls_limit').length, 3, 'three activations tripped the ceiling: the first and two resumes');
  const resumes = guides(session.id).filter((row) => row.kind === 'budget_checkpoint_auto_resume');
  assert.deepEqual(resumes.map((row) => row.resume), [true, true, false]);
  assert.equal(resumes.at(-1)!.reason, 'cap_exhausted');
});

test('a ceiling made only of pre-dispatch refusals resumes so the model can repair, then finishes', async () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const { saved, saveNote } = fixture();
  // Frame one: an unconfigured tool name, refused before dispatch for every
  // call; the counter still charges them and trips at 3 with zero settlements.
  const model = recordingModel([
    [1, 2, 3, 4].map((n) => functionCall(`bad-${n}`, 'save_note', { id: `n${n}` })),
    // The resumed activation has seen the refusals and repairs.
    [1, 2].map((n) => functionCall(`good-${n}`, 'task_list', {})),
    [done('Both listed.')],
  ]);
  const agent = { model, instructions: 'Use the exact configured tool.', tools: [saveNote] };
  bindSurface(session.id, agent, [saveNote]);
  const result = await runConversation({
    sessionId: session.id,
    input: 'List the local tasks twice.',
    turnEngine: 'host_v1',
    judgeCompletion: false,
    agent: agent as never,
    makeRunner: () => throwingRunner() as never,
    maxTurns: 6,
    toolCallsPerTurn: 3,
    suppressMemoryCapture: true,
  });
  assert.equal(result.status, 'completed', JSON.stringify(result).slice(0, 600));
  assert.deepEqual(saved, ['good-1', 'good-2']);
  const resumes = guides(session.id).filter((row) => row.kind === 'budget_checkpoint_auto_resume');
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0]!.resume, true);
  assert.equal(resumes[0]!.settledThisActivation, 1, 'refusal diagnostics count as one repair step');
  const returned = eventlog.listEvents(session.id, { types: ['tool_returned'] }).map((e) => JSON.stringify(e.data).slice(0, 220));
  assert.ok(Number(resumes[0]!.refusedThisActivation) >= 3, JSON.stringify({ resume: resumes[0], returned: returned.slice(0, 4) }));
});

