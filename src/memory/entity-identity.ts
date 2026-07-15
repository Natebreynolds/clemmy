import type Database from 'better-sqlite3';
import { openMemoryDb, type EntityRow, type EntityType } from './db.js';

export interface EntityIdentifierInput {
  scheme: string;
  value: string;
  confidence?: number;
}

export interface UpsertEntityInput {
  type: EntityType;
  name: string;
  aliases?: string[];
  identifiers?: EntityIdentifierInput[];
  confidence?: number;
  evidenceEpisodeId?: string;
  sourceUri?: string;
  sourceFactId?: number;
  sourceKind?: 'entity_upsert' | 'fact_link' | 'fact_backfill' | 'alias' | 'identifier' | 'relationship' | 'meeting_participant' | 'user_turn' | 'manual' | 'import';
}

export interface EntityIdentityConflict {
  scheme: string;
  value: string;
  entities: Array<{ id: number; type: EntityType; name: string }>;
}

export interface EntityIdentifierReconciliationResult {
  groupsScanned: number;
  groupsMerged: number;
  entitiesRedirected: number;
}

export interface MergeEntitiesInput {
  sourceEntityId: number;
  canonicalEntityId: number;
  reason: string;
  confidence?: number;
  evidenceEpisodeId?: string;
}

const GENERIC_EMAIL_LOCAL_PARTS = new Set([
  'accounts', 'accounting', 'admin', 'billing', 'careers', 'contact', 'customer',
  'customerservice', 'hello', 'help', 'hr', 'info', 'intake', 'jobs', 'leads',
  'legal', 'mail', 'marketing', 'newsletter', 'no', 'noreply', 'notifications',
  'office', 'operations', 'press', 'privacy', 'reception', 'sales', 'security',
  'service', 'success', 'support', 'team',
]);
const STRONG_IDENTIFIER_MIN_CONFIDENCE = 0.85;

function clampConfidence(value: number | undefined, fallback: number): number {
  return Math.max(0, Math.min(1, value ?? fallback));
}

