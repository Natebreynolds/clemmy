import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import { BASE_DIR } from '../config.js';
import type { RuntimeContextValue } from '../types.js';
import { getWorkspaceDirs } from './shared.js';
import { loadProactivityPolicy } from '../agents/proactivity-policy.js';
import { needsApprovalFromTaxonomy } from '../agents/tool-taxonomy.js';

/**
 * Approval gate for SDK-native tools — delegates to the global
 * taxonomy in `agents/tool-taxonomy.ts`. The taxonomy layers:
 *
 *   1. ALWAYS_ADMIN list → ask regardless of scope.
 *   2. Hard denylist (`assertCommandAllowed` below) → enforced inside
 *      the tool's `execute`; even YOLO does not bypass it.
 *   3. Per-session PlanScope (user pre-approved a plan) → auto.
 *   4. Global ProactivityPolicy.autoApproveScope (strict/workspace/yolo).
 *
 * Computer tools compute `insideWorkspace` per-call from the user's
 * `path` / `cwd` argument and pass it through the factory.
 */
function inputIsInsideWorkspace(toolName: string, input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const obj = input as Record<string, unknown>;
  const target = toolName === 'write_file'
    ? (typeof obj.path === 'string' ? obj.path : '')
    : (typeof obj.cwd === 'string' && obj.cwd ? obj.cwd : process.cwd());
  if (!target) return false;
  try {
    const resolved = path.resolve(expandHome(target));
    return workspaceRoots().some((root) => isInside(root, resolved));
  } catch {
    return false;
  }
}

function needsApprovalUnlessInPlanScope(toolName: string) {
  return needsApprovalFromTaxonomy(toolName, {
    computeInsideWorkspace: (input) => inputIsInsideWorkspace(toolName, input),
  });
}

/**
 * Per-command read/write classifier for run_shell_command.
 *
 * Nathan's rule (2026-05-19): "It should be able to run shell and bash
 * to find what it needs and only ask approval to write." A blanket
 * "shell = approval" gate makes every discovery turn pause; the
 * common case is `sf data query`, `git status`, `ls`, `cat`, `--version`
 * — pure reads that should fire without friction.
 *
 * Conservative bias: when we can't recognize the command as a known
 * read shape, treat as write (require approval). Over-prompting beats
 * silently running a destructive op.
 */
