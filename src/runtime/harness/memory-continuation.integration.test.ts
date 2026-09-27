/**
 * The memory a request carries survives the host's own continuations.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/memory-continuation.integration.test.ts
 *
 * A frame larger than the per-activation tool ceiling makes the conversation
 * runner re-enter the SAME accepted source in a fresh activation, with the
 * memory ranker held back. That hold is the runtime's, not the owner's: the
 * resumed activation must see the request's remembered facts as the first
 * one did. Only a request that itself declined memory keeps its query-driven
 * recall declined.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-continuation-'));
Object.assign(process.env, {
  CLEMENTINE_HOME: TMP_HOME,
  CLEMMY_TEST_ISOLATED_HOME: '1',
  HARNESS_TOOL_BRACKETS: 'on',
  CLEMMY_TURN_ENGINE: 'host_v1',
  MCP_AUTO_IMPORT_ENABLED: 'false',
  EMBEDDINGS_DISABLED: 'true',
  CLEMMY_SEMANTIC_RECALL: 'off',
  CLEMMY_JEV: 'off',
  HARNESS_BUDGET_PRESET: 'unlimited',
  CLEMMY_CHAT_AUTO_CONTINUE_CAP: '2',
});
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-memory-continuation\n', 'utf8');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('no network in the memory-continuation fixture'); };

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const envelopes = await import('../../agents/capability-envelope.js');
const { harnessInstructions } = await import('../../agents/harness-context.js');
const { rememberFact } = await import('../../memory/facts.js');
const { runConversationContinuingPastToolCallsLimit: runConversation, runConversationFromResume } = await import('./loop.js');
const { HarnessSession } = await import('./session.js');
const approvals = await import('./approval-registry.js');
const { Agent, RunContext, RunState } = await import('@openai/agents');
const memoryDatabase = await import('../../memory/db.js');
const { BoundaryError } = await import('../boundary-error.js');

rememberFact({ kind: 'reference', content: 'Priority accounts are the records where Account.Priority_Account__c is true in the quokka ledger.' });
rememberFact({ kind: 'project', content: 'Invoices are reviewed on Tuesdays by the operations desk.' });

test.after(() => {
  eventlog.closeEventLog();
  memoryDatabase.closeMemoryDb();
  globalThis.fetch = originalFetch;
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const textMessage = (text: string) => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
const functionCall = (callId: string, name: string) => ({ type: 'function_call', callId, name, arguments: '{}' });
const done = (reply: string) => textMessage(JSON.stringify({ summary: reply, reply, done: true, nextAction: 'completed', reason: null }));

function recordingModel(responses: readonly (readonly unknown[])[]) {
  let callCount = 0;
  const requests: string[] = [];
  return {
    requests,
    async getResponse(request: unknown) {
      const row = request as { systemInstructions?: string; input?: unknown };
      requests.push([row.systemInstructions ?? '', JSON.stringify(row.input ?? [])].join('\n'));
      const output = responses[Math.min(callCount, responses.length - 1)] ?? [];
      callCount += 1;
      return { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output: [...output], responseId: `continuation-response-${callCount}` };
    },
    async *getStreamedResponse(request: unknown) {
      const response = await this.getResponse(request);
      yield { type: 'response_started' } as never;
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    },
  };
}

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => { throw new Error('legacy Runner.run must not own a host_v1 activation'); };
  return runner;
}

/** A registry-known read, so the only bound in play is the activation ceiling. */
function taskList() {
  return brackets.wrapToolForHarness({
    type: 'function', name: 'task_list',
    description: 'Return the exact local task list.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    needsApproval: async () => false,
    invoke: async (_context: unknown, _input: unknown, details: unknown) => {
      const callId = (details as { toolCall?: { callId?: string } } | undefined)?.toolCall?.callId ?? 'unknown';
      return { records: [{ id: callId }] };
    },
  });
}

/** The production harness composition, so the turn carries the memory core
 *  in its prefix and memory after the boundary, under a sealed envelope. */
