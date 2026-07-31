/**
 * Run: npx tsx --test src/spaces/mobile-projection.test.ts
 *
 * These pin the judgement calls, each of which was a real defect caught
 * against real workspace data on this machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseFields, formatValue, humanizeKey, projectSourceHealth, projectWorkspaceData } from './mobile-projection.js';

test('counts are not money: `total*` alone never renders as dollars', () => {
  // Live bug: totalOpen (41 deals) rendered as "$41" beside totalOpenValue.
  assert.equal(formatValue('totalOpen', 41), '41');
  assert.equal(formatValue('totalClosedLost', 187), '187');
  assert.equal(formatValue('totalOpenValue', 420_000), '$420k');
  assert.equal(formatValue('amount', 23_400), '$23k');
  assert.equal(formatValue('amount', 9_000), '$9.0k');
  assert.equal(formatValue('totalValue', 3_800_000), '$3.8M');
});

test('formatting stays legible on a small screen', () => {
  assert.equal(formatValue('closeDate', '2026-08-14T00:00:00.000Z'), '2026-08-14');
  assert.equal(formatValue('isOpen', true), 'Yes');
  assert.equal(formatValue('stage', ''), '—');
  assert.equal(formatValue('stage', null), '—');
  assert.equal(formatValue('note', 'x'.repeat(200)).length, 80);
  assert.equal(humanizeKey('daysSinceActivity'), 'Days Since Activity');
  assert.equal(humanizeKey('close_date'), 'Close date');
});

test('field ranking prefers meaning over column order', () => {
  // Live bug: an unanchored /account/ match promoted `emailOnAccount` (a
  // counter) above `amount` on a 39-column deal-risk row.
  const rows = Array.from({ length: 10 }, () => ({
    emailOnAccount: 17,
    daysSinceTouch: 3,
    account: 'Winter Spires',
    amount: 24_000,
    stage: 'Proposal',
    contactEmail: 'a@b.co',
  }));
  const chosen = chooseFields(rows);
  assert.equal(chosen[0], 'account', 'the identifying field leads');
  // The counter is demoted so hard it falls off the card entirely; if it ever
  // survives, it must still rank below the fields that carry meaning.
  const counterIdx = chosen.indexOf('emailOnAccount');
  assert.ok(counterIdx === -1 || counterIdx > chosen.indexOf('amount'), 'money beats a counter');
  assert.ok(chosen.includes('amount') && chosen.includes('stage'));
});

test('projects the largest object array and never ships the whole dataset', () => {
  const data = {
    risk: {
      pulledAt: '2026-07-30T14:00:00.000Z',
      summary: { atRiskCount: 23, totalOpenValue: 420_000, byStage: { Proposal: 4 }, thisMonthLabel: 'July' },
      team: [{ name: 'a' }, { name: 'b' }],
      deals: Array.from({ length: 96 }, (_, i) => ({
        account: `Account ${i}`,
        amount: 1000 * i,
        stage: 'Proposal',
      })),
    },
    _meta: { risk: { ok: true, refreshedAt: '2026-07-30T14:00:00.000Z' } },
  };
  const p = projectWorkspaceData(data);
  assert.equal(p.recordPath, 'risk.deals', 'picks the biggest array, not the first');
  assert.equal(p.total, 96);
  assert.equal(p.shown, 60, 'caps what it ships');
  assert.equal(p.records[0].primary, 'Account 0');
  // Nested breakdowns are charts, and *Label fields caption other numbers —
  // neither belongs in a row of tiles.
  const labels = p.headline.map((f) => f.label);
  assert.ok(!labels.includes('By Stage'));
  assert.ok(!labels.some((l) => /label/i.test(l)));
  assert.ok(labels.includes('At Risk Count'));
  assert.ok(JSON.stringify(p).length < 40_000, 'a 350KB dataset must not become a 350KB response');
});

test('a field that merely repeats the card title is dropped', () => {
  const data = {
    winback: {
      deals: Array.from({ length: 3 }, () => ({
        account: 'Scherr & Legate',
        name: 'Scherr & Legate | Pablo Lopez',
        amount: 23_000,
        stage: 'Closed Lost',
      })),
    },
  };
  const p = projectWorkspaceData(data);
  assert.equal(p.records[0].primary, 'Scherr & Legate');
  assert.ok(
    !p.records[0].fields.some((f) => f.value.includes('Scherr & Legate')),
    'the title must not be repeated back inside the card',
  );
  assert.ok(p.records[0].fields.some((f) => f.label === 'Amount'));
});

test('source health tells the truth when a refresh failed', () => {
  // The dangerous case: the runner failed today, so the data is last week's
  // while `pulledAt` still looks recent. Showing freshness without `ok`
  // would present stale numbers as current.
  const data = {
    pipeline: { pulledAt: '2026-07-24T00:00:00.000Z', deals: [] },
    _meta: { pipeline: { ok: false, refreshedAt: '2026-07-30T14:01:05.176Z', error: 'runner exited 1' } },
  };
  const [source] = projectSourceHealth(data);
  assert.equal(source.ok, false);
  assert.equal(source.error, 'runner exited 1');
  assert.equal(source.refreshedAt, '2026-07-30T14:01:05.176Z');
});

test('degrades rather than throws on shapes it has never seen', () => {
  for (const weird of [null, undefined, 42, 'text', [], {}, { a: { b: { c: { d: 1 } } } }]) {
    const p = projectWorkspaceData(weird);
    assert.equal(typeof p.total, 'number');
    assert.ok(Array.isArray(p.records));
  }
  assert.deepEqual(projectSourceHealth(null), []);
});

test('records carry every field, not just the four on the card', () => {
  // The complaint this fixes: "I need to see data, not just records." The card
  // shows a few fields; the row must still carry the rest for expansion.
  const wide = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [`field${String(i).padStart(2, '0')}`, `v${i}`]),
  );
  const data = { set: { rows: Array.from({ length: 3 }, () => ({ account: 'Acme', amount: 1000, ...wide })) } };
  const p = projectWorkspaceData(data);
  assert.ok(p.records[0].fields.length > 10, 'a 30-column row must not be truncated to four');
  assert.ok(p.records[0].fields.length <= 28, 'but it is still bounded');
});

test('breakdowns surface the distribution behind the headline', () => {
  const data = {
    risk: {
      summary: {
        atRiskCount: 23,
        byStage: { Proposal: 12, Negotiation: 6, Discovery: 2 },
        thisMonthLabel: 'July',
      },
      deals: [{ account: 'a' }, { account: 'b' }],
    },
  };
  const p = projectWorkspaceData(data);
  const stage = p.breakdowns.find((b) => b.label === 'By Stage');
  assert.ok(stage, 'nested summary objects become breakdowns');
  assert.equal(stage!.entries[0].label, 'Proposal', 'largest slice leads');
  assert.equal(stage!.entries[0].ratio, 1, 'the biggest entry fills its bar');
  assert.ok(stage!.entries[2].ratio < 0.5);
  // A caption string is not a distribution.
  assert.ok(!p.breakdowns.some((b) => /label/i.test(b.label)));
});

test('an authored _mobile block wins over inference — intent beats guessing', () => {
  // The case that motivated this: platform-49's desktop view shows "Feature
  // requests", a number computed in view code that exists NOWHERE in the data.
  // Inference can never recover it; the workspace has to say so.
  const data = {
    slack_feed: { data: { messages: Array.from({ length: 15 }, (_, i) => ({ ts: `170${i}`, subtype: 'x', inviter: 'U1' })) } },
    _mobile: {
      headline: [
        { label: 'Items logged', value: '142' },
        { label: 'Feature requests', value: '18' },
      ],
      records: {
        label: 'Recent requests',
        total: 42,
        items: [{ key: 'r1', primary: 'Bulk export for reports', fields: [{ label: 'Channel', value: '#platform-49' }] }],
      },
      breakdowns: [{ label: 'By section', entries: [{ label: 'Reports', value: 12 }, { label: 'Billing', value: 3 }] }],
    },
  };
  const p = projectWorkspaceData(data);
  assert.equal(p.headline[0].label, 'Items logged');
  assert.equal(p.headline[1].value, '18', 'a computed number no heuristic could find');
  assert.equal(p.recordLabel, 'Recent requests');
  assert.equal(p.total, 42, 'the author may report a total larger than the items shipped');
  assert.equal(p.records[0].primary, 'Bulk export for reports');
  // Ratios derive from the values when the author gave none, so bars stay honest.
  assert.equal(p.breakdowns[0].entries[0].ratio, 1);
  assert.ok(p.breakdowns[0].entries[1].ratio < 0.3);
  // And the raw Slack metadata inference would have shown is nowhere in sight.
  assert.ok(!JSON.stringify(p).includes('inviter'));
});

test('a malformed authored block falls back to inference, never breaks the screen', () => {
  // This is what makes the feature safe to add: a bad _mobile block can only
  // ever be as bad as having none.
  const rows = Array.from({ length: 5 }, (_, i) => ({ account: `Acme ${i}`, amount: 1000 * i, stage: 'Open' }));
  for (const junk of [null, 42, 'nope', [], {}, { headline: 'not-an-array' }, { headline: [{ label: 'x' }] }, { records: { items: [{}] } }]) {
    const p = projectWorkspaceData({ deals: rows, _mobile: junk });
    assert.equal(p.recordPath, 'deals', `_mobile=${JSON.stringify(junk)} must fall back to inference`);
    assert.equal(p.total, 5);
  }
});

test('authored content is bounded and coerced — it is agent-written, not trusted', () => {
  const p = projectWorkspaceData({
    _mobile: {
      headline: Array.from({ length: 40 }, (_, i) => ({ label: `L${i}`, value: i })),
      records: {
        items: Array.from({ length: 500 }, (_, i) => ({
          primary: 'x'.repeat(300),
          fields: Array.from({ length: 90 }, (_, f) => ({ label: `f${f}`, value: 'y'.repeat(200) })),
        })),
      },
    },
  });
  assert.ok(p.headline.length <= 8, 'tile count is capped');
  assert.ok(p.records.length <= 60, 'record count is capped');
  assert.ok(p.records[0].fields.length <= 28, 'field count is capped');
  assert.ok(p.records[0].primary.length <= 80, 'long strings are truncated');
  assert.equal(p.headline[0].value, '0', 'numbers are coerced to display strings');
});

test('_mobile is never mistaken for the dataset by inference', () => {
  // Without excluding it, the walk could pick _mobile's own items array as
  // "the largest array of objects" and render the summary as the data.
  const p = projectWorkspaceData({
    deals: [{ account: 'A' }, { account: 'B' }],
    _mobile: { headline: [] },
  });
  assert.equal(p.recordPath, 'deals');
});
