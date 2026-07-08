import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import { BASE_DIR } from '../config.js';
import type { RuntimeContextValue } from '../types.js';
import { AGENTS_DIR, DELEGATIONS_DIR, PENDING_ACTIONS_DIR, TEAM_COMMS_LOG, TEAM_REQUESTS_DIR, getWorkspaceDirs } from './shared.js';
import { loadProactivityPolicy } from '../agents/proactivity-policy.js';
import { needsApprovalFromTaxonomy } from '../agents/tool-taxonomy.js';
import { findSafeCliCommand } from '../runtime/cli-discovery.js';
import { mergedSpawnEnv } from '../runtime/spawn-env.js';
import { isConvertibleExtension } from '../runtime/markitdown.js';
import { ingestAttachment } from '../runtime/attachments.js';
import { formatRecallableToolText } from '../runtime/harness/tool-output-format.js';
import { callIdFromToolDetails, sessionIdFromRunContext } from '../runtime/harness/tool-output-context.js';
import { isSensitivePath, redactSensitiveText, shellCommandTouchesSensitiveData } from '../runtime/security.js';
import { SPACES_DIR, isValidSpaceSlug, spaceStore } from '../spaces/store.js';

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
    // Salesforce CLI writes. NOTE: `sf org display` is a READ (it prints the
    // connected-org details / access token) and `sf data query` is a READ
    // (SOQL SELECT) — neither mutates, so they are deliberately NOT listed.
    // Over-gating them parked read-only prospect pulls for approval (the
    // `sf org display && sf data query` shape, observed 2026-06-17).
    // `data create` was missing from the alternation — `sf data create record`
    // wrote real CRM Tasks with zero approval (proof converse-first, 2026-07-02).
    /(^|[\s;&|])sf\s+(data\s+(create|update|insert|delete|upsert|import|tree)|org\s+(login|logout|create|delete|switch)|project\s+(deploy|retrieve|delete|generate)|deploy\b|alias\s+(set|unset))/,
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
export function needsApprovalForShellSmart() {
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

export function needsApprovalForWriteFile() {
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

function workspaceAuthoringNotice(filePath: string): string | null {
  const root = path.resolve(SPACES_DIR);
  const rel = path.relative(root, filePath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    const parts = rel.split(path.sep).filter(Boolean);
    const slug = parts[0];
    const top = parts[1];
    if (!slug || !isValidSpaceSlug(slug) || (top !== 'view' && top !== 'data')) return null;
    if (spaceStore.get(slug)) {
      if (top === 'data') {
        return `WORKSPACE NOTICE: "${slug}" already exists. After changing data/${parts.slice(2).join('/') || '<runner>'}, call space_refresh("${slug}") or space_save with updated data_sources so the persisted dataset and status match the file.`;
      }
      return `WORKSPACE NOTICE: "${slug}" already exists. For a full view rewrite, call space_save({ slug: "${slug}", title: "...", view_path: "${filePath}", ... }) so the change is versioned and smoke-checked; for small edits, prefer space_edit_view.`;
    }

    const titleHint = slug.split('-').map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part).join(' ');
    const runnerHint = top === 'data' && parts[2]
      ? ` Declare this runner in data_sources, for example data_sources:[{id:"tasks",runner:"${parts[2]}",composio_slug:null,composio_args_json:null,schedule:null,timezone:null}].`
      : ' Include at least one data_sources entry when the workspace should be live/dynamic.';
    return [
      `WORKSPACE NOTICE: "${slug}" is NOT a registered Console workspace yet; raw files under spaces/<slug>/ do not create a workspace and /api/console/spaces/${slug} will return 404.`,
      `NEXT REQUIRED TOOL CALL before reporting done: space_save({slug:"${slug}",title:"${titleHint}",view_path:"${filePath}",data_sources:[...],actions:null,reengage_triggers:null,reengage_guidance:null,origin_session_id:null}).`,
      `${runnerHint} Do not report the workspace as ready until space_save returns "Created workspace".`,
    ].join(' ');
  }

  const pathParts = filePath.split(path.sep).filter(Boolean);
  const marker = pathParts.lastIndexOf('.clementine-next');
  if (marker === -1 || pathParts[marker + 1] !== 'spaces') return null;
  const slug = pathParts[marker + 2];
  const top = pathParts[marker + 3];
  if (!slug || !isValidSpaceSlug(slug) || (top !== 'view' && top !== 'data')) return null;
  const desired = path.join(SPACES_DIR, slug, ...pathParts.slice(marker + 3));
  return [
    `WORKSPACE NOTICE: wrote to ${filePath}, but this daemon's active Clementine home is ${BASE_DIR}.`,
    `The Console reads workspaces from ${SPACES_DIR}; ${filePath} is the wrong home for this run and /api/console/spaces/${slug} will still return 404.`,
    `Write the file to ${desired}, then call space_save with view_path under ${SPACES_DIR}.`,
  ].join(' ');
}

function typedClementineStateWriteNotice(filePath: string): string | null {
  const targets: Array<{ root: string; tool: string }> = [
    { root: AGENTS_DIR, tool: 'create_agent or update_agent' },
    { root: path.join(BASE_DIR, 'Vault', '00-System', 'agents'), tool: 'create_agent or update_agent' },
    { root: TEAM_REQUESTS_DIR, tool: 'team_request' },
    { root: DELEGATIONS_DIR, tool: 'delegate_task' },
    { root: PENDING_ACTIONS_DIR, tool: 'pending_action_queue or pending_action_record_result' },
  ];
  for (const target of targets) {
    const root = path.resolve(target.root);
    const rel = path.relative(root, filePath);
    if (rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel))) {
      return `Refused raw write to typed Clementine state: ${filePath}. Use ${target.tool} so validation, permissions, and audit logs stay consistent.`;
    }
  }
  if (path.resolve(filePath) === path.resolve(TEAM_COMMS_LOG)) {
    return `Refused raw write to Clementine team communication log: ${filePath}. Use team_message, team_request, team_reply, or delegate_task so the queue and audit trail stay consistent.`;
  }
  return null;
}

