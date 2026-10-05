import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAutomaticMemoryOrigin, createAutomaticMemoryEnvelope, withAutomaticMemoryDecision,
  automaticMemoryCandidateIdentity, automaticMemoryOriginDigest, automaticMemoryDecisionDigest,
  parseAutomaticMemoryEnvelope, resolveAutomaticMemoryDestination,
  type AutomaticMemoryOriginInput, type AutomaticMemoryDecision,
} from './memory-destination.js';

const text = 'Remember that reports use blue headings, only in this project.';
function input(): AutomaticMemoryOriginInput {
  return { source: { authority: 'accepted_user_input', sessionId: 'destination-fixture',
    eventId: 'event-7', eventSeq: 7, eventType: 'user_input_received', ownerText: text,
    context: { sessionId: 'destination-fixture', sourceUserSeq: 7, digest: 'a'.repeat(64),
      memoryScope: { projectId: 'project-A', agentKey: 'specialist@created-A' } } },
  claim: { start: 14, end: text.length }, claimMode: 'complete', candidate: { kind: 'user', text: text.slice(14) } };
}
function decision(destination: AutomaticMemoryDecision['destination'] = 'current_project'): AutomaticMemoryDecision {
  return { durability: 'standing', claim: input().claim, destination,
    destinationSpans: destination === 'kind_default' ? [] : [{ start: text.indexOf('only'), end: text.length }],
    reason: 'The exact owner clause specifies this destination.' };
}
const envelope = () => createAutomaticMemoryEnvelope(createAutomaticMemoryOrigin(input()));

