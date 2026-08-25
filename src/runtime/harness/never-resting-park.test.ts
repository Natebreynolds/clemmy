/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/never-resting-park.test.ts
 *
 * HOST TURN LOOP (2026-08-19, supersedes the 2026-08-18 auto-resume drain):
 * a step ceiling is a STEP ending, not a TURN ending. Steps continue INSIDE
 * the turn via logged next_step_claimed facts (pinned in the brain/loop
 * suites). What this file pins is the RESTING contract around them:
 *   - auto-continue-on-limit stays the DEFAULT policy with the 200 backstop;
 *   - a park that does happen (kill-switch, zero progress, cap) is an honest
 *     blocked+resumable rest — NO autoResume marker, NO "continuing
 *     automatically" banner, NO continue-ask;
 *   - the bridge NEVER synthesizes a user message to fake re-entry, even when
 *     a legacy terminal still carries autoResume metadata;
 *   - gate-reason.ts stays the only needs_input author.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-never-resting-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const { getHarnessBudgetSettings } = await import('./budget-settings.js');
const { chatAutoContinueCap, chatAutoContinueDecision } = await import('./continue-directive.js');
const {
  respondViaClaudeAgentSdkBrain,
  setClaudeAgentSdkBrainRunForTest,
  setClaudeAgentSdkBrainJudgeForTest,
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest,
  setClaudeAgentSdkBrainUnifiedPrimerForTest,
} = await import('./claude-agent-brain.js');
const { respondPreferHarness, _setBridgeImplsForTests } = await import('./respond-bridge.js');
const { appendEvent, createSession, listEvents, resetEventLog } = await import('./eventlog.js');
const { _testOnly_reduceStandardConversationTerminal } = await import('./loop.js');
const { _testOnly_terminalStatusForResponse } = await import('../../gateway/router.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');

const UNAVAILABLE_TERMINAL_DELIVERY_JUDGE = {
  async resolveRoute() { return null; },
  async run() { throw new Error('unavailable fixture must not run'); },
} satisfies import('./terminal-delivery-judge.js').TerminalDeliveryJudgePort;

beforeEach(() => {
  resetEventLog();
  setClaudeAgentSdkBrainRunForTest(null);
  setClaudeAgentSdkBrainJudgeForTest(null);
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest(UNAVAILABLE_TERMINAL_DELIVERY_JUDGE);
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query: string) => ({
    objective: query, hits: [], perStore: {}, answerability: 'insufficient',
    diagnostics: { candidates: 0, stores: [], elapsedMs: 0 },
  }));
  delete process.env.HARNESS_AUTO_CONTINUE_ON_LIMIT;
  delete process.env.HARNESS_BUDGET_PRESET;
  delete process.env.CLEMMY_CHAT_AUTO_CONTINUE_CAP;
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
});

