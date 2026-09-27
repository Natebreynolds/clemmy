/**
 * Run: node scripts/run-tests-isolated.mjs apps/mobile-web/src/lib/memory-work.test.ts
 *
 * "Memory at work" on the phone. The pins that matter are the honesty ones,
 * because each failure is silent on a screen: a pulse with no job running, a
 * zero the daemon never counted, a model the phone named on its own, an
 * empty list where a failed read should be.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MEMORY_ROLE_WORDS, type MemoryWorkSnapshot } from '@clem/chat-engine';
import type { ModelSettings } from './api';
import {
  MEMORY_WORK_LIVE_MS,
  MEMORY_WORK_POLL_MS,
  ageText,
  countText,
  dayStrip,
  durationText,
  groupByDay,
  hourCaption,
  hourStrip,
  hourStripSummary,
  keptText,
  memoryEventView,
  memoryJobGroups,
  memoryModelView,
  memoryWorkLive,
  memoryWorkStatus,
  normalizeMemoryWork,
  pipelineView,
  queueLine,
  recentEmptyText,
  retentionText,
  serverNow,
  todayFigures,
  undoConfirmText,
  undoOutcomeText,
  type MemoryWorkRead,
  type MemoryWorkView,
} from './memory-work';
import {
  FIXTURE_MEMORY_MODEL,
  FIXTURE_STAND_IN_MODEL,
  memoryModelSettingsFixture,
  memoryWorkFixture,
} from './memory-work.fixture';
import {
  ROLE_COPY,
  inactiveNote,
  modelLabel,
  roleAutomaticText,
  roleNote,
  roleSummary,
  sameFamilyWarning,
} from './model-roles';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** A fixed afternoon on this machine's calendar, so day labels are stable. */
const NOW = new Date(2026, 8, 26, 15, 20, 0).getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;

const namer = (id: string) => `Named ${id}`;

function view(state: MemoryWorkSnapshot['state'], patch: Partial<MemoryWorkSnapshot> = {}): MemoryWorkView {
  return normalizeMemoryWork({ ...memoryWorkFixture(state, NOW), ...patch })!;
}

function readOf(snapshot: MemoryWorkView | null, over: Partial<MemoryWorkRead> = {}): MemoryWorkRead {
  return { snapshot, error: null, offline: false, receivedAt: NOW, now: NOW, ...over };
}

// ───────────────────────────── reading the snapshot ─────────────────────────────

test('a daemon answer missing fields cannot crash Memory, and nothing missing becomes a zero', () => {
  assert.equal(normalizeMemoryWork(null), null);
  assert.equal(normalizeMemoryWork('nope'), null);
  const bare = normalizeMemoryWork({ state: 'dreaming' })!;
  assert.equal(bare.state, 'unknown', 'an unrecognised state is unknown, never resting');
  assert.deepEqual([bare.running, bare.jobs, bare.hourly, bare.daily, bare.recent], [[], [], [], [], []]);
  assert.deepEqual(bare.queue, { toLearn: null, setAside: null, failed: null });
  assert.equal(bare.today, null);
  assert.equal(bare.retention, null);
  assert.deepEqual(bare.model, { source: 'automatic', modelId: null });
});

test('ages run on the Mac\'s clock: when the snapshot was built plus the time since it arrived', () => {
  const generated = new Date(NOW).toISOString();
  assert.equal(serverNow(generated, 1_000, 6_000), NOW + 5_000, 'a phone clock hours off does not move ages');
  assert.equal(serverNow(undefined, 1_000, 6_000), 6_000);
  assert.equal(serverNow('garbage', 1_000, 6_000), 6_000);
  assert.equal(ageText(new Date(NOW - 20_000).toISOString(), NOW), 'just now');
  assert.equal(ageText(new Date(NOW - 4 * 60_000).toISOString(), NOW), '4 min ago');
  assert.equal(ageText(new Date(NOW - 3 * HOUR).toISOString(), NOW), '3 h ago');
  assert.equal(ageText(new Date(NOW - DAY - HOUR).toISOString(), NOW), 'yesterday');
  assert.equal(ageText(new Date(NOW - 3 * DAY).toISOString(), NOW), '3 days ago');
  assert.equal(durationText(38_000), '38 s');
  assert.equal(durationText(400), 'under 1 s');
  assert.equal(durationText(Number.NaN), '');
});

// ───────────────────────────── the pulse is a certificate ─────────────────────────────

