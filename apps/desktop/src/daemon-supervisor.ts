import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, renameSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
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
  | { type: 'restart-skipped'; reason: string }
  | { type: 'liveness-deferred'; misses: number; unresponsiveMs: number; ipcHeartbeatAgeMs: number; deferral: number; maxDeferrals: number }
  | { type: 'hung-restart'; misses: number; unresponsiveMs: number; ipcHeartbeatAgeMs: number | null; heartbeat: DaemonIpcHeartbeatSnapshot | null; recentLogs: SupervisorLogTailEntry[] };

const READINESS_TIMEOUT_MS = 90_000;
const READINESS_POLL_MS = 250;
const SHUTDOWN_GRACE_MS = 5_000;
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;

// ── Liveness watchdog (2026-07-08; retuned 2026-07-09) ─────────────────────
// A synchronous fs call inside the daemon's event loop hung on a saturated
// disk (OneDrive sync → open$NOCANCEL never returned): the process stayed
// alive but every HTTP request, chat turn, and even SIGTERM handling froze —
// indefinitely, until a human noticed. The supervisor only probed at BOOT, so
// a daemon that hung after 'ready' was invisible. Keep probing /api/status for
// the whole run; after LIVENESS_MAX_MISSES consecutive timeouts SIGKILL the
// child — a frozen loop can't process SIGTERM — and let the existing
// exit→scheduleRestart path bring it back with backoff.
//
// RETUNE (live false-positive, 2026-07-09 03:22Z): the v1.3.1 values (5s
// timeout × 3 misses, no grace) SIGKILLed a BUSY-but-alive daemon — boot
// warmup (route-policy rebuild, local embedding model load) starved three
// short probes while a real chat POST was being served seconds later. A
// watchdog that manufactures the exact mid-run restarts it exists to prevent
// is worse than none. New bar: a probe gets 15s (an intermittently-busy loop
// can answer; a frozen one cannot), FOUR consecutive misses (~80s of sustained
// unresponsiveness), and NO verdicts during the post-ready warmup grace.
const LIVENESS_PROBE_INTERVAL_MS = 20_000;
const LIVENESS_PROBE_TIMEOUT_MS = 15_000;
const LIVENESS_MAX_MISSES = 4;
const LIVENESS_GRACE_AFTER_READY_MS = 180_000;
const SUPERVISOR_IPC_HEARTBEAT_TYPE = 'clementine.daemon.heartbeat';
const SUPERVISOR_IPC_HEARTBEAT_FRESH_MS = 30_000;
const LIVENESS_MAX_IPC_DEFERRALS = 2;

interface DaemonIpcHeartbeatMessage {
  type: typeof SUPERVISOR_IPC_HEARTBEAT_TYPE;
  at?: unknown;
  uptimeMs?: unknown;
  pid?: unknown;
  phase?: unknown;
  reason?: unknown;
}

export interface DaemonIpcHeartbeatSnapshot {
  at?: string;
  uptimeMs?: number;
  pid?: number;
  reason?: string;
  phase?: {
    name?: string;
    detail?: string;
    startedAt?: string;
    activeMs?: number;
    sequence?: number;
  };
}

export interface SupervisorLogTailEntry {
  at: string;
  stream: 'stdout' | 'stderr';
  line: string;
}

export function isDaemonIpcHeartbeatMessage(message: unknown): message is DaemonIpcHeartbeatMessage {
  return Boolean(
    message
    && typeof message === 'object'
    && (message as { type?: unknown }).type === SUPERVISOR_IPC_HEARTBEAT_TYPE,
  );
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown, maxChars = 240): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxChars) : undefined;
}

