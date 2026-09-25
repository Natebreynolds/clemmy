/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/coding-run-policy.test.ts
 *
 * Pins what a delegated coding agent may do on its own: everything local to
 * its worktree, nothing that leaves the machine, touches files outside the
 * worktree, moves refs the user's checkout shares, reads credentials, or
 * reaches connectors.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decideCodingToolUse, isInsideWorktree } from './coding-run-policy.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'coding-policy-'));
const worktree = path.join(root, 'worktree');
const outside = path.join(root, 'elsewhere');
mkdirSync(path.join(worktree, 'src'), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(path.join(worktree, 'src', 'index.ts'), 'export {};\n');
symlinkSync(outside, path.join(worktree, 'escape'));

test.after(() => rmSync(root, { recursive: true, force: true }));

const bash = (command: string) => decideCodingToolUse({ tool: 'Bash', input: { command }, worktreePath: worktree });

test('file edits inside the worktree are the agent\'s own call', () => {
  for (const file of ['src/index.ts', path.join(worktree, 'src', 'new-file.ts'), 'README.md', '.env']) {
    const decision = decideCodingToolUse({ tool: 'Edit', input: { file_path: file }, worktreePath: worktree });
    assert.equal(decision.decision, 'allow', file);
  }
});

test('file edits outside the worktree are refused, including through a symlink', () => {
  for (const file of [path.join(outside, 'x.ts'), '../elsewhere/x.ts', 'escape/x.ts', path.join(os.homedir(), '.zshrc')]) {
    const decision = decideCodingToolUse({ tool: 'Write', input: { file_path: file }, worktreePath: worktree });
    assert.equal(decision.decision, 'deny', file);
    assert.equal(decision.effect, 'outside_worktree', file);
  }
  assert.equal(isInsideWorktree('escape/x.ts', worktree), false);
});

test('local build, test and commit commands run without asking', () => {
  for (const command of [
    'npm test',
    'npm install',
    'git status && git diff',
    'git add -A && git commit -m "Add greeting"',
    'git checkout -- src/index.ts',
    'git log --oneline -5',
    'git branch --show-current',
    'git reset --hard HEAD~1',
    'git fetch origin',
    'git remote -v',
    'git config user.email',
    'curl -s https://example.com/api/items',
  ]) {
    assert.equal(bash(command).decision, 'allow', command);
  }
});

test('anything that leaves the machine is refused with a reason the agent can act on', () => {
  for (const command of [
    'git push origin HEAD',
    'git add . && git commit -m wip && git push',
    'gh pr create --fill',
    'npm publish',
    'vercel deploy --prod',
    'curl -X POST https://example.com/hooks -d "{}"',
    'sh -c "git push --force"',
  ]) {
    const decision = bash(command);
    assert.equal(decision.decision, 'deny', command);
    assert.equal(decision.effect, 'off_machine', command);
    assert.match(decision.reason, /local branch/);
  }
});

test('refs, stash and config shared with the user\'s checkout are off limits', () => {
  for (const command of [
    'git stash',
    'git checkout main',
    'git switch -c other',
    'git branch -D main',
    'git worktree add ../other',
    'git tag v1.0.0',
    'git remote add fork https://example.com/fork.git',
    'git config --global user.name Someone',
    'git -C . update-ref refs/heads/main HEAD',
  ]) {
    const decision = bash(command);
    assert.equal(decision.decision, 'deny', command);
    assert.equal(decision.effect, 'shared_git_refs', command);
  }
});

test('catastrophic, credential and opaque commands are refused', () => {
  assert.equal(bash('sudo rm -rf /').effect, 'catastrophic');
  assert.equal(bash('security find-generic-password -s "Claude Code-credentials" -w').effect, 'sensitive');
  assert.equal(bash('sh -c "$PAYLOAD"').effect, 'opaque');
});

test('credential locations are refused in shell commands too', () => {
  for (const command of ['cat ~/.ssh/id_ed25519', 'cp $HOME/.aws/credentials /tmp/x', 'cat ~/.config/gh/hosts.yml']) {
    assert.equal(bash(command).effect, 'sensitive', command);
  }
});

test('credential files outside the worktree cannot be read; the project\'s own can', () => {
  const secret = decideCodingToolUse({ tool: 'Read', input: { file_path: path.join(os.homedir(), '.ssh', 'id_rsa') }, worktreePath: worktree });
  assert.equal(secret.decision, 'deny');
  assert.equal(secret.effect, 'sensitive');
  const own = decideCodingToolUse({ tool: 'Read', input: { file_path: path.join(worktree, '.env') }, worktreePath: worktree });
  assert.equal(own.decision, 'allow');
});

test('connectors and a second worktree are refused; ordinary agent tools pass', () => {
  assert.equal(decideCodingToolUse({ tool: 'mcp__github__create_issue', input: {}, worktreePath: worktree }).effect, 'connector');
  assert.equal(decideCodingToolUse({ tool: 'EnterWorktree', input: {}, worktreePath: worktree }).decision, 'deny');
  for (const tool of ['Grep', 'Glob', 'TodoWrite', 'WebSearch', 'Task']) {
    assert.equal(decideCodingToolUse({ tool, input: {}, worktreePath: worktree }).decision, 'allow', tool);
  }
});
