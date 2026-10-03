import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserCloseResultMessage, createBrowserViewerLeases, type CloudBrowserResource, type CloudBrowserView } from './cloud-browser.js';
import { browserViewTarget, startBrowserViewLifecycle, type BrowserBoundView, type BrowserViewClock, type BrowserViewIssue } from './browser-view-lifecycle.js';

const resource: CloudBrowserResource = {
  id: 'browser-a', conversationId: 'task-a', provider: 'browserbase', providerSessionId: 'provider-a', projectId: 'project-a',
  state: 'active', controller: 'agent', controlVersion: 1, createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z',
  recording: false, elapsedSeconds: 0, pages: [{ targetId: 'page-a', title: 'Example', url: 'https://example.com/' }], focusTargetId: 'page-a',
};
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
class Clock implements BrowserViewClock {
  time = Date.parse('2026-10-03T00:00:00Z');
  nextId = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout = (callback: () => void, delay: number) => { const id = ++this.nextId; this.timers.set(id, { at: this.time + delay, callback }); return id; };
  clearTimeout = (id: unknown) => { this.timers.delete(id as number); };
  async advance(delay: number) {
    await settle(); const end = this.time + delay;
    for (;;) {
      const first = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      this.time = first[1].at; this.timers.delete(first[0]); first[1].callback(); await settle();
    }
    this.time = end; await settle();
  }
}
function fixture(overrides: Partial<CloudBrowserResource> = {}) {
  const clock = new Clock(); const requested = { ...resource, ...overrides };
  let active = true, busy = false, counter = 0;
  let frame: BrowserBoundView | null = null;
  const issues: BrowserViewIssue[] = [], shown: BrowserBoundView[] = [], calls: Array<{ resource: CloudBrowserResource; target?: string; id: string }> = [], detached: string[] = [];
  const events: string[] = [];
  const response = (id: string, targetId = 'page-a'): CloudBrowserView => ({ url: 'https://www.browserbase.com/live?token=synthetic', viewerLeaseId: id, targetId,
    controlVersion: requested.controlVersion, expiresAt: new Date(clock.now() + 60_000).toISOString() });
  const behavior = {
    view: async (_resource: CloudBrowserResource, targetId: string | undefined, id: string): Promise<CloudBrowserView> => response(id, targetId),
    remove: async (_id: string): Promise<void> => undefined,
    detach: async (): Promise<CloudBrowserResource> => requested,
  };
  const leases = createBrowserViewerLeases({ detach: async (_resource, id) => {
    assert.notEqual(frame?.viewerLeaseId, id, 'iframe must be removed before acknowledgment');
    detached.push(id); events.push(`detach:${id}`); return { resource: await behavior.detach() };
  } });
  const start = (next = requested, key = 'binding-a') => startBrowserViewLifecycle({
    resource: next, key, client: { view: async (res, target, id) => { calls.push({ resource: res, target, id }); events.push(`mint:${id}`); return behavior.view(res, target, id); } }, leases,
    uuid: () => `lease-${++counter}`, isCurrent: () => active, isBusy: () => busy, clock,
    show: (value) => { frame = value; shown.push(value); events.push(`show:${value.viewerLeaseId}`); },
    remove: async (id) => { await behavior.remove(id); if (frame?.viewerLeaseId === id) frame = null; events.push(`remove:${id}`); },
    issue: (issue) => issues.push(issue),
  });
  return { clock, requested, behavior, response, leases, start, calls, detached, shown, issues, events,
    frame: () => frame, active: (value: boolean) => { active = value; }, busy: (value: boolean) => { busy = value; } };
}

test('visible same-page viewer renews across multiple expiries without polling creating requests', async () => {
  const t = fixture(); const life = t.start(); await settle();
  for (let i = 0; i < 20; i++) life.resume();
  await t.clock.advance(59_999); assert.equal(t.calls.length, 1);
  await t.clock.advance(1); assert.equal(t.calls.length, 2);
  await t.clock.advance(60_000); assert.equal(t.calls.length, 3);
  assert.deepEqual(t.calls.map(call => [call.resource.conversationId, call.resource.id, call.resource.controlVersion, call.target]),
    Array.from({ length: 3 }, () => ['task-a', 'browser-a', 1, 'page-a']));
  assert.equal(new Set(t.calls.map(call => call.id)).size, 3);
  assert.deepEqual(t.events.slice(2, 6), ['remove:lease-1', 'detach:lease-1', 'mint:lease-2', 'show:lease-2']);
  await life.stop(); await t.clock.advance(180_000); assert.equal(t.calls.length, 3); assert.equal(t.clock.timers.size, 0);
});

