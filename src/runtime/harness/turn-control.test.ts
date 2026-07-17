/**
 * Run: npx tsx --test src/runtime/harness/turn-control.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-turn-control-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  beginRunAttempt,
  createSession,
  requestKill,
  clearKill,
  accrueSessionTokens,
  listEvents,
  recordRunAttemptUserInput,
} = await import('./eventlog.js');
const { openRunTokenWindow } = await import('./run-token-budget.js');
const {
  killGateVerdict,
  grindGateVerdict,
  composeKillAwareShouldCancel,
  evaluateTurnBoundary,
  shouldOfferBackground,
  backgroundOfferEnabled,
  classifyTurnPreflight,
  confirmBeatDirective,
  effectiveTurnObjective,
  preflightGateVerdict,
  recordTurnPreflightDecision,
  TurnPreflightPersistenceError,
} = await import('./turn-control.js');
const { appendEvent } = await import('./eventlog.js');

let seq = 0;
function freshSession(kind = 'chat'): string {
  seq += 1;
  const id = `turn-control-test-${Date.now().toString(36)}-${seq}`;
  createSession({ id, kind } as never);
  return id;
}

afterEach(() => {
  delete process.env.CLEMMY_BG_OFFER_NUDGE;
  delete process.env.CLEMMY_GUARDRAIL_MUT_WARN;
  delete process.env.CLEMMY_GUARDRAIL_MUT_HALT;
  delete process.env.CLEMMY_GUARDRAIL_EXACT_BLOCK;
  delete process.env.CLEMMY_CONFIRM_BEAT;
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

// ── kill gate ────────────────────────────────────────────────────────────────

test('killGateVerdict: null normally; a hard interrupt deny once the kill row exists', () => {
  const sess = freshSession();
  assert.equal(killGateVerdict(sess), null);
  requestKill(sess, 'user stop');
  const verdict = killGateVerdict(sess);
  assert.equal(verdict?.behavior, 'deny');
  assert.equal(verdict?.interrupt, true, 'interrupt:true is the only reliable in-loop stop');
  clearKill(sess);
  assert.equal(killGateVerdict(sess), null);
  assert.equal(killGateVerdict(undefined), null);
});

test('composeKillAwareShouldCancel: ORs the kill switch with the base', async () => {
  const sess = freshSession();
  const base = { value: false };
  const fn = composeKillAwareShouldCancel(sess, () => base.value);
  assert.equal(await fn(), false);
  requestKill(sess, 'stop');
  assert.equal(await fn(), true, 'kill row cancels');
  clearKill(sess);
  assert.equal(await fn(), false);
  base.value = true;
  assert.equal(await fn(), true, 'base caller-cancel still works');
});

test('kill readers stay bound to their physical attempt after a newer turn becomes active', async () => {
  const sess = freshSession();
  const first = beginRunAttempt(sess, { runId: 'turn-a' });
  const firstInput = recordRunAttemptUserInput(first, {
    turn: 1, role: 'user', data: { text: 'first turn' },
  });
  const second = beginRunAttempt(sess, { runId: 'turn-b' });
  const secondInput = recordRunAttemptUserInput(second, {
    turn: 2, role: 'user', data: { text: 'second turn' },
  });
  requestKill(sess, 'stop only A', first);

  assert.equal(killGateVerdict(sess, { sourceUserSeq: firstInput.seq })?.behavior, 'deny');
  assert.equal(killGateVerdict(sess, { sourceUserSeq: secondInput.seq }), null);
  assert.equal(await composeKillAwareShouldCancel(
    sess,
    undefined,
    { sourceUserSeq: firstInput.seq },
  )(), true);
  assert.equal(await composeKillAwareShouldCancel(
    sess,
    undefined,
    { sourceUserSeq: secondInput.seq },
  )(), false);
  clearKill(sess, first);
});

// ── grind gate (the incident: 15 ignored advisories) ────────────────────────

test('grindGateVerdict: a mutating tool ground across DISTINCT args HALTS at the threshold (never 15 ignored advisories)', () => {
  process.env.CLEMMY_GUARDRAIL_MUT_WARN = '2';
  process.env.CLEMMY_GUARDRAIL_MUT_HALT = '4';
  const sess = freshSession();
  // Production-shaped native MCP sends bypass the local wrapper, so this host
  // gate must classify and stop them directly.
  const tool = 'outlook__send_mail';
  let firstDeny: number | null = null;
  let denyMessage = '';
  for (let i = 1; i <= 12; i++) {
    const v = grindGateVerdict(sess, tool, { to: `firm${i}@example.com`, subject: `Follow-up ${i}`, body: 'Hello' });
    if (v && firstDeny === null) { firstDeny = i; denyMessage = v.message; break; }
  }
  assert.ok(firstDeny !== null && firstDeny <= 5, `the halt must actually deny at the threshold (first deny at ${firstDeny})`);
  assert.match(denyMessage, /run_worker|fan out|batch|program/i, 'the deny steers to the structural alternative');
});

test('grindGateVerdict: benign read/build/test/render shell work never enters the dangerous-write halt', () => {
  process.env.CLEMMY_GUARDRAIL_MUT_HALT = '4';
  const sess = freshSession();
  const commands = [
    'rg TODO src',
    'npm test -- --runInBand',
    'npm run build',
    'npx tsc --noEmit',
    'ffmpeg -i input.mov -vf scale=1280:-2 output.mp4',
    'git status --short',
    'node scripts/render-preview.mjs',
    'ls -la dist',
  ];
  for (const command of commands) {
    assert.equal(grindGateVerdict(sess, 'run_shell_command', { command }), null, command);
  }
});

test('grindGateVerdict: an IDENTICAL-args mutating loop reaches the terminal escalate', () => {
  process.env.CLEMMY_GUARDRAIL_EXACT_BLOCK = '3';
  const sess = freshSession();
  let sawTerminal = false;
  for (let i = 1; i <= 15; i++) {
    const v = grindGateVerdict(sess, 'run_shell_command', { command: 'netlify deploy --prod' });
    if (v?.interrupt) { sawTerminal = true; break; }
  }
  assert.ok(sawTerminal, 'identical mutating repeats end the turn (escalate)');
});

test('grindGateVerdict: a fanout refuse fires only for honorFanout callers, silently allows otherwise', () => {
  const sess = freshSession();
  // Distinct-args read grinding trips the fanout block (entity-gated ≥6 distinct).
  let fanout: ReturnType<typeof grindGateVerdict> = null;
  for (let i = 1; i <= 12; i++) {
    const v = grindGateVerdict(sess, 'dataforseo__serp_organic_live_advanced', { keyword: `firm ${i} san antonio`, url: `https://firm${i}.com` }, { honorFanout: true });
    if (v?.fanout) { fanout = v; break; }
  }
  if (fanout) {
    assert.equal(fanout.interrupt, false, 'fanout steer is a soft deny the model reads');
    assert.match(fanout.message, /REFUSED|one-at-a-time|program/i);
  }
  // A caller WITHOUT run_tool_program (worker/step) gets a silent allow — no
  // deny and no phantom guardrail_tripped event (review wf_2ed83f94 #6).
  const sess2 = freshSession();
  for (let i = 1; i <= 12; i++) {
    const v = grindGateVerdict(sess2, 'dataforseo__serp_organic_live_advanced', { keyword: `firm ${i} austin`, url: `https://tx${i}.com` });
    assert.ok(!v?.fanout, 'un-honored fanout verdicts never surface');
  }
});

test('grindGateVerdict: normal varied usage is untouched', () => {
  const sess = freshSession();
  assert.equal(grindGateVerdict(sess, 'notion__search', { q: 'alpha' }), null);
  assert.equal(grindGateVerdict(sess, 'linear__list_issues', { team: 'eng' }), null);
});

// ── boundary verdict ─────────────────────────────────────────────────────────

test('evaluateTurnBoundary precedence: kill → wall-clock → token budget → max-steps', () => {
  const sess = freshSession();
  const base = { sessionId: sess, startedAt: Date.now(), maxWallMs: 0, stepIndex: 1, maxSteps: 100, tokenWindow: null };
  assert.equal(evaluateTurnBoundary(base).kind, 'continue');

  requestKill(sess, 'x');
  assert.equal(evaluateTurnBoundary(base).kind, 'killed');
  clearKill(sess);

  const wallHit = evaluateTurnBoundary({ ...base, startedAt: Date.now() - 10_000, maxWallMs: 5_000 });
  assert.deepEqual({ kind: wallHit.kind, limit: (wallHit as { limit?: string }).limit }, { kind: 'limit', limit: 'wall_clock' });

  const window = openRunTokenWindow({ sessionId: sess, ceiling: 1_000 });
  accrueSessionTokens(sess, 2_000);
  const both = evaluateTurnBoundary({ ...base, startedAt: Date.now() - 10_000, maxWallMs: 5_000, tokenWindow: window });
  assert.equal((both as { limit?: string }).limit, 'wall_clock', 'wall-clock wins a dual breach (loop precedence)');
  const budgetOnly = evaluateTurnBoundary({ ...base, tokenWindow: window });
  assert.equal((budgetOnly as { limit?: string }).limit, 'token_budget');

  const steps = evaluateTurnBoundary({ ...base, stepIndex: 100 });
  assert.equal((steps as { limit?: string }).limit, 'max_steps');
});

// ── background offer (policy: default ON) ────────────────────────────────────

// ── confirm beat (the shovel policy) ─────────────────────────────────────────

test('confirm beat: fires for a FRESH chat execution-shaped request only', () => {
  const chat = freshSession('chat');
  const msg = 'send outreach emails to the 20 firms on my prospect list';
  assert.ok(confirmBeatDirective({ message: msg, sessionId: chat, sessionKind: 'chat' }), 'fresh + execution-shaped → beat');
  // multi-item without an external-write verb still counts as execution-shaped
  const chat2 = freshSession('chat');
  assert.ok(
    confirmBeatDirective({ message: 'research these 8 companies and rank their weaknesses in detail', sessionId: chat2, sessionKind: 'chat', isMultiItem: true, itemCount: 8 }),
    'multi-item shape → beat',
  );
  const incident = freshSession('chat');
  assert.ok(
    confirmBeatDirective({
      message: 'I need you to try to create something for me. Pull some data from ChatGPT and then create me a Google Doc about a firm.',
      sessionId: incident,
      sessionKind: 'chat',
    }),
    'the incident phrasing gets one alignment beat before any tool calls',
  );
  const natural = freshSession('chat');
  assert.ok(
    confirmBeatDirective({
      message: 'I would like for you to help me create a Google Doc with the firm research.',
      sessionId: natural,
      sessionKind: 'chat',
    }),
    'natural assist phrasing is still an explicit requested action',
  );
  const writeDoc = freshSession('chat');
  assert.ok(
    confirmBeatDirective({ message: 'Please write a Google Doc summarizing the firm research.', sessionId: writeDoc, sessionKind: 'chat' }),
    'artifact verbs beyond create still align before external document authoring',
  );
  const shortSend = freshSession('chat');
  assert.ok(
    confirmBeatDirective({ message: 'Send this email.', sessionId: shortSend, sessionKind: 'chat' }),
    'a short consequential request is not exempted by an arbitrary character minimum',
  );
  const transformDoc = freshSession('chat');
  assert.equal(
    classifyTurnPreflight({
      message: 'Turn this research into a Google Doc for the client.',
      sessionId: transformDoc,
      sessionKind: 'chat',
    }).phase,
    'align',
    'transform-shaped requests are not limited to a create keyword',
  );
  const nounRequest = freshSession('chat');
  assert.equal(
    classifyTurnPreflight({
      message: 'A Google Doc with pictures would be great for this firm.',
      sessionId: nounRequest,
      sessionKind: 'chat',
    }).phase,
    'align',
    'noun-shaped artifact requests receive a typed alignment decision',
  );
});

test('confirm beat: old completions never grant permanent alignment; reads and non-chat lanes remain immediate', () => {
  const continued = freshSession('chat');
  appendEvent({ sessionId: continued, turn: 1, role: 'Clem', type: 'conversation_completed', data: { reason: 'success' } });
  const msg = 'send outreach emails to the 20 firms on my prospect list';
  assert.ok(confirmBeatDirective({ message: msg, sessionId: continued, sessionKind: 'chat' }), 'an old completion cannot authorize a new consequential request');
  const chat = freshSession('chat');
  assert.equal(confirmBeatDirective({ message: 'what emails did I send to acme corp yesterday?', sessionId: chat, sessionKind: 'chat' }), null, 'pure question → no beat');
  assert.equal(confirmBeatDirective({ message: 'what should I send to the client after our meeting?', sessionId: chat, sessionKind: 'chat' }), null, 'action word in an informational question → no beat');
  assert.equal(confirmBeatDirective({ message: 'can Google Docs create formatted tables in a document?', sessionId: chat, sessionKind: 'chat' }), null, 'capability question about an external app → no beat');
  assert.equal(confirmBeatDirective({ message: 'I sent the email yesterday and need a summary of the reply.', sessionId: chat, sessionKind: 'chat' }), null, 'past action plus read-only need → no beat');
  assert.equal(confirmBeatDirective({ message: 'go ahead and send the emails we discussed to everyone', sessionId: chat, sessionKind: 'chat' }), null, 'control lead-in → no beat');
  assert.equal(confirmBeatDirective({ message: 'summarize the quarterly report for me please today', sessionId: chat, sessionKind: 'chat' }), null, 'read-only shape → no beat');
  // Review wf_2ed83f94 #10: service NOUNS and read-lead openers never confirm.
  assert.equal(confirmBeatDirective({ message: 'check my email and tell me if the accountant replied about the invoice', sessionId: chat, sessionKind: 'chat' }), null, 'read-lead + bare noun → no beat');
  assert.equal(confirmBeatDirective({ message: 'look at the github repo and summarize the recent commits', sessionId: chat, sessionKind: 'chat' }), null, 'read-lead over write-ish nouns → no beat');
  assert.equal(confirmBeatDirective({ message: msg, sessionId: freshSession('execution'), sessionKind: 'execution' }), null, 'non-chat → no beat');
  process.env.CLEMMY_CONFIRM_BEAT = 'off';
  assert.equal(confirmBeatDirective({ message: msg, sessionId: freshSession('chat'), sessionKind: 'chat' }), null, 'kill-switch respected');
});

test('typed preflight is durable and blocks tools only until the next user go-ahead', () => {
  const sessionId = freshSession('chat');
  appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Turn this into a Google Doc.' } });
  const align = classifyTurnPreflight({
    message: 'Turn this into a Google Doc.',
    sessionId,
    sessionKind: 'chat',
  });
  assert.equal(align.phase, 'align');
  recordTurnPreflightDecision(sessionId, align);
  assert.equal(preflightGateVerdict(sessionId)?.behavior, 'deny', 'prompt advice has a tool-boundary backstop');

  appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Go ahead.' } });
  const execute = classifyTurnPreflight({ message: 'Go ahead.', sessionId, sessionKind: 'chat' });
  assert.equal(execute.phase, 'execute');
  assert.equal(execute.confirmedIntentKey, align.intentKey, 'approval binds to the exact pending request');
  recordTurnPreflightDecision(sessionId, execute);
  assert.equal(preflightGateVerdict(sessionId), null, 'the next user turn clears alignment without a mutable latch');
});

test('typed preflight write failure throws before dispatch and keeps mutations fail-closed', () => {
  const sessionId = freshSession('chat');
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create a Google Doc for the client.' },
  });
  const align = classifyTurnPreflight({
    message: 'Create a Google Doc for the client.',
    sessionId,
    sessionKind: 'chat',
    sourceUserSeq: source.seq,
  });
  assert.equal(align.phase, 'align');

  assert.throws(
    () => recordTurnPreflightDecision(sessionId, align, source.seq, {
      list: listEvents,
      append: () => { throw new Error('simulated sqlite write failure'); },
    }),
    (error: unknown) => error instanceof TurnPreflightPersistenceError
      && /simulated sqlite write failure/.test(error.message),
  );
  assert.equal(listEvents(sessionId, { types: ['turn_preflight_decision'] }).length, 0);
  assert.match(
    preflightGateVerdict(
      sessionId,
      'mcp__google-docs__GOOGLEDOCS_CREATE_DOCUMENT',
      { title: 'Client' },
      source.seq,
    )?.message ?? '',
    /could not persist.*blocked fail-closed/i,
  );
  assert.equal(
    preflightGateVerdict(
      sessionId,
      'mcp__google-docs__GOOGLEDOCS_GET_DOCUMENT',
      { document_id: 'doc_1' },
      source.seq,
    ),
    null,
    'a storage failure blocks mutation, not useful read-only recovery',
  );

  // Recovery is explicit: once the exact decision persists, the transient latch
  // clears and the normal durable alignment verdict becomes authoritative.
  recordTurnPreflightDecision(sessionId, align, source.seq);
  assert.match(
    preflightGateVerdict(
      sessionId,
      'mcp__google-docs__GOOGLEDOCS_CREATE_DOCUMENT',
      { title: 'Client' },
      source.seq,
    )?.message ?? '',
    /Alignment is still pending/i,
  );
});

test('a later turn persistence success cannot clear an earlier turn failure latch', () => {
  const sessionId = freshSession('chat');
  const sourceA = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create a Google Doc for Acme.' },
  });
  const alignA = classifyTurnPreflight({
    message: 'Create a Google Doc for Acme.',
    sessionId,
    sessionKind: 'chat',
    sourceUserSeq: sourceA.seq,
  });
  assert.throws(
    () => recordTurnPreflightDecision(sessionId, alignA, sourceA.seq, {
      list: listEvents,
      append: () => { throw new Error('simulated turn A write failure'); },
    }),
    TurnPreflightPersistenceError,
  );

  const sourceB = appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create a Google Doc for Beta.' },
  });
  const alignB = classifyTurnPreflight({
    message: 'Create a Google Doc for Beta.',
    sessionId,
    sessionKind: 'chat',
    sourceUserSeq: sourceB.seq,
  });
  recordTurnPreflightDecision(sessionId, alignB, sourceB.seq);

  assert.match(
    preflightGateVerdict(
      sessionId,
      'mcp__google-docs__GOOGLEDOCS_CREATE_DOCUMENT',
      { title: 'Acme' },
      sourceA.seq,
    )?.message ?? '',
    /could not persist.*blocked fail-closed/i,
    'turn B persistence must not release a delayed mutation from failed turn A',
  );
  assert.match(
    preflightGateVerdict(
      sessionId,
      'mcp__google-docs__GOOGLEDOCS_CREATE_DOCUMENT',
      { title: 'Beta' },
      sourceB.seq,
    )?.message ?? '',
    /Alignment is still pending/i,
    'turn B uses its own durable decision rather than inheriting turn A failure',
  );
  assert.match(
    preflightGateVerdict(
      sessionId,
      'mcp__google-docs__GOOGLEDOCS_CREATE_DOCUMENT',
      { title: 'Unknown attempt' },
    )?.message ?? '',
    /could not persist.*blocked fail-closed/i,
    'a tool missing exact source identity must match any outstanding session latch',
  );
});

test('an unknown-source persistence failure conservatively latches the session', () => {
  const sessionId = freshSession('chat');
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create a Google Doc.' },
  });
  const align = classifyTurnPreflight({
    message: 'Create a Google Doc.',
    sessionId,
    sessionKind: 'chat',
    sourceUserSeq: source.seq,
  });
  assert.throws(
    () => recordTurnPreflightDecision(sessionId, align, undefined, {
      list: () => { throw new Error('source lookup unavailable'); },
      append: appendEvent,
    }),
    TurnPreflightPersistenceError,
  );
  assert.match(
    preflightGateVerdict(
      sessionId,
      'mcp__google-docs__GOOGLEDOCS_CREATE_DOCUMENT',
      { title: 'Client' },
      source.seq,
    )?.message ?? '',
    /could not persist.*blocked fail-closed/i,
  );
  assert.equal(
    preflightGateVerdict(
      sessionId,
      'mcp__google-docs__GOOGLEDOCS_GET_DOCUMENT',
      { document_id: 'doc_1' },
      source.seq,
    ),
    null,
    'the conservative wildcard still permits recovery reads',
  );
});

test('a richer same-phase preflight decision supersedes a weaker builder record', () => {
  const sessionId = freshSession('chat');
  const source = appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Create a Google Doc.' } });
  const full = classifyTurnPreflight({ message: 'Create a Google Doc.', sessionId, sessionKind: 'chat', sourceUserSeq: source.seq });
  recordTurnPreflightDecision(sessionId, {
    ...full,
    allowedMutationEffects: [],
    allowedDestinations: [],
    allowedActionFamilies: [],
  }, source.seq);
  recordTurnPreflightDecision(sessionId, full, source.seq);
  const decisions = listEvents(sessionId, { types: ['turn_preflight_decision'] });
  assert.equal(decisions.length, 2, 'immutable history keeps both decisions and the latest correction becomes authority');
  assert.deepEqual(decisions.at(-1)?.data.allowedDestinations, full.allowedDestinations);
  const approval = appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'yes' } });
  const execute = classifyTurnPreflight({ message: 'yes', sessionId, sessionKind: 'chat', sourceUserSeq: approval.seq });
  recordTurnPreflightDecision(sessionId, execute, approval.seq);
  assert.equal(
    preflightGateVerdict(sessionId, 'mcp__google-docs__GOOGLEDOCS_CREATE_DOCUMENT', { title: 'Client' }, approval.seq),
    null,
    'the newest corrected authority—not the earlier weak record—controls the tool boundary',
  );
});

test('confirmed intent is source-, action-, effect-, and destination-bound at the tool boundary', () => {
  const sessionId = freshSession('chat');
  const source = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Create a Google Doc for the client.' },
  });
  const align = classifyTurnPreflight({
    message: 'Create a Google Doc for the client.', sessionId, sessionKind: 'chat', sourceUserSeq: source.seq,
  });
  recordTurnPreflightDecision(sessionId, align, source.seq);
  const approval = appendEvent({
    sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Go ahead.' },
  });
  const execute = classifyTurnPreflight({
    message: 'Go ahead.', sessionId, sessionKind: 'chat', sourceUserSeq: approval.seq,
  });
  recordTurnPreflightDecision(sessionId, execute, approval.seq);

  // A newer ambient input cannot steal authority from this exact attempt.
  appendEvent({ sessionId, turn: 3, role: 'user', type: 'user_input_received', data: { text: 'Actually, unrelated question.' } });
  assert.equal(
    effectiveTurnObjective(sessionId, 'Go ahead.', approval.seq),
    'Create a Google Doc for the client.',
    'the low-information control turn preserves the original objective',
  );
  assert.equal(
    preflightGateVerdict(
      sessionId,
      'mcp__google-docs__GOOGLEDOCS_CREATE_DOCUMENT',
      { title: 'Client brief' },
      approval.seq,
    ),
    null,
    'the exact approved create on the aligned provider is allowed',
  );
  assert.match(
    preflightGateVerdict(
      sessionId,
      'mcp__google-docs__GOOGLEDOCS_DELETE_DOCUMENT',
      { document_id: 'doc_123' },
      approval.seq,
    )?.message ?? '',
    /would delete.*authorized create/i,
    'same destination does not widen create consent into delete consent',
  );
  assert.match(
    preflightGateVerdict(
      sessionId,
      'mcp__outlook__OUTLOOK_SEND_EMAIL',
      { to: 'client@example.com' },
      approval.seq,
    )?.message ?? '',
    /did not authorize|targets email/i,
    'same broad external-write effect cannot switch destinations',
  );
  assert.match(
    preflightGateVerdict(sessionId, 'mcp__mystery__DO_THING', {}, approval.seq)?.message ?? '',
    /no trustworthy runtime effect classification/i,
    'unknown native tools cannot escape mutation authority',
  );
  assert.equal(
    preflightGateVerdict(
      sessionId,
      'mcp__google-docs__GOOGLEDOCS_GET_DOCUMENT',
      { document_id: 'doc_123' },
      approval.seq,
    ),
    null,
    'supporting reads remain available after confirmation',
  );
  assert.equal(
    preflightGateVerdict(sessionId, 'ToolSearch', { query: 'Google Docs create' }, approval.seq),
    null,
    'deferred tool discovery remains available after confirmation',
  );
  assert.equal(
    preflightGateVerdict(sessionId, 'run_tool_program', { program: 'return clem.tool_search({ query: "Google Docs" })' }, approval.seq),
    null,
    'Clementine execution carriers are allowed because each concrete inner call re-enters the gate',
  );
  assert.match(
    preflightGateVerdict(sessionId, 'mcp__untrusted__RUN_BATCH', {}, approval.seq)?.message ?? '',
    /no trustworthy runtime effect classification/i,
    'an external provider cannot borrow the local run_batch carrier exemption',
  );
});

test('draft consent never widens into send consent, while an explicit email verb still authorizes send', () => {
  const sessionId = freshSession('chat');
  const source = appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Draft an email in Outlook.' } });
  const align = classifyTurnPreflight({ message: 'Draft an email in Outlook.', sessionId, sessionKind: 'chat', sourceUserSeq: source.seq });
  recordTurnPreflightDecision(sessionId, align, source.seq);
  const approval = appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'yes' } });
  const execute = classifyTurnPreflight({ message: 'yes', sessionId, sessionKind: 'chat', sourceUserSeq: approval.seq });
  recordTurnPreflightDecision(sessionId, execute, approval.seq);
  assert.equal(
    preflightGateVerdict(sessionId, 'mcp__outlook__OUTLOOK_CREATE_DRAFT', { subject: 'Hello' }, approval.seq),
    null,
  );
  assert.match(
    preflightGateVerdict(sessionId, 'mcp__outlook__OUTLOOK_SEND_EMAIL', { to: 'bob@example.com' }, approval.seq)?.message ?? '',
    /would send.*authorized create/i,
  );

  const sendSession = freshSession('chat');
  const sendDecision = classifyTurnPreflight({
    message: 'Email Bob the approved update.', sessionId: sendSession, sessionKind: 'chat',
  });
  assert.equal(sendDecision.phase, 'align');
  assert.ok(sendDecision.allowedActionFamilies?.includes('send'));
});

test('provider-generic consequential intent aligns and binds an Airtable create without a closed service list', () => {
  const sessionId = freshSession('chat');
  const source = appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Create an Airtable record for Acme.' } });
  const align = classifyTurnPreflight({ message: 'Create an Airtable record for Acme.', sessionId, sessionKind: 'chat', sourceUserSeq: source.seq });
  assert.equal(align.phase, 'align');
  assert.ok(align.allowedDestinations?.includes('provider:airtable'));
  recordTurnPreflightDecision(sessionId, align, source.seq);
  const approval = appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'go ahead' } });
  const execute = classifyTurnPreflight({ message: 'go ahead', sessionId, sessionKind: 'chat', sourceUserSeq: approval.seq });
  recordTurnPreflightDecision(sessionId, execute, approval.seq);
  assert.equal(
    preflightGateVerdict(sessionId, 'mcp__airtable__AIRTABLE_CREATE_RECORD', { fields: { Name: 'Acme' } }, approval.seq),
    null,
  );
  assert.match(
    preflightGateVerdict(sessionId, 'mcp__airtable__AIRTABLE_DELETE_RECORD', { record_id: 'rec1' }, approval.seq)?.message ?? '',
    /would delete.*authorized create/i,
  );
});

test('a stale alignment cannot be approved after an unrelated intervening input', () => {
  const sessionId = freshSession('chat');
  appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Send this email.' } });
  const align = classifyTurnPreflight({ message: 'Send this email.', sessionId, sessionKind: 'chat' });
  recordTurnPreflightDecision(sessionId, align);
  appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'What time is it?' } });
  const read = classifyTurnPreflight({ message: 'What time is it?', sessionId, sessionKind: 'chat' });
  recordTurnPreflightDecision(sessionId, read);
  appendEvent({ sessionId, turn: 3, role: 'user', type: 'user_input_received', data: { text: 'yes' } });
  const staleYes = classifyTurnPreflight({ message: 'yes', sessionId, sessionKind: 'chat' });
  assert.equal(staleYes.reason, 'ordinary_execution');
  assert.equal(staleYes.confirmedIntentKey, undefined);
});

test('background offer: default ON; triggers on tool count OR elapsed; one-shot; chat-only', () => {
  assert.equal(backgroundOfferEnabled(), true, 'graduated to default ON per the 2026-07-16 policy');
  const chat = freshSession('chat');
  const base = { sessionId: chat, toolCalls: 0, elapsedMs: 0, alreadyNudged: false };
  assert.equal(shouldOfferBackground(base), false, 'quick turns are never nudged');
  assert.equal(shouldOfferBackground({ ...base, toolCalls: 6 }), true, 'tool-count trigger');
  assert.equal(shouldOfferBackground({ ...base, elapsedMs: 91_000 }), true, 'elapsed trigger');
  assert.equal(shouldOfferBackground({ ...base, toolCalls: 6, alreadyNudged: true }), false, 'one-shot');
  assert.equal(shouldOfferBackground({ ...base, toolCalls: 6, suppressed: true }), false);
  const exec = freshSession('execution');
  assert.equal(shouldOfferBackground({ ...base, sessionId: exec, toolCalls: 20 }), false, 'non-chat sessions never nudge');
  assert.equal(shouldOfferBackground({ ...base, sessionId: 'background:bg-1', toolCalls: 20 }), false);
  process.env.CLEMMY_BG_OFFER_NUDGE = 'off';
  assert.equal(shouldOfferBackground({ ...base, toolCalls: 20 }), false, 'kill-switch respected');
});
