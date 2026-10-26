/** Exact-source explicit saves invalidate a waiting automatic resolver's snapshot. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { AutomaticMemoryOrigin } from './memory-destination.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-auto-explicit-race-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1',
  CLEMMY_LOCAL_EMBEDDINGS: 'off', EMBEDDINGS_DISABLED: 'true', CLEMMY_EMBED_AT_WRITE: 'off', MCP_AUTO_IMPORT_ENABLED: 'false' });
mkdirSync(path.join(home, 'state'), { recursive: true });
const events = await import('../runtime/harness/eventlog.js');
const contexts = await import('../runtime/harness/source-session-context.js');
const authorities = await import('../runtime/harness/accepted-turn-call-authority.js');
const bindings = await import('../runtime/harness/host-call-capability-binding.js');
const contracts = await import('../runtime/harness/logical-call-contract.js');
const dispatch = await import('../runtime/harness/dispatch-ledger.js');
const settlements = await import('../runtime/harness/logical-call-settlement-store.js');
const outcomes = await import('../runtime/harness/attempt-outcome.js');
const obligation = await import('../runtime/harness/memory-completion-obligation.js');
const capture = await import('./auto-capture.js');
const queue = await import('./durable-consolidation.js');
const candidates = await import('./reflection-candidates.js');
const memory = await import('./db.js');
const facts = await import('./facts.js');
const scopes = await import('./memory-scope.js');
const receipts = await import('./memory-remember-receipt.js');
const { parseAutomaticStandingMemoryReview } = await import('./standing-memory-review.js');
const projects = await import('../projects/project-record.js');
const { setSessionProject } = await import('../projects/session-project.js');
after(() => { memory.closeMemoryDb(); events.closeEventLog(); projects._closeProjectStoreForTests(); rmSync(home, { recursive: true, force: true }); });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
let serial = 0;

function accept(sessionId: string, text: string) {
  const event = events.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  const identity = { sessionId, sourceUserSeq: event.seq, turn: 1 };
  assert.ok(contexts.captureFreshSourceSessionContext(identity));
  const frozenCatalogDigest = digest(JSON.stringify({ entries: [], version: 1 }));
  assert.equal(authorities.armHostCallAuthority({ ...identity,
    catalogRevisionDigest: digest(JSON.stringify({ envelopeDigest: null, frozenCatalogDigest, sealedUniverse: [], version: 1 })),
    bindingRevisionDigest: digest(JSON.stringify({ attemptId: sessionId, envelopeDigest: null, frozenCatalogDigest, version: 1 })),
    maxLogicalCalls: 20, maxParallelCalls: 8 }).status, 'armed');
  const source = obligation.readMemoryRequirementSource(identity); assert.ok(source);
  return { ...identity, source, event };
}

function fixture(scoped = false) {
  const sessionId = `explicit-auto-race-${++serial}`;
  events.createSession({ id: sessionId, kind: 'chat' });
  const project = scoped ? projects.createProject({ name: `Scoped race ${serial}`, context: 'Controlled scope.', }) : null;
  if (project) { assert.ok(project.ok); assert.ok(setSessionProject(sessionId, project.project.id, { by: 'owner' }).ok); }
  const clauses = [`Fixture ${serial} report A has heading HAZEL and footer COPPER.`,
    `Fixture ${serial} report B has heading AMBER and footer LINEN.`,
    `Fixture ${serial} report C has heading BRONZE and footer PAPER.`];
  const message = `${scoped ? 'In the current project, remember this:' : 'Remember this:'} ${clauses.join(' ')} Just confirm it.`;
  const accepted = accept(sessionId, message);
  const input = { message, sessionId, sourceEventId: `user-source:${accepted.sourceUserSeq}`,
    sourceProvenance: capture.autoCaptureProvenanceFromAcceptedEvent(accepted.event) };
  const selected = capture.selectAutoMemoryCandidates(message);
  assert.equal(selected.length, 1);
  const origins = capture.automaticMemoryOriginsForCapture(input, selected);
  assert.equal(origins[0]?.claimMode, 'complete');
  const queued = queue.enqueueAutoCaptureCandidates({ ...input, candidates: selected, origins });
  assert.equal(queued.candidateIds.length, 1);
  const kind = selected[0]!.kind;
  // The existing lexical conflict path must actually await our resolver.
  facts.rememberFact({ kind, content: `Fixture ${serial} report A has heading OLD and footer OTHER.`, sessionId });
  return { ...accepted, input, queued, clauses, kind, scope: scoped ? accepted.source.memoryScope : scopes.EVERYWHERE };
}

function save(source: ReturnType<typeof accept>, kind: import('./db.js').ConsolidatedFactKind, content: string,
  scope: import('./memory-scope.js').MemoryScope = scopes.EVERYWHERE, rawReceipt?: string) {
  const name = 'memory_remember'; const args = { kind, content }; const callId = `explicit-save-${serial}-${++saveSerial}`;
  const root = authorities.acceptedTurnCallAuthorityFor(source.sessionId, source.sourceUserSeq);
  assert.equal(root.status, 'ok'); if (root.status !== 'ok') throw new Error('host source');
  const task = { sessionId: source.sessionId, sourceUserSeq: source.sourceUserSeq, acceptedTaskId: source.source.acceptedTaskId };
  const contract = contracts.durableLogicalCallContract(task.acceptedTaskId, name, args); assert.ok(contract);
  const base = { ...task, sourceEventId: root.authority.sourceEventId, sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId: callId, toolName: contract.toolName, argumentDigest: contract.argumentDigest, effect: 'local_write' as const,
    bindingKind: 'local_envelope' as const, capabilityId: 'cap:memory_remember', schemaFingerprint: digest('fixture:memory_remember'),
    accountId: '', invokePortId: 'fixture:host', operationId: name, manifestId: '', manifestDigest: '',
    engineVersion: root.authority.engineVersion, surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest, authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest, catalogRevisionDigest: root.authority.catalogRevisionDigest!,
    bindingRevisionDigest: root.authority.bindingRevisionDigest! };
  return authorities.withHostCallAttestation({ ...base, bindingDigest: bindings.hostCallAttestationBindingDigest(base) }, () => {
    const opened = dispatch.beginPhysicalDispatch({ identity: { ...task, logicalToolCallId: callId,
      physicalDispatchId: `dispatch:${callId}`, ordinal: 0 }, tool: name, args, executionSite: 'host' });
    assert.equal(opened.status, 'inserted'); if (opened.status !== 'inserted') throw new Error('physical dispatch');
    const fact = facts.rememberFact({ kind, content, scope, sessionId: source.sessionId });
    assert.equal(dispatch.settlePhysicalDispatch({ identity: opened.identity, tool: name, outcome: 'returned' }).status, 'inserted');
    const settled = settlements.commitLogicalCallSettlement({ identity: { ...task, logicalToolCallId: callId },
      contract: { toolName: name, args }, execution: { kind: 'local_execution' },
      result: { payload: rawReceipt ?? receipts.formatMemoryRememberReceipt({ action: 'add', factId: fact.id }) },
      outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
      recovery: { businessCall: false, mutating: true }, observer: { lane: 'byo', turn: source.turn } });
    assert.equal(settled.status, 'committed');
    return fact;
  });
}
let saveSerial = 0;

const review = async (source: string, _text: string, _mode?: unknown, origin?: AutomaticMemoryOrigin) => {
  assert.ok(origin); assert.equal(source, origin.source.ownerText);
  return parseAutomaticStandingMemoryReview({ durability: 'standing', claim: origin.claim,
    destination: 'kind_default', destinationSpans: [], reason: 'Controlled exact source destination.' }, origin);
};
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function candidate(id: number) { const row = candidates.readAutomaticMemoryCandidate(id); assert.equal(row.status, 'valid');
  if (row.status !== 'valid') throw new Error('candidate'); return row.row; }
const total = () => (memory.openMemoryDb().prepare('SELECT COUNT(*) AS n FROM consolidated_facts').get() as { n: number }).n;

test('same-source paraphrased saves landing during the resolver make its stale ADD retry before writing', async () => {
  const f = fixture(); const entered = barrier(); const release = barrier();
  const now = new Date().toISOString();
  const active = queue.drainDurableConsolidationCandidates({ ids: f.queued.candidateIds, now, standingReviewer: review,
    resolver: async () => { entered.resolve(); await release.promise; return { decision: 'ADD' }; } });
  await entered.promise;
  const saved = f.clauses.map(content => save(f, f.kind, content.replace('has heading', 'uses heading').replace('and footer', 'with footer')));
  const before = total();
  release.resolve(); const result = await active;
  assert.equal(result.promoted, 0, 'an old resolver snapshot cannot commit a fourth aggregate');
  assert.equal(result.retried, 1);
  assert.equal(total(), before);
  const pending = candidate(f.queued.candidateIds[0]!);
  assert.equal(pending.status, 'pending'); assert.equal(pending.resulting_fact_id, null);
  assert.equal(pending.processing_started_at, null);
  assert.ok(pending.next_attempt_at);
  assert.ok(f.queued.episodeId && memory.openMemoryDb().prepare('SELECT 1 FROM memory_episodes WHERE id = ?').get(f.queued.episodeId));
  let secondReads = 0;
  const retry = await queue.drainDurableConsolidationCandidates({ ids: f.queued.candidateIds, now: pending.next_attempt_at!,
    standingReviewer: async () => { assert.fail('the checked destination decision is reused'); },
    resolver: async (_claim, similar) => {
      secondReads++;
      for (const fact of saved) assert.ok(similar.some(value => value.id === fact.id), 'the next existing resolver sees the newly saved facts');
      // A fresh resolver may still choose ADD. Retry is not a new semantic deduper.
      return { decision: 'ADD' };
    } });
  assert.equal(secondReads, 1); assert.equal(retry.promoted, 1);
});

test('a same-source saved fact changed during the resolver also invalidates the stale decision', async () => {
  const f = fixture(); const saved = save(f, f.kind, f.clauses[0]!);
  const entered = barrier(); const release = barrier();
  const active = queue.drainDurableConsolidationCandidates({ ids: f.queued.candidateIds, standingReviewer: review,
    resolver: async () => { entered.resolve(); await release.promise; return { decision: 'ADD' }; } });
  await entered.promise;
  facts.updateFact(saved.id, { content: `${f.clauses[0]} A newer retained detail.` });
  const before = total(); release.resolve(); const result = await active;
  assert.equal(result.promoted, 0); assert.equal(result.retried, 1); assert.equal(total(), before);
});

for (const control of ['unchanged', 'foreign_source', 'foreign_scope', 'forged_receipt'] as const)
  test(`${control} does not manufacture a same-source snapshot change`, async () => {
    const f = fixture();
    if (control === 'unchanged') save(f, f.kind, f.clauses[0]!);
    const entered = barrier(); const release = barrier();
    const active = queue.drainDurableConsolidationCandidates({ ids: f.queued.candidateIds, standingReviewer: review,
      resolver: async () => { entered.resolve(); await release.promise; return { decision: 'ADD' }; } });
    await entered.promise;
    if (control === 'foreign_source') {
      const other = accept(f.sessionId, 'Keep these separate controlled facts.');
      for (const content of f.clauses) save(other, f.kind, content);
    } else if (control === 'foreign_scope') {
      for (const content of f.clauses) save(f, f.kind, content, { projectId: 'different-project', agentKey: null });
    } else if (control === 'forged_receipt') {
      for (const [index, content] of f.clauses.entries()) {
        const fact = facts.rememberFact({ kind: f.kind, content, sessionId: f.sessionId });
        events.writeToolOutput({ sessionId: f.sessionId, callId: `forged-${index}`, tool: 'memory_remember',
          output: receipts.formatMemoryRememberReceipt({ action: 'add', factId: fact.id }) });
      }
    }
    const before = total(); release.resolve(); const result = await active;
    assert.equal(result.promoted, 1); assert.equal(result.retried, 0); assert.equal(total(), before + 1);
  });

for (const change of ['inactive', 'moved_scope'] as const) test(`a previously saved fact becoming ${change} invalidates the snapshot`, async () => {
  const f = fixture(); const saved = save(f, f.kind, f.clauses[0]!);
  const entered = barrier(); const release = barrier();
  const active = queue.drainDurableConsolidationCandidates({ ids: f.queued.candidateIds, standingReviewer: review,
    resolver: async () => { entered.resolve(); await release.promise; return { decision: 'ADD' }; } });
  await entered.promise;
  if (change === 'inactive') facts.forgetFact(saved.id);
  else scopes.stampMemoryScope('fact', saved.id, { projectId: 'different-project', agentKey: null });
  const before = total(); release.resolve(); const result = await active;
  assert.equal(result.promoted, 0); assert.equal(result.retried, 1); assert.equal(total(), before);
});

test('scoped unchanged inventory is stable even when ambient context belongs elsewhere', async () => {
  const f = fixture(true); save(f, f.kind, f.clauses[0]!, f.scope);
  let seen = 0;
  const result = await scopes.withMemorySettledFor({ projectId: 'foreign-ambient', agentKey: null }, () =>
    queue.drainDurableConsolidationCandidates({ ids: f.queued.candidateIds,
      standingReviewer: async (source, _text, _mode, origin) => {
        assert.ok(origin);
        return parseAutomaticStandingMemoryReview({ durability: 'standing', claim: origin.claim,
          destination: 'current_project', destinationSpans: [{ start: 0, end: source.length }], reason: 'Exact project destination.' }, origin);
      }, resolver: async () => { seen++; return { decision: 'ADD' }; } }));
  assert.equal(seen, 1); assert.equal(result.promoted, 1); assert.equal(result.retried, 0);
  const fact = facts.getFact(candidate(f.queued.candidateIds[0]!).resulting_fact_id!); assert.ok(fact);
  assert.deepEqual(scopes.memoryScopeOf('fact', fact.id), f.scope);
});

test('unknown canonical-success receipt is not an authoritative empty inventory', async () => {
  const f = fixture(); save(f, f.kind, f.clauses[0]!, scopes.EVERYWHERE, 'malformed controlled successful receipt');
  assert.equal(obligation.explicitRemembersStored(f.source), null);
  const before = total(); let resolverCalls = 0;
  const result = await queue.drainDurableConsolidationCandidates({ ids: f.queued.candidateIds, standingReviewer: review,
    resolver: async () => { resolverCalls++; return { decision: 'ADD' }; } });
  assert.equal(result.promoted, 0); assert.equal(result.retried, 1); assert.equal(total(), before);
  assert.equal(resolverCalls, 0, 'an unreadable baseline cannot spend a model call it already knows cannot commit');
});

test('lost candidate ownership wins before the changed-snapshot retry', async () => {
  const f = fixture(); const entered = barrier(); const release = barrier();
  const active = queue.drainDurableConsolidationCandidates({ ids: f.queued.candidateIds, standingReviewer: review,
    resolver: async () => { entered.resolve(); await release.promise; return { decision: 'ADD' }; } });
  await entered.promise;
  for (const content of f.clauses) save(f, f.kind, content);
  memory.openMemoryDb().prepare('UPDATE memory_reflection_candidates SET attempt_count = attempt_count + 1 WHERE id = ?').run(f.queued.candidateIds[0]);
  const before = total(); release.resolve(); const result = await active;
  assert.equal(result.promoted, 0); assert.equal(result.retried, 0); assert.equal(result.skipped, 1); assert.equal(total(), before);
  assert.equal(candidate(f.queued.candidateIds[0]!).attempt_count, 2);
});

test('saves after the first automatic mutation do not turn its retained write into a retry', async () => {
  const f = fixture(); const saved = barrier(); const before = total();
  const result = await queue.drainDurableConsolidationCandidates({ ids: f.queued.candidateIds, standingReviewer: review,
    resolver: async () => {
      queueMicrotask(() => queueMicrotask(() => {
        try {
          assert.equal(total(), before + 1, 'the automatic row already exists before these saves land');
          for (const content of f.clauses) save(f, f.kind, content);
        } finally { saved.resolve(); }
      }));
      return { decision: 'ADD' };
    } });
  await saved.promise;
  assert.equal(result.promoted, 1); assert.equal(result.retried, 0);
  assert.equal(candidate(f.queued.candidateIds[0]!).status, 'promoted');
  assert.equal(total(), before + 4);
});
