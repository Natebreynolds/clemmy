import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Pin, Loader2 } from 'lucide-react';
import { Composer } from '@/components/chat/Composer';
import { ChatBubble } from '@/components/chat/ChatBubble';
import { useChat, type ChatMessage } from '@/lib/useChat';
import { StatusPill } from '@/components/ui/StatusPill';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { useSession } from '../hooks/useSession';
import { useSessionMutations } from '../hooks/useSessionMutations';
import { sessionKeys } from '../hooks/keys';
import { rawId } from '../lib/ids';
import { originMeta } from '../lib/origin';
import type { Session, Turn } from '../types';
import { ReadOnlyNotice } from './ReadOnlyNotice';

let seedSeq = 0;
function historyToMessages(turns: Turn[]): ChatMessage[] {
  return turns.map((t) => ({
    id: `h${++seedSeq}`,
    role: t.role,
    text: t.text,
    status: t.role === 'assistant' ? 'complete' : undefined,
  }));
}

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
  const chat = useChat({
    initialSessionId: rawId(session.id),
    initialMessages: historyToMessages(history),
  });
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat.messages]);

  const send = async (input: { text: string; attachmentIds: string[]; attachmentNames: string[] }) => {
    await chat.send(input);
    // Re-sort + re-title the list now that this conversation has a new turn.
    qc.invalidateQueries({ queryKey: sessionKeys.lists() });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header session={session} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-5 px-6 py-6">
          {chat.messages.map((m) => (
            <ChatBubble
              key={m.id}
              message={m}
              onApprove={() => chat.send({ text: 'approve', attachmentIds: [], attachmentNames: [] })}
              onReject={() => chat.send({ text: 'not now', attachmentIds: [], attachmentNames: [] })}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="border-t border-border bg-canvas/80 backdrop-blur">
        <div className="mx-auto w-full max-w-3xl px-6 py-4">
          <Composer busy={chat.busy} onSend={send} onStop={chat.stop} />
        </div>
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
        <div className="mx-auto w-full max-w-3xl space-y-5 px-6 py-6">
          {messages.length === 0 ? (
            <p className="py-12 text-center text-body text-faint">No messages in this conversation.</p>
          ) : (
            messages.map((m) => <ChatBubble key={m.id} message={m} onApprove={() => {}} onReject={() => {}} />)
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
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-muted">
        <p>This conversation could not be found.</p>
      </div>
    );
  }

  const { session, turns } = detail.data;
  // Their chat loop is harness-native, so only harness chat sessions can be
  // continued in the new console. Workflow/agent runs and legacy desktop
  // (sessions.json) chats are read-only here.
  const canContinue = session.continuable && session.store === 'harness';

  return canContinue
    ? <ContinuableThread key={session.id} session={session} history={turns} />
    : <ReadOnlyThread key={session.id} session={session} history={turns} />;
}
