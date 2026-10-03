import test from 'node:test';
import assert from 'node:assert/strict';
import { browserLiveUrl, isBrowserDisconnected, browserResourceKey, canApplyBrowserResponse, canApplyBrowserControlResponse, browserInputAllowed, browserBoundInputAllowed, browserStopMessage, createCloudBrowserClient, createBrowserViewerLeases, canStartBrowserInTask, readBrowserResource, type CloudBrowserResource, type CloudBrowserView } from './cloud-browser.js';
const resource: CloudBrowserResource = { id: 'r', conversationId: 'c', provider: 'browserbase', providerSessionId: 'ps', projectId: 'p', state: 'active', controller: 'agent', controlVersion: 2, createdAt: '', updatedAt: '', recording: false, elapsedSeconds: 10, pages: [{ targetId: 'page-a', title: 'Page', url: 'https://example.org' }] };
test('provider-returned live bearer URLs accept only approved HTTPS origins without inventing a path', () => {
  assert.ok(browserLiveUrl('https://www.browserbase.com/live?session=secret'));
  assert.ok(browserLiveUrl('https://browserbase.com/devtools-fullscreen/?token=synthetic-secret'));
  for (const url of ['http://www.browserbase.com/live', 'https://www.browserbase.com.evil.test/live', 'https://www.browserbase.com:444/live', 'https://user@www.browserbase.com/live', 'https://www.browserbase.com/live#secret', 'javascript:alert(1)']) assert.equal(browserLiveUrl(url), null);
});
test('release requested is not provider-confirmed stopped', () => {
  assert.equal(browserStopMessage({ ...resource, state: 'stopped' }), 'Browser stopped.');
  assert.match(browserStopMessage({ ...resource, state: 'stopping' }), /Waiting for the provider/);
  assert.match(browserStopMessage({ ...resource, state: 'uncertain' }), /not confirmed/);
  assert.notEqual(browserStopMessage(resource), 'Browser stopped.');
});
test('disconnect messages must belong to the exact mounted iframe and live origin', () => {
  const frame = {} as Window;
  const event = { source: frame, origin: 'https://www.browserbase.com', data: { type: 'browserbase-disconnected' } };
  assert.equal(isBrowserDisconnected(event, frame, 'https://www.browserbase.com/live'), true);
  assert.equal(isBrowserDisconnected({ ...event, source: {} as Window }, frame, 'https://www.browserbase.com/live'), false);
  assert.equal(isBrowserDisconnected({ ...event, origin: 'https://evil.test' }, frame, 'https://www.browserbase.com/live'), false);
  assert.equal(isBrowserDisconnected({ ...event, data: { type: 'anything' } }, frame, 'https://www.browserbase.com/live'), false);
});
test('late control/read responses cannot overwrite a newer controller or another task', () => {
  const next = { ...resource, controller: 'human' as const, controlVersion: 3 };
  assert.equal(canApplyBrowserResponse(resource, resource, next), true);
  assert.equal(canApplyBrowserResponse(next, resource, next), false);
  assert.equal(canApplyBrowserResponse(resource, resource, { ...next, conversationId: 'other' }), false);
  assert.equal(canApplyBrowserResponse(resource, resource, { ...next, controlVersion: 1 }), false);
  assert.notEqual(browserResourceKey(resource), browserResourceKey(next));
  assert.equal(canApplyBrowserControlResponse(resource, resource, next, 'human'), true);
  assert.equal(canApplyBrowserControlResponse(resource, resource, next, 'agent'), false);
  assert.equal(canApplyBrowserControlResponse(resource, resource, { ...next, controlVersion: 2 }, 'human'), false);
});
test('mobile input requires current human ownership and an exact observed page', () => {
  assert.equal(browserInputAllowed(resource, 'page-a'), false);
  assert.equal(browserInputAllowed({ ...resource, controller: 'human' }, 'page-a'), true);
  assert.equal(browserInputAllowed({ ...resource, controller: 'human' }, 'other'), false);
  assert.equal(browserInputAllowed({ ...resource, controller: 'human', state: 'uncertain' }, 'page-a'), false);
});
test('controls carry task, CAS version and page without mutation retry', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = createCloudBrowserClient(async <T>(path: string, init?: RequestInit): Promise<T> => { calls.push({ path, init }); throw Object.assign(new Error('changed'), { status: 409 }); }, '/api/cloud-browser');
  await assert.rejects(client.input(resource, 'page-a', 'lease-a', { text: 'hello' }));
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { conversationId: 'c', expectedVersion: 2, targetId: 'page-a', viewerLeaseId: 'lease-a', text: 'hello' });
});

