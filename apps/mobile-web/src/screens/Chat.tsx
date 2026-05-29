import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  approvePlanProposal,
  freshIdempotencyKey,
  getChatSession,
  rejectPlanProposal,
  sendChatMessage,
  subscribeChatStream,
  type ChatEvent,
} from '../lib/api';

interface Props {
  sessionId?: string;
  initialTitle?: string;
  onBack: () => void;
}

interface PendingEcho {
  /** Local UUID used as the React key. */
  id: string;
  text: string;
  state: 'sending' | 'failed';
  error?: string;
  idempotencyKey: string;
  sentAt: number;
}

export function Chat({ sessionId: initialSessionId, initialTitle, onBack }: Props) {
  const [sessionId, setSessionId] = useState<string | undefined>(initialSessionId);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [pending, setPending] = useState<PendingEcho[]>([]);
  const [title, setTitle] = useState(initialTitle ?? '');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(initialSessionId));
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [planActing, setPlanActing] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Load + subscribe whenever sessionId changes (incl. when an empty
  // "new chat" gets its server-assigned id after the first send).
  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let latestSeq = 0;

    async function load() {
      try {
        const result = await getChatSession(sessionId!);
        if (cancelled) return;
        setTitle(result.session.title);
        setEvents(result.events);
        latestSeq = result.latestSeq;
        unsubscribe = subscribeChatStream(sessionId!, {
          onReplay: ({ events: replay }) => {
            if (cancelled) return;
            setEvents((current) => mergeEventsBySeq(current, replay));
            for (const e of replay) latestSeq = Math.max(latestSeq, e.seq);
          },
          onEvent: (event) => {
            if (cancelled) return;
            setEvents((current) => mergeEventsBySeq(current, [event]));
            latestSeq = Math.max(latestSeq, event.seq);
            // When the server confirms a user message echo, drop the
            // matching pending bubble.
            if (event.type === 'user_input_received') {
              const text = String(event.data.text ?? '').trim();
              if (text) setPending((p) => p.filter((row) => row.text !== text || row.state !== 'sending'));
            }
          },
        }, latestSeq);
      } catch (err) {
        if (!cancelled) setError((err as Error).message ?? 'Failed to load transcript');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [sessionId]);

  const renderable = useMemo(() => filterAndCoalesce(events), [events]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [renderable.length, pending.length]);

  function autoresize(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }

  async function submitDraft() {
    const text = draft.trim();
    if (!text || sending) return;
    const id = freshIdempotencyKey();
    const echo: PendingEcho = {
      id,
      text,
      state: 'sending',
      idempotencyKey: id,
      sentAt: Date.now(),
    };
    setPending((current) => [...current, echo]);
    setDraft('');
    setSending(true);
    if (textareaRef.current) {
      textareaRef.current.value = '';
      autoresize(textareaRef.current);
    }
    try {
      const result = await sendChatMessage({
        message: text,
        sessionId,
        idempotencyKey: id,
      });
      // If we were in a "new chat" state, lock in the server-assigned
      // sessionId — the effect above will re-subscribe SSE.
      if (!sessionId && result.sessionId) {
        setSessionId(result.sessionId);
      }
      // The SSE replay will surface the user_input_received event,
      // which we listen for above and use to drop the pending echo.
      // Belt-and-braces: also drop on success here in case the SSE
      // isn't open yet.
      setPending((current) => current.filter((row) => row.id !== id));
    } catch (err) {
      const message = (err as Error).message ?? 'Failed to send';
      setPending((current) => current.map((row) =>
        row.id === id ? { ...row, state: 'failed', error: message } : row,
      ));
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  async function retryPending(echo: PendingEcho) {
    if (sending) return;
    setPending((current) => current.map((row) =>
      row.id === echo.id ? { ...row, state: 'sending', error: undefined } : row,
    ));
    setSending(true);
    try {
      const result = await sendChatMessage({
        message: echo.text,
        sessionId,
        // SAME idempotency key — server caches the response.
        idempotencyKey: echo.idempotencyKey,
      });
      if (!sessionId && result.sessionId) {
        setSessionId(result.sessionId);
      }
      setPending((current) => current.filter((row) => row.id !== echo.id));
    } catch (err) {
      const message = (err as Error).message ?? 'Failed to send';
      setPending((current) => current.map((row) =>
        row.id === echo.id ? { ...row, state: 'failed', error: message } : row,
      ));
    } finally {
      setSending(false);
    }
  }

  function discardPending(echo: PendingEcho) {
    setPending((current) => current.filter((row) => row.id !== echo.id));
  }

  async function actOnPlan(planProposalId: string, action: 'approve' | 'reject') {
    if (planActing) return;
    setPlanActing(planProposalId);
    setError(null);
    try {
      if (action === 'approve') await approvePlanProposal(planProposalId);
      else await rejectPlanProposal(planProposalId);
      setEvents((current) => current.map((event) => {
        if (
          event.type === 'conversation_completed'
          && event.data
          && event.data.planProposalId === planProposalId
        ) {
          return {
            ...event,
            data: {
              ...event.data,
              planProposalStatus: action === 'approve' ? 'approved' : 'rejected',
            },
          };
        }
        return event;
      }));
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
        <div class="chat-title">{title || (sessionId ? 'Conversation' : 'New chat')}</div>
      </div>
      <div class="chat-transcript" ref={scrollRef}>
        {error ? <div class="global-error">{error}</div> : null}
        {loading && renderable.length === 0 && pending.length === 0 ? <div class="inbox-empty">Loading…</div> : null}
        {!loading && renderable.length === 0 && pending.length === 0 ? (
          <div class="inbox-empty">{sessionId ? 'Empty session.' : 'Type a message to start a new chat.'}</div>
        ) : null}
        {renderable.map((row) => (
          <Bubble
            key={row.key}
            row={row}
            planActing={row.planProposalId ? planActing === row.planProposalId : false}
            onPlanAction={actOnPlan}
          />
        ))}
        {pending.map((echo) => (
          <PendingBubble key={echo.id} echo={echo} onRetry={retryPending} onDiscard={discardPending} />
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
          disabled={sending}
        />
        <button
          class="chat-send"
          type="submit"
          disabled={sending || draft.trim().length === 0}
          aria-label="Send"
        >
          {sending ? '…' : '↑'}
        </button>
      </form>
    </div>
  );
}

function mergeEventsBySeq(current: ChatEvent[], incoming: ChatEvent[]): ChatEvent[] {
  if (incoming.length === 0) return current;
  const bySeq = new Map<number, ChatEvent>();
  for (const e of current) bySeq.set(e.seq, e);
  for (const e of incoming) bySeq.set(e.seq, e);
  return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
}

interface RenderableRow {
  key: string;
  kind: 'user' | 'assistant' | 'tool' | 'approval' | 'error' | 'note';
  text: string;
  subtitle?: string;
  planProposalId?: string;
  planProposalStatus?: 'pending' | 'approved' | 'rejected';
  at: number;
}

function filterAndCoalesce(events: ChatEvent[]): RenderableRow[] {
  const rows: RenderableRow[] = [];
  for (const event of events) {
    const row = eventToRow(event);
    if (row) rows.push(row);
  }
  return rows;
}

function eventToRow(event: ChatEvent): RenderableRow | null {
  switch (event.type) {
    case 'user_input_received': {
      const text = String(event.data.text ?? '').trim();
      if (!text) return null;
      return { key: `${event.seq}`, kind: 'user', text, at: event.createdAt };
    }
    case 'conversation_completed': {
      const text = String(event.data.reply ?? '').trim();
      if (!text) return null;
      const planProposalId = typeof event.data.planProposalId === 'string'
        ? event.data.planProposalId
        : undefined;
      const statusRaw = typeof event.data.planProposalStatus === 'string'
        ? event.data.planProposalStatus
        : 'pending';
      const planProposalStatus =
        statusRaw === 'approved' || statusRaw === 'rejected' ? statusRaw : 'pending';
      return {
        key: `${event.seq}`,
        kind: 'assistant',
        text,
        planProposalId,
        planProposalStatus,
        at: event.createdAt,
      };
    }
    case 'tool_called': {
      const tool = String(event.data.tool ?? 'tool');
      const preview = String(event.data.argsPreview ?? '');
      return {
        key: `${event.seq}`,
        kind: 'tool',
        text: tool,
        subtitle: preview,
        at: event.createdAt,
      };
    }
    case 'approval_requested': {
      const subject = String(event.data.subject ?? event.data.tool ?? 'approval');
      return { key: `${event.seq}`, kind: 'approval', text: `Approval pending — ${subject}`, at: event.createdAt };
    }
    case 'approval_resolved': {
      const decision = String(event.data.decision ?? 'resolved');
      return { key: `${event.seq}`, kind: 'note', text: `Approval ${decision}`, at: event.createdAt };
    }
    case 'run_failed': {
      const text = String(event.data.error ?? 'Run failed');
      return { key: `${event.seq}`, kind: 'error', text, at: event.createdAt };
    }
    default:
      return null;
  }
}

function Bubble({
  row,
  planActing,
  onPlanAction,
}: {
  row: RenderableRow;
  planActing?: boolean;
  onPlanAction?: (id: string, action: 'approve' | 'reject') => void;
}) {
  if (row.kind === 'user') {
    return (
      <div class="bubble bubble-user">
        <div class="bubble-text">{row.text}</div>
      </div>
    );
  }
  if (row.kind === 'assistant') {
    return (
      <div class="bubble bubble-assistant">
        <div class="bubble-text">{row.text}</div>
        {row.planProposalId && row.planProposalStatus === 'pending' ? (
          <div class="plan-actions">
            <button
              class="approve"
              disabled={planActing}
              onClick={() => onPlanAction?.(row.planProposalId!, 'approve')}
            >
              {planActing ? '…' : 'Approve & Proceed'}
            </button>
            <button
              class="reject"
              disabled={planActing}
              onClick={() => onPlanAction?.(row.planProposalId!, 'reject')}
            >
              {planActing ? '…' : 'Reject'}
            </button>
          </div>
        ) : null}
        {row.planProposalId && row.planProposalStatus !== 'pending' ? (
          <div class="plan-status">Plan {row.planProposalStatus}.</div>
        ) : null}
      </div>
    );
  }
  if (row.kind === 'tool') {
    return (
      <div class="bubble bubble-tool">
        <span class="bubble-tool-tag">{row.text}</span>
        {row.subtitle ? <span class="bubble-tool-args">{row.subtitle}</span> : null}
      </div>
    );
  }
  if (row.kind === 'approval') {
    return <div class="bubble bubble-approval">{row.text}</div>;
  }
  if (row.kind === 'error') {
    return <div class="bubble bubble-error">{row.text}</div>;
  }
  return <div class="bubble bubble-note">{row.text}</div>;
}

interface PendingBubbleProps {
  echo: PendingEcho;
  onRetry: (echo: PendingEcho) => void;
  onDiscard: (echo: PendingEcho) => void;
}

function PendingBubble({ echo, onRetry, onDiscard }: PendingBubbleProps) {
  return (
    <div class={`bubble bubble-user pending pending-${echo.state}`}>
      <div class="bubble-text">{echo.text}</div>
      {echo.state === 'sending' ? <div class="pending-status">sending…</div> : null}
      {echo.state === 'failed' ? (
        <div class="pending-status pending-failed">
          <span>failed — {echo.error}</span>
          <button class="pending-action" onClick={() => onRetry(echo)}>retry</button>
          <button class="pending-action" onClick={() => onDiscard(echo)}>discard</button>
        </div>
      ) : null}
    </div>
  );
}
