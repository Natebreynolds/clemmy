/**
 * Run: npx tsx --test src/tools/callable-surface-registration.test.ts
 *
 * Wiring pins for the callable-surface oracle's local schema projection.
 * A green oracle unit suite proves the oracle RUNS; these prove the lanes
 * actually REGISTER it (who calls this?) — an unregistered lane silently
 * degrades every guardrail mandate to "names no tool".
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-callable-reg-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('importing the registration module wires the oracle with real local schemas', async () => {
  const surface = await import('../runtime/harness/callable-surface.js');
  surface._clearLocalSchemaProviderForTests();
  assert.equal(surface.localSchemaProviderRegistered(), false);
  await import('./callable-surface-registration.js');
  assert.equal(surface.localSchemaProviderRegistered(), true, 'registration is a side effect of import');
  const entry = surface.resolveCallable('memory_search');
  assert.equal(entry.schemaSource, 'local_registry', 'a real local tool resolves through the projection');
  assert.ok(entry.schema, 'and carries its exact JSON schema');
});

test('both lane entries import the registration module (per-lane wiring pin)', async () => {
  const { readFileSync } = await import('node:fs');
  const here = path.dirname(new URL(import.meta.url).pathname);
  const loopSource = readFileSync(path.join(here, '../runtime/harness/loop.ts'), 'utf8');
  const brainSource = readFileSync(path.join(here, '../runtime/harness/claude-agent-brain.ts'), 'utf8');
  for (const [lane, source] of [['loop', loopSource], ['claude-agent-brain', brainSource]] as const) {
    assert.match(
      source,
      /import '\.\.\/\.\.\/tools\/callable-surface-registration\.js';/,
      `${lane} must import the callable-surface registration at its entry`,
    );
  }
});
