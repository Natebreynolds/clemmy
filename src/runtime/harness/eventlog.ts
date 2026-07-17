import Database from 'better-sqlite3';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BASE_DIR } from '../../config.js';
import { actionBus } from '../action-bus.js';
import { mirrorEventToOperational } from './eventlog-operational-mirror.js';

/**
 * Event log — the spine of the 0.3 harness.
 *
 * Mirrors the SQLite pattern used by src/memory/db.ts: WAL + NORMAL,
 * schema_version migrations, cached singleton handle, reset for tests.
 *
 * One file: ~/.clementine-next/state/harness.db. Holds three tables:
 *   - sessions       : one row per chat / execution / workflow / agent run
 *   - events         : append-only, monotonic seq, JSON payload
 *   - kill_switches  : session_id rows that pause the next turn_started
 *
 * The harness reads events to rebuild Session state on replay. The event
 * log is the single source of truth for run-derived state; durable user
 * artifacts (vault, secrets, profile) stay on disk in their own files.
 */

export const HARNESS_STATE_DIR = path.join(BASE_DIR, 'state');
export const HARNESS_DB_PATH = path.join(HARNESS_STATE_DIR, 'harness.db');

/**
 * Closed enum of event types. Any append with a type not in this set
 * is rejected — there is no "free-form" event. New types require a
 * code change so the replay code is forced to handle them.
 */
