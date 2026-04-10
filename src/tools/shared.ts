import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
export const AGENT_STATE_DIR = path.join(BASE_DIR, 'agents-state');
export const AGENT_INBOX_DIR = path.join(BASE_DIR, 'agents-inbox');
export const CRON_RUNS_DIR = path.join(BASE_DIR, 'cron', 'runs');
export const CRON_TRIGGERS_DIR = path.join(BASE_DIR, 'cron', 'triggers');
export const CRON_PROGRESS_DIR = path.join(BASE_DIR, 'cron', 'progress');
export const WORKFLOW_RUNS_DIR = path.join(BASE_DIR, 'workflows', 'runs');

export function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
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

  return shortcuts[target] || path.join(VAULT_DIR, target);
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
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    result[trimmed.slice(0, eqIndex)] = trimmed.slice(eqIndex + 1);
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
}

export function getWorkspaceDirs(): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  const env = readBaseEnv();

  const add = (dir: string): void => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved) || !existsSync(resolved) || !statSync(resolved).isDirectory()) return;
    seen.add(resolved);
    dirs.push(resolved);
  };

  for (const candidate of DEFAULT_WORKSPACE_CANDIDATES) {
    add(path.join(os.homedir(), candidate));
  }

  for (const dir of (env.WORKSPACE_DIRS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)) {
    add(dir.startsWith('~') ? dir.replace('~', os.homedir()) : dir);
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

function extractDescription(dirPath: string, entries: string[]): string {
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

export function listWorkspaceProjects(filter?: string): WorkspaceProject[] {
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
        const isProject = PROJECT_MARKERS.some((marker) => subEntries.includes(marker) || existsSync(path.join(candidate, marker)));
        if (!isProject) continue;

        const name = path.basename(candidate);
        if (filter && !name.toLowerCase().includes(filter.toLowerCase())) continue;

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

  return projects.sort((left, right) => left.name.localeCompare(right.name));
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

  writeFileSync(filePath, matter.stringify(agent.personality || `You are ${agent.name}.`, frontmatter), 'utf-8');
}
