import { listChatSessions, type ChatSession } from '../lib/api';
import { arrangeChatList } from '../lib/chat-list';
import { chatHasNews, chatSeenBaseline } from '@clem/chat-engine';
import { useScreenData } from '../lib/use-screen-data';
import { haptic } from '../lib/native-bridge';
import { ChatStateMark } from './ChatStateMark';

const SHOWN = 8;

/**
 * The conversations in the menu, as the owner left them: what they pinned,
 * then the most recent, each with its live state, so work that kept going
 * after they left a thread is visible from anywhere. Read only while the menu
 * is open; the full list (search, archive) is one tap away.
 */
export function DrawerRecents({ open, onOpen, onAll }: {
  open: boolean;
  onOpen: (session: ChatSession) => void;
  onAll: () => void;
}) {
  const { data } = useScreenData(() => listChatSessions(), { intervalMs: 5000, disabled: !open, resourceKey: 'drawer-recents' });
  const sessions = data?.sessions ?? [];
  if (sessions.length === 0) return null;
  const seen = chatSeenBaseline(sessions);
  const arranged = arrangeChatList(sessions, '');
  const shown = [...arranged.pinned, ...arranged.rest].slice(0, SHOWN);
  return (
    <section class="drawer-recents" aria-label="Recent conversations">
      <h2 class="drawer-recents-head">Recents</h2>
      {shown.map((session) => (
        <button
          key={session.id}
          type="button"
          class="drawer-recent"
          onClick={() => { haptic('light'); onOpen(session); }}
        >
          <span class="drawer-recent-icon" aria-hidden="true">
            {session.agentName ? (
              <span class="drawer-recent-initial">{session.agentName.trim().charAt(0).toUpperCase()}</span>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.6A8 8 0 1 1 21 12z" /></svg>
            )}
          </span>
          <span class="drawer-recent-title">{session.title || 'Untitled'}</span>
          <ChatStateMark running={session.running} news={chatHasNews(session, seen)} />
        </button>
      ))}
      <button type="button" class="drawer-recent drawer-recent-all" onClick={() => { haptic('light'); onAll(); }}>
        <span class="drawer-recent-title">All chats</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
      </button>
    </section>
  );
}
