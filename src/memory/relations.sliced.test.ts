/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/relations.sliced.test.ts
 *
 * The link passes must leave memory exactly as the passes they replace did.
 * One fixture (active and inactive facts, 40 same-name "Acmecorp" rows, a
 * uniquely owned domain, a shared first name, a redirect, resources, source
 * evidence that promotes links and states relationships, and one fact whose
 * refresh rewrites about 150 rows) is cloned; the reference passes run on one
 * clone and the current passes on the other, and every table the passes
 * touch is compared. Timestamps written "now" by a pass are masked; nothing
 * else is.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-link-equivalence-'));

const { openMemoryDb, closeMemoryDb, resetMemoryDb, MEMORY_DB_PATH } = await import('./db.js');
const { recordMemoryEpisode, linkFactEvidence } = await import('./temporal-memory.js');
const { upsertResourcePointer } = await import('./source-map.js');
const { groundedEntityMentionIds } = await import('./grounded-entity-mentions.js');
const { exactGroundedIdentifierMatch } = await import('./grounded-identifier-match.js');
const { compileWordMatcher } = await import('./word-match.js');
const relations = await import('./relations.js');
const { SliceClock } = await import('./sliced-pass.js');
const { memoryPassCursorIO } = await import('./pass-cursor.js');

// ── fixture ────────────────────────────────────────────────────────────────

const PEOPLE = [
  'Dana Smith', 'Riley Park', 'Morgan Diaz', 'Casey Nguyen', 'Jordan Blake', 'Taylor Reed', 'Avery Cole',
  'Quinn Harper', 'Rowan Ellis', 'Sage Porter', 'Emerson Hale', 'Finley Brooks', 'Harper Lane', 'Jamie Ortiz',
  'Kendall Price', 'Logan Shaw', 'Micah Ford', 'Noel Grant', 'Parker Wade', 'Reese Knight', 'Skyler Fox',
  'Tatum West', 'Blair Stone', 'Drew Carter', 'Elliot Moss', 'Hayden Cruz', 'Jules Vance', 'Kai Monroe',
];
const COMPANIES = [
  'Northwind Traders', 'Globex', 'Initech', 'Hooli', 'Vandelay Industries', 'Stark Industries',
  'Wayne Enterprises', 'Wonka Industries', 'Tyrell Corporation', 'Cyberdyne Systems', 'Massive Dynamic',
  'Oscorp', 'Aperture Science', 'Black Mesa', 'Monarch Solutions', 'Pied Piper', 'Dunder Mifflin',
];
const THINGS = ['Roadmap', 'Project Falcon', 'Data', 'Email', 'Quarterly Plan'];
const RELATION_PHRASES = ['works at', 'reports to', 'partner at', 'advises', 'customer of'];

// Deterministic pseudo-random generator (mulberry32).
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Fixture {
  heavyFactId: number;
  heavyWanted: number;
  sharedEpisodeId: string;
  sharedFactIds: [number, number];
  rileyId: number;
}

function iso(minutes: number): string {
  return new Date(Date.UTC(2026, 7, 1) + minutes * 60_000).toISOString();
}