function sealedAgent(label: string, sessionId: string, request: string, model: ReturnType<typeof recordingModel>) {
  const tool = taskList();
  const agent = {
    model,
    instructions: harnessInstructions('Use the exact configured tool.', { sessionId, focusInput: request }),
    tools: [tool],
  };
  const sealed = envelopes.sealAgentCapabilityUniverse({
    sessionId, universeTools: [tool], activeToolNames: ['task_list'],
    policyHash: `memory-continuation-${label}`,
    budget: { maxUncachedTokens: 1_000, maxModelCalls: 16, maxToolCalls: 64, maxElapsedMs: 20_000 },
  });
  if (!sealed.ok) throw new Error(sealed.errors.join('; '));
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  return agent;
}

async function ceilingRun(label: string, request: string) {
  const session = eventlog.createSession({ kind: 'chat' });
  const model = recordingModel([
    [1, 2, 3, 4, 5].map((n) => functionCall(`${label}-${n}`, 'task_list')),
    [4, 5].map((n) => functionCall(`${label}-${n}-again`, 'task_list')),
    [done('Done.')],
  ]);
  const agent = sealedAgent(label, session.id, request, model);
  const result = await runConversation({
    sessionId: session.id, input: request, turnEngine: 'host_v1', judgeCompletion: false,
    agent: agent as never, makeRunner: () => throwingRunner() as never,
    maxTurns: 6, toolCallsPerTurn: 3, suppressMemoryCapture: true,
  });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const resumes = eventlog.listEvents(session.id, { types: ['guardrail_tripped'] })
    .filter((event) => (event.data as { kind?: string }).kind === 'budget_checkpoint_auto_resume');
  assert.equal(resumes.length, 1, 'the ceiling re-entered the same source once');
  const primers = eventlog.listEvents(session.id, { types: ['turn_memory_primer'] }).map((event) => event.data as Record<string, unknown>);
  assert.equal(primers.length, 2, 'one primer per activation');
  return { requests: model.requests, primers };
}

