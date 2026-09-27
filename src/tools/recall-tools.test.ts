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
  appendEvent,
} = await import('../runtime/harness/eventlog.js');
const {
  RecallBudget,
  ToolCallsCounter,
  withHarnessRunContext,
} = await import('../runtime/harness/brackets.js');

type RecallHandler = (input: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;

test('JSON-encoded field arrays query exact retained fields without widening the projection', async () => {
  const session = createSession({ kind: 'chat' });
  writeToolOutput({ sessionId: session.id, callId: 'encoded-fields', tool: 'work_call',
    output: JSON.stringify({ data: { value: [{ subject: 'Example', start: '09:30', privateNote: 'must stay hidden' }] } }) });
  const query = captureToolOutputQueryHandler();
  for (const fields of [['subject', 'start'], '["subject","start"]', 'subject,start']) {
    const result = await withHarnessRunContext({ sessionId: session.id, turn: 1, toolCalls: new ToolCallsCounter(10) },
      () => query({ call_id: 'encoded-fields', fields }));
    assert.match(result.content[0].text, /Example/);
    assert.match(result.content[0].text, /09:30/);
    assert.doesNotMatch(result.content[0].text, /privateNote|must stay hidden|None of/);
  }
  for (const fields of ['[]', '["subject",null]', '["subject"']) {
    const result = await withHarnessRunContext({ sessionId: session.id, turn: 2, toolCalls: new ToolCallsCounter(10) },
      () => query({ call_id: 'encoded-fields', fields }));
    assert.doesNotMatch(result.content[0].text, /must stay hidden/);
  }
});

test('queries of a recall call recover the original data, not the JSON example in its preamble', async () => {
  const session = createSession({ kind: 'chat' });
  writeToolOutput({ sessionId: session.id, callId: 'original-cli', tool: 'work_call', output: JSON.stringify({
    result: { version: 1, status: 'exited', operationId: 'salesforce_sf_soql_query', executableRealpath: '/usr/local/bin/sf',
      argv: ['data', 'query', '--json'], exitCode: 0, stdoutTruncated: false,
      stdout: JSON.stringify({ result: { records: [{ Name: 'Fictional Acorn', Email: 'acorn@example.test' }] } }) }, complete: true,
  }) });
  appendEvent({ sessionId: session.id, turn: 1, role: 'tool', type: 'tool_called', data: {
    callId: 'recall-slice', tool: 'recall_tool_result', arguments: JSON.stringify({ call_id: 'original-cli', offset: 300 }),
  } });
  writeToolOutput({ sessionId: session.id, callId: 'recall-slice', tool: 'recall_tool_result',
    output: 'Recalled chars 300–400 of 1000 (more remains — recall_tool_result {"call_id":"original-cli","offset":400})\n\nclipped fragment' });
  const query = captureToolOutputQueryHandler();
  const result = await withHarnessRunContext({ sessionId: session.id, turn: 2, toolCalls: new ToolCallsCounter(10) },
    () => query({ call_id: 'recall-slice', fields: ['Name', 'Email'] }));
  assert.match(result.content[0].text, /Fictional Acorn/);
  assert.match(result.content[0].text, /acorn@example\.test/);
  assert.doesNotMatch(result.content[0].text, /None of|No tool output/);
});

test('a recall that travelled through a carrier maps back to its producer, for recall and query alike', async () => {
  // Regression: a recall dispatched through call_tool / work_call records the
  // carrier as `tool`; the lineage walk stopped there, so the model paged the
  // recall's own clipped copy instead of the original result.
  const session = createSession({ kind: 'chat' });
  const producer = JSON.stringify([{ padding: 'H'.repeat(4_000), Name: 'Carrier Lineage Row' }]);
  writeToolOutput({ sessionId: session.id, callId: 'carrier-producer', tool: 'space_get', output: producer });
  for (const carrier of ['call_tool', 'work_call'] as const) {
    const recallId = `carrier-recall-${carrier}`;
    appendEvent({ sessionId: session.id, turn: 1, role: 'tool', type: 'tool_called', data: {
      callId: recallId, tool: carrier, effectiveTool: 'recall_tool_result', accounting: 'top_level',
      arguments: JSON.stringify({ name: 'recall_tool_result', args_json: JSON.stringify({ call_id: 'carrier-producer', max_chars: 500 }) }),
    } });
    appendEvent({ sessionId: session.id, turn: 1, role: 'tool', type: 'tool_called', data: {
      callId: recallId, tool: 'recall_tool_result', accounting: 'transport_mirror', canonicalCallId: recallId,
      args: JSON.stringify({ call_id: 'carrier-producer', max_chars: 500, offset: null }),
    } });
    writeToolOutput({ sessionId: session.id, callId: recallId, tool: carrier,
      output: `Recalled chars 0–500 of ${producer.length} (more remains — continue with recall_tool_result {"call_id":"carrier-producer","offset":500})\n\n${'H'.repeat(500)}` });
    const recalled = await withHarnessRunContext({ sessionId: session.id, turn: 2, toolCalls: new ToolCallsCounter(10) },
      () => captureRecallHandler()({ call_id: recallId, offset: 4_000 }));
    assert.match(recalled.content[0].text, new RegExp(`Recalled chars 4000–${producer.length} of ${producer.length}\\b`));
    assert.match(recalled.content[0].text, /Carrier Lineage Row/);
    const queried = await withHarnessRunContext({ sessionId: session.id, turn: 2, toolCalls: new ToolCallsCounter(10) },
      () => captureToolOutputQueryHandler()({ call_id: recallId, fields: ['Name'] }));
    assert.match(queried.content[0].text, /Carrier Lineage Row/);
  }
});

test('lineage never follows a foreign tool that only shares the recall name', async () => {
  const session = createSession({ kind: 'chat' });
  writeToolOutput({ sessionId: session.id, callId: 'foreign-target', tool: 'work_call', output: 'the target text' });
  appendEvent({ sessionId: session.id, turn: 1, role: 'tool', type: 'tool_called', data: {
    callId: 'foreign-recall', tool: 'recall_tool_result', effectiveTool: 'othersrv__recall_tool_result',
    accounting: 'top_level', arguments: JSON.stringify({ call_id: 'foreign-target' }),
  } });
  writeToolOutput({ sessionId: session.id, callId: 'foreign-recall', tool: 'recall_tool_result', output: 'the foreign tool own output' });
  const recalled = await withHarnessRunContext({ sessionId: session.id, turn: 2, toolCalls: new ToolCallsCounter(10) },
    () => captureRecallHandler()({ call_id: 'foreign-recall' }));
  assert.match(recalled.content[0].text, /the foreign tool own output/);
  assert.doesNotMatch(recalled.content[0].text, /the target text/);
});

test('old or failed projections do not permanently exhaust a retained result for later turns', async () => {
  const session = createSession({ kind: 'chat' });
  writeToolOutput({ sessionId: session.id, callId: 'long-lived-result', tool: 'work_call',
    output: JSON.stringify([{ Name: 'Still readable' }]) });
  for (let i = 0; i < 16; i++) appendEvent({ sessionId: session.id, turn: 1, role: 'tool', type: 'tool_called', data: {
    callId: `old-query-${i}`, tool: 'tool_output_query', arguments: JSON.stringify({ call_id: 'long-lived-result', fields: ['wrong'] }),
  } });
  const result = await withHarnessRunContext({ sessionId: session.id, turn: 2, toolCalls: new ToolCallsCounter(10) },
    () => captureToolOutputQueryHandler()({ call_id: 'long-lived-result', fields: ['Name'] }));
  assert.match(result.content[0].text, /Still readable/);
  assert.doesNotMatch(result.content[0].text, /budget.*spent|seen every record/);
});

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
  // A bare recall shows one whole inline result for the window, not the much
  // larger slice ceiling.
  assert.match(t1, /Recalled chars 0.20000 of 50000/);
  // The paging signal must name the EXACT next call, not just "more remains".
  // A model that has to reconstruct the call guesses offsets, and blind paging
  // spends a turn per slice while crediting no business progress until the
  // no-progress governor ends the run (live platform-49 run, 2026-09-02).
  assert.match(t1, /more remains/);
  assert.match(t1, /recall_tool_result \{"call_id":"call_page","offset":20000\}/);

  const explicit = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 200_000) },
    () => handler({ call_id: 'call_page', max_chars: 30_000 }),
  );
  assert.match(explicit.content[0].text, /Recalled chars 0.30000 of 50000/,
    'an explicit larger slice is honored up to the ceiling');

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

