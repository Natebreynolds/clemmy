import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSecretStore } from '../runtime/secrets/index.js';
import { invalidateCachedScan as invalidateCliScan } from '../runtime/cli-discovery.js';

export const BROWSER_HARNESS_REPO_URL = 'https://github.com/browser-use/browser-harness';
export const BROWSER_HARNESS_DIR = path.join(os.homedir(), 'Developer', 'browser-harness');
export const BROWSER_HARNESS_CODEX_SKILL_DIR = path.join(os.homedir(), '.codex', 'skills', 'browser-harness');

const MAX_OUTPUT_CHARS = 24000;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface CommandResult {
  ok: boolean;
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

export interface BrowserHarnessStatus {
  installed: boolean;
  commandPath?: string;
  version?: string;
  installDir: string;
  repoPresent: boolean;
  codexSkillLinked: boolean;
  prerequisites: Array<{
    name: string;
    available: boolean;
    path?: string;
    version?: string;
  }>;
  browserUseCloudKeyPresent: boolean;
  chromeSetupUrl: string;
  docsUrl: string;
  installCommand: string;
}

export interface InstallJob {
  id: string;
  recipeId: 'browser-harness' | 'custom-install';
  title: string;
  status: 'running' | 'succeeded' | 'failed';
  command: string;
  output: string;
  startedAt: string;
  completedAt?: string;
  exitCode?: number | null;
}

const jobs = new Map<string, InstallJob>();

function truncate(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(value.length - MAX_OUTPUT_CHARS)}\n...[truncated ${value.length - MAX_OUTPUT_CHARS} chars from start]`;
}

function extraPath(): string {
  const additions = [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  return [...additions, process.env.PATH || ''].filter(Boolean).join(path.delimiter);
}

export function browserHarnessEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: extraPath(),
    ...extra,
  };
}

function shellCommand(command: string): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { command: '/bin/sh', args: ['-lc', command] };
}

function runShell(command: string, options: {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
} = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const shell = shellCommand(command);
    const child = spawn(shell.command, shell.args, {
      cwd: options.cwd || os.homedir(),
      env: options.env || browserHarnessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout = truncate(stdout + String(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderr = truncate(stderr + String(chunk));
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      stderr = truncate(stderr + error.message);
      resolve({
        ok: false,
        command,
        code: -1,
        stdout,
        stderr,
        output: [stdout, stderr].filter(Boolean).join('\n'),
      });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        ok: code === 0,
        command,
        code,
        stdout,
        stderr,
        output: [stdout, stderr].filter(Boolean).join('\n'),
      });
    });
    if (options.stdin) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

function commandPath(command: string): string | undefined {
  const result = spawnSync('/bin/sh', ['-lc', `command -v ${command}`], {
    encoding: 'utf-8',
    env: browserHarnessEnv(),
    timeout: 1_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.split('\n').map((line) => line.trim()).find(Boolean);
}

function commandVersion(command: string, args: string[]): string | undefined {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    env: browserHarnessEnv(),
    timeout: 2_500,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return undefined;
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  return text.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 220);
}

function prerequisite(name: string, versionArgs: string[] = ['--version']): BrowserHarnessStatus['prerequisites'][number] {
  const found = commandPath(name);
  return {
    name,
    available: Boolean(found),
    path: found,
    version: found ? commandVersion(name, versionArgs) : undefined,
  };
}

export function browserHarnessInstallCommand(): string {
  return [
    'set -e',
    'if ! command -v git >/dev/null 2>&1; then echo "git is required before installing Browser Harness."; exit 2; fi',
    'if ! command -v uv >/dev/null 2>&1; then echo "uv is required before installing Browser Harness. Install uv first: https://docs.astral.sh/uv/getting-started/installation/"; exit 2; fi',
    'mkdir -p "$HOME/Developer"',
    `if [ ! -d "${BROWSER_HARNESS_DIR}/.git" ]; then git clone ${BROWSER_HARNESS_REPO_URL} "${BROWSER_HARNESS_DIR}"; else cd "${BROWSER_HARNESS_DIR}" && git pull --ff-only; fi`,
    `cd "${BROWSER_HARNESS_DIR}"`,
    'uv tool install -e .',
    'mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills/browser-harness"',
    'ln -sf "$PWD/SKILL.md" "${CODEX_HOME:-$HOME/.codex}/skills/browser-harness/SKILL.md"',
    'command -v browser-harness',
    'browser-harness --version',
  ].join('\n');
}

export async function getBrowserHarnessStatus(): Promise<BrowserHarnessStatus> {
  const command = commandPath('browser-harness');
  const store = await getSecretStore();
  const cloudKey = await store.get('browser_use_api_key');
  const skillPath = path.join(BROWSER_HARNESS_CODEX_SKILL_DIR, 'SKILL.md');
  let codexSkillLinked = false;
  try {
    codexSkillLinked = existsSync(skillPath) && (lstatSync(skillPath).isSymbolicLink() || lstatSync(skillPath).isFile());
  } catch {
    codexSkillLinked = false;
  }
  return {
    installed: Boolean(command),
    commandPath: command,
    version: command ? commandVersion('browser-harness', ['--version']) : undefined,
    installDir: BROWSER_HARNESS_DIR,
    repoPresent: existsSync(path.join(BROWSER_HARNESS_DIR, '.git')),
    codexSkillLinked,
    prerequisites: [
      prerequisite('git', ['--version']),
      prerequisite('uv', ['--version']),
      prerequisite('python3', ['--version']),
    ],
    browserUseCloudKeyPresent: Boolean(cloudKey.value),
    chromeSetupUrl: 'chrome://inspect/#remote-debugging',
    docsUrl: BROWSER_HARNESS_REPO_URL,
    installCommand: browserHarnessInstallCommand(),
  };
}

export function startBrowserHarnessInstall(): InstallJob {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const command = browserHarnessInstallCommand();
  const job: InstallJob = {
    id,
    recipeId: 'browser-harness',
    title: 'Install Browser Harness',
    status: 'running',
    command,
    output: '',
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);

  const shell = shellCommand(command);
  const child = spawn(shell.command, shell.args, {
    cwd: os.homedir(),
    env: browserHarnessEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { job.output = truncate(job.output + String(chunk)); });
  child.stderr.on('data', (chunk) => { job.output = truncate(job.output + String(chunk)); });
  child.on('error', (error) => {
    job.status = 'failed';
    job.output = truncate(job.output + error.message);
    job.completedAt = new Date().toISOString();
    job.exitCode = -1;
  });
  child.on('close', (code) => {
    job.status = code === 0 ? 'succeeded' : 'failed';
    job.completedAt = new Date().toISOString();
    job.exitCode = code;
    // A successful install (brew/npm/uv/pipx/git clone) almost always
    // adds something to $PATH or a directory we probe. Bust the CLI
    // cache so the agent and dashboard see the new tool immediately
    // instead of waiting for the 10-min TTL.
    if (code === 0) invalidateCliScan();
  });
  return job;
}

export function getInstallJob(id: string): InstallJob | undefined {
  return jobs.get(id);
}

export function validateInstallCommand(command: string): { ok: true; normalized: string } | { ok: false; error: string } {
  const normalized = command.replace(/\s+/g, ' ').trim();
  if (!normalized) return { ok: false, error: 'command required' };
  const lower = normalized.toLowerCase();
  const denied = [
    /\bsudo\b/,
    /\brm\b/,
    /\bchmod\b/,
    /\bchown\b/,
    /\bdd\b/,
    /\bmkfs\b/,
    /\bdiskutil\b/,
    /[;&|`$<>]/,
  ];
  if (denied.some((pattern) => pattern.test(normalized))) {
    return { ok: false, error: 'Only single, non-destructive install commands are allowed here.' };
  }
  const allowed = [
    /^npm (install|i) (-g|--global) [@a-z0-9._/-]+$/i,
    // brew install [--cask] <formula>  — cask flag is standard for
    // GUI / macOS-bundle packages like google-cloud-sdk.
    /^brew install (--cask )?[a-z0-9._/@+-]+$/i,
    /^brew tap [a-z0-9._/@+-]+$/i,
    /^uv tool install [@a-z0-9._/-]+$/i,
    /^pipx install [@a-z0-9._/-]+$/i,
    /^python3 -m pip install --user [@a-z0-9._/-]+$/i,
    /^git clone https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+(\.git)?( [a-z0-9._~/-]+)?$/i,
  ];
  if (!allowed.some((pattern) => pattern.test(normalized))) {
    return {
      ok: false,
      error: [
        'Unsupported install command.',
        'Allowed forms: npm install -g <package>, brew install <formula>, brew tap <tap>, uv tool install <package>, pipx install <package>, python3 -m pip install --user <package>, git clone https://github.com/org/repo [path].',
      ].join(' '),
    };
  }
  // Keep obviously dangerous npm package flags out of this no-terminal path.
  if (lower.includes('--unsafe-perm') || lower.includes('--force')) {
    return { ok: false, error: 'Unsafe install flags are not allowed from the dashboard installer.' };
  }
  return { ok: true, normalized };
}

