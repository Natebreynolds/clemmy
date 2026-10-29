/** Run: node scripts/run-tests-isolated.mjs src/integrations/other-apps-connect.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-other-apps-'));
const other = await import('./other-apps-connect.js');

const scratch = () => mkdtempSync(path.join(os.tmpdir(), 'clem-other-apps-home-'));

test('the launch comes from this installation: the app runs the compiled entry as Node, in the same home', () => {
  const dir = scratch();
  assert.equal(other.clemMcpConnection({ entry: path.join(dir, 'missing.js') }), null, 'a source checkout has no entry to hand out');
  const entry = path.join(dir, 'mcp.js');
  writeFileSync(entry, '');
  assert.deepEqual(other.clemMcpConnection({ entry, execPath: '/Apps/Clementine.app/Contents/MacOS/Clementine', runsInsideApp: true, home: '/h/.clem' }),
    { command: '/Apps/Clementine.app/Contents/MacOS/Clementine', args: [entry], env: { ELECTRON_RUN_AS_NODE: '1', CLEMENTINE_HOME: '/h/.clem' } });
  assert.deepEqual(other.clemMcpConnection({ entry, execPath: '/usr/bin/node', runsInsideApp: false, home: '/h/.clem' })!.env, { CLEMENTINE_HOME: '/h/.clem' });
});

test('each app\'s settings live where that app keeps them on each system', () => {
  const byId = (platform: NodeJS.Platform) => Object.fromEntries(other.otherApps(platform, '/u', 'C:\\Users\\u\\AppData\\Roaming').map((app) => [app.id, app.settingsFile]));
  assert.equal(byId('darwin')['claude-desktop'], '/u/Library/Application Support/Claude/claude_desktop_config.json');
  assert.equal(byId('linux')['claude-desktop'], '/u/.config/Claude/claude_desktop_config.json');
  assert.match(byId('win32')['claude-desktop']!, /AppData.Roaming.Claude.claude_desktop_config\.json$/);
  assert.equal(byId('darwin').cursor, '/u/.cursor/mcp.json');
});

test('connecting adds only Clementine, keeps the app\'s other servers and a copy of the original; disconnecting takes only her out', () => {
  const home = scratch();
  const [claude] = other.otherApps('darwin', home);
  const connection = { command: '/app/Clementine', args: ['/app/daemon/dist/cli/mcp.js'], env: { ELECTRON_RUN_AS_NODE: '1', CLEMENTINE_HOME: '/h' } };
  assert.equal(other.otherAppState(claude!, connection), 'not_installed');
  assert.equal(other.connectOtherApp(claude!, connection).ok, false, 'never creates an app that is not there');
  mkdirSync(claude!.folder, { recursive: true });
  assert.equal(other.otherAppState(claude!, connection), 'not_connected');
  const original = { theme: 'dark', mcpServers: { files: { command: 'files-server', args: [] } } };
  writeFileSync(claude!.settingsFile, JSON.stringify(original));
  assert.deepEqual(other.connectOtherApp(claude!, connection), { ok: true });
  const written = JSON.parse(readFileSync(claude!.settingsFile, 'utf8'));
  assert.equal(written.theme, 'dark');
  assert.deepEqual(written.mcpServers.files, original.mcpServers.files);
  assert.deepEqual(written.mcpServers.clementine, connection);
  assert.deepEqual(JSON.parse(readFileSync(`${claude!.settingsFile}.before-clementine`, 'utf8')), original);
  assert.equal(other.otherAppState(claude!, connection), 'connected');
  // The app moved: the entry is there but launches the old place.
  assert.equal(other.otherAppState(claude!, { ...connection, command: '/elsewhere/Clementine' }), 'needs_update');
  assert.deepEqual(other.disconnectOtherApp(claude!), { ok: true });
  const after = JSON.parse(readFileSync(claude!.settingsFile, 'utf8'));
  assert.deepEqual(after, original);
  assert.equal(other.otherAppState(claude!, connection), 'not_connected');
});

test('a settings file that does not read as JSON is left exactly as it was', () => {
  const home = scratch();
  const [, cursor] = other.otherApps('darwin', home);
  mkdirSync(cursor!.folder, { recursive: true });
  writeFileSync(cursor!.settingsFile, '{ "mcpServers": { // a comment the owner wrote');
  const connection = { command: '/app/Clementine', args: ['/e.js'], env: { CLEMENTINE_HOME: '/h' } };
  assert.equal(other.otherAppState(cursor!, connection), 'unreadable');
  const refused = other.connectOtherApp(cursor!, connection);
  assert.equal(refused.ok, false);
  assert.match((refused as { reason: string }).reason, /left as it is/);
  assert.equal(readFileSync(cursor!.settingsFile, 'utf8'), '{ "mcpServers": { // a comment the owner wrote');
  assert.equal(existsSync(`${cursor!.settingsFile}.before-clementine`), false);
});