test('mixed CLI help and JSON cannot be silently treated as an authoritative dataset', async () => {
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
  assert.match(text, /text, not structured data/);
  assert.match(text, /recall_tool_result/);
  const raw = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 200_000) },
    () => query({ call_id: 'call_help_then_json' }),
  );
  assert.match(raw.content[0].text, /site-target/);
  assert.match(raw.content[0].text, /USAGE/);
  assert.match(raw.content[0].text, /site-other/);
  assert.match(raw.content[0].text, /text, not structured records/);
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

test('tool_output_query on genuinely non-JSON text answers with the text, never a refusal round', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  writeToolOutput({ sessionId: sess.id, callId: 'call_txt', tool: 'run_shell_command', output: 'exit_code: 0\n\nstdout:\njust some log lines, not json\n' });
  const query = captureToolOutputQueryHandler();
  const budget = new RecallBudget(3, 200_000);
  // Strict transports send every unused optional argument as null; a bare
  // query (the old digest footer even suggested a limit) still means "show it".
  const res = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: budget },
    () => query({ call_id: 'call_txt', fields: null, filter_field: null, where: null, limit: 50 }),
  );
  const text = res.content[0].text;
  assert.match(text, /is text, not structured records/);
  assert.match(text, /Recalled chars 0–\d+ of \d+/);
  assert.match(text, /just some log lines, not json/);
  assert.doesNotMatch(text, /No JSON value could be recovered|is not JSON/);
  assert.equal(budget.snapshot().calls, 1, 'the text answer spends recall budget like recall does');

  // A projection or filter needs records; text still gets a computed route,
  // never a claim that the output "is not JSON".
  const filtered = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 200_000) },
    () => query({ call_id: 'call_txt', filter_field: 'level', filter_contains: 'warn' }),
  );
  assert.match(filtered.content[0].text, /No JSON value could be recovered/);
  assert.match(filtered.content[0].text, /recall_tool_result \{"call_id":"call_txt"\}/);
  assert.doesNotMatch(filtered.content[0].text, /is not JSON/);
});

