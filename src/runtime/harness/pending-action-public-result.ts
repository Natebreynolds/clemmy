/** Display-only approval outcomes. Neither metadata nor public text grants
 * execution authority: durable action state remains the outcome's owner. */
import { createHash } from 'node:crypto';
import type * as approvalRegistry from './approval-registry.js';
import type { EventRow } from './eventlog.js';
import { presentationEventFromCompletionData } from './turn-outcome.js';
import type { PendingActionRecord } from './pending-actions.js';
import { normalizePendingActionResultBinding, type PendingActionResultBinding } from '../../shared/pending-action-result-binding.js';

export type PendingActionResultRecord = Pick<PendingActionRecord,
  'id' | 'approvalId' | 'sessionId' | 'payloadHash' | 'updatedAt' | 'status' | 'resultSummary'>;
type ResultStatus = 'executed' | 'failed' | 'executing' | 'rejected' | 'expired' | 'cancelled';
export interface PendingActionPublicResult {
  version: 1;
  pendingActionId: string;
  approvalId: string | null;
  payloadHash: string;
  recordUpdatedAt: string;
  status: ResultStatus;
  source: 'record' | 'terminal' | 'authored_projection';
  text: string;
  terminal?: { eventId: string; sourceUserSeq: number };
  projection?: { id: string; revision: 1; evidenceDigest: string; textDigest: string; publishedAt: string };
}
const STATUS_TEXT: Record<ResultStatus, string> = {
  executed: 'The approved action completed. Open execution details to see the recorded result.',
  failed: 'The action failed or may have completed only in part. Check what changed before trying again.',
  executing: 'Still waiting for the final result. The outcome is not confirmed; do not run the action again.',
  rejected: 'This action was rejected.',
  expired: 'This approval expired.',
  cancelled: 'This action was cancelled.',
};
function resultStatus(status: string): status is ResultStatus { return Object.hasOwn(STATUS_TEXT, status); }

/** Added only by the host settling the exact approval-response source. The
 * digest binds the original stored string, including all whitespace. */
export function pendingActionResultBinding(
  action: PendingActionResultRecord,
  source: Pick<EventRow, 'sessionId' | 'seq'>,
): PendingActionResultBinding | null {
  if (!action.id || !action.approvalId || action.sessionId !== source.sessionId || !source.sessionId
    || !Number.isSafeInteger(source.seq) || source.seq < 1 || !/^[a-f0-9]{16}$/.test(action.payloadHash)
    || !resultStatus(action.status) || typeof action.resultSummary !== 'string'
    || !Number.isFinite(Date.parse(action.updatedAt))) return null;
  return normalizePendingActionResultBinding({
    version: 1, sessionId: source.sessionId, sourceUserSeq: source.seq,
    pendingActionId: action.id, approvalId: action.approvalId, payloadHash: action.payloadHash,
    recordUpdatedAt: action.updatedAt, recordStatus: action.status,
    resultSummaryDigest: createHash('sha256').update(action.resultSummary).digest('hex'),
  });
}

type ApprovalResultRow = Pick<approvalRegistry.PendingApprovalRow,
  'approvalId' | 'sessionId' | 'args' | 'status' | 'resolution' | 'presentation'>;
export interface PendingActionResultEvidence { approval: ApprovalResultRow; source: EventRow; terminal: EventRow }

export function pendingActionResultApprovalMatches(action: PendingActionResultRecord, row: ApprovalResultRow): boolean {
  const args = row.args;
  const ids = [args?.pendingActionId, args?.pending_action_id].filter(value => value !== undefined);
  const snapshot = args?.pendingAction;
  return row.approvalId === action.approvalId && row.sessionId === action.sessionId
    && row.status === 'resolved' && row.resolution === 'approved'
    && ids.length > 0 && ids.every(value => value === action.id)
    && (snapshot === undefined || (!!snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
      && (snapshot as Record<string, unknown>).id === action.id
      && (snapshot as Record<string, unknown>).payloadHash === action.payloadHash));
}

/** Pure projection. API consumers supply the canonical reader separately so
 * ubiquitous approval views never import the runtime/authority module graph. */
export function pendingActionPublicResult(
  action: PendingActionResultRecord,
  readEvidence: (action: PendingActionResultRecord) => PendingActionResultEvidence | null = () => null,
): PendingActionPublicResult | null {
  if (!resultStatus(action.status)) return null;
  const fallback: PendingActionPublicResult = {
    version: 1, pendingActionId: action.id, approvalId: action.approvalId, payloadHash: action.payloadHash,
    recordUpdatedAt: action.updatedAt, status: action.status, source: 'record', text: STATUS_TEXT[action.status],
  };
  if (action.status !== 'executed' && action.status !== 'failed') return fallback;
  try {
    const evidence = readEvidence(action);
    if (!evidence || !pendingActionResultApprovalMatches(action, evidence.approval)) return fallback;
    const { source, terminal } = evidence;
    if (source.role !== 'user' || source.type !== 'user_input_received' || source.sessionId !== action.sessionId
      || source.data.approvalId !== action.approvalId || source.data.decision !== 'approve'
      || terminal.sessionId !== source.sessionId || terminal.turn !== source.turn || terminal.type !== 'conversation_completed') return fallback;
    const channel = evidence.approval.presentation;
    if (channel && (channel.responseSourceUserSeq !== source.seq || source.data.source !== 'channel_send_consent'
      || source.data.userId !== channel.responseUserId || source.data.conversationKey !== channel.conversationKey)) return fallback;
    if (!channel && (source.data.synthetic !== true || source.data.source !== 'approval_resume')) return fallback;
    const expected = pendingActionResultBinding(action, source);
    const binding = normalizePendingActionResultBinding(terminal.data.pendingActionResultBinding);
    if (!expected || !binding || Object.entries(expected).some(([key, value]) => (binding as unknown as Record<string, unknown>)[key] !== value)) return fallback;
    const presentation = presentationEventFromCompletionData(terminal.data);
    if (!presentation || presentation.identity.sessionId !== source.sessionId || presentation.identity.sourceUserSeq !== source.seq
      || presentation.identity.turn !== source.turn || !presentation.text.trim() || presentation.text.length > 12_000
      || (action.status === 'executed' ? presentation.status !== 'done' : !['failed', 'uncertain', 'blocked'].includes(presentation.status))) return fallback;
    return { ...fallback, source: 'terminal', text: presentation.text, terminal: { eventId: terminal.id, sourceUserSeq: source.seq } };
  } catch { return fallback; }
}
