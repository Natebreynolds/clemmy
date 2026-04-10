import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { input, password, select, confirm } from '@inquirer/prompts';
import { BASE_DIR, CODEX_AUTH_SOURCE_FILE, WEBHOOK_PORT } from '../config.js';
import { bootstrapCodexAuth, getCodexBootstrapAvailability, loginWithNativeOAuth } from '../runtime/auth-store.js';
import { initHome } from './init-home.js';
import {
  BANNER, BOLD, CYAN, DIM, GREEN, ORANGE, RED, RESET, YELLOW,
  sectionHeader, ok, warn, fail, info,
} from '../cli/ui.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    result[trimmed.slice(0, eqIndex)] = trimmed.slice(eqIndex + 1);
  }
  return result;
}

function stringifyEnv(values: Record<string, string>): string {
  return Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  return parseEnv(readFileSync(filePath, 'utf-8'));
}

function writeEnvFile(filePath: string, values: Record<string, string>): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, stringifyEnv(values), 'utf-8');
}

async function runDoctorInFreshProcess(): Promise<number> {
  const doctorEntrypoint = path.join(__dirname, 'doctor.js');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [doctorEntrypoint], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export async function runSetupWizard(): Promise<number> {
  console.log(BANNER);
  console.log(`  ${BOLD}Welcome to Clementine setup.${RESET}`);
  info(`Home directory: ${BASE_DIR}`);
  info('This wizard will configure your agent and write ~/.clementine-next/.env');
  console.log();

  await initHome();

  const envPath = path.join(BASE_DIR, '.env');
  const existing = readEnvFile(envPath);

  // --- Auth ---
  sectionHeader('Step 1: Authentication');

  const codexAvailability = getCodexBootstrapAvailability();
  const defaultAuthMode = codexAvailability.available ? 'codex_oauth' : 'api_key';
  const existingAuthMode = existing.AUTH_MODE === 'codex_oauth' ? 'codex_oauth'
    : existing.AUTH_MODE === 'api_key' ? 'api_key'
    : defaultAuthMode;

  const authMode = await select({
    message: 'How should Clementine connect to the AI?',
    default: existingAuthMode,
    choices: [
      { value: 'api_key', name: `api_key       Use an OpenAI API key (recommended for background agent)` },
      { value: 'codex_oauth', name: `codex_oauth   Sign in with your ChatGPT account via Codex CLI` },
    ],
  });

  const values: Record<string, string> = {
    OPENAI_API_KEY: existing.OPENAI_API_KEY ?? '',
    AUTH_MODE: authMode,
    CODEX_AUTH_SOURCE_FILE: existing.CODEX_AUTH_SOURCE_FILE || CODEX_AUTH_SOURCE_FILE,
    OPENAI_MODEL_PRIMARY: existing.OPENAI_MODEL_PRIMARY || 'gpt-4.1',
    OPENAI_MODEL_FAST: existing.OPENAI_MODEL_FAST || 'gpt-4.1-mini',
    OPENAI_MODEL_DEEP: existing.OPENAI_MODEL_DEEP || 'gpt-4.1',
    CLEMENTINE_HOME: existing.CLEMENTINE_HOME || BASE_DIR,
    ASSISTANT_NAME: existing.ASSISTANT_NAME || 'Clementine',
    OWNER_NAME: existing.OWNER_NAME || os.userInfo().username,
    WEBHOOK_ENABLED: existing.WEBHOOK_ENABLED || 'true',
    WEBHOOK_PORT: existing.WEBHOOK_PORT || String(WEBHOOK_PORT),
    WEBHOOK_SECRET: existing.WEBHOOK_SECRET && existing.WEBHOOK_SECRET !== 'change-me'
      ? existing.WEBHOOK_SECRET
      : randomUUID().slice(0, 16),
    DISCORD_ENABLED: existing.DISCORD_ENABLED || 'false',
    DISCORD_BOT_TOKEN: existing.DISCORD_BOT_TOKEN || '',
    DISCORD_REQUIRE_MENTION: existing.DISCORD_REQUIRE_MENTION || 'true',
    DISCORD_ALLOWED_CHANNELS: existing.DISCORD_ALLOWED_CHANNELS || '',
    LOCAL_MCP_ENABLED: existing.LOCAL_MCP_ENABLED || 'true',
  };

  if (authMode === 'api_key') {
    const key = await password({
      message: 'OpenAI API key (starts with sk-)',
      mask: '*',
    });
    if (key) values.OPENAI_API_KEY = key;
    if (!values.OPENAI_API_KEY) {
      warn('No API key entered', 'you can add OPENAI_API_KEY to ~/.clementine-next/.env later');
    } else {
      ok('API key saved');
    }
  } else {
    const doOAuth = await confirm({
      message: 'Sign in with ChatGPT/Codex in your browser now?',
      default: true,
    });
    if (doOAuth) {
      console.log();
      info('Opening browser for Codex OAuth...');
      const result = await loginWithNativeOAuth(values.CODEX_AUTH_SOURCE_FILE);
      if (result.ok) {
        ok('Signed in', result.message);
      } else {
        warn('Browser sign-in failed', result.message);
        const tryBootstrap = await confirm({ message: 'Try Codex CLI bootstrap as fallback?', default: true });
        if (tryBootstrap) {
          const bootstrapResult = await bootstrapCodexAuth(values.CODEX_AUTH_SOURCE_FILE);
          if (bootstrapResult.ok) {
            ok('Codex CLI auth configured');
          } else {
            fail('Auth failed', bootstrapResult.message);
            info('Run `clementine auth login` later to complete setup.');
          }
        }
      }
    } else {
      info('Skipping. Run `clementine auth login` to authenticate later.');
    }
  }

  // --- Identity ---
  sectionHeader('Step 2: Identity');

  const ownerName = await input({
    message: 'Your name (used to personalize responses)',
    default: values.OWNER_NAME,
  });
  values.OWNER_NAME = ownerName || values.OWNER_NAME;

  const assistantName = await input({
    message: 'Assistant name',
    default: values.ASSISTANT_NAME,
  });
  values.ASSISTANT_NAME = assistantName || values.ASSISTANT_NAME;

  // --- Channels ---
  sectionHeader('Step 3: Channels');

  const useDiscord = await confirm({
    message: 'Enable Discord bot?',
    default: values.DISCORD_ENABLED === 'true',
  });
  values.DISCORD_ENABLED = useDiscord ? 'true' : 'false';

  if (useDiscord) {
    const token = await password({
      message: 'Discord bot token',
      mask: '*',
    });
    if (token) values.DISCORD_BOT_TOKEN = token;
  }

  // --- Write config ---
  sectionHeader('Saving configuration');

  writeEnvFile(envPath, values);
  ok('.env written', envPath);

  console.log();
  const doctorCode = await runDoctorInFreshProcess();
  console.log();

  if (doctorCode === 0) {
    console.log(`  ${GREEN}${BOLD}All set!${RESET}`);
    console.log();
    info(`Dashboard: ${CYAN}http://localhost:${values.WEBHOOK_PORT}/dashboard?token=${encodeURIComponent(values.WEBHOOK_SECRET)}${RESET}`);
    info(`Start:     ${CYAN}clementine daemon start${RESET}`);
    info(`Chat:      ${CYAN}clementine chat${RESET}`);
  }

  console.log();
  return doctorCode;
}
