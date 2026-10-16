import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import type { HarnessRunContext } from '../runtime/harness/brackets.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-manual-skill-authority-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
process.env.CLEMMY_GOAL_CONTRACT = 'on';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
const log = await import('../runtime/harness/eventlog.js');
const leases = await import('../runtime/harness/dispatch-lease.js');
const { harnessRunContextStorage, ToolCallsCounter } = await import('../runtime/harness/brackets.js');
const { toolOutputContextStorage } = await import('../runtime/harness/tool-output-context.js');
const { runWithToolAbortSignal } = await import('../runtime/tool-abort-context.js');
const { registerSkillTools } = await import('./skill-tools.js');
const { captureManualSkillDistillAuthority } = await import('./manual-skill-distill-authority.js');
const { userRequestedSkillDistillation } = await import('./skill-tools.js');
const store = await import('../memory/skill-store.js');
const distiller = await import('../memory/skill-distiller.js');
const { issueManualSkillDraftRequestReceipt } = await import('../memory/learning-receipt.js');
const { withFileLock } = await import('../runtime/atomic-json.js');
const { Runner } = await import('@openai/agents');
const { CodexModelProvider } = await import('../runtime/harness/codex-model.js');
const { commitTurnOutcome } = await import('../runtime/harness/delivery-committer.js');
const { turnOutcomeId } = await import('../runtime/harness/turn-outcome.js');
const continuity = await import('../memory/task-continuity.js');
const continuityRuntime = await import('../runtime/harness/task-continuity-runtime.js');

type Reply = { content: Array<{ text?: string }> };
let handler!: (args: { objective: string }) => Promise<Reply>;
registerSkillTools({ tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
  if (name === 'skill_distill') handler = callback;
} } as never);
let modelCalls = 0;
let providerCalls = 0;
beforeEach(() => {
  rmSync(store.SKILLS_DIR, { recursive: true, force: true });
  modelCalls = 0;
  providerCalls = 0;
  mock.method(Runner.prototype, 'run', async () => { modelCalls++; throw new Error('unexpected model request in fixture'); });
});
afterEach(() => mock.restoreAll());
after(() => { log.closeEventLog(); rmSync(TEST_HOME, { recursive: true, force: true }); });

