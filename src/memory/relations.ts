import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { backupMemoryDb, openMemoryDb } from './db.js';
import { compileWordMatcher } from './word-match.js';
import {
  autoReconcileStrongEntityIdentifiers,
  observeEntityFromEpisodeInDatabase,
  resolveCanonicalEntityId,
  resolveCanonicalEntityIdInDatabase,
} from './entity-identity.js';

/**
 * Stored relationship layer (WS2). The graph used to RE-DERIVE every
 * fact↔entity / fact↔resource edge at render time by substring matching, and
 * entity↔entity relationships were never captured at all — so recall could not
 * traverse "what do I know about entity X". These helpers persist the edges
 * (migration v13: fact_entities / fact_resources / entity_edges) so the graph
 * renders persisted relationships and recall can traverse. Each join carries a
 * truth label: grounded stored/extracted links are graph truth, while nightly
 * text matches remain queryable `inferred_text` candidates.
 *
 * Two population sources:
 *   1. {@link syncFactEntityLinks} / {@link syncFactResourceLinks} — a
 *      DETERMINISTIC word-boundary backfill over every active fact (the nightly
 *      maintenance tick + callable). Covers the whole history as explicitly
 *      labeled inferred candidates; persistence alone does not make them true.
 *   2. {@link recordEntityEdge} — entity↔entity relations emitted by the
 *      reflection extractor ("Dana" -is CFO at- "Acme").
 */

export interface EntityEdgeRow {
  subjectId: number;
  predicate: string;
  objectId: number;
  recurrenceCount: number;
  lastSeenAt: string;
  confidence: number;
  evidenceEpisodeId: string | null;
  validFrom: string | null;
  validTo: string | null;
  evidenceCount: number;
  evidence: EntityEdgeEvidenceRow[];
}

export interface EntityEdgeEvidenceRow {
  episodeId: string;
  excerpt: string;
  sourceUri: string | null;
  sourceFactId: number | null;
  confidence: number;
  observedAt: string;
  validFrom: string | null;
  validTo: string | null;
  extractionMethod: 'reflection' | 'fact_backfill' | 'manual' | 'import';
  episodeStatus: string;
}

export type EntityRelationshipOutcome = 'add' | 'reinforce' | 'supersede' | 'ignore';

export interface EntityRelationshipResult {
  outcome: EntityRelationshipOutcome;
  reason: string;
  subjectId?: number;
  predicate?: string;
  objectId?: number;
  evidenceCount?: number;
}

const RELATIONSHIP_PREDICATE_ALIASES = new Map<string, string>([
  ['works at', 'works at'], ['works for', 'works at'], ['employed by', 'works at'], ['employee of', 'works at'],
  ['reports to', 'reports to'], ['reported to', 'reports to'],
  ['reporting to', 'reports to'], ['reports directly to', 'reports to'], ['reporting directly to', 'reports to'],
  ['leads', 'leads'], ['led', 'leads'], ['heads', 'leads'], ['runs', 'leads'],
  ['owns', 'owns'], ['owned', 'owns'],
  ['member of', 'member of'], ['belongs to', 'member of'],
  ['founded', 'founded'], ['co-founded', 'founded'], ['cofounded', 'founded'],
  ['advises', 'advises'], ['advisor to', 'advises'], ['adviser to', 'advises'],
  ['partner at', 'partner at'], ['partner of', 'partner at'],
  ['primary contact for', 'primary contact for'], ['primary contact at', 'primary contact for'],
  ['manages', 'manages'], ['managed', 'manages'],
  ['collaborates with', 'collaborates with'], ['works with', 'collaborates with'],
  ['customer of', 'customer of'], ['client of', 'client of'],
  ['vendor for', 'vendor for'], ['supplier to', 'vendor for'],
  ['investor in', 'investor in'], ['invested in', 'investor in'],
  ['board member of', 'board member of'], ['serves on board of', 'board member of'],
  ['works on', 'works on'], ['contributes to', 'works on'],
  ['created', 'created'], ['built', 'created'],
  ['located in', 'located in'], ['based in', 'located in'],
  ['attended', 'attended'], ['participated in', 'attended'],
  ['spouse of', 'spouse of'], ['married to', 'spouse of'],
  ['parent of', 'parent of'], ['sibling of', 'sibling of'], ['friend of', 'friend of'],
]);

/** Canonical, bounded vocabulary used by learned entity relationships. */
export function normalizeRelationshipPredicate(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, ' ').replace(/[.]+$/g, '');
  return RELATIONSHIP_PREDICATE_ALIASES.get(normalized) ?? null;
}

function normalizedIso(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}

function namesForRelationshipEvidence(entityId: number): string[] {
  const db = openMemoryDb();
  const row = db.prepare('SELECT canonical_name, aliases_json FROM entities WHERE id = ?').get(entityId) as {
    canonical_name: string; aliases_json: string;
  } | undefined;
  if (!row) return [];
  const names = new Set<string>([row.canonical_name]);
  try {
    const parsed = JSON.parse(row.aliases_json) as unknown;
    if (Array.isArray(parsed)) for (const alias of parsed) if (typeof alias === 'string') names.add(alias);
  } catch { /* malformed legacy aliases */ }
  for (const item of db.prepare('SELECT alias FROM entity_aliases WHERE entity_id = ?').all(entityId) as Array<{ alias: string }>) names.add(item.alias);
  return Array.from(names).map((name) => name.trim()).filter((name) => name.length >= 2 && !name.includes('@'));
}

function evidenceExplicitlySupportsEdge(excerpt: string, subjectId: number, predicate: string, objectId: number): boolean {
  const text = excerpt.toLowerCase();
  const mentions = (names: string[]): boolean => names.some((name) => compileWordMatcher(name.toLowerCase(), 2)?.test(text));
  if (!mentions(namesForRelationshipEvidence(subjectId)) || !mentions(namesForRelationshipEvidence(objectId))) return false;
  const predicatePhrases = Array.from(RELATIONSHIP_PREDICATE_ALIASES.entries())
    .filter(([, canonical]) => canonical === predicate)
    .map(([alias]) => alias);
  return predicatePhrases.some((phrase) => compileWordMatcher(phrase, 2)?.test(text));
}

function edgeIsValidSql(alias: string): string {
  return `(
    EXISTS (
      SELECT 1 FROM entity_edge_validity_intervals evi
      WHERE evi.subject_id = ${alias}.subject_id
        AND evi.predicate = ${alias}.predicate
        AND evi.object_id = ${alias}.object_id
        AND evi.valid_from <= ?
        AND (evi.valid_to IS NULL OR evi.valid_to > ?)
    )
    OR (
      NOT EXISTS (
        SELECT 1 FROM entity_edge_validity_intervals any_evi
        WHERE any_evi.subject_id = ${alias}.subject_id
          AND any_evi.predicate = ${alias}.predicate
          AND any_evi.object_id = ${alias}.object_id
      )
      AND (${alias}.invalidated_at IS NULL OR ${alias}.invalidated_at > ?)
      AND (${alias}.valid_from IS NULL OR ${alias}.valid_from <= ?)
      AND (${alias}.valid_to IS NULL OR ${alias}.valid_to > ?)
    )
  )`;
}

export interface LinkSyncStats {
  factsScanned: number;
  entitiesConsidered: number;
  linksWritten: number;
}

export interface EntityRelationshipBackfillStats {
  factsScanned: number;
  evidenceScanned: number;
  candidates: number;
  added: number;
  reinforced: number;
  ignored: number;
}

export interface GroundedFactEntityBackfillStats {
  factsScanned: number;
  evidenceScanned: number;
  candidates: number;
  promoted: number;
  ambiguous: number;
  ignored: number;
}

export interface GroundedFactResourceBackfillStats {
  factsScanned: number;
  evidenceScanned: number;
  candidates: number;
  promoted: number;
  ambiguous: number;
  ignored: number;
}

export interface MemoryRelationshipReconciliationReport {
  backupPath: string | null;
  before: EntityRelationshipHealth;
  identities: ReturnType<typeof autoReconcileStrongEntityIdentifiers>;
  factEntityLinks: LinkSyncStats;
  groundedFactEntityLinks: GroundedFactEntityBackfillStats;
  factResourceLinks: LinkSyncStats;
  groundedFactResourceLinks: GroundedFactResourceBackfillStats;
  relationships: EntityRelationshipBackfillStats;
  after: EntityRelationshipHealth;
  elapsedMs: number;
}

export interface EntityRelationshipHealth {
  entityEntity: number;
  groundedEntityEntity: number;
  legacyUngroundedEntityEntity: number;
  entityRelationshipEvidence: number;
  unavailableRelationshipEvidence: number;
  relationshipValidityIntervals: number;
}

// ── fact ↔ entity links ────────────────────────────────────────────────

export interface FactLinkProvenance {
  linkType?: 'stored' | 'extracted' | 'inferred_text';
  confidence?: number;
  evidenceEpisodeId?: string;
  evidenceExcerpt?: string;
  sourceUri?: string;
  sourceKind?: 'fact_link' | 'fact_backfill';
  incrementMention?: boolean;
}

