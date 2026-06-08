import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import { BASE_DIR } from '../config.js';
import type { RuntimeContextValue } from '../types.js';
import { getWorkspaceDirs } from './shared.js';
import { loadProactivityPolicy } from '../agents/proactivity-policy.js';
import { needsApprovalFromTaxonomy } from '../agents/tool-taxonomy.js';
import { findSafeCliCommand } from '../runtime/cli-discovery.js';
import { mergedSpawnEnv } from '../runtime/spawn-env.js';
import { isConvertibleExtension } from '../runtime/markitdown.js';
import { ingestAttachment } from '../runtime/attachments.js';
import { formatRecallableToolText } from '../runtime/harness/tool-output-format.js';
import { callIdFromToolDetails, sessionIdFromRunContext } from '../runtime/harness/tool-output-context.js';
import { isSensitivePath, redactSensitiveText, shellCommandTouchesSensitiveData } from '../runtime/security.js';

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
function resolveTargetPath(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const target = toolName === 'write_file' || toolName === 'read_file'
    ? (typeof obj.path === 'string' ? obj.path : '')
    : (typeof obj.cwd === 'string' && obj.cwd ? obj.cwd : process.cwd());
  if (!target) return null;
  try {
    return path.resolve(expandHome(target));
  } catch {
    return null;
  }
}

function inputIsInsideWorkspace(toolName: string, input: unknown): boolean {
  const resolved = resolveTargetPath(toolName, input);
  if (!resolved) return false;
  // Shell/execute auto-approval uses the narrow user-workspace list
  // (no $HOME). write_file is Clementine's local artifact surface, so
  // it uses the same allowed-root list as resolveAllowedPath().
  const roots = toolName === 'write_file' ? workspaceRoots() : userWorkspaceRoots();
  return roots.some((root) => isInside(root, resolved));
}

function inputIsInsideAgentOwnedDir(toolName: string, input: unknown): boolean {
  const resolved = resolveTargetPath(toolName, input);
  if (!resolved) return false;
  return agentOwnedRoots().some((root) => isInside(root, resolved));
}

function needsApprovalUnlessInPlanScope(toolName: string) {
  return needsApprovalFromTaxonomy(toolName, {
    computeInsideWorkspace: (input) => inputIsInsideWorkspace(toolName, input),
    computeInsideAgentOwnedDir: (input) => inputIsInsideAgentOwnedDir(toolName, input),
  });
}

/**
 * Per-command danger classifier for run_shell_command.
 *
 * Nathan's mental model (2026-05-19): "Clementine has shell access.
 * Bash is bash. Don't make me approve every `ls` or `sf data query`.
 * Only ask when something destructive is about to happen." That
 * inverts the previous polarity: default AUTO-APPROVE, deny-list the
 * known destructive shapes. The hard-block list in
 * `assertCommandAllowed` still applies on top (rm -rf /, sudo,
 * shutdown, etc.); this gate is the softer "human-in-the-loop please"
 * checkpoint for ops that mutate state outside Clementine.
 */
