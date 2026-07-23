import { useCallback, useRef, useState } from 'react';
import {
  createChatClientRequestId,
  postChat,
  runHarnessStream,
  watchForLateCompletion,
  cancelSession,
  cancelPendingChatRequest,
  moveSessionToBackground,
  humanHarnessText,
  type StreamHandle,
} from './chat';
import { type ApiError } from './api';
import { humanToolLabel, salientArgDetail, describeExternalWrite } from './toolLabels';
import type { ChatPostResult, HarnessEvent, PendingActionApprovalView } from './types';

// Re-exported for callers that historically imported it from here.
export { salientArgDetail };

export type MessageStatus =
  | 'thinking' | 'complete' | 'failed' | 'stopped'
  | 'awaiting-approval' | 'awaiting-reply' | 'awaiting-plan';

/** One live step in a turn's activity strip — a tool call, a spawned agent, a
 *  batch meter, or a trust check (judge verdict / watcher steer). */
export interface ActivityItem {
  id: string;
  kind: 'tool' | 'agent' | 'batch' | 'check' | 'event';
  label: string;
  detail?: string;
  provider?: 'claude' | 'codex' | 'byo' | 'glm' | 'unknown';
  status: 'running' | 'done' | 'failed';
  /** Client-clock start, for the live per-row elapsed timer while running. */
  startedAt?: number;
  /** kind 'batch' only: live meter state from authoritative batch_progress events.
   *  `throttled` flips true while the runner is backing off a provider rate-limit. */
  batch?: { done: number; total: number; failed: number; throttled?: boolean };
  /** kind 'event' only: a plain-human milestone row (an external write, a
   *  code-mode program, or — in the board drawer's unified feed — a lifecycle
   *  beat). `variant` picks the icon; `tone` its color. `status` is left set for
   *  the shared spinner/✓/✗ but the event icon is driven by `tone`. */
  variant?: 'write' | 'program' | 'lifecycle';
  tone?: 'success' | 'danger' | 'warning' | 'live' | 'muted';
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

/** Prefer an explicit provider string carried on the event (e.g. 'claude',
 *  'codex', or a BYO id) before falling back to regexing the model id — model
 *  ids miss (a BYO/renamed model reads as 'unknown' but its provider is known). */
function providerFor(d: Record<string, unknown>, model: string): ActivityItem['provider'] {
  const explicit = typeof d.provider === 'string' ? d.provider.toLowerCase() : '';
  if (explicit) {
    if (explicit === 'byo') return 'byo';
    if (/claude|anthropic/.test(explicit)) return 'claude';
    if (/glm|zhipu|zai/.test(explicit)) return 'glm';
    if (/codex|openai|gpt/.test(explicit)) return 'codex';
    // Unrecognized custom provider id: fall through to the model regex.
  }
  return providerFromModel(model);
}

const GENERIC_TURN_ERROR = 'Something went wrong on that turn — try again. (Details are in the logs.)';

export interface PendingChatPost {
  fingerprint: string;
  clientRequestId: string;
  input: string;
  sessionId: string | null;
  attachments: string[];
}

export class ChatPostCancelledError extends Error {
  constructor(readonly acceptedLate = false) {
    super(acceptedLate ? 'Chat request was accepted after it was stopped.' : 'Chat request was stopped.');
    this.name = 'AbortError';
  }
}

function isChatPostCancelledError(error: unknown): error is ChatPostCancelledError {
  return error instanceof ChatPostCancelledError
    || (error instanceof Error && error.name === 'AbortError');
}

function throwIfChatPostCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ChatPostCancelledError();
}

/** Keep one request identity until its 202 is observed. If the daemon accepted
 * the first POST but the browser lost that response, an automatic or explicit
 * resend of the same turn replays the durable receipt instead of starting a
 * second model/tool run. */
