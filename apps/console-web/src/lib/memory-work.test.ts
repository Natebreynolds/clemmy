/**
 * Memory at work, on the Mac: the view model the panel draws, and the pins
 * that keep the panel wired and honest.
 *
 * The rules under test are the owner's: motion only while a job runs right now
 * and the read is fresh; unknown is "—", never 0; the model named is the one
 * that answered, and a stand-in says so; undo shows only while it would still
 * change something.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MEMORY_ROLE_WORDS, type MemoryWorkEvent, type MemoryWorkSnapshot } from '@clem/chat-engine';
import {
  durationWords, elapsedClock, getMemoryWork, memoryTimeFormat, memoryUndoNotice, memoryUndoResultText, memoryWorkViewModel, UNKNOWN,
} from './memory-work.js';
import { memoryWorkFixture } from './memory-work.fixture.js';
import { JOB_ICON, jobIcon } from '../components/memory/work/job-icon.js';

const HOUR = 3_600_000;
const MIN = 60_000;
/** Mid-afternoon, local time, so "today" and "yesterday" are unambiguous. */
const NOW = new Date(2026, 8, 26, 15, 30, 0).getTime();
const iso = (t: number) => new Date(t).toISOString();

function event(over: Partial<MemoryWorkEvent> & Pick<MemoryWorkEvent, 'id'>): MemoryWorkEvent {
  return {
    job: 'learn',
    at: iso(NOW - 5 * MIN),
    outcome: 'ok',
    produced: {},
    expiresAt: iso(NOW + 7 * 24 * HOUR),
    ...over,
  };
}

function snapshot(over: Partial<MemoryWorkSnapshot> = {}): MemoryWorkSnapshot {
  return { ...memoryWorkFixture('resting', NOW), ...over };
}

// ─── the status line and motion ─────────────────────────────────────────────

test('working: the running job is named, the panel is live, and only its stages light up', () => {
  const view = memoryWorkViewModel(memoryWorkFixture('working', NOW), NOW);
  assert.equal(view.state, 'working');
  assert.equal(view.band, 'working');
  assert.equal(view.live, true);
  assert.match(view.headline, /^Reading a finished conversation · “Pricing questions from the Tuesday call”$/);
  assert.equal(view.detail, 'part 2 of 4');
  assert.equal(view.runningSince, NOW - 12_000);
  assert.deepEqual(view.runningJobs, ['learn']);
  const active = view.pipeline.filter((s) => s.active).map((s) => s.id);
  assert.deepEqual(active, ['read', 'found', 'aside'], 'learn lights the stages it feeds; kept belongs to reconcile, faded to tidy');
  assert.deepEqual(view.flows, { readToFound: true, foundToKept: false, foundToAside: true, keptToFaded: false });
  const learn = view.jobs.learning.find((j) => j.id === 'learn');
  assert.equal(learn?.stateLabel, 'Working now');
  assert.equal(learn?.dot, 'running');
});

test('a stale read never moves and never claims now: the line says the read failed', () => {
  const view = memoryWorkViewModel(memoryWorkFixture('working', NOW), NOW, { stale: true, readAt: NOW - 2 * MIN });
  assert.equal(view.live, false, 'a job read as running before the failure may have finished since');
  assert.equal(view.band, 'unknown');
  assert.equal(view.runningSince, null);
  assert.equal(view.headline, 'Couldn’t read memory work just now');
  assert.match(view.detail ?? '', /Showing what Clem reported 2 min ago\. Nothing has been lost/);
  assert.equal(view.pipeline.some((s) => s.active), false);
  assert.equal(Object.values(view.flows).some(Boolean), false);
  const learn = view.jobs.learning.find((j) => j.id === 'learn');
  assert.equal(learn?.stateLabel, null, '"Working now" is a claim about now');
  assert.notEqual(learn?.dot, 'running');
  // Everything else is the last good read, still shown.
  assert.equal(view.pipeline.find((s) => s.id === 'read')?.text, '11');
  assert.ok(view.eventCount > 0);
});

test('a read too old to vouch for now stops the motion, by the phone\'s rule', () => {
  // A poll that hangs (the daemon busy with a nightly job) is not an error,
  // so "stale" never comes; the read's age still ends the motion.
  const fresh = memoryWorkViewModel(memoryWorkFixture('working', NOW), NOW, { readAt: NOW - 5_000 });
  assert.equal(fresh.live, true);
  const old = memoryWorkViewModel(memoryWorkFixture('working', NOW), NOW, { readAt: NOW - 31_000 });
  assert.equal(old.live, false);
  assert.equal(old.runningSince, null);
  assert.equal(old.pipeline.some((s) => s.active), false);
  const learn = old.jobs.learning.find((j) => j.id === 'learn');
  assert.equal(learn?.stateLabel, null, '"Working now" is a claim about now');
  assert.notEqual(learn?.dot, 'running');
});

