import { openMemoryDb, type EntityType } from './db.js';

export type EntityDuplicateMatchBasis =
  | 'shared_identifier'
  | 'canonical_equivalent'
  | 'canonical_alias'
  | 'shared_alias'
  | 'person_name_variant'
  | 'person_nickname';

export interface EntityDuplicateMatch {
  entityIds: [number, number];
  basis: EntityDuplicateMatchBasis;
  score: number;
  detail: string;
}

export interface EntityDuplicateCandidateEntity {
  id: number;
  type: EntityType;
  name: string;
  aliases: string[];
  identifiers: Array<{ scheme: string; value: string }>;
  groundedClaims: number;
  inferredLinks: number;
  observations: number;
  legacyMentions: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface EntityDuplicateCandidate {
  id: string;
  entityType: EntityType;
  confidence: 'high' | 'medium' | 'low';
  score: number;
  suggestedCanonicalId: number;
  entities: EntityDuplicateCandidateEntity[];
  matches: EntityDuplicateMatch[];
  reasons: string[];
  cautions: string[];
}

export interface EntityDuplicateCandidateResult {
  candidates: EntityDuplicateCandidate[];
  total: number;
  /** Number of dismissed entity pairs, not the number of review groups. */
  dismissedCount: number;
  entitiesScanned: number;
}

interface RawEntity {
  id: number;
  entity_type: EntityType;
  canonical_name: string;
  first_seen_at: string;
  last_seen_at: string;
  mention_count: number;
  grounded_claims: number;
  inferred_links: number;
  observations: number;
}

interface NameForm {
  entityId: number;
  source: 'canonical' | 'alias';
  value: string;
}

const GENERIC_EMAIL_LOCAL_PARTS = new Set([
  'admin', 'billing', 'contact', 'hello', 'help', 'info', 'intake', 'leads',
  'marketing', 'office', 'sales', 'support', 'team', 'service', 'customerservice',
]);

const COMMON_TLDS = new Set(['ai', 'app', 'biz', 'co', 'com', 'dev', 'edu', 'gov', 'io', 'law', 'net', 'org', 'us']);

const NICKNAME_FAMILIES = [
  ['andy', 'andrew'],
  ['ben', 'benjamin'],
  ['bill', 'billy', 'will', 'william'],
  ['bob', 'bobby', 'rob', 'robert'],
  ['dan', 'danny', 'daniel'],
  ['dave', 'david'],
  ['jim', 'jimmy', 'james'],
  ['joe', 'joey', 'joseph'],
  ['jon', 'john', 'jonathan'],
  ['kate', 'katie', 'katherine', 'kathryn'],
  ['liz', 'beth', 'elizabeth'],
  ['matt', 'matthew'],
  ['mike', 'michael'],
  ['nate', 'nathan', 'nathaniel'],
  ['nick', 'nicholas'],
  ['rick', 'rich', 'richard'],
  ['steve', 'steven', 'stephen'],
  ['tom', 'tommy', 'thomas'],
];
const NICKNAME_KEY = new Map<string, string>();
for (const family of NICKNAME_FAMILIES) {
  for (const name of family) NICKNAME_KEY.set(name, family[0]);
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function pairIds(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function strongNameForm(value: string, type?: EntityType): string | null {
  const raw = value.trim();
  if (!raw || raw.includes('@') || /^(?:https?:\/\/|www\.)/i.test(raw) || /[/\\]/.test(raw)) return null;
  // Domain-shaped aliases are identifiers, not human/company names.
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(raw)) {
    const suffix = raw.toLowerCase().split('.').at(-1) ?? '';
    if (type !== 'person' || COMMON_TLDS.has(suffix)) return null;
  }
  const normalized = normalizeName(raw);
  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length < 2 || normalized.replace(/[^a-z]/g, '').length < 5) return null;
  return normalized;
}

function isGenericEmail(value: string): boolean {
  const at = value.indexOf('@');
  if (at <= 0) return true;
  const local = value.slice(0, at).replace(/[._+-].*$/, '');
  return GENERIC_EMAIL_LOCAL_PARTS.has(local);
}

function identifierScore(type: EntityType, scheme: string, value: string): number | null {
  if (scheme === 'email') {
    if (isGenericEmail(value)) return null;
    return type === 'person' ? 0.99 : 0.94;
  }
  if (scheme === 'domain') return type === 'company' ? 0.98 : 0.9;
  if (scheme === 'handle') return 0.86;
  if (scheme === 'url') return 0.84;
  if (scheme === 'phone') return 0.8;
  return null;
}

function personNameParts(value: string): { first: string; last: string; middle: string[] } | null {
  const normalized = strongNameForm(value, 'person');
  if (!normalized) return null;
  const tokens = normalized.split(' ');
  if (tokens.length < 2 || tokens.length > 5) return null;
  if (new Set(['jr', 'sr', 'ii', 'iii', 'iv']).has(tokens.at(-1) ?? '')) return null;
  const first = tokens[0];
  const last = tokens.at(-1)!;
  if (first.length < 2 || last.length < 2) return null;
  return { first, last, middle: tokens.slice(1, -1).filter((token) => token.length > 1) };
}

function combinations(ids: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) out.push(pairIds(ids[i], ids[j]));
  }
  return out;
}

