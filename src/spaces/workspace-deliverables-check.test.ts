/** Source-only controls: one existing checker, no provider/tool execution. */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { SpaceRecord } from './store.js';
import type { WorkspaceDeliverablesEvidence } from './workspace-deliverables-evidence.js';
import {
  _setWorkspaceDeliverablesReaderForTests, readWorkspaceDeliverables,
  renderWorkspaceDeliverables, workspaceDeliverablesUser,
  type WorkspaceDeliverablesInput,
} from './workspace-deliverables-check.js';

const record: SpaceRecord = {
  id: 'site-ops', title: 'Site Operations', status: 'active',
  contract: { objective: 'Manage the site and its backend.', successCriteria: ['Correct site'], invariants: ['Never auto-publish.'] },
  viewEntry: 'view/index.html', dataSources: [], actions: [], version: 1, revisions: [],
  createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z',
  contentMode: 'static_snapshot',
};
const input: WorkspaceDeliverablesInput = {
  request: 'Build a Workspace with the correct site, deploy status and blog previews.', record,
  viewHtml: '<h1>Site Operations</h1>', feeds: [{ workflow: 'Daily Blog Draft', collections: ['drafts'], enabled: false }],
  requestIdentity: { sessionId: 'fixture-check', sourceUserSeq: 42, runScopeId: 'fixture-attempt', callId: 'fixture-call' },
};
function evidence(): WorkspaceDeliverablesEvidence {
  return {
    version: 1, status: 'available', fingerprint: 'f'.repeat(64),
    snapshot: { workspaceId: record.id, version: 1, revision: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), viewSha256: 'c'.repeat(64), dataSha256: null, dataState: 'absent' },
    facts: [
      { id: 'saved-view', supports: ['saved_content'], detail: { text: 'Site Operations' } },
      { id: 'feed-1', supports: ['configuration'], detail: { workflow: 'Daily Blog Draft', enabled: false, executionVerified: false } },
    ],
    truncation: { text: false, links: false, datasets: false, configuration: false, fields: false },
    unavailableEvidence: ['data_readback', 'render_readback', 'operation_readback', 'deployment_relationship'], limitations: [],
  };
}
function answer(user: string, changes: Record<string, unknown> = {}): unknown {
  const packet = JSON.parse(user);
  return { bindingDigest: packet.bindingDigest, assessmentComplete: true,
    assessedCriteriaIds: packet.workspace.successCriteria.map((item: { id: string }) => item.id),
    deliverables: [{ deliverable: 'Requested saved content', status: 'covered', requiredEvidence: 'saved_content', evidenceIds: ['saved-view'], gap: '' }],
    ...changes };
}
function capture() { return evidence(); }
afterEach(() => _setWorkspaceDeliverablesReaderForTests(null));

test('full request, criteria, invariants and exact source remain in the bound input', () => {
  const request = 'x'.repeat(4_500) + ' The correct final domain must be checked.';
  const fixture = { ...input, request, record: { ...record, contract: { ...record.contract!, successCriteria: Array.from({ length: 12 }, (_, index) => `Outcome ${index + 1}`) } } };
  const packet = JSON.parse(workspaceDeliverablesUser(fixture, evidence()));
  assert.equal(packet.request, request);
  assert.equal(packet.workspace.successCriteria.length, 12);
  assert.equal(packet.workspace.successCriteria[11].text, 'Outcome 12');
  assert.deepEqual(packet.workspace.invariants, ['Never auto-publish.']);
  assert.deepEqual(packet.requestIdentity, input.requestIdentity);
  assert.notEqual(packet.bindingDigest, JSON.parse(workspaceDeliverablesUser({ ...fixture, requestIdentity: { ...input.requestIdentity!, sourceUserSeq: 43 } }, evidence())).bindingDigest);
});

test('requested static content can be covered without live feeds or a button', async () => {
  let calls = 0;
  _setWorkspaceDeliverablesReaderForTests(async (_system, user) => { calls++; return answer(user); });
  const result = await readWorkspaceDeliverables(input, { captureEvidence: capture });
  assert.equal(result.status, 'checked');
  assert.equal(renderWorkspaceDeliverables(result), '');
  assert.equal(calls, 1);
});

