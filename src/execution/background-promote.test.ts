/**
 * Run: npx tsx --test src/execution/background-promote.test.ts
 *
 * Covers the C1 durable-promotion decision + enqueue shared by the desktop
 * dock, Discord harness, and the gateway:
 *   - hasDurableExecutionIntent fires ONLY on explicit user intent
 *   - stripBackgroundPrefix removes a leading /background command
 *   - enqueueDurableChatTask creates a pending durable task wired for
 *     report-back (originSessionId) with the stripped prompt + derived title
 *   - renderDurableTaskQueued tells the user the three trust-earning facts
 *
 * Per-test temp dir via CLEMENTINE_HOME so we don't touch real state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-bgpromote-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  hasDurableExecutionIntent,
  stripBackgroundPrefix,
  shouldPromoteToDurable,
  enqueueDurableChatTask,
  renderDurableTaskQueued,
} = await import('./background-promote.js');
const { getBackgroundTask, listBackgroundTasks } = await import('./background-tasks.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('hasDurableExecutionIntent fires only on explicit durable intent', () => {
  // Explicit intent → promote.
  assert.equal(hasDurableExecutionIntent('/background build the site'), true);
  assert.equal(hasDurableExecutionIntent('bg: refactor the auth module'), true);
  assert.equal(hasDurableExecutionIntent('run this in the background'), true);
  assert.equal(hasDurableExecutionIntent('keep working until the audit is done'), true);
  assert.equal(hasDurableExecutionIntent("don't stop until it's shipped"), true);
  assert.equal(hasDurableExecutionIntent('take your time and get it right'), true);
  assert.equal(hasDurableExecutionIntent('queue this overnight'), true);
  assert.equal(hasDurableExecutionIntent('build the landing page end to end'), true);

  // No explicit intent → stay foreground. "build me a site" alone must NOT
  // promote (that's the conservative-by-design contract; v2 may offer it).
  assert.equal(hasDurableExecutionIntent('build me a site'), false);
  assert.equal(hasDurableExecutionIntent('what is the weather today?'), false);
  assert.equal(hasDurableExecutionIntent('summarize this email'), false);
  assert.equal(hasDurableExecutionIntent('end to end encryption — how does it work?'), false); // no build verb
});

test('shouldPromoteToDurable requires intent AND a non-empty instruction', () => {
  // Real durable asks promote.
  assert.equal(shouldPromoteToDurable('/background build the site'), true);
  assert.equal(shouldPromoteToDurable('keep working until the audit is done'), true);
  // A bare command with no task must NOT queue a content-free worker.
  assert.equal(shouldPromoteToDurable('/background'), false);
  assert.equal(shouldPromoteToDurable('bg:'), false);
  assert.equal(shouldPromoteToDurable('  /bg   '), false);
  // No intent → never promote.
  assert.equal(shouldPromoteToDurable('build me a site'), false);
});

test('stripBackgroundPrefix removes a leading background command only', () => {
  assert.equal(stripBackgroundPrefix('/background build the site'), 'build the site');
  assert.equal(stripBackgroundPrefix('bg: refactor auth'), 'refactor auth');
  assert.equal(stripBackgroundPrefix('build the site'), 'build the site');
  // A non-leading "background" word is preserved.
  assert.equal(stripBackgroundPrefix('explain the background of this case'), 'explain the background of this case');
});

test('enqueueDurableChatTask creates a pending durable task wired for report-back', () => {
  const before = listBackgroundTasks().length;
  const task = enqueueDurableChatTask({
    message: '/background build the Aldous Reeve law firm homepage and deploy it',
    sessionId: 'sess-desktop-123',
    channel: 'desktop',
    source: 'desktop',
  });

  // Persisted + pending so the daemon picks it up.
  const stored = getBackgroundTask(task.id);
  assert.ok(stored, 'task should be persisted to the durable store');
  assert.equal(stored!.status, 'pending');
  assert.equal(listBackgroundTasks().length, before + 1);

  // Report-back wiring: the originating session is captured (this is the whole
  // point — the result re-enters THIS chat on completion).
  assert.equal(stored!.originSessionId, 'sess-desktop-123');
  assert.equal(stored!.source, 'desktop');
  assert.equal(stored!.channel, 'desktop');

  // The /background prefix is stripped from the worker prompt + title.
  assert.equal(stored!.prompt, 'build the Aldous Reeve law firm homepage and deploy it');
  assert.ok(!/^\/?background/i.test(stored!.title), 'title should not carry the command prefix');
  assert.ok(stored!.title.length > 0 && stored!.title.length <= 120);

  // A worker session distinct from the origin chat.
  assert.equal(stored!.runSessionId, `background:${task.id}`);
  // Default model + a sane durable budget from policy.
  assert.ok(stored!.model, 'a worker model should be set by default');
  assert.ok(stored!.maxMinutes >= 1 && stored!.maxMinutes <= 240);
});

test('renderDurableTaskQueued states the three trust-earning facts', () => {
  const msg = renderDurableTaskQueued({ id: 'bg-abc', title: 'Build the homepage' });
  assert.match(msg, /Build the homepage/);
  assert.match(msg, /background task/i);
  assert.match(msg, /Tasks board/i);
  // Survives a close/restart + reports back here.
  assert.match(msg, /close this window|restart/i);
  assert.match(msg, /report back/i);
});
