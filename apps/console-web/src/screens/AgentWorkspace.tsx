/**
 * One agent's workspace: its threads on the left, the open thread in the
 * middle, the record and its recent work on the right. A thread here is an
 * ordinary Clem conversation whose starting context was chosen once — the
 * first message of a new thread carries the agent id, and the server binds
 * the session to it from then on.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Plus, Loader2, PanelRightClose, PanelRightOpen, Pencil, Trash2,
  Check, X, Hourglass, ChevronRight, Files, Monitor, Globe, MessagesSquare, type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { Skeleton } from '@/components/ui/Skeleton';
import { Composer, type ComposerSendInput } from '@/components/chat/Composer';
import { ChatBubble } from '@/components/chat/ChatBubble';
import { AgentPicker } from '@/components/chat/AgentPicker';
import { ProjectPicker } from '@/components/chat/ProjectPicker';
import { ConversationChangeLine } from '@/components/chat/ConversationChangeLine';
import { ConversationTasks } from '@/components/chat/ConversationTasks';
import { CloudBrowserWorkspace, useBrowserControl } from '@/components/chat/CloudBrowserDock';
import { ComputerWorkspace, useComputerControl } from '@/components/chat/ComputerDock';
import { FileDockWorkspace, useFileDock } from '@/components/chat/FileDock';
import { agentWorkspaceLayout } from '@/lib/agent-workspace-layout';
import { agentThreadMarks, projectThreadMarks, APPROVAL_ANSWER_WORDS, sameTerminalContinuation } from '@clem/chat-engine';
import { useConversationAgent } from '@/lib/conversation-agent';
import { useConversationProject } from '@/lib/conversation-project';
import { reportOwner, useConversationTasks } from '@/lib/conversation-tasks';
import { RunningTasksDrawer } from '@/components/chat/RunningTasksDrawer';
import { AgentForm } from '@/components/agents/AgentForm';
import { AgentAssignments } from '@/components/agents/AgentAssignments';
import { ScopedFacts } from '@/components/memory/ScopedFacts';
import { chatAnswerInput, chatDecisionIntent, useChat, type ChatMessage } from '@/lib/useChat';
import { decidePlanProposal } from '@/lib/inbox';
import { unifiedChatSessionId } from '@/lib/last-session';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';
import { getRunAgentOutput } from '@/lib/board';
import { isComputerStepLabel } from '@/lib/toolLabels';
import { useConversationSendScope } from '@/lib/use-conversation-send-scope';
import {
  getAgent, getAgentCatalog, getAgentWork, deleteAgent,
  type AgentRecord, type AgentCatalog, type AgentWorker,
} from '@/lib/agents';
import { modelDisplayName, providerLabel } from '@clem/chat-engine';
import { useSessions } from '@/features/conversations/hooks/useSessions';
import { isMissingConversation, useSession } from '@/features/conversations/hooks/useSession';
import { sessionKeys } from '@/features/conversations/hooks/keys';
import { groupSessions } from '@/features/conversations/lib/groupSessions';
import { rawId } from '@/features/conversations/lib/ids';
import { historyHandlingSources, historyToMessages } from '@/features/conversations/chat/conversation-history';
import { CHAT_COMPOSER_WRAP, CHAT_THREAD } from '@/features/conversations/lib/chatColumn';
import type { Session, Turn } from '@/features/conversations/types';

const THREAD_PAGE_SIZE = 200;

function agentPath(id: string): string {
  return `/agents/${encodeURIComponent(id)}`;
}

function threadPath(agentId: string, unifiedSessionId: string): string {
  return `${agentPath(agentId)}/t/${encodeURIComponent(unifiedSessionId)}`;
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function AgentWorkspace() {
  const { id = '', sessionId } = useParams();
  return <AgentWorkspaceForId key={id} id={id} sessionId={sessionId} />;
}

function AgentWorkspaceForId({ id, sessionId }: { id: string; sessionId?: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const agentQ = usePoll(['agents', 'one', id], () => getAgent(id), 15_000, { enabled: !!id });
  const catalogQ = usePoll(['agents', 'catalog'], getAgentCatalog, 30_000);
  const [editing, setEditing] = useState(false);
  const computerScope = JSON.stringify([id, sessionId ?? null]);
  const computerOwner = useRef<string | null>(computerScope);
  useLayoutEffect(() => {
    computerOwner.current = computerScope;
    return () => { if (computerOwner.current === computerScope) computerOwner.current = null; };
  }, [computerScope]);
  const [computerActivity, setComputerActivity] = useState({ scope: computerScope, active: false });
  const reportComputerActive = useCallback((active: boolean) => {
    if (computerOwner.current === computerScope) setComputerActivity({ scope: computerScope, active });
  }, [computerScope]);

  const agent = agentQ.data;

  if (agentQ.isLoading && !agent) {
    return (
      <div className="flex h-full">
        <div className="w-[260px] shrink-0 border-r border-border p-3"><Skeleton className="h-9 w-full" /></div>
        <div className="flex-1" />
      </div>
    );
  }
  if (!agent) {
    return (
      <div className="mx-auto max-w-xl px-6 py-10">
        <QueryUnavailable
          title="This agent could not be opened"
          description="It may have been removed, or Clementine couldn’t reach it just now."
          onRetry={() => { void agentQ.refetch(); }}
        />
        <div className="mt-4 text-center">
          <Link to="/agents" className="text-small text-primary hover:underline">Back to Agents</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {agentQ.isError && <p role="status" className="shrink-0 border-b border-border px-4 py-2 text-small text-warning">Agent details couldn’t refresh. Showing the last loaded version. <button type="button" className="font-semibold underline" onClick={() => void agentQ.refetch()}>Retry</button></p>}
      <CloudBrowserWorkspace conversationId={sessionId ? rawId(sessionId) : undefined} inHeader>
        <ComputerWorkspace conversationId={sessionId ? rawId(sessionId) : undefined} active={computerActivity.scope === computerScope && computerActivity.active}>
          <FileDockWorkspace conversationId={sessionId ? rawId(sessionId) : undefined} inHeader>
            <AgentWorkspacePanes agent={agent} sessionId={sessionId} catalog={catalogQ.data} onComputerActive={reportComputerActive}
              onEdit={() => setEditing(true)} onDeleted={() => {
                void qc.invalidateQueries({ queryKey: ['agents'] }); navigate('/agents', { replace: true });
              }} />
          </FileDockWorkspace>
        </ComputerWorkspace>
      </CloudBrowserWorkspace>
      {editing && (
        <AgentForm
          mode="edit"
          agent={agent}
          catalog={catalogQ.data}
          catalogUnavailable={catalogQ.isError}
          onRetryCatalog={() => void catalogQ.refetch()}
          onClose={() => setEditing(false)}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ['agents'] });
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}

function AgentWorkspacePanes({ agent, sessionId, catalog, onEdit, onDeleted, onComputerActive }: {
  agent: AgentRecord; sessionId?: string; catalog?: AgentCatalog; onEdit: () => void; onDeleted: () => void; onComputerActive: (active: boolean) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const auxiliary = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  const [threadsOpen, setThreadsOpen] = useState(true);
  const [aboutOpen, setAboutOpen] = useState(true);
  const [activePane, setActivePane] = useState<'threads' | 'about' | null>(null);
  const layout = agentWorkspaceLayout(width, threadsOpen, aboutOpen);
  const files = useFileDock()?.filesControl;
  const computer = useComputerControl();
  const browser = useBrowserControl();
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (activePane) auxiliary.current?.focus({ preventScroll: true }); }, [activePane]);
  useEffect(() => { setActivePane(null); }, [sessionId]);
  const closePane = () => {
    setActivePane(null);
    requestAnimationFrame(() => opener.current?.focus({ preventScroll: true }));
  };
  const toggle = (pane: 'threads' | 'about') => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (activePane) { if (activePane === pane) closePane(); else setActivePane(pane); return; }
    if (pane === 'threads' && (layout.inlineThreads || agentWorkspaceLayout(width, true, aboutOpen).inlineThreads)) setThreadsOpen(!threadsOpen);
    else if (pane === 'about' && (layout.inlineAbout || agentWorkspaceLayout(width, threadsOpen, true).inlineAbout)) setAboutOpen(!aboutOpen);
    else setActivePane(pane);
  };
  return <div ref={container} className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
    <header className="flex flex-wrap items-center gap-1 border-b border-border bg-surface px-3 py-2.5">
      {activePane ? <Button size="sm" variant="ghost" onClick={closePane}><ArrowLeft className="h-4 w-4" aria-hidden /> Conversation</Button>
        : <h2 className="min-w-0 flex-1 truncate px-1 text-h3 text-fg">{agent.name}</h2>}
      <div className="ml-auto flex flex-wrap items-center gap-1">
        <Button size="sm" variant="ghost" onClick={() => toggle('threads')} aria-controls="agent-threads" aria-expanded={activePane === 'threads' || (!activePane && layout.inlineThreads)}><MessagesSquare className="h-4 w-4" aria-hidden /> Threads</Button>
        <Button size="sm" variant="ghost" onClick={() => toggle('about')} aria-controls="agent-about" aria-expanded={activePane === 'about' || (!activePane && layout.inlineAbout)}><PanelRightOpen className="h-4 w-4" aria-hidden /> About</Button>
        {files ? <Button size="sm" variant="ghost" onClick={files.toggle} aria-expanded={files.open} aria-label={files.open ? 'Close files from this chat' : 'Open files from this chat'}><Files className="h-4 w-4" aria-hidden /> Files{files.count > 0 ? <span className="text-faint">{files.count}</span> : null}</Button> : null}
        {computer ? <Button size="sm" variant="ghost" onClick={computer.toggle} aria-expanded={computer.open} aria-label={computer.open ? 'Close computer view' : 'Watch your connected computer'}><Monitor className="h-4 w-4" aria-hidden /> Computer</Button> : null}
        {browser ? <Button size="sm" variant="ghost" onClick={browser.toggle} aria-expanded={browser.open}><Globe className="h-4 w-4" aria-hidden /> {browser.label}{browser.status ? <span className="text-faint">· {browser.status}</span> : null}</Button> : null}
      </div>
    </header>
    {activePane ? <div ref={auxiliary} tabIndex={-1} className="flex min-h-0 flex-1 outline-none" aria-label={activePane === 'threads' ? `${agent.name} threads` : `About ${agent.name}`} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closePane(); } }}>
      {activePane === 'threads' ? <ThreadRail agent={agent} activeSessionId={sessionId} fullWidth onChoose={closePane} /> : <AgentPanel agent={agent} catalog={catalog} fullWidth onCollapse={closePane} onEdit={onEdit} onDeleted={onDeleted} />}
    </div> : null}
    {/* Secondary views never unmount the thread, its stream, or its draft. */}
    <div className={activePane ? 'hidden' : 'flex min-h-0 min-w-0 flex-1'}>
      {!activePane && layout.inlineThreads ? <ThreadRail agent={agent} activeSessionId={sessionId} /> : null}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={`Conversation with ${agent.name}`}><AgentThread key={sessionId ?? 'new'} agent={agent} sessionId={sessionId} onComputerActive={onComputerActive} /></section>
      {!activePane && layout.inlineAbout ? <AgentPanel agent={agent} catalog={catalog} onCollapse={() => setAboutOpen(false)} onEdit={onEdit} onDeleted={onDeleted} /> : null}
    </div>
  </div>;
}

