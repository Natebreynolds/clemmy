/**
 * Run: npx tsx --test src/runtime/harness/stall-retry-directive.test.ts
 *
 * A stall retry is the harness correcting the model, never the owner speaking.
 * Pins: the retry instruction reaches the model as transient system context
 * for that one request, the model-visible user item is a plain continuation,
 * no owner-authored row carries the instruction, and the memory store and the
 * profile are exactly what they were before the retry. The retry turn still
 * classifies and budgets against the owner's request it retries, never against
 * the continuation item. The resume loop keeps the same contract.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-stall-retry-directive-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
// Legacy terminate-on-stall path with one retry, deterministic same-family
// judging, and the event-based tool counter for scripted runners (the same
// pins loop.test.ts uses for its stall mechanics).
process.env.HARNESS_STALL_ASK_USER = 'off';
process.env.HARNESS_MAX_STALL_RETRIES = '1';
process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
process.env.HARNESS_TOOL_BRACKETS = 'off';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent, RunContext, RunState, type AgentInputItem, type Runner } from '@openai/agents';

const { listEvents } = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { runConversation, runConversationFromResume } = await import('./loop.js');
const approvalRegistry = await import('./approval-registry.js');
const { openMemoryDb } = await import('../../memory/db.js');
const { loadUserProfile } = await import('../user-profile.js');
type RunRunnerFn = import('./loop.js').RunRunnerFn;

after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });

// The stall retry's own sentences, as buildStallRetryMessage authors them.
const STALL_INSTRUCTION = [/did not make progress on the directive/i, /was prose, not an action/i, /MUST call a tool now/i];
const carriesStallInstruction = (text: string): boolean => STALL_INSTRUCTION.some((pattern) => pattern.test(text));
// The model-visible user item of every stall retry.
const PLAIN_CONTINUATION = 'Continue with the next step of your plan.';

function itemText(item: unknown): string {
  const content = (item as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join(' ');
}
const roleOf = (item: unknown): string | undefined => (item as { role?: string }).role;
const makeRunner = (): Runner => new EventEmitter() as unknown as Runner;

/** Exactly what the model would see on one pass: the transient per-request
 * context is applied by the same input filter the SDK invokes. A resumed
 * approval hands the runner its serialized run state, not items, and carries
 * no per-request context; it is observed as an empty request. A pass that
 * carries no filter is sent as is. */
async function composedRequest(items: AgentInputItem[], opts: Record<string, unknown>): Promise<AgentInputItem[]> {
  if (!Array.isArray(items)) return [];
  const filter = opts.callModelInputFilter as
    | ((args: { modelData: { input: AgentInputItem[]; instructions?: string } }) =>
      Promise<{ input: AgentInputItem[] }> | { input: AgentInputItem[] })
    | undefined;
  if (typeof filter !== 'function') return items;
  return (await filter({ modelData: { input: items, instructions: '' } })).input;
}

/** The one request whose system context carries the stall instruction, pinned
 * to be the only one; its user items stay the owner's words plus the plain
 * continuation, and every earlier request carries no instruction anywhere. */
function assertRetryRequestShape(requests: AgentInputItem[][]): void {
  const retryIndexes = requests
    .map((request, index) => (request.some((item) => roleOf(item) === 'system' && carriesStallInstruction(itemText(item))) ? index : -1))
    .filter((index) => index >= 0);
  assert.equal(retryIndexes.length, 1, 'exactly one request carries the stall instruction as system context');
  const retryIndex = retryIndexes[0]!;
  assert.ok(retryIndex >= 1, 'the retry follows the stalled request');
  const userItems = requests[retryIndex]!.filter((item) => roleOf(item) === 'user');
  assert.ok(userItems.length > 0, 'the retry still has a user item');
  for (const item of userItems) {
    assert.equal(carriesStallInstruction(itemText(item)), false, 'no user item carries the stall instruction');
  }
  assert.equal(itemText(userItems.at(-1)), PLAIN_CONTINUATION, 'the model-visible user item is the plain continuation');
  for (let index = 0; index < retryIndex; index += 1) {
    assert.equal(requests[index]!.some((item) => carriesStallInstruction(itemText(item))), false, `request ${index} carries no instruction`);
  }
}

