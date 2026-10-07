import type { ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { spawnCliProcess } from './cli-spawn.js';
import { stopWindowsProcessTree } from './windows-process-tree.js';

export interface CliProbeProcessResult {
  exitCode: number | null;
  output: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cleanupIncomplete?: boolean;
  overflowed?: boolean;
}

interface Options {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Each stream retains the previous auth-health executor's 256 KiB bound. */
  maxBuffer?: number;
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
  stopWindowsTree?: typeof stopWindowsProcessTree;
}

/** Keep an unconfirmed Windows child from overlapping another probe of the
 * same executable. Restart is required after stopping the remaining process.
 * This state is deliberately local to the owning daemon process. */
export function createCliProbeRunner(): (binaryPath: string, args: string[], options: Options) => Promise<CliProbeProcessResult> {
  const blocked = new Set<string>();
  const pendingStops = new Map<string, number>();
  return (binaryPath, args, options) => {
    const platform = options.platform ?? process.platform;
    const key = platform === 'win32' ? path.win32.normalize(binaryPath).toLowerCase() : binaryPath;
    const failed = (stderr: string, extra: Partial<CliProbeProcessResult> = {}): CliProbeProcessResult => ({
      exitCode: 1, output: '', stdout: '', stderr, timedOut: false, ...extra,
    });
    if (platform === 'win32' && blocked.has(key)) {
      return Promise.resolve(failed('The previous CLI probe process tree could not be confirmed stopped. Stop its remaining processes and restart Clementine before probing this executable again.',
        { exitCode: null, timedOut: true, cleanupIncomplete: true }));
    }
    if (platform === 'win32' && pendingStops.has(key)) {
      return Promise.resolve(failed('The previous CLI probe process tree is still being stopped. Wait for cleanup before probing this executable again.',
        { exitCode: null, timedOut: true, cleanupIncomplete: true }));
    }
    return new Promise(resolve => {
      const limit = options.maxBuffer ?? 256 * 1024;
      const buffers = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
      const sizes = { stdout: 0, stderr: 0 };
      let child: ChildProcess;
      let settling = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = (exitCode: number | null, timedOut: boolean): CliProbeProcessResult => {
        const stdout = Buffer.concat(buffers.stdout).toString('utf8');
        const stderr = Buffer.concat(buffers.stderr).toString('utf8');
        return { exitCode, stdout, stderr, output: [stdout, stderr].filter(Boolean).join('\n'), timedOut };
      };
      const finish = (value: CliProbeProcessResult): void => {
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      const stop = async (reason: 'timeout' | 'overflow'): Promise<void> => {
        if (settling) return;
        settling = true;
        if (timer) clearTimeout(timer);
        let cleanupIncomplete = false;
        if (platform === 'win32') {
          // Register before awaiting: another caller may arrive while this
          // exact child's cleanup is pending. Each already-running probe owns
          // its own obligation; one complete receipt cannot clear another.
          pendingStops.set(key, (pendingStops.get(key) ?? 0) + 1);
          try {
            let status: 'complete' | 'incomplete' = 'incomplete';
            try { status = await (options.stopWindowsTree ?? stopWindowsProcessTree)(child, { env: options.env }); }
            catch { /* no receipt means incomplete, never a new healthy verdict */ }
            cleanupIncomplete = status !== 'complete';
            if (cleanupIncomplete) blocked.add(key);
          } finally {
            const remaining = (pendingStops.get(key) ?? 1) - 1;
            if (remaining > 0) pendingStops.set(key, remaining);
            else pendingStops.delete(key);
          }
        } else {
          try { child.kill('SIGKILL'); } catch { /* a failed probe never supplies a new verdict */ }
        }
        // Do not let pipes inherited by a lingering descendant hold the probe
        // or its caller open after the bounded cleanup attempt has finished.
        child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
        if (cleanupIncomplete) {
          finish(failed('CLI probe cleanup did not confirm that its Windows process tree stopped. Check and stop remaining processes, then restart Clementine before probing this executable again.',
            { exitCode: null, timedOut: true, cleanupIncomplete: true, ...(reason === 'overflow' ? { overflowed: true } : {}) }));
        } else if (reason === 'overflow') {
          // Partial identity/auth output must never establish an account or
          // sign-out verdict after the output limit terminated the process.
          finish(failed('CLI probe output exceeded the bounded output limit.', { overflowed: true }));
        } else finish(result(null, true));
      };
      try {
        child = (options.spawnProcess ?? spawnCliProcess)(binaryPath, args, {
          cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        });
      } catch {
        settling = true; finish(failed('CLI probe could not be started.')); return;
      }
      for (const stream of ['stdout', 'stderr'] as const) {
        child[stream]?.on('data', (chunk: Buffer | string) => {
          if (settling) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (sizes[stream] + bytes.length > limit) { void stop('overflow'); return; }
          sizes[stream] += bytes.length; buffers[stream].push(bytes);
        });
      }
      timer = setTimeout(() => { void stop('timeout'); }, options.timeoutMs);
      child.once('error', () => {
        if (settling) return;
        settling = true; finish(failed('CLI probe could not be started.'));
      });
      child.once('close', code => {
        if (settling) return;
        settling = true; finish(result(code, false));
      });
    });
  };
}

export const runCliProbeProcess = createCliProbeRunner();
