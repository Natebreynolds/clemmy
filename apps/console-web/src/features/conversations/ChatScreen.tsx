import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { PanelLeftOpen, Plus } from 'lucide-react';
import { ConversationSidebar } from './list/ConversationSidebar';
import { chatRailLayout } from './lib/chatRailLayout';

export { chatRailLayout } from './lib/chatRailLayout';

/**
 * Desktop history lives in the global navigator, alongside the user's work.
 * A narrow window keeps a temporary history overlay so the thread gets the
 * available width. Both conversation routes share the same Outlet.
 */
const NARROW_RAIL_QUERY = '(max-width: 767px)';

export function ChatScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const [narrow, setNarrow] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia(NARROW_RAIL_QUERY).matches
  ));
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileHistoryButtonRef = useRef<HTMLButtonElement>(null);
  const mobileHistoryRef = useRef<HTMLDivElement>(null);

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
  useEffect(() => { setMobileOpen(false); }, [location.key]);
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

  const layout = chatRailLayout(narrow, mobileOpen);
  const startNewChat = () => {
    setMobileOpen(false);
    navigate('/chat', { state: { newChat: Date.now() } });
  };

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden animate-fade-in">
      {layout !== 'desktop' && (
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
              ref={mobileHistoryRef}
              role="dialog"
              aria-modal="true"
              aria-label="Conversation history"
              className="absolute inset-0 z-40 flex"
              onKeyDown={event => {
                if (event.key !== 'Tab') return;
                const elements = [...(mobileHistoryRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])]
                  .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0);
                const first = elements[0]; const last = elements.at(-1);
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
              }}
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
      <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${narrow ? 'pt-12' : ''}`}>
        <Outlet />
      </div>
    </div>
  );
}
