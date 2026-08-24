import type { RunConversationResult } from '../runtime/harness/loop.js';
import type { RunStoppedReason } from '../types.js';
import { runConversationDisposition } from '../runtime/harness/run-conversation-disposition.js';

/** Distinct from a terminal failure: another host/recovery owner is active. */
export const HARNESS_HELD_EXIT_CODE = 3;

export function harnessRunExitCode(
  result: Pick<RunConversationResult, 'status' | 'hold'>,
): number {
  const disposition = runConversationDisposition(result);
  switch (disposition.kind) {
    case 'completed':
    case 'dispatched':
      return 0;
    case 'blocked':
    case 'failed':
      return 1;
    case 'held':
      return HARNESS_HELD_EXIT_CODE;
    case 'awaiting_user_input':
    case 'awaiting_approval':
    case 'killed':
    case 'limit_exceeded':
      // Preserve the pre-existing CLI contract for these user/control/budget
      // boundaries. Only blocked and held were previously laundered as 0.
      return 0;
  }
}

/** Project the shared chat bridge's public stop reason onto the harness CLI's
 * existing status vocabulary. The CLI now exercises the same accepted-source
 * bridge as every other fresh chat surface instead of owning a private loop. */
export function harnessBridgeStatus(reason: RunStoppedReason | undefined): RunConversationResult['status'] {
  switch (reason) {
    case undefined:
    case 'success':
      return 'completed';
    case 'pending-approval':
      return 'awaiting_approval';
    case 'awaiting-input':
      return 'awaiting_user_input';
    case 'max-turns-with-grace':
    case 'token-budget':
      return 'limit_exceeded';
    case 'cancelled':
      return 'killed';
    case 'in-progress':
      return 'held';
    case 'blocked':
    case 'unverified':
      return 'blocked';
    case 'error':
      return 'failed';
  }
}