// Regression: the resumed activation once read the runtime's own ranker hold
// as the owner declining memory and lost every remembered fact.
test('a request resumed past the tool ceiling keeps the memory it started with', async () => {
  const { requests, primers } = await ceilingRun('keeps', 'List my priority accounts in the quokka ledger and draft a client note to each.');
  assert.equal(primers[1]!.skippedReason, 'same_request_continuation', 'the hold is the runtime\'s, not a decline');
  assert.equal(primers[1]!.injected, true, 'the resumed activation carries memory');
  const resumed = requests.at(-1)!;
  assert.match(resumed, /Account\.Priority_Account__c is true/, 'the request\'s fact reaches the resumed activation');
  assert.match(resumed, /## Persistent Facts/, 'the per-block memory stands in for the held-back ranker');
});

// A request that declined automatic memory skips the query-driven recall on
// every activation, and keeps the per-block memory its prompt always carried.
// Regression: the decline once removed every remembered fact from the request.
test('a request that declined memory stays declined when it resumes', async () => {
  const { requests, primers } = await ceilingRun('declined',
    'Do not use memory for this request. List my priority accounts in the quokka ledger.');
  assert.deepEqual(primers.map((primer) => primer.skippedReason), ['explicit_request_opt_out', 'explicit_request_opt_out']);
  for (const request of requests) {
    assert.match(request, /Account\.Priority_Account__c is true/, 'the prompt\'s per-block memory still reaches the request');
    assert.match(request, /## Persistent Facts/, 'the per-block memory stands in');
    for (const absent of ['## Relevant To This Request', '[REMEMBERED FACTS', 'memory_recall_all searches all of it']) {
      assert.equal(request.includes(absent), false, `no query-driven recall on a declined request: ${absent}`);
    }
  }
});

/** What the model receives for one runner call: the agent's instructions and
 *  the input after the turn's own model-input filter. */
function modelRequest(agent: { instructions?: unknown }, items: unknown[], opts: Record<string, unknown>): string {
  const instructions = typeof agent.instructions === 'function' ? String((agent.instructions as () => unknown)()) : String(agent.instructions ?? '');
  const filter = opts.callModelInputFilter as ((args: { modelData: { input: unknown[]; instructions?: string } }) => { input: unknown[]; instructions?: string }) | undefined;
  const filtered = filter ? filter({ modelData: { input: items, instructions } }) : { input: items, instructions };
  return [filtered.instructions ?? '', JSON.stringify(filtered.input)].join('\n');
}

/** Remembered notes that share the host directives' words and not the
 *  request's, so memory ranked by a directive shows them instead of the
 *  request's fact. Stored once. */
let directiveLookalikesStored = false;
function rememberDirectiveLookalikes(): void {
  if (directiveLookalikesStored) return;
  directiveLookalikesStored = true;
  for (let n = 1; n <= 12; n += 1) {
    rememberFact({ kind: 'project', importance: 5,
      content: `Backend step ${n}: a failed call after a transient error is retried exactly as before by depot sync ${n}, which surfaces the choice when it fails again.` });
    rememberFact({ kind: 'project', importance: 5,
      content: `Visible answer ${n}: a completed turn that produced no reply for the user is answered again as plain text, stating the actual result and evidence (desk ${n}).` });
  }
}

// Regression: a retry of the same request (the host's quiet re-attempt after
// a transient model failure) once ranked the request's memory by the host's
// own retry directive, so the retry lost the fact its request carries and was
// shown unrelated memory instead. The runner is the only stand-in: the
// conversation loop, the turn, its memory and its model-input filter are the
// production ones, and the filter's output is what the model would receive.
test('a retry of the same request ranks its memory by the request, not the host directive', async () => {
  rememberDirectiveLookalikes();
  const session = eventlog.createSession({ kind: 'chat' });
  const request = 'List my priority accounts in the quokka ledger and draft a client note to each.';
  const sent: string[] = [];
  let calls = 0;
  const agent = { instructions: harnessInstructions('Answer the request.', { sessionId: session.id, focusInput: request }) };
  const result = await runConversation({
    sessionId: session.id, input: request, judgeCompletion: false,
    agent: agent as never,
    makeRunner: () => new EventEmitter() as never,
    maxTurns: 4, toolCallsPerTurn: 3, suppressMemoryCapture: true,
    runRunner: async (_runner, _agent, items, opts) => {
      calls += 1;
      if (calls === 1) {
        throw BoundaryError.from(new Error('backend 529 overloaded'), {
          kind: 'model.overloaded', retryable: true, userMessage: 'The model runtime is temporarily unavailable.',
        });
      }
      sent.push(modelRequest(agent, items, opts));
      return { history: items, lastResponseId: undefined,
        finalOutput: { summary: 'Listed them.', reply: 'Here are the priority accounts.', done: true, nextAction: 'completed', reason: null } };
    },
  });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(eventlog.listEvents(session.id, { types: ['infra_auto_recover'] }).length, 1,
    'the second activation is the host\'s retry of the same request');
  const primers = eventlog.listEvents(session.id, { types: ['turn_memory_primer'] }).map((event) => event.data as Record<string, unknown>);
  assert.equal(primers.length, 2, 'one primer per activation');
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /Account\.Priority_Account__c is true/, 'the retry carries the request\'s fact');
  assert.match(String(primers[1]!.queryPreview), /quokka ledger/, 'the retry ranks memory by the accepted request');
});

/** A request parked on an approval card, resumed through the production
 *  resume wrapper and its continuation loop. The runner is the only stand-in:
 *  the resume, the continuation's turn, its memory and its model-input filter
 *  are the production ones. The resumed step completes with no reply, so the
 *  host re-asks with its own directive as a later step of the same request. */
async function resumedReask(label: string, options: { answerBySource: boolean; memoryPrimerQuery?: string }) {
  rememberDirectiveLookalikes();
  const request = `Which accounts count as priority in the quokka ledger for the ${label} renewal review?`;
  const session = eventlog.createSession({ kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: request } });
  // A resume agent is built without the request as its focus.
  const agent = new Agent({ name: `ResumedRequestMemory-${label}`, instructions: harnessInstructions('Answer the request.', { sessionId: session.id }) });
  const state = new RunState(new RunContext({}), request, agent, null).toJSON() as Record<string, unknown>;
  state.currentStep = { type: 'next_step_interruption', data: { interruptions: [{
    rawItem: { type: 'function_call', name: 'composio_execute_tool', callId: 'c1', arguments: JSON.stringify({ tool_slug: 'X', arguments: '{}' }) },
    toolName: 'composio_execute_tool',
  }] } };
  HarnessSession.load(session.id)!.saveInterruptState(JSON.stringify(state));
  const card = approvals.register({ sessionId: session.id, subject: 'one draft', tool: 'composio_execute_tool', args: { tool_slug: 'X', arguments: '{}' } });
  const sent: string[] = [];
  let calls = 0;
  const result = await runConversationFromResume({
    agent, sessionId: session.id, decision: 'approve', resolver: 'memory-continuation',
    // Answered in chat, the request's own source accepts the answer; answered
    // by the card's button, the runtime records a control edge for it.
    ...(options.answerBySource ? { sourceUserSeq: source.seq } : { approvalId: card.approvalId }),
    ...(options.memoryPrimerQuery ? { memoryPrimerQuery: options.memoryPrimerQuery } : {}),
    makeRunner: () => new EventEmitter() as never,
    runRunner: async (_runner, _agent, items, opts) => {
      calls += 1;
      // The first call resumes the parked run state; the re-ask is a turn.
      sent.push(Array.isArray(items) ? modelRequest(agent, items, opts) : '');
      return { history: Array.isArray(items) ? items : [], lastResponseId: undefined, finalOutput: calls === 1
        ? { done: true, nextAction: 'completed', reply: null, summary: 'Resumed the approval.', reason: null }
        : { done: true, nextAction: 'completed', reply: 'Here are the priority accounts.', summary: 'Listed them.', reason: null } };
    },
  });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(calls, 2, 'the resumed step and the host\'s re-ask');
  assert.ok(eventlog.listEvents(session.id, { types: ['guardrail_tripped'] })
    .some((event) => (event.data as { kind?: string; path?: string }).kind === 'completed_without_reply'
      && (event.data as { path?: string }).path === 'resume'), 'the second step is the host\'s re-ask on the resume path');
  const primers = eventlog.listEvents(session.id, { types: ['turn_memory_primer'] }).map((event) => event.data as Record<string, unknown>);
  assert.equal(primers.length, 2, 'the resumed step and the re-ask each record their memory');
  return { reask: sent[1]!, primer: primers[1]!, resumedPrimer: primers[0]! };
}

