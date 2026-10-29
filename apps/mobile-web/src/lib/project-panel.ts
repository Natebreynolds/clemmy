import { destinationSearch, projectFromSearch } from './deep-link';

export const PROJECT_PANELS = [
  { id: 'overview', label: 'Overview' },
  { id: 'agents', label: 'Agents' },
  { id: 'context', label: 'Context & apps' },
  { id: 'conversations', label: 'Conversations' },
] as const;
export type ProjectPanel = typeof PROJECT_PANELS[number]['id'];

/** A panel only applies to the exact project addressed by this URL. */
export function projectPanelFromSearch(search: string, projectId: string): ProjectPanel {
  if (projectFromSearch(search) !== projectId) return 'overview';
  const panel = new URLSearchParams(search).get('view');
  return PROJECT_PANELS.some(item => item.id === panel) ? panel as ProjectPanel : 'overview';
}
export function projectPanelSearch(projectId: string, panel: ProjectPanel): string {
  const params = new URLSearchParams(destinationSearch({ tab: 'projects', projectId }));
  if (panel !== 'overview') params.set('view', panel);
  return `?${params}`;
}
