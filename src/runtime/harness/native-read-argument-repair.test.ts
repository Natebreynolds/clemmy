import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-native-read-args-'));
const fixtureWorkspace = path.join(fixtureHome, 'workspace');
const scripts = path.join(fixtureWorkspace, 'scripts');
const originalCwd = process.cwd();
mkdirSync(scripts, { recursive: true });
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
writeFileSync(path.join(scripts, 'requested-script.txt'), 'Only this directory was requested.\n');
writeFileSync(path.join(fixtureWorkspace, 'WRONG_CWD_SENTINEL.txt'), 'Must not appear in the repaired read.\n');
Object.assign(process.env, { CLEMENTINE_HOME: fixtureHome, CLEMMY_TEST_ISOLATED_HOME: '1',
  MCP_AUTO_IMPORT_ENABLED: 'false', EMBEDDINGS_DISABLED: 'true', OPENAI_AGENTS_DISABLE_TRACING: '1',
  CLEMMY_COMPLETION_REVIEW: 'off', AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off',
  WORKSPACE_DIRS: fixtureWorkspace, CLEMMY_MODEL_ROLES: '[]' });
process.chdir(fixtureWorkspace);
const originalFetch = globalThis.fetch;
let providerRequests = 0;
globalThis.fetch = async () => { providerRequests++; throw new Error('No real provider calls permitted in native read fixture'); };
const events = await import('./eventlog.js');
const { runConversation } = await import('./loop.js');
const host = await import('./host-turn-runner.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const { sourceSettledReadEvidence } = await import('./host-completion-work.js');
const { durableLogicalCallContract } = await import('./logical-call-contract.js');
const { acceptedTaskIdFor } = await import('./attempt-identity.js');
const { prepareNativeToolArguments, materializeLocalRuntimeToolArguments } = await import('../../tools/call-tool.js');
after(() => {
  events.closeEventLog();
  process.chdir(originalCwd);
  globalThis.fetch = originalFetch;
  rmSync(fixtureHome, { recursive: true, force: true });
});

async function journey(control: 'direct' | 'repair' | 'reused-call' | 'forged-field' | 'effect-upgrade' | 'unknown-repair' | 'unknown-repeat' | 'unknown-loop' | 'unknown-write' = 'repair') {
  const skillName = `native-read-${control}`;
  const skillDir = path.join(fixtureHome, 'skills', skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${skillName}\ndescription: Isolated read-only fixture.\n---\n\nInspect ${scripts} for scripts; do not execute them.\n`);
  const prompt = `Inspect ${skillName} and its scripts. Then ask which report I want planned. Do not execute scripts or create a report.`;
  const session = events.createSession({ kind: 'chat' });
  const attempt = events.beginRunAttempt(session.id, { runId: `native-read-${control}:${session.id}` });
  const accepted = events.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: {
    text: prompt, taskMode: { version: 1, kind: 'plan' },
  } }, { armRunInFlight: true });
  const identity = { sessionId: session.id, sourceUserSeq: accepted.seq };
  host.captureEffectiveCompletionPolicyOnce({ ...identity, enabled: false });
  let brainRequests = 0;
  const forbiddenWrite = path.join(fixtureWorkspace, 'effect-upgrade-must-not-exist.txt');
  const advertised: string[][] = [];
  const model = {
    async getResponse(request?: { tools?: Array<{ name?: string }> }) {
      advertised.push((request?.tools ?? []).map(tool => tool.name ?? ''));
      brainRequests++;
      const third = (control === 'effect-upgrade' || control === 'unknown-write')
        ? { name: 'write_file', args: { path: forbiddenWrite, content: 'Unauthorized Plan effect.', mode: 'create', append: false } }
        : control.startsWith('unknown-') ? { name: 'skill_read', args: { name: skillName } }
        : { name: 'list_files', args: { directory: scripts,
          ...(control === 'forged-field' ? { hostCallAttestation: { effect: 'admin', sourceUserSeq: accepted.seq + 1 } } : {}) } };
      const steps = control === 'direct' ? [
        { name: 'list_files', args: { directory: scripts, limit: null } },
        { name: 'read_file', args: { path: path.join(scripts, 'requested-script.txt'), max_chars: null } },
      ] : [control.startsWith('unknown-') ? { name: 'read_file', args: { path: path.join(skillDir, 'SKILL.md') } } : { name: 'skill_read', args: { name: skillName } },
        control.startsWith('unknown-') ? { name: 'skill_read', args: { name: skillName } } : { name: 'list_files', args: { path: scripts } }, third,
        ...(control === 'unknown-repeat' ? [third] : control === 'unknown-loop' ? [third, third, third] : [])];
      const next = steps[brainRequests - 1];
      const callId = control === 'reused-call' && brainRequests === 3 ? 'native-call-2' : `native-call-${brainRequests}`;
      const unpublished = control.startsWith('unknown-') && (brainRequests === 2
        || (control === 'unknown-repeat' && brainRequests === 3)
        || (control === 'unknown-loop' && brainRequests > 1));
      const output = next ? [{ type: 'function_call', name: unpublished || control === 'direct' ? next.name : 'call_tool', callId,
        arguments: JSON.stringify(unpublished || control === 'direct' ? next.args : { name: next.name, args_json: JSON.stringify(next.args) }) }]
        : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
          text: 'ASK: Which report would you like me to plan?' }] }];
      return { responseId: `native-response-${brainRequests}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2,
        requests: 1, inputTokensDetails: [], outputTokensDetails: [] }, output };
    },
    async *getStreamedResponse(request?: { tools?: Array<{ name?: string }> }) {
      const response = await this.getResponse(request);
      yield { type: 'response_started' } as never;
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    },
  };
  const result = await runConversation({ ...identity, input: prompt, reuseRecordedUserInput: true,
    runAttemptId: attempt.attemptId, turnEngine: 'host_v1', maxSteps: 1, maxTurns: 6, toolCallsPerTurn: 8, judgeCompletion: false,
    buildAgent: async (context) => buildOrchestratorAgent({ sessionId: context.sessionId,
      sourceUserSeq: context.sourceUserSeq, hostFreshPlanning: context.hostFreshPlanning, userInput: prompt, allowToolJit: true,
      mcpToolScope: { authority: 'none', reason: 'isolated production native carrier', allowedServerSlugs: [], toolPatterns: [], maxTools: 0 },
      model: model as never }),
    makeRunner: () => Object.assign(new EventEmitter(), { run() { throw new Error('Legacy runner must not execute'); } }) as never,
  });
  if (control === 'unknown-loop' && result.status === 'held') {
    // More than one checkpoint hop belongs to the durable timer owner. Observe
    // its actual terminal instead of mistaking the first held return for one.
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline && !events.listEvents(session.id).some(event =>
      event.type === 'conversation_completed' && event.data.sourceUserSeq === accepted.seq)) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(events.listEvents(session.id).some(event => event.type === 'conversation_completed'
      && event.data.sourceUserSeq === accepted.seq), 'the durable recovery owner must reach a terminal');
    const requestsAtTerminal = brainRequests;
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(brainRequests, requestsAtTerminal, 'the timer cannot start late work after its terminal');
  }
  const db = events.openEventLog();
  const rows = db.prepare(`SELECT l.*, s.outcome_kind, s.mutating, s.physical_crossing_count, s.host_crossing_count,
      s.requires_reconciliation FROM logical_tool_calls l LEFT JOIN logical_call_settlements s
      ON s.session_id=l.session_id AND s.source_user_seq=l.source_user_seq AND s.logical_tool_call_id=l.logical_tool_call_id
      WHERE l.session_id=?`).all(session.id) as Array<Record<string, unknown>>;
  const authority = db.prepare('SELECT state FROM accepted_turn_call_authorities WHERE session_id=? AND source_user_seq=?')
    .get(session.id, accepted.seq) as { state: string };
  const checkpoint = db.prepare('SELECT history_json FROM accepted_model_batch_checkpoints WHERE session_id=? AND source_user_seq=? ORDER BY batch_ordinal DESC LIMIT 1').get(session.id, accepted.seq) as { history_json: string } | undefined;
  return { identity, result, brainRequests, rows, authority, forbiddenWrite, advertised,
    checkpointHistory: checkpoint ? JSON.parse(checkpoint.history_json) as Array<{type?: string;callId?: string}> : [],
    trace: events.listEvents(session.id) };
}

