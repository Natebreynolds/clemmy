import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import {
  SmokeError, assertQualificationHost, parseArguments, isOwnedPath,
  isolatedChildEnvironment, assertBuildStamp, assertServedIdentity,
  assertCDPUrl, consoleAssetRelative, exactOwnedProcess,
  assertFailureCleanupIdentity,
  isDashboardTarget,
  INSTALLED_STORAGE_PROBE,
  pinnedLoopbackTlsHandshake, publicStorageReceipt,
  _testOnly_createOwnedChildRunner,
} from './windows-packaged-launch-smoke.mjs';

const refuses = (operation, code) => assert.throws(operation, (error) => error instanceof SmokeError && error.code === code);

function simulatedOwnedChild() {
  let directKills = 0; let unrefs = 0;
  const child = Object.assign(new EventEmitter(), { pid: 543, exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: null,
    kill() { directKills += 1; return true; }, unref() { unrefs += 1; } });
  return { child, directKills: () => directKills, unrefs: () => unrefs };
}

test('owned child helper loads before spawn and a missing build prerequisite admits no installer/probe', async () => {
  let launches = 0;
  for (const loadTreeStop of [async () => { throw new Error('private loader detail'); }, async () => undefined]) {
    const run = _testOnly_createOwnedChildRunner({ platform: 'win32', loadTreeStop,
      spawnProcess: () => { launches += 1; assert.fail('missing helper must refuse before spawn'); } });
    await assert.rejects(run('owned.exe', []), error => error instanceof SmokeError
      && error.code === 'owned_child_stop_helper_unavailable' && !error.message.includes('private'));
  }
  let release; const loaded = new Promise(resolve => { release = resolve; });
  const fixture = simulatedOwnedChild();
  const run = _testOnly_createOwnedChildRunner({ platform: 'win32', loadTreeStop: () => loaded,
    spawnProcess: () => { launches += 1; queueMicrotask(() => fixture.child.emit('close', 0)); return fixture.child; } });
  const pending = run('owned.exe', []);
  await Promise.resolve(); assert.equal(launches, 0);
  release(async () => { assert.fail('successful probe must not stop'); });
  assert.equal(await pending, ''); assert.equal(launches, 1);
});

test('timeout holds late zero close until exact canonical cleanup, which can never turn timeout into success', async () => {
  const fixture = simulatedOwnedChild(); let stops = 0; let accept; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const receipt = new Promise(resolve => { accept = resolve; });
  const run = _testOnly_createOwnedChildRunner({ platform: 'win32', cleanupTimeoutMs: 1_000,
    spawnProcess: () => fixture.child, loadTreeStop: async () => async child => {
      assert.equal(child, fixture.child); stops += 1; entered(); return receipt;
    } });
  let settled = false;
  const pending = run('owned.exe', [], { timeoutMs: 5 }).then(() => assert.fail('forced stop cannot qualify'), error => { settled = true; return error; });
  await started;
  fixture.child.emit('error', new Error('private late child error'));
  fixture.child.emit('error', new Error('private repeated late child error'));
  fixture.child.emit('close', 0); await Promise.resolve(); assert.equal(settled, false);
  accept('complete'); const error = await pending;
  assert.equal(error.code, 'owned_child_timeout'); assert.equal(error.childCleanup, 'complete');
  assert.equal(stops, 1); assert.equal(fixture.directKills(), 0);
  assert.equal(fixture.child.stdout.destroyed, true); assert.equal(fixture.child.stderr.destroyed, true); assert.equal(fixture.unrefs(), 1);
});

for (const outcome of ['incomplete', 'throw', 'never', 'unknown-status']) test(`owned timeout ${outcome} cleanup settles without pipe close and reports uncertainty`, async () => {
  const fixture = simulatedOwnedChild(); let stops = 0;
  const run = _testOnly_createOwnedChildRunner({ platform: 'win32', cleanupTimeoutMs: 20,
    spawnProcess: () => fixture.child, loadTreeStop: async () => async child => {
      assert.equal(child, fixture.child); stops += 1;
      if (outcome === 'throw') throw new Error('private native failure');
      if (outcome === 'never') return new Promise(() => {});
      return outcome;
    } });
  const error = await run('owned.exe', [], { timeoutMs: 5 }).catch(error => error);
  assert.ok(error instanceof SmokeError); assert.equal(error.code, 'owned_child_timeout'); assert.equal(error.childCleanup, 'incomplete');
  assert.equal(error.message.includes('private'), false); assert.equal(stops, 1);
  assert.equal(fixture.child.stdout.destroyed, true); assert.equal(fixture.child.stderr.destroyed, true); assert.equal(fixture.unrefs(), 1);
});

