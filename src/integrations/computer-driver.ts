/**
 * Clem's computer: Cua Driver (cua.ai/cua-driver, MIT), a local computer-use
 * daemon that clicks, types and reads in the apps on this machine through
 * the accessibility tree and its own browser window, driven over MCP. Clem
 * registers it as an MCP server of her own, so every action it takes rides
 * her existing contract: consent at the write boundary, settlement of every
 * attempt, and the record of what was done.
 *
 * This module knows where the driver lives, what it reports, and how it is
 * installed and granted its permissions; the Connect card and the routes
 * read and call it. Nothing here runs an action on the computer.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ManagedMcpServer } from '../types.js';

export const COMPUTER_DRIVER_SERVER_NAME = 'cua-driver';
/** The installer's documented one-liner, from the vendor's quickstart. */
export const COMPUTER_DRIVER_INSTALL_COMMAND = process.platform === 'win32'
  ? 'powershell -NoProfile -Command "irm https://cua.ai/driver/install.ps1 | iex"'
  : '/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"';
export const COMPUTER_DRIVER_DOCS_URL = 'https://cua.ai/docs/cua-driver/quickstart';

export interface ComputerDriverStatus {
  installed: boolean;
  path: string | null;
  /** What `cua-driver status` said, trimmed; null when it could not be asked. */
  daemon: 'running' | 'stopped' | 'unknown';
  statusText: string | null;
  /** macOS: Accessibility and Screen Recording, from `permissions status`. */
  permissions: 'granted' | 'missing' | 'unknown';
  permissionsText: string | null;
  /** Registered as Clem's MCP server, and enabled. */
  connected: boolean;
  serverName: string;
  installCommand: string;
  docsUrl: string;
  platformSupport: 'supported' | 'preview' | 'unsupported';
}

export function computerDriverPath(home: string = os.homedir(), platform: NodeJS.Platform = process.platform): string | null {
  const candidates = platform === 'win32'
    ? [path.join(home, '.local', 'bin', 'cua-driver.exe'), path.join(home, 'AppData', 'Local', 'cua', 'bin', 'cua-driver.exe')]
    : [path.join(home, '.local', 'bin', 'cua-driver'), '/usr/local/bin/cua-driver', '/opt/homebrew/bin/cua-driver'];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function platformSupport(platform: NodeJS.Platform = process.platform): ComputerDriverStatus['platformSupport'] {
  if (platform === 'darwin' || platform === 'linux') return 'supported';
  if (platform === 'win32') return 'preview';
  return 'unsupported';
}

/** Ask the driver one question, bounded; null when it cannot answer. */
export function askDriver(binary: string, args: string[], timeoutMs = 8_000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(binary, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 256_000 }, (error, stdout, stderr) => {
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
  statusText: string | null;
  permissionsText: string | null;
  servers: ReadonlyArray<Pick<ManagedMcpServer, 'name' | 'command' | 'args' | 'enabled'>>;
  platform?: NodeJS.Platform;
}): ComputerDriverStatus {
  const status = input.statusText?.toLowerCase() ?? null;
  const daemon: ComputerDriverStatus['daemon'] = status === null ? 'unknown'
    : /\b(not running|stopped|offline|unavailable)\b/.test(status) ? 'stopped'
      : /\b(running|ready|ok|healthy|serving)\b/.test(status) ? 'running'
        : 'unknown';
  const perms = input.permissionsText?.toLowerCase() ?? null;
  const permissions: ComputerDriverStatus['permissions'] = perms === null ? 'unknown'
    : /\b(denied|missing|not granted|needs|required)\b/.test(perms) ? 'missing'
      : /\b(granted|ok|allowed|enabled)\b/.test(perms) ? 'granted'
        : 'unknown';
  const connected = input.servers.some((server) => server.enabled !== false
    && typeof server.command === 'string' && /cua-driver(\.exe)?$/.test(server.command)
    && Array.isArray(server.args) && server.args.includes('mcp'));
  return {
    installed: input.path !== null,
    path: input.path,
    daemon,
    statusText: input.statusText,
    permissions,
    permissionsText: input.permissionsText,
    connected,
    serverName: COMPUTER_DRIVER_SERVER_NAME,
    installCommand: COMPUTER_DRIVER_INSTALL_COMMAND,
    docsUrl: COMPUTER_DRIVER_DOCS_URL,
    platformSupport: platformSupport(input.platform),
  };
}

export async function computerDriverStatus(servers: ReadonlyArray<Pick<ManagedMcpServer, 'name' | 'command' | 'args' | 'enabled'>>): Promise<ComputerDriverStatus> {
  const binary = computerDriverPath();
  const [statusText, permissionsText] = binary
    ? await Promise.all([askDriver(binary, ['status']), process.platform === 'darwin' ? askDriver(binary, ['permissions', 'status']) : Promise.resolve(null)])
    : [null, null];
  return readComputerDriverStatus({ path: binary, statusText, permissionsText, servers });
}

/** The MCP server record Clem keeps for the driver. */
export function computerDriverServer(binary: string): ManagedMcpServer {
  return {
    name: COMPUTER_DRIVER_SERVER_NAME,
    type: 'stdio',
    command: binary,
    args: ['mcp'],
    description: 'Your computer: Cua Driver clicks, types and reads in the apps on this machine for Clem.',
    enabled: true,
    source: 'user',
  };
}
