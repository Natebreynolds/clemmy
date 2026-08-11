import Database from 'better-sqlite3';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BASE_DIR } from '../../config.js';
import { actionBus } from '../action-bus.js';
import { mirrorEventToOperational } from './eventlog-operational-mirror.js';
import { AUDIT_MIRRORED_EVENT_TYPES, appendAuditRecord } from '../audit-ledger.js';
import {
  projectHarnessEventForPublic,
  publicAsyncWorkDispatchedData,
} from './public-presentation.js';
import { toolOutputLooksSuccessful } from './tool-evidence.js';
import { isPlainOrClementineLocalTool } from './runtime-tool-identity.js';
import { isSettledReadReplayReturnData } from './settled-read-replay-semantics.js';
import { presentationEventFromCompletionData } from './turn-outcome.js';
import { validateTurnGraph } from '../graph/turn-graph-compiler.js';
import type { TurnGraphIR } from '../graph/turn-graph-ir.js';
import { verifyAcceptedTaskTerminalProofInTransaction } from './terminal-publication-proof.js';
import type { ObligationManifest } from './obligation-manifest.js';
import {
  exactOriginDeliveryTargetDigest,
  exactOriginDeliveryTargetFromSessionSnapshot,
  normalizeExactOriginDeliveryTarget,
  sameExactOriginDeliveryTarget,
} from '../exact-origin-delivery.js';

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
  // Private Claude local-MCP handoff: canUseTool has the provider's outer
  // toolUseID before the in-process handler sees its transport request. This
  // is permission/correlation state, not a physical tool attempt, so it must
  // never share tool_called accounting.
  'claude_local_permission_admitted',
  // Private handler-consumption proof used only when the SDK stream authored
  // the outer canonical call before the local MCP handler entered. Keeping the
  // claim separate preserves append-only event history and prevents a second
  // identical handler from consuming the same admission.
  'claude_local_permission_claimed',
  'tool_called',
  'tool_returned',
  'step_verified',
  'step_failed',
  'handoff',
  'awaiting_user_input',
  'user_input_received',
  // Mid-run steering (2026-08-07): a user message that arrived while the
  // session had an active attempt — delivered to the model at the next
  // tool-result boundary instead of superseding the running work.
  'user_steer_note',
  'user_steer_note_delivered',
  // One-release read compatibility for align rows persisted by Clementine 3.5.
  // New turns do not append this event; remove after the upgrade window.
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
  // Private half of the source-group workflow handoff. One row proves a
  // trusted workflow_run producer prepared a held queue member for the exact
  // accepted human source. It is never projected to chat; the loop seals and
  // activates the complete source group before publishing one dispatch ACK.
  'async_work_dispatch_prepared',
  // Durable foreground-release boundary for an exact workflow source group.
  // This freezes the complete ordered set of prepared members before any run
  // can become executable. Prepared-only groups remain held across restarts.
  'async_work_dispatch_batch_closed',
  // Typed nonterminal boundary: an exact workflow_run tool receipt handed
  // continuing ownership to the background workflow daemon. The foreground
  // model/transport may release, but this accepted logical intent remains
  // pending until the workflow's separately sourced outcome reports back.
  'async_work_dispatched',
  // A brain stopped without a safe structured outcome. This is execution-graph
  // state only: the bridge may recover on another brain, then commits exactly
  // one public terminal for the accepted user turn.
  'conversation_recovery_candidate',
  'conversation_completed',
  'conversation_limit_exceeded',
  // Auto-capture writeback: emitted from the harness loop whenever a
  // user message produced durable facts or a profile patch via
  // captureInteractionSignals. Lets the trace show "Clementine learned
  // X from this turn" so memory growth is observable.
  'memory_signals_captured',
  // Content-addressed host authority for an acknowledgement-only durable
  // memory action. Unlike memory_signals_captured telemetry, this event is
  // issued only after the host independently redeems the exact accepted source
  // against its episode and auto-capture candidate rows.
  'durable_memory_intake_receipt',
  // Evidence-first procedural learning boundary. Every automatic candidate
  // records whether it was eligible, which runtime authority verified it, and
  // why a paused/degraded/ambiguous run was refused. The event never drives the
  // run; it makes "why did Clem learn (or not learn) this?" auditable.
  'learning_candidate_evaluated',
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
  // Stage 4 fan-out slice (2026-07-20): the active run token window {baseline,
  // ceiling}, recorded at window open by BOTH lanes so run_worker — which runs
  // in the SDK-brain MCP child, a separate process — can refuse to spawn past
  // an exhausted ceiling. Latest event wins.
  'run_token_window',
  // Fail-closed approval park (2026-07-20): the chat/worker WAIT gate hit its
  // hold ceiling with the card still pending — the turn ended honestly and the
  // durable card stayed resumable. {approvalId, tool, subject}. Read by
  // chat-approval-resume to auto-resume the session on a later approval.
  'approval_parked',
  // SDK local-MCP startup guard retried because the required local tool surface
  // was empty or no init message arrived before the startup budget.
  'sdk_tool_surface_retry',
  // The modern Claude Agent SDK reported an internal provider retry. This is
  // observational only, but it prevents the legacy outer retry layer from
  // replaying an already-exhausted physical query.
  'sdk_api_retry',
  // Spawn→first SDK frame latency for one query. In current Claude SDKs this is
  // normally the child-process init frame, not model TTFT; retained for
  // compatibility with existing telemetry consumers.
  'sdk_first_byte',
  // Spawn→first genuine model/provider activity after SDK initialization
  // (assistant/stream/thinking/tool-progress/result). This is the truthful
  // user-wait metric; init and api_retry control frames do not satisfy it.
  'sdk_first_model_activity',
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
  // The negative half of the credit loop: a user correction of the prior turn
  // recorded a bounded `not_useful` signal against the facts that fed it.
  'memory_correction',
  // Per-turn deterministic context packet: summarizes the memory
  // primer, likely skills/workflows, MCP health, local health, and
  // complexity classification that were injected transiently before
  // the model call.
  'agent_context_packet',
  // Provider-neutral, shadow-only turn graph compiled from one exact accepted
  // chat source. Observational only: it cannot grant authority or alter the
  // active v3.6 execution path.
  'turn_graph_compiled',
  // Fail-closed cutover marker for the Clem 4 evidence protocol. The graph
  // remains observational by itself; this row records that the host accepted
  // its exact identity as the authority contract before provider work began.
  'accepted_task_authority_armed',
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
  // Exact terminal receipt for a pre-dispatch external_write reservation. A
  // reservation alone is never completion evidence: only this same-call
  // settlement proves the provider returned cleanly.
  'external_write_succeeded',
  // S3 orphan ledger: a MUTATING external write TIMED OUT. The harness stops
  // waiting but the request MAY have landed server-side (it is aborted at the
  // network layer — recorded in `aborted`). Durable audit of maybe-landed
  // writes, and the signal the orphaned-write retry corrective consults before
  // a blind same-shape retry.
  'external_write_orphaned',
  // Explicit, execution-owned retry lineage. Authorization names one proven
  // failed call; consumption is a durable one-shot CAS recorded before a
  // corrected provider attempt is reserved.
  'external_write_retry_authorized',
  'external_write_retry_consumed',
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
  // Durable long-horizon work graph. A manifest declares the canonical item
  // universe and ordered phases once; checkpoints update one canonical
  // item/phase with evidence; contract revisions decide whether completed
  // evidence remains valid. These are control-plane facts, not model verdicts.
  'work_manifest_declared',
  'work_item_checkpoint',
  'work_contract_revised',
  // A user changed the objective/constraints of a durable background task while
  // it was queued or running. The task record owns the revision history; this
  // event makes the course correction visible in the same live trace.
  'background_contract_revised',
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
  // Legacy parse-exhaustion marker retained for replay compatibility. New
  // graph turns use conversation_recovery_candidate and never publish the
  // exhausted brain's proposal as a terminal in the first place.
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
  // E4 read lane: the durable receipt row a verified read dispatch appends —
  // the promotion/verification authority the resolver reads back by id.
  // Internal evidence: the public-presentation allowlist does not carry it.
  'read_receipt',
  // A governed warm candidate needed one physical exact-slug provider metadata
  // refresh to restore schema authority. This is not a business tool call and
  // not cold-lane discovery. Payload is deliberately identifier/account-free:
  // {sourceUserSeq, attemptId, artifactId, durationMs, outcome}.
  'warm_schema_metadata_refresh',
  // Durable discovery-budget admission and settlement telemetry. These rows
  // make the one-broad/one-exact-refresh task budget auditable across process
  // restarts without exposing provider identifiers or request payloads.
  'discovery_governor_decision',
  'discovery_governor_outcome',
  // Why a spent discovery budget reopened. Carries {kind, outcome,
  // previousEpoch, epoch, detail} — the observed fact that made the previous
  // search stale, so a task that keeps searching can be told apart from one
  // that keeps LEARNING.
  'discovery_governor_evidence',
  // One typed settlement per tool attempt, from the shared seam every lane
  // ends in. Carries {lane, tool, kind, evidence, action, businessCall,
  // mutating, openedDiscoveryEpoch, creditedProgress} — the audit trail for
  // "which recovery ran, and why".
  'tool_attempt_settled',
  // Durable requirement satisfaction for an accepted task, so a restart does
  // not lose what the task already proved.
  'requirement_state',
  'evidence_receipt',
  'write_evidence_proved',
  'obligation_manifest',
  'obligation_satisfied',
  // One bounded, host-owned chance to gather missing terminal proof. These are
  // control-plane facts, never model-facing scripts or new user turns.
  'terminal_authority_repair_granted',
  'terminal_authority_repair_consumed',
  'terminal_authority_backstop_fired',
  'resolution_operation',
  'resolution_finalized',
  'logical_call_contract_refined',
  'provider_dispatch_started',
  'provider_dispatch_settled',
  // An authorized tool the turn did not advertise was named and fetched.
  // Carries {tool, serverSlug, reason, scopeReason, advertised,
  // widenedBeyondTurnBase} — the audit trail for "the cap was wrong, and the
  // run recovered anyway".
  'mcp_tool_acquired',
  // Typed capability resolution: what this turn's ask can already rely on
  // (proven procedures), what has failed before (invalidated memos), and the
  // connection state of each — resolved by the runtime at preflight. The UI's
  // live "what Clem knows going in" frame and the graph's future admission
  // input. Carries {entries, registryAvailable, sourceUserSeq?}.
  'capability_resolution',
  // Exact schema-backed capabilities surfaced by one governed discovery call.
  // This is restart-safe continuation evidence only: no query, arguments,
  // provider payload, or dispatch authority is stored. Carries
  // {sourceUserSeq, capabilities[{kind,identifier,effectClass,
  // schemaFingerprint?}]}.
  'capability_discovered',
  // What occupied this turn's prompt, split by whether it can be cached.
  // Per-step prompt cost is paid once per step and therefore ~100x per task,
  // so the lever on latency is keeping the LARGE part invariant and the
  // VARIABLE part small — which is only auditable if the split is recorded.
  // Observation only; it never changes a byte of any prompt. Carries
  // {lane, totalTokens, stableTokens, variableTokens, stableShare, toolCount,
  // buckets[], sourceUserSeq?}.
  'prompt_composition',
  // A file the runtime ACTUALLY wrote (local deliverable). Emitted by the
  // write path after the filesystem write succeeds — runtime truth, not model
  // prose — so drafted emails / reports appear in the live feed as they land
  // instead of vanishing into a folder. Carries {name, dir, bytes}.
  'deliverable_saved',
  // Durable record of the Claude lane's inner SDK business-tool uses. That
  // lane's tools do not cross the dispatch ledger, so without this marker a
  // worked action turn looks evidence-free to store-driven terminal
  // adjudication and fails closed. Carries {sourceUserSeq, tools[]}.
  'sdk_tool_use_recorded',
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
    // recall_tool_result …]` stub can retrieve the verbatim
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
  {
    // session_locks was left as a knowing vestige by the 2026-07-09 subtraction
    // (withSessionLock removed; CREATE kept "inert"). The 2026-07-22 legacy
    // sweep confirmed zero readers/writers remain — close the loop.
    version: 13,
    sql: 'DROP TABLE IF EXISTS session_locks;',
  },
  {
    // A fresh human approval may authorize one deliberate duplicate send, but
    // it is not standing permission for unlimited later replays. Keep this
    // consumption independent from the workflow payload-consumption column:
    // the approval gate may consume `consumed_at` immediately before the
    // duplicate wall evaluates the same approved call.
    version: 14,
    sql: '',
    backfill(db) {
      const table = db.prepare(`
        SELECT 1 AS present
          FROM sqlite_master
         WHERE type = 'table' AND name = 'pending_approvals'
      `).get() as { present: number } | undefined;
      if (!table) return;
      const columns = new Set(
        (db.prepare('PRAGMA table_info(pending_approvals)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.has('resend_consumed_at')) {
        db.exec('ALTER TABLE pending_approvals ADD COLUMN resend_consumed_at TEXT');
        columns.add('resend_consumed_at');
      }
      if (
        ['session_id', 'resolved_at', 'status', 'resolution', 'resend_consumed_at']
          .every((column) => columns.has(column))
      ) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_pending_approvals_resend_consent
            ON pending_approvals(session_id, resolved_at DESC)
            WHERE status = 'resolved'
              AND resolution = 'approved'
              AND resend_consumed_at IS NULL
        `);
      }
    },
  },
  {
    // Physical model attempts are cancelable transports, not dispatch
    // authority. A provider can acknowledge cancel and still deliver a late
    // tool call after a retry/recovery has begun. Keep one durable generation
    // per execution scope so every process (including the Claude local-MCP
    // child) can reject work from a superseded generation before bookkeeping
    // or provider dispatch.
    version: 15,
    sql: `
      CREATE TABLE IF NOT EXISTS run_dispatch_leases (
        scope_id       TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        lease_id       TEXT NOT NULL,
        run_attempt_id TEXT REFERENCES run_attempts(attempt_id) ON DELETE CASCADE,
        activated_at   TEXT NOT NULL,
        revoked_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_run_dispatch_leases_session
        ON run_dispatch_leases(session_id, revoked_at);
    `,
  },
  {
    // Internal provider retries own a child generation rather than borrowing
    // the caller's shared lease. Persist the exact parent so a parent revoke
    // invalidates every query child across in-process and stdio MCP transports.
    version: 16,
    sql: '',
    backfill: (db) => {
      const table = db.prepare(`
        SELECT 1 AS present
          FROM sqlite_master
         WHERE type = 'table' AND name = 'run_dispatch_leases'
      `).get() as { present: number } | undefined;
      if (!table) return;
      const columns = new Set(
        (db.prepare('PRAGMA table_info(run_dispatch_leases)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.has('parent_scope_id')) {
        db.exec('ALTER TABLE run_dispatch_leases ADD COLUMN parent_scope_id TEXT');
      }
      if (!columns.has('parent_lease_id')) {
        db.exec('ALTER TABLE run_dispatch_leases ADD COLUMN parent_lease_id TEXT');
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_run_dispatch_leases_parent
          ON run_dispatch_leases(parent_scope_id, parent_lease_id)
      `);
    },
  },
  {
    // One public terminal belongs to one accepted user_input_received event,
    // even across rolling upgrades where an older process still writes the
    // former brain:<attempt> key. A trigger can be installed safely when a
    // historical database already contains duplicate rows (a UNIQUE index
    // cannot); it prevents every future writer, including an old binary, from
    // adding another terminal for an already-settled logical source.
    version: 17,
    sql: '',
    backfill: (db) => {
      const hasEvents = Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'`,
      ).get());
      if (!hasEvents) return;
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_events_one_terminal_per_user_source
        BEFORE INSERT ON events
        WHEN NEW.type = 'conversation_completed'
          AND COALESCE(
            json_extract(NEW.data_json, '$.sourceUserSeq'),
            json_extract(NEW.data_json, '$.presentation.identity.sourceUserSeq')
          ) IS NOT NULL
          AND EXISTS (
            SELECT 1
              FROM events AS settled
             WHERE settled.session_id = NEW.session_id
               AND settled.type = 'conversation_completed'
               AND COALESCE(
                 json_extract(settled.data_json, '$.sourceUserSeq'),
                 json_extract(settled.data_json, '$.presentation.identity.sourceUserSeq')
               ) = COALESCE(
                 json_extract(NEW.data_json, '$.sourceUserSeq'),
                 json_extract(NEW.data_json, '$.presentation.identity.sourceUserSeq')
               )
          )
        BEGIN
          SELECT RAISE(ABORT, 'logical terminal source already exists');
        END;
      `);
    },
  },
  {
    // One verified/success settlement per exact pre-dispatch reservation. New
    // writers carry settlementKey; historical rows remain untouched so an
    // additive upgrade never rewrites ambiguous external-effect history.
    version: 18,
    sql: '',
    backfill: (db) => {
      // Partially recovered/legacy fixtures can legitimately carry a newer
      // schema_version row while the canonical event table is absent. Keep the
      // additive migration tolerant, matching the guarded v7/v17 indexes.
      const hasEvents = Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'`,
      ).get());
      if (hasEvents) {
        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_events_external_write_settlement_key
            ON events(session_id, type, json_extract(data_json, '$.settlementKey'))
            WHERE type = 'external_write_succeeded'
              AND json_extract(data_json, '$.settlementKey') IS NOT NULL;
        `);
      }
      const hasArtifacts = Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_artifacts'`,
      ).get());
      if (!hasArtifacts) return;
      const columns = new Set(
        (db.prepare('PRAGMA table_info(run_artifacts)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      for (const [name, declaration] of [
        ['external_write_event_id', 'external_write_event_id TEXT'],
        ['external_write_action_key', 'external_write_action_key TEXT'],
        ['external_write_tool_name', 'external_write_tool_name TEXT'],
      ] as const) {
        if (!columns.has(name)) db.exec(`ALTER TABLE run_artifacts ADD COLUMN ${declaration}`);
      }
    },
  },
  {
    // Exact settlement/readback bytes need invocation identity stronger than an
    // SDK call id. Keep them in a parallel nonce-keyed store so concurrent or
    // reused call ids cannot overwrite one another, while the legacy call-id
    // recall store retains its backwards-compatible longest-output behavior.
    // v19 is deliberately separate: local canary databases ran an earlier v18
    // while this patch was under review.
    version: 19,
    sql: `
      CREATE TABLE IF NOT EXISTS tool_output_invocations (
        session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        call_id             TEXT NOT NULL,
        invocation_nonce    TEXT NOT NULL,
        tool                TEXT,
        output_full         TEXT NOT NULL,
        content_bytes       INTEGER NOT NULL,
        truncated_at_write  INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL,
        PRIMARY KEY (session_id, call_id, invocation_nonce)
      );
      CREATE INDEX IF NOT EXISTS idx_tool_output_invocations_session
        ON tool_output_invocations(session_id, created_at);
    `,
  },
  {
    // Authority lookups sit on completion, grounding, artifact verification,
    // and memory-write boundaries.  A long-horizon session can contain tens of
    // thousands of tool events, so resolving one call id must not deserialize
    // the entire session.  Index the durable SDK presentation id directly.
    version: 20,
    sql: '',
    backfill: (db) => {
      // Upgrade rehearsals intentionally construct only the table relevant to
      // the historical version under test. Keep that compatibility while a
      // real harness database (which always has events) gets the hot-path index.
      const hasEvents = Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'`,
      ).get());
      if (!hasEvents) return;
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_events_tool_lifecycle_call
          ON events(session_id, type, json_extract(data_json, '$.callId'), seq)
          WHERE type IN ('tool_called', 'tool_returned');
      `);
    },
  },
  {
    // Discovery is a per-accepted-source resource, not a per-process courtesy.
    // Persist both policy and the category claim so daemon restarts and
    // concurrent workers cannot silently reset or double-spend its allowance.
    version: 21,
    sql: `
      CREATE TABLE IF NOT EXISTS discovery_governor_tasks (
        session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_user_seq   INTEGER NOT NULL CHECK (source_user_seq > 0),
        known_capability  INTEGER NOT NULL CHECK (known_capability IN (0, 1)),
        initialized_at    TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        PRIMARY KEY (session_id, source_user_seq)
      );

      CREATE TABLE IF NOT EXISTS discovery_governor_claims (
        session_id       TEXT NOT NULL,
        source_user_seq  INTEGER NOT NULL,
        category         TEXT NOT NULL
                         CHECK (category IN ('broad_discovery', 'exact_schema_refresh')),
        call_id          TEXT NOT NULL,
        outcome          TEXT NOT NULL DEFAULT 'pending'
                         CHECK (outcome IN ('pending', 'succeeded', 'empty', 'failed', 'timed_out')),
        outcome_detail   TEXT,
        admitted_at      TEXT NOT NULL,
        settled_at       TEXT,
        PRIMARY KEY (session_id, source_user_seq, category),
        FOREIGN KEY (session_id, source_user_seq)
          REFERENCES discovery_governor_tasks(session_id, source_user_seq)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_discovery_governor_claims_call
        ON discovery_governor_claims(session_id, source_user_seq, call_id);
    `,
  },
  {
    // Clem 4 accepted-task evidence authority.
    //
    // Resolution is mutable state (open -> finalized), so unlike telemetry it
    // belongs in normalized rows with database-enforced ownership. Operation
    // admission, the mirror event, and finalization are committed by the domain
    // API in one IMMEDIATE transaction. A process crash therefore cannot leave
    // an event claiming a transition the state machine did not make, or vice
    // versa. Raw provider arguments never enter these tables.
    version: 22,
    sql: `
      -- Existing feature code created this table lazily. Fresh homes get the
      -- complete schema here; the guarded backfill below upgrades partial dev
      -- schemas without pretending an old two-column claim carried evidence.
      CREATE TABLE IF NOT EXISTS obligation_transitions (
        obligation_key       TEXT PRIMARY KEY,
        session_id           TEXT NOT NULL,
        source_user_seq      INTEGER NOT NULL,
        manifest_id          TEXT NOT NULL,
        node_id              TEXT NOT NULL,
        obligation           TEXT NOT NULL,
        receipt_id           TEXT NOT NULL,
        physical_attempt_id  TEXT NOT NULL,
        logical_tool_call_id TEXT,
        physical_dispatch_id TEXT,
        claimed_at           TEXT NOT NULL
      );

      -- Compatibility only. It ceases to be settlement authority in the next
      -- slice, but centralizing its schema prevents another lazy-schema fork.
      CREATE TABLE IF NOT EXISTS settlement_claims (
        settlement_key TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL,
        claimed_at     TEXT NOT NULL
      );
    `,
    backfill: (db) => {
      // Upgrade rehearsals intentionally construct only the historical table
      // under test. A resolution cannot exist without the canonical events
      // spine, so do not create FKs to a table that fixture does not contain.
      const hasEvents = Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'`,
      ).get());
      if (hasEvents) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS accepted_task_resolutions (
            session_id                TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            source_user_seq           INTEGER NOT NULL CHECK (source_user_seq > 0),
            accepted_task_id          TEXT NOT NULL UNIQUE,
            graph_event_id            TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
            graph_id                  TEXT NOT NULL,
            graph_hash                TEXT NOT NULL,
            compiler_version          TEXT NOT NULL,
            route                     TEXT NOT NULL CHECK (route IN ('direct_reply','retrieve','act')),
            work_node_id              TEXT,
            work_kind                 TEXT NOT NULL CHECK (work_kind IN ('conversation','retrieve','execute','fanout')),
            effect_ceiling            TEXT NOT NULL,
            external_effect_requested INTEGER NOT NULL CHECK (external_effect_requested IN (0, 1)),
            external_effect_kinds_json TEXT NOT NULL DEFAULT '[]',
            state                     TEXT NOT NULL DEFAULT 'open'
                                      CHECK (state IN ('open','finalized','legacy_ambiguous')),
            revision                  INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
            operation_count           INTEGER NOT NULL DEFAULT 0 CHECK (operation_count >= 0),
            operations_digest         TEXT,
            expectations_satisfied    INTEGER CHECK (expectations_satisfied IN (0, 1)),
            opened_at                 TEXT NOT NULL,
            finalized_at              TEXT,
            finalize_event_id         TEXT REFERENCES events(id) ON DELETE RESTRICT,
            PRIMARY KEY (session_id, source_user_seq)
          );

          CREATE TABLE IF NOT EXISTS accepted_task_operations (
            session_id             TEXT NOT NULL,
            source_user_seq        INTEGER NOT NULL,
            operation_id           TEXT NOT NULL,
            logical_tool_call_id   TEXT NOT NULL,
            graph_node_id          TEXT NOT NULL,
            resolved_tool          TEXT NOT NULL,
            effect_kind            TEXT NOT NULL
                                   CHECK (effect_kind IN ('read','compute','local_write','external_write','admin','unknown')),
            reversibility          TEXT NOT NULL
                                   CHECK (reversibility IN ('read_only','reversible','irreversible','not_applicable','unknown')),
            effect_source          TEXT NOT NULL,
            argument_keys_json     TEXT NOT NULL DEFAULT '[]',
            argument_digest        TEXT NOT NULL,
            physical_dispatch_id  TEXT,
            outcome_kind           TEXT,
            dispatch_state         TEXT CHECK (dispatch_state IN ('not_started','dispatched')),
            recorded_at            TEXT NOT NULL,
            operation_event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
            PRIMARY KEY (session_id, source_user_seq, operation_id),
            UNIQUE (session_id, source_user_seq, logical_tool_call_id),
            FOREIGN KEY (session_id, source_user_seq)
              REFERENCES accepted_task_resolutions(session_id, source_user_seq)
              ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_accepted_task_operations_effect
            ON accepted_task_operations(session_id, source_user_seq, effect_kind);
        `);
      }

      const table = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'obligation_transitions'`,
      ).get();
      if (!table) return;
      const columns = new Set(
        (db.prepare('PRAGMA table_info(obligation_transitions)').all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      const required = [
        'obligation_key', 'session_id', 'source_user_seq', 'manifest_id', 'node_id',
        'obligation', 'receipt_id', 'physical_attempt_id', 'logical_tool_call_id',
        'physical_dispatch_id', 'claimed_at',
      ];
      const missing = required.filter((name) => !columns.has(name));
      if (missing.length === 0) {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_obligation_transitions_task
          ON obligation_transitions(session_id, source_user_seq)`);
        return;
      }

      const priorAuthorityColumns = required.filter((name) =>
        name !== 'logical_tool_call_id' && name !== 'physical_dispatch_id');
      if (priorAuthorityColumns.every((name) => columns.has(name))) {
        // The immediately preceding schema is complete authority and only lacks
        // the corrected identity names. Preserve every row; the legacy
        // physical_attempt_id is compatibility data and is deliberately NOT
        // copied into physical_dispatch_id.
        if (!columns.has('logical_tool_call_id')) {
          db.exec('ALTER TABLE obligation_transitions ADD COLUMN logical_tool_call_id TEXT');
        }
        if (!columns.has('physical_dispatch_id')) {
          db.exec('ALTER TABLE obligation_transitions ADD COLUMN physical_dispatch_id TEXT');
        }
        db.exec(`CREATE INDEX IF NOT EXISTS idx_obligation_transitions_task
          ON obligation_transitions(session_id, source_user_seq)`);
        return;
      }

      // Keep the incompatible rows for forensic inspection. Their absent owner,
      // manifest, receipt, and attempt fields cannot be reconstructed honestly,
      // so none are promoted into terminal authority.
      const legacyExists = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'obligation_transitions_legacy_v21'`,
      ).get();
      if (!legacyExists) {
        db.exec('ALTER TABLE obligation_transitions RENAME TO obligation_transitions_legacy_v21');
      } else {
        db.exec('DROP TABLE obligation_transitions');
      }
      db.exec(`
        CREATE TABLE obligation_transitions (
          obligation_key       TEXT PRIMARY KEY,
          session_id           TEXT NOT NULL,
          source_user_seq      INTEGER NOT NULL,
          manifest_id          TEXT NOT NULL,
          node_id              TEXT NOT NULL,
          obligation           TEXT NOT NULL,
          receipt_id           TEXT NOT NULL,
          physical_attempt_id  TEXT NOT NULL,
          logical_tool_call_id TEXT,
          physical_dispatch_id TEXT,
          claimed_at           TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_obligation_transitions_task
          ON obligation_transitions(session_id, source_user_seq);
      `);
    },
  },
  {
    // Clem 4 logical-call and paid-crossing authority. Inserting a physical
    // dispatch is the permission to let control leave for a provider, not
    // merely telemetry. Domain APIs mirror events in the same transaction and
    // refuse provider I/O when this state cannot be committed.
    version: 23,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (
        !tables.has('sessions')
        || !tables.has('events')
        || !tables.has('accepted_task_resolutions')
      ) return;
      db.exec(`
        CREATE TABLE IF NOT EXISTS logical_tool_calls (
          session_id           TEXT NOT NULL,
          source_user_seq      INTEGER NOT NULL,
          accepted_task_id     TEXT NOT NULL,
          logical_tool_call_id TEXT NOT NULL,
          tool_name            TEXT NOT NULL,
          argument_digest      TEXT NOT NULL,
          state                TEXT NOT NULL DEFAULT 'open'
                               CHECK (state IN ('open','settled','conflict')),
          opened_at            TEXT NOT NULL,
          settled_at           TEXT,
          settlement_event_id  TEXT REFERENCES events(id) ON DELETE RESTRICT,
          outcome_kind         TEXT,
          PRIMARY KEY (session_id, source_user_seq, logical_tool_call_id),
          FOREIGN KEY (session_id, source_user_seq)
            REFERENCES accepted_task_resolutions(session_id, source_user_seq)
            ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS physical_dispatches (
          session_id           TEXT NOT NULL,
          source_user_seq      INTEGER NOT NULL,
          accepted_task_id     TEXT NOT NULL,
          logical_tool_call_id TEXT NOT NULL,
          physical_dispatch_id TEXT NOT NULL,
          ordinal              INTEGER NOT NULL CHECK (ordinal > 0),
          relation             TEXT NOT NULL
                               CHECK (relation IN ('primary','retry','poll','probe','child')),
          retry_of             TEXT,
          tool_name            TEXT NOT NULL,
          argument_digest      TEXT NOT NULL,
          state                TEXT NOT NULL DEFAULT 'started'
                               CHECK (state IN ('started','returned','threw','timed_out','cancelled','unknown')),
          started_at           TEXT NOT NULL,
          settled_at           TEXT,
          start_event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
          settle_event_id      TEXT REFERENCES events(id) ON DELETE RESTRICT,
          PRIMARY KEY (session_id, source_user_seq, physical_dispatch_id),
          UNIQUE (session_id, source_user_seq, logical_tool_call_id, ordinal),
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES logical_tool_calls(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_physical_dispatches_open
          ON physical_dispatches(session_id, source_user_seq, state);
        CREATE INDEX IF NOT EXISTS idx_physical_dispatches_logical
          ON physical_dispatches(session_id, source_user_seq, logical_tool_call_id, ordinal);
      `);
    },
  },
  {
    // Clem 4 atomic logical-call settlement.  Migration 23 established paid
    // crossing admission, but left logical settlement as a separate legacy
    // claim plus a best-effort event.  These normalized rows let one domain
    // transaction freeze the exact semantic result and every paid crossing,
    // mirror it once, and close the logical call by CAS.
    //
    // Do not promote `settlement_claims`: those rows carry neither accepted
    // source, result, contract nor crossing evidence and cannot be upgraded
    // honestly.  They remain forensic compatibility data until cutover.
    version: 24,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      // Historical migration rehearsals intentionally contain no event spine.
      // Keep them sparse.  A real harness database has both tables; on that
      // spine a missing v23 authority table is corruption, not an optional
      // feature, so abort without stamping this migration as applied.
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'accepted_task_resolutions',
        'logical_tool_calls',
        'physical_dispatches',
      ]) {
        if (!tables.has(prerequisite)) {
          throw new Error(`schema v24 prerequisite missing: ${prerequisite}`);
        }
      }

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_physical_dispatch_exact_parent
          ON physical_dispatches(
            session_id, source_user_seq, logical_tool_call_id, physical_dispatch_id
          );

        CREATE UNIQUE INDEX IF NOT EXISTS uq_logical_call_settlement_event
          ON logical_tool_calls(settlement_event_id)
          WHERE settlement_event_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS logical_call_settlements (
          session_id                TEXT NOT NULL,
          source_user_seq           INTEGER NOT NULL CHECK (source_user_seq > 0),
          logical_tool_call_id      TEXT NOT NULL,
          protocol_version          INTEGER NOT NULL CHECK (protocol_version = 1),
          semantic_digest           TEXT NOT NULL CHECK (length(semantic_digest) = 64),
          execution_kind            TEXT NOT NULL
                                    CHECK (execution_kind IN (
                                      'refused_pre_dispatch',
                                      'local_execution',
                                      'provider_execution'
                                    )),
          outcome_kind              TEXT NOT NULL
                                    CHECK (outcome_kind IN (
                                      'succeeded','invalid_arguments','transient',
                                      'unsupported_capability','ignored_requirement',
                                      'input_required','auth_failure','policy_denial',
                                      'uncertain_write','empty_result','unknown'
                                    )),
          outcome_evidence          TEXT NOT NULL
                                    CHECK (outcome_evidence IN ('nominal','structured','text')),
          provider_status           TEXT CHECK (provider_status IS NULL OR length(provider_status) <= 64),
          outcome_detail            TEXT CHECK (outcome_detail IS NULL OR length(outcome_detail) <= 160),
          business_call             INTEGER NOT NULL CHECK (business_call IN (0, 1)),
          mutating                  INTEGER NOT NULL CHECK (mutating IN (0, 1)),
          requirement_id            TEXT CHECK (requirement_id IS NULL OR length(requirement_id) <= 256),
          continues_requirement     INTEGER NOT NULL CHECK (continues_requirement IN (0, 1)),
          recovery_action           TEXT NOT NULL
                                    CHECK (recovery_action IN (
                                      'settle','repair_arguments','retry_with_backoff',
                                      'try_sibling_candidate','ask_user','recover_connection',
                                      'stop_and_explain','reconcile_then_decide'
                                    )),
          retry_same_candidate      INTEGER NOT NULL CHECK (retry_same_candidate IN (0, 1)),
          eliminates_candidate      INTEGER NOT NULL CHECK (eliminates_candidate IN (0, 1)),
          discovery_epoch_requested INTEGER NOT NULL CHECK (discovery_epoch_requested IN (0, 1)),
          requires_reconciliation   INTEGER NOT NULL CHECK (requires_reconciliation IN (0, 1)),
          progress_key_digest       TEXT CHECK (
                                      progress_key_digest IS NULL OR length(progress_key_digest) = 64
                                    ),
          progress_claimed          INTEGER NOT NULL CHECK (progress_claimed IN (0, 1)),
          physical_crossing_count   INTEGER NOT NULL CHECK (physical_crossing_count >= 0),
          physical_crossings_digest TEXT NOT NULL CHECK (length(physical_crossings_digest) = 64),
          observer_lane             TEXT NOT NULL
                                    CHECK (observer_lane IN (
                                      'agents_runner','native_mcp','claude_sdk',
                                      'composio','code_mode','byo'
                                    )),
          observer_call_id          TEXT CHECK (observer_call_id IS NULL OR length(observer_call_id) <= 256),
          settlement_event_id       TEXT NOT NULL UNIQUE
                                    REFERENCES events(id) ON DELETE RESTRICT,
          settled_at                TEXT NOT NULL,
          PRIMARY KEY (session_id, source_user_seq, logical_tool_call_id),
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES logical_tool_calls(
              session_id, source_user_seq, logical_tool_call_id
            ) ON DELETE CASCADE,
          CHECK (
            (execution_kind IN ('refused_pre_dispatch','local_execution')
              AND physical_crossing_count = 0)
            OR
            (execution_kind = 'provider_execution'
              AND physical_crossing_count > 0)
          ),
          CHECK (
            execution_kind != 'refused_pre_dispatch'
            OR outcome_kind NOT IN ('succeeded','empty_result','uncertain_write')
          ),
          CHECK (progress_claimed = 0 OR progress_key_digest IS NOT NULL)
        );

        CREATE TABLE IF NOT EXISTS logical_call_settlement_crossings (
          session_id            TEXT NOT NULL,
          source_user_seq       INTEGER NOT NULL,
          logical_tool_call_id  TEXT NOT NULL,
          physical_dispatch_id  TEXT NOT NULL,
          ordinal               INTEGER NOT NULL CHECK (ordinal > 0),
          relation              TEXT NOT NULL
                                CHECK (relation IN ('primary','retry','poll','probe','child')),
          retry_of              TEXT,
          tool_name             TEXT NOT NULL,
          argument_digest       TEXT NOT NULL CHECK (length(argument_digest) = 64),
          PRIMARY KEY (
            session_id, source_user_seq,
            logical_tool_call_id, physical_dispatch_id
          ),
          UNIQUE (session_id, source_user_seq, logical_tool_call_id, ordinal),
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES logical_call_settlements(
              session_id, source_user_seq, logical_tool_call_id
            ) ON DELETE CASCADE,
          FOREIGN KEY (
            session_id, source_user_seq,
            logical_tool_call_id, physical_dispatch_id
          ) REFERENCES physical_dispatches(
            session_id, source_user_seq,
            logical_tool_call_id, physical_dispatch_id
          ) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS logical_call_progress_claims (
          session_id           TEXT NOT NULL,
          source_user_seq      INTEGER NOT NULL,
          progress_key_digest TEXT NOT NULL CHECK (length(progress_key_digest) = 64),
          logical_tool_call_id TEXT NOT NULL,
          claimed_at           TEXT NOT NULL,
          PRIMARY KEY (session_id, source_user_seq, progress_key_digest),
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES logical_call_settlements(
              session_id, source_user_seq, logical_tool_call_id
            ) ON DELETE CASCADE
        );

        CREATE TRIGGER IF NOT EXISTS trg_physical_dispatch_requires_open_logical
        BEFORE INSERT ON physical_dispatches
        WHEN NOT EXISTS (
          SELECT 1 FROM logical_tool_calls
           WHERE session_id = NEW.session_id
             AND source_user_seq = NEW.source_user_seq
             AND logical_tool_call_id = NEW.logical_tool_call_id
             AND accepted_task_id = NEW.accepted_task_id
             AND state = 'open'
        )
        BEGIN
          SELECT RAISE(ABORT, 'physical dispatch requires its exact open logical parent');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_physical_dispatch_identity_immutable
        BEFORE UPDATE OF accepted_task_id, logical_tool_call_id,
                         physical_dispatch_id, ordinal, relation, retry_of,
                         tool_name, argument_digest
        ON physical_dispatches
        WHEN OLD.accepted_task_id IS NOT NEW.accepted_task_id
          OR OLD.logical_tool_call_id IS NOT NEW.logical_tool_call_id
          OR OLD.physical_dispatch_id IS NOT NEW.physical_dispatch_id
          OR OLD.ordinal IS NOT NEW.ordinal
          OR OLD.relation IS NOT NEW.relation
          OR OLD.retry_of IS NOT NEW.retry_of
          OR OLD.tool_name IS NOT NEW.tool_name
          OR OLD.argument_digest IS NOT NEW.argument_digest
        BEGIN
          SELECT RAISE(ABORT, 'physical dispatch identity is immutable');
        END;
      `);
    },
  },
  {
    // Settlement is also the recovery linearization point. Keep the governor
    // decision beside the normalized call so a crash cannot durably settle a
    // failed candidate while losing the discovery epoch that makes recovery
    // possible (or credit a step without its one task-scoped progress claim).
    version: 25,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      if (!tables.has('logical_call_settlements')) {
        throw new Error('schema v25 prerequisite missing: logical_call_settlements');
      }
      const columns = new Set(
        (db.prepare('PRAGMA table_info(logical_call_settlements)').all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!columns.has('governor_evidence_kind')) {
        db.exec(`
          ALTER TABLE logical_call_settlements ADD COLUMN governor_evidence_kind TEXT
            CHECK (governor_evidence_kind IS NULL OR governor_evidence_kind IN (
              'candidate_unsupported','candidate_unavailable','catalog_revision_changed',
              'auth_recovered','capability_satisfied','user_input_provided'
            ));
          ALTER TABLE logical_call_settlements ADD COLUMN governor_evidence_detail TEXT;
          ALTER TABLE logical_call_settlements ADD COLUMN governor_requires_progress INTEGER NOT NULL DEFAULT 0
            CHECK (governor_requires_progress IN (0, 1));
          ALTER TABLE logical_call_settlements ADD COLUMN governor_outcome TEXT
            CHECK (governor_outcome IS NULL OR governor_outcome IN (
              'epoch_opened','epoch_already_fresh','epoch_ceiling_reached','task_not_initialized'
            ));
          ALTER TABLE logical_call_settlements ADD COLUMN opened_discovery_epoch INTEGER NOT NULL DEFAULT 0
            CHECK (opened_discovery_epoch IN (0, 1));
          ALTER TABLE logical_call_settlements ADD COLUMN credited_progress INTEGER NOT NULL DEFAULT 0
            CHECK (credited_progress IN (0, 1));
        `);
      }
    },
  },
  {
    // Per-accepted-source cutover state. Presence is not inferred from a
    // manifest: a source is explicitly armed before provider work, so losing a
    // later manifest can never fall through to legacy success. Manifest freeze,
    // repair grants, and terminal publication advance this row by CAS.
    version: 26,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      db.exec(`
        CREATE TABLE IF NOT EXISTS accepted_task_authority (
          session_id             TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          source_user_seq        INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id       TEXT NOT NULL UNIQUE,
          authority_protocol     INTEGER NOT NULL CHECK (authority_protocol = 1),
          graph_event_id         TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
          graph_id               TEXT NOT NULL,
          graph_hash             TEXT NOT NULL,
          state                  TEXT NOT NULL DEFAULT 'armed'
                                 CHECK (state IN ('armed','manifested_verifying','terminal','conflict')),
          manifest_id            TEXT,
          revision               INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
          repair_grants_used     INTEGER NOT NULL DEFAULT 0 CHECK (repair_grants_used BETWEEN 0 AND 1),
          repair_grant_id        TEXT,
          repair_grant_status    TEXT NOT NULL DEFAULT 'none'
                                 CHECK (repair_grant_status IN ('none','issued','consumed')),
          repair_grant_issued_at TEXT,
          repair_grant_consumed_at TEXT,
          terminal_event_id      TEXT REFERENCES events(id) ON DELETE RESTRICT,
          backstop_event_id      TEXT REFERENCES events(id) ON DELETE RESTRICT,
          armed_at               TEXT NOT NULL,
          updated_at             TEXT NOT NULL,
          PRIMARY KEY (session_id, source_user_seq),
          CHECK (
            (repair_grant_status = 'none' AND repair_grant_id IS NULL AND repair_grants_used = 0)
            OR
            (repair_grant_status IN ('issued','consumed') AND repair_grant_id IS NOT NULL AND repair_grants_used = 1)
          ),
          CHECK (state = 'armed' OR state = 'conflict' OR manifest_id IS NOT NULL)
        );

        CREATE INDEX IF NOT EXISTS idx_accepted_task_authority_state
          ON accepted_task_authority(state, updated_at);

        CREATE TRIGGER IF NOT EXISTS trg_accepted_task_authority_identity_immutable
        BEFORE UPDATE ON accepted_task_authority
        WHEN OLD.session_id IS NOT NEW.session_id
          OR OLD.source_user_seq IS NOT NEW.source_user_seq
          OR OLD.accepted_task_id IS NOT NEW.accepted_task_id
          OR OLD.authority_protocol IS NOT NEW.authority_protocol
          OR OLD.graph_event_id IS NOT NEW.graph_event_id
          OR OLD.graph_id IS NOT NEW.graph_id
          OR OLD.graph_hash IS NOT NEW.graph_hash
        BEGIN
          SELECT RAISE(ABORT, 'accepted task authority identity is immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_accepted_task_authority_state_machine
        BEFORE UPDATE OF state ON accepted_task_authority
        WHEN OLD.state IS NOT NEW.state AND NOT (
          (OLD.state = 'armed' AND NEW.state IN ('manifested_verifying','conflict'))
          OR (OLD.state = 'manifested_verifying' AND NEW.state IN ('terminal','conflict'))
        )
        BEGIN
          SELECT RAISE(ABORT, 'invalid accepted task authority transition');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_accepted_task_authority_grant_monotonic
        BEFORE UPDATE OF repair_grants_used ON accepted_task_authority
        WHEN NEW.repair_grants_used < OLD.repair_grants_used
          OR NEW.repair_grants_used > OLD.repair_grants_used + 1
        BEGIN
          SELECT RAISE(ABORT, 'terminal repair grant count is monotonic');
        END;
      `);
    },
  },
  {
    // Durable result authority. Provider payloads and opaque continuations used
    // to live in process-local Maps, so a restart made an apparently valid
    // handle irredeemable and removed the only host-side copy of its cursor.
    // Authoritative rows are tied to the exact accepted source, logical call,
    // physical crossing and canonical base call. A legacy-unscoped mode exists
    // only for projection helpers that have not entered a dispatch boundary;
    // those rows can never satisfy task-scoped redemption.
    version: 27,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'accepted_task_resolutions',
        'logical_tool_calls',
        'physical_dispatches',
      ]) {
        if (!tables.has(prerequisite)) {
          throw new Error(`schema v27 prerequisite missing: ${prerequisite}`);
        }
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS durable_result_handles (
          handle_id              TEXT PRIMARY KEY,
          scope_kind             TEXT NOT NULL
                                 CHECK (scope_kind IN ('authoritative','legacy_unscoped')),
          session_id             TEXT,
          source_user_seq        INTEGER,
          accepted_task_id       TEXT,
          logical_tool_call_id   TEXT,
          physical_dispatch_id   TEXT,
          continuation_chain_id  TEXT NOT NULL
                                 CHECK (length(continuation_chain_id) BETWEEN 1 AND 256),
          tool_name              TEXT NOT NULL,
          argument_digest        TEXT NOT NULL CHECK (length(argument_digest) = 64),
          base_argument_digest   TEXT NOT NULL CHECK (length(base_argument_digest) = 64),
          raw_location           TEXT UNIQUE,
          raw_payload_json       TEXT,
          raw_payload_sha256     TEXT CHECK (
                                   raw_payload_sha256 IS NULL OR length(raw_payload_sha256) = 64
                                 ),
          raw_byte_count         INTEGER NOT NULL CHECK (raw_byte_count >= 0),
          rejection_reason       TEXT CHECK (rejection_reason IN (
                                   'unserializable','oversized','cursor_oversized','raw_store_skipped'
                                 )),
          success                INTEGER NOT NULL CHECK (success IN (0, 1)),
          record_path            TEXT,
          record_count           INTEGER NOT NULL CHECK (record_count >= 0),
          envelope_meta_json     TEXT,
          completeness           TEXT NOT NULL CHECK (completeness IN ('complete','partial','unknown')),
          projected_records_json TEXT NOT NULL,
          status_code            INTEGER,
          continuation_ref       TEXT UNIQUE,
          cursor_bytes           BLOB,
          cursor_sha256          TEXT CHECK (cursor_sha256 IS NULL OR length(cursor_sha256) = 64),
          cursor_repeated        INTEGER NOT NULL DEFAULT 0 CHECK (cursor_repeated IN (0, 1)),
          created_at             TEXT NOT NULL,
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id, physical_dispatch_id)
            REFERENCES physical_dispatches(
              session_id, source_user_seq, logical_tool_call_id, physical_dispatch_id
            ) ON DELETE CASCADE,
          CHECK (
            (scope_kind = 'authoritative'
              AND session_id IS NOT NULL
              AND source_user_seq IS NOT NULL AND source_user_seq > 0
              AND accepted_task_id IS NOT NULL
              AND logical_tool_call_id IS NOT NULL
              AND physical_dispatch_id IS NOT NULL)
            OR
            (scope_kind = 'legacy_unscoped'
              AND session_id IS NULL
              AND source_user_seq IS NULL
              AND accepted_task_id IS NULL
              AND logical_tool_call_id IS NULL
              AND physical_dispatch_id IS NULL)
          ),
          CHECK (
            (raw_payload_json IS NOT NULL
              AND raw_location IS NOT NULL
              AND raw_payload_sha256 IS NOT NULL
              AND rejection_reason IS NULL)
            OR
            (raw_payload_json IS NULL
              AND raw_location IS NULL
              AND rejection_reason IS NOT NULL)
          ),
          CHECK (
            (continuation_ref IS NULL AND cursor_bytes IS NULL AND cursor_sha256 IS NULL
              AND cursor_repeated = 0)
            OR
            (continuation_ref IS NOT NULL AND cursor_bytes IS NOT NULL
              AND cursor_sha256 IS NOT NULL)
          )
        );

        CREATE UNIQUE INDEX IF NOT EXISTS uq_durable_result_physical
          ON durable_result_handles(
            session_id, source_user_seq, logical_tool_call_id, physical_dispatch_id
          )
          WHERE scope_kind = 'authoritative';

        CREATE INDEX IF NOT EXISTS idx_durable_result_cursor_history
          ON durable_result_handles(
            session_id, source_user_seq, continuation_chain_id,
            base_argument_digest, cursor_sha256, created_at
          )
          WHERE cursor_sha256 IS NOT NULL;

        CREATE TRIGGER IF NOT EXISTS trg_durable_result_exact_authority
        BEFORE INSERT ON durable_result_handles
        WHEN NEW.scope_kind = 'authoritative' AND NOT EXISTS (
          SELECT 1
            FROM physical_dispatches p
           WHERE p.session_id = NEW.session_id
             AND p.source_user_seq = NEW.source_user_seq
             AND p.accepted_task_id = NEW.accepted_task_id
             AND p.logical_tool_call_id = NEW.logical_tool_call_id
             AND p.physical_dispatch_id = NEW.physical_dispatch_id
             AND p.tool_name = NEW.tool_name
             AND p.argument_digest = NEW.argument_digest
             AND p.state = 'returned'
        )
        BEGIN
          SELECT RAISE(ABORT, 'durable result requires its exact returned physical crossing');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_durable_result_base_immutable
        BEFORE INSERT ON durable_result_handles
        WHEN NEW.scope_kind = 'authoritative' AND EXISTS (
          SELECT 1
            FROM durable_result_handles h
           WHERE h.scope_kind = 'authoritative'
             AND h.session_id = NEW.session_id
             AND h.source_user_seq = NEW.source_user_seq
             AND h.continuation_chain_id = NEW.continuation_chain_id
             AND (h.tool_name IS NOT NEW.tool_name
               OR h.base_argument_digest IS NOT NEW.base_argument_digest)
        )
        BEGIN
          SELECT RAISE(ABORT, 'durable result base call is immutable per logical call');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_durable_result_identity_immutable
        BEFORE UPDATE ON durable_result_handles
        BEGIN
          SELECT RAISE(ABORT, 'durable result handles are immutable');
        END;
      `);
    },
  },
  {
    // A logical invocation enters before policy and resolver gates with the
    // exact model/carrier arguments, but trusted host resolution may replace
    // references, remove routing-only metadata, or materialize strict nullable
    // fields before provider I/O. Preserve both value-opaque digests and allow
    // one monotonic raw -> effective transition before the first crossing.
    version: 28,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'accepted_task_resolutions',
        'logical_tool_calls',
        'physical_dispatches',
        'logical_call_settlements',
      ]) {
        if (!tables.has(prerequisite)) {
          throw new Error(`schema v28 prerequisite missing: ${prerequisite}`);
        }
      }
      const columns = new Set(
        (db.prepare('PRAGMA table_info(logical_tool_calls)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.has('raw_argument_digest')) {
        db.exec('ALTER TABLE logical_tool_calls ADD COLUMN raw_argument_digest TEXT');
      }
      if (!columns.has('effective_argument_digest')) {
        db.exec('ALTER TABLE logical_tool_calls ADD COLUMN effective_argument_digest TEXT');
      }
      if (!columns.has('refined_at')) {
        db.exec('ALTER TABLE logical_tool_calls ADD COLUMN refined_at TEXT');
      }
      if (!columns.has('refinement_event_id')) {
        db.exec(`ALTER TABLE logical_tool_calls ADD COLUMN refinement_event_id TEXT
          REFERENCES events(id) ON DELETE RESTRICT`);
      }
      db.exec(`
        UPDATE logical_tool_calls
           SET raw_argument_digest = argument_digest
         WHERE raw_argument_digest IS NULL;

        CREATE UNIQUE INDEX IF NOT EXISTS uq_logical_call_refinement_event
          ON logical_tool_calls(refinement_event_id)
          WHERE refinement_event_id IS NOT NULL;

        CREATE TRIGGER IF NOT EXISTS trg_logical_call_contract_insert_valid
        BEFORE INSERT ON logical_tool_calls
        WHEN NEW.raw_argument_digest IS NULL
          OR length(NEW.raw_argument_digest) != 64
          OR NEW.argument_digest IS NOT NEW.raw_argument_digest
          OR NEW.effective_argument_digest IS NOT NULL
          OR NEW.refined_at IS NOT NULL
          OR NEW.refinement_event_id IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'new logical call requires one exact raw contract');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_logical_call_contract_identity_immutable
        BEFORE UPDATE OF accepted_task_id, logical_tool_call_id, tool_name, raw_argument_digest
        ON logical_tool_calls
        WHEN OLD.accepted_task_id IS NOT NEW.accepted_task_id
          OR OLD.logical_tool_call_id IS NOT NEW.logical_tool_call_id
          OR OLD.tool_name IS NOT NEW.tool_name
          OR OLD.raw_argument_digest IS NOT NEW.raw_argument_digest
        BEGIN
          SELECT RAISE(ABORT, 'logical call raw contract identity is immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_logical_call_contract_refinement_once
        BEFORE UPDATE OF argument_digest, effective_argument_digest,
                         refined_at, refinement_event_id
        ON logical_tool_calls
        WHEN NOT (
          OLD.state = 'open'
          AND NEW.state = 'open'
          AND OLD.argument_digest = OLD.raw_argument_digest
          AND OLD.effective_argument_digest IS NULL
          AND OLD.refined_at IS NULL
          AND OLD.refinement_event_id IS NULL
          AND NEW.raw_argument_digest = OLD.raw_argument_digest
          AND NEW.effective_argument_digest IS NOT NULL
          AND length(NEW.effective_argument_digest) = 64
          AND NEW.argument_digest = NEW.effective_argument_digest
          AND NEW.argument_digest != NEW.raw_argument_digest
          AND NEW.refined_at IS NOT NULL
          AND NEW.refinement_event_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM accepted_task_resolutions r
             WHERE r.session_id = OLD.session_id
               AND r.source_user_seq = OLD.source_user_seq
               AND r.accepted_task_id = OLD.accepted_task_id
               AND r.state = 'open'
          )
          AND NOT EXISTS (
            SELECT 1 FROM physical_dispatches p
             WHERE p.session_id = OLD.session_id
               AND p.source_user_seq = OLD.source_user_seq
               AND p.logical_tool_call_id = OLD.logical_tool_call_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM logical_call_settlements s
             WHERE s.session_id = OLD.session_id
               AND s.source_user_seq = OLD.source_user_seq
               AND s.logical_tool_call_id = OLD.logical_tool_call_id
          )
        )
        BEGIN
          SELECT RAISE(ABORT, 'logical call contract refinement is not monotonic');
        END;
      `);
    },
  },
  {
    // Immutable expected-work authority for one exact accepted source.
    //
    // This is deliberately separate from accepted_task_operations: expected
    // work is fixed before business dispatch, while observed calls may only
    // discharge it later.  The nullable marker on accepted_task_authority is a
    // staged cutover — direct/retrieve turns can bind now, while action turns
    // remain on the existing runtime until the bounded planner seam exists.
    version: 29,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      if (!tables.has('accepted_task_authority')) {
        throw new Error('schema v29 prerequisite missing: accepted_task_authority');
      }
      const authorityColumns = new Set(
        (db.prepare('PRAGMA table_info(accepted_task_authority)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!authorityColumns.has('work_contract_id')) {
        db.exec('ALTER TABLE accepted_task_authority ADD COLUMN work_contract_id TEXT');
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS accepted_task_work_contracts (
          session_id         TEXT NOT NULL,
          source_user_seq    INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id   TEXT NOT NULL UNIQUE,
          contract_version   INTEGER NOT NULL CHECK (contract_version = 1),
          contract_id        TEXT NOT NULL UNIQUE CHECK (length(contract_id) = 81),
          graph_event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
          graph_id           TEXT NOT NULL,
          graph_hash         TEXT NOT NULL CHECK (length(graph_hash) = 64),
          planner_source     TEXT NOT NULL
                             CHECK (planner_source IN ('deterministic','structured_model')),
          contract_json      TEXT NOT NULL,
          operation_count    INTEGER NOT NULL CHECK (operation_count BETWEEN 0 AND 32),
          universe_count     INTEGER NOT NULL CHECK (universe_count BETWEEN 0 AND 16),
          fixed_at           TEXT NOT NULL,
          PRIMARY KEY (session_id, source_user_seq),
          FOREIGN KEY (session_id, source_user_seq)
            REFERENCES accepted_task_authority(session_id, source_user_seq)
            ON DELETE CASCADE
        );

        CREATE TRIGGER IF NOT EXISTS trg_accepted_task_work_contract_exact_authority
        BEFORE INSERT ON accepted_task_work_contracts
        WHEN NOT EXISTS (
          SELECT 1 FROM accepted_task_authority a
           WHERE a.session_id = NEW.session_id
             AND a.source_user_seq = NEW.source_user_seq
             AND a.accepted_task_id = NEW.accepted_task_id
             AND a.graph_event_id = NEW.graph_event_id
             AND a.graph_id = NEW.graph_id
             AND a.graph_hash = NEW.graph_hash
             AND a.state != 'conflict'
        )
        BEGIN
          SELECT RAISE(ABORT, 'expected-work contract requires its exact accepted authority');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_accepted_task_work_contracts_update_immutable
        BEFORE UPDATE ON accepted_task_work_contracts
        BEGIN
          SELECT RAISE(ABORT, 'accepted task work contracts are immutable');
        END;

        -- Do not block DELETE here: session retention owns parent cascades.
        -- A standalone deletion leaves the authority's immutable contract id
        -- behind, so rehydration fails closed and no replacement can bind.

        CREATE TRIGGER IF NOT EXISTS trg_accepted_task_authority_contract_binding
        BEFORE UPDATE OF work_contract_id ON accepted_task_authority
        WHEN (
          OLD.work_contract_id IS NOT NULL
          AND OLD.work_contract_id IS NOT NEW.work_contract_id
        ) OR (
          NEW.work_contract_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM accepted_task_work_contracts c
             WHERE c.session_id = NEW.session_id
               AND c.source_user_seq = NEW.source_user_seq
               AND c.accepted_task_id = NEW.accepted_task_id
               AND c.graph_event_id = NEW.graph_event_id
               AND c.graph_id = NEW.graph_id
               AND c.graph_hash = NEW.graph_hash
               AND c.contract_id = NEW.work_contract_id
          )
        )
        BEGIN
          SELECT RAISE(ABORT, 'accepted task work-contract binding is invalid or immutable');
        END;
      `);
    },
  },
  {
    // Host-issued evidence authority. A successful result becomes evidence
    // only when the logical settlement names the handle in the same commit;
    // finding a handle later beside a returned crossing is not proof that it
    // was the result which closed the call. Read receipts then bind that exact
    // settlement result to one manifest node and one declared obligation.
    version: 30,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'accepted_task_authority',
        'logical_tool_calls',
        'physical_dispatches',
        'logical_call_settlements',
        'logical_call_settlement_crossings',
        'durable_result_handles',
        'obligation_transitions',
      ]) {
        if (!tables.has(prerequisite)) {
          throw new Error(`schema v30 prerequisite missing: ${prerequisite}`);
        }
      }

      const settlementColumns = new Set(
        (db.prepare('PRAGMA table_info(logical_call_settlements)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!settlementColumns.has('result_handle_id')) {
        db.exec(`ALTER TABLE logical_call_settlements ADD COLUMN result_handle_id TEXT
          REFERENCES durable_result_handles(handle_id) ON DELETE RESTRICT`);
      }

      // Promote only rows whose immutable settlement mirror named the handle
      // and exact returned physical crossing at commit time. A plausible later
      // handle beside the same call remains null and therefore unredeemable.
      db.exec(`
        UPDATE logical_call_settlements AS s
           SET result_handle_id = (
             SELECT h.handle_id
               FROM events e
               JOIN durable_result_handles h
                 ON h.handle_id = json_extract(e.data_json, '$.resultHandleId')
               JOIN logical_tool_calls l
                 ON l.session_id = s.session_id
                AND l.source_user_seq = s.source_user_seq
                AND l.logical_tool_call_id = s.logical_tool_call_id
               JOIN physical_dispatches p
                 ON p.session_id = h.session_id
                AND p.source_user_seq = h.source_user_seq
                AND p.logical_tool_call_id = h.logical_tool_call_id
                AND p.physical_dispatch_id = h.physical_dispatch_id
              WHERE e.id = s.settlement_event_id
                AND e.session_id = s.session_id
                AND e.type = 'tool_attempt_settled'
                AND json_extract(e.data_json, '$.sourceUserSeq') = s.source_user_seq
                AND json_extract(e.data_json, '$.acceptedTaskId') = l.accepted_task_id
                AND json_extract(e.data_json, '$.logicalToolCallId') = s.logical_tool_call_id
                AND json_extract(e.data_json, '$.physicalDispatchId') = h.physical_dispatch_id
                AND h.scope_kind = 'authoritative'
                AND h.session_id = s.session_id
                AND h.source_user_seq = s.source_user_seq
                AND h.accepted_task_id = l.accepted_task_id
                AND h.logical_tool_call_id = s.logical_tool_call_id
                AND h.tool_name = l.tool_name
                AND h.argument_digest = l.argument_digest
                AND h.success = 1
                AND p.state = 'returned'
                AND p.ordinal = (
                  SELECT MAX(p2.ordinal) FROM physical_dispatches p2
                   WHERE p2.session_id = s.session_id
                     AND p2.source_user_seq = s.source_user_seq
                     AND p2.logical_tool_call_id = s.logical_tool_call_id
                )
              LIMIT 1
           )
         WHERE s.result_handle_id IS NULL
           AND s.execution_kind = 'provider_execution'
           AND s.outcome_kind IN ('succeeded','empty_result')
           AND EXISTS (
             SELECT 1 FROM events e
              WHERE e.id = s.settlement_event_id
                AND json_type(e.data_json, '$.resultHandleId') = 'text'
           );

        CREATE INDEX IF NOT EXISTS idx_logical_settlement_result_handle
          ON logical_call_settlements(result_handle_id)
          WHERE result_handle_id IS NOT NULL;

        CREATE TRIGGER IF NOT EXISTS trg_logical_settlement_result_required
        BEFORE INSERT ON logical_call_settlements
        WHEN (
          NEW.execution_kind = 'provider_execution'
          AND NEW.outcome_kind IN ('succeeded','empty_result')
          AND NEW.result_handle_id IS NULL
        ) OR (
          NOT (
            NEW.execution_kind = 'provider_execution'
            AND NEW.outcome_kind IN ('succeeded','empty_result')
          )
          AND NEW.result_handle_id IS NOT NULL
        )
        BEGIN
          SELECT RAISE(ABORT, 'logical settlement result-handle binding is inconsistent');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_logical_settlement_result_exact
        BEFORE INSERT ON logical_call_settlements
        WHEN NEW.result_handle_id IS NOT NULL AND NOT EXISTS (
          SELECT 1
            FROM durable_result_handles h
            JOIN logical_tool_calls l
              ON l.session_id = NEW.session_id
             AND l.source_user_seq = NEW.source_user_seq
             AND l.logical_tool_call_id = NEW.logical_tool_call_id
            JOIN physical_dispatches p
              ON p.session_id = h.session_id
             AND p.source_user_seq = h.source_user_seq
             AND p.logical_tool_call_id = h.logical_tool_call_id
             AND p.physical_dispatch_id = h.physical_dispatch_id
           WHERE h.handle_id = NEW.result_handle_id
             AND h.scope_kind = 'authoritative'
             AND h.session_id = NEW.session_id
             AND h.source_user_seq = NEW.source_user_seq
             AND h.accepted_task_id = l.accepted_task_id
             AND h.logical_tool_call_id = NEW.logical_tool_call_id
             AND h.tool_name = l.tool_name
             AND h.argument_digest = l.argument_digest
             AND h.success = 1
             AND p.state = 'returned'
             AND p.ordinal = (
               SELECT MAX(p2.ordinal) FROM physical_dispatches p2
                WHERE p2.session_id = NEW.session_id
                  AND p2.source_user_seq = NEW.source_user_seq
                  AND p2.logical_tool_call_id = NEW.logical_tool_call_id
             )
        )
        BEGIN
          SELECT RAISE(ABORT, 'logical settlement requires its exact returned result handle');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_logical_settlement_result_immutable
        BEFORE UPDATE OF result_handle_id ON logical_call_settlements
        WHEN OLD.result_handle_id IS NOT NEW.result_handle_id
        BEGIN
          SELECT RAISE(ABORT, 'logical settlement result handle is immutable');
        END;

        CREATE TABLE IF NOT EXISTS evidence_receipts (
          receipt_id             TEXT PRIMARY KEY,
          protocol_version       INTEGER NOT NULL CHECK (protocol_version = 1),
          semantic_digest        TEXT NOT NULL UNIQUE CHECK (length(semantic_digest) = 64),
          kind                   TEXT NOT NULL CHECK (kind IN ('observation','collection')),
          session_id             TEXT NOT NULL,
          source_user_seq        INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id       TEXT NOT NULL,
          manifest_id            TEXT NOT NULL,
          node_id                TEXT NOT NULL,
          obligation             TEXT NOT NULL CHECK (obligation IN ('source_observed','source_completeness')),
          logical_tool_call_id   TEXT NOT NULL,
          physical_dispatch_id   TEXT NOT NULL,
          result_handle_id       TEXT NOT NULL REFERENCES durable_result_handles(handle_id) ON DELETE RESTRICT,
          tool_name              TEXT NOT NULL,
          operation_mode         TEXT NOT NULL CHECK (operation_mode IN ('point_read','collection_read')),
          raw_payload_sha256     TEXT NOT NULL CHECK (length(raw_payload_sha256) = 64),
          raw_byte_count         INTEGER NOT NULL CHECK (raw_byte_count >= 0),
          record_identities_json TEXT NOT NULL,
          aggregate_digest       TEXT NOT NULL CHECK (length(aggregate_digest) = 64),
          completeness           TEXT NOT NULL CHECK (completeness IN ('complete','partial','unknown')),
          continuation_outstanding INTEGER NOT NULL CHECK (continuation_outstanding IN (0, 1)),
          cursor_repeated        INTEGER NOT NULL CHECK (cursor_repeated IN (0, 1)),
          receipt_event_id       TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
          issued_at              TEXT NOT NULL,
          UNIQUE (session_id, source_user_seq, manifest_id, node_id, obligation),
          FOREIGN KEY (session_id, source_user_seq)
            REFERENCES accepted_task_authority(session_id, source_user_seq) ON DELETE CASCADE,
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES logical_call_settlements(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS idx_evidence_receipts_task
          ON evidence_receipts(session_id, source_user_seq, manifest_id);

        CREATE TRIGGER IF NOT EXISTS trg_evidence_receipt_exact_authority
        BEFORE INSERT ON evidence_receipts
        WHEN NOT EXISTS (
          SELECT 1
            FROM accepted_task_authority a
            JOIN logical_call_settlements s
              ON s.session_id = a.session_id
             AND s.source_user_seq = a.source_user_seq
             AND s.logical_tool_call_id = NEW.logical_tool_call_id
            JOIN logical_tool_calls l
              ON l.session_id = s.session_id
             AND l.source_user_seq = s.source_user_seq
             AND l.logical_tool_call_id = s.logical_tool_call_id
            JOIN durable_result_handles h
              ON h.handle_id = s.result_handle_id
            JOIN events e
              ON e.id = NEW.receipt_event_id
           WHERE a.session_id = NEW.session_id
             AND a.source_user_seq = NEW.source_user_seq
             AND a.accepted_task_id = NEW.accepted_task_id
             AND a.manifest_id = NEW.manifest_id
             AND a.state = 'manifested_verifying'
             AND l.accepted_task_id = NEW.accepted_task_id
             AND l.state = 'settled'
             AND s.execution_kind = 'provider_execution'
             AND s.outcome_kind IN ('succeeded','empty_result')
             AND s.result_handle_id = NEW.result_handle_id
             AND h.scope_kind = 'authoritative'
             AND h.session_id = NEW.session_id
             AND h.source_user_seq = NEW.source_user_seq
             AND h.accepted_task_id = NEW.accepted_task_id
             AND h.logical_tool_call_id = NEW.logical_tool_call_id
             AND h.physical_dispatch_id = NEW.physical_dispatch_id
             AND h.tool_name = NEW.tool_name
             AND h.raw_payload_sha256 = NEW.raw_payload_sha256
             AND h.raw_byte_count = NEW.raw_byte_count
             AND h.success = 1
             AND e.session_id = NEW.session_id
             AND e.type = 'evidence_receipt'
             AND json_extract(e.data_json, '$.receiptId') = NEW.receipt_id
             AND json_extract(e.data_json, '$.sourceUserSeq') = NEW.source_user_seq
             AND json_extract(e.data_json, '$.acceptedTaskId') = NEW.accepted_task_id
             AND json_extract(e.data_json, '$.manifestId') = NEW.manifest_id
             AND json_extract(e.data_json, '$.nodeId') = NEW.node_id
             AND json_extract(e.data_json, '$.obligation') = NEW.obligation
             AND json_extract(e.data_json, '$.logicalToolCallId') = NEW.logical_tool_call_id
             AND json_extract(e.data_json, '$.physicalDispatchId') = NEW.physical_dispatch_id
             AND json_extract(e.data_json, '$.resultHandleId') = NEW.result_handle_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'evidence receipt requires exact manifested settlement authority');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_evidence_receipt_identity_immutable
        BEFORE UPDATE ON evidence_receipts
        BEGIN
          SELECT RAISE(ABORT, 'evidence receipts are immutable');
        END;
      `);
    },
  },
  {
    // A settlement is the normalized authority for outcome, requirement
    // routing, business-vs-discovery identity and continuation state. v30 made
    // its result-handle binding immutable; v31 closes the wider row so those
    // other fields cannot be rewritten beneath expected-work replay.
    version: 31,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      if (!tables.has('logical_call_settlements')) {
        throw new Error('schema v31 prerequisite missing: logical_call_settlements');
      }
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_logical_call_settlement_row_immutable
        BEFORE UPDATE ON logical_call_settlements
        BEGIN
          SELECT RAISE(ABORT, 'logical call settlements are immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_logical_call_settlement_delete_immutable
        BEFORE DELETE ON logical_call_settlements
        -- Parent session retention remains the one deletion authority. During
        -- its FK cascade the parent session row is already absent; a direct
        -- settlement/logical-call delete still sees the live parent and stops.
        WHEN EXISTS (
          SELECT 1 FROM sessions WHERE id = OLD.session_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'logical call settlements are immutable');
        END;
      `);
    },
  },
  {
    // Action expected-work admission. One immutable row binds an already-open,
    // zero-crossing logical call to the exact frozen semantic requirement it
    // is allowed to discharge. The same row carries the request-side witness
    // needed by read-evidence refinement; no parallel read authority exists.
    //
    // The two cleanup statements are deliberately parent-session based. A
    // live session may legitimately retain a historical run_attempt whose
    // source event was lost by an old/partial writer; that is degraded history,
    // not an orphan attempt. Only rows whose owning session is absent are
    // unreachable and safe to remove before foreign keys are relied upon.
    version: 32,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;

      if (tables.has('run_dispatch_leases')) {
        db.exec(`
          DELETE FROM run_dispatch_leases
           WHERE NOT EXISTS (
             SELECT 1 FROM sessions s WHERE s.id = run_dispatch_leases.session_id
           )
        `);
      }
      if (tables.has('run_attempts')) {
        db.exec(`
          DELETE FROM run_attempts
           WHERE NOT EXISTS (
             SELECT 1 FROM sessions s WHERE s.id = run_attempts.session_id
           )
        `);
      }

      for (const prerequisite of [
        'accepted_task_authority',
        'accepted_task_work_contracts',
        'logical_tool_calls',
        'physical_dispatches',
      ]) {
        if (!tables.has(prerequisite)) {
          throw new Error(`schema v32 prerequisite missing: ${prerequisite}`);
        }
      }

      const authorityColumns = new Set(
        (db.prepare('PRAGMA table_info(accepted_task_authority)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!authorityColumns.has('expected_work_required')) {
        db.exec(`ALTER TABLE accepted_task_authority
          ADD COLUMN expected_work_required INTEGER NOT NULL DEFAULT 0
          CHECK (expected_work_required IN (0, 1))`);
      }

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_accepted_task_expected_work_activation
        BEFORE UPDATE OF expected_work_required ON accepted_task_authority
        WHEN NOT (
          OLD.expected_work_required = NEW.expected_work_required
          OR (
            OLD.expected_work_required = 0
            AND NEW.expected_work_required = 1
            AND OLD.state = 'armed'
          )
        )
        BEGIN
          SELECT RAISE(ABORT, 'expected-work activation is one-way and requires armed authority');
        END;

        CREATE TABLE IF NOT EXISTS expected_work_call_bindings (
          session_id              TEXT NOT NULL,
          source_user_seq         INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id        TEXT NOT NULL,
          logical_tool_call_id    TEXT NOT NULL,
          contract_id             TEXT NOT NULL,
          requirement_id          TEXT NOT NULL,
          tool_name                TEXT NOT NULL,
          argument_digest          TEXT NOT NULL CHECK (length(argument_digest) = 64),
          effect_kind              TEXT NOT NULL
                                   CHECK (effect_kind IN ('read','compute','local_write','external_write','admin')),
          cardinality_kind         TEXT NOT NULL
                                   CHECK (cardinality_kind IN ('once','each','set')),
          universe_id              TEXT,
          universe_seal            TEXT
                                   CHECK (universe_seal IS NULL OR universe_seal IN ('accepted_input','complete_source_receipt')),
          universe_item_id         TEXT,
          universe_selector_json   TEXT,
          universe_member_digest   TEXT
                                   CHECK (universe_member_digest IS NULL OR length(universe_member_digest) = 64),
          universe_member_count    INTEGER
                                   CHECK (universe_member_count IS NULL OR universe_member_count > 0),
          input_source_kind        TEXT
                                   CHECK (input_source_kind IS NULL OR input_source_kind IN ('accepted_user_input','complete_source_receipt')),
          input_source_ref         TEXT,
          input_source_digest      TEXT
                                   CHECK (input_source_digest IS NULL OR length(input_source_digest) = 64),
          evidence_mode            TEXT
                                   CHECK (evidence_mode IS NULL OR evidence_mode IN ('point_read','collection_read','finite_read')),
          evidence_basis           TEXT,
          schema_fingerprint       TEXT,
          schema_digest            TEXT
                                   CHECK (schema_digest IS NULL OR length(schema_digest) = 64),
          bound_at                 TEXT NOT NULL,
          PRIMARY KEY (session_id, source_user_seq, logical_tool_call_id),
          FOREIGN KEY (session_id, source_user_seq)
            REFERENCES accepted_task_work_contracts(session_id, source_user_seq)
            ON DELETE CASCADE,
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES logical_tool_calls(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE CASCADE,
          FOREIGN KEY (contract_id)
            REFERENCES accepted_task_work_contracts(contract_id)
            ON DELETE RESTRICT,
          CHECK (
            (cardinality_kind = 'once'
              AND universe_id IS NULL
              AND universe_seal IS NULL
              AND universe_item_id IS NULL
              AND universe_selector_json IS NULL
              AND universe_member_digest IS NULL
              AND universe_member_count IS NULL
              AND input_source_kind IS NULL
              AND input_source_ref IS NULL
              AND input_source_digest IS NULL)
            OR
            (cardinality_kind = 'each'
              AND universe_id IS NOT NULL
              AND universe_seal IS NOT NULL
              AND universe_item_id IS NOT NULL
              AND universe_selector_json IS NOT NULL
              AND json_valid(universe_selector_json)
              AND json_type(universe_selector_json) = 'object'
              AND universe_member_digest IS NOT NULL
              AND universe_member_count = 1
              AND input_source_kind IS NOT NULL
              AND input_source_ref IS NOT NULL
              AND input_source_digest IS NOT NULL)
            OR
            (cardinality_kind = 'set'
              AND universe_id IS NOT NULL
              AND universe_seal IS NOT NULL
              AND universe_item_id IS NULL
              AND universe_selector_json IS NOT NULL
              AND json_valid(universe_selector_json)
              AND json_type(universe_selector_json) = 'object'
              AND universe_member_digest IS NOT NULL
              AND universe_member_count > 0
              AND input_source_kind IS NOT NULL
              AND input_source_ref IS NOT NULL
              AND input_source_digest IS NOT NULL)
          ),
          CHECK (
            (evidence_mode IS NULL AND evidence_basis IS NULL)
            OR (evidence_mode IS NOT NULL AND evidence_basis IS NOT NULL)
          ),
          CHECK (
            (schema_fingerprint IS NULL AND schema_digest IS NULL)
            OR (schema_fingerprint IS NOT NULL AND schema_digest IS NOT NULL)
          )
        );

        CREATE INDEX IF NOT EXISTS idx_expected_work_call_bindings_requirement
          ON expected_work_call_bindings(
            session_id, source_user_seq, requirement_id, universe_item_id
          );

        CREATE TRIGGER IF NOT EXISTS trg_expected_work_call_binding_exact_authority
        BEFORE INSERT ON expected_work_call_bindings
        WHEN NOT EXISTS (
          SELECT 1
            FROM accepted_task_authority a
            JOIN accepted_task_work_contracts c
              ON c.session_id = a.session_id
             AND c.source_user_seq = a.source_user_seq
            JOIN logical_tool_calls l
              ON l.session_id = a.session_id
             AND l.source_user_seq = a.source_user_seq
             AND l.logical_tool_call_id = NEW.logical_tool_call_id
           WHERE a.session_id = NEW.session_id
             AND a.source_user_seq = NEW.source_user_seq
             AND a.accepted_task_id = NEW.accepted_task_id
             AND a.expected_work_required = 1
             AND a.work_contract_id = NEW.contract_id
             AND a.state = 'armed'
             AND c.contract_id = NEW.contract_id
             AND l.accepted_task_id = NEW.accepted_task_id
             AND l.tool_name = NEW.tool_name
             AND l.argument_digest = NEW.argument_digest
             AND l.state = 'open'
             AND NOT EXISTS (
               SELECT 1 FROM physical_dispatches p
                WHERE p.session_id = l.session_id
                  AND p.source_user_seq = l.source_user_seq
                  AND p.logical_tool_call_id = l.logical_tool_call_id
             )
        )
        BEGIN
          SELECT RAISE(ABORT, 'expected-work call binding requires exact open zero-crossing authority');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_expected_work_call_bindings_update_immutable
        BEFORE UPDATE ON expected_work_call_bindings
        BEGIN
          SELECT RAISE(ABORT, 'expected-work call bindings are immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_expected_work_call_bindings_delete_immutable
        BEFORE DELETE ON expected_work_call_bindings
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'expected-work call bindings are immutable');
        END;
      `);
    },
  },
  {
    // Provider-neutral write proof authority.  The pre-dispatch binding is
    // intentionally independent of an obligation manifest: selectors and
    // projections must be fixed before provider I/O, while the authoritative
    // manifest is only available after observed resolution closes.  A later
    // content-addressed proof receipt binds the immutable call contract to the
    // exact manifest node without rewriting either artifact.
    //
    // This migration performs no historical promotion or broad cleanup.  Old
    // event prose and external-write rows do not contain the schema, target,
    // exact input, or crossing identity needed to manufacture v33 authority.
    version: 33,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'accepted_task_authority',
        'accepted_task_work_contracts',
        'expected_work_call_bindings',
        'logical_tool_calls',
        'physical_dispatches',
        'logical_call_settlements',
        'durable_result_handles',
        'obligation_transitions',
      ]) {
        if (!tables.has(prerequisite)) {
          throw new Error(`schema v33 prerequisite missing: ${prerequisite}`);
        }
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS write_evidence_bindings (
          binding_id                  TEXT PRIMARY KEY CHECK (length(binding_id) = 81),
          protocol_version            INTEGER NOT NULL CHECK (protocol_version = 1),
          semantic_digest             TEXT NOT NULL UNIQUE CHECK (length(semantic_digest) = 64),
          session_id                  TEXT NOT NULL,
          source_user_seq             INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id            TEXT NOT NULL,
          work_contract_id            TEXT NOT NULL,
          requirement_id              TEXT NOT NULL,
          logical_tool_call_id        TEXT NOT NULL,
          tool_name                   TEXT NOT NULL,
          argument_digest             TEXT NOT NULL CHECK (length(argument_digest) = 64),
          effect_kind                 TEXT NOT NULL CHECK (effect_kind IN ('external_write','admin')),
          reversibility               TEXT NOT NULL CHECK (reversibility IN ('reversible','irreversible')),
          target_selector_json        TEXT NOT NULL CHECK (
                                         json_valid(target_selector_json)
                                         AND json_type(target_selector_json) = 'array'
                                       ),
          target_digest               TEXT NOT NULL CHECK (length(target_digest) = 64),
          write_input_json            TEXT NOT NULL CHECK (json_valid(write_input_json)),
          write_input_digest          TEXT NOT NULL CHECK (length(write_input_digest) = 64),
          input_schema_json           TEXT NOT NULL CHECK (json_valid(input_schema_json)),
          source_requirement_ids_json TEXT NOT NULL CHECK (
                                         json_valid(source_requirement_ids_json)
                                         AND json_type(source_requirement_ids_json) = 'array'
                                       ),
          verification_json           TEXT NOT NULL CHECK (
                                         json_valid(verification_json)
                                         AND json_type(verification_json) = 'object'
                                       ),
          schema_digest               TEXT NOT NULL CHECK (length(schema_digest) = 64),
          mapping_digest              TEXT NOT NULL CHECK (length(mapping_digest) = 64),
          frozen_at                   TEXT NOT NULL,
          UNIQUE (session_id, source_user_seq, logical_tool_call_id),
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES expected_work_call_bindings(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE CASCADE,
          FOREIGN KEY (work_contract_id)
            REFERENCES accepted_task_work_contracts(contract_id) ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS idx_write_evidence_bindings_task
          ON write_evidence_bindings(session_id, source_user_seq, requirement_id);

        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_binding_exact_authority
        BEFORE INSERT ON write_evidence_bindings
        WHEN NOT EXISTS (
          SELECT 1
            FROM expected_work_call_bindings b
            JOIN accepted_task_authority a
              ON a.session_id = b.session_id
             AND a.source_user_seq = b.source_user_seq
            JOIN logical_tool_calls l
              ON l.session_id = b.session_id
             AND l.source_user_seq = b.source_user_seq
             AND l.logical_tool_call_id = b.logical_tool_call_id
           WHERE b.session_id = NEW.session_id
             AND b.source_user_seq = NEW.source_user_seq
             AND b.logical_tool_call_id = NEW.logical_tool_call_id
             AND b.accepted_task_id = NEW.accepted_task_id
             AND b.contract_id = NEW.work_contract_id
             AND b.requirement_id = NEW.requirement_id
             AND b.tool_name = NEW.tool_name
             AND b.argument_digest = NEW.argument_digest
             AND b.effect_kind = NEW.effect_kind
             AND a.accepted_task_id = NEW.accepted_task_id
             AND a.work_contract_id = NEW.work_contract_id
             AND a.expected_work_required = 1
             AND a.state = 'armed'
             AND l.accepted_task_id = NEW.accepted_task_id
             AND l.tool_name = NEW.tool_name
             AND l.argument_digest = NEW.argument_digest
             AND l.state = 'open'
             AND NOT EXISTS (
               SELECT 1 FROM physical_dispatches p
                WHERE p.session_id = NEW.session_id
                  AND p.source_user_seq = NEW.source_user_seq
                  AND p.logical_tool_call_id = NEW.logical_tool_call_id
             )
        )
        BEGIN
          SELECT RAISE(ABORT, 'write evidence binding requires exact pre-dispatch work authority');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_bindings_update_immutable
        BEFORE UPDATE ON write_evidence_bindings
        BEGIN
          SELECT RAISE(ABORT, 'write evidence bindings are immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_bindings_delete_immutable
        BEFORE DELETE ON write_evidence_bindings
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'write evidence bindings are immutable');
        END;

        CREATE TABLE IF NOT EXISTS write_evidence_dispatch_reservations (
          reservation_id       TEXT PRIMARY KEY CHECK (length(reservation_id) = 85),
          binding_id           TEXT NOT NULL REFERENCES write_evidence_bindings(binding_id) ON DELETE CASCADE,
          session_id           TEXT NOT NULL,
          source_user_seq      INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id     TEXT NOT NULL,
          logical_tool_call_id TEXT NOT NULL,
          physical_dispatch_id TEXT NOT NULL,
          ordinal              INTEGER NOT NULL CHECK (ordinal > 0),
          target_digest        TEXT NOT NULL CHECK (length(target_digest) = 64),
          write_input_digest   TEXT NOT NULL CHECK (length(write_input_digest) = 64),
          reserved_at          TEXT NOT NULL,
          UNIQUE (session_id, source_user_seq, physical_dispatch_id),
          UNIQUE (binding_id, ordinal),
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES logical_tool_calls(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE CASCADE
        );

        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_reservation_exact_binding
        BEFORE INSERT ON write_evidence_dispatch_reservations
        WHEN NOT EXISTS (
          SELECT 1 FROM write_evidence_bindings b
           WHERE b.binding_id = NEW.binding_id
             AND b.session_id = NEW.session_id
             AND b.source_user_seq = NEW.source_user_seq
             AND b.accepted_task_id = NEW.accepted_task_id
             AND b.logical_tool_call_id = NEW.logical_tool_call_id
             AND b.target_digest = NEW.target_digest
             AND b.write_input_digest = NEW.write_input_digest
        )
        BEGIN
          SELECT RAISE(ABORT, 'write reservation conflicts with its frozen binding');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_bound_write_dispatch_requires_reservation
        BEFORE INSERT ON physical_dispatches
        WHEN EXISTS (
          SELECT 1 FROM write_evidence_bindings b
           WHERE b.session_id = NEW.session_id
             AND b.source_user_seq = NEW.source_user_seq
             AND b.logical_tool_call_id = NEW.logical_tool_call_id
        ) AND NOT EXISTS (
          SELECT 1
            FROM write_evidence_dispatch_reservations r
            JOIN write_evidence_bindings b ON b.binding_id = r.binding_id
           WHERE r.session_id = NEW.session_id
             AND r.source_user_seq = NEW.source_user_seq
             AND r.accepted_task_id = NEW.accepted_task_id
             AND r.logical_tool_call_id = NEW.logical_tool_call_id
             AND r.physical_dispatch_id = NEW.physical_dispatch_id
             AND r.ordinal = NEW.ordinal
             AND b.tool_name = NEW.tool_name
             AND b.argument_digest = NEW.argument_digest
        )
        BEGIN
          SELECT RAISE(ABORT, 'bound write dispatch requires an atomic reservation');
        END;

        CREATE TABLE IF NOT EXISTS write_evidence_dispatch_outcomes (
          outcome_id            TEXT PRIMARY KEY CHECK (length(outcome_id) = 81),
          reservation_id        TEXT NOT NULL UNIQUE
                                REFERENCES write_evidence_dispatch_reservations(reservation_id)
                                ON DELETE CASCADE,
          binding_id            TEXT NOT NULL REFERENCES write_evidence_bindings(binding_id) ON DELETE CASCADE,
          session_id            TEXT NOT NULL,
          source_user_seq       INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id      TEXT NOT NULL,
          logical_tool_call_id  TEXT NOT NULL,
          physical_dispatch_id  TEXT NOT NULL,
          kind                  TEXT NOT NULL CHECK (kind IN ('succeeded','failed','orphaned')),
          result_handle_id      TEXT REFERENCES durable_result_handles(handle_id) ON DELETE RESTRICT,
          settlement_event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
          target_digest         TEXT NOT NULL CHECK (length(target_digest) = 64),
          write_input_digest    TEXT NOT NULL CHECK (length(write_input_digest) = 64),
          recorded_at           TEXT NOT NULL,
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES logical_call_settlements(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE RESTRICT,
          CHECK ((kind = 'succeeded' AND result_handle_id IS NOT NULL)
              OR (kind != 'succeeded' AND result_handle_id IS NULL))
        );

        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_outcome_exact_authority
        BEFORE INSERT ON write_evidence_dispatch_outcomes
        WHEN NOT EXISTS (
          SELECT 1
            FROM write_evidence_dispatch_reservations r
            JOIN write_evidence_bindings b ON b.binding_id = r.binding_id
            JOIN logical_call_settlements s
              ON s.session_id = r.session_id
             AND s.source_user_seq = r.source_user_seq
             AND s.logical_tool_call_id = r.logical_tool_call_id
            JOIN physical_dispatches p
              ON p.session_id = r.session_id
             AND p.source_user_seq = r.source_user_seq
             AND p.logical_tool_call_id = r.logical_tool_call_id
             AND p.physical_dispatch_id = r.physical_dispatch_id
           WHERE r.reservation_id = NEW.reservation_id
             AND r.binding_id = NEW.binding_id
             AND r.session_id = NEW.session_id
             AND r.source_user_seq = NEW.source_user_seq
             AND r.accepted_task_id = NEW.accepted_task_id
             AND r.logical_tool_call_id = NEW.logical_tool_call_id
             AND r.physical_dispatch_id = NEW.physical_dispatch_id
             AND r.target_digest = NEW.target_digest
             AND r.write_input_digest = NEW.write_input_digest
             AND s.settlement_event_id = NEW.settlement_event_id
             AND p.state != 'started'
             AND (
               (NEW.kind = 'succeeded'
                 AND p.state = 'returned'
                 AND s.execution_kind = 'provider_execution'
                 AND s.outcome_kind IN ('succeeded','empty_result')
                 AND s.result_handle_id = NEW.result_handle_id
                 AND EXISTS (
                   SELECT 1 FROM durable_result_handles h
                    WHERE h.handle_id = NEW.result_handle_id
                      AND h.session_id = NEW.session_id
                      AND h.source_user_seq = NEW.source_user_seq
                      AND h.accepted_task_id = NEW.accepted_task_id
                      AND h.logical_tool_call_id = NEW.logical_tool_call_id
                      AND h.physical_dispatch_id = NEW.physical_dispatch_id
                 ))
               OR
               (NEW.kind != 'succeeded'
                 AND s.outcome_kind NOT IN ('succeeded','empty_result'))
             )
        )
        BEGIN
          SELECT RAISE(ABORT, 'write outcome conflicts with reservation, settlement, or result');
        END;

        CREATE TABLE IF NOT EXISTS write_evidence_readback_bindings (
          readback_binding_id      TEXT PRIMARY KEY CHECK (length(readback_binding_id) = 90),
          binding_id               TEXT NOT NULL REFERENCES write_evidence_bindings(binding_id) ON DELETE CASCADE,
          session_id               TEXT NOT NULL,
          source_user_seq          INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id         TEXT NOT NULL,
          work_contract_id         TEXT NOT NULL,
          write_requirement_id     TEXT NOT NULL,
          read_requirement_id      TEXT NOT NULL,
          read_logical_tool_call_id TEXT NOT NULL,
          read_tool_name           TEXT NOT NULL,
          read_argument_digest     TEXT NOT NULL CHECK (length(read_argument_digest) = 64),
          target_selector_json     TEXT NOT NULL CHECK (
                                     json_valid(target_selector_json)
                                     AND json_type(target_selector_json) = 'array'
                                   ),
          target_digest            TEXT NOT NULL CHECK (length(target_digest) = 64),
          schema_digest            TEXT NOT NULL CHECK (length(schema_digest) = 64),
          verification_contract_id TEXT NOT NULL,
          frozen_at                TEXT NOT NULL,
          UNIQUE (binding_id, read_logical_tool_call_id),
          FOREIGN KEY (session_id, source_user_seq, read_logical_tool_call_id)
            REFERENCES expected_work_call_bindings(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE CASCADE
        );

        CREATE TRIGGER IF NOT EXISTS trg_write_readback_exact_authority
        BEFORE INSERT ON write_evidence_readback_bindings
        WHEN NOT EXISTS (
          SELECT 1
            FROM write_evidence_bindings w
            JOIN expected_work_call_bindings r
              ON r.session_id = w.session_id
             AND r.source_user_seq = w.source_user_seq
             AND r.logical_tool_call_id = NEW.read_logical_tool_call_id
            JOIN logical_tool_calls l
              ON l.session_id = r.session_id
             AND l.source_user_seq = r.source_user_seq
             AND l.logical_tool_call_id = r.logical_tool_call_id
           WHERE w.binding_id = NEW.binding_id
             AND w.session_id = NEW.session_id
             AND w.source_user_seq = NEW.source_user_seq
             AND w.accepted_task_id = NEW.accepted_task_id
             AND w.work_contract_id = NEW.work_contract_id
             AND w.requirement_id = NEW.write_requirement_id
             AND w.target_digest = NEW.target_digest
             AND w.binding_id = NEW.verification_contract_id
             AND r.accepted_task_id = NEW.accepted_task_id
             AND r.contract_id = NEW.work_contract_id
             AND r.requirement_id = NEW.read_requirement_id
             AND r.effect_kind = 'read'
             AND r.tool_name = NEW.read_tool_name
             AND r.argument_digest = NEW.read_argument_digest
             AND l.state = 'open'
             AND NOT EXISTS (
               SELECT 1 FROM physical_dispatches p
                WHERE p.session_id = NEW.session_id
                  AND p.source_user_seq = NEW.source_user_seq
                  AND p.logical_tool_call_id = NEW.read_logical_tool_call_id
             )
        )
        BEGIN
          SELECT RAISE(ABORT, 'readback binding requires exact pre-dispatch read authority');
        END;

        CREATE TABLE IF NOT EXISTS write_evidence_derivations (
          derivation_id             TEXT PRIMARY KEY CHECK (length(derivation_id) = 84),
          binding_id                TEXT NOT NULL UNIQUE REFERENCES write_evidence_bindings(binding_id) ON DELETE CASCADE,
          session_id                TEXT NOT NULL,
          source_user_seq           INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id          TEXT NOT NULL,
          work_contract_id          TEXT NOT NULL,
          requirement_id            TEXT NOT NULL,
          output_digest             TEXT NOT NULL CHECK (length(output_digest) = 64),
          transform_artifact_digest TEXT NOT NULL CHECK (length(transform_artifact_digest) = 64),
          source_count              INTEGER NOT NULL CHECK (source_count > 0),
          semantic_digest           TEXT NOT NULL UNIQUE CHECK (length(semantic_digest) = 64),
          recorded_at               TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS write_evidence_derivation_sources (
          derivation_id         TEXT NOT NULL REFERENCES write_evidence_derivations(derivation_id) ON DELETE CASCADE,
          session_id            TEXT NOT NULL,
          source_user_seq       INTEGER NOT NULL CHECK (source_user_seq > 0),
          requirement_id        TEXT NOT NULL,
          logical_tool_call_id  TEXT NOT NULL,
          result_handle_id      TEXT NOT NULL REFERENCES durable_result_handles(handle_id) ON DELETE RESTRICT,
          content_digest        TEXT NOT NULL CHECK (length(content_digest) = 64),
          PRIMARY KEY (derivation_id, requirement_id),
          UNIQUE (derivation_id, logical_tool_call_id),
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES logical_call_settlements(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS write_evidence_execution_snapshots (
          snapshot_id          TEXT PRIMARY KEY CHECK (length(snapshot_id) = 82),
          binding_id           TEXT NOT NULL UNIQUE REFERENCES write_evidence_bindings(binding_id) ON DELETE CASCADE,
          session_id           TEXT NOT NULL,
          source_user_seq      INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id     TEXT NOT NULL,
          executions_json      TEXT NOT NULL CHECK (
                                 json_valid(executions_json)
                                 AND json_type(executions_json) = 'array'
                               ),
          opened_ids_json      TEXT NOT NULL CHECK (
                                 json_valid(opened_ids_json)
                                 AND json_type(opened_ids_json) = 'array'
                               ),
          semantic_digest      TEXT NOT NULL UNIQUE CHECK (length(semantic_digest) = 64),
          recorded_at          TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS write_evidence_proofs (
          proof_id                   TEXT PRIMARY KEY CHECK (length(proof_id) = 82),
          protocol_version           INTEGER NOT NULL CHECK (protocol_version = 1),
          binding_id                 TEXT NOT NULL REFERENCES write_evidence_bindings(binding_id) ON DELETE RESTRICT,
          session_id                 TEXT NOT NULL,
          source_user_seq            INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id           TEXT NOT NULL,
          work_contract_id           TEXT NOT NULL,
          manifest_id                TEXT NOT NULL,
          node_id                    TEXT NOT NULL,
          requirement_id             TEXT NOT NULL,
          obligation                 TEXT NOT NULL CHECK (obligation IN (
                                             'derivation_from_current_source','commit_effect',
                                             'verify_committed_readback','stale_destination_reconciled',
                                             'verify_committed_receipt','execution_terminal'
                                           )),
          logical_tool_call_id       TEXT NOT NULL,
          anchor_physical_dispatch_id TEXT NOT NULL,
          target_digest              TEXT NOT NULL CHECK (length(target_digest) = 64),
          physical_dispatch_ids_json TEXT NOT NULL CHECK (
                                         json_valid(physical_dispatch_ids_json)
                                         AND json_type(physical_dispatch_ids_json) = 'array'
                                       ),
          evidence_digests_json      TEXT NOT NULL CHECK (
                                         json_valid(evidence_digests_json)
                                         AND json_type(evidence_digests_json) = 'array'
                                       ),
          proof_json                 TEXT NOT NULL CHECK (
                                         json_valid(proof_json)
                                         AND json_type(proof_json) = 'object'
                                       ),
          receipt_event_id           TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
          issued_at                  TEXT NOT NULL,
          UNIQUE (session_id, source_user_seq, manifest_id, node_id, obligation),
          FOREIGN KEY (session_id, source_user_seq)
            REFERENCES accepted_task_authority(session_id, source_user_seq) ON DELETE CASCADE,
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id, anchor_physical_dispatch_id)
            REFERENCES physical_dispatches(
              session_id, source_user_seq, logical_tool_call_id, physical_dispatch_id
            ) ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS idx_write_evidence_proofs_task
          ON write_evidence_proofs(session_id, source_user_seq, manifest_id);

        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_proof_exact_authority
        BEFORE INSERT ON write_evidence_proofs
        WHEN NOT EXISTS (
          SELECT 1
            FROM write_evidence_bindings b
            JOIN accepted_task_authority a
              ON a.session_id = b.session_id
             AND a.source_user_seq = b.source_user_seq
            JOIN events e ON e.id = NEW.receipt_event_id
           WHERE b.binding_id = NEW.binding_id
             AND b.session_id = NEW.session_id
             AND b.source_user_seq = NEW.source_user_seq
             AND b.accepted_task_id = NEW.accepted_task_id
             AND b.work_contract_id = NEW.work_contract_id
             AND b.requirement_id = NEW.requirement_id
             AND b.logical_tool_call_id = NEW.logical_tool_call_id
             AND b.target_digest = NEW.target_digest
             AND a.accepted_task_id = NEW.accepted_task_id
             AND a.work_contract_id = NEW.work_contract_id
             AND a.manifest_id = NEW.manifest_id
             AND a.state = 'manifested_verifying'
             AND e.session_id = NEW.session_id
             AND e.type = 'write_evidence_proved'
             AND json_extract(e.data_json, '$.proofId') = NEW.proof_id
             AND json_extract(e.data_json, '$.sourceUserSeq') = NEW.source_user_seq
             AND json_extract(e.data_json, '$.acceptedTaskId') = NEW.accepted_task_id
             AND json_extract(e.data_json, '$.manifestId') = NEW.manifest_id
             AND json_extract(e.data_json, '$.nodeId') = NEW.node_id
             AND json_extract(e.data_json, '$.obligation') = NEW.obligation
        )
        BEGIN
          SELECT RAISE(ABORT, 'write proof requires exact manifested authority and event mirror');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_normalized_rows_immutable
        BEFORE UPDATE ON write_evidence_dispatch_reservations
        BEGIN SELECT RAISE(ABORT, 'write evidence reservations are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_outcomes_immutable
        BEFORE UPDATE ON write_evidence_dispatch_outcomes
        BEGIN SELECT RAISE(ABORT, 'write evidence outcomes are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_readbacks_immutable
        BEFORE UPDATE ON write_evidence_readback_bindings
        BEGIN SELECT RAISE(ABORT, 'write evidence readback bindings are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_derivations_immutable
        BEFORE UPDATE ON write_evidence_derivations
        BEGIN SELECT RAISE(ABORT, 'write evidence derivations are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_derivation_sources_immutable
        BEFORE UPDATE ON write_evidence_derivation_sources
        BEGIN SELECT RAISE(ABORT, 'write evidence derivation sources are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_execution_snapshots_immutable
        BEFORE UPDATE ON write_evidence_execution_snapshots
        BEGIN SELECT RAISE(ABORT, 'write evidence execution snapshots are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_proofs_immutable
        BEFORE UPDATE ON write_evidence_proofs
        BEGIN SELECT RAISE(ABORT, 'write evidence proofs are immutable'); END;

        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_reservations_delete_immutable
        BEFORE DELETE ON write_evidence_dispatch_reservations
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'write evidence reservations are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_outcomes_delete_immutable
        BEFORE DELETE ON write_evidence_dispatch_outcomes
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'write evidence outcomes are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_readbacks_delete_immutable
        BEFORE DELETE ON write_evidence_readback_bindings
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'write evidence readback bindings are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_derivations_delete_immutable
        BEFORE DELETE ON write_evidence_derivations
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'write evidence derivations are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_derivation_sources_delete_immutable
        BEFORE DELETE ON write_evidence_derivation_sources
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'write evidence derivation sources are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_execution_snapshots_delete_immutable
        BEFORE DELETE ON write_evidence_execution_snapshots
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'write evidence execution snapshots are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_proofs_delete_immutable
        BEFORE DELETE ON write_evidence_proofs
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'write evidence proofs are immutable'); END;
      `);
    },
  },
  {
    // Exact host completion authority for acknowledgement-only durable-memory
    // actions. The normalized receipt is independent of provider prose and is
    // bound to one accepted source, graph, memory episode, intake call, and
    // candidate-row digest. Historical telemetry is deliberately not
    // backfilled: it lacks enough evidence to manufacture this authority.
    version: 34,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      if (!tables.has('accepted_task_authority')) {
        throw new Error('schema v34 prerequisite missing: accepted_task_authority');
      }
      const authorityColumns = new Set(
        (db.prepare('PRAGMA table_info(accepted_task_authority)').all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!authorityColumns.has('host_completion_receipt_id')) {
        db.exec('ALTER TABLE accepted_task_authority ADD COLUMN host_completion_receipt_id TEXT');
      }
      if (!authorityColumns.has('host_completion_event_id')) {
        db.exec('ALTER TABLE accepted_task_authority ADD COLUMN host_completion_event_id TEXT REFERENCES events(id) ON DELETE RESTRICT');
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS durable_memory_intake_receipts (
          receipt_id             TEXT PRIMARY KEY
                                 CHECK (length(receipt_id) = 81 AND receipt_id LIKE 'memory-intake:v1:%'),
          protocol_version       INTEGER NOT NULL CHECK (protocol_version = 1),
          session_id             TEXT NOT NULL,
          source_user_seq        INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id       TEXT NOT NULL,
          graph_event_id         TEXT NOT NULL,
          graph_id               TEXT NOT NULL,
          graph_hash             TEXT NOT NULL CHECK (length(graph_hash) = 64),
          source_event_id        TEXT NOT NULL,
          source_message_digest  TEXT NOT NULL CHECK (length(source_message_digest) = 64),
          episode_id             TEXT NOT NULL,
          call_id                TEXT NOT NULL,
          episode_content_hash   TEXT NOT NULL CHECK (length(episode_content_hash) = 64),
          candidate_count        INTEGER NOT NULL CHECK (candidate_count > 0 AND candidate_count <= 3),
          candidate_digest       TEXT NOT NULL CHECK (length(candidate_digest) = 64),
          evidence_digest        TEXT NOT NULL CHECK (length(evidence_digest) = 64),
          receipt_json           TEXT NOT NULL CHECK (
                                   json_valid(receipt_json)
                                   AND json_type(receipt_json) = 'object'
                                 ),
          receipt_event_id       TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
          issued_at              TEXT NOT NULL,
          UNIQUE (session_id, source_user_seq),
          FOREIGN KEY (session_id, source_user_seq)
            REFERENCES accepted_task_authority(session_id, source_user_seq) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_durable_memory_intake_receipt_task
          ON durable_memory_intake_receipts(accepted_task_id);

        CREATE TRIGGER IF NOT EXISTS trg_durable_memory_intake_receipt_exact_authority
        BEFORE INSERT ON durable_memory_intake_receipts
        WHEN NOT EXISTS (
          SELECT 1
            FROM accepted_task_authority a
            JOIN events e ON e.id = NEW.receipt_event_id
           WHERE a.session_id = NEW.session_id
             AND a.source_user_seq = NEW.source_user_seq
             AND a.accepted_task_id = NEW.accepted_task_id
             AND a.graph_event_id = NEW.graph_event_id
             AND a.graph_id = NEW.graph_id
             AND a.graph_hash = NEW.graph_hash
             AND a.state = 'armed'
             AND a.expected_work_required = 1
             AND a.work_contract_id IS NULL
             AND a.host_completion_receipt_id IS NULL
             AND e.session_id = NEW.session_id
             AND e.type = 'durable_memory_intake_receipt'
             AND json_extract(e.data_json, '$.receiptId') = NEW.receipt_id
             AND json_extract(e.data_json, '$.sourceUserSeq') = NEW.source_user_seq
             AND json_extract(e.data_json, '$.acceptedTaskId') = NEW.accepted_task_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'durable memory receipt requires exact armed host authority');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_durable_memory_intake_receipts_update_immutable
        BEFORE UPDATE ON durable_memory_intake_receipts
        BEGIN
          SELECT RAISE(ABORT, 'durable memory intake receipts are immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_durable_memory_intake_receipts_delete_immutable
        BEFORE DELETE ON durable_memory_intake_receipts
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'durable memory intake receipts are immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_accepted_task_host_completion_monotonic
        BEFORE UPDATE OF host_completion_receipt_id, host_completion_event_id
        ON accepted_task_authority
        WHEN (OLD.host_completion_receipt_id IS NOT NULL
              AND OLD.host_completion_receipt_id IS NOT NEW.host_completion_receipt_id)
          OR (OLD.host_completion_event_id IS NOT NULL
              AND OLD.host_completion_event_id IS NOT NEW.host_completion_event_id)
          OR (NEW.host_completion_receipt_id IS NULL) IS NOT (NEW.host_completion_event_id IS NULL)
          OR (NEW.host_completion_receipt_id IS NOT NULL AND (
            NEW.work_contract_id IS NOT NULL
            OR NEW.manifest_id IS NOT NEW.host_completion_receipt_id
            OR NEW.backstop_event_id IS NOT NEW.host_completion_event_id
            OR NEW.state NOT IN ('manifested_verifying','terminal')
          ))
          OR (NEW.host_completion_receipt_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM durable_memory_intake_receipts r
             WHERE r.receipt_id = NEW.host_completion_receipt_id
               AND r.receipt_event_id = NEW.host_completion_event_id
               AND r.session_id = NEW.session_id
               AND r.source_user_seq = NEW.source_user_seq
               AND r.accepted_task_id = NEW.accepted_task_id
               AND r.graph_event_id = NEW.graph_event_id
               AND r.graph_id = NEW.graph_id
               AND r.graph_hash = NEW.graph_hash
          ))
        BEGIN
          SELECT RAISE(ABORT, 'accepted task host-completion binding is not exact or monotonic');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_accepted_task_host_terminal_exact
        BEFORE UPDATE OF state ON accepted_task_authority
        WHEN OLD.host_completion_receipt_id IS NOT NULL
          AND NEW.state = 'terminal'
          AND NOT EXISTS (
            SELECT 1
              FROM durable_memory_intake_receipts r
              JOIN events receipt_event ON receipt_event.id = r.receipt_event_id
              JOIN events terminal_event ON terminal_event.id = NEW.terminal_event_id
             WHERE r.receipt_id = OLD.host_completion_receipt_id
               AND r.receipt_event_id = OLD.host_completion_event_id
               AND r.session_id = NEW.session_id
               AND r.source_user_seq = NEW.source_user_seq
               AND r.accepted_task_id = NEW.accepted_task_id
               AND r.graph_event_id = NEW.graph_event_id
               AND r.graph_id = NEW.graph_id
               AND r.graph_hash = NEW.graph_hash
               AND NEW.manifest_id = r.receipt_id
               AND NEW.backstop_event_id = r.receipt_event_id
               AND NEW.work_contract_id IS NULL
               AND receipt_event.session_id = NEW.session_id
               AND receipt_event.type = 'durable_memory_intake_receipt'
               AND terminal_event.session_id = NEW.session_id
               AND terminal_event.type = 'conversation_completed'
               AND COALESCE(
                 json_extract(terminal_event.data_json, '$.sourceUserSeq'),
                 json_extract(terminal_event.data_json, '$.presentation.identity.sourceUserSeq')
               ) = NEW.source_user_seq
          )
        BEGIN
          SELECT RAISE(ABORT, 'host-completed terminal requires its exact receipt and terminal event');
        END;
      `);
    },
  },
  {
    // The host's own in-process execution is a crossing too.
    //
    // Evidence redemption, dependency discharge and terminal projection all
    // key on a physical dispatch, so work the host ran itself produced no
    // evidence at all and no contract naming a local read or local_write
    // could ever be proved (live 2026-08-11: a contracted local source read
    // settled with zero dispatches, zero handles, zero operations).
    //
    // Recording those crossings makes them provable, and this column keeps the
    // table honest about which ones left the machine — a paid provider call
    // and a filesystem write must stay distinguishable to anything that counts
    // crossings. Deliberately an ADD COLUMN, not a widened relation CHECK:
    // three tables carry foreign keys into physical_dispatches, so the table
    // rebuild a CHECK change requires would put those references and a live
    // multi-hundred-megabyte store at risk for a label. NULL means what it has
    // always meant — a crossing that left the process.
    version: 35,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('physical_dispatches')) return;
      const columns = new Set(
        (db.prepare('PRAGMA table_info(physical_dispatches)').all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!columns.has('execution_site')) {
        db.exec('ALTER TABLE physical_dispatches ADD COLUMN execution_site TEXT');
      }
      if (!tables.has('logical_call_settlements')) return;
      // physical_crossing_count keeps its exact meaning — crossings that LEFT
      // the machine, which is what a CHECK on that table and anything counting
      // paid work rely on. The host's own in-process crossings are counted
      // separately so the settlement can still bind every crossing it froze
      // without inflating what looks like provider traffic. NULL reads as zero.
      const settlementColumns = new Set(
        (db.prepare('PRAGMA table_info(logical_call_settlements)').all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!settlementColumns.has('host_crossing_count')) {
        db.exec('ALTER TABLE logical_call_settlements ADD COLUMN host_crossing_count INTEGER');
      }
      // Poisoning a logical call without recording WHY costs the diagnosis:
      // every later reader sees only 'conflict', and the first cause — the one
      // check that actually failed — is gone. A live scheduled workflow failed
      // six times a day for two days with its first cause unrecoverable from
      // the store (platform-49, 2026-08-11).
      if (!tables.has('logical_tool_calls')) return;
      const logicalColumns = new Set(
        (db.prepare('PRAGMA table_info(logical_tool_calls)').all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!logicalColumns.has('conflict_reason')) {
        db.exec('ALTER TABLE logical_tool_calls ADD COLUMN conflict_reason TEXT');
      }
      // A successful PROVIDER crossing must still carry its durable result —
      // that requirement is unchanged. What changes is the converse: a result
      // handle may now also belong to a successful execution the host ran
      // itself. A refusal, or any outcome that did not succeed, still may not
      // hold one. Local success WITHOUT a handle stays legal, because control
      // and discovery calls record no crossing and keep none.
      db.exec(`
        DROP TRIGGER IF EXISTS trg_logical_settlement_result_required;
        CREATE TRIGGER trg_logical_settlement_result_required
        BEFORE INSERT ON logical_call_settlements
        WHEN (
          NEW.execution_kind = 'provider_execution'
          AND NEW.outcome_kind IN ('succeeded','empty_result')
          AND NEW.result_handle_id IS NULL
        ) OR (
          NEW.result_handle_id IS NOT NULL
          AND NOT (
            NEW.execution_kind IN ('provider_execution','local_execution')
            AND NEW.outcome_kind IN ('succeeded','empty_result')
          )
        )
        BEGIN
          SELECT RAISE(ABORT, 'logical settlement result-handle binding is inconsistent');
        END;
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
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    runMigrations(db);
    cached = db;
    return db;
  } catch (error) {
    // A failed prerequisite migration must not leave a hidden live handle (or
    // a future caller that accidentally treats the half-open connection as a
    // usable store). The migration transaction has rolled back; close too.
    try { db.close(); } catch { /* preserve the original migration error */ }
    throw error;
  }
}

export function closeEventLog(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}

/** Test-only: drop the DB file so the next open starts fresh.
 *
 * DESTRUCTIVE-STORE GUARD (2026-07-23): the live home's harness.db was found
 * recreated with ALL session history gone — one un-isolated script importing
 * this function is enough (same class as the memory.db wipe that produced the
 * isolate-CLEMENTINE_HOME rule). A reset now REFUSES unless the resolved DB
 * path lives under the OS temp dir (every test pins CLEMENTINE_HOME to a
 * mkdtemp home) or the caller explicitly sets CLEMMY_ALLOW_EVENTLOG_RESET=1.
 * Protecting the store at the API, not by convention. */
export function resetEventLog(): void {
  const tmpRoot = os.tmpdir();
  const resolved = path.resolve(HARNESS_DB_PATH);
  const allowed = resolved.startsWith(path.resolve(tmpRoot) + path.sep)
    || resolved.startsWith('/tmp/')
    || resolved.startsWith('/private/tmp/')
    || process.env.CLEMMY_ALLOW_EVENTLOG_RESET === '1';
  if (!allowed) {
    throw new Error(
      `resetEventLog REFUSED: ${resolved} is not under a temp home. This deletes ALL session history. `
      + 'Point CLEMENTINE_HOME at a mkdtemp directory first (or set CLEMMY_ALLOW_EVENTLOG_RESET=1 if you truly mean it).',
    );
  }
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
  const sessionSignal = session ? summarizeSessionForSignal(session) : undefined;
  // Fan out for live SSE subscribers. Best-effort — emit errors are
  // swallowed inside actionBus so a flaky listener can never block
  // an event write.
  actionBus.emit({
    kind: 'harness.event',
    sessionId: event.sessionId,
    event,
    session: sessionSignal,
  });
  // The raw ledger is not a presentation protocol. Publish a separate,
  // fail-closed projection for user-facing transports while retaining the
  // original event above for operator/audit consumers.
  const publicEvent = projectHarnessEventForPublic(event);
  if (publicEvent) {
    actionBus.emit({
      kind: 'harness.public_event',
      sessionId: event.sessionId,
      event: publicEvent,
      session: sessionSignal,
    });
  }
  // Mirror whitelisted events into the operational-telemetry store so the
  // dashboard / Slack / Discord see run lifecycle, swarms, verdicts and
  // fallovers without touching the hot files. Fail-open — never throws.
  mirrorEventToOperational(event, session);
  return event;
}

/**
 * Insert a closed internal event as part of a domain-owned transaction.
 *
 * This is intentionally lower-level than `appendEvent`: it does not publish to
 * the action bus and it does not implement terminal-event ownership rewriting.
 * Resolution/settlement stores use it only while mutating their normalized
 * authority rows on this SAME database connection. The caller publishes the
 * returned row after its outer transaction commits.
 */
export function insertInternalEventInTransaction(
  db: Database.Database,
  input: AppendEventInput,
): EventRow {
  if (!EVENT_TYPE_SET.has(input.type)) throw new Error(`unknown event type: ${input.type}`);
  if (input.type === 'conversation_completed') {
    throw new Error('conversation_completed must use the terminal ownership writer');
  }
  const id = randomUUID();
  const now = nowIso();
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
    JSON.stringify(input.data ?? {}),
    now,
  );
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, input.sessionId);
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as RawEventRow;
  return rowToEvent(row);
}

/** Publish a domain event only AFTER its authority transaction has committed. */
export function publishCommittedInternalEvent(event: EventRow): EventRow {
  return publishPersistedEvent(event);
}

type AcceptedTaskAuthorityState = 'armed' | 'manifested_verifying' | 'terminal' | 'conflict';

interface TerminalPublicationAuthorityRow {
  session_id: string;
  source_user_seq: number;
  accepted_task_id: string;
  graph_event_id: string;
  graph_id: string;
  graph_hash: string;
  work_contract_id: string | null;
  host_completion_receipt_id: string | null;
  host_completion_event_id: string | null;
  backstop_event_id: string | null;
  state: AcceptedTaskAuthorityState;
  manifest_id: string | null;
  revision: number;
  terminal_event_id: string | null;
}

interface TerminalPublicationContractRow {
  session_id: string;
  source_user_seq: number;
  accepted_task_id: string;
  contract_version: number;
  contract_id: string;
  graph_event_id: string;
  graph_id: string;
  graph_hash: string;
  planner_source: string;
  contract_json: string;
  operation_count: number;
  universe_count: number;
}

export type AcceptedTaskTerminalPublicationErrorStatus =
  | 'not_ready'
  | 'conflict'
  | 'storage_error';

/**
 * A staged accepted task is never allowed to degrade into a legacy terminal.
 * This error is deliberately machine-readable so a caller can distinguish
 * incomplete proof from corrupt authority and an unavailable store without
 * inspecting user-facing prose.
 */
export class AcceptedTaskTerminalPublicationError extends Error {
  readonly status: AcceptedTaskTerminalPublicationErrorStatus;
  readonly reason: string;

  constructor(status: AcceptedTaskTerminalPublicationErrorStatus, reason: string) {
    super(`accepted-task terminal publication ${status}: ${reason}`);
    this.name = 'AcceptedTaskTerminalPublicationError';
    this.status = status;
    this.reason = reason;
  }
}

export type AcceptedTaskTerminalPublicationRead =
  | { status: 'legacy' }
  | {
      status: 'unstaged';
      acceptedTaskId: string;
      authorityState: AcceptedTaskAuthorityState;
    }
  | {
      status: 'pending';
      acceptedTaskId: string;
      authorityState: 'armed' | 'manifested_verifying';
      workContractId?: string;
      hostReceiptId?: string;
      manifestId?: string;
    }
  | {
      status: 'published';
      acceptedTaskId: string;
      workContractId?: string;
      hostReceiptId?: string;
      manifestId: string;
      terminalEventId: string;
      event: EventRow;
    }
  | { status: 'conflict' | 'unreadable'; reason: string };

function terminalPublicationRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function terminalPublicationCanonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(terminalPublicationCanonicalize).join(',')}]`;
  }
  if (!terminalPublicationRecord(value)) throw new Error('non-canonical JSON value');
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${terminalPublicationCanonicalize(value[key])}`)
    .join(',')}}`;
}

function terminalPublicationSourceUserSeq(data: Record<string, unknown>): number | null {
  if (Number.isSafeInteger(data.sourceUserSeq) && Number(data.sourceUserSeq) > 0) {
    return Number(data.sourceUserSeq);
  }
  if (terminalPublicationRecord(data.presentation)) {
    const identity = data.presentation.identity;
    if (
      terminalPublicationRecord(identity)
      && Number.isSafeInteger(identity.sourceUserSeq)
      && Number(identity.sourceUserSeq) > 0
    ) return Number(identity.sourceUserSeq);
  }
  if (typeof data.terminalKey === 'string') {
    const match = /^turn:([1-9]\d*)$/.exec(data.terminalKey.trim());
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isSafeInteger(parsed)) return parsed;
    }
  }
  return null;
}

function terminalPublicationAuthorityRow(
  db: Database.Database,
  sessionId: string,
  sourceUserSeq: number,
): TerminalPublicationAuthorityRow | undefined {
  return db.prepare(`
    SELECT session_id, source_user_seq, accepted_task_id, graph_event_id,
           graph_id, graph_hash, work_contract_id, host_completion_receipt_id,
           host_completion_event_id, backstop_event_id, state, manifest_id,
           revision, terminal_event_id
      FROM accepted_task_authority
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, sourceUserSeq) as TerminalPublicationAuthorityRow | undefined;
}

