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
const receipts = await import('../../memory/memory-remember-receipt.js');
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
function source(text = ownerText, sameSessionId?: string) {
  const next = ++serial;
  const session = sameSessionId ? { id: sameSessionId } : events.createSession({ id: `memory-obligation-${next}`, kind: 'chat' });
  const turn = sameSessionId ? 2 : 1;
  const event = events.appendEvent({ sessionId: session.id, turn, role: 'user', type: 'user_input_received', data: { text } });
  const identity = { sessionId: session.id, sourceUserSeq: event.seq, turn };
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
function settleExactCorrection(identity: ReturnType<typeof source>, fixture: ReturnType<typeof observed>,
  grant: ReturnType<typeof retain>, callId: string) {
  const args = { kind: 'project', content: fixture.observation.content.replace('HAZEL RIDGE', 'LILAC GROVE'),
    correct: fixture.correction };
  settle(identity, 'memory_remember', callId, () => {
    const result = factState.correctFactExact({ targetId: fixture.fact.id, expectedObservationDigest: fixture.observation.digest,
      patches: fixture.correction.edits, owner: { sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq,
        sourceEventId: identity.retained.sourceEventId, sourceContextDigest: identity.retained.sourceContextDigest,
        logicalToolCallId: callId, argumentsDigest: contracts.durableLogicalCallContract(identity.retained.acceptedTaskId, 'memory_remember', args)!.argumentDigest,
        assessmentDigest: grant.assessmentDigest, ownerText: identity.retained.ownerText, occurredAt: identity.retained.occurredAt } });
    assert.equal(result.status, 'corrected');
    return JSON.stringify({ protocol: 'fact_correction_v1', ...result });
  }, args);
}
async function runHost(identity: ReturnType<typeof source>, verdict: import('./objective-judge.js').ObjectiveJudgeVerdict
  | ((review: number, objective: string, reply: string) => import('./objective-judge.js').ObjectiveJudgeVerdict),
  enabled = true, reply: string | ((call: number) => string) = 'The requested memory is saved and corrected.') {
  let calls = 0; let reviews = 0;
  const contexts: Array<import('./objective-judge.js').SkillExecutionContext | undefined> = [];
  host._setHostObjectiveJudgeForTests(async (objective, reply, options) => {
    reviews++; contexts.push(options);
    return typeof verdict === 'function' ? verdict(reviews, objective, reply) : verdict;
  });
  const model = {
    async getResponse() {
      calls++;
      return { responseId: `memory-reply-${serial}-${calls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: typeof reply === 'function' ? reply(calls) : reply }] }] };
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

test('an explicit supersede the host settled verifies the memory request when the typed packet is missing', async () => {
  // Live 2026-10-21 (a tester): "commit this to memory so every time I ask …"
  // → memory_remember superseded the older rule, three reviews returned no
  // packet, and the turn ended blocked "I could not confirm that your
  // correction replaced what I had saved before". The tool's own receipt
  // names the fact it left active; the host reads storage, not prose.
  const identity = source('Commit this to memory: whenever I ask for my untouched accounts, match the saved report exactly.');
  const older = facts.rememberFact({ kind: 'user', content: `Older untouched-account rule ${serial}: filter by hand.`, scope: null });
  const stored = facts.rememberFact({ kind: 'user', content: `Untouched-account rule ${serial}: match the saved report exactly.`, scope: null,
    sessionId: identity.sessionId });
  settle(identity, 'memory_remember', `explicit-supersede-${serial}`,
    `${receipts.MEMORY_REMEMBER_RECEIPT_PREFIX} ${JSON.stringify({ action: 'supersede', factId: stored.id })}\nSuperseded the prior fact with (user): match the saved report exactly.`);
  assert.deepEqual(memory.explicitRememberStored({ ...identity, acceptedTaskId: identity.retained.acceptedTaskId }), { action: 'supersede', factId: stored.id });
  const result = await runHost(identity, { done: true, reason: 'Saved.', failedOpen: true, reviewFailure: 'unavailable' as const });
  assert.equal(result.outcome.terminal, undefined, JSON.stringify(result.outcome.terminal));
  assert.equal(result.calls, 1, 'no repair turns for a save the host can read');
  assert.equal(factState.readFactObservation(older.id)?.active, true, 'the host verifies; it never retires facts itself');
  // A plain add with no older fact retired is still not a correction.
  const plain = source('Commit this to memory: my untouched accounts come from the saved report.');
  const added = facts.rememberFact({ kind: 'user', content: `Plain rule ${serial}: from the saved report.`, scope: null, sessionId: plain.sessionId });
  settle(plain, 'memory_remember', `explicit-add-${serial}`,
    `${receipts.MEMORY_REMEMBER_RECEIPT_PREFIX} ${JSON.stringify({ action: 'add', factId: added.id })}\nRemembered (user): from the saved report.`);
  assert.deepEqual(memory.explicitRememberStored({ ...plain, acceptedTaskId: plain.retained.acceptedTaskId }), { action: 'add', factId: added.id });
  assert.equal(memory.hostVerifiedMemoryRetention(plain.retained)?.status, undefined, 'an add alone is read through the intake path as before');
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
  assert.equal(kept.assessment.kind, 'replaced', 'the actual completion packet is retained separately from its original grant');
  assert.equal(kept.review.phase, 'completion');
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

async function registeredCorrection(identity: ReturnType<typeof source>, args: Parameters<typeof correctionTool.executeMemoryCorrection>[0]) {
  const { registerMemoryTools } = await import('../../tools/memory-tools.js');
  let handler: ((input: unknown) => Promise<unknown>) | undefined;
  registerMemoryTools({ tool(name: string, ...values: unknown[]) {
    if (name === 'memory_remember') handler = values.at(-1) as (input: unknown) => Promise<unknown>;
  } } as never);
  assert.ok(handler);
  const callId = `registered-correction-${serial}`;
  const lease = leases.activateDispatchLease({ sessionId: identity.sessionId, scopeId: `registered:${identity.sourceUserSeq}` });
  try {
    return await attested(identity, 'memory_remember', callId, args, () =>
      logical.withLogicalToolCall({ ...identity, tool: 'memory_remember', logicalToolCallId: callId, args }, () =>
        leases.runWithDispatchLease(lease, () =>
          toolContext.withToolOutputContext({ ...identity, callId, toolName: 'memory_remember' }, () => handler!(args))))) as
            { content: Array<{ text: string }>; isError?: boolean };
  } finally { leases.revokeDispatchLease(lease); }
}

function correctionMemorySnapshot() {
  return {
    facts: memoryDb.openMemoryDb().prepare('SELECT * FROM consolidated_facts ORDER BY id').all(),
    episodes: memoryDb.openMemoryDb().prepare('SELECT id,kind,subtype,content_hash FROM memory_episodes ORDER BY id').all(),
    evidence: memoryDb.openMemoryDb().prepare('SELECT fact_id,episode_id,ordinal FROM fact_evidence ORDER BY fact_id,episode_id,ordinal').all(),
  };
}

test('registered correction with an earlier source read is a repairable no-effect prerequisite failure', async () => {
  const seed = source('Keep the synthetic report heading and footer for this project.');
  const fixture = observed(seed, `prior-source-read-${serial}`);
  const current = source(ownerText, seed.sessionId);
  assert.equal(current.sessionId, seed.sessionId);
  assert.notEqual(current.sourceUserSeq, seed.sourceUserSeq);
  const { localNonWriteStatus, localNonWriteClassification } = await import('../../tools/shared.js');
  const args = { kind: 'project', content: fixture.observation.content.replace('HAZEL RIDGE', 'LILAC GROVE'), correct: fixture.correction };
  const before = correctionMemorySnapshot();
  const result = await registeredCorrection(current, args);
  assert.deepEqual(correctionMemorySnapshot(), before);
  assert.equal(memory.readRetainedMemoryRequirement(current.retained), null, 'stale read never reaches prewrite review or grants correction');
  assert.equal(localNonWriteStatus(result), 'memory_correction_refused', 'the actual registered tool must retain nominal known-no-effect classification');
  assert.deepEqual(localNonWriteClassification(result), { kind: 'invalid_arguments' }, 'existing argument recovery can reopen the fact in this request');
  const text = result.content[0]!.text;
  assert.match(text, /memory_read.*this request/);
  assert.doesNotMatch(text, /Correction outcome could not be verified/);
});

test('registered correction refuses another current tool as the read without changing memory', async () => {
  const identity = source(); const fixture = observed(identity);
  const readCallId = `wrong-tool-read-${serial}`;
  settle(identity, 'memory_search', readCallId, { facts: [] });
  const before = correctionMemorySnapshot();
  const { localNonWriteStatus, localNonWriteClassification } = await import('../../tools/shared.js');
  const result = await registeredCorrection(identity, { kind: 'project',
    content: fixture.observation.content.replace('HAZEL RIDGE', 'LILAC GROVE'),
    correct: { ...fixture.correction, readCallId } });
  assert.deepEqual(correctionMemorySnapshot(), before);
  assert.equal(localNonWriteStatus(result), 'memory_correction_refused');
  assert.deepEqual(localNonWriteClassification(result), { kind: 'invalid_arguments' });
  assert.equal(memory.readRetainedMemoryRequirement(identity.retained), null);
});

test('registered correction accepts a fresh current-source read with the existing exact grant', async () => {
  const seed = source(); const fixture = observed(seed);
  const identity = source(ownerText, seed.sessionId);
  const readCallId = `fresh-current-read-${serial}`;
  settle(identity, 'memory_read', readCallId, JSON.stringify({ protocol: 'fact_observation_v1', readCallId,
    observation: fixture.observation, provenance: 'The complete original fact was reopened in this request.' }));
  const correct = { ...fixture.correction, readCallId };
  retain(identity, { ...fixture.assessment, corrections: [correct] }, 'prewrite');
  const expected = fixture.observation.content.replace('HAZEL RIDGE', 'LILAC GROVE');
  const result = await registeredCorrection(identity, { kind: 'project', content: expected, correct });
  const { localNonWriteStatus } = await import('../../tools/shared.js');
  assert.equal(localNonWriteStatus(result), null);
  assert.notEqual(result.isError, true);
  const receipt = JSON.parse(result.content[0]!.text);
  assert.equal(receipt.protocol, 'fact_correction_v1');
  assert.equal(receipt.status, 'corrected');
  assert.equal(receipt.currentStateMatches, true);
  assert.equal(receipt.proof.before.id, fixture.fact.id);
  assert.equal(receipt.proof.after.content, expected);
  assert.equal(factState.readFactObservation(fixture.fact.id)?.active, false);
});

test('registered correction keeps unavailable or corrupt retained read evidence unknown', async () => {
  const { localNonWriteStatus, localNonWriteClassification } = await import('../../tools/shared.js');
  const payloads = await import('./result-payload-storage.js');
  for (const variation of ['missing-payload', 'corrupt-payload', 'malformed-envelope'] as const) {
    const identity = source(); const fixture = observed(identity);
    const readCallId = `unreadable-${variation}-${serial}`;
    const raw = JSON.stringify({ protocol: variation === 'malformed-envelope' ? 'invalid' : 'fact_observation_v1', readCallId,
      observation: fixture.observation,
      provenance: variation === 'malformed-envelope' ? 'Malformed retained observation envelope.'
        : 'x'.repeat(payloads.RESULT_PAYLOAD_INLINE_MAX_BYTES + 1) });
    settle(identity, 'memory_read', readCallId, raw);
    if (variation !== 'malformed-envelope') {
      const row = events.openEventLog().prepare(`SELECT raw_payload_sha256 FROM durable_result_handles
        WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`)
        .get(identity.sessionId, identity.sourceUserSeq, readCallId) as { raw_payload_sha256: string };
      assert.ok(row);
      const file = payloads.resultPayloadFilePath(row.raw_payload_sha256);
      if (variation === 'missing-payload') rmSync(file);
      else writeFileSync(file, 'corrupt retained bytes');
    }
    const before = correctionMemorySnapshot();
    const result = await registeredCorrection(identity, { kind: 'project',
      content: fixture.observation.content.replace('HAZEL RIDGE', 'LILAC GROVE'),
      correct: { ...fixture.correction, readCallId } });
    assert.equal(result.isError, true, variation);
    assert.equal(localNonWriteStatus(result), null, variation);
    assert.equal(localNonWriteClassification(result), undefined, variation);
    assert.match(result.content[0]!.text, /Correction outcome could not be verified/, variation);
    assert.deepEqual(correctionMemorySnapshot(), before, variation);
    assert.equal(memory.readRetainedMemoryRequirement(identity.retained), null, variation);
  }
});

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


for (const failedOpen of [false, true]) test(`memory assessment coverage keeps unbound B pending when the current packet is ${failedOpen ? 'failed-open' : 'missing'}`, async (t) => {
  const identity = source(ownerText + ' Apply the heading replacement to both report A and report B before claiming both are corrected.');
  const first = observed(identity, `coverage-first-${serial}`);
  const second = observed(identity, `coverage-second-${serial}`);
  const grant = retain(identity, first.assessment, 'prewrite');
  settleExactCorrection(identity, first, grant, `coverage-proved-first-${serial}`);
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'verified', 'A has its complete canonical operation proof');
  assert.equal(memory.readRetainedMemoryRequirement(identity.retained)?.review.phase, 'prewrite',
    'the fixture has an execution grant, never a whole-request completion assessment');
  const result = await runHost(identity, { done: true, reason: 'The model claims both requested corrections are complete.',
    ...(failedOpen ? { failedOpen: true, reviewFailure: 'unavailable' as const } : {}) });
  const judged = events.listEvents(identity.sessionId, { types: ['goal_alignment_judged'] })
    .filter(row => row.data.kind === 'completion');
  t.diagnostic(JSON.stringify({ scenario: 'partial-correction-without-completion-packet', failedOpen,
    calls: result.calls, reviews: result.reviews, terminal: result.outcome.terminal ?? null,
    secondTargetActive: factState.readFactObservation(second.fact.id)?.active,
    finalMemoryStatus: (judged.at(-1)?.data.judgedMemoryRequirement as { status?: string } | undefined)?.status,
    positiveCompletionCount: judged.filter(row => row.data.fulfills === true).length }));
  assert.ok(result.calls > 0 && result.reviews > 0, 'the actual host completion boundary is exercised');
  assert.equal(factState.readFactObservation(second.fact.id)?.active, true, 'verification never repairs the unbound target');
  assert.equal(memory.findRetainedCorrectionAssessment(identity.retained, first.correction)?.assessmentDigest, grant.assessmentDigest,
    'the original source-bound A execution grant remains redeemable');
  assert.equal(result.outcome.terminal?.status, 'blocked', 'one corrected target cannot establish whole-request memory coverage');
  assert.equal(result.outcome.terminal?.reason, 'memory_correction_unverified');
  assert.equal(judged.some(row => row.data.fulfills === true), false, 'partial proof must not become a positive whole-objective verdict');
});

for (const variation of ['missing', 'failed-open', 'legacy-positive'] as const) test(`memory assessment coverage keeps a reviewed question pending after a later ${variation} packet`, async (t) => {
  // Installed q4: A's exact correction was verified while B needed its new
  // heading. The valid question's reviewer retained correct(A), not unresolved.
  const identity = source(ownerText + ' That replacement is for report A only. Report B also has the wrong heading, but I have not provided its replacement. Leave B unchanged and ask me for its new heading.');
  const first = observed(identity, `coverage-question-first-${serial}`);
  const second = observed(identity, `coverage-question-second-${serial}`);
  const grant = retain(identity, first.assessment, 'prewrite');
  settleExactCorrection(identity, first, grant, `coverage-question-write-${serial}`);
  const paused = await runHost(identity, { done: true, awaitingUser: true,
    reason: 'A is corrected. The owner must supply the missing replacement for B.', memoryRequirement: first.assessment },
  true, 'ASK: Report A is corrected. What heading should replace HAZEL RIDGE in report B?');
  assert.equal(paused.outcome.terminal?.status, 'awaiting_user_input', 'the actual host admits the precise owner question');
  assert.equal(paused.calls, 1); assert.equal(paused.reviews, 1);
  const pausedVerdict = events.listEvents(identity.sessionId, { types: ['goal_alignment_judged'] })
    .filter(row => row.data.kind === 'completion').at(-1);
  assert.ok(pausedVerdict);
  assert.equal(pausedVerdict.data.awaitingUser, true);
  assert.equal(pausedVerdict.data.fulfills, false);
  assert.equal(pausedVerdict.data.acceptedMemoryRequirement, undefined, 'a correct partial packet on a question never mints whole-request acceptance');
  assert.equal(memory.readRetainedMemoryRequirement(identity.retained)?.review.phase, 'completion',
    'a completion-phase packet by itself does not mean the whole request was completed');
  assert.equal((pausedVerdict.data.judgedMemoryRequirement as { status?: string }).status, 'verified',
    'the paused review correctly recognizes A\'s canonical operation proof');
  if (variation === 'legacy-positive') {
    // Recreate the old missing-packet fallback's stored positive verdict. It
    // cites the same A digest, but no new accepted memory packet covered B.
    events.appendEvent({ sessionId: identity.sessionId, turn: identity.turn, role: 'system', type: 'goal_alignment_judged',
      data: { ...pausedVerdict.data, fulfills: true, awaitingUser: false, failedOpen: false,
        replyDigest: digest('The requested memory is saved and corrected.'),
        reason: 'Historical missing-packet fallback accepted the old partial A proof.' } });
  }
  events.closeEventLog(); memoryDb.closeMemoryDb();
  const result = await runHost(identity, { done: true, reason: 'The model now claims both corrections are complete.',
    ...(variation !== 'missing' ? { failedOpen: true, reviewFailure: 'unavailable' as const } : {}) });
  const later = events.listEvents(identity.sessionId, { types: ['goal_alignment_judged'] })
    .filter(row => row.data.kind === 'completion' && row.seq > pausedVerdict.seq);
  t.diagnostic(JSON.stringify({ scenario: 'paused-partial-correction-cannot-become-completion', variation,
    calls: result.calls, reviews: result.reviews, terminal: result.outcome.terminal ?? null,
    secondTargetActive: factState.readFactObservation(second.fact.id)?.active,
    finalMemoryStatus: (later.at(-1)?.data.judgedMemoryRequirement as { status?: string } | undefined)?.status,
    finalFulfills: later.at(-1)?.data.fulfills }));
  assert.equal(factState.readFactObservation(second.fact.id)?.active, true, 'the unanswered target stays unchanged');
  assert.equal(memory.findRetainedCorrectionAssessment(identity.retained, first.correction)?.assessmentDigest, grant.assessmentDigest,
    'question/completion coverage does not revoke the settled A grant');
  assert.equal(result.outcome.terminal?.status, 'blocked', 'a retained question must not be reinterpreted as whole-request completion');
  assert.equal(result.outcome.terminal?.reason, 'memory_correction_unverified');
  assert.equal(later.at(-1)?.data.fulfills, false, 'the new boundary cannot bootstrap a misleading historical positive');
});

for (const failedOpen of [false, true]) test(`memory assessment coverage preserves a complete earlier assessment across later prewrite when the current packet is ${failedOpen ? 'failed-open' : 'missing'}`, async () => {
  const identity = source(ownerText + ' Apply the heading replacement to both report A and report B.');
  const first = observed(identity, `coverage-complete-first-${serial}`);
  const second = observed(identity, `coverage-complete-second-${serial}`);
  const firstGrant = retain(identity, first.assessment, 'prewrite');
  const secondGrant = retain(identity, second.assessment, 'prewrite');
  settleExactCorrection(identity, first, firstGrant, `coverage-complete-write-first-${serial}`);
  settleExactCorrection(identity, second, secondGrant, `coverage-complete-write-second-${serial}`);
  const accepted = await runHost(identity, { done: true, reason: 'The whole accepted request is complete.',
    memoryRequirement: { ...first.assessment, corrections: [first.correction, second.correction],
      reason: 'The whole accepted request requires both exact heading replacements; both are now proved.' } });
  assert.equal(accepted.outcome.terminal, undefined);
  assert.equal(accepted.calls, 1); assert.equal(accepted.reviews, 1);
  const acceptedVerdict = events.listEvents(identity.sessionId, { types: ['goal_alignment_judged'] })
    .filter(row => row.data.kind === 'completion').at(-1);
  assert.equal(acceptedVerdict?.data.fulfills, true, 'the actual host accepted the full request before the later absent packet');
  assert.notEqual(acceptedVerdict?.data.awaitingUser, true);
  assert.notEqual(acceptedVerdict?.data.failedOpen, true);
  const full = memory.readRetainedMemoryRequirement(identity.retained);
  assert.ok(full);
  assert.deepEqual(acceptedVerdict?.data.acceptedMemoryRequirement,
    { version: 1, eventId: full.eventId, assessmentDigest: full.assessmentDigest },
    'the actual current whole-request verdict names the typed assessment it accepted');
  assert.equal(full.review.phase, 'completion');
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'verified');
  const laterGrant = retain(identity, { ...full.assessment, reason: 'The same already-covered operations remain authorized.' }, 'prewrite');
  assert.notEqual(laterGrant.eventId, full.eventId);
  assert.equal(memory.readRetainedMemoryRequirement(identity.retained)?.review.phase, 'prewrite',
    'latest union metadata is not the source of whole-request completion authority');
  events.closeEventLog(); memoryDb.closeMemoryDb();
  const result = await runHost(identity, { done: true, reason: 'Both requested corrections are complete.',
    ...(failedOpen ? { failedOpen: true, reviewFailure: 'unavailable' as const } : {}) });
  assert.equal(result.outcome.terminal, undefined, 'a complete accepted assessment of this same request survives an absent later packet');
  assert.equal(result.calls, 1, 'already-settled corrections must not be repeated');
  assert.equal(result.reviews, 1, 'reuse the existing review, without a new review mechanism');
  assert.equal(memory.readRetainedMemoryRequirement(identity.retained)?.assessmentDigest, full.assessmentDigest);
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'verified');
  assert.equal(memory.findRetainedCorrectionAssessment(identity.retained, first.correction)?.assessmentDigest, firstGrant.assessmentDigest);
  assert.equal(memory.findRetainedCorrectionAssessment(identity.retained, second.correction)?.assessmentDigest, secondGrant.assessmentDigest);
});

for (const variation of ['later-awaiting', 'later-unresolved', 'wrong-source', 'wrong-digest', 'storage-drift',
  'new-target', 'substitute-review', 'review-failure'] as const) test(`memory assessment coverage rejects stale acceptance after ${variation}`, async () => {
  const identity = source(ownerText + ' Apply the heading replacement to both report A and report B.');
  const first = observed(identity, `coverage-guard-first-${serial}`);
  const second = observed(identity, `coverage-guard-second-${serial}`);
  const firstGrant = retain(identity, first.assessment, 'prewrite');
  settleExactCorrection(identity, first, firstGrant, `coverage-guard-write-first-${serial}`);
  if (variation !== 'new-target') {
    const secondGrant = retain(identity, second.assessment, 'prewrite');
    settleExactCorrection(identity, second, secondGrant, `coverage-guard-write-second-${serial}`);
  }
  const assessment = { ...first.assessment, corrections: variation === 'new-target'
    ? [first.correction] : [first.correction, second.correction] };
  const firstResult = await runHost(identity, { done: true, reason: 'The current correction set is accepted.', memoryRequirement: assessment });
  assert.equal(firstResult.outcome.terminal, undefined);
  const accepted = events.listEvents(identity.sessionId, { types: ['goal_alignment_judged'] })
    .filter(row => row.data.kind === 'completion').at(-1);
  assert.ok(accepted?.data.acceptedMemoryRequirement);
  assert.equal(memory.memoryCompletionFromAcceptedAssessment(identity.retained).status, 'verified');
  if (variation === 'later-awaiting') {
    const paused = await runHost(identity, { done: true, awaitingUser: true, reason: 'The request has an unanswered remainder.',
      memoryRequirement: assessment }, true, 'ASK: Which remaining report needs the correction?');
    assert.equal(paused.outcome.terminal?.status, 'awaiting_user_input');
  } else if (variation === 'later-unresolved') {
    const held = await runHost(identity, { done: true, reason: 'A remaining requested target is unresolved.',
      memoryRequirement: { version: 1, kind: 'unresolved', corrections: [], reason: 'The request has an unbound correction remainder.' } });
    assert.equal(held.outcome.terminal?.status, 'blocked');
  } else if (variation === 'storage-drift') {
    const replacementId = factState.readFactObservation(first.fact.id)?.supersededByFactId;
    assert.ok(replacementId);
    scope.stampMemoryScope('fact', replacementId, { projectId: 'different-controlled-project', agentKey: null });
  } else if (variation === 'new-target') {
    const nextGrant = retain(identity, second.assessment, 'prewrite');
    settleExactCorrection(identity, second, nextGrant, `coverage-guard-later-write-${serial}`);
    assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'verified', 'all operations are proved, but the older verdict covered only A');
  } else {
    const data = structuredClone(accepted.data);
    if (variation === 'wrong-source') {
      const other = source(); const foreign = observed(other);
      const otherAssessment = retain(other, foreign.assessment);
      data.acceptedMemoryRequirement = { version: 1, eventId: otherAssessment.eventId, assessmentDigest: otherAssessment.assessmentDigest };
    } else if (variation === 'wrong-digest') {
      data.acceptedMemoryRequirement = { ...(data.acceptedMemoryRequirement as object), assessmentDigest: '0'.repeat(64) };
    } else if (variation === 'substitute-review') data.substituteForExactPin = true;
    else data.reviewFailure = 'unavailable';
    events.openEventLog().prepare('UPDATE events SET data_json = ? WHERE id = ?').run(JSON.stringify(data), accepted.id);
  }
  events.closeEventLog(); memoryDb.closeMemoryDb();
  const result = await runHost(identity, { done: true, failedOpen: true, reviewFailure: 'unavailable', reason: 'Controlled later review unavailable.' });
  assert.equal(result.outcome.terminal?.status, 'blocked', 'historical acceptance must still match this source, remaining work and current storage');
  assert.equal(result.outcome.terminal?.reason, 'memory_correction_unverified');
  assert.equal(result.calls, 1, 'an unavailable reviewer adds no repair attempts');
});

test('memory assessment coverage accepts a fresh whole verdict whose packet was deduped from an earlier question', async () => {
  const identity = source(); const fixture = observed(identity);
  const grant = retain(identity, fixture.assessment, 'prewrite');
  settleExactCorrection(identity, fixture, grant, `coverage-dedup-write-${serial}`);
  const paused = await runHost(identity, { done: true, awaitingUser: true, reason: 'The owner question still needs an answer.',
    memoryRequirement: fixture.assessment }, true, 'ASK: Is there another report to correct?');
  assert.equal(paused.outcome.terminal?.status, 'awaiting_user_input');
  const packet = memory.readRetainedMemoryRequirement(identity.retained);
  assert.ok(packet);
  assert.equal(memory.memoryCompletionFromAcceptedAssessment(identity.retained).status, 'unverified');
  const completed = await runHost(identity, { done: true, reason: 'The accepted request required only this exact correction, which is complete.',
    memoryRequirement: fixture.assessment });
  assert.equal(completed.outcome.terminal, undefined);
  assert.equal(memory.readRetainedMemoryRequirement(identity.retained)?.eventId, packet.eventId, 'retaining the identical typed packet remains idempotent');
  const accepted = events.listEvents(identity.sessionId, { types: ['goal_alignment_judged'] })
    .filter(row => row.data.kind === 'completion').at(-1);
  assert.deepEqual(accepted?.data.acceptedMemoryRequirement, { version: 1, eventId: packet.eventId, assessmentDigest: packet.assessmentDigest });
  const later = await runHost(identity, { done: true, failedOpen: true, reviewFailure: 'unavailable', reason: 'Controlled later review unavailable.' });
  assert.equal(later.outcome.terminal, undefined, 'the fresh actual acceptance can reuse the exact retained packet');
});

test('memory assessment coverage retains a replaced packet separately from its exact bound correction proof', async () => {
  const identity = source(); const fixture = observed(identity);
  const grant = retain(identity, fixture.assessment, 'prewrite');
  replaceObservedAtIntake(identity, fixture);
  const accepted = await runHost(identity, { done: true, reason: 'The exact requested replacement is already in effect.', memoryRequirement: replacedAssessment });
  assert.equal(accepted.outcome.terminal, undefined);
  const verdict = events.listEvents(identity.sessionId, { types: ['goal_alignment_judged'] })
    .filter(row => row.data.kind === 'completion').at(-1);
  const reference = verdict?.data.acceptedMemoryRequirement as { eventId: string; assessmentDigest: string } | undefined;
  assert.ok(reference);
  assert.notEqual(reference.eventId, grant.eventId, 'acceptance names a completion assessment, never the earlier execution grant');
  assert.notEqual(reference.assessmentDigest, (verdict?.data.judgedMemoryRequirement as { assessmentDigest: string }).assessmentDigest,
    'typed replacement assessment and canonical bound correction projection have distinct digests');
  const later = await runHost(identity, { done: true, failedOpen: true, reviewFailure: 'unavailable', reason: 'Controlled later review unavailable.' });
  assert.equal(later.outcome.terminal, undefined);
  assert.equal(memory.findRetainedCorrectionAssessment(identity.retained, fixture.correction)?.assessmentDigest, grant.assessmentDigest);
});

test('actual host keeps a current unresolved target after an earlier exact correction is proved', async () => {
  const identity = source(ownerText + ' Apply the heading replacement to both report A and report B before claiming both are corrected.');
  const first = observed(identity, `mixed-first-${serial}`);
  const second = observed(identity, `mixed-second-${serial}`);
  const grant = retain(identity, first.assessment, 'prewrite');
  settleExactCorrection(identity, first, grant, `mixed-proved-first-${serial}`);
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'verified', 'A has its complete canonical proof');
  const unresolved = { version: 1 as const, kind: 'unresolved' as const, corrections: [],
    reason: 'Report A is corrected, but the requested correction for report B is still unresolved.' };
  const result = await runHost(identity, { done: true, reason: 'The model claims both records are corrected.', memoryRequirement: unresolved });
  assert.ok(result.calls > 0 && result.reviews > 0, 'the actual host completion boundary is exercised');
  assert.equal(result.outcome.terminal?.status, 'blocked', 'the current unresolved remainder cannot be hidden by A proof');
  assert.equal(result.outcome.terminal?.reason, 'memory_correction_unverified');
  assert.equal(memory.readRetainedMemoryRequirement(identity.retained)?.assessment.kind, 'unresolved');
  assert.equal(factState.readFactObservation(second.fact.id)?.active, true, 'verification does not repair B');
  assert.equal(memory.findRetainedCorrectionAssessment(identity.retained, first.correction)?.assessmentDigest, grant.assessmentDigest,
    'the immutable prewrite grant still owns A execution, independently of completion');
  assert.equal(retain(identity, first.assessment, 'prewrite').eventId, grant.eventId, 'old prewrite replay is idempotent');
  events.closeEventLog(); memoryDb.closeMemoryDb();
  assert.equal(memory.readRetainedMemoryRequirement(identity.retained)?.assessment.kind, 'unresolved', 'reopen retains the current remainder');
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'unverified', 'old grant replay cannot clear the remainder');
});

test('mixed unresolved completion keeps grants and requires a fresh full assessment after each hold', () => {
  const identity = source(ownerText + ' Apply the heading replacement to both report A and report B.');
  const first = observed(identity, `mixed-resolution-first-${serial}`);
  const second = observed(identity, `mixed-resolution-second-${serial}`);
  const firstGrant = retain(identity, first.assessment, 'prewrite');
  settleExactCorrection(identity, first, firstGrant, `mixed-resolution-proved-first-${serial}`);
  retain(identity, first.assessment); // An earlier completion assessment saw only A.
  const unresolved = { version: 1 as const, kind: 'unresolved' as const, corrections: [],
    reason: 'The remaining requested report correction is unresolved.' };
  const firstHold = retain(identity, unresolved);
  const secondGrant = retain(identity, second.assessment, 'prewrite');
  assert.equal(memory.readRetainedMemoryRequirement(identity.retained)?.assessment.kind, 'unresolved',
    'a new execution grant does not constitute a full completion assessment');
  assert.equal(memory.findRetainedCorrectionAssessment(identity.retained, second.correction)?.assessmentDigest, secondGrant.assessmentDigest);
  settleExactCorrection(identity, second, secondGrant, `mixed-resolution-proved-second-${serial}`);
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'unverified', 'both operations may finish while the review hold remains');
  assert.throws(() => retain(identity, second.assessment), /cannot omit/, 'the pending hold cannot hide the earlier bound target');
  const full = { ...first.assessment, corrections: [second.correction, first.correction] };
  const completed = retain(identity, full);
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'verified');
  const nextHold = retain(identity, unresolved);
  assert.notEqual(nextHold.eventId, firstHold.eventId, 'a repeated packet after completion records the new review rather than resurrecting an old row');
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'unverified');
  assert.equal(retain(identity, unresolved).eventId, nextHold.eventId, 'an unchanged current hold remains idempotent');
  // This is a current host completion invocation using an identical packet
  // value, not a separate cryptographic review identity or replay check.
  const completedAgain = retain(identity, full);
  assert.notEqual(completedAgain.eventId, completed.eventId, 'a fresh full review may resolve the later hold even with the same target digest');
  events.closeEventLog(); memoryDb.closeMemoryDb();
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'verified', 'full proofs and fresh review survive reopening');
});

test('actual host keeps the current unresolved verdict when retaining it fails', async () => {
  const identity = source(ownerText + ' Correct both report A and report B before claiming completion.');
  const first = observed(identity, `mixed-storage-first-${serial}`);
  const second = observed(identity, `mixed-storage-second-${serial}`);
  const grant = retain(identity, first.assessment, 'prewrite');
  settleExactCorrection(identity, first, grant, `mixed-storage-proved-first-${serial}`);
  const db = events.openEventLog();
  db.exec(`CREATE TRIGGER fixture_reject_unresolved_memory BEFORE INSERT ON events
    WHEN NEW.session_id = '${identity.sessionId}' AND NEW.type = 'goal_alignment_judged'
      AND json_extract(NEW.data_json, '$.kind') = 'memory_requirement'
      AND json_extract(NEW.data_json, '$.assessment.kind') = 'unresolved'
    BEGIN SELECT RAISE(ABORT, 'controlled unresolved receipt storage failure'); END`);
  try {
    const result = await runHost(identity, { done: true, reason: 'The model claims both are complete.',
      memoryRequirement: { version: 1, kind: 'unresolved', corrections: [], reason: 'Report B remains unresolved.' } });
    assert.equal(result.outcome.terminal?.status, 'blocked', 'a failed retention write cannot make the current unresolved review disappear');
    assert.equal(result.outcome.terminal?.reason, 'memory_correction_unverified');
    assert.equal(factState.readFactObservation(second.fact.id)?.active, true);
    assert.equal(memory.readRetainedMemoryRequirement(identity.retained)?.assessment.kind, 'correct',
      'the injected failure really left only the older A grant in storage');
  } finally { db.exec('DROP TRIGGER fixture_reject_unresolved_memory'); }
});

test('actual host cannot reuse A proof after rejecting a current correction packet that only names B', async () => {
  const identity = source(ownerText + ' Apply the heading replacement to both report A and report B.');
  const first = observed(identity, `mixed-rejected-first-${serial}`);
  const second = observed(identity, `mixed-rejected-second-${serial}`);
  const firstGrant = retain(identity, first.assessment, 'prewrite');
  settleExactCorrection(identity, first, firstGrant, `mixed-rejected-proved-first-${serial}`);
  const result = await runHost(identity, { done: true, reason: 'The model claims both are complete.', memoryRequirement: second.assessment });
  assert.equal(result.outcome.terminal?.status, 'blocked', 'the rejected current B packet cannot fall back to old A proof');
  assert.equal(result.outcome.terminal?.reason, 'memory_correction_unverified');
  assert.equal(factState.readFactObservation(second.fact.id)?.active, true);
  assert.equal(memory.readRetainedMemoryRequirement(identity.retained)?.assessment.corrections.length, 1,
    'the rejected partial packet did not alter the retained correction union');
  assert.equal(events.listEvents(identity.sessionId, { types: ['goal_alignment_judged'] })
    .filter(row => row.data.kind === 'completion').some(row => row.data.fulfills === true), false,
    'the current rejection is retained as an unverified completion, not a positive review');
});

test('a fresh full intake replacement assessment resolves a mixed hold without waiving bound targets', () => {
  const identity = source(ownerText + ' Apply the heading replacement to both report A and report B.');
  const first = observed(identity, `mixed-intake-first-${serial}`);
  const second = observed(identity, `mixed-intake-second-${serial}`);
  const grants = [retain(identity, first.assessment, 'prewrite'), retain(identity, second.assessment, 'prewrite')];
  for (const fixture of [first, second]) {
    const by = facts.rememberFact({ kind: 'project', content: fixture.observation.content.replace('HAZEL RIDGE', 'LILAC GROVE'), scope: null,
      sessionId: identity.sessionId, occurredAt: identity.retained.occurredAt,
      sourceUri: `conversation://${encodeURIComponent(identity.sessionId)}/${encodeURIComponent(`auto-capture:user-source:${identity.sourceUserSeq}`)}` });
    assert.equal(facts.markFactSupersededBy(fixture.fact.id, by.id, { validTo: identity.retained.occurredAt }), true);
  }
  const unresolved = { version: 1 as const, kind: 'unresolved' as const, corrections: [], reason: 'The full requested replacement still needs comparison.' };
  retain(identity, unresolved);
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'unverified');
  const resolved = retain(identity, replacedAssessment);
  assert.equal(resolved.assessment.kind, 'replaced', 'the fresh completion assessment is retained after the hold');
  assert.equal(memory.readRetainedMemoryRequirement(identity.retained)?.assessment.corrections.length, 2);
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'verified');
  const nextHold = retain(identity, unresolved);
  const resolvedAgain = retain(identity, replacedAssessment);
  assert.notEqual(resolvedAgain.eventId, resolved.eventId, 'a fresh replacement review resolves the newer hold rather than reusing an older row');
  assert.notEqual(resolvedAgain.eventId, nextHold.eventId);
  for (const [index, fixture] of [first, second].entries()) {
    assert.equal(memory.findRetainedCorrectionAssessment(identity.retained, fixture.correction)?.assessmentDigest, grants[index]!.assessmentDigest);
  }
  events.closeEventLog(); memoryDb.closeMemoryDb();
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'verified');
});

