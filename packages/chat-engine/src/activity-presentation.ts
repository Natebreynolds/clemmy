import { writeRowLabel, writeRowStatus, writeRowTone } from './write-ledger.js';
import type { ActivityItem, MessageStatus } from './types.js';
import { MODEL_PHASE_ACTIVITY_ID } from './reduce-activity.js';
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
 *      While live and lookup is still in flight, it collapses to one human
 *      row ("Finding the right tool…") so the strip is not a blank pause.
 *      Once lookup has settled and no work row exists yet, the stand-in is
 *      the wait on the next step ("Working on it…") — keeping the lookup
 *      label after search finished is a lie (live 2026-08-28: Grok had
 *      already searched and planned; the phone still said it was finding a
 *      tool). Failed lookups stay visible — they explain the silence.
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
const WORKING_LIVE_LABEL = 'Working on it…';
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
    // Model-side phase is live affordance, not completed work. Keeping it out
    // of settled receipts also prevents "Thinking with X" from inflating the
    // user's step count after the answer lands.
    if (raw.id === MODEL_PHASE_ACTIVITY_ID && options.live !== true) continue;

    // Inventory and compiler sequencing are not work. A leftover Outlook pin
    // or "N6 execute — blocked" is the mechanism, not the job.
    if (isCapabilityInventoryRow(raw)) continue;
    const plan = publicWorkPlanRow(raw);
    if (plan === null) continue;
    const item = plan;

    // 1 — discovery is overhead, unless it FAILED, in which case it is the
    // reason nothing else happened and must stay visible. While live and
    // nothing else is on screen yet, one phase-honest stand-in replaces the
    // blank: lookup in flight vs wait after lookup.
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
  if (options.live && discoverySeen) {
    const modelPhasePresent = out.some((row) => row.id === MODEL_PHASE_ACTIVITY_ID);
    const concreteWorkRunning = out.some((row) => (
      row.status === 'running' && row.id !== MODEL_PHASE_ACTIVITY_ID
    ));
    if (!concreteWorkRunning && (discoveryRunning || !modelPhasePresent)) out.push({
      id: DISCOVERY_LIVE_ID,
      kind: 'event',
      variant: 'lifecycle',
      label: discoveryRunning ? DISCOVERY_LIVE_LABEL : WORKING_LIVE_LABEL,
      status: 'running',
      tone: 'live',
      ...(discoveryStartedAt !== undefined ? { startedAt: discoveryStartedAt } : {}),
    });
  }
  return out;
}

/** The one live headline rule shared by phone surfaces and pure regressions.
 * A settled row is historical evidence, never a description of what is
 * happening now. If no running row exists, retain an honest generic wait. */
export function liveActivityHeadline(items: readonly ActivityItem[]): string {
  let modelPhase: ActivityItem | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.status !== 'running') continue;
    if (item.id !== MODEL_PHASE_ACTIVITY_ID) return item.label;
    modelPhase ??= item;
  }
  return modelPhase?.label ?? WORKING_LIVE_LABEL;
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
 * turn can settle ordinary activity as done; write rows require their own
 * terminal. Failures and parked/stopped turns must
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
    if (item.write) {
      // A chat terminal cannot certify an outstanding write reservation. Keep
      // the call identity so a later exact write terminal can still resolve it.
      const write = item.write.disposition === 'reserved'
        ? { ...item.write, disposition: 'unknown' as const } : item.write;
      return { ...item, write, label: writeRowLabel(write), status: writeRowStatus(write), tone: writeRowTone(write) };
    }
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
  /** Durable-evidence time — the newest thing the record can prove, and the one
   *  `revision` is derived from. It is NOT a heartbeat: for a workflow row it
   *  is pinned to `startedAt` for the whole run, so it says when evidence last
   *  landed and nothing about whether the run is alive. Optional because the
   *  board feed projects cards that have no evidence clock at all; a row
   *  without it is never CALLED stalled, because then it cannot be known. */
  lastEvidenceAt?: string;
  sessionId?: string;
  /** Present only on the operational DTO; a settled row is never current. */
  terminal?: unknown;
}

export type WorkingNowPresentation = 'working' | 'waiting' | 'needs_you';

/**
 * Which of the three things a row is. Additive on purpose: `presentation`
 * keeps its exact old meaning for the six surfaces already rendering from it
 * (a stalled row presents as 'needs_you', which is where every one of them
 * already puts a row that is not in flight — out of Running, into the quiet
 * lane), while `membership` carries the precision the counts are built from.
 */
