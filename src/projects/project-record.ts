/**
 * Projects: durable bodies of work, and the agents assigned to them.
 *
 * A project is WHAT the work is for: a purpose, goals, the standing context
 * that work inside it shares, the accounts and resources it uses, and the
 * specialists assigned to it. It is not an execution engine and it grants no
 * authority: a turn or a task inside a project passes every gate an
 * unattached one passes.
 *
 * An assignment is the explicit relation between one project and one saved
 * agent. It holds what that agent is responsible for in that project and the
 * context that applies only there, so one agent can work in several projects
 * without one project's context reaching another.
 *
 * The word "project" already names other things in this codebase: a local
 * code folder on the workspace roster, a workflow's default folder, a fact
 * kind, a compiled plan graph. None of them is this record, and none of their
 * fields hold this record's id.
 *
 * Own database file, not a harness or memory migration: several agents
 * hotpatch the same installed app, and two branches that each ship the same
 * next schema version would skip one another's tables in the live home. This
 * file's schema chain belongs to this subsystem alone.
 *
 * Ids are minted, never derived from a name, and never reused: memory and
 * tasks are scoped by them, and a project recreated under an old name must
 * not inherit what the old one learned.
 */
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

export const MAX_PROJECT_NAME_CHARS = 80;
export const MAX_PROJECT_PURPOSE_CHARS = 2_000;
export const MAX_PROJECT_CONTEXT_CHARS = 8_000;
export const MAX_PROJECT_GOALS = 12;
export const MAX_PROJECT_GOAL_CHARS = 300;
export const MAX_ASSIGNMENT_RESPONSIBILITY_CHARS = 1_000;
export const MAX_ASSIGNMENT_CONTEXT_CHARS = 8_000;
export const MAX_ASSIGNMENT_SKILLS = 32;
export const MAX_PROJECT_RESOURCES = 64;

export type ProjectStatus = 'active' | 'archived';
export type ProjectOrigin = 'chat' | 'console' | 'phone';

