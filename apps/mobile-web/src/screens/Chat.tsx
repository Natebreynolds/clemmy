/**
 * The chat screen, rebuilt on the shared chat engine (@clem/chat-engine —
 * the same transport/presentation core the desktop console is converging on).
 *
 * What the engine buys this screen over the old hand-rolled version:
 *  - The stream survives reality: fresh single-use ticket per attempt,
 *    poll-first recovery, resume on webview wake, late-completion watch.
 *    (The old screen lost any reply that finished while the phone was
 *    locked — one SSE, no error handler, no recovery.)
 *  - Live token streaming and desktop-grade activity narration.
 *  - Markdown replies (sanitized by construction — input is escaped before
 *    any markup is added).
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  ChatEngine,
  createPendingMessageStore,
  type ComposerMode,
  type PlanRevisionRef,
  liveActivityHeadline,
  narrateActivity,
  renderMarkdown,
  type ActivityItem,
  type ChatMessage,
  type EngineSnapshot,
} from '@clem/chat-engine';
import {
  approvePlanProposal,
  cancelActiveChat,
  cancelChatRequest,
  createChatStreamTransport,
  freshIdempotencyKey,
  getChatSession,
  rejectPlanProposal,
  sendChatMessageAsync,
} from '../lib/api';
import { REFRESH_EVENT, haptic } from '../lib/native-bridge';
import { chatApprovalDecided, chatApprovalReply } from '../lib/chat-approval';
import { getModelSettings } from '../lib/api';
import { BrainSheet } from '../components/BrainSheet';
import { PlanReview } from '../components/PlanReview';
import { RunControl, delegatedRunControlForExpandedWork } from '../components/RunControl';

interface Props {
  sessionId?: string;
  initialTitle?: string;
  /** Text typed on Home's ask bar, waiting in the composer on arrival. */
  initialDraft?: string;
  /** Only Home's explicit Send handoff uses this; response/edit handoffs stay editable. */
  initialAutoSend?: boolean;
  onBack: () => void;
}

