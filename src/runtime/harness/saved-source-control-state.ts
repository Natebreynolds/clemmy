/** Source-wide owner decisions survive declaration/code changes. A new review
 * generation invalidates old grants without rewriting their historical proof. */
import { openEventLog } from './eventlog.js';

export interface SavedSourceControlState {
  revision: number; reviewId: string | null; stopped: boolean;
}
export function readSavedSourceControlState(slug: string, sourceId: string, db = openEventLog()): SavedSourceControlState {
  const row = db.prepare(`SELECT revision, review_id, stopped FROM workspace_source_controls_v1
    WHERE workspace_id = ? AND source_id = ?`).get(slug, sourceId) as
      { revision: number; review_id: string | null; stopped: number } | undefined;
  return row ? { revision: row.revision, reviewId: row.review_id, stopped: row.stopped === 1 }
    : { revision: 0, reviewId: null, stopped: false };
}

export function stopSavedSource(slug: string, sourceId: string, db = openEventLog()): void {
  db.prepare(`INSERT INTO workspace_source_controls_v1 (workspace_id, source_id, revision, review_id, stopped)
    VALUES (?, ?, 1, NULL, 1) ON CONFLICT(workspace_id, source_id) DO UPDATE
    SET revision = revision + 1, stopped = 1 WHERE stopped = 0`).run(slug, sourceId);
}

export function beginSavedSourceReview(slug: string, sourceId: string, reviewId: string, db = openEventLog()): void {
  db.prepare(`INSERT INTO workspace_source_controls_v1 (workspace_id, source_id, revision, review_id, stopped)
    VALUES (?, ?, 1, ?, 0) ON CONFLICT(workspace_id, source_id) DO UPDATE
    SET revision = revision + 1, review_id = excluded.review_id, stopped = 0`).run(slug, sourceId, reviewId);
}

export function savedSourceReviewIsCurrent(slug: string, sourceId: string, reviewId?: string, db = openEventLog()): boolean {
  const state = readSavedSourceControlState(slug, sourceId, db);
  return !state.stopped && state.reviewId === (reviewId ?? null);
}

export function savedSourceOccurrenceCanDispatch(slug: string, sourceId: string, occurrenceId: string): boolean {
  if (readSavedSourceControlState(slug, sourceId).stopped) return false;
  const row = openEventLog().prepare(`SELECT resolution_json FROM workspace_script_occurrences_v1
    WHERE workspace_id = ? AND source_id = ? AND occurrence_id = ?`).get(slug, sourceId, occurrenceId) as
      { resolution_json: string | null } | undefined;
  // Legacy one-shot callers have no source journal. Their exact call authority
  // is still required by the carrier; a source-wide stop also applies to them.
  return !row?.resolution_json;
}
