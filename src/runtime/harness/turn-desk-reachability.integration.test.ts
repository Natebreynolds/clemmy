/** The round-one desk (agents/turn-desk.ts) through the real host_v1 door.
 *
 * The desk is a fixed ladder of tools blocks: lean ⊂ readers ⊂ full. A turn on
 * a rung below a desk tool's own rung keeps that tool on the agent with its
 * schema off the request, names it on one line, and keeps it reachable in the
 * same turn: an exact-name tool_search returns its schema and call_tool
 * carries it to its real handler. A session only climbs; a desk tool it
 * dispatched climbs it to that tool's rung for the next turn, and a turn that
 * climbs nothing reuses the exact tools block. Plan, act, execute, unattended
 * and door-less builds keep today's surface, even on a source that already
 * recorded a desk. Only the model is scripted (host-chat-turn.testsupport.ts);
 * the orchestrator build, host dispatch, carriers, admission and settlement
 * are production. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-turn-desk-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.CLEMMY_CODEX_TOOL_SEARCH = 'on';
process.env.CLEMMY_JEV = 'off';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_WATCHER_JUDGE = 'off';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'turn-desk-fixture\n');

const eventlog = await import('./eventlog.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const {
  acceptSource, agentTools, buildFor, hostTurn, idleModel,
} = await import('./host-chat-turn.testsupport.js');
const { TOOL_REGISTRY } = await import('../../tools/tool-registry.js');
const { NO_TARGET_STARTS_LEAN } = await import('../../agents/turn-desk.js');
type MoveContext = import('./host-chat-turn.testsupport.js').MoveContext;
type Move = import('./host-chat-turn.testsupport.js').Move;
const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();
after(() => {
  catalogs.installHostCapabilityCatalogFactory(priorCatalog);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const DESK_TOOLS = TOOL_REGISTRY.filter((declaration) => declaration.desk).map((declaration) => declaration.name).sort();
const rungOf = (name: string) => TOOL_REGISTRY.find((declaration) => declaration.name === name)?.desk?.rung;
const READERS = DESK_TOOLS.filter((name) => rungOf(name) === 'readers');
const FULL_ONLY = DESK_TOOLS.filter((name) => rungOf(name) === 'full');

interface DeskRecord {
  version: number; rung: string; fallbackReason: string | null; climbedBy: string[]; missed: string[];
  deferred: string[]; sourceUserSeq: number;
}

function deskRecord(sessionId: string, sourceUserSeq: number): DeskRecord | undefined {
  return eventlog.listEvents(sessionId, { sinceSeq: sourceUserSeq, types: ['tool_search_scope'] })
    .map((event) => (event.data as { desk?: DeskRecord }).desk)
    .filter((desk): desk is DeskRecord => Boolean(desk) && desk!.sourceUserSeq === sourceUserSeq)
    .at(-1);
}

const deferredOn = (agent: unknown): string[] => agentTools(agent)
  .filter((entry) => entry.deferLoading === true && DESK_TOOLS.includes(entry.name ?? ''))
  .map((entry) => entry.name!)
  .sort();
/** What the model can see of an agent's tools: name, description, schema and
 * loading flag of each, in order. */
const toolsBytes = (agent: unknown) => JSON.stringify(agentTools(agent).map((entry) => (
  [entry.name, entry.description, entry.parameters, entry.deferLoading === true])));
const namesLine = (instructions: string) =>
  instructions.split('\n').find((entry) => entry.startsWith('[on-request tools]')) ?? '';
const firstDifference = (left: string, right: string) => {
  let index = 0;
  while (index < left.length && left[index] === right[index]) index += 1;
  return { index, left: left.slice(Math.max(0, index - 200), index + 200), right: right.slice(Math.max(0, index - 200), index + 200) };
};
const agentInstructions = (agent: unknown) => String((agent as { instructions?: unknown }).instructions ?? '');

/** Names an exact registry tool, so an existing host promotion (the exact-name
 * hot-set promotion) identifies the request's target. */
const TARGETED = 'Run workspace_roots and tell me where my workspace folders are.';
const UNTARGETED = 'Can you take care of the thing from earlier?';

test('a targeted ordinary turn with no desk evidence sends the lean rung and names every deferred tool', async () => {
  const sessionId = 'turn-desk-lean';
  const run = await hostTurn(sessionId, TARGETED, [() => ({ name: 'workspace_roots', args: {} })]);
  const first = run.requests[0]!;
  assert.deepEqual(DESK_TOOLS.filter((name) => first.tools.includes(name)), [], `no desk schema rides round 1: ${first.tools.join(',')}`);
  const line = namesLine(first.instructions);
  assert.deepEqual(DESK_TOOLS.filter((name) => !line.includes(`${name} (`)), [], `every deferred tool is named with its purpose: ${line}`);
  assert.ok(first.tools.includes('tool_search') && first.tools.includes('call_tool'), 'both doors ride the request');
  assert.equal(new Set(run.requests.map((request) => request.toolsJson)).size, 1, 'no schema joins or leaves the wire mid-turn');
  assert.deepEqual(deferredOn(run.agent), DESK_TOOLS, 'each deferred tool stays on the agent, marked deferLoading');
  const desk = deskRecord(sessionId, run.source.seq);
  assert.equal(desk?.rung, 'lean');
  assert.equal(desk?.fallbackReason, null);
  assert.deepEqual([...(desk?.deferred ?? [])].sort(), DESK_TOOLS, 'the tool_search_scope event records the deferred names');
});

