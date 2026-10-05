/** Production regression: shared extraction + enqueue boundary.
 * No semantic drain, model calls or live-home reads. Full source remains evidence.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-standing-scope-red-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.CLEMMY_EMBED_AT_WRITE = 'off';
const { extractAutoMemoryCandidates, parseExplicitMemoryInstruction, isEligibleAutoCaptureSourceProvenance } = await import('./auto-capture.js');
const { enqueueAutoCaptureCandidates } = await import('./durable-consolidation.js');
const { openMemoryDb, closeMemoryDb } = await import('./db.js');
const { withMemorySettledFor, memoryScopeOf } = await import('./memory-scope.js');
test.after(() => { closeMemoryDb(); rmSync(fixtureHome, { recursive: true, force: true }); });

const facts = 'the status-report heading is COPPER HORIZON; the report footnote label is CHARTER LAMP.';
const historical = `For this synthetic project memory01-01b06481 A, remember these two standing project conventions for future chats in this project only: ${facts} Keep both as project memory here, not everywhere. These are durable conventions, not instructions to make a report now. Confirm what you saved. Do not create files, change any existing project or settings, or send external messages.`;
function retainsBoth(text: string) {
  assert.ok(text.includes('the status-report heading is COPPER HORIZON'), 'retain complete first assertion');
  assert.ok(text.includes('the report footnote label is CHARTER LAMP.'), 'retain complete independent second assertion');
}
function ordinaryFact(message: string) {
  const candidates = extractAutoMemoryCandidates(message);
  assert.equal(candidates.length, 1, 'one explicit source-backed candidate, no invented fact splitting');
  const candidate = candidates[0]!; retainsBoth(candidate.content);
  assert.equal(candidate.reason, 'explicit remember request', 'one-turn prohibition cannot classify the durable fact');
  assert.notEqual(candidate.pin, true, 'unrelated one-turn work cannot mint standing pin authority');
  assert.doesNotMatch(candidate.content, /Confirm what you saved|Confirm both|Do not create files/i);
  return candidate;
}

test('actual MEMORY-01 source: parser isolates task confirmation and prohibition after retaining both facts', () => {
  const parsed = parseExplicitMemoryInstruction(historical)!;
  retainsBoth(parsed.memoryContent);
  assert.equal(parsed.hasSecondaryWork, true);
  assert.doesNotMatch(parsed.memoryContent, /Confirm what you saved|Do not create files/);
});
test('actual MEMORY-01 source: explicit facts do not become a pinned standing prohibition', () => ordinaryFact(historical));

test('natural mixed durable facts plus current confirmation are not a standing prohibition', () => {
  ordinaryFact(`Remember for future reference: ${facts} Confirm what you saved. Do not create files.`);
});
test('negated current work alone is separated without losing either durable assertion', () => {
  ordinaryFact(`Remember for future reference: ${facts} Do not create files for this task.`);
});
test('already-isolated secondary work cannot lend prohibition authority back to saved facts', () => {
  const message = `Remember for future reference: ${facts} Then draft a sample response. Do not create files.`;
  const parsed = parseExplicitMemoryInstruction(message)!;
  assert.equal(parsed.memoryContent, facts, 'existing isolation already keeps both facts and drops the live draft');
  assert.equal(parsed.hasSecondaryWork, true);
  ordinaryFact(message);
});
test('a preceding unrelated prohibition cannot pin a later explicit factual clause', () => {
  const message = `Do not create files for this task. Remember for future reference: ${facts}`;
  assert.equal(parseExplicitMemoryInstruction(message)!.memoryContent, facts);
  ordinaryFact(message);
});
test('a separate current-task sender choice cannot replace explicit project facts with an enforced constraint', () => {
  const message = `Remember that ${facts} Then send the draft email only from staging@example.test for this task.`;
  assert.equal(parseExplicitMemoryInstruction(message)!.memoryContent, facts, 'the sender clause is already outside the isolated claim');
  const candidate = ordinaryFact(message);
  assert.notEqual(candidate.kind, 'constraint');
  assert.doesNotMatch(candidate.content, /staging@example\.test/);
});

test('facts-only control retains two assertions and ordinary explicit-memory classification', () => {
  for (const message of [`Remember that ${facts}`, `Remember for future reference: ${facts}`]) {
    const candidate = ordinaryFact(message);
    assert.equal(candidate.content, facts);
  }
});
test('the historical facts-only framing does not itself create a safety prohibition', () => {
  const candidate = ordinaryFact(`For this synthetic project Orchard, remember these two standing project conventions for future chats in this project only: ${facts} Keep both as project memory here, not everywhere.`);
  assert.ok(candidate.content.includes('Keep both as project memory here, not everywhere.'));
});
test('genuinely standing prohibition control retains full assertion and pinned safety classification', () => {
  const claim = 'from now on, do not send project reports to external recipients.';
  const candidates = extractAutoMemoryCandidates(`Remember that ${claim}`);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.content, `Standing prohibition: ${claim}`);
  assert.equal(candidates[0]!.reason, 'safety-critical prohibition (auto-pinned)');
  assert.equal(candidates[0]!.pin, true);
});
test('a preceding command-level future wrapper retains authority without borrowing a separate task cue', () => {
  const claim = 'For Project Orchard, do not email release reports to external recipients.';
  for (const wrapper of ['For future reference,', 'Going forward,']) {
    const rows = extractAutoMemoryCandidates(`${wrapper} remember that ${claim}`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.pin, true, wrapper);
    assert.equal(rows[0]!.content, `Standing prohibition: ${claim}`);
  }
  const message = `Draft a checklist for future reference. Remember that ${claim}`;
  const rows = extractAutoMemoryCandidates(message);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0]!.pin, true, 'a separate task is not the memory command wrapper');
  assert.equal(rows[0]!.content, claim);
});
test('genuinely standing sender constraint control remains enforceable', () => {
  const message = 'Remember that project email must always be sent from reports@example.test.';
  const candidates = extractAutoMemoryCandidates(message);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.kind, 'constraint');
  assert.equal(candidates[0]!.reason, 'enforceable sender/account routing rule');
  assert.equal(candidates[0]!.pin, true);
  assert.ok(candidates[0]!.content.includes('project email must always be sent from reports@example.test.'));
});
test('a real standing rule in the same durable clause must not be removed to salvage the facts', () => {
  const message = `Remember for future reference: ${facts} Never send project reports to external recipients.`;
  const candidate = extractAutoMemoryCandidates(message)[0]!;
  retainsBoth(candidate.content);
  assert.ok(candidate.content.endsWith('Never send project reports to external recipients.'));
  assert.equal(candidate.pin, true);
});
test('quoted literal containing confirmation and negative command text is retained intact', () => {
  const content = 'the project banner is "Confirm receipt. Do not create files." and the footnote label is CHARTER LAMP.';
  assert.equal(parseExplicitMemoryInstruction(`Remember that ${content}`)!.memoryContent, content);
});
test('substantive factual assertion about a confirmation procedure is not task framing', () => {
  const content = 'the project review rule is to confirm both headings before sending files.';
  assert.equal(parseExplicitMemoryInstruction(`Remember that ${content}`)!.memoryContent, content);
});
test('existing terminal framing cannot strip an unclosed literal before clause isolation', () => {
  for (const mark of ['"', "'", '`', '```']) {
    for (const ending of ['Confirm.', "Just confirm you've noted it — nothing else.", 'Briefly acknowledge.']) {
      const content = `the project banner begins ${mark}Save the receipt. ${ending}`;
      assert.equal(parseExplicitMemoryInstruction(`Remember that ${content}`)?.memoryContent, content);
    }
  }
  const correction = 'Small correction for later: the project banner is "Save the receipt. Confirm.';
  assert.equal(parseExplicitMemoryInstruction(correction)?.memoryContent, correction);
});
test('literal masking uses source offsets after non-BMP characters and preserves an outer acknowledgement boundary', () => {
  const content = 'the project banner is 🌱 "Confirm what you saved. Do not create files for this task." and the footnote label is CHARTER LAMP.';
  assert.equal(parseExplicitMemoryInstruction(`Remember that ${content} Confirm what you saved.`)?.memoryContent, content);
});
test('an earlier quoted secondary action cannot hide a real later task boundary', () => {
  const content = 'the project banner is "Then draft a report. Then send it." and the footnote label is CHARTER LAMP.';
  assert.equal(parseExplicitMemoryInstruction(`Remember that ${content} Then draft a sample.`)?.memoryContent, content);
});
test('explicit current-only scope cannot discard a later neighboring assertion', () => {
  const content = `${facts} Do not create files for this task. The release region is Europe.`;
  assert.equal(parseExplicitMemoryInstruction(`Remember that ${content}`)?.memoryContent, content);
});
test('plain one-off confirmation/prohibition grants no automatic durable memory authority', () => {
  assert.deepEqual(extractAutoMemoryCandidates('For this task, confirm the draft title. Do not create files.'), []);
});

test('production enqueue and reopen retain complete source/scope but must not bank task-only clauses as pinned memory', () => {
  const sessionId = 'memory-standing-scope-disposable', sourceSeq = 71;
  const source = { authority: 'accepted_user_input' as const, sessionId, eventId: 'source-standing-scope', seq: sourceSeq,
    role: 'user', type: 'user_input_received', data: { text: historical } };
  assert.equal(isEligibleAutoCaptureSourceProvenance(source, { sessionId, sourceEventId: `user-source:${sourceSeq}` }), true);
  const candidates = extractAutoMemoryCandidates(historical);
  const scope = { projectId: 'project-standing-scope-disposable', agentKey: 'agent-standing-scope@disposable' };
  const input = { message: historical, sessionId, sourceEventId: `user-source:${sourceSeq}`, candidates };
  const queued = withMemorySettledFor(scope, () => enqueueAutoCaptureCandidates(input));
  closeMemoryDb();
  const db = openMemoryDb();
  const episode = db.prepare('SELECT evidence_excerpt,call_id,session_id FROM memory_episodes WHERE id=?').get(queued.episodeId) as { evidence_excerpt: string; call_id: string; session_id: string };
  assert.equal(episode.evidence_excerpt, historical, 'source evidence is never rewritten to make candidate extraction look clean');
  assert.equal(episode.call_id, 'auto-capture:user-source:71'); assert.equal(episode.session_id, sessionId);
  assert.deepEqual(memoryScopeOf('episode', queued.episodeId!), scope);
  const replay = withMemorySettledFor(scope, () => enqueueAutoCaptureCandidates(input));
  assert.equal(replay.episodeId, queued.episodeId); assert.deepEqual(replay.candidateIds, queued.candidateIds);
  assert.equal((db.prepare('SELECT count(*) n FROM consolidated_facts').get() as { n: number }).n, 0, 'this test never drains or runs a model');
  const row = db.prepare('SELECT session_id,call_id,text,pin,intake_reason,status FROM memory_reflection_candidates WHERE id=?').get(queued.candidateIds[0]) as { session_id: string; call_id: string; text: string; pin: number; intake_reason: string; status: string };
  assert.equal(row.session_id, sessionId); assert.equal(row.call_id, episode.call_id); assert.equal(row.status, 'pending');
  retainsBoth(row.text);
  assert.equal(row.pin, 0, 'the actual queued durable candidate must not inherit unrelated prohibition authority');
  assert.equal(row.intake_reason, 'explicit remember request');
  assert.doesNotMatch(row.text, /Confirm what you saved|Do not create files/);
});