export type WorkingNowMembership = 'running' | 'stalled' | 'needs_you';

/**
 * How long a row that is not executing — or one whose evidence clock ticks —
 * may stay quiet before calling it current would be a lie.
 *
 * Chosen from the system's own numbers, not from taste:
 *   · the harness clamps its heartbeat check-in to at most 240 minutes
 *     (`intEnv(ENV_KEYS.checkInMinutes, …, 1, 240)` in budget-settings.ts), so
 *     a healthy long run is ALLOWED by configuration to be silent for four
 *     hours between beats;
 *   · two consecutive missed beats is therefore the first silence the system
 *     itself cannot explain.
 *
 * Erring long is the safe direction: a missed stall reads as noise, a wrong
 * stall demotes work that is genuinely alive. It clears the 90-second
 * foreground dwell (WORKING_NOW_FOREGROUND_MS) by 320×, so a chat turn that
 * has been thinking for ninety seconds is never called stalled — and the
 * owner's real rows (blocked two days ago; a run reading 273h) sit 6× and 34×
 * past it.
 */
export const WORKING_NOW_STALL_MS = 8 * 60 * 60 * 1_000;

export interface PresentedWorkingNowEntry<E extends WorkingNowEntryLike> {
  entry: E;
  presentation: WorkingNowPresentation;
  /** Which of the three things this row is. `presentation` is the render hint
   *  six surfaces already switch on; this is the truth the counts come from. */
  membership: WorkingNowMembership;
  /** Convenience mirror of `membership === 'stalled'`, so a surface can say so
   *  without importing the union. */
  stalled: boolean;
  /** Still counted as running, but nothing durable has landed for longer than
   *  WORKING_NOW_STALL_MS and this row carries no clock that could prove
   *  otherwise. The honest words for it are "running, no update in 11d" — not
   *  a stall (we cannot show it stopped) and not a bare "Running" (we would be
   *  reading a start as if it were now). */
  quiet: boolean;
  /** The certificate. True exactly when presentation === 'working', which is
   *  reachable only through `liveness === 'live'`. Pulse visuals render from
   *  this flag and from nothing else. */
  pulse: boolean;
  /** Server-derived age ('' when the timestamps are unusable). */
  elapsed: string;
  /** Server-derived distance from the LAST DURABLE EVIDENCE to the snapshot —
   *  how long this row has been quiet. '' when it cannot be known, which is
   *  the only honest answer for a feed that carries no evidence clock. */
  silence: string;
}

export interface WorkingNowView<E extends WorkingNowEntryLike> {
  /** Entries actually in flight: recently alive, certified live or honestly
   *  unknown. A row nothing has happened to for WORKING_NOW_STALL_MS is NOT
   *  counted here — that count is what said "6 running" with nothing running. */
  running: number;
  /** Entries a person is blocking with something to answer: attention-flagged,
   *  awaiting_*, or a lost lease. Recent — a stale one moves to `stalled`. */
  needsYou: number;
  /** Rows that stopped and stayed stopped past the threshold. A blocked run
   *  from Tuesday lands here rather than in `needsYou`: it is still a pending
   *  item (a blocked run only settles once its report-back is acknowledged —
   *  src/dashboard/activity-projection.ts:167), so this count is the one that
   *  carries it, and a surface that shows needs-you work must show this too. */
  stalled: number;
  /** Rows dropped as settled. Reported so a surface can say "nothing current,
   *  N finished" instead of silently showing an empty panel. */
  settled: number;
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

/** Lifecycles where a person has a QUESTION IN FRONT OF THEM. These never age
 *  out into "stalled": the owner's own rule for what may lead a surface is
 *  "when Clem needs you to answer, and when Clem finishes" — quietly demoting
 *  an unanswered question because it got old is how a decision gets lost. */
const ANSWERABLE_LIFECYCLES: ReadonlySet<string> = new Set([
  'awaiting_approval', 'awaiting_input',
]);

/** Terminal read from the LIFECYCLE, for the DTOs that carry no `terminal`
 *  field. The strict foreground DTO the phone receives is exactly that shape,
 *  so `!entry.terminal` could never see a finished row there. */
const SETTLED_LIFECYCLES: ReadonlySet<string> = new Set([
  'completed', 'failed', 'cancelled',
]);

function isSettled(entry: WorkingNowEntryLike): boolean {
  return Boolean(entry.terminal) || SETTLED_LIFECYCLES.has(entry.lifecycle);
}

/**
 * How long this row has been quiet, in milliseconds, or null when that cannot
 * be known. Both ends are SERVER timestamps; the client clock never enters.
 *
 * `lastEvidenceAt` is the projection's durable-evidence time (and the thing
 * `revision` is itself derived from), so it is the signal used wherever it
 * exists. `startedAt` is the fallback: a row that has produced no evidence
 * since it started has been quiet for exactly its whole life. Returning null —
 * rather than assuming zero or infinity — is what keeps a feed with no
 * evidence clock (the board's cards) from being accused of stalling.
 */
function workingNowSilenceMs(entry: WorkingNowEntryLike, observedAt: string): number | null {
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed)) return null;
  const evidence = entry.lastEvidenceAt ? Date.parse(entry.lastEvidenceAt) : Number.NaN;
  const started = Date.parse(entry.startedAt);
  const latest = Number.isFinite(evidence) ? evidence : started;
  if (!Number.isFinite(latest)) return null;
  // A clock that runs backwards is not evidence of silence.
  return observed < latest ? 0 : observed - latest;
}

