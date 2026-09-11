import { isRunKind } from '@/lib/run-presentation';
import { RunThread } from './RunThread';
import type { TaskMode } from '@/lib/task-mode';
import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Pin, Loader2 } from 'lucide-react';
import { Composer } from '@/components/chat/Composer';
import { ChatBubble } from '@/components/chat/ChatBubble';
import { chatDecisionIntent, useChat, type ChatMessage } from '@/lib/useChat';
import { decidePlanProposal } from '@/lib/inbox';
import { lastChatSession, rememberLastChatSession } from '@/lib/last-session';
import { StatusPill } from '@/components/ui/StatusPill';
import { Button } from '@/components/ui/Button';
import { CollaborativeWorkstate } from '@/components/CollaborativeWorkstate';
import { cn } from '@/lib/cn';
import { listFocusSnapshot } from '@/lib/focus';
import { usePoll } from '@/lib/poll';
import { useSession } from '../hooks/useSession';
import { useSessionMutations } from '../hooks/useSessionMutations';
import { sessionKeys } from '../hooks/keys';
import { rawId } from '../lib/ids';
import { originMeta } from '../lib/origin';
import type { Session, Turn } from '../types';
import { ReadOnlyNotice } from './ReadOnlyNotice';
import { historyToMessages } from './conversation-history';

function Header({ session }: { session: Session }) {
  const mutations = useSessionMutations();
  const meta = originMeta(session.origin);
  return (
    <div className="flex items-center gap-3 border-b border-border bg-surface px-5 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-h3 text-fg">{session.title || 'New chat'}</h2>
          <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
        </div>
      </div>
      <Button
        size="icon"
        variant="ghost"
        aria-label={session.pinned ? 'Unpin' : 'Pin'}
        onClick={() => mutations.setPinned(session.id, !session.pinned)}
      >
        <Pin className={cn('h-4 w-4', session.pinned && 'fill-primary text-primary')} />
      </Button>
    </div>
  );
}

/** Live, continuable conversation — reuses the canonical harness chat loop. */
function ContinuableThread({ session, history }: { session: Session; history: Turn[] }) {
  const qc = useQueryClient();
  const focus = usePoll(['focus'], listFocusSnapshot, 4000);
  const chat = useChat({
    initialSessionId: rawId(session.id),
    initialMessages: historyToMessages(history),
    // This IS the user's active conversation now — the index returns here,
    // and a turn left running server-side reattaches its live stream instead
    // of rendering a dead transcript with an enabled composer.
    rememberAsLastSession: true,
    reattachActiveRun: true,
  });
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Stick to the bottom by default; release the moment the user scrolls up so
  // streaming tokens don't yank them back down mid-read.
  const stickRef = useRef(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    if (!stickRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: chat.busy ? 'auto' : 'smooth', block: 'end' });
  }, [chat.messages, chat.busy]);

  const send = async (input: { text: string; attachmentIds: string[]; attachmentNames: string[]; taskMode?: TaskMode }) => {
    await chat.send(input);
    // Re-sort + re-title the list now that this conversation has a new turn.
    qc.invalidateQueries({ queryKey: sessionKeys.lists() });
  };

  const resolveDecision = async (message: ChatMessage, decision: 'approve' | 'reject') => {
    const intent = chatDecisionIntent(message, decision);
    if (intent.kind === 'invalid-plan') throw new Error(intent.message);
    if (intent.kind === 'approval-reply') {
      await chat.send({ text: intent.text, attachmentIds: [], attachmentNames: [] });
      return;
    }
    await decidePlanProposal(intent.planProposalId, intent.decision);
    await Promise.all([
      qc.invalidateQueries({ queryKey: sessionKeys.detail(session.id) }),
      qc.invalidateQueries({ queryKey: sessionKeys.lists() }),
      qc.invalidateQueries({ queryKey: ['command-center'] }),
      qc.invalidateQueries({ queryKey: ['plan-proposals'] }),
    ]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header session={session} />
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end space-y-5 px-6 py-6">
          <CollaborativeWorkstate snapshot={focus.data} compact />
          {chat.messages.map((m) => (
            <ChatBubble
              key={m.id}
              message={m}
              sessionId={chat.sessionId.current ?? undefined}
              executionBusy={chat.busy}
              onExecutePlan={chat.executePlan}
              onRevisePlan={() => { chat.setComposerMode('plan'); composerRef.current?.focus(); }}
              onApprove={() => resolveDecision(m, 'approve')}
              onReject={() => resolveDecision(m, 'reject')}
              traceHref={`/tasks?select=${encodeURIComponent(session.id)}`}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl px-6 pb-5 pt-2">
        <Composer inputRef={composerRef} sessionId={chat.sessionId.current ?? undefined} busy={chat.busy} mode={chat.composerMode} onModeChange={chat.setComposerMode} activeTaskMode={chat.activeTaskMode} pendingPost={chat.pendingPost} onRetryPending={chat.retryPending} onCancelPending={chat.cancelPending} onSend={send} onStop={chat.stop} />
      </div>
    </div>
  );
}

/** Read-only transcript (workflow / agent runs, or legacy desktop chats). */
function ReadOnlyThread({ session, history }: { session: Session; history: Turn[] }) {
  const messages = historyToMessages(history);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header session={session} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end space-y-5 px-6 py-6">
          {messages.length === 0 ? (
            <p className="py-12 text-center text-body text-faint">No messages in this conversation.</p>
          ) : (
            messages.map((m) => <ChatBubble key={m.id} message={m} sessionId={rawId(session.id)} onApprove={() => {}} onReject={() => {}} />)
          )}
        </div>
      </div>
      <ReadOnlyNotice kind={session.kind} />
    </div>
  );
}

export function ConversationThread() {
  const { sessionId } = useParams();
  const detail = useSession(sessionId);

  if (detail.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (detail.isError || !detail.data) {
    // A dead pointer must not keep bouncing the chat index back here.
    if (sessionId && lastChatSession() === sessionId) rememberLastChatSession(null);
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-muted">
        <p>This conversation could not be found.</p>
      </div>
    );
  }

  const { session, turns } = detail.data;
  if (isRunKind(session.kind)) return <RunThread key={session.id} session={session} />;
  // Their chat loop is harness-native, so only harness chat sessions can be
  // continued in the new console. Workflow/agent runs and legacy desktop
  // (sessions.json) chats are read-only here.
  const canContinue = session.continuable && session.store === 'harness';

  return canContinue
    ? <ContinuableThread key={session.id} session={session} history={turns} />
    : <ReadOnlyThread key={session.id} session={session} history={turns} />;
}
