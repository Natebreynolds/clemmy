import { acceptReplayEvent, copyReplayCursor, createReplayCursor, pollRecentReplayPages, type ReplayCursor } from './replay-cursor';
import { readLiveApprovalControl } from '@clem/chat-engine';
import type { TaskMode } from './task-mode';
/**
 * Chat plumbing — ports the legacy console's chat-dock streaming
 * (console.ts ~19877) to the React app: POST /api/harness/chat, then an
 * EventSource over /api/sessions/:id/events with reconnect (?sinceSeq=)
 * and a /events/recent JSON fallback so a finished run is never lost to a
 * dropped socket. All same-origin; auth via the session cookie.
 */
import { apiPost } from './api';
import { getAuthToken } from './bootstrap';
import type { HarnessEvent, ChatPostResult, AttachResult } from './types';

/**
 * Events that end a streaming turn (the composer re-enables after these).
 * Budget-limit telemetry is paired with a user-facing conversation_completed
 * reply, so it must update status without closing the stream first.
 */
export function isTerminalEvent(type: string): boolean {
  return (
    type === 'conversation_completed' ||
    type === 'run_failed' ||
    type === 'awaiting_user_input' ||
    type === 'approval_requested' ||
    // Host-owned workflow dispatch: the foreground turn is the ACK. The
    // workflow's later conversation_completed arrives on the late watch.
    type === 'async_work_dispatched'
  );
}

/** Extract human-facing text from an event's data (reply || summary || raw). */
export function humanHarnessText(value: unknown, fallback = ''): string {
  if (value == null) return fallback;
  if (typeof value === 'object') {
    const v = value as { reply?: unknown; summary?: unknown };
    const reply = typeof v.reply === 'string' ? v.reply.trim() : '';
    const summary = typeof v.summary === 'string' ? v.summary.trim() : '';
    return reply || summary || fallback;
  }
  const text = String(value).trim();
  if (!text) return fallback;
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try {
      const parsed = JSON.parse(text) as { reply?: unknown; summary?: unknown };
      const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
      const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
      if (reply || summary) return reply || summary;
    } catch { /* not JSON */ }
  }
  return text;
}

