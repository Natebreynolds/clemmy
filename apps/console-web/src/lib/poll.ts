/**
 * Thin polling hook over @tanstack/react-query so screens don't bind to
 * react-query directly (keeps it swappable). Pauses automatically when
 * the tab/window is hidden (react-query default) and de-dupes requests.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

export function usePoll<T>(
  key: readonly unknown[],
  fetcher: () => Promise<T>,
  intervalMs: number,
  opts?: { enabled?: boolean },
): UseQueryResult<T> {
  return useQuery({
    queryKey: key,
    queryFn: fetcher,
    refetchInterval: intervalMs > 0 ? intervalMs : false,
    refetchOnWindowFocus: true,
    staleTime: Math.max(0, intervalMs - 250),
    enabled: opts?.enabled ?? true,
    retry: 1,
  });
}
