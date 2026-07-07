import { useCallback, useRef, useState } from 'react';
import { postChat, runHarnessStream, cancelSession, humanHarnessText, type StreamHandle } from './chat';
import type { ApiError } from './api';
import type { HarnessEvent, PendingActionApprovalView } from './types';

export type MessageStatus =
  | 'thinking' | 'complete' | 'failed' | 'stopped'
  | 'awaiting-approval' | 'awaiting-reply' | 'awaiting-plan';

/** One live step in a turn's activity strip — a tool call or a spawned agent. */
export interface ActivityItem {
  id: string;
  kind: 'tool' | 'agent';
  label: string;
  detail?: string;
  provider?: 'claude' | 'codex' | 'glm' | 'unknown';
  status: 'running' | 'done' | 'failed';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status?: MessageStatus;
  progress?: string;
  /** Live, accumulated tool calls + spawned agents for THIS turn — the premium
   *  "watch the team work" strip (vs. a single rolling label). */
  activity?: ActivityItem[];
  approval?: { subject: string; reason?: string; approvalId?: string | null; pendingAction?: PendingActionApprovalView };
  planProposalId?: string;
  attachmentNames?: string[];
}

let idSeq = 0;
const nextId = () => `m${++idSeq}-${performance.now().toFixed(0)}`;
const EMPTY_ACTIVITY: ActivityItem[] = [];

function providerFromModel(model: string): ActivityItem['provider'] {
  const id = model.toLowerCase();
  if (/claude|sonnet|opus|haiku|fable|anthropic/.test(id)) return 'claude';
  if (/glm|zhipu|zai/.test(id)) return 'glm';
  if (/gpt|^o[134]|codex|openai/.test(id)) return 'codex';
  return 'unknown';
}

/** Fold one harness event into the turn's activity list. Returns the SAME array
 *  reference when nothing changed (so the caller can skip a re-render). Tools are
 *  correlated called→returned by name; agents (run_worker) keyed by item. */
function reduceActivity(prev: ActivityItem[], ev: HarnessEvent): ActivityItem[] {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  const tool = typeof d.tool === 'string' ? d.tool : typeof d.toolName === 'string' ? d.toolName : '';
  const item = typeof d.item === 'string' ? d.item : '';
  const model = typeof d.model === 'string' ? d.model : '';
  const toolLabel = tool.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ');
  switch (ev.type) {
    case 'tool_called':
      if (!tool || tool === 'run_worker' || /run_worker/.test(tool)) return prev; // agents render as agents, not a tool row
      return [...prev, { id: `t${prev.length}-${tool}`, kind: 'tool', label: toolLabel, status: 'running' }];
    case 'tool_returned': {
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].kind === 'tool' && prev[i].status === 'running' && prev[i].label === toolLabel) {
          return prev.map((a, j) => (j === i ? { ...a, status: 'done' } : a));
        }
      }
      return prev;
    }
    case 'worker_started': {
      if (!item) return prev;
      const role = typeof d.role === 'string' ? d.role : '';
      return [...prev, { id: `a-${item}`, kind: 'agent', label: role ? `${role}: ${item}` : item, detail: model || undefined, provider: providerFromModel(model), status: 'running' }];
    }
    case 'worker_result':
      return prev.map((a) => (a.kind === 'agent' && a.id === `a-${item}`
        ? { ...a, status: d.ok === false ? 'failed' : 'done', ...(model ? { detail: model, provider: providerFromModel(model) } : {}) }
        : a));
    case 'worker_capped':
      return prev.map((a) => (a.kind === 'agent' && a.id === `a-${item}` ? { ...a, status: 'failed' } : a));
    default:
      return prev;
  }
}

