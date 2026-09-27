/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/claude-work-call-transport-budget.test.ts
 *
 * The Claude lane's registered work_call MCP transport is a backstop over a
 * result the inner invocation already presented; it never cuts below that
 * invocation's own budget. A local read whose caller asked for a preview
 * larger than the default reaches the model at that preview, not re-clipped
 * by the wire. Drives the real SDK surface: the production permission seam
 * admits the call, then the registered work_call handler dispatches it.
 *
 * Regression: the child honored an explicit 40,000-char read preview, then
 * the MCP wire clipped it at the fixed 20,000-char default.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-claude-work-call-transport-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.AUTH_MODE = 'claude_oauth';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
process.env.CLEMMY_CLAUDE_SDK_INPROCESS_MCP = 'on';
process.env.CLEMMY_CLAUDE_TOOL_SEARCH = 'on';
process.env.CLEMMY_CLAUDE_SDK_REFLECTION = 'off';
process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
process.env.CLEMMY_CLAUDE_SDK_SESSION_HISTORY = 'off';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const acceptedAuthority = await import('./accepted-task-authority.js');
const expectedWork = await import('./expected-work-contract.js');
const actionBoundary = await import('./action-expected-work-boundary.js');
const sdk = await import('./claude-agent-sdk.js');

after(() => {
  sdk.setClaudeAgentSdkQueryForTest(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function writeClaudeToken(): void {
  writeFileSync(path.join(TMP_HOME, 'state', 'claude-auth.json'), JSON.stringify({
    accessToken: 'sk-ant-oat01-transport-budget-test',
    refreshToken: 'refresh-transport-budget-test',
    expiresAt: Date.now() + 60 * 60 * 1000,
    scopes: ['user:inference'],
  }), 'utf8');
}

/** An accepted act source with its action expected-work activated, so the
 * Claude surface mounts work_call. */
function prepareActSource(text: string): { sessionId: string; sourceUserSeq: number } {
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop' });
  const source = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text },
  });
  const recorded = shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, turn: 1, sourceUserSeq: source.seq },
    surface: 'home',
  });
  assert.ok(recorded);
  const graph = shadow.turnGraphFromShadowEvent(recorded);
  assert.ok(graph);
  assert.equal(graph.classification.route, 'act', 'fixture source classifies as an action');
  acceptedAuthority.requireAcceptedTaskAuthority({ sessionId: session.id, sourceUserSeq: source.seq });
  const known = expectedWork.requireKnownExpectedWorkContract({ sessionId: session.id, sourceUserSeq: source.seq });
  if (known.status === 'action_deferred' || known.status === 'bound') {
    actionBoundary.requireActionExpectedWorkActivation({ sessionId: session.id, sourceUserSeq: source.seq });
  }
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

function initMessage(): SDKMessage {
  return {
    type: 'system', subtype: 'init', model: 'fixture-model', session_id: 'sdk-transport-budget',
    uuid: 'sdk-transport-budget-init', apiKeySource: 'none', claude_code_version: '2.1.181',
    cwd: process.cwd(), tools: ['mcp__clementine-local__work_call'],
    mcp_servers: [{ name: 'clementine-local', status: 'connected' }], permissionMode: 'default',
    slash_commands: [], output_style: 'default', skills: [], plugins: [],
  } as SDKMessage;
}

function resultMessage(): SDKMessage {
  return {
    type: 'result', subtype: 'success', session_id: 'sdk-transport-budget', uuid: 'sdk-transport-budget-result',
    result: 'Read.', duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, stop_reason: 'end_turn',
    total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [],
  } as SDKMessage;
}

/** Numbered ~1k lines: any dropped span is visible by line number. */
const FILE_TEXT = Array.from({ length: 60 }, (_, i) => `[line ${String(i).padStart(2, '0')}] ${'f'.repeat(988)}`).join('\n');
const PREVIEW_CHARS = 40_000;

test('an explicit large read preview through the registered work_call MCP transport is not re-clipped', async () => {
  writeClaudeToken();
  const filePath = path.join(TMP_HOME, 'fixture-large-read.txt');
  writeFileSync(filePath, FILE_TEXT, 'utf8');
  const task = prepareActSource('Read the alpha source and write every record into a new report.');
  const input = {
    proposal: null,
    requirement_id: 'read-source',
    universe_item_id: null,
    universe_selector: null,
    name: 'read_file',
    args_json: JSON.stringify({ path: filePath, max_chars: PREVIEW_CHARS }),
  };
  let permission: { behavior?: string } | undefined;
  let admitted: { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
  sdk.setClaudeAgentSdkQueryForTest(((params: any) => {
    const generator = (async function* () {
      yield initMessage();
      permission = await params.options.canUseTool(
        'mcp__clementine-local__work_call',
        input,
        { signal: new AbortController().signal, toolUseID: 'toolu-transport-budget-read' },
      );
      const registered = params.options.mcpServers['clementine-local'].instance._registeredTools as Record<string, any>;
      admitted = await registered.work_call.handler(input);
      yield resultMessage();
    })();
    return Object.assign(generator, {
      close() {}, interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {},
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }), streamInput: async () => {},
      stopTask: async () => false, backgroundTasks: async () => false,
    }) as Query;
  }) as never);

  await sdk.runClaudeAgentSdk({
    prompt: 'Read the alpha source and write every record into a new report.',
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    trackerScopeId: `${task.sessionId}::worker:transport-budget`,
    agentic: true,
    workerScope: true,
    directOrchestrator: false,
    allowedLocalMcpTools: ['mcp_list_tools', 'read_file'],
    localMcpToolUniverse: ['mcp_list_tools', 'read_file'],
  });

  assert.equal(permission?.behavior, 'allow');
  const shown = String(admitted?.content?.[0]?.text ?? '');
  assert.notEqual(admitted?.isError, true, shown.slice(0, 400));
  assert.ok(shown.includes(FILE_TEXT.slice(0, 1_000)), `the read itself ran (${shown.slice(0, 300)})`);
  assert.ok(!/\[truncated —/.test(shown), `the MCP wire did not clip the preview (shown ${shown.length} chars)`);
  assert.ok(shown.length > 30_000,
    `the requested ${PREVIEW_CHARS}-char preview reaches the model (shown ${shown.length} chars)`);
  // The child's own 40,000-char preview of the 60,000-char file: its head
  // runs well past the default budget and it names its own recall handle.
  assert.ok(shown.includes(FILE_TEXT.slice(15_000, 25_000)),
    'text past the default budget reaches the model');
  assert.match(shown, /recall_tool_result \{"call_id":"toolu-transport-budget-read"\}/,
    'the child\'s own preview, with its recall handle, is what arrives');
});