test('renewal waits for actual iframe removal and confirmed detach before minting another lease', async () => {
  const t = fixture(); const life = t.start(); await settle();
  const dom = deferred<void>(), ack = deferred<CloudBrowserResource>();
  t.behavior.remove = () => dom.promise; t.behavior.detach = () => ack.promise;
  await t.clock.advance(60_000);
  assert.equal(t.frame()?.viewerLeaseId, 'lease-1'); assert.equal(t.detached.length, 0); assert.equal(t.calls.length, 1);
  dom.resolve(); await settle(); assert.equal(t.frame(), null); assert.equal(t.detached.length, 1); assert.equal(t.calls.length, 1);
  ack.resolve(t.requested); await settle(); assert.equal(t.calls.length, 2);
  await life.stop();
});

test('busy human input retains its live lease and pauses renewal until the input finishes', async () => {
  const t = fixture({ controller: 'human' }); const life = t.start(); await settle(); t.busy(true);
  await t.clock.advance(59_999); assert.equal(t.frame()?.viewerLeaseId, 'lease-1'); assert.equal(t.detached.length, 0);
  await t.clock.advance(1); assert.equal(t.frame(), null); assert.equal(t.calls.length, 1);
  assert.equal(t.detached.length, 0, 'expired input lease remains attached until the in-flight input settles');
  await t.clock.advance(20_000); assert.equal(t.calls.length, 1);
  t.busy(false); life.resume(); await settle(); assert.equal(t.calls.length, 2); await life.stop();
});

test('disconnect storms get one automatic reconnect per binding and cannot keep buying capabilities', async () => {
  const t = fixture(); const life = t.start(); await settle();
  life.disconnected('foreign'); life.disconnected('lease-1'); life.disconnected('lease-1');
  await t.clock.advance(1000); assert.equal(t.calls.length, 2);
  life.disconnected('lease-2'); await t.clock.advance(180_000);
  assert.equal(t.calls.length, 2); assert.deepEqual(t.issues, ['connection']); assert.equal(t.frame(), null); await life.stop();
});

test('hidden or closed view cancels renewal and a late response is detached without ever attaching', async () => {
  const t = fixture(); const delayed = deferred<CloudBrowserView>(); t.behavior.view = () => delayed.promise;
  const life = t.start(); await settle(); assert.equal(t.calls.length, 1);
  t.active(false); await life.stop(); assert.deepEqual(t.detached, ['lease-1']);
  delayed.resolve(t.response('lease-1')); await settle(); await t.clock.advance(120_000);
  assert.equal(t.shown.length, 0); assert.equal(t.calls.length, 1); assert.equal(t.clock.timers.size, 0);
});

test('late old task and page response cannot replace a new task control binding', async () => {
  const t = fixture(); const delayed = deferred<CloudBrowserView>(); t.behavior.view = () => delayed.promise;
  const old = t.start(); await settle(); await old.stop();
  const next = { ...t.requested, conversationId: 'task-b', id: 'browser-b', controlVersion: 4, focusTargetId: 'page-b', pages: [{ targetId: 'page-b', title: 'B', url: 'https://example.com/b' }] };
  t.behavior.view = async (_r, target, id) => ({ ...t.response(id, target), controlVersion: 4 }); t.behavior.detach = async () => next;
  const fresh = t.start(next, 'binding-b'); await settle();
  assert.equal(t.frame()?.viewerLeaseId, 'lease-2'); assert.equal(t.frame()?.targetId, 'page-b');
  delayed.resolve(t.response('lease-1')); await settle();
  assert.equal(t.frame()?.viewerLeaseId, 'lease-2'); assert.equal(t.shown.length, 1); await fresh.stop();
});

test('wrong page, epoch, lease, unsafe URL and expired capability never attach or trigger blind retries', async () => {
  for (const change of [{ targetId: 'other' }, { controlVersion: 9 }, { viewerLeaseId: 'other' }, { url: 'https://attacker.example/' }, { expiresAt: '2020-01-01T00:00:00Z' }]) {
    const t = fixture(); t.behavior.view = async (_r, target, id) => ({ ...t.response(id, target), ...change });
    const life = t.start(); await settle(); await t.clock.advance(120_000);
    assert.equal(t.shown.length, 0); assert.equal(t.calls.length, 1); assert.deepEqual(t.detached, ['lease-1']); assert.deepEqual(t.issues, ['binding']); await life.stop();
  }
});

test('failed lease cleanup blocks renewal, remains owed, and explicit retry closes it before a new mint', async () => {
  const t = fixture(); const life = t.start(); await settle(); t.behavior.detach = async () => { throw new Error('offline'); };
  await t.clock.advance(60_000); await t.clock.advance(120_000);
  assert.equal(t.calls.length, 1); assert.deepEqual(t.issues, ['cleanup']); assert.equal(t.frame(), null);
  await life.stop(); t.behavior.detach = async () => t.requested;
  const retry = t.start(); await settle(); assert.equal(t.calls.length, 2);
  assert.ok(t.detached.filter(id => id === 'lease-1').length >= 2); await retry.stop();
});

