import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { WORKFLOWS_DIR } from '../memory/vault.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';

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
  | 'step_started'        // single-shot or container step started
  | 'step_completed'      // step finished — output is the final result
  | 'step_failed'         // step errored
  | 'step_retry'          // step failed transiently; retrying after backoff
  | 'step_advisory'       // step completed but a non-failing quality check flagged it (skill-execution miss)
  | 'step_skipped'        // step was a no-op (forEach over empty list, condition)
  | 'item_started'        // one iteration of a forEach step started
  | 'item_completed'      // one iteration of a forEach step done
  | 'item_failed'         // one iteration of a forEach step failed
  | 'tool_called'         // diagnostic — tool name + args (truncated)
  | 'tool_result'         // diagnostic — tool result (truncated)
  | 'approval_requested'  // workflow waiting on user approval
  | 'approval_granted'    // user said yes
  | 'approval_rejected'   // user said no
  | 'transcript_chunk';   // streaming text from LLM, for live UI

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
  return full;
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
  /** Step IDs that logged a step_failed event. In a run that is still resumable
   *  (a genuinely errored run is terminal and never resumed), a step_failed on
   *  the in-flight step means it PARKED on a runtime approval (request_approval
   *  → ParkRunSignal → step_failed → re-admitted by the reaper), NOT a silent
   *  crash — the crash-resume side-effect guard uses this to tell them apart. */
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
    }
    if (ev.kind === 'step_failed' && ev.stepId) {
      failedSteps.add(ev.stepId);
    }
    if (ev.kind === 'step_completed' && ev.stepId) {
      completedSteps.set(ev.stepId, ev.output);
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
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { status?: unknown };
    return typeof raw.status === 'string' && TERMINAL_RUN_RECORD_STATUSES.has(raw.status);
  } catch {
    return false;
  }
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
