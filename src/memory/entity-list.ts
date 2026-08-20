/**
 * Entity listing — the "who does Clem know" query, extracted to one canonical
 * home so every surface (desktop console, mobile) ranks and filters people,
 * companies and projects identically. Mirrors the console route's semantics:
 * redirected (merged-away) entities are invisible, grounded facts outrank
 * inferred mentions, and the free-text filter matches canonical names and
 * aliases.
 */
import { openMemoryDb } from './db.js';

export interface EntityListItem {
  id: number;
  entityType: string;
  canonicalName: string;
  aliases: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  mentionCount: number;
  factCount: number;
  groundedFactCount: number;
  inferredFactCount: number;
  identifierCount: number;
  observationCount: number;
}

export interface EntityListResult {
  entities: EntityListItem[];
  total: number;
  allTotal: number;
  redirectedTotal: number;
}

const ALLOWED_TYPES = new Set(['person', 'company', 'project', 'place', 'thing']);

export function listEntities(options?: {
  type?: string;
  q?: string;
  limit?: number;
}): EntityListResult {
  const db = openMemoryDb();
  const typeParam = options?.type && ALLOWED_TYPES.has(options.type) ? options.type : '';
  const query = (options?.q ?? '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(1_000, options?.limit ?? 400));
  const where = `
    NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = e.id)
    AND (? = '' OR e.entity_type = ?)
    AND (
      ? = ''
      OR instr(e.canonical_name_lc, ?) > 0
      OR EXISTS (
        SELECT 1 FROM entity_aliases ea
        WHERE ea.entity_id = e.id AND instr(ea.alias_lc, ?) > 0
      )
    )`;
  const filterArgs = [typeParam, typeParam, query, query, query];
  const rows = db.prepare(`SELECT e.*,
        (SELECT COUNT(*) FROM fact_entities fe WHERE fe.entity_id = e.id) AS fact_count,
        (SELECT COUNT(*) FROM fact_entities fe
          WHERE fe.entity_id = e.id AND fe.link_type <> 'inferred_text') AS grounded_fact_count,
        (SELECT COUNT(*) FROM fact_entities fe
          WHERE fe.entity_id = e.id AND fe.link_type = 'inferred_text') AS inferred_fact_count,
        (SELECT COUNT(*) FROM entity_identifiers ei WHERE ei.entity_id = e.id) AS identifier_count,
        (SELECT COUNT(*) FROM entity_observations eo WHERE eo.entity_id = e.id) AS observation_count
      FROM entities e
      WHERE ${where}
      ORDER BY grounded_fact_count DESC, observation_count DESC,
        e.mention_count DESC, e.last_seen_at DESC
      LIMIT ?`)
    .all(...filterArgs, limit) as Array<{
    id: number;
    entity_type: string;
    canonical_name: string;
    canonical_name_lc: string;
    aliases_json: string;
    first_seen_at: string;
    last_seen_at: string;
    mention_count: number;
    fact_count: number;
    grounded_fact_count: number;
    inferred_fact_count: number;
    identifier_count: number;
    observation_count: number;
  }>;
  const entities = rows.map((r) => {
    let aliases: string[] = [];
    try {
      const parsed = JSON.parse(r.aliases_json);
      if (Array.isArray(parsed)) aliases = parsed.filter((a) => typeof a === 'string');
    } catch { /* ignore */ }
    return {
      id: r.id,
      entityType: r.entity_type,
      canonicalName: r.canonical_name,
      aliases,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      mentionCount: r.mention_count,
      factCount: r.fact_count,
      groundedFactCount: r.grounded_fact_count,
      inferredFactCount: r.inferred_fact_count,
      identifierCount: r.identifier_count,
      observationCount: r.observation_count,
    };
  });
  const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM entities e WHERE ${where}`)
    .get(...filterArgs) as { c: number };
  const allTotalRow = db.prepare(`SELECT COUNT(*) AS c FROM entities e
    WHERE NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = e.id)`).get() as { c: number };
  const redirectedRow = db.prepare('SELECT COUNT(*) AS c FROM entity_redirects').get() as { c: number };
  return {
    entities,
    total: totalRow?.c ?? 0,
    allTotal: allTotalRow?.c ?? 0,
    redirectedTotal: redirectedRow?.c ?? 0,
  };
}
