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
  const child = spawn(process.execPath, [process.argv[1], 'daemon', '--foreground'], {
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

export function registerShutdownHandlers(onShutdown: () => Promise<void>): void {
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
