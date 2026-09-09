import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-memory-read-retention-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
mkdirSync(path.join(TEST_HOME, 'vault'), { recursive: true });

const { registerMemoryTools } = await import('./memory-tools.js');
const { registerRecallTools } = await import('./recall-tools.js');
const { closeEventLog, createSession, getToolOutput, getToolOutputForInvocation, resetEventLog } =
  await import('../runtime/harness/eventlog.js');
const { RecallBudget, ToolCallsCounter, withHarnessRunContext } =
  await import('../runtime/harness/brackets.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { DEFAULT_TOOL_RESULT_MAX_CHARS } = await import('../runtime/harness/tool-output-format.js');

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
const handlers = new Map<string, Handler>();
const server = {
  tool(name: string, ...args: unknown[]) {
    const handler = args.at(-1);
    assert.equal(typeof handler, 'function');
    handlers.set(name, handler as Handler);
  },
};
registerMemoryTools(server as never);
registerRecallTools(server as never);
const read = handlers.get('memory_read')!;
const recall = handlers.get('recall_tool_result')!;

test.beforeEach(() => resetEventLog());
test.after(() => {
  closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('memory_read returns text beyond the former 12K file cutoff when it fits the model projection', async () => {
  const content = `${'A'.repeat(15_000)}\nTail: preserve this final sentence.\n`;
  writeFileSync(path.join(TEST_HOME, 'vault', 'medium-memory.md'), content);

  const result = await read({ target: 'medium-memory.md' });

  assert.equal(result.content[0].text, content);
});

test('memory_read retains the complete file and recalls its exact tail after reopening the store', async () => {
  const session = createSession({ kind: 'chat' });
  const callId = 'call_memory_read_complete_file';
  const nonce = randomUUID();
  const prefix = 'Earlier context: retain the original bytes.\n'.repeat(900);
  const tail = 'Final decision: café — use “Juniper”, exactly!\nKeep this line break.\n'.repeat(4);
  const content = prefix + tail;
  const filePath = path.join(TEST_HOME, 'vault', 'long-memory.md');
  assert.ok(prefix.length > DEFAULT_TOOL_RESULT_MAX_CHARS);
  writeFileSync(filePath, content);

  const result = await withToolOutputContext(
    { sessionId: session.id, callId, toolName: 'memory_read', settlementNonce: nonce },
    () => read({ target: 'long-memory.md' }),
  );
  const visible = result.content[0].text;
  assert.ok(visible.length <= DEFAULT_TOOL_RESULT_MAX_CHARS, 'the model receives a bounded projection');
  assert.match(visible, /recall_tool_result/);
  assert.ok(visible.includes(callId), 'the projection identifies the stored result for paging');
  assert.match(visible, /exact-output-receipt:v1/);
  const stored = getToolOutputForInvocation(session.id, callId, nonce);
  assert.ok(stored);
  assert.equal(stored.output, content, 'retention must happen before any file cutoff');
  assert.equal(stored.contentBytes, Buffer.byteLength(content));
  assert.equal(stored.truncatedAtWrite, false);

  // Recovery uses the original durable output, even if the source file is gone.
  unlinkSync(filePath);
  closeEventLog();
  assert.equal(getToolOutput(session.id, callId)?.output, content);
  const recovered = await withHarnessRunContext(
    { sessionId: session.id, counter: new ToolCallsCounter(5), recallBudget: new RecallBudget(3, 60_000) },
    () => recall({ call_id: callId, offset: prefix.length, max_chars: 1_000 }),
  );
  assert.ok(recovered.content[0].text.endsWith(tail), 'the real recall tool returns the complete original tail');
  assert.ok(recovered.content[0].text.includes(`of ${content.length}`));
  assert.doesNotMatch(recovered.content[0].text, /more remains/);

  const otherSession = createSession({ kind: 'chat' });
  const unrelated = await withHarnessRunContext(
    { sessionId: otherSession.id, counter: new ToolCallsCounter(5), recallBudget: new RecallBudget(3, 60_000) },
    () => recall({ call_id: callId, offset: prefix.length, max_chars: 1_000 }),
  );
  assert.ok(!unrelated.content[0].text.includes(tail), 'retaining full text does not enable cross-session recall');
});

test('memory_read without a harness output identity stays bounded and explicitly reports omission', async () => {
  const content = 'Unscoped memory content.\n'.repeat(2_000);
  writeFileSync(path.join(TEST_HOME, 'vault', 'unscoped-memory.md'), content);

  const result = await read({ target: 'unscoped-memory.md' });

  assert.ok(result.content[0].text.length <= DEFAULT_TOOL_RESULT_MAX_CHARS);
  assert.match(result.content[0].text, /chars omitted/);
  assert.doesNotMatch(result.content[0].text, /recall_tool_result/);
});
