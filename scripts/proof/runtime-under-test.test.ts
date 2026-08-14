/**
 * Pinned-runtime planner self-tests — pure planning only, no worktree adds,
 * no npm, no builds. The properties under pin:
 *   - ref undefined resolves to the CURRENT tree's dist (default path unchanged);
 *   - a pinned ref plans an out-of-repo worktree keyed by sha;
 *   - an in-repo cacheRoot is refused (it would dirty the fingerprint);
 *   - identical lock digests plan a clone, differing digests plan npm ci;
 *   - cached state is trusted only with a measurement-owned byte attestation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  runtimeBuildManifestPath,
  defaultRuntimeCacheRoot,
  planRuntimeUnderTest,
  resolveRefSha,
  runtimeProvisioningMode,
  sha256Directory,
  sha256File,
  worktreePathForSha,
} from './runtime-under-test.js';

test('release-grade candidates use a detached fresh install; dirty development stays local', () => {
  assert.equal(runtimeProvisioningMode({ runtimeRef: 'v3.14.0', sourceClean: true }), 'explicit-ref');
  assert.equal(runtimeProvisioningMode({ sourceClean: true }), 'clean-candidate-worktree');
  assert.equal(runtimeProvisioningMode({ sourceClean: false }), 'dirty-working-tree');
});

/** Build a tiny throwaway git repo with two commits: one changing the lock. */
function makeFixtureRepo(): { repoRoot: string; firstSha: string; cleanup: () => void } {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'rut-fixture-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' })
    .toString('utf8')
    .trim();
  git('init', '--initial-branch', 'main');
  git('config', 'user.email', 'proof@test.local');
  git('config', 'user.name', 'proof-fixture');
  writeFileSync(path.join(repoRoot, 'package-lock.json'), '{"lockfileVersion": 3, "v": 1}\n');
  writeFileSync(path.join(repoRoot, 'index.js'), 'console.log(1)\n');
  git('add', '.');
  git('commit', '-m', 'first', '--no-gpg-sign');
  const firstSha = git('rev-parse', 'HEAD');
  git('tag', 'v-old');
  writeFileSync(path.join(repoRoot, 'package-lock.json'), '{"lockfileVersion": 3, "v": 2}\n');
  git('add', '.');
  git('commit', '-m', 'second: lock changed', '--no-gpg-sign');
  return { repoRoot, firstSha, cleanup: () => rmSync(repoRoot, { recursive: true, force: true }) };
}

test('ref undefined = current tree, primary node_modules, existing dist honored', () => {
  const { repoRoot, cleanup } = makeFixtureRepo();
  try {
    const withoutDist = planRuntimeUnderTest({ repoRoot });
    assert.equal(withoutDist.runtime.gitRef, null);
    assert.equal(withoutDist.runtime.treeRoot, repoRoot);
    assert.equal(withoutDist.runtime.nodeModulesProvenance, 'primary-tree');
    assert.equal(withoutDist.runtime.built, false);
    assert.deepEqual(withoutDist.steps.map((step) => step.kind), ['npm-build']);

    mkdirSync(path.join(repoRoot, 'dist'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'dist', 'index.js'), '// built\n');
    const withDist = planRuntimeUnderTest({ repoRoot });
    assert.equal(withDist.runtime.built, true);
    assert.deepEqual(withDist.steps, []);
  } finally {
    cleanup();
  }
});

