/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/coding-run-git.test.ts
 *
 * Real git in a temporary repository: the run gets its own worktree and
 * branch without touching the user's checkout, re-entry is idempotent,
 * evidence comes from git, leftovers are committed unless a hook refuses,
 * and the host's own test run is what counts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'coding-run-git-'));
process.env.CLEMENTINE_HOME = home;

const gitLib = await import('./coding-run-git.js');

const project = path.join(home, 'projects', 'fixture');
mkdirSync(project, { recursive: true });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf-8' }).trim();
git(project, 'init', '-q', '-b', 'main');
writeFileSync(path.join(project, 'README.md'), '# fixture\n');
git(project, 'add', '.');
git(project, 'commit', '-q', '-m', 'Initial commit');

test.after(() => rmSync(home, { recursive: true, force: true }));

test('the project repo is read from git, including its current branch', async () => {
  const repo = await gitLib.readProjectRepo(project);
  assert.ok(repo);
  assert.equal(repo.branch, 'main');
  assert.equal(repo.headCommit, git(project, 'rev-parse', 'HEAD'));
  assert.equal(await gitLib.readProjectRepo(path.join(home, 'projects')), null);
});

test('a run gets its own worktree and branch; the user\'s checkout is untouched', async () => {
  const base = git(project, 'rev-parse', 'HEAD');
  const worktreePath = gitLib.codingRunWorktreePath('fixture', 'code-abc-12345678');
  const branch = gitLib.codingRunBranchName('Add a greeting function!', 'code-abc-12345678');
  assert.match(branch, /^clem\/add-a-greeting-function-12345678$/);
  assert.ok(worktreePath.startsWith(path.join(home, 'worktrees', 'fixture')));

  assert.deepEqual(await gitLib.ensureRunWorktree({ projectPath: project, worktreePath, branch, baseCommit: base }), { ok: true });
  assert.equal(git(worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'), branch);
  assert.equal(git(project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  // Re-entry after a restart reuses the worktree.
  assert.deepEqual(await gitLib.ensureRunWorktree({ projectPath: project, worktreePath, branch, baseCommit: base }), { ok: true });

  writeFileSync(path.join(worktreePath, 'greet.js'), 'module.exports = (n) => `Hello, ${n}!`;\n');
  git(worktreePath, 'add', 'greet.js');
  git(worktreePath, 'commit', '-q', '-m', 'Add greet');
  writeFileSync(path.join(worktreePath, 'notes.md'), 'left behind\n');

  const before = await gitLib.readGitEvidence(worktreePath, base);
  assert.equal(before.commits.length, 1);
  assert.equal(before.commits[0]!.subject, 'Add greet');
  assert.equal(before.diffStat.filesChanged, 1);
  assert.deepEqual(before.diffStat.files, ['greet.js']);
  assert.deepEqual(before.dirtyFiles, ['notes.md']);

  assert.equal(await gitLib.commitLeftovers(worktreePath, 'Save uncommitted work'), true);
  const after = await gitLib.readGitEvidence(worktreePath, base);
  assert.equal(after.commits.length, 2);
  assert.deepEqual(after.dirtyFiles, []);
  assert.equal(await gitLib.commitLeftovers(worktreePath, 'nothing to save'), false);
  assert.equal(existsSync(path.join(project, 'greet.js')), false);
});

test('a refusing commit hook leaves leftovers uncommitted instead of being bypassed', async () => {
  const base = git(project, 'rev-parse', 'HEAD');
  const worktreePath = gitLib.codingRunWorktreePath('fixture', 'code-hook-87654321');
  const branch = gitLib.codingRunBranchName('hook case', 'code-hook-87654321');
  await gitLib.ensureRunWorktree({ projectPath: project, worktreePath, branch, baseCommit: base });
  const hooks = path.join(project, '.git', 'hooks');
  writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho "lint failed" >&2\nexit 1\n');
  chmodSync(path.join(hooks, 'pre-commit'), 0o755);
  try {
    writeFileSync(path.join(worktreePath, 'bad.js'), 'x\n');
    assert.equal(await gitLib.commitLeftovers(worktreePath, 'Save uncommitted work'), false);
    const evidence = await gitLib.readGitEvidence(worktreePath, base);
    assert.deepEqual(evidence.dirtyFiles, ['bad.js']);
  } finally {
    rmSync(path.join(hooks, 'pre-commit'), { force: true });
  }
});

test('the host runs the test command itself and reports exit, output and timeouts', async () => {
  const pass = await gitLib.runTestCommand('echo all good && exit 0', project);
  assert.equal(pass.exitCode, 0);
  assert.match(pass.tail, /all good/);
  const fail = await gitLib.runTestCommand('echo "1 failing" >&2; exit 3', project);
  assert.equal(fail.exitCode, 3);
  assert.match(fail.tail, /1 failing/);
  const hung = await gitLib.runTestCommand('sleep 30', project, 300);
  assert.equal(hung.timedOut, true);
  assert.equal(hung.exitCode, null);
  // The clean environment carries no Clem or provider secrets.
  process.env.ANTHROPIC_API_KEY = 'sk-test-should-not-leak';
  try {
    const env = await gitLib.runTestCommand('env', project);
    assert.doesNotMatch(env.tail, /ANTHROPIC_API_KEY|CLEMENTINE_HOME/);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
  assert.ok(readFileSync(path.join(project, 'README.md'), 'utf-8').startsWith('# fixture'));
});
