/**
 * A local write to a credential file (an `.env`) is the one local change that
 * still asks: the turn opens a card for it. Approving that card must land the
 * write. Live 2026-09-30 it did not: the resume carried the owner's exact
 * grant but no native handoff for the graphless local call, so the work
 * carrier refused the approved call and the owner's yes went nowhere.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/sensitive-write-card.integration.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-sensitive-write-'));
Object.assign(process.env, {
  CLEMENTINE_HOME: HOME,
  CLEMMY_TEST_ISOLATED_HOME: '1',
  CLEMMY_TEST_DISABLE_LIVE_MODELS: '1',
  MCP_AUTO_IMPORT_ENABLED: 'false',
  EMBEDDINGS_DISABLED: 'true',
  OPENAI_AGENTS_DISABLE_TRACING: '1',
  CLEMMY_COMPLETION_REVIEW: 'off',
  AUTH_MODE: 'codex_oauth',
  MODEL_ROUTING_MODE: 'off',
  CLEMMY_MODEL_ROLES: '[]',
  HARNESS_TOOL_BRACKETS: 'on',
  CLEMMY_TOOL_JIT: 'on',
  CLEMMY_CODEX_TOOL_SEARCH: 'on',
  CLEMMY_UNIFIED_RECALL: 'off',
  CLEMMY_UNIFIED_TURN_PRIMER: 'off',
  CLEMMY_SEMANTIC_RECALL: 'off',
  CLEMMY_DEBATE_MODE: 'off',
});
delete process.env.TYPESAFE_API_KEY;
delete process.env.CLEMMY_JEV;
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-sensitive-write\n');
const WORK = path.join(HOME, 'work');
mkdirSync(WORK, { recursive: true });

const eventlog = await import('./eventlog.js');
const { runConversation, runConversationFromResume } = await import('./loop.js');
const { buildOrchestratorAgent, buildOrchestratorAgentForApprovalResume } = await import('../../agents/orchestrator.js');
const semanticPorts = await import('../semantic-boundary/turn-semantic-port-registry.js');
const approvalRegistry = await import('./approval-registry.js');

semanticPorts.installTurnSemanticModelPort(null);

const TARGET = path.join(WORK, '.env');
const CONTENT = 'FIXTURE_TOKEN=not-a-real-secret\n';
const WRITE_ARGS = { path: TARGET, content: CONTENT, mode: 'create' };

after(() => {
  semanticPorts.installTurnSemanticModelPort(null);
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

type Frame = { tools: string[]; toolResults: string[] };
type Output = Record<string, unknown>;

const text = (content: string): Output => ({
  type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content }],
});
const call = (callId: string, name: string, args: Record<string, unknown>): Output => ({
  type: 'function_call', callId, name, arguments: JSON.stringify(args),
});
const writeCall = (callId: string): Output => call(callId, 'work_call', {
  requirement_id: 'cap:local:write_file:create', source_call_ids: null, source_record_ids: null,
  universe_item_id: null, universe_selector: null, seal_amendment: null,
  name: 'write_file', args_json: JSON.stringify(WRITE_ARGS),
});

function scriptedBrain(script: Output[][]) {
  const frames: Frame[] = [];
  return {
    frames,
    async getResponse(rawRequest: unknown) {
      const request = rawRequest as { tools?: Array<{ name?: string }>; input?: unknown };
      const items = Array.isArray(request.input) ? request.input as Array<Record<string, unknown>> : [];
      frames.push({
        tools: (request.tools ?? []).map((tool) => tool.name ?? ''),
        toolResults: items
          .filter((item) => item.type === 'function_call_result' || item.type === 'function_call_output')
          .map((item) => typeof item.output === 'string' ? item.output : JSON.stringify(item.output)),
      });
      const output = script[Math.min(frames.length - 1, script.length - 1)]!;
      return {
        responseId: `sensitive-write-${frames.length}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
        output,
      };
    },
    async *getStreamedResponse(request: unknown) {
      const response = await this.getResponse(request);
      yield { type: 'response_started' } as never;
      yield {
        type: 'model',
        event: { type: 'finish', finishReason: response.output.some((item) => item.type === 'function_call') ? 'tool_calls' : 'stop' },
      } as never;
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    },
  };
}

async function runHostTurn(input: { sessionId: string; sourceUserSeq: number; runAttemptId: string; request: string; script: Output[][] }) {
  const brain = scriptedBrain(input.script);
  const result = await runConversation({ sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq, input: input.request,
    reuseRecordedUserInput: true, runAttemptId: input.runAttemptId, turnEngine: 'host_v1', maxSteps: 1, maxTurns: 6,
    toolCallsPerTurn: 8, judgeCompletion: false,
    buildAgent: async (context) => buildOrchestratorAgent({ sessionId: context.sessionId,
      sourceUserSeq: context.sourceUserSeq, hostFreshPlanning: context.hostFreshPlanning, userInput: input.request,
      allowToolJit: true, model: brain as never }),
    makeRunner: () => Object.assign(new EventEmitter(), { run() { throw new Error('Legacy runner must not execute'); } }) as never,
  });
  return { result, frames: brain.frames, trace: eventlog.listEvents(input.sessionId) };
}

test('a credential-file write asks once, and the approved card lands the write', async () => {
  const REQUEST = 'Write the fixture token into .env in the work folder.';
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'sensitive write' });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: `sensitive-write:${session.id}` });
  const accepted = eventlog.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: {
    text: REQUEST, taskMode: { version: 1, kind: 'normal' },
  } }, { armRunInFlight: true });
  const first = await runHostTurn({ sessionId: session.id, sourceUserSeq: accepted.seq, runAttemptId: attempt.attemptId, request: REQUEST, script: [
    [writeCall('call-write')],
    [text('The write is waiting for your approval.')],
  ] });
  const debug = JSON.stringify({ status: first.result.status, frames: first.frames, events: first.trace.map((e) => e.type).slice(-40) }).slice(0, 8_000);

  // Nothing landed; the turn opened one card for the write.
  assert.equal(existsSync(TARGET), false, debug);
  assert.equal(first.result.status, 'awaiting_approval', debug);
  const approvals = first.trace.filter((event) => event.type === 'approval_requested');
  assert.equal(approvals.length, 1, debug);
  const approvalId = String(approvals[0]!.data.approvalId);

  // The owner approves the card. The desktop resumes the paused turn under
  // the owner's exact grant: the harness runs the paused call itself and the
  // model is shown what landed; it does not have to call anything again.
  const resolved = approvalRegistry.resolve(approvalId, 'approved', 'desktop-chat-card');
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  const brain = scriptedBrain([[text('Written.')]]);
  const resumed = await runConversationFromResume({
    sessionId: session.id, approvalId, decision: 'approve', resolver: 'desktop-chat-card', turnEngine: 'host_v1',
    maxTurns: 4, judgeCompletion: false,
    makeRunner: () => Object.assign(new EventEmitter(), { run() { throw new Error('Legacy runner must not execute'); } }) as never,
    buildAgent: (identity) => buildOrchestratorAgentForApprovalResume({
      sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq, acceptedRoute: identity.route,
      ...('hostFreshPlanning' in identity && identity.hostFreshPlanning ? { hostFreshPlanning: identity.hostFreshPlanning as never } : {}),
      model: brain as never, allowToolJit: true,
    }),
  });
  const resumeDebug = JSON.stringify({ status: resumed.status, error: resumed.error, frames: brain.frames,
    events: eventlog.listEvents(session.id).map((e) => e.type).slice(-40),
    guardrails: eventlog.listEvents(session.id, { types: ['guardrail_tripped', 'run_failed', 'approval_requested', 'run_paused'] }).map((e) => ({ type: e.type, kind: e.data.kind, reason: e.data.reason, detail: e.data.detail, error: e.data.error, tool: e.data.tool, subject: e.data.subject, approvalId: e.data.approvalId, consent: e.data.consentCall })) }).slice(0, 12_000);

  // The owner's yes landed the write, once, with the exact bytes.
  assert.equal(existsSync(TARGET), true, resumeDebug);
  assert.equal(readFileSync(TARGET, 'utf8'), CONTENT, resumeDebug);
  const db = eventlog.openEventLog();
  const dispatches = db.prepare('SELECT tool_name, state FROM physical_dispatches WHERE session_id = ? AND tool_name = ? ORDER BY rowid')
    .all(session.id, 'write_file') as Array<{ tool_name: string; state: string }>;
  assert.deepEqual(dispatches, [{ tool_name: 'write_file', state: 'returned' }], resumeDebug);
  assert.equal(eventlog.listEvents(session.id, { types: ['approval_requested'] }).length, 1, 'no second card for the same write');
  assert.equal(resumed.status, 'completed', resumeDebug);
  // The model was told what landed, not asked to do it over.
  assert.match(brain.frames[0]?.toolResults.join('\n') ?? '', /committed|wrote|revision|bytes/i, resumeDebug);
  assert.doesNotMatch(brain.frames[0]?.toolResults.join('\n') ?? '', /work_contract_required|not yet published/, resumeDebug);
});
