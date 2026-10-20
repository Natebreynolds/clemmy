/**
 * Execute-button truth (U3). The chat pending-action card fires the exact
 * stored server-side call through these endpoints and renders state from the
 * durable record — never a client-side "Submitted" latch that can outrun what
 * actually happened.
 */
import { apiGet, apiPost } from './api';
import { durablePhase, durablePresentation, recordMatchesCard, withPublicResult, queuedSnapshotMatchesCard,
  queuedPendingActionProgress, pendingActionTerminalResultUpgrade } from '@clem/chat-engine';
import type { PendingActionExecutionPresentation, PendingActionStatusSnapshot, QueuedPendingActionBinding } from '@clem/chat-engine';
export { pendingActionPresentationCopy, pendingActionRecordPresentation, pendingActionTerminalResultUpgrade,
  queuedPendingActionProgress } from '@clem/chat-engine';
export type { PendingActionExecutionPhase, PendingActionExecutionPresentation } from '@clem/chat-engine';

import type { PendingActionApprovalView, PendingActionPublicResult } from './types';

export interface PendingActionExecuteResult {
  ok: boolean;
  /** Durable executor outcome: the send fired, was refused/failed, is queued
   *  behind a live run in the chat (it runs once that run ends), or was
   *  skipped because the record wasn't in an executable (approved) state. */
  status: 'executed' | 'failed' | 'queued' | 'skipped';
  resultSummary: string;
  /** Grant-at-card: present only when alwaysAllow was requested — true means a
   *  narrow send-trust grant (these recipients, this toolkit) was stored. */
  trustGranted?: boolean;
  trustGrantId?: string | null;
  record: { id: string; status: string; resultSummary: string | null; payloadHash: string;
    approvalId?: string | null; updatedAt?: string; publicResult?: PendingActionPublicResult } | null;
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
  apiGet<{
    ok: boolean;
    status: string;
    resultSummary: string | null;
    pendingAction?: PendingActionApprovalView;
  }>(
    `/api/console/pending-actions/${encodeURIComponent(id)}`,
  );

/** Standing trust is recipient-scoped send authority. Never offer that control
 * on a generic external write/deploy merely because it also uses the durable
 * pending-action substrate. */
export function canOfferStandingSendTrust(
  action: Pick<PendingActionApprovalView, 'kind'> | null | undefined,
): boolean {
  return action?.kind === 'external_send';
}

export interface PendingActionReconciliationOptions {
  /** One durable read per entry. Kept injectable so tests are instant and the
   *  production wait remains deliberately bounded. */
  pollDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
  card?: QueuedPendingActionBinding;
}

const DEFAULT_POLL_DELAYS_MS = [0, 200, 600, 1_400, 2_800] as const;
const UNCERTAIN_EXECUTION_NOTE =
  'The execution outcome is not confirmed yet. No second dispatch was attempted. '
  + 'Check the durable action before continuing; do not retry it.';

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
      if (options.card && !queuedSnapshotMatchesCard(snapshot, options.card)) continue;
      return withPublicResult(durablePresentation(phase, snapshot.resultSummary), snapshot.pendingAction);
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
  if (options.card && (!recordMatchesCard(result.record, options.card)
    || ((result.status === 'executed' || result.status === 'failed') && result.record?.status !== result.status))) return uncertainPresentation();
  if (result.status === 'executed' || result.status === 'failed') {
    const note = (result.record?.resultSummary || result.resultSummary || '').trim();
    return withPublicResult(durablePresentation(result.status, note), result.record);
  }
  // The approval is recorded and its exact resume is waiting for the chat's
  // live run. Never fall through to a conversational "approve" turn here.
  if (result.status === 'queued') return durablePresentation('queued', result.resultSummary);

  const initialPhase = durablePhase(result.record?.status);
  if (!initialPhase) return { mode: 'conversational', phase: 'idle' };
  if (initialPhase !== 'running') {
    const terminalDecision = initialPhase === 'rejected'
      || initialPhase === 'expired'
      || initialPhase === 'cancelled';
    return withPublicResult(durablePresentation(
      initialPhase,
      result.record?.resultSummary || (terminalDecision ? null : result.resultSummary),
    ), result.record);
  }
  return waitForDurableTerminalStatus(refresh, options);
}

/** Observe only; this helper has no approval or dispatch path. Each read must
 * settle before scheduling the next, and terminal truth is fenced before the
 * React callback so cleanup timing cannot let an older read replace it. */