test('production Plan inspects native files directly with the actual schemas and no discovery or repair', async () => {
  const run = await journey('direct');
  assert.ok(run.advertised[0]!.includes('list_files'));
  assert.ok(run.advertised[0]!.includes('read_file'));
  assert.equal(run.brainRequests, 3);
  assert.equal(run.result.status, 'awaiting_user_input');
  assert.equal(run.rows.length, 2);
  assert.ok(run.rows.every(row => row.outcome_kind === 'succeeded' && row.host_crossing_count === 1 && row.mutating === 0));
  const evidence = sourceSettledReadEvidence(run.identity);
  assert.match(evidence.summary, /Only this directory was requested/);
  assert.doesNotMatch(evidence.summary, /WRONG_CWD_SENTINEL/);
  assert.equal(providerRequests, 0);
});

test('production Plan skill inspection refuses a wrong core read field and repairs without poisoning accepted authority', async () => {
  const run = await journey();
  assert.equal(run.brainRequests, 4, 'the model receives its exact schema refusal and can correct the next call');
  assert.equal(run.result.status, 'awaiting_user_input', 'the owner requested a question after inspection');
  assert.notEqual(run.authority.state, 'conflict');
  const bad = run.rows.find(row => row.logical_tool_call_id === 'native-call-2')!;
  const fixed = run.rows.find(row => row.logical_tool_call_id === 'native-call-3')!;
  assert.equal(bad.state, 'settled');
  assert.equal(bad.outcome_kind, 'invalid_arguments');
  assert.equal(bad.effective_argument_digest, null, 'invalid data is never frozen as a resolved contract');
  assert.equal(bad.physical_crossing_count, 0);
  assert.equal(bad.host_crossing_count, 0);
  assert.equal(bad.mutating, 0);
  assert.equal(bad.requires_reconciliation, 0);
  const raw = durableLogicalCallContract(acceptedTaskIdFor(run.identity.sessionId, run.identity.sourceUserSeq), 'call_tool', {
    name: 'list_files', args_json: JSON.stringify({ path: scripts }),
  });
  assert.ok(raw);
  assert.equal(bad.raw_argument_digest, raw.argumentDigest, 'the refused carrier keeps its exact original source/call contract');
  assert.equal(fixed.outcome_kind, 'succeeded');
  assert.equal(fixed.host_crossing_count, 1);
  assert.equal(fixed.physical_crossing_count, 0);
  assert.equal(fixed.mutating, 0);
  assert.notEqual(fixed.raw_argument_digest, fixed.effective_argument_digest, 'the allowed null materialization is a recorded exact refinement');
  const refusal = run.trace.find(row => row.type === 'tool_returned' && row.data.callId === 'native-call-2' && typeof row.data.result === 'string')!;
  const diagnostic = JSON.parse(String(refusal.data.result));
  assert.equal(diagnostic.error, 'arg_validation');
  assert.deepEqual(diagnostic.violations, ['path']);
  assert.equal(diagnostic.schema.additionalProperties, false);
  assert.ok(diagnostic.schema.properties.directory);
  assert.ok(!run.trace.some(row => row.type === 'logical_call_contract_refined' && row.data.logicalToolCallId === 'native-call-2'));
  const evidence = sourceSettledReadEvidence(run.identity);
  assert.match(evidence.summary, /requested-script.txt/);
  assert.doesNotMatch(evidence.summary, /WRONG_CWD_SENTINEL/);
  assert.equal(providerRequests, 0);
});

