/**
 * Shared sandboxed-script spawn substrate — the ONE place that knows how to run
 * an agent-authored, deterministic helper script safely (no LLM):
 *
 *   - resolve the right interpreter for a file (.js/.mjs/.cjs via node, .ts via
 *     tsx, .py via python3, .sh via bash, or a chmod+x executable),
 *   - build a SCRUBBED child env (PATH/HOME/locale/XDG only — never the daemon's
 *     OAuth tokens / API keys),
 *   - spawn with a hard timeout, a captured-output cap (so a runaway script can't
 *     OOM the daemon), and an EPIPE-on-early-exit guard,
 *   - return a structured outcome the CALLER interprets with its own policy.
 *
 * Two surfaces share this substrate (Wave 1.3 — "share the substrate, keep the
 * surfaces distinct"): Workspaces data/action runners (src/spaces/runner.ts) and
 * workflow deterministic steps (src/execution/workflow-runner.ts). Each keeps its
 * OWN path resolution, stdin payload shape, and output handling — only the
 * dangerous spawn mechanics live here, once.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, realpathSync, statSync, accessSync, constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { augmentPath } from './spawn-env.js';
import { stopWindowsProcessTree, type ProcessTreeStopResult } from './windows-process-tree.js';

export const SANDBOXED_SCRIPT_UNCONFIRMED_STOP_GUIDANCE =
  'The previous script process tree could not be confirmed stopped. Its effects are uncertain. ' +
  'Check and stop the remaining processes, then restart Clementine before running another script in this workspace.';

/** Default hard cap on captured stdout so a runaway runner can't OOM the daemon. */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Resolve a bare interpreter name to an absolute path on the augmented PATH so
 *  a minimal-PATH Finder-launched .app still finds python3/bash. */
