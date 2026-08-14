/**
 * A conversational ping is a respond-typed turn: the model-composed reply IS
 * the response. It completes with zero business tool settlements, is
 * publishable without any work evidence (GUARD), and its Claude-lane surface
 * must never be stripped to the work_call-only action carrier (RED): forcing
 * a respond turn through the action carrier leaves it no door but a
 * fabricated work operation (live 2026-08-11 dev-daemon smoke: a plain ping
 * turn entered the act machinery).
 *
 * The red pin is written against the shared typed effect decision every lane
 * asks: claudeActionExpectedWorkRequired must answer false for a turn whose
 * decision is respond/read, so the carrier stripping never fires.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-ping-carrier-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.AUTH_MODE = 'claude_oauth';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_CLAUDE_SDK_INPROCESS_MCP = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-ping-carrier\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const admission = await import('./expected-work-admission.js');
const preparation = await import('./accepted-task-terminal-preparation.js');
const sdk = await import('./claude-agent-sdk.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function acceptPing() {
  const session = eventlog.createSession({ id: `ping-carrier-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'ping' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  // Mirror the production spine: an act-classified turn is durably activated
  // before the surface is built. A respond-typed decision makes this a no-op
  // (not_action) — the fixture tolerates both so only the target assertions
  // can fail.
  const activated = admission.activateActionExpectedWork({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.ok(
    activated.status === 'activated'
    || activated.status === 'replayed'
    || activated.status === 'not_action',
    JSON.stringify(activated),
  );
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

// GUARD: publishable with zero settlements — the reply is the terminal.
test('a pure conversational ping publishes with zero business tool settlements', () => {
  const task = acceptPing();
  const prepared = preparation.prepareAcceptedTaskTerminal({
    ...task,
    proposedReply: 'pong',
  });
  assert.ok(
    prepared.status === 'ready' || prepared.status === 'unstaged',
    'a ping turn needs no work evidence to complete: ' + JSON.stringify(prepared),
  );
  const settlements = (eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as { n: number }).n;
  assert.equal(settlements, 0, 'the ping turn settled no business calls');
});

// RED: the Claude-lane surface must not collapse to the work_call carrier.
test('a respond-typed ping turn never mounts the work_call-only action carrier surface', () => {
  const task = acceptPing();
  const carrierRequired = sdk.claudeActionExpectedWorkRequired(task);
  assert.equal(
    carrierRequired,
    false,
    'the shared effect decision for a conversational ping is respond, so the '
    + 'Claude lane must not strip business tools to the work_call carrier',
  );
  const servers = sdk.buildClaudeAgentSdkLocalMcpServers(
    task.sessionId,
    true,
    ['memory_search', 'mcp_list_tools'],
    {
      sourceUserSeq: task.sourceUserSeq,
      directOrchestrator: true,
      actionExpectedWork: carrierRequired,
    },
  );
  const registered = (servers['clementine-local'] as unknown as {
    instance: { _registeredTools: Record<string, unknown> };
  }).instance._registeredTools;
  assert.equal(
    registered.work_call,
    undefined,
    'a respond-typed turn does not expose the bound action carrier',
  );
  assert.ok(registered.memory_search, 'ordinary recall stays first-class on a respond turn');
});