export function normalizeDaemonIpcHeartbeatMessage(message: unknown): DaemonIpcHeartbeatSnapshot | null {
  if (!isDaemonIpcHeartbeatMessage(message)) return null;
  const raw = message as DaemonIpcHeartbeatMessage;
  const phaseRaw = raw.phase && typeof raw.phase === 'object'
    ? raw.phase as Record<string, unknown>
    : null;
  const phase = phaseRaw
    ? {
        name: stringValue(phaseRaw.name),
        detail: stringValue(phaseRaw.detail),
        startedAt: stringValue(phaseRaw.startedAt),
        activeMs: finiteNumber(phaseRaw.activeMs),
        sequence: finiteNumber(phaseRaw.sequence),
      }
    : undefined;
  return {
    at: stringValue(raw.at),
    uptimeMs: finiteNumber(raw.uptimeMs),
    pid: finiteNumber(raw.pid),
    reason: stringValue(raw.reason),
    phase: phase && Object.values(phase).some((v) => v !== undefined) ? phase : undefined,
  };
}

export function appendSupervisorLogTail(
  tail: SupervisorLogTailEntry[],
  stream: 'stdout' | 'stderr',
  chunk: string,
  nowIso: string = new Date().toISOString(),
  opts: { maxEntries?: number; maxLineChars?: number } = {},
): SupervisorLogTailEntry[] {
  const maxEntries = opts.maxEntries ?? 80;
  const maxLineChars = opts.maxLineChars ?? 500;
  const next = [...tail];
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    next.push({ at: nowIso, stream, line: line.slice(0, maxLineChars) });
  }
  return next.slice(-maxEntries);
}

