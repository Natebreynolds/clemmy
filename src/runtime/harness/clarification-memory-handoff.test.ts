import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-clarification-memory-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.CLEMMY_EMBED_AT_WRITE = 'off';
mkdirSync(path.join(home, 'state'), { recursive: true });
writeFileSync(path.join(home, 'state', 'machine-id'), 'clarification-memory-test\n');
const reviews: Array<Record<string, unknown>> = [];
let reviewHook: ((input: Record<string, unknown>) => void) | undefined;
let reviewQuote: string | undefined;
process.env.AUTH_MODE = 'codex_oauth';
process.env.MODEL_ROUTING_MODE = 'all_in';
process.env.BYO_MODEL_BASE_URL = 'https://fixture.invalid/v1';
process.env.BYO_MODEL_API_KEY = 'fixture-only';
process.env.BYO_MODEL_ID = 'fixture-brain';
process.env.BYO_MODEL_JUDGE_ID = 'fixture-review';
process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
const { Runner } = await import('@openai/agents');
mock.method(Runner.prototype, 'run', async (agent: { name: string }, raw: string) => {
  assert.equal(agent.name, 'MemoryCorrectionReview', 'no additional model route belongs to this fixture');
  const input = JSON.parse(raw) as Record<string, unknown>;
  reviews.push(structuredClone(input)); reviewHook?.(input);
  return { finalOutput: JSON.stringify({ decision: 'entailed', ownerQuote: reviewQuote ?? input.ownerText,
    reason: 'The exact selected owner answer supplies B while A stays unchanged.' }) };
});
const events = await import('./eventlog.js');
const continuity = await import('../../memory/task-continuity.js');
const runtime = await import('./task-continuity-runtime.js');
const revision = await import('../semantic-boundary/clarification-revision.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const context = await import('./source-session-context.js');
const memory = await import('./memory-completion-obligation.js');
const host = await import('./host-turn-runner.js');
const brackets = await import('./brackets.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const facts = await import('../../memory/facts.js');
const factState = await import('../../memory/fact-correction.js');
const memoryDb = await import('../../memory/db.js');
const projects = await import('../../projects/project-record.js');
const { setSessionProject } = await import('../../projects/session-project.js');
const dispatch = await import('./dispatch-ledger.js');
const settlements = await import('./logical-call-settlement-store.js');
const outcomes = await import('./attempt-outcome.js');
const authorities = await import('./accepted-turn-call-authority.js');
const hostBindings = await import('./host-call-capability-binding.js');
const contracts = await import('./logical-call-contract.js');
const logical = await import('./attempt-identity.js');
const leases = await import('./dispatch-lease.js');
const toolContext = await import('./tool-output-context.js');
const { classifyRuntimeToolEffect } = await import('./tool-effect.js');
const { registerMemoryTools } = await import('../../tools/memory-tools.js');
const handlers = new Map<string, (input: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
registerMemoryTools({ tool(name: string, ...values: unknown[]) { handlers.set(name, values.at(-1) as never); } } as never);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type Identity = { sessionId: string; sourceUserSeq: number; turn: number };
let serial = 0;
after(() => { runtime._setClarificationAnswerCompletenessForTests(null); memoryDb.closeMemoryDb(); events.closeEventLog(); projects._closeProjectStoreForTests(); mock.restoreAll(); rmSync(home, { recursive: true, force: true }); });
function accepted(sessionId: string, text: string, data: Record<string, unknown> = {}) {
  const attempt = events.beginRunAttempt(sessionId);
  const event = events.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text, ...data } });
  assert.ok(context.captureFreshSourceSessionContext({ sessionId, sourceUserSeq: event.seq }));
  return event;
}
function arm(identity: Identity) {
  const frozenCatalogDigest = digest(JSON.stringify({ entries: [], version: 1 }));
  const armed = authorities.armHostCallAuthority({ ...identity,
    catalogRevisionDigest: digest(JSON.stringify({ envelopeDigest: null, frozenCatalogDigest, sealedUniverse: [], version: 1 })),
    bindingRevisionDigest: digest(JSON.stringify({ attemptId: identity.sessionId, envelopeDigest: null, frozenCatalogDigest, version: 1 })),
    maxLogicalCalls: 20, maxParallelCalls: 8 });
  assert.equal(armed.status, 'armed', JSON.stringify(armed));
}
function attested<T>(identity: Identity, name: string, callId: string,
  args: Record<string, unknown>, work: () => T): T {
  const task = { ...identity, acceptedTaskId: logical.acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq) };
  const root = authorities.acceptedTurnCallAuthorityFor(identity.sessionId, identity.sourceUserSeq);
  assert.equal(root.status, 'ok');
  if (root.status !== 'ok') throw new Error('Fixture host root is unavailable.');
  const contract = contracts.durableLogicalCallContract(task.acceptedTaskId, name, args);
  assert.ok(contract);
  const effect = classifyRuntimeToolEffect(name, args).effect;
  const base = { sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId, sourceEventId: root.authority.sourceEventId,
    sourceEventDigest: root.authority.sourceEventDigest, logicalToolCallId: callId,
    toolName: contract.toolName, argumentDigest: contract.argumentDigest, effect,
    bindingKind: 'local_envelope' as const, capabilityId: `cap:${name}`,
    schemaFingerprint: digest(`fixture-local:${name}`), accountId: '', invokePortId: 'fixture:local',
    operationId: name, manifestId: '', manifestDigest: '',
    engineVersion: root.authority.engineVersion, surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest, authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest, catalogRevisionDigest: root.authority.catalogRevisionDigest!,
    bindingRevisionDigest: root.authority.bindingRevisionDigest! };
  return authorities.withHostCallAttestation({ ...base, bindingDigest: hostBindings.hostCallAttestationBindingDigest(base) }, work);
}