test('only a fresh, successful read of a running job may pulse', () => {
  const working = view('working');
  assert.equal(memoryWorkLive(readOf(working)), true);
  assert.equal(memoryWorkStatus(readOf(working), namer)?.pulse, true);

  const failedRefresh = memoryWorkStatus(readOf(working, { error: 'HTTP 500' }), namer)!;
  assert.equal(failedRefresh.pulse, false, 'a failed poll cannot vouch that the job is still running');
  assert.match(failedRefresh.stale ?? '', /Couldn’t refresh/);
  assert.equal(memoryWorkStatus(readOf(working, { offline: true }), namer)?.pulse, false);

  const old = readOf(working, { receivedAt: NOW - MEMORY_WORK_LIVE_MS - 1 });
  assert.equal(memoryWorkLive(old), false, 'a read three polls old is history, not now');
  assert.equal(memoryWorkLive(readOf(view('working', { running: [] }))), false,
    'working with nothing in running is not a certificate');
  for (const state of ['resting', 'waiting', 'off', 'unknown'] as const) {
    assert.equal(memoryWorkStatus(readOf(view(state)), namer)?.pulse, false, `${state} never pulses`);
  }
  assert.ok(MEMORY_WORK_LIVE_MS > MEMORY_WORK_POLL_MS * 2, 'one late poll does not stop a real pulse');
});

test('a failed first read says so before any empty state; loading says nothing yet', () => {
  assert.equal(memoryWorkStatus(readOf(null), namer), null, 'still loading: the skeleton shows');
  assert.equal(memoryWorkStatus(readOf(null, { error: 'HTTP 500' }), namer)?.text, 'Couldn’t read memory work just now');
  assert.equal(memoryWorkStatus(readOf(null, { offline: true }), namer)?.text, 'Can’t reach your Mac right now');
  assert.equal(recentEmptyText(null), null);
  assert.equal(recentEmptyText(view('unknown')), null, 'an unread day is not "nothing happened"');
  assert.match(recentEmptyText(view('resting', { recent: [] })) ?? '', /^Nothing in the last 7 days\./);
});

test('the headline names the running job, the wait, and the model by its catalog name', () => {
  const working = memoryWorkStatus(readOf(view('working')), namer)!;
  assert.equal(working.text, 'Reading a finished conversation · “Supplier onboarding call”');
  assert.equal(working.detail, 'part 2 of 3');
  const waiting = memoryWorkStatus(readOf(view('waiting')), namer)!;
  assert.equal(waiting.tone, 'waiting');
  assert.equal(waiting.text, `Named ${FIXTURE_MEMORY_MODEL} is out of quota`);
  assert.match(waiting.detail ?? '', /^Learning resumes around /);
  const busy = memoryWorkStatus(readOf(view('waiting', {
    waiting: { reason: 'busy', blocker: { kind: 'workflow', startedAt: new Date(NOW - 3 * HOUR).toISOString() } },
  })), namer)!;
  assert.equal(busy.text, 'Waiting for a workflow to finish before learning');
  assert.equal(busy.detail, 'started 3 h ago');
  assert.equal(memoryWorkStatus(readOf(view('off')), namer)?.text, 'Learning is turned off');
});

// ───────────────────────────── unknown is not zero ─────────────────────────────

test('today\'s pipeline shows "—" for anything the daemon could not count', () => {
  const unknown = pipelineView(view('unknown'), false);
  assert.deepEqual(unknown.map((s) => s.value), ['—', '—', '—', '—', '—']);
  assert.ok(unknown.every((s) => !s.known));

  const partial = view('resting');
  partial.today = { ...partial.today!, learned: null as unknown as number, updated: null as unknown as number };
  assert.equal(pipelineView(partial, false).find((s) => s.id === 'kept')?.value, '—',
    'two unread counts do not add up to a zero');

  const zero = view('resting');
  zero.today = { ...zero.today!, faded: 0 };
  assert.equal(pipelineView(zero, false).find((s) => s.id === 'faded')?.value, '0', 'a counted zero is a zero');
  assert.equal(countText(undefined), '—');
  assert.equal(countText(Number.NaN), '—');
  assert.equal(countText(1234), (1234).toLocaleString());
  assert.deepEqual(todayFigures(view('unknown')), []);
});

test('a journal the daemon could not read never says a job did not run', () => {
  // The daemon's unread snapshot: jobs with no last run, zero-filled totals
  // and retention still set (see the fixture). None of it was counted.
  const unread = view('unknown');
  assert.ok(unread.retention && unread.jobs.length > 0);
  assert.ok(unread.jobs.every((j) => !j.lastRun && j.today.runs === 0));
  const jobs = memoryJobGroups(unread, namer, NOW, false).flatMap((g) => g.jobs);
  assert.ok(jobs.length > 0);
  for (const job of jobs) {
    assert.doesNotMatch(job.last, /No run|No recent run/, `${job.id}: an unread journal is not "no run"`);
    assert.equal(job.last, 'Last run —');
    assert.equal(job.today, null, `${job.id}: zero-filled totals on an unread day are not today's figures`);
  }
});

