import type { ProjectOverview, ProjectSummary } from '@clem/chat-engine';
import type { Session } from '../features/conversations/types';
import type { AgentRecord } from './agents';
import type { WorkflowRow } from './automate';
import type { SpaceRecord } from './spaces';

export type WorkKind = 'project' | 'space' | 'workflow' | 'agent' | 'chat';
export interface WorkItem {
  key: string;
  kind: WorkKind;
  title: string;
  path: string;
  detail?: string;
  updatedAt?: string | null;
  pinned?: boolean;
  running?: boolean;
}

export const WORK_KIND_LABEL: Record<WorkKind, string> = {
  project: 'Project', space: 'Space', workflow: 'Workflow', agent: 'Agent', chat: 'Chat',
};

export function workKindForPath(path: string): Exclude<WorkKind, 'chat'> | null {
  const collections: Record<string, Exclude<WorkKind, 'chat'>> = { '/projects': 'project', '/workspaces': 'space', '/automate': 'workflow', '/agents': 'agent' };
  return collections[path] ?? null;
}

/** Navigation only: these addresses never execute work or change a chat's context. */
export function workPath(kind: WorkKind, id: string): string {
  const roots: Record<WorkKind, string> = { project: '/projects', space: '/workspaces', workflow: '/automate', agent: '/agents', chat: '/chat' };
  const unified = kind === 'chat' && !id.startsWith('harness:') && !id.startsWith('desktop:') ? `harness:${id}` : id;
  return `${roots[kind]}/${encodeURIComponent(unified)}`;
}

export interface WorkCatalog {
  projects?: readonly ProjectSummary[];
  spaces?: readonly SpaceRecord[];
  workflows?: readonly WorkflowRow[];
  agents?: readonly AgentRecord[];
  chats?: readonly Session[];
}

export function workItems(catalog: WorkCatalog): WorkItem[] {
  return [
    ...(catalog.projects ?? []).filter(p => p.status !== 'archived').map(p => ({ key: `project:${p.id}`, kind: 'project' as const, title: p.name, path: workPath('project', p.id), detail: p.purpose, updatedAt: p.updatedAt })),
    ...(catalog.spaces ?? []).filter(s => s.status !== 'archived').map(s => ({ key: `space:${s.id}`, kind: 'space' as const, title: s.title, path: workPath('space', s.id), detail: s.contract?.objective, updatedAt: s.lastOpenedAt ?? s.updatedAt })),
    ...(catalog.workflows ?? []).map(w => ({ key: `workflow:${w.name}`, kind: 'workflow' as const, title: w.name, path: workPath('workflow', w.name), detail: w.description, updatedAt: w.lastRunAt })),
    ...(catalog.agents ?? []).map(a => ({ key: `agent:${a.id}`, kind: 'agent' as const, title: a.name, path: workPath('agent', a.id), detail: a.handles, updatedAt: a.updatedAt })),
    ...(catalog.chats ?? []).filter(s => !s.archived && !(s.store === 'desktop' && s.turnCount === 0)).map(s => ({ key: `chat:${s.id}`, kind: 'chat' as const, title: s.title || 'Untitled chat', path: workPath('chat', s.id), detail: [s.projectName, s.agentName].filter(Boolean).join(' · '), updatedAt: s.updatedAt, pinned: s.pinned, running: s.running })),
  ];
}

function timestamp(item: WorkItem): number {
  const value = Date.parse(item.updatedAt ?? '');
  return Number.isFinite(value) ? value : 0;
}

/** Match every word; an exact name beats a description or object-type match. */
export function searchWorkItems(items: readonly WorkItem[], query = '', limit = 50): WorkItem[] {
  const q = query.trim().toLocaleLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const score = (item: WorkItem) => {
    const title = item.title.toLocaleLowerCase();
    return !q ? 0 : title === q ? 3 : title.startsWith(q) ? 2 : title.includes(q) ? 1 : 0;
  };
  return items.filter(item => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    const text = `${item.title} ${item.detail ?? ''} ${WORK_KIND_LABEL[item.kind]}`.toLocaleLowerCase();
    return words.every(word => text.includes(word));
  }).sort((a, b) => score(b) - score(a) || Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || timestamp(b) - timestamp(a) || a.title.localeCompare(b.title)).slice(0, Math.max(0, limit));
}

/** Project relationships are pointers, not guessed from matching names. */
export function projectWorkItems(overview: ProjectOverview): WorkItem[] {
  const items: WorkItem[] = overview.conversations.filter(c => c.current).map(c => ({ key: `chat:${c.sessionId}`, kind: 'chat', title: c.title || 'Untitled chat', path: workPath('chat', c.sessionId), detail: c.agentName ?? undefined, updatedAt: c.updatedAt }));
  for (const resource of overview.resources) {
    if ((resource.kind !== 'space' && resource.kind !== 'workflow') || !resource.ref) continue;
    items.push({ key: `${resource.kind}:${resource.ref}`, kind: resource.kind, title: resource.label || resource.ref, path: workPath(resource.kind, resource.ref), updatedAt: resource.updatedAt });
  }
  for (const agent of overview.agents) {
    if (agent.available) items.push({ key: `agent:${agent.agentId}`, kind: 'agent', title: agent.agentName, path: workPath('agent', agent.agentId), detail: agent.responsibility });
  }
  return searchWorkItems(items, '', 12);
}