async function invoke(identity: Identity, name: string, callId: string, args: Record<string, unknown>) {
  const task = { ...identity, acceptedTaskId: logical.acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq) };
  return await attested(identity, name, callId, args, () => logical.withLogicalToolCall({ ...identity, tool: name, logicalToolCallId: callId, args }, async () => {
    const lease = leases.activateDispatchLease({ sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq, acceptedTaskId: task.acceptedTaskId, logicalToolCallId: callId, scopeId: `clarification-memory:${callId}`, recovery: { effect: classifyRuntimeToolEffect(name, args).effect, businessCall: true, material: contracts.durableLogicalCallRecoveryMaterial(task.acceptedTaskId, name, args)!, turn: identity.turn } });
    try { return await leases.runWithDispatchLease(lease, () => toolContext.withToolOutputContext({ ...identity, callId, toolName: name }, async () => {
        const opened = dispatch.beginPhysicalDispatch({ identity: { ...task, logicalToolCallId: callId, physicalDispatchId: `dispatch:${callId}`, ordinal: 0 }, tool: name, args, executionSite: 'host' });
        assert.equal(opened.status, 'inserted', JSON.stringify(opened));
        if (opened.status !== 'inserted') throw new Error('fixture dispatch');
        const result = await handlers.get(name)!(args);
        assert.equal(dispatch.settlePhysicalDispatch({ identity: opened.identity, tool: name, outcome: 'returned' }).status, 'inserted');
        const committed = settlements.commitLogicalCallSettlement({ identity: { ...task, logicalToolCallId: callId }, contract: { toolName: name, args }, execution: { kind: 'local_execution' }, result: { payload: result },
          outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: !result.isError }), recovery: { businessCall: true, mutating: name === 'memory_remember' }, observer: { lane: 'byo', turn: identity.turn } });
        assert.equal(committed.status, 'committed', JSON.stringify(committed));
        return result;
      }));
    } finally { leases.revokeDispatchLease(lease); }
  }));
}
async function fixture(options: { answerText?: string; disposition?: 'selected' | 'provided' | 'affirmed' | 'declined' | 'declined_with_new_task'; parentData?: Record<string, unknown>; parentSteering?: boolean; answerProjectChange?: boolean; parentRead?: boolean } = {}) {
  const disposition = options.disposition ?? 'selected';
  const answerText = options.answerText ?? (disposition === 'affirmed' ? 'Yes' : disposition === 'provided' ? 'Set the saved B cutoff to 20.' : disposition.startsWith('declined') ? 'No' : '20');
  const id = ++serial;
  const sessionId = `clarification-memory-${id}`;
  events.createSession({ id: sessionId, kind: 'chat' });
  const made = projects.createProject({ name: `Clarification Memory ${id}`, context: 'Named synthetic framework fixture.' });
  assert.ok(made.ok); if (!made.ok) throw new Error('fixture project');
  assert.ok(setSessionProject(sessionId, made.project.id, { by: 'owner' }).ok);
  const scope = { projectId: made.project.id, agentKey: null };
  const a = facts.rememberFact({ kind: 'project', content: `Fixture ${id}: A heading SILVER ORBIT.`, scope });
  const b = facts.rememberFact({ kind: 'project', content: `Fixture ${id}: B cutoff 5; keep its footer unchanged.`, scope });
  const parentText = 'Change A heading to SILVER ORBIT now. Replace the saved B cutoff after asking me to choose 10 or 20. Preserve A and every unrelated clause.';
  const parent = accepted(sessionId, parentText, options.parentData);
  if (options.parentSteering) {
    const note = events.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_steer_note', data: { text: 'Actually use a different requested cutoff.' } });
    events.appendEvent({ sessionId, turn: 1, role: 'system', type: 'user_steer_note_delivered', data: { noteSeqs: [note.seq] } });
  }
  const parentIdentity = { sessionId, sourceUserSeq: parent.seq, turn: 1 };
  const priorReadId = `read-parent-B-${id}`;
  if (options.parentRead) {
    arm(parentIdentity);
    const read = await invoke(parentIdentity, 'memory_read', priorReadId, { target: `fact:${b.id}` });
    assert.equal(JSON.parse(read.content[0]!.text).observation.id, b.id);
  }
  const question = disposition === 'affirmed' ? 'A heading is SILVER ORBIT. Set the saved B cutoff to 20?' : 'A heading is SILVER ORBIT. Which cutoff should replace B: 10 or 20?';
  events.appendEvent({ sessionId, turn: 1, role: 'Clem', type: 'awaiting_user_input', data: { question, options: ['10', '20'], purpose: 'clarification', sourceUserSeq: parent.seq } });
  commitTurnOutcome({ version: 2, id: turnOutcomeId(parentIdentity), identity: parentIdentity, status: 'needs_input', resumable: true, needs: { kind: 'input' }, presentation: { kind: 'question', text: question } });
  const pending = continuity.peekTaskContinuityPacket({ sessionId });
  assert.equal(pending.status, 'available'); if (pending.status !== 'available') throw new Error('fixture question');
  if (options.answerProjectChange) {
    const other = projects.createProject({ name: `Other clarification project ${id}` });
    assert.ok(other.ok); if (!other.ok) throw new Error('fixture other project');
    assert.ok(setSessionProject(sessionId, other.project.id, { by: 'owner' }).ok);
  }
  const answer = accepted(sessionId, answerText);
  const slot = pending.packet.pause.slot!;
  const raw = { version: 1, relation: 'answer_open_slot', targetGoal: { goalId: slot.goalId, baseRevision: slot.revision }, goal: null, work: null,
    slotAnswers: [disposition === 'selected' ? { kind: 'option', questionId: slot.questionId, slotKey: slot.slotKey, optionId: 'opt-2' } : { kind: 'value', questionId: slot.questionId, slotKey: slot.slotKey, value: answerText }], rationale: 'Exact second option selected.' };
  const db = events.openEventLog();
  db.prepare(`INSERT OR REPLACE INTO turn_semantics_dispositions (session_id,source_user_seq,participation,outcome,created_at) VALUES (?,?,'participated','admitted',?)`).run(sessionId, answer.seq, new Date().toISOString());
  const reading = events.appendEvent({ sessionId, turn: 1, role: 'system', type: 'turn_semantics_interpreted', data: { purpose: 'turn_semantics', sourceUserSeq: answer.seq, inputHash: 'a', audienceHash: 'b', policyRevision: 'c', validationOutcome: 'admitted', raw } });
  db.prepare(`INSERT INTO turn_semantics_claims (session_id,source_user_seq,owner,created_at,event_id,input_hash,audience_hash,policy_revision) VALUES (?,?,'test',?,?,'a','b','c')`).run(sessionId, answer.seq, new Date().toISOString(), reading.id);
  runtime._setClarificationAnswerCompletenessForTests(input => revision.checkClarificationAnswerCompleteness(input, async () => ({ ok: true, model: 'fixture-jev', answers: { complete_answer: { type: 'noul', noul: 0.99 } }, usage: { input_tokens: 10, output_tokens: 1 }, decisionId: 'fixture-completeness' })));
  try {
    assert.equal((await runtime.classifyUnsettledOpenQuestionReply({ sessionId, sourceUserSeq: answer.seq }))?.route, 'settled');
    const enriched = await runtime.enrichAcceptedRequestWithTaskContinuity({ sessionId, message: answerText }, answer.seq,
      { continuationOnly: true, resolveCandidates: false, typedClassification: { disposition, ...(disposition === 'selected' ? { selectedOption: 'opt-2' } : {}), ...(disposition === 'declined_with_new_task' ? { activeTaskInput: 'Write an unrelated short poem.' } : {}) } });
    assert.equal(enriched.taskContinuation?.disposition, disposition);
    assert.ok(runtime.rehydrateConsumedClarificationContext({ sessionId, sourceUserSeq: answer.seq, answer: answerText }));
  } finally { runtime._setClarificationAnswerCompletenessForTests(null); }
  const identity = { sessionId, sourceUserSeq: answer.seq, turn: 1 }; arm(identity);
  return { identity, parent, answer, parentText, question, priorReadId, packetId: pending.packet.packetId, scope, a, b };
}

