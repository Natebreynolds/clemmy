/**
 * Clem's computer: Cua Driver (cua.ai/cua-driver, MIT), a local computer-use
 * daemon that clicks, types and reads in the apps on this machine through
 * the accessibility tree, driven over MCP. Clem owns it: the driver binary
 * downloads into her tools folder, verified against the vendor's checksums,
 * and runs embedded under the desktop app's own identity, so the operating
 * system's Accessibility and Screen Recording grants attach to Clementine
 * and no system folder, app bundle or administrator is involved. Clem
 * registers the driver as an MCP server of her own, so every action it
 * takes rides her existing contract: consent at the write boundary,
 * settlement of every attempt, and the record of what was done.
 *
 * This module knows where the driver lives, how it is fetched, how its
 * private daemon is kept alive, and what the Connect card reads. Nothing
 * here runs an action on the computer.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import type { ManagedMcpServer } from '../types.js';
import { clementineHomeDir, clemToolsBin, type ToolDownloadRecipe } from '../runtime/clem-tools.js';

const logger = pino({ name: 'clementine.computer-driver' });

import { COMPUTER_DRIVER_SERVER_NAME, computerDriverRecordConnected } from './computer-driver-presence.js';
export { COMPUTER_DRIVER_SERVER_NAME } from './computer-driver-presence.js';
export const COMPUTER_DRIVER_VERSION = '0.37.0';
/** The desktop app's bundle identity; the driver's permissions attach to it. */
export const COMPUTER_DRIVER_HOST_BUNDLE_ID = 'com.clemmy.desktop';
export const COMPUTER_DRIVER_DOCS_URL = 'https://cua.ai/docs/cua-driver/quickstart';
const RELEASE_BASE = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${COMPUTER_DRIVER_VERSION}/`;

/** The vendor's binary-only release for this machine, with the vendor's checksum file. */
export const COMPUTER_DRIVER_DOWNLOAD: ToolDownloadRecipe = {
  version: COMPUTER_DRIVER_VERSION,
  assets: {
    'darwin-arm64': `${RELEASE_BASE}cua-driver-rs-${COMPUTER_DRIVER_VERSION}-darwin-universal-binary.tar.gz`,
    'darwin-x64': `${RELEASE_BASE}cua-driver-rs-${COMPUTER_DRIVER_VERSION}-darwin-universal-binary.tar.gz`,
    'linux-x64': `${RELEASE_BASE}cua-driver-rs-${COMPUTER_DRIVER_VERSION}-linux-x86_64-binary.tar.gz`,
    'win32-x64': `${RELEASE_BASE}cua-driver-rs-${COMPUTER_DRIVER_VERSION}-windows-x86_64-binary.zip`,
    'win32-arm64': `${RELEASE_BASE}cua-driver-rs-${COMPUTER_DRIVER_VERSION}-windows-arm64-binary.zip`,
  },
  checksums: `${RELEASE_BASE}SHA256SUMS`,
  bin: process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver',
};

export interface ComputerDriverStatus {
  installed: boolean;
  path: string | null;
  /** Clem's own copy, run embedded under the app's identity. */
  embedded: boolean;
  version: string;
  /** The private daemon Clem keeps for the driver. */
  daemon: 'running' | 'stopped' | 'unknown';
  statusText: string | null;
  /** macOS: Accessibility and Screen Recording, when the driver can say. */
  permissions: 'granted' | 'missing' | 'unknown';
  permissionsText: string | null;
  /** Registered as Clem's MCP server, and enabled. */
  connected: boolean;
  serverName: string;
  docsUrl: string;
  platformSupport: 'supported' | 'preview' | 'unsupported';
}

/** Clem's own copy first; an older standalone install still counts. */
export function computerDriverPath(home: string = os.homedir(), platform: NodeJS.Platform = process.platform, toolsBin: string = clemToolsBin()): string | null {
  const own = path.join(toolsBin, platform === 'win32' ? 'cua-driver.exe' : 'cua-driver');
  const candidates = platform === 'win32'
    ? [own, path.join(home, '.local', 'bin', 'cua-driver.exe'), path.join(home, 'AppData', 'Local', 'cua', 'bin', 'cua-driver.exe')]
    : [own, path.join(home, '.local', 'bin', 'cua-driver'), '/usr/local/bin/cua-driver', '/opt/homebrew/bin/cua-driver', '/Applications/CuaDriver.app/Contents/MacOS/cua-driver'];
  const found = candidates.find((candidate) => existsSync(candidate)) ?? null;
  // Clem's link is handed out as the link, so ownership stays readable; the
  // daemon and proxy resolve it at spawn time (see realComputerDriverPath).
  return found;
}

/** The executable behind Clem's link, so libraries beside it resolve. */
export function realComputerDriverPath(binary: string): string {
  try { return realpathSync(binary); } catch { return binary; }
}

export function isOwnComputerDriver(binary: string | null, toolsBin: string = clemToolsBin()): boolean {
  return Boolean(binary && path.dirname(binary) === toolsBin);
}

function platformSupport(platform: NodeJS.Platform = process.platform): ComputerDriverStatus['platformSupport'] {
  if (platform === 'darwin' || platform === 'linux') return 'supported';
  if (platform === 'win32') return 'preview';
  return 'unsupported';
}

/** The private endpoint Clem's driver daemon listens on. */
export function computerDriverSocketPath(home: string = clementineHomeDir()): string {
  return path.join(home, 'state', 'cua-driver.sock');
}

export function computerDriverEnv(bundleId: string = COMPUTER_DRIVER_HOST_BUNDLE_ID): Record<string, string> {
  return { CUA_DRIVER_EMBEDDED: '1', CUA_DRIVER_HOST_BUNDLE_ID: bundleId };
}

/** The daemon Clem supervises: the driver serving on her private socket. */
export function computerDriverServeCommand(binary: string, socket: string = computerDriverSocketPath(), bundleId: string = COMPUTER_DRIVER_HOST_BUNDLE_ID): { command: string; args: string[]; env: Record<string, string> } {
  return { command: realComputerDriverPath(binary), args: ['serve', '--socket', socket], env: computerDriverEnv(bundleId) };
}

/** The MCP server record Clem keeps for the driver: a proxy onto her private daemon. */
export function computerDriverServer(binary: string, socket: string = computerDriverSocketPath(), bundleId: string = COMPUTER_DRIVER_HOST_BUNDLE_ID, platform: NodeJS.Platform = process.platform): ManagedMcpServer {
  // Windows (a vendor preview) has no app identity to attach to: the driver
  // serves on its own, configured through its environment, as the vendor documents.
  const embedded = platform !== 'win32';
  return {
    name: COMPUTER_DRIVER_SERVER_NAME,
    type: 'stdio',
    command: realComputerDriverPath(binary),
    args: embedded ? ['mcp', '--embedded', '--socket', socket, '--host-bundle-id', bundleId] : ['mcp'],
    env: embedded ? computerDriverEnv(bundleId) : {},
    description: 'Your computer: Cua Driver clicks, types and reads in the apps on this machine for Clem.',
    enabled: true,
    source: 'user',
  };
}

/** Ask the driver one question, bounded; null when it cannot answer. */
export function askDriver(binary: string, args: string[], timeoutMs = 8_000, env: Record<string, string> = {}): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(binary, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 256_000, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
        const text = `${stdout ?? ''}${stderr ?? ''}`.trim();
        if (error && !text) { resolve(null); return; }
        resolve(text || '');
      });
    } catch { resolve(null); }
  });
}

/** The readings as the Connect card shows them. Pure, so the words are pinned. */
export function readComputerDriverStatus(input: {
  path: string | null;
  embedded?: boolean;
  host?: 'running' | 'stopped' | 'not_started';
  statusText: string | null;
  permissionsText: string | null;
  servers: ReadonlyArray<Pick<ManagedMcpServer, 'name' | 'command' | 'args' | 'enabled'>>;
  platform?: NodeJS.Platform;
}): ComputerDriverStatus {
  const status = input.statusText?.toLowerCase() ?? null;
  const daemon: ComputerDriverStatus['daemon'] = input.host === 'running' ? 'running'
    : input.host === 'stopped' ? 'stopped'
      : status === null ? 'unknown'
        : /\b(not running|stopped|offline|unavailable)\b/.test(status) ? 'stopped'
          : /\b(running|ready|ok|healthy|serving)\b/.test(status) ? 'running'
            : 'unknown';
  const perms = input.permissionsText?.toLowerCase() ?? null;
  const permissions: ComputerDriverStatus['permissions'] = perms === null ? 'unknown'
    : /\b(denied|missing|not granted|needs|required)\b/.test(perms) ? 'missing'
      : /\b(granted|ok|allowed|enabled)\b/.test(perms) ? 'granted'
        : 'unknown';
  const connected = computerDriverRecordConnected(input.servers);
  return {
    installed: input.path !== null,
    path: input.path,
    embedded: input.embedded ?? false,
    version: COMPUTER_DRIVER_VERSION,
    daemon,
    statusText: input.statusText,
    permissions,
    permissionsText: input.permissionsText,
    connected,
    serverName: COMPUTER_DRIVER_SERVER_NAME,
    docsUrl: COMPUTER_DRIVER_DOCS_URL,
    platformSupport: platformSupport(input.platform),
  };
}

export async function computerDriverStatus(servers: ReadonlyArray<Pick<ManagedMcpServer, 'name' | 'command' | 'args' | 'enabled'>>): Promise<ComputerDriverStatus> {
  const binary = computerDriverPath();
  const embedded = isOwnComputerDriver(binary);
  const permissionsText = binary && process.platform === 'darwin' ? await askDriver(binary, ['permissions', 'status'], 8_000, embedded ? computerDriverEnv() : {}) : null;
  return readComputerDriverStatus({ path: binary, embedded, host: computerDriverHostState(), statusText: null, permissionsText, servers });
}

/** True when Clem's own driver is registered and enabled: it is then the
 *  browser on this machine as well as the desktop. Reads the server list
 *  the caller already holds, so the switch costs nothing on the hot path. */
export function computerDriverIsTheBrowser(servers: ReadonlyArray<Pick<ManagedMcpServer, 'name' | 'command' | 'args' | 'enabled'>>, binary: string | null = computerDriverPath()): boolean {
  if (!binary || !isOwnComputerDriver(binary)) return false;
  return readComputerDriverStatus({ path: binary, statusText: null, permissionsText: null, servers }).connected;
}

/** The first picture in a driver tool's result: what the screen looks like now. */
export function firstImageBlock(content: unknown): { data: string; mimeType: string } | null {
  const blocks = Array.isArray(content) ? content : (content && typeof content === 'object' && Array.isArray((content as { content?: unknown }).content)) ? (content as { content: unknown[] }).content : [];
  for (const block of blocks) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'image'
      && typeof (block as { data?: unknown }).data === 'string' && typeof (block as { mimeType?: unknown }).mimeType === 'string') {
      return { data: (block as { data: string }).data, mimeType: (block as { mimeType: string }).mimeType };
    }
  }
  return null;
}

/** The window Clem last acted in, read from a conversation's tool calls: the
 *  newest driver call that named a window. Pure over the rows, so it is pinned. */
export function lastActedWindow(rows: ReadonlyArray<{ type: string; data: Record<string, unknown> }>): { pid: number; windowId: number } | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    // A carried call is recorded under its carrier; the driver tool it ran is the effective one.
    const tool = typeof row.data.effectiveTool === 'string' ? row.data.effectiveTool : typeof row.data.tool === 'string' ? row.data.tool : '';
    if (!tool.startsWith(`${COMPUTER_DRIVER_SERVER_NAME}__`) && !tool.startsWith(`mcp__${COMPUTER_DRIVER_SERVER_NAME}__`)) continue;
    if (row.type === 'tool_called') {
      // A call that named the window in its arguments (a click, typed text, a batch of steps).
      const args = typeof row.data.args === 'string' ? row.data.args : JSON.stringify(row.data.args ?? '');
      const pid = /"pid"\s*:\s*(\d+)/.exec(args);
      const windowId = /"window_id"\s*:\s*(\d+)/.exec(args);
      if (pid && windowId) return { pid: Number(pid[1]), windowId: Number(windowId[1]) };
      continue;
    }
    if (row.type === 'tool_returned') {
      // A read or a batch whose answer names the window it looked at
      // ("window_id=273 pid=19529"); the call's own arguments are stored short.
      const text = typeof row.data.preview === 'string' ? row.data.preview : typeof row.data.result === 'string' ? row.data.result : '';
      const named = /window_id=(\d+)\s+pid=(\d+)/.exec(text) ?? /pid=(\d+)\s+window_id=(\d+)/.exec(text);
      if (named) {
        const byOrder = text.indexOf('window_id=') < text.indexOf('pid=') ? { windowId: Number(named[1]), pid: Number(named[2]) } : { pid: Number(named[1]), windowId: Number(named[2]) };
        return byOrder;
      }
    }
  }
  return null;
}

// ─── The private daemon ──────────────────────────────────────────────────
let host: { child: ChildProcess; generation: number } | null = null;
let hostStopped = true;
let restartTimer: NodeJS.Timeout | null = null;
let backoffMs = 2_000;

export function computerDriverHostState(): 'running' | 'stopped' | 'not_started' {
  if (host?.child && host.child.exitCode === null && !host.child.killed) return 'running';
  return hostStopped ? 'not_started' : 'stopped';
}

/**
 * Keep Clem's driver daemon alive while the driver is hers and connected.
 * Starts nothing when the driver is absent or not registered; restarts with
 * backoff when it exits on its own. Idempotent.
 */
export function startComputerDriverHost(input: { binary?: string | null; servers?: ReadonlyArray<Pick<ManagedMcpServer, 'name' | 'command' | 'args' | 'enabled'>> } = {}): 'started' | 'already' | 'idle' {
  const binary = input.binary === undefined ? computerDriverPath() : input.binary;
  if (!binary || !isOwnComputerDriver(binary)) return 'idle';
  if (process.platform === 'win32') return 'idle'; // the driver serves on its own there
  if (input.servers && !readComputerDriverStatus({ path: binary, statusText: null, permissionsText: null, servers: input.servers }).connected) return 'idle';
  if (computerDriverHostState() === 'running') return 'already';
  hostStopped = false;
  spawnHost(binary);
  return 'started';
}

/**
 * Driver daemons left serving Clem's private socket by an app session that
 * is gone: their parent is the system (pid 1), so nothing will ever stop
 * them, and once a newer daemon recreates the socket they serve nothing.
 * Pure over a `ps -Ao pid=,ppid=,command=` listing, so it is pinned.
 */
export function orphanedComputerDriverPids(listing: string, socket: string): number[] {
  const needle = `cua-driver serve --socket ${socket}`;
  const pids: number[] = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const command = match[3].trimEnd();
    if (Number(match[2]) !== 1) continue;
    if (!(command.endsWith(needle) || command.includes(`${needle} `))) continue;
    pids.push(Number(match[1]));
  }
  return pids;
}

function stopOrphanedComputerDrivers(socket: string): void {
  if (process.platform === 'win32') return;
  let listing = '';
  try { listing = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }); } catch { return; }
  for (const pid of orphanedComputerDriverPids(listing, socket)) {
    try { process.kill(pid, 'SIGTERM'); logger.info({ pid }, 'stopped a computer driver left by an earlier app session'); } catch { /* already gone */ }
  }
}

let exitHookInstalled = false;
/** The driver is the app's child: when the daemon exits, so does its driver. */
function installHostExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    hostStopped = true;
    const child = host?.child;
    if (child && child.exitCode === null) { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  });
}

function spawnHost(binary: string): void {
  const socket = computerDriverSocketPath();
  installHostExitHook();
  stopOrphanedComputerDrivers(socket);
  try { mkdirSync(path.dirname(socket), { recursive: true }); rmSync(socket, { force: true }); } catch { /* the daemon reports it */ }
  const plan = computerDriverServeCommand(binary, socket);
  const generation = (host?.generation ?? 0) + 1;
  let child: ChildProcess;
  try {
    child = spawn(plan.command, plan.args, { env: { ...process.env, ...plan.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'computer driver could not start');
    scheduleRestart(binary);
    return;
  }
  host = { child, generation };
  child.stdout?.on('data', (chunk) => logger.info({ generation }, `driver: ${String(chunk).trim().slice(0, 300)}`));
  child.stderr?.on('data', (chunk) => logger.info({ generation }, `driver: ${String(chunk).trim().slice(0, 300)}`));
  child.on('error', (error) => logger.warn({ generation, err: error.message }, 'computer driver errored'));
  child.on('exit', (code, signal) => {
    logger.info({ generation, code, signal }, 'computer driver daemon exited');
    if (!hostStopped) scheduleRestart(binary);
  });
  logger.info({ generation, socket }, 'computer driver daemon started under the app\'s identity');
}

function scheduleRestart(binary: string): void {
  if (hostStopped || restartTimer) return;
  restartTimer = setTimeout(() => { restartTimer = null; if (!hostStopped) spawnHost(binary); }, backoffMs);
  restartTimer.unref?.();
  backoffMs = Math.min(60_000, backoffMs * 2);
}

export async function stopComputerDriverHost(): Promise<void> {
  hostStopped = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  backoffMs = 2_000;
  const child = host?.child;
  host = null;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 5_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
  });
}
