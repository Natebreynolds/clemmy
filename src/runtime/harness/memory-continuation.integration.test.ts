/**
 * The memory a request carries survives the host's own continuations.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/memory-continuation.integration.test.ts
 *
 * A frame larger than the per-activation tool ceiling makes the conversation
 * runner re-enter the SAME accepted source in a fresh activation, with the
 * memory ranker held back. That hold is the runtime's, not the owner's: the
 * resumed activation must see the request's remembered facts as the first
 * one did. Only a request that itself declined memory keeps it declined.
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
const { runConversationContinuingPastToolCallsLimit: runConversation } = await import('./loop.js');
const memoryDatabase = await import('../../memory/db.js');

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

async function ceilingRun(label: string, request: string) {
  const session = eventlog.createSession({ kind: 'chat' });
  const tool = taskList();
  const model = recordingModel([
    [1, 2, 3, 4, 5].map((n) => functionCall(`${label}-${n}`, 'task_list')),
    [4, 5].map((n) => functionCall(`${label}-${n}-again`, 'task_list')),
    [done('Done.')],
  ]);
  // The instructions are the production harness composition, so the turn
  // carries the memory core in its prefix and memory after the boundary.
  const agent = {
    model,
    instructions: harnessInstructions('Use the exact configured tool.', { sessionId: session.id, focusInput: request }),
    tools: [tool],
  };
  const sealed = envelopes.sealAgentCapabilityUniverse({
    sessionId: session.id, universeTools: [tool], activeToolNames: ['task_list'],
    policyHash: `memory-continuation-${label}`,
    budget: { maxUncachedTokens: 1_000, maxModelCalls: 16, maxToolCalls: 64, maxElapsedMs: 20_000 },
  });
  if (!sealed.ok) throw new Error(sealed.errors.join('; '));
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
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

test('a request that declined memory stays declined when it resumes', async () => {
  const { requests, primers } = await ceilingRun('declined',
    'Do not use memory for this request. List my priority accounts in the quokka ledger.');
  assert.deepEqual(primers.map((primer) => primer.skippedReason), ['explicit_request_opt_out', 'explicit_request_opt_out']);
  for (const request of requests) {
    assert.equal(request.includes('Priority_Account__c'), false, 'no remembered fact on a declined request');
    assert.equal(request.includes('Invoices are reviewed on Tuesdays'), false, 'no remembered fact on a declined request');
  }
});
