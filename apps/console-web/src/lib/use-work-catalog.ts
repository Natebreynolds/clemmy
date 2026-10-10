import { useQuery } from '@tanstack/react-query';
import { apiGet } from './api';
import { listAgents } from './agents';
import { listWorkflows } from './automate';
import { listProjects, projectKeys } from './projects';
import { listSpaces } from './spaces';
import { filterSessionsByKind } from './run-presentation';
import { buildSessionsQuery, sessionKeys } from '../features/conversations/hooks/keys';
import type { SessionListResponse } from '../features/conversations/types';
import { workItems, type WorkKind } from './work-navigation';

/** The same cache keys as the full screens; collapsed collections fetch nothing. */
export function useWorkCatalog(enabled: boolean, kind?: WorkKind, chatQuery = '') {
  const wants = (value: WorkKind) => enabled && (!kind || value === kind);
  const common = { staleTime: 30_000, refetchOnWindowFocus: true };
  const projects = useQuery({ ...common, queryKey: projectKeys.list(false), queryFn: () => listProjects(false), enabled: wants('project') });
  const spaces = useQuery({ ...common, queryKey: ['spaces'], queryFn: listSpaces, enabled: wants('space') });
  const workflows = useQuery({ ...common, queryKey: ['workflows'], queryFn: listWorkflows, enabled: wants('workflow') });
  const agents = useQuery({ ...common, queryKey: ['agents'], queryFn: listAgents, enabled: wants('agent') });
  const filters = { limit: 200 };
  const chats = useQuery({ ...common, staleTime: 5_000, queryKey: sessionKeys.list(filters), queryFn: () => apiGet<SessionListResponse>(`/api/console/sessions${buildSessionsQuery(filters)}`), enabled: wants('chat'), refetchInterval: wants('chat') ? 10_000 : false });
  // Retain recent chats while the server searches older history. The local
  // matcher also understands words like "chat" and project/agent names, which
  // are not necessarily present in the server's title/text search.
  const searchFilters = { limit: 200, q: chatQuery };
  const matchingChats = useQuery({ ...common, queryKey: sessionKeys.list(searchFilters), queryFn: () => apiGet<SessionListResponse>(`/api/console/sessions${buildSessionsQuery(searchFilters)}`), enabled: wants('chat') && Boolean(chatQuery) });
  const selected = [wants('project') && projects, wants('space') && spaces, wants('workflow') && workflows, wants('agent') && agents, wants('chat') && chats, wants('chat') && Boolean(chatQuery) && matchingChats].filter(Boolean) as Array<{ isLoading: boolean; isError: boolean; refetch: () => Promise<unknown> }>;
  return {
    items: workItems({
      projects: wants('project') ? projects.data : undefined,
      spaces: wants('space') ? spaces.data : undefined,
      workflows: wants('workflow') ? workflows.data?.workflows : undefined,
      agents: wants('agent') ? agents.data : undefined,
      chats: wants('chat') ? filterSessionsByKind([...(chats.data?.sessions ?? []), ...(chatQuery ? matchingChats.data?.sessions ?? [] : [])], 'chats') : undefined,
    }),
    loading: selected.some(q => q.isLoading),
    unavailable: selected.some(q => q.isError),
    retry: () => { for (const query of selected) void query.refetch(); },
  };
}
