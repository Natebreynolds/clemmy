/**
 * Actual unsigned NSIS/desktop qualification on an ephemeral Windows Actions
 * runner. This is deliberately not a provider, Browserbase, or tester claim.
 * No setup markers, SQLite rows, or application APIs are forged. The existing
 * wizard Skip button is clicked; the app owns startup and graceful shutdown.
 * Only after shutdown do installed production storage APIs create a synthetic
 * fixture, which the same installed app must expose after restart.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSemVer } from './release-candidate-version.mjs';

export class SmokeError extends Error {
  constructor(code, childCleanup) {
    super(code); this.code = code;
    if (['complete', 'incomplete', 'not_started'].includes(childCleanup)) this.childCleanup = childCleanup;
  }
}
const refuse = (code) => { throw new SmokeError(code); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonFile = (file) => JSON.parse(readFileSync(file, 'utf8'));
const winPath = (value) => path.win32.resolve(value).toLowerCase();

export function assertQualificationHost(platform, arch, env) {
  if (platform !== 'win32' || arch !== 'x64') refuse('windows_x64_required');
  // NSIS writes the current user's install registry/shortcuts even with /D.
  // This gate cannot be run on a tester's or developer's ordinary account.
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_OS !== 'Windows' || !env.RUNNER_TEMP) {
    refuse('ephemeral_windows_actions_runner_required');
  }
}

export function parseArguments(args, cwd = process.cwd()) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--release-dir', '--expected-version', '--receipt'].includes(key) || values[key] || !args[index + 1]) {
      refuse('invalid_arguments');
    }
    values[key] = args[index + 1];
  }
  if (Object.keys(values).length !== 3) refuse('invalid_arguments');
  try { parseSemVer(values['--expected-version']); } catch { refuse('invalid_version'); }
  // Also constrain the version used in an exact installer filename.
  if (!/^[0-9A-Za-z.+-]+$/.test(values['--expected-version'])) refuse('invalid_version');
  return {
    releaseDir: path.resolve(cwd, values['--release-dir']),
    expectedVersion: values['--expected-version'],
    receipt: path.resolve(cwd, values['--receipt']),
  };
}

export function isOwnedPath(file, directory, pathApi = path.win32) {
  const relative = pathApi.relative(pathApi.resolve(directory), pathApi.resolve(file));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative);
}

export function isolatedChildEnvironment(parentEnv, profile, fixtureRoot) {
  // Allowlist avoids inherited OAuth/API keys, auth-file pointers, proxy URLs,
  // NODE_OPTIONS, Electron-as-Node, and a developer's home overrides.
  const result = {};
  const allowed = new Set(['systemroot', 'windir', 'comspec', 'path', 'pathext', 'processor_architecture',
    'processor_identifier', 'number_of_processors', 'programfiles', 'programfiles(x86)', 'programw6432', 'programdata']);
  for (const [key, value] of Object.entries(parentEnv)) {
    if (allowed.has(key.toLowerCase()) && typeof value === 'string') result[key] = value;
  }
  Object.assign(result, {
    USERPROFILE: profile,
    APPDATA: path.win32.join(profile, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.win32.join(profile, 'AppData', 'Local'),
    TEMP: path.win32.join(fixtureRoot, 'temp'), TMP: path.win32.join(fixtureRoot, 'temp'),
    // Distinct from os.homedir()/.clementine-next so the real setup/daemon
    // roundtrip catches a bridge silently ignoring an explicitly selected home.
    CLEMENTINE_HOME: path.win32.join(fixtureRoot, 'selected Clem home'),
    CLEMMY_REAL_USER_HOME: profile,
    CLEMMY_TEST_ISOLATED_HOME: '1', CLEMMY_TEST_DISABLE_LIVE_MODELS: '1',
    OPENAI_AGENTS_DISABLE_TRACING: '1', EMBEDDINGS_DISABLED: 'true', MCP_AUTO_IMPORT_ENABLED: 'false',
  });
  return result;
}

export function assertBuildStamp(stamp) {
  if (!stamp || !/^[a-f0-9]{40}$/.test(stamp.gitSha) || typeof stamp.gitDirty !== 'boolean'
    || !/^[a-f0-9]{64}$/.test(stamp.sourceFingerprint)
    || !Number.isSafeInteger(stamp.expectedSchemaVersion) || stamp.expectedSchemaVersion <= 0) {
    refuse('invalid_candidate_stamp');
  }
  return {
    gitSha: stamp.gitSha, gitDirty: stamp.gitDirty, sourceFingerprint: stamp.sourceFingerprint,
    expectedSchemaVersion: stamp.expectedSchemaVersion,
  };
}

export function assertServedIdentity(info, expected, installedEntry) {
  for (const key of ['gitSha', 'gitDirty', 'sourceFingerprint', 'expectedSchemaVersion']) {
    if (info?.[key] !== expected.stamp[key]) refuse('served_candidate_mismatch');
  }
  if (info.version !== expected.version || info.schemaVersion !== expected.stamp.expectedSchemaVersion
    || info.packaged !== true || typeof info.entry !== 'string' || winPath(info.entry) !== winPath(installedEntry)
    || !Number.isSafeInteger(info.daemonProcessId) || info.daemonProcessId <= 0
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(info.daemonInstanceId ?? '')
    || !Number.isFinite(Date.parse(info.startedAt))) refuse('served_identity_unqualified');
  return {
    version: info.version, ...expected.stamp, schemaVersion: info.schemaVersion, packaged: true,
    daemonProcessId: info.daemonProcessId, daemonInstanceId: info.daemonInstanceId, startedAt: info.startedAt,
  };
}

export function assertCDPUrl(value, port, kind) {
  if (!['browser', 'page'].includes(kind)) refuse('invalid_cdp_endpoint');
  let url;
  try { url = new URL(value); } catch { refuse('invalid_cdp_endpoint'); }
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.port !== String(port)
    || url.username || url.password || url.search || url.hash
    || !new RegExp(`^/devtools/${kind}/[A-Za-z0-9-]+$`).test(url.pathname)) refuse('invalid_cdp_endpoint');
  return url.href;
}

export function consoleAssetRelative(value, origin) {
  let url;
  try { url = new URL(value); } catch { refuse('invalid_console_asset'); }
  if (url.origin !== origin || url.username || url.password || url.search || url.hash
    || !/^\/console\/assets\/[A-Za-z0-9._-]+\.js$/.test(url.pathname)) refuse('invalid_console_asset');
  return url.pathname.slice('/console/'.length);
}

export function isDashboardTarget(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) > 0
      && !url.username && !url.password && /^\/console(?:\/chat(?:\/[^/]*)?)?\/?$/.test(url.pathname);
  } catch { return false; }
}

export function exactOwnedProcess(rows, pid, executable, parentPid) {
  const row = rows.find((item) => item.pid === pid);
  if (!row || typeof row.executable !== 'string' || winPath(row.executable) !== winPath(executable)
    || !Number.isFinite(Date.parse(row.createdAt)) || (parentPid !== undefined && row.parentPid !== parentPid)) {
    refuse('process_ownership_unqualified');
  }
  return { pid: row.pid, parentPid: row.parentPid, executable: row.executable, createdAt: row.createdAt };
}

export function assertFailureCleanupIdentity(row, launch, fixtureRoot) {
  if (!row || row.pid !== launch.pid || typeof row.executable !== 'string'
    || winPath(row.executable) !== winPath(launch.executable)
    || !isOwnedPath(row.executable, fixtureRoot) || !isOwnedPath(launch.userData, fixtureRoot)
    || typeof row.createdAt !== 'string' || row.createdAt !== launch.createdAt
    || row.profileArgumentMatched !== true) refuse('failure_cleanup_ownership_unqualified');
}

/** Trust only the owned fixture certificate and verify the exact paired pin. */
export function pinnedLoopbackTlsHandshake({ port, certificatePem, fingerprint }, connectTls = tls.connect) {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535 || typeof certificatePem !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(fingerprint ?? '')) refuse('mobile_tls_handshake_inputs_invalid');
  return new Promise((resolve, reject) => {
    let socket; let timer; let finished = false;
    const finish = (code) => {
      if (finished) return; finished = true; clearTimeout(timer);
      // This is a handshake-only fixture, with no auth headers or mobile actions.
      try { socket?.destroy(); } catch { /* no accepted handshake after an error */ }
      if (code) reject(new SmokeError(code));
      else resolve({ fingerprint, verifiedLoopbackHandshake: true, exactCertificatePin: true });
    };
    try {
      socket = connectTls({ host: '127.0.0.1', port, servername: 'clementine.local', ca: certificatePem,
        rejectUnauthorized: true, minVersion: 'TLSv1.2' });
      timer = setTimeout(() => finish('mobile_tls_loopback_handshake_timeout'), 10_000);
      socket.once('error', () => finish('mobile_tls_loopback_handshake_failed'));
      socket.once('secureConnect', () => {
        try {
          const raw = socket.getPeerCertificate()?.raw;
          if (socket.authorized !== true || !Buffer.isBuffer(raw)
            || createHash('sha256').update(raw).digest('base64url') !== fingerprint) {
            finish('mobile_tls_peer_pin_mismatch'); return;
          }
          finish();
        } catch { finish('mobile_tls_loopback_handshake_failed'); }
      });
    } catch { finish('mobile_tls_loopback_handshake_failed'); }
  });
}

