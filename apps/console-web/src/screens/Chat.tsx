import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Sparkles, X } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { usePoll } from '@/lib/poll';
import { getContext } from '@/lib/memory';
import { greetingName, timeGreeting } from '@/lib/greeting';
import { dismissInboxItem } from '@/lib/inbox';
import { chatApprovalReply, useChat } from '@/lib/useChat';
import { lastChatSession, rememberLastChatSession } from '@/lib/last-session';
import type { CommandCenter, CommandCenterItem } from '@/lib/types';
import { DogMark } from '@/components/DogMark';
import { Composer } from '@/components/chat/Composer';
import { ChatBubble } from '@/components/chat/ChatBubble';
import { StatusPill } from '@/components/ui/StatusPill';
import { CollaborativeWorkstate } from '@/components/CollaborativeWorkstate';
import { cn } from '@/lib/cn';

const SUGGESTIONS = [
  "What's on my plate today?",
  'Recap what got done yesterday',
  'Draft a follow-up email',
];

/** Where a "Needs you" card should land. Both approval- and needs-attention-
 *  notification-backed cards live on the Inbox "Needs you" tab now — deep-link
 *  straight to the item so "See all in Inbox" always lands on what it promised. */
function inboxTarget(item: CommandCenterItem): string {
  if (item.notifId) return `/inbox?tab=needs&select=${encodeURIComponent(item.notifId)}`;
  if (item.approvalId) return `/inbox?tab=needs&select=${encodeURIComponent(item.approvalId)}`;
  return '/inbox';
}

