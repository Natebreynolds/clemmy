/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-runtrack npx tsx --test src/agents/run-tracking.test.ts
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-runtrack';
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  autonomyRunSlug,
  autonomySessionId,
  finishAutonomyRun,
  getAutonomyRun,
  isAutonomyRun,
  listAutonomyRuns,
  recordAutonomyDecision,
  recordAutonomyResponse,
  startAutonomyRun,
} = await import('./run-tracking.js');

import type { TeamAgentRecord } from '../tools/shared.js';

function fakeAgent(slug: string, name = 'Test'): TeamAgentRecord {
  return {
    slug,
    name,
    description: '',
    canMessage: [],
    allowedTools: [],
    personality: 'test',
  };
}

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME + '/state', { recursive: true });
});

beforeEach(() => {
  // Reset the runs file before each test for isolation.
  rmSync(`${TEST_HOME}/state/runs.json`, { force: true });
});

test('autonomySessionId encodes slug', () => {
  assert.equal(autonomySessionId('clementine'), 'agent:clementine');
});

test('startAutonomyRun creates a daemon-source run', () => {
  const runId = startAutonomyRun(fakeAgent('clementine'), ['inbox', 'cadence'], 3);
  assert.ok(runId.length > 0);

  const run = getAutonomyRun(runId);
  assert.ok(run, 'run loadable by id');
  assert.equal(run!.source, 'daemon');
  assert.equal(run!.sessionId, 'agent:clementine');
  assert.equal(run!.status, 'running');
  assert.match(run!.title, /Test autonomy cycle/);
  assert.match(run!.title, /inbox, cadence/);

  // First two events: received + status.
  assert.ok(run!.events.length >= 2);
  const statusEvent = run!.events.find((e) => e.type === 'status');
  assert.ok(statusEvent, 'status event present');
  assert.match(statusEvent!.message, /Wake: inbox, cadence/);
});

test('recordAutonomyResponse and recordAutonomyDecision add events', () => {
  const runId = startAutonomyRun(fakeAgent('a1'), ['cadence'], 0);
  recordAutonomyResponse(runId, JSON.stringify({ summary: 'ok' }));
  recordAutonomyDecision(runId, {
    summary: 'Did X.',
    actions: [{ type: 'noop' }],
    commitments: ['Follow up tomorrow.'],
    followUpMinutes: 30,
  });

  const run = getAutonomyRun(runId);
  const messages = run!.events.map((e) => e.message);
  assert.ok(messages.some((m) => m.includes('Response received')), 'response event present');
  assert.ok(messages.some((m) => m.includes('Decision parsed')), 'decision event present');
});

test('finishAutonomyRun (success) sets completed status', () => {
  const runId = startAutonomyRun(fakeAgent('a1'), ['inbox'], 1);
  finishAutonomyRun(runId, ['updated task X', 'notified user']);

  const run = getAutonomyRun(runId);
  assert.equal(run!.status, 'completed');
  assert.ok(run!.completedAt, 'completedAt set');
  assert.match(run!.outputPreview ?? '', /updated task X/);
});

test('finishAutonomyRun (error) sets failed status and captures error', () => {
  const runId = startAutonomyRun(fakeAgent('a1'), ['inbox'], 1);
  finishAutonomyRun(runId, [], 'Agent response was not valid JSON');

  const run = getAutonomyRun(runId);
  assert.equal(run!.status, 'failed');
  assert.equal(run!.error, 'Agent response was not valid JSON');
});

test('isAutonomyRun detects daemon source and agent: sessionId', () => {
  const runId = startAutonomyRun(fakeAgent('a1'), ['cadence'], 0);
  const run = getAutonomyRun(runId)!;
  assert.equal(isAutonomyRun(run), true);
});

test('autonomyRunSlug extracts slug from sessionId', () => {
  const runId = startAutonomyRun(fakeAgent('researcher'), ['cadence'], 0);
  const run = getAutonomyRun(runId)!;
  assert.equal(autonomyRunSlug(run), 'researcher');
});

test('listAutonomyRuns filters and orders correctly', () => {
  const r1 = startAutonomyRun(fakeAgent('a1'), ['cadence'], 0);
  const r2 = startAutonomyRun(fakeAgent('a2'), ['cadence'], 0);
  const r3 = startAutonomyRun(fakeAgent('a1'), ['cadence'], 0);
  finishAutonomyRun(r1, ['x']);
  finishAutonomyRun(r2, ['y']);
  finishAutonomyRun(r3, ['z']);

  const all = listAutonomyRuns({ limit: 10 });
  assert.equal(all.length, 3);

  const a1Only = listAutonomyRuns({ slug: 'a1', limit: 10 });
  assert.equal(a1Only.length, 2);
  assert.ok(a1Only.every((r) => r.sessionId === 'agent:a1'));
});

test('listAutonomyRuns respects limit', () => {
  for (let i = 0; i < 5; i++) {
    const id = startAutonomyRun(fakeAgent('a1'), ['cadence'], 0);
    finishAutonomyRun(id, [`run ${i}`]);
  }
  const limited = listAutonomyRuns({ limit: 2 });
  assert.equal(limited.length, 2);
});