test('configured feed, working data, operation, rendering and deployment proof stay distinct', async () => {
  for (const requiredEvidence of ['data_readback', 'operation_readback', 'render_readback', 'deployment_relationship']) {
    _setWorkspaceDeliverablesReaderForTests(async (_system, user) => answer(user, { deliverables: [
      { deliverable: 'Operational outcome', status: 'covered', requiredEvidence, evidenceIds: ['feed-1'], gap: '' },
    ] }));
    const result = await readWorkspaceDeliverables(input, { captureEvidence: capture });
    assert.equal(result.status, 'checked');
    if (result.status === 'checked') assert.equal(result.deliverables[0].status, 'unverified');
    assert.match(renderWorkspaceDeliverables(result), /Not yet verified/);
  }
});

test('exact data readback fact supports data only, including legitimate empty success', async () => {
  const packet = evidence();
  packet.facts.push({ id: 'dataset-1', supports: ['data_readback', 'saved_content'], detail: { state: 'empty_success', count: 0 } });
  _setWorkspaceDeliverablesReaderForTests(async (_system, user) => answer(user, { deliverables: [
    { deliverable: 'Current read result', status: 'covered', requiredEvidence: 'data_readback', evidenceIds: ['dataset-1'], gap: '' },
  ] }));
  assert.equal(renderWorkspaceDeliverables(await readWorkspaceDeliverables(input, { captureEvidence: () => packet })), '');
});

test('mixed missing and unverified outcomes have separate useful next steps', async () => {
  _setWorkspaceDeliverablesReaderForTests(async (_system, user) => answer(user, { deliverables: [
    { deliverable: 'Preview panel', status: 'missing', requiredEvidence: 'saved_content', evidenceIds: ['saved-view'], gap: 'Add the requested preview panel.' },
    { deliverable: 'Refresh result', status: 'unverified', requiredEvidence: 'data_readback', evidenceIds: ['feed-1'], gap: 'Inspect the exact saved read result.' },
  ] }));
  const note = renderWorkspaceDeliverables(await readWorkspaceDeliverables(input, { captureEvidence: capture }));
  assert.match(note, /Not built yet \(1\)/);
  assert.match(note, /Not yet verified \(1\)/);
  assert.match(note, /Inspect the exact saved read result/);
});

test('omitted evidence cannot establish a missing outcome', async () => {
  const packet = evidence(); packet.truncation.text = true;
  _setWorkspaceDeliverablesReaderForTests(async (_system, user) => answer(user, { deliverables: [
    { deliverable: 'A later view section', status: 'missing', requiredEvidence: 'saved_content', evidenceIds: [], gap: 'Add it.' },
  ] }));
  const note = renderWorkspaceDeliverables(await readWorkspaceDeliverables(input, { captureEvidence: () => packet }));
  assert.match(note, /Not yet verified/); assert.doesNotMatch(note, /Not built yet/);
});

test('every saved criterion must be assessed, including more than eight', async () => {
  const fixture = { ...input, record: { ...record, contract: { ...record.contract!, successCriteria: Array.from({ length: 12 }, (_, index) => `Outcome ${index + 1}`) } } };
  _setWorkspaceDeliverablesReaderForTests(async (_system, user) => answer(user, { assessedCriteriaIds: ['criterion-1'] }));
  const result = await readWorkspaceDeliverables(fixture, { captureEvidence: capture });
  assert.equal(result.status, 'checked');
  if (result.status === 'checked') assert.equal(result.assessmentComplete, false);
  assert.match(renderWorkspaceDeliverables(result), /did not assess every/);
});

test('partial whole-request assessment stays unqualified even with covered entries', async () => {
  _setWorkspaceDeliverablesReaderForTests(async (_system, user) => answer(user, { assessmentComplete: false }));
  assert.match(renderWorkspaceDeliverables(await readWorkspaceDeliverables(input, { captureEvidence: capture })), /whole task remains unverified/);
});