export function shellCommandNeedsApproval(rawCommand: unknown): boolean {
  if (typeof rawCommand !== 'string') return true; // unparseable → ask
  const cmd = rawCommand.trim();
  if (!cmd) return true;

  // Strip quoted segments so the patterns don't false-positive on a
  // SOQL string like "DELETE FROM …" inside `sf data query --query "..."`.
  const stripped = cmd.replace(/"[^"]*"|'[^']*'/g, ' ').toLowerCase();

  // Output redirection writes to disk (> file, >> file, |tee).
  if (/>\s*\S/.test(stripped) || /\|\s*tee\b/.test(stripped)) return true;

  // sudo / su escalate privileges — always ask.
  if (/(^|[\s;&|])sudo\b/.test(stripped) || /(^|[\s;&|])su\s+-/.test(stripped)) return true;

  // Destructive patterns — file/dir mutations, system changes, process control,
  // remote mutations, package installs, CRM/SaaS data writes.
  const DANGER_PATTERNS: RegExp[] = [
    // Filesystem mutations
    /(^|[\s;&|])(rm|rmdir|unlink|trash)\b/,
    /(^|[\s;&|])mv\b/,
    /(^|[\s;&|])cp\s+-[a-z]*r/,                  // recursive copy (full-tree write)
    /(^|[\s;&|])(chmod|chown|chgrp)\b/,
    /(^|[\s;&|])(ln|link)\s+-s?/,                // symlink creation
    /(^|[\s;&|])mkfs\b/,
    /(^|[\s;&|])dd\s+.*\bof=/,
    // Process control
    /(^|[\s;&|])(kill|killall|pkill)\b/,
    // System-level state changes
    /(^|[\s;&|])defaults\s+(write|delete)/,
    /(^|[\s;&|])launchctl\s+(load|unload|bootstrap|bootout|kickstart|enable|disable)/,
    /(^|[\s;&|])pmset\b/,
    /(^|[\s;&|])networksetup\b/,
    // Package managers (installing software is a real change)
    /(^|[\s;&|])npm\s+(install|i\b|uninstall|un\b|remove|rm\b|publish|run|exec|update|audit\s+fix)/,
    /(^|[\s;&|])(yarn|pnpm)\s+(add|remove|install|publish|run)/,
    /(^|[\s;&|])brew\s+(install|uninstall|reinstall|upgrade|update|cleanup|tap|untap|link|unlink|cask)/,
    /(^|[\s;&|])(pip|pip3)\s+(install|uninstall|wheel)/,
    /(^|[\s;&|])gem\s+(install|uninstall|update)/,
    /(^|[\s;&|])cargo\s+(install|publish|uninstall)/,
    /(^|[\s;&|])go\s+(install|get|mod\s+tidy)/,
    // Git mutations / data-loss
    /(^|[\s;&|])git\s+(push|merge|rebase|reset\s+--hard|clean\s+-[a-z]*[df]|checkout\s+--|restore\s+--source|branch\s+-d|tag\s+-d|remote\s+(add|remove|rm)|stash\s+drop|stash\s+clear|filter-branch|gc\s+--prune)/,
    // Docker / k8s mutations
    /(^|[\s;&|])docker\s+(run|rm|rmi|stop|start|kill|build|push|exec|cp|tag|commit|prune|system\s+prune)/,
    /(^|[\s;&|])kubectl\s+(apply|create|delete|edit|patch|replace|rollout|scale|cordon|drain|exec|cp|attach|debug|run)/,
    // Salesforce CLI writes
    /(^|[\s;&|])sf\s+(data\s+(update|insert|delete|upsert|import|tree)|org\s+(login|logout|create|delete|open|display|switch)|project\s+(deploy|retrieve|delete|generate)|deploy\b|alias\s+(set|unset))/,
    // GitHub CLI mutations
    /(^|[\s;&|])gh\s+(repo\s+(create|delete|fork|clone|sync|edit|archive|rename|set-default)|pr\s+(create|close|merge|edit|review|comment|ready|reopen)|issue\s+(create|close|edit|comment|reopen|transfer|delete|pin|unpin)|release\s+(create|delete|edit|upload|download)|workflow\s+(run|disable|enable)|secret\s+(set|delete)|auth\s+(login|logout|refresh|token)|api\s+(post|put|patch|delete))/,
    // HTTP mutations
    /(^|[\s;&|])curl\s+.*-X\s*(POST|PUT|DELETE|PATCH)/i,
    /(^|[\s;&|])curl\s+.*(--data|--data-raw|--data-binary|--data-urlencode|-d\s)/,
    /(^|[\s;&|])curl\s+.*--upload-file/,
    /(^|[\s;&|])(wget|wget2)\s+.*(--post-data|--post-file)/,
    // AWS / cloud mutations
    /(^|[\s;&|])aws\s+\S+\s+(create|update|put|delete|terminate|deregister|associate|disassociate|enable|disable|attach|detach|start|stop|reboot|run-instances|publish|send)/,
    /(^|[\s;&|])gcloud\s+\S+\s+(create|update|delete|enable|disable|set)/,
    /(^|[\s;&|])(terraform|tofu)\s+(apply|destroy|init|import|state\s+(rm|mv|push)|workspace\s+(new|delete))/,
    /(^|[\s;&|])(ansible|ansible-playbook)\b/,
    // Static-site / serverless deploys — a public, externally-visible write.
    // A workflow step's plan-scope (['*']) auto-approves the SCHEDULED redeploy;
    // this only pauses the FIRST ad-hoc chat deploy so a busy owner sees it once.
    /(^|[\s;&|])(netlify|vercel|wrangler|firebase|gh-pages)\s+(deploy|publish|--prod)/,
    /(^|[\s;&|])surge\s/,
    // Scary tools
    /(^|[\s;&|])(eval|exec|source|\.)\s/,
    /(^|[\s;&|])history\s+-c/,
    /(^|[\s;&|])(crontab|launchd)\s+-r/,
  ];

  return DANGER_PATTERNS.some((re) => re.test(stripped));
}

