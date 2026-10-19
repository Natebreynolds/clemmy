/** A current, read-only projection of the original accepted request's memory
 * subwork. It cannot complete, replay or revise the original chat turn. */
import type { TaskMemoryStatus } from '../types/task-handling.js';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { readMemoryConsolidationStatusEvidence } from '../runtime/harness/durable-memory-intake-receipt.js';

export function readTaskMemoryStatus(identity: { sessionId: string; sourceUserSeq: number }, now = new Date()): TaskMemoryStatus | null {
  const { sessionId, sourceUserSeq } = identity;
  if (!sessionId || sessionId.length > 256 || !Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) return null;
  const db = openEventLog();
  if (!db.prepare(`SELECT 1 FROM events WHERE session_id = ? AND seq = ?
    AND type = 'user_input_received' AND role = 'user'`).get(sessionId, sourceUserSeq)) return null;
  const result: TaskMemoryStatus = { version: 1, ...identity, observedAt: now.toISOString(), memory: null };
  const hint = Boolean(db.prepare(`SELECT 1 FROM events WHERE session_id = ? AND type = 'conversation_completed'
    AND role = 'system' AND json_valid(data_json) AND json_extract(data_json, '$.sourceUserSeq') = ?
    AND json_extract(data_json, '$.blockedReason') IN ('memory_consolidation_pending', 'memory_work_unverified') LIMIT 1`)
    .get(sessionId, sourceUserSeq));
  const evidence = readMemoryConsolidationStatusEvidence(identity);
  if (evidence.status !== 'ok') {
    // A missing hint is never replaced with a latest-turn/time-window guess.
    if (hint) result.memory = { state: 'unavailable', candidates: [],
      counts: { pending: 0, saved: 0, refused: 0, needsChoice: 0, unavailable: 1 }, nextStep: 'check_again', pollAfterMs: null };
    return result;
  }
  const rows = evidence.results.filter(row => row.ownerStated);
  if (!rows.length) return result;
  const candidates: NonNullable<TaskMemoryStatus['memory']>['candidates'] = rows.map(row => {
    const base = { candidateId: row.candidateId };
    if (row.status === 'pending') return { ...base, state: 'pending' };
    if (row.status === 'expired') return { ...base, state: 'unavailable', reason: 'retry_exhausted' };
    if (row.status === 'rejected') {
      if (row.destinationStatus === 'unresolved' && !/^destination_(?:source_unavailable|invalid|missing)/.test(row.disposition ?? '')) {
        return { ...base, state: 'needs_choice', reason: 'destination_unresolved' };
      }
      if (/^destination_(?:source_unavailable|invalid|missing)/.test(row.disposition ?? '')) {
        return { ...base, state: 'unavailable', reason: 'unverified' };
      }
      return { ...base, state: 'refused' };
    }
    if (row.fact?.superseded) return { ...base, state: 'unavailable', reason: 'superseded', factId: row.fact.id };
    if (row.fact && !row.fact.active) return { ...base, state: 'unavailable', reason: 'inactive', factId: row.fact.id };
    if (row.verified && row.fact?.active) return { ...base, state: 'saved', factId: row.fact.id };
    return { ...base, state: 'unavailable', reason: 'unverified' };
  });
  const counts = { pending: 0, saved: 0, refused: 0, needsChoice: 0, unavailable: 0 };
  for (const row of candidates) counts[row.state === 'needs_choice' ? 'needsChoice' : row.state] += 1;
  const states = new Set(candidates.map(row => row.state));
  result.memory = { state: states.size === 1 ? candidates[0]!.state : 'mixed', candidates, counts,
    nextStep: counts.needsChoice ? 'clarify_destination' : counts.unavailable
      ? candidates.some(row => row.reason === 'inactive' || row.reason === 'superseded') ? 'review_memory' : 'check_again'
      : counts.pending ? 'wait' : counts.refused ? 'review_memory' : 'none',
    pollAfterMs: counts.pending ? 2000 : null };
  return result;
}