test('tool_output_query on text with recall spent routes to a reader that still serves, never back to itself', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  writeToolOutput({ sessionId: sess.id, callId: 'call_txt_spent', tool: 'work_call', invocationNonce: 'nonce-txt-spent',
    output: 'plain narrative text with no records at all' });
  const budget = new RecallBudget(0, 200_000, sess.id);
  const res = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: budget },
    () => captureToolOutputQueryHandler()({ call_id: 'call_txt_spent' }),
  );
  const text = res.content[0].text;
  assert.match(text, /^ERROR: /);
  assert.match(text, /file_query \{"call_id":"call_txt_spent"/);
  assert.doesNotMatch(text, /tool_output_query \{|recall_tool_result \{/);
});

test('a long text slice never points an ANSWER at the record query', async () => {
  // The paging header's "answer instead of paging" route is computed from the
  // output's shape: a record query for records, a passage search for text.
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  writeToolOutput({ sessionId: sess.id, callId: 'call_long_text', tool: 'work_call', invocationNonce: 'nonce-long-text',
    output: 'narrative line without records\n'.repeat(2_000) });
  for (const [reader, input] of [
    [captureRecallHandler(), { call_id: 'call_long_text', max_chars: 1_000 }],
    [captureToolOutputQueryHandler(), { call_id: 'call_long_text' }],
  ] as const) {
    const res = await withHarnessRunContext(
      { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(5, 400_000) },
      () => reader({ ...input }),
    );
    assert.doesNotMatch(res.content[0].text, /tool_output_query \{/);
  }
  const paged = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(5, 400_000) },
    () => captureRecallHandler()({ call_id: 'call_long_text', max_chars: 1_000 }),
  );
  assert.match(paged.content[0].text, /if you need an ANSWER rather than the raw text, file_query \{"call_id":"call_long_text"/);
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
  // A bare query is one inline result, the same default a bare recall gets.
  assert.ok(text.length <= 21_000, `response must be bounded, got ${text.length}`);
  assert.match(text, /clipped to \d+ chars/);
  // A named page is an explicit ask, bounded by the query's own maximum.
  const named = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 200_000) },
    () => query({ call_id: 'call_obj', limit: 50 }),
  );
  assert.ok(named.content[0].text.length > 21_000 && named.content[0].text.length <= 51_000,
    `named page bounded by the query maximum, got ${named.content[0].text.length}`);
  assert.match(named.content[0].text, /clipped to \d+ chars/);
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

