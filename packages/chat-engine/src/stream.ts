/**
 * The chat stream manager — the part of the engine that makes a phone's
 * connection survive reality.
 *
 * Design forced by two live incidents:
 *  - Mobile stream credentials are SINGLE-USE (a spent ticket 401s), so a
 *    browser EventSource's built-in retry — which re-uses the original URL —
 *    always dies permanently after the first drop. Every reconnect attempt
 *    here therefore asks the transport for a FRESH connection; the transport
 *    mints whatever credential its lane needs per attempt.
 *  - A suspended webview (screen lock, app switch) kills the socket silently.
 *    Recovery runs on THREE triggers: transport error, a caller-driven
 *    resume() (visibilitychange / pageshow / online), and an idle timeout for
 *    the frozen-socket case where no error ever fires.
 *
 * Recovery itself is poll-first: a cursor catch-up over plain fetch both
 * bridges a stream-only failure and catches a terminal event that landed
 * during the outage — the exact class where a 34s turn completed server-side
 * and the phone never rendered it. The stream gives up only after a
 * continuous outage window (default 120s: a daemon restart takes 10–30s and
 * a smaller budget turned every mid-turn restart into a permanent "lost the
 * connection"), after which a late-completion watch keeps polling so the
 * answer still lands.
 */
import type { ConnectionState, HarnessEvent, ReplayPayload } from './types.js';
import { isTerminalEvent } from './types.js';

export interface StreamConnection {
  close(): void;
}

export interface StreamTransport {
  /**
   * Open ONE connection attempt. MUST be fresh per call — implementations
   * mint per-attempt credentials here (mobile stream tickets are single-use).
   * Reject or call onError for any failure; never retry internally.
   */
  connect(opts: {
    sessionId: string;
    sinceSeq: number;
    onReplay(payload: ReplayPayload): void;
    onEvent(event: HarnessEvent): void;
    onError(): void;
  }): Promise<StreamConnection>;
  /** Cursor catch-up over plain fetch auth (no ticket). */
  fetchRecent(sessionId: string, sinceSeq: number): Promise<ReplayPayload>;
}

export interface ChatStreamOptions {
  sessionId: string;
  transport: StreamTransport;
  /** Resume cursor: replay strictly after this seq. */
  sinceSeq?: number;
  onEvent(event: HarnessEvent): void;
  onConnectionState?(state: ConnectionState): void;
  /** The stream saw a terminal event and closed itself. */
  onTerminal?(): void;
  /** Timings — injectable for tests. */
  reconnectWindowMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  idleTimeoutMs?: number;
  lateWatchIntervalMs?: number;
  lateWatchAttempts?: number;
  approvalSettleMs?: number;
  now?: () => number;
}

const DEFAULTS = {
  reconnectWindowMs: 120_000,
  reconnectBaseDelayMs: 1_000,
  reconnectMaxDelayMs: 8_000,
  // The server heartbeats every 15s; ten silent minutes means the socket is
  // frozen, not idle.
  idleTimeoutMs: 600_000,
  lateWatchIntervalMs: 15_000,
  lateWatchAttempts: 40,
  approvalSettleMs: 75,
} as const;

export interface ChatStreamHandle {
  /** Caller-driven recovery: webview resumed, network returned. Cheap and
   *  idempotent — safe to call on every visibilitychange. */
  resume(): void;
  stop(): void;
  cursor(): number;
}

