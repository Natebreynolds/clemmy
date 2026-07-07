import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { WORKFLOWS_DIR } from '../memory/vault.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import type { WorkflowStepInput } from '../memory/workflow-store.js';
import { isOperationalEventType, recordOperationalEvent, type OperationalEventSeverity, type OperationalEventSource, type OperationalEventType } from '../runtime/operational-telemetry.js';

/**
 * Append-only event log per workflow run — the durability layer.
 *
 * Layout:
 *   ~/.clementine-next/vault/00-System/workflows/<name>/runs/<runId>/
 *     events.jsonl
 *
 * One JSON object per line, written atomically (single appendFileSync
 * call per event). On daemon restart, the workflow runner scans every
 * in-flight run's events.jsonl, replays the log to reconstruct what
 * already completed, and resumes from the next pending step. This is
 * the same pattern LangGraph uses with its thread-id checkpointer —
 * just file-based, because Clementine is a local-first desktop app
 * and does not need (or want) Postgres or Temporal infrastructure.
 *
 * Why append-only:
 *   - Survives process crashes mid-write (worst case: one truncated
 *     trailing line, which the reader skips).
 *   - Survives multiple processes touching the same log (each event
 *     is one atomic write — no read-modify-write hazard).
 *   - Cheap to inspect: `tail -f events.jsonl` is the live transcript.
 *
 * Why JSONL instead of a SQL table:
 *   - Per-run events are coupled to per-run state. The events.jsonl
 *     lives inside the run's own directory; deleting a workflow or a
 *     run is one rm -rf away.
 *   - The SQLite memory layer is for cross-session truth; this is
 *     ephemeral execution state that gets summarized into the run
 *     record when the workflow completes.
 */

export type WorkflowEventKind =
  | 'run_started'         // workflow run kicked off
  | 'run_completed'       // workflow finished successfully
  | 'run_failed'          // workflow halted with an error
  | 'run_cancelled'       // workflow was abandoned by the user/operator
  | 'run_paused'          // explicit pause (approval gate, user pause)
  | 'run_resumed'         // resumed after pause / daemon restart
  | 'run_summary'         // structured "succeeded because X + artifacts (files/URLs/counts)" at completion
  | 'step_started'        // single-shot or container step started
  | 'step_completed'      // step finished — output is the final result
  | 'step_failed'         // step errored
  | 'step_retry'          // step failed transiently; retrying after backoff
  | 'step_loop_retry'     // loopUntil: output contract failed; re-running with evidence
  | 'attempt_record'      // STATE: a comparable per-attempt record (what was tried, what changed, what it cost)
  | 'step_advisory'       // step completed but a non-failing quality check flagged it (skill-execution miss)
  | 'step_skipped'        // step was a no-op (forEach over empty list, condition)
  | 'workflow_graph_created'         // graph snapshot compiled/created for the run
  | 'workflow_node_ready'            // graph node dependencies satisfied
  | 'workflow_node_started'          // graph node execution started
  | 'workflow_node_completed'        // graph node execution completed
  | 'workflow_node_failed'           // graph node execution failed
  | 'workflow_branch_evaluated'      // condition node chose branch edge(s)
  | 'workflow_graph_patch_proposed'  // model/system proposed graph mutation
  | 'workflow_graph_patch_applied'   // graph mutation validated and applied
  | 'workflow_graph_patch_rejected'  // graph mutation failed validation
  | 'workflow_checkpoint_created'    // durable checkpoint before risky work
  | 'workflow_rollback_started'      // compensating/rollback path started
  | 'workflow_rollback_completed'    // compensating/rollback path completed
  | 'workflow_trigger_fired'         // manual/schedule/webhook/system trigger fired
  | 'workflow_trigger_deduped'       // trigger was ignored due to dedupe
  | 'workflow_resume_replayed'       // run replayed events after restart
  | 'item_started'        // one iteration of a forEach step started
  | 'item_completed'      // one iteration of a forEach step done
  | 'item_retry'          // one iteration failed TRANSIENTLY; retrying that item after backoff (W1b)
  | 'item_failed'         // one iteration of a forEach step failed
  | 'tool_called'         // diagnostic — tool name + args (truncated)
  | 'tool_result'         // diagnostic — tool result (truncated)
  | 'approval_requested'  // workflow waiting on user approval
  | 'approval_granted'    // user said yes
  | 'approval_rejected'   // user said no
  | 'transcript_chunk';   // streaming text from LLM, for live UI