test('a stage lights only while its job runs, and only on a live read', () => {
  const working = view('working');
  const lit = pipelineView(working, true).filter((s) => s.lit).map((s) => s.id);
  assert.deepEqual(lit, ['read', 'found', 'aside'], 'the learn job lights the stages it feeds');
  assert.deepEqual(pipelineView(working, false).filter((s) => s.lit), [], 'no live certificate, no light');
  assert.deepEqual(pipelineView(view('resting'), true).filter((s) => s.lit), []);
});

test('today\'s figures fit one row and show a cost only when every call was priced', () => {
  const figures = todayFigures(view('resting'));
  assert.deepEqual(figures.map((f) => f.label), ['runs', 'model calls', 'tokens in / out']);
  const priced = view('resting');
  priced.today = { ...priced.today!, costUsd: 0.004 };
  assert.deepEqual(todayFigures(priced).at(-1), { value: 'under $0.01', label: 'spent' });
  priced.today = { ...priced.today!, costUsd: 1.5 };
  assert.equal(todayFigures(priced).at(-1)?.value, '$1.50');
  assert.ok(todayFigures(priced).length <= 4);
});

// ───────────────────────────── the model ─────────────────────────────

test('the model row names the memory route\'s own model and who picked it', () => {
  const automatic = memoryModelView(view('resting'), namer, NOW)!;
  assert.equal(automatic.name, `Named ${FIXTURE_MEMORY_MODEL}`);
  assert.equal(automatic.source, `Automatic · ${MEMORY_ROLE_WORDS.automaticChecker}`);
  assert.equal(automatic.served, null, 'the model that served is the one named: nothing extra to say');

  const chosen = memoryModelView(view('resting', { model: { source: 'chosen', modelId: FIXTURE_MEMORY_MODEL } }), namer, NOW)!;
  assert.equal(chosen.source, 'Chosen');
  assert.equal(chosen.chosen, true);

  const standIn = memoryModelView(view('resting', {
    model: { source: 'chosen', modelId: FIXTURE_MEMORY_MODEL, lastServed: { modelId: FIXTURE_STAND_IN_MODEL, at: new Date(NOW - 60_000).toISOString(), standIn: true } },
  }), namer, NOW)!;
  assert.deepEqual(standIn.served, { text: `Last run used a stand-in: Named ${FIXTURE_STAND_IN_MODEL}`, standIn: true });

  const changed = memoryModelView(view('resting', {
    model: { source: 'automatic', modelId: FIXTURE_MEMORY_MODEL, follows: 'brain', lastServed: { modelId: 'older-model', at: new Date(NOW - 2 * HOUR).toISOString(), standIn: false } },
  }), namer, NOW)!;
  assert.equal(changed.served?.standIn, false);
  assert.match(changed.served?.text ?? '', /^Last run used Named older-model, 2 h ago$/);
  assert.equal(changed.source, `Automatic · ${MEMORY_ROLE_WORDS.automaticBrain}`);
});

test('an unavailable model is said once, and a failed read never claims there is no model', () => {
  assert.equal(memoryModelView(view('waiting'), namer, NOW)?.problem, null, 'the headline already says it');
  const resting = memoryModelView(view('resting', {
    model: { source: 'automatic', modelId: FIXTURE_MEMORY_MODEL, unavailable: { problem: 'credit' } },
  }), namer, NOW)!;
  assert.equal(resting.problem, 'This model is out of credit');
  assert.equal(memoryModelView(view('unknown'), namer, NOW)?.name, '—');
  const none = memoryModelView(view('resting', { model: { source: 'automatic', modelId: null, follows: null } }), namer, NOW)!;
  assert.equal(none.name, 'No model available right now');
  assert.equal(none.source, `Automatic · ${MEMORY_ROLE_WORDS.automaticNone}`);
});

// ───────────────────────────── activity strips ─────────────────────────────

