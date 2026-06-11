/**
 * Run: npx tsx --test src/assistant/constraint-survival.test.ts
 *
 * Reproduce-locally-first (binding feedback): a deterministic, NO-live-API
 * repro of the in-chat constraint-drift bug.
 *
 * A user states a hard constraint on turn 1 ("send 25 emails to ONLY this
 * list: <25 names>"), chats for several turns, then approves with a bare
 * "ok" and later "go ahead". The assembled prompt the model actually
 * receives on those ACT turns must still contain the verbatim list.
 *
 * What this protects: the working-memory summary truncates each turn to 180
 * chars and keeps only the last 6 turns, and a bare "ok" classifies as
 * 'casual' whose budget would skip working memory — so without a durable pin,
 * the list is gone from every window the model sees by the approval turn.
 *
 * The pin is written via the Active Task section store (the same write the
 * model-facing `active_task` tool performs — the legacy auto-detector was
 * deleted in goal-contract Phase 0a). What must hold: the pinned constraint
 * is carried forward across turn-end rewrites and re-injected (untruncated)
 * on every subsequent turn — including the casual approval turn.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-constraint-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
// Force FTS-only recall — no network/embedding calls in the repro.
delete process.env.OPENAI_API_KEY;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { ClementineAssistant } = await import('./core.js');
const { writeActiveTaskSection } = await import('../memory/working-memory.js');
import type { AgentRuntime, AgentRuntimeCallbacks } from '../runtime/provider.js';
import type { ApprovalResolutionResult, PendingApproval, RunRequest, RunResult } from '../types.js';

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

/** Records the assembled instructions+prompt handed to the model each turn. */
class RecordingRuntime implements AgentRuntime {
  calls: { instructions: string; prompt: string }[] = [];
  async run(req: RunRequest, _cb?: AgentRuntimeCallbacks): Promise<RunResult> {
    this.calls.push({ instructions: req.instructions ?? '', prompt: req.prompt });
    return { text: 'Acknowledged.', stoppedReason: 'success' };
  }
  listPendingApprovals(): PendingApproval[] {
    return [];
  }
  async resolveApproval(approvalId: string): Promise<ApprovalResolutionResult> {
    return { approvalId, status: 'rejected', text: '', sessionId: '' };
  }
}

// 25 distinct full names; total length comfortably exceeds the 180-char
// working-memory truncation so the bug is observable, and names spread
// across the list let us assert beyond the first-180-chars survivors.
const NAMES = [
  'Alice Anderson', 'Bob Brennan', 'Carol Chen', 'Dan Dawson', 'Eve Ellis',
  'Frank Foley', 'Grace Gupta', 'Hank Holt', 'Ivy Irwin', 'Jack Jones',
  'Kate Kim', 'Leo Lopez', 'Mia Morris', 'Ned Novak', 'Olive Ortiz',
  'Pam Patel', 'Quinn Quan', 'Rob Reyes', 'Sara Singh', 'Tom Tran',
  'Uma Underwood', 'Vic Vargas', 'Wes Wong', 'Xena Xu', 'Yara Yoon',
];
const LIST = NAMES.join(', ');

test('a stated recipient list survives chit-chat and a bare-ack approval turn', async () => {
  const runtime = new RecordingRuntime();
  const assistant = new ClementineAssistant(runtime);
  const sessionId = assistant.createSessionId();

  // The legacy auto-detector (reconcileActiveTask) was deleted in goal-contract
  // Phase 0a — the pin is now written explicitly (as the model-facing
  // `active_task` tool does). What this test still proves is the SURVIVING
  // chain: a written pin carries across turn-end rewrites and is re-injected
  // verbatim into the assembled prompt on casual/bare-ack turns.
  writeActiveTaskSection(sessionId, {
    capturedAt: new Date().toISOString(),
    verb: 'send', count: 25, exclusivity: 'only', recipients: NAMES,
    constraintText: `Send 25 emails to ONLY this list: ${LIST}`,
  });

  const messages = [
    `Send 25 emails to ONLY this list: ${LIST}`, // turn 1 — the constraint
    'thanks',
    'what time is it',
    'cool',
    'got it',
    'sounds good',
    'nice',
    'great',
    'ok', //          turn 9  — bare-ack approval (classifies as 'casual')
    'perfect',
    'yep',
    'go ahead', //    turn 12 — explicit act (classifies as 'action')
  ];

  for (const message of messages) {
    await assistant.respond({ message, sessionId });
  }

  assert.equal(runtime.calls.length, messages.length, 'every turn reached the runtime');

  const ack = runtime.calls[8]; //  'ok'
  const act = runtime.calls[11]; // 'go ahead'
  const ackText = `${ack.instructions}\n${ack.prompt}`;
  const actText = `${act.instructions}\n${act.prompt}`;

  // Spot-check names spread across the list — including ones past the first
  // 180 chars, which a truncated working-memory summary would have dropped.
  for (const name of [NAMES[0], NAMES[12], NAMES[24]]) {
    assert.ok(ackText.includes(name), `bare-ack ('ok') turn prompt is missing "${name}"`);
    assert.ok(actText.includes(name), `act ('go ahead') turn prompt is missing "${name}"`);
  }
});

test('the REAL incident: a list REFERENCE survives the email-copy tangent and is used at action time (not re-discovered)', async () => {
  const runtime = new RecordingRuntime();
  const assistant = new ClementineAssistant(runtime);
  const sessionId = assistant.createSessionId();
  const SHEET = '1AbcD_efGhIjKlMnOpQrStUvWxYz0123456789xyz';

  // Pin the resource explicitly (the `active_task` tool path) — the legacy
  // auto-detector is deleted; this test now covers pin → carry-forward →
  // verbatim injection + use-don't-rediscover discipline at action time.
  writeActiveTaskSection(sessionId, {
    capturedAt: new Date().toISOString(),
    verb: 'send', resourceRef: SHEET, recipients: [],
    constraintText: 'send the Q2 outreach to the list at that sheet',
  });

  const messages = [
    // Turn 1 — point Clem at the list (a concrete resource, like the real user did).
    `send the Q2 outreach to the list at https://docs.google.com/spreadsheets/d/${SHEET}/edit`,
    // Long tangent about the email COPY — nothing about the list.
    "let's work on the email copy",
    'make the subject punchier',
    'add a PS about the webinar',
    'tighten the opening line',
    'good',
    'ok',
    // Action time — the moment Clem previously re-discovered and pulled the WRONG list.
    'now pull the list and send',
  ];
  for (const message of messages) {
    await assistant.respond({ message, sessionId });
  }

  const act = runtime.calls[runtime.calls.length - 1];
  const text = `${act.instructions}\n${act.prompt}`;
  assert.ok(text.includes(SHEET), 'the exact sheet reference is still pinned at action time');
  assert.match(
    text,
    /do NOT re-discover|pull it from the pinned reference/,
    'instructed to use the pinned reference, not re-discover via fresh calls',
  );
});
