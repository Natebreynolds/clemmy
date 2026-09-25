/**
 * What a delegated coding agent may do on its own inside a coding run.
 *
 * The run's worktree is the agent's workspace: reading, editing, building,
 * testing and committing there are Clem's call, and she allows them without
 * asking anyone. Effects that leave the machine (push, PRs, publish, deploy,
 * network writes), touch files outside the worktree, move refs that other
 * checkouts of the same repository share, or reach connectors are not the
 * agent's to take. Until the run's finish line carries the user's decision for
 * a specific send, those are refused with a reason the agent can act on.
 *
 * Pure: the executor feeds this from the agent's PreToolUse hook, which fires
 * for every tool call regardless of the user's own "always allow" rules, so
 * this is the one gate every agent action crosses.
 */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { classifyShellNetworkMutation, expandLiteralShellCommands } from '../runtime/harness/destination-gate.js';
import { BASE_DIR } from '../config.js';
import { isSensitivePath, shellCommandTouchesSensitiveData } from '../runtime/security.js';
import { assertCommandAllowed } from '../tools/computer-tools.js';

export type CodingToolEffect =
  | 'local'
  | 'off_machine'
  | 'outside_worktree'
  | 'shared_git_refs'
  | 'connector'
  | 'catastrophic'
  | 'sensitive'
  | 'opaque';

export interface CodingToolDecision {
  decision: 'allow' | 'deny';
  effect: CodingToolEffect;
  /** Written for the agent: it reads this as the tool's refusal and adapts. */
  reason: string;
}

export interface CodingToolRequest {
  tool: string;
  input: Record<string, unknown>;
  worktreePath: string;
}

const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const FILE_READ_TOOLS = new Set(['Read', 'NotebookRead', 'Grep', 'Glob', 'LS']);
const SHELL_TOOLS = new Set(['Bash']);

const ALLOW_LOCAL: CodingToolDecision = { decision: 'allow', effect: 'local', reason: 'inside the run worktree' };

function deny(effect: CodingToolEffect, reason: string): CodingToolDecision {
  return { decision: 'deny', effect, reason };
}

/** Resolve through the nearest existing ancestor so a symlink inside the
 *  worktree cannot carry a write somewhere else. */
function realResolved(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  let base = current;
  try { base = realpathSync(current); } catch { /* keep the lexical path */ }
  return path.join(base, ...tail);
}