after(() => {
  setClaudeAgentSdkBrainRunForTest(null);
  setClaudeAgentSdkBrainJudgeForTest(null);
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest(null);
  setClaudeAgentSdkBrainUnifiedPrimerForTest(null);
  _setBridgeImplsForTests({});
  process.env.AUTH_MODE = 'api_key';
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN;
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('auto-continue-on-limit is the DEFAULT policy, with a runaway backstop cap of 200', () => {
  assert.equal(getHarnessBudgetSettings().autoContinueOnLimit, true,
    'a ceiling checkpoints and continues by default — parking to a human is the exception');
  assert.equal(chatAutoContinueCap(), 200);
  assert.deepEqual(
    chatAutoContinueDecision({ autoContinueOnLimit: true, attempts: 0, cap: 200, stepsThisActivation: 3 }),
    { resume: true },
  );
  assert.deepEqual(
    chatAutoContinueDecision({ autoContinueOnLimit: true, attempts: 0, cap: 200, stepsThisActivation: 0 }),
    { resume: false, reason: 'no_progress' },
    'zero progress still rests — resuming an idle loop only burns budget',
  );
});

test('a Claude one-step park with progress under the kill-switch RESTS honestly — no autoResume marker, no banner', async () => {
  process.env.HARNESS_AUTO_CONTINUE_ON_LIMIT = 'off';
  try {
    const sessionId = createSession({ id: 'never-resting-claude', kind: 'chat', userId: 'user-1' }).id;
    setClaudeAgentSdkBrainRunForTest(async () => ({
      text: 'Found 2 of 5 restaurants so far.',
      sessionId: 'sdk', model: 'm',
      toolUses: ['mcp__clementine-local__work_call'],
      limitHit: true,
    }));
    const res = await respondViaClaudeAgentSdkBrain('home', {
      // The source-confirmation boundary is covered separately. Pin an exact
      // source here so this fixture reaches the budget park it is meant to test.
      message: 'find the top 5 restaurants from the Apify API and put them in a sheet',
      sessionId,
    });
    const terminal = listEvents(sessionId, { types: ['conversation_completed'] }).at(-1);
    assert.equal(terminal?.data.autoResume, undefined, 'no auto-resume marker on a resting park');
    assert.equal(terminal?.data.reason, 'sdk_step_budget_parked');
    assert.doesNotMatch(String(terminal?.data.reply ?? ''), /continuing automatically/i,
      'a banner without a logged next-step claim is a lie');
    assert.doesNotMatch(String(terminal?.data.reply ?? ''), /say\s+["“`]?continue/i);
    assert.equal(listEvents(sessionId, { types: ['awaiting_user_input'] }).length, 0);
    assert.equal(listEvents(sessionId, { types: ['next_step_claimed'] }).length, 0);
    assert.doesNotMatch(String(res.text ?? ''), /say\s+["“`]?continue/i);
  } finally {
    delete process.env.HARNESS_AUTO_CONTINUE_ON_LIMIT;
  }
});

test('a latched SELF-STOP is a terminal rest: the host loop never claims a step against it', async () => {
  // Live 2026-08-19 sess-synthetic-007: the tool-economy hard stop latched
  // (selfStopped), every subsequent call was denied — and the host loop
  // claimed 200 steps anyway (21 minutes, one crossing, no artifact). The
  // pipe result's own contract says auto-continue must EXCLUDE selfStopped.
  const sessionId = createSession({ id: 'never-resting-selfstop', kind: 'chat', userId: 'user-1' }).id;
  let pipeCalls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    pipeCalls += 1;
    return {
      text: 'I stopped myself after using up my tool budget for this reply while still exploring.',
      sessionId: 'sdk', model: 'm',
      toolUses: ['mcp__clementine-local__work_call', 'mcp__clementine-local__memory_recall_all'],
      limitHit: true,
      selfStopped: true,
    };
  });
  await respondViaClaudeAgentSdkBrain('home', {
    // Keep source selection settled so the first executable step can exercise
    // the self-stop latch rather than correctly pausing for source confirmation.
    message: 'find the top 5 restaurants from the Apify API and put them in a sheet',
    sessionId,
  });
  assert.equal(pipeCalls, 1, 'a self-stop is re-run zero times — re-claiming just replays the stop');
  assert.equal(listEvents(sessionId, { types: ['next_step_claimed'] }).length, 0,
    'no step claim against a latched stop');
  const terminal = listEvents(sessionId, { types: ['conversation_completed'] }).at(-1);
  assert.equal(terminal?.data.autoResume, undefined, 'a self-stop park never self-resumes');
});

test('COPY FLOOR: stop-latch/economy/grind denials never interrupt — the CLI replaces interrupting deny copy with fake-user text', async () => {
  // interrupt:true makes the Claude CLI discard the deny message and hand the
  // model "The user doesn't want to proceed with this tool use… wait for the
  // user" — a fabricated user voice the model then obeys (live 2026-08-19).
  // The gates whose copy IS the steer must deny with interrupt:false; the
  // host ends the turn via selfStopped. Write-correlation safety aborts keep
  // their prompt interrupt (ratcheted below, never grown).
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./claude-agent-sdk.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/message: state\.stopped, interrupt: false/g) ?? []).length, 2,
    'both stop-latch deny sites carry honest copy without an interrupt');
  assert.match(source, /message: economy\.message,\s*\n\s*interrupt: false/,
    'the tool-economy deny reaches the model with its own words');
  assert.match(source, /message: grind\.message, interrupt: false/,
    'the grind deny reaches the model with its own words');
  const interrupting = (source.match(/interrupt: true/g) ?? []).length;
  assert.ok(interrupting <= 6,
    `interrupting denials are a ratchet (6 write-correlation safety aborts); found ${interrupting} — new gates must not interrupt`);
});

test('a Claude one-step budget park with ZERO progress rests honestly', async () => {
  const sessionId = createSession({ id: 'never-resting-idle', kind: 'chat', userId: 'user-1' }).id;
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'stuck', sessionId: 'sdk', model: 'm', toolUses: [], limitHit: true,
  }));
  await respondViaClaudeAgentSdkBrain('home', { message: 'do the thing', sessionId });
  const terminal = listEvents(sessionId, { types: ['conversation_completed'] }).at(-1);
  assert.equal(terminal?.data.autoResume, undefined, 'no progress → no self-resume');
  assert.match(String(terminal?.data.reply ?? ''), /paused/i);
  assert.doesNotMatch(String(terminal?.data.reply ?? ''), /continuing automatically/i);
});

