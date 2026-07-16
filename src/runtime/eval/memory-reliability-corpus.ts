import { closeMemoryDb, openMemoryDb, type ConsolidatedFactKind, type EntityType, type MemoryEpisodeKind } from '../../memory/db.js';
import { extractAutoMemoryCandidates } from '../../memory/auto-capture.js';
import { getFact, rememberFact, supersedeFact } from '../../memory/facts.js';
import { _setEmbeddingProviderForTest, vectorToBuffer } from '../../memory/embeddings.js';
import { looksLikeHighConfidenceTransientRequest } from '../../memory/memory-quality.js';
import { readReflectionCandidateHealth, recordReflectionCandidate } from '../../memory/reflection-candidates.js';
import { recallMemory, type MemoryRecallContext, type MemoryRecallResult } from '../../memory/recall-memory.js';
import {
  loadFactEntityEdges,
  loadFactResourceEdges,
  recordGroundedEntityRelationship,
  setFactEntityLinks,
  setFactResourceLinks,
  syncFactResourceLinks,
} from '../../memory/relations.js';
import { applyMemoryFix, detectMemoryHealCandidates, revertMemoryHeal } from '../../memory/self-heal.js';
import {
  _testOnly_resetAllSessionImportance,
  _testOnly_setReflectionExtractor,
  readReflectionReplayHealth,
  reflectOnToolReturn,
  consolidateFact,
  upsertEntity,
} from '../../memory/reflection.js';
import { upsertResourcePointer } from '../../memory/source-map.js';
import { getFactEvidence, linkFactEvidence, recordMemoryEpisode } from '../../memory/temporal-memory.js';
import { drainDurableConsolidationCandidates, enqueueAutoCaptureCandidates } from '../../memory/durable-consolidation.js';
import { buildMemoryNeighborhood } from '../../dashboard/memory-graph.js';
import {
  syncMeetingMemoryProposals,
  type RecallMeetingAnalysis,
  type RecallMeetingRecord,
} from '../../integrations/recall/meeting-capture.js';
import { promoteReflectionCandidateById, reconcileKnownPendingCandidates } from '../../memory/candidate-review.js';
import type { EvalCase, EvalRunOutcome } from './eval-case.js';

export type MemoryEvalDimension =
  | 'direct_recall'
  | 'multi_session_reasoning'
  | 'temporal_reasoning'
  | 'knowledge_update'
  | 'abstention'
  | 'source_attribution'
  | 'constraint_compliance'
  | 'graph_traversal'
  | 'recorded_meeting_recall'
  | 'meeting_claim_lifecycle'
  | 'candidate_reconciliation'
  | 'fact_deduplication'
  | 'reflection_replay'
  | 'capture_replay'
  | 'intake_quality'
  | 'identity_resolution'
  | 'resource_grounding'
  | 'merge_integrity'
  | 'observation_idempotency'
  | 'relationship_idempotency';

interface SeedFact {
  key: string;
  kind: ConsolidatedFactKind;
  content: string;
  occurredAt?: string;
  sourceUri?: string;
  supersedes?: string;
}

interface SeedEntity {
  key: string;
  type: EntityType;
  name: string;
}

interface SeedEpisode {
  kind: MemoryEpisodeKind;
  subtype?: string;
  title?: string;
  sourceApp?: string;
  sessionId?: string;
  callId?: string;
  sourceUri?: string;
  occurredAt: string;
  content: string;
}

interface SeedVaultChunk {
  path: string;
  chunkIndex: number;
  content: string;
  title?: string;
  mtime?: string;
}

export interface MemoryReliabilityScenario {
  id: string;
  dimension: MemoryEvalDimension;
  facts?: SeedFact[];
  entities?: SeedEntity[];
  episodes?: SeedEpisode[];
  vaultChunks?: SeedVaultChunk[];
  factEntityLinks?: Array<{ factKey: string; entityKey: string }>;
  /** Places a named fact beyond the former recency prefilter using irrelevant
   * rows inserted after it. This makes the tail-recall gate real, not nominal. */
  tailFixture?: { factKey: string; newerFacts: number; minimumRecencyRank: number };
  query: string;
  context?: MemoryRecallContext;
  expect: {
    answerability?: MemoryRecallResult['answerability'];
    requiredTexts?: string[];
    requiredTopText?: string;
    forbiddenTexts?: string[];
    requiredTypes?: Array<MemoryRecallResult['hits'][number]['ref']['type']>;
    requiredTopType?: MemoryRecallResult['hits'][number]['ref']['type'];
    requiredWhy?: string[];
    requireEvidence?: boolean;
    requiredSourceUri?: string;
  };
}

/** Deterministic release corpus aligned to LongMemEval's core dimensions plus
 * Clementine-specific attribution, policy, and graph requirements. Fixtures
 * are deliberately small so the suite can run at pass^k in CI. */
