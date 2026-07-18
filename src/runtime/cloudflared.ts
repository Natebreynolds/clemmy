/**
 * Wrapper around the `cloudflared` CLI. Everything the daemon needs to
 * stand up and run a Cloudflare Tunnel for the mobile PWA:
 *
 *   detectCloudflared()        — find the binary + version
 *   installCloudflaredViaBrew  — `brew install cloudflared` (macOS)
 *   startCloudflaredLogin()    — open browser, poll for cert.pem
 *   listTunnels()              — `cloudflared tunnel list --output json`
 *   createTunnel(name)         — `cloudflared tunnel create <name>`
 *   routeDns(tunnel, host)     — `cloudflared tunnel route dns <name> <host>`
 *   class CloudflaredSupervisor — long-running child that pipes traffic
 *
 * Design notes:
 *   - Never invoke a shell (`shell: true`). All spawns pass argv arrays
 *     so user-supplied tunnel/host names can't shell-escape. The login
 *     and run subcommands run unattended (no TTY).
 *   - cloudflared writes its state under ~/.cloudflared (cert.pem,
 *     <tunnel-id>.json, config.yml). We only read those — never edit.
 *   - "macOS-first": brew install path is the documented happy path.
 *     Linux users get a clear "binary not found, install manually"
 *     message that links to https://developers.cloudflare.com/cloudflared.
 */

import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

// ─── detection ───────────────────────────────────────────────────────

export interface DetectResult {
  binary: string | null;
  version: string | null;
  source: 'path' | 'homebrew' | 'usr-local' | 'not-found';
}

const PROBE_PATHS = [
  '/opt/homebrew/bin/cloudflared',
  '/usr/local/bin/cloudflared',
  '/usr/bin/cloudflared',
];

function whichCloudflared(): { path: string; source: DetectResult['source'] } | null {
  // Try PATH first.
  const which = spawnSync('which', ['cloudflared'], { encoding: 'utf-8' });
  if (which.status === 0) {
    const found = which.stdout.trim();
    if (found) {
      const source = found.includes('homebrew') ? 'homebrew' : 'path';
      return { path: found, source };
    }
  }
  // Fallback to standard install locations (Electron app may have a
  // pinched PATH).
  for (const candidate of PROBE_PATHS) {
    if (existsSync(candidate)) {
      const source = candidate.includes('homebrew') ? 'homebrew' : 'usr-local';
      return { path: candidate, source };
    }
  }
  return null;
}

function parseVersionOutput(text: string): string | null {
  // `cloudflared version 2024.2.1 (built ...)`
  const match = text.match(/cloudflared version\s+([0-9][^\s]*)/i);
  return match ? match[1] : null;
}

export async function detectCloudflared(): Promise<DetectResult> {
  const located = whichCloudflared();
  if (!located) return { binary: null, version: null, source: 'not-found' };
  const v = spawnSync(located.path, ['--version'], { encoding: 'utf-8' });
  const version = v.status === 0 ? parseVersionOutput(v.stdout || v.stderr) : null;
  return { binary: located.path, version, source: located.source };
}

// ─── homebrew install ────────────────────────────────────────────────

export interface InstallOptions {
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void;
}

export async function installCloudflaredViaBrew(
  opts: InstallOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      error: 'Automatic install via Homebrew is macOS-only. Install cloudflared manually: https://developers.cloudflare.com/cloudflared/',
    };
  }
  const brewWhich = spawnSync('which', ['brew'], { encoding: 'utf-8' });
  if (brewWhich.status !== 0) {
    return {
      ok: false,
      error: 'Homebrew not found. Install from https://brew.sh, then run cloudflared install.',
    };
  }
  const brew = brewWhich.stdout.trim();
  return new Promise((resolve) => {
    const child = spawn(brew, ['install', 'cloudflared'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (b: Buffer) => streamLines(b, 'stdout', opts.onLine));
    child.stderr.on('data', (b: Buffer) => streamLines(b, 'stderr', opts.onLine));
    child.on('exit', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: `brew install cloudflared exited ${code}` });
    });
  });
}

