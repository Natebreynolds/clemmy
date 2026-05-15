import { spawnSync } from 'node:child_process';

export interface GlobalCliStatus {
  id: string;
  label: string;
  command: string;
  available: boolean;
  path?: string;
  version?: string;
  purpose: string;
}

const GLOBAL_CLI_CHECKS: Array<{
  id: string;
  label: string;
  command: string;
  versionArgs: string[];
  purpose: string;
}> = [
  { id: 'git', label: 'Git', command: 'git', versionArgs: ['--version'], purpose: 'repository inspection and code changes' },
  { id: 'node', label: 'Node.js', command: 'node', versionArgs: ['--version'], purpose: 'JavaScript and TypeScript project tasks' },
  { id: 'npm', label: 'npm', command: 'npm', versionArgs: ['--version'], purpose: 'package install, scripts, and publishing' },
  { id: 'pnpm', label: 'pnpm', command: 'pnpm', versionArgs: ['--version'], purpose: 'workspace package management when projects use pnpm' },
  { id: 'python3', label: 'Python', command: 'python3', versionArgs: ['--version'], purpose: 'Python automation and local scripts' },
  { id: 'uv', label: 'uv', command: 'uv', versionArgs: ['--version'], purpose: 'modern Python package and task workflows' },
  { id: 'gh', label: 'GitHub CLI', command: 'gh', versionArgs: ['--version'], purpose: 'GitHub issues, PRs, and repository operations' },
  { id: 'codex', label: 'Codex CLI', command: 'codex', versionArgs: ['--version'], purpose: 'ChatGPT/Codex OAuth bootstrap and local agent auth' },
  { id: 'railway', label: 'Railway CLI', command: 'railway', versionArgs: ['--version'], purpose: 'Railway deploy and service workflows' },
  { id: 'vercel', label: 'Vercel CLI', command: 'vercel', versionArgs: ['--version'], purpose: 'Vercel deploy and project workflows' },
  { id: 'netlify', label: 'Netlify CLI', command: 'netlify', versionArgs: ['--version'], purpose: 'Netlify deploy and site workflows' },
  { id: 'docker', label: 'Docker', command: 'docker', versionArgs: ['--version'], purpose: 'containerized local services and build workflows' },
];

const CACHE_TTL_MS = 60_000;
let cachedStatus: { expiresAt: number; value: GlobalCliStatus[] } | null = null;

function firstLine(value: string): string {
  return value.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

function commandPath(command: string): string | undefined {
  const result = spawnSync('sh', ['-lc', `command -v ${command}`], {
    encoding: 'utf-8',
    timeout: 250,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return undefined;
  if (result.status !== 0) return undefined;
  return firstLine(result.stdout);
}

function commandVersion(command: string, args: string[]): string | undefined {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    timeout: 600,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return undefined;
  const output = firstLine(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  return output || undefined;
}

export function listGlobalCliStatus(): GlobalCliStatus[] {
  const now = Date.now();
  if (cachedStatus && cachedStatus.expiresAt > now) {
    return cachedStatus.value;
  }

  const value = GLOBAL_CLI_CHECKS.map((check) => {
    const path = commandPath(check.command);
    return {
      id: check.id,
      label: check.label,
      command: check.command,
      available: Boolean(path),
      path,
      version: path ? commandVersion(check.command, check.versionArgs) : undefined,
      purpose: check.purpose,
    };
  });
  cachedStatus = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}
