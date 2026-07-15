import { createHash } from 'node:crypto';
import { openMemoryDb, type ConsolidatedFactKind } from './db.js';
import { consolidateFact, type ConsolidateOptions } from './reflection.js';
import {
  recordReflectionCandidate,
  resolveReflectionCandidateById,
} from './reflection-candidates.js';
import { recordMemoryEpisode, selectSupportingExcerpt } from './temporal-memory.js';
import { attachGroundedUserPeople } from './grounded-user-entities.js';

const AUTO_CAPTURE_SOURCE = 'auto_capture' as const;
const AUTO_CAPTURE_MAX_ATTEMPTS = 8;
const AUTO_CAPTURE_LEASE_MS = 5 * 60 * 1_000;
const AUTO_CAPTURE_RETRY_BASE_MS = 15_000;
const AUTO_CAPTURE_RETRY_MAX_MS = 60 * 60 * 1_000;

export interface DurableAutoCaptureCandidate {
  kind: ConsolidatedFactKind;
  content: string;
  reason: string;
  pin?: boolean;
  importance?: number;
}

export interface EnqueueAutoCaptureInput {
  message: string;
  sessionId: string;
  /** Stable identity of the actual source turn. Callers with a turn/run id
   * should pass it; otherwise a content hash safely collapses duplicate lane
   * delivery of the same message. */
  sourceEventId?: string;
  occurredAt?: string;
  candidates: DurableAutoCaptureCandidate[];
}

export interface EnqueueAutoCaptureResult {
  episodeId: string | null;
  candidateIds: number[];
  callId: string | null;
}

export interface DrainDurableConsolidationResult {
  selected: number;
  claimed: number;
  promoted: number;
  retried: number;
  expired: number;
  skipped: number;
}

interface PendingAutoCaptureRow {
  id: number;
  episode_id: string;
  session_id: string;
  call_id: string;
  kind: ConsolidatedFactKind;
  text: string;
  importance: number;
  trust_level: number | null;
  authority: 'user' | 'derived' | 'import' | 'manual' | null;
  source_uri: string | null;
  pin: number;
  attempt_count: number;
  evidence_excerpt: string | null;
  episode_source_uri: string | null;
  occurred_at: string;
}

function stableToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
}

function autoCaptureCallId(input: EnqueueAutoCaptureInput): string {
  const explicit = stableToken(input.sourceEventId ?? '');
  if (explicit) return `auto-capture:${explicit}`;
  const digest = createHash('sha256')
    .update(`${input.sessionId}\n${input.message.replace(/\s+/g, ' ').trim()}`)
    .digest('hex')
    .slice(0, 24);
  return `auto-capture:message:${digest}`;
}

/**
 * Persist an exact user-turn episode and every proposed fact before semantic
 * consolidation starts. The transaction is the crash boundary: after it
 * commits, either the immediate worker or maintenance can replay the claim;
 * repeated delivery of the same source turn reuses the same episode/candidate.
 */
export function enqueueAutoCaptureCandidates(input: EnqueueAutoCaptureInput): EnqueueAutoCaptureResult {
  if (input.candidates.length === 0) return { episodeId: null, candidateIds: [], callId: null };
  const message = input.message.trim();
  if (!message) return { episodeId: null, candidateIds: [], callId: null };

  const db = openMemoryDb();
  const callId = autoCaptureCallId(input);
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const sourceUri = `conversation://${encodeURIComponent(input.sessionId)}/${encodeURIComponent(callId)}`;
  let episodeId = '';
  const candidateIds: number[] = [];

  const tx = db.transaction(() => {
    const episode = recordMemoryEpisode({
      kind: 'user_turn',
      subtype: AUTO_CAPTURE_SOURCE,
      title: 'User-stated durable memory candidates',
      metadata: { candidateCount: input.candidates.length, sourceEventId: input.sourceEventId ?? null },
      sourceApp: 'Conversation',
      sessionId: input.sessionId,
      callId,
      sourceUri,
      occurredAt,
      content: message,
      status: 'available',
    });
    episodeId = episode.id;
    for (const candidate of input.candidates) {
      candidateIds.push(recordReflectionCandidate({
        episodeId: episode.id,
        sessionId: input.sessionId,
        callId,
        kind: candidate.kind,
        text: candidate.content,
        importance: candidate.importance ?? 5,
        sourceType: AUTO_CAPTURE_SOURCE,
        intakeReason: candidate.reason,
        trustLevel: 1,
        authority: 'user',
        sourceUri,
        pin: candidate.pin,
        now: occurredAt,
      }));
    }
  });
  tx();
  return { episodeId, candidateIds, callId };
}

function retryDelayMs(attempt: number): number {
  return Math.min(AUTO_CAPTURE_RETRY_MAX_MS, AUTO_CAPTURE_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)));
}

