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

test('mixed-kind rankings keep numbers together, order within each kind, and leave missing values last', () => {
  const rows = [
    { id: 'ten', value: 10 },
    { id: 'text-z', value: 'z' },
    { id: 'two', value: '2' },
    { id: 'missing' },
    { id: 'text-a', value: 'A' },
    { id: 'hundred', value: '100' },
    { id: 'empty', value: '' },
    { id: 'ten-again', value: '10' },
    { id: 'null', value: null },
  ];
  const ids = (order: 'asc' | 'desc') => sortRows(rows, 'value', order)
    .map((row) => (row as { id: string }).id);
  assert.deepEqual(ids('asc'), ['two', 'ten', 'ten-again', 'hundred', 'text-a', 'text-z', 'missing', 'empty', 'null']);
  assert.deepEqual(ids('desc'), ['hundred', 'ten', 'ten-again', 'two', 'text-z', 'text-a', 'missing', 'empty', 'null']);
  assert.equal(rows[0]!.id, 'ten', 'ranking does not mutate the retained input');
});

test('mixed-kind ordering is consistent across input permutations, with separate date and instant groups', () => {
  const rows = [
    { id: 'number', value: 2 },
    { id: 'date-early', value: '2026-09-24' },
    { id: 'date-late', value: '2026-09-25' },
    { id: 'instant-early', value: '2026-09-24T23:00:00Z' },
    { id: 'instant-late', value: '2026-09-25T10:00:00+00:00' },
    { id: 'text', value: 'unknown' },
    { id: 'missing', value: null },
  ];
  for (const input of [rows, [...rows].reverse(), [rows[5], rows[4], rows[0], rows[6], rows[2], rows[3], rows[1]]]) {
    assert.deepEqual(sortRows(input, 'value', 'asc').map((row) => (row as { id: string }).id),
      ['number', 'date-early', 'date-late', 'instant-early', 'instant-late', 'text', 'missing']);
    assert.deepEqual(sortRows(input, 'value', 'desc').map((row) => (row as { id: string }).id),
      ['number', 'date-late', 'date-early', 'instant-late', 'instant-early', 'text', 'missing']);
  }
});

test('aggregates cover every record and say what they could not count', () => {
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

test('aggregates retain very small and high-precision Number results without fixed decimal rounding', () => {
  const tiny = [{ value: '0.000000000001', group: 'a' }, { value: '0.000000000002', group: 'b' }];
  assert.equal(aggregateRows(tiny, 'sum', { valueField: 'value' }).overall.value, 3e-12);
  assert.equal(aggregateRows(tiny, 'avg', { valueField: 'value' }).overall.value, 1.5e-12);
  assert.equal(aggregateRows(tiny, 'min', { valueField: 'value' }).overall.value, 1e-12);
  assert.equal(aggregateRows(tiny, 'max', { valueField: 'value' }).overall.value, 2e-12);
  assert.deepEqual(aggregateRows(tiny, 'sum', { valueField: 'value', groupBy: 'group' }).groups
    ?.map((entry) => [entry.group, entry.figure.value]), [['b', 2e-12], ['a', 1e-12]]);
  const precise = [{ value: 1.000000000001 }, { value: 1.000000000001 }];
  assert.equal(aggregateRows(precise, 'sum', { valueField: 'value' }).overall.value, 2.000000000002);
  assert.equal(aggregateRows(precise, 'avg', { valueField: 'value' }).overall.value, 1.000000000001);
  assert.equal(aggregateRows([{ value: 0.1 }, { value: 0.2 }], 'sum', { valueField: 'value' }).overall.value,
    0.30000000000000004, 'ordinary Number arithmetic is retained, not represented as exact decimal arithmetic');
});

test('a field path steps through lists: text inside nested lists is reachable', () => {
  // The shape of a slide's text box, as a presentation provider returns it.
  const box = { objectId: 'p7_i3', shape: { text: { textElements: [
    { endIndex: 1, paragraphMarker: { style: {} } },
    { endIndex: 12, textRun: { content: 'Q4 results\n' } },
    { endIndex: 30, textRun: { content: 'Revenue up 12%\n' } },
  ] } } };
  const expected = ['Q4 results\n', 'Revenue up 12%\n'];
  assert.deepEqual(fieldValue(box, 'shape.text.textElements.textRun.content'), expected);
  assert.deepEqual(fieldValue(box, 'shape.text.textElements[*].textRun.content'), expected);
  assert.deepEqual(fieldValue(box, 'shape.text.textElements[].textRun.content'), expected);
  assert.equal(fieldValue(box, 'shape.text.textElements[1].textRun.content'), 'Q4 results\n');
  assert.equal(fieldValue(box, 'shape.text.textElements.2.textRun.content'), 'Revenue up 12%\n');
  assert.equal(fieldValue(box, 'shape.text.textElements.missing'), undefined, 'nothing found is undefined, not []');
  assert.deepEqual(fieldValue({ tags: ['a', 'b'] }, 'tags'), ['a', 'b'], 'a list at the end is returned as it is');
  assert.equal(fieldValue({ a: 1, secret: 2 }, '[]'), undefined, 'a wildcard never widens to every key of a record');
  assert.equal(fieldValue({ a: { b: 1 } }, 'a.*'), undefined);
  const boxes = [box, { objectId: 'p7_i4', shape: { text: { textElements: [{ textRun: { content: 'Costs flat' } }] } } }];
  const field = 'shape.text.textElements.textRun.content';
  assert.deepEqual(applyWhere(boxes, [{ field, op: 'contains', value: 'revenue' }]).rows, [box], 'any item may match');
  assert.equal(applyWhere(boxes, [{ field, op: 'ne', value: 'Costs flat' }]).rows.length, 1, 'ne holds when no item equals');
  assert.equal(applyWhere([{ tags: ['x', 'y'] }], [{ field: 'tags', op: 'eq', value: 'y' }]).rows.length, 1);
});

test('dotted fields reach nested values', () => {
  assert.equal(fieldValue({ metrics: { rank: { organic: 6 } } }, 'metrics.rank.organic'), 6);
  assert.equal(fieldValue({ metrics: null }, 'metrics.rank'), undefined);
  const rows = [{ m: { rank: 6 } }, { m: { rank: 42 } }];
  assert.equal(applyWhere(rows, [{ field: 'm.rank', op: 'lt', value: 10 }]).rows.length, 1);
});
