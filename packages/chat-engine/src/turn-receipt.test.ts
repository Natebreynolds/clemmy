import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outsideWorkCards, turnByline, turnModelName, turnReview, turnReviewerName } from './turn-receipt.js';
import { boundedModelId, modelDisplayName } from './model-name.js';
import { readQuestionOptions } from './question-options.js';
import { MODEL_PHASE_ACTIVITY_ID, reduceActivity } from './reduce-activity.js';
import type { ActivityItem, HarnessEvent } from './types.js';

function fold(events: Array<Pick<HarnessEvent, 'type' | 'data'>>): ActivityItem[] {
  return events.reduce<ActivityItem[]>(
    (rows, ev, i) => reduceActivity(rows, { seq: i + 1, ...ev } as HarnessEvent, () => i + 1),
    [],
  );
}

test('the receipt names who did the work and who checked it', () => {
  const rows = fold([
    { type: 'turn_model_routed', data: { model: 'vendor-ai/Vendor-V4.1-Fast', provider: 'byo' } },
    { type: 'verdict_recorded', data: { door: 'completion', pass: false, judgeModelId: 'acme-large-4-5' } },
    { type: 'verdict_recorded', data: { door: 'completion', pass: true, judgeModelId: 'acme-large-4-5' } },
  ]);
  assert.equal(turnReviewerName(rows), 'Acme Large 4.5');
  assert.equal(turnByline(rows), 'Vendor V4.1 Fast did the work, Acme Large 4.5 checked it');

  const rejected = fold([
    { type: 'turn_model_routed', data: { model: 'vendor-ai/Vendor-V4.1-Fast', provider: 'byo' } },
    { type: 'verdict_recorded', data: { door: 'completion', pass: false, judgeModelId: 'acme-large-4-5' } },
  ]);
  assert.equal(turnByline(rejected), 'Vendor V4.1 Fast did the work, Acme Large 4.5 reviewed it', 'a rejection never reads as checked');

  const noReviewer = fold([
    { type: 'turn_model_routed', data: { model: 'vendor-ai/Vendor-V4.1-Fast', provider: 'byo' } },
    { type: 'verdict_recorded', data: { door: 'completion', pass: true, failedOpen: true, judgeModelId: 'acme-large-4-5' } },
  ]);
  assert.equal(turnReviewerName(noReviewer), undefined, 'a verdict with no reviewer names none');
  assert.equal(turnByline(noReviewer), 'Vendor V4.1 Fast did the work');
  assert.equal(turnByline([]), '');
});

test('confirmed writes outside Clem become one card per app and kind; nothing unconfirmed does', () => {
  const draft = (id: string, to: string) => ({ type: 'external_write_succeeded', data: { callId: id, shapeKey: 'MAILAPP_CREATE_DRAFT', targets: [to], app: 'Mail App', appUrl: 'https://mail.example.test' } });
  const rows = fold([
    draft('d1', 'a@example.test'),
    draft('d2', 'b@example.test'),
    draft('d3', 'c@example.test'),
    { type: 'external_write', data: { callId: 'd4', shapeKey: 'MAILAPP_CREATE_DRAFT', targets: ['d@example.test'], app: 'Mail App' } },
    { type: 'external_write_failed', data: { callId: 'd5', shapeKey: 'MAILAPP_CREATE_DRAFT', targets: ['e@example.test'], app: 'Mail App' } },
    { type: 'external_write_succeeded', data: { callId: 's1', shapeKey: 'MAILAPP_SEND_EMAIL', targets: ['x@example.test'], app: 'Mail App' } },
    { type: 'external_write_succeeded', data: { callId: 'r1', shapeKey: 'SHEETS_BATCH_UPDATE', targets: [] } },
  ]);
  const cards = outsideWorkCards(rows);
  assert.deepEqual(cards.map((c) => [c.title, c.subtitle, c.appUrl ?? null]), [
    ['3 drafts in Mail App', 'Saved as drafts · not sent', 'https://mail.example.test'],
    ['1 message sent from Mail App', 'To x@example.test', null],
    ['1 record updated', 'Confirmed', null],
  ]);
});

test('a model id reads the way a person says it', () => {
  assert.equal(modelDisplayName('vendor-ai/Vendor-V4.1-Fast'), 'Vendor V4.1 Fast');
  assert.equal(modelDisplayName('acme-large-4-5-20250101'), 'Acme Large 4.5');
  assert.equal(modelDisplayName('qrs-5.2-mini'), 'QRS 5.2 Mini');
  assert.equal(modelDisplayName('open-coder-70b-latest'), 'Open Coder 70B');
  assert.equal(modelDisplayName('build-4-1106-preview'), 'Build 4 1106 Preview');
  assert.equal(modelDisplayName('  '), '');
});

test('a namespaced model id is a name, and a provider alone never is', () => {
  const rows = reduceActivity([], { seq: 1, type: 'turn_model_routed', data: { model: 'vendor-ai/Vendor-V4.1-Fast', provider: 'byo' } }, () => 1);
  assert.equal(rows[0]?.id, MODEL_PHASE_ACTIVITY_ID);
  assert.equal(rows[0]?.label, 'Thinking with Vendor V4.1 Fast…');
  assert.equal(turnModelName(rows), 'Vendor V4.1 Fast');
  const providerOnly = reduceActivity([], { seq: 1, type: 'turn_model_routed', data: { provider: 'byo' } }, () => 1);
  assert.equal(turnModelName(providerOnly), undefined);
  assert.equal(turnModelName([]), undefined);
  assert.equal(boundedModelId('a/b/c'), '');
  assert.equal(boundedModelId('../etc'), '');
});

test('the last verdict decides the review line, and no reviewer is never a pass', () => {
  const verdict = (pass: boolean, failedOpen = false): ActivityItem[] => reduceActivity(
    [], { seq: 1, type: 'verdict_recorded', data: { door: 'completion', pass, failedOpen } }, () => 1,
  );
  assert.equal(turnReview([...verdict(false), ...verdict(true)]), 'checked');
  assert.equal(turnReview(verdict(true, true)), 'unchecked');
  assert.equal(turnReview(verdict(false)), 'rejected');
  assert.equal(turnReview([]), null);
  assert.equal(turnReview(undefined), null);
});

test('question options keep real, distinct, readable choices only', () => {
  assert.deepEqual(readQuestionOptions(['Your inbox', ' your  inbox ', '', 42, 'The shared inbox', 'x'.repeat(121)]), ['Your inbox', 'The shared inbox']);
  assert.deepEqual(readQuestionOptions('Your inbox'), []);
  assert.equal(readQuestionOptions(Array.from({ length: 12 }, (_v, i) => `Option ${i}`)).length, 8);
});
