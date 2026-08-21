/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/requirement-coverage.test.ts */
import assert from 'node:assert/strict';
import test from 'node:test';
import { admitRequirementCoverage } from './requirement-coverage.js';

test('empty projection on a collect construct is unresolved, not arbitrary fields', () => {
  const admitted = admitRequirementCoverage({
    sourceUserSeq: 1,
    acceptedText: 'collect five items and put them in a workbook',
    goal: {
      construct: 'collect_then_construct',
      route: 'act',
      collection: { count: 5, projection: [] },
      destinations: [{ posture: 'create_new', family: 'workbook', handleRequired: true }],
    },
  });
  assert.equal(admitted.ok, false);
  if (!admitted.ok) assert.ok(admitted.unresolved.includes('projection'));
});

test('a retrieve with no destination is none, not unresolved', () => {
  const admitted = admitRequirementCoverage({
    sourceUserSeq: 2,
    acceptedText: 'what is on my calendar tomorrow',
    goal: { construct: 'none', route: 'retrieve' },
  });
  assert.equal(admitted.ok, true);
  if (admitted.ok) {
    assert.equal(admitted.coverage.entries.find((entry) => entry.kind === 'destination')?.posture, 'none');
    assert.equal(admitted.coverage.entries.find((entry) => entry.kind === 'projection')?.posture, 'none');
  }
});

test('requested analysis without a transform posture is unresolved', () => {
  const admitted = admitRequirementCoverage({
    sourceUserSeq: 3,
    acceptedText: 'derive ranked changes and save them',
    goal: { construct: 'single_act', route: 'act' },
  });
  assert.equal(admitted.ok, false);
  if (!admitted.ok) {
    assert.ok(admitted.unresolved.includes('transform') || admitted.unresolved.includes('destination'));
  }
});