test('working with an empty running list is not drawn as working', () => {
  const view = memoryWorkViewModel(snapshot({ state: 'working', running: [] }), NOW);
  assert.equal(view.live, false);
  assert.equal(view.band, 'resting');
});

test('waiting on the model says which model, why, and when learning resumes', () => {
  const view = memoryWorkViewModel(memoryWorkFixture('waiting', NOW), NOW);
  assert.equal(view.band, 'waiting');
  assert.equal(view.live, false);
  assert.equal(view.headline, 'Memory Model Large is out of quota');
  assert.match(view.detail ?? '', /^Learning resumes around /);
  assert.equal(view.model.problem, 'is out of quota');
  assert.equal(view.jobs.learning.find((j) => j.id === 'learn')?.stateLabel, 'Waiting for the model');
});

test('waiting behind other work names what it waits for, not the owner', () => {
  const view = memoryWorkViewModel(snapshot({
    state: 'waiting',
    waiting: { reason: 'busy', blocker: { kind: 'workflow', startedAt: iso(NOW - 3 * HOUR) } },
    jobs: memoryWorkFixture('waiting', NOW).jobs,
  }), NOW);
  assert.equal(view.headline, 'Waiting for a workflow to finish before learning');
  assert.equal(view.detail, 'started 3 h ago');
  assert.equal(view.jobs.learning.find((j) => j.id === 'learn')?.stateLabel, 'Waiting its turn');
});

test('resting is up to date only when nothing is left to read', () => {
  const upToDate = memoryWorkViewModel(snapshot({ queue: { toLearn: 0, setAside: 0, failed: 0 } }), NOW);
  assert.equal(upToDate.headline, 'Memory is up to date');
  assert.equal(upToDate.detail, 'Last worked 4 min ago');
  assert.equal(upToDate.upToDate, true);
  const queued = memoryWorkViewModel(snapshot({ queue: { toLearn: 6, setAside: 0, failed: 0 } }), NOW);
  assert.equal(queued.headline, '6 parts of finished conversations to read next');
  assert.equal(queued.upToDate, false);
  const unread = memoryWorkViewModel(snapshot({ queue: { toLearn: null, setAside: null, failed: null } }), NOW);
  assert.equal(unread.upToDate, false, 'an unreadable queue is not "up to date" (no green mark)');
  assert.equal(unread.band, 'resting');
  assert.equal(unread.headline, 'No memory work running right now', 'nothing is running is known; up to date is not');
  assert.equal(unread.detail, 'Couldn’t read what is left to learn · Last worked 4 min ago');
  assert.equal(unread.queueLine, null, 'nor is it invented into a backlog');
});

test('off says learning is off and the learning job says so too', () => {
  const view = memoryWorkViewModel(memoryWorkFixture('off', NOW), NOW);
  assert.equal(view.headline, 'Learning is turned off');
  assert.equal(view.band, 'off');
  assert.equal(view.live, false);
  assert.equal(view.jobs.learning.find((j) => j.id === 'learn')?.stateLabel, 'Off');
});

// ─── unknown is not zero ─────────────────────────────────────────────────────

test('unknown: every count is "—" though the daemon sends zeros, and nothing is empty-by-assumption', () => {
  const view = memoryWorkViewModel(memoryWorkFixture('unknown', NOW), NOW);
  assert.equal(view.headline, 'Couldn’t read memory work just now');
  assert.ok(view.pipeline.every((s) => s.value === null && s.text === UNKNOWN), 'no stage reads 0');
  assert.ok(view.totals.every((t) => t.value === UNKNOWN), 'no total reads 0');
  assert.equal(view.totals.some((t) => t.label === 'Cost'), false);
  assert.equal(view.model.unknown, false, 'the model is described by its own read, which succeeded');
  assert.equal(view.model.name, 'Memory Model Large');
  assert.equal(view.eventCount, 0);
  assert.equal(view.hourly.length, 0);
  const noModel = memoryWorkViewModel({ ...memoryWorkFixture('unknown', NOW), model: { source: 'automatic', modelId: null } }, NOW);
  assert.equal(noModel.model.unknown, true, 'an unread model is "—", never "no model available"');
  assert.equal(noModel.model.name, null);
});