test('old start responses normalize absent pages and reject a different task or resource', () => {
  const { pages: _pages, ...starting } = { ...resource, state: 'starting' as const };
  assert.deepEqual(readBrowserResource(starting, 'c').pages, []);
  assert.throws(() => readBrowserResource(resource, 'other'));
  assert.throws(() => readBrowserResource(resource, 'c', 'other'));
});
const view: CloudBrowserView = { url: 'https://www.browserbase.com/live?token=synthetic-test', expiresAt: '2999-01-01T00:00:00Z', viewerLeaseId: 'lease-a', controlVersion: 2, targetId: 'page-a' };
test('mobile bridge requires the exact minted page and epoch and blocks a pending return', () => {
  const human = { ...resource, controller: 'human' as const };
  assert.equal(browserBoundInputAllowed(human, 'page-a', view), true);
  assert.equal(browserBoundInputAllowed(human, 'page-a', { ...view, targetId: undefined }), false);
  assert.equal(browserBoundInputAllowed(human, 'page-a', { ...view, targetId: 'other' }), false);
  assert.equal(browserBoundInputAllowed(human, 'page-a', { ...view, controlVersion: 1 }), false);
  assert.equal(browserBoundInputAllowed(human, 'page-a', { ...view, expiresAt: '2000-01-01' }), false);
  assert.equal(browserBoundInputAllowed({ ...human, returnPending: true }, 'page-a', view), false);
  assert.equal(browserBoundInputAllowed(resource, 'page-a', view), false);
});
test('a cross-device return receipt can be pending without granting agent ownership', () => {
  const human = { ...resource, controller: 'human' as const };
  const pending = { ...human, controlVersion: 3, returnPending: true };
  assert.equal(canApplyBrowserControlResponse(human, human, pending, 'agent'), true);
  assert.equal(pending.controller, 'human');
  assert.equal(browserInputAllowed(pending, 'page-a'), false);
  assert.equal(canApplyBrowserControlResponse(human, human, { ...pending, returnPending: false }, 'agent'), false);
});
test('view minting and lease detachment preserve exact task, epoch and page and use authenticated request transport', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = createCloudBrowserClient(async <T>(path: string, init?: RequestInit): Promise<T> => { calls.push({ path, init }); return (path.endsWith('/view') ? view : { resource }) as T; }, '/api/cloud-browser');
  await client.view(resource, 'page-a', 'lease-a'); await client.detach(resource, view.viewerLeaseId);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { conversationId: 'c', expectedVersion: 2, viewerLeaseId: 'lease-a', targetId: 'page-a' });
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { conversationId: 'c', viewerLeaseId: 'lease-a' });
  assert.equal(calls[1]?.init?.keepalive, true);
});
test('close acknowledgments de-duplicate in flight, keep failed leases owed, and accept a fresh epoch', async () => {
  let release!: (value: { resource: CloudBrowserResource }) => void;
  const calls: string[] = [];
  let fail = true;
  const leases = createBrowserViewerLeases({ detach: async (_resource, id) => {
    calls.push(id); if (fail) throw new Error('offline');
    return new Promise((resolve) => { release = resolve; });
  } });
  leases.remember(resource, view);
  await assert.rejects(leases.detachAll(resource), /offline/);
  fail = false;
  const first = leases.detach(view.viewerLeaseId); const second = leases.detach(view.viewerLeaseId);
  assert.equal(first, second); assert.deepEqual(calls, ['lease-a', 'lease-a']);
  release({ resource: { ...resource, controlVersion: 4 } });
  assert.equal((await first)?.controlVersion, 4); await second;
  assert.equal(await leases.detach(view.viewerLeaseId), null);
});
test('closing a task does not detach another task and returns the freshest confirmed state', async () => {
  const calls: string[] = [];
  const leases = createBrowserViewerLeases({ detach: async (_resource, id) => { calls.push(id); return { resource: { ...resource, controlVersion: id === 'lease-b' ? 5 : 3 } }; } });
  leases.remember(resource, view); leases.remember(resource, { ...view, viewerLeaseId: 'lease-b' });
  leases.remember({ ...resource, conversationId: 'bystander' }, { ...view, viewerLeaseId: 'other-task' });
  assert.equal((await leases.detachAll(resource)).controlVersion, 5);
  assert.deepEqual(calls, ['lease-a', 'lease-b']);
});
test('a failed mint remains closable by the UUID reserved before the request', async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const client = createCloudBrowserClient(async <T>(path: string, init?: RequestInit): Promise<T> => {
    calls.push({ path, body: JSON.parse(String(init?.body)) });
    if (path.endsWith('/view')) throw new Error('response lost');
    return { resource } as T;
  }, '/api/cloud-browser');
  const leases = createBrowserViewerLeases(client);
  const viewerLeaseId = '00000000-0000-4000-8000-000000000001';
  leases.remember(resource, { viewerLeaseId });
  await assert.rejects(client.view(resource, 'page-a', viewerLeaseId), /response lost/);
  await leases.detachAll(resource);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]?.body, { conversationId: 'c', viewerLeaseId });
});