/**
 * STATE pillar (Loop Engineering): a comparable record of ONE attempt at a step,
 * so the self-improvement phase can query "what was tried, what changed between
 * attempts, and what each attempt cost" — instead of only "a retry happened".
 * Emitted per FAILED-then-retried loopUntil attempt (the successful/exhausting
 * final outcome is already captured by step_completed / step_failed).
 */
export interface AttemptRecord {
  /** 1-based index of the attempt this record describes (the one that just failed). */
  attemptIndex: number;
  /** The loopUntil ceiling for context (e.g. "2 of 3"). */
  maxAttempts: number;
  /** The contract problems that failed THIS attempt (the criterion delta). */
  failedProblems: string[];
  /** Human/agent-readable diff vs the prior attempt: fixed / new / still-failing. */
  changeSummary: string;
  /** What this attempt cost. durationMs is exact; tokens/toolCalls are a
   *  best-effort snapshot-diff over the step's deterministic session (absent if
   *  the session couldn't be read). */
  metrics: { durationMs?: number; tokens?: number; toolCalls?: number };
}

export interface WorkflowEvent {
  t: string;                          // ISO timestamp
  kind: WorkflowEventKind;
  stepId?: string;                    // owning step (when applicable)
  itemKey?: string;                   // forEach iteration identifier
  /** Output payload, truncated to ~32KB so the log stays small. */
  output?: unknown;
  /** Error string when kind === '*_failed'. */
  error?: string;
  /** Free-form metadata (tool name, model, attempt count, etc.). */
  meta?: Record<string, unknown>;
  /** Structured per-attempt record (kind === 'attempt_record'). */
  attempt?: AttemptRecord;
}

const MAX_PAYLOAD_BYTES = 32 * 1024;

function runDir(workflowName: string, runId: string): string {
  return path.join(WORKFLOWS_DIR, workflowName, 'runs', runId);
}

/** Delete a run's event-log directory (best-effort). Called by the run-record
 *  reaper so the per-workflow events.jsonl dirs are removed TOGETHER with the
 *  flat record — otherwise they accumulate orphaned (P0-2: 334 dirs vs 122
 *  records) and a reaped run's lingering log used to read as phantom-pending. */
export function reapRunEventDir(workflowName: string, runId: string): void {
  try { rmSync(runDir(workflowName, runId), { recursive: true, force: true }); } catch { /* best-effort */ }
}

function eventsPath(workflowName: string, runId: string): string {
  return path.join(runDir(workflowName, runId), 'events.jsonl');
}

