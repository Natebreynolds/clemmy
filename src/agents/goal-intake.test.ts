/**
 * Run: npx tsx --test src/agents/goal-intake.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftGoalFromNotes } from './goal-intake.js';

test('draftGoalFromNotes extracts a reviewed goal shape from meeting notes', () => {
  const draft = draftGoalFromNotes({
    notes: [
      'Goal: improve onboarding completion by 20% over the next 4 weeks.',
      'Success: baseline is captured and weekly completion rate is measured.',
      'Next action: pull the current funnel report and draft the first experiment plan.',
      'Risk: analytics access is missing and owner approval is required before rollout.',
    ].join('\n'),
  });

  assert.match(draft.objective, /onboarding completion/i);
  assert.equal(draft.confidence, 'high');
  assert.ok(draft.successCriteria.some((item) => /weekly completion rate/i.test(item)));
  assert.ok(draft.nextActions.some((item) => /funnel report/i.test(item)));
  assert.ok(draft.risks.some((item) => /analytics access/i.test(item)));
  assert.equal(draft.missingInputs.length, 0);
  assert.ok(draft.sourceLines.length >= 3);
});

test('draftGoalFromNotes keeps weak notes usable and flags missing inputs', () => {
  const draft = draftGoalFromNotes({ notes: 'Owner wants this to be better.' });

  assert.match(draft.objective, /better/i);
  assert.equal(draft.confidence, 'low');
  assert.ok(draft.successCriteria.length >= 3);
  assert.ok(draft.nextActions.length >= 3);
  assert.ok(draft.risks.length >= 1);
  assert.ok(draft.missingInputs.includes('Add a success metric'));
  assert.ok(draft.missingInputs.includes('Add a deadline'));
});