export const MEMORY_RELIABILITY_CORPUS: MemoryReliabilityScenario[] = [
  {
    id: 'memory-direct-tail-token',
    dimension: 'direct_recall',
    facts: [{ key: 'token', kind: 'reference', content: 'The Zephyr recovery token is TAIL-7782.' }],
    tailFixture: { factKey: 'token', newerFacts: 520, minimumRecencyRank: 501 },
    query: 'What is the Zephyr recovery token?',
    context: { stores: ['fact'], graphDepth: 0 },
    expect: {
      answerability: 'supported', requiredTexts: ['TAIL-7782'], requiredTopText: 'TAIL-7782',
      requiredTypes: ['fact'], requiredTopType: 'fact', requireEvidence: true,
    },
  },
  {
    id: 'memory-multi-session-entity-join',
    dimension: 'multi_session_reasoning',
    entities: [{ key: 'acme', type: 'company', name: 'Acme' }],
    facts: [
      { key: 'owner', kind: 'project', content: 'Dana owns the renewal negotiation.' },
      { key: 'date', kind: 'project', content: 'The renewal closes on September 30.' },
    ],
    factEntityLinks: [{ factKey: 'owner', entityKey: 'acme' }, { factKey: 'date', entityKey: 'acme' }],
    query: 'What do we know about Acme?',
    context: { stores: ['fact', 'entity'], graphDepth: 1, limit: 10 },
    expect: { requiredTexts: ['Dana owns', 'September 30'], requiredTypes: ['fact', 'entity'] },
  },
  {
    id: 'memory-temporal-before-correction',
    dimension: 'temporal_reasoning',
    facts: [
      { key: 'old', kind: 'project', content: 'The quarterly revenue target is one million dollars.', occurredAt: '2025-01-01T00:00:00.000Z' },
      { key: 'new', kind: 'project', content: 'The quarterly revenue target is two million dollars.', occurredAt: '2025-02-01T00:00:00.000Z', supersedes: 'old' },
    ],
    query: 'What was the quarterly revenue target?',
    context: { stores: ['fact'], graphDepth: 0, asOf: '2025-01-15T00:00:00.000Z' },
    expect: { requiredTexts: ['one million'], forbiddenTexts: ['two million'] },
  },
  {
    id: 'memory-current-after-correction',
    dimension: 'knowledge_update',
    facts: [
      { key: 'old', kind: 'project', content: 'The quarterly revenue target is one million dollars.', occurredAt: '2025-01-01T00:00:00.000Z' },
      { key: 'new', kind: 'project', content: 'The quarterly revenue target is two million dollars.', occurredAt: '2025-02-01T00:00:00.000Z', supersedes: 'old' },
    ],
    query: 'What is the quarterly revenue target?',
    context: { stores: ['fact'], graphDepth: 0 },
    expect: { requiredTexts: ['two million'], forbiddenTexts: ['one million'] },
  },
  {
    id: 'memory-general-episode-yesterday',
    dimension: 'temporal_reasoning',
    episodes: [
      {
        kind: 'user_turn', title: 'Dana project note', sourceApp: 'Conversation',
        occurredAt: '2026-07-15T01:00:00.000Z',
        content: 'Dana said the Cobalt rollout needs a legal review.',
      },
      {
        kind: 'user_turn', title: 'Dana follow-up', sourceApp: 'Conversation',
        occurredAt: '2026-07-15T16:00:00.000Z',
        content: 'Dana said the Cobalt rollout is ready to publish.',
      },
    ],
    query: 'What did Dana tell me yesterday?',
    context: {
      stores: ['episode'], graphDepth: 0, limit: 10,
      now: '2026-07-15T17:00:00.000Z', timeZone: 'America/Los_Angeles',
    },
    expect: {
      requiredTexts: ['needs a legal review'],
      forbiddenTexts: ['ready to publish'],
      requiredTypes: ['episode'],
      requiredWhy: ['temporal window match: yesterday'],
      requireEvidence: true,
    },
  },
  {
    id: 'memory-unsupported-question-abstains',
    dimension: 'abstention',
    query: 'What is the launch code for the nonexistent Juniper project?',
    expect: { answerability: 'insufficient' },
  },
  {
    id: 'memory-source-attribution-survives',
    dimension: 'source_attribution',
    facts: [{ key: 'source', kind: 'reference', content: 'The Atlas contract renewal date is October 14.', sourceUri: 'crm://contracts/atlas' }],
    query: 'When is the Atlas contract renewal?',
    context: { stores: ['fact'], graphDepth: 0 },
    expect: { requiredTexts: ['October 14'], requireEvidence: true, requiredSourceUri: 'crm://contracts/atlas' },
  },
  {
    id: 'memory-hard-constraint-policy',
    dimension: 'constraint_compliance',
    facts: [{ key: 'rule', kind: 'constraint', content: 'Always send Atlas Outlook email from legal@example.com.' }],
    query: 'Which Outlook mailbox sends Atlas email?',
    context: { stores: ['fact', 'policy'], graphDepth: 0 },
    expect: { requiredTypes: ['policy'], requiredWhy: ['hard_constraint', 'dispatch-enforced'] },
  },
  {
    id: 'memory-stored-graph-hop',
    dimension: 'graph_traversal',
    entities: [{ key: 'orchid', type: 'project', name: 'Orchid' }],
    facts: [{ key: 'milestone', kind: 'project', content: 'The design review happens on Thursday.' }],
    factEntityLinks: [{ factKey: 'milestone', entityKey: 'orchid' }],
    query: 'What is happening with Orchid?',
    context: { stores: ['fact', 'entity'], graphDepth: 1 },
    expect: { requiredTexts: ['design review'], requiredWhy: ['stored graph traversal'] },
  },
  {
    id: 'memory-in-person-meeting-today',
    dimension: 'recorded_meeting_recall',
    episodes: [
      ...Array.from({ length: 6 }, (_, index) => ({
        kind: 'manual' as const,
        title: `Same-day project reflection ${index}`,
        occurredAt: `2026-07-15T1${index}:00:00.000Z`,
        content: `Project reflection ${index}: reviewed outbound operations and legal prospect research.`,
      })),
      {
      kind: 'tool_result',
      subtype: 'meeting',
      title: 'Onboarding rollout room recording',
      sourceApp: 'Clementine Meetings (In-person)',
      sessionId: 'meeting:local',
      callId: 'local-room-2026-07-15',
      sourceUri: 'meeting://local/local-room-2026-07-15',
      occurredAt: '2026-07-15T17:00:00.000Z',
      content: 'Meeting: Onboarding rollout room recording\nCapture: In-person recording\nTranscript: We agreed to ship the onboarding patch on Friday and have Dana verify the migration.',
      },
      {
        kind: 'tool_result',
        subtype: 'meeting',
        title: 'Later empty recorder test',
        sourceApp: 'Clementine Meetings (In-person)',
        sessionId: 'meeting:local',
        callId: 'local-room-empty-2026-07-15',
        sourceUri: 'meeting://local/local-room-empty-2026-07-15',
        occurredAt: '2026-07-15T20:00:00.000Z',
        content: 'Meeting: Later empty recorder test\nCapture: In-person recording\nSummary: Transcript too short to analyze.',
      },
    ],
    vaultChunks: [
      {
        path: '/vault/04-Meetings/2026-07-15-in-person_meeting-local-room-2026-07-15.md',
        chunkIndex: 0,
        content: `---
type: meeting-transcript
source: local whisper (base.en)
provider: local
meeting_id: local-room-2026-07-15
title: Onboarding rollout room recording
started_at: 2026-07-15T17:00:00.000Z
---`,
      },
      {
        path: '/vault/04-Meetings/2026-07-15-in-person_meeting-local-room-2026-07-15.md',
        chunkIndex: 1,
        title: 'Summary',
        content: '## Summary\nWe agreed to ship the onboarding patch on Friday and have Dana verify the migration.',
      },
    ],
    query: 'What was the recorded in-person meeting I had today about?',
    context: {
      stores: ['episode', 'note'], graphDepth: 0,
      now: '2026-07-15T23:00:00.000Z', timeZone: 'America/Los_Angeles',
    },
    expect: {
      answerability: 'supported',
      requiredTexts: ['ship the onboarding patch'],
      requiredTopText: 'ship the onboarding patch',
      requiredTypes: ['episode'],
      requiredTopType: 'episode',
      requiredWhy: ['exact temporal match', 'first-class recorded meeting episode', 'in-person capture match', 'cross-store meeting representations collapsed'],
      requireEvidence: true,
      requiredSourceUri: 'meeting://local/local-room-2026-07-15',
    },
  },
  {
    id: 'memory-meeting-today-without-recording-abstains',
    dimension: 'abstention',
    episodes: [{
      kind: 'manual',
      title: 'Same-day outbound review',
      occurredAt: '2026-07-15T18:00:00.000Z',
      content: 'Reviewed outbound operations and legal prospect research today.',
    }],
    query: 'What was the meeting I had today about?',
    context: {
      now: '2026-07-15T23:00:00.000Z', timeZone: 'America/Los_Angeles',
    },
    expect: { answerability: 'insufficient' },
  },
  {
    id: 'memory-untranscribed-meeting-existence-supported',
    dimension: 'recorded_meeting_recall',
    episodes: [{
      kind: 'tool_result', subtype: 'meeting', title: 'Untranscribed client room recording',
      sourceApp: 'Clementine Meetings (In-person)', sourceUri: 'meeting://local/untranscribed-client-room',
      occurredAt: '2026-07-15T19:00:00.000Z',
      content: 'Meeting: Untranscribed client room recording\nCapture: In-person recording\nSummary: Transcript too short to analyze.',
    }],
    query: 'Did I have a meeting today?',
    context: {
      stores: ['episode'], graphDepth: 0,
      now: '2026-07-15T23:00:00.000Z', timeZone: 'America/Los_Angeles',
    },
    expect: {
      answerability: 'supported', requiredTopText: 'Untranscribed client room recording',
      requiredTopType: 'episode', requireEvidence: true,
    },
  },
];

export const MEMORY_INTEGRITY_DIMENSIONS = [
  'fact_deduplication',
  'meeting_claim_lifecycle',
  'candidate_reconciliation',
  'reflection_replay',
  'capture_replay',
  'intake_quality',
  'identity_resolution',
  'resource_grounding',
  'merge_integrity',
  'observation_idempotency',
  'relationship_idempotency',
] as const satisfies readonly MemoryEvalDimension[];

