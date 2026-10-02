/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/host-stall-after-content.test.ts
 *
 * Once an answer has started streaming, only what that stream delivers counts
 * as progress. Wire-level liveness (provider keepalive frames, or another
 * request in the same run) keeps a queued provider alive before it starts,
 * but it cannot hold a stalled answer open until the response wall.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-stall-after-content-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_SEMANTIC_RECALL = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_MODEL_STREAM_STALL_MS = '400';
process.env.CLEMMY_MODEL_FIRST_BYTE_STALL_MS = '400';
process.env.CLEMMY_MODEL_STALL_FALLOVER_GRACE_MS = '0';
process.env.CLEMMY_MODEL_STREAM_STALL_RETRIES = '0';
process.env.CLEMMY_MODEL_RESPONSE_WALL_MS = '30000';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-host-stall-after-content\n', 'utf8');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const { hostRunRunner } = await import('./host-turn-runner.js');

const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();
after(() => {
  catalogs.installHostCapabilityCatalogFactory(priorCatalog);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('legacy Runner.run must remain unreachable');
  };
  return runner;
}

test('keepalive frames after the answer started do not hold a stalled answer open', async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  const prompt = 'Say hello in one short sentence.';
  const session = eventlog.createSession({ id: 'host-stall-after-content', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: prompt },
  });

  let keepaliveRunning = false;
  const model = {
    async getResponse() { throw new Error('this fixture only streams'); },
    async *getStreamedResponse(request: { signal?: AbortSignal }) {
      yield { type: 'response_started' } as never;
      yield { type: 'output_text_delta', delta: 'Hel' } as never;
      // The answer started, then stopped. The provider keeps the connection
      // alive with frames that carry no content, for far longer than the
      // stall window.
      keepaliveRunning = true;
      const until = Date.now() + 8_000;
      try {
        while (Date.now() < until && !request.signal?.aborted) {
          const context = brackets.harnessRunContextStorage.getStore();
          if (context) {
            context.privateModelActivityAt = Date.now();
            context.latestProviderStreamEvent = 'ping';
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } finally {
        keepaliveRunning = false;
      }
    },
  };
  const agent = await buildOrchestratorAgent({
    userInput: prompt, sessionId: session.id, sourceUserSeq: source.seq,
    allowedToolNames: [],
    mcpToolScope: { authority: 'none', reason: 'stall fixture has no external authority', allowedServerSlugs: [], toolPatterns: [], maxTools: 0 },
    model: model as never,
  });
  const parent = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1, counter: new brackets.ToolCallsCounter(4), behaviorScopeId: `${session.id}::turn:1` };

  const startedAt = Date.now();
  await brackets.withHarnessRunContext(parent, () => hostRunRunner(
    throwingRunner() as never, agent as never, [{ role: 'user', content: prompt }] as never,
    { maxTurns: 2, hostTurnEngine: 'host_v1', context: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 } } as never,
  )).catch((error: unknown) => error);
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 5_000, `the stall window ended the step, not keepalives or the wall (${elapsed} ms)`);
  // Let the fixture's own loop observe the abort before the test ends.
  for (let i = 0; i < 40 && keepaliveRunning; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
});
