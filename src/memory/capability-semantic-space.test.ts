/** Local-only capability provenance and stale-await controls; no models/network. */
import { after, afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const priorHome = process.env.CLEMENTINE_HOME;
const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-capability-producing-space-'));
process.env.CLEMENTINE_HOME = fixtureHome;
const {
  _resetCapabilityIndexForTest, capabilityIndexDatabase, deactivateCapabilityCarrier,
  recordCapabilityOperations, searchCapabilityOperations,
} = await import('./capability-index.js');
const {
  _setCapabilityEmbedderForTest, embedMissingCapabilityOperations,
  retrieveCapabilityOperations, semanticCapabilityCandidates,
} = await import('./capability-semantic-index.js');
const {
  _resetLocalProviderForTest, _setEmbeddingProviderForTest, _setLocalProviderForTest,
  localEmbeddingSpaceKey, vectorToBuffer,
} = await import('./embeddings.js');
type EmbeddingProvider = import('./embeddings.js').EmbeddingProvider;
type Operation = import('./capability-index.js').CapabilityOperationRow;

beforeEach(() => {
  _setCapabilityEmbedderForTest();
  _setEmbeddingProviderForTest(null);
  _setLocalProviderForTest(null);
  capabilityIndexDatabase().exec('DELETE FROM capability_embeddings; DELETE FROM capability_operations;');
});
afterEach(() => {
  _setCapabilityEmbedderForTest();
  _setEmbeddingProviderForTest(undefined);
  _resetLocalProviderForTest();
});
after(() => {
  _resetCapabilityIndexForTest();
  rmSync(fixtureHome, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = priorHome;
});

const operation: Operation = {
  identifier: 'fixture__lookup', carrierKind: 'mcp', carrier: 'fixture',
  displayName: 'Local lookup', description: 'Find controlled synthetic records.',
  effectClass: 'read', effectProvenance: 'declared', accountIdentity: 'fixture-account-a',
};
function seed(changes: Partial<Operation> = {}) {
  const row = { ...operation, ...changes };
  recordCapabilityOperations([row]);
  return row;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function localProvider(model = 'fixture-local', before?: (texts: string[]) => Promise<void>) {
  const calls: Array<{ texts: string[]; options: Parameters<EmbeddingProvider['embed']>[1] }> = [];
  const provider: EmbeddingProvider = {
    name: 'local', model, dim: 2,
    async embed(texts, options) {
      calls.push({ texts: [...texts], options });
      await before?.(texts);
      return texts.map(() => Float32Array.from([1, 0]));
    },
  };
  return { provider, calls, space: `local:${model}:2` };
}
function stored() {
  return capabilityIndexDatabase().prepare('SELECT identifier, account_identity, model, dim, content_hash FROM capability_embeddings ORDER BY identifier, account_identity')
    .all() as Array<{ identifier: string; account_identity: string; model: string; dim: number; content_hash: string }>;
}

test('configured remote provider cannot produce a local-labeled row or a cold request-path query', async () => {
  seed();
  let remoteCalls = 0;
  _setEmbeddingProviderForTest({
    name: 'openai', model: 'remote-fixture', dim: 384,
    async embed(texts) { remoteCalls++; return texts.map(() => Float32Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0)); },
  });
  const backfill = await embedMissingCapabilityOperations();
  assert.equal(backfill.embedded, 0);
  assert.deepEqual(stored(), []);
  // A historical row bearing the declared cold BGE key still cannot cause a
  // generic remote query when no local model is warm.
  const key = localEmbeddingSpaceKey();
  const text = `${operation.carrier} ${operation.displayName}. ${operation.description}`;
  const vector = Float32Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0);
  capabilityIndexDatabase().prepare(`INSERT INTO capability_embeddings
    (identifier, account_identity, model, dim, vector, content_hash, created_at) VALUES (?, ?, ?, 384, ?, ?, ?)`)
    .run(operation.identifier, operation.accountIdentity, key, vectorToBuffer(vector), createHash('sha256').update(`${key}\n${text}`).digest('hex'), new Date().toISOString());
  assert.deepEqual(await semanticCapabilityCandidates('paraphrased request'), []);
  const lexical = searchCapabilityOperations('lookup');
  assert.deepEqual(await retrieveCapabilityOperations('lookup'), lexical.map((row) => row));
  assert.equal(remoteCalls, 0, 'neither background nor query work uses the configured remote provider');
});

test('warm local producer supplies its actual key and receives foreground/background budgets', async () => {
  seed();
  const local = localProvider();
  _setLocalProviderForTest(local.provider);
  let remoteCalls = 0;
  _setEmbeddingProviderForTest({ name: 'openai', model: 'remote-fixture', dim: 2, async embed() { remoteCalls++; return []; } });
  const before = Date.now();
  assert.equal((await embedMissingCapabilityOperations()).embedded, 1);
  assert.equal(stored()[0].model, local.space);
  assert.equal(local.calls[0].options?.priority, 'background');
  assert.ok((local.calls[0].options?.deadlineAtMs ?? 0) >= before + 59_000);
  assert.equal((await semanticCapabilityCandidates('paraphrased request'))[0]?.account, operation.accountIdentity);
  assert.equal(local.calls[1].options?.priority, 'foreground');
  assert.ok((local.calls[1].options?.deadlineAtMs ?? 0) <= Date.now() + 900);
  assert.equal(remoteCalls, 0);
});

test('global provider opt-out prevents even warm local capability work', async () => {
  seed();
  const local = localProvider();
  _setLocalProviderForTest(local.provider);
  await embedMissingCapabilityOperations();
  const previous = process.env.CLEMMY_EMBED_PROVIDER;
  process.env.CLEMMY_EMBED_PROVIDER = 'off';
  try {
    const calls = local.calls.length;
    seed({ identifier: 'fixture__second' });
    assert.equal((await embedMissingCapabilityOperations()).embedded, 0);
    assert.deepEqual(await semanticCapabilityCandidates('paraphrased request'), []);
    assert.equal(stored().length, 1, 'no row is written while all embeddings are off');
    assert.equal(local.calls.length, calls, 'off also suppresses a model that was already warm');
    assert.ok((await retrieveCapabilityOperations('lookup')).length > 0, 'ordinary lexical capabilities remain reachable');
  } finally {
    if (previous === undefined) delete process.env.CLEMMY_EMBED_PROVIDER;
    else process.env.CLEMMY_EMBED_PROVIDER = previous;
  }
});

test('local provider hot swap during background work cannot relabel the old vectors', async () => {
  seed();
  const started = deferred(); const release = deferred();
  const first = localProvider('space-a', async () => { started.resolve(); await release.promise; });
  const next = localProvider('space-b');
  _setLocalProviderForTest(first.provider);
  const pending = embedMissingCapabilityOperations();
  await started.promise;
  _setLocalProviderForTest(next.provider);
  release.resolve();
  assert.equal((await pending).embedded, 0);
  assert.deepEqual(stored(), []);
  assert.equal((await embedMissingCapabilityOperations()).embedded, 1);
  assert.equal(stored()[0].model, next.space);
});

test('local provider hot swap during a query yields lexical fallback', async () => {
  seed();
  const started = deferred(); const release = deferred();
  const first = localProvider('space-a', async (texts) => {
    if (texts[0] === 'held query') { started.resolve(); await release.promise; }
  });
  _setLocalProviderForTest(first.provider);
  await embedMissingCapabilityOperations();
  const pending = semanticCapabilityCandidates('held query');
  await started.promise;
  _setLocalProviderForTest(localProvider('space-b').provider);
  release.resolve();
  assert.deepEqual(await pending, []);
});

test('replacing the embedder while awaiting, even with the same key, cannot admit old rows', async () => {
  seed();
  const started = deferred(); const release = deferred();
  _setCapabilityEmbedderForTest({
    spaceKey: () => 'fixture:same-space:2', embedOne: async () => Float32Array.from([1, 0]),
    async embedMany(texts) { started.resolve(); await release.promise; return texts.map(() => Float32Array.from([1, 0])); },
  });
  const pending = embedMissingCapabilityOperations();
  await started.promise;
  _setCapabilityEmbedderForTest({ spaceKey: () => 'fixture:same-space:2', embedOne: async () => null, embedMany: async () => null });
  release.resolve();
  assert.equal((await pending).embedded, 0);
  assert.deepEqual(stored(), []);
});

test('content mutation during backfill rejects the stale write and later edits become candidates again', async () => {
  seed();
  const started = deferred(); const release = deferred();
  const local = localProvider('space-a', async () => { if (local.calls.length === 1) { started.resolve(); await release.promise; } });
  _setLocalProviderForTest(local.provider);
  const pending = embedMissingCapabilityOperations();
  await started.promise;
  seed({ description: 'An updated controlled description.' });
  release.resolve();
  assert.equal((await pending).embedded, 0);
  assert.deepEqual(stored(), []);
  assert.equal((await embedMissingCapabilityOperations()).embedded, 1);
  const previousHash = stored()[0].content_hash;
  seed({ description: 'A later controlled description.' });
  assert.deepEqual(await semanticCapabilityCandidates('paraphrased request'), [], 'stale text is not ranked while awaiting re-embedding');
  assert.equal((await embedMissingCapabilityOperations()).embedded, 1);
  assert.notEqual(stored()[0].content_hash, previousHash);
});

test('deactivation during backfill cannot create an unavailable capability vector', async () => {
  seed();
  const started = deferred(); const release = deferred();
  _setLocalProviderForTest(localProvider('space-a', async () => { started.resolve(); await release.promise; }).provider);
  const pending = embedMissingCapabilityOperations();
  await started.promise;
  deactivateCapabilityCarrier('mcp', operation.carrier);
  release.resolve();
  assert.equal((await pending).embedded, 0);
  assert.deepEqual(stored(), []);
});

test('query rechecks current effects and preserves exact account identities after awaiting', async () => {
  seed(); seed({ accountIdentity: 'fixture-account-b' });
  const started = deferred(); const release = deferred();
  const local = localProvider('space-a', async (texts) => {
    if (texts[0] === 'held query') { started.resolve(); await release.promise; }
  });
  _setLocalProviderForTest(local.provider);
  await embedMissingCapabilityOperations();
  const pending = semanticCapabilityCandidates('held query', { effectClass: 'read', carrierKind: 'mcp' });
  await started.promise;
  seed({ effectClass: 'write' });
  release.resolve();
  assert.deepEqual((await pending).map((row) => [row.identifier, row.account]), [[operation.identifier, 'fixture-account-b']]);
});

for (const mutation of ['write', 'inactive'] as const) {
  test(`hybrid retrieval refreshes its lexical descriptors after a pending capability becomes ${mutation}`, async () => {
    seed(); seed({ carrier: 'fixture-b', accountIdentity: 'fixture-account-b' });
    const started = deferred(); const release = deferred();
    const local = localProvider('space-a', async (texts) => {
      if (texts[0] === 'lookup') { started.resolve(); await release.promise; }
    });
    _setLocalProviderForTest(local.provider);
    await embedMissingCapabilityOperations();
    const pending = retrieveCapabilityOperations('lookup', { effectClass: 'read', carrierKind: 'mcp' });
    await started.promise;
    if (mutation === 'write') seed({ effectClass: 'write' });
    else deactivateCapabilityCarrier('mcp', operation.carrier);
    release.resolve();
    const results = await pending;
    assert.deepEqual(results.map((row) => [row.identifier, row.accountIdentity]), [[operation.identifier, 'fixture-account-b']]);
    assert.ok(results.every((row) => row.effectClass === 'read'));
  });
}

for (const malformed of ['count', 'dim', 'zero', 'nonfinite'] as const) {
  test(`malformed ${malformed} provider output is never stored or used for ranking`, async () => {
    seed();
    const local = localProvider();
    _setLocalProviderForTest(local.provider);
    await embedMissingCapabilityOperations();
    local.provider.embed = async (texts) => malformed === 'count'
      ? [] : texts.map(() => Float32Array.from(malformed === 'dim' ? [1, 0, 0] : malformed === 'zero' ? [0, 0] : [Number.NaN, 1]));
    assert.deepEqual(await semanticCapabilityCandidates('paraphrased request'), []);
    capabilityIndexDatabase().exec('DELETE FROM capability_embeddings');
    assert.equal((await embedMissingCapabilityOperations()).embedded, 0);
    assert.deepEqual(stored(), []);
  });
}

test('legacy same-key rows with an incompatible dimension degrade lexically and get repaired', async () => {
  seed();
  const local = localProvider();
  _setLocalProviderForTest(local.provider);
  await embedMissingCapabilityOperations();
  capabilityIndexDatabase().prepare('UPDATE capability_embeddings SET dim = 3, vector = ?').run(vectorToBuffer(Float32Array.from([1, 0, 0])));
  const calls = local.calls.length;
  assert.deepEqual(await semanticCapabilityCandidates('paraphrased request'), []);
  assert.equal(local.calls.length, calls, 'invalid stored vectors do not trigger a request-path embed');
  assert.equal((await embedMissingCapabilityOperations()).embedded, 1);
  assert.equal(stored()[0].dim, 2);
});

test('expired and held query deadlines avoid stale results and never restart work', async () => {
  seed();
  const started = deferred(); const release = deferred();
  const local = localProvider('space-a', async (texts) => {
    if (texts[0] === 'held query') { started.resolve(); await release.promise; }
  });
  _setLocalProviderForTest(local.provider);
  await embedMissingCapabilityOperations();
  assert.deepEqual(await semanticCapabilityCandidates('expired query', { deadlineAtMs: Date.now() - 1 }), []);
  assert.equal(local.calls.length, 1);
  const pending = semanticCapabilityCandidates('held query', { deadlineAtMs: Date.now() + 30 });
  await started.promise;
  assert.deepEqual(await pending, []);
  release.resolve();
  await Promise.resolve();
  assert.equal(local.calls.length, 2);
  seed({ identifier: 'fixture__new' });
  assert.equal((await embedMissingCapabilityOperations({ deadlineAtMs: Date.now() - 1 })).embedded, 0);
  assert.equal(local.calls.length, 2);
});
