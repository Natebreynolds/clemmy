/** Actual fallback assembly, with offline reads held at their production ports. */
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-fallback-parallel-'));
Object.assign(process.env, {
  CLEMENTINE_HOME: testHome,
  CLEMMY_TEST_ISOLATED_HOME: '1',
  EMBEDDINGS_DISABLED: 'true',
  MCP_AUTO_IMPORT_ENABLED: 'false',
  OPENAI_AGENTS_DISABLE_TRACING: '1',
  CLEMMY_TURN_MEMORY_PRIMER_HYBRID_TIMEOUT_MS: '25',
  CLEMMY_BRAIN_QUERY_RECALL_TIMEOUT_MS: '25',
  CLEMMY_TURN_OPENNESS: 'off',
  CLEMMY_RECALL_SHADOW: 'off',
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('No network in fallback memory tests'); };
const loop = await import('./loop.js');
const brain = await import('./claude-agent-brain.js');
const { closeMemoryDb } = await import('../../memory/db.js');
const { rememberFact } = await import('../../memory/facts.js');
const { closeEventLog } = await import('./eventlog.js');
const { currentMemoryReadScope, withMemoryReadScope } = await import('../../memory/memory-scope.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function requireStarted(work: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The second fallback read did not start beside the first')), 1_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

const query = 'Find the quokka fallback source';
const breadcrumbs = '[ALSO IN MEMORY — people/things, places, and proven tools relevant to this message]\n- [WHERE] QUOKKA_PLACE';
const ftsHit = { filePath: '/fixture/fts.md', title: 'QUOKKA_FTS', snippet: 'FTS evidence', score: 1 };
const hybridHit = { filePath: '/fixture/hybrid.md', title: 'QUOKKA_HYBRID', snippet: 'Hybrid evidence', score: 1 };

beforeEach(() => {
  loop._setFallbackMemoryLookupsForTest({ vault: () => [ftsHit], hybridVault: async () => [hybridHit], breadcrumbs: async () => breadcrumbs });
  brain.setClaudeAgentSdkBrainSearchFactsHybridForTest(async () => []);
  brain.setClaudeAgentSdkBrainFallbackBreadcrumbsForTest(async () => breadcrumbs);
  brain.setClaudeAgentSdkBrainUnifiedPrimerForTest(async () => { throw new Error('Offline ranker failure'); });
  process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'on';
  process.env.CLEMMY_BRAIN_QUERY_RECALL = 'on';
});
afterEach(() => {
  loop._setFallbackMemoryLookupsForTest(null);
  brain.setClaudeAgentSdkBrainSearchFactsHybridForTest(null);
  brain.setClaudeAgentSdkBrainFallbackBreadcrumbsForTest(null);
  brain.setClaudeAgentSdkBrainUnifiedPrimerForTest(null);
});
after(() => {
  closeEventLog();
  closeMemoryDb();
  globalThis.fetch = originalFetch;
  rmSync(testHome, { recursive: true, force: true });
});

test('Codex starts both degraded reads before either settles and retains scope, query and output order', async () => {
  const crumbs = deferred<string>();
  const hybrid = deferred<typeof hybridHit[]>();
  const both = deferred<void>();
  const scope = { projectId: 'project-quokka', agentKey: 'agent-quokka', exact: true as const };
  const seen: string[] = [];
  const visit = (label: string, input: string) => {
    assert.equal(input, query);
    assert.deepEqual(currentMemoryReadScope(), scope);
    seen.push(label);
    if (seen.includes('breadcrumbs') && seen.includes('hybrid')) both.resolve();
  };
  loop._setFallbackMemoryLookupsForTest({
    vault: (input) => { visit('fts', input); return [ftsHit]; },
    breadcrumbs: (input) => { visit('breadcrumbs', input); return crumbs.promise; },
    hybridVault: (input) => { visit('hybrid', input); return hybrid.promise; },
  });
  const work = withMemoryReadScope(scope, () => loop._testOnly_plainFallbackPrimer(query, '', 'error', true));
  try {
    await requireStarted(both.promise);
  } finally { crumbs.resolve(breadcrumbs); hybrid.resolve([hybridHit]); }
  const result = await work;
  assert.equal(result.source, 'hybrid');
  assert.match(result.text ?? '', /QUOKKA_HYBRID/);
  assert.doesNotMatch(result.text ?? '', /QUOKKA_FTS/);
  assert.equal((result.text ?? '').split('QUOKKA_PLACE').length - 1, 1);
  assert.ok(result.text!.indexOf('QUOKKA_HYBRID') < result.text!.indexOf('QUOKKA_PLACE'));
  assert.equal(result.skippedReason, 'unified_error_fallback');
});

