import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ACTIVE_ENV_FILES, ASSISTANT_NAME, AUTH_MODE, BASE_DIR,
  DISCORD_BOT_TOKEN, DISCORD_ENABLED, LOCAL_MCP_ENABLED,
  OPENAI_API_KEY, WEBHOOK_ENABLED, WEBHOOK_SECRET,
} from '../config.js';
import { CRON_FILE, SOUL_FILE, VAULT_DIR, WORKFLOWS_DIR, WORKING_MEMORY_FILE } from '../memory/vault.js';
import { getAuthStatus } from '../runtime/auth-store.js';
import {
  BOLD, CYAN, DIM, GREEN, ORANGE, RED, RESET, YELLOW,
  passRow, warnRow, failRow,
} from '../cli/ui.js';

export async function runDoctor(): Promise<number> {
  const envPath = path.join(BASE_DIR, '.env');
  const problems: string[] = [];

  console.log();
  console.log(`  ${ORANGE}${BOLD}Clementine Doctor${RESET}`);
  console.log(`  ${DIM}Assistant: ${ASSISTANT_NAME}  •  Home: ${BASE_DIR}  •  Auth: ${AUTH_MODE}${RESET}`);
  if (ACTIVE_ENV_FILES.length > 0) {
    console.log(`  ${DIM}Env: ${ACTIVE_ENV_FILES.join(', ')}${RESET}`);
  }
  console.log();

  // Auth
  const authStatus = getAuthStatus();
  if (authStatus.mode === 'codex_oauth') {
    if (authStatus.configured) {
      warnRow('AUTH_MODE', authStatus.message);
    } else if (authStatus.source === 'codex_cli') {
      warnRow('AUTH_MODE', `${authStatus.message} Run: clementine auth login`);
    } else {
      failRow('AUTH_MODE', authStatus.message);
      problems.push('AUTH_MODE');
    }
  }

  // Env file
  if (ACTIVE_ENV_FILES.length > 0) {
    passRow('.env', ACTIVE_ENV_FILES.join(', '));
  } else {
    warnRow('.env', `Missing ${envPath} — run: clementine setup`);
  }

  // API key
  if (OPENAI_API_KEY) {
    passRow('OPENAI_API_KEY', 'Configured');
  } else if (AUTH_MODE === 'api_key') {
    failRow('OPENAI_API_KEY', 'Missing — chat, daemon, and workflows will not work');
    problems.push('OPENAI_API_KEY');
  } else {
    warnRow('OPENAI_API_KEY', 'Missing, but AUTH_MODE is not api_key');
  }

  // Webhook
  if (WEBHOOK_ENABLED) {
    if (WEBHOOK_SECRET && WEBHOOK_SECRET !== 'change-me' && WEBHOOK_SECRET !== 'change-me-local-secret') {
      passRow('WEBHOOK_SECRET', 'Dashboard auth configured');
    } else {
      warnRow('WEBHOOK_SECRET', 'Using default placeholder — change it in .env');
    }
  } else {
    warnRow('WEBHOOK_ENABLED', 'Webhook/dashboard is disabled');
  }

  // Discord
  if (DISCORD_ENABLED) {
    if (DISCORD_BOT_TOKEN) {
      passRow('DISCORD_BOT_TOKEN', 'Configured');
    } else {
      failRow('DISCORD_BOT_TOKEN', 'DISCORD_ENABLED=true but token is missing');
      problems.push('DISCORD_BOT_TOKEN');
    }
  } else {
    warnRow('DISCORD_ENABLED', 'Discord bot is disabled');
  }

  // MCP
  if (LOCAL_MCP_ENABLED) {
    passRow('LOCAL_MCP_ENABLED', 'Enabled');
  } else {
    warnRow('LOCAL_MCP_ENABLED', 'Disabled — local tool surface will be reduced');
  }

  // File system checks
  const fsChecks: [string, string][] = [
    ['vault', VAULT_DIR],
    ['soul', SOUL_FILE],
    ['working-memory', WORKING_MEMORY_FILE],
    ['cron', CRON_FILE],
    ['workflows', WORKFLOWS_DIR],
  ];
  for (const [label, target] of fsChecks) {
    if (existsSync(target)) {
      passRow(label, target.replace(BASE_DIR, '~/.clementine-next'));
    } else {
      warnRow(label, `Missing — run: clementine init-home`);
    }
  }

  // Cron jobs configured
  if (existsSync(CRON_FILE)) {
    const cronContent = readFileSync(CRON_FILE, 'utf-8');
    if (cronContent.includes('jobs: []')) {
      warnRow('cron jobs', 'No cron jobs configured yet');
    } else {
      passRow('cron jobs', 'Configured');
    }
  }

  console.log();
  if (problems.length > 0) {
    console.log(`  ${RED}${BOLD}${problems.length} blocking issue(s):${RESET} ${problems.join(', ')}`);
    console.log();
    return 1;
  }

  console.log(`  ${GREEN}${BOLD}All checks passed.${RESET}`);
  console.log(`  ${DIM}Run: ${CYAN}clementine daemon start${DIM} then ${CYAN}clementine chat${RESET}`);
  console.log();
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('setup', 'doctor.ts'))) {
  runDoctor().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
