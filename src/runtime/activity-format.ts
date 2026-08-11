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
import {
  isWorkflowTerminalOutcome,
  type WorkflowTerminalOutcome,
} from '../execution/workflow-terminal-outcome.js';
import { SETTLED_READ_REUSE_LABEL } from './harness/settled-read-replay-semantics.js';

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
  needsAttention?: boolean;
  terminalOutcome?: WorkflowTerminalOutcome;
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
  | 'needs_attention'
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
      return data.reused === true ? SETTLED_READ_REUSE_LABEL : `Used ${toolName(event)}`;
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
      return firstLine(data.reply || data.summary, 200) || 'Replied';
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

  if (isWorkflowTerminalOutcome(run.terminalOutcome)) {
    if (run.terminalOutcome === 'failed') return 'failed';
    if (run.terminalOutcome === 'cancelled') return 'cancelled';
    if (run.terminalOutcome === 'partial' || run.terminalOutcome === 'blocked') return 'needs_attention';
    if (run.terminalOutcome === 'succeeded') return 'completed';
  }
  if (status === 'failed' || latestType === 'run_failed' || latestType === 'failed' || run.error) return 'failed';
  if (status === 'cancelled' || latestType === 'cancelled') return 'cancelled';
  if (run.needsAttention === true) return 'needs_attention';
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
    case 'needs_attention':
      return 'Needs attention';
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
    if (type === 'tool_called' || type === 'tool_started') {
      return event.data?.reused === true
        ? SETTLED_READ_REUSE_LABEL
        : `Using ${toolName(event)}…`;
    }
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
  if (state === 'needs_attention' && run.outputPreview) return firstLine(run.outputPreview, 160);
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

// ── PROGRESS NARRATION ────────────────────────────────────────────────────────
//
// A long turn used to report itself as "Still working (18 tool calls so far)."
// on every surface that has no activity pane — Discord, Slack, relay. Live
// 2026-08-09: a four-minute workflow build showed three of those, sixty seconds
// apart, differing only by a number, while the ledger knew she was reading the
// workflow, editing its steps, scheduling it and turning it on. The count is
// the mechanism; the work was already known and thrown away.
//
// The phrasing derives from the tool's own shape rather than a curated
// vocabulary, so a slug nobody has seen before still narrates. Nothing is
// invented: an unrecognised shape falls back to plain liveness rather than
// guessing at intent, because a confident wrong sentence is worse than a
// vague true one.

/** Acquisition/bookkeeping tools. Narrating these is narrating the walk to the
 *  filing cabinet — the same rule the activity feed already applies. */
const NARRATION_SKIPPED =
  /^(?:tool_search|composio_search_tools|composio_list_tools|recall_tool_result|tool_output_query|memory_recall_all|ping)$/i;
/** Generic dispatchers carry someone else's work. Live 2026-08-09: a Slack
 *  lookup narrated as "running" because `run_tool_program` won the last slot
 *  while `SLACK_FIND_USER_BY_EMAIL_ADDRESS` sat one frame behind it. Skip the
 *  wrapper and let the tool that actually ran speak — the same reason the
 *  ledger reads `effectiveTool` over `tool`. */
const NARRATION_DISPATCHERS = /^(?:run_tool_program|composio_execute_tool|call_tool|code_mode|run_code|execution_create)$/i;

/** Verb families, most specific first. Keyed on how tool slugs are actually
 *  built (VERB_OBJECT / object.verb), not on any provider's catalogue. */
const NARRATION_VERBS: ReadonlyArray<readonly [RegExp, string]> = [
  // Each verb must sit on BOTH boundaries of a slug segment. Without the
  // trailing boundary `SLACK_FIND_USER_BY_EMAIL_ADDRESS` matches "add" inside
  // "ADDRESS" and a Slack lookup narrates as "drafting Slack" (live
  // 2026-08-09). Segment-anchored, most specific first.
  [/(?:^|[._])(?:schedule|scheduled|cron)(?:[._]|$)/i, 'scheduling'],
  [/(?:^|[._])(?:activate|enable|publish|deploy)(?:[._]|$)/i, 'turning on'],
  [/(?:^|[._])(?:disable|deactivate|archive)(?:[._]|$)/i, 'turning off'],
  [/(?:^|[._])(?:send|dispatch|post|notify)(?:[._]|$)/i, 'sending'],
  [/(?:^|[._])(?:delete|remove|trash)(?:[._]|$)/i, 'removing'],
  [/(?:^|[._])(?:create|add|insert|new|draft)(?:[._]|$)/i, 'drafting'],
  [/(?:^|[._])(?:update|edit|modify|patch|set|move|rename)(?:[._]|$)/i, 'updating'],
  [/(?:^|[._])(?:get|list|read|search|find|query|fetch|describe|lookup)(?:[._]|$)/i, 'reading'],
  [/(?:^|[._])(?:run|execute|invoke)(?:[._]|$)/i, 'running'],
];

/** The thing being worked on, in the user's words rather than the slug's. */
const NARRATION_SUBJECTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^workflow/i, 'the workflow'],
  [/^(?:space|workspace)/i, 'the workspace'],
  [/^(?:outlook|gmail|mail)/i, 'your email'],
  [/(?:^|_)calendar/i, 'your calendar'],
  [/^salesforce|^sf[_.]/i, 'Salesforce'],
  [/^slack/i, 'Slack'],
  [/^(?:googlesheets|sheets|airtable|notion)/i, 'the sheet'],
  [/^(?:goal|plan)/i, 'the plan'],
  [/^(?:memory|fact|recall)/i, 'what I remember'],
  [/^(?:run_shell_command|shell|cli)/i, 'a command'],
  [/^(?:write_file|read_file|file_query|produce_document)/i, 'the file'],
];

/**
 * One short, true sentence about what a turn is doing right now.
 *
 * `recentToolNames` is oldest-to-newest; the most recent tool that is real work
 * wins, because that is what she is doing at the moment the user is wondering.
 */
export function progressNarration(recentToolNames: readonly string[]): string {
  for (let i = recentToolNames.length - 1; i >= 0; i -= 1) {
    const raw = (recentToolNames[i] ?? '').trim();
    if (!raw) continue;
    // MCP-namespaced tools carry their real name in the last segment.
    const name = raw.split('__').at(-1) ?? raw;
    if (NARRATION_SKIPPED.test(name) || NARRATION_DISPATCHERS.test(name)) continue;
    const verb = NARRATION_VERBS.find(([pattern]) => pattern.test(name))?.[1];
    const subject = NARRATION_SUBJECTS.find(([pattern]) => pattern.test(name))?.[1];
    if (verb && subject) return `Still working — ${verb} ${subject}.`;
    // A verb with nothing to attach it to reads as a fragment ("— running."),
    // which is worse than saying less. Subjects earn the clause, not verbs.
    return 'Still working.';
  }
  return 'Still working.';
}
