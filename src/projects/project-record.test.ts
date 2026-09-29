/**
 * Run: node scripts/run-tests-isolated.mjs src/projects/project-record.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-project-record-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const projects = await import('./project-record.js');

after(() => {
  projects._closeProjectStoreForTests();
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function created(name: string, extra: Partial<Parameters<typeof projects.createProject>[0]> = {}) {
  const result = projects.createProject({ name, ...extra });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('unreachable');
  return result.project;
}

test('a project gets a minted id that says nothing about its name and is found by either', () => {
  const project = created('  Harbor   Ledger  ', { purpose: 'Keep the weekly ledger.', goals: ['Close by Friday', 'Close by Friday', ''],
    context: 'A "lead" here means a berth enquiry.', createdFrom: 'chat', originSessionId: 'sess-fixture-1' });
  assert.match(project.id, /^prj_[a-z0-9]{14}$/);
  assert.doesNotMatch(project.id, /harbor|ledger/);
  assert.equal(project.name, 'Harbor Ledger');
  assert.deepEqual(project.goals, ['Close by Friday']);
  assert.equal(project.revision, 1);
  assert.equal(project.status, 'active');
  assert.equal(projects.findProject('harbor  LEDGER')?.id, project.id);
  assert.equal(projects.findProject(project.id)?.id, project.id);
  assert.equal(projects.getProject('harbor ledger'), null, 'a name is not an id');
  assert.equal(projects.findProject(''), null);
  assert.deepEqual(projects.createProject({ name: 'harbor ledger' }), { ok: false, reason: 'name_taken' });
  assert.deepEqual(projects.createProject({ name: '   ' }), { ok: false, reason: 'name_required' });
});

test('renaming and archiving keep the id; an archived name is free and its project is never adopted', () => {
  const first = created('Pier Works');
  const renamed = projects.updateProject(first.id, { name: 'Pier Works 2026', purpose: 'Repairs.' });
  assert.equal(renamed.ok && renamed.project.id, first.id);
  assert.equal(renamed.ok && renamed.project.revision, 2);
  assert.equal(projects.findProject('Pier Works'), null);
  const same = projects.updateProject(first.id, { purpose: 'Repairs.' });
  assert.equal(same.ok && same.project.revision, 2, 'a save that changes nothing is not a revision');

  const archived = projects.archiveProject(first.id);
  assert.equal(archived.ok && archived.project.status, 'archived');
  assert.deepEqual(projects.updateProject(first.id, { purpose: 'x' }), { ok: false, reason: 'archived' });
  assert.equal(projects.findProject('Pier Works 2026'), null, 'an archived project does not answer to its name');
  assert.equal(projects.getProject(first.id)?.id, first.id, 'it is still there by id');

  const second = created('Pier Works 2026');
  assert.notEqual(second.id, first.id, 'the same name later is a different project');
  assert.deepEqual(projects.restoreProject(first.id), { ok: false, reason: 'name_taken' });
  assert.deepEqual(projects.listProjects().map((row) => row.id).includes(first.id), false);
  assert.equal(projects.listProjects({ includeArchived: true }).some((row) => row.id === first.id), true);
});

test('one agent is assigned to several projects, each with its own responsibility and context', () => {
  const sales = created('Weekly Sales');
  const hiring = created('Hiring');
  const agent = { agentId: 'sales-assistant', agentCreatedAt: '2026-09-01T00:00:00.000Z' };
  const inSales = projects.saveAssignment(sales.id, { ...agent, responsibility: 'Prepare the weekly briefing.',
    context: 'A "lead" is an open opportunity.', skills: ['reporting'] });
  const inHiring = projects.saveAssignment(hiring.id, { ...agent, responsibility: 'Summarise applicants.',
    context: 'A "lead" is the hiring manager.' });
  assert.equal(inSales.ok && inSales.created, true);
  assert.equal(inHiring.ok && inHiring.created, true);
  assert.deepEqual(projects.listAssignmentsForAgent('sales-assistant').map((row) => row.projectId).sort(), [sales.id, hiring.id].sort());
  assert.equal(projects.getAssignment(sales.id, 'sales-assistant')?.context, 'A "lead" is an open opportunity.');
  assert.equal(projects.getAssignment(hiring.id, 'sales-assistant')?.context, 'A "lead" is the hiring manager.');
  assert.equal(projects.getAssignment(sales.id, 'sales-assistant')?.shareMethods, false, 'what is learned in a project stays in it unless the owner says otherwise');

  const changed = projects.saveAssignment(sales.id, { agentId: 'sales-assistant', responsibility: 'Prepare the weekly briefing and the forecast.' });
  assert.equal(changed.ok && changed.created, false);
  assert.equal(changed.ok && changed.assignment.revision, 2);
  assert.equal(changed.ok && changed.assignment.context, 'A "lead" is an open opportunity.', 'a field the save did not name is kept');
  const unchanged = projects.saveAssignment(sales.id, { agentId: 'sales-assistant' });
  assert.equal(unchanged.ok && unchanged.assignment.revision, 2);

  assert.equal(projects.removeAssignment(hiring.id, 'sales-assistant'), true);
  assert.equal(projects.removeAssignment(hiring.id, 'sales-assistant'), false);
  assert.deepEqual(projects.listAssignmentsForAgent('sales-assistant').map((row) => row.projectId), [sales.id]);
  assert.deepEqual(projects.saveAssignment('prj_aaaaaaaaaaaaaa', { agentId: 'x' }), { ok: false, reason: 'project_not_found' });
  assert.deepEqual(projects.saveAssignment(sales.id, { agentId: '  ' }), { ok: false, reason: 'agent_required' });
});

test('a different agent saved later under the same id does not inherit the assignment', () => {
  const project = created('Tide Tables');
  projects.saveAssignment(project.id, { agentId: 'researcher', agentCreatedAt: '2026-08-01T00:00:00.000Z',
    responsibility: 'Collect tide data.', context: 'Private to the first researcher.' });
  const later = projects.saveAssignment(project.id, { agentId: 'researcher', agentCreatedAt: '2026-09-20T00:00:00.000Z' });
  assert.equal(later.ok && later.created, true);
  assert.equal(later.ok && later.assignment.responsibility, '');
  assert.equal(later.ok && later.assignment.context, '');
});

test('a project holds one account per toolkit and refuses to let a second replace it silently', () => {
  const project = created('Accounts Fixture');
  const first = projects.saveResource(project.id, { kind: 'account', toolkit: 'ledgerscope', accountId: 'acct-east',
    label: 'East ledger', verifiedAt: '2026-09-29T00:00:00.000Z', verification: { connection: 'active' } });
  assert.equal(first.ok && first.created, true);
  assert.equal(projects.getProject(project.id)?.revision, 2, 'what a project is bound to is part of its context');
  assert.equal(projects.projectAccountFor(project.id, 'LEDGERSCOPE')?.accountId, 'acct-east');

  const rival = projects.saveResource(project.id, { kind: 'account', toolkit: 'ledgerscope', accountId: 'acct-west' });
  assert.equal(rival.ok, false);
  assert.equal(!rival.ok && rival.reason, 'conflicting_account');
  assert.equal(!rival.ok && rival.conflict?.accountId, 'acct-east');
  assert.equal(projects.projectAccountFor(project.id, 'ledgerscope')?.accountId, 'acct-east');

  const replaced = projects.saveResource(project.id, { kind: 'account', toolkit: 'ledgerscope', accountId: 'acct-west' }, { replace: true });
  assert.equal(replaced.ok && replaced.created, true);
  assert.deepEqual(projects.listResources(project.id).map((row) => row.accountId), ['acct-west']);
  assert.equal(projects.projectAccountFor(project.id, 'ledgerscope'), null, 'an account nobody verified is never used to pick one');

  assert.deepEqual(projects.saveResource(project.id, { kind: 'account', toolkit: 'ledgerscope' }), { ok: false, reason: 'resource_incomplete' });
  const space = projects.saveResource(project.id, { kind: 'space', ref: 'weekly-sales-board', label: 'Board' });
  assert.equal(space.ok && space.created, true);
  const again = projects.saveResource(project.id, { kind: 'space', ref: 'weekly-sales-board' });
  assert.equal(again.ok && again.created, false);
  assert.equal(again.ok && again.resource.label, 'Board', 'an empty label does not erase one');
  assert.equal(space.ok && projects.removeResource(project.id, space.resource.id), true);
  assert.deepEqual(projects.listResources(project.id).map((row) => row.kind), ['account']);
});

test('another project cannot see or change what belongs to this one', () => {
  const mine = created('Mine');
  const theirs = created('Theirs');
  const resource = projects.saveResource(mine.id, { kind: 'link', ref: 'https://example.invalid/mine' });
  assert.equal(resource.ok && projects.removeResource(theirs.id, resource.resource.id), false);
  assert.deepEqual(projects.listResources(theirs.id), []);
  assert.deepEqual(projects.listAssignments(theirs.id), []);
});
