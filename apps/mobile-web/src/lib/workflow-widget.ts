export const WORKFLOW_WIDGET_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

export interface WorkflowWidgetTarget { slug: string | null; navigationId: string | null }

/** A shortcut opens one saved definition. Query text never grants execution. */
export function workflowWidgetTarget(search: string): WorkflowWidgetTarget | null {
  const params = new URLSearchParams(search);
  if ([...params.keys()].some(key => !['tab', 'workflow', 'widgetNavigation'].includes(key))
    || params.getAll('tab').length !== 1 || params.get('tab') !== 'workflows'
    || params.getAll('workflow').length > 1) return null;
  const slug = params.get('workflow');
  const ids = params.getAll('widgetNavigation');
  if ((slug !== null && !WORKFLOW_WIDGET_SLUG.test(slug)) || ids.length > 1 || (ids.length === 1 && !UUID.test(ids[0]))) return null;
  return { slug, navigationId: ids[0] ?? null };
}

export function workflowFromSearch(search: string): string | null { return workflowWidgetTarget(search)?.slug ?? null; }
export function mobileWorkflowPath(slug: string): string {
  if (!WORKFLOW_WIDGET_SLUG.test(slug)) throw new Error('Invalid saved workflow.');
  return `/m/?tab=workflows&workflow=${encodeURIComponent(slug)}`;
}

/** Only an exact HTTP 404 ends a parked link; offline and server errors retry. */
export async function readWidgetWorkflow<T extends { slug?: string }>(slug: string, load: (slug: string) => Promise<T>): Promise<
  { kind: 'ready'; info: T } | { kind: 'not_found' }
> {
  if (!WORKFLOW_WIDGET_SLUG.test(slug)) throw new Error('That workflow shortcut is invalid.');
  let info: T;
  try { info = await load(slug); }
  catch (error) {
    const failure = error as { status?: number; offline?: boolean } | null;
    if (failure?.status === 404 && failure.offline !== true) return { kind: 'not_found' };
    throw error;
  }
  if (!info || info.slug !== slug) throw new Error('This shortcut did not return its saved workflow. Open it from the list instead.');
  return { kind: 'ready', info };
}

/** Readiness only; the existing Run now route retains all execution checks. */
export function widgetWorkflowCanRun(info: { enabled: boolean; inputs: readonly unknown[] }, row: {
  enabled: boolean; requiresInput: boolean; resourceGaps?: readonly string[];
} | null): boolean {
  return info.enabled === true && Array.isArray(info.inputs) && info.inputs.length === 0
    && row?.enabled === true && row.requiresInput === false
    && Array.isArray(row.resourceGaps) && row.resourceGaps.length === 0;
}

/** Release the pending UI even if a refresh/navigation invalidated the claim. */
export async function settleWidgetWorkflowClaim(
  claim: () => Promise<boolean>, release: () => void, current: () => boolean, settled: (granted: boolean) => void,
): Promise<void> {
  let granted = false;
  try { granted = await claim(); } catch { /* A lost receipt grants nothing and is never retried. */ }
  finally { release(); }
  if (current()) settled(granted);
}