/** A short, human label for an intermediate event (the "working on…" line). */
function progressLabel(ev: HarnessEvent): string | null {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  const tool = typeof d.tool === 'string' ? d.tool : typeof d.toolName === 'string' ? d.toolName : '';
  switch (ev.type) {
    case 'turn_started': return 'Thinking…';
    case 'plan_drafted':
    case 'plan_first_started': return 'Drafting a plan…';
    case 'step_started': return typeof d.title === 'string' ? String(d.title) : 'Working on a step…';
    case 'tool_called': return tool ? `Using ${tool.replace(/_/g, ' ')}…` : 'Using a tool…';
    case 'tool_returned': return tool ? `Got results from ${tool.replace(/_/g, ' ')}` : 'Got results';
    case 'handoff': return 'Handing off…';
    // Structured-decision repair loop (stall retry): without a label these
    // attempts are INVISIBLE — a 2026-07-03 codex turn burned ~51s across three
    // silent attempts and read as "the agent just isn't working".
    case 'stall_retry_attempted': return 'That reply came back malformed — retrying…';
    case 'memory_signals_captured': return 'Learning from this…';
    // Mid-turn keep-alive fired while the brain reasons BETWEEN tool calls. With
    // no tool/plan event to relabel, the progress line otherwise freezes on the
    // last "Got results from X" through a long silent reasoning phase and reads
    // as stuck (observed: a ~4-min codex reasoning call showed no movement). The
    // animated ThinkingDots + this label make an active-but-quiet turn legible.
    case 'heartbeat': return 'Still working…';
    default: return null;
  }
}

function pendingActionFromEvent(value: unknown): PendingActionApprovalView | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Partial<PendingActionApprovalView>;
  if (typeof record.id !== 'string' || !record.id) return undefined;
  if (typeof record.toolName !== 'string' || !record.toolName) return undefined;
  return {
    id: record.id,
    title: typeof record.title === 'string' ? record.title : record.id,
    summary: typeof record.summary === 'string' ? record.summary : '',
    kind: typeof record.kind === 'string' ? record.kind : 'other',
    status: typeof record.status === 'string' ? record.status : 'queued',
    toolName: record.toolName,
    targetSummary: typeof record.targetSummary === 'string' ? record.targetSummary : '',
    preview: typeof record.preview === 'string' ? record.preview : '',
    risk: typeof record.risk === 'string' ? record.risk : '',
    rollback: typeof record.rollback === 'string' ? record.rollback : '',
    payload: record.payload,
    payloadHash: typeof record.payloadHash === 'string' ? record.payloadHash : '',
    idempotencyKey: typeof record.idempotencyKey === 'string' ? record.idempotencyKey : '',
    approvalId: typeof record.approvalId === 'string' ? record.approvalId : null,
    resultSummary: typeof record.resultSummary === 'string' ? record.resultSummary : null,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  };
}

export interface UseChatOptions {
  /** Resume an existing harness session (its turns post back to this id). */
  initialSessionId?: string | null;
  /** Seed the thread with already-loaded history (e.g. a reopened session). */
  initialMessages?: ChatMessage[];
}

