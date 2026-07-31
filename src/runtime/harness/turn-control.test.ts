/**
 * Run: npx tsx --test src/runtime/harness/turn-control.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-turn-control-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, afterEach, beforeEach } from 'node:test';
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
  closeTheLoopNudge,
  confirmBeatDirective,
  confirmBeatEnabled,
  setProvenStandardLineForTest,
  effectiveTurnObjective,
  recordTurnPreflightDecision,
} = await import('./turn-control.js');
const { appendEvent } = await import('./eventlog.js');

let seq = 0;
function freshSession(kind = 'chat'): string {
  seq += 1;
  const id = `turn-control-test-${Date.now().toString(36)}-${seq}`;
  createSession({ id, kind } as never);
  return id;
}

beforeEach(() => {
  // Most tests below exercise the alignment mechanism directly. The production
  // default is asserted separately (it is now ON).
  process.env.CLEMMY_CONFIRM_BEAT = 'on';
});

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

// ── background offer (legacy opt-in) ─────────────────────────────────────────

// ── confirm beat (legacy opt-in) ─────────────────────────────────────────────

test('the kill-switch still silences an explicit action request', () => {
  // Contract INVERTED 2026-07-31: the beat is on by default (it shipped
  // default-off and therefore never fired in production). `off` remains the
  // operator escape hatch.
  const sessionId = freshSession('chat');
  const message = 'Deploy this prepared directory to the exact Netlify site I named, then verify it.';
  process.env.CLEMMY_CONFIRM_BEAT = 'off';
  assert.equal(confirmBeatDirective({ message, sessionId, sessionKind: 'chat' }), null);
  assert.equal(classifyTurnPreflight({ message, sessionId, sessionKind: 'chat' }).phase, 'execute');
  process.env.CLEMMY_CONFIRM_BEAT = 'on';
  assert.ok(confirmBeatDirective({ message, sessionId, sessionKind: 'chat' }), 'the beat is available by default');
});

test('confirm beat: fires for a FRESH chat execution-shaped request only', () => {
  const chat = freshSession('chat');
  const msg = 'send outreach emails to the 20 firms on my prospect list';
  assert.ok(confirmBeatDirective({ message: msg, sessionId: chat, sessionKind: 'chat' }), 'fresh + execution-shaped → beat');
  // Item count alone is parallelism guidance, not a reason to interrupt a
  // fully specified read-only task with another confirmation round trip.
  const chat2 = freshSession('chat');
  assert.equal(
    confirmBeatDirective({ message: 'research these 8 companies and rank their weaknesses in detail', sessionId: chat2, sessionKind: 'chat', isMultiItem: true, itemCount: 8 }),
    null,
    'read-only multi-item work starts immediately',
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

test('preflight ignores negated destinations and never invents providers from scope grammar', () => {
  const sessionId = freshSession('chat');
  const decision = classifyTurnPreflight({
    message: 'In exactly one run_worker call, compute 10 squares using no external tools. Do not write files or deploy to Netlify.',
    sessionId,
    sessionKind: 'chat',
    isMultiItem: true,
    itemCount: 10,
  });
  assert.equal(decision.phase, 'execute');
  assert.equal(decision.consequential, false);
  assert.equal(decision.destination, undefined);
  assert.deepEqual(decision.allowedDestinations, undefined);
});

test('preflight reports a concrete validation blocker before aligning a conditional external write', () => {
  const sessionId = freshSession('chat');
  const message = 'Create a disposable Google Sheet with columns company and email using these rows: Acme — acme@example.com; Beacon — email missing; Cedar — cedar@example.com. Do not create or write any spreadsheet unless every row has a non-empty email. If anything is missing, identify the row and stop.';
  const decision = classifyTurnPreflight({
    message,
    sessionId,
    sessionKind: 'chat',
    isMultiItem: true,
    itemCount: 3,
  });
  assert.equal(decision.phase, 'read');
  assert.equal(decision.reason, 'validation_blocked');
  assert.equal(decision.consequential, false);
  assert.ok(!decision.allowedActionFamilies?.includes('send'));
  assert.ok(!decision.allowedDestinations?.includes('provider:these'));

  const complete = classifyTurnPreflight({
    message: 'Create a disposable Google Sheet with columns company and email using these rows: Acme — acme@example.com; Beacon — beacon@example.com. Do not create or write it unless every row has a non-empty email.',
    sessionId: freshSession('chat'),
    sessionKind: 'chat',
    isMultiItem: true,
    itemCount: 2,
  });
  assert.equal(complete.phase, 'align', 'a defensive validation rule alone is not a concrete blocker');
  assert.ok(!complete.allowedActionFamilies?.includes('send'), 'an email column is data, not send authority');
  assert.ok(!complete.allowedDestinations?.includes('provider:these'));
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

// (fold 2026-07-17) The fail-closed preflightGateVerdict tool gate was DEMOTED
// after review wf_30a7ce7e-e9c — bypassable AND falsely denying. The typed
// decision remains as directive trigger + telemetry + objective anchoring;
// these tests pin the surviving classification/persistence semantics.

test('typed preflight is durable; approval binds to the exact pending request', () => {
  const sessionId = freshSession('chat');
  appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Turn this into a Google Doc.' } });
  const align = classifyTurnPreflight({
    message: 'Turn this into a Google Doc.',
    sessionId,
    sessionKind: 'chat',
  });
  assert.equal(align.phase, 'align');
  recordTurnPreflightDecision(sessionId, align);
  assert.equal(listEvents(sessionId, { types: ['turn_preflight_decision'] }).length, 1, 'the align decision is durable');

  appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Go ahead.' } });
  const execute = classifyTurnPreflight({ message: 'Go ahead.', sessionId, sessionKind: 'chat' });
  assert.equal(execute.phase, 'execute');
  assert.equal(execute.confirmedIntentKey, align.intentKey, 'approval binds to the exact pending request');
});

test('preflight persistence is best-effort telemetry — a failed write never throws or breaks the turn', () => {
  const sessionId = freshSession('chat');
  const source = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Create a Google Doc for the client.' },
  });
  const align = classifyTurnPreflight({
    message: 'Create a Google Doc for the client.',
    sessionId,
    sessionKind: 'chat',
    sourceUserSeq: source.seq,
  });
  assert.equal(align.phase, 'align');
  assert.doesNotThrow(() => recordTurnPreflightDecision(sessionId, align, source.seq, {
    list: listEvents,
    append: () => { throw new Error('simulated sqlite write failure'); },
  }), 'demoted semantics: the decision is directive/telemetry, not execution authority');
  assert.equal(listEvents(sessionId, { types: ['turn_preflight_decision'] }).length, 0);
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
});

test('the aligned objective anchors acknowledgement turns (effectiveTurnObjective)', () => {
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
});

test('classification: an explicit email verb authorizes send; a draft ask does not', () => {
  const draftSession = freshSession('chat');
  const draftDecision = classifyTurnPreflight({
    message: 'Draft an email in Outlook.', sessionId: draftSession, sessionKind: 'chat',
  });
  assert.equal(draftDecision.phase, 'align');
  assert.ok(!draftDecision.allowedActionFamilies?.includes('send'), 'draft consent never widens into send consent');
  const sendSession = freshSession('chat');
  const sendDecision = classifyTurnPreflight({
    message: 'Email Bob the approved update.', sessionId: sendSession, sessionKind: 'chat',
  });
  assert.equal(sendDecision.phase, 'align');
  assert.ok(sendDecision.allowedActionFamilies?.includes('send'));
});

test('provider-generic consequential intent aligns without a closed service list', () => {
  const sessionId = freshSession('chat');
  appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Create an Airtable record for Acme.' } });
  const align = classifyTurnPreflight({ message: 'Create an Airtable record for Acme.', sessionId, sessionKind: 'chat' });
  assert.equal(align.phase, 'align');
  assert.ok(align.allowedDestinations?.includes('provider:airtable'));
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

test('background offer: default OFF; opt-in triggers on tool count OR elapsed; one-shot; chat-only', () => {
  delete process.env.CLEMMY_BG_OFFER_NUDGE;
  assert.equal(backgroundOfferEnabled(), false);
  const chat = freshSession('chat');
  const base = { sessionId: chat, toolCalls: 0, elapsedMs: 0, alreadyNudged: false };
  assert.equal(shouldOfferBackground(base), false, 'quick turns are never nudged');
  assert.equal(shouldOfferBackground({ ...base, toolCalls: 20 }), false, 'normal operation never injects an ask-and-stop gate');
  process.env.CLEMMY_BG_OFFER_NUDGE = 'on';
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

test('closeTheLoopNudge: a recommendation with no question/offer nudges; closed or offered replies never do (live 2026-07-30 Apify miss)', () => {
  // The live miss: a great comparison answer ending on "Best setup: X for A; Y
  // for B." with the decision left on the table.
  const stranded = [
    'Apify is the better bulk route. Best setup: Apify for external visibility; Composio for benchmark prompts across your accounts.',
    'I would recommend the sf CLI here since your org already authenticates it locally.',
    'The better approach is a nightly scheduled pull into the workspace.',
  ];
  for (const reply of stranded) {
    const nudge = closeTheLoopNudge(reply);
    assert.ok(nudge, `must nudge: ${reply.slice(0, 50)}`);
    assert.match(nudge!, /own words/i, 'phrasing stays model-owned');
  }

  // Closing question present → the loop is closed; never nudge.
  assert.equal(closeTheLoopNudge('Best setup: Apify for visibility. Want me to set that up?'), null);
  // An explicit offer counts even without a question mark.
  assert.equal(closeTheLoopNudge('I recommend the Apify route — say the word and I will build the workspace.'), null);
  assert.equal(closeTheLoopNudge('My recommendation is Apify. Happy to set it up on a nightly schedule — let me know which accounts.'), null);
  // Plain answers with no recommendation shape never nudge (this is a nudge for
  // stranded DECISIONS, not a tax on every reply).
  assert.equal(closeTheLoopNudge('Brett sent 14 prospecting emails today; here are the five most recent.'), null);
  assert.equal(closeTheLoopNudge(''), null);
  assert.equal(closeTheLoopNudge(null), null);
});

test('the beat is ON by default — it shipped disabled and therefore never once fired (2026-07-31)', () => {
  const prior = process.env.CLEMMY_CONFIRM_BEAT;
  delete process.env.CLEMMY_CONFIRM_BEAT;
  try {
    assert.equal(confirmBeatEnabled(), true, 'validated behavior is the default, not a rollout flag');
    process.env.CLEMMY_CONFIRM_BEAT = 'off';
    assert.equal(confirmBeatEnabled(), false, 'off survives as an operator kill-switch');
  } finally {
    if (prior === undefined) delete process.env.CLEMMY_CONFIRM_BEAT; else process.env.CLEMMY_CONFIRM_BEAT = prior;
  }
});

test('a request stated AFTER its context, in plural voice, still earns alignment', () => {
  const sess = { id: freshSession() };
  // The owner's live message: context first, ask last, "we/lets" voice, and a
  // polite trailing "?" — it classified as a READ and skipped the beat entirely.
  const decision = classifyTurnPreflight({
    message: 'Okay, remember we need to touch all accounts always, so these 266 we need to get a mid year audit email ready for them in my drafts, lets get at least 50 of them ready right now please?',
    sessionId: sess.id,
    sessionKind: 'chat',
  });
  assert.equal(decision.phase, 'align', `context-first plural request must align, got ${decision.phase}/${decision.reason}`);
});

test('pre-authorized work is never interrupted by a beat', () => {
  const sess = { id: freshSession() };
  for (const message of [
    'fully autonomously in the background please: build my outreach sheet and email the top 20',
    'go ahead and send the follow-ups, no need to check with me',
    'just do it — draft and publish the recap to slack',
  ]) {
    const decision = classifyTurnPreflight({ message, sessionId: sess.id, sessionKind: 'chat' });
    assert.equal(decision.phase, 'execute', `pre-authorized message must execute: "${message.slice(0, 40)}"`);
    assert.equal(decision.reason, 'pre_authorized');
  }
});

test('quick reads and chit-chat stay silent', () => {
  const sess = { id: freshSession() };
  for (const message of ['whats on my calendar today', 'Hey', 'hows it going', 'can Google Docs create tables?']) {
    const decision = classifyTurnPreflight({ message, sessionId: sess.id, sessionKind: 'chat' });
    assert.notEqual(decision.phase, 'align', `"${message}" must not earn a beat`);
  }
});

test('the beat names the governing standard when one is proven', () => {
  const sess = { id: freshSession() };
  setProvenStandardLineForTest(() => '[standard] `brand-outbound` governs this kind of work (3 previous runs).');
  try {
    const directive = confirmBeatDirective({
      message: 'draft outbound emails to the top 20 accounts and put them in my drafts',
      sessionId: sess.id,
      sessionKind: 'chat',
    });
    assert.ok(directive, 'a consequential request earns a beat');
    assert.match(directive!, /brand-outbound/, 'the beat names the standard in force');
  } finally {
    setProvenStandardLineForTest(null);
  }
});

test('with no standard, the beat asks the ONE question that defines it', () => {
  const sess = { id: freshSession() };
  setProvenStandardLineForTest(() => '');
  try {
    const directive = confirmBeatDirective({
      message: 'draft outbound emails to the top 20 accounts and put them in my drafts',
      sessionId: sess.id,
      sessionKind: 'chat',
    });
    assert.match(directive!, /No proven standard governs/);
    assert.match(directive!, /remember it so this is never asked again/, 'the answer becomes a standard — the beat self-extinguishes');
  } finally {
    setProvenStandardLineForTest(null);
  }
});
