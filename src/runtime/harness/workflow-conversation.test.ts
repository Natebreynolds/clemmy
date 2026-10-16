import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-conversation-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(home, 'state'), { recursive: true });
const identity = await import('../../shared/workflow-conversation.js');
const workflows = await import('../../memory/workflow-store.js');
const log = await import('./eventlog.js');
const composition = await import('./session-composition.js');
const contexts = await import('./source-session-context.js');
const sourceScope = await import('./source-session-context-scope.js');
const selector = await import('./accepted-source-session-branch.js');
const { HarnessSession } = await import('./session.js');
const { renderClaudeAgentBrainSystemAppend } = await import('./claude-agent-brain.js');
const { workflowConversationBindingForSession, requireWorkflowConversationTarget } = await import('../../execution/workflow-conversation.js');
const { closeMemoryDb } = await import('../../memory/db.js');
after(() => { closeMemoryDb(); log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

function workflow(slug: string) {
  return workflows.writeWorkflow(slug, { name: 'Same human title', description: 'Controlled conversation fixture.',
    enabled: false, trigger: { manual: true }, steps: [{ id: 'read', prompt: 'PRIVATE_FULL_STEP_NOT_IN_EVERY_PROMPT', sideEffect: 'read' }] });
}
function binding(slug: string) {
  const rootSessionId = identity.workflowConversationSessionId(slug);
  assert.ok(rootSessionId);
  return { version: 1 as const, rootSessionId, workflowSlug: slug };
}

test('workflow conversation identity round trips exact portable basenames and refuses path or encoding aliases', () => {
  for (const slug of ['daily-work', 'Legacy_Name', 'réunion-☕']) {
    const id = identity.workflowConversationSessionId(slug);
    assert.ok(id);
    assert.equal(identity.workflowConversationSlugFromSessionId(id), slug);
    assert.equal(id.startsWith('workflow:'), false);
  }
  for (const slug of ['', '.', '..', '../outside', 'a/b', 'a\\b', ' padded ', 'a\u0000b']) {
    assert.equal(identity.workflowConversationSessionId(slug), null);
  }
  for (const id of ['workflow-edit:%', 'workflow-edit:%2e%2e', 'workflow-edit:a%2fb', 'workflow-edit:%64aily-work']) {
    assert.equal(identity.workflowConversationSlugFromSessionId(id), null);
    assert.throws(() => workflowConversationBindingForSession(id), /invalid identity/);
  }
});

test('workflow conversation remains ordinary chat with exact definition context and no allowlist grant', () => {
  const a = workflow('conversation-a'), b = workflow('conversation-b');
  for (const entry of [a, b]) {
    const scope = binding(entry.name);
    const mount = composition.composeSession({ sessionId: scope.rootSessionId, toolAllowlist: ['read_file'] });
    assert.equal(mount.kind, 'chat');
    assert.equal(mount.sessionKind, 'chat');
    assert.equal(mount.workflow, null);
    assert.deepEqual(mount.workflowConversation, scope);
    assert.deepEqual(mount.toolAllowlist, ['read_file']);
    const context = composition.renderSessionMountPrimers(mount);
    assert.ok(context.includes(JSON.stringify(entry.name)));
    assert.doesNotMatch(context, /PRIVATE_FULL_STEP_NOT_IN_EVERY_PROMPT/);
    const reachable = new Set<string>(['read_file']);
    composition.pinCompositionTools(reachable, mount, ['read_file']);
    assert.deepEqual([...reachable], ['read_file'], 'scoping does not grant unreachable workflow tools');
  }
  const run = composition.composeSession({ sessionId: 'workflow:actual-run:read', sessionKind: 'workflow' });
  assert.equal(run.kind, 'workflow');
  assert.equal(run.workflowConversation, undefined);
});

test('Stop successor retains exact workflow conversation in source context and both brain prompts after reopen', async () => {
  workflow('conversation-stop');
  const scope = binding('conversation-stop');
  const root = log.createSession({ id: scope.rootSessionId, kind: 'chat', channel: 'desktop', userId: 'desktop',
    metadata: { source: 'desktop', ingressProvider: 'desktop', channelId: scope.rootSessionId,
      userId: 'desktop', __workflow_conversation: scope } });
  const prior = log.beginRunAttempt(root.id, { runId: 'conversation-stopped-run' });
  const priorSource = log.recordRunAttemptUserInput(prior, { turn: 1, role: 'user', data: { text: 'Inspect this workflow.' } });
  log.appendEvent({ sessionId: root.id, turn: 1, role: 'Clem', type: 'conversation_completed', data: {
    sourceUserSeq: priorSource.seq, runId: prior.runId, attemptId: prior.attemptId, reason: 'cancelled', reply: 'Stopped.' } });
  log.finishRunAttempt(prior, 'cancelled');
  HarnessSession.load(root.id)!.markStatus('cancelled');
  const claimed = selector.claimSessionForAcceptedSource({ kind: 'ordinary', entrySessionId: root.id,
    durableSourceId: 'conversation-after-stop', workflowConversation: scope,
    continuity: { provider: 'desktop', scopeId: null, conversationId: root.id, audienceId: 'desktop' },
    receipt: { requestId: 'conversation-after-stop', runId: 'conversation-after-stop', inputHash: 'exact-message' } });
  const child = claimed.selection.sessionId;
  assert.notEqual(child, root.id);
  assert.deepEqual(log.getSession(child)?.metadata.__workflow_conversation, scope);
  const attempt = log.beginRunAttempt(child, { runId: claimed.receipt.runId });
  const source = log.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: 'Only explain the read step.' } });
  const accepted = contexts.captureFreshSourceSessionContext({ sessionId: child, sourceUserSeq: source.seq });
  assert.ok(accepted);
  // A native edit changes the definition, without changing which saved object
  // this conversation belongs to or invalidating its own recovery context.
  const current = workflows.readWorkflow(scope.workflowSlug)!;
  workflows.writeWorkflow(scope.workflowSlug, { ...current.data, steps: [{ ...current.data.steps[0], prompt: 'NEW_SAVED_STEP' }] });
  log.closeEventLog();
  const reopened = contexts.readSourceSessionContext({ sessionId: child, sourceUserSeq: source.seq }, accepted.digest);
  assert.ok(reopened);
  await sourceScope.withSourceSessionContext(reopened, async () => {
    const mount = composition.composeSessionFromStore(child);
    assert.deepEqual(mount.workflowConversation, scope);
    composition.applySessionMountPrimers(child, mount);
    const standard = HarnessSession.load(child)!.toInputItems().find(item =>
      typeof (item as { content?: unknown }).content === 'string'
      && String((item as { content?: unknown }).content).startsWith('[workflow-conversation]'));
    assert.ok(standard, 'standard brain receives the scoped primer');
    const claude = renderClaudeAgentBrainSystemAppend('dashboard', {
      sessionId: child, sourceUserSeq: source.seq, message: 'Only explain the read step.', channel: 'cli', userId: 'desktop' }, 'read_only');
    assert.ok(claude.includes('[workflow-conversation]'));
    assert.ok(claude.includes(JSON.stringify(scope.workflowSlug)));
    assert.doesNotMatch(claude, /NEW_SAVED_STEP|PRIVATE_FULL_STEP_NOT_IN_EVERY_PROMPT/);
  });
  assert.equal(selector.resolveAcceptedSourceIngressLineage({ sessionId: child, provider: 'desktop',
    scopeId: null, audienceId: 'desktop' })?.workflowConversation?.workflowSlug, scope.workflowSlug);
});