for (const action of ['supersede', 'reinforce'] as const) test(`actual host keeps unresolved memory after partial ${action}`, async () => {
  const identity = source('Correct both synthetic report headings: change HAZEL RIDGE to LILAC GROVE for report A and resolve report B before claiming both are corrected. Preserve both footers.');
  const unresolved = { version: 1 as const, kind: 'unresolved' as const, corrections: [],
    reason: 'Report B has not been bound to its exact original fact. Report A alone does not complete both requested corrections.' };
  retain(identity, unresolved);
  const first = facts.rememberFact({ kind: 'project', content: `Synthetic ${serial} report A: heading HAZEL RIDGE; footer COPPER KITE.`, scope: null, sessionId: identity.sessionId });
  const second = facts.rememberFact({ kind: 'project', content: `Synthetic ${serial} report B: heading HAZEL RIDGE; footer COPPER KITE.`, scope: null, sessionId: identity.sessionId });
  let storedId = first.id;
  settle(identity, 'memory_remember', `partial-${action}-${serial}`, () => {
    if (action === 'supersede') {
      const stored = facts.rememberFact({ kind: 'project', content: `Synthetic ${serial} report A: heading LILAC GROVE; footer COPPER KITE.`, scope: null, sessionId: identity.sessionId });
      assert.equal(facts.markFactSupersededBy(first.id, stored.id, { validTo: identity.retained.occurredAt }), true);
      storedId = stored.id;
    }
    return receipts.formatMemoryRememberReceipt({ action, factId: storedId })
      + '\nOne synthetic record was saved. Memory conflict unresolved: the second requested target remains active.';
  }, { kind: 'project', content: action === 'supersede' ? 'Synthetic report A heading LILAC GROVE; footer COPPER KITE.' : 'Synthetic report A heading HAZEL RIDGE; footer COPPER KITE.' });
  assert.equal(memory.readRetainedMemoryRequirement(identity.retained)?.assessment.kind, 'unresolved');
  assert.deepEqual(memory.explicitRememberStored(identity.retained), { action, factId: storedId });
  assert.equal(factState.readFactObservation(second.id)?.active, true);
  const result = await runHost(identity, { done: true, reason: 'The model claims both requested corrections are complete.', memoryRequirement: unresolved });
  const finalRequirement = memory.readRetainedMemoryRequirement(identity.retained)?.assessment.kind;
  console.log('MEMORY_UNRESOLVED_RED_OBSERVATION ' + JSON.stringify({ action, calls: result.calls, reviews: result.reviews,
    terminalStatus: result.outcome.terminal?.status ?? null, terminalReason: result.outcome.terminal?.reason ?? null,
    retainedKind: finalRequirement, secondTargetActive: factState.readFactObservation(second.id)?.active,
    finalOutputClaimsSaved: /saved and corrected/.test(result.outcome.finalOutput ?? '') }));
  assert.ok(result.calls > 0 && result.reviews > 0, 'the real installed host completion boundary must run');
  assert.equal(finalRequirement, 'unresolved', 'the retained requirement remains unresolved');
  assert.equal(factState.readFactObservation(second.id)?.active, true, 'verification never repairs the other target');
  assert.equal(result.outcome.terminal?.status, 'blocked', 'a partial save must not complete the unresolved request');
  assert.equal(result.outcome.terminal?.reason, 'memory_correction_unverified');
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'unverified', 'the exact completion helper preserves unresolved');
  assert.equal(memory.hostVerifiedMemoryRetention(identity.retained), null, 'the early-save helper cannot override unresolved');
});

