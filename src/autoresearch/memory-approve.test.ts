/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-memory-approve npx tsx --test src/autoresearch/memory-approve.test.ts
 *
 * Covers the auto-research P2 APPROVE path. Unlike P1 these touch real user
 * knowledge, so the tests assert the full defensive contract: soft-only,
 * server-re-derived, pinned-exempt (incl. at the seam), no-wrong-drop, capped,
 * audited, reversible, dry-run, and a SEPARATE kill-switch from the nightly
 * janitor. Fully offline; embeddings off (no key in the fresh test home).
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-memory-approve';
process.env.CLEMENTINE_HOME = TEST_HOME;
delete process.env.CLEMMY_MEMORY_APPROVE;

// eslint-disable-next-line import/first
const { resetMemoryDb, openMemoryDb } = await import('../memory/db.js');
// eslint-disable-next-line import/first
const { rememberFact, getFact, reactivateFact, setFactPinned, updateFact } = await import('../memory/facts.js');
// eslint-disable-next-line import/first
const { readHygieneAudit } = await import('../memory/hygiene-audit.js');
// eslint-disable-next-line import/first
const { approveDuplicateMerges, liftRecallGaps, retireInternalNoise } = await import('./memory-approve.js');
// eslint-disable-next-line import/first
const { detectRecallGaps } = await import('./memory-detectors.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});
beforeEach(() => {
  resetMemoryDb();
  openMemoryDb();
});

/** Backdate created_at + null last_accessed so a fact reads as an old never-recalled gap. */
function ageFact(id: number, days: number) {
  const db = openMemoryDb();
  const iso = new Date(Date.now() - days * 86400_000).toISOString();
  db.prepare('UPDATE consolidated_facts SET created_at = ?, last_accessed_at = NULL WHERE id = ?').run(iso, id);
}

// ─── (a) approveDuplicateMerges ─────────────────────────────────────────────

test('merge: soft-deletes dropId, keeps keepId', () => {
  const keep = rememberFact({ kind: 'project', content: 'The console redesign lives on feat/console-web-redesign.', score: 5 });
  const drop = rememberFact({ kind: 'project', content: 'Console redesign is on the feat/console-web-redesign branch.', score: 2 });
  const r = approveDuplicateMerges({ pairs: [{ keepId: keep.id, dropId: drop.id }] });
  assert.equal(r.applied, 1);
  assert.equal(getFact(drop.id)?.active, false);
  assert.equal(getFact(keep.id)?.active, true);
});

test('merge: reversible — dropId restores', () => {
  const keep = rememberFact({ kind: 'project', content: 'A keep fact', score: 5 });
  const drop = rememberFact({ kind: 'project', content: 'A drop fact', score: 1 });
  approveDuplicateMerges({ pairs: [{ keepId: keep.id, dropId: drop.id }] });
  assert.equal(reactivateFact(drop.id), true);
  assert.equal(getFact(drop.id)?.active, true);
});

test('merge: no-wrong-drop — refuses when live dropId.score > keepId.score', () => {
  const keep = rememberFact({ kind: 'project', content: 'lower scored keep', score: 1 });
  const drop = rememberFact({ kind: 'project', content: 'higher scored drop', score: 9 });
  const r = approveDuplicateMerges({ pairs: [{ keepId: keep.id, dropId: drop.id }] });
  assert.equal(r.applied, 0);
  assert.equal(r.skipped[0]?.reason, 'stale-score');
  assert.equal(getFact(drop.id)?.active, true, 'the better fact is NOT deleted');
});

test('merge: pinned-exempt at the seam', () => {
  const keep = rememberFact({ kind: 'project', content: 'keep', score: 5 });
  const drop = rememberFact({ kind: 'project', content: 'drop', score: 1 });
  setFactPinned(drop.id, true); // pinned AFTER snapshot — the TOCTOU case
  const r = approveDuplicateMerges({ pairs: [{ keepId: keep.id, dropId: drop.id }] });
  assert.equal(r.applied, 0);
  assert.equal(r.skipped[0]?.reason, 'pinned');
  assert.equal(getFact(drop.id)?.active, true);
});

test('merge: skips not-found / inactive', () => {
  const keep = rememberFact({ kind: 'project', content: 'keep', score: 5 });
  const r = approveDuplicateMerges({ pairs: [{ keepId: keep.id, dropId: 99999 }] });
  assert.equal(r.applied, 0);
  assert.equal(r.skipped[0]?.reason, 'not-found');
});

test('merge: capped + remaining', () => {
  const pairs = [];
  for (let i = 0; i < 30; i += 1) {
    const keep = rememberFact({ kind: 'project', content: `keep ${i}`, score: 5 });
    const drop = rememberFact({ kind: 'project', content: `drop ${i}`, score: 1 });
    pairs.push({ keepId: keep.id, dropId: drop.id });
  }
  const r = approveDuplicateMerges({ pairs });
  assert.ok(r.applied <= 25);
  assert.equal(r.applied, 25);
  assert.equal(r.remaining, 5);
});

test('merge: audited (kind approve-dedup)', () => {
  const keep = rememberFact({ kind: 'project', content: 'keep', score: 5 });
  const drop = rememberFact({ kind: 'project', content: 'drop', score: 1 });
  approveDuplicateMerges({ pairs: [{ keepId: keep.id, dropId: drop.id }] });
  const top = readHygieneAudit(5).find((e) => e.kind === 'approve-dedup');
  assert.ok(top, 'an approve-dedup audit entry exists');
  assert.ok(top!.ids.includes(drop.id));
});

test('merge: audit pairs is NOT over-reported when one dropId appears in two pairs', () => {
  const keepA = rememberFact({ kind: 'project', content: 'keep A', score: 5 });
  const keepB = rememberFact({ kind: 'project', content: 'keep B', score: 5 });
  const drop = rememberFact({ kind: 'project', content: 'shared drop', score: 1 });
  const r = approveDuplicateMerges({ pairs: [{ keepId: keepA.id, dropId: drop.id }, { keepId: keepB.id, dropId: drop.id }] });
  assert.equal(r.applied, 1);
  assert.deepEqual(r.ids, [drop.id]);
  const top = readHygieneAudit(5).find((e) => e.kind === 'approve-dedup')!;
  const pairs = (top.detail as { pairs: Array<{ keepId: number; dropId: number }> }).pairs;
  assert.equal(pairs.length, 1, 'audit records exactly the one pair that triggered the delete');
  assert.equal(pairs[0].keepId, keepA.id);
});

test('merge: dry-run does not mutate', () => {
  const keep = rememberFact({ kind: 'project', content: 'keep', score: 5 });
  const drop = rememberFact({ kind: 'project', content: 'drop', score: 1 });
  const r = approveDuplicateMerges({ pairs: [{ keepId: keep.id, dropId: drop.id }], dryRun: true });
  assert.equal(r.applied, 1);
  assert.equal(getFact(drop.id)?.active, true);
});

test('merge: kill-switch CLEMMY_MEMORY_APPROVE=off', () => {
  const keep = rememberFact({ kind: 'project', content: 'keep', score: 5 });
  const drop = rememberFact({ kind: 'project', content: 'drop', score: 1 });
  process.env.CLEMMY_MEMORY_APPROVE = 'off';
  try {
    const r = approveDuplicateMerges({ pairs: [{ keepId: keep.id, dropId: drop.id }] });
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'disabled');
    assert.equal(getFact(drop.id)?.active, true);
  } finally {
    delete process.env.CLEMMY_MEMORY_APPROVE;
  }
});

