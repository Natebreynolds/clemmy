/**
 * Run: npx tsx --test src/tools/batch-tools.test.ts
 *
 * J1 — the run_batch CONSUMPTION site: when the certifier cannot obtain a verdict
 * (judge chain exhausted), an irreversible SEND batch must PARK as a human
 * approval card, never terminal-block. Asserts a pending approval row exists, the
 * batch was NOT executed, and the response carries no terminal "refused/blocked".
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolation FIRST (test-hygiene rule): this suite writes pending-action records.
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-batch-tools-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { registerBatchTools, _setBatchPlanRunnerForTests } = await import('./batch-tools.js');
const { _setCertifyJudgeForTests } = await import('../execution/batch-runner.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const {
  getPendingAction,
  listPendingActions,
  markPendingActionApprovalResolved,
  queuePendingAction,
} = await import('../runtime/harness/pending-actions.js');

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type Handler = (input: Record<string, unknown>) => Promise<ToolResult>;

function batchHandler(): Handler {
  const handlers = new Map<string, Handler>();
  registerBatchTools({
    tool(name: string, ...args: unknown[]) {
      handlers.set(name, args.at(-1) as Handler);
    },
  } as never);
  const h = handlers.get('run_batch');
  if (!h) throw new Error('run_batch not registered');
  return h;
}

after(() => {
  _setCertifyJudgeForTests(null);
  _setBatchPlanRunnerForTests(null);
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('run_batch propose: exhausted judge chain + SEND batch → parks as one approval card, not executed, no terminal block', async () => {
  // Every judge attempt throws a transient provider shape → the chain exhausts
  // with no verdict (the live incident: a certifier that only knew one Codex lane
  // hit `Codex 429 usage_limit_reached` and terminal-blocked the payloads).
  _setCertifyJudgeForTests(async () => { throw Object.assign(new Error('Codex 429 usage_limit_reached'), { statusCode: 429 }); });

  const handler = batchHandler();
  const sessionId = 'sess-batch-park';
  const res = await withToolOutputContext({ sessionId }, () => handler({
    action: 'propose',
    plan: {
      tool: 'testmcp__send_message',
      sideEffect: 'send',
      objective: 'send three prepared notices to the saved recipients',
      items: [
        { id: 'a@example.com', args: JSON.stringify({ to: 'a@example.com', text: 'hi a' }) },
        { id: 'b@example.com', args: JSON.stringify({ to: 'b@example.com', text: 'hi b' }) },
        { id: 'c@example.com', args: JSON.stringify({ to: 'c@example.com', text: 'hi c' }) },
      ],
    },
  })) as ToolResult;

  const text = res.content[0].text;
  // NOT a terminal block — the payloads are not stranded.
  assert.doesNotMatch(text, /REFUSED|fail-closed|\bblocked\b/i, 'a judge-unavailable send must not terminal-block');
  // Parked for human review (the human is the fallback judge).
  assert.match(text, /couldn't independently verify|review/i);
  assert.match(text, /pending action pa-/, 'names the pending approval card to approve');
  assert.doesNotMatch(text, /Executed/i, 'the batch was NOT executed at propose time');

  // A single OPEN approval row exists, kind external_send, still queued (not executed).
  const pending = listPendingActions({ sessionId, status: 'all' });
  assert.equal(pending.length, 1, 'exactly one pending approval card was minted');
  assert.equal(pending[0].kind, 'external_send');
  assert.equal(pending[0].status, 'queued', 'queued for approval — never auto-executed');
  assert.equal(pending[0].toolName, 'run_batch');
  assert.equal((pending[0].payload as { items: unknown[] }).items.length, 3, 'the exact prepared payloads are pinned in the card');
});

test('run_batch execute atomically consumes approval: concurrent calls start one batch and retries stay inert', async () => {
  const pending = queuePendingAction({
    title: 'Concurrent approved batch',
    summary: 'prove one approved plan is consumed exactly once',
    kind: 'external_write',
    toolName: 'run_batch',
    payload: {
      tool: 'proof__write_record',
      sideEffect: 'write',
      objective: 'write one deterministic proof record',
      items: [{ id: 'proof-1', args: { value: 'once' } }],
    },
    sessionId: 'sess-batch-concurrent',
    createdBy: 'test',
  });
  markPendingActionApprovalResolved(pending.id, 'approved', null, {
    by: 'policy',
    evidence: { kind: 'policy', scope: 'test-approved-write' },
  });

  let runCount = 0;
  _setBatchPlanRunnerForTests(async (plan, sessionId) => {
    runCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return {
      batchId: 'batch-proof-once',
      sessionId,
      tool: plan.tool,
      sideEffect: plan.sideEffect,
      objective: plan.objective,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      total: 1,
      succeeded: 1,
      failed: 0,
      halted: false,
      outcomes: [{ id: 'proof-1', ok: true, attempts: 1, ms: 1 }],
    };
  });

  const handler = batchHandler();
  const invoke = () => withToolOutputContext(
    { sessionId: 'sess-batch-concurrent' },
    () => handler({ action: 'execute', pending_action_id: pending.id }),
  ) as Promise<ToolResult>;
  const results = await Promise.all(Array.from({ length: 5 }, invoke));
  const texts = results.map((result) => result.content[0].text);

  assert.equal(runCount, 1, 'exactly one batch runner crossed the dispatch boundary');
  assert.equal(texts.filter((text) => /batch-proof-once/.test(text)).length, 1, 'one caller receives the ledger');
  const losers = texts.filter((text) => !/batch-proof-once/.test(text));
  assert.equal(losers.length, 4);
  for (const text of losers) {
    assert.match(text, /execution claim|in progress|uncertain/i);
    assert.match(text, /no second batch|not be retried automatically/i);
  }
  assert.equal(getPendingAction(pending.id)?.status, 'executed');

  const retry = await invoke();
  assert.equal(runCount, 1, 'executed retry never starts the runner again');
  assert.match(retry.content[0].text, /already executed|no second batch/i);
  _setBatchPlanRunnerForTests(null);
});