test(`a turn with no identified target follows the owner's no-signal rule (NO_TARGET_STARTS_LEAN=${NO_TARGET_STARTS_LEAN})`, async () => {
  const sessionId = 'turn-desk-no-signal';
  const run = await hostTurn(sessionId, UNTARGETED, []);
  const first = run.requests[0]!;
  const desk = deskRecord(sessionId, run.source.seq);
  assert.equal(desk?.fallbackReason, null, 'the turn is in scope');
  if (NO_TARGET_STARTS_LEAN) {
    assert.equal(desk?.rung, 'lean', 'with no evidence the turn starts on the lean rung');
    assert.deepEqual(DESK_TOOLS.filter((name) => first.tools.includes(name)), [], 'no desk schema rides round 1');
    assert.deepEqual(DESK_TOOLS.filter((name) => !namesLine(first.instructions).includes(`${name} (`)), [], 'every deferred tool is named');
  } else {
    assert.equal(desk?.rung, 'full', 'no identified target: today\'s full surface');
    assert.ok(desk?.climbedBy.includes('no_identified_target'), `recorded reason: ${desk?.climbedBy}`);
    assert.deepEqual(DESK_TOOLS.filter((name) => !first.tools.includes(name)), [], `every desk schema rides round 1: ${first.tools.join(',')}`);
    assert.equal(namesLine(first.instructions), '', 'no names line');
    assert.deepEqual(deferredOn(run.agent), []);
  }
});

/** Per deferred tool: arguments (a reader opens the workspace_roots output
 * retained by the turn's first call) and the handler's own answer. */
const REACH: Record<string, { args: (context: MoveContext) => Record<string, unknown>; handler: RegExp; needsOutput?: boolean }> = {
  app_guide: { args: () => ({ places: false }), handler: /What is set up in Clementine right now/ },
  check_in: { args: () => ({ note: 'Reading your workspace roots now.' }), handler: /Check-in posted to the conversation/ },
  file_query: { args: ({ callId }) => ({ query: 'workspace roots', call_id: callId(0) }), handler: /"source":"tool output [^"]*-c0","totalChunks":1/, needsOutput: true },
  recall_tool_result: { args: ({ callId }) => ({ call_id: callId(0) }), handler: /Recalled chars 0–\d+ of \d+[\s\S]*tool=workspace_roots/, needsOutput: true },
  skill_read: { args: () => ({ name: 'no-such-installed-skill' }), handler: /is not installed/ },
  tool_output_query: { args: ({ callId }) => ({ call_id: callId(0) }), handler: /not structured records[\s\S]*tool=workspace_roots/, needsOutput: true },
};

test('the reachability probes cover every desk-declared tool', () => {
  assert.deepEqual(Object.keys(REACH).sort(), DESK_TOOLS);
});

// Each probe runs in its own session, so no-progress accounting of one probe
// cannot end another probe's turn early.
for (const name of Object.keys(REACH).sort()) {
  test(`deferred ${name}: an exact-name tool_search returns its full schema`, async () => {
    const sessionId = `turn-desk-search-${name}`;
    const run = await hostTurn(sessionId, TARGETED, [() => ({ name: 'tool_search', args: { query: name } })]);
    assert.equal(deskRecord(sessionId, run.source.seq)?.rung, 'lean', 'the desk is lean on this turn');
    assert.ok(!run.requests[0]!.tools.includes(name), `${name} was deferred`);
    const searched = run.outputs.get(run.callId(0)) ?? '';
    const properties = Object.keys(agentTools(run.agent).find((entry) => entry.name === name)?.parameters?.properties ?? {});
    assert.ok(properties.length > 0, `${name} has schema properties`);
    assert.ok(searched.includes(name), `tool_search names ${name}: ${searched.slice(0, 400)}`);
    assert.deepEqual(properties.filter((property) => !searched.includes(`"${property}"`)), [],
      `tool_search returns every ${name} schema property: ${searched.slice(0, 800)}`);
  });

  test(`deferred ${name}: call_tool carries it to its real handler`, async () => {
    const sessionId = `turn-desk-call-${name}`;
    const probe = REACH[name]!;
    const moves: Array<(context: MoveContext) => Move> = [
      ...(probe.needsOutput ? [() => ({ name: 'workspace_roots', args: {} })] : []),
      (context) => ({ name: 'call_tool', args: { name, args_json: JSON.stringify(probe.args(context)) } }),
    ];
    const run = await hostTurn(sessionId, TARGETED, moves);
    assert.equal(deskRecord(sessionId, run.source.seq)?.rung, 'lean', 'the desk is lean on this turn');
    assert.ok(!run.requests[0]!.tools.includes(name), `${name} was deferred`);
    const answered = run.outputs.get(run.callId(moves.length - 1)) ?? '';
    assert.match(answered, probe.handler, `call_tool reached the ${name} handler: ${answered.slice(0, 1500)}`);
  });
}

