import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { HomeLayout, HomeLayoutChange } from '@clem/chat-engine';
import { apiGet, apiPatch, type ApiError } from './api';
import { usePoll } from './poll';
export type { HomeLayout, HomeTile, HomeLayoutChange } from '@clem/chat-engine';
export const HOME_LAYOUT_KEY = ['home-layout'] as const;
export function useHomeLayout() {
  return usePoll(HOME_LAYOUT_KEY, () => apiGet<{ layout: HomeLayout }>('/api/console/home/layout').then(body => body.layout), 6000);
}

/**
 * One change to the Home layout. Every change names ONE Space (pin, move,
 * resize, remove), so when the layout moved on underneath it — the phone,
 * Clem, another window — re-applying that same change to the current
 * layout is exactly what was asked (the daemon's own conflict message says
 * so). It is retried once on the revision the conflict returned; a second
 * conflict is reported in words, never as the daemon's instruction text.
 */
export async function changeHomeLayout(change: HomeLayoutChange): Promise<HomeLayout> {
  const send = (expected: number) =>
    apiPatch<{ layout: HomeLayout }>('/api/console/home/layout', { ...change, expected_revision: expected }).then(body => body.layout);
  try {
    return await send(change.expected_revision);
  } catch (err) {
    const current = layoutConflictCurrent(err);
    if (!current || current.revision === change.expected_revision) throw personWorded(err);
    try {
      return await send(current.revision);
    } catch (retryErr) {
      throw personWorded(retryErr);
    }
  }
}

function layoutConflictCurrent(err: unknown): HomeLayout | null {
  const e = err as ApiError | undefined;
  const body = e?.body as { code?: string; current?: HomeLayout } | undefined;
  return e?.status === 409 && body?.code === 'layout_conflict' && body.current ? body.current : null;
}

function personWorded(err: unknown): Error {
  if (layoutConflictCurrent(err)) return new Error('Your Home changed while this was saving. Try again.');
  return err instanceof Error ? err : new Error(String(err));
}

export function useChangeHomeLayout() {
  const query = useQueryClient();
  return useMutation({
    mutationFn: (change: HomeLayoutChange) => changeHomeLayout(change),
    onSuccess: layout => { query.setQueryData(HOME_LAYOUT_KEY, layout); },
    onError: () => { void query.invalidateQueries({ queryKey: HOME_LAYOUT_KEY }); },
  });
}