/** The private key digest is an in-memory comparison, never an uploaded receipt field. */
export function publicStorageReceipt(result) {
  const keys = ['sessionId', 'eventId', 'eventSeq', 'historySha256', 'artifactId', 'revisionDigest', 'contentDigest',
    'fileSha256', 'fileBytes', 'encryptedReference', 'encryptedBindingRejected', 'productionSealKeyPreexisting', 'staged'];
  return { ...Object.fromEntries(keys.map(key => [key, result[key]])), mobileTls: {
    fingerprint: result.mobileTls.fingerprint, existingProductionIdentityRetained: result.mobileTls.existingProductionIdentityRetained === true,
  } };
}

async function loadCompiledWindowsTreeStop() {
  // The smoke gate runs after this exact checkout's candidate build. Never
  // resolve cleanup code through PATH, environment, or a fixture project.
  const file = fileURLToPath(new URL('../dist/runtime/windows-process-tree.js', import.meta.url));
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || realpathSync(file) !== file) refuse('owned_child_stop_helper_unavailable');
    const module = await import(new URL('../dist/runtime/windows-process-tree.js', import.meta.url).href);
    if (typeof module.stopWindowsProcessTree !== 'function') refuse('owned_child_stop_helper_unavailable');
    return module.stopWindowsProcessTree;
  } catch { refuse('owned_child_stop_helper_unavailable'); }
}

function createOwnedChildRunner(controls = {}) {
  const platform = controls.platform ?? process.platform;
  const spawnProcess = controls.spawnProcess ?? spawn;
  const loadTreeStop = controls.loadTreeStop ?? loadCompiledWindowsTreeStop;
  const cleanupTimeoutMs = Math.min(5_000, Math.max(1, controls.cleanupTimeoutMs ?? 5_000));
  return async (executable, args, options = {}) => {
    if (platform !== 'win32') refuse('owned_child_windows_required');
    // Missing build prerequisite refuses before an installer or probe starts.
    let stopTree;
    try { stopTree = await loadTreeStop(); } catch { refuse('owned_child_stop_helper_unavailable'); }
    if (typeof stopTree !== 'function') refuse('owned_child_stop_helper_unavailable');
    const { timeoutMs = 120_000, ...spawnOptions } = options;
    return new Promise((resolve, reject) => {
      let child;
      try { child = spawnProcess(executable, args, { windowsHide: true, ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { reject(new SmokeError('owned_child_start_failed', 'not_started')); return; }
      const output = []; let bytes = 0; let settled = false; let stopping = false; let exited = false;
      let failureCode; let timer; let cleanupTimer;
      const detach = () => {
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          try { stream?.destroy(); } catch { /* the failure remains unqualified */ }
        }
        try { child.unref(); } catch { /* owned failure is still bounded */ }
      };
      const fail = (cleanup) => {
        if (settled) return; settled = true; clearTimeout(timer); clearTimeout(cleanupTimer);
        detach(); reject(new SmokeError(failureCode, cleanup));
      };
      const stop = (reason) => {
        if (settled || stopping) return;
        stopping = true; failureCode = reason; clearTimeout(timer);
        if (!Number.isSafeInteger(child.pid) || child.pid <= 0) { fail('not_started'); return; }
        // Parent exit plus held pipes is not a live PID ownership witness.
        // Its PID can be reused: never taskkill it or guess descendant PIDs.
        if (exited || child.exitCode != null || child.signalCode != null) { fail('incomplete'); return; }
        cleanupTimer = setTimeout(() => fail('incomplete'), cleanupTimeoutMs);
        void Promise.resolve().then(() => stopTree(child, { timeoutMs: cleanupTimeoutMs }))
          .then(result => fail(result === 'complete' ? 'complete' : 'incomplete'), () => fail('incomplete'));
      };
      // Never forward child logs: they may contain local credential URLs.
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes < 8_000_000) output.push(chunk); });
      child.stderr.on('data', () => {});
      child.once('exit', () => { exited = true; });
      child.on('error', () => stop('owned_child_start_failed'));
      child.once('close', code => {
        if (settled || stopping) return;
        settled = true; clearTimeout(timer);
        if (code !== 0 || bytes >= 8_000_000) reject(new SmokeError('owned_child_failed'));
        else resolve(Buffer.concat(output).toString('utf8'));
      });
      timer = setTimeout(() => stop('owned_child_timeout'), timeoutMs);
    });
  };
}

const runChild = createOwnedChildRunner();
/** Controlled source fixtures avoid requiring dist before the offline gate. */
export const _testOnly_createOwnedChildRunner = createOwnedChildRunner;

/** Files and bytes under a tree that may still be appearing; never its names. */
function extractedTreeSize(root) {
  let files = 0; let bytes = 0;
  const walk = (directory) => {
    let names; try { names = readdirSync(directory); } catch { return; }
    for (const name of names) {
      const file = path.join(directory, name); let stat;
      try { stat = lstatSync(file); } catch { continue; }
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(file);
      else if (stat.isFile()) { files += 1; bytes += stat.size; }
    }
  };
  walk(root);
  return { files, bytes };
}

async function powershell(script, additionalEnv = {}) {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) refuse('windows_system_root_missing');
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'; ${script}`, 'utf16le').toString('base64');
  return runChild(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    env: { ...process.env, ...additionalEnv }, timeoutMs: 30_000,
  });
}

async function processes() {
  const raw = await powershell(`$rows = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^Clementine(?:[ ._-].*)?\\.exe$' -or $_.CommandLine -match '[\\\\/]resources[\\\\/]daemon[\\\\/]dist[\\\\/]index\\.js'
  } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId;
    executable = $_.ExecutablePath; createdAt = $_.CreationDate.ToUniversalTime().ToString('o') } });
  ConvertTo-Json -InputObject $rows -Compress`);
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows)) refuse('process_inventory_failed');
  return rows;
}

