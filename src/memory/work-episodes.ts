/**
 * Work episodes: what Clementine finished, kept like a cache.
 *
 * A finished plan or a reviewed answer left no trace a later chat could find.
 * Live 2026-09-26: the same request ("scrape 10 DUI law firms in Austin") was
 * planned four times, 35–40 investigation calls each, because a plan turn
 * never records what it learned; three audits of the same site were fetched
 * again from a fresh chat because the earlier results were in another
 * session. Executed runs already leave a run strategy; plans and answers now
 * leave an episode in memory, which the turn-start primer already surfaces
 * with its age.
 *
 * Cache mentality (owner, 2026-09-26): everything is tracked, and everything
 * decays. A work episode is FRESH for a few days (its handles are offered for
 * reuse, with the age shown), then SUMMARIZED (one line of what was done,
 * handles gone), then DELETED. The sweep runs with the other retention passes.
 */
import { openMemoryDb } from './db.js';
import { recordMemoryEpisode } from './temporal-memory.js';

export const WORK_EPISODE_SUBTYPE = 'completed_work';
export const WORK_EPISODE_SOURCE_APP = 'clementine';
/** Handles are offered for reuse this long. */
export const WORK_EPISODE_FRESH_DAYS = 7;
/** The one-line summary outlives the handles this long, then the record goes. */
export const WORK_EPISODE_SUMMARY_DAYS = 30;

export type WorkKind = 'plan' | 'answer';

export interface PlanWorkRef {
  planId: string;
  revision: number;
  digest: string;
  readiness: 'ready' | 'needs_input';
}