test('host pre-binding and final native carrier prepare the same exact core arguments', async () => {
  const result = await prepareNativeToolArguments('list_files', { directory: scripts });
  assert.equal(result.status, 'prepared');
  if (result.status !== 'prepared') throw new Error('preparation failed');
  assert.deepEqual(result.args, { directory: scripts, limit: null });
  assert.deepEqual(await materializeLocalRuntimeToolArguments('list_files', { directory: scripts }), { args: result.args });
  for (const args of [{ path: scripts }, { directory: scripts, limit: 501 }, { directory: 42 },
    { directory: scripts, hostCallAttestation: { effect: 'admin' } }]) {
    const invalid = await prepareNativeToolArguments('list_files', args);
    assert.equal(invalid.status, 'invalid', JSON.stringify(args));
    assert.equal(await materializeLocalRuntimeToolArguments('list_files', args), null);
  }
});

test('schema repair does not permit a reused logical call ID with different argument bytes', async () => {
  const run = await journey('reused-call');
  assert.equal(run.brainRequests, 3);
  assert.equal(run.rows.filter(row => row.tool_name === 'list_files').length, 1);
  assert.equal(run.rows.find(row => row.tool_name === 'list_files')?.outcome_kind, 'invalid_arguments');
  assert.equal(run.rows.some(row => row.tool_name === 'list_files' && row.host_crossing_count === 1), false);
});

