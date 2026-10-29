/** Memory-operation instructions stay in the source episode, outside the durable claim. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { MemoryCaptureEdition } from '../runtime/harness/source-session-context-scope.js';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-operation-tail-'));
Object.assign(process.env, { CLEMENTINE_HOME: fixtureHome, CLEMMY_TEST_ISOLATED_HOME: '1',
  CLEMMY_LOCAL_EMBEDDINGS: 'off', CLEMMY_EMBED_AT_WRITE: 'off', EMBEDDINGS_DISABLED: 'true' });
const capture = await import('./auto-capture.js');
const queue = await import('./durable-consolidation.js');
const candidates = await import('./reflection-candidates.js');
const memory = await import('./db.js');
const scopes = await import('./memory-scope.js');
const events = await import('../runtime/harness/eventlog.js');
const contexts = await import('../runtime/harness/source-session-context.js');
const projects = await import('../projects/project-record.js');
const { setSessionProject } = await import('../projects/session-project.js');
after(() => { memory.closeMemoryDb(); events.closeEventLog(); projects._closeProjectStoreForTests();
  rmSync(fixtureHome, { recursive: true, force: true }); });

const fourFacts = ['record A has heading AMBER TRACE.', 'record B has heading COBALT WAVE.',
  'record C has heading SILVER DUNE.', 'record D has heading INDIGO FIELD.'];
const q11Claim = 'all four of these distinct synthetic facts in this project only. '
  + fourFacts.map(fact => `For synthetic fixture CLEM-Q11-20261026-649be750b061, ${fact}`).join(' ');
const q11Tail = 'Preserve every existing memory. Confirm what you actually saved, and say clearly if any requested fact remains unsaved or unverified. '
  + 'Do not change settings, run workflows, write files, contact external services, edit another project, or reset or clean up memory. '
  + 'This is a normal controlled framework memory-retention check.';
const naturalClaim = 'the Orchard report cutoff is Friday and the review owner is Morgan.';
const examples: Array<{ name: string; leader: string; claim: string; tail: string; edition?: MemoryCaptureEdition }> = [
  { name: 'retained q11 source under v2', leader: 'Remember ', claim: q11Claim, tail: q11Tail, edition: 'save_operation_v2' },
  { name: 'ordinary save confirmation and preservation', leader: 'Remember that ', claim: naturalClaim,
    tail: 'Preserve existing memories. Please confirm what you have saved and tell me if anything remains unverified. Do not modify settings, run workflows, or contact external services. This is a memory check.' },
  { name: 'ordinary save outcome disclosure', leader: 'Remember for future reference: ', claim: naturalClaim,
    tail: 'Confirm what you actually stored, and say which requested details remain unsaved. Do not write files or edit other projects.' },
];

for (const example of examples) test(`memory-operation suffix: ${example.name} preserves every fact without banking the task`, () => {
  const message = `${example.leader}${example.claim} ${example.tail}`;
  const parsed = capture.parseExplicitMemoryInstruction(message, example.edition);
  assert.equal(parsed?.memoryContent, example.claim);
  assert.equal(parsed?.hasSecondaryWork, true);
  const selected = capture.selectAutoMemoryCandidates(message, 3, example.edition);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]!.content, example.claim);
  assert.equal(selected[0]!.reason, 'explicit remember request');
  assert.notEqual(selected[0]!.pin, true);
  assert.notEqual(selected[0]!.kind, 'constraint');
});

const unchanged = [
  ['ambiguous confirmation', `${naturalClaim} Confirm both. Do not write files.`],
  ['named restriction', `${naturalClaim} Confirm what you saved. Do not send messages to Morgan.`],
  ['conditional restriction', `${naturalClaim} Confirm what you saved. Do not change settings unless Morgan approves.`],
  ['conditional preservation', `${naturalClaim} Preserve existing memories unless I ask otherwise. Confirm what you saved. Do not write files.`],
  ['approval restriction', `${naturalClaim} Preserve existing memories. Confirm what you saved. Do not send messages without approval.`],
  ['named current restriction', `${naturalClaim} Preserve existing memories. Confirm what you saved. Do not modify Project Orchard for this task.`],
  ['never restriction', `${naturalClaim} Preserve existing memories. Confirm what you saved. Never change settings.`],
  ['until restriction', `${naturalClaim} Preserve existing memories. Confirm what you saved. Do not change settings until I approve.`],
  ['permanent preservation', `${naturalClaim} Preserve existing memories permanently. Confirm what you saved. Do not write files.`],
  ['every-request disclosure', `${naturalClaim} Confirm what you saved after every request. Do not write files.`],
  ['standing disclosure continuation', `${naturalClaim} Confirm what you saved; always disclose unresolved conflicts.`],
  ['later neighboring fact', `${naturalClaim} ${q11Tail} The archive region is Europe.`],
  ['fact between task clauses', `${naturalClaim} Confirm what you saved. The archive region is Europe. Do not write files.`],
  ['lasting confirmation preference', `${naturalClaim} Always confirm what you saved. Do not write files.`],
  ['lasting archival procedure', `${naturalClaim} From now on, preserve every existing memory. Confirm what you saved. Do not write files.`],
  ['command-shaped SOP', `For every archive update, preserve existing memories. Confirm what you actually saved, and say clearly if any requested fact remains unsaved or unverified. Do not change settings.`],
  ['named standing procedure', `the archival procedure is: Preserve every existing memory. Confirm what you saved. Do not write files.`],
  ['conditional standing procedure', `${naturalClaim} Confirm what you saved after every archive update. Do not write files.`],
  ['unrelated declarative self-description', `${naturalClaim} Confirm what you saved. This is a quarterly archive.`],
  ['quoted operation language', `the banner is "${q11Tail}" and the report cutoff is Friday.`],
  ['unclosed quoted operation language', `the banner begins "${q11Tail}`],
  ['unclosed fenced operation language', `the banner begins \`\`\`${q11Tail}`],
  ['quoted text inside a later tail clause', `${naturalClaim} Preserve existing memories. Confirm what you saved. Do not write files. This is a memory check called "Archive rehearsal".`],
] as const;
for (const [name, claim] of unchanged) test(`memory-operation suffix: retains ${name}`, () => {
  assert.equal(capture.parseExplicitMemoryInstruction(`Remember that ${claim}`)?.memoryContent, claim);
});

test('memory-operation suffix: catch-all disclosure does not become a save receipt', () => {
  const claim = `${naturalClaim} Confirm what you saved, and tell me anything unresolved. Do not write files.`;
  assert.equal(capture.parseExplicitMemoryInstruction(`Remember that ${claim}`)?.memoryContent,
    `${naturalClaim} Confirm what you saved`,
    'preserve the existing separate and-tell task boundary; do not swallow its preceding ambiguous confirmation');
});

for (const preface of ['archival procedure.', 'archival procedure for future imports.', 'procedure:']) {
  test(`memory-operation suffix: explicit nominal ${preface} owns its subsequent steps`, () => {
    const claim = `${preface} Preserve existing memories. Confirm what you saved. Do not write files.`;
    assert.equal(capture.parseExplicitMemoryInstruction(`Remember this ${claim}`)?.memoryContent, claim);
  });
}

test('memory-operation suffix: privacy refusal and unresolved referential memory retain their authority', () => {
  assert.deepEqual(capture.selectAutoMemoryCandidates(`Remember that ${naturalClaim} ${q11Tail} Do not save this as memory.`), []);
  assert.deepEqual(capture.selectAutoMemoryCandidates(`Remember that correction. ${q11Tail}`), [],
    'command framing does not supply the referent of a requested correction');
});

for (const [name, claim] of [
  ['q11', q11Claim],
  ['unicode-repeated', `${q11Claim} The banner is 🌱. The archive label is AMBER TRACE. The archive label is AMBER TRACE.`],
] as const) test(`memory-operation suffix: ${name} accepted source and complete origin survive enqueue/reopen with exact scope`, () => {
  const sessionId = `memory-operation-tail-source-${name}`;
  events.createSession({ id: sessionId, kind: 'chat' });
  const created = projects.createProject({ name: `Memory operation tail fixture ${name}`, context: 'Controlled disposable project.' });
  assert.ok(created.ok); if (!created.ok) throw new Error('fixture project');
  assert.ok(setSessionProject(sessionId, created.project.id, { by: 'owner' }).ok);
  // Insert a new explicit v2 source identity for this historical producer
  // regression; never rewrite a source captured under the current edition.
  const template = events.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Establish the controlled historical operation-tail context.' } });
  assert.ok(contexts.captureFreshSourceSessionContext({ sessionId, sourceUserSeq: template.seq }));
  const templateIdentity = events.openEventLog().prepare('SELECT identity_json FROM source_session_contexts_v1 WHERE session_id=? AND source_user_seq=?')
    .get(sessionId, template.seq) as { identity_json: string };
  const message = `Remember ${claim} ${q11Tail}`;
  const accepted = events.appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: message } });
  const identityJson = JSON.stringify({ ...JSON.parse(templateIdentity.identity_json), sourceUserSeq: accepted.seq, memoryCaptureEdition: 'save_operation_v2' });
  const identityDigest = createHash('sha256').update(identityJson).digest('hex');
  events.openEventLog().prepare('INSERT INTO source_session_contexts_v1 (session_id,source_user_seq,identity_json,identity_digest) VALUES (?,?,?,?)')
    .run(sessionId, accepted.seq, identityJson, identityDigest);
  const context = contexts.readSourceSessionContext({ sessionId, sourceUserSeq: accepted.seq }, identityDigest); assert.ok(context);
  const selected = capture.selectAutoMemoryCandidates(message, 3, 'save_operation_v2');
  const input = { message, sessionId, sourceEventId: `user-source:${accepted.seq}`,
    sourceProvenance: capture.autoCaptureProvenanceFromAcceptedEvent(accepted) };
  const origins = capture.automaticMemoryOriginsForCapture(input, selected);
  const queued = queue.enqueueAutoCaptureCandidates({ ...input, candidates: selected, origins });
  assert.equal(queued.candidateIds.length, 1);
  memory.closeMemoryDb();
  const stored = candidates.readAutomaticMemoryCandidate(queued.candidateIds[0]!);
  assert.equal(stored.status, 'valid'); if (stored.status !== 'valid') throw new Error('fixture candidate');
  assert.equal(stored.envelope.origin.source.ownerText, message);
  assert.equal(stored.envelope.origin.source.eventSeq, accepted.seq);
  assert.equal(stored.envelope.origin.claimMode, 'complete', 'do not weaken an explicit claim to selectable');
  assert.deepEqual(stored.envelope.origin.source.context?.memoryScope, context.memoryScope);
  assert.equal(context.memoryScope.projectId, created.project.id);
  const episode = memory.openMemoryDb().prepare('SELECT evidence_excerpt FROM memory_episodes WHERE id=?').get(queued.episodeId) as { evidence_excerpt: string };
  assert.equal(episode.evidence_excerpt, message, 'the original task instructions remain source evidence');
  const expectedSpan = { start: 'Remember '.length, end: 'Remember '.length + claim.length };
  assert.deepEqual(stored.envelope.origin.claim, expectedSpan);
  assert.equal(message.slice(expectedSpan.start, expectedSpan.end), claim);
  assert.equal(stored.row.text, claim);
  for (const fact of fourFacts) assert.ok(stored.row.text.includes(fact));
  assert.equal(stored.row.pin, 0);
  assert.notEqual(stored.row.kind, 'constraint');
  assert.deepEqual(scopes.memoryScopeOf('episode', queued.episodeId!), context.memoryScope);
  const replay = queue.enqueueAutoCaptureCandidates({ ...input, candidates: selected, origins });
  assert.deepEqual(replay.candidateIds, queued.candidateIds);
  assert.equal(replay.episodeId, queued.episodeId);
  assert.equal((memory.openMemoryDb().prepare('SELECT count(*) n FROM consolidated_facts').get() as { n: number }).n, 0,
    'no models, saves, or semantic drain are part of this intake regression');
});
