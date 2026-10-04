import test from 'node:test';
import assert from 'node:assert/strict';
import { browserViewerNavigationDecision, createBrowserViewerNavigationGuard, isBrowserViewerNavigationUrl, type BrowserViewerFrame } from './browser-viewer-navigation-policy.js';
import { isPrivilegedDashboardRendererUrl } from './workspace-navigation-policy.js';

const origins = new Set(['http://127.0.0.1:43123']);
const viewer = 'https://www.browserbase.com/devtools-fullscreen/?token=synthetic-private-viewer';
function fixture() {
  const main: BrowserViewerFrame = { url: 'http://127.0.0.1:43123/console/chat', processId: 1, routingId: 1, frameTreeNodeId: 1, parent: null, top: null };
  const frame: BrowserViewerFrame = { url: 'about:blank', processId: 1, routingId: 2, frameTreeNodeId: 2, parent: main, top: main };
  const input = { targetUrl: viewer, isMainFrame: false, frame, initiator: main, mainFrame: main, trustedOrigins: origins };
  return { main, frame, input };
}

test('the trusted dashboard mounts and renews its direct Browserbase viewer frame', () => {
  const { main, frame, input } = fixture();
  assert.equal(browserViewerNavigationDecision(input), 'allow');
  assert.equal(browserViewerNavigationDecision({ ...input, frame: { ...frame, url: '' } }), 'allow');
  assert.equal(browserViewerNavigationDecision({ ...input, frame: { ...frame, url: viewer }, initiator: { ...main } }), 'allow', 'frame identity survives distinct Electron wrappers');
  assert.equal(browserViewerNavigationDecision({ ...input, targetUrl: 'https://browserbase.com/provider-owned-path?token=synthetic' }), 'allow', 'the provider URL path is not a fixed API contract');
  assert.equal(isPrivilegedDashboardRendererUrl(viewer, origins), false, 'embedding never grants dashboard IPC');
});

test('the same viewer can navigate within Browserbase while retaining its trusted parent', () => {
  const { frame, input } = fixture();
  const loaded = { ...frame, processId: 5, url: viewer };
  assert.equal(browserViewerNavigationDecision({ ...input, frame: loaded, initiator: { ...loaded }, targetUrl: 'https://www.browserbase.com/another-view?token=synthetic-renewal' }), 'allow');
  for (const targetUrl of ['http://127.0.0.1:43123/console/settings', 'https://example.com/', 'mailto:owner@example.com', 'about:blank']) {
    assert.equal(browserViewerNavigationDecision({ ...input, frame: loaded, initiator: loaded, targetUrl }), 'block');
  }
});

test('a viewer cannot replace the main frame and provider URLs are kept from the external opener', () => {
  const { main, frame, input } = fixture();
  const loaded = { ...frame, url: viewer };
  assert.equal(browserViewerNavigationDecision({ ...input, isMainFrame: true, frame: main }), 'block');
  assert.equal(browserViewerNavigationDecision({ ...input, frame: main }), 'block', 'actual frame identity is authoritative too');
  assert.equal(browserViewerNavigationDecision({ ...input, isMainFrame: true, frame: main, initiator: loaded, targetUrl: 'https://example.com/' }), 'block');
  for (const targetUrl of [viewer, 'http://www.browserbase.com/view?token=synthetic', 'https://browserbase.com:444/view?token=synthetic', 'https://user:synthetic@browserbase.com/view']) {
    assert.equal(isBrowserViewerNavigationUrl(targetUrl), true, 'unsafe provider URLs must also be denied by the popup/external-opener guard');
  }
});

test('unknown, unrelated, sibling and nested frame initiators fail closed', () => {
  const { main, frame, input } = fixture();
  for (const initiator of [null, undefined, { ...main, processId: 99 }, { ...frame, routingId: 3 }, { ...main, url: 'https://example.com/' }]) {
    assert.equal(browserViewerNavigationDecision({ ...input, initiator }), 'block');
  }
  assert.equal(browserViewerNavigationDecision({ ...input, frame: null }), 'block');
  assert.equal(browserViewerNavigationDecision({ ...input, frame: { ...frame, parent: frame } }), 'block');
  assert.equal(browserViewerNavigationDecision({ ...input, frame: { ...frame, top: null } }), 'block');
  assert.equal(browserViewerNavigationDecision({ ...input, frame: { ...frame, url: 'https://example.com/' } }), 'block');
});

test('Workspace content, other local services and non-dashboard surfaces cannot embed viewers', () => {
  const { main, frame, input } = fixture();
  for (const url of ['http://127.0.0.1:43124/console/chat', 'http://127.0.0.1:43123/api/console/settings', 'http://127.0.0.1:43123/console/notch', 'http://127.0.0.1:43123/console/spaces/example/view/', 'http://127.0.0.1:43123/console/spaces/example/%76iew/']) {
    const other = { ...main, url };
    assert.equal(browserViewerNavigationDecision({ ...input, mainFrame: other, initiator: other, frame: { ...frame, parent: other, top: other } }), 'block');
  }
  assert.equal(browserViewerNavigationDecision({ ...input, initiator: { ...frame, url: 'http://127.0.0.1:43123/console/spaces/example/view/' } }), 'block');
});

test('embedding accepts only exact HTTPS Browserbase origins with no URL credentials or fragments', () => {
  const { frame, input } = fixture();
  const loaded = { ...frame, url: viewer };
  for (const targetUrl of ['http://www.browserbase.com/view', 'https://www.browserbase.com.evil.example/view', 'https://evil.example/view', 'https://browserbase.com:444/view', 'https://user:synthetic@browserbase.com/view', `${viewer}#fragment`, 'https://www.browserbase.com/\nview', 'javascript:alert(1)']) {
    assert.equal(browserViewerNavigationDecision({ ...input, frame: loaded, targetUrl }), 'block');
  }
});

