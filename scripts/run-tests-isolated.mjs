#!/usr/bin/env node

/**
 * Run the repository test suite behind a process-wide disposable Clementine
 * home. Individual test files still create narrower fixtures when useful, but
 * static ESM imports execute before a file's top-level environment assignment;
 * without this outer boundary an early config import can accidentally bind a
 * test to ~/.clementine-next and create backups/caches in real user state.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createIsolatedRunnerProgressTracker,
  isolatedTestArgs,
} from './run-tests-isolated-args.mjs';
import {
  compareLiveHome,
  liveHomeOwnerPids,
  realUserHome as sentinelRealUserHome,
  snapshotLiveHome,
} from './live-home-sentinel.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testHome = mkdtempSync(path.join(os.tmpdir(), 'clementine-test-home-'));
const testTmp = path.join(testHome, 'tmp');
// Per-process homes are minted UNDER this root by the preload rather than
// shared from here — see test-isolation-preload.mjs. Keeping the root inside
// testHome means the existing teardown removes every one of them.
const testHomeRoot = path.join(testHome, 'homes');
mkdirSync(testTmp, { recursive: true });
mkdirSync(testHomeRoot, { recursive: true });
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const forwarded = process.argv.slice(2);
const args = isolatedTestArgs(forwarded);

const realUserHome = sentinelRealUserHome();
const liveHome = path.resolve(path.join(realUserHome, '.clementine-next'));
const liveHomeBefore = snapshotLiveHome(liveHome);
// Sampled before any test process exists, so an escaped test can never appear
// as an owner and excuse its own writes.
const liveHomeOwners = liveHomeOwnerPids(liveHome);
const testEnv = { ...process.env };
for (const key of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'BROWSER_USE_API_KEY',
  'BYO_MODEL_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CODEX_API_KEY',
  'CODEX_AUTH_SOURCE_FILE',
  'CODEX_HOME',
  'COMPOSIO_API_KEY',
  'DISCORD_BOT_TOKEN',
  'OPENAI_API_KEY',
  'RECALL_API_KEY',
  'SLACK_APP_TOKEN',
  'SLACK_BOT_TOKEN',
  'WEBHOOK_SECRET',
]) {
  delete testEnv[key];
}
// An inherited home silently defeats per-process minting — the case that finds
// it is an isolated run nested inside another isolated run.
delete testEnv.CLEMENTINE_HOME;

function fileBudgetMs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith('--test-timeout=')) {
      const value = Number(argument.slice('--test-timeout='.length));
      if (Number.isFinite(value) && value > 0) return value;
    }
    if (argument === '--test-timeout') {
      const value = Number(argv[index + 1]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return 600_000;
}

function killProcessTree(pid, signal = 'SIGKILL') {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

function collectDescendantPids(pid) {
  if (!pid) return [];
  const seen = new Set();
  const walk = (parent) => {
    const listing = spawnSync('pgrep', ['-P', String(parent)], { encoding: 'utf8' });
    if (listing.status !== 0 || !listing.stdout) return;
    for (const line of listing.stdout.split(/\s+/)) {
      const child = Number(line.trim());
      if (!Number.isInteger(child) || child <= 0 || seen.has(child)) continue;
      seen.add(child);
      walk(child);
    }
  };
  walk(pid);
  return [...seen];
}

let exitCode = 1;
const childEnv = {
  ...testEnv,
  HOME: testHome,
  USERPROFILE: testHome,
  TMPDIR: testTmp,
  TMP: testTmp,
  TEMP: testTmp,
  // Deliberately NOT CLEMENTINE_HOME (and it is deleted from testEnv above):
  // pinning one home here disables the preload's per-process minting, and
  // concurrent test files then contend on the same databases.
  CLEMMY_TEST_HOME_ROOT: testHomeRoot,
  CLEMMY_REAL_USER_HOME: realUserHome,
  CLEMMY_TEST_ISOLATED_HOME: '1',
  CLEMMY_TEST_DISABLE_LIVE_MODELS: '1',
  CLEMMY_LOCAL_EMBEDDINGS: 'off',
  OPENAI_AGENTS_DISABLE_TRACING: '1',
  CLEMMY_AUTHORITY_SEAL_KEY: testEnv.CLEMMY_AUTHORITY_SEAL_KEY || 'ab'.repeat(32),
};

try {
  const budgetMs = fileBudgetMs(args);
  const child = spawn(tsxBin, args, {
    cwd: repoRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const groupPid = child.pid;
  const progress = createIsolatedRunnerProgressTracker();
  const partialLines = { stdout: '', stderr: '' };
  let watchdogFired = false;

  const onChunk = (chunk, dest, source) => {
    dest.write(chunk);
    const text = partialLines[source] + String(chunk);
    const lines = text.split(/\r?\n/);
    partialLines[source] = lines.pop() ?? '';
    for (const line of lines) {
      progress.observe(line, Date.now(), { allowTap: source === 'stdout' });
    }
  };
  child.stdout?.on('data', (chunk) => onChunk(chunk, process.stdout, 'stdout'));
  child.stderr?.on('data', (chunk) => onChunk(chunk, process.stderr, 'stderr'));

  const watchdog = setInterval(() => {
    if (watchdogFired) return;
    const { currentFile, lastProgress, lastProgressAt } = progress.snapshot();
    if (Date.now() - lastProgressAt <= budgetMs + 15_000) return;
    watchdogFired = true;
    const descendants = collectDescendantPids(groupPid);
    console.error(
      `watchdog: owning file=${currentFile} last progress=${lastProgress} pid=${groupPid} descendants=${descendants.join(',') || 'none'} exceeded ${budgetMs}ms; terminating children`,
    );
    killProcessTree(groupPid, 'SIGTERM');
    setTimeout(() => killProcessTree(groupPid, 'SIGKILL'), 2_000);
  }, 1_000);
  watchdog.unref?.();

  const cleanupChildren = () => {
    clearInterval(watchdog);
    killProcessTree(groupPid, 'SIGKILL');
  };
  process.once('exit', cleanupChildren);
  process.once('SIGINT', () => {
    cleanupChildren();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    cleanupChildren();
    process.exit(143);
  });

  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearInterval(watchdog);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
  exitCode = watchdogFired && status === 0 ? 1 : status;
  killProcessTree(groupPid, 'SIGKILL');
} finally {
  rmSync(testHome, { recursive: true, force: true });
}

const liveHomeAfter = snapshotLiveHome(liveHome);
const sentinel = compareLiveHome(liveHomeBefore, liveHomeAfter, liveHomeOwners);
if (!sentinel.performed) {
  console.error(
    `isolated runner sentinel: NOT PERFORMED — a live daemon (pid ${sentinel.ownerPids.join(', ')}) owns this home and writes every path in the snapshot.`
    + (sentinel.attributed.length > 0 ? ` Changed while it ran: ${sentinel.attributed.join(', ')}.` : ' Nothing changed.')
    + ' Stop the daemon to get the isolation proof; CI runs without one.',
  );
}
if (!sentinel.ok) {
  console.error(`isolated runner sentinel: live Clementine ${sentinel.violations.join(', ')} changed`);
  console.error(JSON.stringify({ liveHome, before: liveHomeBefore, after: liveHomeAfter }, null, 2));
  exitCode = exitCode === 0 ? 1 : exitCode;
}

process.exitCode = exitCode;
