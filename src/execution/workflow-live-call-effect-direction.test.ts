/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-live-call-effect-direction.test.ts
 *
 * The live-call effect gate must refuse ESCALATION, not inequality.
 *
 * The gate exists so an authored `read` cannot quietly resolve to a live write.
 * Its first implementation demanded exact class equality, which also refused
 * the reverse — an operation that does LESS than declared. That direction is
 * strictly safer than what was already approved, and refusing it turned a safe
 * surprise into a dead workflow.
 *
 * The reverse case is the DEFAULT path, not an edge case. A promptless `call`
 * step — the exact shape `workflow_create` recommends ("No prompt needed") —
 * never gets `sideEffect` stamped, because autoRepair only stamps when
 * `step.prompt` is truthy (workflow-enforce.ts). `structuredCallSideEffectClass`
 * then sees `undefined`, not `'read'`, and returns its conservative `'write'`.
 * That default is right FOR VALIDATION and is deliberately left alone; it is
 * simply not an author's declaration. Treating it as one made every noun-shaped
 * read slug (SLACK_CONVERSATIONS_HISTORY, TWITTER_USER_TIMELINE)
 * non-recoverable.
 *
 * Downstream it was worse: a Workspace action can only ever declare
 * 'send'|'write' (space-action-v3-authority.ts:124), so a read-bound action
 * refused here landed in `recordApprovedActionNotRun` — refused AFTER a human
 * approved it. That is the safe-but-unavailable failure, not a safeguard.
 *
 * NOTE ON SHAPE: an earlier version of this file tried to drive the whole
 * compiler with hand-registered catalog entries. Those entries carried no
 * capability manifest, so the compiler skipped them and every case failed with
 * "No current capability is registered" — the pins passed while proving
 * nothing. The decision is therefore pinned directly, at the exported
 * predicate the compiler actually calls.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { liveCallEffectEscalates } = await import('./workflow-live-call-compiler.js');

test('an authored read that resolves to a live write is an ESCALATION', () => {
  assert.equal(liveCallEffectEscalates('read', 'write'), true,
    'a read must never quietly acquire write authority — this is the whole point of the gate');
  assert.equal(liveCallEffectEscalates('read', 'admin'), true,
    'admin authority is further still from a declared read');
});

test('an authored write that resolves to a live read is NOT an escalation', () => {
  assert.equal(liveCallEffectEscalates('write', 'read'), false,
    'an operation that does LESS than declared is safer than what was approved');
  assert.equal(liveCallEffectEscalates('send', 'read'), false,
    'the same holds for a send-declared step, which is over-gated rather than under-gated');
});

test('matching effects are never an escalation', () => {
  assert.equal(liveCallEffectEscalates('read', 'read'), false);
  assert.equal(liveCallEffectEscalates('write', 'write'), false);
  assert.equal(liveCallEffectEscalates('send', 'write'), false,
    'send is an irreversibility marker on top of write, not a higher tier of authority');
});

test('admin authority escalates above every declarable class', () => {
  // Nothing a workflow can author declares admin, so a live admin operation is
  // always more than was asked for.
  for (const authored of ['read', 'write', 'send'] as const) {
    assert.equal(liveCallEffectEscalates(authored, 'admin'), true,
      `a live admin operation must never satisfy an authored ${authored}`);
  }
});

test('the compiler consumes this predicate rather than re-deriving the rule', () => {
  // A locally correct predicate the compiler never calls would be a false green.
  const source = readFileSync(new URL('./workflow-live-call-compiler.ts', import.meta.url), 'utf8');
  assert.match(source, /liveCallEffectEscalates\(input\.expectedEffect, liveEffectClass\)/,
    'the compiler must decide via the pinned predicate');
  assert.doesNotMatch(source, /liveEffectClass === 'write'\s*\n?\s*:\s*false/,
    'the old exact-equality comparison must not survive alongside it');
});

import { readFileSync } from 'node:fs';