export const EVENT_TYPES = [
  'session_started',
  'turn_started',
  'turn_ended',
  'condenser_applied',
  'plan_drafted',
  'plan_approved',
  'plan_revised',
  'plan_rejected',
  'step_started',
  'tool_called',
  'tool_returned',
  'step_verified',
  'step_failed',
  'handoff',
  'awaiting_user_input',
  'user_input_received',
  // Turn-control preflight: one typed read/align/execute decision tied to the
  // latest user-input event. The prompt may explain an alignment beat, but the
  // tool boundary reads this durable state so ignoring the prose cannot start
  // execution before the user's next turn.
  'turn_preflight_decision',
  'approval_requested',
  'approval_resolved',
  // Token-level streaming: emitted for each output_text_delta from the model.
  // Not persisted to SQLite — only broadcast via actionBus for real-time UI.
  'stream_token',
  // Loop intent proposal: surfaced before tools fire on multi-step requests.
  // Contains the planned objective, steps, and risks.
  'loop_intent_proposed',
  // Goal-contract validation (goal-contract Phase 3): emitted when a session's
  // parked goal is validated on self-declared completion — pass/fail, attempt.
  'goal_validation',
  'guardrail_tripped',
  'stuck_detected',
  // Emitted from the conversation loop when stuck_detected fires AND
  // the harness has retry budget remaining. The retry sends a synthetic
  // "act now" message to the same sub-agent before giving up. If the
  // retry also stalls, the original sub_agent_stalled outcome surfaces
  // as today.
  'stall_retry_attempted',
  'heartbeat',
  'kill_requested',
  'run_paused',
  'run_resumed',
  'run_completed',
  'run_failed',
  // Multi-turn auto-continuation: emitted at the boundary between
  // two runTurn() calls inside the same runConversation(). The
  // OrchestratorDecision drives whether the loop recurses.
  'conversation_step',
  'conversation_completed',
  'conversation_limit_exceeded',
  // Auto-capture writeback: emitted from the harness loop whenever a
  // user message produced durable facts or a profile patch via
  // captureInteractionSignals. Lets the trace show "Clementine learned
  // X from this turn" so memory growth is observable.
  'memory_signals_captured',
  // Cross-session prefix: when a new Discord (or other channel) session
  // opens within the continuity window of a prior same-channel session,
  // the harness prepends ONE event of this type carrying the prior
  // session's last user message + agent reply. session_history then
  // returns this context so back-references like "first 10 please"
  // can be interpreted. Added 2026-05-24.
  'cross_session_prefix',
  // v0.5.19 F2 — auto-elevate emits this when the preflight gate sees
  // a 'warn' or 'block' verdict early in a `standard`-preset
  // conversation. Carries the from/to caps so the dashboard can show
  // why the budget changed mid-run.
  'budget_elevated',
  // SDK brain auto-continued past a per-query max-turns budget instead of parking
  // on "say continue" (F1). Carries the attempt # and whether it's still limited.
  'sdk_auto_continue',
  // SDK local-MCP startup guard retried because the required local tool surface
  // was empty or no init message arrived before the startup budget.
  'sdk_tool_surface_retry',
  // Spawn→first-stream-byte latency for one SDK query (WS5-L2). The usage log
  // has it too; this copy makes TTFT scoreable from the eventlog (proof
  // harness, speculative-routing acceptance telemetry).
  'sdk_first_byte',
  // Per-turn prompt-prefix cache-hit ratio on the default brain lane — makes the
  // freeze-stable-prefix cache lever scoreable from the eventlog (2026-07-09).
  'sdk_cache',
  // WHICH model/lane served a chat turn (respond bridge, once per turn):
  // {model, routeKind, surface}. The durable answer to "who actually served
  // this?" — brain-matrix assertions, fallover forensics, route-policy audit.
  'turn_model_routed',
  // The Claude Agent SDK's child process compacted its own context mid-run
  // (subtype 'compact_boundary' relay; pre/post tokens + trigger). Mirror of the
  // Codex lane's condenser_applied — proves long runs manage context instead of
  // dying at the window cliff.
  'sdk_compact_boundary',
  // The SDK reported a FAILED compaction (status message compact_result:'failed').
  'sdk_compact_failed',
  // Tool-injection scoping: emitted at agent construction so traces can
  // explain why a run saw a small external MCP surface instead of every
  // configured server tool.
  'mcp_tool_scope',
  // Per-turn memory primer: emitted when the harness runs the local
  // FTS memory lookup for the latest user message before the model call.
  // The actual hits are injected transiently through callModelInputFilter
  // so they do not bloat persisted conversation history.
  'turn_memory_primer',
  // Post-turn memory credit: recall runs whose candidates demonstrably shaped
  // the turn's output (reply / tool args / drafted plan). Replaces the
  // never-called memory_mark_used tool with code-level attribution.
  'recall_auto_credit',
  // Per-turn deterministic context packet: summarizes the memory
  // primer, likely skills/workflows, MCP health, local health, and
  // complexity classification that were injected transiently before
  // the model call.
  'agent_context_packet',
  // Planner-first gate: fresh complex requests get a read-only plan
  // proposal before the full external MCP surface is opened.
  'plan_first_started',
  'plan_first_failed',
  // Flag-only native Codex compaction proof: emitted when the harness
  // persists a Codex `compaction` item from raw model responses and
  // prunes replay history for the next continuation turn.
  'native_compaction_applied',
  // v0.5.19 F3 — preflight gate fires this for workflow/execution/
  // agent kinds when a turn projects over the context block
  // threshold. Workflows have no user to consult mid-step so they
  // proceed — but the dashboard now sees the risk and a future
  // workflow-runner extension can react (split / abort / retry).
  'workflow_step_overbudget',
  // Move 2 (confirm-first gate): emitted by the tool-boundary gate each
  // time a mutating external write is ALLOWED through. The gate counts
  // these per session+shape to detect a batch (≥ threshold same-shape
  // writes) and require an instruction-reviewed plan scope before the
  // batch proceeds. Emitted from the gate (not hooks) so worker/sub-agent
  // writes — which share the parent session via AsyncLocalStorage but may
  // not log tool_called under it — are counted reliably.
  'external_write',
  // Compensation record: the dispatch behind an external_write demonstrably
  // FAILED (e.g. composio schema rejection) — the duplicate-target gate nets
  // one matching prior per failure so corrected retries aren't "duplicates".
  'external_write_failed',
  // S3 orphan ledger: a MUTATING external write TIMED OUT. The harness stops
  // waiting but the request MAY have landed server-side (it is aborted at the
  // network layer — recorded in `aborted`). Durable audit of maybe-landed
  // writes, and the signal the orphaned-write retry corrective consults before
  // a blind same-shape retry.
  'external_write_orphaned',
  // Always-on telemetry: a run_worker sub-agent hit its turn ceiling
  // (MaxTurnsExceeded). Worker nested runs carry no harness hooks, so this is
  // the only signal of worker turn-cap hits — used to recalibrate
  // CLEMMY_WORKER_MAX_TURNS from real data.
  'worker_capped',
  // A fan-out worker STARTING — lets the chat/board render the specialist as
  // running the moment it spawns (not only when worker_result lands).
  'worker_started',
  // Deterministic batch runner (run_batch): plan execution started / a single
  // item failed (with consecutive-failure count) / the whole batch finished
  // with honest counts. The loop makes NO model calls, so these events are the
  // primary visibility into what it did.
  'batch_started',
  'batch_progress',
  'batch_item_failed',
  'batch_completed',
  // Code-mode program visibility (Track 4): clem.progress('…') narration lines
  // from inside a running program, and ONE per-program summary {ok, rpcCalls,
  // durationMs, completed/failed} — the adoption/efficiency measurement the
  // code-mode mandate's DELETE-WHEN-VALIDATED note waits on.
  'codemode_progress',
  'codemode_program_summary',
  // NON-halting record that, in YOLO, an approval-shaped ask_user_question was
  // auto-resolved (standing approval) and the run proceeded instead of pausing.
  // Distinct from awaiting_user_input precisely so it does NOT halt the loop.
  'autonomy_note',
  // Per-turn dynamic reasoning effort: which effort tier (low/medium/high) was
  // selected for this turn's model call and why. gpt-5.x reasons before emitting
  // tokens, so this is the main per-turn latency lever — recorded for observability.
  'reasoning_effort',
  // A fan-out item was routed to a per-task model by an intent rule (model
  // role registry) — records the attempted intent, whether it matched, and the
  // resolved model/provider, so a trace can show "ran on Opus because 'design'".
  'worker_model_routed',
  // A fan-out worker COMPLETED — durable record of {item, ok, model, toolUses,
  // tokens} (Move 5). The honest N-of-M coverage map was in-memory only, so a
  // mid-run daemon restart lost it; this makes the swarm's coverage + per-worker
  // spend restart-surviving and queryable for a 30-60min 100-subagent run.
  'worker_result',
  // Wave 4 Stage 2: a run/continue boundary for a background task's stable
  // runSessionId, so fan-out coverage (summarizeFanoutCoverage) counts only THIS
  // run's worker_results and a prior run's failures don't leak into a later
  // continue's completion check (would permanently block a re-completed task).
  'fanout_run_boundary',
  // Move 2: deterministic pre-execution coherence critique of a surfaced plan
  // (uncovered success criteria, unverifiable steps) — surfaced before approval so
  // a walk-away user never green-lights a structurally weak 100-subagent plan.
  'plan_critiqued',
  // Turn-start swarm governance decision: the context packet detected a
  // multi-item request and either offered fanout, constrained it, or kept the
  // work centralized under the current coordination policy. Pure telemetry.
  'fanout_policy_decision',
  // Engine-over-prompt A/B substrate: emitted at agent construction with the
  // rubric variant in force (CLEMMY_RUBRIC_VARIANT) so a live session is
  // attributable to an arm (legacy vs a future lean prune). Sibling of
  // mcp_tool_scope — pure telemetry, never alters behavior.
  'rubric_variant',
  // Phase 1 Tool-RAG: emitted at agent construction when JIT tool loading
  // (CLEMMY_TOOL_JIT) actually reduced the built-in surface — records how many
  // tools were dropped + the selection reason, so a trace explains a smaller
  // surface and an A/B can attribute token/accuracy deltas. Sibling of
  // mcp_tool_scope; only emitted when a reduction occurred.
  'tool_jit_scope',
  // Schema-on-demand surface (SCHEMA-ON-DEMAND-PLAN-2026-07-07): when the Codex lane
  // moves discovery tools off the first-class schema surface into the catalog block
  // (reachable via call_tool), this records the arm + first-class/catalog counts and
  // estimated tokens so the A/B can attribute the token delta. Sibling of
  // tool_jit_scope; pure telemetry, never alters dispatch.
  'tool_search_scope',
  // Central tool-policy resolver: emitted at model-boundary construction after
  // allow/deny resolution so every brain can show which local tool surface it
  // actually received. Telemetry only; never alters dispatch.
  'tool_policy_resolved',
  // The goal-alignment judge ran on an irreversible write and PASSED
  // (fulfills=true) — the aligned-proceed case is otherwise silent, so this
  // proves the judge fired BEFORE a YOLO silent-proceed (the 2026-06-22
  // CLEMMY_GOAL_ALIGNMENT_GATE fix). Pure telemetry; never alters behavior.
  'goal_alignment_judged',
  // The numeric/output-grounding gate ran on a deliverable (a chat-delivered
  // report or an irreversible-write payload) and reached a verdict — pass,
  // advisory (a load-bearing figure could not be traced to a tool result), or
  // the gate confirmed every figure traces to captured data. The bounce case
  // emits guardrail_tripped(kind:output_grounding_blocked) instead (mirrors
  // grounding_blocked). Pure telemetry on the non-block paths. (2026-06-23
  // trust-layer P1.)
  'output_grounding_judged',
  // OODA re-Orient feedback edge: emitted when a self-driving goal resume folds
  // fresh monitor observations (inbox/calendar needs-you items that landed since
  // the last cycle and overlap the goal) into the resume directive — so the turn
  // re-reads the world before continuing instead of re-pursuing blind. Carries
  // {phase:'reorient', scope:'goal', observationsInjected}. Sibling of
  // tool_jit_scope / rubric_variant — pure telemetry, never alters behavior; the
  // measurement spine for the goal re-Orient feature (default since 2026-06-27). (2026-06-24.)
  'ooda_cycle',
  // W1a chat step-boundary brain fallover: a transient model/codex error on one
  // brain was re-dispatched to the next brain mid-conversation (carries
  // {reason, kind, toModel, attempt}). Telemetry + the visible parity twin of the
  // workflow runner's step_advisory{reason:'brain_fallover'}.
  'brain_fallover',
  // Unattended infra self-heal: a workflow/background run hit a transient infra
  // error (5xx / timeout / tool-timeout) and, having no human to answer the
  // "retry/switch/stop" ask, auto-retried the same failed call instead. Carries
  // {kind, attempt, max}. Bounded — after the budget the run fails honestly.
  'infra_auto_recover',
  // Stranded-tool reunification: a turn DIED on an infra error while a tool
  // (e.g. a run_batch) was still IN FLIGHT. `orphaned_tool_inflight` {callId,
  // toolName} registers it at death; once the tool completes, drainOrphanedTool-
  // Completions emits `orphaned_tool_reported` {callId} (dedup) and fires a
  // follow-up report turn so the session self-reports the result to the user.
  'orphaned_tool_inflight',
  'orphaned_tool_reported',
  // Parse-exhaustion recovery marker: a `conversation_completed` with
  // reason 'no_structured_output' (the internal "couldn't be structured"
  // apology) is being re-run once on the next brain. Appended BEFORE the
  // recovery hop so transcript reconstruction can suppress the apology turn
  // and show ONLY the recovered reply. Carries {reason, recoveryModel,
  // supersededAt?}. Absent when a genuine dead-end apology has no recovery,
  // so the sole reply still renders. (2026-07-03.)
  'conversation_superseded',
  // Restart recovery decision: emitted once per interrupted chat session found
  // on boot, before the visible recovery notice/resume dispatch. Carries the
  // safety evidence behind auto-resume vs manual-continue so restart recovery is
  // auditable from the event log, not only from daemon boot logs.
  'restart_recovery_decision',
  // Judge verdict audit row (T3-B4 verdict door): ONE canonical event for every
  // completion/goal/target/delivery judge verdict, emitted by the call sites
  // that own the session context. Carries {door, pass, reason, failedOpen,
  // selfJudge, durationMs?, detail?} so run views and forensics read verdicts
  // from the event log instead of scraping heartbeats and prose.
  'verdict_recorded',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

export type SessionKind = 'chat' | 'execution' | 'workflow' | 'agent';
export type SessionStatus = 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface SessionRow {
  id: string;
  kind: SessionKind;
  channel: string | null;
  userId: string | null;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  title: string | null;
  objective: string | null;
  tokenBudget: number | null;
  tokensUsed: number;
  currentPlanId: string | null;
  metadata: Record<string, unknown>;
}

export interface HarnessSessionSignal {
  id: string;
  kind: SessionKind;
  channel: string | null;
  userId: string | null;
  status: SessionStatus;
  title: string | null;
  objective: string | null;
  updatedAt: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface RunAttemptRef {
  sessionId: string;
  attemptId: string;
  runId: string | null;
  startedAt: string;
}

export interface KillRequestRef {
  sessionId: string;
  scopeKey: string;
  attemptId: string | null;
  runId: string | null;
  requestedAt: string;
  reason: string | null;
}

export interface KillRequestTarget {
  attemptId?: string | null;
  runId?: string | null;
  /** Exact accepted user event when the runtime boundary does not directly
   * carry the outer transport's attempt id. */
  sourceUserSeq?: number | null;
}

export interface RunAttemptRecord extends RunAttemptRef {
  finishedAt: string | null;
  status: 'active' | 'completed' | 'cancelled' | 'failed' | 'superseded' | 'interrupted';
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  /** Exact durable user-input event that originated this attempt. */
  sourceUserSeq: number | null;
}

export interface RunAttemptLeaseClaim {
  attempt: RunAttemptRef | null;
  claimed: boolean;
  reason: 'claimed' | 'active' | 'terminal';
  interruptedAttemptId: string | null;
}

export interface HarnessChatRequestReceipt {
  requestId: string;
  sessionId: string;
  runId: string;
  inputHash: string;
  sinceSeq: number;
  createdAt: string;
}

/** Durable negative authority for a client-owned chat request. This row may
 * exist before the corresponding request receipt: that is what closes the
 * race where Stop wins locally while the POST acknowledgement is in flight. */
export interface HarnessChatRequestCancellation {
  requestId: string;
  requestedAt: string;
  reason: string | null;
}

export interface EventRow {
  seq: number;
  id: string;
  sessionId: string;
  turn: number;
  role: string;
  type: EventType;
  parentEventId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface AppendEventInput {
  sessionId: string;
  turn: number;
  role: string;
  type: EventType;
  data?: Record<string, unknown>;
  parentEventId?: string;
}

export interface CreateSessionInput {
  id?: string;
  kind: SessionKind;
  channel?: string;
  userId?: string;
  title?: string;
  objective?: string;
  tokenBudget?: number;
  metadata?: Record<string, unknown>;
}

export interface ListEventsOptions {
  sinceSeq?: number;
  /** Inclusive ISO timestamp boundary. Useful for old run-attempt rows that
   * predate an explicit sequence watermark. Prefer sinceSeq when available. */
  sinceAt?: string;
  types?: EventType[];
  limit?: number;
  /** v0.5.19 Bug H — sort by seq DESC instead of ASC. Useful when
   *  combined with `limit` to get the MOST RECENT N events of a type.
   *  Default false (legacy ASC behavior). */
  desc?: boolean;
}

export interface ListSessionsOptions {
  kind?: SessionKind | SessionKind[];
  status?: SessionStatus | SessionStatus[] | 'any';
  channel?: string | string[];
  updatedAfter?: string;
  limit?: number;
  offset?: number;
}

let cached: Database.Database | null = null;

function ensureStateDir(): void {
  if (!existsSync(HARNESS_STATE_DIR)) {
    mkdirSync(HARNESS_STATE_DIR, { recursive: true });
  }
}

interface EventLogMigration {
  version: number;
  sql: string;
  backfill?: (db: Database.Database) => void;
}

const MIGRATIONS: EventLogMigration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL CHECK (kind IN ('chat','execution','workflow','agent')),
        channel         TEXT,
        user_id         TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('active','paused','completed','failed','cancelled')),
        title           TEXT,
        objective       TEXT,
        token_budget    INTEGER,
        tokens_used     INTEGER NOT NULL DEFAULT 0,
        current_plan_id TEXT,
        metadata_json   TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_status_updated ON sessions(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel) WHERE channel IS NOT NULL;

      CREATE TABLE IF NOT EXISTS events (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        id              TEXT NOT NULL UNIQUE,
        session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn            INTEGER NOT NULL,
        role            TEXT NOT NULL,
        type            TEXT NOT NULL,
        parent_event_id TEXT,
        data_json       TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_session_type ON events(session_id, type);

      CREATE TABLE IF NOT EXISTS kill_switches (
        session_id   TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        requested_at TEXT NOT NULL,
        reason       TEXT
      );
    `,
  },
  {
    // Reliability pass v0.4.20:
    //   - session_locks: legacy cross-process lock table. Its withSessionLock
    //     helper was removed in the 2026-07-09 subtraction pass (no live caller);
    //     the table CREATE is retained as an inert vestige — dropping it is a
    //     separate schema change, out of scope for that pass.
    //   - pending_approvals: addressable approval requests with per-row TTL.
    //     One row per `approval_requested` event. The reaper expires stale
    //     rows; the approval-registry resolves them by approval_id so a
    //     bare "approve" reply on a busy channel never silently routes to
    //     the wrong paused session.
    //
    // Both tables reference sessions(id) so they cascade on session delete.
    // session_locks is a small set (one row per actively-locked session,
    // typically <10 at peak); pending_approvals grows with usage but the
    // reaper keeps it bounded.
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS session_locks (
        session_id   TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        owner_pid    INTEGER NOT NULL,
        owner_token  TEXT NOT NULL,
        acquired_at  INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_approvals (
        approval_id   TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        channel       TEXT,
        channel_id    TEXT,
        requested_at  TEXT NOT NULL,
        expires_at    TEXT NOT NULL,
        subject       TEXT NOT NULL,
        tool          TEXT,
        args_json     TEXT,
        status        TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','resolved','expired','cancelled')),
        resolution    TEXT
                      CHECK (resolution IS NULL OR resolution IN ('approved','rejected','expired','cancelled_by_user')),
        resolver      TEXT,
        resolved_at   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_session_status
        ON pending_approvals(session_id, status);
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_channel_status
        ON pending_approvals(channel_id, status) WHERE channel_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_expires
        ON pending_approvals(expires_at) WHERE status = 'pending';
    `,
  },
  {
    // v0.5.10 auto-compact: lossless tool-output storage keyed by call_id.
    // The event log clips tool_returned payloads to 8KB at write-time
    // (see hooks.ts:202) for readability; that loss broke the
    // recall_tool_result promise. This table stores the full output
    // (up to 200KB) so an agent that sees `[clipped: ... call
    // recall_tool_result("call_xxx")]` can retrieve the verbatim
    // original. Append-only; cascade-deleted with the session.
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS tool_outputs (
        session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        call_id             TEXT NOT NULL,
        tool                TEXT,
        output_full         TEXT NOT NULL,
        content_bytes       INTEGER NOT NULL,
        truncated_at_write  INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL,
        PRIMARY KEY (session_id, call_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tool_outputs_session ON tool_outputs(session_id);
    `,
  },
  {
    // v0.5.19 F6 — persist tool-guardrail recent-call queue so the
    // loop-detection thresholds survive daemon restarts. Until v0.5.19
    // tool-guardrail.ts held SessionTrackerState only in-memory, which
    // meant multi-hour workflows that crossed a restart (autonomy
    // loops, cron-scheduled runs) lost their loop-detection history.
    // Append-only blob — one row per session_id, replaced on every
    // write-through (debounced every N calls). Cascade-deleted with
    // the session.
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS tool_guardrail_state (
        session_id  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        recent_json TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `,
  },
  {
    // Workflow-owned Claude SDK approval parking. A workflow query must be able
    // to release its child process + drain slot while a human reviews the exact
    // tool payload, then reuse that decision once after a daemon restart. The
    // resume key identifies the session/tool/payload; consumed_at is claimed
    // atomically before the approved call is allowed through.
    version: 5,
    sql: `
      ALTER TABLE pending_approvals ADD COLUMN resume_key TEXT;
      ALTER TABLE pending_approvals ADD COLUMN consumed_at TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_approvals_pending_resume_key
        ON pending_approvals(resume_key)
        WHERE resume_key IS NOT NULL AND status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_resume_history
        ON pending_approvals(resume_key, requested_at DESC)
        WHERE resume_key IS NOT NULL;
    `,
  },
  {
    // Guardrail trackers are keyed by an EXECUTION SCOPE, not always by a real
    // harness session id. Code mode, certified batches, and workers append
    // `::codeMode`, `::batch:*`, or `::w:*` to the parent session. The v4 table
    // incorrectly made that synthetic key a direct FK to sessions(id), so every
    // fifth scoped tool call failed to persist with FOREIGN KEY constraint
    // errors. Keep the scope isolated while anchoring its lifecycle to the real
    // parent session for cascade cleanup.
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS tool_guardrail_scope_state (
        scope_id          TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        recent_json       TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tool_guardrail_scope_parent
        ON tool_guardrail_scope_state(parent_session_id);
    `,
    backfill: (db) => {
      // A valid v4 database has both tables, but keep the additive migration
      // tolerant of old test fixtures and partially recovered databases. More
      // importantly, do not copy legacy orphan rows: older processes sometimes
      // opened SQLite without FK enforcement and left scope-looking ids in the
      // session-keyed table. Preserve only rows whose real parent still exists.
      const hasTable = (name: string): boolean => Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ).get(name));
      if (!hasTable('sessions') || !hasTable('tool_guardrail_state')) return;
      db.exec(`
        INSERT OR IGNORE INTO tool_guardrail_scope_state
          (scope_id, parent_session_id, recent_json, updated_at)
        SELECT legacy.session_id,
               CASE
                 WHEN instr(legacy.session_id, '::') > 0
                   THEN substr(legacy.session_id, 1, instr(legacy.session_id, '::') - 1)
                 ELSE legacy.session_id
               END,
               legacy.recent_json,
               legacy.updated_at
          FROM tool_guardrail_state AS legacy
          JOIN sessions AS parent
            ON parent.id = CASE
              WHEN instr(legacy.session_id, '::') > 0
                THEN substr(legacy.session_id, 1, instr(legacy.session_id, '::') - 1)
              ELSE legacy.session_id
            END;
      `);
    },
  },
  {
    // Turn-control reliability: cancellation belongs to one concrete run
    // attempt, not to a reusable chat session forever. `kill_switches` is kept
    // for compatibility with the Codex-loop callers, while the two additive
    // tables below carry the precise run/attempt identity used by interactive
    // channels and the Claude SDK brain.
    //
    // The terminal-key index makes a brain attempt's
    // `conversation_completed` append atomic/idempotent. A session legitimately
    // has many completion events across turns, so uniqueness is scoped to the
    // explicit terminalKey rather than merely (session,type).
    version: 7,
    sql: '',
    backfill: (db) => {
      const hasTable = (name: string): boolean => Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ).get(name));
      if (!hasTable('sessions')) return;
      db.exec(`
        CREATE TABLE IF NOT EXISTS run_attempts (
          attempt_id  TEXT PRIMARY KEY,
          session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          run_id      TEXT,
          started_at  TEXT NOT NULL,
          finished_at TEXT,
          status      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_run_attempts_session_active
          ON run_attempts(session_id, finished_at, started_at DESC);

        CREATE TABLE IF NOT EXISTS run_kill_requests (
          session_id  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          attempt_id  TEXT REFERENCES run_attempts(attempt_id) ON DELETE CASCADE,
          run_id      TEXT,
          requested_at TEXT NOT NULL,
          reason      TEXT
        );
      `);
      if (hasTable('events')) {
        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_events_terminal_key
            ON events(session_id, type, json_extract(data_json, '$.terminalKey'))
            WHERE type = 'conversation_completed'
              AND json_extract(data_json, '$.terminalKey') IS NOT NULL;
        `);
      }
    },
  },
  {
    // Desktop POST idempotency: the client owns request_id before sending, and
    // this durable receipt binds it to the server-created session, run identity,
    // original SSE cursor, and exact payload. A retry after a lost 202 or daemon
    // restart therefore rejoins the same turn instead of starting a second run.
    version: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS harness_chat_requests (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL UNIQUE,
        input_hash TEXT NOT NULL,
        since_seq INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_harness_chat_requests_session
        ON harness_chat_requests(session_id, created_at DESC);
    `,
  },
  {
    // A durable request receipt is only half of restart safety: an unfinished
    // attempt also needs bounded ownership. The desktop route renews this
    // lease while its process is alive; a new daemon interrupts foreign-owner
    // attempts at startup, and an expired lease can be reclaimed. This keeps a
    // crash between the 202 and terminal event from making a replay inert
    // forever, without permitting a second executor while the first is alive.
    version: 9,
    sql: '',
    backfill: (db) => {
      const hasAttempts = Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_attempts'`,
      ).get());
      if (!hasAttempts) return;
      const columns = new Set(
        (db.prepare('PRAGMA table_info(run_attempts)').all() as Array<{ name: string }>).map((row) => row.name),
      );
      if (!columns.has('lease_owner')) db.exec('ALTER TABLE run_attempts ADD COLUMN lease_owner TEXT');
      if (!columns.has('lease_expires_at')) db.exec('ALTER TABLE run_attempts ADD COLUMN lease_expires_at TEXT');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_run_attempts_lease
        ON run_attempts(finished_at, lease_expires_at)`);
    },
  },
  {
    // A run attempt must point at the exact user-input event that created it.
    // Timestamps are not an identity: a reusable desktop chat can receive a new
    // input while the prior attempt is still the newest row, and recovery/UI
    // projections otherwise guess the wrong scope. Keep this additive so old
    // attempts remain valid (NULL means the historical source was not recorded).
    version: 10,
    sql: '',
    backfill: (db) => {
      const hasAttempts = Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_attempts'`,
      ).get());
      if (!hasAttempts) return;
      const columns = new Set(
        (db.prepare('PRAGMA table_info(run_attempts)').all() as Array<{ name: string }>).map((row) => row.name),
      );
      if (!columns.has('source_user_seq')) {
        db.exec('ALTER TABLE run_attempts ADD COLUMN source_user_seq INTEGER REFERENCES events(seq)');
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_run_attempts_source_user
        ON run_attempts(session_id, source_user_seq)`);
    },
  },
  {
    // A reusable chat can briefly have attempt A still executing while attempt
    // B is accepted (for example, Move to background followed by a new message).
    // The v7 kill table used PRIMARY KEY(session_id), so B could overwrite or
    // clear A's stop before A observed it. Store independent latches per target;
    // session-scoped rows remain only as the legacy/no-active compatibility
    // shape. The old kill_switch mirror is rebuilt from session rows so a v7
    // targeted latch cannot accidentally become a global stop after migration.
    version: 11,
    sql: '',
    backfill: (db) => {
      const hasTable = (name: string): boolean => Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ).get(name));
      const hasKillTable = hasTable('run_kill_requests');
      if (!hasKillTable) return;
      db.exec(`
        CREATE TABLE IF NOT EXISTS kill_switches (
          session_id   TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          requested_at TEXT NOT NULL,
          reason       TEXT
        );
        ALTER TABLE run_kill_requests RENAME TO run_kill_requests_v7;
        CREATE TABLE run_kill_requests (
          session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          scope_key    TEXT NOT NULL,
          attempt_id   TEXT REFERENCES run_attempts(attempt_id) ON DELETE CASCADE,
          run_id       TEXT,
          requested_at TEXT NOT NULL,
          reason       TEXT,
          PRIMARY KEY (session_id, scope_key)
        );
        CREATE INDEX idx_run_kill_requests_attempt
          ON run_kill_requests(attempt_id) WHERE attempt_id IS NOT NULL;
        CREATE INDEX idx_run_kill_requests_run
          ON run_kill_requests(session_id, run_id) WHERE run_id IS NOT NULL;

        INSERT INTO run_kill_requests
          (session_id, scope_key, attempt_id, run_id, requested_at, reason)
        SELECT session_id,
               CASE
                 WHEN attempt_id IS NOT NULL THEN 'attempt:' || attempt_id
                 WHEN run_id IS NOT NULL THEN 'run:' || run_id
                 ELSE 'session:*'
               END,
               attempt_id, run_id, requested_at, reason
          FROM run_kill_requests_v7;

        INSERT OR IGNORE INTO run_kill_requests
          (session_id, scope_key, attempt_id, run_id, requested_at, reason)
        SELECT legacy.session_id, 'session:*', NULL, NULL,
               legacy.requested_at, legacy.reason
          FROM kill_switches AS legacy
         WHERE NOT EXISTS (
           SELECT 1 FROM run_kill_requests AS scoped
            WHERE scoped.session_id = legacy.session_id
         );

        DROP TABLE run_kill_requests_v7;
        DELETE FROM kill_switches;
        INSERT INTO kill_switches (session_id, requested_at, reason)
        SELECT session_id, requested_at, reason
          FROM run_kill_requests
         WHERE scope_key = 'session:*';
      `);
      // Older builds could delete a session while foreign-key enforcement was
      // disabled, leaving unreachable approval/guardrail rows behind. They are
      // not recoverable execution state (their owning session no longer
      // exists), and they make `foreign_key_check` noisy on otherwise healthy
      // databases. Remove only those proven orphans; valid historical rows are
      // preserved exactly.
      if (hasTable('sessions') && hasTable('tool_guardrail_state')) {
        db.exec(`DELETE FROM tool_guardrail_state
          WHERE NOT EXISTS (
            SELECT 1 FROM sessions WHERE sessions.id = tool_guardrail_state.session_id
          )`);
      }
      if (hasTable('sessions') && hasTable('pending_approvals')) {
        db.exec(`DELETE FROM pending_approvals
          WHERE NOT EXISTS (
            SELECT 1 FROM sessions WHERE sessions.id = pending_approvals.session_id
          )`);
      }
    },
  },
  {
    // Artifact/resource truth and pre-acknowledgement Stop authority must be
    // present before a turn begins. The artifact ledger originally guarded its
    // tables with lazy CREATE statements; keep that repair path, but move the
    // canonical schema into this numbered migration. Chat cancellation rows
    // intentionally have no session FK because Stop can arrive before the
    // server has accepted the request and created/bound its session receipt.
    version: 12,
    sql: `
      CREATE TABLE IF NOT EXISTS run_artifacts (
        id             TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_scope_id   TEXT NOT NULL,
        slot_key       TEXT NOT NULL,
        kind           TEXT NOT NULL,
        provider       TEXT NOT NULL,
        title          TEXT,
        create_shape   TEXT NOT NULL,
        status         TEXT NOT NULL CHECK (status IN ('pending','bound','uncertain')),
        resource_id    TEXT,
        uri            TEXT,
        source_call_id TEXT,
        binding_verified_at TEXT,
        verification_call_id TEXT,
        verification_shape TEXT,
        verification_fingerprint TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        UNIQUE(session_id, run_scope_id, slot_key)
      );
      CREATE INDEX IF NOT EXISTS idx_run_artifacts_session
        ON run_artifacts(session_id, run_scope_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_run_artifacts_resource
        ON run_artifacts(provider, resource_id);

      CREATE TABLE IF NOT EXISTS artifact_run_scopes (
        session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        attempt_scope_id TEXT NOT NULL,
        root_scope_id    TEXT NOT NULL,
        source_user_seq  INTEGER NOT NULL DEFAULT 0,
        reason           TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        PRIMARY KEY(session_id, attempt_scope_id)
      );
      CREATE INDEX IF NOT EXISTS idx_artifact_run_scopes_user
        ON artifact_run_scopes(session_id, source_user_seq DESC, created_at DESC);

      CREATE TABLE IF NOT EXISTS artifact_source_roots (
        session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_user_seq INTEGER NOT NULL,
        root_scope_id   TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        PRIMARY KEY(session_id, source_user_seq)
      );

      CREATE TABLE IF NOT EXISTS harness_chat_request_cancellations (
        request_id   TEXT PRIMARY KEY,
        requested_at TEXT NOT NULL,
        reason       TEXT
      );
    `,
    backfill: (db) => {
      // Some installs already have the original lazy run_artifacts table. Add
      // proof columns in place and preserve every existing resource pointer.
      const columns = new Set(
        (db.prepare('PRAGMA table_info(run_artifacts)').all() as Array<{ name: string }>).map((row) => row.name),
      );
      for (const [name, declaration] of [
        ['binding_verified_at', 'binding_verified_at TEXT'],
        ['verification_call_id', 'verification_call_id TEXT'],
        ['verification_shape', 'verification_shape TEXT'],
        ['verification_fingerprint', 'verification_fingerprint TEXT'],
      ] as const) {
        if (!columns.has(name)) db.exec(`ALTER TABLE run_artifacts ADD COLUMN ${declaration}`);
      }

      // Retain the established root for an old attempt-scoped ledger. The
      // earliest row is authoritative; do not guess a new root during upgrade.
      // Partially recovered legacy fixtures may not have their sessions table;
      // leave their empty child tables repairable instead of invoking the FK.
      const hasSessions = Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`,
      ).get());
      if (!hasSessions) return;
      db.exec(`
        INSERT OR IGNORE INTO artifact_source_roots
          (session_id, source_user_seq, root_scope_id, created_at)
        SELECT s.session_id, s.source_user_seq, s.root_scope_id, s.created_at
          FROM artifact_run_scopes s
         WHERE s.source_user_seq > 0
           AND EXISTS (
             SELECT 1 FROM sessions owner WHERE owner.id = s.session_id
           )
           AND NOT EXISTS (
             SELECT 1
               FROM artifact_run_scopes earlier
              WHERE earlier.session_id = s.session_id
                AND earlier.source_user_seq = s.source_user_seq
                AND (
                  earlier.created_at < s.created_at
                  OR (earlier.created_at = s.created_at AND earlier.rowid < s.rowid)
                )
           );
      `);
    },
  },
];

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const current =
    (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }).v ?? 0;
  const apply = db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)');
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    const tx = db.transaction(() => {
      db.exec(migration.sql);
      migration.backfill?.(db);
      apply.run(migration.version, new Date().toISOString());
    });
    tx();
  }
}

