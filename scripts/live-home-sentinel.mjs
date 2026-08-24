/**
 * Isolation sentinel for the real Clementine home.
 *
 * Paths follow production BASE_DIR layout: $REAL_HOME/.clementine-next/state/*.
 * A claimed live DB that exists at 0 bytes is a failed proof, not an empty home.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * PIDs holding the live harness DB open before the suite starts — i.e. a
 * daemon that already owned this home.
 *
 * Sampled BEFORE any test process exists, so an escaped test can never appear
 * here and excuse its own writes.
 */
export function liveHomeOwnerPids(home = realDefaultClementineHome()) {
  const target = path.join(home, 'state', 'harness.db');
  if (!existsSync(target)) return [];
  try {
    const probe = spawnSync('lsof', ['-t', target], { encoding: 'utf8', timeout: 5_000 });
    if (!probe.stdout) return [];
    return probe.stdout
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    // No lsof (Windows, or a locked-down box): claim no owner, which keeps the
    // strict rule. Fail-closed is the right default for a sentinel.
    return [];
  }
}

export function realUserHome() {
  return process.env.CLEMMY_REAL_USER_HOME || (() => {
    try { return os.userInfo().homedir; } catch { return process.env.HOME || os.homedir(); }
  })();
}

export function realDefaultClementineHome() {
  return path.resolve(path.join(realUserHome(), '.clementine-next'));
}

function hashFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function fileProof(filePath, { allowEmpty = true } = {}) {
  if (!existsSync(filePath)) {
    return { exists: false, size: 0, sha256: null, mtimeMs: null, mtimeNs: null };
  }
  const stats = statSync(filePath, { bigint: true });
  if (!allowEmpty && stats.size === 0n) {
    throw new Error(`live-home sentinel: claimed live DB is unexpectedly zero bytes: ${filePath}`);
  }
  return {
    exists: true,
    size: Number(stats.size),
    sha256: hashFile(filePath),
    mtimeMs: Number(stats.mtimeMs),
    mtimeNs: stats.mtimeNs.toString(),
  };
}

function hashTree(root) {
  if (!existsSync(root)) return null;
  const hash = createHash('sha256');
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stats = statSync(full, { bigint: true });
      hash.update(path.relative(root, full));
      hash.update('\0');
      if (stats.isDirectory()) {
        walk(full);
        continue;
      }
      hash.update(String(stats.size));
      hash.update('\0');
      hash.update(String(stats.mtimeMs));
      hash.update('\0');
      hash.update(stats.mtimeNs.toString());
      hash.update('\0');
      hash.update(hashFile(full));
      hash.update('\n');
    }
  };
  const stats = statSync(root);
  if (stats.isFile()) {
    return fileProof(root);
  }
  walk(root);
  return { exists: true, sha256: hash.digest('hex') };
}

/**
 * Compare two snapshots of the live home.
 *
 * The sentinel proves no test escaped into the real home, and it does that by
 * diffing bytes — it cannot see WHO wrote a file. That is decisive, because a
 * running daemon legitimately writes **every path in this snapshot**: its
 * databases continuously, tool contracts whenever it learns a schema, and
 * `auth.json` whenever it refreshes an OAuth token on its own schedule.
 *
 * Measured 2026-08-22: an initial attempt to split the snapshot into
 * "daemon-writable databases" and an "inviolable" remainder failed on its first
 * real run — the daemon deposited `GOOGLESHEETS_BATCH_GET` and
 * `SLACK_FETCH_CONVERSATION_HISTORY` contracts mid-suite. There is no subset of
 * a live home that a daemon will not touch.
 *
 * So the honest rule is binary, and the limit is reported rather than hidden:
 *
 *  - **No daemon owns the home** (CI, or a developer who stopped Clem): strict.
 *    Any change at all is a violation. This is the configuration a release gate
 *    runs in, which is where the proof actually has to hold.
 *  - **A daemon owns the home**: the check cannot be performed. Report exactly
 *    what moved so it stays visible, and do not fail — a sentinel that is red on
 *    every developer run teaches everyone to ignore it, and a gate nobody
 *    believes protects nothing.
 *
 * Precise escape detection under a live daemon belongs in the test that does
 * the writing: `live-home-isolation.proof.test.ts` writes a synthetic contract
 * identifier and asserts it never appears in the real home, which no amount of
 * daemon churn can imitate.
 */
export function compareLiveHome(before, after, ownerPids = before?.daemonOwners ?? []) {
  const changed = [];
  for (const key of Object.keys({ ...before, ...after })) {
    if (key === 'home' || key === 'daemonOwners') continue;
    if (JSON.stringify(before?.[key]) === JSON.stringify(after?.[key])) continue;
    changed.push(key);
  }
  const performed = ownerPids.length === 0;
  return {
    ok: performed ? changed.length === 0 : true,
    performed,
    violations: performed ? changed : [],
    attributed: performed ? [] : changed,
    ownerPids,
  };
}

export function snapshotLiveHome(home = realDefaultClementineHome()) {
  const state = path.join(home, 'state');
  const harnessDb = path.join(state, 'harness.db');
  const memoryDb = path.join(state, 'memory.db');
  return {
    home: path.resolve(home),
    harnessDb: fileProof(harnessDb, { allowEmpty: false }),
    harnessWal: fileProof(`${harnessDb}-wal`),
    harnessShm: fileProof(`${harnessDb}-shm`),
    memoryDb: fileProof(memoryDb, { allowEmpty: false }),
    memoryWal: fileProof(`${memoryDb}-wal`),
    memoryShm: fileProof(`${memoryDb}-shm`),
    secretsVault: fileProof(path.join(state, 'secrets-vault.json')),
    secretsMeta: fileProof(path.join(state, 'secrets-meta.json')),
    capabilityLiveIdentity: fileProof(path.join(state, 'capability-live-identity.json')),
    authState: fileProof(path.join(state, 'auth.json')),
    toolContracts: hashTree(path.join(home, 'memory', 'tool-contracts')),
  };
}
