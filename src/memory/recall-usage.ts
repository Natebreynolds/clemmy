import { randomUUID } from 'node:crypto';
import { openMemoryDb } from './db.js';

export const RECALL_REF_TYPES = ['fact', 'note', 'entity', 'resource', 'episode', 'policy', 'procedure'] as const;
export type RecallRefType = (typeof RECALL_REF_TYPES)[number];

export interface RecallCandidateRef {
  type: RecallRefType;
  id: string;
}

export interface RecallRun {
  id: string;
  objective: string;
  surface: string;
  answerability: 'supported' | 'partial' | 'insufficient';
  candidateRefs: RecallCandidateRef[];
  createdAt: string;
  expiresAt: string;
}

export interface RecallUseResult {
  ok: boolean;
  recorded: RecallCandidateRef[];
  duplicates: RecallCandidateRef[];
  rejected: string[];
  utilityFactIds: number[];
  reason?: 'not_found' | 'expired';
}

export interface RecallUsageHealth {
  windowDays: number;
  runs: number;
  usedRuns: number;
  conversionRate: number | null;
  usedRefs: number;
  notUsefulRefs: number;
  refUtilityEvents: number;
  refTypeUses: Partial<Record<RecallRefType, number>>;
  topRefShare: number | null;
  topRef: { type: RecallRefType; id: string; uses: number } | null;
  factUtilityEvents: number;
  topFactShare: number | null;
  topFact: { id: number; content: string; uses: number } | null;
}

export interface RecallRefUtilitySignal {
  used: number;
  notUseful: number;
  lastUsedAt: string | null;
}

const REF_TYPE_SET = new Set<string>(RECALL_REF_TYPES);

function normalizeRef(ref: RecallCandidateRef): RecallCandidateRef | null {
  const type = String(ref.type ?? '').trim() as RecallRefType;
  const id = String(ref.id ?? '').trim();
  if (!REF_TYPE_SET.has(type) || !id) return null;
  return { type, id };
}

export function serializeRecallRef(ref: RecallCandidateRef): string {
  return `${ref.type}:${ref.id}`;
}

export function parseRecallRef(value: string): RecallCandidateRef | null {
  const text = String(value ?? '').trim();
  const separator = text.indexOf(':');
  if (separator <= 0 || separator === text.length - 1) return null;
  return normalizeRef({ type: text.slice(0, separator) as RecallRefType, id: text.slice(separator + 1) });
}

/**
 * Read durable, explicitly-attributed usefulness for an exact candidate set.
 *
 * This intentionally reads `memory_recall_uses`, not impressions or the legacy
 * access counter. It therefore works for every public memory ref (notes,
 * entities, resources, episodes, policies, and procedures as well as facts)
 * without turning automatic prompt exposure into a ranking signal.
 */
export function readRecallRefUtilitySignals(
  refs: RecallCandidateRef[],
): Map<string, RecallRefUtilitySignal> {
  const candidates = dedupeRefs(refs);
  if (candidates.length === 0) return new Map();
  try {
    const predicates = candidates.map(() => '(ref_type = ? AND ref_id = ?)').join(' OR ');
    const params = candidates.flatMap((ref) => [ref.type, ref.id]);
    const rows = openMemoryDb().prepare(`
      SELECT ref_type, ref_id,
             COUNT(DISTINCT CASE WHEN outcome = 'used' THEN recall_id END) AS used,
             COUNT(DISTINCT CASE WHEN outcome = 'not_useful' THEN recall_id END) AS not_useful,
             MAX(CASE WHEN outcome = 'used' THEN recorded_at END) AS last_used_at
      FROM memory_recall_uses
      WHERE ${predicates}
      GROUP BY ref_type, ref_id
    `).all(...params) as Array<{
      ref_type: RecallRefType;
      ref_id: string;
      used: number;
      not_useful: number;
      last_used_at: string | null;
    }>;
    return new Map(rows.map((row) => [
      serializeRecallRef({ type: row.ref_type, id: row.ref_id }),
      {
        used: Number(row.used ?? 0),
        notUseful: Number(row.not_useful ?? 0),
        lastUsedAt: row.last_used_at ?? null,
      },
    ]));
  } catch {
    // Old/read-only databases may not have the attribution tables yet. Recall
    // remains relevance-only until the additive migration is applied.
    return new Map();
  }
}

export function createRecallRunId(): string {
  return `mr-${randomUUID()}`;
}