test('verified clarification memory handoff reaches registered correction for the selected outstanding target', async () => {
  reviews.length = 0;
  const f = await fixture();
  const beforeA = factState.readFactObservation(f.a.id);
  const readCallId = `read-B-${serial}`;
  const read = await invoke(f.identity, 'memory_read', readCallId, { target: `fact:${f.b.id}` });
  const observation = JSON.parse(read.content[0]!.text).observation;
  assert.equal(observation.active, true);
  assert.deepEqual(observation.scope, f.scope);
  const result = await invoke(f.identity, 'memory_remember', `correct-B-${serial}`, { kind: 'project', content: observation.content.replace('cutoff 5', 'cutoff 20'), correct: { readCallId, expectedDigest: observation.digest, edits: [{ before: 'cutoff 5', after: 'cutoff 20' }] } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const correction = JSON.parse(result.content[0]!.text);
  assert.equal(correction.status, 'corrected');
  assert.equal(correction.currentStateMatches, true);
  assert.equal(correction.proof.before.id, f.b.id);
  assert.equal(correction.proof.after.content, observation.content.replace('cutoff 5', 'cutoff 20'));
  assert.deepEqual(factState.readFactObservation(f.a.id), beforeA);
  assert.equal(reviews.length, 1, 'one existing semantic correction review, not a new review loop');
});

async function correctB(f: Awaited<ReturnType<typeof fixture>>, suffix = '') {
  const readCallId = `read-B-${serial}${suffix}`;
  const read = await invoke(f.identity, 'memory_read', readCallId, { target: `fact:${f.b.id}` });
  const observation = JSON.parse(read.content[0]!.text).observation;
  const correct = { readCallId, expectedDigest: observation.digest, edits: [{ before: 'cutoff 5', after: 'cutoff 20' }] };
  const args = { kind: 'project', content: observation.content.replace('cutoff 5', 'cutoff 20'), correct };
  const result = await invoke(f.identity, 'memory_remember', `correct-B-${serial}${suffix}`, args);
  return { result, correct, args, observation };
}

for (const disposition of ['selected', 'provided', 'affirmed'] as const) test(`verified clarification memory handoff preserves current owner and whole objective for ${disposition}`, async () => {
  const f = await fixture({ disposition });
  const source = memory.readMemoryRequirementSource(f.identity);
  assert.ok(source);
  assert.equal(source.ownerText, f.answer.data.text);
  assert.equal(source.sourceEventId, f.answer.id);
  assert.equal(source.acceptedTaskId, logical.acceptedTaskIdFor(f.identity.sessionId, f.answer.seq));
  assert.equal(source.objective, host.acceptedObjectiveForSource(f.identity));
  assert.ok(source.objective.includes(f.parentText));
  assert.equal(memory.readMemoryRequirementSource(f.identity, String(f.answer.data.text)), null, 'answer-only is not the complete objective');
  assert.equal(source.clarification?.resolution.disposition, disposition);
  assert.deepEqual(source.clarification?.messages.map(row => row.role), ['user', 'assistant', 'user']);
  assert.deepEqual(source.clarification?.messages.filter(row => row.role === 'user').map(row => row.text), [f.parentText, f.answer.data.text]);
  events.closeEventLog(); memoryDb.closeMemoryDb();
  assert.deepEqual(memory.readMemoryRequirementSource(f.identity, source.objective), source, 'historical consume reopens without a new clock expiry or new source');
});

for (const variation of ['declined', 'declined_with_new_task', 'plan', 'execute', 'steering', 'noticing', 'different-project'] as const) test(`verified clarification memory handoff refuses ${variation} inheritance`, async () => {
  const f = await fixture({
    ...(variation === 'declined' || variation === 'declined_with_new_task' ? { disposition: variation } : {}),
    ...(variation === 'plan' ? { parentData: { taskMode: { version: 1, kind: 'plan' } } } : {}),
    ...(variation === 'execute' ? { parentData: { taskMode: { version: 1, kind: 'execute', executeRef: { planId: 'controlled-plan', revision: 1, digest: 'a'.repeat(64) } } } } : {}),
    ...(variation === 'noticing' ? { parentData: { noticingApprovedTask: { version: 1 } } } : {}),
    ...(variation === 'steering' ? { parentSteering: true } : {}),
    ...(variation === 'different-project' ? { answerProjectChange: true } : {}),
  });
  assert.equal(memory.readMemoryRequirementSource(f.identity), null);
  const before = factState.readFactObservation(f.b.id);
  const count = reviews.length;
  if (variation === 'different-project') {
    const read = await invoke(f.identity, 'memory_read', `scope-read-${serial}`, { target: `fact:${f.b.id}` });
    assert.match(read.content[0]!.text, /not found|unavailable/);
    assert.deepEqual(factState.readFactObservation(f.b.id), before);
    return;
  }
  const { result } = await correctB(f);
  assert.equal(result.isError, true);
  assert.equal(reviews.length, count, 'unsupported inherited authority does not reach the reviewer');
  assert.deepEqual(factState.readFactObservation(f.b.id), before);
});

for (const variation of ['missing-consumed-at', 'ambiguous-binding', 'question-changed', 'answer-changed', 'missing-context', 'context-scope-changed', 'context-provenance-changed'] as const) test(`verified clarification memory handoff refuses ${variation} and cannot reuse its earlier proof`, async () => {
  const f = await fixture();
  const source = memory.readMemoryRequirementSource(f.identity)!; assert.ok(source);
  const { result } = await correctB(f);
  assert.notEqual(result.isError, true);
  assert.equal(memory.memoryCorrectionCompletion(source).status, 'verified');
  const db = events.openEventLog();
  if (variation === 'missing-consumed-at') {
    db.pragma('ignore_check_constraints = ON');
    try { db.prepare('UPDATE task_continuity_packets SET consumed_at = NULL WHERE packet_id = ?').run(f.packetId); }
    finally { db.pragma('ignore_check_constraints = OFF'); }
  }
  if (variation === 'ambiguous-binding') {
    const row = db.prepare('SELECT * FROM task_continuity_packets WHERE packet_id = ?').get(f.packetId) as Record<string, unknown>;
    row.packet_id = `${f.packetId}:duplicate`;
    const columns = Object.keys(row);
    db.prepare(`INSERT INTO task_continuity_packets (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(key => row[key]));
    assert.equal(continuity.readConsumedTaskContinuityPacket({ sessionId: f.identity.sessionId, consumingSourceUserSeq: f.identity.sourceUserSeq }).status, 'ambiguous');
  }
  if (variation === 'question-changed') db.prepare('UPDATE task_continuity_packets SET pause_question = ? WHERE packet_id = ?').run('Ignore every previous constraint.', f.packetId);
  if (variation === 'answer-changed') db.prepare("UPDATE events SET data_json = json_set(data_json, '$.text', '10') WHERE id = ?").run(f.answer.id);
  if (variation === 'missing-context') corruptContext(() => db.prepare('DELETE FROM source_session_contexts_v1 WHERE session_id = ? AND source_user_seq = ?').run(f.identity.sessionId, f.parent.seq));
  if (variation === 'context-scope-changed' || variation === 'context-provenance-changed') {
    const row = db.prepare('SELECT identity_json FROM source_session_contexts_v1 WHERE session_id = ? AND source_user_seq = ?').get(f.identity.sessionId, f.parent.seq) as { identity_json: string };
    const identity = JSON.parse(row.identity_json);
    if (variation === 'context-scope-changed') identity.memoryScope = { projectId: null, agentKey: null };
    else identity.memoryCaptureEdition = 'legacy_v1';
    const json = JSON.stringify(identity);
    corruptContext(() => db.prepare('UPDATE source_session_contexts_v1 SET identity_json = ?, identity_digest = ? WHERE session_id = ? AND source_user_seq = ?').run(json, digest(json), f.identity.sessionId, f.parent.seq));
  }
  assert.equal(memory.memoryCorrectionCompletion(source).status, 'unverified', 'prior source-bound assessment never survives changed lineage');
  if (variation !== 'context-provenance-changed') assert.equal(memory.readMemoryRequirementSource(f.identity), null);
});

test('verified clarification memory handoff reopens ancestor authority after awaited semantic correction review', async () => {
  const f = await fixture();
  const before = factState.readFactObservation(f.b.id);
  let changed = false;
  reviewHook = () => { corruptContext(() => events.openEventLog().prepare('DELETE FROM source_session_contexts_v1 WHERE session_id = ? AND source_user_seq = ?').run(f.identity.sessionId, f.parent.seq)); changed = true; };
  try { const { result } = await correctB(f); assert.equal(result.isError, true); }
  finally { reviewHook = undefined; }
  assert.equal(changed, true, 'fault injection actually crossed the awaited review boundary');
  assert.deepEqual(factState.readFactObservation(f.b.id), before);
});

test('verified clarification memory handoff cannot cite the assistant question as owner consent', async () => {
  const f = await fixture();
  const before = factState.readFactObservation(f.b.id);
  reviewQuote = f.question;
  try { const { result } = await correctB(f); assert.equal(result.isError, true); }
  finally { reviewQuote = undefined; }
  assert.deepEqual(factState.readFactObservation(f.b.id), before);
});

async function report(f: Awaited<ReturnType<typeof fixture>>, corrected: Awaited<ReturnType<typeof correctB>>, full: boolean | 'missing' | 'failed-open' = true) {
  const captured: Array<{ objective: string; reply: string; context: unknown }> = [];
  host._setHostObjectiveJudgeForTests(async (objective, reply, context) => {
    captured.push({ objective, reply, context });
    if (full === 'missing' || full === 'failed-open') return { done: true, reason: 'No fresh typed whole-memory finding.', ...(full === 'failed-open' ? { failedOpen: true, reviewFailure: 'unavailable' as const } : {}) };
    return full ? { done: true, reason: 'The preserved A and corrected B both meet the complete owner request.', memoryRequirement: { version: 1, kind: 'correct', corrections: [corrected.correct], reason: 'B correction is exact and A remains satisfied.' } }
      : { done: false, reason: 'The independent A requirement remains unresolved.', memoryRequirement: { version: 1, kind: 'unresolved', corrections: [], reason: 'A is not fulfilled.' } };
  });
  const reply = full ? 'A heading remains SILVER ORBIT and B cutoff is now 20; unrelated clauses remain unchanged.' : 'B cutoff is now 20.';
  const model = { async getResponse() { return { responseId: `handoff-report-${serial}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply }] }] }; }, async *getStreamedResponse() { const response = await this.getResponse(); yield { type: 'response_started' } as never; yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never; } };
  const prior = catalogs.peekHostCapabilityCatalogFactory(); catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  host.captureEffectiveCompletionPolicyOnce({ ...f.identity, enabled: true });
  try {
    const runner = Object.assign(new EventEmitter(), { run() { throw new Error('Legacy runner must not execute.'); } });
    const outcome = await brackets.withHarnessRunContext({ ...f.identity, counter: new brackets.ToolCallsCounter(20) }, () => host.hostRunRunner(runner as never, { model, tools: [] } as never, [{ role: 'user', content: f.answer.data.text }] as never, { maxTurns: 4, hostTurnEngine: 'host_v1', hostJudgeCompletion: true, context: f.identity } as never));
    return { outcome, captured };
  } finally { host._setHostObjectiveJudgeForTests(null); catalogs.installHostCapabilityCatalogFactory(prior); }
}
for (const full of [true, false]) test(`verified clarification memory handoff ${full ? 'completes' : 'holds'} the full A plus B host objective`, async () => {
  const f = await fixture(); const corrected = await correctB(f);
  assert.notEqual(corrected.result.isError, true);
  const result = await report(f, corrected, full);
  assert.ok(result.captured.length > 0, JSON.stringify(result.outcome));
  assert.ok(result.captured.every(row => row.objective === host.acceptedObjectiveForSource(f.identity) && row.objective.includes(f.parentText)));
  assert.ok(result.captured.every(row => (row.context as { memoryRequirementContext?: unknown }).memoryRequirementContext));
  if (full) assert.equal(result.outcome.terminal, undefined, JSON.stringify(result.outcome));
  else { assert.equal(result.outcome.terminal?.status, 'blocked'); assert.equal(events.listEvents(f.identity.sessionId, { types: ['goal_alignment_judged'] }).some(row => row.data.kind === 'completion' && row.data.fulfills === true), false); }
});

