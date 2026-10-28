/** Run with scripts/run-tests-isolated.mjs; no daemon, providers, or home needed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computerDriverNextStep, type ComputerDriverStatus } from './computer-driver';

const base: ComputerDriverStatus = {
  installed: false, path: null, daemon: 'unknown', statusText: null, permissions: 'unknown', permissionsText: null, connected: false,
  serverName: 'cua-driver', installCommand: 'x', docsUrl: 'y', platformSupport: 'supported',
  install: { blocked: false, viaPassword: false, reason: null, adminCommand: null },
};

test('the card offers one next step: install, then permissions, then connect, then ready', () => {
  assert.equal(computerDriverNextStep(base), 'install');
  assert.equal(computerDriverNextStep({ ...base, installed: true, path: '/u/.local/bin/cua-driver', permissions: 'missing' }), 'permissions');
  assert.equal(computerDriverNextStep({ ...base, installed: true, path: '/u/.local/bin/cua-driver', permissions: 'granted' }), 'connect');
  assert.equal(computerDriverNextStep({ ...base, installed: true, path: '/u/.local/bin/cua-driver', permissions: 'unknown', connected: true }), 'ready');
  assert.equal(computerDriverNextStep({ ...base, platformSupport: 'unsupported' }), 'unsupported');
  assert.equal(computerDriverNextStep({ ...base, install: { blocked: true, viaPassword: false, reason: 'An administrator needs to run it once.', adminCommand: 'x' } }), 'needs-admin', 'an account that cannot place the app is told so instead of offered the button');
  assert.equal(computerDriverNextStep({ ...base, install: { blocked: false, viaPassword: true, reason: 'Your computer will ask for an administrator password.', adminCommand: 'x' } }), 'install', 'the OS password prompt keeps the one-tap install');
});
