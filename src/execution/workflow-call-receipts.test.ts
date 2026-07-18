/**
 * Correctness-critical structured-call mutation receipts. CLEMENTINE_HOME is
 * bound before importing the store so every test writes only to a temp vault.
 */
import { mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-call-receipts-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const {
  executeWorkflowCallMutation,
  inspectWorkflowCallMutation,
  replayWorkflowCallMutationSlot,
  workflowCallMutationSlotHasLedger,
  workflowCallMutationFingerprint,
  WorkflowCallMutationAmbiguousError,
  WorkflowCallMutationConflictError,
  WorkflowCallMutationProvenFailureError,
} = await import('./workflow-call-receipts.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');

function mutation(runId: string, overrides: Record<string, unknown> = {}) {
  return {
    workflowSlug: 'receipt-safety',
    runId,
    stepId: 'send_update',
    tool: 'GMAIL_SEND_EMAIL',
    account: { connectionId: 'ca_primary', identity: 'Owner@Example.com' },
    args: { to: 'client@example.com', subject: 'Update', body: 'Ready' },
    ...overrides,
  } as Parameters<typeof executeWorkflowCallMutation>[0];
}

test('mutation receipt: durable intent and started boundary exist before provider dispatch', async () => {
  const input = mutation('intent-before-dispatch');
  let dispatches = 0;

  const output = await executeWorkflowCallMutation(input, async () => {
    dispatches += 1;
    const duringDispatch = inspectWorkflowCallMutation(input);
    assert.equal(duringDispatch.status, 'ambiguous', 'started is durable before the provider thunk runs');
    return { messageId: 'm-1' };
  });

  assert.equal(dispatches, 1);
  assert.deepEqual(output, { messageId: 'm-1' });
  assert.equal(inspectWorkflowCallMutation(input).status, 'committed');
});

test('mutation receipt: intent persistence failure refuses provider dispatch', async () => {
  const input = mutation('intent-write-failure', { workflowSlug: 'invalid\0workflow-path' });
  let dispatches = 0;
  await assert.rejects(
    executeWorkflowCallMutation(input, async () => {
      dispatches += 1;
      return { shouldNotRun: true };
    }),
    /dispatch refused/,
  );
  assert.equal(dispatches, 0);
});

test('mutation receipt: success is receipted and committed, then replayed without a second dispatch', async () => {
  const input = mutation('commit-after-success');
  let dispatches = 0;

  const first = await executeWorkflowCallMutation(input, async () => {
    dispatches += 1;
    return { id: 'external-42', accepted: true };
  });
  const committed = inspectWorkflowCallMutation(input);
  assert.equal(committed.status, 'committed');
  assert.deepEqual(committed.result, first);

  const replay = await executeWorkflowCallMutation(input, async () => {
    dispatches += 1;
    throw new Error('committed calls must never reach a second dispatch');
  });
  assert.equal(dispatches, 1);
  assert.deepEqual(replay, first);
  assert.equal(workflowCallMutationSlotHasLedger(input), true);
  assert.deepEqual(replayWorkflowCallMutationSlot(input), { replayed: true, result: first });
});

test('mutation receipt: a no-auth toolkit (undefined connectionId) records intent+started+receipt and replays once', async () => {
  // A no-auth toolkit resolves ok with no connection to pin — the ledger must
  // treat it as the provider-default account, not refuse a call with no account
  // to connect. Both account fields absent exercises the null-account path.
  const input = mutation('no-auth-default-account', { account: undefined });
  let dispatches = 0;

  const first = await executeWorkflowCallMutation(input, async () => {
    dispatches += 1;
    const duringDispatch = inspectWorkflowCallMutation(input);
    assert.equal(duringDispatch.status, 'ambiguous', 'started is durable before the provider thunk runs');
    return { id: 'default-entity-created' };
  });
  assert.equal(dispatches, 1);
  assert.equal(inspectWorkflowCallMutation(input).status, 'committed');
  assert.equal(workflowCallMutationSlotHasLedger(input), true);

  const replay = await executeWorkflowCallMutation(input, async () => {
    dispatches += 1;
    throw new Error('committed no-auth call must never reach a second dispatch');
  });
  assert.equal(dispatches, 1, 'a committed no-auth mutation replays its receipt without re-dispatch');
  assert.deepEqual(replay, first);
  assert.deepEqual(replayWorkflowCallMutationSlot(input), { replayed: true, result: first });

  // The fingerprint collapses "no account" (undefined) and an explicit empty
  // account to the same provider-default identity.
  assert.equal(
    workflowCallMutationFingerprint(input),
    workflowCallMutationFingerprint(mutation('no-auth-default-account', { account: {} })),
  );
});

test('mutation receipt: a no-auth dispatch that hits "no connected account" is recorded failed, never a false success', async () => {
  // The gateway only refuses an auth-required route as a typed block (never
  // reaching this ledger) for the AMBIGUOUS/BREAKER cases. A single unconnected
  // toolkit instead resolves ok with no connectionId and the PROVIDER rejects at
  // the door ("no connected account found"). Wired with the same real
  // classifiers the call-node boundary uses, that must be recorded as a proven
  // no-commit failure — refused, retryable, and never committed as success.
  const { detectComposioFailure, composioFailureProvesNoCommit } = await import('../tools/composio-tools.js');
  const input = mutation('no-auth-provider-not-connected', { account: undefined });
  const classifyFailure = (result: unknown) => {
    const failure = detectComposioFailure(result);
    return failure.failed
      ? { summary: failure.summary || 'provider reported failure', provenNoCommit: composioFailureProvesNoCommit(result) }
      : null;
  };
  let dispatches = 0;

  await assert.rejects(
    executeWorkflowCallMutation(input, async () => {
      dispatches += 1;
      return { successful: false, error: 'no connected account found' };
    }, { classifyFailure }),
    (err: unknown) => err instanceof WorkflowCallMutationProvenFailureError,
  );
  const failed = inspectWorkflowCallMutation(input);
  assert.equal(failed.status, 'failed');
  assert.equal(dispatches, 1, 'a no-auth call still dispatches once so the provider can reject it');
});

test('mutation receipt: a non-serializable provider success parks as ambiguous after dispatch', async () => {
  const input = mutation('cyclic-provider-success');
  let dispatches = 0;
  const cyclic: Record<string, unknown> = { id: 'remote-created' };
  cyclic.self = cyclic;

  await assert.rejects(
    executeWorkflowCallMutation(input, async () => {
      dispatches += 1;
      return cyclic;
    }),
    (err: unknown) => {
      assert.ok(err instanceof WorkflowCallMutationAmbiguousError);
      assert.match((err as Error).message, /Provider returned after dispatch/);
      return true;
    },
  );
  assert.equal(inspectWorkflowCallMutation(input).status, 'ambiguous');
  await assert.rejects(
    executeWorkflowCallMutation(input, async () => {
      dispatches += 1;
      return { duplicate: true };
    }),
    (err: unknown) => err instanceof WorkflowCallMutationAmbiguousError,
  );
  assert.equal(dispatches, 1, 'receipt encoding failure never reopens the provider boundary');
});

test('mutation receipt: started without a success receipt is ambiguous and refuses recovery dispatch', async () => {
  const input = mutation('ambiguous-start');
  let recoveryDispatches = 0;

  await assert.rejects(
    executeWorkflowCallMutation(input, async () => {
      throw new Error('socket closed after request bytes were sent');
    }),
    /socket closed/,
  );
  assert.equal(inspectWorkflowCallMutation(input).status, 'ambiguous');

  await assert.rejects(
    executeWorkflowCallMutation(input, async () => {
      recoveryDispatches += 1;
      return { duplicate: true };
    }),
    (err: unknown) => {
      assert.ok(err instanceof WorkflowCallMutationAmbiguousError);
      assert.match((err as Error).message, /NOT dispatched again/);
      return true;
    },
  );
  assert.equal(recoveryDispatches, 0, 'ambiguous recovery must park/refuse before provider dispatch');
});

test('mutation receipt: a concurrent executor cannot cross an in-flight dispatch boundary', async () => {
  const input = mutation('concurrent-owner');
  let dispatches = 0;
  let releaseDispatch!: () => void;
  let signalStarted!: () => void;
  const dispatchStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseDispatch = resolve; });

  const owner = executeWorkflowCallMutation(input, async () => {
    dispatches += 1;
    signalStarted();
    await release;
    return { messageId: 'only-once' };
  });
  await dispatchStarted;

  await assert.rejects(
    executeWorkflowCallMutation(input, async () => {
      dispatches += 1;
      return { duplicate: true };
    }),
    (err: unknown) => err instanceof WorkflowCallMutationAmbiguousError,
  );
  assert.equal(dispatches, 1, 'only the atomic boundary owner may reach the provider');

  releaseDispatch();
  assert.deepEqual(await owner, { messageId: 'only-once' });
  assert.equal(inspectWorkflowCallMutation(input).status, 'committed');
});