test('a model-authored attestation field remains invalid input and cannot confer source or effect authority', async () => {
  const run = await journey('forged-field');
  assert.equal(run.brainRequests, 4);
  const reads = run.rows.filter(row => row.tool_name === 'list_files');
  assert.equal(reads.length, 2);
  assert.ok(reads.every(row => row.outcome_kind === 'invalid_arguments' && row.host_crossing_count === 0));
  assert.notEqual(run.authority.state, 'conflict');
});

test('repairing a read does not upgrade Plan authority into a write', async () => {
  const run = await journey('effect-upgrade');
  assert.equal(existsSync(run.forbiddenWrite), false);
  assert.equal(run.rows.some(row => row.tool_name === 'write_file' && row.outcome_kind === 'succeeded'), false);
  assert.equal(run.trace.some(row => row.type === 'tool_returned' && row.data.tool === 'write_file' && row.data.ok === true), false);
});

test('an unpublished bare native name repairs through the configured carrier in the same accepted Plan source', async () => {
  const run = await journey('unknown-repair');
  assert.equal(run.result.status, 'awaiting_user_input');
  assert.equal(run.brainRequests, 4);
  assert.ok(!run.advertised[1]!.includes('skill_read'), 'the refusal control calls a genuinely unpublished name');
  assert.ok(run.advertised[2]!.includes('call_tool'), 'repair retains the configured carrier');
  assert.ok(run.advertised[2]!.includes('tool_search'), 'exact schema discovery remains callable');
  assert.equal(run.rows.filter(row => row.tool_name === 'skill_read').length, 1);
  assert.equal(run.rows.find(row => row.tool_name === 'skill_read')?.outcome_kind, 'succeeded');
  assert.ok(run.rows.every(row => row.source_user_seq === run.identity.sourceUserSeq));
  assert.notEqual(run.authority.state, 'conflict');
});

test('a repeated unpublished recovery call resumes after its completed checkpoint, never re-admits its frame', async () => {
  const run = await journey('unknown-repeat');
  assert.equal(run.result.status, 'awaiting_user_input');
  assert.equal(run.brainRequests, 5);
  assert.notEqual(run.authority.state, 'conflict');
  const calls = run.checkpointHistory.filter(item => item.type === 'function_call').map(item => item.callId);
  const results = run.checkpointHistory.filter(item => item.type === 'function_call_result').map(item => item.callId);
  assert.equal(new Set(calls).size, calls.length, 'one canonical call per model-emitted call ID');
  assert.equal(new Set(results).size, results.length, 'one result per canonical call');
  assert.deepEqual(calls, results, 'every completed frame is balanced exactly once');
  assert.equal(run.rows.filter(row => row.tool_name === 'skill_read' && row.outcome_kind === 'succeeded').length, 1);
});

