/**
 * The second fold: run-lifecycle rows for the public events `reduceActivity`
 * does not consume.
 *
 * WHERE THE PUBLIC BOUNDARY ACTUALLY IS. The harness ledger holds 167 event
 * types, but the client-facing set is much smaller — and it is NOT
 * `EVENT_TYPES` minus `PRIVATE_EVENT_TYPES`. The real gate is `projectData()`
 * in src/runtime/harness/public-presentation.ts: a fail-closed allowlist whose
 * `default: return null` drops the event entirely, with the rule stated in its
 * own comment — "A new event earns no place on the public bus until this switch
 * explicitly grants both its type and its safe payload projection." It cases 47
 * types. Everything else never leaves the daemon, so no client-side change can
 * render it, however the client is written.
 *
 * That makes this module's job narrow and precise: give a row to the projected
 * events the activity fold does not already claim. `reduceFeed` composes the
 * two folds in the order the board drawer proved out — shared fold first, a
 * lifecycle row only when the shared fold consumed nothing, so no event can
 * ever emit twice.
 *
 * The second job is to keep that boundary honest. `AWAITING_PROJECTION` names
 * the events that carry owner-meaningful truth and are NOT published, each with
 * the row it would get. `event-coverage.test.ts` asserts that list in both
 * directions, so admitting one server-side immediately fails a test telling you
 * to move it up into LIFECYCLE_ROWS.
 */
import type { ActivityItem, HarnessEvent } from './types.js';
import { humanHarnessText } from './types.js';
import { reduceActivity } from './reduce-activity.js';

type Tone = NonNullable<ActivityItem['tone']>;
type Row = { label: string; tone: Tone };

/**
 * Projected events the activity fold does not claim. Every one of these can
 * actually arrive at a client; keep it that way.
 */
export const LIFECYCLE_ROWS: Readonly<Record<string, Row>> = {
  approval_requested: { label: 'Needs approval', tone: 'warning' },
  awaiting_user_input: { label: 'Waiting on you', tone: 'warning' },
  user_steer_note: { label: 'You steered', tone: 'muted' },
  run_failed: { label: 'Failed', tone: 'danger' },
  plan_approved: { label: 'Plan approved', tone: 'success' },
  plan_rejected: { label: 'Plan rejected', tone: 'warning' },
  plan_revised: { label: 'Plan revised', tone: 'muted' },
  plan_execution_claimed: { label: 'Executing the plan', tone: 'live' },
};

/**
 * Owner-meaningful truth the daemon keeps to itself.
 *
 * Each of these is durably recorded and would change what the owner believes
 * about an answer — a brain fell over mid-task, the context was compacted, what
 * Clem had learned was replaced, a write was retried after an uncertain
 * crossing, a reviewer checked the answer against its sources. None of them is
 * cased in `projectData`, so chat cannot show them however it is written.
 *
 * This is therefore a SERVER backlog, not a client one: admitting a type means
 * adding a `case` with a bounded `selected(...)` projection next to it (use the
 * `expected_work_progress` case as the template — it bounds, whitelists enums,
 * and drops on violation). The labels live here so that work has somewhere to
 * land, and so the coverage test can prove the list has not gone stale.
 */
export const AWAITING_PROJECTION: Readonly<Record<string, Row>> = {
  // The declared work contract — the live checklist for a long task. The fold
  // for these already exists in reduce-activity.ts and is inert until they are
  // projected; see work-manifest-activity.test.ts.
  work_manifest_declared: { label: 'Work mapped out', tone: 'muted' },
  work_item_checkpoint: { label: 'Item settled', tone: 'muted' },
  requirement_state: { label: 'Requirements updated', tone: 'muted' },
  obligation_manifest: { label: 'Obligations declared', tone: 'muted' },
  obligation_satisfied: { label: 'Obligation met', tone: 'success' },
  // Verification the owner is entitled to see.
  goal_alignment_judged: { label: 'Checked against your goal', tone: 'muted' },
  output_grounding_judged: { label: 'Checked the answer against its sources', tone: 'muted' },
  goal_validation: { label: 'Goal checked', tone: 'muted' },
  step_verified: { label: 'Step verified', tone: 'success' },
  step_failed: { label: 'Step failed', tone: 'danger' },
  write_evidence_proved: { label: 'Write proved', tone: 'success' },
  plan_critiqued: { label: 'Plan critiqued', tone: 'muted' },
  plan_first_started: { label: 'Drafting a plan', tone: 'live' },
  plan_first_failed: { label: 'Planning did not finish', tone: 'danger' },
  // Recovery and provider health — why an answer took the shape it did.
  brain_fallover: { label: 'Switched brain', tone: 'warning' },
  infra_auto_recover: { label: 'Recovered and kept going', tone: 'muted' },
  restart_recovery_decision: { label: 'Resumed after a restart', tone: 'muted' },
  external_write_retry_authorized: { label: 'Retrying an uncertain write', tone: 'warning' },
  orphaned_tool_reported: { label: 'A call was left in flight', tone: 'warning' },
  // Context and memory.
  condenser_applied: { label: 'Compacted context', tone: 'muted' },
  native_compaction_applied: { label: 'Compacted context', tone: 'muted' },
  sdk_compact_boundary: { label: 'Compacted context', tone: 'muted' },
  memory_correction: { label: 'Replaced what I had learned', tone: 'muted' },
  // Capability, connections, and durable workflows.
  capability_discovered: { label: 'Found a capability', tone: 'muted' },
  mcp_tool_acquired: { label: 'Connected a tool', tone: 'muted' },
  connection_request: { label: 'Needs a connection', tone: 'warning' },
  connection_request_satisfied: { label: 'Connection ready', tone: 'success' },
  workflow_candidate_recorded: { label: 'Workflow saved', tone: 'success' },
  workflow_step_overbudget: { label: 'A step ran over budget', tone: 'warning' },
  work_contract_revised: { label: 'Work contract revised', tone: 'warning' },
  background_contract_revised: { label: 'Course corrected', tone: 'warning' },
  interactive_consent_decided: { label: 'You decided', tone: 'muted' },
  session_started: { label: 'Started', tone: 'muted' },
};