function writeFactEntityLinksInDatabase(
  db: Database.Database,
  factId: number,
  entityIds: number[],
  provenance: FactLinkProvenance,
  replaceTier: boolean,
): void {
  const now = new Date().toISOString();
  const linkType = provenance.linkType ?? 'stored';
  const confidence = Math.max(0, Math.min(1, provenance.confidence ?? (linkType === 'inferred_text' ? 0.55 : 1)));
  const unique = Array.from(new Set(
    entityIds
      .filter((n) => Number.isInteger(n) && n > 0)
      .map((id) => resolveCanonicalEntityIdInDatabase(db, id)),
  ));
  const tx = db.transaction(() => {
    if (replaceTier) {
      if (linkType === 'inferred_text') db.prepare("DELETE FROM fact_entities WHERE fact_id = ? AND link_type = 'inferred_text'").run(factId);
      else db.prepare("DELETE FROM fact_entities WHERE fact_id = ? AND link_type IN ('stored','extracted')").run(factId);
    }
    const ins = db.prepare(`
      INSERT INTO fact_entities
        (fact_id, entity_id, created_at, link_type, confidence, evidence_episode_id, evidence_excerpt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fact_id, entity_id) DO UPDATE SET
        link_type = CASE
          WHEN fact_entities.link_type IN ('stored','extracted') AND excluded.link_type = 'inferred_text'
            THEN fact_entities.link_type
          WHEN fact_entities.link_type = 'stored' AND excluded.link_type = 'extracted'
            THEN fact_entities.link_type
          ELSE excluded.link_type
        END,
        confidence = CASE
          WHEN fact_entities.link_type IN ('stored','extracted') AND excluded.link_type = 'inferred_text'
            THEN fact_entities.confidence
          ELSE MAX(fact_entities.confidence, excluded.confidence)
        END,
        evidence_episode_id = CASE
          WHEN fact_entities.link_type IN ('stored','extracted') AND excluded.link_type = 'inferred_text'
            THEN fact_entities.evidence_episode_id
          WHEN fact_entities.link_type = 'stored' AND excluded.link_type = 'extracted'
            THEN fact_entities.evidence_episode_id
          WHEN excluded.confidence > fact_entities.confidence
            THEN COALESCE(excluded.evidence_episode_id, fact_entities.evidence_episode_id)
          ELSE COALESCE(fact_entities.evidence_episode_id, excluded.evidence_episode_id)
        END,
        evidence_excerpt = CASE
          WHEN fact_entities.link_type IN ('stored','extracted') AND excluded.link_type = 'inferred_text'
            THEN fact_entities.evidence_excerpt
          WHEN fact_entities.link_type = 'stored' AND excluded.link_type = 'extracted'
            THEN fact_entities.evidence_excerpt
          WHEN excluded.confidence > fact_entities.confidence
            THEN COALESCE(excluded.evidence_excerpt, fact_entities.evidence_excerpt)
          ELSE COALESCE(fact_entities.evidence_excerpt, excluded.evidence_excerpt)
        END
    `);
    for (const eid of unique) {
      ins.run(
        factId, eid, now, linkType, confidence,
        provenance.evidenceEpisodeId ?? null,
        provenance.evidenceExcerpt?.trim().slice(0, 1_500) || null,
      );
      if (linkType !== 'inferred_text' && provenance.evidenceEpisodeId) {
        observeEntityFromEpisodeInDatabase(db, {
          entityId: eid,
          episodeId: provenance.evidenceEpisodeId,
          sourceFactId: factId,
          sourceUri: provenance.sourceUri,
          confidence,
          sourceKind: provenance.sourceKind ?? 'fact_link',
          incrementMention: provenance.incrementMention,
        });
      }
    }
  });
  tx();
}

/** Replace one provenance tier of entity links for a fact (idempotent). */
export function setFactEntityLinks(factId: number, entityIds: number[], provenance: FactLinkProvenance = {}): void {
  writeFactEntityLinksInDatabase(openMemoryDb(), factId, entityIds, provenance, true);
}

/** Add evidence-backed links without deleting or rewriting unrelated links. */
export function addFactEntityLinks(factId: number, entityIds: number[], provenance: FactLinkProvenance = {}): void {
  writeFactEntityLinksInDatabase(openMemoryDb(), factId, entityIds, provenance, false);
}

export function addFactEntityLinksInDatabase(
  db: Database.Database,
  factId: number,
  entityIds: number[],
  provenance: FactLinkProvenance = {},
): void {
  writeFactEntityLinksInDatabase(db, factId, entityIds, provenance, false);
}

export function getEntityIdsForFact(factId: number): number[] {
  const db = openMemoryDb();
  return Array.from(new Set(
    (db.prepare('SELECT entity_id FROM fact_entities WHERE fact_id = ?').all(factId) as { entity_id: number }[])
      .map((r) => resolveCanonicalEntityId(r.entity_id)),
  ));
}

/** Fact ids linked to an entity, newest fact first. Backs entity→facts recall. */
export function getFactIdsForEntity(entityId: number, limit = 50, asOf?: string, includeInferred = false): number[] {
  const db = openMemoryDb();
  const canonicalId = resolveCanonicalEntityId(entityId);
  const rows = asOf ? db.prepare(`
    SELECT fe.fact_id AS id
    FROM fact_entities fe
    JOIN consolidated_facts cf ON cf.id = fe.fact_id
    WHERE fe.entity_id = ?
      AND (? = 1 OR fe.link_type <> 'inferred_text')
      AND EXISTS (
        SELECT 1 FROM fact_validity_intervals fvi
        WHERE fvi.fact_id = cf.id AND fvi.valid_from <= ?
          AND (fvi.valid_to IS NULL OR fvi.valid_to > ?)
      )
    ORDER BY cf.updated_at DESC
    LIMIT ?
  `).all(canonicalId, includeInferred ? 1 : 0, asOf, asOf, Math.max(1, limit)) : db.prepare(`
    SELECT fe.fact_id AS id
    FROM fact_entities fe
    JOIN consolidated_facts cf ON cf.id = fe.fact_id
    WHERE fe.entity_id = ? AND (? = 1 OR fe.link_type <> 'inferred_text') AND cf.active = 1
    ORDER BY cf.updated_at DESC
    LIMIT ?
  `).all(canonicalId, includeInferred ? 1 : 0, Math.max(1, limit));
  return (rows as { id: number }[]).map((r) => r.id);
}