function assertOwnerRowsCarryNoInstruction(sessionId: string): void {
  for (const row of listEvents(sessionId, { types: ['user_input_received'] })) {
    assert.equal(carriesStallInstruction(String(row.data.text ?? '')), false, `row ${row.seq} is not a harness instruction`);
  }
}

test('a stall retry carries its instruction as transient system context and leaves memory and the profile untouched', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const profileBefore = loadUserProfile();
  const memory = openMemoryDb();
  const countRows = (table: string): number => (memory.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const candidatesBefore = countRows('memory_reflection_candidates');
  const factsBefore = countRows('consolidated_facts');

  const requests: AgentInputItem[][] = [];
  const runRunner: RunRunnerFn = async (_runner, _agent, items, opts) => {
    // Observe exactly what the model would see: the transient per-request
    // context is applied by the same input filter the SDK invokes.
    const filter = opts.callModelInputFilter as (args: { modelData: { input: AgentInputItem[]; instructions?: string } }) =>
      Promise<{ input: AgentInputItem[] }> | { input: AgentInputItem[] };
    const sent = await filter({ modelData: { input: items, instructions: '' } });
    requests.push(sent.input);
    return {
      history: [],
      lastResponseId: undefined,
      // A generic acknowledgement with zero tools is the stall; the retry answers.
      finalOutput: requests.length === 1 ? 'OK.' : 'Which sheet should I add the rows to?',
    };
  };
  await runConversation({
    agent: {} as never,
    sessionId: sess.id,
    input: 'do work',
    makeRunner: () => new EventEmitter() as unknown as Runner,
    runRunner,
  });

  assert.ok(listEvents(sess.id, { types: ['stall_retry_attempted'] }).length >= 1, 'the first reply stalled and a retry ran');
  assert.ok(requests.length >= 2, 'the retry reached the model');
  const retry = requests[1]!;
  const userItems = retry.filter((item) => roleOf(item) === 'user');
  assert.ok(userItems.length > 0, 'the retry still has a user item');
  for (const item of userItems) {
    assert.equal(carriesStallInstruction(itemText(item)), false, 'no user item carries the stall instruction');
  }
  assert.ok(
    retry.some((item) => roleOf(item) === 'system' && carriesStallInstruction(itemText(item))),
    'the stall instruction rides as system context for that request',
  );
  assert.equal(
    requests[0]!.some((item) => carriesStallInstruction(itemText(item))), false,
    'the instruction is for the retry only',
  );

  // Durable owner rows carry the owner's words only.
  for (const row of listEvents(sess.id, { types: ['user_input_received'] })) {
    assert.equal(carriesStallInstruction(String(row.data.text ?? '')), false, `row ${row.seq} is not a harness instruction`);
  }
  assert.equal(listEvents(sess.id, { types: ['memory_signals_captured'] }).length, 0, 'nothing was captured from the retry');

  // Memory and profile: untouched.
  assert.equal(countRows('memory_reflection_candidates'), candidatesBefore);
  assert.equal(countRows('consolidated_facts'), factsBefore);
  for (const [table, column] of [['memory_reflection_candidates', 'text'], ['consolidated_facts', 'content']] as const) {
    const rows = memory.prepare(`SELECT ${column} AS value FROM ${table}`).all() as Array<{ value: string }>;
    for (const row of rows) assert.equal(carriesStallInstruction(row.value), false, `${table} holds no harness instruction`);
  }
  assert.deepEqual(loadUserProfile(), profileBefore);
});