test('an exited parent with inherited pipes cannot authorize taskkill of a potentially reused PID', async () => {
  const fixture = simulatedOwnedChild(); let stops = 0;
  const run = _testOnly_createOwnedChildRunner({ platform: 'win32', spawnProcess: () => {
    queueMicrotask(() => { fixture.child.exitCode = 0; fixture.child.emit('exit', 0, null); }); return fixture.child;
  }, loadTreeStop: async () => async () => { stops += 1; assert.fail('exited parent is not a PID stop witness'); } });
  const error = await run('owned.exe', [], { timeoutMs: 5 }).catch(error => error);
  assert.equal(error.code, 'owned_child_timeout'); assert.equal(error.childCleanup, 'incomplete'); assert.equal(stops, 0);
  assert.equal(fixture.directKills(), 0); assert.equal(fixture.unrefs(), 1); assert.equal(fixture.child.stdout.destroyed, true);
});

test('owned child error preserves failure through zero close and holds started cleanup instead of leaking raw error', async () => {
  const fixture = simulatedOwnedChild(); let accept; let entered;
  const started = new Promise(resolve => { entered = resolve; }); const receipt = new Promise(resolve => { accept = resolve; });
  const run = _testOnly_createOwnedChildRunner({ platform: 'win32', cleanupTimeoutMs: 1_000,
    spawnProcess: () => { queueMicrotask(() => fixture.child.emit('error', new Error('private command/credential detail'))); return fixture.child; },
    loadTreeStop: async () => async child => { assert.equal(child, fixture.child); entered(); return receipt; } });
  let settled = false;
  const pending = run('owned.exe', []).catch(error => { settled = true; return error; });
  await started; fixture.child.emit('close', 0); await Promise.resolve(); assert.equal(settled, false);
  accept('complete'); const error = await pending;
  assert.equal(error.code, 'owned_child_start_failed'); assert.equal(error.childCleanup, 'complete'); assert.doesNotMatch(error.message, /private/);
});

test('never-started child failure is bounded without invoking PID cleanup, while ordinary success retains output', async () => {
  const fixture = simulatedOwnedChild(); fixture.child.pid = undefined;
  const run = _testOnly_createOwnedChildRunner({ platform: 'win32', spawnProcess: () => {
    queueMicrotask(() => fixture.child.emit('error', new Error('synthetic ENOENT'))); return fixture.child;
  }, loadTreeStop: async () => async () => { assert.fail('a missing child PID must never authorize cleanup'); } });
  const error = await run('owned.exe', []).catch(error => error);
  assert.equal(error.code, 'owned_child_start_failed'); assert.equal(error.childCleanup, 'not_started'); assert.equal(fixture.unrefs(), 1);
  const success = simulatedOwnedChild();
  const runSuccess = _testOnly_createOwnedChildRunner({ platform: 'win32', spawnProcess: () => {
    queueMicrotask(() => { success.child.stdout.write('controlled output'); success.child.emit('exit', 0, null); success.child.emit('close', 0); }); return success.child;
  }, loadTreeStop: async () => async () => { assert.fail('natural successful close must not dispatch a tree stop'); } });
  assert.equal(await runSuccess('owned.exe', []), 'controlled output'); assert.equal(success.unrefs(), 0);
});