test('a recall budget refusal hands back the exact next call, never prose only', async () => {
  // Live platform-49 run 2026-09-02: the refusal said only "proceed with the
  // summary or split work into a new turn". The budget resets per turn, so the
  // model re-recalled, exhausted it again, and burned the no-progress governor
  // -- 19 recalls, zero business calls, the sheet never touched. A gate the
  // model cannot get through is a defect, so both refusals must name
  // tool_output_query AND carry the exact call_id to use.
  const callBudget = new RecallBudget(1, 60_000);
  assert.equal(callBudget.consume(100, 'call_abc123'), null, 'first call fits');
  const callErr = callBudget.consume(100, 'call_abc123');
  assert.ok(callErr, 'second call exhausts the call budget');
  assert.match(callErr, /tool_output_query \{"call_id":"call_abc123"\}/);
  assert.match(callErr, /Do NOT retry recall_tool_result/);

  const byteBudget = new RecallBudget(9, 2_000);
  const byteErr = byteBudget.consume(3_000, 'call_xyz789');
  assert.ok(byteErr, 'an oversized slice exhausts the byte budget');
  assert.match(byteErr, /^recall byte budget exhausted/);
  assert.match(byteErr, /tool_output_query \{"call_id":"call_xyz789"\}/);

  // Once too few bytes remain for a bare query reply, the exact next call is
  // a named page, which spends no reading bytes; the query is never closed.
  const spentBudget = new RecallBudget(9, 150);
  const spentErr = spentBudget.consume(200, 'call_xyz789');
  assert.ok(spentErr);
  assert.match(spentErr, /tool_output_query \{"call_id":"call_xyz789","limit":20\}/);
  assert.match(spentErr, /Do NOT retry recall_tool_result or a bare tool_output_query/);

  // Without a call_id the refusal still points at the tool rather than dead-ending.
  const bare = new RecallBudget(0, 60_000).consume(10);
  assert.ok(bare);
  assert.match(bare, /tool_output_query with that same call_id/);
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

  // A dotted field reaches a nested value, as where/sort_by already do
  // (live 2026-09-26: "keyword_data.keyword" projected to {} and the tool
  // claimed the field did not exist while sorting by it worked).
  writeToolOutput({
    sessionId: sess.id, callId: 'call_nested', tool: 'composio_execute_tool',
    output: JSON.stringify({ items: [
      { keyword_data: { keyword: 'dui attorney', keyword_info: { search_volume: 1900, cpc: 41.2 } }, ranked_serp_element: { serp_item: { rank_absolute: 3 } } },
      { keyword_data: { keyword: 'burglary', keyword_info: { search_volume: 300, cpc: 2.1 } }, ranked_serp_element: { serp_item: { rank_absolute: 9 } } },
    ] }),
  });
  const nested = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 200_000) },
    () => query({ call_id: 'call_nested', fields: 'keyword_data.keyword,keyword_data.keyword_info.cpc,ranked_serp_element.serp_item.rank_absolute', sort_by: 'keyword_data.keyword_info.cpc', order: 'desc' }),
  );
  const tNested = nested.content[0].text;
  assert.match(tNested, /Showing 2 record\(s\)/);
  assert.match(tNested, /"keyword_data\.keyword": "dui attorney"/, 'the nested value is projected under the path as written');
  assert.match(tNested, /"ranked_serp_element\.serp_item\.rank_absolute": 3/);
  assert.doesNotMatch(tNested, /search_volume/, 'fields not asked for stay out');
  assert.ok(tNested.indexOf('dui attorney') < tNested.indexOf('burglary'), 'sorted by the nested cpc, descending');

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

