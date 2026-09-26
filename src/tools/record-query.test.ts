import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRows, applyWhere, fieldValue, sortRows } from './record-query.js';

const keywords = [
  { keyword: 'harbor view law', position: 2, volume: 880 },
  { keyword: 'maple street injury', position: 1, volume: 1300 },
  { keyword: 'lakeside counsel', position: 11, volume: 90 },
  { keyword: 'north bay claims', position: '3', volume: '2,400' },
  { keyword: 'quiet lane legal', position: null, volume: 40 },
  { keyword: 'ridge road firm', position: 76, volume: 320 },
];

test('numeric conditions compare as numbers, including numeric text', () => {
  const top3 = applyWhere(keywords, [{ field: 'position', op: 'lte', value: 3 }]);
  assert.deepEqual(top3.rows.map((row) => (row as { keyword: string }).keyword),
    ['harbor view law', 'maple street injury', 'north bay claims']);
  assert.equal(top3.skipped, 1, 'the record with no position is counted as skipped, not silently dropped');
  const grouped = applyWhere(keywords, [{ field: 'volume', op: 'gt', value: '1000' }]);
  assert.equal(grouped.rows.length, 2, 'a thousands-grouped number compares as the number it is');
});

test('text conditions are trimmed and case-insensitive; ne keeps records without the field', () => {
  const deals = [
    { name: 'Deal A', stage: 'Closed Won ', amount: 1200 },
    { name: 'Deal B', stage: 'closed won', amount: 3230 },
    { name: 'Deal C', stage: 'Negotiation', amount: 5000 },
    { name: 'Deal D', amount: 700 },
  ];
  assert.equal(applyWhere(deals, [{ field: 'stage', op: 'eq', value: 'Closed Won' }]).rows.length, 2);
  assert.equal(applyWhere(deals, [{ field: 'stage', op: 'contains', value: 'won' }]).rows.length, 2);
  assert.equal(applyWhere(deals, [{ field: 'stage', op: 'ne', value: 'closed won' }]).rows.length, 2);
});

test('ISO dates compare as dates and date-times as instants; mixed kinds are skipped, not guessed', () => {
  const rows = [
    { id: 1, closed: '2026-09-21' },
    { id: 2, closed: '2026-09-25' },
    { id: 3, closed: '2026-09-18' },
    { id: 4, closed: '2026-09-24T17:03:00.000+0000' },
  ];
  const week = applyWhere(rows, [
    { field: 'closed', op: 'gte', value: '2026-09-21' },
    { field: 'closed', op: 'lte', value: '2026-09-27' },
  ]);
  assert.deepEqual(week.rows.map((row) => (row as { id: number }).id), [1, 2]);
  assert.equal(week.skipped, 1, 'a date-time is not silently read as a date');
  const instants = applyWhere(rows, [{ field: 'closed', op: 'gt', value: '2026-09-24T10:00:00-07:00' }]);
  assert.deepEqual(instants.rows.map((row) => (row as { id: number }).id), [4]);
});

test('sorting ranks numbers numerically with missing values last', () => {
  const byVolume = sortRows(keywords, 'volume', 'desc').map((row) => (row as { keyword: string }).keyword);
  assert.deepEqual(byVolume.slice(0, 3), ['north bay claims', 'maple street injury', 'harbor view law']);
  const byPosition = sortRows(keywords, 'position', 'asc').map((row) => (row as { keyword: string }).keyword);
  assert.equal(byPosition[0], 'maple street injury');
  assert.equal(byPosition.at(-1), 'quiet lane legal', 'a record with no position sorts last in either direction');
  assert.equal(sortRows(keywords, 'position', 'desc').at(-1), keywords[4]);
});

test('aggregates are exact over every record and say what they could not count', () => {
  const deals = [
    { owner: 'Rep One', amount: 1200 },
    { owner: 'Rep Two', amount: '3,230' },
    { owner: 'Rep One', amount: 500.5 },
    { owner: 'Rep Two', amount: 'n/a' },
  ];
  assert.deepEqual(aggregateRows(deals, 'count').overall, { value: 4, counted: 4, lackedNumber: 0 });
  const sum = aggregateRows(deals, 'sum', { valueField: 'amount' }).overall;
  assert.deepEqual(sum, { value: 4930.5, counted: 3, lackedNumber: 1 });
  assert.equal(aggregateRows(deals, 'avg', { valueField: 'amount' }).overall.value, 1643.5);
  assert.equal(aggregateRows(deals, 'min', { valueField: 'amount' }).overall.value, 500.5);
  assert.equal(aggregateRows(deals, 'max', { valueField: 'amount' }).overall.value, 3230);
  const perOwner = aggregateRows(deals, 'sum', { valueField: 'amount', groupBy: 'owner' });
  assert.deepEqual(perOwner.groups?.map((group) => [group.group, group.figure.value]),
    [['Rep Two', 3230], ['Rep One', 1700.5]], 'groups come largest first');
  assert.equal(aggregateRows([], 'sum', { valueField: 'amount' }).overall.value, null, 'no numbers is not zero');
});

test('dotted fields reach nested values', () => {
  assert.equal(fieldValue({ metrics: { rank: { organic: 6 } } }, 'metrics.rank.organic'), 6);
  assert.equal(fieldValue({ metrics: null }, 'metrics.rank'), undefined);
  const rows = [{ m: { rank: 6 } }, { m: { rank: 42 } }];
  assert.equal(applyWhere(rows, [{ field: 'm.rank', op: 'lt', value: 10 }]).rows.length, 1);
});