function seedFixture(): Fixture {
  resetMemoryDb();
  const db = openMemoryDb();
  const next = rng(20260927);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const insertEntity = db.prepare(`
    INSERT INTO entities (entity_type, canonical_name, canonical_name_lc, aliases_json, first_seen_at, last_seen_at, mention_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAlias = db.prepare(`
    INSERT INTO entity_aliases (entity_id, alias, alias_lc, confidence, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, 0.7, ?, ?)
  `);
  const insertIdentifier = db.prepare(`
    INSERT INTO entity_identifiers (entity_id, scheme, value, value_norm, confidence, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, 0.9, ?, ?)
  `);
  let entityClock = 0;
  const entity = (type: string, name: string, extra: { aliases?: string[]; ids?: Array<[string, string]>; mentions?: number } = {}): number => {
    entityClock += 1;
    const seen = iso(entityClock);
    const id = Number(insertEntity.run(type, name, name.toLowerCase(), '[]', seen, seen, extra.mentions ?? 1 + (entityClock % 7)).lastInsertRowid);
    for (const alias of extra.aliases ?? []) insertAlias.run(id, alias, alias.toLowerCase(), seen, seen);
    for (const [scheme, value] of extra.ids ?? []) insertIdentifier.run(id, scheme, value, value.toLowerCase(), seen, seen);
    return id;
  };

  for (let i = 0; i < 40; i += 1) entity('company', 'Acmecorp', i < 10 ? { ids: [['domain', `acmecorp-${i}.example`]], mentions: 40 - i } : { mentions: 40 - i });
  const people = PEOPLE.map((name) => entity('person', name));
  const companies = COMPANIES.map((name) => entity('company', name));
  entity('company', 'Umbrella Group', { ids: [['domain', 'umbrella.example']] });
  entity('person', 'Alex Adams', { aliases: ['Alex'] });
  entity('person', 'Alex Alvarez', { aliases: ['Alex'] });
  THINGS.forEach((name) => entity(name === 'Project Falcon' ? 'project' : 'thing', name));
  const vendors = Array.from({ length: 70 }, (_, i) => entity('company', `Zeta Vendor ${String(i + 1).padStart(2, '0')}`));
  const redirected = entity('person', 'Dana S', { aliases: ['D. Smith'] });
  db.prepare(`INSERT INTO entity_redirects (source_entity_id, canonical_entity_id, reason, confidence, created_at) VALUES (?, ?, 'fixture', 1, ?)`)
    .run(redirected, people[0], iso(0));

  upsertResourcePointer({ app: 'drive', kind: 'file', name: 'Q3 Pipeline Review.xlsx', ref: 'drive://q3-review' });
  upsertResourcePointer({ app: 'crm', kind: 'app', name: 'CRM', ref: 'crm://home' });
  upsertResourcePointer({ app: 'drive', kind: 'file', name: 'Board Deck 2026', ref: 'drive://deck-a' });
  upsertResourcePointer({ app: 'slides', kind: 'deck', name: 'Board Deck 2026', ref: 'slides://deck-b' });
  upsertResourcePointer({ app: 'docs', kind: 'doc', name: 'Falcon Launch Plan', ref: 'docs://falcon' });

  const insertFact = db.prepare(`
    INSERT INTO consolidated_facts (kind, content, content_hash, active, created_at, updated_at, confidence, trust_level, valid_from)
    VALUES ('project', ?, ?, 1, ?, ?, ?, ?, ?)
  `);
  const templates: Array<() => string> = [
    () => `${pick(PEOPLE)} ${pick(RELATION_PHRASES)} ${pick(COMPANIES)}.`,
    () => `Met ${pick(PEOPLE)} about the Acmecorp renewal and the ${pick(THINGS)}.`,
    () => `Email from ops@umbrella.example about the Umbrella Group contract with ${pick(COMPANIES)}.`,
    () => `Alex attended the ${pick(COMPANIES)} call with Acmecorp.`,
    () => `${pick(PEOPLE)} reviewed Q3 Pipeline Review.xlsx and the CRM before the Board Deck 2026 review.`,
    () => `${pick(COMPANIES)} and ${pick(COMPANIES)} partnered on ${pick(THINGS)} (see Falcon Launch Plan).`,
    () => `Zeta Vendor ${String(1 + Math.floor(next() * 70)).padStart(2, '0')} sent the invoice to ${pick(PEOPLE)}; D. Smith approved.`,
    () => `acmecorp-3.example hosts the portal ${pick(PEOPLE)} uses.`,
  ];
  const factIds: number[] = [];
  for (let i = 0; i < 400; i += 1) {
    const content = `${templates[i % templates.length]!()} [${i}]`;
    const at = iso(1_000 + i * 3 + Math.floor(next() * 2));
    const confidence = next() < 0.5 ? 0.8 : null;
    factIds.push(Number(insertFact.run(content, `fixture-${i}`, at, at, confidence, confidence === null ? 0.6 : null, at).lastInsertRowid));
    if (next() < 0.7) {
      const episode = recordMemoryEpisode({
        kind: 'tool_result', sessionId: `fixture-s-${i}`, callId: `fixture-c-${i}`,
        occurredAt: iso(900 + i), content: `Source note. ${content}`,
        status: next() < 0.08 ? 'missing' : undefined,
        sourceUri: next() < 0.5 ? `fixture://note/${i}` : undefined,
      });
      // Some excerpts carry only the opening words, so a name in the claim
      // is missing from its evidence.
      const excerpt = next() < 0.15 ? content.split(' ').slice(0, 2).join(' ') : content;
      linkFactEvidence({ factId: factIds[i]!, episodeId: episode.id, excerpt, ordinal: 0 });
      if (next() < 0.25) {
        // A second episode naming the same things reinforces a relationship.
        const again = recordMemoryEpisode({
          kind: 'tool_result', sessionId: `fixture-s2-${i}`, callId: `fixture-c2-${i}`,
          occurredAt: iso(950 + i), content: `Follow-up. ${content}`,
        });
        linkFactEvidence({ factId: factIds[i]!, episodeId: again.id, excerpt: content, ordinal: 1 });
      }
    }
  }
  // Two facts share one source episode, so promotion order decides which
  // fact an observation names.
  const shared = recordMemoryEpisode({ kind: 'tool_result', sessionId: 'shared-s', callId: 'shared-c', content: 'Riley Park works at Globex. Riley Park advises Hooli.' });
  const sharedA = Number(insertFact.run('Riley Park works at Globex.', 'fixture-shared-a', iso(3_000), iso(3_000), 0.9, null, iso(3_000)).lastInsertRowid);
  const sharedB = Number(insertFact.run('Riley Park advises Hooli.', 'fixture-shared-b', iso(3_001), iso(3_001), 0.7, null, iso(3_001)).lastInsertRowid);
  linkFactEvidence({ factId: sharedA, episodeId: shared.id, excerpt: 'Riley Park works at Globex.', sourceUri: 'fixture://a' });
  linkFactEvidence({ factId: sharedB, episodeId: shared.id, excerpt: 'Riley Park advises Hooli.', sourceUri: 'fixture://b' });

  // Grounded links written at fact time: the refresh must leave them alone.
  for (const id of factIds.slice(0, 40)) {
    const content = (db.prepare('SELECT content FROM consolidated_facts WHERE id = ?').get(id) as { content: string }).content;
    const named = people.filter((_, i) => content.includes(PEOPLE[i]!)).concat(companies.filter((_, i) => content.includes(COMPANIES[i]!)));
    if (named.length > 0) relations.setFactEntityLinks(id, named.slice(0, 1), { linkType: 'stored' });
  }

  // First refresh, then retire 100 facts: their inferred rows stay behind.
  relations.syncFactEntityLinks();
  relations.syncFactResourceLinks();
  for (const id of factIds.filter((_, i) => i % 4 === 1)) db.prepare('UPDATE consolidated_facts SET active = 0 WHERE id = ?').run(id);

  // One heavy fact: names every Acmecorp row and 50 unique entities, carries
  // 60 stale inferred rows and one wanted row at a downgraded confidence.
  const mentioned = [...PEOPLE.slice(0, 20), ...COMPANIES.slice(0, 10), ...Array.from({ length: 20 }, (_, i) => `Zeta Vendor ${String(i + 1).padStart(2, '0')}`)];
  const heavyContent = `Acmecorp portfolio review with ${mentioned.join(', ')}.`;
  const heavyFactId = Number(insertFact.run(heavyContent, 'fixture-heavy', iso(5_000), iso(5_000), 0.9, null, iso(5_000)).lastInsertRowid);
  const heavyEpisode = recordMemoryEpisode({ kind: 'tool_result', sessionId: 'heavy-s', callId: 'heavy-c', content: heavyContent });
  linkFactEvidence({ factId: heavyFactId, episodeId: heavyEpisode.id, excerpt: heavyContent });
  const stale = vendors.slice(20, 70).concat(companies.slice(10), people.slice(20)).slice(0, 60);
  const seedLink = db.prepare(`INSERT INTO fact_entities (fact_id, entity_id, created_at, link_type, confidence) VALUES (?, ?, ?, 'inferred_text', ?)`);
  for (const id of stale) seedLink.run(heavyFactId, id, iso(0), 0.55);
  seedLink.run(heavyFactId, people[0], iso(0), 0.4);
  return {
    heavyFactId,
    heavyWanted: 40 + mentioned.length,
    sharedEpisodeId: shared.id,
    sharedFactIds: [sharedA, sharedB],
    rileyId: people[1]!,
  };
}