test('the 24-hour strip draws what was counted and marks the hour the Mac is in', () => {
  assert.equal(hourStrip(view('unknown'), NOW), null);
  assert.equal(hourStripSummary(null), 'Last 24 hours · —');
  const strip = hourStrip(view('resting'), NOW)!;
  assert.equal(strip.bars.length, 24);
  assert.equal(strip.metric, 'modelCalls');
  assert.equal(Math.max(...strip.bars.map((b) => b.height)), 1);
  assert.ok(strip.bars.every((b) => b.height >= 0 && b.height <= 1));
  assert.deepEqual(strip.bars.map((b) => b.current), strip.bars.map((_, i) => i === 23));
  assert.match(hourStripSummary(strip), /^Last 24 hours · \d+ runs · \d+ model calls · \d+ learned$/);
  assert.match(hourCaption(strip.bars[23]!), /^This hour · /);

  const quiet = view('resting', { hourly: memoryWorkFixture('resting', NOW).hourly.map((h) => ({ ...h, modelCalls: 0 })) });
  assert.equal(hourStrip(quiet, NOW)?.metric, 'runs', 'a day of local-only work still has a shape');
  const empty = view('resting', { hourly: memoryWorkFixture('resting', NOW).hourly.map((h) => ({ ...h, runs: 0, modelCalls: 0, learned: 0 })) });
  assert.equal(hourStripSummary(hourStrip(empty, NOW)), 'Last 24 hours · no memory work');
});

test('the 30-day strip shows the days the daemon kept, never padding with invented zeros', () => {
  const twelve = view('resting', { daily: memoryWorkFixture('resting', NOW).daily.slice(-12) });
  const strip = dayStrip(twelve, NOW)!;
  assert.equal(strip.bars.length, 12);
  assert.match(strip.summary, /^Last 12 days · /);
  assert.equal(strip.bars.at(-1)?.today, true);
  assert.equal(dayStrip(view('resting', { daily: [] }), NOW), null);
});

// ───────────────────────────── runs and undo ─────────────────────────────

test('a run reads in plain words with only what was measured', () => {
  const [learn, index, , reconcile, failed] = view('resting').recent;
  const v = memoryEventView(learn!, namer, NOW);
  assert.equal(v.sentence, 'Learned 3 memories, updated 1 from “Quarterly planning notes”');
  assert.equal(v.model, `Named ${FIXTURE_MEMORY_MODEL}`);
  assert.deepEqual(v.meta, ['3 model calls', '11k tokens', '38 s']);
  assert.equal(v.tone, 'ok');
  assert.deepEqual(v.undo, { kind: 'forget', count: 2, text: 'Forget these 2' });
  assert.equal(v.kept, 'This record is kept 7 more days');
  assert.deepEqual(v.facts.map((f) => [f.change, f.state]), [
    ['learned', null], ['learned', null], ['learned', 'no longer in use'], ['updated', null],
  ]);
  assert.equal(v.facts[0]!.factId, 101);

  const local = memoryEventView(index!, namer, NOW);
  assert.equal(local.model, null, 'no model ran: none is named');
  assert.ok(!local.meta.some((m) => /model call|tokens/.test(m)), 'zero calls and zero tokens are not news');
  assert.equal(memoryEventView(reconcile!, namer, NOW).standIn, true);

  const fail = memoryEventView(failed!, namer, NOW);
  assert.equal(fail.tone, 'failed');
  assert.equal(fail.sentence, 'Learning from conversations did not finish: the model is out of quota');
  assert.equal(fail.undo, null);
  assert.deepEqual(fail.meta, []);
});

test('undo appears only while it would change something, and forgetting asks first', () => {
  const tidy = view('resting').recent.find((e) => e.job === 'tidy')!;
  const restore = memoryEventView(tidy, namer, NOW);
  assert.deepEqual(restore.undo, { kind: 'restore', count: 2, text: 'Bring back 2' });
  assert.equal(undoConfirmText(restore.undo!), null, 'bringing a memory back needs no question');
  assert.deepEqual(restore.facts.map((f) => f.state), [null, null, 'back in use']);
  assert.equal(restore.moreFacts, 0);
  assert.equal(memoryEventView({ ...tidy, undo: { kind: 'restore', count: 0 } }, namer, NOW).undo, null);
  assert.equal(memoryEventView({ ...tidy, undo: null }, namer, NOW).undo, null);
  assert.equal(undoConfirmText({ kind: 'forget', count: 1, text: '' }), 'Forget the memory this run learned?');
  assert.equal(undoConfirmText({ kind: 'forget', count: 3, text: '' }), 'Forget the 3 memories this run learned?');

  assert.deepEqual(undoOutcomeText({ ok: true, changed: 2 }, 'forget'), { ok: true, text: 'Forgot 2 memories.' });
  assert.deepEqual(undoOutcomeText({ ok: true, changed: 1 }, 'restore'), { ok: true, text: 'Brought back 1 memory.' });
  assert.deepEqual(undoOutcomeText({ ok: true, changed: 0 }, 'forget'), { ok: true, text: 'Nothing left to undo.' });
  assert.deepEqual(undoOutcomeText({ ok: false, reason: 'nothing_to_undo' }, 'forget'), { ok: true, text: 'Nothing left to undo.' });
  assert.equal(undoOutcomeText({ ok: false, reason: 'expired' }, 'forget').ok, false);
  assert.equal(undoOutcomeText({ ok: false, reason: 'not_found' }, 'restore').ok, false);
  // The same words as the Mac's (@clem/chat-engine).
  assert.equal(undoOutcomeText({ ok: false, reason: 'failed' }, 'restore').text, 'Couldn’t undo just now. Nothing was changed.');
  assert.equal(undoOutcomeText({ ok: false, reason: 'not_found' }, 'restore').text, 'That run is no longer in the history.');
  assert.deepEqual(undoOutcomeText(null, 'forget'), { ok: false, text: 'Couldn’t undo just now. Nothing was changed.' });
});

