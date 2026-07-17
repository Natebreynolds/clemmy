import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-agent-brain-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const brain = await import('./claude-agent-brain.js');
const {
  claudeAgentSdkBrainMode,
  claudeAgentSdkBrainEnabled,
  renderClaudeAgentBrainSystemAppend,
  renderClaudeAgentBrainTurnContext,
  respondViaClaudeAgentSdkBrain,
  setClaudeAgentSdkBrainRunForTest,
  setClaudeAgentSdkBrainJudgeForTest,
  setClaudeAgentSdkBrainSearchFactsHybridForTest,
  setClaudeAgentSdkBrainUnifiedPrimerForTest,
  looksLikeToolNarration,
  looksLikeStreamingNarration,
  looksLikeReasoningLeak,
  shouldJudgeClaudeCompletion,
  frameTrustedMemory,
  sdkStreamingEnabled,
  invalidateStableMemorySnapshot,
  claudeAgentSdkAdvertisedToolUniverse,
  partitionClaudeAgentSdkJitSurface,
} = brain;
const { appendEvent, createSession, getSession, listEvents, resetEventLog, writeToolOutput } = await import('./eventlog.js');
const { saveUserProfile } = await import('../user-profile.js');
const {
  ClaudeSdkProviderOverloadError,
  ClaudeSdkContextOverflowError,
  _resetClaudeAgentSdkAdvertisableLocalToolsForTest,
} = await import('./claude-agent-sdk.js');
const capabilityHealth = await import('./capability-health.js');
const { openMemoryDb } = await import('../../memory/db.js');

beforeEach(() => {
  resetEventLog();
  capabilityHealth._resetHarnessCapabilityHealthForTest();
  setClaudeAgentSdkBrainRunForTest(null);
  setClaudeAgentSdkBrainJudgeForTest(null);
  setClaudeAgentSdkBrainSearchFactsHybridForTest(null);
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query) => ({
    objective: query, hits: [], perStore: {}, answerability: 'insufficient',
    diagnostics: { candidates: 0, stores: [], elapsedMs: 0 },
  }));
  _resetClaudeAgentSdkAdvertisableLocalToolsForTest();
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN;
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_ALLOWED_TOOLS;
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN_MAX_TURNS;
  delete process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE;
  delete process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT;
  delete process.env.CLEMMY_CLAUDE_SDK_SESSION_HISTORY;
  delete process.env.CLEMMY_CLAUDE_SDK_JUDGE_MAX_CONTINUATIONS;
  delete process.env.CLEMMY_CLAUDE_SDK_STREAMING;
  delete process.env.CLEMMY_BRAIN_QUERY_RECALL_TIMEOUT_MS;
  delete process.env.CLEMMY_UNIFIED_RECALL;
  delete process.env.CLEMMY_UNIFIED_TURN_PRIMER;
  process.env.AUTH_MODE = 'api_key';
});

after(() => {
  setClaudeAgentSdkBrainRunForTest(null);
  setClaudeAgentSdkBrainJudgeForTest(null);
  setClaudeAgentSdkBrainSearchFactsHybridForTest(null);
  setClaudeAgentSdkBrainUnifiedPrimerForTest(null);
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('JIT monotonic floor: the per-session advertised tool set only GROWS (cache-stable), never shrinks', () => {
  const { bumpSessionToolFloor } = brain as { bumpSessionToolFloor: (s: string, e: Iterable<string>) => Set<string> };
  const sid = 'jit-mono-test';
  assert.deepEqual([...bumpSessionToolFloor(sid, ['a', 'b'])].sort(), ['a', 'b']);
  // Turn 2 needs only 'c' — but the floor must GROW, not shrink to just 'c'.
  assert.deepEqual([...bumpSessionToolFloor(sid, ['c'])].sort(), ['a', 'b', 'c']);
  // Turn 3 needs only 'a' — floor stays stable (converged → the tools block is now
  // identical turn-to-turn → the prompt cache holds).
  assert.deepEqual([...bumpSessionToolFloor(sid, ['a'])].sort(), ['a', 'b', 'c']);
  // A different session has its own independent floor.
  assert.deepEqual([...bumpSessionToolFloor('other-session', ['x'])].sort(), ['x']);
});

test('completion judge targets suspicious text and skips concrete tool-backed results', () => {
  assert.equal(
    shouldJudgeClaudeCompletion('write the brief', 'Done - saved and verified the brief.', ['write_file', 'run_shell_command']),
    false,
  );
  assert.equal(
    shouldJudgeClaudeCompletion('send the emails', "I'll send the remaining emails next.", ['composio_execute_tool']),
    true,
  );
  assert.equal(
    shouldJudgeClaudeCompletion('create the workflow', 'Created the workflow.', []),
    true,
  );
  assert.equal(
    shouldJudgeClaudeCompletion('send the emails', 'Sent the emails.', ['memory_search', 'composio_search_tools']),
    true,
    'probe-only calls are not completion evidence',
  );
  assert.equal(
    shouldJudgeClaudeCompletion('send the emails', 'Sent the emails.', ['ask_user_question']),
    true,
    'a control-only ask cannot certify a send',
  );
  assert.equal(
    shouldJudgeClaudeCompletion('build the app', 'Built the app.', ['read_file']),
    true,
    'a partial read cannot certify a mutating objective',
  );
  assert.equal(
    shouldJudgeClaudeCompletion('send the emails', 'Sent the emails.', ['GMAIL_FETCH_EMAILS']),
    true,
    'a concrete read slug cannot certify a send',
  );
  assert.equal(
    shouldJudgeClaudeCompletion('send the emails', 'Sent the emails.', ['GMAIL_SEND_EMAIL']),
    true,
    'one successful send cannot certify a plural objective',
  );
  assert.equal(
    shouldJudgeClaudeCompletion('send the email', 'Sent the email.', ['GMAIL_SEND_EMAIL']),
    false,
    'a successful concrete send still certifies a singular objective',
  );
});

test('JIT monotonic floor: the EMITTED allowlist string is byte-identical once converged (the actual prompt-cache precondition)', () => {
  const { bumpSessionToolFloor } = brain as { bumpSessionToolFloor: (s: string, e: Iterable<string>) => Set<string> };
  const sid = 'jit-mono-emit';
  // fullAllowed is the stable per-turn ordering the brain filters against; the
  // advertised allowlist = fullAllowed.filter(in floor).join(',') — what the SDK
  // hashes for the tools-block cache key. Order must come from fullAllowed (stable),
  // NOT floor insertion order, so a converged set always serializes identically.
  const fullAllowed = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
  const emit = (floor: Set<string>): string => fullAllowed.filter((n) => floor.has(n)).join(',');

  // Turn 1: intent surfaces charlie+alpha. Turn 2: bravo (grows — one cache bust).
  emit(bumpSessionToolFloor(sid, ['charlie', 'alpha']));
  const t2 = emit(bumpSessionToolFloor(sid, ['bravo']));
  // Turns 3..5 reselect already-floored tools in different orders → converged.
  const t3 = emit(bumpSessionToolFloor(sid, ['alpha']));
  const t4 = emit(bumpSessionToolFloor(sid, ['bravo', 'charlie']));
  const t5 = emit(bumpSessionToolFloor(sid, ['charlie']));
  // Byte-identical across the converged turns → the prefix cache-hits.
  assert.equal(t3, t2);
  assert.equal(t4, t2);
  assert.equal(t5, t2);
  // And the serialization follows fullAllowed order, not selection/insertion order.
  assert.equal(t2, 'alpha,bravo,charlie');
});

test('full-mode JIT keeps MCP advertisement separate from the permission fast-allow set', () => {
  const fastAllow = ['memory_recall', 'tool_search'];
  const universe = claudeAgentSdkAdvertisedToolUniverse('full', fastAllow);
  assert.ok(universe.includes('task_hygiene'), 'catalog-only gated tools remain advertisable');
  assert.ok(universe.includes('focus_get'), 'real MCP tools outside the CLI catalog remain advertisable');
  assert.ok(!universe.includes('browser_harness_run'), 'CLI-only names absent from this MCP server are not promised');

  const selected = new Set(['memory_recall', 'tool_search', 'task_hygiene']);
  const partitioned = partitionClaudeAgentSdkJitSurface(fastAllow, universe, selected);
  assert.ok(partitioned.advertisedNames.includes('task_hygiene'));
  assert.ok(!partitioned.fastAllowNames.includes('task_hygiene'), 'catalog-only tools must still reach canUseTool');

  const readOnly = claudeAgentSdkAdvertisedToolUniverse('read_only', fastAllow);
  assert.ok(!readOnly.includes('task_hygiene'), 'non-agentic profiles remain capability-limited');
  assert.ok(!claudeAgentSdkAdvertisedToolUniverse('full', fastAllow, ['task_hygiene']).includes('task_hygiene'));
});

test('Move 1: the SDK brain ARMS the in-flight marker during the run and CLEARS it on completion', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  const { HarnessSession } = await import('./session.js');
  createSession({ id: 'brain-marker', kind: 'chat', title: 'm' });
  let armedDuringRun: string | null | undefined;
  setClaudeAgentSdkBrainRunForTest(async () => {
    // Captured INSIDE the run: a daemon crash here must be reportable → armed.
    armedDuringRun = HarnessSession.load('brain-marker')?.runInFlightSince() ?? null;
    return { text: 'done', sessionId: 'sdk', model: 'm', toolUses: [] };
  });
  await respondViaClaudeAgentSdkBrain('home', { message: 'hello', sessionId: 'brain-marker' });
  assert.notEqual(armedDuringRun, null, 'marker was ARMED during the run');
  assert.equal(HarnessSession.load('brain-marker')?.runInFlightSince(), null, 'marker CLEARED after completion');
});

test('Claude SDK brain creates background sessions as execution sessions, not chat sessions', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'background result',
    sessionId: 'sdk',
    model: 'm',
    toolUses: [],
  }));

  await respondViaClaudeAgentSdkBrain('background', {
    message: 'run this in the background',
    sessionId: 'brain-background-kind',
  });

  const session = getSession('brain-background-kind');
  assert.equal(session?.kind, 'execution');
  assert.equal(session?.metadata.source, 'claude-agent-sdk-brain:background');
});