test('Codex handles an early hybrid rejection while breadcrumbs are pending and retains FTS evidence', async () => {
  const crumbs = deferred<string>();
  const hybridStarted = deferred<void>();
  loop._setFallbackMemoryLookupsForTest({ vault: () => [ftsHit], breadcrumbs: () => crumbs.promise,
    hybridVault: async () => { hybridStarted.resolve(); throw new Error('Hybrid rejected'); } });
  const work = loop._testOnly_plainFallbackPrimer(query, '', 'timeout', true);
  try {
    await requireStarted(hybridStarted.promise);
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally { crumbs.resolve(breadcrumbs); }
  const result = await work;
  assert.equal(result.source, 'fts5_hybrid_error');
  assert.match(result.text ?? '', /QUOKKA_FTS/);
  assert.match(result.text ?? '', /QUOKKA_PLACE/);
  assert.equal(result.skippedReason, 'unified_timeout_hybrid_error');
});

test('Codex retains hybrid evidence when breadcrumbs fail', async () => {
  loop._setFallbackMemoryLookupsForTest({ vault: () => [ftsHit], hybridVault: async () => [hybridHit],
    breadcrumbs: async () => { throw new Error('Breadcrumbs rejected'); } });
  const result = await loop._testOnly_plainFallbackPrimer(query, '', 'error', true);
  assert.equal(result.source, 'hybrid');
  assert.match(result.text ?? '', /QUOKKA_HYBRID/);
  assert.doesNotMatch(result.text ?? '', /QUOKKA_PLACE/);
});

test('Codex hybrid timeout retains FTS plus breadcrumbs with the original degraded label', async () => {
  loop._setFallbackMemoryLookupsForTest({ vault: () => [ftsHit], breadcrumbs: async () => breadcrumbs,
    hybridVault: async () => await new Promise(() => {}) });
  const result = await loop._testOnly_plainFallbackPrimer(query, '', 'timeout', true);
  assert.equal(result.source, 'fts5_hybrid_timeout');
  assert.equal(result.skippedReason, 'unified_timeout_hybrid_timeout');
  assert.match(result.text ?? '', /QUOKKA_FTS/);
  assert.match(result.text ?? '', /QUOKKA_PLACE/);
});

test('Codex disabled hybrid starts no asynchronous vault lookup and preserves disabled-ranker labels', async () => {
  let hybridCalls = 0;
  loop._setFallbackMemoryLookupsForTest({ vault: () => [ftsHit], breadcrumbs: async () => breadcrumbs,
    hybridVault: async () => { hybridCalls++; return []; } });
  const result = await loop._testOnly_plainFallbackPrimer(query, '', 'disabled', false);
  assert.equal(hybridCalls, 0);
  assert.equal(result.source, 'fts5');
  assert.equal(result.skippedReason, undefined);
  assert.match(result.text ?? '', /QUOKKA_FTS/);
});

test('Codex clears the hybrid timer after a fast result', async () => {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const pending = new Set<ReturnType<typeof setTimeout>>();
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    let handle: ReturnType<typeof setTimeout>;
    handle = nativeSetTimeout(() => { pending.delete(handle); fn(...args); }, delay);
    pending.add(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    pending.delete(handle); nativeClearTimeout(handle);
  }) as typeof clearTimeout;
  try {
    await loop._testOnly_plainFallbackPrimer(query, '', 'error', true);
    assert.equal(pending.size, 0, 'The completed lookup retains no timeout handle');
  } finally {
    for (const handle of pending) nativeClearTimeout(handle);
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
  }
});

test('Claude starts degraded breadcrumbs beside fact recall and keeps the assembled text and scope', async () => {
  const crumbs = deferred<string>();
  const facts = deferred<Awaited<ReturnType<typeof import('../../memory/facts.js').searchFactsHybrid>>>();
  const both = deferred<void>();
  const scope = { projectId: 'project-claude', agentKey: 'agent-claude', exact: true as const };
  const fact = withMemoryReadScope(scope, () => rememberFact({ kind: 'project', content: 'QUOKKA_FACT preserves the exact original words.' }));
  const seen = new Set<string>();
  const visit = (label: string, input: string) => {
    assert.equal(input, query);
    assert.deepEqual(currentMemoryReadScope(), scope);
    seen.add(label);
    if (seen.size === 2) both.resolve();
  };
  brain.setClaudeAgentSdkBrainSearchFactsHybridForTest((input) => { visit('facts', input); return facts.promise; });
  brain.setClaudeAgentSdkBrainFallbackBreadcrumbsForTest((input) => { visit('breadcrumbs', input); return crumbs.promise; });
  const work = withMemoryReadScope(scope, () => brain.renderClaudeAgentBrainTurnContext({ sessionId: '', message: query }));
  try { await requireStarted(both.promise); }
  finally { facts.resolve([fact]); crumbs.resolve(breadcrumbs); }
  const text = await work;
  assert.equal(text.split('QUOKKA_FACT preserves the exact original words.').length - 1, 1);
  assert.equal(text.split('QUOKKA_PLACE').length - 1, 1);
  assert.ok(text.indexOf('QUOKKA_FACT') < text.indexOf('QUOKKA_PLACE'));
});

