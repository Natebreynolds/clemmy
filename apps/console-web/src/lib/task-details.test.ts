import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTaskDetails, recordedCount, recordedDuration, taskDetailsPath, taskModelIdentity,
  taskAuxiliaryIdentity, taskAuxiliaryPurpose, taskAuxiliaryStatus, taskMemorySections, taskProvidedMemoryLinks, taskModelProvider, taskModelRole, taskModelStatus, taskToolEvidence, taskToolReason, taskToolStatus, taskUsageNotes, taskUsageRoles,
  type TaskHandlingDetails, type TaskAuxiliaryModelRecord, type TaskModelRecord, type TaskToolRecord,
} from './task-details.js';

function details(): TaskHandlingDetails {
  return {
    version: 1, sessionId: 'task-a', sourceUserSeq: 41, acceptedAt: '2026-10-18T10:00:00Z', observedAt: '2026-10-18T10:00:03Z',
    attemptIds: [], tools: [], models: [], usage: null, memory: { provided: null, recall: [] },
    limits: { toolsTruncated: false, modelsTruncated: false, memoryTruncated: false }, limitations: [],
  };
}
const model = (patch: Partial<TaskModelRecord> = {}): TaskModelRecord => ({
  callId: 'call-a', role: 'brain', provider: 'test-provider', resolvedModel: 'route-model', status: 'started', responseCompleted: false, ...patch,
});
const tool = (patch: Partial<TaskToolRecord> = {}): TaskToolRecord => ({
  callId: 'tool-a', eventSeq: 50, name: 'read_file', status: 'returned', dispatchEvidence: 'lifecycle', startedAt: '2026-10-18T10:00:00Z', ...patch,
});
const auxiliary = (patch: Partial<TaskAuxiliaryModelRecord> = {}): TaskAuxiliaryModelRecord => ({
  callId: 'auxiliary-a', attemptId: 'attempt-a', physicalAttempt: 1, transport: 'typesafe_systemone', role: 'router',
  responseCompleted: false, status: 'started', dispatchCount: 1, usage: 'unknown', evidence: 'incomplete', ...patch,
});

test('unfamiliar role and section names remain text rather than inherited object properties', () => {
  for (const value of ['__proto__', 'constructor', 'toString']) {
    assert.equal(typeof taskModelRole(value), 'string');
    const detail = details();
    detail.memory.provided = { recordedAt: detail.observedAt, sourceUserSeq: detail.sourceUserSeq,
      manifest: [{ section: value, tier: 'relevant', tokens: 0, bytes: 0, refs: [] }] };
    assert.deepEqual(taskMemorySections(detail), ['Other saved context']);
  }
});

test('a judge role records a review call without attesting an independent or passed review', () => {
  assert.equal(taskModelRole('judge'), 'Review call');
});

test('provided policy and fact references link exact memories once without fetching or claiming use', () => {
  const detail = details();
  detail.memory.provided = { recordedAt: detail.observedAt, sourceUserSeq: 41, manifest: [{
    section: 'standing_policies', tier: 'core', tokens: 10, bytes: 30,
    refs: [{ type: 'policy', id: '5019' }, { type: 'fact', id: '5019' }, { type: 'policy', id: '0' },
      { type: 'fact', id: '42junk' }, { type: 'entity', id: '43' }, { type: 'fact', id: '44' }],
  }] };
  assert.deepEqual(taskProvidedMemoryLinks(detail), [{ id: 5019, href: '/memory?fact=5019' }, { id: 44, href: '/memory?fact=44' }]);
  detail.memory.provided.manifest[0]!.refs = Array.from({ length: 30 }, (_, i) => ({ type: 'policy', id: String(i + 1) }));
  assert.equal(taskProvidedMemoryLinks(detail).length, 12);
});

test('details require an exact source and safely encode session names; no temporal fallback', () => {
  assert.equal(taskDetailsPath('space:a/b?next', 41), '/api/console/sessions/space%3Aa%2Fb%3Fnext/handling?sourceUserSeq=41');
  for (const bad of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => taskDetailsPath('task-a', bad), /exact request identity/);
  }
  assert.throws(() => taskDetailsPath(' ', 41), /exact request identity/);
});