test('unknown: the job roster says "—", never "hasn’t run", "none available" or "none yet"', () => {
  const view = memoryWorkViewModel(memoryWorkFixture('unknown', NOW), NOW);
  const rows = [...view.jobs.learning, ...view.jobs.upkeep];
  assert.deepEqual(rows.map((j) => j.id), ['learn', 'reconcile', 'patterns', 'skills', 'identity', 'standing', 'verify', 'index', 'tidy'],
    'every job the daemon listed, in the shared order; importing still waits for a recorded run');
  for (const job of rows) {
    assert.equal(job.unknown, true);
    assert.equal(job.dot, 'unknown', `${job.id}: a failed read says nothing about how the job went`);
    assert.equal(job.lastWhen, null);
    assert.equal(job.lastText, UNKNOWN, `${job.id}: not "No run recorded yet"`);
    assert.equal(job.todayText, UNKNOWN, `${job.id}: a zero day sent by a failed read is not "none yet"`);
    if (job.modelOwner === 'none') assert.equal(job.modelText, 'No model', 'no model is the registry’s fact, not a read');
    else {
      assert.equal(job.modelText, UNKNOWN, `${job.id}: not "None available"`);
      assert.equal(job.modelHint, 'couldn’t be read');
    }
    assert.notEqual(job.stateLabel, 'Working now');
  }
  assert.match(rows.find((j) => j.id === 'patterns')!.nextText, /^Nightly/, 'when a job runs is the registry’s, still known');
  // The running list is read in process even when the journal is not.
  const base = memoryWorkFixture('unknown', NOW);
  const running = memoryWorkViewModel({
    ...base,
    running: [{ job: 'learn', startedAt: iso(NOW - 20_000) }],
    jobs: base.jobs.map((j) => (j.id === 'learn' ? { ...j, state: 'running' as const } : j)),
  }, NOW);
  const learn = running.jobs.learning.find((j) => j.id === 'learn')!;
  assert.equal(learn.dot, 'running');
  assert.equal(learn.stateLabel, 'Working now');
  assert.equal(learn.lastText, UNKNOWN);
  assert.equal(running.live, false, 'the panel line is still unknown and does not move');
});

test('a combined stage is unknown only when every part is unknown', () => {
  const base = memoryWorkFixture('resting', NOW).today;
  const partial = memoryWorkViewModel(snapshot({ today: { ...base, learned: 4, updated: null as unknown as number } }), NOW);
  assert.equal(partial.pipeline.find((s) => s.id === 'kept')?.value, 4);
  const none = memoryWorkViewModel(snapshot({ today: { ...base, learned: null as unknown as number, updated: null as unknown as number } }), NOW);
  assert.equal(none.pipeline.find((s) => s.id === 'kept')?.value, null, 'unknown + unknown is not 0');
  assert.equal(none.pipeline.find((s) => s.id === 'kept')?.text, UNKNOWN);
  const zero = memoryWorkViewModel(snapshot({ today: { ...base, learned: 0, updated: 0 } }), NOW);
  assert.equal(zero.pipeline.find((s) => s.id === 'kept')?.text, '0', 'a real zero is still a zero');
});

test('cost shows only when the daemon priced every call', () => {
  const base = memoryWorkFixture('resting', NOW).today;
  assert.equal(memoryWorkViewModel(snapshot({ today: { ...base, costUsd: null } }), NOW).totals.some((t) => t.label === 'Cost'), false);
  assert.equal(memoryWorkViewModel(snapshot({ today: { ...base, costUsd: 0.004 } }), NOW).totals.find((t) => t.label === 'Cost')?.value, '<$0.01');
  assert.equal(memoryWorkViewModel(snapshot({ today: { ...base, costUsd: 1.5 } }), NOW).totals.find((t) => t.label === 'Cost')?.value, '$1.50');
  assert.equal(memoryWorkViewModel(snapshot({ today: { ...base, inputTokens: 212_000 } }), NOW).totals.find((t) => t.label === 'Tokens in')?.value, '212k');
});

// ─── the model ───────────────────────────────────────────────────────────────

test('the model chip names what the next job asks for, whether it was chosen, and whose model automatic borrows', () => {
  const view = memoryWorkViewModel(snapshot(), NOW);
  assert.equal(view.model.name, 'Memory Model Large');
  assert.equal(view.model.sourceLabel, 'Automatic');
  assert.equal(view.model.automaticText, MEMORY_ROLE_WORDS.automaticChecker);
  assert.equal(view.model.served, null, 'the same model answering is not news');
  const chosen = memoryWorkViewModel(snapshot({ model: { source: 'chosen', modelId: 'memory-model-mini' } }), NOW);
  assert.equal(chosen.model.sourceLabel, 'Chosen');
  assert.equal(chosen.model.automaticText, null);
  const none = memoryWorkViewModel(snapshot({ model: { source: 'automatic', modelId: null, follows: null } }), NOW);
  assert.equal(none.model.name, null);
  assert.equal(none.model.unknown, false, 'a known absence is "no model available", not "—"');
  assert.equal(none.model.automaticText, MEMORY_ROLE_WORDS.automaticNone);
});