test('actual Windows owned Node timeout confirms descendant stop despite inherited stdout/stderr', { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
  const { stopWindowsProcessTree } = await import('../src/runtime/windows-process-tree.ts');
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'clem-smoke-owned-tree-'));
  const program = path.join(fixture, 'parent.mjs'), trace = path.join(fixture, 'trace.json');
  writeFileSync(program, `import {spawn} from 'node:child_process'; import fs from 'node:fs';
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr],windowsHide:true});
    fs.writeFileSync(process.argv[2]+'.tmp',JSON.stringify({parent:process.pid,descendant:child.pid}));
    fs.renameSync(process.argv[2]+'.tmp',process.argv[2]);setInterval(()=>{},1000);`);
  let owned; let descendant;
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const run = _testOnly_createOwnedChildRunner({ platform: 'win32', loadTreeStop: async () => stopWindowsProcessTree,
    spawnProcess: (...args) => { owned = spawn(...args); return owned; } });
  const pending = run(process.execPath, [program, trace], { timeoutMs: 5_000,
    env: { SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT, TEMP: os.tmpdir(), TMP: os.tmpdir() } }).catch(error => error);
  try {
    const deadline = Date.now() + 4_000;
    while (!existsSync(trace) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(existsSync(trace), true, 'owned parent published its trace before the timeout');
    const pids = JSON.parse(readFileSync(trace, 'utf8')); assert.equal(pids.parent, owned.pid);
    descendant = pids.descendant; assert.ok(Number.isSafeInteger(descendant) && descendant > 0);
    const error = await pending;
    assert.ok(error instanceof SmokeError); assert.equal(error.code, 'owned_child_timeout'); assert.equal(error.childCleanup, 'complete');
    assert.equal(alive(owned.pid), false); assert.equal(alive(descendant), false, 'bounded receipt precedes settled timeout failure');
  } finally {
    // First let the bounded attempt finish. Its original ChildProcess owns
    // parent cleanup; a trace is not authority to stop a reused parent PID.
    const outcome = await pending;
    let treeCleanup = outcome.childCleanup;
    if (owned && owned.exitCode == null && owned.signalCode == null) treeCleanup = await stopWindowsProcessTree(owned);
    const waitGone = async pid => {
      const deadline = Date.now() + 5_000;
      while (alive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(alive(pid), false, 'owned fixture process must be gone before removing its files');
    };
    if (owned?.pid) await waitGone(owned.pid);
    // Read the now-stable trace even if readiness failed before assignment.
    // Only the exact parent object captured at spawn can bind its descendant.
    if (existsSync(trace)) {
      const recovered = JSON.parse(readFileSync(trace, 'utf8'));
      if (recovered.parent === owned?.pid && Number.isSafeInteger(recovered.descendant) && recovered.descendant > 0) {
        descendant = recovered.descendant;
      }
    }
    if (descendant) {
      if (alive(descendant)) { try { process.kill(descendant, 'SIGKILL'); } catch { /* owned fixture already gone */ } }
      await waitGone(descendant);
    } else assert.equal(treeCleanup, 'complete', 'unbound descendants plus uncertain cleanup retain the fixture');
    rmSync(fixture, { recursive: true, force: true });
  }
});
const stamp = { gitSha: 'a'.repeat(40), gitDirty: true, sourceFingerprint: 'b'.repeat(64), expectedSchemaVersion: 92 };
const expected = { version: '3.18.29-windows.1', stamp };
const entry = 'C:\\owned fixture\\installed app\\resources\\daemon\\dist\\index.js';
const served = { ...stamp, version: expected.version, packaged: true, schemaVersion: 92, entry,
  daemonProcessId: 4321, daemonInstanceId: '77777777-7777-4777-8777-777777777777', startedAt: '2026-10-06T02:00:00.000Z' };

test('installer effects require the x64 Windows ephemeral Actions host', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Windows', RUNNER_TEMP: 'C:\\runner\\temp' };
  assert.doesNotThrow(() => assertQualificationHost('win32', 'x64', env));
  refuses(() => assertQualificationHost('darwin', 'arm64', env), 'windows_x64_required');
  refuses(() => assertQualificationHost('win32', 'arm64', env), 'windows_x64_required');
  refuses(() => assertQualificationHost('win32', 'x64', {}), 'ephemeral_windows_actions_runner_required');
  refuses(() => assertQualificationHost('win32', 'x64', { ...env, RUNNER_TEMP: '' }), 'ephemeral_windows_actions_runner_required');
});

