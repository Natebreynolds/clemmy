import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MCP_SERVERS_FILE, BASE_DIR } from '../config.js';
import { computerDriverIsTheBrowserNow, mcpServersFilePath } from './computer-driver-presence.js';

test('the presence leaf names the same MCP servers file as config', () => {
  assert.equal(mcpServersFilePath(BASE_DIR), MCP_SERVERS_FILE);
});

test('the driver is the browser only when Clem\'s own copy exists and its record is on', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-driver-presence-'));
  try {
    const env = { CLEMENTINE_HOME: home } as NodeJS.ProcessEnv;
    assert.equal(computerDriverIsTheBrowserNow({ home, env, platform: 'darwin' }), false, 'nothing installed');
    mkdirSync(path.join(home, 'tools', 'bin'), { recursive: true });
    writeFileSync(path.join(home, 'tools', 'bin', 'cua-driver'), '', 'utf8');
    assert.equal(computerDriverIsTheBrowserNow({ home, env, platform: 'darwin' }), false, 'installed but not registered');
    mkdirSync(path.join(home, 'mcp'), { recursive: true });
    const record = { command: path.join(home, 'tools', 'bin', 'cua-driver'), args: ['mcp', '--embedded'], enabled: true };
    writeFileSync(path.join(home, 'mcp', 'servers.json'), JSON.stringify({ 'cua-driver': record }), 'utf8');
    assert.equal(computerDriverIsTheBrowserNow({ home, env, platform: 'darwin' }), true, 'installed and on');
    writeFileSync(path.join(home, 'mcp', 'servers.json'), JSON.stringify({ 'cua-driver': { ...record, enabled: false } }), 'utf8');
    assert.equal(computerDriverIsTheBrowserNow({ home, env, platform: 'darwin' }), false, 'switched off');
    assert.equal(computerDriverIsTheBrowserNow({ home, env: { ...env, CLEMMY_COMPUTER_IS_THE_BROWSER: '1' }, platform: 'darwin' }), true, 'override on');
    writeFileSync(path.join(home, 'mcp', 'servers.json'), '{not json', 'utf8');
    assert.equal(computerDriverIsTheBrowserNow({ home, env, platform: 'darwin' }), false, 'a broken file reads as off');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
