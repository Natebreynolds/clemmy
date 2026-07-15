import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { openMemoryDb } from './db.js';

export type ReflectionCandidateStatus = 'pending' | 'promoted' | 'rejected' | 'expired';
export type ReflectionCandidateSourceType = 'tool_reflection' | 'recursive_reflection' | 'auto_capture' | 'meeting_analysis' | 'manual' | 'import';

export interface ReflectionCandidateHealth {
  total: number;
  pending: number;
  pendingUniqueClaims: number;
  duplicatePendingObservations: number;
  knownExactPending: number;
  promoted: number;
  rejected: number;
  expired: number;
  overduePending: number;
  orphanedPending: number;
  retrying: number;
  failedPending: number;
  oldestPending: string | null;
  promotionRate: number | null;
  rejectionReasons: Record<string, number>;
}

export interface LegacyReflectionCandidateBackfillResult {
  batchesScanned: number;
  batchesBackfilled: number;
  candidatesFound: number;
  candidatesInserted: number;
  invalidBatches: number;
  invalidFacts: number;
  emptyBatches: number;
  missingEpisodes: number;
}

function normalizeCandidateText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function reflectionCandidateHash(text: string): string {
  return createHash('sha256').update(normalizeCandidateText(text)).digest('hex');
}

/** Count pre-ledger threshold buffers that still have no claim-level audit
 * rows. The extraction JSON is the original extractor output, so it can be
 * projected without running a model or inventing evidence. */
export function countLegacyReflectionCandidateBatches(): number {
  return Number((openMemoryDb().prepare(`
    SELECT COUNT(*) AS count
    FROM reflection_pending_extractions rpe
    WHERE rpe.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM memory_reflection_candidates mrc
        WHERE mrc.session_id = rpe.session_id AND mrc.call_id = rpe.call_id
      )
  `).get() as { count: number }).count);
}

/** Add an auditable row for every exact claim stored in a legacy threshold
 * buffer. This is deliberately additive and idempotent. A missing source
 * episode stays NULL rather than being reconstructed from the proposed claim;
 * candidate history and source evidence are different things. */
export function backfillLegacyReflectionCandidatesInDatabase(
  db: Database.Database,
): LegacyReflectionCandidateBackfillResult {
  const rows = db.prepare(`
    SELECT session_id, call_id, tool, extraction_json, importance
    FROM reflection_pending_extractions
    WHERE status = 'pending'
    ORDER BY created_at ASC, id ASC
  `).all() as Array<{
    session_id: string;
    call_id: string;
    tool: string | null;
    extraction_json: string;
    importance: number;
  }>;
  const result: LegacyReflectionCandidateBackfillResult = {
    batchesScanned: rows.length,
    batchesBackfilled: 0,
    candidatesFound: 0,
    candidatesInserted: 0,
    invalidBatches: 0,
    invalidFacts: 0,
    emptyBatches: 0,
    missingEpisodes: 0,
  };
  const allowedKinds = new Set(['user', 'project', 'feedback', 'reference']);
  const existing = db.prepare(`
    SELECT 1 FROM memory_reflection_candidates
    WHERE session_id = ? AND call_id = ? AND candidate_hash = ?
  `);
  const episodeLookup = db.prepare(`
    SELECT id, source_uri
    FROM memory_episodes
    WHERE session_id = ? AND call_id = ?
    ORDER BY CASE status WHEN 'available' THEN 0 WHEN 'partial' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
             ingested_at DESC, id DESC
    LIMIT 1
  `);
  const tx = db.transaction(() => {
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.extraction_json);
      } catch {
        result.invalidBatches += 1;
        continue;
      }
      const facts = parsed && typeof parsed === 'object' && Array.isArray((parsed as { facts?: unknown }).facts)
        ? (parsed as { facts: unknown[] }).facts
        : null;
      if (!facts) {
        result.invalidBatches += 1;
        continue;
      }
      if (facts.length === 0) {
        result.emptyBatches += 1;
        continue;
      }
      const episode = episodeLookup.get(row.session_id, row.call_id) as { id: string; source_uri: string | null } | undefined;
      if (!episode) result.missingEpisodes += 1;
      let insertedForBatch = 0;
      const hashes = new Set<string>();
      for (const candidate of facts) {
        if (!candidate || typeof candidate !== 'object') {
          result.invalidFacts += 1;
          continue;
        }
        const fact = candidate as { kind?: unknown; text?: unknown; importance?: unknown };
        const kind = typeof fact.kind === 'string' ? fact.kind : '';
        const text = typeof fact.text === 'string' ? fact.text.trim() : '';
        const importance = Number(fact.importance);
        if (!allowedKinds.has(kind) || text.length < 3 || text.length > 500 || !Number.isFinite(importance)) {
          result.invalidFacts += 1;
          continue;
        }
        const hash = reflectionCandidateHash(text);
        if (hashes.has(hash)) continue;
        hashes.add(hash);
        result.candidatesFound += 1;
        if (existing.get(row.session_id, row.call_id, hash)) continue;
        recordReflectionCandidateInDatabase(db, {
          episodeId: episode?.id ?? null,
          sessionId: row.session_id,
          callId: row.call_id,
          kind,
          text,
          importance: Math.max(1, Math.min(10, importance || row.importance || 1)),
          sourceType: 'tool_reflection',
          intakeReason: 'backfilled from the exact pre-ledger extraction buffer',
          trustLevel: 0.6,
          authority: 'derived',
          sourceUri: episode?.source_uri ?? null,
        });
        result.candidatesInserted += 1;
        insertedForBatch += 1;
      }
      if (insertedForBatch > 0) result.batchesBackfilled += 1;
    }
  });
  tx();
  return result;
}