test('the lazy reader asks once for exactly the supplied source and carries cancellation', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const result = await getTaskDetails('task-a', 41, controller.signal, async (path, options) => {
    calls.push(path);
    assert.equal(options?.signal, controller.signal);
    assert.equal(options?.method, undefined, 'the endpoint is a read');
    return details();
  });
  assert.equal(result.sourceUserSeq, 41);
  assert.deepEqual(calls, ['/api/console/sessions/task-a/handling?sourceUserSeq=41']);
});

test('the client refuses another reply’s records even if a server returns them successfully', async () => {
  for (const wrong of [{ sessionId: 'task-b' }, { sourceUserSeq: 42 }, { version: 2 }]) {
    await assert.rejects(getTaskDetails('task-a', 41, undefined, async () => ({ ...details(), ...wrong } as TaskHandlingDetails)), /do not belong/);
  }
});

test('identity-correct malformed payloads become read errors instead of crashing the chat', async () => {
  const malformed: unknown[] = [
    { ...details(), tools: null }, { ...details(), models: {} }, { ...details(), limits: null },
    { ...details(), limitations: [null] }, { ...details(), usage: {} },
    { ...details(), memory: { provided: null } },
    { ...details(), memory: { provided: { recordedAt: '', sourceUserSeq: 41, manifest: [{ section: null }] }, recall: [] } },
    { ...details(), memory: { provided: null, recall: [{ id: 'r', surface: 'primer', createdAt: '', refs: [{ type: 'fact', id: '1', text: 42, outcome: 'used' }] }] } },
    { ...details(), tools: [tool({ name: 42 as unknown as string })] },
    { ...details(), tools: [tool({ selection: { kind: 'owner_preference', text: [] as unknown as string } })] },
    { ...details(), models: [model({ servedProvider: 42 as unknown as string })] },
    { ...details(), models: [model({ role: null as unknown as string })] },
    { ...details(), auxiliaryModels: null },
    { ...details(), auxiliaryModels: [auxiliary({ attemptId: 42 as unknown as string })] },
    { ...details(), auxiliaryModels: [auxiliary({ physicalAttempt: 0 })] },
    { ...details(), auxiliaryModels: [auxiliary({ dispatchCount: 1.5 })] },
    { ...details(), auxiliaryModels: [auxiliary({ callPurpose: 'raw_private_purpose' as TaskAuxiliaryModelRecord['callPurpose'] })] },
    { ...details(), limits: { ...details().limits, auxiliaryModelsTruncated: 'yes' } },
  ];
  for (const payload of malformed) await assert.rejects(getTaskDetails('task-a', 41, undefined, async () => payload), /could not be read/);
});

test('auxiliary records remain optional for old receipts and validated separately for new receipts', async () => {
  assert.equal((await getTaskDetails('task-a', 41, undefined, async () => details())).auxiliaryModels, undefined);
  const detail = details();
  detail.auxiliaryModels = [auxiliary({ callPurpose: 'jev-turn-start' })];
  detail.limits.auxiliaryModelsTruncated = false;
  const loaded = await getTaskDetails('task-a', 41, undefined, async () => detail);
  assert.equal(loaded.auxiliaryModels?.[0]?.callPurpose, 'jev-turn-start');
});

test('historical generic routing does not invent a specific helper purpose', () => {
  assert.equal(taskAuxiliaryPurpose(auxiliary({ role: 'router', requestedModel: 'Jev' })), 'Purpose not recorded');
  assert.equal(taskAuxiliaryPurpose(auxiliary({ callPurpose: 'jev-turn-start' })), 'Assessing how to start');
  assert.equal(taskAuxiliaryPurpose(auxiliary({ callPurpose: 'jev-completion' })), 'Reviewing completion');
  assert.equal(taskAuxiliaryPurpose(auxiliary({ callPurpose: 'jev-completion', evidence: 'conflicting' })), 'Purpose not recorded');
  for (const value of ['constructor', '__proto__', 'toString', 'private-stage']) {
    assert.equal(taskAuxiliaryPurpose(auxiliary({ callPurpose: value as TaskAuxiliaryModelRecord['callPurpose'] })), 'Purpose not recorded');
  }
});

