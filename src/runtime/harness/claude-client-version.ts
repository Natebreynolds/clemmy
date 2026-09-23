import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
let cachedVersion: string | undefined;

export function parseClaudeClientVersion(output: string): string {
  const match = output.trim().match(/^(\d+\.\d+\.\d+)(?:\s|$)/);
  if (!match) throw new Error('Installed Claude client did not report a valid version');
  return match[1];
}

/** Read the actual packaged client version once per daemon. SDK and client
 * versions are different; never infer one from the other or pin a fake UA. */
export function installedClaudeClientVersion(): string {
  if (cachedVersion) return cachedVersion;
  const platform = `${process.platform}-${process.arch}`;
  const candidates = [platform, ...(process.platform === 'linux' ? [`${platform}-musl`] : [])];
  for (const candidate of candidates) {
    try {
      const root = path.dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${candidate}/package.json`));
      const executable = path.join(root, process.platform === 'win32' ? 'claude.exe' : 'claude');
      const output = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
      cachedVersion = parseClaudeClientVersion(output);
      return cachedVersion;
    } catch { /* Try the platform's other packaged runtime, if any. */ }
  }
  throw new Error('Cannot read the installed Claude SDK client version; reinstall the packaged SDK runtime.');
}