function normalizeIdentifier(scheme: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const kind = scheme.trim().toLowerCase();
  if (kind === 'email') return trimmed.replace(/^mailto:/i, '').toLowerCase();
  if (kind === 'phone') {
    const digits = trimmed.replace(/\D/g, '');
    return digits.length >= 7 ? digits : '';
  }
  if (kind === 'domain') {
    return trimmed
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split(/[/?#]/, 1)[0]
      .replace(/\.$/, '')
      .toLowerCase();
  }
  return trimmed.toLowerCase();
}

function observedAtForInput(db: Database.Database, input: UpsertEntityInput, fallback: string): string {
  if (!input.evidenceEpisodeId) return fallback;
  const row = db.prepare('SELECT occurred_at FROM memory_episodes WHERE id = ?')
    .get(input.evidenceEpisodeId) as { occurred_at: string } | undefined;
  return row?.occurred_at ?? fallback;
}

type EntityObservationInput = Pick<
  UpsertEntityInput,
  'confidence' | 'evidenceEpisodeId' | 'sourceUri' | 'sourceFactId' | 'sourceKind'
>;

/** Record one distinct source episode for an identity. Returns true only when
 * this is the first time that episode has observed the canonical entity. */
function recordEntityObservation(
  db: Database.Database,
  entityId: number,
  input: EntityObservationInput,
  observedAt: string,
  createdAt: string,
): boolean {
  if (!input.evidenceEpisodeId) return true;
  const result = db.prepare(`
    INSERT OR IGNORE INTO entity_observations
      (entity_id, episode_id, source_fact_id, source_uri, source_kind,
       confidence, observed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entityId,
    input.evidenceEpisodeId,
    input.sourceFactId ?? null,
    input.sourceUri ?? null,
    input.sourceKind ?? 'entity_upsert',
    clampConfidence(input.confidence, 0.7),
    observedAt,
    createdAt,
  );
  if (result.changes > 0) return true;
  db.prepare(`
    UPDATE entity_observations SET
      source_fact_id = COALESCE(source_fact_id, ?),
      source_uri = COALESCE(source_uri, ?),
      confidence = MAX(confidence, ?),
      observed_at = MIN(observed_at, ?)
    WHERE entity_id = ? AND episode_id = ?
  `).run(
    input.sourceFactId ?? null,
    input.sourceUri ?? null,
    clampConfidence(input.confidence, 0.7),
    observedAt,
    entityId,
    input.evidenceEpisodeId,
  );
  return false;
}

/** Exact person-identity merge authority shared by ingestion, maintenance, and
 * read-only readiness diagnostics. Generic/shared inboxes stay review-only. */
export function isStrongPersonalEmail(value: string): boolean {
  const normalized = normalizeIdentifier('email', value);
  const at = normalized.indexOf('@');
  if (at <= 0 || at === normalized.length - 1) return false;
  const local = normalized.slice(0, at);
  const firstToken = local.split(/[._+-]/, 1)[0];
  const compact = local.replace(/[^a-z0-9]/g, '');
  return !GENERIC_EMAIL_LOCAL_PARTS.has(local)
    && !GENERIC_EMAIL_LOCAL_PARTS.has(firstToken)
    && !GENERIC_EMAIL_LOCAL_PARTS.has(compact);
}

function chooseCanonicalPerson(db: Database.Database, ids: number[]): number {
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, canonical_name, mention_count, first_seen_at
    FROM entities WHERE id IN (${placeholders})
  `).all(...ids) as Array<{ id: number; canonical_name: string; mention_count: number; first_seen_at: string }>;
  rows.sort((a, b) => {
    const quality = (name: string): number => {
      const clean = name.trim();
      if (clean.includes('@')) return 0;
      return clean.split(/\s+/).length >= 2 ? 2 : 1;
    };
    return quality(b.canonical_name) - quality(a.canonical_name)
      || b.mention_count - a.mention_count
      || a.first_seen_at.localeCompare(b.first_seen_at)
      || a.id - b.id;
  });
  return rows[0]?.id ?? ids[0];
}

/** Follow redirect chains on an explicitly supplied database handle. Release
 * rehearsal uses this variant so identity repair can run entirely on a clone. */
export function resolveCanonicalEntityIdInDatabase(db: Database.Database, entityId: number): number {
  let current = entityId;
  const seen = new Set<number>();
  const lookup = db.prepare('SELECT canonical_entity_id FROM entity_redirects WHERE source_entity_id = ?');
  while (!seen.has(current)) {
    seen.add(current);
    const row = lookup.get(current) as { canonical_entity_id: number } | undefined;
    if (!row) return current;
    current = row.canonical_entity_id;
  }
  return entityId;
}

function reconcilePersonalEmailGroup(db: Database.Database, valueNorm: string): { canonicalId?: number; redirected: number } {
  const ids = Array.from(new Set((db.prepare(`
    SELECT ei.entity_id
    FROM entity_identifiers ei
    JOIN entities e ON e.id = ei.entity_id
    LEFT JOIN entity_redirects er ON er.source_entity_id = e.id
    WHERE e.entity_type = 'person' AND ei.scheme = 'email' AND ei.value_norm = ?
      AND ei.confidence >= ?
      AND er.source_entity_id IS NULL
  `).all(valueNorm, STRONG_IDENTIFIER_MIN_CONFIDENCE) as Array<{ entity_id: number }>).map(
    (row) => resolveCanonicalEntityIdInDatabase(db, row.entity_id),
  )));
  if (ids.length === 0) return { redirected: 0 };
  if (ids.length === 1) return { canonicalId: ids[0], redirected: 0 };
  const canonicalId = chooseCanonicalPerson(db, ids);
  let redirected = 0;
  for (const id of ids) {
    if (id === canonicalId) continue;
    mergeEntitiesInDatabase(db, {
      sourceEntityId: id,
      canonicalEntityId: canonicalId,
      reason: `automatic exact personal-email reconciliation: ${valueNorm}`,
      confidence: 0.99,
    });
    redirected += 1;
  }
  return { canonicalId, redirected };
}

function strongPersonalEmailCollisionValues(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT ei.value_norm
    FROM entity_identifiers ei
    JOIN entities e ON e.id = ei.entity_id
    LEFT JOIN entity_redirects er ON er.source_entity_id = e.id
    WHERE e.entity_type = 'person' AND ei.scheme = 'email'
      AND ei.confidence >= ? AND er.source_entity_id IS NULL
    GROUP BY ei.value_norm
    HAVING COUNT(DISTINCT ei.entity_id) > 1
    ORDER BY COUNT(DISTINCT ei.entity_id) DESC, ei.value_norm
  `).all(STRONG_IDENTIFIER_MIN_CONFIDENCE) as Array<{ value_norm: string }>;
  // Filter before applying the caller's repair limit. Otherwise a large set of
  // shared inboxes could fill the SQL LIMIT and starve real personal-email
  // duplicates forever.
  return rows.map((row) => row.value_norm).filter(isStrongPersonalEmail);
}

export function countStrongEntityIdentifierCollisionGroupsInDatabase(db: Database.Database): number {
  return strongPersonalEmailCollisionValues(db).length;
}

export function countStrongEntityIdentifierCollisionGroups(): number {
  return countStrongEntityIdentifierCollisionGroupsInDatabase(openMemoryDb());
}

function inferredIdentifiers(type: EntityType, values: string[]): EntityIdentifierInput[] {
  const out: EntityIdentifierInput[] = [];
  for (const raw of values) {
    for (const match of raw.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
      out.push({ scheme: 'email', value: match[0], confidence: 0.95 });
    }
    const trimmed = raw.trim();
    const digits = trimmed.replace(/\D/g, '');
    if (/^\+?[\d\s().-]{7,24}$/.test(trimmed) && digits.length >= 7 && digits.length <= 15) {
      out.push({ scheme: 'phone', value: trimmed, confidence: 0.9 });
    }
    if (type === 'company' && /^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#].*)?$/i.test(trimmed)) {
      out.push({ scheme: 'domain', value: trimmed, confidence: 0.9 });
    }
  }
  return out;
}

function parseAliases(row: Pick<EntityRow, 'aliases_json'>): string[] {
  try {
    const parsed = JSON.parse(row.aliases_json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
  } catch {
    return [];
  }
}

/** Follow redirect chains without deleting the historical source entity row. */
export function resolveCanonicalEntityId(entityId: number): number {
  return resolveCanonicalEntityIdInDatabase(openMemoryDb(), entityId);
}

function writeAlias(db: Database.Database, entityId: number, alias: string, input: UpsertEntityInput, now: string): void {
  const cleaned = alias.trim();
  if (!cleaned) return;
  db.prepare(`
    INSERT INTO entity_aliases
      (entity_id, alias, alias_lc, confidence, evidence_episode_id, source_uri, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity_id, alias_lc) DO UPDATE SET
      alias = CASE WHEN LENGTH(excluded.alias) > LENGTH(entity_aliases.alias) THEN excluded.alias ELSE entity_aliases.alias END,
      confidence = MAX(entity_aliases.confidence, excluded.confidence),
      evidence_episode_id = COALESCE(excluded.evidence_episode_id, entity_aliases.evidence_episode_id),
      source_uri = COALESCE(excluded.source_uri, entity_aliases.source_uri),
      first_seen_at = MIN(entity_aliases.first_seen_at, excluded.first_seen_at),
      last_seen_at = MAX(entity_aliases.last_seen_at, excluded.last_seen_at)
  `).run(
    entityId,
    cleaned,
    cleaned.toLowerCase(),
    clampConfidence(input.confidence, 0.7),
    input.evidenceEpisodeId ?? null,
    input.sourceUri ?? null,
    now,
    now,
  );
}

function writeIdentifier(db: Database.Database, entityId: number, identifier: EntityIdentifierInput, input: UpsertEntityInput, now: string): void {
  const scheme = identifier.scheme.trim().toLowerCase();
  const value = identifier.value.trim();
  const normalized = normalizeIdentifier(scheme, value);
  if (!scheme || !normalized) return;
  db.prepare(`
    INSERT INTO entity_identifiers
      (entity_id, scheme, value, value_norm, confidence, evidence_episode_id, source_uri, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity_id, scheme, value_norm) DO UPDATE SET
      confidence = MAX(entity_identifiers.confidence, excluded.confidence),
      evidence_episode_id = COALESCE(excluded.evidence_episode_id, entity_identifiers.evidence_episode_id),
      source_uri = COALESCE(excluded.source_uri, entity_identifiers.source_uri),
      first_seen_at = MIN(entity_identifiers.first_seen_at, excluded.first_seen_at),
      last_seen_at = MAX(entity_identifiers.last_seen_at, excluded.last_seen_at)
  `).run(
    entityId,
    scheme,
    value,
    normalized,
    clampConfidence(identifier.confidence, 0.9),
    input.evidenceEpisodeId ?? null,
    input.sourceUri ?? null,
    now,
    now,
  );
}

function isAutoMergeIdentifier(type: EntityType, scheme: string, value: string, confidence = 0.9): boolean {
  const normalizedScheme = scheme.trim().toLowerCase();
  const normalized = normalizeIdentifier(normalizedScheme, value);
  if (!normalized || confidence < STRONG_IDENTIFIER_MIN_CONFIDENCE) return false;
  // Exact, non-shared personal email is the only person identifier strong
  // enough to merge automatically. Phones, handles, and shared inboxes can
  // belong to multiple humans and remain review evidence instead.
  if (type === 'person') return normalizedScheme === 'email' && isStrongPersonalEmail(normalized);
  // A normalized company domain is stable enough to converge spelling/name
  // variants. Other entity kinds currently require names/aliases or review.
  if (type === 'company') return normalizedScheme === 'domain' && normalized.includes('.');
  return false;
}

function uniqueIdentifierCandidate(db: Database.Database, type: EntityType, identifiers: EntityIdentifierInput[]): number | undefined {
  const lookup = db.prepare(`
    SELECT ei.entity_id, ei.confidence
    FROM entity_identifiers ei
    JOIN entities e ON e.id = ei.entity_id
    WHERE e.entity_type = ? AND ei.scheme = ? AND ei.value_norm = ?
  `);
  const ids = new Set<number>();
  for (const identifier of identifiers) {
    const scheme = identifier.scheme.trim().toLowerCase();
    const normalized = normalizeIdentifier(scheme, identifier.value);
    if (!scheme || !normalized || !isAutoMergeIdentifier(
      type,
      scheme,
      identifier.value,
      identifier.confidence ?? 0.9,
    )) continue;
    for (const row of lookup.all(type, scheme, normalized) as Array<{ entity_id: number; confidence: number }>) {
      if (row.confidence < STRONG_IDENTIFIER_MIN_CONFIDENCE) continue;
      ids.add(resolveCanonicalEntityIdInDatabase(db, row.entity_id));
    }
  }
  if (ids.size > 1 && type === 'person') {
    const personalEmails = identifiers
      .filter((identifier) => identifier.scheme.trim().toLowerCase() === 'email'
        && (identifier.confidence ?? 0.9) >= STRONG_IDENTIFIER_MIN_CONFIDENCE
        && isStrongPersonalEmail(identifier.value))
      .map((identifier) => normalizeIdentifier('email', identifier.value));
    for (const email of personalEmails) {
      const reconciled = reconcilePersonalEmailGroup(db, email);
      if (reconciled.canonicalId) {
        const remaining = new Set(Array.from(ids).map((id) => resolveCanonicalEntityIdInDatabase(db, id)));
        if (remaining.size === 1) return remaining.values().next().value;
      }
    }
  }
  return ids.size === 1 ? ids.values().next().value : undefined;
}

function exactNameCandidate(
  db: Database.Database,
  type: EntityType,
  nameLc: string,
  identifiers: EntityIdentifierInput[],
): number | undefined {
  const ids = Array.from(new Set((db.prepare(
    'SELECT id FROM entities WHERE entity_type = ? AND canonical_name_lc = ?',
  ).all(type, nameLc) as Array<{ id: number }>).map((row) => resolveCanonicalEntityIdInDatabase(db, row.id))));
  if (ids.length === 0) return undefined;

  const incoming = identifiers
    .filter((identifier) => isAutoMergeIdentifier(
      type,
      identifier.scheme,
      identifier.value,
      identifier.confidence ?? 0.9,
    ))
    .map((identifier) => ({
      scheme: identifier.scheme.trim().toLowerCase(),
      value: normalizeIdentifier(identifier.scheme, identifier.value),
    }));
  if (incoming.length === 0) return ids.length === 1 ? ids[0] : undefined;

  const lookup = db.prepare('SELECT scheme, value_norm, confidence FROM entity_identifiers WHERE entity_id = ?');
  const compatible: number[] = [];
  for (const id of ids) {
    const existing = (lookup.all(id) as Array<{ scheme: string; value_norm: string; confidence: number }>)
      .filter((item) => isAutoMergeIdentifier(type, item.scheme, item.value_norm, item.confidence));
    if (existing.length === 0 || incoming.some((candidate) => existing.some(
      (item) => item.scheme === candidate.scheme && item.value_norm === candidate.value,
    ))) compatible.push(id);
  }
  return compatible.length === 1 ? compatible[0] : undefined;
}

function uniqueStrongAliasCandidate(db: Database.Database, type: EntityType, nameLc: string, aliases: string[]): number | undefined {
  const ids = new Set<number>();
  // Single-token nicknames are intentionally insufficient for automatic
  // convergence. A unique full-name alias is useful evidence; "Amy" is not.
  if (nameLc.split(/\s+/).length >= 2) {
    const rows = db.prepare(`
      SELECT ea.entity_id
      FROM entity_aliases ea JOIN entities e ON e.id = ea.entity_id
      WHERE e.entity_type = ? AND ea.alias_lc = ?
    `).all(type, nameLc) as Array<{ entity_id: number }>;
    for (const row of rows) ids.add(resolveCanonicalEntityIdInDatabase(db, row.entity_id));
  }
  const canonicalLookup = db.prepare('SELECT id FROM entities WHERE entity_type = ? AND canonical_name_lc = ?');
  for (const alias of aliases) {
    const aliasLc = alias.trim().toLowerCase();
    if (aliasLc.split(/\s+/).length < 2) continue;
    for (const row of canonicalLookup.all(type, aliasLc) as Array<{ id: number }>) {
      ids.add(resolveCanonicalEntityIdInDatabase(db, row.id));
    }
  }
  return ids.size === 1 ? ids.values().next().value : undefined;
}

function syncCompatibilityAliases(db: Database.Database, entityId: number): void {
  const row = db.prepare('SELECT canonical_name_lc FROM entities WHERE id = ?').get(entityId) as { canonical_name_lc: string } | undefined;
  if (!row) return;
  const aliases = (db.prepare(`
    SELECT alias FROM entity_aliases
    WHERE entity_id = ? AND alias_lc <> ?
    ORDER BY confidence DESC, last_seen_at DESC, alias_lc
  `).all(entityId, row.canonical_name_lc) as Array<{ alias: string }>).map((item) => item.alias);
  db.prepare('UPDATE entities SET aliases_json = ? WHERE id = ?').run(JSON.stringify(aliases), entityId);
}

/**
 * Upsert an identity using stable identifiers first, then compatible exact
 * names, then a unique multi-token alias. Ambiguous evidence creates a new row
 * instead of an unsafe merge; it remains visible to identity review.
 */
export function upsertEntity(input: UpsertEntityInput): number {
  const db = openMemoryDb();
  const name = input.name.trim();
  if (!name) throw new Error('upsertEntity: name required');
  const nameLc = name.toLowerCase();
  const now = new Date().toISOString();
  const observedAt = observedAtForInput(db, input, now);
  const aliases = Array.from(new Set((input.aliases ?? []).map((alias) => alias.trim()).filter(Boolean)));
  const identifiers = [
    ...(input.identifiers ?? []),
    ...inferredIdentifiers(input.type, [name, ...aliases]),
  ];

  // Repair legacy duplicate people before resolving this observation. This is
  // deliberately limited to exact, non-generic personal emails; a shared
  // support@/sales@ address or the same address on another entity type never
  // authorizes an automatic merge.
  if (input.type === 'person') {
    for (const identifier of identifiers) {
      if (identifier.scheme.trim().toLowerCase() !== 'email'
        || (identifier.confidence ?? 0.9) < STRONG_IDENTIFIER_MIN_CONFIDENCE
        || !isStrongPersonalEmail(identifier.value)) continue;
      reconcilePersonalEmailGroup(db, normalizeIdentifier('email', identifier.value));
    }
  }
  const targetId = uniqueIdentifierCandidate(db, input.type, identifiers)
    ?? exactNameCandidate(db, input.type, nameLc, identifiers)
    ?? uniqueStrongAliasCandidate(db, input.type, nameLc, aliases);

  let entityId: number;
  if (targetId) {
    entityId = targetId;
    const distinctObservation = recordEntityObservation(db, entityId, input, observedAt, now);
    if (distinctObservation) {
      db.prepare(`
        UPDATE entities SET
          last_seen_at = MAX(last_seen_at, ?),
          first_seen_at = MIN(first_seen_at, ?),
          mention_count = mention_count + 1
        WHERE id = ?
      `).run(observedAt, observedAt, entityId);
    }
  } else {
    const info = db.prepare(`
      INSERT INTO entities
        (entity_type, canonical_name, canonical_name_lc, aliases_json, first_seen_at, last_seen_at, mention_count)
      VALUES (?, ?, ?, '[]', ?, ?, 1)
    `).run(input.type, name, nameLc, observedAt, observedAt);
    entityId = Number(info.lastInsertRowid);
    recordEntityObservation(db, entityId, input, observedAt, now);
  }

  const canonical = db.prepare('SELECT canonical_name_lc FROM entities WHERE id = ?').get(entityId) as { canonical_name_lc: string };
  if (nameLc !== canonical.canonical_name_lc) writeAlias(db, entityId, name, input, observedAt);
  for (const alias of aliases) {
    if (alias.toLowerCase() !== canonical.canonical_name_lc) writeAlias(db, entityId, alias, input, observedAt);
  }
  for (const identifier of identifiers) writeIdentifier(db, entityId, identifier, input, observedAt);
  syncCompatibilityAliases(db, entityId);
  return entityId;
}

/** Attach an already-resolved canonical identity to one durable source
 * episode. Used when a fact→entity link is promoted after extraction or
 * reconciliation, so every grounded profile claim also has a deduplicated
 * source-timeline observation. */
export interface ObserveEntityFromEpisodeInput {
  entityId: number;
  episodeId: string;
  sourceFactId?: number;
  sourceUri?: string;
  confidence?: number;
  sourceKind?: UpsertEntityInput['sourceKind'];
  incrementMention?: boolean;
}

export function observeEntityFromEpisodeInDatabase(
  db: Database.Database,
  input: ObserveEntityFromEpisodeInput,
): boolean {
  const entityId = resolveCanonicalEntityIdInDatabase(db, input.entityId);
  const episode = db.prepare('SELECT occurred_at, source_uri FROM memory_episodes WHERE id = ?')
    .get(input.episodeId) as { occurred_at: string; source_uri: string | null } | undefined;
  if (!episode || !db.prepare('SELECT 1 FROM entities WHERE id = ?').get(entityId)) return false;
  const now = new Date().toISOString();
  const observation: EntityObservationInput = {
    confidence: input.confidence,
    evidenceEpisodeId: input.episodeId,
    sourceUri: input.sourceUri ?? episode.source_uri ?? undefined,
    sourceFactId: input.sourceFactId,
    sourceKind: input.sourceKind ?? 'fact_link',
  };
  const distinct = recordEntityObservation(db, entityId, observation, episode.occurred_at, now);
  if (distinct) {
    db.prepare(`
      UPDATE entities SET
        last_seen_at = MAX(last_seen_at, ?),
        first_seen_at = MIN(first_seen_at, ?),
        mention_count = mention_count + ?
      WHERE id = ?
    `).run(episode.occurred_at, episode.occurred_at, input.incrementMention === false ? 0 : 1, entityId);
  }
  return distinct;
}

export function observeEntityFromEpisode(input: ObserveEntityFromEpisodeInput): boolean {
  return observeEntityFromEpisodeInDatabase(openMemoryDb(), input);
}

/** Bounded maintenance repair for historical person rows sharing a personal email. */
export function autoReconcileStrongEntityIdentifiersInDatabase(
  db: Database.Database,
  limit = 100,
): EntityIdentifierReconciliationResult {
  const groups = strongPersonalEmailCollisionValues(db).slice(0, Math.max(1, limit));
  let groupsMerged = 0;
  let entitiesRedirected = 0;
  for (const group of groups) {
    const result = reconcilePersonalEmailGroup(db, group);
    if (result.redirected > 0) groupsMerged += 1;
    entitiesRedirected += result.redirected;
  }
  return { groupsScanned: groups.length, groupsMerged, entitiesRedirected };
}

/** Bounded maintenance repair against Clementine's configured memory DB. */
export function autoReconcileStrongEntityIdentifiers(limit = 100): EntityIdentifierReconciliationResult {
  return autoReconcileStrongEntityIdentifiersInDatabase(openMemoryDb(), limit);
}

/**
 * Canonicalize a reviewed duplicate without deleting either historical entity.
 * All graph/retrieval edges move to the target and a redirect preserves old ids.
 */
export function mergeEntitiesInDatabase(db: Database.Database, input: MergeEntitiesInput): number {
  const sourceId = resolveCanonicalEntityIdInDatabase(db, input.sourceEntityId);
  const targetId = resolveCanonicalEntityIdInDatabase(db, input.canonicalEntityId);
  if (sourceId === targetId) return targetId;
  const source = db.prepare('SELECT * FROM entities WHERE id = ?').get(sourceId) as EntityRow | undefined;
  const target = db.prepare('SELECT * FROM entities WHERE id = ?').get(targetId) as EntityRow | undefined;
  if (!source || !target) throw new Error('mergeEntities: source and canonical entities must exist');
  if (source.entity_type !== target.entity_type) throw new Error('mergeEntities: entity types must match');
  const now = new Date().toISOString();

  db.transaction(() => {
    const aliasInput: UpsertEntityInput = {
      type: target.entity_type,
      name: target.canonical_name,
      confidence: input.confidence ?? 1,
      evidenceEpisodeId: input.evidenceEpisodeId,
    };
    writeAlias(db, targetId, source.canonical_name, aliasInput, now);
    for (const alias of parseAliases(source)) writeAlias(db, targetId, alias, aliasInput, now);
    db.prepare(`
      INSERT OR IGNORE INTO entity_aliases
      SELECT ?, alias, alias_lc, confidence, evidence_episode_id, source_uri, first_seen_at, last_seen_at
      FROM entity_aliases WHERE entity_id = ?
    `).run(targetId, sourceId);
    db.prepare(`
      INSERT OR IGNORE INTO entity_identifiers
      SELECT ?, scheme, value, value_norm, confidence, evidence_episode_id, source_uri, first_seen_at, last_seen_at
      FROM entity_identifiers WHERE entity_id = ?
    `).run(targetId, sourceId);

    const overlappingObservations = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM entity_observations source
      JOIN entity_observations target
        ON target.entity_id = ? AND target.episode_id = source.episode_id
      WHERE source.entity_id = ?
    `).get(targetId, sourceId) as { count: number }).count;
    db.prepare(`
      INSERT INTO entity_observations
        (entity_id, episode_id, source_fact_id, source_uri, source_kind,
         confidence, observed_at, created_at)
      SELECT ?, episode_id, source_fact_id, source_uri, source_kind,
             confidence, observed_at, created_at
      FROM entity_observations WHERE entity_id = ?
      ON CONFLICT(entity_id, episode_id) DO UPDATE SET
        source_fact_id = COALESCE(entity_observations.source_fact_id, excluded.source_fact_id),
        source_uri = COALESCE(entity_observations.source_uri, excluded.source_uri),
        confidence = MAX(entity_observations.confidence, excluded.confidence),
        observed_at = MIN(entity_observations.observed_at, excluded.observed_at)
    `).run(targetId, sourceId);
    db.prepare('DELETE FROM entity_observations WHERE entity_id = ?').run(sourceId);

    db.prepare(`
      INSERT INTO fact_entities
        (fact_id, entity_id, created_at, link_type, confidence, evidence_episode_id, evidence_excerpt)
      SELECT fact_id, ?, created_at, link_type, confidence, evidence_episode_id, evidence_excerpt
      FROM fact_entities WHERE entity_id = ?
      ON CONFLICT(fact_id, entity_id) DO UPDATE SET
        link_type = CASE
          WHEN fact_entities.link_type IN ('stored','extracted') THEN fact_entities.link_type
          ELSE excluded.link_type
        END,
        confidence = MAX(fact_entities.confidence, excluded.confidence),
        evidence_episode_id = COALESCE(fact_entities.evidence_episode_id, excluded.evidence_episode_id),
        evidence_excerpt = COALESCE(fact_entities.evidence_excerpt, excluded.evidence_excerpt)
    `).run(targetId, sourceId);
    db.prepare('DELETE FROM fact_entities WHERE entity_id = ?').run(sourceId);

    const edges = db.prepare(`
      SELECT * FROM entity_edges WHERE subject_id = ? OR object_id = ?
    `).all(sourceId, sourceId) as Array<Record<string, unknown>>;
    // Child rows cascade when the legacy edge row is deleted. Snapshot them
    // first so a reviewed identity merge never destroys relationship evidence
    // or temporal history.
    const edgeEvidence = db.prepare(`
      SELECT * FROM entity_edge_evidence WHERE subject_id = ? OR object_id = ?
    `).all(sourceId, sourceId) as Array<Record<string, unknown>>;
    const edgeIntervals = db.prepare(`
      SELECT * FROM entity_edge_validity_intervals WHERE subject_id = ? OR object_id = ?
    `).all(sourceId, sourceId) as Array<Record<string, unknown>>;
    db.prepare('DELETE FROM entity_edges WHERE subject_id = ? OR object_id = ?').run(sourceId, sourceId);
    const insertEdge = db.prepare(`
      INSERT INTO entity_edges
        (subject_id, predicate, object_id, recurrence_count, first_seen_at, last_seen_at,
         confidence, evidence_episode_id, valid_from, valid_to, invalidated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subject_id, predicate, object_id) DO UPDATE SET
        recurrence_count = entity_edges.recurrence_count + excluded.recurrence_count,
        first_seen_at = MIN(entity_edges.first_seen_at, excluded.first_seen_at),
        last_seen_at = MAX(entity_edges.last_seen_at, excluded.last_seen_at),
        confidence = MAX(entity_edges.confidence, excluded.confidence),
        evidence_episode_id = COALESCE(excluded.evidence_episode_id, entity_edges.evidence_episode_id),
        valid_from = COALESCE(entity_edges.valid_from, excluded.valid_from),
        valid_to = COALESCE(excluded.valid_to, entity_edges.valid_to),
        invalidated_at = COALESCE(excluded.invalidated_at, entity_edges.invalidated_at)
    `);
    for (const edge of edges) {
      const subjectId = Number(edge.subject_id) === sourceId ? targetId : Number(edge.subject_id);
      const objectId = Number(edge.object_id) === sourceId ? targetId : Number(edge.object_id);
      if (subjectId === objectId) continue;
      insertEdge.run(
        subjectId, edge.predicate, objectId, edge.recurrence_count, edge.first_seen_at, edge.last_seen_at,
        edge.confidence, edge.evidence_episode_id, edge.valid_from, edge.valid_to, edge.invalidated_at,
      );
    }

    const insertEvidence = db.prepare(`
      INSERT OR IGNORE INTO entity_edge_evidence
        (subject_id, predicate, object_id, episode_id, excerpt_hash, excerpt,
         source_uri, source_fact_id, confidence, observed_at, valid_from, valid_to,
         extraction_method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const evidence of edgeEvidence) {
      const subjectId = Number(evidence.subject_id) === sourceId ? targetId : Number(evidence.subject_id);
      const objectId = Number(evidence.object_id) === sourceId ? targetId : Number(evidence.object_id);
      if (subjectId === objectId) continue;
      insertEvidence.run(
        subjectId, evidence.predicate, objectId, evidence.episode_id, evidence.excerpt_hash,
        evidence.excerpt, evidence.source_uri, evidence.source_fact_id, evidence.confidence,
        evidence.observed_at, evidence.valid_from, evidence.valid_to,
        evidence.extraction_method, evidence.created_at,
      );
    }

    const insertInterval = db.prepare(`
      INSERT OR IGNORE INTO entity_edge_validity_intervals
        (subject_id, predicate, object_id, valid_from, valid_to, opened_reason,
         closed_reason, evidence_episode_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const interval of edgeIntervals) {
      const subjectId = Number(interval.subject_id) === sourceId ? targetId : Number(interval.subject_id);
      const objectId = Number(interval.object_id) === sourceId ? targetId : Number(interval.object_id);
      if (subjectId === objectId) continue;
      insertInterval.run(
        subjectId, interval.predicate, objectId, interval.valid_from, interval.valid_to,
        interval.opened_reason, interval.closed_reason, interval.evidence_episode_id,
        interval.created_at, interval.updated_at,
      );
    }

    // Once grounded evidence exists, its deduplicated ledger—not the sum of
    // two legacy counters—is the honest recurrence signal after convergence.
    db.prepare(`
      UPDATE entity_edges SET recurrence_count = (
        SELECT COUNT(*) FROM entity_edge_evidence eee
        WHERE eee.subject_id = entity_edges.subject_id
          AND eee.predicate = entity_edges.predicate
          AND eee.object_id = entity_edges.object_id
      )
      WHERE (subject_id = ? OR object_id = ?)
        AND EXISTS (
          SELECT 1 FROM entity_edge_evidence eee
          WHERE eee.subject_id = entity_edges.subject_id
            AND eee.predicate = entity_edges.predicate
            AND eee.object_id = entity_edges.object_id
        )
    `).run(targetId, targetId);

    db.prepare('UPDATE entity_redirects SET canonical_entity_id = ? WHERE canonical_entity_id = ?').run(targetId, sourceId);
    db.prepare(`
      INSERT INTO entity_redirects
        (source_entity_id, canonical_entity_id, reason, confidence, evidence_episode_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_entity_id) DO UPDATE SET
        canonical_entity_id = excluded.canonical_entity_id,
        reason = excluded.reason,
        confidence = excluded.confidence,
        evidence_episode_id = COALESCE(excluded.evidence_episode_id, entity_redirects.evidence_episode_id)
    `).run(
      sourceId,
      targetId,
      input.reason.trim() || 'reviewed duplicate identity',
      clampConfidence(input.confidence, 1),
      input.evidenceEpisodeId ?? null,
      now,
    );
    db.prepare(`
      UPDATE entities SET
        mention_count = mention_count + ?,
        first_seen_at = MIN(first_seen_at, ?),
        last_seen_at = MAX(last_seen_at, ?)
      WHERE id = ?
    `).run(Math.max(0, source.mention_count - overlappingObservations), source.first_seen_at, source.last_seen_at, targetId);
    syncCompatibilityAliases(db, targetId);
  })();
  return targetId;
}

