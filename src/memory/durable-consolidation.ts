import { createHash } from 'node:crypto';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { modelUsageAttributionStorage, withModelUsageAttribution, type ModelUsageAttributionContext } from '../runtime/usage-log.js';
import { openMemoryDb, type ConsolidatedFactKind, type MemoryEpisodeRow } from './db.js';
import { consolidateFact, type ConsolidateOptions } from './reflection.js';
import {
  recordReflectionCandidate,
  recordAutomaticMemoryCandidates, readAutomaticMemoryCandidate,
  commitAutomaticMemoryDecision, readOwnedAutomaticMemoryDecision,
} from './reflection-candidates.js';
import { recordMemoryEpisode, selectSupportingExcerpt } from './temporal-memory.js';
import { EVERYWHERE, isEverywhere, memoryScopeOf, sameScope, stampMemoryScope, withMemorySettledFor } from './memory-scope.js';
import { automaticMemoryDecisionDigest, resolveAutomaticMemoryDestination, type AutomaticMemoryOrigin } from './memory-destination.js';
import { saveUserProfile } from '../runtime/user-profile.js';
import { getFact } from './facts.js';
import { attachGroundedUserPeople, attachGroundedUserProjects } from './grounded-user-entities.js';
import { bumpStableContextGeneration } from '../runtime/stable-context-generation.js';
import { reviewStandingMemory } from './standing-memory-review.js';

const AUTO_CAPTURE_SOURCE = 'auto_capture' as const;
const AUTO_CAPTURE_MAX_ATTEMPTS = 8;
const AUTO_CAPTURE_LEASE_MS = 5 * 60 * 1_000;
const AUTO_CAPTURE_RETRY_BASE_MS = 15_000;
const AUTO_CAPTURE_RETRY_MAX_MS = 60 * 60 * 1_000;
const EXPLICIT_STABLE_CONTEXT_REASONS = new Set([
  'explicit remember request',
  'explicit durable correction',
]);