function shellCommandIsReadOnly(rawCommand: unknown): boolean {
  if (typeof rawCommand !== 'string') return false;
  const cmd = rawCommand.trim();
  if (!cmd) return false;

  // Chain operators short-circuit to "write" — every linked command
  // would need to be classified individually. If you want to chain,
  // request approval for the whole thing.
  if (/[;&|]/.test(cmd.replace(/"[^"]*"|'[^']*'/g, ''))) return false;
  // Output redirection writes to disk.
  if (/>\s*\S/.test(cmd.replace(/"[^"]*"|'[^']*'/g, ''))) return false;
  // sudo / exec / eval are explicit privilege/scope expansions.
  if (/^\s*(sudo|exec|eval)\b/.test(cmd)) return false;

  const tokens = cmd.split(/\s+/);
  const head = tokens[0] ?? '';
  const second = tokens[1] ?? '';

  // Always-safe binaries (the unix read toolkit).
  const SAFE_BINARIES = new Set([
    'ls', 'cat', 'head', 'tail', 'less', 'more', 'file', 'stat', 'pwd', 'which',
    'type', 'whoami', 'hostname', 'uname', 'env', 'printenv', 'ps', 'top', 'df',
    'du', 'uptime', 'date', 'free', 'id', 'groups', 'history', 'echo', 'printf',
    'grep', 'find', 'wc', 'sort', 'uniq', 'tr', 'cut', 'awk', 'sed', 'jq', 'yq',
    'tree', 'realpath', 'readlink', 'basename', 'dirname',
  ]);
  if (SAFE_BINARIES.has(head)) return true;

  // --version / --help / -V / -h flags are universally informational
  // regardless of binary.
  if (tokens.some((t) => /^(--version|--help|-V|-h)$/.test(t))) return true;

  // Composite tools: classify by subcommand.
  const SUBCOMMAND_READ: Record<string, Set<string>> = {
    git: new Set([
      'status', 'log', 'diff', 'show', 'branch', 'remote', 'blame', 'grep',
      'ls-files', 'ls-tree', 'rev-parse', 'cat-file', 'tag', 'reflog',
      'describe', 'shortlog', 'whatchanged', 'fsck',
    ]),
    sf: new Set([
      'data', // 'sf data query' specifically — narrowed below
      'config', 'project',
    ]),
    npm: new Set(['list', 'ls', 'view', 'show', 'search', 'outdated', 'doctor', 'audit']),
    brew: new Set(['list', 'info', 'search', 'outdated', 'leaves', 'deps', 'home']),
    pip: new Set(['list', 'show', 'search', 'check']),
    pip3: new Set(['list', 'show', 'search', 'check']),
    gem: new Set(['list', 'info', 'search']),
    docker: new Set(['ps', 'images', 'logs', 'inspect', 'version', 'info', 'stats']),
    kubectl: new Set(['get', 'describe', 'logs', 'version', 'config', 'top', 'explain']),
    gh: new Set(['repo', 'pr', 'issue', 'run', 'workflow', 'release', 'auth', 'api', 'browse', 'status']),
    aws: new Set(['s3', 'ec2', 'iam', 'sts']), // many AWS subcommands are read-only describe/list; we err to "needs approval" via fallback
  };

  const readSubs = SUBCOMMAND_READ[head];
  if (readSubs && readSubs.has(second)) {
    // Narrow further for the ones that have both read AND write
    // verbs nested another level deep.
    if (head === 'sf' && second === 'data') {
      // `sf data query` is a SOQL SELECT (read). `sf data update/insert/delete/upsert/import` mutate.
      return tokens[2] === 'query' || tokens[2] === 'search' || tokens[2] === 'get';
    }
    if (head === 'sf' && second === 'config') {
      // `sf config get/list` is read. `sf config set/unset` writes the local CLI config.
      return tokens[2] === 'get' || tokens[2] === 'list';
    }
    if (head === 'sf' && second === 'project') {
      // `sf project list` etc.; deploys/retrieves are writes.
      return tokens[2] === 'list' || tokens[2] === 'manifest';
    }
    if (head === 'gh' && (second === 'repo' || second === 'pr' || second === 'issue' || second === 'workflow' || second === 'release' || second === 'run')) {
      // gh has read verbs (view/list/checks) and write verbs (create/edit/merge/close).
      return ['view', 'list', 'status', 'checks', 'diff'].includes(tokens[2] ?? '');
    }
    return true;
  }

  // Unknown shape → conservative.
  return false;
}

/**
 * needsApproval wrapper specifically for run_shell_command. Inspects
 * the `command` arg and treats known-read commands as auto-approved
 * regardless of policy scope. Falls through to the default
 * execute-class behavior (which still respects plan-scope) for
 * write/unknown commands.
 */
function needsApprovalForShellSmart() {
  // We can't statically set kindHint because it depends on the actual
  // command. Build a fresh callback that classifies per-invocation.
  return async (runContext: unknown, input: unknown): Promise<boolean> => {
    const command = (input && typeof input === 'object' ? (input as Record<string, unknown>).command : undefined);
    if (shellCommandIsReadOnly(command)) return false; // never pause for read
    // Otherwise use the existing taxonomy path (execute kind, plan-scope honored, etc.).
    return needsApprovalUnlessInPlanScope('run_shell_command')(runContext, input);
  };
}

const MAX_COMMAND_OUTPUT_CHARS = 12000;
const DEFAULT_TIMEOUT_MS = 30_000;

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function workspaceRoots(): string[] {
  // $HOME is included so the agent can operate on any user file (the
  // natural workspace for "do work for me"). The path-allowlist check
  // is a soft barrier, not a TCC defense — TCC enforcement happens at
  // the OS level when child processes try to read protected dirs. The
  // tool description in run_shell_command steers the model away from
  // ~/Desktop, ~/Documents, ~/Downloads, and iCloud Drive (which TCC
  // blocks for sandboxed-app children); the model is expected to honor
  // that guidance.
  const roots = [os.homedir(), process.cwd(), BASE_DIR, ...getWorkspaceDirs()]
    .map((entry) => path.resolve(expandHome(entry)));
  return [...new Set(roots)];
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveAllowedPath(input: string): string {
  const resolved = path.resolve(expandHome(input));
  // YOLO mode lets the agent act anywhere the user can. The hard
  // command denylist (assertCommandAllowed) still applies on
  // run_shell_command, so destructive ops like `rm -rf /` remain
  // blocked even here.
  const policy = loadProactivityPolicy();
  if (policy.autoApproveScope === 'yolo') return resolved;

  const roots = workspaceRoots();
  if (!roots.some((root) => isInside(root, resolved))) {
    throw new Error(`Path is outside allowed workspace roots: ${resolved}. Switch to YOLO mode in Settings → Proactivity Policy if you want the agent to act anywhere, or add this dir to WORKSPACE_DIRS in ~/.clementine-next/.env.`);
  }
  return resolved;
}

function resolveAllowedCwd(input?: string): string {
  // Default to BASE_DIR (~/.clementine-next) rather than process.cwd() or
  // os.homedir(). The daemon writes to BASE_DIR constantly, so macOS App
  // Management TCC has already granted access — child shells spawned there
  // never EPERM. Defaulting to HOME or to TCC-protected HOME subdirectories
  // (Desktop, Documents, Downloads) causes child Node CLIs to throw
  // EPERM on uv_cwd. The model can still pass an explicit `cwd` that's
  // inside any allowed workspaceRoots() entry.
  return resolveAllowedPath(input?.trim() || BASE_DIR);
}

function truncateOutput(value: string, maxChars = MAX_COMMAND_OUTPUT_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function assertCommandAllowed(command: string): void {
  const normalized = command.toLowerCase().replace(/\s+/g, ' ').trim();
  const denied = [
    /\brm\s+-[^\n;|&]*r[^\n;|&]*f\s+(\/|\$home|~)(\s|$)/,
    /\bsudo\b/,
    /\bsu\s+-/,
    /\bshutdown\b/,
    /\breboot\b/,
    /\bdiskutil\s+erase/i,
    /\bdd\s+.*\bof=/,
    /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/,
    /\bmkfs\b/,
    /\bchmod\s+-r\s+777\s+(\/|\$home|~)/,
    /\bchown\s+-r\s+.*\s+(\/|\$home|~)/,
  ];
  if (denied.some((pattern) => pattern.test(normalized))) {
    throw new Error('Command denied by Clementine safety policy.');
  }
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<string> {
  assertCommandAllowed(command);
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout = truncateOutput(stdout + String(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderr = truncateOutput(stderr + String(chunk));
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const output = [
        `exit_code: ${code ?? 0}`,
        stdout ? `stdout:\n${stdout}` : '',
        stderr ? `stderr:\n${stderr}` : '',
      ].filter(Boolean).join('\n\n');
      resolve(output || `exit_code: ${code ?? 0}`);
    });
  });
}

function listDirectory(dir: string, limit: number): string {
  const resolved = resolveAllowedPath(dir);
  if (!existsSync(resolved)) return `Directory does not exist: ${resolved}`;
  if (!statSync(resolved).isDirectory()) return `Not a directory: ${resolved}`;
  return readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.name !== 'node_modules' && entry.name !== '.git')
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, Math.max(1, Math.min(500, limit)))
    .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
    .join('\n') || '(empty)';
}

export function getComputerTools(): Tool<RuntimeContextValue>[] {
  const workspace_roots = tool({
    name: 'workspace_roots',
    description: 'List directories Clementine is allowed to inspect or operate in.',
    parameters: z.object({}),
    execute: async () => workspaceRoots().map((root, index) => `${index + 1}. ${root}`).join('\n'),
  });

  const list_files = tool({
    name: 'list_files',
    description: 'List files in an allowed workspace directory. Use before reading or modifying project files.',
    parameters: z.object({
      directory: z.string().nullable(),
      limit: z.number().min(1).max(500).nullable(),
    }),
    execute: async ({ directory, limit }) => listDirectory(directory || process.cwd(), limit ?? 120),
  });

  const read_file = tool({
    name: 'read_file',
    description: 'Read a UTF-8 text file from an allowed workspace path.',
    parameters: z.object({
      path: z.string().min(1),
      max_chars: z.number().min(1).max(50000).nullable(),
    }),
    execute: async (input) => {
      const filePath = resolveAllowedPath(input.path);
      if (!existsSync(filePath)) return `File does not exist: ${filePath}`;
      if (!statSync(filePath).isFile()) return `Not a file: ${filePath}`;
      return readFileSync(filePath, 'utf-8').slice(0, input.max_chars ?? 20000);
    },
  });

  const write_file = tool({
    name: 'write_file',
    description: 'Write a UTF-8 file inside an allowed workspace. Requires approval because it modifies disk. Auto-approved if the session has an open PlanScope covering write_file.',
    parameters: z.object({
      path: z.string().min(1),
      content: z.string(),
    }),
    needsApproval: needsApprovalUnlessInPlanScope('write_file'),
    execute: async (input) => {
      const filePath = resolveAllowedPath(input.path);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, input.content.endsWith('\n') ? input.content : `${input.content}\n`, 'utf-8');
      return `Wrote ${filePath} (${input.content.length} chars).`;
    },
  });

  const run_shell_command = tool({
    name: 'run_shell_command',
    description: [
      'Run a shell command in an allowed workspace directory. Requires per-call approval UNLESS the session has an open PlanScope. Has output and time limits.',
      '',
      'CWD GUIDANCE: leave `cwd` null unless you have a specific reason to be elsewhere. On macOS, paths under ~/Desktop, ~/Documents, ~/Downloads, and iCloud Drive are TCC-protected from sandboxed-app children: child Node CLIs (sf, npm, etc.) spawned there throw EPERM on getcwd. The default cwd (Clementine\'s base directory, which the daemon already has TCC access to) is safe and works for tool invocations that don\'t actually depend on file context (CLI calls, API queries, etc.). Pass an explicit `cwd` only when the command genuinely needs to run in a specific project directory configured in WORKSPACE_DIRS.',
    ].join('\n'),
    parameters: z.object({
      command: z.string().min(1),
      cwd: z.string().nullable(),
      timeout_ms: z.number().min(1000).max(120000).nullable(),
    }),
    needsApproval: needsApprovalForShellSmart(),
    execute: async (input) => {
      const cwd = resolveAllowedCwd(input.cwd ?? undefined);
      return runCommand(input.command, cwd, input.timeout_ms ?? DEFAULT_TIMEOUT_MS);
    },
  });

  const git_status = tool({
    name: 'git_status',
    description: 'Run a read-only git status in an allowed workspace directory.',
    parameters: z.object({
      cwd: z.string().nullable(),
    }),
    execute: async ({ cwd }) => runCommand('git status --short --branch', resolveAllowedCwd(cwd ?? undefined), 10_000),
  });

  return [workspace_roots, list_files, read_file, write_file, run_shell_command, git_status];
}