export function startQueuedPendingActionPolling(
  card: QueuedPendingActionBinding,
  refresh: () => Promise<PendingActionStatusSnapshot>,
  onProgress: (presentation: PendingActionExecutionPresentation) => void,
  options: { schedule?: (read: () => void, delayMs: number) => () => void } = {},
): () => void {
  const schedule = options.schedule ?? ((read, delayMs) => {
    const timer = setTimeout(read, delayMs);
    return () => clearTimeout(timer);
  });
  let stopped = false;
  let cancelNext: (() => void) | undefined;
  let revision = Date.parse(card.updatedAt);
  let running = false;
  let reading = false;
  let failures = 0;
  const stop = () => { stopped = true; cancelNext?.(); };
  const next = (delay: number) => { cancelNext = schedule(() => { cancelNext = undefined; void read(); }, delay); };
  const read = async () => {
    if (stopped || reading) return;
    reading = true;
    try {
      const snapshot = await refresh();
      if (stopped) return;
      const phase = durablePhase(snapshot.status);
      const nextRevision = Date.parse(snapshot.pendingAction?.updatedAt ?? '');
      if (!queuedSnapshotMatchesCard(snapshot, card) || nextRevision < revision
        || (running && phase !== 'running' && phase !== 'executed' && phase !== 'failed')
        || (!phase && !['queued', 'approval_requested', 'approved'].includes(snapshot.status))) {
        throw new Error('Unconfirmed action revision');
      }
      revision = nextRevision;
      failures = 0;
      const progress = queuedPendingActionProgress(snapshot, card);
      if (progress?.mode === 'durable') {
        running = progress.phase === 'running';
        if (!running) stop();
        onProgress(progress);
      }
    } catch {
      if (stopped) return;
      // An unavailable/mismatched read is not evidence of a failed dispatch.
      // Back off, then leave an explicit unconfirmed result without replay.
      failures += 1;
      if (failures >= 3) { stop(); onProgress(uncertainPresentation()); }
    } finally {
      reading = false;
    }
    if (!stopped) next(Math.min(2_500 * (2 ** failures), 10_000));
  };
  if (!card.id || !card.approvalId || !card.payloadHash || !Number.isFinite(revision)) {
    stop();
    onProgress(uncertainPresentation());
  } else next(2_500);
  return stop;
}

/** Record settlement can precede publication of its canonical answer. This
 * short, serialized GET-only pass fills that presentation gap; failed reads or
 * exhaustion leave the known settled outcome untouched. It cannot dispatch. */
export function startPendingActionTerminalResultHydration(
  settled: PendingActionExecutionPresentation,
  refresh: () => Promise<PendingActionStatusSnapshot>,
  onResult: (presentation: PendingActionExecutionPresentation) => void,
  options: { observedExecution?: boolean; schedule?: (read: () => void, delayMs: number) => () => void } = {},
): () => void {
  const result = settled.mode === 'durable' ? settled.publicResult : undefined;
  // Loading a history page must not launch a poll for every old settled card.
  // This flag only selects fresh presentation work; it proves no execution.
  if (options.observedExecution !== true || settled.mode !== 'durable' || (settled.phase !== 'executed' && settled.phase !== 'failed')
    || !result || result.source !== 'record' || result.status !== settled.phase
    || !result.pendingActionId || !result.approvalId || !result.payloadHash
    || !Number.isFinite(Date.parse(result.recordUpdatedAt))
    || !Object.hasOwn(settled, 'recordResultSummary')) return () => {};
  const card = { id: result.pendingActionId, approvalId: result.approvalId,
    payloadHash: result.payloadHash, updatedAt: result.recordUpdatedAt };
  const schedule = options.schedule ?? ((read, delayMs) => {
    const timer = setTimeout(read, delayMs);
    return () => clearTimeout(timer);
  });
  const delays = [250, 750, 1_500, 3_000, 6_000] as const;
  let stopped = false;
  let reading = false;
  let reads = 0;
  let cancelNext: (() => void) | undefined;
  const stop = () => { stopped = true; cancelNext?.(); };
  const next = () => {
    if (stopped || reads >= delays.length) return;
    let fired = false;
    cancelNext = schedule(() => {
      if (fired) return;
      fired = true;
      cancelNext = undefined;
      void read();
    }, delays[reads]);
  };
  const read = async () => {
    if (stopped || reading || reads >= delays.length) return;
    reading = true;
    reads += 1;
    try {
      const snapshot = await refresh();
      if (stopped) return;
      const incoming = queuedPendingActionProgress(snapshot, card);
      const enriched = incoming && pendingActionTerminalResultUpgrade(settled, incoming);
      if (enriched) { stop(); onResult(enriched); }
    } catch {
      // A missing answer is not a new execution verdict or permission to retry.
    } finally {
      reading = false;
    }
    next();
  };
  next();
  return stop;
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
