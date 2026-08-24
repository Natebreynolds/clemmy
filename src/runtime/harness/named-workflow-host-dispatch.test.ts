import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-named-wf-dispatch-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { writeWorkflow } = await import('../../memory/workflow-store.js');
const { WORKFLOWS_DIR } = await import('../../memory/vault.js');
const {
  objectiveExplicitlyNamesWorkflow,
  uniqueEnabledWorkflowMatch,
} = await import('../../tools/named-workflow-match.js');
const { tryHostDispatchNamedWorkflow } = await import('./named-workflow-host-dispatch.js');
const { createSession, appendEvent, resetEventLog } = await import('./eventlog.js');
const { exactOriginDeliveryTargetDigest } = await import('../exact-origin-delivery.js');
const { satisfyNextScheduledWorkflowOccurrence } = await import('../../execution/workflow-scheduler.js');
const { CRON_RUNS_DIR, WORKFLOW_RUNS_DIR } = await import('../../tools/shared.js');
const { readdirSync } = await import('node:fs');

const REPLY_TARGET = { type: 'origin_chat' } as const;

function seedSlackAndFacebook(): void {
  writeWorkflow('team-activity-slack-updates', {
    name: 'Team Activity Slack Updates',
    description: 'Morning team update',
    // Live catalog state: scheduled but still disabled for cron. A uniquely
    // named act ask must still match and dispatch once.
    enabled: false,
    trigger: { schedule: '0 9 * * 1-5', timezone: 'America/Los_Angeles' },
    steps: [{ id: 'post', prompt: 'Post the team update.' }],
  });
  writeWorkflow('scorpion-facebook-trends', {
    name: 'Scorpion Facebook Trends',
    description: 'Daily facebook scrape',
    enabled: true,
    trigger: { schedule: '30 7 * * 1-5', timezone: 'America/Los_Angeles' },
    steps: [{ id: 'scrape', prompt: 'Scrape the official page.' }],
  });
}

test.beforeEach(() => {
  resetEventLog();
  rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  rmSync(path.join(path.dirname(CRON_RUNS_DIR), 'workflow-schedule-state.json'), { force: true });
});

test('uniqueEnabledWorkflowMatch: live early-run phrasing resolves the slack workflow', () => {
  seedSlackAndFacebook();
  const match = uniqueEnabledWorkflowMatch(
    'run my team activity slack update early and skip the 9am one',
  );
  assert.ok(match);
  assert.equal(match?.slug, 'team-activity-slack-updates');
  assert.equal(match?.enabled, false);
  assert.equal(match?.resolutionKind, 'fuzzy');
  const typo = uniqueEnabledWorkflowMatch(
    'can you run my team slack activty update early please and skip it at 9am',
  );
  assert.ok(typo);
  assert.equal(typo?.slug, 'team-activity-slack-updates');
  assert.equal(
    uniqueEnabledWorkflowMatch('scrape their top keywords into a google sheet'),
    null,
  );
});

test('uniqueEnabledWorkflowMatch: sharing one leftover cadence token is not a catalog name', () => {
  writeWorkflow('nightly-digest', {
    name: 'nightly-digest',
    description: 'Nightly digest',
    enabled: true,
    steps: [{ id: 'main', prompt: 'Write the digest.' }],
  });
  seedSlackAndFacebook();
  assert.equal(
    uniqueEnabledWorkflowMatch('please digest these notes into a new sheet'),
    null,
  );
  const named = uniqueEnabledWorkflowMatch('run my nightly digest');
  assert.ok(named);
  assert.equal(named?.slug, 'nightly-digest');
});

