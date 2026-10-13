import { createHash } from 'node:crypto';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { sourceWritesAtStake } from '../runtime/harness/host-completion-work.js';
import { completionReviewStakes } from '../runtime/harness/host-turn-runner.js';

export interface WorkflowCompletionStakesProof {
  reviewStakes: 'read' | 'write';
  /** Private exact frontier of the settled work the stakes were read from;
   * never evidence of completion or execution authority. */
  reviewStakesDigest: string;
}

/** A run's review stakes follow what its steps actually did, by the chat
 * turn's own rule (`completionReviewStakes` over `sourceWritesAtStake`): a
 * write that reached outside the machine, failed, was refused, or changed
 * local state that cannot simply be restored takes the full review; reads
 * alone, and local artifact writes the owner can get back, take the fast
 * review. A step's authored side effect and its output say nothing here; the
 * settled ledger of the run's own sessions does. Inventory this reading
 * cannot trust in full (too many sessions or rows, a session owned by another
 * run, an unreadable ledger) is read as a write. */
export function readWorkflowCompletionStakes(input: { runId: string }): WorkflowCompletionStakesProof {
  const frontier: unknown[] = [input.runId];
  let known = true;
  let attemptedWrites = 0;
  const finish = (): WorkflowCompletionStakesProof => ({
    reviewStakes: !known || completionReviewStakes({ plan: false, attemptedWrites }) === 'write' ? 'write' : 'read',
    reviewStakesDigest: createHash('sha256').update(JSON.stringify(frontier)).digest('hex') });
  try {
    const db = openEventLog();
    const prefix = `workflow:${input.runId}:`;
    // A parked model step may use a UUID, and a deterministic partition has
    // its own session. A prefix alone is not the run's inventory.
    const sessions = db.prepare(`SELECT id, kind, metadata_json FROM sessions
      WHERE (id >= ? AND id < ?)
         OR (json_valid(metadata_json) AND json_extract(metadata_json, '$.workflowRunId') = ?)
         OR id IN (SELECT session_id FROM accepted_turn_call_authorities WHERE run_id = ?)
      ORDER BY id LIMIT 513`).all(prefix, `${prefix.slice(0, -1)};`, input.runId, input.runId) as Array<{
        id: string; kind: string; metadata_json: string | null;
      }>;
    if (sessions.length > 512) { known = false; frontier.push('session_limit'); return finish(); }
    for (const session of sessions) {
      // A session named for this run but owned by another run, or of a kind
      // the runner never activates, is not inventory this run's stakes can
      // be read from.
      let owner: unknown;
      try { owner = (JSON.parse(session.metadata_json ?? 'null') as Record<string, unknown> | null)?.workflowRunId; }
      catch { owner = undefined; }
      if (session.kind !== 'workflow' || (owner !== undefined && owner !== input.runId)) {
        known = false;
        frontier.push([session.id, 'foreign_owner']);
      }
    }
    if (sessions.length === 0) return finish();
    const ids = sessions.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(',');
    // Hash identities, states and effect classes only; encrypted history and
    // request payloads are neither reopened nor retained by this reading.
    const calls = db.prepare(`SELECT session_id, source_user_seq, logical_tool_call_id, tool_name, state
        FROM logical_tool_calls WHERE session_id IN (${placeholders})
       ORDER BY session_id, source_user_seq, logical_tool_call_id LIMIT 4097`).all(...ids) as Array<Record<string, unknown>>;
    const settlements = db.prepare(`SELECT session_id, source_user_seq, logical_tool_call_id, execution_kind,
             outcome_kind, mutating, requirement_id, settlement_event_id
        FROM logical_call_settlements WHERE session_id IN (${placeholders})
       ORDER BY session_id, source_user_seq, logical_tool_call_id LIMIT 4097`).all(...ids) as Array<Record<string, unknown>>;
    frontier.push(calls.slice(0, 4096), settlements.slice(0, 4096));
    if (calls.length > 4096 || settlements.length > 4096) { known = false; frontier.push('row_limit'); return finish(); }
    const sources = new Set(settlements.map((row) => JSON.stringify([String(row.session_id), Number(row.source_user_seq)])));
    for (const key of sources) {
      const [sessionId, sourceUserSeq] = JSON.parse(key) as [string, number];
      attemptedWrites += sourceWritesAtStake({ sessionId, sourceUserSeq });
    }
    return finish();
  } catch { known = false; frontier.push('unavailable'); return finish(); }
}