test('a requested helper model never becomes a provider-confirmed response model', () => {
  const requested = taskAuxiliaryIdentity(auxiliary({ requestedModel: 'requested-helper', providerReportedModel: 'unconfirmed-helper' }));
  assert.equal(requested.name, 'Requested Helper'); assert.match(requested.note, /Requested model.*not confirmed/);
  const parsed = auxiliary({ requestedModel: 'requested-helper', providerReportedModel: 'actual-helper', responseCompleted: true, status: 'returned', evidence: 'parsed_response' });
  assert.deepEqual(taskAuxiliaryIdentity(parsed), { name: 'Actual Helper', note: 'Response model reported', requested: 'Requested Helper' });
  for (const patch of [{ evidence: 'conflicting' as const }, { evidence: 'incomplete' as const }, { status: 'failed' as const }, { responseCompleted: false }]) {
    assert.equal(taskAuxiliaryIdentity({ ...parsed, ...patch }).name, 'Requested Helper');
  }
  assert.equal(taskAuxiliaryIdentity(auxiliary()).name, 'Model not recorded');
});

test('a parsed helper response is not a passed review or a completed task', () => {
  assert.equal(taskAuxiliaryStatus(auxiliary({ responseCompleted: true, status: 'returned', evidence: 'parsed_response', callPurpose: 'jev-completion' })), 'Result parsed');
  assert.equal(taskAuxiliaryStatus(auxiliary({ status: 'returned' })), 'Result unconfirmed');
  assert.equal(taskAuxiliaryStatus(auxiliary({ evidence: 'conflicting' })), 'Observations disagree');
  assert.equal(taskAuxiliaryStatus(auxiliary({ status: 'failed' })), 'Request failed');
  assert.equal(taskAuxiliaryStatus(auxiliary({ status: 'cancelled' })), 'Cancelled');
});

test('call counts come only from canonical role totals, not route and observation array sizes', () => {
  const total = { calls: 3, failedCalls: 0, uncertifiedCalls: 1, unknownCostCalls: 1, promptTokens: 100,
    cachedReadTokens: 10, uncachedWorkTokens: 110, outputTokens: 20, reportedTotalTokens: 120, modelMs: 4000 };
  const detail = details(); detail.models = [model()]; detail.auxiliaryModels = [auxiliary(), auxiliary({ callId: 'auxiliary-b' })];
  detail.usage = { scope: 'accepted_source', meteringStartedAt: detail.acceptedAt, sourcePredatesMetering: false, totals: total,
    byRole: { brain: { ...total, calls: 1 }, router: { ...total, calls: 2 } } };
  assert.deepEqual(taskUsageRoles(detail), [{ label: 'Task work', calls: 1 }, { label: 'Routing', calls: 2 }]);
  detail.models.push(model({ callId: 'second-route' })); detail.auxiliaryModels.push(auxiliary({ callId: 'auxiliary-c' }));
  assert.deepEqual(taskUsageRoles(detail), [{ label: 'Task work', calls: 1 }, { label: 'Routing', calls: 2 }]);
  assert.match(taskUsageNotes(detail).join(' '), /do not have complete usage records.*Cost is unknown/);
  assert.deepEqual(taskUsageRoles({ ...detail, usage: null }), []);
});

test('route selection and a configured model never become proof of the answering model', () => {
  const route = taskModelIdentity(model({ servedModel: 'claimed-response-model' }));
  assert.equal(route.name, 'Route Model');
  assert.equal(route.confirmed, false);
  assert.match(route.note, /not confirmed/);
  const completeWithoutModel = taskModelIdentity(model({ status: 'success', responseCompleted: true }));
  assert.equal(completeWithoutModel.confirmed, false);
  const actual = taskModelIdentity(model({ responseCompleted: true, servedModel: 'served-model', providerReportedModel: 'provider-actual-2' }));
  assert.equal(actual.name, 'Provider Actual 2');
  assert.equal(actual.confirmed, true);
  assert.equal(taskModelStatus(model({ status: 'success', responseCompleted: false })), 'Completion not recorded');
});

