import { approvalCardVoice } from './approval-card-voice.js';
import { openEventLog } from './eventlog.js';
import { publicPresentationText } from './public-presentation.js';
import { presentationEventFromCompletionData } from './turn-outcome.js';

/**
 * The words a person reads on an approval card (Needs you, Home, the phone).
 * The checker's question when it wrote one; else the question Clem paused on
 * for this card in her conversation, so a card speaks as she did in chat and
 * never as an operation id. Display only; the decision path reads the
 * approval itself.
 */

const ASK_MAX = 200;

/** The host's stand-in words for a turn that paused on a card ("Approval
 *  required for X. Review apr-… to continue."): the card's placeholder,
 *  never Clem's question. */
export function isHostApprovalStandIn(text: string, approvalId: string): boolean {
  return (text.startsWith('Approval required for ') && text.endsWith(`. Review ${approvalId} to continue.`))
    || (text.startsWith('Can I go ahead with ') && text.endsWith('? Say yes, or tell me what to change.'))
    || (/^\d+ approvals are waiting, starting with /.test(text)
      && text.endsWith(`(${approvalId}). Approve or reject each and I'll continue.`));
}

function bounded(text: string): string {
  if (text.length <= ASK_MAX) return text;
  const cut = text.slice(0, ASK_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > ASK_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Clem's words for the card, or null to leave it on its action line. */
export function approvalCardVoiceForDisplay(sessionId: string, approvalId: string): { ask: string; why?: string } | null {
  const checked = approvalCardVoice(sessionId, approvalId);
  if (checked) return checked;
  try {
    const rows = openEventLog().prepare(`
      SELECT data_json AS dataJson FROM events
       WHERE session_id = ? AND type = 'conversation_completed'
         AND json_extract(data_json, '$.presentation.approvalId') = ?
       ORDER BY seq DESC LIMIT 1
    `).all(sessionId, approvalId) as Array<{ dataJson: string }>;
    const presentation = rows[0] ? presentationEventFromCompletionData(JSON.parse(rows[0].dataJson)) : null;
    if (!presentation || presentation.kind !== 'approval' || presentation.approvalId !== approvalId) return null;
    const text = publicPresentationText(presentation).trim();
    return text && !isHostApprovalStandIn(text, approvalId) ? { ask: bounded(text) } : null;
  } catch {
    return null;
  }
}
