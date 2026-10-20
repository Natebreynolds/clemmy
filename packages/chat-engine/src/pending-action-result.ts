/** Read-only card result evidence. These projections grant no execution authority. */
export interface PendingActionPublicResult {
  version: 1; pendingActionId: string; approvalId: string | null; payloadHash: string;
  recordUpdatedAt: string;
  status: 'executed' | 'failed' | 'executing' | 'rejected' | 'expired' | 'cancelled';
  source: 'record' | 'terminal'; text: string;
  terminal?: { eventId: string; sourceUserSeq: number };
}
export interface PendingActionResultRecord {
  id: string; approvalId: string | null; payloadHash: string; updatedAt: string;
  status: string; resultSummary: string | null; publicResult?: PendingActionPublicResult;
}
export interface PendingActionResultLookup {
  sessionId: string; approvalId: string; pendingActionId?: string;
  payloadHash?: string; recordUpdatedAt?: string;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\s\u0000-\u001f\u007f]/.test(value);
}
function revision(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}
export function normalizePendingActionPublicResult(value: unknown, record: {
  id: string; approvalId?: string | null; payloadHash: string; updatedAt?: string; status: string;
}): PendingActionPublicResult | null {
  const r = object(value);
  if (!identifier(record.id) || !(record.approvalId === null || identifier(record.approvalId))
    || !identifier(record.payloadHash) || !revision(record.updatedAt) || !r || r.version !== 1 || !['executed','failed','executing','rejected','expired','cancelled'].includes(String(r.status))
    || r.pendingActionId !== record.id || r.approvalId !== record.approvalId || r.payloadHash !== record.payloadHash
    || r.recordUpdatedAt !== record.updatedAt || r.status !== record.status
    || typeof r.text !== 'string' || !r.text.trim() || r.text.length > 12_000
    || (r.source !== 'record' && r.source !== 'terminal')) return null;
  const t = object(r.terminal);
  if (r.source === 'terminal' && (!t || !identifier(t.eventId) || !Number.isSafeInteger(t.sourceUserSeq) || Number(t.sourceUserSeq) < 1)) return null;
  return { version: 1, pendingActionId: record.id, approvalId: record.approvalId ?? null, payloadHash: record.payloadHash,
    recordUpdatedAt: record.updatedAt!, status: r.status as PendingActionPublicResult['status'], source: r.source, text: r.text,
    ...(r.source === 'terminal' ? { terminal: { eventId: t!.eventId as string, sourceUserSeq: Number(t!.sourceUserSeq) } } : {}) };
}
export function normalizePendingActionResultRecord(value: unknown): PendingActionResultRecord | null {
  const r = object(value);
  if (!r || !identifier(r.id) || !(r.approvalId === null || identifier(r.approvalId)) || !identifier(r.payloadHash)
    || !revision(r.updatedAt) || typeof r.status !== 'string' || !['queued','approval_requested','approved','executing','executed','failed','rejected','expired','cancelled'].includes(r.status)
    || !(r.resultSummary === null || (typeof r.resultSummary === 'string' && r.resultSummary.length <= 16_000))) return null;
  const record: PendingActionResultRecord = { id: r.id, approvalId: r.approvalId as string | null, payloadHash: r.payloadHash,
    updatedAt: r.updatedAt, status: r.status, resultSummary: r.resultSummary as string | null };
  const result = normalizePendingActionPublicResult(r.publicResult, record);
  return { ...record, ...(result ? { publicResult: result } : {}) };
}
export function approvalResultLookupKey(binding: PendingActionResultLookup): string {
  return JSON.stringify([binding.sessionId,binding.approvalId,binding.pendingActionId ?? null,binding.payloadHash ?? null,binding.recordUpdatedAt ?? null]);
}
/** Revision is mutable evidence, never a new card identity. Missing old fields
 * may be filled once, but an established relation is never silently replaced. */
