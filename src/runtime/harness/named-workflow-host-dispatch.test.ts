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
  uniqueWorkflowRunRequest,
} = await import('../../tools/named-workflow-match.js');
const {
  acceptedSourceIsWorkflowInternal,
  tryHostDispatchNamedWorkflow,
} = await import('./named-workflow-host-dispatch.js');
const { createSession, appendEvent, resetEventLog } = await import('./eventlog.js');
const { exactOriginDeliveryTargetDigest } = await import('../exact-origin-delivery.js');
const { satisfyNextScheduledWorkflowOccurrence } = await import('../../execution/workflow-scheduler.js');
const { renderOutputContractSpec } = await import('../../execution/step-output-verify.js');
const { CRON_RUNS_DIR, WORKFLOW_RUNS_DIR } = await import('../../tools/shared.js');
const { readdirSync, readFileSync } = await import('node:fs');

const REPLY_TARGET = { type: 'origin_chat' } as const;

function workflowRunFileCount(): number {
  return existsSync(WORKFLOW_RUNS_DIR)
    ? readdirSync(WORKFLOW_RUNS_DIR).filter((name) => name.endsWith('.json')).length
    : 0;
}

/**
 * The exact accepted text a workflow step turn runs under: the runner's own
 * header + prompt + the SAME output-contract block the reduce gate verifies
 * + a learned pin (workflow-runner.ts proseMessage). Its body says "run"
 * twice ("a mismatch fails the run:", "proven in a prior run of this step")
 * and its header names the workflow — a unique lexical run request by
 * construction, which is why every contract-bearing step self-dispatched
 * (live 2026-08-31: morning-briefing, weekly-review, daily-standup-email,
 * scorpion, end-of-week).
 */
function workflowStepAcceptedText(workflowSlug: string, stepId: string): string {
  const contractSpec = renderOutputContractSpec({
    type: 'object',
    required_keys: ['official_page_url', 'notes'],
  });
  const pinSpec = '\n\nLEARNED TOOL PIN (proven in a prior run of this step, last validated 2026-08-30): '
    + 'call composio_execute_tool slug "PROVIDER_SEARCH". Try this FIRST; if it fails, adapt or '
    + 'rediscover rather than repeating it blindly.';
  return `Workflow: ${workflowSlug}\nStep: ${stepId}\n\n`
    + 'Find the official Facebook page for the client and capture its URL.'
    + `\n\n${contractSpec}${pinSpec}`;
}

const STEP_SOURCE_DATA = {
  workflowName: 'scorpion-facebook-trends',
  workflowRunId: 'trigger-run-1',
  stepId: 'find_official_page',
  attemptId: 'attempt:workflow:trigger-run-1:find_official_page:1',
} as const;

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

test('uniqueWorkflowRunRequest: an anaphoric run inherits the unique prior accepted identity', () => {
  writeWorkflow('platform-49-slack-channel-review', {
    name: 'Platform 49 Slack Channel Review',
    description: 'Business-hours channel review',
    enabled: true,
    trigger: { schedule: '0 9 * * 1-5', timezone: 'America/Los_Angeles' },
    steps: [{ id: 'post', prompt: 'Post the team update.' }],
  });
  seedSlackAndFacebook();
  const liveFollowUp = 'Can you just run that workflow and get the sheet updated please';
  assert.equal(uniqueWorkflowRunRequest(liveFollowUp), null, 'the follow-up does not name a catalog entry');
  const inherited = uniqueWorkflowRunRequest(liveFollowUp, [
    "What's on my calendar Monday",
    "What's the latest on the platform 49 updates. Anything stand out in terms of request",
  ]);
  assert.ok(inherited);
  assert.equal(inherited?.slug, 'platform-49-slack-channel-review');
  assert.equal(
    uniqueWorkflowRunRequest(liveFollowUp, [
      "What's the latest on the platform 49 updates",
      'Did the team activity slack updates go out?',
    ]),
    null,
    'two prior unique identities stay unclaimed',
  );
  assert.equal(
    uniqueWorkflowRunRequest("What's the latest on the platform 49 updates"),
    null,
    'a retrieve is not a run request',
  );
  const explicit = uniqueWorkflowRunRequest('Run my platform 49 workflow please', [
    'run my team activity slack updates',
  ]);
  assert.ok(explicit);
  assert.equal(explicit?.slug, 'platform-49-slack-channel-review', 'an explicit current name wins over priors');
});

