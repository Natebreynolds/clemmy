import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLI_HEALTH_FRESH_FOR_MS, cliConnectionHealth, cliConnectionPresentation } from './cli-connection-view';
import type { CliHealth } from './connect';

const now = Date.parse('2026-10-14T22:00:00.000Z');
const health = (fields: Partial<CliHealth> = {}): CliHealth => ({
  id: 'fixture', command: 'fixture-command', installed: true, authStatus: 'ok',
  checkedAt: new Date(now - 1_000).toISOString(), ...fields,
});
const view = (fields: Partial<CliHealth> = {}) => cliConnectionPresentation({ health: health(fields) }, now);

test('saved membership and installation never manufacture authenticated access', () => {
  assert.equal(cliConnectionPresentation({}, now).state, 'not_checked');
  assert.equal(cliConnectionPresentation({ installed: false }, now).state, 'not_installed');
  assert.equal(cliConnectionPresentation({ installed: true }, now).state, 'installed');
  assert.equal(cliConnectionPresentation({ installed: true, authRequired: true }, now).tone, 'neutral');
  assert.equal(view({ authStatus: 'unknown' }).state, 'installed');
  assert.equal(view({ authStatus: 'error' }).state, 'check_needed');
  assert.equal(cliConnectionPresentation({ health: health({ authStatus: 'error' }), authRequired: false }, now).state, 'check_needed');
});

test('only a fresh successful check displays connected and its exact account', () => {
  const result = view({ username: 'fixture-account' });
  assert.equal(result.label, 'Connected');
  assert.equal(result.tone, 'success');
  assert.equal(result.account, 'fixture-account');
  assert.match(result.help, /account and permissions/);
  assert.equal(view({ installed: false }).state, 'not_installed');
  assert.equal(view({ authStatus: 'signed_out' }).state, 'signed_out');
});

test('unknown authentication differs from an explicit no-account tool', () => {
  assert.equal(cliConnectionPresentation({ installed: true }, now).label, 'Installed');
  assert.equal(cliConnectionPresentation({ installed: true, authRequired: false }, now).label, 'Available');
  assert.equal(cliConnectionPresentation({ authRequired: false }, now).state, 'not_checked');
  assert.equal(cliConnectionPresentation({ health: health({ authStatus: 'signed_out' }), authRequired: false }, now).state, 'signed_out');
});

test('credential store and missing defaults are actionable setup states, not sign-out or green success', () => {
  const blocked = view({ issue: 'credential_store_unavailable' });
  assert.equal(blocked.state, 'credential_blocked');
  assert.match(blocked.help, /new sign-in may not be needed/);
  const configure = view({ issue: 'configuration_required' });
  assert.equal(configure.state, 'needs_configuration');
  assert.notEqual(configure.tone, 'success');
});

test('stale, failed, future, invalid and old checks cannot retain a green account or invent sign-out', () => {
  for (const fields of [
    { staleSince: new Date(now - 1_000).toISOString() },
    { lastProbeError: { timedOut: true, exitCode: null } },
    { lastProbeError: { timedOut: false, exitCode: 1 } },
    { checkedAt: 'invalid' }, { checkedAt: new Date(now + 1).toISOString() },
    { checkedAt: new Date(now - CLI_HEALTH_FRESH_FOR_MS - 1).toISOString() },
  ]) {
    for (const authStatus of ['ok', 'signed_out'] as const) {
      const result = view({ authStatus, username: 'prior-account', ...fields });
      assert.equal(result.state, 'check_needed');
      assert.notEqual(result.tone, 'success');
      assert.equal(result.account, undefined);
    }
  }
  assert.equal(view({ checkedAt: new Date(now - CLI_HEALTH_FRESH_FOR_MS).toISOString() }).state, 'connected');
});

test('a failed metadata refresh demotes retained success without changing installation or starting recovery', () => {
  const result = cliConnectionPresentation({ health: health(), unavailable: true }, now);
  assert.equal(result.state, 'unavailable');
  assert.notEqual(result.tone, 'success');
  assert.equal(result.account, undefined);
});

test('health selection binds exact identities and refuses ambiguous or malformed command aliases', () => {
  const exact = health();
  assert.equal(cliConnectionHealth({ fixture: exact }, 'fixture', 'fixture-command'), exact);
  assert.equal(cliConnectionHealth({ fixture: exact }, 'saved:fixture-command', 'fixture-command'), exact);
  assert.equal(cliConnectionHealth({ fixture: exact }, 'fixture', 'different-command'), undefined);
  assert.equal(cliConnectionHealth({ wrong: exact }, 'wrong', 'fixture-command'), undefined);
  assert.equal(cliConnectionHealth({ fixture: exact, second: health({ id: 'second' }) }, 'saved:fixture-command', 'fixture-command'), undefined);
});
