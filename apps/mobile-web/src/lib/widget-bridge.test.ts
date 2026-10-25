import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { saveWidgetSpace, widgetSpaceStored, widgetNavigationFromSearch, reportWidgetLanding, widgetText, openWidgetRoute, WIDGET_ROUTE_EVENT } from './widget-bridge.js';
import { consumeWidgetWorkflowLaunch, removeWidgetWorkflow, saveWidgetWorkflow, widgetWorkflowLaunchConsumed, widgetWorkflowStored } from './widget-bridge.js';

function mockWindow(t: TestContext, value: Window & typeof globalThis) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
}

test('widget snapshot confirms only the exact native receipt and rejects failed storage', async t => {
  const sent: Array<{ requestId: string; clear?: boolean }> = [];
  mockWindow(t, { webkit: { messageHandlers: { clemWidgetSpace: {
    postMessage: (value: { requestId: string }) => { sent.push(value); },
  } } } } as unknown as Window & typeof globalThis);
  const first = saveWidgetSpace({ slug: 'synthetic-space', name: 'Synthetic Space', summary: 'Ready for review', updatedAt: '2026-10-11T12:00:00Z' });
  let resolved = false; void first.then(() => { resolved = true; });
  widgetSpaceStored({ requestId: 'unrelated', ok: true });
  await Promise.resolve(); assert.equal(resolved, false);
  widgetSpaceStored({ requestId: sent[0].requestId, ok: true });
  await first; assert.equal(resolved, true);
  const second = saveWidgetSpace(null);
  assert.equal(sent[1].clear, true);
  widgetSpaceStored({ requestId: sent[1].requestId, ok: false });
  await assert.rejects(second, /could not save/);
});

test('widget landing acknowledges a bounded exact id and removes only its route receipt', t => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  assert.equal(widgetNavigationFromSearch(`?tab=chats&widgetNavigation=${id}`), id);
  assert.equal(widgetNavigationFromSearch(`?widgetNavigation=${id}&widgetNavigation=${id}`), null);
  assert.equal(widgetNavigationFromSearch('?widgetNavigation=arbitrary-script'), null);
  const sent: unknown[] = []; let changed = '';
  mockWindow(t, {
    location: { pathname: '/m/', search: `?tab=chats&compose=voice&widgetNavigation=${id}` },
    history: { state: null, replaceState: (_state: unknown, _unused: string, url: string) => { changed = url; } },
    webkit: { messageHandlers: { clemWidgetNavigationHandled: { postMessage: (value: unknown) => { sent.push(value); } } } },
  } as unknown as Window & typeof globalThis);
  reportWidgetLanding('11111111-bbbb-cccc-dddd-eeeeeeeeeeee', { tab: 'chats', compose: 'voice' });
  reportWidgetLanding(id, { tab: 'spaces' });
  assert.equal(sent.length, 0, 'old effects and wrong destinations cannot acknowledge the new tap');
  reportWidgetLanding(id, { tab: 'chats', compose: 'voice' });
  assert.deepEqual(sent, [{ navigationId: id, outcome: 'presented' }]);
  assert.equal(changed, '/m/?tab=chats&compose=voice');
});

test('widget summaries accept normal multiline and multibyte Space text within native byte bounds', () => {
  assert.equal(widgetText('  One\n\tTwo\u0000Three  ', 600), 'One Two Three');
  const label = widgetText('研究🙂'.repeat(100), 160);
  assert.ok(new TextEncoder().encode(label).length <= 160);
  assert.ok(label.length > 0);
  assert.equal(label.includes('\ufffd'), false);
});

test('warm widget delivery is synchronous, bounded, and handled only by the authenticated app listener', t => {
  const target = new EventTarget();
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  mockWindow(t, { location: { origin: 'https://paired.example' }, dispatchEvent: (event: Event) => target.dispatchEvent(event) } as unknown as Window & typeof globalThis);
  const request = { path: `/m/?tab=chats&compose=voice&widgetNavigation=${id}`, navigationId: id };
  assert.equal(openWidgetRoute(request), false);
  target.addEventListener(WIDGET_ROUTE_EVENT, event => event.preventDefault());
  assert.equal(openWidgetRoute(request), true);
  for (const path of ['https://elsewhere.example/m/', `/m/?tab=chats&compose=send&widgetNavigation=${id}`, `/m/?tab=chats&compose=voice&pair=secret&widgetNavigation=${id}`, `/m/?tab=spaces&workspace=../private&widgetNavigation=${id}`]) {
    assert.equal(openWidgetRoute({ path, navigationId: id }), false);
  }
});

test('workflow pin, removal and clear are acknowledged by their exact workflow receipt only', async t => {
  const sent: Array<{ requestId: string; slug?: string; clear?: boolean; remove?: string }> = [];
  mockWindow(t, { webkit: { messageHandlers: { clemWidgetWorkflow: { postMessage: (value: typeof sent[number]) => sent.push(value) } } } } as unknown as Window & typeof globalThis);
  const pin = saveWidgetWorkflow({ slug: 'Saved.Flow_2', name: 'Saved flow', summary: 'Open it', updatedAt: '2026-10-25T12:00:00Z' });
  let resolved = false; void pin.then(() => { resolved = true; });
  widgetSpaceStored({ requestId: sent[0].requestId, ok: true, slug: 'Saved.Flow_2' });
  widgetWorkflowStored({ requestId: sent[0].requestId, ok: true, slug: 'foreign' });
  await Promise.resolve(); assert.equal(resolved, false);
  widgetWorkflowStored({ requestId: sent[0].requestId, ok: true, slug: 'Saved.Flow_2' });
  await pin;
  const remove = removeWidgetWorkflow('Saved.Flow_2');
  assert.equal(sent[1].remove, 'Saved.Flow_2');
  widgetWorkflowStored({ requestId: sent[1].requestId, ok: true, slug: 'Saved.Flow_2' }); await remove;
  const clear = saveWidgetWorkflow(null); assert.equal(sent[2].clear, true);
  widgetWorkflowStored({ requestId: sent[2].requestId, ok: true }); await clear;
  const refused = saveWidgetWorkflow({ slug: 'fourth', name: 'Fourth', summary: '', updatedAt: '2026-10-25T12:00:00Z' });
  widgetWorkflowStored({ requestId: sent[3].requestId, ok: false });
  await assert.rejects(refused, /up to three/);
  await assert.rejects(removeWidgetWorkflow('../private'), /valid saved shortcut/);
  assert.equal(sent.length, 4);
});