function fixture(text = 'Save this as a reusable playbook.', data: Record<string, unknown> = {}, role: 'user' | 'system' = 'user') {
  const session = log.createSession({ kind: 'chat', userId: 'controlled-manual-owner' });
  const attempt = log.beginRunAttempt(session.id);
  const source = log.recordRunAttemptUserInput(attempt, { turn: 1, role, data: { text, ...data } });
  const lease = leases.activateDispatchLease({ sessionId: session.id, scopeId: `${session.id}::query`, runAttemptId: attempt.attemptId });
  const context: HarnessRunContext = { sessionId: session.id, sourceUserSeq: source.seq, runAttemptId: attempt.attemptId,
    dispatchLease: lease, counter: new ToolCallsCounter(50) };
  const objective = 'Read controlled input and prepare a verified fixture summary';
  const name = 'controlled-manual-procedure';
  store.writeDistilledSkill({ name, description: objective, capabilityTask: objective,
    body: '1. Read the controlled input.\n2. Verify the summary.', origin: { kind: 'chat', sourceId: 'seed-fixture' } });
  return { session, attempt, source, lease, context, objective, name };
}
type Fixture = ReturnType<typeof fixture>;
function text(reply: Reply): string { return reply.content.map(item => item.text ?? '').join('\n'); }
function call(f: Fixture, context: HarnessRunContext = f.context): Promise<Reply> {
  return harnessRunContextStorage.run(context, () => handler({ objective: f.objective }));
}
function bytes(f: Fixture): string { return readFileSync(store.loadSkill(f.name)!.skillPath, 'utf8'); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const nextTurn = () => new Promise<void>(done => setImmediate(done));

function controlledDraft(name: string, objective: string) {
  return { finalOutput: { name, description: objective, requires: [],
    procedureMarkdown: '1. Read the controlled fixture input.\n2. Verify the resulting summary before saving.',
    provenTools: [{ tool: 'read_file', argsShape: '{"path":"{{fixture}}"}', notes: null }], pitfalls: [] } };
}

function configureControlledMemoryModel(run: () => Promise<unknown>): void {
  Object.assign(process.env, { AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', OPENAI_MODEL_PRIMARY: 'gpt-5.6-terra',
    CLEMMY_MODEL_ROLES: '[]', BYO_PROVIDERS: '', BYO_MODEL_BASE_URL: '', BYO_MODEL_ID: '', BYO_MODEL_API_KEY: '' });
  writeFileSync(path.join(TEST_HOME, 'state', 'auth.json'), JSON.stringify({ codexOauth: { accessToken: 'controlled-token', refreshToken: 'controlled-refresh' } }));
  mock.restoreAll();
  mock.method(CodexModelProvider.prototype, 'getModel', () => ({ async getResponse() { providerCalls++; throw new Error('provider forbidden'); },
    async *getStreamedResponse() { providerCalls++; throw new Error('provider forbidden'); } }));
  mock.method(Runner.prototype, 'run', async () => { modelCalls++; return run(); });
}

test('public manual duplicate reuses draft with exact consent-event provenance and zero provider calls', async () => {
  const f = fixture();
  for (let index = 0; index < 24; index++) log.appendEvent({ sessionId: f.session.id, turn: index + 2, role: 'user',
    type: 'user_input_received', data: { synthetic: true, text: 'controlled outcome context' } });
  log.appendEvent({ sessionId: f.session.id, turn: 30, role: 'user', type: 'user_input_received', data: { text: 'An unrelated ordinary message.' } });
  assert.match(text(await call(f)), /already matches an existing skill/);
  const skill = store.loadSkill(f.name)!;
  assert.equal(skill.frontmatter.tier, 'draft');
  assert.ok(skill.frontmatter.capabilityOrigins?.some(origin => origin.kind === 'manual' && origin.sourceId === f.source.id));
  const receipt = skill.frontmatter.learningReceipts?.find(row => row.authority === 'manual_user_request');
  assert.equal(receipt?.sourceId, f.source.id);
  assert.equal(receipt?.sessionId, f.session.id);
  assert.equal(receipt?.evidence.includes('independent_validation'), false);
  assert.equal(receipt?.evidence.includes('terminal_success'), false);
  assert.equal(modelCalls, 0);
});

test('ordinary current source cannot borrow older or newer opt-in', async () => {
  const f = fixture('Read the controlled input.');
  log.appendEvent({ sessionId: f.session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Save this as a skill.' } });
  const before = bytes(f);
  assert.doesNotMatch(text(await call(f)), /already matches|Distilled a draft skill/);
  assert.equal(bytes(f), before);
  assert.equal(modelCalls, 0);
});

for (const request of [
  "Don't automatically save conversations, but save this as a reusable playbook.",
  "Save this as a reusable playbook; don't automatically save my chats by default.",
  'Do not automatically save future work, but save this as a playbook.',
  "Don't automatically save conversations; remember how to do this next time.",
  "Don't automatically save conversations; turn this into a skill.",
  "Don't automatically save conversations\nSave this as a reusable playbook.",
]) {
  test(`automatic-only policy preserves the separate manual request: ${request}`, async () => {
    const f = fixture(request);
    assert.match(text(await call(f)), /already matches an existing skill/);
    const receipt = store.loadSkill(f.name)!.frontmatter.learningReceipts?.find(row => row.authority === 'manual_user_request');
    assert.equal(receipt?.sourceId, f.source.id);
    assert.equal(receipt?.sessionId, f.session.id);
    assert.deepEqual(receipt?.evidence, ['explicit_user_request', 'manual_draft_request']);
    assert.equal(modelCalls, 0);
  });
}

for (const request of [
  "Don't automatically save conversations.",
  'Do not automatically save this as a skill.',
  "Don't automatically save conversations, but read this workflow.",
  "Don't automatically save this workflow, but save this as a reusable playbook.",
  "Don't automatically save conversations, but do not save this as a reusable playbook.",
  "Save this as a reusable playbook, but don't save this task.",
  "Don't automatically save conversations or this task, but save this as a reusable playbook.",
  "Don't automatically save conversations, but stop skill distillation.",
  "Don't automatically save conversations\nSave this as a reusable playbook\nDon't save this task.",
]) {
  test(`automatic policy cannot override absent consent or a current-task veto: ${request}`, async () => {
    const f = fixture(request);
    const before = bytes(f);
    assert.doesNotMatch(text(await call(f)), /already matches|Distilled a draft skill|Saved the requested draft skill/);
    assert.equal(bytes(f), before);
    assert.equal(store.loadSkill(f.name)!.frontmatter.learningReceipts?.some(row => row.authority === 'manual_user_request') ?? false, false);
    assert.equal(modelCalls, 0);
  });
}

for (const displayText of ['', '   ', null, 12, { original: 'Save this playbook' }, 'Read this attachment.']) {
  test(`expanded model text cannot replace original display consent ${JSON.stringify(displayText)}`, async () => {
    const f = fixture('Attachment expansion: save this playbook for future use.', { displayText });
    const before = bytes(f);
    assert.doesNotMatch(text(await call(f)), /already matches|Distilled a draft skill/);
    assert.equal(bytes(f), before);
    assert.equal(modelCalls, 0);
  });
}

for (const kind of ['missing-source', 'foreign-source', 'system-source', 'synthetic-source', 'control-source',
  'wrong-attempt', 'missing-lease', 'forged-lease-attempt', 'ambient-session', 'ambient-source', 'stopped', 'terminal'] as const) {
  test(`public manual tool refuses ${kind} without draft mutation or model work`, async () => {
    const f = fixture(undefined, kind === 'synthetic-source' ? { synthetic: true }
      : kind === 'control-source' ? { cardDecision: { decision: 'approve' } } : {}, kind === 'system-source' ? 'system' : 'user');
    const context = { ...f.context };
    if (kind === 'missing-source') delete context.sourceUserSeq;
    if (kind === 'foreign-source') context.sourceUserSeq = fixture().source.seq;
    if (kind === 'wrong-attempt') context.runAttemptId = fixture().attempt.attemptId;
    if (kind === 'missing-lease') delete context.dispatchLease;
    if (kind === 'forged-lease-attempt') {
      const other = fixture();
      context.dispatchLease = { ...other.lease, sessionId: f.session.id, runAttemptId: f.attempt.attemptId };
    }
    if (kind === 'stopped') log.requestKill(f.session.id, 'controlled Stop', { attemptId: f.attempt.attemptId });
    if (kind === 'terminal') log.finishRunAttempt(f.attempt, 'completed');
    const before = bytes(f);
    const invoke = () => call(f, context);
    const result = kind === 'ambient-session' || kind === 'ambient-source'
      ? await toolOutputContextStorage.run({ sessionId: kind === 'ambient-session' ? 'foreign' : f.session.id,
          sourceUserSeq: kind === 'ambient-source' ? f.source.seq + 1 : f.source.seq }, invoke)
      : await invoke();
    assert.doesNotMatch(text(result), /already matches|Distilled a draft skill/);
    assert.equal(bytes(f), before);
    assert.equal(modelCalls, 0);
  });
}

test('aborted tool, expired deadline and caller cancellation cannot reuse valid active attempt and lease', async () => {
  for (const kind of ['tool-abort', 'deadline', 'caller-abort']) {
    const f = fixture();
    const abort = new AbortController();
    if (kind !== 'deadline') abort.abort();
    if (kind === 'caller-abort') f.context.callerCancelSignal = abort.signal;
    const before = bytes(f);
    const result = await runWithToolAbortSignal(kind === 'caller-abort' ? new AbortController().signal : abort.signal,
      () => call(f), kind === 'deadline' ? Date.now() - 1 : Date.now() + 60_000);
    assert.doesNotMatch(text(result), /already matches|Distilled a draft skill/);
    assert.equal(bytes(f), before);
    assert.equal(leases.isDispatchLeaseCurrent(f.lease), true, 'transport timeout is independently checked');
  }
  assert.equal(modelCalls, 0);
});

test('Stop during the real duplicate capability-lock wait adds no lineage or receipt', async () => {
  const f = fixture();
  store.ensureSkillsDir();
  const entered = deferred<void>();
  const release = deferred<void>();
  const held = withFileLock(path.join(store.SKILLS_DIR, '.capability-claim'), async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const before = bytes(f);
  const pending = call(f);
  await nextTurn();
  log.requestKill(f.session.id, 'Stop during controlled lock wait', { attemptId: f.attempt.attemptId });
  release.resolve();
  await held;
  assert.doesNotMatch(text(await pending), /already matches|Distilled a draft skill/);
  assert.equal(bytes(f), before);
  assert.equal(modelCalls, 0);
});

test('the final draft-claim lock rechecks host authority before duplicate lineage or writing', async () => {
  const f = fixture();
  const authority = captureManualSkillDistillAuthority(f.context, userRequestedSkillDistillation)!;
  assert.ok(authority);
  const receipt = issueManualSkillDraftRequestReceipt({
    sessionId: f.session.id, sourceId: f.source.id, explicitUserRequest: true })!;
  const entered = deferred<void>(); const release = deferred<void>();
  const held = withFileLock(path.join(store.SKILLS_DIR, '.capability-claim'), async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const before = bytes(f);
  const pending = distiller._testOnly_claimDistilledCapability({ preferredName: 'new-controlled-draft', description: f.objective,
    body: 'A controlled procedure with a retained exact authority guard.', objective: f.objective,
    origin: { kind: 'manual', sourceId: f.source.id }, applicability: { toolFamilies: [], entitySlots: [] },
    learningReceipt: receipt, currentAuthority: authority.currentAuthority });
  const refused = assert.rejects(pending, /no longer owns the active request/);
  await nextTurn();
  leases.revokeDispatchLease(f.lease);
  release.resolve(); await held;
  await refused;
  assert.equal(bytes(f), before);
  assert.equal(store.loadSkill('new-controlled-draft'), null);
  assert.equal(modelCalls, 0);
});

function clarification(f: Fixture, answer = 'Use fixture A.') {
  const question = 'Which controlled input should I use?';
  log.appendEvent({ sessionId: f.session.id, turn: f.source.turn, role: 'Clem', type: 'awaiting_user_input',
    data: { question, purpose: 'clarification', sourceUserSeq: f.source.seq } });
  const identity = { sessionId: f.session.id, sourceUserSeq: f.source.seq, turn: f.source.turn };
  commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'needs_input', resumable: true,
    needs: { kind: 'input' }, presentation: { kind: 'question', text: question } });
  const attempt = log.beginRunAttempt(f.session.id);
  const source = log.recordRunAttemptUserInput(attempt, { turn: 2, role: 'user', data: { text: answer } });
  const canonical = continuityRuntime.canonicalClarificationTaskInput({ parentInput: String(f.source.data.text), question, answer })!;
  assert.equal(continuity.consumeTaskContinuityPacket({ sessionId: f.session.id, consumingSourceUserSeq: source.seq,
    resolution: { resolverVersion: continuityRuntime.CLARIFICATION_RESOLVER_VERSION, disposition: 'provided',
      semanticInputHash: createHash('sha256').update(canonical).digest('hex') } }).status, 'consumed');
  const lease = leases.activateDispatchLease({ sessionId: f.session.id, scopeId: `${f.session.id}::answer-query`, runAttemptId: attempt.attemptId });
  return { ...f, source, attempt, lease, context: { ...f.context, sourceUserSeq: source.seq, runAttemptId: attempt.attemptId, dispatchLease: lease } };
}

test('inherited consent binds original A bytes and current B ownership, never a fabricated context', async () => {
  const parent = fixture();
  const current = clarification(parent);
  const authority = captureManualSkillDistillAuthority(current.context, userRequestedSkillDistillation)!;
  assert.ok(authority);
  assert.equal(authority.consentEventId, parent.source.id);
  assert.equal(authority.currentAuthority(), true);
  log.openEventLog().prepare(`UPDATE events SET data_json = json_set(data_json, '$.displayText', ?) WHERE id = ?`)
    .run('Remember this different reusable procedure.', parent.source.id);
  assert.equal(authority.currentAuthority(), false, 'same event id cannot replace the exact original consent text');

  const other = fixture('Read the controlled input only.');
  other.context.taskContinuation = { packetId: 'fabricated', parentSourceUserSeq: parent.source.seq,
    consumingSourceUserSeq: other.source.seq, parentInput: 'Save this workflow', question: 'Which input?',
    answer: 'fixture A', disposition: 'provided', retrievalQuery: 'Save this workflow with fixture A', options: [], capabilities: [] };
  const before = bytes(other);
  assert.doesNotMatch(text(await call(other)), /already matches|Distilled a draft skill/);
  assert.equal(bytes(other), before);
  assert.equal(modelCalls, 0);
});

test('Stop after a controlled model wait preserves its spent attempt but writes no draft', async () => {
  const f = fixture();
  rmSync(path.dirname(store.loadSkill(f.name)!.skillPath), { recursive: true, force: true });
  log.appendEvent({ sessionId: f.session.id, turn: 0, role: 'Clem', type: 'tool_called',
    data: { tool: 'read_file', callId: 'controlled-read', arguments: JSON.stringify({ path: 'controlled.txt' }) } });
  const entered = deferred<void>(); const release = deferred<unknown>();
  configureControlledMemoryModel(async () => { entered.resolve(); return release.promise; });
  const pending = call(f);
  await Promise.race([entered.promise, pending.then(() => { throw new Error('controlled model route did not enter the stub'); })]);
  log.requestKill(f.session.id, 'Stop while controlled model is pending', { attemptId: f.attempt.attemptId });
  release.resolve(controlledDraft('late-model-draft', f.objective));
  assert.doesNotMatch(text(await pending), /Distilled a draft skill/);
  assert.equal(store.loadSkill('late-model-draft'), null);
  assert.equal(modelCalls, 1, 'one controlled stub completion; no actual provider was invoked');
  assert.equal(providerCalls, 0);
  const { listOperationalEvents } = await import('../runtime/operational-telemetry.js');
  const work = listOperationalEvents({ source: 'memory' }).find(event => event.actor === 'skills' && event.sessionId === f.session.id);
  assert.ok(work, 'the controlled memory job retains its truthful failed outcome');
  assert.equal((work.payload as { failure?: unknown }).failure, null, 'host Stop is not a provider/model failure');
});

test('public fresh manual save writes an unreviewed request draft without inventing successful execution', async () => {
  const f = fixture();
  rmSync(path.dirname(store.loadSkill(f.name)!.skillPath), { recursive: true, force: true });
  log.appendEvent({ sessionId: f.session.id, turn: 0, role: 'Clem', type: 'tool_called',
    data: { tool: 'read_file', callId: 'controlled-fresh-read', arguments: JSON.stringify({ path: 'controlled.txt' }) } });
  configureControlledMemoryModel(async () => controlledDraft('fresh-requested-draft', f.objective));
  assert.match(text(await call(f)), /Saved the requested draft skill/);
  const skill = store.loadSkill('fresh-requested-draft')!;
  assert.ok(skill);
  assert.equal(skill.frontmatter.tier, 'draft');
  assert.equal(skill.frontmatter.useCount, 0);
  assert.equal(skill.frontmatter.origin?.sourceId, f.source.id);
  const receipt = skill.frontmatter.learningReceipts?.[0]!;
  assert.equal(receipt.authority, 'manual_user_request');
  assert.equal(receipt.sessionId, f.session.id);
  assert.equal(receipt.sourceId, f.source.id);
  assert.deepEqual(receipt.evidence, ['explicit_user_request', 'manual_draft_request']);
  assert.equal(receipt.evidence.includes('terminal_success'), false);
  const { listNotifications } = await import('../runtime/notifications.js');
  const notification = listNotifications(100).find(row => row.metadata?.skillName === skill.name);
  assert.ok(notification);
  assert.match(notification.body, /asked me to preserve as an unreviewed draft/);
  assert.doesNotMatch(notification.body, /successful run/);
  const { listProactiveOffers } = await import('../runtime/proactive-offers.js');
  const offer = listProactiveOffers('controlled-manual-owner').find(row => row.evidenceRefs.includes(`skill:${skill.name}`));
  assert.ok(offer);
  assert.match(offer.summary, /draft procedure you requested/);
  assert.match(offer.whyNow, /unreviewed/);
  assert.doesNotMatch(`${offer.summary} ${offer.whyNow}`, /successful work|completed work|verified learning receipt/);
  await distiller.reinforceDraftSkills([skill.name], 'success', undefined, f.session.id, receipt);
  assert.equal(store.loadSkill(skill.name)!.frontmatter.useCount, 0);
  assert.equal(modelCalls, 1, 'one deterministic local Runner stub; no provider request');
  assert.equal(providerCalls, 0);
});