test('a genuinely repeated unpublished call exhausts the same repair budget across completed checkpoints', async () => {
  const run = await journey('unknown-loop');
  assert.equal(run.result.status, 'held', 'the first caller hands additional checkpoint hops to durable recovery');
  const { validTypedCompletionPresentation } = await import('./public-presentation.js');
  const terminals = run.trace.filter(event => event.type === 'conversation_completed')
    .map(event => validTypedCompletionPresentation(event.data, run.identity.sessionId));
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.status, 'blocked');
  assert.equal(terminals[0]?.identity.sourceUserSeq, run.identity.sourceUserSeq);
  // Five governed attempts, then exactly one host-owned check-in: a chat turn
  // the no-progress governor exhausts no longer ends on the engine's typed
  // stop, it spends one tool-free request telling the person what stopped it
  // (loop.ts modelCheckInForExhaustedTurn, 2026-09-09). The governor proof is
  // the repair ledger below, not this count.
  assert.equal(run.brainRequests, 6, 'five governed attempts plus one check-in request');
  const checkIns = run.trace.filter(event => event.type === 'guardrail_tripped'
    && event.data.kind === 'no_progress_check_in');
  assert.equal(checkIns.length, 1, 'the sixth request is the check-in, asked once');
  assert.equal(checkIns[0]?.data.why, 'governor_exhausted');
  assert.notEqual(run.authority.state, 'conflict');
  assert.equal(run.rows.some(row => row.tool_name === 'skill_read' && row.host_crossing_count === 1), false);
  assert.ok(run.rows.every(row => Number(row.mutating ?? 0) === 0));
  assert.ok(run.rows.every(row => row.source_user_seq === run.identity.sourceUserSeq));
  const repairs = run.trace.filter(event => event.type === 'guardrail_tripped'
    && event.data.kind === 'no_progress_decision' && event.data.attemptClass === 'zero_crossing_repair');
  assert.deepEqual(repairs.map(event => event.data.retriesRemaining), [2, 1, 0, 0]);
  assert.deepEqual(repairs.map(event => event.data.action), ['continue', 'continue', 'continue', 'terminalize']);
  assert.ok(repairs.every(event => Array.isArray(event.data.gained) && event.data.gained.length === 0));
  assert.equal(new Set(repairs.map(event => event.data.consequenceKey)).size, 1);
  const calls = run.checkpointHistory.filter(item => item.type === 'function_call').map(item => item.callId);
  const results = run.checkpointHistory.filter(item => item.type === 'function_call_result').map(item => item.callId);
  assert.equal(new Set(calls).size, calls.length);
  assert.equal(new Set(results).size, results.length);
  assert.deepEqual(calls, results, 'recovery preserves one paired result per completed call');
});

test('repair discovery and carrier availability never grants a Plan write', async () => {
  const run = await journey('unknown-write');
  assert.ok(run.advertised[2]!.includes('call_tool'));
  assert.equal(existsSync(run.forbiddenWrite), false);
  assert.equal(run.rows.some(row => row.tool_name === 'write_file' && row.outcome_kind === 'succeeded'), false);
  assert.ok(run.rows.every(row => Number(row.mutating ?? 0) === 0));
});

test('actual host producer receipt places the prior public question after its retained read evidence', async () => {
  const run = await journey('repair');
  assert.equal(run.result.status, 'awaiting_user_input');
  const { validTypedCompletionPresentation } = await import('./public-presentation.js');
  const terminal = run.trace.filter(event => event.type === 'conversation_completed')
    .map(event => validTypedCompletionPresentation(event.data, run.identity.sessionId))
    .find(presentation => presentation?.identity.sourceUserSeq === run.identity.sourceUserSeq);
  assert.ok(terminal, 'the actual committer produced a typed public terminal for the exact source');
  assert.match(terminal.text, /^Which report would you like me to plan\?/);
  const next = events.appendEvent({ sessionId: run.identity.sessionId, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Separate question: what is 9 plus 4? Just give me the answer here.', taskMode: { version: 1, kind: 'normal' } } });
  const { replayMissingPublicTurns } = await import('./session-public-replay.js');
  events.closeEventLog();
  const original = run.checkpointHistory as import('@openai/agents').AgentInputItem[];
  const merged = replayMissingPublicTurns({ sessionId: run.identity.sessionId, sourceUserSeq: next.seq, history: original });
  assert.equal(JSON.stringify(merged.slice(0, original.length)), JSON.stringify(original), 'reopen preserves every original tool byte and its order');
  const recovered = merged.slice(original.length) as Array<{ role?: string; status?: string; content?: unknown }>;
  assert.ok(recovered.some(item => item.role === 'assistant' && item.status === 'completed'
    && Array.isArray(item.content) && item.content.length === 1
    && item.content[0]?.type === 'output_text' && item.content[0]?.text === terminal.text),
    'the complete public terminal, including retained-work evidence, follows its authenticated current-source reads');
  assert.ok(!recovered.some(item => item.role === 'system'), 'public assistant prose is never promoted to system authority');
  assert.ok(!JSON.stringify(recovered).includes('Separate question'), 'the new source is not duplicated into prior history');
});
