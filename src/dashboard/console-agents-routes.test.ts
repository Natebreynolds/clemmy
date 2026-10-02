/**
 * Run: npx tsx --test src/dashboard/console-agents-routes.test.ts
 *
 * The console Agents API over the one agent store. Seeds a temp home with
 * agent.md files and boots the REAL registerConsoleRoutes (stub assistant;
 * these routes never touch it). Offline, deterministic, per-test temp home.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-console-agents-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const AGENTS_DIR = path.join(TMP_HOME, 'vault', '00-System', 'agents');
const STATE_DIR = path.join(TMP_HOME, 'agents-state');

function writeAgent(slug: string, frontmatter: string, body: string): void {
  const dir = path.join(AGENTS_DIR, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'agent.md'), `---\n${frontmatter}\n---\n${body}\n`, 'utf-8');
}

// --- seed before importing the route module (dir constants are resolved at load) ---
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });

// The host's own record must never appear as an agent.
writeAgent('clementine', 'name: Clementine\ndescription: The primary orchestrator', 'You are Clementine.');
writeAgent(
  'researcher',
  ['name: Researcher', 'description: Read-only fact gatherer', 'skills:', '  - web-research', 'tools:', '  - firecrawl', 'model: worker', 'updatedAt: "2026-09-01T00:00:00.000Z"'].join('\n'),
  'Gather facts before decisions.',
);
// An older record that still carries team-era fields the product no longer edits.
writeAgent('writer', 'name: Writer\ndescription: Drafts copy\ncanMessage:\n  - clementine\nproject: acme', 'You write.');
writeFileSync(path.join(STATE_DIR, 'writer.json'), JSON.stringify({ slug: 'writer', lastError: 'old' }), 'utf-8');

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

interface Agent {
  id: string; name: string; handles: string; instructions: string;
  skills: string[]; workflows: string[]; tools: string[]; model: string | null; memoryScope: string | null;
  createdFrom: string | null; updatedAt: string | null;
}

test('GET /api/console/agents lists the records, never the host; auth gated', async () => {
  const auth = { v: true };
  const { url, close } = await boot(auth);
  try {
    const res = await fetch(`${url}/api/console/agents`);
    assert.equal(res.status, 200);
    const body = await res.json() as { agents: Agent[] };
    const ids = body.agents.map((a) => a.id).sort();
    assert.deepEqual(ids, ['researcher', 'writer']);
    const researcher = body.agents.find((a) => a.id === 'researcher')!;
    assert.equal(researcher.handles, 'Read-only fact gatherer');
    assert.equal(researcher.instructions, 'Gather facts before decisions.');
    assert.deepEqual(researcher.tools, ['firecrawl']);
    assert.equal(researcher.model, 'worker');

    auth.v = false;
    assert.equal((await fetch(`${url}/api/console/agents`)).status, 401);
  } finally {
    await close();
  }
});

test('GET /api/console/agents/:id returns one record; unknown or host → 404', async () => {
  const { url, close } = await boot();
  try {
    const one = await fetch(`${url}/api/console/agents/writer`);
    assert.equal(one.status, 200);
    assert.equal(((await one.json()) as { agent: Agent }).agent.name, 'Writer');
    assert.equal((await fetch(`${url}/api/console/agents/nobody`)).status, 404);
    assert.equal((await fetch(`${url}/api/console/agents/clementine`)).status, 404);
  } finally {
    await close();
  }
});

test('POST creates; duplicate → 409; reserved name → 400; PATCH edits and clears; DELETE removes state too', async () => {
  const { url, close } = await boot();
  try {
    const post = async (body: unknown) => fetch(`${url}/api/console/agents`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const created = await post({
      name: 'Prospect Research Desk', handles: 'Research on new prospects.', instructions: 'Check speed first.',
      skills: ['prospect-research'], workflows: ['prospect-batch'], tools: ['sheets'], model: 'writer',
    });
    assert.equal(created.status, 200);
    const agent = ((await created.json()) as { agent: Agent }).agent;
    assert.equal(agent.id, 'prospect-research-desk');
    assert.equal(agent.createdFrom, 'console');
    assert.ok(existsSync(path.join(AGENTS_DIR, 'prospect-research-desk', 'agent.md')));

    assert.equal((await post({ name: 'prospect research desk' })).status, 409);
    assert.equal((await post({ name: 'Clementine' })).status, 400);
    assert.equal((await post({ name: '   ' })).status, 400);

    const patched = await fetch(`${url}/api/console/agents/prospect-research-desk`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: '', handles: 'Prospect research.' }),
    });
    assert.equal(patched.status, 200);
    const after = ((await patched.json()) as { agent: Agent }).agent;
    assert.equal(after.model, null, 'an empty string clears the model');
    assert.equal(after.handles, 'Prospect research.');
    assert.deepEqual(after.skills, ['prospect-research'], 'fields not in the patch stay');

    assert.equal((await fetch(`${url}/api/console/agents/nobody`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);

    const removed = await fetch(`${url}/api/console/agents/writer`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.ok(!existsSync(path.join(AGENTS_DIR, 'writer')));
    assert.ok(!existsSync(path.join(STATE_DIR, 'writer.json')), 'the runtime state file goes with it');
    assert.equal((await fetch(`${url}/api/console/agents/clementine`, { method: 'DELETE' })).status, 404);
  } finally {
    await close();
  }
});

test('GET /api/console/agents/:id/work lists the agent\'s conversations and worker runs, never the definition', async () => {
  const { url, close } = await boot();
  try {
    // A worker that ran as the researcher, and one that ran as nobody.
    const { recordSubagentRun } = await import('../agents/subagent-runs.js');
    recordSubagentRun({
      id: 'w-1', parentRunId: 'sess-desktop-abc', parentKind: 'session', role: 'research', boundAgentId: 'researcher',
      provider: 'claude', model: 'claude-x', task: 'acme', status: 'ok', output: 'Three findings.',
      startedAt: '2026-09-25T10:00:00.000Z', finishedAt: '2026-09-25T10:00:30.000Z',
    });
    recordSubagentRun({
      id: 'w-2', parentRunId: 'sess-desktop-abc', parentKind: 'session', role: 'research',
      provider: 'claude', model: 'claude-x', task: 'globex', status: 'ok', output: 'Unbound.',
      startedAt: '2026-09-25T10:01:00.000Z', finishedAt: '2026-09-25T10:01:30.000Z',
    });
    const res = await fetch(`${url}/api/console/agents/researcher/work`);
    assert.equal(res.status, 200);
    const body = await res.json() as { threads: unknown[]; workers: Array<{ id: string; boundAgentId?: string }> };
    assert.ok(Array.isArray(body.threads));
    assert.deepEqual(body.workers.map((w) => w.id), ['w-1'], 'only the worker that ran as this agent');
    assert.equal((await fetch(`${url}/api/console/agents/nobody/work`)).status, 404);
  } finally {
    await close();
  }
});

test('GET /api/console/agents/catalog lists what an agent can reach for', async () => {
  const { url, close } = await boot();
  try {
    const res = await fetch(`${url}/api/console/agents/catalog`);
    assert.equal(res.status, 200);
    const body = await res.json() as { skills: unknown[]; workflows: unknown[] };
    assert.ok(Array.isArray(body.skills));
    assert.ok(Array.isArray(body.workflows));
  } finally {
    await close();
  }
});

test('agent proposal endpoints create, list, approve into the one store, and reject', async () => {
  const { url, close } = await boot();
  try {
    const propose = async (name: string) => fetch(`${url}/api/console/agents/proposals`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        originatingRequest: `Create an ${name} agent that owns the weekly report.`,
        name, description: `${name} owner`, rationale: 'Recurring work.',
      }),
    });
    const created = await propose('Ops Analyst');
    assert.equal(created.status, 200);
    const proposal = ((await created.json()) as { proposal: { id: string } }).proposal;

    const pending = await fetch(`${url}/api/console/agents/proposals?status=pending`);
    const list = (await pending.json()) as { proposals: Array<{ id: string }> };
    assert.ok(list.proposals.some((p) => p.id === proposal.id));

    const approved = await fetch(`${url}/api/console/agents/proposals/${proposal.id}/approve`, { method: 'POST' });
    assert.equal(approved.status, 200);
    const approvedBody = (await approved.json()) as { agent: Agent | null };
    assert.equal(approvedBody.agent?.id, 'ops-analyst', 'an approved draft becomes a record in the one store');

    const second = await propose('Ops Reviewer');
    const secondId = ((await second.json()) as { proposal: { id: string } }).proposal.id;
    const rejected = await fetch(`${url}/api/console/agents/proposals/${secondId}/reject`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'not needed' }),
    });
    assert.equal(rejected.status, 200);
  } finally {
    await close();
  }
});

test('POST /api/console/sessions/:id/agent switches who answers next; auth gated; refusals are typed', async () => {
  const { createSession, getSession } = await import('../runtime/harness/eventlog.js');
  const session = createSession({ kind: 'chat', title: 'switch me' });
  const auth = { v: true };
  const { url, close } = await boot(auth);
  const post = (id: string, body: unknown) => fetch(`${url}/api/console/sessions/${encodeURIComponent(id)}/agent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const on = await post(`harness:${session.id}`, { agentId: 'researcher' });
    assert.equal(on.status, 200);
    assert.deepEqual(await on.json(), { sessionId: session.id, agentId: 'researcher', agentName: 'Researcher', changed: true });
    assert.equal(getSession(session.id)!.metadata.agentId, 'researcher');

    const off = await post(session.id, { agentId: null });
    assert.deepEqual(await off.json(), { sessionId: session.id, agentId: null, agentName: null, changed: true });

    assert.equal((await post(session.id, { agentId: 'clementine' })).status, 400, 'the host is not an agent to switch to');
    assert.equal((await post(session.id, {})).status, 400, 'the body must say which agent, or null');
    assert.equal((await post('sess-nope', { agentId: 'researcher' })).status, 404);

    auth.v = false;
    assert.equal((await post(session.id, { agentId: 'researcher' })).status, 401);
  } finally {
    await close();
  }
});

test('GET /api/console/answering-model names an agent\'s own model for the model chip; a pick in the conversation wins', async () => {
  const { createSession } = await import('../runtime/harness/eventlog.js');
  const { _setSessionAgentModelDepsForTests, recordBrainChosenForSession } = await import('../agents/session-agent-model.js');
  _setSessionAgentModelDepsForTests({ live: () => true });
  const auth = { v: true };
  const { url, close } = await boot(auth);
  const read = async (query: string) => (await fetch(`${url}/api/console/answering-model?${query}`)).json() as Promise<{ agent: { modelId: string; agentName: string } | null }>;
  try {
    const created = await fetch(`${url}/api/console/agents`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Chip Designer', handles: 'Design work.', model: 'claude-opus-5-5' }),
    });
    const agent = ((await created.json()) as { agent: Agent }).agent;
    // A new conversation about to open inside the agent.
    assert.deepEqual((await read(`agentId=${agent.id}`)).agent, { modelId: 'claude-opus-5-5', agentId: agent.id, agentName: 'Chip Designer' });
    assert.equal((await read('agentId=')).agent, null, 'Clem with no agent');

    const session = createSession({ kind: 'chat', title: 'chip' });
    await fetch(`${url}/api/console/sessions/${session.id}/agent`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: agent.id }),
    });
    assert.equal((await read(`sessionId=harness:${session.id}&agentId=${agent.id}`)).agent?.modelId, 'claude-opus-5-5');
    recordBrainChosenForSession(session.id, new Date(Date.now() + 1_000));
    assert.equal((await read(`sessionId=${session.id}&agentId=${agent.id}`)).agent, null, 'the owner\'s later pick answers');

    auth.v = false;
    assert.equal((await fetch(`${url}/api/console/answering-model?agentId=${agent.id}`)).status, 401);
  } finally {
    _setSessionAgentModelDepsForTests({});
    await close();
  }
});
