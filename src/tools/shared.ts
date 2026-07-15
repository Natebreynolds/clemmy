import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASE_DIR as CONFIG_BASE_DIR } from '../config.js';
import { PlanStore } from '../planning/plan-store.js';
import { SessionStore } from '../memory/session-store.js';
import matter from 'gray-matter';
import {
  DAILY_NOTES_DIR,
  IDENTITY_FILE,
  INBOX_DIR,
  MEMORY_FILE,
  PEOPLE_DIR,
  PROJECTS_DIR,
  SOUL_FILE,
  SYSTEM_DIR,
  TASKS_DIR,
  TOPICS_DIR,
  VAULT_DIR,
  CRON_FILE,
  WORKFLOWS_DIR,
  WORKING_MEMORY_FILE,
  ensureTodayNote,
  ensureVaultScaffold,
} from '../memory/vault.js';
import {
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  formatRecallableToolText,
  truncateToolText as truncateToolTextCanonical,
} from '../runtime/harness/tool-output-format.js';

export const plans = new PlanStore();
export const sessions = new SessionStore();
export const BASE_DIR = CONFIG_BASE_DIR;
export const GOALS_DIR = path.join(BASE_DIR, 'goals');
export const TASKS_FILE = path.join(TASKS_DIR, 'TASKS.md');
export const TIMERS_FILE = path.join(BASE_DIR, '.timers.json');
export const AGENTS_DIR = path.join(SYSTEM_DIR, 'agents');
export const TEAM_COMMS_LOG = path.join(BASE_DIR, 'logs', 'team-comms.jsonl');
export const TEAM_REQUESTS_DIR = path.join(BASE_DIR, 'team-requests');
export const DELEGATIONS_DIR = path.join(BASE_DIR, 'delegations');
export const PENDING_ACTIONS_DIR = path.join(BASE_DIR, 'pending-actions');
export const AGENT_STATE_DIR = path.join(BASE_DIR, 'agents-state');
export const AGENT_INBOX_DIR = path.join(BASE_DIR, 'agents-inbox');
export { INBOX_DIR };
export const CRON_RUNS_DIR = path.join(BASE_DIR, 'cron', 'runs');
export const CRON_TRIGGERS_DIR = path.join(BASE_DIR, 'cron', 'triggers');
export const CRON_PROGRESS_DIR = path.join(BASE_DIR, 'cron', 'progress');
export const WORKFLOW_RUNS_DIR = path.join(BASE_DIR, 'workflows', 'runs');

/**
 * Cap a single tool result so a runaway tool output (a 50KB file dump,
 * a giant JSON blob) doesn't fill the model's context. Defaults to
 * 4000 chars (~1000 tokens), which fits normal responses comfortably
 * but stops the worst offenders. Callers that genuinely need raw
 * fidelity (e.g. read_file with an explicit byte budget) can pass a
 * higher maxChars.
 *
 * v0.5.22 — lowered 8000 → 4000 after sess-mplmvrqu (2026-05-25) hit
 * a 1.4MB Codex request body that consistently SSE-truncated. Tool
 * returns accumulated unbounded across 31 history items; tighter
 * default keeps long sessions under Codex's request-size cliff.
 *
 * The truncation marker tells the model the response was cut and how
 * much was dropped, so it can choose to re-call with a narrower scope
 * (offset/limit, filter, more specific query) or call
 * `recall_tool_result(callId)` to pull the original full output from
 * disk without re-invoking the upstream tool.
 */
export function truncateToolText(text: string, maxChars: number = DEFAULT_TOOL_RESULT_MAX_CHARS): string {
  return truncateToolTextCanonical(text, maxChars);
}

export { DEFAULT_TOOL_RESULT_MAX_CHARS };