for (const marker of ['INCOMPLETE', 'CORRECT'] as const) {
  test(`intake coverage cap distinguishes ${marker} before unavailable review`, async () => {
    const { selectAutoMemoryCandidates, automaticMemoryOriginsForCapture, autoCaptureProvenanceFromAcceptedEvent } = await import('../../memory/auto-capture.js');
    const { enqueueAutoCaptureCandidates, drainDurableConsolidationCandidates } = await import('../../memory/durable-consolidation.js');
    const { hostVerifiedStatedRetention } = await import('./durable-memory-intake-receipt.js');
    const { parseCompletionVerdict } = await import('./objective-judge.js');
    const omittedB = marker === 'INCOMPLETE';
    // Four real commands select only the first three. No selected row is
    // deleted or forged; the producer's own cap omits the requested B fact.
    const clauses = ['Remember that my report A heading is LILAC GROVE.',
      'Remember that my report A footer is COPPER KITE.',
      ...(omittedB ? ['Remember that my report A style is TITLE CASE.'] : []),
      'Remember that my report B heading is IVORY FIELD.'];
    const identity = source(clauses.join('\n'));
    const sourceEvent = events.listEvents(identity.sessionId, { types: ['user_input_received'] })
      .find(row => row.seq === identity.sourceUserSeq);
    assert.ok(sourceEvent);
    const input = { message: identity.retained.ownerText, sessionId: identity.sessionId,
      sourceEventId: `user-source:${identity.sourceUserSeq}`,
      sourceProvenance: autoCaptureProvenanceFromAcceptedEvent(sourceEvent) };
    const candidates = selectAutoMemoryCandidates(input.message, 3);
    assert.equal(candidates.length, 3);
    assert.equal(candidates.some(row => row.content.includes('IVORY FIELD')), !omittedB);
    if (omittedB) assert.ok(candidates.every(row => row.content.includes('report A')));
    const queued = enqueueAutoCaptureCandidates({ ...input, candidates,
      origins: automaticMemoryOriginsForCapture(input, candidates) });
    assert.ok(queued.episodeId && queued.callId);
    assert.equal(queued.candidateIds.length, 3);
    let resolverCalls = 0; let standingReviews = 0;
    const standingInputs: Array<{ ownerText: string; sourceUserSeq?: number; claim?: string }> = [];
    const drained = await drainDurableConsolidationCandidates({ ids: queued.candidateIds,
      limit: queued.candidateIds.length,
      resolver: async () => { resolverCalls++; return { decision: 'ADD' }; },
      standingReviewer: async (ownerText, _candidate, _mode, origin) => {
        standingReviews++;
        standingInputs.push({ ownerText, sourceUserSeq: origin?.source.context?.sourceUserSeq, claim: origin?.claim });
        return { scope: 'standing', reason: 'Controlled source-bound promotion of this selected claim.', destinationDecision: {
          durability: 'standing', claim: origin?.claim ?? '', destination: 'kind_default', destinationSpans: [],
          reason: 'Controlled full-source destination review; no claim about coverage of other owner requests.',
        } };
      },
    });
    assert.equal(drained.promoted, 3);
    assert.equal(drained.retried, 0);
    assert.equal(drained.expired, 0);
    assert.equal(drained.skipped, 0);
    assert.equal(standingInputs.length, 3);
    for (const standing of standingInputs) {
      assert.equal(standing.ownerText, input.message);
      assert.equal(standing.sourceUserSeq, identity.sourceUserSeq);
      assert.ok(standing.claim);
    }
    const promoted = memoryDb.openMemoryDb().prepare(`SELECT status,resulting_fact_id FROM memory_reflection_candidates
      WHERE session_id = ? AND call_id = ? ORDER BY id`).all(identity.sessionId, queued.callId) as Array<{
        status: string; resulting_fact_id: number;
      }>;
    assert.equal(promoted.length, 3);
    const stored = promoted.map(row => {
      assert.equal(row.status, 'promoted');
      const fact = factState.readFactObservation(row.resulting_fact_id);
      assert.ok(fact?.active);
      return fact;
    });
    assert.equal(stored.some(row => row.content.includes('IVORY FIELD')), !omittedB);
    if (omittedB) assert.ok(stored.every(row => row.content.includes('report A')));
    assert.equal(hostVerifiedStatedRetention(identity), true, 'all producer-selected claims really have exact promoted storage proof');
    const beforeDigests = stored.map(row => row.digest);
    const beforeDrainCalls = { resolverCalls, standingReviews };
    const first = parseCompletionVerdict(marker === 'INCOMPLETE'
      ? 'INCOMPLETE: Report B heading IVORY FIELD remains unsaved; the three report A facts are stored.'
      : 'CORRECT: All requested facts are stored. Remove the unsupported claim that consolidation is still pending.');
    assert.ok(first && !first.done);
    assert.equal(first.repairScope, omittedB ? undefined : 'claims', 'the existing control parser supplies the distinction, not reason matching');
    const reviewInputs: Array<{ review: number; objective: string; capturedStorage: boolean;
      prior: Array<{ fulfills: unknown; repairScope: unknown }> }> = [];
    const result = await runHost(identity, (review, objective) => {
      reviewInputs.push({ review, objective, capturedStorage: hostVerifiedStatedRetention(identity),
        prior: events.listEvents(identity.sessionId, { types: ['goal_alignment_judged'] })
          .filter(row => row.data.kind === 'completion')
          .map(row => ({ fulfills: row.data.fulfills, repairScope: row.data.repairScope })) });
      if (review === 1) return { ...first,
        memoryRequirement: { version: 1, kind: 'retain', corrections: [], reason: 'The owner asked to retain these new report facts.' } };
      return { done: true, reason: 'Controlled later review is unavailable.', failedOpen: true, reviewFailure: 'unavailable' };
    }, true, call => call === 1
      ? omittedB ? 'All four requested facts are saved.' : 'The report facts are captured, but consolidation is still pending.'
      : omittedB ? 'The three report A facts and report B heading IVORY FIELD are remembered.' : 'The report A heading and footer and report B heading are remembered.');
    const completed = events.listEvents(identity.sessionId, { types: ['goal_alignment_judged'] })
      .filter(row => row.data.kind === 'completion');
    console.log('MEMORY_INTAKE_CAP_CONTRACT_OBSERVATION ' + JSON.stringify({ marker, ownerClauses: clauses.length,
      selectedCandidates: candidates.length, promoted: promoted.length, capturedStorageVerified: hostVerifiedStatedRetention(identity),
      requestedBStored: stored.some(row => row.content.includes('IVORY FIELD')),
      calls: result.calls, reviews: result.reviews, terminalStatus: result.outcome.terminal?.status ?? null,
      reviewResults: completed.map(row => ({ fulfills: row.data.fulfills, failedOpen: row.data.failedOpen === true,
        repairScope: row.data.repairScope ?? null, memoryStatus: (row.data.judgedMemoryRequirement as { status?: string } | undefined)?.status ?? null })) }));
    assert.equal(result.calls, 2);
    assert.equal(result.reviews, 2);
    assert.deepEqual(reviewInputs, [
      { review: 1, objective: identity.retained.ownerText, capturedStorage: true, prior: [] },
      { review: 2, objective: identity.retained.ownerText, capturedStorage: true,
        prior: [{ fulfills: false, repairScope: omittedB ? undefined : 'claims' }] },
    ], 'callback observations are asserted outside the host catch/fail-open boundary');
    assert.equal(completed[0]!.data.failedOpen, undefined, 'the first actual review is the intentional negative');
    assert.equal(completed[1]!.data.failedOpen, true);
    assert.equal(completed[1]!.data.reviewFailure, 'unavailable');
    assert.deepEqual({ resolverCalls, standingReviews }, beforeDrainCalls, 'completion review does not restart consolidation');
    assert.deepEqual(stored.map(row => factState.readFactObservation(row.id)?.digest), beforeDigests, 'no stored fact is changed by review');
    assert.equal(events.listEvents(identity.sessionId, { types: ['tool_called'] }).length, 0);
    assert.equal(result.outcome.terminal?.status, 'blocked',
      'captured storage and claims-only scope cannot clear an unresolved whole-request review');
    assert.equal(completed.some(row => row.data.fulfills === true), false);
    if (!omittedB) assert.equal(completed[0]!.data.repairScope, 'claims',
      'CORRECT is a real claims-only finding, not an accepted revised answer');
  });
}

