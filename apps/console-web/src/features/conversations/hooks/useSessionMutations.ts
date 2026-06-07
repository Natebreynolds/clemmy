import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPatch, apiDelete } from '@/lib/api';
import type { Session, SessionListResponse } from '../types';
import { sessionKeys } from './keys';

interface PatchInput {
  id: string;
  title?: string;
  pinned?: boolean;
  tags?: string[];
  archived?: boolean;
}

/** Re-sort like the server: pinned first, then updatedAt desc. */
function reorder(list: Session[]): Session[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function useSessionMutations() {
  const qc = useQueryClient();

  const patchAllLists = (id: string, apply: (s: Session) => Session) => {
    qc.setQueriesData<SessionListResponse>({ queryKey: sessionKeys.lists() }, (prev) => {
      if (!prev) return prev;
      return { ...prev, sessions: reorder(prev.sessions.map((s) => (s.id === id ? apply(s) : s))) };
    });
  };

  const patch = useMutation({
    mutationFn: ({ id, ...body }: PatchInput) => apiPatch<{ session: Session }>(`/api/console/sessions/${encodeURIComponent(id)}`, body),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: sessionKeys.lists() });
      const snapshot = qc.getQueriesData<SessionListResponse>({ queryKey: sessionKeys.lists() });
      patchAllLists(vars.id, (s) => ({
        ...s,
        ...(vars.title !== undefined ? { title: vars.title } : {}),
        ...(vars.pinned !== undefined ? { pinned: vars.pinned } : {}),
        ...(vars.tags !== undefined ? { tags: vars.tags } : {}),
        ...(vars.archived !== undefined ? { archived: vars.archived } : {}),
      }));
      return { snapshot };
    },
    onError: (_e, _v, ctx) => {
      ctx?.snapshot.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: (_d, _e, vars) => {
      qc.invalidateQueries({ queryKey: sessionKeys.lists() });
      qc.invalidateQueries({ queryKey: sessionKeys.detail(vars.id) });
    },
  });

  const remove = useMutation({
    mutationFn: ({ id, hard }: { id: string; hard?: boolean }) =>
      apiDelete<{ ok: boolean; mode: string }>(`/api/console/sessions/${encodeURIComponent(id)}${hard ? '?hard=1' : ''}`),
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: sessionKeys.lists() });
      const snapshot = qc.getQueriesData<SessionListResponse>({ queryKey: sessionKeys.lists() });
      qc.setQueriesData<SessionListResponse>({ queryKey: sessionKeys.lists() }, (prev) =>
        prev ? { ...prev, sessions: prev.sessions.filter((s) => s.id !== id), total: prev.total - 1 } : prev,
      );
      return { snapshot };
    },
    onError: (_e, _v, ctx) => {
      ctx?.snapshot.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: sessionKeys.lists() }),
  });

  return {
    rename: (id: string, title: string) => patch.mutate({ id, title }),
    setPinned: (id: string, pinned: boolean) => patch.mutate({ id, pinned }),
    setTags: (id: string, tags: string[]) => patch.mutate({ id, tags }),
    setArchived: (id: string, archived: boolean) => patch.mutate({ id, archived }),
    remove: (id: string, hard?: boolean) => remove.mutate({ id, hard }),
  };
}