test('pinned ref plans worktree-add + npm-ci + build when lock digests differ', () => {
  const { repoRoot, firstSha, cleanup } = makeFixtureRepo();
  const cacheRoot = mkdtempSync(path.join(os.tmpdir(), 'rut-cache-'));
  try {
    const plan = planRuntimeUnderTest({ repoRoot, ref: 'v-old', cacheRoot });
    assert.equal(plan.runtime.gitRef, 'v-old');
    assert.equal(plan.runtime.gitSha, firstSha);
    assert.equal(plan.runtime.treeRoot, worktreePathForSha(cacheRoot, firstSha));
    assert.equal(plan.runtime.nodeModulesProvenance, 'npm-ci', 'lock changed after v-old');
    assert.deepEqual(plan.steps.map((step) => step.kind), ['git-worktree-add', 'npm-ci', 'npm-build']);
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('a pinned runtime installs its own dependency closure even when lock digests match', () => {
  const { repoRoot, cleanup } = makeFixtureRepo();
  const cacheRoot = mkdtempSync(path.join(os.tmpdir(), 'rut-cache-'));
  try {
    // HEAD's lock is identical to the working tree's lock in the fixture.
    const plan = planRuntimeUnderTest({ repoRoot, ref: 'HEAD', cacheRoot });
    assert.equal(plan.runtime.nodeModulesProvenance, 'npm-ci');
    assert.deepEqual(plan.steps.map((step) => step.kind), ['git-worktree-add', 'npm-ci', 'npm-build']);
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('cacheRoot inside the repo is refused', () => {
  const { repoRoot, cleanup } = makeFixtureRepo();
  try {
    assert.throws(
      () => planRuntimeUnderTest({ repoRoot, ref: 'HEAD', cacheRoot: path.join(repoRoot, 'cache') }),
      /OUTSIDE the repo/,
    );
    assert.throws(
      () => planRuntimeUnderTest({ repoRoot, ref: 'HEAD', cacheRoot: repoRoot }),
      /OUTSIDE the repo/,
    );
    const outside = mkdtempSync(path.join(os.tmpdir(), 'rut-alias-'));
    const alias = path.join(outside, 'repo-alias');
    try {
      symlinkSync(repoRoot, alias);
      assert.throws(
        () => planRuntimeUnderTest({ repoRoot, ref: 'HEAD', cacheRoot: path.join(alias, 'cache') }),
        /OUTSIDE the repo/,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

test('an unattested cached dist gets a fresh dependency closure and build', () => {
  const { repoRoot, firstSha, cleanup } = makeFixtureRepo();
  const cacheRoot = mkdtempSync(path.join(os.tmpdir(), 'rut-cache-'));
  try {
    const treeRoot = worktreePathForSha(cacheRoot, firstSha);
    execFileSync('git', ['worktree', 'add', '--detach', treeRoot, firstSha], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    mkdirSync(path.join(treeRoot, 'node_modules'), { recursive: true });
    mkdirSync(path.join(treeRoot, 'dist'), { recursive: true });
    writeFileSync(path.join(treeRoot, 'dist', 'index.js'), '// cached build\n');
    const plan = planRuntimeUnderTest({ repoRoot, ref: 'v-old', cacheRoot });
    assert.equal(plan.runtime.built, false);
    assert.deepEqual(plan.steps.map((step) => step.kind), ['npm-ci', 'npm-build']);
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('a cached attestation is inspected but never skips a fresh pinned install and build', () => {
  const { repoRoot, firstSha, cleanup } = makeFixtureRepo();
  const cacheRoot = mkdtempSync(path.join(os.tmpdir(), 'rut-cache-'));
  try {
    const treeRoot = worktreePathForSha(cacheRoot, firstSha);
    execFileSync('git', ['worktree', 'add', '--detach', treeRoot, firstSha], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    mkdirSync(path.join(treeRoot, 'node_modules'), { recursive: true });
    mkdirSync(path.join(treeRoot, 'dist'), { recursive: true });
    const daemonEntry = path.join(treeRoot, 'dist', 'index.js');
    writeFileSync(daemonEntry, '// exact cached build\n');
    writeFileSync(path.join(treeRoot, 'dist', 'imported.js'), '// imported sibling\n');
    writeFileSync(runtimeBuildManifestPath(treeRoot), `${JSON.stringify({
      version: 1,
      gitSha: firstSha,
      lockSha256: sha256File(path.join(treeRoot, 'package-lock.json')),
      artifactRoot: 'dist',
      artifactSha256: sha256Directory(path.join(treeRoot, 'dist')),
    })}\n`);

    const plan = planRuntimeUnderTest({ repoRoot, ref: 'v-old', cacheRoot });
    assert.equal(plan.runtime.built, false);
    assert.deepEqual(plan.steps.map((step) => step.kind), ['npm-ci', 'npm-build']);
    assert.equal(plan.runtime.buildAttestation?.artifactSha256, sha256Directory(path.join(treeRoot, 'dist')));

    writeFileSync(path.join(treeRoot, 'dist', 'imported.js'), '// tampered imported sibling\n');
    const tampered = planRuntimeUnderTest({ repoRoot, ref: 'v-old', cacheRoot });
    assert.equal(tampered.runtime.built, false);
    assert.equal(tampered.runtime.buildAttestation, undefined);
    assert.deepEqual(tampered.steps.map((step) => step.kind), ['npm-ci', 'npm-build']);
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('resolveRefSha rejects garbage refs; default cache root is out of repo', () => {
  const { repoRoot, cleanup } = makeFixtureRepo();
  try {
    assert.throws(() => resolveRefSha(repoRoot, 'no-such-ref-xyz'));
    assert.ok(!defaultRuntimeCacheRoot().startsWith(repoRoot));
  } finally {
    cleanup();
  }
});
