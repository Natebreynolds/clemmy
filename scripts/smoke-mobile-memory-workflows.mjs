#!/usr/bin/env node
// Memory + Workflows smoke. Boots `clementine service` against a fresh
// CLEMENTINE_HOME, seeds a fact + a tiny workflow file, then exercises
// the new mobile endpoints:
//
//   1. Memory facts
//      a. GET /m/api/memory/facts                → seeded fact returned
//      b. GET /m/api/memory/facts?kind=user      → filter works
//      c. GET /m/api/memory/search?q=…           → 200 (may be empty without index)
//   2. Workflows
//      a. GET /m/api/workflows                   → list contains our workflow
//      b. POST /m/api/workflows/<name>/run       → 200 with runId, run file
//                                                  appears under WORKFLOW_RUNS_DIR
//      c. GET /m/api/workflows/<name>/runs       → list contains our run
//      d. POST without cookie                    → 401
//
// Auth gates checked at each step.
//
// Run: npm run build && node scripts/smoke-mobile-memory-workflows.mjs

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, cpSync, symlinkSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DAEMON_DIST = path.join(REPO_ROOT, 'dist');

if (!existsSync(path.join(DAEMON_DIST, 'index.js'))) {
  console.error('✗ dist/ not built. Run: npm run build');
  process.exit(2);
}

let exitCode = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.error(`  ✗ ${m}`); exitCode = 1; };

console.log('Clementine mobile memory+workflows smoke');

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mw-smoke-'));
const tmpCwd = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mw-smoke-cwd-'));
const homeBase = path.join(tmpHome, '.clementine-next');
const stateDir = path.join(homeBase, 'state');
// Workflows definitions live under <home>/vault/00-System/workflows.
// Their RUN records live separately under <home>/workflows/runs.
const workflowsDir = path.join(homeBase, 'vault', '00-System', 'workflows');
mkdirSync(stateDir, { recursive: true });
mkdirSync(workflowsDir, { recursive: true });

const TOKEN = 'mw-smoke-' + Math.random().toString(36).slice(2, 12);
writeFileSync(
  path.join(stateDir, 'secrets-vault.json'),
  JSON.stringify({ version: 'v1', entries: { openai_api_key: 'sk-fake', webhook_secret: TOKEN } }, null, 2),
  { mode: 0o600 },
);
writeFileSync(
  path.join(stateDir, 'setup-complete.json'),
  JSON.stringify({
    completedAt: new Date().toISOString(),
    version: 'v1',
    configured: { auth: 'openai', discord: false, composio: false, workspaceCount: 0, profileSet: false },
  }),
);

// Seed a workflow as a directory + SKILL.md (the preferred layout —
// the daemon's migration would do the same to a flat file but writing
// the canonical layout directly avoids any migration-timing edge).
const workflowName = 'smoke-flow';
const workflowDir = path.join(workflowsDir, workflowName);
mkdirSync(workflowDir, { recursive: true });
writeFileSync(
  path.join(workflowDir, 'SKILL.md'),
  [
    '---',
    `name: ${workflowName}`,
    'description: Smoke-test workflow that does nothing.',
    'enabled: true',
    'steps:',
    '  - id: step1',
    '---',
    '',
    '## step: step1',
    'noop',
    '',
  ].join('\n'),
);

const PORT = 10800 + Math.floor(Math.random() * 200);

const stagedRoot = path.join(tmpHome, 'daemon-stage');
const stagedDist = path.join(stagedRoot, 'dist');
mkdirSync(stagedRoot, { recursive: true });
cpSync(DAEMON_DIST, stagedDist, { recursive: true });
writeFileSync(path.join(stagedRoot, 'package.json'), readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(stagedRoot, 'node_modules'));