/**
 * Has this row's evidence clock actually TICKED — has anything durable landed
 * since it started? Only then is its silence a measurement rather than its own
 * age. A workflow run answers false for its entire life (the projection pins
 * `lastEvidenceAt` to `startedAt` until it finishes), which is exactly why age
 * alone may not end its claim to be running.
 */
function evidenceClockAdvanced(entry: WorkingNowEntryLike): boolean {
  if (!entry.lastEvidenceAt) return false;
  const evidence = Date.parse(entry.lastEvidenceAt);
  const started = Date.parse(entry.startedAt);
  if (!Number.isFinite(evidence) || !Number.isFinite(started)) return false;
  return evidence > started;
}

/**
 * Is this row known NOT to be executing? A person is the blocker, or the
 * server says the owner stopped proving it is alive. These rows already
 * stopped, so their age is a fact about how long they have been stopped —
 * safe to demote. Anything else is presumed to be working until something
 * durable says otherwise.
 */
function workingNowHalted(entry: WorkingNowEntryLike): boolean {
  return entry.needsAttention
    || NEEDS_YOU_LIFECYCLES.has(entry.lifecycle)
    || entry.liveness === 'stale';
}

function workingNowMembershipFor(
  entry: WorkingNowEntryLike,
  silenceMs: number | null,
  halted: boolean,
  clockAdvanced: boolean,
): WorkingNowMembership {
  // A question outranks its own age.
  if (ANSWERABLE_LIFECYCLES.has(entry.lifecycle)) return 'needs_you';
  // Age may end a claim of running only where it is really evidence: the row
  // is already stopped, or its clock demonstrably ticks and went quiet. On a
  // row that is neither, "Running · 273h" is a bad answer — but "Stopped" is a
  // worse one, because nothing here can prove it.
  if (silenceMs !== null && silenceMs >= WORKING_NOW_STALL_MS && (halted || clockAdvanced)) {
    return 'stalled';
  }
  if (halted) return 'needs_you';
  return 'running';
}

function workingNowPresentationFor(
  entry: WorkingNowEntryLike,
  membership: WorkingNowMembership,
): WorkingNowPresentation {
  // Both non-running memberships render in the quiet lane, which is where the
  // six existing call sites already send anything that is not in flight. This
  // is what lets the new class land without reshaping `presentation` out from
  // under them.
  if (membership !== 'running') return 'needs_you';
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
  return compactAgeLabel(observed - started);
}