function streamLines(
  buf: Buffer,
  stream: 'stdout' | 'stderr',
  onLine?: (s: 'stdout' | 'stderr', line: string) => void,
): void {
  if (!onLine) return;
  for (const line of buf.toString('utf-8').split(/\r?\n/)) {
    if (line.length > 0) onLine(stream, line);
  }
}

// ─── login (Cloudflare OAuth via browser) ────────────────────────────

export interface LoginSession {
  /** The login URL the user must open. We capture it from stdout. */
  url: Promise<string>;
  /** The cert path we're watching for. */
  certPath: string;
  /** Resolves when login completes (cert appears) or fails. */
  done: Promise<{ ok: true; certPath: string } | { ok: false; error: string }>;
  /** Cancel the login: kill cloudflared + stop polling. */
  cancel: () => void;
}

const DEFAULT_CERT_PATH = path.join(os.homedir(), '.cloudflared', 'cert.pem');

export function startCloudflaredLogin(opts?: { binary?: string }): LoginSession {
  const binary = opts?.binary ?? whichCloudflared()?.path;
  const certPath = DEFAULT_CERT_PATH;
  if (!binary) {
    return {
      url: Promise.reject(new Error('cloudflared binary not found')),
      certPath,
      done: Promise.resolve({ ok: false, error: 'cloudflared binary not found' }),
      cancel: () => undefined,
    };
  }
  // Snapshot the existing cert's mtime so we can detect a fresh one
  // even if a stale cert.pem is still on disk from an old install.
  const priorMtime = existsSync(certPath) ? statSync(certPath).mtimeMs : 0;

  let urlResolve!: (u: string) => void;
  let urlReject!: (e: Error) => void;
  const urlPromise = new Promise<string>((resolve, reject) => {
    urlResolve = resolve;
    urlReject = reject;
  });

  const child = spawn(binary, ['tunnel', 'login'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let urlCaptured = false;
  const watchForUrl = (buf: Buffer): void => {
    if (urlCaptured) return;
    const text = buf.toString('utf-8');
    // cloudflared prints something like:
    // "Please open the following URL in your browser:
    //  https://dash.cloudflare.com/argotunnel?..."
    const match = text.match(/https?:\/\/[^\s]+/);
    if (match) {
      urlCaptured = true;
      urlResolve(match[0]);
    }
  };
  child.stdout.on('data', watchForUrl);
  child.stderr.on('data', watchForUrl);

  let cancelled = false;
  let pollTimer: NodeJS.Timeout | undefined;

  const done = new Promise<{ ok: true; certPath: string } | { ok: false; error: string }>((resolve) => {
    // Poll for the cert.pem mtime advancing. cloudflared's `tunnel login`
    // doesn't reliably exit on its own — we have to detect the cert
    // ourselves and then kill the child.
    const startedAt = Date.now();
    const POLL_INTERVAL_MS = 1000;
    const TIMEOUT_MS = 10 * 60_000; // 10-minute browser session window
    const poll = (): void => {
      if (cancelled) return;
      const exists = existsSync(certPath);
      const fresh = exists && statSync(certPath).mtimeMs > priorMtime;
      if (fresh) {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        resolve({ ok: true, certPath });
        return;
      }
      if (Date.now() - startedAt > TIMEOUT_MS) {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        resolve({ ok: false, error: 'login timed out (10 minutes)' });
        return;
      }
      pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    };
    pollTimer = setTimeout(poll, POLL_INTERVAL_MS);

    child.on('exit', (code) => {
      if (cancelled) return;
      // If the cert appeared first, the resolve above already fired and
      // this is a no-op (Promise can only resolve once).
      if (code !== 0 && !urlCaptured) {
        urlReject(new Error(`cloudflared exited ${code} before printing the login URL`));
      }
      if (!existsSync(certPath) || statSync(certPath).mtimeMs <= priorMtime) {
        if (pollTimer) clearTimeout(pollTimer);
        resolve({ ok: false, error: `cloudflared exited with code ${code} before login completed` });
      }
    });
  });

  return {
    url: urlPromise,
    certPath,
    done,
    cancel: () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    },
  };
}

// ─── tunnel management ───────────────────────────────────────────────

export interface TunnelInfo {
  id: string;
  name: string;
  created_at: string;
  connections?: unknown[];
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runCloudflared(binary: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf-8'); });
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf-8'); });
    child.on('exit', (code) => {
      resolve({ ok: code === 0, stdout, stderr, exitCode: code });
    });
    child.on('error', (err) => {
      resolve({ ok: false, stdout, stderr: stderr + '\n' + String(err), exitCode: null });
    });
  });
}

