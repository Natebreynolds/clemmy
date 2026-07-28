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

export type PendingActionExecutionPhase =
  | 'running'
  | 'executed'
  | 'failed'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'uncertain';

export type PendingActionExecutionPresentation =
  | { mode: 'durable'; phase: PendingActionExecutionPhase; note?: string }
  | { mode: 'conversational'; phase: 'idle' };

type PendingActionStatusSnapshot = {
  ok: boolean;
  status: string;
  resultSummary: string | null;
};

export interface PendingActionReconciliationOptions {
  /** One durable read per entry. Kept injectable so tests are instant and the
   *  production wait remains deliberately bounded. */
  pollDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
}

const DEFAULT_POLL_DELAYS_MS = [0, 200, 600, 1_400, 2_800] as const;
const UNCERTAIN_EXECUTION_NOTE =
  'The execution outcome is not confirmed yet. No second dispatch was attempted. '
  + 'Check the durable action before continuing; do not retry it.';

function durablePhase(status: string | null | undefined): Exclude<PendingActionExecutionPhase, 'uncertain'> | null {
  if (status === 'executing') return 'running';
  if (
    status === 'executed'
    || status === 'failed'
    || status === 'rejected'
    || status === 'expired'
    || status === 'cancelled'
  ) return status;
  return null;
}

function durablePresentation(
  phase: Exclude<PendingActionExecutionPhase, 'running' | 'uncertain'>,
  note?: string | null,
): PendingActionExecutionPresentation {
  const clean = note?.trim();
  return {
    mode: 'durable',
    phase,
    ...(clean ? { note: clean } : {}),
  };
}

function uncertainPresentation(): PendingActionExecutionPresentation {
  return { mode: 'durable', phase: 'uncertain', note: UNCERTAIN_EXECUTION_NOTE };
}

async function waitForDurableTerminalStatus(
  refresh: () => Promise<PendingActionStatusSnapshot>,
  options: PendingActionReconciliationOptions,
): Promise<PendingActionExecutionPresentation> {
  const delays = options.pollDelaysMs ?? DEFAULT_POLL_DELAYS_MS;
  const wait = options.wait ?? ((delayMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, delayMs));
  }));

  for (const delayMs of delays) {
    await wait(delayMs);
    let snapshot: PendingActionStatusSnapshot;
    try {
      snapshot = await refresh();
    } catch {
      // A failed read cannot prove that an irreversible call did not happen.
      // Keep the bounded reconciliation loop going, then surface uncertainty.
      continue;
    }
    const phase = durablePhase(snapshot.status);
    if (phase && phase !== 'running') {
      return durablePresentation(phase, snapshot.resultSummary);
    }
    // `executing` and pre-claim states both remain unresolved after a lost
    // response. Never infer "safe to retry" from either one.
  }
  return uncertainPresentation();
}

/**
 * Convert an approve-execute response into card UI truth. A skipped response
 * can mean another caller already owns (or completed) the exact durable
 * action. Those states are authoritative and must never fall through to a
 * conversational "approve" turn, which could ask the model to execute twice.
 *
 * Bounded refreshes close the common race where this request observes
 * EXECUTING while the winning request records EXECUTED a moment later. If
 * terminal truth never arrives, the only safe presentation is uncertainty.
 */
export async function resolvePendingActionExecutionPresentation(
  result: PendingActionExecuteResult,
  refresh: () => Promise<PendingActionStatusSnapshot>,
  options: PendingActionReconciliationOptions = {},
): Promise<PendingActionExecutionPresentation> {
  if (result.status === 'executed' || result.status === 'failed') {
    const note = (result.resultSummary || result.record?.resultSummary || '').trim();
    return durablePresentation(result.status, note);
  }

  const initialPhase = durablePhase(result.record?.status);
  if (!initialPhase) return { mode: 'conversational', phase: 'idle' };
  if (initialPhase !== 'running') {
    const terminalDecision = initialPhase === 'rejected'
      || initialPhase === 'expired'
      || initialPhase === 'cancelled';
    return durablePresentation(
      initialPhase,
      result.record?.resultSummary || (terminalDecision ? null : result.resultSummary),
    );
  }
  return waitForDurableTerminalStatus(refresh, options);
}

/**
 * A POST transport error is not an execution verdict: the daemon/provider may
 * have completed after the response path was lost. Reconcile only from durable
 * GET truth, bounded in time. If truth stays unavailable, return an explicit
 * do-not-retry uncertainty instead of the dangerous "didn't send" fiction.
 */
export function reconcilePendingActionExecutionFailure(
  refresh: () => Promise<PendingActionStatusSnapshot>,
  options: PendingActionReconciliationOptions = {},
): Promise<PendingActionExecutionPresentation> {
  return waitForDurableTerminalStatus(refresh, options);
}
