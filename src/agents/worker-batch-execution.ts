import { createHash, randomUUID } from 'node:crypto';
import { listEvents, openEventLog } from '../runtime/harness/eventlog.js';
import {
  assertDispatchLeaseCurrent,
  revokeDispatchLease,
  type DispatchLeaseRef,
} from '../runtime/harness/dispatch-lease.js';

export type WorkerBatchItemState = 'settled' | 'failed' | 'in_flight' | 'pending';

export interface WorkerBatchItem<TInput> {
  item: string;
  packetKey: string;
  input: TInput;
}

export interface WorkerBatchItemResult<TOutput> {
  item: string;
  packetKey: string;
  state: WorkerBatchItemState;
  output?: TOutput;
  reason?: string;
}

export interface WorkerBatchRemainder {
  version: 1;
  batchKey: string;
  generationId: string;
  settled: string[];
  failed: string[];
  in_flight: string[];
  pending: string[];
}

export interface WorkerBatchExecutionResult<TOutput> {
  status: 'complete' | 'parked';
  batchKey: string;
  generationId: string;
  items: Array<WorkerBatchItemResult<TOutput>>;
  remainder: WorkerBatchRemainder;
  observedItemRequirementMs: number;
}

export interface WorkerBatchExecutionLease {
  batchKey: string;
  generationId: string;
  signal: AbortSignal;
  /** Durable cross-process owner for ordinary no-manifest batches. */
  dispatchLease?: DispatchLeaseRef;
  assertCurrent: () => void;
}

export class WorkerBatchGenerationCancelledError extends Error {
  constructor(
    message: string,
    readonly kind: 'deadline' | 'caller' | 'superseded',
    /** How many item bodies had been admitted when the generation was cancelled;
     * `null` when the throw site cannot know. Exactly 0 is the one case a caller
     * may settle as a proven pre-dispatch refusal. */
    readonly startedBodies: number | null = null,
  ) {
    super(message);
    this.name = 'WorkerBatchGenerationCancelledError';
  }
}

export class WorkerBatchIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerBatchIdentityError';
  }
}

export class WorkerBatchOwnershipConflictError extends Error {
  constructor(readonly batchKey: string) {
    super('the exact run_worker batch already has a live durable owner');
    this.name = 'WorkerBatchOwnershipConflictError';
  }
}

