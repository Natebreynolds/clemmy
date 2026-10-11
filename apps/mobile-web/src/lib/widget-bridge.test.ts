import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { saveWidgetSpace, widgetSpaceStored, widgetNavigationFromSearch, reportWidgetLanding, widgetText, openWidgetRoute, WIDGET_ROUTE_EVENT } from './widget-bridge.js';

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
