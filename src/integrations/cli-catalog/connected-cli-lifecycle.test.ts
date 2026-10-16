import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import type { CliHealth, ProbeExecResult } from './auth-health.js';
import type { ConnectedCliRecord } from './catalog.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-cli-lifecycle-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
const STATE = path.join(TEST_HOME, 'state');
const ROSTER = path.join(STATE, 'connected-clis.json');
const HEALTH = path.join(STATE, 'cli-auth-health.json');
const BIN = path.join(STATE, 'connected-cli-bin');
mkdirSync(STATE, { recursive: true });
const catalog = await import('./catalog.js');
const auth = await import('./auth-health.js');
const pins = await import('./connected-cli-bin.js');
const selection = await import('./connected-cli-executable-selection.js');
const { mergedSpawnEnv } = await import('../../runtime/spawn-env.js');

function fixture(command: string, label: string): string {
  const dir = path.join(TEST_HOME, label);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, command);
  writeFileSync(file, `#!/bin/sh\nprintf '${label}\\n'\n`);
  chmodSync(file, 0o755);
  return file;
}

function observation(row: ConnectedCliRecord, binaryPath: string,
  authStatus: CliHealth['authStatus'] = 'ok'): CliHealth {
  return { id: row.id, command: row.command, installed: true, binaryPath, authStatus,
    checkedAt: new Date().toISOString(), username: 'controlled-observation',
    ...(row.connectionRevision ? { connectionRevision: row.connectionRevision } : {}) };
}

function persist(...entries: CliHealth[]): void {
  writeFileSync(HEALTH, JSON.stringify({ version: 'v1', entries: Object.fromEntries(entries.map(row => [row.id, row])) }));
}

function connect(id: string): ConnectedCliRecord {
  return catalog.recordConnectedCli(catalog.findCatalogEntry(id)!);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const successful = (name: string): ProbeExecResult => ({ exitCode: 0,
  output: `Logged in as ${name}@fixture.test`, timedOut: false });
const nextTurn = () => new Promise<void>(done => setImmediate(done));

beforeEach(() => {
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true });
  auth.invalidateCliHealth();
});
afterEach(() => { auth._testOnly_setProbeExec(); auth._testOnly_setCommandResolver(); });
after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

// This uses only public preexisting exports and can run on the exact baseline.
test('public forget immediately retires the selected pin before the next child PATH lookup',
  { skip: process.platform === 'win32' }, () => {
    const row = connect('github');
    const verified = fixture('gh', 'verified');
    const decoy = fixture('gh', 'decoy');
    const checked = observation(row, verified);
    persist(checked);
    pins.syncConnectedCliBin({ github: checked });
    const env = { ...mergedSpawnEnv(), PATH: [BIN, path.dirname(decoy), '/usr/bin', '/bin'].join(path.delimiter) };
    assert.equal(execFileSync('/bin/sh', ['-c', 'gh'], { env, encoding: 'utf8' }).trim(), 'verified');
    catalog.forgetConnectedCli('github');
    assert.equal(existsSync(path.join(BIN, 'gh')), false, 'forget must not depend on another roster health check');
    assert.equal(execFileSync('/bin/sh', ['-c', 'gh'], { env, encoding: 'utf8' }).trim(), 'decoy');
  });

test('forget is exact and idempotent: another connection and credentials remain untouched',
  { skip: process.platform === 'win32' }, () => {
    const github = connect('github');
    const railway = connect('railway');
    const a = observation(github, fixture('gh', 'github-a'));
    const b = observation(railway, fixture('railway', 'railway-b'));
    persist(a, b);
    pins.syncConnectedCliBin({ github: a, railway: b });
    const credential = path.join(TEST_HOME, 'controlled-credential.txt');
    writeFileSync(credential, 'retained-fixture');
    catalog.forgetConnectedCli('github');
    const afterFirst = readFileSync(ROSTER, 'utf8');
    catalog.forgetConnectedCli('github');
    assert.equal(readFileSync(ROSTER, 'utf8'), afterFirst);
    assert.equal(readlinkSync(path.join(BIN, 'railway')), b.binaryPath);
    assert.equal(auth.readPersistedHealth().github, undefined);
    assert.deepEqual(auth.readPersistedHealth().railway, b);
    assert.equal(readFileSync(credential, 'utf8'), 'retained-fixture');
  });

