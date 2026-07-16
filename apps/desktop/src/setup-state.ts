import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CODEX_GRANT_PROVENANCE } from './codex-oauth-store.js';
import { CLEMENTINE_HOME_DIR, CLEMENTINE_STATE_DIR } from './clementine-paths.js';

/**
 * First-run detection + setup-complete marker.
 *
 * The marker file lives at ~/.clementine-next/state/setup-complete.json.
 * Once the user finishes the wizard, we write it; on next launch we
 * route directly to the dashboard. The file holds enough metadata
 * (timestamp, version, what was configured) to drive a future
 * "re-run setup" flow without losing the user's existing config.
 *
 * Detection considers a state "needs setup" when the marker file is
 * absent. Existing env and Clementine-owned vault credentials are still
 * valid fallback inputs, but they must not silently skip the wizard on a
 * fresh desktop install. The external Codex CLI grant is deliberately not
 * a Clementine credential. The setup-complete marker is the only source of
 * truth for "this app has been onboarded."
 */

const HOME = os.homedir();
const STATE_DIR = CLEMENTINE_STATE_DIR;
const MARKER_FILE = path.join(STATE_DIR, 'setup-complete.json');
const VAULT_FILE = path.join(STATE_DIR, 'secrets-vault.json');
const LOCAL_AUTH_FILE = path.join(STATE_DIR, 'auth.json');
const HOME_ENV = path.join(CLEMENTINE_HOME_DIR, '.env');
const REPO_ENV_HINTS = [
  path.join(HOME, 'clementine-next', '.env'),
  path.join(process.cwd(), '.env'),
];

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

/** True when Clementine already has a usable credential of its own
 *  (env, file vault, or its native Codex grant). Used for diagnostics and
 *  setup copy, not as the first-run skip gate. An external Codex CLI grant
 *  is intentionally excluded because Clementine must mint its own rotating
 *  refresh-token family. */
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

  if (existsSync(LOCAL_AUTH_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(LOCAL_AUTH_FILE, 'utf-8'));
      if (
        parsed?.source === 'native'
        && parsed?.codexOauth?.grantProvenance === CODEX_GRANT_PROVENANCE
        && typeof parsed.codexOauth.grantId === 'string'
        && parsed.codexOauth.grantId.length > 0
        && parsed.codexOauth.accessToken
        && parsed.codexOauth.refreshToken
      ) return true;
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
  return !hasCompletedSetup();
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