test('a session climbs the ladder only on a miss: unchanged turns reuse the exact tools block, and a climb extends it at the tail', async () => {
  const sessionId = 'turn-desk-ladder';
  const turn1 = await hostTurn(sessionId, TARGETED, []);
  const turn2 = await hostTurn(sessionId, TARGETED, []);
  const turn3 = await hostTurn(sessionId, TARGETED, []);
  for (const turn of [turn1, turn2, turn3]) assert.equal(deskRecord(sessionId, turn.source.seq)?.rung, 'lean');
  assert.equal(turn2.requests[0]!.toolsJson, turn1.requests[0]!.toolsJson, 'the second turn reuses the exact tools block');
  assert.equal(turn3.requests[0]!.toolsJson, turn1.requests[0]!.toolsJson, 'the third turn reuses the exact tools block');

  // One accepted source keeps one desk: a rebuild on the same source reads
  // the recorded rung back.
  const rebuilt = await buildFor(sessionId, turn3.source.seq, TARGETED, idleModel);
  assert.equal(toolsBytes(rebuilt), toolsBytes(turn3.agent), 'a re-entry on the same source keeps its desk');

  // A miss on a reader: the model calls a deferred reader by bare name. The
  // schema never joins mid-turn; the next turn climbs exactly to the readers rung.
  const turn4 = await hostTurn(sessionId, TARGETED, [() => ({ name: 'recall_tool_result', args: { call_id: 'no-such-call' } })]);
  assert.equal(deskRecord(sessionId, turn4.source.seq)?.rung, 'lean');
  assert.equal(new Set(turn4.requests.map((request) => request.toolsJson)).size, 1, 'the miss changes nothing mid-turn');
  const turn5 = await hostTurn(sessionId, TARGETED, []);
  const desk5 = deskRecord(sessionId, turn5.source.seq);
  assert.equal(desk5?.rung, 'readers', `a reader miss climbs exactly one rung: ${JSON.stringify(desk5)}`);
  assert.ok(desk5?.missed.includes('recall_tool_result'), `the miss is recorded: ${JSON.stringify(desk5)}`);
  assert.deepEqual(READERS.filter((name) => !turn5.requests[0]!.tools.includes(name)), [], 'the readers ride the readers rung');
  assert.deepEqual(FULL_ONLY.filter((name) => turn5.requests[0]!.tools.includes(name)), [], 'the full-rung tools stay deferred');
  assert.deepEqual(FULL_ONLY.filter((name) => !namesLine(turn5.requests[0]!.instructions).includes(`${name} (`)), [], 'and stay named');
  assert.ok(turn5.requests[0]!.toolsJson.startsWith(turn1.requests[0]!.toolsJson.slice(0, -1)),
    `the climb appends the readers after the tools block the session already sent: ${JSON.stringify({ before: turn1.requests[0]!.tools, after: turn5.requests[0]!.tools, diff: firstDifference(turn1.requests[0]!.toolsJson, turn5.requests[0]!.toolsJson) })}`);

  // A miss on a full-rung tool climbs to full on the next turn, and stays there.
  const turn6 = await hostTurn(sessionId, TARGETED, [() => ({ name: 'check_in', args: { note: 'Starting now.' } })]);
  assert.equal(deskRecord(sessionId, turn6.source.seq)?.rung, 'readers');
  assert.match(turn6.outputs.get(turn6.callId(0)) ?? '', /Check-in posted/, 'the bare-name call reached the handler');
  const turn7 = await hostTurn(sessionId, TARGETED, []);
  const turn8 = await hostTurn(sessionId, TARGETED, []);
  assert.equal(deskRecord(sessionId, turn7.source.seq)?.rung, 'full');
  assert.equal(deskRecord(sessionId, turn8.source.seq)?.rung, 'full', 'a session never climbs back down');
  assert.deepEqual(DESK_TOOLS.filter((name) => !turn7.requests[0]!.tools.includes(name)), [], 'every desk schema rides the full rung');
  assert.ok(turn7.requests[0]!.toolsJson.startsWith(turn5.requests[0]!.toolsJson.slice(0, -1)),
    'the second climb extends the tools block again');
  assert.equal(turn8.requests[0]!.toolsJson, turn7.requests[0]!.toolsJson, 'a later full turn reuses the exact tools block');
});

test('after a heavy turn the climb is held so the cached conversation stays warm, and lands once the prefix is small', async () => {
  const sessionId = 'turn-desk-warm-hold';
  const turn1 = await hostTurn(sessionId, TARGETED, [() => ({ name: 'recall_tool_result', args: { call_id: 'no-such-call' } })]);
  assert.equal(deskRecord(sessionId, turn1.source.seq)?.rung, 'lean');
  // The turn's last request carried a large conversation, composed for the model this session is routed to.
  const reading = (source: number, totalTokens: number) => eventlog.appendEvent({ sessionId, turn: 0, role: 'system',
    type: 'prompt_composition', data: { lane: 'host', totalTokens, stableTokens: 7_000, variableTokens: totalTokens - 7_000,
      stableShare: 0.1, toolCount: 10, sourceUserSeq: source, requestOrdinal: 3, model: 'fixture-model' } });
  const routedSource = (model: string) => {
    const source = acceptSource(sessionId, TARGETED);
    eventlog.appendEvent({ sessionId, turn: 0, role: 'system', type: 'turn_model_routed',
      data: { model, sourceUserSeq: source.seq } });
    return source;
  };
  reading(turn1.source.seq, 64_000);
  const source2 = routedSource('fixture-model');
  const agent2 = await buildFor(sessionId, source2.seq, TARGETED, idleModel);
  const desk2 = deskRecord(sessionId, source2.seq) as (DeskRecord & { held?: { rung: string; climbedBy: string[] } }) | undefined;
  assert.equal(desk2?.rung, 'lean', `the miss's climb is held: ${JSON.stringify(desk2)}`);
  assert.equal(desk2?.held?.rung, 'readers');
  assert.ok(desk2?.held?.climbedBy.includes('miss'));
  assert.equal(toolsBytes(agent2), toolsBytes(turn1.agent), 'the tools block is byte-identical, so the cached prefix holds');
  // A prefix composed for a different model than this source is routed to
  // is not this request's cache: the climb lands.
  reading(source2.seq, 64_000);
  const source3 = routedSource('another-model');
  await buildFor(sessionId, source3.seq, TARGETED, idleModel);
  assert.equal(deskRecord(sessionId, source3.seq)?.rung, 'readers', 'a changed model does not hold the climb');
});

