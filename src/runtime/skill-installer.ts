import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverSkillsInRepo,
  installSkillFromDir,
  listSkills,
  loadSkill,
  recordSkillUpdateCheck,
  type Skill,
} from '../memory/skill-store.js';
import { getGitHubCliStatus, runGitHubCli } from '../integrations/github-cli.js';
import { findSafeCliCommand } from './cli-discovery.js';

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
  /**
   * 'install' (default) installs every skill discovered in the repo;
   * 'update' re-pulls a single already-installed skill (scoped to its
   * recorded pathInRepo) so siblings the user uninstalled aren't
   * resurrected.
   */
  mode?: 'install' | 'update';
  /** For mode==='update': the skill being refreshed. */
  target?: string;
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
 * Resolve a user-supplied skill reference into a clone URL.
 *
 * Accepted shapes (all resolve to a github.com clone URL):
 *   1. https://github.com/owner/repo[.git][/]
 *   2. git@github.com:owner/repo[.git]
 *   3. owner/repo                                  — shorthand
 *   4. npx skills add owner/repo                   — pasted verbatim
 *      from a marketing page (e.g. usehallmark.com)
 *
 * Form (4) is purely UX sugar — many skill landing pages now publish
 * "npx skills add nutlope/hallmark"-style commands, and we don't want
 * users to have to translate that into a GitHub URL by hand. We strip
 * the prefix and treat the remainder as form (3).
 *
 * Anything else throws with an honest hint.
 *
 * Returns the normalized clone URL plus the inferred "repo basename"
 * (used as the default install name for single-SKILL.md repos).
 */
