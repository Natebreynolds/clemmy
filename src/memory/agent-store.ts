/**
 * Named agents: a person's own standing helpers.
 *
 * An agent is a NAME plus the things it is allowed to lean on — pinned skills,
 * pinned workflows, and optionally a preferred brain. It is not a second
 * reasoning engine, a second dispatch path, or a fork of the turn loop. Sending
 * a message to "Sales" is an ordinary turn whose pinned context happens to be
 * chosen in advance instead of rediscovered every time.
 *
 * That framing is deliberate. The expensive part of a turn is deciding what to
 * reach for; a named agent is the user's answer to that question, recorded once
 * and reused. It should make turns cheaper and more predictable, never grant
 * authority a plain turn would not have.
 *
 * Stored the way skills and workflows already are — one JSON file per agent
 * under the Clementine home — so a person can read, diff, back up, or hand-edit
 * them, and so this needs no schema migration to exist.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

export const AGENTS_DIR = path.join(BASE_DIR, 'agents');

export const MAX_AGENT_NAME_CHARS = 64;
export const MAX_AGENT_DESCRIPTION_CHARS = 500;
export const MAX_AGENT_PINS = 32;

export interface AgentProfile {
  /** Filesystem-safe stable id derived from the name at creation. */
  id: string;
  /** What the person calls it. */
  name: string;
  description: string;
  /** Skill names this agent leans on, as listed by the skill store. */
  skills: string[];
  /** Workflow names this agent can run, as listed by the workflow store. */
  workflows: string[];
  /** Preferred brain; null means "whatever the session would use anyway". */
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfileDraft {
  name: string;
  description?: string;
  skills?: readonly string[];
  workflows?: readonly string[];
  model?: string | null;
}

/** Stable, filesystem-safe, and recognisable in a directory listing. */
export function agentIdFor(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_AGENT_NAME_CHARS);
  return slug || 'agent';
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

function parseAgent(raw: unknown): AgentProfile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!name || !id) return null;
  return {
    id,
    name: name.slice(0, MAX_AGENT_NAME_CHARS),
    description: typeof row.description === 'string'
      ? row.description.slice(0, MAX_AGENT_DESCRIPTION_CHARS)
      : '',
    skills: boundedList(Array.isArray(row.skills) ? row.skills as string[] : []),
    workflows: boundedList(Array.isArray(row.workflows) ? row.workflows as string[] : []),
    model: typeof row.model === 'string' && row.model.trim() ? row.model.trim() : null,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date(0).toISOString(),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date(0).toISOString(),
  };
}

/** Every agent, newest edit first. Missing directory means none yet. */
export function listAgents(): AgentProfile[] {
  if (!existsSync(AGENTS_DIR)) return [];
  let files: string[];
  try {
    files = readdirSync(AGENTS_DIR).filter((entry) => entry.endsWith('.json'));
  } catch {
    return [];
  }
  const agents: AgentProfile[] = [];
  for (const file of files) {
    try {
      const parsed = parseAgent(JSON.parse(readFileSync(path.join(AGENTS_DIR, file), 'utf8')));
      if (parsed) agents.push(parsed);
    } catch {
      // A hand-edited file that no longer parses is skipped rather than
      // crashing the list — the others stay reachable.
    }
  }
  return agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function getAgent(id: string): AgentProfile | null {
  const trimmed = String(id ?? '').trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('..')) return null;
  const file = path.join(AGENTS_DIR, `${trimmed}.json`);
  if (!existsSync(file)) return null;
  try {
    return parseAgent(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

function writeAgent(agent: AgentProfile): AgentProfile {
  mkdirSync(AGENTS_DIR, { recursive: true });
  const file = path.join(AGENTS_DIR, `${agent.id}.json`);
  // Write-then-rename: a torn file would make an agent silently vanish from
  // the list, and these are the user's own definitions.
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(agent, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
  return agent;
}

export type SaveAgentResult =
  | { ok: true; agent: AgentProfile }
  | { ok: false; reason: 'name_required' | 'name_taken' };

export function createAgent(draft: AgentProfileDraft): SaveAgentResult {
  const name = String(draft.name ?? '').trim();
  if (!name) return { ok: false, reason: 'name_required' };
  const id = agentIdFor(name);
  if (getAgent(id)) return { ok: false, reason: 'name_taken' };
  const now = new Date().toISOString();
  return {
    ok: true,
    agent: writeAgent({
      id,
      name: name.slice(0, MAX_AGENT_NAME_CHARS),
      description: String(draft.description ?? '').slice(0, MAX_AGENT_DESCRIPTION_CHARS),
      skills: boundedList(draft.skills),
      workflows: boundedList(draft.workflows),
      model: draft.model?.trim() || null,
      createdAt: now,
      updatedAt: now,
    }),
  };
}

export function updateAgent(id: string, patch: Partial<AgentProfileDraft>): AgentProfile | null {
  const existing = getAgent(id);
  if (!existing) return null;
  return writeAgent({
    ...existing,
    name: patch.name?.trim() ? patch.name.trim().slice(0, MAX_AGENT_NAME_CHARS) : existing.name,
    description: patch.description === undefined
      ? existing.description
      : String(patch.description).slice(0, MAX_AGENT_DESCRIPTION_CHARS),
    skills: patch.skills === undefined ? existing.skills : boundedList(patch.skills),
    workflows: patch.workflows === undefined ? existing.workflows : boundedList(patch.workflows),
    model: patch.model === undefined ? existing.model : (patch.model?.trim() || null),
    updatedAt: new Date().toISOString(),
  });
}

export function deleteAgent(id: string): boolean {
  const existing = getAgent(id);
  if (!existing) return false;
  try {
    rmSync(path.join(AGENTS_DIR, `${existing.id}.json`), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The standing context one agent contributes to a turn.
 *
 * Deliberately plain text and deliberately small: this is a person's stated
 * preference about where to look first, not an instruction that can widen what
 * a turn may do. Every gate downstream still runs exactly as it would for an
 * unnamed turn.
 */
export function agentTurnPreamble(agent: AgentProfile): string {
  const lines = [`You are answering as "${agent.name}".`];
  if (agent.description) lines.push(agent.description);
  if (agent.skills.length > 0) {
    lines.push(`Preferred skills: ${agent.skills.join(', ')}.`);
  }
  if (agent.workflows.length > 0) {
    lines.push(`Preferred workflows: ${agent.workflows.join(', ')}.`);
  }
  lines.push('These are starting points, not limits: use anything else the request actually needs, and never claim work you did not do.');
  return lines.join(' ');
}
