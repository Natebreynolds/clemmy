/**
 * Run: npx tsx --test src/tools/composio-tools.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-composio-tools-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
// Legacy clip-and-recall path (LARGE_TOOL_OUTPUT_DIGEST ships on; digest
// path covered by tool-output-digest.test.ts).
process.env.LARGE_TOOL_OUTPUT_DIGEST = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatComposioToolOutput } = await import('./composio-tools.js');
const {
  closeEventLog,
  resetEventLog,
  createSession,
  getToolOutput,
} = await import('../runtime/harness/eventlog.js');

test.after(() => {
  try {
    closeEventLog();
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test('formatComposioToolOutput stores full oversized JSON before returning a recallable clip', () => {
  resetEventLog();
  const sess = createSession({ kind: 'workflow' });
  const value = {
    data: {
      value: Array.from({ length: 20 }, (_, index) => ({
        id: `msg-${index}`,
        subject: `Long Outlook subject ${index}`,
        bodyPreview: 'A'.repeat(120),
      })),
    },
  };
  const full = JSON.stringify(value, null, 2);

  const output = formatComposioToolOutput(value, {
    context: { context: { sessionId: sess.id } },
    details: { toolCall: { callId: 'call_composio_full' } },
    toolName: 'composio_execute_tool',
    maxChars: 300,
  });

  assert.ok(output.length < full.length, 'model-facing output should be clipped');
  assert.match(output, /recall_tool_result\("call_composio_full"\)/);
  assert.match(output, /composio_execute_tool returned \d+ chars/);

  const row = getToolOutput(sess.id, 'call_composio_full');
  assert.ok(row);
  assert.equal(row.output, full);
  assert.equal(row.contentBytes, Buffer.byteLength(full, 'utf8'));
  assert.equal(row.truncatedAtWrite, false);
});

test('formatComposioToolOutput falls back to a non-recallable clip without harness call context', () => {
  resetEventLog();
  const value = { payload: 'B'.repeat(1000) };

  const output = formatComposioToolOutput(value, { maxChars: 100 });

  assert.match(output, /truncated/);
  assert.doesNotMatch(output, /recall_tool_result/);
});
