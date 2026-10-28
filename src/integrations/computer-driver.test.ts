/** Run: node scripts/run-tests-isolated.mjs src/integrations/computer-driver.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-computer-driver-'));
const driver = await import('./computer-driver.js');

test('the card reads install, daemon, permissions and connection from what the driver and the server list say', () => {
  const none = driver.readComputerDriverStatus({ path: null, statusText: null, permissionsText: null, servers: [], platform: 'darwin' });
  assert.equal(none.installed, false); assert.equal(none.daemon, 'unknown'); assert.equal(none.connected, false); assert.equal(none.platformSupport, 'supported');
  const running = driver.readComputerDriverStatus({
    path: '/u/.local/bin/cua-driver', statusText: 'CuaDriver daemon: running (standard mode)', permissionsText: 'Accessibility: granted\nScreen Recording: granted',
    servers: [{ name: 'cua-driver', command: '/u/.local/bin/cua-driver', args: ['mcp'], enabled: true }], platform: 'darwin',
  });
  assert.equal(running.installed, true); assert.equal(running.daemon, 'running'); assert.equal(running.permissions, 'granted'); assert.equal(running.connected, true);
  const stopped = driver.readComputerDriverStatus({
    path: '/u/.local/bin/cua-driver', statusText: 'daemon not running', permissionsText: 'Screen Recording: denied',
    servers: [{ name: 'cua-driver', command: '/u/.local/bin/cua-driver', args: ['mcp'], enabled: false }], platform: 'win32',
  });
  assert.equal(stopped.daemon, 'stopped'); assert.equal(stopped.permissions, 'missing'); assert.equal(stopped.connected, false, 'a disabled server is not a connection'); assert.equal(stopped.platformSupport, 'preview');
});

test('the driver is found in the installer\'s home location and registered as Clem\'s own stdio server', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-driver-home-'));
  assert.equal(driver.computerDriverPath(home, 'darwin'), null);
  mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(path.join(home, '.local', 'bin', 'cua-driver'), '#!/bin/sh\n');
  const found = driver.computerDriverPath(home, 'darwin');
  assert.equal(found, path.join(home, '.local', 'bin', 'cua-driver'));
  const server = driver.computerDriverServer(found!);
  assert.deepEqual({ name: server.name, type: server.type, args: server.args, enabled: server.enabled, source: server.source },
    { name: 'cua-driver', type: 'stdio', args: ['mcp'], enabled: true, source: 'user' });
  assert.match(driver.COMPUTER_DRIVER_INSTALL_COMMAND, /cua\.ai\/driver\/install/);
});
