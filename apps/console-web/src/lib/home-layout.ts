import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { HomeLayout, HomeLayoutChange } from '@clem/chat-engine';
import { apiGet, apiPatch } from './api';
import { usePoll } from './poll';
export type { HomeLayout, HomeTile, HomeLayoutChange } from '@clem/chat-engine';
export const HOME_LAYOUT_KEY = ['home-layout'] as const;
export function useHomeLayout() {
  return usePoll(HOME_LAYOUT_KEY, () => apiGet<{ layout: HomeLayout }>('/api/console/home/layout').then(body => body.layout), 6000);
}
export function useChangeHomeLayout() {
  const query = useQueryClient();
  return useMutation({
    mutationFn: (change: HomeLayoutChange) => apiPatch<{ layout: HomeLayout }>('/api/console/home/layout', change),
    onSuccess: body => { query.setQueryData(HOME_LAYOUT_KEY, body.layout); },
    onError: () => { void query.invalidateQueries({ queryKey: HOME_LAYOUT_KEY }); },
  });
}
