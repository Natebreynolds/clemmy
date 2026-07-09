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
    type === 'approval_requested'
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

export async function postChat(input: string, sessionId: string | null, attachments: string[]): Promise<ChatPostResult> {
  return apiPost<ChatPostResult>('/api/harness/chat', { input, sessionId: sessionId || undefined, attachments });
}

export async function cancelSession(sessionId: string): Promise<void> {
  try { await apiPost(`/api/console/harness-sessions/${encodeURIComponent(sessionId)}/cancel`); } catch { /* best effort */ }
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
  let attempts = 0;
  let outageStartedAt = 0; // 0 = healthy; else Date.now() of the first error in this outage
  let reconnectPending = false; // one reconnect cycle at a time
  let es: EventSource | null = null;
  let closed = false;
  let sawEvent = false;
  let sawTerminal = false;
  let streamError = '';
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveFn: (r: { ok: boolean; error: string | null }) => void;

  const promise = new Promise<{ ok: boolean; error: string | null }>((resolve) => { resolveFn = resolve; });

  const finish = () => {
    if (closed) return;
    closed = true;
    try { es?.close(); } catch { /* ignore */ }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
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

  const handleEvent = (ev: HarnessEvent) => {
    if (closed) return;
    resetIdle();
    // Auto-reconnect (and the replay/fallback paths) re-deliver already-seen
    // events — dedupe by seq so the activity strip isn't duplicated. Token
    // deltas carry seq 0 and MUST still pass through every time.
    if (ev && typeof ev.seq === 'number' && ev.seq > 0) {
      if (ev.seq <= lastSeq) return;
      lastSeq = ev.seq;
    }
    sawEvent = true;
    try { opts.onEvent(ev); } catch { /* render errors shouldn't kill the stream */ }
    if (isTerminalEvent(ev.type)) { sawTerminal = true; finish(); }
  };

  const pollReplayFallback = async () => {
    if (closed) return;
    try {
      const url = withToken(`/api/sessions/${encodeURIComponent(sessionId)}/events/recent?sinceSeq=${lastSeq}&limit=500`);
      const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      const data = (await res.json().catch(() => ({}))) as { events?: HarnessEvent[] };
      for (const ev of data.events ?? []) { handleEvent(ev); if (closed) break; }
    } catch { /* best effort */ }
  };

  const connect = () => {
    if (closed) return;
    if (es) { try { es.close(); } catch { /* ignore */ } es = null; }
    const base = `/api/sessions/${encodeURIComponent(sessionId)}/events`;
    es = new EventSource(withToken(lastSeq > 0 ? `${base}?sinceSeq=${lastSeq}` : base));

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
  opts: { intervalMs?: number; maxAttempts?: number } = {},
): { cancel: () => void } {
  const intervalMs = opts.intervalMs ?? 15_000;
  const maxAttempts = opts.maxAttempts ?? 40; // ~10 minutes
  let cancelled = false;
  let lastSeq = sinceSeq;
  let attempt = 0;
  const tick = async () => {
    if (cancelled) return;
    attempt += 1;
    try {
      const url = withToken(`/api/sessions/${encodeURIComponent(sessionId)}/events/recent?sinceSeq=${lastSeq}&limit=500`);
      const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      const data = (await res.json().catch(() => ({}))) as { events?: HarnessEvent[] };
      for (const ev of data.events ?? []) {
        if (ev && typeof ev.seq === 'number' && ev.seq > 0) {
          if (ev.seq <= lastSeq) continue;
          lastSeq = ev.seq;
        }
        onEvent(ev);
        if (isTerminalEvent(ev.type)) { cancelled = true; return; }
      }
    } catch { /* daemon still down — keep watching */ }
    if (!cancelled && attempt < maxAttempts) setTimeout(() => { void tick(); }, intervalMs);
  };
  setTimeout(() => { void tick(); }, intervalMs);
  return { cancel: () => { cancelled = true; } };
}
