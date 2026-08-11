import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseReadHistoryClaims,
  validateReadHistoryClaims,
  type ReadHistorySnapshot,
} from './read-history-claims.js';

const PRIOR: ReadHistorySnapshot = {
  sourceKey: 'proof/local/queue',
  contentDigest: 'snapshot-rev1-open',
  revision: 1,
  count: 1,
  rows: [{
    id: 'proof-release-1',
    title: 'Review the Clementine 4 release proof',
    status: 'open',
  }],
};

const CURRENT_SAME: ReadHistorySnapshot = {
  sourceKey: 'proof/local/queue',
  contentDigest: 'snapshot-rev1-open',
  revision: 1,
  count: 1,
  rows: [{ ...PRIOR.rows[0]! }],
};

const CURRENT_CHANGED: ReadHistorySnapshot = {
  sourceKey: 'proof/local/queue',
  contentDigest: 'snapshot-rev2-done',
  revision: 2,
  count: 1,
  rows: [{ ...PRIOR.rows[0]!, status: 'done' }],
};

function validate(
  text: string,
  current: ReadHistorySnapshot = CURRENT_CHANGED,
  prior: ReadHistorySnapshot | null = PRIOR,
) {
  return validateReadHistoryClaims({ text, current, prior });
}

test('current-only narrative has no history obligation and input bytes are untouched', () => {
  const text = [
    '- **Revision:** 2',
    '- **Status:** done',
    '- **Title:** Review the Clementine 4 release proof',
  ].join('\n');
  const before = Buffer.from(text);
  const result = validate(text, CURRENT_CHANGED, null);

  assert.equal(result.decision, 'certified');
  assert.deepEqual(result.reasonCodes, ['no_temporal_claims']);
  assert.deepEqual(result.claims, []);
  assert.deepEqual(Buffer.from(text), before, 'validation must never rewrite provider bytes');
});

test('retained unchanged and no-change productions certify identical snapshots', () => {
  for (const text of [
    'No changes since last check.',
    'Queue refreshed — unchanged from the last pull:',
    'Refreshed — the queue is unchanged:',
    'Unchanged from before.',
    'Source marker: PROOF_RELEASE_QUEUE:LOCAL_ONLY. Unchanged since the last read.',
  ]) {
    const result = validate(text, CURRENT_SAME);
    assert.equal(result.decision, 'certified', text);
    assert.ok(result.claims.some((claim) => claim.kind === 'unchanged'), text);
  }
});

test('still count/status and same-source/revision claims bind both snapshots', () => {
  const compact = validate('Still one open item, at revision 1.', CURRENT_SAME);
  assert.equal(compact.decision, 'certified');
  assert.deepEqual(compact.claims.map((claim) => claim.kind), [
    'count_still',
    'status_still',
    'revision_target',
  ]);

  const composed = validate(
    'Still 1 item, unchanged since the last read — same source and revision via the local proof provider.',
    CURRENT_SAME,
  );
  assert.equal(composed.decision, 'certified');
  assert.deepEqual(composed.claims.map((claim) => claim.kind), [
    'count_still',
    'unchanged',
    'same_source',
    'same_revision',
  ]);
});

test('remains is typed as continuity and cannot certify without prior authority', () => {
  for (const text of ['The item remains open.', 'Status remains open.']) {
    assert.equal(validate(text, CURRENT_SAME).decision, 'certified', text);
    assert.equal(validate(text, CURRENT_SAME, null).decision, 'contradicted', text);
  }
  assert.equal(validate('Revision remains 1.', CURRENT_SAME).decision, 'certified');
  assert.equal(validate('Revision remains 1.', CURRENT_SAME, null).decision, 'contradicted');
});

test('retained same-source headings require the trusted source identity', () => {
  for (const text of [
    'Proof release queue refreshed from the same source:',
    'Fresh read from the same source:',
    'Fresh data from the same source:',
    'Pulled fresh from the same connected source via the proven capability. One open item in the queue.',
  ]) {
    assert.equal(validate(text, CURRENT_SAME).decision, 'certified', text);
  }

  const otherSource = { ...CURRENT_SAME, sourceKey: 'proof/other/queue' };
  const rejected = validate('Fresh read from the same source:', otherSource);
  assert.equal(rejected.decision, 'contradicted');
  assert.ok(rejected.reasonCodes.includes('source_key_mismatch'));
});

test('generic changed, updated, and advanced headings require a real snapshot delta', () => {
  for (const text of [
    'Refreshed proof release queue — it changed since last check:',
    "Queue refreshed — there's been a change since the last pull:",
    "State has advanced — here's the refreshed queue:",
    'Fresh read complete — the provider state updated:',
  ]) {
    assert.equal(validate(text).decision, 'certified', text);
    const unchanged = validate(text, CURRENT_SAME);
    assert.equal(unchanged.decision, 'contradicted', text);
    assert.ok(unchanged.reasonCodes.includes('snapshot_unchanged'), text);
  }
});