test('deleted or malformed workflow binding never falls through to another same-title definition', () => {
  workflow('conversation-deleted'); workflow('conversation-survivor');
  const scope = binding('conversation-deleted');
  workflows.deleteWorkflow(scope.workflowSlug);
  assert.throws(() => requireWorkflowConversationTarget(scope), /no longer available/);
  assert.deepEqual(composition.composeSession({ sessionId: scope.rootSessionId }).workflowConversation, scope,
    'control/replay context retains identity after deletion; new ordinary admission checks current availability separately');
  assert.throws(() => composition.composeSession({ sessionId: 'sess-corrupt-conversation', metadata: {
    __workflow_conversation: { ...scope, workflowSlug: 'conversation-survivor' } } }), /invalid saved binding/);
  assert.throws(() => composition.composeSession({ sessionId: identity.workflowConversationSessionId('conversation-survivor')!,
    metadata: { __workflow_conversation: scope } }), /different workflow/);
});

test('raw parent workflow metadata does not cross an unvalidated principal split', () => {
  workflow('conversation-principal');
  const scope = binding('conversation-principal');
  const parent = log.createSession({ id: scope.rootSessionId, kind: 'chat', channel: 'desktop', userId: 'desktop',
    metadata: { source: 'desktop', ingressProvider: 'desktop', channelId: scope.rootSessionId,
      userId: 'desktop', __workflow_conversation: scope } });
  const selected = selector.claimSessionForAcceptedSource({ kind: 'ordinary', entrySessionId: parent.id,
    durableSourceId: 'foreign-without-mount', continuity: { provider: 'mobile', scopeId: null,
      conversationId: 'other-device-conversation', audienceId: 'other-device' },
    receipt: { requestId: 'foreign-without-mount', runId: 'foreign-without-mount', inputHash: 'foreign' } });
  assert.equal(log.getSession(selected.selection.sessionId)?.metadata.__workflow_conversation, undefined);
  assert.equal(composition.composeSessionFromStore(selected.selection.sessionId).workflowConversation, undefined);
});

