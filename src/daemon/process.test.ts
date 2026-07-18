import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-daemon-lease-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const {
  acquireDaemonLease,
  clearDaemonPid,
  daemonPidIsForeignReuse,
  DAEMON_LEASE_DIR,
  PID_FILE,
  readDaemonPid,
  stopDaemon,
} = await import('./process.js');

const MODULE_URL = pathToFileURL(path.join(process.cwd(), 'src/daemon/process.ts')).href;
const CHILD_CODE = `
  import { existsSync, writeFileSync } from 'node:fs';
  const mod = await import(process.env.CLEM_LEASE_MODULE_URL);
  writeFileSync(process.env.CLEM_LEASE_READY, 'ready');
  while (!existsSync(process.env.CLEM_LEASE_BARRIER)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const won = mod.acquireDaemonLease();
  writeFileSync(process.env.CLEM_LEASE_RESULT, JSON.stringify({ won, pid: process.pid }));
  if (won) await new Promise((resolve) => setTimeout(resolve, 750));
`;

const GENERATION_ABA_CHILD_CODE = `
  import { existsSync, writeFileSync } from 'node:fs';
  const mod = await import(process.env.CLEM_LEASE_MODULE_URL);
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  mod.daemonProcessInternalsForTest.setAfterLeaseDirectoryCreatedHook(() => {
    writeFileSync(process.env.CLEM_LEASE_READY, 'created');
    while (!existsSync(process.env.CLEM_LEASE_RELEASE)) Atomics.wait(waiter, 0, 0, 10);
  });
  const won = mod.acquireDaemonLease();
  writeFileSync(process.env.CLEM_LEASE_RESULT, JSON.stringify({ won, pid: process.pid }));
`;

beforeEach(() => {
  clearDaemonPid();
  rmSync(DAEMON_LEASE_DIR, { recursive: true, force: true });
  rmSync(PID_FILE, { force: true });
});

function leaseChild(label: string, barrier: string): { child: ChildProcess; ready: string; result: string } {
  const ready = path.join(TMP_HOME, `${label}.ready`);
  const result = path.join(TMP_HOME, `${label}.result`);
  rmSync(ready, { force: true });
  rmSync(result, { force: true });
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', CHILD_CODE], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEMENTINE_HOME: TMP_HOME,
      CLEM_LEASE_MODULE_URL: MODULE_URL,
      CLEM_LEASE_READY: ready,
      CLEM_LEASE_RESULT: result,
      CLEM_LEASE_BARRIER: barrier,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, ready, result };
}