test('status comparison uses the same case-insensitive semantics as transitions', () => {
  const caseOnly = {
    ...CURRENT_SAME,
    contentDigest: CURRENT_SAME.contentDigest,
    rows: [{ ...CURRENT_SAME.rows[0]!, status: 'OPEN' }],
  };
  assert.equal(validate('No changes since last check.', caseOnly).decision, 'certified');
  assert.equal(validate('Fresh read complete — the provider state updated:', caseOnly).decision, 'contradicted');
});

test('revision-first and status-first transitions accept arrows or to and match both endpoints', () => {
  for (const text of [
    "The queue advanced from revision 1 to revision 2, and the single item's status flipped from open to done.",
    'The queue advanced from revision 1 → 2, and the single item flipped from open → done.',
    'The status moved from open to done, and the revision bumped from 1 to 2.',
    'The status moved from open → done, and the revision bumped 1 → 2.',
    'The item moved from open → done, and the revision bumped from 1 → 2.',
  ]) {
    const result = validate(text);
    assert.equal(result.decision, 'certified', text);
    assert.ok(result.claims.some((claim) => claim.kind === 'status_transition'), text);
    assert.ok(result.claims.some((claim) => claim.kind === 'revision_transition'), text);
  }
});

test('live GLM unchanged summary binds the whole prior snapshot, count, and revision', () => {
  const text = 'Unchanged from the last pull — still 1 item, revision 1.';
  const result = validate(text, CURRENT_SAME);
  assert.equal(result.decision, 'certified');
  assert.deepEqual(result.claims.map((claim) => claim.kind), [
    'unchanged',
    'count_still',
    'revision_target',
  ]);

  assert.equal(validate(text, CURRENT_SAME, null).decision, 'contradicted');
  assert.equal(
    validate(text.replace('revision 1', 'revision 2'), CURRENT_SAME).decision,
    'contradicted',
  );
  assert.equal(
    validate(text.replace('still 1 item', 'still 2 items'), CURRENT_SAME).decision,
    'contradicted',
  );
});

test('live GLM state-change heading binds both revision endpoints and a real core delta', () => {
  const text = 'Fresh read — the queue state has changed (revision bumped from 1 to 2):';
  const result = validate(text);
  assert.equal(result.decision, 'certified');
  assert.deepEqual(result.claims.map((claim) => claim.kind), [
    'revision_transition',
    'changed',
  ]);

  assert.equal(validate(text, CURRENT_CHANGED, null).decision, 'contradicted');
  assert.equal(
    validate(text.replace('from 1 to 2', 'from 0 to 2')).decision,
    'contradicted',
  );
  assert.equal(
    validate(text.replace('from 1 to 2', 'from 1 to 3')).decision,
    'contradicted',
  );
  assert.equal(validate(text, CURRENT_SAME).decision, 'contradicted');
});

test('retained combined and parenthetical revision transitions certify exact prior/current facts', () => {
  for (const text of [
    'Still 1 item, but its status flipped from open → done and the revision advanced from 1 to 2 — the provider state changed since the last read.',
    'The state changed since the last read: the item moved from open to done (revision 1 → 2).',
    'The item flipped from open to done since the last read (revision bumped 1 → 2).',
  ]) {
    assert.equal(validate(text).decision, 'certified', text);
  }
});

test('field and table parentheticals validate current and historical scalars without swapping them', () => {
  const fields = validate([
    '- **Revision:** 2 (was 1)',
    '- **Status:** done (was open)',
  ].join('\n'));
  assert.equal(fields.decision, 'certified');
  assert.equal(fields.claims.filter((claim) => claim.kind === 'revision_transition').length, 1);
  assert.equal(fields.claims.filter((claim) => claim.kind === 'status_transition').length, 1);

  const upFrom = validate('- **Revision:** 2 (up from 1)');
  assert.equal(upFrom.decision, 'certified');

  for (const text of [
    'Revision: 2 (from 1)',
    '1. Revision = 2 (was 1)',
    'Latest status equals done (previously open)',
  ]) {
    assert.equal(validate(text).decision, 'certified', text);
  }

  const table = validate([
    '| Item ID | Title | Status |',
    '|---|---|---|',
    '| proof-release-1 | Review what was updated | done (was open) |',
  ].join('\n'));
  assert.equal(table.decision, 'certified');
  const transition = table.claims.find((claim) => claim.kind === 'status_transition');
  assert.equal(transition?.kind === 'status_transition' ? transition.rowId : null, 'proof-release-1');
  assert.deepEqual(table.unparsedTemporalSegments, [], 'history words in a title cell are not narrative claims');

  const vertical = validate([
    '| Field | Value |',
    '|---|---|',
    '| Revision | 2 (was 1) |',
    '| Status | done (from open) |',
  ].join('\n'));
  assert.equal(vertical.decision, 'certified');
  assert.equal(vertical.claims.filter((claim) => claim.kind === 'revision_transition').length, 1);
  assert.equal(vertical.claims.filter((claim) => claim.kind === 'status_transition').length, 1);
});

