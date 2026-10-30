/** Real fact-store reads with synthetic embedding producers; no models/network. */
import { after, afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const priorHome = process.env.CLEMENTINE_HOME;
const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-fact-producing-space-'));
process.env.CLEMENTINE_HOME = fixtureHome;
const priorSemantic = process.env.CLEMMY_SEMANTIC_RECALL;
process.env.CLEMMY_SEMANTIC_RECALL = 'on';

const { closeMemoryDb, openMemoryDb, resetMemoryDb } = await import('./db.js');
const {
  clearTurnQueryVector, findSimilarFactsScored, deleteFact, listActiveFacts,
  markFactSupersededBy, primeTurnRecallVector, reactivateFact, rememberFact,
  searchArchivedFactsScored, setTurnQueryVector, updateFact, withTurnQueryVectorScope,
} = await import('./facts.js');
const {
  _resetEmbedDemotionForTest, _resetEmbeddingHealthForTest, _resetLocalProviderForTest,
  _setEmbeddingProviderForTest, _setLocalProviderForTest, vectorToBuffer,
} = await import('./embeddings.js');
const { stampMemoryScope, withMemoryReadScope } = await import('./memory-scope.js');
type EmbeddingProvider = import('./embeddings.js').EmbeddingProvider;

beforeEach(() => {
  resetMemoryDb();
  _resetEmbeddingHealthForTest();
  _resetEmbedDemotionForTest();
  _setEmbeddingProviderForTest(null);
  clearTurnQueryVector();
  openMemoryDb();
});
afterEach(() => {
  clearTurnQueryVector();
  _setEmbeddingProviderForTest(undefined);
  _resetLocalProviderForTest();
  _resetEmbeddingHealthForTest();
  _resetEmbedDemotionForTest();
});
after(() => {
  closeMemoryDb();
  rmSync(fixtureHome, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = priorHome;
  if (priorSemantic === undefined) delete process.env.CLEMMY_SEMANTIC_RECALL;
  else process.env.CLEMMY_SEMANTIC_RECALL = priorSemantic;
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function producer(name: string, model: string, axis: 0 | 1, before?: (text: string) => Promise<void>) {
  const calls: string[][] = [];
  const provider: EmbeddingProvider = {
    name, model, dim: 2,
    async embed(texts) {
      calls.push([...texts]);
      for (const text of texts) await before?.(text);
      return texts.map(() => Float32Array.from(axis === 0 ? [1, 0] : [0, 1]));
    },
  };
  return { provider, calls };
}

function fact(content: string, model: string, vector: number[], importance = 5) {
  const record = rememberFact({ kind: 'project', content, importance });
  storeVector(record.id, model, vector);
  return record;
}

function storeVector(id: number, model: string, vector: number[]) {
  const db = openMemoryDb();
  const hash = (db.prepare('SELECT content_hash FROM consolidated_facts WHERE id = ?').get(id) as { content_hash: string }).content_hash;
  db.prepare(`INSERT OR REPLACE INTO fact_embeddings (fact_id, model, dim, vector, content_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, model, vector.length, vectorToBuffer(Float32Array.from(vector)), hash, new Date().toISOString());
}

test('no stored selected-space vectors skips the query producer entirely', async () => {
  const selected = producer('fixture-empty', 'selected', 0);
  _setEmbeddingProviderForTest(selected.provider);
  rememberFact({ kind: 'project', content: 'Amber receipt belongs in the ledger.' });
  const results = await findSimilarFactsScored('Amber receipt');
  assert.equal(results[0]?.sim, null);
  assert.equal(selected.calls.length, 0);
  assert.deepEqual(await searchArchivedFactsScored('Amber receipt'), []);
  assert.equal(selected.calls.length, 0);
});

for (const archived of [false, true]) {
  test(`${archived ? 'archived' : 'active'} same-call rescue reloads facts in the actual producer space`, async () => {
    const remote = producer('openai', 'remote-fixture', 0, async () => { throw new Error('synthetic network timeout'); });
    const local = producer('local', 'rescue-fixture', 1);
    _setLocalProviderForTest(local.provider);
    _setEmbeddingProviderForTest(remote.provider);
    const remoteFact = fact('Amber receipt belongs in the ledger.', remote.provider.model, [0, 1]);
    const localFact = fact('Indigo parcel belongs on the shelf.', local.provider.model, [0, 1]);
    if (archived) { deleteFact(remoteFact.id); deleteFact(localFact.id); }
    const results = archived
      ? await searchArchivedFactsScored('synthetic paraphrase')
      : await findSimilarFactsScored('synthetic paraphrase');
    assert.deepEqual(results.map((item) => item.fact.id), [localFact.id]);
    assert.equal(results[0].sim, 1);
    assert.equal(remote.calls.length, 1);
    assert.equal(local.calls.length, 1);
  });
}

test('rescue without stored vectors in its own space retains lexical fallback with unknown similarity', async () => {
  const remote = producer('openai', 'remote-fixture', 0, async () => { throw new Error('synthetic network timeout'); });
  const local = producer('local', 'rescue-fixture', 1);
  _setLocalProviderForTest(local.provider);
  _setEmbeddingProviderForTest(remote.provider);
  const record = fact('Amber receipt belongs in the ledger.', remote.provider.model, [0, 1]);
  const active = await findSimilarFactsScored('Amber receipt');
  assert.deepEqual(active.map((item) => [item.fact.id, item.sim]), [[record.id, null]]);
  deleteFact(record.id);
  const archived = await searchArchivedFactsScored('Amber receipt');
  assert.deepEqual(archived.map((item) => [item.fact.id, item.sim]), [[record.id, null]]);
});

test('provider switch during a query cannot reuse a same-dimension stale fact pool', async () => {
  const started = deferred();
  const release = deferred();
  const original = producer('fixture-first', 'space-a', 0, async () => { started.resolve(); await release.promise; });
  const next = producer('fixture-second', 'space-b', 1);
  _setEmbeddingProviderForTest(original.provider);
  fact('Amber receipt belongs in the ledger.', original.provider.model, [1, 0]);
  const pending = findSimilarFactsScored('synthetic paraphrase');
  await started.promise;
  _setEmbeddingProviderForTest(next.provider);
  release.resolve();
  assert.deepEqual(await pending, [], 'selection change degrades to the ordinary lexical path');
  assert.equal(next.calls.length, 0, 'the old read does not start a replacement embedding');
});

test('content correction while awaiting discards stale hashes and finds newly embedded current facts', async () => {
  const started = deferred();
  const release = deferred();
  const selected = producer('fixture-correction', 'space-a', 0, async () => { started.resolve(); await release.promise; });
  _setEmbeddingProviderForTest(selected.provider);
  const previous = fact('Amber receipt belongs in the ledger.', selected.provider.model, [1, 0]);
  const pending = findSimilarFactsScored('synthetic paraphrase', { topK: 1 });
  await started.promise;
  updateFact(previous.id, { content: 'Amber receipt was corrected to a different destination.' });
  const current = fact('Indigo parcel is the current assertion.', selected.provider.model, [1, 0]);
  release.resolve();
  const results = await pending;
  assert.deepEqual(results.map((item) => item.fact.id), [current.id]);
  assert.equal(results[0].sim, 1);
});

test('scope visibility is rechecked after awaiting the query', async () => {
  const started = deferred();
  const release = deferred();
  const selected = producer('fixture-scope', 'space-a', 0, async () => { started.resolve(); await release.promise; });
  _setEmbeddingProviderForTest(selected.provider);
  const record = fact('Amber receipt belongs in the ledger.', selected.provider.model, [1, 0]);
  stampMemoryScope('fact', record.id, { projectId: 'project-a', agentKey: null });
  const pending = withMemoryReadScope({ projectId: 'project-a', agentKey: null }, () => findSimilarFactsScored('synthetic paraphrase'));
  await started.promise;
  stampMemoryScope('fact', record.id, { projectId: 'project-b', agentKey: null });
  release.resolve();
  assert.deepEqual(await pending, [], 'a fact moved to a foreign project cannot cross the await');
});

test('an archived fact superseded during the await cannot resurface', async () => {
  const started = deferred();
  const release = deferred();
  const selected = producer('fixture-archive', 'space-a', 0, async () => { started.resolve(); await release.promise; });
  _setEmbeddingProviderForTest(selected.provider);
  const previous = fact('Amber receipt belongs in the ledger.', selected.provider.model, [1, 0]);
  const current = rememberFact({ kind: 'project', content: 'Indigo parcel is the current assertion.' });
  deleteFact(previous.id);
  const pending = searchArchivedFactsScored('synthetic paraphrase');
  await started.promise;
  assert.equal(reactivateFact(previous.id), true);
  assert.equal(markFactSupersededBy(previous.id, current.id), true);
  release.resolve();
  assert.deepEqual(await pending, []);
});

test('historical validity intervals are reloaded after the query await', async () => {
  const started = deferred();
  const release = deferred();
  const selected = producer('fixture-historical', 'space-a', 0, async () => { started.resolve(); await release.promise; });
  _setEmbeddingProviderForTest(selected.provider);
  const previous = fact('Amber receipt belongs in the ledger.', selected.provider.model, [1, 0]);
  const boundary = new Date(Date.now() + 1_000).toISOString();
  const asOf = new Date(Date.now() + 2_000).toISOString();
  const pending = findSimilarFactsScored('synthetic paraphrase', { asOf, topK: 1 });
  await started.promise;
  const current = fact('Indigo parcel is the current assertion.', selected.provider.model, [1, 0]);
  assert.equal(markFactSupersededBy(previous.id, current.id, { validTo: boundary }), true);
  release.resolve();
  assert.deepEqual((await pending).map((item) => item.fact.id), [current.id]);
});

function rankingPair(model: string) {
  const low = fact('Amber receipt belongs in the ledger.', model, [1, 0], 3);
  const high = fact('Indigo parcel belongs on the shelf.', model, [0, 1], 8);
  return { low, high, top: () => listActiveFacts({ ranking: 'stanford', limit: 1 })[0]?.id };
}

test('per-turn vector is rejected after a same-dimension space switch', () => {
  const first = producer('fixture-turn', 'space-a', 0);
  _setEmbeddingProviderForTest(first.provider);
  const pair = rankingPair(first.provider.model);
  assert.equal(pair.top(), pair.high.id);
  setTurnQueryVector('synthetic paraphrase', Float32Array.from([1, 0]));
  assert.equal(pair.top(), pair.low.id);
  const next = producer('fixture-turn', 'space-b', 0);
  _setEmbeddingProviderForTest(next.provider);
  storeVector(pair.low.id, next.provider.model, [1, 0]);
  storeVector(pair.high.id, next.provider.model, [0, 1]);
  assert.equal(pair.top(), pair.high.id, 'the old vector cannot promote a fact in the new space');
});

test('per-turn priming keeps the rescued query actual space for synchronous fact loading', async () => {
  const remote = producer('openai', 'remote-turn', 0, async () => { throw new Error('synthetic network timeout'); });
  const local = producer('local', 'rescue-turn', 0);
  _setLocalProviderForTest(local.provider);
  _setEmbeddingProviderForTest(remote.provider);
  const rescued = fact('Amber receipt belongs in the ledger.', local.provider.model, [1, 0], 3);
  const preferred = fact('Indigo parcel belongs on the shelf.', remote.provider.model, [0, 1], 8);
  assert.equal(listActiveFacts({ ranking: 'stanford', limit: 1 })[0]?.id, preferred.id);
  await primeTurnRecallVector('synthetic rescue primer');
  assert.equal(listActiveFacts({ ranking: 'stanford', limit: 1 })[0]?.id, rescued.id);
  assert.equal(remote.calls.length, 1);
  assert.equal(local.calls.length, 1);
});

test('older prime cannot overwrite a newer prime within the same async turn scope', async () => {
  const started = deferred();
  const release = deferred();
  const selected = producer('fixture-prime-order', 'space-a', 0, async (text) => {
    if (text === 'older primer') { started.resolve(); await release.promise; }
  });
  // The newer query chooses the other axis; the provider identity is unchanged.
  const originalEmbed = selected.provider.embed;
  selected.provider.embed = async (texts) => {
    const vectors = await originalEmbed(texts);
    return texts.map((text, index) => text === 'newer primer' ? Float32Array.from([0, 1]) : vectors[index]);
  };
  _setEmbeddingProviderForTest(selected.provider);
  const pair = rankingPair(selected.provider.model);
  await withTurnQueryVectorScope(async () => {
    const older = primeTurnRecallVector('older primer');
    await started.promise;
    await primeTurnRecallVector('newer primer');
    assert.equal(pair.top(), pair.high.id);
    release.resolve();
    await older;
    assert.equal(pair.top(), pair.high.id, 'late older query cannot replace the newer turn intent');
  });
});

test('explicit clear during a prime prevents late vector re-admission', async () => {
  const started = deferred();
  const release = deferred();
  const selected = producer('fixture-prime-clear', 'space-a', 0, async () => { started.resolve(); await release.promise; });
  _setEmbeddingProviderForTest(selected.provider);
  const pair = rankingPair(selected.provider.model);
  const pending = primeTurnRecallVector('pending primer');
  await started.promise;
  clearTurnQueryVector();
  release.resolve();
  await pending;
  assert.equal(pair.top(), pair.high.id);
});

test('default turn-prime deadline returns before a held provider and does not publish its late result', async () => {
  const started = deferred();
  const release = deferred();
  const selected = producer('fixture-prime-budget', 'space-a', 0, async () => { started.resolve(); await release.promise; });
  _setEmbeddingProviderForTest(selected.provider);
  const pair = rankingPair(selected.provider.model);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = primeTurnRecallVector('bounded primer');
    await started.promise;
    const ended = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2_000); }),
    ]);
    assert.equal(ended, true, 'the default 900ms deadline ends the primer while provider work is still held');
    assert.equal(pair.top(), pair.high.id);
    release.resolve();
    await pending;
    await Promise.resolve();
    assert.equal(pair.top(), pair.high.id, 'provider completion after the deadline cannot fill the turn slot');
  } finally {
    release.resolve();
    if (timer) clearTimeout(timer);
  }
});

test('caller deadline suppresses expired active and archived query work without a cosine claim', async () => {
  const selected = producer('fixture-expired', 'space-a', 0);
  _setEmbeddingProviderForTest(selected.provider);
  const record = fact('Amber receipt belongs in the ledger.', selected.provider.model, [1, 0]);
  const active = await findSimilarFactsScored('Amber receipt', { deadlineAtMs: Date.now() - 1 });
  assert.deepEqual(active.map((item) => [item.fact.id, item.sim]), [[record.id, null]]);
  deleteFact(record.id);
  const archived = await searchArchivedFactsScored('Amber receipt', { deadlineAtMs: Date.now() - 1 });
  assert.deepEqual(archived.map((item) => [item.fact.id, item.sim]), [[record.id, null]]);
  assert.equal(selected.calls.length, 0);
});