test('CLI requires a single exact release, version and receipt with no filename injection', () => {
  const args = ['--release-dir', 'release', '--expected-version', expected.version, '--receipt', 'output/receipt.json'];
  assert.equal(parseArguments(args).expectedVersion, expected.version);
  refuses(() => parseArguments(args.slice(0, -2)), 'invalid_arguments');
  refuses(() => parseArguments([...args, '--receipt', 'other']), 'invalid_arguments');
  refuses(() => parseArguments([...args, '--unknown', 'x']), 'invalid_arguments');
  refuses(() => parseArguments(['--release-dir', 'x', '--expected-version', '../3.0.0', '--receipt', 'r']), 'invalid_version');
});

test('owned paths reject sibling-prefix tricks, parent traversal and another Windows drive', () => {
  const root = 'C:\\runner\\owned fixture';
  assert.equal(isOwnedPath(`${root}\\profile\\AppData`, root), true);
  assert.equal(isOwnedPath(root.toUpperCase() + '\\file', root), true);
  assert.equal(isOwnedPath(root, root), false);
  assert.equal(isOwnedPath('C:\\runner\\owned fixture extra\\file', root), false);
  assert.equal(isOwnedPath(`${root}\\..\\someone-else`, root), false);
  assert.equal(isOwnedPath('D:\\owned fixture\\file', root), false);
});

