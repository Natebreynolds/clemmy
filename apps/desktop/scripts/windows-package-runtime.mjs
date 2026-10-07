import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function assertBinaryMatchesManifest(binary, manifest) {
  const bytes = readFileSync(binary);
  if (bytes.length !== manifest.binaryBytes
    || createHash('sha256').update(bytes).digest('hex') !== manifest.binarySha256) {
    throw new Error('Packaged binary differs from its verified provenance manifest.');
  }
}

export function assertUvVersion(output, expectedVersion) {
  if (output.trim().split(/\s+/)[0] !== 'uv'
    || output.trim().split(/\s+/)[1] !== expectedVersion) {
    throw new Error('Packaged uv does not match the pinned runtime version.');
  }
}

export function assertWindowsClaudeSdkAssets(daemonDir, expectedSdkVersion) {
  const sdkName = '@anthropic-ai/claude-agent-sdk';
  const nativeName = '@anthropic-ai/claude-agent-sdk-win32-x64';
  const sdkRoot = path.join(daemonDir, 'node_modules', ...sdkName.split('/'));
  const nativeRoot = path.join(daemonDir, 'node_modules', ...nativeName.split('/'));
  const sdk = JSON.parse(readFileSync(path.join(sdkRoot, 'package.json'), 'utf8'));
  const native = JSON.parse(readFileSync(path.join(nativeRoot, 'package.json'), 'utf8'));
  if (sdk.name !== sdkName || native.name !== nativeName
    || typeof expectedSdkVersion !== 'string' || sdk.version !== expectedSdkVersion
    || native.version !== sdk.version || sdk.optionalDependencies?.[nativeName] !== sdk.version) {
    throw new Error('Packaged Claude SDK and its Windows x64 executable package must match the locked SDK version.');
  }
  const runtimeAssetSha256 = {};
  for (const name of ['sdk.mjs', 'bridge.mjs', 'extractFromBunfs.js', 'browser-sdk.js', 'manifest.json', 'manifest.zst.json']) {
    const file = statSync(path.join(sdkRoot, name));
    if (!file.isFile() || file.size === 0) throw new Error(`Packaged Claude SDK helper is missing: ${name}`);
    runtimeAssetSha256[name] = createHash('sha256').update(readFileSync(path.join(sdkRoot, name))).digest('hex');
  }
  const executable = path.join(nativeRoot, 'claude.exe');
  const file = statSync(executable);
  if (!file.isFile() || file.size === 0) throw new Error('Packaged Claude SDK Windows executable is missing.');
  return { sdkVersion: sdk.version, nativeVersion: native.version, executable,
    executableSha256: createHash('sha256').update(readFileSync(executable)).digest('hex'), runtimeAssetSha256 };
}

// Exercise the native modules with the packaged Electron interpreter, rather
// than the build machine's Node ABI. The database exists only in memory and
// loading keytar never reads or writes a credential.
export const WINDOWS_NATIVE_CORE_PROBE = `
import { createRequire } from 'node:module';
import path from 'node:path';
const resources = process.env.CLEMENTINE_PACKAGE_PROBE_RESOURCES;
const requireDaemon = createRequire(path.join(resources, 'daemon', 'package.json'));
const Database = requireDaemon('better-sqlite3');
const db = new Database(':memory:');
let row;
try {
  db.exec('CREATE TABLE probe (value INTEGER NOT NULL)');
  db.transaction(() => db.prepare('INSERT INTO probe VALUES (?)').run(127))();
  row = db.prepare('SELECT value FROM probe').get();
} finally { db.close(); }
const requireKeytar = createRequire(path.join(resources, 'app.asar.unpacked', 'node_modules', 'keytar', 'package.json'));
const keytar = requireKeytar('./lib/keytar.js');
if (typeof keytar.getPassword !== 'function') throw new Error('Packaged keytar native binding did not load.');
const requireDesktop = createRequire(path.join(resources, 'app.asar', 'package.json'));
const credentials = requireDesktop('./dist/credential-private-filesystem.cjs');
for (const name of ['readCredentialFileSync','readCredentialSourceFileSync','writeCredentialFileSync','assertCredentialFileReadable','isCredentialStoragePrivacyError']) {
  if (typeof credentials[name] !== 'function') throw new Error('Packaged canonical credential policy did not load.');
}
const credentialFixture = path.join(process.env.CLEMENTINE_HOME, 'controlled-credential-policy-fixture');
const started = performance.now();
credentials.writeCredentialFileSync(credentialFixture, 'controlled fixture, no actual credential');
const credentialPolicyRoundtrip = credentials.readCredentialFileSync(credentialFixture) === 'controlled fixture, no actual credential';
if (!credentialPolicyRoundtrip) throw new Error('Packaged credential privacy roundtrip failed.');
console.log(JSON.stringify({ protocol: 'clementine_windows_native_core_v1',
  platform: process.platform, arch: process.arch,
  electron: process.versions.electron, node: process.versions.node,
  modules: process.versions.modules, sqliteValue: row.value, keytarLoaded: true,
  credentialPolicyLoaded: true, syntheticCredentialRoundtrip: credentialPolicyRoundtrip,
  syntheticCredentialLatencyMs: Math.ceil(performance.now() - started),
  credentialOperations: 0, providerCalls: 0 }));
`;