test('forget and sync preserve a regular file, unrelated symlink and differing newer target',
  { skip: process.platform === 'win32' }, () => {
    const row = connect('github');
    const a = observation(row, fixture('gh', 'owned-a'));
    persist(a);
    mkdirSync(BIN, { recursive: true });
    writeFileSync(path.join(BIN, 'gh'), 'user-file');
    const other = fixture('other', 'unrelated');
    symlinkSync(other, path.join(BIN, 'other'));
    pins.syncConnectedCliBin({ github: a });
    catalog.forgetConnectedCli('github');
    assert.equal(readFileSync(path.join(BIN, 'gh'), 'utf8'), 'user-file');
    assert.equal(readlinkSync(path.join(BIN, 'other')), other);

    const current = catalog.reconnectCli('github')!;
    const aAgain = observation(current, a.binaryPath!);
    persist(aAgain);
    rmSync(path.join(BIN, 'gh'));
    const newer = fixture('gh', 'different-newer');
    symlinkSync(newer, path.join(BIN, 'gh'));
    pins.syncConnectedCliBin({ github: aAgain });
    catalog.forgetConnectedCli('github');
    assert.equal(readlinkSync(path.join(BIN, 'gh')), newer);
    assert.equal(readlinkSync(path.join(BIN, 'other')), other);
  });

test('same-millisecond reconnect rejects a late prior probe without account, pin, memo or listener effects', async t => {
  t.mock.method(Date.prototype, 'toISOString', () => '2026-10-16T12:00:00.000Z');
  const rowA = connect('railway');
  const binaryA = fixture('railway', 'probe-a');
  const binaryB = fixture('railway', 'probe-b');
  const old = observation(rowA, binaryA, 'signed_out');
  persist(old);
  let selected = binaryA;
  auth._testOnly_setCommandResolver(command => ({ skipped: false, command, path: selected }));
  const pendingA = deferred<ProbeExecResult>();
  const pendingB = deferred<ProbeExecResult>();
  let calls = 0;
  auth._testOnly_setProbeExec(async () => (++calls === 1 ? pendingA.promise : pendingB.promise));
  const recovered: string[] = [];
  const signedOut: string[] = [];
  const offRecovered = auth.onCliAuthRecovered(value => recovered.push(value.id));
  const offSignedOut = auth.onCliSignedOut(value => signedOut.push(value.id));
  try {
    const taskA = auth.getCliHealth('railway', { force: true });
    await nextTurn();
    catalog.forgetConnectedCli('railway');
    const rowB = catalog.reconnectCli('railway')!;
    assert.equal(rowA.installedAt, rowB.installedAt);
    assert.notEqual(rowA.connectionRevision, rowB.connectionRevision);
    selected = binaryB;
    const taskB = auth.getCliHealth('railway');
    await nextTurn();
    assert.equal(calls, 2, 'new incarnation must not reuse old inFlight');
    pendingA.resolve(successful('old-a'));
    const lateA = await taskA;
    assert.equal(lateA.authStatus, 'unknown');
    assert.equal(lateA.username, undefined);
    assert.equal(lateA.binaryPath, undefined);
    const anotherB = auth.getCliHealth('railway');
    await nextTurn();
    assert.equal(calls, 2, 'old finally must not delete the newer inFlight');
    pendingB.resolve(successful('new-b'));
    const [freshB, sameB] = await Promise.all([taskB, anotherB]);
    assert.deepEqual(freshB, sameB);
    assert.equal(freshB.connectionRevision, rowB.connectionRevision);
    assert.equal(freshB.binaryPath, binaryB);
    assert.equal((await auth.getCliHealth('railway')).username, 'new-b@fixture.test');
    assert.equal(calls, 2);
    pins.syncConnectedCliBin({ railway: old });
    assert.deepEqual(auth.readPersistedHealth().railway, freshB);
    if (process.platform !== 'win32') assert.equal(readlinkSync(path.join(BIN, 'railway')), binaryB);
    assert.deepEqual(recovered, []);
    assert.deepEqual(signedOut, []);

    persist(old);
    assert.equal(auth.readPersistedHealth().railway, undefined, 'retained old health is not the new account observation');
    assert.deepEqual(selection.readConnectedCliExecutableSelection(rowB),
      { status: 'blocked', reason: 'connection_revision_mismatch' });
  } finally { offRecovered(); offSignedOut(); }
});