export function openEventLog(): Database.Database {
  if (cached) return cached;
  ensureStateDir();
  const db = new Database(HARNESS_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  runMigrations(db);
  cached = db;
  return db;
}

export function closeEventLog(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}

/** Test-only: drop the DB file so the next open starts fresh. */
export function resetEventLog(): void {
  closeEventLog();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = HARNESS_DB_PATH + suffix;
    if (existsSync(file)) unlinkSync(file);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

interface RawSessionRow {
  id: string;
  kind: SessionKind;
  channel: string | null;
  user_id: string | null;
  created_at: string;
  updated_at: string;
  status: SessionStatus;
  title: string | null;
  objective: string | null;
  token_budget: number | null;
  tokens_used: number;
  current_plan_id: string | null;
  metadata_json: string | null;
}

interface RawEventRow {
  seq: number;
  id: string;
  session_id: string;
  turn: number;
  role: string;
  type: string;
  parent_event_id: string | null;
  data_json: string;
  created_at: string;
}

function rowToSession(row: RawSessionRow): SessionRow {
  return {
    id: row.id,
    kind: row.kind,
    channel: row.channel,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    title: row.title,
    objective: row.objective,
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    currentPlanId: row.current_plan_id,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
  };
}

function rowToEvent(row: RawEventRow): EventRow {
  return {
    seq: row.seq,
    id: row.id,
    sessionId: row.session_id,
    turn: row.turn,
    role: row.role,
    type: row.type as EventType,
    parentEventId: row.parent_event_id,
    data: JSON.parse(row.data_json),
    createdAt: row.created_at,
  };
}

const SESSION_SIGNAL_METADATA_KEYS = [
  'source',
  'channelId',
  'guildId',
  'workflowName',
  'workflowRunId',
  'stepId',
] as const;

export function summarizeSessionForSignal(session: SessionRow): HarnessSessionSignal {
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const key of SESSION_SIGNAL_METADATA_KEYS) {
    const value = session.metadata[key];
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      metadata[key] = value;
    }
  }
  return {
    id: session.id,
    kind: session.kind,
    channel: session.channel,
    userId: session.userId,
    status: session.status,
    title: session.title,
    objective: session.objective,
    updatedAt: session.updatedAt,
    metadata,
  };
}

