import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSecretStore } from '../runtime/secrets/index.js';
import { invalidateCachedScan as invalidateCliScan, resolveSafeCliProbe } from '../runtime/cli-discovery.js';

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
  metadata?: Record<string, string>;
  connectedRecorded?: boolean;
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

/**
 * Where a learned per-site playbook lives. The harness reads this directory
 * itself when BH_DOMAIN_SKILLS is on, so a skill written here is loaded by the
 * harness on the NEXT visit without Clementine having to recall or replay it.
 */
export const BROWSER_HARNESS_DOMAIN_SKILLS_DIR = path.join(
  BROWSER_HARNESS_DIR,
  'agent-workspace',
  'domain-skills',
);

export function browserHarnessEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: extraPath(),
    // ON by default. The harness ships this off because a stranger's playbook
    // is an unknown instruction source — but Clementine's own domain skills are
    // written from HER verified runs, and a playbook nobody reads cannot teach
    // anything. Without this the learn half is write-only.
    BH_DOMAIN_SKILLS: '1',
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
  const result = process.platform === 'win32'
    ? spawnSync('where', [command], {
        encoding: 'utf-8',
        env: browserHarnessEnv(),
        timeout: 2_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    : spawnSync('/bin/sh', ['-lc', `command -v ${command}`], {
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
  const safe = found ? resolveSafeCliProbe(name, found) : null;
  return {
    name,
    available: Boolean(safe && !safe.skipped),
    path: safe?.path ?? found,
    version: safe && !safe.skipped ? commandVersion(safe.command, versionArgs) : safe?.reason,
  };
}

export function browserHarnessInstallCommand(): string {
  return [
    'set -e',
    'GIT_BINARY=""',
    'if command -v git >/dev/null 2>&1 && [ "$(command -v git)" != "/usr/bin/git" ]; then GIT_BINARY="$(command -v git)"; fi',
    'if [ -z "$GIT_BINARY" ] && [ -x /Library/Developer/CommandLineTools/usr/bin/git ]; then GIT_BINARY=/Library/Developer/CommandLineTools/usr/bin/git; fi',
    'if [ -z "$GIT_BINARY" ] && [ -x /Applications/Xcode.app/Contents/Developer/usr/bin/git ]; then GIT_BINARY=/Applications/Xcode.app/Contents/Developer/usr/bin/git; fi',
    'if [ -z "$GIT_BINARY" ]; then echo "Git is required before installing Browser Harness. Install Xcode Command Line Tools or Git, then retry."; exit 2; fi',
    'if ! command -v uv >/dev/null 2>&1; then echo "uv is required before installing Browser Harness. Install uv first: https://docs.astral.sh/uv/getting-started/installation/"; exit 2; fi',
    'mkdir -p "$HOME/Developer"',
    `if [ ! -d "${BROWSER_HARNESS_DIR}/.git" ]; then "$GIT_BINARY" clone ${BROWSER_HARNESS_REPO_URL} "${BROWSER_HARNESS_DIR}"; else cd "${BROWSER_HARNESS_DIR}" && "$GIT_BINARY" pull --ff-only; fi`,
    `cd "${BROWSER_HARNESS_DIR}"`,
    'uv tool install -e .',
    'mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills/browser-harness"',
    'ln -sf "$PWD/SKILL.md" "${CODEX_HOME:-$HOME/.codex}/skills/browser-harness/SKILL.md"',
    // Clementine reads her OWN skills directory, not Codex's. Linking only the
    // Codex copy is why the model saw a one-line helper list instead of the
    // real API contract and its per-mechanic guides. A symlink means a later
    // `git pull` updates the skill for free.
    'mkdir -p "${CLEMENTINE_HOME:-$HOME/.clementine-next}/skills/browser-harness"',
    'ln -sf "$PWD/SKILL.md" "${CLEMENTINE_HOME:-$HOME/.clementine-next}/skills/browser-harness/SKILL.md"',
    'command -v browser-harness',
    'browser-harness --version',
  ].join('\n');
}

export async function getBrowserHarnessStatus(): Promise<BrowserHarnessStatus> {
  const command = commandPath('browser-harness');
  const safeCommand = command ? resolveSafeCliProbe('browser-harness', command) : null;
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
    commandPath: safeCommand?.path ?? command,
    version: safeCommand && !safeCommand.skipped ? commandVersion(safeCommand.command, ['--version']) : undefined,
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

export function startApprovedInstallCommand(command: string, title = 'Install capability', metadata?: Record<string, string>): InstallJob {
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
    metadata,
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

/**
 * Upgrade in place using the harness's OWN updater.
 *
 * Deliberately not the install command's `git pull` + reinstall: `--update -y`
 * also restarts the daemon, which is the step a manual pull leaves undone — an
 * upgraded binary talking to a running old daemon is a worse state than being
 * out of date. The harness prints this exact remedy in its own output when it
 * detects a new version; running what it asked for is the whole point.
 */
export async function runBrowserHarnessUpdate(): Promise<CommandResult> {
  // MACOS WILL BREAK THIS UPDATE UNLESS WE CLEAR ITS OWN LITTER FIRST.
  // The harness refuses to update when the checkout is dirty, and upstream has
  // no .gitignore entry for .DS_Store — which Finder creates the instant anyone
  // opens the folder. So a file the OS wrote by itself blocks every upgrade,
  // for every Mac user, forever (live 2026-08-14: `?? .DS_Store` was the ONLY
  // change in the tree). Excluding it locally via .git/info/exclude leaves
  // upstream's tracked files untouched, so this cannot conflict on a later
  // pull; deleting the artifacts is safe because Finder regenerates them.
  //
  // Deliberately narrow: only known OS metadata is removed. A user's real
  // untracked file still blocks the update, and it should — that is a genuine
  // "you have local work here" signal, not litter.
  await runShell(
    [
      `cd "${BROWSER_HARNESS_DIR}" 2>/dev/null || exit 0`,
      'mkdir -p .git/info',
      'touch .git/info/exclude',
      'grep -qxF ".DS_Store" .git/info/exclude || echo ".DS_Store" >> .git/info/exclude',
      'grep -qxF "._*" .git/info/exclude || echo "._*" >> .git/info/exclude',
      'find . -name ".DS_Store" -maxdepth 3 -delete 2>/dev/null || true',
    ].join('\n'),
    { timeoutMs: 20_000 },
  );
  return runShell('browser-harness --update -y', { timeoutMs: 300_000 });
}

/** Parse the harness's own "update available: 0.1.0 -> 0.1.8" notice out of any
 *  command output. The harness is the authority on its own freshness; we do not
 *  keep a version list to go stale beside it. */
export function browserHarnessUpdateNotice(output: string): { from: string; to: string } | null {
  const match = /update available:\s*([0-9][\w.-]*)\s*->\s*([0-9][\w.-]*)/i.exec(output ?? '');
  return match ? { from: match[1]!, to: match[2]! } : null;
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

// ─── Learned per-site playbooks ────────────────────────────────────────────
//
// The unlock this serves: a user teaches Clementine to do one thing on one
// site, and she can do it again reliably. The harness already looks for
// per-site playbooks before improvising; nothing was ever writing them, so
// every visit re-derived the same navigation from scratch.
//
// These are FILES, deliberately. A playbook that survives a daemon restart, is
// readable by the user, and is loaded by the harness itself needs no recall
// step, no embedding, and no replay engine — the memory is the artifact.

/** A site key is a directory name, so it must never escape the skills dir. */
export function browserDomainSkillSite(raw: string): string | null {
  const site = raw.trim().toLowerCase()
    // Accept a URL, a host, or an already-clean slug and normalize to a host.
    .replace(/^[a-z]+:\/\//, '')
    .split('/')[0]!
    .replace(/^www\./, '')
    .replace(/[^a-z0-9.-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  if (!site || site.length > 80 || site.includes('..')) return null;
  return site;
}

/** A task name becomes the filename; same containment rule. */
export function browserDomainSkillTask(raw: string): string | null {
  const task = raw.trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!task || task.length > 80) return null;
  return task;
}

export interface WriteDomainSkillResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/**
 * Record what worked on a site so the harness starts from it next time.
 *
 * Refuses to write outside the skills directory even if the caller's site or
 * task normalizes to something unexpected: the final resolved path is checked
 * against the root, so a containment bug in the slug rules cannot become a
 * filesystem write.
 */
export function writeBrowserDomainSkill(input: {
  site: string;
  task: string;
  markdown: string;
}): WriteDomainSkillResult {
  const site = browserDomainSkillSite(input.site);
  if (!site) return { ok: false, error: 'A site is required (a host like "amazon.com" or a URL).' };
  const task = browserDomainSkillTask(input.task);
  if (!task) return { ok: false, error: 'A task name is required (e.g. "export-monthly-report").' };
  const body = input.markdown.trim();
  if (!body) return { ok: false, error: 'The playbook body is empty.' };
  if (body.length > 40_000) return { ok: false, error: 'The playbook is too large (40k character limit).' };
  if (!existsSync(BROWSER_HARNESS_DIR)) {
    return { ok: false, error: 'Browser Harness is not installed, so there is nowhere to save this.' };
  }

  const root = path.resolve(BROWSER_HARNESS_DOMAIN_SKILLS_DIR);
  const target = path.resolve(root, site, `${task}.md`);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return { ok: false, error: 'Refusing to write outside the domain-skills directory.' };
  }
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    // Stamp provenance. The community playbooks carry a field-tested date, and
    // a reader deserves to know whether a step was proven or merely proposed.
    const stamped = body.startsWith('#')
      ? `${body}\n\n_Learned by Clementine from a verified run on ${new Date().toISOString().slice(0, 10)}._\n`
      : `# ${site} — ${task.replace(/-/g, ' ')}\n\n${body}\n\n_Learned by Clementine from a verified run on ${new Date().toISOString().slice(0, 10)}._\n`;
    writeFileSync(target, stamped, 'utf-8');
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Playbooks already learned for a site, newest first. */
export function listBrowserDomainSkills(site?: string): Array<{ site: string; task: string; path: string }> {
  const root = BROWSER_HARNESS_DOMAIN_SKILLS_DIR;
  if (!existsSync(root)) return [];
  const wanted = site ? browserDomainSkillSite(site) : null;
  const out: Array<{ site: string; task: string; path: string }> = [];
  try {
    for (const dir of readdirSync(root)) {
      if (wanted && dir !== wanted) continue;
      const siteDir = path.join(root, dir);
      try {
        if (!lstatSync(siteDir).isDirectory()) continue;
        for (const file of readdirSync(siteDir)) {
          if (!file.endsWith('.md')) continue;
          out.push({ site: dir, task: file.replace(/\.md$/, ''), path: path.join(siteDir, file) });
        }
      } catch { /* an unreadable site dir is skipped, never fatal */ }
    }
  } catch { /* nothing learned yet */ }
  return out;
}

/**
 * The single next action that would make browsing work, or null when it already
 * does.
 *
 * Status used to report facts and leave the model to infer a remedy, so a
 * missing prerequisite became "tell the user to open Settings" — an errand for
 * a machine-fixable problem. Ordered by what blocks first: you cannot run the
 * harness without its prerequisites, cannot connect without Chrome debugging,
 * and a stale build is a real failure mode (a 3-month-old checkout is what sent
 * one live run hunting for a different tool entirely).
 */
export function browserHarnessNextAction(status: BrowserHarnessStatus): string | null {
  const missing = status.prerequisites.filter((p) => !p.available).map((p) => p.name);
  if (missing.length) {
    return `Missing prerequisite${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. `
      + 'These must be installed on the machine first — browser_harness_setup cannot install them. '
      + 'Tell the user exactly which one is missing and how to get it (uv: https://docs.astral.sh/uv/, git: Xcode Command Line Tools).';
  }
  if (!status.installed) {
    return 'Browser Harness is not installed. Call browser_harness_setup with action=install.';
  }
  if (!status.repoPresent) {
    return 'The Browser Harness checkout is missing, so it cannot be updated or repaired. Call browser_harness_setup with action=install.';
  }
  return null;
}
