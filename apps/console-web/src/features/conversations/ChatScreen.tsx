import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { PanelLeftOpen, Plus } from 'lucide-react';
import { ConversationSidebar } from './list/ConversationSidebar';
import { chatRailLayout } from './lib/chatRailLayout';

export { chatRailLayout } from './lib/chatRailLayout';

/**
 * Layout for the Chat experience: the conversation rail beside the active
 * conversation. The rail is COLLAPSIBLE (persisted) — a long history reads as
 * clutter next to the composer, so the user can tuck it away to a slim rail
 * that keeps just "expand" + "new chat". The index route renders the new-chat
 * hero (the existing <Chat/> screen); /chat/:sessionId renders a reopened
 * conversation. Both flow through the <Outlet/>.
 */
const RAIL_PREF_KEY = 'clem.chat.rail';
const NARROW_RAIL_QUERY = '(max-width: 767px)';

export function ChatScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(RAIL_PREF_KEY) === 'collapsed'; } catch { return false; }
  });
  const [narrow, setNarrow] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia(NARROW_RAIL_QUERY).matches
  ));
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileHistoryButtonRef = useRef<HTMLButtonElement>(null);
  const setRail = (next: boolean) => {
    setCollapsed(next);
    try { localStorage.setItem(RAIL_PREF_KEY, next ? 'collapsed' : 'open'); } catch { /* preference only */ }
  };

  useEffect(() => {
    const media = window.matchMedia(NARROW_RAIL_QUERY);
    const sync = () => {
      setNarrow(media.matches);
      if (!media.matches) setMobileOpen(false);
    };
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  // Selecting a conversation from the mobile overlay should reveal it
  // immediately; the rail must not remain over the newly opened thread.
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);
  const closeMobileHistory = useCallback(() => {
    setMobileOpen(false);
    window.requestAnimationFrame(() => mobileHistoryButtonRef.current?.focus());
  }, []);
  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMobileHistory();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [closeMobileHistory, mobileOpen]);

  const layout = chatRailLayout(narrow, collapsed, mobileOpen);
  const startNewChat = () => {
    setMobileOpen(false);
    navigate('/chat', { state: { newChat: Date.now() } });
  };

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden animate-fade-in">
      {layout === 'desktop-collapsed' ? (
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
            onClick={startNewChat}
            className="rounded-md p-2 text-muted transition-colors hover:bg-subtle hover:text-fg cursor-pointer"
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : layout === 'desktop-open' ? (
        <ConversationSidebar onCollapse={() => setRail(true)} />
      ) : (
        <>
          <div className="absolute left-2 top-2 z-30 flex items-center gap-1 rounded-lg border border-border bg-surface/95 p-1 shadow-md backdrop-blur">
            <button
              ref={mobileHistoryButtonRef}
              type="button"
              title="Show chat history"
              aria-label="Show chat history"
              onClick={() => setMobileOpen(true)}
              className="rounded-md p-2 text-muted transition-colors hover:bg-subtle hover:text-fg cursor-pointer"
            >
              <PanelLeftOpen className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              title="New chat"
              aria-label="New chat"
              onClick={startNewChat}
              className="rounded-md p-2 text-muted transition-colors hover:bg-subtle hover:text-fg cursor-pointer"
            >
              <Plus className="h-4 w-4" aria-hidden />
            </button>
          </div>
          {layout === 'mobile-overlay' && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Conversation history"
              className="absolute inset-0 z-40 flex"
            >
              <ConversationSidebar
                onCollapse={closeMobileHistory}
                autoFocusSearch
                className="relative z-10 w-[min(300px,calc(100%-2rem))] shadow-lg"
              />
              <button
                type="button"
                aria-label="Close chat history"
                onClick={closeMobileHistory}
                className="absolute inset-0 bg-black/30"
              />
            </div>
          )}
        </>
      )}
      <div className={`flex min-w-0 flex-1 flex-col ${narrow ? 'pt-12' : ''}`}>
        <Outlet />
      </div>
    </div>
  );
}