// ── snapshots and table dumps ──────────────────────────────────────────────

const SNAPSHOT = path.join(process.env.CLEMENTINE_HOME!, 'fixture-snapshot.db');

function takeSnapshot(): void {
  openMemoryDb().pragma('wal_checkpoint(TRUNCATE)');
  closeMemoryDb();
  copyFileSync(MEMORY_DB_PATH, SNAPSHOT);
}

function restoreSnapshot(): void {
  closeMemoryDb();
  for (const suffix of ['-wal', '-shm']) if (existsSync(MEMORY_DB_PATH + suffix)) rmSync(MEMORY_DB_PATH + suffix);
  copyFileSync(SNAPSHOT, MEMORY_DB_PATH);
}

/** Every table the passes read or write, with columns stamped "now" by the pass masked. */
const DUMPS: Array<[string, string]> = [
  ['consolidated_facts', 'SELECT * FROM consolidated_facts ORDER BY id'],
  ['fact_entities', 'SELECT fact_id, entity_id, link_type, confidence, evidence_episode_id, evidence_excerpt FROM fact_entities ORDER BY fact_id, entity_id'],
  ['fact_resources', 'SELECT fact_id, resource_id, link_type, confidence, evidence_episode_id, evidence_excerpt FROM fact_resources ORDER BY fact_id, resource_id'],
  ['entity_edges', 'SELECT * FROM entity_edges ORDER BY subject_id, predicate, object_id'],
  ['entity_edge_evidence', 'SELECT subject_id, predicate, object_id, episode_id, excerpt_hash, excerpt, source_uri, source_fact_id, confidence, observed_at, valid_from, valid_to, extraction_method FROM entity_edge_evidence ORDER BY subject_id, predicate, object_id, episode_id, excerpt_hash'],
  ['entity_edge_validity_intervals', 'SELECT subject_id, predicate, object_id, valid_from, valid_to, opened_reason, closed_reason, evidence_episode_id FROM entity_edge_validity_intervals ORDER BY subject_id, predicate, object_id, valid_from'],
  ['entity_observations', 'SELECT entity_id, episode_id, source_fact_id, source_uri, source_kind, confidence, observed_at FROM entity_observations ORDER BY entity_id, episode_id'],
  ['entities', 'SELECT * FROM entities ORDER BY id'],
  ['entity_aliases', 'SELECT * FROM entity_aliases ORDER BY entity_id, alias_lc'],
  ['entity_identifiers', 'SELECT * FROM entity_identifiers ORDER BY entity_id, scheme, value_norm'],
  ['entity_redirects', 'SELECT * FROM entity_redirects ORDER BY source_entity_id'],
];

type Dump = Record<string, unknown[]>;

function dumpTables(db: Database.Database = openMemoryDb()): Dump {
  const out: Dump = {};
  for (const [name, sql] of DUMPS) out[name] = db.prepare(sql).all();
  return out;
}

function assertSameTables(actual: Dump, expected: Dump): void {
  for (const [name] of DUMPS) {
    assert.equal(actual[name]!.length, expected[name]!.length, `${name}: row count`);
    assert.deepEqual(actual[name], expected[name], `${name}: rows`);
  }
}

// ── the reference passes (the per-matcher, full-replace, per-candidate loops) ─

function referenceEntityMatch(text: string, index: ReturnType<ReturnType<typeof relations.entityMatcherInternalsForTest>['entityMatcherIndex']>): number[] {
  const internals = relations.entityMatcherInternalsForTest();
  const ids: number[] = [];
  for (const matcher of internals.candidateEntityMatchers(index, text)) {
    const lower = text.toLowerCase();
    const namesOnly = internals.maskIdentifierSpans(lower);
    const hit = matcher.nameRes.some((re) => re.test(namesOnly)) || matcher.identifiers.some((identifier) => {
      if (identifier.scheme === 'phone') {
        const wanted = identifier.value.replace(/\D/g, '');
        return wanted.length >= 7 && lower.replace(/\D/g, '').includes(wanted);
      }
      return identifier.re?.test(lower) ?? false;
    });
    if (hit) ids.push(matcher.id);
  }
  return ids;
}

function referenceSyncFactEntityLinks(): { factsScanned: number; entitiesConsidered: number; linksWritten: number } {
  const db = openMemoryDb();
  const index = relations.entityMatcherInternalsForTest().entityMatcherIndex(100_000);
  const facts = db.prepare('SELECT id, content FROM consolidated_facts WHERE active = 1 ORDER BY updated_at DESC LIMIT ?').all(5_000) as Array<{ id: number; content: string }>;
  let linksWritten = 0;
  db.transaction(() => {
    for (const fact of facts) {
      const ids = fact.content ? referenceEntityMatch(fact.content, index) : [];
      db.prepare("DELETE FROM fact_entities WHERE fact_id = ? AND link_type = 'inferred_text'").run(fact.id);
      relations.addFactEntityLinksInDatabase(db, fact.id, ids, { linkType: 'inferred_text', confidence: 0.55 });
      linksWritten += ids.length;
    }
  })();
  return { factsScanned: facts.length, entitiesConsidered: index.matchers.length, linksWritten };
}

function referenceSyncFactResourceLinks(): { factsScanned: number; entitiesConsidered: number; linksWritten: number } {
  const db = openMemoryDb();
  const matchers = (db.prepare('SELECT id, name FROM resource_pointers ORDER BY mention_count DESC, last_seen_at DESC LIMIT ?').all(2_000) as Array<{ id: number; name: string }>)
    .map((row) => ({ id: row.id, re: compileWordMatcher((row.name || '').toLowerCase()) }))
    .filter((m): m is { id: number; re: RegExp } => m.re !== null);
  const facts = db.prepare('SELECT id, content FROM consolidated_facts WHERE active = 1 ORDER BY updated_at DESC LIMIT ?').all(5_000) as Array<{ id: number; content: string }>;
  let linksWritten = 0;
  db.transaction(() => {
    for (const fact of facts) {
      const lower = (fact.content || '').toLowerCase();
      const ids: number[] = [];
      if (lower) for (const m of matchers) if (m.re.test(lower)) ids.push(m.id);
      db.prepare("DELETE FROM fact_resources WHERE fact_id = ? AND link_type = 'inferred_text'").run(fact.id);
      relations.addFactResourceLinksInDatabase(db, fact.id, ids, { linkType: 'inferred_text', confidence: 0.55 });
      linksWritten += ids.length;
    }
  })();
  return { factsScanned: facts.length, entitiesConsidered: matchers.length, linksWritten };
}

