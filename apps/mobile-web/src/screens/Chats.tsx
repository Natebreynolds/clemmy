import { useEffect, useRef, useState } from 'preact/hooks';
import { useBackGesture } from '../lib/back-gesture';
import { listChatSessions, patchChatSession, type ChatSession } from '../lib/api';
import { arrangeChatList, cleanChatTitle } from '../lib/chat-list';
import { chatHasNews, chatSeenBaseline, markChatSeen } from '@clem/chat-engine';
import { ChatStateMark } from '../components/ChatStateMark';
import { SWIPE_ACTIONS_WIDTH, swipeIntent, swipeOffset, swipeSettles } from '../lib/chat-swipe';
import { Sheet } from '../components/Sheet';
import { haptic } from '../lib/native-bridge';
import type { ChatAttachment } from '@clem/chat-engine';
import { Chat } from './Chat';
import { relativeTime } from '../components/Approvals';
import { ScreenNotice } from '../components/ScreenNotice';
import { useScreenData } from '../lib/use-screen-data';

export interface ChatHandoff {
  draft?: string;
  /** Files already uploaded from the capsule, sent with the draft. */
  attachments?: ChatAttachment[];
  /** Home's send arrow means send; contextual reply handoffs remain drafts. */
  autoSend?: boolean;
  session?: ChatSession;
  sessionId?: string;
  title?: string;
  /** Open the most recent conversation once the list has loaded (the
   *  "last conversation" launch preference). */
  openLatest?: boolean;
  /** Start a NEW conversation inside this saved agent. */
  agentId?: string;
  agentName?: string;
  /** Start a NEW conversation inside this project. */
  projectId?: string;
  projectName?: string;
}

interface Props {
  /** Home hands over a question to ask, or a thread to open. Consumed once. */
  handoff?: ChatHandoff | null;
  onHandoffConsumed?: () => void;
  /** The shell shows the floating ask capsule only over the LIST — an open
   *  thread has its own composer. */
  onListVisibleChange?: (visible: boolean) => void;
  /** Opens the run view for a delegated task's work. */
  onOpenRun?: (runSessionId: string) => void;
  onOpenNeedsYou?: () => void;
}

