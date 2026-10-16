import type { SpaceRecord } from './store.js';

/**
 * After a Workspace is created or redesigned for a request, the owner's checker
 * model reads the request beside what was saved and names each thing the
 * Workspace should let them see or do that it does not yet. The save stands;
 * the note tells Clem what to build before she says it is done.
 */
export const WORKSPACE_DELIVERABLES_SYSTEM = [
  'You check whether a just-saved Workspace (a live page the owner works in) delivers what the owner asked for.',
  'From the request and the Workspace objective, list the things this Workspace itself should let the owner see or do, at most 8.',
  'Skip work the request assigns elsewhere (code changes in a repository, a separate scheduled job), except that the Workspace should show that work\'s results and let the owner act on them when the request connects them.',
  'Mark an item covered only when the Workspace shows it from a data source or feed workflow, or has a working button for it.',
  'A link out to another tool, a static sentence, or a placeholder is not coverage.',
  'For each item not covered, the gap says in one sentence what to add (a feed workflow for live data, a button that runs a workflow, a review queue with previews).',
  'Return only a WorkspaceDeliverablesV1 JSON object.',
].join(' ');

export interface WorkspaceDeliverable { deliverable: string; covered: boolean; gap: string }

export interface WorkspaceDeliverablesInput {
  request: string;
  record: SpaceRecord;
  viewHtml: string;
  feeds: ReadonlyArray<{ workflow: string; collections: readonly string[] }>;
}

type Reader = (system: string, user: string, signal: AbortSignal) => Promise<unknown>;
let readerForTests: Reader | null = null;
export function _setWorkspaceDeliverablesReaderForTests(reader: Reader | null): void { readerForTests = reader; }

const CHECK_BUDGET_MS = 45_000;
const VIEW_TEXT_MAX = 4_000;

function viewText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' [script] ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, VIEW_TEXT_MAX);
}

export function workspaceDeliverablesUser(input: WorkspaceDeliverablesInput): string {
  const { record } = input;
  return JSON.stringify({
    request: input.request.slice(0, 4_000),
    workspace: {
      title: record.title,
      objective: record.contract?.objective ?? null,
      invariants: record.contract?.invariants ?? [],
      dataSources: record.dataSources.map((source) => ({
        id: source.id,
        reads: source.composioSlug ?? (source.cliArgv?.join(' ')) ?? (source.runner ? `script ${source.runner}` : 'nothing'),
        schedule: source.schedule ?? null,
      })),
      feedWorkflows: input.feeds.map((feed) => ({ workflow: feed.workflow, writes: [...feed.collections] })),
      buttons: record.actions.map((action) => ({
        id: action.id,
        label: action.label ?? action.id,
        runs: action.workflow ? `workflow ${action.workflow}` : action.composioSlug ?? (action.runner ? `script ${action.runner}` : 'nothing'),
      })),
      contentMode: record.contentMode ?? null,
      viewText: viewText(input.viewHtml),
    },
  });
}

export async function readWorkspaceDeliverables(input: WorkspaceDeliverablesInput): Promise<WorkspaceDeliverable[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Workspace deliverables check timed out.')), CHECK_BUDGET_MS);
  try {
    const user = workspaceDeliverablesUser(input);
    const raw = readerForTests
      ? await readerForTests(WORKSPACE_DELIVERABLES_SYSTEM, user, controller.signal)
      : (await (await import('../runtime/semantic-boundary/configured-brain-semantic-port.js')).completeViaConfiguredBrain({
        purpose: 'workspace_deliverables',
        system: WORKSPACE_DELIVERABLES_SYSTEM,
        user,
        schemaName: 'WorkspaceDeliverablesV1',
        signal: controller.signal,
        deadlineAt: Date.now() + CHECK_BUDGET_MS,
      })).raw;
    const list = (raw as { deliverables?: unknown } | null)?.deliverables;
    if (!Array.isArray(list)) return null;
    return list.flatMap((item): WorkspaceDeliverable[] => {
      if (!item || typeof item !== 'object') return [];
      const { deliverable, covered, gap } = item as Record<string, unknown>;
      if (typeof deliverable !== 'string' || !deliverable.trim() || typeof covered !== 'boolean') return [];
      return [{ deliverable: deliverable.trim(), covered, gap: typeof gap === 'string' ? gap.trim() : '' }];
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The note appended to the save result: empty when everything is covered or
 *  the check could not run, so a save never reports a check it did not make. */
export function renderWorkspaceDeliverables(items: readonly WorkspaceDeliverable[] | null): string {
  if (!items || items.length === 0) return '';
  const missing = items.filter((item) => !item.covered);
  if (missing.length === 0) return '';
  return [
    '',
    `Not built yet (${missing.length} of ${items.length} things the request asks this Workspace to do):`,
    ...missing.map((item) => `- ${item.deliverable}${item.gap ? ` — ${item.gap}` : ''}`),
    'Build these before you say the Workspace is done: a feed workflow for live data from any tool, a workflow button for any action, a review queue for anything the owner approves.',
  ].join('\n');
}