const retainAssessment = { version: 1 as const, kind: 'retain' as const, corrections: [],
  reason: 'The owner asks to retain the stated project information.' };
const unavailableMemoryReview = { done: true, failedOpen: true, reviewFailure: 'unavailable' as const,
  reason: 'Controlled reviewer unavailable.' };

function savedRetention(action: 'add' | 'supersede' | 'reinforce' = 'add') {
  const identity = source(`Remember the synthetic report A heading LILAC GROVE and report B heading IVORY FIELD for request ${serial + 1}.`);
  const previous = facts.rememberFact({ kind: 'project', content: `Synthetic ${serial} report A: heading HAZEL RIDGE.`,
    scope: null, sessionId: identity.sessionId });
  let storedId = previous.id;
  settle(identity, 'memory_remember', `retain-floor-${action}-${serial}`, () => {
    if (action !== 'reinforce') {
      storedId = facts.rememberFact({ kind: 'project', content: `Synthetic ${serial} report A: heading LILAC GROVE.`,
        scope: null, sessionId: identity.sessionId }).id;
      if (action === 'supersede') assert.equal(facts.markFactSupersededBy(previous.id, storedId,
        { validTo: identity.retained.occurredAt }), true);
    }
    return receipts.formatMemoryRememberReceipt({ action, factId: storedId });
  }, { kind: 'project', content: `Synthetic ${serial} report A: heading LILAC GROVE.` });
  return { identity, storedId };
}

