import type { Express, Request, Response } from 'express';
import {
  createAgentRecord,
  deleteAgentRecord,
  getAgentRecord,
  listAgentRecords,
  updateAgentRecord,
  type AgentPatch,
  type AgentRecord,
} from '../agents/agent-record.js';
import { listActiveSkills } from '../memory/skill-store.js';
import { listWorkflows } from '../memory/workflow-store.js';
import {
  approveAgentProposal,
  listAgentProposals,
  proposeAgentDefinition,
  rejectAgentProposal,
  type AgentProposalStatus,
} from '../agents/agent-proposals.js';

/**
 * Agents API for the console: the roster of specialized working contexts a
 * person opens and works in, plus the catalog they are built from. The
 * records are the same `agents/<id>/agent.md` files the phone and the
 * `create_agent` tool write; this module never runs anything.
 */

export function registerConsoleAgentsRoutes(
  app: Express,
  isAuthorized: (req: Request) => boolean,
): void {
  app.get('/api/console/agents', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json({ agents: listAgentRecords(), generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Options for building an agent: what it can reach for first.
  app.get('/api/console/agents/catalog', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const skills = listActiveSkills().map((s) => ({ name: s.name, description: s.frontmatter.description ?? '' }));
      const workflows = listWorkflows()
        .map((w) => ({ name: w.data.name, description: w.data.description ?? '' }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ skills, workflows, generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/agents/proposals', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const rawStatus = typeof req.query.status === 'string' ? req.query.status : 'pending';
      const status = ['pending', 'approved', 'rejected', 'all'].includes(rawStatus)
        ? rawStatus as AgentProposalStatus | 'all'
        : 'pending';
      const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
      res.json({ proposals: listAgentProposals({ status, limit }), generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/agents/proposals', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const body = coerceAgentProposalBody(req.body);
      const proposal = proposeAgentDefinition({ ...body, source: 'console', proposedByAgent: 'clementine' });
      res.json({ proposal, generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/agents/proposals/:id/approve', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const result = approveAgentProposal(String(req.params.id));
      if (!result) { res.status(404).json({ error: 'pending proposal not found' }); return; }
      res.json({
        proposal: result.proposal,
        agent: getAgentRecord(result.agent.slug),
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(message.includes('already exists') ? 409 : 400).json({ error: message });
    }
  });

  app.post('/api/console/agents/proposals/:id/reject', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const reason = typeof (req.body as { reason?: unknown } | undefined)?.reason === 'string'
        ? String((req.body as { reason?: string }).reason)
        : undefined;
      const proposal = rejectAgentProposal(String(req.params.id), reason);
      if (!proposal) { res.status(404).json({ error: 'pending proposal not found' }); return; }
      res.json({ proposal, generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/agents/:id', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const agent = getAgentRecord(String(req.params.id));
      if (!agent) { res.status(404).json({ error: `agent not found: ${String(req.params.id)}` }); return; }
      res.json({ agent, generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/agents', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const fields = coerceAgentBody(req.body);
      const created = createAgentRecord({ ...fields, name: fields.name ?? '', createdFrom: 'console' });
      if (!created.ok) {
        const status = created.reason === 'name_taken' ? 409 : 400;
        res.status(status).json({ error: saveFailureMessage(created.reason) });
        return;
      }
      res.json({ agent: created.agent, generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/console/agents/:id', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const updated = updateAgentRecord(String(req.params.id), coerceAgentBody(req.body));
      if (!updated) { res.status(404).json({ error: `agent not found: ${String(req.params.id)}` }); return; }
      res.json({ agent: updated, generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/console/agents/:id', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const id = String(req.params.id);
      if (!deleteAgentRecord(id)) { res.status(404).json({ error: `agent not found: ${id}` }); return; }
      res.json({ removed: true, id });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

function saveFailureMessage(reason: 'name_required' | 'name_taken' | 'name_reserved'): string {
  if (reason === 'name_taken') return 'You already have an agent with that name.';
  if (reason === 'name_reserved') return 'That name belongs to Clementine herself.';
  return 'Give the agent a name.';
}

/**
 * Coerce an untrusted JSON body into the fields an agent accepts. Unknown keys
 * are ignored. A string field sent as '' clears it on PATCH; a missing field
 * keeps its value.
 */
function coerceAgentBody(body: unknown): AgentPatch & { name?: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const strList = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : undefined;
  const nullable = (v: unknown): string | null | undefined =>
    v === null ? null : typeof v === 'string' ? v : undefined;
  const out: AgentPatch & { name?: string } = {};
  const name = str(b.name);
  if (name !== undefined) out.name = name;
  const handles = str(b.handles);
  if (handles !== undefined) out.handles = handles;
  const instructions = str(b.instructions);
  if (instructions !== undefined) out.instructions = instructions;
  const skills = strList(b.skills);
  if (skills !== undefined) out.skills = skills;
  const workflows = strList(b.workflows);
  if (workflows !== undefined) out.workflows = workflows;
  const tools = strList(b.tools);
  if (tools !== undefined) out.tools = tools;
  const model = nullable(b.model);
  if (model !== undefined) out.model = model;
  const memoryScope = nullable(b.memoryScope);
  if (memoryScope !== undefined) out.memoryScope = memoryScope;
  return out;
}

export type { AgentRecord };

function coerceAgentProposalBody(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const optStr = (v: unknown): string | undefined => {
    const s = str(v);
    return s ? s : undefined;
  };
  const strList = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : undefined;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
  return {
    originatingRequest: str(b.originatingRequest),
    name: str(b.name),
    description: str(b.description),
    rationale: str(b.rationale),
    role: optStr(b.role),
    personality: optStr(b.personality),
    model: optStr(b.model),
    project: optStr(b.project),
    canMessage: strList(b.canMessage),
    allowedTools: strList(b.allowedTools),
    skills: strList(b.skills),
    workflows: strList(b.workflows),
    memoryScope: optStr(b.memoryScope),
    approvalPolicy: optStr(b.approvalPolicy),
    evalCriteria: strList(b.evalCriteria),
    suggestedWorkflows: strList(b.suggestedWorkflows),
    proactive: bool(b.proactive),
    autonomyEnabled: bool(b.autonomyEnabled),
    cadenceMinutes: num(b.cadenceMinutes),
  };
}
