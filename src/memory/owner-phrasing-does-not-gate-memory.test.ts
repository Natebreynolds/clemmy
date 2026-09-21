import assert from 'node:assert/strict';
import test from 'node:test';
import { extractAutoMemoryCandidates } from './auto-capture.js';
import { UNJUDGED_OWNER_STATEMENT_REASON } from './durable-consolidation.js';

/**
 * Binding rule: everyone phrases things their own way, so no pattern over the
 * owner's words may decide what is worth remembering.
 *
 * The pattern battery in auto-capture decides durability from English shape — a
 * first-person possessive plus a stative verb from a fixed list. These are real
 * standing preferences a person would expect an assistant to keep, written the
 * way people actually talk. Each one matches NOTHING, and before this path
 * existed each was discarded as ephemeral with no route to any other judge.
 *
 * The fix is not to widen the battery. It is to stop letting it decide: an
 * unmatched message goes to the model reviewer, which answers `task` (dropped,
 * exactly as before) or `standing`. These cases assert the FIRST half — that the
 * patterns genuinely miss them — so the test fails loudly if someone "fixes"
 * this by bolting on more regexes, which is the thing that must not happen.
 */
const PHRASINGS_THE_PATTERNS_MISS = [
  'yeah just skip Tim on these going forward',
  'quit cc-ing legal on the weekly ones',
  'going forward put the numbers first and the commentary after',
  'stop scheduling anything before 9',
  'when in doubt draft it, don’t send it',
  'nah, use the shorter format from here on',
];

test('real owner preferences do not match the phrasing patterns', () => {
  for (const phrasing of PHRASINGS_THE_PATTERNS_MISS) {
    const matched = extractAutoMemoryCandidates(phrasing);
    assert.equal(
      matched.length,
      0,
      `"${phrasing}" now matches a pattern (${matched.map((c) => c.reason).join(', ')}). `
      + 'If a regex was widened to catch it, that is the defect this test exists to prevent — '
      + 'the model reviewer decides durability, not a wordlist.',
    );
  }
});

/**
 * The capture path is not unit-testable without a live memory database (it
 * writes an episode and claim rows inside a transaction), so this asserts the
 * CONTRACT the fallback depends on: the reason marker is exported, distinct
 * from the reasons that promote without review, and routed by the drain.
 */
test('the unjudged marker is distinct from reasons that promote without review', () => {
  assert.equal(typeof UNJUDGED_OWNER_STATEMENT_REASON, 'string');
  assert.ok(UNJUDGED_OWNER_STATEMENT_REASON.length > 0);
  for (const promotesDirectly of ['explicit remember request', 'explicit durable correction']) {
    assert.notEqual(
      UNJUDGED_OWNER_STATEMENT_REASON,
      promotesDirectly,
      'an unjudged message must never share a reason with one the owner explicitly authorized',
    );
  }
});

test('the drain routes the unjudged marker to the model reviewer', async () => {
  const { readFileSync } = await import('node:fs');
  const drain = readFileSync(new URL('./durable-consolidation.ts', import.meta.url), 'utf8');
  // The routing condition is what makes the fallback a REVIEW rather than a
  // silent promotion. If this marker stops appearing in it, unmatched owner
  // messages would be written to memory unjudged — strictly worse than the
  // regex gate it replaced.
  const routing = drain.slice(drain.indexOf('const explicitScopeReview'));
  const conditionEnd = routing.indexOf('const review =');
  assert.ok(conditionEnd > 0, 'the reviewer call site moved; re-anchor this test');
  assert.ok(
    routing.slice(0, conditionEnd).includes('UNJUDGED_OWNER_STATEMENT_REASON'),
    'unjudged owner statements must reach reviewStandingMemory, never consolidateFact directly',
  );
});
