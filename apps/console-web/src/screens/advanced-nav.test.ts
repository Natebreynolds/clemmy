/**
 * Every Advanced route must be reachable, and the instruments must stay hidden.
 *
 * TWO REGRESSIONS THIS CLOSES.
 *
 * 1. All nine Advanced sections shipped as routes with no navigation between
 *    them. Only two were linked from anywhere in the app; the rest could be
 *    reached solely by typing the URL. A route with a screen behind it and no
 *    way in is a dead end.
 * 2. The first fix for that introduced a SECOND list of advanced destinations
 *    inside Advanced.tsx, beside the canonical one in lib/nav.ts that the
 *    sidebar and command palette already use — the same two-sources-of-truth
 *    shape this codebase keeps paying for. The rail now renders lib/nav.ts, and
 *    this pin keeps that the only list.
 *
 * Hidden is not removed: developer-tier panels stay routed so an old deep link
 * or bookmark still resolves. They are simply not advertised until developer
 * mode is on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** The `/advanced/...` paths app.tsx actually routes. */
function routedPaths(): string[] {
  return [...read('../app.tsx').matchAll(/path="(\/advanced\/[a-z-]+)"/g)].map((m) => m[1]);
}

/** The canonical destinations, with the tier that decides who sees them. */
function navEntries(): { path: string; tier: string }[] {
  const nav = read('../lib/nav.ts');
  const start = nav.indexOf('export const ADVANCED_NAV');
  assert.ok(start >= 0, 'ADVANCED_NAV moved out of lib/nav.ts; update this pin.');
  const end = nav.indexOf('export function advancedNavFor', start);
  assert.ok(end > start, 'advancedNavFor moved; update this pin.');
  return [...nav.slice(start, end).matchAll(/path: '(\/advanced\/[a-z-]+)'[^}]*tier: '(everyday|developer)'/g)]
    .map((m) => ({ path: m[1], tier: m[2] }));
}

test('the canonical list parses, and every entry declares who it is for', () => {
  const entries = navEntries();
  assert.ok(entries.length >= 7, `Parsed only ${entries.length} advanced destinations.`);
  assert.ok(entries.some((e) => e.tier === 'everyday'), 'No everyday panels.');
  assert.ok(entries.some((e) => e.tier === 'developer'), 'No developer panels.');
});

test('no Advanced route is reachable only by typing its URL', () => {
  // The developer route is deliberately absent from ADVANCED_NAV — it is
  // DEVELOPER_NAV, offered by advancedNavFor when developer mode is on.
  const known = new Set([...navEntries().map((e) => e.path), '/advanced/developer']);
  const unreachable = routedPaths().filter((path) => !known.has(path));
  assert.deepEqual(unreachable, [],
    `These Advanced routes have a screen and no way in:\n  ${unreachable.join('\n  ')}\n`
    + 'Add each to ADVANCED_NAV in lib/nav.ts with a tier.');
});

test('the instruments are hidden by default, not deleted', () => {
  const developerTier = navEntries().filter((e) => e.tier === 'developer').map((e) => e.path);
  const routed = new Set(routedPaths());
  for (const path of developerTier) {
    assert.ok(routed.has(path),
      `${path} is hidden but no longer routed — hiding a panel must never break its deep link.`);
  }
  const advanced = read('./Advanced.tsx');
  assert.ok(advanced.includes('advancedNavFor(developerMode)'),
    'The rail no longer gates on developer mode; the instruments would be advertised to everyone.');
});

test('the rail keeps no list of its own', () => {
  const advanced = read('./Advanced.tsx');
  assert.ok(!/const ADVANCED_NAV\s*[:=]/.test(advanced),
    'Advanced.tsx declared its own destination list again. lib/nav.ts is the one list — '
    + 'the sidebar and command palette read it too.');
  assert.ok(advanced.includes("from '@/lib/nav'"), 'Advanced.tsx should render lib/nav.ts.');
});