export const UNJUDGED_OWNER_STATEMENT_REASON = 'owner statement — model decides durability';

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
  /** Missing origins are legacy intake and may never authorize promotion. */
  origins?: Array<AutomaticMemoryOrigin | null>;
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
  intake_reason: string;
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
  const source = input.origins?.[0]?.source;
  const sourceTime = source?.authority === 'accepted_user_input'
    ? (openEventLog().prepare('SELECT created_at FROM events WHERE session_id = ? AND seq = ? AND id = ?')
      .get(source.sessionId, source.eventSeq, source.eventId) as { created_at: string } | undefined)?.created_at : undefined;
  if (sourceTime && input.occurredAt && input.occurredAt !== sourceTime) throw new Error('Automatic memory source time changed.');
  const occurredAt = sourceTime ?? input.occurredAt ?? new Date().toISOString();
  const sourceUri = `conversation://${encodeURIComponent(input.sessionId)}/${encodeURIComponent(callId)}`;
  let episodeId = '';
  const candidateIds: number[] = [];

  const tx = db.transaction(() => {
    const metadata = { candidateCount: input.candidates.length, sourceEventId: input.sourceEventId ?? null };
    const excerpt = message.replace(/\s+/g, ' ').trim().slice(0, 2_000);
    const expectedId = `call:${createHash('sha256').update(`${input.sessionId}:${callId}`).digest('hex').slice(0, 24)}`;
    const prior = db.prepare('SELECT * FROM memory_episodes WHERE id = ?').get(expectedId) as MemoryEpisodeRow | undefined;
    const retainedScope = source?.context?.memoryScope;
    if (prior && (prior.kind !== 'user_turn' || prior.subtype !== AUTO_CAPTURE_SOURCE
      || prior.session_id !== input.sessionId || prior.call_id !== callId || prior.source_app !== 'Conversation'
      || prior.source_uri !== sourceUri || prior.title !== 'User-stated durable memory candidates'
      || prior.status !== 'available' || prior.evidence_excerpt !== excerpt
      || prior.content_hash !== createHash('sha256').update(excerpt).digest('hex')
      || prior.metadata_json !== JSON.stringify(metadata)
      || ((sourceTime || input.occurredAt) && prior.occurred_at !== occurredAt)
      || (retainedScope && (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_scopes'").get()
        || !sameScope(memoryScopeOf('episode', prior.id), retainedScope))))) {
      throw new Error('Automatic memory episode conflicts with its frozen source.');
    }
    const createEpisode = () => recordMemoryEpisode({
      kind: 'user_turn', subtype: AUTO_CAPTURE_SOURCE, title: 'User-stated durable memory candidates', metadata,
      sourceApp: 'Conversation', sessionId: input.sessionId, callId, sourceUri, occurredAt,
      content: message, status: 'available',
    });
    // A replay never upserts the source episode, including its original scope,
    // occurrence/ingestion timestamps and bounded (2,000 character) excerpt.
    const episode = prior ?? (source ? withMemorySettledFor(retainedScope ?? EVERYWHERE, createEpisode) : createEpisode());
    if (!prior && retainedScope) {
      // Include global scope: this initializes the canonical scope store even
      // in a new empty home and does not swallow a failed scope write.
      stampMemoryScope('episode', episode.id, retainedScope, { sessionId: input.sessionId });
      if (!sameScope(memoryScopeOf('episode', episode.id), retainedScope)) throw new Error('Automatic memory episode scope did not persist.');
    }
    episodeId = episode.id;
    const entries = input.candidates.map(candidate => ({
      episodeId: episode.id, sessionId: input.sessionId, callId,
      kind: candidate.kind, text: candidate.content, importance: candidate.importance ?? 5,
      intakeReason: candidate.reason, trustLevel: 1, sourceUri, pin: candidate.pin, now: occurredAt,
    }));
    if (input.origins) {
      if (input.origins.length !== entries.length || input.origins.some(origin => origin === null)) {
        throw new Error('Automatic memory intake has no exact origin for every candidate.');
      }
      candidateIds.push(...recordAutomaticMemoryCandidates(entries.map((entry, index) => ({
        ...entry, origin: input.origins![index]!,
      })), db));
    } else {
      // Preserve historical rows without retroactively granting new authority.
      candidateIds.push(...entries.map(entry => recordReflectionCandidate({
        ...entry, sourceType: AUTO_CAPTURE_SOURCE, authority: 'user',
      })));
    }
  });
  tx.immediate();
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
           mrc.authority, mrc.source_uri, mrc.pin, mrc.intake_reason,
           mrc.attempt_count,
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

/** Restore accounting ownership from the persisted accepted source on replay.
 * Never infer a source from timestamps, a turn number, or the draining chat. */
function candidateUsageScope(row: PendingAutoCaptureRow): ModelUsageAttributionContext {
  const match = /^auto-capture:user-source:([1-9][0-9]*)$/.exec(row.call_id);
  const seq = match ? Number(match[1]) : 0;
  let verified = false;
  if (Number.isSafeInteger(seq) && seq > 0) {
    try {
      verified = Boolean(openEventLog().prepare(`SELECT 1 FROM events
        WHERE session_id = ? AND seq = ? AND role = 'user' AND type = 'user_input_received'`)
        .get(row.session_id, seq));
    } catch { /* Unknown ownership stays unassigned, never guessed. */ }
  }
  const ambient = modelUsageAttributionStorage.getStore();
  const sameTurn = verified && ambient?.sessionId === row.session_id && ambient.sourceUserSeq === seq;
  // Preserve an immediate caller's existing selection scope only for its own
  // source. A maintenance replay restores accounting, never execution pins.
  return {
    sessionId: sameTurn ? row.session_id : '',
    sourceUserSeq: sameTurn ? seq : 0,
    ...(sameTurn ? ambient : {}),
    usageParentTurn: verified ? {sessionId:row.session_id, sourceUserSeq:seq,
      ...(sameTurn && ambient?.attemptId ? {attemptId:ambient.attemptId} : {})} : undefined,
  };
}

