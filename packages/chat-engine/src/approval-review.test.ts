import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalReview, approvalFieldText } from './approval-review.js';
import { approvalPreviewFrom, type ApprovalPreview } from './types.js';

const item = (title: string, invite = 'molly@example.com'): ApprovalPreview => ({ operation: 'Create calendar event', fields: Object.entries({
  subject: title, start_datetime: '2026-10-05T00:00:00', end_datetime: '2026-10-06T00:00:00',
  is_all_day: 'true', time_zone: 'America/Los_Angeles', attendees_info: JSON.stringify([{ email: invite, name: 'Molly', type: 'required' }]),
}).map(([name, value]) => ({ name, value })), check: { status: 'clear' } });
const group = (...items: ApprovalPreview[]): ApprovalPreview => ({ operation: 'Review prepared actions', fields: [{ name: 'Account', value: 'account-exact' }], items });

test('exact structured members survive host projection and both client transports', () => {
  const preview = group(item('One'), item('Two'));
  assert.deepEqual(approvalPreviewFrom(preview), preview);
  assert.equal(approvalPreviewFrom(group({ ...item('Nested'), items: [item('Hidden')] }, item('Two'))), undefined);
});
test('all-day end is exclusive; full frozen fields remain available', () => {
  const original = group(item('One'), item('Two'));
  const review = approvalReview(original)!;
  assert.equal(review.items[0]!.when, 'Oct 5, 2026 · All day');
  assert.deepEqual(review.items[0]!.exact, original.items![0]!.fields);
  assert.equal(review.common.filter(f => f.name === 'attendees_info').length, 1);
  assert.equal(approvalFieldText(review.common.find(f => f.name === 'attendees_info')!), 'Molly · molly@example.com (required)');
});
test('recipient differences remain visible on each item and unknown attendee data stays exact', () => {
  const review = approvalReview(group(item('One'), item('Two', 'other@example.com')))!;
  assert(!review.common.some(f => f.name === 'attendees_info'));
  assert(review.items.every(i => i.fields.some(f => f.name === 'attendees_info')));
  const field = { name: 'attendees_info', value: '[{"email":"m@example.com","special":true}]' };
  assert.equal(approvalFieldText(field), field.value);
});
test('offset timestamps and invalid dates retain raw times rather than inventing a zone', () => {
  for (const start of ['2026-10-05T09:00:00-07:00', '2026-02-30T00:00:00']) {
    const event = item('One'); event.fields.find(f => f.name === 'start_datetime')!.value = start;
    const review = approvalReview(group(event, item('Two')))!;
    assert.equal(review.items[0]!.when, undefined);
    assert(review.items[0]!.fields.some(f => f.name === 'start_datetime'));
  }
});
test('timed and multi-day events show both bounds without device-time conversion', () => {
  const timed = item('Timed');
  for (const field of timed.fields) {
    if (field.name === 'start_datetime') field.value = '2026-10-08T19:00:00';
    if (field.name === 'end_datetime') field.value = '2026-10-08T20:00:00';
    if (field.name === 'is_all_day') field.value = 'false';
  }
  const days = item('Multi'); days.fields.find(f => f.name === 'end_datetime')!.value = '2026-10-08T00:00:00';
  const review = approvalReview(group(timed, days))!;
  assert.match(review.items[0]!.when!, /7:00 PM.*8:00 PM/);
  assert.equal(review.items[1]!.when, 'Oct 5, 2026 – Oct 7, 2026 · All day');
});


test('new clients render structured actions once while legacy fallback remains in transport', () => {
  const preview = group(item('One'), item('Two'));
  preview.fields.push({ name: 'Prepared actions', value: 'One and Two: full legacy review' });
  assert(!approvalReview(preview)!.common.some(field => field.name === 'Prepared actions'));
  assert(approvalPreviewFrom(preview)!.fields.some(field => field.name === 'Prepared actions'));
});
