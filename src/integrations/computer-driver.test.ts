/** Run: node scripts/run-tests-isolated.mjs src/integrations/computer-driver.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-computer-driver-'));
const driver = await import('./computer-driver.js');
const { resolveToolDownload } = await import('../runtime/clem-tools.js');

test('the card reads on/off, the daemon, permissions and connection from what Clem knows', () => {
  const none = driver.readComputerDriverStatus({ path: null, statusText: null, permissionsText: null, servers: [], platform: 'darwin' });
  assert.equal(none.installed, false); assert.equal(none.daemon, 'unknown'); assert.equal(none.connected, false); assert.equal(none.platformSupport, 'supported');
  const running = driver.readComputerDriverStatus({
    path: '/h/tools/bin/cua-driver', embedded: true, host: 'running', statusText: null, permissionsText: 'Accessibility: granted\nScreen Recording: granted',
    servers: [{ name: 'cua-driver', command: '/h/tools/bin/cua-driver', args: ['mcp', '--embedded', '--socket', '/h/state/cua-driver.sock', '--host-bundle-id', 'x'], enabled: true }], platform: 'darwin',
  });
  assert.equal(running.installed, true); assert.equal(running.embedded, true); assert.equal(running.daemon, 'running'); assert.equal(running.permissions, 'granted'); assert.equal(running.connected, true);
  const stopped = driver.readComputerDriverStatus({
    path: '/u/.local/bin/cua-driver', host: 'stopped', statusText: null, permissionsText: 'Screen Recording: denied',
    servers: [{ name: 'cua-driver', command: '/u/.local/bin/cua-driver', args: ['mcp'], enabled: false }], platform: 'win32',
  });
  assert.equal(stopped.embedded, false); assert.equal(stopped.daemon, 'stopped'); assert.equal(stopped.permissions, 'missing'); assert.equal(stopped.connected, false, 'a disabled server is not a connection'); assert.equal(stopped.platformSupport, 'preview');
});

test('Clem\'s own copy comes first, from the vendor\'s binary release for this machine, verified against the vendor\'s checksum file', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-driver-home-'));
  const toolsBin = path.join(home, '.clementine-next', 'tools', 'bin');
  assert.equal(driver.computerDriverPath(home, 'darwin', toolsBin), null);
  mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(path.join(home, '.local', 'bin', 'cua-driver'), '#!/bin/sh\n');
  assert.equal(driver.computerDriverPath(home, 'darwin', toolsBin), path.join(home, '.local', 'bin', 'cua-driver'), 'an older standalone copy still counts');
  mkdirSync(toolsBin, { recursive: true });
  writeFileSync(path.join(toolsBin, 'cua-driver'), '#!/bin/sh\n');
  const own = driver.computerDriverPath(home, 'darwin', toolsBin);
  assert.equal(own, path.join(toolsBin, 'cua-driver'));
  assert.ok(driver.isOwnComputerDriver(own, toolsBin));
  assert.ok(!driver.isOwnComputerDriver(path.join(home, '.local', 'bin', 'cua-driver'), toolsBin));
  const mac = resolveToolDownload(driver.COMPUTER_DRIVER_DOWNLOAD, { platform: 'darwin', arch: 'arm64' });
  assert.equal(mac?.url, `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${driver.COMPUTER_DRIVER_VERSION}/cua-driver-rs-${driver.COMPUTER_DRIVER_VERSION}-darwin-universal-binary.tar.gz`);
  assert.equal(mac?.checksumsUrl, `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${driver.COMPUTER_DRIVER_VERSION}/SHA256SUMS`);
  assert.equal(mac?.version, driver.COMPUTER_DRIVER_VERSION);
  assert.equal(mac?.archive, 'tar');
  assert.ok(resolveToolDownload(driver.COMPUTER_DRIVER_DOWNLOAD, { platform: 'linux', arch: 'x64' })?.url.endsWith('linux-x86_64-binary.tar.gz'));
  assert.ok(resolveToolDownload(driver.COMPUTER_DRIVER_DOWNLOAD, { platform: 'win32', arch: 'x64' })?.url.endsWith('windows-x86_64-binary.zip'), 'the Windows preview downloads the vendor\'s zip');
  assert.equal(resolveToolDownload(driver.COMPUTER_DRIVER_DOWNLOAD, { platform: 'win32', arch: 'x64' })?.archive, 'zip');
});

test('the driver runs embedded under the app\'s identity: a private daemon on Clem\'s socket and an MCP proxy onto it', () => {
  const serve = driver.computerDriverServeCommand('/h/tools/bin/cua-driver', '/h/state/cua-driver.sock', 'com.example.app');
  assert.deepEqual(serve, { command: '/h/tools/bin/cua-driver', args: ['serve', '--socket', '/h/state/cua-driver.sock'], env: { CUA_DRIVER_EMBEDDED: '1', CUA_DRIVER_HOST_BUNDLE_ID: 'com.example.app' } });
  const server = driver.computerDriverServer('/h/tools/bin/cua-driver', '/h/state/cua-driver.sock', 'com.example.app');
  assert.deepEqual({ name: server.name, type: server.type, args: server.args, env: server.env, enabled: server.enabled, source: server.source },
    { name: 'cua-driver', type: 'stdio', args: ['mcp', '--embedded', '--socket', '/h/state/cua-driver.sock', '--host-bundle-id', 'com.example.app'], env: { CUA_DRIVER_EMBEDDED: '1', CUA_DRIVER_HOST_BUNDLE_ID: 'com.example.app' }, enabled: true, source: 'user' });
  const win = driver.computerDriverServer('C:\\h\\tools\\bin\\cua-driver.exe', 'ignored', 'ignored', 'win32');
  assert.deepEqual(win.args, ['mcp'], 'on Windows the driver serves on its own, no embedded socket');
  assert.deepEqual(win.env, {});
  assert.equal(driver.startComputerDriverHost({ binary: null }), 'idle', 'no driver, nothing to keep alive');
  assert.equal(driver.startComputerDriverHost({ binary: '/u/.local/bin/cua-driver' }), 'idle', 'a standalone copy is not Clem\'s to run');
  assert.equal(driver.computerDriverHostState(), 'not_started');
});

test('the chat\'s live view takes the first picture in the driver\'s answer, bare or wrapped, and nothing else', () => {
  assert.deepEqual(driver.firstImageBlock([{ type: 'text', text: 'desktop' }, { type: 'image', data: 'QUJD', mimeType: 'image/png' }]), { data: 'QUJD', mimeType: 'image/png' });
  assert.deepEqual(driver.firstImageBlock({ content: [{ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }] }), { data: 'QUJD', mimeType: 'image/jpeg' });
  assert.equal(driver.firstImageBlock([{ type: 'text', text: 'no picture' }]), null);
  assert.equal(driver.firstImageBlock('text'), null);
});

test('the chat\'s live view follows the window Clem last acted in, read from the conversation\'s driver calls', () => {
  const rows = [
    { type: 'tool_called', data: { tool: 'cua-driver__list_apps', args: '{}' } },
    { type: 'tool_called', data: { tool: 'cua-driver__click', args: '{"pid":19529,"window_id":273,"x":100,"y":200}' } },
    { type: 'tool_returned', data: { tool: 'cua-driver__click' } },
    { type: 'tool_called', data: { tool: 'read_file', args: '{"pid":1,"window_id":2}' } },
  ];
  assert.deepEqual(driver.lastActedWindow(rows), { pid: 19529, windowId: 273 }, 'the newest driver call that named a window; other tools do not count');
  assert.equal(driver.lastActedWindow(rows.slice(0, 1)), null);
  assert.deepEqual(driver.lastActedWindow([{ type: 'tool_called', data: { tool: 'mcp__cua-driver__type_text', args: { pid: 7, window_id: 9, text: 'hi' } } }]), { pid: 7, windowId: 9 });
  assert.deepEqual(driver.lastActedWindow([
    { type: 'tool_called', data: { tool: 'cua-driver__run_steps', args: '{"steps":[{"tool":"hotkey","args":{"keys":["cmd","n"]}}],"observe":true,"session":"x","target":{"kind":"window","pi' } },
    { type: 'tool_returned', data: { tool: 'cua-driver__run_steps', preview: 'run_steps: 2/2 steps ok\\nwindow_id=273 pid=19529 elements=66 snapshot_id=s0000000a' } },
  ]), { pid: 19529, windowId: 273 }, 'a batch whose arguments were stored short still names its window in the answer');
});