export function mergeEntities(input: MergeEntitiesInput): number {
  return mergeEntitiesInDatabase(openMemoryDb(), input);
}

/** Stable identifiers claimed by multiple canonical entities need review. */
export function listEntityIdentityConflicts(limit = 100): EntityIdentityConflict[] {
  const db = openMemoryDb();
  const groups = db.prepare(`
    SELECT ei.scheme, ei.value_norm, MIN(ei.value) AS value, e.entity_type
    FROM entity_identifiers ei
    JOIN entities e ON e.id = ei.entity_id
    LEFT JOIN entity_redirects er ON er.source_entity_id = ei.entity_id
    WHERE er.source_entity_id IS NULL
      AND NOT (
        ei.scheme = 'email'
        AND lower(substr(ei.value_norm, 1, instr(ei.value_norm, '@') - 1))
          IN ('admin','billing','contact','hello','help','info','intake','leads','marketing','office','sales','support','team','service','customerservice')
      )
    GROUP BY e.entity_type, ei.scheme, ei.value_norm
    HAVING COUNT(DISTINCT entity_id) > 1
    ORDER BY COUNT(DISTINCT entity_id) DESC, ei.scheme, ei.value_norm
    LIMIT ?
  `).all(Math.max(1, limit)) as Array<{ scheme: string; value_norm: string; value: string; entity_type: EntityType }>;
  const entities = db.prepare(`
    SELECT e.id, e.entity_type, e.canonical_name
    FROM entity_identifiers ei
    JOIN entities e ON e.id = ei.entity_id
    LEFT JOIN entity_redirects er ON er.source_entity_id = e.id
    WHERE ei.scheme = ? AND ei.value_norm = ? AND e.entity_type = ? AND er.source_entity_id IS NULL
    ORDER BY e.mention_count DESC, e.last_seen_at DESC
  `);
  return groups.map((group) => ({
    scheme: group.scheme,
    value: group.value,
    entities: (entities.all(group.scheme, group.value_norm, group.entity_type) as Array<{ id: number; entity_type: EntityType; canonical_name: string }>).map((row) => ({
      id: row.id,
      type: row.entity_type,
      name: row.canonical_name,
    })),
  }));
}