test('a small last prefix climbs as before', async () => {
  const sessionId = 'turn-desk-warm-small';
  const turn1 = await hostTurn(sessionId, TARGETED, [() => ({ name: 'recall_tool_result', args: { call_id: 'no-such-call' } })]);
  eventlog.appendEvent({ sessionId, turn: 0, role: 'system', type: 'prompt_composition', data: { lane: 'host', totalTokens: 9_000,
    stableTokens: 7_000, variableTokens: 2_000, stableShare: 0.78, toolCount: 10, sourceUserSeq: turn1.source.seq, model: 'fixture-model' } });
  const source = acceptSource(sessionId, TARGETED);
  eventlog.appendEvent({ sessionId, turn: 0, role: 'system', type: 'turn_model_routed', data: { model: 'fixture-model', sourceUserSeq: source.seq } });
  await buildFor(sessionId, source.seq, TARGETED, idleModel);
  assert.equal(deskRecord(sessionId, source.seq)?.rung, 'readers');
});

test('a turn without the call door records doors_absent and defers nothing', async () => {
  const sessionId = 'turn-desk-no-call-door';
  const source = acceptSource(sessionId, TARGETED);
  const agent = await buildFor(sessionId, source.seq, TARGETED, idleModel, { excludeToolNames: ['call_tool'] });
  const names = agentTools(agent).map((entry) => entry.name);
  assert.ok(!names.includes('call_tool'), `the build has no call_tool: ${names.join(',')}`);
  assert.ok(names.includes('tool_search'), 'the search door is still present');
  assert.deepEqual(deferredOn(agent), [], 'no desk tool carries deferLoading');
  assert.equal(namesLine(agentInstructions(agent)), '', 'no names line');
  const desk = deskRecord(sessionId, source.seq);
  assert.equal(desk?.fallbackReason, 'doors_absent');
  assert.equal(desk?.rung, 'full');
  assert.deepEqual(desk?.deferred, []);
});

const artifacts = await import('./plan-artifacts.js');
/** An accepted Execute source for a saved, ready plan revision. */
function executeSource(sessionId: string) {
  const planSource = acceptSource(sessionId, 'Plan how to find my workspace folders.', { taskMode: { version: 1, kind: 'plan' } });
  const plan = artifacts.publishPlanRevision({
    sessionId, sourceUserSeq: planSource.seq, principalId: sessionId,
    fullText: 'Run workspace_roots and report the workspace folders.', readiness: 'ready',
  });
  const executeRef = { planId: plan.planId, revision: plan.revision, digest: plan.digest };
  const source = acceptSource(sessionId, TARGETED, { taskMode: { version: 1, kind: 'execute', executeRef } });
  artifacts.claimPlanExecution({ sessionId, sourceUserSeq: source.seq, principalId: sessionId, executeRef });
  return source;
}
const OUT_OF_SCOPE: Array<{
  label: string;
  source: (sessionId: string) => { seq: number };
  extra?: Record<string, unknown>;
  prefix?: string;
  modeOnSource?: boolean;
}> = [
  { label: 'plan', source: (sessionId) => acceptSource(sessionId, TARGETED, { taskMode: { version: 1, kind: 'plan' } }), modeOnSource: true },
  { label: 'execute', source: executeSource, modeOnSource: true },
  { label: 'act', source: (sessionId) => acceptSource(sessionId, TARGETED), extra: { acceptedRoute: 'act' } },
  { label: 'unattended', source: (sessionId) => acceptSource(sessionId, TARGETED), prefix: 'workflow:' },
];

test('plan, execute, act and unattended builds keep today\'s surface and record out_of_scope', async () => {
  for (const entry of OUT_OF_SCOPE) {
    const sessionId = `${entry.prefix ?? ''}turn-desk-scope-${entry.label}`;
    const source = entry.source(sessionId);
    const agent = await buildFor(sessionId, source.seq, TARGETED, idleModel, entry.extra ?? {});
    assert.deepEqual(deferredOn(agent), [], `${entry.label}: no desk tool loses its schema`);
    assert.equal(namesLine(agentInstructions(agent)), '', `${entry.label}: no names line`);
    const desk = deskRecord(sessionId, source.seq);
    assert.equal(desk?.fallbackReason, 'out_of_scope', `${entry.label}: ${JSON.stringify(desk)}`);
    assert.deepEqual(desk?.deferred, []);
  }
});