test('workflow launch consumption requires exact native identity and never retries a navigation', async t => {
  const sent: Array<{ requestId: string; navigationId: string; slug: string }> = [];
  mockWindow(t, { webkit: { messageHandlers: { clemWidgetWorkflowLaunch: { postMessage: (value: typeof sent[number]) => sent.push(value) } } } } as unknown as Window & typeof globalThis);
  const navigationId = crypto.randomUUID();
  const first = consumeWidgetWorkflowLaunch(navigationId, 'saved');
  let settled = false; void first.then(() => { settled = true; });
  widgetWorkflowLaunchConsumed({ ...sent[0], navigationId: crypto.randomUUID(), ok: true });
  widgetWorkflowLaunchConsumed({ ...sent[0], slug: 'foreign', ok: true });
  await Promise.resolve(); assert.equal(settled, false);
  assert.equal(await consumeWidgetWorkflowLaunch(navigationId, 'saved'), false);
  widgetWorkflowLaunchConsumed({ ...sent[0], ok: true }); assert.equal(await first, true);
  assert.equal(await consumeWidgetWorkflowLaunch(navigationId, 'saved'), false);
  const refused = consumeWidgetWorkflowLaunch(crypto.randomUUID(), 'saved');
  widgetWorkflowLaunchConsumed({ ...sent[1], ok: false }); assert.equal(await refused, false);
  assert.equal(await consumeWidgetWorkflowLaunch('not-a-uuid', 'saved'), false);
  assert.equal(await consumeWidgetWorkflowLaunch(crypto.randomUUID(), '../private'), false);
  assert.equal(sent.length, 2);
});

test('workflow native timeout is consumed locally and cannot silently retry', async t => {
  const priorTimer = globalThis.setTimeout;
  const callbacks: Array<() => void> = []; const messages: unknown[] = [];
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (callback: () => void) => { callbacks.push(callback); return 1; } });
  t.after(() => Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: priorTimer }));
  mockWindow(t, { webkit: { messageHandlers: { clemWidgetWorkflowLaunch: { postMessage: (value: unknown) => messages.push(value) } } } } as unknown as Window & typeof globalThis);
  const navigationId = crypto.randomUUID(); const pending = consumeWidgetWorkflowLaunch(navigationId, 'saved');
  callbacks[0](); assert.equal(await pending, false);
  assert.equal(await consumeWidgetWorkflowLaunch(navigationId, 'saved'), false);
  assert.equal(messages.length, 1);
});

test('warm workflow and setup links cannot sneak in execution or duplicate parameters', t => {
  const target = new EventTarget(); const id = crypto.randomUUID();
  mockWindow(t, { location: { origin: 'https://paired.example' }, dispatchEvent: (event: Event) => target.dispatchEvent(event) } as unknown as Window & typeof globalThis);
  target.addEventListener(WIDGET_ROUTE_EVENT, event => event.preventDefault());
  assert.equal(openWidgetRoute({ path: `/m/?tab=workflows&workflow=Saved.Flow_2&widgetNavigation=${id}`, navigationId: id }), true);
  assert.equal(openWidgetRoute({ path: `/m/?tab=workflows&widgetNavigation=${id}`, navigationId: id }), true);
  for (const extra of ['&workflow=foreign', '&run=true', '&tab=workflows', `&widgetNavigation=${id}`]) {
    assert.equal(openWidgetRoute({ path: `/m/?tab=workflows&workflow=saved&widgetNavigation=${id}${extra}`, navigationId: id }), false);
  }
});

test('workflow landing cannot acknowledge a foreign target, transient read or duplicate selector', t => {
  const id = crypto.randomUUID(); const sent: unknown[] = []; let changed = '';
  const location = { pathname: '/m/', search: `?tab=workflows&workflow=saved&widgetNavigation=${id}` };
  mockWindow(t, { location, history: { state: null, replaceState: (_state: unknown, _unused: string, url: string) => { changed = url; } },
    webkit: { messageHandlers: { clemWidgetNavigationHandled: { postMessage: (value: unknown) => sent.push(value) } } } } as unknown as Window & typeof globalThis);
  reportWidgetLanding(id, { tab: 'workflows', workflow: 'foreign' }); assert.equal(sent.length, 0);
  location.search += '&workflow=saved'; reportWidgetLanding(id, { tab: 'workflows', workflow: 'saved' }); assert.equal(sent.length, 0);
  location.search = `?tab=workflows&workflow=saved&widgetNavigation=${id}`;
  reportWidgetLanding(id, { tab: 'workflows', workflow: 'saved' }, 'unavailable');
  assert.deepEqual(sent, [{ navigationId: id, outcome: 'unavailable' }]); assert.equal(changed, '/m/?tab=workflows&workflow=saved');
  sent.length = 0; location.search = `?tab=workflows&widgetNavigation=${id}`;
  reportWidgetLanding(id, { tab: 'workflows' }); assert.deepEqual(sent, [{ navigationId: id, outcome: 'presented' }]);
});
