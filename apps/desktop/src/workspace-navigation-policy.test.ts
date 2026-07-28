import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPrivilegedDashboardRendererUrl,
  isSafeWorkspaceExternalUrl,
  isWorkspaceViewUrl,
  workspaceFrameNavigationMustBeBlocked,
  workspaceInitialFrameLoadMayProceed,
  workspaceTopLevelNavigationMustBeBlocked,
} from './workspace-navigation-policy.js';

test('Workspace view recognition is path-exact and loopback-origin agnostic', () => {
  assert.equal(isWorkspaceViewUrl('http://127.0.0.1:43123/console/spaces/social-calendar/view/'), true);
  assert.equal(isWorkspaceViewUrl('http://localhost:43123/console/spaces/social-calendar/view/app.js'), true);
  assert.equal(isWorkspaceViewUrl('http://127.0.0.1:43123/console/workspaces/social-calendar'), false);
  assert.equal(isWorkspaceViewUrl('https://evil.example/console/spaces/social-calendar/view/'), false);
});

test('agent-authored Workspace documents never inherit privileged dashboard IPC', () => {
  const origins = new Set(['http://127.0.0.1:43123']);
  assert.equal(
    isPrivilegedDashboardRendererUrl('http://127.0.0.1:43123/console/workspaces/social-calendar', origins),
    true,
  );
  assert.equal(
    isPrivilegedDashboardRendererUrl('http://127.0.0.1:43123/console/spaces/social-calendar/view/', origins),
    false,
  );
  assert.equal(
    isPrivilegedDashboardRendererUrl('http://127.0.0.1:43123/console/spaces/social-calendar/view/app.js', origins),
    false,
  );
  assert.equal(
    isPrivilegedDashboardRendererUrl('http://127.0.0.1:43124/console/workspaces/social-calendar', origins),
    false,
  );
});

test('a loaded Workspace frame cannot navigate itself or act as a navigation deputy', () => {
  const workspace = 'http://127.0.0.1:43123/console/spaces/social-calendar/view/';
  assert.equal(workspaceFrameNavigationMustBeBlocked({
    frameUrl: workspace,
    initiatorUrl: workspace,
    targetUrl: 'https://evil.example/collect?workspace=data',
  }), true);
  assert.equal(workspaceFrameNavigationMustBeBlocked({
    frameUrl: workspace,
    initiatorUrl: workspace,
    targetUrl: 'http://127.0.0.1:43123/console/settings?workspace=data',
  }), true);
  assert.equal(workspaceFrameNavigationMustBeBlocked({
    frameUrl: 'about:blank',
    initiatorUrl: 'http://127.0.0.1:43123/console/workspaces/social-calendar',
    targetUrl: workspace,
  }), false, 'initial parent-authored iframe load remains available');
  assert.equal(workspaceInitialFrameLoadMayProceed({
    frameUrl: 'about:blank',
    initiatorUrl: 'http://127.0.0.1:43123/console/workspaces/social-calendar',
    targetUrl: workspace,
  }), true, 'the first trusted iframe navigation bypasses ordinary external-link handling');
  assert.equal(workspaceInitialFrameLoadMayProceed({
    frameUrl: workspace,
    initiatorUrl: workspace,
    targetUrl: workspace,
  }), false, 'an authored frame cannot reload or navigate through the initial-load exception');
  assert.equal(workspaceFrameNavigationMustBeBlocked({
    frameUrl: 'http://127.0.0.1:43123/console/chat',
    initiatorUrl: 'http://127.0.0.1:43123/console/chat',
    targetUrl: 'https://example.com',
  }), false, 'ordinary trusted dashboard links retain their external opener');
});

test('a raw Workspace URL is denied as top-level navigation and never becomes an external handoff', () => {
  assert.equal(
    workspaceTopLevelNavigationMustBeBlocked(
      'http://127.0.0.1:43123/console/spaces/social-calendar/view/',
    ),
    true,
  );
  assert.equal(
    workspaceTopLevelNavigationMustBeBlocked(
      'http://127.0.0.1:43123/console/workspaces/social-calendar',
    ),
    false,
  );
  assert.equal(
    workspaceTopLevelNavigationMustBeBlocked(
      'https://example.com/console/spaces/social-calendar/view/',
    ),
    false,
  );
});

test('trusted-click external URLs accept user-facing protocols but reject executable or credentialed URLs', () => {
  assert.equal(isSafeWorkspaceExternalUrl('https://example.com/evidence?id=1'), true);
  assert.equal(isSafeWorkspaceExternalUrl('mailto:owner@example.com?subject=Draft'), true);
  assert.equal(isSafeWorkspaceExternalUrl('tel:+15551234567'), true);
  assert.equal(isSafeWorkspaceExternalUrl('javascript:alert(1)'), false);
  assert.equal(isSafeWorkspaceExternalUrl('https://user:secret@example.com/'), false);
  assert.equal(isSafeWorkspaceExternalUrl('https://example.com/\nmalformed'), false);
});
