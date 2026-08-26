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
  narrateActivity,
  renderMarkdown,
  type ActivityItem,
  type ChatMessage,
  type EngineSnapshot,
} from '@clem/chat-engine';
import {
  approvePlanProposal,
  createChatStreamTransport,
  freshIdempotencyKey,
  getChatSession,
  rejectPlanProposal,
  sendChatMessageAsync,
} from '../lib/api';
import { REFRESH_EVENT, haptic } from '../lib/native-bridge';
import { getModelSettings } from '../lib/api';
import { BrainSheet } from '../components/BrainSheet';

interface Props {
  sessionId?: string;
  initialTitle?: string;
  /** Text typed on Home's ask bar, waiting in the composer on arrival. */
  initialDraft?: string;
  onBack: () => void;
}

export function Chat({ sessionId: initialSessionId, initialTitle, initialDraft, onBack }: Props) {
  const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
  const [title, setTitle] = useState(initialTitle ?? '');
  const [draft, setDraft] = useState(initialDraft ?? '');
  const [planActing, setPlanActing] = useState<string | null>(null);
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

  const engine = useMemo(() => new ChatEngine({
    transport: createChatStreamTransport(),
    sessionId: initialSessionId ?? null,
    api: {
      send: async ({ message, sessionId, idempotencyKey }) => {
        const result = await sendChatMessageAsync({ message, sessionId, idempotencyKey });
        return { sessionId: result.sessionId, accepted: result.accepted };
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

  const messages = snapshot?.messages ?? [];
  const busy = snapshot?.busy ?? false;
  const connection = snapshot?.connection ?? 'idle';

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  function autoresize(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }

  function submitDraft() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    if (textareaRef.current) {
      textareaRef.current.value = '';
      autoresize(textareaRef.current);
    }
    haptic('light');
    void engine.send(text);
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

  return (
    <div class="chat-shell">
      <div class="chat-header">
        <button class="chat-back" onClick={onBack} aria-label="Back">←</button>
        <div class="chat-title">{title || (snapshot?.sessionId ? 'Conversation' : 'New chat')}</div>
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
      <div class="chat-transcript" ref={scrollRef}>
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
            planActing={planActing}
            planOutcome={planOutcome}
            onPlanAction={actOnPlan}
            onRetry={(id) => void engine.retry(id)}
            onDiscard={(id) => engine.discard(id)}
          />
        ))}
      </div>
      <form class="chat-composer" onSubmit={(ev) => { ev.preventDefault(); submitDraft(); }}>
        <textarea
          ref={textareaRef}
          class="chat-input"
          rows={1}
          placeholder="Message Clem…"
          value={draft}
          onInput={(ev) => {
            const el = ev.currentTarget as HTMLTextAreaElement;
            setDraft(el.value);
            autoresize(el);
          }}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' && !ev.shiftKey) {
              ev.preventDefault();
              submitDraft();
            }
          }}
        />
        <button
          class="chat-send"
          type="submit"
          disabled={busy || draft.trim().length === 0}
          aria-label="Send"
        >
          {busy ? '…' : '↑'}
        </button>
      </form>
    </div>
  );
}

function MessageRow({
  message, planActing, planOutcome, onPlanAction, onRetry, onDiscard,
}: {
  message: ChatMessage;
  planActing: string | null;
  planOutcome: Record<string, 'approved' | 'rejected' | undefined>;
  onPlanAction: (id: string, action: 'approve' | 'reject') => void;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
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
    return (
      <div class="turn turn-approval">
        <div class="approval-head">Waiting on you — {message.approval.subject}</div>
        {message.approval.reason ? <div class="approval-reason">{message.approval.reason}</div> : null}
      </div>
    );
  }

  return (
    <div class={`turn turn-assistant${message.status === 'failed' ? ' turn-failed' : ''}`}>
      {/* The work Clem did is ONE quiet line, not a stack of tool rows: while
          she is working it narrates the current step, and once settled it
          becomes a summary you can open. The reply is what the screen is for. */}
      {activity.length > 0 ? <WorkLine activity={activity} live={thinking} /> : null}
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
function WorkLine({ activity, live }: { activity: ActivityItem[]; live: boolean }) {
  const failed = activity.some((item) => item.status === 'failed');
  const [open, setOpen] = useState(failed);
  const running = activity.filter((item) => item.status === 'running');
  const current = running[running.length - 1] ?? activity[activity.length - 1];
  const elapsed = useElapsed(activity, live);

  const summary = live
    ? (current?.label ?? 'Working…')
    : `${failed ? 'Ran into trouble · ' : ''}${elapsed ? `Worked ${elapsed} · ` : ''}${activity.length} ${activity.length === 1 ? 'step' : 'steps'}`;

  return (
    <div class={`work${open ? ' work-open' : ''}${failed ? ' work-failed' : ''}`}>
      <button class="work-line" onClick={() => setOpen(!open)} aria-expanded={open}>
        {live ? <span class="work-spinner" aria-hidden="true" /> : <span class="work-caret" aria-hidden="true">{open ? '⌄' : '›'}</span>}
        <span class="work-summary">{summary}</span>
        {live && elapsed ? <span class="work-elapsed">{elapsed}</span> : null}
      </button>
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