test('objectiveExplicitlyNamesWorkflow: requires separator-normalized workflow adjacency', () => {
  const objective =
    'Read only the frontmatter for workflow platform-49-slack-channel-review, '
    + 'then return only its schedule and timezone.';
  assert.equal(
    objectiveExplicitlyNamesWorkflow(objective, 'platform-49-slack-channel-review'),
    true,
  );
  assert.equal(
    objectiveExplicitlyNamesWorkflow(
      'Read the workflow named Platform 49 Slack Channel Review.',
      'platform-49-slack-channel-review',
    ),
    true,
  );
  assert.equal(
    objectiveExplicitlyNamesWorkflow(
      'Read the Platform_49 Slack Channel Review workflow.',
      'platform-49-slack-channel-review',
    ),
    false,
    'reverse space-separated names cannot prove their exact starting boundary',
  );
  for (const incidental of ['schedule', 'timezone', 'frontmatter', 'only']) {
    assert.equal(objectiveExplicitlyNamesWorkflow(objective, incidental), false, incidental);
  }
  assert.equal(
    objectiveExplicitlyNamesWorkflow(objective, 'platform-49'),
    false,
    'a catalog prefix is not the explicitly named workflow',
  );
  assert.equal(
    objectiveExplicitlyNamesWorkflow(
      'Read workflow Platform 49 Slack Channel Review.',
      'platform-49',
    ),
    false,
    'a space-separated catalog prefix is not the explicitly named workflow',
  );
  for (const conjunction of ['with', 'and']) {
    assert.equal(
      objectiveExplicitlyNamesWorkflow(
        `Read workflow Platform 49 ${conjunction} Slack Channel Review.`,
        'platform-49',
      ),
      false,
      `${conjunction} cannot prove where the workflow identity ended`,
    );
  }
  assert.equal(
    objectiveExplicitlyNamesWorkflow(
      'Read the platform-49-slack-channel-review workflow.',
      'slack-channel-review',
    ),
    false,
    'a catalog suffix is not the explicitly named workflow',
  );
});

test('tryHostDispatchNamedWorkflow: an exact name is still not execution authority', () => {
  seedSlackAndFacebook();
  writeWorkflow('team-activity-slack-updates', {
    name: 'Team Activity Slack Updates',
    description: 'Morning team update',
    enabled: true,
    trigger: { schedule: '0 9 * * 1-5', timezone: 'America/Los_Angeles' },
    steps: [{ id: 'post', prompt: 'Post the team update.' }],
  });
  const session = createSession({ kind: 'chat', channel: 'desktop' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Team Activity Slack Updates',
      originReplyTarget: REPLY_TARGET,
      originReplyTargetDigest: exactOriginDeliveryTargetDigest(REPLY_TARGET),
    },
  });
  const result = tryHostDispatchNamedWorkflow({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    userText: String(source.data.text),
    route: 'act',
  });
  assert.deepEqual(result, {
    status: 'not_applicable',
    reason: 'typed_workflow_authority_required',
  });
  const runs = existsSync(WORKFLOW_RUNS_DIR)
    ? readdirSync(WORKFLOW_RUNS_DIR).filter((name) => name.endsWith('.json'))
    : [];
  assert.equal(runs.length, 0, 'matching a mutable catalog name never queues work');
  assert.equal(
    existsSync(path.join(path.dirname(CRON_RUNS_DIR), 'workflow-schedule-state.json')),
    false,
    'an ordinary manual run does not silently satisfy the next cron occurrence',
  );
});

test('tryHostDispatchNamedWorkflow: fuzzy and management phrasing never authorizes RUN', () => {
  seedSlackAndFacebook();
  for (const text of [
    'run my team activity slack updates workflow',
    'delete my team activity slack updates workflow',
    'disable team activity slack updates',
    'reschedule team activity slack updates to 10am',
    'post a new team activity Slack update about today',
  ]) {
    const session = createSession({ kind: 'chat', channel: 'desktop' });
    const source = appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: {
        text,
        originReplyTarget: REPLY_TARGET,
        originReplyTargetDigest: exactOriginDeliveryTargetDigest(REPLY_TARGET),
      },
    });
    const result = tryHostDispatchNamedWorkflow({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      userText: text,
      route: 'act',
    });
    assert.equal(result.status, 'not_applicable', text);
  }
  assert.equal(
    existsSync(WORKFLOW_RUNS_DIR)
      ? readdirSync(WORKFLOW_RUNS_DIR).filter((name) => name.endsWith('.json')).length
      : 0,
    0,
  );
});

