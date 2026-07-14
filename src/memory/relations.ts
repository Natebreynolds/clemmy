import { openMemoryDb } from './db.js';
import { compileWordMatcher } from './word-match.js';

/**
 * Stored relationship layer (WS2). The graph used to RE-DERIVE every
 * fact↔entity / fact↔resource edge at render time by substring matching, and
 * entity↔entity relationships were never captured at all — so recall could not
 * traverse "what do I know about entity X". These helpers persist the edges
 * (migration v13: fact_entities / fact_resources / entity_edges) so the graph
 * renders stored truth and recall can traverse.
 *
 * Two population sources:
 *   1. {@link syncFactEntityLinks} / {@link syncFactResourceLinks} — a
 *      DETERMINISTIC word-boundary backfill over every active fact (the nightly
 *      maintenance tick + callable). Covers the whole history, same precision
 *      as the graph's word-boundary matcher but stored + queryable.
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
}

export interface LinkSyncStats {
  factsScanned: number;
  entitiesConsidered: number;
  linksWritten: number;
}

// ── fact ↔ entity links ────────────────────────────────────────────────

/** Replace the stored entity links for a fact (idempotent). */
export function setFactEntityLinks(factId: number, entityIds: number[]): void {
  const db = openMemoryDb();
  const now = new Date().toISOString();
  const unique = Array.from(new Set(entityIds.filter((n) => Number.isInteger(n) && n > 0)));
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM fact_entities WHERE fact_id = ?').run(factId);
    const ins = db.prepare('INSERT OR IGNORE INTO fact_entities (fact_id, entity_id, created_at) VALUES (?,?,?)');
    for (const eid of unique) ins.run(factId, eid, now);
  });
  tx();
}

export function getEntityIdsForFact(factId: number): number[] {
  const db = openMemoryDb();
  return (db.prepare('SELECT entity_id FROM fact_entities WHERE fact_id = ?').all(factId) as { entity_id: number }[])
    .map((r) => r.entity_id);
}

/** Fact ids linked to an entity, newest fact first. Backs entity→facts recall. */
export function getFactIdsForEntity(entityId: number, limit = 50, asOf?: string): number[] {
  const db = openMemoryDb();
  const rows = asOf ? db.prepare(`
    SELECT fe.fact_id AS id
    FROM fact_entities fe
    JOIN consolidated_facts cf ON cf.id = fe.fact_id
    WHERE fe.entity_id = ?
      AND (cf.valid_from IS NULL OR cf.valid_from <= ?)
      AND (cf.valid_to IS NULL OR cf.valid_to > ?)
    ORDER BY cf.updated_at DESC
    LIMIT ?
  `).all(entityId, asOf, asOf, Math.max(1, limit)) : db.prepare(`
    SELECT fe.fact_id AS id
    FROM fact_entities fe
    JOIN consolidated_facts cf ON cf.id = fe.fact_id
    WHERE fe.entity_id = ? AND cf.active = 1
    ORDER BY cf.updated_at DESC
    LIMIT ?
  `).all(entityId, Math.max(1, limit));
  return (rows as { id: number }[]).map((r) => r.id);
}

/** Stored fact→entity edges for a set of facts — consumed by the graph builder. */
export function loadFactEntityEdges(factIds: number[]): Array<{ factId: number; entityId: number }> {
  if (factIds.length === 0) return [];
  const db = openMemoryDb();
  const ph = factIds.map(() => '?').join(',');
  return (db.prepare(`SELECT fact_id, entity_id FROM fact_entities WHERE fact_id IN (${ph})`).all(...factIds) as { fact_id: number; entity_id: number }[])
    .map((r) => ({ factId: r.fact_id, entityId: r.entity_id }));
}

// ── fact ↔ resource links ──────────────────────────────────────────────

