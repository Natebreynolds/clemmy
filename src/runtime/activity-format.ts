/**
 * Shared "friendly activity" formatter.
 *
 * The Activity inbox (desktop console + mobile-web) needs to show RUNS and
 * their EVENTS in language an average user understands — not the ~50 raw
 * harness event types (`turn_started`, `condenser_applied`, `mcp_tool_scope`…)
 * that exist for operator/debug introspection.
 *
 * This module is the SINGLE SOURCE OF TRUTH for that translation. It is pure
 * (no I/O) so it is trivially unit-testable and reusable from both the
 * `/api/runs` enrichment in `src/channels/webhook.ts` and any UI. Keep all
 * user-facing phrasing here so it cannot drift between surfaces
 * (see feedback: code-level over prompt-level).
 *
 * Run: npx tsx --test src/runtime/activity-format.test.ts
 */

/** A run/event shape permissive enough to accept legacy run-store records,
 *  harness-session-derived activity runs, and workflow-run records. */
export interface ActivityEventLike {
  type?: string;
  message?: string;
  stepId?: string;
  data?: Record<string, unknown>;
  createdAt?: string;
}

export interface ActivityRunLike {
  id?: string;
  sessionId?: string;
  kind?: string;
  source?: string;
  channel?: string | null;
  status?: string;
  title?: string | null;
  input?: string;
  objective?: string | null;
  outputPreview?: string;
  error?: string;
  queuedTaskId?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  metadata?: Record<string, unknown> | null;
  events?: ActivityEventLike[];
}

export type EventVisibility = 'milestone' | 'noise';
export type RunCategory = 'chat' | 'workflow' | 'scheduled' | 'background';
export type UserFacingRunState =
  | 'planning'
  | 'executing'
  | 'queued'
  | 'waiting_for_approval'
  | 'waiting_for_input'
  | 'stalled'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'idle';

const STALE_LIVE_RUN_MS = 20 * 60_000;

/**
 * Event types that represent a user-meaningful MILESTONE — the things a person
 * would expect to see in a "what happened" timeline. Everything NOT in this set
 * (including unknown/future types) is treated as internal noise and hidden from
 * the clean view (still available in the raw "Technical details" toggle).
 */
const MILESTONE_TYPES: ReadonlySet<string> = new Set([
  // legacy run-store event types
  'received',
  'queued_background',
  'tool_started',
  'approval_required',
  'completed',
  'failed',
  'cancelled',
  // harness event types
  'tool_called',
  'approval_requested',
  'approval_resolved',
  'step_started',
  'step_verified',
  'step_failed',
  'handoff',
  'awaiting_user_input',
  'plan_drafted',
  'run_completed',
  'run_failed',
  'run_paused',
  'run_resumed',
  'conversation_completed',
  'plan_approved',
  // workflow-event kinds
  'run_started',
  'step_completed',
  'approval_granted',
  'approval_rejected',
]);

/** Terminal milestones — used so liveLine never reports a finished state. */
const TERMINAL_TYPES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'run_completed',
  'run_failed',
  'conversation_completed',
]);

export function eventVisibility(type: string | undefined): EventVisibility {
  return type && MILESTONE_TYPES.has(type) ? 'milestone' : 'noise';
}

/** Title-case a raw machine type as a last-resort human label. */
function humanizeType(type: string | undefined): string {
  if (!type) return 'Activity';
  const spaced = type.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function toolName(event: ActivityEventLike): string {
  const data = event.data ?? {};
  return String(data.tool || data.name || 'a tool');
}

function stepLabel(event: ActivityEventLike): string {
  const data = event.data ?? {};
  return String(event.stepId || data.stepId || data.step || '').trim();
}

function firstLine(value: unknown, max = 160): string {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Return events in chronological (oldest-first) order regardless of how the
 * caller supplied them. Harness sessions are fetched newest-first (`desc`)
 * while legacy runs are appended oldest-first — without this, liveLine would
 * pick the oldest milestone and the timeline would render reversed for one of
 * the two sources.
 */
function chronological(events: ActivityEventLike[]): ActivityEventLike[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const at = a.event.createdAt ?? '';
      const bt = b.event.createdAt ?? '';
      if (at !== bt) return at < bt ? -1 : 1;
      return a.index - b.index; // stable for equal/missing timestamps
    })
    .map((entry) => entry.event);
}

/**
 * Translate a single event into a plain-English, past-tense line suitable for
 * the clean "what happened" timeline. Absorbs the old `harnessEventMessage`
 * phrasing so there is one canonical map.
 */