export function formatHungRestartDiagnostic(input: {
  misses: number;
  unresponsiveMs: number;
  ipcHeartbeatAgeMs: number | null;
  heartbeat: DaemonIpcHeartbeatSnapshot | null;
  recentLogs: SupervisorLogTailEntry[];
}): string {
  const phase = input.heartbeat?.phase;
  const phaseText = phase?.name
    ? `${phase.name}${phase.detail ? ` ${phase.detail}` : ''}${typeof phase.activeMs === 'number' ? ` active=${Math.round(phase.activeMs / 1000)}s` : ''}`
    : 'unknown';
  const lines = [
    `=== Daemon HUNG diagnostic: misses=${input.misses} http_unresponsive=${Math.round(input.unresponsiveMs / 1000)}s ipc_heartbeat=${formatIpcHeartbeatAge(input.ipcHeartbeatAgeMs)} phase=${phaseText} ===`,
  ];
  if (input.heartbeat) {
    lines.push(`[heartbeat] ${JSON.stringify(input.heartbeat)}`);
  }
  if (input.recentLogs.length > 0) {
    lines.push('[recent daemon logs]');
    for (const entry of input.recentLogs.slice(-12)) {
      lines.push(`${entry.at} ${entry.stream}: ${entry.line}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function shouldDeferHungRestartForIpcHeartbeat(
  heartbeatAgeMs: number | null,
  freshMs = SUPERVISOR_IPC_HEARTBEAT_FRESH_MS,
  priorDeferrals = 0,
  maxDeferrals = LIVENESS_MAX_IPC_DEFERRALS,
): heartbeatAgeMs is number {
  return heartbeatAgeMs !== null
    && Number.isFinite(heartbeatAgeMs)
    && heartbeatAgeMs >= 0
    && heartbeatAgeMs <= freshMs
    && priorDeferrals < maxDeferrals;
}

function formatIpcHeartbeatAge(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs)) return 'none';
  return `${Math.round(ageMs / 1000)}s`;
}

// supervisor.log is append-only and was never rotated — it grew unbounded
// (30MB+ observed). Roll it at log-open when it exceeds this size, keeping one
// previous generation (.1). Override via CLEMENTINE_SUPERVISOR_LOG_MAX_BYTES.
const DEFAULT_SUPERVISOR_LOG_MAX_BYTES = 20 * 1024 * 1024; // 20MB
function supervisorLogMaxBytes(): number {
  const raw = Number.parseInt(process.env.CLEMENTINE_SUPERVISOR_LOG_MAX_BYTES ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SUPERVISOR_LOG_MAX_BYTES;
}

/**
 * Roll the supervisor log when it exceeds maxBytes: rename current → `.1`
 * (replacing any prior generation), so the live file restarts empty on the next
 * open. rename-then-create is crash-safe. Best-effort — a rotation failure must
 * never block daemon start. Returns true when a rotation happened.
 */
export function rotateSupervisorLogIfNeeded(logFile: string, maxBytes: number): boolean {
  try {
    if (!existsSync(logFile)) return false;
    if (statSync(logFile).size <= maxBytes) return false;
    renameSync(logFile, `${logFile}.1`);
    return true;
  } catch {
    return false;
  }
}
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
  private child: ChildProcess | null = null;
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
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private livenessMisses = 0;
  private livenessProbeInFlight = false;
  private livenessIpcDeferrals = 0;
  private lastIpcHeartbeatAt = 0;
  private lastIpcHeartbeat: DaemonIpcHeartbeatSnapshot | null = null;
  private recentDaemonLogs: SupervisorLogTailEntry[] = [];

  constructor(private opts: SupervisorOptions) {
    if (!existsSync(opts.daemonProjectRoot)) {
      throw new Error(`Daemon project root does not exist: ${opts.daemonProjectRoot}`);
    }
    const logDir = path.dirname(opts.logFile);
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  }

  /** Start (or restart) the daemon. Resolves when the daemon's minimal
   *  health route answers, rejects after READINESS_TIMEOUT_MS. */
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
    const home = os.homedir();
    const COMMON_USER_BIN_DIRS = process.platform === 'win32'
      ? [
        process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '',
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : '',
        process.env.ProgramData ? path.join(process.env.ProgramData, 'chocolatey', 'bin') : '',
        process.env.SCOOP ? path.join(process.env.SCOOP, 'shims') : '',
        home ? path.join(home, 'scoop', 'shims') : '',
      ]
      : [
        '/opt/homebrew/bin',     // Apple Silicon Homebrew
        '/opt/homebrew/sbin',
        '/usr/local/bin',        // Intel Mac Homebrew + npm globals
        '/usr/local/sbin',
        `${home}/.cargo/bin`,    // Rust toolchain
        `${home}/.local/bin`,    // pipx, generic user installs
        `${home}/go/bin`,        // Go binaries
      ];

    // v0.5.21 Phase 2.5 — merge in the user's shell PATH so version
    // managers (nvm, asdf, mise, volta, fnm, rbenv, pyenv, sdkman)
    // become visible. Without this, anything installed via
    // `npm install -g X` while on nvm is invisible to `local_cli_list`
    // (verified 2026-05-25: Higgsfield at ~/.nvm/.../bin/higgsfield
    // was missed). Cache-first: read instantly at boot; async-refresh
    // in background and write a new cache when it changes. Daemon
    // picks up the refreshed PATH at the next restart (no IPC).
    const cachedShellPath = readShellPathCache()?.path ?? null;
    const inheritedPath = process.env.PATH ?? process.env.Path ?? '';
    const augmentedPath = mergePaths(
      COMMON_USER_BIN_DIRS.filter(Boolean).join(path.delimiter),
      cachedShellPath,
      inheritedPath,
    );
    // Kick off the async re-extraction; logging only — never blocks.
    if (process.platform !== 'win32') extractShellPath()
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
    const pathEnvKey = process.platform === 'win32'
      ? Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path'
      : 'PATH';
    if (process.platform === 'win32') {
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === 'path' && key !== pathEnvKey) delete env[key];
      }
    }
    env[pathEnvKey] = augmentedPath;

    this.lastIpcHeartbeatAt = 0;
    this.lastIpcHeartbeat = null;
    this.recentDaemonLogs = [];
    this.child = spawn(command, args, {
      cwd: this.opts.daemonProjectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    if (!this.child.stdout || !this.child.stderr) {
      throw new Error('Daemon supervisor failed to open stdout/stderr pipes');
    }

    // Roll the log if it's grown past the cap BEFORE re-opening it for append.
    rotateSupervisorLogIfNeeded(this.opts.logFile, supervisorLogMaxBytes());
    this.logStream = createWriteStream(this.opts.logFile, { flags: 'a' });
    this.logStream.write(`\n=== Daemon started ${new Date().toISOString()} on port ${this.chosenPort} ===\n`);

    // emit() is the SINGLE writer of log events to supervisor.log — writing
    // here too (the pre-v0.5.21 direct write) duplicated every daemon line
    // once emit() started mirroring log events into the file, silently
    // doubling supervisor.log's growth (~11MB/day observed).
    this.child.stdout.on('data', (buf: Buffer) => {
      const line = buf.toString();
      this.recentDaemonLogs = appendSupervisorLogTail(this.recentDaemonLogs, 'stdout', line);
      this.emit({ type: 'log', stream: 'stdout', line });
    });
    this.child.stderr.on('data', (buf: Buffer) => {
      const line = buf.toString();
      this.recentDaemonLogs = appendSupervisorLogTail(this.recentDaemonLogs, 'stderr', line);
      this.emit({ type: 'log', stream: 'stderr', line });
    });
    this.child.on('message', (message: unknown) => {
      const heartbeat = normalizeDaemonIpcHeartbeatMessage(message);
      if (!heartbeat) return;
      this.lastIpcHeartbeatAt = Date.now();
      this.lastIpcHeartbeat = heartbeat;
    });

    this.child.on('exit', (code, signal) => {
      this.stopLivenessWatchdog();
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
        this.startLivenessWatchdog();
      },
      (err) => this.readyReject?.(err),
    );

    return this.readyPromise;
  }

  /** Ongoing hang detection — see the LIVENESS_* constants for the rationale.
   *  Runs from 'ready' until exit/stop; a probe is a GET of the same minimal
   *  /api/status route the boot readiness check uses. */
  private startLivenessWatchdog(): void {
    this.stopLivenessWatchdog();
    this.livenessMisses = 0;
    const readyAt = Date.now();
    const url = `http://${WEBHOOK_HOST}:${this.chosenPort}/api/status`;
    this.livenessTimer = setInterval(() => {
      if (this.shuttingDown || !this.child) { this.stopLivenessWatchdog(); return; }
      // Warmup grace: boot does legitimately heavy work (embedding model load,
      // policy rebuilds) that can starve probes without being a hang. Probes
      // still run (so the miss counter is warm), but no verdict fires yet.
      if (Date.now() - readyAt < LIVENESS_GRACE_AFTER_READY_MS) { this.livenessMisses = 0; }
      if (this.livenessProbeInFlight) return; // never stack probes
      this.livenessProbeInFlight = true;
      void fetch(url, { signal: AbortSignal.timeout(LIVENESS_PROBE_TIMEOUT_MS) })
        .then((r) => {
          if (r.status === 200) {
            this.livenessMisses = 0;
            this.livenessIpcDeferrals = 0;
          } else {
            this.livenessMisses += 1;
          }
        })
        .catch(() => {
          this.livenessMisses += 1;
        })
        .finally(() => {
          this.livenessProbeInFlight = false;
          if (this.livenessMisses < LIVENESS_MAX_MISSES || this.shuttingDown || !this.child) return;
          const misses = this.livenessMisses;
          const unresponsiveMs = misses * LIVENESS_PROBE_INTERVAL_MS;
          const ipcHeartbeatAgeMs = this.lastIpcHeartbeatAt > 0 ? Date.now() - this.lastIpcHeartbeatAt : null;
          if (shouldDeferHungRestartForIpcHeartbeat(ipcHeartbeatAgeMs, SUPERVISOR_IPC_HEARTBEAT_FRESH_MS, this.livenessIpcDeferrals, LIVENESS_MAX_IPC_DEFERRALS)) {
            this.livenessIpcDeferrals += 1;
            const deferral = this.livenessIpcDeferrals;
            this.livenessMisses = 0;
            this.emit({ type: 'liveness-deferred', misses, unresponsiveMs, ipcHeartbeatAgeMs, deferral, maxDeferrals: LIVENESS_MAX_IPC_DEFERRALS });
            this.logStream?.write(`=== Daemon HTTP liveness missed ${misses} probes (~${Math.round(unresponsiveMs / 1000)}s), but IPC heartbeat is fresh (${formatIpcHeartbeatAge(ipcHeartbeatAgeMs)} old) — deferring restart ${deferral}/${LIVENESS_MAX_IPC_DEFERRALS} at ${new Date().toISOString()} ===\n`);
            return;
          }
          const heartbeat = this.lastIpcHeartbeat;
          const recentLogs = [...this.recentDaemonLogs];
          this.emit({ type: 'hung-restart', misses, unresponsiveMs, ipcHeartbeatAgeMs, heartbeat, recentLogs });
          this.logStream?.write(`=== Daemon HUNG (HTTP unresponsive ~${Math.round(unresponsiveMs / 1000)}s, IPC heartbeat ${formatIpcHeartbeatAge(ipcHeartbeatAgeMs)} old) — force-restarting at ${new Date().toISOString()} ===\n`);
          this.logStream?.write(formatHungRestartDiagnostic({ misses, unresponsiveMs, ipcHeartbeatAgeMs, heartbeat, recentLogs }));
          this.writeHungRestartSnapshot({ misses, unresponsiveMs, ipcHeartbeatAgeMs, heartbeat, recentLogs });
          this.stopLivenessWatchdog();
          // A frozen event loop cannot run its SIGTERM handler — go straight
          // to SIGKILL; the child 'exit' handler schedules the restart with
          // the normal backoff/caps.
          try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
        });
    }, LIVENESS_PROBE_INTERVAL_MS);
    // Never keep the Electron main process alive just to poll the daemon.
    this.livenessTimer.unref?.();
  }

  private stopLivenessWatchdog(): void {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
    this.livenessMisses = 0;
    this.livenessIpcDeferrals = 0;
  }

  private writeHungRestartSnapshot(snapshot: {
    misses: number;
    unresponsiveMs: number;
    ipcHeartbeatAgeMs: number | null;
    heartbeat: DaemonIpcHeartbeatSnapshot | null;
    recentLogs: SupervisorLogTailEntry[];
  }): void {
    try {
      const file = path.join(path.dirname(this.opts.logFile), 'supervisor-hang-snapshots.jsonl');
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...snapshot })}\n`);
    } catch {
      // Best-effort only; supervisor.log still carries the human-readable version.
    }
  }

  /** Stop the daemon. Sends SIGTERM, escalates to SIGKILL after 5s. */
  async stop(): Promise<void> {
    this.shuttingDown = true;
    this.stopLivenessWatchdog();
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

  /** Read the most recent log lines for the dashboard to display. Reads only
   *  the last ~256KB rather than slurping the whole (possibly 20MB) file. */
  tailLog(maxLines = 200): string[] {
    if (!existsSync(this.opts.logFile)) return [];
    const TAIL_BYTES = 256 * 1024;
    let fd: number | undefined;
    try {
      fd = openSync(this.opts.logFile, 'r');
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const length = size - start;
      if (length <= 0) return [];
      const buf = Buffer.allocUnsafe(length);
      readSync(fd, buf, 0, length, start);
      return buf.toString('utf-8').split('\n').slice(-maxLines);
    } catch {
      return [];
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
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
    // Probe the smallest public health route, not `/api/dashboard`.
    // `/api/dashboard` can do real work (state aggregation, MCP status,
    // memory/runs/approvals) and on a cold packaged launch it can cross
    // the old 30s supervisor window even though the daemon is alive.
    // `/api/status` is intentionally minimal and is the correct boot
    // readiness signal.
    const url = `http://${WEBHOOK_HOST}:${this.chosenPort}/api/status`;
    const deadline = Date.now() + READINESS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.shuttingDown) throw new Error('Daemon shutting down before ready');
      if (!this.child) throw new Error('Daemon exited before ready');
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (r.status === 200) {
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