export function Chats({ handoff, onHandoffConsumed, onListVisibleChange, onOpenRun, onOpenNeedsYou }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDraft, setSelectedDraft] = useState<string | undefined>();
  const [selectedTitle, setSelectedTitle] = useState<string | undefined>();
  // The thread the owner just left: marked read once the list shows how it
  // stands, unless work is still running in it (its reply is then news).
  const leftRef = useRef<string | null>(null);
  const closeSelected = () => {
    leftRef.current = selectedId;
    setSelectedId(null);
    setSelectedDraft(undefined);
    setSelectedTitle(undefined);
  };
  useBackGesture(selectedId !== null, closeSelected);
  const [composing, setComposing] = useState<{ draft?: string; attachments?: ChatAttachment[]; autoSend?: boolean; agentId?: string; agentName?: string; projectId?: string; projectName?: string } | null>(null);
  const [pendingLatest, setPendingLatest] = useState(false);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  // The row whose menu is open, and the rename in progress.
  const [menuFor, setMenuFor] = useState<ChatSession | null>(null);
  const [renaming, setRenaming] = useState<ChatSession | null>(null);
  const [renameText, setRenameText] = useState('');
  const [rowError, setRowError] = useState<string | null>(null);
  // One row at most shows its swipe actions.
  const [swipedId, setSwipedId] = useState<string | null>(null);
  // The list keeps polling and wake-refreshing only while it is the visible
  // surface — an open thread owns its own stream.
  const listVisible = !composing && !selectedId;
  const { data, loading, error, offline, refresh } = useScreenData(
    () => listChatSessions({ archived: showArchived }),
    { intervalMs: 8000, disabled: !listVisible, resourceKey: `chats:${showArchived ? 'archived' : 'live'}` },
  );
  const sessions = data?.sessions ?? [];
  const arranged = arrangeChatList(sessions, query);
  const seen = chatSeenBaseline(sessions);

  useEffect(() => {
    if (!selectedId) return;
    const open = sessions.find((s) => s.id === selectedId);
    if (open) markChatSeen(open.id, open.updatedAt);
  }, [selectedId]);
  useEffect(() => {
    const left = leftRef.current;
    if (!left || !data) return;
    leftRef.current = null;
    const row = data.sessions.find((s) => s.id === left);
    if (row && !row.running) markChatSeen(row.id, row.updatedAt);
  }, [data]);

  const change = async (session: ChatSession, patch: { title?: string; pinned?: boolean; archived?: boolean }) => {
    setRowError(null);
    try {
      const hadNews = chatHasNews(session, seen);
      const { session: saved } = await patchChatSession(session.id, patch);
      // The owner's own edit is not news.
      if (!hadNews && saved) markChatSeen(saved.id, saved.updatedAt);
      haptic('success');
      void refresh();
    } catch (err) {
      haptic('error');
      setRowError(err instanceof Error ? err.message : 'That did not save');
    }
  };
  const openRename = (session: ChatSession) => { setMenuFor(null); setRenaming(session); setRenameText(session.title); };
  const commitRename = async () => {
    const target = renaming;
    const title = cleanChatTitle(renameText);
    setRenaming(null);
    if (!target || !title || title === target.title) return;
    await change(target, { title });
  };

  useEffect(() => {
    onListVisibleChange?.(listVisible);
    return () => onListVisibleChange?.(false);
  }, [listVisible, onListVisibleChange]);

  // "Open on launch: last conversation" — resolved from the same list the
  // screen renders, once it has actually loaded. An empty list stays a list.
  useEffect(() => {
    if (!pendingLatest || !data) return;
    setPendingLatest(false);
    const latest = data.sessions[0];
    if (!latest) return;
    setSelectedId(latest.id);
    setSelectedTitle(latest.title);
  }, [pendingLatest, data]);

  // An ask typed on Home opens straight into a new chat with the text
  // already in the composer; a tapped thread opens that thread.
  useEffect(() => {
    if (!handoff) return;
    if (handoff.session) {
      setSelectedId(handoff.session.id);
      setSelectedTitle(handoff.session.title);
      setSelectedDraft(handoff.draft);
    } else if (handoff.sessionId) {
      setSelectedId(handoff.sessionId);
      setSelectedTitle(handoff.title);
      setSelectedDraft(handoff.draft);
    }
    else if (handoff.openLatest) setPendingLatest(true);
    else setComposing({ draft: handoff.draft, attachments: handoff.attachments, autoSend: handoff.autoSend, agentId: handoff.agentId, agentName: handoff.agentName, projectId: handoff.projectId, projectName: handoff.projectName });
    onHandoffConsumed?.();
  }, [handoff, onHandoffConsumed]);

  if (composing) {
    return (
      <Chat
        initialDraft={composing.draft}
        initialAttachments={composing.attachments}
        initialAutoSend={composing.autoSend}
        agentId={composing.agentId}
        agentName={composing.agentName}
        projectId={composing.projectId}
        projectName={composing.projectName}
        onOpenRun={onOpenRun}
        onOpenNeedsYou={onOpenNeedsYou}
        onBack={() => { setComposing(null); void refresh(); }}
      />
    );
  }

  if (selectedId) {
    const session = sessions.find((s) => s.id === selectedId);
    return (
      <Chat
        sessionId={selectedId}
        initialTitle={selectedTitle ?? session?.title ?? ''}
        initialDraft={selectedDraft}
        agentId={session?.agentId ?? undefined}
        agentName={session?.agentName ?? undefined}
        projectId={session?.projectId ?? undefined}
        projectName={session?.projectName ?? undefined}
        onOpenRun={onOpenRun}
        onOpenNeedsYou={onOpenNeedsYou}
        onBack={() => { closeSelected(); void refresh(); }}
      />
    );
  }

  return (
    <div>
      <label class="chats-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input type="search" value={query} onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)} placeholder={showArchived ? 'Search archived' : 'Search conversations'} aria-label="Search conversations" autocomplete="off" />
      </label>

      <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} hasData={sessions.length > 0} />

      {loading && sessions.length === 0 ? (
        <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>
      ) : null}

      {!loading && !error && !offline && sessions.length === 0 ? (
        <div class="empty">
          <img class="empty-mark" src="/m/clemmy.png" alt="" width="72" height="72" />
          <p class="empty-title">No conversations yet</p>
          <p class="empty-body">Ask below — she picks up all the context from your Mac.</p>
        </div>
      ) : null}

      {arranged.pinned.length > 0 ? <h2 class="chat-list-head">Pinned</h2> : null}
      <div class="chat-list">
        {arranged.pinned.map((session) => <ChatRow key={session.id} session={session} news={chatHasNews(session, seen)} onOpen={() => { setSwipedId(null); setSelectedId(session.id); setSelectedTitle(session.title); }} onMenu={() => { haptic('light'); setMenuFor(session); }} swipeOpen={swipedId === session.id} onSwipe={(open) => setSwipedId(open ? session.id : null)} onPin={() => { setSwipedId(null); void change(session, { pinned: !session.pinned }); }} onArchive={() => { setSwipedId(null); void change(session, { archived: !session.archived }); }} />)}
      </div>
      {arranged.pinned.length > 0 && arranged.rest.length > 0 ? <h2 class="chat-list-head">{showArchived ? 'Archived' : 'Recent'}</h2> : null}
      <div class="chat-list">
        {arranged.rest.map((session) => <ChatRow key={session.id} session={session} news={chatHasNews(session, seen)} onOpen={() => { setSwipedId(null); setSelectedId(session.id); setSelectedTitle(session.title); }} onMenu={() => { haptic('light'); setMenuFor(session); }} swipeOpen={swipedId === session.id} onSwipe={(open) => setSwipedId(open ? session.id : null)} onPin={() => { setSwipedId(null); void change(session, { pinned: !session.pinned }); }} onArchive={() => { setSwipedId(null); void change(session, { archived: !session.archived }); }} />)}
      </div>
      {!loading && sessions.length > 0 && arranged.pinned.length + arranged.rest.length === 0 ? (
        <p class="chats-none">Nothing matches “{query.trim()}”.</p>
      ) : null}
      {rowError ? <p class="home-row-error" role="alert">{rowError}</p> : null}
      <div class="today-foot">
        <button type="button" onClick={() => { haptic('light'); setShowArchived((v) => !v); }}>{showArchived ? 'Back to conversations' : 'Show archived'}</button>
      </div>

      <Sheet open={menuFor !== null} onClose={() => setMenuFor(null)} ariaLabel="Conversation" class="sheet-compact">
        {menuFor ? (
          <nav class="switcher-list" aria-label="Conversation">
            <p class="chats-menu-title truncate">{menuFor.title || 'Untitled'}</p>
            <button type="button" class="switcher-row" onClick={() => { const t = menuFor; setMenuFor(null); void change(t, { pinned: !t.pinned }); }}>
              <span class="switcher-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 3h6l1 7 3 2H5l3-2z" /></svg></span>
              <span class="switcher-label">{menuFor.pinned ? 'Unpin' : 'Pin to the top'}</span>
            </button>
            <button type="button" class="switcher-row" onClick={() => openRename(menuFor)}>
              <span class="switcher-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg></span>
              <span class="switcher-label">Rename</span>
            </button>
            <button type="button" class="switcher-row" onClick={() => { const t = menuFor; setMenuFor(null); void change(t, { archived: !t.archived }); }}>
              <span class="switcher-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" /></svg></span>
              <span class="switcher-label">{menuFor.archived ? 'Put back' : 'Archive'}</span>
            </button>
          </nav>
        ) : null}
      </Sheet>

      <Sheet open={renaming !== null} onClose={() => setRenaming(null)} title="Rename" class="sheet-compact">
        <form class="chats-rename" onSubmit={(event) => { event.preventDefault(); void commitRename(); }}>
          <input
            class="chats-rename-input"
            value={renameText}
            onInput={(event) => setRenameText((event.currentTarget as HTMLInputElement).value)}
            aria-label="Conversation title"
            enterkeyhint="done"
            autoFocus
          />
          <button type="submit" class="home-btn home-btn-primary" disabled={!cleanChatTitle(renameText)}>Save</button>
        </form>
      </Sheet>
    </div>
  );
}