export function isInsideWorktree(target: string, worktreePath: string): boolean {
  const root = realResolved(worktreePath);
  const resolved = realResolved(path.isAbsolute(target) ? target : path.join(worktreePath, target));
  const relative = path.relative(root, resolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Where a developer machine keeps credentials a coding agent never needs:
 * SSH and cloud keys, registry and forge tokens, keychains, and the sign-in
 * files of the agents themselves. Matched as path fragments so `~/`, `$HOME/`
 * and absolute spellings all hit.
 */
const CREDENTIAL_LOCATIONS: readonly RegExp[] = [
  /(^|[\s/'"=])\.ssh\//,
  /(^|[\s/'"=])\.aws\//,
  /(^|[\s/'"=])\.gnupg\//,
  /(^|[\s/'"=])\.kube\/config\b/,
  /(^|[\s/'"=])\.docker\/config\.json\b/,
  /(^|[\s/'"=])\.config\/gh\//,
  /(^|[\s/'"=])\.config\/gcloud\//,
  /(^|[\s/'"=])\.netrc\b/,
  /(^|[\s/'"=])\.git-credentials\b/,
  /(^|[\s/'"=])\.npmrc\b/,
  /(^|[\s/'"=])\.pypirc\b/,
  /(^|[\s/'"=])\.claude\/\.credentials\.json\b/,
  /(^|[\s/'"=])\.codex\/auth\.json\b/,
  /Library\/Keychains\//,
];

function mentionsCredentialLocation(text: string): boolean {
  return CREDENTIAL_LOCATIONS.some((pattern) => pattern.test(text));
}

/** Clem's own home (state, vault, event log) is not the agent's to read; the
 *  run's worktree lives under it, and that one subtree is. */
function insideClemHome(target: string): boolean {
  const relative = path.relative(realResolved(BASE_DIR), realResolved(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function fileTargetOf(input: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function tokenizeSegment(segment: string): string[] {
  return segment
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/**
 * Git subcommands that act on state the run's branch does not own. Every
 * worktree of a repository shares its refs, stash and config, so these reach
 * the user's own checkout. Committing, diffing, resetting and rebasing the
 * run's own branch stay local and are not listed.
 */
function sharedGitRefEffect(tokens: string[]): string | null {
  let i = 1;
  // Skip global options such as `-C dir` or `-c key=value`.
  while (i < tokens.length && tokens[i]!.startsWith('-')) {
    const flag = tokens[i]!;
    i += flag === '-C' || flag === '-c' || flag === '--git-dir' || flag === '--work-tree' ? 2 : 1;
  }
  const sub = tokens[i]?.toLowerCase();
  const rest = tokens.slice(i + 1);
  if (!sub) return null;
  const has = (...flags: string[]) => rest.some((token) => flags.includes(token));
  switch (sub) {
    case 'stash':
      return 'git stash is shared by every checkout of this repository';
    case 'worktree':
      return 'this run already has its own worktree';
    case 'update-ref':
    case 'symbolic-ref':
    case 'filter-branch':
    case 'filter-repo':
    case 'gc':
    case 'prune':
      return `git ${sub} rewrites repository-wide state`;
    case 'reflog':
      return has('expire', 'delete') ? 'git reflog expire/delete rewrites repository-wide history' : null;
    case 'remote':
      return rest.length > 0 && !has('-v', '--verbose', 'show', 'get-url') ? 'remotes are shared repository configuration' : null;
    case 'config':
      return has('--global', '--system') || (!has('--get', '--get-all', '--list', '-l', '--get-regexp') && rest.length >= 2)
        ? 'git configuration is shared with the user\'s checkout'
        : null;
    case 'branch':
      return has('-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '-u', '--set-upstream-to', '--unset-upstream')
        ? 'other branches belong to the user\'s checkout'
        : null;
    case 'tag':
      return rest.length > 0 && !has('-l', '--list') ? 'tags are shared repository refs' : null;
    case 'checkout':
    case 'switch': {
      // `git checkout -- file` restores a file; anything else moves this
      // worktree off the run's branch.
      if (sub === 'checkout' && rest.includes('--')) return null;
      if (sub === 'checkout' && rest.length > 0 && rest.every((token) => token.startsWith('-'))) return null;
      return rest.length > 0 ? 'the run works on its own branch; switching branches would abandon it' : null;
    }
    default:
      return null;
  }
}

function shellDecision(command: string): CodingToolDecision {
  if (!command.trim()) return ALLOW_LOCAL;
  if (shellCommandTouchesSensitiveData(command) || mentionsCredentialLocation(command)) {
    return deny('sensitive', 'Refused: that reads credentials or secrets. This task never needs them.');
  }
  try {
    assertCommandAllowed(command);
  } catch {
    return deny('catastrophic', 'Refused: that command is never allowed on this machine.');
  }
  const expansion = expandLiteralShellCommands(command);
  if (expansion.hasOpaqueShellWrapper) {
    return deny('opaque', 'Refused: a shell wrapper whose script is built at runtime cannot be checked. Run the commands directly.');
  }
  const mutation = classifyShellNetworkMutation(command);
  if (mutation.isNetworkMutation) {
    return deny(
      'off_machine',
      'Refused: this sends something off this machine (push, PR, publish, deploy or a network write). '
        + 'Keep the work on this run\'s local branch and commit it; Clem carries it further only when the user asks.',
    );
  }
  for (const candidate of expansion.commands) {
    for (const segment of candidate.split(/&&|\|\||;|\||[\r\n]+/)) {
      const tokens = tokenizeSegment(segment);
      let start = 0;
      while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]!)) start += 1;
      if (path.basename(tokens[start] ?? '') !== 'git') continue;
      const effect = sharedGitRefEffect(tokens.slice(start));
      if (effect) return deny('shared_git_refs', `Refused: ${effect}. Stay on this run's branch.`);
    }
  }
  return ALLOW_LOCAL;
}

export function decideCodingToolUse(request: CodingToolRequest): CodingToolDecision {
  const tool = request.tool;
  if (tool.startsWith('mcp__')) {
    return deny('connector', 'Refused: connectors and external services go through Clem, not the coding agent.');
  }
  if (/worktree/i.test(tool)) {
    return deny('shared_git_refs', 'Refused: this run already has its own worktree.');
  }
  if (FILE_WRITE_TOOLS.has(tool)) {
    const target = fileTargetOf(request.input);
    if (!target) return ALLOW_LOCAL;
    return isInsideWorktree(target, request.worktreePath)
      ? ALLOW_LOCAL
      : deny('outside_worktree', `Refused: ${target} is outside this run's worktree (${request.worktreePath}). Only change files inside it.`);
  }
  if (FILE_READ_TOOLS.has(tool)) {
    // The project's own files (its .env included) are the agent's to read;
    // credential-shaped files elsewhere on the machine are not.
    const target = fileTargetOf(request.input);
    if (!target || isInsideWorktree(target, request.worktreePath)) return ALLOW_LOCAL;
    const absolute = path.resolve(request.worktreePath, target);
    if (isSensitivePath(absolute) || mentionsCredentialLocation(absolute)) {
      return deny('sensitive', `Refused: ${target} holds credentials outside this run's worktree.`);
    }
    if (insideClemHome(absolute)) {
      return deny('sensitive', `Refused: ${target} is Clem's own data, not part of this project.`);
    }
    return ALLOW_LOCAL;
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = typeof request.input.command === 'string' ? request.input.command : '';
    return shellDecision(command);
  }
  return ALLOW_LOCAL;
}
