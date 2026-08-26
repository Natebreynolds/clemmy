import type { ActivityItem, MessageStatus } from './types.js';
import { isWorkPlanRow, workPlanStepLabel } from './work-plan-presentation.js';

export type ActivityTerminalOutcome = 'completed' | 'failed' | 'interrupted';

/**
 * NARRATION — show the work, not the mechanism.
 *
 * The feed was one row per tool call, in call order, with the runtime's own
 * diagnostics rendered verbatim. On a live single-email task that read as:
 * fifteen "searching" rows, three identical profile lookups, six mail writes,
 * and a line saying "Grounded in what's proven: 1 proven tool, 2 not
 * connected" — a debug log wearing a UI.
 *
 * A person narrating the same work says what they did, not which functions
 * they called. Three rules do most of that:
 *
 *   1. DISCOVERY IS NOT WORK. Looking up which tool to use is overhead, like
 *      narrating a walk to the filing cabinet. After the turn it is hidden.
 *      While live and nothing else has happened yet, it collapses to one
 *      human row ("Finding the right tool…") so the strip is not a blank
 *      pause. Failed lookups stay visible — they explain the silence.
 *   2. REPETITION IS ONE THING HAPPENING, NOT MANY. Three identical lookups are
 *      one line with a count. This also stops a retry storm from burying the
 *      one row that matters.
 *   3. AN ATTEMPT AND ITS OUTCOME ARE THE SAME ROW. Rendering them as siblings
 *      made a clean failure read as chaos.
 *
 * Pure and total: no clock, no I/O, no mutation of the input. Order of the
 * surviving rows is preserved, because the sequence IS the story.
 */

/** Rows that describe finding a capability rather than using one. Matched on
 *  the runtime's own tool names, so a renamed label cannot silently unhide a
 *  row — and anything unrecognised stays VISIBLE, which is the safe direction
 *  for a filter (a missed hide is noise; a wrong hide is a lie). */
const DISCOVERY_TOOLS: ReadonlySet<string> = new Set([
  'tool_search', 'composio_search_tools', 'composio_list_tools',
  'tool_output_query', 'recall_tool_result', 'composio_status',
]);

const DISCOVERY_LABEL_RE = /^(?:using\s+)?(?:tool[_ ]search|composio[_ ](?:search[_ ]tools|list[_ ]tools|status)|searching\b|looking up\b|finding\b)/i;

export function isDiscoveryRow(item: Pick<ActivityItem, 'kind' | 'label'>): boolean {
  if (item.kind !== 'tool') return false;
  const normalized = item.label.trim().toLowerCase().replace(/\s+/g, '_');
  if (DISCOVERY_TOOLS.has(normalized)) return true;
  return DISCOVERY_LABEL_RE.test(item.label.trim());
}

export interface NarrateOptions {
  /** Diagnostics mode keeps every row exactly as the runtime emitted it. The
   *  detail is never destroyed — this only decides who it is for. */
  verbose?: boolean;
  /** While the turn is live, keep one human stand-in for discovery so the
   *  strip is not empty during the lookup phase. After the turn, discovery
   *  stays hidden — it is not work. */
  live?: boolean;
}

const DISCOVERY_LIVE_ID = 'discovery-live';
const DISCOVERY_LIVE_LABEL = 'Finding the right tool…';
const CAPABILITY_INVENTORY_RE = /^Grounded in what's proven:/i;
const COMPILER_NODE_LABEL_RE = /^N\d+\s+/i;
const BLOCKED_PLAN_LABEL_RE = /— blocked$/i;

function isCapabilityInventoryRow(item: Pick<ActivityItem, 'kind' | 'label'>): boolean {
  return item.kind === 'event' && CAPABILITY_INVENTORY_RE.test(item.label.trim());
}

/** Already-reduced plan rows from an older client: drop compiler indexes and
 *  "blocked" sequencing, and speak the work. */
function publicWorkPlanRow(item: ActivityItem): ActivityItem | null {
  if (!isWorkPlanRow(item)) return item;
  if (BLOCKED_PLAN_LABEL_RE.test(item.label) || /waiting on /i.test(item.detail ?? '')) {
    return null;
  }
  const stripped = item.label.replace(COMPILER_NODE_LABEL_RE, '').replace(/\s+complete$/i, '').trim();
  const done = item.status === 'done' || /complete$/i.test(item.label);
  const effect = /^retriev/i.test(stripped) ? 'read'
    : /^execut/i.test(stripped) ? 'external_write'
      : undefined;
  const label = effect
    ? workPlanStepLabel({ id: stripped, effect }, done)
    : (COMPILER_NODE_LABEL_RE.test(item.label) ? stripped : item.label);
  if (label === item.label && !item.detail) return item;
  return { ...item, label, detail: undefined };
}