test('child environment isolates desktop and daemon homes and strips inherited credentials/hooks', () => {
  const result = isolatedChildEnvironment({ SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32',
    USERPROFILE: 'C:\\Users\\real-user', APPDATA: 'C:\\real-appdata', CLEMENTINE_HOME: 'C:\\real-clem',
    OPENAI_API_KEY: 'never-forward', CLAUDE_CODE_OAUTH_TOKEN: 'never-forward', ANTHROPIC_API_KEY: 'never-forward',
    WEBHOOK_SECRET: 'never-forward', NODE_OPTIONS: '--require hook', ELECTRON_RUN_AS_NODE: '1',
    HTTPS_PROXY: 'https://user:secret@example.test', HOME: 'never-forward', CODEX_HOME: 'never-forward' },
  'C:\\fixture\\profile', 'C:\\fixture');
  assert.equal(result.USERPROFILE, 'C:\\fixture\\profile');
  assert.equal(result.CLEMENTINE_HOME, 'C:\\fixture\\selected Clem home');
  assert.notEqual(result.CLEMENTINE_HOME, path.win32.join(result.USERPROFILE, '.clementine-next'));
  assert.equal(result.APPDATA, 'C:\\fixture\\profile\\AppData\\Roaming');
  assert.equal(result.LOCALAPPDATA, 'C:\\fixture\\profile\\AppData\\Local');
  assert.equal(result.TEMP, 'C:\\fixture\\temp');
  assert.equal(result.CLEMMY_REAL_USER_HOME, result.USERPROFILE);
  assert.equal(result.CLEMMY_TEST_DISABLE_LIVE_MODELS, '1');
  for (const key of ['OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'WEBHOOK_SECRET',
    'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'HTTPS_PROXY', 'HOME', 'CODEX_HOME']) assert.equal(result[key], undefined);
  assert.equal(result.SystemRoot, 'C:\\Windows');
});

test('candidate requires exact source fingerprint, dirty state and positive schema', () => {
  assert.deepEqual(assertBuildStamp({ ...stamp, ignored: 'not recorded' }), stamp);
  for (const replacement of [{ gitSha: 'main' }, { gitDirty: 'true' }, { sourceFingerprint: 'a'.repeat(40) },
    { expectedSchemaVersion: 0 }, { expectedSchemaVersion: 1.5 }]) {
    refuses(() => assertBuildStamp({ ...stamp, ...replacement }), 'invalid_candidate_stamp');
  }
});

test('served identity rejects dirty-parent matches, substituted fingerprints, version/schema and another app entry', () => {
  const result = assertServedIdentity(served, expected, entry.toUpperCase());
  assert.equal(result.sourceFingerprint, stamp.sourceFingerprint);
  assert.equal(result.gitDirty, true);
  assert.equal(Object.hasOwn(result, 'entry'), false);
  for (const replacement of [{ gitDirty: false }, { gitSha: 'c'.repeat(40) }, { sourceFingerprint: 'd'.repeat(64) },
    { expectedSchemaVersion: 93 }]) {
    refuses(() => assertServedIdentity({ ...served, ...replacement }, expected, entry), 'served_candidate_mismatch');
  }
  for (const replacement of [{ version: '3.18.28' }, { schemaVersion: 91 }, { packaged: false },
    { entry: 'C:\\other\\resources\\daemon\\dist\\index.js' }, { daemonProcessId: 0 },
    { daemonInstanceId: '-'.repeat(36) }, { startedAt: 'unknown' }]) {
    refuses(() => assertServedIdentity({ ...served, ...replacement }, expected, entry), 'served_identity_unqualified');
  }
});

test('CDP endpoints must belong to the exact loopback listener and expected target kind', () => {
  const value = 'ws://127.0.0.1:9223/devtools/browser/a1b2-c3';
  assert.equal(assertCDPUrl(value, 9223, 'browser'), value);
  for (const url of [value.replace('127.0.0.1', 'example.test'), value.replace('127.0.0.1', 'localhost'),
    value.replace(':9223', ':9224'), value.replace('ws:', 'wss:'), `${value}?token=secret`, `${value}#secret`,
    value.replace('127.0.0.1', 'user:secret@127.0.0.1'), value.replace('browser', 'page')]) {
    refuses(() => assertCDPUrl(url, 9223, 'browser'), 'invalid_cdp_endpoint');
  }
  refuses(() => assertCDPUrl(value, 9223, '.*'), 'invalid_cdp_endpoint');
});

test('served assets must be same-origin bundled JavaScript, without traversal or credential URLs', () => {
  const origin = 'http://127.0.0.1:8521';
  assert.equal(consoleAssetRelative(`${origin}/console/assets/index-abc123.js`, origin), 'assets/index-abc123.js');
  for (const value of ['https://example.test/console/assets/a.js', `${origin}/console/assets/a.js?token=x`,
    `${origin}/console/assets/%2e%2e/a.js`, `${origin}/console/assets/a.js.map`, `${origin}/console/index.html`,
    `${origin}/assets/a.js`, `${origin}/console/assets/../../other.js`]) {
    refuses(() => consoleAssetRelative(value, origin), 'invalid_console_asset');
  }
});

test('actual console landing redirect remains observable but remote or unrelated targets do not qualify', () => {
  assert.equal(isDashboardTarget('http://127.0.0.1:8520/console?token=private'), true);
  assert.equal(isDashboardTarget('http://127.0.0.1:8520/console/chat'), true);
  assert.equal(isDashboardTarget('http://127.0.0.1:8520/console/chat/harness%3Asmoke'), true);
  for (const value of ['http://localhost:8520/console', 'https://example.test/console/chat', 'file:///console/chat',
    'http://127.0.0.1/console', 'http://user:password@127.0.0.1:8520/console',
    'http://127.0.0.1:8520/console/notch', 'http://127.0.0.1:8520/admin']) assert.equal(isDashboardTarget(value), false);
});

test('owned daemon proof requires its exact PID, executable, creation identity and app parent', () => {
  const executable = 'C:\\fixture\\installed app\\Clementine.exe';
  const row = { pid: 4321, parentPid: 1234, executable, createdAt: served.startedAt };
  assert.deepEqual(exactOwnedProcess([row], 4321, executable.toUpperCase(), 1234), row);
  for (const altered of [[], [{ ...row, executable: 'C:\\other\\Clementine.exe' }],
    [{ ...row, createdAt: 'unreadable' }], [{ ...row, parentPid: 9999 }]]) {
    refuses(() => exactOwnedProcess(altered, 4321, executable, 1234), 'process_ownership_unqualified');
  }
});

test('failure cleanup refuses PID reuse, an unowned executable or profile, and missing launch argument proof', () => {
  const root = 'C:\\runner\\owned fixture';
  const launch = { pid: 1234, executable: `${root}\\installed app\\Clementine.exe`,
    createdAt: served.startedAt, userData: `${root}\\profile\\electron-data` };
  const row = { pid: launch.pid, executable: launch.executable, createdAt: launch.createdAt, profileArgumentMatched: true };
  assert.doesNotThrow(() => assertFailureCleanupIdentity(row, launch, root));
  for (const altered of [{ ...row, pid: 9999 }, { ...row, executable: 'C:\\user app\\Clementine.exe' },
    { ...row, createdAt: '2026-10-06T02:01:00.000Z' }, { ...row, profileArgumentMatched: false },
    { ...row, profileArgumentMatched: undefined }, null]) {
    refuses(() => assertFailureCleanupIdentity(altered, launch, root), 'failure_cleanup_ownership_unqualified');
  }
  refuses(() => assertFailureCleanupIdentity(row, { ...launch, userData: 'C:\\user\\real profile' }, root),
    'failure_cleanup_ownership_unqualified');
});

test('packaged production storage driver is valid JavaScript without executing runtime imports or fixtures', () => {
  const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], {
    input: INSTALLED_STORAGE_PROBE, encoding: 'utf8',
  });
  assert.equal(checked.status, 0, checked.stderr);
});

