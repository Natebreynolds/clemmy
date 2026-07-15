import { createHash } from 'node:crypto';
import {
  backupMemoryDb,
  openMemoryDb,
  type MemoryEpisodeKind,
  type MemoryEpisodeRow,
  type MemoryEpisodeStatus,
  type MemoryPolicyRow,
} from './db.js';
import { getToolOutput } from '../runtime/harness/eventlog.js';

const MAX_EVIDENCE_CHARS = 2_000;

export interface MemoryEpisodeInput {
  kind: MemoryEpisodeKind;
  sourceApp?: string | null;
  sessionId?: string | null;
  callId?: string | null;
  sourceUri?: string | null;
  occurredAt?: string;
  content?: string | null;
  rawRetainedUntil?: string | null;
  status?: MemoryEpisodeStatus;
}

export interface FactEvidence {
  episodeId: string;
  excerpt: string;
  sourceUri?: string;
  occurredAt: string;
  status: MemoryEpisodeStatus;
}

export interface TemporalEvidenceBackfillResult {
  scanned: number;
  /** Facts linked to a real, source-derived supporting excerpt. */
  linked: number;
  /** Facts linked to an explicit unavailable-source episode. */
  missing: number;
  /** Facts not yet classified by the backfill. */
  remaining: number;
}

export interface TemporalEvidenceReconciliationReport {
  backupPath: string | null;
  before: number;
  processed: number;
  available: number;
  unavailable: number;
  remaining: number;
  complete: boolean;
  elapsedMs: number;
}

export interface TemporalEvidenceHealth {
  evidenceAvailable: number;
  evidenceUnavailable: number;
  unreconciledEvidence: number;
  unreconciledDerivedEvidence: number;
  unavailableDerivedEvidence: number;
  brokenEvidence: number;
  missingEpisodes: number;
  evidenceCoverage: number;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function episodeIdFor(input: MemoryEpisodeInput, normalized: string): string {
  if (input.sessionId && input.callId) {
    return `call:${contentHash(`${input.sessionId}:${input.callId}`).slice(0, 24)}`;
  }
  return `episode:${contentHash([
    input.kind,
    input.sourceApp ?? '',
    input.sessionId ?? '',
    input.sourceUri ?? '',
    input.occurredAt ?? '',
    normalized,
  ].join(':')).slice(0, 24)}`;
}

/** Upsert a durable source episode. For a tool call, (session, call) is the
 * stable identity; later writes may upgrade a missing/pending shell with the
 * actual bounded evidence excerpt. */
export function recordMemoryEpisode(input: MemoryEpisodeInput): MemoryEpisodeRow {
  const db = openMemoryDb();
  const now = new Date().toISOString();
  const excerpt = input.content ? normalize(input.content).slice(0, MAX_EVIDENCE_CHARS) : '';
  const id = episodeIdFor(input, excerpt);
  const status = input.status ?? (excerpt ? 'available' : 'missing');
  db.prepare(`
    INSERT INTO memory_episodes
      (id, kind, source_app, session_id, call_id, source_uri, occurred_at,
       ingested_at, content_hash, evidence_excerpt, raw_retained_until, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source_app = COALESCE(excluded.source_app, memory_episodes.source_app),
      source_uri = COALESCE(excluded.source_uri, memory_episodes.source_uri),
      evidence_excerpt = CASE
        WHEN excluded.evidence_excerpt IS NOT NULL AND length(excluded.evidence_excerpt) > 0
          THEN excluded.evidence_excerpt
        ELSE memory_episodes.evidence_excerpt
      END,
      content_hash = CASE
        WHEN excluded.evidence_excerpt IS NOT NULL AND length(excluded.evidence_excerpt) > 0
          THEN excluded.content_hash
        ELSE memory_episodes.content_hash
      END,
      raw_retained_until = COALESCE(excluded.raw_retained_until, memory_episodes.raw_retained_until),
      status = CASE
        WHEN excluded.status = 'available' THEN 'available'
        WHEN memory_episodes.status = 'available' THEN 'available'
        ELSE excluded.status
      END
  `).run(
    id,
    input.kind,
    input.sourceApp ?? null,
    input.sessionId ?? null,
    input.callId ?? null,
    input.sourceUri ?? null,
    input.occurredAt ?? now,
    now,
    contentHash(excerpt),
    excerpt || null,
    input.rawRetainedUntil ?? null,
    status,
  );
  return db.prepare('SELECT * FROM memory_episodes WHERE id = ?').get(id) as MemoryEpisodeRow;
}

function evidenceTokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9._@-]{2,}/g) ?? [])
    .filter((token) => !['the', 'and', 'for', 'with', 'that', 'this', 'from', 'was', 'are', 'have'].includes(token)));
}