export function backfillLegacyReflectionCandidates(): LegacyReflectionCandidateBackfillResult {
  return backfillLegacyReflectionCandidatesInDatabase(openMemoryDb());
}

export interface RecordReflectionCandidateInput {
  episodeId?: string | null;
  sessionId: string;
  callId: string;
  kind: string;
  text: string;
  importance: number;
  status?: 'pending' | 'rejected';
  reason?: string | null;
  sourceType?: ReflectionCandidateSourceType;
  intakeReason?: string | null;
  trustLevel?: number | null;
  authority?: 'user' | 'derived' | 'import' | 'manual' | null;
  sourceUri?: string | null;
  pin?: boolean;
  now?: string;
}

function recordReflectionCandidateInDatabase(
  db: Database.Database,
  input: RecordReflectionCandidateInput,
): number {
  const now = input.now ?? new Date().toISOString();
  const status = input.status ?? 'pending';
  db.prepare(`
    INSERT INTO memory_reflection_candidates
      (episode_id, session_id, call_id, candidate_hash, kind, text,
       importance, status, reason, resulting_fact_id, created_at, resolved_at,
       source_type, intake_reason, trust_level, authority, source_uri, pin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, call_id, candidate_hash) DO UPDATE SET
      episode_id = COALESCE(excluded.episode_id, memory_reflection_candidates.episode_id),
      kind = excluded.kind,
      text = excluded.text,
      importance = excluded.importance,
      status = CASE
        WHEN memory_reflection_candidates.status = 'pending' THEN excluded.status
        ELSE memory_reflection_candidates.status
      END,
      reason = CASE
        WHEN memory_reflection_candidates.status = 'pending' THEN excluded.reason
        ELSE memory_reflection_candidates.reason
      END,
      resolved_at = CASE
        WHEN memory_reflection_candidates.status = 'pending' THEN excluded.resolved_at
        ELSE memory_reflection_candidates.resolved_at
      END,
      source_type = CASE
        WHEN memory_reflection_candidates.status = 'pending' THEN excluded.source_type
        ELSE memory_reflection_candidates.source_type
      END,
      intake_reason = COALESCE(memory_reflection_candidates.intake_reason, excluded.intake_reason),
      trust_level = COALESCE(memory_reflection_candidates.trust_level, excluded.trust_level),
      authority = COALESCE(memory_reflection_candidates.authority, excluded.authority),
      source_uri = COALESCE(memory_reflection_candidates.source_uri, excluded.source_uri),
      pin = MAX(memory_reflection_candidates.pin, excluded.pin)
  `).run(
    input.episodeId ?? null,
    input.sessionId,
    input.callId,
    reflectionCandidateHash(input.text),
    input.kind,
    input.text.trim(),
    Math.max(1, Math.min(10, input.importance)),
    status,
    input.reason?.slice(0, 240) ?? null,
    now,
    status === 'rejected' ? now : null,
    input.sourceType ?? 'tool_reflection',
    input.intakeReason?.slice(0, 240) ?? null,
    input.trustLevel ?? null,
    input.authority ?? null,
    input.sourceUri ?? null,
    input.pin ? 1 : 0,
  );
  const row = db.prepare(`
    SELECT id FROM memory_reflection_candidates
    WHERE session_id = ? AND call_id = ? AND candidate_hash = ?
  `).get(input.sessionId, input.callId, reflectionCandidateHash(input.text)) as { id: number } | undefined;
  if (!row) throw new Error('recordReflectionCandidate: candidate row was not persisted');
  return row.id;
}

export function recordReflectionCandidate(input: RecordReflectionCandidateInput): number {
  return recordReflectionCandidateInDatabase(openMemoryDb(), input);
}

export function resolveReflectionCandidate(input: {
  sessionId: string;
  callId: string;
  text: string;
  status: 'promoted' | 'rejected' | 'expired';
  reason: string;
  resultingFactId?: number | null;
  now?: string;
}): boolean {
  const info = openMemoryDb().prepare(`
    UPDATE memory_reflection_candidates
    SET status = ?, reason = ?, resulting_fact_id = ?, resolved_at = ?
    WHERE session_id = ? AND call_id = ? AND candidate_hash = ? AND status = 'pending'
  `).run(
    input.status,
    input.reason.slice(0, 240),
    input.resultingFactId ?? null,
    input.now ?? new Date().toISOString(),
    input.sessionId,
    input.callId,
    reflectionCandidateHash(input.text),
  );
  return Number(info.changes ?? 0) > 0;
}

