/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/mcp-reader-transport-cap.test.ts
 *
 * The Claude CLI cuts an MCP tool reply over its own output-token cap and
 * marks it truncated, so a reply that crossed that wire too big lost its tail
 * silently. Every reply on the Claude lane's MCP carrier stays within
 * MCP_TRANSPORT_MAX_CHARS; a larger presentation (an explicit local read
 * preview) is cut by the carrier with its own marker. Readers size their own
 * slice under the same bound (presentation-budget.test.ts).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-mcp-reader-transport-cap-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  createClementineMcpServer,
  initializeClementineMcpCapabilityAuthority,
} = await import('./mcp-server.js');
const events = await import('../runtime/harness/eventlog.js');
const brackets = await import('../runtime/harness/brackets.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const { recordCatalogWindow } = await import('../runtime/harness/model-window-observations.js');
const { MCP_TRANSPORT_MAX_CHARS } = await import('../runtime/harness/tool-output-format.js');

after(() => {
  events.closeEventLog();
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

const LARGE_WINDOW_MODEL = 'fixture-mcp-large-window-model';
recordCatalogWindow(LARGE_WINDOW_MODEL, 1_000_000, 'fixture');

/** 150 numbered ~1k blocks: any dropped span is visible by block number. */
const PARKED = Array.from({ length: 150 }, (_, i) => `[block ${String(i).padStart(3, '0')}] ${'r'.repeat(987)}`).join('\n');

type Registered = Record<string, {
  handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}>;

async function registeredServer(allowedTools: string[], deferredTools: string[]) {
  const session = events.createSession({ kind: 'chat' });
  const source = events.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'read the parked fixture result in full' },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: session.id, turn: source.turn, sourceUserSeq: source.seq },
  }), 'fixture persisted the turn graph for the accepted task');
  events.writeToolOutput({ sessionId: session.id, callId: 'parked-read', tool: 'space_get', output: PARKED });
  const server = createClementineMcpServer({
    sessionId: session.id, sourceUserSeq: source.seq, allowedTools, deferredTools,
  });
  assert.equal(await initializeClementineMcpCapabilityAuthority(server), true);
  const registered = (server as unknown as { _registeredTools: Registered })._registeredTools;
  const call = (tool: string, input: Record<string, unknown>) => {
    assert.ok(registered[tool], `${tool} is registered on the MCP server`);
    return brackets.withHarnessRunContext({
      sessionId: session.id, sourceUserSeq: source.seq, counter: new brackets.ToolCallsCounter(10),
      recallBudget: new brackets.RecallBudget(10, 2_000_000, session.id), routedModelId: LARGE_WINDOW_MODEL,
    }, () => registered[tool]!.handler(input));
  };
  return { call };
}

test('the MCP call_tool carrier never sends more than the CLI carries whole, and says where it cut', async () => {
  const filePath = path.join(TMP_HOME, 'fixture-large-read.txt');
  writeFileSync(filePath, PARKED, 'utf8');
  const { call } = await registeredServer(['tool_search', 'call_tool'], ['read_file']);
  const result = await call('call_tool', {
    name: 'read_file',
    args_json: JSON.stringify({ path: filePath, max_chars: 90_000 }),
  });
  const shown = result.content[0]?.text ?? '';
  assert.notEqual(result.isError, true, shown.slice(0, 300));
  assert.ok(shown.includes('[block 000]'), shown.slice(0, 300));
  assert.ok(shown.length <= MCP_TRANSPORT_MAX_CHARS + 200,
    `the carrier reply fits the CLI wire (${shown.length} chars, cap ${MCP_TRANSPORT_MAX_CHARS})`);
  assert.match(shown, /\[truncated —|middle omitted|omitted/, 'the cut is marked by the carrier, not left to the CLI');
});
