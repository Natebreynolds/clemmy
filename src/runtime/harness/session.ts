import type { AgentInputItem } from '@openai/agents';
import {
  appendEvent,
  createSession,
  getSession,
  updateSession,
  type CreateSessionInput,
  type EventRow,
  type SessionRow,
  type SessionStatus,
} from './eventlog.js';

/**
 * HarnessSession — Clementine-owned conversation memory.
 *
 * The TS `@openai/agents` 0.1.x SDK does not expose a `Session` SPI yet
 * (only Python does), so this is our own type rather than an interface
 * implementation. It still pulls its weight against the SDK:
 *
 *   - `toInputItems()` produces the `AgentInputItem[]` that gets passed
 *     to `Runner.run(agent, items, opts)` on the next turn — replayed
 *     from durable state, not held in memory across processes.
 *
 *   - `previousResponseId()` lets the harness pass `previousResponseId`
 *     in `RunConfig` so the OpenAI Responses API can short-circuit
 *     repeated context (free token savings).
 *
 *   - `saveInterruptState()` / `loadInterruptState()` persist a
 *     `RunState.toString()` blob so a paused-for-approval run can
 *     resume after a daemon restart via
 *     `runner.run(agent, RunState.fromString(blob))`.
 *
 * Storage lives in two reserved metadata keys on the session row so the
 * event log stays the spine but conversation snapshots don't need a
 * dedicated event type. The conversation snapshot is the source of
 * truth for replay; per-event records (tool_called, step_verified, etc.)
 * are the semantic audit log.
 */

const META_CONVERSATION = '__conversation';
const META_INTERRUPT = '__interrupt_state';
// Restart-recovery marker: set while a runConversation is in flight, cleared in
// a finally when it returns/throws — so ONLY a hard process death (daemon crash
// /restart mid-run) leaves it set. The boot scan uses it to surface an
// interrupted chat run instead of dying silently. Internal bookkeeping → no event.
const META_RUNNING = '__run_in_flight';

export interface PersistedConversation {
  items: AgentInputItem[];
  lastResponseId: string | undefined;
  updatedAt: string;
}

export interface RecordTurnResultInput {
  history: AgentInputItem[];
  lastResponseId: string | undefined;
  turn: number;
}

export class HarnessSession {
  private constructor(private row: SessionRow) {}

  static create(input: CreateSessionInput): HarnessSession {
    const row = createSession(input);
    appendEvent({
      sessionId: row.id,
      turn: 0,
      role: 'system',
      type: 'session_started',
      data: {
        kind: row.kind,
        channel: row.channel,
        userId: row.userId,
        title: row.title,
        objective: row.objective,
      },
    });
    return new HarnessSession(row);
  }

  static load(sessionId: string): HarnessSession | null {
    const row = getSession(sessionId);
    return row ? new HarnessSession(row) : null;
  }

  get id(): string {
    return this.row.id;
  }

  get kind(): SessionRow['kind'] {
    return this.row.kind;
  }

  get sessionRow(): SessionRow {
    return this.row;
  }

  /** Re-read the session row from the DB. Use after external writes. */
  refresh(): void {
    const row = getSession(this.row.id);
    if (row) this.row = row;
  }

  private conversation(): PersistedConversation {
    const raw = this.row.metadata[META_CONVERSATION];
    if (!raw || typeof raw !== 'object') {
      return { items: [], lastResponseId: undefined, updatedAt: this.row.createdAt };
    }
    const c = raw as Partial<PersistedConversation>;
    return {
      items: Array.isArray(c.items) ? (c.items as AgentInputItem[]) : [],
      lastResponseId: typeof c.lastResponseId === 'string' ? c.lastResponseId : undefined,
      updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : this.row.createdAt,
    };
  }

  /** Replay items to feed back into `Runner.run(agent, items, opts)`. */
  toInputItems(): AgentInputItem[] {
    return this.conversation().items;
  }

  /** Pass via `RunConfig.previousResponseId` to reuse Responses API state. */
  previousResponseId(): string | undefined {
    return this.conversation().lastResponseId;
  }

  /** ISO timestamp the conversation snapshot was last written (i.e. the previous
   *  turn's completion). Read BEFORE this turn writes back, it gives the idle gap
   *  since the last turn — used by age/idle-aware compaction. Falls back to the
   *  session createdAt for a brand-new session. */
  lastActivityAt(): string {
    return this.conversation().updatedAt;
  }

  /** Append a raw user turn input event. */
  recordUserInput(text: string, turn: number): EventRow {
    return appendEvent({
      sessionId: this.row.id,
      turn,
      role: 'user',
      type: 'user_input_received',
      data: { text },
    });
  }

  /**
   * Update the persisted conversation snapshot without emitting any
   * event. Used by auto-compact (v0.5.10) between turns to write back
   * the compacted items array. We can't use `recordTurnResult` here
   * because that fires `turn_ended` — emitting it pre-turn would
   * corrupt the audit-log boundary (two turn_ended events per turn, or
   * one before turn_started).
   */
  updateConversationSnapshot(items: AgentInputItem[]): void {
    const meta = { ...this.row.metadata };
    const snapshot: PersistedConversation = {
      items,
      lastResponseId: this.conversation().lastResponseId,
      updatedAt: new Date().toISOString(),
    };
    meta[META_CONVERSATION] = snapshot;
    this.row = updateSession(this.row.id, { metadata: meta });
  }

