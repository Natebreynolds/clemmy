import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * A guardrail escalation is a TERMINAL, not an invocation error.
 *
 * call-tool's `errorFunction` stringifies anything it is not explicitly told to
 * propagate, turning a throw into a model-visible "An error occurred while
 * running the tool. Please try again." string. That is right for an ordinary
 * invocation failure and wrong for a deterministic ceiling: the loop reads a
 * retryable error and keeps going.
 *
 * Live 2026-09-18, turn:233895 — the only escalation in 241,603 events — the
 * guardrail escalated 12 times across 4 minutes and the turn then ran 90 more
 * model calls, 2,650,221 uncached tokens and 9.4 further minutes before the
 * owner pressed stop. The re-entry governor does bound the lane at 200 settled
 * calls, so this is "the backstop fires ~10x too late", not "nothing stops it" —
 * but a guardrail designed to end the turn at the 12th identical call must not
 * be the thing that gets softened.
 *
 * Asserted against source text on purpose. The behaviour lives in a predicate
 * handed to the SDK's FunctionTool wrapper, and a runtime test would need a
 * real dispatch through two wrappers plus a live guardrail trip to observe it —
 * so the honest, durable check is that the carrier still declares the
 * propagation. `ToolCallsLimitExceeded` gets the same treatment one line above
 * in call-tool.ts for the same documented reason.
 */
test('the work_call carrier propagates a guardrail escalation instead of stringifying it', () => {
  const source = readFileSync(new URL('./work-call.ts', import.meta.url), 'utf8');

  assert.match(
    source,
    /propagateInvocationError:\s*\(error: unknown\)\s*=>\s*\(\s*\n?\s*error instanceof ToolGuardrailEscalated/,
    'work_call must declare ToolGuardrailEscalated as propagating, or an escalation '
    + 'becomes a retryable error string and the turn continues past its own ceiling',
  );
  assert.match(
    source,
    /ToolGuardrailEscalated[\s\S]{0,120}from '\.\.\/runtime\/harness\/brackets\.js'/,
    'imported from the module that defines it, not re-declared locally',
  );
  // The durable-continuation signal must survive alongside it: serializing that
  // one fabricates a tool result and triggers nested-settlement adoption.
  assert.match(
    source,
    /isHostDurableContinuationPendingError\(error\)/,
    'the pre-existing durable-continuation propagation must not be displaced',
  );
});

/**
 * The sibling path is NOT fixed, and this test says so out loud rather than
 * letting the gap be discovered by a second runaway. call-tool.ts is the direct
 * `call_tool` carrier; its errorFunction needs the same one-line propagation,
 * and that file was being actively edited elsewhere when this landed.
 */
test('call_tool still needs the same propagation — tracked, not fixed', () => {
  const source = readFileSync(new URL('./call-tool.ts', import.meta.url), 'utf8');
  const propagatesEscalation = /if \(error instanceof ToolGuardrailEscalated\) throw error;/.test(source);
  if (propagatesEscalation) {
    // Someone fixed it. Retire this test rather than leave a passing reminder.
    assert.ok(true, 'call_tool now propagates escalations; delete this test');
    return;
  }
  assert.match(
    source,
    /if \(error instanceof ToolCallsLimitExceeded\) throw error;/,
    'the precedent line must still exist — the call_tool fix goes immediately after it',
  );
});