function referenceBackfillGroundedFactEntityLinks(): Record<string, number> {
  const db = openMemoryDb();
  const internals = relations.entityGroundingInternalsForTest();
  const exact = (text: string, name: string) => compileWordMatcher(name.toLowerCase().replace(/\s+/g, ' ').trim(), 2)?.test(text.toLowerCase()) ?? false;
  const facts = db.prepare(`
    SELECT cf.id, cf.content, cf.confidence, cf.trust_level FROM consolidated_facts cf
    WHERE EXISTS (SELECT 1 FROM fact_entities fe WHERE fe.fact_id = cf.id AND fe.link_type = 'inferred_text')
      AND EXISTS (SELECT 1 FROM fact_evidence fve JOIN memory_episodes me ON me.id = fve.episode_id
                  WHERE fve.fact_id = cf.id AND length(trim(fve.excerpt)) > 0 AND me.status IN ('available','partial'))
    ORDER BY cf.active DESC, cf.updated_at DESC, cf.id DESC LIMIT ?
  `).all(5_000) as Array<{ id: number; content: string; confidence: number | null; trust_level: number | null }>;
  const readEvidence = db.prepare(`
    SELECT fve.episode_id, fve.excerpt, COALESCE(fve.source_uri, me.source_uri) AS source_uri
    FROM fact_evidence fve JOIN memory_episodes me ON me.id = fve.episode_id
    WHERE fve.fact_id = ? AND length(trim(fve.excerpt)) > 0 AND me.status IN ('available','partial')
    ORDER BY me.occurred_at DESC, fve.ordinal ASC LIMIT 12
  `);
  const readCandidates = db.prepare(`
    SELECT fe.entity_id, e.entity_type FROM fact_entities fe JOIN entities e ON e.id = fe.entity_id
    WHERE fe.fact_id = ? AND fe.link_type = 'inferred_text'
      AND NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = e.id)
    ORDER BY e.mention_count DESC, e.id
  `);
  const readIdentifiers = db.prepare(`SELECT scheme, value_norm FROM entity_identifiers WHERE entity_id = ? AND scheme IN ('email','domain') ORDER BY confidence DESC`);
  const index = internals.buildEntityGroundingIndex(db);
  const stats = { factsScanned: facts.length, evidenceScanned: 0, candidates: 0, promoted: 0, ambiguous: 0, ignored: 0 };
  for (const fact of facts) {
    const evidence = readEvidence.all(fact.id) as Array<{ episode_id: string; excerpt: string; source_uri: string | null }>;
    stats.evidenceScanned += evidence.length;
    const candidates = readCandidates.all(fact.id) as Array<{ entity_id: number; entity_type: string }>;
    const claimNames = new Set(groundedEntityMentionIds(internals.maskIdentifierSpans(fact.content), index.mentions, true));
    const evidenceNames = new Map(evidence.map((item) => [item, new Set(groundedEntityMentionIds(internals.maskIdentifierSpans(item.excerpt), index.mentions, true))]));
    for (const candidate of candidates) {
      stats.candidates += 1;
      const names = internals.entityNamesForBackfill(db, candidate.entity_id);
      const strongNames = names.filter((name) => {
        const normalized = name.toLowerCase().replace(/\s+/g, ' ').trim();
        const specificEnough = candidate.entity_type === 'person' ? normalized.split(' ').length >= 2 : normalized.length >= 3;
        return specificEnough && (index.nameOwners.get(normalized)?.size ?? 0) === 1;
      });
      const identifiers = readIdentifiers.all(candidate.entity_id) as Array<{ scheme: string; value_norm: string }>;
      let supporting: { episode_id: string; excerpt: string; source_uri: string | null } | undefined;
      for (const item of evidence) {
        const nameSupported = claimNames.has(candidate.entity_id) && evidenceNames.get(item)!.has(candidate.entity_id)
          && strongNames.some((name) => exact(fact.content, name) && exact(item.excerpt, name));
        const identifierSupported = identifiers.some((identifier) =>
          (index.identifierOwners.get(`${identifier.scheme}:${identifier.value_norm}`)?.size ?? 0) === 1
          && exactGroundedIdentifierMatch(fact.content, identifier.value_norm)
          && exactGroundedIdentifierMatch(item.excerpt, identifier.value_norm));
        if (nameSupported || identifierSupported) { supporting = item; break; }
      }
      if (!supporting) {
        if (names.some((name) => exact(fact.content, name) && evidence.some((item) => exact(item.excerpt, name)))) stats.ambiguous += 1;
        else stats.ignored += 1;
        continue;
      }
      relations.addFactEntityLinksInDatabase(db, fact.id, [candidate.entity_id], {
        linkType: 'extracted', confidence: fact.confidence ?? fact.trust_level ?? 0.7,
        evidenceEpisodeId: supporting.episode_id, evidenceExcerpt: supporting.excerpt,
        sourceUri: supporting.source_uri ?? undefined, sourceKind: 'fact_backfill', incrementMention: false,
      });
      stats.promoted += 1;
    }
  }
  return stats;
}

