/**
 * Run: node scripts/run-tests-isolated.mjs src/projects/project-lead.test.ts
 *
 * A project may name one lead agent. Clem hands the project's whole jobs to
 * it; the lead plans them and runs its own workers; its workers work with the
 * project; and nothing goes deeper than Clem → lead → workers.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-project-lead-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const projects = await import('./project-record.js');
const { setSessionProject } = await import('./session-project.js');
const { bindProject, projectContextForWorker } = await import('./project-binding.js');
const { resolveTaskDelegation } = await import('./task-delegation.js');
const { createAgentRecord } = await import('../agents/agent-record.js');
const { createSession, closeEventLog } = await import('../runtime/harness/eventlog.js');
const depth = await import('../agents/delegation-depth.js');

after(() => {
  projects._closeProjectStoreForTests();
  closeEventLog();
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function project(name: string) {
  const made = projects.createProject({ name, purpose: 'Build fixture audits.' });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.project;
}
function agent(name: string) {
  const made = createAgentRecord({ name, handles: `${name} handles`, instructions: `${name} instructions`, createdFrom: 'console' });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.agent;
}

test('a project keeps one lead; naming another hands the role over; taking the lead off clears it', () => {
  const p = project('Lead Fixture One');
  const a = agent('Fixture Auditor'); const b = agent('Fixture Designer');
  assert.ok(projects.saveAssignment(p.id, { agentId: a.id, lead: true }).ok);
  assert.ok(projects.saveAssignment(p.id, { agentId: b.id }).ok);
  assert.equal(projects.projectLead(p.id)?.agentId, a.id);
  assert.equal(projects.getAssignment(p.id, b.id)?.lead, false);
  assert.ok(projects.saveAssignment(p.id, { agentId: b.id, lead: true }).ok);
  assert.equal(projects.projectLead(p.id)?.agentId, b.id);
  assert.equal(projects.getAssignment(p.id, a.id)?.lead, false, 'one lead per project');
  assert.ok(projects.saveAssignment(p.id, { agentId: b.id, responsibility: 'Design' }).ok);
  assert.equal(projects.projectLead(p.id)?.agentId, b.id, 'an unrelated edit keeps the lead');
  assert.ok(projects.removeAssignment(p.id, b.id));
  assert.equal(projects.projectLead(p.id), null);
});

test('a store from before leads upgrades on open: every assignment starts as not the lead, and one can then be named', () => {
  projects._closeProjectStoreForTests();
  const file = projects.projectStorePath();
  rmSync(file, { force: true }); rmSync(`${file}-wal`, { force: true }); rmSync(`${file}-shm`, { force: true });
  const v1 = new Database(file);
  v1.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '',
      goals_json TEXT NOT NULL DEFAULT '[]', context TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', revision INTEGER NOT NULL DEFAULT 1,
      created_from TEXT, origin_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT);
    CREATE TABLE project_ids_issued (id TEXT PRIMARY KEY, issued_at TEXT NOT NULL);
    CREATE TABLE project_agents (project_id TEXT NOT NULL, agent_id TEXT NOT NULL, agent_created_at TEXT, agent_name TEXT NOT NULL DEFAULT '',
      responsibility TEXT NOT NULL DEFAULT '', context TEXT NOT NULL DEFAULT '', skills_json TEXT NOT NULL DEFAULT '[]',
      share_methods INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'active', revision INTEGER NOT NULL DEFAULT 1,
      assigned_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (project_id, agent_id));
    CREATE TABLE project_resources (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
      toolkit TEXT, account_id TEXT, ref TEXT, verified_at TEXT, verification_json TEXT, state TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO projects (id, name, name_key, created_at, updated_at) VALUES ('prj_aaaaaaaaaaaaaa', 'Old Project', 'old project', 't', 't');
    INSERT INTO project_agents (project_id, agent_id, assigned_at, updated_at) VALUES ('prj_aaaaaaaaaaaaaa', 'old-agent', 't', 't');`);
  v1.pragma('user_version = 1'); v1.close();
  const rows = projects.listAssignments('prj_aaaaaaaaaaaaaa');
  assert.deepEqual(rows.map((row) => [row.agentId, row.lead]), [['old-agent', false]]);
  assert.equal(projects.projectLead('prj_aaaaaaaaaaaaaa'), null);
  assert.ok(projects.saveAssignment('prj_aaaaaaaaaaaaaa', { agentId: 'old-agent', lead: true }).ok);
  assert.equal(projects.projectLead('prj_aaaaaaaaaaaaaa')?.agentId, 'old-agent');
});

test('a job delegated in a project with a lead goes to the lead when nobody is named', async () => {
  const p = project('Lead Fixture Two');
  const lead = agent('Fixture Lead'); const other = agent('Fixture Helper');
  projects.saveAssignment(p.id, { agentId: other.id });
  projects.saveAssignment(p.id, { agentId: lead.id, lead: true });
  const chat = createSession({ id: 'lead-fixture-chat', kind: 'chat' });
  setSessionProject(chat.id, p.id, { by: 'owner' } as never);
  const resolved = await resolveTaskDelegation({ sessionId: chat.id, objective: 'Build the fixture audit', project: null, agent: null } as never,
    { selectAgent: async () => { throw new Error('the router is not asked when a lead exists'); } });
  assert.equal(resolved.kind, 'bound');
  if (resolved.kind !== 'bound') return;
  assert.equal(resolved.delegation.agentId, lead.id);
  assert.equal(resolved.delegation.assignedBy, 'owner');
});

test('Clem is told who leads; the lead is told to plan and run workers; a worker is told it does one item', () => {
  const p = project('Lead Fixture Three');
  const lead = agent('Fixture Planner');
  projects.saveAssignment(p.id, { agentId: lead.id, lead: true });
  const forClem = bindProject(p).context;
  assert.match(forClem, /Fixture Planner leads this project/);
  assert.match(forClem, /dispatch_background_task/);
  assert.match(forClem, /Do quick work yourself: answer, look something up, or make a small change to a file\./,
    'a quick edit is not a job: Clem does it rather than starting a worker');
  assert.doesNotMatch(forClem, /run_worker/);
  const forLead = bindProject(p, { agentId: lead.id }).context;
  assert.match(forLead, /You lead this project/);
  assert.match(forLead, /run_worker/);
  const forWorker = bindProject(p, { agentId: lead.id, role: 'worker' }).context;
  assert.match(forWorker, /one item of a job in this project/);
  assert.doesNotMatch(forWorker, /You lead this project|leads this project/);
  const leadRun = createSession({ id: 'background:lead-fixture', kind: 'execution', metadata: { delegatedTaskId: 'task-fixture', projectId: p.id, agentId: lead.id } } as never);
  const context = projectContextForWorker(leadRun.id, lead.id);
  assert.match(context, /## Project: Lead Fixture Three/);
  assert.match(context, /one item of a job/);
  assert.equal(projectContextForWorker(createSession({ id: 'no-project-chat', kind: 'chat' }).id, null), '');
});

test('nothing goes deeper than Clem → lead → workers', () => {
  const lead = createSession({ id: 'background:depth-fixture', kind: 'execution', metadata: { delegatedTaskId: 'task-depth' } } as never);
  assert.equal(depth.sessionIsDelegatedJob(lead.id), true, 'a lead run cannot hand its job on');
  assert.equal(depth.sessionIsDelegatedJob(createSession({ id: 'depth-chat', kind: 'chat' }).id), false, 'Clem can hand a job to a lead');
  assert.match(depth.LEAD_DOES_NOT_HAND_ON, /run_worker/);
  assert.match(depth.WORKER_STARTS_NOTHING, /does not start other workers/);
});

test('a job handed to an agent keeps the plan scope but leaves the split across workers to the agent', async () => {
  const { registerBackgroundTaskTools } = await import('../tools/background-task-tools.js');
  const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
  const { getBackgroundTask } = await import('../execution/background-tasks.js');
  type Handler = (input: Record<string, unknown>) => Promise<{ content?: Array<{ text?: string }> }>;
  const handlers = new Map<string, Handler>();
  registerBackgroundTaskTools({ tool(name: string, _d: string, _s: unknown, handler: Handler) { handlers.set(name, handler); } } as never);
  const dispatch = handlers.get('dispatch_background_task')!;
  const p = project('Lead Fixture Wrapper');
  const lead = agent('Wrapper Lead');
  projects.saveAssignment(p.id, { agentId: lead.id, lead: true });
  const chat = createSession({ id: 'lead-wrapper-chat', kind: 'chat' });
  setSessionProject(chat.id, p.id, { by: 'owner' } as never);
  const run = async (sessionId: string) => {
    const out = await withToolOutputContext({ sessionId }, () => dispatch({
      objective: 'Build the fixture audit.', handoff_note: 'Handing this over.', plan: '- Gather the data\n- Write the audit',
      success_criteria: [], context_refs: [], max_minutes: 15,
    }));
    const taskId = (out.content?.[0]?.text ?? '').match(/task (bg-[a-zA-Z0-9_-]+)/)?.[1];
    assert.ok(taskId, out.content?.[0]?.text);
    return getBackgroundTask(taskId!)!;
  };
  const handed = await run(chat.id);
  assert.equal(handed.delegation?.agentId, lead.id);
  assert.match(handed.prompt, /how you split the work across your workers is yours to decide/);
  assert.doesNotMatch(handed.prompt, /do NOT re-derive a different approach/);
  const plain = await run(createSession({ id: 'plain-wrapper-chat', kind: 'chat' }).id);
  assert.equal(plain.delegation, undefined);
  assert.match(plain.prompt, /do NOT re-derive a different approach/, 'an ordinary background job keeps the strict plan');
});
