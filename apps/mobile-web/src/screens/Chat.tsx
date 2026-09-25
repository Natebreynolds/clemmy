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
  answerDraftStatus,
  evidenceChips,
  liveActivityHeadline,
  narrateActivity,
  observedEvidenceChips,
  outsideWorkCards,
  renderMarkdown,
  turnByline,
  turnReview,
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
import { useDictation } from '../lib/use-dictation';
import { useKeyboardInset } from '../lib/use-keyboard-inset';
import { BrainSheet } from '../components/BrainSheet';
import { ChatBackButton } from '../components/ChatBackButton';
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
  const dockRef = useRef<HTMLDivElement | null>(null);
  const autoSent = useRef(false);
  const keyboardInset = useKeyboardInset();
  const [dockH, setDockH] = useState(140);

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
  const { available: dictation, listening, toggle: toggleDictation, stop: stopDictation } = useDictation(
    draft,
    setDraft,
    () => textareaRef.current?.focus(),
  );

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

  useEffect(() => {
    const el = dockRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setDockH(el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [canStop, planning, listening]);

  function submitDraft() {
    const text = draft.trim();
    if (!text || executing) return;
    stopDictation();
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
    <div
      class="chat-shell"
      style={{ '--kb-inset': `${keyboardInset}px`, '--chat-dock-h': `${dockH}px` }}
    >
      <div class="chat-header">
        <ChatBackButton onClick={onBack} />
        <h2 class="chat-title">{title || (snapshot?.sessionId ? 'Conversation' : 'New chat')}</h2>
        {brainLabel ? (
          <button
            type="button"
            class="brain-chip"
            title="Does the work: the model that answers your next message"
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
        {messages.map((message, index) => (
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
            // Suggested answers stay tappable only while the question is the
            // newest message; once anything follows it, they are a record.
            onAnswer={index === messages.length - 1 ? (text) => {
              haptic('light');
              void engine.send(text, busy ? snapshot?.activeTaskMode : { version: 1, kind: composerMode })
                .catch(error => setError(error instanceof Error ? error.message : 'Could not send.'));
            } : undefined}
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
      <div class="chat-dock-fade" aria-hidden="true" />
      <div ref={dockRef} class={`chat-dock${listening ? ' listening' : ''}`}>
        <div class="chat-mode-bar">
          <div class="chat-mode-seg" role="group" aria-label="Mode">
            <button type="button" aria-pressed={!planning} disabled={busy}
              onClick={() => setComposerMode('normal')}>Act</button>
            <button type="button" aria-pressed={planning} disabled={busy}
              onClick={() => setComposerMode('plan')}>Plan</button>
          </div>
          <span role="status">{executing ? 'Executing the reviewed plan' : busy && snapshot?.activeTaskMode?.kind === 'plan'
            ? 'Planning · read-only tools'
            : busy ? 'Anything you send reaches her mid-run'
              : composerMode === 'plan' ? 'Shows you the steps first' : 'Does it now'}</span>
        </div>
        <form class="chat-composer" onSubmit={(ev) => { ev.preventDefault(); submitDraft(); }}>
          {dictation ? (
            <button
              type="button"
              class="chat-mic"
              aria-label={listening ? 'Stop dictation' : 'Dictate'}
              aria-pressed={listening}
              onClick={toggleDictation}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
              </svg>
            </button>
          ) : null}
          <textarea
            ref={textareaRef}
            class="chat-input"
            rows={1}
            aria-label="Message Clem"
            placeholder={listening ? 'Listening…' : busy ? 'Add to what she’s doing…' : planning ? 'What should we plan?' : 'Message Clem…'}
            value={draft}
            enterkeyhint="send"
            autocomplete="off"
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
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
              <button
                class="chat-stop"
                type="button"
                onClick={stopTurn}
                disabled={stopping}
                aria-label="Stop"
              >
                {stopping ? (
                  <span class="chat-stop-busy" aria-hidden="true" />
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
                  </svg>
                )}
              </button>
            </>
          ) : (
            <button
              class="chat-send"
              type="submit"
              disabled={executing || draft.trim().length === 0}
              aria-label="Send"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

function MessageRow({
  message, sessionId, busy, onExecutePlan, onRevisePlan, planActing, planOutcome, onPlanAction, onRetry, onDiscard,
  approvalActing, approvalDecided, onApprovalAction,
  onDelegatedStateChange, onDelegatedChanged, onAnswer,
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
  /** Send a suggested answer as the reply, exactly as if it were typed.
   *  Absent once the question is no longer the newest message. */
  onAnswer?: (text: string) => void;
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
  const draftStatus = thinking ? answerDraftStatus(message.answerDraft) : null;
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
        <>
          {/* Safe by construction: renderMarkdown escapes ALL input before
              adding markup, refuses raw HTML, and only links http(s). A draft
              that is being checked or corrected stays on screen (dimmed once
              withdrawn) until the next draft or the reply replaces it. */}
          <div
            class={`reply bubble-md${thinking && !draftStatus ? ' reply-writing' : ''}${message.answerDraft?.phase === 'withdrawn' ? ' reply-withdrawn' : ''}`}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }}
          />
          {draftStatus ? (
            <p class={`reply-draft-status${message.answerDraft?.withdrawn === 'review' ? ' is-correcting' : ''}`} role="status">
              <span class="work-orb" aria-hidden="true" />
              {draftStatus}
            </p>
          ) : null}
        </>
      ) : thinking && activity.length === 0 ? (
        <div class="work"><div class="work-line work-live" role="status">
          <span class="work-orb" aria-hidden="true" />
          <span class="work-summary work-shimmer">{message.progress ?? 'Thinking…'}</span>
        </div></div>
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
      {/* The harness's ledger for this turn — what it wrote, saved, read and
          remembered. Desktop makes the file chips openable; a phone has nowhere
          local to open to, so here it stays an honest count rather than a
          button that does nothing. */}
      {message.status === 'awaiting-reply' && message.options?.length && onAnswer ? (
        <AnswerChoices options={message.options} onAnswer={onAnswer} />
      ) : null}
      {thinking ? null : <TurnReceipt message={message} />}
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
  // A turn with no failed ROW can still not have succeeded: stopped, waiting
  // on a reply, waiting on approval, blocked. The typed terminal is what knows.
  // Without this the card read "Worked 40s · 6 steps" for all of them, which is
  // the same class of lie as Home's old "done while you were away".
  // Clem asking for a reply or an approval is her turn ending on purpose: it
  // waits on you, which is neither done nor "Didn't finish".
  const waiting = !live && !failed && message.terminal?.status === 'needs_input';
  const unfinished = !live && !failed && !waiting
    && Boolean(message.terminal) && message.terminal?.status !== 'done';
  const [open, setOpen] = useState(failed);
  const elapsed = useElapsed(activity, live);
  const delegatedControl = delegatedRunControlForExpandedWork(message, open);

  // While live, a running step names itself; between steps the engine's own
  // rolling line ("Reading your calendar…") says what she is doing.
  const running = activity.some((item) => item.status === 'running');
  const summary = live
    ? (!running && message.progress ? message.progress : liveActivityHeadline(activity))
    : `${failed ? 'Ran into trouble · ' : unfinished ? 'Didn’t finish · ' : waiting ? 'Waiting for you · ' : ''}${elapsed ? `Worked ${elapsed} · ` : ''}${activity.length} ${activity.length === 1 ? 'step' : 'steps'}`;

  return (
    <div class={`work${open ? ' work-open' : ''}${failed ? ' work-failed' : ''}${unfinished ? ' work-unfinished' : ''}${waiting ? ' work-waiting' : ''}`}>
      <div class="work-head">
        <button class={`work-line${live ? ' work-live' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>
          {live ? <span class="work-orb" aria-hidden="true" /> : <OutcomeMark failed={failed} unfinished={unfinished} waiting={waiting} />}
          <span class={`work-summary${live ? ' work-shimmer' : ''}`}>{summary}</span>
          {live && elapsed ? <span class="work-elapsed">{elapsed}</span> : null}
          {live ? null : <span class={`work-chevron${open ? ' open' : ''}`} aria-hidden="true">›</span>}
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

function OutcomeMark({ failed, unfinished, waiting }: { failed: boolean; unfinished: boolean; waiting: boolean }) {
  const tone = failed ? 'fail' : unfinished ? 'warn' : waiting ? 'wait' : 'ok';
  const label = failed ? 'Ran into trouble' : unfinished ? 'Did not finish' : waiting ? 'Waiting for you' : 'Completed';
  return (
    <svg class={`work-mark work-mark-${tone}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label={label}>
      <circle cx="12" cy="12" r="9" />
      {failed ? <path d="m9 9 6 6M15 9l-6 6" /> : unfinished ? <path d="M12 7.5v5M12 16.5v.01" /> : waiting ? <path d="M10 9v6M14 9v6" /> : <path d="m8.5 12.5 2.5 2.5 4.5-5.5" />}
    </svg>
  );
}

/**
 * A question's suggested answers as one-tap replies. A tap sends the choice as
 * the reply; typing stays open for anything else. The buttons latch after one
 * tap so a double tap cannot answer twice.
 */
function AnswerChoices({ options, onAnswer }: { options: string[]; onAnswer: (text: string) => void }) {
  const [chosen, setChosen] = useState<string | null>(null);
  return (
    <div class="answer-choices" role="group" aria-label="Suggested answers">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          class={`answer-choice${chosen === option ? ' chosen' : ''}`}
          disabled={chosen !== null}
          aria-pressed={chosen === option}
          onClick={() => { setChosen(option); onAnswer(option); }}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

/**
 * The last lines under an answer: what it changed outside Clem (confirmed
 * writes only), whether it was checked, and what the turn touched. Tapping the
 * line names the models that did the work and the checking — kept out of the
 * way until asked for on the phone's narrow width. "Checked" appears only when
 * a review passed; a turn whose reviewer never ran says so.
 */
function TurnReceipt({ message }: { message: ChatMessage }) {
  const [reveal, setReveal] = useState(false);
  const review = turnReview(message.activity);
  const byline = turnByline(message.activity);
  const outside = outsideWorkCards(message.activity);
  const proven = evidenceChips(message.terminal?.evidenceRefs);
  const chips = proven.length > 0 ? proven : observedEvidenceChips(message.activity);
  const touched = chips.map((chip) => chip.label).join(' · ');
  if (!review && !touched && !byline && outside.length === 0) return null;
  return (
    <>
      {outside.length > 0 ? (
        <div class="reply-outside">
          {outside.map((card) => (
            <div key={card.key} class="reply-outside-card">
              <span class="reply-outside-text">
                <span class="reply-outside-title">{card.title}</span>
                <span class="reply-outside-sub">{card.subtitle}</span>
              </span>
              {card.appUrl ? (
                <a class="reply-outside-open" href={card.appUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open ${card.app ?? 'the app'}`}>Open ↗</a>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {review || touched || byline ? (
        <button type="button" class="reply-receipt" onClick={() => setReveal(!reveal)} aria-expanded={reveal}>
          {review === 'checked' ? <span class="receipt-ok">✓ Checked</span> : null}
          {review === 'unchecked' ? <span class="receipt-warn">Not checked</span> : null}
          {review === 'rejected' ? <span class="receipt-warn">Didn’t pass review</span> : null}
          {touched ? <span>{touched}</span> : null}
          {reveal && byline ? <span class="receipt-model">{byline}</span> : null}
        </button>
      ) : null}
    </>
  );
}