/** Select the smallest source fragment that best supports a synthesized fact.
 * The fragment is copied from the raw source; it is never generated. */
export function selectSupportingExcerpt(source: string, claim: string, maxChars = MAX_EVIDENCE_CHARS): string {
  const clean = source.trim();
  if (!clean) return '';
  if (clean.length <= maxChars) return clean;
  const claimTokens = evidenceTokens(claim);
  const segments = clean.split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9])/).filter(Boolean);
  let best = segments[0] ?? clean.slice(0, maxChars);
  let bestScore = -1;
  for (const segment of segments) {
    const tokens = evidenceTokens(segment);
    let score = 0;
    for (const token of claimTokens) if (tokens.has(token)) score += 1;
    if (score > bestScore) { best = segment; bestScore = score; }
  }
  return best.trim().slice(0, maxChars);
}

export function linkFactEvidence(input: {
  factId: number;
  episodeId: string;
  excerpt: string;
  sourceUri?: string | null;
  ordinal?: number;
}): void {
  const excerpt = input.excerpt.trim();
  if (!excerpt) return;
  openMemoryDb().prepare(`
    INSERT OR REPLACE INTO fact_evidence
      (fact_id, episode_id, excerpt, source_uri, ordinal, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.factId,
    input.episodeId,
    excerpt.slice(0, MAX_EVIDENCE_CHARS),
    input.sourceUri ?? null,
    input.ordinal ?? 0,
    new Date().toISOString(),
  );
}

/** Persist the fact→episode relationship when the original source is gone.
 * The empty excerpt is an explicit sentinel, never fabricated evidence. Recall
 * filters it out of answer-supporting evidence, while audits can still explain
 * exactly which source episode is unavailable. */
export function linkUnavailableFactEvidence(input: {
  factId: number;
  episodeId: string;
  sourceUri?: string | null;
  ordinal?: number;
}): void {
  openMemoryDb().prepare(`
    INSERT OR IGNORE INTO fact_evidence
      (fact_id, episode_id, excerpt, source_uri, ordinal, created_at)
    VALUES (?, ?, '', ?, ?, ?)
  `).run(
    input.factId,
    input.episodeId,
    input.sourceUri ?? null,
    input.ordinal ?? 0,
    new Date().toISOString(),
  );
}

/** Attach durable evidence to a fact at write time. Direct/manual memories use
 * the exact claim as their evidence. Derived memories copy a supporting source
 * fragment out of tool_outputs while it still exists; otherwise the episode is
 * explicitly marked missing and no synthetic evidence is created. */
export function captureFactEvidence(input: {
  factId: number;
  factContent: string;
  sourceApp?: string | null;
  sourcePath?: string | null;
  sessionId?: string | null;
  callId?: string | null;
  tool?: string | null;
  occurredAt?: string;
}): MemoryEpisodeRow {
  const sourceUri = input.sourcePath
    ?? (input.sessionId && input.callId ? `tool://${input.sessionId}/${input.callId}` : null);
  if (input.sessionId && input.callId) {
    let stored: ReturnType<typeof getToolOutput> = null;
    try { stored = getToolOutput(input.sessionId, input.callId); } catch { /* harness DB unavailable */ }
    const excerpt = stored ? selectSupportingExcerpt(stored.output, input.factContent) : '';
    const episode = recordMemoryEpisode({
      kind: 'tool_result',
      sourceApp: input.sourceApp ?? input.tool ?? null,
      sessionId: input.sessionId,
      callId: input.callId,
      sourceUri,
      occurredAt: stored?.createdAt ?? input.occurredAt,
      content: excerpt,
      rawRetainedUntil: stored
        ? new Date(Date.parse(stored.createdAt) + 14 * 24 * 60 * 60 * 1000).toISOString()
        : null,
      status: excerpt ? 'available' : 'missing',
    });
    // A prior fact from the same call may already have copied the durable
    // episode excerpt before raw tool-output expiry. Reuse that exact stored
    // excerpt for sibling facts; otherwise persist an unavailable link so this
    // fact is classified once and bounded backfill can advance.
    const durableExcerpt = excerpt || (episode.status === 'available' ? episode.evidence_excerpt?.trim() ?? '' : '');
    if (durableExcerpt) {
      linkFactEvidence({ factId: input.factId, episodeId: episode.id, excerpt: durableExcerpt, sourceUri: episode.source_uri ?? sourceUri });
    } else {
      linkUnavailableFactEvidence({ factId: input.factId, episodeId: episode.id, sourceUri: episode.source_uri ?? sourceUri });
    }
    return episode;
  }

  const episode = recordMemoryEpisode({
    kind: input.sourcePath ? 'import' : input.sessionId ? 'user_turn' : 'manual',
    sourceApp: input.sourceApp ?? null,
    sessionId: input.sessionId ?? null,
    sourceUri,
    occurredAt: input.occurredAt,
    content: input.factContent,
    status: 'available',
  });
  linkFactEvidence({ factId: input.factId, episodeId: episode.id, excerpt: input.factContent, sourceUri });
  return episode;
}

export function getFactEvidence(factId: number): FactEvidence[] {
  const rows = openMemoryDb().prepare(`
    SELECT fe.episode_id, fe.excerpt, fe.source_uri, me.occurred_at, me.status
    FROM fact_evidence fe
    JOIN memory_episodes me ON me.id = fe.episode_id
    WHERE fe.fact_id = ?
    ORDER BY me.occurred_at DESC, fe.ordinal ASC
  `).all(factId) as Array<{
    episode_id: string; excerpt: string; source_uri: string | null; occurred_at: string; status: MemoryEpisodeStatus;
  }>;
  return rows.map((row) => ({
    episodeId: row.episode_id,
    excerpt: row.excerpt,
    sourceUri: row.source_uri ?? undefined,
    occurredAt: row.occurred_at,
    status: row.status,
  }));
}

export function getMemoryGeneration(): number {
  try {
    return (openMemoryDb().prepare('SELECT generation FROM memory_generation WHERE id = 1').get() as { generation: number } | undefined)?.generation ?? 0;
  } catch { return 0; }
}

export function listMemoryPolicies(): MemoryPolicyRow[] {
  return openMemoryDb().prepare(`
    SELECT mp.* FROM memory_policies mp
    JOIN consolidated_facts cf ON cf.id = mp.fact_id
    WHERE cf.active = 1
    ORDER BY CASE mp.policy_type WHEN 'hard_constraint' THEN 0 WHEN 'core_profile' THEN 1 ELSE 2 END,
             mp.priority DESC, mp.updated_at DESC
  `).all() as MemoryPolicyRow[];
}

/** Bounded incremental backfill. Existing broken sources remain marked missing;
 * recoverable tool outputs are copied before their TTL expires. */
export function countUnreconciledFactEvidence(): number {
  return (openMemoryDb().prepare(`
    SELECT COUNT(*) AS c
    FROM consolidated_facts cf
    WHERE NOT EXISTS (SELECT 1 FROM fact_evidence fe WHERE fe.fact_id = cf.id)
  `).get() as { c: number }).c;
}

export function readTemporalEvidenceHealth(): TemporalEvidenceHealth {
  const db = openMemoryDb();
  const one = (sql: string): number => (db.prepare(sql).get() as { c: number } | undefined)?.c ?? 0;
  const factsTotal = one('SELECT COUNT(*) AS c FROM consolidated_facts');
  const evidenceAvailable = one(`
    SELECT COUNT(DISTINCT fe.fact_id) AS c
    FROM fact_evidence fe
    JOIN memory_episodes me ON me.id = fe.episode_id
    WHERE me.status IN ('available','partial') AND length(trim(fe.excerpt)) > 0
  `);
  const evidenceUnavailable = one(`
    SELECT COUNT(DISTINCT fe.fact_id) AS c
    FROM fact_evidence fe
    JOIN memory_episodes me ON me.id = fe.episode_id
    WHERE (me.status IN ('missing','expired') OR length(trim(fe.excerpt)) = 0)
      AND NOT EXISTS (
        SELECT 1 FROM fact_evidence usable
        JOIN memory_episodes usable_episode ON usable_episode.id = usable.episode_id
        WHERE usable.fact_id = fe.fact_id
          AND usable_episode.status IN ('available','partial')
          AND length(trim(usable.excerpt)) > 0
      )
  `);
  const unreconciledEvidence = countUnreconciledFactEvidence();
  const unreconciledDerivedEvidence = one(`
    SELECT COUNT(*) AS c FROM consolidated_facts cf
    WHERE cf.active = 1 AND cf.derived_from_call_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM fact_evidence fe WHERE fe.fact_id = cf.id)
  `);
  const unavailableDerivedEvidence = one(`
    SELECT COUNT(DISTINCT cf.id) AS c
    FROM consolidated_facts cf
    JOIN fact_evidence fe ON fe.fact_id = cf.id
    JOIN memory_episodes me ON me.id = fe.episode_id
    WHERE cf.active = 1 AND cf.derived_from_call_id IS NOT NULL
      AND (me.status IN ('missing','expired') OR length(trim(fe.excerpt)) = 0)
      AND NOT EXISTS (
        SELECT 1 FROM fact_evidence usable
        JOIN memory_episodes usable_episode ON usable_episode.id = usable.episode_id
        WHERE usable.fact_id = cf.id
          AND usable_episode.status IN ('available','partial')
          AND length(trim(usable.excerpt)) > 0
      )
  `);
  return {
    evidenceAvailable,
    evidenceUnavailable,
    unreconciledEvidence,
    unreconciledDerivedEvidence,
    unavailableDerivedEvidence,
    brokenEvidence: unreconciledDerivedEvidence + unavailableDerivedEvidence,
    missingEpisodes: one("SELECT COUNT(*) AS c FROM memory_episodes WHERE status = 'missing'"),
    evidenceCoverage: factsTotal > 0 ? (evidenceAvailable + evidenceUnavailable) / factsTotal : 1,
  };
}

export function backfillTemporalEvidence(limit = 200): TemporalEvidenceBackfillResult {
  const db = openMemoryDb();
  const rows = db.prepare(`
    SELECT cf.*
    FROM consolidated_facts cf
    LEFT JOIN fact_evidence fe ON fe.fact_id = cf.id
    WHERE fe.fact_id IS NULL
    ORDER BY cf.updated_at DESC
    LIMIT ?
  `).all(Math.max(1, limit)) as Array<Record<string, unknown>>;
  let linked = 0;
  let missing = 0;
  for (const row of rows) {
    const episode = captureFactEvidence({
      factId: Number(row.id),
      factContent: String(row.content ?? ''),
      sourceApp: row.source_app ? String(row.source_app) : null,
      sourcePath: row.source_path ? String(row.source_path) : null,
      sessionId: row.derived_from_session_id ? String(row.derived_from_session_id) : (row.source_session_id ? String(row.source_session_id) : null),
      callId: row.derived_from_call_id ? String(row.derived_from_call_id) : null,
      tool: row.derived_from_tool ? String(row.derived_from_tool) : null,
      occurredAt: row.created_at ? String(row.created_at) : undefined,
    });
    const evidence = getFactEvidence(Number(row.id));
    if (evidence.some((item) => item.status === 'available' && item.excerpt.trim().length > 0)) linked += 1;
    else if (episode.status === 'missing' || evidence.some((item) => item.status === 'missing')) missing += 1;
  }
  return { scanned: rows.length, linked, missing, remaining: countUnreconciledFactEvidence() };
}

/** Operator-triggered, backup-first reconciliation. The default cap is large
 * enough for a personal store but still bounded; callers can resume safely
 * because every processed fact receives either available or unavailable
 * provenance and is never selected again. */
export function reconcileTemporalEvidence(options: {
  maxFacts?: number;
  batchSize?: number;
  requireBackup?: boolean;
} = {}): TemporalEvidenceReconciliationReport {
  const started = Date.now();
  const maxFacts = Math.max(1, Math.min(50_000, options.maxFacts ?? 5_000));
  const batchSize = Math.max(1, Math.min(1_000, options.batchSize ?? 200));
  const before = countUnreconciledFactEvidence();
  const backup = backupMemoryDb({ retain: 7 });
  if ((options.requireBackup ?? true) && !backup) {
    throw new Error('Evidence reconciliation stopped because a preflight memory backup could not be created.');
  }
  let processed = 0;
  let available = 0;
  let unavailable = 0;
  let remaining = before;
  while (processed < maxFacts && remaining > 0) {
    const result = backfillTemporalEvidence(Math.min(batchSize, maxFacts - processed));
    if (result.scanned === 0) { remaining = result.remaining; break; }
    const classified = result.linked + result.missing;
    processed += result.scanned;
    available += result.linked;
    unavailable += result.missing;
    remaining = result.remaining;
    if (classified !== result.scanned) {
      throw new Error(`Evidence reconciliation classified ${classified}/${result.scanned} facts; stopped to avoid a non-advancing loop.`);
    }
  }
  return {
    backupPath: backup?.backupPath ?? null,
    before,
    processed,
    available,
    unavailable,
    remaining,
    complete: remaining === 0,
    elapsedMs: Date.now() - started,
  };
}

export function reapExpiredPendingReflections(now = new Date().toISOString()): number {
  const db = openMemoryDb();
  const rows = db.prepare(`
    SELECT session_id, call_id FROM reflection_pending_extractions
    WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
  `).all(now) as Array<{ session_id: string; call_id: string }>;
  const tx = db.transaction(() => {
    for (const row of rows) {
      db.prepare(`
        UPDATE memory_episodes SET status = 'expired'
        WHERE session_id = ? AND call_id = ? AND status = 'pending'
      `).run(row.session_id, row.call_id);
    }
    db.prepare(`
      DELETE FROM reflection_pending_extractions
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(now);
  });
  tx();
  return rows.length;
}