export function resolveReflectionCandidateById(input: {
  id: number;
  status: 'promoted' | 'rejected' | 'expired';
  reason: string;
  resultingFactId?: number | null;
  now?: string;
}): boolean {
  const info = openMemoryDb().prepare(`
    UPDATE memory_reflection_candidates
    SET status = ?, reason = ?, resulting_fact_id = ?, resolved_at = ?,
        processing_started_at = NULL, next_attempt_at = NULL, last_error = NULL
    WHERE id = ? AND status = 'pending'
  `).run(
    input.status,
    input.reason.slice(0, 240),
    input.resultingFactId ?? null,
    input.now ?? new Date().toISOString(),
    input.id,
  );
  return Number(info.changes ?? 0) > 0;
}

export function readReflectionCandidateHealth(now = new Date().toISOString()): ReflectionCandidateHealth {
  const db = openMemoryDb();
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM memory_reflection_candidates
    GROUP BY status
  `).all() as Array<{ status: ReflectionCandidateStatus; count: number }>;
  const byStatus = new Map(rows.map((row) => [row.status, row.count]));
  const pending = byStatus.get('pending') ?? 0;
  const pendingUniqueClaims = (db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT kind, candidate_hash FROM memory_reflection_candidates
      WHERE status = 'pending' GROUP BY kind, candidate_hash
    )
  `).get() as { count: number }).count;
  const knownExactPending = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_reflection_candidates mrc
    JOIN memory_episodes me ON me.id = mrc.episode_id
    WHERE mrc.status = 'pending'
      AND TRIM(COALESCE(me.evidence_excerpt, '')) <> ''
      AND EXISTS (
        SELECT 1 FROM consolidated_facts cf
        WHERE cf.active = 1 AND cf.kind = mrc.kind
          AND LOWER(TRIM(cf.content)) = LOWER(TRIM(mrc.text))
      )
  `).get() as { count: number }).count;
  const promoted = byStatus.get('promoted') ?? 0;
  const rejected = byStatus.get('rejected') ?? 0;
  const expired = byStatus.get('expired') ?? 0;
  const overduePending = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_reflection_candidates mrc
    JOIN reflection_pending_extractions rpe
      ON rpe.session_id = mrc.session_id AND rpe.call_id = mrc.call_id
    WHERE mrc.status = 'pending' AND rpe.status = 'pending'
      AND rpe.expires_at IS NOT NULL
      AND julianday(rpe.expires_at) <= julianday(?)
  `).get(now) as { count: number }).count;
  const orphanedPending = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_reflection_candidates mrc
    WHERE mrc.status = 'pending'
      AND NOT EXISTS (
          SELECT 1 FROM reflection_pending_extractions rpe
          WHERE rpe.session_id = mrc.session_id AND rpe.call_id = mrc.call_id
            AND rpe.status = 'pending'
        )
      AND (
        mrc.episode_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM memory_episodes me WHERE me.id = mrc.episode_id
        )
      )
  `).get() as { count: number }).count;
  const retrying = (db.prepare(`
    SELECT COUNT(*) AS count FROM memory_reflection_candidates
    WHERE status = 'pending' AND attempt_count > 0
  `).get() as { count: number }).count;
  const failedPending = (db.prepare(`
    SELECT COUNT(*) AS count FROM memory_reflection_candidates
    WHERE status = 'pending' AND last_error IS NOT NULL
  `).get() as { count: number }).count;
  const oldestPending = (db.prepare(`
    SELECT MIN(created_at) AS at FROM memory_reflection_candidates WHERE status = 'pending'
  `).get() as { at: string | null }).at;
  const reasonRows = db.prepare(`
    SELECT COALESCE(reason, 'unspecified') AS reason, COUNT(*) AS count
    FROM memory_reflection_candidates
    WHERE status = 'rejected'
    GROUP BY COALESCE(reason, 'unspecified')
    ORDER BY count DESC, reason ASC
    LIMIT 20
  `).all() as Array<{ reason: string; count: number }>;
  const resolved = promoted + rejected + expired;
  return {
    total: pending + resolved,
    pending,
    pendingUniqueClaims,
    duplicatePendingObservations: Math.max(0, pending - pendingUniqueClaims),
    knownExactPending,
    promoted,
    rejected,
    expired,
    overduePending,
    orphanedPending,
    retrying,
    failedPending,
    oldestPending,
    promotionRate: resolved > 0 ? promoted / resolved : null,
    rejectionReasons: Object.fromEntries(reasonRows.map((row) => [row.reason, row.count])),
  };
}
