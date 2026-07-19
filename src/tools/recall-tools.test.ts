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
  // registerRecallTools now registers BOTH recall_tool_result and
  // tool_output_query — capture by name so we grab the right one.
  let handler: RecallHandler | null = null;
  registerRecallTools({
    tool: (name: string, _description: string, _schema: unknown, cb: RecallHandler) => {
      if (name === 'recall_tool_result') handler = cb;
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
  assert.match(text, /Recalled chars 0.9000 of 10000/);
  assert.ok(text.includes('R'.repeat(8_000)), 'large recalled slice should survive the result wrapper');
  assert.doesNotMatch(text, /chars omitted; re-call with a narrower scope/);
});

function captureToolOutputQueryHandler(): RecallHandler {
  let handler: RecallHandler | null = null;
  registerRecallTools({
    tool: (name: string, _description: string, _schema: unknown, cb: RecallHandler) => {
      if (name === 'tool_output_query') handler = cb;
    },
  } as any);
  assert.ok(handler);
  return handler;
}

test('recall_tool_result pages with offset and signals when more remains', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const head = 'A'.repeat(30_000);
  const tail = 'B'.repeat(20_000); // 50KB total — bigger than one 30KB slice
  writeToolOutput({ sessionId: sess.id, callId: 'call_page', tool: 'composio_execute_tool', output: head + tail });

  const handler = captureRecallHandler();
  const page1 = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 200_000) },
    () => handler({ call_id: 'call_page' }),
  );
  const t1 = page1.content[0].text;
  assert.match(t1, /Recalled chars 0.30000 of 50000/);
  assert.match(t1, /more remains.*offset: 30000/);

  const page2 = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 200_000) },
    () => handler({ call_id: 'call_page', offset: 30_000 }),
  );
  const t2 = page2.content[0].text;
  assert.match(t2, /Recalled chars 30000.50000 of 50000/);
  assert.ok(t2.includes('B'.repeat(20_000)), 'offset reaches the tail of the payload');
  assert.doesNotMatch(t2, /more remains/);
});

test('tool_output_query reaches list rows that were UNQUERYABLE under the old 200KB cap', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  // 4000 records → serialized JSON well over the old 200KB cap, under the new 2MB one.
  const records = Array.from({ length: 4000 }, (_, i) => ({ id: i, email: `partner${i}@firm.example`, note: 'x'.repeat(40) }));
  const json = JSON.stringify(records);
  assert.ok(json.length > 200_000, 'fixture must exceed the old cap to prove the fix');
  writeToolOutput({ sessionId: sess.id, callId: 'call_list', tool: 'composio_execute_tool', output: json });

  const query = captureToolOutputQueryHandler();
  const res = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 200_000) },
    () => query({ call_id: 'call_list', offset: 3990, limit: 10, fields: ['id', 'email'] }),
  );
  const text = res.content[0].text;
  assert.match(text, /of 4000 matching \(4000 total\)/);
  assert.ok(text.includes('partner3999@firm.example'), 'the tail record is now stored and queryable');
});

test('tool_output_query queries JSON embedded in a run_shell_command wrapper (sf/gh/aws --json)', async () => {
  // Regression: a Salesforce team pull parked its `sf data query --json` output
  // inside an `exit_code:/stdout:` shell wrapper, so whole-string JSON.parse
  // failed and tool_output_query bounced the model to recall_tool_result (raw
  // text it had to re-parse) — a multi-turn detour. It must now query the
  // embedded stdout JSON directly.
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const records = Array.from({ length: 8 }, (_, i) => ({ Name: `Seller ${i}`, Email: `seller${i}@scorpion.co`, IsActive: true }));
  const payload = JSON.stringify({ status: 0, result: { totalSize: 8, records } });
  const wrapped = `exit_code: 0\n\nstdout:\n${payload}\n\nstderr:\n`;
  writeToolOutput({ sessionId: sess.id, callId: 'call_sf', tool: 'run_shell_command', output: wrapped });

  const query = captureToolOutputQueryHandler();
  const res = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 200_000) },
    () => query({ call_id: 'call_sf', fields: ['result'] }),
  );
  const text = res.content[0].text;
  assert.doesNotMatch(text, /is not JSON — use recall_tool_result/, 'must not bounce shell-wrapped JSON');
  assert.ok(text.includes('seller0@scorpion.co'), 'embedded records are queryable');
});

test('tool_output_query still bounces genuinely non-JSON output to recall_tool_result', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  writeToolOutput({ sessionId: sess.id, callId: 'call_txt', tool: 'run_shell_command', output: 'exit_code: 0\n\nstdout:\njust some log lines, not json\n' });
  const query = captureToolOutputQueryHandler();
  const res = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 200_000) },
    () => query({ call_id: 'call_txt' }),
  );
  assert.match(res.content[0].text, /is not JSON — use recall_tool_result/);
});

test('tool_output_query bounds an unfiltered large-object response (no full-payload context dump)', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  // ~300KB top-level object — the object branch returns the projected object, which
  // WITHOUT fields would be the whole thing now that the store holds up to 2MB.
  const obj: Record<string, string> = {};
  for (let i = 0; i < 3000; i++) obj[`k${i}`] = 'v'.repeat(100);
  const json = JSON.stringify(obj);
  assert.ok(json.length > 200_000, 'fixture must be large');
  writeToolOutput({ sessionId: sess.id, callId: 'call_obj', tool: 'composio_execute_tool', output: json });

  const query = captureToolOutputQueryHandler();
  const res = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 200_000) },
    () => query({ call_id: 'call_obj' }),
  );
  const text = res.content[0].text;
  assert.ok(text.length <= 51_000, `response must be bounded, got ${text.length}`);
  assert.match(text, /clipped to 50000 chars/);
});