export function retainPendingChatPost(
  previous: PendingChatPost | null,
  payload: { input: string; sessionId: string | null; attachments: string[] },
  createId: () => string = createChatClientRequestId,
): PendingChatPost {
  const fingerprint = JSON.stringify([payload.sessionId ?? '', payload.input, payload.attachments]);
  if (previous?.fingerprint === fingerprint) return previous;
  return {
    fingerprint,
    clientRequestId: createId(),
    input: payload.input,
    sessionId: payload.sessionId,
    attachments: [...payload.attachments],
  };
}

function isRetryableChatPostError(error: unknown): boolean {
  const status = Number((error as Partial<ApiError> | null)?.status);
  return status === 0 || status >= 500 || (!Number.isFinite(status) && error instanceof TypeError);
}

/** Bounded transport recovery only. Every attempt carries the exact same
 * request id; the server's durable receipt makes these retries side-effect
 * free. The retained ref also survives beyond this budget for a manual resend. */
export async function postPendingChatWithRetry(
  pending: PendingChatPost,
  options: {
    retryDelaysMs?: number[];
    transport?: typeof postChat;
    wait?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
    /** A POST can cross the server boundary just before Stop wins locally.
     * The acknowledgement still carries the authoritative session id, so
     * cancel it before rejecting and never return a streamable result. */
    onLateAccepted?: (result: ChatPostResult) => Promise<void> | void;
  } = {},
): Promise<ChatPostResult> {
  const retryDelaysMs = options.retryDelaysMs ?? [500, 1_500, 3_500, 7_500];
  const transport = options.transport ?? postChat;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitForRetry = async (ms: number): Promise<void> => {
    throwIfChatPostCancelled(options.signal);
    if (!options.signal) {
      await wait(ms);
      return;
    }
    const signal = options.signal;
    let onAbort: (() => void) | null = null;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new ChatPostCancelledError());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([wait(ms), aborted]);
      throwIfChatPostCancelled(signal);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  };
  let attempt = 0;
  while (true) {
    throwIfChatPostCancelled(options.signal);
    try {
      const result = await transport(
        pending.input,
        pending.sessionId,
        pending.attachments,
        pending.clientRequestId,
      );
      if (options.signal?.aborted) {
        try {
          await options.onLateAccepted?.(result);
        } finally {
          throw new ChatPostCancelledError(true);
        }
      }
      return result;
    } catch (error) {
      if (isChatPostCancelledError(error)) throw error;
      throwIfChatPostCancelled(options.signal);
      if (!isRetryableChatPostError(error) || attempt >= retryDelaysMs.length) throw error;
      await waitForRetry(retryDelaysMs[attempt]);
      attempt += 1;
    }
  }
}

/** A backend error string is unsafe to show raw when it's a stack trace, a
 *  transport code, embedded JSON, or just very long — swap those for a calm line. */