export function textResult(text: string, options?: { maxChars?: number }): { content: Array<{ type: 'text'; text: string }> } {
  const capped = formatRecallableToolText(text, {
    maxChars: options?.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS,
  });
  return { content: [{ type: 'text', text: capped }] };
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function safeTitle(title: string): string {
  return title.replace(/[<>:"/\\|?*]/g, '').trim();
}

export function noteFolderForType(noteType: 'person' | 'project' | 'topic' | 'task' | 'inbox'): string {
  switch (noteType) {
    case 'person':
      return PEOPLE_DIR;
    case 'project':
      return PROJECTS_DIR;
    case 'topic':
      return TOPICS_DIR;
    case 'task':
      return TASKS_DIR;
    case 'inbox':
      return INBOX_DIR;
  }
}

export function resolveMemoryTarget(target: string): string {
  const shortcuts: Record<string, string> = {
    soul: SOUL_FILE,
    memory: MEMORY_FILE,
    identity: IDENTITY_FILE,
    working_memory: WORKING_MEMORY_FILE,
    today: ensureTodayNote(),
  };

  if (shortcuts[target]) return shortcuts[target];

  // Recall results intentionally expose the durable source path so an agent can
  // load the evidence instead of trusting a snippet. Those paths are absolute,
  // while memory_read historically accepted only vault-relative targets and
  // silently prefixed an absolute path with VAULT_DIR. Accept absolute paths
  // only when they remain inside the vault; never turn memory_read into an
  // arbitrary filesystem reader.
  if (path.isAbsolute(target)) {
    const resolved = path.resolve(target);
    const vaultRoot = path.resolve(VAULT_DIR);
    if (resolved === vaultRoot || resolved.startsWith(`${vaultRoot}${path.sep}`)) return resolved;
  }

  return path.join(VAULT_DIR, target);
}

export function readText(filePath: string, fallback: string, maxChars = 12000): string {
  if (!existsSync(filePath)) return fallback;
  try {
    return readFileSync(filePath, 'utf-8').slice(0, maxChars);
  } catch {
    return fallback;
  }
}

export function replaceFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
}

export function appendTodayNote(content: string): string {
  ensureVaultScaffold();
  const notePath = ensureTodayNote();
  const existing = readFileSync(notePath, 'utf-8');
  const timestamp = new Date().toISOString().slice(11, 16);
  const updated = `${existing.trimEnd()}\n- ${timestamp} ${content.trim()}\n`;
  writeFileSync(notePath, updated, 'utf-8');
  return path.basename(notePath);
}

export function ensureToolDirectories(): void {
  ensureVaultScaffold();
  ensureDir(path.join(BASE_DIR, 'tools'));
  ensureDir(path.join(BASE_DIR, 'plugins'));
  ensureDir(path.join(BASE_DIR, 'mcp'));
  ensureDir(GOALS_DIR);
  ensureDir(SYSTEM_DIR);
  ensureDir(AGENTS_DIR);
  ensureDir(DAILY_NOTES_DIR);
  ensureDir(INBOX_DIR);
  ensureDir(TASKS_DIR);
  ensureDir(path.dirname(TEAM_COMMS_LOG));
  ensureDir(TEAM_REQUESTS_DIR);
  ensureDir(DELEGATIONS_DIR);
  ensureDir(PENDING_ACTIONS_DIR);
  ensureDir(AGENT_STATE_DIR);
  ensureDir(AGENT_INBOX_DIR);
  ensureDir(path.join(BASE_DIR, 'state'));
  ensureDir(path.dirname(CRON_RUNS_DIR));
  ensureDir(CRON_RUNS_DIR);
  ensureDir(CRON_TRIGGERS_DIR);
  ensureDir(CRON_PROGRESS_DIR);
  ensureDir(WORKFLOW_RUNS_DIR);
  ensureDir(WORKFLOWS_DIR);
}

export interface ParsedTask {
  id: string;
  rawLine: string;
  status: 'pending' | 'completed';
  description: string;
  priority: 'high' | 'medium' | 'low';
  dueDate: string;
  project: string;
}

function normalizeTaskPriority(raw: string): 'high' | 'medium' | 'low' {
  if (raw === 'high' || raw === 'low') return raw;
  return 'medium';
}

export function ensureTasksFile(): void {
  ensureDir(TASKS_DIR);
  if (!existsSync(TASKS_FILE)) {
    writeFileSync(
      TASKS_FILE,
      [
        '---',
        'type: tasks',
        '---',
        '',
        '# Tasks',
        '',
        '## Pending',
        '',
        '## Completed',
        '',
      ].join('\n'),
      'utf-8',
    );
  }
}

export function parseTasks(body: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  let section: 'pending' | 'completed' = 'pending';

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '## Pending') {
      section = 'pending';
      continue;
    }
    if (trimmed === '## Completed') {
      section = 'completed';
      continue;
    }
    if (!trimmed.startsWith('- [')) continue;

    const idMatch = trimmed.match(/\{(T-\d+)\}/);
    const dueMatch = trimmed.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
    const projectMatch = trimmed.match(/#project:(\S+)/);
    const priorityMatch = trimmed.match(/!!(high|medium|low)/);
    const checked = /^\s*-\s+\[[xX]\]/.test(line);
    const cleanDescription = trimmed
      .replace(/^- \[[ xX]\]\s*/, '')
      .replace(/\{T-\d+\}\s*/, '')
      .replace(/\s*!!(high|medium|low)/g, '')
      .replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/g, '')
      .replace(/\s*#project:\S+/g, '')
      .trim();

    tasks.push({
      id: idMatch?.[1] ?? '',
      rawLine: line,
      status: checked || section === 'completed' ? 'completed' : 'pending',
      description: cleanDescription,
      priority: normalizeTaskPriority(priorityMatch?.[1] ?? 'medium'),
      dueDate: dueMatch?.[1] ?? '',
      project: projectMatch?.[1] ?? '',
    });
  }

  return tasks;
}

export function nextTaskId(body: string): string {
  const matches = [...body.matchAll(/\{T-(\d+)\}/g)];
  const maxId = matches.reduce((max, match) => Math.max(max, parseInt(match[1], 10)), 0);
  return `T-${String(maxId + 1).padStart(3, '0')}`;
}

export interface WorkspaceProject {
  name: string;
  path: string;
  type: string;
  description: string;
  hasClaude: boolean;
}

const DEFAULT_WORKSPACE_CANDIDATES = [
  'Desktop',
  'Documents',
  'Developer',
  'Projects',
  'projects',
  'repos',
  'Repos',
  'src',
  'code',
  'Code',
  'work',
  'Work',
  'dev',
  'Dev',
  'github',
  'GitHub',
];

const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Makefile', 'CMakeLists.txt'];

export function readBaseEnv(): Record<string, string> {
  const envPath = path.join(BASE_DIR, '.env');
  if (!existsSync(envPath)) return {};

  const result: Record<string, string> = {};
  for (const rawLine of readFileSync(envPath, 'utf-8').split('\n')) {
    // Strip leading whitespace + trailing \r only — DO NOT strip
    // trailing whitespace on the value. Some folder names have
    // significant trailing spaces, and the workspace list breaks
    // if we collapse them silently.
    const line = rawLine.replace(/^\s+|\r+$/g, '');
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1);
    result[key] = value;
  }
  return result;
}