export function createSession(input: CreateSessionInput): SessionRow {
  const db = openEventLog();
  const id = input.id ?? `sess-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const now = nowIso();
  db.prepare(
    `INSERT INTO sessions
       (id, kind, channel, user_id, created_at, updated_at, status,
        title, objective, token_budget, tokens_used, current_plan_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 0, NULL, ?)`,
  ).run(
    id,
    input.kind,
    input.channel ?? null,
    input.userId ?? null,
    now,
    now,
    input.title ?? null,
    input.objective ?? null,
    input.tokenBudget ?? null,
    JSON.stringify(input.metadata ?? {}),
  );
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as RawSessionRow;
  return rowToSession(row);
}

export function getSession(sessionId: string): SessionRow | null {
  const db = openEventLog();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
    | RawSessionRow
    | undefined;
  return row ? rowToSession(row) : null;
}

function addListFilter(
  clauses: string[],
  params: unknown[],
  column: string,
  value: string | string[] | undefined,
): void {
  if (value === undefined) return;
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) return;
  clauses.push(`${column} IN (${values.map(() => '?').join(',')})`);
  params.push(...values);
}

export function listSessions(options: ListSessionsOptions = {}): SessionRow[] {
  const db = openEventLog();
  const clauses: string[] = [];
  const params: unknown[] = [];
  addListFilter(clauses, params, 'kind', options.kind);
  if (options.status !== undefined && options.status !== 'any') {
    addListFilter(clauses, params, 'status', options.status);
  }
  addListFilter(clauses, params, 'channel', options.channel);
  if (options.updatedAfter !== undefined) {
    clauses.push('updated_at >= ?');
    params.push(options.updatedAfter);
  }
  let sql = 'SELECT * FROM sessions';
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }
  sql += ' ORDER BY updated_at DESC, id DESC';
  const rawLimit = Math.trunc(options.limit ?? 100);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, rawLimit)) : 100;
  const rawOffset = Math.trunc(options.offset ?? 0);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;
  sql += ' LIMIT ? OFFSET ?';
  params.push(limit);
  params.push(offset);
  const rows = db.prepare(sql).all(...params) as RawSessionRow[];
  return rows.map(rowToSession);
}

export type SessionPatch = Partial<
  Pick<
    SessionRow,
    'status' | 'title' | 'objective' | 'tokenBudget' | 'tokensUsed' | 'currentPlanId' | 'metadata'
  >
>;

export function updateSession(sessionId: string, patch: SessionPatch): SessionRow {
  const db = openEventLog();
  const current = getSession(sessionId);
  if (!current) throw new Error(`session not found: ${sessionId}`);
  const next: SessionRow = {
    ...current,
    ...patch,
    metadata: patch.metadata ?? current.metadata,
    updatedAt: nowIso(),
  };
  // Stage 4: tokens_used is a CONCURRENT counter written by
  // accrueSessionTokens on every model completion. A read-modify-write here
  // (status/title patches racing worker increments) would write back a stale
  // snapshot and silently erase spend — so the blanket UPDATE never touches
  // it; only an explicit patch.tokensUsed does.
  const patchesTokensUsed = Object.prototype.hasOwnProperty.call(patch, 'tokensUsed');
  db.prepare(
    `UPDATE sessions SET
       status = ?, title = ?, objective = ?, token_budget = ?,
       tokens_used = CASE WHEN ? THEN ? ELSE tokens_used END,
       current_plan_id = ?, metadata_json = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    next.status,
    next.title,
    next.objective,
    next.tokenBudget,
    patchesTokensUsed ? 1 : 0,
    next.tokensUsed,
    next.currentPlanId,
    JSON.stringify(next.metadata),
    next.updatedAt,
    sessionId,
  );
  return patchesTokensUsed ? next : { ...next, tokensUsed: getSessionTokensUsed(sessionId) };
}

/** Stage 4 (aggregate run budget): atomic, race-safe token accrual — never a
 *  read-modify-write. Missing session ⇒ silent no-op (warmup/'unknown' sources
 *  have no row and must not create one). Returns whether a row was updated. */
export function accrueSessionTokens(sessionId: string, tokens: number): boolean {
  if (!sessionId || !Number.isFinite(tokens) || tokens <= 0) return false;
  try {
    const db = openEventLog();
    const res = db.prepare(
      'UPDATE sessions SET tokens_used = tokens_used + ? WHERE id = ?',
    ).run(Math.trunc(tokens), sessionId);
    return res.changes > 0;
  } catch {
    return false; // the meter must never break a model-call path
  }
}

/** Stage 4 (workflow lane): run-level spend = the SUM over the run's per-step
 *  sessions (workflow:<runId>:%). Cheap indexed prefix scan; used only at
 *  between-batch boundaries. */
export function sumSessionTokensUsedByPrefix(prefix: string): number {
  if (!prefix) return 0;
  try {
    const row = openEventLog().prepare(
      "SELECT COALESCE(SUM(tokens_used), 0) AS total FROM sessions WHERE id LIKE ? ESCAPE '\\'",
    ).get(`${prefix.replace(/[%_\\]/g, (c) => `\\${c}`)}%`) as { total: number } | undefined;
    return typeof row?.total === 'number' ? row.total : 0;
  } catch {
    return 0;
  }
}

/** Cheap point read of the lifetime token counter (0 when the row is absent). */
export function getSessionTokensUsed(sessionId: string): number {
  try {
    const row = openEventLog().prepare(
      'SELECT tokens_used FROM sessions WHERE id = ?',
    ).get(sessionId) as { tokens_used: number } | undefined;
    return typeof row?.tokens_used === 'number' ? row.tokens_used : 0;
  } catch {
    return 0;
  }
}

function publishPersistedEvent(event: EventRow): EventRow {
  const session = getSession(event.sessionId);
  // Fan out for live SSE subscribers. Best-effort — emit errors are
  // swallowed inside actionBus so a flaky listener can never block
  // an event write.
  actionBus.emit({
    kind: 'harness.event',
    sessionId: event.sessionId,
    event,
    session: session ? summarizeSessionForSignal(session) : undefined,
  });
  // Mirror whitelisted events into the operational-telemetry store so the
  // dashboard / Slack / Discord see run lifecycle, swarms, verdicts and
  // fallovers without touching the hot files. Fail-open — never throws.
  mirrorEventToOperational(event, session);
  return event;
}

