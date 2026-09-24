import type { AgentInputItem } from '@openai/agents';
import type { McpToolScope } from '../mcp-tool-scope.js';
import {
  appendEvent,
  createSession,
  getSession,
  insertInternalEventInTransaction,
  listEvents,
  openEventLog,
  publishCommittedInternalEvent,
  updateSession,
  type CreateSessionInput,
  type EventRow,
  type SessionRow,
  type SessionStatus,
} from './eventlog.js';
import {
  preparePersistedSessionConversationProtocol,
  type PreparedProviderConversation,
} from './conversation-protocol-session.js';
import { resolveExactTerminalForAcceptedSource } from './accepted-source-terminal.js';
import { workflowParentActivation } from './workflow-parent-activation.js';
import { SOURCE_APPROVAL_CHECKPOINTS_KEY, hostApprovalCheckpointSource, sourceApprovalSnapshotFromMetadata, readSourceApprovalCheckpoint,
  listSourceApprovalCheckpoints, replaceSourceApprovalCheckpoint } from './source-approval-checkpoints.js';

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
// Exact external-connector authority in force when the SDK paused. Approval
// resumes rebuild an Agent, so without this sibling record a scoped/local-only
// turn silently reopened the legacy allow-all MCP surface after approval.
const META_INTERRUPT_MCP_SCOPE = '__interrupt_mcp_scope';
// Local checkpoint recovery is not an approval interruption. Keeping a
// separate key prevents UI/card owners from treating host bookkeeping as a
// user decision while still surviving daemon restart.
const META_RECOVERY = '__host_recovery_state';
const META_RECOVERY_MCP_SCOPE = '__host_recovery_mcp_scope';
/** Exact activation that owns the installed recovery blob. */
const META_RECOVERY_OWNER = '__host_recovery_owner';
/**
 * The activation still RESPONSIBLE for an accepted source, independent of any
 * checkpoint blob.
 *
 * The recovery blob was the wrong evidence: adoption deliberately removes it
 * while the work continues, so sampling it told the desktop bridge that a live
 * turn had stopped. Live 2026-09-07 source 141915 — checkpoint recovery ran
 * 4ms before the attempt was marked completed, and the next protected child
 * call was refused against a finished owner.
 *
 * Cleared in the SAME transaction as the terminal that closes the owner, so it
 * can never outlive the work it describes.
 */
const META_CONTINUATION_OWNER = '__continuation_owner';

/** The exact activation a recovery checkpoint belongs to. */
export interface RecoveryOwner {
  sourceUserSeq: number;
  /** Distinguishes competing activations of the SAME accepted source. */
  attemptId?: string | undefined;
}

export type RecoverySaveOutcome =
  | { installed: true }
  | {
      installed: false;
      reason:
        /** Another activation owns the installed recovery. */
        | 'owner_conflict'
        /** The source already published a typed terminal. */
        | 'source_terminalized'
        | 'storage_failure';
    };

function recoveryOwnerToken(owner: RecoveryOwner): string {
  return JSON.stringify({
    sourceUserSeq: owner.sourceUserSeq,
    attemptId: owner.attemptId ?? null,
  });
}
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

export interface RecordCompletedTurnResultInput extends RecordTurnResultInput {
  finalOutputPreview: string;
  toolCalls: number;
}

export class HarnessSession {
  private constructor(private row: SessionRow) {}

  private selectedApprovalSource?: number;

  private defaultStoredApprovalSource(): number | undefined {
    const stored = this.row.metadata[SOURCE_APPROVAL_CHECKPOINTS_KEY];
    if (stored == null) return undefined;
    if (typeof stored !== 'object' || Array.isArray(stored)) throw new Error('Malformed source approval checkpoint index');
    return Object.keys(stored).map(Number).sort((a, b) => b - a).find(source =>
      sourceApprovalSnapshotFromMetadata(this.row.metadata, source).checkpoint !== null);
  }

