/** Memory-operation containers belong to ordinary tools, not one automatic fact.
 * The canonical isolated runner owns the disposable home and provider boundary.
 * These regressions never drain candidates or invoke a model.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';

assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1', 'run with the canonical isolated test launcher');
assert.ok(process.env.CLEMENTINE_HOME, 'the launcher must supply the disposable home before imports');

const capture = await import('./auto-capture.js');
const queue = await import('./durable-consolidation.js');
const candidates = await import('./reflection-candidates.js');
const memory = await import('./db.js');
const scopes = await import('./memory-scope.js');
const events = await import('../runtime/harness/eventlog.js');
const contexts = await import('../runtime/harness/source-session-context.js');
const contextScopes = await import('../runtime/harness/source-session-context-scope.js');
const projects = await import('../projects/project-record.js');
const { setSessionProject } = await import('../projects/session-project.js');
after(() => { memory.closeMemoryDb(); events.closeEventLog(); projects._closeProjectStoreForTests(); });

const outline = 'Our preferred proposal brief outline is: Outcomes, Evidence, Work plan, Commercial terms, Open questions.';
const amount = 'The setup amount for synthetic fixture CLEM-PLURAL-MEMORY-COMMAND is $1,200.';
const operationTail = 'Confirm what you actually saved and disclose anything unfinished. '
  + 'This is synthetic framework acceptance in this project only. Preserve unrelated memory. '
  + 'Do not change settings or projects, run workflows, write files, contact external services, or reset memory.';
const bareContainer = `Remember two separate standing facts for synthetic fixture CLEM-PLURAL-MEMORY-COMMAND in this project only. ${outline} ${amount} ${operationTail}`;
const containers = [
  bareContainer,
  `Remember these two separate standing facts in this project only: ${outline} ${amount} ${operationTail}`,
  `Remember the following preferences in this project only: ${outline} ${amount} ${operationTail}`,
];
const unrelatedClaim = 'the Falcon project owner is Mira Vale.';

test('automatic producer defers a plural operation without resurrecting it through the unmatched-owner fallback', () => {
  const before = memory.openMemoryDb().prepare('SELECT count(*) n FROM memory_reflection_candidates').get();
  for (const message of containers) {
    assert.ok(capture.explicitMemoryInstructionFor(message), 'deferral must not cancel the explicit memory request');
    const produced = capture.captureInteractionSignals({ message,
      sourceProvenance: capture.autoCaptureProvenanceFromDirectUserInput('chat') });
    assert.deepEqual(produced.candidates, [], 'the real producer must not recreate an unmatched owner candidate or pinned constraint');
    assert.deepEqual(produced.facts, []);
    assert.deepEqual(produced.queuedCandidateIds ?? [], []);
    assert.equal(produced.episodeId ?? null, null, 'no automatic episode may imply that these separate tool saves are complete');
    assert.equal(produced.profilePatch, undefined);
  }
  assert.deepEqual(memory.openMemoryDb().prepare('SELECT count(*) n FROM memory_reflection_candidates').get(), before);
});

test('automatic selector excludes the operation container and its task-only instructions', () => {
  for (const message of containers) {
    assert.equal(capture.parseExplicitMemoryInstruction(message)?.kind, 'remember');
    assert.deepEqual(capture.extractAutoMemoryCandidates(message), []);
    assert.deepEqual(capture.selectAutoMemoryCandidates(message), [], 'an empty extraction is a deferral, not a fallback opportunity');
  }
});

let serial = 0;
function sourceFixture(message: string) {
  const sessionId = `plural-memory-command-${++serial}`;
  events.createSession({ id: sessionId, kind: 'chat' });
  const project = projects.createProject({ name: `Plural memory command ${serial}`, context: 'Controlled disposable framework fixture.' });
  assert.ok(project.ok); if (!project.ok) throw new Error('fixture project');
  assert.ok(setSessionProject(sessionId, project.project.id, { by: 'owner' }).ok);
  const event = events.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: message } });
  return { sessionId, projectId: project.project.id, event, sourceUserSeq: event.seq };
}

test('a fresh accepted source freezes the new producer behavior while retaining the complete owner input', () => {
  const fixture = sourceFixture(bareContainer);
  const source = { sessionId: fixture.sessionId, sourceUserSeq: fixture.sourceUserSeq };
  const context = contexts.captureFreshSourceSessionContext(source); assert.ok(context);
  const edition = contextScopes.sourceMemoryCaptureEdition(context);
  assert.notEqual(edition, 'legacy_v1');
  assert.notEqual(edition, 'save_operation_v2', 'historical complete-container decisions require their original producer');
  assert.deepEqual(capture.selectAutoMemoryCandidates(bareContainer, 3, edition), []);
  assert.ok(capture.explicitMemoryInstructionFor(bareContainer));
  const reopened = contexts.readSourceSessionContext(source, context.digest); assert.ok(reopened);
  assert.equal(contextScopes.sourceMemoryCaptureEdition(reopened), edition);
  assert.deepEqual(reopened.memoryScope, { projectId: fixture.projectId, agentKey: null });
  const accepted = events.listEvents(fixture.sessionId, { types: ['user_input_received'] }).find(row => row.seq === fixture.sourceUserSeq);
  assert.equal(accepted?.data.text, bareContainer, 'the tools still receive every requested claim, scope and restriction');
});

test('deferring one container preserves an independent later simple remember command', () => {
  const message = `${bareContainer} Also remember that ${unrelatedClaim}`;
  const selected = capture.selectAutoMemoryCandidates(message);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.content, unrelatedClaim);
  assert.equal(selected[0]?.reason, 'explicit remember request');
  assert.notEqual(selected[0]?.pin, true);
});

test('actual claims, connected assertions and literal command wording remain complete eligible memories', () => {
  const controls = [
    { message: `Remember that ${unrelatedClaim}`, content: unrelatedClaim },
    { message: 'Remember that the report cutoff is Friday and the review owner is Morgan.',
      content: 'the report cutoff is Friday and the review owner is Morgan.' },
    { message: 'Remember that two separate facts are required by the archive policy.',
      content: 'two separate facts are required by the archive policy.' },
    { message: 'Remember this: the following preferences are documented in the archive.',
      content: 'the following preferences are documented in the archive.' },
    { message: 'Remember exactly: "two separate standing facts: Confirm what you saved. Do not write files."',
      content: 'two separate standing facts: Confirm what you saved. Do not write files.' },
    { message: 'Remember "the following preferences".', content: '"the following preferences".' },
  ];
  for (const control of controls) {
    const selected = capture.selectAutoMemoryCandidates(control.message);
    assert.equal(selected.length, 1, control.message);
    assert.equal(selected[0]?.content, control.content);
    assert.equal(selected[0]?.reason, 'explicit remember request');
  }
  const prohibition = capture.selectAutoMemoryCandidates('Remember that from now on, do not send project reports to external recipients.');
  assert.equal(prohibition.length, 1);
  assert.equal(prohibition[0]?.pin, true, 'a real standing safety rule keeps its existing authority');
});

test('privacy opt-outs and unresolved memory references still win over automatic capture', () => {
  assert.deepEqual(capture.selectAutoMemoryCandidates(`${bareContainer} Do not save anything from this turn to memory.`), []);
  assert.deepEqual(capture.selectAutoMemoryCandidates('Remember that correction. Confirm what you saved.'), []);
});

test('plural framing preserves an already-enforceable sender rule and genuine standing prohibition', () => {
  const sender = 'Remember two separate standing project rules: project email must always be sent from reports@example.test. The archive label is COPPER.';
  const senderCandidates = capture.selectAutoMemoryCandidates(sender);
  assert.equal(senderCandidates.length, 1);
  assert.equal(senderCandidates[0]?.kind, 'constraint');
  assert.equal(senderCandidates[0]?.pin, true);
  assert.equal(senderCandidates[0]?.reason, 'enforceable sender/account routing rule');
  assert.ok(senderCandidates[0]?.content.includes('from reports@example.test'));
  assert.deepEqual(senderCandidates, capture.selectAutoMemoryCandidates(sender, 3, 'save_operation_v2'),
    'container deferral must not change existing recognized routing authority');

  const prohibition = 'Remember two separate standing project rules: from now on, do not send project reports to external recipients. The archive label is COPPER.';
  const prohibitionCandidates = capture.selectAutoMemoryCandidates(prohibition);
  assert.equal(prohibitionCandidates.length, 1);
  assert.equal(prohibitionCandidates[0]?.pin, true);
  assert.equal(prohibitionCandidates[0]?.reason, 'safety-critical prohibition (auto-pinned)');
  assert.deepEqual(prohibitionCandidates, capture.selectAutoMemoryCandidates(prohibition, 3, 'save_operation_v2'),
    'plural framing does not waive a real standing safety instruction');
});

test('an independent task-only sender choice cannot lend standing routing authority to a deferred container', () => {
  const message = `Remember two separate project facts: ${outline} ${amount} Then send the draft email only from staging@example.test for this task.`;
  assert.ok(capture.explicitMemoryInstructionFor(message));
  assert.deepEqual(capture.selectAutoMemoryCandidates(message), []);
});

test('an explicitly retained v2 source keeps its complete candidate, exact origin and idempotent reopen/replay', () => {
  // Construct a new historical identity, never rewrite an accepted context.
  const template = sourceFixture('Establish the controlled historical project context.');
  const templateContext = contexts.captureFreshSourceSessionContext(template); assert.ok(templateContext);
  const source = events.appendEvent({ sessionId: template.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: bareContainer } });
  const table = () => events.openEventLog().prepare('SELECT identity_json, identity_digest FROM source_session_contexts_v1 WHERE session_id=? AND source_user_seq=?');
  const original = table().get(template.sessionId, template.sourceUserSeq) as { identity_json: string; identity_digest: string };
  const identity = { ...JSON.parse(original.identity_json), sourceUserSeq: source.seq, memoryCaptureEdition: 'save_operation_v2' };
  const identityJson = JSON.stringify(identity);
  const identityDigest = createHash('sha256').update(identityJson).digest('hex');
  events.openEventLog().prepare('INSERT INTO source_session_contexts_v1 (session_id,source_user_seq,identity_json,identity_digest) VALUES (?,?,?,?)')
    .run(template.sessionId, source.seq, identityJson, identityDigest);
  const ref = { sessionId: template.sessionId, sourceUserSeq: source.seq };
  const retained = contexts.readSourceSessionContext(ref, identityDigest); assert.ok(retained);
  assert.equal(contextScopes.sourceMemoryCaptureEdition(retained), 'save_operation_v2');
  const selected = capture.selectAutoMemoryCandidates(bareContainer, 3, contextScopes.sourceMemoryCaptureEdition(retained));
  assert.equal(selected.length, 1, 'the historical producer remains available even though the current producer defers');
  const historicalClaim = bareContainer.slice('Remember '.length);
  assert.equal(selected[0]?.content, historicalClaim);
  const input = { message: bareContainer, sessionId: template.sessionId, sourceEventId: `user-source:${source.seq}`,
    sourceProvenance: capture.autoCaptureProvenanceFromAcceptedEvent(source) };
  const origins = capture.automaticMemoryOriginsForCapture(input, selected);
  assert.equal(origins[0]?.claimMode, 'complete');
  assert.deepEqual(origins[0]?.claim, { start: 'Remember '.length, end: bareContainer.length });
  assert.equal(origins[0]?.source.ownerText, bareContainer);
  const first = queue.enqueueAutoCaptureCandidates({ ...input, candidates: selected, origins });
  assert.equal(first.candidateIds.length, 1); assert.ok(first.episodeId);
  const beforeContext = table().get(template.sessionId, source.seq);
  memory.closeMemoryDb(); events.closeEventLog();
  const reopened = candidates.readAutomaticMemoryCandidate(first.candidateIds[0]!);
  assert.equal(reopened.status, 'valid'); if (reopened.status !== 'valid') throw new Error('fixture candidate');
  assert.equal(reopened.row.text, historicalClaim);
  assert.equal(reopened.envelope.origin.claimMode, 'complete');
  const boundContext = reopened.envelope.origin.source.context; assert.ok(boundContext);
  const reopenedContext = contexts.readSourceSessionContext(boundContext, boundContext.digest); assert.ok(reopenedContext);
  assert.equal(contextScopes.sourceMemoryCaptureEdition(reopenedContext), 'save_operation_v2');
  assert.deepEqual(reopened.envelope.origin.source.context?.memoryScope, retained.memoryScope);
  assert.deepEqual(scopes.memoryScopeOf('episode', first.episodeId!), retained.memoryScope);
  assert.deepEqual(queue.enqueueAutoCaptureCandidates({ ...input, candidates: selected, origins }), first);
  assert.deepEqual(table().get(template.sessionId, source.seq), beforeContext, 'replay must not upgrade historical source authority');
  assert.equal((memory.openMemoryDb().prepare('SELECT count(*) n FROM consolidated_facts').get() as { n: number }).n, 0,
    'no review, model or consolidation drain is part of the producer regression');
});