function looksRawError(s: string): boolean {
  return s.length > 200 || /at\s+\w+\s+\(|stack|ECONN|ETIMEDOUT|\{"/.test(s);
}

/** Fold one harness event into the turn's activity list. Returns the SAME array
 *  reference when nothing changed (so the caller can skip a re-render). Tools are
 *  correlated called→returned by callId when available, falling back to name for
 *  older events; agents (run_worker) are keyed by item; run_batch renders as ONE
 *  live meter row driven by authoritative batch_progress counts. */
export function reduceActivity(prev: ActivityItem[], ev: HarnessEvent): ActivityItem[] {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  const tool = typeof d.tool === 'string' ? d.tool : typeof d.toolName === 'string' ? d.toolName : '';
  const callId = typeof d.callId === 'string' ? d.callId : typeof d.call_id === 'string' ? d.call_id : '';
  const item = typeof d.item === 'string' ? d.item : '';
  const model = typeof d.model === 'string' ? d.model : '';
  // Server names can contain underscores (mcp__some_server__tool) — a non-greedy
  // `.+?` strips the whole `mcp__…__` prefix; `[^_]+` stopped at the first `_`.
  const toolLabel = humanToolLabel(tool, d.args);
  switch (ev.type) {
    case 'batch_started': {
      const batchId = typeof d.batchId === 'string' ? d.batchId : `${prev.length}`;
      const total = typeof d.items === 'number' ? d.items : 0;
      const slugRaw = typeof d.slug === 'string' && d.slug ? d.slug : typeof d.tool === 'string' ? d.tool : 'items';
      const verb = d.sideEffect === 'send' ? 'Sending' : d.sideEffect === 'write' ? 'Writing' : 'Fetching';
      const label = `${verb} ${total} × ${slugRaw.replace(/^mcp__.+?__/, '').replace(/_/g, ' ').toLowerCase()}`;
      return [...prev, { id: `b-${batchId}`, kind: 'batch', label, status: 'running', startedAt: Date.now(), batch: { done: 0, total, failed: 0 } }];
    }
    case 'batch_progress': {
      const id = `b-${typeof d.batchId === 'string' ? d.batchId : ''}`;
      if (!prev.some((a) => a.kind === 'batch' && a.id === id)) return prev;
      const done = typeof d.done === 'number' ? d.done : 0;
      const total = typeof d.total === 'number' ? d.total : 0;
      const failed = typeof d.failed === 'number' ? d.failed : 0;
      const itemId = typeof d.itemId === 'string' ? d.itemId : '';
      // A throttled event is a batch-level back-off pause (no per-item advance) —
      // keep the counts, flip the meter into "throttled — backing off" until the
      // next real item update clears it.
      const throttled = d.throttled === true;
      return prev.map((a) => (a.kind === 'batch' && a.id === id
        ? { ...a, batch: { done, total, failed, ...(throttled ? { throttled: true } : {}) }, ...(itemId ? { detail: itemId } : {}) }
        : a));
    }
    case 'batch_completed': {
      const id = `b-${typeof d.batchId === 'string' ? d.batchId : ''}`;
      const failed = typeof d.failed === 'number' ? d.failed : 0;
      const halted = d.halted === true;
      return prev.map((a) => (a.kind === 'batch' && a.id === id
        ? {
            ...a,
            status: failed > 0 || halted ? 'failed' : 'done',
            detail: undefined,
            batch: a.batch ? { ...a.batch, done: typeof d.succeeded === 'number' ? (d.succeeded as number) + failed : a.batch.done, failed } : a.batch,
          }
        : a));
    }
    case 'tool_called': {
      if (!tool || tool === 'run_worker' || /run_worker/.test(tool)) return prev; // agents render as agents, not a tool row
      if (d.batchMode === true) return prev; // batch items render as ONE live meter row, not N tool rows
      const detail = salientArgDetail(d.args);
      return [...prev, { id: callId ? `t-${callId}` : `t${prev.length}-${tool}`, kind: 'tool', label: toolLabel, ...(detail ? { detail } : {}), startedAt: Date.now(), status: 'running' }];
    }
    case 'tool_returned': {
      if (d.batchMode === true) return prev; // counted via batch_progress
      // The backend now carries data.ok — a returned tool can have failed.
      const status: ActivityItem['status'] = d.ok === false ? 'failed' : 'done';
      if (callId) {
        const id = `t-${callId}`;
        if (prev.some((a) => a.kind === 'tool' && a.id === id)) {
          return prev.map((a) => (a.kind === 'tool' && a.id === id ? { ...a, status } : a));
        }
      }
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].kind === 'tool' && prev[i].status === 'running' && prev[i].label === toolLabel) {
          return prev.map((a, j) => (j === i ? { ...a, status } : a));
        }
      }
      return prev;
    }
    case 'worker_started': {
      if (!item) return prev;
      const role = typeof d.role === 'string' ? d.role : '';
      return [...prev, { id: `a-${item}`, kind: 'agent', label: role ? `${role}: ${item}` : item, detail: model || undefined, provider: providerFor(d, model), status: 'running' }];
    }
    case 'worker_result': {
      // UPSERT: on non-Claude (orchestrator) lanes worker_started historically
      // wasn't emitted, so there's no `a-${item}` row to update — append one with
      // the final status so the agent still appears in the strip.
      if (!item) return prev;
      const id = `a-${item}`;
      const status: ActivityItem['status'] = d.ok === false ? 'failed' : 'done';
      const reason = typeof d.reason === 'string' ? d.reason.trim() : '';
      // Plain-human default: "<item> ✓" or "<item> ✗ — <short reason>". The model
      // id is power-user detail (demoted behind the drawer's "details" toggle).
      if (prev.some((a) => a.kind === 'agent' && a.id === id)) {
        return prev.map((a) => (a.kind === 'agent' && a.id === id
          ? {
              ...a,
              status,
              // Keep the worker_started label (it carries the role); on failure
              // append the short reason so "<item> ✗ <reason>" reads by default.
              ...(status === 'failed' && reason ? { label: `${a.label} — ${reason.slice(0, 80)}` } : {}),
              ...(model ? { detail: model, provider: providerFor(d, model) } : {}),
            }
          : a));
      }
      const role = typeof d.role === 'string' ? d.role : '';
      const base = role ? `${role}: ${item}` : item;
      const label = status === 'failed' && reason ? `${base} — ${reason.slice(0, 80)}` : base;
      return [...prev, { id, kind: 'agent', label, detail: model || undefined, provider: providerFor(d, model), status }];
    }
    case 'worker_capped':
      return prev.map((a) => (a.kind === 'agent' && a.id === `a-${item}` ? { ...a, status: 'failed' } : a));
    // Trust cockpit: judge verdicts + watcher steers appear as 'check' rows so
    // the strip shows not only what the agent DID but what verified it.
    case 'verdict_recorded': {
      const door = typeof d.door === 'string' ? d.door.replace(/_/g, ' ') : 'judge';
      const pass = d.pass === true;
      const failedOpen = d.failedOpen === true;
      const scorecard = typeof d.criteriaMet === 'number' && typeof d.criteriaTotal === 'number' ? ` ${d.criteriaMet}/${d.criteriaTotal}` : '';
      const reason = typeof d.reason === 'string' ? d.reason : '';
      return [...prev, {
        id: `v${prev.length}-${door}`,
        kind: 'check',
        label: failedOpen ? `Verdict · ${door}: accepted (judge unavailable)` : `Verdict · ${door}${scorecard}: ${pass ? 'passed' : 'not passed'}`,
        ...(reason ? { detail: reason } : {}),
        status: pass && !failedOpen ? 'done' : 'failed',
      }];
    }
    case 'heartbeat': {
      if (d.kind !== 'watcher_steer') return prev;
      const miss = typeof d.miss === 'string' ? d.miss : '';
      const steer = typeof d.steer === 'string' ? d.steer : '';
      const detail = [miss, steer && steer !== miss ? steer : ''].filter(Boolean).join(' → ');
      return [...prev, { id: `w${prev.length}`, kind: 'check', label: 'Watcher steered', ...(detail ? { detail } : {}), status: 'done' }];
    }
    // Real effects on the outside world — the plain-human "Sent a message to …",
    // "Created a record", "Saved a file" rows. Phrasing mirrors the server's
    // describeExternalWrite (work-report.ts) so chat, the drawer feed, and the
    // report-back message all speak in ONE vocabulary. A failed/orphaned write
    // is the same line with an honest tail.
    case 'external_write':
    case 'external_write_failed':
    case 'external_write_orphaned': {
      const shapeKey = typeof d.shapeKey === 'string' ? d.shapeKey : '';
      const writeTool = typeof d.toolName === 'string' ? d.toolName : tool;
      const targets = Array.isArray(d.targets) ? d.targets.filter((t): t is string => typeof t === 'string') : [];
      const base = describeExternalWrite(shapeKey, writeTool, targets);
      const failed = ev.type === 'external_write_failed';
      const orphaned = ev.type === 'external_write_orphaned';
      const key = callId || shapeKey || writeTool || `${prev.length}`;
      return [...prev, {
        id: `x-${ev.type}-${key}`,
        kind: 'event',
        variant: 'write',
        label: failed ? `${base} — failed` : orphaned ? `${base} — timed out, may have landed` : base,
        status: failed ? 'failed' : 'done',
        tone: failed ? 'danger' : orphaned ? 'warning' : 'success',
      }];
    }
    // ONE row per code-mode program: "Ran a batch program (N tool calls)". The
    // per-call plumbing stays inside the sandbox — the user sees the outcome, not
    // the machinery.
    case 'codemode_program_summary': {
      const rpc = typeof d.rpcCalls === 'number' ? d.rpcCalls : 0;
      const ok = d.ok !== false;
      const label = `Ran a batch program (${rpc} tool call${rpc === 1 ? '' : 's'})`;
      return [...prev, {
        id: `cm-${prev.length}`,
        kind: 'event',
        variant: 'program',
        label: ok ? label : `${label} — didn't finish`,
        status: ok ? 'done' : 'failed',
        tone: ok ? 'muted' : 'danger',
      }];
    }
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
    case 'heartbeat': {
      // Watcher steer: show the actual course-correction, not a generic pulse —
      // this is the "co-pilot caught something" moment the user should see.
      if (d.kind === 'watcher_steer' && typeof d.steer === 'string' && d.steer) {
        return `Watcher: ${d.steer}`;
      }
      return 'Still working…';
    }
    default: return null;
  }
}