export function parseWindowsNativeCoreObservation(output) {
  const lines = output.trim().split(/\r?\n/);
  if (lines.length !== 1) throw new Error('Packaged native probe returned an unexpected response.');
  const result = JSON.parse(lines[0]);
  if (result.protocol !== 'clementine_windows_native_core_v1'
    || result.platform !== 'win32' || result.arch !== 'x64'
    || typeof result.electron !== 'string' || !/^\d+\.\d+\.\d+/.test(result.electron)
    || typeof result.node !== 'string' || !/^\d+\.\d+\.\d+/.test(result.node)
    || typeof result.modules !== 'string' || !/^\d+$/.test(result.modules)
    || result.sqliteValue !== 127 || result.keytarLoaded !== true
    || result.credentialPolicyLoaded !== true || result.syntheticCredentialRoundtrip !== true
    || !Number.isSafeInteger(result.syntheticCredentialLatencyMs) || result.syntheticCredentialLatencyMs < 0 || result.syntheticCredentialLatencyMs > 15_000
    || result.credentialOperations !== 0 || result.providerCalls !== 0) {
    throw new Error('Packaged native probe did not establish Windows Electron/SQLite/keytar readiness.');
  }
  return result;
}

export function classifyWindowsNativeCoreFailure(result) {
  if (result.error?.code === 'ETIMEDOUT') return 'probe_timeout';
  if (result.error) return 'interpreter_launch_failed';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (/NODE_MODULE_VERSION|compiled against a different Node\.js version/i.test(stderr)) return 'native_abi_mismatch';
  if (/MODULE_NOT_FOUND|Cannot find module/i.test(stderr)) return 'packaged_module_missing';
  if (/ERR_DLOPEN_FAILED|not a valid Win32 application|specified module could not be found/i.test(stderr)) return 'native_binding_load_failed';
  return 'probe_nonzero_exit';
}

export function windowsClaudeVersionEnvironment(parentEnv, fixtureRoot) {
  const env = {};
  const allowed = new Set(['systemroot', 'windir', 'comspec', 'path', 'pathext',
    'processor_architecture', 'processor_identifier', 'number_of_processors',
    'programfiles', 'programfiles(x86)', 'programw6432', 'programdata']);
  for (const [key, value] of Object.entries(parentEnv)) {
    if (allowed.has(key.toLowerCase()) && typeof value === 'string') env[key] = value;
  }
  const profile = path.win32.join(fixtureRoot, 'profile');
  Object.assign(env, {
    USERPROFILE: profile,
    APPDATA: path.win32.join(profile, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.win32.join(profile, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: path.win32.join(profile, '.claude'),
    CLEMENTINE_HOME: path.win32.join(profile, '.clementine-next'),
    TEMP: path.win32.join(fixtureRoot, 'temp'), TMP: path.win32.join(fixtureRoot, 'temp'),
    CLEMMY_TEST_DISABLE_LIVE_MODELS: '1', OPENAI_AGENTS_DISABLE_TRACING: '1',
  });
  return env;
}

export function parseWindowsClaudeNativeVersion(output) {
  // Keep the runtime's existing client-version contract. The native CLI client
  // and the Agent SDK have independent versions.
  const match = output.trim().match(/^(\d+\.\d+\.\d+)(?:\s|$)/);
  if (!match) throw new Error('Packaged Claude native client did not report a valid version.');
  return match[1];
}

export function verifyWindowsClaudeNativeLaunch(executable) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Packaged Claude native launch qualification requires an actual Windows x64 host.');
  }
  if (!statSync(executable).isFile()) throw new Error('Packaged Claude native executable is missing.');
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'clem-win-claude-version-'));
  try {
    const env = windowsClaudeVersionEnvironment(process.env, fixtureRoot);
    for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR', 'CLEMENTINE_HOME', 'TEMP']) {
      mkdirSync(env[key], { recursive: true });
    }
    const result = spawnSync(executable, ['--version'], {
      env, cwd: fixtureRoot, encoding: 'utf8', shell: false, windowsHide: true,
      timeout: 5_000, maxBuffer: 64 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Packaged Claude native version probe failed: ${classifyWindowsNativeCoreFailure(result)}.`);
    }
    return { clientVersion: parseWindowsClaudeNativeVersion(result.stdout), nativeLaunchQualified: true,
      credentialOperations: 0, providerCalls: 0, sdkApiAccepted: false };
  } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
}

export function verifyWindowsNativeCore({ executable, resourcesDir }) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Packaged Windows native qualification requires an actual Windows x64 host.');
  }
  if (!statSync(executable).isFile()) throw new Error('Packaged Electron executable is missing.');
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-win-native-core-'));
  try {
    const env = { ...process.env, CLEMENTINE_HOME: home,
      ELECTRON_RUN_AS_NODE: '1', CLEMENTINE_PACKAGE_PROBE_RESOURCES: path.resolve(resourcesDir) };
    for (const key of Object.keys(env)) {
      if (/^(?:ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_|BYO_|COMPOSIO_|RECALL_|BROWSERBASE_)/i.test(key)) delete env[key];
    }
    const result = spawnSync(executable, ['--input-type=module', '-e', WINDOWS_NATIVE_CORE_PROBE], {
      cwd: resourcesDir, env, encoding: 'utf8', shell: false, timeout: 30_000, maxBuffer: 64 * 1024,
    });
    if (result.error || result.status !== 0) {
      // Keep a useful closed diagnosis in the public build log without exposing
      // arbitrary child output or inherited environment values.
      throw new Error(`Packaged Windows native probe failed: ${classifyWindowsNativeCoreFailure(result)}.`);
    }
    return parseWindowsNativeCoreObservation(result.stdout);
  } finally { rmSync(home, { recursive: true, force: true }); }
}
