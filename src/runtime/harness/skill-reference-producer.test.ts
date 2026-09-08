import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-skill-reference-producer-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(home, 'state'), { recursive: true });
const events = await import('./eventlog.js');
const { gatherSessionSkills, renderSkillReference } = await import('./skill-execution.js');
const { withToolOutputContext } = await import('./tool-output-context.js');
const { getLocalRuntimeTools } = await import('../../tools/local-runtime-tools.js');
const { acceptedTaskIdFor } = await import('./attempt-identity.js');
const { buildCallTool } = await import('../../tools/call-tool.js');
const { wrapToolForHarness, withHarnessRunContext, ToolCallsCounter } = await import('./brackets.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const { attachEventLogHooks, extractSessionIdFromContext } = await import('./hooks.js');
const { buildObjectiveJudgePrompt } = await import('./objective-judge.js');
const { loadSkill } = await import('../../memory/skill-store.js');
const { DEFAULT_TOOL_RESULT_MAX_CHARS } = await import('./tool-output-format.js');

after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });
let serial = 0;
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function install(name: string, body: string) {
  const dir = path.join(home, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Reusable reference fixture\n---\n${body}`);
  return loadSkill(name)!.body;
}
function source(sessionId: string, text: string) {
  const event = events.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  assert.ok(recordTurnGraphShadow({ identity: { sessionId, sourceUserSeq: event.seq, turn: 1 } }));
  return event.seq;
}
async function readSkillInvocation(sessionId: string, sourceUserSeq: number, name: string, carrier = false) {
  const local = getLocalRuntimeTools().find((tool) => tool.name === 'skill_read')!;
  const wrapped = (carrier
    ? wrapToolForHarness(buildCallTool({ reachableBuiltinNames: new Set(['skill_read']) }) as never)
    : local) as unknown as { invoke(context: unknown, input: string, details: unknown): Promise<unknown> };
  const callId = `skill-producer-${++serial}`;
  const args = carrier ? { name: 'skill_read', args_json: JSON.stringify({ name }) } : { name };
  const emitter = new EventEmitter();
  const detach = attachEventLogHooks(emitter, { getSessionId: extractSessionIdFromContext, getTurn: () => 1 });
  const runContext = { context: { sessionId, sourceUserSeq, turn: 1 } };
  const tool = { name: carrier ? 'call_tool' : 'skill_read' };
  const details = { toolCall: { callId, arguments: JSON.stringify(args) } };
  let output: unknown;
  try {
    output = await withHarnessRunContext({ sessionId, sourceUserSeq, turn: 1, counter: new ToolCallsCounter(10) }, async () => {
      emitter.emit('agent_tool_start', runContext, { name: 'Clem' }, tool, details);
      const result = carrier ? await wrapped.invoke(runContext, JSON.stringify(args), details)
        : await withToolOutputContext({ sessionId, sourceUserSeq, callId, toolName: tool.name, settlementNonce: randomUUID() },
          () => wrapped.invoke(runContext, JSON.stringify(args), details));
      emitter.emit('agent_tool_end', runContext, { name: 'Clem' }, tool, result, details);
      return result;
    });
  } finally { detach(); }
  const authority = events.resolveToolOutputForAuthority(sessionId, callId);
  return { callId, output: String(output), authority };
}
async function readSkill(sessionId: string, sourceUserSeq: number, name: string, carrier = false) {
  const result = await readSkillInvocation(sessionId, sourceUserSeq, name, carrier);
  assert.equal(result.authority.status, 'ok', JSON.stringify(result.authority));
  if (result.authority.status !== 'ok') throw new Error('Expected authentic retained skill result');
  return { ...result, authority: result.authority };
}

test('real native producers retain full source/version references across SQLite reopen', async () => {
  const session = events.createSession({ kind: 'chat' });
  const a = source(session.id, 'Inspect the reporting framework; do not run or publish it.');
  const name = 'versioned-framework';
  const bodyA = install(name, 'Run scripts/generate-html.js only when producing this report.\n'
    + 'Reference detail: café — preserve each line.\n'.repeat(1_800)
    + '\n---\n\nFRAMEWORK_A_TAIL: Preserve this full section and its whitespace.\n');
  assert.ok(bodyA.length > DEFAULT_TOOL_RESULT_MAX_CHARS);
  const first = await readSkill(session.id, a, name);
  assert.ok(first.authority.record.output.includes(bodyA), 'the real adapter retains the entire body');
  assert.ok(gatherSessionSkills(session.id).length, JSON.stringify(gatherSessionSkills(session.id, { includeUnavailable: true })));
  assert.equal(first.authority.record.truncatedAtWrite, false);
  const b = source(session.id, 'Compare the newer reporting framework with the previous one; do not execute either.');
  const bodyB = install(name, 'Version B changes the procedure.\nRun scripts/render-v2.js when adopted.\n'
    + 'Complete version B reference.\n'.repeat(700) + 'FRAMEWORK_B_TAIL');
  const second = await readSkill(session.id, b, name);
  const repeat = await readSkill(session.id, b, name);
  const c = source(session.id, 'Use the original version A framework from our first request for this report.');
  install(name, 'Version C now exists on disk but has never been read by this session.');
  events.closeEventLog();
  const references = gatherSessionSkills(session.id, { sourceUserSeq: c, includeUnavailable: true });
  assert.equal(references.length, 2);
  const versionA = references.find((ref) => ref.bodyDigest === hash(bodyA))!;
  const versionB = references.find((ref) => ref.bodyDigest === hash(bodyB))!;
  assert.ok(versionA && versionB, JSON.stringify(references));
  assert.equal(versionA.body, bodyA);
  assert.equal(versionB.body, bodyB);
  assert.equal(versionA.origins?.[0].sourceUserSeq, a);
  assert.equal(versionA.origins?.[0].outputDigest, hash(first.authority.record.output));
  assert.equal(versionA.origins?.[0].invocationNonce, first.authority.record.invocationNonce);
  assert.deepEqual(versionB.origins?.map((o) => o.callId), [second.callId, repeat.callId]);
  assert.ok(versionB.origins?.every((o) => o.sourceUserSeq === b && o.scope === 'prior_source'));
  assert.ok(references.every((ref) => ref.evidenceStatus === 'verified'));
  assert.ok(renderSkillReference(versionA).includes(bodyA));
  const current = gatherSessionSkills(session.id, { sourceUserSeq: b });
  assert.equal(current[0].body, bodyB, 'ordering presents current reads first without discarding the old requested version');
  assert.equal(current[0].origins?.[0].scope, 'current_source');
  const prompt = buildObjectiveJudgePrompt('Use original version A from our first request.', 'Here is the report.',
    { skills: references, fullSourceEvidence: true });
  assert.ok(prompt.includes(bodyA) && prompt.includes(bodyB));
  assert.doesNotMatch(prompt, /Version C now exists/);
  assert.match(prompt, /prior_source/);
});

test('unknown, missing, and reused-call evidence never invents current-source framework authority', async () => {
  const session = events.createSession({ kind: 'chat' });
  const acceptedSource = source(session.id, 'Inspect the framework.');
  const name = 'authority-framework';
  const body = install(name, 'Reference body with a required step only if the owner adopts it.');
  const first = await readSkill(session.id, acceptedSource, name);
  const called = events.listEvents(session.id, { types: ['tool_called'] }).find((e) => e.data.callId === first.callId)!;
  const db = events.openEventLog();
  db.prepare("UPDATE events SET data_json = json_remove(data_json, '$.sourceUserSeq') WHERE session_id = ? AND json_extract(data_json, '$.callId') = ?")
    .run(session.id, first.callId);
  const unattributed = gatherSessionSkills(session.id, { sourceUserSeq: acceptedSource, includeUnavailable: true });
  assert.ok(unattributed[0], JSON.stringify(events.listEvents(session.id, { types: ['tool_called', 'tool_returned'] })));
  assert.equal(unattributed[0].body, body);
  assert.equal(unattributed[0].origins?.[0].scope, 'unknown');
  assert.equal(unattributed[0].origins?.[0].sourceUserSeq, null, 'the latest user event cannot supply missing read lineage');
  events.appendEvent({ sessionId: session.id, turn: 2, role: 'agent', type: 'tool_called', data: { ...called.data, accounting: 'top_level' } });
  const ambiguous = gatherSessionSkills(session.id, { sourceUserSeq: acceptedSource, includeUnavailable: true });
  assert.ok(ambiguous.every((ref) => ref.evidenceStatus === 'unavailable' && ref.body === ''));
  assert.ok(ambiguous.every((ref) => ref.origins?.every((origin) => origin.scope === 'unknown')));
  assert.deepEqual(gatherSessionSkills(session.id), [], 'ordinary successful-reference consumers do not ingest unavailable placeholders');
  events.appendEvent({ sessionId: session.id, turn: 2, role: 'agent', type: 'tool_called', data: {
    tool: 'skill_read', callId: 'missing-reference-output', arguments: JSON.stringify({ name: 'not-retained' }), effect: 'read', sourceUserSeq: acceptedSource,
  } });
  const missing = gatherSessionSkills(session.id, { sourceUserSeq: acceptedSource, includeUnavailable: true }).find((ref) => ref.name === 'not-retained')!;
  assert.equal(missing.evidenceStatus, 'unavailable');
  assert.equal(missing.body, '');
  assert.equal(missing.origins?.[0].scope, 'unknown');
});

test('production host_v1 call_tool retains the full skill behind its canonical source settlement', async () => {
  const { runConversation } = await import('./loop.js');
  const host = await import('./host-turn-runner.js');
  const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
  const { sourceSettledReadEvidence } = await import('./host-completion-work.js');
  const name = 'host-reference-framework';
  const body = install(name, 'Run scripts/generate-html.js when the owner asks to produce this report.\n'
    + 'Full host framework detail café.\n'.repeat(2_000) + 'HOST_FRAMEWORK_DECISIVE_TAIL');
  const prompt = `Inspect and compare the installed ${name} framework only. Explain what it does; do not run scripts or write a report.`;
  const session = events.createSession({ kind: 'chat' });
  const attempt = events.beginRunAttempt(session.id, { runId: 'host-skill-reference-producer' });
  const accepted = events.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: prompt } }, { armRunInFlight: true });
  let requests = 0;
  let judged = 0;
  host.captureEffectiveCompletionPolicyOnce({ sessionId: session.id, sourceUserSeq: accepted.seq, enabled: true });
  host._setHostObjectiveJudgeForTests(async (objective, _reply, context) => {
    judged += 1;
    assert.equal(objective, prompt);
    assert.equal(context?.skills.find((ref) => ref.name === name)?.body, body);
    assert.ok(buildObjectiveJudgePrompt(objective, _reply, context).includes(body));
    return { done: true, reason: 'The accepted job is inspection and comparison; no producer execution or report was requested.' };
  });
  const model = {
    async getResponse() {
      requests += 1;
      const output = requests === 1
        ? [{ type: 'function_call', name: 'call_tool', callId: 'host-skill-read', arguments: JSON.stringify({
          name: 'skill_read', args_json: JSON.stringify({ name }),
        }) }]
        : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
          text: JSON.stringify({ summary: 'Framework inspected.', reply: 'The framework generates the requested report when adopted. Inspection is complete; no report was requested or written.', done: true, nextAction: 'completed', reason: null }) }] }];
      return { responseId: `host-skill-response-${requests}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2,
        requests: 1, inputTokensDetails: [], outputTokensDetails: [] }, output };
    },
    async *getStreamedResponse() {
      const response = await this.getResponse();
      yield { type: 'response_started' } as never;
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    },
  };
  let result: Awaited<ReturnType<typeof runConversation>>;
  try { result = await runConversation({ sessionId: session.id, input: prompt, sourceUserSeq: accepted.seq,
    reuseRecordedUserInput: true, runAttemptId: attempt.attemptId, turnEngine: 'host_v1', maxSteps: 1,
    maxTurns: 4, toolCallsPerTurn: 4, judgeCompletion: true,
    buildAgent: async (identity) => buildOrchestratorAgent({ sessionId: identity.sessionId,
      sourceUserSeq: identity.sourceUserSeq, hostFreshPlanning: identity.hostFreshPlanning, userInput: prompt, allowToolJit: true,
      mcpToolScope: { authority: 'none', reason: 'isolated real skill producer test', allowedServerSlugs: [], toolPatterns: [], maxTools: 0 },
      model: model as never }),
    makeRunner: () => Object.assign(new EventEmitter(), { run() { throw new Error('Legacy runner must not execute'); } }) as never,
  }); } finally { host._setHostObjectiveJudgeForTests(null); }
  const evidence = sourceSettledReadEvidence({ sessionId: session.id, sourceUserSeq: accepted.seq });
  assert.ok(evidence.results.some((row) => row.toolName === 'skill_read' && row.status === 'verified'),
    JSON.stringify({ status: result.status, presentation: result.publicPresentation, evidence, trace: events.listEvents(session.id).map((event) => ({type:event.type,data:event.data})).filter((event) => /tool|guardrail|plan/.test(event.type)) }));
  const references = gatherSessionSkills(session.id, { sourceUserSeq: accepted.seq, includeUnavailable: true });
  assert.equal(references.find((reference) => reference.name === name)?.body, body,
    JSON.stringify({ references, evidence: evidence.results }));
  assert.equal(requests, 2, 'read/answer does not force a renderer continuation');
  assert.equal(judged, 1, 'the existing reviewer judges inspection once without forcing execution');
  assert.equal(result.status, 'completed');
  const origin = references.find((reference) => reference.name === name)!.origins![0];
  const retained = evidence.results.find((row) => row.toolName === 'skill_read')!;
  assert.equal(origin.authority, 'settlement');
  assert.equal(origin.scope, 'current_source');
  assert.equal(origin.resultHandleId, retained.resultHandleId);
  assert.equal(origin.physicalDispatchId, retained.physicalDispatchId);
  assert.equal(origin.outputDigest, retained.contentDigest);
  assert.equal(origin.acceptedTaskId, acceptedTaskIdFor(session.id, accepted.seq));
  events.closeEventLog();
  assert.deepEqual(gatherSessionSkills(session.id, { sourceUserSeq: accepted.seq, includeUnavailable: true }), references);
  const called = events.listEvents(session.id, { types: ['tool_called'] });
  assert.equal(called.filter((event) => event.data.tool === 'plan_task' || event.data.tool === 'run_shell_command').length, 0);
  const readCall = called.find((event) => event.data.callId === 'host-skill-read')!;
  const originalData = JSON.stringify(readCall.data);
  events.openEventLog().prepare('UPDATE events SET data_json = ? WHERE id = ?').run(JSON.stringify({ ...readCall.data,
    arguments: JSON.stringify({ name: 'skill_read', args_json: JSON.stringify({ name: 'a-different-framework' }) }) }), readCall.id);
  const mismatchedName = gatherSessionSkills(session.id, { sourceUserSeq: accepted.seq, includeUnavailable: true });
  assert.equal(mismatchedName[0].evidenceStatus, 'unavailable');
  assert.match(mismatchedName[0].evidenceReason ?? '', /arguments do not match/);
  events.openEventLog().prepare('UPDATE events SET data_json = ? WHERE id = ?').run(originalData, readCall.id);
  assert.throws(() => events.openEventLog().prepare('UPDATE physical_dispatches SET tool_name = ? WHERE session_id = ? AND physical_dispatch_id = ?')
    .run('unrelated_tool', session.id, origin.physicalDispatchId), /physical dispatch identity is immutable/);
  const db = events.openEventLog();
  const trigger = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='durable_result_handles' AND sql LIKE '%durable result handles are immutable%'").get() as { name: string; sql: string };
  assert.ok(trigger);
  // Fault injection below the immutable API in this disposable database.
  db.exec(`DROP TRIGGER ${trigger.name}`);
  try { db.prepare('UPDATE durable_result_handles SET raw_payload_json = ? WHERE handle_id = ?')
    .run(JSON.stringify('tampered framework'), origin.resultHandleId); }
  finally { db.exec(trigger.sql); }
  const corruptedCrossing = gatherSessionSkills(session.id, { sourceUserSeq: accepted.seq, includeUnavailable: true });
  assert.equal(corruptedCrossing[0].evidenceStatus, 'unavailable', 'broken canonical proof cannot fall back to legacy bytes');
  assert.equal(corruptedCrossing[0].body, '');
});


test('legacy call_tool without canonical result authority stays explicitly unavailable', async () => {
  const session = events.createSession({ kind: 'chat' });
  const seq = source(session.id, 'Inspect the legacy reference.');
  const name = 'legacy-carrier-reference';
  install(name, 'Legacy retained framework body.\n'.repeat(900));
  const result = await readSkillInvocation(session.id, seq, name, true);
  assert.equal(result.authority.status, 'ambiguous', JSON.stringify(result.authority));
  if (result.authority.status !== 'ambiguous') throw new Error('Expected ambiguous legacy invocation authority');
  assert.equal(result.authority.invocationCount, 2, 'the legacy outer and inner results cannot be silently selected as canonical authority');
  const references = gatherSessionSkills(session.id, { sourceUserSeq: seq, includeUnavailable: true });
  assert.equal(references.length, 1);
  assert.equal(references[0].name, name);
  assert.equal(references[0].evidenceStatus, 'unavailable');
  assert.equal(references[0].body, '');
  assert.equal(references[0].origins?.[0].scope, 'unknown');
});