export function Chat({ sessionId: initialSessionId, initialTitle, initialDraft, initialAutoSend, onBack }: Props) {
  const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
  const [title, setTitle] = useState(initialTitle ?? '');
  const [draft, setDraft] = useState(initialDraft ?? '');
  const [composerMode, setComposerMode] = useState<ComposerMode>('normal');
  const [planActing, setPlanActing] = useState<string | null>(null);
  const [approvalActing, setApprovalActing] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [planOutcome, setPlanOutcome] = useState<Record<string, 'approved' | 'rejected' | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  // §6a: a compact brain chip in the chat header — the same live catalog
  // sheet as Settings > Brain, mounted where the switch is most often wanted.
  const [brainLabel, setBrainLabel] = useState('');
  const [brainOpen, setBrainOpen] = useState(false);
  const loadBrain = () => {
    void getModelSettings()
      .then((data) => {
        const current = data.options.find((option) => option.value === data.effectiveValue);
        setBrainLabel(current?.label ?? data.brain.modelId);
      })
      .catch(() => setBrainLabel(''));
  };
  useEffect(loadBrain, []);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const autoSent = useRef(false);

  const engine = useMemo(() => new ChatEngine({
    transport: createChatStreamTransport(),
    sessionId: initialSessionId ?? null,
    pendingStore: createPendingMessageStore(localStorage, `clem.pending.mobile:${initialSessionId ?? 'new'}`),
    api: {
      send: async ({ message, sessionId, idempotencyKey, steerOnly, taskMode }) => {
        const result = await sendChatMessageAsync({ message, sessionId, idempotencyKey, steerOnly, taskMode });
        return { sessionId: result.sessionId, accepted: result.accepted, steered: result.steered };
      },
      loadSession: async (sessionId) => {
        try {
          const result = await getChatSession(sessionId);
          setTitle(result.session.title);
          return { events: result.events, latestSeq: result.latestSeq };
        } catch (err) {
          // Workspace threads use a STABLE session id (space-<slug>) that may
          // not exist until the first message — an empty thread, not an error.
          if ((err as { status?: number }).status === 404 && /^space-/.test(sessionId)) {
            return { events: [], latestSeq: 0 };
          }
          throw err;
        }
      },
    },
    newIdempotencyKey: freshIdempotencyKey,
  }), [initialSessionId]);

  useEffect(() => {
    const unsubscribe = engine.subscribe(setSnapshot);
    if (initialSessionId) {
      engine.open().catch((err) => setError((err as Error).message ?? 'Failed to load transcript'));
    }
    // Recovery triggers: the webview waking up (screen unlock, app switch
    // back), the network returning, and the shell's pull-to-refresh. Each is
    // cheap and idempotent — the engine polls a cursor catch-up and only
    // reconnects when the stream is actually gone.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') engine.resume();
    };
    const onWake = (): void => engine.resume();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onWake);
    window.addEventListener('online', onWake);
    window.addEventListener(REFRESH_EVENT, onWake);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onWake);
      window.removeEventListener('online', onWake);
      window.removeEventListener(REFRESH_EVENT, onWake);
      unsubscribe();
      engine.dispose();
    };
  }, [engine]);

  useEffect(() => {
    const text = initialDraft?.trim();
    if (!initialAutoSend || !text || autoSent.current) return;
    autoSent.current = true;
    setDraft('');
    haptic('light');
    void engine.send(text, busy ? snapshot?.activeTaskMode : { version: 1, kind: composerMode })
      .catch(error => setError(error instanceof Error ? error.message : 'Could not send.'));
  }, [engine, initialAutoSend, initialDraft]);

  const messages = snapshot?.messages ?? [];
  const busy = snapshot?.busy ?? false;
  const planning = busy ? snapshot?.activeTaskMode?.kind === 'plan' : composerMode === 'plan';
  const executing = busy && snapshot?.activeTaskMode?.kind === 'execute';
  const connection = snapshot?.connection ?? 'idle';
  // Present only while this client owns the in-flight turn. A turn adopted
  // from another surface has no key here, so the button stays a plain busy
  // indicator rather than a control that would silently do nothing.
  const cancelKey = snapshot?.cancelKey ?? null;
  const canStop = busy && Boolean(snapshot?.sessionId);
  const followingTail = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  useEffect(() => { if (!busy) setStopping(false); }, [busy]);

  function stopTurn() {
    const key = cancelKey;
    const session = snapshot?.sessionId;
    if (!session || stopping) return;
    setStopping(true);
    haptic('light');
    const stop = key
      ? cancelChatRequest(session, key)
      : cancelActiveChat(session);
    void stop.catch((err) => {
      // Leaving `stopping` latched would strand the only control the user
      // has; the turn is still running, so hand the button back.
      setStopping(false);
      setError(err instanceof Error ? err.message : 'Could not stop this turn');
    });
  }

  useEffect(() => {
    const transcript = scrollRef.current;
    if (!transcript) return;
    if (followingTail.current) {
      transcript.scrollTop = transcript.scrollHeight;
      setShowJumpToLatest(false);
    } else {
      setShowJumpToLatest(true);
    }
  }, [messages]);

  function updateTailState() {
    const transcript = scrollRef.current;
    if (!transcript) return;
    const nearTail = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 72;
    followingTail.current = nearTail;
    if (nearTail) setShowJumpToLatest(false);
  }

  function jumpToLatest() {
    const transcript = scrollRef.current;
    if (!transcript) return;
    followingTail.current = true;
    transcript.scrollTo({
      top: transcript.scrollHeight,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
    setShowJumpToLatest(false);
    haptic('light');
  }

  function autoresize(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }

  function submitDraft() {
    const text = draft.trim();
    if (!text || executing) return;
    setDraft('');
    if (textareaRef.current) {
      textareaRef.current.value = '';
      autoresize(textareaRef.current);
    }
    haptic('light');
    void engine.send(text, busy ? snapshot?.activeTaskMode : { version: 1, kind: composerMode })
      .catch(error => setError(error instanceof Error ? error.message : 'Could not send.'));
  }

  async function actOnPlan(planProposalId: string, action: 'approve' | 'reject') {
    if (planActing) return;
    setPlanActing(planProposalId);
    setError(null);
    try {
      if (action === 'approve') await approvePlanProposal(planProposalId);
      else await rejectPlanProposal(planProposalId);
      setPlanOutcome((prev) => ({ ...prev, [planProposalId]: action === 'approve' ? 'approved' : 'rejected' }));
      haptic(action === 'approve' ? 'success' : 'warning');
    } catch (err) {
      setError((err as Error).message ?? `Failed to ${action} plan`);
    } finally {
      setPlanActing(null);
    }
  }

  /**
   * Decide a tool approval from inside the transcript.
   *
   * Sent as ordinary chat text, not through the approval endpoint:
   * `approval_requested` is TERMINAL for the stream, and only engine.send()
   * re-attaches it. Resolving via the endpoint would leave the transcript
   * frozen, so the tap would look like it did nothing.
   *
   * No catch — engine.send() does not reject; a failed post marks the user row
   * failed and the existing retry/discard affordance takes over.
   */
  async function actOnApproval(approvalId: string, decision: 'approve' | 'reject') {
    const reply = chatApprovalReply(decision, approvalId);
    if (!reply || approvalActing) return;
    setApprovalActing(approvalId);
    setError(null);
    haptic(decision === 'approve' ? 'success' : 'warning');
    try {
      await engine.send(reply);
    } finally {
      setApprovalActing(null);
    }
  }

  return (
    <div class="chat-shell">
      <div class="chat-header">
        <button class="chat-back" onClick={onBack} aria-label="Back">←</button>
        <h2 class="chat-title">{title || (snapshot?.sessionId ? 'Conversation' : 'New chat')}</h2>
        {brainLabel ? (
          <button
            type="button"
            class="brain-chip"
            title="Brain — who answers your next message"
            onClick={() => { haptic('light'); setBrainOpen(true); }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 3a4 4 0 0 0-4 4 4 4 0 0 0-3 6.5 4 4 0 0 0 3 6.5h.5" /><path d="M12 3a4 4 0 0 1 4 4 4 4 0 0 1 3 6.5 4 4 0 0 1-3 6.5h-.5" /><path d="M12 3v17" />
            </svg>
            <span class="truncate">{brainLabel}</span>
          </button>
        ) : null}
        {/* This sheet lives in a conversation, so it passes the session id: the
            daemon re-pins THIS conversation and the switch truly applies to its
            next message (Settings mounts the same sheet with no session). */}
        <BrainSheet
          open={brainOpen}
          onClose={() => setBrainOpen(false)}
          onChanged={loadBrain}
          sessionId={snapshot?.sessionId ?? initialSessionId ?? undefined}
        />
        {connection === 'recovering' || connection === 'connecting' ? (
          <div class="conn-pill conn-recovering">reconnecting…</div>
        ) : connection === 'detached' ? (
          <div class="conn-pill conn-detached">catching up in the background</div>
        ) : null}
      </div>
      <div
        class="chat-transcript"
        ref={scrollRef}
        role="log"
        aria-live="off"
        aria-label="Conversation"
        onScroll={updateTailState}
      >
        {error ? <div class="global-error">{error}</div> : null}
        {messages.length === 0 ? (
          <div class="inbox-empty">
            {initialSessionId && !snapshot ? 'Loading…' : snapshot?.sessionId ? 'Empty session.' : 'Type a message to start a new chat.'}
          </div>
        ) : null}
        {messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            sessionId={snapshot?.sessionId ?? undefined}
            busy={busy}
            onExecutePlan={ref => engine.send(`Execute the reviewed plan, revision ${ref.revision}.`, { version: 1, kind: 'execute', executeRef: ref })}
            onRevisePlan={() => { setComposerMode('plan'); textareaRef.current?.focus(); }}
            planActing={planActing}
            planOutcome={planOutcome}
            onPlanAction={actOnPlan}
            approvalActing={approvalActing}
            approvalDecided={chatApprovalDecided(messages, message.approval?.approvalId)}
            onApprovalAction={actOnApproval}
            onRetry={(id) => void engine.retry(id)}
            onDiscard={(id) => engine.discard(id)}
            onDelegatedStateChange={(sourceUserSeq, state) => {
              engine.setDelegatedWorkState(sourceUserSeq, state);
            }}
            onDelegatedChanged={() => engine.resume()}
          />
        ))}
      </div>
      {showJumpToLatest ? (
        <button type="button" class="chat-jump" onClick={jumpToLatest}>Jump to latest</button>
      ) : null}
      <div class="chat-mode-bar">
        <button type="button" aria-pressed={planning} disabled={busy}
          onClick={() => setComposerMode(mode => mode === 'plan' ? 'normal' : 'plan')}>Plan</button>
        <span>{executing ? 'Executing the reviewed plan' : busy && snapshot?.activeTaskMode?.kind === 'plan'
          ? 'Planning · investigating with read-only tools'
          : composerMode === 'plan' ? 'Plan mode · review before Execute' : 'Normal · handle the task'}</span>
      </div>
      <form class="chat-composer" onSubmit={(ev) => { ev.preventDefault(); submitDraft(); }}>
        <textarea
          ref={textareaRef}
          class="chat-input"
          rows={1}
          aria-label="Message Clem"
          placeholder={planning ? 'What should we plan?' : 'Message Clem…'}
          value={draft}
          onInput={(ev) => {
            const el = ev.currentTarget as HTMLTextAreaElement;
            setDraft(el.value);
            autoresize(el);
          }}
          onKeyDown={(ev) => {
            if (ev.isComposing) return;
            if (ev.key === 'Enter' && !ev.shiftKey) {
              ev.preventDefault();
              submitDraft();
            }
          }}
        />
        {canStop ? (
          <>
            <button
              class="chat-send"
              type="submit"
              disabled={executing || draft.trim().length === 0}
              aria-label="Send while she works"
            >
              ↑
            </button>
            <button
              class="chat-send chat-stop"
              type="button"
              onClick={stopTurn}
              disabled={stopping}
              aria-label="Stop"
            >
              {stopping ? '…' : '■'}
            </button>
          </>
        ) : (
          <button
            class="chat-send"
            type="submit"
            disabled={executing || draft.trim().length === 0}
            aria-label="Send"
          >
            ↑
          </button>
        )}
      </form>
    </div>
  );
}

