import { spawn } from 'node:child_process';
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeRepoUrl } from './skill-installer.js';
import { findSafeCliCommand } from './cli-discovery.js';
import { WORKFLOWS_DIR } from '../memory/vault.js';
import {
  readWorkflow,
  readWorkflowDefinitionFile,
  type WorkflowDefinition,
} from '../memory/workflow-store.js';
import { prepareWorkflowCreateForWrite } from '../execution/workflow-authoring.js';
import { syncWorkflowTriggersBestEffort, writeWorkflowAndSyncTriggers } from '../execution/workflow-write.js';

export type WorkflowImportStatus = 'queued' | 'cloning' | 'discovering' | 'installing' | 'succeeded' | 'failed';

export interface WorkflowImportJob {
  id: string;
  source: string;
  normalizedSource: string;
  status: WorkflowImportStatus;
  startedAt: string;
  completedAt?: string;
  output: string;
  dryRun: boolean;
  overwrite: boolean;
  discovered: Array<{ name: string; pathInSource: string; description: string }>;
  installed: Array<{ name: string; pathInSource: string; filePath: string }>;
  skipped: Array<{ name: string; pathInSource: string; reason: string }>;
  error?: string;
  sha?: string;
}

interface WorkflowCandidate {
  name: string;
  sourceDir: string;
  skillPath: string;
  pathInSource: string;
  definition: WorkflowDefinition;
}

export interface WorkflowImportOptions {
  dryRun?: boolean;
  overwrite?: boolean;
}

const SOURCE_FILE = '.clementine-source.json';
const jobs = new Map<string, WorkflowImportJob>();