export function setFactResourceLinks(factId: number, resourceIds: number[]): void {
  const db = openMemoryDb();
  const now = new Date().toISOString();
  const unique = Array.from(new Set(resourceIds.filter((n) => Number.isInteger(n) && n > 0)));
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM fact_resources WHERE fact_id = ?').run(factId);
    const ins = db.prepare('INSERT OR IGNORE INTO fact_resources (fact_id, resource_id, created_at) VALUES (?,?,?)');
    for (const rid of unique) ins.run(factId, rid, now);
  });
  tx();
}

export function loadFactResourceEdges(factIds: number[]): Array<{ factId: number; resourceId: number }> {
  if (factIds.length === 0) return [];
  const db = openMemoryDb();
  const ph = factIds.map(() => '?').join(',');
  return (db.prepare(`SELECT fact_id, resource_id FROM fact_resources WHERE fact_id IN (${ph})`).all(...factIds) as { fact_id: number; resource_id: number }[])
    .map((r) => ({ factId: r.fact_id, resourceId: r.resource_id }));
}

export function getFactIdsForResource(resourceId: number, limit = 50, asOf?: string): number[] {
  const db = openMemoryDb();
  const rows = asOf ? db.prepare(`
    SELECT fr.fact_id AS id
    FROM fact_resources fr
    JOIN consolidated_facts cf ON cf.id = fr.fact_id
    WHERE fr.resource_id = ?
      AND (cf.valid_from IS NULL OR cf.valid_from <= ?)
      AND (cf.valid_to IS NULL OR cf.valid_to > ?)
    ORDER BY cf.updated_at DESC
    LIMIT ?
  `).all(resourceId, asOf, asOf, Math.max(1, limit)) : db.prepare(`
    SELECT fr.fact_id AS id
    FROM fact_resources fr
    JOIN consolidated_facts cf ON cf.id = fr.fact_id
    WHERE fr.resource_id = ? AND cf.active = 1
    ORDER BY cf.updated_at DESC
    LIMIT ?
  `).all(resourceId, Math.max(1, limit));
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
  const placeholders = entityIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT subject_id, object_id
    FROM entity_edges
    WHERE (invalidated_at IS NULL OR invalidated_at > ?)
      AND (valid_from IS NULL OR valid_from <= ?)
      AND (valid_to IS NULL OR valid_to > ?)
      AND (subject_id IN (${placeholders}) OR object_id IN (${placeholders}))
    ORDER BY recurrence_count DESC, last_seen_at DESC
    LIMIT ?
  `).all(asOf, asOf, asOf, ...entityIds, ...entityIds, Math.max(1, limit)) as Array<{ subject_id: number; object_id: number }>;
  const seeds = new Set(entityIds);
  const out = new Set<number>();
  for (const row of rows) {
    if (!seeds.has(row.subject_id)) out.add(row.subject_id);
    if (!seeds.has(row.object_id)) out.add(row.object_id);
  }
  return Array.from(out);
}

// ── entity ↔ entity edges ──────────────────────────────────────────────

/** Upsert a subject-predicate-object relation; reinforces recurrence + recency. */
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
  if (!predicate || input.subjectId === input.objectId) return;
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
    input.subjectId,
    predicate,
    input.objectId,
    now,
    now,
    Math.max(0, Math.min(1, input.confidence ?? 0.7)),
    input.evidenceEpisodeId ?? null,
    input.validFrom ?? now,
    input.validTo ?? null,
  );
}

/** All entity edges (strongest/most-recent first) — consumed by the graph. */
export function loadEntityEdges(limit = 300, asOf = new Date().toISOString()): EntityEdgeRow[] {
  const db = openMemoryDb();
  return (db.prepare(`
    SELECT subject_id, predicate, object_id, recurrence_count, last_seen_at,
           confidence, evidence_episode_id, valid_from, valid_to
    FROM entity_edges
    WHERE (invalidated_at IS NULL OR invalidated_at > ?)
      AND (valid_from IS NULL OR valid_from <= ?)
      AND (valid_to IS NULL OR valid_to > ?)
    ORDER BY recurrence_count DESC, last_seen_at DESC
    LIMIT ?
  `).all(asOf, asOf, asOf, Math.max(1, limit)) as Array<{
    subject_id: number; predicate: string; object_id: number; recurrence_count: number; last_seen_at: string;
    confidence: number; evidence_episode_id: string | null; valid_from: string | null; valid_to: string | null;
  }>).map((r) => ({
    subjectId: r.subject_id,
    predicate: r.predicate,
    objectId: r.object_id,
    recurrenceCount: r.recurrence_count,
    lastSeenAt: r.last_seen_at,
    confidence: r.confidence,
    evidenceEpisodeId: r.evidence_episode_id,
    validFrom: r.valid_from,
    validTo: r.valid_to,
  }));
}

// ── entity recall (resolve a free-text objective → entities) ────────────

interface EntityMatcher { id: number; res: RegExp[] }

/** Compile word-boundary matchers for every entity (canonical name + aliases). */
function entityMatchers(limit = 2000): EntityMatcher[] {
  const db = openMemoryDb();
  const rows = db.prepare(`
    SELECT id, canonical_name_lc, aliases_json
    FROM entities
    ORDER BY mention_count DESC, last_seen_at DESC
    LIMIT ?
  `).all(Math.max(1, limit)) as Array<{ id: number; canonical_name_lc: string; aliases_json: string | null }>;
  const out: EntityMatcher[] = [];
  for (const r of rows) {
    const names = new Set<string>();
    if (r.canonical_name_lc) names.add(r.canonical_name_lc);
    try {
      const aliases = r.aliases_json ? JSON.parse(r.aliases_json) : [];
      if (Array.isArray(aliases)) for (const a of aliases) {
        const al = String(a || '').trim().toLowerCase();
        if (al) names.add(al);
      }
    } catch { /* malformed aliases — skip */ }
    const res = Array.from(names).map((n) => compileWordMatcher(n)).filter((re): re is RegExp => re !== null);
    if (res.length > 0) out.push({ id: r.id, res });
  }
  return out;
}

/** Entity ids whose canonical name / alias appears (word-boundary) in `text`. */
export function resolveEntityIdsForText(text: string, limit = 8): number[] {
  const lower = (text || '').toLowerCase();
  if (!lower.trim()) return [];
  const matched: number[] = [];
  for (const m of entityMatchers()) {
    if (m.res.some((re) => re.test(lower))) matched.push(m.id);
    if (matched.length >= limit) break;
  }
  return matched;
}

// ── deterministic backfill sync ─────────────────────────────────────────

/**
 * Promote the graph's word-boundary fact↔entity inference to STORED edges over
 * every active fact. Idempotent (replaces each fact's links), so re-running is
 * safe. Bounded so a large vault stays snappy on the nightly tick.
 */
export function syncFactEntityLinks(opts: { factLimit?: number; entityLimit?: number } = {}): LinkSyncStats {
  const factLimit = Math.max(1, opts.factLimit ?? 5000);
  const db = openMemoryDb();
  const matchers = entityMatchers(opts.entityLimit ?? 2000);
  const facts = db.prepare(`
    SELECT id, content FROM consolidated_facts WHERE active = 1 ORDER BY updated_at DESC LIMIT ?
  `).all(factLimit) as Array<{ id: number; content: string }>;
  let linksWritten = 0;
  const tx = db.transaction(() => {
    for (const f of facts) {
      const lower = (f.content || '').toLowerCase();
      const ids: number[] = [];
      if (lower) for (const m of matchers) if (m.res.some((re) => re.test(lower))) ids.push(m.id);
      setFactEntityLinks(f.id, ids);
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
      setFactResourceLinks(f.id, ids);
      linksWritten += ids.length;
    }
  });
  tx();
  return { factsScanned: facts.length, entitiesConsidered: matchers.length, linksWritten };
}
