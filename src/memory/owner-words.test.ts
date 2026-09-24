import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-owner-words-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const eventlog = await import('../runtime/harness/eventlog.js');
const memory = await import('./db.js');
const capture = await import('./auto-capture.js');
const consolidation = await import('./durable-consolidation.js');
const facts = await import('./facts.js');
const repair = await import('./owner-words-repair.js');

test.after(() => {
  eventlog.closeEventLog();
  memory.closeMemoryDb();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function acceptedSource(text: string, extra: Record<string, unknown> = {}) {
  const session = eventlog.createSession({ id: `owner-words-${process.pid}-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text, ...extra },
  });
  return { sessionId: session.id, source, provenance: capture.autoCaptureProvenanceFromAcceptedEvent(source) };
}

const OWNER_EXECUTE_LINE = 'Execute the reviewed plan, revision 1.';

// What the host hands the model for an Execute selection: the owner's one line
// followed by host-composed plan text. The plan here states a sender rule, so
// the expansion is exactly the shape automatic capture would otherwise admit.
function hostExpansion(): string {
  return [
    OWNER_EXECUTE_LINE,
    'The user explicitly selected Execute for reviewed plan plan-1, revision 1, digest abc123.',
    '<reviewed-plan>Going forward, always send email via the Outlook mailbox owner@example.com and never from any other connected mailbox.</reviewed-plan>',
  ].join('\n');
}

test('a host expansion would be admitted by the candidate rules (precondition for the boundary)', () => {
  assert.ok(capture.extractAutoMemoryCandidates(hostExpansion()).length > 0);
});

test('capture refuses a host expansion of an accepted source and admits the owner\'s own words', () => {
  const { sessionId, source, provenance } = acceptedSource(OWNER_EXECUTE_LINE, { taskMode: { version: 1, kind: 'execute' } });
  const refused = capture.captureInteractionSignals({
    message: hostExpansion(),
    sessionId,
    sourceEventId: `user-source:${source.seq}`,
    sourceProvenance: provenance,
  });
  assert.deepEqual(refused.candidates, [], 'host-composed plan text never becomes owner memory');
  assert.deepEqual(refused.queuedCandidateIds ?? [], []);

  const ownerRule = 'Going forward, always send email via the Outlook mailbox owner@example.com and never from any other connected mailbox.';
  const owner = acceptedSource(ownerRule);
  const admitted = capture.captureInteractionSignals({
    message: ownerRule,
    sessionId: owner.sessionId,
    sourceEventId: `user-source:${owner.source.seq}`,
    sourceProvenance: owner.provenance,
  });
  assert.ok(admitted.candidates.length > 0, 'the same rule in the owner\'s own words is admitted');
});

test('owner authorship admits a narrower clause and either accepted text, and nothing outside them', () => {
  const { provenance } = acceptedSource('Please  draft the reply.\nAlso remember that Cedar is Cedar-41.', {
    displayText: 'Remember that Cedar is Cedar-41.',
  });
  assert.equal(capture.captureMessageIsOwnerAuthored('Also remember that Cedar is Cedar-41.', provenance), true,
    'a fresh clause of the typed text is the owner\'s');
  assert.equal(capture.captureMessageIsOwnerAuthored('Please draft the reply. Also', provenance), true,
    'whitespace differences do not change authorship');
  assert.equal(capture.captureMessageIsOwnerAuthored('Remember that Cedar is Cedar-41.', provenance), true,
    'the display copy is the owner\'s too');
  assert.equal(capture.captureMessageIsOwnerAuthored('Remember that Cedar is Cedar-42.', provenance), false);
  assert.equal(capture.captureMessageIsOwnerAuthored('', provenance), false);
  assert.equal(
    capture.captureMessageIsOwnerAuthored('anything', capture.autoCaptureProvenanceFromDirectUserInput('chat')),
    true,
    'a direct user boundary attests its own input',
  );
});

// The ordinary capture path also drains its own candidates in a microtask, so
// settle on the rows' recorded status rather than on one drain's count.
async function promote(ids: number[]): Promise<void> {
  const placeholders = ids.map(() => '?').join(',');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await consolidation.drainDurableConsolidationCandidates({ ids, limit: ids.length });
    const rows = memory.openMemoryDb().prepare(
      `SELECT status FROM memory_reflection_candidates WHERE id IN (${placeholders})`,
    ).all(...ids) as Array<{ status: string }>;
    if (rows.length === ids.length && rows.every((row) => row.status === 'promoted')) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('capture candidates never promoted');
}

function factIdFor(candidateId: number): number {
  const row = memory.openMemoryDb().prepare(
    'SELECT resulting_fact_id FROM memory_reflection_candidates WHERE id = ?',
  ).get(candidateId) as { resulting_fact_id: number };
  return row.resulting_fact_id;
}

test('the owner-words repair retires only facts it proves were captured from host text', async () => {
  // A fact admitted before the boundary held: the capture consumed the
  // expansion under the accepted source's identity.
  const leaked = acceptedSource(OWNER_EXECUTE_LINE, { taskMode: { version: 1, kind: 'execute' } });
  const leakQueued = consolidation.enqueueAutoCaptureCandidates({
    message: hostExpansion(),
    sessionId: leaked.sessionId,
    sourceEventId: `user-source:${leaked.source.seq}`,
    candidates: capture.extractAutoMemoryCandidates(hostExpansion()),
  });
  // An owner statement captured through the ordinary boundary.
  const ownerText = 'My preferred contract reviewer is Sarah Chen.';
  const owner = acceptedSource(ownerText);
  const ownerQueued = capture.captureInteractionSignals({
    message: ownerText,
    sessionId: owner.sessionId,
    sourceEventId: `user-source:${owner.source.seq}`,
    sourceProvenance: owner.provenance,
  });
  // A capture whose accepted source is not on record cannot be judged.
  const orphanText = 'Zephyr intake uses the numbered multipart field names for every upload.';
  const orphanQueued = consolidation.enqueueAutoCaptureCandidates({
    message: `Going forward, remember this: ${orphanText}`,
    sessionId: `owner-words-orphan-${process.pid}`,
    sourceEventId: 'user-source:999999',
    candidates: [{ kind: 'project', content: orphanText, reason: 'explicit remember request' }],
  });
  // Seed the historical defect, not a new capture through today's owner-word
  // boundary (which correctly refuses both host text and unverifiable sources).
  // Keep the original candidate/episode/source linkage for the repair to prove.
  const historicalFact = (candidateId: number): number => {
    const db = memory.openMemoryDb();
    const row = db.prepare('SELECT kind, text FROM memory_reflection_candidates WHERE id = ?')
      .get(candidateId) as { kind: Parameters<typeof facts.rememberFact>[0]['kind']; text: string };
    assert.ok(row);
    const fact = facts.rememberFact({ kind: row.kind, content: row.text });
    const changed = db.prepare("UPDATE memory_reflection_candidates SET status = 'promoted', resulting_fact_id = ? WHERE id = ?")
      .run(fact.id, candidateId);
    assert.equal(changed.changes, 1);
    return fact.id;
  };
  const leakedFact = historicalFact(leakQueued.candidateIds[0]!);
  const orphanFact = historicalFact(orphanQueued.candidateIds[0]!);
  await promote(ownerQueued.queuedCandidateIds ?? []);
  const ownerFact = factIdFor(ownerQueued.queuedCandidateIds![0]!);

  const preview = repair.retireAutoCaptureFactsOutsideOwnerWords({ dryRun: true });
  assert.deepEqual(preview.retired.map((entry) => entry.factId), [leakedFact]);
  assert.equal(facts.getFact(leakedFact)?.active, true, 'a dry run changes nothing');

  const applied = repair.retireAutoCaptureFactsOutsideOwnerWords();
  assert.deepEqual(applied.retired.map((entry) => entry.factId), [leakedFact]);
  assert.equal(applied.unverifiable, 1, 'the capture without an accepted source on record is left alone');
  assert.equal(facts.getFact(leakedFact)?.active, false);
  assert.equal(facts.getFact(ownerFact)?.active, true);
  assert.equal(facts.getFact(orphanFact)?.active, true);
  assert.deepEqual(repair.retireAutoCaptureFactsOutsideOwnerWords().retired, [], 'the pass is idempotent');
});

test('an oversized dispatch-enforced rule renders within the display bound and is still shown', () => {
  const filler = 'Host-composed plan text that is not part of the rule. '.repeat(120);
  const rule = facts.rememberFact({
    kind: 'constraint',
    content: `Email sending constraint: ALWAYS send email via the Outlook mailbox bounded@example.com. NEVER send from any other connected mailbox unless explicitly directed. ${filler}`,
  });
  const block = facts.renderFactsForInstructions(10, 2600);
  assert.match(block, /ALWAYS send email via the Outlook mailbox bounded@example\.com/);
  const line = block.split('\n').find((entry) => entry.includes('bounded@example.com')) ?? '';
  assert.match(line, new RegExp(`rule #${rule.id} shortened for display`));
  assert.ok(line.length <= facts.POLICY_LINE_MAX_CHARS + 120, `rendered line is ${line.length} chars`);
  assert.ok(!block.includes(rule.content), 'the full oversized text never reaches the prompt');
});

test('an oversized standing preference no longer hides the smaller ones ranked after it', () => {
  const oversized = facts.rememberFact({
    kind: 'feedback',
    content: `Standing instruction: ${'Summarize every workspace change in a long-form memo with full context. '.repeat(40)}`,
    importance: 9,
  });
  const small = facts.rememberFact({
    kind: 'feedback',
    content: 'Standing preference: keep Friday digests to five bullets.',
    importance: 5,
  });
  facts.setFactPinned(oversized.id, true);
  facts.setFactPinned(small.id, true);
  const block = facts.renderFactsForInstructions(10, 2600);
  assert.match(block, /keep Friday digests to five bullets/);
});
