/**
 * Run: node scripts/run-tests-isolated.mjs apps/console-web/src/components/home/home-model.test.ts
 *
 * THE DEFECT THIS FILE EXISTS TO PIN. The run page was built, shipped and
 * verified green — and Home's "Open run" still pointed at the /tasks drawer,
 * so from the main screen the feature was unreachable. Nothing caught it,
 * because the two lanes owned different files and each was correct alone. Only
 * opening the app in a browser found it.
 *
 * The link is therefore not an implementation detail: it is the whole
 * difference between a durable run page existing and a user ever seeing one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { homeBlocks, homeRows, presenceLine, runningOpenTarget, steerTarget } from './home-model.js';
import {
  DEFAULT_HOME_PANE_ORDER,
  DEFAULT_HOME_PREFERENCES,
  migrateHomePreferences,
  visiblePanes,
} from '../../lib/home-prefs.js';
import type { HomePreferences } from '../../lib/home-prefs.js';
import type { ActivityEntry } from '../../lib/activity';

function entry(over: Partial<ActivityEntry>): ActivityEntry {
  return {
    runKey: 'rk-1',
    kind: 'workflow',
    headline: 'friday-dashboard-daily-refresh',
    lifecycle: 'using_tool',
    liveness: 'live',
    ...over,
  } as ActivityEntry;
}

test('a run with a session opens its durable run page, not the drawer', () => {
  const target = runningOpenTarget(entry({ sessionId: 'harness:workflow:trigger-abc:update_dashboard' }));
  assert.equal(
    target,
    '/chat/harness%3Aworkflow%3Atrigger-abc%3Aupdate_dashboard',
    'the run has an address — sending the owner to transient drawer state instead wastes it',
  );
});

test('a bare harness session id is normalized the same way the rail normalizes it', () => {
  // Otherwise Home and the conversation list would deep-link to two different
  // URLs for one run, and only one of them would resolve.
  assert.equal(
    runningOpenTarget(entry({ kind: 'chat', sessionId: 'sess-desktop-123' })),
    '/chat/harness%3Asess-desktop-123',
  );
});

test('a row with no session keeps the board deep link, because it has nothing else', () => {
  // A queued task or a run scope that never minted a harness session cannot
  // render at a session address; the board is genuinely its home.
  assert.equal(
    runningOpenTarget(entry({ kind: 'background', taskId: 'task-9' })),
    '/tasks?select=task-9',
  );
  assert.equal(
    runningOpenTarget(entry({ kind: 'fanout', runId: 'run-4' })),
    '/tasks?select=run-4',
  );
  assert.equal(
    runningOpenTarget(entry({ runKey: 'rk-only' })),
    '/tasks?select=rk-only',
    'runKey is the last resort, so a row is never unopenable',
  );
});

test('the session wins over the task id when a row carries both', () => {
  // The old rule preferred taskId, which is what sent workflow rows to the
  // drawer even after they had a page.
  assert.equal(
    runningOpenTarget(entry({ taskId: 'task-9', sessionId: 'harness:sess-x' })),
    '/chat/harness%3Asess-x',
  );
});

test('steer still means "say something to a live chat turn", and nothing else', () => {
  assert.equal(steerTarget(entry({ kind: 'chat', sessionId: 'sess-1' })), '/chat/harness%3Asess-1');
  assert.equal(steerTarget(entry({ kind: 'workflow', sessionId: 'harness:wf-1' })), null);
  assert.equal(steerTarget(entry({ kind: 'chat' })), null);
});


// ─── The window leads with work ────────────────────────────────────────────
// The owner's verdict was that the console "feels more like a chatbot app".
// The single loudest reason was this order: a greeting and a text box came
// first, and the panes that answer "what are my employees doing" came after.

test('the composer sinks below every pane the user kept', () => {
  assert.deepEqual(
    homeBlocks(['needs_you', 'running', 'while_away', 'projects']),
    ['needs_you', 'running', 'while_away', 'projects', 'composer'],
  );
});

test('the shipped default puts work first and the two "talk to Clem" blocks last', () => {
  // "Work leads" is now expressed in the DEFAULT ORDER, which the Customize
  // sheet displays, rather than by the renderer overruling that order.
  assert.deepEqual(
    homeBlocks(visiblePanes(DEFAULT_HOME_PREFERENCES)),
    ['needs_you', 'running', 'while_away', 'projects', 'quick_actions', 'composer'],
  );
});

/**
 * THE PREFERENCE THAT COULD NOT BE EXPRESSED.
 *
 * homeBlocks used to sink `quick_actions` whenever it preceded every work
 * pane — which is exactly what dragging "Quick actions" to slot 1 produces.
 * The sheet drew the chips in position 1, the drag saved, and the home went on
 * rendering them last. These two cases are the same arrangement seen from the
 * sheet and from the screen; if they ever disagree again, the sheet is lying.
 */
