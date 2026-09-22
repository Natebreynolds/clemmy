/**
 * Run: node scripts/run-tests-isolated.mjs src/agents/workflow-suggestions.test.ts
 *
 * The workflow-suggestions watch: a deterministic look at the host's own
 * proven-strategy record (never user text) that offers, at most once at a
 * time, to save a repeated request as a workflow. Live 2026-09-22: "whats on
 * my calendar tomorrow" had run 11 times on 2 days with no saved workflow.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-wf-suggest-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const {
  deriveSuggestionCandidates, processWorkflowSuggestionsTick, emptyWorkflowSuggestionsState,
  suggestedWorkflowName, buildSuggestionPlan, isWorkTool, workflowSuggestionsStatus, workflowCovers,
  SUGGESTION_MIN_TURNS, SUGGESTION_PENDING_EXPIRY_DAYS, SUGGESTION_DECLINE_COOLDOWN_DAYS,
} = await import('./workflow-suggestions.js');
import type { RepeatObservation, WorkflowSuggestionsDeps, WorkflowSuggestionsState, SuggestionCandidate } from './workflow-suggestions.js';

const NOW = new Date('2026-09-22T16:00:00.000Z');
const DAY = 86_400_000;
const work = (tool: string) => tool === 'outlook_get_calendar_view' || tool === 'write_file' || tool === 'salesforce_sf_soql_query';

function obs(strategyId: string, daysAgo: number, session = `sess-${strategyId}-${daysAgo}`, seq = 100 + daysAgo): RepeatObservation {
  return { strategyId, sessionId: session, sourceUserSeq: seq, at: new Date(NOW.getTime() - daysAgo * DAY + 3_600_000).toISOString() };
}
const strategies = [
  { id: 'strat-cal', objective: 'whats on my calendar tomorrow', toolsUsed: ['outlook_get_calendar_view'] },
  { id: 'strat-meta', objective: 'Graph driver tag canary', toolsUsed: ['work_call', 'tool_search', 'plan_task'] },
  { id: 'strat-sf', objective: 'find tim in salesforce', toolsUsed: ['salesforce_sf_soql_query', 'outlook_get_calendar_view'] },
  { id: 'strat-old', objective: 'old routine', toolsUsed: ['write_file'] },
  { id: 'strat-oneday', objective: 'same day three times', toolsUsed: ['write_file'] },
];

test('a request repeated on several days with a real work tool is a candidate; meta-only, one-day, stale and covered ones are not', () => {
  const observations = [
    obs('strat-cal', 0), obs('strat-cal', 0, 'sess-cal-b', 200), obs('strat-cal', 1), obs('strat-cal', 1, 'sess-cal-c', 300),
    obs('strat-meta', 0), obs('strat-meta', 1), obs('strat-meta', 2),
    obs('strat-sf', 0), obs('strat-sf', 3), obs('strat-sf', 5),
    obs('strat-old', 20), obs('strat-old', 21), obs('strat-old', 22),
    obs('strat-oneday', 0), obs('strat-oneday', 0, 's2', 5), obs('strat-oneday', 0, 's3', 6),
  ];
  const { candidates, covered } = deriveSuggestionCandidates({
    strategies, observations, now: NOW, isWorkTool: work,
    existingWorkflows: [
      // Covers the salesforce routine: same tools, same subject.
      { name: 'Tim in Salesforce check', tools: new Set(['SALESFORCE_SF_SOQL_QUERY', 'OUTLOOK_GET_CALENDAR_VIEW']), keywords: ['tim', 'salesforce', 'check'] },
      // Shares the calendar read but is about something else: NOT coverage.
      { name: 'Morning briefing', tools: new Set(['OUTLOOK_GET_CALENDAR_VIEW', 'GMAIL_FETCH_EMAILS']), keywords: ['morning', 'briefing', 'inbox', 'summary'] },
    ],
  });
  assert.deepEqual(candidates.map((c) => c.strategyId), ['strat-cal'], 'only the calendar routine qualifies');
  assert.equal(covered, 1, 'the salesforce routine is already covered by a saved workflow');
  const cal = candidates[0];
  assert.equal(cal.turns, 4);
  assert.equal(cal.distinctDays, 2);
  assert.equal(cal.sessions, 4);
  assert.equal(cal.latestSessionId, 'sess-cal-b', 'the newest chat that did the work is the promotion source');
  assert.equal(cal.latestSourceUserSeq, 200);
  assert.deepEqual(cal.workTools, ['outlook_get_calendar_view']);
  assert.ok(SUGGESTION_MIN_TURNS >= 3);
});

test('coverage needs every work tool AND the same subject; one shared tool is not coverage', () => {
  const routine = ['outlook_get_calendar_view'];
  const words = ['whats', 'calendar', 'tomorrow'];
  assert.equal(workflowCovers({ name: 'Tomorrow calendar', tools: new Set(['OUTLOOK_GET_CALENDAR_VIEW']), keywords: ['tomorrow', 'calendar', 'read'] }, routine, words), true);
  assert.equal(workflowCovers({ name: 'Morning briefing', tools: new Set(['OUTLOOK_GET_CALENDAR_VIEW']), keywords: ['morning', 'briefing', 'inbox'] }, routine, words), false, 'same tool, different subject');
  assert.equal(workflowCovers({ name: 'Tomorrow plan', tools: new Set(['GOOGLECALENDAR_LIST_EVENTS']), keywords: ['tomorrow', 'calendar'] }, routine, words), false, 'same subject, different tool');
});

test('the suggested name is the user\'s own words as a title; the plan is one workflow_from_session step', () => {
  assert.equal(suggestedWorkflowName('whats on my calendar tomorrow?'), 'Whats on my calendar tomorrow');
  assert.equal(suggestedWorkflowName('   '), 'Saved routine');
  const candidate: SuggestionCandidate = {
    strategyId: 'strat-cal', objective: 'whats on my calendar tomorrow', tools: ['outlook_get_calendar_view'], workTools: ['outlook_get_calendar_view'],
    turns: 4, distinctDays: 2, sessions: 3, firstAt: '2026-09-21T09:00:00.000Z', lastAt: '2026-09-22T09:00:00.000Z', latestSessionId: 'sess-cal-b', latestSourceUserSeq: 200,
  };
  const plan = buildSuggestionPlan(candidate, 'Whats on my calendar tomorrow');
  assert.equal(plan.steps.length, 1);
  assert.match(plan.steps[0].action, /workflow_from_session with name "Whats on my calendar tomorrow" and sessionId "sess-cal-b"/);
  assert.match(plan.steps[0].action, /manual-only/);
  assert.deepEqual(plan.needsUserInput, []);
  assert.equal(plan.estimatedComplexity, 'trivial');
  assert.match(plan.successCriteria[0], /enabled after a passing creation test/);
});

test('isWorkTool: discovery, planning and control tools are never the work; local adapters and provider operations are', () => {
  for (const tool of ['tool_search', 'plan_task', 'memory_recall_all', 'workspace_roots', 'list_files', 'workflow_get', 'workflow_update', 'work_call', 'call_tool']) {
    assert.equal(isWorkTool(tool), false, `${tool} is not work`);
  }
  assert.equal(isWorkTool('read_file'), true);
  assert.equal(isWorkTool('write_file'), true);
});

function makeDeps(overrides: Partial<WorkflowSuggestionsDeps> = {}): { deps: WorkflowSuggestionsDeps; surfaced: Array<{ candidate: SuggestionCandidate; name: string }>; state: () => WorkflowSuggestionsState } {
  let state = emptyWorkflowSuggestionsState();
  const surfaced: Array<{ candidate: SuggestionCandidate; name: string }> = [];
  const statuses = new Map<string, 'pending' | 'approved' | 'rejected' | 'missing'>();
  const deps: WorkflowSuggestionsDeps = {
    now: () => NOW,
    policy: () => ({ enabled: true, cadenceMinutes: 360, quietHoursActive: false }),
    observations: () => [obs('strat-cal', 0), obs('strat-cal', 0, 'sess-cal-b', 200), obs('strat-cal', 1), obs('strat-sf', 0), obs('strat-sf', 3), obs('strat-sf', 5)],
    strategies: () => strategies,
    existingWorkflows: () => [],
    isWorkTool: work,
    surface: (candidate, name) => { surfaced.push({ candidate, name }); const id = `plan-${surfaced.length}`; statuses.set(id, 'pending'); return id; },
    proposalStatus: (id) => statuses.get(id) ?? 'missing',
    loadState: () => structuredClone(state),
    saveState: (next) => { state = structuredClone(next); },
    ...overrides,
  };
  return { deps: Object.assign(deps, { _statuses: statuses }), surfaced, state: () => state };
}

test('a tick raises ONE suggestion for the most repeated request and stays quiet while it is unanswered', () => {
  const { deps, surfaced, state } = makeDeps();
  const first = processWorkflowSuggestionsTick(deps, { source: 'manual' });
  assert.equal(first.proposed, 1);
  assert.equal(first.candidates, 2, 'two routines qualified');
  assert.equal(surfaced.length, 1);
  assert.equal(surfaced[0].candidate.strategyId, 'strat-cal', 'the most repeated first');
  assert.equal(surfaced[0].name, 'Whats on my calendar tomorrow');
  assert.match(first.summary, /Suggested saving "whats on my calendar tomorrow" as a workflow \(3 times on 2 days\)/);
  const second = processWorkflowSuggestionsTick(deps, { source: 'heartbeat' });
  assert.equal(second.proposed, 0, 'one open suggestion at a time');
  assert.equal(surfaced.length, 1);
  assert.match(second.summary, /already waiting for your answer/);
  assert.equal(state().records.length, 1);
  assert.equal(state().metrics.ticks, 2);
  assert.equal(state().metrics.quietTicks, 1);
  const status = workflowSuggestionsStatus(NOW);
  assert.equal(status.id, 'workflow-suggestions');
});

test('a decline is remembered for the cooldown, an approval retires the record, and the next routine gets its turn', () => {
  const { deps, surfaced, state } = makeDeps();
  const statuses = (deps as unknown as { _statuses: Map<string, 'pending' | 'approved' | 'rejected' | 'missing'> })._statuses;
  processWorkflowSuggestionsTick(deps, { source: 'manual' });
  statuses.set('plan-1', 'rejected');
  const after = processWorkflowSuggestionsTick(deps, { source: 'manual' });
  assert.equal(state().records[0].status, 'declined');
  assert.equal(state().metrics.declined, 1);
  assert.equal(after.proposed, 1, 'the declined routine is out; the salesforce routine is suggested next');
  assert.equal(surfaced[1].candidate.strategyId, 'strat-sf');
  statuses.set('plan-2', 'approved');
  const later = processWorkflowSuggestionsTick(deps, { source: 'manual' });
  assert.equal(state().records[1].status, 'approved');
  assert.equal(later.proposed, 0, 'nothing left to suggest: one declined within cooldown, one approved');
  assert.ok(SUGGESTION_DECLINE_COOLDOWN_DAYS >= 14);
});

test('an unanswered suggestion expires and a disabled or quiet-hours watch raises nothing', () => {
  const { deps, state } = makeDeps();
  processWorkflowSuggestionsTick(deps, { source: 'manual' });
  const late = new Date(NOW.getTime() + (SUGGESTION_PENDING_EXPIRY_DAYS + 1) * DAY);
  const expiredTick = processWorkflowSuggestionsTick({ ...deps, now: () => late, observations: () => [] }, { source: 'heartbeat' });
  assert.equal(expiredTick.expired, 1);
  assert.equal(state().records[0].status, 'expired');
  const off = processWorkflowSuggestionsTick({ ...deps, policy: () => ({ enabled: false, cadenceMinutes: 360, quietHoursActive: false }) }, { source: 'heartbeat' });
  assert.equal(off.skipped, 'disabled');
  const quiet = processWorkflowSuggestionsTick({ ...deps, policy: () => ({ enabled: true, cadenceMinutes: 360, quietHoursActive: true }) }, { source: 'heartbeat' });
  assert.equal(quiet.skipped, 'quiet_hours');
  const forced = processWorkflowSuggestionsTick({ ...deps, policy: () => ({ enabled: false, cadenceMinutes: 360, quietHoursActive: true }) }, { source: 'manual', force: true });
  assert.equal(forced.skipped, undefined, '"Check now" runs even when the switch is off');
});