/** Stored fact→entity edges for a set of facts — consumed by the graph builder. */
export function loadFactEntityEdges(factIds: number[]): Array<{
  factId: number;
  entityId: number;
  truth: 'stored' | 'inferred';
  confidence: number;
  evidenceEpisodeId: string | null;
  evidenceExcerpt: string | null;
}> {
  if (factIds.length === 0) return [];
  const db = openMemoryDb();
  const ph = factIds.map(() => '?').join(',');
  const seen = new Set<string>();
  const out: Array<{ factId: number; entityId: number; truth: 'stored' | 'inferred'; confidence: number; evidenceEpisodeId: string | null; evidenceExcerpt: string | null }> = [];
  for (const row of db.prepare(`
    SELECT fact_id, entity_id, link_type, confidence, evidence_episode_id, evidence_excerpt
    FROM fact_entities WHERE fact_id IN (${ph})
  `).all(...factIds) as Array<{ fact_id: number; entity_id: number; link_type: string; confidence: number; evidence_episode_id: string | null; evidence_excerpt: string | null }>) {
    const entityId = resolveCanonicalEntityId(row.entity_id);
    const key = `${row.fact_id}:${entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      factId: row.fact_id,
      entityId,
      truth: row.link_type === 'inferred_text' ? 'inferred' : 'stored',
      confidence: row.confidence,
      evidenceEpisodeId: row.evidence_episode_id,
      evidenceExcerpt: row.evidence_excerpt,
    });
  }
  return out;
}

// ── fact ↔ resource links ──────────────────────────────────────────────

function writeFactResourceLinksInDatabase(
  db: Database.Database,
  factId: number,
  resourceIds: number[],
  provenance: FactLinkProvenance,
  replaceTier: boolean,
): void {
  const now = new Date().toISOString();
  const linkType = provenance.linkType ?? 'stored';
  const confidence = Math.max(0, Math.min(1, provenance.confidence ?? (linkType === 'inferred_text' ? 0.55 : 1)));
  const unique = Array.from(new Set(resourceIds.filter((n) => Number.isInteger(n) && n > 0)));
  const tx = db.transaction(() => {
    if (replaceTier) {
      if (linkType === 'inferred_text') db.prepare("DELETE FROM fact_resources WHERE fact_id = ? AND link_type = 'inferred_text'").run(factId);
      else db.prepare("DELETE FROM fact_resources WHERE fact_id = ? AND link_type IN ('stored','extracted')").run(factId);
    }
    const ins = db.prepare(`
      INSERT INTO fact_resources
        (fact_id, resource_id, created_at, link_type, confidence, evidence_episode_id, evidence_excerpt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fact_id, resource_id) DO UPDATE SET
        link_type = CASE
          WHEN fact_resources.link_type IN ('stored','extracted') AND excluded.link_type = 'inferred_text'
            THEN fact_resources.link_type
          WHEN fact_resources.link_type = 'stored' AND excluded.link_type = 'extracted'
            THEN fact_resources.link_type
          ELSE excluded.link_type
        END,
        confidence = CASE
          WHEN fact_resources.link_type IN ('stored','extracted') AND excluded.link_type = 'inferred_text'
            THEN fact_resources.confidence
          ELSE MAX(fact_resources.confidence, excluded.confidence)
        END,
        evidence_episode_id = CASE
          WHEN fact_resources.link_type IN ('stored','extracted') AND excluded.link_type = 'inferred_text'
            THEN fact_resources.evidence_episode_id
          WHEN fact_resources.link_type = 'stored' AND excluded.link_type = 'extracted'
            THEN fact_resources.evidence_episode_id
          WHEN excluded.confidence > fact_resources.confidence
            THEN COALESCE(excluded.evidence_episode_id, fact_resources.evidence_episode_id)
          ELSE COALESCE(fact_resources.evidence_episode_id, excluded.evidence_episode_id)
        END,
        evidence_excerpt = CASE
          WHEN fact_resources.link_type IN ('stored','extracted') AND excluded.link_type = 'inferred_text'
            THEN fact_resources.evidence_excerpt
          WHEN fact_resources.link_type = 'stored' AND excluded.link_type = 'extracted'
            THEN fact_resources.evidence_excerpt
          WHEN excluded.confidence > fact_resources.confidence
            THEN COALESCE(excluded.evidence_excerpt, fact_resources.evidence_excerpt)
          ELSE COALESCE(fact_resources.evidence_excerpt, excluded.evidence_excerpt)
        END
    `);
    for (const rid of unique) ins.run(
      factId, rid, now, linkType, confidence,
      provenance.evidenceEpisodeId ?? null,
      provenance.evidenceExcerpt?.trim().slice(0, 1_500) || null,
    );
  });
  tx();
}

/** Replace one provenance tier of resource links for a fact (idempotent). */
export function setFactResourceLinks(factId: number, resourceIds: number[], provenance: FactLinkProvenance = {}): void {
  writeFactResourceLinksInDatabase(openMemoryDb(), factId, resourceIds, provenance, true);
}

/** Add evidence-backed resource links without deleting unrelated links. */
export function addFactResourceLinks(factId: number, resourceIds: number[], provenance: FactLinkProvenance = {}): void {
  writeFactResourceLinksInDatabase(openMemoryDb(), factId, resourceIds, provenance, false);
}

export function addFactResourceLinksInDatabase(
  db: Database.Database,
  factId: number,
  resourceIds: number[],
  provenance: FactLinkProvenance = {},
): void {
  writeFactResourceLinksInDatabase(db, factId, resourceIds, provenance, false);
}

export function loadFactResourceEdges(factIds: number[]): Array<{
  factId: number;
  resourceId: number;
  truth: 'stored' | 'inferred';
  confidence: number;
  evidenceEpisodeId: string | null;
  evidenceExcerpt: string | null;
}> {
  if (factIds.length === 0) return [];
  const db = openMemoryDb();
  const ph = factIds.map(() => '?').join(',');
  return (db.prepare(`
    SELECT fact_id, resource_id, link_type, confidence, evidence_episode_id, evidence_excerpt
    FROM fact_resources WHERE fact_id IN (${ph})
  `).all(...factIds) as Array<{
    fact_id: number; resource_id: number; link_type: string; confidence: number;
    evidence_episode_id: string | null; evidence_excerpt: string | null;
  }>).map((r) => ({
    factId: r.fact_id,
    resourceId: r.resource_id,
    truth: r.link_type === 'inferred_text' ? 'inferred' : 'stored',
    confidence: r.confidence,
    evidenceEpisodeId: r.evidence_episode_id,
    evidenceExcerpt: r.evidence_excerpt,
  }));
}

export function getFactIdsForResource(resourceId: number, limit = 50, asOf?: string, includeInferred = false): number[] {
  const db = openMemoryDb();
  const rows = asOf ? db.prepare(`
    SELECT fr.fact_id AS id
    FROM fact_resources fr
    JOIN consolidated_facts cf ON cf.id = fr.fact_id
    WHERE fr.resource_id = ?
      AND (? = 1 OR fr.link_type <> 'inferred_text')
      AND EXISTS (
        SELECT 1 FROM fact_validity_intervals fvi
        WHERE fvi.fact_id = cf.id AND fvi.valid_from <= ?
          AND (fvi.valid_to IS NULL OR fvi.valid_to > ?)
      )
    ORDER BY cf.updated_at DESC
    LIMIT ?
  `).all(resourceId, includeInferred ? 1 : 0, asOf, asOf, Math.max(1, limit)) : db.prepare(`
    SELECT fr.fact_id AS id
    FROM fact_resources fr
    JOIN consolidated_facts cf ON cf.id = fr.fact_id
    WHERE fr.resource_id = ? AND (? = 1 OR fr.link_type <> 'inferred_text') AND cf.active = 1
    ORDER BY cf.updated_at DESC
    LIMIT ?
  `).all(resourceId, includeInferred ? 1 : 0, Math.max(1, limit));
  return (rows as Array<{ id: number }>).map((row) => row.id);
}

export function getResourceIdsForFact(factId: number): number[] {
  return (openMemoryDb().prepare(
    'SELECT resource_id FROM fact_resources WHERE fact_id = ?',
  ).all(factId) as Array<{ resource_id: number }>).map((row) => row.resource_id);
}

export function getNeighborEntityIds(entityIds: number[], limit = 50, asOf = new Date().toISOString()): number[] {
  if (entityIds.length === 0) return [];
  const db = openMemoryDb();
  const canonicalIds = Array.from(new Set(entityIds.map((id) => resolveCanonicalEntityId(id))));
  const placeholders = canonicalIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT ee.subject_id, ee.object_id
    FROM entity_edges ee
    WHERE ${edgeIsValidSql('ee')}
      AND (subject_id IN (${placeholders}) OR object_id IN (${placeholders}))
    ORDER BY recurrence_count DESC, last_seen_at DESC
    LIMIT ?
  `).all(asOf, asOf, asOf, asOf, asOf, ...canonicalIds, ...canonicalIds, Math.max(1, limit)) as Array<{ subject_id: number; object_id: number }>;
  const seeds = new Set(canonicalIds);
  const out = new Set<number>();
  for (const row of rows) {
    const subjectId = resolveCanonicalEntityId(row.subject_id);
    const objectId = resolveCanonicalEntityId(row.object_id);
    if (!seeds.has(subjectId)) out.add(subjectId);
    if (!seeds.has(objectId)) out.add(objectId);
  }
  return Array.from(out);
}

// ── entity ↔ entity edges ──────────────────────────────────────────────

/**
 * Persist a relationship only when an exact supporting excerpt can be found
 * in a durable episode source. Evidence identity makes extractor retries
 * idempotent: the same episode + excerpt can never inflate recurrence.
 */