// ─── (b) liftRecallGaps ─────────────────────────────────────────────────────

test('lift: raises importance of an old, high-importance, never-recalled fact', () => {
  const f = rememberFact({ kind: 'project', content: 'A high-value buried fact', importance: 8 });
  ageFact(f.id, 30);
  const r = liftRecallGaps();
  assert.equal(r.applied, 1);
  assert.equal(getFact(f.id)?.importance, 9);
});

test('lift: does NOT change content (no rephrase) — content + hash stable', () => {
  const content = 'Verbatim high-value fact that must not be reworded';
  const f = rememberFact({ kind: 'project', content, importance: 7 });
  ageFact(f.id, 30);
  const db = openMemoryDb();
  const before = db.prepare('SELECT content_hash FROM consolidated_facts WHERE id = ?').get(f.id) as { content_hash: string };
  liftRecallGaps();
  const after = db.prepare('SELECT content, content_hash FROM consolidated_facts WHERE id = ?').get(f.id) as { content: string; content_hash: string };
  assert.equal(after.content, content);
  assert.equal(after.content_hash, before.content_hash);
});

test('lift: tightened predicate — trust=1.0 mundane fact is NOT a candidate', () => {
  // trust 1.0 but importance 5 → the old detector OR-clause swept these in; lift must not.
  const f = rememberFact({ kind: 'user', content: 'A mundane directly-stated fact', importance: 5, trustLevel: 1.0 });
  ageFact(f.id, 30);
  const r = liftRecallGaps();
  assert.equal(r.applied, 0);
  assert.equal(getFact(f.id)?.importance, 5);
});

test('lift: skips facts already at importance 10', () => {
  const f = rememberFact({ kind: 'project', content: 'already maxed', importance: 10 });
  ageFact(f.id, 30);
  const r = liftRecallGaps();
  assert.equal(r.applied, 0); // predicate excludes imp>=10
});

test('lift: audited (kind approve-lift) + records priorImportance', () => {
  const f = rememberFact({ kind: 'project', content: 'buried', importance: 8 });
  ageFact(f.id, 30);
  liftRecallGaps();
  const top = readHygieneAudit(5).find((e) => e.kind === 'approve-lift');
  assert.ok(top);
  assert.equal((top!.detail as { priorImportance: Record<number, number> }).priorImportance[f.id], 8);
});