// ─── Left rail: this agent's threads ───

function ThreadRail({ agent, activeSessionId, fullWidth = false, onChoose }: { agent: AgentRecord; activeSessionId?: string; fullWidth?: boolean; onChoose?: () => void }) {
  const navigate = useNavigate();
  const threads = useSessions({ agent: agent.id, limit: THREAD_PAGE_SIZE }, 'chats');
  const sessions = threads.data?.sessions ?? [];
  const handedOff = handedOffWork(usePoll(['agents', 'work', agent.id], () => getAgentWork(agent.id), 10_000).data?.workers ?? []);
  const groups = useMemo(() => groupSessions(sessions, Date.now()), [sessions]);

  return (
    <aside id="agent-threads" aria-label={`${agent.name} threads`} className={cn('flex min-h-0 shrink-0 flex-col border-r border-border bg-surface', fullWidth ? 'w-full' : 'w-[260px]')}>
      <div className="space-y-2 border-b border-border p-3">
        <Link to="/agents" className="inline-flex items-center gap-1 text-caption font-semibold text-muted hover:text-fg">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Agents
        </Link>
        <Button className="w-full" onClick={() => { onChoose?.(); navigate(agentPath(agent.id), { state: { newThread: Date.now() } }); }}>
          <Plus className="h-4 w-4" /> New thread
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {threads.isError && threads.data && <p role="status" className="px-2 py-2 text-caption text-warning">Threads couldn’t refresh. Showing the last loaded list. <button type="button" className="font-semibold underline" onClick={() => void threads.refetch()}>Retry</button></p>}
        {threads.isLoading && sessions.length === 0 ? (
          <div className="space-y-2 p-1">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}
          </div>
        ) : threads.isError && !threads.data ? (
          <QueryUnavailable title="Threads couldn’t load" description="Try loading this agent’s existing conversations again." onRetry={() => void threads.refetch()} />
        ) : sessions.length === 0 ? (
          <p className="px-2 py-6 text-center text-caption text-muted">
            {handedOff.length > 0
              ? `No threads with you yet. Clem has handed ${agent.name} ${handedOff.length === 1 ? 'one task' : `${handedOff.length} tasks`}; they are under Work in About.`
              : 'No threads yet. Your first message starts one.'}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="mb-3">
              <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">{group.label}</div>
              <ul className="space-y-0.5">
                {group.items.map((s) => (
                  <li key={s.id}>
                    <NavLink
                      to={threadPath(agent.id, s.id)}
                      onClick={onChoose}
                      className={cn(
                        'block rounded-md px-2.5 py-2 transition-colors',
                        s.id === activeSessionId ? 'bg-primary-tint' : 'hover:bg-hover',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-small font-semibold text-fg">{s.title || 'New thread'}</span>
                        <span className="shrink-0 text-caption text-faint">{relativeTime(s.updatedAt)}</span>
                      </div>
                      {s.preview && <p className="mt-0.5 truncate text-caption text-muted">{s.preview}</p>}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

// ─── Center: the thread ───

function AgentThread({ agent, sessionId, onComputerActive }: { agent: AgentRecord; sessionId?: string; onComputerActive: (active: boolean) => void }) {
  if (!sessionId) return <FreshThread agent={agent} onComputerActive={onComputerActive} />;
  return <ExistingThread agent={agent} sessionId={sessionId} onComputerActive={onComputerActive} />;
}

export function ExistingThread({ agent, sessionId, onComputerActive }: { agent: AgentRecord; sessionId: string; onComputerActive?: (active: boolean) => void }) {
  const detail = useSession(sessionId);
  if (detail.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (!detail.data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-muted">
        <p>{isMissingConversation(detail.error) ? 'This thread could not be found.' : 'This thread couldn’t load right now.'}</p>
        <Button size="sm" variant="secondary" onClick={() => void detail.refetch()}>Retry</Button>
        <Link to={agentPath(agent.id)} className="text-small text-primary hover:underline">Start a new thread</Link>
      </div>
    );
  }
  const { session, turns } = detail.data;
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    {detail.isError && <p role="status" className="shrink-0 border-b border-border px-4 py-2 text-small text-warning">This thread couldn’t refresh. Your conversation and draft are still here. <button type="button" className="font-semibold underline" onClick={() => void detail.refetch()}>Retry</button></p>}
    <BoundThread key={session.id} agent={agent} session={session} history={turns} onComputerActive={onComputerActive} />
  </div>;
}

/** A reopened thread: hydrated from history, reattached if a turn is running. */
function BoundThread({ agent, session, history, onComputerActive }: { agent: AgentRecord; session: Session; history: Turn[]; onComputerActive?: (active: boolean) => void }) {
  const retainedHistorySources = useMemo(() => historyHandlingSources(history), [history]);
  const chat = useChat({
    initialSessionId: session.executionSessionId ?? rawId(session.id),
    conversationSessionId: rawId(session.id),
    initialMessages: historyToMessages(history),
    reattachActiveRun: true,
  });
  return (
    <ThreadBody
      agent={agent}
      chat={chat}
      sessionId={session.id}
      retainedHistorySources={retainedHistorySources}
      onComputerActive={onComputerActive}
      project={session.projectId && session.projectName ? { id: session.projectId, name: session.projectName } : null}
    />
  );
}

/** A thread that does not exist yet: the first send carries the agent id,
 *  then the URL moves to the session the server minted. */
function FreshThread({ agent, onComputerActive }: { agent: AgentRecord; onComputerActive?: (active: boolean) => void }) {
  const chat = useChat();
  return <ThreadBody agent={agent} chat={chat} onComputerActive={onComputerActive} />;
}

type ChatHandle = ReturnType<typeof useChat>;

function ThreadBody({ agent, chat, sessionId, project = null, retainedHistorySources, onComputerActive }: {
  agent: AgentRecord;
  chat: ChatHandle;
  sessionId?: string;
  /** The project the thread works in when it was opened. */
  project?: { id: string; name: string } | null;
  retainedHistorySources?: ReturnType<typeof historyHandlingSources>;
  onComputerActive?: (active: boolean) => void;
}) {
  const computerActive = chat.busy && Boolean(chat.messages.at(-1)?.activity?.some(row => row.kind === 'tool' && isComputerStepLabel(row.label)));
  useEffect(() => { onComputerActive?.(computerActive); return () => onComputerActive?.(false); }, [onComputerActive, computerActive]);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const captureSendScope = useConversationSendScope(`${location.key}:${agent.id}:${sessionId ?? 'new'}`, chat.sessionId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);
  const fresh = !sessionId;
  // This page is the agent: every message sent from it goes to this agent,
  // including in a thread that was switched to another one elsewhere.
  const agentChoice = useConversationAgent({ id: agent.id, name: agent.name });
  const marks = agentThreadMarks(chat.messages, agent.name);
  const projectChoice = useConversationProject(project, {
    onMoved: () => { void qc.invalidateQueries({ queryKey: sessionKeys.all }); },
  });
  const projectMarks = projectThreadMarks(chat.messages, project?.name ?? null);
  const delegated = useConversationTasks(chat.sessionId.current, chat.delegatedTaskTick);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    if (!stickRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: chat.busy ? 'auto' : 'smooth', block: 'end' });
  }, [chat.messages, chat.busy]);

  // "New thread" while already on the fresh screen: clear what was typed.
  const resetChat = chat.reset;
  const lastStampRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const stamp = (location.state as { newThread?: number } | null)?.newThread;
    if (fresh && stamp && stamp !== lastStampRef.current) {
      lastStampRef.current = stamp;
      resetChat();
      stickRef.current = true;
    }
  }, [location.state, fresh, resetChat]);

  const continuationState = useRef({ busy: chat.busy, latest: chat.messages.at(-1), pending: chat.pendingPost });
  continuationState.current = { busy: chat.busy, latest: chat.messages.at(-1), pending: chat.pendingPost };
  const renderedSessionId = chat.sessionId.current;
  const continuePaused = (message: ChatMessage) => {
    const assertCurrent = () => {
      const current = continuationState.current;
      if (!renderedSessionId || chat.sessionId.current !== renderedSessionId || current.busy || current.pending
        || !sameTerminalContinuation(message, current.latest)) {
        throw new Error('This pause has changed. Check the latest reply before continuing.');
      }
    };
    return send({ text: 'continue', attachmentIds: [], attachmentNames: [], taskMode: message.taskMode, onAccepted: () => {} }, assertCurrent);
  };
  const send = async (input: ComposerSendInput, assertCurrent: () => void = () => {}) => {
    assertCurrent();
    const scope = captureSendScope();
    const [addressed, placed] = await Promise.all([
      agentChoice.prepare(chat.sessionId.current, chat.busy),
      projectChoice.prepare(chat.sessionId.current, chat.busy),
    ]);
    scope.assertCurrent();
    assertCurrent();
    await chat.send({ ...input, ...addressed, ...placed });
    qc.invalidateQueries({ queryKey: sessionKeys.lists() });
    // The server minted the session on that first send; from here the thread
    // is addressable, so the URL says which one it is.
    const minted = chat.sessionId.current;
    if (fresh && minted && scope.isCurrentRoute()) navigate(threadPath(agent.id, unifiedChatSessionId(minted)), { replace: true });
  };

  const resolveDecision = async (message: ChatMessage, decision: 'approve' | 'reject') => {
    const intent = chatDecisionIntent(message, decision);
    if (intent.kind === 'invalid-plan') throw new Error(intent.message);
    if (intent.kind === 'approval-reply') {
      // An answer to a waiting card resumes that reply as it started.
      await chat.send({ text: intent.text, displayText: APPROVAL_ANSWER_WORDS[decision], attachmentIds: [], attachmentNames: [] });
      return;
    }
    await decidePlanProposal(intent.planProposalId, intent.decision);
    await Promise.all([
      sessionId ? qc.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) }) : Promise.resolve(),
      qc.invalidateQueries({ queryKey: sessionKeys.lists() }),
      qc.invalidateQueries({ queryKey: ['command-center'] }),
      qc.invalidateQueries({ queryKey: ['plan-proposals'] }),
    ]);
  };

  const traceHref = chat.sessionId.current ? `/tasks?select=${encodeURIComponent(chat.sessionId.current)}` : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className={CHAT_THREAD}>
          {chat.messages.length === 0 && (
            <div className="rounded-lg border border-border bg-surface p-4">
              <p className="text-small font-semibold text-fg">A new thread with {agent.name}</p>
              <p className="mt-1 text-small text-muted">
                {agent.handles || 'Anything you would ask Clem, with this agent’s standing instructions already in place.'}
              </p>
            </div>
          )}
          {chat.messages.map((m, index) => (
            <Fragment key={m.id}>
            <ConversationChangeLine agent={marks[index]?.switchedTo} project={projectMarks[index]?.movedTo} />
            <ChatBubble
              message={m}
              speaker={reportOwner(m, delegated.tasks) ?? marks[index]?.speaker ?? undefined}
              project={projectMarks[index]?.project ?? undefined}
              ownedTaskIds={delegated.ownedIds}
              sessionId={chat.sessionId.current ?? undefined}
              retainedHistorySources={retainedHistorySources}
              executionBusy={chat.busy}
              onExecutePlan={chat.executePlan}
              onPreparePlan={chat.preparePlan}
              onRevisePlan={() => { chat.setComposerMode('plan'); composerRef.current?.focus(); }}
              onApprove={() => resolveDecision(m, 'approve')}
              onApproveWithEdits={(fields) => chat.approveWithEdits(m, fields)}
              onReject={() => resolveDecision(m, 'reject')}
              onBackground={chat.background}
              onSendHeld={chat.sendHeld}
              onAnswer={index === chat.messages.length - 1 ? (text, connectionResume) => connectionResume ? chat.send({ text, connectionResume }) : send(chatAnswerInput(m, text)) : undefined}
              onContinue={index === chat.messages.length - 1 && !chat.busy && !chat.pendingPost ? () => continuePaused(m) : undefined}
              traceHref={traceHref}
            />
            </Fragment>
          ))}
          <ConversationTasks conversationId={chat.sessionId.current ?? undefined} cards={delegated.cards} tasks={delegated.tasks} messages={chat.messages} onChanged={delegated.refresh} />
          <div ref={bottomRef} />
        </div>
      </div>
      <div className={CHAT_COMPOSER_WRAP}>
        <RunningTasksDrawer className="mb-1" composerRef={composerRef} />
        <Composer
          inputRef={composerRef}
          sessionId={chat.sessionId.current ?? undefined} draftSessionId={chat.conversationSessionId.current}
          busy={chat.busy}
          mode={chat.composerMode}
          onModeChange={chat.setComposerMode}
          activeTaskMode={chat.activeTaskMode}
          pendingPost={chat.pendingPost}
          onRetryPending={chat.retryPending}
          onCancelPending={chat.cancelPending}
          onSend={send}
          onStop={chat.stop}
          onBackground={chat.background}
          placeholder={`Message ${agent.name}…`}
          agentSlot={<><ProjectPicker value={projectChoice.chosen} onChange={projectChoice.choose} started={!fresh} /><AgentPicker bound={agent.name} /></>}
          agentId={agent.id}
          applyAgent={() => agentChoice.prepare(chat.sessionId.current, chat.busy)}
        />
      </div>
    </div>
  );
}