export function recordGroundedEntityRelationship(input: {
  subjectId: number;
  predicate: string;
  objectId: number;
  evidenceEpisodeId: string;
  evidenceExcerpt: string;
  sourceText: string;
  sourceUri?: string;
  sourceFactId?: number;
  confidence?: number;
  validFrom?: string;
  validTo?: string;
  extractionMethod?: EntityEdgeEvidenceRow['extractionMethod'];
  supersedes?: { subjectId: number; predicate: string; objectId: number };
}): EntityRelationshipResult {
  const predicate = normalizeRelationshipPredicate(input.predicate);
  if (!predicate) return { outcome: 'ignore', reason: 'unsupported_predicate' };
  const subjectId = resolveCanonicalEntityId(input.subjectId);
  const objectId = resolveCanonicalEntityId(input.objectId);
  if (subjectId === objectId) return { outcome: 'ignore', reason: 'self_edge' };

  const excerpt = input.evidenceExcerpt.trim().slice(0, 1_500);
  if (excerpt.length < 3 || !input.sourceText.includes(excerpt)) {
    return { outcome: 'ignore', reason: 'ungrounded_evidence' };
  }

  const db = openMemoryDb();
  if (!evidenceExplicitlySupportsEdge(excerpt, subjectId, predicate, objectId)) {
    return { outcome: 'ignore', reason: 'evidence_does_not_support_edge' };
  }
  const episode = db.prepare(`
    SELECT id, occurred_at, source_uri, status FROM memory_episodes WHERE id = ?
  `).get(input.evidenceEpisodeId) as {
    id: string; occurred_at: string; source_uri: string | null; status: string;
  } | undefined;
  if (!episode) return { outcome: 'ignore', reason: 'missing_episode' };
  if (episode.status === 'missing' || episode.status === 'expired') {
    return { outcome: 'ignore', reason: 'unavailable_episode' };
  }

  const observedAt = normalizedIso(episode.occurred_at, new Date().toISOString());
  const validFrom = normalizedIso(input.validFrom, observedAt);
  const validTo = input.validTo ? normalizedIso(input.validTo, validFrom) : null;
  if (validTo && validTo <= validFrom) return { outcome: 'ignore', reason: 'invalid_validity_range' };
  const confidence = Math.max(0, Math.min(1, input.confidence ?? 0.7));
  const excerptHash = createHash('sha256').update(excerpt).digest('hex');
  const sourceUri = input.sourceUri ?? episode.source_uri ?? null;
  const extractionMethod = input.extractionMethod ?? 'reflection';

  return db.transaction((): EntityRelationshipResult => {
    const duplicate = db.prepare(`
      SELECT 1 FROM entity_edge_evidence
      WHERE subject_id = ? AND predicate = ? AND object_id = ?
        AND episode_id = ? AND excerpt_hash = ?
    `).get(subjectId, predicate, objectId, episode.id, excerptHash);
    if (duplicate) {
      const count = (db.prepare(`
        SELECT COUNT(*) AS c FROM entity_edge_evidence
        WHERE subject_id = ? AND predicate = ? AND object_id = ?
      `).get(subjectId, predicate, objectId) as { c: number }).c;
      return { outcome: 'ignore', reason: 'duplicate_evidence', subjectId, predicate, objectId, evidenceCount: count };
    }

    const existing = db.prepare(`
      SELECT recurrence_count, invalidated_at FROM entity_edges
      WHERE subject_id = ? AND predicate = ? AND object_id = ?
    `).get(subjectId, predicate, objectId) as { recurrence_count: number; invalidated_at: string | null } | undefined;
    const now = new Date().toISOString();
    if (!existing) {
      db.prepare(`
        INSERT INTO entity_edges
          (subject_id, predicate, object_id, recurrence_count, first_seen_at, last_seen_at,
           confidence, evidence_episode_id, valid_from, valid_to, invalidated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, NULL)
      `).run(subjectId, predicate, objectId, observedAt, observedAt, confidence, episode.id, validFrom, validTo);
    } else {
      db.prepare(`
        UPDATE entity_edges SET
          recurrence_count = recurrence_count + 1,
          last_seen_at = MAX(last_seen_at, ?),
          confidence = MAX(confidence, ?),
          evidence_episode_id = ?,
          valid_from = CASE WHEN invalidated_at IS NOT NULL THEN ? ELSE valid_from END,
          valid_to = ?,
          invalidated_at = NULL
        WHERE subject_id = ? AND predicate = ? AND object_id = ?
      `).run(observedAt, confidence, episode.id, validFrom, validTo, subjectId, predicate, objectId);
    }

    db.prepare(`
      INSERT INTO entity_edge_evidence
        (subject_id, predicate, object_id, episode_id, excerpt_hash, excerpt,
         source_uri, source_fact_id, confidence, observed_at, valid_from, valid_to,
         extraction_method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      subjectId, predicate, objectId, episode.id, excerptHash, excerpt,
      sourceUri, input.sourceFactId ?? null, confidence, observedAt, validFrom, validTo,
      extractionMethod, now,
    );

    const openInterval = db.prepare(`
      SELECT id FROM entity_edge_validity_intervals
      WHERE subject_id = ? AND predicate = ? AND object_id = ? AND valid_to IS NULL
      ORDER BY valid_from DESC LIMIT 1
    `).get(subjectId, predicate, objectId) as { id: number } | undefined;
    if (!openInterval) {
      db.prepare(`
        INSERT OR IGNORE INTO entity_edge_validity_intervals
          (subject_id, predicate, object_id, valid_from, valid_to, opened_reason,
           closed_reason, evidence_episode_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'asserted', ?, ?, ?, ?)
      `).run(
        subjectId, predicate, objectId, validFrom, validTo,
        validTo ? 'bounded-assertion' : null, episode.id, now, now,
      );
    } else if (validTo) {
      db.prepare(`
        UPDATE entity_edge_validity_intervals
        SET valid_to = ?, closed_reason = 'bounded-assertion',
            evidence_episode_id = ?, updated_at = ?
        WHERE id = ?
      `).run(validTo, episode.id, now, openInterval.id);
    }

    let outcome: EntityRelationshipOutcome = existing ? 'reinforce' : 'add';
    if (input.supersedes) {
      const oldPredicate = normalizeRelationshipPredicate(input.supersedes.predicate);
      const oldSubjectId = resolveCanonicalEntityId(input.supersedes.subjectId);
      const oldObjectId = resolveCanonicalEntityId(input.supersedes.objectId);
      if (oldPredicate && !(oldSubjectId === subjectId && oldPredicate === predicate && oldObjectId === objectId)) {
        const closed = db.prepare(`
          UPDATE entity_edges SET valid_to = ?, invalidated_at = ?, last_seen_at = MAX(last_seen_at, ?)
          WHERE subject_id = ? AND predicate = ? AND object_id = ?
            AND (invalidated_at IS NULL OR invalidated_at > ?)
        `).run(validFrom, validFrom, observedAt, oldSubjectId, oldPredicate, oldObjectId, validFrom);
        if (closed.changes > 0) {
          db.prepare(`
            UPDATE entity_edge_validity_intervals
            SET valid_to = ?, closed_reason = 'superseded',
                evidence_episode_id = ?, updated_at = ?
            WHERE subject_id = ? AND predicate = ? AND object_id = ? AND valid_to IS NULL
          `).run(validFrom, episode.id, now, oldSubjectId, oldPredicate, oldObjectId);
          outcome = 'supersede';
        }
      }
    }

    const evidenceCount = (db.prepare(`
      SELECT COUNT(*) AS c FROM entity_edge_evidence
      WHERE subject_id = ? AND predicate = ? AND object_id = ?
    `).get(subjectId, predicate, objectId) as { c: number }).c;
    return { outcome, reason: outcome === 'supersede' ? 'explicit_supersession' : 'grounded_evidence', subjectId, predicate, objectId, evidenceCount };
  })();
}

/** Legacy/manual edge writer. Learned relationships must use the grounded API. */
export function recordEntityEdge(input: {
  subjectId: number;
  predicate: string;
  objectId: number;
  confidence?: number;
  evidenceEpisodeId?: string;
  validFrom?: string;
  validTo?: string;
}): void {
  const predicate = input.predicate.trim().slice(0, 80);
  if (!predicate) return;
  const subjectId = resolveCanonicalEntityId(input.subjectId);
  const objectId = resolveCanonicalEntityId(input.objectId);
  if (subjectId === objectId) return;
  const db = openMemoryDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO entity_edges
      (subject_id, predicate, object_id, recurrence_count, first_seen_at, last_seen_at,
       confidence, evidence_episode_id, valid_from, valid_to, invalidated_at)
    VALUES (?,?,?,1,?,?,?,?,?,?,NULL)
    ON CONFLICT(subject_id, predicate, object_id) DO UPDATE SET
      recurrence_count = recurrence_count + 1,
      last_seen_at = excluded.last_seen_at,
      confidence = MAX(entity_edges.confidence, excluded.confidence),
      evidence_episode_id = COALESCE(excluded.evidence_episode_id, entity_edges.evidence_episode_id),
      valid_from = COALESCE(entity_edges.valid_from, excluded.valid_from),
      valid_to = excluded.valid_to,
      invalidated_at = NULL
  `).run(
    subjectId,
    predicate,
    objectId,
    now,
    now,
    Math.max(0, Math.min(1, input.confidence ?? 0.7)),
    input.evidenceEpisodeId ?? null,
    input.validFrom ?? now,
    input.validTo ?? null,
  );
  db.prepare(`
    INSERT OR IGNORE INTO entity_edge_validity_intervals
      (subject_id, predicate, object_id, valid_from, valid_to, opened_reason,
       closed_reason, evidence_episode_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'legacy-writer', ?, ?, ?, ?)
  `).run(
    subjectId, predicate, objectId, input.validFrom ?? now, input.validTo ?? null,
    input.validTo ? 'bounded-assertion' : null, input.evidenceEpisodeId ?? null, now, now,
  );
}

/** All entity edges (strongest/most-recent first) — consumed by the graph. */
export function loadEntityEdges(limit = 300, asOf = new Date().toISOString()): EntityEdgeRow[] {
  const db = openMemoryDb();
  const rows = db.prepare(`
    SELECT subject_id, predicate, object_id, recurrence_count, last_seen_at,
           confidence, evidence_episode_id, valid_from, valid_to
    FROM entity_edges ee
    WHERE ${edgeIsValidSql('ee')}
    ORDER BY recurrence_count DESC, last_seen_at DESC
    LIMIT ?
  `).all(asOf, asOf, asOf, asOf, asOf, Math.max(1, limit)) as Array<{
    subject_id: number; predicate: string; object_id: number; recurrence_count: number; last_seen_at: string;
    confidence: number; evidence_episode_id: string | null; valid_from: string | null; valid_to: string | null;
  }>;
  const evidence = db.prepare(`
    SELECT eee.episode_id, eee.excerpt, eee.source_uri, eee.source_fact_id,
           eee.confidence, eee.observed_at, eee.valid_from, eee.valid_to,
           eee.extraction_method, me.status AS episode_status
    FROM entity_edge_evidence eee
    JOIN memory_episodes me ON me.id = eee.episode_id
    WHERE eee.subject_id = ? AND eee.predicate = ? AND eee.object_id = ?
    ORDER BY eee.confidence DESC, eee.observed_at DESC
    LIMIT 5
  `);
  return rows.map((r) => {
    const evidenceRows = (evidence.all(r.subject_id, r.predicate, r.object_id) as Array<{
      episode_id: string; excerpt: string; source_uri: string | null; source_fact_id: number | null;
      confidence: number; observed_at: string; valid_from: string | null; valid_to: string | null;
      extraction_method: EntityEdgeEvidenceRow['extractionMethod']; episode_status: string;
    }>).map((item) => ({
      episodeId: item.episode_id,
      excerpt: item.excerpt,
      sourceUri: item.source_uri,
      sourceFactId: item.source_fact_id,
      confidence: item.confidence,
      observedAt: item.observed_at,
      validFrom: item.valid_from,
      validTo: item.valid_to,
      extractionMethod: item.extraction_method,
      episodeStatus: item.episode_status,
    }));
    const evidenceCount = (db.prepare(`
      SELECT COUNT(*) AS c FROM entity_edge_evidence
      WHERE subject_id = ? AND predicate = ? AND object_id = ?
    `).get(r.subject_id, r.predicate, r.object_id) as { c: number }).c;
    return {
      subjectId: r.subject_id,
      predicate: r.predicate,
      objectId: r.object_id,
      recurrenceCount: r.recurrence_count,
      lastSeenAt: r.last_seen_at,
      confidence: r.confidence,
      evidenceEpisodeId: r.evidence_episode_id,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      evidenceCount,
      evidence: evidenceRows,
    };
  });
}

export function countCurrentEntityEdges(asOf = new Date().toISOString()): number {
  const row = openMemoryDb().prepare(`
    SELECT COUNT(*) AS c FROM entity_edges ee WHERE ${edgeIsValidSql('ee')}
  `).get(asOf, asOf, asOf, asOf, asOf) as { c: number };
  return row.c;
}

export function readEntityRelationshipHealth(asOf = new Date().toISOString()): EntityRelationshipHealth {
  const db = openMemoryDb();
  const validArgs = [asOf, asOf, asOf, asOf, asOf];
  const current = (suffix: string): number => (db.prepare(`
    SELECT COUNT(*) AS c FROM entity_edges ee
    WHERE ${edgeIsValidSql('ee')} ${suffix}
  `).get(...validArgs) as { c: number }).c;
  const groundedEntityEntity = current(`AND EXISTS (
    SELECT 1 FROM entity_edge_evidence eee
    WHERE eee.subject_id = ee.subject_id AND eee.predicate = ee.predicate AND eee.object_id = ee.object_id
  )`);
  const entityEntity = current('');
  const one = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;
  return {
    entityEntity,
    groundedEntityEntity,
    legacyUngroundedEntityEntity: Math.max(0, entityEntity - groundedEntityEntity),
    entityRelationshipEvidence: one('SELECT COUNT(*) AS c FROM entity_edge_evidence'),
    unavailableRelationshipEvidence: one(`
      SELECT COUNT(*) AS c FROM entity_edge_evidence eee
      JOIN memory_episodes me ON me.id = eee.episode_id
      WHERE me.status IN ('missing','expired')
    `),
    relationshipValidityIntervals: one('SELECT COUNT(*) AS c FROM entity_edge_validity_intervals'),
  };
}

// ── entity recall (resolve a free-text objective → entities) ────────────

interface EntityMatcher {
  id: number;
  rank: number;
  nameRes: RegExp[];
  identifiers: Array<{ scheme: string; value: string; re: RegExp | null }>;
  anchors: string[];
}

interface EntityMatcherIndex {
  matchers: EntityMatcher[];
  byAnchor: Map<string, EntityMatcher[]>;
  phoneMatchers: EntityMatcher[];
  unanchored: EntityMatcher[];
}

let entityMatcherCache: {
  db: ReturnType<typeof openMemoryDb>;
  key: string;
  limit: number;
  index: EntityMatcherIndex;
} | null = null;

function matcherAnchor(value: string): string | null {
  const tokens = value.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  if (tokens.length === 0) return null;
  return tokens.sort((a, b) => b.length - a.length || a.localeCompare(b))[0] ?? null;
}

function buildEntityMatcherIndex(matchers: EntityMatcher[]): EntityMatcherIndex {
  const byAnchor = new Map<string, EntityMatcher[]>();
  const phoneMatchers: EntityMatcher[] = [];
  const unanchored: EntityMatcher[] = [];
  for (const matcher of matchers) {
    if (matcher.anchors.length === 0) unanchored.push(matcher);
    for (const anchor of matcher.anchors) {
      const rows = byAnchor.get(anchor) ?? [];
      rows.push(matcher);
      byAnchor.set(anchor, rows);
    }
    if (matcher.identifiers.some((identifier) => identifier.scheme === 'phone')) phoneMatchers.push(matcher);
  }
  return { matchers, byAnchor, phoneMatchers, unanchored };
}

function candidateEntityMatchers(index: EntityMatcherIndex, text: string): EntityMatcher[] {
  const candidates = new Set<EntityMatcher>(index.unanchored);
  const tokens = new Set(text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []);
  for (const token of tokens) for (const matcher of index.byAnchor.get(token) ?? []) candidates.add(matcher);
  if (index.phoneMatchers.length > 0) {
    const digits = text.replace(/\D/g, '');
    if (digits.length >= 7) {
      for (const matcher of index.phoneMatchers) {
        if (matcher.identifiers.some((identifier) => {
          if (identifier.scheme !== 'phone') return false;
          const wanted = identifier.value.replace(/\D/g, '');
          return wanted.length >= 7 && digits.includes(wanted);
        })) candidates.add(matcher);
      }
    }
  }
  return Array.from(candidates).sort((a, b) => a.rank - b.rank);
}

/** Do not interpret a token inside an email, URL, domain, or @handle as an
 * entity-name mention ("Acme" inside dana@acme.example is not evidence that the
 * sentence discusses the company). Full identifiers are matched separately. */
function maskIdentifierSpans(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi, ' ')
    .replace(/\bhttps?:\/\/[^\s]+/gi, ' ')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/gi, ' ')
    .replace(/(^|\s)@[a-z0-9_.-]+/gi, '$1 ');
}