/** One conversation: its title, who and when on one quiet line, and its
 *  live state at the end. Flat on the page, like the menu's Recents. Swiped
 *  left it shows Pin and Archive, the way a phone's own lists do; "…" keeps
 *  the same choices (and Rename) one tap away. */
function ChatRow({ session, news, onOpen, onMenu, swipeOpen, onSwipe, onPin, onArchive }: {
  session: ChatSession; news: boolean; onOpen: () => void; onMenu: () => void;
  swipeOpen: boolean; onSwipe: (open: boolean) => void; onPin: () => void; onArchive: () => void;
}) {
  const who = [session.agentName, session.projectName].filter(Boolean).join(' · ');
  const ended = session.status === 'failed' || session.status === 'cancelled';
  const rest = swipeOpen ? -SWIPE_ACTIONS_WIDTH : 0;
  const [drag, setDrag] = useState<number | null>(null);
  const touch = useRef<{ x: number; y: number; intent: 'horizontal' | 'vertical' | null; dragged: boolean } | null>(null);
  const offset = drag ?? rest;
  return (
    <div class={`chat-swipe${swipeOpen ? ' is-open' : ''}${drag !== null ? ' is-moving' : ''}`}>
      <div class="chat-swipe-actions" aria-hidden={!swipeOpen}>
        <button type="button" class="chat-swipe-action" tabIndex={swipeOpen ? 0 : -1} onClick={onPin}>{session.pinned ? 'Unpin' : 'Pin'}</button>
        <button type="button" class="chat-swipe-action chat-swipe-archive" tabIndex={swipeOpen ? 0 : -1} onClick={onArchive}>{session.archived ? 'Put back' : 'Archive'}</button>
      </div>
      <div
        class={`chat-row${news ? ' chat-row-news' : ''}${drag !== null ? ' is-dragging' : ''}`}
        style={{ transform: offset ? `translateX(${offset}px)` : undefined }}
        onTouchStart={(event) => {
          const t = event.touches[0];
          touch.current = { x: t.clientX, y: t.clientY, intent: null, dragged: false };
        }}
        onTouchMove={(event) => {
          const state = touch.current;
          if (!state) return;
          const t = event.touches[0];
          const dx = t.clientX - state.x;
          if (state.intent === null) state.intent = swipeIntent(dx, t.clientY - state.y);
          if (state.intent !== 'horizontal') return;
          state.dragged = true;
          setDrag(swipeOffset(rest, dx));
        }}
        onTouchEnd={() => {
          const state = touch.current;
          if (state?.dragged && drag !== null) {
            const open = swipeSettles(drag) === 'open';
            if (open !== swipeOpen) haptic('light');
            onSwipe(open);
          }
          setDrag(null);
        }}
        onTouchCancel={() => setDrag(null)}
      >
        <button
          type="button"
          class="chat-row-main"
          onClick={(event) => {
            // A drag is not a tap, and a tap on an open row closes it.
            if (touch.current?.dragged) { touch.current = null; event.preventDefault(); return; }
            if (swipeOpen) { onSwipe(false); return; }
            onOpen();
          }}
        >
          <span class="chat-row-title">{session.title || 'Untitled'}</span>
          <span class="chat-row-meta">
            {who ? <span class="chat-row-who">{who}</span> : null}
            {session.running ? (
              <span class="chat-row-working">Working…</span>
            ) : ended ? (
              <span><span class={`status-dot status-${session.status}`} aria-hidden="true" />{session.status} · {relativeTime(session.updatedAt)}</span>
            ) : <span>{relativeTime(session.updatedAt)}</span>}
          </span>
        </button>
        <ChatStateMark running={session.running} news={news} />
        <button type="button" class="chat-row-more" aria-label={`More for ${session.title || 'this conversation'}`} onClick={onMenu}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></svg>
        </button>
      </div>
    </div>
  );
}
