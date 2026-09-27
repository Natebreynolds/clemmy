/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/grounded-entity-mentions.prefilter.test.ts
 *
 * The anchor prefilter must be exact: grounded mentions over the prefiltered
 * entities equal grounded mentions over every entity, ids and order, for
 * every text. Checked on fixture names and texts, then on seeded random
 * names and texts built to stress the edges (hyphens, apostrophes, non-ASCII
 * letters, digits, names under four characters, names with no two-character
 * alphanumeric run, overlapping and nested names).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { groundedEntityMentionIds, groundedMentionPrefilter } = await import('./grounded-entity-mentions.js');

type Entity = { id: number; names: string[]; canonicalName?: string };

function assertSame(entities: Entity[], text: string): void {
  const prefilter = groundedMentionPrefilter(entities);
  for (const canonicalOnly of [false, true]) {
    const everyEntity = groundedEntityMentionIds(text, entities, canonicalOnly);
    const prefiltered = groundedEntityMentionIds(text, prefilter(text), canonicalOnly);
    assert.deepEqual(prefiltered, everyEntity, `text=${JSON.stringify(text)} canonicalOnly=${canonicalOnly}`);
  }
}

const FIXTURE: Entity[] = [
  { id: 1, names: ['Acmecorp'], canonicalName: 'Acmecorp' },
  { id: 2, names: ['Acmecorp'], canonicalName: 'Acmecorp' },
  { id: 3, names: ['Dana Smith', 'Dana'], canonicalName: 'Dana Smith' },
  { id: 4, names: ['Dana Smithson'], canonicalName: 'Dana Smithson' },
  { id: 5, names: ["O'Neil Group", 'ONeil'], canonicalName: "O'Neil Group" },
  { id: 6, names: ['Zoë Café'], canonicalName: 'Zoë Café' },
  { id: 7, names: ['R2-D2 Unit', 'R2-D2'], canonicalName: 'R2-D2 Unit' },
  { id: 8, names: ['a b c d', 'x y z w'], canonicalName: 'a b c d' },
  { id: 9, names: ['AI'], canonicalName: 'AI' },
  { id: 10, names: ['—·—·'], canonicalName: '—·—·' },
  { id: 11, names: ['Northwind Traders', 'Northwind'], canonicalName: 'Northwind Traders' },
  { id: 12, names: ['  Globex  ', 'GLOBEX corp'], canonicalName: 'Globex' },
  { id: 13, names: ['3M', '3M Company'], canonicalName: '3M Company' },
  { id: 14, names: ['Q3 2026 Plan'], canonicalName: 'Q3 2026 Plan' },
  { id: 15, names: ['İstanbul Office'], canonicalName: 'İstanbul Office' },
];

const FIXTURE_TEXTS = [
  '',
  'Nothing to see here.',
  'Acmecorp renewed with Dana Smith today.',
  'Dana Smithson and Dana Smith met at Acmecorp HQ.',
  "O'Neil Group signed; ONeil confirmed by email.",
  'Zoë Café opened a second shop. zoë café is busy.',
  'The R2-D2 Unit shipped. r2-d2 again.',
  'a b c d then x y z w and a b c d e',
  'AI is too short to ground.',
  'Separator —·—· stands alone; —·—·— does not.',
  'Northwind Traders is Northwind; northwinds is not.',
  'globex corp and GLOBEX CORP and Globex.',
  '3M Company and 3M; 3Ms is not a mention.',
  'The Q3 2026 Plan is due; q3 2026 planning is not.',
  'İstanbul Office and istanbul office.',
  'dana@acmecorp.example wrote about acmecorp.example and https://acmecorp.example/x',
  'Acmecorp-Dana Smith joint review (Northwind Traders).',
];

test('prefiltered grounded mentions equal unfiltered ones on the fixture texts', () => {
  for (const text of FIXTURE_TEXTS) assertSame(FIXTURE, text);
});

test('the prefilter keeps the entities in their original order and drops only ones that cannot match', () => {
  const prefilter = groundedMentionPrefilter(FIXTURE);
  const ids = prefilter('Dana Smithson and Acmecorp').map((entity) => entity.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'original order');
  assert.ok(ids.includes(1) && ids.includes(2) && ids.includes(3) && ids.includes(4));
  assert.ok(!ids.includes(11), 'Northwind cannot match a text without its anchor');
  assert.ok(ids.includes(10), 'a name with no two-character run is a candidate for every text');
  assert.ok(!ids.includes(9), 'an entity whose names are all under four characters never matches');
});

// Deterministic pseudo-random generator (mulberry32), so a failure reproduces.
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

const ALPHABET = [
  ...'abcdefghijklmnopqrstuvwxyz', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...'0123456789',
  ' ', ' ', ' ', '-', "'", '.', '&', 'é', 'ü', 'ß', 'İ', 'K', '—', '·', '_',
];

function randomName(next: () => number): string {
  const shape = next();
  const pick = (chars: readonly string[]) => chars[Math.floor(next() * chars.length)]!;
  if (shape < 0.1) return Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick(ALPHABET)).join('');
  if (shape < 0.2) return Array.from({ length: 4 + Math.floor(next() * 4) }, (_, i) => (i % 2 === 0 ? pick([...'abcxyz']) : pick([' ', '-', '·']))).join('');
  if (shape < 0.3) return Array.from({ length: 4 + Math.floor(next() * 3) }, () => pick(['—', '·', 'é', ' '])).join('');
  const words = 1 + Math.floor(next() * 3);
  return Array.from({ length: words }, () => Array.from({ length: 1 + Math.floor(next() * 7) }, () => pick(ALPHABET)).join('')).join(pick([' ', '-', "'", ' ']));
}

test('property: prefiltered equals unfiltered over seeded random names and texts', () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const next = rng(seed);
    const entities: Entity[] = Array.from({ length: 30 }, (_, i) => {
      const names = Array.from({ length: 1 + Math.floor(next() * 3) }, () => randomName(next));
      return { id: i + 1, names, canonicalName: next() < 0.8 ? names[0] : undefined };
    });
    // Give some entities the same name, and nest names inside other names.
    entities[1]!.names.push(entities[0]!.names[0]!);
    entities[2]!.names.push(`${entities[3]!.names[0]!} ${entities[4]!.names[0]!}`);
    for (let t = 0; t < 40; t += 1) {
      const parts: string[] = [];
      const pieces = 1 + Math.floor(next() * 8);
      for (let p = 0; p < pieces; p += 1) {
        const roll = next();
        if (roll < 0.55) {
          const entity = entities[Math.floor(next() * entities.length)]!;
          let name = entity.names[Math.floor(next() * entity.names.length)]!;
          if (next() < 0.3) name = name.toUpperCase();
          parts.push(name);
        } else {
          parts.push(randomName(next));
        }
      }
      const joiners = [' ', '', '-', ', ', '. ', "'", 'x', '9'];
      const text = parts.reduce((acc, part) => acc + joiners[Math.floor(next() * joiners.length)]! + part, '');
      assertSame(entities, text);
    }
  }
});