/** The resource backfill as one ORDER BY … LIMIT statement and a per-candidate loop. */
function referenceBackfillGroundedFactResourceLinks(): Record<string, number> {
  const db = openMemoryDb();
  const internals = relations.entityGroundingInternalsForTest();
  const facts = db.prepare(`
    SELECT cf.id, cf.content, cf.confidence, cf.trust_level FROM consolidated_facts cf
    WHERE EXISTS (SELECT 1 FROM fact_resources fr WHERE fr.fact_id = cf.id AND fr.link_type = 'inferred_text')
      AND EXISTS (SELECT 1 FROM fact_evidence fve JOIN memory_episodes me ON me.id = fve.episode_id
                  WHERE fve.fact_id = cf.id AND length(trim(fve.excerpt)) > 0 AND me.status IN ('available','partial'))
    ORDER BY cf.active DESC, cf.updated_at DESC, cf.id DESC LIMIT ?
  `).all(5_000) as Array<{ id: number; content: string; confidence: number | null; trust_level: number | null }>;
  const readEvidence = db.prepare(`
    SELECT fve.episode_id, fve.excerpt FROM fact_evidence fve JOIN memory_episodes me ON me.id = fve.episode_id
    WHERE fve.fact_id = ? AND length(trim(fve.excerpt)) > 0 AND me.status IN ('available','partial')
    ORDER BY me.occurred_at DESC, fve.ordinal ASC LIMIT 12
  `);
  const readCandidates = db.prepare(`
    SELECT fr.resource_id, rp.app, rp.kind, rp.name FROM fact_resources fr JOIN resource_pointers rp ON rp.id = fr.resource_id
    WHERE fr.fact_id = ? AND fr.link_type = 'inferred_text' ORDER BY rp.mention_count DESC, rp.id ASC
  `);
  const owners = internals.buildResourceNameOwners(db);
  const stats = { factsScanned: facts.length, evidenceScanned: 0, candidates: 0, promoted: 0, ambiguous: 0, ignored: 0 };
  for (const fact of facts) {
    const evidence = readEvidence.all(fact.id) as Array<{ episode_id: string; excerpt: string }>;
    stats.evidenceScanned += evidence.length;
    for (const candidate of readCandidates.all(fact.id) as Array<{ resource_id: number; app: string; kind: string; name: string }>) {
      stats.candidates += 1;
      const factMatch = internals.exactResourceNameMatch(fact.content, candidate.name);
      const supporting = factMatch ? evidence.find((item) => internals.exactResourceNameMatch(item.excerpt, candidate.name)) : undefined;
      if (!factMatch || !supporting || !internals.resourceNameSpecificEnough(candidate.name, candidate.app, candidate.kind)) { stats.ignored += 1; continue; }
      if ((owners.get(internals.normalizedResourceGroundingName(candidate.name))?.size ?? 0) !== 1) { stats.ambiguous += 1; continue; }
      relations.addFactResourceLinksInDatabase(db, fact.id, [candidate.resource_id], {
        linkType: 'extracted', confidence: fact.confidence ?? fact.trust_level ?? 0.7,
        evidenceEpisodeId: supporting.episode_id, evidenceExcerpt: supporting.excerpt,
      });
      stats.promoted += 1;
    }
  }
  return stats;
}

/** The relationship backfill as one ORDER BY … LIMIT statement (with the correlated count) and a per-row loop. */
function referenceBackfillGroundedEntityRelationships(): Record<string, number> {
  const db = openMemoryDb();
  const internals = relations.entityGroundingInternalsForTest();
  const rows = db.prepare(`
    SELECT cf.id AS fact_id, cf.confidence, cf.trust_level, cf.valid_from, cf.valid_to, fe.episode_id, fe.excerpt, fe.source_uri
    FROM consolidated_facts cf
    JOIN fact_evidence fe ON fe.fact_id = cf.id AND length(trim(fe.excerpt)) > 0
    JOIN memory_episodes me ON me.id = fe.episode_id AND me.status IN ('available','partial')
    WHERE cf.active = 1 AND (SELECT COUNT(*) FROM fact_entities link WHERE link.fact_id = cf.id) >= 2
    ORDER BY cf.updated_at DESC, fe.ordinal ASC LIMIT ?
  `).all(5_000) as Array<{
    fact_id: number; confidence: number | null; trust_level: number | null; valid_from: string | null; valid_to: string | null;
    episode_id: string; excerpt: string; source_uri: string | null;
  }>;
  const stats = { factsScanned: new Set(rows.map((row) => row.fact_id)).size, evidenceScanned: rows.length, candidates: 0, added: 0, reinforced: 0, ignored: 0 };
  const names = new Map<number, string[]>();
  for (const row of rows) {
    const excerptLower = row.excerpt.toLowerCase();
    const phrases = internals.relationshipPredicates.filter((phrase) => excerptLower.includes(phrase));
    if (phrases.length === 0) continue;
    const ids = relations.getEntityIdsForFact(row.fact_id).slice(0, 12);
    for (const id of ids) if (!names.has(id)) names.set(id, internals.entityNamesForBackfill(db, id));
    const emitted = new Set<string>();
    for (const subjectId of ids) {
      for (const objectId of ids) {
        if (subjectId === objectId) continue;
        const predicate = internals.explicitlyStatedRelationship(row.excerpt, names.get(subjectId) ?? [], names.get(objectId) ?? [], phrases);
        if (!predicate) continue;
        const key = `${subjectId}:${predicate}:${objectId}`;
        if (emitted.has(key)) continue;
        emitted.add(key);
        stats.candidates += 1;
        const result = relations.recordGroundedEntityRelationship({
          subjectId, predicate, objectId, evidenceEpisodeId: row.episode_id, evidenceExcerpt: row.excerpt, sourceText: row.excerpt,
          sourceUri: row.source_uri ?? undefined, sourceFactId: row.fact_id, confidence: row.confidence ?? row.trust_level ?? 0.7,
          validFrom: row.valid_from ?? undefined, validTo: row.valid_to ?? undefined, extractionMethod: 'fact_backfill',
        });
        if (result.outcome === 'add') stats.added += 1;
        else if (result.outcome === 'reinforce' || result.outcome === 'supersede') stats.reinforced += 1;
        else stats.ignored += 1;
      }
    }
  }
  return stats;
}

// ── pins ───────────────────────────────────────────────────────────────────

let fixture: Fixture;
let reference: { dump: Dump; stats: Record<string, unknown> };

