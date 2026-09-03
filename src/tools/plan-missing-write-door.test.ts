/** Run: node scripts/run-tests-isolated.mjs src/tools/plan-missing-write-door.test.ts
 *
 * A refusal must name a door that can actually open.
 *
 * plan_incomplete_missing_write names TWO doors in its detail — bind the exact
 * write, or drop it and gather first — but its `repair` named only the first.
 * When the write is blocked on WHICH connected account to use, no amount of
 * tool_search resolves it: the ambiguity is a question for the user at the
 * write boundary. Live 2026-09-03 run 24: OUTLOOK_CREATE_DRAFT was unbindable
 * (two mailboxes), the repair said "search for the missing write", and the turn
 * exhausted on plan_incomplete:missing_write — while the gathering-stage door
 * (an all-read draft, a legitimate stage per the 2026-08-29 owner directive)
 * was open the whole time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./plan-tools.ts', import.meta.url), 'utf8');

test('an account-blocked write is steered to the gathering stage, not to discovery', () => {
  const i = SRC.indexOf("code: 'plan_incomplete_missing_write'");
  assert.ok(i > 0, 'the refusal must exist');
  const block = SRC.slice(i, i + 1800);
  assert.match(block, /accountBlockedWriteInDraft/, 'the repair must branch on account-blocked writes');
  assert.match(block, /gathering stage/i, 'the achievable door must be named');
  assert.match(block, /recoveryTool: accountBlockedWriteInDraft \? 'plan_task'/,
    'an account-blocked write recovers by planning reads, never by searching again');
});

test('the discovery door is kept for a genuinely undisclosed write', () => {
  const i = SRC.indexOf("code: 'plan_incomplete_missing_write'");
  const block = SRC.slice(i, i + 1800);
  assert.match(block, /Use tool_search for the exact missing write capability/,
    'a write that is merely undiscovered still routes to tool_search');
});
