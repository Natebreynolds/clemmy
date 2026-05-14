import type { Express, Request } from 'express';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import matter from 'gray-matter';
import { renderConsoleHtml } from './console.js';
import { BASE_DIR, WEBHOOK_SECRET } from '../config.js';
import { recallHybrid } from '../memory/recall.js';
import { forgetFact, listActiveFacts, listAllFacts } from '../memory/facts.js';
import { openMemoryDb } from '../memory/db.js';
import { readMemoryIndexStatus } from '../memory/indexer.js';
import { WORKFLOWS_DIR } from '../memory/vault.js';
import { ensureDir, getWorkspaceDirs, listWorkspaceProjects, WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import type { ClementineAssistant } from '../assistant/core.js';
import { LOCAL_MCP_TOOL_NAMES } from '../tools/catalog.js';
import { getCoreTools } from '../tools/registry.js';
import { discoverMcpServers } from '../runtime/mcp-config.js';
import { loadPlugins, PLUGINS_DIR } from '../plugins/loader.js';
import { loadUserProfile, saveUserProfile } from '../runtime/user-profile.js';
import { getProactivityPolicySnapshot, saveProactivityPolicy } from '../agents/proactivity-policy.js';
import { getAuthStatus } from '../runtime/auth-store.js';
import { getSecretStore, listSecretDescriptors, type SecretName } from '../runtime/secrets/index.js';
import {
  createCheckInTemplate,
  deleteCheckInTemplate,
  ensureSeedTemplates,
  getCheckInTemplate,
  getTemplateState,
  listCheckInTemplates,
  testFireTemplate,
  updateCheckInTemplate,
  type TriggerKind,
} from '../agents/check-in-templates.js';
import {
  approveProposal,
  deleteProposal,
  getProposal,
  listProposals,
  rejectProposal,
} from '../agents/check-in-proposals.js';
import {
  approvePlanProposal,
  deletePlanProposal,
  getPlanProposal,
  listPlanProposals,
  rejectPlanProposal,
} from '../agents/plan-proposals.js';
import { PlanSchema } from '../agents/planner.js';
import type { CheckInUrgency } from '../agents/check-ins.js';

/**
 * Mounts the new Console dashboard at /console.
 *
 * The existing /dashboard route in webhook.ts is left untouched —
 * Run Control Center keeps working. /console is the new parallel
 * surface with its own visual language, growing toward the goal of
 * "manage your agent, workflows, skills, and all local/external tools."
 *
 * Auth piggy-backs on the same isAuthorized check the rest of the
 * dashboard routes use. Future console-specific endpoints (workflow
 * studio chat, project picker actions, etc.) register here too.
 */
interface WorkflowStepShape {
  id: string;
  prompt: string;
  dependsOn?: string[];
  model?: string;
  tier?: number;
  maxTurns?: number;
}
interface WorkflowFrontmatter {
  name?: string;
  description?: string;
  enabled?: boolean;
  trigger?: { schedule?: string; manual?: boolean };
  steps?: WorkflowStepShape[];
  inputs?: Record<string, { type?: string; default?: string; description?: string }>;
  synthesis?: { prompt?: string };
}

function validateCronExpression(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((part) => /^(\*|\*\/\d+|\d+|\d+-\d+)(,(\*\/\d+|\d+|\d+-\d+))*$/.test(part));
}

function sanitizeWorkflowFileName(name: string): string {
  return `${name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()}.md`;
}

function findWorkflowFile(workflowName: string): { file: string; data: WorkflowFrontmatter; content: string } | null {
  if (!existsSync(WORKFLOWS_DIR)) return null;
  for (const file of readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.md'))) {
    const filePath = path.join(WORKFLOWS_DIR, file);
    try {
      const parsed = matter(readFileSync(filePath, 'utf-8'));
      const data = parsed.data as WorkflowFrontmatter;
      if (data.name === workflowName) return { file, data, content: parsed.content };
    } catch { continue; }
  }
  return null;
}

function listAllWorkflows(): Array<{ file: string; data: WorkflowFrontmatter }> {
  if (!existsSync(WORKFLOWS_DIR)) return [];
  const out: Array<{ file: string; data: WorkflowFrontmatter }> = [];
  for (const file of readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.md'))) {
    try {
      const parsed = matter(readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8'));
      out.push({ file, data: parsed.data as WorkflowFrontmatter });
    } catch { continue; }
  }
  return out.sort((a, b) => (a.data.name ?? '').localeCompare(b.data.name ?? ''));
}

interface WorkflowValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  stepCount: number;
  hasCycles: boolean;
}

function validateWorkflowDefinition(data: WorkflowFrontmatter): WorkflowValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!data.name) errors.push('Workflow has no name.');
  if (!Array.isArray(data.steps) || data.steps.length === 0) errors.push('Workflow has no steps.');

  const steps = data.steps ?? [];
  const ids = new Set<string>();
  let duplicates = 0;
  for (const step of steps) {
    if (!step.id) errors.push('A step is missing an id.');
    if (!step.prompt || step.prompt.trim().length < 3) errors.push(`Step "${step.id ?? '?'}" has no substantive prompt.`);
    if (step.id) {
      if (ids.has(step.id)) duplicates++;
      ids.add(step.id);
    }
  }
  if (duplicates > 0) errors.push(`${duplicates} duplicate step id${duplicates === 1 ? '' : 's'}.`);

  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!ids.has(dep)) errors.push(`Step "${step.id}" depends on unknown step "${dep}".`);
    }
  }

  // Cycle detection via DFS on the dependency graph.
  const adj = new Map<string, string[]>();
  for (const step of steps) adj.set(step.id, step.dependsOn ?? []);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  let hasCycles = false;
  function dfs(node: string): boolean {
    color.set(node, GRAY);
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && dfs(next)) return true;
    }
    color.set(node, BLACK);
    return false;
  }
  for (const id of ids) {
    if ((color.get(id) ?? WHITE) === WHITE && dfs(id)) { hasCycles = true; break; }
  }
  if (hasCycles) errors.push('Dependency graph has a cycle.');

  if (data.trigger?.schedule && !validateCronExpression(data.trigger.schedule)) {
    errors.push(`Invalid cron expression: "${data.trigger.schedule}"`);
  }

  if (!data.description || data.description.trim().length < 8) {
    warnings.push('Description is missing or too short — the agent will have trouble picking the right workflow.');
  }
  if (data.enabled === false) {
    warnings.push('Workflow is currently disabled — Executor/Deployer handoffs will not fire it.');
  }
  if (steps.length > 12) {
    warnings.push(`${steps.length} steps is a lot — consider splitting into smaller workflows for reliability.`);
  }

  return { ok: errors.length === 0, errors, warnings, stepCount: steps.length, hasCycles };
}

