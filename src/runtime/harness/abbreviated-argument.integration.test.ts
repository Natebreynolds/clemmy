/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/abbreviated-argument.integration.test.ts
 *
 * Real host_v1 runner and the real read_file tool: a result returns an opaque
 * token, the next call passes it shortened with "...", and the request after
 * that carries the host's note naming the full token whole. The fake model
 * only records what it is sent.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-abbreviated-argument-'));
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

after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

test('a shortened opaque value in the next call gets the full value named in the request after it', async () => {
  const token = Buffer.from(JSON.stringify({ v: 1, list: 'https://records.example/v1/items', skip: '5000', top: '1000' })).toString('base64');
  const filesDir = path.join(home, 'files');
  mkdirSync(filesDir, { recursive: true });
  const pagePath = path.join(filesDir, 'page.json');
  writeFileSync(pagePath, JSON.stringify({ items: [{ id: 'row-1' }], next: token }), 'utf8');
  const shortened = `${token.slice(0, 48)}...5000`;
  const calls = [
    { callId: 'read-page', args: { path: pagePath } },
    { callId: 'read-shortened', args: { path: shortened } },
  ];
  const session = events.createSession({ id: 'sess-abbreviated-argument', kind: 'chat' });
  const text = 'Read the page file and then the next page.';
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
    sessionId: session.id, universeTools: [readFile as never], activeToolNames: ['read_file'], policyHash: 'abbreviated-argument',
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
  assert.ok(requests.length >= 3, `three model requests (got ${requests.length})`);
  assert.equal(requests[1]!.includes('shortened with'), false, 'no note before a shortened value is sent');
  assert.ok(requests[2]!.includes('Call read-shortened passed path shortened with'), 'the request after the shortened call carries the note');
  assert.ok(requests[2]!.includes(token), 'the full token is named whole');
  assert.equal(events.listEvents(session.id, { types: ['guardrail_tripped'] })
    .filter((event) => event.data.kind === 'abbreviated_argument').length, 1);
});
