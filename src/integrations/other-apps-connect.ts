/**
 * Let another app on this computer hand Clementine work: the MCP entry
 * (src/cli/mcp.ts) launched from this installation, written into that app's
 * own MCP settings on the owner's tap. Only Clementine's entry is ever added,
 * changed or removed; the app's other settings stay as they were, the first
 * write keeps a copy of the original file, and a settings file that does not
 * read as JSON is left alone.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_DIR } from '../config.js';

export const CLEMENTINE_SERVER_NAME = 'clementine';

export interface ClemMcpConnection {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** How another app launches the MCP entry from this installation, or null
 *  when this build has no compiled entry (a source checkout). */
export function clemMcpConnection(input: {
  execPath?: string;
  runsInsideApp?: boolean;
  entry?: string;
  home?: string;
} = {}): ClemMcpConnection | null {
  const entry = input.entry ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli/mcp.js');
  if (!existsSync(entry)) return null;
  // The installed app runs its daemon with its own executable as Node.
  const runsInsideApp = input.runsInsideApp ?? Boolean(process.versions.electron);
  return {
    command: input.execPath ?? process.execPath,
    args: [entry],
    env: { ...(runsInsideApp ? { ELECTRON_RUN_AS_NODE: '1' } : {}), CLEMENTINE_HOME: input.home ?? BASE_DIR },
  };
}

export interface OtherApp {
  id: 'claude-desktop' | 'cursor';
  name: string;
  /** The folder that exists once the app has run on this computer. */
  folder: string;
  settingsFile: string;
  /** What the owner does after connecting for the app to see Clementine. */
  after: string;
}

export function otherApps(platform: NodeJS.Platform = process.platform, home = os.homedir(), appData = process.env.APPDATA): OtherApp[] {
  const claudeFolder = platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude')
    : platform === 'win32' ? path.join(appData ?? path.join(home, 'AppData', 'Roaming'), 'Claude')
      : path.join(home, '.config', 'Claude');
  const cursorFolder = path.join(home, '.cursor');
  return [
    { id: 'claude-desktop', name: 'Claude Desktop', folder: claudeFolder, settingsFile: path.join(claudeFolder, 'claude_desktop_config.json'),
      after: 'Quit and reopen Claude Desktop; Clementine then shows in its tools.' },
    { id: 'cursor', name: 'Cursor', folder: cursorFolder, settingsFile: path.join(cursorFolder, 'mcp.json'),
      after: 'Cursor picks it up on its own; if not, reopen Cursor.' },
  ];
}

export type OtherAppState = 'not_installed' | 'not_connected' | 'connected' | 'needs_update' | 'unreadable';

type Settings = { mcpServers?: Record<string, unknown> } & Record<string, unknown>;

function readSettings(file: string): Settings | null | 'unreadable' {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8') || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Settings : 'unreadable';
  } catch { return 'unreadable'; }
}

function sameConnection(entry: unknown, connection: ClemMcpConnection): boolean {
  const e = entry as Partial<ClemMcpConnection> | undefined;
  return Boolean(e) && e!.command === connection.command && JSON.stringify(e!.args ?? []) === JSON.stringify(connection.args)
    && JSON.stringify(e!.env ?? {}) === JSON.stringify(connection.env);
}

export function otherAppState(app: OtherApp, connection: ClemMcpConnection): OtherAppState {
  if (!existsSync(app.folder)) return 'not_installed';
  const settings = readSettings(app.settingsFile);
  if (settings === 'unreadable') return 'unreadable';
  const entry = settings?.mcpServers?.[CLEMENTINE_SERVER_NAME];
  if (!entry) return 'not_connected';
  return sameConnection(entry, connection) ? 'connected' : 'needs_update';
}

function writeSettings(file: string, settings: Settings): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}.before-clementine`;
  if (existsSync(file) && !existsSync(backup)) copyFileSync(file, backup);
  const temp = `${file}.clementine-${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(temp, file);
}

export function connectOtherApp(app: OtherApp, connection: ClemMcpConnection): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(app.folder)) return { ok: false, reason: `${app.name} has not run on this computer yet.` };
  const settings = readSettings(app.settingsFile);
  if (settings === 'unreadable') return { ok: false, reason: `${app.name}'s settings file could not be read, so it was left as it is.` };
  const next: Settings = { ...(settings ?? {}) };
  const servers = next.mcpServers && typeof next.mcpServers === 'object' && !Array.isArray(next.mcpServers) ? next.mcpServers : {};
  next.mcpServers = { ...servers, [CLEMENTINE_SERVER_NAME]: { command: connection.command, args: connection.args, env: connection.env } };
  writeSettings(app.settingsFile, next);
  return { ok: true };
}

export function disconnectOtherApp(app: OtherApp): { ok: true } | { ok: false; reason: string } {
  const settings = readSettings(app.settingsFile);
  if (settings === 'unreadable') return { ok: false, reason: `${app.name}'s settings file could not be read, so it was left as it is.` };
  if (!settings?.mcpServers?.[CLEMENTINE_SERVER_NAME]) return { ok: true };
  const servers = { ...settings.mcpServers };
  delete servers[CLEMENTINE_SERVER_NAME];
  writeSettings(app.settingsFile, { ...settings, mcpServers: servers });
  return { ok: true };
}
