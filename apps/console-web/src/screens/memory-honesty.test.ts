/**
 * The memory screen may never report an empty memory it did not verify.
 *
 * THE REGRESSION THIS CLOSES. Every list on this screen was written as
 * `isLoading ? <Skeleton> : rows.length === 0 ? <EmptyState>`. A failed call is
 * not loading and has no rows, so it fell straight through to the empty state
 * and the screen made a confident claim about what Clementine knows. On the
 * Facts tab that read "Still getting to know you" — Clem telling the owner she
 * had learned nothing about him, when the truth was that she could not be
 * asked. The Overview said "0 told · 0 learned" the same way.
 *
 * Unknown is not empty. Nowhere does that matter more than here, so each list
 * must branch on its query's error BEFORE it branches on emptiness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./Memory.tsx', import.meta.url)), 'utf8');

/** Lists whose empty state would otherwise be indistinguishable from failure. */
const GUARDED_QUERIES = ['facts', 'episodes', 'entities'] as const;

test('every list branches on failure before it branches on emptiness', () => {
  for (const query of GUARDED_QUERIES) {
    const guard = `${query}.isError && !${query}.data`;
    assert.ok(source.includes(guard),
      `Memory.tsx no longer distinguishes an unreadable ${query} store from an empty one. `
      + `Restore the \`${guard}\` branch before its \`rows.length === 0\` case.`);
    const guardAt = source.indexOf(guard);
    const emptyAt = source.indexOf('rows.length === 0', guardAt);
    assert.ok(emptyAt > guardAt,
      `The ${query} error branch must come BEFORE its empty branch, or failure still renders as empty.`);
  }
});

test('the overview never interpolates a zero count it did not read', () => {
  // `${h.directFacts ?? 0} told` rendered "0 told · 0 learned" on a failed
  // health call — a claim, not a placeholder.
  assert.ok(source.includes('statsUnknown'),
    'Memory overview lost its statsUnknown guard; stat sub-lines will report 0 on failure again.');
  assert.ok(source.includes("'count unavailable'"),
    'Memory overview no longer has an unknown-count label.');
});

test('an unreadable store says nothing was lost', () => {
  assert.match(source, /couldn’t be read just now/,
    'The unreadable-store copy is gone; a failure must say so in words.');
  assert.ok(source.includes('function CouldNotRead'),
    'CouldNotRead was removed — the three lists share it.');
});

test('the health strip reports unknown as unknown, not as zero', () => {
  // Without this it answered a failed health call with "0 people & things ·
  // no identity conflicts" and "caught up" — three confident claims about a
  // memory it had not been able to read.
  const strip = readFileSync(
    fileURLToPath(new URL('../components/memory/HealthStrip.tsx', import.meta.url)), 'utf8');
  assert.ok(strip.includes('unavailable'),
    'HealthStrip lost its unavailable branch; a failed health call reports 0 again.');
  assert.ok(source.includes('unavailable={health.isError && !health.data}'),
    'Memory.tsx no longer tells HealthStrip when health could not be read.');
});

test('a set filter is never hidden', () => {
  // The chips render only while searching — but a filter left set would then
  // narrow the next search invisibly.
  assert.ok(source.includes('const showFacets = searching || '),
    'The facet visibility rule changed; a set filter could become invisible.');
});