function dedupeRefs(refs: RecallCandidateRef[]): RecallCandidateRef[] {
  const seen = new Set<string>();
  const result: RecallCandidateRef[] = [];
  for (const candidate of refs) {
    const ref = normalizeRef(candidate);
    if (!ref) continue;
    const key = serializeRecallRef(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

export function recordRecallRun(input: {
  id?: string;
  objective: string;
  surface: string;
  answerability: RecallRun['answerability'];
  candidateRefs: RecallCandidateRef[];
  nowIso?: string;
  ttlHours?: number;
}): RecallRun {
  const createdAt = input.nowIso ?? new Date().toISOString();
  const createdMs = Date.parse(createdAt);
  const ttlHours = Math.max(1, Math.min(24 * 30, input.ttlHours ?? 24 * 7));
  const expiresAt = new Date((Number.isFinite(createdMs) ? createdMs : Date.now()) + ttlHours * 60 * 60 * 1_000).toISOString();
  const run: RecallRun = {
    id: input.id?.trim() || createRecallRunId(),
    objective: input.objective.replace(/\s+/g, ' ').trim(),
    surface: input.surface.replace(/\s+/g, ' ').trim() || 'unknown',
    answerability: input.answerability,
    candidateRefs: dedupeRefs(input.candidateRefs),
    createdAt,
    expiresAt,
  };
  openMemoryDb().prepare(`
    INSERT INTO memory_recall_runs
      (id, objective, surface, answerability, candidate_refs_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id,
    run.objective,
    run.surface,
    run.answerability,
    JSON.stringify(run.candidateRefs),
    run.createdAt,
    run.expiresAt,
  );
  return run;
}

function parseCandidateRefs(json: string): RecallCandidateRef[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return dedupeRefs(parsed.filter((item): item is RecallCandidateRef => Boolean(item) && typeof item === 'object') as RecallCandidateRef[]);
  } catch {
    return [];
  }
}

/**
 * Credit only exact refs returned by an unexpired recall run. The unique use
 * key makes retries harmless, while fact/policy projections of the same claim
 * share one underlying utility increment per run.
 */
export function recordRecallUse(input: {
  recallId: string;
  refs: string[];
  outcome?: 'used' | 'not_useful';
  detail?: string;
  nowIso?: string;
}): RecallUseResult {
  const db = openMemoryDb();
  const now = input.nowIso ?? new Date().toISOString();
  const run = db.prepare(`
    SELECT candidate_refs_json, expires_at
    FROM memory_recall_runs
    WHERE id = ?
  `).get(input.recallId) as { candidate_refs_json: string; expires_at: string } | undefined;
  if (!run) return { ok: false, recorded: [], duplicates: [], rejected: input.refs, utilityFactIds: [], reason: 'not_found' };
  if (Date.parse(run.expires_at) < Date.parse(now)) {
    return { ok: false, recorded: [], duplicates: [], rejected: input.refs, utilityFactIds: [], reason: 'expired' };
  }

  const candidates = new Set(parseCandidateRefs(run.candidate_refs_json).map(serializeRecallRef));
  const requested = new Map<string, RecallCandidateRef>();
  const rejected: string[] = [];
  for (const value of input.refs) {
    const ref = parseRecallRef(value);
    if (!ref || !candidates.has(serializeRecallRef(ref))) {
      rejected.push(value);
      continue;
    }
    requested.set(serializeRecallRef(ref), ref);
  }

  const outcome = input.outcome ?? 'used';
  const detail = input.detail?.replace(/\s+/g, ' ').trim().slice(0, 500) || null;
  const recorded: RecallCandidateRef[] = [];
  const duplicates: RecallCandidateRef[] = [];
  const utilityFactIds = new Set<number>();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO memory_recall_uses
      (recall_id, ref_type, ref_id, outcome, detail, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const existingUse = db.prepare(`
    SELECT outcome
    FROM memory_recall_uses
    WHERE recall_id = ? AND ref_type = ? AND ref_id = ?
  `);
  const promoteUse = db.prepare(`
    UPDATE memory_recall_uses
    SET outcome = 'used', detail = COALESCE(?, detail), recorded_at = ?
    WHERE recall_id = ? AND ref_type = ? AND ref_id = ? AND outcome = 'not_useful'
  `);
  const priorFactUse = db.prepare(`
    SELECT 1
    FROM memory_recall_uses
    WHERE recall_id = ? AND outcome = 'used'
      AND ref_type IN ('fact','policy') AND ref_id = ?
    LIMIT 1
  `);
  const creditFact = db.prepare(`
    UPDATE consolidated_facts
    SET last_used_at = ?, last_accessed_at = ?,
        utility_count = utility_count + 1,
        access_count = access_count + 1
    WHERE id = ? AND active = 1
  `);

  db.transaction(() => {
    const preexistingFactIds = new Set<number>();
    for (const ref of requested.values()) {
      if ((ref.type === 'fact' || ref.type === 'policy') && /^\d+$/.test(ref.id)
        && priorFactUse.get(input.recallId, ref.id)) {
        preexistingFactIds.add(Number(ref.id));
      }
    }

    const newlyRecordedFactIds = new Set<number>();
    for (const ref of requested.values()) {
      const prior = existingUse.get(input.recallId, ref.type, ref.id) as { outcome: 'used' | 'not_useful' } | undefined;
      // A caller can first reject an alternative, then discover later in the
      // same turn that it materially changed the answer. Allow that one-way
      // correction and credit it once. We never demote `used` to
      // `not_useful`: the aggregate fact counter cannot safely be decremented
      // after merges and a recorded material use remains historically true.
      if (prior) {
        if (prior.outcome === 'not_useful' && outcome === 'used'
          && promoteUse.run(detail, now, input.recallId, ref.type, ref.id).changes > 0) {
          recorded.push(ref);
          if ((ref.type === 'fact' || ref.type === 'policy') && /^\d+$/.test(ref.id)) {
            newlyRecordedFactIds.add(Number(ref.id));
          }
        } else {
          duplicates.push(ref);
        }
        continue;
      }
      const info = insert.run(input.recallId, ref.type, ref.id, outcome, detail, now);
      if (info.changes === 0) {
        duplicates.push(ref);
        continue;
      }
      recorded.push(ref);
      if (outcome === 'used' && (ref.type === 'fact' || ref.type === 'policy') && /^\d+$/.test(ref.id)) {
        newlyRecordedFactIds.add(Number(ref.id));
      }
    }

    if (outcome === 'used') {
      for (const factId of newlyRecordedFactIds) {
        if (preexistingFactIds.has(factId)) continue;
        if (creditFact.run(now, now, factId).changes > 0) utilityFactIds.add(factId);
      }
    }
  })();

  return { ok: true, recorded, duplicates, rejected, utilityFactIds: [...utilityFactIds] };
}

export function readRecallUsageHealth(windowDays = 30, nowIso = new Date().toISOString()): RecallUsageHealth {
  const days = Math.max(1, Math.min(365, Math.floor(windowDays)));
  const nowMs = Date.parse(nowIso);
  const since = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) - days * 24 * 60 * 60 * 1_000).toISOString();
  const db = openMemoryDb();
  const runStats = db.prepare(`
    SELECT COUNT(DISTINCT r.id) AS runs,
           COUNT(DISTINCT CASE WHEN u.outcome = 'used' THEN r.id END) AS used_runs,
           COUNT(CASE WHEN u.outcome = 'used' THEN 1 END) AS used_refs,
           COUNT(CASE WHEN u.outcome = 'not_useful' THEN 1 END) AS not_useful_refs
    FROM memory_recall_runs r
    LEFT JOIN memory_recall_uses u ON u.recall_id = r.id
    WHERE r.created_at >= ?
  `).get(since) as { runs: number; used_runs: number; used_refs: number; not_useful_refs: number };
  const refRows = db.prepare(`
    SELECT ref_type, ref_id, COUNT(DISTINCT recall_id) AS uses
    FROM memory_recall_uses
    WHERE recorded_at >= ? AND outcome = 'used'
    GROUP BY ref_type, ref_id
    ORDER BY uses DESC, ref_type ASC, ref_id ASC
  `).all(since) as Array<{ ref_type: RecallRefType; ref_id: string; uses: number }>;
  const refUtilityEvents = refRows.reduce((sum, row) => sum + Number(row.uses), 0);
  const refTypeUses: Partial<Record<RecallRefType, number>> = {};
  for (const row of refRows) refTypeUses[row.ref_type] = (refTypeUses[row.ref_type] ?? 0) + Number(row.uses);
  const topRef = refRows[0];
  const factRows = db.prepare(`
    SELECT CAST(u.ref_id AS INTEGER) AS fact_id,
           COUNT(DISTINCT u.recall_id) AS uses,
           COALESCE(f.content, '') AS content
    FROM memory_recall_uses u
    LEFT JOIN consolidated_facts f ON f.id = CAST(u.ref_id AS INTEGER)
    WHERE u.recorded_at >= ? AND u.outcome = 'used'
      AND u.ref_type IN ('fact','policy') AND u.ref_id GLOB '[0-9]*'
    GROUP BY u.ref_id
    ORDER BY uses DESC, fact_id ASC
  `).all(since) as Array<{ fact_id: number; uses: number; content: string }>;
  const factUtilityEvents = factRows.reduce((sum, row) => sum + row.uses, 0);
  const top = factRows[0];
  return {
    windowDays: days,
    runs: runStats.runs,
    usedRuns: runStats.used_runs,
    conversionRate: runStats.runs > 0 ? runStats.used_runs / runStats.runs : null,
    usedRefs: runStats.used_refs,
    notUsefulRefs: runStats.not_useful_refs,
    refUtilityEvents,
    refTypeUses,
    topRefShare: refUtilityEvents > 0 && topRef ? topRef.uses / refUtilityEvents : null,
    topRef: topRef ? { type: topRef.ref_type, id: topRef.ref_id, uses: topRef.uses } : null,
    factUtilityEvents,
    topFactShare: factUtilityEvents > 0 && top ? top.uses / factUtilityEvents : null,
    topFact: top ? { id: top.fact_id, content: top.content, uses: top.uses } : null,
  };
}

/** Drop abandoned expired runs while preserving runs with durable feedback. */
export function reapExpiredUnusedRecallRuns(nowIso = new Date().toISOString()): number {
  return openMemoryDb().prepare(`
    DELETE FROM memory_recall_runs
    WHERE expires_at < ?
      AND NOT EXISTS (SELECT 1 FROM memory_recall_uses u WHERE u.recall_id = memory_recall_runs.id)
  `).run(nowIso).changes;
}
