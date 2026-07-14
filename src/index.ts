#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import pino from 'pino';
import { ASSISTANT_NAME, BASE_DIR, DISCORD_ENABLED, SLACK_ENABLED, WEBHOOK_ENABLED } from './config.js';
import { ClementineAssistant } from './assistant/core.js';
import { startDiscordBot } from './channels/discord.js';
import { startSlackBot } from './channels/slack.js';
import { SLACK_APP_MANIFEST_YAML } from './channels/slack-manifest.js';
import { startWebhookServer } from './channels/webhook.js';
import { startChatCli } from './cli/chat.js';
import { startSupervisorIpcHeartbeat } from './daemon/phase.js';
import { startDaemon } from './daemon/runner.js';
import {
  clearDaemonPid,
  DAEMON_LOG_FILE,
  generateLaunchdPlist,
  generateSystemdUnit,
  getDaemonStatus,
  isDaemonRunning,
  LOG_DIR,
  readDaemonPid,
  registerShutdownHandlers,
  spawnDaemonProcess,
  stopDaemon,
  writeDaemonPid,
} from './daemon/process.js';
import { bootstrapCodexAuth, clearImportedAuth, formatAuthStatus, importCodexCliAuth, loginWithNativeOAuth, loginWithCodexDeviceCode, refreshStoredNativeOAuth } from './runtime/auth-store.js';
import { createRuntimeFromConfig } from './runtime/factory.js';
import { warmMarkitdownInBackground } from './runtime/markitdown.js';
import { runDoctor } from './setup/doctor.js';
import { initHome } from './setup/init-home.js';
import { runSetupWizard } from './setup/setup.js';
import { PLUGINS_DIR } from './plugins/loader.js';
import { getConfiguredDiscordInstallInfo } from './channels/discord-install.js';
import { readMemoryIndexStatus, rebuildVaultIndex } from './memory/indexer.js';
import { collectHarnessAudit } from './dashboard/harness-audit.js';
import {
  prepareLocalTranscriptionRuntime,
  shutdownLocalTranscriptionRuntime,
} from './integrations/local-meetings/whisper-runtime.js';

const logger = pino({ name: 'clementine-next' });

function printUsage(): void {
  console.log(`
Clementine — lightweight background agent system

Usage: clementine <command> [options]

Core
  chat                Start interactive CLI chat
  service             Start all services (daemon + webhook + discord)

Daemon (background agent)
  daemon start        Start daemon in the background
  daemon stop         Stop the background daemon
  daemon restart      Restart the background daemon
  daemon status       Show daemon status
  daemon logs         Tail daemon log file
  daemon install      Generate launchd (macOS) or systemd (Linux) service file
  daemon --foreground Run daemon in foreground (internal use)

Auth
  auth status         Show auth configuration
  auth login          Sign in with ChatGPT/Codex (browser if a TTY, else device code)
  auth login-native   OAuth browser sign-in (local machine)
  auth login-device   OAuth device-code sign-in (remote / headless — any device)
  auth refresh        Refresh stored OAuth token
  auth import-codex   Import a token from the Codex CLI (legacy; couples to a CLI logout)
  auth logout         Clear stored auth

Plugins
  plugin install <dir|.clemplug|url|pkg>  Install a plugin cartridge (or legacy npm pkg)
  plugin list               List installed plugins
  plugin enable|disable <id>  Eject/re-seat a cartridge without deleting it
  plugin uninstall <id>     Remove a cartridge and everything it brought

Memory
  memory status       Show SQLite vault index and fact counts
  memory reindex      Rebuild the SQLite vault index

Mobile (PWA companion)
  mobile status                    Show PIN + sessions + tunnel summary
  mobile set-pin                   Set / rotate the mobile login PIN
  mobile sessions                  List active mobile sessions
  mobile revoke-all                Invalidate every active mobile session
  mobile tunnel detect             Locate cloudflared + record version
  mobile tunnel install            brew install cloudflared (macOS)
  mobile tunnel login              Open browser to authorize cloudflared
  mobile tunnel list               List tunnels on the connected CF account
  mobile tunnel create <name>      Create a named tunnel
  mobile tunnel route <tn> <host>  Point hostname at a tunnel
  mobile tunnel start              Run the configured tunnel (foreground)
  mobile tunnel info               Show saved mobile-access state

Harness (0.3, local smoke test)
  harness run "<prompt>"     Run one turn through the Orchestrator + loop
  harness events <session>   Pretty-print the event log for a session
  harness-audit [--json]     Score tools, workflows, approvals, agents, learning

Setup
  setup               Interactive setup wizard
  doctor              Run diagnostics
  init-home           Initialize home directory structure

Individual services
  webhook             Start HTTP webhook server only
  discord             Start Discord bot only
  discord invite      Print the Discord bot install link

Options
  --help, -h          Show this help
`.trim());
}

