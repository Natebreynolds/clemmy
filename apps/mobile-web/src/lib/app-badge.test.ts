import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { appBadgeAuthAction, appBadgeCount, clearAppBadge, syncAppBadge, type BadgeTarget } from './app-badge';

function recorder(overrides?: Partial<BadgeTarget>) {
  const calls: Array<{ op: 'set' | 'clear'; count?: number }> = [];
  const target: BadgeTarget = {
    setAppBadge: async (count?: number) => { calls.push({ op: 'set', count }); },
    clearAppBadge: async () => { calls.push({ op: 'clear' }); },
    ...overrides,
  };
  return { calls, target };
}

test('an unknown count neither sets nor clears the badge', () => {
  assert.equal(appBadgeCount({ count: 3, known: false }), null);
  const { calls, target } = recorder();
  assert.equal(syncAppBadge({ count: 3, known: false }, target), null);
  assert.deepEqual(calls, [], 'a dropped poll must never repaint the icon');
});

test('zero is an authoritative answer and clears the badge', () => {
  const { calls, target } = recorder();
  assert.equal(syncAppBadge({ count: 0, known: true }, target), 0);
  assert.deepEqual(calls, [{ op: 'clear' }]);
});

test('a known count is applied, bounded, and never negative', () => {
  const { calls, target } = recorder();
  syncAppBadge({ count: 4, known: true }, target);
  syncAppBadge({ count: 5_000, known: true }, target);
  assert.deepEqual(calls, [{ op: 'set', count: 4 }, { op: 'set', count: 99 }]);
  assert.equal(appBadgeCount({ count: -1, known: true }), null);
  assert.equal(appBadgeCount({ count: Number.NaN, known: true }), null);
});

test('an unsupported browser and a rejected call are both silent', async () => {
  assert.equal(syncAppBadge({ count: 2, known: true }, {}), 2, 'no methods = nothing to do');
  const rejecting: BadgeTarget = {
    setAppBadge: () => Promise.reject(new Error('not installed')),
    clearAppBadge: () => { throw new Error('not installed'); },
  };
  assert.equal(syncAppBadge({ count: 2, known: true }, rejecting), 2);
  assert.doesNotThrow(() => clearAppBadge(rejecting));
  // Let the rejected promise settle so an unhandled rejection would surface.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('sign-out clears the icon', () => {
  const { calls, target } = recorder();
  clearAppBadge(target);
  assert.deepEqual(calls, [{ op: 'clear' }]);
});

test('a session that is not yet known holds the icon — only a confirmed sign-out clears', () => {
  // The cold open: the badge says 3, the Mac is asleep, /m/auth/status has not
  // answered yet. Treating that null as "signed out" cleared the icon and left
  // it saying "you're clear" while three things needed the user.
  assert.equal(appBadgeAuthAction(null), 'hold');
  assert.equal(appBadgeAuthAction(undefined), 'hold');
  assert.equal(appBadgeAuthAction({ authenticated: false }), 'clear');
  assert.equal(appBadgeAuthAction({ authenticated: true }), 'sync');
});

test('the shell asks the session gate before it touches the icon', () => {
  const app = readFileSync(new URL('../app.tsx', import.meta.url), 'utf8');
  assert.match(app, /const action = appBadgeAuthAction\(authStatus\);/,
    'the raw `authenticated` boolean cannot distinguish unknown from signed out');
  assert.match(app, /if \(action === 'clear'\) \{ clearAppBadge\(\); return; \}/);
  assert.match(app, /if \(action === 'hold'\) return;/);
  assert.doesNotMatch(app, /if \(!authenticated\) \{ clearAppBadge\(\); return; \}/,
    'the cold-open wipe must not come back');
});

test('signing out is local and unconditional — an unreachable Mac cannot cancel it', () => {
  // `await logout(); clearAppBadge(); await refreshAuth();` did nothing at all
  // offline: the throw skipped every line after it and Settings swallowed the
  // rejection, leaving a signed-in shell and a stale icon count.
  const app = readFileSync(new URL('../app.tsx', import.meta.url), 'utf8');
  const handler = app.slice(app.indexOf('onSignOut={async () =>'), app.indexOf('onCustomize={() => setCustomizeOpen(true)}', app.indexOf('onSignOut={async () =>')));
  assert.ok(handler.length > 0, 'the sign-out handler moved — re-anchor this pin');
  assert.match(handler, /try \{\s*\n\s*await logout\(\);\s*\n\s*\} catch \{/);
  assert.match(handler, /clearAppBadge\(\);/);
  assert.match(handler, /setAuthStatus\(\(s\) => \(s \? \{ \.\.\.s, authenticated: false \} : s\)\);/,
    'the device is signed out whether or not the daemon heard it');
  assert.match(handler, /if \(told\) await refreshAuth\(\);/,
    'only re-ask the daemon when it actually answered');
});