test('Claude cron uses an execution SDK session, skips the expensive judge, and preserves plain-question awaiting', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  let judgeCalls = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judgeCalls += 1;
    return { done: true, reason: 'done' };
  });
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'Which account should I update?',
    sessionId: 'sdk',
    model: 'claude-sonnet-4-6',
    toolUses: [],
  }));

  const response = await respondViaClaudeAgentSdkBrain('cron', {
    message: 'Update the account',
    sessionId: 'brain-cron-kind',
  });

  const session = getSession('brain-cron-kind');
  assert.equal(session?.kind, 'execution');
  assert.equal(session?.metadata.source, 'claude-agent-sdk-brain:cron');
  assert.equal(judgeCalls, 0, 'cron does not pay for completion-judge continuations');
  assert.equal(response.stoppedReason, 'awaiting-input', 'plain blocking questions still pause canonically');
});

test('SDK brain auto-captures explicit remember turns even when the model skips memory_remember', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  createSession({ id: 'brain-autocap-remember', kind: 'chat', title: 'm' });
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'Saved — your smoke marker is MEMTOK-999999.',
    sessionId: 'sdk',
    model: 'm',
    toolUses: [],
  }));

  await respondViaClaudeAgentSdkBrain('home', {
    message: 'Remember exactly: my smoke marker is MEMTOK-999999. Confirm.',
    sessionId: 'brain-autocap-remember',
  });

  const events = listEvents('brain-autocap-remember');
  const captured = events.find((event) => event.type === 'memory_signals_captured');
  assert.ok(captured, 'SDK brain emitted memory capture telemetry for the explicit remember turn');
  assert.equal((captured!.data as { factCount?: number }).factCount, 1);
  assert.deepEqual(
    (captured!.data as { reasons?: string[] }).reasons,
    ['explicit remember request'],
  );
  assert.ok(
    events.findIndex((event) => event.type === 'memory_signals_captured') <
      events.findIndex((event) => event.type === 'conversation_completed'),
    'capture telemetry is recorded before the final saved reply',
  );
});

test('Move 4: a judge-failed-open completion is TAGGED verification.failedOpen (no silent green check)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  createSession({ id: 'brain-verif-failopen', kind: 'chat', title: 'v' });
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'Done — sent the 3 emails.', sessionId: 'sdk', model: 'm',
    toolUses: [],
  }));
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'judge timed out — accepting completion', failedOpen: true }));
  await respondViaClaudeAgentSdkBrain('home', { message: 'send the 3 emails', sessionId: 'brain-verif-failopen' });
  const completed = listEvents('brain-verif-failopen').filter((e) => e.type === 'conversation_completed').at(-1);
  assert.ok(completed, 'a completion event was emitted');
  assert.equal((completed!.data as { verification?: { failedOpen?: boolean } }).verification?.failedOpen, true, 'fail-open is surfaced on the completion');
});

test('Move 4: a thrown completion judge is TAGGED verification.failedOpen', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  createSession({ id: 'brain-verif-throw', kind: 'chat', title: 'v' });
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'Done — sent the 3 emails.', sessionId: 'sdk', model: 'm',
    toolUses: [],
  }));
  setClaudeAgentSdkBrainJudgeForTest(async () => { throw new Error('judge unavailable'); });
  await respondViaClaudeAgentSdkBrain('home', { message: 'send the 3 emails', sessionId: 'brain-verif-throw' });
  const completed = listEvents('brain-verif-throw').filter((e) => e.type === 'conversation_completed').at(-1);
  assert.ok(completed, 'a completion event was emitted');
  assert.equal((completed!.data as { verification?: { failedOpen?: boolean } }).verification?.failedOpen, true);
});

test('Move 4: a clean cross-family done verdict leaves NO verification tag (full confidence)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  createSession({ id: 'brain-verif-clean', kind: 'chat', title: 'v' });
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'Done — sent the 3 emails.', sessionId: 'sdk', model: 'm',
    toolUses: [],
  }));
  let judgeCalls = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judgeCalls += 1;
    return { done: true, reason: 'all three sent with links' };
  });
  await respondViaClaudeAgentSdkBrain('home', { message: 'send the 3 emails', sessionId: 'brain-verif-clean' });
  const completed = listEvents('brain-verif-clean').filter((e) => e.type === 'conversation_completed').at(-1);
  assert.equal(judgeCalls, 1);
  assert.equal((completed!.data as { verification?: unknown }).verification, undefined, 'a clean verdict adds no tag');
});

test('Move 1: the marker is CLEARED even when the run throws (finally)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  const { HarnessSession } = await import('./session.js');
  createSession({ id: 'brain-marker-throw', kind: 'chat', title: 'm' });
  setClaudeAgentSdkBrainRunForTest(async () => { throw new Error('boom'); });
  await assert.rejects(respondViaClaudeAgentSdkBrain('home', { message: 'hi', sessionId: 'brain-marker-throw' }));
  assert.equal(HarnessSession.load('brain-marker-throw')?.runInFlightSince(), null, 'marker cleared on throw');
});

test('Move 1: the marker stays armed when final delivery fails before terminal report-back', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  const { HarnessSession } = await import('./session.js');
  createSession({ id: 'brain-marker-delivery-throw', kind: 'chat', title: 'm' });
  setClaudeAgentSdkBrainRunForTest(async () => ({ text: 'done', sessionId: 'sdk', model: 'm', toolUses: [] }));
  await assert.rejects(
    respondViaClaudeAgentSdkBrain('home', {
      message: 'hi',
      sessionId: 'brain-marker-delivery-throw',
      onChunk: async () => { throw new Error('client disconnected'); },
    }),
  );
  assert.notEqual(
    HarnessSession.load('brain-marker-delivery-throw')?.runInFlightSince(),
    null,
    'marker remains armed so restart recovery can report the missing terminal delivery',
  );
});

test('Claude auth defaults to the full tool-capable SDK lane; off remains explicit', () => {
  process.env.AUTH_MODE = 'claude_oauth';
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN;
  assert.equal(claudeAgentSdkBrainEnabled('home'), true);
  assert.equal(claudeAgentSdkBrainMode(), 'full');

  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  assert.equal(claudeAgentSdkBrainEnabled('home'), true);
  assert.equal(claudeAgentSdkBrainMode(), 'local_authoring');
  assert.equal(claudeAgentSdkBrainEnabled('dashboard'), true);
  assert.equal(claudeAgentSdkBrainEnabled('background'), true, 'background tasks need the SDK lane so Claude can call Clementine tools');
  assert.equal(claudeAgentSdkBrainEnabled('cron'), true, 'cron needs the SDK lane so Claude can call Clementine tools');
  assert.equal(claudeAgentSdkBrainEnabled('workflow'), false, 'execution surfaces stay on the guarded harness');

  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  assert.equal(claudeAgentSdkBrainEnabled('home'), true);
  assert.equal(claudeAgentSdkBrainMode(), 'read_only');

  process.env.AUTH_MODE = 'codex_oauth';
  assert.equal(claudeAgentSdkBrainEnabled('home'), false);

  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'off';
  assert.equal(claudeAgentSdkBrainEnabled('home'), false);
});

