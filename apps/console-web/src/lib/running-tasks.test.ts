import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { workingNowSnapshotFromResponse, type ActivityEntry } from './activity.js';
import type { BoardCard } from './board.js';
import { boardCardForActivity, runningTaskActions, serverElapsedLabel } from './running-tasks.js';

function activity(patch: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    schemaVersion: 1,
    runKey: 'chat:session-1',
    attemptId: 'attempt-a',
    kind: 'chat',
    lifecycle: 'reasoning',
    liveness: 'live',
    needsAttention: false,
    headline: 'Compare release candidates',
    startedAt: '2026-08-22T12:00:00.000Z',
    lastEvidenceAt: '2026-08-22T12:01:00.000Z',
    revision: 4,
    sessionId: 'session-1',
    ...patch,
  };
}

function card(patch: Partial<BoardCard> = {}): BoardCard {
  return {
    id: 'run-card-a',
    sourceKind: 'run',
    title: 'Compare release candidates',
    column: 'running',
    status: 'running',
    progressHint: '',
    sessionId: 'session-1',
    ageMs: 0,
    updatedAt: '2026-08-22T12:01:00.000Z',
    actions: ['cancel'],
    attemptId: 'attempt-a',
    runScopeId: 'scope-a',
    raw: { runId: 'scope-a' },
    ...patch,
  };
}

test('activity-to-board matching requires exact attempt identity for reusable chat sessions', () => {
  const old = card({ id: 'old', attemptId: 'attempt-old', runScopeId: 'scope-old', raw: { runId: 'shared-run-id' } });
  const exact = card();
  assert.equal(boardCardForActivity(activity(), [old, exact])?.id, exact.id);
  assert.equal(boardCardForActivity(activity({ attemptId: 'missing', runId: 'shared-run-id' }), [old, exact]), undefined,
    'a stale same-session/run-id neighbor cannot inherit controls');
});

test('durable task and workflow identities match before a session fallback', () => {
  const task = card({ id: 'bg-1', sourceKind: 'background', sessionId: 'background:bg-1', attemptId: undefined, raw: {} });
  assert.equal(boardCardForActivity(activity({ kind: 'background', taskId: 'bg-1' }), [task])?.id, 'bg-1');
  const workflow = card({ id: 'wf-card', sourceKind: 'workflow', sessionId: null, attemptId: undefined, raw: { runId: 'wf-run-1' } });
  assert.equal(boardCardForActivity(activity({ kind: 'workflow', sessionId: undefined, runId: 'wf-run-1' }), [workflow])?.id, 'wf-card');
});

test('a fan-out aggregate cannot inherit controls from its origin chat card', () => {
  const origin = card();
  const plan = activity({
    runKey: 'fanout:plan-1',
    kind: 'fanout',
    planId: 'plan-1',
  });
  assert.equal(boardCardForActivity(plan, [origin]), undefined);
});

test('drawer actions come only from canonical card allowlists and retain exact deep-link identity', () => {
  const actions = runningTaskActions(activity(), card({ actions: ['cancel', 'resume_safe'] }));
  assert.equal(actions.stop, 'cancel');
  assert.equal(actions.resume, 'resume_safe');
  assert.equal(actions.openLabel, 'Open');
  assert.equal(actions.openHref, '/tasks?select=session-1&attemptId=attempt-a&runScopeId=scope-a');

  const closed = runningTaskActions(activity({ needsAttention: true }), card({ actions: ['approve'] }));
  assert.equal(closed.openLabel, 'Review');
  assert.equal(closed.stop, undefined);
  assert.equal(closed.resume, undefined);
});

test('elapsed is computed from server snapshot time, never client liveness', () => {
  assert.equal(serverElapsedLabel('2026-08-22T12:00:00.000Z', '2026-08-22T12:09:22.000Z'), '9m 22s');
  assert.equal(serverElapsedLabel('bad', '2026-08-22T12:09:22.000Z'), '');
});