// Live 2026-09-03, platform-49 run 10: the model asked for
// `toulu_016PctF8QXsnvKo5ZKasu1ri` — a two-letter transposition of `toolu_…` —
// and got a bare "no tool output found". The harness knew every real id. Run 5
// proved the opposite: an exact correction repaired the very next frame.
test('a near-miss call_id gets the exact correction, not a dead end', async () => {
  const { nearestToolOutputCallId } = await import('./recall-tools.js');
  const known = [
    'toolu_016PctF8QXsnvKo5ZKasu1ri',
    'toolu_01ZZZZZZZZZZZZZZZZZZZZZZ',
  ];
  // The exact slip from the live run.
  assert.equal(
    nearestToolOutputCallId('toulu_016PctF8QXsnvKo5ZKasu1ri', known),
    'toolu_016PctF8QXsnvKo5ZKasu1ri',
  );
  // An id that already exists needs no correction.
  assert.equal(nearestToolOutputCallId('toolu_016PctF8QXsnvKo5ZKasu1ri', known), null);
  // A genuinely different id is never "corrected" into someone else's result —
  // guessing a DIFFERENT result is worse than saying it is missing.
  assert.equal(nearestToolOutputCallId('call_completely_unrelated_9', known), null);
  assert.equal(nearestToolOutputCallId('', known), null);
  assert.equal(nearestToolOutputCallId('toolu_016PctF8QXsnvKo5ZKasu1ri', []), null);
});


