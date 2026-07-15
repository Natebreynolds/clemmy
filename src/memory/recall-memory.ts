import { openMemoryDb, type MemoryEpisodeStatus } from './db.js';
import {
  findSimilarFactsScored,
  getFact,
  lexicalRelevance,
  searchFactsByText,
  searchFactsByTextAt,
  type ConsolidatedFact,
} from './facts.js';
import { recallHybrid, resolveTemporalMeetingDate } from './recall.js';
import {
  getFactIdsForEntity,
  getFactIdsForResource,
  getNeighborEntityIds,
  resolveEntityIdsForText,
} from './relations.js';
import { listResourcePointers } from './source-map.js';
import { matchToolChoicesForStep } from './tool-choice-store.js';
import { getFactEvidence, listMemoryPolicies } from './temporal-memory.js';

export type MemoryRef =
  | { type: 'fact'; id: string }
  | { type: 'entity'; id: number }
  | { type: 'resource'; id: number }
  | { type: 'episode'; id: string }
  | { type: 'note' | 'procedure' | 'policy'; id: string };

export interface MemoryEvidenceHit {
  ref: MemoryRef;
  text: string;
  title?: string;
  score: number;
  confidence: number;
  validFrom?: string;
  validTo?: string;
  evidence: Array<{ episodeId: string; excerpt: string; sourceUri?: string }>;
  whyRecalled: string[];
}

export interface MemoryRecallResult {
  hits: MemoryEvidenceHit[];
  answerability: 'supported' | 'partial' | 'insufficient';
  diagnostics: { candidates: number; stores: string[]; elapsedMs: number };
}

export interface MemoryRecallContext {
  limit?: number;
  perStore?: number;
  graphDepth?: 0 | 1 | 2;
  asOf?: string;
  stores?: Array<'fact' | 'note' | 'entity' | 'resource' | 'episode' | 'policy' | 'procedure'>;
  resourceMinOverlap?: number;
  /** Deterministic clock override for relative temporal queries. */
  now?: string;
  /** User timezone for "today"/"yesterday" resolution. */
  timeZone?: string;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'what', 'when', 'where', 'how', 'your']);
const IN_PERSON_RE = /\b(?:in\s*-?\s*person|inperson)(?=$|[^a-z0-9])/i;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9._@-]{2,}/g) ?? []).filter((token) => !STOP.has(token)));
}

function overlapScore(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const hay = tokens(text);
  let matched = 0;
  for (const token of queryTokens) if (hay.has(token)) matched += 1;
  return matched / queryTokens.size;
}

function factHit(fact: ConsolidatedFact, score: number, why: string[]): MemoryEvidenceHit {
  return {
    ref: { type: 'fact', id: String(fact.id) },
    title: `${fact.kind} fact`,
    text: fact.content,
    score: clamp(score, 0, 1),
    confidence: clamp(fact.confidence ?? fact.trustLevel ?? 0.7, 0, 1),
    validFrom: fact.validFrom ?? fact.createdAt,
    validTo: fact.validTo ?? undefined,
    evidence: getFactEvidence(fact.id)
      .filter((item) => (item.status === 'available' || item.status === 'partial') && item.excerpt.trim().length > 0)
      .map((item) => ({
        episodeId: item.episodeId,
        excerpt: item.excerpt,
        sourceUri: item.sourceUri,
      })),
    whyRecalled: why,
  };
}

function mergeHit(target: Map<string, MemoryEvidenceHit>, hit: MemoryEvidenceHit): void {
  const key = `${hit.ref.type}:${hit.ref.id}`;
  const existing = target.get(key);
  if (!existing) { target.set(key, hit); return; }
  existing.score = Math.max(existing.score, hit.score);
  existing.confidence = Math.max(existing.confidence, hit.confidence);
  existing.whyRecalled = Array.from(new Set([...existing.whyRecalled, ...hit.whyRecalled]));
  const evidence = new Map(existing.evidence.map((item) => [`${item.episodeId}:${item.excerpt}`, item]));
  for (const item of hit.evidence) evidence.set(`${item.episodeId}:${item.excerpt}`, item);
  existing.evidence = Array.from(evidence.values());
}

