import { useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { PanelLeftOpen, Plus } from 'lucide-react';
import { ConversationSidebar } from './list/ConversationSidebar';

/**
 * Layout for the Chat experience: the conversation rail beside the active
 * conversation. The rail is COLLAPSIBLE (persisted) — a long history reads as
 * clutter next to the composer, so the user can tuck it away to a slim rail
 * that keeps just "expand" + "new chat". The index route renders the new-chat
 * hero (the existing <Chat/> screen); /chat/:sessionId renders a reopened
 * conversation. Both flow through the <Outlet/>.
 */
const RAIL_PREF_KEY = 'clem.chat.rail';

export function ChatScreen() {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(RAIL_PREF_KEY) === 'collapsed'; } catch { return false; }
  });
  const setRail = (next: boolean) => {
    setCollapsed(next);
    try { localStorage.setItem(RAIL_PREF_KEY, next ? 'collapsed' : 'open'); } catch { /* preference only */ }
  };

  return (
    <div className="flex h-full min-h-0 animate-fade-in">
      {collapsed ? (
        <div className="flex h-full w-12 shrink-0 flex-col items-center gap-1.5 border-r border-border bg-surface py-3">
          <button
            type="button"
            title="Show chat history"
            aria-label="Show chat history"
            onClick={() => setRail(false)}
            className="rounded-md p-2 text-muted transition-colors hover:bg-subtle hover:text-fg cursor-pointer"
          >
            <PanelLeftOpen className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            title="New chat"
            aria-label="New chat"
            onClick={() => navigate('/chat', { state: { newChat: Date.now() } })}
            className="rounded-md p-2 text-muted transition-colors hover:bg-subtle hover:text-fg cursor-pointer"
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : (
        <ConversationSidebar onCollapse={() => setRail(true)} />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  );
}
