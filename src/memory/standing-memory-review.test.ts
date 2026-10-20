import assert from 'node:assert/strict';
import test from 'node:test';
import { explicitMemoryNeedsScopeReview, parseStandingMemoryReview } from './standing-memory-review.js';

test('explicit candidates with remaining clauses need scope review; complete claims do not', () => {
  assert.equal(explicitMemoryNeedsScopeReview('Remember that reports use minutes.', 'reports use minutes.'), false);
  assert.equal(explicitMemoryNeedsScopeReview('Remember reports use minutes!', 'reports use minutes'), false);
  assert.equal(explicitMemoryNeedsScopeReview('Remember reports should show completed items and show minutes.',
    'reports should show completed items'), true);
  assert.equal(explicitMemoryNeedsScopeReview('Remember reports use minutes. Then show today’s report.',
    'reports use minutes.'), true);
  assert.equal(explicitMemoryNeedsScopeReview('Read today’s report. Remember reports use minutes.',
    'reports use minutes.'), false);
});

test('a standing review keeps only the grounded future clause of a mixed task', () => {
  const clause = 'Every Monday, send the digest to my review list unless I cancel it.';
  const source = `Build a board now. ${clause} Use a blue heading on the board.`;
  const review = parseStandingMemoryReview(JSON.stringify({ scope: 'standing', text: clause, reason: 'Recurring request' }), source);
  assert.equal(review.text, clause);
  assert.doesNotMatch(review.text!, /board|blue/);
});

test('a task-only review cannot smuggle a candidate into durable memory', () => {
  assert.deepEqual(parseStandingMemoryReview({ scope: 'task', text: 'Always save the board', reason: 'Artifact requirement' }, 'Build a board'),
    { scope: 'task', reason: 'Artifact requirement' });
});

test('invented standing text and malformed classifications remain retryable errors', () => {
  const source = 'Build a board and always preserve its task filter.';
  for (const value of [null, {}, { scope: 'permanent', reason: 'guess' },
    { scope: 'standing', text: '', reason: 'empty' },
    { scope: 'standing', text: 'Always create a board for every request.', reason: 'invented' }]) {
    assert.throws(() => parseStandingMemoryReview(value, source));
  }
});


test('an owner-authorized remember cannot be rejected on durability; the reviewer only places it', async () => {
  const { createAutomaticMemoryOrigin } = await import('./memory-destination.js');
  const { parseAutomaticStandingMemoryReview } = await import('./standing-memory-review.js');
  const source = 'Remember that the R45 test fixture shelf code is TANGERINE-7.';
  const origin = createAutomaticMemoryOrigin({ source: { authority: 'accepted_user_input', sessionId: 'review-explicit',
    eventId: 'event-2', eventSeq: 2, eventType: 'user_input_received', ownerText: source,
    context: { sessionId: 'review-explicit', sourceUserSeq: 2, digest: 'b'.repeat(64), memoryScope: { projectId: null, agentKey: null } } },
    claim: { start: 14, end: source.length }, claimMode: 'complete', candidate: { kind: 'user', text: source.slice(14) } });
  // Live 2026-10-20 (Haiku 5.5): "a test fixture code … a test contract rather than standing owner policy".
  const taskVerdict = { durability: 'task', claim: origin.claim, destination: 'kind_default', destinationSpans: [], reason: 'test contract, not policy' };
  const authorized = parseAutomaticStandingMemoryReview(taskVerdict, origin, { ownerAuthorized: true });
  assert.equal(authorized.scope, 'standing');
  assert.equal(authorized.text, source.slice(14));
  assert.equal(authorized.destinationDecision?.destination, 'kind_default');
  assert.match(authorized.reason, /owner authorized remembering/);
  // Without the owner's authorization the reviewer's task verdict stands.
  assert.equal(parseAutomaticStandingMemoryReview(taskVerdict, origin).scope, 'task');
});

test('automatic review requires checked destination and complete raw claim, preserving old durability parser', async () => {
  const { createAutomaticMemoryOrigin } = await import('./memory-destination.js');
  const { parseAutomaticStandingMemoryReview } = await import('./standing-memory-review.js');
  const source = 'Remember this: heading is BLUE and footnote is GOLD, only in this project.';
  const origin = createAutomaticMemoryOrigin({ source: { authority: 'accepted_user_input', sessionId: 'review-source',
    eventId: 'event-1', eventSeq: 1, eventType: 'user_input_received', ownerText: source,
    context: { sessionId: 'review-source', sourceUserSeq: 1, digest: 'a'.repeat(64), memoryScope: { projectId: 'project-A', agentKey: null } } },
    claim: { start: 15, end: source.length }, claimMode: 'complete', candidate: { kind: 'user', text: source.slice(15) } });
  assert.throws(() => parseAutomaticStandingMemoryReview({ scope: 'standing', text: source.slice(15), reason: 'missing destination' }, origin));
  const decision = { durability: 'standing', claim: origin.claim, destination: 'current_project',
    destinationSpans: [{ start: source.indexOf('only'), end: source.length }], reason: 'Explicit current project' };
  assert.equal(parseAutomaticStandingMemoryReview(decision, origin).text, source.slice(15));
  assert.throws(() => parseAutomaticStandingMemoryReview({ ...decision, claim: { start: 15, end: source.indexOf(' and') } }, origin));
  assert.throws(() => parseAutomaticStandingMemoryReview({ ...decision, destinationSpans: [] }, origin));
  assert.throws(() => parseAutomaticStandingMemoryReview({ ...decision, projectId: 'model-selected-foreign-project' }, origin));
});