async function assertNoExistingInstallation() {
  if ((await processes()).length !== 0) refuse('existing_clementine_process');
  const count = Number((await powershell(`$locations = @(
    'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall');
  $found = @($locations | ForEach-Object {
    if (Test-Path $_) { Get-ChildItem $_ | ForEach-Object { Get-ItemProperty $_.PSPath } }
  } |
    Where-Object { $_.DisplayName -like '*Clementine*' }); Write-Output $found.Count`)).trim());
  if (!Number.isSafeInteger(count) || count !== 0) refuse('existing_clementine_installation');
}

async function listeners(port, kind = 'loopback') {
  if (!['loopback', 'mobile'].includes(kind)) refuse('listener_kind_invalid');
  const rows = JSON.parse(await powershell(`$rows = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$env:SMOKE_OWNER_PORT) |
    ForEach-Object { [pscustomobject]@{ address = $_.LocalAddress; pid = [int]$_.OwningProcess } });
    ConvertTo-Json -InputObject $rows -Compress`, { SMOKE_OWNER_PORT: String(port) }));
  // The production mobile door intentionally binds IPv4 wildcard. This does
  // not broaden CDP/console ownership checks or claim LAN/firewall acceptance.
  const address = kind === 'mobile' ? '0.0.0.0' : '127.0.0.1';
  if (!Array.isArray(rows) || rows.length === 0 || rows.some((row) => row.address !== address
    || !Number.isSafeInteger(row.pid) || row.pid <= 0)) refuse('listener_ownership_unqualified');
  return rows;
}

async function assertListenerOwner(port, expectedPid) {
  if ((await listeners(port)).some((row) => row.pid !== expectedPid)) refuse('listener_ownership_unqualified');
}

let activeGate = null;
async function waitFor(operation, code, timeoutMs = 120_000) {
  activeGate = code;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await pause(500);
  }
  refuse(code);
}

async function localJSON(url, token, timeoutMs = 5_000) {
  const response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  if (!response.ok) refuse('local_read_failed');
  return response.json();
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

/** Small loopback-only CDP client; never logs protocol payloads/target URLs. */
class CDP {
  constructor(url) {
    this.socket = new WebSocket(url); this.nextId = 1; this.pending = new Map(); this.handlers = new Map();
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new SmokeError('cdp_connect_timeout')), 10_000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new SmokeError('cdp_connect_failed')); }, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      let message; try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id) {
        const request = this.pending.get(message.id); if (!request) return;
        this.pending.delete(message.id); clearTimeout(request.timer);
        message.error ? request.reject(new SmokeError('cdp_command_failed')) : request.resolve(message.result ?? {});
      } else {
        for (const handler of this.handlers.get(message.method) ?? []) handler(message.params ?? {});
      }
    });
    this.socket.addEventListener('close', () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new SmokeError('cdp_closed')); }
      this.pending.clear();
    });
  }
  on(method, handler) { const list = this.handlers.get(method) ?? []; list.push(handler); this.handlers.set(method, list); }
  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new SmokeError('cdp_command_timeout')); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async requestQuit() {
    await this.ready;
    // Electron's Browser.close handler calls Browser::Quit and deliberately
    // sends no CDP response. Acceptance is actual owned process exit below.
    this.socket.send(JSON.stringify({ id: this.nextId++, method: 'Browser.close', params: {} }));
  }
  async evaluate(expression) {
    const reply = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (reply.exceptionDetails || !Object.hasOwn(reply.result ?? {}, 'value')) refuse('ui_evaluation_failed');
    return reply.result.value;
  }
  close() { this.socket.close(); }
}

function hashTree(root) {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) refuse('invalid_package_tree');
  const manifest = [];
  const walk = (directory, relative = '') => {
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory, name); const stat = lstatSync(file); const rel = relative ? `${relative}/${name}` : name;
      if (stat.isSymbolicLink()) refuse('package_tree_link_refused');
      if (stat.isDirectory()) walk(file, rel);
      else if (stat.isFile()) {
        if (manifest.length > 50_000) refuse('package_tree_too_large');
        manifest.push({ path: rel, bytes: stat.size, sha256: sha256(readFileSync(file)) });
      } else refuse('package_tree_special_file_refused');
    }
  };
  walk(root);
  if (manifest.length === 0) refuse('package_tree_empty');
  return { files: manifest.length, sha256: sha256(JSON.stringify(manifest)) };
}

function packageIdentity(root) {
  const stamp = assertBuildStamp(jsonFile(path.join(root, 'resources', 'daemon', 'dist', 'runtime', 'build-stamp.json')));
  const pkg = jsonFile(path.join(root, 'resources', 'daemon', 'package.json'));
  if (pkg.name !== 'clemmy' || typeof pkg.version !== 'string') refuse('invalid_daemon_package');
  const files = ['Clementine.exe', 'resources/app.asar', 'resources/daemon/package.json'];
  const trees = ['resources/daemon/dist', 'resources/daemon/builtin-skills',
    'resources/daemon/apps/console-web/dist', 'resources/daemon/apps/mobile-web/dist'];
  const hashes = {};
  for (const relative of files) {
    const file = path.join(root, relative); const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) refuse('invalid_package_file');
    hashes[relative] = { bytes: stat.size, sha256: sha256(readFileSync(file)) };
  }
  for (const relative of trees) hashes[relative] = hashTree(path.join(root, relative));
  return { version: pkg.version, stamp, hashes };
}

async function findPage(port, predicate) {
  let targets;
  try { targets = await localJSON(`http://127.0.0.1:${port}/json/list`); } catch { return null; }
  if (!Array.isArray(targets)) refuse('cdp_target_inventory_failed');
  return targets.find((target) => target.type === 'page' && typeof target.url === 'string' && predicate(target.url)) ?? null;
}

async function skipSetup(app) {
  const target = await waitFor(() => findPage(app.port, (value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'file:' && isOwnedPath(fileURLToPath(url), app.profile)
        && /[\\/]wizard[\\/]setup\.html$/i.test(fileURLToPath(url));
    } catch { return false; }
  }), 'first_launch_setup_missing');
  const page = new CDP(assertCDPUrl(target.webSocketDebuggerUrl, app.port, 'page'));
  try {
    await page.send('Page.enable'); await page.send('Runtime.enable');
    const bounds = await waitFor(async () => page.evaluate(`(() => {
      const button = document.querySelector('[data-wiz-skip]');
      if (document.readyState !== 'complete' || !button || typeof window.clemmy?.setupSkip !== 'function') return null;
      const box = button.getBoundingClientRect();
      return !button.disabled && box.width > 0 && box.height > 0 ? { x: box.x + box.width/2, y: box.y + box.height/2 } : null;
    })()`), 'setup_preload_or_button_missing', 30_000);
    let dialogAccepted = false;
    let dialogFailure;
    page.on('Page.javascriptDialogOpening', (params) => {
      if (params.type !== 'confirm') { dialogFailure = new SmokeError('unexpected_setup_dialog'); return; }
      page.send('Page.handleJavaScriptDialog', { accept: true }).then(() => { dialogAccepted = true; }, () => {
        // Closing the setup target after successful skip can race the reply;
        // only an observed accepted dialog plus the app marker is evidence.
        dialogFailure = new SmokeError('setup_confirmation_failed');
      });
    });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...bounds });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...bounds });
    await waitFor(async () => {
      if (dialogFailure) throw dialogFailure;
      const marker = path.join(app.env.CLEMENTINE_HOME, 'state', 'setup-complete.json');
      if (!dialogAccepted || !existsSync(marker)) return null;
      const record = jsonFile(marker);
      if (record.version !== 'v1' || record.configured?.auth !== 'skipped') refuse('setup_marker_not_app_skip');
      return true;
    }, 'setup_skip_not_completed', 60_000);
  } finally { page.close(); }
}