/**
 * needsApproval wrapper specifically for run_shell_command. Inspects
 * the `command` arg and treats known-read commands as auto-approved
 * regardless of policy scope. Falls through to the default
 * execute-class behavior (which still respects plan-scope) for
 * write/unknown commands.
 */
function needsApprovalForShellSmart() {
  // Inverted polarity: auto-approve by default; pause only on
  // recognized destructive shapes (rm, git push, package installs,
  // sf data update, curl POST, etc.). The full hard-block list in
  // assertCommandAllowed still applies at the binary level for the
  // truly catastrophic shapes (rm -rf /, sudo, shutdown).
  return async (runContext: unknown, input: unknown): Promise<boolean> => {
    const command = (input && typeof input === 'object' ? (input as Record<string, unknown>).command : undefined);
    if (typeof command === 'string' && shellCommandTouchesSensitiveData(command)) return true;
    if (!shellCommandNeedsApproval(command)) return false;
    // Destructive pattern matched — still honor plan-scope so an
    // approved plan can pre-cover the whole thing.
    return needsApprovalUnlessInPlanScope('run_shell_command')(runContext, input);
  };
}

function inputTargetsSensitivePath(toolName: string, input: unknown): boolean {
  const resolved = resolveTargetPath(toolName, input);
  return Boolean(resolved && isSensitivePath(resolved));
}

function needsApprovalForReadFile() {
  return async (_runContext: unknown, input: unknown): Promise<boolean> => inputTargetsSensitivePath('read_file', input);
}

function needsApprovalForWriteFile() {
  const base = needsApprovalUnlessInPlanScope('write_file');
  return async (runContext: unknown, input: unknown): Promise<boolean> => {
    if (inputTargetsSensitivePath('write_file', input)) return true;
    return base(runContext, input);
  };
}

const MAX_COMMAND_CAPTURE_CHARS = 200_000;
const DEFAULT_TIMEOUT_MS = 30_000;

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function agentOwnedRoots(): string[] {
  // BASE_DIR (~/.clementine-next) is the agent's own data directory:
  // vault, harness.db, logs, state, meeting-capture/analysis/ outputs.
  // Writing here is bookkeeping the agent OWNS — not a user-visible
  // action — so it auto-approves regardless of scope.
  return [path.resolve(BASE_DIR)];
}

function userWorkspaceRoots(): string[] {
  // The "workspace" scope means: dirs the user explicitly opted into.
  // We include BASE_DIR (agent's own) and the daemon's cwd for safety,
  // PLUS whatever the user listed in WORKSPACE_DIRS. We deliberately
  // do NOT include $HOME — that's reserved for the hard-boundary list
  // (workspaceRoots) so explicit "write to ~/Documents" still works
  // with approval, but auto-approve under "workspace" scope is limited
  // to dirs the user actually declared.
  const roots = [process.cwd(), BASE_DIR, ...getWorkspaceDirs()]
    .map((entry) => path.resolve(expandHome(entry)));
  return [...new Set(roots)];
}

function workspaceRoots(): string[] {
  // Hard-boundary list used by resolveAllowedPath(). $HOME is included
  // so the agent CAN write to ~/Documents/foo.txt when the user
  // explicitly asks (with approval). TCC enforcement happens at the OS
  // level when child processes try to read protected dirs. The tool
  // description in run_shell_command steers the model away from
  // ~/Desktop, ~/Documents, ~/Downloads, and iCloud Drive (which TCC
  // blocks for sandboxed-app children); the model is expected to honor
  // that guidance. The auto-approve hint uses userWorkspaceRoots()
  // (narrower) so "workspace" scope means what the dropdown says.
  const roots = [os.homedir(), ...userWorkspaceRoots()];
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
    // List the valid roots IN the error so the agent self-corrects on
    // the first retry instead of guessing again. Before this change,
    // a bad cwd ("/Users/nate", "/Users/Shared", invented from
    // preferredName) would loop 7-8 times against the same wrong path
    // before the agent finally thought to call workspace_roots.
    // Architectural fix beats a prompt nudge: the failing tool tells
    // the agent the answer instead of relying on the model to remember.
    const rootsList = roots.map((r) => `  - ${r}`).join('\n');
    throw new Error(
      `Path is outside allowed workspace roots: ${resolved}.\n`
      + `Allowed roots:\n${rootsList}\n`
      + `Pick one of these as cwd, or omit cwd to use the safe default (~/.clementine-next). `
      + `If you genuinely need to act outside these roots, switch to YOLO mode in Settings → Proactivity Policy, `
      + `or add the dir to WORKSPACE_DIRS in ~/.clementine-next/.env.`,
    );
  }
  return resolved;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
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