const child = spawn(process.execPath, [path.join(stagedDist, 'index.js'), 'service'], {
  cwd: tmpCwd,
  env: {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TERM: process.env.TERM ?? 'xterm-256color',
    HOME: tmpHome,
    CLEMENTINE_HOME: homeBase,
    WEBHOOK_PORT: String(PORT),
    WEBHOOK_ENABLED: 'true',
    DISCORD_ENABLED: 'false',
    NODE_ENV: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (b) => { stderr += String(b); });

const baseUrl = `http://127.0.0.1:${PORT}`;

async function tcpProbe() {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port: PORT });
    const settle = (r) => { try { sock.destroy(); } catch { /* noop */ } resolve(r); };
    sock.once('connect', () => settle(true));
    sock.once('error', () => settle(false));
    setTimeout(() => settle(false), 1000);
  });
}
async function waitForReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    if (await tcpProbe()) {
      try {
        const res = await fetch(`${baseUrl}/api/status`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) return true;
      } catch { /* still booting */ }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

process.on('exit', () => {
  try { child.kill('SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 1500);
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* best effort */ }
});

if (!(await waitForReady())) {
  console.error('  ✗ daemon did not become ready');
  console.error('--- stderr ---\n' + stderr);
  process.exit(1);
}
ok('daemon booted');

// PIN + login.
{
  const seed = spawnSync(process.execPath, [path.join(stagedDist, 'index.js'), 'mobile', 'set-pin', '--pin', 'SmokeTest-2024'], {
    env: { PATH: process.env.PATH, HOME: tmpHome, CLEMENTINE_HOME: homeBase },
    stdio: 'pipe',
  });
  if (seed.status !== 0) { fail('set-pin failed'); process.exit(1); }
  ok('PIN seeded');
}
let cookie = '';
{
  const res = await fetch(`${baseUrl}/m/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: 'SmokeTest-2024' }),
  });
  const sc = res.headers.get('set-cookie') ?? '';
  if (res.status === 200 && /clem_mobile_session=/.test(sc)) {
    cookie = sc.split(';')[0];
    ok('cookie issued');
  } else { fail(`login failed: ${res.status}`); process.exit(1); }
}

// Seed a fact via the in-process facts helper (same pattern as the chat smoke).
const seedFactsScript = `
import('${path.join(stagedDist, 'memory/facts.js').replace(/'/g, "\\'")}').then((m) => {
  if (typeof m.rememberFact === 'function') {
    m.rememberFact({
      kind: 'user',
      content: 'Smoke-test fact about Clementine mobile.',
      score: 0.9,
      source: { sessionId: null, path: null },
    });
  } else if (typeof m.upsertConsolidatedFact === 'function') {
    m.upsertConsolidatedFact({
      kind: 'user',
      content: 'Smoke-test fact about Clementine mobile.',
      score: 0.9,
      source: { sessionId: null, path: null },
    });
  } else {
    // older API name
    m.insertFact?.({ kind: 'user', content: 'Smoke-test fact about Clementine mobile.', score: 0.9 });
  }
  console.log('OK');
});`;
const seedFactsFile = path.join(tmpHome, 'seed-facts.mjs');
writeFileSync(seedFactsFile, seedFactsScript);
const seedRun = spawnSync(process.execPath, [seedFactsFile], {
  env: {
    PATH: process.env.PATH,
    HOME: tmpHome,
    CLEMENTINE_HOME: homeBase,
    NODE_PATH: path.join(REPO_ROOT, 'node_modules'),
  },
  stdio: 'pipe',
});
if (seedRun.status !== 0) {
  console.log('  • fact-seeding via in-process helper failed; continuing without it');
  console.log('    ' + (seedRun.stderr?.toString() ?? '').slice(0, 200));
}

// 1a. Facts list.
{
  const res = await fetch(`${baseUrl}/m/api/memory/facts?limit=40`, { headers: { cookie } });
  if (!res.ok) { fail(`facts returned ${res.status}: ${(await res.text()).slice(0, 300)}`); }
  else {
    const body = await res.json();
    const found = Array.isArray(body.facts)
      && body.facts.some((fact) => typeof fact.content === 'string' && fact.content.includes('Clementine mobile'));
    if (found) ok('facts list returned the seeded mobile fact');
    else fail(`facts shape wrong: ${JSON.stringify(body).slice(0, 200)}`);
  }
}

// 1b. Facts filter.
{
  const res = await fetch(`${baseUrl}/m/api/memory/facts?kind=user`, { headers: { cookie } });
  if (!res.ok) { fail(`filtered facts returned ${res.status}: ${(await res.text()).slice(0, 300)}`); }
  else {
    const body = await res.json();
    const onlyUser = body.facts.every((f) => f.kind === 'user');
    if (onlyUser) ok('facts?kind=user only returns user-kind facts');
    else fail('filter leaked non-user facts');
  }
}

// 1c. Memory search — empty query short-circuits.
{
  const res = await fetch(`${baseUrl}/m/api/memory/search?q=`, { headers: { cookie } });
  if (res.ok) {
    const body = await res.json();
    if (Array.isArray(body.hits) && body.hits.length === 0) ok('empty query returns empty hits');
    else fail(`expected empty hits, got ${JSON.stringify(body).slice(0, 120)}`);
  } else fail(`empty search returned ${res.status}`);
}
{
  const res = await fetch(`${baseUrl}/m/api/memory/search?q=smoke`, { headers: { cookie } });
  if (res.ok) ok('non-empty search returns 200 (hit count may be 0 if vault not indexed)');
  else fail(`non-empty search returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// 2a. Workflows list.
{
  const res = await fetch(`${baseUrl}/m/api/workflows`, { headers: { cookie } });
  if (!res.ok) { fail(`workflows returned ${res.status}`); }
  else {
    const body = await res.json();
    const match = body.workflows.find((w) => w.name === workflowName);
    if (match && match.enabled && match.requiresInput === false) {
      ok(`workflows list contains "${workflowName}" (enabled, no input required)`);
    } else {
      fail(`workflow not found in list or wrong shape: ${JSON.stringify(body).slice(0, 200)}`);
    }
  }
}

// 2b. Trigger a run.
let triggeredRunId = '';
{
  const res = await fetch(`${baseUrl}/m/api/workflows/${workflowName}/run`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) { fail(`run trigger returned ${res.status}: ${await res.text()}`); }
  else {
    const body = await res.json();
    if (body.ok && body.runId && body.status === 'queued') {
      triggeredRunId = body.runId;
      ok(`run queued with id ${triggeredRunId}`);
    } else { fail(`run shape wrong: ${JSON.stringify(body)}`); }
  }
}

// 2b-verify: a JSON record landed in WORKFLOW_RUNS_DIR.
if (triggeredRunId) {
  // Run records — different directory from definitions (see
  // src/tools/shared.ts:48 vs src/memory/vault.ts:18).
  const runsDir = path.join(homeBase, 'workflows', 'runs');
  const files = existsSync(runsDir) ? readdirSync(runsDir) : [];
  const file = files.find((f) => f === `${triggeredRunId}.json`);
  if (file) ok(`run file persisted at ${runsDir}/${file}`);
  else fail(`expected ${triggeredRunId}.json in ${runsDir}, found: ${files.join(', ')}`);
}

// 2c. List runs.
{
  const res = await fetch(`${baseUrl}/m/api/workflows/${workflowName}/runs`, { headers: { cookie } });
  if (!res.ok) { fail(`runs returned ${res.status}`); }
  else {
    const body = await res.json();
    const match = body.runs.find((r) => r.id === triggeredRunId);
    if (match) ok('runs list contains the triggered run');
    else fail(`run ${triggeredRunId} missing from list: ${JSON.stringify(body)}`);
  }
}

// 2d. Without cookie → 401.
{
  const res = await fetch(`${baseUrl}/m/api/workflows`);
  if (res.status === 401) ok('workflows without cookie → 401');
  else fail(`expected 401, got ${res.status}`);
}

console.log(exitCode === 0 ? '\nAll memory+workflows checks passed.' : '\nSmoke FAILED.');
process.exit(exitCode);
