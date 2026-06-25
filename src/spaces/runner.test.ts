/**
 * Run: npx tsx --test src/spaces/runner.test.ts
 *
 * Guards the spaces runner's spawn/env contract — the seam that broke every
 * runner-backed space in the packaged app (process.execPath = Electron without
 * ELECTRON_RUN_AS_NODE → GUI launch → empty stdout). Round-trips real runners
 * through runSpaceDataSource and asserts the child env: flag set for node
 * runners (NOT for sh), augmented PATH, locale baseline, slug, stdin payload,
 * and — critically — that the daemon's secrets are NOT leaked into agent code.
 * Temp CLEMENTINE_HOME so the real instance is untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-runner-test-'));

const runner = await import('./runner.js');
const store = await import('./store.js');

function writeRunner(slug: string, file: string, body: string, exec = false): void {
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, file);
  writeFileSync(p, body, 'utf-8');
  if (exec) chmodSync(p, 0o755);
}

const hasPython = (() => {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

// A node runner that echoes its own env + the stdin payload back as JSON.
const ENV_ECHO_MJS = `
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const p = (() => { try { return JSON.parse(input || '{}'); } catch { return {}; } })();
  process.stdout.write(JSON.stringify({
    electron: process.env.ELECTRON_RUN_AS_NODE ?? null,
    slug: process.env.CLEMENTINE_SPACE_SLUG ?? null,
    lang: process.env.LANG ?? null,
    pathHasWellKnown: (process.env.PATH || '').split(':').some((d) => d === '/usr/local/bin' || d === '/opt/homebrew/bin'),
    sawSecret: process.env.SPACE_TEST_SECRET ?? null,
    payloadSlug: p.slug ?? null,
    payloadRunner: p.runner ?? null,
  }));
});
`;

test('node (.mjs) runner: ELECTRON_RUN_AS_NODE set, PATH augmented, secrets scrubbed, stdin round-trips', async () => {
  const slug = 'env-node';
  writeRunner(slug, 'echo.mjs', ENV_ECHO_MJS);
  // A daemon secret present at spawn time MUST NOT reach agent-authored code.
  process.env.SPACE_TEST_SECRET = 'leak-canary';
  try {
    const res = await runner.runSpaceDataSource(slug, { id: 'contacts', runner: 'echo.mjs' });
    assert.equal(res.ok, true, res.ok ? '' : (res as { error: string }).error);
    const d = (res as { data: Record<string, unknown> }).data;
    assert.equal(d.electron, '1', 'ELECTRON_RUN_AS_NODE must be 1 for a node runner');
    assert.equal(d.slug, slug);
    assert.equal(d.payloadSlug, slug, 'stdin JSON payload must round-trip');
    assert.equal(d.payloadRunner, 'echo.mjs', 'stdin JSON payload must include runner identity');
    assert.equal(d.pathHasWellKnown, true, 'PATH must be augmented with the well-known bin dirs');
    assert.ok(d.lang, 'LANG baseline must be set');
    assert.equal(d.sawSecret, null, 'daemon secret env must NOT leak into the runner');
  } finally {
    delete process.env.SPACE_TEST_SECRET;
  }
});

test('runner stdin identity cannot be overridden by dry-run payload extras', async () => {
  const slug = 'payload-identity';
  writeRunner(slug, 'echo.mjs', ENV_ECHO_MJS);

  const res = await runner.runScript(slug, 'echo.mjs', {
    slug: '../other-space',
    runner: '../view/evil.mjs',
    customInput: true,
  });

  assert.equal(res.ok, true, res.ok ? '' : (res as { error: string }).error);
  const d = (res as { data: Record<string, unknown> }).data;
  assert.equal(d.slug, slug);
  assert.equal(d.payloadSlug, slug);
  assert.equal(d.payloadRunner, 'echo.mjs');
});

test('shell (.sh) runner: works and does NOT get ELECTRON_RUN_AS_NODE', async () => {
  const slug = 'env-sh';
  writeRunner(slug, 'echo.sh', `#!/bin/bash\nprintf '{"electron":"%s","slug":"%s"}' "\${ELECTRON_RUN_AS_NODE:-}" "$CLEMENTINE_SPACE_SLUG"\n`);
  const res = await runner.runSpaceDataSource(slug, { id: 'contacts', runner: 'echo.sh' });
  assert.equal(res.ok, true, res.ok ? '' : (res as { error: string }).error);
  const d = (res as { data: Record<string, unknown> }).data;
  assert.equal(d.electron, '', 'ELECTRON_RUN_AS_NODE must NOT be set for a shell runner');
  assert.equal(d.slug, slug);
});

test('python (.py) runner: resolves python3 on the augmented PATH and yields JSON', { skip: !hasPython }, async () => {
  const slug = 'env-py';
  writeRunner(slug, 'echo.py', `import json,os\nprint(json.dumps({"slug": os.environ.get("CLEMENTINE_SPACE_SLUG"), "rows": [1,2]}))\n`);
  const res = await runner.runSpaceDataSource(slug, { id: 'contacts', runner: 'echo.py' });
  assert.equal(res.ok, true, res.ok ? '' : (res as { error: string }).error);
  const d = (res as { data: Record<string, unknown> }).data;
  assert.equal(d.slug, slug);
  assert.deepEqual(d.rows, [1, 2]);
});

test('runner that prints non-JSON → clear error (not a crash)', async () => {
  const slug = 'bad-json';
  writeRunner(slug, 'r.mjs', `process.stdout.write('not json at all');`);
  const res = await runner.runSpaceDataSource(slug, { id: 'contacts', runner: 'r.mjs' });
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /not valid JSON/);
});

test('refreshSpaceData refuses malformed hand-written manifest JSON before running sources', async () => {
  const slug = 'bad-manifest-refresh';
  const dir = store.resolveSpaceDir(slug);
  mkdirSync(path.join(dir, 'data'), { recursive: true });
  writeFileSync(path.join(dir, 'data', 'r.mjs'), `process.stdout.write(JSON.stringify({rows:[1]}));`, 'utf-8');
  writeFileSync(path.join(dir, 'space.json'), JSON.stringify({
    id: slug,
    title: 'Bad Manifest Refresh',
    dataSources: [{ id: 'pull', runner: 'r.mjs', composio_args_json: '{not json' }],
  }), 'utf-8');

  const res = await runner.refreshSpaceData(slug, 'pull');
  assert.equal(res[0].ok, false);
  assert.match(res[0].error ?? '', /workspace manifest is invalid/);
  assert.match(res[0].error ?? '', /composio_args_json is not valid JSON/);
});

test('runner that prints nothing (exit 0) → "produced no output"', async () => {
  const slug = 'no-output';
  writeRunner(slug, 'r.mjs', `process.exit(0);`);
  const res = await runner.runSpaceDataSource(slug, { id: 'contacts', runner: 'r.mjs' });
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /produced no output/);
});

test('runner that exits non-zero → surfaces stderr', async () => {
  const slug = 'nonzero';
  writeRunner(slug, 'r.mjs', `process.stderr.write('boom happened'); process.exit(3);`);
  const res = await runner.runSpaceDataSource(slug, { id: 'contacts', runner: 'r.mjs' });
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /exited 3/);
  assert.match((res as { error: string }).error, /boom happened/);
});

test('unsupported extension → actionable error', async () => {
  const slug = 'bad-ext';
  writeRunner(slug, 'data.txt', `whatever`);
  const res = await runner.runSpaceDataSource(slug, { id: 'contacts', runner: 'data.txt' });
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /unsupported runner extension/);
});

test('runner path traversal is refused even if the target file exists inside the workspace', async () => {
  const slug = 'runner-path-traversal';
  const viewDir = store.resolveInSpace(slug, 'view');
  mkdirSync(viewDir, { recursive: true });
  writeFileSync(path.join(viewDir, 'evil.mjs'), `process.stdout.write(JSON.stringify({ran:true}));`, 'utf-8');

  const res = await runner.runSpaceDataSource(slug, { id: 'contacts', runner: '../view/evil.mjs' });

  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /runner must be a filename under data\//);
});
