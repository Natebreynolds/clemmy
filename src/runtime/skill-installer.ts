import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverSkillsInRepo,
  installSkillFromDir,
  type Skill,
} from '../memory/skill-store.js';
import { getGitHubCliStatus } from '../integrations/github-cli.js';

/**
 * Skill installer — clones a public Git repo into a temp dir, scans
 * for SKILL.md skills (single, bundled under skills/, or Claude
 * convention under .claude/skills/), and installs each one into
 * ~/.clementine-next/skills/. Cleans up the temp clone afterward.
 *
 * Async + status-pollable so the dashboard can stream "cloning →
 * discovered N skills → copying → done" without holding the request.
 */

export type SkillInstallStatus = 'queued' | 'cloning' | 'discovering' | 'installing' | 'succeeded' | 'failed';

export interface SkillInstallJob {
  id: string;
  source: string;            // the URL the user submitted
  normalizedUrl: string;     // sanitized git URL we actually cloned
  status: SkillInstallStatus;
  output: string;            // captured stdout/stderr from git
  startedAt: string;
  completedAt?: string;
  installed: Array<{ name: string; pathInRepo: string }>;
  error?: string;
  sha?: string;
  cloneMethod?: 'git' | 'gh';
}

const jobs = new Map<string, SkillInstallJob>();

function newJobId(): string {
  return `skill-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function appendOutput(job: SkillInstallJob, chunk: string): void {
  const next = job.output + chunk;
  // Cap output to keep memory bounded.
  job.output = next.length > 30_000 ? next.slice(next.length - 30_000) : next;
}

/**
 * Accept https://github.com/owner/repo[.git] and git@github.com:owner/repo[.git].
 * Reject anything else — we only support public Git URLs.
 *
 * Returns the normalized clone URL plus the inferred "repo basename"
 * (used as the default install name for single-SKILL.md repos).
 */
export function normalizeRepoUrl(input: string): { url: string; basename: string; owner?: string; repo?: string } {
  const trimmed = (input || '').trim();
  if (!trimmed) throw new Error('Empty repo URL');
  if (trimmed.length > 400) throw new Error('Repo URL too long');

  // https://github.com/owner/repo[.git][/]
  let m = trimmed.match(/^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/);
  if (m) {
    const owner = m[1];
    const repo = m[2];
    return { url: `https://github.com/${owner}/${repo}.git`, basename: repo, owner, repo };
  }
  // git@github.com:owner/repo[.git]
  m = trimmed.match(/^git@github\.com:([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/);
  if (m) {
    const owner = m[1];
    const repo = m[2];
    return { url: `git@github.com:${owner}/${repo}.git`, basename: repo, owner, repo };
  }
  throw new Error('Unsupported URL — paste a GitHub repo URL like https://github.com/owner/repo');
}

function runGit(args: string[], cwd: string, onChunk: (s: string) => void, timeoutMs: number): Promise<{ code: number }> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b: Buffer) => onChunk(b.toString('utf-8')));
    child.stderr.on('data', (b: Buffer) => onChunk(b.toString('utf-8')));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (_) { /* noop */ }
      onChunk(`\n[git timed out after ${timeoutMs}ms]\n`);
      resolve({ code: 124 });
    }, timeoutMs);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onChunk(`\n[git spawn error: ${err.message}]\n`);
      resolve({ code: -1 });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1 });
    });
  });
}

async function readGitSha(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (b: Buffer) => { out += b.toString('utf-8'); });
    child.on('close', (code) => resolve(code === 0 ? out.trim() : undefined));
    child.on('error', () => resolve(undefined));
  });
}

/**
 * Kick off an install. Returns the job record immediately; the actual
 * work happens in the background. Poll via getSkillInstallJob(id).
 */
export function startSkillInstall(rawUrl: string): SkillInstallJob {
  const { url, basename, owner, repo } = normalizeRepoUrl(rawUrl);
  const id = newJobId();
  const job: SkillInstallJob = {
    id,
    source: rawUrl,
    normalizedUrl: url,
    status: 'queued',
    output: '',
    startedAt: new Date().toISOString(),
    installed: [],
  };
  jobs.set(id, job);

  void runInstall(job, url, basename, owner && repo ? `${owner}/${repo}` : undefined).catch((err) => {
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
    job.completedAt = new Date().toISOString();
    appendOutput(job, `\n[install crashed: ${job.error}]\n`);
  });
  return job;
}