export function registerConsoleRoutes(
  app: Express,
  isAuthorized: (req: Request) => boolean,
  assistant: ClementineAssistant,
): void {
  app.get('/console', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const queryToken = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    res.type('html').send(renderConsoleHtml(queryToken));
  });

  // ─── Console-specific API namespace ───────────────────────────────
  //
  // Routes under /api/console/* support the console panels. We avoid
  // touching the existing /api/* routes the dashboard already uses.

  /**
   * Search the vault via the existing recall layer (FTS + optional
   * embedding rerank). Returns hits in the same shape as MemorySearchHit
   * so the panel renderer stays simple.
   */
  app.get('/api/console/memory/search', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = Math.max(1, Math.min(20, parseInt(typeof req.query.limit === 'string' ? req.query.limit : '10', 10) || 10));
    if (!query) { res.json({ query: '', hits: [] }); return; }
    try {
      const hits = await recallHybrid(query, { limit });
      res.json({ query, hits });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * List durable facts. ?kind=user|project|feedback|reference filters.
   * Defaults to active only; ?includeInactive=1 includes soft-deleted.
   */
  app.get('/api/console/memory/facts', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const kindRaw = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    const allowedKinds = new Set(['user', 'project', 'feedback', 'reference']);
    const kind = kindRaw && allowedKinds.has(kindRaw) ? kindRaw as 'user' | 'project' | 'feedback' | 'reference' : undefined;
    const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
    const limit = Math.max(1, Math.min(200, parseInt(typeof req.query.limit === 'string' ? req.query.limit : '60', 10) || 60));
    try {
      const facts = includeInactive
        ? listAllFacts(limit).filter((f) => !kind || f.kind === kind)
        : listActiveFacts({ kind, limit });
      res.json({ facts });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Soft-delete a fact (sets active=0). Used by the panel's forget button.
   * Hard delete intentionally not exposed here — that lives in MCP tools
   * for the agent itself.
   */
  app.post('/api/console/memory/facts/:id/forget', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return; }
    try {
      const ok = forgetFact(id);
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * List indexed vault files with chunk counts + last index time. The
   * panel renders this as a browsable file tree on the left side.
   */
  app.get('/api/console/memory/files', (_req, res) => {
    try {
      const db = openMemoryDb();
      const rows = db.prepare(`
        SELECT
          path,
          COUNT(*) AS chunks,
          MAX(mtime) AS mtime,
          MAX(byte_size) AS byteSize
        FROM vault_chunks
        GROUP BY path
        ORDER BY MAX(mtime) DESC
      `).all() as Array<{ path: string; chunks: number; mtime: number; byteSize: number }>;
      const status = readMemoryIndexStatus();
      res.json({ files: rows, status });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Fetch the chunks for a single file, optionally with full content.
   * Used by the panel's file inspector.
   */
  app.get('/api/console/memory/file', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!filePath) { res.status(400).json({ error: 'path required' }); return; }
    try {
      const db = openMemoryDb();
      const chunks = db.prepare(`
        SELECT id, chunk_index AS chunkIndex, title, content, mtime, byte_size AS byteSize
        FROM vault_chunks WHERE path = ?
        ORDER BY chunk_index ASC
      `).all(filePath) as Array<{ id: number; chunkIndex: number; title: string | null; content: string; mtime: number; byteSize: number }>;

      let rawContent: string | undefined;
      if (existsSync(filePath)) {
        try { rawContent = readFileSync(filePath, 'utf-8').slice(0, 50_000); }
        catch { rawContent = undefined; }
      }

      res.json({ path: filePath, chunks, rawContent });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Workflow Studio ──────────────────────────────────────────

  app.get('/api/console/workflows', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const items = listAllWorkflows().map(({ file, data }) => ({
        name: data.name ?? file.replace(/\.md$/, ''),
        file,
        description: data.description ?? '',
        enabled: data.enabled !== false,
        triggerSchedule: data.trigger?.schedule ?? null,
        stepCount: Array.isArray(data.steps) ? data.steps.length : 0,
      }));
      res.json({ workflows: items });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/workflows/:name', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const entry = findWorkflowFile(req.params.name);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    res.json({
      name: entry.data.name ?? req.params.name,
      file: entry.file,
      description: entry.data.description ?? '',
      enabled: entry.data.enabled !== false,
      trigger: entry.data.trigger ?? { manual: true },
      steps: entry.data.steps ?? [],
      inputs: entry.data.inputs ?? {},
      synthesis: entry.data.synthesis ?? null,
    });
  });

  app.post('/api/console/workflows', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) { res.status(400).json({ error: 'name required' }); return; }
    if (findWorkflowFile(name)) { res.status(409).json({ error: 'workflow already exists' }); return; }
    const description = typeof body.description === 'string' ? body.description : '';
    const steps = Array.isArray(body.steps) ? body.steps : [];
    const triggerSchedule = typeof body.triggerSchedule === 'string' ? body.triggerSchedule.trim() : '';
    const trigger = triggerSchedule ? { schedule: triggerSchedule, manual: true } : { manual: true };
    if (triggerSchedule && !validateCronExpression(triggerSchedule)) {
      res.status(400).json({ error: `invalid cron expression: "${triggerSchedule}"` }); return;
    }
    const synthesis = typeof body.synthesisPrompt === 'string' && body.synthesisPrompt.trim()
      ? { prompt: body.synthesisPrompt.trim() } : undefined;
    const inputs = (body.inputs && typeof body.inputs === 'object') ? body.inputs : undefined;

    ensureDir(WORKFLOWS_DIR);
    const fileName = sanitizeWorkflowFileName(name);
    const filePath = path.join(WORKFLOWS_DIR, fileName);

    const frontmatter: WorkflowFrontmatter = {
      name, description,
      enabled: body.enabled !== false,
      trigger,
      steps,
    };
    if (inputs && Object.keys(inputs).length > 0) frontmatter.inputs = inputs;
    if (synthesis) frontmatter.synthesis = synthesis;

    writeFileSync(filePath, matter.stringify(`# ${name}\n\n${description}\n`, frontmatter as Record<string, unknown>), 'utf-8');
    res.json({ created: true, name, file: fileName });
  });

  app.patch('/api/console/workflows/:name', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const entry = findWorkflowFile(req.params.name);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    const body = req.body ?? {};
    const filePath = path.join(WORKFLOWS_DIR, entry.file);
    const next: WorkflowFrontmatter = { ...entry.data };

    if (typeof body.description === 'string') next.description = body.description;
    if (Array.isArray(body.steps)) next.steps = body.steps;
    if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
    if (body.synthesisPrompt !== undefined) {
      next.synthesis = typeof body.synthesisPrompt === 'string' && body.synthesisPrompt.trim()
        ? { prompt: body.synthesisPrompt.trim() } : undefined;
    }
    if (body.inputs && typeof body.inputs === 'object') next.inputs = body.inputs;
    if (typeof body.triggerSchedule === 'string') {
      const s = body.triggerSchedule.trim();
      if (s && !validateCronExpression(s)) { res.status(400).json({ error: `invalid cron: ${s}` }); return; }
      next.trigger = s ? { schedule: s, manual: true } : { manual: true };
    } else if (body.clearTriggerSchedule === true) {
      next.trigger = { manual: true };
    }

    writeFileSync(filePath, matter.stringify(entry.content, next as Record<string, unknown>), 'utf-8');
    res.json({ updated: true, name: next.name ?? req.params.name });
  });

  app.delete('/api/console/workflows/:name', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const entry = findWorkflowFile(req.params.name);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    unlinkSync(path.join(WORKFLOWS_DIR, entry.file));
    res.json({ deleted: true });
  });

  app.post('/api/console/workflows/:name/set-enabled', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const entry = findWorkflowFile(req.params.name);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    const body = req.body ?? {};
    if (typeof body.enabled !== 'boolean') { res.status(400).json({ error: 'enabled (boolean) required' }); return; }
    const filePath = path.join(WORKFLOWS_DIR, entry.file);
    const next: WorkflowFrontmatter = { ...entry.data, enabled: body.enabled };
    writeFileSync(filePath, matter.stringify(entry.content, next as Record<string, unknown>), 'utf-8');
    res.json({ updated: true, enabled: body.enabled });
  });

  app.post('/api/console/workflows/:name/validate', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const entry = findWorkflowFile(req.params.name);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    res.json(validateWorkflowDefinition(entry.data));
  });

  app.post('/api/console/workflows/:name/run', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const entry = findWorkflowFile(req.params.name);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    if (entry.data.enabled === false) { res.status(409).json({ error: 'workflow is disabled — approve it first' }); return; }
    const body = req.body ?? {};
    const inputs = body.inputs && typeof body.inputs === 'object' ? body.inputs : {};
    const dryRun = body.dryRun === true;

    ensureDir(WORKFLOW_RUNS_DIR);
    const id = `${Date.now()}-${randomBytes(3).toString('hex')}`;
    const filePath = path.join(WORKFLOW_RUNS_DIR, `${id}.json`);
    writeFileSync(filePath, JSON.stringify({
      id,
      workflow: entry.data.name,
      inputs,
      status: dryRun ? 'dry_run' : 'queued',
      createdAt: new Date().toISOString(),
      source: 'console',
    }, null, 2), 'utf-8');
    res.json({ queued: !dryRun, dryRun, id });
  });

  /**
   * Workflow architect chat — sends the user's message + the current
   * draft workflow JSON to the assistant with workflow-builder-specific
   * instructions, returns the response text. Stateless per call;
   * frontend manages the chat history client-side and replays it as
   * a single rolled-up prompt for context. Keeps the backend simple.
   */
  app.post('/api/console/workflows/architect/chat', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    const userMessage = typeof body.message === 'string' ? body.message.trim() : '';
    if (!userMessage) { res.status(400).json({ error: 'message required' }); return; }
    const draft = body.draft && typeof body.draft === 'object' ? body.draft : null;
    const history = Array.isArray(body.history) ? body.history.slice(-10) : [];

    const transcript = history.map((m: { role?: string; text?: string }) => `${m.role === 'assistant' ? 'Architect' : 'User'}: ${m.text ?? ''}`).join('\n\n');
    const draftBlock = draft ? `Current workflow draft (JSON):\n\`\`\`json\n${JSON.stringify(draft, null, 2)}\n\`\`\`` : 'No draft yet — agent is starting from scratch.';

    const prompt = [
      'You are the Clementine Workflow Architect — a focused sub-mode that helps the user design and edit multi-step workflows.',
      'Each workflow has: name, description, trigger (manual or cron schedule), steps (with id + prompt + optional dependsOn), inputs, optional synthesis prompt.',
      'When the user asks for an edit, propose CONCRETE changes — step text, dependency edges, schedule expressions, input keys. Show the diff in plain language plus a short JSON snippet of the changed slice.',
      'Be terse. No preamble. Lead with the answer.',
      '',
      draftBlock,
      '',
      transcript ? `Conversation so far:\n${transcript}\n` : '',
      `User: ${userMessage}`,
    ].filter(Boolean).join('\n\n');

    try {
      const response = await assistant.respond({
        message: prompt,
        sessionId: `console:workflow-architect:${body.draftName ?? 'new'}`,
        channel: 'cli',
        userId: 'console',
      });
      res.json({ text: response.text });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Tools catalog ────────────────────────────────────────────

  /** Map a tool name to a UI-friendly category. Mirrors the runtime
   *  categories used by autonomy-v2's policy filter + the dashboard
   *  state's toolCategory. Kept here so the console doesn't depend on
   *  the dashboard module. */
  function categorizeTool(name: string): string {
    if (name.startsWith('memory_') || name === 'working_memory' || name.startsWith('note_')) return 'Memory';
    if (name.startsWith('task_') || name === 'create_plan' || name === 'list_plans' || name === 'update_plan_step' || name === 'discover_work' || name.startsWith('goal_')) return 'Planning';
    if (name.startsWith('execution_')) return 'Executions';
    if (name.startsWith('check_in') || name === 'ask_user_question' || name === 'list_pending_check_ins' || name === 'answer_check_in') return 'Check-ins';
    if (name === 'notify_user') return 'Notifications';
    if (name.startsWith('agent_run') || name.startsWith('user_profile') || name.startsWith('team_') || name.startsWith('create_agent') || name.startsWith('update_agent') || name.startsWith('delete_agent') || name.startsWith('delegate') || name === 'check_delegation') return 'Agents';
    if (name === 'set_timer' || name.startsWith('cron_') || name.startsWith('workflow_') || name === 'trigger_cron_job' || name === 'add_cron_job') return 'Automation';
    if (name === 'workspace_config' || name === 'workspace_list' || name === 'workspace_info' || name === 'workspace_roots' || name === 'list_files' || name === 'read_file' || name === 'write_file' || name === 'run_shell_command' || name === 'git_status') return 'Computer';
    if (name.startsWith('composio_')) return 'Connected Apps';
    if (name === 'session_history' || name === 'session_pause' || name === 'session_resume') return 'Sessions';
    if (name === 'create_tool') return 'Meta';
    if (name === 'ping') return 'System';
    if (name === 'request_destructive_action') return 'System';
    return 'Other';
  }

  app.get('/api/console/tools', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      // Local MCP tools — from the catalog (string names) plus the
      // SDK-native tools registered in registry.ts (have full schema).
      const sdkTools = getCoreTools()
        .filter((tool) => tool.type === 'function')
        .map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          category: categorizeTool(tool.name),
          source: 'sdk' as const,
          needsApproval: Boolean((tool as { needsApproval?: unknown }).needsApproval),
        }));

      const sdkNames = new Set(sdkTools.map((t) => t.name));
      const mcpOnlyTools = LOCAL_MCP_TOOL_NAMES
        .filter((name) => !sdkNames.has(name))
        .map((name) => ({
          name,
          description: '',
          category: categorizeTool(name),
          source: 'mcp' as const,
          needsApproval: false,
        }));

      const allTools = [...sdkTools, ...mcpOnlyTools].sort((a, b) =>
        a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
      );

      // Discovered MCP servers (firecrawl, playwright, etc.) — what
      // ELSE the agent has access to from the user's Claude Desktop /
      // Claude Code config.
      const mcpServers = discoverMcpServers().map((server) => ({
        name: server.name,
        description: server.description ?? '',
        enabled: server.enabled !== false,
        source: server.source,
        transport: server.type,
        command: server.command,
        url: server.url,
      }));

      res.json({ tools: allTools, mcpServers });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Projects (workspace) ─────────────────────────────────────

  app.get('/api/console/projects', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const dirs = getWorkspaceDirs();
      const projects = listWorkspaceProjects() || [];
      res.json({ workspaceDirs: dirs, projects });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Inspect one project deeply: README, CLAUDE.md, package.json snippet
   *  to surface relevant metadata for the user without exposing the
   *  whole filesystem. */
  app.get('/api/console/projects/inspect', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const root = typeof req.query.path === 'string' ? req.query.path : '';
    if (!root || !existsSync(root)) { res.status(404).json({ error: 'path not found' }); return; }
    try {
      const result: Record<string, unknown> = { path: root };

      // README in any common form.
      for (const name of ['README.md', 'readme.md', 'README', 'README.markdown']) {
        const candidate = path.join(root, name);
        if (existsSync(candidate)) {
          try { result.readme = readFileSync(candidate, 'utf-8').slice(0, 8000); }
          catch { /* ignore */ }
          break;
        }
      }

      // CLAUDE.md — both root and .claude/ subdir.
      for (const candidate of [path.join(root, 'CLAUDE.md'), path.join(root, '.claude', 'CLAUDE.md')]) {
        if (existsSync(candidate)) {
          try { result.claudeMd = readFileSync(candidate, 'utf-8').slice(0, 8000); }
          catch { /* ignore */ }
          break;
        }
      }

      // package.json — pull a structured snippet.
      const pkgPath = path.join(root, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
          result.package = {
            name: pkg.name,
            version: pkg.version,
            description: pkg.description,
            scripts: pkg.scripts ?? {},
            dependencies: pkg.dependencies ? Object.keys(pkg.dependencies) : [],
            devDependencies: pkg.devDependencies ? Object.keys(pkg.devDependencies) : [],
          };
        } catch { /* ignore */ }
      }

      // Top-level entries.
      try {
        const entries = readdirSync(root, { withFileTypes: true })
          .filter((e) => !e.name.startsWith('.'))
          .slice(0, 80)
          .map((e) => ({ name: e.name, isDir: e.isDirectory() }));
        result.entries = entries;
      } catch { /* ignore */ }

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Skills (plugins) ──────────────────────────────────────────

  app.get('/api/console/skills', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const plugins = await loadPlugins();
      const items = plugins.map((p) => ({
        name: p.name,
        version: p.version ?? null,
        description: p.description ?? '',
        toolCount: Array.isArray(p.tools) ? p.tools.length : 0,
        tools: (p.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
      }));
      res.json({ plugins: items, pluginsDir: PLUGINS_DIR });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Settings ──────────────────────────────────────────────────

  app.get('/api/console/settings', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const profile = loadUserProfile();
      const proactivity = getProactivityPolicySnapshot();
      const auth = getAuthStatus();
      const memory = readMemoryIndexStatus();
      res.json({ profile, proactivity, auth, memory });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/console/settings/profile', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const updated = saveUserProfile(req.body ?? {});
      res.json({ profile: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/console/settings/policy', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const updated = saveProactivityPolicy(req.body ?? {});
      res.json({ policy: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Credentials health + management ───────────────────────────
  //
  // Backed by the SecretStore abstraction (src/runtime/secrets). The
  // dashboard never sees raw secret values for env-only or already-
  // stored credentials — only their existence, source, and status.
  //
  // POST endpoints accept a raw value once (when the user enters it)
  // and write it through the store. Migrations and resets call into
  // the existing methods.

  app.get('/api/console/credentials', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const store = await getSecretStore();
      const rows = await store.health();
      const descriptors = listSecretDescriptors().reduce<Record<string, { description: string; setupHint?: string; required: boolean; envVarName: string }>>(
        (acc, d) => { acc[d.name] = { description: d.description, setupHint: d.setupHint, required: d.required, envVarName: d.envVarName }; return acc; },
        {},
      );
      res.json({ rows, descriptors });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/credentials/set', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    const name = typeof body.name === 'string' ? body.name : '';
    const value = typeof body.value === 'string' ? body.value : '';
    const known = listSecretDescriptors().map((d) => d.name as string);
    if (!known.includes(name)) { res.status(400).json({ error: 'unknown credential name' }); return; }
    if (!value) { res.status(400).json({ error: 'value required' }); return; }
    try {
      const store = await getSecretStore();
      const result = await store.set(name as SecretName, value);
      res.json({ name: result.name, source: result.source, status: result.status });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/credentials/migrate', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    const name = typeof body.name === 'string' ? body.name : '';
    const from = body.from === 'env' || body.from === 'file' ? body.from : null;
    const to = body.to === 'keychain' || body.to === 'file' ? body.to : null;
    if (!name || !from || !to) { res.status(400).json({ error: 'name, from, to required' }); return; }
    try {
      const store = await getSecretStore();
      const result = await store.migrate(name as SecretName, from, to);
      res.json({ name: result.name, source: result.source, status: result.status });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/credentials/repair-keychain', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const store = await getSecretStore();
      const report = await store.repairKeychain();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/credentials/reset', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    if (body.confirm !== true) {
      res.status(400).json({ error: 'confirm: true required — this deletes all clementine-owned credentials' });
      return;
    }
    try {
      const store = await getSecretStore();
      const report = await store.resetAll();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/console/credentials/:name', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const name = req.params.name;
    const known = listSecretDescriptors().map((d) => d.name as string);
    if (!known.includes(name)) { res.status(400).json({ error: 'unknown credential name' }); return; }
    try {
      const store = await getSecretStore();
      await store.delete(name as SecretName);
      res.json({ deleted: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Proactive check-in templates ──────────────────────────────

  app.get('/api/console/check-in-templates', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      ensureSeedTemplates();
      const items = listCheckInTemplates().map((t) => ({ ...t, state: getTemplateState(t.id) }));
      res.json({ templates: items });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/check-in-templates/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const t = getCheckInTemplate(req.params.id);
    if (!t) { res.status(404).json({ error: 'template not found' }); return; }
    res.json({ template: t, state: getTemplateState(t.id) });
  });

  app.post('/api/console/check-in-templates', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    if (!body.name || !body.trigger || !body.questionTemplate) {
      res.status(400).json({ error: 'name, trigger, questionTemplate required' }); return;
    }
    try {
      const created = createCheckInTemplate({
        name: body.name,
        description: body.description,
        agentSlug: body.agentSlug,
        trigger: body.trigger as TriggerKind,
        schedule: body.schedule,
        blockedHours: body.blockedHours,
        staleDays: body.staleDays,
        inboxThreshold: body.inboxThreshold,
        questionTemplate: body.questionTemplate,
        urgency: body.urgency as CheckInUrgency,
        cooldownHours: body.cooldownHours,
        enabled: body.enabled === true,
      });
      res.json({ template: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/console/check-in-templates/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const updated = updateCheckInTemplate(req.params.id, req.body ?? {});
    if (!updated) { res.status(404).json({ error: 'template not found' }); return; }
    res.json({ template: updated });
  });

  app.delete('/api/console/check-in-templates/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const ok = deleteCheckInTemplate(req.params.id);
    if (!ok) { res.status(404).json({ error: 'template not found' }); return; }
    res.json({ deleted: true });
  });

  app.post('/api/console/check-in-templates/:id/test', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const bypassCooldown = req.body?.bypassCooldown === true;
    const result = testFireTemplate(req.params.id, { bypassCooldown });
    if (!result.ok) { res.status(400).json(result); return; }
    res.json(result);
  });

  // ─── Agent-drafted check-in proposals ──────────────────────────

  app.get('/api/console/check-in-proposals', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const wanted = (status === 'pending' || status === 'approved' || status === 'rejected' || status === 'all')
      ? status : 'pending';
    try {
      const items = listProposals({ status: wanted, limit: 50 });
      res.json({ proposals: items });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/check-in-proposals/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const p = getProposal(req.params.id);
    if (!p) { res.status(404).json({ error: 'proposal not found' }); return; }
    res.json({ proposal: p });
  });

  app.post('/api/console/check-in-proposals/:id/approve', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    try {
      const result = approveProposal(req.params.id, {
        overrides: body.overrides && typeof body.overrides === 'object' ? body.overrides : undefined,
        enabledOnInstall: typeof body.enabledOnInstall === 'boolean' ? body.enabledOnInstall : true,
      });
      if (!result) { res.status(404).json({ error: 'proposal not found or already resolved' }); return; }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/check-in-proposals/:id/reject', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    const result = rejectProposal(req.params.id, reason);
    if (!result) { res.status(404).json({ error: 'proposal not found' }); return; }
    res.json({ proposal: result });
  });

  app.delete('/api/console/check-in-proposals/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const ok = deleteProposal(req.params.id);
    if (!ok) { res.status(404).json({ error: 'proposal not found' }); return; }
    res.json({ deleted: true });
  });

  // ─── Plan proposals (Planner sub-agent → user review) ──────────

  app.get('/api/console/plan-proposals', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const wanted = (status === 'pending' || status === 'approved' || status === 'rejected' || status === 'superseded' || status === 'all')
      ? status : 'pending';
    try {
      const items = listPlanProposals({ status: wanted, limit: 50 });
      res.json({ proposals: items });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/plan-proposals/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const p = getPlanProposal(req.params.id);
    if (!p) { res.status(404).json({ error: 'plan proposal not found' }); return; }
    res.json({ proposal: p });
  });

  app.post('/api/console/plan-proposals/:id/approve', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    let editedPlan: ReturnType<typeof PlanSchema.parse> | undefined;
    if (body.editedPlan && typeof body.editedPlan === 'object') {
      const parsed = PlanSchema.safeParse(body.editedPlan);
      if (!parsed.success) {
        res.status(400).json({ error: 'editedPlan did not match PlanSchema', details: parsed.error.message });
        return;
      }
      editedPlan = parsed.data;
    }
    const result = approvePlanProposal(req.params.id, { editedPlan });
    if (!result) { res.status(404).json({ error: 'plan proposal not found or already resolved' }); return; }
    res.json({ proposal: result });
  });

  app.post('/api/console/plan-proposals/:id/reject', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    const result = rejectPlanProposal(req.params.id, reason);
    if (!result) { res.status(404).json({ error: 'plan proposal not found' }); return; }
    res.json({ proposal: result });
  });

  app.delete('/api/console/plan-proposals/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const ok = deletePlanProposal(req.params.id);
    if (!ok) { res.status(404).json({ error: 'plan proposal not found' }); return; }
    res.json({ deleted: true });
  });
}
