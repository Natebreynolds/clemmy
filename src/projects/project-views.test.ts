import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { after, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clem-project-view-snapshot-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
fs.mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });

const projects = await import('./project-record.js');
const views = await import('./project-views.js');
const tasks = await import('../execution/background-tasks.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const agents = await import('../agents/agent-record.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const { exactOriginDeliveryTargetDigest } = await import('../runtime/exact-origin-delivery.js');
type Project = ReturnType<typeof projects.listProjects>[number];
type Task = ReturnType<typeof tasks.listBackgroundTasks>[number];
after(() => {
  projects._closeProjectStoreForTests();
  eventlog.closeEventLog();
  fs.rmSync(fixtureHome, { recursive: true, force: true });
});

function project(name: string): Project {
  const made = projects.createProject({ name, purpose: `Purpose of ${name}` });
  if (!made.ok) throw new Error('fixture project');
  return made.project;
}

function chat(id: string, metadata: unknown, at = '2034-01-01T00:00:00.000Z', raw = false): string {
  eventlog.createSession({ id, kind: 'chat', title: id });
  eventlog.openEventLog().prepare('UPDATE sessions SET metadata_json = ?, updated_at = ? WHERE id = ?')
    .run(raw ? metadata : JSON.stringify(metadata), at, id);
  return id;
}

function task(project: Project, title: string, patch: Partial<Task> = {}): Task {
  const made = tasks.createBackgroundTask({ title, prompt: title, source: 'desktop',
    delegation: { agentId: 'fixture-worker', agentName: title, agentCreatedAt: null,
      projectId: project.id, projectName: project.name, assignedBy: 'owner' } });
  const record = { ...made, ...patch };
  fs.writeFileSync(path.join(fixtureHome, 'state', 'background-tasks', `${made.id}.json`), JSON.stringify(record));
  return record;
}

// Captured pre-optimization SQL and JSON.parse view: intentionally retain its
// scalar membership, SQL failure, duplicate-key and historical-limit behavior.
function legacyConversations(projectId: string): import('./project-views.js').ProjectConversationView[] {
  try {
    const rows = eventlog.openEventLog().prepare(`
      SELECT id, title, updated_at AS updatedAt, metadata_json AS metadata
        FROM sessions WHERE kind = 'chat'
         AND (json_extract(metadata_json, '$.projectId') = ?
           OR EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(metadata_json, '$.projectIds'), '[]')) WHERE value = ?))
       ORDER BY updated_at DESC LIMIT ?
    `).all(projectId, projectId, 50) as Array<{ id: string; title: string | null; updatedAt: string; metadata: string }>;
    return rows.map((row) => {
      let metadata: any = {};
      try { metadata = JSON.parse(row.metadata ?? '{}'); } catch { /* legacy fallback */ }
      return { sessionId: row.id, title: row.title, updatedAt: row.updatedAt,
        agentName: typeof metadata.agentName === 'string' && metadata.agentId ? metadata.agentName : null,
        current: metadata.projectId === projectId };
    });
  } catch { return []; }
}

function observeList(t: TestContext) {
  const db = eventlog.openEventLog();
  const originalPrepare = db.prepare;
  const originalRead = fs.readFileSync;
  const originalReadDir = fs.readdirSync;
  const observed = { taskReads: 0, taskInventories: 0, approvalInventories: 0, batches: 0, legacyQueries: 0,
    batchRows: [] as Array<{ projectId: string; id: string; title: string | null; updatedAt: string; metadata: string; strictUnique: number }> };
  const taskDir = path.join(fixtureHome, 'state', 'background-tasks');
  t.mock.method(fs, 'readFileSync', (...args: any[]) => {
    if (String(args[0]).startsWith(`${taskDir}${path.sep}`)) observed.taskReads++;
    return Reflect.apply(originalRead, fs, args);
  });
  t.mock.method(fs, 'readdirSync', (...args: any[]) => {
    if (String(args[0]) === taskDir) observed.taskInventories++;
    return Reflect.apply(originalReadDir, fs, args);
  });
  syncBuiltinESMExports();
  t.mock.method(db, 'prepare', (sql: string) => {
    const statement = originalPrepare.call(db, sql);
    if (sql.includes('SELECT * FROM pending_approvals') && sql.includes('ORDER BY requested_at DESC')) observed.approvalInventories++;
    if (sql.includes('metadata_json AS metadata') && sql.includes("'$.projectIds'")) observed.legacyQueries++;
    if (sql.includes('chat_projection AS MATERIALIZED')) {
      observed.batches++;
      const originalAll = statement.all;
      t.mock.method(statement, 'all', (...args: any[]) => {
        const rows = Reflect.apply(originalAll, statement, args);
        observed.batchRows = rows as typeof observed.batchRows;
        return rows;
      });
    }
    return statement;
  });
  return { observed, restore: () => { t.mock.restoreAll(); syncBuiltinESMExports(); } };
}

function baselineSummaries() {
  return projects.listProjects({ includeArchived: true }).map((row) => views.projectSummary(row));
}

test('one fresh listing reuses tasks and public approvals and preserves batched legacy conversation projections', (t) => {
  const first = project('Snapshot first');
  const second = project('Snapshot second');
  const crowded = project('Snapshot historical limit');
  const archived = project('Snapshot archived');
  projects.archiveProject(archived.id);
  const madeAgent = agents.createAgentRecord({ name: 'Snapshot agent', handles: 'Fixture.' });
  if (!madeAgent.ok) throw new Error('fixture agent');
  projects.saveAssignment(first.id, { agentId: madeAgent.agent.id, agentName: madeAgent.agent.name, agentCreatedAt: madeAgent.agent.createdAt });
  projects.saveAssignment(second.id, { agentId: madeAgent.agent.id, agentName: 'Old agent', agentCreatedAt: '1900-01-01T00:00:00.000Z' });

  const question = task(first, 'Waiting question', { status: 'awaiting_input', pendingQuestionId: 'q-snapshot',
    pendingQuestion: 'Choose a fixture branch.', pendingQuestionOptions: ['A', 'B'] });
  task(first, 'Working', { status: 'running' });
  task(first, 'Finished', { status: 'done' });
  task(first, 'Internal', { status: 'running', internal: true });
  task(first, 'Archived task', { status: 'running', archived: true });
  task(second, 'Blocked still active', { status: 'blocked' });
  task(archived, 'Archived project work', { status: 'running' });
  const newestTask = task(second, 'New task owner', { createdAt: '2030-01-02T00:00:00.000Z' });
  const olderTask = task(second, 'Old task owner', { runSessionId: newestTask.runSessionId, createdAt: '2030-01-01T00:00:00.000Z' });
  const taskApproval = approvals.register({ sessionId: newestTask.runSessionId, subject: 'Task duplicate owner', tool: 'fixture_write', args: { task: 'one' } });
  assert.equal(views.decisionsForProject(second.id).find((row) => row.approvalId === taskApproval.approvalId)?.owner, olderTask.title);
  // A current chat then overwrites the same task session's owner exactly as before.
  eventlog.openEventLog().prepare('UPDATE sessions SET kind = ?, metadata_json = ?, updated_at = ? WHERE id = ?')
    .run('chat', JSON.stringify({ projectId: second.id, agentId: 'fixture', agentName: 'Conversation owner' }), '2034-01-01T00:00:00.000Z', newestTask.runSessionId);
  assert.equal(views.decisionsForProject(second.id).find((row) => row.approvalId === taskApproval.approvalId)?.owner, 'Conversation owner');

  const current = chat('snapshot-current', { projectId: first.id, projectIds: [second.id, second.id], agentId: [], agentName: 'Array owner', huge: 'x'.repeat(128_000) });
  approvals.register({ sessionId: current, subject: 'Current formal card', tool: 'fixture_write', args: { x: 1 } });
  for (const [id, metadata] of [
    ['snapshot-object-history', { projectId: second.id, projectIds: { old: first.id }, agentId: {}, agentName: 'Object owner' }],
    ['snapshot-encoded-history', { projectId: second.id, projectIds: JSON.stringify([first.id]), agentId: false, agentName: 'Hidden owner' }],
    ['snapshot-encoded-scalar', { projectId: second.id, projectIds: JSON.stringify(first.id), agentId: 0, agentName: 'Hidden zero' }],
    ['snapshot-number-history', { projectId: second.id, projectIds: 1, agentId: true, agentName: 'Boolean owner' }],
    ['snapshot-bool-history', { projectId: second.id, projectIds: true, agentId: 'fixture', agentName: 'Fixture owner' }],
    ['snapshot-tie-z', { projectId: second.id }], ['snapshot-tie-a', { projectId: second.id }],
    ['snapshot-scalar-root', 'root'], ['snapshot-null-root', null], ['snapshot-array-root', []],
  ] as const) chat(id, metadata);
  const consent = chat('snapshot-consent', { projectId: first.id });
  const replyTo = { type: 'discord_channel' as const, channelId: 'snapshot-fixture' };
  approvals.register({ sessionId: consent, subject: 'Fixture conversational consent', tool: 'fixture_send', args: { destination: 'fixture' },
    presentation: { version: 1, kind: 'autonomous_send_consent', question: 'Send the fixture?', actionLabel: 'message', target: 'fixture',
      subject: null, bodyPreview: null, resultUrl: null, sourceUserSeq: 1, originReplyTarget: replyTo,
      originReplyTargetDigest: exactOriginDeliveryTargetDigest(replyTo), conversationKey: 'snapshot-fixture', audienceUserId: 'fixture-owner' } });
  const groupedChat = chat('snapshot-group', { projectId: second.id });
  const members = [1, 2].map((part) => approvals.register({ sessionId: groupedChat, subject: `Member ${part}`, tool: 'fixture_write', args: { part }, resumeKey: `snapshot-${part}` }));
  const group = approvals.registerApprovalGroup(members, { operation: 'Fixture group', fields: [] });
  // Group folding happens before expiry: expired group must not reveal members.
  eventlog.openEventLog().prepare('UPDATE pending_approvals SET expires_at = ? WHERE approval_id = ?')
    .run('2000-01-01T00:00:00.000Z', group.approvalId);
  const expiredChat = chat('snapshot-expired', { projectId: first.id });
  const expired = approvals.register({ sessionId: expiredChat, subject: 'Expired', tool: 'fixture_write', args: { expired: true } });
  eventlog.openEventLog().prepare('UPDATE pending_approvals SET expires_at = ? WHERE approval_id = ?').run('2000-01-01T00:00:00.000Z', expired.approvalId);
  const excluded = chat('snapshot-crowded-current-old', { projectId: crowded.id }, '2029-01-01T00:00:00.000Z');
  approvals.register({ sessionId: excluded, subject: 'Beyond historical cap', tool: 'fixture_write', args: { beyond: true } });
  for (let index = 0; index < 51; index++) chat(`snapshot-historical-${index}`, { projectId: second.id, projectIds: [crowded.id] }, '2031-01-01T00:00:00.000Z');
  assert.equal(legacyConversations(crowded.id).some((row) => row.current), false);

  const expected = baselineSummaries();
  const reference = new Map(projects.listProjects().map((row) => [row.id, legacyConversations(row.id)]));
  const fileCount = fs.readdirSync(path.join(fixtureHome, 'state', 'background-tasks')).filter((file) => file.endsWith('.json')).length;
  const watch = observeList(t);
  let actual;
  try { actual = views.projectSummaries({ includeArchived: true }); }
  finally { watch.restore(); }
  assert.deepEqual(actual, expected);
  assert.equal(watch.observed.taskInventories, 1);
  assert.equal(watch.observed.taskReads, fileCount);
  assert.equal(watch.observed.approvalInventories, 1);
  assert.equal(watch.observed.batches, 1);
  assert.equal(watch.observed.legacyQueries, 0);
  for (const [projectId, conversations] of reference) {
    const actualConversations = watch.observed.batchRows.filter((row) => row.projectId === projectId).map((row) => {
      const [currentProjectId, , agentId, agentName] = JSON.parse(row.metadata);
      assert.ok(row.metadata.length < 1_000, 'large unrelated metadata never crosses the batch projection');
      return { sessionId: row.id, title: row.title, updatedAt: row.updatedAt,
        agentName: typeof agentName === 'string' && agentId ? agentName : null, current: currentProjectId === projectId };
    });
    assert.deepEqual(actualConversations, conversations);
  }
  assert.equal(actual!.find((row) => row.id === first.id)?.activeTasks, 2);
  assert.equal(actual!.find((row) => row.id === first.id)?.needsYou, 3);
  assert.equal(actual!.find((row) => row.id === second.id)?.needsYou, 1, 'the expired group hides its members before expiry filtering');
  assert.equal(actual!.find((row) => row.id === crowded.id)?.needsYou, 0);
  assert.deepEqual(actual!.find((row) => row.id === second.id)?.agents, []);
  assert.equal(actual!.find((row) => row.id === archived.id)?.needsYou, 0);
  // A new request observes changed task, approval and membership receipts.
  fs.writeFileSync(path.join(fixtureHome, 'state', 'background-tasks', `${question.id}.json`), JSON.stringify({ ...question, status: 'done' }));
  approvals.resolve(taskApproval.approvalId, 'rejected', 'fixture');
  eventlog.openEventLog().prepare('UPDATE sessions SET metadata_json = ? WHERE id = ?').run('{}', current);
  const next = views.projectSummaries({ includeArchived: true });
  assert.deepEqual(next, baselineSummaries());
  assert.equal(next.find((row) => row.id === first.id)?.activeTasks, 1);
  assert.equal(next.find((row) => row.id === first.id)?.needsYou, 1);
});

test('the existing decision cap counts fifty while task counts keep the complete inventory', () => {
  const capped = project('Snapshot decision cap');
  for (let index = 0; index < 52; index++) task(capped, `Cap question ${index}`, {
    status: 'awaiting_input', pendingQuestionId: `q-cap-${index}`, pendingQuestion: `Fixture question ${index}?`,
  });
  const actual = views.projectSummaries().find((row) => row.id === capped.id);
  assert.deepEqual(actual, views.projectSummary(capped));
  assert.equal(actual?.activeTasks, 52);
  assert.equal(actual?.needsYou, 50);
});

test('duplicate, JSON5 and malformed metadata retain legacy per-project fallback and short-circuit behavior', async (t) => {
  const first = project('Snapshot unusual first');
  const second = project('Snapshot unusual second');
  const cases = [
    ['duplicate-current', `{"projectId":${JSON.stringify(first.id)},"projectId":${JSON.stringify(second.id)}}`],
    ['duplicate-owner', `{"projectId":${JSON.stringify(first.id)},"agentId":"a","agentName":"first","agentName":"last"}`],
    ['duplicate-agent', `{"projectId":${JSON.stringify(first.id)},"agentId":false,"agentId":[],"agentName":"last"}`],
    ['duplicate-history', `{"projectIds":[${JSON.stringify(first.id)}],"projectIds":[${JSON.stringify(second.id)}]}`],
    ['json5', `{projectId:${JSON.stringify(first.id)},agentId:'a',agentName:'JSON5'}`],
    ['plain-history', JSON.stringify({ projectId: first.id, projectIds: second.id })],
    ['malformed', '{not JSON'],
  ];
  for (const [name, raw] of cases) await t.test(name!, (caseTest) => {
    const sessionId = chat(`snapshot-${name}`, raw, '2032-01-01T00:00:00.000Z', true);
    const card = approvals.register({ sessionId, subject: name!, tool: 'fixture_write', args: { name } });
    try {
      const expected = baselineSummaries();
      if (name === 'plain-history') {
        assert.equal(legacyConversations(first.id).some((row) => row.sessionId === sessionId && row.current), true);
        assert.deepEqual(legacyConversations(second.id), [], 'only some projects fail the scalar history parse');
      }
      const watch = observeList(caseTest);
      let actual;
      try { actual = views.projectSummaries({ includeArchived: true }); }
      finally { watch.restore(); }
      assert.deepEqual(actual, expected);
      assert.equal(watch.observed.batches, 1);
      assert.equal(watch.observed.legacyQueries, projects.listProjects().length);
      assert.equal(watch.observed.taskInventories, 1);
      assert.equal(watch.observed.approvalInventories, 1);
    } finally {
      approvals.resolve(card.approvalId, 'rejected', 'fixture');
      eventlog.openEventLog().prepare('UPDATE sessions SET metadata_json = ? WHERE id = ?').run('{}', sessionId);
    }
  });
});