function terminalPublicationContractRow(
  db: Database.Database,
  sessionId: string,
  sourceUserSeq: number,
): TerminalPublicationContractRow | undefined {
  return db.prepare(`
    SELECT session_id, source_user_seq, accepted_task_id, contract_version,
           contract_id, graph_event_id, graph_id, graph_hash, planner_source,
           contract_json, operation_count, universe_count
      FROM accepted_task_work_contracts
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, sourceUserSeq) as TerminalPublicationContractRow | undefined;
}

function terminalPublicationContractIsExact(
  authority: TerminalPublicationAuthorityRow,
  contract: TerminalPublicationContractRow | undefined,
  sourceTurn: number,
): boolean {
  if (
    !contract
    || contract.contract_version !== 1
    || contract.session_id !== authority.session_id
    || contract.source_user_seq !== authority.source_user_seq
    || contract.accepted_task_id !== authority.accepted_task_id
    || contract.contract_id !== authority.work_contract_id
    || contract.graph_event_id !== authority.graph_event_id
    || contract.graph_id !== authority.graph_id
    || contract.graph_hash !== authority.graph_hash
    || (contract.planner_source !== 'deterministic' && contract.planner_source !== 'structured_model')
  ) return false;
  let value: unknown;
  try {
    value = JSON.parse(contract.contract_json);
  } catch {
    return false;
  }
  if (!terminalPublicationRecord(value) || !terminalPublicationRecord(value.identity)) return false;
  const exactTopLevelKeys = [
    'acceptedTaskId', 'contractId', 'graphEventId', 'graphHash', 'graphId',
    'identity', 'operations', 'plannerSource', 'universes', 'version',
  ];
  const exactIdentityKeys = ['sessionId', 'sourceUserSeq', 'turn'];
  const material = {
    version: value.version,
    identity: value.identity,
    acceptedTaskId: value.acceptedTaskId,
    graphEventId: value.graphEventId,
    graphId: value.graphId,
    graphHash: value.graphHash,
    plannerSource: value.plannerSource,
    operations: value.operations,
    universes: value.universes,
  };
  const contentAddress = `expected-work:v1:${createHash('sha256')
    .update(terminalPublicationCanonicalize(material))
    .digest('hex')}`;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(exactTopLevelKeys)
    && JSON.stringify(Object.keys(value.identity).sort()) === JSON.stringify(exactIdentityKeys)
    && contract.contract_json === terminalPublicationCanonicalize(value)
    && contentAddress === contract.contract_id
    && value.version === 1
    && value.contractId === contract.contract_id
    && value.acceptedTaskId === contract.accepted_task_id
    && value.graphEventId === contract.graph_event_id
    && value.graphId === contract.graph_id
    && value.graphHash === contract.graph_hash
    && value.plannerSource === contract.planner_source
    && value.identity.sessionId === contract.session_id
    && value.identity.sourceUserSeq === contract.source_user_seq
    && value.identity.turn === sourceTurn
    && Array.isArray(value.operations)
    && value.operations.length === contract.operation_count
    && Array.isArray(value.universes)
    && value.universes.length === contract.universe_count;
}

function terminalPublicationManifestForAuthority(
  db: Database.Database,
  authority: TerminalPublicationAuthorityRow,
): ObligationManifest | null {
  if (!authority.manifest_id) return null;
  const rows = db.prepare(`
    SELECT data_json
      FROM events
     WHERE session_id = ?
       AND type = 'obligation_manifest'
       AND json_extract(data_json, '$.sourceUserSeq') = ?
     ORDER BY seq ASC
     LIMIT 2
  `).all(authority.session_id, authority.source_user_seq) as Array<{ data_json: string }>;
  if (rows.length !== 1) return null;
  let data: unknown;
  try {
    data = JSON.parse(rows[0]!.data_json);
  } catch {
    return null;
  }
  if (!terminalPublicationRecord(data) || !terminalPublicationRecord(data.manifest)) return null;
  const manifest = data.manifest;
  if (!terminalPublicationRecord(manifest.identity)) return null;
  const exactTopLevelKeys = [
    'edges', 'graphHash', 'graphId', 'identity', 'manifestId',
    'mode', 'nodes', 'readiness', 'version',
  ];
  const exactIdentityKeys = ['sessionId', 'sourceUserSeq', 'turn'];
  const material = {
    version: manifest.version,
    mode: manifest.mode,
    readiness: manifest.readiness,
    identity: manifest.identity,
    graphId: manifest.graphId,
    graphHash: manifest.graphHash,
    nodes: manifest.nodes,
    edges: manifest.edges,
  };
  const contentAddress = `manifest:v1:${createHash('sha256')
    .update(terminalPublicationCanonicalize(material))
    .digest('hex')}`;
  const exact = JSON.stringify(Object.keys(manifest).sort()) === JSON.stringify(exactTopLevelKeys)
    && JSON.stringify(Object.keys(manifest.identity).sort()) === JSON.stringify(exactIdentityKeys)
    && Array.isArray(manifest.nodes)
    && Array.isArray(manifest.edges)
    && data.sourceUserSeq === authority.source_user_seq
    && manifest.version === 1
    && manifest.mode === 'authoritative'
    && manifest.readiness === 'ready'
    && manifest.manifestId === authority.manifest_id
    && manifest.manifestId === contentAddress
    && manifest.graphId === authority.graph_id
    && manifest.graphHash === authority.graph_hash
    && manifest.identity.sessionId === authority.session_id
    && manifest.identity.sourceUserSeq === authority.source_user_seq;
  return exact ? manifest as unknown as ObligationManifest : null;
}

function terminalPublicationManifestIsExact(
  db: Database.Database,
  authority: TerminalPublicationAuthorityRow,
): boolean {
  return terminalPublicationManifestForAuthority(db, authority) !== null;
}

function terminalPublicationPresentation(
  data: Record<string, unknown>,
  input: { sessionId: string; sourceUserSeq: number; turn: number },
): NonNullable<ReturnType<typeof presentationEventFromCompletionData>> {
  let presentation: ReturnType<typeof presentationEventFromCompletionData>;
  try {
    presentation = presentationEventFromCompletionData(data);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AcceptedTaskTerminalPublicationError(
      'conflict',
      `typed completion projection is invalid: ${reason}`,
    );
  }
  if (!presentation) {
    throw new AcceptedTaskTerminalPublicationError(
      'conflict',
      'a staged accepted task requires a typed completion projection',
    );
  }
  if (
    presentation.identity.sessionId !== input.sessionId
    || presentation.identity.sourceUserSeq !== input.sourceUserSeq
    || presentation.identity.turn !== input.turn
  ) {
    throw new AcceptedTaskTerminalPublicationError(
      'conflict',
      'completion identity does not match the exact accepted source',
    );
  }
  return presentation;
}

function assertExactTerminalPublicationGraphStructure(
  db: Database.Database,
  authority: TerminalPublicationAuthorityRow,
): number {
  if (authority.accepted_task_id !== `task:${authority.session_id}#${authority.source_user_seq}`) {
    throw new AcceptedTaskTerminalPublicationError('conflict', 'accepted-task identity is inconsistent');
  }
  const source = db.prepare(`
    SELECT id, turn FROM events
     WHERE session_id = ? AND seq = ? AND type = 'user_input_received'
  `).get(authority.session_id, authority.source_user_seq) as {
    id: string;
    turn: number;
  } | undefined;
  const graphRow = db.prepare(`
    SELECT * FROM events
     WHERE id = ? AND session_id = ? AND type = 'turn_graph_compiled'
       AND json_extract(data_json, '$.sourceUserSeq') = ?
  `).get(
    authority.graph_event_id,
    authority.session_id,
    authority.source_user_seq,
  ) as RawEventRow | undefined;
  if (!source || !graphRow) {
    throw new AcceptedTaskTerminalPublicationError(
      'conflict',
      'accepted-task source or graph authority is missing',
    );
  }
  const graphEvent = rowToEvent(graphRow);
  const graph = graphEvent.data.graph as TurnGraphIR | undefined;
  const graphValidation = graph ? validateTurnGraph(graph) : null;
  if (
    !graph
    || !graphValidation?.ok
    || graphEvent.turn !== source.turn
    || graphEvent.parentEventId !== source.id
    || graph.identity.sessionId !== authority.session_id
    || graph.identity.sourceUserSeq !== authority.source_user_seq
    || graph.identity.turn !== source.turn
    || graph.graphId !== authority.graph_id
    || graph.compiler.graphHash !== authority.graph_hash
    || graphEvent.data.graphId !== authority.graph_id
    || graphEvent.data.graphHash !== authority.graph_hash
  ) {
    throw new AcceptedTaskTerminalPublicationError(
      'conflict',
      'accepted-task graph bytes do not match their authority',
    );
  }
  return source.turn;
}

