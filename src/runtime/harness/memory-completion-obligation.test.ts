import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-completion-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.CLEMMY_EMBED_AT_WRITE = 'off';
mkdirSync(path.join(home, 'state'), { recursive: true });
writeFileSync(path.join(home, 'state', 'machine-id'), 'memory-completion-test\n');
const events = await import('./eventlog.js');
const host = await import('./host-turn-runner.js');
const brackets = await import('./brackets.js');
const context = await import('./source-session-context.js');
const memory = await import('./memory-completion-obligation.js');
const facts = await import('../../memory/facts.js');
const factState = await import('../../memory/fact-correction.js');
const scope = await import('../../memory/memory-scope.js');
const memoryDb = await import('../../memory/db.js');
const dispatch = await import('./dispatch-ledger.js');
const settlements = await import('./logical-call-settlement-store.js');
const outcomes = await import('./attempt-outcome.js');
const { actionTopologyRoleFor } = await import('../../tools/tool-registry.js');
const { classifyRuntimeToolEffect } = await import('./tool-effect.js');
const authorities = await import('./accepted-turn-call-authority.js');
const hostBindings = await import('./host-call-capability-binding.js');
const contracts = await import('./logical-call-contract.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const logical = await import('./attempt-identity.js');
const leases = await import('./dispatch-lease.js');
const toolContext = await import('./tool-output-context.js');
const correctionTool = await import('./memory-correction-tool.js');

after(() => {
  host._setHostObjectiveJudgeForTests(null);
  memoryDb.closeMemoryDb(); events.closeEventLog();
  rmSync(home, { recursive: true, force: true });
});
let serial = 0;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const ownerText = 'Replace my saved report heading HAZEL RIDGE with LILAC GROVE. Keep the separate footer convention unchanged.';
function source(text = ownerText) {
  const session = events.createSession({ id: `memory-obligation-${++serial}`, kind: 'chat' });
  const event = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  const identity = { sessionId: session.id, sourceUserSeq: event.seq, turn: 1 };
  assert.ok(context.captureFreshSourceSessionContext(identity));
  // These are host-owned retained local calls followed by a tool-free reporting
  // entry. A turn-graph shadow would instead reserve the source for the typed
  // executor and correctly prevent host_v1 from entering before any model call.
  const frozenCatalogDigest = digest(JSON.stringify({ entries: [], version: 1 }));
  const armed = authorities.armHostCallAuthority({ ...identity,
    catalogRevisionDigest: digest(JSON.stringify({ envelopeDigest: null, frozenCatalogDigest, sealedUniverse: [], version: 1 })),
    bindingRevisionDigest: digest(JSON.stringify({ attemptId: session.id, envelopeDigest: null, frozenCatalogDigest, version: 1 })),
    maxLogicalCalls: 20, maxParallelCalls: 8 });
  assert.equal(armed.status, 'armed', JSON.stringify(armed));
  const retained = memory.readMemoryRequirementSource(identity);
  assert.ok(retained);
  return { ...identity, retained };
}
function attested<T>(identity: ReturnType<typeof source>, name: string, callId: string,
  args: Record<string, unknown>, work: () => T): T {
  const task = { ...identity, acceptedTaskId: identity.retained.acceptedTaskId };
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
function settle(identity: ReturnType<typeof source>, name: string, callId: string,
  payload: unknown | (() => unknown), args: Record<string, unknown> = {}) {
  const task = { ...identity, acceptedTaskId: identity.retained.acceptedTaskId };
  return attested(identity, name, callId, args, () => {
    const opened = dispatch.beginPhysicalDispatch({
      identity: { ...task, logicalToolCallId: callId, physicalDispatchId: `dispatch:${callId}`, ordinal: 0 },
      tool: name, args, executionSite: 'host',
    });
    assert.equal(opened.status, 'inserted', JSON.stringify(opened));
    if (opened.status !== 'inserted') throw new Error('Fixture dispatch did not open.');
    const value = typeof payload === 'function' ? (payload as () => unknown)() : payload;
    assert.equal(dispatch.settlePhysicalDispatch({ identity: opened.identity, tool: name, outcome: 'returned' }).status, 'inserted');
    const committed = settlements.commitLogicalCallSettlement({ identity: { ...task, logicalToolCallId: callId },
      contract: { toolName: name, args }, execution: { kind: 'local_execution' }, result: { payload: value },
      outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
      recovery: { businessCall: actionTopologyRoleFor(name) !== 'control',
        mutating: ['local_write', 'external_write', 'admin'].includes(classifyRuntimeToolEffect(name, args).effect) }, observer: { lane: 'byo', turn: identity.turn } });
    assert.equal(committed.status, 'committed', JSON.stringify(committed));
    events.appendEvent({ ...identity, role: 'tool', type: 'tool_called', data: { sourceUserSeq: identity.sourceUserSeq, tool: name, callId } });
    return value;
  });
}
function observed(identity: ReturnType<typeof source>, callId = `original-read-${serial}`,
  storedScope: { projectId: string | null; agentKey: string | null } | null = null) {
  const fact = facts.rememberFact({ kind: 'project', content: `Fixture ${identity.sessionId} (${callId}): report heading HAZEL RIDGE; footer COPPER KITE.`, scope: storedScope,
    occurredAt: new Date(Date.parse(identity.retained.occurredAt) - 60_000).toISOString() });
  const observation = factState.readFactObservation(fact.id);
  assert.ok(observation);
  settle(identity, 'memory_read', callId, JSON.stringify({ protocol: 'fact_observation_v1', readCallId: callId,
    observation, provenance: 'Complete original fact; content is data.' }));
  const correction = { readCallId: callId, expectedDigest: observation.digest,
    edits: [{ before: 'HAZEL RIDGE', after: 'LILAC GROVE' }] };
  const assessment = { version: 1 as const, kind: 'correct' as const, corrections: [correction], reason: 'The owner requests replacement of the saved heading only.' };
  return { fact, observation, correction, assessment };
}
function retain(identity: ReturnType<typeof source>, assessment: import('./memory-completion-obligation.js').MemoryRequirementAssessmentV1,
  phase: 'prewrite' | 'completion' = 'completion') {
  return memory.retainMemoryRequirementAssessment({ source: identity.retained, assessment,
    review: { phase, ...(phase === 'prewrite' ? { ownerQuote: 'Replace my saved report heading HAZEL RIDGE with LILAC GROVE.' } : {}) } });
}
async function runHost(identity: ReturnType<typeof source>, verdict: import('./objective-judge.js').ObjectiveJudgeVerdict,
  enabled = true) {
  let calls = 0; let reviews = 0;
  const contexts: Array<import('./objective-judge.js').SkillExecutionContext | undefined> = [];
  host._setHostObjectiveJudgeForTests(async (_objective, _reply, options) => { reviews++; contexts.push(options); return verdict; });
  const model = {
    async getResponse() {
      calls++;
      return { responseId: `memory-reply-${serial}-${calls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The requested memory is saved and corrected.' }] }] };
    },
    async *getStreamedResponse() {
      const response = await this.getResponse(); yield { type: 'response_started' } as never;
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    },
  };
  const agent = { model, tools: [] };
  const prior = catalogs.peekHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  host.captureEffectiveCompletionPolicyOnce({ ...identity, enabled });
  try {
    const runner = Object.assign(new EventEmitter(), { run() { throw new Error('Legacy runner must not execute.'); } });
    const outcome = await brackets.withHarnessRunContext({ ...identity, counter: new brackets.ToolCallsCounter(20) }, () =>
      host.hostRunRunner(runner as never, agent as never,
        [{ type: 'message', role: 'user', content: identity.retained.ownerText }] as never,
        { maxTurns: 4, hostTurnEngine: 'host_v1', hostJudgeCompletion: enabled, context: identity } as never));
    return { outcome, calls, reviews, contexts };
  } finally { host._setHostObjectiveJudgeForTests(null); catalogs.installHostCapabilityCatalogFactory(prior); }
}

test('memory review packet is structural and never inferred from verdict prose', () => {
  const packet = { version: 1, kind: 'none', corrections: [], reason: 'Only recall was requested.' };
  assert.deepEqual(memory.parseMemoryRequirementPacket(`DONE: Recalled.\nMEMORY_REQUIREMENT: ${JSON.stringify(packet)}`), packet);
  for (const output of ['DONE: I corrected the fact.', `DONE: ok\nMEMORY_REQUIREMENT: ${JSON.stringify({ ...packet, kind: 'correct' })}`,
    `MEMORY_REQUIREMENT: ${JSON.stringify(packet)}\nMEMORY_REQUIREMENT: ${JSON.stringify(packet)}`,
    `MEMORY_REQUIREMENT: ${JSON.stringify({ ...packet, fulfilled: true })}`]) assert.equal(memory.parseMemoryRequirementPacket(output), null);
});

test('source authority excludes incidental caller fields', () => {
  const identity = source();
  assert.deepEqual(memory.readMemoryRequirementSource({ ...identity, runId: 'incidental-run' } as typeof identity), identity.retained);
  assert.equal('turn' in identity.retained, false);
  assert.equal('runId' in identity.retained, false);
});

test('retained correction survives reopen, generic save and changed reviewer phrasing', () => {
  const identity = source(); const fixture = observed(identity);
  const first = retain(identity, fixture.assessment);
  assert.equal(memory.findRetainedCorrectionAssessment(identity.retained, fixture.correction), null, 'completion is not prewrite authorization');
  events.closeEventLog();
  assert.equal(memory.readRetainedMemoryRequirement(identity.retained)?.assessmentDigest, first.assessmentDigest);
  assert.throws(() => retain(identity, { version: 1, kind: 'retain', corrections: [], reason: 'Another fact was saved.' }), /cannot be waived/);
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'unverified');
  const repeatId = `repeat-read-${serial}`;
  settle(identity, 'memory_read', repeatId, JSON.stringify({ protocol: 'fact_observation_v1', readCallId: repeatId,
    observation: fixture.observation, provenance: 'The same complete original observation.' }));
  const repeated = { ...fixture.assessment, corrections: [{ ...fixture.correction, readCallId: repeatId }], reason: 'Different explanation.' };
  const approved = retain(identity, repeated, 'prewrite');
  assert.equal(approved.assessmentDigest, first.assessmentDigest, 'same target state and exact edits, not call id or reason, own identity');
  assert.equal(memory.findRetainedCorrectionAssessment(identity.retained, repeated.corrections[0]!)?.assessmentDigest, first.assessmentDigest);
  const other = source();
  assert.throws(() => retain(other, fixture.assessment), /original fact/);
});

test('actual host rejects generic save plus active new fact as a correction despite DONE', async () => {
  const identity = source(); const fixture = observed(identity);
  const duplicate = facts.rememberFact({ kind: 'project', content: fixture.observation.content.replace('HAZEL RIDGE', 'LILAC GROVE'), scope: null });
  settle(identity, 'memory_remember', `generic-save-${serial}`, `Saved fact ${duplicate.id}.`);
  const result = await runHost(identity, { done: true, reason: 'The new fact is active.', memoryRequirement: fixture.assessment });
  assert.equal(result.outcome.terminal?.status, 'blocked');
  assert.equal(result.outcome.terminal?.reason, 'memory_correction_unverified');
  assert.ok(result.contexts.every(row => row?.memoryRequirementContext));
  assert.ok(result.calls <= 3, 'existing finite repair budget is preserved');
  assert.equal(factState.readFactObservation(fixture.fact.id)?.active, true, 'validation never repairs live memory implicitly');
  assert.equal(factState.readFactObservation(duplicate.id)?.active, true);
  assert.equal(events.listEvents(identity.sessionId, { types: ['goal_alignment_judged'] })
    .filter(row => row.data.kind === 'completion').some(row => row.data.fulfills === true), false);
});

for (const failedOpen of [false, true]) test(`actual host rejects ${failedOpen ? 'failed-open' : 'missing'} typed memory packet after generic save`, async () => {
  const identity = source();
  settle(identity, 'memory_remember', `generic-unqualified-${serial}`, 'Saved a new fact.');
  const result = await runHost(identity, { done: true, reason: 'Saved.', ...(failedOpen ? { failedOpen: true, reviewFailure: 'unavailable' as const } : {}) });
  assert.equal(result.outcome.terminal?.status, 'blocked');
  assert.equal(result.outcome.terminal?.reason, 'memory_correction_unverified');
  assert.ok(result.calls > 0 && result.reviews > 0, 'the actual completion boundary was reached');
  if (failedOpen) assert.equal(result.calls, 1, 'unavailable reviewer adds no repair turns');
  assert.equal(memory.readRetainedMemoryRequirement(identity.retained), null);
});

test('ordinary memory save with disabled review and background memory read keep existing policy', async () => {
  const saved = source('Keep my preferred heading for later.');
  settle(saved, 'memory_remember', `ordinary-save-${serial}`, 'Saved the requested preference.');
  const off = await runHost(saved, { done: true, reason: 'unused' }, false);
  assert.equal(off.reviews, 0); assert.equal(off.outcome.terminal, undefined);
  assert.equal(memory.readRetainedMemoryRequirement(saved.retained), null, 'disabled review is not a typed acceptance');
  const recall = source('Answer from the context already available.');
  settle(recall, 'memory_read', `background-read-${serial}`, 'Background context only.');
  assert.equal(memory.sourceHasMemoryToolActivity(recall), false);
  const normal = await runHost(recall, { done: true, reason: 'Ordinary reviewed answer.' });
  assert.equal(normal.outcome.terminal, undefined);
  assert.ok(normal.contexts.every(row => row?.memoryRequirementContext === undefined));
});

test('standalone forget, pin and restore keep their ordinary administration review', async () => {
  for (const name of ['memory_forget', 'memory_pin', 'memory_restore']) {
    const identity = source(`Perform the requested ${name} administration of the selected saved fact.`);
    settle(identity, name, `administration-${serial}`, 'The requested administration completed.');
    assert.equal(memory.sourceHasMemoryToolActivity(identity), false);
    const result = await runHost(identity, { done: true, reason: 'The requested administration completed.' });
    assert.equal(result.outcome.terminal, undefined);
    assert.ok(result.contexts.every(row => row?.memoryRequirementContext === undefined));
  }
});

test('exact correction proof closes retained obligation with reordered edits and reopen/drift cannot repeat the effect', async () => {
  const identity = source(ownerText + ' Also replace the stored word Fixture with Record.'); const fixture = observed(identity);
  const toolEdits = [{ before: 'Fixture', after: 'Record' }, ...fixture.correction.edits];
  fixture.correction.edits = [...toolEdits].reverse();
  const retained = retain(identity, fixture.assessment, 'prewrite');
  const callId = `bound-correction-${serial}`;
  const args = { content: fixture.observation.content.replace('Fixture', 'Record').replace('HAZEL RIDGE', 'LILAC GROVE'), kind: 'project',
    correct: { ...fixture.correction, edits: toolEdits } };
  assert.equal(memory.findRetainedCorrectionAssessment(identity.retained, args.correct)?.assessmentDigest, retained.assessmentDigest);
  let result: ReturnType<typeof factState.correctFactExact> | undefined;
  settle(identity, 'memory_remember', callId, () => {
    result = factState.correctFactExact({ targetId: fixture.fact.id, expectedObservationDigest: fixture.observation.digest,
      patches: toolEdits, owner: { sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq,
        sourceEventId: identity.retained.sourceEventId, sourceContextDigest: identity.retained.sourceContextDigest,
        logicalToolCallId: callId, argumentsDigest: contracts.durableLogicalCallContract(identity.retained.acceptedTaskId, 'memory_remember', args)!.argumentDigest,
        assessmentDigest: retained.assessmentDigest, ownerText: identity.retained.ownerText, occurredAt: identity.retained.occurredAt } });
    return JSON.stringify({ protocol: 'fact_correction_v1', ...result });
  }, args);
  assert.ok(result && result.status === 'corrected');
  const afterId = result.proof.after.id;
  assert.match(result.proof.after.content, /footer COPPER KITE\.$/);
  assert.deepEqual(result.proof.patches, toolEdits, 'the immutable operation keeps the original tool patch order');
  const count = memoryDb.openMemoryDb().prepare('SELECT COUNT(*) AS n FROM consolidated_facts').get();
  events.closeEventLog(); memoryDb.closeMemoryDb();
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'verified');
  const record = events.openEventLog().prepare('SELECT data_json FROM events WHERE id=?').get(retained.eventId) as { data_json: string };
  const changed = JSON.parse(record.data_json);
  changed.review.phase = 'completion'; delete changed.review.ownerQuote;
  events.openEventLog().prepare('UPDATE events SET data_json=? WHERE id=?').run(JSON.stringify(changed), retained.eventId);
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'unverified', 'an operation alone cannot replace prewrite owner-intent authority');
  changed.review.phase = 'prewrite'; changed.review.ownerQuote = 'A different person authorized this.';
  events.openEventLog().prepare('UPDATE events SET data_json=? WHERE id=?').run(JSON.stringify(changed), retained.eventId);
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'unverified', 'reopen revalidates the original owner quote');
  events.openEventLog().prepare('UPDATE events SET data_json=? WHERE id=?').run(record.data_json, retained.eventId);
  const done = await runHost(identity, { done: true, reason: 'The exact old/new postconditions hold.', memoryRequirement: fixture.assessment });
  assert.equal(done.outcome.terminal, undefined);
  assert.equal(done.calls, 1);
  assert.deepEqual(memoryDb.openMemoryDb().prepare('SELECT COUNT(*) AS n FROM consolidated_facts').get(), count);
  scope.stampMemoryScope('fact', afterId, { projectId: 'different-project', agentKey: null });
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'unverified', 'actual stored scope drift defeats historical success');
  const heldSource = source(); const heldFact = observed(heldSource);
  retain(heldSource, heldFact.assessment);
  const held = await runHost(heldSource, { done: true, reason: 'ignored under disabled review' }, false);
  assert.equal(held.reviews, 0);
  assert.equal(held.outcome.terminal?.status, 'blocked', 'disabled review cannot waive a retained correction');
});


test('two target corrections retain both obligations and redeem each original prewrite grant', () => {
  const identity = source(ownerText + ' Apply the heading replacement to both saved report records.');
  const first = observed(identity, `first-target-${serial}`);
  const second = observed(identity, `second-target-${serial}`);
  assert.notEqual(first.fact.id, second.fact.id);
  const firstGrant = retain(identity, first.assessment, 'prewrite');
  const secondGrant = retain(identity, second.assessment, 'prewrite');
  assert.notEqual(firstGrant.assessmentDigest, secondGrant.assessmentDigest);
  assert.equal(memory.readRetainedMemoryRequirement(identity.retained)?.assessment.corrections.length, 2);
  assert.equal(memory.findRetainedCorrectionAssessment(identity.retained, first.correction)?.assessmentDigest, firstGrant.assessmentDigest);
  assert.equal(memory.findRetainedCorrectionAssessment(identity.retained, second.correction)?.assessmentDigest, secondGrant.assessmentDigest);
  assert.throws(() => retain(identity, first.assessment), /cannot omit/);
  assert.throws(() => retain(identity, { ...first.assessment, corrections: [{ ...first.correction,
    edits: [{ before: 'HAZEL RIDGE', after: 'ANOTHER HEADING' }] }] }, 'prewrite'), /conflicting/);
  assert.equal(memory.readRetainedMemoryRequirement(identity.retained)?.assessment.corrections.length, 2);
  for (const [index, fixture, grant] of [[0, first, firstGrant], [1, second, secondGrant]] as const) {
    const callId = `two-target-${serial}-${index}`;
    const args = { kind: 'project', content: fixture.observation.content.replace('HAZEL RIDGE', 'LILAC GROVE'), correct: fixture.correction };
    settle(identity, 'memory_remember', callId, () => {
      const result = factState.correctFactExact({ targetId: fixture.fact.id, expectedObservationDigest: fixture.observation.digest,
        patches: fixture.correction.edits, owner: { sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq,
          sourceEventId: identity.retained.sourceEventId, sourceContextDigest: identity.retained.sourceContextDigest,
          logicalToolCallId: callId, argumentsDigest: contracts.durableLogicalCallContract(identity.retained.acceptedTaskId, 'memory_remember', args)!.argumentDigest,
          assessmentDigest: grant.assessmentDigest, ownerText: identity.retained.ownerText, occurredAt: identity.retained.occurredAt } });
      assert.equal(result.status, 'corrected');
      return JSON.stringify({ protocol: 'fact_correction_v1', ...result });
    }, args);
    assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, index === 0 ? 'unverified' : 'verified');
  }
  const completed = retain(identity, { ...first.assessment, corrections: [second.correction, first.correction] });
  assert.equal(completed.assessment.corrections.length, 2);
  events.closeEventLog(); memoryDb.closeMemoryDb();
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'verified', 'both original grants survive an aggregate completion packet and reopen');
});

// Intake names the facts it stores by the accepted source they came from.
function intakeReplacement(identity: ReturnType<typeof source>) {
  const old = facts.rememberFact({ kind: 'project', content: `Fixture ${identity.sessionId}: report heading HAZEL RIDGE.`, scope: null,
    occurredAt: new Date(Date.parse(identity.retained.occurredAt) - 60_000).toISOString() });
  const by = facts.rememberFact({ kind: 'project', content: `Fixture ${identity.sessionId}: report heading LILAC GROVE.`, scope: null,
    sessionId: identity.sessionId, occurredAt: identity.retained.occurredAt,
    sourceUri: `conversation://${encodeURIComponent(identity.sessionId)}/${encodeURIComponent(`auto-capture:user-source:${identity.sourceUserSeq}`)}` });
  assert.equal(facts.markFactSupersededBy(old.id, by.id, { validTo: identity.retained.occurredAt }), true);
  return { old, by };
}
const replacedAssessment = { version: 1 as const, kind: 'replaced' as const, corrections: [],
  reason: 'The owner\'s correction already replaced the saved heading in its scope.' };

test('a correction this request\'s own intake already made completes without a second write', async () => {
  const identity = source('Correction: the report heading is LILAC GROVE, not HAZEL RIDGE.');
  const { old, by } = intakeReplacement(identity);
  assert.deepEqual(memory.intakeReplacementsForSource(identity.retained).map(row => [row.replaced.id, row.by.id]), [[old.id, by.id]]);
  retain(identity, { version: 1, kind: 'unresolved', corrections: [], reason: 'No exact target was bound yet.' });
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'unverified');
  const count = memoryDb.openMemoryDb().prepare('SELECT COUNT(*) AS n FROM consolidated_facts').get();
  const done = await runHost(identity, { done: true, reason: 'The heading change is in effect.', memoryRequirement: replacedAssessment });
  assert.equal(done.outcome.terminal, undefined);
  assert.equal(done.calls, 1);
  assert.match(done.contexts[0]?.memoryRequirementContext ?? '', new RegExp(`"intakeReplacements":\\[\\{"replaced":\\{"id":${old.id},`));
  assert.equal(memory.readRetainedMemoryRequirement(identity.retained)?.assessment.kind, 'replaced');
  assert.deepEqual(memoryDb.openMemoryDb().prepare('SELECT COUNT(*) AS n FROM consolidated_facts').get(), count, 'nothing else was written');
  events.closeEventLog(); memoryDb.closeMemoryDb();
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'verified', 'reopen re-proves it from memory state');
  scope.stampMemoryScope('fact', by.id, { projectId: 'different-project', agentKey: null });
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'unverified', 'a replacement outside the old scope is not the correction');
});

test('a replacement is only this request\'s own intake retiring the old fact', async () => {
  const identity = source('Correction: the report heading is LILAC GROVE, not HAZEL RIDGE.');
  const other = source('Correction: the report heading is LILAC GROVE, not HAZEL RIDGE.');
  intakeReplacement(other);
  const beside = facts.rememberFact({ kind: 'project', content: `Fixture ${identity.sessionId}: heading LILAC GROVE beside an old one.`, scope: null,
    sessionId: identity.sessionId,
    sourceUri: `conversation://${encodeURIComponent(identity.sessionId)}/${encodeURIComponent(`auto-capture:user-source:${identity.sourceUserSeq}`)}` });
  assert.equal(facts.getFact(beside.id)?.active, true);
  assert.deepEqual(memory.intakeReplacementsForSource(identity.retained), [], 'another request\'s replacement and a new fact beside an active old one are not listed');
  assert.throws(() => retain(identity, replacedAssessment), /No replacement made by this request/);
  retain(identity, { version: 1, kind: 'unresolved', corrections: [], reason: 'No exact target was bound yet.' });
  const result = await runHost(identity, { done: true, reason: 'Claimed replaced.', memoryRequirement: replacedAssessment });
  assert.equal(result.outcome.terminal?.status, 'blocked');
  assert.equal(result.outcome.terminal?.reason, 'memory_correction_unverified');
  assert.doesNotMatch(result.outcome.finalOutput ?? '', /memory requirement|bound to its original fact/i, 'the owner reads words, not the review reason');
});

test('a bound correction whose target this request\'s intake retired is complete', () => {
  const identity = source(); const fixture = observed(identity);
  retain(identity, fixture.assessment, 'prewrite');
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'unverified');
  const by = facts.rememberFact({ kind: 'project', content: fixture.observation.content.replace('HAZEL RIDGE', 'LILAC GROVE'), scope: null,
    sessionId: identity.sessionId, occurredAt: identity.retained.occurredAt,
    sourceUri: `conversation://${encodeURIComponent(identity.sessionId)}/${encodeURIComponent(`auto-capture:user-source:${identity.sourceUserSeq}`)}` });
  assert.equal(facts.markFactSupersededBy(fixture.fact.id, by.id, { validTo: identity.retained.occurredAt }), true);
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'verified');
  const kept = retain(identity, replacedAssessment);
  assert.equal(kept.assessment.kind, 'correct', 'the bound correction stays the requirement');
  assert.equal(memory.readRetainedMemoryRequirement(identity.retained)?.assessment.kind, 'correct');
  const unbound = source(); const unboundFixture = observed(unbound);
  retain(unbound, unboundFixture.assessment, 'prewrite');
  assert.throws(() => retain(unbound, replacedAssessment), /No replacement made by this request/);
});

