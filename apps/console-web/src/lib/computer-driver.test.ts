/** Run with scripts/run-tests-isolated.mjs; no daemon, providers, or home needed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computerDriverNextStep, type ComputerDriverStatus } from './computer-driver';

const base: ComputerDriverStatus = {
  installed: false, path: null, embedded: false, version: '0.37.0', daemon: 'unknown', statusText: null, permissions: 'unknown', permissionsText: null, connected: false,
  serverName: 'cua-driver', docsUrl: 'y', platformSupport: 'supported',
};

test('the card offers one next step: turn on, then connect an older copy, then ready', () => {
  assert.equal(computerDriverNextStep(base), 'install');
  assert.equal(computerDriverNextStep({ ...base, installed: true, path: '/h/tools/bin/cua-driver', embedded: true }), 'connect');
  assert.equal(computerDriverNextStep({ ...base, installed: true, path: '/h/tools/bin/cua-driver', embedded: true, connected: true }), 'ready');
  assert.equal(computerDriverNextStep({ ...base, installed: true, path: '/h/tools/bin/cua-driver', permissions: 'missing', connected: true }), 'ready', 'permissions are the system\'s pages, offered beside the ready line, never a wall');
  assert.equal(computerDriverNextStep({ ...base, platformSupport: 'unsupported' }), 'unsupported');
});
