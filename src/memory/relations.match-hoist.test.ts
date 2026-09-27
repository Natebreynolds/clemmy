/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/relations.match-hoist.test.ts
 *
 * Matching a text reads it once (lowercase, identifier mask, digits) for every
 * candidate matcher. The ids and their order must equal the reference loop
 * that lowercased and masked the text again for each matcher.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-match-hoist-'));

const { openMemoryDb, resetMemoryDb } = await import('./db.js');
const { entityMatcherInternalsForTest, resolveEntityIdsForText } = await import('./relations.js');

type Internals = ReturnType<typeof entityMatcherInternalsForTest>;
type Index = ReturnType<Internals['entityMatcherIndex']>;
type Matcher = Index['matchers'][number];

/** The per-matcher loop as it was: lowercase and mask the text for every matcher. */
function referenceMatch(internals: Internals, index: Index, text: string, limit = Number.POSITIVE_INFINITY): number[] {
  const matches = (matcher: Matcher): boolean => {
    const lower = text.toLowerCase();
    const namesOnly = internals.maskIdentifierSpans(lower);
    return matcher.nameRes.some((re) => re.test(namesOnly))
      || matcher.identifiers.some((identifier) => {
        if (identifier.scheme === 'phone') {
          const wanted = identifier.value.replace(/\D/g, '');
          return wanted.length >= 7 && lower.replace(/\D/g, '').includes(wanted);
        }
        return identifier.re?.test(lower) ?? false;
      });
  };
  const matched: number[] = [];
  for (const matcher of internals.candidateEntityMatchers(index, text)) {
    if (matches(matcher)) matched.push(matcher.id);
    if (matched.length >= limit) break;
  }
  return matched;
}

function seedEntities(): void {
  const db = openMemoryDb();
  const insert = db.prepare(`
    INSERT INTO entities (entity_type, canonical_name, canonical_name_lc, aliases_json, first_seen_at, last_seen_at, mention_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const alias = db.prepare(`
    INSERT INTO entity_aliases (entity_id, alias, alias_lc, confidence, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, 0.7, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `);
  const identifier = db.prepare(`
    INSERT INTO entity_identifiers (entity_id, scheme, value, value_norm, confidence, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, 0.9, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `);
  const add = (type: string, name: string, extra: { aliases?: string[]; json?: string[]; ids?: Array<[string, string]>; mentions?: number } = {}) => {
    const id = Number(insert.run(type, name, name.toLowerCase(), JSON.stringify(extra.json ?? []),
      '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', extra.mentions ?? 1).lastInsertRowid);
    for (const a of extra.aliases ?? []) alias.run(id, a, a.toLowerCase());
    for (const [scheme, value] of extra.ids ?? []) identifier.run(id, scheme, value, value.toLowerCase());
    return id;
  };
  for (let i = 0; i < 12; i += 1) add('company', 'Acmecorp', { mentions: 12 - i, ids: [['domain', `acme${i}.example`]] });
  add('person', 'Dana Smith', { aliases: ['Dana'], ids: [['email', 'dana@acmecorp.example'], ['phone', '4155550100']], mentions: 9 });
  add('person', 'Riley Park', { json: ['R. Park'], ids: [['handle', '@rileyp']], mentions: 3 });
  add('company', 'Umbrella Group', { ids: [['domain', 'umbrella.example']], mentions: 5 });
  add('company', 'Northwind Traders', { aliases: ['Northwind'], mentions: 7 });
  add('project', 'Q3 Pipeline Review', { mentions: 2 });
  add('thing', 'Roadmap', { mentions: 4 });
  add('person', 'Sam Lee', { ids: [['phone', '(212) 555-0199'], ['phone', '555']], mentions: 1 });
  add('company', 'Initech', { json: ['initech.example'], mentions: 1 });
  add('person', 'Zoë Café', { mentions: 1 });
}

const TEXTS = [
  '',
  'Nothing matches here.',
  'Acmecorp renewed with Dana Smith today.',
  'Email dana@acmecorp.example about the acme3.example domain.',
  'Visit https://umbrella.example/pricing and umbrella.example for Umbrella Group.',
  'Ping @rileyp; R. Park and Riley Park both replied.',
  'Call 415-555-0100 or (212) 555 0199 about the Q3 Pipeline Review.',
  'Northwind Traders (Northwind) shares a Roadmap with Initech and initech.example.',
  'northwinds is not Northwind; acmecorporate is not Acmecorp.',
  'ZOË CAFÉ and zoë café opened; DANA SMITH signed.',
  'A long note: Acmecorp, Dana, Sam Lee, 555, Umbrella Group, Roadmap, Riley Park, Northwind.',
];

before(() => {
  resetMemoryDb();
  seedEntities();
});

test('matchEntityIdsInText equals the per-matcher reference loop, ids and order', () => {
  const internals = entityMatcherInternalsForTest();
  const index = internals.entityMatcherIndex();
  for (const text of TEXTS) {
    assert.deepEqual(internals.matchEntityIdsInText(index, text), referenceMatch(internals, index, text), text);
    for (const limit of [0, 1, 2, 5, 8]) {
      assert.deepEqual(internals.matchEntityIdsInText(index, text, limit), referenceMatch(internals, index, text, limit), `${text} limit=${limit}`);
    }
  }
});

test('resolveEntityIdsForText keeps its guard and limit', () => {
  const internals = entityMatcherInternalsForTest();
  const index = internals.entityMatcherIndex();
  assert.deepEqual(resolveEntityIdsForText('   '), []);
  for (const text of TEXTS.filter((t) => t.trim())) {
    assert.deepEqual(resolveEntityIdsForText(text), referenceMatch(internals, index, text, 8));
    assert.deepEqual(resolveEntityIdsForText(text, 100_000), referenceMatch(internals, index, text));
  }
  assert.ok(resolveEntityIdsForText(TEXTS.at(-1)!, 100_000).length >= 16, 'the long note names most entities');
});
