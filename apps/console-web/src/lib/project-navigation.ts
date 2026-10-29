export const PROJECT_VIEWS = [
  { id: 'overview', label: 'Overview' },
  { id: 'agents', label: 'Agents' },
  { id: 'context', label: 'Context & apps' },
  { id: 'conversations', label: 'Conversations' },
] as const;
export type ProjectView = typeof PROJECT_VIEWS[number]['id'];

export function projectView(value: string | null | undefined, hash = ''): ProjectView {
  const selected = PROJECT_VIEWS.find(view => view.id === value)?.id;
  if (selected) return selected;
  if (hash === '#project-agents') return 'agents';
  if (hash === '#project-context' || hash === '#project-details') return 'context';
  if (hash === '#project-conversations') return 'conversations';
  return 'overview';
}

/** Back, reload and copied links return to the same part of this project. */
export function projectViewSearch(search: URLSearchParams, view: ProjectView): URLSearchParams {
  const next = new URLSearchParams(search);
  if (view === 'overview') next.delete('view');
  else next.set('view', view);
  return next;
}