// --- Daemon commands ---

async function cmdDaemonStart(): Promise<number> {
  if (isDaemonRunning()) {
    const pid = readDaemonPid();
    console.log(`Daemon is already running (PID ${pid}).`);
    return 0;
  }
  try {
    const pid = spawnDaemonProcess();
    // Give it a moment to write its own PID file before we exit
    await new Promise((resolve) => setTimeout(resolve, 300));
    console.log(`Daemon started (PID ${pid}).`);
    console.log(`Logs: ${DAEMON_LOG_FILE}`);
    return 0;
  } catch (err) {
    console.error('Failed to start daemon:', err instanceof Error ? err.message : err);
    return 1;
  }
}

function cmdDaemonStop(): number {
  const { stopped, pid } = stopDaemon();
  if (stopped) {
    console.log(`Daemon stopped (PID ${pid}).`);
    return 0;
  }
  if (pid) {
    console.log(`Daemon process (PID ${pid}) was not running — cleaned up stale PID file.`);
    return 0;
  }
  console.log('Daemon is not running.');
  return 0;
}

async function cmdDaemonRestart(): Promise<number> {
  const { stopped, pid } = stopDaemon();
  if (stopped) {
    console.log(`Stopped daemon (PID ${pid}).`);
  }
  // Brief pause to let the process exit cleanly
  await new Promise((resolve) => setTimeout(resolve, 800));
  return cmdDaemonStart();
}

function cmdDaemonStatus(): number {
  const { running, pid, logFile } = getDaemonStatus();
  if (running) {
    console.log(`Daemon is running (PID ${pid}).`);
  } else {
    console.log('Daemon is not running.');
  }
  console.log(`Log file: ${logFile}`);
  return running ? 0 : 1;
}

function cmdDaemonLogs(): number {
  if (!existsSync(DAEMON_LOG_FILE)) {
    console.log(`No log file found at ${DAEMON_LOG_FILE}`);
    console.log('Start the daemon first: clementine daemon start');
    return 1;
  }
  // Print last 100 lines then follow
  try {
    const result = spawnSync('tail', ['-n', '100', '-f', DAEMON_LOG_FILE], { stdio: 'inherit' });
    return result.status ?? 0;
  } catch {
    // Fallback: just print the file
    const content = readFileSync(DAEMON_LOG_FILE, 'utf-8');
    const lines = content.split('\n');
    console.log(lines.slice(-100).join('\n'));
    return 0;
  }
}

function cmdDaemonInstall(): number {
  const platform = process.platform;
  // Try to find the clementine bin
  let clementineBin = process.argv[1];
  try {
    clementineBin = execSync('which clementine', { encoding: 'utf-8' }).trim() || process.argv[1];
  } catch {
    // use process.argv[1]
  }

  if (platform === 'darwin') {
    const plistContent = generateLaunchdPlist(clementineBin);
    const plistPath = path.join(process.env.HOME ?? '~', 'Library', 'LaunchAgents', 'com.clementine.daemon.plist');
    console.log('macOS launchd service file:\n');
    console.log(plistContent);
    console.log('\nTo install:');
    console.log(`  mkdir -p ~/Library/LaunchAgents`);
    console.log(`  # Save the above to: ${plistPath}`);
    console.log(`  launchctl load ${plistPath}`);
    console.log(`  launchctl start com.clementine.daemon`);
  } else {
    const unitContent = generateSystemdUnit(clementineBin);
    const unitPath = path.join(process.env.HOME ?? '~', '.config', 'systemd', 'user', 'clementine.service');
    console.log('systemd user service file:\n');
    console.log(unitContent);
    console.log('\nTo install:');
    console.log(`  mkdir -p ~/.config/systemd/user`);
    console.log(`  # Save the above to: ${unitPath}`);
    console.log('  systemctl --user daemon-reload');
    console.log('  systemctl --user enable --now clementine');
    console.log('  journalctl --user -fu clementine  # to view logs');
  }
  return 0;
}

// --- Plugin commands ---