function withToken(path: string): string {
  const token = getAuthToken();
  if (!token) return path;
  return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

/** Minted by useChat before the first POST so every transport replay carries
 * the same durable turn identity. */
export function createChatClientRequestId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function postChat(
  input: string,
  sessionId: string | null,
  attachments: string[],
  clientRequestId: string,
  taskMode?: TaskMode,
): Promise<ChatPostResult> {
  const result = await apiPost<ChatPostResult>('/api/harness/chat', {
    input,
    sessionId: sessionId || undefined,
    attachments,
    clientRequestId,
    ...(taskMode ? { taskMode } : {}),
  });
  if (!result || typeof result.sessionId !== 'string' || !result.sessionId) {
    throw Object.assign(new TypeError('chat acknowledgement was incomplete'), { status: 0 });
  }
  if (
    ['started', 'planning', 'resuming'].includes(result.status)
    && (!chatCancelEndpoint(result) || !chatBackgroundEndpoint(result))
  ) {
    throw Object.assign(new TypeError('chat acknowledgement omitted exact run control'), { status: 0 });
  }
  return result;
}

export function chatBackgroundEndpoint(
  accepted: Pick<ChatPostResult, 'sessionId' | 'attemptId' | 'runScopeId' | 'backgroundEndpoint'>,
): string | null {
  if (typeof accepted.backgroundEndpoint === 'string' && accepted.backgroundEndpoint.startsWith('/api/')) {
    return accepted.backgroundEndpoint;
  }
  if (!accepted.attemptId || !accepted.runScopeId) return null;
  const query = new URLSearchParams({ attemptId: accepted.attemptId, runScopeId: accepted.runScopeId });
  return `/api/console/harness-sessions/${encodeURIComponent(accepted.sessionId)}/background?${query.toString()}`;
}

export interface BackgroundHandoffResult {
  ok: boolean;
  sessionId: string;
  attemptId: string;
  runScopeId: string;
  taskId: string;
  replayed?: boolean;
  text: string;
}

export async function moveSessionToBackground(
  accepted: Pick<ChatPostResult, 'sessionId' | 'attemptId' | 'runScopeId' | 'backgroundEndpoint'>,
  options: {
    transport?: (endpoint: string) => Promise<BackgroundHandoffResult>;
    retryDelaysMs?: number[];
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<BackgroundHandoffResult> {
  const endpoint = chatBackgroundEndpoint(accepted);
  if (!endpoint) throw Object.assign(new TypeError('exact background handoff identity is unavailable'), { status: 0 });
  const transport = options.transport ?? ((path: string) => apiPost<BackgroundHandoffResult>(path));
  const waits = options.retryDelaysMs ?? [400, 1_200];
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let attempt = 0;
  while (true) {
    try {
      return await transport(endpoint);
    } catch (error) {
      const status = Number((error as { status?: unknown } | null)?.status);
      const retryable = status === 0 || status >= 500 || (!Number.isFinite(status) && error instanceof TypeError);
      if (!retryable || attempt >= waits.length) throw error;
      await wait(waits[attempt]);
      attempt += 1;
    }
  }
}

export function chatCancelEndpoint(
  accepted: Pick<ChatPostResult, 'sessionId' | 'attemptId' | 'runScopeId' | 'cancelEndpoint'>,
): string | null {
  if (typeof accepted.cancelEndpoint === 'string' && accepted.cancelEndpoint.startsWith('/api/')) {
    return accepted.cancelEndpoint;
  }
  if (!accepted.attemptId || !accepted.runScopeId) return null;
  const query = new URLSearchParams({ attemptId: accepted.attemptId, runScopeId: accepted.runScopeId });
  return `/api/console/harness-sessions/${encodeURIComponent(accepted.sessionId)}/cancel?${query.toString()}`;
}

interface IdempotentControlOptions {
  transport?: (path: string, body: unknown) => Promise<unknown>;
  retryDelaysMs?: number[];
  wait?: (ms: number) => Promise<void>;
}

async function postIdempotentControl(
  endpoint: string,
  body: unknown,
  options: IdempotentControlOptions,
): Promise<boolean> {
  const transport = options.transport ?? ((path: string, payload: unknown) => apiPost(path, payload));
  const retryDelaysMs = options.retryDelaysMs ?? [250, 750, 1_500];
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let attempt = 0;
  while (true) {
    try {
      const result = await transport(endpoint, body);
      return !result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== false;
    } catch (error) {
      const status = Number((error as { status?: unknown } | null)?.status);
      const retryable = status === 0 || status >= 500 || (!Number.isFinite(status) && error instanceof TypeError);
      if (!retryable || attempt >= retryDelaysMs.length) return false;
      await wait(retryDelaysMs[attempt]);
      attempt += 1;
    }
  }
}

export async function cancelSession(
  accepted: Pick<ChatPostResult, 'sessionId' | 'attemptId' | 'runScopeId' | 'cancelEndpoint'>,
  options: IdempotentControlOptions = {},
): Promise<boolean> {
  const endpoint = chatCancelEndpoint(accepted);
  if (!endpoint) return false;
  return postIdempotentControl(endpoint, undefined, options);
}

/** Stop authority for the window before POST /api/harness/chat returns an
 * attempt id. The endpoint persists an idempotent tombstone keyed by the
 * client-owned request id, so a lost acknowledgement cannot leave work alive.
 */
export async function cancelPendingChatRequest(
  clientRequestId: string,
  options: IdempotentControlOptions = {},
): Promise<boolean> {
  const requestId = clientRequestId.trim();
  if (!requestId) return false;
  return postIdempotentControl(
    '/api/harness/chat/cancel',
    { clientRequestId: requestId },
    options,
  );
}

/** Upload one file → returns its inbox attachment id (to pass into postChat). */
export async function uploadAttachment(file: File): Promise<AttachResult> {
  const res = await fetch(withToken(`/api/attach?name=${encodeURIComponent(file.name)}`), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  const json = (await res.json().catch(() => ({}))) as Partial<AttachResult>;
  if (!res.ok || !json.id) {
    return { id: '', name: file.name, ok: false, error: json.error || `HTTP ${res.status}` };
  }
  return { id: json.id, name: json.name || file.name, ok: true, chars: json.chars };
}

export interface StreamHandle {
  promise: Promise<{ ok: boolean; error: string | null }>;
  stop: () => void;
  /** Highest event seq delivered so far — the resume cursor for a late-recovery
   *  watch after the stream gives up (the run may still finish server-side). */
  getLastSeq: () => number;
  /** Exact raw continuation plus public overlap identities for late recovery. */
  getReplayCursor: () => ReplayCursor;
}

/**
 * Subscribe to a session's event stream. Calls onEvent for every event
 * (replayed + live). Resolves when a terminal event arrives or the
 * stream gives up. `stop()` ends it early (for the composer STOP button).
 */
export function runHarnessStream(
  sessionId: string,
  opts: { sinceSeq?: number; onEvent: (ev: HarnessEvent) => void },
): StreamHandle {
  // Reconnect budget (2026-07-09): a daemon RESTART takes 10–30s+ (longer on a
  // slow disk), and the event stream is losslessly resumable via sinceSeq — so
  // giving up after ~5 EventSource errors (~15s) converted every mid-turn
  // restart into a permanent "I lost the live connection", even when the run
  // recovered and completed server-side (verified live: kill -9 mid-run → the
  // run resumed and finished; the old client would never have shown it). Ride
  // through outages up to RECONNECT_WINDOW_MS, recreating the EventSource with
  // backoff; a CLOSED source is reconnected, not treated as fatal.
  const RECONNECT_WINDOW_MS = 120 * 1000;
  const RECONNECT_BASE_DELAY_MS = 1_000;
  const RECONNECT_MAX_DELAY_MS = 8_000;
  const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
  let lastSeq = Number(opts.sinceSeq) || 0;
  const replayCursor = createReplayCursor(lastSeq);
  let replayInFlight: Promise<void> | null = null;
  let attempts = 0;
  let outageStartedAt = 0; // 0 = healthy; else Date.now() of the first error in this outage
  let reconnectPending = false; // one reconnect cycle at a time
  let es: EventSource | null = null;
  let closed = false;
  let sawEvent = false;
  let sawTerminal = false;
  let streamError = '';
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let approvalSettleTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveFn: (r: { ok: boolean; error: string | null }) => void;

  const promise = new Promise<{ ok: boolean; error: string | null }>((resolve) => { resolveFn = resolve; });

  const finish = () => {
    if (closed) return;
    closed = true;
    try { es?.close(); } catch { /* ignore */ }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (approvalSettleTimer) { clearTimeout(approvalSettleTimer); approvalSettleTimer = null; }
    resolveFn({ ok: !streamError, error: streamError || null });
  };

  const failStream = (message: string) => {
    if (closed) return;
    streamError = message || 'stream interrupted';
    finish();
  };

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => failStream('no progress event received'), IDLE_TIMEOUT_MS);
  };

  // One SDK turn may surface several independent approval cards back-to-back.
  // The first card is terminal for composer/busy state, but closing EventSource
  // synchronously used to discard its siblings. Debounce briefly, replay once,
  // then settle; ordinary completed/failed/question terminals remain instant.
  function scheduleApprovalSettle(): void {
    if (approvalSettleTimer) clearTimeout(approvalSettleTimer);
    approvalSettleTimer = setTimeout(() => {
      approvalSettleTimer = null;
      void pollReplayFallback().finally(() => {
        // A sibling discovered by replay schedules a fresh settle window.
        if (!closed && !approvalSettleTimer) {
          if (replayCursor.pending) scheduleApprovalSettle();
          else finish();
        }
      });
    }, 75);
  }

  const handleEvent = (ev: HarnessEvent, replayAccepted = false) => {
    if (closed) return;
    resetIdle();
    // Auto-reconnect (and the replay/fallback paths) re-deliver already-seen
    // events — dedupe by seq so the activity strip isn't duplicated. Token
    // deltas carry seq 0 and MUST still pass through every time.
    if (!replayAccepted && !acceptReplayEvent(replayCursor, sessionId, ev)) return;
    const own = !ev.sessionId || ev.sessionId === sessionId;
    if (own && ev.seq > 0) lastSeq = Math.max(lastSeq, ev.seq);
    sawEvent = true;
    try { opts.onEvent(ev); } catch { /* render errors shouldn't kill the stream */ }
    if (own && isTerminalEvent(ev.type) && !readLiveApprovalControl(ev)) {
      sawTerminal = true;
      if (ev.type === 'approval_requested') scheduleApprovalSettle();
      else finish();
    }
  };

  const pollReplayFallback = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (replayInFlight) return replayInFlight;
    replayInFlight = pollRecentReplayPages({
      sessionId, cursor: replayCursor, active: () => !closed,
      fetchPage: async (url) => {
        const res = await fetch(withToken(url), { credentials: 'same-origin', headers: { accept: 'application/json' } });
        if (res.ok === false) throw new Error('Session replay is temporarily unavailable.');
        return res.json();
      },
      onEvent: (event) => { handleEvent(event, true); return !closed; },
    }).catch(() => { /* retain this exact cursor for the next attempt */ }).finally(() => { replayInFlight = null; });
    return replayInFlight;
  };

  const connect = () => {
    if (closed) return;
    if (es) { try { es.close(); } catch { /* ignore */ } es = null; }
    const base = `/api/sessions/${encodeURIComponent(sessionId)}/events`;
    es = new EventSource(withToken(replayCursor.scanSeq > 0 ? `${base}?sinceSeq=${replayCursor.scanSeq}` : base));

    es.addEventListener('replay', (e) => {
      try {
        const payload = JSON.parse((e as MessageEvent).data) as { events?: HarnessEvent[] };
        for (const ev of payload.events ?? []) { handleEvent(ev); if (closed) break; }
        attempts = 0;
        outageStartedAt = 0; // replay delivered — the connection is healthy again
      } catch { /* ignore */ }
    });
    es.addEventListener('event', (e) => {
      outageStartedAt = 0;
      try { handleEvent(JSON.parse((e as MessageEvent).data) as HarnessEvent); } catch { /* ignore */ }
    });
    es.onerror = () => {
      if (closed || reconnectPending) return;
      reconnectPending = true;
      if (outageStartedAt === 0) outageStartedAt = Date.now();
      attempts += 1;
      // Between attempts, poll the replay endpoint — it both bridges an SSE-only
      // failure AND picks up a terminal event the moment the daemon is back, so
      // a run that finished during the outage completes the stream normally.
      void pollReplayFallback().finally(() => {
        if (closed || sawTerminal) { reconnectPending = false; return; }
        if (Date.now() - outageStartedAt >= RECONNECT_WINDOW_MS) {
          reconnectPending = false;
          failStream(sawEvent ? 'connection lost before the turn finished' : 'connection lost before any reply');
          return;
        }
        const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.min(attempts - 1, 3)));
        setTimeout(() => {
          reconnectPending = false;
          if (!closed && !sawTerminal) connect();
        }, delay);
      });
    };
  };

  resetIdle();
  connect();

  return {
    promise,
    stop: () => { if (!closed) { streamError = ''; finish(); } },
    getLastSeq: () => lastSeq,
    getReplayCursor: () => copyReplayCursor(replayCursor),
  };
}

