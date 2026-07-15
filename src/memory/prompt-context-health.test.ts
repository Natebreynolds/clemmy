import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-prompt-context-health-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.NODE_ENV = 'test';

const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');
const { readPromptContextHealth } = await import('./prompt-context-health.js');
const { appendFactRecallTrace } = await import('./recall-trace.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test('prompt context health reports included, omitted, and legacy-unknown runs honestly', () => {
  resetEventLog();
  const session = createSession({ id: 'prompt-health', kind: 'chat' });
  appendEvent({
    sessionId: session.id, turn: 1, role: 'system', type: 'turn_memory_primer',
    data: { hitCount: 1, includedCount: 1, injected: true, source: 'legacy_fallback' },
  });
  appendEvent({
    sessionId: session.id, turn: 2, role: 'system', type: 'turn_memory_primer',
    data: { hitCount: 0, includedCount: 0, omittedCount: 0, candidateCount: 0, injected: false, source: 'unified' },
  });
  appendEvent({
    sessionId: session.id, turn: 3, role: 'system', type: 'turn_memory_primer',
    data: { hitCount: 3, includedCount: 3, omittedCount: 2, candidateCount: 20, injected: true, source: 'unified' },
  });
  appendFactRecallTrace({
    surface: 'facts_for_instructions',
    mode: 'pinned',
    includedCount: 2,
    omittedCount: 3,
    candidateCount: 5,
    enforcementBackedCount: 2,
    facts: [
      { fact: { id: 41, kind: 'constraint', pinned: true } as never, reason: 'policy:hard_constraint' },
      { fact: { id: 42, kind: 'user', pinned: true } as never, reason: 'policy:core_profile' },
    ],
  });
  appendFactRecallTrace({
    surface: 'turn_memory_primer',
    mode: 'legacy_assistant_primer',
    sessionId: 'legacy-direct-session',
    includedCount: 2,
    omittedCount: 1,
    candidateCount: 9,
    facts: [],
    nowIso: new Date(Date.now() + 1_000).toISOString(),
  });

  const health = readPromptContextHealth(30);
  assert.equal(health.runs, 4);
  assert.equal(health.injectedRuns, 3);
  assert.equal(health.telemetryCompleteRuns, 3);
  assert.equal(health.unknownOmissionRuns, 1);
  assert.equal(health.included, 6);
  assert.equal(health.omitted, 3);
  assert.equal(health.candidates, 29);
  assert.equal(health.omissionRate, 0.375);
  assert.deepEqual(health.last, {
    included: 2, omitted: 1, candidates: 9, source: 'legacy_assistant_primer', injected: true,
  });
  assert.deepEqual(health.bySource, { legacy_assistant_primer: 1, unified: 2, legacy_fallback: 1 });
  assert.deepEqual(health.standingContext.last, {
    mode: 'pinned', included: 2, omitted: 3, candidates: 5, enforcementBacked: 2,
  });
});