async function waitForFiles(files: string[], timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!files.every(existsSync)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${files.join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runContenders(prefix: string): Promise<Array<{ won: boolean; pid: number }>> {
  const barrier = path.join(TMP_HOME, `${prefix}.go`);
  rmSync(barrier, { force: true });
  const contenders = [leaseChild(`${prefix}-a`, barrier), leaseChild(`${prefix}-b`, barrier)];
  await waitForFiles(contenders.map((entry) => entry.ready));
  writeFileSync(barrier, 'go');
  const closes = await Promise.all(contenders.map(async ({ child }) => {
    const [code] = await once(child, 'close') as [number | null];
    return code;
  }));
  assert.deepEqual(closes, [0, 0]);
  return contenders.map(({ result }) => JSON.parse(readFileSync(result, 'utf-8')) as { won: boolean; pid: number });
}

test('daemon lease: two simultaneous starters produce exactly one live owner', async () => {
  const results = await runContenders('fresh');
  assert.equal(results.filter((result) => result.won).length, 1);
  assert.equal(readDaemonPid(), results.find((result) => result.won)?.pid);
});

test('daemon lease: concurrent stale reclaimers cannot delete the new generation (ABA)', async () => {
  const staleToken = '00000000-0000-4000-8000-000000000000';
  mkdirSync(DAEMON_LEASE_DIR, { recursive: true });
  writeFileSync(path.join(DAEMON_LEASE_DIR, `owner-${staleToken}.json`), JSON.stringify({
    version: 1,
    pid: 2_147_483_647,
    token: staleToken,
    startedAt: new Date(0).toISOString(),
  }));
  const results = await runContenders('stale');
  assert.equal(results.filter((result) => result.won).length, 1);
  assert.equal(readDaemonPid(), results.find((result) => result.won)?.pid);
});

test('daemon lease: a claimant cannot publish into a replacement directory generation', async () => {
  const ready = path.join(TMP_HOME, 'generation-aba.ready');
  const release = path.join(TMP_HOME, 'generation-aba.release');
  const resultFile = path.join(TMP_HOME, 'generation-aba.result');
  const displacedDirectory = path.join(TMP_HOME, 'daemon.lock.displaced');
  for (const file of [ready, release, resultFile]) rmSync(file, { force: true });
  rmSync(displacedDirectory, { recursive: true, force: true });

  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', GENERATION_ABA_CHILD_CODE], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEMENTINE_HOME: TMP_HOME,
      CLEM_LEASE_MODULE_URL: MODULE_URL,
      CLEM_LEASE_READY: ready,
      CLEM_LEASE_RELEASE: release,
      CLEM_LEASE_RESULT: resultFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForFiles([ready]);
    // Keep the claimant's original inode alive under another name so the new
    // fixed path is guaranteed to be a distinct directory generation.
    renameSync(DAEMON_LEASE_DIR, displacedDirectory);
    mkdirSync(DAEMON_LEASE_DIR, { mode: 0o700 });
    const replacementToken = '11111111-1111-4111-8111-111111111111';
    writeFileSync(path.join(DAEMON_LEASE_DIR, `owner-${replacementToken}.json`), JSON.stringify({
      version: 1,
      pid: process.pid,
      token: replacementToken,
      startedAt: new Date().toISOString(),
    }));
    writeFileSync(release, 'continue');

    const [code] = await once(child, 'close') as [number | null];
    assert.equal(code, 0);
    const result = JSON.parse(readFileSync(resultFile, 'utf-8')) as { won: boolean; pid: number };
    assert.equal(result.won, false, 'the displaced creator must not claim the replacement generation');
    assert.deepEqual(
      readdirSync(DAEMON_LEASE_DIR).filter((entry) => entry.startsWith('owner-')),
      [`owner-${replacementToken}.json`],
      'generation mismatch cleanup removes only the displaced claimant token',
    );
    assert.equal(readDaemonPid(), process.pid, 'the replacement generation remains authoritative');
    assert.equal(existsSync(PID_FILE), false, 'the displaced claimant never publishes a pid projection');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(displacedDirectory, { recursive: true, force: true });
  }
});

const DEAD_PID = 2_147_483_647;

/** A pid the test runner cannot signal (EPERM), or null when it runs as root
 *  (or pid 1 is gone), in which case the EPERM case cannot be exercised here. */
function foreignUserPid(): number | null {
  try {
    process.kill(1, 0);
    return null;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? 1 : null;
  }
}
const EPERM_PID = foreignUserPid();

function psReadable(): boolean {
  if (process.platform === 'win32') return false;
  try {
    return execFileSync('ps', ['-p', String(process.pid), '-o', 'command='], {
      encoding: 'utf-8',
      timeout: 2_000,
    }).trim().length > 0;
  } catch {
    return false;
  }
}

async function spawnSignalableChild(extraArgs: string[]): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)', ...extraArgs], {
    stdio: 'ignore',
  });
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      if (child.pid) { process.kill(child.pid, 0); break; }
    } catch { /* not yet visible */ }
    if (Date.now() >= deadline) throw new Error('child never became signalable');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return child;
}

/** A live same-user process with NO daemon signature in its argv. */
function spawnSameUserSleeper(): Promise<ChildProcess> {
  return spawnSignalableChild([]);
}

test('daemon lease: an EPERM (foreign-user) owner pid is stale and taken over', { skip: EPERM_PID === null }, () => {
  const token = '22222222-2222-4222-8222-222222222222';
  mkdirSync(DAEMON_LEASE_DIR, { recursive: true });
  writeFileSync(path.join(DAEMON_LEASE_DIR, `owner-${token}.json`), JSON.stringify({
    version: 1,
    pid: EPERM_PID,
    token,
    startedAt: new Date().toISOString(),
  }));
  assert.equal(acquireDaemonLease(process.pid), true, 'a root-owned (EPERM) pid can never be our daemon');
  assert.equal(readDaemonPid(), process.pid);
});

test('daemon lease: a live same-user current-format owner still blocks acquisition', async () => {
  // The current-format path uses plain liveness (not the daemon-shape heuristic)
  // so a concurrent live competitor always blocks — see the reverted hardening
  // note in process.ts. Same-user pid reuse of a stale current-format owner is
  // the documented residual (proper fix = process-start-time vs startedAt).
  const child = await spawnSameUserSleeper();
  try {
    const token = '33333333-3333-4333-8333-333333333333';
    mkdirSync(DAEMON_LEASE_DIR, { recursive: true });
    writeFileSync(path.join(DAEMON_LEASE_DIR, `owner-${token}.json`), JSON.stringify({
      version: 1,
      pid: child.pid,
      token,
      startedAt: new Date().toISOString(),
    }));
    assert.equal(acquireDaemonLease(process.pid), false, 'a live same-user owner must retain the lease');
    assert.equal(readDaemonPid(), child.pid);
  } finally {
    child.kill('SIGKILL');
  }
});

