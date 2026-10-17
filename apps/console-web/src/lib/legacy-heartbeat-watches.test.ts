import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getWatches, patchWatch, tickWatch } from './settings.js';
import { listWatches, setWatchNotify } from './watches.js';

test('legacy heartbeat clients use their own routes while workflow-watch clients remain canonical', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __CLEM_BOOTSTRAP__: { token: 'controlled-watch-client', version: '', flags: {} } },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    requests.push({ path: url.pathname, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ watches: [], watch: { id: 'calendar' }, tick: { summary: 'fixture' }, notify: 'quiet' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await getWatches();
    await patchWatch('calendar', { enabled: false, cadenceMinutes: 30 });
    await tickWatch('workflow-suggestions');
    await listWatches();
    await setWatchNotify('calendar', 'quiet');
    assert.deepEqual(requests, [
      { path: '/api/console/legacy-heartbeat-watches', method: 'GET', body: undefined },
      { path: '/api/console/legacy-heartbeat-watches/calendar', method: 'PATCH', body: { enabled: false, cadenceMinutes: 30 } },
      { path: '/api/console/legacy-heartbeat-watches/workflow-suggestions/tick', method: 'POST', body: {} },
      { path: '/api/console/watches', method: 'GET', body: undefined },
      { path: '/api/console/watches/calendar/notify', method: 'POST', body: { mode: 'quiet' } },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('Autonomy reads and invalidates only its heartbeat cache, independent of workflow watches', () => {
  const autonomy = readFileSync(new URL('../screens/advanced/AutonomyForm.tsx', import.meta.url), 'utf8');
  const watches = readFileSync(new URL('../screens/Watches.tsx', import.meta.url), 'utf8');
  assert.match(autonomy, /usePoll\(\['legacy-heartbeat-watches'\], getWatches,/);
  assert.match(autonomy, /invalidateQueries\(\{ queryKey: \['legacy-heartbeat-watches'\] \}\)/);
  assert.doesNotMatch(autonomy, /\['watches'\]/);
  assert.match(watches, /usePoll\(\['watches'\], listWatches,/);
  assert.match(watches, /invalidateQueries\(\{ queryKey: \['watches'\] \}\)/);
});