test('forget with a current memo refuses a repeat check without starting another probe', async () => {
  connect('railway');
  let calls = 0;
  auth._testOnly_setCommandResolver(command => ({ skipped: false, command, path: process.execPath }));
  auth._testOnly_setProbeExec(async () => { calls++; return successful('memo'); });
  await auth.getCliHealth('railway');
  catalog.forgetConnectedCli('railway');
  await assert.rejects(auth.getCliHealth('railway'), /disconnected or changed/);
  assert.equal(calls, 1);
  assert.equal(auth.readPersistedHealth().railway, undefined);
});

test('item metadata and its exact incarnation are captured in one locked snapshot', async () => {
  connect('railway');
  const original = fs.readFileSync;
  let reads = 0;
  let guarded = false;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    const value = original(...args);
    if (String(args[0]) === ROSTER && ++reads === 2) {
      // This is the source-capture race: the first read is only alias lookup.
      // A second process must not replace the adopted skill/probe metadata
      // between its read and attaching a newer connection incarnation.
      if (existsSync(`${ROSTER}.lock`)) {
        assert.throws(() => catalog.reconnectCli('railway'));
        guarded = true;
      } else {
        const changed = catalog.reconnectCli('railway')!;
        changed.authProbe = { args: ['whoami', '--new-fixture'] };
        writeFileSync(ROSTER, JSON.stringify({ version: 'v1', entries: { railway: changed } }));
      }
    }
    return value;
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  const argsSeen: string[][] = [];
  auth._testOnly_setCommandResolver(command => ({ skipped: false, command, path: process.execPath }));
  auth._testOnly_setProbeExec(async (_binary, args) => { argsSeen.push([...args]); return successful('captured'); });
  try {
    const result = await auth.getCliHealth('railway', { force: true });
    const current = catalog.readConnectedClis().railway!;
    assert.deepEqual(argsSeen, [current.authProbe!.args]);
    assert.equal(result.connectionRevision, current.connectionRevision);
    assert.equal(guarded, true);
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
});

test('independently saved commands remain observable after their catalog connection is forgotten', async () => {
  connect('railway');
  const previous = process.env.CLEMMY_SAVED_CLIS;
  process.env.CLEMMY_SAVED_CLIS = 'railway,fixture-custom';
  catalog.forgetConnectedCli('railway');
  let calls = 0;
  auth._testOnly_setCommandResolver(command => ({ skipped: false, command, path: process.execPath }));
  auth._testOnly_setProbeExec(async () => { calls++; return successful('saved'); });
  try {
    const saved = await auth.getCliHealth('saved:railway');
    const custom = await auth.getCliHealth('saved:fixture-custom');
    assert.equal(saved.id, 'saved:railway');
    assert.equal(saved.connectionRevision, undefined);
    assert.equal(custom.id, 'saved:fixture-custom');
    assert.equal(custom.authStatus, 'unknown', 'probe-less inventory does not invent authentication');
    assert.equal(custom.username, undefined);
    assert.equal(calls, 1);
    assert.equal(catalog.readConnectedClis().railway, undefined);
    assert.equal(catalog.readForgottenCliIds().includes('railway'), true);
  } finally {
    if (previous === undefined) delete process.env.CLEMMY_SAVED_CLIS; else process.env.CLEMMY_SAVED_CLIS = previous;
  }
});

test('strict lifecycle lock never mutates roster, observations or pins while held', async () => {
  const row = connect('railway');
  const checked = observation(row, fixture('railway', 'locked'));
  persist(checked);
  pins.syncConnectedCliBin({ railway: checked });
  const roster = readFileSync(ROSTER, 'utf8');
  const health = readFileSync(HEALTH, 'utf8');
  const { withFileLock } = await import('../../runtime/atomic-json.js');
  await withFileLock(ROSTER, async () => {
    assert.throws(() => catalog.forgetConnectedCli('railway'));
    assert.throws(() => catalog.reconnectCli('railway'));
    assert.throws(() => pins.syncConnectedCliBin({ railway: checked }));
    assert.equal(readFileSync(ROSTER, 'utf8'), roster);
    assert.equal(readFileSync(HEALTH, 'utf8'), health);
    if (process.platform !== 'win32') assert.equal(readlinkSync(path.join(BIN, 'railway')), checked.binaryPath);
  });
});

test('corrupt existing roster is not normalized into an empty successful mutation', () => {
  for (const contents of ['{broken', JSON.stringify({ version: 'v1', entries: [] }),
    JSON.stringify({ version: 'v1', entries: {}, forgotten: {} })]) {
    writeFileSync(ROSTER, contents);
    assert.throws(() => catalog.forgetConnectedCli('github'));
    assert.throws(() => connect('github'));
    assert.equal(readFileSync(ROSTER, 'utf8'), contents);
  }
});

test('legacy exact-row observation remains usable until reconnect issues a new incarnation', () => {
  const row = connect('railway');
  delete row.connectionRevision;
  writeFileSync(ROSTER, JSON.stringify({ version: 'v1', entries: { railway: row } }));
  const checked = observation(row, process.execPath);
  persist(checked);
  assert.equal(selection.readConnectedCliExecutableSelection(row).status, 'selected');
  catalog.forgetConnectedCli('railway');
  const reconnected = catalog.reconnectCli('railway')!;
  persist(checked);
  assert.equal(auth.readPersistedHealth().railway, undefined);
  assert.deepEqual(selection.readConnectedCliExecutableSelection(reconnected),
    { status: 'blocked', reason: 'connection_revision_mismatch' });
});

test('unlink failure keeps exact forget ownership for a successful retry',
  { skip: process.platform === 'win32' }, () => {
    const row = connect('railway');
    const checked = observation(row, fixture('railway', 'unlink-failure'));
    persist(checked);
    pins.syncConnectedCliBin({ railway: checked });
    const original = fs.unlinkSync;
    fs.unlinkSync = ((file: fs.PathLike) => {
      if (String(file) === path.join(BIN, 'railway')) throw Object.assign(new Error('controlled unlink failure'), { code: 'EACCES' });
      return original(file);
    }) as typeof fs.unlinkSync;
    syncBuiltinESMExports();
    try { assert.throws(() => catalog.forgetConnectedCli('railway'), /controlled unlink failure/); }
    finally { fs.unlinkSync = original; syncBuiltinESMExports(); }
    assert.equal(catalog.readConnectedClis().railway?.connectionRevision, row.connectionRevision);
    assert.deepEqual(auth.readPersistedHealth().railway, checked);
    catalog.forgetConnectedCli('railway');
    assert.equal(existsSync(path.join(BIN, 'railway')), false);
  });

test('unreadable pin ownership fails before discarding the roster or health and can be retried',
  { skip: process.platform === 'win32' }, () => {
    const row = connect('railway');
    const checked = observation(row, fixture('railway', 'readlink-failure'));
    persist(checked);
    pins.syncConnectedCliBin({ railway: checked });
    const original = fs.readlinkSync;
    fs.readlinkSync = ((...args: Parameters<typeof fs.readlinkSync>) => {
      if (String(args[0]) === path.join(BIN, 'railway')) throw Object.assign(new Error('controlled readlink failure'), { code: 'EIO' });
      return original(...args);
    }) as typeof fs.readlinkSync;
    syncBuiltinESMExports();
    try { assert.throws(() => catalog.forgetConnectedCli('railway'), /controlled readlink failure/); }
    finally { fs.readlinkSync = original; syncBuiltinESMExports(); }
    assert.equal(catalog.readConnectedClis().railway?.connectionRevision, row.connectionRevision);
    assert.deepEqual(auth.readPersistedHealth().railway, checked);
    catalog.forgetConnectedCli('railway');
    assert.equal(existsSync(path.join(BIN, 'railway')), false);
  });

test('a failed A-to-B pin retirement retains A observation until a safe fresh retry',
  { skip: process.platform === 'win32' }, async () => {
    const row = connect('railway');
    const binaryA = fixture('railway', 'replacement-a');
    const binaryB = fixture('railway', 'replacement-b');
    const old = observation(row, binaryA);
    persist(old);
    pins.syncConnectedCliBin({ railway: old });
    auth._testOnly_setCommandResolver(command => ({ skipped: false, command, path: binaryB }));
    auth._testOnly_setProbeExec(async () => successful('replacement-b'));
    const original = fs.unlinkSync;
    fs.unlinkSync = ((file: fs.PathLike) => {
      if (String(file) === path.join(BIN, 'railway')) throw new Error('controlled retirement failure');
      return original(file);
    }) as typeof fs.unlinkSync;
    syncBuiltinESMExports();
    try { await assert.rejects(auth.getCliHealth('railway', { force: true }), /controlled retirement failure/); }
    finally { fs.unlinkSync = original; syncBuiltinESMExports(); }
    assert.deepEqual(auth.readPersistedHealth().railway, old);
    assert.equal(readlinkSync(path.join(BIN, 'railway')), binaryA);
    const fresh = await auth.getCliHealth('railway', { force: true });
    assert.equal(fresh.binaryPath, binaryB);
    assert.equal(readlinkSync(path.join(BIN, 'railway')), binaryB);
  });

test('auto-promotion rechecks a disconnect which happens after its discovery snapshot',
  { skip: process.platform === 'win32' }, () => {
    const file = fixture('railway', 'promotion');
    const previousPath = process.env.PATH;
    process.env.PATH = path.dirname(file);
    const original = fs.statSync;
    let injected = false;
    fs.statSync = ((...args: Parameters<typeof fs.statSync>) => {
      if (!injected && String(args[0]) === file) {
        injected = true;
        catalog.forgetConnectedCli('railway');
      }
      return original(...args);
    }) as typeof fs.statSync;
    syncBuiltinESMExports();
    try {
      const result = catalog.autoPromoteInstalledClis();
      assert.equal(injected, true);
      assert.equal(result.promoted.includes('railway'), false);
      assert.equal(catalog.readConnectedClis().railway, undefined);
      assert.equal(catalog.readForgottenCliIds().includes('railway'), true);
    } finally {
      fs.statSync = original; syncBuiltinESMExports();
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    }
  });

test('lifecycle pins stay in the bound home if process environment changes later',
  { skip: process.platform === 'win32' }, () => {
    const row = connect('railway');
    const checked = observation(row, fixture('railway', 'home-a'));
    persist(checked);
    pins.syncConnectedCliBin({ railway: checked });
    const other = mkdtempSync(path.join(os.tmpdir(), 'clem-cli-other-home-'));
    const otherPin = path.join(other, 'state', 'connected-cli-bin', 'railway');
    mkdirSync(path.dirname(otherPin), { recursive: true });
    symlinkSync(checked.binaryPath!, otherPin);
    process.env.CLEMENTINE_HOME = other;
    try {
      catalog.forgetConnectedCli('railway');
      assert.equal(existsSync(path.join(BIN, 'railway')), false);
      assert.equal(lstatSync(otherPin).isSymbolicLink(), true);
    } finally { process.env.CLEMENTINE_HOME = TEST_HOME; rmSync(other, { recursive: true, force: true }); }
  });