export function friendlyEventMessage(event: ActivityEventLike): string {
  const type = event.type ?? '';
  const data = event.data ?? {};
  switch (type) {
    case 'received':
      return 'Received your request';
    case 'queued_background':
      return 'Queued to run in the background';
    case 'tool_called':
    case 'tool_started':
      return `Used ${toolName(event)}`;
    case 'tool_returned':
      return `Finished ${toolName(event)}`;
    case 'approval_requested':
    case 'approval_required':
      return `Asked for your approval: ${firstLine(data.subject || data.tool || 'a tool call', 80)}`;
    case 'approval_resolved':
      return `Approval ${String(data.decision || data.resolution || 'resolved')}`;
    case 'approval_granted':
      return 'Approval granted';
    case 'approval_rejected':
      return 'Approval declined';
    case 'awaiting_user_input':
      return 'Waiting for your input';
    case 'handoff':
      return 'Handed off to a specialist';
    case 'step_started': {
      const label = stepLabel(event);
      return label ? `Started: ${label}` : 'Started a step';
    }
    case 'step_verified':
    case 'step_completed': {
      const label = stepLabel(event);
      return label ? `Finished: ${label}` : 'Finished a step';
    }
    case 'step_failed': {
      const label = stepLabel(event);
      const why = firstLine(data.error, 80);
      return `Step failed${label ? `: ${label}` : ''}${why ? ` — ${why}` : ''}`;
    }
    case 'run_started':
      return 'Started';
    case 'plan_drafted':
      return 'Drafted a plan';
    case 'run_paused':
      return 'Paused';
    case 'run_resumed':
      return 'Resumed';
    case 'plan_approved':
      return 'Plan approved';
    case 'conversation_completed':
      return firstLine(data.summary || data.reply, 200) || 'Replied';
    case 'run_completed':
    case 'completed':
      return 'Completed';
    case 'run_failed':
    case 'failed':
      return firstLine(data.error, 200) || 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      // Fall back to any pre-built message, else a humanized type name.
      return event.message ? firstLine(event.message, 200) : humanizeType(type);
  }
}

/** Categorize a run for the inbox filter chips. Status-independent — the
 *  "Needs approval" chip is handled separately by the UI via status. */
export function runFilterCategory(run: ActivityRunLike): RunCategory {
  const source = (run.source ?? '').toLowerCase();
  const channel = (run.channel ?? '').toString().toLowerCase();
  const kind = (run.kind ?? '').toLowerCase();
  const id = (run.id ?? '').toString().toLowerCase();
  const sessionId = (run.sessionId ?? '').toString().toLowerCase();
  const metaSource = String((run.metadata ?? {}).source ?? '').toLowerCase();

  if (kind === 'workflow' || channel === 'workflow' || source === 'workflow' || metaSource === 'workflow') {
    return 'workflow';
  }
  // Cron/scheduled — internal channel 'cron' or a `cron:` session prefix
  // (see src/execution/scope.ts INTERNAL_SESSION_PREFIXES).
  if (
    source === 'cron'
    || metaSource === 'cron'
    || metaSource === 'schedule'
    || metaSource === 'scheduled'
    || channel.startsWith('cron')
    || channel.startsWith('schedule')
    || sessionId.startsWith('cron:')
  ) {
    return 'scheduled';
  }
  // Background task runs are created with channel 'background', a
  // `background:<id>` session id, and `run-bg-…` run ids (see
  // src/execution/background-tasks.ts). Autonomy/agent + execution-controller
  // work is background to the user too.
  if (
    run.queuedTaskId
    || kind === 'agent'
    || kind === 'execution'
    || channel === 'background'
    || channel === 'agent'
    || channel === 'execution-controller'
    || id.startsWith('run-bg')
    || sessionId.startsWith('background:')
    || sessionId.startsWith('agent:')
    || sessionId.startsWith('execution:')
  ) {
    return 'background';
  }
  return 'chat';
}

/** Human-facing label for the run's kind. Discord chats keep a distinct
 *  "Discord" badge even though they filter under the 'chat' category. */
export function friendlyKindLabel(run: ActivityRunLike): string {
  const source = (run.source ?? '').toLowerCase();
  const channel = (run.channel ?? '').toString().toLowerCase();
  const metaSource = String((run.metadata ?? {}).source ?? '').toLowerCase();
  if (source === 'discord' || channel === 'discord' || channel === 'discord-dm' || metaSource === 'discord') {
    return 'Discord';
  }
  switch (runFilterCategory(run)) {
    case 'workflow':
      return 'Workflow';
    case 'scheduled':
      return 'Scheduled';
    case 'background':
      return 'Background task';
    default:
      return 'Chat';
  }
}

export function friendlyStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'running':
    case 'received':
      return 'Running…';
    case 'queued':
      return 'Queued';
    case 'awaiting_approval':
    case 'parked':
      return 'Waiting for your approval';
    case 'awaiting_user_input':
      return 'Waiting for your input';
    case 'stalled':
      return 'Needs attention';
    case 'idle':
      return 'Idle';
    case 'paused':
      return 'Paused';
    case 'completed':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return humanizeType(status);
  }
}

/** Live = actively doing something the user might wait on. `idle` (an active
 *  session with no recent updates, e.g. a chat between turns) is intentionally
 *  NOT live, so it does not pin to "Happening now" forever. */
export function isLive(status: string | undefined): boolean {
  return status === 'running'
    || status === 'received'
    || status === 'active'
    || status === 'queued'
    || status === 'awaiting_approval'
    || status === 'parked'
    || status === 'awaiting_user_input';
}

function parseTimeMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function latestActivityMs(run: ActivityRunLike): number | null {
  const candidates = [
    parseTimeMs(run.updatedAt),
    parseTimeMs(run.completedAt),
    parseTimeMs(run.createdAt),
    ...(run.events ?? []).map((event) => parseTimeMs(event.createdAt)),
  ].filter((value): value is number => typeof value === 'number');
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

function latestMilestone(run: ActivityRunLike): ActivityEventLike | null {
  const events = chronological(run.events ?? [])
    .filter((event) => eventVisibility(event.type) === 'milestone');
  return events.length ? events[events.length - 1] : null;
}

function hasExecutionMilestone(run: ActivityRunLike): boolean {
  return chronological(run.events ?? []).some((event) =>
    event.type === 'tool_called'
    || event.type === 'tool_started'
    || event.type === 'step_started'
    || event.type === 'step_completed'
    || event.type === 'step_verified'
    || event.type === 'handoff',
  );
}

export function userFacingRunState(run: ActivityRunLike, nowMs = Date.now()): UserFacingRunState {
  const status = (run.status ?? '').toLowerCase();
  const latest = latestMilestone(run);
  const latestType = latest?.type ?? '';

  if (status === 'failed' || latestType === 'run_failed' || latestType === 'failed' || run.error) return 'failed';
  if (status === 'cancelled' || latestType === 'cancelled') return 'cancelled';
  if (status === 'completed' || latestType === 'run_completed' || latestType === 'completed' || latestType === 'conversation_completed') return 'completed';
  if (status === 'awaiting_approval' || status === 'parked' || status === 'paused' || latestType === 'approval_requested' || latestType === 'approval_required') return 'waiting_for_approval';
  if (status === 'awaiting_user_input' || latestType === 'awaiting_user_input') return 'waiting_for_input';
  if (status === 'queued' || latestType === 'queued_background') return 'queued';

  if (status === 'running' || status === 'received' || status === 'active') {
    const lastMs = latestActivityMs(run);
    if (lastMs !== null && nowMs - lastMs > STALE_LIVE_RUN_MS) return 'stalled';
    if (!hasExecutionMilestone(run) && (latestType === 'received' || latestType === 'run_started' || latestType === 'plan_drafted' || !latestType)) {
      return 'planning';
    }
    return 'executing';
  }

  if (status === 'idle') return 'idle';
  return 'idle';
}

export function userFacingRunStateLabel(state: UserFacingRunState): string {
  switch (state) {
    case 'planning':
      return 'Planning';
    case 'executing':
      return 'Working';
    case 'queued':
      return 'Queued';
    case 'waiting_for_approval':
      return 'Waiting for your approval';
    case 'waiting_for_input':
      return 'Waiting for your input';
    case 'stalled':
      return 'Needs attention';
    case 'completed':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'idle':
      return 'Idle';
  }
}

export function userFacingRunStateIsLive(state: UserFacingRunState): boolean {
  return state === 'planning'
    || state === 'executing'
    || state === 'queued'
    || state === 'waiting_for_approval'
    || state === 'waiting_for_input';
}

/**
 * One-line "what is it doing right now" for a live run, derived from the most
 * recent meaningful (non-terminal milestone) event. Returns '' for runs that
 * are not live.
 */
export function liveLine(run: ActivityRunLike): string {
  const state = userFacingRunState(run);
  if (!userFacingRunStateIsLive(state)) return '';
  if (state === 'waiting_for_approval') return 'Waiting for your approval';
  if (state === 'waiting_for_input') return 'Waiting for your input';
  if (state === 'queued') return 'Queued to start';
  if (state === 'planning') return 'Planning the next steps…';

  const events = chronological(run.events ?? []);
  const stepsStarted = events.filter((e) => e.type === 'step_started').length;

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const type = event.type ?? '';
    if (eventVisibility(type) !== 'milestone' || TERMINAL_TYPES.has(type)) continue;
    if (type === 'tool_called' || type === 'tool_started') return `Using ${toolName(event)}…`;
    if (type === 'step_started') return stepsStarted > 0 ? `Working on step ${stepsStarted}…` : 'Working on a step…';
    if (type === 'approval_requested' || type === 'approval_required') return 'Waiting for your approval';
    return friendlyEventMessage(event);
  }
  return 'Working…';
}

/** A single secondary "preview" line for an inbox row — like an email snippet. */
export function runPreview(run: ActivityRunLike): string {
  const state = userFacingRunState(run);
  if (state === 'stalled') return 'No recent progress — needs attention';
  if (userFacingRunStateIsLive(state)) {
    const line = liveLine(run);
    if (line) return line;
  }
  if (run.error) return firstLine(run.error, 160);
  if (run.outputPreview) return firstLine(run.outputPreview, 160);
  return userFacingRunStateLabel(state);
}

/** Milestone-only, human-readable timeline for the clean detail view. */
export function friendlyTimeline(
  events: ActivityEventLike[] | undefined,
): Array<{ type: string; message: string; createdAt?: string }> {
  return chronological(events ?? [])
    .filter((event) => eventVisibility(event.type) === 'milestone')
    .map((event) => ({
      type: event.type ?? '',
      message: friendlyEventMessage(event),
      createdAt: event.createdAt,
    }));
}