/**
 * Late-recovery watch (2026-07-09): after a stream gives up, the run frequently
 * FINISHES server-side (restart recovery resumes it; the daemon just came back
 * after the reconnect window). Poll the session slowly for a terminal event and
 * deliver it, so "Stopped" is replaced by the real answer instead of stranding
 * a completed run invisibly. Bounded; stops on the first terminal event.
 */
export function watchForLateCompletion(
  sessionId: string,
  sinceSeq: number,
  onEvent: (ev: HarnessEvent) => void,
  opts: { intervalMs?: number; maxAttempts?: number; replayCursor?: ReplayCursor } = {},
): { cancel: () => void } {
  const intervalMs = opts.intervalMs ?? 15_000;
  const maxAttempts = opts.maxAttempts ?? 40; // ~10 minutes
  let cancelled = false;
  const replayCursor = opts.replayCursor ? copyReplayCursor(opts.replayCursor) : createReplayCursor(sinceSeq);
  let attempt = 0;
  const tick = async () => {
    if (cancelled) return;
    attempt += 1;
    try {
      await pollRecentReplayPages({
        sessionId, cursor: replayCursor, active: () => !cancelled,
        fetchPage: async (url) => {
          const res = await fetch(withToken(url), { credentials: 'same-origin', headers: { accept: 'application/json' } });
          if (res.ok === false) throw new Error('Session replay is temporarily unavailable.');
          return res.json();
        },
        onEvent: (event) => {
          onEvent(event);
          if (isTerminalEvent(event.type) && !readLiveApprovalControl(event)) cancelled = true;
          return !cancelled;
        },
      });
    } catch { /* daemon still down — keep this continuation for the next poll */ }
    if (!cancelled && attempt < maxAttempts) setTimeout(() => { void tick(); }, intervalMs);
  };
  setTimeout(() => { void tick(); }, intervalMs);
  return { cancel: () => { cancelled = true; } };
}

