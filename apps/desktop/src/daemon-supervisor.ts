import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer } from 'node:net';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import type { Readable } from 'node:stream';
import { extractShellPath } from './shell-path-extractor.js';
import { readCache as readShellPathCache, writeCache as writeShellPathCache, mergePaths } from './shell-path-cache.js';

/**
 * Daemon supervisor — owns the lifecycle of the local Clementine daemon
 * child process. Used by the Electron main process.
 *
 * Responsibilities:
 *   - Locate the daemon entry (dev mode vs packaged build).
 *   - Pick a free port for the dashboard (configurable; defaults to
 *     8520 with auto-fallback when occupied).
 *   - Spawn the daemon with the desired env, capture stdout+stderr to
 *     a log file the dashboard can read.
 *   - Probe the dashboard URL until it returns 200 → resolve a Ready
 *     promise so the main process can show the window.
 *   - Auto-restart on crash with exponential backoff (capped).
 *   - Clean shutdown on app quit (SIGTERM, then SIGKILL after 5s).
 *
 * Intentionally framework-free: works in dev (tsx) and in a packaged
 * Electron bundle (where the daemon is shipped as a precompiled
 * directory under app.getPath('exe')/../Resources/daemon).
 */

interface SupervisorOptions {
  /** Absolute path to the daemon's package.json — used to resolve
   *  the entry point + project root. In dev, this is the parent repo;
   *  in packaged mode, it's the extraResources path. */
  daemonProjectRoot: string;
  /** Override the webhook port. Default 8520 with auto-fallback. */
  preferredPort?: number;
  /** Log file path. Auto-created if missing. */
  logFile: string;
  /** Optional env overrides — merged on top of process.env. */
  envOverrides?: Record<string, string>;
  /** Optional logger so the Electron main can route events. */
  onEvent?: (event: SupervisorEvent) => void;
}

