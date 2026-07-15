import { openMemoryDb, type ConsolidatedFactKind, type EntityType, type MemoryEpisodeStatus } from './db.js';
import { resolveCanonicalEntityId } from './entity-identity.js';
import { getFactEvidence, type FactEvidence } from './temporal-memory.js';
import { looksLikeHighConfidenceTransientRequest } from './memory-quality.js';

export interface EntityMemoryAlias {
  value: string;
  confidence: number;
  sourceUri: string | null;
  evidenceEpisodeId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface EntityMemoryIdentifier {
  scheme: string;
  value: string;
  confidence: number;
  sourceUri: string | null;
  evidenceEpisodeId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface EntityMemoryClaim {
  factId: number;
  kind: ConsolidatedFactKind;
  content: string;
  active: boolean;
  confidence: number;
  validFrom: string | null;
  validTo: string | null;
  supersededByFactId: number | null;
  linkType: 'stored' | 'extracted';
  linkConfidence: number;
  quality: 'accepted' | 'needs_review';
  reviewReason: string | null;
  evidence: FactEvidence[];
}

export interface EntityMemoryRelationshipEvidence {
  episodeId: string;
  excerpt: string;
  sourceUri: string | null;
  sourceFactId: number | null;
  confidence: number;
  observedAt: string;
  status: MemoryEpisodeStatus;
}

export interface EntityMemoryValidityInterval {
  validFrom: string;
  validTo: string | null;
  openedReason: string;
  closedReason: string | null;
}

export interface EntityMemoryRelationship {
  direction: 'outgoing' | 'incoming';
  predicate: string;
  otherEntity: { id: number; type: EntityType; canonicalName: string };
  current: boolean;
  confidence: number;
  recurrenceCount: number;
  validFrom: string | null;
  validTo: string | null;
  evidence: EntityMemoryRelationshipEvidence[];
  validityIntervals: EntityMemoryValidityInterval[];
}

export interface EntityMemoryEpisode {
  id: string;
  kind: string;
  subtype: string | null;
  title: string | null;
  sourceApp: string | null;
  sourceUri: string | null;
  occurredAt: string;
  status: MemoryEpisodeStatus;
  excerpt: string | null;
  confidence: number;
  sourceKind: string;
  sourceFactId: number | null;
}

export interface EntityMemoryDetail {
  entity: {
    id: number;
    type: EntityType;
    canonicalName: string;
    firstSeenAt: string;
    lastSeenAt: string;
    legacyMentionCount: number;
    aliases: EntityMemoryAlias[];
    identifiers: EntityMemoryIdentifier[];
  };
  identity: {
    requestedId: number;
    canonicalId: number;
    redirectedFrom: Array<{
      id: number;
      canonicalName: string;
      reason: string;
      confidence: number;
      createdAt: string;
    }>;
  };
  claims: EntityMemoryClaim[];
  relationships: EntityMemoryRelationship[];
  episodes: EntityMemoryEpisode[];
  stats: {
    groundedClaims: number;
    currentClaims: number;
    reviewClaims: number;
    relationships: number;
    currentRelationships: number;
    sourceEpisodes: number;
    aliases: number;
    identifiers: number;
    redirectedIdentities: number;
  };
  asOf: string;
}

function validAsOf(value?: string): string {
  if (!value) return new Date().toISOString();
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : new Date().toISOString();
}

function intervalContains(interval: EntityMemoryValidityInterval, asOf: string): boolean {
  return interval.validFrom <= asOf && (!interval.validTo || interval.validTo > asOf);
}

/**
 * A truthful, canonical entity projection for the desktop. It intentionally
 * excludes inferred_text joins. Guessed name matches remain available in the
 * augmented graph, but never appear as claims in a person's memory profile.
 */
export function getEntityMemoryDetail(requestedId: number, options: { asOf?: string } = {}): EntityMemoryDetail {
  if (!Number.isInteger(requestedId) || requestedId <= 0) throw new Error('entity id must be a positive integer');
  const db = openMemoryDb();
  const canonicalId = resolveCanonicalEntityId(requestedId);
  const asOf = validAsOf(options.asOf);
  const entity = db.prepare(`
    SELECT id, entity_type, canonical_name, first_seen_at, last_seen_at, mention_count
    FROM entities WHERE id = ?
  `).get(canonicalId) as {
    id: number; entity_type: EntityType; canonical_name: string;
    first_seen_at: string; last_seen_at: string; mention_count: number;
  } | undefined;
  if (!entity) throw new Error('entity not found');

  const aliases = (db.prepare(`
    SELECT alias, confidence, source_uri, evidence_episode_id, first_seen_at, last_seen_at
    FROM entity_aliases WHERE entity_id = ?
    ORDER BY confidence DESC, last_seen_at DESC, alias_lc
  `).all(canonicalId) as Array<{
    alias: string; confidence: number; source_uri: string | null; evidence_episode_id: string | null;
    first_seen_at: string; last_seen_at: string;
  }>).map((row) => ({
    value: row.alias,
    confidence: row.confidence,
    sourceUri: row.source_uri,
    evidenceEpisodeId: row.evidence_episode_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  }));

  const identifiers = (db.prepare(`
    SELECT scheme, value, confidence, source_uri, evidence_episode_id, first_seen_at, last_seen_at
    FROM entity_identifiers WHERE entity_id = ?
    ORDER BY confidence DESC, scheme, value_norm
  `).all(canonicalId) as Array<{
    scheme: string; value: string; confidence: number; source_uri: string | null; evidence_episode_id: string | null;
    first_seen_at: string; last_seen_at: string;
  }>).map((row) => ({
    scheme: row.scheme,
    value: row.value,
    confidence: row.confidence,
    sourceUri: row.source_uri,
    evidenceEpisodeId: row.evidence_episode_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  }));

  const claimRows = db.prepare(`
    SELECT cf.id, cf.kind, cf.content, cf.active, cf.confidence, cf.trust_level,
           cf.valid_from, cf.valid_to, cf.superseded_by_fact_id,
           fe.link_type, fe.confidence AS link_confidence
    FROM fact_entities fe
    JOIN consolidated_facts cf ON cf.id = fe.fact_id
    WHERE fe.entity_id = ? AND fe.link_type IN ('stored','extracted')
    ORDER BY cf.active DESC, COALESCE(cf.valid_from, cf.updated_at) DESC, cf.id DESC
    LIMIT 250
  `).all(canonicalId) as Array<{
    id: number; kind: ConsolidatedFactKind; content: string; active: number;
    confidence: number | null; trust_level: number | null; valid_from: string | null;
    valid_to: string | null; superseded_by_fact_id: number | null;
    link_type: 'stored' | 'extracted'; link_confidence: number;
  }>;
  const claims: EntityMemoryClaim[] = claimRows.map((row) => {
    const needsReview = looksLikeHighConfidenceTransientRequest(row.content);
    return {
      factId: row.id,
      kind: row.kind,
      content: row.content,
      active: row.active === 1,
      confidence: row.confidence ?? row.trust_level ?? 0.7,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      supersededByFactId: row.superseded_by_fact_id,
      linkType: row.link_type,
      linkConfidence: row.link_confidence,
      quality: needsReview ? 'needs_review' : 'accepted',
      reviewReason: needsReview ? 'This resembles a one-time command or question, not stable identity memory.' : null,
      evidence: getFactEvidence(row.id),
    };
  });

  const edgeRows = db.prepare(`
    SELECT ee.subject_id, ee.predicate, ee.object_id, ee.recurrence_count,
           ee.confidence, ee.valid_from, ee.valid_to, ee.invalidated_at,
           other.id AS other_id, other.entity_type AS other_type,
           other.canonical_name AS other_name
    FROM entity_edges ee
    JOIN entities other ON other.id = CASE WHEN ee.subject_id = ? THEN ee.object_id ELSE ee.subject_id END
    WHERE ee.subject_id = ? OR ee.object_id = ?
    ORDER BY ee.last_seen_at DESC, ee.confidence DESC, ee.predicate
    LIMIT 250
  `).all(canonicalId, canonicalId, canonicalId) as Array<{
    subject_id: number; predicate: string; object_id: number; recurrence_count: number;
    confidence: number; valid_from: string | null; valid_to: string | null; invalidated_at: string | null;
    other_id: number; other_type: EntityType; other_name: string;
  }>;
  const readEvidence = db.prepare(`
    SELECT eee.episode_id, eee.excerpt, eee.source_uri, eee.source_fact_id,
           eee.confidence, eee.observed_at, me.status
    FROM entity_edge_evidence eee
    JOIN memory_episodes me ON me.id = eee.episode_id
    WHERE eee.subject_id = ? AND eee.predicate = ? AND eee.object_id = ?
    ORDER BY eee.observed_at DESC, eee.confidence DESC
    LIMIT 20
  `);
  const readIntervals = db.prepare(`
    SELECT valid_from, valid_to, opened_reason, closed_reason
    FROM entity_edge_validity_intervals
    WHERE subject_id = ? AND predicate = ? AND object_id = ?
    ORDER BY valid_from DESC
  `);
  const relationships: EntityMemoryRelationship[] = edgeRows.map((row) => {
    const evidence = (readEvidence.all(row.subject_id, row.predicate, row.object_id) as Array<{
      episode_id: string; excerpt: string; source_uri: string | null; source_fact_id: number | null;
      confidence: number; observed_at: string; status: MemoryEpisodeStatus;
    }>).map((item) => ({
      episodeId: item.episode_id,
      excerpt: item.excerpt,
      sourceUri: item.source_uri,
      sourceFactId: item.source_fact_id,
      confidence: item.confidence,
      observedAt: item.observed_at,
      status: item.status,
    }));
    const validityIntervals = (readIntervals.all(row.subject_id, row.predicate, row.object_id) as Array<{
      valid_from: string; valid_to: string | null; opened_reason: string; closed_reason: string | null;
    }>).map((item) => ({
      validFrom: item.valid_from,
      validTo: item.valid_to,
      openedReason: item.opened_reason,
      closedReason: item.closed_reason,
    }));
    const current = validityIntervals.length > 0
      ? validityIntervals.some((interval) => intervalContains(interval, asOf))
      : (!row.invalidated_at || row.invalidated_at > asOf)
        && (!row.valid_from || row.valid_from <= asOf)
        && (!row.valid_to || row.valid_to > asOf);
    return {
      direction: row.subject_id === canonicalId ? 'outgoing' : 'incoming',
      predicate: row.predicate,
      otherEntity: { id: row.other_id, type: row.other_type, canonicalName: row.other_name },
      current,
      confidence: row.confidence,
      recurrenceCount: row.recurrence_count,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      evidence,
      validityIntervals,
    };
  });

  const episodes = (db.prepare(`
    SELECT eo.episode_id, eo.source_fact_id, eo.source_uri AS observation_source_uri,
           eo.source_kind, eo.confidence, eo.observed_at,
           me.kind, me.subtype, me.title, me.source_app, me.source_uri,
           me.status, me.evidence_excerpt
    FROM entity_observations eo
    JOIN memory_episodes me ON me.id = eo.episode_id
    WHERE eo.entity_id = ?
    ORDER BY eo.observed_at DESC, eo.episode_id
    LIMIT 250
  `).all(canonicalId) as Array<{
    episode_id: string; source_fact_id: number | null; observation_source_uri: string | null;
    source_kind: string; confidence: number; observed_at: string; kind: string; subtype: string | null;
    title: string | null; source_app: string | null; source_uri: string | null;
    status: MemoryEpisodeStatus; evidence_excerpt: string | null;
  }>).map((row) => ({
    id: row.episode_id,
    kind: row.kind,
    subtype: row.subtype,
    title: row.title,
    sourceApp: row.source_app,
    sourceUri: row.observation_source_uri ?? row.source_uri,
    occurredAt: row.observed_at,
    status: row.status,
    excerpt: row.evidence_excerpt,
    confidence: row.confidence,
    sourceKind: row.source_kind,
    sourceFactId: row.source_fact_id,
  }));

  const redirectedFrom = (db.prepare(`
    SELECT source.id, source.canonical_name, er.reason, er.confidence, er.created_at
    FROM entity_redirects er
    JOIN entities source ON source.id = er.source_entity_id
    WHERE er.canonical_entity_id = ?
    ORDER BY er.created_at DESC, source.id
  `).all(canonicalId) as Array<{
    id: number; canonical_name: string; reason: string; confidence: number; created_at: string;
  }>).map((row) => ({
    id: row.id,
    canonicalName: row.canonical_name,
    reason: row.reason,
    confidence: row.confidence,
    createdAt: row.created_at,
  }));

  return {
    entity: {
      id: entity.id,
      type: entity.entity_type,
      canonicalName: entity.canonical_name,
      firstSeenAt: entity.first_seen_at,
      lastSeenAt: entity.last_seen_at,
      legacyMentionCount: entity.mention_count,
      aliases,
      identifiers,
    },
    identity: { requestedId, canonicalId, redirectedFrom },
    claims,
    relationships,
    episodes,
    stats: {
      groundedClaims: claims.length,
      currentClaims: claims.filter((claim) => claim.quality === 'accepted' && claim.active && (!claim.validFrom || claim.validFrom <= asOf) && (!claim.validTo || claim.validTo > asOf)).length,
      reviewClaims: claims.filter((claim) => claim.quality === 'needs_review').length,
      relationships: relationships.length,
      currentRelationships: relationships.filter((relationship) => relationship.current).length,
      sourceEpisodes: episodes.length,
      aliases: aliases.length,
      identifiers: identifiers.length,
      redirectedIdentities: redirectedFrom.length,
    },
    asOf,
  };
}
