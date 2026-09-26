/**
 * Agents: specialized working contexts a person opens and works in.
 *
 * An agent is a WHO — a name, what it handles, its standing instructions, and
 * the skills, workflows, tools and model role it reaches for first. It is not
 * a second reasoning engine, a timer loop, or a dispatch path. A turn inside
 * an agent is an ordinary turn whose starting context was chosen once instead
 * of rediscovered every time; the harness stays the HOW.
 *
 * One store: `agents/<id>/agent.md` in the vault, next to skills and
 * workflows, so a person can read, diff, back up or hand-edit it and a plugin
 * can ship one. The on-disk record (`TeamAgentRecord`) is a superset that
 * still carries fields older runtimes read; this module is the only view the
 * product uses.
 */
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import {
  AGENTS_DIR,
  AGENT_INBOX_DIR,
  AGENT_STATE_DIR,
  DELEGATIONS_DIR,
  agentFilePath,
  loadTeamAgents,
  slugifyAgentName,
  writeTeamAgent,
  type TeamAgentRecord,
} from '../tools/shared.js';

export const MAX_AGENT_NAME_CHARS = 64;
export const MAX_AGENT_HANDLES_CHARS = 500;
export const MAX_AGENT_INSTRUCTIONS_CHARS = 20_000;
export const MAX_AGENT_PINS = 32;

/** The host's own identity is not an agent in the list. */
export const HOST_AGENT_ID = 'clementine';

export type AgentOrigin = 'chat' | 'console' | 'phone' | 'plugin';

export interface AgentRecord {
  /** Stable, filesystem-safe id derived from the name at creation. */
  id: string;
  name: string;
  /** One line: what this agent handles. */
  handles: string;
  /** Standing instructions applied to every turn inside the agent. */
  instructions: string;
  /** Skill names it reaches for first (from the skill store). */
  skills: string[];
  /** Workflow names it reaches for first (from the workflow store). */
  workflows: string[];
  /** Tool families a turn inside it is narrowed to. Empty = the turn's usual surface. */
  tools: string[];
  /** A model role (writer, worker…) or a named model; null = whatever the turn would use. */
  model: string | null;
  /** Space or project whose memory it works within. */
  memoryScope: string | null;
  createdFrom: AgentOrigin | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AgentDraft {
  name: string;
  handles?: string;
  instructions?: string;
  skills?: readonly string[];
  workflows?: readonly string[];
  tools?: readonly string[];
  model?: string | null;
  memoryScope?: string | null;
  createdFrom?: AgentOrigin;
}

/** Every string field on a patch accepts '' to clear it. */
export type AgentPatch = Partial<Omit<AgentDraft, 'createdFrom'>>;

export type SaveAgentResult =
  | { ok: true; agent: AgentRecord }
  | { ok: false; reason: 'name_required' | 'name_taken' | 'name_reserved' };

export function agentIdFor(name: string): string {
  return slugifyAgentName(name).slice(0, MAX_AGENT_NAME_CHARS) || 'agent';
}

function boundedList(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) continue;
    seen.add(trimmed);
    if (seen.size >= MAX_AGENT_PINS) break;
  }
  return [...seen];
}

function isOrigin(value: unknown): value is AgentOrigin {
  return value === 'chat' || value === 'console' || value === 'phone' || value === 'plugin';
}

function fromDisk(record: TeamAgentRecord): AgentRecord {
  return {
    id: record.slug,
    name: record.name,
    handles: record.description,
    instructions: record.personality,
    skills: record.skills ?? [],
    workflows: record.workflows ?? [],
    tools: record.tools ?? [],
    model: record.model ?? null,
    memoryScope: record.memoryScope ?? null,
    createdFrom: isOrigin(record.createdFrom) ? record.createdFrom : null,
    createdAt: record.createdAt ?? null,
    updatedAt: record.updatedAt ?? null,
  };
}

function toDisk(agent: AgentRecord, existing?: TeamAgentRecord): TeamAgentRecord {
  return {
    // Fields this product does not use are carried through untouched so a
    // hand-written file loses nothing on save.
    ...(existing ?? { slug: agent.id, canMessage: [], allowedTools: [] }),
    slug: agent.id,
    name: agent.name,
    description: agent.handles,
    personality: agent.instructions,
    skills: agent.skills,
    workflows: agent.workflows,
    tools: agent.tools,
    model: agent.model ?? undefined,
    memoryScope: agent.memoryScope ?? undefined,
    createdFrom: agent.createdFrom ?? undefined,
    createdAt: agent.createdAt ?? undefined,
    updatedAt: agent.updatedAt ?? undefined,
  };
}

function loadDisk(): TeamAgentRecord[] {
  importLegacyProfiles();
  return loadTeamAgents().filter((record) => record.slug !== HOST_AGENT_ID);
}

/**
 * Phone-created agents used to live as `<home>/agents/<id>.json`. Fold any
 * that remain into the one store the first time it is read; the JSON file is
 * moved aside, never deleted.
 */