function MessageRow({
  message, sessionId, busy, onExecutePlan, onRevisePlan, planActing, planOutcome, onPlanAction, onRetry, onDiscard,
  approvalActing, approvalDecided, onApprovalAction,
  onDelegatedStateChange, onDelegatedChanged,
}: {
  message: ChatMessage;
  sessionId?: string;
  busy: boolean;
  onExecutePlan: (ref: PlanRevisionRef) => Promise<void>;
  onRevisePlan: () => void;
  planActing: string | null;
  planOutcome: Record<string, 'approved' | 'rejected' | undefined>;
  onPlanAction: (id: string, action: 'approve' | 'reject') => void;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
  approvalActing: string | null;
  approvalDecided: boolean;
  onApprovalAction: (approvalId: string, decision: 'approve' | 'reject') => void;
  onDelegatedStateChange: (
    sourceUserSeq: number,
    state: 'running' | 'cancelling' | 'stopped',
  ) => void;
  onDelegatedChanged: () => void;
}) {
  if (message.role === 'user') {
    return (
      <div class={`turn turn-user${message.pending ? ` pending pending-${message.pending}` : ''}`}>
        <div class="user-said">{message.text}</div>
        {message.pending === 'sending' ? <div class="pending-status">sending…</div> : null}
        {message.pending === 'failed' ? (
          <div class="pending-status pending-failed">
            <span>failed — {message.pendingError ?? 'couldn’t reach your Mac'}</span>
            <button class="pending-action" onClick={() => onRetry(message.id)}>retry</button>
            <button class="pending-action" onClick={() => onDiscard(message.id)}>discard</button>
          </div>
        ) : null}
      </div>
    );
  }

  const thinking = message.status === 'thinking';
  const activity = narrateActivity(message.activity ?? [], { live: thinking });
  const planStatus = message.planProposalId
    ? (planOutcome[message.planProposalId] ?? message.planProposalStatus ?? 'pending')
    : undefined;

  if (message.approval) {
    const approvalId = message.approval.approvalId;
    return (
      <div class="turn turn-approval">
        <div class="approval-head">Waiting on you — {message.approval.subject}</div>
        {message.approval.reason ? <div class="approval-reason">{message.approval.reason}</div> : null}
        {approvalId && !approvalDecided ? (
          <div class="plan-actions">
            <button
              class="approve"
              disabled={approvalActing !== null}
              onClick={() => onApprovalAction(approvalId, 'approve')}
            >
              {approvalActing === approvalId ? '…' : 'Approve'}
            </button>
            <button
              class="reject"
              disabled={approvalActing !== null}
              onClick={() => onApprovalAction(approvalId, 'reject')}
            >
              {approvalActing === approvalId ? '…' : 'Don’t do this'}
            </button>
          </div>
        ) : !approvalId ? (
          <div class="approval-reason">Open “Needs you” from the menu to act on this.</div>
        ) : null}
      </div>
    );
  }

  return (
    <div class={`turn turn-assistant${message.status === 'failed' ? ' turn-failed' : ''}`}>
      {message.taskMode?.kind === 'plan' && <div class="plan-mode-label">Plan mode · read-only investigation</div>}
      {message.planArtifactRef && <PlanReview planRef={message.planArtifactRef} sessionId={sessionId} busy={busy} onExecute={onExecutePlan} onRevise={onRevisePlan} />}
      {/* The work Clem did is ONE quiet line, not a stack of tool rows: while
          she is working it narrates the current step, and once settled it
          becomes a summary you can open. The reply is what the screen is for. */}
      {activity.length > 0 ? (
        <WorkLine
          activity={activity}
          live={thinking}
          message={message}
          onDelegatedStateChange={onDelegatedStateChange}
          onDelegatedChanged={onDelegatedChanged}
        />
      ) : null}
      {message.text ? (
        // Safe by construction: renderMarkdown escapes ALL input before adding
        // markup, refuses raw HTML, and only links http(s).
        <div
          class={`reply bubble-md${thinking ? ' reply-writing' : ''}`}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }}
        />
      ) : thinking && activity.length === 0 ? (
        <div class="reply reply-ghost">Thinking…</div>
      ) : null}
      {/* Mirror the backend's TYPED terminal (desktop shows the same pills).
          Without this the phone showed a blocked or paused turn as plain prose,
          indistinguishable from a finished answer. Legacy events show nothing. */}
      {(() => {
        const t = message.terminal;
        if (!t || thinking) return null;
        const line = t.status === 'blocked' ? 'Stopped here — your work is kept'
          : t.status === 'uncertain' ? 'Outcome uncertain — check before repeating'
          : t.status === 'cancelled' ? 'Cancelled'
          : t.status === 'transferred' ? 'Handed off'
          : t.status === 'needs_input' && (t.kind === 'continue' || t.needs === 'continue') ? 'Paused — say “continue” to pick up'
          : t.status === 'needs_input' && t.kind === 'approval' ? 'Waiting for your approval'
          : t.status === 'needs_input' ? 'Needs your reply'
          : null;
        return line ? <p class={`reply-state reply-state-${t.status}`} role="status">{line}</p> : null;
      })()}
      {message.planProposalId && planStatus === 'pending' && !message.planProposalNeedsUserInput ? (
        <div class="plan-actions">
          <button
            class="approve"
            disabled={planActing !== null}
            onClick={() => onPlanAction(message.planProposalId!, 'approve')}
          >
            {planActing === message.planProposalId ? '…' : 'Approve & Proceed'}
          </button>
          <button
            class="reject"
            disabled={planActing !== null}
            onClick={() => onPlanAction(message.planProposalId!, 'reject')}
          >
            {planActing === message.planProposalId ? '…' : 'Reject'}
          </button>
        </div>
      ) : null}
      {message.planProposalId && planStatus === 'pending' && message.planProposalNeedsUserInput ? (
        <div class="plan-status">Reply with the missing detail before this can run.</div>
      ) : null}
      {message.planProposalId && planStatus !== 'pending' ? (
        <div class="plan-status">Plan {planStatus}.</div>
      ) : null}
    </div>
  );
}