export function resolveAllowedCwd(input?: string): string {
  // Default to BASE_DIR (~/.clementine-next) rather than process.cwd() or
  // os.homedir(). The daemon writes to BASE_DIR constantly, so macOS App
  // Management TCC has already granted access — child shells spawned there
  // never EPERM. Defaulting to HOME or to TCC-protected HOME subdirectories
  // (Desktop, Documents, Downloads) causes child Node CLIs to throw
  // EPERM on uv_cwd. The model can still pass an explicit `cwd` that's
  // inside any allowed workspaceRoots() entry.
  const raw = input?.trim();
  // A model (esp. a BYO backend) can serialize a null cwd as the LITERAL string
  // "null"/"undefined" — which is truthy, so it would resolve to a non-existent
  // dir and make spawn fail with ENOENT on EVERY retry: an unrecoverable loop
  // (the live GLM `cwd:"null"` site-host failure). Treat those as "no cwd".
  if (!raw || raw === 'null' || raw === 'undefined' || raw === 'None') {
    return resolveAllowedPath(BASE_DIR);
  }
  const resolved = resolveAllowedPath(raw); // throws (self-correcting) if outside roots
  // An in-root but NON-EXISTENT cwd (typo, deleted dir) would also ENOENT-loop.
  // Throw a clear, self-correcting error instead — mirrors the outside-roots msg
  // so the model omits cwd or fixes it rather than retrying the same dead path.
  if (!existsSync(resolved)) {
    throw new Error(
      `cwd does not exist: ${resolved}. Omit cwd to use the safe default (~/.clementine-next), `
      + `or pass an existing directory inside an allowed workspace root.`,
    );
  }
  return resolved;
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

/**
 * Standing-instruction integrity: the memory store (memory.db /
 * consolidated_facts) is the system of record for pinned standing
 * instructions and constraint rows. The memory_* tools enforce
 * pin/constraint protection + audit notifications; raw `sqlite3` / SQL
 * against the store walks around ALL of that (found live 2026-06-12: the
 * model flipped a pinned constraint's `active`/`pinned` columns via shell
 * when memory_pin wasn't in its surface). So: refuse a shell command that
 * BOTH references the memory store AND carries a mutating SQL verb against
 * the facts tables. Read-only inspection (SELECT/.schema/.tables/.dump) is
 * untouched — only mutation is blocked, with a pointer to the right tools.
 * Pure + exported for tests.
 */
const MEMORY_STORE_REF = /\b(memory\.db|consolidated_facts|fact_embeddings)\b/i;
const MUTATING_SQL = /\b(update|delete\s+from|insert\s+into|drop\s+table|alter\s+table|replace\s+into|truncate)\b/i;
const FACTS_TABLE_REF = /\b(consolidated_facts|fact_embeddings)\b/i;

export function shellMutatesMemoryStore(rawCommand: unknown): boolean {
  if (typeof rawCommand !== 'string') return false;
  const cmd = rawCommand;
  if (!MEMORY_STORE_REF.test(cmd)) return false;
  if (!MUTATING_SQL.test(cmd)) return false;
  // Require the mutation to actually target the facts tables (not, say, an
  // UPDATE against an unrelated table in a command that merely mentions the
  // path in a comment). Conservative: if a facts table is named anywhere
  // alongside a mutating verb, block.
  return FACTS_TABLE_REF.test(cmd) || /memory\.db/i.test(cmd);
}

const SKILL_ARTIFACT_DIRS = new Set(['output', 'outputs', 'runs', 'artifacts', 'reports', 'tmp', '.tmp']);

function installedSkillsRoot(): string {
  return path.join(BASE_DIR, 'skills');
}

function installedSkillPathParts(filePath: string): string[] | null {
  const resolved = path.resolve(expandHome(filePath));
  const root = path.resolve(installedSkillsRoot());
  if (!isInside(root, resolved)) return null;
  const rel = path.relative(root, resolved);
  if (!rel) return [];
  return rel.split(path.sep).filter(Boolean);
}

function isInstalledSkillArtifactPath(filePath: string): boolean {
  const parts = installedSkillPathParts(filePath);
  if (!parts || parts.length < 2) return false;
  return SKILL_ARTIFACT_DIRS.has(parts[1]);
}

export function isProtectedInstalledSkillSourcePath(filePath: string): boolean {
  const parts = installedSkillPathParts(filePath);
  if (!parts) return false;
  return !isInstalledSkillArtifactPath(filePath);
}

function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const flush = () => {
    if (current) tokens.push(current);
    current = '';
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch) || /[;&|<>]/.test(ch)) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return tokens;
}

