/**
 * Execute-button truth (U3). The chat pending-action card fires the exact
 * stored server-side call through these endpoints and renders state from the
 * durable record — never a client-side "Submitted" latch that can outrun what
 * actually happened.
 */
import { apiGet, apiPost } from './api';
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

export type PendingActionExecutionPhase =
  | 'queued'
  | 'running'
  | 'executed'
  | 'failed'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'uncertain';

export type PendingActionExecutionPresentation =
  | { mode: 'durable'; phase: PendingActionExecutionPhase; note?: string; publicResult?: PendingActionPublicResult;
      /** Exact raw record evidence retained only for read-only result hydration. */
      recordResultSummary?: string | null }
  | { mode: 'conversational'; phase: 'idle' };

type PendingActionStatusSnapshot = {
  ok: boolean;
  status: string;
  resultSummary: string | null;
  pendingAction?: Pick<PendingActionApprovalView,
    'id' | 'approvalId' | 'payloadHash' | 'updatedAt' | 'status' | 'resultSummary' | 'publicResult'>;
};

type QueuedPendingActionBinding = Pick<PendingActionApprovalView, 'id' | 'approvalId' | 'payloadHash' | 'updatedAt'>;

export interface PendingActionReconciliationOptions {
  /** One durable read per entry. Kept injectable so tests are instant and the
   *  production wait remains deliberately bounded. */
  pollDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
  card?: QueuedPendingActionBinding;
}

type ResultRecord = NonNullable<PendingActionExecuteResult['record']>;
function recordMatchesCard(action: ResultRecord | null | undefined, card: QueuedPendingActionBinding): boolean {
  return !!action && !!card.id && !!card.approvalId && !!card.payloadHash
    && action.id === card.id && action.approvalId === card.approvalId && action.payloadHash === card.payloadHash
    && typeof action.updatedAt === 'string' && Number.isFinite(Date.parse(card.updatedAt))
    && Date.parse(action.updatedAt) >= Date.parse(card.updatedAt);
}
function withPublicResult(presentation: PendingActionExecutionPresentation, action?: ResultRecord | null): PendingActionExecutionPresentation {
  const result = action?.publicResult;
  if (presentation.mode !== 'durable' || !action || !result || result.version !== 1
    || durablePhase(action.status) !== presentation.phase
    || result.pendingActionId !== action.id || result.approvalId !== action.approvalId
    || result.payloadHash !== action.payloadHash || result.recordUpdatedAt !== action.updatedAt || result.status !== action.status
    || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 12_000
    || (result.source !== 'record' && result.source !== 'terminal')
    || (result.source === 'terminal' && (typeof result.terminal?.eventId !== 'string' || !result.terminal.eventId.trim()
      || result.terminal.eventId.length > 256 || !Number.isSafeInteger(result.terminal.sourceUserSeq) || result.terminal.sourceUserSeq < 1))) return presentation;
  return { ...presentation, publicResult: result, recordResultSummary: action.resultSummary };
}

/** A later answer may enrich this settled record, never replace its execution
 * truth or another revision's evidence. Both projections passed withPublicResult. */
export function pendingActionTerminalResultUpgrade(
  current: PendingActionExecutionPresentation | undefined,
  incoming: PendingActionExecutionPresentation,
): PendingActionExecutionPresentation | null {
  if (current?.mode !== 'durable' || incoming.mode !== 'durable'
    || (current.phase !== 'executed' && current.phase !== 'failed') || current.phase !== incoming.phase
    || !Object.hasOwn(current, 'recordResultSummary') || !Object.hasOwn(incoming, 'recordResultSummary')
    || current.recordResultSummary !== incoming.recordResultSummary) return null;
  const before = current.publicResult;
  const after = incoming.publicResult;
  if (!before || before.source !== 'record' || !after || after.source !== 'terminal'
    || before.pendingActionId !== after.pendingActionId || before.approvalId !== after.approvalId
    || before.payloadHash !== after.payloadHash || before.recordUpdatedAt !== after.recordUpdatedAt
    || before.status !== after.status || after.status !== current.phase) return null;
  return incoming;
}

/** Raw evidence is always disclosure text. A missing legacy projection cannot
 * make a technical summary, provider prose or a later result the main answer. */
export function pendingActionPresentationCopy(presentation: PendingActionExecutionPresentation): { note?: string; details?: string } {
  if (presentation.mode !== 'durable') return {};
  const raw = presentation.note?.trim();
  const fallback: Partial<Record<PendingActionExecutionPhase, string>> = {
    executed: 'The approved action completed. Open execution details to see the recorded result.',
    failed: 'The action failed or may have completed only in part. Check what changed before trying again.',
    rejected: 'This action was rejected.', expired: 'This approval expired.', cancelled: 'This action was cancelled.',
  };
  if (fallback[presentation.phase]) {
    const note = presentation.publicResult?.text ?? fallback[presentation.phase];
    return { note, ...(raw && raw !== note ? { details: raw } : {}) };
  }
  return { ...(raw ? { note: raw } : {}) };
}

export function pendingActionRecordPresentation(action: PendingActionApprovalView): PendingActionExecutionPresentation | null {
  const phase = durablePhase(action.status);
  return phase && phase !== 'running' ? withPublicResult(durablePresentation(phase, action.resultSummary), action) : null;
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

function queuedSnapshotMatchesCard(snapshot: PendingActionStatusSnapshot, card: QueuedPendingActionBinding): boolean {
  const action = snapshot.pendingAction;
  return snapshot.ok === true && !!action && typeof action === 'object' && !Array.isArray(action)
    && !!card.id && !!card.approvalId && !!card.payloadHash
    && action.id === card.id && action.approvalId === card.approvalId && action.payloadHash === card.payloadHash
    && action.status === snapshot.status && action.resultSummary === snapshot.resultSummary
    && (snapshot.resultSummary === null || typeof snapshot.resultSummary === 'string')
    && typeof action.updatedAt === 'string' && typeof card.updatedAt === 'string'
    && Number.isFinite(Date.parse(card.updatedAt))
    && Date.parse(action.updatedAt) >= Date.parse(card.updatedAt);
}

/** Only this exact card's retained record may move its presentation forward.
 * updatedAt is the durable revision: progress can advance it, never rewind it. */
export function queuedPendingActionProgress(
  snapshot: PendingActionStatusSnapshot,
  card: QueuedPendingActionBinding,
): PendingActionExecutionPresentation | null {
  if (!queuedSnapshotMatchesCard(snapshot, card)) return null;
  const phase = durablePhase(snapshot.status);
  if (!phase) return null;
  return phase === 'running' ? { mode: 'durable', phase }
    : withPublicResult(durablePresentation(phase, snapshot.resultSummary), snapshot.pendingAction);
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
