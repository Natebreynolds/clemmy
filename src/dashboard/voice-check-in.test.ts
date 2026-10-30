import assert from 'node:assert/strict';
import test from 'node:test';
import { readVoiceCheckIn, type VoiceCheckInReaders } from './voice-check-in.js';

const NOW = Date.parse('2026-10-29T19:00:00.000Z');
const AT = '2026-10-29T18:58:00.000Z';
const empty = (): VoiceCheckInReaders => ({
  approvals: () => [], questions: () => [], plans: () => [],
  watches: async () => ({ items: [], failed: 0 }),
  workflows: () => ({ items: [], failed: 0, omitted: 0 }),
});

test('check-in retains exact decision identities without granting answer or send authority', async () => {
  const readers = empty();
  readers.approvals = () => [{ approvalId: 'approval-fixture', subject: 'Review controlled draft', requestedAt: AT }] as never;
  readers.questions = () => [{ id: 'workflow:fixture-run|fixture-question', question: 'Which controlled account should I use?',
    askedAt: AT, source: 'workflow', runId: 'fixture-run', stepId: 'fixture-step', sessionId: 'fixture-session', taskId: null }] as never;
  const result = await readVoiceCheckIn(readers, NOW);
  assert.equal(result.status, 'partial', 'excluded attention sources are explicit, not a complete Inbox count');
  assert.equal(result.generatedAt, new Date(NOW).toISOString());
  assert.equal(result.sections.attention.observedCount, 2);
  assert.deepEqual(result.sections.attention.items.map(item => item.key), ['approval:approval-fixture', 'workflow:fixture-run|fixture-question']);
  assert.deepEqual(result.sections.attention.items[1].ref, { questionId: 'workflow:fixture-run|fixture-question',
    runId: 'fixture-run', stepId: 'fixture-step', sessionId: 'fixture-session' });
  assert.ok(result.sections.attention.omittedSources.includes('notifications'));
  assert.match(result.spokenText, /1 approval.*1 question/i);
  assert.doesNotMatch(JSON.stringify(result), /ownerChoiceToken|ownerCardReplyToken|resumeCapability|approvedPayload/);
});

test('one failed source stays unknown while useful retained facts survive', async () => {
  const readers = empty();
  readers.approvals = () => { throw new Error('private fixture failure text must not escape'); };
  readers.workflows = () => ({ items: [{ runId: 'fixture-running', workflow: 'Controlled workflow', status: 'running', at: AT }], failed: 0, omitted: 0 });
  const result = await readVoiceCheckIn(readers, NOW);
  assert.equal(result.status, 'partial');
  assert.ok(result.issues.some(issue => issue.source === 'approvals' && issue.code === 'read_unavailable'));
  assert.equal(result.sections.attention.counts.approvals, null);
  assert.equal(result.sections.workflows.items[0].ref.runId, 'fixture-running');
  assert.doesNotMatch(JSON.stringify(result), /private fixture failure|nothing needs|all clear/i);
});

test('complete read failure is unavailable, never an empty-success briefing', async () => {
  const unavailable = () => { throw new Error('controlled unavailable'); };
  const readers = { approvals: unavailable, questions: unavailable, plans: unavailable, watches: unavailable, workflows: unavailable };
  const result = await readVoiceCheckIn(readers, NOW);
  assert.equal(result.status, 'unavailable');
  assert.match(result.spokenText, /could not read/i);
  assert.doesNotMatch(result.spokenText, /nothing|all clear|no work/i);
});

test('retained watch failure and never-checked state cannot become current successful checks', async () => {
  const readers = empty();
  readers.watches = async () => ({ failed: 1, items: [{ id: 'calendar', title: 'Calendar watch', enabled: true,
    state: 'failed', lastCheck: { state: 'failed', at: AT }, summary: 'A prior recorded observation' },
  { id: 'noticing', title: 'Noticing', enabled: false, state: 'off', lastCheck: { state: 'never' } }] });
  const result = await readVoiceCheckIn(readers, NOW);
  assert.equal(result.sections.watches.status, 'partial');
  assert.equal(result.sections.watches.items[0].freshness.basis, 'retained');
  assert.equal(result.sections.watches.items[0].lastCheck.state, 'failed');
  assert.equal(result.sections.watches.items[1].freshness.at, null);
  assert.match(result.spokenText, /saved watch records/i);
  assert.doesNotMatch(result.spokenText, /just checked|all watches.*healthy/i);
});

test('bounded output keeps identities whole, counts omissions, and strips spoken links', async () => {
  const readers = empty();
  readers.questions = () => Array.from({ length: 12 }, (_, n) => ({ id: `task:controlled-${n}`,
    question: `Controlled question ${n} ${'long '.repeat(150)} https://example.invalid/controlled`, askedAt: AT })) as never;
  readers.workflows = () => ({ items: [], failed: 2, omitted: 10 });
  const result = await readVoiceCheckIn(readers, NOW);
  assert.equal(result.sections.attention.observedCount, 12);
  assert.equal(result.sections.attention.items.length, 4);
  assert.equal(result.sections.attention.omittedItems, 8);
  assert.equal(result.sections.workflows.omittedItems, 10);
  assert.equal(result.sections.workflows.status, 'partial');
  assert.ok(result.spokenText.length <= 1000);
  assert.doesNotMatch(result.spokenText, /https?:\/\//);
  assert.equal(result.sections.attention.items[0].ref.questionId, 'task:controlled-0');
});

test('spoken check-in includes two time-labelled retained findings and reserves its partial-view caveat', async () => {
  const readers = empty();
  readers.questions = () => [{ id: 'task:controlled-long-question', question: 'Controlled question '.repeat(80), askedAt: AT }] as never;
  readers.watches = async () => ({ failed: 0, items: [
    { id: 'calendar', title: 'Calendar watch', enabled: true, state: 'scheduled',
      lastCheck: { state: 'recorded', at: AT }, summary: 'One controlled meeting is awaiting a reply. ' + 'Details '.repeat(100) },
    { id: 'work-review', title: 'Work review', enabled: true, state: 'failed',
      lastCheck: { state: 'failed', at: AT }, summary: 'The controlled saved review had a read failure. ' + 'Details '.repeat(100) },
    { id: 'noticing', title: 'Noticing', enabled: true, state: 'scheduled',
      lastCheck: { state: 'recorded', at: AT }, summary: 'Third controlled finding must remain on screen.' },
  ] });
  const result = await readVoiceCheckIn(readers, NOW);
  assert.match(result.spokenText, /Calendar watch, saved check recorded at 2026-10-29T18:58:00.000Z: One controlled meeting/);
  assert.match(result.spokenText, /Work review, saved check failed at 2026-10-29T18:58:00.000Z: The controlled saved review/);
  assert.doesNotMatch(result.spokenText, /Third controlled finding|just checked|all clear/);
  assert.ok(result.spokenText.length <= 1000);
  assert.match(result.spokenText, /Saved observations, not fresh checks\. Notification asks, trust and workspace choices are not included\./);
  assert.ok(result.spokenText.endsWith('Open Clem for the full Needs you list.'));
});
