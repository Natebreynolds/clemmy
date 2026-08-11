import test from 'node:test';
import assert from 'node:assert/strict';

import { converseFirstQuestionCoverage } from './scenarios/converse-first.js';

test('converse-first coverage accepts one natural bundle that binds both independent unknowns', () => {
  const text = [
    'I need two quick details so I can get this right:',
    '1. Where does the Zephyr deal tracker live?',
    '   - Spreadsheet',
    '   - Notion',
    '2. Who is the crew for the update, and where should they receive it?',
    '   - Slack or Discord',
    '   - Email',
  ].join('\n');
  assert.deepEqual(converseFirstQuestionCoverage(text), {
    trackerLocation: true,
    crewDeliveryTarget: true,
  });
});

test('converse-first coverage accepts the compact link-and-channel question from Codex', () => {
  const text = 'Which Zephyr deal tracker and crew should I use—please point me to the tracker (link or app) and the update channel or recipient list?';
  assert.deepEqual(converseFirstQuestionCoverage(text), {
    trackerLocation: true,
    crewDeliveryTarget: true,
  });
});

test('converse-first coverage accepts one shared which/use clause for tracker and crew channel', () => {
  assert.deepEqual(
    converseFirstQuestionCoverage('Which deal tracker and crew channel should I use for Zephyr?'),
    { trackerLocation: true, crewDeliveryTarget: true },
  );
});

test('converse-first coverage rejects a public terminal that drops either parallel clarification', () => {
  assert.deepEqual(
    converseFirstQuestionCoverage('Where does the Zephyr deal tracker live so I can clean it up?'),
    { trackerLocation: true, crewDeliveryTarget: false },
  );
  assert.deepEqual(
    converseFirstQuestionCoverage('Who is the crew, and which Slack channel should receive the update?'),
    { trackerLocation: false, crewDeliveryTarget: true },
  );
  assert.deepEqual(
    converseFirstQuestionCoverage('Who knows where the Zephyr deal tracker lives?'),
    { trackerLocation: true, crewDeliveryTarget: false },
    'a generic who near the tracker location is not evidence that the delivery target was asked',
  );
  assert.deepEqual(
    converseFirstQuestionCoverage('Should I clean up the Zephyr deal tracker, and which crew channel should I use?'),
    { trackerLocation: false, crewDeliveryTarget: true },
    'mentioning a tracker does not establish which tracker or where it lives',
  );
  assert.deepEqual(
    converseFirstQuestionCoverage('Which deal tracker should I use for Zephyr?'),
    { trackerLocation: true, crewDeliveryTarget: false },
    'choosing the tracker alone still omits the crew delivery destination',
  );
});
