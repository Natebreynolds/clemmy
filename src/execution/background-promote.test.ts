/**
 * Run: npx tsx --test src/execution/background-promote.test.ts
 *
 * Covers the C1 durable-promotion decision + enqueue shared by the desktop
 * dock, Discord harness, and the gateway:
 *   - hasDurableExecutionIntent fires on explicit user intent OR a high-confidence
 *     unattended data-pipeline shape
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
  detectBackgroundItIntent,
  detachRunningTurnToBackground,
} = await import('./background-promote.js');
const { getBackgroundTask, listBackgroundTasks } = await import('./background-tasks.js');
const { createSession, appendEvent } = await import('../runtime/harness/eventlog.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('hasDurableExecutionIntent fires on explicit durable intent and broad data pipelines', () => {
  // Explicit intent → promote.
  assert.equal(hasDurableExecutionIntent('/background build the site'), true);
  assert.equal(hasDurableExecutionIntent('bg: refactor the auth module'), true);
  assert.equal(hasDurableExecutionIntent('run this in the background'), true);
  assert.equal(hasDurableExecutionIntent('move this to the background. Read the workspace files.'), true);
  assert.equal(hasDurableExecutionIntent('please send this to the background: audit the repo'), true);
  assert.equal(hasDurableExecutionIntent('keep working until the audit is done'), true);
  assert.equal(hasDurableExecutionIntent("don't stop until it's shipped"), true);
  assert.equal(hasDurableExecutionIntent('take your time and get it right'), true);
  assert.equal(hasDurableExecutionIntent('queue this overnight'), true);
  assert.equal(hasDurableExecutionIntent('build the landing page end to end'), true);

  // High-confidence unattended pipeline → promote without forcing the user to
  // say "background" explicitly.
  assert.equal(
    hasDurableExecutionIntent(
      'Pull full data from Salesforce via the CLI, then scrape all of it with Apify MCP, run subagents for 5 different actors including Google reviews, SEO data, and lead info, then add the results to my Airtable CRM via MCP.',
    ),
    true,
  );
  assert.equal(
    hasDurableExecutionIntent('Pull every Salesforce account, enrich each with Google reviews and SEO data, then write the leads to Airtable CRM.'),
    true,
  );

  // No durable/background intent → stay foreground.
  assert.equal(hasDurableExecutionIntent('build me a site'), false);
  assert.equal(hasDurableExecutionIntent('what is the weather today?'), false);
  assert.equal(hasDurableExecutionIntent('summarize this email'), false);
  assert.equal(hasDurableExecutionIntent('end to end encryption — how does it work?'), false); // no build verb
  assert.equal(hasDurableExecutionIntent('research Salesforce and Airtable integration options'), false);
  assert.equal(hasDurableExecutionIntent('pull 5 salesforce accounts for me please just as a test'), false);
});

test('shouldPromoteToDurable requires intent AND a non-empty instruction', () => {
  // Real durable asks promote.
  assert.equal(shouldPromoteToDurable('/background build the site'), true);
  assert.equal(shouldPromoteToDurable('move this to the background. Read the workspace files.'), true);
  assert.equal(shouldPromoteToDurable('Live validation only: move this to the background. Read the top-level files.'), true);
  assert.equal(shouldPromoteToDurable('keep working until the audit is done'), true);
  assert.equal(
    shouldPromoteToDurable('Pull all Salesforce leads, enrich them through Apify and Google reviews, then sync the cleaned records into Airtable.'),
    true,
  );
  // A bare command with no task must NOT queue a content-free worker.
  assert.equal(shouldPromoteToDurable('/background'), false);
  assert.equal(shouldPromoteToDurable('bg:'), false);
  assert.equal(shouldPromoteToDurable('  /bg   '), false);
  assert.equal(shouldPromoteToDurable('move this to the background'), false);
  // No intent → never promote.
  assert.equal(shouldPromoteToDurable('build me a site'), false);
});

test('stripBackgroundPrefix removes a leading background command only', () => {
  assert.equal(stripBackgroundPrefix('/background build the site'), 'build the site');
  assert.equal(stripBackgroundPrefix('bg: refactor auth'), 'refactor auth');
  assert.equal(stripBackgroundPrefix('move this to the background. Read the workspace files.'), 'Read the workspace files.');
  assert.equal(stripBackgroundPrefix('Live validation only: move this to the background. Read the top-level files.'), 'Read the top-level files.');
  assert.equal(stripBackgroundPrefix('please send this to the background: audit the repo'), 'audit the repo');
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

// ── Inc A4: user-initiated "background it" control ───────────────────────────

test('detectBackgroundItIntent: matches the imperative forms, ignores normal mentions', () => {
  for (const yes of [
    'background it', 'Background it.', 'run it in the background', 'take it to the background',
    'move this to the background', 'do it in the background', 'finish it in the background',
    '/background it', 'send it to the background',
  ]) assert.equal(detectBackgroundItIntent(yes), true, `should match: ${yes}`);
  for (const no of [
    'what is running in the background?', 'tell me about background tasks',
    'the background color should be blue', 'run a background check on this company',
    'hello', 'background',
  ]) assert.equal(detectBackgroundItIntent(no), false, `should NOT match: ${no}`);
});

test('detachRunningTurnToBackground: stops the run + enqueues a goal-bound resume task from the recent objective', () => {
  const sess = createSession({ kind: 'chat' });
  appendEvent({ sessionId: sess.id, turn: 0, role: 'user', type: 'user_input_received', data: { text: 'scrape 100 net-new Salesforce accounts similar to my customers' } });
  // a later background-it message must NOT be picked as the objective
  appendEvent({ sessionId: sess.id, turn: 0, role: 'user', type: 'user_input_received', data: { text: 'background it' } });
  const before = listBackgroundTasks().length;
  const res = detachRunningTurnToBackground(sess.id);
  assert.ok(res, 'returns a result');
  assert.equal(res!.handled, true);
  assert.match(res!.text, /background/i);
  const tasks = listBackgroundTasks();
  assert.equal(tasks.length, before + 1, 'one background task enqueued');
  const task = getBackgroundTask(res!.taskId);
  assert.ok(task);
  assert.match(task!.prompt, /scrape 100 net-new Salesforce accounts/, 'objective = the recent real request, not "background it"');
  assert.match(task!.prompt, /session_history/, 'prompt tells it to resume from recorded progress');
  assert.equal(task!.originSessionId, sess.id, 'reports back to the originating chat');
});

test('detachRunningTurnToBackground: null when there is nothing to background', () => {
  const sess = createSession({ kind: 'chat' });
  assert.equal(detachRunningTurnToBackground(sess.id), null, 'no objective → null (caller treats as a normal turn)');
});