export function normalizeRepoUrl(input: string): { url: string; basename: string; owner?: string; repo?: string } {
  let trimmed = (input || '').trim();
  if (!trimmed) throw new Error('Empty repo URL');
  if (trimmed.length > 400) throw new Error('Repo URL too long');

  // (4) "npx skills add owner/repo" — peel the prefix and fall through.
  // Tolerate "npx -y skills add ...", "npx skills add @scope/repo",
  // "pnpm dlx skills add ...", and "bunx skills add ..." for the same
  // reason: copy-paste shouldn't care about the package manager.
  const dlxPrefix = /^(?:npx(?:\s+-y)?|pnpm\s+dlx|yarn\s+dlx|bunx)\s+skills\s+add\s+/i;
  if (dlxPrefix.test(trimmed)) {
    trimmed = trimmed.replace(dlxPrefix, '').trim();
  }

  // (1) https://github.com/owner/repo[.git][/]
  let m = trimmed.match(/^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/);
  if (m) {
    const owner = m[1];
    const repo = m[2];
    return { url: `https://github.com/${owner}/${repo}.git`, basename: repo, owner, repo };
  }
  // (2) git@github.com:owner/repo[.git]
  m = trimmed.match(/^git@github\.com:([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/);
  if (m) {
    const owner = m[1];
    const repo = m[2];
    return { url: `git@github.com:${owner}/${repo}.git`, basename: repo, owner, repo };
  }
  // (3) owner/repo shorthand. Allow a single optional leading "@" so
  // pastes like "@nutlope/hallmark" still resolve. Reject anything that
  // doesn't look like exactly one "/" with sane segments — we don't
  // want to silently accept "foo" (no owner) or "a/b/c" (subpath).
  m = trimmed.match(/^@?([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/);
  if (m) {
    const owner = m[1];
    const repo = m[2];
    return { url: `https://github.com/${owner}/${repo}.git`, basename: repo, owner, repo };
  }
  throw new Error(
    'Unsupported reference. Accepted formats:\n' +
    '  • https://github.com/owner/repo\n' +
    '  • git@github.com:owner/repo\n' +
    '  • owner/repo (shorthand)\n' +
    '  • npx skills add owner/repo (the command from skill marketing pages)',
  );
}

/**
 * Env for spawning git in automation: never prompt for credentials or
 * host-key confirmation, and fail fast on SSH so a misconfigured key
 * can't hang behind our timeout. Applied to every git spawn here — the
 * installer runs headless under the daemon, where an interactive prompt
 * would mean a guaranteed (bounded) stall.
 */
function nonInteractiveGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new',
  };
}

function runGit(args: string[], cwd: string, onChunk: (s: string) => void, timeoutMs: number): Promise<{ code: number }> {
  return new Promise((resolve) => {
    const git = findSafeCliCommand('git');
    if (!git || git.skipped) {
      const reason = git?.skipped ? git.reason : 'git was not found on PATH.';
      onChunk(`\n[git unavailable: ${reason} Install Xcode Command Line Tools or a standalone Git binary, then retry.]\n`);
      resolve({ code: 127 });
      return;
    }
    let settled = false;
    const child = spawn(git.command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: nonInteractiveGitEnv() });
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
    const git = findSafeCliCommand('git');
    if (!git || git.skipped) {
      resolve(undefined);
      return;
    }
    let out = '';
    const child = spawn(git.command, ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], env: nonInteractiveGitEnv() });
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

async function runInstall(
  job: SkillInstallJob,
  url: string,
  basename: string,
  ghRepo?: string,
  // When set (mode==='update'), install ONLY the discovered skill whose
  // pathInRepo matches — re-pulling one skill from a bundled repo without
  // touching its siblings.
  filter?: { pathInRepo: string; installName: string },
): Promise<void> {
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
    let discovered = discoverSkillsInRepo(tmpRoot, basename);
    if (discovered.length === 0) {
      job.status = 'failed';
      job.error = 'No SKILL.md found in repo (looked at root, skills/, and .claude/skills/).';
      job.completedAt = new Date().toISOString();
      appendOutput(job, `\nNo skills found. A valid skill repo has SKILL.md at the root or inside a skills/<name>/ folder.\n`);
      return;
    }

    // Update mode: narrow to the single skill we're refreshing. Match on
    // pathInRepo (the stable identifier across re-clones); fall back to
    // installName so a root-level skill renamed at install time still
    // resolves. If the path vanished upstream, fail loudly rather than
    // silently reinstalling a sibling.
    if (filter) {
      const wantPath = filter.pathInRepo || '';
      const match = discovered.find((d) => (d.pathInRepo || '') === wantPath)
        ?? discovered.find((d) => d.installName === filter.installName);
      if (!match) {
        job.status = 'failed';
        job.error = `Skill "${filter.installName}" (path "${wantPath || 'root'}") was not found in the repo at HEAD — it may have been moved or removed upstream.`;
        job.completedAt = new Date().toISOString();
        appendOutput(job, `\n${job.error}\n`);
        return;
      }
      // Pin the install name to what's already on disk so the update
      // overwrites the existing skill rather than creating a renamed copy.
      discovered = [{ ...match, installName: filter.installName }];
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
      const verb = job.mode === 'update' ? 'updated' : 'now active';
      appendOutput(job, `\nDone — ${installed.length} skill${installed.length === 1 ? '' : 's'} ${verb}.\n`);
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

/**
 * Re-pull a single installed skill from its recorded source repo. The
 * upgrade path is identical to install (clone → discover → overwrite),
 * scoped to this skill's pathInRepo so siblings the user uninstalled
 * aren't resurrected. A successful run rewrites .clementine-source.json
 * with the fresh sha, which clears any "update available" flag.
 *
 * Returns the job immediately; poll via getSkillInstallJob(id) — the
 * same map the install flow uses.
 */
export function startSkillUpdate(name: string): SkillInstallJob {
  const skill = loadSkill(name);
  if (!skill) throw new Error(`Skill not found: ${name}`);
  const repo = skill.source?.repo;
  if (!repo) {
    throw new Error(`Skill "${name}" has no recorded source repo. Reinstall it from GitHub to enable updates.`);
  }
  const { url, basename, owner, repo: repoName } = normalizeRepoUrl(repo);
  const id = newJobId();
  const job: SkillInstallJob = {
    id,
    source: repo,
    normalizedUrl: url,
    status: 'queued',
    output: '',
    startedAt: new Date().toISOString(),
    installed: [],
    mode: 'update',
    target: name,
  };
  jobs.set(id, job);

  void runInstall(
    job,
    url,
    basename,
    owner && repoName ? `${owner}/${repoName}` : undefined,
    { pathInRepo: skill.source?.pathInRepo ?? '', installName: name },
  ).catch((err) => {
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
    job.completedAt = new Date().toISOString();
    appendOutput(job, `\n[update crashed: ${job.error}]\n`);
  });
  return job;
}

export interface SkillUpdateStatus {
  name: string;
  repo?: string;
  /** SHA recorded at install time (baseline). */
  installedSha?: string;
  /** Remote default-branch HEAD SHA, undefined when the check failed. */
  remoteSha?: string;
  updateAvailable: boolean;
  checkedAt: string;
  /** Populated when the remote SHA couldn't be resolved. */
  error?: string;
}

export interface SkillUpdateSummary {
  checkedAt: string;
  results: SkillUpdateStatus[];
  /** Names of skills with a newer upstream commit. */
  updatesAvailable: string[];
}

/**
 * Resolve the remote default-branch HEAD SHA WITHOUT cloning.
 *
 * Primary path: `git ls-remote <url> HEAD` — one cheap network round
 * trip, works for any public repo with no auth. Fallback for private
 * repos: the authenticated GitHub CLI's commits API. Returns undefined
 * when neither path yields a SHA (offline, gone, private + no gh auth).
 */
export async function getRemoteHeadSha(repoUrl: string): Promise<string | undefined> {
  let normalized: { url: string; owner?: string; repo?: string };
  try {
    const n = normalizeRepoUrl(repoUrl);
    normalized = { url: n.url, owner: n.owner, repo: n.repo };
  } catch {
    return undefined;
  }

  const lsRemote = await gitLsRemoteHead(normalized.url);
  if (lsRemote) return lsRemote;

  // Fallback: private repo over the authenticated GitHub CLI.
  if (normalized.owner && normalized.repo) {
    const ghStatus = await getGitHubCliStatus().catch(() => null);
    if (ghStatus?.installed && ghStatus.authenticated) {
      const res = await runGitHubCli(
        ['api', `repos/${normalized.owner}/${normalized.repo}/commits?per_page=1`, '--jq', '.[0].sha'],
        20_000,
      ).catch(() => null);
      const sha = res?.ok ? res.stdout.trim() : '';
      if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha;
    }
  }
  return undefined;
}

function gitLsRemoteHead(url: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const git = findSafeCliCommand('git');
    if (!git || git.skipped) {
      resolve(undefined);
      return;
    }
    let settled = false;
    let out = '';
    // -q/--exit-code keeps noise down; HEAD resolves the remote's
    // default-branch tip without fetching any objects.
    const child = spawn(git.command, ['ls-remote', '--quiet', '--', url, 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: nonInteractiveGitEnv(),
    });
    child.stdout.on('data', (b: Buffer) => { out += b.toString('utf-8'); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      resolve(undefined);
    }, 20_000);
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) { resolve(undefined); return; }
      // Output: "<sha>\tHEAD". Take the first whitespace-delimited token.
      const sha = out.split(/\s+/)[0]?.trim() ?? '';
      resolve(/^[0-9a-f]{7,40}$/i.test(sha) ? sha : undefined);
    });
  });
}