function AttentionStrip({ needsYou, onDismiss }: { needsYou: CommandCenterItem[]; onDismiss?: (item: CommandCenterItem) => void }) {
  const navigate = useNavigate();
  if (needsYou.length === 0) return null;
  return (
    <div className="space-y-2">
      {needsYou.slice(0, 3).map((item, i) => (
        <div
          key={`n${i}`}
          role="button"
          tabIndex={0}
          onClick={() => navigate(inboxTarget(item))}
          onKeyDown={(e) => { if (e.key === 'Enter') navigate(inboxTarget(item)); }}
          className="flex w-full items-center gap-3 rounded-md border border-warning/40 bg-warning-tint px-3 py-2.5 text-left transition-colors hover:brightness-[0.99] cursor-pointer"
        >
          <StatusPill tone="warning">Needs you</StatusPill>
          <span className="min-w-0 flex-1 truncate text-body text-fg">{item.title ?? 'Pending approval'}</span>
          {item.dismissKind && item.dismissId && onDismiss && (
            <button
              type="button"
              aria-label="Dismiss"
              title="Dismiss — I don't need this"
              onClick={(e) => { e.stopPropagation(); onDismiss(item); }}
              className="rounded p-1 text-muted transition-colors hover:bg-warning/20 hover:text-fg cursor-pointer"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
          <ArrowRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        </div>
      ))}
      {needsYou.length > 3 && (
        <button
          type="button"
          onClick={() => navigate('/inbox')}
          className="text-small text-primary hover:underline cursor-pointer"
        >
          See all {needsYou.length} in Inbox
        </button>
      )}
    </div>
  );
}

export function Chat() {
  const qc = useQueryClient();
  const cc = usePoll(['command-center'], () => apiGet<CommandCenter>('/api/console/home/command-center'), 6000);
  // The profile changes rarely; a slow poll keeps the greeting personal
  // without adding chatter to the fast command-center loop.
  const userContext = usePoll(['user-context'], getContext, 300000);
  const dismissCard = async (item: CommandCenterItem) => {
    if (!item.dismissKind || !item.dismissId) return;
    try { await dismissInboxItem(item.dismissKind, item.dismissId); } finally {
      void qc.invalidateQueries({ queryKey: ['command-center'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    }
  };
  const chat = useChat({ rememberAsLastSession: true });
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the view is "stuck" to the bottom. True by default so the initial
  // load lands at the newest message; flips false the moment the user scrolls up
  // (so streaming tokens don't yank them back down mid-read).
  const stickRef = useRef(true);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const seededRef = useRef(false);

  const needsYou = cc.data?.needsYou ?? [];
  const hasThread = chat.messages.length > 0;

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    if (!stickRef.current) return;
    // 'auto' while streaming: smooth-scroll can't keep up with rapid token
    // appends and piles up into visible jitter.
    bottomRef.current?.scrollIntoView({ behavior: chat.busy ? 'auto' : 'smooth', block: 'end' });
  }, [chat.messages, chat.busy]);

  // "New chat" from the sidebar navigates to /chat with a fresh state stamp even
  // when already here — reset the live thread so it doesn't append to the old one.
  // Guard on the stamp value so a re-render (chat is a fresh object each time)
  // doesn't reset again and wipe a thread the user just started.
  const resetChat = chat.reset;
  const lastNewChatRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const stamp = (location.state as { newChat?: number } | null)?.newChat;
    if (stamp && stamp !== lastNewChatRef.current) {
      lastNewChatRef.current = stamp;
      resetChat();
      // An explicit "New chat" releases the active-conversation pointer — the
      // index must not bounce straight back into the thread being left.
      rememberLastChatSession(null);
      stickRef.current = true;
    }
  }, [location.state, resetChat]);

  // Deep-link: /chat?prompt=… auto-sends a message (e.g. "Discuss in chat"
  // from a meeting). Fires once, then strips the param so a refresh won't resend.
  useEffect(() => {
    const prompt = searchParams.get('prompt');
    if (prompt && !seededRef.current) {
      seededRef.current = true;
      chat.send({ text: prompt });
      const next = new URLSearchParams(searchParams);
      next.delete('prompt');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, chat, setSearchParams]);

  // Static-window return (2026-08-04): the chat index used to greet with a
  // blank hero even while the user's conversation — possibly mid-run — sat
  // one navigation away, and the next message would mint a NEW session (the
  // dominant sidebar-clutter source). With no thread on screen, no deep-link
  // seed, and no explicit "New chat", return to the active conversation.
  const activeConversation = lastChatSession();
  if (
    !hasThread
    && activeConversation
    && !searchParams.get('prompt')
    && !(location.state as { newChat?: number } | null)?.newChat
  ) {
    return <Navigate to={`/chat/${encodeURIComponent(activeConversation)}`} replace />;
  }

  if (!hasThread) {
    return (
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col justify-center px-8 py-8">
        <div className="mb-6 text-center">
          <DogMark size={56} className="mx-auto mb-4" />
          <h2 className="text-display text-fg">{timeGreeting(new Date().getHours(), greetingName(userContext.data?.profile))}</h2>
          {/* Needs-you is rendered directly below, so do not repeat the same
              item as the away message. Foreground progress belongs inside the
              assistant bubble; detached work stays behind the top-bar badge. */}
          <p className="mt-1 text-body-lg text-muted">
            {needsYou.length > 0
              ? "I'm here. Ask me anything, or tap Talk."
              : (cc.data?.presence?.awayMessage ?? "I'm here. Ask me anything, or tap Talk.")}
          </p>
        </div>

        {needsYou.length > 0 && (
          <div className="mb-5">
            <AttentionStrip needsYou={needsYou} onDismiss={dismissCard} />
          </div>
        )}

        <CollaborativeWorkstate snapshot={cc.data?.focus} compact className="mb-5" />

        <Composer busy={chat.busy} onSend={chat.send} onStop={chat.stop} onBackground={chat.background} />

        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => chat.send({ text: s })}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 py-1.5 text-small text-muted transition-colors hover:border-border-strong hover:text-fg cursor-pointer"
            >
              <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
              {s}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-5 px-8 py-6">
          {needsYou.length > 0 && (
            <AttentionStrip needsYou={needsYou} onDismiss={dismissCard} />
          )}
          <CollaborativeWorkstate snapshot={cc.data?.focus} compact />
          {chat.messages.map((m) => (
            <ChatBubble
              key={m.id}
              message={m}
              onApprove={() => chat.send({ text: chatApprovalReply('approve', m.approval?.approvalId) })}
              onReject={() => chat.send({ text: chatApprovalReply('reject', m.approval?.approvalId) })}
              onBackground={chat.background}
              traceHref={chat.sessionId.current ? `/tasks?select=${encodeURIComponent(chat.sessionId.current)}` : undefined}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className={cn('border-t border-border bg-canvas/80 backdrop-blur')}>
        <div className="mx-auto w-full max-w-3xl px-8 py-4">
          <Composer busy={chat.busy} onSend={chat.send} onStop={chat.stop} onBackground={chat.background} />
        </div>
      </div>
    </div>
  );
}