export function useChat(options?: UseChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>(options?.initialMessages ?? []);
  const [busy, setBusy] = useState(false);
  const sessionIdRef = useRef<string | null>(options?.initialSessionId ?? null);
  const streamRef = useRef<StreamHandle | null>(null);
  const activeAssistantId = useRef<string | null>(null);

  const patch = useCallback((id: string, fields: Partial<ChatMessage>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...fields } : m)));
  }, []);

  const applyEvent = useCallback((assistantId: string, ev: HarnessEvent) => {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    if (ev.type === 'stream_token') {
      // Token-level streaming: append delta to current assistant text
      const delta = typeof d.delta === 'string' ? d.delta : '';
      if (delta) {
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + delta } : m)));
      }
    } else if (ev.type === 'conversation_completed') {
      const text = humanHarnessText((d.reply ?? d.summary), '');
      const reason = typeof d.reason === 'string' ? d.reason : '';
      const planProposalId = typeof d.planProposalId === 'string' ? d.planProposalId : '';
      const awaitingContinue = reason === 'awaiting_continue' || reason === 'limit_exceeded';
      if (reason === 'plan_first' && planProposalId) {
        patch(assistantId, { text: text || 'I drafted a plan — approve it to go ahead.', status: 'awaiting-plan', planProposalId, progress: undefined });
      } else {
        patch(assistantId, {
          text: text || (reason === 'no_structured_output' ? '(Finished without a written reply.)' : '(Done.)'),
          status: awaitingContinue ? 'stopped' : 'complete',
          progress: undefined,
        });
      }
    } else if (ev.type === 'run_failed') {
      patch(assistantId, { text: `Something went wrong: ${String(d.error ?? 'failed')}`, status: 'failed', progress: undefined });
    } else if (ev.type === 'conversation_limit_exceeded') {
      patch(assistantId, { status: 'stopped', progress: undefined });
    } else if (ev.type === 'awaiting_user_input') {
      patch(assistantId, { text: String(d.question ?? 'I have a question for you.'), status: 'awaiting-reply', progress: undefined });
    } else if (ev.type === 'approval_requested') {
      patch(assistantId, {
        status: 'awaiting-approval',
        progress: undefined,
        approval: {
          subject: String(d.subject ?? d.tool ?? 'this action'),
          reason: typeof d.reason === 'string' ? d.reason : undefined,
          approvalId: typeof d.approvalId === 'string' ? d.approvalId : null,
          pendingAction: pendingActionFromEvent(d.pendingAction),
        },
      });
    } else {
      const label = progressLabel(ev);
      setMessages((prev) => prev.map((m) => {
        if (m.id !== assistantId) return m;
        const cur = m.activity ?? EMPTY_ACTIVITY;
        const activity = reduceActivity(cur, ev);
        const changed = activity !== cur;
        if (!changed && !label) return m;
        return { ...m, ...(changed ? { activity } : {}), ...(label ? { progress: label } : {}) };
      }));
    }
  }, [patch]);

  const send = useCallback(async (input: { text: string; attachmentIds?: string[]; attachmentNames?: string[] }) => {
    const text = input.text.trim();
    const attachmentIds = input.attachmentIds ?? [];
    if (!text && attachmentIds.length === 0) return;
    if (busy) return;

    const userId = nextId();
    const assistantId = nextId();
    activeAssistantId.current = assistantId;
    setMessages((prev) => [
      ...prev,
      { id: userId, role: 'user', text, attachmentNames: input.attachmentNames },
      { id: assistantId, role: 'assistant', text: '', status: 'thinking', progress: 'Starting up…' },
    ]);
    setBusy(true);

    try {
      const body = await postChat(text, sessionIdRef.current, attachmentIds);
      sessionIdRef.current = body.sessionId;
      const handle = runHarnessStream(body.sessionId, {
        sinceSeq: body.sinceSeq ?? 0,
        onEvent: (ev) => applyEvent(assistantId, ev),
      });
      streamRef.current = handle;
      const result = await handle.promise;
      streamRef.current = null;
      if (!result.ok) {
        setMessages((prev) => prev.map((m) => {
          if (m.id !== assistantId) return m;
          if (m.status && m.status !== 'thinking') return m; // a terminal event already landed
          const note = 'I lost the live connection before this finished. Check Inbox for the latest, or say “continue”.';
          return { ...m, text: m.text ? `${m.text}\n\n${note}` : note, status: 'stopped', progress: undefined };
        }));
      }
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 404) sessionIdRef.current = null;
      patch(assistantId, { text: `Couldn't send: ${e.message || 'error'}`, status: 'failed', progress: undefined });
    } finally {
      activeAssistantId.current = null;
      setBusy(false);
    }
  }, [busy, applyEvent, patch]);

  const stop = useCallback(() => {
    const sid = sessionIdRef.current;
    streamRef.current?.stop();
    streamRef.current = null;
    if (activeAssistantId.current) patch(activeAssistantId.current, { status: 'stopped', progress: undefined });
    if (sid) void cancelSession(sid);
    setBusy(false);
  }, [patch]);

  const reset = useCallback(() => {
    sessionIdRef.current = null;
    setMessages([]);
  }, []);

  return { messages, busy, send, stop, reset, sessionId: sessionIdRef };
}
