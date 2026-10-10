import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Setup wizard write-throughs that bypass the daemon (because the
 * daemon hasn't started yet during first-run).
 *
 *   - addWorkspaceDir(absPath) appends to WORKSPACE_DIRS in the user's
 *     ~/.clementine-next/.env (creating the file if missing). The
 *     daemon reads WORKSPACE_DIRS from env on boot.
 *
 *   - saveUserProfile(patch) writes the same JSON shape the daemon's
 *     src/runtime/user-profile.ts maintains. The daemon's loadUserProfile
 *     reads it on every chat turn.
 *
 * Atomic writes (tmp+rename), 0600 perms on the env file because it
 * may contain a WEBHOOK_SECRET. Idempotent — calling twice is safe.
 */

const HOME = os.homedir();
// The same home the credentials bridge, setup state and the daemon use.
const HOME_DIR = process.env.CLEMENTINE_HOME || path.join(HOME, '.clementine-next');
const STATE_DIR = path.join(HOME_DIR, 'state');
const HOME_ENV = path.join(HOME_DIR, '.env');
const PROFILE_FILE = path.join(STATE_DIR, 'user-profile.json');

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return out;
  } catch {
    return {};
  }
}

function writeEnvFile(filePath: string, values: Record<string, string>): void {
  ensureDir(path.dirname(filePath));
  const body = Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n';
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, filePath);
}

/** The folders a home with no chosen list works in by default: the daemon's
 *  own candidates (src/tools/shared.ts), kept identical by a parity test. */
export const DEFAULT_WORKSPACE_CANDIDATES: readonly string[] = [
  'Desktop', 'Documents', 'Developer', 'Projects', 'projects', 'repos', 'Repos', 'src', 'code', 'Code',
  'work', 'Work', 'dev', 'Dev', 'github', 'GitHub',
  path.join('Documents', 'GitHub'),
  path.join('source', 'repos'),
];

function isDirectory(candidate: string): boolean {
  try { return statSync(candidate).isDirectory(); } catch { return false; }
}

/** The default folders that exist on this computer, as the daemon resolves them. */
export function defaultWorkspaceDirs(home: string = HOME, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const oneDrive = platform === 'win32'
    ? [...new Set(['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']
      .map((key) => env[key]?.trim())
      .filter((value): value is string => Boolean(value && path.isAbsolute(value)))
      .map((root) => path.resolve(root)))]
    : [];
  return [
    ...DEFAULT_WORKSPACE_CANDIDATES.map((candidate) => path.join(home, candidate)),
    ...oneDrive.flatMap((root) => ['Desktop', 'Documents', path.join('Documents', 'GitHub')].map((candidate) => path.join(root, candidate))),
  ].filter(isDirectory);
}

/**
 * Adds one folder. With no list chosen yet the folders in use are the
 * defaults (Desktop, Documents, …); they are kept, never replaced by the one
 * folder added.
 */
export function addWorkspaceDir(absPath: string): void {
  if (!absPath || !absPath.trim()) return;
  const cleaned = absPath.trim();
  const env = readEnvFile(HOME_ENV);
  const configured = (env.WORKSPACE_DIRS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const existing = configured.length > 0 ? configured : defaultWorkspaceDirs();
  if (existing.includes(cleaned)) return;
  existing.push(cleaned);
  env.WORKSPACE_DIRS = existing.join(',');
  writeEnvFile(HOME_ENV, env);
}

const COMPUTER_ACCESS_FILE = path.join(STATE_DIR, 'computer-access.json');

/** The owner's computer-access choice, in the daemon's own file
 *  (src/runtime/computer-access.ts), written before the daemon exists. */
export function saveComputerAccess(choice: 'full' | 'standard'): void {
  ensureDir(STATE_DIR);
  const tmp = `${COMPUTER_ACCESS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ choice: choice === 'full' ? 'full' : 'standard', chosenAt: new Date().toISOString() }, null, 2), 'utf-8');
  renameSync(tmp, COMPUTER_ACCESS_FILE);
}

export function ensureHomeEnv(values: Record<string, string>): void {
  const env = readEnvFile(HOME_ENV);
  for (const [k, v] of Object.entries(values)) {
    if (env[k] === undefined || env[k] === '') env[k] = v;
  }
  writeEnvFile(HOME_ENV, env);
}

/** Always overwrites the given keys in the home .env (drops empty values). */
export function setHomeEnv(values: Record<string, string>): void {
  const env = readEnvFile(HOME_ENV);
  for (const [k, v] of Object.entries(values)) {
    if (v === '' || v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }
  writeEnvFile(HOME_ENV, env);
}

export interface ProfilePatch {
  preferredName?: string;
  displayName?: string;
  role?: string;
  timezone?: string;
  communicationTone?: 'terse' | 'balanced' | 'verbose';
  formality?: 'casual' | 'professional' | 'formal';
}

/** Write the user-profile.json file in the same shape user-profile.ts
 *  normalizes to. Partial-patch on top of any existing value so the
 *  wizard doesn't clobber stuff a user already had. */
export function saveUserProfile(patch: ProfilePatch): void {
  ensureDir(STATE_DIR);
  let existing: Record<string, unknown> = {};
  if (existsSync(PROFILE_FILE)) {
    try { existing = JSON.parse(readFileSync(PROFILE_FILE, 'utf-8')) ?? {}; }
    catch { existing = {}; }
  }
  const next = {
    ...existing,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== '')),
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${PROFILE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  renameSync(tmp, PROFILE_FILE);
}