test('Claude retains already-started breadcrumbs after an early fact fallback rejection', async () => {
  let crumbCalls = 0;
  brain.setClaudeAgentSdkBrainSearchFactsHybridForTest(async () => { throw new Error('Facts rejected'); });
  brain.setClaudeAgentSdkBrainFallbackBreadcrumbsForTest(async () => { crumbCalls++; return breadcrumbs; });
  const text = await brain.renderClaudeAgentBrainTurnContext({ sessionId: '', message: query });
  assert.equal(crumbCalls, 1, 'A degraded retry shares its started breadcrumb read');
  assert.match(text, /QUOKKA_PLACE/);
});

test('Claude retains fact evidence and its recall attribution when breadcrumbs fail', async () => {
  const fact = rememberFact({ kind: 'project', content: 'QUOKKA_FACT_ONLY preserves exact fallback evidence.' });
  brain.setClaudeAgentSdkBrainSearchFactsHybridForTest(async () => [fact]);
  brain.setClaudeAgentSdkBrainFallbackBreadcrumbsForTest(async () => { throw new Error('Breadcrumbs rejected'); });
  const text = await brain.renderClaudeAgentBrainTurnContext({ sessionId: 'fallback-fact-attribution', message: query });
  assert.match(text, /QUOKKA_FACT_ONLY preserves exact fallback evidence/);
  assert.doesNotMatch(text, /QUOKKA_PLACE/);
  const { openMemoryDb } = await import('../../memory/db.js');
  const row = openMemoryDb().prepare(`SELECT candidate_refs_json FROM memory_recall_runs
    WHERE session_id = ? AND surface = 'claude_primer_fallback' ORDER BY created_at DESC LIMIT 1`)
    .get('fallback-fact-attribution') as { candidate_refs_json: string };
  assert.deepEqual(JSON.parse(row.candidate_refs_json), [{ type: 'fact', id: String(fact.id), snippet: fact.content }]);
});

for (const status of ['ok', 'empty'] as const) {
  test(`Claude starts no fallback when unified recall is ${status}`, async () => {
    let fallbackCalls = 0;
    const fact = rememberFact({ kind: 'project', content: 'QUOKKA_UNIFIED is exact evidence.' });
    brain.setClaudeAgentSdkBrainUnifiedPrimerForTest(async (objective) => ({ objective, perStore: {},
      answerability: status === 'ok' ? 'supported' : 'insufficient',
      hits: status === 'ok' ? [{ type: 'fact', ref: String(fact.id), title: 'Unified', snippet: fact.content, score: 1 }] : [] }));
    brain.setClaudeAgentSdkBrainSearchFactsHybridForTest(async () => { fallbackCalls++; return []; });
    brain.setClaudeAgentSdkBrainFallbackBreadcrumbsForTest(async () => { fallbackCalls++; return breadcrumbs; });
    const text = await brain.renderClaudeAgentBrainTurnContext({ sessionId: '', message: query });
    assert.equal(fallbackCalls, 0);
    assert.doesNotMatch(text, /QUOKKA_PLACE/);
    if (status === 'ok') assert.match(text, /QUOKKA_UNIFIED/);
  });
}

test('Claude starts no fallback for request-local memory opt-out or an exact declined continuation', async () => {
  let reads = 0;
  brain.setClaudeAgentSdkBrainUnifiedPrimerForTest(async () => { reads++; throw new Error('Must not run'); });
  brain.setClaudeAgentSdkBrainSearchFactsHybridForTest(async () => { reads++; return []; });
  brain.setClaudeAgentSdkBrainFallbackBreadcrumbsForTest(async () => { reads++; return breadcrumbs; });
  await brain.renderClaudeAgentBrainTurnContext({ sessionId: '', message: 'Do not use memory. Answer only from this request.' });
  await brain.renderClaudeAgentBrainTurnContext({ sessionId: '', message: 'No', taskContinuation: {
    packetId: 'declined-packet', parentSourceUserSeq: 1, consumingSourceUserSeq: 2,
    parentInput: query, question: 'Should I continue?', options: ['Yes', 'No'], answer: 'No',
    disposition: 'declined', retrievalQuery: query, capabilities: [],
  } });
  assert.equal(reads, 0);
});