/** What the installed app did when its debug listener never answered:
 * structural facts in the receipt, and the tails of the isolated fixture
 * home's own logs as separate redacted files in the diagnostics upload.
 * The home is synthetic (no accounts, live models disabled); tokens, keys
 * and long opaque strings are still cut before anything is written. */
async function collectLaunchDiagnostics(app, error) {
  const diagnostics = {
    failure: error instanceof SmokeError ? error.code : 'qualification_failed',
    elapsedMs: Date.now() - app.launchStartedAt,
    childExitCode: app.child.exitCode, childSignal: app.child.signalCode,
    devToolsActivePort: existsSync(path.join(app.userData, 'DevToolsActivePort')),
    userDataEntries: safeNames(app.userData), homeStateEntries: safeNames(path.join(app.env.CLEMENTINE_HOME, 'state')),
    profileHomeStateEntries: safeNames(path.join(app.profile, '.clementine-next', 'state')),
    clementineProcesses: null, logs: [],
  };
  try { diagnostics.clementineProcesses = (await processes()).length; } catch { /* the launch failure stands */ }
  const roots = [['user-data', path.join(app.userData, 'logs')], ['home', path.join(app.env.CLEMENTINE_HOME, 'logs')],
    ['profile', path.join(app.profile, '.clementine-next', 'logs')]];
  const directory = path.join(app.diagnosticsDir, 'launch-diagnostics');
  for (const [label, root] of roots) {
    for (const file of logFiles(root)) {
      let raw; try { raw = readFileSync(file); } catch { continue; }
      const tail = raw.subarray(Math.max(0, raw.length - 48_000)).toString('utf8');
      const name = `${label}-${path.relative(root, file).replace(/[^A-Za-z0-9._-]+/g, '_')}`;
      try { mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, name), redactLogText(tail)); } catch { continue; }
      diagnostics.logs.push({ file: name, bytes: raw.length });
    }
  }
  return diagnostics;
}

function safeNames(directory) {
  try { return readdirSync(directory).filter((name) => /^[A-Za-z0-9._ -]+$/.test(name)).sort().slice(0, 64); } catch { return null; }
}

function logFiles(root) {
  const found = [];
  const walk = (directory, depth) => {
    let names; try { names = readdirSync(directory); } catch { return; }
    for (const name of names) {
      const file = path.join(directory, name); let stat;
      try { stat = lstatSync(file); } catch { continue; }
      if (stat.isDirectory() && !stat.isSymbolicLink() && depth < 3) walk(file, depth + 1);
      else if (stat.isFile() && /\.(?:log|txt|jsonl)(?:\.\d+)?$/.test(name)) found.push(file);
    }
  };
  walk(root, 0);
  return found.slice(0, 12);
}

function redactLogText(text) {
  return text
    .replace(/(token|key|secret|password|authorization|signature)(["']?\s*[:=]\s*["']?)[^&\s"']+/gi, '$1$2[redacted]')
    .replace(/Bearer\s+\S+/g, 'Bearer [redacted]')
    .replace(/[?&][A-Za-z_]*(?:token|key|secret|sig)[A-Za-z_]*=[^&\s]*/gi, (match) => `${match.slice(0, match.indexOf('=') + 1)}[redacted]`)
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted-opaque]');
}

