import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { HeartbeatId, HeartbeatStatus } from './heartbeats.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-heartbeat-presentation-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TEST_HOME, 'state'));
const { HEARTBEAT_IDS, projectHeartbeatPresentation, readHeartbeatSnapshot, listHeartbeats } = await import('./heartbeats.js');
const now = Date.parse('2026-10-16T12:00:00.000Z');
const at = '2026-10-16T11:30:00.000Z';
const future = '2026-10-16T12:30:00.000Z';
const input = () => ({ enabled: true, quietHoursActive: false, running: false, cadenceMinutes: 60,
  lastTickAt: at, lastFinding: { at, quiet: true }, nextTickAt: future });

test.after(async () => {
  const { closeEventLog } = await import('../runtime/harness/eventlog.js');
  closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('off and quiet hours suppress a promised next check, while an actual manual check remains checking', () => {
  for (const [patch, state] of [[{ enabled: false }, 'off'], [{ quietHoursActive: true }, 'quiet_hours']] as const) {
    const shown = projectHeartbeatPresentation({ ...input(), ...patch }, now);
    assert.equal(shown.state, state);
    assert.equal(shown.nextCheckAt, undefined);
    assert.equal(shown.lastCheck.state, 'recorded');
  }
  const running = projectHeartbeatPresentation({ ...input(), enabled: false, quietHoursActive: true, running: true }, now);
  assert.equal(running.state, 'checking');
  assert.equal(running.nextCheckAt, undefined);
});

test('scheduled, due, never and unknown are distinct without claiming a successful read', () => {
  assert.deepEqual(projectHeartbeatPresentation(input(), now), {
    state: 'scheduled', nextCheckAt: future, lastCheck: { state: 'recorded', at },
  });
  assert.equal(projectHeartbeatPresentation({ ...input(), nextTickAt: undefined }, now + 31 * 60_000).state, 'due');
  assert.deepEqual(projectHeartbeatPresentation({ enabled: true, quietHoursActive: false, running: false, cadenceMinutes: 60 }, now),
    { state: 'never', lastCheck: { state: 'never' } });
  const incomplete = projectHeartbeatPresentation({ ...input(), lastFinding: undefined, nextTickAt: undefined }, now);
  assert.equal(incomplete.state, 'unknown');
  assert.equal(incomplete.lastCheck.state, 'unknown', 'a start time without a finding is not a completed check');
  const invalid = projectHeartbeatPresentation({ ...input(), lastTickAt: 'invalid', lastFinding: { at: 'invalid' }, nextTickAt: 'invalid' }, now);
  assert.deepEqual(invalid, { state: 'unknown', lastCheck: { state: 'unknown' } });
  assert.equal(projectHeartbeatPresentation({ ...input(), lastFinding: { at: future } }, now).lastCheck.state, 'unknown');
  assert.equal(projectHeartbeatPresentation({ ...input(), readFailures: -1 }, now).lastCheck.state, 'unknown');
  assert.ok(!JSON.stringify(projectHeartbeatPresentation(input(), now)).includes('success'));
});

test('partial and wholly failed reads retain coverage, and unproved coverage stays unknown', () => {
  const failed = projectHeartbeatPresentation({ ...input(), readFailures: 2, successfulReads: 0 }, now);
  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.lastCheck, { state: 'failed', at, readFailures: 2, successfulReads: 0 });
  const partial = projectHeartbeatPresentation({ ...input(), readFailures: 1, successfulReads: 2, lastError: { at } }, now);
  assert.equal(partial.state, 'partial');
  assert.deepEqual(partial.lastCheck, { state: 'partial', at, readFailures: 1, successfulReads: 2 });
  const unknown = projectHeartbeatPresentation({ ...input(), readFailures: 1 }, now);
  assert.equal(unknown.lastCheck.state, 'unknown');
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.nextCheckAt, future, 'the known schedule does not erase uncertain read coverage');
  assert.deepEqual(projectHeartbeatPresentation({ ...input(), readFailures: 0, successfulReads: 0 }, now).lastCheck,
    { state: 'recorded', at, readFailures: 0, successfulReads: 0 }, 'no connected source is not proof of a successful read');
});

test('an earlier failure cannot contaminate a rapid later finding and later error cannot borrow old coverage', () => {
  const later = '2026-10-16T11:30:40.000Z';
  assert.equal(projectHeartbeatPresentation({ ...input(), lastError: { at }, lastTickAt: later, lastFinding: { at: later } }, now).lastCheck.state, 'recorded');
  const failed = projectHeartbeatPresentation({ ...input(), lastError: { at: later }, readFailures: 0, successfulReads: 3 }, now);
  assert.deepEqual(failed.lastCheck, { state: 'failed', at: later });
  assert.equal(failed.state, 'failed');
  const unfinished = projectHeartbeatPresentation({ ...input(), lastTickAt: later }, now);
  assert.equal(unfinished.lastCheck.state, 'unknown');
});

