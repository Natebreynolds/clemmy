import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import { BASE_DIR } from '../config.js';
import type { RuntimeContextValue } from '../types.js';
import { getWorkspaceDirs } from './shared.js';
import { isAutoApprovedByScope, recordAutoApproval, summarizeToolArgs } from '../agents/plan-scope.js';

/**
 * Plan-scope check used by the per-tool needsApproval gates below.
 * Returns true → SDK pauses for human approval. Returns false → call
 * runs immediately.
 *
 * If the session has an open, unexpired PlanScope that covers this
 * tool name, we auto-approve and log the call against the scope for
 * audit. Otherwise we fall back to the legacy "always requires
 * approval" behavior.
 *
 * Pure function shape so unit tests can target it cheaply.
 */
function extractSessionId(runContext: unknown): string | undefined {
  if (!runContext || typeof runContext !== 'object') return undefined;
  const ctx = (runContext as { context?: unknown }).context;
  if (!ctx || typeof ctx !== 'object') return undefined;
  const sid = (ctx as { sessionId?: unknown }).sessionId;
  return typeof sid === 'string' ? sid : undefined;
}

function needsApprovalUnlessInPlanScope(toolName: string) {
  return async (runContext: unknown, input: unknown): Promise<boolean> => {
    const sessionId = extractSessionId(runContext);
    if (!sessionId) return true;
    if (!isAutoApprovedByScope(sessionId, toolName)) return true;
    recordAutoApproval(sessionId, toolName, summarizeToolArgs(toolName, input));
    return false;
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
  const roots = [process.cwd(), BASE_DIR, ...getWorkspaceDirs()]
    .map((entry) => path.resolve(expandHome(entry)));
  return [...new Set(roots)];
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveAllowedPath(input: string): string {
  const resolved = path.resolve(expandHome(input));
  const roots = workspaceRoots();
  if (!roots.some((root) => isInside(root, resolved))) {
    throw new Error(`Path is outside allowed workspace roots: ${resolved}`);
  }
  return resolved;
}

function resolveAllowedCwd(input?: string): string {
  return resolveAllowedPath(input?.trim() || process.cwd());
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
    description: 'Run a shell command in an allowed workspace directory. Requires per-call approval UNLESS the session has an open PlanScope (the user pre-approved a plan covering this kind of work). Has output and time limits.',
    parameters: z.object({
      command: z.string().min(1),
      cwd: z.string().nullable(),
      timeout_ms: z.number().min(1000).max(120000).nullable(),
    }),
    needsApproval: needsApprovalUnlessInPlanScope('run_shell_command'),
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
