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
import { Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  ChatEngine,
  agentSwitchLabel,
  agentThreadMarks,
  createPendingMessageStore,
  modelDisplayName,
  type ChatAttachment,
  type ComposerMode,
  type PlanRevisionRef,
  type TaskMode,
  answerDraftStatus,
  evidenceChips,
  liveActivityHeadline,
  narrateActivity,
  observedEvidenceChips,
  outsideWorkCards,
  renderMarkdown,
  timelineBounds,
  timelineSpan,
  turnByline,
  turnProgress,
  type TimelineBounds,
  turnModelOffer,
  turnReview,
  type ActivityItem,
  type ModelRuleOffer,
  type ChatMessage,
  type EngineSnapshot,
  workflowCardLevels,
  workflowCards,
  type WorkflowCardData,
} from '@clem/chat-engine';
import {
  answerModelRuleOffer,
  approvePlanProposal,
  cancelActiveChat,
  cancelChatRequest,
  createChatStreamTransport,
  freshIdempotencyKey,
  getChatSession,
  listAgents,
  rejectPlanProposal,
  sendChatMessageAsync,
  uploadChatAttachment,
  switchChatAgent,
  type MobileAgent,
} from '../lib/api';
import { REFRESH_EVENT, haptic } from '../lib/native-bridge';
import { chatApprovalDecided, chatApprovalReply } from '../lib/chat-approval';
import { getModelSettings } from '../lib/api';
import { useKeyboardInset } from '../lib/use-keyboard-inset';
import { BrainSheet } from '../components/BrainSheet';
import { Composer } from '../components/Composer';
import { attachmentLabel, attachmentsSummary } from '../lib/attachments';
import { ChatBackButton } from '../components/ChatBackButton';
import { Sheet } from '../components/Sheet';
import { PlanReview } from '../components/PlanReview';
import { RunControl, delegatedRunControlForExpandedWork } from '../components/RunControl';
import { ProgressRail } from '../components/ProgressRail';

interface Props {
  sessionId?: string;
  initialTitle?: string;
  /** Text typed on Home's ask bar, waiting in the composer on arrival. */
  initialDraft?: string;
  /** Files uploaded from Home's capsule, sent with that text. */
  initialAttachments?: ChatAttachment[];
  /** Only Home's explicit Send handoff uses this; response/edit handoffs stay editable. */
  initialAutoSend?: boolean;
  /** The saved agent a NEW conversation opens inside, or the one a reopened
   *  thread already lives in (from its session row). */
  agentId?: string;
  agentName?: string;
  onBack: () => void;
}

