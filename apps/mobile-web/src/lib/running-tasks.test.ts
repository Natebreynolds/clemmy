import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { workingNowSnapshotFromResponse, type ActivityEntry } from './api.js';
import {
  elapsedLabel,
  hasExpandableTaskFacts,
  kindLabel,
  lifecycleLabel,
  mobileRunControl,
  workerCountLabel,
} from './running-tasks.js';

function entry(patch: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    schemaVersion: 1,
    runKey: 'background:bg-1',
    attemptId: 'bg-1',
    kind: 'background',
    lifecycle: 'reasoning',
    liveness: 'live',
    needsAttention: false,
    headline: 'Compare release candidates',
    startedAt: '2026-08-22T12:00:00.000Z',
    lastEvidenceAt: '2026-08-22T12:02:00.000Z',
    revision: 1,
    taskId: 'bg-1',
    ...patch,
  };
}

test('running-task labels expose bounded runtime vocabulary and server-time elapsed only', () => {
  assert.equal(kindLabel('background'), 'Task');
  assert.equal(kindLabel('fanout'), 'Plan');
  assert.equal(lifecycleLabel('awaiting_approval'), 'Waiting for approval');
  assert.equal(lifecycleLabel('new_runtime_state'), 'Status unavailable');
  assert.equal(elapsedLabel('2026-08-22T12:00:00.000Z', '2026-08-22T12:09:22.000Z'), '9m 22s');
  assert.equal(elapsedLabel('bad', '2026-08-22T12:09:22.000Z'), '');
});

test('mobile expansion exists only when the safe foreground DTO has facts to show', () => {
  assert.equal(hasExpandableTaskFacts(entry({ needsAttention: true })), false,
    'Needs review alone manufactured a no-op Review control');
  assert.equal(hasExpandableTaskFacts(entry({ activity: { phase: 'verifying', text: 'Verifying the result' } })), true);
  assert.equal(hasExpandableTaskFacts(entry({ progress: { completed: 0, total: 4 } })), true);
  assert.equal(hasExpandableTaskFacts(entry({ children: { running: 0, completed: 0, failed: 0, total: 0 } })), false);
});

test('worker counts render only a real server-owned denominator', () => {
  assert.equal(workerCountLabel(entry()), '');
  assert.equal(workerCountLabel(entry({ children: { running: 2, completed: 7, failed: 1, total: 10 } })), '2 running · 7/10 done · 1 failed');
  assert.equal(workerCountLabel(entry({ children: { running: 0, completed: 0, failed: 0, total: 0 } })), '');
});

test('the mobile client preserves every row in the bounded server snapshot for its count', () => {
  const rows = Array.from({ length: 30 }, (_, index) => entry({
    runKey: `background:bg-${index}`,
    taskId: `bg-${index}`,
  }));
  const snapshot = workingNowSnapshotFromResponse({
    schemaVersion: 1,
    observedAt: '2026-08-22T12:09:22.000Z',
    entries: rows,
  });
  assert.equal(snapshot.entries.length, 30);
  assert.equal(snapshot.entries.at(-1)?.taskId, 'bg-29');
});

test('mobile controls fail closed without exact identity, supported lifecycle, or a nonterminal projection', () => {
  assert.deepEqual(mobileRunControl(entry()), {
    target: { kind: 'task', taskId: 'bg-1' },
    resumable: false,
  });
  assert.deepEqual(mobileRunControl(entry({ lifecycle: 'paused_budget' })), {
    target: { kind: 'task', taskId: 'bg-1' },
    resumable: true,
  });
  assert.equal(mobileRunControl(entry({ taskId: undefined })), null);
  assert.equal(mobileRunControl(entry({ lifecycle: 'mystery' })), null);
  assert.equal(mobileRunControl({
    ...entry(),
    terminal: { status: 'failed', kind: 'failed', resumable: true },
  } as unknown as ActivityEntry), null);
  assert.equal(mobileRunControl(entry({ kind: 'chat', taskId: undefined, runId: 'run-1' })), null,
    'a chat activity id is not the mobile cancel endpoint\'s background-task allowlist');
});

test('the mobile sheet is bounded, modal, keyboard dismissible, safe-area aware, and uses 44px targets', () => {
  const component = readFileSync(
    new URL('../components/RunningTasksSheet.tsx', import.meta.url),
    'utf8',
  );
  assert.match(component, /const MAX_VISIBLE_TASKS = 12/);
  // Superseded 2026-08-26: counts, label, pulse, and elapsed all come from
  // the ONE shared presenter — a private derivation here is exactly how the
  // surfaces came to disagree. Pin the presenter contract instead.
  assert.match(component, /presentWorkingNow\(data\?\.entries \?\? \[\], data\?\.observedAt \?\? ''\)/);
  assert.match(component, /const pillLabel = view\.label/);
  assert.doesNotMatch(component, /more running|\{total\} running|>Running · \{total\}</,
    'aggregate copy must not flatten queued, waiting, blocked, or paused rows into running');
  assert.match(component, /aria-haspopup="dialog"/);
  assert.match(component, /role="dialog" aria-modal="true"/);
  assert.match(component, /event\.key === 'Escape'/);
  assert.match(component, /entries\.length === 0 && open[\s\S]*composerRef\?\.current\?\.focus\(\)/,
    'an auto-empty sheet focuses the adjacent composer before its trigger disappears');
  assert.match(component, /const expandable = hasExpandableTaskFacts\(entry\)/);
  assert.match(component, /const expanded = expandable && selected === entry\.runKey/,
    'a facts-free row retained an empty expanded container for one render');
  assert.match(component, /\{expandable \? \([\s\S]*class="running-task-open"[\s\S]*\) : null\}/,
    'a no-facts row rendered a no-op Open/Review button');
  assert.doesNotMatch(component, /getWorkflowRunEvents|buildWorkflowRunDetail|WorkflowSteps|MAX_VISIBLE_STEPS/,
    'foreground chat fetched raw workflow events or rendered a secondary detail path');

  // The dock is gone (owner directive 2026-08-25): the trigger is a compact
  // HEADER chip, mounted once in the shell header so running work stays
  // reachable from every screen and nothing floats at the bottom any more.
  const appShell = readFileSync(new URL('../app.tsx', import.meta.url), 'utf8');
  assert.match(appShell, /class="meta"[\s\S]*?<RunningTasksSheet[^>]*\/>/,
    'the running-tasks chip lives in the sticky header, not a bottom float');
  assert.match(appShell, /<RunningTasksSheet onOpenRun=\{openRun\}/,
    'a run listed in the sheet must open the run, not only expand in place');
  // Presenter contract: the chip exists ONLY while view.total > 0 — the
  // pill disappearing at zero is pinned behavior.
  assert.match(component, /if \(view\.total === 0\) return null/);

  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.running-tasks-trigger \{[\s\S]*?min-height: 44px/);
  assert.match(css, /\.running-tasks-close \{[\s\S]*?width: 44px;[\s\S]*?height: 44px/);
  assert.match(css, /\.running-task-open \{[\s\S]*?min-height: 44px/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.running-tasks-list \{[\s\S]*?overflow-y: auto;[\s\S]*?overscroll-behavior: contain/);
});