function candidateRows(options: { ids?: number[]; limit: number; now: string }): PendingAutoCaptureRow[] {
  const db = openMemoryDb();
  const staleLease = new Date(Date.parse(options.now) - AUTO_CAPTURE_LEASE_MS).toISOString();
  const ids = [...new Set((options.ids ?? []).filter((id) => Number.isInteger(id) && id > 0))];
  const idClause = ids.length > 0 ? `AND mrc.id IN (${ids.map(() => '?').join(',')})` : '';
  return db.prepare(`
    SELECT mrc.id, mrc.episode_id, mrc.session_id, mrc.call_id,
           mrc.kind, mrc.text, mrc.importance, mrc.trust_level,
           mrc.authority, mrc.source_uri, mrc.pin, mrc.attempt_count,
           me.evidence_excerpt, me.source_uri AS episode_source_uri,
           me.occurred_at
    FROM memory_reflection_candidates mrc
    JOIN memory_episodes me ON me.id = mrc.episode_id
    WHERE mrc.source_type = '${AUTO_CAPTURE_SOURCE}'
      AND mrc.status = 'pending'
      AND (mrc.next_attempt_at IS NULL OR mrc.next_attempt_at <= ?)
      AND (mrc.processing_started_at IS NULL OR mrc.processing_started_at <= ?)
      ${idClause}
    ORDER BY mrc.created_at ASC, mrc.id ASC
    LIMIT ?
  `).all(options.now, staleLease, ...ids, options.limit) as PendingAutoCaptureRow[];
}

/** Process durable user-statement candidates. Claims are leased before any
 * model call, retried with bounded backoff, and resolved against the canonical
 * fact id. A failed immediate microtask therefore becomes visible queued work
 * instead of a silently lost memory. */
export async function drainDurableConsolidationCandidates(options: {
  ids?: number[];
  limit?: number;
  now?: string;
  resolver?: ConsolidateOptions['resolver'];
} = {}): Promise<DrainDurableConsolidationResult> {
  const limit = Math.max(1, Math.min(50, options.limit ?? 8));
  const now = options.now ?? new Date().toISOString();
  const rows = candidateRows({ ids: options.ids, limit, now });
  const result: DrainDurableConsolidationResult = {
    selected: rows.length,
    claimed: 0,
    promoted: 0,
    retried: 0,
    expired: 0,
    skipped: 0,
  };
  const db = openMemoryDb();
  const staleLease = new Date(Date.parse(now) - AUTO_CAPTURE_LEASE_MS).toISOString();

  for (const row of rows) {
    const claimed = db.prepare(`
      UPDATE memory_reflection_candidates
      SET processing_started_at = ?, attempt_count = attempt_count + 1,
          last_error = NULL
      WHERE id = ? AND status = 'pending' AND source_type = ?
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND (processing_started_at IS NULL OR processing_started_at <= ?)
    `).run(now, row.id, AUTO_CAPTURE_SOURCE, now, staleLease);
    if (Number(claimed.changes ?? 0) !== 1) {
      result.skipped += 1;
      continue;
    }
    result.claimed += 1;
    const attempt = row.attempt_count + 1;
    try {
      const sourceText = row.evidence_excerpt?.trim() ?? '';
      if (!sourceText) throw new Error('durable source episode has no evidence excerpt');
      const excerpt = selectSupportingExcerpt(sourceText, row.text);
      const outcome = await consolidateFact({
        kind: row.kind,
        text: row.text,
        importance: row.importance,
        trustLevel: row.trust_level ?? 1,
        authority: row.authority ?? 'user',
        sourceApp: 'Conversation',
        sourceUri: row.source_uri ?? row.episode_source_uri ?? undefined,
        occurredAt: row.occurred_at,
        pin: row.pin === 1,
        evidence: {
          episodeId: row.episode_id,
          excerpt,
          sourceUri: row.source_uri ?? row.episode_source_uri,
        },
      }, { sessionId: row.session_id }, options.resolver ? { resolver: options.resolver } : {});
      const people = attachGroundedUserPeople({
        factId: outcome.factId,
        episodeId: row.episode_id,
        sourceText,
        sourceUri: row.source_uri ?? row.episode_source_uri,
      });
      const entityDecision = people.extracted > 0
        ? `;people_observed=${people.observed};person_links=${people.linked};person_failures=${people.failures.length}`
        : '';
      resolveReflectionCandidateById({
        id: row.id,
        status: 'promoted',
        reason: `consolidation:${outcome.action}${entityDecision}`,
        resultingFactId: outcome.factId,
        now,
      });
      result.promoted += 1;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      if (attempt >= AUTO_CAPTURE_MAX_ATTEMPTS) {
        db.prepare(`
          UPDATE memory_reflection_candidates
          SET status = 'expired', reason = 'retry_exhausted', resolved_at = ?,
              processing_started_at = NULL, next_attempt_at = NULL, last_error = ?
          WHERE id = ? AND status = 'pending'
        `).run(now, message, row.id);
        result.expired += 1;
      } else {
        const nextAttemptAt = new Date(Date.parse(now) + retryDelayMs(attempt)).toISOString();
        db.prepare(`
          UPDATE memory_reflection_candidates
          SET processing_started_at = NULL, next_attempt_at = ?, last_error = ?
          WHERE id = ? AND status = 'pending'
        `).run(nextAttemptAt, message, row.id);
        result.retried += 1;
      }
    }
  }
  return result;
}
