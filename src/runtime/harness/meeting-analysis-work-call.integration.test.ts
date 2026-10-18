/** The real discovery/planning/consent/local-dispatch path, with only model
 * output scripted and all meeting/task storage inside the disposable home. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { RunContext } from '@openai/agents';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-meeting-work-call-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.HARNESS_TOOL_BRACKETS = 'on';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-meeting-analysis-work-call\n');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const envelopes = await import('../../agents/capability-envelope.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const manifests = await import('./capability-manifest-store.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const localPlanning = await import('./local-planning-capability.js');
const { buildScopedLocalToolSearch } = await import('../../tools/local-runtime-tools.js');
const planTools = await import('../../tools/plan-tools.js');
const { buildWorkCall } = await import('../../tools/work-call.js');
const { hostRunRunner } = await import('./host-turn-runner.js');
const meetings = await import('../../integrations/recall/meeting-capture.js');
const contract = await import('../../integrations/recall/meeting-analysis-contract.js');
const tasks = await import('../../execution/background-tasks.js');
const { closeMemoryDb } = await import('../../memory/db.js');

after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  manifests.installCapabilityManifestStore(null);
  eventlog.closeEventLog();
  closeMemoryDb();
  rmSync(HOME, { recursive: true, force: true });
});

const analysis = {
  title: 'Fixture planning', summary: 'The fixture team discussed a preview.',
  decisions: ['Review the preview.'], actionItems: [{ text: 'Review preview', owner: null, dueDate: null }],
  topics: ['Preview'], participants: ['Fixture Speaker'],
};

function finalized(id: string) {
  meetings.noteRecallMeetingDetected({ windowId: id, platform: 'zoom', status: 'recording' });
  meetings.appendRecallTranscriptSegment({ windowId: id, event: 'transcript.data', speaker: 'Fixture Speaker',
    text: 'We will review the preview.', isFinal: true });
  const { record } = meetings.finalizeRecallMeeting({ windowId: id });
  meetings.patchMeetingRecord(record.id, { canonicalStatus: 'ready' });
  return meetings.loadRecallMeetingById(record.id)!;
}

function modelScript(responses: unknown[][]) {
  let calls = 0;
  return {
    async getResponse() {
      const output = responses[Math.min(calls++, responses.length - 1)];
      return { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1,
        inputTokensDetails: [], outputTokensDetails: [] }, output, responseId: `fixture-${calls}` };
    },
    async *getStreamedResponse() {
      const response = await this.getResponse();
      yield { type: 'response_started' };
      yield { type: 'model', event: { type: 'finish', finishReason: response.output!.some(
        item => (item as { type?: string }).type === 'function_call') ? 'tool_calls' : 'stop' } };
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } };
    },
  };
}
const call = (callId: string, name: string, args: unknown) => ({
  type: 'function_call', callId, name, arguments: JSON.stringify(args),
});

test('discovered canonical meeting save enters exact local consent, commits once and attests its own accepted source', async () => {
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  const record = finalized('planned-save');
  const requiredOutput = contract.captureMeetingAnalysisRequirement(record);
  const task = tasks.createBackgroundTask({ title: 'Fixture analysis', prompt: 'Save structured analysis for the named fixture meeting.',
    source: 'daemon', channel: 'electron:meeting-capture', requiredOutput });
  assert.ok(tasks.markBackgroundTaskRunning(task.id));
  const source = eventlog.appendEvent({ sessionId: task.runSessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: `Analyze finalized meeting ${record.id} and save its structured analysis.` } });
  const identity = { sessionId: task.runSessionId, sourceUserSeq: source.seq, turn: 1 };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, JSON.stringify(primed));
  if (!primed.ok) return;
  const search = buildScopedLocalToolSearch(new Set(['meeting_analysis_save']), 'work_call', undefined, undefined,
    candidates => semantic.disclosePrimaryModelPlanningCapabilities({ authority: primed.planning.authority, candidates }));
  const discovered = JSON.parse(String(await search.invoke(new RunContext({ sessionId: task.runSessionId }),
    JSON.stringify({ query: 'meeting_analysis_save', role_key: null, limit: 8, account_selection: null })))) as {
      results: Array<{ name: string; capabilityRef?: string; carrier?: string; planningRefusalReason?: string }>;
    };
  const row = discovered.results.find(entry => entry.name === 'meeting_analysis_save');
  assert.equal(row?.capabilityRef, 'cap:local:meeting_analysis_save:ordinary');
  assert.equal(row?.carrier, 'work_call');
  assert.equal(row?.planningRefusalReason, undefined);
  const definition = await localPlanning.observeCurrentLocalPlanningDefinition({ name: 'meeting_analysis_save', carrier: 'work_call' });
  assert.equal(definition.ok, true);
  if (definition.ok) {
    assert.equal(definition.definition.descriptor.effect, 'local_write');
    assert.equal(definition.definition.accountIdentity, 'local_registry:host');
    assert.equal(definition.definition.reversibility, 'ordinary_non_destructive');
    assert.ok(definition.definition.schemaFingerprint);
  }
  const planTask = brackets.wrapToolForHarness(planTools.buildPlanTaskTool({ planning: primed.planning }) as never);
  const workCall = brackets.wrapToolForHarness(buildWorkCall({ requireHostPlan: true,
    reachableBuiltinNames: new Set(['meeting_analysis_save']), firstClassNames: new Set<string>(),
    catalogIdentifiers: ['meeting_analysis_save'], settlementLane: 'byo', hostPlanningReady: () => true }) as never);
  const plan = { preamble: 'I’ll save the fixture meeting summary.', draft: {
    criteria: ['Canonical structured analysis is saved for the exact finalized meeting.'], cardinality: null,
    destination: { posture: 'named_existing', family: 'meeting', handleRequired: true },
    topology: { version: 1, operations: [{ id: 'save_analysis', effect: 'local_write', coverage: null,
      dependsOn: [], dataFrom: [], cardinality: { kind: 'once' } }], universes: [] },
    bindings: [{ operationId: 'save_analysis', role: 'destination', capabilityRef: row!.capabilityRef, evidence: ['tool_result'] }],
    deliverables: [{ id: 'meeting_summary', kind: 'meeting' }], evidenceRequirements: ['tool_result'],
  } };
  const work = { requirement_id: 'save_analysis', universe_item_id: null, universe_selector: null, seal_amendment: null,
    name: 'meeting_analysis_save', args_json: JSON.stringify({ meeting_id: record.id, analysis }) };
  const model = modelScript([[call('plan-analysis', 'plan_task', plan)], [call('save-analysis', 'work_call', work)],
    [call('replay-analysis', 'work_call', work)], [{ type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'The fixture meeting analysis is saved.' }] }]]);
  const tools = [planTask, workCall];
  const agent = { model, tools };
  const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId: task.runSessionId, universeTools: tools,
    activeToolNames: tools.map(tool => tool.name), policyHash: 'meeting-analysis-work-call-fixture-v1',
    budget: { maxUncachedTokens: 2_000, maxModelCalls: 8, maxToolCalls: 8, maxElapsedMs: 60_000 } });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  if (!sealed.ok) return;
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => { throw new Error('Legacy runner must not own this turn.'); };
  const outcome = await brackets.withHarnessRunContext({ ...identity, counter: new brackets.ToolCallsCounter(8) },
    () => hostRunRunner(runner as never, agent as never,
      [{ type: 'message', role: 'user', content: source.data.text }] as never,
      { maxTurns: 5, hostTurnEngine: 'host_v1', context: identity } as never));
  const saved = meetings.loadRecallMeetingAnalysis(record.id);
  assert.equal(saved?.summary, analysis.summary, JSON.stringify(outcome.history));
  assert.equal(saved?.completionEvidence?.meetingId, record.id);
  assert.equal(saved?.completionEvidence?.sessionId, task.runSessionId);
  assert.equal(saved?.completionEvidence?.sourceUserSeq, source.seq);
  assert.equal(saved?.completionEvidence?.transcriptDigest, requiredOutput.transcriptDigest);
  assert.equal(saved?.completionEvidence?.contentDigest, contract.meetingAnalysisContentDigest(analysis));
  assert.ok(saved?.completionEvidence?.logicalCallId);
  assert.equal(contract.verifyMeetingAnalysisOutput({ requiredOutput, runSessionId: task.runSessionId,
    sourceExists: (sessionId, sourceUserSeq) => Boolean(eventlog.getUserInputEventAtSequence(sessionId, sourceUserSeq)) }).ok, true);
  const crossings = eventlog.openEventLog().prepare(`SELECT logical_tool_call_id, tool_name, state FROM physical_dispatches
    WHERE session_id = ? AND source_user_seq = ? AND tool_name = 'meeting_analysis_save'`).all(task.runSessionId, source.seq);
  assert.equal(crossings.length, 1, JSON.stringify(crossings));
  assert.equal((crossings[0] as { state: string }).state, 'returned');
  const settlements = eventlog.openEventLog().prepare(`SELECT logical_tool_call_id, outcome_kind, physical_crossing_count, host_crossing_count FROM logical_call_settlements
    WHERE session_id = ? AND source_user_seq = ? AND mutating = 1 ORDER BY settled_at, logical_tool_call_id`).all(task.runSessionId, source.seq);
  assert.deepEqual(settlements.map(row => (row as { outcome_kind: string }).outcome_kind), ['succeeded', 'policy_denial']);
  assert.deepEqual(settlements.map(row => (row as { physical_crossing_count: number }).physical_crossing_count), [0, 0], 'saving a local meeting is not provider traffic');
  assert.deepEqual(settlements.map(row => (row as { host_crossing_count: number }).host_crossing_count), [1, 0], JSON.stringify({ crossings, settlements }));
  assert.match(readFileSync(record.artifactPath!, 'utf8'), /The fixture team discussed a preview/);
});
