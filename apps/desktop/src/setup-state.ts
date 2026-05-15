import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * First-run detection + setup-complete marker.
 *
 * The marker file lives at ~/.clementine-next/state/setup-complete.json.
 * Once the user finishes the wizard, we write it; on next launch we
 * route directly to the dashboard. The file holds enough metadata
 * (timestamp, version, what was configured) to drive a future
 * "re-run setup" flow without losing the user's existing config.
 *
 * Detection considers a state "needs setup" when:
 *   - The marker file is absent OR
 *   - No usable auth credential exists yet (neither OPENAI_API_KEY
 *     in env nor a codex auth.json on disk nor anything in the
 *     SecretStore file vault)
 *
 * Skipping the wizard with an existing .env-based setup is fine —
 * the env backend is a first-class fallback. The wizard surface
 * exists primarily for users who installed the .app via DMG and
 * have never touched a terminal.
 */

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.clementine-next', 'state');
const MARKER_FILE = path.join(STATE_DIR, 'setup-complete.json');
const VAULT_FILE = path.join(STATE_DIR, 'secrets-vault.json');
const HOME_ENV = path.join(HOME, '.clementine-next', '.env');
const REPO_ENV_HINTS = [
  path.join(HOME, 'clementine-next', '.env'),
  path.join(process.cwd(), '.env'),
];
const CODEX_AUTH = path.join(HOME, '.codex', 'auth.json');

export interface SetupCompleteRecord {
  completedAt: string;
  version: 'v1';
  configured: {
    auth: 'openai' | 'codex' | 'skipped';
    discord: boolean;
    composio: boolean;
    workspaceCount: number;
    profileSet: boolean;
  };
}

export type SetupConfiguredSummary = SetupCompleteRecord['configured'];

/** True when the user already has SOME usable credential anywhere
 *  (env, file vault, or codex auth). Used to choose between the
 *  setup wizard and the dashboard. */
export function hasAnyUsableCredential(): boolean {
  // Check process env
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.length > 0) return true;

  // Check .env files
  for (const file of [HOME_ENV, ...REPO_ENV_HINTS]) {
    if (!existsSync(file)) continue;
    try {
      for (const line of readFileSync(file, 'utf-8').split('\n')) {
        const m = line.match(/^OPENAI_API_KEY\s*=\s*(.+?)\s*$/);
        if (m && m[1] && m[1] !== '""' && m[1] !== "''") return true;
      }
    } catch { /* keep looking */ }
  }

  // Check codex auth
  if (existsSync(CODEX_AUTH)) {
    try {
      const parsed = JSON.parse(readFileSync(CODEX_AUTH, 'utf-8'));
      if (parsed && (parsed.access_token || parsed.id_token)) return true;
    } catch { /* fall through */ }
  }

  // Check SecretStore file vault
  if (existsSync(VAULT_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(VAULT_FILE, 'utf-8'));
      const entries = parsed?.entries ?? {};
      for (const key of Object.keys(entries)) {
        if (key.includes('openai') || key.includes('codex')) {
          if (entries[key] && typeof entries[key] === 'string' && entries[key].length > 0) return true;
        }
      }
    } catch { /* fall through */ }
  }

  return false;
}

export function hasCompletedSetup(): boolean {
  return existsSync(MARKER_FILE);
}

/** Final "is this a first-run install" decision used by main.ts. */
export function needsSetup(): boolean {
  if (hasCompletedSetup()) return false;
  return !hasAnyUsableCredential();
}

/** Read the marker so the dashboard or tray can surface "configured X days ago". */
export function loadSetupRecord(): SetupCompleteRecord | null {
  if (!existsSync(MARKER_FILE)) return null;
  try {
    return JSON.parse(readFileSync(MARKER_FILE, 'utf-8')) as SetupCompleteRecord;
  } catch {
    return null;
  }
}

/** Write the setup-complete marker atomically. Called when the
 *  wizard reaches the "Done" step. */
export function writeSetupComplete(record: Omit<SetupCompleteRecord, 'completedAt' | 'version'>): SetupCompleteRecord {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const full: SetupCompleteRecord = {
    completedAt: new Date().toISOString(),
    version: 'v1',
    configured: record.configured,
  };
  const tmp = `${MARKER_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(full, null, 2), 'utf-8');
  renameSync(tmp, MARKER_FILE);
  return full;
}

/** Test helper / "Reset setup" admin action. */
export function clearSetupComplete(): void {
  if (!existsSync(MARKER_FILE)) return;
  try { unlinkSync(MARKER_FILE); } catch { /* ignore */ }
}
