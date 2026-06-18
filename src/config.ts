import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthMode, Models } from './types.js';
import { isStrongLocalSecret } from './runtime/security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PKG_DIR = path.resolve(__dirname, '..');
const DEFAULT_BASE_DIR = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine-next');
export const BASE_DIR = DEFAULT_BASE_DIR;

function parseEnvFile(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {};

  const result: Record<string, string> = {};
  for (const rawLine of readFileSync(envPath, 'utf-8').split('\n')) {
    // Preserve trailing whitespace on values — some folder names
    // carry significant trailing spaces (e.g. a project folder a
    // user named with a stray space at the end). Strip only leading
    // whitespace and trailing \r so comments and key-trim still
    // work, but leave the value bytes alone.
    const line = rawLine.replace(/^\s+|\r+$/g, '');
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export const ACTIVE_ENV_FILES = [
  path.join(PKG_DIR, '.env'),
  path.join(process.cwd(), '.env'),
  path.join(BASE_DIR, '.env'),
].filter((filePath, index, items) => existsSync(filePath) && items.indexOf(filePath) === index);

const env = Object.assign({}, ...ACTIVE_ENV_FILES.map((filePath) => parseEnvFile(filePath)));

function getEnv(key: string, fallback = ''): string {
  return process.env[key] ?? env[key] ?? fallback;
}

function parseCsvEnv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function normalizeWebhookHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'localhost') return '127.0.0.1';
  if (trimmed === '::1') return '::1';
  if (trimmed === '0.0.0.0' || trimmed === '::') return trimmed;
  if (/^[A-Za-z0-9.-]+$/.test(trimmed) || /^[0-9a-f:.]+$/i.test(trimmed)) return trimmed;
  return '127.0.0.1';
}

export function isLoopbackWebhookHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export function getRuntimeEnv(key: string, fallback = ''): string {
  const activeEnvFiles = [
    path.join(PKG_DIR, '.env'),
    path.join(process.cwd(), '.env'),
    path.join(BASE_DIR, '.env'),
  ].filter((filePath, index, items) => existsSync(filePath) && items.indexOf(filePath) === index);
  const currentEnv = Object.assign({}, ...activeEnvFiles.map((filePath) => parseEnvFile(filePath)));
  return process.env[key] ?? currentEnv[key] ?? fallback;
}

/**
 * Sync fallback reader for the file-backed secrets vault.
 *
 * The SecretStore (src/runtime/secrets) is the canonical async path,
 * but legacy sync call sites can call into this helper for a no-await
 * lookup. Reads the same JSON file the FileSecretBackend writes to
 * (~/.clementine-next/state/secrets-vault.json). Returns undefined
 * cleanly when absent or unreadable — never throws.
 */