test('mutation receipt: a proven-no-commit failure is durable and never committed as success without a real re-dispatch', async () => {
  const input = mutation('provider-failure');
  let dispatches = 0;
  const classifyFailure = (result: { successful: boolean; error?: string }) => (
    result.successful === false
      ? { summary: result.error ?? 'provider failed', provenNoCommit: true }
      : null
  );

  await assert.rejects(
    executeWorkflowCallMutation(input, async () => {
      dispatches += 1;
      return { successful: false, error: 'invalid recipient' };
    }, { classifyFailure }),
    (err: unknown) => err instanceof WorkflowCallMutationProvenFailureError,
  );
  const failed = inspectWorkflowCallMutation(input);
  assert.equal(failed.status, 'failed');
  assert.match(failed.failureSummary ?? '', /invalid recipient/);

  // A still-failing retry re-dispatches (the failure PROVED no commit, so a
  // second attempt cannot double-write) and throws again — the stale failed
  // result is never silently reported as success.
  await assert.rejects(
    executeWorkflowCallMutation(input, async () => {
      dispatches += 1;
      return { successful: false, error: 'invalid recipient' };
    }, { classifyFailure }),
    (err: unknown) => err instanceof WorkflowCallMutationProvenFailureError,
  );
  assert.equal(dispatches, 2, 'a proven-no-commit failure re-dispatches rather than silently replaying the failed result');
});