export function updateEnvKey(key: string, value: string): void {
  const envPath = path.join(BASE_DIR, '.env');
  const lines = existsSync(envPath) ? readFileSync(envPath, 'utf-8').split('\n') : [];
  let updated = false;

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith(`${key}=`)) {
      lines[index] = `${key}=${value}`;
      updated = true;
      break;
    }
  }

  if (!updated) {
    lines.push(`${key}=${value}`);
  }

  writeFileSync(envPath, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf-8');

  // Mirror into the live process env. getRuntimeEnv() reads process.env BEFORE
  // the .env file (config.ts), so a file-only write is INVISIBLE this session
  // whenever the key was already present in process.env at boot — the next
  // getRuntimeEnv() keeps returning the stale value. That made settings writes
  // (e.g. the worker/judge role picker via CLEMMY_MODEL_ROLES) appear to "revert"
  // in the UI: the file got the new value but the running snapshot didn't. A
  // handful of call sites worked around this by manually setting process.env[key]
  // after the call; doing it here fixes the whole class once, for every caller.
  process.env[key] = value;
  if (key === 'WORKSPACE_DIRS') clearWorkspaceProjectCache();
}

/**
 * Remove a key from the BASE_DIR/.env file AND the live process.env, so the
 * next getRuntimeEnv() falls back to the code default (or a lower-precedence
 * .env). The inverse of updateEnvKey — used by the developer flags panel to
 * "reset to default" without writing an explicit value (which would otherwise
 * pin the flag even after the code default changes).
 */
