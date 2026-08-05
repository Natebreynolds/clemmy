/**
 * Run: npx tsx --test src/memory/capability-alias-index.test.ts
 *
 * F1 biting suite: the alias index is the only thing standing between "we have
 * seen a tool work for a request like this" and "run this call". Every property
 * below is one that, if it broke, would turn advisory retrieval into silent
 * authority, leak one user's phrasing to another, or serve a forged row.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-alias-index-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  acceptedPhraseDigest,
  aliasScopeDigest,
  attachCapabilityAliasEmbedding,
  boundedAliasTerms,
  claimAcceptedSourceForLearning,
  listCapabilityAliases,
  lookupExactCapabilityAliases,
  recordCapabilityAlias,
  semanticCapabilityAliases,
  DEFAULT_SEMANTIC_FLOOR,
} = await import('./capability-alias-index.js');

const SCOPE = { tenant: 'tenant-1', workspace: 'ws-1' };

function firstExact(aliasDigest: string, options: Record<string, unknown> = {}) {
  // Rows in this suite bind contract fp-1; schema-bound retrieval requires
  // LIVE authority, so the default lookup presents it.
  return lookupExactCapabilityAliases(aliasDigest, {
    scope: SCOPE, liveSchemaFingerprintFor: () => 'fp-1', ...options,
  })[0] ?? null;
}
const DB_FILE = path.join(TMP_HOME, 'memory', 'capability-aliases', 'machine-A', 'aliases.db');

async function openDb() {
  const Database = (await import('better-sqlite3')).default;
  return new Database(DB_FILE);
}

function record(over: Record<string, unknown> = {}) {
  return recordCapabilityAlias({
    aliasDigest: 'alias-base',
    scope: SCOPE,
    intent: 'providerx.list_items',
    kind: 'composio',
    identifier: 'PROVIDERX_LIST_ITEMS',
    klass: 'capability_only',
    terms: ['items', 'inventory'],
    schemaFingerprint: 'fp-1',
    ...over,
  });
}

// ─── class is immutable ──────────────────────────────────────────────────────

test('a capability_only alias can never be promoted to executable', async () => {
  assert.equal(record({ aliasDigest: 'alias-class' }).stored, true);
  const promotion = record({ aliasDigest: 'alias-class', klass: 'executable' });
  assert.equal(promotion.stored, false);
  assert.match((promotion as { reason: string }).reason, /immutable/);
  assert.equal(firstExact('alias-class')?.klass, 'capability_only');

  // And the reverse: a genuinely executable row is never demoted in place
  // either — the class is decided once, by whatever proved it.
  assert.equal(recordCapabilityAlias({
    aliasDigest: 'alias-exec', scope: SCOPE, intent: 'providerx.list_items',
    kind: 'composio', identifier: 'PROVIDERX_LIST_ITEMS', klass: 'executable', terms: ['x'],
  }).stored, true);
  assert.equal(record({ aliasDigest: 'alias-exec' }).stored, false);
});

test('the store itself refuses a class it does not know', async () => {
  const db = await openDb();
  assert.throws(() => db.prepare(`
    INSERT INTO aliases (alias_digest, scope_digest, intent, kind, identifier, account_identity, klass, terms,
                         schema_fingerprint, created_at, updated_at, row_digest)
    VALUES ('forged', ?, 'i', 'composio', 'X', '', 'authorized', '[]', NULL, 'n', 'n', 'd')
  `).run(aliasScopeDigest(SCOPE)), /CHECK/);
  db.close();
});

// ─── concurrency ─────────────────────────────────────────────────────────────

test('concurrent writes for one alias leave exactly one consistent row', async () => {
  const writes = Array.from({ length: 12 }, (_, index) => record({
    aliasDigest: 'alias-race', terms: ['shared', `variant${index}`],
  }));
  assert.equal(writes.every((w) => w.stored), true, JSON.stringify(writes.filter((w) => !w.stored)));
  const db = await openDb();
  const rows = db.prepare('SELECT COUNT(*) AS n FROM aliases WHERE alias_digest = ?').get('alias-race') as { n: number };
  db.close();
  assert.equal(rows.n, 1, 'contention produced more than one row for one alias');
  assert.ok(firstExact('alias-race'), 'the surviving row does not resolve');
});

test('an accepted source is owned exactly once, whoever settles first', () => {
  const claims = Array.from({ length: 8 }, () => claimAcceptedSourceForLearning({
    sessionId: 'sess-race', sourceUserSeq: 7, identifier: 'PROVIDERX_LIST_ITEMS',
  }));
  assert.equal(claims.filter(Boolean).length, 1, 'an accepted source was learned more than once');
  // A DIFFERENT accepted turn is its own claim.
  assert.equal(claimAcceptedSourceForLearning({
    sessionId: 'sess-race', sourceUserSeq: 8, identifier: 'PROVIDERX_LIST_ITEMS',
  }), true);
  // A different ACCOUNT is a different settlement: a brief that read two
  // mailboxes teaches both, once each.
  assert.equal(claimAcceptedSourceForLearning({
    sessionId: 'sess-race', sourceUserSeq: 7, identifier: 'PROVIDERX_LIST_ITEMS',
    accountIdentity: 'b@example.com',
  }), true);
  assert.equal(claimAcceptedSourceForLearning({
    sessionId: 'sess-race', sourceUserSeq: 7, identifier: 'PROVIDERX_LIST_ITEMS',
    accountIdentity: 'b@example.com',
  }), false);
});

// ─── tamper evidence ─────────────────────────────────────────────────────────

test('a row edited underneath the index misses and is removed, never served', async () => {
  assert.equal(record({ aliasDigest: 'alias-tamper' }).stored, true);
  const db = await openDb();
  db.prepare('UPDATE aliases SET identifier = ? WHERE alias_digest = ?')
    .run('PROVIDERX_DELETE_EVERYTHING', 'alias-tamper');
  db.close();

  assert.equal(firstExact('alias-tamper'), null,
    'a forged identifier was served as a retrieval candidate');
  const after = await openDb();
  const remaining = after.prepare('SELECT COUNT(*) AS n FROM aliases WHERE alias_digest = ?')
    .get('alias-tamper') as { n: number };
  after.close();
  assert.equal(remaining.n, 0, 'the failed row stayed on disk to fail again');
});

// ─── stale schema ────────────────────────────────────────────────────────────

test('a row whose provider contract moved stops being retrievable until it is re-proven', () => {
  assert.equal(record({ aliasDigest: 'alias-drift', schemaFingerprint: 'fp-1' }).stored, true);
  assert.ok(firstExact('alias-drift', { liveSchemaFingerprintFor: () => 'fp-1' }));
  assert.equal(firstExact('alias-drift', { liveSchemaFingerprintFor: () => 'fp-2' }), null,
    'a stale capability was still retrievable after the contract changed');
  assert.equal(record({ aliasDigest: 'alias-drift', schemaFingerprint: 'fp-2' }).stored, true);
  assert.ok(firstExact('alias-drift', { liveSchemaFingerprintFor: () => 'fp-2' }),
    'a re-proven capability did not come back');
});

// ─── privacy ─────────────────────────────────────────────────────────────────

test('scope isolation is structural: another tenant or workspace retrieves nothing', () => {
  assert.equal(record({ aliasDigest: 'alias-scoped' }).stored, true);
  for (const other of [
    { ...SCOPE, tenant: 'tenant-2' },
    { ...SCOPE, workspace: 'ws-2' },
    undefined,
  ]) {
    assert.equal(lookupExactCapabilityAliases('alias-scoped', { scope: other }).length, 0,
      `${JSON.stringify(other)} crossed a privacy boundary`);
    assert.equal(listCapabilityAliases({ scope: other }).some((r) => r.aliasDigest === 'alias-scoped'), false,
      `${JSON.stringify(other)} enumerated another scope's aliases`);
  }
});

test('one phrase may prove many capabilities and many accounts, each its own row', () => {
  assert.equal(record({ aliasDigest: 'alias-many', identifier: 'PROVIDERX_LIST_ITEMS' }).stored, true);
  assert.equal(record({ aliasDigest: 'alias-many', identifier: 'PROVIDERY_GET_FORECAST' }).stored, true);
  assert.equal(record({
    aliasDigest: 'alias-many', identifier: 'PROVIDERX_LIST_ITEMS', accountIdentity: 'b@example.com',
  }).stored, true);
  const rows = lookupExactCapabilityAliases('alias-many', {
    scope: SCOPE, liveSchemaFingerprintFor: () => 'fp-1',
  });
  assert.equal(rows.length, 3, 'rows for one phrase displaced each other');
  const identities = new Set(rows.map((r) => `${r.identifier}::${r.accountIdentity}`));
  assert.equal(identities.size, 3);
});

test('the accepted phrase is never recoverable from the index', async () => {
  const phrase = 'email the Q3 renewal quote to dana.wexler@northwind-industries.com order 884213307 token sk_live_9fJq2mNz8Xa4';
  const terms = boundedAliasTerms(phrase);
  for (const leaked of ['dana', 'wexler', 'northwind', 'industries', 'com', '884213307', 'sk_live_9fJq2mNz8Xa4']) {
    // Address and identifier fragments are exactly what must not become
    // retrievable features; ordinary intent words still may.
    assert.equal(terms.includes(leaked), false, `"${leaked}" survived into the stored alias terms`);
  }
  assert.ok(terms.includes('renewal') && terms.includes('quote'), `intent words were lost: ${terms.join(',')}`);
  assert.ok(terms.length <= 12, 'the alias is not bounded');

  assert.equal(recordCapabilityAlias({
    aliasDigest: acceptedPhraseDigest(phrase), scope: SCOPE, intent: 'providerx.quote',
    kind: 'composio', identifier: 'PROVIDERX_QUOTE', klass: 'capability_only', terms,
  }).stored, true);

  const db = await openDb();
  const bytes = JSON.stringify(db.prepare('SELECT * FROM aliases').all());
  db.close();
  for (const secret of ['dana.wexler', 'northwind-industries', '884213307', 'sk_live_9fJq2mNz8Xa4']) {
    assert.equal(bytes.includes(secret), false, `"${secret}" is stored in the alias index`);
  }
  assert.equal(bytes.includes(phrase), false, 'the raw accepted phrase is stored verbatim');
});

// ─── retrieval carries no execution state ────────────────────────────────────

test('an alias row has nowhere to put an argument, an account, or a connection', async () => {
  const db = await openDb();
  const columns = (db.prepare('PRAGMA table_info(aliases)').all() as Array<{ name: string }>)
    .map((c) => c.name);
  db.close();
  for (const forbidden of ['args', 'arguments', 'invocation_template', 'template', 'connection_id', 'account']) {
    assert.equal(columns.includes(forbidden), false,
      `the alias index has an "${forbidden}" column — retrieval could carry execution state`);
  }
});

// ─── the semantic floor ──────────────────────────────────────────────────────

test('semantic retrieval is bounded by scope, space, and floor', () => {
  const dim = 8;
  const unit = (values: number[]) => {
    const vector = Float32Array.from(values.concat(Array(dim - values.length).fill(0)));
    const norm = Math.hypot(...vector) || 1;
    return vector.map((v) => v / norm) as Float32Array;
  };
  const stored = unit([1, 1, 0, 0]);
  const written = record({ aliasDigest: 'alias-vec' });
  assert.equal(written.stored, true);
  const row = (written as Extract<typeof written, { stored: true }>).row;
  assert.equal(attachCapabilityAliasEmbedding(row, stored, 'space-A'), true);

  const near = semanticCapabilityAliases(unit([1, 0.9, 0, 0]), {
    scope: SCOPE, embeddingSpace: 'space-A', liveSchemaFingerprintFor: () => 'fp-1',
  });
  assert.equal(near[0]?.row.aliasDigest, 'alias-vec');
  assert.ok(near[0]!.score >= DEFAULT_SEMANTIC_FLOOR);

  assert.equal(semanticCapabilityAliases(unit([0, 0, 1, 0]), {
    scope: SCOPE, embeddingSpace: 'space-A', liveSchemaFingerprintFor: () => 'fp-1',
  }).length, 0, 'an unrelated vector cleared the retrieval floor');
  assert.equal(semanticCapabilityAliases(stored, {
    scope: SCOPE, embeddingSpace: 'space-B', liveSchemaFingerprintFor: () => 'fp-1',
  }).length, 0, 'a vector from a different embedding space was compared anyway');
  assert.equal(semanticCapabilityAliases(stored, {
    scope: { tenant: 'tenant-2' }, embeddingSpace: 'space-A', liveSchemaFingerprintFor: () => 'fp-1',
  }).length, 0, 'semantic retrieval crossed a privacy boundary');
  // And the fail-closed rule itself: no live authority, no schema-bound hit.
  assert.equal(semanticCapabilityAliases(unit([1, 0.9, 0, 0]), {
    scope: SCOPE, embeddingSpace: 'space-A',
  }).length, 0, 'a schema-bound row served without live catalog authority');
});