/** Collapse a run's rows into what a person would say they did. */
export function narrateActivity(
  items: readonly ActivityItem[],
  options: NarrateOptions = {},
): ActivityItem[] {
  if (options.verbose) return [...items];
  const out: ActivityItem[] = [];
  let discoverySeen = false;
  let discoveryRunning = false;
  let discoveryStartedAt: number | undefined;
  for (const raw of items) {
    // Inventory and compiler sequencing are not work. A leftover Outlook pin
    // or "N6 execute — blocked" is the mechanism, not the job.
    if (isCapabilityInventoryRow(raw)) continue;
    const plan = publicWorkPlanRow(raw);
    if (plan === null) continue;
    const item = plan;

    // 1 — discovery is overhead, unless it FAILED, in which case it is the
    // reason nothing else happened and must stay visible. While live and
    // nothing else is on screen yet, one human stand-in replaces the blank.
    if (isDiscoveryRow(item) && item.status !== 'failed') {
      discoverySeen = true;
      if (item.status === 'running') discoveryRunning = true;
      if (item.startedAt && discoveryStartedAt === undefined) discoveryStartedAt = item.startedAt;
      continue;
    }

    // 2/3 — fold into the previous row when it is the same thing again. A
    // terminal status always wins over a running one: the row's state is the
    // outcome, never the attempt.
    const previous = out[out.length - 1];
    if (previous && previous.kind === item.kind && previous.label === item.label) {
      const repeats = (previous.repeats ?? 1) + 1;
      out[out.length - 1] = {
        ...previous,
        repeats,
        status: item.status === 'running' ? previous.status : item.status,
        // Keep the earliest start so the elapsed timer measures the whole thing.
        ...(previous.startedAt ? { startedAt: previous.startedAt } : item.startedAt ? { startedAt: item.startedAt } : {}),
        ...(item.detail && !previous.detail ? { detail: item.detail } : {}),
      };
      continue;
    }
    out.push({ ...item });
  }
  if (options.live && discoverySeen && out.length === 0) {
    return [{
      id: DISCOVERY_LIVE_ID,
      kind: 'event',
      variant: 'lifecycle',
      label: DISCOVERY_LIVE_LABEL,
      status: discoveryRunning ? 'running' : 'done',
      tone: discoveryRunning ? 'live' : 'muted',
      ...(discoveryStartedAt !== undefined ? { startedAt: discoveryStartedAt } : {}),
    }];
  }
  return out;
}

/** How many rows the narration hid, so a diagnostics affordance can offer them
 *  rather than pretending they never existed. */
export function hiddenActivityCount(
  items: readonly ActivityItem[],
  narrated: readonly ActivityItem[],
): number {
  return Math.max(0, items.length - narrated.length);
}

/**
 * Close only activity rows whose terminal event never arrived. A successful
 * turn can safely settle them as done; failures and parked/stopped turns must
 * remain visibly non-successful.
 */
export function settleTerminalActivity(
  items: ActivityItem[],
  outcome?: ActivityTerminalOutcome,
): ActivityItem[] {
  if (!outcome) return items;
  const status: ActivityItem['status'] = outcome === 'completed'
    ? 'done'
    : outcome === 'failed'
      ? 'failed'
      : 'interrupted';
  return items.map((item) => {
    if (item.status !== 'running') return item;
    // Host plan rows already carry their own truth. An open requirement is
    // not done just because the chat turn ended.
    if (isWorkPlanRow(item)) {
      return {
        ...item,
        status: outcome === 'failed' ? 'failed' : 'interrupted',
        tone: item.tone === 'live' ? 'muted' : item.tone,
      };
    }
    return { ...item, status };
  });
}

export function activityTerminalOutcomeForMessageStatus(
  status: MessageStatus | undefined,
): ActivityTerminalOutcome | undefined {
  if (status === 'thinking') return undefined;
  if (status === 'complete') return 'completed';
  if (status === 'failed') return 'failed';
  return 'interrupted';
}

export {
  humanizeRequirementId,
  isWorkPlanRow,
  workPlanActivityItem,
  workPlanStepLabel,
} from './work-plan-presentation.js';

/**
 * Prefer the durable harness terminal event; without one, fail closed as an
 * interruption instead of painting unmatched calls green.
 */
export function activityTerminalOutcomeFromHarnessEvents(
  events: ReadonlyArray<{ type: string }>,
  live: boolean,
): ActivityTerminalOutcome | undefined {
  if (live) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'run_failed') return 'failed';
    if (events[index]?.type === 'conversation_completed') return 'completed';
  }
  return 'interrupted';
}