class LostAutomaticMemoryOwnership extends Error {
  constructor() { super('Automatic memory processing ownership changed.'); }
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
  standingReviewer?: typeof reviewStandingMemory;
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
    const usageScope = candidateUsageScope(row);
    const claim = { attemptCount: attempt, processingStartedAt: now };
    const settle = (status: 'promoted' | 'rejected', reason: string, factId: number | null = null): boolean =>
      Number(db.prepare(`UPDATE memory_reflection_candidates SET status = ?, reason = ?, resulting_fact_id = ?,
        resolved_at = ?, processing_started_at = NULL, next_attempt_at = NULL
        WHERE id = ? AND status = 'pending' AND attempt_count = ? AND processing_started_at = ?`)
        .run(status, reason.slice(0, 240), factId, now, row.id, attempt, now).changes) === 1;
    try {
      const stored = readAutomaticMemoryCandidate(row.id, db);
      if (stored.status !== 'valid') {
        settle('rejected', `destination_${stored.status}`);
        result.skipped += 1; continue;
      }
      const origin = stored.envelope.origin;
      const owner = { id: row.id, originDigest: stored.envelope.originDigest, claim };
      const { automaticMemoryOriginSourceIsCurrent, extractProfilePatchFromMessage } = await import('./auto-capture.js');
      if (!automaticMemoryOriginSourceIsCurrent(origin)) {
        settle('rejected', 'destination_source_unavailable');
        result.skipped += 1; continue;
      }
      if (origin.claimMode === 'unresolved') {
        settle('rejected', 'destination_claim_unresolved');
        result.skipped += 1; continue;
      }
      let envelope = stored.envelope;
      if (!envelope.decision) {
        // Every admitted claim needs a destination decision. Share the same
        // review call that already judges inferred/compound durability.
        const mode = EXPLICIT_STABLE_CONTEXT_REASONS.has(row.intake_reason) || origin.claimMode === 'complete'
          ? 'destination' : row.intake_reason === UNJUDGED_OWNER_STATEMENT_REASON ? 'volunteered' : 'inferred';
        const review = await withModelUsageAttribution(usageScope, () =>
          (options.standingReviewer ?? reviewStandingMemory)(origin.source.ownerText, row.text, mode, origin));
        if (!review.destinationDecision || review.scope !== review.destinationDecision.durability) {
          throw new Error('Automatic memory review omitted its checked destination decision.');
        }
        const committed = commitAutomaticMemoryDecision({ ...owner, decision: review.destinationDecision }, db);
        if (committed.status === 'conflict') throw new Error('Automatic memory destination decision conflicts with its complete source claim.');
        if (committed.status !== 'committed' && committed.status !== 'replayed') {
          result.skipped += 1; continue;
        }
        envelope = committed.envelope;
      }
      const destination = resolveAutomaticMemoryDestination(envelope);
      if (destination.status !== 'resolved') {
        settle('rejected', `destination_${destination.status}:${destination.reason}`);
        result.skipped += 1; continue;
      }
      const decisionDigest = automaticMemoryDecisionDigest(envelope);
      const runMutation: NonNullable<ConsolidateOptions['runMutation']> = action => db.transaction(() => {
        const current = readOwnedAutomaticMemoryDecision(owner, db);
        if (current.status !== 'owned' || automaticMemoryDecisionDigest(current.envelope) !== decisionDigest
          || !automaticMemoryOriginSourceIsCurrent(origin)) throw new LostAutomaticMemoryOwnership();
        return action();
      }).immediate();
      // Check immediately before entering async consolidation, and at every
      // later mutation through its synchronous transaction hook.
      runMutation(() => undefined);
      const sourceText = origin.source.ownerText;
      const candidateText = destination.claimText;
      const excerpt = selectSupportingExcerpt(sourceText, candidateText);
      const outcome = await withModelUsageAttribution(usageScope, () => consolidateFact({
        kind: row.kind, text: candidateText, importance: row.importance,
        trustLevel: row.trust_level ?? 1, authority: row.authority ?? 'user',
        sourceApp: 'Conversation', sourceUri: row.source_uri ?? row.episode_source_uri ?? undefined,
        occurredAt: row.occurred_at, pin: row.pin === 1,
        evidence: { episodeId: row.episode_id, excerpt, sourceUri: row.source_uri ?? row.episode_source_uri },
      }, { sessionId: row.session_id, scope: destination.scope }, {
        ...(options.resolver ? { resolver: options.resolver } : {}), runMutation,
      }));
      runMutation(() => {
        // Enrichment also uses the reviewed claim and scope, not unrelated
        // task text elsewhere in the source turn.
        if (isEverywhere(destination.scope)) withMemorySettledFor(destination.scope, () => {
          attachGroundedUserPeople({ factId: outcome.factId, episodeId: row.episode_id,
            sourceText: candidateText, sourceUri: row.source_uri ?? row.episode_source_uri });
          attachGroundedUserProjects({ factId: outcome.factId, episodeId: row.episode_id,
            sourceText: candidateText, sourceUri: row.source_uri ?? row.episode_source_uri });
        });
        const fact = outcome.factId ? getFact(outcome.factId) : null;
        // A profile has global reach. It may adapt only from an actually saved
        // current global claim with affirmative default/global destination.
        // Whole-source privacy and current-task guards remain authoritative.
        if (fact?.active && !outcome.unresolvedConflict && isEverywhere(destination.scope)
          && sameScope(memoryScopeOf('fact', fact.id), destination.scope)
          && fact.content.replace(/\s+/g, ' ').trim() === candidateText.replace(/\s+/g, ' ').trim()
          && (envelope.decision!.destination === 'everywhere' || envelope.decision!.destination === 'kind_default')
          && extractProfilePatchFromMessage(sourceText)) {
          const patch = extractProfilePatchFromMessage(candidateText);
          if (patch) saveUserProfile(patch);
        }
        if (!settle('promoted', `consolidation:${outcome.action}`, outcome.factId ?? null)) throw new LostAutomaticMemoryOwnership();
      });
      if (outcome.action !== 'ignore' && EXPLICIT_STABLE_CONTEXT_REASONS.has(row.intake_reason)) bumpStableContextGeneration();
      result.promoted += 1;
    } catch (error) {
      if (error instanceof LostAutomaticMemoryOwnership) { result.skipped += 1; continue; }
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      if (attempt >= AUTO_CAPTURE_MAX_ATTEMPTS) {
        const changed = db.prepare(`
          UPDATE memory_reflection_candidates
          SET status = 'expired', reason = 'retry_exhausted', resolved_at = ?,
              processing_started_at = NULL, next_attempt_at = NULL, last_error = ?
          WHERE id = ? AND status = 'pending' AND attempt_count = ? AND processing_started_at = ?
        `).run(now, message, row.id, attempt, now);
        if (Number(changed.changes) === 1) result.expired += 1; else result.skipped += 1;
      } else {
        const nextAttemptAt = new Date(Date.parse(now) + retryDelayMs(attempt)).toISOString();
        const changed = db.prepare(`
          UPDATE memory_reflection_candidates
          SET processing_started_at = NULL, next_attempt_at = ?, last_error = ?
          WHERE id = ? AND status = 'pending' AND attempt_count = ? AND processing_started_at = ?
        `).run(nextAttemptAt, message, row.id, attempt, now);
        if (Number(changed.changes) === 1) result.retried += 1; else result.skipped += 1;
      }
    }
  }
  return result;
}
