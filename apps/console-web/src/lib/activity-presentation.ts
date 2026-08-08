import type { ActivityItem, MessageStatus } from './useChat';

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
 *      narrating a walk to the filing cabinet. It is hidden, not deleted — the
 *      rows still exist for diagnostics, they just stop competing with the work
 *      for the user's attention.
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
}

/** Collapse a run's rows into what a person would say they did. */
export function narrateActivity(
  items: readonly ActivityItem[],
  options: NarrateOptions = {},
): ActivityItem[] {
  if (options.verbose) return [...items];
  const out: ActivityItem[] = [];
  for (const item of items) {
    // 1 — discovery is overhead, unless it FAILED, in which case it is the
    // reason nothing else happened and must stay visible.
    if (isDiscoveryRow(item) && item.status !== 'failed') continue;

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
  return items.map((item) => (item.status === 'running' ? { ...item, status } : item));
}

export function activityTerminalOutcomeForMessageStatus(
  status: MessageStatus | undefined,
): ActivityTerminalOutcome | undefined {
  if (status === 'thinking') return undefined;
  if (status === 'complete') return 'completed';
  if (status === 'failed') return 'failed';
  return 'interrupted';
}

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
