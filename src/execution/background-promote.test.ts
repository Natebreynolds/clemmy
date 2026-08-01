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
  hasForegroundWatchIntent,
  isSpaceSession,
  isContinuationDirective,
  stripBackgroundPrefix,
  shouldPromoteToDurable,
  enqueueDurableChatTask,
  renderDurableTaskQueued,
  detectBackgroundItIntent,
  detachRunningTurnToBackground,
  resolveBackgroundableObjective,
} = await import('./background-promote.js');
const { createDirectGoal } = await import('../agents/plan-proposals.js');
const { getBackgroundTask, listBackgroundTasks } = await import('./background-tasks.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const {
  createSession,
  appendEvent,
  beginRunAttempt,
  finishRunAttempt,
  getActiveRunAttempt,
  isKillRequested,
  recordRunAttemptUserInput,
} = await import('../runtime/harness/eventlog.js');

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
  assert.equal(hasDurableExecutionIntent('Please summarize this transcript in the background.'), true);
  assert.equal(
    hasDurableExecutionIntent([
      'Please summarize this captured meeting for me, then ask what I want you to act on from it.',
      'Important rules: read the full transcript end-to-end before summarizing.',
      'Existing machine summary for context only:',
      'The firm has several large, long-running matters and needs stronger online visibility.',
    ].join('\n')),
    false,
    'embedded meeting content must not be mistaken for a long-running-task directive',
  );
  assert.equal(hasDurableExecutionIntent('end to end encryption — how does it work?'), false); // no build verb
  assert.equal(hasDurableExecutionIntent('research Salesforce and Airtable integration options'), false);
  assert.equal(hasDurableExecutionIntent('pull 5 salesforce accounts for me please just as a test'), false);
  assert.equal(
    hasDurableExecutionIntent('Reply exactly HOTPATCH_SMOKE_OK. Do not call tools, send messages, modify files, or start background tasks.'),
    false,
  );
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
  assert.equal(
    shouldPromoteToDurable('Reply exactly HOTPATCH_SMOKE_OK. Do not call tools, send messages, modify files, or start background tasks.'),
    false,
  );
  // No intent → never promote.
  assert.equal(shouldPromoteToDurable('build me a site'), false);
  assert.equal(
    shouldPromoteToDurable('Please discuss this transcript. The client described several long-running matters.'),
    false,
  );
});

test('foreground watch intent vetoes soft durable phrasing but not explicit background directives', () => {
  // Live 2026-07-23: this exact Workspace-chat message was promoted to a
  // durable task on the "keep working" trigger despite "here … ill watch".
  assert.equal(
    hasDurableExecutionIntent('you can keep working on it here please and ill watch the updates happen as you make them'),
    false,
  );
  assert.equal(hasDurableExecutionIntent('keep working on it here'), false);
  assert.equal(hasDurableExecutionIntent("keep going and I'll watch the changes as you go"), false);
  assert.equal(hasDurableExecutionIntent('take your time, I want to see it in real time'), false);
  // The explicit lane always wins — even next to watch language.
  assert.equal(hasDurableExecutionIntent("keep working on it in the background and I'll watch for the report"), true);
  // Soft phrasing WITHOUT watch intent still promotes (unchanged behavior).
  assert.equal(hasDurableExecutionIntent('keep working until the audit is done'), true);
  assert.equal(hasForegroundWatchIntent('ill watch the updates happen'), true);
  assert.equal(hasForegroundWatchIntent('run the enrichment overnight'), false);
});

test('space sessions promote only on an explicit background directive', () => {
  assert.equal(isSpaceSession('space-james-english-pipeline'), true);
  assert.equal(isSpaceSession('sess-abc123'), false);
  assert.equal(isSpaceSession(undefined), false);
  const spaceOpts = { sessionId: 'space-james-english-pipeline' };
  // Soft durable phrasing and pipeline shape stay foreground in a space.
  assert.equal(shouldPromoteToDurable('keep working until the audit is done', spaceOpts), false);
  assert.equal(shouldPromoteToDurable("don't stop until it's shipped", spaceOpts), false);
  assert.equal(
    shouldPromoteToDurable('Pull all Salesforce leads, enrich them through Apify and Google reviews, then sync the cleaned records into Airtable.', spaceOpts),
    false,
  );
  // The user naming the lane still wins — they own the designation.
  assert.equal(shouldPromoteToDurable('/background rebuild the coaching tab', spaceOpts), true);
  assert.equal(shouldPromoteToDurable('run this in the background: refresh all the feeds', spaceOpts), true);
  // Non-space sessions are unchanged.
  assert.equal(shouldPromoteToDurable('keep working until the audit is done', { sessionId: 'sess-abc123' }), true);
});

