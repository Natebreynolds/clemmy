import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCliProbeRunner } from './cli-probe-process.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-cli-probe-windows-'));
process.env.CLEMENTINE_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

function fixture(name: string, body: string): string {
  const dir = path.join(home, `space & café 日本語 ${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'probe fixture.mjs'), body);
  const shim = path.join(dir, `${name}.cmd`);
  // Fixed owned fixture only: no credential/login/provider commands. This is
  // the same quoted interpreter + adjacent script structure as an npm shim.
  writeFileSync(shim, '@echo off\r\n"%CLEMMY_TEST_PROBE_NODE%" "%~dp0probe fixture.mjs" %*\r\n');
  return shim;
}

test('actual Windows batch shim receives literal spaced/Unicode/ampersand argv', { skip: process.platform !== 'win32' }, async () => {
  const executable = fixture('literal', "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.stderr.write('owned diagnostic');");
  const args = ['--version', 'argument with spaces', 'café 日本語', 'literal & argument'];
  const result = await createCliProbeRunner()(executable, args, {
    cwd: home, timeoutMs: 20_000, env: { ...process.env, CLEMMY_TEST_PROBE_NODE: process.execPath },
  });
  assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.timedOut, false);
  assert.deepEqual(JSON.parse(result.stdout), args); assert.equal(result.stderr, 'owned diagnostic');
});

test('actual Windows discovery and auth-health launch owned .cmd probes and preserve account/stale semantics', { skip: process.platform !== 'win32' }, async () => {
  const discovery = await import('./cli-discovery.js');
  const health = await import('../integrations/cli-catalog/auth-health.js');
  const marker = path.join(home, 'observed.json');
  const state = path.join(home, 'mode.txt'); writeFileSync(state, 'ok');
  const executable = fixture('owned-probe', `import fs from 'node:fs';
const mode = fs.readFileSync(${JSON.stringify(state)}, 'utf8');
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));
if (process.argv.includes('--version')) { process.stdout.write('owned-probe 1.0 café'); }
else if (mode === 'ok') { process.stdout.write('Logged in as fixture@example.test'); }
else if (mode === 'signed_out') { process.stdout.write('Unauthorized. Please login'); process.exitCode=1; }
else { process.stderr.write('owned transient failure'); process.exitCode=1; }`);
  const savedNode = process.env.CLEMMY_TEST_PROBE_NODE;
  process.env.CLEMMY_TEST_PROBE_NODE = process.execPath;
  health._testOnly_setCommandResolver(command => ({ skipped: false, command, path: executable }));
  try {
    const entry = await discovery.probe('owned-probe', executable);
    assert.equal(entry?.isLikelyCli, true); assert.equal(entry?.version, 'owned-probe 1.0 café');
    const seen = JSON.parse(readFileSync(marker, 'utf8'));
    assert.deepEqual(seen.args, ['--version']); assert.notEqual(seen.cwd, home); assert.equal(existsSync(seen.cwd), false);
    const good = await health.getCliHealth('railway', { force: true });
    assert.equal(good.authStatus, 'ok'); assert.equal(good.username, 'fixture@example.test');
    writeFileSync(state, 'transient');
    const stale = await health.getCliHealth('railway', { force: true });
    assert.equal(stale.authStatus, 'ok'); assert.equal(stale.username, good.username);
    assert.equal(stale.staleSince, good.checkedAt); assert.ok(stale.lastProbeError);
    writeFileSync(state, 'signed_out');
    const signedOut = await health.getCliHealth('railway', { force: true });
    assert.equal(signedOut.authStatus, 'signed_out'); assert.equal(signedOut.username, undefined); assert.equal(signedOut.staleSince, undefined);
  } finally {
    health._testOnly_setCommandResolver(); health._testOnly_stopCliHealthSweep();
    if (savedNode === undefined) delete process.env.CLEMMY_TEST_PROBE_NODE;
    else process.env.CLEMMY_TEST_PROBE_NODE = savedNode;
  }
});

test('actual Windows timed-out batch probe stops its owned Node descendants before returning', { skip: process.platform !== 'win32' }, async () => {
  const marker = path.join(home, 'timeout-pids.json');
  const executable = fixture('timeout', `import fs from 'node:fs'; import {spawn} from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'inherit',windowsHide:true});
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid,child.pid]));
process.stdout.write('partial response cannot qualify'); setInterval(()=>{},1000);`);
  const result = await createCliProbeRunner()(executable, ['--version'], {
    cwd: home, timeoutMs: 5_000, env: { ...process.env, CLEMMY_TEST_PROBE_NODE: process.execPath },
  });
  assert.equal(result.timedOut, true); assert.equal(result.exitCode, null);
  assert.equal(result.cleanupIncomplete, undefined, 'taskkill must provide its successful tree-stop receipt');
  assert.ok(existsSync(marker), 'the fixture must actually start its descendants before this can qualify timeout cleanup');
  const pids = JSON.parse(readFileSync(marker, 'utf8')) as number[];
  assert.equal(pids.length, 2);
  for (const pid of pids) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), 'an exact owned descendant must no longer be running when the probe returns');
  }
});
