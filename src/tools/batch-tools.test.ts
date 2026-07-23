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

const { registerBatchTools } = await import('./batch-tools.js');
const { _setCertifyJudgeForTests } = await import('../execution/batch-runner.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { listPendingActions } = await import('../runtime/harness/pending-actions.js');

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
