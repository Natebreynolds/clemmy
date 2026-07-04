/**
 * Run: npx tsx --test src/tools/memory-tools.test.ts
 *
 * Covers the standing-instruction protection policy for the DIRECT memory
 * tools (reviewForgetRequest) — the pure decision behind memory_forget's
 * pinned/constraint refusals. The notification side is a straight
 * addNotification wrapper, covered by the notifications store tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-memory-tools-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { reviewForgetRequest, registerMemoryTools } = await import('./memory-tools.js');
const { LOCAL_MCP_TOOL_NAMES } = await import('./catalog.js');
const { resetMemoryDb } = await import('../memory/db.js');
const { rememberFact, getFact } = await import('../memory/facts.js');
const { appendFactRecallTrace } = await import('../memory/recall-trace.js');
const { listProposedMemoryFixes } = await import('../memory/self-heal.js');
const { loadFactEmbeddings, _setEmbeddingProviderForTest } = await import('../memory/embeddings.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test.beforeEach(() => {
  resetMemoryDb();
  _setEmbeddingProviderForTest(undefined);
  rmSync(path.join(TMP_HOME, 'state', 'memory-self-heal'), { recursive: true, force: true });
  rmSync(path.join(TMP_HOME, 'state', 'memory-recall-trace.jsonl'), { force: true });
});

const fact = (over: Partial<{ id: number; kind: string; pinned: boolean; content: string }>) => ({
  id: 42,
  kind: 'user',
  pinned: false,
  content: 'Some fact.',
  ...over,
}) as Parameters<typeof reviewForgetRequest>[0];

test('reviewForgetRequest: a plain unpinned fact can be forgotten (soft or hard)', () => {
  assert.equal(reviewForgetRequest(fact({}), false).allow, true);
  assert.equal(reviewForgetRequest(fact({}), true).allow, true);
});

test('reviewForgetRequest: a PINNED fact is refused — unpin first', () => {
  const r = reviewForgetRequest(fact({ pinned: true }), false);
  assert.equal(r.allow, false);
  assert.match(r.reason ?? '', /PINNED standing instruction/);
  assert.match(r.reason ?? '', /memory_pin/);
});

test('reviewForgetRequest: a pinned CONSTRAINT is refused even for soft delete', () => {
  const r = reviewForgetRequest(fact({ kind: 'constraint', pinned: true }), false);
  assert.equal(r.allow, false);
});

test('reviewForgetRequest: hard-deleting an unpinned constraint is refused; soft is allowed', () => {
  const hard = reviewForgetRequest(fact({ kind: 'constraint', pinned: false }), true);
  assert.equal(hard.allow, false);
  assert.match(hard.reason ?? '', /recoverable/);
  const soft = reviewForgetRequest(fact({ kind: 'constraint', pinned: false }), false);
  assert.equal(soft.allow, true);
});

test('memory_self_heal is exposed in the local MCP catalog', () => {
  assert.ok(LOCAL_MCP_TOOL_NAMES.includes('memory_self_heal'));
});

function registeredToolHandlers(): Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>> {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>>();
  const server = {
    tool(name: string, ...args: unknown[]) {
      const handler = args.at(-1);
      if (typeof handler !== 'function') throw new Error(`tool ${name} missing handler`);
      handlers.set(name, handler as (input: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>);
    },
  };
  registerMemoryTools(server as never);
  return handlers;
}

test('memory_self_heal tool lists, applies, and reverts audited memory fixes', async () => {
  const overexposed = rememberFact({
    kind: 'project',
    content: 'Temporary browser inspection state should not keep winning global memory context.',
    importance: 5,
    trustLevel: 0.6,
    derivedFrom: { tool: 'browser_read', sessionId: 'sess-self-heal-tool' },
  });
  for (let i = 0; i < 8; i += 1) {
    appendFactRecallTrace({
      surface: 'facts_for_instructions',
      facts: [{ fact: overexposed, reason: 'scored-stanford-global' }],
      nowIso: `2026-07-04T12:00:0${i}.000Z`,
    });
  }

  const handler = registeredToolHandlers().get('memory_self_heal');
  assert.ok(handler, 'memory_self_heal should be registered');

  const listed = await handler!({ action: 'list', maxCandidates: 10 });
  assert.match(listed.content[0].text, /demote_overexposed_fact/);
  assert.match(listed.content[0].text, new RegExp(`#${overexposed.id}\\b|ids=${overexposed.id}\\b`));
  assert.equal(listProposedMemoryFixes().length, 0, 'list must not persist proposal records');
  assert.equal(getFact(overexposed.id)?.importance, 5);

  const dry = await handler!({ action: 'dry_run', maxApply: 1, maxCandidates: 10 });
  assert.match(dry.content[0].text, /dry run/);
  assert.match(dry.content[0].text, /applied 1/);
  assert.equal(listProposedMemoryFixes().length, 0, 'dry_run must not persist proposal records');
  assert.equal(getFact(overexposed.id)?.importance, 5);

  const run = await handler!({ action: 'run', maxApply: 1, maxCandidates: 10 });
  const runText = run.content[0].text;
  assert.match(runText, /applied 1/);
  assert.equal(getFact(overexposed.id)?.importance, 4);
  const auditId = runText.match(/audit=(mh-[a-f0-9]+)/)?.[1];
  assert.ok(auditId, 'run output should include the reversible heal audit id');

  const reverted = await handler!({ action: 'revert', auditId });
  assert.match(reverted.content[0].text, /Reverted/);
  assert.equal(getFact(overexposed.id)?.importance, 5);
});

test('memory_embed_backfill can backfill durable fact embeddings', async () => {
  _setEmbeddingProviderForTest({
    name: 'test',
    model: 'test-model',
    dim: 4,
    async embed(texts) {
      return texts.map((text) => Float32Array.from([text.length || 1, 0, 0, 0]));
    },
  });
  try {
    const fact = rememberFact({ kind: 'user', content: 'Nathan prefers semantic memory checks before recall changes.' });
    const handler = registeredToolHandlers().get('memory_embed_backfill');
    assert.ok(handler, 'memory_embed_backfill should be registered');

    const result = await handler!({ scope: 'facts', maxChunks: 5 });
    assert.match(result.content[0].text, /Facts: embedded 1 \/ 1 candidates/);
    assert.match(result.content[0].text, /Fact total embeddings: 1 \(test-model, dim 4\)/);
    assert.equal(loadFactEmbeddings([fact.id]).size, 1);
  } finally {
    _setEmbeddingProviderForTest(undefined);
  }
});