test('tryHostDispatchNamedWorkflow: a counted set into one sheet is not a named workflow', () => {
  seedSlackAndFacebook();
  const session = createSession({ kind: 'chat', channel: 'desktop' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'find me the top 5 competitors to Acme and their facebook page links and put them on a new google sheet',
      originReplyTarget: REPLY_TARGET,
      originReplyTargetDigest: exactOriginDeliveryTargetDigest(REPLY_TARGET),
    },
  });
  const result = tryHostDispatchNamedWorkflow({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    userText: String(source.data.text),
    route: 'act',
  });
  assert.equal(result.status, 'not_applicable');
  if (result.status === 'not_applicable') {
    assert.equal(result.reason, 'typed_workflow_authority_required');
  }
  assert.equal(
    existsSync(WORKFLOW_RUNS_DIR)
      ? readdirSync(WORKFLOW_RUNS_DIR).filter((name) => name.endsWith('.json')).length
      : 0,
    0,
  );
});

test('tryHostDispatchNamedWorkflow: a complete typed authority still does not re-enable the lexical shortcut', () => {
  seedSlackAndFacebook();
  const session = createSession({ kind: 'chat', channel: 'desktop' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Team Activity Slack Updates',
      originReplyTarget: REPLY_TARGET,
      originReplyTargetDigest: exactOriginDeliveryTargetDigest(REPLY_TARGET),
    },
  });
  const result = tryHostDispatchNamedWorkflow({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    userText: String(source.data.text),
    route: 'act',
    authority: {
      version: 1,
      action: 'run',
      workflowId: 'team-activity-slack-updates',
      workflowSlug: 'team-activity-slack-updates',
      definitionDigest: 'a'.repeat(64),
      definitionVersion: '1',
      normalizedInputsDigest: 'b'.repeat(64),
      effectSummary: 'none',
      acceptedGoal: { goalId: 'goal-1', revision: 1 },
      suppressSchedule: false,
    },
  });
  assert.deepEqual(result, {
    status: 'not_applicable',
    reason: 'graph_executor_owns_run_existing_workflow',
  });
  const runs = existsSync(WORKFLOW_RUNS_DIR)
    ? readdirSync(WORKFLOW_RUNS_DIR).filter((name) => name.endsWith('.json'))
    : [];
  assert.equal(runs.length, 0);
});

test('tryHostDispatchNamedWorkflow: retrieve/inspect does not queue', () => {
  seedSlackAndFacebook();
  const session = createSession({ kind: 'chat', channel: 'desktop' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'what is in my team activity slack update workflow',
      originReplyTarget: REPLY_TARGET,
      originReplyTargetDigest: exactOriginDeliveryTargetDigest(REPLY_TARGET),
    },
  });
  const result = tryHostDispatchNamedWorkflow({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    userText: String(source.data.text),
    route: 'retrieve',
  });
  assert.equal(result.status, 'not_applicable');
  if (result.status === 'not_applicable') {
    assert.equal(result.reason, 'compiled_route_is_not_act');
  }
});

test('satisfyNextScheduledWorkflowOccurrence: 07:27 marks today 09:00 handled and leaves tomorrow open', () => {
  writeWorkflow('team-activity-slack-updates', {
    name: 'Team Activity Slack Updates',
    description: 'Morning team update',
    enabled: true,
    trigger: { schedule: '0 9 * * 1-5' },
    steps: [{ id: 'post', prompt: 'Post the team update.' }],
  });
  const at727 = new Date(2026, 7, 14, 7, 27, 0);
  const result = satisfyNextScheduledWorkflowOccurrence('team-activity-slack-updates', at727);
  assert.equal(result.satisfied, true);
  assert.ok(result.atMs);
  const nineAm = new Date(2026, 7, 14, 9, 0, 0).getTime();
  assert.equal(result.atMs, nineAm);

  const again = satisfyNextScheduledWorkflowOccurrence('team-activity-slack-updates', at727);
  assert.equal(again.satisfied, false, 'the same slot must not be rewritten');

  const afterNine = satisfyNextScheduledWorkflowOccurrence(
    'team-activity-slack-updates',
    new Date(2026, 7, 14, 10, 0, 0),
  );
  assert.equal(afterNine.satisfied, false, 'tomorrow must stay pending');
});