function replaceObservedAtIntake(identity: ReturnType<typeof source>, fixture: ReturnType<typeof observed>,
  content = fixture.observation.content.replace('HAZEL RIDGE', 'LILAC GROVE'), kind: 'project' | 'reference' = 'project') {
  const by = facts.rememberFact({ kind, content, scope: fixture.observation.scope,
    sessionId: identity.sessionId, occurredAt: identity.retained.occurredAt,
    sourceUri: `conversation://${encodeURIComponent(identity.sessionId)}/${encodeURIComponent(`auto-capture:user-source:${identity.sourceUserSeq}`)}` });
  assert.equal(facts.markFactSupersededBy(fixture.fact.id, by.id, { validTo: identity.retained.occurredAt }), true);
  return by;
}

test('a bound correction rejects intake that drops unchanged bytes, changes kind or moves the stored scope', () => {
  for (const variation of ['lost-footer', 'wrong-heading', 'changed-prefix', 'changed-kind', 'moved-scope'] as const) {
    const identity = source(); const fixture = observed(identity);
    retain(identity, fixture.assessment, 'prewrite');
    const expected = fixture.observation.content.replace('HAZEL RIDGE', 'LILAC GROVE');
    const content = variation === 'lost-footer' ? expected.replace('; footer COPPER KITE.', '.')
      : variation === 'wrong-heading' ? expected.replace('LILAC GROVE', 'ANOTHER HEADING')
      : variation === 'changed-prefix' ? expected.replace('Fixture', 'Record') : expected;
    const by = replaceObservedAtIntake(identity, fixture, content, variation === 'changed-kind' ? 'reference' : 'project');
    if (variation === 'moved-scope') {
      // Both rows still agree with each other, which passes the ordinary
      // semantic intake scope check, but disagree with the retained original.
      scope.stampMemoryScope('fact', fixture.fact.id, { projectId: 'moved-project', agentKey: null });
      scope.stampMemoryScope('fact', by.id, { projectId: 'moved-project', agentKey: null });
    }
    assert.equal(memory.intakeReplacementsForSource(identity.retained).some(row => row.replaced.id === fixture.fact.id), true,
      `${variation} reaches the former id-only bypass`);
    const count = memoryDb.openMemoryDb().prepare('SELECT COUNT(*) AS n FROM consolidated_facts').get();
    assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'unverified', variation);
    assert.throws(() => retain(identity, replacedAssessment), /cannot be waived/, variation);
    events.closeEventLog(); memoryDb.closeMemoryDb();
    assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'unverified', `${variation} survives reopen`);
    assert.deepEqual(memoryDb.openMemoryDb().prepare('SELECT COUNT(*) AS n FROM consolidated_facts').get(), count,
      'verification never mints another successor');
  }
});