export function resolveOnPath(bin: string, augmentedPath: string): string | null {
  if (path.isAbsolute(bin)) return existsSync(bin) ? bin : null;
  const extensions = process.platform === 'win32' && !path.extname(bin)
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const dir of augmentedPath.split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${bin}${ext}`);
      try { accessSync(candidate, fsConstants.X_OK); return candidate; } catch { /* next */ }
    }
  }
  return null;
}

/** Locate the bundled tsx CLI entry (ships in daemon/node_modules; the .bin
 *  symlink is filtered out of the packaged app, so resolve the package). */
export function resolveTsxEntry(): string | null {
  try { return createRequire(import.meta.url).resolve('tsx/cli'); } catch { return null; }
}

/** Decide how to run a runner file. `isElectron` flags the process.execPath case
 *  (node / tsx) so the caller sets ELECTRON_RUN_AS_NODE in the packaged app —
 *  without it, process.execPath (the Electron binary) launches a GUI instance
 *  instead of running the script. python3/bash resolve to absolute paths on the
 *  augmented PATH. Returns null for unsupported shapes. */
export function interpreterFor(
  target: string,
  augmentedPath: string,
): { command: string; args: string[]; isElectron: boolean } | null {
  const ext = path.extname(target).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { command: process.execPath, args: [target], isElectron: true };
  }
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
    const tsx = resolveTsxEntry();
    if (!tsx) return null; // surfaces "unsupported runner extension" — graceful
    return { command: process.execPath, args: [tsx, target], isElectron: true };
  }
  if (ext === '.py') {
    const command = process.platform === 'win32'
      ? resolveOnPath('python3', augmentedPath) ?? resolveOnPath('python', augmentedPath) ?? resolveOnPath('py', augmentedPath) ?? 'py'
      : resolveOnPath('python3', augmentedPath) ?? 'python3';
    const launcher = path.basename(command).toLowerCase();
    return { command, args: launcher === 'py' || launcher === 'py.exe' ? ['-3', target] : [target], isElectron: false };
  }
  if (ext === '.sh' || ext === '.bash') {
    const bash = resolveOnPath('bash', augmentedPath);
    if (bash) return { command: bash, args: [target], isElectron: false };
    if (process.platform !== 'win32') return { command: '/bin/bash', args: [target], isElectron: false };
    return null;
  }
  try {
    if ((statSync(target).mode & 0o111) !== 0) return { command: target, args: [], isElectron: false };
  } catch { /* fallthrough */ }
  return null;
}

/**
 * Safe, complete-enough baseline env for AGENT-AUTHORED runner code. We do NOT
 * spread process.env (it carries the daemon's OAuth tokens / API keys); we DO
 * carry what any generic CLI needs — binary resolution (augmented PATH),
 * $HOME-based auth (e.g. sf → ~/.sfdx), UTF-8 I/O, XDG config dirs, and
 * Clementine identity. None of these is a secret. `extra` keys are layered on
 * top (the caller's surface-specific vars + the ELECTRON_RUN_AS_NODE flag).
 */
export function scrubbedChildEnv(extra: Record<string, string> = {}): Record<string, string> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir() ?? '';
  const tmp = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? os.tmpdir();
  const inheritedPath = process.env.PATH ?? process.env.Path;
  const base: Record<string, string> = {
    PATH: augmentPath(inheritedPath),
    HOME: home,
    TMPDIR: tmp,
    TEMP: process.env.TEMP ?? tmp,
    TMP: process.env.TMP ?? tmp,
    SHELL: process.env.SHELL ?? process.env.ComSpec ?? (process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'),
    USER: process.env.USER ?? process.env.USERNAME ?? process.env.LOGNAME ?? '',
    USERNAME: process.env.USERNAME ?? process.env.USER ?? '',
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? process.env.USERNAME ?? '',
    USERPROFILE: process.env.USERPROFILE ?? home,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'en_US.UTF-8',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    NO_COLOR: '1',
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? (home ? path.join(home, '.config') : ''),
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? (home ? path.join(home, '.cache') : ''),
    XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? (home ? path.join(home, '.local', 'share') : ''),
    APPDATA: process.env.APPDATA ?? '',
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? '',
    ComSpec: process.env.ComSpec ?? '',
    CLEMENTINE_HOME: process.env.CLEMENTINE_HOME ?? '',
  };
  return { ...base, ...extra };
}

/** Set ELECTRON_RUN_AS_NODE only when the command IS the Electron/Node binary
 *  (the .js/.ts cases). NEVER for python/bash/executable runners. */
export function electronNodeEnv(command: string, isElectron: boolean): Record<string, string> {
  return (isElectron && command === process.execPath) ? { ELECTRON_RUN_AS_NODE: '1' } : {};
}

export interface SandboxedSpawnInput {
  command: string;
  args: string[];
  cwd: string;
  /** The fully-built child env (use scrubbedChildEnv()). */
  env: Record<string, string>;
  /** Written to the child's stdin and then closed; EPIPE on early exit is swallowed. */
  stdinPayload: string;
  timeoutMs: number;
  /** The owning run may stop a pending or already-started process. */
  signal?: AbortSignal;
  /** Cap on captured stdout (default DEFAULT_MAX_OUTPUT_BYTES). */
  maxOutputBytes?: number;
}

export interface SandboxedSpawnOutcome {
  /** Set when the process could not be SPAWNED (ENOENT/EPERM…). When present,
   *  code/signal are null and stdout/stderr are whatever was captured (usually ''). */
  launchError?: Error;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Cancellation is distinct from a deadline or process failure. */
  aborted: boolean;
  /** True once a process was created; cancellation does not imply no effects. */
  spawned: boolean;
  /** True when stdout exceeded the cap and the child was killed. */
  overflowed: boolean;
  /** A Windows stop receipt, including cancellation/output overflow. */
  timeoutCleanup?: ProcessTreeStopResult;
}

/**
 * Spawn a script with a hard timeout, an output cap, and an EPIPE guard, and
 * resolve a structured outcome. NEVER rejects — a launch failure surfaces as
 * `launchError` so the caller maps it to its own message. The promise settles
 * exactly once.
 */
function createSandboxedScriptSpawner(controls: {
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
  stopWindowsTree?: typeof stopWindowsProcessTree;
} = {}): (input: SandboxedSpawnInput) => Promise<SandboxedSpawnOutcome> {
  const platform = controls.platform ?? process.platform;
  const spawnProcess = controls.spawnProcess ?? spawn;
  const stopWindowsTree = controls.stopWindowsTree ?? stopWindowsProcessTree;
  // A successful stop cannot clear another concurrent script's uncertain stop.
  const stopObligations = new Map<string, { pending: number; incomplete: boolean }>();
  return (input: SandboxedSpawnInput): Promise<SandboxedSpawnOutcome> => {
  const maxBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const empty: SandboxedSpawnOutcome = {
    code: null, signal: null, stdout: '', stderr: '', timedOut: false,
    overflowed: false, aborted: false, spawned: false,
  };
  // Stop owns admission too: a cancelled caller never briefly launches a child.
  if (input.signal?.aborted) return Promise.resolve({ ...empty, aborted: true });
  let workspace = path.resolve(input.cwd);
  try { workspace = realpathSync(workspace); } catch { /* spawn owns missing cwd */ }
  if (platform === 'win32') workspace = workspace.toLowerCase();
  if (platform === 'win32' && stopObligations.has(workspace)) {
    return Promise.resolve({ ...empty, timeoutCleanup: 'incomplete',
      launchError: new Error(SANDBOXED_SCRIPT_UNCONFIRMED_STOP_GUIDANCE) });
  }
  return new Promise<SandboxedSpawnOutcome>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(input.command, input.args, {
        cwd: input.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: input.env,
        // A deadline/Stop owns the process group, including nested CLIs. A
        // script can deliberately escape it; this is not an OS sandbox.
        detached: platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ...empty, launchError: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    let settled = false;
    let stopping = false;
    let stdout = '';
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let overflowed = false;
    let aborted = false;
    const spawned = child.pid !== undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let windowsCleanupPending = false;
    let timeoutCleanup: ProcessTreeStopResult | undefined;
    let pendingClose: Pick<SandboxedSpawnOutcome, 'code' | 'signal' | 'launchError'> | undefined;
    const signalTree = (signal: NodeJS.Signals): void => {
      if (platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, signal); }
        catch (error) {
          // ESRCH means the owned group is gone. Do not address a possibly
          // reused child PID after its wrapper has already exited.
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            try { child.kill(signal); } catch { /* outcome remains stopped/uncertain */ }
          }
        }
      } else {
        try { child.kill(signal); } catch { /* launch never started */ }
      }
    };
    const finish = (details: Pick<SandboxedSpawnOutcome, 'code' | 'signal' | 'launchError'>): void => {
      if (settled) return;
      if (windowsCleanupPending) { pendingClose = details; return; }
      settled = true;
      if (timer) clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      input.signal?.removeEventListener('abort', onAbort);
      // A wrapper can exit on TERM while a child ignores it and has its stdio
      // detached. Its close event is not proof that the owned group stopped.
      if (stopping && platform !== 'win32') signalTree('SIGKILL');
      resolve({ ...details, ...(stopping && platform === 'win32' ? { code: null } : {}),
        stdout, stderr, timedOut, overflowed, aborted, spawned,
        ...(timeoutCleanup ? { timeoutCleanup } : {}) });
    };
    const stop = (reason: 'abort' | 'timeout' | 'overflow'): void => {
      if (settled || stopping) return;
      stopping = true;
      aborted = reason === 'abort';
      timedOut = reason === 'timeout';
      overflowed = reason === 'overflow';
      if (platform === 'win32' && child.pid) {
        // Hold the process lane before asking the OS to stop the exact tree.
        // A parent's late close event is not a descendant-cleanup receipt.
        windowsCleanupPending = true;
        const obligation = stopObligations.get(workspace) ?? { pending: 0, incomplete: false };
        obligation.pending += 1;
        stopObligations.set(workspace, obligation);
        void Promise.resolve().then(() => stopWindowsTree(child)).catch(() => 'incomplete' as const).then(status => {
          timeoutCleanup = status;
          obligation.pending -= 1;
          obligation.incomplete ||= status === 'incomplete';
          if (!obligation.pending && !obligation.incomplete) stopObligations.delete(workspace);
          windowsCleanupPending = false;
          // Descendants can retain inherited pipes after their wrapper exits.
          // The bounded OS receipt owns settlement, never the close callback.
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
          if (status === 'incomplete') child.unref();
          finish(pendingClose ?? { code: null, signal: null });
        });
        return;
      }
      signalTree('SIGTERM');
      escalation = setTimeout(() => signalTree('SIGKILL'), 2_000);
      escalation.unref?.();
    };
    const onAbort = (): void => stop('abort');
    timer = setTimeout(() => stop('timeout'), input.timeoutMs);
    timer.unref?.();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    // Covers an abort that occurred while spawn/registration was being set up.
    if (input.signal?.aborted) onAbort();

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (c) => {
      if (stdoutBytes > maxBytes) return;
      const text = String(c);
      stdout += text;
      stdoutBytes += Buffer.byteLength(text);
      if (stdoutBytes > maxBytes) stop('overflow');
    });
    child.stderr.on('data', (c) => { if (stderr.length < 100_000) stderr += String(c); });
    child.on('error', (err) => finish({ launchError: err, code: null, signal: null }));
    child.on('close', (code, signal) => finish({ code, signal }));
    // A child may exit before it consumes stdin. The close/error receipt owns
    // that outcome; EPIPE must not escape as an unhandled stream error.
    child.stdin.on('error', () => { /* child closed stdin early */ });
    try { child.stdin.end(input.stdinPayload); } catch { /* stdin optional */ }
  });
  };
}

const spawnDefaultSandboxedScript = createSandboxedScriptSpawner();
export function spawnSandboxedScript(input: SandboxedSpawnInput): Promise<SandboxedSpawnOutcome> {
  return spawnDefaultSandboxedScript(input);
}

/** Isolated process-control fixture; never changes the production registry. */
export const _testOnly_createSandboxedScriptSpawner = createSandboxedScriptSpawner;