test('a stall retry classifies and budgets against the owner\'s request, not the continuation item', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const request = 'Pull the latest invoices from QuickBooks, compare them against the spreadsheet in Drive, then draft an email to accounting summarizing the discrepancies.';
  const requests: AgentInputItem[][] = [];
  const runRunner: RunRunnerFn = async (_runner, _agent, items, opts) => {
    requests.push(await composedRequest(items, opts));
    return {
      history: [],
      lastResponseId: undefined,
      finalOutput: requests.length === 1 ? 'OK.' : 'Which sheet should I add the rows to?',
    };
  };
  await runConversation({ agent: {} as never, sessionId: sess.id, input: request, makeRunner, runRunner });

  assert.ok(listEvents(sess.id, { types: ['stall_retry_attempted'] }).length >= 1, 'the first reply stalled and a retry ran');
  assertRetryRequestShape(requests);

  // The turn's own classification and reasoning budget are the request's,
  // never the continuation item's: the same context packet and effort as
  // the turn that accepted the request.
  const packetByTurn = new Map<number, { inputPreview?: string; complexity?: string }>();
  for (const event of listEvents(sess.id, { types: ['agent_context_packet'] })) {
    packetByTurn.set(event.turn, event.data as { inputPreview?: string; complexity?: string });
  }
  const effortByTurn = new Map<number, { effort?: string }>();
  for (const event of listEvents(sess.id, { types: ['reasoning_effort'] })) {
    effortByTurn.set(event.turn, event.data as { effort?: string });
  }
  const requestTurn = packetByTurn.get(1);
  const retryTurn = packetByTurn.get(2);
  assert.ok(requestTurn && retryTurn, 'both the request turn and the retry turn built a context packet');
  assert.equal(retryTurn.inputPreview, request, 'the retry turn is anchored to the owner\'s request');
  assert.equal(retryTurn.complexity, requestTurn.complexity, 'the retry turn keeps the request\'s complexity');
  assert.ok(effortByTurn.get(2)?.effort, 'the retry turn chose a reasoning effort');
  assert.notEqual(effortByTurn.get(2)?.effort, 'none', 'the retry turn is not run at zero reasoning budget');
});

function approvalStateWithInterruptions(
  agent: Agent<any, any>,
  interruptions: Array<{ toolName: string; argumentsJson?: string; callId?: string }>,
): string {
  const state = new RunState(new RunContext({}), 'approve this', agent, null);
  const json = state.toJSON() as Record<string, unknown>;
  json.currentStep = {
    type: 'next_step_interruption',
    data: {
      interruptions: interruptions.map((interruption, index) => ({
        rawItem: {
          type: 'function_call',
          name: interruption.toolName,
          callId: interruption.callId ?? `${interruption.toolName}_call_${index}`,
          arguments: interruption.argumentsJson ?? '{}',
        },
        toolName: interruption.toolName,
      })),
    },
  };
  return JSON.stringify(json);
}

test('a resume-path stall retry carries its instruction as system context beside the plain continuation', async () => {
  const agent = new Agent({ name: 'ResumeStallRetry', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat' });
  const tool = 'composio_execute_tool';
  const args = { tool_slug: 'X', arguments: '{}' };
  sess.saveInterruptState(approvalStateWithInterruptions(agent, [{ toolName: tool, callId: 'c1', argumentsJson: JSON.stringify(args) }]));
  approvalRegistry.register({ sessionId: sess.id, subject: 'the pull', tool, args });

  const scripted: unknown[] = [
    // The approved turn resumes and is not done, which drives the continuation loop.
    { done: false, nextAction: 'awaiting_handoff_result', reply: 'Approved — continuing.', summary: 'resumed after approval', reason: null },
    // The continuation defers with zero tools: the resume-path stall.
    { done: false, nextAction: 'awaiting_handoff_result', reply: 'On it — running the pull now. One sec.', summary: 'about to pull', reason: null },
    // The retry completes.
    { done: true, nextAction: 'completed', reply: 'Here are the 12 records.', summary: 'Returned the records.', reason: null },
  ];
  const requests: AgentInputItem[][] = [];
  const runRunner: RunRunnerFn = async (_runner, _agent, items, opts) => {
    requests.push(await composedRequest(items, opts));
    const output = scripted[requests.length - 1] ?? scripted[scripted.length - 1];
    return { history: items, lastResponseId: undefined, finalOutput: output };
  };
  const result = await runConversationFromResume({
    agent, sessionId: sess.id, decision: 'approve', resolver: 'unit-test', makeRunner, runRunner,
  });

  const resumeRetries = listEvents(sess.id, { types: ['stall_retry_attempted'] })
    .filter((event) => (event.data as { path?: string }).path === 'resume');
  assert.ok(resumeRetries.length >= 1, 'the resume continuation stalled and a resume-path retry ran');
  assert.equal(result.status, 'completed');
  assertRetryRequestShape(requests);
  assertOwnerRowsCarryNoInstruction(sess.id);
});