export interface WorkEpisodeInput {
  kind: WorkKind;
  sessionId: string;
  sourceUserSeq: number;
  /** The accepted request, as the owner wrote it. */
  objective: string;
  /** One sentence of what was produced, in Clem's words. */
  outcome: string;
  finishedAt?: string;
  plan?: PlanWorkRef;
  /** Retained result handles the answer rests on (ids only; content stays in its session). */
  resultHandleIds?: readonly string[];
  toolsUsed?: readonly string[];
  /** Ids of things created or changed (a Space slug, a file revision). */
  createdIds?: readonly string[];
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/** The reuse line the brain reads: what to call to pick the work up again. */
function reuseLine(input: WorkEpisodeInput): string {
  if (input.kind === 'plan' && input.plan) {
    const ref = JSON.stringify({ planId: input.plan.planId, revision: input.plan.revision, digest: input.plan.digest });
    return input.plan.readiness === 'ready'
      ? `Ready plan; to reuse it unchanged call publish_plan with base_ref_json=${ref} and no full_text; to change it, revise from that base.`
      : `Plan still needs input; base_ref_json=${ref}.`;
  }
  const parts: string[] = [];
  if (input.resultHandleIds?.length) parts.push(`${input.resultHandleIds.length} retained result${input.resultHandleIds.length === 1 ? '' : 's'} in session ${input.sessionId} (open with session_search / session_history; they are that chat's results, reuse them only with their age stated)`);
  if (input.createdIds?.length) parts.push(`created: ${input.createdIds.slice(0, 5).join(', ')}`);
  if (input.toolsUsed?.length) parts.push(`via ${input.toolsUsed.slice(0, 6).join(', ')}`);
  return parts.join('; ');
}

function workEpisodeCallId(kind: WorkKind, sourceUserSeq: number): string {
  return `work:${kind}:${sourceUserSeq}`;
}

/** Whether a work episode of this kind already exists for the accepted request. */
export function hasWorkEpisode(input: { sessionId: string; kind: WorkKind; sourceUserSeq: number }): boolean {
  try {
    return openMemoryDb().prepare('SELECT 1 FROM memory_episodes WHERE subtype = ? AND session_id = ? AND call_id = ? LIMIT 1')
      .get(WORK_EPISODE_SUBTYPE, input.sessionId, workEpisodeCallId(input.kind, input.sourceUserSeq)) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Record one finished piece of work. Idempotent per accepted request and
 * kind: the episode id derives from (sessionId, callId), so a second call for
 * the same request updates the same row.
 */
export function recordWorkEpisode(input: WorkEpisodeInput): { id: string } | null {
  try {
    const objective = clip(input.objective, 200);
    if (!objective) return null;
    const finishedAt = input.finishedAt ?? new Date().toISOString();
    const title = `Completed ${input.kind}: ${objective}`;
    const content = [
      `${input.kind === 'plan' ? 'Planned' : 'Answered'} at ${finishedAt}: ${clip(input.outcome, 400)}`,
      reuseLine(input),
    ].filter(Boolean).join(' ');
    const row = recordMemoryEpisode({
      kind: 'user_turn',
      subtype: WORK_EPISODE_SUBTYPE,
      title,
      content,
      sourceApp: WORK_EPISODE_SOURCE_APP,
      sessionId: input.sessionId,
      callId: workEpisodeCallId(input.kind, input.sourceUserSeq),
      sourceUri: `clementine://work/${encodeURIComponent(input.sessionId)}/${input.sourceUserSeq}`,
      occurredAt: finishedAt,
      rawRetainedUntil: addDays(finishedAt, WORK_EPISODE_FRESH_DAYS),
      status: 'available',
      metadata: {
        workKind: input.kind,
        finishedAt,
        ...(input.plan ? { plan: input.plan } : {}),
        ...(input.resultHandleIds?.length ? { resultHandleIds: input.resultHandleIds.slice(0, 50) } : {}),
        ...(input.toolsUsed?.length ? { toolsUsed: input.toolsUsed.slice(0, 12) } : {}),
        ...(input.createdIds?.length ? { createdIds: input.createdIds.slice(0, 20) } : {}),
      },
    });
    return { id: row.id };
  } catch {
    return null;
  }
}

export interface WorkEpisodeDecay {
  summarized: number;
  deleted: number;
}

/**
 * Decay: past its fresh window a work episode loses its handles and keeps
 * one line of what was done; past the summary window it is deleted.
 * Never touches episodes of other subtypes.
 */
export function decayWorkEpisodes(input: { now?: string; summaryDays?: number } = {}): WorkEpisodeDecay {
  const now = input.now ?? new Date().toISOString();
  const summaryDays = input.summaryDays ?? WORK_EPISODE_SUMMARY_DAYS;
  const db = openMemoryDb();
  const result: WorkEpisodeDecay = { summarized: 0, deleted: 0 };
  const run = db.transaction(() => {
    const deleted = db.prepare(`
      DELETE FROM memory_episodes
       WHERE subtype = ? AND julianday(occurred_at) < julianday(?, ?)
    `).run(WORK_EPISODE_SUBTYPE, now, `-${Math.max(1, Math.floor(summaryDays))} days`);
    result.deleted = deleted.changes;
    const stale = db.prepare(`
      SELECT id, evidence_excerpt AS excerpt, metadata_json AS metadata FROM memory_episodes
       WHERE subtype = ? AND status = 'available'
         AND raw_retained_until IS NOT NULL AND julianday(raw_retained_until) <= julianday(?)
    `).all(WORK_EPISODE_SUBTYPE, now) as Array<{ id: string; excerpt: string | null; metadata: string | null }>;
    const update = db.prepare(`
      UPDATE memory_episodes SET status = 'partial', evidence_excerpt = ?, metadata_json = ? WHERE id = ?
    `);
    for (const row of stale) {
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(row.metadata ?? '{}') as Record<string, unknown>; } catch { /* keep what parses */ }
      const kept = { workKind: metadata.workKind, finishedAt: metadata.finishedAt, handlesExpired: true };
      const summary = `${(row.excerpt ?? '').split(' Ready plan;')[0].split(' retained result')[0].trim()} (handles expired; the work is only a memory now)`;
      update.run(clip(summary, 500), JSON.stringify(kept), row.id);
      result.summarized += 1;
    }
  });
  run();
  return result;
}