test('malformed, partial, empty, fabricated-reference and wrong-binding answers never look clean', async () => {
  for (const change of [
    { deliverables: [] }, { deliverables: [{ deliverable: 'Bad', covered: true }] },
    { deliverables: [{ deliverable: 'Bad', status: 'covered', requiredEvidence: 'saved_content', evidenceIds: ['invented'], gap: '' }] },
    { bindingDigest: '0'.repeat(64) }, { assessedCriteriaIds: ['invented-criterion'] }, { extra: true },
  ]) {
    let calls = 0;
    _setWorkspaceDeliverablesReaderForTests(async (_system, user) => { calls++; return answer(user, change); });
    const result = await readWorkspaceDeliverables(input, { captureEvidence: capture });
    assert.deepEqual(result.status, 'unavailable');
    assert.match(renderWorkspaceDeliverables(result), /not yet verified/);
    assert.equal(calls, 1, 'invalid answers do not buy another review');
  }
});

test('missing request or evidence starts no reader', async () => {
  let calls = 0;
  _setWorkspaceDeliverablesReaderForTests(async () => { calls++; throw new Error('must not call'); });
  const noRequest = await readWorkspaceDeliverables({ ...input, request: '' }, { captureEvidence: capture });
  assert.equal(noRequest.status, 'unavailable');
  const packet: WorkspaceDeliverablesEvidence = { ...evidence(), status: 'unavailable', reason: 'fixture_unreadable', snapshot: null };
  const noEvidence = await readWorkspaceDeliverables(input, { captureEvidence: () => packet });
  assert.equal(noEvidence.status, 'unavailable');
  assert.equal(calls, 0);
});

test('full input overflow is explicit rather than silently dropping requirements', async () => {
  let calls = 0;
  _setWorkspaceDeliverablesReaderForTests(async () => { calls++; throw new Error('must not call'); });
  const result = await readWorkspaceDeliverables({ ...input, request: 'x'.repeat(100_000) }, { captureEvidence: capture });
  assert.equal(result.status, 'unavailable');
  if (result.status === 'unavailable') assert.equal(result.reason, 'input_too_large');
  assert.equal(calls, 0);
});

test('a changed saved revision or feed state rejects the old answer without retrying', async () => {
  for (const kind of ['revision', 'feed']) {
    let captures = 0; let calls = 0;
    _setWorkspaceDeliverablesReaderForTests(async (_system, user) => { calls++; return answer(user); });
    const result = await readWorkspaceDeliverables(input, { captureEvidence: () => {
      const packet = evidence();
      if (++captures === 2 && packet.status === 'available') {
        if (kind === 'revision') packet.snapshot.revision = 'd'.repeat(64);
        else packet.facts[1].detail = { enabled: true };
      }
      return packet;
    } });
    assert.equal(result.status, 'unavailable');
    if (result.status === 'unavailable') assert.equal(result.reason, 'stale_revision');
    assert.equal(calls, 1);
  }
});

test('pre-aborted Stop starts no capture or model call', async () => {
  const controller = new AbortController(); controller.abort(); let captures = 0; let calls = 0;
  _setWorkspaceDeliverablesReaderForTests(async () => { calls++; return {}; });
  const result = await readWorkspaceDeliverables(input, { signal: controller.signal, captureEvidence: () => { captures++; return evidence(); } });
  assert.equal(result.status, 'unavailable');
  if (result.status === 'unavailable') assert.equal(result.reason, 'cancelled');
  assert.equal(captures, 0); assert.equal(calls, 0);
});

test('Stop settles promptly even if a reader ignores abort and later returns', async () => {
  const controller = new AbortController(); let finish!: (value: unknown) => void; let user = '';
  let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
  _setWorkspaceDeliverablesReaderForTests(async (_system, packet) => { user = packet; started(); return new Promise(resolve => { finish = resolve; }); });
  const pending = readWorkspaceDeliverables(input, { signal: controller.signal, captureEvidence: capture });
  await entered; controller.abort();
  const result = await pending;
  assert.equal(result.status, 'unavailable');
  if (result.status === 'unavailable') assert.equal(result.reason, 'cancelled');
  finish(answer(user)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.status, 'unavailable');
});