/**
 * Idle-chat window onto delegated work (2026-08-04). When a turn promotes its
 * work to a background task, the run continues under `background:<taskId>` and
 * the server bridges that task's activity-shaped public events onto the origin
 * session's stream. This subscription is how the idle chat sees them: it
 * listens ONLY for bridged frames (sessionId present and ≠ the subscribed
 * session) and ignores replay + own-session frames entirely, so it can never
 * interfere with the per-turn stream's transcript or terminal handling.
 * Keeping this EventSource open while the chat is on screen also registers the
 * viewer presence the terminal report-back uses to decide whether a finished
 * run still owes an out-of-band ping.
 */
export function subscribeDelegatedActivity(
  sessionId: string,
  onEvent: (ev: HarnessEvent) => void,
): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    es = new EventSource(withToken(`/api/sessions/${encodeURIComponent(sessionId)}/events`));
    const handleForeign = (ev: HarnessEvent) => {
      if (!ev || typeof ev.type !== 'string') return;
      if (!ev.sessionId || ev.sessionId === sessionId) return; // own-turn frames belong to the turn stream
      onEvent(ev);
    };
    es.addEventListener('replay', (e) => {
      try {
        const payload = JSON.parse((e as MessageEvent).data) as { events?: HarnessEvent[] };
        for (const ev of payload.events ?? []) handleForeign(ev);
      } catch { /* malformed frame — skip */ }
    });
    es.addEventListener('event', (e) => {
      try {
        handleForeign(JSON.parse((e as MessageEvent).data) as HarnessEvent);
      } catch { /* malformed frame — skip */ }
    });
    es.onerror = () => {
      // Missing session (fresh chat) or daemon restart — back off and retry
      // while the chat stays open; the strip is a best-effort live view.
      try { es?.close(); } catch { /* already closed */ }
      es = null;
      if (!closed) retryTimer = setTimeout(connect, 30_000);
    };
  };
  connect();

  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    try { es?.close(); } catch { /* already closed */ }
    es = null;
  };
}