// ─── Right panel: the record and its recent work ───

function AgentPanel({
  agent,
  catalog,
  onCollapse,
  onEdit,
  onDeleted,
  fullWidth = false,
}: {
  agent: AgentRecord;
  catalog?: AgentCatalog;
  onCollapse: () => void;
  onEdit: () => void;
  onDeleted: () => void;
  fullWidth?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const model = agent.model ? (catalog?.models?.find((m) => m.id === agent.model)?.label ?? modelDisplayName(agent.model)) : null;
  const reaches = agent.skills.length + agent.workflows.length > 0;

  const remove = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteAgent(agent.id);
      onDeleted();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  };

  return (
    <aside id="agent-about" aria-label={`About ${agent.name}`} className={cn('flex min-h-0 shrink-0 flex-col border-l border-border bg-subtle', fullWidth ? 'w-full' : 'w-[320px]')}>
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-small font-semibold text-fg">About</span>
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
        </Button>
        <Button variant="ghost" size="icon" aria-label="Hide the agent's details" onClick={onCollapse}>
          <PanelRightClose className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <section>
          <p className="text-small text-fg">{agent.handles || 'No description yet.'}</p>
          {agent.instructions && (
            <div className="mt-2">
              <div className="text-caption font-semibold text-faint">Standing instructions</div>
              <p className={cn('mt-1 whitespace-pre-wrap text-small text-muted', !showAll && 'line-clamp-4')}>{agent.instructions}</p>
              {agent.instructions.length > 240 && (
                <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-1 text-caption text-primary hover:underline">
                  {showAll ? 'Less' : 'More'}
                </button>
              )}
            </div>
          )}
        </section>

        <AgentAssignments agent={agent} />

        <section>
          <div className="text-caption font-semibold text-faint">What it has learned</div>
          <p className="mb-1.5 mt-0.5 text-caption text-muted">Kept for this agent, in any project it works in.</p>
          <ScopedFacts
            filter={{ kind: 'agent', agentId: agent.id }}
            limit={5}
            compact
            empty="Nothing kept for this agent yet."
            unavailableTitle="What it has learned is unavailable"
          />
        </section>

        <section>
          <div className="text-caption font-semibold text-faint">Reaches for first</div>
          {reaches ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {agent.skills.map((s) => <span key={`s-${s}`} className="rounded-full bg-info-tint px-2 py-0.5 text-caption text-info">{s}</span>)}
              {agent.workflows.map((w) => <span key={`w-${w}`} className="rounded-full bg-success-tint px-2 py-0.5 text-caption text-success">{w}</span>)}
            </div>
          ) : (
            <p className="mt-1 text-caption text-muted">Nothing pinned — it picks the way Clem would.</p>
          )}
        </section>

        {agent.tools.length > 0 && (
          <section>
            <div className="text-caption font-semibold text-faint">Tools</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {agent.tools.map((t) => <span key={t} className="rounded-full bg-subtle px-2 py-0.5 text-caption text-muted ring-1 ring-border">{t}</span>)}
            </div>
          </section>
        )}

        <section>
          <div className="text-caption font-semibold text-faint">Model</div>
          <p className="mt-1 text-small text-fg">{model ?? 'Follows the brain'}</p>
        </section>

        <RecentWork agent={agent} />

        <section className="border-t border-border pt-4">
          {confirming ? (
            <div className="rounded-md border border-danger/30 bg-danger-tint p-3">
              <p className="text-small text-fg">Delete {agent.name}? Its threads stay in Chat.</p>
              {deleteError && <p className="mt-1 text-caption text-danger" role="alert">{deleteError}</p>}
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => setConfirming(false)} disabled={deleting}>Keep</Button>
                <Button variant="danger" size="sm" onClick={remove} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete'}</Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" size="sm" className="text-danger hover:text-danger" onClick={() => setConfirming(true)}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete agent
            </Button>
          )}
        </section>
      </div>
    </aside>
  );
}