test('renderClaudeAgentBrainSystemAppend carries Clementine context and the read-only boundary', () => {
  const prompt = renderClaudeAgentBrainSystemAppend('home', { message: 'hi', sessionId: 'brain-prompt' }, 'read_only');
  assert.match(prompt, /official Claude Agent SDK/);
  assert.match(prompt, /READ-ONLY\/local-context/);
  assert.match(prompt, /How you operate here/);
  assert.match(prompt, /You are Clementine/);
  assert.match(prompt, /CALL TOOLS — NEVER DESCRIBE THEM/);
  assert.doesNotMatch(prompt, /Return an OrchestratorDecision/);
  // The lean rubric must NOT leak the harness's internal event protocol — that
  // leakage is what the model reproduced as text ("Tool:… / System: tool result").
  assert.doesNotMatch(prompt, /tool_called event|tool_returned event|\[clipped:/);
});

test('stable memory freezing is opt-in and supports explicit invalidation', () => {
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'on'; // the freeze applies only on the split (cacheable-prefix) path
  process.env.CLEMMY_BRAIN_STABLE_SNAPSHOT = 'on';
  const sid = 'brain-freeze-A';
  invalidateStableMemorySnapshot(); // clean slate
  // First render seeds this session's snapshot (before the vault edit).
  const first = renderClaudeAgentBrainSystemAppend('home', { message: 'hi', sessionId: sid }, 'read_only');
  // A mid-session vault edit changes what the STABLE block WOULD render.
  saveUserProfile({ role: 'MARKER_ROLE_XYZZY' });
  // Same session → byte-identical (frozen); the new role never enters the cached prefix.
  const second = renderClaudeAgentBrainSystemAppend('home', { message: 'hi', sessionId: sid }, 'read_only');
  assert.equal(second, first, 'frozen snapshot: same session ignores the mid-session edit');
  assert.doesNotMatch(second, /MARKER_ROLE_XYZZY/);
  // A DIFFERENT session renders live — proves the edit really does surface (so its
  // absence above is the freeze, not a non-rendering field).
  const fresh = renderClaudeAgentBrainSystemAppend('home', { message: 'hi', sessionId: 'brain-freeze-B' }, 'read_only');
  assert.match(fresh, /MARKER_ROLE_XYZZY/, 'a fresh session renders the current vault state');
  // Explicit invalidation re-renders the frozen session.
  invalidateStableMemorySnapshot(sid);
  const third = renderClaudeAgentBrainSystemAppend('home', { message: 'hi', sessionId: sid }, 'read_only');
  assert.match(third, /MARKER_ROLE_XYZZY/, 'invalidation re-renders the stable block');
  // Default/off → live render every turn (no freeze).
  delete process.env.CLEMMY_BRAIN_STABLE_SNAPSHOT;
  saveUserProfile({ role: 'MARKER_ROLE_SECOND' });
  const live = renderClaudeAgentBrainSystemAppend('home', { message: 'hi', sessionId: sid }, 'read_only');
  assert.match(live, /MARKER_ROLE_SECOND/, 'default renders the vault live');
  invalidateStableMemorySnapshot();
});

test('CONVERGE guard: after the user answers a clarifying question, the turn context steers toward EXECUTION (one beat, no turn-by-turn re-ask)', async () => {
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'on';
  delete process.env.CLEMMY_BRAIN_CONVERGE;
  const sid = createSession({ kind: 'chat' }).id;
  // No prior clarifying question → no convergence steer.
  const before = await renderClaudeAgentBrainTurnContext({ message: 'design a win-back workspace', sessionId: sid });
  assert.doesNotMatch(before, /CONVERGE/);
  // Clem's PREVIOUS turn ended by asking a clarifying question (awaiting-user completion).
  appendEvent({ sessionId: sid, turn: 1, role: 'system', type: 'conversation_completed', data: { awaitingUser: true, summary: 'win-back action or closed-lost diagnosis?' } });
  const after = await renderClaudeAgentBrainTurnContext({ message: 'winback action please', sessionId: sid });
  assert.match(after, /CONVERGE/, 'answering a clarifying question injects the execute-now steer');
  assert.match(after, /EXECUTE the work this turn/);
  assert.match(after, /do NOT ask another separate clarifying question/);
  // An approval card (approval_requested) is NOT a clarifying question — it must not trip the steer.
  const sid2 = createSession({ kind: 'chat' }).id;
  appendEvent({ sessionId: sid2, turn: 1, role: 'system', type: 'conversation_completed', data: { summary: 'done, sent 3 emails' } });
  const normal = await renderClaudeAgentBrainTurnContext({ message: 'thanks', sessionId: sid2 });
  assert.doesNotMatch(normal, /CONVERGE/, 'a normal completion does not trip the steer');
  const sid3 = createSession({ kind: 'chat' }).id;
  appendEvent({ sessionId: sid3, turn: 1, role: 'Clem', type: 'awaiting_user_input', data: { question: 'Background, hold, or now?', source: 'offer_background' } });
  appendEvent({ sessionId: sid3, turn: 1, role: 'system', type: 'conversation_completed', data: { awaitingUser: true } });
  const backgroundChoice = await renderClaudeAgentBrainTurnContext({ message: 'Do it now here', sessionId: sid3 });
  assert.doesNotMatch(backgroundChoice, /CONVERGE/, 'a background routing choice is not a clarification answer');
  // Kill-switch off → no steer even after a clarify.
  process.env.CLEMMY_BRAIN_CONVERGE = 'off';
  const killed = await renderClaudeAgentBrainTurnContext({ message: 'winback action please', sessionId: sid });
  assert.doesNotMatch(killed, /CONVERGE/, 'kill-switch disables the steer');
  delete process.env.CLEMMY_BRAIN_CONVERGE;
});

test('Claude SDK dispatch receives convergence state on a clarification answer', async () => {
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.CLEMMY_TOOL_JIT = 'off';
  const sid = createSession({ kind: 'chat' }).id;
  appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: { question: 'Win-back queue or loss diagnosis?', source: 'decision_awaiting' },
  });
  let capturedTurnContext = '';
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    capturedTurnContext = options.turnContext ?? '';
    return { text: 'Built the win-back queue.', sessionId: sid, model: 'claude-sonnet-5', toolUses: [] };
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Use the win-back queue.',
    sessionId: sid,
  });

  assert.equal(response.text, 'Built the win-back queue.');
  assert.match(capturedTurnContext, /CONVERGE/);
  assert.match(capturedTurnContext, /EXECUTE the work this turn/);
});

test('renderClaudeAgentBrainSystemAppend describes local-authoring workflow/model-role capability', () => {
  const prompt = renderClaudeAgentBrainSystemAppend('home', { message: 'hi', sessionId: 'brain-prompt' }, 'local_authoring');
  assert.match(prompt, /local-authoring tools/);
  assert.match(prompt, /workflow_run only queues/);
  assert.match(prompt, /set_model_role/);
  assert.match(prompt, /usesSkill/);
  assert.doesNotMatch(prompt, /READ-ONLY\/local-context/);
});

test('renderClaudeAgentBrainTurnContext bounds slow unified recall and falls back open', async () => {
  process.env.CLEMMY_BRAIN_QUERY_RECALL_TIMEOUT_MS = '5';
  process.env.CLEMMY_UNIFIED_RECALL = 'off'; // keep degraded breadcrumbs synchronous in this timeout test
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async () => await new Promise(() => { /* intentionally stalled */ }));
  setClaudeAgentSdkBrainSearchFactsHybridForTest(async () => []);
  const start = Date.now();
  const ctx = await renderClaudeAgentBrainTurnContext({ message: 'market leader accounts', sessionId: 'brain-recall-timeout' });
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 1500, `slow recall must not stall turn-context assembly; elapsed ${elapsedMs}ms`);
  assert.doesNotMatch(ctx, /Relevant To Your Request\n- /, 'timed-out recall block is omitted');
});

