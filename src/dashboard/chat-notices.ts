/**
 * A chat the owner archives or deletes needs nothing more from them: its own
 * unread notices (a report back, an answer that finished after they left) are
 * read with it, so Needs you keeps no row for a conversation they set aside.
 * A notice belongs to the chat by its own session; a workflow the chat started
 * keeps its notices, since the workflow lives on.
 */
import { loadNotifications, markNotificationsRead } from '../runtime/notifications.js';

export function settleNoticesOfSetAsideChats(sessionIds: readonly string[]): number {
  const chats = new Set(sessionIds.filter((id) => typeof id === 'string' && id.trim()));
  if (chats.size === 0) return 0;
  const owned = loadNotifications()
    .filter((notification) => !notification.read)
    .filter((notification) => {
      const meta = notification.metadata ?? {};
      return [meta.sessionId, meta.session_id].some((value) => typeof value === 'string' && chats.has(value));
    })
    .map((notification) => notification.id);
  return owned.length > 0 ? markNotificationsRead(owned).cleared.length : 0;
}