async function startInstalledApp(context, firstLaunch) {
  if ((await processes()).length !== 0) refuse('existing_clementine_process');
  let port = await freePort();
  if (port === Number(context.env.CLEMENTINE_MOBILE_APP_PORT)) port = await freePort();
  if (port === Number(context.env.CLEMENTINE_MOBILE_APP_PORT)) refuse('mobile_and_cdp_port_collision');
  // Electron 43's PreSandboxStartup honors --user-data-dir before app code.
  // USERPROFILE alone does not remap Windows known-folder APIs/app.userData.
  const userData = path.join(context.profile, 'electron-data');
  context.activeApp = undefined;
  context.launchStartedAt = Date.now();
  const child = spawn(context.executable, [`--user-data-dir=${userData}`,
    `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], {
    env: context.env, cwd: context.fixtureRoot, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  context.spawnedChild = child;
  let spawnFailed = false; child.once('error', () => { spawnFailed = true; });
  const main = await waitFor(async () => {
    if (spawnFailed || child.exitCode !== null) refuse('desktop_launch_failed');
    const rows = await processes();
    if (!rows.some((row) => row.pid === child.pid)) return null;
    return exactOwnedProcess(rows, child.pid, context.executable);
  }, 'desktop_process_missing', 30_000);
  const app = { ...context, child, main, port, userData };
  context.activeApp = app;
  // The process was alive for the whole 30 s wait in run 37670309581 with
  // no listener yet: a first start on a cold runner loads a 236 MB
  // executable while Defender scans 1.4 GB of fresh files. The bound now
  // matches the other waits, and a miss records what the app itself says.
  // Any miss between the listener and the dashboard records what the app
  // itself did (its log, its state entries), not only a listener miss.
  try {
    await waitFor(async () => {
      try { await localJSON(`http://127.0.0.1:${port}/json/version`); return true; } catch { return null; }
    }, 'desktop_debug_listener_missing', 120_000);
    await assertListenerOwner(port, main.pid);
    if (firstLaunch) await skipSetup(app);
  } catch (error) {
    context.launchDiagnostics = await collectLaunchDiagnostics(app, error);
    throw error;
  }
  // The app's real React landing redirect normally changes /console to
  // /console/chat before the next poll. Both are legitimate dashboard targets.
  // Every gate from here to the mounted dashboard records the app's own log
  // on a miss (run 37701723310: the dashboard appeared, then the daemon's
  // build info never answered in 120 s and nothing was recorded).
  const withLaunchDiagnostics = async (step) => {
    try { return await step(); } catch (error) {
      if (!context.launchDiagnostics) context.launchDiagnostics = await collectLaunchDiagnostics(app, error);
      throw error;
    }
  };
  const target = await withLaunchDiagnostics(() => waitFor(() => findPage(port, isDashboardTarget), 'desktop_dashboard_missing'));
  const targetUrl = new URL(target.url);
  const origin = targetUrl.origin;
  const owners = await listeners(Number(targetUrl.port));
  if (owners.some((row) => row.pid !== owners[0].pid)) refuse('listener_ownership_unqualified');
  // Attest the exact installed child listener before sending local credentials.
  const daemonCandidate = exactOwnedProcess(await processes(), owners[0].pid, context.executable, main.pid);
  const vault = jsonFile(path.join(app.env.CLEMENTINE_HOME, 'state', 'secrets-vault.json'));
  const token = vault.version === 'v1' ? vault.entries?.webhook_secret : null;
  if (typeof token !== 'string' || token.length < 24) refuse('fixture_local_auth_missing');
  if (existsSync(path.join(context.profile, '.clementine-next'))) refuse('selected_home_ignored');
  // This credential remains in memory; no target/viewer URLs are recorded.
  // A first boot on a cold runner answers slowly; one 5 s read aborting is
  // "not yet", not a verdict (run 37699594352: a raw TimeoutError here).
  // A cold first boot stalls the daemon's loop for 10–60 s at a time (run
  // 37703868292: a font request in flight for 114 s while heartbeats ran);
  // each read waits through one such stall, and the gate waits five minutes.
  const info = await withLaunchDiagnostics(() => waitFor(async () => {
    try { return await localJSON(`${origin}/api/console/build-info`, token, 30_000); } catch { return null; }
  }, 'daemon_build_info_unavailable', 300_000));
  app.served = assertServedIdentity(info, context.expected, path.join(context.installRoot, 'resources', 'daemon', 'dist', 'index.js'));
  app.daemon = exactOwnedProcess(await processes(), app.served.daemonProcessId, context.executable, main.pid);
  if (app.daemon.pid !== daemonCandidate.pid || app.daemon.createdAt !== daemonCandidate.createdAt) refuse('daemon_listener_changed');
  await assertListenerOwner(Number(targetUrl.port), app.daemon.pid);
  const page = new CDP(assertCDPUrl(target.webSocketDebuggerUrl, port, 'page'));
  app.page = page;
  await page.send('Page.enable'); await page.send('Runtime.enable');
  const assets = await withLaunchDiagnostics(() => waitFor(async () => page.evaluate(`(() => {
    const root = document.getElementById('root'); const main = root?.querySelector('#main');
    if (document.readyState !== 'complete' || !main || root.children.length === 0
      || !main.querySelector('[aria-label="Today overview"]')
      || !main.querySelector('textarea[aria-label="Message Clementine"]')
      || (root.innerText || '').length < 50 || (root.innerText || '').includes('Session expired')
      || (root.innerText || '').includes('This view hit a snag')) return null;
    return [...document.scripts].map(script => script.src).filter(Boolean);
  })()`), 'react_dashboard_not_mounted', 60_000));
  if (!Array.isArray(assets) || assets.length === 0) refuse('console_executed_asset_missing');
  app.assetHashes = [];
  for (const asset of assets) {
    const relative = consoleAssetRelative(asset, origin);
    // The daemon's loop stalls on a cold first boot (run 37705987629: a
    // 10 s abort here ended the smoke after the dashboard had mounted);
    // each asset is read through such stalls, bounded, inside the collector.
    // The body read is governed by the same abort signal as the headers
    // (run 37708030984: headers answered, the bundle's bytes stalled past
    // the signal, and the raw timeout surfaced outside this wait), so the
    // whole download, headers and bytes, is one bounded attempt.
    const { response, bytes } = await withLaunchDiagnostics(() => waitFor(async () => {
      try {
        const response = await fetch(asset, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(60_000) });
        return { response, bytes: Buffer.from(await response.arrayBuffer()) };
      } catch { return null; }
    }, 'console_asset_unreadable', 240_000));
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || !/javascript/.test(contentType)) refuse('console_asset_response_invalid');
    const installed = path.join(context.installRoot, 'resources', 'daemon', 'apps', 'console-web', 'dist', relative);
    if (sha256(bytes) !== sha256(readFileSync(installed))) refuse('console_served_asset_mismatch');
    app.assetHashes.push({ relative, bytes: bytes.length, sha256: sha256(bytes) });
  }
  app.readAPI = (pathname) => localJSON(`${origin}${pathname}`, token);
  // A dashboard can boot while optional mobile TLS catches an initialization
  // failure. Require the actual owned daemon listener and its boot-generated pin.
  const mobilePort = Number(context.env.CLEMENTINE_MOBILE_APP_PORT);
  await waitFor(async () => {
    let rows;
    try { rows = await listeners(mobilePort, 'mobile'); }
    catch (error) { if (error instanceof SmokeError && error.code === 'owned_child_failed') return null; throw error; }
    if (rows.some(row => row.pid !== app.daemon.pid)) refuse('mobile_tls_listener_ownership_unqualified');
    return true;
  }, 'mobile_tls_listener_missing', 30_000);
  const freshDaemon = exactOwnedProcess(await processes(), app.daemon.pid, context.executable, main.pid);
  if (freshDaemon.createdAt !== app.daemon.createdAt) refuse('mobile_tls_daemon_identity_changed');
  if ((await listeners(mobilePort, 'mobile')).some(row => row.pid !== app.daemon.pid)) refuse('mobile_tls_listener_ownership_unqualified');
  const identityDirectory = path.join(context.env.CLEMENTINE_HOME, 'state', 'mobile-tls');
  const certificateFile = path.join(identityDirectory, 'cert.pem'); const keyFile = path.join(identityDirectory, 'key.pem');
  if (!isOwnedPath(realpathSync(identityDirectory), context.fixtureRoot)
    || !lstatSync(identityDirectory).isDirectory() || lstatSync(identityDirectory).isSymbolicLink()
    || !lstatSync(certificateFile).isFile() || lstatSync(certificateFile).isSymbolicLink()
    || !lstatSync(keyFile).isFile() || lstatSync(keyFile).isSymbolicLink()) refuse('mobile_tls_fixture_identity_unqualified');
  const certificatePem = readFileSync(certificateFile, 'utf8');
  const certificate = new X509Certificate(certificatePem);
  const fingerprint = createHash('sha256').update(certificate.raw).digest('base64url');
  app.mobileTls = await pinnedLoopbackTlsHandshake({ port: mobilePort, certificatePem, fingerprint });
  if (!firstLaunch && await findPage(port, (value) => {
    try { return new URL(value).protocol === 'file:' && /[\\/]wizard[\\/]setup\.html$/i.test(fileURLToPath(value)); }
    catch { return false; }
  })) refuse('setup_repeated_after_restart');
  return app;
}

async function quitInstalledApp(app) {
  // Refresh exact process + loopback ownership immediately before control.
  const current = exactOwnedProcess(await processes(), app.main.pid, app.executable);
  if (current.createdAt !== app.main.createdAt) refuse('desktop_pid_reused');
  await assertListenerOwner(app.port, app.main.pid);
  const version = await waitFor(async () => {
    try { return await localJSON(`http://127.0.0.1:${app.port}/json/version`); } catch { return null; }
  }, 'desktop_debug_listener_missing', 60_000);
  const browser = new CDP(assertCDPUrl(version.webSocketDebuggerUrl, app.port, 'browser'));
  try {
    await browser.requestQuit();
    // A closed protocol channel alone is not successful app shutdown. Normal
    // Electron quit must actually reap the exact daemon and every app child.
    await waitFor(async () => {
      const rows = await processes();
      return !rows.some((row) => winPath(row.executable ?? '') === winPath(app.executable)
        || row.pid === app.daemon?.pid || row.pid === app.main.pid) ? true : null;
    }, 'graceful_quit_or_daemon_stop_failed', 45_000);
    if (app.child.exitCode !== 0) refuse('desktop_graceful_exit_nonzero');
  } finally { browser.close(); app.page?.close(); }
}