test('a run lists at most what the daemon sent and says how many more it changed', () => {
  const learn = view('resting').recent[0]!;
  const trimmed = memoryEventView({ ...learn, produced: { learned: 9, updated: 1 }, facts: learn.facts!.slice(0, 2) }, namer, NOW);
  assert.equal(trimmed.moreFacts, 8);
  assert.equal(memoryEventView({ ...learn, facts: [] }, namer, NOW).moreFacts, 0, 'no ids at all: no "more" line');
});

test('records say when they age out; the memories they changed do not', () => {
  assert.equal(keptText(new Date(NOW + 6 * DAY).toISOString(), NOW), 'This record is kept 6 more days');
  assert.equal(keptText(new Date(NOW + DAY).toISOString(), NOW), 'This record ages out tomorrow');
  assert.equal(keptText(new Date(NOW + HOUR).toISOString(), NOW), 'This record ages out today');
  assert.equal(keptText(undefined, NOW), '');
  assert.equal(retentionText({ detailDays: 7, summaryDays: 90 }),
    'Clem keeps the detail of each run for 7 days and daily totals for 90 days, then deletes them.');
  assert.equal(retentionText(null), null);
});

test('runs group under Today, Yesterday, then the weekday', () => {
  const at = (ms: number) => ({ at: new Date(NOW - ms).toISOString() });
  const groups = groupByDay([at(HOUR), at(2 * HOUR), at(DAY), at(3 * DAY)], NOW);
  assert.deepEqual(groups.map((g) => g.items.length), [2, 1, 1]);
  assert.deepEqual(groups.slice(0, 2).map((g) => g.label), ['Today', 'Yesterday']);
  assert.equal(groups[2]!.label, new Date(NOW - 3 * DAY).toLocaleDateString(undefined, { weekday: 'long' }));
});

test('the queue is a quiet line of non-zero counts, never a call to action', () => {
  assert.equal(queueLine({ toLearn: 4, setAside: 3, failed: 1 }),
    '3 set aside for a second look · 1 part could not be read after every retry');
  assert.equal(queueLine({ toLearn: 4, setAside: 0, failed: 0 }), null);
  assert.equal(queueLine({ toLearn: null, setAside: null, failed: null }), null);
  assert.equal(queueLine(undefined), null);
});

// ───────────────────────────── jobs ─────────────────────────────

test('jobs list in the shared order, learning first, import only once it has run', () => {
  const groups = memoryJobGroups(view('resting'), namer, NOW, false);
  assert.deepEqual(groups.map((g) => g.label), ['Learning', 'Upkeep']);
  assert.deepEqual(groups[0]!.jobs.map((j) => j.id), ['learn', 'reconcile', 'patterns', 'skills', 'identity']);
  assert.deepEqual(groups[1]!.jobs.map((j) => j.id), ['standing', 'verify', 'index', 'tidy']);

  const imported = view('resting');
  imported.jobs = imported.jobs.map((j) => (j.id === 'import' ? { ...j, lastRun: { at: new Date(NOW - HOUR).toISOString(), outcome: 'ok' as const } } : j));
  assert.ok(memoryJobGroups(imported, namer, NOW, false)[0]!.jobs.some((j) => j.id === 'import'));

  const learn = groups[0]!.jobs[0]!;
  assert.equal(learn.model, `Named ${FIXTURE_MEMORY_MODEL} · ${MEMORY_ROLE_WORDS.title}`);
  assert.match(learn.last, /^Last ran 4 min ago · done$/);
  assert.equal(learn.next, 'After each conversation, when Clem is idle');
  assert.equal(learn.today, '6 runs today · 14 model calls · 46k tokens');
  const byId = new Map(groups.flatMap((g) => g.jobs).map((j) => [j.id, j]));
  assert.equal(byId.get('standing')?.model, 'Named checker-model · Checks the work');
  assert.equal(byId.get('index')?.model, 'local-embedder · Runs on this Mac', 'the local model is a file, not a catalog name');
  assert.equal(byId.get('tidy')?.model, 'No model');
  assert.equal(byId.get('identity')?.last, 'No run recorded yet', 'no record is not "not in 7 days": a restart forgets quiet runs');
  assert.equal(byId.get('identity')?.today, null);
});

