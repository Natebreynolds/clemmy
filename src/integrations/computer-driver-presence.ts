/**
 * Whether Clem's own computer driver is the browser on this machine, read
 * from what the daemon leaves on disk: her copy of the driver in her tools
 * folder, and its server record in her MCP servers file. A leaf on purpose:
 * the sealed local-tool transport asks this on every browser tool call and
 * must stay free of the host's configuration and event-log graph.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { clementineHomeDir, clemToolsBin } from '../runtime/clem-tools.js';

export const COMPUTER_DRIVER_SERVER_NAME = 'cua-driver';

export interface ComputerDriverServerRecord {
  name?: string;
  command?: unknown;
  args?: unknown;
  enabled?: unknown;
}

/** The one place the user's MCP server records live; config.ts names the same file. */
export function mcpServersFilePath(home: string = clementineHomeDir()): string {
  return path.join(home, 'mcp', 'servers.json');
}

/** Clem's own copy of the driver, the only one she supervises. */
export function ownComputerDriverBinary(toolsBin: string = clemToolsBin(), platform: NodeJS.Platform = process.platform): string {
  return path.join(toolsBin, platform === 'win32' ? 'cua-driver.exe' : 'cua-driver');
}

/** A server record that registers the driver and is not switched off. */
export function computerDriverRecordConnected(servers: ReadonlyArray<ComputerDriverServerRecord>): boolean {
  return servers.some((server) => server.enabled !== false
    && typeof server.command === 'string' && /cua-driver(\.exe)?$/.test(server.command)
    && Array.isArray(server.args) && server.args.includes('mcp'));
}

export function readUserMcpServerRecords(file: string = mcpServersFilePath()): ComputerDriverServerRecord[] {
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    return Object.entries(data).map(([name, record]) => ({ name, ...(record ?? {}) }));
  } catch {
    return [];
  }
}

/**
 * True when Clem's own driver is installed and its record is on. The env
 * override exists for pins and for an owner who wants the switch forced.
 */
export function computerDriverIsTheBrowserNow(input: { home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): boolean {
  const env = input.env ?? process.env;
  if (env.CLEMMY_COMPUTER_IS_THE_BROWSER === '1') return true;
  if (env.CLEMMY_COMPUTER_IS_THE_BROWSER === '0') return false;
  const home = input.home ?? clementineHomeDir(env);
  const binary = ownComputerDriverBinary(path.join(home, 'tools', 'bin'), input.platform ?? process.platform);
  if (!existsSync(binary)) return false;
  return computerDriverRecordConnected(readUserMcpServerRecords(mcpServersFilePath(home)));
}