// ─── The ONE Working-Now presenter ───────────────────────────────────────────
//
// The Working-Now surfaces (desktop badge, desktop drawer, mobile pill,
// mobile Home) each re-derived "running" and "needs you" from the raw projection and
// disagreed — the owner met a task pill full of dead tasks and a stale mobile
// task section. Every surface now renders THIS function's output and nothing
// else.
//
// The design law it enforces: a pulsing "Working" state is a CERTIFICATE. It
// is only renderable when the server said `liveness === 'live'`; the
// 'working' presentation (and its `pulse` flag) is structurally unreachable
// for any other entry. Elapsed time is the distance between two SERVER
// timestamps (startedAt → the snapshot's observedAt) — the client clock never
// enters.

/** The structural slice of a projection entry the presenter needs. Both the
 *  operational Activity DTO and the strict foreground DTO satisfy it. */
export interface WorkingNowEntryLike {
  runKey: string;
  lifecycle: string;
  /** Server-owned: lease truth, never "no event for N seconds". */
  liveness: string;
  needsAttention: boolean;
  startedAt: string;
  sessionId?: string;
  /** Present only on the operational DTO; a settled row is never current. */
  terminal?: unknown;
}

export type WorkingNowPresentation = 'working' | 'waiting' | 'needs_you';

export interface PresentedWorkingNowEntry<E extends WorkingNowEntryLike> {
  entry: E;
  presentation: WorkingNowPresentation;
  /** The certificate. True exactly when presentation === 'working', which is
   *  reachable only through `liveness === 'live'`. Pulse visuals render from
   *  this flag and from nothing else. */
  pulse: boolean;
  /** Server-derived age ('' when the timestamps are unusable). */
  elapsed: string;
}

export interface WorkingNowView<E extends WorkingNowEntryLike> {
  /** Entries actually in flight (certified live or honestly unknown). */
  running: number;
  /** Entries a person is blocking: attention-flagged, awaiting_*, or stale. */
  needsYou: number;
  total: number;
  /** The pill text every trigger shows, so no surface words it differently. */
  label: string;
  entries: PresentedWorkingNowEntry<E>[];
}

/** Lifecycles where a person is the blocker, mirrored from the projection's
 *  own attention set — waiting on you outranks any liveness claim. */
const NEEDS_YOU_LIFECYCLES: ReadonlySet<string> = new Set([
  'blocked', 'awaiting_approval', 'awaiting_input', 'paused_budget',
]);

function workingNowPresentationFor(entry: WorkingNowEntryLike): WorkingNowPresentation {
  if (entry.needsAttention || NEEDS_YOU_LIFECYCLES.has(entry.lifecycle)) return 'needs_you';
  // A stale non-terminal run lost its lease: that is a fact for a person,
  // never quiet background running.
  if (entry.liveness === 'stale') return 'needs_you';
  // The certificate: 'working' exists only inside this branch.
  if (entry.liveness === 'live') return 'working';
  return 'waiting';
}

/** Compact server-clock age: "<1m", "12m", "3h", "2d". A label, never a
 *  status — it may not decide tone, membership, or liveness. */
export function workingNowElapsedLabel(startedAt: string, observedAt: string): string {
  const started = Date.parse(startedAt);
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(started) || !Number.isFinite(observed) || observed < started) return '';
  const ms = observed - started;
  if (ms < 60_000) return '<1m';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

/**
 * Present the server's Working-Now entries for rendering. Pure and total:
 * `observedAt` is the snapshot's own server timestamp, passed as data.
 */
export function presentWorkingNow<E extends WorkingNowEntryLike>(
  entries: readonly E[],
  observedAt: string,
  options: {
    /** The conversation the user is currently watching — its bubble already
     *  narrates itself, so it never counts as detached work. */
    omitSessionId?: string | null;
  } = {},
): WorkingNowView<E> {
  const current = entries.filter((entry) => !entry.terminal
    && !(options.omitSessionId && entry.sessionId === options.omitSessionId));
  const presented = current.map((entry): PresentedWorkingNowEntry<E> => {
    const presentation = workingNowPresentationFor(entry);
    return {
      entry,
      presentation,
      pulse: presentation === 'working',
      elapsed: workingNowElapsedLabel(entry.startedAt, observedAt),
    };
  });
  const needsYou = presented.filter((p) => p.presentation === 'needs_you').length;
  const running = presented.length - needsYou;
  const label = [
    running > 0 ? `${running} running` : null,
    needsYou > 0 ? `${needsYou} need${needsYou === 1 ? 's' : ''} you` : null,
  ].filter(Boolean).join(' · ')
    || `${presented.length} current ${presented.length === 1 ? 'task' : 'tasks'}`;
  return { running, needsYou, total: presented.length, label, entries: presented };
}
