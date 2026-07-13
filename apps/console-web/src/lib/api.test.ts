import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { __test__ } from './api.js';

test('resolveSupervisorDashboardUrl corrects a stale dashboard URL with the live daemon port', () => {
  assert.equal(
    __test__.resolveSupervisorDashboardUrl(
      { running: true, port: 8521, url: 'http://127.0.0.1:8520/console?token=secret' },
    ),
    'http://127.0.0.1:8521/console?token=secret',
  );
});

test('resolveSupervisorDashboardUrl rejects stopped, invalid, and non-loopback targets', () => {
  assert.equal(__test__.resolveSupervisorDashboardUrl({ running: false, port: 8521, url: 'http://127.0.0.1:8521/console' }), null);
  assert.equal(__test__.resolveSupervisorDashboardUrl({ running: true, port: 0, url: 'not a URL' }), null);
  assert.equal(__test__.resolveSupervisorDashboardUrl({ running: true, port: 8521, url: 'https://example.com/console' }), null);
});

test('responseErrorMessage preserves server message diagnostics as well as error diagnostics', () => {
  assert.equal(__test__.responseErrorMessage(400, { message: 'OAuth callback server could not bind.' }), 'OAuth callback server could not bind.');
  assert.equal(__test__.responseErrorMessage(502, { error: 'fetch failed' }), 'fetch failed');
  assert.equal(__test__.responseErrorMessage(500, {}), 'HTTP 500');
});

test('renderer bootstrap navigation never crosses daemon origins', () => {
  assert.equal(
    __test__.shouldNavigateForBootstrap(
      'http://127.0.0.1:8521/console?token=secret',
      'http://127.0.0.1:8520/console',
    ),
    false,
  );
  assert.equal(
    __test__.shouldNavigateForBootstrap(
      'http://127.0.0.1:8520/console?token=secret',
      'http://127.0.0.1:8520/console',
    ),
    true,
  );
  assert.equal(
    __test__.shouldNavigateForBootstrap(
      'http://127.0.0.1:8520/console',
      'http://127.0.0.1:8520/console',
    ),
    false,
  );
});