test('project destination drops agent dimension without changing the complete claim', () => {
  const out = resolveAutomaticMemoryDestination(withAutomaticMemoryDecision(envelope(), decision()));
  assert.deepEqual(out, { status: 'resolved', scope: { projectId: 'project-A', agentKey: null }, claimText: text.slice(14) });
});
test('checked kind default preserves user and constraint global semantics', () => {
  for (const kind of ['user', 'constraint'] as const) {
    const source = input(); source.candidate.kind = kind;
    const out = resolveAutomaticMemoryDestination(withAutomaticMemoryDecision(createAutomaticMemoryEnvelope(createAutomaticMemoryOrigin(source)), decision('kind_default')));
    assert.equal(out.status, 'resolved');
    if (out.status === 'resolved') assert.deepEqual(out.scope, { projectId: null, agentKey: null });
  }
});
test('non-global default retains the frozen project and agent incarnation', () => {
  const source = input(); source.candidate.kind = 'project';
  const out = resolveAutomaticMemoryDestination(withAutomaticMemoryDecision(createAutomaticMemoryEnvelope(createAutomaticMemoryOrigin(source)), decision('kind_default')));
  assert.equal(out.status, 'resolved');
  if (out.status === 'resolved') assert.deepEqual(out.scope, source.source.context!.memoryScope);
});
test('pending, unknown scope and task durability are distinct negative outcomes', () => {
  assert.equal(resolveAutomaticMemoryDestination(envelope()).status, 'unresolved');
  assert.equal(resolveAutomaticMemoryDestination(withAutomaticMemoryDecision(envelope(), { ...decision(), destination: 'unresolved' })).status, 'unresolved');
  assert.equal(resolveAutomaticMemoryDestination(withAutomaticMemoryDecision(envelope(), { ...decision(), durability: 'task', destination: 'unresolved' })).status, 'task');
  const source = input(); source.source.context!.memoryScope.projectId = null;
  assert.equal(resolveAutomaticMemoryDestination(withAutomaticMemoryDecision(createAutomaticMemoryEnvelope(createAutomaticMemoryOrigin(source)), decision())).status, 'unresolved');
});
test('missing historical context cannot become default-global', () => {
  const source = input(); source.source.context = null;
  const out = withAutomaticMemoryDecision(createAutomaticMemoryEnvelope(createAutomaticMemoryOrigin(source)), decision('kind_default'));
  assert.equal(resolveAutomaticMemoryDestination(out).status, 'unresolved');
});
test('explicit current context needs a local identity while global choices retain their semantics', () => {
  const source = input();
  source.source.context!.memoryScope = { projectId: null, agentKey: null };
  const make = () => createAutomaticMemoryEnvelope(createAutomaticMemoryOrigin(source));
  assert.equal(resolveAutomaticMemoryDestination(withAutomaticMemoryDecision(make(), decision('current_context'))).status, 'unresolved');
  for (const choice of ['kind_default', 'everywhere'] as const) {
    const out = resolveAutomaticMemoryDestination(withAutomaticMemoryDecision(make(), decision(choice)));
    assert.equal(out.status, 'resolved');
    if (out.status === 'resolved') assert.deepEqual(out.scope, { projectId: null, agentKey: null });
  }
  for (const scope of [{ projectId: 'project-A', agentKey: null }, { projectId: null, agentKey: 'specialist@created-A' }]) {
    source.source.context!.memoryScope = scope;
    const out = resolveAutomaticMemoryDestination(withAutomaticMemoryDecision(make(), decision('current_context')));
    assert.equal(out.status, 'resolved');
    if (out.status === 'resolved') assert.deepEqual(out.scope, scope);
  }
});
test('claim mode preserves complete assertions but lets unjudged source select a contiguous claim', () => {
  const shorter = { ...decision(), claim: { start: 14, end: text.indexOf(',') } };
  assert.throws(() => withAutomaticMemoryDecision(envelope(), shorter), /authorized claim/);
  const source = input(); source.claimMode = 'selectable'; source.claim = { start: 0, end: text.length };
  assert.doesNotThrow(() => withAutomaticMemoryDecision(createAutomaticMemoryEnvelope(createAutomaticMemoryOrigin(source)), shorter));
  source.claimMode = 'unresolved';
  assert.throws(() => withAutomaticMemoryDecision(createAutomaticMemoryEnvelope(createAutomaticMemoryOrigin(source)), shorter), /Unresolved claim/);
});
test('explicit destination requires source evidence and model-supplied scope IDs are rejected', () => {
  assert.throws(() => withAutomaticMemoryDecision(envelope(), { ...decision(), destinationSpans: [] }), /owner source span/);
  assert.throws(() => withAutomaticMemoryDecision(envelope(), { ...decision(), projectId: 'other-project' } as AutomaticMemoryDecision));
});
test('origin parsing rejects changed bytes, foreign context and malformed spans', () => {
  const changed = envelope(); changed.origin.source.ownerText += ' Changed';
  assert.throws(() => parseAutomaticMemoryEnvelope(changed), /digest/);
  const foreign = input(); foreign.source.context!.sourceUserSeq = 8;
  assert.throws(() => createAutomaticMemoryOrigin(foreign), /different accepted source/);
  const split = input(); split.source.ownerText = 'A😀B'; split.claim = { start: 1, end: 2 };
  assert.throws(() => createAutomaticMemoryOrigin(split), /source character/);
  const extra = { ...envelope(), extraAuthority: true };
  assert.throws(() => parseAutomaticMemoryEnvelope(extra));
});
test('kind/context changes conflict on the same candidate identity instead of minting another key', () => {
  const original = createAutomaticMemoryOrigin(input());
  const change = input(); change.candidate.kind = 'constraint'; change.source.context!.memoryScope.projectId = 'project-B';
  const changed = createAutomaticMemoryOrigin(change);
  assert.equal(automaticMemoryCandidateIdentity(original), automaticMemoryCandidateIdentity(changed));
  assert.notEqual(automaticMemoryOriginDigest(original), automaticMemoryOriginDigest(changed));
});
test('decision is single-assignment and its canonical digest binds the original claim', () => {
  const original = envelope();
  const saved = withAutomaticMemoryDecision(original, decision());
  assert.equal(automaticMemoryDecisionDigest(original), null);
  assert.equal(automaticMemoryDecisionDigest(saved), automaticMemoryDecisionDigest(parseAutomaticMemoryEnvelope(JSON.stringify(saved))));
  assert.doesNotThrow(() => withAutomaticMemoryDecision(saved, decision()));
  assert.throws(() => withAutomaticMemoryDecision(saved, decision('everywhere')), /already frozen/);
});
