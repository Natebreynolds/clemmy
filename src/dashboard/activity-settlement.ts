/**
 * Settle the notebook's linked actions from the activity projection.
 *
 * A focus action is linked to the work it dispatched by ONE id, and which id
 * that is depends on the lane that dispatched it: a background task links by
 * task id, a workflow by run id, a durable fan-out by plan id. Settlement then
 * calls back with whatever id ITS lane knows, so any lane whose settlement id
 * differs from its link id leaves the action reading "running" forever — long
 * after the work completed, failed, or stopped needing anything.
 *
 * This closes that class from the projection side rather than per lane: for a
 * run the projection says is settled or blocked, every identity that run owns
 * is offered to the notebook, and whichever one the action was linked by
 * matches. Nothing is invented — an action only moves when the projection
 * carries a durable terminal or a durable needs-attention state for the exact
 * work it references.
 */
import {
  getFocusWorkstate,
  listFocuses,
  updateLinkedFocusAction,
  type FocusActionStatus,
} from '../memory/focus.js';
import type { ActivityEntry } from './activity-projection.js';

/** Every durable identity a projection entry can have been linked by. The plan
 *  id comes first: it is the id the fan-out dispatch links its action by. */
function identitiesFor(entry: ActivityEntry): string[] {
  return [entry.planId, entry.taskId, entry.runId, entry.sessionId, entry.runKey]
    .filter((value): value is string => Boolean(value && value.trim()));
}

interface Settlement {
  status: FocusActionStatus;
  note?: string;
}

/**
 * What the notebook should say about this run now. A successful terminal is
 * done; anything else that has stopped moving on its own is blocked, which is
 * the notebook's word for "this needs you" — never done, and never still
 * running.
 */
function settlementFor(entry: ActivityEntry): Settlement | null {
  if (entry.terminal) {
    return entry.terminal.status === 'completed'
      ? { status: 'done', note: entry.terminal.text }
      : { status: 'blocked', note: entry.terminal.text };
  }
  if (entry.needsAttention) {
    return { status: 'blocked', ...(entry.nextAction ? { note: entry.nextAction } : {}) };
  }
  return null;
}

/**
 * Reconcile linked actions against the projection. Returns how many actions
 * moved, so a caller can log a real number instead of assuming.
 *
 * The live notebook is read ONCE and only refs it actually carries are pushed
 * back, because this runs on a polled endpoint: a settlement pass must cost one
 * read when there is nothing to settle, which is almost always.
 */
export function settleFocusActionsForTerminals(entries: readonly ActivityEntry[]): number {
  let linkedRefs: Set<string>;
  try {
    linkedRefs = new Set<string>();
    for (const row of listFocuses({ includeTerminal: false, limit: 50 })) {
      const workstate = getFocusWorkstate(row);
      for (const action of workstate?.actions ?? []) {
        // Only an action still claiming to run can be out of date.
        if (action.status !== 'running') continue;
        if (action.ref) linkedRefs.add(action.ref);
        linkedRefs.add(action.id);
      }
    }
  } catch {
    return 0;
  }
  if (linkedRefs.size === 0) return 0;

  let settled = 0;
  for (const entry of entries) {
    const settlement = settlementFor(entry);
    if (!settlement) continue;
    for (const ref of identitiesFor(entry)) {
      if (!linkedRefs.has(ref)) continue;
      try {
        settled += updateLinkedFocusAction(ref, settlement);
      } catch { /* the notebook is best-effort; the run's own truth is durable */ }
    }
  }
  return settled;
}