test('a plan or execute re-entry on a source that recorded a lean desk keeps today\'s surface', async () => {
  // A real in-scope lean record to reuse.
  const leanSession = 'turn-desk-reentry-lean';
  const leanSource = acceptSource(leanSession, TARGETED);
  await buildFor(leanSession, leanSource.seq, TARGETED, idleModel);
  const lean = deskRecord(leanSession, leanSource.seq);
  assert.equal(lean?.rung, 'lean', 'the ordinary build recorded a lean desk');
  for (const entry of OUT_OF_SCOPE.filter((candidate) => candidate.label === 'plan' || candidate.label === 'execute')) {
    const sessionId = `turn-desk-reentry-${entry.label}`;
    const controlId = `turn-desk-reentry-control-${entry.label}`;
    const source = entry.source(sessionId);
    const control = entry.source(controlId);
    if (entry.modeOnSource) {
      // The mode is part of the accepted source, so no ordinary build can run
      // on it; record the lean desk an earlier build would have recorded.
      eventlog.appendEvent({
        sessionId, turn: 0, role: 'system', type: 'tool_search_scope',
        data: { active: true, desk: { ...lean, sourceUserSeq: source.seq } },
      });
    } else {
      const chat = await buildFor(sessionId, source.seq, TARGETED, idleModel);
      assert.deepEqual(deferredOn(chat), DESK_TOOLS, `${entry.label}: the ordinary build on this source recorded a lean desk`);
    }
    const scoped = await buildFor(sessionId, source.seq, TARGETED, idleModel, entry.extra ?? {});
    const fresh = await buildFor(controlId, control.seq, TARGETED, idleModel, entry.extra ?? {});
    assert.deepEqual(deferredOn(scoped), [], `${entry.label}: no desk tool loses its schema`);
    assert.equal(namesLine(agentInstructions(scoped)), '', `${entry.label}: no names line`);
    assert.equal(toolsBytes(scoped), toolsBytes(fresh),
      `${entry.label}: the re-entry's tools are byte-identical to the same build on a source with no desk record`);
  }
});

test('an act resume of a turn that recorded its desk (the restart after an approval) keeps that turn\'s exact tools block', async () => {
  const sessionId = 'turn-desk-resume-act';
  const source = acceptSource(sessionId, TARGETED);
  const chat = await buildFor(sessionId, source.seq, TARGETED, idleModel);
  assert.equal(deskRecord(sessionId, source.seq)?.rung, 'lean', 'the turn began as ordinary chat on the lean rung');
  const resumed = await buildFor(sessionId, source.seq, TARGETED, idleModel, { acceptedRoute: 'act' });
  assert.deepEqual(deferredOn(resumed), deferredOn(chat), 'the resume defers what the turn deferred');
  const before = toolsBytes(chat);
  const after = toolsBytes(resumed);
  assert.equal(after, before, `the resume re-sends the turn's tools block byte for byte: ${JSON.stringify(firstDifference(before, after))}`);
  assert.equal(deskRecord(sessionId, source.seq)?.fallbackReason, null, 'the resume recorded the reused in-scope desk');
  // A source that never recorded a desk still gets today's surface on act.
  const freshId = 'turn-desk-resume-act-fresh';
  const fresh = acceptSource(freshId, TARGETED);
  const act = await buildFor(freshId, fresh.seq, TARGETED, idleModel, { acceptedRoute: 'act' });
  assert.deepEqual(deferredOn(act), []);
  assert.equal(deskRecord(freshId, fresh.seq)?.fallbackReason, 'out_of_scope');
});

test('a tool reached for during a turn joins the tools block at the owner\'s next message, never on a rebuild of the same turn', async () => {
  const hotset = await import('../../agents/tool-hotset.js');
  const sessionId = 'turn-desk-hot-next-turn';
  const first = acceptSource(sessionId, TARGETED);
  const opening = await buildFor(sessionId, first.seq, TARGETED, idleModel);
  const names = (agent: unknown) => agentTools(agent).map((entry) => entry.name);
  assert.equal(names(opening).includes('view_image'), false, 'the fixture tool is not on the opening surface');
  // The turn reaches for it (through the dispatcher), then restarts.
  hotset.recordToolHit(sessionId, 'view_image');
  const restarted = await buildFor(sessionId, first.seq, TARGETED, idleModel);
  assert.equal(toolsBytes(restarted), toolsBytes(opening), 'the same turn re-sends its exact tools block');
  // The owner's next message promotes it.
  const next = acceptSource(sessionId, TARGETED);
  const nextTurn = await buildFor(sessionId, next.seq, TARGETED, idleModel);
  assert.equal(names(nextTurn).includes('view_image'), true, 'the next turn carries the tool it reached for');
});

