import type {
  RunConversationResult,
  RunConversationStatus,
} from './loop.js';

export type RunConversationHold = NonNullable<RunConversationResult['hold']>;

/**
 * The provider-neutral control disposition returned by the harness loop.
 *
 * Keep this projection one-to-one with RunConversationStatus. Consumers still
 * own their surface-specific policy, but they can no longer accidentally let a
 * newly-added status fall through to an old success/default branch.
 */
export type RunConversationDisposition =
  | { kind: 'completed' }
  | { kind: 'dispatched' }
  | { kind: 'held'; hold: RunConversationHold; recoveredContract: boolean }
  | { kind: 'awaiting_user_input' }
  | { kind: 'awaiting_approval' }
  | { kind: 'killed' }
  | { kind: 'limit_exceeded' }
  | { kind: 'blocked' }
  | { kind: 'failed' };

const RECOVERY_OWNED_HOLD: RunConversationHold = {
  owner: 'host',
  wake: 'recovery',
  reason: 'recovery_pending',
};

export function runConversationDisposition(
  result: Pick<RunConversationResult, 'status' | 'hold'>,
): RunConversationDisposition {
  switch (result.status) {
    case 'completed':
      return { kind: 'completed' };
    case 'dispatched':
      return { kind: 'dispatched' };
    case 'held':
      // Historical/synthetic fixtures may omit the newer hold envelope. Such
      // a row still cannot become success: recovery owns it until the exact
      // accepted source has a durable terminal.
      return result.hold
        ? { kind: 'held', hold: result.hold, recoveredContract: false }
        : { kind: 'held', hold: RECOVERY_OWNED_HOLD, recoveredContract: true };
    case 'awaiting_user_input':
      return { kind: 'awaiting_user_input' };
    case 'awaiting_approval':
      return { kind: 'awaiting_approval' };
    case 'killed':
      return { kind: 'killed' };
    case 'limit_exceeded':
      return { kind: 'limit_exceeded' };
    case 'blocked':
      return { kind: 'blocked' };
    case 'failed':
      return { kind: 'failed' };
    default:
      return assertNeverRunConversationStatus(result.status);
  }
}

export function assertNeverRunConversationStatus(value: never): never {
  throw new Error(`Unhandled run conversation status: ${String(value)}`);
}
