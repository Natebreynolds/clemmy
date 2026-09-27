/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/mcp-carrier-transport-budget.test.ts
 *
 * The Claude lane's in-process MCP carrier transports (call_tool, work_call)
 * are a backstop over a result the inner invocation already presented. They
 * never cut below that invocation's own budget: a recall slice the reader
 * shaped whole reaches the model whole, with a paging frame whose next offset
 * is exactly where the shown slice ends.
 *
 * Regression: the recall child returned its whole 20,000-char slice, then the
 * MCP wire clipped it at the fixed 20,000-char default (header included), so
 * the header still said "Recalled chars 0–20000" and "continue at 20000" while
 * the last ~340 chars were dropped; an explicit 30,000-char recall lost 10,340.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-mcp-carrier-transport-'));
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
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');

after(() => {
  events.closeEventLog();
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** 50 numbered ~1k blocks: any dropped span is visible by block number. */
const PARKED = Array.from({ length: 50 }, (_, i) => `[block ${String(i).padStart(2, '0')}] ${'r'.repeat(988)}`).join('\n');

function anchoredSession(ask: string): { sessionId: string; sourceUserSeq: number } {
  const session = events.createSession({ kind: 'chat' });
  const source = events.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: ask },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: session.id, turn: source.turn, sourceUserSeq: source.seq },
  }), 'fixture persisted the turn graph for the accepted task');
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

type Registered = Record<string, {
  handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}>;

test('a recall through the registered MCP call_tool arrives whole with an exact next offset', async () => {
  const anchor = anchoredSession('read the parked fixture result in full');
  events.writeToolOutput({
    sessionId: anchor.sessionId, callId: 'parked-read', tool: 'space_get', output: PARKED,
  });
  const server = createClementineMcpServer({
    sessionId: anchor.sessionId,
    sourceUserSeq: anchor.sourceUserSeq,
    allowedTools: ['tool_search', 'call_tool'],
    deferredTools: ['recall_tool_result'],
  });
  assert.equal(await initializeClementineMcpCapabilityAuthority(server), true);
  const registered = (server as unknown as { _registeredTools: Registered })._registeredTools;
  assert.ok(registered.call_tool);

  for (const [args, sliceEnd] of [[{}, 20_000], [{ max_chars: 30_000 }, 30_000]] as const) {
    const result = await registered.call_tool.handler({
      name: 'recall_tool_result',
      args_json: JSON.stringify({ call_id: 'parked-read', ...args }),
    });
    const shown = result.content[0]?.text ?? '';
    assert.notEqual(result.isError, true, shown.slice(0, 300));
    assert.match(shown, new RegExp(`Recalled chars 0–${sliceEnd} of ${PARKED.length}`),
      `the recall itself ran (${shown.slice(0, 200)})`);
    assert.match(shown, new RegExp(`"offset":${sliceEnd}`), 'the paging frame names the next offset');
    assert.ok(!/\[truncated —/.test(shown),
      `the MCP wire did not clip the slice (shown ${shown.length} chars, args ${JSON.stringify(args)})`);
    assert.ok(shown.endsWith(PARKED.slice(0, sliceEnd)),
      `the whole slice up to the named next offset reaches the model (shown ${shown.length} chars, slice ${sliceEnd})`);
  }
});