test('a stand-in is marked from the daemon’s evidence, and a different served model is named', () => {
  const standIn = memoryWorkViewModel(snapshot({
    model: { source: 'chosen', modelId: 'memory-model-large', lastServed: { modelId: 'memory-model-backup', at: iso(NOW - 10 * MIN), standIn: true } },
  }), NOW);
  assert.deepEqual(standIn.model.served, { name: 'Memory Model Backup', standIn: true, age: '10 min ago' });
  const differs = memoryWorkViewModel(snapshot({
    model: { source: 'automatic', modelId: 'memory-model-large', follows: 'brain', lastServed: { modelId: 'memory-model-mini', at: iso(NOW - MIN), standIn: false } },
  }), NOW);
  assert.equal(differs.model.served?.standIn, false);
  assert.equal(differs.model.served?.name, 'Memory Model Mini');
  const dated = memoryWorkViewModel(snapshot({
    model: { source: 'automatic', modelId: 'memory-model-large', lastServed: { modelId: 'memory-model-large-20260901', at: iso(NOW - MIN), standIn: false } },
  }), NOW);
  assert.equal(dated.model.served, null, 'a dated release of the same model is the same name');
  const row = memoryWorkViewModel(snapshot({ recent: [event({ id: 'e', model: { modelId: 'memory-model-backup', standIn: true } })] }), NOW);
  assert.equal(row.timeline[0]?.rows[0]?.standIn, true);
});

// ─── jobs ────────────────────────────────────────────────────────────────────

test('jobs come in the shared order, learning before upkeep, and importing hides until it has run', () => {
  const view = memoryWorkViewModel(snapshot(), NOW);
  assert.deepEqual(view.jobs.learning.map((j) => j.id), ['learn', 'reconcile', 'patterns', 'skills', 'identity']);
  assert.deepEqual(view.jobs.upkeep.map((j) => j.id), ['standing', 'verify', 'index', 'tidy']);
  const jobs = memoryWorkFixture('resting', NOW).jobs.map((j) => (j.id === 'import' ? { ...j, lastRun: { at: iso(NOW - HOUR), outcome: 'ok' as const } } : j));
  assert.ok(memoryWorkViewModel(snapshot({ jobs }), NOW).jobs.learning.some((j) => j.id === 'import'));
});

test('a job row says its model, whose model that is, when it last ran, and when it runs next', () => {
  const view = memoryWorkViewModel(snapshot(), NOW);
  const learn = view.jobs.learning.find((j) => j.id === 'learn')!;
  assert.equal(learn.modelName, 'Memory Model Large');
  assert.equal(learn.modelOwnerText, MEMORY_ROLE_WORDS.title);
  assert.equal(learn.lastWhen, '4 min ago');
  assert.equal(learn.lastDetail, 'done · 8s');
  assert.equal(learn.lastText, 'Last ran 4 min ago · done · 8s');
  assert.equal(learn.nextText, 'After each conversation, when Clem is idle');
  assert.equal(learn.todayText, '3 runs · 15k tokens');
  const tidy = view.jobs.upkeep.find((j) => j.id === 'tidy')!;
  assert.equal(tidy.modelName, null);
  assert.match(tidy.nextText, /^Nightly · next /);
  const skills = view.jobs.learning.find((j) => j.id === 'skills')!;
  assert.equal(skills.lastWhen, null);
  assert.equal(skills.lastText, 'No run recorded yet', 'the journal keeps 90 days and began at install: no record is not "never ran"');
  assert.equal(skills.dot, 'unrecorded');
  assert.equal(skills.todayText, null);
  assert.equal(skills.unknown, false);
  const failed = memoryWorkViewModel(snapshot({ jobs: [{ ...memoryWorkFixture('resting', NOW).jobs[0]!, lastRun: { at: iso(NOW - HOUR), outcome: 'failed' } }] }), NOW);
  assert.equal(failed.jobs.learning[0]?.dot, 'failed');
  assert.equal(failed.jobs.learning[0]?.lastFailed, true);
});

test('a null model means "none available" for a memory or checker job; the local index with none says "—"', () => {
  const jobs = memoryWorkFixture('resting', NOW).jobs.map((j) => ({ ...j, modelId: null, lastRun: null }));
  const view = memoryWorkViewModel(snapshot({ jobs }), NOW);
  const all = [...view.jobs.learning, ...view.jobs.upkeep];
  const by = (id: string) => all.find((j) => j.id === id)!;
  assert.equal(by('learn').modelText, 'None available', 'a memory job’s route resolved to nothing');
  assert.equal(by('learn').modelHint, null);
  for (const id of ['standing', 'verify']) {
    assert.equal(by(id).modelText, 'None available', `${id}: the daemon names the checker it asks now, or none`);
    assert.equal(by(id).modelHint, null);
    assert.equal(by(id).modelOwnerText, 'Checks the work');
    assert.equal(by(id).modelName, null);
  }
  assert.equal(by('index').modelText, UNKNOWN);
  assert.equal(by('index').modelHint, 'not reported');
  assert.equal(by('tidy').modelText, 'No model');
  const named = memoryWorkViewModel(snapshot(), NOW);
  assert.equal([...named.jobs.upkeep].find((j) => j.id === 'standing')?.modelText, 'Checker Model Fast');
});

