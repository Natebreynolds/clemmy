import {
  PUBLIC_MODEL_RUNTIME_UNAVAILABLE_TEXT,
  PUBLIC_RUN_FAILURE_TEXT,
} from '../runtime/harness/public-presentation.js';

export { PUBLIC_MODEL_RUNTIME_UNAVAILABLE_TEXT };

/**
 * Channel transports are public presentation surfaces. Provider exceptions,
 * local HTTP response bodies, stack messages, and tool errors belong in the
 * private log/inbox record and must never be interpolated into chat copy.
 *
 * Keep the generic fallback shared with the harness projector so a Discord or
 * Slack catch cannot accidentally become a second, less-safe error protocol.
 */
export const PUBLIC_CHANNEL_FAILURE_TEXT = PUBLIC_RUN_FAILURE_TEXT;

export function publicApprovalDecisionFailure(
  action: 'approve' | 'reject',
  approvalId: string,
): string {
  return [
    `I could not ${action} approval \`${approvalId}\`. The approval is still actionable.`,
    PUBLIC_CHANNEL_FAILURE_TEXT,
  ].join(' ');
}

export const PUBLIC_APPROVAL_EDIT_FAILURE_TEXT = [
  'I could not apply those edits. The approval is still actionable.',
  PUBLIC_CHANNEL_FAILURE_TEXT,
].join(' ');

export const PUBLIC_APPROVAL_CARD_REFRESH_FAILURE_TEXT =
  'The decision was recorded, but I could not refresh the approval card. Open Clementine → Inbox to review it.';
