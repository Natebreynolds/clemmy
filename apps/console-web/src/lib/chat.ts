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

/** Events that end a streaming turn (the composer re-enables after these). */
export function isTerminalEvent(type: string): boolean {
  return (
    type === 'conversation_completed' ||
    type === 'run_failed' ||
    type === 'conversation_limit_exceeded' ||
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
  const MAX_RECONNECTS = 5;
  const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
  let lastSeq = Number(opts.sinceSeq) || 0;
  let attempts = 0;
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
    sawEvent = true;
    resetIdle();
    if (ev && typeof ev.seq === 'number' && ev.seq > lastSeq) lastSeq = ev.seq;
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
      } catch { /* ignore */ }
    });
    es.addEventListener('event', (e) => {
      try { handleEvent(JSON.parse((e as MessageEvent).data) as HarnessEvent); } catch { /* ignore */ }
    });
    es.onerror = () => {
      if (closed) return;
      if (es && es.readyState === EventSource.CLOSED) {
        void pollReplayFallback().finally(() => {
          if (!closed && !sawTerminal) failStream(sawEvent ? 'connection closed before the turn finished' : 'connection closed before any reply');
        });
        return;
      }
      attempts += 1;
      if (attempts > MAX_RECONNECTS) {
        void pollReplayFallback().finally(() => {
          if (!closed && !sawTerminal) failStream('could not reconnect to the live stream');
        });
        return;
      }
      // EventSource auto-reconnects; our handlers stay attached.
    };
  };

  resetIdle();
  connect();

  return {
    promise,
    stop: () => { if (!closed) { streamError = ''; finish(); } },
  };
}