for (const sealed of [false, true]) test(`MCP metadata fields are queryable through their JSON carrier (sealed=${sealed})`, async () => {
  const session = createSession({ kind: 'chat' });
  const payload = { path: '/v3/visibility/live', method: 'POST', bodySchema: { type: 'array', items: { type: 'object', required: ['target'], properties: { target: { type: 'string' } } } }, documentation: 'A long API reference. '.repeat(5000) };
  const envelope = { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  const original = JSON.stringify(sealed ? { result: envelope, complete: true } : envelope);
  writeToolOutput({ sessionId: session.id, callId: 'nested-api', tool: 'work_call', output: original });
  const query = captureToolOutputQueryHandler();
  const result = await withHarnessRunContext({ sessionId: session.id, counter: new ToolCallsCounter(10) },
    () => query({ call_id: 'nested-api', fields: ['path', 'method', 'bodySchema'] }));
  const text = result.content[0].text;
  assert.match(text, /visibility\/live/); assert.match(text, /"target"/);
  assert.doesNotMatch(text, /None of|long API reference|clipped/);
  assert.ok(text.length < 1500, 'project only the requested schema instead of paging a 100KB transport string');
  assert.doesNotMatch(text, /\$fromToolOutput/, 'a decoded payload path must not be advertised as a raw-envelope path');
  const { getToolOutput } = await import('../runtime/harness/eventlog.js');
  assert.equal(getToolOutput(session.id, 'nested-api')?.output, original, 'raw retained bytes remain unchanged');
  const raw = await withHarnessRunContext({ sessionId: session.id, counter: new ToolCallsCounter(10) },
    () => query({ call_id: 'nested-api', fields: [sealed ? 'complete' : 'content'] }));
  assert.match(raw.content[0].text, new RegExp('"' + (sealed ? 'complete' : 'content') + '"'), 'explicit transport-field queries retain the original view');
});

test('MCP record queries decode one owner and never select a conflicting or failed payload', async () => {
  const session = createSession({ kind: 'chat' });
  const query = captureToolOutputQueryHandler();
  const run = async (callId: string, value: unknown, fields: string[], options = {}) => {
    writeToolOutput({ sessionId: session.id, callId, tool: 'work_call', output: JSON.stringify(value) });
    const result = await withHarnessRunContext({ sessionId: session.id, counter: new ToolCallsCounter(10) },
      () => query({ call_id: callId, fields, ...options }));
    return result.content[0].text;
  };
  const rows = [{ id: 'first', count: 7 }, { id: 'second', count: 9 }, { id: 'third', count: 11 }];
  const records = await run('mcp-records', { result: { content: [{ type: 'text', text: JSON.stringify(rows) }] }, complete: true }, ['id'], { offset: 1, limit: 1 });
  assert.match(records, /"second"/); assert.doesNotMatch(records, /"first"|"third"|\$fromToolOutput/);
  const payload = { path: '/exact', method: 'GET' };
  const same = await run('agreeing-owners', { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload }, ['path']);
  assert.match(same, /"path": "\/exact"/);
  for (const [callId, envelope] of [
    ['conflicting-owners', { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: { path: '/different' } }],
    ['failed-owner', { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true }],
    ['ordinary-business-object', { content: [{ type: 'text', text: JSON.stringify(payload) }], invoiceId: 'not-an-mcp-envelope' }],
  ] as const) {
    const text = await run(callId, envelope, ['path']);
    assert.match(text, /None of/); assert.doesNotMatch(text, /"path": "\/exact"/, 'do not promote failed, ambiguous or merely similar transport bytes');
  }
});

test('tool_output_query given a capability reference redirects to the carrier and lists real results — never a bare "not found" (live 277962)', async () => {
  resetEventLog();
  const session = createSession({ kind: 'chat' });
  writeToolOutput({ sessionId: session.id, callId: 'call-real-1', tool: 'work_call', output: JSON.stringify({ items: [{ subject: 'Standup' }] }) });
  // A reader's own miss is retained too; it must not be listed back as data.
  writeToolOutput({ sessionId: session.id, callId: 'call-miss-1', tool: 'tool_output_query', output: 'No tool output found for call_id "x" in this session.' });
  const query = captureToolOutputQueryHandler();
  const ref = 'cap:resolved:outlook_get_calendar_view:definition:890911f634558ec9c128fad4';
  const result = await withHarnessRunContext({ sessionId: session.id, counter: new ToolCallsCounter(10) },
    () => query({ call_id: ref, fields: [], limit: 1, offset: 0, filter_field: 'dummy', filter_contains: 'dummy', filter_equals: 'dummy' }));
  const text = result.content[0].text;
  assert.match(text, /CAPABILITY reference, not a result handle/);
  // No live catalog in this test → the honest door is discovery.
  assert.match(text, /tool_search/);
  assert.match(text, /call-real-1 \(work_call/);
  assert.doesNotMatch(text, /call-miss-1/);
  assert.doesNotMatch(text, /^No tool output found/);

  const recall = captureRecallHandler();
  const recalled = await withHarnessRunContext({ sessionId: session.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 60_000) },
    () => recall({ call_id: ref }));
  assert.match(recalled.content[0].text, /CAPABILITY reference, not a result handle/);
});

test('query projects records from an unfamiliar single-array envelope without paging raw output', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const rows = Array.from({ length: 114 }, (_, i) => ({ name: `Fixture ${i}`, details: 'x'.repeat(300) }));
  writeToolOutput({ sessionId: sess.id, callId: 'unknown-envelope', tool: 'fixture_list',
    output: JSON.stringify({ total: rows.length, arbitraryCollection: rows }) });
  const query = captureToolOutputQueryHandler();
  const res = await withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 200_000) },
    () => query({ call_id: 'unknown-envelope', fields: ['name'], limit: 200 }),
  );
  const text = res.content[0].text;
  assert.match(text, /114 total from arbitraryCollection/);
  assert.match(text, /Fixture 113/);
  assert.doesNotMatch(text, /details|None of/);
});