test('Claude brain primer surfaces an exact-date recorded meeting before external calendar lookup', async () => {
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'on';
  setClaudeAgentSdkBrainUnifiedPrimerForTest(null);
  const db = openMemoryDb();
  const meetingPath = '/vault/04-Meetings/2026-07-14-in-person_meeting-local-review-primer.md';
  const insert = db.prepare(`
    INSERT INTO vault_chunks (path, chunk_index, content, title, mtime, byte_size, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const metadata = `---
type: meeting-transcript
source: local whisper (base.en)
recording_id: recording-in-person-review-primer
title: Scorpion Partnership Revenue and Legal Data Integration Review
started_at: 2026-07-14T20:24:09.442Z
---`;
  const summary = '## Summary\nInternal Scorpion team meeting reviewing partnership revenue against 2026 goals and legal data integration gaps.';
  try {
    insert.run(meetingPath, 0, metadata, null, Date.now(), Buffer.byteLength(metadata), 'primer-meeting-metadata');
    insert.run(meetingPath, 1, summary, 'Summary', Date.now(), Buffer.byteLength(summary), 'primer-meeting-summary');
    const ctx = await renderClaudeAgentBrainTurnContext({
      message: 'What was my recorded meeting on 2026-07-14 about?',
      sessionId: 'brain-recorded-meeting-primer',
    });
    assert.match(ctx, /\[NOTE\]/);
    assert.doesNotMatch(ctx, /\[why:/, 'automatic primer keeps ranking explanations out of the prompt');
    assert.match(ctx, /Scorpion Partnership Revenue and Legal Data Integration Review/);
    assert.match(ctx, /partnership revenue/);
    assert.ok(ctx.includes(meetingPath), 'primer carries the local source path for memory_read');
  } finally {
    db.prepare('DELETE FROM vault_chunks WHERE path = ?').run(meetingPath);
  }
});

test('Claude brain volatile turn context includes degraded harness capability health', async () => {
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'on';
  capabilityHealth.recordHarnessCapabilityHealth({
    id: 'claude_sdk_local_mcp_surface',
    state: 'degraded',
    summary: 'Claude SDK local MCP surface did not advertise tools the harness depends on.',
    reason: 'missing required local MCP tool: memory_recall',
    sessionId: 'brain-health-context',
    details: { missingTools: ['memory_recall'], availableToolCount: 0 },
  });
  capabilityHealth.recordHarnessCapabilityHealth({
    id: 'healthy_thing',
    state: 'healthy',
    summary: 'Healthy should stay silent.',
  });

  const ctx = await renderClaudeAgentBrainTurnContext({ message: 'continue', sessionId: 'brain-health-context' });

  assert.match(ctx, /## Harness Capability Health/);
  assert.match(ctx, /claude_sdk_local_mcp_surface: degraded/);
  assert.match(ctx, /memory_recall/);
  assert.match(ctx, /harness_status/);
  assert.doesNotMatch(ctx, /healthy_thing/);
});

test('Claude brain carries same-session external-write ledger in the volatile turn context', async () => {
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'on';
  createSession({ id: 'brain-actions-split', kind: 'chat', title: 'actions' });
  appendEvent({ sessionId: 'brain-actions-split', turn: 1, role: 'system', type: 'external_write', data: { shapeKey: 'OUTLOOK_SEND_EMAIL', targets: ['casey@example.com'] } });

  const ctx = await renderClaudeAgentBrainTurnContext({ message: 'continue', sessionId: 'brain-actions-split' });

  assert.match(ctx, /ALREADY DONE in THIS conversation/);
  assert.match(ctx, /OUTLOOK_SEND_EMAIL/);
  assert.match(ctx, /casey@example\.com/);
  assert.equal(ctx.match(/ALREADY DONE in THIS conversation/g)?.length, 1);
});

test('Claude brain volatile turn context includes cross-session continuation prefix', async () => {
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'on';
  createSession({ id: 'brain-prefix-split', kind: 'chat', channel: 'discord', title: 'fresh split' });
  appendEvent({
    sessionId: 'brain-prefix-split',
    turn: 0,
    role: 'system',
    type: 'cross_session_prefix',
    data: {
      text: [
        '[CONTINUATION CONTEXT]',
        '  USER: Work from the approved client sheet.',
        '  YOU: I found the correct sheet id.',
      ].join('\n'),
    },
  });

  const ctx = await renderClaudeAgentBrainTurnContext({ message: 'continue', sessionId: 'brain-prefix-split' });

  assert.match(ctx, /\[CONTINUATION CONTEXT\]/);
  assert.match(ctx, /approved client sheet/);
});

test('Claude brain carries same-session external-write ledger in system append when context split is off', () => {
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'off';
  createSession({ id: 'brain-actions-nosplit', kind: 'chat', title: 'actions' });
  appendEvent({ sessionId: 'brain-actions-nosplit', turn: 1, role: 'system', type: 'external_write', data: { shapeKey: 'CRM_UPDATE', targets: ['record:acct-42'] } });

  const prompt = renderClaudeAgentBrainSystemAppend('home', { message: 'continue', sessionId: 'brain-actions-nosplit' }, 'full');

  assert.match(prompt, /ALREADY DONE in THIS conversation/);
  assert.match(prompt, /CRM_UPDATE/);
  assert.match(prompt, /record:acct-42/);
  assert.equal(prompt.match(/ALREADY DONE in THIS conversation/g)?.length, 1);
});

test('Claude brain keeps unified recall enabled when context split is off', async () => {
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'off';
  const sourceUri = 'meeting://local/no-split-review';
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query) => ({
    objective: query,
    answerability: 'supported',
    diagnostics: { candidates: 6, stores: ['episode'], elapsedMs: 2 },
    perStore: { episode: 1 },
    hits: [{
      type: 'episode', ref: 'no-split-review', title: 'In-person no-split review',
      snippet: 'Reviewed the temporal memory rollout.', score: 0.98, confidence: 0.95,
      whyRecalled: ['exact temporal match'],
      evidence: [{ episodeId: 'no-split-review', excerpt: 'Reviewed the rollout.', sourceUri }],
    }],
  }));

  const ctx = await renderClaudeAgentBrainTurnContext({
    message: 'What was my in-person meeting today about?',
    sessionId: 'brain-no-split-unified-memory',
  });

  assert.match(ctx, /\[MEMORY PRIMER\]/);
  assert.match(ctx, /\[EPISODE\].*In-person no-split review/);
  assert.match(ctx, /meeting:\/\/local\/no-split-review/);
  assert.doesNotMatch(ctx, /# Current State/, 'persistent and volatile blocks stay in the system append');
});

test('respondViaClaudeAgentSdkBrain read_only mode uses read-only tools, honors excludes, creates a session, and streams final text', async () => {
  const chunks: string[] = [];
  let captured: any;
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.CLEMMY_TOOL_JIT = 'off'; // pin off: this test guards the unfiltered read-only surface
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    captured = options;
    return {
      text: 'Claude brain reply',
      sessionId: 'sdk-session',
      model: 'claude-sonnet-4-6',
      toolUses: ['mcp__clementine-local__memory_search'],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'search memory',
    sessionId: 'brain-run',
    excludeToolNames: ['memory_read'],
    onChunk: async (delta) => { chunks.push(delta); },
  });

  assert.equal(res.text, 'Claude brain reply');
  assert.equal(res.stoppedReason, 'success');
  assert.equal(res.raw?.transport, 'claude_agent_sdk_brain');
  assert.deepEqual(chunks, ['Claude brain reply']);
  assert.equal(getSession('brain-run')?.metadata?.source, 'claude-agent-sdk-brain:home');
  assert.equal(getSession('brain-run')?.metadata?.readOnly, true);
  assert.equal(captured.prompt, 'search memory');
  assert.equal(captured.sessionId, 'brain-run');
  assert.equal(captured.maxTurns, 24);
  assert.ok(captured.allowedLocalMcpTools.includes('memory_search'));
  assert.ok(captured.allowedLocalMcpTools.includes('memory_remember'));
  assert.equal(captured.allowedLocalMcpTools.includes('memory_read'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('run_shell_command'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('write_file'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('composio_execute_tool'), false);
  // JIT pinned off above → no MCP tool-allowlist passed (server advertises all tools).
  assert.equal(captured.mcpToolAllowlist, undefined, 'JIT off must not filter the MCP surface');
  assert.equal(listEvents('brain-run', { types: ['turn_memory_primer'] }).length, 1);
  assert.equal(listEvents('brain-run', { types: ['agent_context_packet'] }).length, 1);
  const effort = listEvents('brain-run', { types: ['reasoning_effort'] })[0]?.data as { transport?: string; effort?: string } | undefined;
  assert.equal(effort?.transport, 'claude_agent_sdk_brain');
  assert.equal(effort?.effort, 'provider_default');
});

test('Claude dispatch telemetry carries exact unified-primer refs and recall id', async () => {
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.CLEMMY_TOOL_JIT = 'off';
  const sourceUri = '/vault/04-Meetings/2026-07-15-live-review.md';
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query) => ({
    objective: query,
    answerability: 'supported',
    diagnostics: { candidates: 3, stores: ['note', 'episode'], elapsedMs: 7 },
    perStore: { vault: 1 },
    hits: [{
      type: 'vault', ref: sourceUri, title: 'Live review', snippet: 'Reviewed memory reliability.',
      score: 0.97, confidence: 0.95, whyRecalled: ['exact temporal match'],
      evidence: [{ episodeId: `note:${sourceUri}`, excerpt: 'Reviewed memory reliability.', sourceUri }],
    }],
  }));
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'The meeting reviewed memory reliability.', sessionId: 'sdk', model: 'claude', toolUses: [],
  }));

  await respondViaClaudeAgentSdkBrain('home', {
    message: 'What was my meeting today about?', sessionId: 'brain-unified-primer-telemetry',
  });

  const event = listEvents('brain-unified-primer-telemetry', { types: ['turn_memory_primer'] })[0];
  assert.ok(event);
  assert.equal(event.data.source, 'unified');
  assert.equal(event.data.hitCount, 1);
  assert.equal(event.data.includedCount, 1);
  assert.equal(event.data.omittedCount, 0);
  assert.equal(event.data.candidateCount, 3);
  assert.deepEqual(event.data.stores, ['note', 'episode']);
  assert.equal(event.data.answerability, 'supported');
  assert.match(String(event.data.recallId), /^mr-/);
  const run = openMemoryDb().prepare('SELECT surface, candidate_refs_json FROM memory_recall_runs WHERE id = ?')
    .get(event.data.recallId) as { surface: string; candidate_refs_json: string };
  assert.equal(run.surface, 'claude_primer');
  assert.deepEqual(JSON.parse(run.candidate_refs_json), [
    // The snippet carries what the model actually SAW (title + snippet) so
    // post-turn auto-credit can match demonstrable use; identity stays type:id.
    { type: 'note', id: sourceUri, snippet: 'Live review: Reviewed memory reliability.' },
  ]);
});

test('JIT explicitly off: the SDK brain passes the FULL profile + no mcpToolAllowlist (byte-identical surface)', async () => {
  // Guards the kill-switch path: with CLEMMY_TOOL_JIT=off the brain must not reduce
  // the tool surface (no mcpToolAllowlist → MCP server advertises every tool).
  process.env.CLEMMY_TOOL_JIT = 'off';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.AUTH_MODE = 'claude_oauth';
  let captured: any;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    captured = options;
    return { text: 'ok', sessionId: 'sdk', model: 'claude-opus-4-8', toolUses: [], usage: { input_tokens: 1, output_tokens: 1 } };
  });
  await respondViaClaudeAgentSdkBrain('home', { message: 'create a workflow that emails me daily', sessionId: 'jit-off-run' });
  assert.equal(captured.mcpToolAllowlist, undefined, 'no allowlist when JIT is off');
  // full profile still present (e.g. the agentic execution tools), unfiltered.
  assert.ok(captured.allowedLocalMcpTools.includes('composio_execute_tool'));
  assert.ok(captured.allowedLocalMcpTools.includes('run_shell_command'));
});

test('full mode: completion judge bounces a not-done turn into ONE continuation, then returns the finished answer', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const prompts: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    prompts.push(options.prompt);
    return {
      text: prompts.length === 1 ? "I'll send the emails next." : 'Sent all 3 emails — here are the message links.',
      sessionId: 'sdk', model: 'claude-opus-4-8',
      toolUses: ['mcp__clementine-local__composio_execute_tool'],
    };
  });
  let judged = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judged += 1;
    return judged === 1 ? { done: false, reason: 'no message links shown' } : { done: true, reason: 'links present' };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'send the 3 emails', sessionId: 'brain-judge' });

  assert.equal(prompts.length, 2, 'one continuation fired after the not-done verdict');
  assert.match(prompts[1], /continue now and FINISH it/i);
  assert.match(prompts[1], /do NOT proceed on your own/i, 'continuation permits asking before external actions');
  assert.match(res.text, /Sent all 3 emails/);
});

test('Phase 1.3: a SHARED continuation budget caps narration + judge so corrective re-runs cannot stack', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const prevBudget = process.env.CLEMMY_CLAUDE_SDK_MAX_CONTINUATIONS;
  process.env.CLEMMY_CLAUDE_SDK_MAX_CONTINUATIONS = '1';
  try {
    const prompts: string[] = [];
    setClaudeAgentSdkBrainRunForTest(async (options) => {
      prompts.push(options.prompt);
      // 1st attempt narrates a tool call instead of invoking it (no real toolUses).
      if (prompts.length === 1) {
        return { text: 'Tool call: composio_execute_tool { "to": "x" }', sessionId: 'sdk', model: 'm', toolUses: [] };
      }
      // The narration retry "succeeds" with a promise-shaped reply + a real tool
      // use, so the completion judge WOULD want another continuation.
      return { text: "I'll send the emails next.", sessionId: 'sdk', model: 'm', toolUses: ['mcp__clementine-local__composio_execute_tool'] };
    });
    let judged = 0;
    setClaudeAgentSdkBrainJudgeForTest(async () => { judged += 1; return { done: false, reason: 'no evidence shown' }; });

    const res = await respondViaClaudeAgentSdkBrain('home', { message: 'send the 3 emails', sessionId: 'brain-cont-budget' });

    // initial + ONE narration continuation = 2 full-context runs. The narration
    // retry spent the only budgeted continuation, so the judge's not-done verdict
    // does NOT fire a 3rd full re-run (budget exhausted).
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /INVOKE the real tool now/); // the narration retry prompt, not the judge's
    assert.ok(judged >= 1, 'the cheap judge still evaluated — only its expensive continuation is budget-gated');
    assert.ok(res.text.length > 0);
  } finally {
    if (prevBudget === undefined) delete process.env.CLEMMY_CLAUDE_SDK_MAX_CONTINUATIONS;
    else process.env.CLEMMY_CLAUDE_SDK_MAX_CONTINUATIONS = prevBudget;
  }
});

test('full mode: completion judge receives prior user context and SDK tool evidence', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  createSession({ id: 'brain-judge-evidence', kind: 'chat', title: 'judge evidence' });
  appendEvent({
    sessionId: 'brain-judge-evidence',
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Build and publish the Q3 microsite' },
  });
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: "I'll finish publishing the Q3 microsite next.",
    sessionId: 'sdk',
    model: 'claude-opus-4-8',
    toolUses: [
      'mcp__clementine-local__run_shell_command',
      'mcp__clementine-local__composio_execute_tool',
      'mcp__clementine-local__composio_execute_tool',
    ],
  }));
  let judgedObjective = '';
  let toolSummary = '';
  setClaudeAgentSdkBrainJudgeForTest(async (objective, _response, skillContext) => {
    judgedObjective = objective;
    toolSummary = skillContext?.toolCallSummary ?? '';
    return { done: true, reason: 'published URL present' };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'ship it',
    sessionId: 'brain-judge-evidence',
  });

  assert.match(res.text, /finish publishing the Q3 microsite/);
  assert.match(judgedObjective, /Build and publish the Q3 microsite/);
  assert.match(judgedObjective, /Current user message .*ship it/);
  assert.match(toolSummary, /run_shell_command/);
  assert.match(toolSummary, /composio_execute_tool x2/);
});

test('streaming judge continuation appends the corrected final answer when it was not streamed', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_STREAMING = 'on';
  const chunks: string[] = [];
  let runs = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    runs += 1;
    if (runs === 1) {
      await options.onDelta?.("I'll send the emails next.");
      return {
        text: "I'll send the emails next.",
        sessionId: 'sdk', model: 'claude-opus-4-8',
        toolUses: ['mcp__clementine-local__composio_execute_tool'],
      };
    }
    return {
      text: 'Sent all 3 emails — here are the message links.',
      sessionId: 'sdk', model: 'claude-opus-4-8',
      toolUses: ['mcp__clementine-local__composio_execute_tool'],
    };
  });
  let judged = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judged += 1;
    return judged === 1 ? { done: false, reason: 'no message links shown' } : { done: true, reason: 'links present' };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'send the 3 emails',
    sessionId: 'brain-stream-judge',
    onChunk: async (delta) => { chunks.push(delta); },
  });

  assert.equal(res.text, 'Sent all 3 emails — here are the message links.');
  assert.deepEqual(chunks, [
    "I'll send the emails next.",
    '\n\nSent all 3 emails — here are the message links.',
  ]);
});

test('streaming judge continuation suppresses retry deltas after stale streamed text', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_STREAMING = 'on';
  const chunks: string[] = [];
  let runs = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    runs += 1;
    if (runs === 1) {
      await options.onDelta?.("I'll send the emails next.");
      return {
        text: "I'll send the emails next.",
        sessionId: 'sdk', model: 'claude-opus-4-8',
        toolUses: ['mcp__clementine-local__composio_execute_tool'],
      };
    }
    await options.onDelta?.('STREAMED RETRY SHOULD NOT RENDER');
    return {
      text: 'Sent all 3 emails — here are the message links.',
      sessionId: 'sdk', model: 'claude-opus-4-8',
      toolUses: ['mcp__clementine-local__composio_execute_tool'],
    };
  });
  let judged = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judged += 1;
    return judged === 1 ? { done: false, reason: 'no message links shown' } : { done: true, reason: 'links present' };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'send the 3 emails',
    sessionId: 'brain-stream-judge-suppress-retry',
    onChunk: async (delta) => { chunks.push(delta); },
  });

  assert.equal(res.text, 'Sent all 3 emails — here are the message links.');
  assert.deepEqual(chunks, [
    "I'll send the emails next.",
    '\n\nSent all 3 emails — here are the message links.',
  ]);
});

test('local_authoring mode: concrete tool-backed completion skips the redundant judge', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on'; // default Claude brain mode = local_authoring
  const prompts: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    prompts.push(options.prompt);
    return {
      text: 'Created workflow wf_daily_digest and scheduled it for 8am.',
      sessionId: 'sdk', model: 'claude-opus-4-8',
      toolUses: ['mcp__clementine-local__workflow_create'],
    };
  });
  let judged = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judged += 1;
    return { done: false, reason: 'should not run for tool-backed completion' };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'create and schedule a daily digest workflow', sessionId: 'brain-author-judge' });

  assert.equal(prompts.length, 1);
  assert.equal(judged, 0);
  assert.match(res.text, /wf_daily_digest/);
});

test('local_authoring mode: zero-tool completion claims are judged before success', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  const prompts: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    prompts.push(options.prompt);
    return prompts.length === 1
      ? { text: 'Created workflow daily_digest.', sessionId: 'sdk', model: 'claude-opus-4-8', toolUses: [] }
      : {
        text: 'Created workflow wf_daily_digest with workflow_create.',
        sessionId: 'sdk',
        model: 'claude-opus-4-8',
        toolUses: ['mcp__clementine-local__workflow_create'],
      };
  });
  let judged = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judged += 1;
    return judged === 1 ? { done: false, reason: 'no workflow_create evidence' } : { done: true, reason: 'workflow tool evidence present' };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'create a daily digest workflow', sessionId: 'brain-author-zero-tool-claim' });

  assert.equal(prompts.length, 2, 'zero-tool completion claim must be judged and continued');
  assert.match(prompts[1], /no workflow_create evidence/);
  assert.match(res.text, /wf_daily_digest/);
});

test('full mode: completion-judge kill-switch off ⇒ no judge call, no continuation', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  let runs = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    runs += 1;
    return { text: "I'll do it next", sessionId: 's', toolUses: ['mcp__clementine-local__run_shell_command'] };
  });
  let judged = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => { judged += 1; return { done: false, reason: 'x' }; });

  await respondViaClaudeAgentSdkBrain('home', { message: 'do the thing', sessionId: 'brain-nojudge' });

  assert.equal(runs, 1, 'no continuation when the judge is off');
  assert.equal(judged, 0, 'judge not called when off');
});

test('turn-budget stop surfaces as max-turns-with-grace and writes user_input + lifecycle events', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only'; // read_only ⇒ judge skipped
  setClaudeAgentSdkBrainRunForTest(async () => ({ text: 'partial work so far', sessionId: 's', toolUses: [], limitHit: true }));

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'a long multi-step task', sessionId: 'brain-limit' });

  assert.equal(res.stoppedReason, 'max-turns-with-grace');
  assert.match(res.text, /Say "continue"/);
  assert.equal(res.raw?.limitHit, true);
  const events = listEvents('brain-limit');
  const types = events.map((e) => (e as { type?: string }).type);
  assert.ok(types.includes('user_input_received'), 'user_input_received written for the SDK brain');
  assert.ok(types.includes('conversation_completed'), 'conversation_completed emitted');
  assert.ok(types.includes('conversation_limit_exceeded'), 'limit event emitted for paused/stopped classification');
  assert.ok(
    types.indexOf('conversation_limit_exceeded') < types.indexOf('conversation_completed'),
    'limit telemetry lands before the user-facing continue completion',
  );
  const completed = events.find((e) => (e as { type?: string }).type === 'conversation_completed') as { data?: Record<string, unknown> } | undefined;
  assert.equal(completed?.data?.reason, 'awaiting_continue');
  assert.match(String(completed?.data?.reply ?? ''), /Say "continue"/);
});

test('F1: a limit-hit WITH tool progress AUTO-CONTINUES and finishes (no park)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    calls += 1;
    // Turn 1: made tool progress (2 firms) but hit the per-query turn budget.
    if (calls === 1) return { text: 'Did firms 1-2. Continuing with the remaining 3.', sessionId: 's', model: 'claude-sonnet-5', toolUses: ['mcp__clementine-local__composio_execute_tool'], limitHit: true };
    // Continuation: finishes the rest.
    return { text: 'Done — deep SEO for all 5 firms.', sessionId: 's', model: 'claude-sonnet-5', toolUses: ['mcp__clementine-local__composio_execute_tool'], limitHit: false };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'get deep SEO for 5 firms', sessionId: 'brain-autocont' });

  assert.equal(calls, 2, 'auto-continued exactly once past the turn budget');
  assert.equal(res.stoppedReason, 'success', 'finished, not parked');
  assert.doesNotMatch(res.text, /Say "continue"/, 'no park prompt — it finished');
  assert.match(res.text, /all 5 firms/);
  assert.ok(listEvents('brain-autocont').some((e) => (e as { type?: string }).type === 'sdk_auto_continue'), 'auto-continue telemetry emitted');
});

test('F1: no forward progress (0 tool calls) does NOT auto-continue — still parks', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => { calls += 1; return { text: 'stuck', sessionId: 's', toolUses: [], limitHit: true }; });
  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'x', sessionId: 'brain-autocont-noprog' });
  assert.equal(calls, 1, 'a limit-hit with NO tool progress must not auto-continue (anti-loop)');
  assert.match(res.text, /Say "continue"/);
});

test('H2: a skill loaded before the turn cap is RE-INJECTED into the auto-continue (not dropped)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  createSession({ id: 'brain-skill-cont', kind: 'chat', title: 's' });
  // Simulate a skill_read earlier in the run: the tool_called event + the stored body.
  appendEvent({ sessionId: 'brain-skill-cont', turn: 0, role: 'Clem', type: 'tool_called', data: { tool: 'skill_read', callId: 'sk1', args: { name: 'client-seo-report' } } });
  writeToolOutput({ sessionId: 'brain-skill-cont', callId: 'sk1', tool: 'skill_read', output: 'Skill: client-seo-report\nmanifest…\n---\nSTEP 1: pull ranked keywords. STEP 2: compute the SEO_MAGIC_SCORE_XYZ. STEP 3: render the branded HTML.' });

  const prompts: string[] = [];
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls += 1;
    prompts.push(options.prompt ?? '');
    if (calls === 1) return { text: 'Did step 1 (keywords), hit the budget.', sessionId: 's', toolUses: ['mcp__clementine-local__composio_execute_tool'], limitHit: true };
    return { text: 'Finished — rendered the branded report.', sessionId: 's', toolUses: ['mcp__clementine-local__composio_execute_tool'], limitHit: false };
  });

  await respondViaClaudeAgentSdkBrain('home', { message: 'run the seo report skill for the firm', sessionId: 'brain-skill-cont' });

  assert.equal(calls, 2, 'auto-continued once');
  // The continuation prompt (call 2) must carry the skill body — else the model
  // would hand-roll the deliverable and get bounced by the skill-execution gate.
  assert.match(prompts[1], /SEO_MAGIC_SCORE_XYZ/, 'the skill procedure was re-injected into the continuation');
  assert.match(prompts[1], /KEEP FOLLOWING/);
});

test('F1: kill-switch CLEMMY_CLAUDE_SDK_AUTO_CONTINUE=off ⇒ parks on limit (prior behavior)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.CLEMMY_CLAUDE_SDK_AUTO_CONTINUE = 'off';
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => { calls += 1; return { text: 'partial', sessionId: 's', toolUses: ['x'], limitHit: true }; });
  try {
    const res = await respondViaClaudeAgentSdkBrain('home', { message: 'long task', sessionId: 'brain-autocont-off' });
    assert.equal(calls, 1, 'no auto-continue when the kill-switch is off');
    assert.match(res.text, /Say "continue"/);
  } finally {
    delete process.env.CLEMMY_CLAUDE_SDK_AUTO_CONTINUE;
  }
});

test('streaming max-turn stop appends the missing continue guidance instead of suppressing it', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.CLEMMY_CLAUDE_SDK_STREAMING = 'on';
  const chunks: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    await options.onDelta?.('partial work so far');
    return { text: 'partial work so far', sessionId: 's', toolUses: [], limitHit: true };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'a long multi-step task',
    sessionId: 'brain-stream-limit',
    onChunk: async (delta) => { chunks.push(delta); },
  });

  assert.equal(res.stoppedReason, 'max-turns-with-grace');
  assert.match(chunks.join(''), /partial work so far\n\nI hit the turn budget/);
  assert.match(chunks.join(''), /Say "continue"/);
});

test('looksLikeToolNarration flags described-but-not-called tool protocol, ignores real tool calls', () => {
  // The exact shape from the live failure (sess-mql8hb50): narrated, zero tool calls.
  assert.equal(looksLikeToolNarration('Tool:run_shell_command\n\nSystem: tool result is empty\n\nfunction\n{"command":"sf data query"}', []), true);
  assert.equal(looksLikeToolNarration('{"command": "sf data query --json"}', []), true);
  // The 2026-06-22 Workspace-build failure (space-new-workspace-2): the native
  // tool-call XML emitted AS TEXT — nothing ran, so the workspace was never built.
  assert.equal(looksLikeToolNarration('<invoke name="run_shell_command">\n<parameter name="command">sf data query</parameter>\n</invoke>', []), true);
  assert.equal(looksLikeToolNarration('<invoke name="space_save">', []), true);
  assert.equal(looksLikeToolNarration('Fields 40-89:\n<invoke name="run_shell_command"><parameter name="command">ls</parameter></invoke>', []), true);
  // The 2026-06-23 dock failure: a markdown "**Tool call: NAME**" header + a
  // ```json args block, on the Claude brain in FULL mode (42 tools exposed).
  assert.equal(looksLikeToolNarration('**Tool call: skill_read**\n```json\n{\n  "name": "salesforce-deal-risk-workspace"\n}\n```', []), true);
  assert.equal(looksLikeToolNarration('Tool call: skill_read\n{"name":"x"}', []), true);
  assert.equal(looksLikeToolNarration('<tool_call>\n{"name":"skill_read"}', []), true);
  assert.equal(looksLikeToolNarration('[tool_call] skill_read', []), true);
  assert.equal(looksLikeToolNarration('{"tool_slug": "SALESFORCE_RUN_SOQL_QUERY", "arguments": {}}', []), true);
  // The 2026-06-30 live failure (v0.12.46 desktop): the brain wrapped its tool calls
  // in a hallucinated <system>…</system> pseudo-tag, so a Workspace build + Composio
  // search + offer_background all narrated and NOTHING ran. The `<system>` prefix
  // defeated the old line-anchored header. Both exact live strings must now trip.
  assert.equal(looksLikeToolNarration('<system>Tool call: composio_search_tools — {"query": "apify run actor facebook ad library scraper dataset items"}</system>', []), true);
  assert.equal(looksLikeToolNarration('I\'ll set that up.\n\n<system>Tool call: offer_background — {"summary": "Build the Meta-ads workspace", "options": ["background", "hold", "now"]}</system>', []), true);
  assert.equal(looksLikeToolNarration('<assistant>Tool call: space_save — {"slug":"x"}</assistant>', []), true);
  // The 2026-07-01 live failure (Scorpion calendar, Sonnet-5 brain): the brain PRINTED
  // OpenAI-style function-calling JSON and a "[Tool: NAME]" reference instead of firing the
  // tool — nothing ran. Both exact live shapes must trip.
  assert.equal(looksLikeToolNarration("I'll pull today's events now.\n\n{\"tool_call\":{\"name\":\"composio_search_tools\",\"arguments\":{\"query\":\"outlook calendar\"}}}", []), true);
  assert.equal(looksLikeToolNarration('[Tool: OUTLOOK_OUTLOOK_GET_CALENDAR_VIEW]', []), true);
  assert.equal(looksLikeToolNarration('{"name":"composio_execute_tool","arguments":{"tool_slug":"X"}}', []), true);
  assert.equal(looksLikeToolNarration('{"function":{"name":"run_shell_command","arguments":{}}}', []), true);
  // …but these SHAPES must not false-flag normal prose that merely mentions the words:
  assert.equal(looksLikeToolNarration('The [tool] I recommend is the calendar view — want me to pull it?', []), false);
  assert.equal(looksLikeToolNarration('Your event is named "Weekly Sync" and the arguments we set look right.', []), false);
  // Real tool calls happened ⇒ not narration, even if text mentions tools / XML.
  assert.equal(looksLikeToolNarration('Tool:run_shell_command', ['mcp__clementine-local__run_shell_command']), false);
  assert.equal(looksLikeToolNarration('<invoke name="run_shell_command">', ['run_shell_command']), false);
  assert.equal(looksLikeToolNarration('**Tool call: skill_read**', ['skill_read']), false);
  // Normal prose ⇒ not narration (a mid-sentence "tool call" must NOT false-flag).
  assert.equal(looksLikeToolNarration('Pulled your 5 accounts — here they are.', []), false);
  assert.equal(looksLikeToolNarration('I will invoke the report generator and send it over.', []), false);
  assert.equal(looksLikeToolNarration('Here is what each tool call does in the pipeline, summarized.', []), false);
  assert.equal(looksLikeToolNarration('The tool call budget looks fine for this run.', []), false);
  assert.equal(looksLikeToolNarration('', []), false);
});

test('sdkStreamingEnabled defaults ON (clean streaming — narration suppressed + reply unwrapped); =off reverts', () => {
  delete process.env.CLEMMY_CLAUDE_SDK_STREAMING;
  assert.equal(sdkStreamingEnabled(), true);
  process.env.CLEMMY_CLAUDE_SDK_STREAMING = 'off';
  assert.equal(sdkStreamingEnabled(), false);
  process.env.CLEMMY_CLAUDE_SDK_STREAMING = 'on';
  assert.equal(sdkStreamingEnabled(), true);
  delete process.env.CLEMMY_CLAUDE_SDK_STREAMING;
});

test('looksLikeStreamingNarration suppresses live streaming the moment tool-call XML/protocol appears, never on clean prose', () => {
  // The high-precision markers that must cut the live stream (the dock noise).
  assert.equal(looksLikeStreamingNarration('Let me check…\n<invoke name="run_shell_command">'), true);
  assert.equal(looksLikeStreamingNarration('<parameter name="command">ls</parameter>'), true);
  assert.equal(looksLikeStreamingNarration('**Tool call: skill_read**'), true);
  assert.equal(looksLikeStreamingNarration('Tool call: workflow_get'), true);
  assert.equal(looksLikeStreamingNarration('<tool_call>'), true);
  assert.equal(looksLikeStreamingNarration('[tool_call] skill_read'), true);
  // 2026-06-30 live: the <system>-wrapped header must cut the stream too.
  assert.equal(looksLikeStreamingNarration('<system>Tool call: composio_search_tools — {"query": "x"}</system>'), true);
  // Clean prose must keep streaming — no false cut mid-answer.
  assert.equal(looksLikeStreamingNarration('Pulled your 5 deals — here is the summary.'), false);
  assert.equal(looksLikeStreamingNarration('Here is what each tool call does in the pipeline.'), false);
  assert.equal(looksLikeStreamingNarration('I will invoke the report generator next.'), false);
  assert.equal(looksLikeStreamingNarration(''), false);
});

test('renderClaudeAgentBrainSystemAppend injects the workspace primer for a "space-" session', async () => {
  const { spaceStore } = await import('../../spaces/store.js');
  spaceStore.save({ id: 'deal-risk', title: 'Deal Risk', actions: [], dataSources: [] });
  const out = renderClaudeAgentBrainSystemAppend(
    'dashboard', { sessionId: 'space-deal-risk', message: 'add a close-date filter' } as never, 'full');
  assert.match(out, /space_edit_view\('deal-risk'/);
  assert.match(out, /Deal Risk/);
  // a plain (non-space) session gets no workspace primer
  const plain = renderClaudeAgentBrainSystemAppend('dashboard', { sessionId: 'sess-abc', message: 'hi' } as never, 'full');
  assert.ok(!/space_edit_view/.test(plain));
});

test('full mode: a narrated (no-tool-call) turn triggers ONE retry that actually invokes the tool', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off'; // isolate the narration retry
  const calls: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls.push(options.prompt);
    return calls.length === 1
      ? { text: 'Tool:run_shell_command\n\nSystem: tool result is empty\n\nfunction\n{"command":"sf data query"}', sessionId: 's', toolUses: [] }
      : { text: 'Pulled 5 accounts: Acme, Globex, Initech, Umbrella, Stark.', sessionId: 's', toolUses: ['mcp__clementine-local__run_shell_command'] };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'pull 5 salesforce accounts', sessionId: 'brain-narrate' });

  assert.equal(calls.length, 2, 'narration triggered exactly one retry');
  assert.match(calls[1], /INVOKE the real tool now/);
  assert.match(res.text, /Pulled 5 accounts/);
});