function status(id: HeartbeatId): HeartbeatStatus {
  return { id, title: id, purpose: 'Controlled projection.', enabled: true, cadenceMinutes: 60, cadenceRange: { min: 15, max: 1440 },
    quietHoursActive: false, running: false, metrics: { ticks: 0, quietTicks: 0, itemsProduced: 0, itemsAcknowledged: 0, itemsRetired: 0, modelCalls: 0, modelVetoes: 0 },
    openItems: [], recentlyRetired: [], rulesApply: false,
    contract: { id, notify: 'quiet', rules: [], updatedAt: new Date(0).toISOString() },
    phonePush: { ready: false, reason: 'no_phone_registered', phones: { webPush: 0, apns: 0 } },
    presentation: { state: 'never', lastCheck: { state: 'never' } } };
}

test('a partial status failure keeps every registry identity visible without fabricating Off or zero items', async () => {
  const read: HeartbeatId[] = [];
  const result = await readHeartbeatSnapshot(async id => {
    read.push(id);
    if (id === 'calendar') throw new Error('private diagnostic must not be projected');
    return status(id);
  }, new Date(now));
  assert.deepEqual(read, [...HEARTBEAT_IDS]);
  assert.deepEqual(result.heartbeats.map(row => row.id), ['work-review', 'workflow-suggestions', 'noticing']);
  assert.deepEqual(result.unavailable, [{ id: 'calendar', title: 'Calendar watch', reason: 'status_unavailable' }]);
  assert.equal(result.generatedAt, new Date(now).toISOString());
  assert.ok(!JSON.stringify(result).includes('private diagnostic'));
  assert.ok(!('enabled' in result.unavailable[0]!));
  const allFailed = await readHeartbeatSnapshot(async () => { throw new Error('unavailable'); }, new Date(now));
  assert.equal(allFailed.heartbeats.length, 0);
  assert.deepEqual(allFailed.unavailable.map(row => row.id), [...HEARTBEAT_IDS]);
  const wrongIdentity = await readHeartbeatSnapshot(async () => status('calendar'), new Date(now));
  assert.deepEqual(wrongIdentity.heartbeats.map(row => row.id), ['calendar']);
  assert.equal(wrongIdentity.unavailable.length, 3);
});

test('actual never-ticked work and calendar status do not promise next-now during quiet hours', async () => {
  const policy = await import('./proactivity-policy.js');
  const saved = policy.loadProactivityPolicy();
  try {
    policy.saveProactivityPolicy({ quietHoursEnabled: true, quietHoursStart: '00:00', quietHoursEnd: '00:00', workReviewEnabled: true, calendarWatchEnabled: true });
    const { workReviewStatus } = await import('./work-review-runtime.js');
    const { calendarWatchStatus } = await import('./calendar-watch-runtime.js');
    for (const observed of [workReviewStatus(), calendarWatchStatus()]) {
      assert.equal(observed.quietHoursActive, true);
      assert.equal(observed.lastTickAt, undefined);
      assert.equal(observed.nextTickAt, undefined);
    }
    const available = await listHeartbeats();
    assert.ok(Array.isArray(available), 'the established list API keeps its array shape');
    assert.deepEqual(available.map(row => row.id), [...HEARTBEAT_IDS]);
    assert.equal(available.find(row => row.id === 'calendar')?.presentation.state, 'quiet_hours');
  } finally { policy.saveProactivityPolicy(saved); }
});