test('a rebuild of the same turn keeps work_call\'s ready list; an operation found during the turn joins at the next message', async () => {
  const sessionId = 'work-call-disclosure-turn';
  const descriptor = {
    id: 'cap:resolved:quillboard_pages_batch_update', effect: 'external_write', purpose: 'Update the pages of a deck',
    acceptedInputKinds: [], producedOutputKinds: [], applicableDeliverableKinds: [], inputShape: 'object', outputShape: 'object',
    outputKind: 'record', deliverableKind: 'none', destinationPosture: null, evidenceKinds: [], handleRequired: false,
    readbackRequired: false, accountScope: 'account', manifestDigest: 'a'.repeat(64),
  };
  const proven = (sourceUserSeq: number) => eventlog.appendEvent({
    sessionId, turn: 0, role: 'system', type: 'proven_operation_selected',
    data: { sourceUserSeq, skipDiscoverySearch: false, tools: ['QUILLBOARD_PAGES_BATCH_UPDATE'], descriptors: [descriptor], boundAccounts: [] },
  });
  const workCallBytes = (agent: unknown) => JSON.stringify(agentTools(agent)
    .filter((entry) => entry.name === 'work_call').map((entry) => [entry.description, entry.parameters]));
  const source = acceptSource(sessionId, TARGETED);
  const opening = await buildFor(sessionId, source.seq, TARGETED, idleModel);
  const before = workCallBytes(opening);
  assert.notEqual(before, '[]', 'the turn carries work_call');
  assert.doesNotMatch(before, /QUILLBOARD_PAGES_BATCH_UPDATE/);
  // The turn finds an operation, then restarts after the owner approves.
  proven(source.seq);
  const resumed = await buildFor(sessionId, source.seq, TARGETED, idleModel, { acceptedRoute: 'act' });
  assert.equal(workCallBytes(resumed), before, 'the restarted turn re-sends work_call byte for byte');
  // The owner's next message lists it.
  const next = acceptSource(sessionId, TARGETED);
  proven(next.seq);
  const nextTurn = await buildFor(sessionId, next.seq, TARGETED, idleModel);
  assert.match(workCallBytes(nextTurn), /QUILLBOARD_PAGES_BATCH_UPDATE/, 'the next turn lists the operation as ready');
});

test('Jev off and Jev on without a key decide the same desk and send the same tools block', async () => {
  const offRun = await hostTurn('turn-desk-jev-off', TARGETED, []);
  process.env.CLEMMY_JEV = 'on';
  try {
    const noKeyRun = await hostTurn('turn-desk-jev-no-key', TARGETED, []);
    const offDesk = deskRecord('turn-desk-jev-off', offRun.source.seq);
    const noKeyDesk = deskRecord('turn-desk-jev-no-key', noKeyRun.source.seq);
    assert.deepEqual({ ...noKeyDesk, sourceUserSeq: 0 }, { ...offDesk, sourceUserSeq: 0 });
    assert.equal(noKeyRun.requests[0]!.toolsJson, offRun.requests[0]!.toolsJson);
  } finally {
    process.env.CLEMMY_JEV = 'off';
  }
});

const ATTACHED = { attachmentIds: ['turn-desk-fixture-attachment'] };

test('an evidence climb holds: the next turn without that evidence stays on the climbed rung and reuses its tools block', async () => {
  const sessionId = 'turn-desk-evidence-floor';
  const turn1 = await hostTurn(sessionId, TARGETED, []);
  assert.equal(deskRecord(sessionId, turn1.source.seq)?.rung, 'lean');
  const turn2 = await hostTurn(sessionId, TARGETED, [], ATTACHED);
  const desk2 = deskRecord(sessionId, turn2.source.seq);
  assert.equal(desk2?.rung, 'readers', `attachments climb to the readers rung: ${JSON.stringify(desk2)}`);
  assert.ok(desk2?.climbedBy.includes('retained_output'), JSON.stringify(desk2));
  const turn3 = await hostTurn(sessionId, TARGETED, []);
  const desk3 = deskRecord(sessionId, turn3.source.seq);
  assert.equal(desk3?.rung, 'readers', `a session never descends: ${JSON.stringify(desk3)}`);
  assert.ok(desk3?.climbedBy.includes('session_floor'), JSON.stringify(desk3));
  assert.equal(turn3.requests[0]!.toolsJson, turn2.requests[0]!.toolsJson, 'the next turn reuses the exact tools block');
});

test('a rebuild of an older source recorded after a newer source climbed never lowers the floor', async () => {
  const sessionId = 'turn-desk-interleaved-floor';
  const turn1 = await hostTurn(sessionId, TARGETED, []);
  const desk1 = deskRecord(sessionId, turn1.source.seq);
  assert.equal(desk1?.rung, 'lean');
  const turn2 = await hostTurn(sessionId, TARGETED, [], ATTACHED);
  assert.equal(deskRecord(sessionId, turn2.source.seq)?.rung, 'readers');
  // A retry or approval resume of the older source appends its record after
  // the newer source's; it is newer by event order but older by source.
  eventlog.appendEvent({
    sessionId, turn: 0, role: 'system', type: 'tool_search_scope',
    data: { active: true, desk: { ...desk1, sourceUserSeq: turn1.source.seq } },
  });
  const turn3 = await hostTurn(sessionId, TARGETED, []);
  const desk3 = deskRecord(sessionId, turn3.source.seq);
  assert.equal(desk3?.rung, 'readers', `the floor is the highest earlier rung, not the newest row: ${JSON.stringify(desk3)}`);
  assert.equal(turn3.requests[0]!.toolsJson, turn2.requests[0]!.toolsJson, 'the tools block does not change');
});

