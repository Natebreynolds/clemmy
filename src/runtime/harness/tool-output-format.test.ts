/**
 * Run: npx tsx --test src/runtime/harness/tool-output-format.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-tool-output-format-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
// These tests cover the recallable-tool-output WRAPPER: full output is stored +
// recoverable via recall_tool_result, and the global id-index is prepended. The
// structure-aware digest BODY is covered in detail by tool-output-digest.test.ts.
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  closeEventLog,
  resetEventLog,
  createSession,
  getToolOutput,
} = await import('./eventlog.js');
const { formatRecallableToolText, extractResourceIdIndex } = await import('./tool-output-format.js');
const { withToolOutputContext } = await import('./tool-output-context.js');
const { textResult } = await import('../../tools/shared.js');

test.after(() => {
  try {
    closeEventLog();
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test('formatRecallableToolText stores full output and returns canonical recall stub', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const full = 'global-output-'.repeat(1000);

  const visible = formatRecallableToolText(full, {
    sessionId: sess.id,
    callId: 'call_global_clip',
    toolName: 'global_tool',
    maxChars: 120,
  });

  assert.ok(visible.length < full.length);
  assert.match(visible, /recall_tool_result\("call_global_clip"\)/);

  const row = getToolOutput(sess.id, 'call_global_clip');
  assert.ok(row);
  assert.equal(row.output, full);
});

test('clip footer reports the TRUE record count + that recall returns ALL (scorpion 44→4 fix)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  // The Airtable shape that broke: full result with 59 records, clipped to a few.
  const full = JSON.stringify({ data: { records: Array.from({ length: 59 }, (_, i) => ({ id: i, fields: { Name: 'Contact ' + i, Email: `c${i}@x.com` } })) }, error: null, successful: true });
  const visible = formatRecallableToolText(full, { sessionId: sess.id, callId: 'call_air', toolName: 'composio_execute_tool', maxChars: 400 });
  assert.match(visible, /[Cc]ontains 59 records/);
  assert.match(visible, /returns ALL 59/);
  assert.match(visible, /no pagination/i);
  assert.match(visible, /recall_tool_result\("call_air"\)/);
  assert.equal(getToolOutput(sess.id, 'call_air')!.output, full); // full payload preserved
});

test('textResult uses active tool-output context for MCP-style local tools', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const full = 'mcp-local-output-'.repeat(1000);

  const result = await withToolOutputContext(
    {
      sessionId: sess.id,
      callId: 'call_text_result_full',
      toolName: 'skill_read',
    },
    () => textResult(full, { maxChars: 100 }),
  );

  const visible = result.content[0].text;
  assert.match(visible, /recall_tool_result\("call_text_result_full"\)/);

  const row = getToolOutput(sess.id, 'call_text_result_full');
  assert.ok(row);
  assert.equal(row.output, full);
});

test('formatRecallableToolText falls back to plain truncation without call context', () => {
  const visible = formatRecallableToolText('x'.repeat(1000), { maxChars: 50 });
  assert.match(visible, /truncated/);
  assert.doesNotMatch(visible, /recall_tool_result/);
});

// ── GLOBAL id-index: applies to EVERY tool (composio + native MCP + local) ──

test('extractResourceIdIndex: pulls id=name from resource lists, ignores bulk data rows', () => {
  // Airtable base schema (composio shape)
  assert.match(
    extractResourceIdIndex(JSON.stringify({ data: { tables: [
      { id: 'tblAAA', name: 'Prospecting Accounts', fields: [] },
      { id: 'tblBBB', name: 'Prospecting Contacts' },
    ] } })),
    /tblAAA = Prospecting Accounts[\s\S]*tblBBB = Prospecting Contacts/,
  );
  // Native-MCP-style list under a different key (objects/databases/sheets)
  assert.match(
    extractResourceIdIndex(JSON.stringify({ databases: [{ id: 'db_1', title: 'CRM' }] })),
    /db_1 = CRM/,
  );
  // Bulk record rows (id but no name) and value arrays are NOT indexed (no noise).
  assert.equal(extractResourceIdIndex(JSON.stringify({ data: { records: [{ id: 'rec1', fields: { x: 1 } }] } })), '');
  // A single object / non-list → no index.
  assert.equal(extractResourceIdIndex(JSON.stringify({ data: { display_url: 'x' } })), '');
  // Non-JSON → safe empty.
  assert.equal(extractResourceIdIndex('not json'), '');
});

test('formatRecallableToolText prepends the id index when a large resource-list result is clipped', () => {
  // 8 tables, each padded so the whole result exceeds maxChars and gets clipped.
  const tables = Array.from({ length: 8 }, (_, i) => ({ id: `tbl${i}`, name: `Table ${i}`, fields: Array.from({ length: 30 }, (_, f) => ({ id: `fld${i}_${f}`, name: 'x'.repeat(20) })) }));
  const text = JSON.stringify({ data: { tables } });
  assert.ok(text.length > 2000);
  const out = formatRecallableToolText(text, { maxChars: 1500 });
  assert.match(out, /IDs available in this result/);
  assert.match(out, /tbl0 = Table 0/);
  assert.match(out, /tbl7 = Table 7/); // survives even though the body is clipped
});