/** Exposed for tests. */
export function parseTunnelList(jsonText: string): TunnelInfo[] {
  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((row: Record<string, unknown>) => ({
      id: String(row.id ?? ''),
      name: String(row.name ?? ''),
      created_at: String(row.created_at ?? ''),
      connections: Array.isArray(row.connections) ? row.connections : undefined,
    })).filter((t) => t.id && t.name);
  } catch {
    return [];
  }
}

export async function listTunnels(opts?: { binary?: string }): Promise<TunnelInfo[]> {
  const binary = opts?.binary ?? whichCloudflared()?.path;
  if (!binary) throw new Error('cloudflared binary not found');
  const res = await runCloudflared(binary, ['tunnel', 'list', '--output', 'json']);
  if (!res.ok) {
    throw new Error(`cloudflared tunnel list failed: ${res.stderr.trim() || res.stdout.trim() || `exit ${res.exitCode}`}`);
  }
  return parseTunnelList(res.stdout);
}

/** Exposed for tests. */
export function parseCreatedTunnel(stdout: string): { id: string; credentialsFile?: string } | null {
  // cloudflared 2024+ prints:
  //   Tunnel credentials written to /Users/.../.cloudflared/<uuid>.json.
  //   Created tunnel <name> with id <uuid>
  const idMatch = stdout.match(/(?:with id|id\s*[:=])\s*([0-9a-fA-F-]{36})/);
  const credsMatch = stdout.match(/credentials\s+written\s+to\s+(\S+\.json)/i);
  if (!idMatch) return null;
  return {
    id: idMatch[1],
    credentialsFile: credsMatch ? credsMatch[1].replace(/[.,]$/, '') : undefined,
  };
}

export async function createTunnel(
  name: string,
  opts?: { binary?: string },
): Promise<TunnelInfo & { credentialsFile?: string }> {
  if (!/^[A-Za-z0-9._-]{1,63}$/.test(name)) {
    throw new Error('Tunnel name must be 1-63 chars of A-Z, a-z, 0-9, dot, dash, underscore');
  }
  const binary = opts?.binary ?? whichCloudflared()?.path;
  if (!binary) throw new Error('cloudflared binary not found');
  const res = await runCloudflared(binary, ['tunnel', 'create', name]);
  if (!res.ok) {
    throw new Error(`cloudflared tunnel create failed: ${res.stderr.trim() || res.stdout.trim() || `exit ${res.exitCode}`}`);
  }
  const parsed = parseCreatedTunnel(res.stdout + '\n' + res.stderr);
  if (!parsed) {
    throw new Error(`Could not parse tunnel id from cloudflared output:\n${res.stdout}`);
  }
  return {
    id: parsed.id,
    name,
    created_at: new Date().toISOString(),
    credentialsFile: parsed.credentialsFile,
  };
}

export async function routeDns(
  tunnelNameOrId: string,
  hostname: string,
  opts?: { binary?: string },
): Promise<void> {
  if (!/^[A-Za-z0-9._-]{1,253}$/.test(hostname)) {
    throw new Error('Invalid hostname');
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(tunnelNameOrId)) {
    throw new Error('Invalid tunnel name/id');
  }
  const binary = opts?.binary ?? whichCloudflared()?.path;
  if (!binary) throw new Error('cloudflared binary not found');
  const res = await runCloudflared(binary, ['tunnel', 'route', 'dns', tunnelNameOrId, hostname]);
  if (!res.ok) {
    throw new Error(`cloudflared tunnel route dns failed: ${res.stderr.trim() || res.stdout.trim() || `exit ${res.exitCode}`}`);
  }
}