test('a desk tool dispatched before a same-source rebuild still climbs the next turn', async () => {
  const sessionId = 'turn-desk-miss-before-rebuild';
  const turn1 = await hostTurn(sessionId, TARGETED, [() => ({ name: 'check_in', args: { note: 'Starting now.' } })]);
  assert.equal(deskRecord(sessionId, turn1.source.seq)?.rung, 'lean');
  assert.match(turn1.outputs.get(turn1.callId(0)) ?? '', /Check-in posted/, 'the bare-name call reached the handler');
  // A re-entry on the same source (an approval resume, a retry) records the
  // same desk again after the dispatch.
  const rebuilt = await buildFor(sessionId, turn1.source.seq, TARGETED, idleModel);
  assert.equal(toolsBytes(rebuilt), toolsBytes(turn1.agent), 'the re-entry keeps its desk');
  const turn2 = await hostTurn(sessionId, TARGETED, []);
  const desk2 = deskRecord(sessionId, turn2.source.seq);
  assert.equal(desk2?.rung, 'full', `the miss climbs the next turn: ${JSON.stringify(desk2)}`);
  assert.ok(desk2?.missed.includes('check_in'), JSON.stringify(desk2));
});

test('the session floor survives any number of out-of-scope builds between two ordinary turns', async () => {
  const sessionId = 'turn-desk-floor-past-out-of-scope';
  const turn1 = await hostTurn(sessionId, TARGETED, [], ATTACHED);
  assert.equal(deskRecord(sessionId, turn1.source.seq)?.rung, 'readers');
  const act = acceptSource(sessionId, TARGETED);
  await buildFor(sessionId, act.seq, TARGETED, idleModel, { acceptedRoute: 'act' });
  const actScope = eventlog.listEvents(sessionId, { sinceSeq: act.seq, types: ['tool_search_scope'] }).at(-1);
  assert.equal((actScope?.data as { desk?: DeskRecord }).desk?.fallbackReason, 'out_of_scope');
  // A long act source rebuilds many times; each build records its own scope.
  for (let index = 0; index < 80; index += 1) {
    eventlog.appendEvent({ sessionId, turn: 0, role: 'system', type: 'tool_search_scope', data: actScope!.data as Record<string, unknown> });
  }
  const turn2 = await hostTurn(sessionId, TARGETED, []);
  const desk2 = deskRecord(sessionId, turn2.source.seq);
  assert.equal(desk2?.rung, 'readers', `the floor is the previous in-scope source's rung: ${JSON.stringify(desk2)}`);
  assert.equal(turn2.requests[0]!.toolsJson, turn1.requests[0]!.toolsJson, 'the ordinary turn reuses its tools block');
});

const multiItem = await import('./multi-item-intent.js');
const contextPacket = await import('./context-packet.js');
const FANOUT = 'For each of these 8 accounts: Acme, Globex, Initech, Umbrella, Hooli, Stark, Wayne, Wonka, look up their latest invoice and draft a follow-up email.';

// run_worker declares no desk rung: a carried run_worker takes a different
// consent path from a direct call, so it rides every rung with its schema.
test('a turn whose context packet offers fan-out with run_worker carries run_worker\'s schema in round one', async () => {
  const intent = multiItem.detectMultiItemIntent(FANOUT);
  assert.ok(intent.isMultiItem, 'the packet owner detects the multi-item request');
  assert.match(contextPacket.fanoutDirectiveLine(intent, 4), /run_worker/, 'the packet directive names run_worker');
  const sessionId = 'turn-desk-fanout';
  const run = await hostTurn(sessionId, FANOUT, []);
  assert.equal(deskRecord(sessionId, run.source.seq)?.fallbackReason, null, 'the turn is in scope');
  assert.ok(run.requests[0]!.tools.includes('run_worker'), `run_worker rides round 1: ${run.requests[0]!.tools.join(',')}`);
  assert.ok(!namesLine(run.requests[0]!.instructions).includes('run_worker'), 'run_worker is not an on-request tool');
});

/** A local operation this session already used on an earlier source: the
 * planning catalog seeds the next source's card from it, so that card holds a
 * capability. */
function discloseEarlierLocalOperation(sessionId: string, identifier: string) {
  const earlier = acceptSource(sessionId, TARGETED);
  eventlog.appendEvent({
    sessionId, turn: earlier.turn, role: 'system', type: 'capability_discovered',
    data: { sourceUserSeq: earlier.seq, capabilities: [{ identifier, providerKind: 'authorized_local_registry' }] },
  });
}

