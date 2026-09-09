import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-focus-scope-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const { focusSummaryIsHistoricalForRequest } = await import('./focus-projection.js');
const memory = await import('../../memory/db.js');
const { createFocus } = await import('../../memory/focus.js');
const { resolveActiveTaskContext } = await import('./active-task-context.js');
const { buildAgentContextPacket } = await import('./context-packet.js');
const { renderHarnessMemoryContext } = await import('../../agents/harness-context.js');
const { closeEventLog } = await import('./eventlog.js');

test.after(() => {
  closeEventLog();
  memory.closeMemoryDb();
  rmSync(fixtureHome, { recursive: true, force: true });
});

test('reviewing these three drafts does not import unrelated stale or parked Tyler work', () => {
  memory.resetMemoryDb();
  createFocus({ resourceRef: 'session:old-tyler', relatedSessionId: 'old-tyler',
    title: 'Five drafts for Tyler Jorgensen', summary: 'Unrelated parked work.' });
  createFocus({ resourceRef: 'session:old-stale', relatedSessionId: 'old-stale',
    title: 'Create five stale drafts', summary: 'Unrelated stale work.', staleOnCreate: true });
  for (const input of [
    'Show these three drafts here for my review.',
    'Review these three drafts.',
    'Continue polishing these three drafts.',
    'Inspect these three drafts.',
    'Summarize these three drafts.',
    'What is the status of these three drafts?',
  ]) {
    const scope = { sessionId: 'current-brett-conversation', input };
    const context = resolveActiveTaskContext(scope);
    assert.equal(context.focus, null, input);
    assert.deepEqual(context.parked, [], input);
    assert.doesNotMatch(renderHarnessMemoryContext({ sessionId: scope.sessionId, focusInput: input }),
      /Tyler|five stale drafts|Unrelated parked|Unrelated stale/, input);
    assert.doesNotMatch(buildAgentContextPacket(input, { enabled: false, hitCount: 0, injected: false },
      { sessionId: scope.sessionId, suppressSemanticEnrichment: true }).text, /Tyler|five stale drafts/, input);
  }
});

test('focus scope follows session ownership rather than review or continuation wording', () => {
  const focus = { related_session_id: 'focus-owner' };
  for (const input of ['Review the previous work.', 'Continue.', 'Resume the workflow.', 'Show these drafts.', '']) {
    assert.equal(focusSummaryIsHistoricalForRequest(focus, input, 'other-session'), true, input);
    assert.equal(focusSummaryIsHistoricalForRequest(focus, input, 'focus-owner'), false, input);
  }
  assert.equal(focusSummaryIsHistoricalForRequest(focus, 'Start a brand-new task.', 'focus-owner'), true);
});
