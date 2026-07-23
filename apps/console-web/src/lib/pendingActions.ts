/**
 * Execute-button truth (U3). The chat pending-action card fires the exact
 * stored server-side call through these endpoints and renders state from the
 * durable record — never a client-side "Submitted" latch that can outrun what
 * actually happened.
 */
import { apiGet, apiPost } from './api';

export interface PendingActionExecuteResult {
  ok: boolean;
  /** Durable executor outcome: the send fired, was refused/failed, or was
   *  skipped because the record wasn't in an executable (approved) state. */
  status: 'executed' | 'failed' | 'skipped';
  resultSummary: string;
  /** Grant-at-card: present only when alwaysAllow was requested — true means a
   *  narrow send-trust grant (these recipients, this toolkit) was stored. */
  trustGranted?: boolean;
  trustGrantId?: string | null;
  record: { id: string; status: string; resultSummary: string | null; payloadHash: string } | null;
}

/** Resolve the human card (if an approvalId is known) and fire the exact stored
 *  call server-side, returning the real outcome. `alwaysAllow` opts into a
 *  narrow standing send-trust grant derived from this very action. */
export const approveExecutePendingAction = (id: string, approvalId?: string | null, alwaysAllow?: boolean) =>
  apiPost<PendingActionExecuteResult>(
    `/api/console/pending-actions/${encodeURIComponent(id)}/approve-execute`,
    { ...(approvalId ? { approvalId } : {}), ...(alwaysAllow ? { alwaysAllow: true } : {}) },
  );

/** The durable record's current truth, for refreshing a card after execution. */
export const getPendingActionStatus = (id: string) =>
  apiGet<{ ok: boolean; status: string; resultSummary: string | null }>(
    `/api/console/pending-actions/${encodeURIComponent(id)}`,
  );