test('presentation-compatible historical annotations cannot disappear from history validation', () => {
  for (const text of [
    'Revision: 2 (from 999)',
    'Revision = 2 (was 999)',
    '1. Revision: 2 (was 999)',
    'Status = done (was closed)',
    '| Field | Value |\n|---|---|\n| Revision | 2 (was 999) |',
    '| Field | Value |\n|---|---|\n| Status | done (from closed) |',
  ]) {
    const result = validate(text);
    assert.equal(result.decision, 'contradicted', text);
    assert.ok(
      result.reasonCodes.includes('revision_transition_mismatch')
        || result.reasonCodes.includes('status_transition_mismatch'),
      text,
    );
  }

  for (const text of [
    'Item: id proof-release-1, title "Review the release", status done (was closed)',
    '- proof-release-1 — Review the release — status done (from closed)',
  ]) {
    const result = validate(text);
    assert.equal(result.decision, 'needs_semantic_judge', text);
    assert.ok(result.unparsedTemporalSegments.length > 0, text);
  }
});

test('current-only revision bump validates change without inventing a from revision', () => {
  const text = "It's advanced since last check — status moved from open to done, and the revision bumped to 2.";
  const result = validate(text);
  assert.equal(result.decision, 'certified');
  const target = result.claims.find((claim) => claim.kind === 'revision_target');
  assert.deepEqual(target && {
    kind: target.kind,
    to: target.kind === 'revision_target' ? target.to : null,
    requiresChange: target.kind === 'revision_target' ? target.requiresChange : null,
    hasFrom: 'from' in target,
  }, {
    kind: 'revision_target',
    to: 2,
    requiresChange: true,
    hasFrom: false,
  });

  const sameRevision = validate(text, { ...CURRENT_CHANGED, revision: 1 });
  assert.equal(sameRevision.decision, 'contradicted');
  assert.ok(sameRevision.reasonCodes.includes('revision_mismatch'));
  assert.ok(sameRevision.reasonCodes.includes('revision_not_changed'));
});

test('wrong parsed facts are contradicted with specific forensic reasons', () => {
  const wrongStatus = validate('The item flipped from closed to done since the last read.');
  assert.equal(wrongStatus.decision, 'contradicted');
  assert.ok(wrongStatus.reasonCodes.includes('status_transition_mismatch'));

  const wrongRevision = validate('- **Revision:** 3 (was 1)');
  assert.equal(wrongRevision.decision, 'contradicted');
  assert.ok(wrongRevision.reasonCodes.includes('revision_transition_mismatch'));

  const falseUnchanged = validate('Unchanged from before.');
  assert.equal(falseUnchanged.decision, 'contradicted');
  assert.ok(falseUnchanged.reasonCodes.includes('snapshot_changed'));
});

test('a status comparison needs one stable row identity across snapshots', () => {
  const replaced: ReadHistorySnapshot = {
    ...CURRENT_CHANGED,
    rows: [{ ...CURRENT_CHANGED.rows[0]!, id: 'proof-release-2' }],
  };
  const result = validate('The item flipped from open to done since the last read.', replaced);
  assert.equal(result.decision, 'contradicted');
  assert.ok(result.reasonCodes.includes('stable_row_required'));
});

test('every recognized temporal claim requires a prior trusted snapshot', () => {
  const result = validate('No changes since last check.', CURRENT_SAME, null);
  assert.equal(result.decision, 'contradicted');
  assert.ok(result.reasonCodes.includes('prior_snapshot_required'));
});

test('unknown historical wording is routed to a semantic judge, not guessed', () => {
  for (const text of [
    'The queue evolved from its earlier state.',
    'The item was formerly open and has settled now.',
    '| Item ID | Status |\n|---|---|\n| proof-release-1 | done (formerly open) |',
  ]) {
    const result = validate(text);
    assert.equal(result.decision, 'needs_semantic_judge', text);
    assert.ok(result.reasonCodes.includes('unknown_temporal_wording'), text);
    assert.ok(result.unparsedTemporalSegments.length > 0, text);
  }

  assert.equal(
    validate('The queue evolved from its earlier state.', CURRENT_CHANGED, null).decision,
    'needs_semantic_judge',
    'unknown wording remains a judge decision even before the parser can establish a claim',
  );
});

test('quoted examples and fenced code cannot create trusted history claims', () => {
  const text = [
    '> No changes since last check.',
    '',
    '```text',
    'The item flipped from open to done since the last read.',
    '```',
  ].join('\n');
  assert.deepEqual(parseReadHistoryClaims(text), {
    claims: [],
    unparsedTemporalSegments: [],
  });
});