async function cleanupFailedCIApp(context) {
  const child = context.spawnedChild;
  if (!child) return 'no_owned_app_started';
  let result = 'owned_process_ownership_unconfirmed';
  try {
    const rows = await processes();
    const row = rows.find((item) => item.pid === child.pid);
    if (!row) return 'owned_main_absent';
    const app = context.activeApp;
    if (app && row.createdAt === app.main.createdAt) {
      try { await quitInstalledApp(app); return 'graceful_owned_quit'; } catch { /* bounded exact-owner fallback below */ }
    }
    // Explicitly authorized only as failed CI-fixture cleanup. This is never
    // normal shutdown acceptance, and is never an image-name/global kill.
    // Recheck fresh launch ownership even if startup never reached CDP.
    if (winPath(realpathSync(context.fixtureRoot)) !== winPath(context.fixtureRoot)
      || readFileSync(path.join(context.fixtureRoot, '.owned-ci-fixture'), 'utf8') !== context.fixtureNonce
      || !Number.isFinite(Date.parse(row.createdAt)) || Date.parse(row.createdAt) < context.launchStartedAt - 5_000) {
      refuse('failure_cleanup_ownership_unqualified');
    }
    const userData = path.join(context.profile, 'electron-data');
    const fresh = JSON.parse(await powershell(`$proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $env:SMOKE_OWNER_PID);
      if ($null -eq $proc) { Write-Output 'null'; exit 0 }
      $argument = [regex]::Escape('--user-data-dir=' + $env:SMOKE_OWNER_USER_DATA);
      [pscustomobject]@{ pid = [int]$proc.ProcessId; executable = $proc.ExecutablePath;
        createdAt = $proc.CreationDate.ToUniversalTime().ToString('o');
        profileArgumentMatched = [bool]($proc.CommandLine -match ('(?:^|[\\s\"])' + $argument + '(?:$|[\\s\"])')) } |
        ConvertTo-Json -Compress`, { SMOKE_OWNER_PID: String(child.pid), SMOKE_OWNER_USER_DATA: userData }));
    const launch = { pid: child.pid, executable: context.executable, createdAt: app?.main.createdAt ?? row.createdAt, userData };
    assertFailureCleanupIdentity(fresh, launch, context.fixtureRoot);
    // Last identity comparison and taskkill invocation share one PowerShell
    // process to narrow the PID reuse window. No control if any witness fails.
    await powershell(`$proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $env:SMOKE_OWNER_PID);
      if ($null -eq $proc) { exit 0 }
      $argument = [regex]::Escape('--user-data-dir=' + $env:SMOKE_OWNER_USER_DATA);
      if ($proc.ExecutablePath -ine $env:SMOKE_OWNER_EXE -or
        $proc.CreationDate.ToUniversalTime().ToString('o') -ne $env:SMOKE_OWNER_CREATED -or
        $proc.CommandLine -notmatch ('(?:^|[\\s\"])' + $argument + '(?:$|[\\s\"])')) { throw 'Owned CI process mismatch' }
      & (Join-Path $env:SystemRoot 'System32\\taskkill.exe') /PID $env:SMOKE_OWNER_PID /T /F | Out-Null;
      if ($LASTEXITCODE -ne 0) { throw 'Owned CI stop failed' }`, {
      SMOKE_OWNER_PID: String(launch.pid), SMOKE_OWNER_USER_DATA: userData,
      SMOKE_OWNER_EXE: launch.executable, SMOKE_OWNER_CREATED: launch.createdAt,
    });
    await waitFor(async () => !(await processes()).some((item) => winPath(item.executable ?? '') === winPath(context.executable)),
      'failure_cleanup_stop_unconfirmed', 15_000);
    result = 'forced_exact_ci_fixture_stop_after_failure';
  } catch { result = 'owned_process_cleanup_unconfirmed'; }
  finally {
    context.activeApp?.page?.close();
    // Never hold failure reporting hostage to an unqualified process. Its
    // freshly owned Actions VM will be disposed; no candidate is accepted.
    child.stdout.destroy(); child.stderr.destroy(); child.unref();
  }
  return result;
}

export const INSTALLED_STORAGE_PROBE = `
  import assert from 'node:assert/strict';
  import { createHash } from 'node:crypto';
  import { pathToFileURL } from 'node:url';
  import { existsSync, readFileSync } from 'node:fs';
  import path from 'node:path';
  import os from 'node:os';
  const settings = JSON.parse(process.env.SMOKE_STORAGE_CONFIG);
  assert.equal(path.resolve(os.homedir()), path.resolve(settings.profile));
  assert.equal(path.resolve(process.env.CLEMENTINE_HOME), path.resolve(settings.clementineHome));
  assert.notEqual(path.resolve(settings.clementineHome), path.resolve(settings.profile, '.clementine-next'));
  assert.equal(existsSync(path.join(settings.profile, '.clementine-next')), false);
  const eventlog = await import(pathToFileURL(path.join(settings.runtime, 'runtime/harness/eventlog.js')).href);
  const artifacts = await import(pathToFileURL(path.join(settings.runtime, 'tools/artifact-bundle-core.js')).href);
  const encrypted = await import(pathToFileURL(path.join(settings.runtime, 'runtime/harness/authority-encrypted-payload-store.js')).href);
  const blobs = await import(pathToFileURL(path.join(settings.runtime, 'integrations/composio/staged-file-blob-store.js')).href);
  const mobile = await import(pathToFileURL(path.join(settings.runtime, 'runtime/mobile-tls.js')).href);
  const digest = value => createHash('sha256').update(value).digest('hex');
  // Read must succeed before the production API: a later mint must not hide
  // the actual app's missing startup identity or bundled dependency failure.
  const mobileDirectory = path.join(process.env.CLEMENTINE_HOME, 'state/mobile-tls');
  const retainedKeyBytes = readFileSync(path.join(mobileDirectory, 'key.pem'));
  const retainedCertificateBytes = readFileSync(path.join(mobileDirectory, 'cert.pem'));
  const identity = await mobile.ensureMobileTlsIdentity();
  assert.equal(identity.fingerprint, settings.mobileFingerprint);
  assert.deepEqual(readFileSync(path.join(mobileDirectory, 'key.pem')), retainedKeyBytes);
  assert.deepEqual(readFileSync(path.join(mobileDirectory, 'cert.pem')), retainedCertificateBytes);
  assert.equal(mobile.certFingerprint(identity.certPem), settings.mobileFingerprint);
  const content = 'Controlled Windows installed smoke — restart preservation.\\n';
  const artifactInput = { bundleId: settings.bundleId, files: [{ path: 'notes/restart.txt', content }] };
  // Require the actual app's boot-provisioned vault key. The isolated-home
  // convenience fallback must not hide a missing production first-run key.
  const vault = JSON.parse(readFileSync(path.join(process.env.CLEMENTINE_HOME, 'state/secrets-vault.json'), 'utf8'));
  assert.match(vault.entries?.authority_seal_v2 ?? '', /^[a-f0-9]{64}$/i);
  const bindingDigest = digest('controlled_ci_model_request_snapshot:' + settings.sessionId);
  const snapshot = Buffer.from(JSON.stringify({ kind: 'controlled_ci_model_request_snapshot',
    fixture: settings.marker, items: Array.from({ length: 400 }, (_, index) => ({ role: 'user',
      content: 'Synthetic offline model-request provenance storage chunk ' + index })) }), 'utf8');
  const stagedBytes = Buffer.from(content, 'utf8');
  const storeDirectory = path.join(process.env.CLEMENTINE_HOME, 'state/windows-smoke-blob');
  const destinationDirectory = path.join(process.env.CLEMENTINE_HOME, 'files/windows-smoke-materialized');
  try {
    if (settings.mode === 'seed') {
      assert.equal(eventlog.getSession(settings.sessionId), null);
      eventlog.createSession({ id: settings.sessionId, kind: 'chat', channel: 'cli',
        title: 'Controlled Windows installed smoke', metadata: { source: 'controlled_ci_windows_smoke' } });
      eventlog.appendEvent({ sessionId: settings.sessionId, turn: 1, role: 'user', type: 'user_input',
        data: { text: settings.marker, source: 'controlled_ci_windows_smoke' } });
      const saved = artifacts.saveArtifactBundle(artifactInput);
      assert.equal(saved.created, true);
    }
    const encryptedInput = { payloadKind: 'model_request_snapshot', bindingDigest, bytes: snapshot };
    const encryptedReference = settings.mode === 'seed'
      ? encrypted.persistAuthorityEncryptedPayload(encryptedInput) : settings.retainedReference;
    assert.equal(encryptedReference?.plaintextSha256, digest(snapshot));
    assert.equal(encryptedReference.plaintextBytes, snapshot.byteLength);
    assert.ok(encryptedReference.chunkCount > 1);
    const opened = encrypted.readAuthorityEncryptedPayload({ reference: encryptedReference,
      payloadKind: 'model_request_snapshot', bindingDigest });
    assert.equal(opened.status, 'ok');
    assert.deepEqual(opened.bytes, snapshot);
    assert.equal(encrypted.readAuthorityEncryptedPayload({ reference: encryptedReference,
      payloadKind: 'model_request_snapshot', bindingDigest: digest('wrong:' + settings.sessionId) }).status, 'binding_mismatch');
    assert.deepEqual(encrypted.persistAuthorityEncryptedPayload(encryptedInput), encryptedReference,
      'same bound bytes must adopt the exact prior encrypted identity across restart');
    const sealedBytes = readFileSync(encrypted.authorityEncryptedPayloadFilePath(encryptedReference.payloadId));
    assert.equal(digest(sealedBytes), encryptedReference.sealedFileSha256);
    assert.equal(sealedBytes.includes(Buffer.from(settings.marker)), false);
    let staged;
    if (settings.mode === 'seed') {
      const writer = blobs.createStagedFileBlobWriter({ storeDirectory });
      writer.write(stagedBytes.subarray(0, 8)); writer.write(stagedBytes.subarray(8));
      const published = blobs.publishStagedFileBlob({ storeDirectory,
        sealed: writer.seal({ sha256: digest(stagedBytes), byteCount: stagedBytes.byteLength }) });
      assert.equal(blobs.materializeStagedFileBlob({ blob: published, destinationDirectory,
        destinationName: 'restart.txt' }).disposition, 'published');
      const replay = blobs.createStagedFileBlobWriter({ storeDirectory }); replay.write(stagedBytes);
      const adopted = blobs.publishStagedFileBlob({ storeDirectory, sealed: replay.seal() });
      assert.deepEqual(adopted, published);
      assert.equal(blobs.materializeStagedFileBlob({ blob: adopted, destinationDirectory,
        destinationName: 'restart.txt' }).disposition, 'adopted');
      staged = { sha256: published.sha256, md5: published.md5, byteCount: published.byteCount };
    } else staged = settings.retainedStaged;
    assert.equal(staged?.sha256, digest(stagedBytes));
    assert.equal(staged.byteCount, stagedBytes.byteLength);
    assert.deepEqual(readFileSync(path.join(storeDirectory, 'sha256-' + staged.sha256)), stagedBytes);
    assert.equal(blobs.verifyStagedFileMaterialization({ blob: staged, destinationDirectory,
      destinationName: 'restart.txt' }).disposition, 'adopted');
    const session = eventlog.getSession(settings.sessionId);
    const events = eventlog.listEvents(settings.sessionId);
    assert.equal(session?.metadata.source, 'controlled_ci_windows_smoke');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'user_input');
    assert.equal(events[0].data.text, settings.marker);
    const inspected = artifacts.inspectArtifactBundle(artifactInput);
    assert.equal(inspected.status, 'present_exact');
    const reopened = artifacts.inspectArtifactBundleArtifactId(inspected.result.artifactId);
    assert.equal(reopened.status, 'present_exact');
    assert.equal(reopened.result.contentDigest, inspected.result.contentDigest);
    const result = { sessionId: session.id, eventId: events[0].id, eventSeq: events[0].seq,
      historySha256: digest(JSON.stringify(events)), artifactId: inspected.result.artifactId,
      revisionDigest: inspected.result.revisionDigest, contentDigest: inspected.result.contentDigest,
      fileSha256: inspected.result.files[0].sha256, fileBytes: inspected.result.files[0].bytes,
      encryptedReference, encryptedBindingRejected: true, productionSealKeyPreexisting: true, staged,
      mobileTls: { fingerprint: identity.fingerprint, existingProductionIdentityRetained: true },
      privateMobileKeySha256: digest(retainedKeyBytes), privateMobileCertificateSha256: digest(retainedCertificateBytes) };
    process.stdout.write('WINDOWS_SMOKE_STORAGE=' + JSON.stringify(result) + '\\n');
  } finally { eventlog.closeEventLog(); }
`;

