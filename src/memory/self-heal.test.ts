/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-memory-self-heal npx tsx --test src/memory/self-heal.test.ts
 *
 * Covers the aggressive memory self-heal layer: real-knowledge fixes may
 * auto-apply only when they are objective, pinned-exempt, bounded, audited,
 * reversible, and either deterministic or judge-approved.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-memory-self-heal';
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_MEMORY_SELF_HEAL_JUDGE = 'off';
delete process.env.CLEMMY_MEMORY_SELF_HEAL;
delete process.env.CLEMMY_MEMORY_SELF_HEAL_REAL;
delete process.env.CLEMMY_MEMORY_SELF_HEAL_MAX;

// eslint-disable-next-line import/first
const { resetMemoryDb, openMemoryDb } = await import('./db.js');
// eslint-disable-next-line import/first
const { rememberFact, getFact, setFactPinned } = await import('./facts.js');
// eslint-disable-next-line import/first
const { vectorToBuffer, _setEmbeddingProviderForTest } = await import('./embeddings.js');
// eslint-disable-next-line import/first
const { readHygieneAudit } = await import('./hygiene-audit.js');
// eslint-disable-next-line import/first
const { appendFactRecallTrace } = await import('./recall-trace.js');
// eslint-disable-next-line import/first
const {
  detectMemoryHealCandidates,
  applyMemoryFix,
  runMemorySelfHeal,
  revertMemoryHeal,
  listProposedMemoryFixes,
  parseMemoryVetoVerdict,
  _memorySelfHealTest,
} = await import('./self-heal.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

beforeEach(() => {
  resetMemoryDb();
  _setEmbeddingProviderForTest({
    name: 'test',
    model: 'test',
    dim: 4,
    async embed(texts) {
      return texts.map(() => new Float32Array(4));
    },
  });
  rmSync(`${TEST_HOME}/state/memory-self-heal`, { recursive: true, force: true });
  rmSync(`${TEST_HOME}/state/memory-recall-trace.jsonl`, { force: true });
  openMemoryDb();
  process.env.CLEMMY_MEMORY_SELF_HEAL_JUDGE = 'off';
  delete process.env.CLEMMY_MEMORY_SELF_HEAL;
  delete process.env.CLEMMY_MEMORY_SELF_HEAL_REAL;
  delete process.env.CLEMMY_MEMORY_SELF_HEAL_MAX;
});

function ageFact(id: number, days: number) {
  const db = openMemoryDb();
  const iso = new Date(Date.now() - days * 86_400_000).toISOString();
  db.prepare('UPDATE consolidated_facts SET created_at = ?, updated_at = ?, last_accessed_at = NULL WHERE id = ?').run(iso, iso, id);
}

function setFactCreatedAt(id: number, iso: string) {
  const db = openMemoryDb();
  db.prepare('UPDATE consolidated_facts SET created_at = ?, updated_at = ?, last_accessed_at = NULL WHERE id = ?').run(iso, iso, id);
}

function contentHash(id: number): string {
  const db = openMemoryDb();
  return (db.prepare('SELECT content_hash FROM consolidated_facts WHERE id = ?').get(id) as { content_hash: string }).content_hash;
}

function setEmbedding(id: number, vector: number[]) {
  const db = openMemoryDb();
  db.prepare(
    `INSERT OR REPLACE INTO fact_embeddings (fact_id, model, dim, vector, content_hash, created_at)
     VALUES (?, 'test', ?, ?, ?, ?)`,
  ).run(id, vector.length, vectorToBuffer(Float32Array.from(vector)), contentHash(id), new Date().toISOString());
}

test('runMemorySelfHeal: retires internal-noise facts, keeps real facts, audits, and reverts', async () => {
  const noise = rememberFact({ kind: 'project', content: 'Internal task list result from memory_read', derivedFrom: { tool: 'memory_read', sessionId: 's1' } });
  const real = rememberFact({ kind: 'project', content: 'The Aldous project uses a generated one-page site.' });

  const out = await runMemorySelfHeal({ maxApply: 5, nowIso: '2026-07-04T12:00:00.000Z' });
  assert.equal(out.ran, true);
  assert.equal(out.applied, 1);
  assert.equal(getFact(noise.id)?.active, false);
  assert.equal(getFact(real.id)?.active, true);

  const audit = readHygieneAudit(5).find((e) => e.kind === 'memory-heal');
  assert.ok(audit);
  const healAuditId = (audit!.detail as { healAuditId: string }).healAuditId;
  const reverted = revertMemoryHeal(healAuditId, '2026-07-04T12:01:00.000Z');
  assert.equal(reverted.ok, true);
  assert.equal(getFact(noise.id)?.active, true);
  assert.ok(readHygieneAudit(5).some((e) => e.kind === 'memory-heal-revert'));

  const second = await runMemorySelfHeal({ maxApply: 5, nowIso: '2026-07-04T12:02:00.000Z' });
  assert.equal(second.applied, 0, 'a reverted fix signature is not auto-applied again');
  assert.ok(second.skipped.some((s) => /reverted/.test(s.reason)));
});

test('lift_recall_gap: boosts importance without changing content', async () => {
  const f = rememberFact({ kind: 'project', content: 'High-value buried fact for a client workspace.', importance: 8 });
  ageFact(f.id, 30);
  const beforeHash = contentHash(f.id);

  const out = await runMemorySelfHeal({ maxApply: 5, nowIso: '2026-07-04T12:00:00.000Z' });
  assert.equal(out.applied, 1);
  const after = getFact(f.id)!;
  assert.equal(after.importance, 9);
  assert.equal(after.content, 'High-value buried fact for a client workspace.');
  assert.equal(contentHash(f.id), beforeHash);
});

test('lift_recall_gap detection honors supplied nowIso instead of wall clock', () => {
  const f = rememberFact({ kind: 'project', content: 'Future-preview buried high-value fact.', importance: 8 });
  setFactCreatedAt(f.id, '2026-07-01T00:00:00.000Z');

  const tooSoon = detectMemoryHealCandidates({
    persistProposals: false,
    nowIso: '2026-07-07T23:59:59.000Z',
  });
  assert.equal(tooSoon.some((fix) => fix.kind === 'lift_recall_gap' && fix.targetIds.includes(f.id)), false);

  const eligible = detectMemoryHealCandidates({
    persistProposals: false,
    nowIso: '2026-07-09T00:00:00.000Z',
  });
  assert.equal(eligible.some((fix) => fix.kind === 'lift_recall_gap' && fix.targetIds.includes(f.id)), true);
});

test('pinned facts are exempt from every auto-heal candidate class', async () => {
  const noise = rememberFact({ kind: 'project', content: 'Pinned internal result from memory_read', derivedFrom: { tool: 'memory_read', sessionId: 's1' } });
  const buried = rememberFact({ kind: 'project', content: 'Pinned high-value fact.', importance: 8 });
  setFactPinned(noise.id, true);
  setFactPinned(buried.id, true);
  ageFact(buried.id, 30);

  const out = await runMemorySelfHeal({ maxApply: 5 });
  assert.equal(out.applied, 0);
  assert.equal(getFact(noise.id)?.active, true);
  assert.equal(getFact(buried.id)?.importance, 8);
});

test('demote_overexposed_fact: lowers derived low-value fact importance without deleting it', async () => {
  const derived = rememberFact({
    kind: 'project',
    content: 'Generic browser state was seen while inspecting a temporary page.',
    importance: 5,
    trustLevel: 0.6,
    derivedFrom: { tool: 'browser_read', sessionId: 's1' },
  });
  const direct = rememberFact({
    kind: 'project',
    content: 'Directly stated project preference should stay at default importance.',
    importance: 5,
  });

  for (let i = 0; i < 8; i += 1) {
    appendFactRecallTrace({
      surface: 'facts_for_instructions',
      facts: [
        { fact: derived, reason: 'scored-stanford-global' },
        { fact: direct, reason: 'scored-stanford-global' },
      ],
      nowIso: `2026-07-04T12:00:0${i}.000Z`,
    });
  }

  const fixes = detectMemoryHealCandidates({ nowIso: '2026-07-04T12:01:00.000Z' });
  const fix = fixes.find((f) => f.kind === 'demote_overexposed_fact');
  assert.ok(fix, 'expected an overexposure demotion candidate');
  assert.deepEqual(fix!.targetIds, [derived.id]);

  const applied = await applyMemoryFix(fix!, { nowIso: '2026-07-04T12:02:00.000Z' });
  assert.equal(applied.ok, true);
  assert.equal(getFact(derived.id)?.active, true);
  assert.equal(getFact(derived.id)?.importance, 4);
  assert.equal(getFact(direct.id)?.importance, 5);

  const audit = readHygieneAudit(5).find((e) => e.kind === 'memory-heal');
  assert.equal((audit?.detail as { action?: string } | undefined)?.action, 'demote_overexposed_fact');
  const reverted = revertMemoryHeal(applied.auditId!, '2026-07-04T12:03:00.000Z');
  assert.equal(reverted.ok, true);
  assert.equal(getFact(derived.id)?.importance, 5);
});

test('preview candidate detection and dry-run do not persist proposals or mutate facts', async () => {
  const f = rememberFact({ kind: 'project', content: 'Preview-only internal result from memory_read.', derivedFrom: { tool: 'memory_read', sessionId: 's1' } });

  const preview = detectMemoryHealCandidates({ persistProposals: false, nowIso: '2026-07-04T12:00:00.000Z' });
  assert.ok(preview.some((fix) => fix.kind === 'retire_internal_noise' && fix.targetIds.includes(f.id)));
  assert.equal(listProposedMemoryFixes().length, 0, 'preview detection must not create proposal records');
  assert.equal(getFact(f.id)?.active, true);

  const dry = await runMemorySelfHeal({ dryRun: true, maxApply: 5, nowIso: '2026-07-04T12:01:00.000Z' });
  assert.equal(dry.ran, true);
  assert.equal(dry.applied, 1);
  assert.equal(listProposedMemoryFixes().length, 0, 'dry-run must not persist proposal records');
  assert.equal(getFact(f.id)?.active, true, 'dry-run must not mutate fact active state');
});

test('merge_duplicate: requires judge approval, merges lower-quality duplicate, and can revert', async () => {
  const keep = rememberFact({ kind: 'project', content: 'Revill Law Firm SEO report lives at revill-lawfirm.com/report.', score: 5, importance: 8 });
  const drop = rememberFact({ kind: 'project', content: 'The Revill Law Firm SEO report is at revill-lawfirm.com/report.', score: 1, importance: 6 });
  setEmbedding(keep.id, [1, 0, 0, 0]);
  setEmbedding(drop.id, [0.999, 0.001, 0, 0]);

  const fixes = detectMemoryHealCandidates({ nowIso: '2026-07-04T12:00:00.000Z' });
  const fix = fixes.find((f) => f.kind === 'merge_duplicate');
  assert.ok(fix, 'expected a merge_duplicate candidate');

  const veto = await applyMemoryFix(fix!, {
    nowIso: '2026-07-04T12:00:00.000Z',
    judge: async () => ({ verdict: 'veto', reason: 'distinct facts' }),
  });
  assert.equal(veto.ok, false);
  assert.equal(getFact(drop.id)?.active, true);

  const applied = await applyMemoryFix(fix!, {
    nowIso: '2026-07-04T12:01:00.000Z',
    judge: async () => ({ verdict: 'approve', reason: 'same fact' }),
  });
  assert.equal(applied.ok, true);
  assert.equal(getFact(drop.id)?.active, false);
  assert.equal(getFact(keep.id)?.active, true);

  const reverted = revertMemoryHeal(applied.auditId!, '2026-07-04T12:02:00.000Z');
  assert.equal(reverted.ok, true);
  assert.equal(getFact(drop.id)?.active, true);
});

test('merge_duplicate probe rejects entity-mismatched facts even with similar embeddings', async () => {
  const a = rememberFact({ kind: 'project', content: 'Revill Law Firm SEO report lives at revill-lawfirm.com/report.', score: 5 });
  const b = rememberFact({ kind: 'project', content: 'Aldous Law SEO report lives at aldouslaw.com/report.', score: 1 });
  setEmbedding(a.id, [1, 0, 0, 0]);
  setEmbedding(b.id, [0.999, 0.001, 0, 0]);
  const fixes = detectMemoryHealCandidates();
  assert.equal(fixes.some((f) => f.kind === 'merge_duplicate'), false);
});

test('supersede_stale_fact: only lower-trust derived preference is deactivated', async () => {
  const old = rememberFact({
    kind: 'user',
    content: 'Nathan prefers Tuesday calls.',
    trustLevel: 0.5,
    derivedFrom: { tool: 'calendar_read', sessionId: 's1' },
  });
  ageFact(old.id, 40);
  const newer = rememberFact({ kind: 'user', content: 'Nathan now prefers Wednesday calls.', trustLevel: 1 });

  const fixes = detectMemoryHealCandidates({ nowIso: '2026-07-04T12:00:00.000Z' });
  const fix = fixes.find((f) => f.kind === 'supersede_stale_fact');
  assert.ok(fix, 'expected supersede_stale_fact candidate');
  const applied = await applyMemoryFix(fix!, {
    nowIso: '2026-07-04T12:01:00.000Z',
    judge: async () => ({ verdict: 'approve', reason: 'newer direct correction' }),
  });
  assert.equal(applied.ok, true);
  assert.equal(getFact(old.id)?.active, false);
  assert.equal(getFact(newer.id)?.active, true);
});

test('supersede_stale_fact: user-vs-user contradictions are not auto candidates', () => {
  const old = rememberFact({ kind: 'user', content: 'Nathan prefers Tuesday calls.', trustLevel: 1 });
  ageFact(old.id, 40);
  rememberFact({ kind: 'user', content: 'Nathan now prefers Wednesday calls.', trustLevel: 1 });
  assert.equal(detectMemoryHealCandidates().some((f) => f.kind === 'supersede_stale_fact'), false);
});

test('kill switches and caps are honored', async () => {
  rememberFact({ kind: 'project', content: 'noise 1', derivedFrom: { tool: 'memory_read', sessionId: 's1' } });
  rememberFact({ kind: 'project', content: 'noise 2', derivedFrom: { tool: 'memory_read', sessionId: 's2' } });

  process.env.CLEMMY_MEMORY_SELF_HEAL = 'off';
  assert.equal((await runMemorySelfHeal({ maxApply: 5 })).ran, false);
  delete process.env.CLEMMY_MEMORY_SELF_HEAL;

  process.env.CLEMMY_MEMORY_SELF_HEAL_REAL = 'off';
  assert.equal((await runMemorySelfHeal({ maxApply: 5 })).reason, 'real-disabled');
  delete process.env.CLEMMY_MEMORY_SELF_HEAL_REAL;

  process.env.CLEMMY_MEMORY_SELF_HEAL_MAX = '1';
  const out = await runMemorySelfHeal();
  assert.equal(out.applied, 1);
});

test('supersession parser keeps correction subject stable', () => {
  const p = _memorySelfHealTest.parsePreferenceFact('Actually Nathan now prefers Wednesday calls.');
  assert.equal(p?.subject, 'nathan');
  assert.equal(p?.property, 'preference');
  assert.equal(p?.value, 'wednesday calls');
});

// ─── plain-text VETO marker parse (converted from MemoryFixVetoSchema) ──────
test('parseMemoryVetoVerdict: APPROVE / VETO markers, case + whitespace tolerant', () => {
  assert.deepEqual(parseMemoryVetoVerdict('APPROVE: same durable fact about the same client'),
    { verdict: 'approve', reason: 'same durable fact about the same client' });
  assert.deepEqual(parseMemoryVetoVerdict('VETO: these may be two different accounts'),
    { verdict: 'veto', reason: 'these may be two different accounts' });
  // lowercase marker
  assert.equal(parseMemoryVetoVerdict('veto: distinct people').verdict, 'veto');
  // leading whitespace/newlines + a missing colon
  assert.equal(parseMemoryVetoVerdict('\n  APPROVE newer high-trust correction').verdict, 'approve');
  // first line wins when the model adds trailing lines
  assert.equal(parseMemoryVetoVerdict('VETO: ambiguous\nfurther notes').verdict, 'veto');
});

test('parseMemoryVetoVerdict: FAILS CLOSED — no marker / empty output → unavailable (never a silent apply)', () => {
  assert.equal(parseMemoryVetoVerdict('Sure, this looks fine to merge.').verdict, 'unavailable', 'no marker → unavailable');
  assert.equal(parseMemoryVetoVerdict('').verdict, 'unavailable', 'empty → unavailable');
  assert.equal(parseMemoryVetoVerdict('   \n  ').verdict, 'unavailable', 'whitespace-only → unavailable');
});

test('applyMemoryFix: an "unavailable" verdict is a FAIL-CLOSED skip (the fix is NOT applied)', async () => {
  const keep = rememberFact({ kind: 'project', content: 'Revill Law Firm SEO report lives at revill-lawfirm.com/report.', score: 5, importance: 8 });
  const drop = rememberFact({ kind: 'project', content: 'The Revill Law Firm SEO report is at revill-lawfirm.com/report.', score: 1, importance: 6 });
  setEmbedding(keep.id, [1, 0, 0, 0]);
  setEmbedding(drop.id, [0.999, 0.001, 0, 0]);
  const candidates = detectMemoryHealCandidates({ nowIso: '2026-07-08T12:00:00.000Z' });
  const fix = candidates.find((c) => c.kind === 'merge_duplicate');
  assert.ok(fix, 'a duplicate merge was proposed');
  // Fail-closed only applies while the judge is REQUIRED (its normal default).
  process.env.CLEMMY_MEMORY_SELF_HEAL_JUDGE = 'on';
  try {
    const res = await applyMemoryFix(fix!, {
      nowIso: '2026-07-08T12:01:00.000Z',
      judge: async () => ({ verdict: 'unavailable', reason: 'judge timeout' }),
    });
    assert.equal(res.ok, false, 'an unreadable/unavailable verdict skips the mutation (fail closed)');
  } finally {
    process.env.CLEMMY_MEMORY_SELF_HEAL_JUDGE = 'off';
  }
});