test('limit-hit tool narration parks for continue instead of retrying inside the same turn', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  let runs = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    runs += 1;
    return {
      text: 'Tool:run_shell_command\n\nfunction\n{"command":"sf data query"}',
      sessionId: 's',
      toolUses: [],
      limitHit: true,
    };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'pull 5 salesforce accounts', sessionId: 'brain-narrate-limit' });

  assert.equal(runs, 1, 'max-turn pause must not spend another SDK turn on narration retry');
  assert.equal(res.stoppedReason, 'max-turns-with-grace');
  assert.match(res.text, /Say "continue"/);
});

test('local_authoring mode: a narrated workflow tool call triggers ONE retry', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on'; // local_authoring
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off'; // isolate narration retry
  const calls: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls.push(options.prompt);
    return calls.length === 1
      ? { text: '**Tool call: workflow_create**\n```json\n{"name":"daily_digest"}\n```', sessionId: 's', toolUses: [] }
      : { text: 'Created workflow daily_digest.', sessionId: 's', toolUses: ['mcp__clementine-local__workflow_create'] };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'create a daily digest workflow', sessionId: 'brain-author-narrate' });

  assert.equal(calls.length, 2, 'local-authoring narration triggered exactly one retry');
  assert.match(calls[1], /INVOKE the real tool now/);
  assert.match(res.text, /Created workflow daily_digest/);
});