const LEGACY_PROFILE_DIR = path.join(BASE_DIR, 'agents');
let legacyImported = false;
function importLegacyProfiles(): void {
  if (legacyImported) return;
  legacyImported = true;
  if (!existsSync(LEGACY_PROFILE_DIR)) return;
  let files: string[];
  try {
    files = readdirSync(LEGACY_PROFILE_DIR).filter((entry) => entry.endsWith('.json'));
  } catch {
    return;
  }
  for (const file of files) {
    const full = path.join(LEGACY_PROFILE_DIR, file);
    try {
      const raw = JSON.parse(readFileSync(full, 'utf8')) as Record<string, unknown>;
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      if (!name) continue;
      const id = agentIdFor(name);
      if (id === HOST_AGENT_ID || existsSync(agentFilePath(id))) {
        renameSync(full, `${full}.imported`);
        continue;
      }
      const now = new Date().toISOString();
      writeTeamAgent(toDisk({
        id,
        name: name.slice(0, MAX_AGENT_NAME_CHARS),
        handles: typeof raw.description === 'string' ? raw.description.slice(0, MAX_AGENT_HANDLES_CHARS) : '',
        instructions: '',
        skills: boundedList(Array.isArray(raw.skills) ? raw.skills as string[] : []),
        workflows: boundedList(Array.isArray(raw.workflows) ? raw.workflows as string[] : []),
        tools: [],
        model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null,
        memoryScope: null,
        createdFrom: 'phone',
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
      }));
      renameSync(full, `${full}.imported`);
    } catch {
      // A file that no longer parses stays where it is; the others import.
    }
  }
}

/** Every agent, most recently edited first. */
export function listAgentRecords(): AgentRecord[] {
  return loadDisk()
    .map(fromDisk)
    .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '') || left.name.localeCompare(right.name));
}

export function getAgentRecord(id: string): AgentRecord | null {
  const trimmed = String(id ?? '').trim();
  if (!trimmed || trimmed === HOST_AGENT_ID || trimmed.includes('/') || trimmed.includes('..')) return null;
  const record = loadDisk().find((entry) => entry.slug === trimmed);
  return record ? fromDisk(record) : null;
}

/** Resolve an agent by id or by the name a person would type. */
export function findAgentRecord(idOrName: string): AgentRecord | null {
  const wanted = String(idOrName ?? '').trim();
  if (!wanted) return null;
  const byId = getAgentRecord(wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase();
  return listAgentRecords().find((agent) => agent.name.toLowerCase() === lower || agent.id === agentIdFor(wanted)) ?? null;
}

export function createAgentRecord(draft: AgentDraft): SaveAgentResult {
  const name = String(draft.name ?? '').trim().slice(0, MAX_AGENT_NAME_CHARS);
  if (!name) return { ok: false, reason: 'name_required' };
  const id = agentIdFor(name);
  if (id === HOST_AGENT_ID) return { ok: false, reason: 'name_reserved' };
  if (existsSync(agentFilePath(id))) return { ok: false, reason: 'name_taken' };
  const now = new Date().toISOString();
  const agent: AgentRecord = {
    id,
    name,
    handles: String(draft.handles ?? '').trim().slice(0, MAX_AGENT_HANDLES_CHARS),
    instructions: String(draft.instructions ?? '').trim().slice(0, MAX_AGENT_INSTRUCTIONS_CHARS),
    skills: boundedList(draft.skills),
    workflows: boundedList(draft.workflows),
    tools: boundedList(draft.tools),
    model: draft.model?.trim() || null,
    memoryScope: draft.memoryScope?.trim() || null,
    createdFrom: draft.createdFrom ?? null,
    createdAt: now,
    updatedAt: now,
  };
  writeTeamAgent(toDisk(agent));
  return { ok: true, agent };
}

export function updateAgentRecord(id: string, patch: AgentPatch): AgentRecord | null {
  const existing = loadDisk().find((entry) => entry.slug === String(id ?? '').trim());
  if (!existing) return null;
  const current = fromDisk(existing);
  const next: AgentRecord = {
    ...current,
    name: patch.name?.trim() ? patch.name.trim().slice(0, MAX_AGENT_NAME_CHARS) : current.name,
    handles: patch.handles === undefined ? current.handles : String(patch.handles).trim().slice(0, MAX_AGENT_HANDLES_CHARS),
    instructions: patch.instructions === undefined ? current.instructions : String(patch.instructions).trim().slice(0, MAX_AGENT_INSTRUCTIONS_CHARS),
    skills: patch.skills === undefined ? current.skills : boundedList(patch.skills),
    workflows: patch.workflows === undefined ? current.workflows : boundedList(patch.workflows),
    tools: patch.tools === undefined ? current.tools : boundedList(patch.tools),
    model: patch.model === undefined ? current.model : (patch.model?.trim() || null),
    memoryScope: patch.memoryScope === undefined ? current.memoryScope : (patch.memoryScope?.trim() || null),
    updatedAt: new Date().toISOString(),
  };
  writeTeamAgent(toDisk(next, existing));
  return next;
}

/** Remove the agent and everything the runtime kept about it. */
export function deleteAgentRecord(id: string): boolean {
  const trimmed = String(id ?? '').trim();
  if (!trimmed || trimmed === HOST_AGENT_ID || trimmed.includes('/') || trimmed.includes('..')) return false;
  const dir = path.join(AGENTS_DIR, trimmed);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  for (const leftover of [
    path.join(AGENT_STATE_DIR, `${trimmed}.json`),
    path.join(AGENT_INBOX_DIR, `${trimmed}.json`),
    path.join(DELEGATIONS_DIR, trimmed),
  ]) {
    rmSync(leftover, { recursive: true, force: true });
  }
  return true;
}

export function ensureAgentsDir(): void {
  mkdirSync(AGENTS_DIR, { recursive: true });
}