export type SupervisorEvent =
  | { type: 'starting'; port: number; attempt: number }
  | { type: 'running'; port: number; pid: number }
  | { type: 'ready'; port: number; url: string }
  | { type: 'log'; stream: 'stdout' | 'stderr'; line: string }
  | { type: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { type: 'restart-scheduled'; delayMs: number; attempt: number }
  | { type: 'restart-counter-reset'; reason: string; priorAttempts: number }
  | { type: 'restart-skipped'; reason: string };

const READINESS_TIMEOUT_MS = 30_000;
const READINESS_POLL_MS = 250;
const SHUTDOWN_GRACE_MS = 5_000;
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;
// After this much continuous stable uptime, treat any future crash as
// "fresh" (i.e. reset the restart counter to 0 before incrementing).
// Without this, 8 transient crashes spread over a month would
// permanently disable the supervisor — the counter never decayed even
// though each crash was independent. 5 minutes is short enough that a
// genuinely broken daemon (flapping start → crash → start → crash) still
// trips the cap quickly, but long enough that a "normal" upgrade or
// transient blip doesn't accumulate forever.
const STABILITY_RESET_MS = 5 * 60_000;
const WEBHOOK_HOST = '127.0.0.1';

/**
 * Parse a single .env file into a key/value map. Mirrors the parser in
 * src/config.ts so user-edited .env files behave identically whether
 * they're read by the daemon's own config module or by this supervisor
 * before spawn.
 *
 * Returns {} on missing file or parse failure — never throws (a broken
 * .env must not block daemon startup).
 */
function parseEnvFile(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {};
  const result: Record<string, string> = {};
  try {
    for (const rawLine of readFileSync(envPath, 'utf-8').split('\n')) {
      // Strip only leading whitespace + trailing \r so comment + trim
      // semantics match config.ts; preserve trailing spaces on values.
      const line = rawLine.replace(/^\s+|\r+$/g, '');
      if (!line || line.startsWith('#')) continue;
      const eqIndex = line.indexOf('=');
      if (eqIndex === -1) continue;
      const key = line.slice(0, eqIndex).trim();
      let value = line.slice(eqIndex + 1);
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  } catch {
    // Best-effort — corrupt .env shouldn't crash the supervisor.
  }
  return result;
}

/**
 * Collect .env files in the same precedence order src/config.ts uses
 * (later wins): package dir, current working dir, $CLEMENTINE_HOME or
 * ~/.clementine-next. Merging into the spawned daemon's process.env
 * was missing — the daemon's env-flag reads (HARNESS_TOOL_BRACKETS,
 * CLEMMY_TOOL_GUARDRAIL, CLEMMY_AUTO_COMPACT, etc.) hit `process.env`
 * directly, so values in the user's home .env were invisible. Setting
 * a flag in Settings → Runtime did nothing in production until this
 * supervisor merge.
 *
 * Note: shell exports inherited via Electron's process.env still win
 * over .env file values at spawn time (see the merge order in start()).
 * That matches config.ts's `process.env[key] ?? env[key] ?? fallback`
 * precedence so behavior is consistent across read paths.
 */
function loadDotenvBaseline(daemonProjectRoot: string): Record<string, string> {
  const home = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine-next');
  const candidates = [
    path.join(daemonProjectRoot, '.env'),
    path.join(process.cwd(), '.env'),
    path.join(home, '.env'),
  ].filter((p, i, all) => all.indexOf(p) === i);
  return Object.assign({}, ...candidates.map(parseEnvFile));
}

export class DaemonSupervisor {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private logStream: ReturnType<typeof createWriteStream> | null = null;
  private shuttingDown = false;
  private restartAttempts = 0;
  /** Wall-clock of the most recent successful readiness signal. Used
   *  by scheduleRestart() to detect "stable for long enough" → fresh
   *  crash, decay counter. */
  private lastReadyAt = 0;
  private chosenPort = 0;
  private readyPromise: Promise<{ port: number; url: string }> | null = null;
  private readyResolve: ((info: { port: number; url: string }) => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;

  constructor(private opts: SupervisorOptions) {
    if (!existsSync(opts.daemonProjectRoot)) {
      throw new Error(`Daemon project root does not exist: ${opts.daemonProjectRoot}`);
    }
    const logDir = path.dirname(opts.logFile);
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  }

  /** Start (or restart) the daemon. Resolves when the dashboard URL
   *  returns a 200, rejects after READINESS_TIMEOUT_MS. */
  async start(): Promise<{ port: number; url: string }> {
    if (this.child) {
      // Already running — return the existing ready promise.
      if (this.readyPromise) return this.readyPromise;
      throw new Error('Daemon already running but readiness promise lost');
    }

    this.shuttingDown = false;
    this.chosenPort = await pickFreePort(this.opts.preferredPort ?? 8520, WEBHOOK_HOST);

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.emit({ type: 'starting', port: this.chosenPort, attempt: this.restartAttempts });

    const { command, args, runAsNode } = this.resolveDaemonCommand();

    // GUI Mac apps launched by launchd get a bare PATH (/usr/bin:/bin
    // :/usr/sbin:/sbin) — no /usr/local/bin, no /opt/homebrew/bin. Every
    // user-installed CLI (sf, gh, composio, anything from Homebrew or
    // npm globals) is invisible to the daemon's `run_shell_command`
    // unless we augment PATH at spawn. Discovered 2026-05-21 when the
    // user's Salesforce work suddenly failed with "sf: command not
    // found" even though sf was on their shell PATH — the daemon's
    // PATH had no /usr/local/bin. Insurance: add common user-tool dirs
    // unconditionally. Idempotent — duplicates in PATH are harmless.
    const COMMON_USER_BIN_DIRS = [
      '/opt/homebrew/bin',     // Apple Silicon Homebrew
      '/opt/homebrew/sbin',
      '/usr/local/bin',        // Intel Mac Homebrew + npm globals
      '/usr/local/sbin',
      `${process.env.HOME ?? ''}/.cargo/bin`,    // Rust toolchain
      `${process.env.HOME ?? ''}/.local/bin`,    // pipx, generic user installs
      `${process.env.HOME ?? ''}/go/bin`,        // Go binaries
    ].filter((p) => p && !p.endsWith('/'));

    // v0.5.21 Phase 2.5 — merge in the user's shell PATH so version
    // managers (nvm, asdf, mise, volta, fnm, rbenv, pyenv, sdkman)
    // become visible. Without this, anything installed via
    // `npm install -g X` while on nvm is invisible to `local_cli_list`
    // (verified 2026-05-25: Higgsfield at ~/.nvm/.../bin/higgsfield
    // was missed). Cache-first: read instantly at boot; async-refresh
    // in background and write a new cache when it changes. Daemon
    // picks up the refreshed PATH at the next restart (no IPC).
    const cachedShellPath = readShellPathCache()?.path ?? null;
    const augmentedPath = mergePaths(
      COMMON_USER_BIN_DIRS.join(':'),
      cachedShellPath,
      process.env.PATH ?? '',
    );
    // Kick off the async re-extraction; logging only — never blocks.
    extractShellPath()
      .then((result) => {
        if (!result.path) {
          this.emit({
            type: 'log',
            stream: 'stderr',
            line: `[supervisor] shell-path extraction failed: ${result.failureReason ?? 'unknown'} (${result.durationMs}ms)`,
          });
          return;
        }
        const prior = readShellPathCache()?.path ?? null;
        if (prior === result.path) return; // unchanged → skip write
        try {
          writeShellPathCache(result.path);
          this.emit({
            type: 'log',
            stream: 'stdout',
            line: `[supervisor] shell-path cache updated via ${result.shell} (${result.durationMs}ms) — daemon will see new CLIs on next restart`,
          });
        } catch (err) {
          this.emit({
            type: 'log',
            stream: 'stderr',
            line: `[supervisor] shell-path cache write failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      })
      .catch((err) => {
        // Defensive — extractShellPath() returns a result envelope and
        // shouldn't reject, but a programming bug shouldn't crash the
        // supervisor either.
        this.emit({
          type: 'log',
          stream: 'stderr',
          line: `[supervisor] shell-path extraction threw: ${err instanceof Error ? err.message : String(err)}`,
        });
      });

    // Load .env files as a BASELINE before process.env. Order matters:
    // shell exports (in process.env) override .env file values, which
    // override nothing — but the daemon now actually SEES the .env
    // values. Without this baseline merge, flags like
    // HARNESS_TOOL_BRACKETS=on / CLEMMY_TOOL_GUARDRAIL=warn that the
    // user (or Settings UI) wrote to ~/.clementine-next/.env were
    // invisible to the daemon because the harness reads process.env
    // directly. Diagnosed 2026-05-24 when v0.5.18 brackets work was
    // silently inactive in production despite the flag being set.
    const dotenvBaseline = loadDotenvBaseline(this.opts.daemonProjectRoot);
    const env: NodeJS.ProcessEnv = {
      ...dotenvBaseline,
      ...process.env,
      ...this.opts.envOverrides,
      PATH: augmentedPath,
      WEBHOOK_ENABLED: 'true',
      WEBHOOK_PORT: String(this.chosenPort),
      WEBHOOK_HOST,
      // Forward Electron's process.resourcesPath so the daemon can
      // resolve native modules (keytar) bundled in app.asar.unpacked.
      // Without this, the daemon's node_modules walk doesn't see the
      // Electron-bundled keytar and the Keychain backend disables itself
      // with "keytar not available — install the desktop app to use Keychain"
      // even though the user IS on the desktop app.
      ...(typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === 'string'
        ? { CLEMENTINE_RESOURCES_PATH: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath as string }
        : {}),
    };
    // In a packaged Electron build, process.execPath is the Electron
    // executable itself. To run it as a plain Node.js, we set
    // ELECTRON_RUN_AS_NODE=1 — Electron honors this and skips the
    // browser bootstrap, behaving like a normal Node interpreter.
    if (runAsNode) {
      env.ELECTRON_RUN_AS_NODE = '1';
    }

    this.child = spawn(command, args, {
      cwd: this.opts.daemonProjectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.logStream = createWriteStream(this.opts.logFile, { flags: 'a' });
    this.logStream.write(`\n=== Daemon started ${new Date().toISOString()} on port ${this.chosenPort} ===\n`);

    this.child.stdout.on('data', (buf: Buffer) => {
      const line = buf.toString();
      this.logStream?.write(line);
      this.emit({ type: 'log', stream: 'stdout', line });
    });
    this.child.stderr.on('data', (buf: Buffer) => {
      const line = buf.toString();
      this.logStream?.write(line);
      this.emit({ type: 'log', stream: 'stderr', line });
    });

    this.child.on('exit', (code, signal) => {
      this.emit({ type: 'exit', code, signal });
      this.logStream?.write(`=== Daemon exited (code=${code}, signal=${signal}) at ${new Date().toISOString()} ===\n`);
      this.logStream?.end();
      this.logStream = null;
      this.child = null;
      if (this.shuttingDown) return;
      this.scheduleRestart();
    });

    this.emit({ type: 'running', port: this.chosenPort, pid: this.child.pid ?? -1 });

    // Probe the dashboard URL until it answers — the daemon takes a
    // moment to boot the webhook server.
    void this.waitForReady().then(
      (info) => {
        this.restartAttempts = 0;
        this.lastReadyAt = Date.now();
        this.readyResolve?.(info);
        this.emit({ type: 'ready', port: info.port, url: info.url });
      },
      (err) => this.readyReject?.(err),
    );

    return this.readyPromise;
  }

  /** Stop the daemon. Sends SIGTERM, escalates to SIGKILL after 5s. */
  async stop(): Promise<void> {
    this.shuttingDown = true;
    const child = this.child;
    if (!child) return;
    return new Promise<void>((resolve) => {
      const killer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, SHUTDOWN_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(killer);
        resolve();
      });
      try { child.kill('SIGTERM'); } catch {
        clearTimeout(killer);
        resolve();
      }
    });
  }

  /** Restart — stop + start. */
  async restart(): Promise<{ port: number; url: string }> {
    await this.stop();
    this.shuttingDown = false;
    return this.start();
  }

  isRunning(): boolean {
    return Boolean(this.child);
  }

  getPort(): number {
    return this.chosenPort;
  }

  getDashboardUrl(token?: string): string {
    const base = `http://${WEBHOOK_HOST}:${this.chosenPort}/console`;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }

  /** Read the most recent log lines for the dashboard to display. */
  tailLog(maxLines = 200): string[] {
    if (!existsSync(this.opts.logFile)) return [];
    try {
      const text = readFileSync(this.opts.logFile, 'utf-8');
      const lines = text.split('\n');
      return lines.slice(-maxLines);
    } catch {
      return [];
    }
  }

  // ─── internals ────────────────────────────────────────────────

  private emit(event: SupervisorEvent): void {
    this.opts.onEvent?.(event);
    // v0.5.21 Phase 2.5 — supervisor's own log events also go to the
    // supervisor.log file (which previously only captured daemon
    // stdout/stderr). Without this, operator-relevant signals like
    // "shell-path cache updated" never landed in the log file the
    // dashboard + ops tail. Best-effort: write failures must never
    // crash the supervisor.
    try {
      if (event.type === 'log' && this.logStream) {
        const text = event.line.endsWith('\n') ? event.line : event.line + '\n';
        this.logStream.write(text);
      }
    } catch { /* swallow — logging must never break the runtime */ }
  }

  private resolveDaemonCommand(): { command: string; args: string[]; runAsNode: boolean } {
    // Dev mode: project root has src/index.ts — run via tsx.
    const tsEntry = path.join(this.opts.daemonProjectRoot, 'src', 'index.ts');
    const jsEntry = path.join(this.opts.daemonProjectRoot, 'dist', 'index.js');

    if (existsSync(tsEntry)) {
      // Prefer the source entry in dev, even when dist/ exists. Running the
      // daemon through Electron-as-Node in dev forces native modules such as
      // better-sqlite3 to match Electron's ABI instead of the repo's Node ABI.
      const localTsx = path.join(this.opts.daemonProjectRoot, 'node_modules', '.bin', 'tsx');
      if (existsSync(localTsx)) {
        return { command: localTsx, args: [tsEntry, 'service'], runAsNode: false };
      }
      // Fallback to npx (slower first run, but works).
      return { command: 'npx', args: ['tsx', tsEntry, 'service'], runAsNode: false };
    }
    if (existsSync(jsEntry)) {
      // In a packaged Electron app, process.execPath is Electron itself.
      // ELECTRON_RUN_AS_NODE=1 (set in the spawn env) makes it behave
      // like Node.
      return { command: process.execPath, args: [jsEntry, 'service'], runAsNode: true };
    }
    throw new Error(`No daemon entry found in ${this.opts.daemonProjectRoot} (expected dist/index.js or src/index.ts)`);
  }

  private async waitForReady(): Promise<{ port: number; url: string }> {
    const url = `http://${WEBHOOK_HOST}:${this.chosenPort}/api/dashboard`;
    const deadline = Date.now() + READINESS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.shuttingDown) throw new Error('Daemon shutting down before ready');
      if (!this.child) throw new Error('Daemon exited before ready');
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
        // 200 OK or 401 (auth required) both mean the server is up.
        if (r.status === 200 || r.status === 401) {
          return { port: this.chosenPort, url: `http://${WEBHOOK_HOST}:${this.chosenPort}` };
        }
      } catch {
        // Connection refused / abort — keep polling.
      }
      await sleep(READINESS_POLL_MS);
    }
    throw new Error(`Daemon did not become ready within ${READINESS_TIMEOUT_MS}ms`);
  }

  private scheduleRestart(): void {
    // If the daemon was stable for >= STABILITY_RESET_MS before this
    // crash, treat it as a fresh failure: clear the prior count so a
    // long-uptime user doesn't get permanently locked out after 8
    // transient hiccups spread over weeks. We only decay the counter
    // BEFORE the increment so the rapid back-to-back crash path (where
    // lastReadyAt is recent) still trips the cap at 8.
    const stableUptime = this.lastReadyAt > 0 && (Date.now() - this.lastReadyAt) >= STABILITY_RESET_MS;
    if (stableUptime && this.restartAttempts > 0) {
      this.emit({ type: 'restart-counter-reset', reason: 'daemon was stable >=5min before this crash', priorAttempts: this.restartAttempts });
      this.restartAttempts = 0;
    }
    this.restartAttempts++;
    if (this.restartAttempts > 8) {
      this.emit({ type: 'restart-skipped', reason: 'too many failures — manual intervention required' });
      return;
    }
    const delayMs = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * Math.pow(2, this.restartAttempts - 1));
    this.emit({ type: 'restart-scheduled', delayMs, attempt: this.restartAttempts });
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.start().catch(() => { /* exit handler will reschedule */ });
      }
    }, delayMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Try to bind to `preferred`; if busy, walk forward until we find one
 *  that's free. Caps at 50 attempts. */
async function pickFreePort(preferred: number, host: string): Promise<number> {
  // Probe the exact host the daemon binds to. The daemon is loopback-only
  // by default; probing 0.0.0.0 would unnecessarily reserve a LAN-facing
  // port and can fail on locked-down machines.
  for (let p = preferred; p < preferred + 50; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(p, host);
    });
    if (ok) return p;
  }
  throw new Error(`No free port found in range ${preferred}..${preferred + 50}`);
}

/** Resolve the path to the daemon project from inside the Electron app.
 *  In dev (tsx src/main.ts), it's the parent repo. In a packaged build,
 *  it's the extraResources path under the .app/.exe bundle. */
export function locateDaemonProjectRoot(): string {
  // Dev: this file lives at apps/desktop/src/daemon-supervisor.ts →
  // two levels up to apps/desktop, then one more to repo root.
  // fileURLToPath (not .pathname) so spaces and unicode in install
  // paths get decoded properly — otherwise daemon spawn fails for
  // users whose home dir or app path contains %-encoded chars.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const devCandidate = path.resolve(here, '..', '..', '..');
  if (existsSync(path.join(devCandidate, 'src', 'index.ts')) || existsSync(path.join(devCandidate, 'dist', 'index.js'))) {
    return devCandidate;
  }
  // Packaged: resources/daemon next to the executable.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const packagedCandidate = path.join(resourcesPath ?? '', 'daemon');
  if (existsSync(packagedCandidate)) return packagedCandidate;
  // Last resort: user's repo clone under ~/clementine-next.
  const homeCandidate = path.join(os.homedir(), 'clementine-next');
  if (existsSync(path.join(homeCandidate, 'src', 'index.ts'))) return homeCandidate;
  throw new Error('Cannot locate the Clementine daemon project root');
}
