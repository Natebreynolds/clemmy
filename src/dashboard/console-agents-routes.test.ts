/**
 * Run: npx tsx --test src/dashboard/console-agents-routes.test.ts
 *
 * Functional smoke for the read-only multi-agent workspace routes
 * (GET /api/console/agents[/graph|/comms|/:slug/runs|/:slug/run/:id]).
 * Seeds a temp home with two agent.md files, a team-comms.jsonl line
 * (incl. a malformed line), and a delegation file; boots a tiny Express
 * app with the REAL registerConsoleRoutes (stub assistant — these routes
 * never touch it). Offline, deterministic, per-test temp home.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-console-agents-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const AGENTS_DIR = path.join(TMP_HOME, 'vault', '00-System', 'agents');
const LOGS_DIR = path.join(TMP_HOME, 'logs');
const DELEGATIONS_DIR = path.join(TMP_HOME, 'delegations');
const STATE_DIR = path.join(TMP_HOME, 'agents-state');

function writeAgent(slug: string, frontmatter: string, persona: string): void {
  const dir = path.join(AGENTS_DIR, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'agent.md'), `---\n${frontmatter}\n---\n${persona}\n`, 'utf-8');
}

// --- seed before importing the route module (dir constants are resolved at load) ---
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
mkdirSync(LOGS_DIR, { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });

writeAgent('clementine', 'name: Clementine\ndescription: The primary orchestrator\nrole: orchestrator', 'You are Clementine.');
writeAgent(
  'researcher',
  ['name: Researcher', 'description: Read-only fact gatherer', 'role: research', 'canMessage:', '  - clementine', 'proactive: true', 'cadenceMinutes: 30'].join('\n'),
  'You research things.',
);
// An agent with a recorded error → derived status should be "blocked".
writeAgent('writer', 'name: Writer\ndescription: Drafts copy\ncanMessage:\n  - clementine', 'You write.');
writeFileSync(path.join(STATE_DIR, 'writer.json'), JSON.stringify({ slug: 'writer', lastError: 'composio auth expired', lastRunAt: '2026-06-22T10:00:00.000Z' }), 'utf-8');

// Team comms: one good message + one malformed line (must be skipped).
writeFileSync(
  path.join(LOGS_DIR, 'team-comms.jsonl'),
  [
    JSON.stringify({ id: 'm1', fromAgent: 'researcher', toAgent: 'clementine', content: 'found 3 sources', timestamp: '2026-06-22T11:00:00.000Z', protocol: 'message' }),
    '{ this is not valid json',
  ].join('\n') + '\n',
  'utf-8',
);

// One delegation.
mkdirSync(path.join(DELEGATIONS_DIR, 'researcher'), { recursive: true });
writeFileSync(
  path.join(DELEGATIONS_DIR, 'researcher', 'd1.json'),
  JSON.stringify({ id: 'd1', fromAgent: 'clementine', toAgent: 'researcher', task: 'pull SEO metrics', expectedOutput: 'a table', status: 'pending', createdAt: '2026-06-22T09:00:00.000Z', updatedAt: '2026-06-22T09:00:00.000Z' }),
  'utf-8',
);

const { registerConsoleRoutes } = await import('./console-routes.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

async function boot(authorized = { v: true }) {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => authorized.v, {} as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

interface AgentSummary {
  slug: string; name: string; role: string | null; canMessage: string[];
  status: string; proactive: boolean; lastError: string | null; pendingInbox: number;
}

test('GET /api/console/agents returns the enriched roster; auth gated', async () => {
  const authorized = { v: true };
  const h = await boot(authorized);
  try {
    authorized.v = false;
    assert.equal((await fetch(`${h.url}/api/console/agents`)).status, 401);

    authorized.v = true;
    const res = await fetch(`${h.url}/api/console/agents`);
    assert.equal(res.status, 200);
    const body = await res.json() as { agents: AgentSummary[]; generatedAt: string };
    const bySlug = new Map(body.agents.map((a) => [a.slug, a]));

    assert.ok(bySlug.has('clementine'), 'clementine present');
    const researcher = bySlug.get('researcher');
    assert.ok(researcher, 'researcher present');
    assert.deepEqual(researcher!.canMessage, ['clementine'], 'canMessage parsed from frontmatter');
    assert.equal(researcher!.status, 'idle', 'no error, no active run → idle');
    assert.equal(researcher!.proactive, true);

    const writer = bySlug.get('writer');
    assert.equal(writer!.status, 'blocked', 'recorded lastError → blocked');
    assert.equal(writer!.lastError, 'composio auth expired');
  } finally {
    await h.close();
  }
});

test('GET /api/console/agents/graph returns nodes + canMessage edges', async () => {
  const h = await boot();
  try {
    const body = await (await fetch(`${h.url}/api/console/agents/graph`)).json() as {
      nodes: Array<{ id: string; primary: boolean; status: string }>;
      edges: Array<{ source: string; target: string }>;
    };
    const ids = new Set(body.nodes.map((n) => n.id));
    assert.ok(ids.has('clementine') && ids.has('researcher') && ids.has('writer'));
    assert.equal(body.nodes.find((n) => n.id === 'clementine')!.primary, true);
    // researcher → clementine and writer → clementine edges, no dangling targets.
    assert.ok(body.edges.some((e) => e.source === 'researcher' && e.target === 'clementine'));
    assert.ok(body.edges.every((e) => ids.has(e.source) && ids.has(e.target)), 'no edge to an unknown node');
  } finally {
    await h.close();
  }
});

test('GET /api/console/agents/comms returns messages + delegations, skips malformed jsonl', async () => {
  const h = await boot();
  try {
    const body = await (await fetch(`${h.url}/api/console/agents/comms`)).json() as {
      messages: Array<{ id: string; fromAgent: string; toAgent: string }>;
      delegations: Array<{ id: string; status: string }>;
    };
    assert.equal(body.messages.length, 1, 'malformed line skipped, one good message');
    assert.equal(body.messages[0].id, 'm1');
    assert.equal(body.delegations.length, 1);
    assert.equal(body.delegations[0].id, 'd1');
    assert.equal(body.delegations[0].status, 'pending');
  } finally {
    await h.close();
  }
});

test('GET /api/console/agents/:slug/runs returns an array; unknown run → 404', async () => {
  const h = await boot();
  try {
    const runs = await (await fetch(`${h.url}/api/console/agents/researcher/runs`)).json() as { runs: unknown[] };
    assert.ok(Array.isArray(runs.runs), 'runs array (empty store is fine)');

    const missing = await fetch(`${h.url}/api/console/agents/researcher/run/does-not-exist`);
    assert.equal(missing.status, 404);
  } finally {
    await h.close();
  }
});

test('POST creates an agent; duplicate → 409; PATCH edits; DELETE removes; auth gated', async () => {
  const authorized = { v: true };
  const h = await boot(authorized);
  const post = (path: string, body: unknown, method = 'POST') =>
    fetch(`${h.url}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    // Unauthorized create → 401.
    authorized.v = false;
    assert.equal((await post('/api/console/agents', { name: 'Analyst' })).status, 401);
    authorized.v = true;

    // Create → 200 with the summarized agent, slug derived from name.
    const created = await post('/api/console/agents', {
      name: 'Data Analyst', description: 'Crunches numbers', role: 'analysis',
      canMessage: ['clementine'], cadenceMinutes: 2, proactive: true,
    });
    assert.equal(created.status, 200);
    const body = await created.json() as { agent: { slug: string; cadenceMinutes: number; canMessage: string[] } };
    assert.equal(body.agent.slug, 'data-analyst');
    assert.equal(body.agent.cadenceMinutes, 5, 'cadence floored at 5');
    assert.deepEqual(body.agent.canMessage, ['clementine']);

    // It shows up on the roster.
    const roster = await (await fetch(`${h.url}/api/console/agents`)).json() as { agents: Array<{ slug: string }> };
    assert.ok(roster.agents.some((a) => a.slug === 'data-analyst'), 'new agent on roster');

    // Duplicate create → 409.
    assert.equal((await post('/api/console/agents', { name: 'Data Analyst' })).status, 409);

    // PATCH a subset → only those fields change; pause via autonomyEnabled:false.
    const patched = await post('/api/console/agents/data-analyst', { description: 'Now does forecasts', autonomyEnabled: false }, 'PATCH');
    assert.equal(patched.status, 200);
    const pb = await patched.json() as { agent: { description: string; role: string | null; autonomyEnabled: boolean } };
    assert.equal(pb.agent.description, 'Now does forecasts');
    assert.equal(pb.agent.role, 'analysis', 'untouched field preserved');
    assert.equal(pb.agent.autonomyEnabled, false, 'paused');

    // PATCH unknown → 404.
    assert.equal((await post('/api/console/agents/nope', { description: 'x' }, 'PATCH')).status, 404);

    // The primary orchestrator cannot be deleted.
    assert.equal((await fetch(`${h.url}/api/console/agents/clementine`, { method: 'DELETE' })).status, 400);

    // DELETE the created agent → gone from the roster.
    assert.equal((await fetch(`${h.url}/api/console/agents/data-analyst`, { method: 'DELETE' })).status, 200);
    const after = await (await fetch(`${h.url}/api/console/agents`)).json() as { agents: Array<{ slug: string }> };
    assert.equal(after.agents.some((a) => a.slug === 'data-analyst'), false, 'deleted agent off the roster');
  } finally {
    await h.close();
  }
});

test('slice 4: skills + workflows round-trip and appear as graph nodes/edges; catalog endpoint shape', async () => {
  const h = await boot();
  const post = (path: string, body: unknown, method = 'POST') =>
    fetch(`${h.url}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    // Create an agent that owns a skill + a workflow.
    const created = await post('/api/console/agents', {
      name: 'SEO Specialist', description: 'owns seo work',
      canMessage: ['clementine'], skills: ['seo-audit'], workflows: ['weekly-seo-report'],
    });
    assert.equal(created.status, 200);
    const body = await created.json() as { agent: { slug: string; skills: string[]; workflows: string[] } };
    assert.deepEqual(body.agent.skills, ['seo-audit']);
    assert.deepEqual(body.agent.workflows, ['weekly-seo-report']);

    // Graph gains skill: + wf: nodes and typed ownership edges.
    const graph = await (await fetch(`${h.url}/api/console/agents/graph`)).json() as {
      nodes: Array<{ id: string; kind: string }>;
      edges: Array<{ source: string; target: string; kind: string }>;
    };
    assert.ok(graph.nodes.some((n) => n.id === 'skill:seo-audit' && n.kind === 'skill'), 'skill node present');
    assert.ok(graph.nodes.some((n) => n.id === 'wf:weekly-seo-report' && n.kind === 'workflow'), 'workflow node present');
    assert.ok(graph.edges.some((e) => e.source === 'seo-specialist' && e.target === 'skill:seo-audit' && e.kind === 'skill'), 'skill ownership edge');
    assert.ok(graph.edges.some((e) => e.source === 'seo-specialist' && e.target === 'wf:weekly-seo-report' && e.kind === 'workflow'), 'workflow ownership edge');
    assert.ok(graph.edges.some((e) => e.kind === 'message'), 'canMessage edges still present');

    // PATCH clears a binding (empty array overrides existing).
    const patched = await post('/api/console/agents/seo-specialist', { workflows: [] }, 'PATCH');
    const pb = await patched.json() as { agent: { skills: string[]; workflows: string[] } };
    assert.deepEqual(pb.agent.workflows, [], 'workflows cleared');
    assert.deepEqual(pb.agent.skills, ['seo-audit'], 'skills untouched');

    // Catalog endpoint returns arrays (empty in this temp home — no installs).
    const cat = await (await fetch(`${h.url}/api/console/agents/catalog`)).json() as { skills: unknown[]; workflows: unknown[] };
    assert.ok(Array.isArray(cat.skills) && Array.isArray(cat.workflows), 'catalog has skills + workflows arrays');
  } finally {
    await h.close();
  }
});
