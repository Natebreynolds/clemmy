/** Original composition survives selection changes and process state loss. No network. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-source-composition-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.CLEMMY_EMBED_AT_WRITE = 'off';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
const log = await import('./eventlog.js');
const contexts = await import('./source-session-context.js');
const binding = await import('./source-session-context-scope.js');
const memory = await import('../../memory/memory-scope.js');
const memoryBinding = await import('./memory-scope-binding.js');
const composition = await import('./session-composition.js');
const agents = await import('../../agents/agent-record.js');
const projects = await import('../../projects/project-record.js');
const { setSessionAgent } = await import('../../agents/session-agent.js');
const { setSessionProject } = await import('../../projects/session-project.js');
const { defaultFactWriteScope } = await import('../../memory/facts.js');
const { closeMemoryDb } = await import('../../memory/db.js');
after(() => {
  closeMemoryDb(); log.closeEventLog(); projects._closeProjectStoreForTests();
  rmSync(fixtureHome, { force: true, recursive: true });
});
function captureFresh(input: { sessionId: string; sourceUserSeq: number }) {
  const context = contexts.captureFreshSourceSessionContext(input);
  assert.ok(context);
  return context;
}
let serial = 0;
function fixture(attached = true, text = 'Inspect the controlled task.') {
  const id = ++serial;
  const made = agents.createAgentRecord({ name: `Context Specialist ${id}`, instructions: `ORIGINAL_CRAFT_${id}`, createdFrom: 'console' });
  assert.ok(made.ok); if (!made.ok) throw new Error('fixture agent');
  const project = projects.createProject({ name: `Context Project ${id}`, context: `ORIGINAL_PROJECT_${id}` });
  assert.ok(project.ok); if (!project.ok) throw new Error('fixture project');
  const session = log.createSession({ id: `source-composition-${id}`, kind: 'chat' });
  if (attached) {
    assert.ok(setSessionAgent(session.id, made.agent.id, { by: 'owner' }).ok);
    assert.ok(setSessionProject(session.id, project.project.id, { by: 'owner' }).ok);
  }
  const source = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  return { id, agent: made.agent, project: project.project, sessionId: session.id, sourceUserSeq: source.seq };
}

test('reopen keeps original agent, project, memory reads, learning and reviewer after selection changes', async () => {
  const task = fixture();
  const original = captureFresh(task);
  const other = fixture();
  assert.ok(setSessionAgent(task.sessionId, other.agent.id, { by: 'owner' }).ok);
  assert.ok(setSessionProject(task.sessionId, other.project.id, { by: 'owner' }).ok);
  memoryBinding._forgetPinnedMemoryScopesForTests(); memoryBinding.forgetSessionMemoryScope();
  log.closeEventLog();
  const reopened = contexts.readSourceSessionContext(task, original.digest);
  assert.ok(reopened);
  await binding.withSourceSessionContext(reopened, async () => {
    await Promise.resolve();
    const mount = composition.composeSessionFromStore(task.sessionId);
    assert.equal(mount.agent?.agent.id, task.agent.id);
    assert.equal(mount.project?.project.id, task.project.id);
    const scope = { projectId: task.project.id, agentKey: memory.agentScopeKey(task.agent) };
    assert.deepEqual(memory.scopeOfSession(task.sessionId), scope);
    assert.deepEqual(defaultFactWriteScope('project', task.sessionId), scope);
    assert.deepEqual(defaultFactWriteScope('constraint', task.sessionId), memory.EVERYWHERE);
    assert.equal(composition.sessionAgentFields(task.sessionId).agentId, task.agent.id);
    assert.equal(composition.sessionProjectFields(task.sessionId).projectId, task.project.id);
    const review = composition.sessionAgentReviewContext(task.sessionId);
    assert.match(review, new RegExp(`ORIGINAL_CRAFT_${task.id}`));
    assert.match(review, new RegExp(`ORIGINAL_PROJECT_${task.id}`));
    assert.doesNotMatch(review, new RegExp(`ORIGINAL_CRAFT_${other.id}|ORIGINAL_PROJECT_${other.id}`));
  });
  assert.equal(composition.composeSessionFromStore(task.sessionId).agent?.agent.id, other.agent.id);
  assert.equal(memory.scopeOfSession(task.sessionId)?.projectId, other.project.id, 'UI selection was not rewritten');
  const stored = log.openEventLog().prepare('SELECT identity_json FROM source_session_contexts_v1 WHERE session_id = ?')
    .get(task.sessionId) as { identity_json: string };
  assert.doesNotMatch(stored.identity_json, /ORIGINAL_CRAFT|ORIGINAL_PROJECT|Inspect the controlled task/);
  assert.ok(stored.identity_json.length < 2000, 'identity is references/digests, not a copied prompt');
});

for (const kind of ['user', 'constraint'] as const) {
  test(`registered ${kind} memory stays in the accepted scope after selection changes and reopen`, async () => {
    const { registerMemoryTools } = await import('../../tools/memory-tools.js');
    const { z } = await import('zod');
    const facts = await import('../../memory/facts.js');
    const { openMemoryDb } = await import('../../memory/db.js');
    const { harnessRunContextStorage, ToolCallsCounter } = await import('./brackets.js');
    let remember: ((input: Record<string, unknown>) => Promise<unknown>) | undefined;
    registerMemoryTools({ tool(name: string, _description: string,
      shape: import('zod').ZodRawShape, handler: (input: unknown) => Promise<unknown>) {
      if (name === 'memory_remember') remember = input => handler(z.object(shape).parse(input));
    } } as never);
    assert.ok(remember);
    const task = fixture(true, `Remember this recurring ${kind} convention only in this project.`);
    const original = captureFresh(task);
    const other = fixture();
    const content = `Retained scope fixture ${task.id}: keep the recurring report marker COPPER MEADOW.`;
    // A fact with the exact same text in another scope is not a duplicate.
    // Seeding the intended scope also avoids asking a semantic resolver.
    const prior = facts.rememberFact({ kind, content, sessionId: task.sessionId, scope: original.memoryScope });
    setSessionAgent(task.sessionId, other.agent.id, { by: 'owner' });
    setSessionProject(task.sessionId, other.project.id, { by: 'owner' });
    memoryBinding._forgetPinnedMemoryScopesForTests(); memoryBinding.forgetSessionMemoryScope();
    closeMemoryDb(); log.closeEventLog();
    const fetchBefore = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (async () => { networkCalls += 1; throw new Error('memory scope fixture forbids network'); }) as typeof fetch;
    try {
      const save = async (identity: { sessionId: string; sourceUserSeq: number }) =>
        contexts.withAcceptedSourceSessionContext(identity, execution => harnessRunContextStorage.run({
          ...execution, counter: new ToolCallsCounter(4),
        }, () => remember!({ kind, content, keepFor: 'here' })));
      const result = await save(task);
      assert.match(JSON.stringify(result), /Reinforced|Already known|Remembered/);
      const rows = () => openMemoryDb().prepare('SELECT id, active FROM consolidated_facts WHERE content = ? ORDER BY id')
        .all(content) as Array<{ id: number; active: number }>;
      assert.deepEqual(rows(), [{ id: prior.id, active: 1 }], 'reopen must not save an everywhere or newly selected copy');
      assert.deepEqual(memory.memoryScopeOf('fact', prior.id), original.memoryScope);
      assert.equal(memory.scopeOfSession(task.sessionId)?.projectId, other.project.id, 'the UI selection remains moved');

      const next = log.appendEvent({ sessionId: task.sessionId, turn: 2, role: 'user', type: 'user_input_received',
        data: { text: 'Remember the same report marker only in this newly selected project.' } });
      const nextIdentity = { sessionId: task.sessionId, sourceUserSeq: next.seq };
      const nextContext = captureFresh(nextIdentity);
      assert.equal(nextContext.memoryScope.projectId, other.project.id);
      await save(nextIdentity);
      const after = rows();
      assert.equal(after.length, 2, 'a fresh accepted source uses its own selected scope');
      assert.ok(after.every(row => row.active === 1));
      const added = after.find(row => row.id !== prior.id)!;
      assert.deepEqual(memory.memoryScopeOf('fact', added.id), nextContext.memoryScope);
      assert.deepEqual(memory.memoryScopeOf('fact', prior.id), original.memoryScope);
      assert.equal(networkCalls, 0);
    } finally { globalThis.fetch = fetchBefore; }
  });
}

test('explicit absence survives later agent/project selection; new requests use the new selection', () => {
  const task = fixture(false);
  const original = captureFresh(task);
  setSessionAgent(task.sessionId, task.agent.id, { by: 'owner' });
  setSessionProject(task.sessionId, task.project.id, { by: 'owner' });
  const source = log.appendEvent({ sessionId: task.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Start a different task.' } });
  const next = captureFresh({ sessionId: task.sessionId, sourceUserSeq: source.seq });
  assert.equal(next.mount.agent?.agent.id, task.agent.id);
  binding.withSourceSessionContext(contexts.readSourceSessionContext(task, original.digest)!, () => {
    assert.equal(composition.composeSessionFromStore(task.sessionId).agent, null);
    assert.equal(composition.composeSessionFromStore(task.sessionId).project, null);
    assert.deepEqual(memory.scopeOfSession(task.sessionId), memory.EVERYWHERE);
    assert.equal(composition.sessionAgentReviewContext(task.sessionId), '');
    assert.throws(() => binding.withSourceSessionContext(next, () => {}), /Nested task composition/);
  });
});

test('concurrent requests do not share ambient composition across awaits', async () => {
  const tasks = [fixture(), fixture()];
  await Promise.all(tasks.map(task => binding.withSourceSessionContext(captureFresh(task), async () => {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(composition.sessionAgentFields(task.sessionId).agentId, task.agent.id);
    assert.equal(memory.scopeOfSession(task.sessionId)?.projectId, task.project.id);
    assert.equal(binding.currentSourceSessionContext(tasks.find(x => x !== task)!.sessionId), undefined);
  })));
});

for (const changed of ['deleted-agent', 'agent-instructions', 'archived-project', 'project-context', 'assignment'] as const) {
  test(`reopen refuses ${changed} drift instead of switching identities`, () => {
    const task = fixture();
    const captured = captureFresh(task);
    if (changed === 'deleted-agent') agents.deleteAgentRecord(task.agent.id);
    if (changed === 'agent-instructions') agents.updateAgentRecord(task.agent.id, { instructions: 'CHANGED_CRAFT' });
    if (changed === 'archived-project') projects.archiveProject(task.project.id);
    if (changed === 'project-context') projects.updateProject(task.project.id, { context: 'CHANGED_PROJECT' });
    if (changed === 'assignment') projects.saveAssignment(task.project.id, { agentId: task.agent.id, agentCreatedAt: task.agent.createdAt, responsibility: 'A different assignment.' });
    assert.throws(() => contexts.readSourceSessionContext(task, captured.digest), /deleted or replaced|context changed/);
    assert.throws(() => captureFresh(task), /deleted or replaced|context changed/, 're-entry must not overwrite old identity');
  });
}

test('helper retains its exact parent memory scope across restart and a parent project move', () => {
  const parent = fixture();
  const context = captureFresh(parent);
  const child = log.createSession({ id: 'source-composition-worker', kind: 'agent', metadata: {
    source: 'delegated_worker', workerScope: true, parentSessionId: parent.sessionId, parentSourceUserSeq: parent.sourceUserSeq } });
  const source = log.appendEvent({ sessionId: child.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Inspect the delegated item.' } });
  const childInput = { sessionId: child.id, sourceUserSeq: source.seq };
  const childContext = binding.withSourceSessionContext(context, () => captureFresh(childInput));
  setSessionProject(parent.sessionId, null, { by: 'owner' });
  setSessionAgent(parent.sessionId, null, { by: 'owner' });
  memoryBinding._forgetPinnedMemoryScopesForTests(); memoryBinding.forgetSessionMemoryScope(); log.closeEventLog();
  binding.withSourceSessionContext(contexts.readSourceSessionContext(childInput, childContext.digest)!, () => {
    assert.equal(memory.scopeOfSession(child.id)?.projectId, parent.project.id);
    assert.equal(defaultFactWriteScope('project', child.id).agentKey, memory.agentScopeKey(parent.agent));
  });
});

test('a pinned skill changing without an agent edit invalidates the old composition', () => {
  const task = fixture();
  const skillName = 'source-context-craft';
  const folder = path.join(fixtureHome, 'skills', skillName);
  mkdirSync(folder, { recursive: true });
  const skill = path.join(folder, 'SKILL.md');
  writeFileSync(skill, '---\nname: source-context-craft\ndescription: Controlled fixture craft\n---\nOriginal skill body.');
  assert.ok(agents.updateAgentRecord(task.agent.id, { skills: [skillName] }));
  const context = captureFresh(task);
  const updatedAt = agents.getAgentRecord(task.agent.id)!.updatedAt;
  writeFileSync(skill, '---\nname: source-context-craft\ndescription: Controlled fixture craft\n---\nDifferent skill body.');
  assert.equal(agents.getAgentRecord(task.agent.id)!.updatedAt, updatedAt);
  assert.throws(() => contexts.readSourceSessionContext(task, context.digest), /context changed/);
});

test('a new agent with the same name cannot reopen the previous incarnation', async () => {
  const task = fixture();
  const context = captureFresh(task);
  agents.deleteAgentRecord(task.agent.id);
  await new Promise(resolve => setTimeout(resolve, 2));
  const replacement = agents.createAgentRecord({ name: task.agent.name, instructions: task.agent.instructions, createdFrom: 'console' });
  assert.ok(replacement.ok);
  assert.throws(() => contexts.readSourceSessionContext(task, context.digest), /deleted or replaced/);
});

test('missing history stays missing; foreign sources and mismatched digests cannot recreate it', () => {
  const task = fixture();
  assert.equal(contexts.readSourceSessionContext(task), null);
  contexts.withAcceptedSourceSessionContext(task, () => {
    assert.equal(binding.currentSourceSessionContext(task.sessionId), undefined);
  });
  assert.equal(contexts.readSourceSessionContext(task), null, 'entering an older source must not fabricate retained identity');
  assert.throws(() => captureFresh({ ...task, sourceUserSeq: task.sourceUserSeq + 999 }), /exact accepted source/);
  captureFresh(task);
  assert.throws(() => contexts.readSourceSessionContext(task, 'forged'), /identity is inconsistent/);
  const wrong = fixture();
  assert.throws(() => captureFresh({ sessionId: wrong.sessionId, sourceUserSeq: task.sourceUserSeq }), /exact accepted source/);
});

test('fresh identity ignores a warmed memory cache after same-name agent replacement', async () => {
  const task = fixture();
  memoryBinding.forgetSessionMemoryScope();
  assert.equal(memory.scopeOfSession(task.sessionId)?.agentKey, memory.agentScopeKey(task.agent));
  agents.deleteAgentRecord(task.agent.id);
  await new Promise(resolve => setTimeout(resolve, 2));
  const replacement = agents.createAgentRecord({ name: task.agent.name, instructions: task.agent.instructions, createdFrom: 'console' });
  assert.ok(replacement.ok);
  if (!replacement.ok) throw new Error('replacement fixture');
  // Do not invalidate the old cache: reproduce an out-of-process edit.
  const fresh = captureFresh(task);
  assert.equal(fresh.mount.agent?.agent.createdAt, replacement.agent.createdAt);
  assert.equal(fresh.memoryScope.agentKey, memory.agentScopeKey(replacement.agent));
  assert.notEqual(fresh.memoryScope.agentKey, memory.agentScopeKey(task.agent));
});

test('a legacy agent without a creation identity keeps ordinary chat and cannot claim durable recovery', async () => {
  const task = fixture();
  const { agentFilePath } = await import('../../tools/shared.js');
  const file = agentFilePath(task.agent.id);
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^createdAt:.*\n/m, ''));
  assert.equal(agents.getAgentRecord(task.agent.id)?.createdAt, null);
  let ran = false;
  contexts.withAcceptedSourceSessionContext(task, () => {
    ran = true;
    assert.equal(composition.composeSessionFromStore(task.sessionId).agent?.agent.id, task.agent.id);
    const agent = {};
    binding.bindAgentSourceSessionContext(agent, task.sessionId);
    assert.equal(binding.boundAgentSourceSessionContext(agent), undefined);
  }, { newlyAccepted: true });
  assert.equal(ran, true);
  assert.equal(contexts.readSourceSessionContext(task), null);
});

type SourceFixtureRef = { sessionId: string; sourceUserSeq: number };
function storedSourceIdentity(input: SourceFixtureRef) {
  const row = log.openEventLog().prepare(`SELECT identity_json, identity_digest FROM source_session_contexts_v1
    WHERE session_id = ? AND source_user_seq = ?`).get(input.sessionId, input.sourceUserSeq) as
    { identity_json: string; identity_digest: string } | undefined;
  assert.ok(row);
  return row;
}
function retainedMemoryCaptureSibling<T extends SourceFixtureRef>(template: T, edition: unknown,
  omit = false, mismatchedDigest = false) {
  // Controlled historical identity fixture; the separate cross-version suite
  // supplies actual old-producer bytes. Insert a new immutable accepted source;
  // do not disable retention guards or rewrite an already retained identity.
  const source = log.appendEvent({ sessionId: template.sessionId, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Inspect the controlled historical memory capture fixture.' } });
  const input = { ...template, sourceUserSeq: source.seq };
  const identity = JSON.parse(storedSourceIdentity(template).identity_json);
  identity.sourceUserSeq = input.sourceUserSeq;
  if (omit) delete identity.memoryCaptureEdition;
  else identity.memoryCaptureEdition = edition;
  const json = JSON.stringify(identity);
  const digest = mismatchedDigest ? '0'.repeat(64) : createHash('sha256').update(json).digest('hex');
  log.openEventLog().prepare(`INSERT INTO source_session_contexts_v1
    (session_id, source_user_seq, identity_json, identity_digest) VALUES (?, ?, ?, ?)`)
    .run(input.sessionId, input.sourceUserSeq, json, digest);
  return { input, stored: { identity_json: json, identity_digest: digest } };
}

test('memory capture edition: fresh source chooses tool owned v3 and reopens the exact stored identity', () => {
  const task = fixture();
  const forgedCallerFields = { ...task, memoryCaptureEdition: 'legacy_v1', digest: 'f'.repeat(64) };
  const context = captureFresh(forgedCallerFields);
  assert.equal(binding.sourceMemoryCaptureEdition(context), 'tool_owned_v3');
  const stored = storedSourceIdentity(task);
  assert.equal(JSON.parse(stored.identity_json).version, 1, 'the existing identity protocol is retained');
  assert.equal(JSON.parse(stored.identity_json).memoryCaptureEdition, 'tool_owned_v3');
  assert.equal(stored.identity_digest, context.digest);
  assert.equal(createHash('sha256').update(stored.identity_json).digest('hex'), context.digest);
  log.closeEventLog();
  const reopened = contexts.readSourceSessionContext(task, context.digest)!;
  assert.equal(binding.sourceMemoryCaptureEdition(reopened), 'tool_owned_v3');
  assert.deepEqual(storedSourceIdentity(task), stored, 'recovery must not rewrite the retained edition or bytes');
});

test('memory capture edition: missing retained field stays legacy after restart while a new source gets v3', () => {
  const template = fixture();
  captureFresh(template);
  const { input: task, stored: legacyBytes } = retainedMemoryCaptureSibling(template, undefined, true);
  log.closeEventLog();
  const recovered = contexts.readSourceSessionContext(task, legacyBytes.identity_digest)!;
  assert.equal(binding.sourceMemoryCaptureEdition(recovered), 'legacy_v1');
  assert.equal(binding.sourceMemoryCaptureEdition(captureFresh(task)), 'legacy_v1', 're-entry is not a new acceptance');
  assert.deepEqual(storedSourceIdentity(task), legacyBytes);
  assert.equal(Object.hasOwn(JSON.parse(storedSourceIdentity(task).identity_json), 'memoryCaptureEdition'), false);
  const next = log.appendEvent({ sessionId: task.sessionId, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Remember a separate controlled fact for this new request.' } });
  const fresh = captureFresh({ sessionId: task.sessionId, sourceUserSeq: next.seq });
  assert.equal(binding.sourceMemoryCaptureEdition(fresh), 'tool_owned_v3');
  assert.equal(binding.sourceMemoryCaptureEdition(contexts.readSourceSessionContext(task, legacyBytes.identity_digest)!), 'legacy_v1');
  assert.deepEqual(storedSourceIdentity(task), legacyBytes, 'fresh acceptance must not upgrade the earlier source');
});

test('memory capture edition: the retained digest is checked before applying the missing-field legacy default', () => {
  const template = fixture();
  captureFresh(template);
  const { input: task, stored } = retainedMemoryCaptureSibling(template, undefined, true, true);
  assert.throws(() => contexts.readSourceSessionContext(task, stored.identity_digest), /identity is inconsistent/);
  assert.throws(() => captureFresh(task), /identity is inconsistent/, 'capture cannot repair historical bytes by defaulting');
  assert.deepEqual(storedSourceIdentity(task), stored);
});

for (const edition of ['future_v99', null, '', 7] as const) {
  test(`memory capture edition: explicit ${JSON.stringify(edition)} cannot use the legacy default`, () => {
    const template = fixture();
    captureFresh(template);
    const { input: task, stored } = retainedMemoryCaptureSibling(template, edition);
    log.closeEventLog();
    assert.throws(() => contexts.readSourceSessionContext(task, stored.identity_digest), /memory.?capture.*unavailable/i);
    assert.throws(() => captureFresh(task), /memory.?capture.*unavailable/i);
    assert.deepEqual(storedSourceIdentity(task), stored);
  });
}

test('memory capture edition: plain fields and cloned contexts cannot claim checked v3 provenance', () => {
  const context = captureFresh(fixture());
  assert.equal(binding.sourceMemoryCaptureEdition(context), 'tool_owned_v3');
  assert.throws(() => binding.sourceMemoryCaptureEdition({ ...context }), /not validated/i);
  assert.throws(() => binding.sourceMemoryCaptureEdition({ ...context, memoryCaptureEdition: 'legacy_v1' }), /not validated/i);
  const { memoryCaptureEdition: _edition, ...legacyUnbound } = context;
  assert.equal(binding.sourceMemoryCaptureEdition(legacyUnbound), 'legacy_v1', 'an unbound older context cannot opt into v3');
  assert.throws(() => Object.defineProperty(context, 'memoryCaptureEdition', { value: 'legacy_v1' }), TypeError);
  assert.equal(binding.sourceMemoryCaptureEdition(context), 'tool_owned_v3');
});

for (const field of ['sessionId', 'sourceUserSeq', 'digest'] as const) {
  test(`memory capture edition: mutating checked ${field} invalidates the WeakMap source binding`, () => {
    const context = captureFresh(fixture());
    const original = context[field];
    Object.assign(context, { [field]: field === 'sourceUserSeq' ? context.sourceUserSeq + 1 : String(original) + '-changed' });
    try { assert.throws(() => binding.sourceMemoryCaptureEdition(context), /changed its accepted source/i); }
    finally { Object.assign(context, { [field]: original }); }
    assert.equal(binding.sourceMemoryCaptureEdition(context), 'tool_owned_v3');
  });
}

for (const edition of ['legacy_v1', 'save_operation_v2', 'tool_owned_v3'] as const) {
  test(`memory capture edition: helper inherits exact ${edition} parent across restart and rejects edition drift`, () => {
    let parent = fixture();
    captureFresh(parent);
    if (edition !== 'tool_owned_v3') parent = retainedMemoryCaptureSibling(parent, edition, edition === 'legacy_v1').input;
    const parentContext = contexts.readSourceSessionContext(parent)!;
    assert.equal(binding.sourceMemoryCaptureEdition(parentContext), edition);
    const child = log.createSession({ id: `source-memory-edition-worker-${parent.id}`, kind: 'agent', metadata: {
      source: 'delegated_worker', workerScope: true,
      parentSessionId: parent.sessionId, parentSourceUserSeq: parent.sourceUserSeq,
    } });
    const source = log.appendEvent({ sessionId: child.id, turn: 1, role: 'user', type: 'user_input_received',
      data: { text: 'Inspect the delegated memory fixture.' } });
    const childInput = { sessionId: child.id, sourceUserSeq: source.seq };
    const childContext = binding.withSourceSessionContext(parentContext, () => captureFresh(childInput));
    assert.equal(binding.sourceMemoryCaptureEdition(childContext), edition);
    const childBytes = storedSourceIdentity(childInput);
    const childIdentity = JSON.parse(childBytes.identity_json);
    assert.equal(childIdentity.memoryCaptureEdition, edition);
    assert.deepEqual(childIdentity.parent, {
      sessionId: parent.sessionId, sourceUserSeq: parent.sourceUserSeq, digest: parentContext.digest,
    });
    setSessionProject(parent.sessionId, null, { by: 'owner' });
    setSessionAgent(parent.sessionId, null, { by: 'owner' });
    log.closeEventLog();
    const reopened = contexts.readSourceSessionContext(childInput, childContext.digest)!;
    assert.equal(binding.sourceMemoryCaptureEdition(reopened), edition);
    assert.deepEqual(storedSourceIdentity(childInput), childBytes);
    const changed = retainedMemoryCaptureSibling(childInput, edition === 'legacy_v1' ? 'save_operation_v2' : 'legacy_v1');
    assert.throws(() => contexts.readSourceSessionContext(changed.input, changed.stored.identity_digest), /worker lost.*memory.?capture.*edition/i);
  });
}