function appendCapturedOutput(current: string, chunk: string): string {
  if (current.length >= MAX_COMMAND_CAPTURE_CHARS) return current;
  const next = current + chunk;
  if (next.length <= MAX_COMMAND_CAPTURE_CHARS) return next;
  return `${next.slice(0, MAX_COMMAND_CAPTURE_CHARS)}\n...[capture stopped after ${MAX_COMMAND_CAPTURE_CHARS} chars]`;
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

function developerToolStubBlockMessage(command: string): string | null {
  const matches = command.matchAll(/(?:^|[;&|]\s*)([A-Za-z0-9_.+-]+)\b/g);
  for (const match of matches) {
    const binary = match[1];
    const safe = findSafeCliCommand(binary);
    if (safe?.skipped) {
      return `${binary} is unavailable: ${safe.reason} Install Xcode Command Line Tools or a standalone ${binary} binary before using this command.`;
    }
  }
  return null;
}

/**
 * Map raw shell stderr to actionable remediation hints. Without this,
 * the model sees `EPERM: operation not permitted, uv_cwd` and either
 * retries blindly or hands off with a confused error. Returns the
 * original stderr, optionally with one extra line appended explaining
 * what to do — visible to the model and to the dashboard reader.
 */
function annotateShellStderr(stderr: string, command: string): string {
  if (!stderr) return stderr;
  const hints: string[] = [];
  if (/EPERM:\s*operation not permitted,?\s*uv_cwd/i.test(stderr)) {
    hints.push(
      'CLEMENTINE HINT: macOS TCC blocked this Node-embedding CLI when spawned by the desktop daemon. ' +
      'Workarounds: (1) re-run via `clementine chat` in Terminal — the CLI entry point has no Electron parent and no TCC clamp; ' +
      '(2) replace this CLI call with the equivalent Composio tool; ' +
      '(3) grant Full Disk Access to Clementine.app in System Settings → Privacy & Security.',
    );
  } else if (/shell-init:\s*getcwd:\s*cannot access parent directories/i.test(stderr)) {
    hints.push(
      'CLEMENTINE HINT: bash could not resolve the current working directory. ' +
      'This typically means the cwd was deleted or is inside a TCC-protected folder; pass `cwd: null` or a path under WORKSPACE_DIRS.',
    );
  } else if (/(command not found|: not found)/i.test(stderr)) {
    const firstWord = command.trim().split(/\s+/)[0];
    hints.push(
      `CLEMENTINE HINT: "${firstWord}" is not on PATH. ` +
      `Install it via Homebrew/npm (\`brew install ${firstWord}\` or \`npm install -g ${firstWord}\`), or pick a different tool.`,
    );
  }
  if (hints.length === 0) return stderr;
  return `${stderr}\n\n${hints.join('\n')}`;
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<string> {
  assertCommandAllowed(command);
  const stubMessage = developerToolStubBlockMessage(command);
  if (stubMessage) return Promise.resolve(stubMessage);
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Augmented PATH so CLI-backed skills resolve on a packaged .app
      // launch instead of "command not found". See spawn-env.ts.
      env: mergedSpawnEnv(),
    });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout = appendCapturedOutput(stdout, String(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendCapturedOutput(stderr, String(chunk));
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const annotated = annotateShellStderr(stderr, command);
      const output = [
        `exit_code: ${code ?? 0}`,
        stdout ? `stdout:\n${stdout}` : '',
        annotated ? `stderr:\n${annotated}` : '',
      ].filter(Boolean).join('\n\n');
      resolve(output || `exit_code: ${code ?? 0}`);
    });
  });
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Augmented PATH so CLI-backed skills resolve on a packaged .app
      // launch instead of "command not found". See spawn-env.ts.
      env: mergedSpawnEnv(),
    });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout = appendCapturedOutput(stdout, String(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendCapturedOutput(stderr, String(chunk));
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const annotated = annotateShellStderr(stderr, command);
      const output = [
        `exit_code: ${code ?? 0}`,
        stdout ? `stdout:\n${stdout}` : '',
        annotated ? `stderr:\n${annotated}` : '',
      ].filter(Boolean).join('\n\n');
      resolve(output || `exit_code: ${code ?? 0}`);
    });
  });
}