export function removeEnvKey(key: string): void {
  const envPath = path.join(BASE_DIR, '.env');
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    const kept = lines.filter((line) => !line.startsWith(`${key}=`));
    if (kept.length !== lines.length) {
      writeFileSync(envPath, `${kept.join('\n').replace(/\n+$/, '')}\n`, 'utf-8');
    }
  }
  delete process.env[key];
}

export function getWorkspaceDirs(): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  const env = readBaseEnv();
  // Split but DON'T pre-trim — some folder names have significant
  // trailing whitespace (real project paths in the wild end with
  // a stray space). We can't tell from the CSV whether " /foo" is
  // "user added spaces around the comma" or "/foo has a leading
  // space in its real name", so the resolver below tries both
  // forms.
  const configuredEntries = (env.WORKSPACE_DIRS ?? '')
    .split(',')
    .filter((entry) => entry.length > 0);

  const add = (raw: string): void => {
    // Try as-written first (preserves trailing whitespace in folder
    // names), then fall back to trimmed (handles the common
    // ", "-separated CSV pattern). Stop at the first one that exists
    // on disk so we don't double-register the same folder.
    const candidates = raw !== raw.trim() ? [raw, raw.trim()] : [raw];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const expanded = candidate.startsWith('~')
        ? candidate.replace('~', os.homedir())
        : candidate;
      const resolved = path.resolve(expanded);
      if (seen.has(resolved)) return;
      try {
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) continue;
      } catch {
        continue;
      }
      seen.add(resolved);
      dirs.push(resolved);
      return;
    }
  };

  if (configuredEntries.length > 0) {
    for (const dir of configuredEntries) add(dir);
    return dirs;
  }

  for (const candidate of DEFAULT_WORKSPACE_CANDIDATES) {
    add(path.join(os.homedir(), candidate));
  }

  return dirs;
}

function detectProjectType(entries: string[]): string {
  if (entries.includes('package.json')) return 'node';
  if (entries.includes('pyproject.toml')) return 'python';
  if (entries.includes('Cargo.toml')) return 'rust';
  if (entries.includes('go.mod')) return 'go';
  return 'unknown';
}

/**
 * macOS CloudStorage paths (OneDrive, Google Drive, iCloud File Provider, etc.)
 * back files with on-demand hydration — read() can block indefinitely while
 * the OS pulls the file down. There is no sync I/O timeout in Node, so the
 * only safe option is to skip these paths entirely for nice-to-have reads.
 *
 * `~/Desktop` is the most common offender: OneDrive Known Folder Move
 * symlinks `~/Desktop` to `~/Library/CloudStorage/OneDrive-*`. We canonicalize
 * via realpath so the check catches paths that *resolve* into CloudStorage,
 * not just literal CloudStorage paths.
 */
function isCloudStoragePath(dirPath: string): boolean {
  const literal = /\/Library\/CloudStorage\//.test(dirPath) || /\/Library\/Mobile Documents\//.test(dirPath);
  if (literal) return true;
  try {
    // realpath is a path-resolution syscall only — it does not pull file
    // contents, so it stays fast even on hydrated-on-demand backings.
    const resolved = realpathSync(dirPath);
    return /\/Library\/CloudStorage\//.test(resolved) || /\/Library\/Mobile Documents\//.test(resolved);
  } catch {
    return false;
  }
}

