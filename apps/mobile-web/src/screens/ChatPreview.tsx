/**
 * Local chrome preview for mobile chat. Gated in main.tsx behind
 * `?preview=chat` so it never ships as a product surface. Daemon-free:
 * the thread composer, header, and Plan bar use the live CSS.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { ChatBackButton } from '../components/ChatBackButton';

type PreviewState = 'empty' | 'thread' | 'busy';

function previewStateFromSearch(): PreviewState {
  const value = new URLSearchParams(window.location.search).get('state');
  return value === 'thread' || value === 'busy' ? value : 'empty';
}

export function ChatPreview() {
  const [state, setState] = useState<PreviewState>(previewStateFromSearch);
  const [draft, setDraft] = useState(state === 'busy' ? 'and skip the recap' : '');
  const [dockH, setDockH] = useState(140);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = dockRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setDockH(el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [state]);

  useEffect(() => {
    document.title = 'Chat preview · Clem';
  }, []);

  const busy = state === 'busy';
  const title = state === 'empty' ? 'New chat' : 'Prep me for the 2pm with Jordan';

  return (
    <>
      <div class="chat-preview-switch" role="navigation" aria-label="Preview states">
        {(['empty', 'thread', 'busy'] as const).map((item) => (
          <button
            key={item}
            type="button"
            class={state === item ? 'is-on' : undefined}
            onClick={() => {
              setState(item);
              setDraft(item === 'busy' ? 'and skip the recap' : '');
              const next = new URL(window.location.href);
              next.searchParams.set('preview', 'chat');
              next.searchParams.set('state', item);
              window.history.replaceState(null, '', `${next.pathname}${next.search}`);
            }}
          >
            {item}
          </button>
        ))}
      </div>
      <header class="app-header">
        <img class="brand-mark" src="/m/clemmy.png" alt="" width="28" height="28" />
        <h1 class="app-title">
          <button type="button" class="title-switch" aria-label="Chats">
            <span class="title-switch-text">Chats</span>
            <svg class="title-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </h1>
        <div class="meta">
          <span class="conn-dot-only" role="status" aria-label="Direct" />
        </div>
      </header>
      <main class="app-main">
        <div
          class="chat-shell"
          style={{ '--kb-inset': '0px', '--chat-dock-h': `${dockH}px` }}
        >
          <div class="chat-header">
            <ChatBackButton onClick={() => undefined} />
            <h2 class="chat-title">{title}</h2>
            <button type="button" class="brain-chip" title="Does the work: the model that answers your next message">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 3a4 4 0 0 0-4 4 4 4 0 0 0-3 6.5 4 4 0 0 0 3 6.5h.5" /><path d="M12 3a4 4 0 0 1 4 4 4 4 0 0 1 3 6.5 4 4 0 0 1-3 6.5h-.5" /><path d="M12 3v17" />
              </svg>
              <span class="truncate">Clem</span>
            </button>
          </div>
          <div class="chat-transcript" role="log" aria-label="Conversation">
            {state === 'empty' ? (
              <div class="inbox-empty">Type a message to start a new chat.</div>
            ) : (
              <>
                <div class="turn turn-user">
                  <div class="user-said">Prep me for the 2pm with Jordan. What’s actually on the table?</div>
                </div>
                <div class="turn turn-assistant">
                  <div class="work">
                    <div class="work-head">
                      <button class="work-line" type="button" aria-expanded={false}>
                        {busy
                          ? <span class="work-spinner" aria-hidden="true" />
                          : <span class="work-caret" aria-hidden="true">›</span>}
                        <span class="work-summary">{busy ? 'Reading the last three notes' : 'Worked 12s · 4 steps'}</span>
                        {busy ? <span class="work-elapsed">8s</span> : null}
                      </button>
                    </div>
                  </div>
                  {busy ? (
                    <div class="reply reply-ghost">Thinking…</div>
                  ) : (
                    <div class="reply bubble-md">
                      <p>Jordan wants a yes on the West region rollout. The open thread is pricing, not product — she already signed off on the deck last Thursday.</p>
                      <p>Two things to have in your pocket: the revised unit cost from the sheet, and the note that legal cleared the customer letter yesterday.</p>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          <div class="chat-dock-fade" aria-hidden="true" />
          <div ref={dockRef} class="chat-dock">
            <div class="chat-mode-bar">
              <button type="button" aria-pressed={false} disabled={busy}>Plan</button>
              <span>{busy ? 'Planning · investigating with read-only tools' : 'Normal · handle the task'}</span>
            </div>
            <form class="chat-composer" onSubmit={(event) => event.preventDefault()}>
              <button type="button" class="chat-mic" aria-label="Dictate" aria-pressed={false}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
                </svg>
              </button>
              <textarea
                ref={textareaRef}
                class="chat-input"
                rows={1}
                aria-label="Message Clem"
                placeholder="Message Clem…"
                value={draft}
                enterkeyhint="send"
                autocomplete="off"
                onInput={(event) => {
                  const el = event.currentTarget as HTMLTextAreaElement;
                  setDraft(el.value);
                  el.style.height = 'auto';
                  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
                }}
              />
              {busy ? (
                <>
                  <button class="chat-send" type="submit" disabled={draft.trim().length === 0} aria-label="Send while she works">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M12 19V5M5 12l7-7 7 7" />
                    </svg>
                  </button>
                  <button class="chat-stop" type="button" aria-label="Stop">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
                    </svg>
                  </button>
                </>
              ) : (
                <button class="chat-send" type="submit" disabled={draft.trim().length === 0} aria-label="Send">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              )}
            </form>
          </div>
        </div>
      </main>
    </>
  );
}