function listDirectory(dir: string, limit: number): string {
  const resolved = resolveAllowedPath(dir);
  if (!existsSync(resolved)) return `Directory does not exist: ${resolved}`;
  if (!statSync(resolved).isDirectory()) return `Not a directory: ${resolved}`;
  const cap = Math.max(1, Math.min(500, limit));
  const entries = readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.name !== 'node_modules' && entry.name !== '.git')
    .sort((left, right) => left.name.localeCompare(right.name));
  const shown = entries.slice(0, cap).map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`);
  // Without this, an alphabetical slice silently drops the tail — a file that
  // sorts late reads as "not present". Tell the model how to widen.
  if (entries.length > cap) {
    shown.push(`…[${entries.length - cap} more entr${entries.length - cap === 1 ? 'y' : 'ies'} not shown; pass a higher limit (max 500) or a more specific directory]`);
  }
  return shown.join('\n') || '(empty)';
}

export function getComputerTools(): Tool<RuntimeContextValue>[] {
  const formatToolOutput = (toolName: string, runContext: unknown, details: unknown, output: string): string =>
    formatRecallableToolText(redactSensitiveText(output), {
      toolName,
      sessionId: sessionIdFromRunContext(runContext),
      callId: callIdFromToolDetails(details),
    });

  const workspace_roots = tool({
    name: 'workspace_roots',
    description: 'List directories Clementine is allowed to inspect or operate in.',
    parameters: z.object({}),
    execute: async (_input, runContext, details) => formatToolOutput(
      'workspace_roots',
      runContext,
      details,
      workspaceRoots().map((root, index) => `${index + 1}. ${root}`).join('\n'),
    ),
  });

  const list_files = tool({
    name: 'list_files',
    description: 'List files in an allowed workspace directory. Use before reading or modifying project files.',
    parameters: z.object({
      directory: z.string().nullable(),
      limit: z.number().min(1).max(500).nullable(),
    }),
    execute: async ({ directory, limit }, runContext, details) => formatToolOutput(
      'list_files',
      runContext,
      details,
      listDirectory(directory || process.cwd(), limit ?? 120),
    ),
  });

  // Clip read output to the char cap, but when the FULL content exceeds the
  // cap append a self-describing note with the true length + how to widen. The
  // slice happens BEFORE the result is parked, so without this note a clipped
  // large file (multi-page brief, extracted PDF, audit log) reads as complete
  // with no recovery path — confident wrong/incomplete answers. (~30-60 tokens,
  // only on oversized reads; net token-negative, it prevents blind re-reads.)
  const clipReadWithWidenNote = (content: string, cap: number, label: string): string =>
    content.length <= cap
      ? content
      : `${content.slice(0, cap)}\n\n…[${label} is ${content.length} chars; showing the first ${cap}. Re-call with a larger max_chars (up to 50000) to read more.]`;

  const read_file = tool({
    name: 'read_file',
    description: [
      'Read a file from an allowed workspace path.',
      'UTF-8 text is returned as-is. Other formats are transparently extracted to Markdown: PDF/Word/Excel/PowerPoint/EPub via the bundled markitdown runtime, images via vision OCR, and audio via transcription. The first markitdown conversion may take ~30-60s while the runtime warms.',
    ].join('\n'),
    parameters: z.object({
      path: z.string().min(1),
      max_chars: z.number().min(1).max(50000).nullable(),
    }),
    needsApproval: needsApprovalForReadFile(),
    execute: async (input, runContext, details) => {
      const filePath = resolveAllowedPath(input.path);
      if (!existsSync(filePath)) return `File does not exist: ${filePath}`;
      if (!statSync(filePath).isFile()) return `Not a file: ${filePath}`;
      if (isConvertibleExtension(filePath)) {
        // Route through the unified ingestion pipeline so audio→Whisper,
        // image→vision OCR, and docs→markitdown all behave identically here.
        const ingested = await ingestAttachment({ name: path.basename(filePath), sourcePath: filePath });
        if (ingested.error) return `Could not read ${path.basename(filePath)}: ${ingested.error}`;
        return formatToolOutput(
          'read_file',
          runContext,
          details,
          clipReadWithWidenNote(ingested.markdown ?? '', input.max_chars ?? 20000, path.basename(filePath)),
        );
      }
      return formatToolOutput(
        'read_file',
        runContext,
        details,
        clipReadWithWidenNote(readFileSync(filePath, 'utf-8'), input.max_chars ?? 20000, path.basename(filePath)),
      );
    },
  });

  const convert_to_markdown = tool({
    name: 'convert_to_markdown',
    description: [
      'Extract a non-text file (PDF, Word/Excel/PowerPoint, EPub, image, audio, …) into Markdown you can read.',
      'Use for any binary/Office document, image (OCR), or audio (transcript) the user references. (read_file also auto-routes these formats here.)',
      'Docs use the bundled markitdown runtime (first run ~30-60s to warm); images use vision OCR; audio uses transcription.',
    ].join('\n'),
    parameters: z.object({
      path: z.string().min(1),
      max_chars: z.number().min(1).max(50000).nullable(),
    }),
    needsApproval: needsApprovalForReadFile(),
    execute: async (input, runContext, details) => {
      const filePath = resolveAllowedPath(input.path);
      if (!existsSync(filePath)) return `File does not exist: ${filePath}`;
      if (!statSync(filePath).isFile()) return `Not a file: ${filePath}`;
      const ingested = await ingestAttachment({ name: path.basename(filePath), sourcePath: filePath });
      if (ingested.error) return `Conversion failed: ${ingested.error}`;
      return formatToolOutput(
        'convert_to_markdown',
        runContext,
        details,
        clipReadWithWidenNote(ingested.markdown ?? '', input.max_chars ?? 20000, path.basename(filePath)),
      );
    },
  });

  const write_file = tool({
    name: 'write_file',
    description: [
      'Create, append to, or overwrite a UTF-8 file inside an allowed local workspace path.',
      'mode=create or null creates a new file and refuses to replace an existing one.',
      'mode=append appends content to the existing file, adding a newline boundary when needed.',
      'mode=overwrite replaces the entire file; use only when the user asks to replace it or after reading the current file and preparing the full replacement.',
      'Auto-approved for allowed local paths; destructive/system paths remain blocked by the path boundary.',
    ].join('\n'),
    parameters: z.object({
      path: z.string().min(1),
      content: z.string(),
      mode: z.enum(['create', 'append', 'overwrite']).nullable(),
    }),
    needsApproval: needsApprovalForWriteFile(),
    execute: async (input) => {
      const filePath = resolveAllowedPath(input.path);
      const mode = input.mode ?? 'create';
      mkdirSync(path.dirname(filePath), { recursive: true });
      const exists = existsSync(filePath);
      if (exists && !statSync(filePath).isFile()) return `Refused to write ${filePath}: target exists and is not a file.`;
      const content = ensureTrailingNewline(input.content);

      if (mode === 'append') {
        const needsBoundary = exists && statSync(filePath).size > 0 && !readFileSync(filePath, 'utf-8').endsWith('\n');
        appendFileSync(filePath, `${needsBoundary ? '\n' : ''}${content}`, 'utf-8');
        return `Appended ${filePath} (${input.content.length} chars).`;
      }

      if (mode === 'create' && exists) {
        return [
          `Refused to overwrite existing file: ${filePath}.`,
          'Use mode="append" to add content, or mode="overwrite" only after reading the file and preparing the full replacement.',
        ].join(' ');
      }

      writeFileSync(filePath, content, 'utf-8');
      return `${mode === 'overwrite' ? 'Overwrote' : 'Wrote'} ${filePath} (${input.content.length} chars).`;
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
    execute: async (input, runContext, details) => {
      const cwd = resolveAllowedCwd(input.cwd ?? undefined);
      return formatToolOutput(
        'run_shell_command',
        runContext,
        details,
        await runCommand(input.command, cwd, input.timeout_ms ?? DEFAULT_TIMEOUT_MS),
      );
    },
  });

  const git_status = tool({
    name: 'git_status',
    description: 'Run a read-only git status in an allowed workspace directory.',
    parameters: z.object({
      cwd: z.string().nullable(),
    }),
    execute: async ({ cwd }, runContext, details) => {
      const git = findSafeCliCommand('git');
      if (!git || git.skipped) {
        const reason = git?.skipped ? git.reason : 'git was not found on PATH.';
        return `Git is unavailable: ${reason} Install Xcode Command Line Tools or a standalone Git binary to use git_status.`;
      }
      return formatToolOutput(
        'git_status',
        runContext,
        details,
        await runProcess(git.command, ['status', '--short', '--branch'], resolveAllowedCwd(cwd ?? undefined), 10_000),
      );
    },
  });

  return [workspace_roots, list_files, read_file, convert_to_markdown, write_file, run_shell_command, git_status];
}