test('mobile loopback gate requires trusted certificate authorization and the exact pin, with no disabled validation or credentials', async () => {
  const raw = Buffer.from('controlled synthetic certificate bytes');
  const fingerprint = createHash('sha256').update(raw).digest('base64url');
  const calls = []; let destroyed = 0;
  const connect = (authorized, peer = raw) => (options) => {
    calls.push(options); const socket = Object.assign(new EventEmitter(), {
      authorized, getPeerCertificate: () => ({ raw: peer }), destroy() { destroyed++; },
    }); queueMicrotask(() => socket.emit('secureConnect')); return socket;
  };
  assert.deepEqual(await pinnedLoopbackTlsHandshake({ port: 8841, certificatePem: 'controlled PEM', fingerprint }, connect(true)),
    { fingerprint, verifiedLoopbackHandshake: true, exactCertificatePin: true });
  assert.deepEqual(calls[0], { host: '127.0.0.1', port: 8841, servername: 'clementine.local', ca: 'controlled PEM', rejectUnauthorized: true, minVersion: 'TLSv1.2' });
  for (const connector of [connect(false), connect(true, Buffer.from('different certificate'))]) {
    await assert.rejects(pinnedLoopbackTlsHandshake({ port: 8841, certificatePem: 'controlled PEM', fingerprint }, connector),
      error => error instanceof SmokeError && error.code === 'mobile_tls_peer_pin_mismatch');
  }
  assert.equal(destroyed, 3);
  refuses(() => pinnedLoopbackTlsHandshake({ port: 0, certificatePem: 'controlled PEM', fingerprint }, connect(true)), 'mobile_tls_handshake_inputs_invalid');
});

test('uploaded storage receipt omits private key hashes, PEM and unrecognized mobile identity fields', () => {
  const publicReceipt = publicStorageReceipt({ sessionId: 'controlled-session', fileSha256: 'c'.repeat(64),
    privateMobileKeySha256: 'never-upload', privateMobileCertificateSha256: 'never-upload', keyPem: 'never-upload',
    mobileTls: { fingerprint: 'b'.repeat(43), existingProductionIdentityRetained: true, keyPem: 'never-upload' } });
  assert.equal(publicReceipt.sessionId, 'controlled-session');
  assert.deepEqual(publicReceipt.mobileTls, { fingerprint: 'b'.repeat(43), existingProductionIdentityRetained: true });
  assert.equal(JSON.stringify(publicReceipt).includes('never-upload'), false);
});

test('unsupported-host direct execution refuses before creating a receipt or fixture', { skip: process.platform === 'win32' }, () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clem-windows-smoke-helper-'));
  try {
    const receipt = path.join(temporary, 'must-not-exist', 'receipt.json');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./windows-packaged-launch-smoke.mjs', import.meta.url)),
      '--release-dir', temporary, '--expected-version', expected.version, '--receipt', receipt], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^\[Windows installed smoke\] windows_x64_required\s*$/);
    assert.equal(existsSync(path.dirname(receipt)), false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
