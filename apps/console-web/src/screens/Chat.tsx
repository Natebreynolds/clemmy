import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Sparkles, X } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { usePoll } from '@/lib/poll';
import { dismissInboxItem } from '@/lib/inbox';
import { useChat } from '@/lib/useChat';
import type { CommandCenter, CommandCenterItem } from '@/lib/types';
import { DogMark } from '@/components/DogMark';
import { Composer } from '@/components/chat/Composer';
import { ChatBubble } from '@/components/chat/ChatBubble';
import { StatusPill } from '@/components/ui/StatusPill';
import { cn } from '@/lib/cn';

function timeGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

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

function AttentionStrip({ needsYou, workingNow, onDismiss }: { needsYou: CommandCenterItem[]; workingNow: CommandCenterItem[]; onDismiss?: (item: CommandCenterItem) => void }) {
  const navigate = useNavigate();
  if (needsYou.length === 0 && workingNow.length === 0) return null;
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
      {workingNow.slice(0, 2).map((item, i) => (
        <div key={`w${i}`} className="flex items-center gap-3 rounded-md border border-border bg-subtle px-3 py-2.5">
          <StatusPill tone="live">Working now</StatusPill>
          <span className="min-w-0 flex-1 truncate text-body text-muted">{item.title ?? 'In progress'}</span>
        </div>
      ))}
    </div>
  );
}

export function Chat() {
  const qc = useQueryClient();
  const cc = usePoll(['command-center'], () => apiGet<CommandCenter>('/api/console/home/command-center'), 6000);
  const dismissCard = async (item: CommandCenterItem) => {
    if (!item.dismissKind || !item.dismissId) return;
    try { await dismissInboxItem(item.dismissKind, item.dismissId); } finally {
      void qc.invalidateQueries({ queryKey: ['command-center'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    }
  };
  const chat = useChat();
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
  const workingNow = cc.data?.workingNow ?? [];
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

  const approveLast = () => chat.send({ text: 'approve' });
  const rejectLast = () => chat.send({ text: 'not now' });

  if (!hasThread) {
    return (
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col justify-center px-8 py-8">
        <div className="mb-6 text-center">
          <DogMark size={56} className="mx-auto mb-4" />
          <h2 className="text-display text-fg">{timeGreeting()}</h2>
          <p className="mt-1 text-body-lg text-muted">
            {cc.data?.presence?.awayMessage ?? "I'm here. Ask me anything, or tap Talk."}
          </p>
        </div>

        {(needsYou.length > 0 || workingNow.length > 0) && (
          <div className="mb-5">
            <AttentionStrip needsYou={needsYou} workingNow={workingNow} onDismiss={dismissCard} />
          </div>
        )}

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
          {(needsYou.length > 0 || workingNow.length > 0) && (
            <AttentionStrip needsYou={needsYou} workingNow={workingNow} onDismiss={dismissCard} />
          )}
          {chat.messages.map((m) => (
            <ChatBubble key={m.id} message={m} onApprove={approveLast} onReject={rejectLast} onBackground={chat.background} />
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