test('a running job pulses only on a live read', () => {
  const working = view('working');
  const live = memoryJobGroups(working, namer, NOW, true)[0]!.jobs[0]!;
  assert.equal(live.pulse, true);
  assert.equal(live.stateText, 'Reading a finished conversation');
  const stale = memoryJobGroups(working, namer, NOW, false)[0]!.jobs[0]!;
  assert.equal(stale.pulse, false);
  assert.equal(stale.stateText, 'Running at the last check');
  assert.equal(memoryJobGroups(view('waiting'), namer, NOW, false)[0]!.jobs[0]!.stateText, 'Waiting');
  assert.equal(memoryJobGroups(view('off'), namer, NOW, false)[0]!.jobs[0]!.stateText, 'Off');
  assert.deepEqual(memoryJobGroups(null, namer, NOW, true), []);
});

// ───────────────────────────── Keeps your memory in Settings ─────────────────────────────

const settings = memoryModelSettingsFixture() as unknown as ModelSettings;

test('the memory role uses the desktop\'s words and the daemon\'s "follows"', () => {
  assert.equal(ROLE_COPY.memory.title, MEMORY_ROLE_WORDS.title);
  assert.equal(ROLE_COPY.memory.explain, MEMORY_ROLE_WORDS.explain);
  assert.equal(roleAutomaticText('memory', { follows: 'checker', modelId: 'm-1' }), MEMORY_ROLE_WORDS.automaticChecker);
  assert.equal(roleAutomaticText('memory', { follows: 'brain', modelId: 'm-1' }), MEMORY_ROLE_WORDS.automaticBrain);
  assert.equal(roleAutomaticText('memory', { follows: null, modelId: 'm-1' }), MEMORY_ROLE_WORDS.automaticOwn,
    'a named model that is neither the checker\'s nor the brain\'s is Clem\'s own pick, not "none available"');
  assert.equal(roleAutomaticText('memory', {}), MEMORY_ROLE_WORDS.automaticNone);
  assert.equal(roleAutomaticText('judge', { follows: 'brain' }), ROLE_COPY.judge.automatic, 'other roles keep their own words');
  assert.equal(ROLE_COPY.memory.saved, 'Saved. The next memory job uses it.');
  assert.equal(ROLE_COPY.writer.saved, undefined, 'request roles keep "applies to your next message"');
});

test('the memory row names its model from the catalog, including a memory-only model', () => {
  assert.equal(roleSummary('memory', settings), 'Automatic · Provider A — Quick model');
  const onlyMemory: ModelSettings = {
    ...settings,
    roleOptions: { memory: [{ provider: 'byo', providerId: 'p', label: 'Provider C', models: [{ id: 'm-only', label: 'Tiny model' }] }] },
    roles: { memory: { modelId: 'm-only', provider: 'byo', source: 'settings' } },
  };
  assert.equal(roleSummary('memory', onlyMemory), 'Provider C — Tiny model');
  assert.equal(modelLabel('m-only', onlyMemory), 'Provider C — Tiny model');
  assert.equal(modelLabel('m-only', null), 'm-only', 'before the catalog loads, an id shows as itself');
  assert.equal(modelLabel('unknown-id', settings), 'unknown-id');
});

test('the memory row says whose model Automatic borrows from the daemon\'s "follows", never from a matching id', () => {
  assert.equal(roleNote('memory', settings), MEMORY_ROLE_WORDS.automaticChecker);
  // The daemon resolved the checker's model, which happens to be the brain's
  // id too: the row still says the checker, as the picker does.
  const sharedId: ModelSettings = {
    ...settings,
    roles: { ...settings.roles, memory: { modelId: 'brain-model', provider: 'byo', source: 'default', follows: 'checker' } },
  };
  assert.equal(roleSummary('memory', sharedId), 'Automatic · Provider A — Main model');
  assert.equal(roleNote('memory', sharedId), MEMORY_ROLE_WORDS.automaticChecker);
  assert.equal(roleNote('memory', sharedId), roleAutomaticText('memory', sharedId.roles!.memory), 'row and picker agree');
  const brain: ModelSettings = { ...settings, roles: { ...settings.roles, memory: { ...sharedId.roles!.memory!, follows: 'brain' } } };
  assert.equal(roleNote('memory', brain), MEMORY_ROLE_WORDS.automaticBrain);
  const chosen: ModelSettings = { ...settings, roles: { ...settings.roles, memory: { modelId: FIXTURE_MEMORY_MODEL, provider: 'byo', source: 'settings', follows: 'checker' } } };
  assert.equal(roleNote('memory', chosen), null, 'a chosen model borrows nothing');
  const none: ModelSettings = { ...settings, roles: { ...settings.roles, memory: { modelId: '', provider: '', source: 'default', follows: 'checker' } } };
  assert.equal(roleNote('memory', none), null, 'no model: the summary already says so');
  const unsaid: ModelSettings = { ...settings, roles: { ...settings.roles, memory: { modelId: FIXTURE_MEMORY_MODEL, provider: 'byo', source: 'default' } } };
  assert.equal(roleNote('memory', unsaid), null, 'an older daemon that does not say whose model: the phone does not guess');
  assert.equal(roleNote('writer', settings), null);
  assert.equal(roleSummary('writer', settings), 'Same model that does the work', 'request roles keep their reading');
});