function outputRedirectionTargets(command: string): string[] {
  const targets: string[] = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch !== '>') continue;

    i += 1;
    if (command[i] === '>') i += 1;
    while (i < command.length && /\s/.test(command[i])) i += 1;
    if (i >= command.length) break;

    const targetQuote = command[i] === '"' || command[i] === "'" ? command[i] : null;
    if (targetQuote) i += 1;
    let target = '';
    for (; i < command.length; i += 1) {
      const targetCh = command[i];
      if (targetQuote) {
        if (targetCh === targetQuote) break;
        target += targetCh;
      } else if (/\s/.test(targetCh) || /[;&|<>]/.test(targetCh)) {
        i -= 1;
        break;
      } else {
        target += targetCh;
      }
    }
    if (target) targets.push(target);
  }

  return targets;
}

function resolveShellPathToken(token: string, cwd: string): string | null {
  const cleaned = token.trim();
  if (!cleaned || cleaned.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(cleaned)) return null;
  const expanded = cleaned
    .replace(/^\$\{HOME\}(?=\/|$)/, os.homedir())
    .replace(/^\$HOME(?=\/|$)/, os.homedir());
  if (expanded.includes('*') || expanded.includes('?') || expanded.includes('$(') || expanded.includes('`')) return null;
  const homeExpanded = expandHome(expanded);
  return path.isAbsolute(homeExpanded) ? path.resolve(homeExpanded) : path.resolve(cwd, homeExpanded);
}

function tokenResolvesToProtectedSkillSource(token: string, cwd: string): boolean {
  const resolved = resolveShellPathToken(token, cwd);
  return Boolean(resolved && isProtectedInstalledSkillSourcePath(resolved));
}

function tokenResolvesToSkillArtifact(token: string, cwd: string): boolean {
  const resolved = resolveShellPathToken(token, cwd);
  return Boolean(resolved && isInstalledSkillArtifactPath(resolved));
}