test('mutation receipt: a proven-no-commit failure that later succeeds commits on retry (e.g. a cleared 429)', async () => {
  const input = mutation('proven-then-success');
  let dispatches = 0;
  const classifyFailure = (result: { successful: boolean; error?: string }) => (
    result.successful === false
      ? { summary: result.error ?? 'rate limited', provenNoCommit: true }
      : null
  );

  await assert.rejects(
    executeWorkflowCallMutation(input, async () => {
      dispatches += 1;
      return { successful: false, error: '429 rate limited' };
    }, { classifyFailure }),
    (err: unknown) => err instanceof WorkflowCallMutationProvenFailureError,
  );
  assert.equal(inspectWorkflowCallMutation(input).status, 'failed');

  // The rate limit clears: the same run/step slot re-dispatches exactly once
  // more and commits. Nothing was committed on the failed attempt, so this is
  // the first and only external mutation (2026-07-17 final-wave review #5/#10).
  const result = await executeWorkflowCallMutation(input, async () => {
    dispatches += 1;
    return { successful: true, messageId: 'sent-after-retry' };
  }, { classifyFailure });
  assert.deepEqual(result, { successful: true, messageId: 'sent-after-retry' });
  assert.equal(dispatches, 2, 'exactly one retry dispatch after the proven-no-commit failure');
  assert.equal(inspectWorkflowCallMutation(input).status, 'committed');

  // The now-committed result replays without any further dispatch.
  const replay = await executeWorkflowCallMutation(input, async () => {
    dispatches += 1;
    return { successful: true, messageId: 'should-not-run' };
  }, { classifyFailure });
  assert.deepEqual(replay, { successful: true, messageId: 'sent-after-retry' });
  assert.equal(dispatches, 2, 'a committed slot never re-dispatches');
});

