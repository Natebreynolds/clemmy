/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/project-record-tools.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-project-tools-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const { registerProjectRecordTools } = await import('./project-record-tools.js');
const projects = await import('../projects/project-record.js');
const accounts = await import('../projects/connected-accounts.js');
const { createAgentRecord, findAgentRecord } = await import('../agents/agent-record.js');
const { createSession, getSession, closeEventLog } = await import('../runtime/harness/eventlog.js');
const { toolOutputContextStorage } = await import('../runtime/harness/tool-output-context.js');

after(() => {
  accounts._setConnectedAccountDirectoryForTests(null);
  projects._closeProjectStoreForTests();
  closeEventLog();
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
const handlers = new Map<string, Handler>();
registerProjectRecordTools({ tool: (name: string, _description: string, _schema: unknown, handler: Handler) => { handlers.set(name, handler); } } as never);

async function call(name: string, args: Record<string, unknown>, sessionId?: string): Promise<any> {
  const run = () => handlers.get(name)!(args);
  const result = sessionId ? await toolOutputContextStorage.run({ sessionId } as never, run) : await run();
  const text = result.content[0]!.text;
  try { return JSON.parse(text); } catch { return text; }
}

const east = { toolkit: 'ledgerscope', accountId: 'conn-east', label: 'East ledger', names: ['east@harborline.example'] };
const west = { toolkit: 'ledgerscope', accountId: 'conn-west', label: 'West ledger', names: ['west@harborline.example'] };
const mail = { toolkit: 'mailscope', accountId: 'conn-mail', label: 'Work mail', names: ['owner@harborline.example'] };
accounts._setConnectedAccountDirectoryForTests(async (toolkit) => [east, west, mail].filter((row) => row.toolkit === toolkit));

const made = createAgentRecord({ name: 'Sales Assistant', handles: 'Sales reporting.', instructions: 'Figures first.', createdFrom: 'console' });
if (!made.ok) throw new Error('fixture agent');

test('one call creates the project, assigns the agent, binds the one account that is unambiguous, and asks about the other', async () => {
  const chat = createSession({ id: 'organising-chat', kind: 'chat' });
  const saved = await call('project_save', {
    project: null, name: 'Weekly Sales', purpose: 'Prepare the weekly sales briefing.', goals: ['A draft every Monday'],
    context: 'A "lead" is an open opportunity.',
    agents: [{ agent: 'sales assistant', responsibility: 'Prepare the briefing.', skills: ['not-an-installed-skill'] },
      { agent: 'Nobody Saved', responsibility: 'x' }],
    accounts: [{ toolkit: 'mailscope', account: null }, { toolkit: 'ledgerscope', account: null }, { toolkit: 'unconnected', account: null }],
    resources: [{ kind: 'space', ref: 'weekly-sales-board', label: 'Board' }],
  }, chat.id);
  assert.equal(saved.ok, true);
  assert.equal(saved.created, true);
  assert.match(saved.id, /^prj_/);
  assert.deepEqual(saved.agents, [{ agent: 'Sales Assistant', responsibility: 'Prepare the briefing.', sharesMethodsAcrossProjects: false }]);
  assert.deepEqual(saved.resources, [
    { kind: 'account', toolkit: 'mailscope', account: 'Work mail', accountId: 'conn-mail', verified: true },
    { kind: 'space', ref: 'weekly-sales-board', label: 'Board' },
  ]);
  assert.deepEqual(saved.askTheOwner, [{ about: 'which_account', toolkit: 'ledgerscope', choices: ['East ledger', 'West ledger'] }]);
  assert.match(saved.next, /ONE message/);
  assert.ok(saved.notes.includes('"Nobody Saved" is not a saved agent, so it was not assigned.'));
  assert.ok(saved.notes.includes('Not installed, so not pinned for Sales Assistant: not-an-installed-skill.'));
  assert.ok(saved.notes.includes('No account is connected for unconnected, so none was bound.'));
  assert.ok(saved.notes.includes('This conversation works in the project from its next turn.'));
  assert.equal(getSession(chat.id)?.metadata?.projectId, saved.id);
  assert.equal(getSession(chat.id)?.metadata?.projectSetBy, 'clem');

  // The owner answered: that account, by the name they used.
  const answered = await call('project_save', { project: 'Weekly Sales', name: null,
    accounts: [{ toolkit: 'ledgerscope', account: 'east@harborline.example' }] }, chat.id);
  assert.equal(answered.askTheOwner, undefined);
  assert.ok(answered.resources.some((row: any) => row.accountId === 'conn-east' && row.verified === true));

  // A different account for the same app is never swapped in silently.
  const rival = await call('project_save', { project: saved.id, name: null, accounts: [{ toolkit: 'ledgerscope', account: 'West ledger' }] }, chat.id);
  assert.deepEqual(rival.askTheOwner, [{ about: 'replace_account', toolkit: 'ledgerscope', bound: 'East ledger', asked: 'West ledger' }]);
  assert.ok(rival.resources.some((row: any) => row.accountId === 'conn-east'));
  const replaced = await call('project_save', { project: saved.id, name: null, accounts: [{ toolkit: 'ledgerscope', account: 'West ledger', replace: true }] }, chat.id);
  assert.deepEqual(replaced.resources.filter((row: any) => row.toolkit === 'ledgerscope').map((row: any) => row.accountId), ['conn-west']);

  // A name that identifies no connected account is a question, not a guess.
  const vague = await call('project_save', { project: saved.id, name: null, accounts: [{ toolkit: 'ledgerscope', account: 'the main one', replace: true }] }, chat.id);
  assert.deepEqual(vague.askTheOwner, [{ about: 'which_account', toolkit: 'ledgerscope', named: 'the main one',
    problem: 'that does not identify exactly one connected account', choices: ['East ledger', 'West ledger'] }]);
});

test('the same agent joins a second project with its own context, and a new agent is made only when asked', async () => {
  const second = await call('project_save', { project: null, name: 'Hiring Round',
    agents: [{ agent: 'Sales Assistant', responsibility: 'Summarise applicants.', context: 'A "lead" is the hiring manager.' },
      { agent: 'Notes Desk', create_if_missing: { handles: 'Keeps the meeting notes.', instructions: 'Short and dated.' } }] });
  assert.equal(second.ok, true);
  assert.ok(second.notes.includes('Sales Assistant is also assigned to 1 other project; their context stays separate.'));
  assert.ok(second.notes.includes('Created the agent Notes Desk.'));
  assert.equal(findAgentRecord('Notes Desk')?.handles, 'Keeps the meeting notes.');
  const sales = await call('project_get', { project: 'weekly sales' });
  const hiring = await call('project_get', { project: 'Hiring Round' });
  assert.equal(sales.agents[0].responsibility, 'Prepare the briefing.');
  assert.equal(hiring.agents.find((row: any) => row.agent === 'Sales Assistant').context, 'A "lead" is the hiring manager.');
  assert.doesNotMatch(JSON.stringify(sales), /hiring manager|Hiring Round/);

  const removed = await call('project_save', { project: 'Hiring Round', name: null, agents: [{ agent: 'Notes Desk', remove: true }] });
  assert.deepEqual(removed.agents.map((row: any) => row.agent), ['Sales Assistant']);
  const list = await call('project_list', {});
  assert.deepEqual(list.map((row: any) => [row.project, row.agents]).sort(), [['Hiring Round', ['Sales Assistant']], ['Weekly Sales', ['Sales Assistant']]]);
});

test('what cannot be found or made changes nothing and says what can be', async () => {
  const before = projects.listProjects().length;
  const missing = await call('project_save', { project: 'No Such Project', name: 'x', purpose: 'y' });
  assert.deepEqual([missing.ok, missing.code], [false, 'project_not_found']);
  assert.deepEqual(missing.projects.sort(), ['Hiring Round', 'Weekly Sales']);
  const unnamed = await call('project_save', { project: null, name: '  ' });
  assert.deepEqual([unnamed.ok, unnamed.code], [false, 'name_required']);
  const taken = await call('project_save', { project: null, name: 'weekly sales' });
  assert.deepEqual([taken.ok, taken.code], [false, 'name_taken']);
  assert.equal(projects.listProjects().length, before);
  const unknown = await call('project_get', { project: 'No Such Project' });
  assert.equal(unknown.code, 'project_not_found');
});
