import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthMode, Models } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PKG_DIR = path.resolve(__dirname, '..');
const DEFAULT_BASE_DIR = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine-next');
export const BASE_DIR = DEFAULT_BASE_DIR;

function parseEnvFile(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {};

  const result: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex);
    let value = trimmed.slice(eqIndex + 1);
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

export function getRuntimeEnv(key: string, fallback = ''): string {
  const activeEnvFiles = [
    path.join(PKG_DIR, '.env'),
    path.join(process.cwd(), '.env'),
    path.join(BASE_DIR, '.env'),
  ].filter((filePath, index, items) => existsSync(filePath) && items.indexOf(filePath) === index);
  const currentEnv = Object.assign({}, ...activeEnvFiles.map((filePath) => parseEnvFile(filePath)));
  return process.env[key] ?? currentEnv[key] ?? fallback;
}

export function getOpenAiApiKey(): string {
  return getRuntimeEnv('OPENAI_API_KEY', '');
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

export const MODELS: Models = {
  fast: getEnv('OPENAI_MODEL_FAST', 'gpt-5.4-mini'),
  primary: getEnv('OPENAI_MODEL_PRIMARY', 'gpt-5.4'),
  deep: getEnv('OPENAI_MODEL_DEEP', 'gpt-5.4'),
};

export const VAULT_DIR = path.join(BASE_DIR, 'vault');
export const WEBHOOK_ENABLED = getEnv('WEBHOOK_ENABLED', 'false').toLowerCase() === 'true';
export const WEBHOOK_PORT = parseInt(getEnv('WEBHOOK_PORT', '8420'), 10);
export const WEBHOOK_SECRET = getEnv('WEBHOOK_SECRET', '');
export const DISCORD_ENABLED = getEnv('DISCORD_ENABLED', 'false').toLowerCase() === 'true';
export const DISCORD_BOT_TOKEN = getEnv('DISCORD_BOT_TOKEN', '');
export const DISCORD_CLIENT_ID = getEnv('DISCORD_CLIENT_ID', '');
export const DISCORD_REQUIRE_MENTION = getEnv('DISCORD_REQUIRE_MENTION', 'true').toLowerCase() === 'true';
export const DISCORD_DM_ALLOWED_USERS = getEnv('DISCORD_DM_ALLOWED_USERS', '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
export const DISCORD_DM_POLL_INTERVAL_MS = parseInt(getEnv('DISCORD_DM_POLL_INTERVAL_MS', '5000'), 10);
export const DISCORD_ALLOWED_CHANNELS = getEnv('DISCORD_ALLOWED_CHANNELS', '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
export const LOCAL_MCP_ENABLED = getEnv('LOCAL_MCP_ENABLED', 'true').toLowerCase() === 'true';
export const MCP_SERVERS_FILE = path.join(BASE_DIR, 'mcp', 'servers.json');
export const COMPOSIO_API_KEY = getEnv('COMPOSIO_API_KEY', '');
export const COMPOSIO_USER_ID = getEnv('COMPOSIO_USER_ID', 'default');
