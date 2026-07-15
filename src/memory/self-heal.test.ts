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
const { rememberFact, getFact, getFactValidityIntervals, setFactPinned } = await import('./facts.js');
// eslint-disable-next-line import/first
const { vectorToBuffer, _setEmbeddingProviderForTest } = await import('./embeddings.js');
// eslint-disable-next-line import/first
const { readHygieneAudit } = await import('./hygiene-audit.js');
// eslint-disable-next-line import/first
const { appendFactRecallTrace } = await import('./recall-trace.js');
// eslint-disable-next-line import/first
const { getFactEvidence } = await import('./temporal-memory.js');
// eslint-disable-next-line import/first
const { upsertEntity } = await import('./reflection.js');
// eslint-disable-next-line import/first
const { upsertResourcePointer } = await import('./source-map.js');
// eslint-disable-next-line import/first
const {
  setFactEntityLinks,
  setFactResourceLinks,
  loadFactEntityEdges,
  loadFactResourceEdges,
} = await import('./relations.js');
// eslint-disable-next-line import/first
const {
  detectMemoryHealCandidates,
  applyMemoryFix,
  runMemorySelfHeal,
  revertMemoryHeal,
  listProposedMemoryFixes,
  parseMemoryVetoVerdict,
  looksLikeLegacyTransientRequest,
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

test('legacy conversational requests enter review but are never retired automatically', async () => {
  const request = rememberFact({ kind: 'user', content: 'Can you fix the memory graph and show me what changed' });
  const declarative = rememberFact({ kind: 'user', content: 'Nathan prefers concise progress updates.' });

  const candidates = detectMemoryHealCandidates({ persistProposals: true, maxCandidates: 20, nowIso: '2027-07-04T12:00:00.000Z' });
  const fix = candidates.find((candidate) => candidate.kind === 'retire_transient_request' && candidate.targetIds.includes(request.id));
  assert.ok(fix, 'the legacy request should be proposed for review');
  assert.equal(candidates.some((candidate) => candidate.targetIds.includes(declarative.id)), false);

  const automatic = await runMemorySelfHeal({ maxApply: 20, nowIso: '2027-07-04T12:01:00.000Z' });
  assert.equal(automatic.applied, 0);
  assert.ok(automatic.skipped.some((item) => item.id === fix!.id && /review required/.test(item.reason)));
  assert.equal(getFact(request.id)?.active, true, 'scheduled cleanup must leave the request untouched');

  const applied = await applyMemoryFix(fix!, { nowIso: '2027-07-04T12:02:00.000Z' });
  assert.equal(applied.ok, true);
  assert.equal(getFact(request.id)?.active, false);
  assert.equal(getFact(declarative.id)?.active, true);

  const reverted = revertMemoryHeal(applied.auditId!, '2027-07-04T12:03:00.000Z');
  assert.equal(reverted.ok, true);
  assert.equal(getFact(request.id)?.active, true);
  const intervals = getFactValidityIntervals(request.id);
  assert.equal(intervals.length, 2, 'revert opens a new validity period instead of erasing the retirement gap');
  assert.equal(intervals[0]?.validFrom, '2027-07-04T12:03:00.000Z');
  assert.equal(intervals[0]?.validTo, null);
  assert.equal(intervals[1]?.validTo, '2027-07-04T12:02:00.000Z');
});

test('legacy request shape detector excludes durable capture wrappers and proper-name declaratives', () => {
  assert.equal(looksLikeLegacyTransientRequest('How people get replayed and added without duplicate memory?'), true);
  assert.equal(looksLikeLegacyTransientRequest('Please search my recorded meetings'), true);
  assert.equal(looksLikeLegacyTransientRequest('Quick task: briefly analyze one client and send me the result'), true);
  assert.equal(looksLikeLegacyTransientRequest('Go ahead and email the summary when ready'), true);
  assert.equal(looksLikeLegacyTransientRequest('I need you to remember this meeting'), true);
  assert.equal(looksLikeLegacyTransientRequest('User explicitly asked Clementine to remember: How the Orchid account is billed.'), false);
  assert.equal(looksLikeLegacyTransientRequest('Send the pipeline report every Monday to the sales list.'), false);
  assert.equal(looksLikeLegacyTransientRequest('Email outreach execution chronically fails on sender identity and recipient integrity.'), false);
  assert.equal(looksLikeLegacyTransientRequest('When pulling Salesforce accounts, only include accounts with a real named contact.'), false);
  assert.equal(looksLikeLegacyTransientRequest('When recalling meetings, lead with decisions, owners, and next actions.'), false);
  assert.equal(looksLikeLegacyTransientRequest('When writing client updates, use concise outcome-first language.'), false);
  assert.equal(looksLikeLegacyTransientRequest('When meeting Sarah tomorrow, send the draft.'), true);
  assert.equal(looksLikeLegacyTransientRequest('When reviewing this, can you fix the title?'), true);
  assert.equal(looksLikeLegacyTransientRequest('When Nate says “scorpion email,” it refers to his main Outlook account.'), false);
  assert.equal(looksLikeLegacyTransientRequest('Will Smith is attached to the Acme project.'), false);
  assert.equal(looksLikeLegacyTransientRequest('Clementine requirement: always ask before deleting a memory.'), false);
});

test('legacy transient review scans the complete direct-fact pool beyond the former 5000-row ceiling', () => {
  const db = openMemoryDb();
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO consolidated_facts
      (kind, content, content_hash, score, active, created_at, updated_at, importance, pinned)
    VALUES ('user', ?, ?, 1, 1, ?, ?, 5, 0)
  `);
  db.transaction(() => {
    for (let i = 0; i < 5001; i += 1) {
      insert.run(`Nathan has durable profile attribute number ${i}.`, `self-heal-direct-tail-${i}`, now, now);
    }
  })();
  const request = rememberFact({ kind: 'user', content: 'Can you fix the view here because I am not seeing the data' });

  const fix = detectMemoryHealCandidates({
    kinds: ['retire_transient_request'], persistProposals: false, maxCandidates: 200,
  }).find((candidate) => candidate.targetIds.includes(request.id));
  assert.ok(fix, 'a conversational request beyond the former direct-fact scan ceiling remains reviewable');
});

test('internal-noise review scans the complete derived pool beyond the former 1000-row ceiling', () => {
  const db = openMemoryDb();
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO consolidated_facts
      (kind, content, content_hash, score, active, created_at, updated_at,
       derived_from_session_id, derived_from_tool, importance, pinned)
    VALUES ('project', ?, ?, 1, 1, ?, ?, 'tail-session', 'calendar_read', 5, 0)
  `);
  db.transaction(() => {
    for (let i = 0; i < 1001; i += 1) {
      insert.run(`Durable calendar observation number ${i}.`, `self-heal-derived-tail-${i}`, now, now);
    }
  })();
  const noise = rememberFact({
    kind: 'project',
    content: 'Internal memory lookup result should stay out of durable knowledge.',
    derivedFrom: { tool: 'memory_read', sessionId: 'tail-noise-session' },
  });

  const fix = detectMemoryHealCandidates({
    kinds: ['retire_internal_noise'], persistProposals: false, maxCandidates: 200,
  }).find((candidate) => candidate.targetIds.includes(noise.id));
  assert.ok(fix, 'self-referential tool noise beyond the former derived-fact scan ceiling remains reviewable');
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
  const companyId = upsertEntity({ type: 'company', name: 'Revill Law Firm' });
  const report = upsertResourcePointer({
    app: 'Google Drive', kind: 'file', name: 'Revill SEO Report', providerId: 'revill-report',
  });
  const [dropEvidence] = getFactEvidence(drop.id);
  assert.ok(dropEvidence);
  setFactEntityLinks(keep.id, [companyId], { linkType: 'inferred_text', confidence: 0.55 });
  setFactEntityLinks(drop.id, [companyId], {
    linkType: 'stored', confidence: 0.96,
    evidenceEpisodeId: dropEvidence.episodeId, evidenceExcerpt: dropEvidence.excerpt,
  });
  setFactResourceLinks(drop.id, [report.id], {
    linkType: 'stored', confidence: 0.95,
    evidenceEpisodeId: dropEvidence.episodeId, evidenceExcerpt: dropEvidence.excerpt,
  });
  openMemoryDb().prepare(`
    UPDATE consolidated_facts
    SET access_count = 1, impression_count = 2, utility_count = 1,
        last_accessed_at = '2026-07-01T10:00:00.000Z', last_used_at = '2026-07-01T10:00:00.000Z'
    WHERE id = ?
  `).run(keep.id);
  openMemoryDb().prepare(`
    UPDATE consolidated_facts
    SET access_count = 2, impression_count = 3, utility_count = 2,
        last_accessed_at = '2026-07-02T10:00:00.000Z', last_used_at = '2026-07-02T10:00:00.000Z'
    WHERE id = ?
  `).run(drop.id);
  setEmbedding(keep.id, [1, 0, 0, 0]);
  setEmbedding(drop.id, [0.999, 0.001, 0, 0]);

  const fixes = detectMemoryHealCandidates({ nowIso: '2026-07-04T12:00:00.000Z' });
  const fix = fixes.find((f) => f.kind === 'merge_duplicate');
  assert.ok(fix, 'expected a merge_duplicate candidate');

  const automatic = await runMemorySelfHeal({ maxApply: 5, nowIso: '2026-07-04T12:00:30.000Z' });
  assert.equal(automatic.applied, 0, 'nightly self-heal never executes a semantic merge');
  assert.ok(automatic.skipped.some((item) => item.id === fix!.id && /review required/.test(item.reason)));
  assert.equal(getFact(drop.id)?.active, true, 'review candidate remains active until explicit approval');

  const veto = await applyMemoryFix(fix!, {
    nowIso: '2026-07-04T12:00:00.000Z',
    judge: async () => ({ verdict: 'veto', reason: 'distinct facts' }),
  });
  assert.equal(veto.ok, false);
  assert.equal(getFact(drop.id)?.active, true);

  const applied = await applyMemoryFix(fix!, {
    nowIso: '2026-07-04T12:01:00.000Z',
    humanApproved: true,
  });
  assert.equal(applied.ok, true);
  assert.equal(getFact(drop.id)?.active, false);
  assert.equal(getFact(drop.id)?.supersededByFactId, keep.id, 'inactive duplicate points to its canonical fact');
  assert.equal(getFact(drop.id)?.validTo, '2026-07-04T12:01:00.000Z');
  assert.equal(getFact(keep.id)?.active, true);
  assert.equal(getFact(keep.id)?.impressionCount, 5, 'passive exposure history is folded without becoming utility');
  assert.equal(getFact(keep.id)?.utilityCount, 3, 'material-use history follows the canonical claim');
  assert.equal(getFact(keep.id)?.lastUsedAt, '2026-07-02T10:00:00.000Z');
  assert.equal(getFactEvidence(keep.id).length, 2, 'both independent source episodes remain attached');
  const mergedEntity = loadFactEntityEdges([keep.id]).find((edge) => edge.entityId === companyId);
  assert.equal(mergedEntity?.truth, 'stored', 'strong grounded identity link upgrades the inferred canonical link');
  assert.equal(mergedEntity?.evidenceEpisodeId, dropEvidence.episodeId);
  const mergedResource = loadFactResourceEdges([keep.id]).find((edge) => edge.resourceId === report.id);
  assert.equal(mergedResource?.truth, 'stored', 'resource provenance moves with the canonical claim');
  assert.match(applied.message, /preserved 1 evidence source and 2 graph links/);

  const reverted = revertMemoryHeal(applied.auditId!, '2026-07-04T12:02:00.000Z');
  assert.equal(reverted.ok, true);
  assert.equal(getFact(drop.id)?.active, true);
  assert.equal(getFact(drop.id)?.supersededByFactId, null);
  assert.equal(getFact(keep.id)?.impressionCount, 2);
  assert.equal(getFact(keep.id)?.utilityCount, 1);
  assert.equal(getFactEvidence(keep.id).length, 1, 'revert removes only evidence copied by the merge');
  assert.equal(loadFactEntityEdges([keep.id]).find((edge) => edge.entityId === companyId)?.truth, 'inferred');
  assert.equal(loadFactResourceEdges([keep.id]).some((edge) => edge.resourceId === report.id), false);
});