function extractDescription(dirPath: string, entries: string[]): string {
  if (isCloudStoragePath(dirPath)) return '';

  if (entries.includes('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dirPath, 'package.json'), 'utf-8')) as { description?: string };
      if (pkg.description) return pkg.description;
    } catch {
      // Ignore malformed package.json
    }
  }

  for (const readmeName of ['README.md', 'readme.md', 'README']) {
    if (!entries.includes(readmeName)) continue;
    try {
      const lines = readFileSync(path.join(dirPath, readmeName), 'utf-8').split('\n');
      const line = lines.find((entry) => {
        const trimmed = entry.trim();
        return trimmed && !trimmed.startsWith('#');
      });
      if (line) return line.trim().slice(0, 200);
    } catch {
      // Ignore unreadable README.
    }
  }

  return '';
}

// listWorkspaceProjects walks every configured workspace dir + a fan
// of macOS standard locations, stat'ing each subdir against
// PROJECT_MARKERS. With Spotlight/iCloud-mirrored dirs this can take
// 30+ seconds — way too slow for the dashboard which calls it on
// every projects-panel open. Cache the unfiltered list and re-filter
// in-process. TTL is short so projects added during the session
// surface within a minute.
const PROJECT_LIST_CACHE_TTL_MS = 60_000;
let projectListCache: { at: number; projects: WorkspaceProject[] } | null = null;

export function clearWorkspaceProjectCache(): void {
  projectListCache = null;
}

export function listWorkspaceProjects(filter?: string): WorkspaceProject[] {
  if (projectListCache && Date.now() - projectListCache.at < PROJECT_LIST_CACHE_TTL_MS) {
    const filtered = filter
      ? projectListCache.projects.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()))
      : projectListCache.projects;
    return filtered;
  }
  const projects: WorkspaceProject[] = [];
  const seen = new Set<string>();

  for (const workspaceDir of getWorkspaceDirs()) {
    let entries: string[] = [];
    try {
      entries = readdirSync(workspaceDir);
    } catch {
      continue;
    }

    const candidates = [workspaceDir, ...entries.map((entry) => path.join(workspaceDir, entry))];
    for (const candidate of candidates) {
      try {
        if (!statSync(candidate).isDirectory()) continue;
        const resolved = path.resolve(candidate);
        if (seen.has(resolved)) continue;

        const subEntries = readdirSync(candidate);
        const isProject = PROJECT_MARKERS.some((marker) => subEntries.includes(marker));
        if (!isProject) continue;

        const name = path.basename(candidate);

        seen.add(resolved);
        projects.push({
          name,
          path: resolved,
          type: detectProjectType(subEntries),
          description: extractDescription(candidate, subEntries),
          hasClaude: existsSync(path.join(candidate, '.claude', 'CLAUDE.md')),
        });
      } catch {
        continue;
      }
    }
  }

  const sorted = projects.sort((left, right) => left.name.localeCompare(right.name));
  projectListCache = { at: Date.now(), projects: sorted };
  if (filter) {
    return sorted.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()));
  }
  return sorted;
}

/** Force the projects cache to refresh on next call. */
export function invalidateWorkspaceProjectsCache(): void {
  projectListCache = null;
}

export interface TeamAgentRecord {
  slug: string;
  name: string;
  description: string;
  role?: string;
  channelName?: string;
  canMessage: string[];
  allowedTools: string[];
  model?: string;
  project?: string;
  tier?: number;
  autonomyEnabled?: boolean;
  proactive?: boolean;
  cadenceMinutes?: number;
  wakeTriggers?: string[];
  /** Skills this agent is expert in. Their SKILL.md is injected into the
   *  agent's instructions at build time (Slice 4). Empty = none bound. */
  skills?: string[];
  /** Workflows this agent owns / may trigger (Slice 4). Surfaced in the
   *  agent's instructions so it reaches for them via workflow_run. */
  workflows?: string[];
  personality: string;
}

