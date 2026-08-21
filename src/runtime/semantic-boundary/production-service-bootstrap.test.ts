/** Run: npx tsx --test src/runtime/semantic-boundary/production-service-bootstrap.test.ts */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';



const CHILD = new URL('./production-service-bootstrap-child.mts', import.meta.url).pathname;
const CREDENTIAL_KEY = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTHORIZATION|COMPOSIO|OPENAI|ANTHROPIC|XAI|SLACK|DISCORD|WEBHOOK|API_KEY)/i;

function scrubbedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (CREDENTIAL_KEY.test(key)) continue;
    if (key.startsWith('CLEMENTINE_') || key.startsWith('CLEM_') || key.startsWith('CLEMMY_')) continue;
    env[key] = value;
  }
  return {
    ...env,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: os.tmpdir(),
    CLEMENTINE_HOME: home,
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    NO_PROXY: '',
    no_proxy: '',
  };
}

test('isolated full service bootstrap installs the production catalog without fixtures or network', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-prod-service-'));
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD, home], {
      env: scrubbedEnv(home),
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.resolve(path.dirname(CHILD), '../../..'),
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    const code = await new Promise<number | null>((resolve) => {
      child.on('exit', (exitCode) => resolve(exitCode));
    });
    assert.equal(code, 0, stderr || stdout);
    const line = stdout.split('\n').find((entry) => entry.startsWith('BOOTSTRAP_RESULT '));
    assert.ok(line, `missing bootstrap result: ${stdout}\n${stderr}`);
    const payload = JSON.parse(line.slice('BOOTSTRAP_RESULT '.length)) as {
      catalogIds: string[];
      manifestIds: string[];
      portCount: number;
      destinationHasReconcile: boolean;
      everyManifestBacked: boolean;
    };
    // Built-in beta pack cannot populate an executable catalog without a
    // registered live observer. Manifest rows may exist; invoke entries must not.
    assert.deepEqual(payload.catalogIds, []);
    assert.equal(payload.destinationHasReconcile, false);
    assert.ok(payload.manifestIds.length === 0 || payload.catalogIds.length === 0, JSON.stringify(payload));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