export function runChatStream(options: ChatStreamOptions): ChatStreamHandle {
  const t = { ...DEFAULTS, ...options };
  const now = options.now ?? Date.now;
  let cursor = options.sinceSeq ?? 0;
  let stopped = false;
  let connection: StreamConnection | null = null;
  let connecting = false;
  let outageStartedAt: number | null = null;
  let reconnectDelay = t.reconnectBaseDelayMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let approvalTimer: ReturnType<typeof setTimeout> | null = null;
  let lateWatchTimer: ReturnType<typeof setTimeout> | null = null;
  let recovering = false;
  const seen = new Set<number>();

  const setState = (state: ConnectionState): void => {
    if (!stopped) options.onConnectionState?.(state);
  };

  const clearTimers = (): void => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (approvalTimer) { clearTimeout(approvalTimer); approvalTimer = null; }
    if (lateWatchTimer) { clearTimeout(lateWatchTimer); lateWatchTimer = null; }
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearTimers();
    connection?.close();
    connection = null;
  };

  const finishTerminal = (): void => {
    stop();
    options.onTerminal?.();
  };

  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (stopped) return;
    idleTimer = setTimeout(() => {
      // No event OR error for the whole window: the socket is frozen. Treat
      // it exactly like an error — poll, then reconnect fresh.
      connection?.close();
      connection = null;
      handleFailure();
    }, t.idleTimeoutMs);
  };

  const deliver = (event: HarnessEvent, ownSession: boolean): boolean => {
    // Token deltas ride with seq 0 and always pass through; durable events
    // dedupe by seq so an overlap between poll catch-up and stream replay is
    // inert. Bridged (foreign-session) frames never advance the cursor.
    if (ownSession && event.seq > 0) {
      if (seen.has(event.seq)) return false;
      seen.add(event.seq);
      if (seen.size > 4096) {
        // Bounded memory: everything at/below the cursor is already deduped
        // by the seq check on arrival order.
        for (const s of seen) { if (s <= cursor - 512) seen.delete(s); }
      }
      if (event.seq > cursor) cursor = event.seq;
    }
    options.onEvent(event);
    if (ownSession && isTerminalEvent(event.type)) {
      if (event.type === 'approval_requested') {
        // One SDK turn can emit sibling approval cards; closing the stream
        // synchronously on the first one used to discard the rest. Debounce,
        // take one catch-up poll, then settle.
        if (approvalTimer) clearTimeout(approvalTimer);
        approvalTimer = setTimeout(() => {
          void pollOnce().finally(finishTerminal);
        }, t.approvalSettleMs);
        return true;
      }
      finishTerminal();
      return true;
    }
    return false;
  };

  const deliverPayload = (payload: ReplayPayload): boolean => {
    let terminal = false;
    for (const event of payload.events ?? []) {
      const own = !event.sessionId || event.sessionId === options.sessionId;
      if (deliver(event, own)) terminal = true;
      if (stopped) break;
    }
    return terminal;
  };

  const pollOnce = async (): Promise<boolean> => {
    try {
      const payload = await options.transport.fetchRecent(options.sessionId, cursor);
      if (stopped) return false;
      return deliverPayload(payload);
    } catch {
      return false;
    }
  };

  const handleFailure = (): void => {
    if (stopped || recovering) return;
    recovering = true;
    if (outageStartedAt === null) outageStartedAt = now();
    setState('recovering');
    void (async () => {
      // Poll first: it both bridges a stream-only failure and catches a
      // terminal that landed during the outage.
      const terminal = await pollOnce();
      if (stopped || terminal) { recovering = false; return; }
      if (now() - (outageStartedAt ?? now()) > t.reconnectWindowMs) {
        // Continuous outage exceeded the window: stop burning the radio on
        // reconnects and fall back to slow polling until the turn resolves.
        recovering = false;
        setState('detached');
        startLateWatch();
        return;
      }
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        recovering = false;
        void connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, t.reconnectMaxDelayMs);
    })();
  };

  let lateWatchRemaining = 0;
  const startLateWatch = (): void => {
    lateWatchRemaining = t.lateWatchAttempts;
    const tick = (): void => {
      if (stopped || lateWatchRemaining <= 0) return;
      lateWatchRemaining -= 1;
      void pollOnce().then((terminal) => {
        if (!stopped && !terminal && lateWatchRemaining > 0) {
          lateWatchTimer = setTimeout(tick, t.lateWatchIntervalMs);
        }
      });
    };
    lateWatchTimer = setTimeout(tick, t.lateWatchIntervalMs);
  };

  const connect = async (): Promise<void> => {
    if (stopped || connecting || connection) return;
    connecting = true;
    setState('connecting');
    try {
      const attempt = await options.transport.connect({
        sessionId: options.sessionId,
        sinceSeq: cursor,
        onReplay: (payload) => {
          if (stopped) return;
          outageStartedAt = null;
          reconnectDelay = t.reconnectBaseDelayMs;
          setState('live');
          resetIdle();
          deliverPayload(payload);
        },
        onEvent: (event) => {
          if (stopped) return;
          outageStartedAt = null;
          reconnectDelay = t.reconnectBaseDelayMs;
          resetIdle();
          const own = !event.sessionId || event.sessionId === options.sessionId;
          deliver(event, own);
        },
        onError: () => {
          connection?.close();
          connection = null;
          if (!stopped) handleFailure();
        },
      });
      if (stopped) { attempt.close(); return; }
      connection = attempt;
      resetIdle();
    } catch {
      if (!stopped) handleFailure();
    } finally {
      connecting = false;
    }
  };

  const resume = (): void => {
    if (stopped) return;
    // A fresh user-driven signal resets the outage clock — the window bounds
    // continuous failure, not total session length.
    outageStartedAt = null;
    reconnectDelay = t.reconnectBaseDelayMs;
    if (lateWatchTimer) { clearTimeout(lateWatchTimer); lateWatchTimer = null; }
    if (connection) {
      // The socket may be silently dead after a suspension; poll to catch up
      // and let the idle timer / server heartbeat prove the socket's health.
      void pollOnce();
      return;
    }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    recovering = false;
    void pollOnce().then((terminal) => {
      if (!stopped && !terminal) void connect();
    });
  };

  void connect();

  return {
    resume,
    stop,
    cursor: () => cursor,
  };
}
