/**
 * Run: npx tsx --test src/tools/table-ops.test.ts
 * table_ops (2026-07-21) — the deterministic "spreadsheet brain" (capability
 * audit missing-primitive #1): reconcile/diff/join/dedupe/tally with exact
 * results at any size, sourced from inline rows, parked tool outputs, or files.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-table-ops-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  loadTableFromText, opAggregate, opDedupe, opDiff, opJoin, opSelect, parseCsv, rowKey,
} = await import('./table-ops-core.js');
const { registerTableOpsTools } = await import('./table-ops-tools.js');
const { writeToolOutput, createSession } = await import('../runtime/harness/eventlog.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');

test.after(() => rmSync(TMP, { recursive: true, force: true }));

// ── Core algebra ─────────────────────────────────────────────────────

test('diff: "who is in the CRM but not the sheet" — trimmed, case-insensitive key match', () => {
  const crm = [{ email: 'Amy@Firm.example', name: 'Amy' }, { email: 'bo@firm.example', name: 'Bo' }, { email: 'cy@firm.example', name: 'Cy' }];
  const sheet = [{ email: ' amy@firm.example ', row: 2 }, { email: 'CY@FIRM.EXAMPLE', row: 3 }];
  const result = opDiff(crm, sheet, ['email']);
  assert.deepEqual(result.rows.map((r) => r.name), ['Bo'], 'exact set difference, email-normalized');
  assert.equal(result.leftCount, 3);
  assert.equal(result.rightCount, 2);
});

test('join merges the first right match; colliding columns prefix right_', () => {
  const left = [{ email: 'a@x.example', status: 'lead' }];
  const right = [{ email: 'a@x.example', status: 'customer', mrr: 100 }];
  const { rows } = opJoin(left, right, ['email']);
  assert.deepEqual(rows[0], { email: 'a@x.example', status: 'lead', right_status: 'customer', mrr: 100 });
});

test('dedupe keeps first; aggregate tallies with sum/avg over numeric coercion', () => {
  const rows = [
    { owner: 'amy', amount: '10' }, { owner: 'amy', amount: '5' }, { owner: 'bo', amount: 'n/a' },
  ];
  assert.equal(opDedupe(rows, ['owner']).rows.length, 2);
  const agg = opAggregate(rows, ['owner'], [{ fn: 'count' }, { fn: 'sum', column: 'amount' }]);
  const amy = agg.rows.find((r) => r.owner === 'amy');
  assert.equal(amy!.count, 2);
  assert.equal(amy!.sum_amount, 15, 'numeric strings coerce');
  const bo = agg.rows.find((r) => r.owner === 'bo');
  assert.equal(bo!.sum_amount, null, 'no numeric values → null, never NaN');
});

test('select: where + projection + limit', () => {
  const rows = [{ a: 'x', b: 1 }, { a: '', b: 2 }, { a: 'y', b: 3 }];
  const result = opSelect(rows, { where: { column: 'a', op: 'nonempty' }, columns: ['b'], limit: 1 });
  assert.deepEqual(result.rows, [{ b: 1 }]);
});

test('input parsing: JSON envelope, JSONL, quoted CSV, TSV — all land as rows', () => {
  assert.equal(loadTableFromText('{"data":{"items":[{"id":1},{"id":2}]}}').length, 2, 'envelope auto-found');
  assert.equal(loadTableFromText('{"data":{"items":[{"id":1}]}}', { path: 'data.items' }).length, 1, 'explicit path');
  assert.equal(loadTableFromText('{"id":1}\n{"id":2}\n{"id":3}').length, 3, 'JSONL');
  const csv = 'email,note\n"amy@x.example","said ""hi"", twice"\nbo@x.example,ok';
  const rows = parseCsv(csv, ',');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].note, 'said "hi", twice', 'RFC-4180 quoting');
  assert.equal(loadTableFromText('a\tb\n1\t2').length, 1, 'TSV sniffed');
  assert.throws(() => loadTableFromText('just some prose'), /could not parse/);
});

test('rowKey: multi-column + non-string values are stable', () => {
  assert.equal(rowKey({ a: ' X ', b: 2 }, ['a', 'b']), rowKey({ a: 'x', b: 2 }, ['a', 'b']));
});

// ── Tool wrapper ─────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
function captureTool(): ToolHandler {
  let handler: ToolHandler | undefined;
  const fake = { tool: (_n: string, _d: string, _s: unknown, h: ToolHandler) => { handler = h; } };
  registerTableOpsTools(fake as never);
  return handler!;
}
const textOf = (r: { content: Array<{ text: string }> }): string => r.content[0].text;

test('tool: diff over a PARKED tool output — the 10k-row read never re-enters context', async () => {
  const sess = createSession({ kind: 'chat' });
  const bigSheet = Array.from({ length: 500 }, (_, i) => ({ email: `c${i}@x.example`, row: i }));
  writeToolOutput({ sessionId: sess.id, callId: 'call_sheet_read', tool: 'composio_execute_tool', output: JSON.stringify({ data: { values: bigSheet } }) });
  const crm = JSON.stringify([...bigSheet.slice(0, 498).map((r) => ({ email: r.email })), { email: 'new1@x.example' }, { email: 'new2@x.example' }]);
  const handler = captureTool();
  const out = await withToolOutputContext({ sessionId: sess.id }, () =>
    handler({ op: 'diff', key: 'email', left_rows: crm, right_call_id: 'call_sheet_read' }));
  const parsed = JSON.parse(textOf(out));
  assert.equal(parsed.resultCount, 2, 'exactly the two CRM contacts missing from the sheet');
  assert.deepEqual(parsed.rows.map((r: { email: string }) => r.email).sort(), ['new1@x.example', 'new2@x.example']);
});

test('tool: a large result spills to a staged JSONL file that chains back in as left_file', async () => {
  const handler = captureTool();
  const big = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: `row-${i}`, v: i })));
  const out = await handler({ op: 'select', left_rows: big });
  const parsed = JSON.parse(textOf(out));
  assert.equal(parsed.resultCount, 500);
  assert.ok(parsed.filePath && existsSync(parsed.filePath), 'full result staged');
  assert.equal(readFileSync(parsed.filePath, 'utf-8').split('\n').length, 500);
  // Chain: aggregate over the spilled file.
  const out2 = await handler({ op: 'aggregate', left_file: parsed.filePath, group_by: 'id', metrics: 'count' });
  assert.equal(JSON.parse(textOf(out2)).resultCount, 500, 'spill file round-trips');
});

test('tool: corrective errors — missing key, over-specified source, bad call id', async () => {
  const handler = captureTool();
  assert.match(textOf(await handler({ op: 'diff', left_rows: '[]', right_rows: '[]' })), /needs `key`/);
  assert.match(textOf(await handler({ op: 'dedupe', key: 'x', left_rows: '[{"x":1}]', left_file: '/tmp/nope' })), /exactly ONE/);
  const sess = createSession({ kind: 'chat' });
  const out = await withToolOutputContext({ sessionId: sess.id }, () =>
    handler({ op: 'dedupe', key: 'x', left_call_id: 'call_never_existed' }));
  assert.match(textOf(out), /no stored output/);
});