function identifierAppears(text: string, matcher: EntityMatcher['identifiers'][number]): boolean {
  if (matcher.scheme === 'phone') {
    const wanted = matcher.value.replace(/\D/g, '');
    return wanted.length >= 7 && text.replace(/\D/g, '').includes(wanted);
  }
  return matcher.re?.test(text) ?? false;
}

function entityMatcherMatches(matcher: EntityMatcher, text: string): boolean {
  const lower = text.toLowerCase();
  const namesOnly = maskIdentifierSpans(lower);
  return matcher.nameRes.some((re) => re.test(namesOnly))
    || matcher.identifiers.some((identifier) => identifierAppears(lower, identifier));
}

/** Compile word-boundary matchers for every entity (canonical name + aliases). */
function entityMatcherIndex(limit = 100_000): EntityMatcherIndex {
  const db = openMemoryDb();
  const fingerprint = db.prepare(`
    SELECT
      (SELECT COUNT(*) || ':' || COALESCE(MAX(last_seen_at), '') || ':' || COALESCE(SUM(mention_count), 0) FROM entities) || '|' ||
      (SELECT COUNT(*) || ':' || COALESCE(MAX(last_seen_at), '') FROM entity_aliases) || '|' ||
      (SELECT COUNT(*) || ':' || COALESCE(MAX(last_seen_at), '') FROM entity_identifiers) || '|' ||
      (SELECT COUNT(*) || ':' || COALESCE(MAX(created_at), '') FROM entity_redirects) AS key
  `).get() as { key: string };
  const boundedLimit = Math.max(1, limit);
  if (entityMatcherCache?.db === db && entityMatcherCache.key === fingerprint.key && entityMatcherCache.limit === boundedLimit) {
    return entityMatcherCache.index;
  }
  const rows = db.prepare(`
    SELECT e.id, e.canonical_name_lc, e.aliases_json
    FROM entities e
    WHERE NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = e.id)
    ORDER BY mention_count DESC, last_seen_at DESC
    LIMIT ?
  `).all(boundedLimit) as Array<{ id: number; canonical_name_lc: string; aliases_json: string | null }>;
  const aliasesByEntity = new Map<number, string[]>();
  for (const alias of db.prepare(`
    SELECT ea.entity_id, ea.alias_lc
    FROM entity_aliases ea
    WHERE NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = ea.entity_id)
  `).all() as Array<{ entity_id: number; alias_lc: string }>) {
    const values = aliasesByEntity.get(alias.entity_id) ?? [];
    values.push(alias.alias_lc);
    aliasesByEntity.set(alias.entity_id, values);
  }
  const identifiersByEntity = new Map<number, Array<{ scheme: string; value: string }>>();
  for (const identifier of db.prepare(`
    SELECT ei.entity_id, ei.scheme, ei.value_norm
    FROM entity_identifiers ei
    WHERE NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = ei.entity_id)
  `).all() as Array<{ entity_id: number; scheme: string; value_norm: string }>) {
    const values = identifiersByEntity.get(identifier.entity_id) ?? [];
    values.push({ scheme: identifier.scheme, value: identifier.value_norm });
    identifiersByEntity.set(identifier.entity_id, values);
  }
  const out: EntityMatcher[] = [];
  for (const r of rows) {
    const names = new Set<string>();
    if (r.canonical_name_lc) names.add(r.canonical_name_lc);
    for (const alias of aliasesByEntity.get(r.id) ?? []) if (alias) names.add(alias);
    try {
      const aliases = r.aliases_json ? JSON.parse(r.aliases_json) : [];
      if (Array.isArray(aliases)) for (const a of aliases) {
        const al = String(a || '').trim().toLowerCase();
        if (al) names.add(al);
      }
    } catch { /* malformed aliases — skip */ }
    const nameValues = Array.from(names).filter((name) => !name.includes('@'));
    const nameRes = nameValues
      .filter((name) => !name.includes('@'))
      .map((n) => compileWordMatcher(n))
      .filter((re): re is RegExp => re !== null);
    const identifiers = (identifiersByEntity.get(r.id) ?? []).map((identifier) => ({
      ...identifier,
      re: identifier.scheme === 'phone' ? null : compileWordMatcher(identifier.value, 2),
    }));
    const anchors = Array.from(new Set([
      ...nameValues.map(matcherAnchor),
      ...identifiers.filter((identifier) => identifier.scheme !== 'phone').map((identifier) => matcherAnchor(identifier.value)),
    ].filter((anchor): anchor is string => anchor !== null)));
    if (nameRes.length > 0 || identifiers.length > 0) out.push({ id: r.id, rank: out.length, nameRes, identifiers, anchors });
  }
  const index = buildEntityMatcherIndex(out);
  entityMatcherCache = { db, key: fingerprint.key, limit: boundedLimit, index };
  return index;
}