export interface ProjectRecord {
  /** Minted at creation. Never derived from the name, never reused. */
  id: string;
  name: string;
  /** What the work is for, in the owner's words. */
  purpose: string;
  goals: string[];
  /** Standing context every piece of work in the project shares: its terms,
   * its current state, what has been decided. */
  context: string;
  status: ProjectStatus;
  /** Rises on every change to the record itself. */
  revision: number;
  createdFrom: ProjectOrigin | null;
  /** The conversation it was created in, when there was one. */
  originSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ProjectDraft {
  name: string;
  purpose?: string;
  goals?: readonly string[];
  context?: string;
  createdFrom?: ProjectOrigin;
  originSessionId?: string | null;
}

/** Every string field on a patch accepts '' to clear it, except the name. */
export type ProjectPatch = Partial<Pick<ProjectDraft, 'name' | 'purpose' | 'goals' | 'context'>>;

export interface ProjectAssignment {
  projectId: string;
  agentId: string;
  /** When the agent record assigned was created. An agent id is a name's
   * slug; a different agent later saved under the same name is not this one. */
  agentCreatedAt: string | null;
  /** The agent's name when it was assigned or last seen, so an assignment
   * whose agent is gone can still say who it was. */
  agentName: string;
  /** What this agent answers for in this project. */
  responsibility: string;
  /** Context that applies to this agent in this project and nowhere else. */
  context: string;
  /** Skills it reaches for in this project, beside the ones it always pins. */
  skills: string[];
  /**
   * Whether a method this agent learns here may be kept for its work in
   * other projects. Off unless the owner turns it on: what is learned inside
   * a project stays inside it.
   */
  shareMethods: boolean;
  state: 'active' | 'removed';
  /** Rises on every change to the assignment. */
  revision: number;
  assignedAt: string;
  updatedAt: string;
}

export interface AssignmentDraft {
  agentId: string;
  agentCreatedAt?: string | null;
  agentName?: string;
  responsibility?: string;
  context?: string;
  skills?: readonly string[];
  shareMethods?: boolean;
}

export type ProjectResourceKind = 'account' | 'space' | 'workflow' | 'folder' | 'link';

export interface ProjectResource {
  id: string;
  projectId: string;
  kind: ProjectResourceKind;
  /** How the owner would name it. */
  label: string;
  /** For an account: the toolkit or server it belongs to. */
  toolkit: string | null;
  /** For an account: the exact connected account. */
  accountId: string | null;
  /** For everything else: the slug, name, path or address. */
  ref: string | null;
  /** When the binding was last checked against live configuration, and what
   * it was checked against. Null when it never was: a binding nobody
   * verified is shown as unverified and is never used to pick an account. */
  verifiedAt: string | null;
  verification: Record<string, unknown> | null;
  state: 'active' | 'removed';
  createdAt: string;
  updatedAt: string;
}

export interface ResourceDraft {
  kind: ProjectResourceKind;
  label?: string;
  toolkit?: string | null;
  accountId?: string | null;
  ref?: string | null;
  verifiedAt?: string | null;
  verification?: Record<string, unknown> | null;
}

export type SaveProjectResult =
  | { ok: true; project: ProjectRecord; created: boolean }
  | { ok: false; reason: 'name_required' | 'name_taken' | 'not_found' | 'archived' };

export type SaveAssignmentResult =
  | { ok: true; assignment: ProjectAssignment; created: boolean }
  | { ok: false; reason: 'project_not_found' | 'project_archived' | 'agent_required' };

export type SaveResourceResult =
  | { ok: true; resource: ProjectResource; created: boolean }
  | { ok: false; reason: 'project_not_found' | 'project_archived' | 'resource_incomplete' | 'too_many_resources'
      | 'conflicting_account'; conflict?: ProjectResource };

const SCHEMA_VERSION = 1;
const RESOURCE_KINDS: ReadonlySet<string> = new Set(['account', 'space', 'workflow', 'folder', 'link']);

let handle: Database.Database | null = null;
let handlePath = '';

function nowIso(): string {
  return new Date().toISOString();
}

export function projectStorePath(): string {
  return path.join(BASE_DIR, 'state', 'projects', 'projects.db');
}

function db(): Database.Database {
  const file = projectStorePath();
  if (handle && handlePath === file) return handle;
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const next = new Database(file);
  next.pragma('journal_mode = WAL');
  next.pragma('busy_timeout = 5000');
  next.pragma('foreign_keys = ON');
  migrate(next);
  handle = next;
  handlePath = file;
  return next;
}

function migrate(conn: Database.Database): void {
  const current = Number(conn.pragma('user_version', { simple: true })) || 0;
  if (current >= SCHEMA_VERSION) return;
  conn.transaction(() => {
    if (current < 1) {
      conn.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id                TEXT PRIMARY KEY,
          name              TEXT NOT NULL,
          name_key          TEXT NOT NULL,
          purpose           TEXT NOT NULL DEFAULT '',
          goals_json        TEXT NOT NULL DEFAULT '[]',
          context           TEXT NOT NULL DEFAULT '',
          status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
          revision          INTEGER NOT NULL DEFAULT 1,
          created_from      TEXT,
          origin_session_id TEXT,
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL,
          archived_at       TEXT
        );
        -- One active project per name. An archived one frees its name and
        -- keeps its id.
        CREATE UNIQUE INDEX IF NOT EXISTS projects_active_name
          ON projects (name_key) WHERE status = 'active';

        -- Ids are never reused, including after a record is removed.
        CREATE TABLE IF NOT EXISTS project_ids_issued (
          id        TEXT PRIMARY KEY,
          issued_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS project_agents (
          project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          agent_id         TEXT NOT NULL,
          agent_created_at TEXT,
          agent_name       TEXT NOT NULL DEFAULT '',
          responsibility   TEXT NOT NULL DEFAULT '',
          context          TEXT NOT NULL DEFAULT '',
          skills_json      TEXT NOT NULL DEFAULT '[]',
          share_methods    INTEGER NOT NULL DEFAULT 0 CHECK (share_methods IN (0,1)),
          state            TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','removed')),
          revision         INTEGER NOT NULL DEFAULT 1,
          assigned_at      TEXT NOT NULL,
          updated_at       TEXT NOT NULL,
          PRIMARY KEY (project_id, agent_id)
        );
        CREATE INDEX IF NOT EXISTS project_agents_by_agent ON project_agents (agent_id, state);

        CREATE TABLE IF NOT EXISTS project_resources (
          id                TEXT PRIMARY KEY,
          project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind              TEXT NOT NULL CHECK (kind IN ('account','space','workflow','folder','link')),
          label             TEXT NOT NULL DEFAULT '',
          toolkit           TEXT,
          account_id        TEXT,
          ref               TEXT,
          verified_at       TEXT,
          verification_json TEXT,
          state             TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','removed')),
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS project_resources_by_project ON project_resources (project_id, state, kind);
      `);
    }
    conn.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

/** Test seam: drop the cached handle so a test can point BASE_DIR elsewhere. */
export function _closeProjectStoreForTests(): void {
  try { handle?.close(); } catch { /* already closed */ }
  handle = null;
  handlePath = '';
}

function clean(value: unknown, max: number): string {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function cleanLine(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function boundedList(values: readonly string[] | undefined, maxItems: number, maxChars: number): string[] {
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const item = cleanLine(value, maxChars);
    if (!item) continue;
    seen.add(item);
    if (seen.size >= maxItems) break;
  }
  return [...seen];
}

function nameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function parseList(json: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(json ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseObject(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isOrigin(value: unknown): value is ProjectOrigin {
  return value === 'chat' || value === 'console' || value === 'phone';
}

/** Lowercase letters and digits, no look-alikes: read aloud and typed without error. */
const ID_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789';

function mintId(prefix: string, conn: Database.Database): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = randomBytes(14);
    let body = '';
    for (const byte of bytes) body += ID_ALPHABET[byte % ID_ALPHABET.length];
    const id = `${prefix}_${body}`;
    if (prefix !== 'prj') return id;
    const issued = conn.prepare('INSERT OR IGNORE INTO project_ids_issued (id, issued_at) VALUES (?, ?)').run(id, nowIso());
    if (issued.changes === 1) return id;
  }
  throw new Error('project-record: could not mint an unused id');
}

export function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && /^prj_[a-z0-9]{14}$/.test(value);
}

interface RawProject {
  id: string; name: string; purpose: string; goals_json: string; context: string; status: ProjectStatus;
  revision: number; created_from: string | null; origin_session_id: string | null;
  created_at: string; updated_at: string; archived_at: string | null;
}

function toProject(row: RawProject): ProjectRecord {
  return {
    id: row.id, name: row.name, purpose: row.purpose, goals: parseList(row.goals_json), context: row.context,
    status: row.status, revision: row.revision,
    createdFrom: isOrigin(row.created_from) ? row.created_from : null,
    originSessionId: row.origin_session_id, createdAt: row.created_at, updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

interface RawAssignment {
  project_id: string; agent_id: string; agent_created_at: string | null; agent_name: string;
  responsibility: string; context: string;
  skills_json: string; share_methods: number; state: 'active' | 'removed'; revision: number;
  assigned_at: string; updated_at: string;
}

function toAssignment(row: RawAssignment): ProjectAssignment {
  return {
    projectId: row.project_id, agentId: row.agent_id, agentCreatedAt: row.agent_created_at, agentName: row.agent_name,
    responsibility: row.responsibility, context: row.context, skills: parseList(row.skills_json),
    shareMethods: row.share_methods === 1, state: row.state, revision: row.revision,
    assignedAt: row.assigned_at, updatedAt: row.updated_at,
  };
}

interface RawResource {
  id: string; project_id: string; kind: ProjectResourceKind; label: string; toolkit: string | null;
  account_id: string | null; ref: string | null; verified_at: string | null; verification_json: string | null;
  state: 'active' | 'removed'; created_at: string; updated_at: string;
}

function toResource(row: RawResource): ProjectResource {
  return {
    id: row.id, projectId: row.project_id, kind: row.kind, label: row.label, toolkit: row.toolkit,
    accountId: row.account_id, ref: row.ref, verifiedAt: row.verified_at,
    verification: parseObject(row.verification_json), state: row.state,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function getProject(id: string | null | undefined): ProjectRecord | null {
  if (!isProjectId(id)) return null;
  const row = db().prepare('SELECT * FROM projects WHERE id = ?').get(id) as RawProject | undefined;
  return row ? toProject(row) : null;
}

/** By id, or by the name a person typed. Only an active project answers to its name. */
export function findProject(idOrName: string | null | undefined): ProjectRecord | null {
  const wanted = String(idOrName ?? '').trim();
  if (!wanted) return null;
  if (isProjectId(wanted)) return getProject(wanted);
  const row = db().prepare("SELECT * FROM projects WHERE name_key = ? AND status = 'active'")
    .get(nameKey(wanted)) as RawProject | undefined;
  return row ? toProject(row) : null;
}

export function listProjects(options: { includeArchived?: boolean } = {}): ProjectRecord[] {
  const rows = db().prepare(`
    SELECT * FROM projects ${options.includeArchived ? '' : "WHERE status = 'active'"}
    ORDER BY updated_at DESC, id
  `).all() as RawProject[];
  return rows.map(toProject);
}

export function createProject(draft: ProjectDraft): SaveProjectResult {
  const name = cleanLine(draft.name, MAX_PROJECT_NAME_CHARS);
  if (!name) return { ok: false, reason: 'name_required' };
  const conn = db();
  return conn.transaction((): SaveProjectResult => {
    if (conn.prepare("SELECT 1 FROM projects WHERE name_key = ? AND status = 'active'").get(nameKey(name))) {
      return { ok: false, reason: 'name_taken' };
    }
    const id = mintId('prj', conn);
    const at = nowIso();
    conn.prepare(`
      INSERT INTO projects (id, name, name_key, purpose, goals_json, context, status, revision,
        created_from, origin_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)
    `).run(
      id, name, nameKey(name), clean(draft.purpose, MAX_PROJECT_PURPOSE_CHARS),
      JSON.stringify(boundedList(draft.goals, MAX_PROJECT_GOALS, MAX_PROJECT_GOAL_CHARS)),
      clean(draft.context, MAX_PROJECT_CONTEXT_CHARS),
      isOrigin(draft.createdFrom) ? draft.createdFrom : null,
      cleanLine(draft.originSessionId, 200) || null, at, at,
    );
    return { ok: true, project: getProject(id)!, created: true };
  })();
}

export function updateProject(id: string, patch: ProjectPatch): SaveProjectResult {
  const conn = db();
  return conn.transaction((): SaveProjectResult => {
    const current = getProject(id);
    if (!current) return { ok: false, reason: 'not_found' };
    if (current.status === 'archived') return { ok: false, reason: 'archived' };
    const name = patch.name === undefined ? current.name : cleanLine(patch.name, MAX_PROJECT_NAME_CHARS);
    if (!name) return { ok: false, reason: 'name_required' };
    if (nameKey(name) !== nameKey(current.name)
      && conn.prepare("SELECT 1 FROM projects WHERE name_key = ? AND status = 'active' AND id <> ?").get(nameKey(name), id)) {
      return { ok: false, reason: 'name_taken' };
    }
    const next = {
      name,
      purpose: patch.purpose === undefined ? current.purpose : clean(patch.purpose, MAX_PROJECT_PURPOSE_CHARS),
      goals: patch.goals === undefined ? current.goals : boundedList(patch.goals, MAX_PROJECT_GOALS, MAX_PROJECT_GOAL_CHARS),
      context: patch.context === undefined ? current.context : clean(patch.context, MAX_PROJECT_CONTEXT_CHARS),
    };
    const unchanged = next.name === current.name && next.purpose === current.purpose
      && next.context === current.context && JSON.stringify(next.goals) === JSON.stringify(current.goals);
    if (unchanged) return { ok: true, project: current, created: false };
    conn.prepare(`
      UPDATE projects SET name = ?, name_key = ?, purpose = ?, goals_json = ?, context = ?,
        revision = revision + 1, updated_at = ? WHERE id = ?
    `).run(next.name, nameKey(next.name), next.purpose, JSON.stringify(next.goals), next.context, nowIso(), id);
    return { ok: true, project: getProject(id)!, created: false };
  })();
}

/** Put a project away. Its id, its tasks and what was learned in it remain. */
export function archiveProject(id: string): SaveProjectResult {
  const conn = db();
  return conn.transaction((): SaveProjectResult => {
    const current = getProject(id);
    if (!current) return { ok: false, reason: 'not_found' };
    if (current.status === 'archived') return { ok: true, project: current, created: false };
    const at = nowIso();
    conn.prepare("UPDATE projects SET status = 'archived', archived_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(at, at, id);
    return { ok: true, project: getProject(id)!, created: false };
  })();
}

export function restoreProject(id: string): SaveProjectResult {
  const conn = db();
  return conn.transaction((): SaveProjectResult => {
    const current = getProject(id);
    if (!current) return { ok: false, reason: 'not_found' };
    if (current.status === 'active') return { ok: true, project: current, created: false };
    if (conn.prepare("SELECT 1 FROM projects WHERE name_key = ? AND status = 'active'").get(nameKey(current.name))) {
      return { ok: false, reason: 'name_taken' };
    }
    conn.prepare("UPDATE projects SET status = 'active', archived_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(nowIso(), id);
    return { ok: true, project: getProject(id)!, created: false };
  })();
}

export function getAssignment(projectId: string, agentId: string): ProjectAssignment | null {
  const row = db().prepare("SELECT * FROM project_agents WHERE project_id = ? AND agent_id = ? AND state = 'active'")
    .get(projectId, agentId) as RawAssignment | undefined;
  return row ? toAssignment(row) : null;
}

export function listAssignments(projectId: string): ProjectAssignment[] {
  const rows = db().prepare("SELECT * FROM project_agents WHERE project_id = ? AND state = 'active' ORDER BY assigned_at, agent_id")
    .all(projectId) as RawAssignment[];
  return rows.map(toAssignment);
}

/** The active projects an agent is assigned to, most recently changed first. */
export function listAssignmentsForAgent(agentId: string): ProjectAssignment[] {
  const rows = db().prepare(`
    SELECT a.* FROM project_agents a JOIN projects p ON p.id = a.project_id
     WHERE a.agent_id = ? AND a.state = 'active' AND p.status = 'active'
     ORDER BY p.updated_at DESC, a.project_id
  `).all(agentId) as RawAssignment[];
  return rows.map(toAssignment);
}

/** Assign an agent, or change what its assignment says. */
export function saveAssignment(projectId: string, draft: AssignmentDraft): SaveAssignmentResult {
  const agentId = cleanLine(draft.agentId, 64);
  if (!agentId) return { ok: false, reason: 'agent_required' };
  const conn = db();
  return conn.transaction((): SaveAssignmentResult => {
    const project = getProject(projectId);
    if (!project) return { ok: false, reason: 'project_not_found' };
    if (project.status === 'archived') return { ok: false, reason: 'project_archived' };
    const existing = conn.prepare('SELECT * FROM project_agents WHERE project_id = ? AND agent_id = ?')
      .get(projectId, agentId) as RawAssignment | undefined;
    const at = nowIso();
    const agentCreatedAt = draft.agentCreatedAt === undefined
      ? existing?.agent_created_at ?? null
      : cleanLine(draft.agentCreatedAt, 40) || null;
    // A different agent now answers to this id: what was written for the
    // earlier one does not carry over.
    const sameAgent = existing && existing.state === 'active'
      && (existing.agent_created_at ?? null) === agentCreatedAt;
    const base = sameAgent ? toAssignment(existing) : null;
    const agentName = draft.agentName === undefined ? base?.agentName ?? '' : cleanLine(draft.agentName, 120);
    const next = {
      responsibility: draft.responsibility === undefined
        ? base?.responsibility ?? '' : clean(draft.responsibility, MAX_ASSIGNMENT_RESPONSIBILITY_CHARS),
      context: draft.context === undefined ? base?.context ?? '' : clean(draft.context, MAX_ASSIGNMENT_CONTEXT_CHARS),
      skills: draft.skills === undefined ? base?.skills ?? [] : boundedList(draft.skills, MAX_ASSIGNMENT_SKILLS, 120),
      shareMethods: draft.shareMethods === undefined ? base?.shareMethods ?? false : draft.shareMethods === true,
    };
    if (base && agentName === base.agentName && next.responsibility === base.responsibility && next.context === base.context
      && next.shareMethods === base.shareMethods && JSON.stringify(next.skills) === JSON.stringify(base.skills)) {
      return { ok: true, assignment: base, created: false };
    }
    if (existing) {
      conn.prepare(`
        UPDATE project_agents SET agent_created_at = ?, agent_name = ?, responsibility = ?, context = ?, skills_json = ?,
          share_methods = ?, state = 'active', revision = revision + 1,
          assigned_at = CASE WHEN ? THEN assigned_at ELSE ? END, updated_at = ?
        WHERE project_id = ? AND agent_id = ?
      `).run(agentCreatedAt, agentName, next.responsibility, next.context, JSON.stringify(next.skills),
        next.shareMethods ? 1 : 0, sameAgent ? 1 : 0, at, at, projectId, agentId);
    } else {
      conn.prepare(`
        INSERT INTO project_agents (project_id, agent_id, agent_created_at, agent_name, responsibility, context, skills_json,
          share_methods, state, revision, assigned_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)
      `).run(projectId, agentId, agentCreatedAt, agentName, next.responsibility, next.context, JSON.stringify(next.skills),
        next.shareMethods ? 1 : 0, at, at);
    }
    conn.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(at, projectId);
    return { ok: true, assignment: getAssignment(projectId, agentId)!, created: !sameAgent };
  })();
}

/** Take an agent off a project. What it did and learned there is kept. */
export function removeAssignment(projectId: string, agentId: string): boolean {
  const at = nowIso();
  const conn = db();
  return conn.transaction(() => {
    const changed = conn.prepare(`
      UPDATE project_agents SET state = 'removed', revision = revision + 1, updated_at = ?
       WHERE project_id = ? AND agent_id = ? AND state = 'active'
    `).run(at, projectId, agentId).changes === 1;
    if (changed) conn.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(at, projectId);
    return changed;
  })();
}

export function listResources(projectId: string): ProjectResource[] {
  const rows = db().prepare("SELECT * FROM project_resources WHERE project_id = ? AND state = 'active' ORDER BY kind, created_at, id")
    .all(projectId) as RawResource[];
  return rows.map(toResource);
}

/**
 * Bind an account or a resource to a project. A project holds one account per
 * toolkit: binding a second, different one is refused and the one already
 * bound is returned, so the caller can ask which is meant instead of one
 * silently replacing the other. `replace` is the answer to that question.
 */
export function saveResource(projectId: string, draft: ResourceDraft, options: { replace?: boolean } = {}): SaveResourceResult {
  if (!RESOURCE_KINDS.has(draft.kind)) return { ok: false, reason: 'resource_incomplete' };
  const toolkit = cleanLine(draft.toolkit, 120) || null;
  const accountId = cleanLine(draft.accountId, 200) || null;
  const ref = clean(draft.ref, 1_000) || null;
  if (draft.kind === 'account' ? !toolkit || !accountId : !ref) return { ok: false, reason: 'resource_incomplete' };
  const conn = db();
  return conn.transaction((): SaveResourceResult => {
    const project = getProject(projectId);
    if (!project) return { ok: false, reason: 'project_not_found' };
    if (project.status === 'archived') return { ok: false, reason: 'project_archived' };
    const active = listResources(projectId);
    const same = active.find((row) => row.kind === draft.kind && (draft.kind === 'account'
      ? row.toolkit?.toLowerCase() === toolkit!.toLowerCase() && row.accountId === accountId
      : row.ref === ref));
    const rival = draft.kind === 'account'
      ? active.find((row) => row.kind === 'account' && row.toolkit?.toLowerCase() === toolkit!.toLowerCase() && row.accountId !== accountId)
      : undefined;
    if (rival && !options.replace) return { ok: false, reason: 'conflicting_account', conflict: rival };
    const at = nowIso();
    const label = cleanLine(draft.label, 200);
    const verifiedAt = cleanLine(draft.verifiedAt, 40) || null;
    const verification = draft.verification ? JSON.stringify(draft.verification).slice(0, 4_000) : null;
    if (rival) {
      conn.prepare("UPDATE project_resources SET state = 'removed', updated_at = ? WHERE id = ?").run(at, rival.id);
    }
    if (same) {
      conn.prepare(`
        UPDATE project_resources SET label = CASE WHEN ? <> '' THEN ? ELSE label END,
          verified_at = COALESCE(?, verified_at), verification_json = COALESCE(?, verification_json), updated_at = ?
        WHERE id = ?
      `).run(label, label, verifiedAt, verification, at, same.id);
      conn.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(at, projectId);
      return { ok: true, resource: toResource(conn.prepare('SELECT * FROM project_resources WHERE id = ?').get(same.id) as RawResource), created: false };
    }
    if (active.length - (rival ? 1 : 0) >= MAX_PROJECT_RESOURCES) return { ok: false, reason: 'too_many_resources' };
    const id = mintId('res', conn);
    conn.prepare(`
      INSERT INTO project_resources (id, project_id, kind, label, toolkit, account_id, ref, verified_at,
        verification_json, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(id, projectId, draft.kind, label, toolkit, accountId, ref, verifiedAt, verification, at, at);
    // What a project is bound to is part of what work inside it sees.
    conn.prepare('UPDATE projects SET revision = revision + 1, updated_at = ? WHERE id = ?').run(at, projectId);
    return { ok: true, resource: toResource(conn.prepare('SELECT * FROM project_resources WHERE id = ?').get(id) as RawResource), created: true };
  })();
}

export function removeResource(projectId: string, resourceId: string): boolean {
  const at = nowIso();
  const conn = db();
  return conn.transaction(() => {
    const changed = conn.prepare(`
      UPDATE project_resources SET state = 'removed', updated_at = ? WHERE id = ? AND project_id = ? AND state = 'active'
    `).run(at, resourceId, projectId).changes === 1;
    if (changed) conn.prepare('UPDATE projects SET revision = revision + 1, updated_at = ? WHERE id = ?').run(at, projectId);
    return changed;
  })();
}

/** The account a project is bound to for one toolkit, when it has exactly one that was verified. */
export function projectAccountFor(projectId: string, toolkit: string): ProjectResource | null {
  const wanted = toolkit.trim().toLowerCase();
  if (!wanted) return null;
  const matches = listResources(projectId)
    .filter((row) => row.kind === 'account' && row.toolkit?.toLowerCase() === wanted && row.verifiedAt);
  return matches.length === 1 ? matches[0]! : null;
}