export function Chat({ sessionId: initialSessionId, initialTitle, initialDraft, initialAttachments, initialAutoSend, agentId: initialAgentId, agentName: initialAgentName, onBack }: Props) {
  const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
  // Who answers the next message — changeable at any time, like the brain.
  // A new conversation opens inside it; after that a change is applied just
  // before the next message (see sendMessage).
  const [agent, setAgent] = useState<{ id: string; name: string } | null>(
    initialAgentId ? { id: initialAgentId, name: initialAgentName ?? '' } : null,
  );
  /** The agent the daemon has for this conversation, so a send only reports a real change. */
  const sessionAgentId = useRef<string | null>(initialAgentId ?? null);
  // The agent a NEW conversation is created in. Frozen once a session exists:
  // the engine is rebuilt when it changes, which must never drop a thread.
  const [openingAgentId, setOpeningAgentId] = useState<string | null>(initialSessionId ? null : initialAgentId ?? null);
  const boundAgentId = initialSessionId ? null : openingAgentId;
  const [agentPickOpen, setAgentPickOpen] = useState(false);
  const [agentChoices, setAgentChoices] = useState<MobileAgent[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    listAgents()
      .then((result) => { if (!cancelled) setAgentChoices(result.agents); })
      .catch(() => { if (!cancelled) setAgentChoices([]); });
    return () => { cancelled = true; };
  }, [agentPickOpen]);
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
    agentId: boundAgentId,
    pendingStore: createPendingMessageStore(localStorage, `clem.pending.mobile:${initialSessionId ?? 'new'}`),
    api: {
      send: async ({ message, sessionId, idempotencyKey, steerOnly, taskMode, agentId, attachments }) => {
        const result = await sendChatMessageAsync({ message, sessionId, idempotencyKey, steerOnly, taskMode, agentId, attachments });
        return { sessionId: result.sessionId, accepted: result.accepted, steered: result.steered };
      },
      loadSession: async (sessionId) => {
        try {
          const result = await getChatSession(sessionId);
          setTitle(result.session.title);
          setAgent(result.session.agentId ? { id: result.session.agentId, name: result.session.agentName ?? '' } : null);
          sessionAgentId.current = result.session.agentId ?? null;
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
  }), [initialSessionId, boundAgentId]);

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
    const text = initialDraft?.trim() ?? '';
    const files = initialAttachments ?? [];
    if (!initialAutoSend || (!text && files.length === 0) || autoSent.current) return;
    autoSent.current = true;
    setDraft('');
    haptic('light');
    void engine.send(text, busy ? snapshot?.activeTaskMode : { version: 1, kind: composerMode }, { attachments: files })
      .catch(error => setError(error instanceof Error ? error.message : 'Could not send.'));
  }, [engine, initialAutoSend, initialDraft, initialAttachments]);

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
  // A Space dock takes no agent; everything else can switch at any time.
  const takesAgent = !(snapshot?.sessionId ?? initialSessionId ?? '').startsWith('space-');
  const showAgentChip = takesAgent && (Boolean(agent) || (agentChoices?.length ?? 0) > 0);
  const agentLabel = agent?.name || (agent ? 'Agent' : 'Clem');
  const agentMarks = agentThreadMarks(messages, agent?.name ?? null);

  function pickAgent(next: { id: string; name: string } | null) {
    haptic('light');
    setAgent(next);
    if (!snapshot?.sessionId && messages.length === 0) setOpeningAgentId(next?.id ?? null);
    setAgentPickOpen(false);
  }

  /** Send a new message to whoever the chip names. A message sent while a
   *  reply runs steers that reply; the choice waits for the next one. */
  async function sendMessage(text: string, mode: TaskMode | undefined, attachments: ChatAttachment[] = []) {
    const sessionId = snapshot?.sessionId;
    // The daemon is told about the chip only when the chip changed: a plain
    // follow-up must never wait on, or fail on, a switch to what the
    // conversation already has (live 09-26: that call failed and every
    // follow-up in an existing thread was silently dropped).
    const wanted = agent?.id ?? null;
    if (sessionId && !busy && takesAgent && wanted !== sessionAgentId.current) {
      const result = await switchChatAgent(sessionId, wanted);
      sessionAgentId.current = result.agentId ?? null;
      // Who actually replies (a deleted agent falls back to Clem).
      if ((result.agentId ?? null) !== wanted) {
        setAgent(result.agentId ? { id: result.agentId, name: result.agentName ?? '' } : null);
      }
    }
    await engine.send(text, mode, { attachments });
  }
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

  useEffect(() => {
    const el = dockRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setDockH(el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [canStop, planning]);

  function submitDraft(text: string, attachments: ChatAttachment[]) {
    if (executing) return;
    haptic('light');
    void sendMessage(text, busy ? snapshot?.activeTaskMode : { version: 1, kind: composerMode }, attachments)
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
        {showAgentChip ? (
          <button
            type="button"
            class="brain-chip agent-chip"
            disabled={executing}
            title="Who answers your next message"
            onClick={() => { haptic('light'); setAgentPickOpen(true); }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" />
            </svg>
            <span class="truncate">{agentLabel}</span>
          </button>
        ) : null}
        <Sheet open={agentPickOpen} onClose={() => setAgentPickOpen(false)} title="Who answers" class="sheet-compact">
          {agentChoices === null ? (
            <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>
          ) : (
            <ul class="agent-pick-list">
              <li>
                <button type="button" aria-pressed={!agent} onClick={() => pickAgent(null)}>
                  <span class="agent-name">Clem</span>
                  <span class="agent-desc">As usual, no agent's instructions</span>
                </button>
              </li>
              {agentChoices.map((choice) => (
                <li key={choice.id}>
                  <button type="button" aria-pressed={agent?.id === choice.id} onClick={() => pickAgent({ id: choice.id, name: choice.name })}>
                    <span class="agent-name">{choice.name}</span>
                    {choice.handles ? <span class="agent-desc">{choice.handles}</span> : null}
                  </button>
                </li>
              ))}
              {agentChoices.length === 0 ? <li><p class="agent-desc">No agents yet. Make one on the Agents tab.</p></li> : null}
            </ul>
          )}
        </Sheet>
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
            {initialSessionId && !snapshot ? 'Loading…' : snapshot?.sessionId ? 'Empty session.'
              : agent?.name ? `Type a message to start a chat with ${agent.name}.` : 'Type a message to start a new chat.'}
          </div>
        ) : null}
        {messages.map((message, index) => (
          <Fragment key={message.id}>
          {agentMarks[index]?.switchedTo ? (
            <div class="agent-switch-line" role="separator">{agentSwitchLabel(agentMarks[index].switchedTo!.name)}</div>
          ) : null}
          <MessageRow
            message={message}
            sessionId={snapshot?.sessionId ?? undefined}
            busy={busy}
            onExecutePlan={ref => engine.send(`Execute the reviewed plan, revision ${ref.revision}.`, { version: 1, kind: 'execute', executeRef: ref })}
            onRevisePlan={() => { setComposerMode('plan'); textareaRef.current?.focus(); }}
            planActing={planActing}
            planOutcome={planOutcome}
            onPlanAction={actOnPlan}
            approvalActing={approvalActing}
            approvalDecided={Boolean(message.approval?.resolution) || chatApprovalDecided(messages, message.approval?.approvalId)}
            onApprovalAction={actOnApproval}
            onRetry={(id) => void engine.retry(id)}
            onDiscard={(id) => engine.discard(id)}
            // Suggested answers stay tappable only while the question is the
            // newest message; once anything follows it, they are a record.
            onAnswer={index === messages.length - 1 ? (text) => {
              haptic('light');
              void sendMessage(text, busy ? snapshot?.activeTaskMode : { version: 1, kind: composerMode })
                .catch(error => setError(error instanceof Error ? error.message : 'Could not send.'));
            } : undefined}
            onDelegatedStateChange={(sourceUserSeq, state) => {
              engine.setDelegatedWorkState(sourceUserSeq, state);
            }}
            onDelegatedChanged={() => engine.resume()}
          />
          </Fragment>
        ))}
      </div>
      {showJumpToLatest ? (
        <button type="button" class="chat-jump" onClick={jumpToLatest}>Jump to latest</button>
      ) : null}
      <div class="chat-dock-fade" aria-hidden="true" />
      <div ref={dockRef} class="chat-dock">
        <Composer
          value={draft}
          onChange={setDraft}
          textareaRef={textareaRef}
          placeholder={busy ? 'Add to what she’s doing…' : planning ? 'What should we plan?' : `Message ${agent?.name || 'Clem'}…`}
          ariaLabel={agent?.name ? `Message ${agent.name}` : 'Message Clem'}
          upload={uploadChatAttachment}
          disabled={executing}
          canStop={canStop}
          stopping={stopping}
          onStop={stopTurn}
          onSend={submitDraft}
          chips={(
            <>
              {/* Act | Plan as one chip: tap flips it. Disabled mid-run, when
                  the mode belongs to the turn already going. */}
              <button
                type="button"
                class={`composer-chip mode-chip${planning ? ' is-plan' : ''}`}
                disabled={busy}
                aria-pressed={planning}
                title={planning ? 'Plan: shows you the steps first' : 'Act: does it now'}
                onClick={() => { haptic('light'); setComposerMode(planning ? 'normal' : 'plan'); }}
              >
                {executing ? 'Executing plan' : planning ? 'Plan' : 'Act'}
              </button>
              {brainLabel ? (
                <button
                  type="button"
                  class="composer-chip brain-chip"
                  title="Does the work: the model that answers your next message"
                  onClick={() => { haptic('light'); setBrainOpen(true); }}
                >
                  <span class="truncate">{modelDisplayName(brainLabel)}</span>
                </button>
              ) : null}
            </>
          )}
        />
      </div>
    </div>
  );
}

