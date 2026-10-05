/** Exact-source destination pipeline. Synthetic disposable stores; no provider. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AutomaticMemoryDecision, AutomaticMemoryOrigin } from './memory-destination.js';
import type { StandingMemoryReview } from './standing-memory-review.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-auto-destination-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.CLEMMY_EMBED_AT_WRITE = 'off';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(home, 'state'), { recursive: true });
const log = await import('../runtime/harness/eventlog.js');
const contexts = await import('../runtime/harness/source-session-context.js');
const agents = await import('../agents/agent-record.js');
const projects = await import('../projects/project-record.js');
const { setSessionAgent } = await import('../agents/session-agent.js');
const { setSessionProject } = await import('../projects/session-project.js');
const capture = await import('./auto-capture.js');
const queue = await import('./durable-consolidation.js');
const candidates = await import('./reflection-candidates.js');
const memory = await import('./db.js');
const facts = await import('./facts.js');
const scopes = await import('./memory-scope.js');
const profile = await import('../runtime/user-profile.js');
const { parseAutomaticStandingMemoryReview } = await import('./standing-memory-review.js');
after(() => { memory.closeMemoryDb(); log.closeEventLog(); projects._closeProjectStoreForTests(); rmSync(home, { recursive: true, force: true }); });
let serial = 0;
function fixture(text: string, retained = true) {
  const n = ++serial;
  const agent = agents.createAgentRecord({ name: `Destination specialist ${n}`, instructions: `Synthetic context ${n}`, createdFrom: 'console' });
  const project = projects.createProject({ name: `Destination project ${n}`, context: `Synthetic project ${n}` });
  assert.ok(agent.ok); assert.ok(project.ok);
  const session = log.createSession({ id: `destination-pipeline-${n}`, kind: 'chat' });
  assert.ok(setSessionAgent(session.id, agent.agent.id, { by: 'owner' }).ok);
  assert.ok(setSessionProject(session.id, project.project.id, { by: 'owner' }).ok);
  const event = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  const context = retained ? contexts.captureFreshSourceSessionContext({ sessionId: session.id, sourceUserSeq: event.seq }) : null;
  const input = { message: text, sessionId: session.id, sourceEventId: `user-source:${event.seq}`,
    sourceProvenance: capture.autoCaptureProvenanceFromAcceptedEvent(event) };
  const selected = capture.selectAutoMemoryCandidates(text);
  const origins = capture.automaticMemoryOriginsForCapture(input, selected);
  return { ...input, selected, origins, context, event, project: project.project, agent: agent.agent };
}
function enqueue(f: ReturnType<typeof fixture>) {
  assert.ok(f.selected.length, 'fixture must be admitted before queue assertions');
  assert.ok(f.origins.every(Boolean));
  return queue.enqueueAutoCaptureCandidates({ ...f, candidates: f.selected, origins: f.origins });
}
function review(destination: AutomaticMemoryDecision['destination'] = 'kind_default', durability: AutomaticMemoryDecision['durability'] = 'standing') {
  return async (source: string, _text: string, _mode?: unknown, origin?: AutomaticMemoryOrigin): Promise<StandingMemoryReview> => {
    assert.ok(origin); assert.equal(source, origin.source.ownerText);
    const decision: AutomaticMemoryDecision = { durability, claim: origin.claim, destination,
      destinationSpans: destination === 'kind_default' || destination === 'unresolved' ? [] : [{ start: 0, end: source.length }],
      reason: 'Controlled exact source decision' };
    return parseAutomaticStandingMemoryReview(decision, origin);
  };
}
const add = async () => ({ decision: 'ADD' as const });
function row(id: number) { const found = candidates.readAutomaticMemoryCandidate(id); assert.equal(found.status, 'valid'); if (found.status !== 'valid') throw new Error('candidate'); return found; }
function currentFact(id: number) { const found = row(id).row; assert.ok(found.resulting_fact_id); const fact = facts.getFact(found.resulting_fact_id); assert.ok(fact); return fact; }
function count(table: string) { return (memory.openMemoryDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; }
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('brand-new global source initializes canonical scope and qualifies an actual global fact', async () => {
  const session = log.createSession({ id: 'destination-brand-new-global', kind: 'chat' });
  const message = 'Remember this: my global label is IVORY.';
  const event = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: message } });
  const context = contexts.captureFreshSourceSessionContext({ sessionId: session.id, sourceUserSeq: event.seq });
  assert.ok(context); assert.deepEqual(context.memoryScope, scopes.EVERYWHERE);
  const input = { message, sessionId: session.id, sourceEventId: `user-source:${event.seq}`,
    sourceProvenance: capture.autoCaptureProvenanceFromAcceptedEvent(event) };
  const selected = capture.selectAutoMemoryCandidates(message);
  const origins = capture.automaticMemoryOriginsForCapture(input, selected);
  const queued = queue.enqueueAutoCaptureCandidates({ ...input, candidates: selected, origins });
  assert.ok(memory.openMemoryDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_scopes'").get());
  assert.equal(scopes.sameScope(scopes.memoryScopeOf('episode', queued.episodeId!), scopes.EVERYWHERE), true);
  assert.equal((await queue.drainDurableConsolidationCandidates({ ids: queued.candidateIds, resolver: add, standingReviewer: review() })).promoted, 1);
  assert.equal(scopes.sameScope(scopes.memoryScopeOf('fact', currentFact(queued.candidateIds[0]!).id), scopes.EVERYWHERE), true);
});

test('raw UTF-16/whitespace offsets preserve repeated command claims and neighboring assertions', () => {
  const f = fixture('  Remember this: code 😀 is BLUE.\n\n Remember this: code 😀 is BLUE.  ');
  assert.equal(f.selected.length, 2);
  assert.equal(f.selected[0]!.content, f.selected[1]!.content);
  assert.ok(f.origins.every(origin => origin?.claimMode === 'complete'));
  assert.notDeepEqual(f.origins[0]!.claim, f.origins[1]!.claim);
  assert.deepEqual(f.origins.map(origin => origin!.source.ownerText.slice(origin!.claim.start, origin!.claim.end)),
    ['code 😀 is BLUE.', 'code 😀 is BLUE.']);
  assert.equal(enqueue(f).candidateIds.length, 2);
  const g = fixture(`Remember this: the heading is INDIGO and the footnote is AMBER, unless the owner cancels. ${'A complementary convention stays intact. '.repeat(10)}`);
  assert.ok(g.origins[0]!.source.ownerText.slice(g.origins[0]!.claim.start, g.origins[0]!.claim.end).endsWith('A complementary convention stays intact.'));
});

test('same literal with distinct explicit destinations keeps separate source intervals', async () => {
  const f = fixture('In the current project, remember this: code is BLUE. Everywhere, remember this: code is BLUE.');
  assert.equal(f.selected.length, 2);
  const queued = enqueue(f);
  let n = 0;
  const result = await queue.drainDurableConsolidationCandidates({ ids: queued.candidateIds, resolver: add,
    standingReviewer: async (...args) => review(n++ === 0 ? 'current_project' : 'everywhere')(...args) });
  assert.equal(result.promoted, 2);
  assert.deepEqual(scopes.memoryScopeOf('fact', currentFact(queued.candidateIds[0]!).id), { projectId: f.project.id, agentKey: null });
  assert.equal(scopes.sameScope(scopes.memoryScopeOf('fact', currentFact(queued.candidateIds[1]!).id), scopes.EVERYWHERE), true);
});

test('scope reopens original project and agent after UI selection changes and DB reopen', async () => {
  const f = fixture('Remember this: the project launch label is JADE.'); const queued = enqueue(f);
  const episodeBefore = memory.openMemoryDb().prepare('SELECT * FROM memory_episodes WHERE id = ?').get(queued.episodeId);
  const episodeScope = scopes.memoryScopeOf('episode', queued.episodeId!);
  const other = fixture('Remember this: an unrelated project code is OLIVE.');
  setSessionAgent(f.sessionId, other.agent.id, { by: 'owner' }); setSessionProject(f.sessionId, other.project.id, { by: 'owner' });
  memory.closeMemoryDb(); log.closeEventLog();
  assert.deepEqual(enqueue(f).candidateIds, queued.candidateIds);
  assert.deepEqual(memory.openMemoryDb().prepare('SELECT * FROM memory_episodes WHERE id = ?').get(queued.episodeId), episodeBefore);
  assert.deepEqual(scopes.memoryScopeOf('episode', queued.episodeId!), episodeScope);
  assert.deepEqual(episodeScope, f.context!.memoryScope);
  assert.equal((await queue.drainDurableConsolidationCandidates({ ids: queued.candidateIds, resolver: add, standingReviewer: review() })).promoted, 1);
  assert.deepEqual(scopes.memoryScopeOf('fact', currentFact(queued.candidateIds[0]!).id), f.context!.memoryScope);
});

for (const destination of ['current_project', 'current_agent', 'current_context'] as const) test(`local ${destination} leaves global profile/entities unchanged`, async () => {
  const f = fixture('In the current project, remember this: my CFO is Dana Reed and call me Cedar.');
  const queued = enqueue(f); const beforeProfile = profile.loadUserProfile(); const beforeEntities = count('entities');
  assert.equal((await queue.drainDurableConsolidationCandidates({ ids: queued.candidateIds, resolver: add, standingReviewer: review(destination) })).promoted, 1);
  assert.deepEqual(profile.loadUserProfile(), beforeProfile); assert.equal(count('entities'), beforeEntities);
  const expected = destination === 'current_project' ? { projectId: f.project.id, agentKey: null }
    : destination === 'current_agent' ? { projectId: null, agentKey: f.context!.memoryScope.agentKey } : f.context!.memoryScope;
  assert.deepEqual(scopes.memoryScopeOf('fact', currentFact(queued.candidateIds[0]!).id), expected);
});

test('qualified global claim adapts profile only after reviewed actual save', async () => {
  const f = fixture('Remember this: call me Saffron.'); const before = profile.loadUserProfile(); const queued = enqueue(f);
  assert.deepEqual(profile.loadUserProfile(), before);
  assert.equal((await queue.drainDurableConsolidationCandidates({ ids: queued.candidateIds, resolver: add, standingReviewer: review('everywhere') })).promoted, 1);
  assert.equal(profile.loadUserProfile().preferredName, 'Saffron');
});

test('NOOP against a different active fact cannot apply the proposed profile preference', async () => {
  const f = fixture('Remember this: call me Cedar.'); const queued = enqueue(f);
  const old = scopes.withMemorySettledFor(scopes.EVERYWHERE, () => facts.rememberFact({ kind: 'user', content: 'call me Saffron.', sessionId: f.sessionId }));
  const before = profile.loadUserProfile();
  assert.equal((await queue.drainDurableConsolidationCandidates({ ids: queued.candidateIds, standingReviewer: review(),
    resolver: async () => ({ decision: 'NOOP', target_id: old.id }) })).promoted, 1);
  assert.deepEqual(profile.loadUserProfile(), before);
  assert.equal(currentFact(queued.candidateIds[0]!).content, old.content);
});

for (const mode of ['direct', 'missing_context', 'legacy'] as const) test(`${mode} intake cannot acquire automatic save authority`, async () => {
  const f = fixture('Remember this: call me Quartz.', mode !== 'missing_context');
  const before = count('consolidated_facts'); const beforeProfile = profile.loadUserProfile();
  const origins = mode === 'direct' ? capture.automaticMemoryOriginsForCapture({ ...f,
    sourceProvenance: capture.autoCaptureProvenanceFromDirectUserInput('assistant-core') }, f.selected) : f.origins;
  const queued = queue.enqueueAutoCaptureCandidates({ ...f, candidates: f.selected, origins: mode === 'legacy' ? undefined : origins });
  const result = await queue.drainDurableConsolidationCandidates({ ids: queued.candidateIds,
    resolver: async () => { assert.fail('unqualified intake must not dispatch a resolver'); },
    standingReviewer: async () => { assert.fail('unqualified intake must not dispatch a reviewer'); } });
  assert.equal(result.promoted, 0); assert.equal(result.skipped, 1);
  assert.equal(count('consolidated_facts'), before); assert.deepEqual(profile.loadUserProfile(), beforeProfile);
});

test('foreign source text and full-turn privacy do not become destination authority', () => {
  const f = fixture('Remember this: a synthetic label is PEARL.');
  assert.deepEqual(capture.automaticMemoryOriginsForCapture({ ...f, sourceProvenance: { ...f.sourceProvenance,
    data: { text: 'Remember this: a different label is CORAL.' } } }, f.selected), [null]);
  assert.deepEqual(capture.selectAutoMemoryCandidates('Remember this: call me Pearl. Do not save this as memory.'), []);
});

test('narrowed source cannot omit the broader owner privacy boundary', async () => {
  const narrowed = 'Remember this: the project label is ROSE.';
  const f = fixture(`Do not save this request as memory. ${narrowed}`);
  const selected = capture.selectAutoMemoryCandidates(narrowed);
  assert.ok(selected.length);
  assert.deepEqual(capture.automaticMemoryOriginsForCapture({ ...f, message: narrowed }, selected), selected.map(() => null));
  // A previously queued typed envelope must also be revalidated, not merely
  // trust that today's producer would decline creating it.
  const { createAutomaticMemoryOrigin } = await import('./memory-destination.js');
  const origin = createAutomaticMemoryOrigin({ source: { authority: 'accepted_user_input', sessionId: f.sessionId,
    eventId: f.event.id, eventSeq: f.event.seq, eventType: 'user_input_received', ownerText: f.message,
    context: { sessionId: f.sessionId, sourceUserSeq: f.event.seq, digest: f.context!.digest, memoryScope: f.context!.memoryScope } },
    claim: capture.uniqueAutomaticMemorySpan(f.message, selected[0]!.content)!, claimMode: 'complete',
    candidate: { kind: selected[0]!.kind, text: selected[0]!.content } });
  const queued = queue.enqueueAutoCaptureCandidates({ ...f, message: narrowed, candidates: selected, origins: [origin] });
  const result = await queue.drainDurableConsolidationCandidates({ ids: queued.candidateIds,
    standingReviewer: async () => { assert.fail('full-owner privacy must refuse before review'); }, resolver: add });
  assert.equal(result.promoted, 0); assert.equal(result.skipped, 1);
});

test('named task-only opt-out still permits its separate fresh memory command', async () => {
  const narrowed = 'Remember this: the project label is LILAC.';
  const f = fixture(`Do not save the scraping task as memory; ${narrowed}`);
  const selected = capture.selectAutoMemoryCandidates(narrowed);
  const origins = capture.automaticMemoryOriginsForCapture({ ...f, message: narrowed }, selected);
  assert.ok(origins.length); assert.ok(origins.every(origin => origin?.claimMode === 'complete'));
  const queued = queue.enqueueAutoCaptureCandidates({ ...f, message: narrowed, candidates: selected, origins });
  assert.equal((await queue.drainDurableConsolidationCandidates({ ids: queued.candidateIds,
    standingReviewer: review(), resolver: add })).promoted, 1);
});

for (const durability of ['task', 'unresolved'] as const) test(`${durability} review never promotes or changes profile`, async () => {
  const f = fixture('Remember this: call me Topaz.'); const queued = enqueue(f); const before = count('consolidated_facts');
  const result = await queue.drainDurableConsolidationCandidates({ ids: queued.candidateIds,
    standingReviewer: review('unresolved', durability), resolver: async () => { assert.fail('no destination, no consolidation'); } });
  assert.equal(result.promoted, 0); assert.equal(result.skipped, 1); assert.equal(count('consolidated_facts'), before);
  assert.equal(row(queued.candidateIds[0]!).envelope.decision?.durability, durability);
});

test('durability-only review and dropped neighboring assertion are retryable, not default-global', async () => {
  for (const malformed of [true, false]) {
    const f = fixture('Remember this: heading is INDIGO; footnote is AMBER.'); const queued = enqueue(f);
    const result = await queue.drainDurableConsolidationCandidates({ ids: queued.candidateIds, resolver: add,
      standingReviewer: async (source, text, _mode, origin) => malformed
        ? { scope: 'standing', text, reason: 'old review contract' }
        : { scope: 'standing', reason: 'lost neighbor', destinationDecision: { durability: 'standing',
          claim: { start: origin!.claim.start, end: source.indexOf(';') }, destination: 'kind_default', destinationSpans: [], reason: 'lost neighbor' } } });
    assert.equal(result.promoted, 0); assert.equal(result.retried, 1);
    assert.equal(row(queued.candidateIds[0]!).envelope.decision, null);
  }
});

test('technical retry reuses exact decision without a second review and replay adds no duplicate', async () => {
  const f = fixture('Remember this: my beverage label is CINNAMON.'); const queued = enqueue(f); let reviews = 0;
  const now = new Date().toISOString();
  const first = await queue.drainDurableConsolidationCandidates({ ids: queued.candidateIds, now,
    standingReviewer: async (...args) => { reviews++; return review()(...args); }, resolver: async () => { throw new Error('controlled unavailable resolver'); } });
  assert.equal(first.retried, 1);
  const again = await queue.drainDurableConsolidationCandidates({ ids: queued.candidateIds, now: new Date(Date.parse(now) + 60_000).toISOString(),
    standingReviewer: async () => { assert.fail('persisted review must be reused'); }, resolver: add });
  assert.equal(again.promoted, 1); assert.equal(reviews, 1);
  const before = count('consolidated_facts'); assert.deepEqual(enqueue(f).candidateIds, queued.candidateIds);
  assert.equal((await queue.drainDurableConsolidationCandidates({ ids: queued.candidateIds,
    standingReviewer: async () => { assert.fail('terminal replay cannot review'); }, resolver: add })).selected, 0);
  assert.equal(count('consolidated_facts'), before);
});

for (const reclaim of [false, true]) test(`resolver barrier ${reclaim ? 'reclaimed owner cannot mutate or settle' : 'valid owner still applies its update'}`, async () => {
  const f = fixture(`Remember this: my tea recipe ${serial} is roasted barley.`); const queued = enqueue(f);
  const old = scopes.withMemorySettledFor(scopes.EVERYWHERE, () => facts.rememberFact({ kind: 'user', content: `My tea recipe ${serial} is jasmine.`, sessionId: f.sessionId }));
  const entered = barrier(); const release = barrier(); const now = new Date().toISOString();
  const active = queue.drainDurableConsolidationCandidates({ ids: queued.candidateIds, now, standingReviewer: review(),
    resolver: async () => { entered.resolve(); await release.promise; return { decision: 'UPDATE', target_id: old.id }; } });
  await entered.promise;
  if (reclaim) {
    const successor = await queue.drainDurableConsolidationCandidates({ ids: queued.candidateIds,
      now: new Date(Date.parse(now) + 6 * 60_000).toISOString(), resolver: add,
      standingReviewer: async () => { assert.fail('successor reuses frozen decision'); } });
    assert.equal(successor.promoted, 1);
  }
  release.resolve(); const result = await active;
  assert.equal(result.promoted, reclaim ? 0 : 1); assert.equal(result.skipped, reclaim ? 1 : 0);
  assert.equal(facts.getFact(old.id)?.active, reclaim);
  assert.equal(row(queued.candidateIds[0]!).row.status, 'promoted');
  assert.equal(row(queued.candidateIds[0]!).row.attempt_count, reclaim ? 2 : 1);
  assert.match(currentFact(queued.candidateIds[0]!).content, /roasted barley/);
});