interface WorkerBatchRuntime {
  now: () => number;
  setTimer: (fn: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

const defaultRuntime: WorkerBatchRuntime = {
  now: () => Date.now(),
  setTimer: (fn, delayMs) => setTimeout(fn, delayMs),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

let runtimeOverride: WorkerBatchRuntime | null = null;

/** Test-only controllable clock. Production always uses the process clock. */
export function _setWorkerBatchRuntimeForTest(runtime: WorkerBatchRuntime | null): void {
  runtimeOverride = runtime;
}

interface ActiveGeneration {
  generationId: string;
  controller: AbortController;
  cancel: (kind: 'deadline' | 'caller' | 'superseded', reason?: unknown) => void;
  done: Promise<void>;
}

const activeGenerations = new Map<string, ActiveGeneration>();
const observedRequirements = new Map<string, number>();
const MAX_PARKED_REQUIREMENTS = 256;

function parkedRequirement(batchKey: string): number {
  const requirement = observedRequirements.get(batchKey) ?? 0;
  if (requirement > 0) {
    // Map insertion order is the bounded LRU. Active/complete/error generations
    // never remain here; only a typed parked generation is retained for resume.
    observedRequirements.delete(batchKey);
    observedRequirements.set(batchKey, requirement);
  }
  return requirement;
}

function retainParkedRequirement(batchKey: string, requirementMs: number): void {
  observedRequirements.delete(batchKey);
  if (requirementMs > 0) observedRequirements.set(batchKey, requirementMs);
  while (observedRequirements.size > MAX_PARKED_REQUIREMENTS) {
    const oldest = observedRequirements.keys().next().value as string | undefined;
    if (!oldest) break;
    observedRequirements.delete(oldest);
  }
}

/** Test-only bounded-state probe. */
export function _workerBatchObservationCountForTest(): number {
  return observedRequirements.size;
}

export function _resetWorkerBatchExecutionsForTest(): void {
  for (const active of activeGenerations.values()) {
    active.cancel(
      'superseded',
      new WorkerBatchGenerationCancelledError('worker batch test reset', 'superseded'),
    );
  }
  activeGenerations.clear();
  observedRequirements.clear();
  runtimeOverride = null;
}

function cleanIdentity(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 2_000) : '';
}

/**
 * Durable identity for one exact run_worker batch. Source identity deliberately
 * excludes physical call/generation ids so a restart can resume the same work,
 * while a later chat turn (different sourceUserSeq) remains a new operation.
 */
export function workerBatchKey(input: {
  sessionId: string;
  sourceUserSeq?: number;
  workflowRunId?: string;
  manifestScopeId?: string;
  logicalCallId?: string;
  packetKeys: readonly string[];
}): string {
  if (!cleanIdentity(input.sessionId)) {
    throw new WorkerBatchIdentityError('run_worker batch needs an exact session identity');
  }
  const source = Number.isSafeInteger(input.sourceUserSeq) && (input.sourceUserSeq ?? 0) > 0
    ? `user:${input.sourceUserSeq}`
    : cleanIdentity(input.workflowRunId)
      ? `workflow:${cleanIdentity(input.workflowRunId)}`
      : cleanIdentity(input.manifestScopeId)
        ? `manifest:${cleanIdentity(input.manifestScopeId)}`
        : cleanIdentity(input.logicalCallId)
          ? `call:${cleanIdentity(input.logicalCallId)}`
          : '';
  if (!source) {
    throw new WorkerBatchIdentityError(
      'run_worker batch needs an exact accepted source, workflow run, durable manifest, or logical call identity',
    );
  }
  return createHash('sha256')
    .update('run_worker_batch_v1\0')
    .update(cleanIdentity(input.sessionId))
    .update('\0')
    .update(source)
    .update('\0')
    .update(JSON.stringify(input.packetKeys))
    .digest('hex');
}

export interface WorkerBatchDurableOwnerInput {
  sessionId: string;
  parentLease: DispatchLeaseRef;
}

/**
 * Claim one existing-ledger row without replacing a live generation.
 *
 * `run_dispatch_leases.scope_id` is a durable primary key, so this INSERT/CAS
 * is process-independent. A concurrent daemon cannot steal an unreleased
 * batch. Elapsed time is deliberately not authority: a paused process or an
 * abort-ignoring provider remains the owner indefinitely. Only normal exact
 * release or daemon-boot reconciliation of a known-dead attempt may revoke it.
 */
export function claimWorkerBatchDurableOwnership(
  batchKey: string,
  input: WorkerBatchDurableOwnerInput,
): DispatchLeaseRef {
  if (!batchKey) throw new WorkerBatchIdentityError('worker batch ownership needs an exact key');
  if (!input.sessionId || input.parentLease.sessionId !== input.sessionId) {
    throw new WorkerBatchIdentityError('worker batch ownership must match its parent session');
  }
  assertDispatchLeaseCurrent(input.parentLease);
  const lease: DispatchLeaseRef = {
    sessionId: input.sessionId,
    scopeId: `worker-batch:v1:${batchKey}`,
    leaseId: randomUUID(),
    ...(input.parentLease.runAttemptId ? { runAttemptId: input.parentLease.runAttemptId } : {}),
    parentScopeId: input.parentLease.scopeId,
    parentLeaseId: input.parentLease.leaseId,
  };
  const activatedAt = new Date().toISOString();
  const claimed = openEventLog().prepare(`
    INSERT INTO run_dispatch_leases
      (
        scope_id, session_id, lease_id, run_attempt_id,
        parent_scope_id, parent_lease_id, activated_at, revoked_at
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(scope_id) DO UPDATE SET
      session_id = excluded.session_id,
      lease_id = excluded.lease_id,
      run_attempt_id = excluded.run_attempt_id,
      parent_scope_id = excluded.parent_scope_id,
      parent_lease_id = excluded.parent_lease_id,
      activated_at = excluded.activated_at,
      revoked_at = NULL,
      revocation_reason = NULL
    WHERE run_dispatch_leases.revoked_at IS NOT NULL
  `).run(
    lease.scopeId,
    lease.sessionId,
    lease.leaseId,
    lease.runAttemptId ?? null,
    lease.parentScopeId,
    lease.parentLeaseId,
    activatedAt,
  );
  if (claimed.changes !== 1) throw new WorkerBatchOwnershipConflictError(batchKey);
  try {
    assertDispatchLeaseCurrent(lease);
  } catch (error) {
    revokeDispatchLease(lease);
    throw error;
  }
  return lease;
}

export function releaseWorkerBatchDurableOwnership(lease: DispatchLeaseRef | undefined): void {
  revokeDispatchLease(lease);
}

/** Forward-only exact receipt used by interrupted ordinary (no-manifest) calls. */
export function completedWorkerBatchPacket(
  sessionId: string,
  batchKey: string,
  packetKey: string,
): boolean {
  if (!sessionId || !batchKey || !packetKey) return false;
  try {
    const events = listEvents(sessionId, { types: ['worker_result'] });
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const data = events[index]!.data as Record<string, unknown>;
      if (data.batchKey !== batchKey || data.packetKey !== packetKey) continue;
      return data.ok === true;
    }
  } catch {
    // Receipt reuse is an optimization. Unreadable authority fails toward a
    // fresh execution; downstream duplicate-action walls remain authoritative.
  }
  return false;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new WorkerBatchGenerationCancelledError('worker batch generation cancelled', 'caller');
}

export function isWorkerBatchGenerationCancellation(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  return error instanceof WorkerBatchGenerationCancelledError
    || Boolean(signal?.aborted && (error === signal.reason || error instanceof Error));
}

function remainderOf<TOutput>(
  batchKey: string,
  generationId: string,
  items: readonly WorkerBatchItemResult<TOutput>[],
): WorkerBatchRemainder {
  const named = (state: WorkerBatchItemState): string[] => items
    .filter((entry) => entry.state === state)
    .map((entry) => entry.item);
  return {
    version: 1,
    batchKey,
    generationId,
    settled: named('settled'),
    failed: named('failed'),
    in_flight: named('in_flight'),
    pending: named('pending'),
  };
}

export function renderWorkerBatchRemainder(remainder: WorkerBatchRemainder): string {
  return `RUN_WORKER_REMAINDER ${JSON.stringify(remainder)}`;
}

export async function runResumableWorkerBatch<
  TInput,
  TOutput,
  TItem extends WorkerBatchItem<TInput> = WorkerBatchItem<TInput>,
>(input: {
  batchKey: string;
  items: readonly TItem[];
  maxConcurrency: number;
  deadlineAt?: number;
  callerSignal?: AbortSignal;
  declaredItemRequirementMs?: number;
  /** Required by production ordinary/no-manifest batches. Manifest-backed
   * generations retain their existing durable attempt fence. */
  durableOwner?: WorkerBatchDurableOwnerInput;
  beforeGeneration?: (lease: WorkerBatchExecutionLease) => void | Promise<void>;
  execute: (item: TItem, lease: WorkerBatchExecutionLease) => Promise<TOutput>;
  failed: (output: TOutput) => boolean;
  failureReason?: (output: TOutput) => string;
}): Promise<WorkerBatchExecutionResult<TOutput>> {
  if (!input.batchKey) throw new Error('worker batch needs an exact batch key');
  if (input.items.length === 0) throw new Error('worker batch needs at least one item');
  const runtime = runtimeOverride ?? defaultRuntime;
  const predecessor = activeGenerations.get(input.batchKey);
  if (predecessor) {
    predecessor.cancel(
      'superseded',
      new WorkerBatchGenerationCancelledError(
        'worker batch generation superseded by exact re-entry',
        'superseded',
      ),
    );
    // A new generation is forbidden to cross any provider edge until every body
    // owned by the predecessor has acknowledged cancellation and settled.
    await predecessor.done;
  }

  const durableLease = input.durableOwner
    ? claimWorkerBatchDurableOwnership(input.batchKey, input.durableOwner)
    : undefined;
  const generationId = randomUUID();
  const controller = new AbortController();
  let stopKind: 'deadline' | 'caller' | 'superseded' | null = null;
  const abort = (kind: 'deadline' | 'caller' | 'superseded', reason?: unknown): void => {
    if (controller.signal.aborted) return;
    stopKind = kind;
    controller.abort(reason ?? new WorkerBatchGenerationCancelledError(
      kind === 'deadline'
        ? 'worker batch parked before its outer tool deadline'
        : kind === 'superseded'
          ? 'worker batch generation superseded'
          : 'worker batch caller cancelled',
      kind,
    ));
  };
  let settleDone!: () => void;
  const done = new Promise<void>((resolve) => { settleDone = resolve; });
  const active: ActiveGeneration = { generationId, controller, cancel: abort, done };
  activeGenerations.set(input.batchKey, active);
  const lease: WorkerBatchExecutionLease = {
    batchKey: input.batchKey,
    generationId,
    signal: controller.signal,
    ...(durableLease ? { dispatchLease: durableLease } : {}),
    assertCurrent: () => {
      const current = activeGenerations.get(input.batchKey);
      if (current !== active || current.generationId !== generationId || controller.signal.aborted) {
        throw abortReason(controller.signal);
      }
      assertDispatchLeaseCurrent(durableLease);
    },
  };

  const states: Array<WorkerBatchItemResult<TOutput>> = input.items.map((entry) => ({
    item: entry.item,
    packetKey: entry.packetKey,
    state: 'pending',
  }));
  const startedAt = runtime.now();
  const deadlineAt = Number.isFinite(input.deadlineAt) ? input.deadlineAt as number : undefined;
  const initialRemaining = deadlineAt === undefined ? Number.POSITIVE_INFINITY : Math.max(0, deadlineAt - startedAt);
  // Two seconds is enough for signals/iterator interrupts to drain while still
  // leaving the 42nd seven-second wave (294s) inside the unchanged 300s budget.
  // Tests scale the same ratio through a controllable clock.
  const safetyMarginMs = Number.isFinite(initialRemaining)
    ? Math.max(1, Math.min(2_000, Math.floor(initialRemaining * 0.01)))
    : 0;
  const parkAt = deadlineAt === undefined ? undefined : Math.max(startedAt, deadlineAt - safetyMarginMs);
  let timer: unknown;
  let retainedParkedObservation = false;
  let observedRequirementMs = Math.max(
    0,
    input.declaredItemRequirementMs ?? 0,
    parkedRequirement(input.batchKey),
  );
  const onCallerAbort = (): void => abort('caller', input.callerSignal?.reason);
  input.callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  if (input.callerSignal?.aborted) onCallerAbort();
  if (parkAt !== undefined) {
    timer = runtime.setTimer(() => abort('deadline'), Math.max(0, parkAt - runtime.now()));
  }

  let cursor = 0;
  // Remainder state may return to pending after cancellation. It cannot prove
  // that no body crossed its execution boundary: keep that fact monotonically.
  let startedBodies = 0;
  let admissionClosed = false;
  const nextIndex = (): number | null => {
    if (controller.signal.aborted) return null;
    if (cursor >= input.items.length || admissionClosed) return null;
    const now = runtime.now();
    if (parkAt !== undefined && now >= parkAt) {
      abort('deadline');
      return null;
    }
    if (
      deadlineAt !== undefined
      && observedRequirementMs > 0
      && deadlineAt - now < observedRequirementMs + safetyMarginMs
    ) {
      // Do not begin an item whose observed/declared body cannot fit. This is the
      // 252/253 cliff: at 294s the 253rd seven-second body remains pending. Stop
      // new admissions without aborting siblings from the already-admitted
      // 42nd wave; typed park still waits for those bodies to settle.
      stopKind = 'deadline';
      admissionClosed = true;
      return null;
    }
    const index = cursor;
    cursor += 1;
    return index;
  };

  try {
    lease.assertCurrent();
    await input.beforeGeneration?.(lease);
    const width = Math.max(1, Math.min(input.items.length, Math.floor(input.maxConcurrency) || 1));
    const runners = Array.from({ length: width }, async () => {
      while (true) {
        const index = nextIndex();
        if (index === null) return;
        const spec = input.items[index]!;
        const state = states[index]!;
        state.state = 'in_flight';
        const itemStartedAt = runtime.now();
        try {
          lease.assertCurrent();
          startedBodies += 1;
          const output = await input.execute(spec, lease);
          lease.assertCurrent();
          state.output = output;
          state.state = input.failed(output) ? 'failed' : 'settled';
          if (state.state === 'failed') state.reason = input.failureReason?.(output);
          if (state.state === 'settled') {
            observedRequirementMs = Math.max(observedRequirementMs, runtime.now() - itemStartedAt);
          }
        } catch (error) {
          if (controller.signal.aborted || isWorkerBatchGenerationCancellation(error, controller.signal)) {
            state.state = 'pending';
            state.output = undefined;
            state.reason = undefined;
            return;
          }
          state.state = 'failed';
          state.reason = error instanceof Error ? error.message : String(error);
        }
      }
    });
    // A typed return is forbidden until every started body settles. An
    // abort-ignoring provider therefore keeps this promise pending and lets the
    // unchanged outer deadline fail closed; it can never receive a false
    // "no orphan" receipt.
    await Promise.all(runners);
    if (stopKind === 'caller' || stopKind === 'superseded') throw abortReason(controller.signal);
    if (stopKind === 'deadline' && deadlineAt !== undefined && runtime.now() >= deadlineAt) {
      throw new WorkerBatchGenerationCancelledError(
        'worker batch body did not settle before the outer deadline; safe typed remainder withheld',
        'deadline',
        startedBodies,
      );
    }
    // A cross-process successor may take only an explicitly revoked claim.
    // Re-check the durable row after every body drains and before emitting
    // typed no-orphan state so a stale process can never publish a competing
    // remainder after daemon-boot reconciliation.
    assertDispatchLeaseCurrent(durableLease);
    for (const state of states) {
      if (state.state === 'in_flight') {
        throw new Error('worker batch invariant violated: typed return retained an in-flight body');
      }
    }
    const remainder = remainderOf(input.batchKey, generationId, states);
    const status = remainder.pending.length > 0 ? 'parked' : 'complete';
    if (status === 'parked') {
      retainParkedRequirement(input.batchKey, observedRequirementMs);
      retainedParkedObservation = true;
    }
    else observedRequirements.delete(input.batchKey);
    return {
      status,
      batchKey: input.batchKey,
      generationId,
      items: states,
      remainder,
      observedItemRequirementMs: observedRequirementMs,
    };
  } finally {
    if (timer !== undefined) runtime.clearTimer(timer);
    input.callerSignal?.removeEventListener('abort', onCallerAbort);
    if (activeGenerations.get(input.batchKey) === active) activeGenerations.delete(input.batchKey);
    // Only a successful typed park retains its bounded observation. Complete,
    // cancellation, supersession, setup failure, and deadline overrun evict it.
    if (!retainedParkedObservation) observedRequirements.delete(input.batchKey);
    releaseWorkerBatchDurableOwnership(durableLease);
    settleDone();
  }
}