test('a user who drags the chips to slot 1 gets them in slot 1', () => {
  assert.deepEqual(
    homeBlocks(['quick_actions', 'needs_you', 'running', 'while_away', 'projects']),
    ['quick_actions', 'needs_you', 'running', 'while_away', 'projects', 'composer'],
  );
});

test('every pane order renders verbatim; the composer is the only block the code places', () => {
  assert.deepEqual(
    homeBlocks(['needs_you', 'quick_actions', 'running']),
    ['needs_you', 'quick_actions', 'running', 'composer'],
  );
  assert.deepEqual(homeBlocks(['projects', 'while_away']), ['projects', 'while_away', 'composer']);
});

test('with every pane hidden the composer is the page, because nothing else is', () => {
  assert.deepEqual(homeBlocks([]), ['composer']);
  assert.deepEqual(homeBlocks(['quick_actions']), ['quick_actions', 'composer']);
});

// ─── The one-time re-expression of the shipped default ─────────────────────

function prefs(order: HomePreferences['panes']['order']): HomePreferences {
  return { ...DEFAULT_HOME_PREFERENCES, panes: { order, hidden: ['workstate'] } };
}

test('the daemon\'s chips-first default is re-expressed as the chips-last default', () => {
  // Behaviour-preserving: the previous build already drew this record's chips
  // last. What changes is that the Customize sheet now shows the same thing.
  const migrated = migrateHomePreferences(prefs(['quick_actions', 'needs_you', 'running', 'while_away', 'projects']));
  assert.deepEqual(migrated.panes.order, DEFAULT_HOME_PANE_ORDER);
  assert.deepEqual(
    homeBlocks(visiblePanes(migrated)),
    ['needs_you', 'running', 'while_away', 'projects', 'quick_actions', 'composer'],
  );
});

test('an order the user actually saved is never re-expressed', () => {
  // The Customize sheet writes every known pane id, so a saved order carries
  // all six and can never collide with the five-id shipped default. Chips
  // first stays chips first.
  const chosen = prefs(['quick_actions', 'needs_you', 'running', 'while_away', 'projects', 'workstate']);
  assert.deepEqual(migrateHomePreferences(chosen).panes.order, chosen.panes.order);
  assert.equal(homeBlocks(visiblePanes(chosen))[0], 'quick_actions');

  const reordered = prefs(['running', 'needs_you', 'quick_actions', 'while_away', 'projects']);
  assert.deepEqual(migrateHomePreferences(reordered).panes.order, reordered.panes.order);
});

test('needs-you and running still share a row when they stay adjacent', () => {
  assert.deepEqual(
    homeRows(['needs_you', 'running', 'while_away', 'composer']),
    [['needs_you', 'running'], ['while_away'], ['composer']],
  );
  assert.deepEqual(
    homeRows(['running', 'needs_you']),
    [['running', 'needs_you']],
  );
});

test('a pane between them breaks the pair, and the composer never pairs', () => {
  assert.deepEqual(
    homeRows(['needs_you', 'projects', 'running', 'composer']),
    [['needs_you'], ['projects'], ['running'], ['composer']],
  );
});

// ─── The presence line is now the headline ─────────────────────────────────
// It was a subtitle under a greeting. It is the most useful sentence on the
// screen, so it is the <h1> — which makes its exact copy load-bearing.

test('the headline counts what is actually happening, in one sentence', () => {
  assert.equal(
    presenceLine({ needsYou: 6, running: 6, done: 8, paused: 0 }),
    '6 need you · 6 running · 8 done while you were away',
  );
  assert.equal(
    presenceLine({ needsYou: 1, running: 0, done: 0, paused: 1 }),
    '1 needs you · 1 paused while you were away',
  );
});

test('an idle console says so plainly rather than showing an empty headline', () => {
  assert.equal(presenceLine({ needsYou: 0, running: 0, done: 0, paused: 0 }), 'Nothing needs you right now.');
});
