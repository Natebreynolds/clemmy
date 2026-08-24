/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/claude-one-step-transport.test.ts
 *
 * ONE-STEP TRANSPORT PINS (2026-08-18 cut).
 *
 * The Claude Agent SDK is an OAuth subscription pipe, not the turn owner:
 *   - one host invocation → one query() / one model step;
 *   - a second model step happens only when the HOST calls the adapter again;
 *   - max_turns / limitHit returns to the host as a typed BLOCKED park —
 *     never awaiting_user_input / needs_input "want me to continue";
 *   - the lane bills the user's Claude subscription (CLAUDE_CODE_OAUTH_TOKEN),
 *     never a Console ANTHROPIC_API_KEY;
 *   - a greeting stays a single-step, zero-tool exchange.
 *
 * Live shape this pins against: Discord AUTH_MODE=claude_oauth runs looping
 * tools/auto-continue/salvage/finish-phase for 16 minutes / ~300k tokens and
 * ending needs_input (2026-08-18).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-one-step-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

// A stored SUBSCRIPTION token (never an API key) is this lane's credential.
const STATE_DIR = path.join(TMP_HOME, 'state');
mkdirSync(STATE_DIR, { recursive: true });
function writeClaudeSubscriptionToken(): void {
  writeFileSync(
    path.join(STATE_DIR, 'claude-auth.json'),
    JSON.stringify({
      accessToken: 'sk-ant-oat01-one-step-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ['user:inference'],
    }),
    'utf-8',
  );
}

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const {
  respondViaClaudeAgentSdkBrain,
  setClaudeAgentSdkBrainRunForTest,
  setClaudeAgentSdkBrainJudgeForTest,
  setClaudeAgentSdkBrainPostTurnHooksForTest,
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest,
  setClaudeAgentSdkBrainPreflightConversationPortForTest,
  setClaudeAgentSdkBrainSearchFactsHybridForTest,
  setClaudeAgentSdkBrainUnifiedPrimerForTest,
  resolveClaudeAgentBrainMaxTurns,
} = await import('./claude-agent-brain.js');
const {
  runClaudeAgentSdk,
  setClaudeAgentSdkQueryForTest,
  setClaudeAgentSdkReflectionForTest,
  _resetClaudeAgentSdkAdvertisableLocalToolsForTest,
} = await import('./claude-agent-sdk.js');
const { buildClaudeHeadlessEnv } = await import('./claude-headless-model.js');
const { createSession, listEvents, resetEventLog } = await import('./eventlog.js');
const { installTurnSemanticModelPort } = await import('../semantic-boundary/turn-semantic-port-registry.js');
const { _setOpennessJudgeForTests } = await import('./turn-openness.js');
const artifactLedger = await import('./artifact-ledger.js');
const capabilityHealth = await import('./capability-health.js');

const UNAVAILABLE_TERMINAL_DELIVERY_JUDGE = {
  async resolveRoute() { return null; },
  async run() { throw new Error('unavailable fixture must not run'); },
} satisfies import('./terminal-delivery-judge.js').TerminalDeliveryJudgePort;

function stubsFor(gen: AsyncGenerator<SDKMessage>): Query {
  return Object.assign(gen, {
    close() {}, interrupt: async () => {}, setPermissionMode: async () => {},
    setModel: async () => {}, setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
    streamInput: async () => {}, stopTask: async () => false, backgroundTasks: async () => false,
  }) as Query;
}

