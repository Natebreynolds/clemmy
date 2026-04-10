import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ACTIVE_ENV_FILES, ASSISTANT_NAME, AUTH_MODE, BASE_DIR, DISCORD_BOT_TOKEN, DISCORD_ENABLED, LOCAL_MCP_ENABLED, OPENAI_API_KEY, WEBHOOK_ENABLED, WEBHOOK_SECRET } from '../config.js';
import { CRON_FILE, SOUL_FILE, VAULT_DIR, WORKFLOWS_DIR, WORKING_MEMORY_FILE } from '../memory/vault.js';
import { getAuthStatus } from '../runtime/auth-store.js';

function pass(label: string, detail: string): void {
  console.log(`PASS  ${label}: ${detail}`);
}

function warn(label: string, detail: string): void {
  console.log(`WARN  ${label}: ${detail}`);
}

function fail(label: string, detail: string): void {
  console.log(`FAIL  ${label}: ${detail}`);
}

export async function runDoctor(): Promise<number> {
  const envPath = path.join(BASE_DIR, '.env');
  const problems: string[] = [];

  console.log('Clementine Doctor');
  console.log(`Assistant: ${ASSISTANT_NAME}`);
  console.log(`Home: ${BASE_DIR}`);
  console.log(`Auth mode: ${AUTH_MODE}`);
  console.log(`Env files: ${ACTIVE_ENV_FILES.length > 0 ? ACTIVE_ENV_FILES.join(', ') : '(none)'}`);
  console.log('');

  const authStatus = getAuthStatus();
  if (authStatus.mode === 'codex_oauth') {
    if (authStatus.configured) {
      warn('AUTH_MODE', authStatus.message);
    } else if (authStatus.source === 'codex_cli') {
      warn('AUTH_MODE', `${authStatus.message} Run: clementine auth login`);
    } else {
      fail('AUTH_MODE', authStatus.message);
      problems.push('AUTH_MODE');
    }
  }

  if (ACTIVE_ENV_FILES.length > 0) {
    pass('.env', ACTIVE_ENV_FILES.join(', '));
  } else {
    warn('.env', `Missing ${envPath}. Run clementine setup or npm run setup.`);
  }

  if (OPENAI_API_KEY) {
    pass('OPENAI_API_KEY', 'Configured');
  } else if (AUTH_MODE === 'api_key') {
    fail('OPENAI_API_KEY', 'Missing. Chat, daemon, workflows, and Discord responses will not work.');
    problems.push('OPENAI_API_KEY');
  } else {
    warn('OPENAI_API_KEY', 'Missing, but AUTH_MODE is not api_key.');
  }

  if (WEBHOOK_ENABLED) {
    if (WEBHOOK_SECRET && WEBHOOK_SECRET !== 'change-me-local-secret') {
      pass('WEBHOOK_SECRET', 'Configured for dashboard auth');
    } else {
      warn('WEBHOOK_SECRET', 'Using the default placeholder or missing secret. Dashboard auth is weak until you change it.');
    }
  } else {
    warn('WEBHOOK_ENABLED', 'Webhook/dashboard is disabled.');
  }

  if (DISCORD_ENABLED) {
    if (DISCORD_BOT_TOKEN) {
      pass('DISCORD_BOT_TOKEN', 'Configured');
    } else {
      fail('DISCORD_BOT_TOKEN', 'DISCORD_ENABLED=true but token is missing.');
      problems.push('DISCORD_BOT_TOKEN');
    }
  } else {
    warn('DISCORD_ENABLED', 'Discord bot is disabled.');
  }

  if (LOCAL_MCP_ENABLED) {
    pass('LOCAL_MCP_ENABLED', 'Enabled');
  } else {
    warn('LOCAL_MCP_ENABLED', 'Disabled. Local tool surface will be reduced.');
  }

  for (const [label, target] of [
    ['vault', VAULT_DIR],
    ['soul', SOUL_FILE],
    ['working-memory', WORKING_MEMORY_FILE],
    ['cron', CRON_FILE],
    ['workflows', WORKFLOWS_DIR],
  ] as const) {
    if (existsSync(target)) {
      pass(label, target);
    } else {
      warn(label, `Missing ${target}. Run npm run init-home.`);
    }
  }

  if (existsSync(CRON_FILE)) {
    const cronContent = readFileSync(CRON_FILE, 'utf-8');
    if (cronContent.includes('jobs: []')) {
      warn('cron jobs', 'No cron jobs configured yet.');
    } else {
      pass('cron jobs', 'Configured');
    }
  }

  console.log('');
  if (problems.length > 0) {
    console.log(`Doctor found blocking issues: ${problems.join(', ')}`);
    return 1;
  }

  console.log('Doctor found no blocking issues.');
  console.log('Suggested local run: clementine service');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('setup', 'doctor.ts'))) {
  runDoctor().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