function entityMatchers(limit = 100_000): EntityMatcher[] {
  return entityMatcherIndex(limit).matchers;
}

/** Entity ids whose canonical name / alias appears (word-boundary) in `text`. */
export function resolveEntityIdsForText(text: string, limit = 8): number[] {
  const source = text || '';
  if (!source.trim()) return [];
  const matched: number[] = [];
  const index = entityMatcherIndex();
  for (const m of candidateEntityMatchers(index, source)) {
    if (entityMatcherMatches(m, source)) matched.push(m.id);
    if (matched.length >= limit) break;
  }
  return matched;
}

// ── deterministic backfill sync ─────────────────────────────────────────

/**
 * Persist the graph's word-boundary fact↔entity inference as `inferred_text`
 * candidates over every active fact. Idempotent (replaces only that tier), so
 * re-running is safe and cannot overwrite grounded links. Bounded so a large
 * vault stays snappy on the nightly tick.
 */
export function syncFactEntityLinks(opts: { factLimit?: number; entityLimit?: number } = {}): LinkSyncStats {
  const factLimit = Math.max(1, opts.factLimit ?? 5000);
  const db = openMemoryDb();
  const index = entityMatcherIndex(opts.entityLimit ?? 100_000);
  const matchers = index.matchers;
  const facts = db.prepare(`
    SELECT id, content FROM consolidated_facts WHERE active = 1 ORDER BY updated_at DESC LIMIT ?
  `).all(factLimit) as Array<{ id: number; content: string }>;
  let linksWritten = 0;
  const tx = db.transaction(() => {
    for (const f of facts) {
      const ids: number[] = [];
      if (f.content) for (const m of candidateEntityMatchers(index, f.content)) if (entityMatcherMatches(m, f.content)) ids.push(m.id);
      setFactEntityLinks(f.id, ids, { linkType: 'inferred_text', confidence: 0.55 });
      linksWritten += ids.length;
    }
  });
  tx();
  return { factsScanned: facts.length, entitiesConsidered: matchers.length, linksWritten };
}

/** Same, for fact↔resource_pointers (word-boundary on the resource name). */
export function syncFactResourceLinks(opts: { factLimit?: number; resourceLimit?: number } = {}): LinkSyncStats {
  const factLimit = Math.max(1, opts.factLimit ?? 5000);
  const db = openMemoryDb();
  const resourceRows = db.prepare(`
    SELECT id, name FROM resource_pointers ORDER BY mention_count DESC, last_seen_at DESC LIMIT ?
  `).all(Math.max(1, opts.resourceLimit ?? 2000)) as Array<{ id: number; name: string }>;
  const matchers = resourceRows
    .map((r) => ({ id: r.id, re: compileWordMatcher((r.name || '').toLowerCase()) }))
    .filter((m): m is { id: number; re: RegExp } => m.re !== null);
  const facts = db.prepare(`
    SELECT id, content FROM consolidated_facts WHERE active = 1 ORDER BY updated_at DESC LIMIT ?
  `).all(factLimit) as Array<{ id: number; content: string }>;
  let linksWritten = 0;
  const tx = db.transaction(() => {
    for (const f of facts) {
      const lower = (f.content || '').toLowerCase();
      const ids: number[] = [];
      if (lower) for (const m of matchers) if (m.re.test(lower)) ids.push(m.id);
      setFactResourceLinks(f.id, ids, { linkType: 'inferred_text', confidence: 0.55 });
      linksWritten += ids.length;
    }
  });
  tx();
  return { factsScanned: facts.length, entitiesConsidered: matchers.length, linksWritten };
}

const HIGH_PRECISION_BACKFILL_PREDICATES = [
  'primary contact for', 'primary contact at', 'board member of',
  'collaborates with', 'reports to', 'works at', 'works for', 'employed by',
  'member of', 'partner at', 'customer of', 'client of', 'vendor for',
  'investor in', 'spouse of', 'married to', 'parent of', 'sibling of',
  'founded', 'advises', 'owns',
] as const;

const GENERIC_BACKFILL_ENTITY_NAMES = new Set([
  'user', 'the user', 'team', 'company', 'client', 'customer', 'project', 'people', 'person',
]);

const GENERIC_BACKFILL_RESOURCE_NAMES = new Set([
  'account', 'accounts', 'app', 'base', 'calendar', 'channel', 'crm', 'database',
  'docs', 'documents', 'drive', 'email', 'file', 'files', 'folder', 'home', 'inbox',
  'mail', 'notes', 'pipeline', 'project', 'projects', 'record', 'records', 'root',
  'sheet', 'slack', 'table', 'workspace',
]);

const GENERIC_RESOURCE_TOKENS = new Set([
  ...GENERIC_BACKFILL_RESOURCE_NAMES,
  'airtable', 'calendar', 'database', 'docs', 'drive', 'file', 'folder', 'google',
  'microsoft', 'notion', 'object', 'outlook', 'salesforce', 'sheet', 'sheets',
  'slack', 'table', 'workspace',
]);

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function entityNamesForBackfill(db: Database.Database, entityId: number): string[] {
  const row = db.prepare(`
    SELECT canonical_name, aliases_json FROM entities WHERE id = ?
  `).get(entityId) as { canonical_name: string; aliases_json: string } | undefined;
  if (!row) return [];
  const names = new Set<string>([row.canonical_name]);
  try {
    const aliases = JSON.parse(row.aliases_json) as unknown;
    if (Array.isArray(aliases)) for (const alias of aliases) if (typeof alias === 'string') names.add(alias);
  } catch { /* malformed legacy aliases */ }
  for (const alias of db.prepare(`
    SELECT alias FROM entity_aliases WHERE entity_id = ?
  `).all(entityId) as Array<{ alias: string }>) names.add(alias.alias);
  return Array.from(names)
    .map((name) => name.trim())
    .filter((name) => name.length >= 2 && !name.includes('@') && !GENERIC_BACKFILL_ENTITY_NAMES.has(name.toLowerCase()))
    .sort((a, b) => b.length - a.length);
}

interface EntityGroundingIndex {
  nameOwners: Map<string, Set<number>>;
  identifierOwners: Map<string, Set<number>>;
}

function normalizedGroundingName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function buildEntityGroundingIndex(db: Database.Database): EntityGroundingIndex {
  const nameOwners = new Map<string, Set<number>>();
  const identifierOwners = new Map<string, Set<number>>();
  const add = (map: Map<string, Set<number>>, key: string, entityId: number): void => {
    if (!key) return;
    const owners = map.get(key) ?? new Set<number>();
    owners.add(resolveCanonicalEntityIdInDatabase(db, entityId));
    map.set(key, owners);
  };
  for (const row of db.prepare(`
    SELECT e.id, e.canonical_name
    FROM entities e
    WHERE NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = e.id)
  `).all() as Array<{ id: number; canonical_name: string }>) {
    add(nameOwners, normalizedGroundingName(row.canonical_name), row.id);
  }
  for (const row of db.prepare(`
    SELECT ea.entity_id, ea.alias
    FROM entity_aliases ea
    WHERE NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = ea.entity_id)
  `).all() as Array<{ entity_id: number; alias: string }>) {
    add(nameOwners, normalizedGroundingName(row.alias), row.entity_id);
  }
  for (const row of db.prepare(`
    SELECT ei.entity_id, ei.scheme, ei.value_norm
    FROM entity_identifiers ei
    WHERE ei.scheme IN ('email','domain')
      AND NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = ei.entity_id)
  `).all() as Array<{ entity_id: number; scheme: string; value_norm: string }>) {
    add(identifierOwners, `${row.scheme}:${row.value_norm}`, row.entity_id);
  }
  return { nameOwners, identifierOwners };
}

function exactGroundingNameMatch(text: string, name: string): boolean {
  return compileWordMatcher(normalizedGroundingName(name), 2)?.test(text.toLowerCase()) ?? false;
}

function exactIdentifierMatch(text: string, value: string): boolean {
  return text.toLowerCase().includes(value.toLowerCase());
}

function normalizedResourceGroundingName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function resourceNameSpecificEnough(value: string, app?: string, kind?: string): boolean {
  const normalized = normalizedResourceGroundingName(value);
  if (GENERIC_BACKFILL_RESOURCE_NAMES.has(normalized) || /^\d+$/.test(normalized)) return false;
  const nameTokens = normalized.match(/[a-z0-9]+/g) ?? [];
  // A bare one-word label is too easy to collide with a person, project, or
  // ordinary noun (for example, an Airtable table named “FixtureLabel” or a generic
  // Salesforce “Event” object). Keep it inferred unless the label carries an
  // obviously identifying number or filename extension.
  if (nameTokens.length < 2 && !/\d/.test(normalized) && !/\.[a-z0-9]{2,8}$/i.test(normalized)) return false;
  const contextTokens = new Set(
    `${app ?? ''} ${kind ?? ''}`.toLowerCase().match(/[a-z0-9]+/g) ?? [],
  );
  const discriminative = nameTokens.filter((token) =>
    token.length >= 3 && !GENERIC_RESOURCE_TOKENS.has(token) && !contextTokens.has(token));
  return discriminative.length > 0;
}

function buildResourceNameOwners(db: Database.Database): Map<string, Set<number>> {
  const owners = new Map<string, Set<number>>();
  for (const row of db.prepare(`
    SELECT id, name FROM resource_pointers
  `).all() as Array<{ id: number; name: string }>) {
    const key = normalizedResourceGroundingName(row.name);
    if (!key) continue;
    const ids = owners.get(key) ?? new Set<number>();
    ids.add(row.id);
    owners.set(key, ids);
  }
  return owners;
}

