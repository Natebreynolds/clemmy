/**
 * Run: npx tsx --test src/journeys/collaborative-workstate.test.ts
 *
 * Global collaborative-work journey:
 *   1. A no-tool conversation can breathe for several turns.
 *   2. Material choices survive in one sparse shared notebook.
 *   3. A clear commitment fans out through the real background/workflow tools.
 *   4. A correction revises only the intended live branch.
 *   5. Terminal report-back reconciles both branches without duplicate turns.
 *
 * External systems are intentionally faked at the execution boundary. This
 * exercises Clementine's graph/lineage behavior without writing to a user's
 * real Airtable base or calendar.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-collaborative-journey-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_HARNESS_BACKGROUND = 'off';
process.env.CLEMMY_PROACTIVE_REPORT_DEFER = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  appendEvent,
  closeEventLog,
  createSession,
  listEvents,
  resetEventLog,
} = await import('../runtime/harness/eventlog.js');
const { resetMemoryDb } = await import('../memory/db.js');
const { maybeAutoFocusSession } = await import('../runtime/harness/auto-focus.js');
const {
  getActiveFocus,
  getFocusWorkstate,
  patchFocusWorkstate,
} = await import('../memory/focus.js');
const { renderFocusForInstructions } = await import('../agents/harness-context.js');
const { registerBackgroundTaskTools } = await import('../tools/background-task-tools.js');
const {
  getBackgroundTask,
  markBackgroundTaskDone,
} = await import('../execution/background-tasks.js');
const { registerOrchestrationTools } = await import('../tools/orchestration-tools.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const {
  readWorkflowRunRecordUnlocked,
  withWorkflowRunRecordLock,
  writeWorkflowRunRecordDurablyUnlocked,
} = await import('../execution/workflow-run-record.js');
const {
  attemptWorkflowRunReportBack,
  recordAndAttemptWorkflowRunReportBack,
} = await import('../execution/workflow-run-report-back.js');
const { setProactiveReportFireForTest } = await import('../runtime/outcome.js');

type ToolResult = { content?: Array<{ text?: string }> };
type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

function registerHandlers(register: (server: never) => void): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  register({
    tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
      handlers.set(name, handler);
    },
  } as never);
  return handlers;
}

function resultText(result: ToolResult): string {
  return result.content?.map((item) => item.text ?? '').join('\n') ?? '';
}

function workstate() {
  return getFocusWorkstate(getActiveFocus());
}

test.after(async () => {
  // Outcome delivery schedules its optional proactive relay fire-and-forget.
  // Keep the relay stub installed until those microtasks have crossed their
  // dynamic-import boundary, then remove the isolated temp home.
  await new Promise<void>((resolve) => setTimeout(resolve, 400));
  setProactiveReportFireForTest(null);
  closeEventLog();
  delete process.env.CLEMMY_HARNESS_BACKGROUND;
  delete process.env.CLEMMY_PROACTIVE_REPORT_DEFER;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('J4: converse → decide → fan out → steer one branch → reconcile both', async () => {
  setProactiveReportFireForTest(async () => { /* passive report-back is the assertion target */ });
  closeEventLog();
  resetEventLog();
  resetMemoryDb();

  const session = createSession({
    id: 'sess-collaborative-meal-journey',
    kind: 'chat',
    channel: 'desktop',
    title: 'Weeknight meal planning',
  });

  // Exploration stays conversational: no task, workflow, or external write is
  // required merely because the user is narrowing choices over several turns.
  for (const [turn, text] of [
    [1, 'Help me plan three easy dinners for next week.'],
    [2, 'What about black bean tacos, and can we keep everything vegetarian?'],
    [3, 'I like those tacos. I also want a mild chickpea curry and pesto pasta.'],
  ] as const) {
    appendEvent({
      sessionId: session.id,
      turn,
      role: 'user',
      type: 'user_input_received',
      data: { text },
    });
  }

  const autoFocus = maybeAutoFocusSession({
    sessionId: session.id,
    summaryHint: { summary: 'Comparing weeknight recipes before choosing and scheduling them.' },
  });
  assert.ok(autoFocus, 'the sustained conversation becomes resumable without a tool-count threshold');
  assert.equal(getActiveFocus()?.resource_ref, `session:${session.id}`);
  assert.equal(workstate(), null, 'auto-focus does not invent decisions or a mandatory plan');
  assert.equal(existsSync(WORKFLOW_RUNS_DIR), false, 'exploration queued no workflow');

  const explored = patchFocusWorkstate(autoFocus.id, {
    mode: 'explore',
    objective: 'Choose three vegetarian weeknight dinners, then save and schedule them.',
    upsertCandidates: [
      { id: 'tacos', label: 'Black bean tacos', status: 'considering' },
      { id: 'curry', label: 'Mild chickpea curry', status: 'considering' },
      { id: 'pasta', label: 'Pesto pasta', status: 'considering' },
    ],
    addConstraints: ['Vegetarian', 'Easy weeknight cooking', 'Keep the curry mild'],
    openLoops: ['Which nights should each dinner land on?'],
  });
  assert.equal(explored.status, 'updated');

  appendEvent({
    sessionId: session.id,
    turn: 4,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Use those three. Save them to Airtable and add dinners Monday through Wednesday to my calendar.',
    },
  });
  const committed = patchFocusWorkstate(autoFocus.id, {
    mode: 'execute',
    upsertCandidates: [
      { id: 'tacos', label: 'Black bean tacos', status: 'selected', note: 'Monday' },
      { id: 'curry', label: 'Mild chickpea curry', status: 'selected', note: 'Tuesday' },
      { id: 'pasta', label: 'Pesto pasta', status: 'selected', note: 'Wednesday' },
    ],
    addDecisions: [
      'Use tacos Monday, curry Tuesday, and pasta Wednesday',
      'Save the selected recipes to Airtable and schedule all three dinners',
    ],
    openLoops: [],
  }, explored.actualVersion);
  assert.equal(committed.status, 'updated');

  writeWorkflow('save-selected-recipes', {
    name: 'save-selected-recipes',
    description: 'Save the already-selected recipes to the bound recipe base.',
    enabled: true,
    trigger: { manual: true },
    steps: [{
      id: 'save_rows',
      prompt: 'Save the three already-selected recipe records and verify their count.',
    }],
  });
  const workflowHandlers = registerHandlers(registerOrchestrationTools as never);
  const backgroundHandlers = registerHandlers(registerBackgroundTaskTools as never);
  const runWorkflow = workflowHandlers.get('workflow_run');
  const dispatchBackground = backgroundHandlers.get('dispatch_background_task');
  const reviseBackground = backgroundHandlers.get('background_task_revise');
  assert.ok(runWorkflow && dispatchBackground && reviseBackground);

  // Both independent branches are launched before either one completes.
  const [workflowResult, backgroundResult] = await Promise.all([
    withToolOutputContext({ sessionId: session.id, callId: 'j4-airtable' }, () =>
      runWorkflow!({ name: 'save-selected-recipes', inputs: '{}' })),
    withToolOutputContext({ sessionId: session.id, callId: 'j4-calendar' }, () =>
      dispatchBackground!({
        objective: 'Schedule the three selected dinners on the calendar.',
        handoff_note: 'I’m scheduling the selected dinners and will report back here.',
        plan: '- Add tacos Monday\n- Add curry Tuesday\n- Add pasta Wednesday\n- Verify all three events',
        success_criteria: ['Exactly three correctly dated dinner events exist'],
        context_refs: [],
        max_minutes: 15,
      })),
  ]);
  assert.match(resultText(workflowResult), /Queued "save-selected-recipes"/);
  const backgroundText = resultText(backgroundResult);
  const calendarTaskId = backgroundText.match(/task (bg-[a-zA-Z0-9_-]+)/)?.[1];
  assert.ok(calendarTaskId, `calendar branch returns its durable task id (got: ${backgroundText.slice(0, 240)})`);

  const [workflowRunFile] = readdirSync(WORKFLOW_RUNS_DIR).filter((name) => name.endsWith('.json'));
  assert.ok(workflowRunFile, 'the Airtable branch has a durable workflow run');
  const workflowPath = path.join(WORKFLOW_RUNS_DIR, workflowRunFile);
  const workflowRun = JSON.parse(readFileSync(workflowPath, 'utf-8')) as { id: string };
  const runningActions = workstate()?.actions ?? [];
  assert.equal(runningActions.length, 2);
  assert.deepEqual(
    new Set(runningActions.map((action) => action.status)),
    new Set(['running']),
    'both branches are visible as in-flight at the same time',
  );
  assert.ok(runningActions.some((action) => action.ref === workflowRun.id && action.kind === 'workflow'));
  assert.ok(runningActions.some((action) => action.ref === calendarTaskId && action.kind === 'background'));

  const visibleWhileRunning = renderFocusForInstructions({
    sessionId: session.id,
    input: 'How is our meal plan going?',
  });
  assert.match(visibleWhileRunning, /Shared workstate v\d+ · execute/);
  assert.match(visibleWhileRunning, /\[selected\] tacos/);
  assert.match(visibleWhileRunning, /Keep the curry mild/);
  assert.match(visibleWhileRunning, new RegExp(`\\[running\\].*${calendarTaskId}`));
  assert.match(visibleWhileRunning, new RegExp(`\\[running\\].*${workflowRun.id}`));

  // The user changes one live branch. Its durable identity is retained and the
  // already-running Airtable branch and prior choices are not reset.
  appendEvent({
    sessionId: session.id,
    turn: 5,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Actually move the curry dinner to Thursday; leave Airtable and the other nights alone.' },
  });
  const airtableBeforeCorrection = workstate()?.actions.find((action) => action.ref === workflowRun.id);
  const revision = await withToolOutputContext({ sessionId: session.id, callId: 'j4-calendar-revise' }, () =>
    reviseBackground!({
      id: calendarTaskId,
      instruction: 'Move only the chickpea curry event from Tuesday to Thursday; preserve Monday tacos and Wednesday pasta.',
      evidence_policy: 'revalidate',
    }));
  assert.match(resultText(revision), /contract v2/i);
  assert.equal(getBackgroundTask(calendarTaskId!)?.contractVersion, 2);

  const afterCorrection = workstate();
  assert.deepEqual(
    afterCorrection?.actions.find((action) => action.ref === workflowRun.id),
    airtableBeforeCorrection,
    'course-correcting Calendar does not disturb the Airtable branch',
  );
  assert.match(
    afterCorrection?.actions.find((action) => action.ref === calendarTaskId)?.note ?? '',
    /contract v2/i,
  );
  assert.equal(afterCorrection?.candidates.filter((candidate) => candidate.status === 'selected').length, 3);
  assert.equal(afterCorrection?.decisions.length, 2, 'material conversation history survives runtime updates');

  // Simulate verified terminal work at the provider boundary, then exercise
  // the production report-back/reconciliation paths.
  withWorkflowRunRecordLock(workflowPath, () => {
    const current = readWorkflowRunRecordUnlocked<Record<string, unknown>>(workflowPath);
    assert.ok(current);
    writeWorkflowRunRecordDurablyUnlocked(workflowPath, {
      ...current,
      status: 'completed',
      finishedAt: new Date().toISOString(),
    });
  });
  assert.equal(recordAndAttemptWorkflowRunReportBack(workflowPath, {
    workflowName: 'save-selected-recipes',
    outcome: 'done',
    detail: 'Exactly three selected recipes were saved and verified.',
  }), true);
  markBackgroundTaskDone(
    calendarTaskId!,
    'Verified tacos Monday, pasta Wednesday, and the corrected curry event Thursday.',
  );

  // Retried terminal callbacks are idempotent: no cloned action and no cloned
  // report-back turn can masquerade as another external write.
  assert.equal(
    attemptWorkflowRunReportBack(workflowPath),
    false,
    'an already-acknowledged workflow has no second delivery to perform',
  );
  markBackgroundTaskDone(
    calendarTaskId!,
    'Verified tacos Monday, pasta Wednesday, and the corrected curry event Thursday.',
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  const finalState = workstate();
  assert.equal(finalState?.actions.length, 2);
  assert.ok(finalState?.actions.every((action) => action.status === 'done'));
  assert.equal(new Set(finalState?.actions.map((action) => action.ref)).size, 2);
  assert.equal(finalState?.candidates.filter((candidate) => candidate.status === 'selected').length, 3);
  assert.deepEqual(finalState?.openLoops, []);

  const outcomeTurns = listEvents(session.id).filter((event) =>
    event.type === 'user_input_received'
    && (event.data as { source?: unknown }).source === 'outcome');
  assert.equal(
    outcomeTurns.filter((event) => String((event.data as { text?: unknown }).text).includes(workflowRun.id)).length,
    1,
    'the workflow reports back exactly once',
  );
  assert.equal(
    outcomeTurns.filter((event) => String((event.data as { text?: unknown }).text).includes(calendarTaskId!)).length,
    1,
    'the background branch reports back exactly once',
  );

  const visibleWhenDone = renderFocusForInstructions({
    sessionId: session.id,
    input: 'What did we finish?',
  });
  assert.match(visibleWhenDone, new RegExp(`\\[done\\].*${calendarTaskId}`));
  assert.match(visibleWhenDone, new RegExp(`\\[done\\].*${workflowRun.id}`));
});