function ensureRunDir(workflowName: string, runId: string): string {
  const dir = runDir(workflowName, runId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Compact large payloads so the events log doesn't balloon. Strings
 * over MAX_PAYLOAD_BYTES are tail-truncated; objects/arrays are
 * stringified and capped. Crucially, the original value's type is
 * preserved (string stays string, object stays object) so downstream
 * consumers don't need to special-case the truncation marker.
 */
function compactPayload(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf-8');
    if (bytes <= MAX_PAYLOAD_BYTES) return value;
    // Tail-truncate: keep the head, prepend a notice. The model's
    // useful output is almost always at the start of a long response.
    return value.slice(0, MAX_PAYLOAD_BYTES - 64) + `\n\n[…truncated ${bytes - MAX_PAYLOAD_BYTES + 64} bytes…]`;
  }
  if (typeof value !== 'object') return value;
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf-8') <= MAX_PAYLOAD_BYTES) return value;
  return { truncated: true, preview: json.slice(0, MAX_PAYLOAD_BYTES - 64) };
}

/**
 * Append one event to a run's events.jsonl. Creates the directory on
 * first write. Never throws — durability layer must not break the
 * runner. If the disk is full / permissions are wrong, the error is
 * captured into the meta of subsequent in-memory events but the run
 * itself continues.
 */
export function appendWorkflowEvent(
  workflowName: string,
  runId: string,
  event: Omit<WorkflowEvent, 't'>,
): WorkflowEvent {
  const full: WorkflowEvent = {
    t: new Date().toISOString(),
    ...event,
    output: compactPayload(event.output),
  };
  try {
    ensureRunDir(workflowName, runId);
    appendFileSync(eventsPath(workflowName, runId), JSON.stringify(full) + '\n', 'utf-8');
  } catch {
    // Silent — log persistence is best-effort. Future enhancement:
    // mirror to stderr so the daemon's supervisor.log captures the
    // event when the per-run log is unwritable.
  }
  mirrorWorkflowOperationalEvent(workflowName, runId, full);
  return full;
}

// The live runner emits LEGACY lifecycle kinds (step_*/item_*/approval_*/tool_*);
// the operational taxonomy names them workflow_node_*/approval_*/tool_call_*. Map
// them here so the existing emit points light up telemetry with NO runner edits.
// A kind that is ALREADY an operational type (the graph layer's workflow_node_*,
// workflow_graph_*, etc.) passes straight through. A given emit is exactly one
// kind, so this never double-counts.
const LEGACY_WORKFLOW_OPERATIONAL: Readonly<Record<string, { type: OperationalEventType; source: OperationalEventSource }>> = {
  step_started: { type: 'workflow_node_started', source: 'workflow' },
  step_completed: { type: 'workflow_node_completed', source: 'workflow' },
  step_failed: { type: 'workflow_node_failed', source: 'workflow' },
  step_retry: { type: 'workflow_node_retried', source: 'workflow' },
  item_started: { type: 'workflow_node_started', source: 'workflow' },
  item_completed: { type: 'workflow_node_completed', source: 'workflow' },
  item_failed: { type: 'workflow_node_failed', source: 'workflow' },
  item_retry: { type: 'workflow_node_retried', source: 'workflow' },
  approval_requested: { type: 'approval_required', source: 'safety' },
  approval_granted: { type: 'approval_resolved', source: 'safety' },
  approval_rejected: { type: 'approval_resolved', source: 'safety' },
  tool_called: { type: 'tool_call_started', source: 'tool' },
  tool_result: { type: 'tool_call_completed', source: 'tool' },
};

function mirrorWorkflowOperationalEvent(workflowName: string, runId: string, event: WorkflowEvent): void {
  // step_advisory is a family of non-failing quality flags; only the
  // brain_fallover variant is an operational event — the workflow-runner's parity
  // twin of the chat lane's model_fallover. Every other advisory reason is
  // intentionally NOT mirrored.
  let mapped = LEGACY_WORKFLOW_OPERATIONAL[event.kind];
  if (event.kind === 'step_advisory') {
    if (event.meta?.reason !== 'brain_fallover') return;
    mapped = { type: 'model_fallover', source: 'model' };
  }
  // A step/item that finalized as BLOCKED is not a completion — emit
  // workflow_node_blocked so dashboards stop counting blocks as successes.
  if ((event.kind === 'step_completed' || event.kind === 'item_completed') && event.meta?.blocked === true) {
    mapped = { type: 'workflow_node_blocked', source: 'workflow' };
  }
  const type: OperationalEventType | null = mapped?.type
    ?? (isOperationalEventType(event.kind) ? event.kind : null);
  if (!type) return;
  recordOperationalEvent({
    source: mapped?.source ?? 'workflow',
    type,
    severity: severityForWorkflowEvent(event),
    workflowRunId: runId,
    workflowNodeRunId: stringFromMeta(event.meta, 'workflowNodeRunId')
      ?? stringFromMeta(event.meta, 'nodeRunId')
      ?? event.stepId,
    sessionId: stringFromMeta(event.meta, 'sessionId'),
    actor: 'workflow-runner',
    now: new Date(event.t),
    payload: {
      workflowName,
      stepId: event.stepId,
      itemKey: event.itemKey,
      output: event.output,
      error: event.error,
      meta: event.meta,
      attempt: event.attempt,
    },
  });
}

function severityForWorkflowEvent(event: WorkflowEvent): OperationalEventSeverity {
  // A transient retry is a recovery signal, not a terminal failure — flag it
  // 'warn' even though the triggering error may be attached to the event.
  if (event.kind.endsWith('_retry')) return 'warn';
  if (event.error || event.kind.endsWith('_failed')) return 'error';
  if (event.kind.endsWith('_rejected') || event.kind.endsWith('_deduped')) return 'warn';
  if (event.kind === 'step_advisory' && event.meta?.reason === 'brain_fallover') return 'warn';
  return 'info';
}

function stringFromMeta(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = meta?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read every event for a run. Returns an empty array when the log
 * doesn't exist (run never started) or the directory is unreadable.
 * Truncated trailing lines (a write that didn't fsync before crash)
 * are silently skipped so the reader never throws on partial data.
 */
export function readWorkflowEvents(workflowName: string, runId: string): WorkflowEvent[] {
  const file = eventsPath(workflowName, runId);
  if (!existsSync(file)) return [];
  const events: WorkflowEvent[] = [];
  try {
    const raw = readFileSync(file, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as WorkflowEvent);
      } catch {
        // Partial / corrupt trailing line — keep what we have.
      }
    }
  } catch {
    /* unreadable; treat as empty */
  }
  return events;
}

/**
 * STATE-pillar reader: pull every comparable attempt record for a run, optionally
 * scoped to one step. This is the substrate the self-improvement phase queries to
 * answer "what was tried and what worked best" — and what the dashboard/run-report
 * renders as an attempt timeline. Cheap: replays the run's events.jsonl. Returns
 * `{ stepId, itemKey, at, record }` so callers keep the owning step/time without
 * re-correlating.
 */
export function listAttemptRecords(
  workflowName: string,
  runId: string,
  stepId?: string,
): Array<{ stepId?: string; itemKey?: string; at: string; record: AttemptRecord }> {
  const out: Array<{ stepId?: string; itemKey?: string; at: string; record: AttemptRecord }> = [];
  for (const ev of readWorkflowEvents(workflowName, runId)) {
    if (ev.kind !== 'attempt_record' || !ev.attempt) continue;
    if (stepId && ev.stepId !== stepId) continue;
    out.push({ stepId: ev.stepId, itemKey: ev.itemKey, at: ev.t, record: ev.attempt });
  }
  return out;
}

/** Return the final failed forEach items for a run.
 *
 * An item can fail and then later complete during a retry/resume pass, so this
 * tracks the last terminal item state per step+key rather than returning every
 * historical `item_failed` event. This is the durable source of truth for
 * "rerun failed items only".
 */
export function listFinalFailedItems(
  workflowName: string,
  runId: string,
): Array<{ stepId: string; itemKey: string; error: string; at: string }> {
  const state = new Map<string, { stepId: string; itemKey: string; error: string; at: string } | null>();
  for (const ev of readWorkflowEvents(workflowName, runId)) {
    if (!ev.stepId || !ev.itemKey) continue;
    const key = `${ev.stepId}\u0000${ev.itemKey}`;
    if (ev.kind === 'item_failed') {
      state.set(key, {
        stepId: ev.stepId,
        itemKey: ev.itemKey,
        error: ev.error ?? 'item failed',
        at: ev.t,
      });
    } else if (ev.kind === 'item_completed') {
      state.set(key, null);
    }
  }
  return Array.from(state.values()).filter((item): item is NonNullable<typeof item> => item !== null);
}

/**
 * What's the durability layer's view of where we left off? Replays
 * the events log and returns a summary the runner uses to decide
 * which steps to skip on resume.
 *
 * The contract:
 *   - A step_completed event marks that step's id as done. The runner
 *     re-uses the stored output instead of re-invoking the LLM.
 *   - For forEach steps, item_completed events accumulate into a
 *     per-step Set of itemKeys. The runner skips those keys.
 *   - If a step appears as step_started but not step_completed and
 *     the most recent event is older than the resume grace window,
 *     the runner treats it as crashed and retries from the start.
 */
export interface ResumeState {
  /** Completed step IDs → recorded output. */
  completedSteps: Map<string, unknown>;
  /** Per-step Set of itemKeys that succeeded in forEach iterations. */
  completedItems: Map<string, Map<string, unknown>>;
  /** Step that was in flight at last event (may have crashed). */
  inFlightStepId?: string;
  /** Step IDs whose MOST-RECENT lifecycle event is step_failed — i.e. currently
   *  sitting in a parked/failed state, NOT subsequently re-started. A later
   *  step_started or step_completed REMOVES the id. In a run that is still
   *  resumable (a genuinely errored run is terminal and never resumed), a step in
   *  this set means it PARKED on a runtime approval (request_approval →
   *  ParkRunSignal → step_failed → re-admitted by the reaper), NOT a silent
   *  crash — the crash-resume side-effect guard uses it to tell them apart.
   *  Critically, because a re-start clears it, a step that parked, got approved,
   *  re-started, and THEN crashed mid-send is NOT exempt (its post-approval
   *  step_started removed it) → the guard halts it instead of double-sending. */
  failedSteps: Set<string>;
  /** ISO timestamp of the most recent event. */
  lastEventAt?: string;
  /** True when the log contains a terminal run_completed/run_failed. */
  terminal: boolean;
}

export function computeResumeState(workflowName: string, runId: string): ResumeState {
  const events = readWorkflowEvents(workflowName, runId);
  const completedSteps = new Map<string, unknown>();
  const completedItems = new Map<string, Map<string, unknown>>();
  const failedSteps = new Set<string>();
  let inFlightStepId: string | undefined;
  let lastEventAt: string | undefined;
  let terminal = false;

  for (const ev of events) {
    lastEventAt = ev.t;
    if (ev.kind === 'run_completed' || ev.kind === 'run_failed' || ev.kind === 'run_cancelled') {
      terminal = true;
    }
    if (ev.kind === 'step_started' && ev.stepId) {
      inFlightStepId = ev.stepId;
      // A re-start clears any prior parked/failed state: a crash AFTER this
      // step_started is a REAL crash (e.g. a post-approval send that died
      // mid-flight), not a park — so it must NOT be exempted from the guard.
      failedSteps.delete(ev.stepId);
    }
    if (ev.kind === 'step_failed' && ev.stepId) {
      failedSteps.add(ev.stepId);
    }
    if ((ev.kind === 'step_completed' || ev.kind === 'step_skipped') && ev.stepId) {
      const output = ev.kind === 'step_skipped' && ev.output === undefined && ev.meta?.reason === 'forEach-empty'
        ? []
        : ev.output;
      completedSteps.set(ev.stepId, output);
      failedSteps.delete(ev.stepId);
      if (inFlightStepId === ev.stepId) inFlightStepId = undefined;
    }
    if (ev.kind === 'item_completed' && ev.stepId && ev.itemKey) {
      let inner = completedItems.get(ev.stepId);
      if (!inner) { inner = new Map(); completedItems.set(ev.stepId, inner); }
      inner.set(ev.itemKey, ev.output);
    }
  }

  return { completedSteps, completedItems, failedSteps, inFlightStepId, lastEventAt, terminal };
}

// ─────────────────────────────────────────────────────────────────
// Queue visibility — reconstruct a run's SUB-TASK QUEUE from the durable
// event log so each queued unit ("check followers", "draft post 3") is a
// first-class, restart-surviving item the Tasks board can show, instead of one
// opaque "campaign running" card. Pure read; no behaviour change.
// ─────────────────────────────────────────────────────────────────

export type RunQueueStepStatus = 'done' | 'running' | 'failed' | 'queued' | 'blocked';

export interface RunQueueStep {
  stepId: string;
  /** Short human label (first line of the step prompt, else the id). */
  title: string;
  kind: 'step' | 'forEach';
  status: RunQueueStepStatus;
  /** The next ready-to-run step (the head of the queue) — what Clem does next. */
  isNext: boolean;
  /** forEach progress (present only for forEach steps that have started). */
  itemsDone?: number;
  itemsTotal?: number;
  itemsFailed?: number;
}

export interface RunQueue {
  runId: string;
  steps: RunQueueStep[];
  doneCount: number;
  totalCount: number;
  /** The step that will run next (null when none are ready — running/blocked/done). */
  nextStepId: string | null;
}

function stepLabel(step: WorkflowStepInput): string {
  const firstLine = (step.prompt ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  const label = (firstLine ?? step.id).trim();
  return label.length > 90 ? `${label.slice(0, 87)}…` : label;
}

/**
 * Reconstruct the ordered sub-task queue for a workflow run from its durable
 * events + the workflow's declared steps. Every step gets a status (done /
 * running / failed / queued / blocked); the first ready step is flagged `isNext`.
 * forEach steps carry item progress from the log. Survives restarts (it reads the
 * same events.jsonl the crash-resume does). Never throws — returns an empty queue
 * on any read error so the board degrades gracefully.
 */
export function reconstructWorkflowRunQueue(
  workflowName: string,
  runId: string,
  steps: WorkflowStepInput[],
): RunQueue {
  try {
    const state = computeResumeState(workflowName, runId);
    const failedItemsByStep = new Map<string, number>();
    for (const item of listFinalFailedItems(workflowName, runId)) {
      failedItemsByStep.set(item.stepId, (failedItemsByStep.get(item.stepId) ?? 0) + 1);
    }
    // Per-forEach item progress: distinct keys started vs completed, from events.
    const perStepItems = new Map<string, { started: Set<string>; done: Set<string> }>();
    for (const ev of readWorkflowEvents(workflowName, runId)) {
      if (!ev.stepId || !ev.itemKey) continue;
      let s = perStepItems.get(ev.stepId);
      if (!s) { s = { started: new Set(), done: new Set() }; perStepItems.set(ev.stepId, s); }
      s.started.add(ev.itemKey);
      if (ev.kind === 'item_completed') s.done.add(ev.itemKey);
    }

    let nextStepId: string | null = null;
    const out: RunQueueStep[] = steps.map((step) => {
      const deps = step.dependsOn ?? [];
      const failedItemCount = failedItemsByStep.get(step.id) ?? 0;
      let status: RunQueueStepStatus;
      if (state.failedSteps.has(step.id) || failedItemCount > 0) status = 'failed';
      else if (state.completedSteps.has(step.id)) status = 'done';
      else if (state.inFlightStepId === step.id) status = 'running';
      else if (deps.every((d) => state.completedSteps.has(d))) status = 'queued';
      else status = 'blocked';

      // The head of the queue: the FIRST ready step (in declared order).
      const isNext = status === 'queued' && nextStepId === null;
      if (isNext) nextStepId = step.id;

      const items = perStepItems.get(step.id);
      return {
        stepId: step.id,
        title: stepLabel(step),
        kind: step.forEach ? 'forEach' : 'step',
        status,
        isNext,
        ...(step.forEach && items && items.started.size > 0
          ? { itemsDone: items.done.size, itemsTotal: items.started.size }
          : {}),
        ...(step.forEach && failedItemCount > 0 ? { itemsFailed: failedItemCount } : {}),
      };
    });

    return {
      runId,
      steps: out,
      doneCount: out.filter((s) => s.status === 'done').length,
      totalCount: out.length,
      nextStepId,
    };
  } catch {
    return { runId, steps: [], doneCount: 0, totalCount: 0, nextStepId: null };
  }
}

/**
 * Scan every workflow's runs/ directory for runs whose latest event
 * isn't a terminal run_completed/run_failed. The daemon calls this on
 * startup so it can resume work interrupted by a crash or restart.
 *
 * Returns lightweight descriptors so the runner can pick them up
 * without re-reading every events.jsonl. Empty array when nothing's
 * pending — the common case.
 */
export interface PendingRun {
  workflowName: string;
  runId: string;
  lastEventAt?: string;
  inFlightStepId?: string;
}

const TERMINAL_RUN_RECORD_STATUSES = new Set(['completed', 'error', 'cancelled', 'dry_run']);

function terminalRunRecordStatus(runId: string): boolean {
  const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  // P0-2: a MISSING record means it was reaped (7-day terminal cleanup) or never
  // persisted — either way this is NOT a live in-flight run to resume. Treat
  // missing as terminal so a reaped run with a lingering events.jsonl doesn't
  // get "resumed" as a phantom on every boot (the May-29 trio symptom). Was
  // `return false`, which made every reaped run look permanently pending.
  if (!existsSync(file)) return true;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { status?: unknown; finishedAt?: unknown };
    if (typeof raw.status !== 'string') return false;
    if (TERMINAL_RUN_RECORD_STATUSES.has(raw.status)) return true;
    // A creation_test (workflow-shape validation) is a one-shot check, not a
    // resumable run. Once it has FINISHED it must not resurface as pending/in-flight
    // on the board or in the boot "Resuming N in-flight" loop — the 2026-06-19
    // clem-smoke-flow zombies (9 finished creation_tests painted QUEUED / RUNNING=0,
    // re-"resumed" every boot, never reaped because they aren't a terminal status).
    if (raw.status === 'creation_test' && typeof raw.finishedAt === 'string') return true;
    return false;
  } catch {
    return false;
  }
}

/** Every workflow name that has a runs/ directory — the set the self-improvement
 *  proposer walks to mine per-workflow run history. */
export function listWorkflowNamesWithRuns(): string[] {
  if (!existsSync(WORKFLOWS_DIR)) return [];
  const out: string[] = [];
  for (const name of readdirSync(WORKFLOWS_DIR)) {
    if (existsSync(path.join(WORKFLOWS_DIR, name, 'runs'))) out.push(name);
  }
  return out;
}

/** Recent run ids for a workflow, newest-first by directory mtime, capped. The
 *  history window the workflow_step proposer mines for recurring step failures. */
export function listWorkflowRunIds(workflowName: string, limit = 20): string[] {
  const runsDir = path.join(WORKFLOWS_DIR, workflowName, 'runs');
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .map((id) => {
      try { return { id, mtime: statSync(path.join(runsDir, id)).mtimeMs }; }
      catch { return { id, mtime: 0 }; }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, Math.max(0, limit))
    .map((e) => e.id);
}

export function listPendingRuns(): PendingRun[] {
  if (!existsSync(WORKFLOWS_DIR)) return [];
  const pending: PendingRun[] = [];
  for (const workflowDir of readdirSync(WORKFLOWS_DIR)) {
    const runsDir = path.join(WORKFLOWS_DIR, workflowDir, 'runs');
    if (!existsSync(runsDir)) continue;
    for (const runId of readdirSync(runsDir)) {
      const evFile = path.join(runsDir, runId, 'events.jsonl');
      if (!existsSync(evFile)) continue;
      const state = computeResumeState(workflowDir, runId);
      if (state.terminal) continue;
      if (terminalRunRecordStatus(runId)) continue;
      pending.push({
        workflowName: workflowDir,
        runId,
        lastEventAt: state.lastEventAt,
        inFlightStepId: state.inFlightStepId,
      });
    }
  }
  return pending;
}
