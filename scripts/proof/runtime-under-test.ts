/**
 * Pinned runtime provisioning — build a specific git ref (e.g. v3.14.0) in an
 * out-of-repo worktree so the proof harness can drive TWO runtimes with ONE
 * measurement stack.
 *
 * Design rules (cross-version benchmark spine):
 *   - The baseline is never modified; only its own tree builds its dist.
 *   - The worktree cache lives OUTSIDE the repo so a provisioned runtime can
 *     never dirty the fingerprinted source paths of the tree under test.
 *   - `package-lock.json` digests are recorded, and every pinned proof runs its
 *     own `npm ci`: directory existence is not dependency provenance.
 *   - `ref` undefined resolves to the CURRENT tree's dist — byte-for-byte the
 *     existing proof path, so default behavior never changes.
 *
 * The pure planning half (resolve/plan/inspect) is separated from the
 * effectful half (worktree add / npm ci / build) so tests cover the decisions
 * without spawning builds.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Check } from './types.js';

export interface RuntimeUnderTest {
  /** Human label: explicit input label, the ref, or 'working-tree'. */
  label: string;
  /** null = the current working tree (today's behavior). */
  gitRef: string | null;
  gitSha: string;
  /** Absolute path of the tree that owns daemonEntry. */
  treeRoot: string;
  /** Absolute path to that build's dist/index.js. */
  daemonEntry: string;
  lockSha256: string;
  nodeModulesProvenance: 'primary-tree' | 'npm-ci';
  /** True when daemonEntry exists (build already done / cached). */
  built: boolean;
  /** Measurement-owned attestation for a pinned worktree's exact daemon bytes. */
  buildAttestation?: RuntimeBuildAttestation;
}

export interface RuntimeBuildAttestation {
  version: 1;
  gitSha: string;
  lockSha256: string;
  artifactRoot: 'dist';
  artifactSha256: string;
}

export interface ReportedDaemonBuild {
  version: string;
  entry: string;
  packaged: boolean;
  gitSha?: string;
  gitDirty?: boolean;
}

/** Fail-closed parser for the authenticated identity endpoint. Only a literal
 * 404 denotes a daemon old enough not to expose the endpoint at all. */