function assertExactTerminalPublicationStructure(
  db: Database.Database,
  authority: TerminalPublicationAuthorityRow,
): void {
  const sourceTurn = assertExactTerminalPublicationGraphStructure(db, authority);
  const contract = terminalPublicationContractRow(
    db,
    authority.session_id,
    authority.source_user_seq,
  );
  if (!terminalPublicationContractIsExact(authority, contract, sourceTurn)) {
    throw new AcceptedTaskTerminalPublicationError(
      'conflict',
      'accepted-task work contract is missing or does not match its authority',
    );
  }
}

interface TerminalPublicationMemoryReceiptRow {
  receipt_id: string;
  protocol_version: number;
  session_id: string;
  source_user_seq: number;
  accepted_task_id: string;
  graph_event_id: string;
  graph_id: string;
  graph_hash: string;
  source_event_id: string;
  source_message_digest: string;
  episode_id: string;
  call_id: string;
  episode_content_hash: string;
  candidate_count: number;
  candidate_digest: string;
  evidence_digest: string;
  receipt_json: string;
  receipt_event_id: string;
}

/** Validate the immutable normalized host receipt inside the terminal writer
 * transaction. The memory ledger was independently re-redeemed immediately
 * before publication; this check ensures the transaction closes only the exact
 * receipt-bound authority and never an armed boolean/event shortcut. */
