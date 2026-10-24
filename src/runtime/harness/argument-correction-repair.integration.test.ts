/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/argument-correction-repair.integration.test.ts
 *
 * Real host_v1 runner and the real read_file tool: a read carrying a value a
 * learned record says its tool rejects goes without it, the host journals the
 * repair, and the next model request says what changed and that the call
 * already ran. The fake model only records what it is sent.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-argument-correction-repair-'));
process.env.CLEMENTINE_HOME = home;
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(home, 'state'), { recursive: true });

const events = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const envelopes = await import('../../agents/capability-envelope.js');
const { getComputerTools } = await import('../../tools/computer-tools.js');
const { hostRunRunner } = await import('./host-turn-runner.js');
const store = await import('../../memory/argument-corrections-store.js');

const STORE = path.join(home, 'argument-corrections.json');
after(() => { store._setArgumentCorrectionStorePathForTests(null); events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

test('a read carrying a learned rejected value goes without it, and the model is told', async () => {
  store._setArgumentCorrectionStorePathForTests(STORE);
  store.saveArgumentCorrections([{
    operation: 'read_file', effect: 'read', argument: 'max_chars', rejectedValue: 5, fix: { kind: 'omit' },
    error: 'max_chars 5 is not accepted here', pairs: 2,
    firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
  }]);
  const filesDir = path.join(home, 'files');
  mkdirSync(filesDir, { recursive: true });
  const notePath = path.join(filesDir, 'note.md');
  writeFileSync(notePath, 'fixture note WHOLE-NOTE-TAIL', 'utf8');
  const calls = [{ callId: 'read-1', args: { path: notePath, max_chars: 5 } }];
  const session = events.createSession({ id: 'sess-argument-correction-repair', kind: 'chat' });
  const text = 'Read the note.';
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  const requests: string[] = [];
  const model = {
    async *getStreamedResponse(request: unknown) {
      const response = await this.getResponse(request);
      yield { type: 'response_started' };
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } };
    },
    async getResponse(request: unknown) {
      requests.push(JSON.stringify(request));
      const next = calls[requests.length - 1];
      return {
        responseId: `response-${requests.length}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: next
          ? [{ type: 'function_call', callId: next.callId, name: 'read_file', arguments: JSON.stringify(next.args) }]
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Read.' }] }],
      };
    },
  };
  const readFile = brackets.wrapToolForHarness(getComputerTools().find((candidate) => candidate.name === 'read_file')! as never);
  const agent = { model, tools: [readFile] };
  const sealed = envelopes.sealAgentCapabilityUniverse({
    sessionId: session.id, universeTools: [readFile as never], activeToolNames: ['read_file'], policyHash: 'argument-correction-repair',
    budget: { maxUncachedTokens: 100000, maxModelCalls: 6, maxToolCalls: 6, maxElapsedMs: 60000 },
  });
  assert.ok(sealed.ok, JSON.stringify(sealed));
  if (!sealed.ok) return;
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const runner = Object.assign(new EventEmitter(), { run() { throw new Error('legacy runner forbidden'); } });
  await brackets.withHarnessRunContext({
    sessionId: session.id, sourceUserSeq: source.seq,
    counter: new brackets.ToolCallsCounter(6), behaviorScopeId: `${session.id}::turn:1`,
  }, () => hostRunRunner(runner as never, agent as never, [{ role: 'user', content: text }] as never, {
    maxTurns: 6, hostTurnEngine: 'host_v1', context: { sessionId: session.id, sourceUserSeq: source.seq },
  } as never));
  assert.ok(requests.length >= 2, `two model requests (got ${requests.length})`);
  assert.ok(requests[1]!.includes('Host repair for call read-1: read_file rejected max_chars=5 2 times before'),
    'the next request says what the host changed');
  assert.ok(requests[1]!.includes('That call already ran in the repaired form'));
  const repairs = events.listEvents(session.id, { types: ['guardrail_tripped'] })
    .filter((event) => event.data.kind === store.ARGUMENT_CORRECTION_APPLIED);
  assert.deepEqual(repairs.map((event) => [event.data.callId, event.data.argument, event.data.rejectedValue]), [['read-1', 'max_chars', 5]]);
  // The model's own call stays in its history as it wrote it; what ran is the
  // repaired call, whose result answers for a read without max_chars.
  const result = JSON.parse(requests[1]!).input.find((item: { type?: string; callId?: string }) =>
    item.type === 'function_call_result' && item.callId === 'read-1');
  assert.match(JSON.stringify(result), /WHOLE-NOTE-TAIL/, 'the read ran without the 5-character preview the rejected value asked for');
});
