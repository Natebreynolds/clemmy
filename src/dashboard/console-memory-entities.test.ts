import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-console-memory-entities-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.NODE_ENV = 'test';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { resetMemoryDb, openMemoryDb } = await import('../memory/db.js');
const { forgetFact, getFact, getFactWithEvidence, rememberFact } = await import('../memory/facts.js');
const { recordMemoryEpisode, linkFactEvidence } = await import('../memory/temporal-memory.js');
const { vectorToBuffer, _setEmbeddingProviderForTest } = await import('../memory/embeddings.js');
const { upsertEntity } = await import('../memory/entity-identity.js');
const { addFactEntityLinks, setFactEntityLinks } = await import('../memory/relations.js');
const { recordReflectionCandidate, resolveReflectionCandidate } = await import('../memory/reflection-candidates.js');
const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

async function boot(authorized = { value: true }) {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => authorized.value, {} as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const instance = createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('memory readiness route is authenticated, read-only, and reports explicit safeguards', async () => {
  resetMemoryDb();
  rememberFact({ kind: 'constraint', content: 'Never send externally without approval.' });
  const beforeVersion = (openMemoryDb().prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version;
  const authorized = { value: false };
  const harness = await boot(authorized);
  try {
    assert.equal((await fetch(`${harness.url}/api/console/memory/readiness`)).status, 401);
    authorized.value = true;
    const response = await fetch(`${harness.url}/api/console/memory/readiness`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      ready: boolean;
      mode: string;
      observedSchemaVersion: number;
      checks: Array<{ id: string; status: string }>;
    };
    assert.equal(body.ready, true);
    assert.equal(body.mode, 'read-only');
    assert.equal(body.observedSchemaVersion, beforeVersion);
    assert.equal(body.checks.find((item) => item.id === 'policy_dispatch')?.status, 'pass');
    assert.equal(body.checks.find((item) => item.id === 'sqlite_integrity')?.status, 'pass');
    const afterVersion = (openMemoryDb().prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version;
    assert.equal(afterVersion, beforeVersion);
  } finally {
    await harness.close();
  }
});

test('memory health exposes prompt inclusion and omission telemetry', async () => {
  resetMemoryDb();
  resetEventLog();
  const session = createSession({ id: 'memory-health-primer', kind: 'chat' });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'turn_memory_primer',
    data: {
      enabled: true,
      includedCount: 4,
      omittedCount: 3,
      candidateCount: 17,
      injected: true,
      source: 'unified',
    },
  });
  const harness = await boot();
  try {
    const response = await fetch(`${harness.url}/api/console/memory/health`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      reliability: { promptContext: { runs: number; included: number; omitted: number; candidates: number } };
    };
    assert.equal(body.reliability.promptContext.runs, 1);
    assert.equal(body.reliability.promptContext.included, 4);
    assert.equal(body.reliability.promptContext.omitted, 3);
    assert.equal(body.reliability.promptContext.candidates, 17);
  } finally {
    await harness.close();
  }
});

test('facts route reports visible and total counts instead of silently clipping', async () => {
  resetMemoryDb();
  rememberFact({ kind: 'reference', content: 'Archive fact one.' });
  rememberFact({ kind: 'reference', content: 'Archive fact two.' });
  const historical = rememberFact({ kind: 'reference', content: 'Archive fact three, now historical.' });
  forgetFact(historical.id);
  rememberFact({ kind: 'user', content: 'Alexander prefers accurate coverage counts.' });
  const harness = await boot();
  try {
    const response = await fetch(`${harness.url}/api/console/memory/facts?kind=reference&limit=1`);
    assert.equal(response.status, 200);
    const body = await response.json() as { facts: Array<{ kind: string }>; total: number; visible: number };
    assert.equal(body.facts.length, 1);
    assert.equal(body.facts[0]?.kind, 'reference');
    assert.equal(body.visible, 1);
    assert.equal(body.total, 2);

    const historyResponse = await fetch(`${harness.url}/api/console/memory/facts?kind=reference&limit=2&includeInactive=1`);
    assert.equal(historyResponse.status, 200);
    const history = await historyResponse.json() as { facts: Array<{ kind: string }>; total: number; visible: number };
    assert.equal(history.facts.length, 2);
    assert.equal(history.facts.every((fact) => fact.kind === 'reference'), true);
    assert.equal(history.visible, 2);
    assert.equal(history.total, 3);
  } finally {
    await harness.close();
  }
});

test('desktop memory review exposes exact duplicate facts and owner approval preserves both sources', async () => {
  resetMemoryDb();
  _setEmbeddingProviderForTest({
    name: 'review-test', model: 'review-test', dim: 4,
    async embed(texts) { return texts.map(() => new Float32Array(4)); },
  });
  const keep = rememberFact({
    kind: 'project', content: 'Example Legal Group SEO report lives at example-legal.example/report.',
    score: 5, importance: 8,
  });
  const drop = rememberFact({
    kind: 'project', content: 'The Example Legal Group SEO report is at example-legal.example/report.',
    score: 1, importance: 6,
  });
  rememberFact({ kind: 'user', content: 'Can you resend the Example Legal report to me today?' });
  const db = openMemoryDb();
  const embed = db.prepare(`
    INSERT OR REPLACE INTO fact_embeddings
      (fact_id, model, dim, vector, content_hash, created_at)
    VALUES (?, 'review-test', 4, ?, ?, ?)
  `);
  const hash = (id: number) => (db.prepare('SELECT content_hash FROM consolidated_facts WHERE id = ?').get(id) as { content_hash: string }).content_hash;
  embed.run(keep.id, vectorToBuffer(Float32Array.from([1, 0, 0, 0])), hash(keep.id), new Date().toISOString());
  embed.run(drop.id, vectorToBuffer(Float32Array.from([0.999, 0.001, 0, 0])), hash(drop.id), new Date().toISOString());

  const harness = await boot();
  try {
    const response = await fetch(`${harness.url}/api/console/memory/review-candidates?limit=25`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      total: number;
      visible: number;
      byKind: { merge_duplicate: number; retire_transient_request: number };
      candidates: Array<{
        id: string; kind: string; payload: { keepId: number; dropId: number };
        targetFacts: Array<{ id: number; evidence: unknown[] }>;
      }>;
    };
    assert.equal(body.total, 2);
    assert.equal(body.visible, 2);
    assert.deepEqual(body.byKind, { merge_duplicate: 1, retire_transient_request: 1 });
    assert.equal(body.candidates[0]?.kind, 'merge_duplicate', 'review families are fairly interleaved with duplicates visible first');
    assert.ok(body.candidates.some((item) => item.kind === 'retire_transient_request'));
    const candidate = body.candidates.find((item) => item.kind === 'merge_duplicate');
    assert.ok(candidate, 'review queue should show the semantic duplicate pair');
    assert.equal(candidate.payload.keepId, keep.id);
    assert.equal(candidate.payload.dropId, drop.id);
    assert.equal(candidate.targetFacts.length, 2);
    assert.equal(candidate.targetFacts.every((fact) => fact.evidence.length === 1), true, 'desktop sees both source histories before approval');

    const appliedResponse = await fetch(`${harness.url}/api/console/memory/review-candidates/${candidate.id}/apply`, { method: 'POST' });
    assert.equal(appliedResponse.status, 200);
    const applied = await appliedResponse.json() as { ok: boolean; message: string };
    assert.equal(applied.ok, true);
    assert.match(applied.message, /preserved 1 evidence source/);
    assert.equal(getFact(drop.id)?.active, false);
    assert.equal(getFact(drop.id)?.supersededByFactId, keep.id);
    assert.equal(getFactWithEvidence(keep.id)?.evidence?.length, 2);
  } finally {
    await harness.close();
  }
});

test('memory health exposes per-claim reflection lifecycle', async () => {
  resetMemoryDb();
  const db = openMemoryDb();
  const now = '2026-07-15T12:00:00.000Z';
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
  recordReflectionCandidate({
    sessionId: 'health-session', callId: 'promoted-call', kind: 'reference',
    text: 'Dana is the Acme billing contact.', importance: 5, now,
  });
  resolveReflectionCandidate({
    sessionId: 'health-session', callId: 'promoted-call',
    text: 'Dana is the Acme billing contact.', status: 'promoted', reason: 'consolidation:add', now,
  });
  recordReflectionCandidate({
    sessionId: 'health-session', callId: 'rejected-call', kind: 'reference',
    text: 'Clementine searched the CRM.', importance: 3,
    status: 'rejected', reason: 'assistant_action_history', now,
  });
  recordReflectionCandidate({
    sessionId: 'health-session', callId: 'pending-call', kind: 'reference',
    text: 'The Quorvex archive is amber.', importance: 4, now,
  });
  db.prepare(`
    INSERT INTO reflection_pending_extractions
      (session_id, call_id, tool, extraction_json, importance, created_at, expires_at, status)
    VALUES ('health-session', 'pending-call', 'read_file', '{}', 4, ?, ?, 'pending')
  `).run(now, expiresAt);

  const harness = await boot();
  try {
    const response = await fetch(`${harness.url}/api/console/memory/health`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      reliability: { reflectionCandidates: {
        total: number; promoted: number; rejected: number; pending: number;
        pendingUniqueClaims: number; duplicatePendingObservations: number; knownExactPending: number;
        overduePending: number; orphanedPending: number; rejectionReasons: Record<string, number>;
      } };
    };
    assert.equal(body.reliability.reflectionCandidates.total, 3);
    assert.equal(body.reliability.reflectionCandidates.promoted, 1);
    assert.equal(body.reliability.reflectionCandidates.rejected, 1);
    assert.equal(body.reliability.reflectionCandidates.pending, 1);
    assert.equal(body.reliability.reflectionCandidates.pendingUniqueClaims, 1);
    assert.equal(body.reliability.reflectionCandidates.duplicatePendingObservations, 0);
    assert.equal(body.reliability.reflectionCandidates.knownExactPending, 0);
    assert.equal(body.reliability.reflectionCandidates.overduePending, 0);
    assert.equal(body.reliability.reflectionCandidates.orphanedPending, 0);
    assert.equal(body.reliability.reflectionCandidates.rejectionReasons.assistant_action_history, 1);

    const ledgerResponse = await fetch(`${harness.url}/api/console/memory/reflection-candidates?limit=10`);
    assert.equal(ledgerResponse.status, 200);
    const ledger = await ledgerResponse.json() as {
      candidates: Array<{ text: string; status: string; reason: string | null; resultingFactId: number | null }>;
      health: { total: number };
    };
    assert.equal(ledger.health.total, 3);
    assert.equal(ledger.candidates.length, 3);
    assert.ok(ledger.candidates.some((candidate) => candidate.status === 'rejected' && candidate.reason === 'assistant_action_history'));
    assert.ok(ledger.candidates.some((candidate) => candidate.status === 'promoted'));
  } finally {
    await harness.close();
  }
});

test('brain health counts durable source episodes instead of only legacy pointers', async () => {
  resetMemoryDb();
  recordMemoryEpisode({
    kind: 'tool_result', subtype: 'meeting', title: 'Current in-person review',
    sourceApp: 'Clementine Meetings (In-person)', occurredAt: new Date().toISOString(),
    content: 'The current in-person review covered launch readiness.',
  });
  recordMemoryEpisode({
    kind: 'manual', title: 'Historical note', occurredAt: '2020-01-01T00:00:00.000Z',
    content: 'A historical source episode.',
  });
  const harness = await boot();
  try {
    const response = await fetch(`${harness.url}/api/console/brain/health`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      pointersTotal: number;
      memoryEpisodesTotal: number;
      memoryEpisodesRecent: number;
      recordedMeetingsTotal: number;
    };
    assert.equal(body.pointersTotal, 0, 'legacy pointers stay separately observable');
    assert.equal(body.memoryEpisodesTotal, 2);
    assert.equal(body.memoryEpisodesRecent, 1);
    assert.equal(body.recordedMeetingsTotal, 1);
  } finally {
    await harness.close();
  }
});

test('episode timeline exposes exact source coverage, filters, and visible counts', async () => {
  resetMemoryDb();
  const meeting = recordMemoryEpisode({
    kind: 'tool_result', subtype: 'meeting', title: 'In-person Orchid review',
    sourceApp: 'Clementine Meetings (In-person)',
    sessionId: 'meeting:local', callId: 'orchid-live-review',
    sourceUri: 'meeting://local/orchid-live-review',
    occurredAt: '2026-07-15T17:00:00.000Z',
    content: 'Summary: The Orchid review covered launch readiness and migration timing.',
  });
  recordMemoryEpisode({
    kind: 'manual', title: 'Older manual note',
    occurredAt: '2026-07-14T09:00:00.000Z',
    content: 'A manually recorded source.',
  });
  const fact = rememberFact({ kind: 'project', content: 'The Orchid launch is ready for migration.' });
  linkFactEvidence({
    factId: fact.id, episodeId: meeting.id,
    excerpt: 'The Orchid review covered launch readiness and migration timing.',
    sourceUri: meeting.source_uri,
  });
  const candidateId = recordReflectionCandidate({
    episodeId: meeting.id, sessionId: 'meeting:local', callId: 'orchid-live-review',
    kind: 'project', text: 'The Orchid launch is ready for migration.', importance: 7,
    sourceType: 'meeting_analysis', intakeReason: 'structured meeting decision',
    trustLevel: 0.82, authority: 'derived', sourceUri: meeting.source_uri,
  });
  upsertEntity({
    type: 'person', name: 'Dana Smith', evidenceEpisodeId: meeting.id,
    sourceUri: meeting.source_uri, sourceKind: 'meeting_participant',
  });
  const harness = await boot();
  try {
    const response = await fetch(`${harness.url}/api/console/memory/episodes?kind=meeting&q=orchid&limit=1`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      total: number; allTotal: number; visible: number; hasMore: boolean;
      summary: {
        meetings: number;
        pendingCandidates: number;
        pendingUniqueClaims: number;
        pendingCandidatesBySource: Record<string, number>;
        pendingUniqueClaimsBySource: Record<string, number>;
        byKind: Record<string, number>;
        byStatus: Record<string, number>;
      };
      episodes: Array<{
        id: string; kind: string; subtype: string; title: string; sourceUri: string;
        excerpt: string; claimCount: number; entityCount: number; status: string;
        candidateCount: number; pendingCandidateCount: number;
        candidates: Array<{ id: number; status: string; resultingFactId: number | null; pendingEquivalentCount: number }>;
      }>;
    };
    assert.equal(body.total, 1);
    assert.equal(body.allTotal, 3, 'the fact write also has its own manual evidence episode');
    assert.equal(body.visible, 1);
    assert.equal(body.hasMore, false);
    assert.equal(body.summary.meetings, 1);
    assert.equal(body.summary.pendingCandidates, 1);
    assert.equal(body.summary.pendingUniqueClaims, 1);
    assert.equal(body.summary.pendingCandidatesBySource.meeting_analysis, 1);
    assert.equal(body.summary.pendingUniqueClaimsBySource.meeting_analysis, 1);
    assert.equal(body.summary.byKind.tool_result, 1);
    assert.equal(body.summary.byStatus.available, 3);
    assert.equal(body.episodes[0]?.id, meeting.id);
    assert.equal(body.episodes[0]?.subtype, 'meeting');
    assert.equal(body.episodes[0]?.sourceUri, 'meeting://local/orchid-live-review');
    assert.match(body.episodes[0]?.excerpt ?? '', /launch readiness/);
    assert.equal(body.episodes[0]?.claimCount, 1);
    assert.equal(body.episodes[0]?.entityCount, 1);
    assert.equal(body.episodes[0]?.candidateCount, 1);
    assert.equal(body.episodes[0]?.pendingCandidateCount, 1);
    assert.equal(body.episodes[0]?.candidates[0]?.id, candidateId);
    assert.equal(body.episodes[0]?.candidates[0]?.pendingEquivalentCount, 1);

    const reviewResponse = await fetch(`${harness.url}/api/console/memory/episodes?review=pending`);
    assert.equal(reviewResponse.status, 200);
    const review = await reviewResponse.json() as {
      total: number; summary: { pendingCandidates: number };
      episodes: Array<{ id: string; pendingCandidateCount: number }>;
    };
    assert.equal(review.total, 1, 'review filter reaches the pending meeting regardless of timeline position');
    assert.equal(review.summary.pendingCandidates, 1);
    assert.equal(review.episodes[0]?.id, meeting.id);
    assert.equal(review.episodes[0]?.pendingCandidateCount, 1);
    const meetingReviewResponse = await fetch(`${harness.url}/api/console/memory/episodes?candidateSource=meeting_analysis`);
    const meetingReview = await meetingReviewResponse.json() as { total: number; episodes: Array<{ id: string }> };
    assert.equal(meetingReview.total, 1);
    assert.equal(meetingReview.episodes[0]?.id, meeting.id);
    const unrelatedReviewResponse = await fetch(`${harness.url}/api/console/memory/episodes?candidateSource=auto_capture`);
    assert.equal((await unrelatedReviewResponse.json() as { total: number }).total, 0);

    const promotedResponse = await fetch(`${harness.url}/api/console/memory/reflection-candidates/${candidateId}/promote`, { method: 'POST' });
    assert.equal(promotedResponse.status, 200);
    const promoted = await promotedResponse.json() as {
      ok: boolean;
      factId: number;
      action: string;
      coalescedCandidateIds: number[];
      evidenceSourcesAdded: number;
    };
    assert.equal(promoted.ok, true);
    assert.equal(promoted.factId, fact.id);
    assert.equal(promoted.action, 'reinforce');
    assert.deepEqual(promoted.coalescedCandidateIds, []);
    assert.equal(promoted.evidenceSourcesAdded, 1);
    const resolved = openMemoryDb().prepare(`
      SELECT status, resulting_fact_id FROM memory_reflection_candidates WHERE id = ?
    `).get(candidateId) as { status: string; resulting_fact_id: number };
    assert.deepEqual(resolved, { status: 'promoted', resulting_fact_id: fact.id });
    const emptyReviewResponse = await fetch(`${harness.url}/api/console/memory/episodes?review=pending`);
    const emptyReview = await emptyReviewResponse.json() as {
      total: number;
      summary: {
        pendingCandidates: number;
        pendingUniqueClaims: number;
        pendingCandidatesBySource: Record<string, number>;
        pendingUniqueClaimsBySource: Record<string, number>;
      };
    };
    assert.equal(emptyReview.total, 0);
    assert.equal(emptyReview.summary.pendingCandidates, 0);
    assert.equal(emptyReview.summary.pendingUniqueClaims, 0);
    assert.equal(emptyReview.summary.pendingCandidatesBySource.meeting_analysis, undefined);
    assert.equal(emptyReview.summary.pendingUniqueClaimsBySource.meeting_analysis, undefined);
  } finally {
    await harness.close();
  }
});

test('desktop quick-add reports consolidation and never creates an exact duplicate', async () => {
  resetMemoryDb();
  const harness = await boot();
  try {
    const content = 'The Quorvex in-person review covered the amber renewal proposal.';
    const firstResponse = await fetch(`${harness.url}/api/console/context/facts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'project', content }),
    });
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json() as {
      fact: { id: number };
      consolidation: { action: string; supersededFactId: number | null };
    };
    assert.equal(first.consolidation.action, 'add');
    assert.equal(first.consolidation.supersededFactId, null);

    const repeatResponse = await fetch(`${harness.url}/api/console/context/facts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'project', content: `  ${content}  ` }),
    });
    assert.equal(repeatResponse.status, 200);
    const repeat = await repeatResponse.json() as {
      fact: { id: number };
      consolidation: { action: string; supersededFactId: number | null };
    };
    assert.equal(repeat.consolidation.action, 'reinforce');
    assert.equal(repeat.fact.id, first.fact.id);
    assert.equal((openMemoryDb().prepare('SELECT COUNT(*) AS count FROM consolidated_facts WHERE active = 1').get() as { count: number }).count, 1);
    assert.equal((openMemoryDb().prepare('SELECT COUNT(*) AS count FROM fact_evidence WHERE fact_id = ?').get(first.fact.id) as { count: number }).count, 1);
  } finally {
    await harness.close();
  }
});

