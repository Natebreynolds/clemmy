/**
 * Run: npx tsx --test src/runtime/harness/turn-decision.test.ts
 *
 * GOLDEN CORPUS for turn-decision classification. Every fixture below is
 * either a documented live incident or a contract the parser must keep:
 *
 *   - sess-mrcg3mtx (2026-07-08): a LONG draft-quoting answer ("Here's one
 *     example: To: lloyd@…") must parse as the completed reply, never be
 *     nulled by the announcement heuristic.
 *   - sess-mrchgvkc (2026-07-08): a draft-present reply to the plain-text
 *     contract directive is FULFILLMENT — deliverable, not a stall.
 *   - Joshua Tree deploy (2026-07-08): a hallucinated tool call rendered as
 *     markdown ("**run_shell_command**" + fence) must stay a punt — the site
 *     was never deployed; that prose must never complete a run.
 *   - bg-mrcg45p1 (2026-07-08): a fake `**Tool: read**` transcript with
 *     missing path text must stay a punt — the meeting analysis was never
 *     written even though the background task was marked done.
 *   - "I'll run the Outlook search now." — a TRUE short punt stays a punt.
 *
 * These pin the classification vocabulary so later refactors can't silently
 * flip a live-fixed shape. The loop-level behavior (retries, banners,
 * salvage) is covered by loop.test.ts; this file covers the pure text
 * classification.
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-turn-decision-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  classifyTurnText,
  evaluateProgress,
  evaluateStructuredDecisionStall,
  toOrchestratorDecision,
  isPlainTextContractDirective,
  requestedVerbatimReply,
  replyFulfillsVerbatimRequest,
} = await import('./turn-decision.js');
const { appendEvent, createSession, resetEventLog } = await import('./eventlog.js');

// ── Live bug 1: sess-mrcg3mtx — long draft-quoting answer must COMPLETE ───────

// The requested email example, quoted verbatim in the reply. Contains
// "checking" and "I'll" — the verbs that tripped the announcement heuristic
// live — but is far past the 300-char announcement bound: a real answer.
const LONG_DRAFT_ANSWER =
  "Here's one example:\n\nTo: lloyd@example.com\nSubject: Lloyd Baker Injury Attorneys and AI search\n\n" +
  'Lloyd, your firm already has the kind of reputation most firms want. The piece worth checking now is ' +
  "whether that reputation carries into AI-driven results when clients ask full legal questions. I'll " +
  'include the full report link so you can see where you show up across Google, local search, and the ' +
  'new AI answers surface.\n\nGood to send?';

test('golden sess-mrcg3mtx: long draft-quoting answer parses as completed, never nulled', () => {
  assert.ok(LONG_DRAFT_ANSWER.length > 300, 'fixture must exceed the announcement bound');
  const d = toOrchestratorDecision(LONG_DRAFT_ANSWER);
  assert.ok(d, 'a substantive reply is never a zero-work punt');
  assert.equal(d!.done, true);
  assert.equal(d!.nextAction, 'completed');
  assert.match(d!.reply ?? '', /lloyd@example\.com/);

  const { kind, decision } = classifyTurnText(LONG_DRAFT_ANSWER, { toolCalls: 0 });
  assert.equal(kind, 'answer');
  assert.match(decision!.reply ?? '', /Good to send\?/);
});

// ── Live bug 2: sess-mrchgvkc — draft-present contract reply is FULFILLMENT ──

// Deliberately inside the 200–300 char window (announcement verbs present) so
// only the contract exemption saves it — exactly the live failure shape.
const PRESENTED_DRAFT =
  'To: lloyd@example.com\nSubject: Quick market visibility question\n\n' +
  'Lloyd, the piece worth checking now is whether your reputation carries into ' +
  "AI-driven results. I'll include the full report link so you can see where " +
  'you show up across Google.\n\nGood to send?';

test('golden sess-mrchgvkc: a zero-tool contract reply classifies as answer (fulfillment)', () => {
  const { kind, decision } = classifyTurnText(PRESENTED_DRAFT, { toolCalls: 0, contractTurn: true });
  assert.equal(kind, 'answer', 'compliance with "do not call a tool — reply now" is never a stall');
  assert.equal(decision!.nextAction, 'completed');
  assert.match(decision!.reply ?? '', /Good to send\?/);
});

test('golden sess-mrchgvkc counterpart: a concrete closing question is preserved without the contract', () => {
  // The question is a conversational deliverable. The loop decides whether it
  // is awaiting input; the announcement detector must not erase it first.
  const { kind, decision } = classifyTurnText(PRESENTED_DRAFT, { toolCalls: 0 });
  assert.equal(kind, 'answer');
  assert.match(decision?.reply ?? '', /Good to send\?/);
});

test('golden live direction question: future-tense recommendation is not erased as a zero-work punt', () => {
  const text =
    'I’ll prioritize by win-back likelihood: recency, engagement history, loss reason, ' +
    'next-step clarity, and deal value as a tiebreaker. ' +
    'Should it refresh daily, or only when you click Refresh?';
  const { kind, decision } = classifyTurnText(text, { toolCalls: 0 });
  assert.equal(kind, 'answer');
  assert.equal(decision?.nextAction, 'completed');
  assert.match(decision?.reply ?? '', /refresh daily/);
});

test('promise-only announcements ending in vague sign-off questions remain punts', () => {
  const promises = [
    "I'll run the Outlook search now. Should I proceed?",
    "I'll run the Outlook search now. Ready?",
    "I'll prepare the draft. Good to send?",
    "I'll do that now. Sound good?",
    "I'll run it now. Should I proceed now or later?",
    "I'll run it now. Should I run it here or in the background?",
    "I'll run the Outlook search now. Should I run the Outlook search now or later?",
  ];
  for (const text of promises) {
    assert.equal(
      toOrchestratorDecision(text),
      null,
      `a vague sign-off must not launder a zero-tool action promise: ${text}`,
    );
    const { kind, decision } = classifyTurnText(text, { toolCalls: 0 });
    assert.equal(kind, 'punt', text);
    assert.equal(decision, null, text);
  }
});

test('structured completed envelope cannot use a trailing permission question to hide a zero-tool promise', () => {
  const text = "I'll run the Outlook search now. Should I proceed?";
  const envelope = {
    summary: text,
    reply: text,
    done: true,
    nextAction: 'completed',
    reason: null,
  };
  const { kind, decision } = classifyTurnText(JSON.stringify(envelope), { toolCalls: 0 });
  assert.equal(kind, 'punt');
  assert.equal(decision?.nextAction, 'completed', 'the envelope parsed, then the stall classifier rejected it');
});

test('contract directive detection keys on the directive text itself', () => {
  assert.equal(
    isPlainTextContractDirective(
      'Your previous send was held … Do NOT call another tool. Reply to the user NOW with the drafted item(s).',
    ),
    true,
  );
  assert.equal(isPlainTextContractDirective('please continue'), false);
  // A short generic ack is NOT compliance even on a contract turn — it still
  // falls through to the stall machinery (mirrors the loop's >60-char guard).
  const ack = classifyTurnText('OK.', { toolCalls: 0, contractTurn: true });
  assert.equal(ack.kind, 'punt');
});

// ── Verbatim-echo request (2026-07-13, F1 runaway source fix) ────────────────
// A directive that explicitly asks for an exact short reply makes that literal the
// deliverable, not a lazy ack. requestedVerbatimReply extracts it; the loop delivers
// the zero-tool reply ONLY when it EQUALS the literal (the equality is the guard).

test('requestedVerbatimReply: extracts the literal from explicit verbatim directives', () => {
  assert.equal(requestedVerbatimReply('Reply with just the word: ok'), 'ok');
  assert.equal(requestedVerbatimReply("respond with only 'yes'"), 'yes');
  assert.equal(requestedVerbatimReply('say exactly: done'), 'done');
  assert.equal(requestedVerbatimReply('just reply "acknowledged"'), 'acknowledged');
  assert.equal(requestedVerbatimReply('answer with the single word GO'), 'GO');
  assert.equal(requestedVerbatimReply('reply with only the phrase "all clear"'), 'all clear');
});

test('requestedVerbatimReply: covers polite/interrogative phrasings of the same class (lead-in is safe)', () => {
  // The reply-verb must IMMEDIATELY follow the trivial lead-in, so these extract...
  assert.equal(requestedVerbatimReply('Can you reply with just the word ok?'), 'ok');
  assert.equal(requestedVerbatimReply('Could you just reply ok'), 'ok');
  assert.equal(requestedVerbatimReply('hey, just say done'), 'done');
  assert.equal(requestedVerbatimReply('Would you reply with the single word GO'), 'GO');
  // ...while an interrogative wrapping an ACTION clause still yields null (no leak).
  assert.equal(requestedVerbatimReply('Can you fix the bug and reply ok'), null);
  assert.equal(requestedVerbatimReply('Would you reconcile the accounts and reply done'), null);
});

// IO verbs are ACTION-ambiguous ("type yes" = type into the prompt you're operating;
// "write done" = a file write), so a BARE token after an IO verb must NOT extract
// (pre-patch review finding). Explicit verbatim intent — quotes or "the word <X>" —
// is required for write|output|return|print|type.
test('requestedVerbatimReply: IO verbs require explicit verbatim intent (bare token = null)', () => {
  assert.equal(requestedVerbatimReply('type yes'), null);
  assert.equal(requestedVerbatimReply('write done'), null);
  assert.equal(requestedVerbatimReply('Can you please just write done'), null);
  assert.equal(requestedVerbatimReply('return ok'), null);
  assert.equal(requestedVerbatimReply('print done'), null);
  // Explicit intent still extracts:
  assert.equal(requestedVerbatimReply('type the word yes'), 'yes');
  assert.equal(requestedVerbatimReply('write "done"'), 'done');
  assert.equal(requestedVerbatimReply('print the word: hello'), 'hello');
});

test('requestedVerbatimReply: returns null for open tasks and non-verbatim phrasings', () => {
  assert.equal(requestedVerbatimReply('Analyze these 50 deals and report back'), null);
  assert.equal(requestedVerbatimReply('reply only when the report is done'), null);
  assert.equal(requestedVerbatimReply('just send the email to bob'), null);
  assert.equal(requestedVerbatimReply('please continue'), null);
  // The harness's own stall steer must never read as a verbatim request.
  assert.equal(
    requestedVerbatimReply('Your previous response was prose, not an action. You MUST call a tool now to make progress — do not emit any text before the tool call.'),
    null,
  );
  // Over-long directives are out of scope (the ask is not a simple short reply).
  assert.equal(requestedVerbatimReply(`reply with the word ok. ${'x'.repeat(260)}`), null);
});

// ANCHORING REGRESSION (adversarial review 2026-07-13): the bindings are ^…$
// whole-directive anchored, so an ACTION clause before a trailing ack no longer
// leaks the ack word out of the tail. Without anchoring these all wrongly extracted
// the trailing token and a zero-tool punt of it was delivered as "done".
test('requestedVerbatimReply: an action clause before a trailing ack yields NO literal (anchoring holds)', () => {
  assert.equal(requestedVerbatimReply('Fix the login bug and just reply ok'), null);
  assert.equal(requestedVerbatimReply('Send the report to finance and then just reply done'), null);
  assert.equal(requestedVerbatimReply('Reconcile the accounts. Only reply yes'), null);
  assert.equal(requestedVerbatimReply('Delete the stale branches and just confirm'), null);
  // Adverb-in-prose must not bind a bare trailing token ("exactly right" ≠ a request).
  assert.equal(requestedVerbatimReply('Fix the bug and verify it works exactly right'), null);
  assert.equal(requestedVerbatimReply('Reconcile the ledgers and get it exactly right.'), null);
  // A full action directive that ENDS in the verbatim ask still yields null (the
  // action clause at the start breaks the ^-anchor) — the task must actually run.
  assert.equal(
    requestedVerbatimReply('Reconcile the July invoices against the bank statement and when finished reply with just the word: done'),
    null,
  );
});

test('replyFulfillsVerbatimRequest: a zero-tool ack on an action-then-ack directive is NOT fulfillment', () => {
  assert.equal(replyFulfillsVerbatimRequest('Fix the login bug and just reply ok', 'ok'), false);
  assert.equal(replyFulfillsVerbatimRequest('Reconcile the ledgers and get it exactly right.', 'Right.'), false);
  assert.equal(
    replyFulfillsVerbatimRequest('Reconcile the July invoices against the bank statement and when finished reply with just the word: done', 'Done.'),
    false,
  );
});

test('replyFulfillsVerbatimRequest: fulfilled only when the reply EQUALS the requested literal', () => {
  // The F1 case: exact match (tolerant of the trailing period the model adds).
  assert.equal(replyFulfillsVerbatimRequest('Reply with just the word: ok', 'ok'), true);
  assert.equal(replyFulfillsVerbatimRequest('Reply with just the word: ok', 'ok.'), true);
  assert.equal(replyFulfillsVerbatimRequest('Reply with just the word: ok', 'OK'), true);
  assert.equal(replyFulfillsVerbatimRequest("respond with only 'yes'", 'Yes.'), true);
  // A lazy ack on an OPEN task is NOT fulfillment — no bound literal equals it.
  assert.equal(replyFulfillsVerbatimRequest('Analyze these 50 deals', 'OK.'), false);
  assert.equal(replyFulfillsVerbatimRequest('reply only when the report is done', 'Done.'), false);
  // Right directive, WRONG reply → not fulfilled (equality guard holds).
  assert.equal(replyFulfillsVerbatimRequest('Reply with just the word: ok', 'sure, done'), false);
});

// ── Live bug 3: Joshua Tree — hallucinated tool transcript stays a PUNT ──────

test('golden Joshua Tree: "**run_shell_command**" + fence is a fake tool transcript, never an answer', () => {
  const fake = '**run_shell_command**\n```\ncd /Users/n/Projects/site && netlify deploy --dir "." --prod\n```';
  assert.equal(toOrchestratorDecision(fake), null, 'fail-open must not launder a fake transcript into a reply');
  const { kind, decision } = classifyTurnText(fake, { toolCalls: 0 });
  assert.equal(kind, 'fake_tool_transcript');
  assert.equal(decision, null);
});

test('golden sess-mrcg3mtx shape 2: lead-in sentence + "**Tool Call: run_shell_command**" transcript is still a punt', () => {
  const fake =
    'Let me find the correct file path.\n\n**Tool Call: run_shell_command**\nStatus: Completed\n\nTerminal:\n' +
    '```\nfind /Users/n/.clementine-next -iname "*market-leader*"\n```';
  assert.equal(toOrchestratorDecision(fake), null, 'a lead-in sentence must not launder a fake transcript');
  const { kind } = classifyTurnText(fake, { toolCalls: 0 });
  assert.equal(kind, 'fake_tool_transcript');
});

test('golden bg-mrcg45p1: "**Tool: read**" missing-argument transcript is a fake tool transcript', () => {
  const fake =
    "**Tool: read**\n\n*(No `path` provided in the assistant's tool call — the harness will supply required params.)*";
  assert.equal(toOrchestratorDecision(fake), null, 'missing-argument tool label must not complete the task');
  const { kind, decision } = classifyTurnText(fake, { toolCalls: 0 });
  assert.equal(kind, 'fake_tool_transcript');
  assert.equal(decision, null);
});

test('an "Options:" heading before a fence is a REAL reply, not a transcript', () => {
  const real = 'Options:\n\n```\nnpm run build\n```\nRun the first one and the site rebuilds.';
  const d = toOrchestratorDecision(real);
  assert.ok(d && d.done === true, 'a plain heading before a fence is a real reply');
  const { kind, decision } = classifyTurnText(real, { toolCalls: 0 });
  assert.equal(kind, 'answer');
  assert.match(decision!.reply ?? '', /npm run build/);
});

// ── Live bug 4: the TRUE punt stays a punt ───────────────────────────────────

test('golden true punt: "I\'ll run the Outlook search now." is a punt, decision null', () => {
  assert.equal(toOrchestratorDecision("I'll run the Outlook search now."), null);
  const { kind, decision } = classifyTurnText("I'll run the Outlook search now.", { toolCalls: 0 });
  assert.equal(kind, 'punt');
  assert.equal(decision, null);
});

test('golden bg-mrbqprgv: self-reported no tool access is a punt, not a completed answer', () => {
  const text =
    'Nothing new - this environment has no tool access (Composio, Google Sheets, DataForSEO, or file I/O are not exposed to me here), so I cannot fetch search volumes, create a Google Sheet, or verify anything.';
  assert.equal(toOrchestratorDecision(text), null);
  const { kind, decision } = classifyTurnText(text, { toolCalls: 0 });
  assert.equal(kind, 'punt');
  assert.equal(decision, null);
});

test('golden workflow-step no-live-tool-access wording is a punt', () => {
  const text =
    'I cannot complete this step - this execution context has no live tool access, so I cannot call workflow_step_result.';
  assert.equal(toOrchestratorDecision(text), null);
  const { kind, decision } = classifyTurnText(text, { toolCalls: 0 });
  assert.equal(kind, 'punt');
  assert.equal(decision, null);
});

test('short generic ack ("Continuing.") is a punt', () => {
  const { kind } = classifyTurnText('Continuing.', { toolCalls: 0 });
  assert.equal(kind, 'punt');
});

// ── Marker contract ──────────────────────────────────────────────────────────

test('ASK: marker → ask, body is the question shown to the user', () => {
  const { kind, decision } = classifyTurnText('ASK: Which calendar should I use — work or personal?', { toolCalls: 0 });
  assert.equal(kind, 'ask');
  assert.equal(decision!.nextAction, 'awaiting_user_input');
  assert.equal(decision!.done, false);
  assert.match(decision!.reply ?? '', /Which calendar/);
});

test('CONTINUE: marker → continue, internal note is never a user reply', () => {
  const { kind, decision } = classifyTurnText('CONTINUE: still paging through the mailbox results', { toolCalls: 2 });
  assert.equal(kind, 'continue');
  assert.equal(decision!.nextAction, 'awaiting_handoff_result');
  assert.equal(decision!.reply, null);
  assert.match(decision!.reason ?? '', /paging through/);
});

// ── JSON envelope back-compat ────────────────────────────────────────────────

test('JSON envelope back-compat: a stringified decision parses identically', () => {
  const envelope = JSON.stringify({
    summary: 'Located the message.',
    reply: 'Found it — the email from Brooke arrived at 9:14am.',
    done: true,
    nextAction: 'completed',
    reason: null,
  });
  const d = toOrchestratorDecision(envelope);
  assert.ok(d);
  assert.equal(d!.nextAction, 'completed');
  assert.match(d!.reply ?? '', /9:14am/);

  const { kind, decision } = classifyTurnText(envelope, { toolCalls: 1 });
  assert.equal(kind, 'answer');
  assert.match(decision!.reply ?? '', /Brooke/);
});

test('JSON envelope: awaiting_user_input maps to ask', () => {
  const envelope = JSON.stringify({
    summary: 'Need a decision from the user.',
    reply: 'Should I send to the full list or just the top 10?',
    done: false,
    nextAction: 'awaiting_user_input',
    reason: 'ambiguous audience',
  });
  const { kind } = classifyTurnText(envelope, { toolCalls: 0 });
  assert.equal(kind, 'ask');
});

// ── Reflection / converse-until-aligned ──────────────────────────────────────

test('a reflective alignment reply ("you\'re right — going forward I\'ll…") is an answer, not a stall', () => {
  const reflection = "you're right — going forward I'll treat SEO rankings as raw metrics and skip the editorializing.";
  const d = toOrchestratorDecision(reflection);
  assert.ok(d && d.done === true, 'reflection suppress guard keeps converse-until-aligned replies deliverable');
  const { kind } = classifyTurnText(reflection, { toolCalls: 0 });
  assert.equal(kind, 'answer');
});

// ── Empty / sentinel ─────────────────────────────────────────────────────────

test('empty string → empty', () => {
  const { kind, decision } = classifyTurnText('', { toolCalls: 0 });
  assert.equal(kind, 'empty');
  assert.equal(decision, null);
  assert.equal(toOrchestratorDecision(''), null);
});

test('the structured-output recovery sentinel → empty (routes to the retry path)', () => {
  const sentinel = "Clementine produced a response that couldn't be structured. Please ask again.";
  const { kind, decision } = classifyTurnText(sentinel, { toolCalls: 0 });
  assert.equal(kind, 'empty');
  assert.equal(decision, null);
});

// ── Long future-tense real answer ────────────────────────────────────────────

test('a >300-char future-tense real answer is an answer (announcement bound honored)', () => {
  const longPlan =
    "Here's the rollout plan you asked for. First I'll freeze the current schema and snapshot the " +
    "production tables so we have a clean restore point. Then I'll run the migration against staging, " +
    'compare row counts, and diff a 1% sample of records field-by-field. If the sample is clean, the same ' +
    'migration runs against production during the Sunday window, with the snapshot as the rollback path. ' +
    'You only need to approve the Sunday window — everything else is reversible.';
  assert.ok(longPlan.length > 300, 'fixture must exceed the announcement bound');
  const { kind, decision } = classifyTurnText(longPlan, { toolCalls: 0 });
  assert.equal(kind, 'answer');
  assert.match(decision!.reply ?? '', /Sunday window/);

  // Evidence variants that also must stay answers: work happened this turn, or
  // the completion reports prior substantive work (2026-06-15 Brooke shape).
  assert.equal(classifyTurnText(longPlan, { toolCalls: 3 }).kind, 'answer');
  assert.equal(classifyTurnText(longPlan, { toolCalls: 0, priorSubstantiveWork: true }).kind, 'answer');
});

// ── Zero-tool false claim via envelope (shape B) still punts ─────────────────

test('a short zero-tool "Sent the email." completion envelope is a punt unless prior work backs it', () => {
  const envelope = JSON.stringify({
    summary: 'Sent the email to the prospect list.',
    reply: 'Sent the email to all 12 prospects.',
    done: true,
    nextAction: 'completed',
    reason: null,
  });
  // No tools this turn, no prior work → the false-claim shape (sess-mper69si).
  assert.equal(classifyTurnText(envelope, { toolCalls: 0 }).kind, 'punt');
  // Same text reporting PRIOR real work is a genuine completion (Brooke shape).
  assert.equal(classifyTurnText(envelope, { toolCalls: 0, priorSubstantiveWork: true }).kind, 'answer');
  // And with tool calls this turn it is simply an answer.
  assert.equal(classifyTurnText(envelope, { toolCalls: 2 }).kind, 'answer');
});

// ── Canonical top-level tool accounting ─────────────────────────────────────

test('MCP transport mirrors cannot manufacture a repeated-tool loop signal', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat', title: 'mirror accounting' });
  for (let index = 1; index <= 2; index += 1) {
    const callId = `outlook-${index}`;
    appendEvent({
      sessionId: sess.id,
      turn: 1,
      role: 'Clem',
      type: 'tool_called',
      data: {
        tool: 'composio_execute_tool',
        callId,
        canonicalCallId: callId,
        accounting: 'top_level',
        arguments: '{"tool_slug":"OUTLOOK_LIST_MESSAGES","arguments":"{}"}',
      },
    });
    appendEvent({
      sessionId: sess.id,
      turn: 0,
      role: 'Clem',
      type: 'tool_called',
      data: {
        tool: 'composio_execute_tool',
        callId,
        accounting: 'transport_mirror',
        arguments: '{"tool_slug":"OUTLOOK_LIST_MESSAGES","arguments":"{}"}',
      },
    });
  }

  assert.equal(evaluateProgress({
    finalOutput: 'I found the relevant messages.',
    toolCalls: 2,
    sessionId: sess.id,
  }), undefined, 'two logical calls plus their mirrors are still only two calls');

  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      tool: 'composio_execute_tool',
      callId: 'outlook-3',
      canonicalCallId: 'outlook-3',
      accounting: 'top_level',
      arguments: '{"tool_slug":"OUTLOOK_LIST_MESSAGES","arguments":"{}"}',
    },
  });
  const repeated = evaluateProgress({
    finalOutput: 'I found the relevant messages.',
    toolCalls: 3,
    sessionId: sess.id,
  });
  assert.equal(repeated?.signal, 'B_repeated_tool');
  assert.equal(repeated?.detail.repeatCount, 3);
});

test('legacy and native top-level rows still drive repeated-tool detection', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat', title: 'native accounting' });
  for (let index = 1; index <= 3; index += 1) {
    appendEvent({
      sessionId: sess.id,
      turn: 1,
      role: 'Clem',
      type: 'tool_called',
      data: {
        tool: 'GONG_GET_CALL_TRANSCRIPT',
        callId: `gong-${index}`,
        arguments: '{"call_id":"recording-123"}',
        ...(index === 1 ? {} : { accounting: 'top_level', canonicalCallId: `gong-${index}` }),
      },
    });
  }
  assert.equal(evaluateProgress({
    finalOutput: 'The transcript lookup completed.',
    toolCalls: 3,
    sessionId: sess.id,
  })?.signal, 'B_repeated_tool');
});

test('a mirror-only prior cannot validate a zero-tool completion claim', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat', title: 'prior accounting' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      tool: 'OUTLOOK_SEND_EMAIL',
      callId: 'send-1',
      accounting: 'transport_mirror',
    },
  });
  const decision = {
    summary: 'Sent the email.',
    reply: 'Sent the email.',
    done: true,
    nextAction: 'completed' as const,
    reason: null,
  };
  assert.equal(evaluateStructuredDecisionStall({
    decision,
    toolCalls: 0,
    sessionId: sess.id,
    turn: 2,
  })?.signal, 'A_zero_tools');

  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      tool: 'OUTLOOK_SEND_EMAIL',
      callId: 'send-1',
      canonicalCallId: 'send-1',
      accounting: 'top_level',
    },
  });
  assert.equal(evaluateStructuredDecisionStall({
    decision,
    toolCalls: 0,
    sessionId: sess.id,
    turn: 2,
  }), undefined, 'a real prior top-level send still backs the completion');
});

test('a transport mirror after handoff does not masquerade as post-handoff progress', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat', title: 'handoff accounting' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'handoff',
    data: { from: 'Clem', to: 'Researcher' },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: { tool: 'composio_execute_tool', callId: 'mirror-1', accounting: 'transport_mirror' },
  });
  assert.equal(evaluateProgress({
    finalOutput: 'Continuing.',
    toolCalls: 1,
    sessionId: sess.id,
    turn: 1,
  })?.signal, 'A_zero_tools');
});