export function appendEvent(input: AppendEventInput): EventRow {
  if (!EVENT_TYPE_SET.has(input.type)) {
    throw new Error(`unknown event type: ${input.type}`);
  }
  const db = openEventLog();
  const id = randomUUID();
  const now = nowIso();
  const tx = db.transaction(() => {
    let eventData = input.data ?? {};
    if (input.type === 'conversation_completed') {
      type TerminalOwner = {
        attempt_id: string;
        run_id: string | null;
        source_user_seq: number | null;
      };
      const explicit = eventData as Record<string, unknown>;
      const explicitAttemptId = typeof explicit.attemptId === 'string'
        ? explicit.attemptId.trim()
        : '';
      const explicitRunId = typeof explicit.runId === 'string'
        ? explicit.runId.trim()
        : '';
      const explicitSourceUserSeq = Number.isSafeInteger(explicit.sourceUserSeq)
        && Number(explicit.sourceUserSeq) > 0
        ? Number(explicit.sourceUserSeq)
        : null;
      // Prefer the identity already carried by the physical turn. Falling
      // straight back to the DB-active attempt can misattribute a late A
      // completion to newer turn B on the same reusable chat session.
      const owner = explicitAttemptId
        ? db.prepare(
          `SELECT attempt_id, run_id, source_user_seq
             FROM run_attempts
            WHERE session_id = ? AND attempt_id = ?
            LIMIT 1`,
        ).get(input.sessionId, explicitAttemptId) as TerminalOwner | undefined
        : explicitRunId
          ? db.prepare(
            `SELECT attempt_id, run_id, source_user_seq
               FROM run_attempts
              WHERE session_id = ? AND run_id = ?
              ORDER BY (finished_at IS NULL) DESC, started_at DESC, rowid DESC
              LIMIT 1`,
          ).get(input.sessionId, explicitRunId) as TerminalOwner | undefined
          : explicitSourceUserSeq !== null
            ? db.prepare(
              `SELECT attempt_id, run_id, source_user_seq
                 FROM run_attempts
                WHERE session_id = ? AND source_user_seq = ?
                ORDER BY started_at DESC, rowid DESC
                LIMIT 1`,
            ).get(input.sessionId, explicitSourceUserSeq) as TerminalOwner | undefined
            : db.prepare(
              `SELECT attempt_id, run_id, source_user_seq
                 FROM run_attempts
                WHERE session_id = ? AND finished_at IS NULL
                ORDER BY started_at DESC, rowid DESC
                LIMIT 1`,
            ).get(input.sessionId) as TerminalOwner | undefined;
      if (owner) {
        // Terminal ownership is written in the SAME transaction as the event.
        // Recovery can therefore distinguish this request's terminal from a
        // late completion belonging to another turn without timestamp guesses.
        eventData = {
          ...eventData,
          ...(!Object.prototype.hasOwnProperty.call(eventData, 'attemptId')
            ? { attemptId: owner.attempt_id }
            : {}),
          ...(owner.run_id && !Object.prototype.hasOwnProperty.call(eventData, 'runId')
            ? { runId: owner.run_id }
            : {}),
          ...(owner.source_user_seq !== null && !Object.prototype.hasOwnProperty.call(eventData, 'sourceUserSeq')
            ? { sourceUserSeq: owner.source_user_seq }
            : {}),
        };
      }
    }
    const data = JSON.stringify(eventData);
    db.prepare(
      `INSERT INTO events
         (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.sessionId,
      input.turn,
      input.role,
      input.type,
      input.parentEventId ?? null,
      data,
      now,
    );
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, input.sessionId);
  });
  tx();
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as RawEventRow;
  const event = rowToEvent(row);
  return publishPersistedEvent(event);
}

/**
 * Atomically insert-or-reuse a user input and bind it to one run attempt.
 *
 * This is the write-side counterpart to `source_user_seq`: agentic execution
 * must never begin in the crash window between a durable chat row and its run
 * binding. When `existingEventSeq` is supplied (for a desktop acceptance row),
 * the same transaction validates and binds it. When the attempt is already
 * bound, that exact source wins even if the runtime prompt was transformed.
 */
export function recordRunAttemptUserInput(
  attempt: Pick<RunAttemptRef, 'sessionId' | 'attemptId'>,
  input: Omit<AppendEventInput, 'sessionId' | 'type'>,
  options: { existingEventSeq?: number } = {},
): EventRow {
  const db = openEventLog();
  const id = randomUUID();
  const now = nowIso();
  const data = JSON.stringify(input.data ?? {});
  const tx = db.transaction((): { event: EventRow; inserted: boolean } => {
    const attemptRow = db.prepare(
      'SELECT session_id, source_user_seq FROM run_attempts WHERE attempt_id = ?',
    ).get(attempt.attemptId) as { session_id: string; source_user_seq: number | null } | undefined;
    if (!attemptRow) throw new Error(`run attempt not found: ${attempt.attemptId}`);
    if (attemptRow.session_id !== attempt.sessionId) {
      throw new Error(`run attempt ${attempt.attemptId} belongs to another session`);
    }

    const selectedSeq = attemptRow.source_user_seq ?? options.existingEventSeq ?? null;
    if (selectedSeq !== null) {
      const existing = db.prepare('SELECT * FROM events WHERE seq = ?').get(selectedSeq) as RawEventRow | undefined;
      if (!existing || existing.session_id !== attempt.sessionId || existing.type !== 'user_input_received') {
        throw new Error(`event ${selectedSeq} is not a user input for attempt session ${attempt.sessionId}`);
      }
      db.prepare(
        `UPDATE run_attempts
            SET source_user_seq = COALESCE(source_user_seq, ?)
          WHERE attempt_id = ? AND session_id = ?`,
      ).run(selectedSeq, attempt.attemptId, attempt.sessionId);
      return { event: rowToEvent(existing), inserted: false };
    }

    db.prepare(
      `INSERT INTO events
         (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
       VALUES (?, ?, ?, ?, 'user_input_received', ?, ?, ?)`,
    ).run(
      id,
      attempt.sessionId,
      input.turn,
      input.role,
      input.parentEventId ?? null,
      data,
      now,
    );
    const inserted = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as RawEventRow;
    db.prepare(
      'UPDATE run_attempts SET source_user_seq = ? WHERE attempt_id = ? AND session_id = ?',
    ).run(inserted.seq, attempt.attemptId, attempt.sessionId);
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, attempt.sessionId);
    return { event: rowToEvent(inserted), inserted: true };
  });
  const result = tx();
  return result.inserted ? publishPersistedEvent(result.event) : result.event;
}

/**
 * Append one terminal completion for a concrete run attempt. The v7 partial
 * unique index makes the check atomic across concurrent callers/processes; the
 * loser receives the already-durable event and, critically, does not fan out a
 * second completion on actionBus.
 */
export function appendTerminalEventOnce(
  input: Omit<AppendEventInput, 'type'> & { type?: 'conversation_completed' },
  terminalKey: string,
): { event: EventRow; inserted: boolean } {
  const key = terminalKey.trim();
  if (!key) throw new Error('terminalKey is required');
  try {
    const event = appendEvent({
      ...input,
      type: 'conversation_completed',
      data: { ...(input.data ?? {}), terminalKey: key },
    });
    return { event, inserted: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/unique constraint failed/i.test(message)) throw err;
    const row = openEventLog().prepare(
      `SELECT * FROM events
        WHERE session_id = ?
          AND type = 'conversation_completed'
          AND json_extract(data_json, '$.terminalKey') = ?
        LIMIT 1`,
    ).get(input.sessionId, key) as RawEventRow | undefined;
    if (!row) throw err;
    return { event: rowToEvent(row), inserted: false };
  }
}

/**
 * Newest event timestamp across every session whose id starts with `prefix`
 * (e.g. 'workflow:<runId>:' spans all of a run's step sessions). Used by the
 * workflow watchdog's silent-running detection — a 'running' run whose step
 * sessions have emitted nothing for many minutes is wedged, not working.
 * Returns null when no events match.
 */
export function latestEventAtForSessionPrefix(prefix: string): string | null {
  if (!prefix) return null;
  const db = openEventLog();
  const row = db
    .prepare("SELECT MAX(created_at) AS at FROM events WHERE session_id LIKE ? ESCAPE '\\'")
    .get(`${prefix.replace(/[%_\\]/g, (m) => `\\${m}`)}%`) as { at: string | null };
  return row?.at ?? null;
}

export function listEvents(sessionId: string, options: ListEventsOptions = {}): EventRow[] {
  const db = openEventLog();
  const clauses: string[] = ['session_id = ?'];
  const params: unknown[] = [sessionId];
  if (options.sinceSeq !== undefined) {
    clauses.push('seq > ?');
    params.push(options.sinceSeq);
  }
  if (options.sinceAt !== undefined) {
    clauses.push('created_at >= ?');
    params.push(options.sinceAt);
  }
  if (options.types && options.types.length > 0) {
    const placeholders = options.types.map(() => '?').join(',');
    clauses.push(`type IN (${placeholders})`);
    params.push(...options.types);
  }
  const order = options.desc ? 'DESC' : 'ASC';
  let sql = `SELECT * FROM events WHERE ${clauses.join(' AND ')} ORDER BY seq ${order}`;
  if (options.limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(options.limit);
  }
  const rows = db.prepare(sql).all(...params) as RawEventRow[];
  const mapped = rows.map(rowToEvent);
  // For desc + limit: the caller usually wants chronological order
  // back, so reverse the result. The caller can post-reverse if they
  // truly want newest-first.
  return options.desc ? mapped.reverse() : mapped;
}

/** Return the newest logical provider-level tool call without relying on a
 * bounded raw-event tail. A single native MCP call can emit a later transport
 * mirror, and a busy turn can emit hundreds of those audit rows after the call
 * whose arguments recovery needs. Keep the raw rows; exclude only mirrors at
 * the indexed query boundary. */
export function getLatestCanonicalTopLevelToolEvent(sessionId: string): EventRow | undefined {
  const row = openEventLog().prepare(
    `SELECT * FROM events
      WHERE session_id = ?
        AND type = 'tool_called'
        AND COALESCE(json_extract(data_json, '$.accounting'), '') <> 'transport_mirror'
      ORDER BY seq DESC
      LIMIT 1`,
  ).get(sessionId) as RawEventRow | undefined;
  return row ? rowToEvent(row) : undefined;
}

/** Count the exact event scope represented by listEvents without loading its
 * data_json payloads. This keeps UI aggregates truthful even when the rendered
 * event window is intentionally bounded. */
export function countMatchingEvents(
  sessionId: string,
  options: Pick<ListEventsOptions, 'sinceSeq' | 'sinceAt' | 'types'> = {},
): number {
  const db = openEventLog();
  const clauses: string[] = ['session_id = ?'];
  const params: unknown[] = [sessionId];
  if (options.sinceSeq !== undefined) {
    clauses.push('seq > ?');
    params.push(options.sinceSeq);
  }
  if (options.sinceAt !== undefined) {
    clauses.push('created_at >= ?');
    params.push(options.sinceAt);
  }
  if (options.types && options.types.length > 0) {
    clauses.push(`type IN (${options.types.map(() => '?').join(',')})`);
    params.push(...options.types);
  }
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM events WHERE ${clauses.join(' AND ')}`,
  ).get(...params) as { n: number } | undefined;
  return Number.isFinite(row?.n) ? row!.n : 0;
}

/** Count events of a given type for a session — an authoritative tally (e.g.
 *  live `tool_called` count for a background run) without materializing rows.
 *  Zero on any error, so a caller can use it inline for a best-effort stat. */
export function countEvents(sessionId: string, type: EventType): number {
  try {
    const db = openEventLog();
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = ?')
      .get(sessionId, type) as { n: number } | undefined;
    return Number.isFinite(row?.n) ? row!.n : 0;
  } catch {
    return 0;
  }
}

export function getLatestEventSeq(sessionId: string): number {
  const db = openEventLog();
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?')
    .get(sessionId) as { seq: number } | undefined;
  return Number.isFinite(row?.seq) ? row!.seq : 0;
}

export function getEvent(eventId: string): EventRow | null {
  const db = openEventLog();
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as
    | RawEventRow
    | undefined;
  return row ? rowToEvent(row) : null;
}

/**
 * Find an unsettled user-input event already recorded for a durable run.
 *
 * The desktop owns a request receipt before dispatch and may append the input
 * before the selected brain starts. Reusing that row prevents a duplicate chat
 * turn. Both run ids and client request ids are accepted because the receipt is
 * the durable bridge between those two identities.
 */
export function findUserInputEventForRun(
  sessionId: string,
  runId: string,
  expectedText: string,
): EventRow | null {
  const sid = sessionId.trim();
  const rid = runId.trim();
  if (!sid || !rid || !expectedText) return null;
  const db = openEventLog();
  const identities = new Set<string>([rid]);
  try {
    const receipt = db.prepare(
      'SELECT request_id FROM harness_chat_requests WHERE session_id = ? AND run_id = ?',
    ).get(sid, rid) as { request_id: string } | undefined;
    if (receipt?.request_id) identities.add(receipt.request_id);
  } catch { /* old/partial fixtures may not have the receipt table */ }
  const values = [...identities];
  const placeholders = values.map(() => '?').join(',');
  const params = [
    sid,
    expectedText,
    ...values,
    ...values,
    ...values,
    ...values,
  ];
  const row = db.prepare(
    `SELECT input.*
       FROM events AS input
      WHERE input.session_id = ?
        AND input.type = 'user_input_received'
        AND json_extract(input.data_json, '$.text') = ?
        AND (
          json_extract(input.data_json, '$.runId') IN (${placeholders})
          OR json_extract(input.data_json, '$.requestRunId') IN (${placeholders})
          OR json_extract(input.data_json, '$.requestId') IN (${placeholders})
          OR json_extract(input.data_json, '$.clientRequestId') IN (${placeholders})
        )
        AND NOT EXISTS (
          SELECT 1 FROM events AS terminal
           WHERE terminal.session_id = input.session_id
             AND terminal.type = 'conversation_completed'
             AND terminal.seq > input.seq
        )
      ORDER BY input.seq DESC
      LIMIT 1`,
  ).get(...params) as RawEventRow | undefined;
  return row ? rowToEvent(row) : null;
}

/** Bind one attempt to its exact, same-session user-input event. Idempotent for
 * the same sequence and deliberately refuses an identity-changing rebind. */
export function bindRunAttemptSourceUserEvent(
  attempt: Pick<RunAttemptRef, 'sessionId' | 'attemptId'>,
  sourceUserSeq: number,
): void {
  if (!Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) {
    throw new Error('sourceUserSeq must be a positive event sequence');
  }
  const db = openEventLog();
  const tx = db.transaction(() => {
    const attemptRow = db.prepare(
      'SELECT session_id, source_user_seq FROM run_attempts WHERE attempt_id = ?',
    ).get(attempt.attemptId) as { session_id: string; source_user_seq: number | null } | undefined;
    if (!attemptRow) throw new Error(`run attempt not found: ${attempt.attemptId}`);
    if (attemptRow.session_id !== attempt.sessionId) {
      throw new Error(`run attempt ${attempt.attemptId} belongs to another session`);
    }
    const source = db.prepare(
      'SELECT session_id, type FROM events WHERE seq = ?',
    ).get(sourceUserSeq) as { session_id: string; type: string } | undefined;
    if (!source) throw new Error(`source user event not found: ${sourceUserSeq}`);
    if (source.session_id !== attempt.sessionId || source.type !== 'user_input_received') {
      throw new Error(`event ${sourceUserSeq} is not a user input for attempt session ${attempt.sessionId}`);
    }
    if (attemptRow.source_user_seq !== null && attemptRow.source_user_seq !== sourceUserSeq) {
      throw new Error(
        `run attempt ${attempt.attemptId} is already bound to user event ${attemptRow.source_user_seq}`,
      );
    }
    db.prepare(
      `UPDATE run_attempts
          SET source_user_seq = COALESCE(source_user_seq, ?)
        WHERE attempt_id = ? AND session_id = ?`,
    ).run(sourceUserSeq, attempt.attemptId, attempt.sessionId);
  });
  tx();
}

/** Read the exact durable user input already bound to an attempt. */
export function getRunAttemptSourceUserEvent(
  attempt: Pick<RunAttemptRef, 'sessionId' | 'attemptId'>,
): EventRow | null {
  const row = openEventLog().prepare(
    `SELECT event.*
       FROM run_attempts AS attempt
       JOIN events AS event ON event.seq = attempt.source_user_seq
      WHERE attempt.attempt_id = ?
        AND attempt.session_id = ?
        AND event.session_id = attempt.session_id
        AND event.type = 'user_input_received'`,
  ).get(attempt.attemptId, attempt.sessionId) as RawEventRow | undefined;
  return row ? rowToEvent(row) : null;
}

/** Register the one live attempt that a reusable session is currently serving. */
export function beginRunAttempt(
  sessionId: string,
  input: { runId?: string | null; attemptId?: string } = {},
): RunAttemptRef {
  const db = openEventLog();
  const runId = input.runId?.trim() || null;
  // A lease recovery may have minted a suffixed attempt identity under the
  // same durable run id. Downstream wrappers (for example the SDK brain) only
  // know that run id, so reuse its active attempt instead of deriving the base
  // id again and accidentally superseding the lease holder.
  const activeForRun = !input.attemptId && runId
    ? db.prepare(
      `SELECT attempt_id FROM run_attempts
        WHERE session_id = ? AND run_id = ? AND finished_at IS NULL
        ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    ).get(sessionId, runId) as { attempt_id: string } | undefined
    : undefined;
  let attemptId = input.attemptId?.trim()
    || activeForRun?.attempt_id
    || (runId
      ? (/^attempt(?::|-)/.test(runId) ? runId : `attempt:${runId}`)
      : `attempt-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`);
  let existing = db.prepare(
    'SELECT session_id, run_id, started_at, finished_at FROM run_attempts WHERE attempt_id = ?',
  ).get(attemptId) as {
    session_id: string;
    run_id: string | null;
    started_at: string;
    finished_at: string | null;
  } | undefined;
  if (existing && existing.session_id !== sessionId) {
    throw new Error(`run attempt ${attemptId} belongs to another session`);
  }
  // A repeated external run id after its prior attempt settled is a retry, not
  // permission to reopen/rewrite the historical attempt. Keep the run id for
  // correlation but mint a fresh terminal identity.
  if (existing?.finished_at) {
    attemptId = `${attemptId}:${randomUUID().slice(0, 8)}`;
    existing = undefined;
  }
  const startedAt = existing?.started_at ?? nowIso();
  const tx = db.transaction(() => {
    // A single chat session is serialized. If a caller starts a new attempt
    // after a process-level error left the previous row active, retire the old
    // marker so a stale stop can never target the fresh work.
    db.prepare(
      `UPDATE run_attempts
          SET finished_at = COALESCE(finished_at, ?), status = 'superseded'
        WHERE session_id = ? AND finished_at IS NULL AND attempt_id != ?`,
    ).run(startedAt, sessionId, attemptId);
    db.prepare(
      `INSERT INTO run_attempts
         (attempt_id, session_id, run_id, started_at, finished_at, status)
       VALUES (?, ?, ?, ?, NULL, 'active')
       ON CONFLICT(attempt_id) DO UPDATE SET
         run_id = COALESCE(excluded.run_id, run_attempts.run_id),
         status = 'active'`,
    ).run(attemptId, sessionId, runId, startedAt);
    db.prepare("UPDATE sessions SET status = 'active', updated_at = ? WHERE id = ?")
      .run(startedAt, sessionId);
  });
  tx();
  return { sessionId, attemptId, runId: runId ?? existing?.run_id ?? null, startedAt };
}

export function finishRunAttempt(
  attempt: Pick<RunAttemptRef, 'sessionId' | 'attemptId'>,
  status: 'completed' | 'cancelled' | 'failed' | 'superseded' | 'interrupted' = 'completed',
): void {
  const db = openEventLog();
  const tx = db.transaction(() => {
    const row = db.prepare(
      'SELECT run_id FROM run_attempts WHERE attempt_id = ? AND session_id = ?',
    ).get(attempt.attemptId, attempt.sessionId) as { run_id: string | null } | undefined;
    db.prepare(
      `UPDATE run_attempts
          SET finished_at = ?, status = ?, lease_expires_at = NULL
        WHERE attempt_id = ? AND session_id = ? AND finished_at IS NULL`,
    ).run(nowIso(), status, attempt.attemptId, attempt.sessionId);
    // The physical owner is settling now. This remains necessary when a newer
    // attempt already marked the row superseded: its exact stop latch still had
    // to survive until this old process reached its terminal finally.
    db.prepare(
      'DELETE FROM run_kill_requests WHERE session_id = ? AND scope_key = ?',
    ).run(attempt.sessionId, `attempt:${attempt.attemptId}`);
    if (row?.run_id) {
      const otherLive = db.prepare(
        `SELECT 1 FROM run_attempts
          WHERE session_id = ? AND run_id = ? AND attempt_id != ? AND finished_at IS NULL
          LIMIT 1`,
      ).get(attempt.sessionId, row.run_id, attempt.attemptId);
      if (!otherLive) {
        db.prepare(
          'DELETE FROM run_kill_requests WHERE session_id = ? AND scope_key = ?',
        ).run(attempt.sessionId, `run:${row.run_id}`);
      }
    }
  });
  tx();
}

export function getActiveRunAttempt(sessionId: string): RunAttemptRef | null {
  const row = openEventLog().prepare(
    `SELECT attempt_id, run_id, started_at
       FROM run_attempts
      WHERE session_id = ? AND finished_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1`,
  ).get(sessionId) as { attempt_id: string; run_id: string | null; started_at: string } | undefined;
  return row
    ? { sessionId, attemptId: row.attempt_id, runId: row.run_id, startedAt: row.started_at }
    : null;
}

/** Latest durable attempt for a reusable session, terminal or active. */
export function getLatestRunAttempt(sessionId: string): RunAttemptRecord | null {
  const row = openEventLog().prepare(
    `SELECT attempt_id, run_id, started_at, finished_at, status,
            lease_owner, lease_expires_at, source_user_seq
       FROM run_attempts
      WHERE session_id = ?
      ORDER BY started_at DESC, rowid DESC
      LIMIT 1`,
  ).get(sessionId) as {
    attempt_id: string;
    run_id: string | null;
    started_at: string;
    finished_at: string | null;
    status: RunAttemptRecord['status'];
    lease_owner: string | null;
    lease_expires_at: string | null;
    source_user_seq: number | null;
  } | undefined;
  return row ? {
    sessionId,
    attemptId: row.attempt_id,
    runId: row.run_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    sourceUserSeq: row.source_user_seq,
  } : null;
}

/** Batch projection for polling surfaces. Avoid one SQLite prepare/query per
 * session while preserving getLatestRunAttempt's exact ordering semantics. */
export function listLatestRunAttemptsForSessions(
  sessionIds: readonly string[],
): Map<string, RunAttemptRecord> {
  const ids = [...new Set(sessionIds.map((id) => id.trim()).filter(Boolean))];
  const out = new Map<string, RunAttemptRecord>();
  const db = openEventLog();
  for (let offset = 0; offset < ids.length; offset += 400) {
    const chunk = ids.slice(offset, offset + 400);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT session_id, attempt_id, run_id, started_at, finished_at, status,
              lease_owner, lease_expires_at, source_user_seq
         FROM (
           SELECT session_id, attempt_id, run_id, started_at, finished_at, status,
                  lease_owner, lease_expires_at, source_user_seq,
                  ROW_NUMBER() OVER (
                    PARTITION BY session_id
                    ORDER BY started_at DESC, rowid DESC
                  ) AS latest_rank
             FROM run_attempts
            WHERE session_id IN (${placeholders})
         )
        WHERE latest_rank = 1`,
    ).all(...chunk) as Array<{
      session_id: string;
      attempt_id: string;
      run_id: string | null;
      started_at: string;
      finished_at: string | null;
      status: RunAttemptRecord['status'];
      lease_owner: string | null;
      lease_expires_at: string | null;
      source_user_seq: number | null;
    }>;
    for (const row of rows) {
      out.set(row.session_id, {
        sessionId: row.session_id,
        attemptId: row.attempt_id,
        runId: row.run_id,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        status: row.status,
        leaseOwner: row.lease_owner,
        leaseExpiresAt: row.lease_expires_at,
        sourceUserSeq: row.source_user_seq,
      });
    }
  }
  return out;
}

export function getLatestRunAttemptByRunId(sessionId: string, runId: string): RunAttemptRecord | null {
  const row = openEventLog().prepare(
    `SELECT attempt_id, run_id, started_at, finished_at, status,
            lease_owner, lease_expires_at, source_user_seq
       FROM run_attempts
      WHERE session_id = ? AND run_id = ?
      ORDER BY started_at DESC, rowid DESC
      LIMIT 1`,
  ).get(sessionId, runId) as {
    attempt_id: string;
    run_id: string | null;
    started_at: string;
    finished_at: string | null;
    status: RunAttemptRecord['status'];
    lease_owner: string | null;
    lease_expires_at: string | null;
    source_user_seq: number | null;
  } | undefined;
  return row ? {
    sessionId,
    attemptId: row.attempt_id,
    runId: row.run_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    sourceUserSeq: row.source_user_seq,
  } : null;
}

/**
 * Atomically acquire bounded ownership of one durable run identity.
 *
 * A live, unexpired lease is never stolen. An unfinished attempt whose lease
 * expired is first closed as `interrupted`, then a fresh attempt identity is
 * created under the same run id so terminal history remains immutable. A
 * completed/cancelled/failed run is terminal and is only replayed, never run a
 * second time.
 */
export function claimRunAttemptLease(input: {
  sessionId: string;
  runId: string;
  ownerId: string;
  leaseMs: number;
  nowMs?: number;
}): RunAttemptLeaseClaim {
  const sessionId = input.sessionId.trim();
  const runId = input.runId.trim();
  const ownerId = input.ownerId.trim();
  if (!sessionId || !runId || !ownerId) throw new Error('sessionId, runId, and ownerId are required');
  if (!Number.isFinite(input.leaseMs) || input.leaseMs < 1_000) throw new Error('leaseMs must be at least 1000');

  const db = openEventLog();
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const leaseExpiresAt = new Date(nowMs + input.leaseMs).toISOString();
  const tx = db.transaction((): RunAttemptLeaseClaim => {
    const latest = db.prepare(
      `SELECT attempt_id, run_id, started_at, finished_at, status,
              lease_owner, lease_expires_at, source_user_seq
         FROM run_attempts
        WHERE session_id = ? AND run_id = ?
        ORDER BY started_at DESC, rowid DESC
        LIMIT 1`,
    ).get(sessionId, runId) as {
      attempt_id: string;
      run_id: string | null;
      started_at: string;
      finished_at: string | null;
      status: RunAttemptRecord['status'];
      lease_owner: string | null;
      lease_expires_at: string | null;
      source_user_seq: number | null;
    } | undefined;

    if (latest?.finished_at && latest.status !== 'interrupted') {
      return {
        attempt: { sessionId, attemptId: latest.attempt_id, runId: latest.run_id, startedAt: latest.started_at },
        claimed: false,
        reason: 'terminal',
        interruptedAttemptId: null,
      };
    }

    // A process can crash after the user-visible terminal event commits but
    // before its finally block settles run_attempts. The terminal is the
    // authoritative no-replay boundary: reconcile the stale active lease
    // instead of reclaiming it and executing the accepted request again.
    if (latest && !latest.finished_at) {
      const terminal = db.prepare(
        `SELECT terminal.created_at
           FROM events AS terminal
          WHERE terminal.session_id = ?
            AND terminal.type = 'conversation_completed'
            AND (
              json_extract(terminal.data_json, '$.terminalKey') = ?
              OR json_extract(terminal.data_json, '$.attemptId') = ?
              OR json_extract(terminal.data_json, '$.runId') = ?
              OR (? IS NOT NULL AND json_extract(terminal.data_json, '$.sourceUserSeq') = ?)
            )
          ORDER BY terminal.seq ASC
          LIMIT 1`,
      ).get(
        sessionId,
        `brain:${latest.attempt_id}`,
        latest.attempt_id,
        latest.run_id,
        latest.source_user_seq,
        latest.source_user_seq,
      ) as { created_at: string } | undefined;
      if (terminal) {
        db.prepare(
          `UPDATE run_attempts
              SET finished_at = ?, status = 'completed', lease_expires_at = NULL
            WHERE attempt_id = ? AND session_id = ? AND finished_at IS NULL`,
        ).run(terminal.created_at, latest.attempt_id, sessionId);
        return {
          attempt: {
            sessionId,
            attemptId: latest.attempt_id,
            runId: latest.run_id,
            startedAt: latest.started_at,
          },
          claimed: false,
          reason: 'terminal',
          interruptedAttemptId: null,
        };
      }
    }

    let interruptedAttemptId: string | null = null;
    if (latest && !latest.finished_at) {
      const leaseExpiry = latest.lease_expires_at ? Date.parse(latest.lease_expires_at) : Number.NaN;
      if (latest.lease_owner && Number.isFinite(leaseExpiry) && leaseExpiry > nowMs) {
        return {
          attempt: { sessionId, attemptId: latest.attempt_id, runId: latest.run_id, startedAt: latest.started_at },
          claimed: false,
          reason: 'active',
          interruptedAttemptId: null,
        };
      }
      db.prepare(
        `UPDATE run_attempts
            SET finished_at = ?, status = 'interrupted', lease_expires_at = NULL
          WHERE attempt_id = ? AND session_id = ? AND finished_at IS NULL`,
      ).run(now, latest.attempt_id, sessionId);
      interruptedAttemptId = latest.attempt_id;
    }

    const baseAttemptId = /^attempt(?::|-)/.test(runId) ? runId : `attempt:${runId}`;
    const baseExists = Boolean(db.prepare('SELECT 1 FROM run_attempts WHERE attempt_id = ?').get(baseAttemptId));
    const attemptId = baseExists ? `${baseAttemptId}:${randomUUID().slice(0, 8)}` : baseAttemptId;

    // Keep the session serialization contract from beginRunAttempt: a newer
    // request retires any unrelated unfinished marker before it becomes live.
    db.prepare(
      `UPDATE run_attempts
          SET finished_at = COALESCE(finished_at, ?), status = 'superseded', lease_expires_at = NULL
        WHERE session_id = ? AND finished_at IS NULL`,
    ).run(now, sessionId);
    db.prepare(
      `INSERT INTO run_attempts
         (attempt_id, session_id, run_id, started_at, finished_at, status,
          lease_owner, lease_expires_at, source_user_seq)
       VALUES (?, ?, ?, ?, NULL, 'active', ?, ?, ?)`,
    ).run(attemptId, sessionId, runId, now, ownerId, leaseExpiresAt, latest?.source_user_seq ?? null);
    db.prepare("UPDATE sessions SET status = 'active', updated_at = ? WHERE id = ?").run(now, sessionId);

    return {
      attempt: { sessionId, attemptId, runId, startedAt: now },
      claimed: true,
      reason: 'claimed',
      interruptedAttemptId,
    };
  });
  return tx();
}

/** Extend a lease only when the same process still owns the active attempt. */
export function renewRunAttemptLease(
  attempt: Pick<RunAttemptRef, 'sessionId' | 'attemptId'>,
  ownerId: string,
  leaseMs: number,
  nowMs = Date.now(),
): boolean {
  if (!ownerId.trim() || !Number.isFinite(leaseMs) || leaseMs < 1_000) return false;
  const expiresAt = new Date(nowMs + leaseMs).toISOString();
  const result = openEventLog().prepare(
    `UPDATE run_attempts
        SET lease_expires_at = ?
      WHERE attempt_id = ? AND session_id = ?
        AND finished_at IS NULL AND status = 'active' AND lease_owner = ?`,
  ).run(expiresAt, attempt.attemptId, attempt.sessionId, ownerId);
  return result.changes === 1;
}

/**
 * Startup recovery for process-owned attempts. A lease belonging to another
 * process (or a pre-lease row) cannot still have a live executor in this
 * daemon, so close it immediately rather than waiting for its wall-clock TTL.
 */
export function interruptForeignRunAttemptLeases(
  ownerId: string,
  options: { runIdPrefix?: string; nowMs?: number } = {},
): number {
  const owner = ownerId.trim();
  if (!owner) throw new Error('ownerId is required');
  const now = new Date(options.nowMs ?? Date.now()).toISOString();
  const prefix = options.runIdPrefix ?? '';
  // NULL-run_id rows (Discord/webhook attempts carry no external run id) can
  // never match `run_id LIKE ?` — with no prefix requested they must still be
  // sweepable, or a crashed lane leaks permanently-active attempts (fold,
  // review wf_30a7ce7e-e9c #7).
  const result = openEventLog().prepare(
    `UPDATE run_attempts
        SET finished_at = ?, status = 'interrupted', lease_expires_at = NULL
      WHERE finished_at IS NULL
        AND status = 'active'
        AND (run_id LIKE ? OR (? = '' AND run_id IS NULL))
        AND (lease_owner IS NULL OR lease_owner != ?)`,
  ).run(now, `${prefix}%`, prefix, owner);
  return result.changes;
}

/** DAEMON-BOOT recovery (fold, review wf_30a7ce7e-e9c #7): at daemon startup
 * every still-'active' attempt necessarily belonged to the dead process —
 * Discord/webhook attempts carry no run id and no lease, so the desktop-only
 * foreign-lease sweep never reached them and they showed as phantom running
 * sessions forever. Call ONLY from daemon startup (a CLI process opening the
 * same DB must never sweep the live daemon's rows). */
export function interruptOrphanedRunAttemptsAtBoot(nowMs: number = Date.now()): number {
  const now = new Date(nowMs).toISOString();
  return openEventLog().prepare(
    `UPDATE run_attempts
        SET finished_at = ?, status = 'interrupted', lease_expires_at = NULL
      WHERE finished_at IS NULL
        AND status = 'active'`,
  ).run(now).changes;
}

function rowToHarnessChatRequestReceipt(row: {
  request_id: string;
  session_id: string;
  run_id: string;
  input_hash: string;
  since_seq: number;
  created_at: string;
}): HarnessChatRequestReceipt {
  return {
    requestId: row.request_id,
    sessionId: row.session_id,
    runId: row.run_id,
    inputHash: row.input_hash,
    sinceSeq: row.since_seq,
    createdAt: row.created_at,
  };
}

export function getHarnessChatRequestReceipt(requestId: string): HarnessChatRequestReceipt | null {
  const row = openEventLog().prepare(
    `SELECT request_id, session_id, run_id, input_hash, since_seq, created_at
       FROM harness_chat_requests WHERE request_id = ?`,
  ).get(requestId) as {
    request_id: string;
    session_id: string;
    run_id: string;
    input_hash: string;
    since_seq: number;
    created_at: string;
  } | undefined;
  return row ? rowToHarnessChatRequestReceipt(row) : null;
}

function rowToHarnessChatRequestCancellation(row: {
  request_id: string;
  requested_at: string;
  reason: string | null;
}): HarnessChatRequestCancellation {
  return {
    requestId: row.request_id,
    requestedAt: row.requested_at,
    reason: row.reason,
  };
}

/** Persist Stop authority independently of request acceptance. INSERT OR
 * IGNORE makes retries idempotent and preserves the timestamp of the first
 * user decision; once cancelled, the same request id can never execute later. */
export function requestHarnessChatCancellation(
  requestIdInput: string,
  reason = 'cancelled by user before chat acknowledgement',
): HarnessChatRequestCancellation {
  const requestId = requestIdInput.trim();
  if (!requestId) throw new Error('requestId is required');
  const db = openEventLog();
  db.prepare(
    `INSERT OR IGNORE INTO harness_chat_request_cancellations
       (request_id, requested_at, reason)
     VALUES (?, ?, ?)`,
  ).run(requestId, nowIso(), reason.trim() || null);
  const row = db.prepare(
    `SELECT request_id, requested_at, reason
       FROM harness_chat_request_cancellations
      WHERE request_id = ?`,
  ).get(requestId) as {
    request_id: string;
    requested_at: string;
    reason: string | null;
  } | undefined;
  if (!row) throw new Error(`failed to persist chat cancellation ${requestId}`);
  return rowToHarnessChatRequestCancellation(row);
}

export function getHarnessChatCancellation(requestIdInput: string): HarnessChatRequestCancellation | null {
  const requestId = requestIdInput.trim();
  if (!requestId) return null;
  const row = openEventLog().prepare(
    `SELECT request_id, requested_at, reason
       FROM harness_chat_request_cancellations
      WHERE request_id = ?`,
  ).get(requestId) as {
    request_id: string;
    requested_at: string;
    reason: string | null;
  } | undefined;
  return row ? rowToHarnessChatRequestCancellation(row) : null;
}

/** Atomically claim or replay a desktop chat request. A request id is bound to
 * exactly one payload/session/run for its lifetime; conflicting reuse fails
 * closed instead of silently executing different work under an old dedupe key. */
export function claimHarnessChatRequest(input: {
  requestId: string;
  sessionId: string;
  runId: string;
  inputHash: string;
  sinceSeq: number;
}): { receipt: HarnessChatRequestReceipt; inserted: boolean } {
  const requestId = input.requestId.trim();
  if (!requestId) throw new Error('requestId is required');
  const db = openEventLog();
  const claim = db.transaction((): { receipt: HarnessChatRequestReceipt; inserted: boolean } => {
    const cancelled = db.prepare(
      'SELECT 1 FROM harness_chat_request_cancellations WHERE request_id = ?',
    ).get(requestId);
    if (cancelled) throw new Error(`client request id ${requestId} was cancelled before acceptance`);

    const createdAt = nowIso();
    const result = db.prepare(
      `INSERT OR IGNORE INTO harness_chat_requests
         (request_id, session_id, run_id, input_hash, since_seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(requestId, input.sessionId, input.runId, input.inputHash, input.sinceSeq, createdAt);
    const row = db.prepare(
      `SELECT request_id, session_id, run_id, input_hash, since_seq, created_at
         FROM harness_chat_requests WHERE request_id = ?`,
    ).get(requestId) as {
      request_id: string;
      session_id: string;
      run_id: string;
      input_hash: string;
      since_seq: number;
      created_at: string;
    } | undefined;
    if (!row) throw new Error(`failed to persist chat request ${requestId}`);
    const receipt = rowToHarnessChatRequestReceipt(row);
    if (
      receipt.sessionId !== input.sessionId
      || receipt.runId !== input.runId
      || receipt.inputHash !== input.inputHash
    ) {
      throw new Error(`client request id ${requestId} is already bound to a different chat request`);
    }
    return { receipt, inserted: result.changes === 1 };
  });
  // Serialize the cancellation check with receipt creation. Whichever durable
  // decision reaches SQLite first wins; a second daemon/process cannot slip a
  // receipt between a pre-ack Stop and this acceptance boundary.
  return claim.immediate();
}

const SESSION_KILL_SCOPE = 'session:*';

interface RawKillRequestRow {
  session_id: string;
  scope_key: string;
  attempt_id: string | null;
  run_id: string | null;
  requested_at: string;
  reason: string | null;
}

function rowToKillRequest(row: RawKillRequestRow): KillRequestRef {
  return {
    sessionId: row.session_id,
    scopeKey: row.scope_key,
    attemptId: row.attempt_id,
    runId: row.run_id,
    requestedAt: row.requested_at,
    reason: row.reason,
  };
}

function listKillRequests(sessionId: string): KillRequestRef[] {
  return (openEventLog().prepare(
    `SELECT session_id, scope_key, attempt_id, run_id, requested_at, reason
       FROM run_kill_requests
      WHERE session_id = ?
      ORDER BY requested_at DESC, scope_key ASC`,
  ).all(sessionId) as RawKillRequestRow[]).map(rowToKillRequest);
}

/** Resolve source-event authority without relying on the session's newest/active
 * attempt. Superseded attempts stay queryable because their process may still
 * be unwinding and must be able to observe its own stop. */
export function getRunAttemptBySourceUserSeq(
  sessionId: string,
  sourceUserSeq: number,
): RunAttemptRecord | null {
  if (!Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) return null;
  const row = openEventLog().prepare(
    `SELECT attempt_id, run_id, started_at, finished_at, status,
            lease_owner, lease_expires_at, source_user_seq
       FROM run_attempts
      WHERE session_id = ? AND source_user_seq = ?
      ORDER BY started_at DESC, rowid DESC
      LIMIT 1`,
  ).get(sessionId, sourceUserSeq) as {
    attempt_id: string;
    run_id: string | null;
    started_at: string;
    finished_at: string | null;
    status: RunAttemptRecord['status'];
    lease_owner: string | null;
    lease_expires_at: string | null;
    source_user_seq: number | null;
  } | undefined;
  return row ? {
    sessionId,
    attemptId: row.attempt_id,
    runId: row.run_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    sourceUserSeq: row.source_user_seq,
  } : null;
}

function resolveKillTarget(
  sessionId: string,
  target: KillRequestTarget | undefined,
  useActiveFallback: boolean,
): Pick<RunAttemptRef, 'attemptId' | 'runId'> | null {
  if (target && Number.isSafeInteger(target.sourceUserSeq) && (target.sourceUserSeq ?? 0) > 0) {
    const attempt = getRunAttemptBySourceUserSeq(sessionId, target.sourceUserSeq as number);
    if (!attempt) return null;
    return { attemptId: attempt.attemptId, runId: attempt.runId };
  }
  const attemptId = target?.attemptId?.trim() || null;
  const runId = target?.runId?.trim() || null;
  if (attemptId || runId) return { attemptId: attemptId ?? '', runId };
  if (!useActiveFallback) return { attemptId: '', runId: null };
  const active = getActiveRunAttempt(sessionId);
  return active ? { attemptId: active.attemptId, runId: active.runId } : { attemptId: '', runId: null };
}

function targetScopeKeys(target: Pick<RunAttemptRef, 'attemptId' | 'runId'>): string[] {
  return [
    target.attemptId ? `attempt:${target.attemptId}` : '',
    target.runId ? `run:${target.runId}` : '',
  ].filter(Boolean);
}

function killMatchesTarget(
  kill: Pick<KillRequestRef, 'scopeKey' | 'attemptId' | 'runId'>,
  target: Pick<RunAttemptRef, 'attemptId' | 'runId'>,
): boolean {
  if (kill.scopeKey === SESSION_KILL_SCOPE) return true;
  if (kill.attemptId) return Boolean(target.attemptId) && kill.attemptId === target.attemptId;
  if (kill.runId) return Boolean(target.runId) && kill.runId === target.runId;
  return false;
}

/** Relevant kill for the current active attempt (or the session compatibility
 * row when idle). Historical attempt latches are intentionally not projected as
 * a kill for a newer active turn. */
export function getKillRequest(sessionId: string, target?: KillRequestTarget): KillRequestRef | null {
  const rows = listKillRequests(sessionId);
  const sessionWide = rows.find((row) => row.scopeKey === SESSION_KILL_SCOPE) ?? null;
  const resolved = resolveKillTarget(sessionId, target, target === undefined);
  if (!resolved) return sessionWide;
  return rows.find((row) => killMatchesTarget(row, resolved))
    ?? sessionWide
    ?? null;
}

/**
 * Latch a stop to the active attempt when one exists. Callers that already
 * resolved the concrete channel run can pass it explicitly, covering the
 * pre-dispatch window before the model runtime starts.
 */
export function requestKill(
  sessionId: string,
  reason?: string,
  target: KillRequestTarget = {},
): void {
  const db = openEventLog();
  const resolved = resolveKillTarget(sessionId, target, true);
  if (!resolved) {
    throw new Error(`no run attempt for source user event ${target.sourceUserSeq} in session ${sessionId}`);
  }
  const attemptId = resolved.attemptId || null;
  const runId = resolved.runId || null;
  if (attemptId) {
    const owner = db.prepare('SELECT session_id FROM run_attempts WHERE attempt_id = ?')
      .get(attemptId) as { session_id: string } | undefined;
    if (!owner || owner.session_id !== sessionId) {
      throw new Error(`run attempt ${attemptId} is not registered to session ${sessionId}`);
    }
  } else if (runId) {
    const owner = db.prepare('SELECT 1 FROM run_attempts WHERE session_id = ? AND run_id = ? LIMIT 1')
      .get(sessionId, runId);
    if (!owner) throw new Error(`run ${runId} is not registered to session ${sessionId}`);
  }
  const scopeKey = attemptId ? `attempt:${attemptId}` : runId ? `run:${runId}` : SESSION_KILL_SCOPE;
  const requestedAt = nowIso();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO run_kill_requests
         (session_id, scope_key, attempt_id, run_id, requested_at, reason)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, scope_key) DO UPDATE SET
         attempt_id = excluded.attempt_id,
         run_id = excluded.run_id,
         requested_at = excluded.requested_at,
         reason = excluded.reason`,
    ).run(sessionId, scopeKey, attemptId, runId, requestedAt, reason ?? null);
    // The old table is only a compatibility mirror for a genuinely unscoped
    // request. Mirroring an attempt target recreates the session-wide race this
    // table exists to remove.
    if (scopeKey === SESSION_KILL_SCOPE) {
      db.prepare(
        `INSERT OR REPLACE INTO kill_switches (session_id, requested_at, reason)
         VALUES (?, ?, ?)`,
      ).run(sessionId, requestedAt, reason ?? null);
    }
  });
  tx();
}

export function isKillRequested(
  sessionId: string,
  target?: KillRequestTarget,
): boolean {
  const rows = listKillRequests(sessionId);
  if (rows.some((kill) => kill.scopeKey === SESSION_KILL_SCOPE)) return true;
  const resolved = resolveKillTarget(sessionId, target, target === undefined);
  if (resolved && rows.some((kill) => killMatchesTarget(kill, resolved))) return true;
  // Compatibility for a database written by an older process. v11 rebuilds
  // this table with session-only rows, so it can never widen an exact target.
  return Boolean(openEventLog()
    .prepare('SELECT 1 AS x FROM kill_switches WHERE session_id = ?')
    .get(sessionId));
}

/**
 * Prepare a fresh attempt without erasing a stop aimed at that attempt. Any
 * scoped stop for a superseded attempt (or an old unscoped compatibility row)
 * is discarded so a reusable session cannot be permanently bricked.
 */
export function preserveCurrentKillAndClearStale(
  sessionId: string,
  attempt: Pick<RunAttemptRef, 'attemptId' | 'runId'>,
): boolean {
  const exact = listKillRequests(sessionId).some((kill) =>
    kill.scopeKey !== SESSION_KILL_SCOPE && killMatchesTarget(kill, attempt));
  // An idle-session compatibility latch must not curse the next fresh turn.
  // Clear it even when the current attempt also has an exact latch: the exact
  // row remains authoritative and latches for other attempts still survive.
  clearKill(sessionId);
  return exact;
}

export function clearKill(
  sessionId: string,
  target?: KillRequestTarget,
): void {
  const db = openEventLog();
  const resolved = target ? resolveKillTarget(sessionId, target, false) : null;
  // A source-bound caller that cannot resolve its attempt must never clear a
  // different attempt's latch as a fallback.
  if (target && !resolved) return;
  const tx = db.transaction(() => {
    if (target && resolved) {
      const keys = targetScopeKeys(resolved);
      for (const key of keys) {
        db.prepare('DELETE FROM run_kill_requests WHERE session_id = ? AND scope_key = ?')
          .run(sessionId, key);
      }
      return;
    }
    db.prepare('DELETE FROM run_kill_requests WHERE session_id = ? AND scope_key = ?')
      .run(sessionId, SESSION_KILL_SCOPE);
    db.prepare('DELETE FROM kill_switches WHERE session_id = ?').run(sessionId);
  });
  tx();
}

// Lossless side-store cap for a single tool result. This bounds ONLY what's
// parked for recall_tool_result / tool_output_query — it NEVER enters the model
// context (that's gated separately by the ~8KB event-log clip + ~12KB digest +
// the per-turn recall budget), so a generous value costs disk, not tokens.
// Raised 200KB → 2MB (2026-06-25): a 200KB ceiling tail-dropped the back of
// large-but-legitimate results (Apify dataset items, DataForSEO reports), and
// since tool_output_query pages from THIS store, dropped rows became
// unqueryable — not just unshown. 2MB covers realistic single-call results
// (~thousands of records); the 14-day retention sweep below bounds aggregate
// disk. The tail-truncate + truncated_at_write marker stays as a backstop for
// the pathological >2MB case.
export const TOOL_OUTPUT_MAX_BYTES = 2_000_000;

export interface ToolOutputRecord {
  output: string;
  contentBytes: number;
  truncatedAtWrite: boolean;
  tool: string | null;
  createdAt: string;
}

export interface WriteToolOutputInput {
  sessionId: string;
  callId: string;
  tool?: string | null;
  output: string;
}

/**
 * Persist the full tool output keyed by (session_id, call_id) so the
 * recall_tool_result tool can retrieve it after the event-log copy is
 * clipped. Capped at TOOL_OUTPUT_MAX_BYTES with an explicit
 * truncated_at_write marker — distinct from the per-turn `[clipped: ...]`
 * stub Layer 1 emits.
 *
 * Idempotent on conflict: `(session_id, call_id)` is the primary key
 * and we INSERT OR REPLACE so a duplicate tool_returned event (e.g.
 * after a retry) cleanly overwrites the row.
 */
export function writeToolOutput(input: WriteToolOutputInput): void {
  const db = openEventLog();
  const original = input.output;
  const originalBytes = Buffer.byteLength(original, 'utf8');

  const existing = db.prepare(
    `SELECT content_bytes
       FROM tool_outputs
      WHERE session_id = ? AND call_id = ?`,
  ).get(input.sessionId, input.callId) as { content_bytes: number } | undefined;
  if (existing && existing.content_bytes > originalBytes) {
    return;
  }

  let stored = original;
  let truncated = false;
  if (originalBytes > TOOL_OUTPUT_MAX_BYTES) {
    // Tail-truncate by char count, then re-check bytes (multi-byte
    // chars can still push us over; clamp again if needed).
    stored = original.slice(0, TOOL_OUTPUT_MAX_BYTES);
    while (Buffer.byteLength(stored, 'utf8') > TOOL_OUTPUT_MAX_BYTES) {
      stored = stored.slice(0, stored.length - 1);
    }
    truncated = true;
  }
  db.prepare(
    `INSERT OR REPLACE INTO tool_outputs
       (session_id, call_id, tool, output_full, content_bytes, truncated_at_write, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.sessionId,
    input.callId,
    input.tool ?? null,
    stored,
    originalBytes,
    truncated ? 1 : 0,
    nowIso(),
  );
}

/**
 * Search a session's stored tool outputs for rows containing ANY of the
 * given terms. Powers the grounding gate's source retrieval: before an
 * irreversible external write, the gate pulls the artifacts that mention
 * the write's TARGET (recipient email/name/domain) so an independent
 * judge can verify the outgoing payload against what was actually
 * researched for that target. Newest first; caller clips content.
 */
export function searchToolOutputs(
  sessionId: string,
  terms: string[],
  opts: { limit?: number } = {},
): Array<{ callId: string; tool: string | null; output: string; createdAt: string }> {
  const cleaned = terms.map((t) => t.trim()).filter((t) => t.length >= 3);
  if (cleaned.length === 0) return [];
  const db = openEventLog();
  const likes = cleaned.map(() => 'output_full LIKE ?').join(' OR ');
  const rows = db.prepare(
    `SELECT call_id, tool, output_full, created_at
       FROM tool_outputs
      WHERE session_id = ? AND (${likes})
      ORDER BY created_at DESC
      LIMIT ?`,
  ).all(sessionId, ...cleaned.map((t) => `%${t}%`), Math.max(1, Math.min(opts.limit ?? 6, 20))) as Array<{
    call_id: string; tool: string | null; output_full: string; created_at: string;
  }>;
  return rows.map((r) => ({ callId: r.call_id, tool: r.tool, output: r.output_full, createdAt: r.created_at }));
}

/**
 * Most-recent stored tool outputs for a session, newest first. The numeric/
 * output-grounding gate uses this as a fallback when label-based
 * `searchToolOutputs` retrieval comes up thin: a reported figure often derives
 * from a row whose label vocabulary differs from the deliverable's wording
 * (e.g. a raw metrics blob), so the gate also looks at the latest data the
 * figures most plausibly came from. Same row shape as `searchToolOutputs`.
 */
export function recentToolOutputs(
  sessionId: string,
  opts: { limit?: number } = {},
): Array<{ callId: string; tool: string | null; output: string; createdAt: string }> {
  const db = openEventLog();
  const rows = db.prepare(
    `SELECT call_id, tool, output_full, created_at
       FROM tool_outputs
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?`,
  ).all(sessionId, Math.max(1, Math.min(opts.limit ?? 8, 40))) as Array<{
    call_id: string; tool: string | null; output_full: string; created_at: string;
  }>;
  return rows.map((r) => ({ callId: r.call_id, tool: r.tool, output: r.output_full, createdAt: r.created_at }));
}

/**
 * Drop `tool_outputs` rows older than `maxAgeDays` (default 14). Called
 * from the daemon's hourly maintenance tick — without this, the table
 * grows unbounded (~10 MB/day at observed write rates) and the harness
 * sqlite file balloons over weeks. The 14-day window covers any
 * plausible follow-up where the agent might want to `recall_tool_result`
 * on a prior call; beyond that the conversation has almost certainly
 * compacted past the clip placeholder anyway, so the recall is moot.
 *
 * Returns the number of rows deleted. Operator-overridable via
 * `CLEMMY_TOOL_OUTPUT_TTL_DAYS` env (clamped to [1, 365]).
 */
export function reapStaleToolOutputs(maxAgeDays?: number): number {
  const env = process.env.CLEMMY_TOOL_OUTPUT_TTL_DAYS;
  const ttl = maxAgeDays ?? (env ? Math.max(1, Math.min(365, Number(env))) : 14);
  if (!Number.isFinite(ttl) || ttl <= 0) return 0;
  const db = openEventLog();
  const result = db
    .prepare(`DELETE FROM tool_outputs WHERE created_at < datetime('now', ?)`)
    .run(`-${Math.floor(ttl)} days`);
  return result.changes;
}

/**
 * Drop terminal (completed/failed/cancelled) sessions older than `maxAgeDays`
 * (default 14) and — via the `ON DELETE CASCADE` on every child table
 * (events, tool_outputs, kill switches, …) with `PRAGMA foreign_keys = ON`
 * set on the connection — all of their child rows. Active/paused sessions are
 * NEVER touched, so the user can always resume in-flight work.
 *
 * Without this the `sessions` + `events` tables append forever and harness.db
 * balloons over weeks (observed 159 MB). `reapStaleToolOutputs` already caps
 * one child table; this caps the parent (and everything under it). After the
 * delete we checkpoint the WAL (TRUNCATE) so reclaimed pages actually return
 * to the main file instead of accumulating in the -wal sidecar.
 *
 * Returns the number of sessions deleted. Operator-overridable via
 * `CLEMMY_SESSION_TTL_DAYS` env (clamped to [1, 365]).
 */
export function reapStaleSessions(maxAgeDays?: number): number {
  const env = process.env.CLEMMY_SESSION_TTL_DAYS;
  const ttl = maxAgeDays ?? (env ? Math.max(1, Math.min(365, Number(env))) : 14);
  if (!Number.isFinite(ttl) || ttl <= 0) return 0;
  const db = openEventLog();
  // Never reap a conversation the user has pinned or archived for keeping
  // — those are explicit "hold onto this" signals from the Conversations
  // UI, stored additively in metadata_json. Without this guard a pinned
  // Discord/workflow conversation would silently vanish after the TTL.
  const result = db
    .prepare(
      `DELETE FROM sessions
       WHERE status IN ('completed','failed','cancelled')
         AND updated_at < datetime('now', ?)
         AND metadata_json NOT LIKE '%"pinned":true%'
         AND metadata_json NOT LIKE '%"archived":true%'`,
    )
    .run(`-${Math.floor(ttl)} days`);
  // Best-effort WAL merge so the on-disk file actually shrinks after a reap.
  // A busy db just retries on the next tick — never let this throw.
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // opportunistic; ignore
  }
  return result.changes;
}

export function getToolOutput(sessionId: string, callId: string): ToolOutputRecord | null {
  const db = openEventLog();
  const row = db
    .prepare(
      `SELECT output_full, content_bytes, truncated_at_write, tool, created_at
       FROM tool_outputs
       WHERE session_id = ? AND call_id = ?`,
    )
    .get(sessionId, callId) as
    | {
        output_full: string;
        content_bytes: number;
        truncated_at_write: number;
        tool: string | null;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    output: row.output_full,
    contentBytes: row.content_bytes,
    truncatedAtWrite: row.truncated_at_write === 1,
    tool: row.tool,
    createdAt: row.created_at,
  };
}

// ─── v0.5.19 F6 — tool-guardrail state persistence ────────────────
//
// The tool-guardrail keeps a per-session sliding window of recent
// tool calls so it can detect loops (same args repeated; mutating
// tool spamming distinct args). Before v0.5.19 this state lived only
// in-memory, so long workflows that crossed a daemon restart lost
// their loop-detection history. Persist the recent[] queue here;
// the guardrail rebuilds derived state (signature counts, distinct
// mutating-tool args) from it on rehydrate.

function guardrailParentSessionId(scopeId: string): string {
  const separator = scopeId.indexOf('::');
  return separator >= 0 ? scopeId.slice(0, separator) : scopeId;
}

export function writeGuardrailState(scopeId: string, recentJson: string): void {
  const db = openEventLog();
  const parentSessionId = guardrailParentSessionId(scopeId);
  // Out-of-band/test-only wrappers can evaluate a guardrail without first
  // creating a harness session. Persistence is optional in that lane; skip it
  // cleanly instead of raising a foreign-key warning on the hot tool path.
  const parent = db.prepare('SELECT id FROM sessions WHERE id = ?').get(parentSessionId) as { id: string } | undefined;
  if (!parent) return;
  db.prepare(
    `INSERT INTO tool_guardrail_scope_state (scope_id, parent_session_id, recent_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(scope_id) DO UPDATE SET
       parent_session_id = excluded.parent_session_id,
       recent_json = excluded.recent_json,
       updated_at  = excluded.updated_at`,
  ).run(scopeId, parentSessionId, recentJson, new Date().toISOString());
}

export function readGuardrailState(scopeId: string): string | null {
  const db = openEventLog();
  const row = db
    .prepare('SELECT recent_json FROM tool_guardrail_scope_state WHERE scope_id = ?')
    .get(scopeId) as { recent_json: string } | undefined;
  return row?.recent_json ?? null;
}

export function clearGuardrailState(scopeId: string): void {
  const db = openEventLog();
  db.prepare('DELETE FROM tool_guardrail_scope_state WHERE scope_id = ?').run(scopeId);
  // Compatibility cleanup for plain-session rows created before schema v6.
  if (scopeId === guardrailParentSessionId(scopeId)) {
    db.prepare('DELETE FROM tool_guardrail_state WHERE session_id = ?').run(scopeId);
  }
}
