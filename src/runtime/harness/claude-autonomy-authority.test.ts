/**
 * Red-first release contract for decision-only autonomy on Claude OAuth.
 *
 * The Claude cron route bypasses buildOrchestratorAgent and dispatches straight
 * to the Claude Agent SDK brain. An empty per-call allowlist must therefore
 * close that SDK surface itself; proving only the normal harness builder is not
 * sufficient.
 *
 * Run:
 *   npx tsx --test src/runtime/harness/claude-autonomy-authority.test.ts
 */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-autonomy-authority-'));
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  respondViaClaudeAgentSdkBrain,
  setClaudeAgentSdkBrainJudgeForTest,
  setClaudeAgentSdkBrainRunForTest,
  setClaudeAgentSdkBrainUnifiedPrimerForTest,
} = await import('./claude-agent-brain.js');
const {
  _setBridgeImplsForTests,
  respondPreferHarness,
} = await import('./respond-bridge.js');
const { resetEventLog } = await import('./eventlog.js');

beforeEach(() => {
  resetEventLog();
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    claudeAgentBrain: respondViaClaudeAgentSdkBrain,
  });
  setClaudeAgentSdkBrainRunForTest(null);
  setClaudeAgentSdkBrainJudgeForTest(null);
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query) => ({
    objective: query,
    hits: [],
    perStore: {},
    answerability: 'insufficient',
    diagnostics: { candidates: 0, stores: [], elapsedMs: 0 },
  }));
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_TOOL_SEARCH = 'on';
  process.env.CLEMMY_TOOL_JIT = 'off';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  process.env.CLEMMY_HARNESS_CRON = 'on';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
});

after(() => {
  _setBridgeImplsForTests({});
  setClaudeAgentSdkBrainRunForTest(null);
  setClaudeAgentSdkBrainJudgeForTest(null);
  setClaudeAgentSdkBrainUnifiedPrimerForTest(null);
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('Claude OAuth cron honors explicit decision-only authority end to end', async () => {
  let captured: Record<string, unknown> | undefined;
  let legacyCalls = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    captured = options as unknown as Record<string, unknown>;
    return {
      text: JSON.stringify({ summary: 'Decision only.', commitments: [], actions: [] }),
      sessionId: options.sessionId,
      model: 'claude-sonnet-4-6',
      toolUses: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  });

  const response = await respondPreferHarness('cron', {
    message: 'Return the closed autonomy decision JSON.',
    sessionId: 'agent:claude-decision-only',
    allowedToolNames: [],
  }, async (request) => {
    legacyCalls += 1;
    return { text: 'unsafe legacy fallback', sessionId: request.sessionId };
  });

  assert.equal(response.stoppedReason, 'success');
  assert.equal(legacyCalls, 0, 'an explicit authority boundary must never fall back to a wider legacy lane');
  assert.ok(captured, 'precondition: Claude SDK brain served the cron turn');
  assert.deepEqual(
    captured.allowedLocalMcpTools,
    [],
    'the SDK permission surface must contain zero local tools',
  );
  assert.deepEqual(
    captured.mcpToolAllowlist,
    [],
    'the local MCP server must advertise zero first-class schemas',
  );
  assert.deepEqual(
    captured.localMcpToolUniverse,
    [],
    'tool_search/call_tool must have no deferred local authority universe',
  );
  assert.deepEqual(
    captured.requiredLocalMcpTools,
    [],
    'decision-only turns must not require the normal memory/tool-acquisition sentinels',
  );
  const nativeScope = captured.nativeMcpToolScope as {
    allowAll?: boolean;
    allowedServerSlugs?: string[];
    maxTools?: number;
  } | undefined;
  assert.ok(nativeScope, 'native MCP scope must be explicit for an authority-sensitive turn');
  assert.equal(nativeScope.allowAll ?? false, false);
  assert.deepEqual(nativeScope.allowedServerSlugs, []);
  assert.equal(nativeScope.maxTools, 0, 'native external MCP attachment must be explicitly empty');
});

test('explicit decision-only authority blocks instead of using legacy fallback when cron harness is disabled', async () => {
  process.env.CLEMMY_HARNESS_CRON = 'off';
  let legacyCalls = 0;

  const response = await respondPreferHarness('cron', {
    message: 'Return a decision.',
    sessionId: 'agent:claude-no-legacy',
    allowedToolNames: [],
  }, async (request) => {
    legacyCalls += 1;
    return { text: 'unsafe legacy fallback', sessionId: request.sessionId };
  });

  assert.equal(legacyCalls, 0);
  assert.equal(response.stoppedReason, 'error');
  assert.match(response.text, /runtime lane is temporarily unavailable/i);
  assert.doesNotMatch(response.text, /harness|CLEMMY_/i, 'public preflight copy stays free of runtime internals');
});