test('merge_duplicate probe rejects entity-mismatched facts even with similar embeddings', async () => {
  const a = rememberFact({ kind: 'project', content: 'Revill Law Firm SEO report lives at revill-lawfirm.com/report.', score: 5 });
  const b = rememberFact({ kind: 'project', content: 'Aldous Law SEO report lives at aldouslaw.com/report.', score: 1 });
  setEmbedding(a.id, [1, 0, 0, 0]);
  setEmbedding(b.id, [0.999, 0.001, 0, 0]);
  const fixes = detectMemoryHealCandidates();
  assert.equal(fixes.some((f) => f.kind === 'merge_duplicate'), false);
});

test('merge_duplicate canonical selection uses material utility, never passive exposure', () => {
  const overexposed = rememberFact({
    kind: 'project',
    content: 'The Atlas renewal review is scheduled for Thursday morning.',
    score: 1,
    importance: 5,
  });
  const useful = rememberFact({
    kind: 'project',
    content: 'Atlas renewal review is scheduled Thursday morning.',
    score: 1,
    importance: 5,
  });
  openMemoryDb().prepare(`
    UPDATE consolidated_facts
    SET access_count = 1000, impression_count = 1000, utility_count = 0
    WHERE id = ?
  `).run(overexposed.id);
  openMemoryDb().prepare(`
    UPDATE consolidated_facts
    SET access_count = 0, impression_count = 0, utility_count = 5
    WHERE id = ?
  `).run(useful.id);
  setEmbedding(overexposed.id, [1, 0, 0, 0]);
  setEmbedding(useful.id, [0.999, 0.001, 0, 0]);

  const fix = detectMemoryHealCandidates({ persistProposals: false })
    .find((candidate) => candidate.kind === 'merge_duplicate');
  assert.ok(fix);
  assert.equal((fix!.payload as { keepId: number }).keepId, useful.id,
    'one explicit material-use history outweighs any number of passive impressions');
  assert.equal((fix!.payload as { dropId: number }).dropId, overexposed.id);
});

