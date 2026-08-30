/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/observation-provenance.test.ts
 *
 * A remembered observation must reach the model WITH its age and origin.
 *
 * Live defect 2026-08-27: asked a CRM question, Clem stated a portfolio size
 * and a team head-count as confirmed fact. She had not looked. She was reading
 * two remembered observations — one five weeks old, derived via a tool that no
 * longer exists, the other a few days older. Both reached the prompt as
 * `- <content>` and nothing else. With no date attached, a five-week-old
 * reading is indistinguishable from a live one, so confident restatement was
 * the only reading available to the model.
 *
 * The fix is NOT to suppress the answer — withholding what she knows is its
 * own failure mode. It is to hand her what she needs to say "I have this from
 * July, it has probably moved, want me to re-check?" That sentence requires
 * knowing which July.
 *
 * The line these pins hold: age is disclosed for what was OBSERVED from an
 * external system, and never bolted onto a standing instruction the user
 * simply stated. Provenance decides — not the fact's kind, not its wording.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { observationProvenanceSuffix, OBSERVATION_AGE_DISCLOSURE_DAYS } =
  await import('./facts.js');

const NOW = Date.parse('2026-08-27T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

/** Shaped exactly like the live row that produced the defect. */
const STALE_CRM_OBSERVATION = {
  derivedFrom: { sessionId: null, callId: null, tool: 'run_tool_program' },
  sourceApp: null,
  extractedAt: '2026-07-24T00:00:00.000Z',
  createdAt: '2026-07-24T00:00:00.000Z',
};

test('the figure that was restated as fact carries its age and its origin', () => {
  const suffix = observationProvenanceSuffix(STALE_CRM_OBSERVATION, NOW);
  assert.match(suffix, /2026-07-24/, 'the model must be able to see WHEN this was read');
  assert.match(suffix, /34d ago/, 'and how stale that makes it today');
  assert.match(suffix, /run_tool_program/, 'and what produced it, so a dead tool is visible as one');
  assert.match(suffix, /remembered from/,
    'the wording must mark this as recall, never as a current reading');
});

test('a standing instruction the user stated is never stamped with an age', () => {
  // "Salesforce only via the sf CLI" is true until the user says otherwise.
  // Ageing it would invite the model to treat a durable rule as expired.
  const stated = {
    derivedFrom: { sessionId: 'sess-1', callId: null, tool: null },
    sourceApp: null,
    extractedAt: daysAgo(400),
    createdAt: daysAgo(400),
  };
  assert.equal(observationProvenanceSuffix(stated, NOW), '',
    'a rule that was told to her has no observation to go stale');
});

test('a fresh reading is not cluttered with its own timestamp', () => {
  const fresh = { ...STALE_CRM_OBSERVATION, extractedAt: daysAgo(1), createdAt: daysAgo(1) };
  assert.equal(observationProvenanceSuffix(fresh, NOW), '',
    'stamping every line would make the signal worthless where it matters');
});

test('disclosure begins exactly at the threshold, not vaguely near it', () => {
  const justUnder = OBSERVATION_AGE_DISCLOSURE_DAYS - 1;
  assert.equal(
    observationProvenanceSuffix(
      { ...STALE_CRM_OBSERVATION, extractedAt: daysAgo(justUnder), createdAt: daysAgo(justUnder) },
      NOW,
    ),
    '',
  );
  assert.notEqual(
    observationProvenanceSuffix(
      { ...STALE_CRM_OBSERVATION,
        extractedAt: daysAgo(OBSERVATION_AGE_DISCLOSURE_DAYS),
        createdAt: daysAgo(OBSERVATION_AGE_DISCLOSURE_DAYS) },
      NOW,
    ),
    '',
  );
});

test('a system-of-record name is preferred over the tool that fetched it', () => {
  const withApp = { ...STALE_CRM_OBSERVATION, sourceApp: 'Salesforce' };
  const suffix = observationProvenanceSuffix(withApp, NOW);
  assert.match(suffix, /via Salesforce/,
    'the user thinks in systems, not in tool slugs');
});

test('an unparseable or missing timestamp discloses nothing rather than guessing', () => {
  for (const bad of ['', 'not-a-date', undefined as unknown as string]) {
    assert.equal(
      observationProvenanceSuffix({ ...STALE_CRM_OBSERVATION, extractedAt: bad, createdAt: bad }, NOW),
      '',
      'inventing an age would be its own false claim',
    );
  }
});

/**
 * End-to-end through the real renderer.
 *
 * The suffix helper being correct is not enough: the sentence that tells the
 * model what a date MEANS lives at the end of the scored block, which is
 * exactly where the char cap cuts. Rendered inside the budget it was the FIRST
 * thing removed on any real store — the model kept the ages and lost the only
 * line saying that offering to re-read was an option. That is worse than not
 * dating the facts at all, because it looks like it is working.
 */
const { rememberFact, renderFactsForInstructions } = await import('./facts.js');
const { MEMORY_DB_PATH } = await import('./db.js');
const { default: Database } = await import('better-sqlite3');

/** Age a fact the way real time does, so the pin exercises a real condition. */
function backdate(factId: number, days: number): void {
  const when = new Date(Date.now() - days * 86_400_000).toISOString();
  const handle = new Database(MEMORY_DB_PATH);
  handle.prepare('UPDATE consolidated_facts SET created_at = ?, extracted_at = ? WHERE id = ?')
    .run(when, when, factId);
  handle.close();
}

test('a store too large for the budget still tells the model how to read the dates', () => {
  // One observation that must be dated, aged to match the live defect...
  const observation = rememberFact({
    kind: 'project',
    content: 'A named rep manages a portfolio of 120 accounts for the legal team.',
    derivedFrom: { sessionId: 'sess-probe', callId: 'call-probe', tool: 'run_tool_program' },
    trustLevel: 0.6,
  });
  backdate(observation.id, 33);
  // ...and enough bulk to blow past any sane char budget.
  for (let index = 0; index < 40; index += 1) {
    const filler = rememberFact({
      kind: 'project',
      content: `Filler project fact ${index} describing unrelated salesforce account context `
        + 'at length so the scored block comfortably exceeds the rendering budget for this pin.',
      derivedFrom: { sessionId: 'sess-probe', callId: `call-${index}`, tool: 'run_tool_program' },
      trustLevel: 0.6,
    });
    backdate(filler.id, 33);
  }

  const rendered = renderFactsForInstructions(10, 600, 'salesforce accounts', 'scored');
  assert.ok(rendered.length > 0, 'the probe must actually render something');
  assert.match(rendered, /remembered from \d{4}-\d{2}-\d{2}/,
    'a stale observation reaches the model carrying its date');
  assert.match(rendered, /_… more facts elided to fit/,
    'the fixture must genuinely overflow the budget, or this pin proves nothing');
  assert.match(rendered, /offer to re-check/,
    'the instruction for reading dates must survive the clip that removes facts');
  assert.ok(
    rendered.indexOf('offer to re-check') > rendered.indexOf('elided to fit'),
    'the guidance sits outside the budget, after the elision notice',
  );
});
