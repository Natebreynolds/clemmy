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

const { classifyTurnText, toOrchestratorDecision, isPlainTextContractDirective } =
  await import('./turn-decision.js');

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

test('golden sess-mrchgvkc counterpart: same text WITHOUT the contract is still a punt', () => {
  // Without the directive, a sub-300-char announcement-verb reply defers to
  // the stall machinery (that is the desired safety, unchanged).
  const { kind, decision } = classifyTurnText(PRESENTED_DRAFT, { toolCalls: 0 });
  assert.equal(kind, 'punt');
  assert.equal(decision, null);
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
