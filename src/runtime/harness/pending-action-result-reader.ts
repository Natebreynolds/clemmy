/** Request-time adapter, deliberately separate from ubiquitous pure views. */
import * as approvalRegistry from './approval-registry.js';
import { getUserInputEventAtSequence, openEventLog, readValidatedTerminalEvent } from './eventlog.js';
import { loadAcceptedTaskAuthority } from './accepted-task-authority.js';
import { pendingActionPublicResult, pendingActionResultApprovalMatches, type PendingActionResultRecord, type PendingActionResultEvidence } from './pending-action-public-result.js';
import { readApprovedActionResultProjection } from './approved-action-result-projection.js';

function readExactEvidence(action: PendingActionResultRecord): PendingActionResultEvidence | null {
  if (!action.approvalId || !action.sessionId) return null;
  const approval = approvalRegistry.get(action.approvalId);
  if (!approval || !pendingActionResultApprovalMatches(action, approval)) return null;
  let sourceSeq = approval.presentation?.responseSourceUserSeq ?? null;
  if (!approval.presentation) {
    // At most two relevant coordinates; ambiguity never selects the latest B.
    const candidates = openEventLog().prepare(`SELECT seq FROM events
      WHERE session_id = ? AND type = 'user_input_received'
        AND json_valid(data_json)
        AND json_extract(data_json, '$.approvalId') = ?
        AND json_extract(data_json, '$.decision') = 'approve'
      LIMIT 2`).all(action.sessionId, action.approvalId) as Array<{ seq: number }>;
    if (candidates.length !== 1) return null;
    sourceSeq = candidates[0]!.seq;
  }
  if (!sourceSeq) return null;
  const source = getUserInputEventAtSequence(action.sessionId, sourceSeq);
  if (!source) return null;
  const authority = loadAcceptedTaskAuthority(action.sessionId, sourceSeq);
  if (authority.status !== 'ok' || !authority.authority.terminalEventId) return null;
  return { approval, source, terminal: readValidatedTerminalEvent(authority.authority.terminalEventId, action.sessionId, sourceSeq) };
}
export function readPendingActionPublicResult(action: PendingActionResultRecord) {
  let evidence: PendingActionResultEvidence | null = null;
  const result = pendingActionPublicResult(action, value => { evidence = readExactEvidence(value); return evidence; });
  if (!result || result.source !== 'terminal' || action.status !== 'executed' || !evidence) return result;
  // This exact GET only reads an already committed display projection. It
  // never enqueues, invokes a model, changes execution state or repairs history.
  const projection = readApprovedActionResultProjection(action, (evidence as PendingActionResultEvidence).terminal);
  if (!projection) return result;
  const { text, ...receipt } = projection;
  return { ...result, source: 'authored_projection' as const, text, projection: receipt };
}