  /**
   * Stage a synthetic `role:'user'` turn into the persisted conversation
   * snapshot so the NEXT `runTurn` replays it (no event emitted, no turn
   * started — same mechanism as updateConversationSnapshot). This is how a
   * background workflow/task OUTCOME reaches the ORCHESTRATOR's reasoning: the
   * orchestrator replays toInputItems() (the harness snapshot), NOT the PWA
   * SessionStore where enqueue*OutcomeTurn also writes. Idempotent by
   * `idPrefix` so a terminal-retry / re-drain can't double-inject. Returns true
   * when it injected, false when a matching turn was already staged.
   */
  injectSyntheticUserTurn(idPrefix: string, text: string): boolean {
    const items = this.toInputItems();
    const already = items.some((it) => {
      const role = (it as { role?: unknown }).role;
      const content = (it as { content?: unknown }).content;
      return role === 'user' && typeof content === 'string' && content.startsWith(idPrefix);
    });
    if (already) return false;
    this.updateConversationSnapshot([...items, { role: 'user', content: text } as AgentInputItem]);
    return true;
  }

  /**
   * Set a self-updating CONTEXT PRIMER turn keyed by a stable prefix (e.g. a
   * Workspace dock's "[workspace-context]" block). Unlike injectSyntheticUserTurn
   * (inject-once), this REPLACES any prior primer with the same prefix when the
   * text changes, so guidance edits reach existing sessions on their next turn.
   * No-op when the current primer already matches. Returns true if it changed.
   */
  setContextPrimer(prefix: string, text: string): boolean {
    const items = this.toInputItems();
    const isPrimer = (it: AgentInputItem): boolean => {
      const role = (it as { role?: unknown }).role;
      const content = (it as { content?: unknown }).content;
      return role === 'user' && typeof content === 'string' && content.startsWith(prefix);
    };
    const current = items.find(isPrimer) as { content?: string } | undefined;
    if (current && current.content === text) return false; // already current
    const without = items.filter((it) => !isPrimer(it));
    this.updateConversationSnapshot([...without, { role: 'user', content: text } as AgentInputItem]);
    return true;
  }

  /**
   * Persist the SDK's post-run history snapshot + `lastResponseId`.
   * Also emits a `turn_ended` event so the audit log records the
   * boundary even when no semantic events fired this turn.
   */
  recordTurnResult(input: RecordTurnResultInput): void {
    const meta = { ...this.row.metadata };
    const snapshot: PersistedConversation = {
      items: input.history,
      lastResponseId: input.lastResponseId,
      updatedAt: new Date().toISOString(),
    };
    meta[META_CONVERSATION] = snapshot;
    this.row = updateSession(this.row.id, { metadata: meta });
    appendEvent({
      sessionId: this.row.id,
      turn: input.turn,
      role: 'system',
      type: 'turn_ended',
      data: {
        items: input.history.length,
        lastResponseId: input.lastResponseId ?? null,
      },
    });
  }

  /**
   * Save a `RunState.toString()` blob produced when the SDK pauses for
   * an approval interrupt. Resumed via:
   *   const state = RunState.fromString(harnessSession.loadInterruptState()!);
   *   await runner.run(agent, state, { context: ... });
   */
  saveInterruptState(serialized: string): void {
    const meta = { ...this.row.metadata };
    meta[META_INTERRUPT] = serialized;
    this.row = updateSession(this.row.id, { metadata: meta });
    appendEvent({
      sessionId: this.row.id,
      turn: 0,
      role: 'system',
      type: 'run_paused',
      data: { bytes: serialized.length },
    });
  }

  loadInterruptState(): string | null {
    const raw = this.row.metadata[META_INTERRUPT];
    return typeof raw === 'string' ? raw : null;
  }

  clearInterruptState(options: { emitEvent?: boolean } = {}): void {
    if (!(META_INTERRUPT in this.row.metadata)) return;
    const meta = { ...this.row.metadata };
    delete meta[META_INTERRUPT];
    this.row = updateSession(this.row.id, { metadata: meta });
    if (options.emitEvent === false) return;
    appendEvent({
      sessionId: this.row.id,
      turn: 0,
      role: 'system',
      type: 'run_resumed',
      data: {},
    });
  }

  /**
   * Update the session's status. Does NOT emit a terminal event — the
   * caller (typically the harness loop) is responsible for emitting
   * `run_completed` / `run_failed` with the rich payload (final
   * output preview, tool-call counts, etc.). Splitting these
   * concerns avoids the double-emission bug where both this method
   * and the loop appended the terminal event.
   */
  markStatus(status: SessionStatus): void {
    this.row = updateSession(this.row.id, { status });
  }

  // ── Restart-recovery in-flight marker ──────────────────────────────
  // Mirror of saveInterruptState's read-modify-write, but emits NO event
  // (it's internal bookkeeping, not an audit signal). Set on runConversation
  // entry, cleared in its finally — so a value surviving across a daemon
  // restart means that run was killed mid-flight.
  setRunInFlight(at: string = new Date().toISOString()): void {
    const meta = { ...this.row.metadata };
    meta[META_RUNNING] = at;
    this.row = updateSession(this.row.id, { metadata: meta });
  }

  clearRunInFlight(): void {
    if (!(META_RUNNING in this.row.metadata)) return;
    const meta = { ...this.row.metadata };
    delete meta[META_RUNNING];
    this.row = updateSession(this.row.id, { metadata: meta });
  }

  /** ISO timestamp a still-in-flight run started at, or null. */
  runInFlightSince(): string | null {
    const raw = this.row.metadata[META_RUNNING];
    return typeof raw === 'string' ? raw : null;
  }
}