async function storageFixture(context, fixture, mode, retained) {
  if ((await processes()).length !== 0) refuse('storage_fixture_requires_quiet_app');
  const config = { ...fixture, mode, profile: context.profile, clementineHome: context.env.CLEMENTINE_HOME,
    retainedReference: retained?.encryptedReference, retainedStaged: retained?.staged,
    runtime: path.join(context.installRoot, 'resources', 'daemon', 'dist') };
  const raw = await runChild(context.executable, ['--input-type=module', '--eval', INSTALLED_STORAGE_PROBE], {
    env: { ...context.env, ELECTRON_RUN_AS_NODE: '1', SMOKE_STORAGE_CONFIG: JSON.stringify(config) }, cwd: context.fixtureRoot,
  });
  const matches = [...raw.matchAll(/^WINDOWS_SMOKE_STORAGE=(\{[^\r\n]+\})$/gm)];
  if (matches.length !== 1) refuse('installed_storage_receipt_missing');
  const result = JSON.parse(matches[0][1]);
  if (existsSync(path.join(context.profile, '.clementine-next'))) refuse('selected_home_ignored');
  if (result.sessionId !== fixture.sessionId || !/^[a-f0-9]{64}$/.test(result.historySha256)
    || !/^[a-f0-9]{64}$/.test(result.fileSha256)
    || !/^[a-f0-9]{64}$/.test(result.privateMobileKeySha256)
    || !/^[a-f0-9]{64}$/.test(result.privateMobileCertificateSha256)
    || result.mobileTls?.fingerprint !== fixture.mobileFingerprint
    || result.mobileTls?.existingProductionIdentityRetained !== true) refuse('installed_storage_receipt_invalid');
  return result;
}

async function screenshot(app, file) {
  // Only a synthetic account is ever opened. Still guard against accidental
  // auth prompt/viewer content; never save target lists or credential URLs.
  const safe = await app.page.evaluate(`(() => !document.querySelector('input[type=password]')
    && !document.querySelector('iframe') && !/oauth|authorize|browserbase/i.test(location.pathname))()`);
  if (!safe) refuse('screenshot_context_refused');
  const shot = await app.page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
}