test('workflow conversation refuses a reused or replayed successor rebound to another valid definition', () => {
  workflow('conversation-head-a'); workflow('conversation-head-b');
  const a = binding('conversation-head-a'), b = binding('conversation-head-b');
  const root = log.createSession({ id: a.rootSessionId, kind: 'chat', channel: 'desktop', userId: 'desktop',
    metadata: { source: 'desktop', ingressProvider: 'desktop', channelId: a.rootSessionId,
      userId: 'desktop', __workflow_conversation: a } });
  HarnessSession.load(root.id)!.markStatus('completed');
  const request = { kind: 'ordinary' as const, entrySessionId: root.id, durableSourceId: 'head-a-first', workflowConversation: a,
    continuity: { provider: 'desktop', scopeId: null, conversationId: root.id, audienceId: 'desktop' },
    receipt: { requestId: 'head-a-first', runId: 'head-a-first', inputHash: 'head-a-first' } };
  const first = selector.claimSessionForAcceptedSource(request);
  assert.notEqual(first.selection.sessionId, root.id);
  log.openEventLog().prepare("UPDATE sessions SET metadata_json = json_set(metadata_json, '$.__workflow_conversation', json(?)) WHERE id = ?")
    .run(JSON.stringify(b), first.selection.sessionId);
  const before = ['events', 'harness_chat_requests', 'accepted_source_session_bindings', 'accepted_source_session_pointers']
    .map(table => log.openEventLog().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  assert.throws(() => selector.claimSessionForAcceptedSource({ ...request, durableSourceId: 'head-a-next',
    receipt: { requestId: 'head-a-next', runId: 'head-a-next', inputHash: 'head-a-next' } }), /different workflow/);
  assert.throws(() => selector.claimSessionForAcceptedSource(request), /different workflow/);
  assert.deepEqual(['events', 'harness_chat_requests', 'accepted_source_session_bindings', 'accepted_source_session_pointers']
    .map(table => log.openEventLog().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), before,
  'a foreign valid definition cannot acquire a new source, receipt, binding or pointer');
  log.openEventLog().prepare("UPDATE sessions SET metadata_json = json_set(metadata_json, '$.__workflow_conversation', json(?)) WHERE id = ?")
    .run(JSON.stringify(a), first.selection.sessionId);
  assert.equal(selector.claimSessionForAcceptedSource(request).receipt.sessionId, first.selection.sessionId);
});