test('mutation receipt: uncertain provider failure is ambiguous, never committed as success', async () => {
  const input = mutation('provider-uncertain-failure');
  await assert.rejects(
    executeWorkflowCallMutation(input, async () => ({
      successful: false,
      error: '503 upstream response lost after submit',
    }), {
      classifyFailure: (result) => ({ summary: result.error, provenNoCommit: false }),
    }),
    (err: unknown) => err instanceof WorkflowCallMutationAmbiguousError,
  );
  assert.equal(inspectWorkflowCallMutation(input).status, 'ambiguous');
});

test('mutation fingerprint binds resolved account and normalized arguments', () => {
  const base = mutation('fingerprint');
  const reordered = mutation('fingerprint', {
    args: { body: 'Ready', subject: 'Update', to: 'client@example.com' },
    account: { identity: 'owner@example.com', connectionId: 'ca_primary' },
  });
  assert.equal(workflowCallMutationFingerprint(base), workflowCallMutationFingerprint(reordered));
  assert.notEqual(
    workflowCallMutationFingerprint(base),
    workflowCallMutationFingerprint(mutation('fingerprint', { account: { connectionId: 'ca_other' } })),
  );
  assert.notEqual(
    workflowCallMutationFingerprint(base),
    workflowCallMutationFingerprint(mutation('fingerprint', { args: { ...base.args, body: 'Changed' } })),
  );
});

test('mutation slot refuses a changed call after the original crossed dispatch boundary', async () => {
  const input = mutation('slot-conflict');
  await assert.rejects(
    executeWorkflowCallMutation(input, async () => {
      throw new Error('ambiguous provider timeout');
    }),
    /ambiguous provider timeout/,
  );

  let dispatches = 0;
  const changed = mutation('slot-conflict', { args: { ...input.args, subject: 'Different' } });
  await assert.rejects(
    executeWorkflowCallMutation(changed, async () => {
      dispatches += 1;
      return { duplicate: true };
    }),
    (err: unknown) => err instanceof WorkflowCallMutationConflictError,
  );
  assert.equal(dispatches, 0);
});

test('mutation replay fails closed when valid JSON corrupts the intent slot', async () => {
  const input = mutation('corrupt-intent-slot');
  await executeWorkflowCallMutation(input, async () => ({ messageId: 'durable' }));
  const fingerprint = workflowCallMutationFingerprint(input);
  const intentFile = path.join(
    WORKFLOWS_DIR,
    input.workflowSlug,
    'runs',
    input.runId,
    'call-mutations',
    fingerprint,
    'intent.json',
  );
  const intent = JSON.parse(readFileSync(intentFile, 'utf-8')) as { slot: { stepId: string } };
  intent.slot.stepId = 'different_step';
  writeFileSync(intentFile, `${JSON.stringify(intent)}\n`, 'utf-8');

  assert.throws(
    () => replayWorkflowCallMutationSlot({
      workflowSlug: input.workflowSlug,
      runId: input.runId,
      stepId: 'different_step',
    }),
    /does not match its path or fingerprint|corrupt/i,
  );
});

test('mutation ledger presence check rejects an incomplete slot claim instead of authorizing recovery', async () => {
  const input = mutation('incomplete-slot-claim');
  await executeWorkflowCallMutation(input, async () => ({ messageId: 'durable' }));
  const claimsRoot = path.join(
    WORKFLOWS_DIR,
    input.workflowSlug,
    'runs',
    input.runId,
    'call-mutations',
    '.slot-claims',
  );
  const [claimDir] = readdirSync(claimsRoot);
  assert.ok(claimDir);
  unlinkSync(path.join(claimsRoot, claimDir, 'claim.json'));

  assert.throws(
    () => workflowCallMutationSlotHasLedger(input),
    /slot claim is incomplete|dispatch refused/i,
  );
});