export async function main(args = process.argv.slice(2)) {
  // Reject unsupported/ordinary hosts before any directory, process, install,
  // registry, credential, or application effect.
  assertQualificationHost(process.platform, process.arch, process.env);
  const options = parseArguments(args);
  const receipt = {
    version: 1, kind: 'controlled_ci_windows_installed_smoke', startedAt: new Date().toISOString(),
    platform: 'win32', arch: 'x64', expectedVersion: options.expectedVersion, status: 'failed', phase: 'preflight',
    acceptance: { models: false, oauth: false, byo: false, browserbase: false, physicalTester: false,
      mobilePhonePairing: false, mobileLanFirewall: false },
  };
  const record = () => { mkdirSync(path.dirname(options.receipt), { recursive: true });
    writeFileSync(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`); };
  const phase = (value) => { receipt.phase = value; record(); process.stdout.write(`[Windows installed smoke] ${value}\n`); };
  let context;
  try {
    const installer = path.join(options.releaseDir, `Clementine-Setup-${options.expectedVersion}.exe`);
    const candidateRoot = path.join(options.releaseDir, 'win-unpacked');
    const candidate = packageIdentity(candidateRoot);
    if (candidate.version !== options.expectedVersion
      || (process.env.SOURCE_COMMIT && process.env.SOURCE_COMMIT !== candidate.stamp.gitSha)) refuse('candidate_identity_mismatch');
    if (!existsSync(installer) || !lstatSync(installer).isFile() || lstatSync(installer).isSymbolicLink()) refuse('exact_installer_missing');
    receipt.candidate = candidate;
    receipt.installer = { filename: path.basename(installer), bytes: lstatSync(installer).size, sha256: sha256(readFileSync(installer)) };
    await assertNoExistingInstallation();
    // The fixture stands in for a user's profile, so it lives under the
    // runner user's own temp folder, which inherits the profile's private
    // NTFS permissions. Under the shared runner temp drive the installed
    // app's credential policy refused the home at first boot (run
    // 37675782327: "Credential storage privacy or integrity could not be
    // verified" in the app's own log, no window, no listener). The
    // ephemeral-runner guard above still requires RUNNER_TEMP.
    const userTemp = realpathSync(os.tmpdir());
    const fixtureRoot = mkdtempSync(path.join(userTemp, 'clem-windows-installed-smoke-'));
    if (!isOwnedPath(fixtureRoot, userTemp)) refuse('fixture_ownership_failed');
    const fixtureNonce = randomUUID();
    writeFileSync(path.join(fixtureRoot, '.owned-ci-fixture'), fixtureNonce);
    const profile = path.join(fixtureRoot, 'profile'); const installRoot = path.join(fixtureRoot, 'installed app');
    const env = isolatedChildEnvironment(process.env, profile, fixtureRoot);
    // The actual production listener uses this port; reserve no shared/default
    // listener and do not inject or rewrite any TLS identity.
    env.CLEMENTINE_MOBILE_APP_PORT = String(await freePort());
    env.CLEMENTINE_MOBILE_APP_LISTENER = 'on';
    for (const directory of [profile, env.APPDATA, env.LOCALAPPDATA, env.TEMP, env.CLEMENTINE_HOME]) mkdirSync(directory, { recursive: true });
    context = { profile, installRoot, fixtureRoot, fixtureNonce, env, diagnosticsDir: path.dirname(options.receipt),
      executable: path.join(installRoot, 'Clementine.exe'), expected: candidate };
    if (existsSync(path.join(env.CLEMENTINE_HOME, 'state', 'setup-complete.json'))) refuse('fixture_not_fresh');
    // Recheck immediately before installer effect. /D is deliberately final;
    // NSIS consumes its unquoted remainder, including spaces, as the directory.
    await assertNoExistingInstallation();
    phase('nsis_install');
    // A 400 MB LZMA installer extracting on a two-core runner passed 180 s
    // (run 37667783130) with nothing to tell slow from stuck: the bound is
    // generous and the extracted tree is measured every 30 s (counts only).
    const installStarted = Date.now();
    const progress = setInterval(() => {
      const extracted = extractedTreeSize(installRoot);
      process.stdout.write(`[Windows installed smoke] nsis_install progress: ${extracted.files} files, ${Math.round(extracted.bytes / 1_048_576)} MB after ${Math.round((Date.now() - installStarted) / 1000)} s\n`);
    }, 30_000);
    try {
      await runChild(installer, ['/S', '/currentuser', `/D=${installRoot}`], {
        env, cwd: fixtureRoot, windowsVerbatimArguments: true, timeoutMs: 900_000,
      });
    } finally { clearInterval(progress); }
    receipt.install = { durationMs: Date.now() - installStarted, ...extractedTreeSize(installRoot) };
    if (!existsSync(context.executable) || !isOwnedPath(realpathSync(context.executable), fixtureRoot)) refuse('owned_install_not_created');
    const installed = packageIdentity(installRoot);
    assert.deepEqual(installed, candidate);
    receipt.installed = installed;
    phase('first_launch_real_setup');
    const first = await startInstalledApp(context, true);
    receipt.firstLaunch = { served: first.served, setupSkippedByUI: true, reactMounted: true, assets: first.assetHashes, mobileTls: first.mobileTls };
    phase('first_graceful_quit'); await quitInstalledApp(first);
    const fixture = { sessionId: `windows-installed-smoke-${randomUUID()}`, bundleId: `windows-smoke-${randomUUID()}`,
      marker: `Controlled CI-only Windows restart fixture ${randomUUID()}`, mobileFingerprint: first.mobileTls.fingerprint };
    phase('installed_production_storage');
    const seeded = await storageFixture(context, fixture, 'seed');
    phase('restart_and_history');
    const second = await startInstalledApp(context, false);
    if (second.served.daemonInstanceId === first.served.daemonInstanceId || second.served.startedAt === first.served.startedAt) {
      refuse('restart_identity_unchanged');
    }
    assert.deepEqual(second.mobileTls, first.mobileTls);
    const sessions = await second.readAPI('/api/console/sessions');
    if (!sessions.sessions?.some((session) => session.id === `harness:${fixture.sessionId}`)) refuse('restarted_history_not_exposed');
    const detail = await second.readAPI(`/api/console/sessions/${encodeURIComponent(`harness:${fixture.sessionId}`)}`);
    if (!JSON.stringify(detail).includes(fixture.marker)) refuse('restarted_history_bytes_not_exposed');
    await screenshot(second, path.join(path.dirname(options.receipt), 'installed-dashboard.png'));
    receipt.restart = { served: second.served, reactMounted: true, assets: second.assetHashes,
      retainedHistoryAPI: true, setupRepeated: false, screenshot: 'installed-dashboard.png', mobileTls: second.mobileTls };
    phase('second_graceful_quit'); await quitInstalledApp(second);
    phase('retention_readback');
    const retained = await storageFixture(context, fixture, 'read', seeded);
    assert.deepEqual(retained, seeded);
    receipt.retention = publicStorageReceipt(retained);
    receipt.status = 'passed'; receipt.phase = 'complete'; receipt.finishedAt = new Date().toISOString();
    // Scope is explicit in candidate.hashes. Packaged native dependency gates
    // are a separate workflow receipt; these hashes do not claim every DLL or
    // every daemon/node_modules file was compared after NSIS extraction.
    receipt.qualified = { nsisInstalled: true, exactInstalledScopedBytes: true, actualSetupUI: true,
      authenticatedDaemon: true, mountedReact: true, exactServedAssets: true,
      gracefulMainAndDaemonQuit: true, restartedSameHome: true, productionHistoryAndArtifactRetained: true,
      encryptedModelRequestStorageRetained: true, stagedBlobAndMaterializationRetained: true,
      productionMobileTlsIdentityRetained: true, actualMobileTlsLoopbackPinVerified: true,
      selectedConfiguredHome: true, defaultProfileHomeAbsent: true };
    record(); process.stdout.write('[Windows installed smoke] passed (no model/provider acceptance)\n');
    return receipt;
  } catch (error) {
    // Never serialize native exceptions, subprocess logs, auth URLs or tokens
    // into the receipt. An unexpected exception is the smoke's own defect,
    // so its stack goes to the step log, bounded and redacted (run
    // 37697565733: qualification_failed with the stack lost to the re-throw).
    if (!(error instanceof SmokeError)) {
      // An abort timeout carries no user frames; the gate that was open
      // when it surfaced locates it.
      process.stderr.write(`[Windows installed smoke] unexpected (last gate: ${activeGate ?? 'none'}): ${redactLogText(String(error?.stack ?? error)).slice(0, 2_000)}\n`);
    }
    receipt.failureCode = error instanceof SmokeError ? error.code : 'qualification_failed';
    if (error instanceof SmokeError && error.childCleanup) {
      receipt.ownedChildCleanup = { result: error.childCleanup, qualifiesGracefulOrInstallerSuccess: false };
    }
    if (context?.launchDiagnostics) receipt.launchDiagnostics = context.launchDiagnostics;
    if (context) receipt.failureCleanup = await cleanupFailedCIApp(context);
    receipt.finishedAt = new Date().toISOString(); record();
    throw new SmokeError(receipt.failureCode);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[Windows installed smoke] ${error instanceof SmokeError ? error.code : 'qualification_failed'}\n`);
    // An unexpected exception is the smoke's own defect; its stack names the
    // line (bounded, with the same redaction as the log tails). Run
    // 37695051118 ended qualification_failed with nothing to read.
    if (!(error instanceof SmokeError)) {
      process.stderr.write(`[Windows installed smoke] unexpected: ${redactLogText(String(error?.stack ?? error)).slice(0, 2_000)}\n`);
    }
    process.exitCode = 1;
  });
}