function newJobId(): string {
  return `workflow-import-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function appendOutput(job: WorkflowImportJob, chunk: string): void {
  const next = job.output + chunk;
  job.output = next.length > 30_000 ? next.slice(next.length - 30_000) : next;
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function safeWorkflowName(input: string, fallback: string): string {
  const raw = (input || fallback || 'workflow').trim().toLowerCase();
  const slug = raw
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'workflow';
}

function relativePath(root: string, filePath: string): string {
  const rel = path.relative(root, filePath);
  return rel && !rel.startsWith('..') ? rel : path.basename(filePath);
}

function discoverWorkflowCandidates(root: string): WorkflowCandidate[] {
  const roots = [
    { dir: root, singleRoot: true },
    { dir: path.join(root, 'workflows'), singleRoot: false },
    { dir: path.join(root, '.clementine', 'workflows'), singleRoot: false },
  ];
  const candidates: WorkflowCandidate[] = [];
  const seen = new Set<string>();

  for (const entry of roots) {
    if (!existsSync(entry.dir)) continue;
    if (entry.singleRoot) {
      const skillPath = path.join(entry.dir, 'SKILL.md');
      if (existsSync(skillPath)) {
        const definition = readWorkflowDefinitionFile(skillPath);
        if (definition?.steps?.length) {
          const name = safeWorkflowName(definition.name, path.basename(entry.dir));
          seen.add(skillPath);
          candidates.push({
            name,
            sourceDir: entry.dir,
            skillPath,
            pathInSource: relativePath(root, skillPath),
            definition,
          });
        }
      }
      continue;
    }

    let children: string[] = [];
    try {
      children = readdirSync(entry.dir, { withFileTypes: true })
        .filter((child) => child.isDirectory() && !child.name.startsWith('.'))
        .map((child) => child.name);
    } catch {
      continue;
    }
    for (const child of children) {
      const sourceDir = path.join(entry.dir, child);
      const skillPath = path.join(sourceDir, 'SKILL.md');
      if (seen.has(skillPath) || !existsSync(skillPath)) continue;
      const definition = readWorkflowDefinitionFile(skillPath);
      if (!definition?.steps?.length) continue;
      const name = safeWorkflowName(definition.name, child);
      seen.add(skillPath);
      candidates.push({
        name,
        sourceDir,
        skillPath,
        pathInSource: relativePath(root, skillPath),
        definition,
      });
    }
  }

  return candidates.sort((a, b) => a.name.localeCompare(b.name));
}

function shouldSkipCopyEntry(name: string): boolean {
  return name === '.git' || name === 'node_modules' || name === 'runs' || name === '.DS_Store';
}

function clearTargetDirPreservingRuns(targetDir: string): void {
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
    return;
  }
  for (const entry of readdirSync(targetDir)) {
    if (entry === 'runs') continue;
    rmSync(path.join(targetDir, entry), { recursive: true, force: true });
  }
}

function copyDirFiltered(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (shouldSkipCopyEntry(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirFiltered(srcPath, dstPath);
    } else if (entry.isFile()) {
      const data = statSync(srcPath);
      rmSync(dstPath, { force: true });
      writeFileSync(dstPath, readFileSync(srcPath));
      try { chmodSync(dstPath, data.mode); } catch { /* best effort */ }
    }
  }
}

function writeSourceMeta(targetDir: string, meta: Record<string, unknown>): void {
  writeFileSync(path.join(targetDir, SOURCE_FILE), JSON.stringify(meta, null, 2), 'utf-8');
}

export function importWorkflowFrameworkFromDirectory(
  root: string,
  options: WorkflowImportOptions & { sourceLabel?: string; sha?: string } = {},
): Pick<WorkflowImportJob, 'discovered' | 'installed' | 'skipped'> {
  const sourceRoot = path.resolve(expandHome(root));
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    throw new Error(`Workflow framework source is not a directory: ${root}`);
  }

  const candidates = discoverWorkflowCandidates(sourceRoot);
  const discovered = candidates.map((candidate) => ({
    name: candidate.name,
    pathInSource: candidate.pathInSource,
    description: candidate.definition.description,
  }));
  const installed: WorkflowImportJob['installed'] = [];
  const skipped: WorkflowImportJob['skipped'] = [];

  for (const candidate of candidates) {
    const existing = readWorkflow(candidate.name);
    if (options.dryRun) {
      skipped.push({
        name: candidate.name,
        pathInSource: candidate.pathInSource,
        reason: existing ? 'would update existing workflow' : 'would install new workflow',
      });
      continue;
    }
    if (existing && !options.overwrite) {
      skipped.push({
        name: candidate.name,
        pathInSource: candidate.pathInSource,
        reason: 'workflow already exists; pass overwrite=true to replace framework files',
      });
      continue;
    }

    const prepared = prepareWorkflowCreateForWrite(candidate.definition);
    if (prepared.status === 'invalid') {
      skipped.push({
        name: candidate.name,
        pathInSource: candidate.pathInSource,
        reason: `workflow failed validation: ${prepared.errors.join('; ')}`,
      });
      continue;
    }

    const targetDir = path.join(WORKFLOWS_DIR, candidate.name);
    clearTargetDirPreservingRuns(targetDir);
    copyDirFiltered(candidate.sourceDir, targetDir);
    const installedEntry = writeWorkflowAndSyncTriggers(candidate.name, prepared.def);
    writeSourceMeta(targetDir, {
      source: options.sourceLabel ?? sourceRoot,
      pathInSource: candidate.pathInSource,
      sha: options.sha,
      importedAt: new Date().toISOString(),
      kind: 'workflow-framework',
      repairs: prepared.repairs,
      warnings: prepared.warnings,
      codifyNotes: prepared.codifyNotes,
    });
    installed.push({ name: candidate.name, pathInSource: candidate.pathInSource, filePath: installedEntry.filePath });
  }

  if (installed.length > 0) syncWorkflowTriggersBestEffort();

  return { discovered, installed, skipped };
}

function runGit(args: string[], cwd: string, onChunk: (chunk: string) => void, timeoutMs: number): Promise<{ code: number }> {
  return new Promise((resolve) => {
    const git = findSafeCliCommand('git');
    if (!git || git.skipped) {
      onChunk(`\n[git unavailable: ${git?.skipped ? git.reason : 'git was not found on PATH'}]\n`);
      resolve({ code: 127 });
      return;
    }
    let settled = false;
    const child = spawn(git.command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b: Buffer) => onChunk(b.toString('utf-8')));
    child.stderr.on('data', (b: Buffer) => onChunk(b.toString('utf-8')));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
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

function readGitSha(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const git = findSafeCliCommand('git');
    if (!git || git.skipped) {
      resolve(undefined);
      return;
    }
    let out = '';
    const child = spawn(git.command, ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (b: Buffer) => { out += b.toString('utf-8'); });
    child.on('close', (code) => resolve(code === 0 ? out.trim() : undefined));
    child.on('error', () => resolve(undefined));
  });
}

export function startWorkflowFrameworkImport(source: string, options: WorkflowImportOptions = {}): WorkflowImportJob {
  const local = path.resolve(expandHome(source));
  const isLocal = existsSync(local) && statSync(local).isDirectory();
  const normalizedSource = isLocal ? local : normalizeRepoUrl(source).url;
  const job: WorkflowImportJob = {
    id: newJobId(),
    source,
    normalizedSource,
    status: 'queued',
    startedAt: new Date().toISOString(),
    output: '',
    dryRun: options.dryRun === true,
    overwrite: options.overwrite === true,
    discovered: [],
    installed: [],
    skipped: [],
  };
  jobs.set(job.id, job);

  void runWorkflowImportJob(job, isLocal ? local : undefined).catch((err) => {
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
    job.completedAt = new Date().toISOString();
    appendOutput(job, `\n[workflow import crashed: ${job.error}]\n`);
  });

  return job;
}

async function runWorkflowImportJob(job: WorkflowImportJob, localDir?: string): Promise<void> {
  let tmpRoot: string | undefined;
  try {
    let sourceRoot = localDir;
    if (!sourceRoot) {
      job.status = 'cloning';
      tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'clemmy-workflow-import-'));
      appendOutput(job, `Cloning ${job.normalizedSource} into ${tmpRoot}...\n`);
      const clone = await runGit(
        ['clone', '--depth=1', '--single-branch', '--', job.normalizedSource, '.'],
        tmpRoot,
        (chunk) => appendOutput(job, chunk),
        60_000,
      );
      if (clone.code !== 0) {
        job.status = 'failed';
        job.error = `git clone exited with code ${clone.code}`;
        job.completedAt = new Date().toISOString();
        return;
      }
      job.sha = await readGitSha(tmpRoot);
      sourceRoot = tmpRoot;
    }

    job.status = 'installing';
    const result = importWorkflowFrameworkFromDirectory(sourceRoot, {
      dryRun: job.dryRun,
      overwrite: job.overwrite,
      sourceLabel: job.normalizedSource,
      sha: job.sha,
    });
    job.discovered = result.discovered;
    job.installed = result.installed;
    job.skipped = result.skipped;

    appendOutput(job, `Discovered ${job.discovered.length} workflow${job.discovered.length === 1 ? '' : 's'}.\n`);
    for (const item of job.installed) appendOutput(job, `Installed ${item.name} from ${item.pathInSource}\n`);
    for (const item of job.skipped) appendOutput(job, `Skipped ${item.name}: ${item.reason}\n`);

    if (job.discovered.length === 0) {
      job.status = 'failed';
      job.error = 'No workflow SKILL.md files found. Expected workflows/<name>/SKILL.md or .clementine/workflows/<name>/SKILL.md.';
    } else {
      job.status = 'succeeded';
    }
    job.completedAt = new Date().toISOString();
  } finally {
    if (tmpRoot) {
      try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }
}

export function getWorkflowImportJob(id: string): WorkflowImportJob | undefined {
  return jobs.get(id);
}

export function listRecentWorkflowImportJobs(): WorkflowImportJob[] {
  return Array.from(jobs.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
