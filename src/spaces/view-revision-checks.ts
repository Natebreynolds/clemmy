/**
 * The checks every new Workspace view version goes through, whoever makes it:
 * Clem editing or reverting the view, or the owner restoring an earlier version
 * from the console.
 *
 * Two parts. `newBreakingGaps` compares the view before and after a change and
 * returns only the gaps the change itself introduces (a script that no longer
 * parses, a source or action the view stops using), so an edit can be refused
 * before it goes live without ever blocking work on a view that already had
 * them. `recordViewGapNote` records the current verdict as the newest gap note,
 * which is what the desktop banner shows.
 */
import { ensureToolSchema } from '../tools/composio-schema-cache.js';
import { appendNote } from './data-store.js';
import { analyzeSpaceGaps, renderSpaceGapQuestions, type SpaceGap } from './space-gap-test.js';
import type { SpaceAction, SpaceRecord } from './store.js';

/** At most this many action schemas are read for one check. */
export const SPACE_SAVE_MAX_READ_PREPARATIONS = 12;

export interface WorkspaceActionInputContract {
  actionInputRequirements: Record<string, string[]>;
  actionInputNames: Record<string, string[]>;
}

/**
 * Action id → the inputs its operation REQUIRES (declared required, no schema
 * default), read from the operation's input schema without calling it. The gap
 * test compares these against the args template and the view's literal
 * clem.action call, so a button that could never succeed is caught at save
 * instead of by clicking it against real data. An unreadable schema is simply
 * not checked.
 */
export async function workspaceActionInputContract(
  actions: readonly SpaceAction[],
): Promise<WorkspaceActionInputContract> {
  const requirements: Record<string, string[]> = {};
  const names: Record<string, string[]> = {};
  for (const action of actions.slice(0, SPACE_SAVE_MAX_READ_PREPARATIONS)) {
    const operationId = action.composioSlug?.trim().toUpperCase();
    if (!operationId) continue;
    let schema: Record<string, unknown> | null = null;
    try { schema = await ensureToolSchema(operationId); } catch { schema = null; }
    const required = Array.isArray(schema?.required)
      ? (schema!.required as unknown[]).filter((name): name is string => typeof name === 'string' && name.length > 0)
      : [];
    const properties = schema?.properties && typeof schema.properties === 'object'
      ? schema.properties as Record<string, unknown>
      : {};
    const withoutDefault = required.filter((name) => {
      const property = properties[name];
      return !(property && typeof property === 'object' && Object.prototype.hasOwnProperty.call(property, 'default'));
    });
    if (withoutDefault.length > 0) requirements[action.id] = withoutDefault;
    if (schema) names[action.id] = Object.keys(properties);
  }
  return { actionInputRequirements: requirements, actionInputNames: names };
}

function gapKey(gap: SpaceGap): string {
  return [gap.why, gap.sourceId ?? '', gap.actionId ?? '', gap.unreferenced ?? ''].join('|');
}

/** The must-fix gaps `afterHtml` has that `beforeHtml` did not. */
export function newBreakingGaps(
  record: SpaceRecord,
  beforeHtml: string,
  afterHtml: string,
  contract: WorkspaceActionInputContract,
): SpaceGap[] {
  const before = new Set(
    analyzeSpaceGaps(record, beforeHtml, [], contract).filter((gap) => gap.resolution === 'fix').map(gapKey),
  );
  return analyzeSpaceGaps(record, afterHtml, [], contract)
    .filter((gap) => gap.resolution === 'fix' && !before.has(gapKey(gap)));
}

/**
 * Record the gap test's verdict on the view as it now stands, as the newest gap
 * note, and return it rendered for the author. Advisory only: a failure to
 * record never fails the change that was already saved.
 */
export async function recordViewGapNote(record: SpaceRecord, html: string): Promise<string> {
  try {
    const gaps = analyzeSpaceGaps(record, html, [], await workspaceActionInputContract(record.actions));
    appendNote(record.id, {
      text: gaps.length > 0 ? `Gap test flagged ${gaps.length} item${gaps.length === 1 ? '' : 's'} to confirm.` : 'Gap test: clean.',
      kind: 'gap',
      meta: { gaps: gaps.map((g) => ({ question: g.question, why: g.why })) },
    });
    return gaps.length > 0 ? renderSpaceGapQuestions(gaps) : '\n\nGap test: clean — the confirm banner clears on next load.';
  } catch {
    return '';
  }
}