test('with no model at all the memory row says so, and a missing pick waits instead of naming a stand-in', () => {
  const none: ModelSettings = { ...settings, roles: { ...settings.roles, memory: { modelId: '', provider: '', source: 'default', follows: null } } };
  assert.equal(roleSummary('memory', none), 'Automatic · no model available right now');
  const inactive: ModelSettings = {
    ...settings,
    roles: {
      ...settings.roles,
      memory: { modelId: '', provider: '', source: 'settings', inactiveBinding: { modelId: FIXTURE_STAND_IN_MODEL, provider: 'byo', reason: 'not connected' } },
    },
  };
  assert.equal(roleSummary('memory', inactive), 'Provider B — Backup model · not available right now');
  assert.equal(inactiveNote(inactive.roles!.memory, inactive, 'memory'),
    'Your pick, Provider B — Backup model, isn\'t available, so learning waits until it is back. Nothing is lost.');
  const sameId = { modelId: FIXTURE_STAND_IN_MODEL, provider: 'byo', source: 'settings', inactiveBinding: { modelId: FIXTURE_STAND_IN_MODEL, provider: 'byo', reason: 'x' } };
  assert.match(inactiveNote(sameId, settings, 'memory') ?? '', /learning waits until it is back/,
    'a pick reported under its own id is still a wait, never "used instead"');
  assert.equal(inactiveNote(sameId, settings, 'judge'), null, 'request roles keep their existing reading');
  const judge = { modelId: FIXTURE_MEMORY_MODEL, provider: 'byo', source: 'default', inactiveBinding: { modelId: FIXTURE_STAND_IN_MODEL, provider: 'byo', reason: 'x' } };
  assert.equal(inactiveNote(judge, settings, 'judge'),
    'Your pick, Provider B — Backup model, isn\'t available, so Provider A — Quick model is used instead.',
    'a request role that does substitute still says what runs');
  const memoryChosen: ModelSettings = {
    ...settings, judgeReviewsOwnFamily: true,
    roles: { ...settings.roles, memory: { modelId: FIXTURE_MEMORY_MODEL, provider: 'byo', source: 'settings' } },
  };
  assert.equal(sameFamilyWarning(memoryChosen), null, 'choosing the memory model is not a checker-independence choice');
});

// ───────────────────────────── source pins ─────────────────────────────

