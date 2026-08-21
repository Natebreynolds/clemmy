/**
 * Durable semantic participation for one accepted source.
 *
 * The atomic admit boundary records whether a semantic port participated
 * before interpretation. Callers must not re-peek the process registry
 * after that point: a concurrent uninstall cannot turn a participating
 * refusal into a legacy failed/untyped path.
 */
import { openEventLog } from '../harness/eventlog.js';

export type SemanticParticipationV1 = 'participated' | 'unparticipated';
export type SemanticDispositionOutcomeV1 = 'admitted' | 'blocked' | 'unavailable';

export interface SemanticDispositionV1 {
  participation: SemanticParticipationV1;
  outcome: SemanticDispositionOutcomeV1 | null;
}

export function recordSemanticParticipation(
  sessionId: string,
  sourceUserSeq: number,
  participation: SemanticParticipationV1,
): SemanticDispositionV1 {
  const db = openEventLog();
  const now = new Date().toISOString();
  db.transaction(() => {
    const existing = db.prepare(
      `SELECT participation, outcome FROM turn_semantics_dispositions
        WHERE session_id = ? AND source_user_seq = ?`,
    ).get(sessionId, sourceUserSeq) as { participation: string; outcome: string | null } | undefined;
    if (!existing) {
      db.prepare(
        `INSERT INTO turn_semantics_dispositions
          (session_id, source_user_seq, participation, outcome, created_at)
         VALUES (?, ?, ?, NULL, ?)`,
      ).run(sessionId, sourceUserSeq, participation, now);
      return;
    }
    if (existing.participation === 'unparticipated' && participation === 'participated') {
      db.prepare(
        `UPDATE turn_semantics_dispositions
            SET participation = ?
          WHERE session_id = ? AND source_user_seq = ?`,
      ).run(participation, sessionId, sourceUserSeq);
    }
  })();
  return readSemanticDisposition(sessionId, sourceUserSeq) ?? {
    participation,
    outcome: null,
  };
}

export function recordSemanticDispositionOutcome(
  sessionId: string,
  sourceUserSeq: number,
  outcome: SemanticDispositionOutcomeV1,
): void {
  const existing = readSemanticDisposition(sessionId, sourceUserSeq);
  if (!existing) {
    recordSemanticParticipation(
      sessionId,
      sourceUserSeq,
      outcome === 'unavailable' ? 'unparticipated' : 'participated',
    );
  }
  openEventLog().prepare(
    `UPDATE turn_semantics_dispositions
        SET outcome = ?
      WHERE session_id = ? AND source_user_seq = ?`,
  ).run(outcome, sessionId, sourceUserSeq);
}

export function readSemanticDisposition(
  sessionId: string,
  sourceUserSeq: number,
): SemanticDispositionV1 | null {
  try {
    const row = openEventLog().prepare(
      `SELECT participation, outcome FROM turn_semantics_dispositions
        WHERE session_id = ? AND source_user_seq = ?`,
    ).get(sessionId, sourceUserSeq) as { participation: string; outcome: string | null } | undefined;
    if (!row) return null;
    if (row.participation !== 'participated' && row.participation !== 'unparticipated') return null;
    const outcome = row.outcome === 'admitted' || row.outcome === 'blocked' || row.outcome === 'unavailable'
      ? row.outcome
      : null;
    return { participation: row.participation, outcome };
  } catch {
    return null;
  }
}

export function semanticPortParticipated(sessionId: string, sourceUserSeq: number): boolean {
  return readSemanticDisposition(sessionId, sourceUserSeq)?.participation === 'participated';
}
