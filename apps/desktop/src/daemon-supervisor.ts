import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer } from 'node:net';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Readable } from 'node:stream';

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
  | { type: 'restart-skipped'; reason: string };

const READINESS_TIMEOUT_MS = 30_000;
const READINESS_POLL_MS = 250;
const SHUTDOWN_GRACE_MS = 5_000;
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;

export class DaemonSupervisor {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private logStream: ReturnType<typeof createWriteStream> | null = null;
  private shuttingDown = false;
  private restartAttempts = 0;
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
    this.chosenPort = await pickFreePort(this.opts.preferredPort ?? 8520);

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.emit({ type: 'starting', port: this.chosenPort, attempt: this.restartAttempts });

    const { command, args, runAsNode } = this.resolveDaemonCommand();

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.opts.envOverrides,
      WEBHOOK_ENABLED: 'true',
      WEBHOOK_PORT: String(this.chosenPort),
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
    const base = `http://localhost:${this.chosenPort}/console`;
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
    const url = `http://localhost:${this.chosenPort}/api/dashboard`;
    const deadline = Date.now() + READINESS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.shuttingDown) throw new Error('Daemon shutting down before ready');
      if (!this.child) throw new Error('Daemon exited before ready');
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
        // 200 OK or 401 (auth required) both mean the server is up.
        if (r.status === 200 || r.status === 401) {
          return { port: this.chosenPort, url: `http://localhost:${this.chosenPort}` };
        }
      } catch {
        // Connection refused / abort — keep polling.
      }
      await sleep(READINESS_POLL_MS);
    }
    throw new Error(`Daemon did not become ready within ${READINESS_TIMEOUT_MS}ms`);
  }

  private scheduleRestart(): void {
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
async function pickFreePort(preferred: number): Promise<number> {
  for (let p = preferred; p < preferred + 50; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(p, '127.0.0.1');
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
  const here = path.dirname(new URL(import.meta.url).pathname);
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
