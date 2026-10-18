/** Timing arithmetic only. A ready plan is never authority to invoke a tool. */
export const READ_CONTINUATION_TIMER_MAX_MS = 2_147_483_647;

export interface ReadContinuationWakeInput {
  /** The caller's immutable retained start/settlement time, never resume time. */
  readonly anchorAtMs: number;
  readonly delayMs: number;
  readonly nowMs: number;
  readonly deadlineAtMs?: number;
}

export type ReadContinuationWakePlan =
  | { readonly status: 'ready'; readonly notBeforeAtMs: number }
  | { readonly status: 'waiting'; readonly notBeforeAtMs: number; readonly remainingMs: number }
  | { readonly status: 'expired'; readonly deadlineAtMs: number }
  | { readonly status: 'invalid'; readonly reason: 'anchor_invalid' | 'delay_invalid' | 'now_invalid' | 'deadline_invalid' | 'due_overflow' };

function safeNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function planReadContinuationWake(input: ReadContinuationWakeInput): ReadContinuationWakePlan {
  if (!safeNonnegativeInteger(input.anchorAtMs)) return { status: 'invalid', reason: 'anchor_invalid' };
  if (!safeNonnegativeInteger(input.delayMs) || input.delayMs > READ_CONTINUATION_TIMER_MAX_MS) {
    return { status: 'invalid', reason: 'delay_invalid' };
  }
  if (!safeNonnegativeInteger(input.nowMs)) return { status: 'invalid', reason: 'now_invalid' };
  if (input.deadlineAtMs !== undefined && !safeNonnegativeInteger(input.deadlineAtMs)) {
    return { status: 'invalid', reason: 'deadline_invalid' };
  }
  const notBeforeAtMs = input.anchorAtMs + input.delayMs;
  if (!Number.isSafeInteger(notBeforeAtMs)) return { status: 'invalid', reason: 'due_overflow' };
  if (input.deadlineAtMs !== undefined
    && (input.nowMs >= input.deadlineAtMs || notBeforeAtMs >= input.deadlineAtMs)) {
    return { status: 'expired', deadlineAtMs: input.deadlineAtMs };
  }
  return input.nowMs >= notBeforeAtMs
    ? { status: 'ready', notBeforeAtMs }
    : { status: 'waiting', notBeforeAtMs, remainingMs: notBeforeAtMs - input.nowMs };
}