test('a remembered read capability stays callable without promoting the session to delegation', async () => {
  const sessionId = 'turn-desk-remembered-read';
  discloseEarlierLocalOperation(sessionId, 'space_get');
  const source = acceptSource(sessionId, TARGETED);
  const primed = await (await import('../semantic-boundary/admit-and-compile-accepted-source.js'))
    .primePrimaryModelPlanningCatalog({ sessionId, sourceUserSeq: source.seq });
  assert.ok(primed.ok && primed.planning.capabilities.length > 0,
    `the host-fresh planning card holds a capability: ${JSON.stringify(primed.ok ? primed.planning.capabilities.map((entry) => entry.id) : primed)}`);
  const agent = await buildFor(sessionId, source.seq, TARGETED, idleModel);
  const desk = deskRecord(sessionId, source.seq);
  assert.equal(desk?.fallbackReason, null, 'the turn is in scope');
  assert.equal(desk?.rung, 'lean', `discovery is not delegation: ${JSON.stringify(desk)}`);
  assert.ok(!desk?.climbedBy.includes('delegation'));
  assert.deepEqual(deferredOn(agent), DESK_TOOLS);
  assert.ok(agentTools(agent).some((tool) => tool.name === 'run_worker' && !tool.deferLoading), 'new fan-out remains first class');
  const read = await hostTurn(sessionId, 'Read the retained workspace metadata.', [
    () => ({ name: 'call_tool', args: { name: 'space_get', args_json: JSON.stringify({ slug: 'desk-test-absent' }) } }),
  ]);
  assert.equal(deskRecord(sessionId, read.source.seq)?.rung, 'lean');
  assert.ok(namesLine(read.requests[0]!.instructions).includes('tool_search'), 'the rendered prompt names the deferred-schema door');
  assert.match(read.outputs.get(read.callId(0)) ?? '', /No workspace named/, 'the known read reaches its real handler');
});

test('recorded direct and carried delegation retain the full desk after database reopen', async () => {
  for (const carried of [false, true]) {
    const sessionId = `turn-desk-actual-delegation-${carried}`;
    const earlier = acceptSource(sessionId, FANOUT);
    eventlog.appendEvent({
      sessionId, turn: earlier.turn, role: 'tool', type: 'tool_called',
      data: { sourceUserSeq: earlier.seq, tool: carried ? 'call_tool' : 'run_worker',
        ...(carried ? { effectiveTool: 'run_worker' } : {}), callId: `worker-${carried}` },
    });
    eventlog.closeEventLog();
    const source = acceptSource(sessionId, 'Continue the pending work.');
    const agent = await buildFor(sessionId, source.seq, 'Continue the pending work.', idleModel);
    const desk = deskRecord(sessionId, source.seq);
    assert.equal(desk?.rung, 'full');
    assert.ok(desk?.climbedBy.includes('delegation'));
    assert.deepEqual(deferredOn(agent), [], 'delegation readers and progress tools keep their schemas');
  }
});

test('unfinished long work retains the full desk without any discovered capability or worker call', async () => {
  const sessionId = 'turn-desk-pending-manifest';
  acceptSource(sessionId, 'Prepare the requested records.');
  const { declareWorkManifest } = await import('./work-manifest.js');
  declareWorkManifest({ sessionId, manifestId: 'pending', contractVersion: 1,
    phases: [{ id: 'read' }], items: [{ id: 'item-a' }, { id: 'item-b' }] });
  eventlog.closeEventLog();
  const source = acceptSource(sessionId, 'Continue the pending work.');
  const agent = await buildFor(sessionId, source.seq, 'Continue the pending work.', idleModel);
  const desk = deskRecord(sessionId, source.seq);
  assert.equal(desk?.rung, 'full');
  assert.ok(desk?.climbedBy.includes('long_work'));
  assert.deepEqual(deferredOn(agent), []);
});

/** Longer than every inline presentation budget, so it is shown in part. */
const LONG_NOTES_PATH = path.join(TEST_HOME, 'long-notes.md');
writeFileSync(LONG_NOTES_PATH, Array.from({ length: 400 }, (_, index) => `Line ${index + 1}: the quarry ledger row for item ${index + 1} holds tonnage ${1000 + index}.`).join('\n'), 'utf-8');

test('a result shown whole keeps the next turn on the lean rung with the same tools block', async () => {
  const sessionId = 'turn-desk-small-result';
  const opening = await hostTurn(sessionId, TARGETED, [() => ({ name: 'workspace_roots', args: {} })]);
  assert.equal(deskRecord(sessionId, opening.source.seq)?.rung, 'lean');
  assert.ok(eventlog.getToolOutput(sessionId, opening.callId(0)), 'the small result was retained');
  const next = await hostTurn(sessionId, TARGETED, []);
  assert.equal(deskRecord(sessionId, next.source.seq)?.rung, 'lean', 'a whole result is no reason to preload the readers');
  assert.equal(next.requests[0]!.toolsJson, opening.requests[0]!.toolsJson, 'the tools block is byte-identical');
});

test('a result shown only in part puts the readers on the next turn\'s first request', async () => {
  const sessionId = 'turn-desk-long-result';
  const opening = await hostTurn(sessionId, TARGETED, [() => ({ name: 'read_file', args: { path: LONG_NOTES_PATH } })]);
  assert.equal(deskRecord(sessionId, opening.source.seq)?.rung, 'lean');
  assert.ok((eventlog.getToolOutput(sessionId, opening.callId(0))?.output.length ?? 0) > 4_000, 'a long result was retained');
  const next = await hostTurn(sessionId, TARGETED, []);
  const desk = deskRecord(sessionId, next.source.seq);
  assert.equal(desk?.rung, 'readers', JSON.stringify(desk));
  assert.ok(desk?.climbedBy.includes('retained_output'), JSON.stringify(desk));
  assert.deepEqual(READERS.filter((name) => !next.requests[0]!.tools.includes(name)), [], `readers ride round 1: ${next.requests[0]!.tools.join(',')}`);
});