test('daemon lease: a legacy bare-pid file from a dead process is taken over', () => {
  writeFileSync(PID_FILE, `${DEAD_PID}\n`);
  assert.equal(existsSync(DAEMON_LEASE_DIR), false);
  assert.equal(acquireDaemonLease(process.pid), true);
  assert.equal(readDaemonPid(), process.pid);
  assert.equal(existsSync(DAEMON_LEASE_DIR), true, 'takeover installs a current-format lease');
});

test('daemon lease: a legacy bare-pid held by a non-daemon same-user process is taken over', { skip: !psReadable() }, async () => {
  const child = await spawnSameUserSleeper();
  try {
    writeFileSync(PID_FILE, `${child.pid}\n`);
    // The sleeper's command line carries no Clementine daemon signature, so the
    // reused legacy pid must classify as stale despite being live and same-user.
    assert.equal(acquireDaemonLease(process.pid), true);
    assert.equal(readDaemonPid(), process.pid);
  } finally {
    child.kill('SIGKILL');
  }
});

test('daemon lease: a legacy pid reused by a same-user Clementine.app helper (no daemon signature) is taken over', { skip: !psReadable() }, async () => {
  // Every packaged Electron helper's argv contains "/Applications/Clementine.app/…",
  // so a bundle-name match would let the app's OWN reused pid block the daemon
  // forever — a first-boot-after-upgrade brick that flickers then dies. Only a
  // real daemon carries a /daemon/ path or --foreground; a bundle-path lookalike
  // must classify as stale and be taken over.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)', '/Applications/Clementine.app/Contents/MacOS/Clementine'], { stdio: 'ignore' });
  const deadline = Date.now() + 5_000;
  while (true) {
    try { if (child.pid) { process.kill(child.pid, 0); break; } } catch { /* not yet visible */ }
    if (Date.now() >= deadline) throw new Error('lookalike child never became signalable');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  try {
    writeFileSync(PID_FILE, `${child.pid}\n`);
    assert.equal(acquireDaemonLease(process.pid), true, 'a Clementine-bundle-path helper is not the daemon');
    assert.equal(readDaemonPid(), process.pid);
  } finally {
    child.kill('SIGKILL');
  }
});

test('daemon stop: a legacy pid reused by a non-daemon same-user process is NOT killed', { skip: !psReadable() }, async () => {
  const child = await spawnSameUserSleeper();
  try {
    writeFileSync(PID_FILE, `${child.pid}\n`);
    assert.equal(daemonPidIsForeignReuse(child.pid!), true, 'a non-daemon reused pid is foreign');
    const result = stopDaemon();
    assert.equal(result.stopped, false, 'must not SIGTERM an unrelated same-user process');
    // The innocent process is still alive; only the stale pid record was cleared.
    assert.doesNotThrow(() => process.kill(child.pid!, 0), 'the reused-pid process must survive daemon stop');
    assert.equal(readDaemonPid(), null, 'the stale pid record is cleared');
  } finally {
    child.kill('SIGKILL');
  }
});

test('daemon stop: a genuine daemon-shaped pid is signalled', { skip: !psReadable() }, async () => {
  const child = await spawnSignalableChild(['daemon', '--foreground']);
  try {
    writeFileSync(PID_FILE, `${child.pid}\n`);
    assert.equal(daemonPidIsForeignReuse(child.pid!), false, 'a daemon-shaped pid is not foreign');
    const result = stopDaemon();
    assert.equal(result.stopped, true, 'a real daemon receives SIGTERM');
    assert.equal(result.pid, child.pid);
  } finally {
    child.kill('SIGKILL');
  }
});

test('daemon lease: malformed or multiple-owner state fails closed', () => {
  mkdirSync(DAEMON_LEASE_DIR, { recursive: true });
  writeFileSync(path.join(DAEMON_LEASE_DIR, 'owner-bad.json'), '{}');
  assert.equal(acquireDaemonLease(process.pid), false);
  writeFileSync(path.join(DAEMON_LEASE_DIR, 'owner-also-bad.json'), '{}');
  assert.equal(acquireDaemonLease(process.pid), false);
});