function successQuery(text: string): Query {
  return stubsFor((async function* () {
    yield { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', session_id: 's', uuid: 'i', apiKeySource: 'none', claude_code_version: '2', cwd: process.cwd(), tools: [], mcp_servers: [], permissionMode: 'dontAsk', slash_commands: [], output_style: 'default', skills: [], plugins: [] } as never;
    yield { type: 'result', subtype: 'success', session_id: 's', uuid: 'r', result: text, duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, stop_reason: 'end_turn', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [] } as never;
  })());
}

beforeEach(() => {
  writeClaudeSubscriptionToken();
  installTurnSemanticModelPort(null);
  resetEventLog();
  artifactLedger._resetArtifactLedgerForTests();
  capabilityHealth._resetHarnessCapabilityHealthForTest();
  setClaudeAgentSdkBrainRunForTest(null);
  setClaudeAgentSdkBrainPostTurnHooksForTest(null);
  setClaudeAgentSdkBrainJudgeForTest(null);
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest(UNAVAILABLE_TERMINAL_DELIVERY_JUDGE);
  setClaudeAgentSdkBrainPreflightConversationPortForTest(null);
  setClaudeAgentSdkBrainSearchFactsHybridForTest(null);
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query: string) => ({
    objective: query, hits: [], perStore: {}, answerability: 'insufficient',
    diagnostics: { candidates: 0, stores: [], elapsedMs: 0 },
  }));
  _setOpennessJudgeForTests(null);
  _resetClaudeAgentSdkAdvertisableLocalToolsForTest();
  setClaudeAgentSdkQueryForTest(null);
  setClaudeAgentSdkReflectionForTest(() => {});
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
});

after(() => {
  installTurnSemanticModelPort(null);
  setClaudeAgentSdkBrainRunForTest(null);
  setClaudeAgentSdkBrainJudgeForTest(null);
  setClaudeAgentSdkBrainPostTurnHooksForTest(null);
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest(null);
  setClaudeAgentSdkBrainPreflightConversationPortForTest(null);
  setClaudeAgentSdkBrainSearchFactsHybridForTest(null);
  setClaudeAgentSdkBrainUnifiedPrimerForTest(null);
  setClaudeAgentSdkQueryForTest(null);
  setClaudeAgentSdkReflectionForTest(null);
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN;
  process.env.AUTH_MODE = 'api_key';
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('the brain resolves a FLAT step window per host invocation — no widening by objective', () => {
  // STEP = one request + the tool calls it CHAINS (2026-08-19; live
  // sess-synthetic-009 paid ~7s re-entry PER CALL at maxTurns:1). Flat regardless
  // of ask size: bigger work buys host re-entries, never a bigger SDK loop.
  assert.equal(resolveClaudeAgentBrainMaxTurns('hey'), 12);
  assert.equal(resolveClaudeAgentBrainMaxTurns(
    'build the full multi-page site with research, a workbook, and a report',
    ['keep going', 'and add five more pages'],
  ), 12, 'a bigger objective buys host re-entries, not a bigger SDK loop');
});

test('one host invocation → one bounded step window; the brain never re-runs query() on its own', async () => {
  const sessionId = createSession({ id: 'one-step-count', kind: 'chat', userId: 'user-1' }).id;
  let runs = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    runs += 1;
    assert.equal(options.maxTurns, 12, 'the brain passes the flat step window to the transport');
    return { text: 'I sent the report.', sessionId: 'sdk', model: 'm', toolUses: [] };
  });
  // A not-done judge verdict used to buy a full corrective continuation.
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: false, reason: 'nothing actually ran' }));
  await respondViaClaudeAgentSdkBrain('home', {
    message: 'send the weekly report to the team',
    sessionId,
  });
  assert.equal(runs, 1, 'judges may label; they cannot mint a second model step');
  assert.equal(listEvents(sessionId, { types: ['sdk_auto_continue'] }).length, 0);

  // HOST re-entry is the only way to a second step.
  await respondViaClaudeAgentSdkBrain('home', { message: 'and the follow-up note', sessionId });
  assert.equal(runs, 2, 'a second step happens only when the host calls the adapter again');
});