// ─── the timeline ────────────────────────────────────────────────────────────

test('what Clem did is grouped by local day, newest first', () => {
  const view = memoryWorkViewModel(snapshot({
    recent: [
      event({ id: 'a', at: iso(NOW - 10 * MIN) }),
      event({ id: 'b', at: iso(NOW - 2 * HOUR) }),
      event({ id: 'c', at: iso(new Date(2026, 8, 25, 22, 0).getTime()) }),
      event({ id: 'd', at: iso(new Date(2026, 8, 22, 9, 0).getTime()) }),
    ],
  }), NOW);
  assert.deepEqual(view.timeline.map((d) => d.label.startsWith('Today') || d.label.startsWith('Yesterday') ? d.label : 'older'), ['Today', 'Yesterday', 'older']);
  assert.deepEqual(view.timeline.map((d) => d.rows.map((r) => r.id)), [['a', 'b'], ['c'], ['d']]);
  assert.equal(view.eventCount, 4);
});

test('a row says the run in the shared sentence, with the model, tokens and time it took', () => {
  const view = memoryWorkViewModel(snapshot(), NOW);
  const first = view.timeline[0]!.rows[0]!;
  assert.equal(first.sentence, 'Learned 3 memories, confirmed 1 from “Prospect research for the west region”');
  assert.equal(first.modelName, 'Memory Model Large');
  assert.equal(first.tokens, '11k tokens');
  assert.equal(first.duration, '8s');
  assert.match(first.usage ?? '', /2 model calls · 9\.8k in · 1\.2k out · 6\.1k reused from cache · 8s/);
  assert.equal(first.source, 'From “Prospect research for the west region”');
  assert.match(first.expires ?? '', /^Ages out of this history /);
  assert.deepEqual(first.facts.map((f) => f.changeLabel), ['New', 'New', 'New', 'Confirmed']);
  assert.equal(first.factsMore, 0);
  const failed = view.timeline.flatMap((d) => d.rows).find((r) => r.failed)!;
  assert.equal(failed.sentence, 'Learning from conversations did not finish: the model did not answer in time');
  assert.equal(failed.tokens, null, 'no model call, no token claim');
});

test('undo shows only while it would still change something', () => {
  const view = memoryWorkViewModel(snapshot({
    recent: [
      event({ id: 'learned', undo: { kind: 'forget', count: 3 } }),
      event({ id: 'one', undo: { kind: 'forget', count: 1 } }),
      event({ id: 'faded', job: 'tidy', produced: { faded: 2 }, undo: { kind: 'restore', count: 2 } }),
      event({ id: 'spent', undo: { kind: 'forget', count: 0 } }),
      event({ id: 'none', undo: null }),
    ],
  }), NOW);
  const rows = Object.fromEntries(view.timeline.flatMap((d) => d.rows).map((r) => [r.id, r.undo]));
  assert.deepEqual(rows.learned, { label: 'Forget these 3', kind: 'forget' });
  assert.deepEqual(rows.one, { label: 'Forget this', kind: 'forget' });
  assert.deepEqual(rows.faded, { label: 'Bring back 2', kind: 'restore' });
  assert.equal(rows.spent, null);
  assert.equal(rows.none, null);
});

test('memories beyond the listed ones are counted, and an inactive memory is marked off', () => {
  const view = memoryWorkViewModel(snapshot({
    recent: [event({
      id: 'x',
      produced: { learned: 10 },
      facts: [{ id: '1', text: 'A', change: 'learned', active: false }],
    })],
  }), NOW);
  const row = view.timeline[0]!.rows[0]!;
  assert.equal(row.factsMore, 9);
  assert.equal(row.facts[0]?.active, false);
});

test('the undo result is said calmly, and a refusal changes nothing', () => {
  assert.equal(memoryUndoResultText({ ok: true, changed: 3 }, 'forget'), 'Forgot 3 memories.');
  assert.equal(memoryUndoResultText({ ok: true, changed: 1 }, 'restore'), 'Brought back 1 memory.');
  assert.equal(memoryUndoResultText({ ok: true, changed: 0 }, 'forget'), 'Nothing left to undo.');
  assert.equal(memoryUndoResultText({ ok: false, reason: 'not_found' }, 'forget'), 'That run is no longer in the history.');
  assert.equal(memoryUndoResultText({ ok: false, reason: 'expired' }, 'forget'), 'That run is too old to undo now.');
  assert.equal(memoryUndoResultText({ ok: false, reason: 'failed' }, 'forget'), 'Couldn’t undo just now. Nothing was changed.');
});

