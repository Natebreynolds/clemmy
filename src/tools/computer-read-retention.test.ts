import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-complete-read-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(testHome, 'state'), { recursive: true });
const { getComputerTools } = await import('./computer-tools.js');
const { registerRecallTools } = await import('./recall-tools.js');
const { createSession, closeEventLog, getToolOutput } = await import('../runtime/harness/eventlog.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { exactToolOutputForInvocation } = await import('../runtime/harness/tool-output-format.js');
const { withHarnessRunContext, ToolCallsCounter } = await import('../runtime/harness/brackets.js');

test.after(() => { closeEventLog(); rmSync(testHome, { recursive: true, force: true }); });

for (const preview of [null, 2_000, 80_000]) test(`read_file retains every record when preview max_chars=${preview}`, async () => {
  const session = createSession({ kind: 'chat' });
  const records = Array.from({ length: 50 }, (_, index) => ({
    Id: randomUUID(), Name: `Account ${index + 1}`, Email: `${randomUUID()}@example.test`,
    Metadata: 'Provider metadata. '.repeat(100),
  }));
  const raw = JSON.stringify({ result: { version: 1, status: 'exited', operationId: 'salesforce_sf_soql_query',
    executableRealpath: '/usr/local/bin/sf', argv: ['data', 'query', '--json'], exitCode: 0,
    stdoutTruncated: false, stdout: JSON.stringify({ result: { records, totalSize: 50, done: true } }) }, complete: true });
  assert.ok(raw.length > 80_000);
  const file = path.join(testHome, `${session.id}.json`);
  writeFileSync(file, raw);
  const callId = `read-${session.id}`, nonce = randomUUID();
  const reader = getComputerTools().find(t => t.name === 'read_file') as unknown as {
    invoke(context: unknown, input: string, details: unknown): Promise<string>;
  };
  const visible = await withToolOutputContext({ sessionId: session.id, callId, toolName: 'read_file', settlementNonce: nonce },
    () => reader.invoke({ context: { sessionId: session.id, turn: 1 } }, JSON.stringify({ path: file, max_chars: preview }), { toolCall: { callId } }));
  const parked = getToolOutput(session.id, callId);
  assert.equal(parked?.output.length, raw.length, 'the complete bytes must be parked before display clipping');
  assert.equal(parked?.output === raw, true, 'no injected widening note or missing tail');
  assert.equal(exactToolOutputForInvocation({ sessionId: session.id, callId, toolName: 'read_file', compactResult: visible, settlementNonce: nonce }) === raw, true);
  closeEventLog();
  let query: ((args: unknown) => Promise<any>) | undefined;
  registerRecallTools({ tool: (name: string, _description: unknown, _schema: unknown, handler: any) => {
    if (name === 'tool_output_query') query = handler;
  } } as any);
  assert.ok(query);
  const response = await withHarnessRunContext({ sessionId: session.id, turn: 2, toolCalls: new ToolCallsCounter(10) },
    () => query!({ call_id: callId, fields: ['Id', 'Email'], limit: 50 }));
  const text = response.content[0].text;
  assert.match(text, /Showing 50 record/);
  for (const record of records) assert.ok(text.includes(record.Email), 'every opaque address must remain queryable after reopen');
});