/** "markdown_text" → "Markdown text": an argument name as a label. */
function approvalFieldLabel(name: string): string {
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
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
        {message.attachments?.length ? (
          <div class="user-attachments" aria-label={attachmentsSummary(message.attachments)}>
            {message.attachments.map((a) => (
              a.kind === 'image' && a.previewUrl
                ? <img key={a.id} class="user-attachment-image" src={a.previewUrl} alt={attachmentLabel(a)} />
                : <span key={a.id} class="user-attachment-chip">{attachmentLabel(a)}</span>
            ))}
          </div>
        ) : null}
        {message.text ? <div class="user-said">{message.text}</div> : null}
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
        {message.approval.preview?.check?.status === 'conflicts' && message.approval.preview.check.conflicts?.length ? (
          <div class="approval-check approval-check-warn" role="note">
            <div class="approval-check-title">Before you approve</div>
            <ul>
              {message.approval.preview.check.conflicts.map((line) => <li key={line}>{line}</li>)}
            </ul>
            <div class="approval-check-hint">Reply with a change, or approve it as it is.</div>
          </div>
        ) : message.approval.preview?.check ? (
          <div class="approval-check">
            {message.approval.preview.check.status === 'clear'
              ? 'Checked against your standing rules — no conflicts.'
              : 'Couldn’t check this against your standing rules.'}
          </div>
        ) : null}
        {message.approval.preview && message.approval.preview.fields.length > 0 ? (
          // What approving would actually send, from the host's frozen call.
          <dl class="approval-preview">
            {message.approval.preview.fields.map((field) => (
              <div key={field.name}>
                <dt>{approvalFieldLabel(field.name)}</dt>
                <dd>
                  {field.label
                    ? <>{field.label} <span class="approval-preview-id">· {field.value}</span></>
                    : field.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
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
        ) : message.approval.resolution === 'changed' ? (
          <div class="approval-reason">You asked for a change — the revised version is below. Nothing was sent from this one.</div>
        ) : message.approval.resolution === 'declined' ? (
          <div class="approval-reason">Declined — nothing was sent.</div>
        ) : message.approval.resolution === 'expired' ? (
          <div class="approval-reason">Expired without an answer — it did not run.</div>
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
        <div class="work">
          <div class="work-line work-live" role="status">
            <span class="work-orb" aria-hidden="true" />
            <span class="work-summary work-shimmer">{message.progress ?? 'Thinking…'}</span>
          </div>
          <ProgressRail progress={turnProgress({ activity, live: true, draft: message.answerDraft, hasText: Boolean(message.text) })} />
        </div>
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
      {thinking ? <OutsideWork activity={message.activity} /> : <TurnReceipt message={message} sessionId={sessionId} />}
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
  const now = useNowTick(live);
  const elapsed = turnElapsed(activity, live, now);
  const delegatedControl = delegatedRunControlForExpandedWork(message, open);
  // The four-phase rail while live; the step bars share one time window.
  const progress = live ? turnProgress({ activity, live, draft: message.answerDraft, hasText: Boolean(message.text) }) : null;
  const bounds = timelineBounds(activity, live, now);

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
      {progress ? <ProgressRail progress={progress} /> : null}
      {open ? (
        <div class="work-detail">
          {activity.map((item) => <ActivityRow key={item.id} item={item} bounds={bounds} now={now} live={live} />)}
        </div>
      ) : null}
    </div>
  );
}

/** Tick once a second while live, so the clock and the step bars move together. */
function useNowTick(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

/** Human elapsed for the turn, from the earliest step that carried a start. */
function turnElapsed(activity: ActivityItem[], live: boolean, now: number): string {
  const startedAt = activity.reduce<number | undefined>((earliest, item) => (
    item.startedAt && (earliest === undefined || item.startedAt < earliest) ? item.startedAt : earliest
  ), undefined);
  if (startedAt === undefined) return '';
  const seconds = Math.max(0, Math.round(((live ? now : Math.max(now, startedAt)) - startedAt) / 1000));
  if (!live && seconds < 1) return '';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/** One step, with where it sat in the turn drawn as a hairline under it. */
function ActivityRow({ item, bounds, now, live }: { item: ActivityItem; bounds: TimelineBounds | null; now: number; live: boolean }) {
  const icon = item.status === 'running' ? <span class="act-spinner" aria-label="running" />
    : item.status === 'failed' ? <span class="act-mark act-fail">✗</span>
      : item.status === 'interrupted' ? <span class="act-mark act-warn">–</span>
        : <span class="act-mark act-ok">✓</span>;
  const span = bounds ? timelineSpan(item, bounds, live, now) : null;
  const running = live && item.status === 'running';
  return (
    <div class="act-step">
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
    {span ? (
      <span class="step-track" aria-hidden="true">
        <span class={`step-fill ${running ? 'is-running' : `is-${item.status}`}`} style={{ left: `${span.left}%`, width: `${span.width}%` }} />
      </span>
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
/** Changes the provider confirmed in other apps. Shown the moment a write is
 *  confirmed, while the answer is still being written and checked; the
 *  finished receipt keeps them in the same place. */
function WorkflowCardView({ card }: { card: WorkflowCardData }) {
  const levels = workflowCardLevels(card);
  const changed = new Set(card.changedStepIds);
  const n = card.changedStepIds.length;
  const sub = card.op === 'created'
    ? `${card.steps.length} step${card.steps.length === 1 ? '' : 's'} · ${card.enabled ? 'on' : 'off until you turn it on'}`
    : n === 0 ? 'Settings changed · steps as before' : `${n} step${n === 1 ? '' : 's'} changed${card.enabled ? '' : ' · off until its test passes'}`;
  return (
    <div class="reply-outside-card reply-workflow">
      <span class="reply-outside-text">
        <span class="reply-outside-title">{card.name}</span>
        <span class="reply-outside-sub">{sub}</span>
        {card.steps.length > 0 ? (
          <span class="reply-workflow-chain" aria-label="Steps">
            {levels.map((level, i) => (
              <span key={i} class="reply-workflow-level">
                {i > 0 ? <span class="reply-workflow-arrow" aria-hidden>→</span> : null}
                <span class="reply-workflow-stack">
                  {level.map((step) => (
                    <span key={step.id} class={`reply-workflow-step${changed.has(step.id) ? ' changed' : ''}`} title={step.label}>
                      {step.label}{step.approval ? ' 🔒' : ''}
                    </span>
                  ))}
                </span>
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function OutsideWork({ activity }: { activity: ChatMessage['activity'] }) {
  const outside = outsideWorkCards(activity);
  const workflows = workflowCards(activity);
  if (outside.length === 0 && workflows.length === 0) return null;
  return (
    <div class="reply-outside">
      {workflows.map((card) => <WorkflowCardView key={card.slug} card={card} />)}
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
  );
}

/**
 * "Use <model> for <kind of work> from now on?" — asked once, after a turn
 * where the owner named a model for one part of the work. Save writes the same
 * rule Settings → Models shows; nothing changes until the owner taps.
 */
function ModelRuleOfferCard({ offer, sessionId }: { offer: ModelRuleOffer; sessionId: string }) {
  const [answer, setAnswer] = useState<'save' | 'dismiss' | undefined>(offer.resolved);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState('');
  if (answer === 'dismiss') return null;
  if (answer === 'save') {
    return <p class="reply-offer-saved" role="status">✓ {offer.modelName} will do {offer.intent} from now on. Change it in Settings.</p>;
  }
  const respond = (action: 'save' | 'dismiss') => {
    setWorking(true);
    setProblem('');
    void answerModelRuleOffer(sessionId, offer.offerId, action)
      .then((result) => { setAnswer(result.action); setWorking(false); })
      .catch(() => { setWorking(false); setProblem('That did not save. Try again, or set it in Settings.'); });
  };
  return (
    <div class="reply-offer">
      <span class="reply-offer-title">Use {offer.modelName} for {offer.intent} from now on?</span>
      <span class="reply-offer-sub">{problem || 'It will show in Settings, where you can change it.'}</span>
      <span class="reply-offer-actions">
        <button type="button" class="reply-offer-button" disabled={working} onClick={() => respond('dismiss')}>Just this once</button>
        <button type="button" class="reply-offer-button primary" disabled={working} onClick={() => respond('save')}>{working ? 'Saving…' : 'Save for next time'}</button>
      </span>
    </div>
  );
}

function TurnReceipt({ message, sessionId }: { message: ChatMessage; sessionId?: string }) {
  const [reveal, setReveal] = useState(false);
  const review = turnReview(message.activity);
  const byline = turnByline(message.activity);
  const outside = outsideWorkCards(message.activity);
  const offer = turnModelOffer(message.activity);
  const proven = evidenceChips(message.terminal?.evidenceRefs);
  const chips = proven.length > 0 ? proven : observedEvidenceChips(message.activity);
  const touched = chips.map((chip) => chip.label).join(' · ');
  if (!review && !touched && !byline && outside.length === 0 && !offer && workflowCards(message.activity).length === 0) return null;
  return (
    <>
      <OutsideWork activity={message.activity} />
      {offer && sessionId ? <ModelRuleOfferCard key={offer.offerId} offer={offer} sessionId={sessionId} /> : null}
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