test('uniqueEnabledWorkflowMatch: spoken "platform 49 workflow" uniquely matches the numbered slug', () => {
  writeWorkflow('platform-49-slack-channel-review', {
    name: 'Platform 49 Slack Channel Review',
    description: 'Business-hours channel review',
    enabled: true,
    trigger: { schedule: '0 9 * * 1-5', timezone: 'America/Los_Angeles' },
    steps: [{ id: 'post', prompt: 'Post the team update.' }],
  });
  seedSlackAndFacebook();
  const match = uniqueEnabledWorkflowMatch('Can you run my platform 49 workflow');
  assert.ok(match);
  assert.equal(match?.slug, 'platform-49-slack-channel-review');
  assert.equal(match?.resolutionKind, 'fuzzy');
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

test('tryHostDispatchNamedWorkflow: a unique run request on a disabled workflow does not queue', () => {
  seedSlackAndFacebook();
  const session = createSession({ kind: 'chat', channel: 'desktop' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'run my team activity slack updates workflow',
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
  assert.equal(result.status, 'blocked');
  if (result.status === 'blocked') {
    assert.equal(result.reason, 'disabled');
  }
  assert.equal(
    existsSync(WORKFLOW_RUNS_DIR)
      ? readdirSync(WORKFLOW_RUNS_DIR).filter((name) => name.endsWith('.json')).length
      : 0,
    0,
    'disabled unique-run identity is not a queue',
  );
});

test('tryHostDispatchNamedWorkflow: a unique enabled run request queues through workflow_run', () => {
  writeWorkflow('platform-49-slack-channel-review', {
    name: 'Platform 49 Slack Channel Review',
    description: 'Business-hours channel review',
    enabled: true,
    trigger: { schedule: '0 9 * * 1-5', timezone: 'America/Los_Angeles' },
    steps: [{ id: 'post', prompt: 'Post the team update.' }],
  });
  seedSlackAndFacebook();
  const session = createSession({ kind: 'chat', channel: 'desktop' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Can you run my platform 49 flow please now so it catches up',
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
  assert.equal(result.status, 'dispatched', JSON.stringify(result));
  if (result.status === 'dispatched') {
    assert.equal(result.workflowName, 'Platform 49 Slack Channel Review');
    assert.ok(result.runId);
  }
  const runs = existsSync(WORKFLOW_RUNS_DIR)
    ? readdirSync(WORKFLOW_RUNS_DIR).filter((name) => name.endsWith('.json'))
    : [];
  assert.equal(runs.length, 1, 'the unique run must land in the shared queue');
});

test('tryHostDispatchNamedWorkflow: a workflow step\'s own accepted source never self-dispatches', () => {
  seedSlackAndFacebook();
  const text = workflowStepAcceptedText('scorpion-facebook-trends', 'find_official_page');
  // Same text + same catalog as chat: the lexical matcher alone says RUN.
  // Only the source class differs, and the class is what must decide.
  assert.equal(
    uniqueWorkflowRunRequest(text)?.slug,
    'scorpion-facebook-trends',
    'setup: the real step text is a unique lexical run request',
  );
  const session = createSession({ kind: 'workflow', channel: 'workflow' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    // Exactly what workflow-runner records for a step attempt: no reply
    // target (today's accidental origin_unbound block).
    data: { text, ...STEP_SOURCE_DATA },
  });
  const result = tryHostDispatchNamedWorkflow({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    userText: text,
    route: 'act',
  });
  assert.deepEqual(result, {
    status: 'not_applicable',
    reason: 'accepted_source_is_workflow_internal',
  }, 'the step continues into its ordinary model loop; no terminal, no block message');
  assert.equal(workflowRunFileCount(), 0, 'a step never queues a sibling run of its own workflow');
});

test('tryHostDispatchNamedWorkflow: a workflow self-improvement session is host-internal and never queues the workflow it is rewriting', () => {
  // Live 2026-09-01: the improvement prompt says the workflow "was asked to
  // run"; the shortcut queued it from the system session, could not bind a
  // report-back target, and ended the turn before any authoring call.
  seedSlackAndFacebook();
  const text = 'Workflow self-improvement: "slack-digest". This saved workflow was asked to run but its readiness check refused it. Run it after the rewrite.';
  const result = tryHostDispatchNamedWorkflow({
    sessionId: `workflow-improvement:slack-digest:${Date.now()}`,
    sourceUserSeq: 1,
    userText: text,
    route: 'act',
  });
  assert.deepEqual(result, {
    status: 'not_applicable',
    reason: 'accepted_source_is_workflow_internal',
  });
  assert.equal(workflowRunFileCount(), 0);
});

test('tryHostDispatchNamedWorkflow: a bindable workflow-internal source still never queues (load-bearing)', () => {
  seedSlackAndFacebook();
  const text = workflowStepAcceptedText('scorpion-facebook-trends', 'find_official_page');
  // Today's block was the origin_unbound ACCIDENT (step events carry no reply
  // target). Give the step source a bindable target: without the class
  // guard this exact source queues a real recursive run of its own workflow.
  const session = createSession({
    id: 'workflow:trigger-run-1:find_official_page',
    kind: 'workflow',
    channel: 'workflow',
  });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text,
      ...STEP_SOURCE_DATA,
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
  assert.deepEqual(result, {
    status: 'not_applicable',
    reason: 'accepted_source_is_workflow_internal',
  });
  assert.equal(workflowRunFileCount(), 0, 'a bindable reply target does not turn a step into a user request');
});

test('acceptedSourceIsWorkflowInternal: each durable flag decides alone; chat and execution sources stay open', () => {
  const text = 'run my team activity slack updates workflow';
  // (1) session kind only.
  const byKind = createSession({ kind: 'workflow', channel: 'workflow' });
  const byKindSource = appendEvent({
    sessionId: byKind.id, turn: 1, role: 'user', type: 'user_input_received', data: { text },
  });
  assert.equal(acceptedSourceIsWorkflowInternal(byKind.id, byKindSource.seq), true, 'kind workflow');
  // (2) the accepted event's run/step identity only (a rebound step session).
  const byEvent = createSession({ kind: 'chat', channel: 'desktop' });
  const byEventSource = appendEvent({
    sessionId: byEvent.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text, workflowRunId: 'trigger-run-9', stepId: 'post' },
  });
  assert.equal(acceptedSourceIsWorkflowInternal(byEvent.id, byEventSource.seq), true, 'event ids');
  // (3) the deterministic step session id only.
  const byId = createSession({ id: 'workflow:trigger-run-9:post', kind: 'chat', channel: 'desktop' });
  const byIdSource = appendEvent({
    sessionId: byId.id, turn: 1, role: 'user', type: 'user_input_received', data: { text },
  });
  assert.equal(acceptedSourceIsWorkflowInternal(byId.id, byIdSource.seq), true, 'workflow: prefix');
  // A later chat turn on a chat session is not workflow-internal because an
  // EARLIER event carried step ids: the exact accepted event decides.
  const later = appendEvent({
    sessionId: byEvent.id, turn: 2, role: 'user', type: 'user_input_received', data: { text },
  });
  assert.equal(acceptedSourceIsWorkflowInternal(byEvent.id, later.seq), false, 'exact accepted event only');
  // Chat and cron/background execution sessions are user-originated.
  for (const kind of ['chat', 'execution'] as const) {
    const session = createSession({ kind, channel: kind === 'chat' ? 'desktop' : 'background' });
    const source = appendEvent({
      sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text },
    });
    assert.equal(acceptedSourceIsWorkflowInternal(session.id, source.seq), false, kind);
  }
});

test('tryHostDispatchNamedWorkflow: a cron/background execution session is user-originated and still queues', () => {
  writeWorkflow('platform-49-slack-channel-review', {
    name: 'Platform 49 Slack Channel Review',
    description: 'Business-hours channel review',
    enabled: true,
    trigger: { schedule: '0 9 * * 1-5', timezone: 'America/Los_Angeles' },
    steps: [{ id: 'post', prompt: 'Post the team update.' }],
  });
  seedSlackAndFacebook();
  // Surface→kind map: cron/background surfaces are kind 'execution'. Their
  // accepted text was authored for a user, so the guard must not exclude it.
  const session = createSession({ kind: 'execution', channel: 'background' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Can you run my platform 49 flow please now so it catches up',
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
  assert.equal(result.status, 'dispatched', JSON.stringify(result));
  assert.equal(workflowRunFileCount(), 1, 'an execution-kind source keeps the shortcut');
});

test('plan_task twin: the plan_not_required "call workflow_run" short-circuit consults the same predicate first', () => {
  // Lane parity (carrier sweep): plan_task carries the same lexical
  // short-circuit. A step with a populated planning card would otherwise be
  // told to call workflow_run, which the step surface denies by construction.
  const src = readFileSync(new URL('../../tools/plan-tools.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function executePlanTask'), src.indexOf('export function buildPlanTaskTool'));
  const guardAt = fn.indexOf('acceptedSourceIsWorkflowInternal(sessionId, sourceUserSeq)');
  const uniqueAt = fn.indexOf('uniqueWorkflowRunRequest(');
  const shortCircuitAt = fn.indexOf("code: 'plan_not_required'");
  assert.ok(guardAt >= 0, 'plan_task consults acceptedSourceIsWorkflowInternal');
  assert.ok(uniqueAt > guardAt && shortCircuitAt > uniqueAt,
    'the source-class guard decides before the lexical short-circuit can name workflow_run');
  assert.match(
    src,
    /import \{ acceptedSourceIsWorkflowInternal \} from '\.\.\/runtime\/harness\/named-workflow-host-dispatch\.js'/,
    'one predicate, imported from the dispatcher, not a second spelling',
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
  // Keep the synthetic occurrence ahead of wall-clock retention. A historical
  // date eventually ages out of the seven-day scheduler state between the
  // first and second assertion, which tests pruning rather than idempotency.
  const at727 = new Date(2099, 7, 14, 7, 27, 0);
  const result = satisfyNextScheduledWorkflowOccurrence('team-activity-slack-updates', at727);
  assert.equal(result.satisfied, true);
  assert.ok(result.atMs);
  const nineAm = new Date(2099, 7, 14, 9, 0, 0).getTime();
  assert.equal(result.atMs, nineAm);

  const again = satisfyNextScheduledWorkflowOccurrence('team-activity-slack-updates', at727);
  assert.equal(again.satisfied, false, 'the same slot must not be rewritten');

  const afterNine = satisfyNextScheduledWorkflowOccurrence(
    'team-activity-slack-updates',
    new Date(2099, 7, 14, 10, 0, 0),
  );
  assert.equal(afterNine.satisfied, false, 'tomorrow must stay pending');
});
