/** Run with scripts/run-tests-isolated.mjs; no daemon, providers, or home needed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WatchRow } from '../../lib/watches';
import { buildWatchOverview, type WatchOverviewInput } from './watch-overview-model';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');

function watch(overrides: Partial<WatchRow> = {}): WatchRow {
  return {
    slug: 'source-a',
    name: 'watch-source-a',
    source: 'Source A',
    lookFor: 'A change that needs a decision',
    purpose: 'tell_me',
    enabled: true,
    onEvents: false,
    findings: [],
    learned: [],
    notify: 'quiet',
    rules: [],
    totals: { runs: 0, findings: 0, raised: 0, learned: 0 },
    ...overrides,
  };
}

function report(at: string, status: 'ok' | 'missing' = 'ok'): NonNullable<WatchRow['lastRun']> {
  return { runId: `run-${at}`, at, report: status, findings: 0, surfaced: 0, learned: 0 };
}

function overview(overrides: Partial<WatchOverviewInput> = {}) {
  return buildWatchOverview({ watches: [], state: 'loaded', dataUpdatedAt: NOW, nowMs: NOW, ...overrides });
}

test('a fresh successful empty response describes only the returned list', () => {
  const view = overview();
  assert.equal(view.status, 'loaded');
  assert.equal(view.label, 'No watches to show');
  assert.deepEqual(view.currentCounts, { total: 0, enabled: 0 });
  assert.deepEqual(view.rows, []);
  assert.equal(view.href, '/watching');
  assert.doesNotMatch(`${view.label} ${view.detail}`, /never|not watching|not checked/i);
});

test('an empty failed load never becomes a healthy zero or an empty-state invitation', () => {
  for (const dataUpdatedAt of [0, NOW - 60_000]) {
    const view = overview({ state: 'error', dataUpdatedAt });
    assert.equal(view.status, 'error');
    assert.equal(view.label, 'Watches unavailable');
    assert.equal(view.currentCounts, null);
    assert.match(view.detail, /couldn’t/i);
    assert.doesNotMatch(view.detail, /give Clem/i);
  }
});

test('a failed refresh retains sources while qualifying settings and counts as last loaded', () => {
  const source = watch({ source: 'A shared folder', enabled: false, lastRun: report('2026-10-17T11:50:00.000Z') });
  const view = overview({ watches: [source], state: 'error', dataUpdatedAt: NOW - 4 * 60_000 });
  assert.equal(view.status, 'error');
  assert.equal(view.currentCounts, null);
  assert.match(view.detail, /last loaded watches/);
  assert.equal(view.freshnessLabel, 'Last loaded 4m ago');
  assert.equal(view.rows[0].source, source.source);
  assert.equal(view.rows[0].stateLabel, 'Last loaded paused');
  assert.equal(view.rows[0].reportLabel, 'Retained report');
  assert.equal(view.rows[0].reportTimeLabel, '10m ago');
});

test('initial loading and refresh loading remain distinct from a confirmed empty list', () => {
  const initial = overview({ state: 'loading', dataUpdatedAt: 0 });
  assert.equal(initial.label, 'Loading watches');
  assert.equal(initial.currentCounts, null);
  assert.equal(initial.freshnessLabel, null);
  const cached = overview({ watches: [watch()], state: 'loading' });
  assert.equal(cached.rows.length, 1);
  assert.equal(cached.rows[0].stateLabel, 'Last loaded enabled');
  assert.match(cached.detail, /last loaded/);
  assert.equal(cached.currentCounts, null);
});

test('a successful query retained across a suspended tab stops claiming current counts', () => {
  const fresh = overview({ watches: [watch()], dataUpdatedAt: NOW - 90_000 });
  assert.equal(fresh.status, 'loaded');
  assert.deepEqual(fresh.currentCounts, { total: 1, enabled: 1 });
  const stale = overview({ watches: [watch()], dataUpdatedAt: NOW - 90_001 });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.currentCounts, null);
  assert.equal(stale.rows[0].stateLabel, 'Last loaded enabled');
  assert.match(stale.detail, /Refresh to confirm/);
  assert.match(stale.freshnessLabel!, /^Last loaded /);
  const staleEmpty = overview({ dataUpdatedAt: NOW - 10 * 60_000 });
  assert.notEqual(staleEmpty.label, 'No watches to show');
  assert.equal(staleEmpty.currentCounts, null);
});

test('unknown, invalid, and future snapshot times cannot establish freshness', () => {
  for (const dataUpdatedAt of [0, -1, NaN, Infinity, NOW + 1]) {
    const view = overview({ watches: [watch()], dataUpdatedAt });
    assert.equal(view.status, 'unconfirmed');
    assert.equal(view.currentCounts, null);
    assert.equal(view.freshnessLabel, 'Last loaded time unavailable');
    assert.equal(view.rows[0].stateLabel, 'Last loaded enabled');
  }
  const badClock = overview({ watches: [watch()], nowMs: NaN });
  assert.equal(badClock.currentCounts, null);
  assert.equal(badClock.freshnessLabel, 'Last loaded time unavailable');
});

test('Home retains exact source identity and links every source to its shared watching door', () => {
  const source = watch({
    slug: 'source/%?a',
    name: 'the exact saved name',
    source: ' A source in the owner’s words ',
    lookFor: 'A very specific signal, as saved.',
    enabled: false,
  });
  const row = overview({ watches: [source] }).rows[0];
  assert.deepEqual(
    { slug: row.slug, name: row.name, source: row.source, lookFor: row.lookFor, enabled: row.enabled, href: row.href },
    { slug: source.slug, name: source.name, source: source.source, lookFor: source.lookFor, enabled: false, href: '/watching' },
  );
  assert.equal(row.stateLabel, 'Paused');
});

test('Home shows at most three sources, preferring valid recent reports without mutating its input', () => {
  const rows = [
    watch({ slug: 'old', lastRun: report('2026-10-16T11:00:00.000Z') }),
    watch({ slug: 'unknown' }),
    watch({ slug: 'recent', lastRun: report('2026-10-17T11:59:00.000Z') }),
    watch({ slug: 'middle', lastRun: report('2026-10-17T10:00:00.000Z') }),
    watch({ slug: 'future', lastRun: report('2026-10-18T11:00:00.000Z') }),
  ];
  const before = structuredClone(rows);
  const view = overview({ watches: Object.freeze(rows) });
  assert.deepEqual(view.rows.map((row) => row.slug), ['recent', 'middle', 'old']);
  assert.deepEqual(view.currentCounts, { total: 5, enabled: 5 });
  assert.equal(view.rows.every((row) => row.href === '/watching'), true);
  assert.deepEqual(rows, before);
});

test('equal or unavailable report times keep the original source order', () => {
  const rows = ['b', 'a', 'c', 'd'].map((slug) => watch({ slug }));
  assert.deepEqual(overview({ watches: rows }).rows.map((row) => row.slug), ['b', 'a', 'c']);
  for (const source of rows) source.lastRun = report('2026-10-17T11:00:00.000Z');
  assert.deepEqual(overview({ watches: rows }).rows.map((row) => row.slug), ['b', 'a', 'c']);
});

test('missing reports and absent retained reports do not erase history or claim a successful check', () => {
  const view = overview({ watches: [
    watch({ slug: 'missing', lastRun: report('2026-10-17T11:59:00.000Z', 'missing') }),
    watch({ slug: 'no-retained', totals: { runs: 100, findings: 50, raised: 20, learned: 10 } }),
  ] });
  assert.deepEqual(view.rows.map(({ reportStatus, reportLabel, reportAt, reportTimeLabel }) => ({ reportStatus, reportLabel, reportAt, reportTimeLabel })), [
    { reportStatus: 'unconfirmed', reportLabel: 'Report unconfirmed', reportAt: null, reportTimeLabel: null },
    { reportStatus: 'none', reportLabel: 'No retained report', reportAt: null, reportTimeLabel: null },
  ]);
  assert.doesNotMatch(JSON.stringify(view), /never checked|not checked|nothing new/i);
});

test('a retained report keeps its exact timestamp, while invalid and future report times stay unknown', () => {
  const at = '2026-10-17T11:58:00.000Z';
  const confirmed = overview({ watches: [watch({ lastRun: report(at) })] }).rows[0];
  assert.equal(confirmed.reportAt, at);
  assert.equal(confirmed.reportTimeLabel, '2m ago');
  for (const invalid of ['', 'not a date', '0', '2026-02-30T11:00:00.000Z', '2026-10-17T12:00:00.001Z']) {
    const row = overview({ watches: [watch({ lastRun: report(invalid) })] }).rows[0];
    assert.equal(row.reportStatus, 'retained');
    assert.equal(row.reportAt, null);
    assert.equal(row.reportTimeLabel, 'Time unavailable');
  }
});

test('raw finding, learned, and lifetime counts do not turn into new updates or memory claims', () => {
  const plain = watch({ lastRun: report('2026-10-17T11:55:00.000Z') });
  const withHistory = watch({
    ...plain,
    lastRun: { ...plain.lastRun!, findings: 700, surfaced: 60, learned: 12 },
    findings: [{ key: 'retained', title: 'An earlier finding', at: '2026-10-16T10:00:00.000Z', surfaced: true }],
    learned: [{ text: 'A retained learning entry', at: '2026-10-16T10:00:00.000Z' }],
    totals: { runs: 1_000, findings: 900, raised: 80, learned: 50 },
  });
  assert.deepEqual(overview({ watches: [withHistory] }), overview({ watches: [plain] }));
});

test('identical duplicate slugs describe one watch rather than inflating Home counts', () => {
  const source = watch({ lastRun: report('2026-10-17T11:55:00.000Z') });
  const view = overview({ watches: [source, structuredClone(source)] });
  assert.deepEqual(view.currentCounts, { total: 1, enabled: 1 });
  assert.equal(view.rows.length, 1);
});

test('conflicting duplicate settings or retained reports withhold that source and current counts', () => {
  const source = watch({ lastRun: report('2026-10-17T11:55:00.000Z') });
  for (const conflict of [
    watch({ ...source, enabled: false }),
    watch({ ...source, source: 'A different source' }),
    watch({ ...source, lookFor: 'A different signal' }),
    watch({ ...source, schedule: '0 9 * * *' }),
    watch({ ...source, lastRun: report('2026-10-17T11:56:00.000Z') }),
  ]) {
    const view = overview({ watches: [source, watch({ slug: 'unambiguous' }), conflict] });
    assert.equal(view.status, 'unconfirmed');
    assert.equal(view.currentCounts, null);
    assert.match(view.detail, /Conflicting watch details were left out/);
    assert.deepEqual(view.rows.map((row) => row.slug), ['unambiguous']);
    assert.equal(view.rows[0].stateLabel, 'Last loaded enabled');
  }
});

test('duplicate conflicts do not hide a refresh error or discard unambiguous cached sources', () => {
  const source = watch();
  const view = overview({ state: 'error', watches: [source, watch({ enabled: false }), watch({ slug: 'retained-source' })] });
  assert.equal(view.status, 'error');
  assert.match(view.detail, /last loaded/);
  assert.match(view.detail, /Conflicting watch details/);
  assert.equal(view.currentCounts, null);
  assert.deepEqual(view.rows.map((row) => row.slug), ['retained-source']);
});
