import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerDriverStatus } from './computer-driver';
import { computerDriverPresentation } from './computer-driver-presentation';

const connected: ComputerDriverStatus = {
  installed: true, path: '/controlled/driver', embedded: true, version: '1.0',
  daemon: 'running', statusText: null, permissions: 'granted', permissionsText: null,
  connected: true, serverName: 'controlled-computer', docsUrl: 'https://example.test/driver',
  platformSupport: 'supported', permissionSettingsAvailable: true,
};

test('computer connection summary requires current installation, registration, running state and screen permission for success', () => {
  for (const installed of [false, true]) for (const registered of [false, true]) {
    for (const daemon of ['running', 'stopped', 'unknown'] as const) {
      for (const permissions of ['granted', 'missing', 'unknown'] as const) {
        const result = computerDriverPresentation({ ...connected, installed, connected: registered, daemon, permissions });
        assert.equal(result.tone === 'success', installed && registered && daemon === 'running' && permissions === 'granted',
          JSON.stringify({ installed, registered, daemon, permissions, result }));
        assert.doesNotMatch(result.label, /ready/i);
      }
    }
  }
});

test('unavailable reads override even a previously healthy computer connection', () => {
  for (const previous of [undefined, connected]) {
    const result = computerDriverPresentation(previous, true);
    assert.equal(result.label, 'Status unavailable');
    assert.equal(result.tone, 'warning');
    assert.match(result.detail, /Refresh its status/);
    assert.doesNotMatch(result.detail, /Ask Clem to work/);
  }
});

test('checking, stopped, missing permissions and unknown states remain distinct', () => {
  assert.equal(computerDriverPresentation().label, 'Checking…');
  assert.equal(computerDriverPresentation({ ...connected, daemon: 'stopped' }).label, 'Stopped');
  assert.equal(computerDriverPresentation({ ...connected, permissions: 'missing' }).label, 'Permission needed');
  assert.equal(computerDriverPresentation({ ...connected, daemon: 'unknown' }).label, 'Status unknown');
  assert.equal(computerDriverPresentation({ ...connected, permissions: 'unknown' }).label, 'Permissions unknown');
  assert.equal(computerDriverPresentation({ ...connected, connected: false }).label, 'Not connected');
});

test('unsupported platforms never inherit a successful connection summary', () => {
  const result = computerDriverPresentation({ ...connected, platformSupport: 'unsupported' });
  assert.equal(result.label, 'Unavailable here');
  assert.equal(result.tone, 'neutral');
  assert.match(result.detail, /isn’t supported/);
});

test('Windows preview uses the same truthful status without Mac-specific claims', () => {
  for (const permissions of ['granted', 'missing', 'unknown'] as const) {
    const result = computerDriverPresentation({ ...connected, platformSupport: 'preview', permissions, permissionSettingsAvailable: false });
    assert.doesNotMatch(result.label + result.detail, /macOS|System Settings|Accessibility|Screen Recording/);
  }
});
