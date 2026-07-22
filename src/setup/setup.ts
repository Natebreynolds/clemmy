import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { input, password, select, confirm } from '@inquirer/prompts';
import { BASE_DIR, CODEX_AUTH_SOURCE_FILE, DEFAULT_MODELS, WEBHOOK_PORT } from '../config.js';
import {
  bootstrapCodexAuth,
  getAuthStatus,
  getCodexBootstrapAvailability,
  loginWithNativeOAuth,
} from '../runtime/auth-store.js';
import { fetchDiscordInstallInfo } from '../channels/discord-install.js';
import { initHome } from './init-home.js';
import { readEnvFile, writeEnvFile } from './env-file.js';
import { openBrowser } from '../cli/open-url.js';
import {
  BANNER, BOLD, CYAN, DIM, GREEN, ORANGE, RED, RESET, YELLOW,
  sectionHeader, ok, warn, fail, info,
} from '../cli/ui.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

  const envPath = path.join(BASE_DIR, '.env');
  const isFirstRun = !existsSync(envPath);

  if (isFirstRun) {
    console.log();
    info('First-run setup detected. This wizard will:');
    info('  1. Sign you in (Codex OAuth or OpenAI API key)');
    info('  2. Optionally enable Discord and open the bot install link for you');
    info('  3. Configure workspaces, connected apps, and write your .env');
    info(`Settings are saved to ${envPath}.`);
  } else {
    info(`This wizard will update ${envPath}.`);
  }
  console.log();

  await initHome();

  const existing = readEnvFile(envPath);

  // --- Auth ---
  sectionHeader('Step 1: Authentication');

  const codexAvailability = getCodexBootstrapAvailability();
  const defaultAuthMode = codexAvailability.available ? 'codex_oauth' : 'api_key';
  const existingAuthMode = existing.AUTH_MODE === 'codex_oauth' ? 'codex_oauth'
    : existing.AUTH_MODE === 'claude_oauth' ? 'claude_oauth'
    : existing.AUTH_MODE === 'api_key' ? 'api_key'
    : defaultAuthMode;

  const authMode = await select({
    message: 'How should Clementine connect to the AI?',
    default: existingAuthMode,
    choices: [
      { value: 'api_key', name: `api_key       Use direct OpenAI API billing for the agent runtime` },
      { value: 'codex_oauth', name: `codex_oauth   Use ChatGPT/Codex OAuth for the agent runtime` },
    ],
  });

  const values: Record<string, string> = {
    OPENAI_API_KEY: existing.OPENAI_API_KEY ?? '',
    AUTH_MODE: authMode,
    CODEX_AUTH_SOURCE_FILE: existing.CODEX_AUTH_SOURCE_FILE || CODEX_AUTH_SOURCE_FILE,
    // Seed from DEFAULT_MODELS (the single source of truth) so the wizard
    // never silently pins a new user to a stale model the rest of the app
    // has moved past.
    OPENAI_MODEL_PRIMARY: existing.OPENAI_MODEL_PRIMARY || DEFAULT_MODELS.primary,
    OPENAI_MODEL_FAST: existing.OPENAI_MODEL_FAST || DEFAULT_MODELS.fast,
    OPENAI_MODEL_DEEP: existing.OPENAI_MODEL_DEEP || DEFAULT_MODELS.deep,
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
    DISCORD_CLIENT_ID: existing.DISCORD_CLIENT_ID || '',
    DISCORD_REQUIRE_MENTION: existing.DISCORD_REQUIRE_MENTION || 'true',
    DISCORD_ALLOWED_CHANNELS: existing.DISCORD_ALLOWED_CHANNELS || '',
    DISCORD_DM_ALLOWED_USERS: existing.DISCORD_DM_ALLOWED_USERS || '',
    LOCAL_MCP_ENABLED: existing.LOCAL_MCP_ENABLED || 'true',
    MCP_AUTO_IMPORT_ENABLED: existing.MCP_AUTO_IMPORT_ENABLED || 'false',
    AUTONOMY_V2_AGENTS: existing.AUTONOMY_V2_AGENTS || 'clementine',
    AUTONOMY_ORCHESTRATOR_SLUGS: existing.AUTONOMY_ORCHESTRATOR_SLUGS || '',
    COMPOSIO_API_KEY: existing.COMPOSIO_API_KEY || '',
    // Leave blank by default. The Composio client preserves an explicit id,
    // detects ids exposed by the legacy API, or persists this device's stable
    // Clementine id for the current API shape. Migrate the old "default"
    // sentinel to blank so it can never become an execution route.
    COMPOSIO_USER_ID:
      existing.COMPOSIO_USER_ID && existing.COMPOSIO_USER_ID !== 'default'
        ? existing.COMPOSIO_USER_ID
        : '',
    WORKSPACE_DIRS: existing.WORKSPACE_DIRS || '',
  };

  let authConfigured = false;
  if (authMode === 'api_key') {
    const existingKey = values.OPENAI_API_KEY;
    if (existingKey) {
      info('An OpenAI API key is already set; press Enter to keep it.');
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const key = await password({
        message: existingKey
          ? 'OpenAI API key (sk-...) — leave blank to keep existing'
          : 'OpenAI API key (starts with sk-)',
        mask: '*',
      });
      if (key) values.OPENAI_API_KEY = key;
      if (!values.OPENAI_API_KEY) {
        fail('No API key entered', 'an API key is required for api_key auth mode');
        const retry = await confirm({ message: 'Try again?', default: true });
        if (!retry) break;
        continue;
      }
      if (!values.OPENAI_API_KEY.startsWith('sk-')) {
        warn('Key does not look like an OpenAI key', 'expected prefix sk-');
        const accept = await confirm({ message: 'Use it anyway?', default: false });
        if (!accept) {
          values.OPENAI_API_KEY = existingKey;
          continue;
        }
      }
      ok('API key saved');
      authConfigured = true;
      break;
    }
    if (!authConfigured) {
      warn('Auth not configured', `add OPENAI_API_KEY to ${path.join(BASE_DIR, '.env')} before running the daemon`);
    }
  } else {
    for (let attempt = 0; attempt < 3 && !authConfigured; attempt++) {
      const initialStatus = getAuthStatus();
      if (initialStatus.mode === 'codex_oauth' && initialStatus.codexOauthPresent) {
        ok('Codex OAuth already configured', initialStatus.codexAccountId ?? '');
        authConfigured = true;
        break;
      }
      const doOAuth = await confirm({
        message: attempt === 0
          ? 'Sign in with ChatGPT/Codex in your browser now?'
          : 'Try Codex OAuth sign-in again?',
        default: true,
      });
      if (!doOAuth) {
        info('Skipping. Run `clementine auth login` to authenticate later.');
        break;
      }
      console.log();
      info('Opening browser for Codex OAuth...');
      const result = await loginWithNativeOAuth(values.CODEX_AUTH_SOURCE_FILE);
      if (result.ok) {
        const after = getAuthStatus();
        if (after.codexOauthPresent) {
          ok('Signed in', result.message);
          authConfigured = true;
          break;
        }
        warn('Sign-in returned success but no token was found', 'will retry');
      } else {
        warn('Browser sign-in failed', result.message);
      }
      const tryBootstrap = await confirm({ message: 'Try Codex CLI bootstrap as fallback?', default: true });
      if (tryBootstrap) {
        const bootstrapResult = await bootstrapCodexAuth(values.CODEX_AUTH_SOURCE_FILE);
        if (bootstrapResult.ok && getAuthStatus().codexOauthPresent) {
          ok('Codex CLI auth configured');
          authConfigured = true;
          break;
        }
        fail('Auth failed', bootstrapResult.message);
      }
    }
    if (!authConfigured) {
      warn('Codex auth not yet configured', 'run `clementine auth login` before starting the daemon');
    }
  }

  // --- Semantic memory ---
  sectionHeader('Step 2: Semantic Memory');
  info('Clementine always uses local SQLite/FTS memory. The OpenAI API key is optional and separate from Codex OAuth; it enables semantic embedding rerank/backfill and live voice.');
  const configureEmbeddings = await confirm({
    message: values.OPENAI_API_KEY
      ? 'OpenAI capability key is present. Update it for semantic memory/live voice?'
      : 'Add an optional OpenAI API key for semantic memory and live voice?',
    default: Boolean(values.OPENAI_API_KEY),
  });
  if (configureEmbeddings) {
    const key = await password({
      message: 'Optional OpenAI API key (starts with sk-, leave blank to keep existing)',
      mask: '*',
    });
    if (key) values.OPENAI_API_KEY = key;
    if (values.OPENAI_API_KEY) {
      ok('Semantic memory enabled', 'embeddings backfill can run from the dashboard or memory tools');
    } else {
      warn('Semantic memory skipped', 'FTS recall and durable facts still work');
    }
  } else if (!values.OPENAI_API_KEY) {
    info('Semantic memory skipped. FTS recall and durable facts still work without an API key.');
  }

  // --- Identity ---
  sectionHeader('Step 3: Identity');

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

  // --- Projects ---
  sectionHeader('Step 4: Projects');
  info('Workspace directories let Clementine discover projects and run approved shell commands in them.');
  const configureWorkspaces = await confirm({
    message: 'Configure project/workspace directories?',
    default: Boolean(values.WORKSPACE_DIRS),
  });
  if (configureWorkspaces) {
    const workspaceDirs = await input({
      message: 'Workspace directories, comma-separated',
      default: values.WORKSPACE_DIRS || path.join(os.homedir(), 'Desktop'),
    });
    values.WORKSPACE_DIRS = workspaceDirs || values.WORKSPACE_DIRS;
  }

  // --- Channels ---
  sectionHeader('Step 5: Channels');

  const useDiscord = await confirm({
    message: 'Enable Discord bot?',
    default: values.DISCORD_ENABLED === 'true',
  });
  values.DISCORD_ENABLED = useDiscord ? 'true' : 'false';

  if (useDiscord) {
    let installUrl: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const tokenPrompt = values.DISCORD_BOT_TOKEN && attempt === 0
        ? 'Discord bot token (leave blank to keep existing)'
        : 'Discord bot token';
      const token = await password({ message: tokenPrompt, mask: '*' });
      if (token) values.DISCORD_BOT_TOKEN = token;
      if (!values.DISCORD_BOT_TOKEN) {
        fail('No token entered', 'Discord requires a bot token to connect');
        const retry = await confirm({ message: 'Try again?', default: true });
        if (!retry) break;
        continue;
      }
      try {
        const installInfo = await fetchDiscordInstallInfo(values.DISCORD_BOT_TOKEN);
        if (installInfo) {
          values.DISCORD_CLIENT_ID = installInfo.clientId;
          installUrl = installInfo.installUrl;
          ok(
            'Discord bot verified',
            installInfo.appName ? `${installInfo.appName} (${installInfo.clientId})` : installInfo.clientId,
          );
          break;
        }
      } catch (error) {
        warn('Discord token check failed', error instanceof Error ? error.message : String(error));
        const retry = await confirm({ message: 'Try a different token?', default: true });
        if (!retry) break;
      }
    }

    if (values.DISCORD_BOT_TOKEN) {
      const ownerIdDefault = values.DISCORD_DM_ALLOWED_USERS.split(',')[0]?.trim() ?? '';
      const ownerId = await input({
        message: 'Your Discord user ID (right-click your name in Discord → Copy User ID)',
        default: ownerIdDefault,
        validate: (raw) => {
          const v = raw.trim();
          if (!v) return true;
          return /^\d{15,25}$/.test(v) || 'Discord user IDs are numeric (15–25 digits)';
        },
      });
      const trimmedOwner = ownerId.trim();
      if (trimmedOwner) {
        const existingIds = values.DISCORD_DM_ALLOWED_USERS
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);
        if (!existingIds.includes(trimmedOwner)) existingIds.unshift(trimmedOwner);
        values.DISCORD_DM_ALLOWED_USERS = existingIds.join(',');
        ok('Discord owner ID saved', trimmedOwner);
      } else {
        warn('Owner ID skipped', 'add DISCORD_DM_ALLOWED_USERS later to allow DM access');
      }

      if (installUrl) {
        console.log();
        info(`Bot install link: ${CYAN}${installUrl}${RESET}`);
        const doOpen = await confirm({
          message: 'Open the install link in your browser to add the bot to a server now?',
          default: true,
        });
        if (doOpen) {
          const opened = openBrowser(installUrl);
          if (opened) {
            ok('Opened install link in your browser', 'authorize the bot in the server of your choice');
          } else {
            warn('Could not open browser automatically', 'copy/paste the link above');
          }
          await confirm({
            message: 'Have you added the bot to your server? (press Enter to continue)',
            default: true,
          });
        } else {
          info('Skipped opening browser. Paste the link above when ready.');
        }
      } else {
        warn('Install link unavailable', 'no client ID was resolved — verify the token and re-run setup');
      }
    }
  }

  // --- Connected apps ---
  sectionHeader('Step 6: Connected Apps');
  const useComposio = await confirm({
    message: 'Configure Composio for connected app OAuth?',
    default: Boolean(values.COMPOSIO_API_KEY),
  });
  if (useComposio) {
    const composioKey = await password({
      message: 'Composio API key (optional, starts with cak_)',
      mask: '*',
    });
    if (composioKey) values.COMPOSIO_API_KEY = composioKey;
    const composioUserId = await input({
      message: 'Composio user ID (leave blank to use this device\'s stable Clementine ID)',
      default: values.COMPOSIO_USER_ID,
    });
    // Blank → legacy auto-detect or stable device id at runtime. Never
    // re-persist the "default" sentinel.
    const trimmedUserId = composioUserId.trim();
    values.COMPOSIO_USER_ID = trimmedUserId && trimmedUserId !== 'default' ? trimmedUserId : '';
    if (values.COMPOSIO_API_KEY) {
      ok('Composio configured', 'connect app toolkits from the dashboard');
    } else {
      warn('Composio skipped', 'you can paste an API key in the dashboard later');
    }
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
    info(`Console:   ${CYAN}http://127.0.0.1:${values.WEBHOOK_PORT}/console${RESET}`);
    info(`Start:     ${CYAN}clementine daemon start${RESET}`);
    info(`Chat:      ${CYAN}clementine chat${RESET}`);
  } else {
    console.log(`  ${RED}${BOLD}Setup finished with blocking issues.${RESET}`);
    info('Review the doctor output above. The most common fixes:');
    info(`  • Auth not configured  → ${CYAN}clementine auth login${RESET}`);
    info(`  • Missing values       → re-run ${CYAN}clementine setup${RESET}`);
    info(`  • Anything else        → ${CYAN}clementine doctor${RESET} for a fresh check`);
  }

  console.log();
  return doctorCode;
}
