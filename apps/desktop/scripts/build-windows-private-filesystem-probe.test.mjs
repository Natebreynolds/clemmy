import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWindowsAclProbeManifest, buildWindowsAclProbe, PROBE_FILENAME, PROBE_RESPONSE,
  resolveWindowsAclCompiler, windowsCompilerEnvironment, WINDOWS_PRIVATE_FILESYSTEM_JSON_DRIVER } from './build-windows-private-filesystem-probe.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('compiler discovery uses exact installed Visual Studio executable, bounded literal argv and no provider environment', () => {
  const programRoot = 'C:\\Program Files (x86)';
  const vswhere = path.win32.join(programRoot, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const compiler = path.win32.join(programRoot, 'Microsoft Visual Studio', '2022', 'Enterprise', 'MSBuild', 'Current', 'Bin', 'Roslyn', 'csc.exe');
  const calls = [];
  const env = { 'PROGRAMFILES(X86)': programRoot, SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'controlled-secret', HOME: 'real-profile', PATH: 'project&path' };
  const result = resolveWindowsAclCompiler(env, (...args) => { calls.push(args); return { status: 0, stdout: compiler + '\r\n' }; }, filename => [vswhere, compiler].includes(filename));
  assert.equal(result, compiler); assert.equal(calls[0][0], vswhere);
  assert.deepEqual(calls[0][1], ['-latest', '-products', '*', '-requires', 'Microsoft.Component.MSBuild', '-find', 'MSBuild\\**\\Bin\\Roslyn\\csc.exe']);
  assert.equal(calls[0][2].timeout, 10_000); assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].env.OPENAI_API_KEY, undefined); assert.equal(calls[0][2].env.HOME, undefined);
  assert.equal(calls[0][2].env.PATH, undefined);
});

test('untrusted compiler discovery paths and missing compiler fail without shell or fallback', () => {
  const env = { ProgramFiles: 'C:\\Program Files' };
  for (const stdout of ['C:\\project\\csc.exe', 'csc.exe', 'C:\\Program Files\\..\\project\\csc.exe', 'C:\\Program Files\\VS\\runner.cmd']) {
    assert.throws(() => resolveWindowsAclCompiler(env, () => ({ status: 0, stdout }), () => true), /outside/);
  }
  assert.throws(() => resolveWindowsAclCompiler({ ProgramFiles: 'relative' }), /absolute/);
  assert.throws(() => resolveWindowsAclCompiler(env, () => ({ status: 1, stdout: '' }), () => true), /discovery failed/);
  assert.deepEqual(windowsCompilerEnvironment({ sYsTeMrOoT: 'C:\\Windows', TMP: 'tmp', Claude_Code_Oauth_Token: 'no', Path: 'unsafe', USERPROFILE: 'profile' }), { sYsTeMrOoT: 'C:\\Windows', TMP: 'tmp' });
});

test('probe manifest binds canonical class, JSON driver, binary bytes and deterministic build metadata', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'clem-probe-manifest-'));
  const bytes = Buffer.from('controlled manifest bytes, not an executable');
  const classSource = 'controlled canonical class';
  const manifest = { version: 2, target: 'windows-x64-netframework4', classSourceSha256: sha(classSource),
    driverSourceSha256: sha(WINDOWS_PRIVATE_FILESYSTEM_JSON_DRIVER), probeSha256: sha(bytes), probeBytes: bytes.length,
    compilerSha256: 'a'.repeat(64), deterministic: true, response: PROBE_RESPONSE };
  try {
    writeFileSync(path.join(fixture, PROBE_FILENAME), bytes);
    writeFileSync(path.join(fixture, 'manifest.json'), JSON.stringify(manifest));
    assert.deepEqual(assertWindowsAclProbeManifest(fixture, classSource), manifest);
    assert.throws(() => assertWindowsAclProbeManifest(fixture, classSource + ' changed'), /canonical/);
    assert.throws(() => assertWindowsAclProbeManifest(fixture, classSource, 'changed driver'), /canonical/);
    writeFileSync(path.join(fixture, PROBE_FILENAME), 'changed bytes');
    assert.throws(() => assertWindowsAclProbeManifest(fixture, classSource), /canonical/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('native compilation refuses another platform before compile/import actions', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(buildWindowsAclProbe(), /actual Windows x64/);
});

test('actual compiled Windows probe rejects malformed/extra/duplicated/coerced requests without target effects or private output', {
  skip: process.platform !== 'win32',
}, () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'clem-private-probe-driver-'));
  const target = path.join(fixture, "literal & ' 文件");
  writeFileSync(target, 'controlled preserved bytes');
  const input = { version: 2, path: target, dev: '0', ino: '0', nlink: '1', directory: false, harden: false, allowInheritedPrivate: false, syntheticDiagnostic: false };
  const raw = JSON.stringify(input);
  const cases = [raw.replace('"version":2', '"version":2,"version":2'),
    JSON.stringify({ ...input, extra: 'must not be accepted' }),
    JSON.stringify({ ...input, harden: 'false' }), JSON.stringify({ ...input, version: 1 }),
    JSON.stringify({ ...input, harden: true, allowInheritedPrivate: true }),
    JSON.stringify({ ...input, nlink: undefined }), raw + '{}', '{broken'];
  try {
    for (const value of cases) {
      const result = spawnSync(path.join(root, 'output/windows-private-filesystem', PROBE_FILENAME), [], {
        input: value, env: windowsCompilerEnvironment(process.env), encoding: 'utf8', shell: false, windowsHide: true, timeout: 2_000, maxBuffer: 4096,
      });
      assert.equal(result.error, undefined, 'compiled probe must actually launch on Windows');
      assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'private-acl-refused-v2');
      assert.equal(readFileSync(target, 'utf8'), 'controlled preserved bytes');
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