export function sameApprovalResultRelation(a: PendingActionResultLookup | null, b: PendingActionResultLookup | null): boolean {
  return !!a && !!b && a.sessionId === b.sessionId && a.approvalId === b.approvalId
    && !(a.pendingActionId && b.pendingActionId && a.pendingActionId !== b.pendingActionId)
    && !(a.payloadHash && b.payloadHash && a.payloadHash !== b.payloadHash);
}
export function approvalResultRelationKey(binding: PendingActionResultLookup): string {
  return JSON.stringify([binding.sessionId,binding.approvalId,binding.pendingActionId ?? null,binding.payloadHash ?? null]);
}
export function mergeApprovalResultBinding(current: PendingActionResultLookup | null, incoming: PendingActionResultLookup | null,
  record?: PendingActionResultRecord): PendingActionResultLookup | null {
  if (!incoming) return current;
  if (!current || !sameApprovalResultRelation(current, incoming)) return incoming;
  const dates = [current.recordUpdatedAt, incoming.recordUpdatedAt, record?.updatedAt].filter(revision).sort((a,b) => Date.parse(b)-Date.parse(a));
  return { ...incoming, ...(current.pendingActionId ? { pendingActionId: current.pendingActionId } : {}),
    ...(current.payloadHash ? { payloadHash: current.payloadHash } : {}), ...(dates[0] ? { recordUpdatedAt: dates[0] } : {}) };
}
export function normalizeApprovalResultResponse(value: unknown, expected: PendingActionResultLookup): {
  binding: PendingActionResultLookup; record: PendingActionResultRecord;
} | null {
  if (!identifier(expected.sessionId) || !identifier(expected.approvalId)) return null;
  const r = object(value); const record = normalizePendingActionResultRecord(r?.pendingAction);
  if (!r || r.sessionId !== expected.sessionId || r.approvalId !== expected.approvalId || !record || record.approvalId !== expected.approvalId
    || (expected.pendingActionId !== undefined && record.id !== expected.pendingActionId)
    || (expected.payloadHash !== undefined && record.payloadHash !== expected.payloadHash)
    || (expected.recordUpdatedAt !== undefined && (!revision(expected.recordUpdatedAt) || Date.parse(record.updatedAt) < Date.parse(expected.recordUpdatedAt)))) return null;
  return { binding: { sessionId: expected.sessionId, approvalId: expected.approvalId, pendingActionId: record.id,
    payloadHash: record.payloadHash, recordUpdatedAt: record.updatedAt }, record };
}
/** Preserve a known settlement/answer when another read is older or lacks enrichment. */
export function mergeApprovalResultRecord(current: PendingActionResultRecord | undefined, incoming: PendingActionResultRecord): PendingActionResultRecord | null {
  if (!current) return incoming;
  if (current.id !== incoming.id || current.approvalId !== incoming.approvalId || current.payloadHash !== incoming.payloadHash
    || Date.parse(incoming.updatedAt) < Date.parse(current.updatedAt)) return null;
  const settled = ['executed','failed','rejected','expired','cancelled'].includes(current.status);
  if (settled && (current.status !== incoming.status || current.resultSummary !== incoming.resultSummary)) return null;
  if (current.status === 'executing' && !['executing','executed','failed'].includes(incoming.status)) return null;
  if (current.publicResult && !incoming.publicResult && current.updatedAt === incoming.updatedAt
    && current.status === incoming.status && current.resultSummary === incoming.resultSummary) return current;
  if (current.publicResult?.source === 'terminal' && incoming.publicResult?.source === 'terminal'
    && (current.updatedAt !== incoming.updatedAt || current.publicResult.text !== incoming.publicResult.text
      || current.publicResult.terminal?.eventId !== incoming.publicResult.terminal?.eventId
      || current.publicResult.terminal?.sourceUserSeq !== incoming.publicResult.terminal?.sourceUserSeq)) return null;
  if (current.publicResult?.source === 'terminal' && incoming.publicResult?.source !== 'terminal') {
    return current.updatedAt === incoming.updatedAt && current.status === incoming.status && current.resultSummary === incoming.resultSummary ? current : null;
  }
  if (settled && current.publicResult && incoming.publicResult?.source === 'terminal' && current.publicResult.source === 'record') {
    const before = pendingActionRecordPresentation(current); const after = pendingActionRecordPresentation(incoming);
    if (!before || !after || !pendingActionTerminalResultUpgrade(before, after)) return null;
  }
  return incoming;
}
/** A history container or event supplies the raw card owner; never the latest execution head. */
export function approvalResultFields(data: Record<string, unknown>, ownerSessionId: string | undefined): {
  ownerSessionId?: string; pendingActionId?: string; payloadHash?: string; recordUpdatedAt?: string; resultRecord?: PendingActionResultRecord;
} {
  if (!identifier(ownerSessionId) || !identifier(data.approvalId)) return {};
  const record = normalizePendingActionResultRecord(data.pendingAction);
  const raw = object(data.pendingAction);
  const directId = data.pendingActionId ?? raw?.id;
  if (record && record.approvalId === data.approvalId && (directId === undefined || directId === record.id)) return {
    ownerSessionId, pendingActionId: record.id, payloadHash: record.payloadHash, recordUpdatedAt: record.updatedAt, resultRecord: record,
  };
  if (record || (data.pendingActionId !== undefined && raw?.id !== undefined && data.pendingActionId !== raw.id)) return {};
  return { ownerSessionId, ...(identifier(directId) ? { pendingActionId: directId } : {}),
    ...(identifier(raw?.payloadHash) ? { payloadHash: raw.payloadHash } : {}),
    ...(revision(raw?.updatedAt) ? { recordUpdatedAt: raw.updatedAt } : {}) };
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

export type PendingActionStatusSnapshot = {
  ok: boolean;
  status: string;
  resultSummary: string | null;
  pendingAction?: Pick<PendingActionResultRecord,
    'id' | 'approvalId' | 'payloadHash' | 'updatedAt' | 'status' | 'resultSummary' | 'publicResult'>;
};

export type QueuedPendingActionBinding = Pick<PendingActionResultRecord, 'id' | 'approvalId' | 'payloadHash' | 'updatedAt'>;

type ResultRecord = { id: string; status: string; resultSummary: string | null; payloadHash: string; approvalId?: string | null; updatedAt?: string; publicResult?: PendingActionPublicResult };
export function recordMatchesCard(action: ResultRecord | null | undefined, card: QueuedPendingActionBinding): boolean {
  return !!action && !!card.id && !!card.approvalId && !!card.payloadHash
    && action.id === card.id && action.approvalId === card.approvalId && action.payloadHash === card.payloadHash
    && typeof action.updatedAt === 'string' && Number.isFinite(Date.parse(card.updatedAt))
    && Date.parse(action.updatedAt) >= Date.parse(card.updatedAt);
}
export function withPublicResult(presentation: PendingActionExecutionPresentation, action?: ResultRecord | null): PendingActionExecutionPresentation {
  const result = action ? normalizePendingActionPublicResult(action.publicResult, action) : null;
  if (presentation.mode !== 'durable' || !action || !result || durablePhase(action.status) !== presentation.phase) return presentation;
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

/** A closed question cannot erase a result already observed on that same
 * immutable card. Callers must bind both inputs to that card before use. */
export function retainPendingActionPresentation(known: PendingActionExecutionPresentation | undefined,
  incoming: PendingActionExecutionPresentation | null): PendingActionExecutionPresentation | null {
  if (known?.mode !== 'durable') return incoming;
  if (incoming?.mode !== 'durable') return known;
  const terminal = ['executed','failed','rejected','expired','cancelled'].includes(known.phase);
  if (terminal) {
    if (incoming.phase !== known.phase) return known;
    if (known.publicResult?.source === 'terminal') return known;
    return pendingActionTerminalResultUpgrade(known, incoming) ?? (known.publicResult ? known : incoming);
  }
  if (known.phase === 'uncertain' && !['executed','failed','rejected','expired','cancelled'].includes(incoming.phase)) return known;
  if (known.phase === 'running' && incoming.phase === 'queued') return known;
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
    queued: 'Approved. It is waiting for the current work to finish.',
    running: 'The approved action is running. No second dispatch was attempted.',
    uncertain: 'The outcome is not confirmed. Check the recorded result before trying again.',
  };
  if (fallback[presentation.phase]) {
    const note = presentation.publicResult?.text ?? fallback[presentation.phase];
    return { note, ...(raw && raw !== note ? { details: raw } : {}) };
  }
  return { ...(raw ? { note: raw } : {}) };
}

export function pendingActionRecordPresentation(action: PendingActionResultRecord): PendingActionExecutionPresentation | null {
  const phase = action.status === 'approved' ? 'queued' : durablePhase(action.status);
  return phase ? withPublicResult({ mode: 'durable', phase, ...(action.resultSummary?.trim() ? { note: action.resultSummary.trim() } : {}) }, action) : null;
}


export function durablePhase(status: string | null | undefined): Exclude<PendingActionExecutionPhase, 'uncertain'> | null {
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

export function durablePresentation(
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


export function queuedSnapshotMatchesCard(snapshot: PendingActionStatusSnapshot, card: QueuedPendingActionBinding): boolean {
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