test('entity list searches the full canonical pool and separates grounded from inferred links', async () => {
  resetMemoryDb();
  const db = openMemoryDb();
  const now = '2026-07-15T12:00:00.000Z';

  const hiddenTailId = upsertEntity({
    type: 'person',
    name: 'Tail Memory Person',
    aliases: ['Hidden Beacon'],
  });
  const insertNoise = db.prepare(`
    INSERT INTO entities
      (entity_type, canonical_name, canonical_name_lc, aliases_json, first_seen_at, last_seen_at, mention_count)
    VALUES ('person', ?, ?, '[]', ?, ?, 100)
  `);
  db.transaction(() => {
    for (let index = 0; index < 350; index += 1) {
      const name = `Frequent Person ${String(index).padStart(3, '0')}`;
      insertNoise.run(name, name.toLowerCase(), now, now);
    }
  })();

  const episode = recordMemoryEpisode({
    kind: 'tool_result',
    sessionId: 'entity-route-session',
    callId: 'entity-route-call',
    occurredAt: now,
    content: 'Dana Smith leads the renewal review.',
  });
  const danaId = upsertEntity({
    type: 'person',
    name: 'Dana Smith',
    evidenceEpisodeId: episode.id,
  });
  const grounded = rememberFact({
    kind: 'project',
    content: 'Dana Smith leads the renewal review.',
    derivedFrom: { sessionId: 'entity-route-session', callId: 'entity-route-call', tool: 'directory_lookup' },
  });
  linkFactEvidence({ factId: grounded.id, episodeId: episode.id, excerpt: 'Dana Smith leads the renewal review.' });
  addFactEntityLinks(grounded.id, [danaId], {
    linkType: 'extracted',
    evidenceEpisodeId: episode.id,
    evidenceExcerpt: 'Dana Smith leads the renewal review.',
  });
  const inferred = rememberFact({
    kind: 'project',
    content: 'Dana Smith appears near an unverified renewal note.',
    derivedFrom: { sessionId: 'entity-route-other-session', callId: 'entity-route-other-call', tool: 'search' },
  });
  setFactEntityLinks(inferred.id, [danaId], { linkType: 'inferred_text' });
  const jamieId = upsertEntity({ type: 'person', name: 'Jamie Rivera' });
  const dottedJamieId = upsertEntity({ type: 'person', name: 'jamie.rivera' });

  const authorized = { value: false };
  const harness = await boot(authorized);
  try {
    assert.equal((await fetch(`${harness.url}/api/console/brain/entities`)).status, 401);
    assert.equal((await fetch(`${harness.url}/api/console/brain/entity-identity/candidates?type=person`)).status, 401);
    authorized.value = true;

    const tailResponse = await fetch(`${harness.url}/api/console/brain/entities?limit=10&type=person&q=hidden%20beacon`);
    assert.equal(tailResponse.status, 200);
    const tail = await tailResponse.json() as {
      entities: Array<{ id: number; canonicalName: string }>;
      total: number;
      allTotal: number;
    };
    assert.equal(tail.total, 1);
    assert.ok(tail.allTotal > 350);
    assert.equal(tail.entities[0]?.id, hiddenTailId, 'an alias outside the unfiltered page remains searchable');

    const danaResponse = await fetch(`${harness.url}/api/console/brain/entities?limit=10&type=person&q=dana`);
    assert.equal(danaResponse.status, 200);
    const dana = await danaResponse.json() as {
      entities: Array<{
        id: number; factCount: number; groundedFactCount: number;
        inferredFactCount: number; observationCount: number;
      }>;
      total: number;
    };
    assert.equal(dana.total, 1);
    assert.equal(dana.entities[0]?.id, danaId);
    assert.equal(dana.entities[0]?.factCount, 2);
    assert.equal(dana.entities[0]?.groundedFactCount, 1);
    assert.equal(dana.entities[0]?.inferredFactCount, 1);
    assert.equal(dana.entities[0]?.observationCount, 1);

    const candidatesResponse = await fetch(`${harness.url}/api/console/brain/entity-identity/candidates?type=person&limit=20`);
    assert.equal(candidatesResponse.status, 200);
    const candidates = await candidatesResponse.json() as {
      candidates: Array<{ entities: Array<{ id: number }>; suggestedCanonicalId: number }>;
      total: number;
      dismissedCount: number;
    };
    const jamieCandidate = candidates.candidates.find((candidate) =>
      candidate.entities.some((entity) => entity.id === jamieId)
      && candidate.entities.some((entity) => entity.id === dottedJamieId));
    assert.ok(jamieCandidate, 'punctuation-equivalent people reach the review API');

    const dismissResponse = await fetch(`${harness.url}/api/console/brain/entity-identity/candidates/dismiss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entityIds: [jamieId, dottedJamieId], reason: 'route test distinct people' }),
    });
    assert.equal(dismissResponse.status, 200);
    const afterDismiss = await (await fetch(`${harness.url}/api/console/brain/entity-identity/candidates?type=person&limit=20`)).json() as {
      candidates: Array<{ entities: Array<{ id: number }> }>;
      dismissedCount: number;
    };
    assert.ok(!afterDismiss.candidates.some((candidate) => candidate.entities.some((entity) => entity.id === jamieId)));
    assert.equal(afterDismiss.dismissedCount, 1);

    const restoreResponse = await fetch(`${harness.url}/api/console/brain/entity-identity/candidates/restore-dismissed`, { method: 'POST' });
    assert.equal(restoreResponse.status, 200);
    assert.equal((await restoreResponse.json() as { restored: number }).restored, 1);
  } finally {
    await harness.close();
  }
});
