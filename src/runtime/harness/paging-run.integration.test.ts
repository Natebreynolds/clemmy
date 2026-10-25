/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/paging-run.integration.test.ts
 *
 * Real host_v1 runner and the real read_file tool: each page names the next,
 * the model reads on page after page, and from the third page the request
 * after it carries the host's note on what paging costs. The fake model only
 * records what it is sent.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-paging-run-'));
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

test('the third page of the same list carries the host\'s note on what paging costs', async () => {
  const filesDir = path.join(home, 'files');
  mkdirSync(filesDir, { recursive: true });
  const pages = [1, 2, 3, 4].map((n) => path.join(filesDir, `page-${n}.json`));
  pages.forEach((page, index) => writeFileSync(page, JSON.stringify({ items: [{ id: `row-${index}` }], next: pages[index + 1] ?? null }), 'utf8'));
  const calls = pages.slice(0, 3).map((page, index) => ({ callId: `read-page-${index + 1}`, args: { path: page, max_chars: null } }));
  const session = events.createSession({ id: 'sess-paging-run', kind: 'chat' });
  const text = 'Read the first page file and follow its next pages.';
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
    sessionId: session.id, universeTools: [readFile as never], activeToolNames: ['read_file'], policyHash: 'paging-run',
    budget: { maxUncachedTokens: 100000, maxModelCalls: 8, maxToolCalls: 8, maxElapsedMs: 60000 },
  });
  assert.ok(sealed.ok, JSON.stringify(sealed));
  if (!sealed.ok) return;
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const runner = Object.assign(new EventEmitter(), { run() { throw new Error('legacy runner forbidden'); } });
  await brackets.withHarnessRunContext({
    sessionId: session.id, sourceUserSeq: source.seq,
    counter: new brackets.ToolCallsCounter(8), behaviorScopeId: `${session.id}::turn:1`,
  }, () => hostRunRunner(runner as never, agent as never, [{ role: 'user', content: text }] as never, {
    maxTurns: 8, hostTurnEngine: 'host_v1', context: { sessionId: session.id, sourceUserSeq: source.seq },
  } as never));
  assert.ok(requests.length >= 4, `four model requests (got ${requests.length})`);
  assert.equal(requests[2]!.includes('of the same read_file list'), false, 'two pages are not yet a paging run');
  assert.ok(requests[3]!.includes('Call read-page-3 reads the same read_file list at another position (read 3 of it'), 'the request after page 3 carries the note');
  assert.equal(events.listEvents(session.id, { types: ['guardrail_tripped'] })
    .filter((event) => event.data.kind === 'paging_run').length, 1);
});
