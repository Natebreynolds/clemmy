import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSpaceForHome } from './home-space-summary.js';

test('a Space\'s own summary wins, and a failed source is said beside its numbers', () => {
  const summary = summarizeSpaceForHome({
    id: 'pipeline',
    title: 'Pipeline',
    objective: 'Deals closing this month',
    lastRefreshedAt: '2026-09-23T14:00:00.000Z',
    freshness: 'fresh',
    data: {
      _mobile: {
        headline: [{ label: 'Open', value: '$1.84M' }, { label: 'Slipped', value: '3' }],
        records: { label: 'Deals', items: [{ key: 'd1', primary: 'Harborview Legal', fields: [{ label: 'Amount', value: '$240k' }, { label: 'Close', value: 'Fri' }, { label: 'Owner', value: 'Priya' }] }] },
        breakdowns: [{ label: 'By stage', entries: [{ label: 'Proposal', value: 6 }, { label: 'Negotiation', value: 3 }] }],
      },
      _meta: { crm: { ok: false, refreshedAt: '2026-09-22T14:00:00.000Z', error: 'Salesforce session expired' } },
    },
  });
  assert.deepEqual(summary.headline.map((h) => h.value), ['$1.84M', '3']);
  assert.equal(summary.records[0]!.primary, 'Harborview Legal');
  assert.equal(summary.records[0]!.fields.length, 2, 'a Home row shows two fields; the Space shows the rest');
  assert.equal(summary.breakdown?.label, 'By stage');
  assert.deepEqual(summary.breakdown?.entries.map((e) => e.label), ['Proposal', 'Negotiation']);
  assert.equal(summary.sources[0]!.ok, false);
  assert.match(summary.sources[0]!.error ?? '', /session expired/);
});

test('a Space with no summary claims only what its rows show', () => {
  const summary = summarizeSpaceForHome({
    id: 'inbox',
    title: 'Inbox',
    data: { emails: { complete: true, records: [{ subject: 'Renewal terms', from: 'Alex' }, { subject: 'Intro', from: 'Sam' }] } },
  });
  assert.equal(summary.total, 2);
  assert.equal(summary.headline[0]?.label, 'Records');
  assert.equal(summary.freshness, 'unknown');
});

test('unreadable data is an empty summary, never an error on Home', () => {
  const summary = summarizeSpaceForHome({ id: 'x', title: 'X', data: 'not json' });
  assert.equal(summary.total, 0);
  assert.deepEqual(summary.records, []);
});
