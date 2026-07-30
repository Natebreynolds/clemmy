/**
 * Run: npx tsx --test src/execution/cli-auth-recovery.test.ts
 *
 * Pins for the auth-recovery resume path — the piece that turns "the user
 * signed in again" into parked work actually continuing.
 *
 * The blast-radius contract is the point of these pins: ONLY tasks
 * carrying the structured blockedOnCli tag resume; a task that merely
 * mentions the CLI in its question text stays parked (it may be waiting
 * on real human input); and resumes are capped per event.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-cli-auth-recovery-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  createBackgroundTask,
  markBackgroundTaskAwaitingInput,
  listBackgroundTasks,
  getBackgroundTask,
  detectBlockedOnCli,
} = await import('./background-tasks.js');
const { recordConnectedCli, findCatalogEntry } = await import('../integrations/cli-catalog/catalog.js');
const { getCliHealth, invalidateCliHealth, _testOnly_setProbeExec } = await import('../integrations/cli-catalog/auth-health.js');
const { registerCliAuthRecoverySweep } = await import('./cli-auth-recovery.js');

// The roster: railway is connected (catalog entry with a probe).
recordConnectedCli(findCatalogEntry('railway')!);

function parkTask(title: string, blockerReason: string | undefined, question: string): { id: string; questionId: string } {
  const task = createBackgroundTask({ title, prompt: `work for ${title}` });
  const questionId = `q-${task.id}`;
  const parked = markBackgroundTaskAwaitingInput(task.id, questionId, question, {
    blockerType: 'permission',
    blockerReason,
  });
  assert.ok(parked, `task ${title} must park`);
  return { id: task.id, questionId };
}

test('detectBlockedOnCli: roster-bounded, permission-only, word-boundary', () => {
  const roster = ['railway', 'gh'];
  assert.equal(detectBlockedOnCli('permission', 'railway whoami returned Unauthorized (401)', roster), 'railway');
  assert.equal(detectBlockedOnCli('permission', 'gh auth status: token invalid', roster), 'gh');
  assert.equal(detectBlockedOnCli('needs_user_input', 'railway is signed out', roster), undefined,
    'only permission-classified blockers qualify');
  assert.equal(detectBlockedOnCli('permission', 'the railways were blocked', roster), undefined,
    'word-boundary: substrings of prose never match');
  assert.equal(detectBlockedOnCli('permission', 'vercel token expired', roster), undefined,
    'a CLI outside the roster can never mint a tag');
});

test('recovery resumes ONLY tagged tasks, caps per event, and leaves text-mention tasks parked', async () => {
  registerCliAuthRecoverySweep();

  // Six tagged tasks (cap is 5) + one untagged that merely mentions railway.
  const tagged = Array.from({ length: 6 }, (_, i) =>
    parkTask(`tagged-${i}`, 'railway CLI returned Unauthorized — re-authenticate to continue', 'Sign in to railway, then reply continue.'));
  const untagged = parkTask('untagged-mention', undefined, 'Should I deploy to railway production or staging?');

  for (const t of tagged) {
    assert.equal(getBackgroundTask(t.id)?.blockedOnCli, 'railway', 'park path stamps the structured tag');
  }
  assert.equal(getBackgroundTask(untagged.id)?.blockedOnCli, undefined,
    'no blockerReason naming the CLI → no tag, even though the question mentions railway');

  // Drive a REAL signed_out→ok transition through the health engine.
  let output = 'Unauthorized. Please login with `railway login`';
  _testOnly_setProbeExec(async () => ({ exitCode: output.startsWith('Unauthorized') ? 1 : 0, output, timedOut: false }));
  await getCliHealth('railway', { force: true });

  output = 'Logged in as nathan@example.com 👋';
  invalidateCliHealth('railway');
  await getCliHealth('railway', { force: true });
  // The sweep is async fire-and-forget off the event; give it a beat.
  await new Promise((resolve) => setTimeout(resolve, 250));
  _testOnly_setProbeExec();

  const byId = new Map(listBackgroundTasks({}).map((task) => [task.id, task]));
  const resumedCount = tagged.filter((t) => byId.get(t.id)?.status === 'pending').length;
  assert.equal(resumedCount, 5, `cap: exactly 5 of 6 tagged tasks resume (got ${resumedCount})`);
  assert.equal(byId.get(untagged.id)?.status, 'awaiting_input',
    'a text-mention task without the tag stays parked — it may need real human input');

  const resumedTask = tagged.map((t) => byId.get(t.id)).find((task) => task?.status === 'pending');
  assert.ok(resumedTask?.inputResolution?.answer.includes('signed in again'),
    'resume goes through the canonical input-resolution verb with a truthful answer');
});

test('signed-out transitions notify once per day for roster CLIs; unreferenced CLIs stay pill-only', async () => {
  const { loadNotifications } = await import('../runtime/notifications.js');
  const countCliAuth = (id) => loadNotifications().filter((n) => n.id.startsWith(`cli-auth-${id}-`)).length;

  // railway is CONNECTED (roster) — a signed-out transition notifies.
  let output = 'Logged in as nathan@example.com';
  _testOnly_setProbeExec(async () => ({ exitCode: output.startsWith('Logged') ? 0 : 1, output, timedOut: false }));
  invalidateCliHealth('railway');
  await getCliHealth('railway', { force: true }); // ok baseline

  output = 'Unauthorized. Please login with `railway login`';
  invalidateCliHealth('railway');
  await getCliHealth('railway', { force: true }); // → signed_out (transition)
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(countCliAuth('railway'), 1, 'the transition into signed_out notifies exactly once');

  // A signed_out re-probe is NOT a transition — no second record; and even a
  // flap (ok → signed_out again) the same day collides on the daily id.
  invalidateCliHealth('railway');
  await getCliHealth('railway', { force: true });
  output = 'Logged in as nathan@example.com';
  invalidateCliHealth('railway');
  await getCliHealth('railway', { force: true });
  output = 'Unauthorized. Please login with `railway login`';
  invalidateCliHealth('railway');
  await getCliHealth('railway', { force: true });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(countCliAuth('railway'), 1, 'same-day flaps collapse onto one daily-bucketed record');

  // gcloud is NOT connected here and no parked task references it → pill only.
  output = '[]';
  invalidateCliHealth('gcloud');
  const before = loadNotifications().length;
  await getCliHealth('gcloud', { force: true });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(countCliAuth('gcloud'), 0, 'an unreferenced CLI never notifies');
  assert.equal(loadNotifications().length >= before, true);
  _testOnly_setProbeExec();
});
