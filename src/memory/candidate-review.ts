import { openMemoryDb, type ConsolidatedFactKind } from './db.js';
import { consolidateFact, type ConsolidateOptions, type ConsolidateOutcome } from './reflection.js';
import { resolveReflectionCandidateById } from './reflection-candidates.js';
import { linkFactEvidence, selectSupportingExcerpt } from './temporal-memory.js';

const REVIEW_LEASE_MS = 5 * 60 * 1_000;
const ALLOWED_FACT_KINDS = new Set<ConsolidatedFactKind>(['user', 'project', 'feedback', 'reference', 'constraint']);

interface ReviewCandidateRow {
  id: number;
  candidate_hash: string;
  episode_id: string | null;
  session_id: string;
  call_id: string;
  kind: string;
  text: string;
  importance: number;
  status: string;
  trust_level: number | null;
  authority: 'user' | 'derived' | 'import' | 'manual' | null;
  source_uri: string | null;
  evidence_excerpt: string | null;
  episode_source_uri: string | null;
  source_app: string | null;
  occurred_at: string | null;
}

export interface PromoteReflectionCandidateResult {
  candidateId: number;
  factId: number;
  action: ConsolidateOutcome['action'];
  /** Other pending observations with the exact same kind and normalized claim
   * that were folded into this approval. Each keeps its own episode/evidence
   * row, but the reviewer makes one semantic decision. */
  coalescedCandidateIds: number[];
  evidenceSourcesAdded: number;
}

export interface RejectReflectionCandidateClusterResult {
  candidateId: number;
  rejectedCandidateIds: number[];
}

export interface ReconcileKnownPendingCandidatesResult {
  selected: number;
  matched: number;
  resolved: number;
  skipped: number;
  failed: number;
}

