import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

export const PID_FILE = path.join(BASE_DIR, 'daemon.pid');
export const LOG_DIR = path.join(BASE_DIR, 'logs');
export const DAEMON_LOG_FILE = path.join(LOG_DIR, 'daemon.log');

export function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

export function readDaemonPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function isDaemonRunning(): boolean {
  const pid = readDaemonPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0); // Signal 0 just checks if process exists
    return true;
  } catch {
    return false; // ESRCH = no such process
  }
}

export function writeDaemonPid(pid: number): void {
  mkdirSync(path.dirname(PID_FILE), { recursive: true });
  writeFileSync(PID_FILE, String(pid), 'utf-8');
}

export function clearDaemonPid(): void {
  rmSync(PID_FILE, { force: true });
}

export function stopDaemon(): { stopped: boolean; pid: number | null } {
  const pid = readDaemonPid();
  if (!pid) return { stopped: false, pid: null };
  const wasRunning = isDaemonRunning();
  clearDaemonPid();
  if (!wasRunning) return { stopped: false, pid };
  try {
    process.kill(pid, 'SIGTERM');
    return { stopped: true, pid };
  } catch {
    return { stopped: false, pid };
  }
}

export function spawnDaemonProcess(): number {
  ensureLogDir();
  const logFd = openSync(DAEMON_LOG_FILE, 'a');
  const entrypoint = process.argv[1];
  const childArgs = entrypoint.endsWith('.ts')
    ? ['--import', 'tsx', entrypoint, 'daemon', '--foreground']
    : [entrypoint, 'daemon', '--foreground'];
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, CLEMENTINE_DAEMON: '1' },
  });
  child.unref();
  const pid = child.pid;
  if (!pid) throw new Error('Failed to spawn daemon process');
  return pid;
}

export function getDaemonStatus(): { running: boolean; pid: number | null; logFile: string } {
  const pid = readDaemonPid();
  const running = pid !== null && isDaemonRunning();
  return { running, pid: running ? pid : null, logFile: DAEMON_LOG_FILE };
}

// ── Last-resort crash guards (2026-07-08) ───────────────────────────────────
// The daemon died with exit 1 when a ws WebSocket (Slack socket-mode reconnect)
// emitted 'error' with no listener — "Opening handshake has timed out" became
// an uncaughtException and took EVERY channel down mid-conversation. A transport
// error on one reconnecting socket is never worth the whole daemon: the
// socket-mode client has its own reconnect loop and every other subsystem is
// healthy. Same for a leaked broken-pipe/reset event: the live v1.3.1 daemon
// printed "Unhandled 'error' event ... write EPIPE" during startup and got
// killed out from under an otherwise recoverable boot. Swallow exactly these
// transport classes (log + let the owner reconnect/close); any OTHER uncaught
// error still exits (state may be corrupt) — but now with a structured log line
// first, and the supervisor restarts us cleanly.
let crashGuardsRegistered = false;

/** A transport error escaping a socket/pipe owner's own event handling. These
 *  sockets (Slack socket-mode, Discord gateway, stdio/MCP streams) all have an
 *  owning component that can reconnect, close, or retry. The escaped 'error'
 *  event is a plumbing leak, not a daemon-fatal state. */
export function isSurvivableSocketError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const stack = err instanceof Error ? (err.stack ?? '') : '';
  const code = err && typeof err === 'object' && 'code' in err
    ? String((err as { code?: unknown }).code ?? '')
    : '';
  return code === 'EPIPE'
    || code === 'ECONNRESET'
    || /\b(?:EPIPE|ECONNRESET)\b/i.test(msg)
    || /opening handshake has timed out|websocket was closed before the connection was established/i.test(msg)
    || /node_modules[\\/]+ws[\\/]+lib[\\/]+websocket\.js/.test(stack);
}

export function registerCrashGuards(): void {
  if (crashGuardsRegistered) return;
  crashGuardsRegistered = true;
  process.on('uncaughtException', (err) => {
    if (isSurvivableSocketError(err)) {
      console.error('[daemon] survivable socket error (uncaughtException) — the connection will self-heal:', err instanceof Error ? err.message : err);
      return;
    }
    console.error('[daemon] FATAL uncaughtException — exiting:', err);
    try { clearDaemonPid(); } catch { /* best effort */ }
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    if (isSurvivableSocketError(reason)) {
      console.error('[daemon] survivable socket error (unhandledRejection) — the connection will self-heal:', reason instanceof Error ? reason.message : reason);
      return;
    }
    // Node's default is to crash on an unhandled rejection; keep that contract
    // (the supervisor restarts us) but log a structured line first.
    console.error('[daemon] FATAL unhandledRejection — exiting:', reason);
    try { clearDaemonPid(); } catch { /* best effort */ }
    process.exit(1);
  });
}

export function registerShutdownHandlers(onShutdown: () => Promise<void>): void {
  registerCrashGuards();
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[daemon] ${signal} received — shutting down...`);
    onShutdown()
      .catch((err: unknown) => console.error('[daemon] Shutdown error:', err))
      .finally(() => {
        clearDaemonPid();
        process.exit(0);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// --- Service file generators ---

export function generateLaunchdPlist(clementineBin: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>com.clementine.daemon</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${clementineBin}</string>`,
    '    <string>daemon</string>',
    '    <string>--foreground</string>',
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${DAEMON_LOG_FILE}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${DAEMON_LOG_FILE}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    `    <key>HOME</key>`,
    `    <string>${os.homedir()}</string>`,
    `    <key>CLEMENTINE_HOME</key>`,
    `    <string>${BASE_DIR}</string>`,
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function generateSystemdUnit(clementineBin: string): string {
  return [
    '[Unit]',
    'Description=Clementine Agent Daemon',
    'After=network.target',
    '',
    '[Service]',
    `ExecStart=${clementineBin} daemon --foreground`,
    'Restart=always',
    'RestartSec=10',
    `StandardOutput=append:${DAEMON_LOG_FILE}`,
    `StandardError=append:${DAEMON_LOG_FILE}`,
    `Environment=HOME=${os.homedir()}`,
    `Environment=CLEMENTINE_HOME=${BASE_DIR}`,
    `EnvironmentFile=-${BASE_DIR}/.env`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}
