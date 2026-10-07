import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

export type ProcessTreeStopResult = 'complete' | 'incomplete';

/** Resolve an OS utility independently of the project or CLI PATH. */
export function windowsSystemRoot(env: NodeJS.ProcessEnv = process.env): string {
  const entry = Object.entries(env).find(([key, value]) => key.toLowerCase() === 'systemroot' && value);
  const root = entry?.[1] || 'C:\\Windows';
  if (!path.win32.isAbsolute(root)) throw new Error('Windows SystemRoot must be an absolute path.');
  return root;
}

/** Only the child object created by the caller supplies the PID to stop.
 * A successful taskkill result is the receipt; failure never means stopped.
 * The bound also covers an OS utility which never closes its own pipes. */
export function stopWindowsProcessTree(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  options: { env?: NodeJS.ProcessEnv; spawnProcess?: typeof spawn; timeoutMs?: number } = {},
): Promise<ProcessTreeStopResult> {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) return Promise.resolve('incomplete');
  const env = options.env ?? process.env;
  const spawnProcess = options.spawnProcess ?? spawn;
  const timeoutMs = Math.min(5_000, Math.max(1, options.timeoutMs ?? 5_000));
  return new Promise(resolve => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killer: ChildProcess | undefined;
    const finish = (status: ProcessTreeStopResult): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (status === 'incomplete') {
        try { child.kill('SIGKILL'); } catch { /* stop of parent alone is not a tree receipt */ }
      }
      resolve(status);
    };
    try {
      const systemRoot = windowsSystemRoot(env);
      const utilityEnv: NodeJS.ProcessEnv = { SystemRoot: systemRoot };
      for (const [key, value] of Object.entries(env)) {
        if (value && /^(?:windir|systemdrive|comspec|pathext|temp|tmp)$/i.test(key)) utilityEnv[key] = value;
      }
      killer = spawnProcess(path.win32.join(systemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(pid), '/T', '/F'], { env: utilityEnv, stdio: 'ignore', windowsHide: true });
      timer = setTimeout(() => {
        try { killer?.kill('SIGKILL'); } catch { /* no confirmed cleanup */ }
        killer?.unref();
        finish('incomplete');
      }, timeoutMs);
      killer.once('error', () => finish('incomplete'));
      killer.once('close', code => finish(code === 0 ? 'complete' : 'incomplete'));
    } catch {
      finish('incomplete');
    }
  });
}