/**
 * One line for everything Clem did this turn.
 *
 * Live, it says what is happening right now — a person watching wants the
 * current beat, not a growing list. Settled, it collapses to how long the work
 * took and how many steps it was, and opens on tap for anyone who wants the
 * receipts. Failures are never hidden: if any step failed the line says so and
 * starts open, because that is the one case where the detail IS the answer.
 */
function WorkLine({
  activity,
  live,
  message,
  onDelegatedStateChange,
  onDelegatedChanged,
}: {
  activity: ActivityItem[];
  live: boolean;
  message: ChatMessage;
  onDelegatedStateChange: (
    sourceUserSeq: number,
    state: 'running' | 'cancelling' | 'stopped',
  ) => void;
  onDelegatedChanged: () => void;
}) {
  const failed = activity.some((item) => item.status === 'failed');
  const [open, setOpen] = useState(failed);
  const elapsed = useElapsed(activity, live);
  const delegatedControl = delegatedRunControlForExpandedWork(message, open);

  const summary = live
    ? liveActivityHeadline(activity)
    : `${failed ? 'Ran into trouble · ' : ''}${elapsed ? `Worked ${elapsed} · ` : ''}${activity.length} ${activity.length === 1 ? 'step' : 'steps'}`;

  return (
    <div class={`work${open ? ' work-open' : ''}${failed ? ' work-failed' : ''}`}>
      <div class="work-head">
        <button class="work-line" onClick={() => setOpen(!open)} aria-expanded={open}>
          {live ? <span class="work-spinner" aria-hidden="true" /> : <span class="work-caret" aria-hidden="true">{open ? '⌄' : '›'}</span>}
          <span class="work-summary">{summary}</span>
          {live && elapsed ? <span class="work-elapsed">{elapsed}</span> : null}
        </button>
        {delegatedControl?.target ? (
          <RunControl
            compact
            state={delegatedControl.state}
            target={delegatedControl.target}
            onStateChange={(state) => onDelegatedStateChange(delegatedControl.sourceUserSeq, state)}
            onChanged={onDelegatedChanged}
          />
        ) : delegatedControl?.state === 'stopped' ? (
          <div class="delegated-work-state" role="status">Stopped</div>
        ) : null}
      </div>
      {open ? (
        <div class="work-detail">
          {activity.map((item) => <ActivityRow key={item.id} item={item} />)}
        </div>
      ) : null}
    </div>
  );
}