function normalizedClaim(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function readCandidate(id: number): ReviewCandidateRow | null {
  return (openMemoryDb().prepare(`
    SELECT mrc.id, mrc.candidate_hash, mrc.episode_id, mrc.session_id, mrc.call_id,
           mrc.kind, mrc.text, mrc.importance, mrc.status,
           mrc.trust_level, mrc.authority, mrc.source_uri,
           me.evidence_excerpt, me.source_uri AS episode_source_uri,
           me.source_app, me.occurred_at
    FROM memory_reflection_candidates mrc
    LEFT JOIN memory_episodes me ON me.id = mrc.episode_id
    WHERE mrc.id = ?
  `).get(id) as ReviewCandidateRow | undefined) ?? null;
}

function readPendingExactCluster(row: ReviewCandidateRow): ReviewCandidateRow[] {
  return openMemoryDb().prepare(`
    SELECT mrc.id, mrc.candidate_hash, mrc.episode_id, mrc.session_id, mrc.call_id,
           mrc.kind, mrc.text, mrc.importance, mrc.status,
           mrc.trust_level, mrc.authority, mrc.source_uri,
           me.evidence_excerpt, me.source_uri AS episode_source_uri,
           me.source_app, me.occurred_at
    FROM memory_reflection_candidates mrc
    LEFT JOIN memory_episodes me ON me.id = mrc.episode_id
    WHERE mrc.status = 'pending' AND mrc.kind = ? AND mrc.candidate_hash = ?
      AND mrc.id <> ?
    ORDER BY mrc.created_at ASC, mrc.id ASC
  `).all(row.kind, row.candidate_hash, row.id) as ReviewCandidateRow[];
}

function claimForReview(id: number, now: string, staleLease: string): boolean {
  const claimed = openMemoryDb().prepare(`
    UPDATE memory_reflection_candidates
    SET processing_started_at = ?, attempt_count = attempt_count + 1,
        last_error = NULL
    WHERE id = ? AND status = 'pending'
      AND (processing_started_at IS NULL OR processing_started_at <= ?)
  `).run(now, id, staleLease);
  return Number(claimed.changes ?? 0) === 1;
}

async function consolidateReviewedCandidate(
  row: ReviewCandidateRow,
  resolver?: ConsolidateOptions['resolver'],
): Promise<ConsolidateOutcome> {
  if (!row.episode_id) throw new Error('memory candidate source episode is unavailable');
  if (!ALLOWED_FACT_KINDS.has(row.kind as ConsolidatedFactKind)) {
    throw new Error(`unsupported memory candidate kind: ${row.kind}`);
  }
  const sourceText = row.evidence_excerpt?.trim() ?? '';
  if (!sourceText) throw new Error('memory candidate source evidence is unavailable');
  const sourceUri = row.source_uri ?? row.episode_source_uri ?? undefined;
  return consolidateFact({
    kind: row.kind as ConsolidatedFactKind,
    text: row.text,
    importance: row.importance,
    // Explicit owner review raises confidence, but `manual` authority cannot
    // rewrite a protected pinned policy. Only a direct user correction may.
    trustLevel: Math.max(0.9, row.trust_level ?? 0),
    authority: 'manual',
    sourceApp: row.source_app ?? 'Memory review',
    sourceUri,
    occurredAt: row.occurred_at ?? undefined,
    evidence: {
      episodeId: row.episode_id,
      excerpt: selectSupportingExcerpt(sourceText, row.text),
      sourceUri,
    },
  }, { sessionId: row.session_id }, resolver ? { resolver } : {});
}

function releaseFailedReview(id: number, error: unknown): void {
  openMemoryDb().prepare(`
    UPDATE memory_reflection_candidates
    SET processing_started_at = NULL, last_error = ?
    WHERE id = ? AND status = 'pending'
  `).run((error instanceof Error ? error.message : String(error)).slice(0, 500), id);
}

/** Owner-approved promotion still passes through the canonical consolidation
 * seam, so exact repeats reinforce and semantic conflicts supersede/merge
 * instead of stacking duplicate facts. The candidate is leased across the
 * asynchronous resolver; repeated clicks or replay cannot promote it twice. */
export async function promoteReflectionCandidateById(
  id: number,
  options: { now?: string; resolver?: ConsolidateOptions['resolver'] } = {},
): Promise<PromoteReflectionCandidateResult | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = readCandidate(id);
  if (!row || row.status !== 'pending' || !row.episode_id) return null;
  if (!ALLOWED_FACT_KINDS.has(row.kind as ConsolidatedFactKind)) {
    throw new Error(`unsupported memory candidate kind: ${row.kind}`);
  }
  const sourceText = row.evidence_excerpt?.trim() ?? '';
  if (!sourceText) throw new Error('memory candidate source evidence is unavailable');

  const now = options.now ?? new Date().toISOString();
  const staleLease = new Date(Date.parse(now) - REVIEW_LEASE_MS).toISOString();
  if (!claimForReview(id, now, staleLease)) return null;

  try {
    const outcome = await consolidateReviewedCandidate(row, options.resolver);
    if (!outcome.factId) throw new Error('memory consolidation did not return a canonical fact');
    const resolved = resolveReflectionCandidateById({
      id,
      status: 'promoted',
      reason: `owner_approved:${outcome.action}`,
      resultingFactId: outcome.factId,
      now,
    });
    if (!resolved) throw new Error('memory candidate changed while approval was being applied');

    // Exact duplicate proposals are source observations of the same semantic
    // decision, not separate decisions for the owner. Fan their durable
    // evidence into the just-approved canonical fact and resolve each ledger
    // row independently. Missing/busy sources remain pending and visible.
    const coalescedCandidateIds: number[] = [];
    for (const duplicate of readPendingExactCluster(row)) {
      if (!duplicate.episode_id || !duplicate.evidence_excerpt?.trim()) continue;
      if (!claimForReview(duplicate.id, now, staleLease)) continue;
      try {
        const duplicateOutcome = await consolidateReviewedCandidate(duplicate, options.resolver);
        if (!duplicateOutcome.factId || duplicateOutcome.factId !== outcome.factId) {
          throw new Error('exact review cluster resolved to a different canonical fact');
        }
        const duplicateResolved = resolveReflectionCandidateById({
          id: duplicate.id,
          status: 'promoted',
          reason: `owner_approved_exact_cluster:${duplicateOutcome.action}`,
          resultingFactId: duplicateOutcome.factId,
          now,
        });
        if (!duplicateResolved) throw new Error('duplicate candidate changed while approval was being applied');
        coalescedCandidateIds.push(duplicate.id);
      } catch (error) {
        releaseFailedReview(duplicate.id, error);
      }
    }
    return {
      candidateId: id,
      factId: outcome.factId,
      action: outcome.action,
      coalescedCandidateIds,
      evidenceSourcesAdded: 1 + coalescedCandidateIds.length,
    };
  } catch (error) {
    releaseFailedReview(id, error);
    throw error;
  }
}

/** Reject every pending exact observation of one claim in a single review
 * decision. Source episodes remain immutable and queryable; only their claim
 * proposals are resolved. Rows under an active promotion lease are left alone
 * rather than racing the writer. */