test('the console client preserves every row in the bounded server snapshot for its count', () => {
  const rows = Array.from({ length: 30 }, (_, index) => activity({
    runKey: `chat:session-${index}`,
    sessionId: `session-${index}`,
    attemptId: `attempt-${index}`,
  }));
  const snapshot = workingNowSnapshotFromResponse({
    schemaVersion: 1,
    observedAt: '2026-08-22T12:09:22.000Z',
    entries: rows,
  });
  assert.equal(snapshot.entries.length, 30);
  assert.equal(snapshot.entries.at(-1)?.sessionId, 'session-29');
});

test('the running-task affordance is not on Chat — Running lives on Home and /tasks', () => {
  const newChat = readFileSync(new URL('../screens/Chat.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(newChat, /RunningTasksDrawer/);
  assert.doesNotMatch(newChat, /border-t border-border/);

  const thread = readFileSync(
    new URL('../features/conversations/chat/ConversationThread.tsx', import.meta.url),
    'utf8',
  );
  const continuable = thread.slice(thread.indexOf('function ContinuableThread'), thread.indexOf('function ReadOnlyThread'));
  const readOnly = thread.slice(thread.indexOf('function ReadOnlyThread'));
  assert.doesNotMatch(continuable, /RunningTasksDrawer/);
  assert.doesNotMatch(readOnly, /RunningTasksDrawer/, 'a read-only transcript never gains task controls');

  const workspace = readFileSync(new URL('../screens/WorkspaceView.tsx', import.meta.url), 'utf8');
  assert.match(workspace, /const composerRef = useRef<HTMLTextAreaElement>\(null\)/);
  assert.match(workspace, /<RunningTasksDrawer className="mb-1" composerRef=\{composerRef\} \/>[\s\S]*<Composer inputRef=\{composerRef\}/);

  const drawer = readFileSync(new URL('../components/chat/RunningTasksDrawer.tsx', import.meta.url), 'utf8');
  assert.match(drawer, /const view = presentWorkingNow\([\s\S]*activity\.data\?\.entries \?\? \[\][\s\S]*activity\.data\?\.observedAt \?\? ''[\s\S]*\)/);
  assert.match(drawer, /const rows = view\.entries\.slice\(0, MAX_RENDERED_TASKS\)/);
  assert.match(drawer, /const total = view\.total/);
  assert.match(drawer, /const pillLabel = view\.label/);
  assert.equal(drawer.match(/\{pillLabel\}/g)?.length, 2, 'trigger and drawer header share one presenter label');
  assert.doesNotMatch(drawer, /more running|\{total\} running|>Running · \{total\}</,
    'aggregate copy must not flatten queued, waiting, blocked, or paused rows into running');
  assert.match(drawer, /total === 0 && !activity\.isLoading[\s\S]*composerRef\.current\?\.focus\(\)/,
    'an auto-empty drawer focuses the adjacent composer before its trigger disappears');
  assert.match(drawer, /listForegroundWorkingNowSnapshot/);
  assert.match(drawer, /listForegroundTaskControls/);
  assert.match(drawer, /\['chat-running-task-controls'\]/);
  assert.doesNotMatch(drawer, /listBoard|getRunQueue|runQueueRef|CompactRunQueue|step\.title|RunQueue/,
    'foreground chat imported the full board or prompt-derived workflow step detail');
  assert.match(drawer, /min-h-11/);
  assert.match(drawer, /safe-area-inset-bottom/);

  const composer = readFileSync(new URL('../components/chat/Composer.tsx', import.meta.url), 'utf8');
  assert.match(composer, /inputRef\?: RefObject<HTMLTextAreaElement \| null>/);
  assert.match(composer, /const textarea = inputRef \?\? localTextarea/);

  const activityClient = readFileSync(new URL('./activity.ts', import.meta.url), 'utf8');
  assert.match(activityClient, /activity\/v2\?workingNow=1&surface=foreground-chat/);
  const boardClient = readFileSync(new URL('./board.ts', import.meta.url), 'utf8');
  assert.match(boardClient, /board\?surface=foreground-chat/);
});