function isValidAt(fact: ConsolidatedFact, asOfMs: number): boolean {
  const from = Date.parse(fact.validFrom ?? fact.createdAt);
  const to = fact.validTo ? Date.parse(fact.validTo) : Number.POSITIVE_INFINITY;
  return (!Number.isFinite(from) || from <= asOfMs) && (!Number.isFinite(to) || asOfMs < to);
}

function diversify(hits: MemoryEvidenceHit[], limit: number): MemoryEvidenceHit[] {
  const selected: MemoryEvidenceHit[] = [];
  for (const hit of hits.sort((a, b) => b.score - a.score)) {
    const hitTokens = tokens(hit.text);
    const duplicate = selected.some((existing) => {
      // Cross-store corroboration is useful evidence, not duplication. Keep a
      // fact, its episode, and its policy projection independently visible.
      if (existing.ref.type !== hit.ref.type) return false;
      const other = tokens(existing.text);
      if (hitTokens.size === 0 || other.size === 0) return false;
      let intersection = 0;
      for (const token of hitTokens) if (other.has(token)) intersection += 1;
      const union = new Set([...hitTokens, ...other]).size;
      return union > 0 && intersection / union >= 0.85;
    });
    if (!duplicate) selected.push(hit);
    if (selected.length >= limit) break;
  }
  return selected;
}