// ─── long-running tunnel supervisor ─────────────────────────────────

export interface CloudflaredSupervisorOptions {
  /** Resolved binary path; pass to avoid re-detect on every start. */
  binary: string;
  /** Tunnel name OR uuid. Omit for a Cloudflare Quick Tunnel. */
  tunnelNameOrId?: string;
  /** Start an ephemeral trycloudflare.com tunnel that does not require login or a domain. */
  quickTunnel?: boolean;
  /** Local URL the tunnel forwards to (e.g. http://127.0.0.1:8420). */
  localUrl: string;
  /** Where to append cloudflared's stdout/stderr. */
  logFile: string;
  /** Cap consecutive crash restarts. Default 8. */
  maxRestarts?: number;
  onEvent?: (event: CloudflaredEvent) => void;
}

export type CloudflaredEvent =
  | { type: 'starting' }
  | { type: 'running'; pid: number }
  | { type: 'url'; url: string; hostname: string }
  | { type: 'connected' }
  | { type: 'log'; stream: 'stdout' | 'stderr'; line: string }
  | { type: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { type: 'restart-scheduled'; delayMs: number; attempt: number }
  | { type: 'restart-skipped'; reason: string };

const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;

export function parseQuickTunnelUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
  return match ? match[0] : null;
}

/**
 * Interprets one line of cloudflared output.
 *
 * Extracted from the supervisor's inline stream handler so both the piped path
 * and the detached log-tailing path speak one event vocabulary instead of
 * drifting into two subtly different parsers. Pure, so it is directly testable.
 */
export function interpretCloudflaredLine(
  line: string,
  alreadyConnected: boolean,
): CloudflaredEvent[] {
  if (!line) return [];
  const events: CloudflaredEvent[] = [];
  const quickUrl = parseQuickTunnelUrl(line);
  if (quickUrl) {
    try {
      const parsed = new URL(quickUrl);
      events.push({ type: 'url', url: quickUrl, hostname: parsed.hostname });
      events.push({ type: 'connected' });
      return events;
    } catch {
      /* malformed URL in output — fall through */
    }
  }
  if (!alreadyConnected && /Registered tunnel connection|Connection .+ registered/i.test(line)) {
    events.push({ type: 'connected' });
  }
  return events;
}

export interface DetachedTunnelHandle {
  pid: number;
  logFile: string;
  startedAt: string;
}

/**
 * Starts a quick tunnel as a DETACHED process that outlives this daemon.
 *
 * A trycloudflare hostname is stable for the lifetime of the cloudflared
 * process. While that process was a child of the daemon, every daemon restart —
 * upgrade, crash, dev reload, launchd respawn — rotated the hostname, and a new
 * hostname is a new ORIGIN: it invalidates the home-screen icon, the session
 * cookie, the service worker, the push subscription, and notification
 * permission. Detaching makes the overwhelming majority of restarts invisible
 * to the phone. Only a machine reboot rotates.
 *
 * stdio MUST go to a file, never a pipe: with `detached` + `pipe`, cloudflared
 * writes into a closed pipe once the daemon exits and dies on EPIPE, which
 * would defeat the entire point.
 */
export function spawnDetachedQuickTunnel(opts: {
  binary: string;
  localUrl: string;
  logFile: string;
}): DetachedTunnelHandle {
  mkdirSync(path.dirname(opts.logFile), { recursive: true });
  const fd = openSync(opts.logFile, 'a');
  try {
    const child = spawn(
      opts.binary,
      ['tunnel', '--no-autoupdate', '--url', opts.localUrl],
      { detached: true, stdio: ['ignore', fd, fd] },
    );
    // Let the parent exit without waiting on this child.
    child.unref();
    if (typeof child.pid !== 'number') throw new Error('cloudflared did not report a pid');
    return { pid: child.pid, logFile: opts.logFile, startedAt: new Date().toISOString() };
  } finally {
    closeSync(fd);
  }
}

