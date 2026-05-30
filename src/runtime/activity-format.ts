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
  metadata?: Record<string, unknown> | null;
  events?: ActivityEventLike[];
}

export type EventVisibility = 'milestone' | 'noise';
export type RunCategory = 'chat' | 'workflow' | 'scheduled' | 'background';

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
  const metaSource = String((run.metadata ?? {}).source ?? '').toLowerCase();

  if (kind === 'workflow' || channel === 'workflow' || source === 'workflow' || metaSource === 'workflow') {
    return 'workflow';
  }
  if (
    source === 'cron'
    || metaSource === 'cron'
    || metaSource === 'schedule'
    || metaSource === 'scheduled'
    || channel.startsWith('cron')
    || channel.startsWith('schedule')
  ) {
    return 'scheduled';
  }
  if (run.queuedTaskId || kind === 'agent' || kind === 'execution') {
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
      return 'Waiting for your approval';
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
    || status === 'queued'
    || status === 'awaiting_approval';
}

/**
 * One-line "what is it doing right now" for a live run, derived from the most
 * recent meaningful (non-terminal milestone) event. Returns '' for runs that
 * are not live.
 */
export function liveLine(run: ActivityRunLike): string {
  if (!isLive(run.status)) return '';
  if (run.status === 'awaiting_approval') return 'Waiting for your approval';
  if (run.status === 'queued') return 'Queued to start';

  const events = run.events ?? [];
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
  if (isLive(run.status)) {
    const line = liveLine(run);
    if (line) return line;
  }
  if (run.error) return firstLine(run.error, 160);
  if (run.outputPreview) return firstLine(run.outputPreview, 160);
  return friendlyStatusLabel(run.status);
}

/** Milestone-only, human-readable timeline for the clean detail view. */
export function friendlyTimeline(
  events: ActivityEventLike[] | undefined,
): Array<{ type: string; message: string; createdAt?: string }> {
  return (events ?? [])
    .filter((event) => eventVisibility(event.type) === 'milestone')
    .map((event) => ({
      type: event.type ?? '',
      message: friendlyEventMessage(event),
      createdAt: event.createdAt,
    }));
}
