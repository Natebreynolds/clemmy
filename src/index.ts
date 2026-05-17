#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import pino from 'pino';
import { ASSISTANT_NAME, BASE_DIR, DISCORD_ENABLED, WEBHOOK_ENABLED } from './config.js';
import { ClementineAssistant } from './assistant/core.js';
import { startDiscordBot } from './channels/discord.js';
import { startWebhookServer } from './channels/webhook.js';
import { startChatCli } from './cli/chat.js';
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
import { bootstrapCodexAuth, clearImportedAuth, formatAuthStatus, importCodexCliAuth, loginWithNativeOAuth, refreshStoredNativeOAuth } from './runtime/auth-store.js';
import { createRuntimeFromConfig } from './runtime/factory.js';
import { runDoctor } from './setup/doctor.js';
import { initHome } from './setup/init-home.js';
import { runSetupWizard } from './setup/setup.js';
import { PLUGINS_DIR } from './plugins/loader.js';
import { getConfiguredDiscordInstallInfo } from './channels/discord-install.js';
import { readMemoryIndexStatus, rebuildVaultIndex } from './memory/indexer.js';

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
  auth login          Bootstrap Codex CLI auth
  auth login-native   OAuth browser sign-in
  auth refresh        Refresh stored OAuth token
  auth import-codex   Import token from Codex CLI
  auth logout         Clear stored auth

Plugins
  plugin install <dir|pkg>  Install a plugin (copies dir or npm-installs pkg)
  plugin list               List installed plugins

Memory
  memory status       Show SQLite vault index and fact counts
  memory reindex      Rebuild the SQLite vault index

Harness (0.3, local smoke test)
  harness run "<prompt>"     Run one turn through the Orchestrator + loop
  harness events <session>   Pretty-print the event log for a session

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

async function main(): Promise<void> {
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
    console.log('Usage: clementine auth <status|login|login-native|refresh|import-codex|logout>');
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
      });
      logger.info({ pid: process.pid }, 'Daemon starting in foreground mode');
      const assistant = new ClementineAssistant(createRuntimeFromConfig());
      if (WEBHOOK_ENABLED) await startWebhookServer(assistant);
      if (DISCORD_ENABLED) await startDiscordBot(assistant);
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
    registerShutdownHandlers(async () => { /* cleanup */ });
    const assistant = new ClementineAssistant(createRuntimeFromConfig());
    await startDaemon(assistant);
    return;
  }

  // --- Plugin commands ---
  if (command === 'plugin') {
    const sub = process.argv[3] ?? 'list';
    if (sub === 'list') { process.exitCode = cmdPluginList(); return; }
    if (sub === 'install') {
      const target = process.argv[4] ?? '';
      process.exitCode = cmdPluginInstall(target);
      return;
    }
    console.log('Usage: clementine plugin <list|install <path-or-package>>');
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
  if (command === 'service') {
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
    writeDaemonPid(process.pid);
    registerShutdownHandlers(async () => { clearDaemonPid(); });
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
