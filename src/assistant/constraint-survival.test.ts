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
 * FAILS on main: the turn-1 imperative is never captured (auto-capture
 * rejects imperatives at auto-capture.ts:165), the working-memory summary
 * truncates each turn to 180 chars and keeps only the last 6 turns
 * (working-memory.ts:32,38), and a bare "ok" classifies as 'casual' whose
 * budget skips working memory entirely (message-intent.ts:192). So by the
 * approval turn the list is gone from every window the model sees.
 *
 * PASSES after the durable Active Task fix: the constraint is pinned
 * synchronously to the per-session working-memory file at turn start,
 * carried forward across turn-end rewrites, and re-injected (untruncated)
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