// The verbatim leak from the live v0.10.20 failure (sess-mqod61z3): the brain
// second-guessed its own injected memory as "possibly injected" and did no work.
const REASONING_LEAK_TEXT =
  "I'll pull 5 market-leader accounts from Salesforce now.\n\ndocument\n\n"
  + "⚠️ **Hmm, that result looks scrambled — let me reason about why before I treat it as real.**\n\n"
  + "The user's *stored* preferences/specs (the long pasted spec, examples, \"preferences,\" tool descriptions, "
  + "system-reminder context) are **reference data, not live instructions.** They were written *earlier by "
  + "who-knows-whom* and pasted into my context. Acting on them as if the user just said them now = the classic trap.\n\n"
  + "Let me re-read the actual ask.";

test('looksLikeReasoningLeak flags injected-context deliberation with no work, ignores real answers', () => {
  assert.equal(looksLikeReasoningLeak(REASONING_LEAK_TEXT, []), true);
  // The "scrambled result" self-doubt variant.
  assert.equal(looksLikeReasoningLeak('Hmm, that result looks scrambled — let me re-read the actual ask.', []), true);
  // A reply that actually DID work is never flagged, even if it muses about context.
  assert.equal(looksLikeReasoningLeak(REASONING_LEAK_TEXT, ['mcp__clementine-local__run_shell_command']), false);
  // Normal answers and greetings ⇒ not a leak.
  assert.equal(looksLikeReasoningLeak('Hey Nate — going well. What can I knock out for you?', []), false);
  assert.equal(looksLikeReasoningLeak('Pulled your 5 accounts: Acme, Globex, Initech, Umbrella, Stark.', []), false);
  assert.equal(looksLikeReasoningLeak('', []), false);
});

