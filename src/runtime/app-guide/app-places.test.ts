/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/app-guide/app-places.test.ts
 *
 * The daemon's copy of the place list must match the one the apps render
 * links from. The daemon cannot import packages/, so this compares source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_PLACES } from './app-places.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const APPS = path.resolve(here, '../../../packages/chat-engine/src/app-places.ts');
const MIRROR = path.resolve(here, './app-places.ts');

function placeBlock(source: string): string {
  const start = source.indexOf('export interface AppPlace {');
  const end = source.indexOf('] as const;');
  assert.ok(start >= 0 && end > start, 'the place list is declared');
  return source.slice(start, end);
}

test('the daemon and the apps share one place list', () => {
  assert.equal(placeBlock(readFileSync(MIRROR, 'utf8')), placeBlock(readFileSync(APPS, 'utf8')));
});

test('every place has a desktop route, a name and a purpose, and ids are unique', () => {
  const ids = new Set<string>();
  for (const place of APP_PLACES) {
    assert.match(place.id, /^[a-z][a-z-]*$/);
    assert.ok(!ids.has(place.id), place.id);
    ids.add(place.id);
    assert.ok(place.desktop.startsWith('/'), place.id);
    assert.ok(place.name && place.purpose, place.id);
    assert.ok(place.phone === null || place.phone.startsWith('?tab='), place.id);
  }
});