test('merge_duplicate scans the complete active fact pool beyond the former 1500-row sample', () => {
  const db = openMemoryDb();
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO consolidated_facts
      (kind, content, content_hash, score, active, created_at, updated_at, importance, pinned)
    VALUES ('reference', ?, ?, 1, 1, ?, ?, 10, 0)
  `);
  db.transaction(() => {
    for (let i = 0; i < 1501; i += 1) {
      insert.run(`Synthetic high-priority filler memory ${i}.`, `self-heal-tail-filler-${i}`, now, now);
    }
  })();

  const first = rememberFact({
    kind: 'project',
    content: 'Tail account renewal report lives in the Atlas client folder.',
    importance: 1,
  });
  const second = rememberFact({
    kind: 'project',
    content: 'The Tail account renewal report is in the Atlas client folder.',
    importance: 1,
  });
  setEmbedding(first.id, [1, 0, 0, 0]);
  setEmbedding(second.id, [0.999, 0.001, 0, 0]);

  const fix = detectMemoryHealCandidates({ persistProposals: false, maxCandidates: 200 })
    .find((candidate) => candidate.kind === 'merge_duplicate'
      && candidate.targetIds.includes(first.id)
      && candidate.targetIds.includes(second.id));
  assert.ok(fix, 'a duplicate outside the former 1500-row recency/importance sample remains reviewable');
});

test('fix-family filtering prevents unrelated hygiene candidates from starving duplicate review', () => {
  for (let i = 0; i < 5; i += 1) {
    rememberFact({
      kind: 'project',
      content: `Internal memory tool result ${i}.`,
      derivedFrom: { tool: 'memory_read', sessionId: `noise-${i}` },
    });
  }
  const first = rememberFact({ kind: 'project', content: 'Atlas launch review happens Friday at ten.' });
  const second = rememberFact({ kind: 'project', content: 'The Atlas launch review is Friday at ten.' });
  setEmbedding(first.id, [1, 0, 0, 0]);
  setEmbedding(second.id, [0.999, 0.001, 0, 0]);

  const unscoped = detectMemoryHealCandidates({ persistProposals: false, maxCandidates: 1 });
  assert.equal(unscoped[0]?.kind, 'retire_internal_noise', 'the shared legacy ordering would consume the cap');
  const duplicateOnly = detectMemoryHealCandidates({
    kinds: ['merge_duplicate'],
    persistProposals: false,
    maxCandidates: 1,
  });
  assert.equal(duplicateOnly[0]?.kind, 'merge_duplicate');
  assert.ok(duplicateOnly[0]?.targetIds.includes(first.id));
  assert.ok(duplicateOnly[0]?.targetIds.includes(second.id));
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