export function startApprovedInstallCommand(command: string, title = 'Install capability'): InstallJob {
  const checked = validateInstallCommand(command);
  if (!checked.ok) throw new Error(checked.error);
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const job: InstallJob = {
    id,
    recipeId: 'custom-install',
    title,
    status: 'running',
    command: checked.normalized,
    output: '',
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);

  const shell = shellCommand(checked.normalized);
  const child = spawn(shell.command, shell.args, {
    cwd: os.homedir(),
    env: browserHarnessEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { job.output = truncate(job.output + String(chunk)); });
  child.stderr.on('data', (chunk) => { job.output = truncate(job.output + String(chunk)); });
  child.on('error', (error) => {
    job.status = 'failed';
    job.output = truncate(job.output + error.message);
    job.completedAt = new Date().toISOString();
    job.exitCode = -1;
  });
  child.on('close', (code) => {
    job.status = code === 0 ? 'succeeded' : 'failed';
    job.completedAt = new Date().toISOString();
    job.exitCode = code;
    // A successful install (brew/npm/uv/pipx/git clone) almost always
    // adds something to $PATH or a directory we probe. Bust the CLI
    // cache so the agent and dashboard see the new tool immediately
    // instead of waiting for the 10-min TTL.
    if (code === 0) invalidateCliScan();
  });
  return job;
}

export async function runBrowserHarnessDoctor(): Promise<CommandResult> {
  return runShell('browser-harness --doctor', { timeoutMs: 20_000 });
}

export async function runBrowserHarnessScript(code: string, options: { timeoutMs?: number; buName?: string } = {}): Promise<CommandResult> {
  const store = await getSecretStore();
  const cloudKey = await store.get('browser_use_api_key');
  const env = browserHarnessEnv({
    ...(cloudKey.value ? { BROWSER_USE_API_KEY: cloudKey.value } : {}),
    ...(options.buName ? { BU_NAME: options.buName } : {}),
  });
  return runShell('browser-harness', {
    timeoutMs: Math.max(2_000, Math.min(120_000, options.timeoutMs ?? 30_000)),
    env,
    stdin: code.endsWith('\n') ? code : `${code}\n`,
  });
}

export async function runBrowserHarnessSmokeTest(): Promise<CommandResult> {
  return runBrowserHarnessScript([
    'print(page_info())',
  ].join('\n'), { timeoutMs: 20_000 });
}

export async function openChromeRemoteDebuggingSetup(): Promise<CommandResult> {
  if (process.platform === 'darwin') {
    return runShell(`osascript -e 'tell application "Google Chrome" to activate' -e 'tell application "Google Chrome" to open location "chrome://inspect/#remote-debugging"'`, { timeoutMs: 5_000 });
  }
  return {
    ok: false,
    command: 'open chrome://inspect/#remote-debugging',
    code: 1,
    stdout: '',
    stderr: 'Open chrome://inspect/#remote-debugging in Chrome and enable remote debugging for this profile.',
    output: 'Open chrome://inspect/#remote-debugging in Chrome and enable remote debugging for this profile.',
  };
}
