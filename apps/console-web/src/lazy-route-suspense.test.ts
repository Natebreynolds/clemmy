/**
 * Every lazily-loaded screen must be rendered inside Suspense.
 *
 * THE REGRESSION THIS CLOSES. Deferring the 1,380-line design mock off the main
 * chunk took it from a static import to `lazy()` — and `/dev/home-mock` was one
 * of the few routes rendered bare, outside `deferred(...)` and outside AppShell.
 * A lazy component with no Suspense boundary above it throws on render, so the
 * change that made every cold start 40 KB lighter would have made that one route
 * a white screen. The build is silent about it; only visiting the route shows it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = readFileSync(fileURLToPath(new URL('./app.tsx', import.meta.url)), 'utf8');

/** Components built by the lazyNamed helper or a bare React.lazy. */
function lazyComponents(): string[] {
  return [
    ...[...app.matchAll(/const (\w+) = lazyNamed\(/g)].map((m) => m[1]),
    ...[...app.matchAll(/const (\w+) = lazy\(/g)].map((m) => m[1]),
  ];
}

test('the app still defers its screens', () => {
  const names = lazyComponents();
  assert.ok(names.length >= 8, `Parsed only ${names.length} lazy screens; the pattern changed.`);
  assert.ok(app.includes('function DeferredScreen'), 'DeferredScreen is the Suspense boundary; it moved.');
});

test('no lazy screen is rendered without a Suspense boundary', () => {
  const bare: string[] = [];
  for (const name of lazyComponents()) {
    // `element={<Name ...>}` is bare; `element={deferred(<Name ...>)}` is not.
    const re = new RegExp(`element=\\{<${name}\\b`, 'g');
    if (re.test(app)) bare.push(name);
  }
  assert.deepEqual(bare, [],
    `These lazy screens render outside Suspense and will throw on visit:\n  ${bare.join('\n  ')}\n`
    + 'Wrap each route element in deferred(...), or give it its own Suspense boundary.');
});
