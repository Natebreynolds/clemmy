/**
 * Run: npx tsx --test src/memory/capability-alias-private-queue.test.ts
 *
 * The durable learning queue is a crash boundary, not a second transcript.
 * These tests start from the shipped raw-phrase schema so the migration,
 * physical byte scrubbing, bounded retention, query plan, and file modes all
 * have to work against the real failure shape.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const PRIOR_CLEMENTINE_HOME = process.env.CLEMENTINE_HOME;
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-private-learning-queue-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-private-queue\n');

const STORE_DIR = path.join(TMP_HOME, 'memory', 'capability-aliases', 'machine-private-queue');
const DB_FILE = path.join(STORE_DIR, 'aliases.db');
mkdirSync(STORE_DIR, { recursive: true });

const Database = (await import('better-sqlite3')).default;
const legacy = new Database(DB_FILE);
legacy.exec(`
  CREATE TABLE pending_learning (
    pending_id       TEXT PRIMARY KEY,
    session_id       TEXT NOT NULL,
    source_user_seq  INTEGER,
    attempt_id       TEXT,
    identifier       TEXT NOT NULL,
    kind             TEXT NOT NULL,
    account_identity TEXT NOT NULL DEFAULT '',
    phrase           TEXT NOT NULL,
    evidence_digest  TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('pending','done','dead')),
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  )
`);

const SENTINELS = {
  pending: 'PRIVATE_PENDING_PROMPT_6f8c3a48e9d74d13',
  done: 'PRIVATE_DONE_PROMPT_2d1a791dd63a4d6f',
  dead: 'PRIVATE_DEAD_PROMPT_b8bda3f7a02b4a95',
};
const insertLegacy = legacy.prepare(`
  INSERT INTO pending_learning (
    pending_id, session_id, source_user_seq, attempt_id, identifier, kind,
    account_identity, phrase, evidence_digest, status, attempts, last_error,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 'composio', '', ?, ?, ?, ?, ?, ?, ?)
`);
for (const [index, status] of (['pending', 'done', 'dead'] as const).entries()) {
  const at = `2026-08-0${index + 1}T00:00:00.000Z`;
  insertLegacy.run(
    `legacy-${status}`, `session-${status}`, index + 1, `attempt-${status}`,
    `PRIVATECO_LIST_${status.toUpperCase()}`,
    `list renewal invoices ${SENTINELS[status]} user@example.com https://private.example/case/12345`,
    `evidence-${status}`, status, status === 'dead' ? 5 : 0,
    status === 'dead' ? 'catalog unavailable' : null, at, at,
  );
}
legacy.close();

assert.equal(
  Object.values(SENTINELS).every((sentinel) => readFileSync(DB_FILE).includes(Buffer.from(sentinel))),
  true,
  'legacy fixture must physically contain every raw-prompt sentinel before migration',
);

const aliasIndex = await import('./capability-alias-index.js');

test.after(() => {
  aliasIndex.closeCapabilityAliasIndexForTests();
  rmSync(TMP_HOME, { recursive: true, force: true });
  if (PRIOR_CLEMENTINE_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PRIOR_CLEMENTINE_HOME;
});

test('legacy pending/done/dead rows migrate transactionally without retaining raw prompt bytes', () => {
  const initialized = aliasIndex.recordCapabilityAlias({
    aliasDigest: 'privacy-migration-probe',
    intent: 'privateco.list_items',
    kind: 'composio',
    identifier: 'PRIVATECO_LIST_ITEMS',
    klass: 'capability_only',
    terms: ['privateco', 'items'],
  });
  assert.equal(initialized.stored, true,
    `alias store initialization failed: ${'reason' in initialized ? initialized.reason : 'unknown'}`);
  const pending = aliasIndex.listPendingLearning();
  assert.equal(pending.length, 1, 'the retryable legacy row did not survive migration');
  assert.equal(pending[0]?.pendingId, 'legacy-pending');
  assert.equal(pending[0]?.aliasDigest, aliasIndex.acceptedPhraseDigest(
    `list renewal invoices ${SENTINELS.pending} user@example.com https://private.example/case/12345`,
  ));
  assert.deepEqual(pending[0]?.aliasTerms, ['list', 'renewal', 'invoices']);

  const migrated = new Database(DB_FILE, { readonly: true, fileMustExist: true });
  const columns = (migrated.prepare('PRAGMA table_info(pending_learning)').all() as Array<{ name: string }>)
    .map((column) => column.name);
  assert.equal(columns.includes('phrase'), false, 'the raw phrase column survived migration');
  assert.equal(columns.includes('alias_digest'), true);
  assert.equal(columns.includes('alias_terms'), true);
  const statuses = migrated.prepare(
    'SELECT status, COUNT(*) AS n FROM pending_learning GROUP BY status ORDER BY status',
  ).all() as Array<{ status: string; n: number }>;
  assert.deepEqual(statuses, [
    { status: 'dead', n: 1 },
    { status: 'done', n: 1 },
    { status: 'pending', n: 1 },
  ], 'migration did not preserve compact diagnostics for every legacy lifecycle state');
  const plan = migrated.prepare(
    "EXPLAIN QUERY PLAN SELECT * FROM pending_learning WHERE status = 'pending' ORDER BY created_at ASC LIMIT 32",
  ).all() as Array<{ detail: string }>;
  assert.equal(plan.some((row) => /pending_learning_by_status_created/.test(row.detail)), true,
    `pending drain still scans and sorts terminal history: ${JSON.stringify(plan)}`);
  migrated.close();

  aliasIndex.closeCapabilityAliasIndexForTests();
  for (const member of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, `${DB_FILE}-journal`]) {
    if (!existsSync(member)) continue;
    const bytes = readFileSync(member);
    for (const sentinel of Object.values(SENTINELS)) {
      assert.equal(bytes.includes(Buffer.from(sentinel)), false,
        `${path.basename(member)} retained legacy raw prompt bytes for ${sentinel}`);
    }
  }
});

test('the queue directory and SQLite family are private and terminal diagnostics are bounded', () => {
  for (let index = 0; index < 270; index += 1) {
    const pending = aliasIndex.enqueuePendingLearning({
      sessionId: `terminal-session-${index}`,
      sourceUserSeq: index + 10,
      identifier: 'PRIVATECO_LIST_ITEMS',
      kind: 'composio',
      aliasDigest: aliasIndex.acceptedPhraseDigest(`list privateco items variant ${index}`),
      aliasTerms: ['list', 'privateco', 'items', 'variant'],
      evidenceDigest: `terminal-evidence-${index}`,
    });
    assert.ok(pending, `could not enqueue terminal fixture ${index}`);
    aliasIndex.completePendingLearning(pending!.pendingId);
  }

  const database = new Database(DB_FILE, { readonly: true, fileMustExist: true });
  const terminal = database.prepare(
    "SELECT COUNT(*) AS n FROM pending_learning WHERE status IN ('done','dead')",
  ).get() as { n: number };
  database.close();
  assert.ok(terminal.n <= 256, `terminal queue grew beyond its hard cap: ${terminal.n}`);

  assert.equal(statSync(STORE_DIR).mode & 0o777, 0o700, 'alias queue directory is not mode 0700');
  for (const member of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, `${DB_FILE}-journal`]) {
    if (!existsSync(member)) continue;
    assert.equal(statSync(member).mode & 0o777, 0o600, `${path.basename(member)} is not mode 0600`);
  }
});
