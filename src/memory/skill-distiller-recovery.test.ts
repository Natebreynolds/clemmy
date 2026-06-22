/**
 * Run: npx tsx --test src/memory/skill-distiller-recovery.test.ts
 *
 * Recovery procedures from FAILED trajectories (Lane D Phase 1). Today only
 * successes distill; deriveRecoveryTip closes the asymmetry — a slug that FAILED
 * (non-transiently) and was then retried with corrected args is a figured-out
 * recovery worth remembering as an error-signature-keyed tip. A TRANSIENT blip
 * (429/timeout) is NOT a lesson and must never mint a tip (poison guard).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRecoveryTip } from './skill-distiller.js';
import type { TraceToolCall } from '../execution/trace-to-workflow.js';

const call = (slug: string, args: string, callId: string): TraceToolCall => ({
  tool: 'composio_execute_tool', args, callId, slug,
});

test('failed-then-corrected (non-transient) → recovery tip keyed to the error signature', () => {
  const calls = [
    call('GMAIL_SEND_EMAIL', '{"to":"a@b.com","subject":"s"}', 'c1'),
    call('GMAIL_SEND_EMAIL', '{"to":"a@b.com","subject":"s","body":"b"}', 'c2'),
  ];
  const returns = new Map([
    ['c1', 'could not send: missing required field body'],
    ['c2', 'sent ok'],
  ]);
  const tip = deriveRecoveryTip(calls, returns);
  assert.ok(tip, 'a corrected retry should mint a tip');
  assert.match(tip!, /GMAIL_SEND_EMAIL/);
  assert.match(tip!, /retry with corrected args/);
  assert.match(tip!, /missing required field body/);
});

test('TRANSIENT failure (timed out) retried → NO tip (poison guard)', () => {
  const calls = [
    call('GMAIL_SEND_EMAIL', '{"to":"a@b.com"}', 'c1'),
    call('GMAIL_SEND_EMAIL', '{"to":"a@b.com","retry":true}', 'c2'),
  ];
  // evidenceLooksFailedOrBlocked TRUE ("could not send") AND isTransientFailure TRUE ("timed out")
  const returns = new Map([['c1', 'could not send: request timed out'], ['c2', 'sent ok']]);
  assert.equal(deriveRecoveryTip(calls, returns), null);
});

test('single call (no retry) → null (nothing was figured out)', () => {
  const calls = [call('GMAIL_SEND_EMAIL', '{"to":"a@b.com"}', 'c1')];
  const returns = new Map([['c1', 'could not send: missing body']]);
  assert.equal(deriveRecoveryTip(calls, returns), null);
});

test('identical re-fire (same args twice) → null (a loop, not a corrected retry)', () => {
  const calls = [
    call('GMAIL_SEND_EMAIL', '{"to":"a@b.com"}', 'c1'),
    call('GMAIL_SEND_EMAIL', '{"to":"a@b.com"}', 'c2'),
  ];
  const returns = new Map([['c1', 'could not send: missing body'], ['c2', 'could not send: missing body']]);
  assert.equal(deriveRecoveryTip(calls, returns), null);
});

test('success-only trajectory → null', () => {
  const calls = [
    call('GMAIL_SEND_EMAIL', '{"to":"a@b.com"}', 'c1'),
    call('GMAIL_SEND_EMAIL', '{"to":"x@y.com"}', 'c2'),
  ];
  const returns = new Map([['c1', 'sent ok'], ['c2', 'sent ok']]);
  assert.equal(deriveRecoveryTip(calls, returns), null);
});

test('non-composio calls (no slug) are ignored — only rot-prone composio actions distill recovery', () => {
  const calls: TraceToolCall[] = [
    { tool: 'run_shell_command', args: 'netlify deploy', callId: 'c1', slug: undefined },
    { tool: 'run_shell_command', args: 'netlify deploy --prod', callId: 'c2', slug: undefined },
  ];
  const returns = new Map([['c1', 'could not deploy: no site linked'], ['c2', 'deployed']]);
  assert.equal(deriveRecoveryTip(calls, returns), null);
});