function canonicalQuality(entity: EntityDuplicateCandidateEntity): number {
  const name = entity.name.trim();
  const readableName = !name.includes('@') && !/[/\\]/.test(name) && name.includes(' ') ? 30 : 0;
  const casing = /[A-Z]/.test(name) && !name.includes('.') ? 5 : 0;
  return readableName
    + casing
    + Math.min(100, entity.groundedClaims * 8)
    + Math.min(60, entity.observations * 6)
    + Math.min(20, entity.identifiers.length * 4)
    + Math.min(20, Math.log2(entity.legacyMentions + 1) * 3);
}

/**
 * Discover review-only identity clusters. Names, aliases, nicknames, phones,
 * and handles are evidence for a human—not merge authority. Exact personal
 * emails remain the only automatic person convergence path elsewhere.
 */
export function listEntityDuplicateCandidates(options: {
  limit?: number;
  type?: EntityType;
} = {}): EntityDuplicateCandidateResult {
  const db = openMemoryDb();
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  const type = options.type ?? null;
  const rows = db.prepare(`
    SELECT e.id, e.entity_type, e.canonical_name, e.first_seen_at, e.last_seen_at,
           e.mention_count,
           (SELECT COUNT(*) FROM fact_entities fe
             WHERE fe.entity_id = e.id AND fe.link_type <> 'inferred_text') AS grounded_claims,
           (SELECT COUNT(*) FROM fact_entities fe
             WHERE fe.entity_id = e.id AND fe.link_type = 'inferred_text') AS inferred_links,
           (SELECT COUNT(*) FROM entity_observations eo WHERE eo.entity_id = e.id) AS observations
    FROM entities e
    WHERE NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = e.id)
      AND (? IS NULL OR e.entity_type = ?)
    ORDER BY e.id
  `).all(type, type) as RawEntity[];
  if (rows.length < 2) return { candidates: [], total: 0, dismissedCount: 0, entitiesScanned: rows.length };

  const byId = new Map(rows.map((row) => [row.id, row]));
  const aliases = new Map<number, string[]>();
  for (const row of db.prepare(`
    SELECT ea.entity_id, ea.alias
    FROM entity_aliases ea
    JOIN entities e ON e.id = ea.entity_id
    WHERE NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = e.id)
      AND (? IS NULL OR e.entity_type = ?)
    ORDER BY ea.entity_id, ea.confidence DESC, ea.alias_lc
  `).all(type, type) as Array<{ entity_id: number; alias: string }>) {
    const values = aliases.get(row.entity_id) ?? [];
    values.push(row.alias);
    aliases.set(row.entity_id, values);
  }
  const identifiers = new Map<number, Array<{ scheme: string; value: string; valueNorm: string }>>();
  for (const row of db.prepare(`
    SELECT ei.entity_id, ei.scheme, ei.value, ei.value_norm
    FROM entity_identifiers ei
    JOIN entities e ON e.id = ei.entity_id
    WHERE NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = e.id)
      AND (? IS NULL OR e.entity_type = ?)
    ORDER BY ei.entity_id, ei.confidence DESC, ei.scheme, ei.value_norm
  `).all(type, type) as Array<{ entity_id: number; scheme: string; value: string; value_norm: string }>) {
    const values = identifiers.get(row.entity_id) ?? [];
    values.push({ scheme: row.scheme, value: row.value, valueNorm: row.value_norm });
    identifiers.set(row.entity_id, values);
  }

  const dismissedRows = db.prepare(`
    SELECT entity_a_id, entity_b_id
    FROM entity_identity_review_decisions WHERE status = 'dismissed'
  `).all() as Array<{ entity_a_id: number; entity_b_id: number }>;
  const dismissed = new Set(dismissedRows.map((row) => pairKey(row.entity_a_id, row.entity_b_id)));
  const edges = new Map<string, EntityDuplicateMatch[]>();
  const addEdge = (a: number, b: number, basis: EntityDuplicateMatchBasis, score: number, detail: string): void => {
    if (a === b || !byId.has(a) || !byId.has(b)) return;
    const key = pairKey(a, b);
    if (dismissed.has(key)) return;
    const values = edges.get(key) ?? [];
    if (!values.some((match) => match.basis === basis && match.detail === detail)) {
      values.push({ entityIds: pairIds(a, b), basis, score, detail });
      edges.set(key, values);
    }
  };

  const identifierIndex = new Map<string, number[]>();
  for (const entity of rows) {
    for (const identifier of identifiers.get(entity.id) ?? []) {
      const score = identifierScore(entity.entity_type, identifier.scheme, identifier.valueNorm);
      if (score == null) continue;
      const key = `${entity.entity_type}:${identifier.scheme}:${identifier.valueNorm}`;
      const ids = identifierIndex.get(key) ?? [];
      ids.push(entity.id);
      identifierIndex.set(key, ids);
    }
  }
  for (const [key, rawIds] of identifierIndex) {
    const ids = Array.from(new Set(rawIds));
    if (ids.length < 2 || ids.length > 10) continue;
    const [, scheme, ...valueParts] = key.split(':');
    const value = valueParts.join(':');
    const sample = byId.get(ids[0])!;
    const score = identifierScore(sample.entity_type, scheme, value);
    if (score == null) continue;
    for (const [a, b] of combinations(ids)) {
      addEdge(a, b, 'shared_identifier', score, `Both records carry the same ${scheme}: ${value}`);
    }
  }

  const formIndex = new Map<string, NameForm[]>();
  for (const entity of rows) {
    const forms: NameForm[] = [];
    const canonical = strongNameForm(entity.canonical_name, entity.entity_type);
    if (canonical) forms.push({ entityId: entity.id, source: 'canonical', value: entity.canonical_name });
    for (const alias of aliases.get(entity.id) ?? []) {
      if (strongNameForm(alias, entity.entity_type)) forms.push({ entityId: entity.id, source: 'alias', value: alias });
    }
    for (const form of forms) {
      const normalized = strongNameForm(form.value, entity.entity_type)!;
      const key = `${entity.entity_type}:${normalized}`;
      const indexed = formIndex.get(key) ?? [];
      const existing = indexed.find((item) => item.entityId === entity.id);
      if (!existing) indexed.push(form);
      else if (form.source === 'canonical') existing.source = 'canonical';
      formIndex.set(key, indexed);
    }
  }
  for (const [key, forms] of formIndex) {
    const unique = Array.from(new Map(forms.map((form) => [form.entityId, form])).values());
    if (unique.length < 2 || unique.length > 8) continue;
    const normalized = key.slice(key.indexOf(':') + 1);
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const a = unique[i];
        const b = unique[j];
        if (a.source === 'canonical' && b.source === 'canonical') {
          addEdge(a.entityId, b.entityId, 'canonical_equivalent', 0.96, `Canonical names normalize to “${normalized}”.`);
        } else if (a.source === 'canonical' || b.source === 'canonical') {
          addEdge(a.entityId, b.entityId, 'canonical_alias', 0.92, `One canonical name exactly matches the other record’s alias: “${normalized}”.`);
        } else {
          addEdge(a.entityId, b.entityId, 'shared_alias', 0.84, `Both records share the full-name alias “${normalized}”.`);
        }
      }
    }
  }

  const peopleByLast = new Map<string, RawEntity[]>();
  for (const entity of rows) {
    if (entity.entity_type !== 'person') continue;
    const parts = personNameParts(entity.canonical_name);
    if (!parts) continue;
    const people = peopleByLast.get(parts.last) ?? [];
    people.push(entity);
    peopleByLast.set(parts.last, people);
  }
  for (const people of peopleByLast.values()) {
    if (people.length < 2 || people.length > 30) continue;
    for (let i = 0; i < people.length; i += 1) {
      for (let j = i + 1; j < people.length; j += 1) {
        const a = personNameParts(people[i].canonical_name)!;
        const b = personNameParts(people[j].canonical_name)!;
        if (a.last !== b.last) continue;
        const middleCompatible = a.middle.length === 0 || b.middle.length === 0 || a.middle.join(' ') === b.middle.join(' ');
        if (!middleCompatible) continue;
        if (a.first === b.first) {
          addEdge(people[i].id, people[j].id, 'person_name_variant', 0.86, `Same first and last name after ignoring punctuation or a middle initial.`);
          continue;
        }
        const familyA = NICKNAME_KEY.get(a.first);
        const familyB = NICKNAME_KEY.get(b.first);
        if (familyA && familyA === familyB) {
          addEdge(people[i].id, people[j].id, 'person_nickname', 0.74, `“${a.first}” and “${b.first}” are common variants with the same last name “${a.last}”.`);
        }
      }
    }
  }

  const parent = new Map<number, number>();
  const find = (id: number): number => {
    const current = parent.get(id) ?? id;
    if (current === id) { parent.set(id, id); return id; }
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(Math.max(rootA, rootB), Math.min(rootA, rootB));
  };
  for (const matches of edges.values()) union(matches[0].entityIds[0], matches[0].entityIds[1]);
  const components = new Map<number, Set<number>>();
  for (const matches of edges.values()) {
    for (const id of matches[0].entityIds) {
      const root = find(id);
      const component = components.get(root) ?? new Set<number>();
      component.add(id);
      components.set(root, component);
    }
  }

  const summaries = new Map<number, EntityDuplicateCandidateEntity>();
  for (const entity of rows) {
    summaries.set(entity.id, {
      id: entity.id,
      type: entity.entity_type,
      name: entity.canonical_name,
      aliases: Array.from(new Set((aliases.get(entity.id) ?? []).map((value) => value.trim()).filter(Boolean))),
      identifiers: (identifiers.get(entity.id) ?? []).map((identifier) => ({ scheme: identifier.scheme, value: identifier.value })),
      groundedClaims: entity.grounded_claims,
      inferredLinks: entity.inferred_links,
      observations: entity.observations,
      legacyMentions: entity.mention_count,
      firstSeenAt: entity.first_seen_at,
      lastSeenAt: entity.last_seen_at,
    });
  }

  const candidates: EntityDuplicateCandidate[] = [];
  for (const component of components.values()) {
    const ids = Array.from(component).sort((a, b) => a - b);
    if (ids.length < 2) continue;
    const entities = ids.map((id) => summaries.get(id)!).filter(Boolean);
    if (entities.length < 2 || new Set(entities.map((entity) => entity.type)).size !== 1) continue;
    const idSet = new Set(ids);
    const matches = Array.from(edges.values()).flat().filter((match) => idSet.has(match.entityIds[0]) && idSet.has(match.entityIds[1]));
    const score = Math.max(...matches.map((match) => match.score));
    const reasons = Array.from(new Set(matches.map((match) => match.detail))).slice(0, 8);
    const cautions: string[] = [];
    if (!matches.some((match) => match.basis === 'shared_identifier')) {
      cautions.push('No shared stable identifier proves these are the same identity; review is required.');
    }
    const emailSets = entities
      .map((entity) => new Set(entity.identifiers.filter((identifier) => identifier.scheme === 'email').map((identifier) => identifier.value.toLowerCase())))
      .filter((values) => values.size > 0);
    if (emailSets.length >= 2) {
      const common = Array.from(emailSets[0]).some((email) => emailSets.slice(1).every((values) => values.has(email)));
      if (!common) cautions.push('The records carry different email addresses; compare source history before merging.');
    }
    if (entities.some((entity) => entity.observations === 0 && entity.groundedClaims === 0)) {
      cautions.push('At least one record is legacy name-only data without an exact source observation.');
    }
    if (ids.length > 2) cautions.push(`This suggestion connects ${ids.length} records; verify every name before combining the group.`);
    const suggestedCanonicalId = [...entities].sort((a, b) => canonicalQuality(b) - canonicalQuality(a) || a.id - b.id)[0].id;
    const hasStrongIdentifier = matches.some((match) => match.basis === 'shared_identifier' && match.score >= 0.94);
    const hasCanonicalEquivalent = matches.some((match) => match.basis === 'canonical_equivalent');
    candidates.push({
      id: `${entities[0].type}:${ids.join('-')}`,
      entityType: entities[0].type,
      // Exact identifiers and punctuation-equivalent canonical names are strong.
      // Alias-only and nickname-only matches remain review signals, not identity certainty.
      confidence: hasStrongIdentifier || hasCanonicalEquivalent ? 'high' : score >= 0.8 ? 'medium' : 'low',
      score,
      suggestedCanonicalId,
      entities: [...entities].sort((a, b) => (a.id === suggestedCanonicalId ? -1 : b.id === suggestedCanonicalId ? 1 : canonicalQuality(b) - canonicalQuality(a))),
      matches: matches.sort((a, b) => b.score - a.score || a.entityIds[0] - b.entityIds[0]),
      reasons,
      cautions,
    });
  }
  candidates.sort((a, b) => b.score - a.score
    || b.entities.reduce((sum, entity) => sum + entity.groundedClaims + entity.observations, 0)
      - a.entities.reduce((sum, entity) => sum + entity.groundedClaims + entity.observations, 0)
    || a.id.localeCompare(b.id));
  return {
    candidates: candidates.slice(0, limit),
    total: candidates.length,
    dismissedCount: dismissed.size,
    entitiesScanned: rows.length,
  };
}