export function pendingActionFromEvent(value: unknown): PendingActionApprovalView | undefined {
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
  const lateWatchRef = useRef<{ cancel: () => void } | null>(null);
  const pendingPostRef = useRef<PendingChatPost | null>(null);
  const postAbortRef = useRef<AbortController | null>(null);
  const activeRunRef = useRef<ChatPostResult | null>(null);
  const pendingBackgroundRef = useRef<{ assistantId: string } | null>(null);
  const backgroundInFlightRef = useRef(false);

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
    } else if (ev.type === 'stall_retry_attempted') {
      // The streamed draft was a DETECTED-BAD reply (e.g. the model claiming it
      // has no tools while the surface is attached). Never leave it on screen
      // as if it were an answer — clear it and show the retry honestly
      // (live 2026-07-08: a flaked "I can't execute this" reply stayed visible
      // while the retry was already succeeding underneath).
      patch(assistantId, { text: '', progress: 'First attempt came back malformed — retrying now…' });
    } else if (ev.type === 'run_failed') {
      const errStr = String(d.error ?? '').trim();
      const text = !errStr || looksRawError(errStr) ? GENERIC_TURN_ERROR : `Something went wrong: ${errStr}`;
      patch(assistantId, { text, status: 'failed', progress: undefined });
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

  const handoffAcceptedRun = useCallback(async (
    accepted: ChatPostResult,
    assistantId: string,
  ): Promise<boolean> => {
    if (backgroundInFlightRef.current) return false;
    backgroundInFlightRef.current = true;
    patch(assistantId, { progress: 'Moving this exact run to the background…' });
    try {
      const out = await moveSessionToBackground(accepted);
      // End only this foreground view after the server durably confirms the
      // replacement task. A failed/stale handoff leaves the stream attached.
      streamRef.current?.stop();
      streamRef.current = null;
      if (activeRunRef.current === accepted) activeRunRef.current = null;
      patch(assistantId, {
        status: 'complete',
        progress: undefined,
        text: out.text || 'Moved to the background — it will report back here.',
      });
      setBusy(false);
      return true;
    } catch {
      patch(assistantId, {
        progress: 'The background handoff was not confirmed, so this run is still working here.',
      });
      return false;
    } finally {
      backgroundInFlightRef.current = false;
    }
  }, [patch]);

  const send = useCallback(async (input: { text: string; attachmentIds?: string[]; attachmentNames?: string[] }) => {
    const text = input.text.trim();
    const attachmentIds = input.attachmentIds ?? [];
    if (!text && attachmentIds.length === 0) return;
    if (busy) return;

    const userId = nextId();
    const assistantId = nextId();
    // A new turn owns the session's event stream — a still-running late watch
    // from a previous stopped turn would misattribute this turn's events.
    lateWatchRef.current?.cancel();
    lateWatchRef.current = null;
    // Do not carry a reusable session's prior attempt into this turn. If Stop
    // wins before the new 202 arrives, onLateAccepted will cancel the exact
    // attempt from that acknowledgement instead of guessing by session id.
    activeRunRef.current = null;
    pendingBackgroundRef.current = null;
    activeAssistantId.current = assistantId;
    setMessages((prev) => [
      ...prev,
      { id: userId, role: 'user', text, attachmentNames: input.attachmentNames },
      { id: assistantId, role: 'assistant', text: '', status: 'thinking', progress: 'Starting up…' },
    ]);
    setBusy(true);

    const postAbort = new AbortController();
    postAbortRef.current = postAbort;

    try {
      const pending = retainPendingChatPost(pendingPostRef.current, {
        input: text,
        sessionId: sessionIdRef.current,
        attachments: attachmentIds,
      });
      pendingPostRef.current = pending;
      const body = await postPendingChatWithRetry(pending, {
        signal: postAbort.signal,
        onLateAccepted: async (accepted) => {
          // Stop won locally while the POST was crossing the daemon boundary.
          // Use the late acknowledgement to kill that exact durable session,
          // but never attach its stream or revive the stopped chat bubble.
          if (postAbortRef.current === postAbort) sessionIdRef.current = accepted.sessionId;
          const confirmed = await cancelSession(accepted);
          if (confirmed && pendingPostRef.current === pending) pendingPostRef.current = null;
        },
      });
      // Only observing the server's 202 proves this turn identity is safely
      // bound. Until then it remains reusable for an explicit resend.
      if (pendingPostRef.current === pending) pendingPostRef.current = null;
      sessionIdRef.current = body.sessionId;
      activeRunRef.current = body;
      // The background button is available immediately for responsiveness,
      // but authority arrives only in the 202. Queue an early click and apply
      // it to THIS acknowledgement rather than guessing from the session id.
      const pendingBackground = pendingBackgroundRef.current as { assistantId: string } | null;
      if (pendingBackground?.assistantId === assistantId) {
        pendingBackgroundRef.current = null;
        if (await handoffAcceptedRun(body, assistantId)) return;
      }
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
          const note = 'I lost the live connection — still watching for the result in the background. Say “continue” to nudge it, or check Inbox.';
          return { ...m, text: m.text ? `${m.text}\n\n${note}` : note, status: 'stopped', progress: undefined };
        }));
        // The run often FINISHES server-side after a restart (restart recovery /
        // auto-resume) — keep a slow watch on the session and deliver the real
        // result over the "stopped" note instead of stranding a completed run.
        // (Any prior watch was cancelled at the top of this send.)
        lateWatchRef.current = watchForLateCompletion(body.sessionId, handle.getLastSeq(), (ev) => applyEvent(assistantId, ev));
      }
    } catch (err) {
      if (isChatPostCancelledError(err)) return;
      const e = err as ApiError;
      // Validation/conflict errors prove the server did not accept this exact
      // request. Transport/restart failures retain it for a safe replay.
      if (!isRetryableChatPostError(e) && postAbortRef.current === postAbort) pendingPostRef.current = null;
      if (e.status === 404) sessionIdRef.current = null;
      const msg = (e.message || '').trim();
      const text = !msg || looksRawError(msg) ? GENERIC_TURN_ERROR : `Couldn't send: ${msg}`;
      patch(assistantId, { text, status: 'failed', progress: undefined });
    } finally {
      // A stopped POST can finish after the user has already started another
      // turn. Never let the stale promise clear the newer turn's controller,
      // active bubble, or busy state.
      if (postAbortRef.current === postAbort) {
        postAbortRef.current = null;
        if (activeAssistantId.current === assistantId) activeAssistantId.current = null;
        setBusy(false);
      }
      const pendingBackground = pendingBackgroundRef.current as { assistantId: string } | null;
      if (pendingBackground?.assistantId === assistantId) pendingBackgroundRef.current = null;
    }
  }, [busy, applyEvent, handoffAcceptedRun, patch]);

  const stop = useCallback(() => {
    const aid = activeAssistantId.current;
    const accepted = activeRunRef.current;
    const pending = pendingPostRef.current;
    pendingBackgroundRef.current = null;
    postAbortRef.current?.abort();
    streamRef.current?.stop();
    streamRef.current = null;
    // Stopping before any text streamed in otherwise leaves an empty bubble.
    if (aid) setMessages((prev) => prev.map((m) => (m.id === aid
      ? { ...m, status: 'stopped', progress: undefined, text: m.text.trim() ? m.text : 'Stopped.' }
      : m)));
    if (accepted) {
      void cancelSession(accepted).then((confirmed) => {
        if (confirmed || !aid) return;
        setMessages((prev) => prev.map((m) => (m.id === aid
          ? {
              ...m,
              status: 'failed',
              progress: undefined,
              text: 'Stop closed this view, but the server did not confirm that the exact run attempt was cancelled. Open Run Environment to check it before retrying.',
            }
          : m)));
      });
    } else if (pending) {
      // Stop may win before the 202 carries an attempt id. Persist a negative
      // receipt under the client request id; do not discard that identity until
      // the server confirms it can never execute later.
      void cancelPendingChatRequest(pending.clientRequestId).then((confirmed) => {
        if (confirmed && pendingPostRef.current === pending) pendingPostRef.current = null;
        if (confirmed || !aid) return;
        setMessages((prev) => prev.map((m) => (m.id === aid
          ? {
              ...m,
              status: 'failed',
              progress: undefined,
              text: 'Stop closed this view, but Clementine could not record the server-side cancellation. Open Run Environment to check it before retrying.',
            }
          : m)));
      });
    }
    setBusy(false);
  }, []);

  /** User-initiated "continue in background" (the ctrl+b model): detach the
   *  running turn to a durable background task that picks up where the
   *  foreground left off and reports back to this chat. The foreground bubble
   *  closes honestly with the handoff message instead of "Stopped." */
  const background = useCallback(async () => {
    const aid = activeAssistantId.current;
    if (!aid || backgroundInFlightRef.current) return;
    const accepted = activeRunRef.current;
    if (accepted) {
      await handoffAcceptedRun(accepted, aid);
      return;
    }
    // The POST has not returned its exact attempt yet. Remember intent and let
    // send() execute it against that acknowledgement before attaching SSE.
    if (postAbortRef.current) {
      pendingBackgroundRef.current = { assistantId: aid };
      patch(aid, { progress: 'Waiting for this run’s identity, then moving it to the background…' });
    }
  }, [handoffAcceptedRun, patch]);

  const reset = useCallback(() => {
    postAbortRef.current?.abort();
    postAbortRef.current = null;
    streamRef.current?.stop();
    streamRef.current = null;
    activeAssistantId.current = null;
    sessionIdRef.current = null;
    pendingPostRef.current = null;
    pendingBackgroundRef.current = null;
    activeRunRef.current = null;
    setMessages([]);
    setBusy(false);
  }, []);

  return { messages, busy, send, stop, background, reset, sessionId: sessionIdRef };
}