// Regression: after the owner answers a card, a later step of the resumed
// request (the host re-asking for the reply the resumed step did not give)
// once ranked the request's memory by the host's directive and lost the
// request's fact.
test('a later step of a resumed request ranks its memory by the request, not the host directive', async () => {
  const { reask, primer } = await resumedReask('request', { answerBySource: true });
  assert.match(reask, /Account\.Priority_Account__c is true/, 'the re-ask carries the request\'s fact');
  assert.match(String(primer.queryPreview), /quokka ledger/, 'the re-ask ranks memory by the accepted request');
});

// A workflow step resumed after its card keeps searching by its own memory
// query on every later step, as its first activation did.
test('a later step of a resumed workflow step ranks its memory by the step\'s memory query', async () => {
  const { primer } = await resumedReask('workflow-query', { answerBySource: true, memoryPrimerQuery: 'Priority accounts in the quokka ledger' });
  assert.equal(primer.queryPreview, 'Priority accounts in the quokka ledger', 'the re-ask ranks memory by the step\'s own query');
});

// A card answered by its button is accepted by a source the runtime records,
// whose text is not a request. On this legacy runner seam the parked run state
// names no request of its own (only the host path restores the parked source
// the card belongs to), so the resumed step and the re-ask have no request
// text to rank by: they carry the per-block rendering the prompt carried, not
// a ranking of the control text or of the host's directive. The host path's
// button answer, which ranks by the parked request, is pinned in
// host-direct-write.integration.test.ts.
test('a later step of a resumed request accepted by a control edge is not ranked by the host directive', async () => {
  const { reask, primer, resumedPrimer } = await resumedReask('control-edge', { answerBySource: false });
  assert.equal(resumedPrimer.skippedReason, 'empty_input', `the resumed step is not ranked by the control text: ${JSON.stringify(resumedPrimer)}`);
  assert.equal(primer.skippedReason, 'empty_input', `the ranker is not run on a directive: ${JSON.stringify(primer)}`);
  assert.doesNotMatch(reask, /## Relevant To This Request/, 'no ranked tail about the directive');
  assert.match(reask, /## Persistent Facts/, 'the per-block memory stands in');
});