test('isContinuationDirective spots directives that continue existing work', () => {
  assert.equal(isContinuationDirective('keep working on it please'), true);
  assert.equal(isContinuationDirective('carry on with the edits'), true);
  assert.equal(isContinuationDirective('finish this'), true);
  assert.equal(isContinuationDirective('build me a rep scorecard dashboard'), false);
  assert.equal(isContinuationDirective('research SEO options for the firm'), false);
});

test('continuation promotions title from the active goal, not the raw chat message', () => {
  const sessionId = 'sess-title-fallback-test';
  const goal = createDirectGoal({
    objective: 'Rebuild the pipeline command center with rep scorecards',
    sessionId,
  });
  assert.ok(goal, 'direct goal should activate');
  const task = enqueueDurableChatTask({
    message: "keep working on it, don't stop until it's finished",
    sessionId,
    channel: 'desktop',
    source: 'desktop',
  });
  assert.match(task.title, /pipeline command center/i);
  // A message that names its own objective keeps its own title.
  const named = enqueueDurableChatTask({
    message: 'run this in the background: audit the coaching notes tab',
    sessionId,
    channel: 'desktop',
    source: 'desktop',
  });
  assert.match(named.title, /coaching notes/i);
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
    message: '/background build the Sample Law Partners law firm homepage and deploy it',
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
  assert.equal(stored!.prompt, 'build the Sample Law Partners law firm homepage and deploy it');
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
  const attempt = beginRunAttempt(sess.id, { runId: 'desktop:background-handoff' });
  const source = recordRunAttemptUserInput(attempt, {
    turn: 0,
    role: 'user',
    data: { text: 'scrape 100 net-new Salesforce accounts similar to my customers' },
  });
  // a later background-it message must NOT be picked as the objective
  appendEvent({ sessionId: sess.id, turn: 0, role: 'user', type: 'user_input_received', data: { text: 'background it' } });
  const before = listBackgroundTasks().length;
  const res = detachRunningTurnToBackground(sess.id, attempt, {
    source: 'discord',
    channel: 'discord:test-channel',
    userId: 'user-1',
  });
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
  assert.equal(task!.source, 'discord', 'handoff preserves its real surface');
  assert.equal(task!.channel, 'discord:test-channel');
  assert.equal(task!.userId, 'user-1');
  assert.equal(task!.foregroundHandoff?.attemptId, attempt.attemptId);
  assert.equal(task!.foregroundHandoff?.sourceUserSeq, source.seq);
  assert.ok((task!.foregroundHandoff?.throughSeq ?? 0) >= source.seq);
  assert.equal(isKillRequested(sess.id, attempt), true, 'only the exact foreground attempt is stopped');
});

test('detachRunningTurnToBackground: null when there is nothing to background', () => {
  const sess = createSession({ kind: 'chat' });
  assert.equal(
    detachRunningTurnToBackground(sess.id, { attemptId: 'attempt-does-not-exist' }),
    null,
    'no exact active attempt → null',
  );
});

test('detachRunningTurnToBackground: refuses to clone a turn with an actionable approval', () => {
  const sess = createSession({ kind: 'chat' });
  const attempt = beginRunAttempt(sess.id, { runId: 'desktop:approval-blocked-handoff' });
  recordRunAttemptUserInput(attempt, {
    turn: 0,
    role: 'user',
    data: { text: 'send the approved client update' },
  });
  const approval = approvalRegistry.register({
    sessionId: sess.id,
    subject: 'Send the client update',
    tool: 'OUTLOOK_SEND_EMAIL',
    args: { to: 'client@example.com' },
  });
  const before = listBackgroundTasks({ includeArchived: true }).length;
  try {
    assert.equal(detachRunningTurnToBackground(sess.id, attempt), null);
    assert.equal(listBackgroundTasks({ includeArchived: true }).length, before, 'no replacement worker is created');
    assert.equal(isKillRequested(sess.id, attempt), false, 'the paused foreground attempt is left intact');
  } finally {
    approvalRegistry.resolve(approval.approvalId, 'cancelled_by_user', 'test-cleanup');
  }
});

test('detachRunningTurnToBackground: fails closed for an interrupt without a registry row', () => {
  const sess = createSession({ kind: 'chat' });
  const attempt = beginRunAttempt(sess.id, { runId: 'desktop:interrupt-blocked-handoff' });
  recordRunAttemptUserInput(attempt, {
    turn: 0,
    role: 'user',
    data: { text: 'continue the paused provider action' },
  });
  const harnessSession = HarnessSession.load(sess.id);
  assert.ok(harnessSession);
  harnessSession!.saveInterruptState('opaque-pending-run-state');
  const before = listBackgroundTasks({ includeArchived: true }).length;
  try {
    assert.equal(detachRunningTurnToBackground(sess.id, attempt), null);
    assert.equal(listBackgroundTasks({ includeArchived: true }).length, before);
    assert.equal(isKillRequested(sess.id, attempt), false);
  } finally {
    harnessSession!.clearInterruptState({ emitEvent: false });
  }
});