/**
 * Projected events rendered somewhere other than a lifecycle row — by
 * `reduceActivity`, or at message level (streamed text, terminals, approvals,
 * plan artifacts, check-ins, the accepted user turn). Listed so the coverage
 * test can prove every projected type is accounted for exactly once.
 */
export const ACTIVITY_FOLD_EVENTS: ReadonlySet<string> = new Set([
  'turn_started', 'turn_model_routed', 'turn_graph_compiled', 'heartbeat',
  'step_started', 'conversation_completed',
  'tool_called', 'tool_returned', 'capability_resolution',
  'worker_started', 'worker_result', 'worker_capped',
  'batch_started', 'batch_progress', 'batch_completed',
  'async_work_dispatched', 'expected_work_progress',
  'external_write', 'external_write_succeeded', 'external_write_failed', 'external_write_orphaned',
  'deliverable_saved', 'codemode_program_summary', 'verdict_recorded',
  'stream_token', 'user_input_received', 'conversation_preamble', 'conversation_check_in',
  'approval_resolved', 'conversation_limit_exceeded', 'stall_retry_attempted',
  'plan_drafted', 'plan_revision_published', 'memory_signals_captured', 'handoff',
  'run_completed', 'run_paused', 'run_resumed',
  'coding_run_activity', 'coding_run_settled',
]);

/** The detail line under a lifecycle row: the step's own title where it has
 *  one, otherwise the event's plain-language summary. Never the raw payload. */
function lifecycleDetail(ev: HarnessEvent): string {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  if (ev.type === 'step_started') return typeof d.title === 'string' ? d.title : '';
  // These carry their own fuller surface (terminal pill, approval control), so
  // a duplicate summary underneath is noise.
  if (ev.type === 'conversation_completed' || ev.type === 'run_failed') return '';
  return humanHarnessText(d, '').slice(0, 140);
}

/** One lifecycle row, or null when this event is not an owner-facing beat. */
export function lifecycleActivityItem(ev: HarnessEvent): ActivityItem | null {
  const match = LIFECYCLE_ROWS[ev.type];
  if (!match) return null;
  const detail = lifecycleDetail(ev);
  return {
    id: `l-${ev.seq}`,
    kind: 'event',
    variant: 'lifecycle',
    label: match.label,
    tone: match.tone,
    status: match.tone === 'danger' ? 'failed' : 'done',
    ...(detail ? { detail } : {}),
  };
}

/** Append this event's lifecycle row, if it has one. Returns `prev` unchanged
 *  otherwise, so callers can keep using identity to detect "nothing happened". */
export function reduceLifecycle(prev: ActivityItem[], ev: HarnessEvent): ActivityItem[] {
  const row = lifecycleActivityItem(ev);
  return row ? [...prev, row] : prev;
}

/**
 * The full feed fold both shells should use: the shared activity fold first,
 * and a lifecycle row only when that fold consumed nothing. Identity is the
 * signal — `reduceActivity` returns `prev` unchanged when it did not claim the
 * event, which is precisely when a lifecycle row is allowed to speak.
 */
export function reduceFeed(
  prev: ActivityItem[],
  ev: HarnessEvent,
  now: () => number = Date.now,
): ActivityItem[] {
  const next = reduceActivity(prev, ev, now);
  return next === prev ? reduceLifecycle(prev, ev) : next;
}
