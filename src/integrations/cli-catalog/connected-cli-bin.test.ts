/**
 * Run: node scripts/run-tests-isolated.mjs src/integrations/cli-catalog/connected-cli-bin.test.ts
 *
 * A connected CLI runs in Clem's shell as the executable its health check
 * verified, even when a same-named package sits earlier on PATH.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-cli-bin-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { CLI_CATALOG, recordConnectedCli } = await import('./catalog.js');
const { syncConnectedCliBin } = await import('./connected-cli-bin.js');
const { connectedCliBinDir, mergedSpawnEnv } = await import('../../runtime/spawn-env.js');

function fakeCli(dir: string, says: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'gh');
  writeFileSync(file, `#!/bin/sh\necho ${says}\n`);
  chmodSync(file, 0o755);
  return file;
}

const decoy = fakeCli(path.join(TMP_HOME, 'node-bin'), 'decoy');
const verified = fakeCli(path.join(TMP_HOME, 'brew-bin'), 'verified');
recordConnectedCli(CLI_CATALOG.find((entry) => entry.id === 'github')!);

function health(authStatus: 'ok' | 'signed_out', binaryPath = verified) {
  return { github: { id: 'github', command: 'gh', installed: true, authStatus, binaryPath, checkedAt: new Date().toISOString() } };
}

function runGh(): string {
  const env = mergedSpawnEnv();
  env.PATH = env.PATH.split(path.delimiter)
    .filter((part) => part === connectedCliBinDir())
    .concat([path.dirname(decoy), path.dirname(verified), '/usr/bin', '/bin'])
    .join(path.delimiter);
  return execFileSync('/bin/sh', ['-c', 'gh'], { env, encoding: 'utf8' }).trim();
}

test('the verified binary wins over a same-named command earlier on PATH', { skip: process.platform === 'win32' }, () => {
  syncConnectedCliBin(health('ok'));
  assert.equal(runGh(), 'verified');
});

test('a signed-out CLI loses its link and the shell falls back to PATH order', { skip: process.platform === 'win32' }, () => {
  syncConnectedCliBin(health('signed_out'));
  assert.equal(existsSync(path.join(connectedCliBinDir()!, 'gh')), false);
  assert.equal(runGh(), 'decoy');
});

test('a recorded binary that is gone gets no link', { skip: process.platform === 'win32' }, () => {
  syncConnectedCliBin(health('ok', path.join(TMP_HOME, 'missing', 'gh')));
  assert.equal(existsSync(path.join(connectedCliBinDir()!, 'gh')), false);
});

test('a CLI that is not connected gets no link', { skip: process.platform === 'win32' }, () => {
  writeFileSync(path.join(TMP_HOME, 'state', 'connected-clis.json'), JSON.stringify({ version: 'v1', entries: {} }));
  syncConnectedCliBin(health('ok'));
  assert.equal(existsSync(path.join(connectedCliBinDir()!, 'gh')), false);
});
