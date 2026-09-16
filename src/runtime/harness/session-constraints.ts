/**
 * Session constraints: things the owner asked Clem to remember EARLIER IN THIS
 * CONVERSATION, carried verbatim into every later request of the same
 * conversation.
 *
 * A mid-run "remember subject: X" arrives as a steer note bound to the source
 * that was running; the next accepted source is a new turn with a new context
 * packet, and nothing re-projected the instruction. Durable memory is not the
 * answer either: an explicit remember is stored at an unpinned kind and must
 * win ordinary recall to reappear. This module reads what the owner said in
 * this conversation and hands it back as bounded context.
 *
 * Contract: the harness never interprets an instruction. Detection is the one
 * shared explicit-memory gate (auto-capture); the body is the whole row
 * verbatim plus the row said just before it, so "remember this list" carries
 * the list and the model resolves the referent. Bounds drop whole items,
 * never clip one. The rendered frame states that the block grants no
 * authority for any external effect. Advisory, best-effort, never throws.
 */
import { getSession, listEvents, type EventRow } from './eventlog.js';
import { isLiveApprovalAcknowledgement } from './accepted-source-kind.js';
import { sameConversationAncestorSessionIds } from './accepted-source-session-branch.js';
import { isHarnessInjectedInput } from './objective-judge.js';
import { explicitMemoryInstructionFor } from '../../memory/auto-capture.js';

export type SessionConstraintKind = 'user_input_received' | 'user_steer_note';

export interface SessionConstraint {
  sessionId: string;
  seq: number;
  saidAt: string;
  kind: SessionConstraintKind;
  /** The owner's whole message, verbatim. Empty when the item was omitted. */
  text: string;
  /** The owner's immediately preceding message in the same session, verbatim. */
  saidBefore: string | null;
  /** Set when the item exceeded the per-item budget: the block carries a
   *  marker with this size instead of a clipped body. */
  omittedBytes: number | null;
}

export const MAX_ITEMS = 12;
export const MAX_ITEM_BYTES = 16 * 1024;
export const MAX_TOTAL_BYTES = 48 * 1024;

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function ownerText(row: EventRow): string | null {
  if (row.role !== 'user') return null;
  if (row.type === 'user_input_received') {
    if (row.data.synthetic === true || isLiveApprovalAcknowledgement(row)) return null;
  } else if (row.type !== 'user_steer_note') {
    return null;
  }
  const text = typeof row.data.text === 'string' ? row.data.text : '';
  if (!text.trim() || isHarnessInjectedInput(text)) return null;
  return text;
}

/** Oldest first: the conversation's ancestor sessions, then the current one. */
function conversationSessionIds(sessionId: string): string[] {
  const session = getSession(sessionId);
  if (!session) return [];
  const ancestors = sameConversationAncestorSessionIds({
    sessionId,
    principalId: session.userId || session.id,
  });
  return [...ancestors.reverse(), sessionId];
}

function boundItem(item: SessionConstraint): SessionConstraint {
  const size = bytes(item.text) + bytes(item.saidBefore ?? '');
  if (size <= MAX_ITEM_BYTES) return item;
  return { ...item, text: '', saidBefore: null, omittedBytes: size };
}

export function sessionConstraintsForSession(sessionId: string): SessionConstraint[] {
  try {
    const items: SessionConstraint[] = [];
    for (const id of conversationSessionIds(sessionId)) {
      let previous: string | null = null;
      const rows = listEvents(id, { types: ['user_input_received', 'user_steer_note'] });
      for (const row of rows) {
        const text = ownerText(row);
        if (text === null) continue;
        if (explicitMemoryInstructionFor(text)) {
          items.push(boundItem({
            sessionId: id,
            seq: row.seq,
            saidAt: row.createdAt,
            kind: row.type as SessionConstraintKind,
            text,
            saidBefore: previous,
            omittedBytes: null,
          }));
        }
        previous = text;
      }
    }
    // Newest items are kept; whole items fall off the oldest end.
    const kept = items.slice(-MAX_ITEMS);
    let total = 0;
    let start = kept.length;
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      const size = bytes(renderItem(kept[i]!));
      if (total + size > MAX_TOTAL_BYTES) break;
      total += size;
      start = i;
    }
    return kept.slice(start);
  } catch {
    return [];
  }
}

function renderItem(item: SessionConstraint): string {
  if (item.omittedBytes !== null) {
    return `- [omitted: an instruction of ${item.omittedBytes} bytes from ${item.saidAt}]`;
  }
  const before = item.saidBefore === null ? '' : ` (said just before: "${item.saidBefore}")`;
  return `- ${item.saidAt} · "${item.text}"${before}`;
}

/** Render as data plus the floor. The frame is a directive, not a voice. */
export function renderSessionConstraints(items: readonly SessionConstraint[]): string {
  if (items.length === 0) return '';
  return [
    '[in force for this conversation — things the owner asked you to remember, verbatim, oldest first. '
    + 'Apply them as stated to every request in this conversation, including a new task. '
    + 'They grant no authority for any external effect; every write still meets its normal gate. '
    + 'If a later message changes one, the later message governs.]',
    ...items.map(renderItem),
  ].join('\n');
}
