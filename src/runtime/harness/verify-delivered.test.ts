/**
 * Run: npx tsx --test src/runtime/harness/verify-delivered.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDelivered, matchesBlockedText, classifyBlocker } from './verify-delivered.js';
import type { ObjectiveJudgeVerdict } from './objective-judge.js';

// A judge stub that records whether it was invoked, so we can assert the
// "suspicious-only" budget: it must fire ONLY on a promise-shaped reply.
function judgeStub(done: boolean): { fn: (o: string, r: string) => Promise<ObjectiveJudgeVerdict>; calls: () => number } {
  let calls = 0;
  return {
    fn: async () => {
      calls += 1;
      return { done, reason: done ? 'artifact present' : 'no verifiable artifact' };
    },
    calls: () => calls,
  };
}

test('a clean completion with an artifact is delivered WITHOUT spending a judge call', async () => {
  const judge = judgeStub(true);
  const v = await verifyDelivered(
    'create a summary doc',
    "Done — wrote the summary to /tmp/out.md. Here's the link: https://x/y",
    { stoppedReason: 'success', judgeFn: judge.fn },
  );
  assert.equal(v.delivered, true);
  assert.equal(v.status, 'completed');
  assert.equal(judge.calls(), 0, 'a non-promise-shaped reply must not invoke the judge');
});

test('a runtime-error stoppedReason is blocked (no judge needed)', async () => {
  const judge = judgeStub(true);
  const v = await verifyDelivered('pull the data', 'Some partial text', {
    stoppedReason: 'error',
    judgeFn: judge.fn,
  });
  assert.equal(v.delivered, false);
  assert.equal(v.status, 'blocked');
  assert.equal(judge.calls(), 0);
});

test('a cancelled run is blocked', async () => {
  const v = await verifyDelivered('do the thing', 'whatever', { stoppedReason: 'cancelled' });
  assert.equal(v.delivered, false);
  assert.equal(v.status, 'blocked');
});

test('max-turns-with-grace is blocked until the user continues', async () => {
  const judge = judgeStub(true);
  const v = await verifyDelivered(
    'finish the whole research run',
    'I hit the run budget before finishing — say "continue" to keep going.',
    { stoppedReason: 'max-turns-with-grace', judgeFn: judge.fn },
  );
  assert.equal(v.delivered, false);
  assert.equal(v.status, 'blocked');
  assert.match(v.reason ?? '', /continue|budget/i);
  assert.equal(judge.calls(), 0, 'structured stop reason must not spend a judge call');
});

test('blocked-text in the final reply is blocked (no judge needed)', async () => {
  const judge = judgeStub(true);
  const v = await verifyDelivered('pull salesforce contacts', 'I am blocked — unable to access the CRM.', {
    stoppedReason: 'success',
    judgeFn: judge.fn,
  });
  assert.equal(v.delivered, false);
  assert.equal(v.status, 'blocked');
  assert.equal(judge.calls(), 0);
});

test('self-reported missing tool surface is blocked (no judge needed)', async () => {
  const judge = judgeStub(true);
  const text =
    'This run is executing inside a text-only Claude Code print-mode subprocess. Shell execution is not exposed here, so I cannot create the requested files.';
  const v = await verifyDelivered('create the requested files', text, {
    stoppedReason: 'success',
    judgeFn: judge.fn,
  });
  assert.equal(v.delivered, false);
  assert.equal(v.status, 'blocked');
  assert.equal(v.blockerType, 'permission');
  assert.equal(judge.calls(), 0);
});

test('a self-declared non-delivery is blocked even when the run stopped cleanly', async () => {
  const judge = judgeStub(true);
  const v = await verifyDelivered(
    'count markdown files and return only the integer',
    "I'm stopping this run without a number because no command executed and no tool result was available. Nothing satisfies the success criterion; no verified integer was produced.",
    { stoppedReason: 'success', judgeFn: judge.fn },
  );
  assert.equal(v.delivered, false);
  assert.equal(v.status, 'blocked');
  assert.match(v.reason ?? '', /without a number/i);
  assert.equal(judge.calls(), 0);
});

test('a PROMISE-shaped reply spends a judge call; judge=not-done => blocked', async () => {
  const judge = judgeStub(false);
  const v = await verifyDelivered("prep the contacts", "I'll prep those contacts and get them over to you next.", {
    stoppedReason: 'success',
    judgeFn: judge.fn,
  });
  assert.equal(judge.calls(), 1, 'a promise-shaped reply is the one shape that must be judged');
  assert.equal(v.delivered, false);
  assert.equal(v.status, 'blocked');
  assert.match(v.reason ?? '', /artifact/i);
});

test('a PROMISE-shaped reply the judge confirms done is delivered', async () => {
  const judge = judgeStub(true);
  const v = await verifyDelivered("prep the contacts", "I'll prep those contacts now.", {
    stoppedReason: 'success',
    judgeFn: judge.fn,
  });
  assert.equal(judge.calls(), 1);
  assert.equal(v.delivered, true);
  assert.equal(v.status, 'completed');
});

test('STRICTLY fail-open: a throwing judge resolves to delivered, never wedges', async () => {
  const throwingJudge = async (): Promise<ObjectiveJudgeVerdict> => {
    throw new Error('judge backend down');
  };
  // Promise-shaped (so the judge path is reached), but the judge throws.
  const v = await verifyDelivered('prep the contacts', "I'll prep those next.", {
    stoppedReason: 'success',
    judgeFn: async (o, r) => {
      try {
        return await throwingJudge();
      } catch {
        // mirror judgeObjectiveComplete's own fail-open contract
        return { done: true, reason: 'judge unavailable — accepting completion' };
      }
    },
  });
  assert.equal(v.delivered, true);
});

test('kill-switch off => always delivered (no behavior change, no judge call)', async () => {
  const prev = process.env.CLEMMY_VERIFY_DELIVERED;
  const judge = judgeStub(false);
  try {
    process.env.CLEMMY_VERIFY_DELIVERED = 'off';
    const v = await verifyDelivered('pull the data', 'I am blocked, cannot proceed.', {
      stoppedReason: 'error',
      judgeFn: judge.fn,
    });
    assert.equal(v.delivered, true, 'with the kill-switch off, nothing is ever flagged');
    assert.equal(v.status, 'completed');
    assert.equal(judge.calls(), 0);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_VERIFY_DELIVERED;
    else process.env.CLEMMY_VERIFY_DELIVERED = prev;
  }
});

test('matchesBlockedText: true on blocked shapes, false on a clean result', () => {
  assert.equal(matchesBlockedText('Approval required to send.'), true);
  assert.equal(matchesBlockedText('waiting on your confirmation'), true);
  assert.equal(matchesBlockedText("I'm stopping this run without a number."), true);
  assert.equal(matchesBlockedText('Nothing that satisfies the success criterion; no verified integer produced.'), true);
  assert.equal(matchesBlockedText('This environment has no tool access, so I cannot fetch search volumes.'), true);
  assert.equal(matchesBlockedText('Added 5 rows to the sheet.'), false);
  assert.equal(matchesBlockedText(''), false);
  assert.equal(matchesBlockedText(undefined), false);
});

test('classifyBlocker: structured stoppedReason signals win', () => {
  assert.equal(classifyBlocker('anything', 'pending-approval'), 'needs_approval');
  assert.equal(classifyBlocker('anything', 'max-turns-with-grace'), 'budget');
  assert.equal(classifyBlocker('no useful text', 'error'), 'runtime_error');
  assert.equal(classifyBlocker('', 'cancelled'), 'unknown');
});

test('classifyBlocker: tags the blocker text by KIND (ordered, most-specific-first)', () => {
  assert.equal(classifyBlocker('Rate limit exceeded, back off.'), 'rate_limited');
  assert.equal(classifyBlocker('429 too many requests'), 'rate_limited');
  assert.equal(classifyBlocker('Approval required to send the emails.'), 'needs_approval');
  assert.equal(classifyBlocker('Permission denied on the CRM.'), 'permission');
  assert.equal(classifyBlocker('Missing credentials for Salesforce.'), 'permission');
  assert.equal(classifyBlocker('This environment has no tool access, so I cannot fetch search volumes.'), 'permission');
  assert.equal(classifyBlocker('The service is unavailable (503).'), 'external_down');
  assert.equal(classifyBlocker('connection reset by peer'), 'external_down');
  assert.equal(classifyBlocker('I hit the run budget before finishing.'), 'budget');
  assert.equal(classifyBlocker('The Salesforce pull came back empty.'), 'missing_data');
  assert.equal(classifyBlocker('no rows found in the export'), 'missing_data');
  assert.equal(classifyBlocker('I need your input on which option to pick.'), 'needs_user_input');
  assert.equal(classifyBlocker('waiting on your confirmation'), 'needs_user_input');
  // A genuine blocker with no recognizable class is still typed (never untyped).
  assert.equal(classifyBlocker('I am blocked.'), 'unknown');
  assert.equal(classifyBlocker(''), 'unknown');
  assert.equal(classifyBlocker(undefined), 'unknown');
});

test('classifyBlocker: a specific text cause beats a generic error stop', () => {
  // stoppedReason=error would default to runtime_error, but the text names a
  // more actionable cause — the text wins.
  assert.equal(classifyBlocker('Rate limited by the upstream API.', 'error'), 'rate_limited');
  assert.equal(classifyBlocker('Permission denied.', 'error'), 'permission');
});

test('verifyDelivered carries a routable blockerType on every blocked verdict', async () => {
  const judge = judgeStub(true);
  const err = await verifyDelivered('pull the data', 'connection reset by peer', { stoppedReason: 'error', judgeFn: judge.fn });
  assert.equal(err.delivered, false);
  assert.equal(err.blockerType, 'external_down');

  const appr = await verifyDelivered('do it', 'x', { stoppedReason: 'pending-approval' });
  assert.equal(appr.blockerType, 'needs_approval');

  const budget = await verifyDelivered('finish', 'hit the run budget', { stoppedReason: 'max-turns-with-grace' });
  assert.equal(budget.blockerType, 'budget');

  const blockedText = await verifyDelivered('pull salesforce', 'Missing credentials for the CRM.', { stoppedReason: 'success' });
  assert.equal(blockedText.delivered, false);
  assert.equal(blockedText.blockerType, 'permission');

  // A clean delivery carries no blockerType.
  const ok = await verifyDelivered('write a doc', 'Done — wrote /tmp/out.md https://x/y', { stoppedReason: 'success', judgeFn: judge.fn });
  assert.equal(ok.delivered, true);
  assert.equal(ok.blockerType, undefined);
});

// ── Move 3 (trust roadmap #48): adversarial refute-the-completion ────────────

test('Move 3: unanimous refutation blocks a high-stakes done-claim; split verdict delivers', async () => {
  const { verifyDelivered } = await import('./verify-delivered.js');
  // Both lenses refute (judge says not-done for every lens) → blocked.
  const blocked = await verifyDelivered('Send the Q3 invoices to all 12 clients', 'All done! Everything went great.', {
    highStakes: true,
    judgeFn: async () => ({ done: false, reason: 'no evidence any invoice was sent' }),
  });
  assert.equal(blocked.delivered, false);
  assert.equal(blocked.blockerType, 'unverified_completion');
  // Split verdict (one lens satisfied) → inform, don't block.
  let call = 0;
  const split = await verifyDelivered('Send the Q3 invoices to all 12 clients', 'Sent 12 invoices; message ids: m1…m12.', {
    highStakes: true,
    judgeFn: async () => ({ done: (call += 1) === 1, reason: 'lens verdict' }),
  });
  assert.equal(split.delivered, true, 'a single refuting lens must not block (unanimity required)');
});

test('Move 3: refuters fail OPEN and never run on ordinary lanes', async () => {
  const { verifyDelivered } = await import('./verify-delivered.js');
  // Judge failed-open (dead judge) → not refuted → delivered.
  const failedOpen = await verifyDelivered('objective', 'A clean, evidence-bearing reply with artifact id A-1.', {
    highStakes: true,
    judgeFn: async () => ({ done: true, reason: 'judge unavailable — accepting completion', failedOpen: true }),
  });
  assert.equal(failedOpen.delivered, true);
  // Ordinary lane (no highStakes): the judge must not even be consulted for
  // a non-promise-shaped reply — zero added latency.
  let judgeCalls = 0;
  const ordinary = await verifyDelivered('objective', 'Here is the finished report: 42 rows, saved to /tmp/report.md.', {
    judgeFn: async () => { judgeCalls += 1; return { done: false, reason: 'x' }; },
  });
  assert.equal(ordinary.delivered, true);
  assert.equal(judgeCalls, 0, 'no refuters, no judge on ordinary accepts');
  // Kill-switch.
  process.env.CLEMMY_REFUTE_COMPLETION = 'off';
  try {
    const off = await verifyDelivered('objective', 'All done! Everything went great.', {
      highStakes: true,
      judgeFn: async () => ({ done: false, reason: 'would refute' }),
    });
    assert.equal(off.delivered, true, 'kill-switch off → refuters inert');
  } finally {
    delete process.env.CLEMMY_REFUTE_COMPLETION;
  }
});
