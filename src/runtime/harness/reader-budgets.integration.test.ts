/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/reader-budgets.integration.test.ts
 *
 * What a retained-output reader puts into the prompt. Real host_v1 runner,
 * real brackets and the real registered reader handlers; the fake model only
 * records the requests it is sent, so every assertion reads the function
 * result text the model actually received on its next request.
 *
 * - A bare reader call returns one inline result for the routed window, the
 *   same as a bare recall, and names the exact next call; a larger reply is
 *   the caller's explicit ask.
 * - Structured query bytes are charged to the turn's RecallBudget like recall
 *   bytes, so the per-turn byte cap holds whichever reader the model uses.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-reader-budgets-'));
process.env.CLEMENTINE_HOME = home;
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(home, 'state'), { recursive: true });

const events = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const envelopes = await import('../../agents/capability-envelope.js');
const inner = await import('../../tools/inner-dispatch.js');
const { getLocalRuntimeTools } = await import('../../tools/local-runtime-tools.js');
const { hostRunRunner } = await import('./host-turn-runner.js');
const {
  DEFAULT_TOOL_RESULT_MAX_CHARS, MCP_TRANSPORT_MAX_CHARS, PROMPT_INLINE_RECALLABLE_RESULT_CHARS,
  inlineResultBudgetForModel, retainedReaderMaxChars,
} = await import('./tool-output-format.js');
const { recordCatalogWindow, recordWindowRejection } = await import('./model-window-observations.js');

after(() => {
  inner._setInnerDispatchToolsForTests(null);
  events.closeEventLog();
  rmSync(home, { recursive: true, force: true });
});

let serial = 0;

/** Drive one real host_v1 turn. The fake model emits `calls` one per request
 * and then answers; returns the text of each tool result it was sent. */
