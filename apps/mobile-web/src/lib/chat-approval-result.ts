import {
  mergeApprovalResultRecord,
  mergeApprovalResultBinding,
  sameApprovalResultRelation,
  normalizeApprovalResultResponse,
  type PendingActionResultLookup,
  type PendingActionResultRecord,
} from '@clem/chat-engine';

export interface MobileApprovalResultState {
  binding: PendingActionResultLookup | null;
  record?: PendingActionResultRecord;
  loading: boolean;
  error: string | null;
}

type ReadResult = (binding: PendingActionResultLookup, signal: AbortSignal) => Promise<unknown>;
const REFRESH_PROBLEM = 'Couldn’t refresh this result. Try again.';
const REFRESH_TIMEOUT = 'This result is taking too long to load. Try again.';
const READ_DEADLINE_MS = 15_000;

/** One visible card owns this reader. Reading is explicit: mounting history
 * never starts requests, and a discovered old relation stays pinned. */
export class MobileApprovalResultReader {
  private state: MobileApprovalResultState;
  private listeners = new Set<(state: MobileApprovalResultState) => void>();
  private request: AbortController | null = null;
  private active = true;

  constructor(binding: PendingActionResultLookup | null, record: PendingActionResultRecord | undefined, private readonly read: ReadResult) {
    this.state = { binding, ...(record ? { record } : {}), loading: false, error: null };
  }

  snapshot(): MobileApprovalResultState { return this.state; }

  subscribe(listener: (state: MobileApprovalResultState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }

  /** New engine evidence can enrich this same revision while a read is idle. */
  reconcile(record: PendingActionResultRecord | undefined, binding?: PendingActionResultLookup | null): void {
    if (!this.active) return;
    if (binding && this.state.binding && !sameApprovalResultRelation(this.state.binding, binding)) return;
    const merged = record ? mergeApprovalResultRecord(this.state.record, record) : this.state.record;
    const nextBinding = mergeApprovalResultBinding(this.state.binding, binding ?? this.state.binding, merged ?? this.state.record);
    const revised = nextBinding?.recordUpdatedAt !== this.state.binding?.recordUpdatedAt;
    if (revised) { this.request?.abort(); this.request = null; }
    if (merged === this.state.record && !revised) return;
    this.publish({ ...this.state, ...(merged ? { record: merged } : {}), binding: nextBinding,
      ...(revised ? { loading: false, error: null } : {}) });
  }

  async refresh(): Promise<void> {
    if (!this.active || this.state.loading || !this.state.binding) return;
    const expected = this.state.binding;
    const request = new AbortController();
    this.request = request;
    this.publish({ ...this.state, loading: true, error: null });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortRead: (() => void) | undefined;
    // Racing the deadline also releases the UI when a transport ignores its
    // AbortSignal. Its eventual answer still belongs to this request token.
    const deadline = new Promise<never>((_resolve, reject) => {
      abortRead = () => { reject(new Error('Result read cancelled')); };
      request.signal.addEventListener('abort', abortRead, { once: true });
      timer = setTimeout(() => { timedOut = true; request.abort(); }, READ_DEADLINE_MS);
    });
    try {
      const value = await Promise.race([this.read(expected, request.signal), deadline]);
      if (!this.active || this.request !== request || request.signal.aborted) return;
      const admitted = normalizeApprovalResultResponse(value, expected);
      const record = admitted && mergeApprovalResultRecord(this.state.record, admitted.record);
      if (!admitted || !record) {
        this.publish({ ...this.state, loading: false, error: REFRESH_PROBLEM });
        return;
      }
      this.publish({ binding: admitted.binding, record, loading: false, error: null });
    } catch {
      if (this.active && this.request === request && (timedOut || !request.signal.aborted)) {
        this.publish({ ...this.state, loading: false, error: timedOut ? REFRESH_TIMEOUT : REFRESH_PROBLEM });
      }
    } finally {
      clearTimeout(timer);
      if (abortRead) request.signal.removeEventListener('abort', abortRead);
      if (this.request === request) this.request = null;
    }
  }

  dispose(): void {
    this.active = false;
    this.request?.abort();
    this.request = null;
    this.listeners.clear();
  }

  private publish(state: MobileApprovalResultState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}