function exactResourceNameMatch(text: string, name: string): boolean {
  return compileWordMatcher(normalizedResourceGroundingName(name), 2)?.test(text.toLowerCase()) ?? false;
}

export interface GroundedFactResourceAttachStats {
  resourcesConsidered: number;
  linked: number;
  ambiguous: number;
  ignored: number;
}

/**
 * Ground a newly written fact to existing resource pointers using only its
 * persisted evidence. A unique, sufficiently specific resource name must be
 * explicit in both the canonical claim and a surviving source excerpt. This
 * is deliberately stricter than source-map discovery: generic names such as
 * “CRM” or “Drive” remain navigation hints, never stored graph truth.
 */
export function attachGroundedFactResources(input: {
  factId: number;
  evidenceEpisodeId?: string;
  confidence?: number;
}): GroundedFactResourceAttachStats {
  const db = openMemoryDb();
  const fact = db.prepare(`
    SELECT content, confidence, trust_level FROM consolidated_facts WHERE id = ?
  `).get(input.factId) as { content: string; confidence: number | null; trust_level: number | null } | undefined;
  const stats: GroundedFactResourceAttachStats = { resourcesConsidered: 0, linked: 0, ambiguous: 0, ignored: 0 };
  if (!fact) return stats;
  const evidence = (input.evidenceEpisodeId ? db.prepare(`
    SELECT fve.episode_id, fve.excerpt
    FROM fact_evidence fve
    JOIN memory_episodes me ON me.id = fve.episode_id
    WHERE fve.fact_id = ? AND fve.episode_id = ? AND length(trim(fve.excerpt)) > 0
      AND me.status IN ('available','partial')
    ORDER BY fve.ordinal ASC
  `).all(input.factId, input.evidenceEpisodeId) : db.prepare(`
    SELECT fve.episode_id, fve.excerpt
    FROM fact_evidence fve
    JOIN memory_episodes me ON me.id = fve.episode_id
    WHERE fve.fact_id = ? AND length(trim(fve.excerpt)) > 0
      AND me.status IN ('available','partial')
    ORDER BY me.occurred_at DESC, fve.ordinal ASC
    LIMIT 12
  `).all(input.factId)) as Array<{ episode_id: string; excerpt: string }>;
  if (evidence.length === 0) return stats;
  const owners = buildResourceNameOwners(db);
  const resources = db.prepare(`
    SELECT id, app, kind, name FROM resource_pointers ORDER BY mention_count DESC, id ASC
  `).all() as Array<{ id: number; app: string; kind: string; name: string }>;
  for (const resource of resources) {
    stats.resourcesConsidered += 1;
    const key = normalizedResourceGroundingName(resource.name);
    const factMatch = exactResourceNameMatch(fact.content, resource.name);
    const supporting = factMatch
      ? evidence.find((item) => exactResourceNameMatch(item.excerpt, resource.name))
      : undefined;
    if (!factMatch && !supporting) continue;
    if (!resourceNameSpecificEnough(resource.name, resource.app, resource.kind)) {
      stats.ignored += 1;
      continue;
    }
    if ((owners.get(key)?.size ?? 0) !== 1) {
      stats.ambiguous += 1;
      continue;
    }
    if (!supporting) {
      stats.ignored += 1;
      continue;
    }
    addFactResourceLinksInDatabase(db, input.factId, [resource.id], {
      linkType: 'extracted',
      confidence: input.confidence ?? fact.confidence ?? fact.trust_level ?? 0.7,
      evidenceEpisodeId: supporting.episode_id,
      evidenceExcerpt: supporting.excerpt,
    });
    stats.linked += 1;
  }
  return stats;
}

/**
 * Promote inferred fact→entity candidates only when a unique, sufficiently
 * specific identity is explicitly named in both the durable claim and one of
 * its surviving evidence excerpts. This creates useful historical profiles
 * without treating every co-occurring first name as identity proof.
 */
export function backfillGroundedFactEntityLinks(
  opts: { factLimit?: number } = {},
): GroundedFactEntityBackfillStats {
  return backfillGroundedFactEntityLinksInDatabase(openMemoryDb(), opts);
}

export function backfillGroundedFactEntityLinksInDatabase(
  db: Database.Database,
  opts: { factLimit?: number } = {},
): GroundedFactEntityBackfillStats {
  const factLimit = Math.max(1, Math.min(50_000, Math.floor(opts.factLimit ?? 5_000)));
  const facts = db.prepare(`
    SELECT cf.id, cf.content, cf.confidence, cf.trust_level
    FROM consolidated_facts cf
    WHERE EXISTS (
      SELECT 1 FROM fact_entities fe
      WHERE fe.fact_id = cf.id AND fe.link_type = 'inferred_text'
    )
      AND EXISTS (
        SELECT 1 FROM fact_evidence fve
        JOIN memory_episodes me ON me.id = fve.episode_id
        WHERE fve.fact_id = cf.id AND length(trim(fve.excerpt)) > 0
          AND me.status IN ('available','partial')
      )
    ORDER BY cf.active DESC, cf.updated_at DESC, cf.id DESC
    LIMIT ?
  `).all(factLimit) as Array<{
    id: number; content: string; confidence: number | null; trust_level: number | null;
  }>;
  const readEvidence = db.prepare(`
    SELECT fve.episode_id, fve.excerpt, COALESCE(fve.source_uri, me.source_uri) AS source_uri
    FROM fact_evidence fve
    JOIN memory_episodes me ON me.id = fve.episode_id
    WHERE fve.fact_id = ? AND length(trim(fve.excerpt)) > 0
      AND me.status IN ('available','partial')
    ORDER BY me.occurred_at DESC, fve.ordinal ASC
    LIMIT 12
  `);
  const readCandidates = db.prepare(`
    SELECT fe.entity_id, e.entity_type
    FROM fact_entities fe
    JOIN entities e ON e.id = fe.entity_id
    WHERE fe.fact_id = ? AND fe.link_type = 'inferred_text'
      AND NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = e.id)
    ORDER BY e.mention_count DESC, e.id
  `);
  const readIdentifiers = db.prepare(`
    SELECT scheme, value_norm FROM entity_identifiers
    WHERE entity_id = ? AND scheme IN ('email','domain')
    ORDER BY confidence DESC
  `);
  const index = buildEntityGroundingIndex(db);
  const stats: GroundedFactEntityBackfillStats = {
    factsScanned: facts.length,
    evidenceScanned: 0,
    candidates: 0,
    promoted: 0,
    ambiguous: 0,
    ignored: 0,
  };

  for (const fact of facts) {
    const evidence = readEvidence.all(fact.id) as Array<{
      episode_id: string; excerpt: string; source_uri: string | null;
    }>;
    stats.evidenceScanned += evidence.length;
    const candidates = readCandidates.all(fact.id) as Array<{ entity_id: number; entity_type: string }>;
    for (const candidate of candidates) {
      stats.candidates += 1;
      const names = entityNamesForBackfill(db, candidate.entity_id);
      const strongNames = names.filter((name) => {
        const normalized = normalizedGroundingName(name);
        const specificEnough = candidate.entity_type === 'person'
          ? normalized.split(' ').length >= 2
          : normalized.length >= 3;
        return specificEnough && (index.nameOwners.get(normalized)?.size ?? 0) === 1;
      });
      const identifiers = readIdentifiers.all(candidate.entity_id) as Array<{ scheme: string; value_norm: string }>;
      let supporting: { episode_id: string; excerpt: string; source_uri: string | null } | undefined;
      for (const item of evidence) {
        const nameSupported = strongNames.some((name) =>
          exactGroundingNameMatch(fact.content, name) && exactGroundingNameMatch(item.excerpt, name));
        const identifierSupported = identifiers.some((identifier) =>
          (index.identifierOwners.get(`${identifier.scheme}:${identifier.value_norm}`)?.size ?? 0) === 1
          && exactIdentifierMatch(fact.content, identifier.value_norm)
          && exactIdentifierMatch(item.excerpt, identifier.value_norm));
        if (nameSupported || identifierSupported) {
          supporting = item;
          break;
        }
      }
      if (!supporting) {
        const weakOrSharedMatch = names.some((name) =>
          exactGroundingNameMatch(fact.content, name)
          && evidence.some((item) => exactGroundingNameMatch(item.excerpt, name)));
        if (weakOrSharedMatch) stats.ambiguous += 1;
        else stats.ignored += 1;
        continue;
      }
      addFactEntityLinksInDatabase(db, fact.id, [candidate.entity_id], {
        linkType: 'extracted',
        confidence: fact.confidence ?? fact.trust_level ?? 0.7,
        evidenceEpisodeId: supporting.episode_id,
        evidenceExcerpt: supporting.excerpt,
        sourceUri: supporting.source_uri ?? undefined,
        sourceKind: 'fact_backfill',
        incrementMention: false,
      });
      stats.promoted += 1;
    }
  }
  return stats;
}

/**
 * Promote legacy inferred fact→resource candidates only when the resource name
 * is unique, sufficiently specific, and explicit in both the canonical claim
 * and one of its surviving evidence excerpts. This is the resource equivalent
 * of the fact→entity grounding pass; ambiguous folder/object names stay
 * inferred and are never shown as stored truth.
 */
