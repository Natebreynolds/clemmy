import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { BASE_DIR, CODEX_AUTH_SOURCE_FILE, WEBHOOK_PORT } from '../config.js';
import { bootstrapCodexAuth, getCodexBootstrapAvailability, loginWithNativeOAuth } from '../runtime/auth-store.js';
import { initHome } from './init-home.js';

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
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
}

function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  return parseEnv(readFileSync(filePath, 'utf-8'));
}

function writeEnvFile(filePath: string, values: Record<string, string>): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, stringifyEnv(values), 'utf-8');
}

async function promptYesNo(rl: readline.Interface, question: string, defaultValue: boolean): Promise<boolean> {
  const suffix = defaultValue ? 'Y/n' : 'y/N';
  const answer = (await rl.question(`${question} [${suffix}] `)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return answer === 'y' || answer === 'yes';
}

async function promptText(rl: readline.Interface, question: string, defaultValue = ''): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || defaultValue;
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
  await initHome();

  const envPath = path.join(BASE_DIR, '.env');
  const existing = readEnvFile(envPath);
  const rl = readline.createInterface({ input, output });

  try {
    console.log('Clementine Setup');
    console.log(`Home: ${BASE_DIR}`);
    console.log(`Codex auth source: ${CODEX_AUTH_SOURCE_FILE}`);
    console.log('');

    const codexAvailability = getCodexBootstrapAvailability();
    const defaultAuthMode = codexAvailability.available ? 'codex_oauth' : 'api_key';
    const existingAuthMode = existing.AUTH_MODE === 'codex_oauth'
      ? 'codex_oauth'
      : existing.AUTH_MODE === 'api_key' && existing.OPENAI_API_KEY
        ? 'api_key'
        : defaultAuthMode;
    const authAnswer = (await promptText(rl, 'Auth mode [api_key|codex_oauth]', existingAuthMode)).toLowerCase();
    const authMode = authAnswer === 'codex_oauth' ? 'codex_oauth' : 'api_key';

    const values: Record<string, string> = {
      OPENAI_API_KEY: existing.OPENAI_API_KEY ?? '',
      AUTH_MODE: authMode,
      CODEX_AUTH_SOURCE_FILE: existing.CODEX_AUTH_SOURCE_FILE || CODEX_AUTH_SOURCE_FILE,
      OPENAI_MODEL_PRIMARY: existing.OPENAI_MODEL_PRIMARY || 'gpt-5.4',
      OPENAI_MODEL_FAST: existing.OPENAI_MODEL_FAST || 'gpt-5.4-mini',
      OPENAI_MODEL_DEEP: existing.OPENAI_MODEL_DEEP || 'gpt-5.4',
      CLEMENTINE_HOME: existing.CLEMENTINE_HOME || BASE_DIR,
      ASSISTANT_NAME: existing.ASSISTANT_NAME || 'Clementine',
      OWNER_NAME: existing.OWNER_NAME || os.userInfo().username,
      WEBHOOK_ENABLED: existing.WEBHOOK_ENABLED || 'true',
      WEBHOOK_PORT: existing.WEBHOOK_PORT || String(WEBHOOK_PORT),
      WEBHOOK_SECRET: existing.WEBHOOK_SECRET && existing.WEBHOOK_SECRET !== 'change-me-local-secret'
        ? existing.WEBHOOK_SECRET
        : randomUUID().slice(0, 16),
      DISCORD_ENABLED: existing.DISCORD_ENABLED || 'false',
      DISCORD_BOT_TOKEN: existing.DISCORD_BOT_TOKEN || '',
      DISCORD_REQUIRE_MENTION: existing.DISCORD_REQUIRE_MENTION || 'true',
      DISCORD_ALLOWED_CHANNELS: existing.DISCORD_ALLOWED_CHANNELS || '',
      LOCAL_MCP_ENABLED: existing.LOCAL_MCP_ENABLED || 'true',
    };

    if (authMode === 'api_key') {
      values.OPENAI_API_KEY = await promptText(rl, 'OpenAI API key', values.OPENAI_API_KEY);
    } else {
      const shouldBootstrap = await promptYesNo(rl, 'Use native ChatGPT/Codex sign-in in the browser', true);
      if (shouldBootstrap) {
        const result = await loginWithNativeOAuth(values.CODEX_AUTH_SOURCE_FILE);
        console.log(result.message);
        if (!result.ok) {
          const tryCodexBootstrap = await promptYesNo(rl, 'Try Codex CLI bootstrap as a fallback', true);
          if (tryCodexBootstrap) {
            const bootstrapResult = await bootstrapCodexAuth(values.CODEX_AUTH_SOURCE_FILE);
            console.log(bootstrapResult.message);
          } else {
            const fallbackToApiKey = await promptYesNo(rl, 'Fall back to API key auth for now', true);
            if (fallbackToApiKey) {
              values.AUTH_MODE = 'api_key';
              values.OPENAI_API_KEY = await promptText(rl, 'OpenAI API key', values.OPENAI_API_KEY);
            }
          }
        }
      } else {
        console.log('Skipping Codex bootstrap. You can run `clementine auth login` later.');
      }
    }

    const useDiscord = await promptYesNo(rl, 'Enable Discord bot', values.DISCORD_ENABLED === 'true');
    values.DISCORD_ENABLED = useDiscord ? 'true' : 'false';
    if (useDiscord) {
      values.DISCORD_BOT_TOKEN = await promptText(rl, 'Discord bot token', values.DISCORD_BOT_TOKEN);
    }

    writeEnvFile(envPath, values);
    console.log(`Wrote config to ${envPath}`);
    console.log('');
    const doctorCode = await runDoctorInFreshProcess();
    console.log('');
    console.log(`Dashboard URL: http://localhost:${values.WEBHOOK_PORT}/dashboard?token=${encodeURIComponent(values.WEBHOOK_SECRET)}`);
    console.log('Start command: clementine service');
    return doctorCode;
  } finally {
    rl.close();
  }
}
