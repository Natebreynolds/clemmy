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
 * Detection considers a state "needs setup" when the marker file is
 * absent. Existing env/Codex/vault credentials are still valid
 * fallback inputs, but they must not silently skip the wizard on a
 * fresh desktop install. The setup-complete marker is the only source
 * of truth for "this app has been onboarded."
 */

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.clementine-next', 'state');
const MARKER_FILE = path.join(STATE_DIR, 'setup-complete.json');
const VAULT_FILE = path.join(STATE_DIR, 'secrets-vault.json');
const LOCAL_AUTH_FILE = path.join(STATE_DIR, 'auth.json');
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
 *  (env, file vault, or codex auth). Used for diagnostics and setup
 *  copy, not as the first-run skip gate. */
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
      if (parsed?.tokens?.access_token && parsed.tokens.refresh_token) return true;
    } catch { /* fall through */ }
  }

  if (existsSync(LOCAL_AUTH_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(LOCAL_AUTH_FILE, 'utf-8'));
      if (parsed?.codexOauth?.accessToken && parsed.codexOauth.refreshToken) return true;
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

/* ────────────────────────────────────────────────────────────────────────────
   What is ALREADY configured, and therefore what the wizard must not re-ask.

   The setup-complete marker is the only first-run gate (needsSetup above), so
   a deleted or corrupt marker replays the whole wizard over a fully configured
   install — the user is asked again for an API key they already gave us, and
   an empty answer would overwrite nothing but every screen still costs them a
   decision. The fix is not another gate; it is for each STEP to know whether
   its question is already answered.

   These two functions are the whole mechanism, and they are separated on
   purpose: detectExistingConfiguration touches the disk, planSetupSteps is
   pure. The wizard HTML is rendered in the main process, so the plan is
   computed once at render time and inlined — the sandboxed renderer never
   needs a new IPC channel to know what to skip.
   ──────────────────────────────────────────────────────────────────────────── */

export type SetupStepId = 'welcome' | 'auth' | 'profile' | 'workspace' | 'launch';

export interface ExistingConfiguration {
  /** Which model credential we can already see. 'none' means we must ask. */
  auth: 'openai' | 'codex' | 'none';
  /** An OpenAI key is present for embeddings + voice (may be the same key). */
  embeddingKey: boolean;
  workspaces: string[];
  profile: {
    preferredName: string;
    role: string;
    timezone: string;
    communicationTone: string;
  };
  discord: boolean;
  composio: boolean;
}

interface SetupPaths {
  vaultFile: string;
  localAuthFile: string;
  homeEnv: string;
  codexAuth: string;
  profileFile: string;
}

function setupPathsFor(homeDir: string): SetupPaths {
  const stateDir = path.join(homeDir, '.clementine-next', 'state');
  return {
    vaultFile: path.join(stateDir, 'secrets-vault.json'),
    localAuthFile: path.join(stateDir, 'auth.json'),
    homeEnv: path.join(homeDir, '.clementine-next', '.env'),
    codexAuth: path.join(homeDir, '.codex', 'auth.json'),
    profileFile: path.join(stateDir, 'user-profile.json'),
  };
}

function readJson(file: string): Record<string, any> | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readEnvPairs(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const value = trimmed.slice(eq + 1).trim();
      if (value && value !== '""' && value !== "''") out[trimmed.slice(0, eq).trim()] = value;
    }
  } catch { /* an unreadable .env is the same as an absent one */ }
  return out;
}

function vaultHas(vault: Record<string, any> | null, name: string): boolean {
  const value = vault?.entries?.[name];
  return typeof value === 'string' && value.length > 0;
}

/**
 * Look at the disk and report what a returning user already has. Never throws;
 * an unreadable file is treated as "not configured", which costs the user one
 * extra question rather than silently skipping a step they still need.
 *
 * `homeDir` is injectable so this is testable against a temp directory rather
 * than against whoever happens to be running the test.
 */