function evaluateScenario(scenario: MemoryReliabilityScenario, result: MemoryRecallResult): EvalRunOutcome {
  const allText = result.hits.map((hit) => hit.text.toLowerCase());
  const types = new Set(result.hits.map((hit) => hit.ref.type));
  const why = new Set(result.hits.flatMap((hit) => hit.whyRecalled));
  const failures: string[] = [];
  if (scenario.expect.answerability && result.answerability !== scenario.expect.answerability) {
    failures.push(`answerability=${result.answerability}, expected ${scenario.expect.answerability}`);
  }
  for (const text of scenario.expect.requiredTexts ?? []) if (!allText.some((value) => value.includes(text.toLowerCase()))) failures.push(`missing text: ${text}`);
  if (scenario.expect.requiredTopText && !allText[0]?.includes(scenario.expect.requiredTopText.toLowerCase())) failures.push(`top hit missing text: ${scenario.expect.requiredTopText}`);
  for (const text of scenario.expect.forbiddenTexts ?? []) if (allText.some((value) => value.includes(text.toLowerCase()))) failures.push(`forbidden text: ${text}`);
  for (const type of scenario.expect.requiredTypes ?? []) if (!types.has(type)) failures.push(`missing type: ${type}`);
  if (scenario.expect.requiredTopType && result.hits[0]?.ref.type !== scenario.expect.requiredTopType) failures.push(`top hit type=${result.hits[0]?.ref.type ?? 'none'}, expected ${scenario.expect.requiredTopType}`);
  for (const reason of scenario.expect.requiredWhy ?? []) if (!why.has(reason)) failures.push(`missing reason: ${reason}`);
  if (scenario.expect.requireEvidence && !result.hits.some((hit) => hit.evidence.length > 0)) failures.push('missing durable evidence');
  if (scenario.expect.requiredSourceUri && !result.hits.some((hit) => hit.evidence.some((item) => item.sourceUri === scenario.expect.requiredSourceUri))) failures.push(`missing source: ${scenario.expect.requiredSourceUri}`);
  return failures.length > 0
    ? { pass: false, detail: failures.join('; ') }
    : { pass: true, detail: `${result.hits.length} hits; ${result.answerability}; ${result.diagnostics.elapsedMs}ms` };
}

/** Build pass^k-compatible cases. The reset callback must point at an isolated
 * test database; it runs before every trial so cases cannot contaminate each
 * other. */