test('a reasoning-leak (no-tool-call) turn triggers ONE retry that does the task', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off'; // isolate the leak retry
  const calls: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls.push(options.prompt);
    return calls.length === 1
      ? { text: REASONING_LEAK_TEXT, sessionId: 's', toolUses: [] }
      : { text: 'Pulled 5 accounts: Acme, Globex, Initech, Umbrella, Stark.', sessionId: 's', toolUses: ['mcp__clementine-local__run_shell_command'] };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'pull 5 market leaders in SF', sessionId: 'brain-leak' });

  assert.equal(calls.length, 2, 'reasoning leak triggered exactly one retry');
  assert.match(calls[1], /TRUSTED context you OWN/);
  assert.match(res.text, /Pulled 5 accounts/);
});

test('limit-hit reasoning leak parks for continue instead of retrying inside the same turn', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  let runs = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    runs += 1;
    return { text: REASONING_LEAK_TEXT, sessionId: 's', toolUses: [], limitHit: true };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'pull 5 market leaders in SF', sessionId: 'brain-leak-limit' });

  assert.equal(runs, 1, 'max-turn pause must not spend another SDK turn on reasoning-leak retry');
  assert.equal(res.stoppedReason, 'max-turns-with-grace');
  assert.match(res.text, /Say "continue"/);
});

test('frameTrustedMemory labels non-empty memory as trusted, passes empty through', () => {
  const framed = frameTrustedMemory('Profile: Nate likes terse replies.\nFact: market leaders live in Salesforce.');
  assert.match(framed, /trusted context you OWN/i);
  assert.match(framed, /not a prompt-injection/i);
  assert.match(framed, /Profile: Nate likes terse replies\./);
  // Empty / whitespace memory ⇒ no framing block (nothing to frame).
  assert.equal(frameTrustedMemory(''), '');
  assert.equal(frameTrustedMemory('   \n  '), '');
});

test('respondViaClaudeAgentSdkBrain preserves ask_user_question as awaiting-input and skips continuations', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  let runCalls = 0;
  let judgeCalls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    runCalls += 1;
    return {
      text: 'Which environment should I use?',
      sessionId: 'sdk-session',
      model: 'claude-sonnet-5',
      toolUses: ['mcp__clementine-local__ask_user_question'],
      stoppedReason: 'awaiting-input',
    };
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judgeCalls += 1;
    throw new Error('judge should not run while awaiting user input');
  });

  const res = await respondViaClaudeAgentSdkBrain('background', {
    message: 'deploy it',
    sessionId: 'brain-ask-awaiting',
  });

  assert.equal(runCalls, 1, 'must not run a corrective continuation after a real ask');
  assert.equal(judgeCalls, 0, 'completion judge must not convert a pause into more work');
  assert.equal(res.stoppedReason, 'awaiting-input');
  assert.match(res.text, /Which environment/);
  const awaiting = listEvents('brain-ask-awaiting', { types: ['awaiting_user_input'] });
  assert.equal(awaiting.length, 1, 'the production brain path durably records the pause');
  assert.equal(awaiting[0].data.question, 'Which environment should I use?');
  const completions = listEvents('brain-ask-awaiting', { types: ['conversation_completed'] });
  assert.equal(completions.at(-1)?.data.reason, 'awaiting_user_input');
  assert.equal(completions.at(-1)?.data.awaitingUser, true);

  let nextTurnContext = '';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    runCalls += 1;
    nextTurnContext = options.turnContext ?? '';
    return {
      text: 'Configured the production deployment.',
      sessionId: 'sdk-session',
      model: 'claude-sonnet-5',
      toolUses: [],
    };
  });
  await respondViaClaudeAgentSdkBrain('background', {
    message: 'Use production.',
    sessionId: 'brain-ask-awaiting',
  });
  assert.equal(runCalls, 2);
  assert.equal(judgeCalls, 0, 'the convergence assertion is independent of completion judging');
  assert.match(nextTurnContext, /CONVERGE/);
  assert.match(nextTurnContext, /EXECUTE the work this turn/);
});

test('respondViaClaudeAgentSdkBrain persists a material plain-text clarification as awaiting-input', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'Which audience should this rollout brief target?',
    sessionId: 'sdk-session',
    model: 'claude-sonnet-5',
    toolUses: [],
  }));

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Prepare a rollout brief; the audience is unresolved.',
    sessionId: 'brain-plain-material-ask',
  });

  assert.equal(res.stoppedReason, 'awaiting-input');
  const awaiting = listEvents('brain-plain-material-ask', { types: ['awaiting_user_input'] });
  assert.equal(awaiting.length, 1);
  assert.equal(awaiting[0].data.question, 'Which audience should this rollout brief target?');
  const completed = listEvents('brain-plain-material-ask', { types: ['conversation_completed'] }).at(-1);
  assert.equal(completed?.data.reason, 'awaiting_user_input');
  assert.equal(completed?.data.awaitingUser, true);
});

test('respondViaClaudeAgentSdkBrain local_authoring mode exposes curated local authoring tools but not broad execution', async () => {
  let captured: any;
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    captured = options;
    return {
      text: 'Created the workflow draft.',
      sessionId: 'sdk-session',
      model: 'claude-opus-4-8',
      toolUses: ['mcp__clementine-local__workflow_create'],
    };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'create a design workflow',
    sessionId: 'brain-author',
    excludeToolNames: ['workflow_set_enabled'],
  });

  assert.equal(res.text, 'Created the workflow draft.');
  assert.equal(res.raw?.mode, 'local_authoring');
  assert.equal(getSession('brain-author')?.metadata?.readOnly, false);
  assert.equal(getSession('brain-author')?.metadata?.mode, 'local_authoring');
  assert.ok(captured.allowedLocalMcpTools.includes('workflow_create'));
  assert.ok(captured.allowedLocalMcpTools.includes('workflow_run'));
  assert.ok(captured.allowedLocalMcpTools.includes('set_model_role'));
  assert.ok(captured.allowedLocalMcpTools.includes('memory_remember'));
  assert.equal(captured.allowedLocalMcpTools.includes('workflow_set_enabled'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('run_shell_command'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('write_file'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('composio_execute_tool'), false);
});

test('salvage A: a parse error AFTER work committed returns a SUCCESS confirmation and NEVER re-runs (no double-send)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE; // default on
  createSession({ id: 'salvage-committed', kind: 'chat', title: 'salvage' });
  // The 3 emails already sent this turn — recorded as external_write events.
  for (const t of ['a@x.com', 'b@y.com', 'c@z.com']) {
    appendEvent({ sessionId: 'salvage-committed', turn: 0, role: 'tool', type: 'external_write', data: { shapeKey: 'OUTLOOK_OUTLOOK_SEND_EMAIL', toolName: 'composio_execute_tool', targets: [t] } });
  }
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => { calls += 1; throw new Error("Claude Code returned an error result: The model's tool call could not be parsed (retry also failed)."); });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'sent' }));
  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'send those 3 emails', sessionId: 'salvage-committed' });
  assert.equal(calls, 1, 'must NOT re-run after a committed send (no double-send)');
  assert.equal(res.stoppedReason, 'success');
  assert.match(res.text, /3 emails/);
  assert.match(res.text, /a@x\.com/);
  // HONEST: it must NOT over-claim "Done" — it reports what ran and asks to verify.
  assert.match(res.text, /nothing was duplicated/i);
  assert.match(res.text, /check|verify|missing/i);
  assert.doesNotMatch(res.text, /could not be parsed|went wrong|✅ Done/i);
});