export function backfillGroundedFactResourceLinks(
  opts: { factLimit?: number } = {},
): GroundedFactResourceBackfillStats {
  return backfillGroundedFactResourceLinksInDatabase(openMemoryDb(), opts);
}

export function backfillGroundedFactResourceLinksInDatabase(
  db: Database.Database,
  opts: { factLimit?: number } = {},
): GroundedFactResourceBackfillStats {
  const factLimit = Math.max(1, Math.min(50_000, Math.floor(opts.factLimit ?? 5_000)));
  const facts = db.prepare(`
    SELECT cf.id, cf.content, cf.confidence, cf.trust_level
    FROM consolidated_facts cf
    WHERE EXISTS (
      SELECT 1 FROM fact_resources fr
      WHERE fr.fact_id = cf.id AND fr.link_type = 'inferred_text'
    )
      AND EXISTS (
        SELECT 1 FROM fact_evidence fve
        JOIN memory_episodes me ON me.id = fve.episode_id
        WHERE fve.fact_id = cf.id AND length(trim(fve.excerpt)) > 0
          AND me.status IN ('available','partial')
      )
    ORDER BY cf.active DESC, cf.updated_at DESC, cf.id DESC
    LIMIT ?
  `).all(factLimit) as Array<{
    id: number; content: string; confidence: number | null; trust_level: number | null;
  }>;
  const readEvidence = db.prepare(`
    SELECT fve.episode_id, fve.excerpt
    FROM fact_evidence fve
    JOIN memory_episodes me ON me.id = fve.episode_id
    WHERE fve.fact_id = ? AND length(trim(fve.excerpt)) > 0
      AND me.status IN ('available','partial')
    ORDER BY me.occurred_at DESC, fve.ordinal ASC
    LIMIT 12
  `);
  const readCandidates = db.prepare(`
    SELECT fr.resource_id, rp.app, rp.kind, rp.name
    FROM fact_resources fr
    JOIN resource_pointers rp ON rp.id = fr.resource_id
    WHERE fr.fact_id = ? AND fr.link_type = 'inferred_text'
    ORDER BY rp.mention_count DESC, rp.id ASC
  `);
  const owners = buildResourceNameOwners(db);
  const stats: GroundedFactResourceBackfillStats = {
    factsScanned: facts.length,
    evidenceScanned: 0,
    candidates: 0,
    promoted: 0,
    ambiguous: 0,
    ignored: 0,
  };
  for (const fact of facts) {
    const evidence = readEvidence.all(fact.id) as Array<{ episode_id: string; excerpt: string }>;
    stats.evidenceScanned += evidence.length;
    const candidates = readCandidates.all(fact.id) as Array<{
      resource_id: number; app: string; kind: string; name: string;
    }>;
    for (const candidate of candidates) {
      stats.candidates += 1;
      const factMatch = exactResourceNameMatch(fact.content, candidate.name);
      const supporting = factMatch
        ? evidence.find((item) => exactResourceNameMatch(item.excerpt, candidate.name))
        : undefined;
      if (!factMatch || !supporting || !resourceNameSpecificEnough(candidate.name, candidate.app, candidate.kind)) {
        stats.ignored += 1;
        continue;
      }
      const key = normalizedResourceGroundingName(candidate.name);
      if ((owners.get(key)?.size ?? 0) !== 1) {
        stats.ambiguous += 1;
        continue;
      }
      addFactResourceLinksInDatabase(db, fact.id, [candidate.resource_id], {
        linkType: 'extracted',
        confidence: fact.confidence ?? fact.trust_level ?? 0.7,
        evidenceEpisodeId: supporting.episode_id,
        evidenceExcerpt: supporting.excerpt,
      });
      stats.promoted += 1;
    }
  }
  return stats;
}

function explicitlyStatedRelationship(
  excerpt: string,
  subjectNames: string[],
  objectNames: string[],
  phrases: readonly string[],
): string | null {
  for (const subject of subjectNames) {
    for (const object of objectNames) {
      for (const phrase of phrases) {
        // Deliberately require a direct grammatical shape. This misses some
        // true relations, but it will not turn "Taylor leads the team at
        // Acme" into the false edge "Taylor leads Acme".
        const pattern = new RegExp(
          `\\b${regexEscape(subject)}\\b\\s+(?:(?:currently|now|also|still|is|was)\\s+){0,2}${regexEscape(phrase)}\\s+(?:the\\s+|an?\\s+)?\\b${regexEscape(object)}\\b`,
          'i',
        );
        if (pattern.test(excerpt)) return phrase;
      }
    }
  }
  return null;
}

/**
 * Conservative historical relationship promotion. It reads only active facts
 * with surviving, source-derived evidence and promotes only direct syntactic
 * subject→predicate→object statements between already-linked named entities.
 * Mere co-occurrence can never become stored graph truth.
 */
export function backfillGroundedEntityRelationships(
  opts: { factLimit?: number } = {},
): EntityRelationshipBackfillStats {
  const db = openMemoryDb();
  const rows = db.prepare(`
    SELECT cf.id AS fact_id, cf.confidence, cf.trust_level, cf.valid_from, cf.valid_to,
           fe.episode_id, fe.excerpt, fe.source_uri
    FROM consolidated_facts cf
    JOIN fact_evidence fe ON fe.fact_id = cf.id AND length(trim(fe.excerpt)) > 0
    JOIN memory_episodes me ON me.id = fe.episode_id AND me.status IN ('available','partial')
    WHERE cf.active = 1
      AND (SELECT COUNT(*) FROM fact_entities link WHERE link.fact_id = cf.id) >= 2
    ORDER BY cf.updated_at DESC, fe.ordinal ASC
    LIMIT ?
  `).all(Math.max(1, opts.factLimit ?? 5_000)) as Array<{
    fact_id: number; confidence: number | null; trust_level: number | null;
    valid_from: string | null; valid_to: string | null; episode_id: string;
    excerpt: string; source_uri: string | null;
  }>;
  const stats: EntityRelationshipBackfillStats = {
    factsScanned: new Set(rows.map((row) => row.fact_id)).size,
    evidenceScanned: rows.length,
    candidates: 0,
    added: 0,
    reinforced: 0,
    ignored: 0,
  };
  const names = new Map<number, string[]>();
  for (const row of rows) {
    const excerptLower = row.excerpt.toLowerCase();
    const phrases = HIGH_PRECISION_BACKFILL_PREDICATES.filter((phrase) => excerptLower.includes(phrase));
    if (phrases.length === 0) continue;
    const ids = getEntityIdsForFact(row.fact_id).slice(0, 12);
    for (const id of ids) if (!names.has(id)) names.set(id, entityNamesForBackfill(db, id));
    const emitted = new Set<string>();
    for (const subjectId of ids) {
      for (const objectId of ids) {
        if (subjectId === objectId) continue;
        const predicate = explicitlyStatedRelationship(
          row.excerpt,
          names.get(subjectId) ?? [],
          names.get(objectId) ?? [],
          phrases,
        );
        if (!predicate) continue;
        const key = `${subjectId}:${predicate}:${objectId}`;
        if (emitted.has(key)) continue;
        emitted.add(key);
        stats.candidates += 1;
        const result = recordGroundedEntityRelationship({
          subjectId,
          predicate,
          objectId,
          evidenceEpisodeId: row.episode_id,
          evidenceExcerpt: row.excerpt,
          sourceText: row.excerpt,
          sourceUri: row.source_uri ?? undefined,
          sourceFactId: row.fact_id,
          confidence: row.confidence ?? row.trust_level ?? 0.7,
          validFrom: row.valid_from ?? undefined,
          validTo: row.valid_to ?? undefined,
          extractionMethod: 'fact_backfill',
        });
        if (result.outcome === 'add') stats.added += 1;
        else if (result.outcome === 'reinforce' || result.outcome === 'supersede') stats.reinforced += 1;
        else stats.ignored += 1;
      }
    }
  }
  return stats;
}

/** Backup-first reconciliation used by maintenance and the desktop health UI.
 * It repairs only strong-identifier identity duplicates, refreshes explicitly
 * labeled inferred joins, grounds unique fact→entity mentions against exact
 * evidence, and promotes only exact evidence-backed relation sentences. It
 * never converts co-occurrence into stored graph truth. */
export function reconcileMemoryRelationships(opts: {
  factLimit?: number;
  requireBackup?: boolean;
} = {}): MemoryRelationshipReconciliationReport {
  const started = Date.now();
  const before = readEntityRelationshipHealth();
  const backup = opts.requireBackup === false ? null : backupMemoryDb({ retain: 14 });
  if (opts.requireBackup !== false && !backup) {
    throw new Error('relationship reconciliation requires a successful memory backup');
  }
  const factLimit = Math.max(1, Math.min(50_000, Math.floor(opts.factLimit ?? 5_000)));
  const identities = autoReconcileStrongEntityIdentifiers(500);
  const factEntityLinks = syncFactEntityLinks({ factLimit });
  const groundedFactEntityLinks = backfillGroundedFactEntityLinks({ factLimit });
  const factResourceLinks = syncFactResourceLinks({ factLimit });
  const groundedFactResourceLinks = backfillGroundedFactResourceLinks({ factLimit });
  const relationships = backfillGroundedEntityRelationships({ factLimit });
  return {
    backupPath: backup?.backupPath ?? null,
    before,
    identities,
    factEntityLinks,
    groundedFactEntityLinks,
    factResourceLinks,
    groundedFactResourceLinks,
    relationships,
    after: readEntityRelationshipHealth(),
    elapsedMs: Date.now() - started,
  };
}
