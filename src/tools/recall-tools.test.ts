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

test('tool_output_query recovers complete JSON after a CLI help preamble', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const wrapped = [
    'exit_code: 0',
    '',
    'stdout:',
    'USAGE',
    '  $ provider sites:create [options]',
    '',
    'OPTIONS',
    '  --name <name>',
    '',
    '---ACCOUNT SITES---',
    JSON.stringify([
      { id: 'site-other', name: 'other' },
      { id: 'site-target', name: 'target' },
    ]),
  ].join('\n');
  writeToolOutput({
    sessionId: sess.id,
    callId: 'call_help_then_json',
    tool: 'run_shell_command',
    output: wrapped,
  });

  const query = captureToolOutputQueryHandler();
  const res = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 200_000) },
    () => query({
      call_id: 'call_help_then_json',
      filter_field: 'name',
      filter_equals: 'target',
      fields: ['id', 'name'],
    }),
  );
  const text = res.content[0].text;
  assert.doesNotMatch(text, /is not JSON — use recall_tool_result/);
  assert.match(text, /site-target/);
  assert.doesNotMatch(text, /site-other/);
});

test('tool_output_query recovers complete records from a clipped shell JSON-array prefix', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const wrapped = [
    'exit_code: 0',
    '',
    'stdout:',
    '[',
    '{"id":"site-1","default_domain":"first.netlify.app"},',
    '{"id":"site-target","default_domain":"target.netlify.app"},',
    '{"id":"partial"',
  ].join('\n');
  writeToolOutput({
    sessionId: sess.id,
    callId: 'call_netlify_clipped',
    tool: 'run_shell_command',
    output: wrapped,
  });

  const query = captureToolOutputQueryHandler();
  const res = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 200_000) },
    () => query({
      call_id: 'call_netlify_clipped',
      filter_field: 'default_domain',
      filter_equals: 'target.netlify.app',
      fields: ['id', 'default_domain'],
    }),
  );
  const text = res.content[0].text;
  assert.doesNotMatch(text, /is not JSON — use recall_tool_result/);
  assert.match(text, /complete record\(s\) recovered from a clipped JSON-array prefix/);
  assert.match(text, /full total unknown/);
  assert.match(text, /site-target/);
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

test('tool_output_query hands the model the exact copy-paste $fromToolOutput reference for record values', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const records = [{ Email: 'a@x.co' }, { Email: 'b@x.co' }, { Email: 'c@x.co' }];
  writeToolOutput({ sessionId: sess.id, callId: 'call_roster', tool: 'run_shell_command', output: JSON.stringify(records) });
  const query = captureToolOutputQueryHandler();
  const res = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 200_000) },
    () => query({ call_id: 'call_roster', fields: ['Email'] }),
  );
  const text = res.content[0].text;
  assert.match(text, /grounded reference/);
  assert.match(text, /"callId":"call_roster"/);
  assert.match(text, /"path":"\[\*\]\.Email"/, 'exact copy-paste path for the projected field');
});

test('budget exhaustion is unmistakably an ERROR string, never parseable-looking data', async () => {
  // 4th call against a 3-call budget: the message must self-identify as an
  // error so a program that JSON.parses results can never mistake it for a
  // corrupt record (live 2026-07-24 "malformed data" misdiagnosis).
  const budget = new RecallBudget(1, 60_000);
  assert.equal(budget.consume(100), null, 'first call fits');
  const err = budget.consume(100);
  assert.ok(err, 'second call exhausts');
  // The recall tool prefixes this with "ERROR: " — pin the contract there via
  // the returned message shape used by the tool handler.
  assert.match(`ERROR: ${err}`, /^ERROR: recall budget exhausted/);
});

