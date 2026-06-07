import type { SessionFilters } from '../types';

export const sessionKeys = {
  all: ['conversations'] as const,
  lists: () => [...sessionKeys.all, 'list'] as const,
  list: (f: SessionFilters) => [...sessionKeys.lists(), f] as const,
  detail: (id: string) => [...sessionKeys.all, 'detail', id] as const,
};

export function buildSessionsQuery(f: SessionFilters): string {
  const params = new URLSearchParams();
  if (f.q) params.set('q', f.q);
  if (f.tag) params.set('tag', f.tag);
  if (f.source) params.set('source', f.source);
  if (f.includeArchived) params.set('includeArchived', '1');
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