function assertExactDurableMemoryHostReceipt(
  db: Database.Database,
  authority: TerminalPublicationAuthorityRow,
): TerminalPublicationMemoryReceiptRow {
  assertExactTerminalPublicationGraphStructure(db, authority);
  if (
    authority.work_contract_id !== null
    || !authority.host_completion_receipt_id
    || !authority.host_completion_event_id
    || authority.manifest_id !== authority.host_completion_receipt_id
    || authority.backstop_event_id !== authority.host_completion_event_id
  ) {
    throw new AcceptedTaskTerminalPublicationError(
      'conflict',
      'durable memory host authority is not exactly receipt-bound',
    );
  }
  const row = db.prepare(`
    SELECT * FROM durable_memory_intake_receipts
     WHERE session_id = ? AND source_user_seq = ?
  `).get(authority.session_id, authority.source_user_seq) as TerminalPublicationMemoryReceiptRow | undefined;
  if (
    !row
    || row.protocol_version !== 1
    || row.receipt_id !== authority.host_completion_receipt_id
    || row.receipt_event_id !== authority.host_completion_event_id
    || row.accepted_task_id !== authority.accepted_task_id
    || row.graph_event_id !== authority.graph_event_id
    || row.graph_id !== authority.graph_id
    || row.graph_hash !== authority.graph_hash
    || row.session_id !== authority.session_id
    || row.source_user_seq !== authority.source_user_seq
  ) {
    throw new AcceptedTaskTerminalPublicationError(
      'conflict',
      'durable memory host receipt is missing or contradicts its authority',
    );
  }
  let receipt: unknown;
  try { receipt = JSON.parse(row.receipt_json); } catch {
    throw new AcceptedTaskTerminalPublicationError('conflict', 'durable memory host receipt JSON is malformed');
  }
  const canonical = terminalPublicationCanonicalize(receipt);
  if (
    row.receipt_json !== canonical
    || row.receipt_id !== `memory-intake:v1:${createHash('sha256').update(canonical).digest('hex')}`
    || !terminalPublicationRecord(receipt)
    || receipt.protocol !== 1
    || receipt.kind !== 'durable_memory_intake'
    || !terminalPublicationRecord(receipt.identity)
    || !terminalPublicationRecord(receipt.graph)
    || !terminalPublicationRecord(receipt.source)
    || !terminalPublicationRecord(receipt.memory)
    || receipt.identity.sessionId !== row.session_id
    || receipt.identity.sourceUserSeq !== row.source_user_seq
    || receipt.identity.acceptedTaskId !== row.accepted_task_id
    || receipt.graph.graphEventId !== row.graph_event_id
    || receipt.graph.graphId !== row.graph_id
    || receipt.graph.graphHash !== row.graph_hash
    || receipt.source.eventId !== row.source_event_id
    || receipt.source.messageDigest !== row.source_message_digest
    || receipt.memory.episodeId !== row.episode_id
    || receipt.memory.callId !== row.call_id
    || receipt.memory.episodeContentHash !== row.episode_content_hash
    || !Array.isArray(receipt.candidates)
    || receipt.candidates.length !== row.candidate_count
    || receipt.candidateDigest !== row.candidate_digest
    || receipt.evidenceDigest !== row.evidence_digest
  ) {
    throw new AcceptedTaskTerminalPublicationError('conflict', 'durable memory host receipt content address is invalid');
  }
  const receiptEvents = db.prepare(`
    SELECT id, data_json FROM events
     WHERE session_id = ? AND type = 'durable_memory_intake_receipt'
       AND json_extract(data_json, '$.sourceUserSeq') = ?
     ORDER BY seq
  `).all(authority.session_id, authority.source_user_seq) as Array<{ id: string; data_json: string }>;
  if (receiptEvents.length !== 1 || receiptEvents[0]!.id !== row.receipt_event_id) {
    throw new AcceptedTaskTerminalPublicationError('conflict', 'durable memory host receipt event is not unique');
  }
  let eventData: unknown;
  try { eventData = JSON.parse(receiptEvents[0]!.data_json); } catch {
    throw new AcceptedTaskTerminalPublicationError('conflict', 'durable memory host receipt event is malformed');
  }
  if (
    !terminalPublicationRecord(eventData)
    || eventData.receiptId !== row.receipt_id
    || eventData.sourceUserSeq !== row.source_user_seq
    || eventData.acceptedTaskId !== row.accepted_task_id
    || !isDeepStrictEqual(eventData.receipt, receipt)
  ) {
    throw new AcceptedTaskTerminalPublicationError('conflict', 'durable memory host receipt event is not exact');
  }
  const crossings = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ?) AS logical_n,
      (SELECT COUNT(*) FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ?) AS dispatch_n,
      (SELECT COUNT(*) FROM accepted_task_work_contracts
        WHERE session_id = ? AND source_user_seq = ?) AS contract_n
  `).get(
    authority.session_id,
    authority.source_user_seq,
    authority.session_id,
    authority.source_user_seq,
    authority.session_id,
    authority.source_user_seq,
  ) as { logical_n: number; dispatch_n: number; contract_n: number };
  if (crossings.logical_n !== 0 || crossings.dispatch_n !== 0 || crossings.contract_n !== 0) {
    throw new AcceptedTaskTerminalPublicationError(
      'conflict',
      'durable memory host receipt has competing provider work',
    );
  }
  return row;
}

function closeAcceptedTaskTerminalPublicationInTransaction(input: {
  db: Database.Database;
  eventId: string;
  sessionId: string;
  turn: number;
  eventData: Record<string, unknown>;
  now: string;
}): void {
  const sourceUserSeq = terminalPublicationSourceUserSeq(input.eventData);
  if (sourceUserSeq === null) return;
  const authority = terminalPublicationAuthorityRow(input.db, input.sessionId, sourceUserSeq);
  if (!authority || (!authority.work_contract_id && !authority.host_completion_receipt_id)) return;
  if (authority.work_contract_id && authority.host_completion_receipt_id) {
    throw new AcceptedTaskTerminalPublicationError(
      'conflict',
      'accepted task cannot own both provider work and a host completion receipt',
    );
  }
  if (authority.host_completion_receipt_id) {
    assertExactDurableMemoryHostReceipt(input.db, authority);
    const presentation = terminalPublicationPresentation(input.eventData, {
      sessionId: input.sessionId,
      sourceUserSeq,
      turn: input.turn,
    });
    if (presentation.status !== 'done') return;
    if (authority.state !== 'manifested_verifying') {
      throw new AcceptedTaskTerminalPublicationError(
        authority.state === 'armed' ? 'not_ready' : 'conflict',
        `durable memory host authority cannot publish done from ${authority.state}`,
      );
    }
    const updated = input.db.prepare(`
      UPDATE accepted_task_authority
         SET state = 'terminal', terminal_event_id = ?,
             revision = revision + 1, updated_at = ?
       WHERE session_id = ? AND source_user_seq = ?
         AND state = 'manifested_verifying'
         AND revision = ?
         AND work_contract_id IS NULL
         AND manifest_id = ?
         AND host_completion_receipt_id = ?
         AND host_completion_event_id = ?
         AND terminal_event_id IS NULL
    `).run(
      input.eventId,
      input.now,
      input.sessionId,
      sourceUserSeq,
      authority.revision,
      authority.host_completion_receipt_id,
      authority.host_completion_receipt_id,
      authority.host_completion_event_id,
    );
    if (updated.changes !== 1) {
      throw new AcceptedTaskTerminalPublicationError(
        'conflict',
        'durable memory host terminal authority CAS lost',
      );
    }
    return;
  }
  assertExactTerminalPublicationStructure(input.db, authority);
  const presentation = terminalPublicationPresentation(input.eventData, {
    sessionId: input.sessionId,
    sourceUserSeq,
    turn: input.turn,
  });
  // A blocked/needs-input/failed/cancelled/transferred presentation remains a
  // truthful public stop, but it is not completion evidence. Only done closes
  // the accepted-task authority.
  if (presentation.status !== 'done') return;
  if (authority.state === 'armed') {
    throw new AcceptedTaskTerminalPublicationError(
      'not_ready',
      'accepted-task authority has not entered manifested verification',
    );
  }
  if (authority.state !== 'manifested_verifying') {
    throw new AcceptedTaskTerminalPublicationError(
      'conflict',
      `accepted-task authority cannot publish done from ${authority.state}`,
    );
  }
  const manifest = terminalPublicationManifestForAuthority(input.db, authority);
  if (!manifest) {
    throw new AcceptedTaskTerminalPublicationError(
      'conflict',
      'accepted-task manifest is missing or does not match its authority',
    );
  }
  const proof = verifyAcceptedTaskTerminalProofInTransaction({
    db: input.db,
    sessionId: input.sessionId,
    sourceUserSeq,
    acceptedTaskId: authority.accepted_task_id,
    manifest,
  });
  if (!proof.ok) {
    throw new AcceptedTaskTerminalPublicationError(
      proof.status === 'unreadable' ? 'storage_error' : proof.status,
      proof.reason,
    );
  }
  const updated = input.db.prepare(`
    UPDATE accepted_task_authority
       SET state = 'terminal', terminal_event_id = ?,
           revision = revision + 1, updated_at = ?
     WHERE session_id = ? AND source_user_seq = ?
       AND state = 'manifested_verifying'
       AND revision = ?
       AND work_contract_id = ?
       AND manifest_id = ?
       AND terminal_event_id IS NULL
  `).run(
    input.eventId,
    input.now,
    input.sessionId,
    sourceUserSeq,
    authority.revision,
    authority.work_contract_id,
    authority.manifest_id,
  );
  if (updated.changes !== 1) {
    throw new AcceptedTaskTerminalPublicationError(
      'conflict',
      'accepted-task terminal authority CAS lost',
    );
  }
}

function terminalEventForAcceptedSource(
  db: Database.Database,
  sessionId: string,
  sourceUserSeq: number,
): RawEventRow | undefined {
  return db.prepare(`
    SELECT * FROM events
     WHERE session_id = ?
       AND type = 'conversation_completed'
       AND COALESCE(
         json_extract(data_json, '$.sourceUserSeq'),
         json_extract(data_json, '$.presentation.identity.sourceUserSeq')
       ) = ?
     ORDER BY seq ASC
     LIMIT 1
  `).get(sessionId, sourceUserSeq) as RawEventRow | undefined;
}

function validatePersistedTerminalPublicationWinner(
  db: Database.Database,
  row: RawEventRow,
  sessionId: string,
  sourceUserSeq: number,
): EventRow {
  const event = rowToEvent(row);
  if (event.sessionId !== sessionId || event.type !== 'conversation_completed') {
    throw new AcceptedTaskTerminalPublicationError(
      'conflict',
      'persisted terminal winner belongs to another accepted source',
    );
  }
  const authority = terminalPublicationAuthorityRow(db, sessionId, sourceUserSeq);
  if (!authority || (!authority.work_contract_id && !authority.host_completion_receipt_id)) return event;
  if (authority.host_completion_receipt_id) {
    assertExactDurableMemoryHostReceipt(db, authority);
    const presentation = terminalPublicationPresentation(event.data, {
      sessionId,
      sourceUserSeq,
      turn: event.turn,
    });
    if (presentation.status === 'done') {
      if (
        authority.state !== 'terminal'
        || authority.terminal_event_id !== event.id
        || authority.manifest_id !== authority.host_completion_receipt_id
      ) {
        throw new AcceptedTaskTerminalPublicationError(
          'conflict',
          'persisted done event is not the host-receipt authority winner',
        );
      }
    } else if (authority.state === 'terminal' || authority.terminal_event_id) {
      throw new AcceptedTaskTerminalPublicationError(
        'conflict',
        'non-done event cannot own durable-memory terminal authority',
      );
    }
    return event;
  }
  assertExactTerminalPublicationStructure(db, authority);
  const presentation = terminalPublicationPresentation(event.data, {
    sessionId,
    sourceUserSeq,
    turn: event.turn,
  });
  if (presentation.status === 'done') {
    const manifest = terminalPublicationManifestForAuthority(db, authority);
    if (
      authority.state !== 'terminal'
      || authority.terminal_event_id !== event.id
      || !authority.manifest_id
      || !manifest
    ) {
      throw new AcceptedTaskTerminalPublicationError(
        'conflict',
        'persisted done event is not the authority-linked terminal winner',
      );
    }
    const proof = verifyAcceptedTaskTerminalProofInTransaction({
      db,
      sessionId,
      sourceUserSeq,
      acceptedTaskId: authority.accepted_task_id,
      manifest,
    });
    if (!proof.ok) {
      throw new AcceptedTaskTerminalPublicationError(
        proof.status === 'unreadable' ? 'storage_error' : proof.status,
        proof.reason,
      );
    }
  } else if (authority.state === 'terminal' || authority.terminal_event_id) {
    throw new AcceptedTaskTerminalPublicationError(
      'conflict',
      'non-done event cannot own terminal accepted-task authority',
    );
  }
  return event;
}

/**
 * Read and revalidate terminal publication state for one exact accepted task.
 * The result never infers staging from a reply/reason string: only the durable
 * authority's immutable work_contract_id opts the source into this protocol.
 */
export function readAcceptedTaskTerminalPublication(
  sessionId: string,
  sourceUserSeq: number,
): AcceptedTaskTerminalPublicationRead {
  if (!sessionId || !Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) {
    return { status: 'unreadable', reason: 'accepted source identity is invalid' };
  }
  try {
    const db = openEventLog();
    const authority = terminalPublicationAuthorityRow(db, sessionId, sourceUserSeq);
    if (!authority) return { status: 'legacy' };
    const strayContract = terminalPublicationContractRow(db, sessionId, sourceUserSeq);
    if (authority.host_completion_receipt_id) {
      if (authority.work_contract_id || strayContract) {
        return { status: 'conflict', reason: 'host-completed authority also owns provider work' };
      }
      try {
        assertExactDurableMemoryHostReceipt(db, authority);
      } catch (error) {
        return {
          status: 'conflict',
          reason: error instanceof AcceptedTaskTerminalPublicationError
            ? error.reason
            : String(error),
        };
      }
      if (authority.state === 'conflict') {
        return { status: 'conflict', reason: 'accepted-task authority is conflicted' };
      }
      const terminalRow = terminalEventForAcceptedSource(db, sessionId, sourceUserSeq);
      if (authority.state === 'terminal') {
        if (!authority.terminal_event_id || !terminalRow || terminalRow.id !== authority.terminal_event_id) {
          return { status: 'conflict', reason: 'host terminal authority does not name its exact event' };
        }
        try {
          const event = validatePersistedTerminalPublicationWinner(
            db,
            terminalRow,
            sessionId,
            sourceUserSeq,
          );
          return {
            status: 'published',
            acceptedTaskId: authority.accepted_task_id,
            hostReceiptId: authority.host_completion_receipt_id,
            manifestId: authority.host_completion_receipt_id,
            terminalEventId: authority.terminal_event_id,
            event,
          };
        } catch (error) {
          return {
            status: 'conflict',
            reason: error instanceof AcceptedTaskTerminalPublicationError
              ? error.reason
              : String(error),
          };
        }
      }
      if (authority.state !== 'manifested_verifying' || authority.terminal_event_id) {
        return { status: 'conflict', reason: 'host receipt authority is not in a valid pending state' };
      }
      return {
        status: 'pending',
        acceptedTaskId: authority.accepted_task_id,
        authorityState: authority.state,
        hostReceiptId: authority.host_completion_receipt_id,
        manifestId: authority.host_completion_receipt_id,
      };
    }
    if (!authority.work_contract_id) {
      if (strayContract) {
        return { status: 'conflict', reason: 'unbound authority has a staged work-contract row' };
      }
      return {
        status: 'unstaged',
        acceptedTaskId: authority.accepted_task_id,
        authorityState: authority.state,
      };
    }
    try {
      assertExactTerminalPublicationStructure(db, authority);
    } catch (error) {
      return {
        status: 'conflict',
        reason: error instanceof AcceptedTaskTerminalPublicationError
          ? error.reason
          : String(error),
      };
    }
    if (authority.state === 'conflict') {
      return { status: 'conflict', reason: 'accepted-task authority is conflicted' };
    }
    const terminalRow = terminalEventForAcceptedSource(db, sessionId, sourceUserSeq);
    if (authority.state === 'terminal') {
      if (!authority.terminal_event_id || !terminalRow || terminalRow.id !== authority.terminal_event_id) {
        return { status: 'conflict', reason: 'terminal authority does not name its exact event' };
      }
      if (!authority.manifest_id || !terminalPublicationManifestIsExact(db, authority)) {
        return { status: 'conflict', reason: 'terminal authority does not retain its exact manifest' };
      }
      try {
        const event = validatePersistedTerminalPublicationWinner(
          db,
          terminalRow,
          sessionId,
          sourceUserSeq,
        );
        return {
          status: 'published',
          acceptedTaskId: authority.accepted_task_id,
          workContractId: authority.work_contract_id,
          manifestId: authority.manifest_id,
          terminalEventId: authority.terminal_event_id,
          event,
        };
      } catch (error) {
        return {
          status: 'conflict',
          reason: error instanceof AcceptedTaskTerminalPublicationError
            ? error.reason
            : String(error),
        };
      }
    }
    if (authority.state === 'manifested_verifying') {
      if (!authority.manifest_id || !terminalPublicationManifestIsExact(db, authority)) {
        return { status: 'conflict', reason: 'verifying authority does not retain its exact manifest' };
      }
    } else if (authority.manifest_id) {
      return { status: 'conflict', reason: 'armed authority unexpectedly names a manifest' };
    }
    if (authority.terminal_event_id) {
      return { status: 'conflict', reason: 'nonterminal authority unexpectedly names a terminal event' };
    }
    if (terminalRow) {
      try {
        const presentation = terminalPublicationPresentation(rowToEvent(terminalRow).data, {
          sessionId,
          sourceUserSeq,
          turn: terminalRow.turn,
        });
        if (presentation.status === 'done') {
          return { status: 'conflict', reason: 'done event exists without the terminal authority CAS' };
        }
      } catch (error) {
        return {
          status: 'conflict',
          reason: error instanceof AcceptedTaskTerminalPublicationError
            ? error.reason
            : String(error),
        };
      }
    }
    return {
      status: 'pending',
      acceptedTaskId: authority.accepted_task_id,
      authorityState: authority.state,
      workContractId: authority.work_contract_id,
      ...(authority.manifest_id ? { manifestId: authority.manifest_id } : {}),
    };
  } catch (error) {
    return {
      status: 'unreadable',
      reason: String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 240),
    };
  }
}

export function appendEvent(input: AppendEventInput): EventRow {
  if (!EVENT_TYPE_SET.has(input.type)) {
    throw new Error(`unknown event type: ${input.type}`);
  }
  const db = openEventLog();
  const id = randomUUID();
  const now = nowIso();
  let stagedTerminalPublicationAttempted = false;
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
    if (input.type === 'conversation_completed') {
      const terminalSourceUserSeq = terminalPublicationSourceUserSeq(eventData);
      if (terminalSourceUserSeq !== null) {
        const terminalAuthority = terminalPublicationAuthorityRow(
          db,
          input.sessionId,
          terminalSourceUserSeq,
        );
        stagedTerminalPublicationAttempted = Boolean(
          terminalAuthority?.work_contract_id || terminalAuthority?.host_completion_receipt_id,
        );
      }
      closeAcceptedTaskTerminalPublicationInTransaction({
        db,
        eventId: id,
        sessionId: input.sessionId,
        turn: input.turn,
        eventData,
        now,
      });
    }
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, input.sessionId);
  });
  try {
    // A deferred read-then-write transaction can lose a concurrent terminal
    // race with SQLITE_BUSY even with a busy timeout. IMMEDIATE acquires the
    // single writer slot before inspecting authority, so concurrent processes
    // deterministically become winner + replay instead.
    if (input.type === 'conversation_completed') tx.immediate();
    else tx();
  } catch (error) {
    if (error instanceof AcceptedTaskTerminalPublicationError) throw error;
    if (input.type === 'conversation_completed' && stagedTerminalPublicationAttempted) {
      throw new AcceptedTaskTerminalPublicationError(
        'storage_error',
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as RawEventRow;
  const event = rowToEvent(row);
  // Durable audit mirror (2026-07-20 attorney-bar B3): trust-relevant events
  // are cascade-DELETED with their session at the 14-day reap — the ledger
  // copy under BASE_DIR/audit/ survives GC so "who did Clem write to, when,
  // under whose approval" stays reconstructable. One seam covers every lane.
  if (AUDIT_MIRRORED_EVENT_TYPES.has(input.type)) {
    try {
      appendAuditRecord({
        at: event.createdAt,
        kind: input.type,
        sessionId: input.sessionId,
        seq: event.seq,
        turn: input.turn,
        ...(input.data && typeof input.data === 'object' ? input.data : {}),
      });
    } catch { /* the ledger never blocks the event write */ }
  }
  // Deliverable index tee (2026-07-23): every lane's settled external writes
  // flow through THIS seam, so one tee gives "where did I put the user's work"
  // durable memory (memory.db — it must survive an evidence-store wipe; see
  // deliverable-index.ts). A new pre-dispatch row is only a reservation; index
  // it after the exact call succeeds. Legacy rows keep their historical
  // success meaning. Fire-and-forget: memory never blocks the event append.
  let deliverableData: Record<string, unknown> | null = null;
  const eventDataRecord = (input.data ?? {}) as Record<string, unknown>;
  if (input.type === 'external_write' && eventDataRecord.preDispatch !== true) {
    deliverableData = eventDataRecord;
  } else if (input.type === 'external_write_succeeded') {
    const successCallId = typeof eventDataRecord.canonicalCallId === 'string'
      ? eventDataRecord.canonicalCallId.trim()
      : typeof eventDataRecord.callId === 'string'
        ? eventDataRecord.callId.trim()
        : '';
    if (successCallId) {
      try {
        const candidates = db.prepare(
          `SELECT seq, data_json
             FROM events
            WHERE session_id = ?
              AND type = 'external_write'
              AND seq < ?
            ORDER BY seq DESC
            LIMIT 500`,
        ).all(input.sessionId, event.seq) as Array<{ seq: number; data_json: string }>;
        for (const candidate of candidates) {
          let reserved: Record<string, unknown>;
          try { reserved = JSON.parse(candidate.data_json) as Record<string, unknown>; } catch { continue; }
          if (reserved.preDispatch !== true) continue;
          const reservedCallId = typeof reserved.canonicalCallId === 'string'
            ? reserved.canonicalCallId.trim()
            : typeof reserved.callId === 'string'
              ? reserved.callId.trim()
              : '';
          if (reservedCallId !== successCallId) continue;
          const failedRows = db.prepare(
            `SELECT data_json
               FROM events
              WHERE session_id = ?
                AND type = 'external_write_failed'
                AND seq > ?
                AND seq < ?
              ORDER BY seq DESC
              LIMIT 100`,
          ).all(input.sessionId, candidate.seq, event.seq) as Array<{ data_json: string }>;
          const alreadyFailed = failedRows.some((failedRow) => {
            try {
              const failed = JSON.parse(failedRow.data_json) as Record<string, unknown>;
              const failedCallId = typeof failed.canonicalCallId === 'string'
                ? failed.canonicalCallId.trim()
                : typeof failed.callId === 'string'
                  ? failed.callId.trim()
                  : '';
              return failedCallId === successCallId;
            } catch {
              return false;
            }
          });
          if (alreadyFailed) break;
          deliverableData = {
            ...reserved,
            ...eventDataRecord,
            targets: Array.isArray(eventDataRecord.targets) && eventDataRecord.targets.length > 0
              ? eventDataRecord.targets
              : reserved.targets,
          };
          break;
        }
      } catch { /* exact settlement lookup is best-effort */ }
    }
  }
  if (deliverableData) {
    const d = deliverableData as { shapeKey?: unknown; targets?: unknown };
    const shapeKey = typeof d.shapeKey === 'string' ? d.shapeKey : undefined;
    const targets = Array.isArray(d.targets) ? d.targets.filter((t): t is string => typeof t === 'string') : [];
    if (targets.length > 0) {
      let why = '';
      try {
        const sess = db.prepare('SELECT title FROM sessions WHERE id = ?').get(input.sessionId) as { title?: string } | undefined;
        why = sess?.title ?? '';
      } catch { /* title enrichment only */ }
      void import('../../memory/deliverable-index.js')
        .then(({ recordDeliverable, deliverableKindForShape }) => {
          const kind = deliverableKindForShape(shapeKey);
          for (const target of targets.slice(0, 25)) {
            recordDeliverable({ kind, target, title: shapeKey ?? kind, why, sessionId: input.sessionId, lane: 'external' });
          }
        })
        .catch(() => { /* best-effort */ });
    }
  }
  return publishPersistedEvent(event);
}

function rawTurnGraphEventForSource(
  db: Database.Database,
  sessionId: string,
  sourceUserSeq: number,
): RawEventRow | undefined {
  return db.prepare(
    `SELECT * FROM events
      WHERE session_id = ?
        AND type = 'turn_graph_compiled'
        AND json_extract(data_json, '$.sourceUserSeq') = ?
      ORDER BY seq ASC
      LIMIT 1`,
  ).get(sessionId, sourceUserSeq) as RawEventRow | undefined;
}

/** Point-read the one observational turn graph owned by an exact accepted
 * source. This avoids loading every later graph (including each full private
 * IR) when a bridge/recovery hook retries an older logical turn. */
export function getTurnGraphEventForSource(
  sessionId: string,
  sourceUserSeq: number,
): EventRow | null {
  if (!sessionId || !Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) return null;
  const row = rawTurnGraphEventForSource(openEventLog(), sessionId, sourceUserSeq);
  return row ? rowToEvent(row) : null;
}

/**
 * Atomically append one source-owned shadow graph, or reuse the existing row.
 *
 * The bridge and both brain lanes can observe the same accepted turn. An
 * IMMEDIATE transaction serializes those observers across processes so their
 * read-before-write cannot create duplicate graph rows. The transaction also
 * revalidates the exact chat/user source and parent link before persistence;
 * the returned observation is never execution or publication authority.
 */
export function appendTurnGraphEventOnce(input: {
  sessionId: string;
  turn: number;
  sourceUserSeq: number;
  data: Record<string, unknown>;
}): { event: EventRow; inserted: boolean } {
  if (!input.sessionId || !Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq <= 0) {
    throw new Error('turn graph requires an accepted sourceUserSeq');
  }
  if (input.data.sourceUserSeq !== input.sourceUserSeq) {
    throw new Error('turn graph payload source does not match its accepted source');
  }
  const db = openEventLog();
  const append = db.transaction((): { row: RawEventRow; inserted: boolean } => {
    const source = db.prepare(
      `SELECT events.*, sessions.kind AS session_kind
         FROM events
         JOIN sessions ON sessions.id = events.session_id
        WHERE events.session_id = ?
          AND events.seq = ?
          AND events.type = 'user_input_received'
        LIMIT 1`,
    ).get(input.sessionId, input.sourceUserSeq) as (RawEventRow & { session_kind: SessionKind }) | undefined;
    // Every dispatching lane needs a persisted graph (the dispatch ledger
    // refuses logical calls without one), so the writer validates the exact
    // accepted USER event — not the session kind. The former chat-only guard
    // here plus the shadow recorder's own made background/workflow/execution
    // dispatch impossible (live 2026-08-11: first tool call of every
    // background run failed LogicalCallPreDispatchAuthorityError).
    if (
      !source
      || source.role !== 'user'
      || source.turn !== input.turn
    ) {
      throw new Error('turn graph source is not the exact accepted user turn');
    }

    const prior = rawTurnGraphEventForSource(db, input.sessionId, input.sourceUserSeq);
    if (prior) {
      const priorData = JSON.parse(prior.data_json) as Record<string, unknown>;
      if (
        prior.turn !== source.turn
        || prior.parent_event_id !== source.id
        || priorData.sourceUserSeq !== input.sourceUserSeq
      ) {
        throw new Error('existing turn graph does not belong to its claimed accepted source');
      }
      return { row: prior, inserted: false };
    }

    const id = randomUUID();
    const now = nowIso();
    db.prepare(
      `INSERT INTO events
         (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
       VALUES (?, ?, ?, 'system', 'turn_graph_compiled', ?, ?, ?)`,
    ).run(
      id,
      input.sessionId,
      input.turn,
      source.id,
      JSON.stringify(input.data),
      now,
    );
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, input.sessionId);
    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as RawEventRow;
    return { row, inserted: true };
  });

  // Shadow observability must not add the connection's normal five-second
  // lock wait to a user turn. If another process owns the eventlog writer, the
  // observation fails open immediately and a later bridge/recovery hook can
  // retry the same exact source.
  const priorBusyTimeout = Number(db.pragma('busy_timeout', { simple: true }));
  let inserted: { row: RawEventRow; inserted: boolean };
  try {
    db.pragma('busy_timeout = 0');
    inserted = append.immediate();
  } finally {
    db.pragma(`busy_timeout = ${Number.isFinite(priorBusyTimeout) ? Math.max(0, Math.floor(priorBusyTimeout)) : 5000}`);
  }

  const event = rowToEvent(inserted.row);
  return inserted.inserted
    ? { event: publishPersistedEvent(event), inserted: true }
    : { event, inserted: false };
}

/**
 * Atomically close one accepted source's private workflow-dispatch batch.
 *
 * The close row is the graph boundary between the foreground SDK invocation
 * and source-group activation. An existing winner is returned unchanged so a
 * retry cannot widen or replace the member set after foreground ownership was
 * released.
 */
export function appendAsyncWorkDispatchBatchClosedOnce(input: {
  sessionId: string;
  turn: number;
  sourceUserSeq: number;
  data: Record<string, unknown>;
}): { event: EventRow; inserted: boolean } {
  if (!input.sessionId || !Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq <= 0) {
    throw new Error('workflow dispatch batch close requires an accepted sourceUserSeq');
  }
  if (
    input.data.originSessionId !== input.sessionId
    || input.data.sourceUserSeq !== input.sourceUserSeq
  ) {
    throw new Error('workflow dispatch batch close payload disagrees with its accepted source');
  }
  const db = openEventLog();
  const append = db.transaction((): { row: RawEventRow; inserted: boolean } => {
    const source = db.prepare(
      `SELECT events.*, sessions.kind AS session_kind
         FROM events
         JOIN sessions ON sessions.id = events.session_id
        WHERE events.session_id = ?
          AND events.seq = ?
          AND events.type = 'user_input_received'
        LIMIT 1`,
    ).get(input.sessionId, input.sourceUserSeq) as (RawEventRow & { session_kind: SessionKind }) | undefined;
    if (
      !source
      || source.session_kind !== 'chat'
      || source.role !== 'user'
      || source.turn !== input.turn
    ) {
      throw new Error('workflow dispatch batch close source is not the exact accepted chat user turn');
    }
    const sourceData = JSON.parse(source.data_json) as Record<string, unknown>;
    if (sourceData.synthetic === true) {
      throw new Error('synthetic input cannot close a workflow dispatch batch');
    }

    const priorRows = db.prepare(
      `SELECT * FROM events
        WHERE session_id = ?
          AND type = 'async_work_dispatch_batch_closed'
          AND json_extract(data_json, '$.sourceUserSeq') = ?
        ORDER BY seq ASC
        LIMIT 2`,
    ).all(input.sessionId, input.sourceUserSeq) as RawEventRow[];
    if (priorRows.length > 1) {
      throw new Error('workflow dispatch batch has ambiguous close winners');
    }
    const prior = priorRows[0];
    if (prior) {
      if (prior.turn !== source.turn || prior.parent_event_id !== source.id) {
        throw new Error('existing workflow dispatch batch close does not belong to its accepted source');
      }
      return { row: prior, inserted: false };
    }

    const id = randomUUID();
    const now = nowIso();
    db.prepare(
      `INSERT INTO events
         (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
       VALUES (?, ?, ?, 'system', 'async_work_dispatch_batch_closed', ?, ?, ?)`,
    ).run(
      id,
      input.sessionId,
      input.turn,
      source.id,
      JSON.stringify(input.data),
      now,
    );
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, input.sessionId);
    return {
      row: db.prepare('SELECT * FROM events WHERE id = ?').get(id) as RawEventRow,
      inserted: true,
    };
  });

  const winner = append.immediate();
  const event = rowToEvent(winner.row);
  return winner.inserted
    ? { event: publishPersistedEvent(event), inserted: true }
    : { event, inserted: false };
}

/** Atomically publish or reuse the single public dispatch winner for one
 * immutable source group. Foreground completion and daemon recovery may race;
 * the SQLite transaction serializes them and rejects any byte-level authority
 * conflict instead of emitting two transport ACKs. */
export function appendAsyncWorkDispatchedOnce(input: {
  sessionId: string;
  turn: number;
  sourceUserSeq: number;
  sourceGroupId: string;
  data: Record<string, unknown>;
}): { event: EventRow; inserted: boolean } {
  const publicDispatch = publicAsyncWorkDispatchedData(input.data);
  if (
    !input.sessionId
    || !Number.isSafeInteger(input.sourceUserSeq)
    || input.sourceUserSeq <= 0
    || !input.sourceGroupId
    || input.data.sourceUserSeq !== input.sourceUserSeq
    || input.data.sourceGroupId !== input.sourceGroupId
    || !publicDispatch
    || publicDispatch.sourceUserSeq !== input.sourceUserSeq
    || publicDispatch.sourceGroupId !== input.sourceGroupId
  ) {
    throw new Error('workflow public dispatch requires one exact source-group identity');
  }
  const db = openEventLog();
  const append = db.transaction((): { row: RawEventRow; inserted: boolean } => {
    const source = db.prepare(
      `SELECT events.*, sessions.kind AS session_kind
         FROM events
         JOIN sessions ON sessions.id = events.session_id
        WHERE events.session_id = ?
          AND events.seq = ?
          AND events.type = 'user_input_received'
        LIMIT 1`,
    ).get(input.sessionId, input.sourceUserSeq) as (RawEventRow & { session_kind: SessionKind }) | undefined;
    if (
      !source
      || source.session_kind !== 'chat'
      || source.role !== 'user'
      || source.turn !== input.turn
    ) {
      throw new Error('workflow public dispatch source is not the exact accepted chat user turn');
    }
    const sourceData = JSON.parse(source.data_json) as Record<string, unknown>;
    if (sourceData.synthetic === true) {
      throw new Error('synthetic input cannot own a workflow public dispatch');
    }
    const sourceTarget = normalizeExactOriginDeliveryTarget(sourceData.originReplyTarget);
    const dispatchTarget = normalizeExactOriginDeliveryTarget(input.data.replyTarget);
    if (
      !sourceTarget
      || !dispatchTarget
      || !sameExactOriginDeliveryTarget(sourceTarget, dispatchTarget)
      || sourceData.originReplyTargetDigest !== exactOriginDeliveryTargetDigest(sourceTarget)
      || input.data.replyTargetDigest !== exactOriginDeliveryTargetDigest(sourceTarget)
    ) {
      throw new Error('workflow public dispatch target disagrees with its accepted source');
    }
    const priorRows = db.prepare(
      `SELECT * FROM events
        WHERE session_id = ?
          AND type = 'async_work_dispatched'
          AND json_extract(data_json, '$.sourceUserSeq') = ?
        ORDER BY seq ASC
        LIMIT 2`,
    ).all(input.sessionId, input.sourceUserSeq) as RawEventRow[];
    if (priorRows.length > 1) {
      throw new Error('workflow public dispatch has ambiguous durable winners');
    }
    const prior = priorRows[0];
    if (prior) {
      const priorData = JSON.parse(prior.data_json) as Record<string, unknown>;
      if (
        prior.role !== 'system'
        || prior.turn !== source.turn
        || prior.parent_event_id !== source.id
        || !isDeepStrictEqual(priorData, input.data)
      ) {
        throw new Error('workflow public dispatch has a conflicting durable winner');
      }
      return { row: prior, inserted: false };
    }

    const id = randomUUID();
    const now = nowIso();
    db.prepare(
      `INSERT INTO events
         (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
       VALUES (?, ?, ?, 'system', 'async_work_dispatched', ?, ?, ?)`,
    ).run(
      id,
      input.sessionId,
      input.turn,
      source.id,
      JSON.stringify(input.data),
      now,
    );
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, input.sessionId);
    return {
      row: db.prepare('SELECT * FROM events WHERE id = ?').get(id) as RawEventRow,
      inserted: true,
    };
  });

  const winner = append.immediate();
  const event = rowToEvent(winner.row);
  return winner.inserted
    ? { event: publishPersistedEvent(event), inserted: true }
    : { event, inserted: false };
}

/**
 * Atomically insert-or-reuse an accepted user input and establish chat restart
 * ownership. This is the no-attempt twin of recordRunAttemptUserInput, used by
 * direct runConversation callers such as the CLI.
 */
function acceptedUserDataWithOriginSnapshot(
  db: Database.Database,
  sessionId: string,
  role: string,
  rawData: Record<string, unknown>,
): Record<string, unknown> {
  if (role !== 'user' || rawData.synthetic === true) return rawData;
  const explicitTargetPresent = Object.prototype.hasOwnProperty.call(rawData, 'originReplyTarget')
    || Object.prototype.hasOwnProperty.call(rawData, 'originReplyTargetDigest');
  const explicitTarget = normalizeExactOriginDeliveryTarget(rawData.originReplyTarget);
  const explicitDigest = typeof rawData.originReplyTargetDigest === 'string'
    ? rawData.originReplyTargetDigest
    : '';
  if (
    explicitTargetPresent
    && (!explicitTarget || explicitDigest !== exactOriginDeliveryTargetDigest(explicitTarget))
  ) {
    throw new Error('accepted user source has invalid explicit origin reply authority');
  }
  const sessionSnapshot = db.prepare(
    'SELECT kind, channel, metadata_json FROM sessions WHERE id = ?',
  ).get(sessionId) as {
    kind?: unknown;
    channel?: unknown;
    metadata_json?: unknown;
  } | undefined;
  if (sessionSnapshot?.kind !== 'chat') return rawData;
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(sessionSnapshot.metadata_json ?? '{}')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>;
    }
  } catch { /* invalid session metadata fails to bind an exact route */ }
  const target = explicitTarget ?? exactOriginDeliveryTargetFromSessionSnapshot({
    channel: typeof sessionSnapshot.channel === 'string' ? sessionSnapshot.channel : null,
    metadata,
  });
  return target
    ? {
        ...rawData,
        originReplyTarget: target,
        originReplyTargetDigest: exactOriginDeliveryTargetDigest(target),
      }
    : rawData;
}

export function acceptUserInputForRun(
  input: Omit<AppendEventInput, 'type'>,
  options: { existingEventSeq?: number } = {},
): EventRow {
  const db = openEventLog();
  const id = randomUUID();
  const now = nowIso();
  const shouldArm = (process.env.CLEMMY_CHAT_RESTART_RECOVERY ?? 'on').toLowerCase() !== 'off';
  const tx = db.transaction((): { event: EventRow; inserted: boolean } => {
    const armAcceptedChat = (): void => {
      if (!shouldArm) return;
      db.prepare(
        `UPDATE sessions
            SET metadata_json = json_set(
                  metadata_json,
                  '$.__run_in_flight',
                  COALESCE(json_extract(metadata_json, '$.__run_in_flight'), ?)
                ),
                updated_at = ?
          WHERE id = ? AND kind = 'chat'`,
      ).run(now, now, input.sessionId);
    };

    if (options.existingEventSeq !== undefined) {
      const existing = db.prepare('SELECT * FROM events WHERE seq = ?').get(
        options.existingEventSeq,
      ) as RawEventRow | undefined;
      if (!existing || existing.session_id !== input.sessionId || existing.type !== 'user_input_received') {
        throw new Error(`event ${options.existingEventSeq} is not a user input for session ${input.sessionId}`);
      }
      armAcceptedChat();
      return { event: rowToEvent(existing), inserted: false };
    }

    const acceptedData = acceptedUserDataWithOriginSnapshot(
      db,
      input.sessionId,
      input.role,
      input.data ?? {},
    );
    db.prepare(
      `INSERT INTO events
         (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
       VALUES (?, ?, ?, ?, 'user_input_received', ?, ?, ?)`,
    ).run(
      id,
      input.sessionId,
      input.turn,
      input.role,
      input.parentEventId ?? null,
      JSON.stringify(acceptedData),
      now,
    );
    const inserted = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as RawEventRow;
    armAcceptedChat();
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, input.sessionId);
    return { event: rowToEvent(inserted), inserted: true };
  });
  const result = tx();
  return result.inserted ? publishPersistedEvent(result.event) : result.event;
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
  options: {
    existingEventSeq?: number;
    /** Atomically establish restart ownership beside source insert/binding.
     * Chat-only and honors CLEMMY_CHAT_RESTART_RECOVERY=off. */
    armRunInFlight?: boolean;
  } = {},
): EventRow {
  const db = openEventLog();
  const id = randomUUID();
  const now = nowIso();
  const shouldArmRunInFlight = options.armRunInFlight === true
    && (process.env.CLEMMY_CHAT_RESTART_RECOVERY ?? 'on').toLowerCase() !== 'off';
  const tx = db.transaction((): { event: EventRow; inserted: boolean } => {
    const armAcceptedChat = (): void => {
      if (!shouldArmRunInFlight) return;
      db.prepare(
        `UPDATE sessions
            SET metadata_json = json_set(
                  metadata_json,
                  '$.__run_in_flight',
                  COALESCE(json_extract(metadata_json, '$.__run_in_flight'), ?)
                ),
                updated_at = ?
          WHERE id = ? AND kind = 'chat'`,
      ).run(now, now, attempt.sessionId);
    };
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
      armAcceptedChat();
      return { event: rowToEvent(existing), inserted: false };
    }

    const acceptedData = acceptedUserDataWithOriginSnapshot(
      db,
      attempt.sessionId,
      input.role,
      input.data ?? {},
    );
    const data = JSON.stringify(acceptedData);

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
    armAcceptedChat();
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
  const rawSourceUserSeq = input.data?.sourceUserSeq;
  const sourceUserSeq = Number.isSafeInteger(rawSourceUserSeq) && Number(rawSourceUserSeq) > 0
    ? Number(rawSourceUserSeq)
    : null;
  const findByLogicalSource = (): RawEventRow | undefined => {
    if (sourceUserSeq === null) return undefined;
    return openEventLog().prepare(
      `SELECT * FROM events
        WHERE session_id = ?
          AND type = 'conversation_completed'
          AND (
            json_extract(data_json, '$.sourceUserSeq') = ?
            OR json_extract(data_json, '$.presentation.identity.sourceUserSeq') = ?
            OR json_extract(data_json, '$.terminalKey') = ?
          )
        ORDER BY seq ASC
        LIMIT 1`,
    ).get(input.sessionId, sourceUserSeq, sourceUserSeq, `turn:${sourceUserSeq}`) as RawEventRow | undefined;
  };

  // Upgrade bridge: a typed 3.5 row may already own this exact source under a
  // brain:<attempt> key. It is still the durable first writer; never append a
  // parallel turn:<source> row beside it.
  const logicalWinner = findByLogicalSource();
  if (logicalWinner) {
    return {
      event: sourceUserSeq === null
        ? rowToEvent(logicalWinner)
        : validatePersistedTerminalPublicationWinner(
          openEventLog(),
          logicalWinner,
          input.sessionId,
          sourceUserSeq,
        ),
      inserted: false,
    };
  }
  try {
    const event = appendEvent({
      ...input,
      type: 'conversation_completed',
      data: {
        ...(input.data ?? {}),
        terminalKey: key,
        ...(sourceUserSeq !== null ? { logicalTerminalVersion: 1 } : {}),
      },
    });
    return { event, inserted: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/unique constraint failed|logical terminal source already exists/i.test(message)) throw err;
    const row = findByLogicalSource() ?? openEventLog().prepare(
      `SELECT * FROM events
        WHERE session_id = ?
          AND type = 'conversation_completed'
          AND json_extract(data_json, '$.terminalKey') = ?
        LIMIT 1`,
    ).get(input.sessionId, key) as RawEventRow | undefined;
    if (!row) throw err;
    return {
      event: sourceUserSeq === null
        ? rowToEvent(row)
        : validatePersistedTerminalPublicationWinner(
          openEventLog(),
          row,
          input.sessionId,
          sourceUserSeq,
        ),
      inserted: false,
    };
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

/**
 * Bounded global recovery query for workflow batches that crossed the durable
 * foreground close boundary but have no public dispatch winner yet. Oldest
 * first lets repeated daemon ticks drain an arbitrarily large backlog without
 * loading unrelated event payloads or every session into memory.
 */
export function listPendingAsyncWorkDispatchBatchClosedEvents(limit = 200): EventRow[] {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 500)) : 200;
  const rows = openEventLog().prepare(
    `SELECT closed.*
       FROM events AS closed
      WHERE closed.type = 'async_work_dispatch_batch_closed'
        AND NOT EXISTS (
          SELECT 1
            FROM events AS published
           WHERE published.session_id = closed.session_id
             AND published.type = 'async_work_dispatched'
             AND json_extract(published.data_json, '$.sourceGroupId') = json_extract(closed.data_json, '$.sourceGroupId')
             AND json_extract(published.data_json, '$.sourceUserSeq') = json_extract(closed.data_json, '$.sourceUserSeq')
        )
      ORDER BY closed.seq ASC
      LIMIT ?`,
  ).all(boundedLimit) as RawEventRow[];
  return rows.map(rowToEvent);
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
  // workflow recovery review).
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

/** DAEMON-BOOT recovery (workflow recovery review): at daemon startup
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
// unqueryable — not just unshown.
// Raised 2MB → 16MB (2026-08-05, owner ask): 2MB was the hard wall on the
// large-dataset class ("reconcile two 10MB exports") — the tail of a big pull
// became unqueryable and the loss was unrecoverable by ANY reader. The win is
// NOT reading 16MB into context (the event-log clip, digest, and recall
// budget still gate that): it is that tool_output_query filters/projects/
// paginates IN CODE against this store, so a 10MB record set stays fully
// queryable and only matching rows ever reach the model. Costs disk + an
// occasional ~100-300ms JSON.parse on query — the 14-day retention sweep
// below bounds aggregate disk. The tail-truncate + truncated_at_write marker
// (surfaced to the model by recall_tool_result) stays as the backstop for the
// pathological >16MB case.
export const TOOL_OUTPUT_MAX_BYTES = 16_000_000;

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
  /** Exact harness invocation identity. When present, the bytes are also stored
   * under (session, call, nonce) for settlement/readback evidence. */
  invocationNonce?: string | null;
}

/**
 * Persist the full tool output keyed by (session_id, call_id) so the
 * recall_tool_result tool can retrieve it after the event-log copy is
 * clipped. Capped at TOOL_OUTPUT_MAX_BYTES with an explicit
 * truncated_at_write marker — distinct from the per-turn `[clipped: ...]`
 * stub Layer 1 emits.
 *
 * Idempotent on conflict: `(session_id, call_id)` remains the legacy recall key
 * and keeps the longest representation. Nonce-bearing formatter writes also
 * replace the exact row for THAT invocation; other invocations and later
 * nonce-less hook writes cannot overwrite those evidence bytes.
 */
export function writeToolOutput(input: WriteToolOutputInput): void {
  const db = openEventLog();
  const original = input.output;
  const originalBytes = Buffer.byteLength(original, 'utf8');
  const invocationNonce = input.invocationNonce?.trim() || null;

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
  const createdAt = nowIso();
  const tx = db.transaction(() => {
    // Keep the canonical recall row's longest representation with one SQLite
    // conflict decision. A read-before-write check races across daemon/worker
    // processes and can let a later compact hook overwrite a larger result.
    db.prepare(
      `INSERT INTO tool_outputs
         (session_id, call_id, tool, output_full, content_bytes, truncated_at_write, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, call_id) DO UPDATE SET
         tool = excluded.tool,
         output_full = excluded.output_full,
         content_bytes = excluded.content_bytes,
         truncated_at_write = excluded.truncated_at_write,
         created_at = excluded.created_at
       WHERE excluded.content_bytes >= tool_outputs.content_bytes`,
    ).run(
      input.sessionId,
      input.callId,
      input.tool ?? null,
      stored,
      originalBytes,
      truncated ? 1 : 0,
      createdAt,
    );
    if (invocationNonce) {
      db.prepare(
        `INSERT OR REPLACE INTO tool_output_invocations
           (session_id, call_id, invocation_nonce, tool, output_full, content_bytes, truncated_at_write, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.sessionId,
        input.callId,
        invocationNonce,
        input.tool ?? null,
        stored,
        originalBytes,
        truncated ? 1 : 0,
        createdAt,
      );
    }
  });
  tx();
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
/**
 * Age sweep for harness_chat_request_cancellations (2026-07-22 legacy audit):
 * deliberately FK-less (a Stop can precede its session), so the session-cascade
 * reap that bounds the rest of harness.db misses it. Tombstones older than the
 * session-retention window can never match a live replay.
 */
export function reapStaleChatCancellations(maxAgeDays = 14): number {
  try {
    const db = openEventLog();
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    return db.prepare('DELETE FROM harness_chat_request_cancellations WHERE requested_at < ?').run(cutoff).changes;
  } catch {
    return 0;
  }
}

export function reapStaleToolOutputs(maxAgeDays?: number): number {
  const env = process.env.CLEMMY_TOOL_OUTPUT_TTL_DAYS;
  const ttl = maxAgeDays ?? (env ? Math.max(1, Math.min(365, Number(env))) : 14);
  if (!Number.isFinite(ttl) || ttl <= 0) return 0;
  const db = openEventLog();
  const cutoff = `-${Math.floor(ttl)} days`;
  const reap = db.transaction(() => {
    const canonical = db
      .prepare(`DELETE FROM tool_outputs WHERE created_at < datetime('now', ?)`)
      .run(cutoff).changes;
    // v19's nonce-keyed rows hold the same full payload bytes as the canonical
    // recall store and need the same bounded retention.  Preserve evidence for
    // a write reservation that still has no terminal child: reconciliation of
    // a genuinely uncertain provider write is more important than reclaiming
    // those few rows, while every settled/read-only invocation remains bounded.
    const exact = db.prepare(`
      DELETE FROM tool_output_invocations
       WHERE tool_output_invocations.created_at < datetime('now', ?)
         AND NOT EXISTS (
           SELECT 1
             FROM events AS reserved
            WHERE reserved.session_id = tool_output_invocations.session_id
              AND reserved.type = 'external_write'
              AND json_extract(reserved.data_json, '$.callId') = tool_output_invocations.call_id
              AND NOT EXISTS (
                SELECT 1
                  FROM events AS settled
                 WHERE settled.parent_event_id = reserved.id
                   AND settled.type IN ('external_write_succeeded', 'external_write_failed')
              )
         )
    `).run(cutoff).changes;
    return canonical + exact;
  });
  return reap();
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

export function getToolOutputForInvocation(
  sessionId: string,
  callId: string,
  invocationNonce: string,
): ToolOutputRecord | null {
  const row = openEventLog().prepare(
    `SELECT output_full, content_bytes, truncated_at_write, tool, created_at
       FROM tool_output_invocations
      WHERE session_id = ? AND call_id = ? AND invocation_nonce = ?`,
  ).get(sessionId, callId, invocationNonce) as {
    output_full: string;
    content_bytes: number;
    truncated_at_write: number;
    tool: string | null;
    created_at: string;
  } | undefined;
  if (!row) return null;
  return {
    output: row.output_full,
    contentBytes: row.content_bytes,
    truncatedAtWrite: row.truncated_at_write === 1,
    tool: row.tool,
    createdAt: row.created_at,
  };
}

export interface ToolOutputInvocationRecord extends ToolOutputRecord {
  invocationNonce: string;
}

/** All exact invocations that reused one SDK call id. Callers that need
 * evidence authority must require exactly one row; the canonical call-id store
 * is intentionally unsuitable because it keeps the longest presentation. */
export function listToolOutputInvocations(
  sessionId: string,
  callId: string,
): ToolOutputInvocationRecord[] {
  const rows = openEventLog().prepare(
    `SELECT invocation_nonce, output_full, content_bytes, truncated_at_write, tool, created_at
       FROM tool_output_invocations
      WHERE session_id = ? AND call_id = ?
      ORDER BY created_at ASC, invocation_nonce ASC`,
  ).all(sessionId, callId) as Array<{
    invocation_nonce: string;
    output_full: string;
    content_bytes: number;
    truncated_at_write: number;
    tool: string | null;
    created_at: string;
  }>;
  return rows.map((row) => ({
    invocationNonce: row.invocation_nonce,
    output: row.output_full,
    contentBytes: row.content_bytes,
    truncatedAtWrite: row.truncated_at_write === 1,
    tool: row.tool,
    createdAt: row.created_at,
  }));
}

export type AuthorityToolOutputResolution =
  | {
      status: 'ok';
      record: ToolOutputRecord;
      source: 'exact' | 'legacy';
      /** Effect proven by the sole parented lifecycle. Detached exact rows have
       * no effect authority and therefore expose null. */
      effect: string | null;
      /** Exact accepted user source shared by the parented call/return pair.
       * Legacy or detached rows expose null and cannot satisfy a source-scoped
       * authority request. */
      sourceUserSeq: number | null;
    }
  | { status: 'missing' }
  | { status: 'failed'; reason: string }
  | { status: 'ambiguous'; invocationCount: number; reason?: string };

interface DurableToolOutputOccurrence {
  call: EventRow;
  returned: EventRow;
  tool: string;
  effect: string | null;
  sourceUserSeq: number | null;
  /** Explicit terminal success when the transport supplied it. Older SDK
   * lifecycle rows legitimately omit this field and remain null. */
  explicitOk: boolean | null;
}

function authorityEventString(
  event: EventRow,
  field: 'callId' | 'tool' | 'effect' | 'effectiveTool',
): string {
  const value = event.data[field];
  return typeof value === 'string' ? value.trim() : '';
}

function authorityEventSourceUserSeq(event: EventRow): number | null {
  const value = event.data.sourceUserSeq;
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function durableReturnExplicitOk(returned: EventRow): boolean | null {
  const data = returned.data;
  for (const field of ['ok', 'successful', 'success'] as const) {
    const value = data[field];
    if (value === false) return false;
  }
  if (data.failed === true || data.error === true) return false;
  if (typeof data.error === 'string' && data.error.trim()) return false;
  if (Array.isArray(data.errors) && data.errors.length > 0) return false;
  for (const field of ['ok', 'successful', 'success'] as const) {
    if (data[field] === true) return true;
  }
  return null;
}

const DERIVED_TOOL_OUTPUT_READERS = ['recall_tool_result', 'tool_output_query'] as const;
const DERIVED_READER_AUTHORITY_REASON =
  'derived tool-output reader is presentation-only and has no independent evidence authority';

type LegacyCallToolTarget =
  | { status: 'ok'; name: string }
  | { status: 'invalid' };

/** Before effectiveTool was durable, call_tool's only inner-identity record was
 *  its bounded raw argument preview. Accept that legacy evidence only when the
 *  complete outer schema and inner JSON object are both exact. A clipped,
 *  malformed, recursive, or widened carrier has no safe authority identity. */
function legacyCallToolTarget(call: EventRow): LegacyCallToolTarget {
  let parsed: unknown = call.data.arguments;
  if (typeof parsed === 'string') {
    const raw = parsed.trim();
    if (!raw.startsWith('{') || !raw.endsWith('}')) return { status: 'invalid' };
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { status: 'invalid' };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'invalid' };
  const input = parsed as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== 'args_json' || keys[1] !== 'name') return { status: 'invalid' };
  if (typeof input.name !== 'string' || typeof input.args_json !== 'string') return { status: 'invalid' };
  const name = input.name.trim();
  if (
    !name
    || name.length > 256
    || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(name)
    || isPlainOrClementineLocalTool(name, 'call_tool')
  ) return { status: 'invalid' };
  try {
    // The live carrier treats an empty string as `{}` for no-argument tools;
    // mirror that exact legacy dispatch contract instead of dropping a genuine
    // provider read solely because its serialized args were empty.
    const rawArgs = input.args_json.trim();
    const args = rawArgs ? JSON.parse(rawArgs) as unknown : {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
  return { status: 'ok', name };
}

/** These readers render bytes from another tool occurrence for the model. Their
 *  response also contains harness-generated headers and model-selected query
 *  fields/offsets, so it is presentation state rather than a second independent
 *  provider observation. The original producer call remains the authority. */
function derivedToolOutputReaderFailureReason(
  record: ToolOutputRecord,
  occurrence: DurableToolOutputOccurrence | null,
): string | null {
  // Current lifecycle rows persist the transport-normalized inner identity on
  // both call and return. Prefer that parity-verified identity before looking
  // at the outer producer name: Claude records some foreign MCP tools under
  // their tail (for example `recall_tool_result`) while retaining the foreign
  // namespace only in `effectiveTool`.
  const effectiveTool = occurrence
    ? authorityEventString(occurrence.call, 'effectiveTool')
    : '';
  if (effectiveTool) {
    return DERIVED_TOOL_OUTPUT_READERS.some((tool) =>
      isPlainOrClementineLocalTool(effectiveTool, tool)
    ) ? DERIVED_READER_AUTHORITY_REASON : null;
  }
  const producer = occurrence?.tool || record.tool || '';
  if (DERIVED_TOOL_OUTPUT_READERS.some((tool) =>
    isPlainOrClementineLocalTool(producer, tool)
  )) return DERIVED_READER_AUTHORITY_REASON;
  // A generic discovery carrier inherits this policy only from the compact
  // identity that was persisted on BOTH sides of its durable lifecycle. A
  // foreign MCP tool with the same tail is deliberately not shadowed.
  if (!occurrence || !isPlainOrClementineLocalTool(producer, 'call_tool')) return null;
  const legacyTarget = legacyCallToolTarget(occurrence.call);
  if (legacyTarget.status !== 'ok') {
    return 'legacy call_tool output lacks durable effective identity and exact well-formed arguments';
  }
  return DERIVED_TOOL_OUTPUT_READERS.some((tool) =>
    isPlainOrClementineLocalTool(legacyTarget.name, tool)
  ) ? DERIVED_READER_AUTHORITY_REASON : null;
}

function authorityOutputFailureReason(
  record: ToolOutputRecord,
  occurrence: DurableToolOutputOccurrence | null,
): string | null {
  if (occurrence?.explicitOk === false) return 'durable tool lifecycle explicitly failed';
  if (!toolOutputLooksSuccessful(record.output, occurrence?.explicitOk ?? undefined)) {
    return 'stored tool output is failure-shaped';
  }
  const derivedReaderReason = derivedToolOutputReaderFailureReason(record, occurrence);
  if (derivedReaderReason) return derivedReaderReason;
  return null;
}

/** Resolve one call-id occurrence only when the durable lifecycle itself is
 * unambiguous. A call id is an SDK presentation identifier, not invocation
 * identity: retries may reuse it. `parent_event_id` is therefore part of the
 * proof, not optional telemetry. */
function durableToolOutputOccurrence(
  sessionId: string,
  callId: string,
): {
  occurrence: DurableToolOutputOccurrence | null;
  callCount: number;
  returnCount: number;
  reason?: string;
} {
  // Intentionally no ORDER BY: a valid authority has exactly one call and one
  // return and validates their seq relationship below. Ordering here makes
  // SQLite choose the broad session/seq index instead of the existing
  // call-lifecycle expression index on long sessions.
  const events = openEventLog().prepare(`
    SELECT seq, id, session_id, turn, role, type, parent_event_id, data_json, created_at
      FROM events
     WHERE session_id = ?
       AND type IN ('tool_called', 'tool_returned')
       AND json_extract(data_json, '$.callId') = ?
  `).all(sessionId, callId).map((row) => rowToEvent(row as RawEventRow));
  // A deterministic replay remains a canonical model attempt in the audit,
  // but it is not a second provider observation. Remove its parented pair from
  // authority occurrence counting so a later REAL invocation that legitimately
  // reuses the SDK call id can still prove its own fresh bytes.
  const replayParentIds = new Set(events
    .filter((event) => event.type === 'tool_returned'
      && isSettledReadReplayReturnData(event.data)
      && typeof event.parentEventId === 'string')
    .map((event) => event.parentEventId as string));
  const calls = events.filter((event) =>
    event.type === 'tool_called' && authorityEventString(event, 'callId') === callId
      && !replayParentIds.has(event.id)
  );
  const returns = events.filter((event) =>
    event.type === 'tool_returned' && authorityEventString(event, 'callId') === callId
      && !isSettledReadReplayReturnData(event.data)
  );
  if (calls.length !== 1 || returns.length !== 1) {
    return {
      occurrence: null,
      callCount: calls.length,
      returnCount: returns.length,
      reason: `durable lifecycle has ${calls.length} call record(s) and ${returns.length} return record(s)`,
    };
  }
  const call = calls[0];
  const returned = returns[0];
  const callTool = authorityEventString(call, 'tool');
  const returnTool = authorityEventString(returned, 'tool');
  const callEffect = authorityEventString(call, 'effect');
  const returnEffect = authorityEventString(returned, 'effect');
  const callEffectiveTool = authorityEventString(call, 'effectiveTool');
  const returnEffectiveTool = authorityEventString(returned, 'effectiveTool');
  if (
    returned.parentEventId !== call.id
    || returned.seq <= call.seq
    || !callTool
    || callTool !== returnTool
    || callEffect !== returnEffect
    || callEffectiveTool !== returnEffectiveTool
  ) {
    return {
      occurrence: null,
      callCount: 1,
      returnCount: 1,
      reason: 'durable call/return identity does not form one matching parented occurrence',
    };
  }
  return {
    occurrence: {
      call,
      returned,
      tool: callTool,
      effect: callEffect || null,
      sourceUserSeq: (() => {
        const callSource = authorityEventSourceUserSeq(call);
        const returnSource = authorityEventSourceUserSeq(returned);
        return callSource !== null && callSource === returnSource ? callSource : null;
      })(),
      explicitOk: durableReturnExplicitOk(returned),
    },
    callCount: 1,
    returnCount: 1,
  };
}

function outputFallsWithinOccurrence(
  record: ToolOutputRecord,
  occurrence: DurableToolOutputOccurrence,
): boolean {
  return record.tool === occurrence.tool
    && record.createdAt >= occurrence.call.createdAt
    && record.createdAt <= occurrence.returned.createdAt;
}

/** Resolve bytes for a value that may authorize a later action. Reporting and
 * recall may intentionally use the canonical longest row; authority consumers
 * must use this function so a reused call id can never select stale bytes. */
export function resolveToolOutputForAuthority(
  sessionId: string,
  callId: string,
): AuthorityToolOutputResolution {
  const invocations = listToolOutputInvocations(sessionId, callId);
  if (invocations.length > 1) {
      return { status: 'ambiguous', invocationCount: invocations.length };
  }
  const lifecycle = durableToolOutputOccurrence(sessionId, callId);
  if (invocations.length === 1) {
    // Detached/internal formatter paths do not always have SDK lifecycle events.
    // One nonce row is still exact in that case. But once ANY durable lifecycle
    // exists, it must prove precisely one matching occurrence. Otherwise a later
    // hook-only invocation may have reused the call id without writing a nonce,
    // and the lone row can be stale authority from the earlier call.
    if (lifecycle.callCount === 0 && lifecycle.returnCount === 0) {
      const failureReason = authorityOutputFailureReason(invocations[0], null);
      if (failureReason) return { status: 'failed', reason: failureReason };
      return {
        status: 'ok', record: invocations[0], source: 'exact', effect: null, sourceUserSeq: null,
      };
    }
    if (
      lifecycle.occurrence
      && outputFallsWithinOccurrence(invocations[0], lifecycle.occurrence)
    ) {
      const failureReason = authorityOutputFailureReason(invocations[0], lifecycle.occurrence);
      if (failureReason) return { status: 'failed', reason: failureReason };
      return {
        status: 'ok',
        record: invocations[0],
        source: 'exact',
        effect: lifecycle.occurrence.effect,
        sourceUserSeq: lifecycle.occurrence.sourceUserSeq,
      };
    }
    return {
      status: 'ambiguous',
      invocationCount: Math.max(1, lifecycle.callCount, lifecycle.returnCount),
      reason: lifecycle.reason ?? 'exact output does not match the sole durable invocation',
    };
  }
  const legacy = getToolOutput(sessionId, callId);
  if (!legacy) return { status: 'missing' };
  // Migrated pre-v19 rows have no nonce. They retain authority only when one
  // parented lifecycle pair proves the producer was the same READ/COMPUTE tool
  // and the longest-wins row was actually written inside that occurrence.
  // Anything less would let a reused id promote stale provider bytes.
  if (
    lifecycle.occurrence
    && (lifecycle.occurrence.effect === 'read' || lifecycle.occurrence.effect === 'compute')
    && outputFallsWithinOccurrence(legacy, lifecycle.occurrence)
  ) {
    const failureReason = authorityOutputFailureReason(legacy, lifecycle.occurrence);
    if (failureReason) return { status: 'failed', reason: failureReason };
    return {
      status: 'ok',
      record: legacy,
      source: 'legacy',
      effect: lifecycle.occurrence.effect,
      sourceUserSeq: lifecycle.occurrence.sourceUserSeq,
    };
  }
  return {
    status: 'ambiguous',
    invocationCount: Math.max(1, lifecycle.callCount, lifecycle.returnCount),
    reason: lifecycle.reason ?? 'legacy output lacks one matching read/compute lifecycle occurrence',
  };
}

export interface AuthorityToolOutputRecord extends ToolOutputRecord {
  callId: string;
  effect: string | null;
  sourceUserSeq: number | null;
}

/** Convert presentation/search rows into evidence rows.  Candidate bytes are
 * never trusted: each call id is re-resolved to its exact durable invocation,
 * and reused/ambiguous ids disappear.  With `readOrComputeOnly`, a detached
 * formatter row or write/send confirmation also disappears. */
export function resolveToolOutputsForAuthority(
  sessionId: string,
  candidates: readonly { callId: string }[],
  options: { readOrComputeOnly?: boolean; allowedSourceUserSeqs?: readonly number[] } = {},
): AuthorityToolOutputRecord[] {
  const resolved: AuthorityToolOutputRecord[] = [];
  const seen = new Set<string>();
  const allowedSources = options.allowedSourceUserSeqs === undefined
    ? null
    : new Set(options.allowedSourceUserSeqs.filter((value) => Number.isSafeInteger(value) && value > 0));
  for (const candidate of candidates) {
    const callId = candidate.callId.trim();
    if (!callId || seen.has(callId)) continue;
    seen.add(callId);
    const authority = resolveToolOutputForAuthority(sessionId, callId);
    if (authority.status !== 'ok') continue;
    if (
      options.readOrComputeOnly
      && authority.effect !== 'read'
      && authority.effect !== 'compute'
    ) continue;
    if (
      allowedSources
      && (authority.sourceUserSeq === null || !allowedSources.has(authority.sourceUserSeq))
    ) continue;
    resolved.push({
      callId,
      ...authority.record,
      effect: authority.effect,
      sourceUserSeq: authority.sourceUserSeq,
    });
  }
  return resolved;
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
