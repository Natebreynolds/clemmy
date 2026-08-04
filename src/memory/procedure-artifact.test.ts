/**
 * Run: npx tsx --test src/memory/procedure-artifact.test.ts
 *
 * Stage 2 acceptance from the charter, pinned exactly: promotion only from
 * verified receipts, scope isolation that names cannot cross, durable
 * quarantine on drift with receipt-only re-promotion, one canonical logical
 * procedure after repair, and outcome attribution that never lets transient
 * trouble poison a structurally healthy artifact.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-procedure-artifact-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  computeArtifactId,
  promoteProcedureArtifact,
  readArtifact,
  recordProcedureUse,
  resolveProcedureArtifact,
  templateSlots,
} = await import('./procedure-artifact.js');
type PromoteInput = Parameters<typeof promoteProcedureArtifact>[0];

const SCOPE = { tenant: 'local', workspace: 'sales', accountIdentity: 'user@example.com' };
const RECEIPT = {
  receiptId: 'rcpt-001',
  at: '2026-08-04T00:00:00Z',
  schemaFingerprint: 'sha256:contract-a',
};

function promote(over: Partial<PromoteInput> = {}) {
  return promoteProcedureArtifact({
    scope: SCOPE,
    provider: 'googlesheets',
    operation: 'batch_update',
    effectClass: 'read',
    kind: 'composio',
    identifier: 'GOOGLESHEETS_BATCH_UPDATE',
    templateArgs: { spreadsheet_id: '{{sheet_id}}', range: '{{range}}', majorDimension: 'ROWS' },
    receipt: RECEIPT,
    now: '2026-08-04T00:00:00Z',
    ...over,
  });
}

// ── promotion: the one write path ────────────────────────────────────────────

test('a verified receipt promotes; an assertion without one cannot', () => {
  const promoted = promote();
  assert.equal(promoted.ok, true, JSON.stringify(promoted));
  const artifact = (promoted as Extract<typeof promoted, { ok: true }>).artifact;
  assert.equal(artifact.status, 'active');
  assert.deepEqual(artifact.template.slots, ['sheet_id', 'range']);
  assert.equal(artifact.schemaFingerprint, 'sha256:contract-a');

  const noReceipt = promote({ receipt: { ...RECEIPT, receiptId: '   ' } });
  assert.equal(noReceipt.ok, false, 'a blank receipt promoted a procedure');
  const noFingerprint = promote({ receipt: { ...RECEIPT, schemaFingerprint: '' } });
  assert.equal(noFingerprint.ok, false, 'a receipt that cannot prove its contract promoted');
});

test('a write promotion requires the observation reference, not just a dispatch', () => {
  const write = promote({ effectClass: 'write', operation: 'append_row' });
  assert.equal(write.ok, false, 'a write promoted without observation/commit proof');
  const witnessed = promote({
    effectClass: 'write',
    operation: 'append_row',
    receipt: { ...RECEIPT, observationRef: 'obs-1' },
  });
  assert.equal(witnessed.ok, true);
});

test('filler and undispatchable identifiers cannot be promoted even WITH a receipt', () => {
  assert.equal(promote({ identifier: 'PLACEHOLDER' }).ok, false);
  assert.equal(promote({ identifier: 'GOOGLESHEETS' }).ok, false, 'a bare toolkit name promoted');
});

test('volatile connection identity never enters an artifact', () => {
  const promoted = promote({
    operation: 'values_get',
    templateArgs: { spreadsheet_id: '{{sheet_id}}', connected_account_id: 'ca_rotates' },
  });
  assert.equal(promoted.ok, true);
  const artifact = (promoted as Extract<typeof promoted, { ok: true }>).artifact;
  assert.equal('connected_account_id' in artifact.template.args, false);
  assert.equal(JSON.stringify(artifact).includes('ca_rotates'), false, 'a rotating id was persisted');

  const badScope = promote({ scope: { ...SCOPE, accountIdentity: 'ca_dead_beef' } });
  assert.equal(badScope.ok, false, 'a rotating id was accepted as scope identity');
});

// ── resolution: honestly typed reads ─────────────────────────────────────────

test('resolution binds with slot values, asks for missing ones, and misses honestly', () => {
  promote({ operation: 'values_update' });

  const bound = resolveProcedureArtifact({
    scope: SCOPE, provider: 'googlesheets', operation: 'values_update', effectClass: 'read',
    slotValues: { sheet_id: 'abc', range: 'A1:B2' },
  });
  assert.equal(bound.outcome, 'bound');
  assert.deepEqual((bound as Extract<typeof bound, { outcome: 'bound' }>).requiredSlots, ['sheet_id', 'range']);

  const partial = resolveProcedureArtifact({
    scope: SCOPE, provider: 'googlesheets', operation: 'values_update', effectClass: 'read',
    slotValues: { sheet_id: 'abc' },
  });
  assert.equal(partial.outcome, 'needs_slots');
  assert.deepEqual((partial as Extract<typeof partial, { outcome: 'needs_slots' }>).missingSlots, ['range']);

  const miss = resolveProcedureArtifact({
    scope: SCOPE, provider: 'salesforce', operation: 'soql_query', effectClass: 'read',
  });
  assert.equal(miss.outcome, 'miss', 'an unproven operation returned something other than miss');
});

test('scope isolation is structural — names cannot cross tenant, workspace, or account', () => {
  promote({ operation: 'scoped_op' });
  for (const foreign of [
    { ...SCOPE, tenant: 'other-tenant' },
    { ...SCOPE, workspace: 'other-workspace' },
    { ...SCOPE, accountIdentity: 'other@example.com' },
  ]) {
    const result = resolveProcedureArtifact({
      scope: foreign, provider: 'googlesheets', operation: 'scoped_op', effectClass: 'read',
      slotValues: { sheet_id: 'x', range: 'y' },
    });
    assert.equal(result.outcome, 'miss',
      `a ${JSON.stringify(foreign)} lookup reused another scope's artifact`);
  }
});

test('a disconnected account is unavailable, not a miss and not bound', () => {
  promote({ operation: 'conn_op' });
  const result = resolveProcedureArtifact({
    scope: SCOPE, provider: 'googlesheets', operation: 'conn_op', effectClass: 'read',
    accountConnected: false,
  });
  assert.equal(result.outcome, 'unavailable');
  assert.match((result as Extract<typeof result, { outcome: 'unavailable' }>).reason, /user@example\.com/);
});

// ── drift: durable quarantine, receipt-only way back ─────────────────────────

test('schema drift quarantines DURABLY and only a fresh receipt re-promotes', () => {
  const promoted = promote({ operation: 'drift_op' });
  const artifactId = (promoted as Extract<typeof promoted, { ok: true }>).artifact.artifactId;

  const stale = resolveProcedureArtifact({
    scope: SCOPE, provider: 'googlesheets', operation: 'drift_op', effectClass: 'read',
    liveSchemaFingerprint: 'sha256:contract-B',
  });
  assert.equal(stale.outcome, 'stale');
  assert.match((stale as Extract<typeof stale, { outcome: 'stale' }>).reason, /contract-B/);
  assert.equal(readArtifact(artifactId)?.status, 'quarantined', 'drift did not quarantine durably');

  // The next resolution reports the quarantine as a miss for binding purposes
  // (no active candidate) — it does NOT serve the stale artifact.
  const after = resolveProcedureArtifact({
    scope: SCOPE, provider: 'googlesheets', operation: 'drift_op', effectClass: 'read',
    slotValues: { sheet_id: 'x', range: 'y' },
  });
  assert.equal(after.outcome, 'miss');

  // Success cannot resurrect it; only a fresh receipt can.
  recordProcedureUse(artifactId, 'success', 'someone claims it worked');
  assert.equal(readArtifact(artifactId)?.status, 'quarantined', 'a success claim reactivated a quarantined artifact');

  const repromo = promote({
    operation: 'drift_op',
    receipt: { receiptId: 'rcpt-002', at: '2026-08-04T01:00:00Z', schemaFingerprint: 'sha256:contract-B' },
    now: '2026-08-04T01:00:00Z',
  });
  assert.equal(repromo.ok, true);
  const revived = (repromo as Extract<typeof repromo, { ok: true }>).artifact;
  assert.equal(revived.artifactId, artifactId, 'the same content address did not converge');
  assert.equal(revived.status, 'active');
  assert.equal(revived.schemaFingerprint, 'sha256:contract-B');
});

// ── one canonical procedure per logical key ──────────────────────────────────

test('a repaired carrier supersedes — never two active duplicates', () => {
  promote({ operation: 'canon_op', identifier: 'GOOGLESHEETS_BATCH_UPDATE' });
  const repaired = promote({
    operation: 'canon_op',
    identifier: 'GOOGLESHEETS_VALUES_BATCH_UPDATE',
    receipt: { receiptId: 'rcpt-003', at: '2026-08-04T02:00:00Z', schemaFingerprint: 'sha256:contract-a' },
  });
  assert.equal(repaired.ok, true);
  const result = repaired as Extract<typeof repaired, { ok: true }>;
  assert.ok(result.superseded, 'the prior artifact for the same logical key stayed active');
  assert.equal(readArtifact(result.superseded!)?.status, 'superseded');
  assert.equal(readArtifact(result.superseded!)?.supersededBy, result.artifact.artifactId);

  const resolved = resolveProcedureArtifact({
    scope: SCOPE, provider: 'googlesheets', operation: 'canon_op', effectClass: 'read',
    slotValues: { sheet_id: 'x', range: 'y' },
  });
  assert.equal(resolved.outcome, 'bound');
  assert.equal(
    (resolved as Extract<typeof resolved, { outcome: 'bound' }>).artifact.identifier,
    'GOOGLESHEETS_VALUES_BATCH_UPDATE',
  );
});

// ── outcome attribution ──────────────────────────────────────────────────────

test('transient trouble is evidence; only structural failure quarantines', () => {
  const promoted = promote({ operation: 'outcome_op' });
  const artifactId = (promoted as Extract<typeof promoted, { ok: true }>).artifact.artifactId;

  recordProcedureUse(artifactId, 'transient_failure', 'provider 429');
  recordProcedureUse(artifactId, 'transient_failure', 'timeout');
  recordProcedureUse(artifactId, 'success');
  assert.equal(readArtifact(artifactId)?.status, 'active',
    'transient provider trouble poisoned a structurally healthy artifact');
  assert.equal(readArtifact(artifactId)?.evidence.length, 3);

  recordProcedureUse(artifactId, 'structural_failure', 'field renamed by provider');
  assert.equal(readArtifact(artifactId)?.status, 'quarantined');
  assert.match(readArtifact(artifactId)?.statusReason ?? '', /field renamed/);
});

// ── identity ─────────────────────────────────────────────────────────────────

test('the content address converges paraphrases and separates real differences', () => {
  const base = {
    scope: SCOPE, provider: 'p', operation: 'o', effectClass: 'read',
    kind: 'composio' as const, identifier: 'P_O',
    template: { args: { a: '{{x}}' }, slots: ['x'] },
  };
  assert.equal(computeArtifactId(base), computeArtifactId({ ...base }));
  assert.notEqual(computeArtifactId(base), computeArtifactId({ ...base, identifier: 'P_O_V2' }));
  assert.notEqual(computeArtifactId(base), computeArtifactId({ ...base, scope: { ...SCOPE, workspace: 'w2' } }));
  assert.notEqual(computeArtifactId(base), computeArtifactId({ ...base, template: { args: { a: '{{y}}' }, slots: ['y'] } }));
});

test('slot extraction preserves template order and nesting', () => {
  assert.deepEqual(
    templateSlots({ b: '{{beta}}', a: { nested: ['{{alpha}}', '{{beta}}'] }, c: 'literal' }),
    ['beta', 'alpha'],
  );
  assert.deepEqual(templateSlots({ plain: 'no slots' }), []);
});