  private projectSourceApproval(): void {
    const remaining = listSourceApprovalCheckpoints(this.row.id).at(-1)?.checkpoint;
    const db = openEventLog();
    db.prepare(`UPDATE sessions SET metadata_json = json_remove(metadata_json,
      '$.${META_INTERRUPT}', '$.${META_INTERRUPT_MCP_SCOPE}') WHERE id = ?`).run(this.row.id);
    if (remaining) db.prepare(`UPDATE sessions SET metadata_json = json_set(metadata_json,
      '$.${META_INTERRUPT}', ?, '$.${META_INTERRUPT_MCP_SCOPE}', json(?)) WHERE id = ?`)
      .run(remaining.serialized, JSON.stringify(remaining.mcpToolScope), this.row.id);
  }

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
    const active = workflowParentActivation(this.row.id);
    if (active) return active.conversation;
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

  /**
   * Canonical persisted-session boundary for model replay. Historical repair
   * and quarantine happen atomically in the eventlog; only a ready transcript
   * is exposed. Ordinary snapshot readers keep using `toInputItems()` so this
   * boundary cannot silently mutate non-provider session operations.
   */
  prepareProviderHistory(): PreparedProviderConversation {
    const active = workflowParentActivation(this.row.id);
    if (active) return { status: 'ready', disposition: 'ready', migration: 'none',
      history: active.conversation.items, providerHistory: active.conversation.items };
    const prepared = preparePersistedSessionConversationProtocol({ sessionId: this.row.id });
    this.refresh();
    return prepared;
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
    const snapshot: PersistedConversation = {
      items,
      lastResponseId: this.conversation().lastResponseId,
      updatedAt: new Date().toISOString(),
    };
    const active = workflowParentActivation(this.row.id);
    if (active) { active.conversation = snapshot; return; }
    // Compaction may await a model while other owners update this session.
    // Commit only our conversation field, preserving their newer metadata.
    const written = openEventLog().prepare(
      `UPDATE sessions
          SET metadata_json = json_set(metadata_json, '$.__conversation', json(?)),
              updated_at = ?
        WHERE id = ?`,
    ).run(JSON.stringify(snapshot), snapshot.updatedAt, this.row.id);
    if (written.changes !== 1) throw new Error(`session not found: ${this.row.id}`);
    this.refresh();
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
    const active = workflowParentActivation(this.row.id);
    if (active) active.conversation = snapshot;
    else {
      meta[META_CONVERSATION] = snapshot;
      this.row = updateSession(this.row.id, { metadata: meta });
    }
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
   * Canonical successful-turn durability owner. The replay snapshot, audit
   * boundary, internal run terminal, and logical turn watermark describe one
   * completed result, so publishing any proper subset would expose a state no
   * reader should observe. Insert all four under one SQLite transaction, then
   * publish the two events in their original order only after commit.
   *
   * Blocked/error/approval paths deliberately keep using recordTurnResult and
   * their existing terminal owners because they do not have this exact event
   * sequence.
   */
  recordCompletedTurnResult(input: RecordCompletedTurnResultInput): void {
    const db = openEventLog();
    const snapshot: PersistedConversation = {
      items: input.history,
      lastResponseId: input.lastResponseId,
      updatedAt: new Date().toISOString(),
    };
    let turnEnded!: EventRow;
    let runCompleted!: EventRow;

    const commit = db.transaction(() => {
      // json_set preserves unrelated metadata written by concurrent owners;
      // writing a stale in-memory metadata object here would erase it.
      const active = workflowParentActivation(this.row.id);
      if (active) active.conversation = snapshot;
      else db.prepare(
        `UPDATE sessions
            SET metadata_json = json_set(metadata_json, '$.__conversation', json(?)),
                updated_at = ?
          WHERE id = ?`,
      ).run(JSON.stringify(snapshot), snapshot.updatedAt, this.row.id);

      turnEnded = insertInternalEventInTransaction(db, {
        sessionId: this.row.id,
        turn: input.turn,
        role: 'system',
        type: 'turn_ended',
        data: {
          items: input.history.length,
          lastResponseId: input.lastResponseId ?? null,
        },
      });
      runCompleted = insertInternalEventInTransaction(db, {
        sessionId: this.row.id,
        turn: input.turn,
        role: 'system',
        type: 'run_completed',
        data: {
          finalOutputPreview: input.finalOutputPreview,
          toolCalls: input.toolCalls,
        },
      });

      db.prepare(
        `UPDATE sessions
            SET metadata_json = json_set(metadata_json, '$.__turn', ?),
                updated_at = ?
          WHERE id = ?`,
      ).run(input.turn, new Date().toISOString(), this.row.id);
    });

    commit.immediate();
    this.refresh();
    publishCommittedInternalEvent(turnEnded);
    publishCommittedInternalEvent(runCompleted);
  }

  /**
   * Save a `RunState.toString()` blob produced when the SDK pauses for
   * an approval interrupt. Resumed via:
   *   const state = RunState.fromString(harnessSession.loadInterruptState()!);
   *   await runner.run(agent, state, { context: ... });
   */
  saveInterruptState(
    serialized: string,
    options: { mcpToolScope?: McpToolScope | null } = {},
  ): void {
    workflowParentActivation(this.row.id); // fences a resumed parent's stale lease
    const sourceUserSeq = hostApprovalCheckpointSource(serialized, this.row.id);
    if (sourceUserSeq !== undefined) {
      const observed = sourceApprovalSnapshotFromMetadata(this.row.metadata, sourceUserSeq);
      openEventLog().transaction(() => {
        // Preserve a pre-upgrade host pause before installing another source.
        const current = getSession(this.row.id)!;
        const legacy = current.metadata[META_INTERRUPT];
        const legacySource = typeof legacy === 'string' ? hostApprovalCheckpointSource(legacy, this.row.id) : undefined;
        if (legacySource !== undefined && legacySource !== sourceUserSeq
          && readSourceApprovalCheckpoint({ sessionId: this.row.id, sourceUserSeq: legacySource }).revision === null) {
          const migrated = replaceSourceApprovalCheckpoint({ sessionId: this.row.id, sourceUserSeq: legacySource,
            expectedRevision: null, checkpoint: { serialized: legacy as string,
              mcpToolScope: (current.metadata[META_INTERRUPT_MCP_SCOPE] as McpToolScope | undefined) ?? null } });
          if (!migrated.updated) throw new Error('Approval interrupt changed during migration');
        }
        const result = replaceSourceApprovalCheckpoint({ sessionId: this.row.id, sourceUserSeq,
          expectedRevision: observed.revision,
          checkpoint: { serialized, mcpToolScope: options.mcpToolScope ?? null } });
        if (!result.updated) throw new Error('Approval interrupt changed before it could be saved');
        this.projectSourceApproval();
      }).immediate();
      this.refresh();
      this.selectedApprovalSource = sourceUserSeq;
      appendEvent({ sessionId: this.row.id, turn: 0, role: 'system', type: 'run_paused',
        data: { bytes: serialized.length, sourceUserSeq } });
      return;
    }
    const expected = this.row.metadata[META_INTERRUPT] ?? null;
    const expectedScope = this.row.metadata[META_INTERRUPT_MCP_SCOPE];
    const scope = options.mcpToolScope && typeof options.mcpToolScope.reason === 'string'
      ? JSON.stringify(options.mcpToolScope) : null;
    // Mutate only the parked state. A cached session row may predate another
    // task's conversation, counters or metadata. Compare the old pause as well
    // so an older activation cannot replace a newer approval's authority.
    const updated = openEventLog().prepare(`UPDATE sessions SET metadata_json =
      json_set(json_remove(metadata_json, '$.${META_INTERRUPT_MCP_SCOPE}'), '$.${META_INTERRUPT}', ?),
      updated_at = ? WHERE id = ?
      AND json_extract(metadata_json, '$.${META_INTERRUPT}') IS ?
      AND json_extract(metadata_json, '$.${META_INTERRUPT_MCP_SCOPE}') IS ?`);
    openEventLog().transaction(() => {
      const result = updated.run(serialized, new Date().toISOString(), this.row.id, expected,
        expectedScope == null ? null : JSON.stringify(expectedScope));
      if (result.changes !== 1) throw new Error('Approval interrupt changed before it could be saved');
      if (scope !== null) openEventLog().prepare(`UPDATE sessions SET metadata_json =
        json_set(metadata_json, '$.${META_INTERRUPT_MCP_SCOPE}', json(?)) WHERE id = ?`).run(scope, this.row.id);
    }).immediate();
    this.refresh();
    appendEvent({
      sessionId: this.row.id,
      turn: 0,
      role: 'system',
      type: 'run_paused',
      data: { bytes: serialized.length },
    });
  }

  loadInterruptState(sourceUserSeq?: number): string | null {
    if (sourceUserSeq !== undefined) this.selectedApprovalSource = sourceUserSeq;
    if (this.selectedApprovalSource !== undefined) {
      const snapshot = sourceApprovalSnapshotFromMetadata(this.row.metadata, this.selectedApprovalSource);
      if (snapshot.revision !== null) return snapshot.checkpoint?.serialized ?? null;
      const legacy = this.row.metadata[META_INTERRUPT];
      return typeof legacy === 'string'
        && hostApprovalCheckpointSource(legacy, this.row.id) === this.selectedApprovalSource ? legacy : null;
    }
    const raw = this.row.metadata[META_INTERRUPT];
    if (typeof raw === 'string') return raw;
    const storedSource = this.defaultStoredApprovalSource();
    return storedSource === undefined ? null
      : sourceApprovalSnapshotFromMetadata(this.row.metadata, storedSource).checkpoint?.serialized ?? null;
  }

  /** Exact MCP scope captured beside the currently parked RunState. */
  loadInterruptMcpToolScope(sourceUserSeq?: number): McpToolScope | null {
    if (sourceUserSeq !== undefined) this.selectedApprovalSource = sourceUserSeq;
    if (this.selectedApprovalSource !== undefined) {
      const snapshot = sourceApprovalSnapshotFromMetadata(this.row.metadata, this.selectedApprovalSource);
      if (snapshot.revision !== null) return snapshot.checkpoint?.mcpToolScope ?? null;
      if (!this.loadInterruptState(this.selectedApprovalSource)) return null;
    }
    if (typeof this.row.metadata[META_INTERRUPT] !== 'string') {
      const storedSource = this.defaultStoredApprovalSource();
      if (storedSource !== undefined) return sourceApprovalSnapshotFromMetadata(this.row.metadata, storedSource).checkpoint?.mcpToolScope ?? null;
    }
    const raw = this.row.metadata[META_INTERRUPT_MCP_SCOPE];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const scope = raw as Partial<McpToolScope>;
    if (typeof scope.reason !== 'string' || !scope.reason.trim()) return null;
    // Return a detached value: agent construction may add queryText, and that
    // must not mutate the durable pause record.
    try {
      return JSON.parse(JSON.stringify(scope)) as McpToolScope;
    } catch {
      return null;
    }
  }

  clearInterruptState(options: { emitEvent?: boolean } = {}): void {
    workflowParentActivation(this.row.id);
    const legacy = this.row.metadata[META_INTERRUPT];
    const sourceUserSeq = this.selectedApprovalSource ?? (typeof legacy === 'string'
      ? hostApprovalCheckpointSource(legacy, this.row.id) : this.defaultStoredApprovalSource());
    if (sourceUserSeq !== undefined) {
      const observed = sourceApprovalSnapshotFromMetadata(this.row.metadata, sourceUserSeq);
      if (observed.revision !== null) {
        const changed = openEventLog().transaction(() => {
          const result = replaceSourceApprovalCheckpoint({ sessionId: this.row.id, sourceUserSeq,
            expectedRevision: observed.revision, checkpoint: null });
          if (!result.updated) return false;
          this.projectSourceApproval();
          return true;
        }).immediate();
        if (!changed) return;
        this.refresh();
        if (observed.checkpoint && options.emitEvent !== false) appendEvent({ sessionId: this.row.id,
          turn: 0, role: 'system', type: 'run_resumed', data: { sourceUserSeq } });
        return;
      }
      if (!this.loadInterruptState(sourceUserSeq)) return;
    }
    const hadInterrupt = META_INTERRUPT in this.row.metadata;
    const hadScope = META_INTERRUPT_MCP_SCOPE in this.row.metadata;
    if (!hadInterrupt && !hadScope) return;
    const expected = this.row.metadata[META_INTERRUPT] ?? null;
    const expectedScope = this.row.metadata[META_INTERRUPT_MCP_SCOPE];
    const result = openEventLog().prepare(`UPDATE sessions SET metadata_json =
      json_remove(metadata_json, '$.${META_INTERRUPT}', '$.${META_INTERRUPT_MCP_SCOPE}'), updated_at = ?
      WHERE id = ? AND json_extract(metadata_json, '$.${META_INTERRUPT}') IS ?
      AND json_extract(metadata_json, '$.${META_INTERRUPT_MCP_SCOPE}') IS ?`)
      .run(new Date().toISOString(), this.row.id, expected,
        expectedScope == null ? null : JSON.stringify(expectedScope));
    if (result.changes !== 1) return;
    this.refresh();
    if (!hadInterrupt || options.emitEvent === false) return;
    appendEvent({
      sessionId: this.row.id,
      turn: 0,
      role: 'system',
      type: 'run_resumed',
      data: {},
    });
  }

  /**
   * Install this turn's recovery checkpoint.
   *
   * `owner` FENCES the write to one exact activation. A source number alone
   * does not identify an activation: two activations of the SAME source
   * compete, and the older one was able to replace the newer one's checkpoint.
   * The predicate is therefore exact ownership, not a numeric comparison —
   * either nothing is installed, or the installed owner is precisely us.
   *
   * The write touches ONLY the recovery keys. It previously replaced the whole
   * metadata document from a CACHED copy, so any unrelated field written after
   * this instance loaded was silently erased.
   *
   * A source that already published a typed terminal owns nothing further: a
   * late response must never revive finished work.
   */
  saveRecoveryState(
    serialized: string,
    options: {
      mcpToolScope?: McpToolScope | null;
      owner?: RecoveryOwner;
    } = {},
  ): RecoverySaveOutcome {
    const scope = options.mcpToolScope && typeof options.mcpToolScope.reason === 'string'
      ? JSON.parse(JSON.stringify(options.mcpToolScope)) as McpToolScope
      : null;
    const owner = options.owner;
    const ownerToken = owner ? recoveryOwnerToken(owner) : null;

    if (owner && this.acceptedSourceHasTypedTerminal(owner.sourceUserSeq)) {
      return { installed: false, reason: 'source_terminalized' };
    }

    // ONE nested expression touching only our own keys. `json_set` leaves every
    // unrelated field alone, so a concurrent writer's metadata survives. Built
    // outward, so the textual order of the placeholders matches `bound`.
    let expr = `json_set(metadata_json, '$.${META_RECOVERY}', ?)`;
    const bound: unknown[] = [serialized];
    if (ownerToken !== null) {
      expr = `json_set(${expr}, '$.${META_RECOVERY_OWNER}', json(?))`;
      bound.push(ownerToken);
    }
    if (scope) {
      expr = `json_set(${expr}, '$.${META_RECOVERY_MCP_SCOPE}', json(?))`;
      bound.push(JSON.stringify(scope));
    } else {
      expr = `json_remove(${expr}, '$.${META_RECOVERY_MCP_SCOPE}')`;
    }

    // Ownership predicate, in the SAME statement as the write.
    //
    // Three ways to hold the blob, and only three:
    //   1. nothing is installed;
    //   2. the installed owner is exactly us — an ordinary re-hold;
    //   3. we are the session's NEWEST activation, so nothing that could still
    //      be running has a better claim.
    //
    // (3) is judged by `run_attempts.started_at`, the canonical per-session
    // activation ordering this codebase already fences run ownership with. A
    // source number alone cannot do it: two activations of the SAME source
    // compete. Liveness alone cannot either — a SIGKILLed attempt never
    // records finished_at, so requiring the previous owner to be finished
    // would deadlock every restart out of its own recovery, which is the very
    // failure this fence exists to prevent.
    //
    // Taking over is therefore a claim only the newest activation can make.
    // That covers a blob whose owner sidecar is missing or unreadable — legacy
    // bytes, or a corrupt read — WITHOUT wedging the session: unknown ownership
    // does not block the one activation that provably supersedes it, and it
    // does block every stale one.
    const ownership = ownerToken === null
      ? ''
      : ` AND (
            json_extract(metadata_json, '$.${META_RECOVERY}') IS NULL
            OR (json_extract(metadata_json, '$.${META_RECOVERY_OWNER}.sourceUserSeq') = ?
                AND json_extract(metadata_json, '$.${META_RECOVERY_OWNER}.attemptId') IS ?)
            OR EXISTS (
                 SELECT 1 FROM run_attempts AS mine
                  WHERE mine.session_id = sessions.id
                    AND mine.attempt_id = ?
                    AND NOT EXISTS (
                          SELECT 1 FROM run_attempts AS newer
                           WHERE newer.session_id = sessions.id
                             AND newer.started_at > mine.started_at
                        )
               )
          )`;

    bound.push(new Date().toISOString(), this.row.id);
    if (owner && ownerToken !== null) {
      bound.push(owner.sourceUserSeq, owner.attemptId ?? null, owner.attemptId ?? null);
    }

    try {
      const result = openEventLog().prepare(`
        UPDATE sessions SET metadata_json = ${expr}, updated_at = ?
         WHERE id = ?${ownership}
      `).run(...bound as never[]);
      this.refresh();
      return result.changes === 1
        ? { installed: true }
        : { installed: false, reason: 'owner_conflict' };
    } catch {
      return { installed: false, reason: 'storage_failure' };
    }
  }

  /**
   * Whether one accepted source already published a TYPED terminal.
   *
   * Deliberately typed-only: the compatibility projection turns a legacy or
   * corrupt row into a conservative blocked terminal so it never returns null,
   * which would let an unreadable row fence a live activation out of its own
   * recovery.
   */
  private acceptedSourceHasTypedTerminal(sourceUserSeq: number): boolean {
    if (!Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) return false;
    try {
      const source = listEvents(this.row.id, { types: ['user_input_received'] })
        .find((candidate) => candidate.seq === sourceUserSeq);
      if (!source) return false;
      return resolveExactTerminalForAcceptedSource(source).kind === 'terminal';
    } catch {
      // An unreadable eventlog is not proof of a terminal. Refusing here would
      // deny a live activation its own checkpoint on a transient read failure.
      return false;
    }
  }

  /**
   * Does the DURABLY installed recovery belong to this exact activation?
   *
   * The desktop bridge asks before finishing its run attempt. A held turn whose
   * recovery owner is armed must keep its attempt live: every later child lease
   * names that attempt, and `isDispatchLeaseCurrent` correctly refuses any
   * lineage whose bound attempt has finished. Live 2026-09-07 source 140867 —
   * the attempt was finished at 02:41:24.777 while its own scheduled recovery
   * ran on, and fifteen consecutive calls were refused
   * `child_lease_activation_failed` before the owner was asked to retype the
   * request. The board never changed.
   *
   * Positive evidence only: no sidecar, unreadable metadata, or a different
   * owner all answer false, so a turn can never claim "held with recovery
   * armed" without an actual owner and checkpoint behind it.
   */
  recoveryOwnedByActivation(owner: { sourceUserSeq: number; attemptId?: string | undefined }): boolean {
    try {
      const row = openEventLog().prepare(
        `SELECT json_extract(metadata_json, '$.${META_RECOVERY}') AS blob,
                json_extract(metadata_json, '$.${META_RECOVERY_OWNER}.sourceUserSeq') AS src,
                json_extract(metadata_json, '$.${META_RECOVERY_OWNER}.attemptId') AS att
           FROM sessions WHERE id = ?`,
      ).get(this.row.id) as { blob?: unknown; src?: unknown; att?: unknown } | undefined;
      if (!row || typeof row.blob !== 'string' || !row.blob) return false;
      if (row.src !== owner.sourceUserSeq) return false;
      return (row.att ?? null) === (owner.attemptId ?? null);
    } catch {
      return false;
    }
  }

  /**
   * Claim continuation responsibility for one exact activation. Idempotent;
   * a newer source's claim replaces an older one's.
   */
  claimContinuationOwner(owner: { sourceUserSeq: number; attemptId?: string | undefined }): boolean {
    try {
      const result = openEventLog().prepare(`
        UPDATE sessions
           SET metadata_json = json_set(metadata_json, '$.${META_CONTINUATION_OWNER}', json(?)),
               updated_at = ?
         WHERE id = ?
           AND COALESCE(json_extract(metadata_json, '$.${META_CONTINUATION_OWNER}.sourceUserSeq'), 0) <= ?
      `).run(
        JSON.stringify({ sourceUserSeq: owner.sourceUserSeq, attemptId: owner.attemptId ?? null }),
        new Date().toISOString(),
        this.row.id,
        owner.sourceUserSeq,
      );
      this.refresh();
      return result.changes === 1;
    } catch {
      return false;
    }
  }

  /**
   * Is this activation still responsible for the turn?
   *
   * `unreadable` is deliberately distinct from `absent`: a metadata read
   * failure is not evidence that execution stopped, and the caller must not
   * treat it as permission to finish the owner.
   */
  continuationOwnerState(
    owner: { sourceUserSeq: number; attemptId?: string | undefined },
  ): 'ours' | 'other' | 'absent' | 'unreadable' {
    let row: { src?: unknown; att?: unknown } | undefined;
    try {
      row = openEventLog().prepare(
        `SELECT json_extract(metadata_json, '$.${META_CONTINUATION_OWNER}.sourceUserSeq') AS src,
                json_extract(metadata_json, '$.${META_CONTINUATION_OWNER}.attemptId') AS att
           FROM sessions WHERE id = ?`,
      ).get(this.row.id) as { src?: unknown; att?: unknown } | undefined;
    } catch {
      return 'unreadable';
    }
    if (!row) return 'unreadable';
    if (row.src === null || row.src === undefined) return 'absent';
    if (row.src !== owner.sourceUserSeq) return 'other';
    return (row.att ?? null) === (owner.attemptId ?? null) ? 'ours' : 'other';
  }

  /** Release continuation responsibility held by this exact activation. */
  releaseContinuationOwner(owner: { sourceUserSeq: number; attemptId?: string | undefined }): boolean {
    try {
      const result = openEventLog().prepare(`
        UPDATE sessions
           SET metadata_json = json_remove(metadata_json, '$.${META_CONTINUATION_OWNER}'),
               updated_at = ?
         WHERE id = ?
           AND json_extract(metadata_json, '$.${META_CONTINUATION_OWNER}.sourceUserSeq') = ?
           AND json_extract(metadata_json, '$.${META_CONTINUATION_OWNER}.attemptId') IS ?
      `).run(new Date().toISOString(), this.row.id, owner.sourceUserSeq, owner.attemptId ?? null);
      this.refresh();
      return result.changes === 1;
    } catch {
      return false;
    }
  }

  loadRecoveryState(): string | null {
    const raw = this.row.metadata[META_RECOVERY];
    return typeof raw === 'string' ? raw : null;
  }

  loadRecoveryMcpToolScope(): McpToolScope | null {
    const raw = this.row.metadata[META_RECOVERY_MCP_SCOPE];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const scope = raw as Partial<McpToolScope>;
    if (typeof scope.reason !== 'string' || !scope.reason.trim()) return null;
    try {
      return JSON.parse(JSON.stringify(scope)) as McpToolScope;
    } catch {
      return null;
    }
  }

  /**
   * Clear the recovery blob.
   *
   * `expectedSerialized` retires EXACTLY those bytes: retiring a superseded
   * owner must never erase a blob another source installed in the interim. An
   * unconditional clear is still available for the in-flight paths that own the
   * turn they are clearing.
   */
  clearRecoveryState(expectedSerialized?: string): boolean {
    const updatedAt = new Date().toISOString();
    const removal = `metadata_json = json_remove(metadata_json, '$.${META_RECOVERY}', '$.${META_RECOVERY_MCP_SCOPE}', '$.${META_RECOVERY_OWNER}')`;
    let changes = 0;
    try {
      const db = openEventLog();
      // The condition lives in the STATEMENT, so the compare and the swap are
      // one durable step. Comparing cached metadata first and updating after
      // left a window in which a concurrent install was silently erased, and
      // reported success either way.
      const result = expectedSerialized === undefined
        ? db.prepare(`
            UPDATE sessions SET ${removal}, updated_at = ?
             WHERE id = ?
               AND (json_extract(metadata_json, '$.${META_RECOVERY}') IS NOT NULL
                 OR json_extract(metadata_json, '$.${META_RECOVERY_MCP_SCOPE}') IS NOT NULL)
          `).run(updatedAt, this.row.id)
        : db.prepare(`
            UPDATE sessions SET ${removal}, updated_at = ?
             WHERE id = ?
               AND json_extract(metadata_json, '$.${META_RECOVERY}') = ?
          `).run(updatedAt, this.row.id, expectedSerialized);
      changes = result.changes;
    } catch {
      // A storage failure retires nothing. Reporting false keeps the caller on
      // the ownership-preserving branch instead of announcing a retirement
      // that never reached the database.
      return false;
    }
    this.refresh();
    return changes === 1;
  }

  /**
   * Adopt one already-verified ready model-batch checkpoint and release its
   * private recovery owner in the same local transaction. The exact serialized
   * state is the compare-and-swap token: a concurrent replacement cannot be
   * erased or paired with the wrong conversation snapshot.
   */
  adoptRecoveredConversation(input: {
    serializedState: string;
    history: AgentInputItem[];
    lastResponseId: string | undefined;
  }): boolean {
    const db = openEventLog();
    const snapshot: PersistedConversation = {
      items: input.history,
      lastResponseId: input.lastResponseId,
      updatedAt: new Date().toISOString(),
    };
    const adopted = db.prepare(`
      UPDATE sessions
         SET metadata_json = json_remove(
               json_set(metadata_json, '$.__conversation', json(?)),
               '$.__host_recovery_state',
               '$.__host_recovery_mcp_scope'
             ),
             updated_at = ?
       WHERE id = ?
         AND json_extract(metadata_json, '$.__host_recovery_state') = ?
    `).run(
      JSON.stringify(snapshot),
      snapshot.updatedAt,
      this.row.id,
      input.serializedState,
    );
    this.refresh();
    return adopted.changes === 1;
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
  // The marker belongs to the foreground executor. A workflow-parent
  // activation already owns its source-specific durable lease and must not
  // replace or clear a newer foreground marker.
  setRunInFlight(at: string = new Date().toISOString()): void {
    if (workflowParentActivation(this.row.id)) return;
    openEventLog().prepare(`UPDATE sessions SET metadata_json =
      json_set(metadata_json, '$.${META_RUNNING}', ?), updated_at = ? WHERE id = ?`)
      .run(at, new Date().toISOString(), this.row.id);
    this.refresh();
  }

  clearRunInFlight(): void {
    if (workflowParentActivation(this.row.id)) return;
    const expected = this.row.metadata[META_RUNNING];
    if (typeof expected !== 'string') return;
    const result = openEventLog().prepare(`UPDATE sessions SET metadata_json =
      json_remove(metadata_json, '$.${META_RUNNING}'), updated_at = ?
      WHERE id = ? AND json_extract(metadata_json, '$.${META_RUNNING}') = ?`)
      .run(new Date().toISOString(), this.row.id, expected);
    if (result.changes === 1) this.refresh();
  }

  /** ISO timestamp a still-in-flight run started at, or null. */
  runInFlightSince(): string | null {
    const raw = this.row.metadata[META_RUNNING];
    return typeof raw === 'string' ? raw : null;
  }
}