function compactAgeLabel(ms: number): string {
  if (ms < 60_000) return '<1m';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

/**
 * Present the server's Working-Now entries for rendering. Pure and total:
 * `observedAt` is the snapshot's own server timestamp, passed as data, and
 * every age in the result is the distance between two SERVER timestamps.
 *
 * Membership is the three-way decision at the top of this section: settled
 * rows leave (counted in `settled` so a surface can say so), quiet rows are
 * reported as `stalled`, and only what is left may be called running.
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
  const watched = (entry: E): boolean => Boolean(options.omitSessionId)
    && entry.sessionId === options.omitSessionId;
  let settled = 0;
  const current: E[] = [];
  for (const entry of entries) {
    if (isSettled(entry)) { if (!watched(entry)) settled += 1; continue; }
    if (watched(entry)) continue;
    current.push(entry);
  }
  const presented = current.map((entry): PresentedWorkingNowEntry<E> => {
    const silenceMs = workingNowSilenceMs(entry, observedAt);
    const membership = workingNowMembershipFor(
      entry,
      silenceMs,
      workingNowHalted(entry),
      evidenceClockAdvanced(entry),
    );
    const presentation = workingNowPresentationFor(entry, membership);
    return {
      entry,
      presentation,
      membership,
      stalled: membership === 'stalled',
      quiet: membership === 'running' && silenceMs !== null && silenceMs >= WORKING_NOW_STALL_MS,
      pulse: presentation === 'working',
      elapsed: workingNowElapsedLabel(entry.startedAt, observedAt),
      silence: silenceMs === null ? '' : compactAgeLabel(silenceMs),
    };
  });
  const needsYou = presented.filter((p) => p.membership === 'needs_you').length;
  const stalled = presented.filter((p) => p.membership === 'stalled').length;
  const running = presented.length - needsYou - stalled;
  // The label says all three, in the order a person cares about them. "6
  // running" with nothing running was the whole defect: `running` can now only
  // count rows something has actually happened to.
  const label = [
    running > 0 ? `${running} running` : null,
    needsYou > 0 ? `${needsYou} need${needsYou === 1 ? 's' : ''} you` : null,
    stalled > 0 ? `${stalled} stalled` : null,
  // No "N current tasks" fallback: the three counts partition `presented`, so
  // a non-empty view always words itself above and that branch could never
  // run. The empty ones stay — `settled` is non-zero whenever the board feed
  // hands its Done column to this presenter (apps/console-web/src/lib/board.ts
  // `presentBoardWorkingNow`), which is the case this wording exists for.
  ].filter(Boolean).join(' · ')
    || (settled > 0 ? `${settled} finished` : 'Nothing running');
  return { running, needsYou, stalled, settled, total: presented.length, label, entries: presented };
}

// ─── The words on the row ─────────────────────────────────────────────────────
//
// The chip and the rows one element below it used to be worded by different
// files, and they disagreed: the chip said "21 stalled" over a list whose every
// row said "Needs review". Both now come from here, so a surface cannot invent
// a third vocabulary — and neither one may say a past fact in the present tense.

/** Human vocabulary for a server-owned lifecycle. Unknown values fail closed
 *  instead of turning an internal spelling into user-facing state. */
export function workingNowLifecycleLabel(lifecycle: string): string {
  const labels: Record<string, string> = {
    accepted: 'Accepted',
    queued: 'Queued',
    reasoning: 'Running',
    retrieving: 'Reading',
    using_tool: 'Running',
    fanout: 'Running',
    reducing: 'Combining',
    verifying: 'Verifying',
    awaiting_input: 'Waiting for input',
    awaiting_approval: 'Waiting for approval',
    paused_budget: 'Stopped',
    retrying: 'Retrying',
    completing: 'Finishing',
    blocked: 'Needs review',
    completed: 'Done',
    failed: 'Failed',
    cancelled: 'Stopped',
  };
  return labels[lifecycle] ?? 'Status unavailable';
}

/**
 * The one line under a run row's title.
 *
 * Three cases, matching the three memberships, in the same words the pill uses:
 *   · STALLED — it stopped, and this is how long ago. Its own lifecycle word
 *     ("Needs review", "Running") describes the moment it stopped, and printing
 *     that alone is what put six two-day-old blocked runs under a heading that
 *     said Running.
 *   · NEEDS YOU — the lifecycle word IS the ask.
 *   · RUNNING — the server's own phase text; and when the row is `quiet`, the
 *     age is appended rather than hidden, because a row nothing has landed on
 *     for eleven days may not present as plain "Running".
 *
 * Every age here is server-derived (observedAt − lastEvidenceAt); no client
 * clock enters.
 */
export function workingNowStatusLabel(input: {
  membership: WorkingNowMembership;
  /** From the presented entry; '' when it cannot be known. */
  silence: string;
  quiet?: boolean;
  lifecycle: string;
  /** The server's live phase text, when the DTO carries one. */
  phase?: string;
}): string {
  const lifecycle = workingNowLifecycleLabel(input.lifecycle);
  // A stalled row always has a measurable silence — membership 'stalled' is
  // only reachable through a non-null silenceMs — so there is no "no recent
  // activity" case to word.
  if (input.membership === 'stalled') return `Stalled · nothing for ${input.silence}`;
  if (input.membership === 'needs_you') return lifecycle;
  const base = input.phase?.trim() || lifecycle;
  return input.quiet && input.silence ? `${base} · no update in ${input.silence}` : base;
}