/** True when both shas are known and differ — the honest signal. */
export function deriveUpdateAvailable(installedSha?: string, remoteSha?: string): boolean {
  return Boolean(installedSha && remoteSha && installedSha !== remoteSha);
}

/**
 * Check a single installed skill against its upstream and persist the
 * result into its source metadata. Cheap (one ls-remote). Skills with
 * no recorded source repo are reported as not-checkable.
 */
export async function checkSkillUpdate(name: string): Promise<SkillUpdateStatus> {
  const checkedAt = new Date().toISOString();
  const skill = loadSkill(name);
  if (!skill || !skill.source?.repo) {
    return { name, updateAvailable: false, checkedAt, error: 'no source repo recorded' };
  }
  const remoteSha = await getRemoteHeadSha(skill.source.repo);
  const updateAvailable = deriveUpdateAvailable(skill.source.sha, remoteSha);
  recordSkillUpdateCheck(name, { latestRemoteSha: remoteSha, updateAvailable, lastCheckedAt: checkedAt });
  return {
    name,
    repo: skill.source.repo,
    installedSha: skill.source.sha,
    remoteSha,
    updateAvailable,
    checkedAt,
    error: remoteSha ? undefined : 'could not resolve remote HEAD',
  };
}

/**
 * Check every installed skill that has a source repo. Dedupes the
 * network call by repo URL, so a bundled repo (e.g. taste-skill with 12
 * skills) costs ONE ls-remote, not twelve. Persists each result and
 * returns a summary the daily poll / dashboard can act on.
 */
export async function checkAllSkillUpdates(
  // Injectable for tests; production passes the real ls-remote resolver.
  resolveRemoteSha: (repoUrl: string) => Promise<string | undefined> = getRemoteHeadSha,
): Promise<SkillUpdateSummary> {
  const checkedAt = new Date().toISOString();
  const skills = listSkills().filter((s) => s.source?.repo);

  // Group by repo so we hit each remote once.
  const byRepo = new Map<string, Skill[]>();
  for (const s of skills) {
    const key = s.source!.repo!;
    const group = byRepo.get(key);
    if (group) group.push(s);
    else byRepo.set(key, [s]);
  }

  // Resolve every unique repo's HEAD concurrently so total wall-clock is
  // one timeout window, not the sum — a handful of unreachable repos
  // can't serialize into an N×20s stall on the request-synchronous
  // check-updates route. Unique-repo counts are tiny, so unbounded
  // fan-out is fine.
  const repoShas = new Map<string, string | undefined>(
    await Promise.all(
      [...byRepo.keys()].map(async (repo) => [repo, await resolveRemoteSha(repo)] as const),
    ),
  );

  const results: SkillUpdateStatus[] = [];
  for (const [repo, group] of byRepo) {
    const remoteSha = repoShas.get(repo);
    for (const s of group) {
      const updateAvailable = deriveUpdateAvailable(s.source?.sha, remoteSha);
      recordSkillUpdateCheck(s.name, { latestRemoteSha: remoteSha, updateAvailable, lastCheckedAt: checkedAt });
      results.push({
        name: s.name,
        repo,
        installedSha: s.source?.sha,
        remoteSha,
        updateAvailable,
        checkedAt,
        error: remoteSha ? undefined : 'could not resolve remote HEAD',
      });
    }
  }

  return {
    checkedAt,
    results: results.sort((a, b) => a.name.localeCompare(b.name)),
    updatesAvailable: results.filter((r) => r.updateAvailable).map((r) => r.name),
  };
}

export function getSkillInstallJob(id: string): SkillInstallJob | undefined {
  return jobs.get(id);
}

export function listRecentSkillInstallJobs(): SkillInstallJob[] {
  return Array.from(jobs.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