test('two public manual suggestion checks report the actual proposal count and release single-flight after each tick', async () => {
  const eventlog = await import('../runtime/harness/eventlog.js');
  const { evaluateLearningCandidate } = await import('../memory/learning-receipt.js');
  const { recordRunStrategy } = await import('../memory/run-strategy-store.js');
  const { tickHeartbeat } = await import('./heartbeats.js');
  const { workflowSuggestionsStatus } = await import('./workflow-suggestions.js');
  // Controlled retained evidence for the suggestion reader, never a claim
  // that this test executed a provider or granted permission to run the plan.
  const receipt = evaluateLearningCandidate({ target: 'strategy', authority: 'background_delivery_verifier',
    sessionId: 'background:controlled-heartbeat-count', sourceId: 'controlled-heartbeat-count', terminalSuccess: true,
    controllerValidation: true }).receipt;
  assert.ok(receipt);
  const strategy = recordRunStrategy({ objective: 'Prepare the controlled report draft', toolsUsed: ['write_file'],
    workerCount: 0, durationMs: 1, learningReceipt: receipt, scope: 'chat' });
  assert.ok(strategy);
  for (let index = 0; index < 3; index++) {
    const session = eventlog.createSession({ id: `controlled-suggestion-source-${index}`, kind: 'chat' });
    const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Prepare the controlled report draft.' } });
    const selected = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'proven_operation_selected',
      data: { strategyId: strategy.id, sourceUserSeq: source.seq } });
    if (index === 0) eventlog.openEventLog().prepare('UPDATE events SET created_at=? WHERE id=?')
      .run(new Date(Date.now() - 86_400_000).toISOString(), selected.id);
  }
  const first = await tickHeartbeat('workflow-suggestions');
  assert.equal(first.produced, 1);
  assert.equal(first.quiet, false);
  assert.equal(first.status.openItems.length, 1);
  assert.equal(first.status.running, false);
  assert.equal(workflowSuggestionsStatus().metrics.ticks, 1);
  const second = await tickHeartbeat('workflow-suggestions');
  assert.equal(second.produced, 0, 'an unanswered suggestion does not create a second plan');
  assert.equal(second.status.openItems.length, 1);
  assert.equal(second.status.running, false, 'the completed first promise cannot remain installed');
  assert.equal(workflowSuggestionsStatus().metrics.ticks, 2, 'the next check performs a fresh observation');
});

test('a failed synchronous suggestion check releases single-flight so the next check can recover', async () => {
  const { runWorkflowSuggestionsTick, productionWorkflowSuggestionsDeps, emptyWorkflowSuggestionsState, workflowSuggestionsStatus } = await import('./workflow-suggestions.js');
  let state = emptyWorkflowSuggestionsState();
  let reads = 0;
  const deps = { ...productionWorkflowSuggestionsDeps(),
    policy: () => ({ enabled: true, cadenceMinutes: 60, quietHoursActive: false }),
    loadState: () => structuredClone(state), saveState: (next: typeof state) => { state = structuredClone(next); },
    observations: () => { reads++; if (reads === 1) throw new Error('controlled unavailable observation'); return []; },
    strategies: () => [], existingWorkflows: () => [],
    surface: () => { throw new Error('no proposal may be surfaced without an observation'); },
  };
  const failed = await runWorkflowSuggestionsTick({ source: 'manual', force: true }, deps);
  assert.match(failed.summary, /Tick failed/);
  assert.equal(failed.proposed, 0);
  assert.equal(workflowSuggestionsStatus().running, false);
  const recovered = await runWorkflowSuggestionsTick({ source: 'manual', force: true }, deps);
  assert.equal(reads, 2);
  assert.doesNotMatch(recovered.summary, /Tick failed/);
  assert.equal(state.metrics.ticks, 1);
  assert.equal(workflowSuggestionsStatus().running, false);
});

test('an answered Noticing handoff stays open as progress without being presented as retired or exposing its private digest', async () => {
  const { heartbeatStatus } = await import('./heartbeats.js');
  const { emptyNoticingState } = await import('./noticing.js');
  const { loadNoticingState, saveNoticingState } = await import('./noticing-runtime.js');
  const before = loadNoticingState();
  const state = emptyNoticingState();
  const createdAt = new Date(Date.now() - 1_000).toISOString();
  for (const handoffState of ['not_started', 'needs_attention', 'dispatched'] as const) {
    state.proposals[handoffState] = { id: handoffState, shapeKey: handoffState, title: 'Controlled accepted proposal',
      why: 'Controlled retained handoff.', action: 'Prepare a controlled draft.', evidence: [], goalId: null, confidence: 1,
      createdAt, status: 'answered', answer: { text: 'Prepare the draft.', decision: 'do_it', at: createdAt },
      handoff: { version: 1, answerDigest: 'private-answer-digest', state: handoffState, updatedAt: createdAt,
        sessionId: 'controlled-handoff-chat', reason: 'Controlled progress.' } };
  }
  try {
    saveNoticingState(state);
    const status = await heartbeatStatus('noticing');
    assert.deepEqual(new Set(status.openItems.map(row => row.key)), new Set(['not_started', 'needs_attention', 'dispatched']));
    for (const row of status.openItems) {
      assert.equal(row.retiredAt, undefined);
      assert.equal(row.handoff?.sessionId, 'controlled-handoff-chat');
      assert.equal(row.handoff?.reason, 'Controlled progress.');
      assert.equal(row.handoff?.state, row.key);
    }
    assert.ok(!JSON.stringify(status.openItems).includes('private-answer-digest'));
  } finally { saveNoticingState(before); }
});