test('a new browser is available after confirmed terminal sessions, never while a task session may be live', () => {
  assert.equal(canStartBrowserInTask([]), true);
  assert.equal(canStartBrowserInTask([{ ...resource, state: 'stopped' }, { ...resource, state: 'expired' }]), true);
  for (const state of ['starting', 'active', 'uncertain', 'stopping'] as const) assert.equal(canStartBrowserInTask([{ ...resource, state }]), false);
});

test('the browser chip counts every open browser, and each says when it closes in plain words', async () => {
  const { browsersChipLabel, browserClosesText } = await import('./cloud-browser.js');
  assert.equal(browsersChipLabel(0), 'Browser');
  assert.equal(browsersChipLabel(2), 'Browsers · 2 open');
  const now = Date.parse('2026-10-03T16:00:00Z');
  assert.equal(browserClosesText({ idleClosesAt: '2026-10-03T16:12:00Z', endsAt: '2026-10-03T18:00:00Z' }, now), 'Closes in 12 min if left idle');
  assert.equal(browserClosesText({ idleClosesAt: '2026-10-03T16:00:20Z', endsAt: '2026-10-03T18:00:00Z' }, now), 'Closes in about a minute if left idle');
  assert.equal(browserClosesText({ idleClosesAt: '2026-10-03T17:59:00Z', endsAt: '2026-10-03T16:40:00Z' }, now), 'Ends in 40 min', 'the sooner of the two');
  assert.equal(browserClosesText({ idleClosesAt: null, endsAt: '2026-10-03T18:00:00Z' }, now), 'Ends in 2 h');
});

test('the overview keeps each browser bound to its own conversation and refuses a malformed list', async () => {
  const { createCloudBrowserClient } = await import('./cloud-browser.js');
  const browser = { id: 'b1', conversationId: 'sess-a', provider: 'browserbase', providerSessionId: 's1', projectId: 'p', state: 'active', controller: 'agent', controlVersion: 2,
    createdAt: '2026-10-03T16:00:00Z', updatedAt: '2026-10-03T16:00:00Z', recording: false, elapsedSeconds: 60, pages: [], conversationTitle: 'Pricing research',
    idleClosesAt: '2026-10-03T16:15:00Z', endsAt: '2026-10-03T18:00:00Z', usesProfile: true };
  const client = createCloudBrowserClient(async <T>(): Promise<T> => ({ browsers: [browser], unlinked: [{ providerSessionId: 's9' }], unlinkedChecked: true }) as T, '/api/cloud-browser');
  const overview = await client.overview();
  assert.equal(overview.browsers[0]!.conversationId, 'sess-a');
  assert.equal(overview.browsers[0]!.conversationTitle, 'Pricing research');
  assert.equal(overview.browsers[0]!.usesProfile, true);
  assert.deepEqual(overview.unlinked.map((row) => row.providerSessionId), ['s9']);
  const broken = createCloudBrowserClient(async <T>(): Promise<T> => ({ browsers: [{ ...browser, endsAt: 5 }], unlinked: [] }) as T, '/api/cloud-browser');
  await assert.rejects(broken.overview(), /not confirmed/);
});

test('the panel names the page Clem is on, else the first page', async () => {
  const { browserFocusPage } = await import('./cloud-browser.js');
  const pages = [{ targetId: 'a', title: 'Blank', url: 'about:blank' }, { targetId: 'b', title: 'Facebook', url: 'https://www.facebook.com/' }];
  assert.equal(browserFocusPage({ pages, focusTargetId: 'b' })?.title, 'Facebook');
  assert.equal(browserFocusPage({ pages, focusTargetId: 'closed' })?.title, 'Blank');
  assert.equal(browserFocusPage({ pages: [] }), undefined);
});
