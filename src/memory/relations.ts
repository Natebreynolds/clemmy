import { exactGroundedIdentifierMatch } from './grounded-identifier-match.js';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { backupMemoryDb, openMemoryDb, type BackupResult } from './db.js';
import { compileWordMatcher } from './word-match.js';
import { NIGHTLY_SLICE, SliceClock, runSliced, runUnsliced, stepsOf } from './sliced-pass.js';
import {
  PassProgress,
  comparePassKeys,
  type PassCursorIO,
  type PassCursorKey,
  type PassPartialUnit,
  type PassResume,
} from './pass-cursor.js';
import { groundedEntityMentionIds, groundedMentionPrefilter, type NamedEntityMentions } from './grounded-entity-mentions.js';
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
  const statements = entityNameStatements(openMemoryDb());
  const row = statements.entity.get(entityId) as {
    canonical_name: string; aliases_json: string;
  } | undefined;
  if (!row) return [];
  const names = new Set<string>([row.canonical_name]);
  try {
    const parsed = JSON.parse(row.aliases_json) as unknown;
    if (Array.isArray(parsed)) for (const alias of parsed) if (typeof alias === 'string') names.add(alias);
  } catch { /* malformed legacy aliases */ }
  for (const item of statements.aliases.all(entityId) as Array<{ alias: string }>) names.add(item.alias);
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
  /** Writes refused by a constraint (the row's entity or resource was removed mid-pass); present only when some were. */
  skipped?: number;
}

export interface EntityRelationshipBackfillStats {
  factsScanned: number;
  evidenceScanned: number;
  candidates: number;
  added: number;
  reinforced: number;
  ignored: number;
  /** Writes refused by a constraint (the row's entity or resource was removed mid-pass); present only when some were. */
  skipped?: number;
}

export interface GroundedFactEntityBackfillStats {
  factsScanned: number;
  evidenceScanned: number;
  candidates: number;
  promoted: number;
  ambiguous: number;
  ignored: number;
  /** Writes refused by a constraint (the row's entity or resource was removed mid-pass); present only when some were. */
  skipped?: number;
}