function cmdPluginList(): number {
  if (!existsSync(PLUGINS_DIR)) {
    console.log('No plugins installed.');
    console.log(`Plugin directory: ${PLUGINS_DIR}`);
    return 0;
  }
  const entries = readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'));

  if (entries.length === 0) {
    console.log('No plugins installed.');
  } else {
    console.log(`Installed plugins (${PLUGINS_DIR}):\n`);
    for (const entry of entries) {
      const pkgPath = path.join(PLUGINS_DIR, entry.name, 'package.json');
      let version = '';
      let description = '';
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string; description?: string };
          version = pkg.version ? `@${pkg.version}` : '';
          description = pkg.description ? ` — ${pkg.description}` : '';
        } catch { /* ignore */ }
      }
      console.log(`  ${entry.name}${version}${description}`);
    }
  }
  console.log(`\nPlugin directory: ${PLUGINS_DIR}`);
  console.log('Restart the daemon or MCP server to pick up changes.');
  return 0;
}

function cmdPluginInstall(target: string): number {
  if (!target) {
    console.error('Usage: clementine plugin install <directory|npm-package>');
    return 1;
  }

  mkdirSync(PLUGINS_DIR, { recursive: true });

  // If it's a local directory, copy it
  if (existsSync(target)) {
    const resolved = path.resolve(target);
    const name = path.basename(resolved);
    const destDir = path.join(PLUGINS_DIR, name);
    console.log(`Installing plugin from ${resolved} → ${destDir}`);
    const result = spawnSync('cp', ['-r', resolved, destDir], { stdio: 'inherit' });
    if (result.status !== 0) {
      console.error('Failed to copy plugin directory.');
      return 1;
    }
    console.log(`Plugin "${name}" installed. Restart daemon or MCP server to activate.`);
    return 0;
  }

  // Otherwise treat as npm package name
  console.log(`Installing npm package "${target}" into plugins directory...`);
  const result = spawnSync('npm', ['install', target, '--prefix', PLUGINS_DIR], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error('npm install failed.');
    return 1;
  }

  // Move from node_modules to plugins root if it's a single package
  const packageName = target.startsWith('@') ? target.split('/').slice(-1)[0] : target.split('/')[0];
  console.log(`\nPlugin "${packageName}" installed. Restart daemon or MCP server to activate.`);
  return 0;
}

function cmdMemoryStatus(): number {
  const status = readMemoryIndexStatus();
  console.log('Memory index');
  console.log(`  DB: ${status.dbPath}`);
  console.log(`  Present: ${status.dbPresent ? 'yes' : 'no'}`);
  console.log(`  Size: ${status.dbBytes} bytes`);
  console.log(`  Indexed files: ${status.indexedFiles}`);
  console.log(`  Chunks: ${status.chunks}`);
  console.log(`  Facts: ${status.activeFacts} active / ${status.totalFacts} total`);
  console.log(`  Embeddings: ${status.embeddingsEnabled ? 'enabled' : 'disabled'}`);
  console.log(`  Embedding vectors: ${status.embeddingsCount}`);
  console.log(`  Embedding coverage: ${Math.round(status.embeddingsCoverage * 100)}%`);
  if (status.embeddingsModel) {
    console.log(`  Embedding model: ${status.embeddingsModel} (${status.embeddingsDim ?? '-'} dimensions)`);
  }
  if (status.lastIndexedSourceMtime) {
    console.log(`  Latest source mtime: ${new Date(status.lastIndexedSourceMtime).toISOString()}`);
  }
  if (status.error) {
    console.log(`  Error: ${status.error}`);
    return 1;
  }
  return 0;
}

function cmdMemoryReindex(): number {
  try {
    const stats = rebuildVaultIndex();
    console.log(`Rebuilt memory index: ${stats.inserted} chunks from ${stats.scanned} files.`);
    console.log(`Changed: ${stats.changed}; skipped: ${stats.skipped}; removed: ${stats.removed}; errors: ${stats.errors}; duration: ${stats.durationMs}ms`);
    return stats.errors > 0 ? 1 : 0;
  } catch (error) {
    console.error('Failed to rebuild memory index:', error instanceof Error ? error.message : error);
    return 1;
  }
}

