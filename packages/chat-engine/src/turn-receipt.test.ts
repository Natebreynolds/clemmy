import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outsideWorkCards, turnAgentName, turnByline, turnHelpers, turnModelName, turnModelOffer, turnReview, turnReviewerName, workflowCardLevels, workflowCards } from './turn-receipt.js';
import { narrateActivity } from './activity-presentation.js';
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

test('a helper on another model is credited by name and by the work it was handed', () => {
  const rows = fold([
    { type: 'turn_model_routed', data: { model: 'vendor-ai/Vendor-V4.1-Fast', provider: 'byo' } },
    { type: 'worker_started', data: { item: 'speed', role: 'outbound email writing', model: 'acme-flagship-5', provider: 'claude' } },
    { type: 'worker_started', data: { item: 'booking', role: 'outbound email writing', model: 'acme-flagship-5', provider: 'claude' } },
    { type: 'worker_result', data: { item: 'speed', ok: true, model: 'acme-flagship-5' } },
    { type: 'worker_result', data: { item: 'booking', ok: true, model: 'acme-flagship-5' } },
    { type: 'verdict_recorded', data: { door: 'completion', pass: true, judgeModelId: 'acme-large-4-5' } },
  ]);
  assert.deepEqual(turnHelpers(rows), [{ modelName: 'Acme Flagship 5', count: 2, work: 'outbound email writing' }]);
  assert.equal(
    turnByline(rows),
    'Vendor V4.1 Fast did the work, Acme Flagship 5 handled outbound email writing, Acme Large 4.5 checked it',
  );
});

test('helpers on the brain model are the brain work, and a failed helper earns no credit', () => {
  const rows = fold([
    { type: 'turn_model_routed', data: { model: 'vendor-ai/Vendor-V4.1-Fast', provider: 'byo' } },
    { type: 'worker_started', data: { item: 'a', model: 'vendor-ai/Vendor-V4.1-Fast', provider: 'byo' } },
    { type: 'worker_result', data: { item: 'a', ok: true, model: 'vendor-ai/Vendor-V4.1-Fast' } },
    { type: 'worker_started', data: { item: 'b', model: 'acme-flagship-5', provider: 'claude' } },
    { type: 'worker_result', data: { item: 'b', ok: false, reason: 'ERROR: timed out', model: 'acme-flagship-5' } },
  ]);
  assert.deepEqual(turnHelpers(rows), []);
  assert.equal(turnByline(rows), 'Vendor V4.1 Fast did the work');
});

test('a helper rerun on the same item replaces its row with the model that ran last', () => {
  const rows = fold([
    { type: 'worker_started', data: { item: 'speed', role: 'emails', model: 'other-model-5', provider: 'byo' } },
    { type: 'worker_result', data: { item: 'speed', ok: true, model: 'other-model-5' } },
    { type: 'worker_started', data: { item: 'speed', role: 'emails', model: 'acme-flagship-5', provider: 'claude' } },
    { type: 'worker_result', data: { item: 'speed', ok: true, model: 'acme-flagship-5' } },
  ]);
  const agents = rows.filter((row) => row.kind === 'agent');
  assert.equal(agents.length, 1);
  assert.equal(agents[0]!.modelName, 'Acme Flagship 5');
});

test('an offer to keep a model is carried to the receipt with the owner answer', () => {
  const offerEvent = { type: 'worker_model_offer', data: { offerId: 'wmo-0123456789abcdef', intent: 'outbound email writing', modelId: 'acme-flagship-5', modelName: 'Acme Flagship 5' } };
  const open = fold([offerEvent]);
  assert.deepEqual(turnModelOffer(open), { offerId: 'wmo-0123456789abcdef', intent: 'outbound email writing', modelId: 'acme-flagship-5', modelName: 'Acme Flagship 5' });
  const answered = fold([offerEvent, { type: 'worker_model_offer_resolved', data: { offerId: 'wmo-0123456789abcdef', action: 'save' } }]);
  assert.equal(turnModelOffer(answered)?.resolved, 'save');
  const replayed = fold([{ ...offerEvent, data: { ...offerEvent.data, resolved: 'dismiss' } }]);
  assert.equal(turnModelOffer(replayed)?.resolved, 'dismiss');
  assert.equal(turnModelOffer(fold([])), null);
});

test('a turn inside a saved agent says so first on the receipt; an unbound turn reads as before', () => {
  const routed = { type: 'turn_model_routed', data: { model: 'acme-flagship-5', provider: 'byo', agentName: 'Prospect Research Desk' } };
  const bound = fold([routed]);
  assert.equal(turnAgentName(bound), 'Prospect Research Desk');
  assert.match(turnByline(bound), /^Prospect Research Desk · .+ did the work$/);
  const plain = fold([{ type: 'turn_model_routed', data: { model: 'acme-flagship-5', provider: 'byo' } }]);
  assert.equal(turnAgentName(plain), undefined);
  assert.doesNotMatch(turnByline(plain), /·/);
});

test('a saved workflow becomes one card under the reply, from the saved definition, and never a work row', () => {
  const saved = {
    name: 'Weekly posts', slug: 'weekly-posts', op: 'updated', enabled: true,
    steps: [
      { id: 'pull', label: 'Pull posts', effect: 'read', approval: false, forEach: false, dependsOn: [] },
      { id: 'caption', label: 'Write captions', effect: 'unknown', approval: false, forEach: true, dependsOn: ['pull'] },
      { id: 'images', label: 'Find images', effect: 'read', approval: false, forEach: true, dependsOn: ['pull'] },
      { id: 'review', label: 'Show me the drafts', effect: 'unknown', approval: true, forEach: false, dependsOn: ['caption', 'images'] },
    ],
    changedStepIds: ['review'], addedStepIds: ['review'], removedStepIds: [],
  };
  const rows = fold([
    { type: 'workflow_saved', data: { ...saved, changedStepIds: ['caption'], addedStepIds: [] } },
    { type: 'workflow_saved', data: saved },
  ]);
  const cards = workflowCards(rows);
  assert.equal(cards.length, 1, 'the newest save of the same workflow replaces the earlier card');
  assert.deepEqual(cards[0].changedStepIds, ['review']);
  assert.deepEqual(workflowCardLevels(cards[0]).map((level) => level.map((s) => s.id)), [['pull'], ['caption', 'images'], ['review']]);
  assert.equal(narrateActivity(rows).some((row) => row.workflow), false, 'the card is not listed as work');

  const malformed = fold([{ type: 'workflow_saved', data: { name: 'x', slug: '', op: 'updated', steps: [] } }]);
  assert.equal(workflowCards(malformed).length, 0);
});