for (const action of ['supersede', 'reinforce'] as const) {
  test(`retained negative floor cannot be bypassed by a partial manual ${action}`, async () => {
    const { identity, storedId } = savedRetention(action);
    assert.equal(memory.hostVerifiedMemoryRetention(identity.retained)?.status, 'verified',
      'the existing convenience path is initially eligible');
    const result = await runHost(identity, review => review === 1
      ? { done: false, reason: 'Report B still needs its requested heading.', memoryRequirement: retainAssessment }
      : unavailableMemoryReview, true, call => `Both requested headings are saved, report revision ${call}.`);
    assert.equal(result.calls, 2); assert.equal(result.reviews, 2);
    assert.deepEqual(memory.explicitRememberStored(identity.retained), { action, factId: storedId });
    assert.equal(result.outcome.terminal?.status, 'blocked');
    assert.equal(memory.hostVerifiedMemoryRetention(identity.retained), null,
      'the same negative floor applies before the explicit-store fallback');
    assert.equal(memory.memoryCompletionFromAcceptedAssessment(identity.retained).status, 'unverified');
  });
}

for (const variation of ['fresh-positive', 'later-negative', 'later-awaiting', 'wrong-objective', 'wrong-source',
  'substituted', 'failed-open', 'answered-unqualified', 'insufficient-evidence'] as const) {
  test(`retained negative floor accepts only the current whole review: ${variation}`, async () => {
    const { identity } = savedRetention();
    const b = facts.rememberFact({ kind: 'project', content: `Synthetic ${serial} report B: heading IVORY FIELD.`,
      scope: null, sessionId: identity.sessionId });
    settle(identity, 'memory_remember', `retain-floor-B-${serial}`,
      receipts.formatMemoryRememberReceipt({ action: 'add', factId: b.id }),
      { kind: 'project', content: `Synthetic ${serial} report B: heading IVORY FIELD.` });
    // Both writes are real; the first answer falsely says they are pending.
    // Only an actual current positive review can settle that claims finding.
    const completed = await runHost(identity, review => review === 1
      ? { done: false, repairScope: 'claims', reason: 'The pending-save claim contradicts the completed work.', memoryRequirement: retainAssessment }
      : { done: true, reason: 'Both requested headings are saved and the revised answer is accurate.', memoryRequirement: retainAssessment },
    true, call => call === 1 ? 'Both report headings are still pending.' : 'Both requested report headings are saved.');
    assert.equal(completed.outcome.terminal, undefined);
    assert.equal(completed.calls, 2); assert.equal(completed.reviews, 2);
    const accepted = events.listEvents(identity.sessionId, { types: ['goal_alignment_judged'] })
      .filter(row => row.data.kind === 'completion').at(-1);
    assert.ok(accepted?.data.fulfills);
    if (variation === 'later-negative' || variation === 'later-awaiting') {
      const paused = await runHost(identity, { done: true, awaitingUser: true,
        reason: 'A requested detail remains unresolved.', memoryRequirement: retainAssessment },
      true, 'ASK: Which remaining report detail should be retained?');
      assert.equal(paused.outcome.terminal?.status, 'awaiting_user_input', 'a legitimate current question still publishes');
      if (variation === 'later-negative') {
        const row = events.listEvents(identity.sessionId, { types: ['goal_alignment_judged'] })
          .filter(item => item.data.kind === 'completion').at(-1)!;
        events.openEventLog().prepare('UPDATE events SET data_json = ? WHERE id = ?')
          .run(JSON.stringify({ ...row.data, awaitingUser: false, fulfills: false }), row.id);
      }
    } else if (variation !== 'fresh-positive') {
      const data = structuredClone(accepted.data);
      if (variation === 'wrong-objective') data.objectiveDigest = digest('another objective');
      if (variation === 'wrong-source') data.sourceUserSeq = identity.sourceUserSeq + 1;
      if (variation === 'substituted') data.substituteForExactPin = true;
      if (variation === 'failed-open') { data.failedOpen = true; data.reviewFailure = 'unavailable'; }
      if (variation === 'answered-unqualified') data.reviewDisposition = 'answered_unqualified';
      if (variation === 'insufficient-evidence') data.evidenceCoverage = { status: 'insufficient', returnedForCorrection: true };
      events.openEventLog().prepare('UPDATE events SET data_json = ? WHERE id = ?').run(JSON.stringify(data), accepted.id);
    }
    events.closeEventLog(); memoryDb.closeMemoryDb();
    const later = await runHost(identity, unavailableMemoryReview);
    assert.equal(later.calls, 1); assert.equal(later.reviews, 1, 'no extra review calls are introduced');
    if (variation === 'fresh-positive') {
      assert.equal(later.outcome.terminal, undefined, 'an actual qualified whole review clears the older negative');
    } else {
      assert.equal(later.outcome.terminal?.status, 'blocked', 'unqualified, foreign or retired positives cannot clear the hold');
      assert.equal(memory.memoryCompletionFromAcceptedAssessment(identity.retained).status, 'unverified');
    }
  });
}

test('unresolved becomes exact correction and closes only with full proof', async () => {
  const identity = source(ownerText + ' Also replace the stored word Fixture with Record.'); const fixture = observed(identity);
  retain(identity, { version: 1, kind: 'unresolved', corrections: [], reason: 'The exact target has not yet been bound.' });
  assert.equal(memory.memoryCorrectionCompletion(identity.retained).status, 'unverified');
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
