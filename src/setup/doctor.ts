import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ACTIVE_ENV_FILES, ASSISTANT_NAME, AUTH_MODE, BASE_DIR,
  COMPOSIO_API_KEY,
  DISCORD_BOT_TOKEN, DISCORD_DM_ALLOWED_USERS, DISCORD_ENABLED, LOCAL_MCP_ENABLED,
  WEBHOOK_ENABLED, WEBHOOK_SECRET, getOpenAiApiKey, getRuntimeEnv,
} from '../config.js';
import { CRON_FILE, SOUL_FILE, VAULT_DIR, WORKFLOWS_DIR, WORKING_MEMORY_FILE } from '../memory/vault.js';
import { readMemoryIndexStatus } from '../memory/indexer.js';
import { getAuthStatus } from '../runtime/auth-store.js';
import { getConfiguredDiscordInstallInfo } from '../channels/discord-install.js';
import { getWorkspaceDirs, listWorkspaceProjects } from '../tools/shared.js';
import { listGlobalCliStatus } from './capability-status.js';
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
      passRow('AUTH_MODE', authStatus.message);
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
  if (getOpenAiApiKey()) {
    passRow('OPENAI_API_KEY', 'Configured for embeddings, live voice, and direct API features');
  } else if (AUTH_MODE === 'api_key') {
    failRow('OPENAI_API_KEY', 'Missing — chat, daemon, and workflows will not work');
    problems.push('OPENAI_API_KEY');
  } else {
    warnRow('OPENAI_API_KEY', 'Optional capability key missing — Codex OAuth runtime can still run; embeddings and live voice stay disabled');
  }

  const workspaceDirs = getWorkspaceDirs();
  const workspaceProjects = listWorkspaceProjects();
  if (workspaceDirs.length > 0) {
    passRow('workspaces', `${workspaceDirs.length} roots; ${workspaceProjects.length} projects detected`);
  } else {
    warnRow('workspaces', 'No workspace roots configured or auto-detected — add WORKSPACE_DIRS in setup/dashboard');
  }

  const cliStatus = listGlobalCliStatus();
  const availableClis = cliStatus.filter((item) => item.available);
  passRow('global CLIs', `${availableClis.length}/${cliStatus.length} available (${availableClis.map((item) => item.command).join(', ') || 'none'})`);

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
      const installInfo = getConfiguredDiscordInstallInfo();
      if (installInfo) {
        passRow('DISCORD_INSTALL_URL', installInfo.installUrl);
      } else {
        warnRow('DISCORD_INSTALL_URL', 'Missing DISCORD_CLIENT_ID — rerun setup with a valid bot token');
      }
      if (DISCORD_DM_ALLOWED_USERS.length > 0) {
        passRow('DISCORD_DM_ALLOWED_USERS', `${DISCORD_DM_ALLOWED_USERS.length} user(s) authorized for DMs`);
      } else {
        warnRow('DISCORD_DM_ALLOWED_USERS', 'No owner user ID set — DMs to the bot will be ignored. Run: clementine setup');
      }
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

  const v2Agents = getRuntimeEnv('AUTONOMY_V2_AGENTS', '')
    .split(',')
    .map((slug) => slug.trim())
    .filter(Boolean);
  if (v2Agents.includes('clementine')) {
    passRow('AUTONOMY_V2_AGENTS', v2Agents.join(', '));
    if (!getOpenAiApiKey()) {
      warnRow('AUTONOMY_V2_RUNTIME', 'OpenAI Agents SDK autonomy needs OPENAI_API_KEY; Codex OAuth chat still works');
    }
  } else {
    warnRow('AUTONOMY_V2_AGENTS', 'clementine is not on the OpenAI Agents SDK v2 loop');
  }

  // Connected apps
  if (COMPOSIO_API_KEY) {
    passRow('COMPOSIO_API_KEY', 'Configured for connected app OAuth');
  } else {
    warnRow('COMPOSIO_API_KEY', 'Not configured — add it in the dashboard to connect Gmail, Slack, Notion, GitHub, and more');
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
      passRow(label, target);
    } else {
      warnRow(label, `Missing — run: clementine init-home`);
    }
  }

  const memoryIndex = readMemoryIndexStatus();
  if (memoryIndex.error) {
    warnRow('memory index', memoryIndex.error);
  } else if (memoryIndex.chunks > 0) {
    passRow('memory index', `${memoryIndex.chunks} chunks from ${memoryIndex.indexedFiles} files; ${memoryIndex.activeFacts} active facts`);
    if (memoryIndex.embeddingsEnabled) {
      passRow('memory embeddings', `${memoryIndex.embeddingsCount} vectors; ${Math.round(memoryIndex.embeddingsCoverage * 100)}% coverage`);
    } else {
      warnRow('memory embeddings', 'Disabled — set OPENAI_API_KEY to enable semantic rerank/backfill; FTS recall still works');
    }
  } else {
    warnRow('memory index', 'Empty — it will build lazily on first memory search, or use the dashboard Rebuild Index action');
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