async function runHostTurn(input: {
  agentTool: unknown;
  toolName: string;
  calls: Array<{ callId: string; args: Record<string, unknown>; tool?: string }>;
  /** Further registered local tools the model may call by name. */
  extraTools?: string[];
  routedModelId?: string;
  seed?: (sessionId: string) => void;
  recallBudget?: InstanceType<typeof brackets.RecallBudget>
    | ((sessionId: string) => InstanceType<typeof brackets.RecallBudget>);
}): Promise<{ results: Map<string, string>; sessionId: string }> {
  serial += 1;
  const session = events.createSession({ id: `sess-reader-budgets-${serial}`, kind: 'chat' });
  const text = 'Read the fixture result and report what it holds.';
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  input.seed?.(session.id);
  const requests: unknown[] = [];
  const model = {
    async *getStreamedResponse(request: unknown) {
      const response = await this.getResponse(request);
      yield { type: 'response_started' };
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } };
    },
    async getResponse(request: unknown) {
      requests.push(request);
      const next = input.calls[requests.length - 1];
      return {
        responseId: `response-${requests.length}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: next
          ? [{ type: 'function_call', callId: next.callId, name: next.tool ?? input.toolName, arguments: JSON.stringify(next.args) }]
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Read.' }] }],
      };
    },
  };
  const tools = [input.agentTool, ...(input.extraTools ?? []).map(realLocalTool)];
  const agent = { model, tools };
  const sealed = envelopes.sealAgentCapabilityUniverse({
    sessionId: session.id, universeTools: tools as never[], activeToolNames: [input.toolName, ...(input.extraTools ?? [])],
    policyHash: `reader-budgets-${serial}`,
    budget: { maxUncachedTokens: 100000, maxModelCalls: 6, maxToolCalls: 6, maxElapsedMs: 60000 },
  });
  assert.ok(sealed.ok, JSON.stringify(sealed));
  if (!sealed.ok) throw new Error('unsealed');
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const runner = Object.assign(new EventEmitter(), { run() { throw new Error('legacy runner forbidden'); } });
  const outcome = await brackets.withHarnessRunContext({
    sessionId: session.id, sourceUserSeq: source.seq,
    counter: new brackets.ToolCallsCounter(6), behaviorScopeId: `${session.id}::turn:1`,
    recallBudget: typeof input.recallBudget === 'function'
      ? input.recallBudget(session.id)
      : input.recallBudget ?? new brackets.RecallBudget(10, 500_000, session.id),
    ...(input.routedModelId ? { routedModelId: input.routedModelId } : {}),
  }, () => hostRunRunner(runner as never, agent as never, [{ role: 'user', content: text }] as never, {
    maxTurns: 6, hostTurnEngine: 'host_v1', context: { sessionId: session.id, sourceUserSeq: source.seq },
  } as never));
  assert.equal(outcome.finalOutput, 'Read.', JSON.stringify(outcome.terminal));
  const results = new Map<string, string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const item = value as { type?: unknown; callId?: unknown; output?: unknown };
    if (item.type === 'function_call_result' && typeof item.callId === 'string') {
      const output = item.output as { text?: unknown } | string;
      results.set(item.callId, typeof output === 'string' ? output : String(output?.text ?? ''));
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(requests.at(-1));
  return { results, sessionId: session.id };
}

function realLocalTool(name: string) {
  const found = getLocalRuntimeTools().find((candidate) => candidate.name === name);
  assert.ok(found, `${name} is a registered local tool`);
  return brackets.wrapToolForHarness(found as never);
}

/** Park an output the way a real call leaves it: its call, its bytes, its return. */
function parkOutput(sessionId: string, callId: string, output: string, tool = 'run_shell_command') {
  const called = events.appendEvent({ sessionId, turn: 1, role: 'agent', type: 'tool_called', data: { callId, tool, arguments: '{}' } });
  events.writeToolOutput({ sessionId, callId, tool, output });
  events.appendEvent({ sessionId, turn: 1, role: 'agent', type: 'tool_returned', parentEventId: called.id, data: { callId, tool, ok: true } });
}

/** 50 numbered ~1k text blocks: any dropped span is visible by block number. */
const PARKED_TEXT = Array.from({ length: 50 }, (_, i) => `[block ${String(i).padStart(2, '0')}] ${'r'.repeat(988)}`).join('\n');

test('a bare tool_output_query on text returns one inline result, exactly as a bare recall does', async () => {
  const { results } = await runHostTurn({
    agentTool: realLocalTool('tool_output_query'), toolName: 'tool_output_query',
    seed: (sessionId) => parkOutput(sessionId, 'parked-text', PARKED_TEXT),
    calls: [{ callId: 'text-query', args: { call_id: 'parked-text' } }],
  });
  const shown = results.get('text-query') ?? '';
  const inline = inlineResultBudgetForModel(undefined);
  assert.match(shown, /is text, not structured records/);
  assert.ok(shown.includes(`Recalled chars 0–${inline} of ${PARKED_TEXT.length}`),
    `one inline result, not the recall ceiling (${shown.slice(0, 240)} … ${shown.length} chars)`);
  assert.ok(shown.includes(`recall_tool_result {"call_id":"parked-text","offset":${inline}}`), 'the exact next page');
  assert.ok(shown.endsWith(PARKED_TEXT.slice(0, inline)), 'the whole slice reaches the model');
});

test('on a small window a bare text query shrinks to that window\'s inline result', async () => {
  const smallWindowModel = 'fixture-reader-small-window';
  recordWindowRejection(smallWindowModel, 32_001);
  const inline = inlineResultBudgetForModel(smallWindowModel);
  assert.equal(inline, 11_200);
  const { results } = await runHostTurn({
    agentTool: realLocalTool('tool_output_query'), toolName: 'tool_output_query', routedModelId: smallWindowModel,
    seed: (sessionId) => parkOutput(sessionId, 'parked-text', PARKED_TEXT),
    calls: [{ callId: 'small-text-query', args: { call_id: 'parked-text' } }],
  });
  const shown = results.get('small-text-query') ?? '';
  assert.ok(shown.includes(`Recalled chars 0–${inline} of ${PARKED_TEXT.length}`), `${shown.slice(0, 240)} (${shown.length} chars)`);
  assert.ok(shown.length < inline + 1_000, `bounded by the window (got ${shown.length})`);
});

/** 60 records of ~1.5k chars each, parked under one call id. */
const PARKED_ROWS = JSON.stringify(Array.from({ length: 60 }, (_, i) => ({
  id: `row-${String(i).padStart(2, '0')}`,
  name: `Fixture record ${i}`,
  notes: `note ${i} `.repeat(150),
})));
const parkRows = (sessionId: string) => parkOutput(sessionId, 'parked-rows', PARKED_ROWS);

test('a bare tool_output_query on records is one inline result, cut on a record boundary with the exact next query', async () => {
  const { results } = await runHostTurn({
    agentTool: realLocalTool('tool_output_query'), toolName: 'tool_output_query', seed: parkRows,
    calls: [{ callId: 'bare-rows', args: { call_id: 'parked-rows' } }],
  });
  const shown = results.get('bare-rows') ?? '';
  const inline = inlineResultBudgetForModel(undefined);
  assert.ok(shown.length <= inline, `a bare query is one inline result (got ${shown.length} chars, budget ${inline})`);
  const header = /^Showing (\d+) record\(s\) \[0–(\d+)\] of 60 matching/.exec(shown);
  assert.ok(header, shown.slice(0, 200));
  const count = Number(header[1]);
  assert.ok(count > 0 && count < 50, `a partial page (${count} records)`);
  assert.ok(shown.includes(`"id": "row-${String(count - 1).padStart(2, '0')}"`), 'the last counted record is shown whole');
  assert.ok(!shown.includes(`"id": "row-${String(count).padStart(2, '0')}"`), 'no record past the count');
  assert.ok(shown.includes(`Next: tool_output_query {"call_id":"parked-rows","offset":${count}}`), 'the exact next query');
});

test('a named page or projection may run past one inline result, up to the query bound', async () => {
  const { results } = await runHostTurn({
    agentTool: realLocalTool('tool_output_query'), toolName: 'tool_output_query', seed: parkRows,
    calls: [{ callId: 'named-page', args: { call_id: 'parked-rows', limit: 20 } }],
  });
  const shown = results.get('named-page') ?? '';
  assert.match(shown, /^Showing 20 record\(s\) \[0–20\] of 60 matching/);
  assert.ok(shown.length > inlineResultBudgetForModel(undefined), `the named page is returned whole (${shown.length} chars)`);
});

test('bare query replies spend the turn\'s reading bytes; named pages page on uncharged, and a spent budget routes a bare query away', async () => {
  const budget = new brackets.RecallBudget(10, 26_000, undefined);
  const { results } = await runHostTurn({
    agentTool: realLocalTool('tool_output_query'), toolName: 'tool_output_query', seed: parkRows, recallBudget: budget,
    calls: [
      { callId: 'spend-first', args: { call_id: 'parked-rows' } },
      { callId: 'named-page', args: { call_id: 'parked-rows', limit: 50, offset: 10 } },
      { callId: 'spend-second', args: { call_id: 'parked-rows', offset: 20 } },
      { callId: 'spend-third', args: { call_id: 'parked-rows', offset: 40 } },
      { callId: 'named-after', args: { call_id: 'parked-rows', limit: 5, offset: 55 } },
    ],
  });
  const first = results.get('spend-first') ?? '';
  const named = results.get('named-page') ?? '';
  const second = results.get('spend-second') ?? '';
  const third = results.get('spend-third') ?? '';
  const namedAfter = results.get('named-after') ?? '';
  assert.match(first, /^Showing \d+ record/);
  assert.match(named, /^Showing \d+ record\(s\) \[10–\d+\]/, 'a named page is served up to its own reply bound, uncharged');
  assert.match(second, /^Showing \d+ record/, second.slice(0, 300));
  const charged = [first, second, third].filter((reply) => /^Showing/.test(reply))
    .reduce((sum, reply) => sum + Buffer.byteLength(reply), 0);
  assert.ok(charged <= 26_000, `bare replies fit the turn's byte budget (${charged} bytes)`);
  assert.equal(budget.snapshot().bytes, charged, 'only bare replies were charged');
  assert.equal(budget.snapshot().calls, 0, 'a query spends bytes, never a recall call');
  if (!/^Showing/.test(third)) {
    assert.match(third, /^ERROR: reading byte budget exhausted/, third.slice(0, 300));
    assert.doesNotMatch(third, /recall_tool_result \{/, 'never routed to a reader the budget refuses');
  }
  assert.match(namedAfter, /^Showing 5 record\(s\) \[55–60\]/, 'a named page is served even after the bytes are spent');
});

test('on a small window an explicit recall and a named query page stay within what the window can take', async () => {
  const smallWindowModel = 'fixture-reader-small-window';
  recordWindowRejection(smallWindowModel, 32_001);
  const readerMax = retainedReaderMaxChars(smallWindowModel);
  assert.equal(readerMax, 11_200, 'a 32k-token window takes one inline result per reader reply');
  const recall = await runHostTurn({
    agentTool: realLocalTool('recall_tool_result'), toolName: 'recall_tool_result', routedModelId: smallWindowModel,
    seed: (sessionId) => parkOutput(sessionId, 'parked-text', PARKED_TEXT),
    calls: [{ callId: 'small-explicit-recall', args: { call_id: 'parked-text', max_chars: 30_000 } }],
  });
  const recalled = recall.results.get('small-explicit-recall') ?? '';
  assert.ok(recalled.startsWith(`Recalled chars 0–${readerMax} of ${PARKED_TEXT.length}`), `${recalled.slice(0, 200)} (${recalled.length} chars)`);
  assert.ok(recalled.includes(`recall_tool_result {"call_id":"parked-text","offset":${readerMax}}`), 'the exact next page');
  assert.ok(recalled.endsWith(PARKED_TEXT.slice(0, readerMax)), 'the whole slice reaches the model, never re-clipped');

  const query = await runHostTurn({
    agentTool: realLocalTool('tool_output_query'), toolName: 'tool_output_query', routedModelId: smallWindowModel, seed: parkRows,
    calls: [{ callId: 'small-named-page', args: { call_id: 'parked-rows', limit: 50 } }],
  });
  const page = query.results.get('small-named-page') ?? '';
  assert.ok(page.length <= readerMax, `a named page fits the window's reader bound (${page.length} chars)`);
  const header = /^Showing (\d+) record\(s\) \[0–(\d+)\]/.exec(page);
  assert.ok(header, page.slice(0, 200));
  assert.ok(page.includes(`Next: tool_output_query {"call_id":"parked-rows","limit":50,"offset":${header[1]}}`), 'the exact next query');
});

test('on a large window an explicit recall is bounded by what the MCP wire carries whole, never re-clipped', async () => {
  const largeWindowModel = 'fixture-reader-large-window';
  recordCatalogWindow(largeWindowModel, 1_000_000, 'fixture');
  const readerMax = retainedReaderMaxChars(largeWindowModel);
  assert.ok(readerMax < MCP_TRANSPORT_MAX_CHARS, `room for the reader frame (${readerMax})`);
  const large = Array.from({ length: 150 }, (_, i) => `[block ${String(i).padStart(3, '0')}] ${'r'.repeat(987)}`).join('\n');
  const { results } = await runHostTurn({
    agentTool: realLocalTool('recall_tool_result'), toolName: 'recall_tool_result', routedModelId: largeWindowModel,
    seed: (sessionId) => parkOutput(sessionId, 'parked-large', large),
    calls: [{ callId: 'large-explicit-recall', args: { call_id: 'parked-large', max_chars: 120_000 } }],
  });
  const shown = results.get('large-explicit-recall') ?? '';
  assert.ok(shown.length <= MCP_TRANSPORT_MAX_CHARS, `one reply fits the MCP wire (${shown.length} chars)`);
  assert.ok(shown.startsWith(`Recalled chars 0–${readerMax} of ${large.length}`), shown.slice(0, 200));
  assert.ok(shown.includes(`"offset":${readerMax}`), 'the exact next page');
  assert.ok(shown.endsWith(large.slice(0, readerMax)), 'the whole slice reaches the model');
});

test('a direct business-role local tool keeps the projection its own handler formatted', async () => {
  // table_ops formats its own reply (textResult) from the exact bytes of a
  // result larger than one inline result; the bracket must not rebuild a
  // smaller view of the same bytes for a direct call.
  const rows = Array.from({ length: 20 }, (_, i) => ({
    id: `r${i}`, email: `person${i}@example.test`, notes: `detail ${i} `.repeat(160),
  }));
  const { results } = await runHostTurn({
    agentTool: realLocalTool('table_ops'), toolName: 'table_ops',
    calls: [{ callId: 'direct-table', args: { op: 'select', left_rows: JSON.stringify(rows), limit: 20 } }],
  });
  const shown = results.get('direct-table') ?? '';
  assert.ok(shown.length > PROMPT_INLINE_RECALLABLE_RESULT_CHARS,
    `the handler's own projection reaches the model, not the 4,000-char view (got ${shown.length})`);
  assert.ok(shown.length <= DEFAULT_TOOL_RESULT_MAX_CHARS, `bounded by one inline result (got ${shown.length})`);
  assert.ok(shown.includes('"id":"r0"'), 'the projection carries the records');
});

test('an object query is sized to the reading bytes the turn has left and served, never refused for its own clip marker', async () => {
  const budget = new brackets.RecallBudget(10, 10_000, undefined);
  const { results } = await runHostTurn({
    agentTool: realLocalTool('tool_output_query'), toolName: 'tool_output_query', recallBudget: budget,
    seed: (sessionId) => parkOutput(sessionId, 'parked-object', JSON.stringify({ body: 'x'.repeat(30_000), meta: 1 })),
    calls: [{ callId: 'object-remainder', args: { call_id: 'parked-object' } }],
  });
  const shown = results.get('object-remainder') ?? '';
  assert.match(shown, /^Object \(2 top-level keys\)/, shown.slice(0, 300));
  assert.match(shown, /…\[clipped to \d+ chars — narrow with fields/);
  assert.ok(Buffer.byteLength(shown, 'utf8') <= 10_000, `within the remaining bytes (${Buffer.byteLength(shown, 'utf8')})`);
  assert.equal(budget.snapshot().bytes, Buffer.byteLength(shown, 'utf8'), 'the served reply is what was charged');
});

test('a non-ASCII bare record page is cut on a record boundary to the bytes left, with the exact next query', async () => {
  const budget = new brackets.RecallBudget(10, 40_000, undefined);
  const rows = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ id: `row-${i}`, notes: '中文记录'.repeat(300) })));
  const { results } = await runHostTurn({
    agentTool: realLocalTool('tool_output_query'), toolName: 'tool_output_query', recallBudget: budget,
    seed: (sessionId) => parkOutput(sessionId, 'parked-wide', rows),
    calls: [{ callId: 'wide-page', args: { call_id: 'parked-wide' } }],
  });
  const shown = results.get('wide-page') ?? '';
  const header = /^Showing (\d+) record\(s\) \[0–(\d+)\] of 40 matching/.exec(shown);
  assert.ok(header, shown.slice(0, 300));
  const count = Number(header[1]);
  assert.ok(count > 0 && count < 40, `a partial page (${count} records)`);
  assert.ok(shown.includes(`"id": "row-${count - 1}"`) && !shown.includes(`"id": "row-${count}"`), 'cut on a record boundary');
  assert.ok(shown.includes(`Next: tool_output_query {"call_id":"parked-wide","offset":${count}}`), 'the exact next query');
  assert.ok(Buffer.byteLength(shown, 'utf8') <= 40_000, `within the remaining bytes (${Buffer.byteLength(shown, 'utf8')})`);
});