async function runInstall(job: SkillInstallJob, url: string, basename: string, ghRepo?: string): Promise<void> {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'clemmy-skill-install-'));
  try {
    job.status = 'cloning';
    appendOutput(job, `Cloning ${url} into ${tmpRoot}…\n`);

    let cloneResult: { code: number };
    const ghStatus = ghRepo ? await getGitHubCliStatus().catch(() => null) : null;
    if (ghRepo && ghStatus?.installed && ghStatus.authenticated) {
      job.cloneMethod = 'gh';
      appendOutput(job, `Using authenticated GitHub CLI for ${ghRepo} (private repos supported).\n`);
      cloneResult = await runGitHubClone(ghStatus.path || 'gh', ghRepo, tmpRoot, (s) => appendOutput(job, s), 90_000);
    } else {
      job.cloneMethod = 'git';
      if (ghRepo && ghStatus?.installed && !ghStatus.authenticated) {
        appendOutput(job, `GitHub CLI is installed but not authenticated; falling back to public git clone. Private repos need GitHub CLI login in Integrations.\n`);
      }
      cloneResult = await runGit(
        ['clone', '--depth=1', '--single-branch', '--', url, '.'],
        tmpRoot,
        (s) => appendOutput(job, s),
        60_000,
      );
    }
    if (cloneResult.code !== 0) {
      job.status = 'failed';
      job.error = `git clone exited with code ${cloneResult.code}`;
      job.completedAt = new Date().toISOString();
      return;
    }
    job.sha = await readGitSha(tmpRoot);
    appendOutput(job, `\nCloned at SHA ${job.sha ?? '(unknown)'}\n`);

    job.status = 'discovering';
    const discovered = discoverSkillsInRepo(tmpRoot, basename);
    if (discovered.length === 0) {
      job.status = 'failed';
      job.error = 'No SKILL.md found in repo (looked at root, skills/, and .claude/skills/).';
      job.completedAt = new Date().toISOString();
      appendOutput(job, `\nNo skills found. A valid skill repo has SKILL.md at the root or inside a skills/<name>/ folder.\n`);
      return;
    }
    appendOutput(job, `\nDiscovered ${discovered.length} skill${discovered.length === 1 ? '' : 's'}:\n`);
    for (const d of discovered) appendOutput(job, `  - ${d.installName} (${d.pathInRepo || 'root'})\n`);

    job.status = 'installing';
    const installed: Skill[] = [];
    for (const d of discovered) {
      try {
        const skill = installSkillFromDir(d.sourceDir, d.installName, {
          repo: url,
          pathInRepo: d.pathInRepo,
          sha: job.sha,
        });
        installed.push(skill);
        job.installed.push({ name: skill.name, pathInRepo: d.pathInRepo });
        appendOutput(job, `Installed: ${skill.name}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendOutput(job, `Skipped ${d.installName}: ${msg}\n`);
      }
    }

    if (installed.length === 0) {
      job.status = 'failed';
      job.error = 'Discovered skills but none could be installed (see output).';
    } else {
      job.status = 'succeeded';
      appendOutput(job, `\nDone — ${installed.length} skill${installed.length === 1 ? '' : 's'} now active.\n`);
    }
    job.completedAt = new Date().toISOString();
  } finally {
    // Always clean up the temp clone, even on failure.
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

function runGitHubClone(binary: string, repo: string, cwd: string, onChunk: (s: string) => void, timeoutMs: number): Promise<{ code: number }> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(binary, ['repo', 'clone', repo, '.', '--', '--depth=1', '--single-branch'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (b: Buffer) => onChunk(b.toString('utf-8')));
    child.stderr.on('data', (b: Buffer) => onChunk(b.toString('utf-8')));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (_) { /* noop */ }
      onChunk(`\n[gh repo clone timed out after ${timeoutMs}ms]\n`);
      resolve({ code: 124 });
    }, timeoutMs);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onChunk(`\n[gh spawn error: ${err.message}]\n`);
      resolve({ code: -1 });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1 });
    });
  });
}

export function getSkillInstallJob(id: string): SkillInstallJob | undefined {
  return jobs.get(id);
}

export function listRecentSkillInstallJobs(): SkillInstallJob[] {
  return Array.from(jobs.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