before(() => {
  fixture = seedFixture();
  takeSnapshot();
  restoreSnapshot();
  const stats = {
    factEntityLinks: referenceSyncFactEntityLinks(),
    factResourceLinks: referenceSyncFactResourceLinks(),
    groundedFactEntityLinks: referenceBackfillGroundedFactEntityLinks(),
    groundedFactResourceLinks: referenceBackfillGroundedFactResourceLinks(),
    relationships: referenceBackfillGroundedEntityRelationships(),
  };
  reference = { dump: dumpTables(), stats };
});

test('the fixture exercises what the equivalence claims', (t) => {
  t.diagnostic(JSON.stringify(reference.stats));
  const stats = reference.stats as {
    factEntityLinks: { linksWritten: number };
    groundedFactEntityLinks: { promoted: number; ambiguous: number; ignored: number };
    groundedFactResourceLinks: { promoted: number; ambiguous: number };
    relationships: { added: number; reinforced: number };
  };
  assert.ok(stats.factEntityLinks.linksWritten > 1_000, `links ${stats.factEntityLinks.linksWritten}`);
  assert.ok(stats.groundedFactEntityLinks.promoted > 20, `promoted ${stats.groundedFactEntityLinks.promoted}`);
  assert.ok(stats.groundedFactEntityLinks.ambiguous > 100, 'shared names stay ambiguous');
  assert.ok(stats.groundedFactEntityLinks.ignored > 0);
  assert.ok(stats.groundedFactResourceLinks.promoted > 0 && stats.groundedFactResourceLinks.ambiguous > 0);
  assert.ok(stats.relationships.added > 0 && stats.relationships.reinforced > 0, JSON.stringify(stats.relationships));
  // Two facts promote the same person from one shared episode: the fact
  // processed first names the observation, so processing order is pinned.
  const observations = reference.dump.entity_observations as Array<{ entity_id: number; episode_id: string; source_fact_id: number }>;
  const sharedObservation = observations.find((row) => row.entity_id === fixture.rileyId && row.episode_id === fixture.sharedEpisodeId);
  assert.equal(sharedObservation?.source_fact_id, fixture.sharedFactIds[1], 'the newer fact is processed first');
  const inactive = (reference.dump.consolidated_facts as Array<{ active: number }>).filter((row) => row.active === 0).length;
  assert.equal(inactive, 100);
  assert.ok((reference.dump.fact_entities as Array<{ fact_id: number }>).some((row) => row.fact_id === fixture.heavyFactId));
});

test('the synchronous passes leave memory exactly as the reference passes do', () => {
  restoreSnapshot();
  const stats = {
    factEntityLinks: relations.syncFactEntityLinks(),
    factResourceLinks: relations.syncFactResourceLinks(),
    groundedFactEntityLinks: relations.backfillGroundedFactEntityLinks(),
    groundedFactResourceLinks: relations.backfillGroundedFactResourceLinks(),
    relationships: relations.backfillGroundedEntityRelationships(),
  };
  assert.deepEqual(stats, reference.stats);
  assertSameTables(dumpTables(), reference.dump);
});

// ── diff writes: a refresh writes only the rows that change ────────────────

/** Counts row writes on the link tables through TEMP triggers on this connection. */
function rowWriteMeter(db: Database.Database = openMemoryDb()): () => number {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS link_row_writes (n INTEGER NOT NULL);
    DELETE FROM temp.link_row_writes;
    INSERT INTO temp.link_row_writes (n) VALUES (0);
  `);
  for (const table of ['fact_entities', 'fact_resources', 'entity_edges']) {
    for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS meter_${table}_${op.toLowerCase()} AFTER ${op} ON main.${table}
        BEGIN UPDATE temp.link_row_writes SET n = n + 1; END;`);
    }
  }
  return () => (db.prepare('SELECT n FROM temp.link_row_writes').get() as { n: number }).n;
}

function generation(db: Database.Database = openMemoryDb()): number {
  return (db.prepare('SELECT generation FROM memory_generation WHERE id = 1').get() as { generation: number }).generation;
}

test('a refresh over unchanged memory writes no row and leaves the memory generation alone', () => {
  restoreSnapshot();
  relations.syncFactEntityLinks();
  relations.syncFactResourceLinks();
  const writes = rowWriteMeter();
  const before = generation();
  relations.syncFactEntityLinks();
  relations.syncFactResourceLinks();
  assert.equal(writes(), 0);
  assert.equal(generation(), before);
});

test('a refresh keeps the created_at of every inferred row it leaves unchanged', () => {
  restoreSnapshot();
  const read = () => new Map((openMemoryDb().prepare(`
    SELECT fact_id || ':' || entity_id AS k, created_at, confidence, evidence_episode_id FROM fact_entities WHERE link_type = 'inferred_text'
  `).all() as Array<{ k: string; created_at: string; confidence: number; evidence_episode_id: string | null }>).map((row) => [row.k, row]));
  const before = read();
  relations.syncFactEntityLinks();
  const after = read();
  let kept = 0;
  for (const [key, row] of after) {
    const old = before.get(key);
    if (!old || old.confidence !== row.confidence) continue;
    assert.equal(row.created_at, old.created_at, key);
    kept += 1;
  }
  assert.ok(kept > 1_000, `kept ${kept}`);
});

test('the heavy fact is refreshed by exactly its difference: stale rows out, missing rows in, the downgraded row rewritten', () => {
  restoreSnapshot();
  const db = openMemoryDb();
  const tier = () => (db.prepare(`SELECT entity_id, confidence FROM fact_entities WHERE fact_id = ? AND link_type = 'inferred_text' ORDER BY entity_id`)
    .all(fixture.heavyFactId) as Array<{ entity_id: number; confidence: number }>);
  const old = tier();
  assert.equal(old.length, 61);
  const writes = rowWriteMeter(db);
  const content = (db.prepare('SELECT content FROM consolidated_facts WHERE id = ?').get(fixture.heavyFactId) as { content: string }).content;
  const wanted = relations.resolveEntityIdsForText(content, 100_000);
  relations.setFactEntityLinks(fixture.heavyFactId, wanted, { linkType: 'inferred_text', confidence: 0.55 });
  const now = tier();
  const nowIds = new Set(now.map((row) => row.entity_id));
  const grounded = new Set((db.prepare(`SELECT entity_id FROM fact_entities WHERE fact_id = ? AND link_type <> 'inferred_text'`)
    .all(fixture.heavyFactId) as Array<{ entity_id: number }>).map((row) => row.entity_id));
  const expected = new Set(wanted.filter((id) => !grounded.has(id)));
  assert.deepEqual(nowIds, expected);
  assert.ok(now.every((row) => row.confidence === 0.55));
  const oldIds = new Set(old.map((row) => row.entity_id));
  const deleted = old.filter((row) => !expected.has(row.entity_id) || row.confidence !== 0.55).length;
  const inserted = [...expected].filter((id) => !oldIds.has(id) || old.find((row) => row.entity_id === id)!.confidence !== 0.55).length;
  assert.equal(writes(), deleted + inserted);
  assert.ok(deleted + inserted >= 150, `the heavy diff is ${deleted + inserted} rows`);
});