function resolveAsOf(query: string, explicit?: string, nowMs = Date.now()): { iso?: string; ms: number } {
  const raw = explicit?.trim()
    || query.match(/\b(?:as of|on)\s+(\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-Z]+)?)/i)?.[1]
    || query.match(/\b(?:as of|in)\s+(\d{4})\b/i)?.[1];
  if (!raw) return { ms: nowMs };
  const normalized = /^\d{4}$/.test(raw) ? `${raw}-12-31T23:59:59.999Z`
    : /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59.999Z`
      : raw.replace(' ', 'T');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? { iso: new Date(ms).toISOString(), ms } : { ms: nowMs };
}

/** Evidence-backed hybrid recall over the complete local memory set. Stored
 * graph links expand candidates, but inferred graph edges never affect recall. */
export async function recallMemory(query: string, context: MemoryRecallContext = {}): Promise<MemoryRecallResult> {
  const started = Date.now();
  const objective = query.replace(/\s+/g, ' ').trim();
  const limit = clamp(context.limit ?? 12, 1, 50);
  const perStore = clamp(context.perStore ?? Math.max(8, limit), 1, 30);
  const depth = context.graphDepth ?? 1;
  const wanted = new Set(context.stores ?? ['fact', 'note', 'entity', 'resource', 'episode', 'policy', 'procedure']);
  const usedStores = new Set<string>();
  const merged = new Map<string, MemoryEvidenceHit>();
  if (!objective) return { hits: [], answerability: 'insufficient', diagnostics: { candidates: 0, stores: [], elapsedMs: 0 } };
  const queryTokens = tokens(objective);
  const contextNowMs = context.now ? Date.parse(context.now) : Date.now();
  const nowMs = Number.isFinite(contextNowMs) ? contextNowMs : Date.now();
  const recallTime = resolveAsOf(objective, context.asOf, nowMs);
  const asOfMs = recallTime.ms;
  const historicalAsOf = recallTime.iso;
  const temporalMeetingDate = resolveTemporalMeetingDate(objective, { nowMs, timeZone: context.timeZone });

  const [semanticFacts, notes] = await Promise.all([
    wanted.has('fact') ? findSimilarFactsScored(objective, { topK: perStore }).catch(() => []) : Promise.resolve([]),
    wanted.has('note') ? recallHybrid(objective, { limit: perStore, nowMs, timeZone: context.timeZone }).catch(() => []) : Promise.resolve([]),
  ]);

  const factIds = new Set<number>();
  if (wanted.has('fact')) {
    usedStores.add('fact');
    const lexical = historicalAsOf
      ? searchFactsByTextAt(objective, historicalAsOf, perStore)
      : searchFactsByText(objective, perStore);
    const semanticById = new Map(semanticFacts.map((item, rank) => [item.fact.id, { ...item, rank }]));
    for (const fact of [...semanticFacts.map((item) => item.fact), ...lexical]) {
      if (!isValidAt(fact, asOfMs)) continue;
      factIds.add(fact.id);
      const semantic = semanticById.get(fact.id);
      const semanticScore = semantic?.sim == null ? 0 : clamp((semantic.sim + 1) / 2, 0, 1);
      const lexicalScore = lexicalRelevance(objective, fact.content);
      const confidence = fact.confidence ?? fact.trustLevel ?? 0.7;
      const importance = (fact.importance ?? 5) / 10;
      const score = 0.45 * semanticScore + 0.30 * lexicalScore + 0.15 * confidence + 0.10 * importance;
      const hit = factHit(fact, Math.max(score, semantic ? 0.35 - semantic.rank * 0.005 : 0.25), []);
      hit.whyRecalled = [
        semanticScore > 0 ? `semantic similarity ${semanticScore.toFixed(2)}` : '',
        lexicalScore > 0 ? `lexical relevance ${lexicalScore.toFixed(2)}` : '',
        hit.evidence.length > 0 ? 'source-backed' : '',
      ].filter(Boolean);
      mergeHit(merged, hit);
    }
  }

  if (wanted.has('note')) {
    usedStores.add('note');
    notes.forEach((note, rank) => {
      const normalizedPath = note.filePath.replace(/\\/g, '/');
      const inPersonMatch = IN_PERSON_RE.test(objective)
        && IN_PERSON_RE.test(`${normalizedPath} ${note.title} ${note.snippet}`);
      const exactTemporalMeeting = Boolean(
        temporalMeetingDate
        && normalizedPath.includes('/04-Meetings/')
        && (normalizedPath.includes(temporalMeetingDate) || note.snippet.includes(temporalMeetingDate)),
      );
      mergeHit(merged, {
        ref: { type: 'note', id: note.filePath },
        title: note.title,
        text: note.snippet,
        score: exactTemporalMeeting
          ? clamp(0.98 - rank * 0.01, 0.85, 0.98)
          : clamp(0.68 - rank * 0.025, 0.2, 0.68),
        confidence: exactTemporalMeeting ? 0.95 : 0.8,
        evidence: [{ episodeId: `note:${note.filePath}`, excerpt: note.snippet, sourceUri: note.filePath }],
        whyRecalled: exactTemporalMeeting
          ? ['exact temporal match', inPersonMatch ? 'in-person capture match' : '', 'recorded meeting source', 'vault type meeting-transcript'].filter(Boolean)
          : ['vault lexical/vector retrieval'],
      });
    });
  }

  let entityIds: number[] = [];
  if (wanted.has('entity') || depth > 0) {
    const directEntityIds = resolveEntityIdsForText(objective, perStore);
    const directEntityIdSet = new Set(directEntityIds);
    entityIds = directEntityIds;
    if (directEntityIds.length > 0) usedStores.add('entity');
    if (depth === 2) entityIds = Array.from(new Set([
      ...entityIds,
      ...getNeighborEntityIds(entityIds, perStore, historicalAsOf ?? new Date(asOfMs).toISOString()),
    ]));
    if (entityIds.length > 0) {
      const db = openMemoryDb();
      const ph = entityIds.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT id, entity_type, canonical_name, mention_count FROM entities WHERE id IN (${ph})
      `).all(...entityIds) as Array<{ id: number; entity_type: string; canonical_name: string; mention_count: number }>;
      for (const row of rows) {
        if (wanted.has('entity')) mergeHit(merged, {
          ref: { type: 'entity', id: row.id },
          title: row.canonical_name,
          text: `${row.entity_type} · mentioned ${row.mention_count}×`,
          score: directEntityIdSet.has(row.id) ? 0.72 : 0.48,
          confidence: 0.75,
          evidence: [],
          whyRecalled: [directEntityIdSet.has(row.id) ? 'entity name or alias matched' : 'stored entity relation'],
        });
        if (depth > 0) for (const id of getFactIdsForEntity(row.id, perStore, historicalAsOf)) factIds.add(id);
      }
    }
  }

  const resources = listResourcePointers({ limit: 2_000 })
    .map((resource) => ({ resource, overlap: overlapScore(queryTokens, `${resource.name} ${resource.whatsHere ?? ''} ${resource.whenToUse ?? ''}`) }))
    .filter((item) => item.overlap * Math.max(1, queryTokens.size) >= (context.resourceMinOverlap ?? 1))
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, perStore);
  if (wanted.has('resource') && resources.length > 0) usedStores.add('resource');
  for (const { resource, overlap } of resources) {
    if (wanted.has('resource')) mergeHit(merged, {
      ref: { type: 'resource', id: resource.id },
      title: resource.name,
      text: `${resource.app}${resource.whatsHere ? ` · ${resource.whatsHere}` : ''}`,
      score: 0.38 + 0.42 * overlap,
      confidence: resource.trust ?? 0.7,
      evidence: [],
      whyRecalled: [`resource overlap ${overlap.toFixed(2)}`],
    });
    if (depth > 0) for (const id of getFactIdsForResource(resource.id, perStore, historicalAsOf)) factIds.add(id);
  }

  // Graph-expanded facts are evidence-bearing context, not merely breadcrumbs.
  if (wanted.has('fact')) for (const id of factIds) {
    const fact = getFact(id);
    if (!fact || (!historicalAsOf && !fact.active) || !isValidAt(fact, asOfMs)) continue;
    mergeHit(merged, factHit(fact, 0.58 + 0.2 * lexicalRelevance(objective, fact.content), ['stored graph traversal']));
  }

  if (wanted.has('episode')) {
    const db = openMemoryDb();
    const tokenList = Array.from(queryTokens).slice(0, 8);
    const rows = tokenList.length === 0 ? [] : db.prepare(`
      SELECT id, kind, source_app, source_uri, occurred_at, evidence_excerpt, status
      FROM memory_episodes
      WHERE evidence_excerpt IS NOT NULL
        AND (${tokenList.map(() => 'LOWER(evidence_excerpt) LIKE ?').join(' OR ')})
      ORDER BY occurred_at DESC
      LIMIT ?
    `).all(...tokenList.map((token) => `%${token}%`), perStore) as Array<{
      id: string; kind: string; source_app: string | null; source_uri: string | null;
      occurred_at: string; evidence_excerpt: string; status: MemoryEpisodeStatus;
    }>;
    if (rows.length > 0) usedStores.add('episode');
    for (const row of rows) mergeHit(merged, {
      ref: { type: 'episode', id: row.id },
      title: row.source_app ?? row.kind,
      text: row.evidence_excerpt,
      score: 0.35 + 0.4 * overlapScore(queryTokens, row.evidence_excerpt),
      confidence: row.status === 'available' ? 0.85 : 0.55,
      validFrom: row.occurred_at,
      evidence: [{ episodeId: row.id, excerpt: row.evidence_excerpt, sourceUri: row.source_uri ?? undefined }],
      whyRecalled: ['durable episode evidence'],
    });
  }

  if (wanted.has('policy')) {
    for (const policy of listMemoryPolicies()) {
      const fact = getFact(policy.fact_id);
      if (!fact) continue;
      const relevance = lexicalRelevance(objective, fact.content);
      if (relevance <= 0 && policy.policy_type !== 'hard_constraint') continue;
      if (relevance <= 0) continue;
      usedStores.add('policy');
      mergeHit(merged, {
        ...factHit(fact, 0.55 + 0.35 * relevance, [`${policy.policy_type}`, `${policy.enforcement}-enforced`]),
        ref: { type: 'policy', id: String(policy.fact_id) },
        title: policy.policy_type.replace(/_/g, ' '),
      });
    }
  }

  if (wanted.has('procedure')) {
    const procedures = matchToolChoicesForStep(objective, { limit: perStore });
    if (procedures.length > 0) usedStores.add('procedure');
    procedures.forEach((procedure, rank) => mergeHit(merged, {
      ref: { type: 'procedure', id: procedure.intent },
      title: procedure.intent,
      text: `proven tool → ${procedure.kind}:${procedure.identifier}`,
      score: clamp(0.62 - rank * 0.025, 0.25, 0.62),
      confidence: 0.75,
      evidence: [],
      whyRecalled: ['procedural intent match'],
    }));
  }

  const hits = diversify(Array.from(merged.values()), limit);
  const supported = hits.some((hit) => hit.evidence.length > 0 && hit.score >= 0.45);
  return {
    hits,
    answerability: supported ? 'supported' : hits.length > 0 ? 'partial' : 'insufficient',
    diagnostics: { candidates: merged.size, stores: Array.from(usedStores), elapsedMs: Date.now() - started },
  };
}