const STATUS: Record<AgentWorker['status'], { Icon: LucideIcon; className: string; title: string }> = {
  ok: { Icon: Check, className: 'text-success', title: 'Completed' },
  error: { Icon: X, className: 'text-danger', title: 'Failed' },
  capped: { Icon: Hourglass, className: 'text-warning', title: 'Hit its turn cap' },
};

/** Work Clem handed this agent from one of her own chats. */
function handedOffWork(workers: readonly AgentWorker[]): AgentWorker[] {
  return workers.filter((w) => w.parentKind === 'session' && Boolean(w.parentRunId));
}

function workerLabel(w: AgentWorker): string {
  if (w.role && w.role !== w.task) return `${w.role}: ${w.task}`;
  return w.task;
}

/** Workers that ran as this agent: tasks Clem handed it from one of her
 *  chats (linked back to that chat) or from an automation run — the same row
 *  the board's agents panel draws. Each ends when its task does. The tasks the
 *  agent itself owned are listed above (AgentAssignments). The full
 *  work-product is fetched on open when the run is addressable; otherwise the
 *  stored preview stands in. */
function RecentWork({ agent }: { agent: AgentRecord }) {
  const work = usePoll(['agents', 'work', agent.id], () => getAgentWork(agent.id), 10_000);
  const workers = work.data?.workers ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  const toggle = (w: AgentWorker) => setOpenId(current => current === w.id ? null : w.id);

  return (
    <section>
      <div className="text-caption font-semibold text-faint">Work</div>
      <p className="mt-0.5 text-caption text-muted">
        What this agent did: tasks Clem handed it from a chat or an automation. Each one ends when its task does.
      </p>
      {work.isError && <p role="status" className="mt-2 text-caption text-warning">{work.data ? 'Work couldn’t refresh. Showing the last loaded list.' : 'Work couldn’t load.'} <button type="button" className="font-semibold underline" onClick={() => void work.refetch()}>Retry</button></p>}
      {workers.length === 0 ? (
        <p className="mt-1 text-caption text-muted">
          {work.isLoading ? 'Looking…' : work.isError ? 'Try loading this agent’s work again.' : 'None yet.'}
        </p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {workers.map((w) => {
            const st = STATUS[w.status] ?? STATUS.ok;
            const isOpen = openId === w.id;
            return (
              <li key={w.id} className="rounded-lg border border-border/60 bg-surface">
                <button type="button" onClick={() => toggle(w)} aria-expanded={isOpen} className="flex w-full items-center gap-2 px-2.5 py-2 text-left">
                  <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-faint transition-transform', isOpen && 'rotate-90')} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-small text-fg">{workerLabel(w)}</span>
                    <span className="block truncate text-caption text-faint">
                      {providerLabel(w.provider)}{w.model ? ` · ${modelDisplayName(w.model)}` : ''}{w.finishedAt ? ` · ${relativeTime(w.finishedAt)}` : ''}
                    </span>
                  </span>
                  <st.Icon className={cn('h-4 w-4 shrink-0', st.className)} aria-label={st.title} />
                </button>
                {isOpen && (
                  <div className="border-t border-border/60 px-2.5 py-2">
                    <HelperOutput worker={w} />
                    {w.parentKind === 'session' && w.parentRunId ? (
                      <Link to={`/chat/${encodeURIComponent(unifiedChatSessionId(w.parentRunId))}`} className="mt-2 inline-block text-caption font-semibold text-primary hover:underline">
                        Open the chat Clem handed this from
                      </Link>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Query identity includes the producing run; a retry never borrows another helper’s output. */
export function HelperOutput({ worker }: { worker: AgentWorker }) {
  const addressable = Boolean(worker.outputRef && worker.workflowName && worker.parentRunId);
  const result = usePoll(['agents', 'helper-output', worker.workflowName, worker.parentRunId, worker.id, worker.outputRef],
    () => getRunAgentOutput(worker.workflowName!, worker.parentRunId!, worker.id), 0, { enabled: addressable });
  return <>
    <p className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words text-caption text-muted">{result.data?.output ?? (addressable && result.isLoading ? 'Loading full output…' : worker.outputPreview || (addressable ? 'Full output is unavailable.' : 'No output recorded.'))}</p>
    {result.isError && <p role="status" className="mt-2 text-caption text-warning">The full output couldn’t load. {worker.outputPreview ? 'The saved preview is shown above. ' : ''}<button type="button" className="font-semibold underline" onClick={() => void result.refetch()}>Retry</button></p>}
  </>;
}