export function detectExistingConfiguration(opts: { homeDir?: string; env?: NodeJS.ProcessEnv } = {}): ExistingConfiguration {
  const homeDir = opts.homeDir ?? HOME;
  const env = opts.env ?? process.env;
  const paths = setupPathsFor(homeDir);

  const vault = readJson(paths.vaultFile);
  const homeEnv = readEnvPairs(paths.homeEnv);

  const openaiKey =
    vaultHas(vault, 'openai_api_key') ||
    Boolean(env.OPENAI_API_KEY && env.OPENAI_API_KEY.length > 0) ||
    Boolean(homeEnv.OPENAI_API_KEY);

  const codexTokens = readJson(paths.codexAuth);
  const localAuth = readJson(paths.localAuthFile);
  const codex =
    Boolean(codexTokens?.tokens?.access_token && codexTokens?.tokens?.refresh_token) ||
    Boolean(localAuth?.codexOauth?.accessToken && localAuth?.codexOauth?.refreshToken) ||
    vaultHas(vault, 'codex_oauth_refresh_token');

  const profileJson = readJson(paths.profileFile) ?? {};
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

  return {
    // An explicit OpenAI key wins the label because it is the one the user
    // typed; Codex is the fallback because it can be inherited from a Codex
    // CLI login the user did for something else entirely.
    auth: openaiKey ? 'openai' : codex ? 'codex' : 'none',
    embeddingKey: openaiKey,
    workspaces: (homeEnv.WORKSPACE_DIRS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    profile: {
      preferredName: str(profileJson.preferredName) || str(profileJson.displayName),
      role: str(profileJson.role),
      timezone: str(profileJson.timezone),
      communicationTone: str(profileJson.communicationTone) || 'balanced',
    },
    discord: vaultHas(vault, 'discord_bot_token') || Boolean(homeEnv.DISCORD_BOT_TOKEN),
    composio: vaultHas(vault, 'composio_api_key') || Boolean(homeEnv.COMPOSIO_API_KEY),
  };
}

/**
 * The steps this person still has to answer. Pure.
 *
 * 'welcome' and 'launch' always run — one is the greeting and the other is the
 * button that starts the app, neither asks a question. Everything between is a
 * question, and a question with an answer already on disk is not asked.
 *
 * Discord and Composio are deliberately absent: standing a channel build in
 * front of someone who has not yet said a word to Clementine is backwards.
 * They live behind an optional disclosure on the last step and in Connect.
 */
export function planSetupSteps(existing: ExistingConfiguration): SetupStepId[] {
  const steps: SetupStepId[] = ['welcome'];
  if (existing.auth === 'none') steps.push('auth');
  // Name + timezone is what actually changes how she writes; role and tone are
  // nice-to-have, so having those two is enough to not ask again.
  if (!(existing.profile.preferredName && existing.profile.timezone)) steps.push('profile');
  if (existing.workspaces.length === 0) steps.push('workspace');
  steps.push('launch');
  return steps;
}

/** What the wizard submits as the user's auth answer. */
export type SetupAuthChoice = 'openai' | 'codex' | 'skipped';

/**
 * The wizard's auth answer BEFORE the user is asked — and for a returning
 * user, instead of asking.
 *
 * planSetupSteps() drops the 'auth' step whenever a credential is already on
 * disk, so for a returning user nothing ever writes this value: it is what
 * `clemmy:setup-complete` receives, and main.ts turns it into AUTH_MODE. It
 * was seeded to the literal 'codex' while the step always ran, which was
 * harmless then and is not now — an OpenAI-key user who also has a stale
 * ~/.codex/auth.json (which detectExistingConfiguration deliberately ranks
 * BELOW the key) finished the wizard and got AUTH_MODE=codex_oauth written
 * against the credential they do not use. So the seed is the detection, and
 * the literal is only the pre-selection on a step that is actually shown.
 */
export function initialAuthChoice(existing: ExistingConfiguration): SetupAuthChoice {
  return existing.auth === 'none' ? 'codex' : existing.auth;
}
