/** Exact retained JSON selection through the real reader and scoped store. */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-retained-path-'));
process.env.CLEMENTINE_HOME = fixtureHome;
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });

const { registerRecallTools } = await import('./recall-tools.js');
const { closeEventLog, createSession, getToolOutput, openEventLog, writeToolOutput, appendEvent } =
  await import('../runtime/harness/eventlog.js');
const { RecallBudget, ToolCallsCounter, withHarnessRunContext } =
  await import('../runtime/harness/brackets.js');
const { inlineResultBudgetForModel, retainedReaderMaxChars } =
  await import('../runtime/harness/tool-output-format.js');

type QueryHandler = (input: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
let query: QueryHandler | undefined;
registerRecallTools({
  tool: (name: string, _description: string, _schema: unknown, handler: QueryHandler) => {
    if (name === 'tool_output_query') query = handler;
  },
} as Parameters<typeof registerRecallTools>[0]);
assert.ok(query);
const retainedQuery = query;

function park(value: unknown, tool = 'work_call') {
  const session = createSession({ kind: 'chat' });
  const callId = 'fixture-retained-path';
  const output = JSON.stringify(value);
  writeToolOutput({ sessionId: session.id, callId, tool, output });
  return { sessionId: session.id, callId, output };
}

async function read(sessionId: string, args: Record<string, unknown>, recallBudget?: InstanceType<typeof RecallBudget>) {
  const result = await withHarnessRunContext({
    sessionId, turn: 1, counter: new ToolCallsCounter(200), ...(recallBudget ? { recallBudget } : {}),
  }, () => retainedQuery(args));
  assert.equal(result.content.length, 1);
  return result.content[0].text;
}

function shownRows(text: string): Array<Record<string, unknown>> {
  const json = text.split('\n\n').find(block => block.startsWith('[\n') || block === '[]');
  assert.ok(json, `No record page in ${text.slice(0, 400)}`);
  return JSON.parse(json) as Array<Record<string, unknown>>;
}

test.after(() => {
  closeEventLog();
  rmSync(fixtureHome, { recursive: true, force: true });
});

test('an exact small subtree wins over a larger unrelated record array without changing the stored bytes', async () => {
  const fixture = park({
    records: Array.from({ length: 80 }, (_, i) => ({ id: `audit-${i}`, state: 'irrelevant' })),
    workflow: { runs: [{ steps: [{ evidence: { checks: [{ id: 'decisive', state: 'failed' }] } }] }] },
  });
  const selected = '/workflow/runs/0/steps/0/evidence/checks';
  const result = await read(fixture.sessionId, { call_id: fixture.callId, path: selected, fields: ['id', 'state'] });
  assert.deepEqual(shownRows(result), [{ id: 'decisive', state: 'failed' }]);
  assert.match(result, /1 matching/);
  assert.ok(result.includes(`path=${JSON.stringify(selected)}`));
  assert.match(result, /not a fresh provider read/);
  assert.doesNotMatch(result, /audit-0|\$fromToolOutput/);
  assert.equal(getToolOutput(fixture.sessionId, fixture.callId)?.output, fixture.output);
  const legacy = await read(fixture.sessionId, { call_id: fixture.callId, fields: ['id'], limit: 2 });
  assert.deepEqual(shownRows(legacy).map(row => row.id), ['audit-0', 'audit-1']);
});

test('selected objects and explicit root never silently unwrap their own larger arrays', async () => {
  const fixture = park({
    workflow: { title: 'Exact workflow', steps: [{ id: 'step-1' }, { id: 'step-2' }] },
    audit: Array.from({ length: 20 }, (_, i) => ({ id: `other-${i}` })),
  });
  const object = await read(fixture.sessionId, { call_id: fixture.callId, path: '/workflow', fields: ['title', 'steps'] });
  assert.match(object, /Object \(2 top-level keys\)/);
  assert.match(object, /Exact workflow/);
  assert.match(object, /step-2/);
  assert.doesNotMatch(object, /other-|Showing|\$fromToolOutput/);
  const root = await read(fixture.sessionId, { call_id: fixture.callId, path: '', fields: ['workflow.title'] });
  assert.match(root, /"workflow.title": "Exact workflow"/);
  assert.doesNotMatch(root, /other-|Showing|\$fromToolOutput/);
});

test('escaped keys and array indices identify null, false, zero, empty string and empty array distinctly', async () => {
  const fixture = park({ 'a/b': { '~key.with.dots': [{ nothing: null, disabled: false, count: 0, empty: '', rows: [] }] }, '': 'empty-key-value' });
  const prefix = '/a~1b/~0key.with.dots/0';
  for (const [key, literal] of [['nothing', 'null'], ['disabled', 'false'], ['count', '0'], ['empty', '""']]) {
    const result = await read(fixture.sessionId, { call_id: fixture.callId, path: `${prefix}/${key}` });
    assert.match(result, /is a scalar:/);
    assert.ok(result.endsWith(`is a scalar: ${literal}`));
    assert.doesNotMatch(result, /ERROR|No alternate|\$fromToolOutput/);
  }
  const empty = await read(fixture.sessionId, { call_id: fixture.callId, path: `${prefix}/rows` });
  assert.deepEqual(shownRows(empty), []);
  assert.match(empty, /0 matching/);
  const emptyKey = await read(fixture.sessionId, { call_id: fixture.callId, path: '/' });
  assert.match(emptyKey, /empty-key-value/);
});

test('bad or missing pointers fail exactly instead of choosing another array or inherited value', async () => {
  const fixture = park({ rows: [{ id: 'never-selected' }], other: [{ id: 'also-never-selected' }] });
  for (const selected of ['rows', '/rows/~2', '/rows/01', '/rows/-1', '/rows/*', '/rows/8', '/toString', '/missing']) {
    const result = await read(fixture.sessionId, { call_id: fixture.callId, path: selected });
    assert.match(result, /ERROR: path/);
    assert.match(result, /No alternate data was selected/);
    assert.doesNotMatch(result, /never-selected|\$fromToolOutput/);
  }
});

test('explicit paths preserve raw MCP ownership while omitted paths preserve automatic payload decoding', async () => {
  for (const sealed of [false, true]) {
    const payload = { records: [{ id: 'mcp-proof', verdict: 'verified' }], large: 'unused '.repeat(10_000) };
    const envelope = { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    const fixture = park(sealed ? { result: envelope, complete: true } : envelope);
    const automatic = await read(fixture.sessionId, { call_id: fixture.callId, fields: ['id', 'verdict'], limit: 1 });
    assert.deepEqual(shownRows(automatic), [{ id: 'mcp-proof', verdict: 'verified' }]);
    const selected = `${sealed ? '/result' : ''}/structuredContent/records`;
    const explicit = await read(fixture.sessionId, { call_id: fixture.callId, path: selected, fields: ['id', 'verdict'] });
    assert.deepEqual(shownRows(explicit), [{ id: 'mcp-proof', verdict: 'verified' }]);
    assert.doesNotMatch(explicit, /unused|\$fromToolOutput/);
    const text = await read(fixture.sessionId, { call_id: fixture.callId, path: `${sealed ? '/result' : ''}/content/0/text`, limit: 1 });
    assert.match(text, /is a scalar:/);
    assert.doesNotMatch(text, /Showing|\$fromToolOutput/);
    const notRaw = await read(fixture.sessionId, { call_id: fixture.callId, path: '/records', fields: ['id'] });
    assert.match(notRaw, /ERROR: path/);
    assert.doesNotMatch(notRaw, /mcp-proof/);
    assert.equal(getToolOutput(fixture.sessionId, fixture.callId)?.output, fixture.output);
  }
});

test('filters, sort and figures compute only over the chosen complete array and name its scope', async () => {
  const fixture = park({
    audit: Array.from({ length: 25 }, (_, i) => ({ amount: 1_000 + i, category: 'keep' })),
    groups: [{ items: [{ id: 'a', amount: 5, category: 'keep' }, { id: 'b', amount: 7, category: 'drop' }, { id: 'c', amount: 11, category: 'keep' }] }],
  });
  const args = { call_id: fixture.callId, path: '/groups/0/items', where: [{ field: 'category', op: 'eq', value: 'keep' }] };
  const result = await read(fixture.sessionId, { ...args, fields: ['id', 'amount'], sort_by: 'amount', order: 'desc' });
  assert.deepEqual(shownRows(result), [{ id: 'c', amount: 11 }, { id: 'a', amount: 5 }]);
  assert.match(result, /2 matching/);
  const figure = await read(fixture.sessionId, { ...args, aggregate: 'sum', value_field: 'amount' });
  assert.match(figure, /2 matching record\(s\) of 3 total/);
  assert.match(figure, /16/);
  assert.ok(figure.includes('path="/groups/0/items"'));
  assert.match(figure, /not a fresh provider read/);
  assert.doesNotMatch(figure, /\$fromToolOutput/);
});

test('Unicode record-boundary clipping keeps the exact selector and advances only past displayed records', async () => {
  const rows = Array.from({ length: 72 }, (_, i) => ({ id: `row-${i}`, text: '🙂🪴 café '.repeat(260) }));
  const fixture = park({ irrelevant: Array.from({ length: 90 }, (_, i) => ({ id: `wrong-${i}` })), nested: { rows } });
  let args: Record<string, unknown> = { call_id: fixture.callId, path: '/nested/rows', fields: ['id', 'text'], limit: 50 };
  const seen: unknown[] = [];
  const bound = Math.min(50_000, retainedReaderMaxChars(undefined));
  for (let page = 0; page < 20 && seen.length < rows.length; page++) {
    const result = await read(fixture.sessionId, args);
    assert.ok(result.length <= bound, `reply length ${result.length} exceeds ${bound}`);
    const shown = shownRows(result);
    assert.ok(shown.length > 0);
    assert.deepEqual(shown, rows.slice(seen.length, seen.length + shown.length));
    seen.push(...shown.map(row => row.id));
    assert.doesNotMatch(result, /wrong-|\$fromToolOutput/);
    if (seen.length === rows.length) break;
    const next = /Next: tool_output_query (\{[^\n]+\})/.exec(result);
    assert.ok(next, `No exact continuation after ${seen.length} displayed records`);
    args = JSON.parse(next[1]) as Record<string, unknown>;
    assert.equal(args.path, '/nested/rows');
    assert.equal(args.offset, seen.length);
    assert.deepEqual(args.fields, ['id', 'text']);
    assert.equal(args.limit, 50);
  }
  assert.deepEqual(seen, rows.map(row => row.id));
});

test('a path alone retains reading-byte charges and spent-budget refusal, while named fields or pages remain allowed', async () => {
  const fixture = park({ chosen: [{ id: 'budgeted', text: '😀'.repeat(25_000) }] });
  const budget = new RecallBudget(10, 2_000);
  const first = await read(fixture.sessionId, { call_id: fixture.callId, path: '/chosen' }, budget);
  assert.ok(Buffer.byteLength(first, 'utf8') <= 2_000);
  assert.ok(first.length <= inlineResultBudgetForModel(undefined));
  assert.ok(budget.remainingBytes() < 2_000, 'path-only reply charges existing reading bytes');
  const spent = new RecallBudget(10, 100);
  const refused = await read(fixture.sessionId, { call_id: fixture.callId, path: '/chosen' }, spent);
  assert.match(refused, /ERROR:.*budget/i);
  assert.doesNotMatch(refused, /"id": "budgeted"/);
  const projected = await read(fixture.sessionId, { call_id: fixture.callId, path: '/chosen', fields: ['id'] }, spent);
  assert.deepEqual(shownRows(projected), [{ id: 'budgeted' }]);
  const paged = await read(fixture.sessionId, { call_id: fixture.callId, path: '/chosen', limit: 1 }, spent);
  assert.ok(paged.length <= 50_000);
  assert.match(paged, /saved subtree only/);
  assert.equal(spent.remainingBytes(), 100, 'named page/projection uses the unchanged uncharged reply allowance');
});

test('long selected scalars are bounded and null optional paths retain legacy byte-for-byte replies', async () => {
  const fixture = park({ scalar: '🙂'.repeat(60_000), records: [{ id: 'legacy-record' }] });
  const budget = new RecallBudget(10, 3_000);
  const selected = await read(fixture.sessionId, { call_id: fixture.callId, path: '/scalar' }, budget);
  assert.ok(Buffer.byteLength(selected, 'utf8') <= 3_000);
  assert.match(selected, /is a scalar:/);
  assert.match(selected, /clipped/);
  assert.ok(budget.remainingBytes() < 3_000);
  const omitted = await read(fixture.sessionId, { call_id: fixture.callId, fields: ['id'], limit: 1 });
  const nullish = await read(fixture.sessionId, { call_id: fixture.callId, path: null, fields: ['id'], limit: 1 });
  assert.equal(nullish, omitted);
  assert.match(omitted, /legacy-record/);
});

test('paths on non-JSON text and recovered partial arrays never silently return unrelated or incomplete data', async () => {
  const session = createSession({ kind: 'chat' });
  writeToolOutput({ sessionId: session.id, callId: 'plain-text', tool: 'run_shell_command', output: 'exit_code: 0\n\nstdout:\nonly text here' });
  const explicit = await read(session.id, { call_id: 'plain-text', path: '' });
  assert.match(explicit, /text, not structured data/);
  assert.doesNotMatch(explicit, /Recalled chars/);
  const fallback = await read(session.id, { call_id: 'plain-text', path: null });
  assert.match(fallback, /Recalled chars/);
  writeToolOutput({ sessionId: session.id, callId: 'partial-prefix', tool: 'run_shell_command', output: 'exit_code: 0\n\nstdout:\n[{"id":"prefix-only"},{"id":' });
  const partial = await read(session.id, { call_id: 'partial-prefix', path: '/0/id', aggregate: 'count' });
  assert.match(partial, /ERROR: cannot select path.*clipped JSON-array prefix/);
  assert.doesNotMatch(partial, /prefix-only|Exact over|\$fromToolOutput/);
});

test('path selection cannot cross session boundaries or read incomplete durable storage', async () => {
  const fixture = park({ proof: { value: 'owned-only' } });
  const foreign = createSession({ kind: 'chat' });
  const denied = await read(foreign.id, { call_id: fixture.callId, path: '/proof/value' });
  assert.doesNotMatch(denied, /owned-only/);
  assert.match(denied, /No tool output|not found|no retained output/i);
  openEventLog().prepare('UPDATE tool_outputs SET truncated_at_write = 1 WHERE session_id = ? AND call_id = ?')
    .run(fixture.sessionId, fixture.callId);
  const incomplete = await read(fixture.sessionId, { call_id: fixture.callId, path: '/proof/value' });
  assert.match(incomplete, /ERROR: tool output .* is incomplete/);
  assert.doesNotMatch(incomplete, /owned-only|\$fromToolOutput/);
});

test('a scoped retained-reader lineage resolves the producer before selecting its subtree', async () => {
  const fixture = park({ workflow: { proof: [{ id: 'producer-value' }] } });
  appendEvent({ sessionId: fixture.sessionId, turn: 1, role: 'tool', type: 'tool_called', data: {
    callId: 'recall-carrier', tool: 'recall_tool_result', arguments: JSON.stringify({ call_id: fixture.callId, offset: 0 }),
  } });
  writeToolOutput({ sessionId: fixture.sessionId, callId: 'recall-carrier', tool: 'recall_tool_result',
    output: `Recalled chars 0–20 of ${fixture.output.length}\n\n${fixture.output.slice(0, 20)}` });
  const selected = await read(fixture.sessionId, { call_id: 'recall-carrier', path: '/workflow/proof', fields: ['id'] });
  assert.deepEqual(shownRows(selected), [{ id: 'producer-value' }]);
  assert.ok(selected.includes(`call_id=${JSON.stringify(fixture.callId)}`));
  assert.doesNotMatch(selected, /\$fromToolOutput/);
});

test('a projected field reads text inside nested lists of each record', async () => {
  const fixture = park({ data: { pageElements: [
    { objectId: 'p7_i3', size: { width: 1 }, shape: { text: { textElements: [
      { paragraphMarker: {} }, { textRun: { content: 'Q4 results\n' } }, { textRun: { content: 'Revenue up 12%' } },
    ] } } },
    { objectId: 'p7_i4', image: { contentUrl: 'https://x.test/a.png' } },
  ] } });
  const text = await read(fixture.sessionId, {
    call_id: fixture.callId, path: '/data/pageElements', fields: ['objectId', 'shape.text.textElements.textRun.content'],
  });
  assert.deepEqual(shownRows(text), [
    { objectId: 'p7_i3', 'shape.text.textElements.textRun.content': ['Q4 results\n', 'Revenue up 12%'] },
    { objectId: 'p7_i4' },
  ]);
});
