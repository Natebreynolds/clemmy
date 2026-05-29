/**
 * Run: npx tsx --test src/tools/recall-tools.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-recall-tools-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { registerRecallTools } = await import('./recall-tools.js');
const {
  closeEventLog,
  resetEventLog,
  createSession,
  writeToolOutput,
} = await import('../runtime/harness/eventlog.js');
const {
  RecallBudget,
  ToolCallsCounter,
  withHarnessRunContext,
} = await import('../runtime/harness/brackets.js');

type RecallHandler = (input: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;

function captureRecallHandler(): RecallHandler {
  let handler: RecallHandler | null = null;
  registerRecallTools({
    tool: (_name: string, _description: string, _schema: unknown, cb: RecallHandler) => {
      handler = cb;
    },
  } as any);
  assert.ok(handler);
  return handler;
}

test.after(() => {
  try {
    closeEventLog();
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test('recall_tool_result returns the requested large slice without default 4KB truncation', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const payload = 'R'.repeat(10_000);
  writeToolOutput({
    sessionId: sess.id,
    callId: 'call_recall_large',
    tool: 'composio_execute_tool',
    output: payload,
  });

  const handler = captureRecallHandler();
  const result = await withHarnessRunContext(
    {
      sessionId: sess.id,
      counter: new ToolCallsCounter(10),
      recallBudget: new RecallBudget(3, 60_000),
    },
    () => handler({ call_id: 'call_recall_large', max_chars: 9_000 }),
  );

  const text = result.content[0].text;
  assert.match(text, /Recalled 9000 chars/);
  assert.ok(text.includes('R'.repeat(8_000)), 'large recalled slice should survive the result wrapper');
  assert.doesNotMatch(text, /chars omitted; re-call with a narrower scope/);
});
