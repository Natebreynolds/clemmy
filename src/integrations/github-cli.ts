import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCliProbeProcess } from '../runtime/cli-probe-process.js';
import { mergedSpawnEnv } from '../runtime/spawn-env.js';
import { cliHealthExecutableIdentity } from './cli-catalog/cli-executable-identity.js';

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
  // Lookup happens in the daemon's working directory; execution happens in
  // the owner's home. Preserve the selected path across that cwd boundary.
  if (explicit && isExecutable(path.resolve(explicit))) return path.resolve(explicit);

  const candidates = [
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    path.join(os.homedir(), '.local', 'bin', 'gh'),
  ];
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  const names = process.platform === 'win32' ? ['gh.exe', 'gh.cmd', 'gh.bat', 'gh'] : ['gh'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.resolve(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export interface GitHubCliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

interface GitHubCliClientDependencies {
  resolve?: () => string | null;
  environment?: () => Record<string, string>;
  cwd?: () => string;
  probe?: typeof runCliProbeProcess;
  platform?: NodeJS.Platform;
}

interface GitHubCliSnapshot {
  binary: string;
  env: Readonly<Record<string, string>>;
  cwd: string;
}

function createGitHubCliClient(dependencies: GitHubCliClientDependencies = {}) {
  const resolve = dependencies.resolve ?? findGitHubCli;
  const environment = dependencies.environment ?? mergedSpawnEnv;
  const cwd = dependencies.cwd ?? os.homedir;
  const probe = dependencies.probe ?? runCliProbeProcess;
  const platform = dependencies.platform ?? process.platform;
  const snapshot = (): GitHubCliSnapshot | null => {
    const binary = resolve();
    // A health observation must identify the exact launch path, never a
    // relative name whose meaning changes with the child's working directory.
    if (!binary || !cliHealthExecutableIdentity(binary, platform)) return null;
    return { binary, cwd: cwd(), env: Object.freeze(Object.fromEntries(Object.entries(environment()))) };
  };
  const missing = (): GitHubCliResult => ({
    ok: false,
    stdout: '',
    stderr: 'GitHub CLI is not installed.',
    exitCode: null,
    timedOut: false,
  });
  const execute = async (selected: GitHubCliSnapshot, args: string[], timeoutMs: number): Promise<{
    result: GitHubCliResult; complete: boolean; incompleteMessage?: string;
  }> => {
    const result = await probe(selected.binary, [...args], {
      cwd: selected.cwd, env: selected.env, timeoutMs, maxBuffer: 256 * 1024, platform,
    });
    const complete = !result.timedOut && !result.overflowed && !result.cleanupIncomplete;
    return {
      complete,
      result: {
        ok: complete && result.exitCode === 0,
        // Partial output from a stopped probe cannot establish an account.
        stdout: complete ? result.stdout : '',
        stderr: result.stderr || (result.timedOut ? `GitHub CLI timed out after ${timeoutMs}ms.` : ''),
        exitCode: complete ? result.exitCode : null,
        timedOut: result.timedOut,
      },
      ...(!complete ? { incompleteMessage: result.cleanupIncomplete
        ? 'GitHub CLI check could not confirm that all probe processes stopped. Stop remaining processes and restart Clementine before checking again.'
        : result.timedOut ? 'GitHub CLI check timed out before all probes completed.'
          : 'GitHub CLI check exceeded the bounded output limit.' } : {}),
    };
  };
  return {
    async runGitHubCli(args: string[], timeoutMs = STATUS_TIMEOUT_MS): Promise<GitHubCliResult> {
      const selected = snapshot();
      return selected ? (await execute(selected, args, timeoutMs)).result : missing();
    },
    async getGitHubCliStatus(): Promise<GitHubCliStatus> {
      const selected = snapshot();
      if (!selected) return {
        installed: false, path: null, version: null, authenticated: false, username: null,
        authStatus: 'missing', authMessage: 'Install GitHub CLI to clone private skill repos and use GitHub tools locally.',
      };
      const [versionProbe, authProbe] = await Promise.all([
        execute(selected, ['--version'], STATUS_TIMEOUT_MS),
        execute(selected, ['auth', 'status', '-h', 'github.com'], STATUS_TIMEOUT_MS),
      ]);
      const version = versionProbe.result;
      const auth = authProbe.result;
      const incomplete = !versionProbe.complete ? versionProbe : !authProbe.complete ? authProbe : null;
      const authText = compact([auth.stdout, auth.stderr].filter(Boolean).join('\n'));
      const authenticated = !incomplete && auth.ok;
      const invalid = !incomplete && !auth.timedOut && auth.exitCode !== null
        && /token .* invalid|Failed to log in|not logged into|not authenticated/i.test(authText);
      const userMatch = authenticated || invalid
        ? authText.match(/account\s+([A-Za-z0-9-]+)/) ?? authText.match(/Logged in to github\.com account\s+([A-Za-z0-9-]+)/i)
        : null;
      return {
        installed: true,
        path: selected.binary,
        version: versionProbe.complete ? compact([version.stdout, version.stderr].filter(Boolean).join('\n')).split('\n')[0] || null : null,
        authenticated,
        username: userMatch?.[1] ?? null,
        authStatus: authenticated ? 'ok' : invalid ? 'invalid' : 'error',
        authMessage: incomplete ? incomplete.incompleteMessage ?? 'GitHub CLI check did not complete.'
          : authenticated ? authText : authText || 'Run gh auth login --web to connect GitHub.',
      };
    },
  };
}

function compact(text: string): string {
  return text.replace(/\s+$/g, '').slice(0, 1600);
}

const githubCliClient = createGitHubCliClient();
export const runGitHubCli = githubCliClient.runGitHubCli;
export const getGitHubCliStatus = githubCliClient.getGitHubCliStatus;

/** Controlled resolver/process injection only; not a model or setup surface. */
export const _testOnly_createGitHubCliClient = createGitHubCliClient;