test('a record larger than the whole reply is clipped inside the bound and still names the exact next query', async () => {
  const rows = JSON.stringify(Array.from({ length: 3 }, (_, i) => ({ id: `big-${i}`, notes: 'y'.repeat(30_000) })));
  const { results } = await runHostTurn({
    agentTool: realLocalTool('tool_output_query'), toolName: 'tool_output_query',
    seed: (sessionId) => parkOutput(sessionId, 'parked-big', rows),
    calls: [{ callId: 'big-record', args: { call_id: 'parked-big' } }],
  });
  const shown = results.get('big-record') ?? '';
  const inline = inlineResultBudgetForModel(undefined);
  assert.match(shown, /^Showing 1 record\(s\) \[0–1\] of 3 matching/);
  assert.match(shown, /…\[clipped to \d+ chars — narrow with fields/);
  assert.ok(shown.length <= inline, `within one inline result (got ${shown.length}, budget ${inline})`);
  assert.ok(shown.includes('Next: tool_output_query {"call_id":"parked-big","offset":1}'), 'the exact next query survives the clip');
});

test('a recall refused for bytes never routes to a query the same byte budget would refuse', async () => {
  const { results } = await runHostTurn({
    agentTool: realLocalTool('recall_tool_result'), toolName: 'recall_tool_result', seed: parkRows,
    recallBudget: (sessionId) => new brackets.RecallBudget(10, 900, sessionId),
    calls: [{ callId: 'recall-spent', args: { call_id: 'parked-rows' } }],
  });
  const shown = results.get('recall-spent') ?? '';
  assert.match(shown, /^ERROR: recall byte budget exhausted/, shown.slice(0, 300));
  assert.match(shown, /file_query \{"call_id":"parked-rows"/, shown);
  assert.doesNotMatch(shown, /tool_output_query \{/, 'the query would refuse: fewer than one minimal reply of bytes remain');
});

test('a recall refused for calls with its bytes spent too never routes to the query either', async () => {
  const { results } = await runHostTurn({
    agentTool: realLocalTool('recall_tool_result'), toolName: 'recall_tool_result', seed: parkRows,
    recallBudget: (sessionId) => new brackets.RecallBudget(1, 1_050, sessionId),
    calls: [
      { callId: 'recall-small', args: { call_id: 'parked-rows', max_chars: 100 } },
      { callId: 'recall-over', args: { call_id: 'parked-rows', max_chars: 100 } },
    ],
  });
  assert.match(results.get('recall-small') ?? '', /^Recalled chars 0–100/);
  const shown = results.get('recall-over') ?? '';
  assert.match(shown, /^ERROR: recall budget exhausted this turn \(max 1 calls\)/, shown.slice(0, 300));
  assert.match(shown, /file_query \{"call_id":"parked-rows"/, shown);
  assert.doesNotMatch(shown, /tool_output_query \{/, shown);
});

test('while a minimal query reply still fits, a recall refused for bytes names the query, and that query is served', async () => {
  const { results } = await runHostTurn({
    agentTool: realLocalTool('recall_tool_result'), toolName: 'recall_tool_result', seed: parkRows,
    extraTools: ['tool_output_query'],
    recallBudget: (sessionId) => new brackets.RecallBudget(10, 2_000, sessionId),
    calls: [
      { callId: 'recall-too-big', args: { call_id: 'parked-rows' } },
      { callId: 'named-query', tool: 'tool_output_query', args: { call_id: 'parked-rows' } },
    ],
  });
  const refused = results.get('recall-too-big') ?? '';
  assert.match(refused, /^ERROR: recall byte budget exhausted/, refused.slice(0, 300));
  assert.ok(refused.includes('tool_output_query {"call_id":"parked-rows"}'), refused);
  const served = results.get('named-query') ?? '';
  assert.match(served, /^Showing 1 record\(s\) \[0–1\] of 60 matching/, served.slice(0, 300));
  assert.ok(Buffer.byteLength(served, 'utf8') <= 2_000, `within the bytes left (${Buffer.byteLength(served, 'utf8')})`);
});

test('a projection is served whole whatever the reading bytes left, and is not charged', async () => {
  const budget = new brackets.RecallBudget(10, 1_200, undefined);
  const fields = ['id', ...Array.from({ length: 41 }, (_, i) => `absent_field_with_a_rather_long_descriptive_name_${String(i).padStart(2, '0')}`)];
  const { results } = await runHostTurn({
    agentTool: realLocalTool('tool_output_query'), toolName: 'tool_output_query', seed: parkRows, recallBudget: budget,
    calls: [{ callId: 'wide-projection', args: { call_id: 'parked-rows', fields } }],
  });
  const shown = results.get('wide-projection') ?? '';
  assert.match(shown, /^Showing 50 record\(s\) \[0–50\] of 60 matching/, shown.slice(0, 300));
  assert.equal(budget.snapshot().bytes, 0, 'a named projection spends no reading bytes');
});

/** 20 records of ~3k chars each: no single record fits a small byte budget. */
const WIDE_ROWS = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ id: i, body: `[row ${String(i).padStart(2, '0')}] ${'w'.repeat(3_000)}` })));
const parkWideRows = (sessionId: string) => parkOutput(sessionId, 'parked-wide-rows', WIDE_ROWS);

test('a clipped bare record page always shows the record it continues from, or no record and the same offset', async () => {
  for (const bytesLeft of [900, 1_400, 2_400]) {
    const budget = new brackets.RecallBudget(10, bytesLeft, undefined);
    const { results } = await runHostTurn({
      agentTool: realLocalTool('tool_output_query'), toolName: 'tool_output_query', seed: parkWideRows, recallBudget: budget,
      calls: [{ callId: `wide-${bytesLeft}`, args: { call_id: 'parked-wide-rows' } }],
    });
    const shown = results.get(`wide-${bytesLeft}`) ?? '';
    const header = /^Showing (\d+) record\(s\)/.exec(shown);
    assert.ok(header || shown.startsWith('ERROR:'), shown.slice(0, 300));
    if (!header) continue;
    if (Number(header[1]) === 0) {
      assert.doesNotMatch(shown, /"offset":1\b/, `no record shown, so nothing is skipped (${bytesLeft}): ${shown.slice(0, 400)}`);
      assert.match(shown, /same offset/);
    } else {
      assert.match(shown, /\[row 00\] w{150}/, `a real slice of record 0 is shown beside its continuation (${bytesLeft}): ${shown.slice(0, 400)}`);
    }
    assert.ok(Buffer.byteLength(shown, 'utf8') <= bytesLeft, `within the bytes left (${Buffer.byteLength(shown, 'utf8')} of ${bytesLeft})`);
  }
});