test('tool_output_query unwraps provider-wrapped records — the 2026-07-31 calendar-run class', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  // Microsoft Graph shape: records nested at data.value, wrapped in envelope keys.
  const payload = JSON.stringify({
    data: {
      '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#calendarView',
      value: Array.from({ length: 7 }, (_, i) => ({
        subject: `Meeting ${i}`, start: { dateTime: `2026-07-31T0${i}:00:00` }, organizer: 'nate',
      })),
    },
    successful: true,
    error: null,
  });
  writeToolOutput({ sessionId: sess.id, callId: 'call_cal', tool: 'composio_execute_tool', output: payload });

  const query = captureToolOutputQueryHandler();
  const res = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 200_000) },
    () => query({ call_id: 'call_cal', fields: ['subject', 'start'] }),
  );
  const text = res.content[0].text;
  assert.match(text, /of 7 matching \(7 total from data\.value\[\*\]\)/, 'the engine queries the RECORDS, naming where they live');
  assert.ok(text.includes('Meeting 6'), 'record fields project without knowing the envelope');
  assert.doesNotMatch(text, /Object \(\d+ top-level keys\)/, 'never the useless envelope summary');
});

test('a projection that matches nothing returns the MAP, never "{}"', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  writeToolOutput({
    sessionId: sess.id, callId: 'call_flat', tool: 'composio_execute_tool',
    output: JSON.stringify({ status: 'ok', meta: { region: 'us' } }),
  });
  const query = captureToolOutputQueryHandler();
  const missTop = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 200_000) },
    () => query({ call_id: 'call_flat', fields: ['events'] }),
  );
  const t1 = missTop.content[0].text;
  assert.match(t1, /None of \["events"\] exist at the top level/);
  assert.match(t1, /status: string/, 'the shape outline names what DOES exist');

  writeToolOutput({
    sessionId: sess.id, callId: 'call_wrap', tool: 'composio_execute_tool',
    output: JSON.stringify({ data: { value: [{ subject: 'A' }, { subject: 'B' }] } }),
  });
  const missRecords = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 200_000) },
    () => query({ call_id: 'call_wrap', fields: ['zzz_not_real'] }),
  );
  const t2 = missRecords.content[0].text;
  assert.match(t2, /None of \["zzz_not_real"\] exist on these records/);
  assert.match(t2, /subject/, 'record fields are named so the next query lands');

  const missFilter = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 200_000) },
    () => query({ call_id: 'call_wrap', filter_field: 'subject', filter_equals: 'Z' }),
  );
  const t3 = missFilter.content[0].text;
  assert.match(t3, /0 records matched filter_field="subject"/);
  assert.match(t3, /record fields: subject/, 'zero matches still teach the shape');
});

test('fields accepts the comma-separated STRING spelling — the live 2026-08-05 near-miss', async () => {
  // REGRESSION PIN: the model sent `"fields": "subject,start"` (valid JSON,
  // string type) after being taught prose field lists. The widened schema
  // accepts it and normalizeFieldsInput canonicalizes to the array form, so
  // both spellings produce byte-identical projections.
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const payload = JSON.stringify({
    data: {
      value: Array.from({ length: 4 }, (_, i) => ({
        subject: `Event ${i}`, start: { dateTime: `2026-08-06T0${i}:00:00` }, isAllDay: false, organizer: 'nate',
      })),
    },
  });
  writeToolOutput({ sessionId: sess.id, callId: 'call_widen', tool: 'composio_execute_tool', output: payload });

  const query = captureToolOutputQueryHandler();
  const run = (fields: unknown) => withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 200_000) },
    () => query({ call_id: 'call_widen', fields }),
  );
  const viaString = (await run(' subject, start ')).content[0].text;
  const viaArray = (await run(['subject', 'start'])).content[0].text;
  assert.equal(viaString, viaArray, 'string and array spellings are the SAME query (one canonical form past the boundary)');
  assert.ok(viaString.includes('Event 3'), 'projection actually returned records');
  assert.doesNotMatch(viaString, /isAllDay/, 'projection excluded unrequested fields');
});

test('normalizeFieldsInput: one canonical spelling, junk-tolerant, never a phantom empty projection', async () => {
  const { normalizeFieldsInput } = await import('./recall-tools.js');
  assert.deepEqual(normalizeFieldsInput('a,b , c'), ['a', 'b', 'c']);
  assert.deepEqual(normalizeFieldsInput(['a', ' b ']), ['a', 'b']);
  assert.equal(normalizeFieldsInput(''), undefined);
  assert.equal(normalizeFieldsInput('  ,  '), undefined);
  assert.equal(normalizeFieldsInput([]), undefined);
  assert.equal(normalizeFieldsInput(undefined), undefined);
  assert.equal(normalizeFieldsInput(null), undefined);
});
