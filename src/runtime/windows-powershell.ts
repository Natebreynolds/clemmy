import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { windowsSystemRoot } from './windows-process-tree.js';

const READ_PAYLOAD = `[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ErrorActionPreference = 'Stop'
$payload = ConvertFrom-Json ([Console]::In.ReadToEnd())
`;

/** Fixed host programs receive literal values over stdin, not cmd.exe source.
 * The caller supplies source code, never a model/tool argument. Output stays
 * bounded and failure text deliberately omits private URLs and sign-in data. */
/** The exact invocation: Windows PowerShell 5.1 from the system root, the
 * payload reader prepended to the fixed program, a reduced environment. */
export function windowsPowerShellInvocation(
  program: string,
  environment: NodeJS.ProcessEnv = process.env,
): { executable: string; args: string[]; env: NodeJS.ProcessEnv } {
  const systemRoot = windowsSystemRoot(environment);
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(READ_PAYLOAD + program, 'utf16le').toString('base64');
  const env = Object.fromEntries(Object.entries(environment).filter(([key, value]) => value !== undefined
    && /^(?:systemroot|windir|systemdrive|comspec|pathext|path|userprofile|appdata|localappdata|temp|tmp)$/i.test(key)));
  return { executable, args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], env };
}

export function runWindowsPowerShell(
  program: string,
  payload: unknown,
  options: { env?: NodeJS.ProcessEnv; spawnProcess?: typeof spawn; timeoutMs?: number } = {},
): Promise<string> {
  const { executable, args, env } = windowsPowerShellInvocation(program, options.env ?? process.env);
  return new Promise((resolve, reject) => {
    let child: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let output = '';
    const finish = (success: boolean, reason = 'Windows could not confirm the requested application launch. Check whether a window opened before trying again.'): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (!success) {
        try { child?.kill('SIGKILL'); } catch { /* no dispatch receipt */ }
        child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
        reject(new Error(reason));
      } else resolve(output.trim());
    };
    try {
      child = (options.spawnProcess ?? spawn)(executable, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      timer = setTimeout(() => finish(false, 'Windows application launch timed out; check whether a window opened before trying again.'),
        Math.min(15_000, Math.max(1, options.timeoutMs ?? 15_000)));
      child.on('error', () => finish(false));
      child.stdin?.on('error', () => finish(false));
      child.stdout?.on('data', chunk => {
        output += chunk.toString('utf8');
        if (Buffer.byteLength(output, 'utf8') > 4_096) finish(false);
      });
      // Drain errors without persisting or returning potentially private data.
      child.stderr?.on('data', () => {});
      child.once('close', code => finish(code === 0));
      child.stdin?.end(JSON.stringify(payload));
    } catch { finish(false); }
  });
}

/** Registry-backed URL/file association. No URL becomes shell syntax. */
export async function launchWindowsDefaultApp(target: string): Promise<void> {
  if (!target || /[\x00-\x1f]/.test(target)) throw new Error('Invalid application target.');
  await runWindowsPowerShell('Start-Process -FilePath $payload.target -ErrorAction Stop', { target });
}