/** Persist a review dismissal for every pair in a presented candidate group. */
export function dismissEntityDuplicateCandidate(entityIds: number[], reason = 'reviewed as distinct identities'): number {
  const db = openMemoryDb();
  const ids = Array.from(new Set(entityIds.filter((id) => Number.isInteger(id) && id > 0))).sort((a, b) => a - b);
  if (ids.length < 2 || ids.length > 20) throw new Error('identity candidate dismissal requires 2–20 entity ids');
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT e.id, e.entity_type
    FROM entities e
    WHERE e.id IN (${placeholders})
      AND NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = e.id)
  `).all(...ids) as Array<{ id: number; entity_type: EntityType }>;
  if (rows.length !== ids.length) throw new Error('identity candidate contains a missing or redirected entity');
  if (new Set(rows.map((row) => row.entity_type)).size !== 1) throw new Error('identity candidate entities must have the same type');
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO entity_identity_review_decisions
      (entity_a_id, entity_b_id, status, reason, reviewed_at)
    VALUES (?, ?, 'dismissed', ?, ?)
    ON CONFLICT(entity_a_id, entity_b_id) DO UPDATE SET
      status = 'dismissed', reason = excluded.reason, reviewed_at = excluded.reviewed_at
  `);
  let changed = 0;
  db.transaction(() => {
    for (const [a, b] of combinations(ids)) changed += Number(insert.run(a, b, reason.trim().slice(0, 500) || null, now).changes ?? 0);
  })();
  return changed;
}

/** Reopen every dismissed identity suggestion; no memory or identity data changes. */
export function restoreDismissedEntityDuplicateCandidates(): number {
  return Number(openMemoryDb().prepare(`
    DELETE FROM entity_identity_review_decisions WHERE status = 'dismissed'
  `).run().changes ?? 0);
}
