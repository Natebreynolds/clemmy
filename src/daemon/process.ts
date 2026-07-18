import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

export const PID_FILE = path.join(BASE_DIR, 'daemon.pid');
export const DAEMON_LEASE_DIR = path.join(BASE_DIR, 'daemon.lock');
export const LOG_DIR = path.join(BASE_DIR, 'logs');
export const DAEMON_LOG_FILE = path.join(LOG_DIR, 'daemon.log');

export function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

interface DaemonLeaseOwner {
  version: 1;
  pid: number;
  token: string;
  startedAt: string;
  file: string;
}

interface DaemonLeaseDirectoryGeneration {
  dev: bigint;
  ino: bigint;
}

const EMPTY_DAEMON_LEASE_RECLAIM_MS = 5_000;

let afterDaemonLeaseDirectoryCreatedForTest: (() => void) | undefined;

/** Narrow synchronous seam for deterministic cross-process lease tests. */
export const daemonProcessInternalsForTest = {
  setAfterLeaseDirectoryCreatedHook(hook?: () => void): void {
    afterDaemonLeaseDirectoryCreatedForTest = hook;
  },
};

function readLegacyPidProjection(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function readDaemonLeaseOwner(): DaemonLeaseOwner | null {
  if (!existsSync(DAEMON_LEASE_DIR)) return null;
  let entries: string[];
  try {
    entries = readdirSync(DAEMON_LEASE_DIR).filter((entry) => /^owner-[a-f0-9-]+\.json$/.test(entry));
  } catch {
    return null;
  }
  if (entries.length !== 1) return null;
  const file = path.join(DAEMON_LEASE_DIR, entries[0]);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<DaemonLeaseOwner>;
    if (
      parsed.version !== 1
      || !Number.isSafeInteger(parsed.pid)
      || (parsed.pid ?? 0) <= 0
      || typeof parsed.token !== 'string'
      || !parsed.token
      || entries[0] !== `owner-${parsed.token}.json`
      || typeof parsed.startedAt !== 'string'
      || !Number.isFinite(Date.parse(parsed.startedAt))
    ) return null;
    return { ...parsed, file } as DaemonLeaseOwner;
  } catch {
    return null;
  }
}

export function readDaemonPid(): number | null {
  if (existsSync(DAEMON_LEASE_DIR)) return readDaemonLeaseOwner()?.pid ?? null;
  return readLegacyPidProjection();
}

export function isDaemonRunning(): boolean {
  const pid = readDaemonPid();
  if (!pid) return false;
  return processIsAlive(pid);
}