test('detachRunningTurnToBackground: stale A cannot move or kill newer B; replay of B rejoins one task', () => {
  const sess = createSession({ kind: 'chat' });
  const attemptA = beginRunAttempt(sess.id, { runId: 'desktop:handoff-a' });
  recordRunAttemptUserInput(attemptA, {
    turn: 0,
    role: 'user',
    data: { text: 'prepare the first client brief' },
  });
  finishRunAttempt(attemptA, 'completed');

  const attemptB = beginRunAttempt(sess.id, { runId: 'desktop:handoff-b' });
  const sourceB = recordRunAttemptUserInput(attemptB, {
    turn: 1,
    role: 'user',
    data: { text: 'prepare the second and different client brief' },
  });
  const before = listBackgroundTasks({ includeArchived: true }).length;

  assert.equal(detachRunningTurnToBackground(sess.id, attemptA), null);
  assert.equal(getActiveRunAttempt(sess.id)?.attemptId, attemptB.attemptId);
  assert.equal(isKillRequested(sess.id, attemptB), false, 'stale A cannot latch B');
  assert.equal(listBackgroundTasks({ includeArchived: true }).length, before);

  const runScopeId = `${sess.id}::brain:${attemptB.runId}`;
  const first = detachRunningTurnToBackground(sess.id, { ...attemptB, runScopeId });
  assert.ok(first);
  assert.equal(first!.replayed, false);
  const replay = detachRunningTurnToBackground(sess.id, { ...attemptB, runScopeId });
  assert.ok(replay);
  assert.equal(replay!.replayed, true);
  assert.equal(replay!.taskId, first!.taskId, 'lost-response replay rejoins the same durable task');
  assert.equal(listBackgroundTasks({ includeArchived: true }).length, before + 1);
  const task = getBackgroundTask(first!.taskId);
  assert.match(task!.prompt, /second and different client brief/);
  assert.equal(task!.foregroundHandoff?.sourceUserSeq, sourceB.seq);
});

test('EVERY durable task is goal-bound at creation — including the auto-promote path (2026-07-08 zero-goal done-with-nothing)', async () => {
  const { enqueueDurableChatTask } = await import('./background-promote.js');
  const { getActiveGoalForSession } = await import('../agents/plan-proposals.js');
  const task = enqueueDurableChatTask({ message: 'pull 10 keyword volumes and write them to a sheet', sessionId: 'sess-goalbind-test', source: 'desktop' });
  const goal = getActiveGoalForSession(task.runSessionId);
  assert.ok(goal, 'a task enqueued with NO explicit goal input must still get a bound goal contract');
  const obj = (goal!.approvedPlan ?? goal!.plan).objective ?? '';
  assert.match(obj, /keyword volumes/i, 'default goal objective derives from the message');
});

// Title/objective truth (live 2026-07-23): a handoff fired by a conversational
// turn ("you can keep working on it here please…") produced a background task
// NAMED after that sentence. When no goal and no execute-phase aligned
// objective exists, the resolver must fall back to the durable work signals —
// the active FOCUS, then the session title — before ever using the utterance.
test('handoff objective prefers focus/session-title over a conversational utterance', async () => {
  const { createFocus } = await import('../memory/focus.js');
  const { createSession, beginRunAttempt, recordRunAttemptUserInput } = await import('../runtime/harness/eventlog.js');
  const sess = createSession({ kind: 'chat', channel: 'desktop', title: 'Reconstruct the 15 missing outreach drafts' });
  const attempt = beginRunAttempt(sess.id, { runId: 'run-title-truth' });
  recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'you can keep working on it here please and ill watch the updates happen' },
  });
  createFocus({
    resourceRef: 'focus-title-truth',
    title: '15 missing outreach drafts',
    summary: 'Reconstructing the July 22 Market Leader emails from verified sources',
  });

  const resolved = resolveBackgroundableObjective(sess.id, attempt);
  assert.ok(resolved, 'objective resolves');
  assert.ok(
    /outreach drafts|Market Leader/i.test(resolved!.objective),
    `objective names the WORK, got: ${resolved!.objective}`,
  );
  assert.ok(
    !/keep working on it here/i.test(resolved!.objective),
    'the conversational utterance never becomes the task name',
  );
});
