import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
const STATE_DIR = path.join(HOME, '.clementine-next', 'state');
const HOME_DIR = path.join(HOME, '.clementine-next');
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

export function addWorkspaceDir(absPath: string): void {
  if (!absPath || !absPath.trim()) return;
  const cleaned = absPath.trim();
  const env = readEnvFile(HOME_ENV);
  const existing = (env.WORKSPACE_DIRS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (existing.includes(cleaned)) return;
  existing.push(cleaned);
  env.WORKSPACE_DIRS = existing.join(',');
  writeEnvFile(HOME_ENV, env);
}

export function ensureHomeEnv(values: Record<string, string>): void {
  const env = readEnvFile(HOME_ENV);
  for (const [k, v] of Object.entries(values)) {
    if (env[k] === undefined || env[k] === '') env[k] = v;
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
