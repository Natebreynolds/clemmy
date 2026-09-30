/** Shared SQL-only identity proof for a host-validated approval continuation.
 * This maps evidence, never grants consent or execution ownership. */
import type Database from 'better-sqlite3';

export function readApprovalExecutionSource(db: Database.Database, input: { sessionId: string; sourceUserSeq: number }): number | null {
  const row = db.prepare("SELECT data_json FROM events WHERE session_id = ? AND seq = ? AND type = 'user_input_received'")
    .get(input.sessionId, input.sourceUserSeq) as { data_json: string } | undefined;
  if (!row) return null;
  const control = JSON.parse(row.data_json);
  if (typeof control.approvalId !== 'string' || !['approve', 'approve_with_edits', 'reject'].includes(String(control.decision))) return null;
  const candidates = db.prepare(`SELECT DISTINCT json_extract(data_json, '$.executionSourceUserSeq') AS source FROM events
    WHERE session_id = ? AND seq > ? AND type = 'run_resumed' AND role = 'system'
      AND json_extract(data_json, '$.reviewContinuationVersion') = 1
      AND json_extract(data_json, '$.deliverySourceUserSeq') = ?
      AND json_extract(data_json, '$.approvalId') = ? AND json_extract(data_json, '$.decision') = ? LIMIT 2`)
    .all(input.sessionId, input.sourceUserSeq, input.sourceUserSeq, control.approvalId, control.decision) as Array<{ source: unknown }>;
  const sources = new Set(candidates.map(candidate => candidate.source));
  if (sources.size !== 1) return null;
  const source = [...sources][0];
  if (!Number.isSafeInteger(source) || Number(source) <= 0 || Number(source) >= input.sourceUserSeq) return null;
  const card = db.prepare('SELECT status, resolution FROM pending_approvals WHERE session_id = ? AND approval_id = ?')
    .get(input.sessionId, control.approvalId) as { status: string; resolution: string } | undefined;
  if (card?.status !== 'resolved' || card.resolution !== (control.decision === 'reject' ? 'rejected' : 'approved')) return null;
  if (!db.prepare("SELECT 1 FROM events WHERE session_id = ? AND seq = ? AND type = 'user_input_received'")
    .get(input.sessionId, source)) return null;
  return Number(source);
}