function syncDaemonDirectory(): void {
  if (process.platform === 'win32') return;
  const fd = openSync(path.dirname(PID_FILE), 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function readDaemonLeaseDirectoryGeneration(): DaemonLeaseDirectoryGeneration | null {
  try {
    const stat = statSync(DAEMON_LEASE_DIR, { bigint: true });
    if (!stat.isDirectory()) return null;
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function sameDaemonLeaseDirectoryGeneration(
  expected: DaemonLeaseDirectoryGeneration,
  actual: DaemonLeaseDirectoryGeneration | null,
): boolean {
  return actual !== null && expected.dev === actual.dev && expected.ino === actual.ino;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM still proves a process owns the pid; only ESRCH proves absence.
    // This answers "does the pid exist"; a lease-takeover decision needs a
    // stricter "is this pid our daemon" — see pidBlocksLeaseAcquisition.
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

/** Whether `pid` may be THIS installation's live daemon — the only thing allowed
 *  to block a lease takeover. Our daemon always runs as the current user, so a
 *  pid we cannot signal (EPERM — another user, typically a root process that
 *  reused the pid across a reboot) is provably not ours and must not block.
 *  Unlike processIsAlive, EPERM here means "stale", not "alive". */
function pidBlocksLeaseAcquisition(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ESRCH: gone. EPERM: owned by another user, so never our daemon. Both are
    // stale and takeable. Any other errno is unexpected — keep blocking rather
    // than risk evicting a genuinely live owner.
    return code !== 'ESRCH' && code !== 'EPERM';
  }
}

/** Argv signature of the real daemon: it always runs its entrypoint with a
 *  daemon/service subcommand (a `/daemon/` resource path or the `daemon` verb)
 *  or the `--foreground` flag. Deliberately excludes the bare app-bundle name,
 *  which every packaged Electron helper shares. */
const DAEMON_ARGV_RE = /--foreground\b|\bdaemon\b/i;

/** Best-effort command line for `pid`, or null when it cannot be read. */
function readProcessCommandLine(pid: number): string | null {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf-8',
      timeout: 2_000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Whether a live same-user `pid` looks like a real Clementine daemon — the only
 *  thing allowed to block a lease takeover once ESRCH (gone) and EPERM (foreign
 *  user) are ruled out. Both the legacy bare-pid file and a persisted
 *  current-format lease record a pid that may have been REUSED by an unrelated
 *  same-user process across a reboot or after an unclean daemon exit; a reused
 *  pid must never block the real daemon from starting.
 *
 *  The signature must NOT include the bare app-bundle name: every process the
 *  packaged Electron app spawns (main, GPU/renderer/network helpers, the recall
 *  SDK) has "/Applications/Clementine.app/…" in its argv, so matching
 *  "clementine" let ANY of the app's OWN helpers that reused the pid block the
 *  daemon forever — a non-deterministic, per-machine hard boot brick that
 *  presents as the app flickering (8 supervisor restarts) then a dead daemon.
 *  Only the real daemon carries a `/daemon/` resource path or a `--foreground`
 *  flag; the helpers carry neither, so this stays specific without the bundle
 *  name (2026-07-17: brick matched to a live report). An unreadable command line
 *  falls back to conservative blocking. Residual risk: a same-user pid reused by
 *  a process whose argv coincidentally carries a daemon signature still blocks —
 *  rare, and it only costs a manual daemon.pid/daemon.lock delete, never a
 *  wrong-owner eviction (a genuine live daemon always matches, so this can never
 *  evict a real one → no split-brain). */
function livePidLooksLikeDaemon(pid: number): boolean {
  if (!pidBlocksLeaseAcquisition(pid)) return false;
  const command = readProcessCommandLine(pid);
  if (command === null) return true;
  return DAEMON_ARGV_RE.test(command);
}

/** Positive confirmation that a live `pid` is NOT our daemon — a legacy/lease
 *  pid reused by an unrelated same-user process. True ONLY when the command line
 *  is readable AND lacks a daemon signature. An unreadable command line (e.g.
 *  Windows, where `ps` is absent) returns false so callers fall back to their
 *  prior behavior rather than refuse to act. Used by the STOP and START paths so
 *  `daemon stop`/`restart` never SIGTERMs an innocent reused pid, and `daemon
 *  start` is not fooled into "already running" by one (2026-07-17). */
export function daemonPidIsForeignReuse(pid: number): boolean {
  if (!pidBlocksLeaseAcquisition(pid)) return false; // dead/foreign-user: cannot be (or be killed as) our daemon
  const command = readProcessCommandLine(pid);
  return command !== null && !DAEMON_ARGV_RE.test(command);
}

function writePidProjection(pid: number): void {
  const temp = `${PID_FILE}.${pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, `${pid}\n`, 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, PID_FILE);
    syncDaemonDirectory();
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(temp); } catch { /* best effort */ }
  }
}

/** Atomically acquire the one-daemon lease. The directory mkdir is the CAS;
 * token-scoped owner filenames prevent stale reclaimers from deleting a newer
 * owner, while dev/inode verification binds publication to the exact directory
 * generation created by this claimant. */
export function acquireDaemonLease(pid = process.pid): boolean {
  mkdirSync(path.dirname(PID_FILE), { recursive: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!existsSync(DAEMON_LEASE_DIR)) {
      const legacyOwner = readLegacyPidProjection();
      if (legacyOwner && legacyOwner !== pid && livePidLooksLikeDaemon(legacyOwner)) return false;
      if (legacyOwner) {
        try { unlinkSync(PID_FILE); } catch { /* another claimant may have cleaned it */ }
      }
    }
    const token = randomUUID();
    const temp = path.join(BASE_DIR, `.daemon-owner-${token}.tmp`);
    const ownerFile = path.join(DAEMON_LEASE_DIR, `owner-${token}.json`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, pid, token, startedAt: new Date().toISOString() }), 'utf-8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      let claimedGeneration: DaemonLeaseDirectoryGeneration | null = null;
      try {
        mkdirSync(DAEMON_LEASE_DIR, { mode: 0o700 });
        claimedGeneration = readDaemonLeaseDirectoryGeneration();
        if (!claimedGeneration) continue;
        afterDaemonLeaseDirectoryCreatedForTest?.();
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
        let entries: string[];
        try {
          entries = readdirSync(DAEMON_LEASE_DIR).filter((entry) => /^owner-.*\.json$/.test(entry));
        } catch (readErr) {
          if ((readErr as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
          throw readErr;
        }
        if (entries.length === 0) {
          // A freshly-created empty directory is an owner being installed, not
          // stale state. Reaping it immediately lets its suspended creator later
          // publish into a replacement directory and grants two claimants the
          // same fixed path. Age-gate cleanup; generation verification below is
          // the backstop when a creator is paused longer than this grace window.
          let ageMs = 0;
          try { ageMs = Date.now() - statSync(DAEMON_LEASE_DIR).mtimeMs; } catch { continue; }
          if (ageMs < EMPTY_DAEMON_LEASE_RECLAIM_MS) return false;
          try { rmdirSync(DAEMON_LEASE_DIR); } catch { /* creator may have published its owner */ }
          continue;
        }
        if (entries.length !== 1) return false;
        const owner = readDaemonLeaseOwner();
        if (!owner) return false;
        if (owner.pid === pid) return true;
        // A current-format lease carries owner metadata but still cannot prove
        // the pid was not reused; the EPERM rule evicts a foreign-user reuse,
        // and same-user pid reuse remains the documented residual risk. This
        // stays a plain liveness check (NOT the daemon-shape heuristic used for
        // the legacy path): during a concurrent start the live competitor's argv
        // may not yet be daemon-shaped, and evicting it would grant two owners.
        // The correct pid-reuse disambiguator here is process-start-time vs the
        // lease startedAt — a follow-up, tracked 2026-07-17.
        if (pidBlocksLeaseAcquisition(owner.pid)) return false;
        try {
          unlinkSync(owner.file);
        } catch {
          // A different stale reclaimer already advanced the generation.
          continue;
        }
        try { rmdirSync(DAEMON_LEASE_DIR); } catch { /* a new generation now owns it */ }
        syncDaemonDirectory();
        continue;
      }
      try {
        renameSync(temp, ownerFile);
      } catch (publishErr) {
        // A stale reclaimer may have removed the pathname generation after
        // observing an older owner. Losing the path is a failed claim, not a
        // daemon-start crash; retry from a fresh mkdir generation.
        if ((publishErr as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        throw publishErr;
      }
      if (!claimedGeneration || !sameDaemonLeaseDirectoryGeneration(
        claimedGeneration,
        readDaemonLeaseDirectoryGeneration(),
      )) {
        // The fixed path was removed/recreated between mkdir and publication.
        // Remove only this claimant's token from the replacement generation;
        // never remove that generation or any other owner's file.
        try { unlinkSync(ownerFile); } catch { /* the replacement owner may already have cleaned it */ }
        try {
          if (process.platform !== 'win32') {
            const leaseFd = openSync(DAEMON_LEASE_DIR, 'r');
            try { fsyncSync(leaseFd); } finally { closeSync(leaseFd); }
          }
          syncDaemonDirectory();
        } catch { /* cleanup durability is best-effort; ownership is still refused */ }
        continue;
      }
      if (process.platform !== 'win32') {
        const leaseFd = openSync(DAEMON_LEASE_DIR, 'r');
        try { fsyncSync(leaseFd); } finally { closeSync(leaseFd); }
      }
      syncDaemonDirectory();
      writePidProjection(pid);
      return true;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best effort */ }
      }
      try { unlinkSync(temp); } catch { /* best effort */ }
    }
  }
  return false;
}

/** Release only the caller's lease. An old daemon finishing shutdown can never
 * erase a newer owner's pid file. Omit expectedPid only for stale cleanup. */
export function clearDaemonPid(expectedPid?: number): boolean {
  const lease = readDaemonLeaseOwner();
  const owner = lease?.pid ?? readLegacyPidProjection();
  if (expectedPid !== undefined && owner !== expectedPid) return false;
  let removed = false;
  if (lease) {
    try {
      unlinkSync(lease.file);
      rmdirSync(DAEMON_LEASE_DIR);
      removed = true;
      syncDaemonDirectory();
    } catch {
      return false;
    }
  } else if (existsSync(DAEMON_LEASE_DIR)) {
    return false;
  }
  try {
    unlinkSync(PID_FILE);
    syncDaemonDirectory();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return removed;
    throw err;
  }
}

/** Backward-compatible name for callers that used to overwrite daemon.pid. */
export function writeDaemonPid(pid: number): void {
  if (!acquireDaemonLease(pid)) {
    throw new Error(`Another Clementine daemon already owns the singleton lease (PID ${readDaemonPid() ?? 'unknown'}).`);
  }
}

export function stopDaemon(): { stopped: boolean; pid: number | null } {
  const pid = readDaemonPid();
  if (!pid) return { stopped: false, pid: null };
  const wasRunning = isDaemonRunning();
  if (!wasRunning) {
    clearDaemonPid(pid);
    return { stopped: false, pid };
  }
  // Never SIGTERM a pid we can POSITIVELY identify as an unrelated same-user
  // process that reused a stale legacy/lease pid. Killing it would take down an
  // innocent process on `daemon stop`/`restart`; clear the stale record instead.
  if (daemonPidIsForeignReuse(pid)) {
    clearDaemonPid(pid);
    return { stopped: false, pid };
  }
  try {
    process.kill(pid, 'SIGTERM');
    return { stopped: true, pid };
  } catch {
    return { stopped: false, pid };
  }
}

export async function waitForDaemonExit(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (processIsAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
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
        // Leave the lease record in place until the process is actually dead.
        // A successor atomically reclaims that stale owner only after signal 0
        // proves the old PID is gone, eliminating release-before-exit overlap.
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
