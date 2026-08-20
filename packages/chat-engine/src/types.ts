/**
 * Shared chat-engine types. These mirror the desktop console's contracts
 * (apps/console-web/src/lib/useChat.ts) so both UIs speak one vocabulary;
 * the engine is the canonical home going forward.
 */

/** One public-projected harness event as a client transport delivers it. */
export interface HarnessEvent {
  seq: number;
  type: string;
  data?: Record<string, unknown>;
  id?: string;
  turn?: number;
  role?: string;
  createdAt?: number;
  /** Present on transports that bridge delegated-work frames — a foreign
   *  sessionId marks mirrored background/workflow activity, never turn state. */
  sessionId?: string;
}

export interface ReplayPayload {
  sessionId?: string;
  sessionStatus?: string;
  events: HarnessEvent[];
  latestSeq?: number;
  error?: string;
}

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
  status: 'running' | 'done' | 'failed' | 'interrupted';
  /** Client-clock start, for the live per-row elapsed timer while running. */
  startedAt?: number;
  /** kind 'batch' only: live meter state from authoritative batch_progress events. */
  batch?: { done: number; total: number; failed: number; throttled?: boolean };
  variant?: 'write' | 'program' | 'lifecycle';
  /** Narration: how many identical rows folded into this one. Absent means one. */
  repeats?: number;
  tone?: 'success' | 'danger' | 'warning' | 'live' | 'muted';
  /** kind 'event' rolling rows only: occurrences aggregated (e.g. files saved). */
  count?: number;
  /** Bounded runtime-verified content peek (the opening of a file just written). */
  excerpt?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status?: MessageStatus;
  progress?: string;
  /** Live, accumulated tool calls + spawned agents for THIS turn. */
  activity?: ActivityItem[];
  approval?: {
    subject: string;
    reason?: string;
    approvalId?: string | null;
  };
  planProposalId?: string;
  planProposalStatus?: 'pending' | 'approved' | 'rejected';
  planProposalNeedsUserInput?: boolean;
  /** Local echo not yet confirmed by the server ('sending'), or a send that
   *  needs the user's attention ('failed'). Absent once durable. */
  pending?: 'sending' | 'failed';
  pendingError?: string;
  /** Client idempotency key for retrying a failed send verbatim. */
  idempotencyKey?: string;
}

/** What the transport layer is doing right now, for an honest connection pill. */
export type ConnectionState =
  | 'idle'        // no stream open (no session yet)
  | 'connecting'  // attempting the stream
  | 'live'        // stream open and delivering
  | 'recovering'  // stream down; polling catch-up + reconnecting
  | 'detached';   // gave up on the stream; late-completion polling only

export interface EngineSnapshot {
  sessionId: string | null;
  messages: ChatMessage[];
  busy: boolean;
  connection: ConnectionState;
}

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