test('transient mint failure retries once; control/auth/rate-limit refusals never automatically retry', async () => {
  for (const status of [undefined, 401, 403, 409, 429]) {
    const t = fixture(); t.behavior.view = async () => { throw Object.assign(new Error('failed'), { status }); };
    const life = t.start(); await t.clock.advance(180_000);
    assert.equal(t.calls.length, status === undefined ? 2 : 1); assert.equal(t.shown.length, 0); assert.deepEqual(t.issues, ['connection']); await life.stop();
  }
});

test('a changed epoch returned by cleanup cannot mint against the old resource', async () => {
  const t = fixture(); t.leases.remember(t.requested, { viewerLeaseId: 'old-lease' });
  t.behavior.detach = async () => ({ ...t.requested, controlVersion: 2 });
  const life = t.start(); await settle(); assert.equal(t.calls.length, 0); assert.deepEqual(t.issues, ['binding']); await life.stop();
});

test('pending return and nonactive resources cannot mint; busy first open waits for resume', async () => {
  for (const change of [{ returnPending: true }, { state: 'uncertain' as const }, { state: 'stopped' as const }]) {
    const t = fixture(change); const life = t.start(); await settle(); assert.equal(t.calls.length, 0); await life.stop();
  }
  const t = fixture(); t.busy(true); const life = t.start(); await t.clock.advance(120_000); assert.equal(t.calls.length, 0);
  t.busy(false); life.resume(); await settle(); assert.equal(t.calls.length, 1); await life.stop();
});

test('a mint finishing during busy input is retired and resumes only after that input ends', async () => {
  const t = fixture(); const delayed = deferred<CloudBrowserView>(); t.behavior.view = () => delayed.promise;
  const life = t.start(); await settle(); t.busy(true); delayed.resolve(t.response('lease-1')); await settle();
  assert.equal(t.shown.length, 0); assert.deepEqual(t.detached, ['lease-1']); assert.equal(t.calls.length, 1);
  t.behavior.view = async (_r, target, id) => t.response(id, target); t.busy(false); life.resume(); await settle();
  assert.equal(t.calls.length, 2); assert.equal(t.shown.length, 1); await life.stop();
});

test('hung mint times out, tombstones its known lease and never attaches its eventual response', async () => {
  const t = fixture(); const delayed = deferred<CloudBrowserView>(); t.behavior.view = () => delayed.promise;
  const life = t.start(); await t.clock.advance(60_000); assert.deepEqual(t.detached, ['lease-1']);
  await life.stop(); delayed.resolve(t.response('lease-1')); await settle(); assert.equal(t.shown.length, 0); assert.equal(t.clock.timers.size, 0);
});

test('late successful mint after timeout and failed detach remains owed until explicit cleanup succeeds', async () => {
  const t = fixture(); const delayed = deferred<CloudBrowserView>(); t.behavior.view = () => delayed.promise;
  t.behavior.detach = async () => { throw new Error('offline'); };
  const life = t.start(); await t.clock.advance(60_000);
  assert.deepEqual(t.issues, ['cleanup']); assert.deepEqual(t.detached, ['lease-1']);
  delayed.resolve(t.response('lease-1')); await t.clock.advance(120_000);
  assert.equal(t.shown.length, 0); assert.equal(t.calls.length, 1);
  t.behavior.detach = async () => t.requested;
  await t.leases.detachAll(t.requested); assert.deepEqual(t.detached, ['lease-1', 'lease-1']); await life.stop();
});

test('page selection stays explicit and close notices require exact terminal confirmation', () => {
  assert.equal(browserViewTarget(resource, 'chosen'), 'chosen'); assert.equal(browserViewTarget(resource), 'page-a');
  assert.equal(browserViewTarget({ ...resource, focusTargetId: undefined }), 'page-a');
  assert.equal(browserCloseResultMessage({ closed: false, status: 'releasing' }), 'Stop requested. Waiting for the provider to confirm it ended.');
  assert.equal(browserCloseResultMessage({ closed: false, status: 'unknown' }), 'Stopping was not confirmed. Refresh before trying again.');
  assert.equal(browserCloseResultMessage({ closed: true, status: 'closed' }), 'Browser stopped.');
  assert.notEqual(browserCloseResultMessage(JSON.parse('{"closed":true,"status":"unknown"}')), 'Browser stopped.');
  assert.equal(browserCloseResultMessage({ resource: { ...resource, state: 'uncertain' } }), 'Stopping was not confirmed. Refresh before trying again.');
});