export function buildMemoryReliabilityEvalCases(reset: () => void): EvalCase[] {
  return MEMORY_RELIABILITY_CORPUS.map((scenario): EvalCase => ({
    id: scenario.id,
    label: `memory:${scenario.dimension}`,
    run: async () => {
      reset();
      const facts = new Map<string, number>();
      const entities = new Map<string, number>();
      for (const entity of scenario.entities ?? []) entities.set(entity.key, upsertEntity({ type: entity.type, name: entity.name }));
      for (const seed of scenario.facts ?? []) {
        const previous = seed.supersedes ? facts.get(seed.supersedes) : undefined;
        const fact = previous
          ? supersedeFact(previous, { content: seed.content, occurredAt: seed.occurredAt, sourceUri: seed.sourceUri })
          : rememberFact({ kind: seed.kind, content: seed.content, occurredAt: seed.occurredAt, sourceUri: seed.sourceUri });
        if (!fact) return { pass: false, detail: `could not seed fact ${seed.key}` };
        facts.set(seed.key, fact.id);
      }
      if (scenario.tailFixture) {
        const fixture = scenario.tailFixture;
        const targetId = facts.get(fixture.factKey);
        if (!targetId) return { pass: false, detail: `invalid tail fact ${fixture.factKey}` };
        const db = openMemoryDb();
        const insert = db.prepare(`
          INSERT INTO consolidated_facts
            (kind, content, content_hash, score, active, created_at, updated_at,
             importance, valid_from, confidence)
          VALUES ('reference', ?, ?, 1, 1, ?, ?, 1, ?, 1)
        `);
        const validFrom = '2026-01-01T00:00:00.000Z';
        db.transaction(() => {
          for (let index = 0; index < fixture.newerFacts; index += 1) {
            const updatedAt = new Date(Date.UTC(2099, 0, 1, 0, 0, 0, index)).toISOString();
            insert.run(
              `Irrelevant recent benchmark filler ${scenario.id} ${index}.`,
              `memory-eval:${scenario.id}:filler:${index}`,
              validFrom,
              updatedAt,
              validFrom,
            );
          }
        })();
        const ranked = db.prepare(`
          WITH ranked AS (
            SELECT id, ROW_NUMBER() OVER (ORDER BY updated_at DESC, id DESC) AS recency_rank
            FROM consolidated_facts WHERE active = 1
          )
          SELECT recency_rank FROM ranked WHERE id = ?
        `).get(targetId) as { recency_rank: number } | undefined;
        if (!ranked || ranked.recency_rank < fixture.minimumRecencyRank) {
          return { pass: false, detail: `tail fixture rank=${ranked?.recency_rank ?? 'missing'}, expected >=${fixture.minimumRecencyRank}` };
        }
      }
      for (const episode of scenario.episodes ?? []) recordMemoryEpisode({
        ...episode,
        status: 'available',
      });
      if (scenario.vaultChunks?.length) {
        const insertChunk = openMemoryDb().prepare(`
          INSERT INTO vault_chunks (path, chunk_index, content, title, mtime, byte_size, content_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const chunk of scenario.vaultChunks) {
          const mtime = Date.parse(chunk.mtime ?? '2026-07-15T23:00:00.000Z');
          insertChunk.run(
            chunk.path,
            chunk.chunkIndex,
            chunk.content,
            chunk.title ?? null,
            mtime,
            Buffer.byteLength(chunk.content),
            `memory-eval:${scenario.id}:vault:${chunk.chunkIndex}`,
          );
        }
      }
      for (const link of scenario.factEntityLinks ?? []) {
        const factId = facts.get(link.factKey);
        const entityId = entities.get(link.entityKey);
        if (!factId || !entityId) return { pass: false, detail: `invalid graph fixture ${link.factKey}->${link.entityKey}` };
        setFactEntityLinks(factId, [entityId]);
      }
      return evaluateScenario(scenario, await recallMemory(scenario.query, scenario.context));
    },
  }));
}

/** Release cases for the write side of memory. These certify that replay and
 * restatement add evidence or aliases without multiplying claims, people, or
 * graph recurrence, while one-off requests remain ephemeral. */
export function buildMemoryIntegrityEvalCases(reset: () => void): EvalCase[] {
  return [
    {
      id: 'memory-resource-grounding-precision',
      label: 'memory:resource_grounding',
      run: async () => {
        reset();
        const unique = upsertResourcePointer({
          app: 'Google Drive', kind: 'folder', providerId: 'q3-planning', name: 'Q3 Planning',
        });
        const ambiguousA = upsertResourcePointer({
          app: 'Google Drive', kind: 'folder', providerId: 'client-files-drive', name: 'Client Files',
        });
        const ambiguousB = upsertResourcePointer({
          app: 'Notion', kind: 'database', providerId: 'client-files-notion', name: 'Client Files',
        });
        const content = 'The Q3 Planning folder contains the launch plan; two systems also have a Client Files resource.';
        const fact = rememberFact({ kind: 'reference', content });
        const replay = rememberFact({ kind: 'reference', content });
        syncFactResourceLinks();
        const edges = loadFactResourceEdges([fact.id]);
        const uniqueEdges = edges.filter((edge) => edge.resourceId === unique.id && edge.truth === 'stored');
        const ambiguousStored = edges.filter((edge) =>
          (edge.resourceId === ambiguousA.id || edge.resourceId === ambiguousB.id) && edge.truth === 'stored');
        const recall = await recallMemory('What is stored in Q3 Planning?', { graphDepth: 1, limit: 20 });
        const why = new Set(recall.hits.flatMap((hit) => hit.whyRecalled));
        const pass = replay.id === fact.id
          && uniqueEdges.length === 1
          && Boolean(uniqueEdges[0].evidenceEpisodeId)
          && ambiguousStored.length === 0
          && why.has('stored fact-to-resource relationship');
        return {
          pass,
          detail: `canonicalFact=${replay.id === fact.id}; uniqueStored=${uniqueEdges.length}; ambiguousStored=${ambiguousStored.length}; traversed=${why.has('stored fact-to-resource relationship')}`,
        };
      },
    },
    {
      id: 'memory-reviewed-merge-preserves-provenance',
      label: 'memory:merge_integrity',
      run: async () => {
        reset();
        _setEmbeddingProviderForTest({
          name: 'merge-eval', model: 'merge-eval', dim: 4,
          async embed(texts) { return texts.map(() => new Float32Array(4)); },
        });
        try {
          const keep = rememberFact({
            kind: 'project', content: 'Revill Law Firm SEO report lives at revill-lawfirm.com/report.',
            score: 1, importance: 6,
          });
          const drop = rememberFact({
            kind: 'project', content: 'The Revill Law Firm SEO report is at revill-lawfirm.com/report.',
            score: 1, importance: 6,
          });
          const entity = upsertEntity({ type: 'company', name: 'Revill Law Firm' });
          const resource = upsertResourcePointer({
            app: 'Google Drive', kind: 'file', providerId: 'revill-report', name: 'Revill SEO Report',
          });
          const [dropEvidence] = getFactEvidence(drop.id);
          if (!dropEvidence) return { pass: false, detail: 'duplicate source episode missing before merge' };
          setFactEntityLinks(keep.id, [entity], { linkType: 'inferred_text', confidence: 0.55 });
          setFactEntityLinks(drop.id, [entity], {
            linkType: 'stored', confidence: 0.96,
            evidenceEpisodeId: dropEvidence.episodeId, evidenceExcerpt: dropEvidence.excerpt,
          });
          setFactResourceLinks(drop.id, [resource.id], {
            linkType: 'stored', confidence: 0.95,
            evidenceEpisodeId: dropEvidence.episodeId, evidenceExcerpt: dropEvidence.excerpt,
          });
          const db = openMemoryDb();
          db.prepare('UPDATE consolidated_facts SET access_count = 0, utility_count = 5, impression_count = 0 WHERE id = ?').run(keep.id);
          db.prepare('UPDATE consolidated_facts SET access_count = 1000, utility_count = 0, impression_count = 1000 WHERE id = ?').run(drop.id);
          const contentHash = (id: number): string => (db.prepare(
            'SELECT content_hash FROM consolidated_facts WHERE id = ?',
          ).get(id) as { content_hash: string }).content_hash;
          const insertEmbedding = db.prepare(`
            INSERT OR REPLACE INTO fact_embeddings
              (fact_id, model, dim, vector, content_hash, created_at)
            VALUES (?, 'merge-eval', 4, ?, ?, ?)
          `);
          insertEmbedding.run(keep.id, vectorToBuffer(Float32Array.from([1, 0, 0, 0])), contentHash(keep.id), new Date().toISOString());
          insertEmbedding.run(drop.id, vectorToBuffer(Float32Array.from([0.999, 0.001, 0, 0])), contentHash(drop.id), new Date().toISOString());
          const fix = detectMemoryHealCandidates({ persistProposals: false })
            .find((candidate) => candidate.kind === 'merge_duplicate');
          if (!fix) return { pass: false, detail: 'reviewable duplicate merge was not detected' };
          const canonicalSelectionPass = (fix.payload as { keepId?: number }).keepId === keep.id;
          const applied = await applyMemoryFix(fix, {
            humanApproved: true, nowIso: '2026-07-15T22:00:00.000Z',
          });
          const canonical = getFact(keep.id);
          const historical = getFact(drop.id);
          const canonicalEvidence = getFactEvidence(keep.id);
          const entityEdge = loadFactEntityEdges([keep.id]).find((edge) => edge.entityId === entity);
          const resourceEdge = loadFactResourceEdges([keep.id]).find((edge) => edge.resourceId === resource.id);
          const mergePass = canonicalSelectionPass && applied.ok
            && canonical?.utilityCount === 5 && canonical.impressionCount === 1000
            && historical?.active === false && historical.supersededByFactId === keep.id
            && canonicalEvidence.length === 2
            && entityEdge?.truth === 'stored' && resourceEdge?.truth === 'stored';
          const reverted = applied.auditId
            ? revertMemoryHeal(applied.auditId, '2026-07-15T22:05:00.000Z')
            : { ok: false };
          const revertPass = reverted.ok
            && getFact(drop.id)?.active === true
            && getFactEvidence(keep.id).length === 1
            && loadFactEntityEdges([keep.id]).find((edge) => edge.entityId === entity)?.truth === 'inferred'
            && !loadFactResourceEdges([keep.id]).some((edge) => edge.resourceId === resource.id);
          return {
            pass: mergePass && revertPass,
            detail: `canonicalByUtility=${canonicalSelectionPass}; applied=${applied.ok}; evidence=${canonicalEvidence.length}; entity=${entityEdge?.truth ?? 'missing'}; resource=${resourceEdge?.truth ?? 'missing'}; utility=${canonical?.utilityCount ?? 0}; impressions=${canonical?.impressionCount ?? 0}; reverted=${revertPass}`,
          };
        } finally {
          _setEmbeddingProviderForTest(null);
        }
      },
    },
    {
      id: 'memory-fact-outward-graph-pack',
      label: 'memory:graph_traversal',
      run: async () => {
        reset();
        const fact = rememberFact({ kind: 'project', content: 'Waypoint-771 launch decision is approved.' });
        const person = upsertEntity({ type: 'person', name: 'Dana Whitlock' });
        const resource = upsertResourcePointer({ app: 'Drive', kind: 'folder', name: 'Executive decision archive' });
        const episode = recordMemoryEpisode({
          kind: 'import', title: 'Waypoint approval', sourceApp: 'In-person recorder',
          sourceUri: 'meeting://local/waypoint-771', occurredAt: '2026-07-10T18:00:00.000Z',
          content: 'Dana Whitlock approved Waypoint-771 and filed the decision in the executive archive.',
        });
        const excerpt = episode.evidence_excerpt ?? '';
        linkFactEvidence({ factId: fact.id, episodeId: episode.id, excerpt, sourceUri: episode.source_uri });
        setFactEntityLinks(fact.id, [person], {
          linkType: 'extracted', confidence: 0.95, evidenceEpisodeId: episode.id, evidenceExcerpt: excerpt,
        });
        setFactResourceLinks(fact.id, [resource.id], {
          linkType: 'extracted', confidence: 0.9, evidenceEpisodeId: episode.id, evidenceExcerpt: excerpt,
        });
        const recall = await recallMemory('What is the Waypoint-771 decision?', { graphDepth: 1, limit: 20 });
        const types = new Set(recall.hits.map((hit) => hit.ref.type));
        const why = new Set(recall.hits.flatMap((hit) => hit.whyRecalled));
        const pass = types.has('fact') && types.has('entity') && types.has('resource') && types.has('episode')
          && why.has('stored fact-to-entity relationship')
          && why.has('stored fact-to-resource relationship')
          && why.has('stored fact-to-evidence relationship');
        return {
          pass,
          detail: `types=${Array.from(types).join(',')}; outwardEntity=${why.has('stored fact-to-entity relationship')}; outwardResource=${why.has('stored fact-to-resource relationship')}; sourceEpisode=${why.has('stored fact-to-evidence relationship')}`,
        };
      },
    },
    {
      id: 'memory-user-corrects-pinned-policy',
      label: 'memory:constraint_compliance',
      run: async () => {
        reset();
        const original = rememberFact({
          kind: 'constraint',
          content: 'Always send Atlas updates from the legacy@example.com Outlook mailbox.',
          occurredAt: '2026-01-01T00:00:00.000Z',
        });
        const outcome = await consolidateFact({
          kind: 'constraint',
          text: 'Always send Atlas updates from the operations@example.com Outlook mailbox.',
          trustLevel: 1,
          authority: 'user',
          occurredAt: '2026-07-15T00:00:00.000Z',
          pin: true,
        }, {}, {
          resolver: async () => ({
            decision: 'UPDATE', target_id: original.id,
            rewrite: 'Always send Atlas updates from the operations@example.com Outlook mailbox.',
          }),
        });
        const oldFact = getFact(original.id);
        const newFact = outcome.factId ? getFact(outcome.factId) : null;
        const policy = outcome.factId ? openMemoryDb().prepare(
          'SELECT policy_type, enforcement FROM memory_policies WHERE fact_id = ?',
        ).get(outcome.factId) as { policy_type: string; enforcement: string } | undefined : undefined;
        const recall = await recallMemory('Which mailbox sends Atlas updates?', {
          stores: ['fact', 'policy'], graphDepth: 0, limit: 10,
        });
        const text = recall.hits.map((hit) => hit.text).join('\n');
        const pass = outcome.action === 'supersede' && oldFact?.active === false
          && newFact?.active === true && newFact.pinned === true
          && policy?.policy_type === 'hard_constraint' && policy.enforcement === 'dispatch'
          && text.includes('operations@example.com') && !text.includes('legacy@example.com');
        return {
          pass,
          detail: `action=${outcome.action}; historical=${oldFact?.active === false}; replacementPinned=${newFact?.pinned === true}; enforcement=${policy?.enforcement ?? 'missing'}; currentOnly=${text.includes('operations@example.com') && !text.includes('legacy@example.com')}`,
        };
      },
    },
    {
      id: 'memory-exact-fact-reinforcement',
      label: 'memory:fact_deduplication',
      run: async () => {
        reset();
        const first = rememberFact({ kind: 'user', content: 'The user prefers concise weekly status summaries.' });
        const replay = rememberFact({ kind: 'user', content: '  The user prefers concise weekly status summaries.  ' });
        const db = openMemoryDb();
        const facts = (db.prepare('SELECT COUNT(*) AS count FROM consolidated_facts').get() as { count: number }).count;
        const evidence = (db.prepare('SELECT COUNT(*) AS count FROM fact_evidence WHERE fact_id = ?').get(first.id) as { count: number }).count;
        const pass = replay.id === first.id && facts === 1 && evidence === 1 && replay.score > first.score;
        return {
          pass,
          detail: `sameId=${replay.id === first.id}; facts=${facts}; evidence=${evidence}; score=${first.score.toFixed(1)}→${replay.score.toFixed(1)}`,
        };
      },
    },
    {
      id: 'memory-semantic-dedup-retains-new-evidence',
      label: 'memory:fact_deduplication',
      run: async () => {
        reset();
        const firstEpisode = recordMemoryEpisode({
          kind: 'tool_result', sessionId: 'memory-eval-semantic-dedup', callId: 'crm',
          sourceUri: 'crm://contacts/dana', content: 'Dana Smith is the Acme billing contact.',
        });
        const canonical = rememberFact({
          kind: 'project', content: 'Dana Smith is Acme’s billing contact.',
          derivedFrom: { sessionId: 'memory-eval-semantic-dedup', callId: 'crm', tool: 'crm_lookup' },
        });
        const secondEpisode = recordMemoryEpisode({
          kind: 'tool_result', sessionId: 'memory-eval-semantic-dedup', callId: 'meeting',
          sourceUri: 'recording://local/acme-review',
          content: 'The in-person review confirmed Dana Smith as billing contact for Acme.',
        });
        const outcome = await consolidateFact({
          kind: 'project', text: 'The billing contact at Acme is Dana Smith.',
          trustLevel: 0.8, authority: 'derived',
        }, {
          sessionId: 'memory-eval-semantic-dedup',
          derivedFrom: { sessionId: 'memory-eval-semantic-dedup', callId: 'meeting', tool: 'meeting_transcript' },
        }, {
          resolver: async () => ({ decision: 'NOOP', target_id: canonical.id }),
        });
        const evidence = getFactEvidence(canonical.id);
        const ids = new Set(evidence.map((item) => item.episodeId));
        const facts = (openMemoryDb().prepare('SELECT COUNT(*) AS count FROM consolidated_facts WHERE active = 1').get() as { count: number }).count;
        const pass = outcome.action === 'ignore' && outcome.factId === canonical.id && facts === 1
          && ids.has(firstEpisode.id) && ids.has(secondEpisode.id)
          && evidence.some((item) => item.sourceUri === 'recording://local/acme-review');
        return {
          pass,
          detail: `action=${outcome.action}; facts=${facts}; evidence=${evidence.length}; meetingSource=${ids.has(secondEpisode.id)}`,
        };
      },
    },
    {
      id: 'memory-known-claim-auto-attaches-evidence',
      label: 'memory:candidate_reconciliation',
      run: async () => {
        reset();
        const text = 'The Orchid migration is approved for Friday.';
        const canonical = rememberFact({
          kind: 'project', content: text, importance: 5, trustLevel: 1,
          // Keep the fixture's claim inside its fixed evaluation clock. Using
          // ingestion time here made this deterministic corpus begin failing
          // once wall-clock time passed 23:00Z on the fixture date.
          occurredAt: '2026-07-15T18:00:00.000Z',
        });
        const source = recordMemoryEpisode({
          kind: 'tool_result', subtype: 'meeting',
          sourceApp: 'Clementine Meetings (In-person)',
          sessionId: 'meeting:local', callId: 'orchid-known-evidence',
          sourceUri: 'meeting://local/orchid-known-evidence',
          occurredAt: '2026-07-15T19:00:00.000Z',
          content: `Decision: ${text}`,
        });
        const candidateId = recordReflectionCandidate({
          episodeId: source.id,
          sessionId: 'meeting:local', callId: 'orchid-known-evidence',
          kind: 'project', text, importance: 8,
          sourceType: 'meeting_analysis',
          intakeReason: 'structured meeting decision',
          trustLevel: 0.82, authority: 'derived', sourceUri: source.source_uri,
        });
        const reconciled = reconcileKnownPendingCandidates({
          limit: 20, now: '2026-07-15T20:00:00.000Z',
        });
        const db = openMemoryDb();
        const fact = db.prepare(`
          SELECT score, importance, trust_level FROM consolidated_facts WHERE id = ?
        `).get(canonical.id) as { score: number; importance: number; trust_level: number };
        const candidate = db.prepare(`
          SELECT status, reason, resulting_fact_id
          FROM memory_reflection_candidates WHERE id = ?
        `).get(candidateId) as { status: string; reason: string | null; resulting_fact_id: number | null };
        const evidence = getFactEvidence(canonical.id);
        const recall = await recallMemory('When is the Orchid migration approved?', {
          stores: ['fact', 'episode'], graphDepth: 1, limit: 10,
          now: '2026-07-15T23:00:00.000Z', timeZone: 'America/Los_Angeles',
        });
        const recalled = recall.hits.find((hit) => hit.ref.type === 'fact' && hit.ref.id === String(canonical.id));
        const pass = reconciled.resolved === 1
          && candidate.status === 'promoted'
          && candidate.reason === 'automatic_exact_reinforce'
          && candidate.resulting_fact_id === canonical.id
          && fact.score === 1 && fact.importance === 5 && fact.trust_level === 1
          && evidence.some((item) => item.episodeId === source.id && item.sourceUri === source.source_uri)
          && recall.answerability === 'supported' && Boolean(recalled);
        return {
          pass,
          detail: `resolved=${reconciled.resolved}; status=${candidate.status}; unchanged=${fact.score === 1 && fact.importance === 5 && fact.trust_level === 1}; evidence=${evidence.length}; recalled=${Boolean(recalled)}`,
        };
      },
    },
    {
      id: 'memory-meeting-claim-review-to-recall',
      label: 'memory:meeting_claim_lifecycle',
      run: async () => {
        reset();
        const analysis: RecallMeetingAnalysis = {
          title: 'Clio Integration Data Review',
          summary: 'The team reviewed incomplete client data and next steps.',
          decisions: [],
          actionItems: [{
            text: 'Produce a report identifying integrated clients missing revenue, zip code, or case type fields.',
            owner: 'Dana Smith',
            dueDate: '2026-07-17',
          }],
          topics: ['Clio integration', 'client data quality'],
          participants: ['Dana Smith', 'Nathan Reynolds'],
          generatedAt: '2026-07-15T22:00:00.000Z',
          source: 'agent',
        };
        const meeting = (id: string, startedAt: string): RecallMeetingRecord => ({
          id,
          windowId: `window-${id}`,
          provider: 'local',
          source: 'local-audio',
          title: 'Clio Integration Data Review',
          status: 'completed',
          startedAt,
          endedAt: new Date(Date.parse(startedAt) + 30 * 60_000).toISOString(),
          segments: [{
            id: `segment-${id}`,
            windowId: `window-${id}`,
            event: 'transcript.final',
            speaker: 'Dana Smith',
            text: 'Produce the missing-fields report for the integrated client list.',
            timestamp: startedAt,
            isFinal: true,
          }],
        });
        const episodeFor = (record: RecallMeetingRecord) => recordMemoryEpisode({
          kind: 'tool_result',
          subtype: 'meeting',
          title: analysis.title,
          sourceApp: 'Clementine Meetings (In-person)',
          sessionId: 'meeting:local',
          callId: record.id,
          sourceUri: `meeting://local/${record.id}`,
          occurredAt: record.startedAt,
          status: 'available',
          content: [
            `Meeting: ${analysis.title}`,
            `Summary: ${analysis.summary}`,
            `Action items: ${analysis.actionItems?.[0]?.text} [Dana Smith] [due 2026-07-17]`,
            'Transcript: Dana Smith: Produce the missing-fields report for the integrated client list.',
          ].join('\n'),
        });

        const firstMeeting = meeting('clio-review-a', '2026-07-15T20:00:00.000Z');
        const secondMeeting = meeting('clio-review-b', '2026-07-15T21:00:00.000Z');
        const firstEpisode = episodeFor(firstMeeting);
        const secondEpisode = episodeFor(secondMeeting);
        const firstSync = syncMeetingMemoryProposals(firstEpisode, firstMeeting, analysis);
        const secondSync = syncMeetingMemoryProposals(secondEpisode, secondMeeting, analysis);
        const replayA = syncMeetingMemoryProposals(firstEpisode, firstMeeting, analysis);
        const replayB = syncMeetingMemoryProposals(secondEpisode, secondMeeting, analysis);

        const db = openMemoryDb();
        const candidateRows = db.prepare(`
          SELECT id, episode_id, status
          FROM memory_reflection_candidates
          WHERE source_type = 'meeting_analysis'
          ORDER BY episode_id, id
        `).all() as Array<{ id: number; episode_id: string; status: string }>;
        if (candidateRows.length !== 2) {
          return { pass: false, detail: `meetingCandidates=${candidateRows.length}, expected 2` };
        }

        const first = await promoteReflectionCandidateById(candidateRows[0].id, {
          now: '2026-07-15T22:05:00.000Z',
        });
        const duplicateClick = await promoteReflectionCandidateById(candidateRows[1].id, {
          now: '2026-07-15T22:06:00.000Z',
        });
        if (!first?.factId) {
          return {
            pass: false,
            detail: `first=${first?.action ?? 'missing'}; coalesced=${first?.coalescedCandidateIds.length ?? 0}`,
          };
        }

        const factId = first.factId;
        const activeFacts = (db.prepare(
          'SELECT COUNT(*) AS count FROM consolidated_facts WHERE active = 1',
        ).get() as { count: number }).count;
        const evidence = getFactEvidence(factId);
        const evidenceEpisodes = new Set(evidence.map((item) => item.episodeId));
        const resolvedCandidates = db.prepare(`
          SELECT status, resulting_fact_id FROM memory_reflection_candidates
          WHERE source_type = 'meeting_analysis' ORDER BY id
        `).all() as Array<{ status: string; resulting_fact_id: number | null }>;
        const recall = await recallMemory('Who owns the Clio integrated-client missing-fields report?', {
          stores: ['fact', 'episode'], graphDepth: 1, limit: 10,
          now: '2026-07-15T23:00:00.000Z', timeZone: 'America/Los_Angeles',
        });
        const recalledFact = recall.hits.find((hit) => hit.ref.type === 'fact' && hit.ref.id === String(factId));
        const recalledSources = new Set(recalledFact?.evidence.map((item) => item.sourceUri) ?? []);
        const graph = buildMemoryNeighborhood(db, `fact:${factId}`, 1);
        const graphEvidenceEpisodes = new Set(graph.edges
          .filter((edge) => edge.source === `fact:${factId}` && edge.type === 'evidence' && edge.truth === 'stored')
          .map((edge) => edge.target));

        const pass = firstSync.proposed === 1 && secondSync.proposed === 1
          && replayA.proposed === 1 && replayB.proposed === 1
          && first.action === 'add'
          && first.coalescedCandidateIds.length === 1
          && first.coalescedCandidateIds[0] === candidateRows[1].id
          && first.evidenceSourcesAdded === 2
          && duplicateClick === null
          && activeFacts === 1
          && resolvedCandidates.length === 2
          && resolvedCandidates.every((candidate) => candidate.status === 'promoted' && candidate.resulting_fact_id === factId)
          && evidence.length === 2
          && evidenceEpisodes.has(firstEpisode.id) && evidenceEpisodes.has(secondEpisode.id)
          && recall.answerability === 'supported' && Boolean(recalledFact)
          && recalledSources.has('meeting://local/clio-review-a')
          && recalledSources.has('meeting://local/clio-review-b')
          && graphEvidenceEpisodes.has(`episode:${firstEpisode.id}`)
          && graphEvidenceEpisodes.has(`episode:${secondEpisode.id}`)
          && graph.edges.every((edge) => edge.truth === 'stored');
        return {
          pass,
          detail: `proposals=${candidateRows.length}; action=${first.action}; coalesced=${first.coalescedCandidateIds.length}; facts=${activeFacts}; evidence=${evidence.length}; recalled=${Boolean(recalledFact)}; recallSources=${recalledSources.size}; graphSources=${graphEvidenceEpisodes.size}; doubleClick=${duplicateClick === null}; hits=${recall.hits.map((hit) => `${hit.ref.type}:${hit.ref.id}`).join(',') || 'none'}`,
        };
      },
    },
    {
      id: 'memory-tool-reflection-exactly-once',
      label: 'memory:reflection_replay',
      run: async () => {
        reset();
        _testOnly_resetAllSessionImportance();
        const priorThreshold = process.env.CLEMMY_REFLECTION_THRESHOLD;
        const priorEmbed = process.env.CLEMMY_EMBED_AT_WRITE;
        process.env.CLEMMY_REFLECTION_THRESHOLD = '0';
        process.env.CLEMMY_EMBED_AT_WRITE = 'off';
        let extractorCalls = 0;
        const input = {
          sessionId: 'memory-eval-replay-session',
          callId: 'memory-eval-replay-call',
          tool: 'directory_lookup',
          output: `Dana works at Acme. ${'durable directory evidence '.repeat(50)}`,
        };
        try {
          _testOnly_setReflectionExtractor(async () => {
            extractorCalls += 1;
            return {
              facts: [{ kind: 'reference', text: 'Dana works at Acme', importance: 5 }],
              entities: [{ type: 'person', name: 'Dana' }, { type: 'company', name: 'Acme' }],
              pointers: [{ label: 'Dana directory record' }],
            };
          });
          const first = await reflectOnToolReturn(input);
          closeMemoryDb();
          openMemoryDb();
          const replay = await reflectOnToolReturn(input);
          const db = openMemoryDb();
          const facts = (db.prepare('SELECT COUNT(*) AS count FROM consolidated_facts').get() as { count: number }).count;
          const entities = (db.prepare('SELECT COUNT(*) AS count FROM entities').get() as { count: number }).count;
          const mentions = (db.prepare('SELECT SUM(mention_count) AS count FROM entities').get() as { count: number }).count;
          const pointers = (db.prepare('SELECT COUNT(*) AS count FROM episodic_pointers').get() as { count: number }).count;
          const health = readReflectionReplayHealth();
          const pass = first.factsWritten === 1 && replay.skipped === 'already_reflected'
            && extractorCalls === 1 && facts === 1 && entities === 2 && mentions === 2 && pointers === 1
            && health.completed === 1 && health.retried === 0;
          return {
            pass,
            detail: `extractor=${extractorCalls}; replay=${replay.skipped ?? 'processed'}; facts=${facts}; entities=${entities}; mentions=${mentions}; pointers=${pointers}`,
          };
        } finally {
          _testOnly_setReflectionExtractor(null);
          if (priorThreshold === undefined) delete process.env.CLEMMY_REFLECTION_THRESHOLD;
          else process.env.CLEMMY_REFLECTION_THRESHOLD = priorThreshold;
          if (priorEmbed === undefined) delete process.env.CLEMMY_EMBED_AT_WRITE;
          else process.env.CLEMMY_EMBED_AT_WRITE = priorEmbed;
        }
      },
    },
    {
      id: 'memory-auto-capture-survives-restart',
      label: 'memory:capture_replay',
      run: async () => {
        reset();
        const input = {
          message: 'My preferred contract reviewer is Sarah Chen.',
          sessionId: 'memory-eval-auto-capture',
          sourceEventId: 'turn:9',
          occurredAt: '2026-07-15T20:00:00.000Z',
          candidates: [{
            kind: 'user' as const,
            content: 'My preferred contract reviewer is Sarah Chen.',
            reason: 'durable first-person declarative',
          }],
        };
        const queued = enqueueAutoCaptureCandidates(input);
        // The original process exits after durable intake but before its
        // microtask starts. A fresh database handle represents daemon restart.
        closeMemoryDb();
        openMemoryDb();
        const replay = await drainDurableConsolidationCandidates({ ids: queued.candidateIds });
        const redelivery = enqueueAutoCaptureCandidates(input);
        const duplicateReplay = await drainDurableConsolidationCandidates({ ids: redelivery.candidateIds });
        const db = openMemoryDb();
        const candidate = db.prepare(`
          SELECT status, resulting_fact_id, attempt_count
          FROM memory_reflection_candidates WHERE id = ?
        `).get(queued.candidateIds[0]) as {
          status: string; resulting_fact_id: number; attempt_count: number;
        };
        const facts = (db.prepare('SELECT COUNT(*) AS count FROM consolidated_facts').get() as { count: number }).count;
        const candidates = (db.prepare('SELECT COUNT(*) AS count FROM memory_reflection_candidates').get() as { count: number }).count;
        const evidence = getFactEvidence(candidate.resulting_fact_id);
        const pass = replay.promoted === 1 && duplicateReplay.selected === 0
          && redelivery.candidateIds[0] === queued.candidateIds[0]
          && candidate.status === 'promoted' && candidate.attempt_count === 1
          && facts === 1 && candidates === 1
          && evidence.length === 1 && evidence[0]?.episodeId === queued.episodeId;
        return {
          pass,
          detail: `promoted=${replay.promoted}; duplicateSelected=${duplicateReplay.selected}; facts=${facts}; candidates=${candidates}; attempts=${candidate.attempt_count}; exactEpisode=${evidence[0]?.episodeId === queued.episodeId}`,
        };
      },
    },
    {
      id: 'memory-one-off-request-stays-ephemeral',
      label: 'memory:intake_quality',
      run: async () => {
        reset();
        const request = 'Please send the Atlas proposal to Dana today.';
        const standing = 'Standing instruction: Always summarize recorded meetings with decisions and owners.';
        const requestRejected = looksLikeHighConfidenceTransientRequest(request);
        const requestCandidates = extractAutoMemoryCandidates(request);
        const standingRejected = looksLikeHighConfidenceTransientRequest(standing);
        if (!standingRejected) rememberFact({ kind: 'feedback', content: standing });
        const factCount = (openMemoryDb().prepare('SELECT COUNT(*) AS count FROM consolidated_facts').get() as { count: number }).count;
        const pass = requestRejected && requestCandidates.length === 0 && !standingRejected && factCount === 1;
        return {
          pass,
          detail: `requestRejected=${requestRejected}; requestCandidates=${requestCandidates.length}; standingRejected=${standingRejected}; facts=${factCount}`,
        };
      },
    },
    {
      id: 'memory-user-statement-canonical-person-graph',
      label: 'memory:identity_resolution',
      run: async () => {
        reset();
        const input = {
          message: 'My CFO is Dana Wilson (dana.wilson@acme.example).',
          sessionId: 'memory-eval-user-person',
          sourceEventId: 'turn:12',
          occurredAt: '2026-07-15T20:30:00.000Z',
          candidates: [{
            kind: 'user' as const,
            content: 'My CFO is Dana Wilson (dana.wilson@acme.example).',
            reason: 'durable first-person declarative',
          }],
        };
        const queued = enqueueAutoCaptureCandidates(input);
        const first = await drainDurableConsolidationCandidates({ ids: queued.candidateIds });
        const redelivery = enqueueAutoCaptureCandidates(input);
        const replay = await drainDurableConsolidationCandidates({ ids: redelivery.candidateIds });
        const db = openMemoryDb();
        const candidate = db.prepare(`
          SELECT status, resulting_fact_id FROM memory_reflection_candidates WHERE id = ?
        `).get(queued.candidateIds[0]) as { status: string; resulting_fact_id: number };
        const person = db.prepare(`
          SELECT id, canonical_name FROM entities WHERE entity_type = 'person'
        `).get() as { id: number; canonical_name: string } | undefined;
        const people = (db.prepare("SELECT COUNT(*) AS count FROM entities WHERE entity_type = 'person'").get() as { count: number }).count;
        const observations = person
          ? (db.prepare('SELECT COUNT(*) AS count FROM entity_observations WHERE entity_id = ? AND episode_id = ?').get(person.id, queued.episodeId) as { count: number }).count
          : 0;
        const factLinks = person
          ? (db.prepare("SELECT COUNT(*) AS count FROM fact_entities WHERE fact_id = ? AND entity_id = ? AND link_type = 'extracted'").get(candidate.resulting_fact_id, person.id) as { count: number }).count
          : 0;
        const emailIdentifiers = person
          ? (db.prepare("SELECT COUNT(*) AS count FROM entity_identifiers WHERE entity_id = ? AND scheme = 'email' AND value_norm = ?").get(person.id, 'dana.wilson@acme.example') as { count: number }).count
          : 0;
        const graph = person ? buildMemoryNeighborhood(db, `entity:${person.id}`, 1) : null;
        const storedFactEdge = Boolean(graph?.edges.some((edge) => (
          edge.source === `fact:${candidate.resulting_fact_id}`
          && edge.target === `entity:${person!.id}`
          && edge.type === 'entity'
          && edge.truth === 'stored'
        )));
        const storedEpisodeEdge = Boolean(graph?.edges.some((edge) => (
          edge.source === `entity:${person!.id}`
          && edge.target === `episode:${queued.episodeId}`
          && edge.type === 'observed'
          && edge.truth === 'stored'
        )));
        const graphStoredOnly = Boolean(graph && graph.edges.every((edge) => edge.truth === 'stored'));
        const pass = first.promoted === 1 && replay.selected === 0
          && redelivery.candidateIds[0] === queued.candidateIds[0]
          && candidate.status === 'promoted'
          && people === 1 && person?.canonical_name === 'Dana Wilson'
          && observations === 1 && factLinks === 1 && emailIdentifiers === 1
          && storedFactEdge && storedEpisodeEdge && graphStoredOnly;
        return {
          pass,
          detail: `promoted=${first.promoted}; replaySelected=${replay.selected}; people=${people}; observations=${observations}; factLinks=${factLinks}; exactEmail=${emailIdentifiers}; storedFactEdge=${storedFactEdge}; storedEpisodeEdge=${storedEpisodeEdge}; graphStoredOnly=${graphStoredOnly}`,
        };
      },
    },
    {
      id: 'memory-derived-noise-is-rejected-and-audited',
      label: 'memory:intake_quality',
      run: async () => {
        reset();
        _testOnly_resetAllSessionImportance();
        const priorThreshold = process.env.CLEMMY_REFLECTION_THRESHOLD;
        const priorEmbed = process.env.CLEMMY_EMBED_AT_WRITE;
        process.env.CLEMMY_REFLECTION_THRESHOLD = '0';
        process.env.CLEMMY_EMBED_AT_WRITE = 'off';
        try {
          _testOnly_setReflectionExtractor(async () => ({
            facts: [
              { kind: 'reference', text: 'Clementine searched the CRM for Dana.', importance: 4 },
              { kind: 'reference', text: 'Dana Smith is the billing contact for Acme.', importance: 6 },
            ],
            entities: [],
            pointers: [],
          }));
          const result = await reflectOnToolReturn({
            sessionId: 'memory-eval-quality-session',
            callId: 'memory-eval-quality-call',
            tool: 'crm_lookup',
            output: `CRM record: Dana Smith is the billing contact for Acme. ${'durable directory evidence '.repeat(50)}`,
          });
          const facts = openMemoryDb().prepare('SELECT content FROM consolidated_facts').all() as Array<{ content: string }>;
          const health = readReflectionCandidateHealth();
          const pass = result.factsWritten === 1
            && facts.length === 1 && facts[0].content.includes('billing contact')
            && health.promoted === 1 && health.rejected === 1
            && health.rejectionReasons.assistant_action_history === 1;
          return {
            pass,
            detail: `facts=${facts.length}; promoted=${health.promoted}; rejected=${health.rejected}; actionNoise=${health.rejectionReasons.assistant_action_history ?? 0}`,
          };
        } finally {
          _testOnly_setReflectionExtractor(null);
          if (priorThreshold === undefined) delete process.env.CLEMMY_REFLECTION_THRESHOLD;
          else process.env.CLEMMY_REFLECTION_THRESHOLD = priorThreshold;
          if (priorEmbed === undefined) delete process.env.CLEMMY_EMBED_AT_WRITE;
          else process.env.CLEMMY_EMBED_AT_WRITE = priorEmbed;
        }
      },
    },
    {
      id: 'memory-stable-email-converges-person',
      label: 'memory:identity_resolution',
      run: async () => {
        reset();
        const first = upsertEntity({ type: 'person', name: 'Nathan Reynolds', aliases: ['nathan@example.com'] });
        const replay = upsertEntity({ type: 'person', name: 'Nate Reynolds', aliases: ['nathan@example.com'] });
        const db = openMemoryDb();
        const row = db.prepare('SELECT aliases_json FROM entities WHERE id = ?').get(first) as { aliases_json: string };
        const count = (db.prepare("SELECT COUNT(*) AS count FROM entities WHERE entity_type = 'person'").get() as { count: number }).count;
        const aliases = JSON.parse(row.aliases_json) as string[];
        const pass = first === replay && count === 1 && aliases.includes('Nate Reynolds');
        return { pass, detail: `sameId=${first === replay}; people=${count}; alternateNameRetained=${aliases.includes('Nate Reynolds')}` };
      },
    },
    {
      id: 'memory-ambiguous-people-stay-distinct',
      label: 'memory:identity_resolution',
      run: async () => {
        reset();
        const jordanOne = upsertEntity({ type: 'person', name: 'Jordan Lee', aliases: ['jordan.one@example.com'] });
        const jordanTwo = upsertEntity({ type: 'person', name: 'Jordan Lee', aliases: ['jordan.two@example.com'] });
        const amy = upsertEntity({ type: 'person', name: 'Amy Adams', aliases: ['sales@example.com'] });
        const alex = upsertEntity({ type: 'person', name: 'Alex Alvarez', aliases: ['sales@example.com'] });
        const count = (openMemoryDb().prepare("SELECT COUNT(*) AS count FROM entities WHERE entity_type = 'person'").get() as { count: number }).count;
        const pass = jordanOne !== jordanTwo && amy !== alex && count === 4;
        return { pass, detail: `conflictingEmailDistinct=${jordanOne !== jordanTwo}; sharedInboxDistinct=${amy !== alex}; people=${count}` };
      },
    },
    {
      id: 'memory-entity-observation-replay-safe',
      label: 'memory:observation_idempotency',
      run: async () => {
        reset();
        const episode = recordMemoryEpisode({
          kind: 'tool_result', sessionId: 'memory-eval-observation', callId: 'meeting-1',
          occurredAt: '2026-07-15T17:00:00.000Z', content: 'Dana Smith joined the project review.',
        });
        const first = upsertEntity({ type: 'person', name: 'Dana Smith', evidenceEpisodeId: episode.id });
        const replay = upsertEntity({ type: 'person', name: 'Dana Smith', aliases: ['Dana'], evidenceEpisodeId: episode.id });
        const row = openMemoryDb().prepare(`
          SELECT mention_count,
            (SELECT COUNT(*) FROM entity_observations eo WHERE eo.entity_id = entities.id) AS observations
          FROM entities WHERE id = ?
        `).get(first) as { mention_count: number; observations: number };
        const pass = replay === first && row.mention_count === 1 && row.observations === 1;
        return { pass, detail: `sameId=${replay === first}; mentions=${row.mention_count}; observations=${row.observations}` };
      },
    },
    {
      id: 'memory-relationship-evidence-replay-safe',
      label: 'memory:relationship_idempotency',
      run: async () => {
        reset();
        const sourceText = 'Dana works at Acme.';
        const episode = recordMemoryEpisode({
          kind: 'tool_result', sessionId: 'memory-eval-edge', callId: 'directory-1',
          occurredAt: '2026-07-15T17:00:00.000Z', sourceUri: 'directory://acme/dana', content: sourceText,
        });
        const dana = upsertEntity({ type: 'person', name: 'Dana', evidenceEpisodeId: episode.id });
        const acme = upsertEntity({ type: 'company', name: 'Acme', evidenceEpisodeId: episode.id });
        const input = {
          subjectId: dana, predicate: 'works at', objectId: acme,
          evidenceEpisodeId: episode.id, evidenceExcerpt: sourceText,
          sourceText, sourceUri: 'directory://acme/dana', confidence: 0.95,
        };
        const first = recordGroundedEntityRelationship(input);
        const replay = recordGroundedEntityRelationship(input);
        const db = openMemoryDb();
        const edge = db.prepare('SELECT recurrence_count FROM entity_edges').get() as { recurrence_count: number } | undefined;
        const evidence = (db.prepare('SELECT COUNT(*) AS count FROM entity_edge_evidence').get() as { count: number }).count;
        const pass = first.outcome === 'add' && replay.reason === 'duplicate_evidence'
          && edge?.recurrence_count === 1 && evidence === 1;
        return { pass, detail: `first=${first.outcome}; replay=${replay.reason}; recurrence=${edge?.recurrence_count ?? 0}; evidence=${evidence}` };
      },
    },
  ];
}

export function buildAllMemoryReliabilityEvalCases(reset: () => void): EvalCase[] {
  return [
    ...buildMemoryReliabilityEvalCases(reset),
    ...buildMemoryIntegrityEvalCases(reset),
  ];
}