test('a completed fallback names its actual provider and preserves the requested route separately', () => {
  assert.deepEqual(taskModelProvider(model({ provider: 'route-provider', servedProvider: 'actual-provider', responseCompleted: true })), {
    label: 'Actual provider', note: 'Requested provider: Route provider',
  });
  assert.deepEqual(taskModelProvider(model({ provider: 'route-provider', servedProvider: 'unconfirmed-provider' })), {
    label: 'Requested provider: Route provider', note: null,
  });
  assert.deepEqual(taskModelProvider(model({ provider: 'route-provider', responseCompleted: true })), {
    label: 'Requested provider: Route provider', note: 'Response provider not recorded',
  });
});

test('a returned read is a returned result, not a verified write or completed task', () => {
  assert.equal(taskToolStatus(tool()), 'Result returned');
  assert.equal(taskToolStatus(tool({ status: 'started' })), 'Result not recorded');
  assert.equal(taskToolStatus(tool({ status: 'reused' })), 'Reused a saved result');
  assert.equal(taskToolStatus(tool({ status: 'failed' })), 'Failed');
  assert.equal(taskToolEvidence(tool()), 'Call recorded; dispatch not confirmed');
  assert.equal(taskToolEvidence(tool({ dispatchEvidence: 'physical' })), 'Dispatch recorded');
  assert.equal(taskToolEvidence(tool({ dispatchEvidence: 'reused' })), 'Saved result; no new dispatch');
});

test('choice reasons require retained selection evidence, never nearby memory or a successful result', () => {
  assert.equal(taskToolReason(tool()), null);
  assert.equal(taskToolReason(tool({ selection: { kind: 'owner_preference', factId: 17, text: ' Use the local reader. ' } })), 'Saved preference recorded for this approach: Use the local reader.');
  assert.equal(taskToolReason(tool({ selection: { kind: 'owner_preference', factId: 17 } })), 'Saved preference recorded for this approach');
  assert.equal(taskToolReason(tool({ selection: { kind: 'prepared_approach', strategyId: 'route:tool-a' } })), 'Prepared tool choice recorded');
});

test('memory headings explain user context without exposing prompt-internal section names', () => {
  const detail = details();
  detail.memory.provided = { recordedAt: detail.acceptedAt, sourceUserSeq: 41, manifest: [
    '(header)', 'fact_primer', 'Relevant To This Request', 'Standing Policies', 'Proven Run Strategies', 'future_private_internal_section',
  ].map((section) => ({ section, tier: 'relevant', tokens: 2, bytes: 8, refs: [] })) };
  assert.deepEqual(taskMemorySections(detail), ['Relevant memories', 'Your standing instructions', 'Recorded tool approaches', 'Other saved context']);
});

test('unknown measurements stay unknown and model duration is explicitly individual call time', () => {
  assert.equal(recordedCount(undefined), 'Not recorded');
  assert.equal(recordedCount(NaN), 'Not recorded');
  assert.equal(recordedCount(-1), 'Not recorded');
  assert.equal(recordedCount(0), '0');
  assert.equal(recordedDuration(undefined), null);
  assert.equal(recordedDuration(NaN), null);
  assert.equal(recordedDuration(-10), null);
  assert.equal(recordedDuration(0), '0 ms');
  assert.equal(recordedDuration(1200), '1.2 s');
});

test('accepted-source usage retains incomplete, uncertain and billing limitations', () => {
  assert.deepEqual(taskUsageNotes(details()), ['Usage was not recorded for this request.']);
  const observed = details();
  observed.usage = {
    scope: 'accepted_source', meteringStartedAt: '2026-10-18T10:00:01Z', sourcePredatesMetering: true,
    totals: { calls: 3, failedCalls: 1, uncertifiedCalls: 1, unknownCostCalls: 1, promptTokens: 2100, cachedReadTokens: 1000,
      uncachedWorkTokens: 1600, outputTokens: 500, reportedTotalTokens: 2600, modelMs: 20000 }, byRole: {},
  };
  const notes = taskUsageNotes(observed).join(' ');
  assert.match(notes, /Linked tasks may have their own usage/);
  assert.match(notes, /incomplete/);
  assert.match(notes, /complete usage records/);
  assert.match(notes, /Cost is unknown/);
  assert.match(notes, /not a provider bill/);
  assert.match(notes, /elapsed time/);
});
