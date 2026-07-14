import type { ConsolidatedFactKind, EntityType } from '../../memory/db.js';
import { rememberFact, supersedeFact } from '../../memory/facts.js';
import { recallMemory, type MemoryRecallContext, type MemoryRecallResult } from '../../memory/recall-memory.js';
import { setFactEntityLinks } from '../../memory/relations.js';
import { upsertEntity } from '../../memory/reflection.js';
import type { EvalCase, EvalRunOutcome } from './eval-case.js';

export type MemoryEvalDimension =
  | 'direct_recall'
  | 'multi_session_reasoning'
  | 'temporal_reasoning'
  | 'knowledge_update'
  | 'abstention'
  | 'source_attribution'
  | 'constraint_compliance'
  | 'graph_traversal';

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

export interface MemoryReliabilityScenario {
  id: string;
  dimension: MemoryEvalDimension;
  facts?: SeedFact[];
  entities?: SeedEntity[];
  factEntityLinks?: Array<{ factKey: string; entityKey: string }>;
  query: string;
  context?: MemoryRecallContext;
  expect: {
    answerability?: MemoryRecallResult['answerability'];
    requiredTexts?: string[];
    forbiddenTexts?: string[];
    requiredTypes?: Array<MemoryRecallResult['hits'][number]['ref']['type']>;
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
    query: 'What is the Zephyr recovery token?',
    context: { stores: ['fact'], graphDepth: 0 },
    expect: { answerability: 'supported', requiredTexts: ['TAIL-7782'], requiredTypes: ['fact'], requireEvidence: true },
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
    facts: [{ key: 'rule', kind: 'constraint', content: 'Never publish an Atlas quote without legal approval.' }],
    query: 'Can I publish the Atlas quote without legal approval?',
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
];

function evaluateScenario(scenario: MemoryReliabilityScenario, result: MemoryRecallResult): EvalRunOutcome {
  const allText = result.hits.map((hit) => hit.text.toLowerCase());
  const types = new Set(result.hits.map((hit) => hit.ref.type));
  const why = new Set(result.hits.flatMap((hit) => hit.whyRecalled));
  const failures: string[] = [];
  if (scenario.expect.answerability && result.answerability !== scenario.expect.answerability) {
    failures.push(`answerability=${result.answerability}, expected ${scenario.expect.answerability}`);
  }
  for (const text of scenario.expect.requiredTexts ?? []) if (!allText.some((value) => value.includes(text.toLowerCase()))) failures.push(`missing text: ${text}`);
  for (const text of scenario.expect.forbiddenTexts ?? []) if (allText.some((value) => value.includes(text.toLowerCase()))) failures.push(`forbidden text: ${text}`);
  for (const type of scenario.expect.requiredTypes ?? []) if (!types.has(type)) failures.push(`missing type: ${type}`);
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