test('tool_output_query computes exact counts, rankings and totals over every stored record', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const keywords = Array.from({ length: 120 }, (_, i) => ({
    keyword: `fixture keyword ${i}`,
    position: i % 40 === 0 ? null : (i % 37) + 1,
    volume: (i * 7919) % 5000,
  }));
  writeToolOutput({ sessionId: sess.id, callId: 'call_rankings', tool: 'composio_execute_tool', output: JSON.stringify({ data: { items: keywords } }) });
  const deals = [
    { name: 'Fixture deal 1', stage: 'Closed Won', owner: 'Rep One', amount: 1200, closed: '2026-09-22' },
    { name: 'Fixture deal 2', stage: 'closed won', owner: 'Rep Two', amount: '3,230', closed: '2026-09-24' },
    { name: 'Fixture deal 3', stage: 'Closed Won', owner: 'Rep One', amount: 900, closed: '2026-09-12' },
    { name: 'Fixture deal 4', stage: 'Negotiation', owner: 'Rep Two', amount: 5000, closed: '2026-09-23' },
  ];
  writeToolOutput({ sessionId: sess.id, callId: 'call_deals', tool: 'composio_execute_tool', output: JSON.stringify(deals) });
  const query = captureToolOutputQueryHandler();
  const run = (input: Record<string, unknown>) => withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(20), recallBudget: new RecallBudget(10, 200_000) },
    () => query(input),
  ).then((res) => res.content[0].text);

  const expectedTop3 = keywords.filter((row) => typeof row.position === 'number' && row.position <= 3).length;
  const count = await run({ call_id: 'call_rankings', where: [{ field: 'position', op: 'lte', value: 3 }], aggregate: 'count' });
  assert.match(count, new RegExp(`count = ${expectedTop3}\\b`), 'the count is computed over all 120 records, not a page');
  assert.match(count, /of 120 total from data\.items\[\*\]/, 'the provider wrapper is unwrapped for aggregates too');
  assert.match(count, /3 record\(s\) were left out/, 'records with no position are named as left out');

  const top = await run({ call_id: 'call_rankings', sort_by: 'volume', order: 'desc', limit: 3, fields: ['keyword', 'volume'] });
  const expected = [...keywords].sort((a, b) => b.volume - a.volume).slice(0, 3).map((row) => row.keyword);
  for (const keyword of expected) assert.ok(top.includes(keyword), `${keyword} is in the exact top 3`);
  assert.match(top, /ordered by volume descending/);

  const closedThisWeek = await run({
    call_id: 'call_deals',
    where: [{ field: 'stage', op: 'eq', value: 'closed won' }, { field: 'closed', op: 'gte', value: '2026-09-21' }],
    aggregate: 'sum', value_field: 'amount', group_by: 'owner',
  });
  assert.match(closedThisWeek, /sum of amount = 4430 \(over 2 record\(s\)\)/);
  assert.match(closedThisWeek, /Rep Two: sum of amount = 3230[\s\S]*Rep One: sum of amount = 1200/, 'groups come largest first');

  const missingField = await run({ call_id: 'call_deals', aggregate: 'sum' });
  assert.match(missingField, /needs value_field/);
});