// ── sliced passes: same memory, bounded slices, a turn between slices ──────

const TEST_SLICE = { maxMs: Number.POSITIVE_INFINITY, maxUnits: 50, maxWrites: 100 };

/** Counts macrotask turns that ran while the code under test was awaited. */
function turnCounter(): { stop: () => number } {
  let turns = 0;
  let on = true;
  (function tick() {
    turns += 1;
    if (on) setImmediate(tick);
  })();
  return { stop: () => { on = false; return turns; } };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function heavyTier(db: Database.Database = openMemoryDb()): Set<string> {
  return new Set((db.prepare(`SELECT entity_id, confidence FROM fact_entities WHERE fact_id = ? AND link_type = 'inferred_text'`)
    .all(fixture.heavyFactId) as Array<{ entity_id: number; confidence: number }>).map((row) => `${row.entity_id}:${row.confidence}`));
}

test('the sliced passes leave memory exactly as the reference passes do, with a turn at least every 50 units or 100 row writes', async () => {
  // The heavy fact's tier before and after its refresh.
  restoreSnapshot();
  const heavyBefore = heavyTier();
  relations.syncFactEntityLinks();
  const heavyAfter = heavyTier();
  restoreSnapshot();

  const db = openMemoryDb();
  const meter = rowWriteMeter(db);
  let metered = 0;
  const writesBetweenTurns: number[] = [];
  const slices: Array<{ units: number; writes: number }> = [];
  const problems: string[] = [];
  let checkHeavy = false;
  let heavySplit = false;
  const clock = new SliceClock(TEST_SLICE, {
    onSlice: (slice) => slices.push({ units: slice.units, writes: slice.writes }),
    yieldTurn: async () => {
      if (db.inTransaction) problems.push('a turn inside a transaction');
      const now = meter();
      writesBetweenTurns.push(now - metered);
      metered = now;
      if (checkHeavy) {
        const tier = heavyTier(db);
        for (const row of tier) if (!heavyBefore.has(row) && !heavyAfter.has(row)) problems.push(`heavy tier gained ${row} outside old ∪ new`);
        for (const row of heavyBefore) if (heavyAfter.has(row) && !tier.has(row)) problems.push(`heavy tier lost ${row} from old ∩ new`);
        const same = (a: Set<string>) => a.size === tier.size && [...a].every((row) => tier.has(row));
        if (!same(heavyBefore) && !same(heavyAfter)) heavySplit = true;
      }
      await nextTurn();
    },
  });

  const counter = turnCounter();
  checkHeavy = true;
  const factEntityLinks = await relations.syncFactEntityLinksAsync({ clock });
  checkHeavy = false;
  const stats = {
    factEntityLinks,
    factResourceLinks: await relations.syncFactResourceLinksAsync({ clock }),
    groundedFactEntityLinks: await relations.backfillGroundedFactEntityLinksAsync({ clock }),
    groundedFactResourceLinks: await relations.backfillGroundedFactResourceLinksAsync({ clock }),
    relationships: await relations.backfillGroundedEntityRelationshipsAsync({ clock }),
  };
  const loopTurns = counter.stop();
  writesBetweenTurns.push(meter() - metered);

  assert.deepEqual(stats, reference.stats);
  assertSameTables(dumpTables(), reference.dump);
  assert.deepEqual(problems, []);
  assert.ok(heavySplit, "the heavy fact's difference was written across more than one slice");
  for (const slice of slices) {
    assert.ok(slice.units <= TEST_SLICE.maxUnits, `a slice counted ${slice.units} units`);
    assert.ok(slice.writes <= TEST_SLICE.maxWrites, `a slice counted ${slice.writes} writes`);
  }
  assert.ok(Math.max(...writesBetweenTurns) <= TEST_SLICE.maxWrites, `metered row writes between turns: max ${Math.max(...writesBetweenTurns)}`);
  const { units } = clock.totals;
  assert.ok(clock.turns >= Math.ceil(units / TEST_SLICE.maxUnits) - 1, `${clock.turns} turns for ${units} units`);
  assert.ok(loopTurns >= clock.turns, `the loop ran ${loopTurns} turns during ${clock.turns} pass turns`);
});

function failingClock(failAtTurn: number): SliceClock {
  let turns = 0;
  return new SliceClock(TEST_SLICE, {
    yieldTurn: async () => {
      turns += 1;
      if (turns === failAtTurn) throw new Error('the process stopped');
      await nextTurn();
    },
  });
}

test('an interrupted pass resumes after its last committed slice and ends exactly as an uninterrupted run', async () => {
  restoreSnapshot();
  const cursor = memoryPassCursorIO();
  const day = '2026-09-27';
  const options = { cursor, day, cursorWriteIntervalMs: 0 };
  const ids = relations.LINK_PASS_IDS;

  await assert.rejects(relations.syncFactEntityLinksAsync({ ...options, clock: failingClock(6) }), /the process stopped/);
  const syncCursor = cursor.read(ids.entitySync);
  assert.equal(syncCursor?.attempts, 1);
  assert.equal(typeof syncCursor?.after, 'number', 'the entity refresh recorded the last fact it finished');
  const factEntityLinks = await relations.syncFactEntityLinksAsync({ ...options, clock: new SliceClock(TEST_SLICE) });
  assert.equal(cursor.read(ids.entitySync), null, 'a finished pass clears its cursor');

  const factResourceLinks = await relations.syncFactResourceLinksAsync({ ...options, clock: new SliceClock(TEST_SLICE) });

  await assert.rejects(relations.backfillGroundedFactEntityLinksAsync({ ...options, clock: failingClock(12) }), /the process stopped/);
  const backfillCursor = cursor.read(ids.entityBackfill);
  assert.ok(backfillCursor?.partial, 'the grounding pass stopped inside a fact and recorded the candidates it had decided');
  const groundedFactEntityLinks = await relations.backfillGroundedFactEntityLinksAsync({ ...options, clock: new SliceClock(TEST_SLICE) });

  await assert.rejects(relations.backfillGroundedFactResourceLinksAsync({ ...options, clock: failingClock(4) }), /the process stopped/);
  const groundedFactResourceLinks = await relations.backfillGroundedFactResourceLinksAsync({ ...options, clock: new SliceClock(TEST_SLICE) });

  await assert.rejects(relations.backfillGroundedEntityRelationshipsAsync({
    ...options,
    clock: new SliceClock({ ...TEST_SLICE, maxUnits: 20 }, {
      yieldTurn: (() => { let turns = 0; return async () => { turns += 1; if (turns === 6) throw new Error('the process stopped'); await nextTurn(); }; })(),
    }),
  }), /the process stopped/);
  assert.ok(cursor.read(ids.relationships)?.after, 'the relationship pass recorded the last evidence row it finished');
  const relationships = await relations.backfillGroundedEntityRelationshipsAsync({ ...options, clock: new SliceClock(TEST_SLICE) });

  assert.deepEqual(
    { factEntityLinks, factResourceLinks, groundedFactEntityLinks, groundedFactResourceLinks, relationships },
    reference.stats,
  );
  assertSameTables(dumpTables(), reference.dump);
  assert.equal(cursor.cursors.size, 0);
});

test('a pass resumes at most once a day: the third attempt starts over', async () => {
  restoreSnapshot();
  const cursor = memoryPassCursorIO();
  const day = '2026-09-27';
  const id = relations.LINK_PASS_IDS.entityBackfill;
  await assert.rejects(relations.backfillGroundedFactEntityLinksAsync({ cursor, day, cursorWriteIntervalMs: 0, clock: failingClock(8) }));
  assert.equal(cursor.read(id)?.attempts, 1);
  await assert.rejects(relations.backfillGroundedFactEntityLinksAsync({ cursor, day, cursorWriteIntervalMs: 0, clock: failingClock(8) }));
  const second = cursor.read(id);
  assert.equal(second?.attempts, 2);
  assert.ok(second?.after !== null || second?.partial !== null, 'the second attempt resumed and moved on');

  const writes: Array<{ attempts: number; after: unknown; stats: unknown }> = [];
  const watched = {
    read: cursor.read,
    clear: cursor.clear,
    write: (passId: string, value: Parameters<typeof cursor.write>[1]) => {
      writes.push({ attempts: value.attempts, after: value.after, stats: value.stats });
      cursor.write(passId, value);
    },
  };
  const third = await relations.backfillGroundedFactEntityLinksAsync({ cursor: watched, day, cursorWriteIntervalMs: 0, clock: new SliceClock(TEST_SLICE) });
  assert.deepEqual(writes[0], { attempts: 3, after: null, stats: null }, 'the third attempt starts from the beginning');
  const uninterrupted = reference.stats as { groundedFactEntityLinks: { factsScanned: number; promoted: number } };
  // Counted afresh: facts whose every candidate the earlier attempts promoted
  // are no longer selected, and those links are no longer candidates.
  assert.ok(third.factsScanned < uninterrupted.groundedFactEntityLinks.factsScanned);
  assert.ok(third.promoted < uninterrupted.groundedFactEntityLinks.promoted);
  assert.equal(cursor.read(id), null);

  // A cursor left from another day is not resumed: the attempt is the day's first.
  await assert.rejects(relations.backfillGroundedFactEntityLinksAsync({ cursor, day, cursorWriteIntervalMs: 0, clock: failingClock(8) }));
  const nextDay = writes.length;
  await relations.backfillGroundedFactEntityLinksAsync({ cursor: watched, day: '2026-09-28', cursorWriteIntervalMs: 0, clock: new SliceClock(TEST_SLICE) });
  assert.deepEqual(writes[nextDay], { attempts: 1, after: null, stats: null });
  assert.equal(cursor.read(id), null);
});

test('the paged selections return the same rows in the same order as the one-statement selections', () => {
  restoreSnapshot();
  const db = openMemoryDb();
  const legacyBackfill = (db.prepare(`
    SELECT cf.id FROM consolidated_facts cf
    WHERE EXISTS (SELECT 1 FROM fact_entities fe WHERE fe.fact_id = cf.id AND fe.link_type = 'inferred_text')
      AND EXISTS (SELECT 1 FROM fact_evidence fve JOIN memory_episodes me ON me.id = fve.episode_id
                  WHERE fve.fact_id = cf.id AND length(trim(fve.excerpt)) > 0 AND me.status IN ('available','partial'))
    ORDER BY cf.active DESC, cf.updated_at DESC, cf.id DESC LIMIT 5000
  `).all() as Array<{ id: number }>).map((row) => row.id);
  const legacyRelationships = (db.prepare(`
    SELECT cf.id AS fact_id, fe.episode_id FROM consolidated_facts cf
    JOIN fact_evidence fe ON fe.fact_id = cf.id AND length(trim(fe.excerpt)) > 0
    JOIN memory_episodes me ON me.id = fe.episode_id AND me.status IN ('available','partial')
    WHERE cf.active = 1 AND (SELECT COUNT(*) FROM fact_entities link WHERE link.fact_id = cf.id) >= 2
    ORDER BY cf.updated_at DESC, fe.ordinal ASC LIMIT 5000
  `).all() as Array<{ fact_id: number; episode_id: string }>).map((row) => `${row.fact_id}:${row.episode_id}`);
  const selection = relations.linkPassSelectionsForTest(db);
  assert.deepEqual(selection.groundingFactIds('fact_entities', 5_000), legacyBackfill);
  assert.deepEqual(selection.relationshipRows(5_000), legacyRelationships);
  assert.ok(legacyBackfill.length > 100 && legacyRelationships.length > 100);
});