/** Human elapsed for the turn, from the earliest step that carried a start. */
function useElapsed(activity: ActivityItem[], live: boolean): string {
  const startedAt = activity.reduce<number | undefined>((earliest, item) => (
    item.startedAt && (earliest === undefined || item.startedAt < earliest) ? item.startedAt : earliest
  ), undefined);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live || startedAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live, startedAt]);
  if (startedAt === undefined) return '';
  const seconds = Math.max(0, Math.round(((live ? now : Math.max(now, startedAt)) - startedAt) / 1000));
  if (!live && seconds < 1) return '';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const icon = item.status === 'running' ? <span class="act-spinner" aria-label="running" />
    : item.status === 'failed' ? <span class="act-mark act-fail">✗</span>
      : item.status === 'interrupted' ? <span class="act-mark act-warn">–</span>
        : <span class="act-mark act-ok">✓</span>;
  return (
    <div class={`activity-row act-${item.status}${item.tone ? ` tone-${item.tone}` : ''}`}>
      {icon}
      <span class="act-label">
        {item.label}
        {item.repeats && item.repeats > 1 ? <span class="act-repeats">×{item.repeats}</span> : null}
      </span>
      {item.batch ? (
        <span class="act-batch">
          {item.batch.done}/{item.batch.total}
          {item.batch.failed > 0 ? ` · ${item.batch.failed} failed` : ''}
          {item.batch.throttled ? ' · backing off' : ''}
        </span>
      ) : item.detail ? (
        <span class="act-detail">{item.detail}</span>
      ) : null}
    </div>
  );
}
