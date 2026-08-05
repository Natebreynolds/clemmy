/**
 * Run: npx tsx --test src/memory/procedure-receipts.test.ts
 *
 * D2 biting suite: runtime-validated, receipt-backed, TRANSACTIONAL
 * procedures. No cast JSON is trusted; no caller-constructed receipt shape is
 * promotion authority; logical-key supersession is atomic under concurrency;
 * drift quarantines durably before dispatch and only a new verified receipt
 * re-promotes.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-procedure-receipts-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  activeArtifactForKey,
  logicalKeyDigest,
  parseProcedureArtifactDocument,
  promoteFromVerifiedReceipt,
  resolveActiveProcedure,
  PROCEDURE_ARTIFACT_VERSION,
} = await import('./procedure-receipts.js');
type ReceiptRecord = import('./procedure-receipts.js').DurableReceiptRecord;

const SCOPE = { tenant: 'tenant-1', workspace: 'ws-1', accountIdentity: 'person@example.com' };

let receiptSeq = 0;
function receiptStore() {
  const records = new Map<string, ReceiptRecord>();
  return {
    records,
    mint(over: Partial<ReceiptRecord> = {}): ReceiptRecord {
      const record: ReceiptRecord = {
        receiptId: `rcpt_${(receiptSeq += 1)}`,
        at: '2026-08-04T00:00:00.000Z',
        provider: 'providerx',
        operation: 'list_items',
        effectClass: 'read',
        identifier: 'PROVIDERX_LIST_ITEMS',
        schemaFingerprint: 'fp-1',
        scope: { ...SCOPE },
        dispatchOutcome: 'succeeded',
        readEvidenceRef: 'ev-1',
        ...over,
      };
      records.set(record.receiptId, record);
      return record;
    },
    resolver: { resolve: (id: string) => records.get(id) },
  };
}

function promotionInput(receiptId: string, over: Record<string, unknown> = {}) {
  return {
    scope: { ...SCOPE },
    provider: 'providerx',
    operation: 'list_items',
    effectClass: 'read' as const,
    kind: 'composio' as const,
    identifier: 'PROVIDERX_LIST_ITEMS',
    templateArgs: { window: '{{window}}' },
    receiptId,
    now: '2026-08-04T00:00:00.000Z',
    ...over,
  };
}

// ─── receipt authority ───────────────────────────────────────────────────────

test('a receipt-shaped object is not promotion authority — the durable record is', async () => {
  const store = receiptStore();
  const unresolvable = await promoteFromVerifiedReceipt(promotionInput('rcpt_ghost'), store.resolver);
  assert.equal(unresolvable.ok, false);
  assert.match((unresolvable as Extract<typeof unresolvable, { ok: false }>).errors[0]!, /does not resolve/);

  const record = store.mint();
  const promoted = await promoteFromVerifiedReceipt(promotionInput(record.receiptId), store.resolver);
  assert.equal(promoted.ok, true, JSON.stringify(promoted));
});

test('promotion verifies operation, provider, identifier, effect, scope, outcome, and read evidence against the durable record', async () => {
  const store = receiptStore();
  const cases: Array<[string, Partial<ReceiptRecord>, RegExp]> = [
    ['failed dispatch', { dispatchOutcome: 'failed' }, /not a verified success/],
    ['ambiguous dispatch', { dispatchOutcome: 'ambiguous' }, /not a verified success/],
    ['different operation', { operation: 'delete_items' }, /proves providerx\/delete_items/],
    ['different identifier', { identifier: 'PROVIDERX_OTHER' }, /proves identifier/],
    ['different effect class', { effectClass: 'write' }, /effect class write/],
    ['different scope', { scope: { ...SCOPE, accountIdentity: 'someone@else.com' } }, /scope .* does not match/],
    ['read without evidence', { readEvidenceRef: undefined }, /without read evidence/],
  ];
  for (const [label, over, why] of cases) {
    const record = store.mint(over);
    const result = await promoteFromVerifiedReceipt(promotionInput(record.receiptId), store.resolver);
    assert.equal(result.ok, false, `${label}: promoted anyway`);
    assert.ok((result as Extract<typeof result, { ok: false }>).errors.some((e) => why.test(e)),
      `${label}: ${JSON.stringify(result)}`);
  }
});

// ─── runtime validation and quarantine ───────────────────────────────────────

test('parse validates every load-bearing field and refuses unknown versions', () => {
  assert.equal(parseProcedureArtifactDocument('nonsense').ok, false);
  assert.equal(parseProcedureArtifactDocument({ artifactVersion: 99 }).ok, false);
  const missing = parseProcedureArtifactDocument({ artifactVersion: PROCEDURE_ARTIFACT_VERSION, artifactId: 'x' });
  assert.equal(missing.ok, false);
});

test('a torn active artifact row quarantines with a typed reason, and resolution reports the miss', async () => {
  const store = receiptStore();
  const record = store.mint({ operation: 'torn_case', identifier: 'PROVIDERX_TORN_CASE' });
  const promoted = await promoteFromVerifiedReceipt(promotionInput(record.receiptId, {
    operation: 'torn_case', identifier: 'PROVIDERX_TORN_CASE', templateArgs: {},
  }), store.resolver);
  assert.equal(promoted.ok, true);
  const artifactId = (promoted as Extract<typeof promoted, { ok: true }>).artifact.artifactId;

  // Tear the ROW the pointer names (direct surgery on the store).
  const Database = (await import('better-sqlite3')).default;
  const database = new Database(path.join(TMP_HOME, 'memory', 'procedure-artifacts', 'machine-A', 'procedures.db'));
  database.prepare('UPDATE artifacts SET document = ? WHERE artifact_id = ?').run('{ torn json', artifactId);
  database.close();

  const resolved = resolveActiveProcedure({
    scope: SCOPE, provider: 'providerx', operation: 'torn_case', effectClass: 'read',
  });
  assert.equal(resolved.outcome, 'miss');
  assert.ok((resolved as { quarantined?: { reason: string } }).quarantined,
    'the torn row did not report a typed quarantine');
  // The pointer is cleared: the next resolution is a clean miss, not a crash loop.
  assert.equal(resolveActiveProcedure({
    scope: SCOPE, provider: 'providerx', operation: 'torn_case', effectClass: 'read',
  }).outcome, 'miss');
});

// ─── atomic logical-key supersession ─────────────────────────────────────────

test('concurrent promotions for one logical key leave exactly ONE active canonical artifact', async () => {
  const store = receiptStore();
  const contenders = Array.from({ length: 8 }, (_, index) => {
    const record = store.mint({
      operation: 'contended', identifier: 'PROVIDERX_CONTENDED',
      schemaFingerprint: `fp-${index}`,
    });
    return promoteFromVerifiedReceipt(promotionInput(record.receiptId, {
      operation: 'contended', identifier: 'PROVIDERX_CONTENDED',
      templateArgs: { variant: String(index) }, // 8 DIFFERENT artifacts, one key
    }), store.resolver);
  });
  const settled = await Promise.all(contenders);
  assert.equal(settled.filter((result) => result.ok).length, 8);
  const active = activeArtifactForKey({
    scope: SCOPE, provider: 'providerx', operation: 'contended', effectClass: 'read',
  });
  assert.ok(active, 'no active canonical artifact after contention');
  const resolved = resolveActiveProcedure({
    scope: SCOPE, provider: 'providerx', operation: 'contended', effectClass: 'read',
    slotValues: {},
  });
  assert.equal(resolved.outcome, 'bound', JSON.stringify(resolved));
  // One pointer row, one winner — never two actives.
  const Database = (await import('better-sqlite3')).default;
  const database = new Database(path.join(TMP_HOME, 'memory', 'procedure-artifacts', 'machine-A', 'procedures.db'));
  const key = logicalKeyDigest({ scope: SCOPE, provider: 'providerx', operation: 'contended', effectClass: 'read' });
  const pointer = database.prepare('SELECT active_artifact_id FROM pointers WHERE key_digest = ?').get(key) as
    { active_artifact_id: string };
  const activeCount = database.prepare(
    "SELECT COUNT(*) AS n FROM artifacts a JOIN pointers p ON p.active_artifact_id = a.artifact_id WHERE p.key_digest = ? AND a.status = 'active'",
  ).get(key) as { n: number };
  database.close();
  assert.equal(pointer.active_artifact_id, active!.artifactId);
  assert.equal(activeCount.n, 1, 'more than one active canonical artifact for the key');
});

// ─── drift quarantines before dispatch; a fresh receipt re-promotes ──────────

test('schema drift quarantines durably at resolution, and only a new verified receipt re-promotes', async () => {
  const store = receiptStore();
  const record = store.mint({ operation: 'drifty', identifier: 'PROVIDERX_DRIFTY' });
  const promoted = await promoteFromVerifiedReceipt(promotionInput(record.receiptId, {
    operation: 'drifty', identifier: 'PROVIDERX_DRIFTY', templateArgs: {},
  }), store.resolver);
  assert.equal(promoted.ok, true);

  const drifted = resolveActiveProcedure({
    scope: SCOPE, provider: 'providerx', operation: 'drifty', effectClass: 'read',
    liveSchemaFingerprint: 'fp-NEW',
  });
  assert.equal(drifted.outcome, 'stale');
  // Durable: the next resolution is a MISS (pointer cleared), never a re-detect.
  assert.equal(resolveActiveProcedure({
    scope: SCOPE, provider: 'providerx', operation: 'drifty', effectClass: 'read',
  }).outcome, 'miss');

  // Re-promotion requires a NEW verified receipt against the new contract.
  const fresh = store.mint({ operation: 'drifty', identifier: 'PROVIDERX_DRIFTY', schemaFingerprint: 'fp-NEW' });
  const repromoted = await promoteFromVerifiedReceipt(promotionInput(fresh.receiptId, {
    operation: 'drifty', identifier: 'PROVIDERX_DRIFTY', templateArgs: {},
  }), store.resolver);
  assert.equal(repromoted.ok, true);
  assert.equal(resolveActiveProcedure({
    scope: SCOPE, provider: 'providerx', operation: 'drifty', effectClass: 'read',
    liveSchemaFingerprint: 'fp-NEW', slotValues: {},
  }).outcome, 'bound');
});

test('scope isolation is structural: another tenant, workspace, or account never resolves this key', async () => {
  const store = receiptStore();
  const record = store.mint({ operation: 'scoped', identifier: 'PROVIDERX_SCOPED' });
  const promoted = await promoteFromVerifiedReceipt(promotionInput(record.receiptId, {
    operation: 'scoped', identifier: 'PROVIDERX_SCOPED', templateArgs: {},
  }), store.resolver);
  assert.equal(promoted.ok, true);
  for (const other of [
    { ...SCOPE, tenant: 'tenant-2' },
    { ...SCOPE, workspace: 'ws-2' },
    { ...SCOPE, accountIdentity: 'other@example.com' },
  ]) {
    assert.equal(resolveActiveProcedure({
      scope: other, provider: 'providerx', operation: 'scoped', effectClass: 'read',
    }).outcome, 'miss', `${JSON.stringify(other)} crossed a scope boundary`);
  }
});