test('Memory shows the card above the tabs, polls only while on screen, and needs no new props', () => {
  const memory = read('../screens/Memory.tsx');
  assert.match(memory, /<MemoryWorkCard[\s\S]*?<div class="memory-tabs" role="tablist">/,
    'the card sits above Memories / People');
  assert.match(memory, /searchQuery \? \([\s\S]*?<SearchResults[\s\S]*?\) : \([\s\S]*?<MemoryWorkCard/,
    'search results replace the card, as they replace the tabs');
  assert.match(memory, /intervalMs: MEMORY_WORK_POLL_MS/);
  assert.match(memory, /disabled: openFactId !== null \|\| openEntityId !== null \|\| \(Boolean\(searchQuery\) && !workOpen\)/);
  assert.match(memory, /useBackGesture\(workOpen, leaveWork\)/, 'the full view closes with the swipe-back gesture');
  assert.match(memory, /const leaveWork = \(\) => \{ setModelSheet\(false\); setWorkOpen\(false\); \};/,
    'a swipe while the picker is open over the full view closes both, never leaving the sheet over the card');
  assert.match(memory, /const closeWork = \(\) => withDepthTransition\(leaveWork\);/, 'the arrow and the swipe close the same way');
  assert.doesNotMatch(read('../components/RoleSheet.tsx'), /useBackGesture/,
    'the picker takes no back entry: a tap-close would unwind two levels (back-gesture.ts)');
  assert.match(memory, /<RoleSheet[\s\S]*?role=\{modelSheet \? 'memory' : null\}/, 'the picker opens in place');
  assert.match(memory, /modelSettings\?\.roles\?\.memory \?/, 'Change appears only when this Mac offers the role');
  assert.equal(MEMORY_WORK_POLL_MS, 8_000);
  const app = read('../app.tsx');
  assert.match(app, /tab === 'memory' \? <Memory \/>/, 'no props added to the Memory screen');
});

test('the pulse renders only from the certified flag, and only the headline is announced', () => {
  const parts = read('../components/MemoryWorkParts.tsx');
  const pulses = parts.match(/<span class="pulse-dot/g) ?? [];
  const guarded = parts.match(/\.pulse\s*\n?\s*\? <span class="pulse-dot/g) ?? [];
  assert.equal(pulses.length, guarded.length, 'every pulse-dot is behind a certified pulse flag');
  assert.ok(pulses.length >= 2);
  assert.equal((parts.match(/aria-live=/g) ?? []).length, 1, 'one polite live region: the headline');
  assert.match(parts, /<p class="mw-headline" aria-live="polite">/);
  // A hung poll changes no state, so the screen schedules the render that
  // stops the motion when the last read stops vouching for it.
  const memory = read('../screens/Memory.tsx');
  assert.match(memory, /useLiveExpiry\(Boolean\(work\.data && work\.data\.state === 'working' && work\.data\.running\.length > 0\), work\.updatedAt\);/);
  assert.match(memory, /function useLiveExpiry[\s\S]*?receivedAt \+ MEMORY_WORK_LIVE_MS - Date\.now\(\)[\s\S]*?setTimeout\(/);
  assert.match(memory, /receivedAt: work\.updatedAt,\s*now: Date\.now\(\),/, 'the certificate is judged on the clock at render');
  const css = read('../styles.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.mw-flow\.is-flowing i \{ animation: none;/,
    'the flow between stages is still for anyone who asked for less motion');
  assert.match(css, /\.mw-flow\.is-flowing i \{[\s\S]*?animation: rail-sweep 2\.4s linear infinite;/,
    'background work moves slower than the chat rail (1.6s)');
});

test('the phone asks the daemon for memory work at the one route, and undo is a POST', () => {
  const api = read('./api.ts');
  assert.match(api, /api<MemoryWorkSnapshot>\('\/m\/api\/memory\/work'\)/);
  assert.match(api, /`\/m\/api\/memory\/work\/\$\{encodeURIComponent\(eventId\)\}\/undo`, \{ method: 'POST' \}/);
  assert.match(api, /export type ModelRoleName = 'writer' \| 'judge' \| 'worker' \| 'memory';/);
});

test('Settings lists the memory row, and the picker warns about providers only for checker and writer', () => {
  const settingsSource = read('../screens/Settings.tsx');
  assert.match(settingsSource, /\(\['writer', 'judge', 'worker', 'memory'\] as const\)\.map\(\(role\) => settings\.roles\?\.\[role\]/,
    'a daemon that does not offer the role hides the row');
  assert.match(settingsSource, /note=\{role === 'judge' && reviewOff \? 'Review of finished work is off\.' : roleNote\(role, settings\)\}/,
    'the memory row says whose model Automatic borrows, from the daemon');
  const sheet = read('../components/RoleSheet.tsx');
  assert.match(sheet, /role === 'judge' \|\| role === 'writer' \? sameFamilyWarning\(settings\) : null/);
  assert.match(sheet, /roleAutomaticText\(role, resolved\)/);
});

test('memory-work code names no model and no provider, and the fixture never ships', () => {
  const files = ['./memory-work.ts', './memory-work.fixture.ts', '../components/MemoryWorkCard.tsx',
    '../components/MemoryWorkTimeline.tsx', '../components/MemoryWorkParts.tsx'];
  for (const file of files) {
    const source = read(file);
    for (const literal of ['gpt-', 'claude', 'opus', 'sonnet', 'haiku', 'glm', 'deepseek', 'minimax', 'grok', 'gemini', 'codex', 'openai', 'anthropic']) {
      assert.doesNotMatch(source, new RegExp(literal, 'i'), `"${literal}" must not appear in ${file}`);
    }
  }
  const srcRoot = fileURLToPath(new URL('..', import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]
  ));
  for (const file of walk(srcRoot)) {
    if (!/\.(ts|tsx)$/.test(file) || /\.test\.ts$/.test(file) || file.endsWith('memory-work.fixture.ts')) continue;
    assert.doesNotMatch(readFileSync(file, 'utf8'), /memory-work\.fixture/, `${file} must not import the fixture`);
  }
});
