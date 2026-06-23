import type { Express, Request, Response } from 'express';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  AGENTS_DIR,
  AGENT_INBOX_DIR,
  AGENT_STATE_DIR,
  DELEGATIONS_DIR,
  TEAM_COMMS_LOG,
  TEAM_REQUESTS_DIR,
  agentFilePath,
  loadTeamAgents,
  slugifyAgentName,
  writeTeamAgent,
  type TeamAgentRecord,
} from '../tools/shared.js';
import { listAutonomyRuns, getAutonomyRun } from '../agents/run-tracking.js';
import { listSkills } from '../memory/skill-store.js';
import { listWorkflows } from '../memory/workflow-store.js';

/**
 * Read-only "Agents" workspace API (multi-agent workspace, slice 1).
 *
 * Surfaces the existing — but until now invisible — team-agent system:
 * the `TeamAgentRecord` roster (`agents/<slug>/agent.md`), the
 * `canMessage` permission graph, the team comms log + delegations, and
 * per-agent autonomy runs. Pure reads over stores that `team-tools.ts`
 * and `autonomy-v2.ts` already own; no writes, no new execution paths.
 *
 * Parsing is deliberately defensive — these are hand-written jsonl/json
 * files, so malformed lines/files are skipped, mirroring
 * `readTeamMessages()` in team-tools.ts.
 */

const PRIMARY_SLUG = 'clementine';

type AgentStatus = 'idle' | 'active' | 'blocked';

interface GraphNode {
  id: string;
  label: string;
  role: string | null;
  primary: boolean;
  status: AgentStatus;
  kind: 'agent' | 'skill' | 'workflow';
}
interface GraphEdge {
  source: string;
  target: string;
  kind: 'message' | 'skill' | 'workflow';
}

interface AgentStateFile {
  slug: string;
  lastRunAt?: string;
  lastWakeAt?: string;
  lastSummary?: string;
  commitments?: string[];
  nextWakeAt?: string;
  lastError?: string;
}

interface TeamMessageRecord {
  id: string;
  fromAgent: string;
  toAgent: string;
  content: string;
  timestamp: string;
  protocol: 'message' | 'request' | 'response';
  requestId?: string;
  respondedAt?: string;
}

interface DelegationRecord {
  id: string;
  fromAgent: string;
  toAgent: string;
  task: string;
  expectedOutput: string;
  status: 'pending' | 'in_progress' | 'completed';
  result?: string;
  createdAt: string;
  updatedAt: string;
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function loadAgentState(slug: string): AgentStateFile | null {
  return readJsonFile<AgentStateFile>(path.join(AGENT_STATE_DIR, `${slug}.json`));
}

function pendingInboxCount(slug: string): number {
  const items = readJsonFile<Array<{ status?: string }>>(path.join(AGENT_INBOX_DIR, `${slug}.json`));
  if (!Array.isArray(items)) return 0;
  return items.filter((item) => item?.status === 'pending').length;
}

/**
 * Slugs with an in-flight autonomy run. Read the runs store ONCE per
 * request (autonomySessionId is `agent:<slug>`) instead of once per agent
 * — the roster + graph both derive status from this.
 */
function activeRunSlugs(): Set<string> {
  const active = new Set<string>();
  for (const run of listAutonomyRuns({ limit: 50 })) {
    if (run.status === 'running' || run.status === 'queued') {
      const slug = run.sessionId.startsWith('agent:') ? run.sessionId.slice('agent:'.length) : run.sessionId;
      active.add(slug);
    }
  }
  return active;
}

function deriveStatus(slug: string, state: AgentStateFile | null, active: Set<string>): AgentStatus {
  if (active.has(slug)) return 'active';
  if (state?.lastError) return 'blocked';
  return 'idle';
}

function readTeamMessages(): TeamMessageRecord[] {
  if (!existsSync(TEAM_COMMS_LOG)) return [];
  return readFileSync(TEAM_COMMS_LOG, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as TeamMessageRecord;
      } catch {
        return null;
      }
    })
    .filter((record): record is TeamMessageRecord => record !== null);
}