function readSecretFromFileVaultSync(name: string): string | undefined {
  const vaultPath = path.join(BASE_DIR, 'state', 'secrets-vault.json');
  if (!existsSync(vaultPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(vaultPath, 'utf-8')) as { version?: string; entries?: Record<string, string> };
    if (parsed.version !== 'v1' || !parsed.entries) return undefined;
    const value = parsed.entries[name];
    return value && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function getOpenAiApiKey(): string {
  // Env wins (highest priority for the sync path) → file vault → empty.
  // The composite SecretStore implements the full file/env/keychain read
  // order asynchronously; this sync helper keeps existing call sites
  // working without forcing async refactors.
  // Vault first — matches CompositeSecretStore precedence. See
  // WEBHOOK_SECRET comment + the 2026-05-23 Composio drift incident.
  const fromFile = readSecretFromFileVaultSync('openai_api_key');
  if (fromFile) return fromFile;
  const fromEnv = getRuntimeEnv('OPENAI_API_KEY', '');
  return fromEnv ?? '';
}

export const ASSISTANT_NAME = getEnv('ASSISTANT_NAME', 'Clementine');
export const OWNER_NAME = getEnv('OWNER_NAME', '');
export const OPENAI_API_KEY = getEnv('OPENAI_API_KEY', '');
export const AUTH_MODE = ((): AuthMode => {
  const raw = getEnv('AUTH_MODE', 'api_key');
  if (raw === 'codex_oauth') return 'codex_oauth';
  if (raw === 'claude_oauth') return 'claude_oauth';
  return 'api_key';
})();

/**
 * Live-readable brain selector. Unlike the boot-time `AUTH_MODE` const above
 * (frozen at module load), this re-reads `AUTH_MODE` from the runtime env on
 * every call — so the active brain (Codex ↔ Claude) can be switched from
 * Settings WITHOUT a daemon restart. The harness reads this at the start of
 * each run (codex-client.ts), and the active-brain route both persists to
 * `.env` (survives restart) and mutates `process.env.AUTH_MODE` (so this getter
 * reflects the change the same session). Falls back to the boot const when
 * unset, so byte-identical for users who never touch the switch.
 */
export function getActiveAuthMode(): AuthMode {
  const raw = getRuntimeEnv('AUTH_MODE', AUTH_MODE);
  if (raw === 'codex_oauth') return 'codex_oauth';
  if (raw === 'claude_oauth') return 'claude_oauth';
  return 'api_key';
}

/** Claude (Anthropic) flagship-brain support — peer to Codex. Gated default-OFF;
 *  flip with AUTH_MODE=claude_oauth (and the kill-switch below). Mirrors the
 *  Codex OAuth subscription path: reads the user's Claude Code OAuth token and
 *  bills the subscription (Agent-SDK credit), never an API key. */
export function getClaudeBrainEnabled(): boolean {
  const raw = (getRuntimeEnv('CLEMENTINE_CLAUDE_BRAIN', '') || '').trim().toLowerCase();
  if (raw === 'on' || raw === '1' || raw === 'true') return true;
  // Implicitly enabled when AUTH_MODE selects it — read LIVE so this tracks the
  // in-app brain switch the same session (the boot const would go stale).
  return getActiveAuthMode() === 'claude_oauth';
}

/** Default Claude brain model (current flagship, verified live 2026-06-09). */
export function getClaudeBrainModel(): string {
  return (getRuntimeEnv('CLAUDE_MODEL', '') || '').trim() || 'claude-opus-4-8';
}

/**
 * The Claude model used as the fusion VERIFY CHECKER (and debate judge). Defaults
 * to Sonnet 4.6 — a fast, low-contention "minimal checker": a verify pass only
 * confirms/refines an already-drafted answer, so it does not need the flagship's
 * depth, and Opus 4.8 (the most contended tier on Max/Pro) routinely hung past
 * the checker deadline → the check silently shipped the unchecked draft. Keeping
 * the checker on Sonnet makes the check actually complete, fast, while a full
 * single-brain Claude run (getClaudeBrainModel) stays on Opus. Override with
 * CLEMMY_DEBATE_CHECKER_MODEL (e.g. claude-opus-4-8 to check with the flagship,
 * or claude-haiku-4-5 for the lightest pass).
 */
export function getDebateCheckerModel(): string {
  return (getRuntimeEnv('CLEMMY_DEBATE_CHECKER_MODEL', '') || '').trim() || 'claude-sonnet-4-6';
}

export const CLAUDE_MODEL_PRESETS = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 (flagship)' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];
export const CODEX_AUTH_SOURCE_FILE = getEnv('CODEX_AUTH_SOURCE_FILE', path.join(os.homedir(), '.codex', 'auth.json'));
export const CODEX_EXECUTABLE = getEnv('CODEX_EXECUTABLE', 'codex');
export const CODEX_INSTALL_PACKAGE = getEnv('CODEX_INSTALL_PACKAGE', '@openai/codex');
export const CODEX_SANDBOX_MODE = getEnv('CODEX_SANDBOX_MODE', 'workspace-write');
export const CODEX_USE_FULL_AUTO = getEnv('CODEX_USE_FULL_AUTO', 'true').toLowerCase() === 'true';

export type ModelTier = keyof Models;

export const DEFAULT_MODELS: Models = {
  fast: 'gpt-5.4-mini',
  primary: 'gpt-5.4',
  deep: 'gpt-5.4',
};

export const MODEL_ENV_KEYS: Record<ModelTier, string> = {
  fast: 'OPENAI_MODEL_FAST',
  primary: 'OPENAI_MODEL_PRIMARY',
  deep: 'OPENAI_MODEL_DEEP',
};

export const MODEL_PRESETS = [
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
];

export function normalizeModelId(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return fallback;
  if (!/^[A-Za-z0-9._:-]+$/.test(raw)) return fallback;
  return raw;
}

export function getModelForTier(tier: ModelTier): string {
  return normalizeModelId(getRuntimeEnv(MODEL_ENV_KEYS[tier], DEFAULT_MODELS[tier]), DEFAULT_MODELS[tier]);
}

export const MODELS: Models = {
  get fast() { return getModelForTier('fast'); },
  get primary() { return getModelForTier('primary'); },
  get deep() { return getModelForTier('deep'); },
};

export function getModelSettingsSnapshot(): {
  models: Models;
  defaults: Models;
  envKeys: Record<ModelTier, string>;
  presets: typeof MODEL_PRESETS;
  processEnvOverrides: Record<ModelTier, boolean>;
} {
  return {
    models: {
      fast: MODELS.fast,
      primary: MODELS.primary,
      deep: MODELS.deep,
    },
    defaults: { ...DEFAULT_MODELS },
    envKeys: { ...MODEL_ENV_KEYS },
    presets: [...MODEL_PRESETS],
    processEnvOverrides: {
      fast: process.env[MODEL_ENV_KEYS.fast] !== undefined,
      primary: process.env[MODEL_ENV_KEYS.primary] !== undefined,
      deep: process.env[MODEL_ENV_KEYS.deep] !== undefined,
    },
  };
}

// ----------------------------------------------------------------------
// BYO model backend — worker offload & all-in (non-Codex) routing.
//
// Additive and default-OFF: when MODEL_ROUTING_MODE is unset/'off' OR no
// BYO backend is configured, the harness registers CodexModelProvider
// exactly as before (byte-identical). These knobs only take effect when a
// user opts in via Settings → Models.
//
//   off    → everything on Codex (today's behavior)
//   worker → worker/grunt-work agents on the BYO model; brain + judge on Codex
//   all_in → every role on the BYO model (judge on a 2nd BYO model if set)
// ----------------------------------------------------------------------
export type ModelRoutingMode = 'off' | 'worker' | 'all_in';

export function getModelRoutingMode(): ModelRoutingMode {
  const v = (getRuntimeEnv('MODEL_ROUTING_MODE', 'off') || 'off').toLowerCase();
  return v === 'worker' || v === 'all_in' ? v : 'off';
}

/** The model the delegated worker/grunt-work agents run on. Defaults to
 *  the primary (Codex) model so an unset knob is byte-identical to today. */
export function getWorkerModel(): string {
  const raw = getRuntimeEnv('OPENAI_MODEL_WORKER', '') || '';
  return raw ? normalizeModelId(raw, MODELS.primary) : MODELS.primary;
}

export interface ByoBackendConfig {
  configured: boolean;
  baseURL: string;
  apiKey: string;
  primaryId: string;
  judgeId: string;
  providerLabel: string;
}

/** Resolve the user-supplied (bring-your-own) OpenAI-compatible backend
 *  used for worker/all-in routing (e.g. MiniMax, DeepSeek, or any
 *  Chat-Completions endpoint). Key is vault-first, then env. */
export function getByoBackendConfig(): ByoBackendConfig {
  // BYO ids may include '/' (OpenRouter-style) so we use a looser sanity
  // filter than normalizeModelId (which is tuned for OpenAI gpt-* ids).
  const cleanId = (raw: unknown): string => {
    const s = typeof raw === 'string' ? raw.trim() : '';
    return /^[A-Za-z0-9._:/-]+$/.test(s) ? s : '';
  };
  const baseURL = (getRuntimeEnv('BYO_MODEL_BASE_URL', '') || '').trim();
  const apiKey = (readSecretFromFileVaultSync('byo_model_api_key') || getRuntimeEnv('BYO_MODEL_API_KEY', '') || '').trim();
  const primaryId = cleanId(getRuntimeEnv('BYO_MODEL_ID', ''));
  const judgeRaw = cleanId(getRuntimeEnv('BYO_MODEL_JUDGE_ID', ''));
  return {
    configured: Boolean(baseURL && apiKey),
    baseURL,
    apiKey,
    primaryId,
    judgeId: judgeRaw || primaryId,
    providerLabel: (getRuntimeEnv('BYO_MODEL_PROVIDER', '') || '').trim(),
  };
}

export const VAULT_DIR = path.join(BASE_DIR, 'vault');
export const WEBHOOK_ENABLED = getEnv('WEBHOOK_ENABLED', 'false').toLowerCase() === 'true';
export const WEBHOOK_PORT = parseInt(getEnv('WEBHOOK_PORT', '8420'), 10);
export const WEBHOOK_HOST = normalizeWebhookHost(getEnv('WEBHOOK_HOST', '127.0.0.1'));
export const WEBHOOK_ALLOW_LAN = getEnv('WEBHOOK_ALLOW_LAN', 'false').toLowerCase() === 'true';
// Vault first — matches CompositeSecretStore precedence (vault → env).
// Previously env beat vault, which masked freshly-saved values when a
// stale .env was present. (Observed 2026-05-23 for composio_api_key;
// applied here for symmetry across all secrets.)
export const WEBHOOK_SECRET = readSecretFromFileVaultSync('webhook_secret') || getEnv('WEBHOOK_SECRET', '') || '';
export const WEBHOOK_SECRET_IS_STRONG = isStrongLocalSecret(WEBHOOK_SECRET);
// Raw env intent. Empty string = "unset" (auto-decide from token presence
// below); 'true'/'false' are explicit overrides. See DISCORD_ENABLED.
const DISCORD_ENABLED_RAW = getEnv('DISCORD_ENABLED', '').toLowerCase();
// When true, Discord routes incoming messages through the 0.3 harness
// (Orchestrator + sub-agents + auto-continuation + live progress) instead
// of the legacy v0.2 gateway path. DEFAULT-ON (2026-06-14 FORK-collapse):
// Discord was the last surface still defaulting to the ungated legacy
// engine — every other surface defaults to the gated harness, so Discord
// now matches. The legacy gateway path stays as a kill-switch
// (DISCORD_HARNESS_ENABLED=false) for reversibility until it's deleted
// post-soak. handleDiscordHarnessMessage (discord-harness.ts, tested) is
// the path Nathan has run in production.
export const DISCORD_HARNESS_ENABLED = !['false', '0', 'no', 'off'].includes(
  getEnv('DISCORD_HARNESS_ENABLED', 'true').toLowerCase(),
);
// Vault fallback matches WEBHOOK_SECRET / OPENAI_API_KEY pattern — when
// the user saves their bot token via the credentials UI it lands in
// secrets-vault.json, NOT in .env. Without this fallback the daemon
// reads only process.env and the bot stays offline even after restart.
// Reported 2026-05-22: buddy added token via Integrations panel, saw
// status "CONNECTED file", restarted Clementine — bot still showed as
// offline because DISCORD_BOT_TOKEN was the empty string.
export const DISCORD_BOT_TOKEN = readSecretFromFileVaultSync('discord_bot_token') || getEnv('DISCORD_BOT_TOKEN', '') || '';
// Discord turns on automatically when a bot token is present, so "paste a
// token → bot connects" works across every setup surface (CLI setup,
// desktop wizard, credentials hub, manual .env) without each one having to
// also remember to write DISCORD_ENABLED=true. This is the second half of
// the vault-token fallback above: together they close the "token saved but
// bot still offline after restart" gap end to end. An explicit
// DISCORD_ENABLED=false still force-disables while keeping the token saved.
export function resolveDiscordEnabled(rawEnabled: string, hasToken: boolean): boolean {
  const raw = rawEnabled.trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return hasToken; // unset → decide by token presence
}
export const DISCORD_ENABLED = resolveDiscordEnabled(DISCORD_ENABLED_RAW, DISCORD_BOT_TOKEN.length > 0);
export const DISCORD_CLIENT_ID = getEnv('DISCORD_CLIENT_ID', '');
export const DISCORD_REQUIRE_MENTION = getEnv('DISCORD_REQUIRE_MENTION', 'true').toLowerCase() === 'true';
export const DISCORD_DM_ALLOWED_USERS = parseCsvEnv(getEnv('DISCORD_DM_ALLOWED_USERS', ''));
export const DISCORD_ALLOWED_USERS = parseCsvEnv(
  getEnv('DISCORD_ALLOWED_USERS', getEnv('DISCORD_DM_ALLOWED_USERS', '')),
);
export const DISCORD_DM_POLL_INTERVAL_MS = parseInt(getEnv('DISCORD_DM_POLL_INTERVAL_MS', '5000'), 10);
export const DISCORD_ALLOWED_CHANNELS = parseCsvEnv(getEnv('DISCORD_ALLOWED_CHANNELS', ''));
export const DISCORD_PUSH_PROACTIVE_BRIEFS = getEnv('DISCORD_PUSH_PROACTIVE_BRIEFS', 'false').toLowerCase() === 'true';
export const LOCAL_MCP_ENABLED = getEnv('LOCAL_MCP_ENABLED', 'true').toLowerCase() === 'true';
export const MCP_AUTO_IMPORT_ENABLED = getEnv('MCP_AUTO_IMPORT_ENABLED', 'false').toLowerCase() === 'true';
export const MCP_SERVERS_FILE = path.join(BASE_DIR, 'mcp', 'servers.json');
export const COMPOSIO_API_KEY = getEnv('COMPOSIO_API_KEY', '');
export const COMPOSIO_USER_ID = getEnv('COMPOSIO_USER_ID', 'default');