test('tool_output_query refuses an exact figure over a clipped prefix instead of stating a partial one', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  writeToolOutput({
    sessionId: sess.id,
    callId: 'call_clipped_rows',
    tool: 'run_shell_command',
    output: ['exit_code: 0', '', 'stdout:', '[', '{"id":"a","amount":5},', '{"id":"b","amount":7},', '{"id":"partial"'].join('\n'),
  });
  const query = captureToolOutputQueryHandler();
  const run = (input: Record<string, unknown>) => withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(5, 200_000) },
    () => query(input),
  ).then((res) => res.content[0].text);
  assert.match(await run({ call_id: 'call_clipped_rows', aggregate: 'sum', value_field: 'amount' }), /needs the complete set/);
  assert.match(await run({ call_id: 'call_clipped_rows', sort_by: 'amount' }), /needs the complete set/);
  assert.match(await run({ call_id: 'call_clipped_rows', filter_field: 'id', filter_equals: 'b' }), /full total unknown/,
    'a plain lookup over the recovered records still works and says the total is unknown');
});

test('a displayed aggregate carries the figure, not floating-point noise, and keeps tiny values', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  writeToolOutput({ sessionId: sess.id, callId: 'call_cents', tool: 'composio_execute_tool',
    output: JSON.stringify([{ amount: 0.1 }, { amount: 0.2 }, { amount: 1200.1 }, { amount: 3230.2 }]) });
  writeToolOutput({ sessionId: sess.id, callId: 'call_tiny', tool: 'composio_execute_tool',
    output: JSON.stringify([{ share: 0.000000000001 }, { share: 0.000000000002 }]) });
  const query = captureToolOutputQueryHandler();
  const run = (input: Record<string, unknown>) => withHarnessRunContext(
    { sessionId: sess.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(5, 200_000) },
    () => query(input),
  ).then((res) => res.content[0].text);
  assert.match(await run({ call_id: 'call_cents', aggregate: 'sum', value_field: 'amount' }), /sum of amount = 4430\.6 \(/,
    'the model reads 4430.6, never 4430.599999999999');
  assert.match(await run({ call_id: 'call_tiny', aggregate: 'sum', value_field: 'share' }), /sum of share = 3e-12 \(/,
    'a very small figure is still shown, not rounded to 0');
});


test('tool_output_query ranks a saved Space dataset without another provider pull', async () => {
  const session = createSession({ kind: 'chat' });
  const output = 'Workspace "Stored analysis" (stored-analysis) — active, v1.\nView source: space_get_view({slug:"stored-analysis"}) returns HTML.\nSnapshot revision: fixture\nContent mode: static_snapshot.\nDataset (complete JSON): {"rows":[{"term":"low","cpc":0.12},{"term":"high","cpc":197.11},{"term":"middle","cpc":140.32}]}\nNo notes yet.';
  writeToolOutput({ sessionId: session.id, callId: 'saved-space-query', tool: 'space_get', output });
  const result = await withHarnessRunContext({ sessionId: session.id, counter: new ToolCallsCounter(10), recallBudget: new RecallBudget(3, 60_000) },
    () => captureToolOutputQueryHandler()({ call_id: 'saved-space-query', fields: ['term', 'cpc'], sort_by: 'cpc', order: 'desc', limit: 2 }));
  const text = result.content[0].text;
  assert.match(text, /high/);
  assert.match(text, /197\.11/);
  assert.match(text, /140\.32/);
  assert.doesNotMatch(text, /No JSON|not structured|"low"/);
});


test('actual shell reader does not turn a CLI help example into a customer result', async () => {
  const session = createSession({ kind: 'chat' });
  writeToolOutput({ sessionId: session.id, callId: 'shell-example', tool: 'run_shell_command',
    output: 'exit_code: 0\n\nstdout:\nExample request: {"email":"sample@example.test"}\nActual lookup returned no customer.' });
  const result = await withHarnessRunContext({ sessionId: session.id, counter: new ToolCallsCounter(10) },
    () => captureToolOutputQueryHandler()({ call_id: 'shell-example', fields: ['email'] }));
  assert.match(result.content[0].text, /No JSON value could be recovered/);
  assert.doesNotMatch(result.content[0].text, /sample@example\.test/);
});
