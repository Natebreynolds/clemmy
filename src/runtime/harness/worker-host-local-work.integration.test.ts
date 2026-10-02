/** A WORKER DOES ORDINARY LOCAL WORK (2026-10-02). Only the child model is
 * scripted: the parent's ordinary chat turn, the real worker surface from
 * buildWorkerAgent, the host turn runner, consent, native run_shell_command
 * and write_file, and settlement are all production code.
 *
 * Live 10-02: a saved design agent, handed a brief through run_worker, was
 * refused `mkdir` (the shell was sealed as a read) and then write_file (no
 * local definition was prepared in a worker), so its design existed only in
 * its reply. Local changes are ordinary work in a worker exactly as in chat;
 * what leaves the machine still does not run here. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-worker-local-work-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_WATCHER_JUDGE = 'off';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'worker-local-work-fixture\n');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const { withLogicalToolCall } = await import('./attempt-identity.js');
const { runPacketWorkerWithHost } = await import('./worker-host-runner.js');
const { buildWorkerAgent } = await import('../../agents/sub-agents.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();
after(() => {
  catalogs.installHostCapabilityCatalogFactory(priorCatalog);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function* modelStream(this: { getResponse(request: unknown): Promise<any> }, request: unknown) {
  const response = await this.getResponse(request);
  yield { type: 'response_started' } as never;
  yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
}

const call = (callId: string, name: string, args: Record<string, unknown>) => ({
  type: 'function_call', callId, name, arguments: JSON.stringify(args),
});
const say = (text: string) => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });

async function runWorker(input: { id: string; ask: string; steps: unknown[][] }) {
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  const session = eventlog.createSession({ id: `${input.id}-parent`, kind: 'chat', userId: 'fixture-owner' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: input.ask } });
  assert.ok(recordTurnGraphShadow({ identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn } }));
  const packet = {
    objective: input.ask, item: input.id, resolvedTools: 'none needed (local files only)',
    externalMcpToolNames: null, context: 'Work only in the fixture folder. Do not contact anyone.',
    instructions: 'Produce the work and save it as a local file.', expectedOutput: 'The saved path.', intent: 'design',
  };
  let childId = '';
  let modelCalls = 0;
  let surface: string[] = [];
  await brackets.withHarnessRunContext({ sessionId: session.id, sourceUserSeq: source.seq,
    counter: new brackets.ToolCallsCounter(8) }, () => withLogicalToolCall({
      sessionId: session.id, sourceUserSeq: source.seq, logicalToolCallId: `${input.id}-run-worker`, tool: 'run_worker', args: packet,
    }, () => runPacketWorkerWithHost({
      parentSessionId: session.id, sourceUserSeq: source.seq, input: packet, modelId: 'gpt-5.6-terra', maxTurns: 6, mcpToolScope: null,
      buildAgent: async (child) => {
        childId = child.sessionId;
        const built = await buildWorkerAgent({ sessionId: childId, sourceUserSeq: child.sourceUserSeq, workerInput: packet as never,
          model: 'gpt-5.6-terra', mcpToolScope: null,
          ...(child.hostFreshPlanning ? { hostFreshPlanning: child.hostFreshPlanning } : {}) });
        surface = (built.tools as Array<{ name?: string }>).map((tool) => tool.name ?? '');
        (built as unknown as { model: unknown }).model = {
          async getResponse() {
            const output = input.steps[Math.min(modelCalls, input.steps.length - 1)]!;
            modelCalls += 1;
            return { responseId: `${input.id}-${modelCalls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output };
          }, getStreamedResponse: modelStream,
        };
        return built as never;
      },
    })));
  const db = eventlog.openEventLog();
  return {
    childId,
    surface,
    modelCalls,
    dispatches: db.prepare('SELECT tool_name, state FROM physical_dispatches WHERE session_id = ? ORDER BY rowid').all(childId) as Array<{ tool_name: string; state: string }>,
    approvals: (db.prepare('SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = ?').get(childId) as { n: number }).n,
    refusals: eventlog.listEvents(childId, { types: ['guardrail_tripped'] })
      .filter((event) => event.data.kind === 'refused_pre_dispatch')
      .map((event) => String(event.data.refusalDetail ?? '')),
  };
}

test('a worker on an ordinary turn makes a folder and saves its file as ordinary local work, with no card', async () => {
  const folder = path.join(TEST_HOME, 'designs', 'ember-oak');
  const file = path.join(folder, 'landing.md');
  const nonce = 'WORKER-LOCAL-WORK-NONCE-7741';
  const run = await runWorker({
    id: 'worker-local-design',
    ask: 'Design a one-page landing layout and save it as a file.',
    steps: [
      [call('mk', 'run_shell_command', { command: `mkdir -p ${JSON.stringify(folder)}`, cwd: TEST_HOME, timeout_ms: 10_000 })],
      [call('save', 'write_file', { path: file, content: `# Landing\n${nonce}\n`, mode: 'create' })],
      [say(`Saved ${file}.`)],
    ],
  });
  assert.ok(run.surface.includes('run_shell_command') && run.surface.includes('write_file'),
    `the worker carries the local tools first-class: ${run.surface.join(',')}`);
  assert.deepEqual(run.refusals, [], 'no local step was refused');
  assert.equal(existsSync(folder), true, 'the folder was made');
  assert.equal(readFileSync(file, 'utf8'), `# Landing\n${nonce}\n`, 'the file was saved');
  assert.deepEqual(run.dispatches, [
    { tool_name: 'run_shell_command', state: 'returned' },
    { tool_name: 'write_file', state: 'returned' },
  ]);
  assert.equal(run.approvals, 0, 'ordinary local work asks nothing');
});

test('a worker\'s read-only shell command still runs as a read', async () => {
  writeFileSync(path.join(TEST_HOME, 'brief.txt'), 'Ember & Oak brief\n', 'utf8');
  const run = await runWorker({
    id: 'worker-local-read',
    ask: 'Read the brief and summarise it.',
    steps: [
      [call('cat', 'run_shell_command', { command: 'cat brief.txt', cwd: TEST_HOME, timeout_ms: 10_000 })],
      [say('The brief is for Ember & Oak.')],
    ],
  });
  assert.deepEqual(run.refusals, []);
  assert.deepEqual(run.dispatches, [{ tool_name: 'run_shell_command', state: 'returned' }]);
  assert.equal(run.approvals, 0);
});

test('a worker\'s shell command that leaves the machine is not run', async () => {
  const run = await runWorker({
    id: 'worker-off-machine',
    ask: 'Post the design to the review endpoint.',
    steps: [
      [call('post', 'run_shell_command', { command: 'curl -X POST https://example.com/hook -d x=1', cwd: TEST_HOME, timeout_ms: 10_000 })],
      [say('I could not post it from here.')],
    ],
  });
  assert.deepEqual(run.dispatches, [], 'nothing left the machine');
});