test('the loop reducer parks bypass limit paths honestly — continue-shaped+resumable, no autoResume, no banner', async () => {
  // SDK MaxTurnsExceededError / tool-guardrail paths bypass the in-loop
  // claims; their paired terminal is an honest continue checkpoint (a ceiling
  // is a checkpoint, not an end) — resumable by the host's continue loop or a
  // next user message, never a fake self-resume marker and never coaching
  // copy. The 2026-08-18 blocked demotion here erased the resumable status,
  // so no caller's continue loop could ever receive a limit checkpoint.
  const progressed = createSession({ id: 'never-resting-reducer', kind: 'chat', userId: 'user-1' });
  const source = appendEvent({
    sessionId: progressed.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: 'long task' },
  });
  recordTurnGraphShadow({ identity: { sessionId: progressed.id, sourceUserSeq: source.seq, turn: 1 } });
  const reduced = _testOnly_reduceStandardConversationTerminal({
    result: { sessionId: progressed.id, status: 'limit_exceeded', steps: 7, lastTurn: 1, limitKind: 'max_steps' },
    sourceUserSeq: source.seq,
  });
  assert.equal(reduced.status, 'limit_exceeded', 'the committed typed public winner controls compatibility status');
  const terminal = listEvents(progressed.id, { types: ['conversation_completed'] }).at(-1);
  assert.equal(terminal?.data.autoResume, undefined);
  assert.equal(terminal?.data.reason, 'step_budget_parked');
  assert.equal((terminal?.data.turnOutcome as { status?: string })?.status, 'needs_input');
  assert.equal(
    (terminal?.data.turnOutcome as { needs?: { kind?: string } })?.needs?.kind,
    'continue',
  );
  assert.doesNotMatch(String(terminal?.data.reply ?? ''), /continuing automatically/i);
  assert.doesNotMatch(String(terminal?.data.reply ?? ''), /say\s+["“`]?continue/i);
});

test('the gateway never authors a continue-ask for a ceiling — blocked park, gate-reason stays the only needs_input author', () => {
  assert.equal(
    _testOnly_terminalStatusForResponse({ text: 'x', sessionId: 's', stoppedReason: 'max-turns-with-grace' } as never),
    'blocked',
  );
  assert.equal(
    _testOnly_terminalStatusForResponse({ text: 'x', sessionId: 's', stoppedReason: 'token-budget' } as never),
    'blocked',
  );
});

test('COPY FLOOR: no production limit path coaches the user to type `continue` (seq 58781 is not the production shape)', async () => {
  const { readFileSync } = await import('node:fs');
  const files = [
    'src/runtime/harness/claude-agent-sdk.ts',
    'src/runtime/harness/claude-agent-brain.ts',
    'src/runtime/harness/loop.ts',
    'src/runtime/harness/respond-bridge.ts',
    'src/runtime/harness/delivery-committer.ts',
    'src/tools/worker-tools.ts',
    'src/agents/orchestrator.ts',
    'src/gateway/router.ts',
  ];
  for (const file of files) {
    const sourceText = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      sourceText,
      /say\s+[\\"'“`]{0,2}continue/i,
      `${file} still coaches "say continue" — a ceiling is the host's checkpoint, never a user chore`,
    );
    assert.doesNotMatch(
      sourceText,
      /continuing automatically \(pass/i,
      `${file} still renders the auto-continue banner — a banner without a logged next_step_claimed is a lie`,
    );
  }
});

test('legacy standalone Claude reducer: the bridge never fakes re-entry for an autoResume terminal', async () => {
  const sessionId = createSession({ id: 'never-resting-bridge', kind: 'chat', userId: 'user-1' }).id;
  const calls: Array<{ message: string }> = [];
  _setBridgeImplsForTests({
    allowStandaloneClaudeInteractiveBrainForTests: true,
    configure: (async () => ({ ok: true })) as never,
    claudeAgentBrain: (async (_surface: string, req: { sessionId: string; message: string }) => {
      calls.push({ message: req.message });
      // Simulate a LEGACY park terminal that still carries the retired
      // autoResume metadata — the bridge must not act on it.
      const source = appendEvent({
        sessionId: req.sessionId, turn: 1, role: 'user',
        type: 'user_input_received', data: { text: req.message },
      });
      commitTurnOutcome({
        version: 2,
        id: turnOutcomeId({ sessionId: req.sessionId, turn: 1, sourceUserSeq: source.seq }),
        identity: { sessionId: req.sessionId, turn: 1, sourceUserSeq: source.seq },
        status: 'blocked',
        resumable: true,
        presentation: { kind: 'blocked', text: 'I paused at this step\'s budget. The work so far is saved.' },
      }, { legacyReason: 'sdk_step_budget_parked', metadata: { autoResume: true, autoResumeAttempt: 1, autoResumeCap: 200 } });
      return { text: 'parked', sessionId: req.sessionId, stoppedReason: 'max-turns-with-grace', raw: { limitHit: true } };
    }) as never,
  });

  const first = await respondPreferHarness('home', {
    message: 'find the top 5 restaurants and put them in a sheet',
    sessionId,
  }, async (req) => ({ text: 'legacy', sessionId: (req as { sessionId: string }).sessionId }));
  assert.equal(first.stoppedReason, 'max-turns-with-grace');

  // Give any stray fire-and-forget scheduler a beat to (wrongly) fire.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(calls.length, 1, 'no second dispatch — steps continue INSIDE the turn, not via fake user input');
  assert.equal(
    listEvents(sessionId, { types: ['user_input_received'] })
      .filter((event) => event.data.hostDirective === true).length,
    0,
    'no user_input_received pretending to be the human',
  );
});
