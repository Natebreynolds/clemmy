/**
 * Run: npx tsx --test src/runtime/harness/tool-output-format.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-tool-output-format-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  closeEventLog,
  resetEventLog,
  createSession,
  getToolOutput,
} = await import('./eventlog.js');
const { formatRecallableToolText } = await import('./tool-output-format.js');
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
  assert.match(visible, /global_tool returned \d+ chars/);
  assert.match(visible, /recall_tool_result\("call_global_clip"\)/);

  const row = getToolOutput(sess.id, 'call_global_clip');
  assert.ok(row);
  assert.equal(row.output, full);
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
  assert.match(visible, /skill_read returned \d+ chars/);
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
