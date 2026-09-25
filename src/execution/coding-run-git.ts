/**
 * Git facts and effects for a coding run: the isolated worktree the agent
 * works in, and the evidence its receipt is built from.
 *
 * The user's checkout is never touched. Each run gets its own worktree on its
 * own branch under Clem's home, cut from the commit the project was on when the
 * run was admitted. Evidence is read from git, never from the agent's prose:
 * the commits on the run's branch past its base, the diff they add up to, and
 * anything left uncommitted.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { buildCodingAgentEnv } from './coding-run-env.js';
import type { CodingRunCommit, CodingRunDiffStat } from './coding-run-store.js';

const GIT_TIMEOUT_MS = 60_000;
const FALLBACK_AUTHOR = ['-c', 'user.name=Clementine', '-c', 'user.email=clementine@coding-run.invalid'];

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runGit(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...buildCodingAgentEnv(), GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

async function gitOut(args: string[], cwd: string): Promise<string | null> {
  const result = await runGit(args, cwd);
  return result.code === 0 ? result.stdout.trim() : null;
}

export interface ProjectRepoFacts {
  topLevel: string;
  commonDir: string;
  /** Null when the project is on a detached HEAD. */
  branch: string | null;
  headCommit: string;
}

/** Null when the folder is not inside a git repository with at least one commit. */
export async function readProjectRepo(projectPath: string): Promise<ProjectRepoFacts | null> {
  const topLevel = await gitOut(['rev-parse', '--show-toplevel'], projectPath);
  if (!topLevel) return null;
  const headCommit = await gitOut(['rev-parse', '--verify', 'HEAD'], topLevel);
  if (!headCommit) return null;
  const commonDirRaw = await gitOut(['rev-parse', '--git-common-dir'], topLevel);
  const commonDir = commonDirRaw ? path.resolve(topLevel, commonDirRaw) : path.join(topLevel, '.git');
  const branch = await gitOut(['symbolic-ref', '--quiet', '--short', 'HEAD'], topLevel);
  return { topLevel, commonDir, branch: branch || null, headCommit };
}

function slug(value: string, max: number): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return cleaned || 'task';
}

export function codingRunWorktreePath(projectName: string, runId: string): string {
  return path.join(BASE_DIR, 'worktrees', slug(projectName, 40), runId);
}

export function codingRunBranchName(objective: string, runId: string): string {
  const suffix = runId.replace(/^code-/, '').split('-').pop() ?? runId;
  return `clem/${slug(objective, 40)}-${suffix.slice(0, 8)}`;
}

export interface EnsureWorktreeInput {
  projectPath: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
}

/**
 * Create the run's worktree, or confirm the one a previous generation made.
 * Idempotent: a restart that re-enters this after a partial create reuses the
 * branch rather than failing on "already exists".
 */
export async function ensureRunWorktree(input: EnsureWorktreeInput): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (existsSync(input.worktreePath)) {
    const current = await gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], input.worktreePath);
    if (current === input.branch) return { ok: true };
    return { ok: false, reason: `${input.worktreePath} exists but is not on ${input.branch}` };
  }
  mkdirSync(path.dirname(input.worktreePath), { recursive: true });
  const branchExists = (await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${input.branch}`], input.projectPath)).code === 0;
  const args = branchExists
    ? ['worktree', 'add', input.worktreePath, input.branch]
    : ['worktree', 'add', '-b', input.branch, input.worktreePath, input.baseCommit];
  const result = await runGit(args, input.projectPath);
  if (result.code !== 0) {
    return { ok: false, reason: (result.stderr || result.stdout).trim().slice(0, 400) || 'git worktree add failed' };
  }
  return { ok: true };
}

export interface GitEvidence {
  headCommit: string | null;
  commits: CodingRunCommit[];
  diffStat: CodingRunDiffStat;
  dirtyFiles: string[];
}

const EMPTY_DIFF: CodingRunDiffStat = { filesChanged: 0, insertions: 0, deletions: 0, files: [] };

export async function readGitEvidence(worktreePath: string, baseCommit: string | null): Promise<GitEvidence> {
  const headCommit = await gitOut(['rev-parse', 'HEAD'], worktreePath);
  const commits: CodingRunCommit[] = [];
  let diffStat: CodingRunDiffStat = { ...EMPTY_DIFF, files: [] };
  if (baseCommit && headCommit && headCommit !== baseCommit) {
    const log = await gitOut(['log', '--reverse', '--format=%H%x09%s', `${baseCommit}..HEAD`], worktreePath);
    for (const line of (log ?? '').split('\n')) {
      const tab = line.indexOf('\t');
      if (tab <= 0) continue;
      commits.push({ sha: line.slice(0, tab), subject: line.slice(tab + 1).slice(0, 200) });
    }
    const numstat = await gitOut(['diff', '--numstat', `${baseCommit}..HEAD`], worktreePath);
    for (const line of (numstat ?? '').split('\n')) {
      const [added, removed, ...rest] = line.split('\t');
      const file = rest.join('\t');
      if (!file) continue;
      diffStat.filesChanged += 1;
      diffStat.insertions += Number(added) || 0;
      diffStat.deletions += Number(removed) || 0;
      if (diffStat.files.length < 200) diffStat.files.push(file);
    }
  }
  const porcelain = await gitOut(['status', '--porcelain', '--untracked-files=all'], worktreePath);
  const dirtyFiles = (porcelain ?? '')
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .slice(0, 200);
  return { headCommit, commits, diffStat, dirtyFiles };
}

/**
 * Commit whatever the agent left uncommitted on the run's own branch, so the
 * branch alone is the complete deliverable. Uses the repository's identity;
 * a repository with none gets a reserved placeholder rather than a failure.
 * The repository's own commit hooks still run: when they refuse, the files
 * stay uncommitted and the receipt says so.
 */
export async function commitLeftovers(worktreePath: string, message: string): Promise<boolean> {
  const add = await runGit(['add', '--all'], worktreePath);
  if (add.code !== 0) return false;
  const staged = await runGit(['diff', '--cached', '--quiet'], worktreePath);
  if (staged.code === 0) return false;
  const hasIdentity = Boolean(await gitOut(['config', 'user.email'], worktreePath));
  const commit = await runGit([...(hasIdentity ? [] : FALLBACK_AUTHOR), 'commit', '-m', message], worktreePath);
  return commit.code === 0;
}

export interface TestRunResult {
  exitCode: number | null;
  timedOut: boolean;
  tail: string;
  durationMs: number;
}

export const CODING_RUN_TEST_TIMEOUT_MS = 10 * 60_000;

/**
 * Run the run's test command in its worktree, as the host — the agent's own
 * claim that tests pass is not evidence. Its process group is killed on
 * timeout so a hung watcher cannot outlive the check.
 */
export function runTestCommand(command: string, worktreePath: string, timeoutMs = CODING_RUN_TEST_TIMEOUT_MS): Promise<TestRunResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let tail = '';
    let timedOut = false;
    const append = (chunk: Buffer): void => { tail = (tail + chunk.toString('utf-8')).slice(-8_000); };
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: worktreePath,
      env: { ...buildCodingAgentEnv(), CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut, tail: `${tail}\n${error.message}`.slice(-8_000), durationMs: Date.now() - startedAt });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? null : code, timedOut, tail, durationMs: Date.now() - startedAt });
    });
  });
}
