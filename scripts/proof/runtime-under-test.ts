/**
 * Pinned runtime provisioning — build a specific git ref (e.g. v3.14.0) in an
 * out-of-repo worktree so the proof harness can drive TWO runtimes with ONE
 * measurement stack.
 *
 * Design rules (cross-version benchmark spine):
 *   - The baseline is never modified; only its own tree builds its dist.
 *   - The worktree cache lives OUTSIDE the repo so a provisioned runtime can
 *     never dirty the fingerprinted source paths of the tree under test.
 *   - `package-lock.json` digests are compared and recorded: identical locks
 *     mean the dependency closure is provably shared; differing locks force a
 *     full `npm ci` in the worktree and the comparison report says so.
 *   - `ref` undefined resolves to the CURRENT tree's dist — byte-for-byte the
 *     existing proof path, so default behavior never changes.
 *
 * The pure planning half (resolve/plan/inspect) is separated from the
 * effectful half (worktree add / npm ci / build) so tests cover the decisions
 * without spawning builds.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  nodeModulesProvenance: 'primary-tree' | 'shared-lock-link' | 'npm-ci';
  /** True when daemonEntry exists (build already done / cached). */
  built: boolean;
}

export interface RuntimePlanStep {
  kind: 'git-worktree-add' | 'link-node-modules' | 'npm-ci' | 'npm-build';
  cwd: string;
  detail: string;
  /** Set on link-node-modules only. */
  sourcePath?: string;
  targetPath?: string;
}

export interface RuntimeProvisionPlan {
  runtime: RuntimeUnderTest;
  /** Effectful steps still required, in order. Empty = ready to use. */
  steps: RuntimePlanStep[];
}

export function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
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
  if (path.resolve(cacheRoot).startsWith(path.resolve(repoRoot) + path.sep)) {
    throw new Error(
      `runtime cacheRoot must live OUTSIDE the repo (got ${cacheRoot}) — a worktree inside the repo would dirty the fingerprinted source paths`,
    );
  }
  const treeRoot = worktreePathForSha(cacheRoot, sha);
  const daemonEntry = path.join(treeRoot, 'dist', 'index.js');

  const refLockSha = lockShaAtRef(repoRoot, sha);
  const primaryLockSha = sha256File(path.join(repoRoot, 'package-lock.json'));
  const sharedLock = refLockSha === primaryLockSha;

  const worktreeExists = existsSync(treeRoot);
  const nodeModulesExists = existsSync(path.join(treeRoot, 'node_modules'));
  const built = existsSync(daemonEntry);

  const steps: RuntimePlanStep[] = [];
  if (!worktreeExists) {
    steps.push({
      kind: 'git-worktree-add',
      cwd: repoRoot,
      detail: `git worktree add --detach ${treeRoot} ${sha}`,
    });
  }
  if (!nodeModulesExists) {
    if (sharedLock) {
      steps.push({
        kind: 'link-node-modules',
        cwd: treeRoot,
        detail: 'clone node_modules from primary tree (lock digests identical)',
        sourcePath: path.join(repoRoot, 'node_modules'),
        targetPath: path.join(treeRoot, 'node_modules'),
      });
    } else {
      steps.push({ kind: 'npm-ci', cwd: treeRoot, detail: 'npm ci (lock digests differ)' });
    }
  }
  if (!built) {
    steps.push({ kind: 'npm-build', cwd: treeRoot, detail: 'npm run build (pinned tree)' });
  }

  return {
    runtime: {
      label: input.label ?? input.ref,
      gitRef: input.ref,
      gitSha: sha,
      treeRoot,
      daemonEntry,
      lockSha256: refLockSha,
      nodeModulesProvenance: sharedLock ? 'shared-lock-link' : 'npm-ci',
      built,
    },
    steps,
  };
}

/**
 * Effectful half: execute the remaining plan steps. Builds are cached by sha —
 * a second call with the same ref does nothing. Kept separate so callers (and
 * tests) can inspect the plan first.
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
      case 'link-node-modules': {
        // Copy-on-write clone where the filesystem supports it; falls back to
        // a plain recursive copy. A symlink is deliberately NOT used: build
        // tooling that resolves realpaths would escape the worktree.
        if (!step.sourcePath || !step.targetPath) {
          throw new Error('link-node-modules step missing sourcePath/targetPath');
        }
        try {
          execFileSync('cp', ['-Rc', step.sourcePath, step.targetPath], { stdio: 'pipe' });
        } catch {
          execFileSync('cp', ['-R', step.sourcePath, step.targetPath], { stdio: 'pipe' });
        }
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
  return {
    ...plan.runtime,
    built: existsSync(plan.runtime.daemonEntry),
  };
}