function readDelegations(): DelegationRecord[] {
  if (!existsSync(DELEGATIONS_DIR)) return [];
  const out: DelegationRecord[] = [];
  for (const slug of readdirSync(DELEGATIONS_DIR)) {
    const dir = path.join(DELEGATIONS_DIR, slug);
    let files: string[];
    try {
      files = readdirSync(dir).filter((file) => file.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      const record = readJsonFile<DelegationRecord>(path.join(dir, file));
      if (record) out.push(record);
    }
  }
  return out;
}

function pendingRequestCount(slug: string): number {
  if (!existsSync(TEAM_REQUESTS_DIR)) return 0;
  let files: string[];
  try {
    files = readdirSync(TEAM_REQUESTS_DIR).filter((file) => file.endsWith('.json'));
  } catch {
    return 0;
  }
  let count = 0;
  for (const file of files) {
    const request = readJsonFile<{ toAgent?: string; status?: string }>(path.join(TEAM_REQUESTS_DIR, file));
    if (request?.toAgent === slug && request.status === 'pending') count++;
  }
  return count;
}

function summarizeAgent(agent: TeamAgentRecord, active: Set<string>) {
  const state = loadAgentState(agent.slug);
  return {
    slug: agent.slug,
    name: agent.name,
    role: agent.role ?? null,
    description: agent.description,
    model: agent.model ?? null,
    project: agent.project ?? null,
    channelName: agent.channelName ?? null,
    canMessage: agent.canMessage,
    allowedTools: agent.allowedTools,
    proactive: agent.proactive ?? false,
    autonomyEnabled: agent.autonomyEnabled ?? false,
    cadenceMinutes: agent.cadenceMinutes ?? null,
    wakeTriggers: agent.wakeTriggers ?? [],
    skills: agent.skills ?? [],
    workflows: agent.workflows ?? [],
    personality: agent.personality,
    status: deriveStatus(agent.slug, state, active),
    pendingInbox: pendingInboxCount(agent.slug),
    pendingRequests: pendingRequestCount(agent.slug),
    lastRunAt: state?.lastRunAt ?? null,
    lastSummary: state?.lastSummary ?? null,
    commitments: state?.commitments ?? [],
    nextWakeAt: state?.nextWakeAt ?? null,
    lastError: state?.lastError ?? null,
  };
}

/**
 * Register read-only agent-workspace routes. Called from
 * registerConsoleRoutes so it shares the same auth gate and Express app.
 */
export function registerConsoleAgentsRoutes(
  app: Express,
  isAuthorized: (req: Request) => boolean,
): void {
  app.get('/api/console/agents', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const active = activeRunSlugs();
      const agents = loadTeamAgents().map((agent) => summarizeAgent(agent, active));
      res.json({ agents, generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/agents/graph', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const agents = loadTeamAgents();
      const active = activeRunSlugs();
      const known = new Set(agents.map((agent) => agent.slug));
      // The primary orchestrator is a node even if it has no agent.md.
      const nodes: GraphNode[] = agents.map((agent) => {
        const state = loadAgentState(agent.slug);
        return {
          id: agent.slug,
          label: agent.name,
          role: agent.role ?? null,
          primary: agent.slug === PRIMARY_SLUG,
          status: deriveStatus(agent.slug, state, active),
          kind: 'agent' as const,
        };
      });
      if (!known.has(PRIMARY_SLUG)) {
        nodes.unshift({ id: PRIMARY_SLUG, label: 'Clementine', role: 'orchestrator', primary: true, status: 'idle', kind: 'agent' });
        known.add(PRIMARY_SLUG);
      }
      // Edges: canMessage permissions (agent→agent), plus Slice-4 ownership
      // edges (agent→skill, agent→workflow). Skill/workflow nodes are added
      // once each, on demand. Drop edges to unknown agent targets.
      const edges: GraphEdge[] = [];
      const seenSkill = new Set<string>();
      const seenWf = new Set<string>();
      for (const agent of agents) {
        for (const target of agent.canMessage) {
          if (known.has(target)) edges.push({ source: agent.slug, target, kind: 'message' });
        }
        for (const skill of agent.skills ?? []) {
          const id = `skill:${skill}`;
          if (!seenSkill.has(id)) { seenSkill.add(id); nodes.push({ id, label: skill, role: null, primary: false, status: 'idle', kind: 'skill' }); }
          edges.push({ source: agent.slug, target: id, kind: 'skill' });
        }
        for (const wf of agent.workflows ?? []) {
          const id = `wf:${wf}`;
          if (!seenWf.has(id)) { seenWf.add(id); nodes.push({ id, label: wf, role: null, primary: false, status: 'idle', kind: 'workflow' }); }
          edges.push({ source: agent.slug, target: id, kind: 'workflow' });
        }
      }
      res.json({ nodes, edges, generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Slice 4: options for the agent form's skill + workflow multi-selects.
  app.get('/api/console/agents/catalog', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const skills = listSkills().map((s) => ({ name: s.name, description: s.frontmatter.description ?? '' }));
      const workflows = listWorkflows()
        .map((w) => ({ name: w.data.name, description: w.data.description ?? '' }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ skills, workflows, generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/agents/comms', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
      const messages = readTeamMessages()
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
        .slice(0, limit);
      const delegations = readDelegations()
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .slice(0, limit);
      res.json({ messages, delegations, generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/agents/:slug/runs', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
      const runs = listAutonomyRuns({ slug: String(req.params.slug), limit });
      res.json({ runs, generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/agents/:slug/run/:runId', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const run = getAutonomyRun(String(req.params.runId));
      if (!run) { res.status(404).json({ error: 'run not found' }); return; }
      res.json(run);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- Manage (slice 2): create / edit / delete agent definitions. These
  // write agents/<slug>/agent.md via writeTeamAgent — the same store the
  // create_agent/update_agent MCP tools own. The console is the primary
  // owner UI (already auth-gated), so no per-write approval is needed,
  // mirroring the spaces create/patch/delete routes.

  app.post('/api/console/agents', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const fields = coerceAgentBody(req.body);
      if (!fields.name) { res.status(400).json({ error: 'name is required' }); return; }
      const slug = slugifyAgentName(fields.name);
      if (!slug) { res.status(400).json({ error: 'could not derive a valid slug from name' }); return; }
      if (existsSync(agentFilePath(slug))) { res.status(409).json({ error: `agent already exists: ${slug}` }); return; }

      const record: TeamAgentRecord = {
        slug,
        name: fields.name,
        description: fields.description ?? '',
        role: fields.role,
        channelName: fields.channelName,
        canMessage: fields.canMessage ?? [],
        allowedTools: fields.allowedTools ?? [],
        skills: fields.skills ?? [],
        workflows: fields.workflows ?? [],
        model: fields.model,
        project: fields.project,
        tier: fields.tier !== undefined ? Math.min(fields.tier, 2) : 2,
        autonomyEnabled: fields.autonomyEnabled ?? true,
        proactive: fields.proactive ?? true,
        cadenceMinutes: fields.cadenceMinutes !== undefined ? Math.max(5, fields.cadenceMinutes) : 30,
        wakeTriggers: fields.wakeTriggers ?? ['inbox', 'delegation', 'request', 'stale_tasks', 'daily_review'],
        personality: fields.personality || `You are ${fields.name}. ${fields.description ?? ''}`.trim(),
      };
      writeTeamAgent(record);
      res.json({ agent: summarizeAgent(record, activeRunSlugs()), generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/console/agents/:slug', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const slug = String(req.params.slug);
      const existing = loadTeamAgents().find((agent) => agent.slug === slug);
      if (!existing) { res.status(404).json({ error: `agent not found: ${slug}` }); return; }

      const fields = coerceAgentBody(req.body);
      const merged: TeamAgentRecord = {
        ...existing,
        name: fields.name ?? existing.name,
        description: fields.description ?? existing.description,
        role: fields.role ?? existing.role,
        channelName: fields.channelName ?? existing.channelName,
        canMessage: fields.canMessage ?? existing.canMessage,
        allowedTools: fields.allowedTools ?? existing.allowedTools,
        skills: fields.skills ?? existing.skills,
        workflows: fields.workflows ?? existing.workflows,
        model: fields.model ?? existing.model,
        project: fields.project ?? existing.project,
        tier: fields.tier !== undefined ? Math.min(fields.tier, 2) : existing.tier,
        autonomyEnabled: fields.autonomyEnabled ?? existing.autonomyEnabled,
        proactive: fields.proactive ?? existing.proactive,
        cadenceMinutes: fields.cadenceMinutes !== undefined ? Math.max(5, fields.cadenceMinutes) : existing.cadenceMinutes,
        wakeTriggers: fields.wakeTriggers ?? existing.wakeTriggers,
        personality: fields.personality ?? existing.personality,
      };
      writeTeamAgent(merged);
      res.json({ agent: summarizeAgent(merged, activeRunSlugs()), generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/console/agents/:slug', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const slug = String(req.params.slug);
      if (slug === PRIMARY_SLUG) { res.status(400).json({ error: 'the primary orchestrator cannot be deleted' }); return; }
      const dir = path.join(AGENTS_DIR, slug);
      if (!existsSync(dir)) { res.status(404).json({ error: `agent not found: ${slug}` }); return; }
      rmSync(dir, { recursive: true, force: true });
      res.json({ removed: true, slug });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** Coerce an untrusted JSON body into the agent fields we accept. Unknown
 *  keys are ignored; wrong-typed values fall through to undefined so the
 *  create/patch handlers apply defaults or keep the existing value. */
interface AgentBodyFields {
  name?: string;
  description?: string;
  role?: string;
  channelName?: string;
  personality?: string;
  model?: string;
  project?: string;
  canMessage?: string[];
  allowedTools?: string[];
  skills?: string[];
  workflows?: string[];
  wakeTriggers?: string[];
  cadenceMinutes?: number;
  tier?: number;
  proactive?: boolean;
  autonomyEnabled?: boolean;
}

function coerceAgentBody(body: unknown): AgentBodyFields {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const strList = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : undefined;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
  return {
    name: str(b.name),
    description: str(b.description),
    role: str(b.role),
    channelName: str(b.channelName),
    personality: str(b.personality),
    model: str(b.model),
    project: str(b.project),
    canMessage: strList(b.canMessage),
    allowedTools: strList(b.allowedTools),
    skills: strList(b.skills),
    workflows: strList(b.workflows),
    wakeTriggers: strList(b.wakeTriggers),
    cadenceMinutes: num(b.cadenceMinutes),
    tier: num(b.tier),
    proactive: bool(b.proactive),
    autonomyEnabled: bool(b.autonomyEnabled),
  };
}