test('one absolute deadline bounds a noncooperating capture or reader', async () => {
  for (const phase of ['capture', 'reader']) {
    let calls = 0;
    _setWorkspaceDeliverablesReaderForTests(async () => { calls++; return new Promise(() => {}); });
    const start = Date.now();
    const result = await readWorkspaceDeliverables(input, { deadlineAt: Date.now() + 20,
      captureEvidence: phase === 'capture' ? () => new Promise(() => {}) : capture });
    assert.equal(result.status, 'unavailable');
    if (result.status === 'unavailable') assert.equal(result.reason, 'timeout');
    assert.ok(Date.now() - start < 1_000);
    assert.equal(calls, phase === 'capture' ? 0 : 1);
  }
});

test('lost invocation ownership cannot qualify a late answer', async () => {
  let active = true;
  _setWorkspaceDeliverablesReaderForTests(async (_system, user) => { active = false; return answer(user); });
  const result = await readWorkspaceDeliverables(input, { captureEvidence: capture, checkActive: () => { if (!active) throw new Error('stale owner'); } });
  assert.equal(result.status, 'unavailable');
  if (result.status === 'unavailable') assert.equal(result.reason, 'cancelled');
});

test('unavailable operation, rendering or relationship proof cannot be called structurally missing', async () => {
  for (const requiredEvidence of ['operation_readback', 'render_readback', 'deployment_relationship']) {
    _setWorkspaceDeliverablesReaderForTests(async (_system, user) => answer(user, { deliverables: [
      { deliverable: 'Unobserved outcome', status: 'missing', requiredEvidence, evidenceIds: [], gap: 'Rebuild it.' },
    ] }));
    const note = renderWorkspaceDeliverables(await readWorkspaceDeliverables(input, { captureEvidence: capture }));
    assert.match(note, /Not yet verified/); assert.doesNotMatch(note, /Not built yet|Rebuild it/);
  }
});

test('request, effective objective, identity and same-length criteria drift invalidate an old packet', async () => {
  for (const field of ['request', 'objective', 'identity', 'criteria', 'invariants']) {
    const fixture: WorkspaceDeliverablesInput = { ...input, requestIdentity: { ...input.requestIdentity! },
      record: { ...record, contract: { ...record.contract!, successCriteria: [...record.contract!.successCriteria], invariants: [...record.contract!.invariants] } } };
    _setWorkspaceDeliverablesReaderForTests(async (_system, user) => {
      if (field === 'request') fixture.request = 'A changed request';
      if (field === 'objective') fixture.effectiveObjective = 'A different effective task';
      if (field === 'identity') fixture.requestIdentity!.sourceUserSeq++;
      if (field === 'criteria') fixture.record.contract!.successCriteria[0] = 'A different criterion';
      if (field === 'invariants') fixture.record.contract!.invariants[0] = 'A changed standing restriction';
      return answer(user);
    });
    const result = await readWorkspaceDeliverables(fixture, { captureEvidence: capture });
    assert.equal(result.status, 'unavailable');
    if (result.status === 'unavailable') assert.equal(result.reason, 'stale_revision');
  }
});

test('synchronous final capture cannot outrun the absolute deadline before a timer tick', async () => {
  const originalNow = Date.now; let now = originalNow(); let captures = 0;
  Date.now = () => now;
  try {
    _setWorkspaceDeliverablesReaderForTests(async (_system, user) => answer(user));
    const result = await readWorkspaceDeliverables(input, { deadlineAt: now + 1_000, captureEvidence: () => {
      if (++captures === 2) now += 2_000;
      return evidence();
    } });
    assert.equal(result.status, 'unavailable');
    if (result.status === 'unavailable') assert.equal(result.reason, 'timeout');
  } finally { Date.now = originalNow; }
});


test('optional absent host identity fields use the same JSON binding as the emitted packet', () => {
  const fixture = { ...input, requestIdentity: { ...input.requestIdentity!, settlementNonce: undefined, runAttemptId: undefined } };
  const packet = JSON.parse(workspaceDeliverablesUser(fixture, evidence()));
  assert.match(packet.bindingDigest, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(packet.requestIdentity, 'runAttemptId'), false);
  assert.equal(packet.bindingDigest, JSON.parse(workspaceDeliverablesUser(input, evidence())).bindingDigest);
});
