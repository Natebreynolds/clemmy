import type { WriteLedgerRow } from './write-ledger.js';
import type { TaskMode, PlanRevisionRef } from './task-mode.js';
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
  /** Own-session raw traversal only; bridged child events do not extend it. */
  page?: { version: 1; scannedThroughSeq: number; snapshotSeq: number; hasMore: boolean };
}

export type MessageStatus =
  | 'thinking' | 'complete' | 'failed' | 'stopped'
  | 'awaiting-approval' | 'awaiting-reply' | 'awaiting-plan';

/** Durable identity for workflow work delegated by one accepted chat source.
 * The client may use these exact run ids for controls, but never derives them
 * from prose or a workflow label. */
export interface DelegatedWorkControl {
  sourceUserSeq: number;
  runIds: string[];
  state: 'running' | 'cancelling' | 'stopped';
}

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
  /** Actual event effect; presentation only, never execution authority. */
  effect?: 'read' | 'compute' | 'local_write' | 'external_write' | 'admin';
  /** A reservation becomes confirmed only through its own write terminal. */
  write?: WriteLedgerRow;
}

/**
 * The backend's TYPED terminal, carried onto the message so renderers can key on
 * it instead of re-deriving state from prose or reason strings. `status` is the
 * harness terminal status; `kind` is the presentation kind; `needs` is what the
 * turn is waiting on; `resumable` is the harness's own claim. Absent on legacy
 * events, in which case renderers fall back to `MessageStatus`.
 */
export interface TerminalFacts {
  status: 'done' | 'needs_input' | 'blocked' | 'cancelled' | 'failed' | 'transferred' | 'uncertain';
  kind?: 'answer' | 'question' | 'approval' | 'continue';
  needs?: 'input' | 'approval' | 'continue';
  resumable?: boolean;
  /** Which model actually produced this turn (from turn_model_routed). */
  modelIdentity?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status?: MessageStatus;
  progress?: string;
  /** See TerminalFacts. */
  terminal?: TerminalFacts;
  /** Live, accumulated tool calls + spawned agents for THIS turn. */
  activity?: ActivityItem[];
  approval?: {
    subject: string;
    reason?: string;
    approvalId?: string | null;
    /** Host reducer facts, passed through unchanged for display, not authority. */
    consentCall?: {
      effect: string;
      accountId: string | null;
      risk: { reversibility: string; consequence: string; destructive: boolean };
    };
  };
  taskMode?: TaskMode;
  planArtifactRef?: PlanRevisionRef;
  /** Original target retained verbatim across a failed POST and a later retry. */
  requestSessionId?: string | null;
  planProposalId?: string;
  planProposalStatus?: 'pending' | 'approved' | 'rejected';
  planProposalNeedsUserInput?: boolean;
  /** Local echo not yet confirmed by the server ('sending'), or a send that
   *  needs the user's attention ('failed'). Absent once durable. */
  pending?: 'sending' | 'failed';
  pendingError?: string;
  /** Client idempotency key for retrying a failed send verbatim. */
  idempotencyKey?: string;
  /** Mid-run steer: text delivered into the live turn, not a new attempt. */
  steer?: 'pending' | 'delivered' | 'failed';
  /** Present only while this assistant bubble represents exact, source-bound
   * delegated workflow work. A canonical terminal removes the control. */
  delegatedWork?: DelegatedWorkControl;
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
  /**
   * The idempotency key of the turn currently in flight, or null.
   *
   * A surface can hand this straight to the host's request-identity cancel,
   * which stops the turn whether or not a run attempt exists yet — so a user
   * is never locked out during the window before one is registered. Null while
   * idle, and also while a turn that started on ANOTHER surface is being
   * followed (this client never minted a key for it); a surface that wants
   * Stop to work there too falls back to the run attempt's own identity.
   */
  cancelKey: string | null;
  activeTaskMode?: TaskMode;
}

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