test('a failed undo can be tried again; a done or refused one cannot', () => {
  assert.deepEqual(memoryUndoNotice(null, 'forget'), { ok: false, text: 'Couldn’t undo just now. Nothing was changed.', retry: true }, 'no answer at all');
  assert.equal(memoryUndoNotice({ ok: false, reason: 'failed' }, 'restore').retry, true);
  assert.equal(memoryUndoNotice({ ok: false, reason: 'expired' }, 'forget').retry, false);
  assert.equal(memoryUndoNotice({ ok: false, reason: 'not_found' }, 'forget').retry, false);
  assert.equal(memoryUndoNotice({ ok: false, reason: 'nothing_to_undo' }, 'forget').retry, false);
  assert.deepEqual(memoryUndoNotice({ ok: true, changed: 3 }, 'forget'), { ok: true, text: 'Forgot 3 memories.', retry: false });
  assert.equal(memoryUndoNotice({ ok: true, changed: 0 }, 'forget').ok, false, 'nothing changed is not drawn as done');
  const timeline = read('../components/memory/work/WorkTimeline.tsx');
  assert.match(timeline, /row\.undo && \(!result \|\| result\.retry\)/, 'the button comes back after a retryable failure');
});

test('a job this build does not know keeps its row and a plain glyph, and cannot take the screen down', () => {
  const future = 'a-job-from-a-newer-daemon' as unknown as MemoryWorkEvent['job'];
  const view = memoryWorkViewModel(snapshot({
    recent: [event({ id: 'new', job: future, produced: { learned: 2 } })],
    jobs: [...memoryWorkFixture('resting', NOW).jobs, { ...memoryWorkFixture('resting', NOW).jobs[0]!, id: future }],
  }), NOW);
  const row = view.timeline[0]?.rows[0];
  assert.equal(row?.id, 'new');
  assert.equal(row?.sentence, 'Memory work: nothing new', 'the shared words fall back for an unknown job');
  assert.equal([...view.jobs.learning, ...view.jobs.upkeep].some((j) => j.id === future), false, 'the roster lists the jobs it knows');
  assert.ok(jobIcon(future), 'an unknown id still gets a drawable glyph');
  assert.equal(typeof jobIcon(future), typeof JOB_ICON.learn);
  assert.equal(jobIcon('learn'), JOB_ICON.learn);
  assert.equal(jobIcon('toString'), jobIcon(future), 'an inherited property name is not a glyph');
  for (const file of ['WorkTimeline.tsx', 'JobRoster.tsx']) {
    assert.doesNotMatch(read(`../components/memory/work/${file}`), /JOB_ICON\[/, `${file} looks glyphs up through jobIcon()`);
  }
});

test('the quiet queue line appears only for counts above zero, and retention is said in days', () => {
  const view = memoryWorkViewModel(snapshot({ queue: { toLearn: 0, setAside: 14, failed: 0 } }), NOW);
  assert.equal(view.queueLine, '14 claims set aside for a second look');
  assert.equal(memoryWorkViewModel(snapshot({ queue: { toLearn: 0, setAside: 0, failed: 0 } }), NOW).queueLine, null);
  assert.equal(view.retentionText, 'Clem keeps this detail for 7 days and daily totals for 90 days, then deletes them.');
});

// ─── activity ────────────────────────────────────────────────────────────────

test('the 24-hour strip marks the current hour, scales to the busiest, and says each hour in words', () => {
  const start = new Date(NOW); start.setMinutes(0, 0, 0);
  const hourly = Array.from({ length: 24 }, (_, i) => ({
    hourStart: iso(start.getTime() - (23 - i) * HOUR),
    runs: i === 23 ? 1 : 0,
    modelCalls: i === 23 ? 4 : i === 10 ? 8 : 0,
    learned: i === 10 ? 2 : 0,
  }));
  const view = memoryWorkViewModel(snapshot({ hourly }), NOW);
  assert.equal(view.hourlyUnit, 'model calls');
  assert.equal(view.hourly[23]?.current, true);
  assert.equal(view.hourly.filter((b) => b.current).length, 1);
  assert.equal(view.hourly[10]?.height, 100);
  assert.equal(view.hourly[23]?.height, 50);
  assert.equal(view.hourly[0]?.height, 0);
  assert.match(view.hourly[23]?.readout ?? '', /^This hour · 4 model calls · 1 run$/);
  assert.match(view.hourly[0]?.readout ?? '', /no memory work$/);
  assert.equal(view.hourlySummary, '12 model calls · 2 learned in the last 24 hours. Point at a bar for its hour.');
});

test('with no model calls the bars count runs, and a quiet day says so', () => {
  const start = new Date(NOW); start.setMinutes(0, 0, 0);
  const runsOnly = Array.from({ length: 24 }, (_, i) => ({ hourStart: iso(start.getTime() - (23 - i) * HOUR), runs: i === 5 ? 3 : 0, modelCalls: 0, learned: 0 }));
  const view = memoryWorkViewModel(snapshot({ hourly: runsOnly }), NOW);
  assert.equal(view.hourlyUnit, 'runs');
  assert.equal(view.hourly[5]?.height, 100);
  const quiet = memoryWorkViewModel(snapshot({ hourly: runsOnly.map((h) => ({ ...h, runs: 0 })) }), NOW);
  assert.equal(quiet.hourlyEmpty, true);
  assert.equal(quiet.hourlySummary, 'No memory work in the last 24 hours.');
});

test('the 30-day strip leaves days before the record began blank, not zero', () => {
  const view = memoryWorkViewModel(snapshot(), NOW);
  assert.equal(view.daily.length, 24);
  assert.equal(view.dailyMissing, 6);
  assert.equal(view.daily[view.daily.length - 1]?.label, 'Today');
  assert.equal(view.daily[view.daily.length - 1]?.current, true);
  assert.deepEqual(view.daily.map((b) => b.slot), Array.from({ length: 24 }, (_, i) => i + 6), 'each day in its own slot');
});

test('a new journal\'s one hour and one day sit at the right of their strips, and say since when', () => {
  // Install day: the journal began at 3:12 PM; the daemon sends only the hour
  // and the day it has measured.
  const began = new Date(2026, 8, 26, 15, 12, 0).getTime();
  const start = new Date(NOW); start.setMinutes(0, 0, 0);
  const view = memoryWorkViewModel(snapshot({
    measuredSince: iso(began),
    hourly: [{ hourStart: iso(start.getTime()), runs: 0, modelCalls: 0, learned: 0 }],
    daily: [{ day: '2026-09-26', runs: 0, modelCalls: 0, learned: 0, inputTokens: 0, outputTokens: 0 }],
  }), NOW);
  assert.deepEqual(view.hourly.map((b) => b.slot), [23], 'one bar in the current hour\'s slot, not across the day');
  assert.equal(view.hourlySlots, 24);
  assert.deepEqual(view.daily.map((b) => b.slot), [29]);
  assert.equal(view.dailySlots, 30);
  const time = new Date(began).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  assert.equal(view.hourlySummary, `No memory work since ${time}.`, 'the span measured, not "the last 24 hours"');
  assert.equal(view.todayCaption, `Counts since ${time}`, 'today\'s zeros count from when the journal began');
  // An hour in the middle of the strip with no record stays blank too.
  const gappy = memoryWorkViewModel(snapshot({
    measuredSince: null,
    hourly: [{ hourStart: iso(start.getTime() - 5 * HOUR), runs: 1, modelCalls: 2, learned: 0 }, { hourStart: iso(start.getTime()), runs: 0, modelCalls: 0, learned: 0 }],
  }), NOW);
  assert.deepEqual(gappy.hourly.map((b) => b.slot), [18, 23]);
  assert.equal(memoryWorkViewModel(snapshot({ measuredSince: null }), NOW).todayCaption, 'Counts since midnight');
});

// ─── time words ──────────────────────────────────────────────────────────────

test('ages and clocks read the way the shared words expect', () => {
  const fmt = memoryTimeFormat(NOW);
  assert.equal(fmt.age(iso(NOW - 20_000)), 'just now');
  assert.equal(fmt.age(iso(NOW - 5 * MIN)), '5 min ago');
  assert.equal(fmt.age(iso(NOW - 3 * HOUR)), '3 h ago');
  assert.equal(fmt.age(iso(new Date(2026, 8, 25, 9, 0).getTime())), 'yesterday');
  assert.equal(fmt.age(iso(new Date(2026, 8, 22, 9, 0).getTime())), '4 days ago');
  assert.equal(fmt.age('not a date'), '');
  const today = fmt.clock(iso(new Date(2026, 8, 26, 17, 0).getTime()));
  const tomorrow = fmt.clock(iso(new Date(2026, 8, 27, 3, 0).getTime()));
  assert.ok(!/\s\S+\s/.test(today) || /AM|PM/.test(today), 'today is a bare time');
  assert.ok(tomorrow.length > today.length, 'another day carries its weekday');
  assert.equal(durationWords(400), 'under a second');
  assert.equal(durationWords(8_400), '8s');
  assert.equal(durationWords(64_000), '1m 4s');
  assert.equal(durationWords(undefined), '');
  assert.equal(elapsedClock(NOW - 72_000, NOW), '1:12');
});

// ─── the fixture keeps the contract's shape ──────────────────────────────────

test('the preview fixture carries every key of the contract snapshot', () => {
  const keys: Array<keyof MemoryWorkSnapshot> = [
    'generatedAt', 'state', 'running', 'waiting', 'lastWorkAt', 'queue', 'model', 'embedder', 'jobs', 'today', 'hourly', 'daily', 'recent', 'retention',
  ];
  for (const state of ['working', 'waiting', 'resting', 'off', 'unknown'] as const) {
    const s = memoryWorkFixture(state, NOW);
    for (const key of keys) assert.ok(key in s, `${state} fixture lacks ${key}`);
    assert.equal(s.state, state);
  }
});

// ─── wiring and honesty pins ─────────────────────────────────────────────────

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('WIRED: the Memory screen renders the panel, and the panel reads the route through the view model', () => {
  const screen = read('../screens/Memory.tsx');
  assert.match(screen, /from '@\/components\/memory\/work\/MemoryWorkPanel'/);
  assert.match(screen, /<MemoryWorkPanel \/>/);
  const panel = read('../components/memory/work/MemoryWorkPanel.tsx');
  assert.match(panel, /useMemoryWork\(\)/);
  assert.match(panel, /memoryWorkViewModel\(/);
  const lib = read('./memory-work.ts');
  assert.match(lib, /'\/api\/console\/memory\/work'/);
  assert.match(lib, /\/api\/console\/memory\/work\/\$\{encodeURIComponent\(eventId\)\}\/undo/);
  assert.doesNotMatch(read('../components/memory/work/MemoryWorkPanel.tsx'), /memory-work\.fixture/, 'the fixture never ships');
});

test('the panel branches on a failed read before it draws anything as empty', () => {
  const panel = read('../components/memory/work/MemoryWorkPanel.tsx');
  const guard = panel.indexOf('work.isError && work.data === undefined');
  const drawn = panel.indexOf('<LearningPipeline');
  assert.ok(guard > 0, 'the failed-first-read branch is gone');
  assert.ok(drawn > guard, 'the error branch must come before the panel draws counts');
  assert.match(panel, /Couldn’t read memory work just now/);
});

test('the headline is the one live region polling can speak through; nothing alerts', () => {
  const files = ['MemoryWorkPanel.tsx', 'WorkStatus.tsx', 'LearningPipeline.tsx', 'ActivityStrip.tsx', 'JobRoster.tsx', 'WorkTimeline.tsx'];
  const src = Object.fromEntries(files.map((f) => [f, read(`../components/memory/work/${f}`)]));
  for (const f of files) assert.doesNotMatch(src[f]!, /role="alert"/, `${f}: no assertive interruptions`);
  const live = files.filter((f) => /aria-live=/.test(src[f]!));
  assert.deepEqual(live, ['WorkStatus.tsx']);
  // The one other status line answers the owner's own undo click (the app's
  // pattern for an action result); a poll never writes into it.
  const status = files.flatMap((f) => (src[f]!.match(/role="status"/g) ?? []).map(() => f));
  assert.deepEqual(status.sort(), ['WorkStatus.tsx', 'WorkTimeline.tsx']);
});

test('the pipeline is a labelled group: a list may own only its items, and the note shares the grid', () => {
  const src = read('../components/memory/work/LearningPipeline.tsx');
  assert.doesNotMatch(src, /role="list(item)?"/);
  assert.match(src, /role="group" aria-label="Today’s learning, stage by stage"/);
});

test('motion stops for reduced motion and for the owner’s still style', () => {
  const css = read('../styles.css');
  assert.match(css, /\.memory-work\.is-still \.memory-pulse::after/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.memory-pulse::after,\s*\.memory-link\.is-flowing \.memory-line::after \{ animation: none; display: none; \}/);
  const panel = read('../components/memory/work/MemoryWorkPanel.tsx');
  assert.match(panel, /liveStatus \?\? 'animated'\) !== 'animated'/);
});

test('the panel’s Change goes to the memory row in Settings, the one owner of the choice', () => {
  assert.match(read('../components/memory/work/WorkStatus.tsx'), /to="\/settings#memory-model"/);
  assert.match(read('../screens/settings/ModelRolesCard.tsx'), /id="memory-model"/);
});

test('a daemon without the memory-work route hides the panel, as on the phone; other failures still say so', async () => {
  const failing = (status: number) => async () => { throw Object.assign(new Error(`HTTP ${status}`), { status }); };
  assert.equal(await getMemoryWork(failing(404)), null, 'an older daemon: not reported, not "couldn’t read"');
  await assert.rejects(getMemoryWork(failing(500)), /HTTP 500/);
  const snap = memoryWorkFixture('resting', NOW);
  assert.equal(await getMemoryWork(async () => snap), snap);
});
