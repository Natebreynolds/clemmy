/**
 * Public recovery truth derived only from redeemed durable settlement data.
 *
 * Model-authored terminal prose is not authority for why a business call
 * stopped.  When the exact current accepted source most recently settled a
 * business call as `repair_arguments`, the user-facing pause has one
 * deterministic, value-opaque shape.  Missing or unreadable authority never
 * guesses and leaves the caller's presentation unchanged.
 */
import { openEventLog } from './eventlog.js';
import { redeemDurableLogicalCallSettlementForHost } from './logical-call-settlement-store.js';

export const REPAIR_ARGUMENTS_NEEDS_INPUT_TEXT =
  'The attempted request was rejected because its parameters need correction. I can revise the parameters and try again, or stop here. Which would you prefer?';

export interface RecoveryNeedsInputPresentationProjection {
  /** Public bytes to emit. */
  text: string;
  /** True only when redeemed durable recovery authority selected those bytes. */
  constrained: boolean;
}

interface LatestBusinessSettlementIdentityRow {
  accepted_task_id: string;
  logical_tool_call_id: string;
}

/**
 * Constrain one proposed needs-input presentation to the exact current-source
 * recovery authority.  The query selects only the newest business settlement;
 * a later success therefore supersedes an earlier repair directive, while a
 * non-business control/discovery refusal can never manufacture this prompt.
 */
export function constrainNeedsInputPresentationForRecovery(input: {
  sessionId: string;
  sourceUserSeq: number;
  proposedText: string;
}): RecoveryNeedsInputPresentationProjection {
  const unchanged = (): RecoveryNeedsInputPresentationProjection => ({
    text: input.proposedText,
    constrained: false,
  });
  if (
    !input.sessionId.trim()
    || !Number.isSafeInteger(input.sourceUserSeq)
    || input.sourceUserSeq <= 0
  ) return unchanged();

  try {
    const latest = openEventLog().prepare(`
      SELECT r.accepted_task_id, s.logical_tool_call_id
        FROM logical_call_settlements s
        JOIN accepted_task_resolutions r
          ON r.session_id = s.session_id
         AND r.source_user_seq = s.source_user_seq
        JOIN events e ON e.id = s.settlement_event_id
       WHERE s.session_id = ? AND s.source_user_seq = ?
         AND s.business_call = 1
         AND r.state != 'legacy_ambiguous'
       ORDER BY e.seq DESC
       LIMIT 1
    `).get(input.sessionId, input.sourceUserSeq) as
      | LatestBusinessSettlementIdentityRow
      | undefined;
    if (!latest) return unchanged();

    const redeemed = redeemDurableLogicalCallSettlementForHost({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: latest.accepted_task_id,
      logicalToolCallId: latest.logical_tool_call_id,
    });
    if (redeemed.status !== 'ok') return unchanged();
    const { settlement } = redeemed;
    if (
      settlement.recovery.businessCall
      && settlement.outcome.kind === 'invalid_arguments'
      && settlement.outcome.directive.action === 'repair_arguments'
    ) {
      return {
        text: REPAIR_ARGUMENTS_NEEDS_INPUT_TEXT,
        constrained: true,
      };
    }
  } catch {
    // Presentation authority is additive.  A missing/corrupt/unreadable
    // settlement must not invent recovery truth or prevent the ordinary
    // needs-input terminal from committing.
  }
  return unchanged();
}