test('limitHit parks as a typed blocked outcome — never awaiting_user_input / needs_input "say continue"', async () => {
  // Pin the RESTING park shape (kill-switch off): the host turn loop normally
  // claims next-step in-turn, so the park is only reachable when the policy
  // rests — and even then it must never become a user chore.
  process.env.HARNESS_AUTO_CONTINUE_ON_LIMIT = 'off';
  const sessionId = createSession({ id: 'one-step-limit', kind: 'chat', userId: 'user-1' }).id;
  let runs = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    runs += 1;
    return {
      text: 'Collected 3 of 25 items so far.',
      sessionId: 'sdk',
      model: 'm',
      toolUses: ['tool_search', 'work_call'],
      limitHit: true,
    };
  });
  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'collect all 25 items into the sheet',
    sessionId,
  });
  delete process.env.HARNESS_AUTO_CONTINUE_ON_LIMIT;
  assert.equal(runs, 1, 'a resting park spends exactly one pipe step');
  assert.equal(listEvents(sessionId, { types: ['sdk_auto_continue'] }).length, 0);
  assert.equal(listEvents(sessionId, { types: ['awaiting_user_input'] }).length, 0,
    'a budget stop is a host park, not a question to the user');
  const terminals = listEvents(sessionId, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1);
  const terminal = terminals[0]?.data as {
    turnOutcome?: { status?: string; needs?: unknown };
    presentation?: { kind?: string; text?: string };
    reply?: string;
  };
  assert.equal(terminal.turnOutcome?.status, 'blocked', JSON.stringify(terminal).slice(0, 400));
  assert.equal(terminal.turnOutcome?.needs, undefined, 'no needs_input, no needs:{kind:continue}');
  assert.equal(terminal.presentation?.kind, 'blocked');
  assert.doesNotMatch(String(terminal.reply ?? ''), /say\s+["“]?continue/i,
    'the user is never asked to do the harness\'s bookkeeping');
  assert.doesNotMatch(String(response.text ?? ''), /say\s+["“]?continue/i);
});

test('a greeting is a single direct-reply step with zero advertised tools', async () => {
  const sessionId = createSession({ id: 'one-step-greeting', kind: 'chat', userId: 'user-1' }).id;
  let runs = 0;
  let capturedMaxTurns: number | undefined;
  let capturedTools: string[] | undefined;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    runs += 1;
    capturedMaxTurns = options.maxTurns;
    capturedTools = options.allowedLocalMcpTools;
    return { text: 'Hey! Going well over here.', sessionId: 'sdk', model: 'm', toolUses: [] };
  });
  const response = await respondViaClaudeAgentSdkBrain('home', { message: 'hey hows it going', sessionId });
  assert.equal(response.stoppedReason, 'success');
  assert.equal(runs, 1);
  assert.equal(capturedMaxTurns, 12);
  // Direct reply carries no call authority or schema payload. A retrieve/act
  // turn obtains its exact surface at the accepted-route boundary instead.
  assert.deepEqual(capturedTools, [], 'a greeting advertises no tools');
});

test('the transport defaults to one model step and exposes no native SDK tools', async () => {
  const session = createSession({ kind: 'chat' });
  let captured: { maxTurns?: number; tools?: unknown; allowedTools?: unknown } | undefined;
  setClaudeAgentSdkQueryForTest(((params: { options?: typeof captured }) => {
    captured = params.options;
    return successQuery('ok');
  }) as never);
  const result = await runClaudeAgentSdk({ prompt: 'Summarize the status.', sessionId: session.id });
  assert.equal(result.text, 'ok');
  assert.equal(captured?.maxTurns, 1, 'one query() = one model step unless a caller explicitly widens');
  assert.deepEqual(captured?.tools, [], 'no native Read/Grep/Bash — tools are the host MCP surface only');
  assert.deepEqual(captured?.allowedTools, [], 'no SDK preapproval bypassing the host permission gate');
});

test('AUTH_MODE=claude_oauth bills the subscription: no ANTHROPIC_API_KEY ever reaches the claude process', async () => {
  const priorKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-console-key-that-must-not-bill';
  try {
    const env = await buildClaudeHeadlessEnv();
    assert.equal(env.ANTHROPIC_API_KEY, undefined, 'Console key is scrubbed from the spawn env');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-one-step-token',
      'the stored subscription OAuth token is the credential');
  } finally {
    if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorKey;
  }
});