export function rejectReflectionCandidateClusterById(
  id: number,
  now = new Date().toISOString(),
): RejectReflectionCandidateClusterResult | null {
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = readCandidate(id);
  if (!row || row.status !== 'pending') return null;
  const db = openMemoryDb();
  return db.transaction(() => {
    const candidates = db.prepare(`
      SELECT id FROM memory_reflection_candidates
      WHERE status = 'pending' AND kind = ? AND candidate_hash = ?
        AND processing_started_at IS NULL
      ORDER BY created_at ASC, id ASC
    `).all(row.kind, row.candidate_hash) as Array<{ id: number }>;
    if (!candidates.some((candidate) => candidate.id === id)) return null;
    const ids = candidates.map((candidate) => candidate.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`
      UPDATE memory_reflection_candidates
      SET status = 'rejected', reason = 'owner_rejected_exact_cluster',
          resolved_at = ?, processing_started_at = NULL,
          next_attempt_at = NULL, last_error = NULL
      WHERE id IN (${placeholders}) AND status = 'pending'
    `).run(now, ...ids);
    return { candidateId: id, rejectedCandidateIds: ids };
  })();
}

/** Close proposals whose exact semantic claim is already active without
 * asking the owner to approve the same truth again. This does not write,
 * rewrite, reactivate, reprioritize, or raise trust on a canonical fact; it
 * only adds the surviving source excerpt as evidence and points the auditable
 * candidate row at the existing fact. Semantic/paraphrase matches are never
 * eligible for this automatic path. */
export function reconcileKnownPendingCandidates(options: {
  limit?: number;
  now?: string;
} = {}): ReconcileKnownPendingCandidatesResult {
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  const now = options.now ?? new Date().toISOString();
  const staleLease = new Date(Date.parse(now) - REVIEW_LEASE_MS).toISOString();
  const db = openMemoryDb();
  const rows = db.prepare(`
    SELECT mrc.id, mrc.candidate_hash, mrc.episode_id, mrc.session_id, mrc.call_id,
           mrc.kind, mrc.text, mrc.importance, mrc.status,
           mrc.trust_level, mrc.authority, mrc.source_uri,
           me.evidence_excerpt, me.source_uri AS episode_source_uri,
           me.source_app, me.occurred_at
    FROM memory_reflection_candidates mrc
    JOIN memory_episodes me ON me.id = mrc.episode_id
    WHERE mrc.status = 'pending'
      AND TRIM(COALESCE(me.evidence_excerpt, '')) <> ''
      AND (mrc.processing_started_at IS NULL OR mrc.processing_started_at <= ?)
    ORDER BY mrc.created_at ASC, mrc.id ASC
    LIMIT 5000
  `).all(staleLease) as ReviewCandidateRow[];
  const facts = db.prepare(`
    SELECT id, kind, content FROM consolidated_facts WHERE active = 1
  `).all() as Array<{ id: number; kind: string; content: string }>;
  const exactFacts = new Map(facts.map((fact) => [`${fact.kind}\u001f${normalizedClaim(fact.content)}`, fact.id]));
  const result: ReconcileKnownPendingCandidatesResult = {
    selected: 0,
    matched: 0,
    resolved: 0,
    skipped: 0,
    failed: 0,
  };
  for (const row of rows) {
    if (result.matched >= limit) break;
    result.selected += 1;
    const factId = exactFacts.get(`${row.kind}\u001f${normalizedClaim(row.text)}`);
    if (!factId) {
      result.skipped += 1;
      continue;
    }
    result.matched += 1;
    if (!row.episode_id || !row.evidence_excerpt?.trim() || !claimForReview(row.id, now, staleLease)) {
      result.skipped += 1;
      continue;
    }
    try {
      linkFactEvidence({
        factId,
        episodeId: row.episode_id,
        excerpt: selectSupportingExcerpt(row.evidence_excerpt, row.text),
        sourceUri: row.source_uri ?? row.episode_source_uri,
      });
      const resolved = resolveReflectionCandidateById({
        id: row.id,
        status: 'promoted',
        reason: 'automatic_exact_reinforce',
        resultingFactId: factId,
        now,
      });
      if (!resolved) throw new Error('known candidate changed while evidence was being attached');
      result.resolved += 1;
    } catch (error) {
      releaseFailedReview(row.id, error);
      result.failed += 1;
    }
  }
  return result;
}

export function rejectReflectionCandidateById(id: number, now = new Date().toISOString()): boolean {
  if (!Number.isInteger(id) || id <= 0) return false;
  return resolveReflectionCandidateById({
    id,
    status: 'rejected',
    reason: 'owner_rejected',
    now,
  });
}
