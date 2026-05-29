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
export const AUTH_MODE = (getEnv('AUTH_MODE', 'api_key') === 'codex_oauth' ? 'codex_oauth' : 'api_key') satisfies AuthMode;
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
export const DISCORD_ENABLED = getEnv('DISCORD_ENABLED', 'false').toLowerCase() === 'true';
// When true, Discord routes incoming messages through the 0.3 harness
// (Orchestrator + sub-agents + auto-continuation + live progress) instead
// of the v0.2 gateway. Off by default so the desktop release ships the
// stable path and we can flip per-deployment.
export const DISCORD_HARNESS_ENABLED = getEnv('DISCORD_HARNESS_ENABLED', 'false').toLowerCase() === 'true';
// Vault fallback matches WEBHOOK_SECRET / OPENAI_API_KEY pattern — when
// the user saves their bot token via the credentials UI it lands in
// secrets-vault.json, NOT in .env. Without this fallback the daemon
// reads only process.env and the bot stays offline even after restart.
// Reported 2026-05-22: buddy added token via Integrations panel, saw
// status "CONNECTED file", restarted Clementine — bot still showed as
// offline because DISCORD_BOT_TOKEN was the empty string.
export const DISCORD_BOT_TOKEN = readSecretFromFileVaultSync('discord_bot_token') || getEnv('DISCORD_BOT_TOKEN', '') || '';
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
