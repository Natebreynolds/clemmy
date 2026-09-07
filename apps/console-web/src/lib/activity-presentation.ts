import type { ActivityItem, MessageStatus } from './useChat';
import { isWorkPlanRow, workPlanStepLabel } from './work-plan-presentation';

export type ActivityTerminalOutcome = 'completed' | 'failed' | 'interrupted';

/**
 * NARRATION — show the work, not the mechanism.
 *
 * The feed was one row per tool call, in call order, with the runtime's own
 * diagnostics rendered verbatim. On a live single-email task that read as:
 * fifteen "searching" rows, three identical profile lookups, six mail writes,
 * and a line saying "Grounded in what's proven: 1 proven tool, 2 not
 * connected" — a debug log wearing a UI. The owner's summary was that it is
 * "stuff users will most likely never understand".
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
 *      produced "Created a draft to X" directly above "Created a draft to X —
 *      failed", which made a clean failure read as chaos (live 2026-08-07).
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
  if (options.live && discoverySeen && out.length === 0) {
    return [{
      id: DISCOVERY_LIVE_ID,
      kind: 'event',
      variant: 'lifecycle',
      label: discoveryRunning ? DISCOVERY_LIVE_LABEL : WORKING_LIVE_LABEL,
      status: 'running',
      tone: 'live',
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
} from './work-plan-presentation';

/**
 * The board can lag or project several terminal statuses into one column.
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

// ─── Working Now: the ONE presenter, consolidated in the shared package ──────
// The desktop badge and drawer render Working-Now counts from the SAME
// function the mobile PWA uses — and so does /tasks, which used to derive its
// own Running column straight from the board feed. That split meant the badge
// that sends you to /tasks and the board you land on gave two answers to one
// question; lib/board.ts (presentBoardWorkingNow) now routes the board's live
// rows through this function too. It lives in @clem/chat-engine
// (packages/chat-engine/src/activity-presentation.ts); the console re-exports
// it here rather than keeping a private copy — a second derivation is exactly
// how five surfaces came to disagree about one question.
//
// Membership is part of that one truth as of 2026-09-06: the presenter
// separates RUNNING from STALLED (a row that is not executing and has stayed
// that way past WORKING_NOW_STALL_MS) and drops SETTLED rows by lifecycle as
// well as by the typed terminal. `view.running` therefore counts only work
// nothing has disproved, and `presented.stalled` / `presented.silence` give a
// surface the honest words for a row that stopped days ago.
//
// So are the WORDS. workingNowStatusLabel is the one status line every row
// renders — the chip said "21 stalled" over a list whose rows each said "Needs
// review", because two files were wording the same fact.
export {
  presentWorkingNow,
  workingNowElapsedLabel,
  workingNowLifecycleLabel,
  workingNowStatusLabel,
  WORKING_NOW_STALL_MS,
  type PresentedWorkingNowEntry,
  type WorkingNowEntryLike,
  type WorkingNowMembership,
  type WorkingNowPresentation,
  type WorkingNowView,
} from '../../../../packages/chat-engine/src/activity-presentation';
