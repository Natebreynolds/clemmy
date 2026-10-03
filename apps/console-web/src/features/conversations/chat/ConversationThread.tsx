import { CliSessions } from '@/components/chat/CliSessions';
import { CloudBrowserWorkspace } from '@/components/chat/CloudBrowserDock';
import { isRunKind } from '@/lib/run-presentation';
import { RunThread } from './RunThread';
import type { TaskMode } from '@/lib/task-mode';
import { Fragment, useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { FolderKanban, Pin, Loader2 } from 'lucide-react';
import { Composer } from '@/components/chat/Composer';
import { AgentPicker } from '@/components/chat/AgentPicker';
import { ProjectPicker } from '@/components/chat/ProjectPicker';
import { ConversationChangeLine } from '@/components/chat/ConversationChangeLine';
import { ConversationTasks } from '@/components/chat/ConversationTasks';
import { agentThreadMarks, projectThreadMarks, APPROVAL_ANSWER_WORDS } from '@clem/chat-engine';
import { useConversationAgent } from '@/lib/conversation-agent';
import { useConversationProject } from '@/lib/conversation-project';
import { reportOwner, useConversationTasks } from '@/lib/conversation-tasks';
import { ChatBubble } from '@/components/chat/ChatBubble';
import { chatDecisionIntent, useChat, type ChatMessage } from '@/lib/useChat';
import { decidePlanProposal } from '@/lib/inbox';
import { lastChatSession, rememberLastChatSession } from '@/lib/last-session';
import { Tag } from '@/components/ui/StatusPill';
import { Button } from '@/components/ui/Button';
import { CollaborativeWorkstate } from '@/components/CollaborativeWorkstate';
import { cn } from '@/lib/cn';
import { listFocusSnapshot } from '@/lib/focus';
import { usePoll } from '@/lib/poll';
import { useSession } from '../hooks/useSession';
import { sessionHistoryReady } from '../hooks/session-history-readiness';
import { useSessionMutations } from '../hooks/useSessionMutations';
import { sessionKeys } from '../hooks/keys';
import { rawId } from '../lib/ids';
import { originMeta } from '../lib/origin';
import type { Session, Turn } from '../types';
import { ReadOnlyNotice } from './ReadOnlyNotice';
import { historyToMessages } from './conversation-history';
import { CHAT_COMPOSER_WRAP, CHAT_THREAD } from '../lib/chatColumn';

function Header({ session }: { session: Session }) {
  const mutations = useSessionMutations();
  const meta = originMeta(session.origin);
  return (
    <div className="flex items-center gap-3 border-b border-border bg-surface px-5 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 truncate text-h3 text-fg">{session.title || 'New chat'}</h2>
          <Tag className="shrink-0 whitespace-nowrap">{meta.label}</Tag>
          {session.agentName && <Tag title="Answering this conversation" className="max-w-[12rem] shrink-0 truncate whitespace-nowrap">{session.agentName}</Tag>}
          {session.projectId && session.projectName && (
            <Link
              to={`/projects/${encodeURIComponent(session.projectId)}`}
              aria-label={`Project: ${session.projectName}`}
              className="min-w-0 shrink-0 rounded-sm transition-opacity hover:opacity-80"
            >
              <Tag title="The project this conversation works in" className="max-w-[14rem] gap-1 whitespace-nowrap">
                <FolderKanban className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{session.projectName}</span>
              </Tag>
            </Link>
          )}
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
  // Who answers next: the conversation's own agent until the chip changes it.
  // A Space dock takes no agent, so it shows no chip.
  const takesAgent = !rawId(session.id).startsWith('space-');
  const agentChoice = useConversationAgent(
    session.agentId && session.agentName ? { id: session.agentId, name: session.agentName } : null,
    { onSwitched: () => { void qc.invalidateQueries({ queryKey: sessionKeys.all }); } },
  );
  const marks = agentThreadMarks(chat.messages, session.agentName ?? null);
  // Which project applies next: the conversation's own until the chip changes it.
  const projectChoice = useConversationProject(
    session.projectId && session.projectName ? { id: session.projectId, name: session.projectName } : null,
    { onMoved: () => { void qc.invalidateQueries({ queryKey: sessionKeys.all }); } },
  );
  const projectMarks = projectThreadMarks(chat.messages, session.projectName ?? null);
  const delegated = useConversationTasks(chat.sessionId.current, chat.delegatedTaskTick);
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
    const [addressed, placed] = takesAgent
      ? await Promise.all([
          agentChoice.prepare(chat.sessionId.current, chat.busy),
          projectChoice.prepare(chat.sessionId.current, chat.busy),
        ])
      : [{}, {}];
    await chat.send({ ...input, ...addressed, ...placed });
    // Re-sort + re-title the list now that this conversation has a new turn.
    qc.invalidateQueries({ queryKey: sessionKeys.lists() });
  };

  const resolveDecision = async (message: ChatMessage, decision: 'approve' | 'reject') => {
    const intent = chatDecisionIntent(message, decision);
    if (intent.kind === 'invalid-plan') throw new Error(intent.message);
    if (intent.kind === 'approval-reply') {
      // An answer to a waiting card resumes that reply; a pending agent
      // switch waits for the next new message.
      await chat.send({ text: intent.text, displayText: APPROVAL_ANSWER_WORDS[decision], attachmentIds: [], attachmentNames: [] });
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
    <CloudBrowserWorkspace conversationId={chat.sessionId.current ?? rawId(session.id)}>
    <div className="flex min-h-0 flex-1 flex-col">
      <Header session={session} />
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className={CHAT_THREAD}>
          <CollaborativeWorkstate snapshot={focus.data} sessionId={rawId(session.id)} compact />
          <CliSessions sessionId={chat.sessionId.current ?? undefined} />
          {chat.messages.map((m, index) => (
            <Fragment key={m.id}>
            <ConversationChangeLine agent={marks[index]?.switchedTo} project={projectMarks[index]?.movedTo} />
            <ChatBubble
              message={m}
              speaker={reportOwner(m, delegated.tasks) ?? marks[index]?.speaker ?? undefined}
              project={projectMarks[index]?.project ?? undefined}
              ownedTaskIds={delegated.ownedIds}
              sessionId={chat.sessionId.current ?? undefined}
              executionBusy={chat.busy}
              onExecutePlan={chat.executePlan}
              onRevisePlan={() => { chat.setComposerMode('plan'); composerRef.current?.focus(); }}
              onApprove={() => resolveDecision(m, 'approve')}
              onReject={() => resolveDecision(m, 'reject')}
              onPreparePlan={chat.preparePlan}
              // Suggested answers stay tappable only while the question is the
              // newest message; once anything follows it, they are a record.
              onAnswer={index === chat.messages.length - 1 ? (text, connectionResume) => connectionResume ? chat.send({ text, connectionResume }) : send({ text, attachmentIds: [], attachmentNames: [] }) : undefined}
              traceHref={`/tasks?select=${encodeURIComponent(session.id)}`}
            />
            </Fragment>
          ))}
          <ConversationTasks cards={delegated.cards} tasks={delegated.tasks} messages={chat.messages} onChanged={delegated.refresh} />
          <div ref={bottomRef} />
        </div>
      </div>
      <div className={CHAT_COMPOSER_WRAP}>
        <Composer inputRef={composerRef} sessionId={chat.sessionId.current ?? undefined} busy={chat.busy} mode={chat.composerMode} onModeChange={chat.setComposerMode} activeTaskMode={chat.activeTaskMode} pendingPost={chat.pendingPost} onRetryPending={chat.retryPending} onCancelPending={chat.cancelPending} onSend={send} onStop={chat.stop} onBackground={chat.background} agentSlot={takesAgent ? <><ProjectPicker value={projectChoice.chosen} onChange={projectChoice.choose} started /><AgentPicker value={agentChoice.chosen} onChange={agentChoice.choose} started /></> : undefined} agentId={takesAgent ? agentChoice.chosen?.id ?? null : undefined} applyAgent={takesAgent ? () => agentChoice.prepare(chat.sessionId.current, chat.busy) : undefined} placeholder={agentChoice.chosen ? `Message ${agentChoice.chosen.name}…` : undefined} />
      </div>
    </div>
    </CloudBrowserWorkspace>
  );
}

/** Read-only transcript (workflow / agent runs, or legacy desktop chats). */
function ReadOnlyThread({ session, history }: { session: Session; history: Turn[] }) {
  const messages = historyToMessages(history);
  const marks = agentThreadMarks(messages, session.agentName ?? null);
  const projectMarks = projectThreadMarks(messages, session.projectName ?? null);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header session={session} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={CHAT_THREAD}>
          {messages.length === 0 ? (
            <p className="py-12 text-center text-body text-faint">No messages in this conversation.</p>
          ) : (
            messages.map((m, index) => (
              <Fragment key={m.id}>
                <ConversationChangeLine agent={marks[index]?.switchedTo} project={projectMarks[index]?.movedTo} />
                <ChatBubble message={m} speaker={marks[index]?.speaker ?? undefined} project={projectMarks[index]?.project ?? undefined} sessionId={rawId(session.id)} />
              </Fragment>
            ))
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

  // useChat seeds its local transcript once. A cached partial history must
  // not mount it before this opening's fetch finishes; later refetches keep
  // the live component and its composer intact.
  if (!detail.isError && !sessionHistoryReady(detail)) {
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