export interface GroundedFactResourceBackfillStats {
  factsScanned: number;
  evidenceScanned: number;
  candidates: number;
  promoted: number;
  ambiguous: number;
  ignored: number;
  /** Writes refused by a constraint (the row's entity or resource was removed mid-pass); present only when some were. */
  skipped?: number;
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

/**
 * Statements prepared once per connection. Every per-fact statement names
 * `+link_type` so SQLite seeks the primary key (fact_id, entity_id) instead of
 * walking every row of `idx_*_truth (link_type, …)` for the tier: with no
 * table statistics the planner otherwise prefers that index, and one call then
 * costs a scan of the whole inferred tier.
 */
interface LinkWriteStatements {
  /** The fact's whole link set, by primary key: what an inferred-tier diff starts from. */
  readLinks: Database.Statement;
  /** One inferred row, by primary key. */
  deleteInferredLink: Database.Statement;
  deleteGroundedTier: Database.Statement;
  upsert: Database.Statement;
}

const factEntityWriteStatements = new WeakMap<Database.Database, LinkWriteStatements>();
const factResourceWriteStatements = new WeakMap<Database.Database, LinkWriteStatements>();

function entityLinkStatements(db: Database.Database): LinkWriteStatements {
  let statements = factEntityWriteStatements.get(db);
  if (statements) return statements;
  statements = {
    readLinks: db.prepare(`
      SELECT entity_id AS id, link_type, confidence, evidence_episode_id, evidence_excerpt
      FROM fact_entities WHERE fact_id = ?
    `),
    deleteInferredLink: db.prepare("DELETE FROM fact_entities WHERE fact_id = ? AND entity_id = ? AND +link_type = 'inferred_text'"),
    deleteGroundedTier: db.prepare("DELETE FROM fact_entities WHERE fact_id = ? AND +link_type IN ('stored','extracted')"),
    upsert: db.prepare(`
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
    `),
  };
  factEntityWriteStatements.set(db, statements);
  return statements;
}

interface StoredLinkRow {
  id: number;
  link_type: string;
  confidence: number;
  evidence_episode_id: string | null;
  evidence_excerpt: string | null;
}

/** One row write of an inferred-tier refresh. */
interface TierWrite {
  kind: 'delete' | 'insert';
  id: number;
}

interface InferredTierTarget {
  confidence: number;
  evidenceEpisodeId: string | null;
  evidenceExcerpt: string | null;
}

/**
 * The row writes that turn a fact's inferred tier into `wanted` (canonical,
 * unique ids), deletes first, then inserts. The result equals replacing the
 * whole tier, except that a row already exactly as wanted is left alone
 * (keeping its created_at and not bumping the memory generation):
 *   - an inferred row wanted with the same confidence and evidence is kept;
 *   - every other inferred row is deleted (including a wanted row at another
 *     confidence, which the replace would have re-inserted);
 *   - a wanted id with no row, or whose row was just deleted, is inserted;
 *   - a wanted id with a stored or extracted row is left alone, as the
 *     replace's upsert left it.
 */
function planInferredTierWrites(have: readonly StoredLinkRow[], wanted: readonly number[], target: InferredTierTarget): TierWrite[] {
  const wantedSet = new Set(wanted);
  const kept = new Set<number>();
  const grounded = new Set<number>();
  const writes: TierWrite[] = [];
  for (const row of have) {
    if (row.link_type !== 'inferred_text') {
      grounded.add(row.id);
      continue;
    }
    if (wantedSet.has(row.id)
      && row.confidence === target.confidence
      && row.evidence_episode_id === target.evidenceEpisodeId
      && row.evidence_excerpt === target.evidenceExcerpt) {
      kept.add(row.id);
    } else {
      writes.push({ kind: 'delete', id: row.id });
    }
  }
  for (const id of wanted) {
    if (!kept.has(id) && !grounded.has(id)) writes.push({ kind: 'insert', id });
  }
  return writes;
}

function inferredTierTarget(confidence: number, provenance: FactLinkProvenance): InferredTierTarget {
  return {
    confidence,
    evidenceEpisodeId: provenance.evidenceEpisodeId ?? null,
    evidenceExcerpt: provenance.evidenceExcerpt?.trim().slice(0, 1_500) || null,
  };
}

function applyTierWrite(
  statements: LinkWriteStatements,
  factId: number,
  write: TierWrite,
  target: InferredTierTarget,
  now: string,
): void {
  if (write.kind === 'delete') statements.deleteInferredLink.run(factId, write.id);
  else statements.upsert.run(factId, write.id, now, 'inferred_text', target.confidence, target.evidenceEpisodeId, target.evidenceExcerpt);
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
  const statements = entityLinkStatements(db);
  if (replaceTier && linkType === 'inferred_text') {
    const target = inferredTierTarget(confidence, provenance);
    db.transaction(() => {
      const writes = planInferredTierWrites(statements.readLinks.all(factId) as StoredLinkRow[], unique, target);
      for (const write of writes) applyTierWrite(statements, factId, write, target, now);
    })();
    return;
  }
  const tx = db.transaction(() => {
    if (replaceTier) statements.deleteGroundedTier.run(factId);
    for (const eid of unique) {
      statements.upsert.run(
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

function resourceLinkStatements(db: Database.Database): LinkWriteStatements {
  let statements = factResourceWriteStatements.get(db);
  if (statements) return statements;
  statements = {
    readLinks: db.prepare(`
      SELECT resource_id AS id, link_type, confidence, evidence_episode_id, evidence_excerpt
      FROM fact_resources WHERE fact_id = ?
    `),
    deleteInferredLink: db.prepare("DELETE FROM fact_resources WHERE fact_id = ? AND resource_id = ? AND +link_type = 'inferred_text'"),
    deleteGroundedTier: db.prepare("DELETE FROM fact_resources WHERE fact_id = ? AND +link_type IN ('stored','extracted')"),
    upsert: db.prepare(`
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
    `),
  };
  factResourceWriteStatements.set(db, statements);
  return statements;
}

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
  const statements = resourceLinkStatements(db);
  if (replaceTier && linkType === 'inferred_text') {
    const target = inferredTierTarget(confidence, provenance);
    db.transaction(() => {
      const writes = planInferredTierWrites(statements.readLinks.all(factId) as StoredLinkRow[], unique, target);
      for (const write of writes) applyTierWrite(statements, factId, write, target, now);
    })();
    return;
  }
  const tx = db.transaction(() => {
    if (replaceTier) statements.deleteGroundedTier.run(factId);
    for (const rid of unique) statements.upsert.run(
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
  names: string[];
  canonicalName: string;
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

/**
 * Entity ids whose names or identifiers appear in `text`, in matcher rank
 * order, stopping at `limit`. The text is lowercased, masked and reduced to
 * digits once for all candidate matchers rather than once per matcher. Names
 * match against the masked text and identifiers against the unmasked
 * lowercase text, as the per-matcher test did.
 */
function matchEntityIdsInText(index: EntityMatcherIndex, text: string, limit = Number.POSITIVE_INFINITY): number[] {
  const matched: number[] = [];
  const candidates = candidateEntityMatchers(index, text);
  if (candidates.length === 0) return matched;
  const lower = text.toLowerCase();
  const namesOnly = maskIdentifierSpans(lower);
  let lowerDigits: string | undefined;
  const identifierAppears = (identifier: EntityMatcher['identifiers'][number]): boolean => {
    if (identifier.scheme === 'phone') {
      const wanted = identifier.value.replace(/\D/g, '');
      if (wanted.length < 7) return false;
      lowerDigits ??= lower.replace(/\D/g, '');
      return lowerDigits.includes(wanted);
    }
    return identifier.re?.test(lower) ?? false;
  };
  for (const matcher of candidates) {
    if (matcher.nameRes.some((re) => re.test(namesOnly)) || matcher.identifiers.some(identifierAppears)) {
      matched.push(matcher.id);
    }
    if (matched.length >= limit) break;
  }
  return matched;
}

/** Test seam: the matcher index and the one-pass matcher, so a pin can hold
 * them against a per-matcher reference loop. */
export function entityMatcherInternalsForTest(): {
  entityMatcherIndex: (limit?: number) => EntityMatcherIndex;
  matchEntityIdsInText: (index: EntityMatcherIndex, text: string, limit?: number) => number[];
  candidateEntityMatchers: (index: EntityMatcherIndex, text: string) => EntityMatcher[];
  maskIdentifierSpans: (text: string) => string;
} {
  return { entityMatcherIndex, matchEntityIdsInText, candidateEntityMatchers, maskIdentifierSpans };
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
    if (nameRes.length > 0 || identifiers.length > 0) out.push({ id: r.id, rank: out.length, names: nameValues, canonicalName: r.canonical_name_lc, nameRes, identifiers, anchors });
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
  return matchEntityIdsInText(entityMatcherIndex(), source, limit);
}

/** Direct fact links require an unambiguous name in both claim and evidence.
 * Keep broad alias/identifier matching in recall; it is not stored identity proof.
 */
export function resolveGroundedEntityIdsForText(text: string, evidence: string, limit = 8, canonicalOnly = false): number[] {
  const index = entityMatcherIndex();
  const claimIds = groundedEntityMentionIds(maskIdentifierSpans(text), candidateEntityMatchers(index, text), canonicalOnly);
  const evidenceIds = new Set(groundedEntityMentionIds(maskIdentifierSpans(evidence), candidateEntityMatchers(index, evidence), canonicalOnly));
  return claimIds.filter(id => evidenceIds.has(id)).slice(0, limit);
}

// ── sliced passes: shared driver ───────────────────────────────────────

/**
 * Options every sliced (async) pass takes. Several passes may share one clock;
 * its budget and turn hooks then apply across all of them.
 */
export interface SlicedPassOptions {
  /** Slice budget and turn hooks. Default: the nightly budget. */
  clock?: SliceClock;
  /** Where the pass records committed progress so a restart the same day resumes it. Default: nowhere. */
  cursor?: PassCursorIO;
  /** Local day for the resume rule. Default: today. */
  day?: string;
  /** Minimum time between cursor writes. Default: 2 s. */
  cursorWriteIntervalMs?: number;
}

/** Cursor ids of the resumable link passes. */
export const LINK_PASS_IDS = Object.freeze({
  entitySync: 'link_sync.entities',
  resourceSync: 'link_sync.resources',
  entityBackfill: 'grounded_backfill.entities',
  resourceBackfill: 'grounded_backfill.resources',
  relationships: 'grounded_backfill.relationships',
});

/**
 * What a pass reports as committed after each slice. `stats` stays null until
 * the pass has made its selection, so a resume never inherits counts from an
 * attempt that stopped before it knew what it was scanning.
 */
interface PassPosition<S> {
  after: PassCursorKey | null;
  partial: PassPartialUnit | null;
  stats: S | null;
}

interface PassRun<S> {
  /** Yields after every unit of work and every row write (and after each setup statement). */
  steps: Generator<void, void, undefined>;
  position: () => PassPosition<S>;
  result: () => S;
}

type PassFactory<S> = (db: Database.Database, clock: SliceClock, resume: PassResume<S> | null) => PassRun<S>;

const UNBOUNDED_SLICE = Object.freeze({ maxMs: Number.POSITIVE_INFINITY, maxUnits: Number.POSITIVE_INFINITY, maxWrites: Number.POSITIVE_INFINITY });

/** Sliced passes running in this process, by pass id. */
const passesInFlight = new Map<string, Promise<unknown>>();

/**
 * One run of each pass at a time in this process: a second caller waits for
 * the first run to finish (however it ends), then runs its own. Two runs of
 * the same pass interleaving slice by slice would only redo each other's
 * work and split the stats.
 */
async function runPassSliced<S>(
  db: Database.Database,
  passId: string,
  factory: PassFactory<S>,
  options: SlicedPassOptions,
): Promise<S> {
  for (let running = passesInFlight.get(passId); running; running = passesInFlight.get(passId)) {
    await running.catch(() => undefined);
  }
  const run = runPassSlicedNow(db, passId, factory, options);
  passesInFlight.set(passId, run);
  try {
    return await run;
  } finally {
    if (passesInFlight.get(passId) === run) passesInFlight.delete(passId);
  }
}

async function runPassSlicedNow<S>(
  db: Database.Database,
  passId: string,
  factory: PassFactory<S>,
  options: SlicedPassOptions,
): Promise<S> {
  const clock = options.clock ?? new SliceClock(NIGHTLY_SLICE);
  const progress = new PassProgress<S>({
    io: options.cursor,
    passId,
    day: options.day,
    minWriteIntervalMs: options.cursorWriteIntervalMs,
  });
  const run = factory(db, clock, progress.resume);
  try {
    await runSliced(db, clock, stepsOf(run.steps), { afterSlice: () => progress.checkpoint(run.position()) });
  } catch (err) {
    progress.flush();
    throw err;
  }
  progress.complete();
  return run.result();
}

/** The same steps in one transaction with no turn: the synchronous exports. */
function runPassUnsliced<S>(db: Database.Database, factory: PassFactory<S>): S {
  const run = factory(db, new SliceClock(UNBOUNDED_SLICE), null);
  runUnsliced(db, stepsOf(run.steps));
  return run.result();
}

function isConstraintError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

/** Run one write; a constraint refusal (its entity or resource was removed mid-pass) is skipped, anything else propagates. */
function writeOrSkip(write: () => void): boolean {
  try {
    write();
    return true;
  } catch (err) {
    if (isConstraintError(err)) return false;
    throw err;
  }
}

function withSkipped<S extends { skipped?: number }>(stats: S, skipped: number): S {
  const out = { ...stats };
  delete out.skipped;
  return skipped > 0 ? { ...out, skipped } : out;
}

// ── deterministic backfill sync ─────────────────────────────────────────

const ACTIVE_FACT_IDS_SQL = 'SELECT id FROM consolidated_facts WHERE active = 1 ORDER BY updated_at DESC LIMIT ?';

const INFERRED_TARGET: InferredTierTarget = Object.freeze({ confidence: 0.55, evidenceEpisodeId: null, evidenceExcerpt: null });

/**
 * One fact at a time, in ascending id: read its text, match it, plan the
 * difference to its inferred tier, then write that difference one row per
 * step. Facts are independent, so the order changes nothing. A fact counts as
 * done (for its stats and for resume) only once all its writes are applied.
 */
function* inferredTierRefreshSteps(
  clock: SliceClock,
  statements: LinkWriteStatements,
  ids: readonly number[],
  after: () => number | null,
  refresh: (factId: number) => { wanted: number[]; matched: number } | null,
  done: (factId: number, matched: number) => void,
  skip: () => void,
): Generator<void, void, undefined> {
  for (const factId of ids) {
    const resumeAfter = after();
    if (resumeAfter !== null && factId <= resumeAfter) continue;
    const plan = refresh(factId);
    const writes = plan ? planInferredTierWrites(statements.readLinks.all(factId) as StoredLinkRow[], plan.wanted, INFERRED_TARGET) : [];
    clock.unit();
    yield;
    const now = new Date().toISOString();
    for (const write of writes) {
      if (!writeOrSkip(() => applyTierWrite(statements, factId, write, INFERRED_TARGET, now))) skip();
      clock.wrote(1);
      yield;
    }
    done(factId, plan?.matched ?? 0);
  }
}

function entityLinkSyncPass(opts: { factLimit?: number; entityLimit?: number }): PassFactory<LinkSyncStats> {
  return (db, clock, resume) => {
    const factLimit = Math.max(1, opts.factLimit ?? 5000);
    const stats: LinkSyncStats = { factsScanned: 0, entitiesConsidered: 0, linksWritten: resume?.stats?.linksWritten ?? 0 };
    let skipped = resume?.stats?.skipped ?? 0;
    let after = typeof resume?.after === 'number' ? resume.after : null;
    let selected = false;
    function* steps(): Generator<void, void, undefined> {
      const ids = (db.prepare(ACTIVE_FACT_IDS_SQL).all(factLimit) as Array<{ id: number }>).map((row) => row.id).sort((a, b) => a - b);
      stats.factsScanned = resume?.stats?.factsScanned ?? ids.length;
      clock.boundary();
      yield;
      const index = entityMatcherIndex(opts.entityLimit ?? 100_000);
      stats.entitiesConsidered = index.matchers.length;
      selected = true;
      clock.boundary();
      yield;
      const readContent = db.prepare('SELECT content FROM consolidated_facts WHERE id = ?');
      yield* inferredTierRefreshSteps(clock, entityLinkStatements(db), ids, () => after, (factId) => {
        const row = readContent.get(factId) as { content: string } | undefined;
        if (!row) return null;
        const matched = row.content ? matchEntityIdsInText(index, row.content) : [];
        const wanted = Array.from(new Set(matched.map((id) => resolveCanonicalEntityIdInDatabase(db, id))));
        return { wanted, matched: matched.length };
      }, (factId, matched) => {
        stats.linksWritten += matched;
        after = factId;
      }, () => { skipped += 1; });
    }
    return {
      steps: steps(),
      position: () => ({ after, partial: null, stats: selected ? withSkipped(stats, skipped) : null }),
      result: () => withSkipped(stats, skipped),
    };
  };
}

function resourceLinkSyncPass(opts: { factLimit?: number; resourceLimit?: number }): PassFactory<LinkSyncStats> {
  return (db, clock, resume) => {
    const factLimit = Math.max(1, opts.factLimit ?? 5000);
    const stats: LinkSyncStats = { factsScanned: 0, entitiesConsidered: 0, linksWritten: resume?.stats?.linksWritten ?? 0 };
    let skipped = resume?.stats?.skipped ?? 0;
    let after = typeof resume?.after === 'number' ? resume.after : null;
    let selected = false;
    function* steps(): Generator<void, void, undefined> {
      const resourceRows = db.prepare(`
        SELECT id, name FROM resource_pointers ORDER BY mention_count DESC, last_seen_at DESC LIMIT ?
      `).all(Math.max(1, opts.resourceLimit ?? 2000)) as Array<{ id: number; name: string }>;
      const matchers = resourceRows
        .map((r) => ({ id: r.id, re: compileWordMatcher((r.name || '').toLowerCase()) }))
        .filter((m): m is { id: number; re: RegExp } => m.re !== null);
      stats.entitiesConsidered = matchers.length;
      clock.boundary();
      yield;
      const ids = (db.prepare(ACTIVE_FACT_IDS_SQL).all(factLimit) as Array<{ id: number }>).map((row) => row.id).sort((a, b) => a - b);
      stats.factsScanned = resume?.stats?.factsScanned ?? ids.length;
      selected = true;
      clock.boundary();
      yield;
      const readContent = db.prepare('SELECT content FROM consolidated_facts WHERE id = ?');
      yield* inferredTierRefreshSteps(clock, resourceLinkStatements(db), ids, () => after, (factId) => {
        const row = readContent.get(factId) as { content: string } | undefined;
        if (!row) return null;
        const lower = (row.content || '').toLowerCase();
        const matched: number[] = [];
        if (lower) for (const m of matchers) if (m.re.test(lower)) matched.push(m.id);
        return { wanted: Array.from(new Set(matched)), matched: matched.length };
      }, (factId, matched) => {
        stats.linksWritten += matched;
        after = factId;
      }, () => { skipped += 1; });
    }
    return {
      steps: steps(),
      position: () => ({ after, partial: null, stats: selected ? withSkipped(stats, skipped) : null }),
      result: () => withSkipped(stats, skipped),
    };
  };
}

/**
 * Persist the graph's word-boundary fact↔entity inference as `inferred_text`
 * candidates over every active fact. Idempotent (rewrites only that tier's
 * difference), so re-running is safe and cannot overwrite grounded links.
 * Bounded so a large vault stays snappy on the nightly tick.
 */
export function syncFactEntityLinks(opts: { factLimit?: number; entityLimit?: number } = {}): LinkSyncStats {
  return runPassUnsliced(openMemoryDb(), entityLinkSyncPass(opts));
}

/** {@link syncFactEntityLinks} in slices, with a turn between slices. */
export async function syncFactEntityLinksAsync(
  opts: { factLimit?: number; entityLimit?: number } & SlicedPassOptions = {},
): Promise<LinkSyncStats> {
  return runPassSliced(openMemoryDb(), LINK_PASS_IDS.entitySync, entityLinkSyncPass(opts), opts);
}

/** Same, for fact↔resource_pointers (word-boundary on the resource name). */
export function syncFactResourceLinks(opts: { factLimit?: number; resourceLimit?: number } = {}): LinkSyncStats {
  return runPassUnsliced(openMemoryDb(), resourceLinkSyncPass(opts));
}

/** {@link syncFactResourceLinks} in slices, with a turn between slices. */
export async function syncFactResourceLinksAsync(
  opts: { factLimit?: number; resourceLimit?: number } & SlicedPassOptions = {},
): Promise<LinkSyncStats> {
  return runPassSliced(openMemoryDb(), LINK_PASS_IDS.resourceSync, resourceLinkSyncPass(opts), opts);
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

interface EntityNameStatements {
  entity: Database.Statement;
  aliases: Database.Statement;
}

const entityNameStatementsByDb = new WeakMap<Database.Database, EntityNameStatements>();

function entityNameStatements(db: Database.Database): EntityNameStatements {
  let statements = entityNameStatementsByDb.get(db);
  if (!statements) {
    statements = {
      entity: db.prepare('SELECT canonical_name, aliases_json FROM entities WHERE id = ?'),
      aliases: db.prepare('SELECT alias FROM entity_aliases WHERE entity_id = ?'),
    };
    entityNameStatementsByDb.set(db, statements);
  }
  return statements;
}

function entityNamesForBackfill(db: Database.Database, entityId: number): string[] {
  const statements = entityNameStatements(db);
  const row = statements.entity.get(entityId) as { canonical_name: string; aliases_json: string } | undefined;
  if (!row) return [];
  const names = new Set<string>([row.canonical_name]);
  try {
    const aliases = JSON.parse(row.aliases_json) as unknown;
    if (Array.isArray(aliases)) for (const alias of aliases) if (typeof alias === 'string') names.add(alias);
  } catch { /* malformed legacy aliases */ }
  for (const alias of statements.aliases.all(entityId) as Array<{ alias: string }>) names.add(alias.alias);
  return Array.from(names)
    .map((name) => name.trim())
    .filter((name) => name.length >= 2 && !name.includes('@') && !GENERIC_BACKFILL_ENTITY_NAMES.has(name.toLowerCase()))
    .sort((a, b) => b.length - a.length);
}

interface EntityGroundingIndex {
  mentions: NamedEntityMentions[];
  nameOwners: Map<string, Set<number>>;
  identifierOwners: Map<string, Set<number>>;
}

function normalizedGroundingName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function buildEntityGroundingIndex(db: Database.Database): EntityGroundingIndex {
  const mentionsById = new Map<number, { id: number; canonicalName: string; names: string[] }>();
  const nameOwners = new Map<string, Set<number>>();
  const identifierOwners = new Map<string, Set<number>>();
  const add = (map: Map<string, Set<number>>, key: string, entityId: number): void => {
    if (!key) return;
    const owners = map.get(key) ?? new Set<number>();
    owners.add(resolveCanonicalEntityIdInDatabase(db, entityId));
    map.set(key, owners);
  };
  for (const row of db.prepare(`
    SELECT e.id, e.canonical_name, e.aliases_json
    FROM entities e
    WHERE NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = e.id)
  `).all() as Array<{ id: number; canonical_name: string; aliases_json: string }>) {
    const names = [row.canonical_name];
    try {
      const aliases: unknown = JSON.parse(row.aliases_json);
      if (Array.isArray(aliases)) names.push(...aliases.filter((x): x is string => typeof x === 'string'));
    } catch { /* malformed legacy aliases */ }
    mentionsById.set(row.id, { id: row.id, canonicalName: row.canonical_name, names });
    for (const name of names) add(nameOwners, normalizedGroundingName(name), row.id);
  }
  for (const row of db.prepare(`
    SELECT ea.entity_id, ea.alias
    FROM entity_aliases ea
    WHERE NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = ea.entity_id)
  `).all() as Array<{ entity_id: number; alias: string }>) {
    add(nameOwners, normalizedGroundingName(row.alias), row.entity_id);
    mentionsById.get(row.entity_id)?.names.push(row.alias);
  }
  for (const row of db.prepare(`
    SELECT ei.entity_id, ei.scheme, ei.value_norm
    FROM entity_identifiers ei
    WHERE ei.scheme IN ('email','domain')
      AND NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = ei.entity_id)
  `).all() as Array<{ entity_id: number; scheme: string; value_norm: string }>) {
    add(identifierOwners, `${row.scheme}:${row.value_norm}`, row.entity_id);
  }
  return { nameOwners, identifierOwners, mentions: [...mentionsById.values()] };
}

/** Test seam: the identity snapshot, name readers and decision helpers the
 * grounding passes use, so a pin can replay the one-statement, per-candidate
 * reference loops against them. */
export function entityGroundingInternalsForTest(): {
  buildEntityGroundingIndex: (db: Database.Database) => EntityGroundingIndex;
  entityNamesForBackfill: (db: Database.Database, entityId: number) => string[];
  maskIdentifierSpans: (text: string) => string;
  buildResourceNameOwners: (db: Database.Database) => Map<string, Set<number>>;
  exactResourceNameMatch: (text: string, name: string) => boolean;
  resourceNameSpecificEnough: (value: string, app?: string, kind?: string) => boolean;
  normalizedResourceGroundingName: (value: string) => string;
  relationshipPredicates: readonly string[];
  explicitlyStatedRelationship: (excerpt: string, subjectNames: string[], objectNames: string[], phrases: readonly string[]) => string | null;
} {
  return {
    buildEntityGroundingIndex,
    entityNamesForBackfill,
    maskIdentifierSpans,
    buildResourceNameOwners,
    exactResourceNameMatch,
    resourceNameSpecificEnough,
    normalizedResourceGroundingName,
    relationshipPredicates: HIGH_PRECISION_BACKFILL_PREDICATES,
    explicitlyStatedRelationship,
  };
}

function exactGroundingNameMatch(text: string, name: string): boolean {
  return compileWordMatcher(normalizedGroundingName(name), 2)?.test(text.toLowerCase()) ?? false;
}

/** {@link exactGroundingNameMatch} against an already-lowercased text, with
 * each name's matcher compiled once per pass instead of once per test. */
function groundingNameMatcher(): (lowerText: string, name: string) => boolean {
  const compiled = new Map<string, RegExp | null>();
  return (lowerText, name) => {
    const key = normalizedGroundingName(name);
    let re = compiled.get(key);
    if (re === undefined) {
      re = compileWordMatcher(key, 2);
      compiled.set(key, re);
    }
    return re?.test(lowerText) ?? false;
  };
}

/** Per-pass memo of a function of an entity id (names, identifiers). A pass
 * reads an identity snapshot; promotions never change names or identifiers. */
function perEntityMemo<T>(read: (entityId: number) => T): (entityId: number) => T {
  const memo = new Map<number, T>();
  return (entityId) => {
    if (memo.has(entityId)) return memo.get(entityId)!;
    const value = read(entityId);
    memo.set(entityId, value);
    return value;
  };
}

function exactIdentifierMatch(text: string, value: string): boolean {
  return exactGroundedIdentifierMatch(text, value);
}

export interface ExtractedFactEntityEvidenceReconciliationStats {
  linksScanned: number;
  evidenceScanned: number;
  repaired: number;
  downgraded: number;
  ambiguous: number;
}

/**
 * Repair legacy `extracted` fact→entity rows that predate mandatory episode
 * provenance. A row remains stored graph truth only when one usable
 * fact-evidence episode deterministically supports the same unique identity in
 * both the canonical fact and its exact persisted excerpt. If no such episode
 * exists—or more than one could be the source—the link is preserved only as an
 * `inferred_text` overlay. We never guess an episode merely to make readiness
 * green.
 */
export function reconcileExtractedFactEntityEvidence(
  opts: { linkLimit?: number } = {},
): ExtractedFactEntityEvidenceReconciliationStats {
  return reconcileExtractedFactEntityEvidenceInDatabase(openMemoryDb(), opts);
}

export function reconcileExtractedFactEntityEvidenceInDatabase(
  db: Database.Database,
  opts: { linkLimit?: number } = {},
): ExtractedFactEntityEvidenceReconciliationStats {
  const linkLimit = Math.max(1, Math.min(100_000, Math.floor(opts.linkLimit ?? 50_000)));
  const rows = db.prepare(`
    SELECT fe.fact_id, fe.entity_id, fe.confidence, fe.evidence_episode_id,
           cf.content, e.entity_type
    FROM fact_entities fe
    JOIN consolidated_facts cf ON cf.id = fe.fact_id
    JOIN entities e ON e.id = fe.entity_id
    WHERE fe.link_type = 'extracted'
      AND (
        fe.evidence_episode_id IS NULL
        OR length(trim(COALESCE(fe.evidence_excerpt, ''))) = 0
      )
    ORDER BY cf.active DESC, cf.updated_at DESC, fe.fact_id DESC, fe.entity_id
    LIMIT ?
  `).all(linkLimit) as Array<{
    fact_id: number;
    entity_id: number;
    confidence: number;
    evidence_episode_id: string | null;
    content: string;
    entity_type: string;
  }>;
  const stats: ExtractedFactEntityEvidenceReconciliationStats = {
    linksScanned: rows.length,
    evidenceScanned: 0,
    repaired: 0,
    downgraded: 0,
    ambiguous: 0,
  };
  if (rows.length === 0) return stats;

  const readEvidence = db.prepare(`
    SELECT fve.episode_id, fve.excerpt,
           COALESCE(fve.source_uri, me.source_uri) AS source_uri
    FROM fact_evidence fve
    JOIN memory_episodes me ON me.id = fve.episode_id
    WHERE fve.fact_id = ?
      AND length(trim(fve.excerpt)) > 0
      AND me.status IN ('available','partial')
    ORDER BY me.occurred_at DESC, fve.ordinal ASC, fve.episode_id
  `);
  const readIdentifiers = db.prepare(`
    SELECT scheme, value_norm FROM entity_identifiers
    WHERE entity_id = ? AND scheme IN ('email','domain')
    ORDER BY confidence DESC
  `);
  const repair = db.prepare(`
    UPDATE fact_entities
    SET evidence_episode_id = ?, evidence_excerpt = ?
    WHERE fact_id = ? AND entity_id = ? AND link_type = 'extracted'
  `);
  const downgrade = db.prepare(`
    UPDATE fact_entities
    SET link_type = 'inferred_text',
        confidence = MIN(confidence, 0.55),
        evidence_episode_id = NULL,
        evidence_excerpt = NULL
    WHERE fact_id = ? AND entity_id = ? AND link_type = 'extracted'
  `);
  const index = buildEntityGroundingIndex(db);

  db.transaction(() => {
    for (const row of rows) {
      const evidence = (readEvidence.all(row.fact_id) as Array<{
        episode_id: string;
        excerpt: string;
        source_uri: string | null;
      }>).filter((item) =>
        row.evidence_episode_id == null || item.episode_id === row.evidence_episode_id);
      stats.evidenceScanned += evidence.length;

      const names = entityNamesForBackfill(db, row.entity_id);
      const strongNames = names.filter((name) => {
        const normalized = normalizedGroundingName(name);
        const specificEnough = row.entity_type === 'person'
          ? normalized.split(' ').length >= 2
          : normalized.length >= 3;
        return specificEnough && (index.nameOwners.get(normalized)?.size ?? 0) === 1;
      });
      const identifiers = readIdentifiers.all(row.entity_id) as Array<{
        scheme: string;
        value_norm: string;
      }>;
      const supporting = evidence.filter((item) => {
        const nameSupported = groundedEntityMentionIds(maskIdentifierSpans(row.content), index.mentions, true).includes(row.entity_id)
          && groundedEntityMentionIds(maskIdentifierSpans(item.excerpt), index.mentions, true).includes(row.entity_id)
          && strongNames.some((name) =>
            exactGroundingNameMatch(row.content, name)
            && exactGroundingNameMatch(item.excerpt, name));
        const identifierSupported = identifiers.some((identifier) =>
          (index.identifierOwners.get(`${identifier.scheme}:${identifier.value_norm}`)?.size ?? 0) === 1
          && exactIdentifierMatch(row.content, identifier.value_norm)
          && exactIdentifierMatch(item.excerpt, identifier.value_norm));
        return nameSupported || identifierSupported;
      });
      const episodes = new Map<string, typeof supporting[number]>();
      for (const item of supporting) {
        if (!episodes.has(item.episode_id)) episodes.set(item.episode_id, item);
      }

      if (episodes.size === 1) {
        const supported = episodes.values().next().value as typeof supporting[number];
        repair.run(
          supported.episode_id,
          supported.excerpt.trim().slice(0, 1_500),
          row.fact_id,
          row.entity_id,
        );
        observeEntityFromEpisodeInDatabase(db, {
          entityId: row.entity_id,
          episodeId: supported.episode_id,
          sourceFactId: row.fact_id,
          sourceUri: supported.source_uri ?? undefined,
          confidence: row.confidence,
          sourceKind: 'fact_backfill',
          incrementMention: false,
        });
        stats.repaired += 1;
        continue;
      }

      if (episodes.size > 1) stats.ambiguous += 1;
      downgrade.run(row.fact_id, row.entity_id);
      stats.downgraded += 1;
    }
  })();
  return stats;
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

interface GroundingEvidence {
  episode_id: string;
  excerpt: string;
  source_uri: string | null;
}

interface GroundingFact {
  id: number;
  content: string;
  confidence: number | null;
  trust_level: number | null;
}

interface EntityCandidate {
  entity_id: number;
  entity_type: string;
}

/** What one fact→entity grounding pass reads once: the identity snapshot, its
 * exact mention prefilter, and per-entity memos (names and identifiers are
 * read once per entity, not once per candidate). */
interface EntityGroundingPass {
  db: Database.Database;
  index: EntityGroundingIndex;
  mentionsFor: (text: string) => NamedEntityMentions[];
  nameMatches: (lowerText: string, name: string) => boolean;
  namesOf: (entityId: number) => string[];
  identifiersOf: (entityId: number) => Array<{ scheme: string; value_norm: string }>;
  readEvidence: Database.Statement;
  readCandidates: Database.Statement;
}

function entityGroundingPass(db: Database.Database, index: EntityGroundingIndex): EntityGroundingPass {
  const readIdentifiers = db.prepare(`
    SELECT scheme, value_norm FROM entity_identifiers
    WHERE entity_id = ? AND scheme IN ('email','domain')
    ORDER BY confidence DESC
  `);
  return {
    db,
    index,
    mentionsFor: groundedMentionPrefilter(index.mentions),
    nameMatches: groundingNameMatcher(),
    namesOf: perEntityMemo((entityId) => entityNamesForBackfill(db, entityId)),
    identifiersOf: perEntityMemo((entityId) =>
      readIdentifiers.all(entityId) as Array<{ scheme: string; value_norm: string }>),
    readEvidence: db.prepare(`
      SELECT fve.episode_id, fve.excerpt, COALESCE(fve.source_uri, me.source_uri) AS source_uri
      FROM fact_evidence fve
      JOIN memory_episodes me ON me.id = fve.episode_id
      WHERE fve.fact_id = ? AND length(trim(fve.excerpt)) > 0
        AND me.status IN ('available','partial')
      ORDER BY me.occurred_at DESC, fve.ordinal ASC
      LIMIT 12
    `),
    readCandidates: db.prepare(`
      SELECT fe.entity_id, e.entity_type
      FROM fact_entities fe
      JOIN entities e ON e.id = fe.entity_id
      WHERE fe.fact_id = ? AND +fe.link_type = 'inferred_text'
        AND NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = e.id)
      ORDER BY e.mention_count DESC, e.id
    `),
  };
}

/** One fact's claim and evidence as the grounding decision sees them. */
interface FactGroundingView {
  fact: GroundingFact;
  contentLower: string;
  evidence: Array<GroundingEvidence & { excerptLower: string; names: Set<number> }>;
  claimNames: Set<number>;
}

function groundedMentionSet(pass: EntityGroundingPass, text: string): Set<number> {
  const masked = maskIdentifierSpans(text);
  return new Set(groundedEntityMentionIds(masked, pass.mentionsFor(masked), true));
}

function viewFactGrounding(pass: EntityGroundingPass, fact: GroundingFact): FactGroundingView {
  const evidence = (pass.readEvidence.all(fact.id) as GroundingEvidence[]).map((item) => ({
    ...item,
    excerptLower: item.excerpt.toLowerCase(),
    names: groundedMentionSet(pass, item.excerpt),
  }));
  return {
    fact,
    contentLower: fact.content.toLowerCase(),
    evidence,
    claimNames: groundedMentionSet(pass, fact.content),
  };
}

type GroundingDecision =
  | { kind: 'promote'; supporting: GroundingEvidence }
  | { kind: 'ambiguous' }
  | { kind: 'ignored' };

function decideEntityCandidate(
  pass: EntityGroundingPass,
  view: FactGroundingView,
  candidate: EntityCandidate,
): GroundingDecision {
  const { index, nameMatches } = pass;
  const names = pass.namesOf(candidate.entity_id);
  const strongNames = names.filter((name) => {
    const normalized = normalizedGroundingName(name);
    const specificEnough = candidate.entity_type === 'person'
      ? normalized.split(' ').length >= 2
      : normalized.length >= 3;
    return specificEnough && (index.nameOwners.get(normalized)?.size ?? 0) === 1;
  });
  const identifiers = pass.identifiersOf(candidate.entity_id);
  for (const item of view.evidence) {
    const nameSupported = view.claimNames.has(candidate.entity_id)
      && item.names.has(candidate.entity_id)
      && strongNames.some((name) =>
        nameMatches(view.contentLower, name) && nameMatches(item.excerptLower, name));
    const identifierSupported = identifiers.some((identifier) =>
      (index.identifierOwners.get(`${identifier.scheme}:${identifier.value_norm}`)?.size ?? 0) === 1
      && exactIdentifierMatch(view.fact.content, identifier.value_norm)
      && exactIdentifierMatch(item.excerpt, identifier.value_norm));
    if (nameSupported || identifierSupported) {
      return { kind: 'promote', supporting: { episode_id: item.episode_id, excerpt: item.excerpt, source_uri: item.source_uri } };
    }
  }
  const weakOrSharedMatch = names.some((name) =>
    nameMatches(view.contentLower, name)
    && view.evidence.some((item) => nameMatches(item.excerptLower, name)));
  return weakOrSharedMatch ? { kind: 'ambiguous' } : { kind: 'ignored' };
}

function promoteEntityCandidate(
  db: Database.Database,
  fact: GroundingFact,
  entityId: number,
  supporting: GroundingEvidence,
): void {
  addFactEntityLinksInDatabase(db, fact.id, [entityId], {
    linkType: 'extracted',
    confidence: fact.confidence ?? fact.trust_level ?? 0.7,
    evidenceEpisodeId: supporting.episode_id,
    evidenceExcerpt: supporting.excerpt,
    sourceUri: supporting.source_uri ?? undefined,
    sourceKind: 'fact_backfill',
    incrementMention: false,
  });
}

// ── grounded backfills: paged selection, then one fact / candidate per step ─

interface GroundingSelectionRow {
  id: number;
  active: number;
  updated_at: string;
}

/** The backfills' processing order: active first, newest first, highest id first. */
const GROUNDING_ORDER: ReadonlyArray<1 | -1> = [-1, -1, -1];
const SELECTION_PAGE_IDS = 250;

function groundingKey(row: GroundingSelectionRow): [number, string, number] {
  return [row.active, row.updated_at, row.id];
}

/**
 * Facts with an inferred link and usable evidence, read one id range per
 * slice, then ordered (active, updated_at, id, all descending) and limited in
 * memory: the same facts in the same order as one ORDER BY … LIMIT statement,
 * without one statement scanning every fact. Processing keeps this order, so
 * when two facts promote the same identity from one shared episode the same
 * fact names the observation.
 */
function* selectGroundingFacts(
  db: Database.Database,
  linkTable: 'fact_entities' | 'fact_resources',
  factLimit: number,
  clock: SliceClock,
): Generator<void, GroundingSelectionRow[], undefined> {
  const alias = linkTable === 'fact_entities' ? 'fe' : 'fr';
  const maxId = (db.prepare('SELECT MAX(id) AS id FROM consolidated_facts').get() as { id: number | null }).id ?? 0;
  const page = db.prepare(`
    SELECT cf.id, cf.active, cf.updated_at
    FROM consolidated_facts cf
    WHERE cf.id > ? AND cf.id <= ?
      AND EXISTS (
        SELECT 1 FROM ${linkTable} ${alias}
        WHERE ${alias}.fact_id = cf.id AND +${alias}.link_type = 'inferred_text'
      )
      AND EXISTS (
        SELECT 1 FROM fact_evidence fve
        JOIN memory_episodes me ON me.id = fve.episode_id
        WHERE fve.fact_id = cf.id AND length(trim(fve.excerpt)) > 0
          AND me.status IN ('available','partial')
      )
  `);
  const rows: GroundingSelectionRow[] = [];
  for (let from = 0; from < maxId; from += SELECTION_PAGE_IDS) {
    for (const row of page.all(from, from + SELECTION_PAGE_IDS) as GroundingSelectionRow[]) rows.push(row);
    clock.unit();
    clock.boundary();
    yield;
  }
  rows.sort((a, b) => comparePassKeys(groundingKey(a), groundingKey(b), GROUNDING_ORDER));
  return rows.slice(0, factLimit);
}

interface GroundingBackfillHandlers<C> {
  readFact: (factId: number) => GroundingFact | undefined;
  /** Read one fact's evidence and candidates and prepare its decisions. */
  open: (fact: GroundingFact) => { evidenceScanned: number; candidates: C[]; decide: (candidate: C) => GroundingDecision };
  candidateId: (candidate: C) => number;
  promote: (fact: GroundingFact, candidate: C, supporting: GroundingEvidence) => void;
}

type GroundingBackfillStats = GroundedFactEntityBackfillStats;

/**
 * A grounding backfill as steps: the paged selection (a slice per page), the
 * pass's setup (a slice per index), then per fact one step to open it and one
 * step per candidate. A fact is done once every candidate is decided; the
 * candidates decided so far in the fact in progress are recorded too, so a
 * resumed attempt neither re-counts nor re-decides them.
 */
function groundingBackfillPass<C>(
  linkTable: 'fact_entities' | 'fact_resources',
  opts: { factLimit?: number },
  setup: (db: Database.Database, clock: SliceClock) => Generator<void, GroundingBackfillHandlers<C>, undefined>,
): PassFactory<GroundingBackfillStats> {
  return (db, clock, resume) => {
    const factLimit = Math.max(1, Math.min(50_000, Math.floor(opts.factLimit ?? 5_000)));
    const earlier = resume?.stats ?? null;
    const stats: GroundingBackfillStats = {
      factsScanned: 0,
      evidenceScanned: earlier?.evidenceScanned ?? 0,
      candidates: earlier?.candidates ?? 0,
      promoted: earlier?.promoted ?? 0,
      ambiguous: earlier?.ambiguous ?? 0,
      ignored: earlier?.ignored ?? 0,
    };
    let skipped = earlier?.skipped ?? 0;
    let after: PassCursorKey | null = resume?.after ?? null;
    const resumedUnit = resume?.partial ?? null;
    let partial: PassPartialUnit | null = null;
    let selected = false;
    function* steps(): Generator<void, void, undefined> {
      const chosen = yield* selectGroundingFacts(db, linkTable, factLimit, clock);
      // A resumed attempt reports the facts the day's first selection found:
      // facts whose every candidate was promoted since are not selected again.
      stats.factsScanned = earlier?.factsScanned ?? chosen.length;
      selected = true;
      const handlers = yield* setup(db, clock);
      for (const selected of chosen) {
        const key = groundingKey(selected);
        if (after !== null && comparePassKeys(key, after, GROUNDING_ORDER) <= 0) continue;
        const fact = handlers.readFact(selected.id);
        if (!fact) {
          after = key;
          continue;
        }
        const continuing = resumedUnit !== null && comparePassKeys(resumedUnit.key, key) === 0;
        const opened = handlers.open(fact);
        if (!continuing) stats.evidenceScanned += opened.evidenceScanned;
        const decided = new Set(continuing ? resumedUnit.done : []);
        partial = { key, done: [...decided] };
        clock.unit();
        yield;
        for (const candidate of opened.candidates) {
          const candidateId = handlers.candidateId(candidate);
          if (decided.has(candidateId)) continue;
          stats.candidates += 1;
          const decision = opened.decide(candidate);
          if (decision.kind === 'ambiguous') stats.ambiguous += 1;
          else if (decision.kind === 'ignored') stats.ignored += 1;
          else if (writeOrSkip(() => handlers.promote(fact, candidate, decision.supporting))) {
            stats.promoted += 1;
            clock.wrote(1);
          } else skipped += 1;
          partial.done.push(candidateId);
          clock.unit();
          yield;
        }
        after = key;
        partial = null;
      }
    }
    return {
      steps: steps(),
      position: () => ({
        after,
        partial: partial ? { key: partial.key, done: [...partial.done] } : null,
        stats: selected ? withSkipped(stats, skipped) : null,
      }),
      result: () => withSkipped(stats, skipped),
    };
  };
}

function* entityGroundingSetup(
  db: Database.Database,
  clock: SliceClock,
): Generator<void, GroundingBackfillHandlers<EntityCandidate>, undefined> {
  const index = buildEntityGroundingIndex(db);
  clock.boundary();
  yield;
  const pass = entityGroundingPass(db, index);
  clock.boundary();
  yield;
  const readFact = db.prepare('SELECT id, content, confidence, trust_level FROM consolidated_facts WHERE id = ?');
  return {
    readFact: (factId) => readFact.get(factId) as GroundingFact | undefined,
    open: (fact) => {
      const view = viewFactGrounding(pass, fact);
      const candidates = pass.readCandidates.all(fact.id) as EntityCandidate[];
      return { evidenceScanned: view.evidence.length, candidates, decide: (candidate) => decideEntityCandidate(pass, view, candidate) };
    },
    candidateId: (candidate) => candidate.entity_id,
    promote: (fact, candidate, supporting) => promoteEntityCandidate(db, fact, candidate.entity_id, supporting),
  };
}

function entityGroundingBackfillPass(opts: { factLimit?: number }): PassFactory<GroundedFactEntityBackfillStats> {
  return groundingBackfillPass('fact_entities', opts, entityGroundingSetup);
}

export function backfillGroundedFactEntityLinksInDatabase(
  db: Database.Database,
  opts: { factLimit?: number } = {},
): GroundedFactEntityBackfillStats {
  return runPassUnsliced(db, entityGroundingBackfillPass(opts));
}

/** {@link backfillGroundedFactEntityLinks} in slices, with a turn between slices. */
export async function backfillGroundedFactEntityLinksAsync(
  opts: { factLimit?: number } & SlicedPassOptions = {},
): Promise<GroundedFactEntityBackfillStats> {
  return runPassSliced(openMemoryDb(), LINK_PASS_IDS.entityBackfill, entityGroundingBackfillPass(opts), opts);
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

interface ResourceCandidate {
  resource_id: number;
  app: string;
  kind: string;
  name: string;
}

function decideResourceCandidate(
  owners: Map<string, Set<number>>,
  fact: GroundingFact,
  evidence: ReadonlyArray<{ episode_id: string; excerpt: string }>,
  candidate: ResourceCandidate,
): GroundingDecision {
  const factMatch = exactResourceNameMatch(fact.content, candidate.name);
  const supporting = factMatch
    ? evidence.find((item) => exactResourceNameMatch(item.excerpt, candidate.name))
    : undefined;
  if (!factMatch || !supporting || !resourceNameSpecificEnough(candidate.name, candidate.app, candidate.kind)) {
    return { kind: 'ignored' };
  }
  if ((owners.get(normalizedResourceGroundingName(candidate.name))?.size ?? 0) !== 1) return { kind: 'ambiguous' };
  return { kind: 'promote', supporting: { episode_id: supporting.episode_id, excerpt: supporting.excerpt, source_uri: null } };
}

function* resourceGroundingSetup(
  db: Database.Database,
  clock: SliceClock,
): Generator<void, GroundingBackfillHandlers<ResourceCandidate>, undefined> {
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
    WHERE fr.fact_id = ? AND +fr.link_type = 'inferred_text'
    ORDER BY rp.mention_count DESC, rp.id ASC
  `);
  const readFact = db.prepare('SELECT id, content, confidence, trust_level FROM consolidated_facts WHERE id = ?');
  const owners = buildResourceNameOwners(db);
  clock.boundary();
  yield;
  return {
    readFact: (factId) => readFact.get(factId) as GroundingFact | undefined,
    open: (fact) => {
      const evidence = readEvidence.all(fact.id) as Array<{ episode_id: string; excerpt: string }>;
      const candidates = readCandidates.all(fact.id) as ResourceCandidate[];
      return { evidenceScanned: evidence.length, candidates, decide: (candidate) => decideResourceCandidate(owners, fact, evidence, candidate) };
    },
    candidateId: (candidate) => candidate.resource_id,
    promote: (fact, candidate, supporting) => addFactResourceLinksInDatabase(db, fact.id, [candidate.resource_id], {
      linkType: 'extracted',
      confidence: fact.confidence ?? fact.trust_level ?? 0.7,
      evidenceEpisodeId: supporting.episode_id,
      evidenceExcerpt: supporting.excerpt,
    }),
  };
}

function resourceGroundingBackfillPass(opts: { factLimit?: number }): PassFactory<GroundedFactResourceBackfillStats> {
  return groundingBackfillPass('fact_resources', opts, resourceGroundingSetup);
}

export function backfillGroundedFactResourceLinksInDatabase(
  db: Database.Database,
  opts: { factLimit?: number } = {},
): GroundedFactResourceBackfillStats {
  return runPassUnsliced(db, resourceGroundingBackfillPass(opts));
}

/** {@link backfillGroundedFactResourceLinks} in slices, with a turn between slices. */
export async function backfillGroundedFactResourceLinksAsync(
  opts: { factLimit?: number } & SlicedPassOptions = {},
): Promise<GroundedFactResourceBackfillStats> {
  return runPassSliced(openMemoryDb(), LINK_PASS_IDS.resourceBackfill, resourceGroundingBackfillPass(opts), opts);
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

interface RelationshipEvidenceRow {
  fact_id: number;
  updated_at: string;
  confidence: number | null;
  trust_level: number | null;
  valid_from: string | null;
  valid_to: string | null;
  episode_id: string;
  excerpt: string;
  source_uri: string | null;
  ordinal: number;
}

/**
 * The relationship pass's order: newest fact first, then evidence ordinal.
 * Rows that tie on both (possible only for evidence rows sharing an ordinal)
 * are ordered by fact id, then episode id, so the order is total and a resume
 * key is exact.
 */
const RELATIONSHIP_ORDER: ReadonlyArray<1 | -1> = [-1, 1, 1, 1];

function relationshipKey(row: RelationshipEvidenceRow): [string, number, number, string] {
  return [row.updated_at, row.ordinal, row.fact_id, row.episode_id];
}

/** Record every relationship one evidence row states directly. Returns the rows it wrote (about three per edge). */
function recordRelationshipsFromEvidence(
  db: Database.Database,
  row: RelationshipEvidenceRow,
  names: Map<number, string[]>,
  stats: EntityRelationshipBackfillStats,
  skip: () => void,
): number {
  const excerptLower = row.excerpt.toLowerCase();
  const phrases = HIGH_PRECISION_BACKFILL_PREDICATES.filter((phrase) => excerptLower.includes(phrase));
  if (phrases.length === 0) return 0;
  const ids = getEntityIdsForFact(row.fact_id).slice(0, 12);
  for (const id of ids) if (!names.has(id)) names.set(id, entityNamesForBackfill(db, id));
  const emitted = new Set<string>();
  let writes = 0;
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
      let result: EntityRelationshipResult | undefined;
      const recorded = writeOrSkip(() => {
        result = recordGroundedEntityRelationship({
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
      });
      if (!recorded || !result) {
        skip();
        continue;
      }
      if (result.outcome === 'add') stats.added += 1;
      else if (result.outcome === 'reinforce' || result.outcome === 'supersede') stats.reinforced += 1;
      else stats.ignored += 1;
      if (result.outcome !== 'ignore') writes += 3;
    }
  }
  return writes;
}

/**
 * Evidence rows of active facts with at least two links, one id range per
 * slice, then the pass order and the row limit in memory. "At least two
 * links" stops at the second link instead of counting every link. The
 * CROSS JOINs and `+cf.active` keep each page a primary-key range of facts,
 * rather than a walk of every active fact or every usable episode.
 */
function* selectRelationshipEvidence(
  db: Database.Database,
  limit: number,
  clock: SliceClock,
): Generator<void, RelationshipEvidenceRow[], undefined> {
  const maxId = (db.prepare('SELECT MAX(id) AS id FROM consolidated_facts').get() as { id: number | null }).id ?? 0;
  const page = db.prepare(`
    SELECT cf.id AS fact_id, cf.updated_at, cf.confidence, cf.trust_level, cf.valid_from, cf.valid_to,
           fe.episode_id, fe.excerpt, fe.source_uri, fe.ordinal
    FROM consolidated_facts cf
    CROSS JOIN fact_evidence fe ON fe.fact_id = cf.id AND length(trim(fe.excerpt)) > 0
    CROSS JOIN memory_episodes me ON me.id = fe.episode_id AND me.status IN ('available','partial')
    WHERE cf.id > ? AND cf.id <= ? AND +cf.active = 1
      AND EXISTS (SELECT 1 FROM fact_entities link WHERE link.fact_id = cf.id LIMIT 1 OFFSET 1)
  `);
  const rows: RelationshipEvidenceRow[] = [];
  for (let from = 0; from < maxId; from += SELECTION_PAGE_IDS) {
    for (const row of page.all(from, from + SELECTION_PAGE_IDS) as RelationshipEvidenceRow[]) rows.push(row);
    clock.unit();
    clock.boundary();
    yield;
  }
  rows.sort((a, b) => comparePassKeys(relationshipKey(a), relationshipKey(b), RELATIONSHIP_ORDER));
  return rows.slice(0, limit);
}

/** Test seam: the paged selections, drained at once, to hold against the one-statement selections. */
export function linkPassSelectionsForTest(db: Database.Database): {
  groundingFactIds: (linkTable: 'fact_entities' | 'fact_resources', factLimit: number) => number[];
  relationshipRows: (limit: number) => string[];
} {
  const drain = <T>(steps: Generator<void, T, undefined>): T => {
    for (;;) {
      const next = steps.next();
      if (next.done) return next.value;
    }
  };
  const clock = new SliceClock(UNBOUNDED_SLICE);
  return {
    groundingFactIds: (linkTable, factLimit) => drain(selectGroundingFacts(db, linkTable, factLimit, clock)).map((row) => row.id),
    relationshipRows: (limit) => drain(selectRelationshipEvidence(db, limit, clock)).map((row) => `${row.fact_id}:${row.episode_id}`),
  };
}

function relationshipBackfillPass(opts: { factLimit?: number }): PassFactory<EntityRelationshipBackfillStats> {
  return (db, clock, resume) => {
    const limit = Math.max(1, opts.factLimit ?? 5_000);
    const earlier = resume?.stats ?? null;
    const stats: EntityRelationshipBackfillStats = {
      factsScanned: 0,
      evidenceScanned: 0,
      candidates: earlier?.candidates ?? 0,
      added: earlier?.added ?? 0,
      reinforced: earlier?.reinforced ?? 0,
      ignored: earlier?.ignored ?? 0,
    };
    let skipped = earlier?.skipped ?? 0;
    let after: PassCursorKey | null = resume?.after ?? null;
    let selected = false;
    function* steps(): Generator<void, void, undefined> {
      const chosen = yield* selectRelationshipEvidence(db, limit, clock);
      stats.factsScanned = earlier?.factsScanned ?? new Set(chosen.map((row) => row.fact_id)).size;
      stats.evidenceScanned = earlier?.evidenceScanned ?? chosen.length;
      selected = true;
      const names = new Map<number, string[]>();
      for (const row of chosen) {
        const key = relationshipKey(row);
        if (after !== null && comparePassKeys(key, after, RELATIONSHIP_ORDER) <= 0) continue;
        const writes = recordRelationshipsFromEvidence(db, row, names, stats, () => { skipped += 1; });
        after = key;
        clock.unit();
        clock.wrote(writes);
        yield;
      }
    }
    return {
      steps: steps(),
      position: () => ({ after, partial: null, stats: selected ? withSkipped(stats, skipped) : null }),
      result: () => withSkipped(stats, skipped),
    };
  };
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
  return runPassUnsliced(openMemoryDb(), relationshipBackfillPass(opts));
}

/** {@link backfillGroundedEntityRelationships} in slices, with a turn between slices. */
export async function backfillGroundedEntityRelationshipsAsync(
  opts: { factLimit?: number } & SlicedPassOptions = {},
): Promise<EntityRelationshipBackfillStats> {
  return runPassSliced(openMemoryDb(), LINK_PASS_IDS.relationships, relationshipBackfillPass(opts), opts);
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

/**
 * {@link reconcileMemoryRelationships} with every pass in slices and a turn
 * between steps, so a request that runs it never holds the loop for the
 * whole reconciliation. Same steps, same order, same report.
 *
 * `backup` takes the rollback point; by default the synchronous backup. A
 * caller that has an off-thread backup passes it here.
 */
export async function reconcileMemoryRelationshipsAsync(opts: {
  factLimit?: number;
  requireBackup?: boolean;
  backup?: () => BackupResult | null | Promise<BackupResult | null>;
  clock?: SliceClock;
} = {}): Promise<MemoryRelationshipReconciliationReport> {
  const started = Date.now();
  const clock = opts.clock ?? new SliceClock(NIGHTLY_SLICE);
  const before = readEntityRelationshipHealth();
  await clock.next(true);
  const takeBackup = opts.backup ?? (() => backupMemoryDb({ retain: 14 }));
  const backup = opts.requireBackup === false ? null : await takeBackup();
  if (opts.requireBackup !== false && !backup) {
    throw new Error('relationship reconciliation requires a successful memory backup');
  }
  await clock.next(true);
  const factLimit = Math.max(1, Math.min(50_000, Math.floor(opts.factLimit ?? 5_000)));
  const identities = autoReconcileStrongEntityIdentifiers(500);
  await clock.next(true);
  const factEntityLinks = await syncFactEntityLinksAsync({ factLimit, clock });
  const groundedFactEntityLinks = await backfillGroundedFactEntityLinksAsync({ factLimit, clock });
  const factResourceLinks = await syncFactResourceLinksAsync({ factLimit, clock });
  const groundedFactResourceLinks = await backfillGroundedFactResourceLinksAsync({ factLimit, clock });
  const relationships = await backfillGroundedEntityRelationshipsAsync({ factLimit, clock });
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