async function invokeCorrection(identity: ReturnType<typeof source>, args: Parameters<typeof correctionTool.executeMemoryCorrection>[0]) {
  const callId = `manual-intake-check-${serial}`;
  const lease = leases.activateDispatchLease({ sessionId: identity.sessionId, scopeId: `manual:${identity.sessionId}` });
  return attested(identity, 'memory_remember', callId, args, () =>
    logical.withLogicalToolCall({ ...identity, tool: 'memory_remember', logicalToolCallId: callId, args }, () =>
      leases.runWithDispatchLease(lease, () =>
        toolContext.withToolOutputContext({ ...identity, callId, toolName: 'memory_remember' }, () =>
          correctionTool.executeMemoryCorrection(args)))));
}

test('manual correction validates all exact arguments before accepting a matching intake replacement', async () => {
  for (const variation of ['exact', 'read-after-intake', 'content-mismatch', 'invalid-patch', 'scope-move', 'lost-footer', 'moved-scope'] as const) {
    const identity = source();
    const fixture = observed(identity, `manual-read-${serial}`,
      variation === 'scope-move' ? { projectId: 'original-stored-project', agentKey: null } : null);
    const expected = fixture.observation.content.replace('HAZEL RIDGE', 'LILAC GROVE');
    const by = replaceObservedAtIntake(identity, fixture,
      variation === 'lost-footer' ? expected.replace('; footer COPPER KITE.', '.') : expected);
    if (variation === 'moved-scope') {
      scope.stampMemoryScope('fact', fixture.fact.id, { projectId: 'moved-project', agentKey: null });
      scope.stampMemoryScope('fact', by.id, { projectId: 'moved-project', agentKey: null });
    }
    let correction = fixture.correction;
    if (variation === 'read-after-intake') {
      const observation = factState.readFactObservation(fixture.fact.id);
      assert.ok(observation); assert.equal(observation.active, false);
      const readCallId = `retired-read-${serial}`;
      settle(identity, 'memory_read', readCallId, JSON.stringify({ protocol: 'fact_observation_v1', readCallId,
        observation, provenance: 'The original fact was read after this source retired it.' }));
      correction = { ...correction, readCallId, expectedDigest: observation.digest };
    }
    const args = { kind: 'project', content: variation === 'content-mismatch' ? 'A different saved fact.' : expected,
      correct: variation === 'invalid-patch' ? { ...correction, edits: [{ before: 'MISSING TEXT', after: 'LILAC GROVE' }] } : correction,
      ...(variation === 'scope-move' ? { keepFor: 'here' as const } : {}) };
    assert.equal(memory.intakeReplacementsForSource(identity.retained).some(row => row.replaced.id === fixture.fact.id), true,
      `${variation} reaches the former argument-validation bypass`);
    const count = memoryDb.openMemoryDb().prepare('SELECT COUNT(*) AS n FROM consolidated_facts').get();
    if (variation === 'exact' || variation === 'read-after-intake') assert.equal((await invokeCorrection(identity, args)).status, 'already_in_effect');
    else await assert.rejects(scope.withMemoryReadScope('unrestricted', () => invokeCorrection(identity, args)), variation === 'content-mismatch' ? /content must equal/
      : variation === 'invalid-patch' ? /match exactly once/
      : variation === 'scope-move' ? /original stored scope/ : /does not match the exact edited original/, variation);
    assert.deepEqual(memoryDb.openMemoryDb().prepare('SELECT COUNT(*) AS n FROM consolidated_facts').get(), count,
      'a fast-return check neither writes another fact nor enters provider review');
  }
});
