import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertBinaryMatchesManifest, assertUvVersion, assertWindowsClaudeSdkAssets, classifyWindowsNativeCoreFailure, parseWindowsClaudeNativeVersion, parseWindowsNativeCoreObservation, verifyWindowsClaudeNativeLaunch, verifyWindowsNativeCore, windowsClaudeVersionEnvironment } from './windows-package-runtime.mjs';

test('uv version gate rejects an existing stale vendor cache or another executable', () => {
  assertUvVersion('uv 0.11.19 (verified build)\r\n', '0.11.19');
  assert.throws(() => assertUvVersion('uv 0.11.18 (older cache)', '0.11.19'), /pinned runtime version/);
  assert.throws(() => assertUvVersion('python 0.11.19', '0.11.19'), /pinned runtime version/);
});

test('Windows SDK asset gate rejects absent native dependencies, helpers and a version mismatch', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-win-sdk-assets-'));
  const sdkRoot = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  const nativeRoot = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64');
  const sdk = { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.280',
    optionalDependencies: { '@anthropic-ai/claude-agent-sdk-win32-x64': '0.3.280' } };
  const native = { name: '@anthropic-ai/claude-agent-sdk-win32-x64', version: '0.3.280' };
  try {
    mkdirSync(sdkRoot, { recursive: true });
    writeFileSync(path.join(sdkRoot, 'package.json'), JSON.stringify(sdk));
    for (const file of ['sdk.mjs', 'bridge.mjs', 'extractFromBunfs.js', 'browser-sdk.js', 'manifest.json', 'manifest.zst.json']) {
      writeFileSync(path.join(sdkRoot, file), 'runtime asset');
    }
    assert.throws(() => assertWindowsClaudeSdkAssets(dir, sdk.version), /ENOENT/);
    mkdirSync(nativeRoot, { recursive: true });
    writeFileSync(path.join(nativeRoot, 'package.json'), JSON.stringify(native));
    writeFileSync(path.join(nativeRoot, 'claude.exe'), 'native package asset');
    assert.equal(assertWindowsClaudeSdkAssets(dir, sdk.version).sdkVersion, sdk.version);
    writeFileSync(path.join(nativeRoot, 'package.json'), JSON.stringify({ ...native, version: '0.3.279' }));
    assert.throws(() => assertWindowsClaudeSdkAssets(dir, sdk.version), /locked SDK version/);
    writeFileSync(path.join(nativeRoot, 'package.json'), JSON.stringify(native));
    assert.throws(() => assertWindowsClaudeSdkAssets(dir, '0.3.279'), /locked SDK version/);
    rmSync(path.join(sdkRoot, 'extractFromBunfs.js'));
    assert.throws(() => assertWindowsClaudeSdkAssets(dir, sdk.version), /ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('packaged binary qualification detects changed bytes and truncation despite matching version metadata', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-binary-manifest-'));
  try {
    const binary = path.join(dir, 'whisper-cli.exe');
    const bytes = Buffer.from('exact build bytes');
    const manifest = { binaryBytes: bytes.length, binarySha256: createHash('sha256').update(bytes).digest('hex') };
    writeFileSync(binary, bytes);
    assertBinaryMatchesManifest(binary, manifest);
    writeFileSync(binary, Buffer.from('other build bytes'));
    assert.throws(() => assertBinaryMatchesManifest(binary, manifest), /differs/);
    writeFileSync(binary, bytes.subarray(0, 8));
    assert.throws(() => assertBinaryMatchesManifest(binary, manifest), /differs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('native observation cannot pass a build-host Node result or incomplete native-module checks', () => {
  const valid = { protocol: 'clementine_windows_native_core_v1', platform: 'win32', arch: 'x64',
    electron: '43.0.0', node: '24.13.0', modules: '150', sqliteValue: 127,
    keytarLoaded: true, credentialPolicyLoaded: true, syntheticCredentialRoundtrip: true,
    syntheticCredentialLatencyMs: 120, credentialOperations: 0, providerCalls: 0 };
  assert.deepEqual(parseWindowsNativeCoreObservation(JSON.stringify(valid)), valid);
  for (const changed of [{ electron: undefined }, { platform: 'darwin' }, { arch: 'arm64' },
    { sqliteValue: 0 }, { keytarLoaded: false }, { providerCalls: 1 }, { credentialOperations: 1 },
    { credentialPolicyLoaded: false }, { syntheticCredentialRoundtrip: false }, { syntheticCredentialLatencyMs: 15_001 }, { syntheticCredentialLatencyMs: -1 }]) {
    assert.throws(() => parseWindowsNativeCoreObservation(JSON.stringify({ ...valid, ...changed })), /did not establish/);
  }
  assert.throws(() => parseWindowsNativeCoreObservation(`${JSON.stringify(valid)}\n${JSON.stringify(valid)}`), /unexpected/);
});

test('physical Windows native probe refuses to run on another platform', { skip: process.platform === 'win32' }, () => {
  assert.throws(() => verifyWindowsNativeCore({ executable: 'never-executed', resourcesDir: 'never-read' }), /actual Windows x64/);
  assert.throws(() => verifyWindowsClaudeNativeLaunch('never-executed'), /actual Windows x64/);
});

test('native failures retain a closed diagnosis without forwarding arbitrary child errors', () => {
  for (const [result, expected] of [
    [{ error: { code: 'ETIMEDOUT' } }, 'probe_timeout'],
    [{ error: { code: 'ENOENT' }, stderr: 'private-sentinel' }, 'interpreter_launch_failed'],
    [{ stderr: 'compiled against a different Node.js version using NODE_MODULE_VERSION 127' }, 'native_abi_mismatch'],
    [{ stderr: "Error: Cannot find module 'better-sqlite3'" }, 'packaged_module_missing'],
    [{ stderr: 'ERR_DLOPEN_FAILED: The specified module could not be found' }, 'native_binding_load_failed'],
    [{ stderr: 'arbitrary-private-sentinel', status: 1 }, 'probe_nonzero_exit'],
  ]) {
    const actual = classifyWindowsNativeCoreFailure(result);
    assert.equal(actual, expected);
    assert.doesNotMatch(actual, /sentinel/);
  }
});

test('native client version qualification never equates CLI and SDK versions or forwards raw output', () => {
  assert.equal(parseWindowsClaudeNativeVersion('9.12.345 (Claude Code)\r\n'), '9.12.345');
  assert.equal(parseWindowsClaudeNativeVersion('9.12.345\nprivate-sentinel'), '9.12.345');
  for (const invalid of ['private-sentinel', '9.12', '9.12.345x', 'sdk 0.3.280']) {
    assert.throws(() => parseWindowsClaudeNativeVersion(invalid), /valid version/);
  }
});

test('native --version probe uses an owned empty profile and excludes credentials, hooks and HOME overrides', () => {
  const result = windowsClaudeVersionEnvironment({ SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32',
    USERPROFILE: 'C:\\Users\\real-user', HOME: 'real-home', APPDATA: 'real-app-data',
    ANTHROPIC_API_KEY: 'private-sentinel', openai_api_key: 'private-sentinel',
    Claude_Config_Dir: 'real-claude-auth', CODEX_HOME: 'real-codex-auth', HTTPS_PROXY: 'private-sentinel',
    NODE_OPTIONS: '--require private-hook', ELECTRON_RUN_AS_NODE: '1' }, 'C:\\owned-fixture');
  assert.equal(result.SystemRoot, 'C:\\Windows');
  assert.equal(result.Path, 'C:\\Windows\\System32');
  assert.equal(result.USERPROFILE, 'C:\\owned-fixture\\profile');
  assert.equal(result.CLAUDE_CONFIG_DIR, 'C:\\owned-fixture\\profile\\.claude');
  assert.equal(result.CLEMENTINE_HOME, 'C:\\owned-fixture\\profile\\.clementine-next');
  for (const key of ['HOME', 'ANTHROPIC_API_KEY', 'openai_api_key', 'Claude_Config_Dir', 'CODEX_HOME',
    'HTTPS_PROXY', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) assert.equal(result[key], undefined);
  assert.doesNotMatch(JSON.stringify(result), /private-sentinel|real-user|real-claude-auth/);
});