export function reportedBuildFromHealthResponse(input: {
  status: number;
  bodyText: string;
}): ReportedDaemonBuild | undefined {
  if (input.status === 404) return undefined;
  if (input.status < 200 || input.status >= 300) {
    throw new Error(`pinned daemon identity health failed with HTTP ${input.status}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(input.bodyText);
  } catch {
    throw new Error('pinned daemon identity health returned malformed JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('pinned daemon identity health returned a non-object payload');
  }
  const rawBuild = (body as { build?: unknown }).build;
  if (rawBuild === undefined) {
    throw new Error('pinned daemon identity health omitted its build payload');
  }
  if (!rawBuild || typeof rawBuild !== 'object' || Array.isArray(rawBuild)) {
    throw new Error('pinned daemon identity health returned a malformed build payload');
  }
  return rawBuild as ReportedDaemonBuild;
}

/**
 * Pure identity check used before a pinned proof spends a provider call. The
 * worktree path proves what we intended to spawn; only the child daemon's own
 * full build stamp proves what actually answered the health request.
 */
export function verifyDaemonBuildMatchesPinnedRuntime(input: {
  runtime: RuntimeUnderTest;
  reportedBuild: ReportedDaemonBuild | undefined;
  /** Hash read from the exact entry immediately after this daemon booted. */
  observedArtifactSha256?: string;
}): Check {
  const expected = input.runtime.gitSha.toLowerCase();
  const reported = input.reportedBuild?.gitSha?.toLowerCase();
  const reportedFullSha = typeof reported === 'string' && /^[0-9a-f]{40}$/.test(reported);
  const reportedShortSha = typeof reported === 'string' && /^[0-9a-f]{7,39}$/.test(reported);
  const legacyWithoutIdentity = !input.reportedBuild
    || (
      input.reportedBuild.gitSha === undefined
      && input.reportedBuild.gitDirty === undefined
      && /^3\.14(?:\.|$)/.test(input.reportedBuild.version)
    );
  const legacyCompatibleShortReport = reportedShortSha
    && expected.startsWith(reported)
    && input.reportedBuild?.gitDirty === false;
  const legacyContradicts = reportedShortSha && !expected.startsWith(reported);
  const malformedSelfReport = Boolean(input.reportedBuild)
    && !legacyWithoutIdentity
    && !reportedFullSha
    && !legacyCompatibleShortReport
    && !legacyContradicts;
  const selfReportContradicts = reportedFullSha && reported !== expected;
  const selfReportDirty = input.reportedBuild?.gitDirty === true;
  const selfReportExact = reportedFullSha
    && reported === expected
    && input.reportedBuild?.gitDirty === false;
  const attestation = input.runtime.buildAttestation;
  const exactObservedBytes = Boolean(
    attestation
      && attestation.version === 1
      && attestation.gitSha.toLowerCase() === expected
      && attestation.lockSha256 === input.runtime.lockSha256
      && attestation.artifactRoot === 'dist'
      && /^[0-9a-f]{64}$/.test(attestation.artifactSha256)
      && input.observedArtifactSha256 === attestation.artifactSha256,
  );
  const pass = /^[0-9a-f]{40}$/.test(expected)
    && !selfReportContradicts
    && !legacyContradicts
    && !selfReportDirty
    && !malformedSelfReport
    && exactObservedBytes
    && (selfReportExact || legacyWithoutIdentity || legacyCompatibleShortReport);
  return {
    name: `pinned daemon build matches ${input.runtime.label}`,
    pass,
    detail: legacyContradicts
      ? `expected sha ${expected}; legacy daemon reported contradictory prefix ${reported}`
      : malformedSelfReport
      ? `daemon returned a malformed partial build identity (gitSha=${String(input.reportedBuild?.gitSha)}, gitDirty=${String(input.reportedBuild?.gitDirty)})`
      : selfReportContradicts
      ? `expected full sha ${expected}; daemon reported ${reported}`
      : selfReportDirty
        ? `daemon reported gitDirty=true for pinned runtime ${expected}`
        : !exactObservedBytes
          ? `spawned daemon artifact was not certified by the external build attestation (expected ${attestation?.artifactSha256 ?? '(missing)'}, observed ${input.observedArtifactSha256 ?? '(missing)'})`
          : selfReportExact
            ? `daemon self-reported exact clean build ${expected}; artifact ${input.observedArtifactSha256}`
            : `legacy daemon certified as ${expected} by exact artifact ${input.observedArtifactSha256}`,
  };
}

export interface RuntimePlanStep {
  kind: 'git-worktree-add' | 'npm-ci' | 'npm-build';
  cwd: string;
  detail: string;
}

export interface RuntimeProvisionPlan {
  runtime: RuntimeUnderTest;
  /** Effectful steps still required, in order. Empty = ready to use. */
  steps: RuntimePlanStep[];
}

export type RuntimeProvisioningMode =
  | 'explicit-ref'
  | 'clean-candidate-worktree'
  | 'dirty-working-tree';

export function runtimeProvisioningMode(input: {
  runtimeRef?: string;
  sourceClean: boolean;
}): RuntimeProvisioningMode {
  if (input.runtimeRef) return 'explicit-ref';
  return input.sourceClean ? 'clean-candidate-worktree' : 'dirty-working-tree';
}

export function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** Canonical identity for every regular file the daemon can import from dist. */
export function sha256Directory(directoryPath: string): string {
  const files: string[] = [];
  const visit = (absoluteDir: string, relativeDir: string): void => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(absoluteDir, entry.name);
      const relative = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`runtime artifact contains unsupported filesystem entry ${relative}`);
    }
  };
  if (!lstatSync(directoryPath).isDirectory()) {
    throw new Error(`runtime artifact root is not a directory: ${directoryPath}`);
  }
  visit(directoryPath, '');
  const hash = createHash('sha256');
  hash.update('clementine-runtime-artifact-v1\0');
  for (const relative of files.sort((a, b) => a.localeCompare(b))) {
    hash.update('\0path\0');
    hash.update(relative);
    hash.update('\0bytes\0');
    hash.update(readFileSync(path.join(directoryPath, ...relative.split('/'))));
  }
  return hash.digest('hex');
}

/** Kept beside (not inside) the worktree so measurement metadata cannot dirty it. */
export function runtimeBuildManifestPath(treeRoot: string): string {
  return `${treeRoot}.build-manifest.json`;
}

function isRuntimeBuildAttestation(value: unknown): value is RuntimeBuildAttestation {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<RuntimeBuildAttestation>;
  return row.version === 1
    && typeof row.gitSha === 'string'
    && /^[0-9a-f]{40}$/.test(row.gitSha)
    && typeof row.lockSha256 === 'string'
    && /^[0-9a-f]{64}$/.test(row.lockSha256)
    && row.artifactRoot === 'dist'
    && typeof row.artifactSha256 === 'string'
    && /^[0-9a-f]{64}$/.test(row.artifactSha256);
}

function readValidBuildAttestation(input: {
  treeRoot: string;
  gitSha: string;
  lockSha256: string;
  daemonEntry: string;
}): RuntimeBuildAttestation | undefined {
  if (!existsSync(input.daemonEntry)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(runtimeBuildManifestPath(input.treeRoot), 'utf8')) as unknown;
    if (!isRuntimeBuildAttestation(parsed)) return undefined;
    if (parsed.gitSha !== input.gitSha || parsed.lockSha256 !== input.lockSha256) return undefined;
    if (parsed.artifactSha256 !== sha256Directory(path.dirname(input.daemonEntry))) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function assertReusableWorktree(treeRoot: string, gitSha: string): void {
  const actual = git(treeRoot, ['rev-parse', 'HEAD']);
  if (actual !== gitSha) {
    throw new Error(`cached runtime worktree ${treeRoot} is at ${actual}, expected ${gitSha}; remove that cache entry before retrying`);
  }
  const status = git(treeRoot, ['status', '--porcelain', '--untracked-files=all']);
  const sourceChanges = status.split('\n').filter(Boolean).filter((line) => {
    const changedPath = line.slice(3).replace(/^"|"$/g, '');
    return changedPath !== 'dist'
      && !changedPath.startsWith('dist/')
      && changedPath !== 'node_modules'
      && !changedPath.startsWith('node_modules/');
  });
  if (sourceChanges.length > 0) {
    throw new Error(`cached runtime worktree ${treeRoot} is dirty; remove that cache entry before retrying`);
  }
}

function writeBuildAttestation(runtime: RuntimeUnderTest): RuntimeBuildAttestation {
  const attestation: RuntimeBuildAttestation = {
    version: 1,
    gitSha: runtime.gitSha,
    lockSha256: runtime.lockSha256,
    artifactRoot: 'dist',
    artifactSha256: sha256Directory(path.dirname(runtime.daemonEntry)),
  };
  const target = runtimeBuildManifestPath(runtime.treeRoot);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(attestation)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
  return attestation;
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 })
    .toString('utf8')
    .trim();
}

export function resolveRefSha(repoRoot: string, ref: string): string {
  const sha = git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`could not resolve '${ref}' to a commit sha (got '${sha}')`);
  }
  return sha;
}

export function defaultRuntimeCacheRoot(): string {
  return path.join(os.tmpdir(), 'clem-benchmark-runtimes');
}

export function worktreePathForSha(cacheRoot: string, sha: string): string {
  return path.join(cacheRoot, sha.slice(0, 12));
}

export function lockShaAtRef(repoRoot: string, sha: string): string {
  const contents = execFileSync('git', ['show', `${sha}:package-lock.json`], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  return createHash('sha256').update(contents).digest('hex');
}

function physicalPathIncludingMissingTail(candidate: string): string {
  let cursor = path.resolve(candidate);
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  const physicalBase = realpathSync(cursor);
  return path.join(physicalBase, ...missing);
}

/**
 * Pure planning: decide what the runtime IS and which effectful steps remain.
 * Never spawns git worktree/npm; safe for tests and dry runs.
 */
export function planRuntimeUnderTest(input: {
  repoRoot: string;
  ref?: string;
  label?: string;
  cacheRoot?: string;
}): RuntimeProvisionPlan {
  const repoRoot = input.repoRoot;

  if (!input.ref) {
    const sha = git(repoRoot, ['rev-parse', 'HEAD']);
    const daemonEntry = path.join(repoRoot, 'dist', 'index.js');
    const runtime: RuntimeUnderTest = {
      label: input.label ?? 'working-tree',
      gitRef: null,
      gitSha: sha,
      treeRoot: repoRoot,
      daemonEntry,
      lockSha256: sha256File(path.join(repoRoot, 'package-lock.json')),
      nodeModulesProvenance: 'primary-tree',
      built: existsSync(daemonEntry),
    };
    const steps: RuntimePlanStep[] = runtime.built
      ? []
      : [{ kind: 'npm-build', cwd: repoRoot, detail: 'npm run build (current tree)' }];
    return { runtime, steps };
  }

  const sha = resolveRefSha(repoRoot, input.ref);
  const cacheRoot = input.cacheRoot ?? defaultRuntimeCacheRoot();
  const physicalCacheRoot = physicalPathIncludingMissingTail(cacheRoot);
  const physicalRepoRoot = realpathSync(repoRoot);
  if (
    physicalCacheRoot === physicalRepoRoot
    || physicalCacheRoot.startsWith(physicalRepoRoot + path.sep)
  ) {
    throw new Error(
      `runtime cacheRoot must live OUTSIDE the repo (got ${cacheRoot}) — a worktree inside the repo would dirty the fingerprinted source paths`,
    );
  }
  const treeRoot = worktreePathForSha(cacheRoot, sha);
  const daemonEntry = path.join(treeRoot, 'dist', 'index.js');

  const refLockSha = lockShaAtRef(repoRoot, sha);
  const worktreeExists = existsSync(treeRoot);
  if (worktreeExists) assertReusableWorktree(treeRoot, sha);
  const buildAttestation = worktreeExists
    ? readValidBuildAttestation({ treeRoot, gitSha: sha, lockSha256: refLockSha, daemonEntry })
    : undefined;
  // A prior attestation is useful forensic evidence, but not permission to
  // skip dependency installation/build in a new measurement run.
  const built = false;

  const steps: RuntimePlanStep[] = [];
  if (!worktreeExists) {
    steps.push({
      kind: 'git-worktree-add',
      cwd: repoRoot,
      detail: `git worktree add --detach ${treeRoot} ${sha}`,
    });
  }
  steps.push({
    kind: 'npm-ci',
    cwd: treeRoot,
    detail: 'npm ci (fresh pinned dependency closure for this proof run)',
  });
  steps.push({ kind: 'npm-build', cwd: treeRoot, detail: 'npm run build (fresh pinned artifact)' });

  return {
    runtime: {
      label: input.label ?? input.ref,
      gitRef: input.ref,
      gitSha: sha,
      treeRoot,
      daemonEntry,
      lockSha256: refLockSha,
      nodeModulesProvenance: 'npm-ci',
      built,
      ...(buildAttestation ? { buildAttestation } : {}),
    },
    steps,
  };
}

/**
 * Effectful half: execute the remaining plan steps. The detached worktree is
 * cached by sha; dependencies and artifacts are deliberately rebuilt for each
 * pinned proof invocation.
 */
export function executeRuntimePlan(plan: RuntimeProvisionPlan, opts?: {
  log?: (line: string) => void;
}): RuntimeUnderTest {
  const log = opts?.log ?? (() => {});
  for (const step of plan.steps) {
    log(`[runtime-under-test] ${step.kind}: ${step.detail}`);
    switch (step.kind) {
      case 'git-worktree-add': {
        execFileSync('git', ['worktree', 'add', '--detach', plan.runtime.treeRoot, plan.runtime.gitSha], {
          cwd: step.cwd,
          stdio: 'pipe',
        });
        break;
      }
      case 'npm-ci': {
        execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: step.cwd, stdio: 'pipe' });
        break;
      }
      case 'npm-build': {
        execFileSync('npm', ['run', 'build'], { cwd: step.cwd, stdio: 'pipe' });
        break;
      }
      default:
        throw new Error(`unknown step kind ${(step as { kind: string }).kind}`);
    }
  }
  if (plan.runtime.gitRef) assertReusableWorktree(plan.runtime.treeRoot, plan.runtime.gitSha);
  const built = existsSync(plan.runtime.daemonEntry);
  const buildAttestation = built && plan.runtime.gitRef
    ? (plan.steps.some((step) => step.kind === 'npm-build')
      ? writeBuildAttestation(plan.runtime)
      : readValidBuildAttestation({
        treeRoot: plan.runtime.treeRoot,
        gitSha: plan.runtime.gitSha,
        lockSha256: plan.runtime.lockSha256,
        daemonEntry: plan.runtime.daemonEntry,
      }))
    : undefined;
  return {
    ...plan.runtime,
    built,
    ...(buildAttestation ? { buildAttestation } : {}),
  };
}
