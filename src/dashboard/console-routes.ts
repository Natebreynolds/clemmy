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
import { ensureDir, WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import type { ClementineAssistant } from '../assistant/core.js';

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
}