function cmdHarnessAudit(): number {
  const audit = collectHarnessAudit();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(audit, null, 2));
    return audit.summary.fail > 0 ? 1 : 0;
  }
  console.log(`Harness audit: ${audit.score}/100 (${audit.summary.pass} pass, ${audit.summary.warn} warn, ${audit.summary.fail} fail)`);
  for (const section of audit.sections) {
    console.log(`\n[${section.score}/100] ${section.title}`);
    const actionable = section.checks.filter((item) => item.status !== 'pass');
    if (actionable.length === 0) {
      console.log('  PASS all checks');
      continue;
    }
    for (const item of actionable) {
      console.log(`  ${item.status.toUpperCase()} ${item.title}: ${item.detail}`);
    }
  }
  return audit.summary.fail > 0 ? 1 : 0;
}

async function main(): Promise<void> {
  startSupervisorIpcHeartbeat();

  // NOTE: an earlier attempt called process.chdir(os.homedir()) here to
  // dodge a `shell-init: getcwd` warning. That broke previously-working
  // shell commands — calling chdir on the daemon process apparently
  // perturbs macOS's sandbox association and makes child Node CLIs
  // throw EPERM on uv_cwd. The bundle cwd was working before; leave it
  // alone. The getcwd warning is harmless noise; bash still runs the
  // command and the binary still gets a usable cwd from spawn's
  // `cwd:` argument.

  const command = process.argv[2] ?? 'help';

  if (command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  // --- Setup commands (no auth needed) ---
  if (command === 'setup') {
    process.exitCode = await runSetupWizard();
    return;
  }
  if (command === 'doctor') {
    process.exitCode = await runDoctor();
    return;
  }
  if (command === 'harness-audit') {
    process.exitCode = cmdHarnessAudit();
    return;
  }
  if (command === 'init-home') {
    await initHome();
    return;
  }

  if (command === 'discord') {
    const subcommand = process.argv[3] ?? '';
    if (subcommand === 'invite') {
      const installInfo = getConfiguredDiscordInstallInfo();
      if (!installInfo) {
        console.error('No Discord install link is configured.');
        console.error('Run `clementine setup` with a valid Discord bot token or set DISCORD_CLIENT_ID in your .env.');
        process.exitCode = 1;
        return;
      }
      console.log(installInfo.installUrl);
      return;
    }
  }

  if (command === 'slack') {
    const subcommand = process.argv[3] ?? '';
    if (subcommand === 'scopes' || subcommand === 'manifest') {
      console.log(SLACK_APP_MANIFEST_YAML);
      console.log('\nCreate the app: https://api.slack.com/apps?new_app=1 → "From a manifest" → paste the above.');
      console.log('Then: Install to Workspace → copy the Bot token (xoxb-) and App-level token (xapp-, scope connections:write)');
      console.log('into the Clementine dashboard (Connect → Slack), and /invite @Clementine to any channel you want it in.');
      return;
    }
  }

  // --- Auth ---
  if (command === 'auth') {
    const subcommand = process.argv[3] ?? 'status';
    if (subcommand === 'status') { console.log(formatAuthStatus()); return; }
    if (subcommand === 'login') {
      const result = await bootstrapCodexAuth();
      console.log(result.message);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    if (subcommand === 'login-native') {
      const result = await loginWithNativeOAuth();
      console.log(result.message);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    if (subcommand === 'login-device') {
      // Remote / headless sign-in: no local browser or loopback callback needed.
      const result = await loginWithCodexDeviceCode(({ userCode, verificationUri }) => {
        console.log('\nTo sign in to ChatGPT/Codex from any device:');
        console.log(`  1. Open: ${verificationUri}`);
        console.log(`  2. Enter the code: ${userCode}\n`);
        console.log('Waiting for sign-in… (Ctrl+C to cancel)');
      });
      console.log(result.message);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    if (subcommand === 'refresh') {
      const result = await refreshStoredNativeOAuth();
      console.log(result.message);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    if (subcommand === 'import-codex') {
      const result = importCodexCliAuth();
      console.log(result.message);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    if (subcommand === 'logout') {
      clearImportedAuth();
      console.log('Cleared stored auth.');
      return;
    }
    console.log('Usage: clementine auth <status|login|login-native|login-device|refresh|import-codex|logout>');
    process.exitCode = 1;
    return;
  }

  // --- Daemon commands ---
  if (command === 'daemon') {
    const sub = process.argv[3] ?? 'help';

    // Internal foreground mode — spawned by `daemon start`
    if (sub === '--foreground') {
      writeDaemonPid(process.pid);
      registerShutdownHandlers(async () => {
        logger.info('Daemon shutting down...');
        await shutdownLocalTranscriptionRuntime();
      });
      await prepareLocalTranscriptionRuntime();
      logger.info({ pid: process.pid }, 'Daemon starting in foreground mode');
      const assistant = new ClementineAssistant(createRuntimeFromConfig());
      if (WEBHOOK_ENABLED) await startWebhookServer(assistant);
      if (DISCORD_ENABLED) await startDiscordBot(assistant);
      if (SLACK_ENABLED) await startSlackBot(assistant);
      await startDaemon(assistant);
      return;
    }

    if (sub === 'start') { process.exitCode = await cmdDaemonStart(); return; }
    if (sub === 'stop') { process.exitCode = cmdDaemonStop(); return; }
    if (sub === 'restart') { process.exitCode = await cmdDaemonRestart(); return; }
    if (sub === 'status') { process.exitCode = cmdDaemonStatus(); return; }
    if (sub === 'logs') { process.exitCode = cmdDaemonLogs(); return; }
    if (sub === 'install') { process.exitCode = cmdDaemonInstall(); return; }

    // Legacy: `clementine daemon` with no sub → start in foreground (backward compat)
    if (sub === 'help' || sub === undefined) {
      console.log('Usage: clementine daemon <start|stop|restart|status|logs|install>');
      console.log('       clementine daemon start   — start daemon in background');
      console.log('       clementine daemon status  — check if running');
      return;
    }

    // Anything else: treat as legacy foreground (old behavior)
    writeDaemonPid(process.pid);
    registerShutdownHandlers(async () => {
      await shutdownLocalTranscriptionRuntime();
    });
    await prepareLocalTranscriptionRuntime();
    const assistant = new ClementineAssistant(createRuntimeFromConfig());
    await startDaemon(assistant);
    return;
  }

  // --- Plugin commands ---
  if (command === 'plugin') {
    const sub = process.argv[3] ?? 'list';
    const arg = process.argv[4] ?? '';
    const yes = process.argv.includes('--yes') || process.argv.includes('-y');
    // Content cartridges (plugin.json bundles of skills/workflows/MCP servers)
    // are the primary plugin concept; the legacy JS tool-module install path is
    // kept for code plugins (no plugin.json).
    const { resolvePluginSource, previewPlugin, installPlugin, listPlugins, setPluginEnabled, uninstallPlugin } = await import('./plugins/plugin-store.js');
    if (sub === 'list') {
      const cartridges = listPlugins();
      if (cartridges.length) {
        console.log('Installed plugins:');
        for (const c of cartridges) {
          const counts = c.artifacts.reduce<Record<string, number>>((acc, a) => { acc[a.kind] = (acc[a.kind] ?? 0) + 1; return acc; }, {});
          const parts = Object.entries(counts).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ');
          console.log(`  ${c.enabled ? '●' : '○'} ${c.manifest.name} v${c.manifest.version} (${c.manifest.id}) — ${parts}${c.enabled ? '' : ' [disabled]'}`);
        }
        console.log('');
      }
      process.exitCode = cmdPluginList(); // legacy code plugins + dir pointer
      return;
    }
    if (sub === 'install' && arg) {
      // A URL downloads to a temp archive, then flows through the same
      // consent path as a local source.
      let downloaded: { file: string; cleanup: () => void } | null = null;
      let source = arg;
      if (/^https?:\/\//i.test(arg)) {
        const { downloadPluginArchive } = await import('./plugins/plugin-fetch.js');
        try {
          downloaded = await downloadPluginArchive(arg);
          source = downloaded.file;
        } catch (err) {
          console.error(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
          return;
        }
      }
      // A source with plugin.json is a cartridge; anything else = legacy path.
      let resolved: { dir: string; cleanup: () => void } | null = null;
      try { resolved = resolvePluginSource(source); } catch { /* not a dir/tarball → legacy npm path below */ }
      if (resolved && existsSync(path.join(resolved.dir, 'plugin.json'))) {
        try {
          const preview = previewPlugin(resolved.dir);
          console.log(preview.consent.join('\n'));
          for (const w of preview.warnings) console.log(`  ! ${w}`);
          if (!yes) {
            console.log('\nRe-run with --yes to consent and install.');
            return;
          }
          const installed = await installPlugin(resolved.dir);
          const memoryNote = installed.memory ? ` — ${installed.memory.newFacts} memory fact${installed.memory.newFacts === 1 ? '' : 's'} imported${installed.memory.deduped ? ` (${installed.memory.deduped} already known)` : ''}` : '';
          console.log(`\nInstalled ${installed.manifest.id} v${installed.manifest.version} (${installed.artifacts.length} artifact${installed.artifacts.length === 1 ? '' : 's'})${memoryNote}.`);
        } catch (err) {
          console.error(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        } finally {
          resolved.cleanup();
          downloaded?.cleanup();
        }
        return;
      }
      resolved?.cleanup();
      downloaded?.cleanup();
      process.exitCode = cmdPluginInstall(arg);
      return;
    }
    if ((sub === 'enable' || sub === 'disable') && arg) {
      try {
        const plugin = setPluginEnabled(arg, sub === 'enable');
        console.log(`${plugin.manifest.id} ${plugin.enabled ? 'enabled' : 'disabled'}.`);
      } catch (err) { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; }
      return;
    }
    if (sub === 'uninstall' && arg) {
      try {
        const { removed } = uninstallPlugin(arg);
        console.log(`Uninstalled ${arg} (${removed.length} artifact${removed.length === 1 ? '' : 's'} removed).`);
      } catch (err) { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; }
      return;
    }
    console.log('Usage: clementine plugin <list | install <dir|.clemplug|url|npm-package> [--yes] | enable <id> | disable <id> | uninstall <id>>');
    return;
  }

  if (command === 'memory') {
    const sub = process.argv[3] ?? 'status';
    if (sub === 'status') { process.exitCode = cmdMemoryStatus(); return; }
    if (sub === 'reindex' || sub === 'rebuild-index') { process.exitCode = cmdMemoryReindex(); return; }
    console.log('Usage: clementine memory <status|reindex>');
    process.exitCode = 1;
    return;
  }

  if (command === 'mobile') {
    const { runMobileCli } = await import('./cli/mobile.js');
    process.exitCode = await runMobileCli(process.argv.slice(3));
    return;
  }

  if (command === 'harness') {
    const { runHarnessCli } = await import('./cli/harness.js');
    process.exitCode = await runHarnessCli(process.argv.slice(3));
    return;
  }

  // --- Service commands (need assistant) ---
  const assistant = new ClementineAssistant(createRuntimeFromConfig());

  if (command === 'chat') {
    await startChatCli();
    return;
  }
  if (command === 'webhook') {
    await startWebhookServer(assistant);
    return;
  }
  if (command === 'discord') {
    await startDiscordBot(assistant);
    await new Promise(() => undefined);
    return;
  }
  if (command === 'slack') {
    await startSlackBot(assistant);
    await new Promise(() => undefined);
    return;
  }
  if (command === 'service') {
    // Idempotent home scaffold — creates SOUL.md / MEMORY.md / cron
    // jobs / working-memory / example workflow if they don't already
    // exist. The desktop wizard writes credentials + profile but
    // never ran this, so fresh-install users were booting with an
    // empty vault. `ensureFile` is a no-op when files exist, so this
    // is safe to call on every daemon start.
    try {
      await initHome();
    } catch (err) {
      logger.warn({ err }, 'initHome failed during service boot — continuing with whatever scaffold exists');
    }
    if (WEBHOOK_ENABLED) {
      await startWebhookServer(assistant);
    } else {
      logger.info('Skipping webhook (WEBHOOK_ENABLED=false)');
    }
    if (DISCORD_ENABLED) {
      await startDiscordBot(assistant);
    } else {
      logger.info('Skipping Discord bot (DISCORD_ENABLED=false)');
    }
    if (SLACK_ENABLED) {
      await startSlackBot(assistant);
    } else {
      logger.info('Skipping Slack bot (SLACK_ENABLED=false)');
    }
    writeDaemonPid(process.pid);
    registerShutdownHandlers(async () => {
      await shutdownLocalTranscriptionRuntime();
      clearDaemonPid();
    });
    await prepareLocalTranscriptionRuntime();
    // Warm the markitdown runtime in the background so a user's FIRST file
    // conversion doesn't eat a ~½GB download under the per-conversion timeout.
    // Fire-and-forget, idempotent, never blocks the daemon loop.
    warmMarkitdownInBackground();
    await startDaemon(assistant);
    return;
  }

  // Default: brief intro
  console.log(`${ASSISTANT_NAME} is ready. Run \`clementine --help\` to see available commands.`);
  console.log(`Quick start: clementine setup → clementine daemon start → clementine chat`);
}

main().catch((err) => {
  logger.error({ err }, 'Startup failed');
  process.exit(1);
});