test('ordinary dashboard and Workspace navigation keep their existing policy', () => {
  const { input } = fixture();
  for (const targetUrl of ['https://example.com/', 'http://127.0.0.1:43123/console/spaces/example/view/', 'mailto:owner@example.com']) {
    assert.equal(browserViewerNavigationDecision({ ...input, targetUrl }), 'unhandled');
  }
});

test('first-load redirects stay bound while the frame URL is still empty', () => {
  const { frame, input } = fixture();
  const first = { ...input, frame: { ...frame, url: '' } };
  for (const targetUrl of ['http://127.0.0.1:43123/console/settings', 'https://example.com/', 'http://www.browserbase.com/view']) {
    const guard = createBrowserViewerNavigationGuard();
    assert.equal(guard.navigation(first), 'allow');
    assert.equal(guard.redirect({ ...first, targetUrl }), 'block');
    assert.equal(guard.redirect(first), 'block', 'a rejected chain loses its admission');
  }
  const guard = createBrowserViewerNavigationGuard();
  assert.equal(guard.navigation(first), 'allow');
  assert.equal(guard.redirect({ ...first, targetUrl: 'https://browserbase.com/provider-redirect?token=synthetic' }), 'allow');
  assert.equal(guard.redirect({ ...first, frame: { ...first.frame, processId: 5, routingId: 6 } }), 'allow', 'frame-tree identity survives a renderer process change');
});

test('redirects cannot borrow another frame, parent or initiator admission', () => {
  const { main, frame, input } = fixture();
  for (const patch of [
    { frame: { ...frame, frameTreeNodeId: 99 } },
    { mainFrame: { ...main, frameTreeNodeId: 99 } },
    { initiator: null },
    { initiator: { ...main, processId: 99 } },
    { isMainFrame: true },
  ]) {
    const guard = createBrowserViewerNavigationGuard();
    assert.equal(guard.navigation(input), 'allow');
    assert.equal(guard.redirect({ ...input, ...patch }), 'block');
  }
  assert.equal(createBrowserViewerNavigationGuard().redirect(input), 'block', 'a redirect cannot invent initial admission');
});

test('commit, failure, removal and replacement navigation clean pending viewer admission', () => {
  const { frame, input } = fixture();
  const cleaners = [
    (guard: ReturnType<typeof createBrowserViewerNavigationGuard>) => guard.settled(frame.processId, frame.routingId),
    (guard: ReturnType<typeof createBrowserViewerNavigationGuard>) => guard.settled(99, 100, frame.frameTreeNodeId),
    (guard: ReturnType<typeof createBrowserViewerNavigationGuard>) => guard.prune(new Set([input.mainFrame.frameTreeNodeId])),
    (guard: ReturnType<typeof createBrowserViewerNavigationGuard>) => guard.clear(),
    (guard: ReturnType<typeof createBrowserViewerNavigationGuard>) => guard.navigation({ ...input, targetUrl: 'https://example.com/' }),
  ];
  for (const clean of cleaners) {
    const guard = createBrowserViewerNavigationGuard();
    assert.equal(guard.navigation(input), 'allow');
    clean(guard);
    assert.equal(guard.redirect(input), 'block');
  }
  const guard = createBrowserViewerNavigationGuard();
  assert.equal(guard.navigation(input), 'allow');
  guard.settled(100, 101);
  assert.equal(guard.redirect(input), 'allow', 'an unrelated load must not cancel this admission');
});

test('late failure for a replaced navigation cannot let its empty-source viewer escape', () => {
  const { frame, input } = fixture();
  const empty = { ...input, frame: { ...frame, url: '' } };
  for (const targetUrl of ['http://127.0.0.1:43123/console/settings', 'https://example.com/']) {
    const guard = createBrowserViewerNavigationGuard();
    assert.equal(guard.navigation(empty), 'allow', 'navigation A is admitted');
    assert.equal(guard.navigation({ ...empty, targetUrl: 'https://browserbase.com/replacement?token=synthetic-b' }), 'allow', 'navigation B replaces A on the same frame');
    guard.settled(frame.processId, frame.routingId, frame.frameTreeNodeId); // A's late failure cannot be correlated to a navigation.
    assert.equal(guard.redirect({ ...empty, targetUrl }), 'block', 'losing pending permission must not erase the viewer boundary');
    assert.equal(guard.redirect(empty), 'block', 'lost permission also cannot authorize a provider redirect');
    assert.equal(guard.navigation({ ...empty, targetUrl }), 'block', 'the marked viewer cannot escape by starting a fresh unrelated navigation either');
  }
});

test('only removed frames or a committed main-document replacement clear the deny-only viewer boundary', () => {
  const { frame, input } = fixture();
  const empty = { ...input, frame: { ...frame, url: '' } };
  const escape = { ...empty, targetUrl: 'http://127.0.0.1:43123/console/settings' };
  const guard = createBrowserViewerNavigationGuard();
  assert.equal(guard.navigation(empty), 'allow');
  guard.settled(frame.processId, frame.routingId);
  guard.prune(new Set([input.mainFrame.frameTreeNodeId, frame.frameTreeNodeId]));
  assert.equal(guard.redirect(escape), 'block', 'failure and a still-attached frame preserve denial');
  guard.prune(new Set([input.mainFrame.frameTreeNodeId]));
  assert.equal(guard.redirect(escape), 'unhandled', 'removed stable frame ids are never reused by Electron');
  assert.equal(guard.navigation(empty), 'allow');
  guard.clear();
  assert.equal(guard.redirect(escape), 'unhandled', 'a new main document gets a clean tracker');
});
