import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { sessionHistoryReady } from './session-history-readiness';

test('reopening cannot seed the stateful chat from a partial cached transcript', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const queryKey = ['saved-chat'];
  client.setQueryData(queryKey, ['first question']);
  let complete!: (turns: string[]) => void;
  const response = new Promise<string[]>(resolve => { complete = resolve; });
  const observer = new QueryObserver(client, { queryKey, queryFn: () => response, staleTime: 0 });
  const stop = observer.subscribe(() => {});
  try {
    const cached = observer.getCurrentResult();
    assert.equal(cached.isLoading, false, 'cached data bypasses the old loading guard');
    assert.equal(cached.isFetching, true);
    assert.equal(sessionHistoryReady(cached), false, 'do not freeze the partial cache into useChat state');
    complete(['first question', 'first answer', 'second question', 'second answer']);
    await observer.refetch();
    const fresh = observer.getCurrentResult();
    assert.equal(sessionHistoryReady(fresh), true);
    assert.deepEqual(fresh.data, ['first question', 'first answer', 'second question', 'second answer']);
    const backgroundRefresh = observer.refetch();
    assert.equal(sessionHistoryReady(observer.getCurrentResult()), true,
      'later refreshes must not unmount a live chat or clear its draft');
    await backgroundRefresh;
  } finally { stop(); client.clear(); }
});