// Corrupt only the disposable fixture's retained bytes, then reinstall the
// original immutable-store guards. Production writers cannot make these rows.
function corruptContext(work: () => unknown) {
  const db = events.openEventLog();
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='source_session_contexts_v1'").all() as Array<{name: string; sql: string}>;
  try { for (const row of triggers) db.exec(`DROP TRIGGER "${row.name}"`); work(); }
  finally { for (const row of triggers) db.exec(row.sql); }
}

for (const unavailable of ['missing', 'failed-open'] as const) test(`verified clarification memory handoff cannot complete from prewrite alone after ${unavailable} review`, async () => {
  const f = await fixture(); const corrected = await correctB(f);
  assert.notEqual(corrected.result.isError, true);
  const result = await report(f, corrected, unavailable);
  assert.ok(result.captured.length > 0);
  assert.equal(result.outcome.terminal?.status, 'blocked');
  assert.equal(events.listEvents(f.identity.sessionId, { types: ['goal_alignment_judged'] }).some(row => row.data.kind === 'completion' && row.data.fulfills === true), false);
});

test('verified clarification memory handoff cannot redeem a read from the prior source', async () => {
  const f = await fixture({ parentRead: true });
  const before = factState.readFactObservation(f.b.id)!;
  const n = reviews.length;
  const result = await invoke(f.identity, 'memory_remember', `prior-read-correction-${serial}`, { kind: 'project', content: before.content.replace('cutoff 5', 'cutoff 20'), correct: { readCallId: f.priorReadId, expectedDigest: before.digest, edits: [{ before: 'cutoff 5', after: 'cutoff 20' }] } });
  assert.match(result.content[0]!.text, /memory_read.*this request/);
  assert.equal(reviews.length, n);
  assert.deepEqual(factState.readFactObservation(f.b.id), before);
});

test('verified clarification memory handoff rechecks the canonical target after its semantic review', async () => {
  const f = await fixture();
  let changed = false;
  reviewHook = () => { memoryDb.openMemoryDb().prepare('UPDATE consolidated_facts SET active = 0 WHERE id = ?').run(f.b.id); changed = true; };
  try { const { result } = await correctB(f); assert.equal(result.isError, true); }
  finally { reviewHook = undefined; }
  assert.equal(changed, true);
  assert.equal(factState.readFactObservation(f.b.id)?.supersededByFactId, null, 'no new replacement was created from a stale current target');
});
