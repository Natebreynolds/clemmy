import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  maybeHeavyPerItemToolAdvisory,
  _resetHeavyAdvisoryForTests,
} = await import('./fanout-alignment-gate.js');

// Heavy per-item tool advisory (live 2026-07-23): a 120-account run planned a
// browser session PER ITEM; only a mid-run human steer saved the budget. This is
// advisory-only: it never pauses execution, fires once, and stays narrowly
// scoped to browser/screenshot-class work.
test('browser-per-item fan-outs draw one cost advisory; cheap or small fan-outs draw none', () => {
  _resetHeavyAdvisoryForTests();
  const packet = JSON.stringify({
    objective: 'capture each firm homepage',
    instructions: 'use browser_harness_run to screenshot each site',
    items: [],
  });
  const first = maybeHeavyPerItemToolAdvisory('sess-heavy', 120, packet);
  assert.ok(first && /cost advisory/.test(first), 'large browser fan-out advises');
  assert.match(first, /batch scrape API|reused browser session/);
  assert.equal(maybeHeavyPerItemToolAdvisory('sess-heavy', 120, packet), null, 'one advisory per session');
  _resetHeavyAdvisoryForTests();
  assert.equal(maybeHeavyPerItemToolAdvisory('sess-heavy', 5, packet), null, 'small fan-outs are fine');
  assert.equal(
    maybeHeavyPerItemToolAdvisory('sess-heavy', 120, JSON.stringify({ instructions: 'composio scrape each site' })),
    null,
    'cheap per-item tools draw nothing',
  );
});