function shellWriteApiTargets(command: string, cwd: string): boolean {
  const apiWrite = /\b(?:writeFileSync|appendFileSync|createWriteStream|copyFileSync|renameSync|rmSync|unlinkSync|mkdirSync)\s*\(/.test(command);
  if (!apiWrite) return false;
  const quotedPath = command.matchAll(/(?:writeFileSync|appendFileSync|createWriteStream|copyFileSync|renameSync|rmSync|unlinkSync|mkdirSync)\s*\(\s*['"]([^'"]+)['"]/g);
  let sawPath = false;
  for (const match of quotedPath) {
    sawPath = true;
    if (tokenResolvesToProtectedSkillSource(match[1], cwd)) return true;
  }
  return !sawPath && isProtectedInstalledSkillSourcePath(cwd);
}

function shellCommandTargetsProtectedSkillSource(command: string, cwd: string): boolean {
  const tokens = tokenizeShell(command);

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const binary = path.basename(token);
    if (binary === 'tee') {
      const targets = tokens.slice(i + 1).filter((entry) => !entry.startsWith('-'));
      if (targets.some((entry) => tokenResolvesToProtectedSkillSource(entry, cwd))) return true;
    }
    const args = tokens.slice(i + 1).filter((entry) => !entry.startsWith('-'));
    if (binary === 'cp' || binary === 'install') {
      const target = args.at(-1);
      if (target && tokenResolvesToProtectedSkillSource(target, cwd)) return true;
      continue;
    }
    if (binary === 'mv') {
      if (args.some((entry) => tokenResolvesToProtectedSkillSource(entry, cwd))) return true;
      continue;
    }
    if (binary === 'touch' || binary === 'mkdir') {
      if (args.some((entry) => tokenResolvesToProtectedSkillSource(entry, cwd))) return true;
    }
  }

  return false;
}

export function shellWritesInstalledSkillSource(rawCommand: unknown, cwdInput?: string): boolean {
  if (typeof rawCommand !== 'string') return false;
  const cwd = path.resolve(expandHome(cwdInput || BASE_DIR));
  const command = rawCommand.trim();
  if (!command) return false;

  const redirectionTargets = outputRedirectionTargets(command);
  if (redirectionTargets.some((target) => tokenResolvesToProtectedSkillSource(target, cwd))) return true;

  if (isProtectedInstalledSkillSourcePath(cwd)) {
    if (redirectionTargets.length > 0 && redirectionTargets.some((target) => !tokenResolvesToSkillArtifact(target, cwd))) return true;
    if (/\b(?:sed|perl)\s+-[A-Za-z0-9]*i[A-Za-z0-9]*\b/.test(command)) return true;
  }

  return shellCommandTargetsProtectedSkillSource(command, cwd) || shellWriteApiTargets(command, cwd);
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
export function annotateShellStderr(stderr: string, command: string): string {
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
  } else if (/\b404\b|\bno such (?:team|account|site|project)\b|account[-\s]?slug|\bunauthoriz|\bnot authoriz|\bforbidden\b|invalid (?:team|account|slug|site|project)/i.test(stderr)) {
    // RECOVERABLE config error (2026-06-15: a netlify `404: Not Found` from a
    // wrong --account-slug). The value is DISCOVERABLE — nudge diagnose-then-
    // retry, NOT surrender. Checked BEFORE the not-on-PATH branch so a "404:
    // Not Found" stops getting mislabeled "binary missing" (the false hint that
    // sent the model chasing an install instead of the right team slug).
    hints.push(
      'CLEMENTINE HINT (recoverable): this is a WRONG or MISSING config value (team/account/slug/id), not a dead end — it is DISCOVERABLE. Do NOT give up, call it impossible, or ask the user for it. Find the right value with the tool\'s own discovery command (e.g. `netlify api listAccountsForUser` for the real --account-slug, or `<cli> whoami`/`status`/`list`), OR recall your saved choice for this action with `tool_choice_recall(intent)`, then RETRY with the correct value. Do NOT re-issue the identical failing command.',
    );
  } else if (/unsettled top-level await|\?\s*Team:|Use arrow keys/i.test(stderr)) {
    // The CLI tried to open an INTERACTIVE prompt (no TTY here → it hangs/exits
    // 13). Re-run non-interactively (2026-06-15: `netlify sites:create` hung on
    // the team picker; `npx netlify-cli … --json` + an explicit value clears it).
    hints.push(
      'CLEMENTINE HINT (recoverable): the CLI tried to open an INTERACTIVE prompt (e.g. a team picker) but there is no terminal here, so it hung/failed. Re-run NON-INTERACTIVELY: add `--json` and pass the needed value explicitly — discover it first if unknown (e.g. `netlify api listAccountsForUser` for the team). Do NOT repeat the interactive command unchanged.',
    );
  } else if (/command not found|(?:^|\s)[a-zA-Z][\w./-]*: not found\b/i.test(stderr)) {
    // Tightened (2026-06-15): require a real command-not-found shape so an HTTP
    // "404: Not Found" no longer matches and falsely claims the binary is absent.
    const firstWord = command.trim().split(/\s+/)[0];
    hints.push(
      `CLEMENTINE HINT: "${firstWord}" is not on PATH. ` +
      `Install it via Homebrew/npm (\`brew install ${firstWord}\` or \`npm install -g ${firstWord}\`), or pick a different tool.`,
    );
  }
  if (hints.length === 0) return stderr;
  return `${stderr}\n\n${hints.join('\n')}`;
}

/**
 * Map a spawn-LEVEL failure to an actionable, self-correcting message.
 *
 * This is distinct from annotateShellStderr (which annotates the stderr of a
 * command that actually RAN). A spawn-level failure is emitted on the child's
 * `error` event — the process could not even start. The two get conflated at
 * the cost of self-correction: the model only ever saw the raw `spawn /bin/sh
 * ENOENT`, which names NEITHER the cwd nor the binary as the cause, so it could
 * not tell what to change and re-issued the identical call until the loop
 * guardrail ended the turn (the live 2026-06-20 site-host failure). Every branch
 * names the likely cause AND tells the model not to repeat the call unchanged.
 */
export function annotateSpawnError(error: unknown, command: string, cwd?: string): string {
  const err = error as NodeJS.ErrnoException | undefined;
  const base = err?.message ? String(err.message) : String(error);
  const code = err?.code;
  const firstWord = command.trim().split(/\s+/)[0] || 'the command';
  if (code === 'ENOENT') {
    return `${base}\n\n`
      + `CLEMENTINE HINT (recoverable): the process could not be spawned (ENOENT). The two likely causes are `
      + `(1) the working directory does not exist${cwd ? ` — cwd was "${cwd}"` : ''}, or `
      + `(2) the binary "${firstWord}" is not on PATH. `
      + `Fix the cause before retrying: omit \`cwd\` to use the safe default (~/.clementine-next) or pass an existing directory inside an allowed workspace root; `
      + `if it's the binary, install it (\`brew install ${firstWord}\` / \`npm install -g ${firstWord}\`) or pick another tool. `
      + `Do NOT re-issue the identical command — it will fail the same way.`;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `${base}\n\n`
      + `CLEMENTINE HINT (recoverable): permission denied (${code}) starting the process. `
      + `The binary may not be executable, or the cwd/file is in a protected location. `
      + `Omit \`cwd\` to fall back to the safe default, make the file executable (\`chmod +x\`), or use the equivalent Composio tool. `
      + `Do NOT re-issue the identical command unchanged.`;
  }
  // Unknown spawn error — still run the message through the stderr annotator in
  // case it matches a known recoverable pattern; otherwise return it plainly.
  return annotateShellStderr(base, command);
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
      // A spawn-level failure (ENOENT/EACCES/…) never reaches the close handler
      // and so never hit annotateShellStderr — the model saw the raw error and
      // could not self-correct. Annotate it here so the cause + fix ride back.
      reject(new Error(annotateSpawnError(error, command, cwd)));
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
      reject(new Error(annotateSpawnError(error, command, cwd)));
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

/** Authoritative parameter shapes — the SINGLE SOURCE for write_file /
 *  run_shell_command. The tool() defs below build their `parameters` from these,
 *  and the gated MCP lane (gated-mutating-tools.ts) derives its Claude-facing
 *  schema from them too, so the two can never drift (TOOL-REGISTRY-PLAN C3). */
export const WRITE_FILE_PARAMS = {
  path: z.string().min(1),
  content: z.string(),
  mode: z.enum(['create', 'append', 'overwrite']).nullable(),
} satisfies z.ZodRawShape;

export const RUN_SHELL_COMMAND_PARAMS = {
  command: z.string().min(1),
  cwd: z.string().nullable(),
  timeout_ms: z.number().min(1000).max(120000).nullable(),
} satisfies z.ZodRawShape;

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
      // HTML/HTM are TEXT — read the raw source. A Workspace view is edited AS
      // HTML, so routing it through markitdown strips the tags (and was erroring
      // on workspace views: "An error occurred while running the tool"). Only
      // non-text formats (PDF/Word/Excel/audio/images) take the ingest path.
      const readExt = path.extname(filePath).toLowerCase();
      const isHtmlSource = readExt === '.html' || readExt === '.htm';
      if (isConvertibleExtension(filePath) && !isHtmlSource) {
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
      'Installed skill source files under ~/.clementine-next/skills/<skill>/ are read-only; generated artifacts belong under output/, outputs/, runs/, artifacts/, reports/, or tmp/.',
      'Auto-approved for allowed local paths; destructive/system paths remain blocked by the path boundary.',
    ].join('\n'),
    parameters: z.object(WRITE_FILE_PARAMS),
    needsApproval: needsApprovalForWriteFile(),
    execute: async (input) => {
      const filePath = resolveAllowedPath(input.path);
      if (isProtectedInstalledSkillSourcePath(filePath)) {
        return [
          `Refused to write ${filePath}: installed skill source files are read-only during skill runs.`,
          'Write generated artifacts under the skill output/, outputs/, runs/, artifacts/, reports/, or tmp/ directory, or update the skill package through the skill install/update path.',
        ].join(' ');
      }
      const teamNotice = typedClementineStateWriteNotice(filePath);
      if (teamNotice) return teamNotice;
      const mode = input.mode ?? 'create';
      mkdirSync(path.dirname(filePath), { recursive: true });
      const exists = existsSync(filePath);
      if (exists && !statSync(filePath).isFile()) return `Refused to write ${filePath}: target exists and is not a file.`;
      const content = ensureTrailingNewline(input.content);

      if (mode === 'append') {
        const needsBoundary = exists && statSync(filePath).size > 0 && !readFileSync(filePath, 'utf-8').endsWith('\n');
        appendFileSync(filePath, `${needsBoundary ? '\n' : ''}${content}`, 'utf-8');
        const notice = workspaceAuthoringNotice(filePath);
        return [`Appended ${filePath} (${input.content.length} chars).`, notice].filter(Boolean).join('\n\n');
      }

      if (mode === 'create' && exists) {
        return [
          `Refused to overwrite existing file: ${filePath}.`,
          'Use mode="append" to add content, or mode="overwrite" only after reading the file and preparing the full replacement.',
        ].join(' ');
      }

      if (mode === 'overwrite' && exists && readFileSync(filePath, 'utf-8') === content) {
        const notice = workspaceAuthoringNotice(filePath);
        return [`No changes needed for ${filePath} (${input.content.length} chars already present).`, notice].filter(Boolean).join('\n\n');
      }

      writeFileSync(filePath, content, 'utf-8');
      const notice = workspaceAuthoringNotice(filePath);
      return [`${mode === 'overwrite' ? 'Overwrote' : 'Wrote'} ${filePath} (${input.content.length} chars).`, notice].filter(Boolean).join('\n\n');
    },
  });

  const run_shell_command = tool({
    name: 'run_shell_command',
    description: [
      'Run a shell command in an allowed workspace directory. Requires per-call approval UNLESS the session has an open PlanScope. Has output and time limits.',
      '',
      'CWD GUIDANCE: leave `cwd` null unless you have a specific reason to be elsewhere. On macOS, paths under ~/Desktop, ~/Documents, ~/Downloads, and iCloud Drive are TCC-protected from sandboxed-app children: child Node CLIs (sf, npm, etc.) spawned there throw EPERM on getcwd. The default cwd (Clementine\'s base directory, which the daemon already has TCC access to) is safe and works for tool invocations that don\'t actually depend on file context (CLI calls, API queries, etc.). Pass an explicit `cwd` only when the command genuinely needs to run in a specific project directory configured in WORKSPACE_DIRS.',
    ].join('\n'),
    parameters: z.object(RUN_SHELL_COMMAND_PARAMS),
    needsApproval: needsApprovalForShellSmart(),
    execute: async (input, runContext, details) => {
      if (shellMutatesMemoryStore(input.command)) {
        return formatToolOutput(
          'run_shell_command',
          runContext,
          details,
          'Refused: direct SQL mutation of the memory store (memory.db / consolidated_facts) bypasses the standing-instruction guards and audit trail. '
            + 'Use the memory tools instead: memory_pin (pin/unpin), memory_forget (soft/hard delete, refuses pinned), memory_restore (reactivate), memory_remember (add/update). '
            + 'Read-only inspection of the DB is fine; mutation must go through the tools.',
        );
      }
      const cwd = resolveAllowedCwd(input.cwd ?? undefined);
      if (shellWritesInstalledSkillSource(input.command, cwd)) {
        return formatToolOutput(
          'run_shell_command',
          runContext,
          details,
          'Refused: this shell command appears to write into an installed skill source tree under ~/.clementine-next/skills. '
            + 'Installed skills are treated as read-only package source during runs; write generated artifacts under output/, outputs/, runs/, artifacts/, reports/, or tmp/, '
            + 'or update the skill through the skill install/update path.',
        );
      }
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