/** Signal-0 liveness check; EPERM means alive but owned by another user. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Waits for a detached quick tunnel to announce its hostname by tailing the log.
 *
 * The hostname is only discoverable from cloudflared's own output, so this is
 * unavoidable on FIRST start. Adoption on later starts uses the persisted
 * hostname plus an HTTP probe instead, which is stronger evidence than
 * re-reading a log.
 */
export async function awaitQuickTunnelHostname(
  logFile: string,
  opts?: { timeoutMs?: number; pollMs?: number; since?: number },
): Promise<string | null> {
  const deadline = Date.now() + (opts?.timeoutMs ?? 60_000);
  const pollMs = opts?.pollMs ?? 400;
  const since = opts?.since ?? 0;
  while (Date.now() < deadline) {
    try {
      const text = readFileSync(logFile, 'utf-8').slice(since);
      const url = parseQuickTunnelUrl(text);
      if (url) return new URL(url).hostname;
    } catch {
      /* log not written yet */
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

export class CloudflaredSupervisor {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private logStream: ReturnType<typeof createWriteStream> | null = null;
  private shuttingDown = false;
  private restartAttempts = 0;
  private connected = false;

  constructor(private readonly opts: CloudflaredSupervisorOptions) {}

  async start(): Promise<void> {
    if (this.child) return;
    this.shuttingDown = false;
    this.connected = false;
    mkdirSync(path.dirname(this.opts.logFile), { recursive: true });
    this.logStream = createWriteStream(this.opts.logFile, { flags: 'a' });
    const label = this.opts.quickTunnel ? 'quick tunnel' : `tunnel ${this.opts.tunnelNameOrId}`;
    this.logStream.write(`\n=== cloudflared starting ${new Date().toISOString()} for ${label} → ${this.opts.localUrl} ===\n`);
    this.emit({ type: 'starting' });

    if (!this.opts.quickTunnel && !this.opts.tunnelNameOrId) {
      throw new Error('tunnelNameOrId is required unless quickTunnel is true');
    }
    const args = this.opts.quickTunnel
      ? ['tunnel', '--no-autoupdate', '--url', this.opts.localUrl]
      : ['tunnel', '--url', this.opts.localUrl, 'run', this.opts.tunnelNameOrId!];
    this.child = spawn(this.opts.binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onLine = (stream: 'stdout' | 'stderr') => (buf: Buffer): void => {
      const text = buf.toString('utf-8');
      this.logStream?.write(text);
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        this.emit({ type: 'log', stream, line });
        for (const event of interpretCloudflaredLine(line, this.connected)) {
          if (event.type === 'connected') this.connected = true;
          this.emit(event);
        }
      }
    };
    this.child.stdout.on('data', onLine('stdout'));
    this.child.stderr.on('data', onLine('stderr'));

    this.child.on('exit', (code, signal) => {
      this.logStream?.write(`=== cloudflared exited code=${code} signal=${signal} at ${new Date().toISOString()} ===\n`);
      this.logStream?.end();
      this.logStream = null;
      this.child = null;
      this.emit({ type: 'exit', code, signal });
      if (this.shuttingDown) return;
      this.scheduleRestart();
    });

    this.emit({ type: 'running', pid: this.child.pid ?? -1 });
  }

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

  isRunning(): boolean {
    return Boolean(this.child);
  }

  isConnected(): boolean {
    return this.connected;
  }

  private emit(event: CloudflaredEvent): void {
    try { this.opts.onEvent?.(event); } catch { /* swallow */ }
  }

  private scheduleRestart(): void {
    this.restartAttempts += 1;
    const max = this.opts.maxRestarts ?? 8;
    if (this.restartAttempts > max) {
      this.emit({ type: 'restart-skipped', reason: `exceeded ${max} restart attempts` });
      return;
    }
    const delayMs = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** (this.restartAttempts - 1));
    this.emit({ type: 'restart-scheduled', delayMs, attempt: this.restartAttempts });
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.start().catch(() => { /* exit handler reschedules */ });
      }
    }, delayMs);
  }
}
