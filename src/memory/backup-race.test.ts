/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/backup-race.test.ts
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = path.join(repoRoot, 'src/memory/backup-race.fixture.ts');

type BackupResult = {
  pid: number;
  result: null | {
    backupPath: string;
    bytes: number;
    reused: boolean;
  };
};

function fixtureEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLEMENTINE_HOME: home,
    CLEMMY_TEST_ISOLATED_HOME: '1',
  };
}

function initialize(home: string): void {
  const result = spawnSync(process.execPath, ['--import', 'tsx', fixture, 'init'], {
    cwd: repoRoot,
    env: fixtureEnv(home),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function spawnBackup(home: string, localDayKey: string, retain = 7): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ['--import', 'tsx', fixture, 'backup', localDayKey, String(retain)],
    { cwd: repoRoot, env: fixtureEnv(home), stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

function spawnUnkeyedBackup(home: string, retain = 7): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ['--import', 'tsx', fixture, 'backup-unkeyed', String(retain)],
    { cwd: repoRoot, env: fixtureEnv(home), stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

async function completion(child: ChildProcessWithoutNullStreams, timeoutMs = 30_000): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`backup fixture timed out; stdout=${stdout}; stderr=${stderr}`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function waitForLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  child.stdout.setEncoding('utf8');
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${expected}; stdout=${stdout}`)), 10_000);
    const onData = (chunk: string) => {
      stdout += chunk;
      if (stdout.includes(expected)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (!stdout.includes(expected)) {
        clearTimeout(timer);
        reject(new Error(`lock holder exited before marker: code=${code} signal=${signal}; stdout=${stdout}`));
      }
    });
  });
}

function publishedSnapshots(home: string): string[] {
  const dir = path.join(home, 'state', 'backups');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith('memory-') && name.endsWith('.db'))
    .sort();
}

test('same local-day backup has one cross-process winner and every loser reuses it', { timeout: 40_000 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-memory-backup-race-'));
  initialize(home);

  const children = Array.from({ length: 6 }, () => spawnBackup(home, '2026-08-25'));
  const completions = await Promise.all(children.map((child) => completion(child)));
  for (const result of completions) assert.equal(result.code, 0, result.stderr || result.stdout);

  const results = completions.map((result) => JSON.parse(result.stdout.trim()) as BackupResult);
  assert.equal(results.every((entry) => entry.result !== null), true, 'contending callers never soft-fail');
  assert.equal(new Set(results.map((entry) => entry.result!.backupPath)).size, 1, 'all callers report the same snapshot');
  assert.equal(results.filter((entry) => entry.result!.reused === false).length, 1, 'exactly one process publishes');
  assert.equal(results.filter((entry) => entry.result!.reused === true).length, 5, 'every loser reports reuse');
  assert.equal(results.every((entry) => entry.result!.bytes > 0), true);
  assert.deepEqual(publishedSnapshots(home), [path.basename(results[0]!.result!.backupPath)]);
});

test('SIGKILL releases the coordinator and a waiting restart publishes without a duplicate', { timeout: 40_000 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-memory-backup-crash-'));
  initialize(home);

  const holder = spawn(process.execPath, ['--import', 'tsx', fixture, 'hold-coordinator'], {
    cwd: repoRoot,
    env: fixtureEnv(home),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    await waitForLine(holder, 'COORDINATOR_LOCKED');

    const waitingRestart = spawnBackup(home, '2026-08-25');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(waitingRestart.exitCode, null, 'backup waits instead of racing creation/retention');
    assert.deepEqual(publishedSnapshots(home), [], 'no snapshot publishes outside the coordinator');

    assert.equal(holder.kill('SIGKILL'), true);
    const restarted = await completion(waitingRestart);
    assert.equal(restarted.code, 0, restarted.stderr || restarted.stdout);
    const result = JSON.parse(restarted.stdout.trim()) as BackupResult;
    assert.ok(result.result);
    assert.equal(result.result.reused, false);
    assert.equal(existsSync(result.result.backupPath), true);
    assert.deepEqual(publishedSnapshots(home), [path.basename(result.result.backupPath)]);
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
  }
});

test('rename-before-commit SIGKILL re-adopts the deterministic nightly snapshot', { timeout: 40_000 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-memory-backup-adopt-'));
  initialize(home);
  const backupDir = path.join(home, 'state', 'backups');
  mkdirSync(backupDir, { recursive: true });
  for (const stamp of [
    '2020-01-01T00-00-00-000Z',
    '2020-02-01T00-00-00-000Z',
    '2020-03-01T00-00-00-000Z',
    '2020-04-01T00-00-00-000Z',
  ]) {
    writeFileSync(path.join(backupDir, `memory-${stamp}.db`), 'old');
  }

  const crashed = spawn(process.execPath, ['--import', 'tsx', fixture, 'publish-uncommitted', '2026-08-25'], {
    cwd: repoRoot,
    env: fixtureEnv(home),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    await waitForLine(crashed, 'PUBLISHED_UNCOMMITTED:');
    const expected = path.join(home, 'state', 'backups', 'memory-2026-08-25-nightly.db');
    assert.equal(existsSync(expected), true, 'the complete final is visible before the coordinator commit');
    assert.equal(crashed.kill('SIGKILL'), true);

    const restarted = await completion(spawnBackup(home, '2026-08-25', 2));
    assert.equal(restarted.code, 0, restarted.stderr || restarted.stdout);
    const result = (JSON.parse(restarted.stdout.trim()) as BackupResult).result!;
    assert.equal(result.backupPath, expected);
    assert.equal(result.reused, true, 'restart adopts the complete final instead of vacuuming again');
    assert.equal(result.bytes > 0, true);
    const retained = publishedSnapshots(home);
    assert.equal(retained.length, 2, 're-adoption also restores the requested retention bound');
    assert.equal(retained.includes(path.basename(expected)), true, 'the re-adopted snapshot is protected from pruning');
  } finally {
    if (crashed.exitCode === null && crashed.signalCode === null) crashed.kill('SIGKILL');
  }
});

test('same-day reuse prunes a later unkeyed repair burst while protecting the nightly snapshot', { timeout: 40_000 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-memory-backup-reuse-prune-'));
  initialize(home);

  const initial = await completion(spawnBackup(home, '2026-08-25', 3));
  assert.equal(initial.code, 0, initial.stderr || initial.stdout);
  const nightly = (JSON.parse(initial.stdout.trim()) as BackupResult).result!;
  assert.equal(nightly.reused, false);

  const repairExits = await Promise.all(
    Array.from({ length: 4 }, () => completion(spawnUnkeyedBackup(home, 99))),
  );
  for (const result of repairExits) assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(publishedSnapshots(home).length, 5, 'repair burst intentionally exceeds nightly retention');

  const reusedExit = await completion(spawnBackup(home, '2026-08-25', 3));
  assert.equal(reusedExit.code, 0, reusedExit.stderr || reusedExit.stdout);
  const reused = (JSON.parse(reusedExit.stdout.trim()) as BackupResult).result!;
  assert.equal(reused.reused, true);
  assert.equal(reused.backupPath, nightly.backupPath);
  const retained = publishedSnapshots(home);
  assert.equal(retained.length, 3, 'keyed reuse prunes under the same coordinator lease');
  assert.equal(retained.includes(path.basename(nightly.backupPath)), true, 'the returned snapshot survives pruning');
});

test('unkeyed repair backups remain fresh while nightly publication and retention serialize', { timeout: 40_000 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-memory-backup-retention-'));
  initialize(home);
  const backupDir = path.join(home, 'state', 'backups');
  mkdirSync(backupDir, { recursive: true });
  for (const stamp of ['2020-01-01T00-00-00-000Z', '2020-02-01T00-00-00-000Z']) {
    writeFileSync(path.join(backupDir, `memory-${stamp}.db`), 'old');
  }

  const nightly = spawnBackup(home, '2026-08-25', 3);
  const repairA = spawnUnkeyedBackup(home, 3);
  const repairB = spawnUnkeyedBackup(home, 3);
  const exits = await Promise.all([completion(nightly), completion(repairA), completion(repairB)]);
  for (const result of exits) assert.equal(result.code, 0, result.stderr || result.stdout);
  const [nightlyResult, repairAResult, repairBResult] = exits
    .map((result) => (JSON.parse(result.stdout.trim()) as BackupResult).result!);

  assert.equal(nightlyResult.reused, false);
  assert.equal(repairAResult.reused, false);
  assert.equal(repairBResult.reused, false);
  assert.equal(new Set([nightlyResult.backupPath, repairAResult.backupPath, repairBResult.backupPath]).size, 3);
  assert.equal(existsSync(nightlyResult.backupPath), true);
  assert.equal(existsSync(repairAResult.backupPath), true);
  assert.equal(existsSync(repairBResult.backupPath), true);
  assert.deepEqual(
    publishedSnapshots(home),
    [nightlyResult, repairAResult, repairBResult].map((result) => path.basename(result.backupPath)).sort(),
  );
});
