import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXPECTED_TEMPORAL_CHANGES,
  temporalMutationToolCalls,
  validateTemporalChangeReport,
  validateTemporalHttpDiff,
  workspaceTemporalPrompt,
} from './scenarios/workspace-temporal-history.js';

test('temporal report accepts exactly the grounded changes in any order', () => {
  const report = JSON.stringify({
    changes: [
      EXPECTED_TEMPORAL_CHANGES[2],
      EXPECTED_TEMPORAL_CHANGES[0],
      EXPECTED_TEMPORAL_CHANGES[1],
    ],
  });
  assert.deepEqual(validateTemporalChangeReport(report), {
    pass: true,
    detail: '3 exact grounded changes',
  });
  assert.equal(validateTemporalChangeReport(`\`\`\`json\n${report}\n\`\`\``).pass, true);
});

test('temporal report rejects missing, duplicated, invented, and stringified facts', () => {
  assert.equal(validateTemporalChangeReport(JSON.stringify({
    changes: EXPECTED_TEMPORAL_CHANGES.slice(0, 2),
  })).pass, false);
  assert.equal(validateTemporalChangeReport(JSON.stringify({
    changes: [
      ...EXPECTED_TEMPORAL_CHANGES,
      EXPECTED_TEMPORAL_CHANGES[0],
    ],
  })).pass, false);
  assert.equal(validateTemporalChangeReport(JSON.stringify({
    changes: [
      ...EXPECTED_TEMPORAL_CHANGES,
      { id: 'invented-account', field: 'spend', before: 1, after: 2 },
    ],
  })).pass, false);
  assert.equal(validateTemporalChangeReport(JSON.stringify({
    changes: EXPECTED_TEMPORAL_CHANGES.map((change) => (
      change.field === 'spend'
        ? { ...change, before: String(change.before), after: String(change.after) }
        : change
    )),
  })).pass, false);
  assert.equal(validateTemporalChangeReport(
    `Here is the result: ${JSON.stringify({ changes: EXPECTED_TEMPORAL_CHANGES })}`,
  ).pass, false);
});

test('temporal HTTP diff requires the exact non-truncated retained delta', () => {
  const exact = {
    status: 'ok',
    sourceKey: '$document',
    diff: {
      changed: true,
      truncated: false,
      counts: { add: 0, remove: 0, replace: 3 },
      changes: [
        {
          op: 'replace',
          path: '/accounts/@id=northstar-ads/spend',
          entityKey: 'id=northstar-ads',
          before: '1200',
          after: '1375',
        },
        {
          op: 'replace',
          path: '/accounts/@id=ember-search/status',
          entityKey: 'id=ember-search',
          before: '"active"',
          after: '"paused"',
        },
        {
          op: 'replace',
          path: '/accounts/@id=northstar-ads/conversions',
          entityKey: 'id=northstar-ads',
          before: '24',
          after: '31',
        },
      ],
    },
  };
  assert.equal(validateTemporalHttpDiff(exact).pass, true);
  assert.equal(validateTemporalHttpDiff({
    ...exact,
    diff: {
      ...exact.diff,
      truncated: true,
    },
  }).pass, false);
  assert.equal(validateTemporalHttpDiff({
    ...exact,
    diff: {
      ...exact.diff,
      counts: { add: 0, remove: 0, replace: 4 },
      changes: [
        ...exact.diff.changes,
        {
          op: 'replace',
          path: '/accounts/@id=cedar-social/spend',
          entityKey: 'id=cedar-social',
          before: '300',
          after: '999',
        },
      ],
    },
  }).pass, false);
});

test('temporal mutation classifier allows reads and the deferred wrapper but fails closed', () => {
  assert.deepEqual(temporalMutationToolCalls({
    tool_search: 1,
    call_tool: 1,
    space_diff: 1,
    space_history: 1,
  }), {});
  assert.deepEqual(temporalMutationToolCalls({
    call_tool: 1,
    space_diff: 1,
    space_set_data: 1,
    write_file: 1,
    workflow_run: 1,
    dispatch_background_task: 1,
    unregistered_external_tool: 1,
  }), {
    space_set_data: 1,
    write_file: 1,
    workflow_run: 1,
    dispatch_background_task: 1,
    unregistered_external_tool: 1,
  });
});

test('temporal live prompt requires the retained diff without leaking expected facts', () => {
  const prompt = workspaceTemporalPrompt('fixture-workspace');
  assert.match(prompt, /space_diff/);
  assert.match(prompt, /fixture-workspace/);
  assert.match(prompt, /\$document/);
  for (const leaked of [
    'northstar-ads',
    'ember-search',
    'cedar-social',
    '1375',
    '1200',
    '31',
    '24',
    'paused',
  ]) {
    assert.equal(prompt.includes(leaked), false, leaked);
  }
});