test('lift: reports reason "no-eligible" when the detector counts gaps the boost cannot act on', () => {
  // An imp-10 aged never-recalled fact: the DETECTOR counts it (importance>=7),
  // but the action can't lift it (already max) → enabled-button no-op guard.
  const f = rememberFact({ kind: 'project', content: 'maxed but never recalled', importance: 10 });
  ageFact(f.id, 30);
  assert.equal(detectRecallGaps().count, 1, 'detector still counts the imp-10 gap');
  const r = liftRecallGaps();
  assert.equal(r.ran, true);
  assert.equal(r.applied, 0);
  assert.equal(r.reason, 'no-eligible');
});

test('detector recall-gap predicate is in sync with the boost: trust=1.0/imp5 counts in neither', () => {
  const f = rememberFact({ kind: 'user', content: 'mundane stated fact', importance: 5, trustLevel: 1.0 });
  ageFact(f.id, 30);
  assert.equal(detectRecallGaps().count, 0, 'tightened detector no longer inflates with trust=1.0 mundane facts');
  assert.equal(liftRecallGaps().applied, 0);
});

test('lift: dry-run + kill-switch', () => {
  const f = rememberFact({ kind: 'project', content: 'buried', importance: 8 });
  ageFact(f.id, 30);
  assert.equal(liftRecallGaps({ dryRun: true }).applied, 1);
  assert.equal(getFact(f.id)?.importance, 8, 'dry-run did not mutate');
  process.env.CLEMMY_MEMORY_APPROVE = 'off';
  try {
    assert.equal(liftRecallGaps().ran, false);
  } finally { delete process.env.CLEMMY_MEMORY_APPROVE; }
});

// ─── (c) retireInternalNoise ────────────────────────────────────────────────

test('retire: soft-deletes self-tool facts, keeps reflectable-tool facts', () => {
  const noise = rememberFact({ kind: 'project', content: 'from memory_read', derivedFrom: { tool: 'memory_read', sessionId: 's1' } });
  const exec = rememberFact({ kind: 'project', content: 'from execution_status', derivedFrom: { tool: 'execution_status', sessionId: 's2' } });
  const real = rememberFact({ kind: 'project', content: 'from read_file (a real signal)', derivedFrom: { tool: 'read_file', sessionId: 's3' } });
  const r = retireInternalNoise();
  assert.equal(r.applied, 2);
  assert.equal(getFact(noise.id)?.active, false);
  assert.equal(getFact(exec.id)?.active, false);
  assert.equal(getFact(real.id)?.active, true, 'read_file is reflectable — untouched');
});

test('retire: pinned self-tool fact is exempt + reversible', () => {
  const noise = rememberFact({ kind: 'project', content: 'pinned noise', derivedFrom: { tool: 'task_get', sessionId: 's1' } });
  setFactPinned(noise.id, true);
  const r = retireInternalNoise();
  assert.equal(r.applied, 0);
  assert.equal(getFact(noise.id)?.active, true);
});

test('retire: reversible + audited + capped + dry-run + kill-switch', () => {
  const ids: number[] = [];
  for (let i = 0; i < 30; i += 1) {
    ids.push(rememberFact({ kind: 'project', content: `noise ${i}`, derivedFrom: { tool: 'memory_read', sessionId: `s${i}` } }).id);
  }
  // dry-run
  assert.equal(retireInternalNoise({ dryRun: true }).applied <= 25, true);
  assert.equal(getFact(ids[0])?.active, true, 'dry-run did not mutate');
  // real, capped
  const r = retireInternalNoise();
  assert.equal(r.applied, 25);
  assert.equal(r.remaining, 5);
  // reversible
  assert.equal(reactivateFact(r.ids[0]), true);
  // audited
  assert.ok(readHygieneAudit(5).some((e) => e.kind === 'approve-retire'));
  // kill-switch
  process.env.CLEMMY_MEMORY_APPROVE = 'off';
  try { assert.equal(retireInternalNoise().ran, false); }
  finally { delete process.env.CLEMMY_MEMORY_APPROVE; }
});

// ─── cross-cutting ──────────────────────────────────────────────────────────

test('all approve actions are soft: the row always survives (never hard-deleted)', () => {
  const keep = rememberFact({ kind: 'project', content: 'keep', score: 5 });
  const drop = rememberFact({ kind: 'project', content: 'drop', score: 1 });
  approveDuplicateMerges({ pairs: [{ keepId: keep.id, dropId: drop.id }] });
  const db = openMemoryDb();
  const row = db.prepare('SELECT id, active FROM consolidated_facts WHERE id = ?').get(drop.id) as { id: number; active: number } | undefined;
  assert.ok(row, 'row still exists');
  assert.equal(row!.active, 0, 'only the active flag flipped');
});