export function slugifyAgentName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function agentFilePath(slug: string): string {
  return path.join(AGENTS_DIR, slug, 'agent.md');
}

export function loadTeamAgents(): TeamAgentRecord[] {
  if (!existsSync(AGENTS_DIR)) return [];

  const agents: TeamAgentRecord[] = [];
  for (const entry of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const slug = entry.name;
    const filePath = agentFilePath(slug);
    if (!existsSync(filePath)) continue;

    try {
      const parsed = matter(readFileSync(filePath, 'utf-8'));
      const data = parsed.data as Record<string, unknown>;
      agents.push({
        slug,
        name: typeof data.name === 'string' ? data.name : slug,
        description: typeof data.description === 'string' ? data.description : '',
        role: typeof data.role === 'string' ? data.role : undefined,
        channelName: typeof data.channelName === 'string' ? data.channelName : undefined,
        canMessage: Array.isArray(data.canMessage) ? data.canMessage.map(String).filter(Boolean) : [],
        allowedTools: Array.isArray(data.allowedTools) ? data.allowedTools.map(String).filter(Boolean) : [],
        model: typeof data.model === 'string' ? data.model : undefined,
        project: typeof data.project === 'string' ? data.project : undefined,
        tier: typeof data.tier === 'number' ? data.tier : undefined,
        autonomyEnabled: typeof data.autonomyEnabled === 'boolean' ? data.autonomyEnabled : true,
        proactive: typeof data.proactive === 'boolean' ? data.proactive : true,
        cadenceMinutes: typeof data.cadenceMinutes === 'number' ? data.cadenceMinutes : 30,
        wakeTriggers: Array.isArray(data.wakeTriggers) ? data.wakeTriggers.map(String).filter(Boolean) : ['inbox', 'delegation', 'request', 'stale_tasks', 'daily_review'],
        skills: Array.isArray(data.skills) ? data.skills.map(String).filter(Boolean) : [],
        workflows: Array.isArray(data.workflows) ? data.workflows.map(String).filter(Boolean) : [],
        personality: parsed.content.trim(),
      });
    } catch {
      continue;
    }
  }

  return agents.sort((left, right) => left.slug.localeCompare(right.slug));
}

export function writeTeamAgent(agent: TeamAgentRecord): void {
  const filePath = agentFilePath(agent.slug);
  ensureDir(path.dirname(filePath));

  const frontmatter: Record<string, unknown> = {
    name: agent.name,
    description: agent.description,
  };
  if (agent.role) frontmatter.role = agent.role;
  if (agent.channelName) frontmatter.channelName = agent.channelName;
  if (agent.canMessage.length > 0) frontmatter.canMessage = agent.canMessage;
  if (agent.allowedTools.length > 0) frontmatter.allowedTools = agent.allowedTools;
  if (agent.model) frontmatter.model = agent.model;
  if (agent.project) frontmatter.project = agent.project;
  if (agent.tier !== undefined) frontmatter.tier = agent.tier;
  if (agent.autonomyEnabled !== undefined) frontmatter.autonomyEnabled = agent.autonomyEnabled;
  if (agent.proactive !== undefined) frontmatter.proactive = agent.proactive;
  if (agent.cadenceMinutes !== undefined) frontmatter.cadenceMinutes = agent.cadenceMinutes;
  if (agent.wakeTriggers && agent.wakeTriggers.length > 0) frontmatter.wakeTriggers = agent.wakeTriggers;
  if (agent.skills && agent.skills.length > 0) frontmatter.skills = agent.skills;
  if (agent.workflows && agent.workflows.length > 0) frontmatter.workflows = agent.workflows;

  writeFileSync(filePath, matter.stringify(agent.personality || `You are ${agent.name}.`, frontmatter), 'utf-8');
}