test('salvage A2: a COMMITTED provider overload returns an honest partial (never re-runs, no double-send)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE; // default on
  createSession({ id: 'overload-committed', kind: 'chat', title: 'overload salvage' });
  // 2 emails already sent this turn when the provider 529'd mid-run (21-min-in case).
  for (const t of ['a@x.com', 'b@y.com']) {
    appendEvent({ sessionId: 'overload-committed', turn: 0, role: 'tool', type: 'external_write', data: { shapeKey: 'OUTLOOK_OUTLOOK_SEND_EMAIL', toolName: 'composio_execute_tool', targets: [t] } });
  }
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => { calls += 1; throw new ClaudeSdkProviderOverloadError('API Error: 529 overloaded_error', true); });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'sent' }));
  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'send those 2 emails', sessionId: 'overload-committed' });
  assert.equal(calls, 1, 'must NOT re-run after a committed overload (no double-send)');
  assert.match(res.text, /2 emails/);
  assert.match(res.text, /nothing was duplicated/i);
  // The user gets an honest recoverable message, NOT a bare "overloaded" error.
  assert.doesNotMatch(res.text, /overloaded_error|529|went wrong/i);
});

test('salvage A2b: an UNCOMMITTED overload still propagates (so the transplant to another brain runs)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE;
  createSession({ id: 'overload-uncommitted', kind: 'chat', title: 'overload uncommitted' });
  // No external_write events → nothing to salvage.
  setClaudeAgentSdkBrainRunForTest(async () => { throw new ClaudeSdkProviderOverloadError('API Error: 529 overloaded_error', true); });
  await assert.rejects(
    respondViaClaudeAgentSdkBrain('home', { message: 'do a thing', sessionId: 'overload-uncommitted' }),
    /overloaded_error|529/i,
    'a committed overload with no writes to salvage propagates for the caller to handle',
  );
});

test('salvage B: a parse error with NOTHING committed retries once and succeeds', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE;
  createSession({ id: 'salvage-retry', kind: 'chat', title: 'salvage retry' });
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    calls += 1;
    if (calls === 1) throw new Error("Claude Code returned an error result: The model's tool call could not be parsed (retry also failed).");
    return { text: 'Here is your answer.', sessionId: 'sdk', model: 'claude-opus-4-8', toolUses: [] };
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'ok' }));
  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'what is 2+2', sessionId: 'salvage-retry' });
  assert.equal(calls, 2, 'retried once after a pre-commit parse error');
  assert.match(res.text, /Here is your answer/);
});

test('salvage: kill-switch off ⇒ the parse error propagates (byte-identical to before)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_SALVAGE = 'off';
  createSession({ id: 'salvage-off', kind: 'chat', title: 'off' });
  appendEvent({ sessionId: 'salvage-off', turn: 0, role: 'tool', type: 'external_write', data: { shapeKey: 'X', toolName: 'composio_execute_tool', targets: ['a@x.com'] } });
  setClaudeAgentSdkBrainRunForTest(async () => { throw new Error("Claude Code returned an error result: The model's tool call could not be parsed (retry also failed)."); });
  await assert.rejects(
    () => respondViaClaudeAgentSdkBrain('home', { message: 'go', sessionId: 'salvage-off' }),
    /could not be parsed/,
  );
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE;
});

test('overflow A2: a COMMITTED context overflow salvages an honest partial (never re-runs)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE; // default on
  createSession({ id: 'overflow-committed', kind: 'chat', title: 'overflow salvage' });
  appendEvent({ sessionId: 'overflow-committed', turn: 0, role: 'tool', type: 'external_write', data: { shapeKey: 'OUTLOOK_OUTLOOK_SEND_EMAIL', toolName: 'composio_execute_tool', targets: ['a@x.com'] } });
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => { calls += 1; throw new ClaudeSdkContextOverflowError('prompt is too long: 214000 tokens > 200000 maximum', true); });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'sent' }));
  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'send that email', sessionId: 'overflow-committed' });
  assert.equal(calls, 1, 'must NOT re-run after a committed overflow (no double-send)');
  assert.doesNotMatch(res.text, /prompt is too long|went wrong/i);
});

test('overflow A2: an UNCOMMITTED context overflow retries ONCE with reduced context (recall dropped, session actions kept)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE;
  createSession({ id: 'overflow-uncommitted', kind: 'chat', title: 'overflow retry' });
  const seen: Array<{ priorTurns?: unknown[]; turnContext?: string }> = [];
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async (opts: any) => {
    calls += 1;
    seen.push({ priorTurns: opts.priorTurns, turnContext: opts.turnContext });
    if (calls === 1) throw new ClaudeSdkContextOverflowError('context length exceeded', false);
    return { text: 'finished after reduced retry', toolUses: [] };
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'ok' }));
  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'finish the report', sessionId: 'overflow-uncommitted' });
  assert.equal(calls, 2, 'exactly one reduced-context retry');
  assert.match(res.text, /finished after reduced retry/);
  const retry = seen[1];
  assert.ok((retry.priorTurns?.length ?? 0) <= 2, 'prior turns halved to the last 2');
  assert.ok(!(retry.turnContext ?? '').includes('## Relevant To Your Request'), 'recall section dropped on the retry');
  assert.ok(!(retry.turnContext ?? '').includes('[MEMORY PRIMER]'), 'unified recall section dropped on the retry');
});

test('A3: the auto-continue prompt carries the tool-call recall ledger (callIds for tool_output_query)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  let calls = 0;
  const prompts: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (opts: any) => {
    calls += 1;
    prompts.push(String(opts.prompt ?? ''));
    if (calls === 1) {
      return {
        text: 'Scraped 60 of 100 leads so far.',
        sessionId: 's',
        toolUses: ['mcp__clementine-local__composio_execute_tool'],
        toolCallLedger: [
          { callId: 'toolu_abc123', name: 'composio_execute_tool', argsPreview: '{"tool_slug":"APIFY_GET_DATASET_ITEMS"}' },
        ],
        limitHit: true,
      };
    }
    return { text: 'All 100 leads done.', sessionId: 's', toolUses: ['mcp__clementine-local__composio_execute_tool'], limitHit: false };
  });
  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'scrape 100 leads', sessionId: 'brain-ledger' });
  assert.equal(calls, 2);
  assert.match(res.text, /All 100 leads done/);
  const contPrompt = prompts[1];
  assert.match(contPrompt, /tool_output_query/, 'ledger instruction present');
  assert.match(contPrompt, /toolu_abc123/, 'earlier callId handed to the continuation');
  assert.match(contPrompt, /APIFY_GET_DATASET_ITEMS/, 'args preview present');
});

test('spine: the FIRST auto-continue of a long chat run carries the background offer, one-shot', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  let calls = 0;
  const prompts: string[] = [];
  const manyTools = Array.from({ length: 8 }, () => 'mcp__clementine-local__composio_execute_tool');
  setClaudeAgentSdkBrainRunForTest(async (opts: any) => {
    calls += 1;
    prompts.push(String(opts.prompt ?? ''));
    // Two limit-hits in a row: the offer must ride the first continuation only.
    if (calls <= 2) return { text: `batch ${calls} done, more remain`, sessionId: 's', toolUses: manyTools, limitHit: true };
    return { text: 'All batches done.', sessionId: 's', toolUses: manyTools, limitHit: false };
  });
  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'process 30 firms', sessionId: 'brain-bg-offer' });
  assert.equal(calls, 3);
  assert.match(res.text, /All batches done/);
  assert.match(prompts[1], /\[background offer\]/, 'first auto-continue carries the offer');
  assert.match(prompts[1], /offer_background/, 'steers to the terminal tool');
  assert.doesNotMatch(prompts[2], /\[background offer\]/, 'one-shot — never repeated');
  const nudgeEvent = listEvents('brain-bg-offer').find(
    (e) => (e as { type?: string }).type === 'heartbeat'
      && ((e as { data?: { kind?: string } }).data?.kind === 'background_offer_nudge'),
  );
  assert.ok(nudgeEvent, 'nudge telemetry emitted at the boundary');
});

test('overflow A2: committed overflow with ZERO external writes falls through to the reduced retry (reads are safe)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE;
  createSession({ id: 'overflow-committed-reads', kind: 'chat', title: 'read-heavy overflow' });
  // No external_write events — a read-heavy research run that overflowed mid-run.
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    calls += 1;
    if (calls === 1) throw new ClaudeSdkContextOverflowError('prompt is too long', true);
    return { text: 'finished after retry', toolUses: [] };
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'ok' }));
  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'research everything', sessionId: 'overflow-committed-reads' });
  assert.equal(calls, 2, 'reduced retry ran instead of dying unsalvaged');
  assert.match(res.text, /finished after retry/);
});

test('brain runOptions demand the local-MCP sentinel so tool starvation throws instead of running blind', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  let seen: string[] | undefined;
  setClaudeAgentSdkBrainRunForTest(async (opts: any) => {
    seen = opts.requiredLocalMcpTools;
    return { text: 'ok', toolUses: [] };
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'ok' }));
  await respondViaClaudeAgentSdkBrain('home', { message: 'hi', sessionId: 'sentinel-check' });
  assert.deepEqual(seen, ['memory_recall_all'], 'unified-memory sentinel demanded on every brain run');
});
