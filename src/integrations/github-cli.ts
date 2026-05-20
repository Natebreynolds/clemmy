import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const STATUS_TIMEOUT_MS = 8_000;

export interface GitHubCliStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
  authenticated: boolean;
  username: string | null;
  authStatus: 'ok' | 'missing' | 'invalid' | 'error';
  authMessage: string | null;
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findGitHubCli(): string | null {
  const explicit = process.env.GITHUB_CLI_PATH?.trim() || process.env.GH_CLI_PATH?.trim();
  if (explicit && isExecutable(explicit)) return explicit;

  const candidates = [
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    path.join(os.homedir(), '.local', 'bin', 'gh'),
  ];
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'gh');
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export function runGitHubCli(args: string[], timeoutMs = STATUS_TIMEOUT_MS): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}> {
  const binary = findGitHubCli();
  if (!binary) {
    return Promise.resolve({
      ok: false,
      stdout: '',
      stderr: 'GitHub CLI is not installed.',
      exitCode: null,
      timedOut: false,
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(binary, args, {
      cwd: os.homedir(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      resolve({
        ok: false,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8') || `GitHub CLI timed out after ${timeoutMs}ms.`,
        exitCode: null,
        timedOut: true,
      });
    }, timeoutMs);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: error.message,
        exitCode: null,
        timedOut: false,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
        exitCode: code,
        timedOut: false,
      });
    });
  });
}

function compact(text: string): string {
  return text.replace(/\s+$/g, '').slice(0, 1600);
}

export async function getGitHubCliStatus(): Promise<GitHubCliStatus> {
  const binary = findGitHubCli();
  if (!binary) {
    return {
      installed: false,
      path: null,
      version: null,
      authenticated: false,
      username: null,
      authStatus: 'missing',
      authMessage: 'Install GitHub CLI to clone private skill repos and use GitHub tools locally.',
    };
  }

  const [version, auth] = await Promise.all([
    runGitHubCli(['--version'], STATUS_TIMEOUT_MS),
    runGitHubCli(['auth', 'status', '-h', 'github.com'], STATUS_TIMEOUT_MS),
  ]);
  const authText = compact([auth.stdout, auth.stderr].filter(Boolean).join('\n'));
  const userMatch = authText.match(/account\s+([A-Za-z0-9-]+)/) ?? authText.match(/Logged in to github\.com account\s+([A-Za-z0-9-]+)/i);
  const invalid = /token .* invalid|Failed to log in|not logged into|not authenticated/i.test(authText);
  return {
    installed: true,
    path: binary,
    version: compact([version.stdout, version.stderr].filter(Boolean).join('\n')).split('\n')[0] || null,
    authenticated: auth.ok,
    username: userMatch?.[1] ?? null,
    authStatus: auth.ok ? 'ok' : invalid ? 'invalid' : 'error',
    authMessage: auth.ok ? authText : authText || 'Run gh auth login --web to connect GitHub.',
  };
}
