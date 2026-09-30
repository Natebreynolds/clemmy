/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/shell-local-change.integration.test.ts
 *
 * A shell command on a chat turn, through the real host turn runner, with no
 * graph and no model or provider call. What a command does decides its path:
 * a read or a computation runs under its own envelope; a command that changes
 * local files runs as ordinary accepted work, with no card; the guards inside
 * the tool refuse what they always refuse; a command that leaves the machine
 * is not carried here.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { RunContext } from '@openai/agents';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-shell-local-change-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.HARNESS_TOOL_BRACKETS = 'on';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-shell-local-change\n', 'utf8');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const capabilityEnvelopes = await import('../../agents/capability-envelope.js');
const capabilityCatalogs = await import('./host-capability-catalog-factory.js');
const capabilityManifestStores = await import('./capability-manifest-store.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const localPreparation = await import('./host-local-call-preparation.js');
const localDefinitions = await import('./local-planning-capability.js');
const { buildScopedLocalToolSearch } = await import('../../tools/local-runtime-tools.js');
const workCallTools = await import('../../tools/work-call.js');
const { hostRunRunner } = await import('./host-turn-runner.js');
const store = await import('../../spaces/store.js');
const workspaceDb = await import('../../spaces/workspace-db.js');
const workflowStore = await import('../../memory/workflow-store.js');

after(() => {
  capabilityCatalogs.installHostCapabilityCatalogFactory(null);
  capabilityManifestStores.installCapabilityManifestStore(null);
  workspaceDb.closeWorkspaceDb();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function* testModelStream(
  this: { getResponse: (request: unknown) => Promise<{
    usage?: Record<string, unknown>;
    output?: unknown[];
    responseId?: string;
  }> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const output = response.output ?? [];
  yield { type: 'response_started' } as never;
  yield {
    type: 'model',
    event: {
      type: 'finish',
      finishReason: output.some((item) => (item as { type?: string }).type === 'function_call')
        ? 'tool_calls'
        : 'stop',
    },
  } as never;
  yield {
    type: 'response_done',
    response: {
      id: response.responseId ?? 'space-save-response',
      usage: {
        inputTokens: Number(response.usage?.inputTokens ?? 0),
        outputTokens: Number(response.usage?.outputTokens ?? 0),
        totalTokens: Number(response.usage?.totalTokens ?? 0),
      },
      output,
    },
  } as never;
}

function stubModel(responses: unknown[][]) {
  let call = 0;
  return {
    calls: () => call,
    async getResponse() {
      const output = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return {
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          requests: 1,
          inputTokensDetails: [],
          outputTokensDetails: [],
        },
        output,
        responseId: `space-save-response-${call}`,
      };
    },
    getStreamedResponse: testModelStream,
  };
}

const textMessage = (text: string) => ({
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text }],
});

const toolCall = (callId: string, name: string, args: Record<string, unknown>) => ({
  type: 'function_call',
  callId,
  name,
  arguments: JSON.stringify(args),
});

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('Runner.run must not own the turn');
  };
  return runner;
}


const SHELL = 'run_shell_command';
const ORDINARY = 'cap:local:run_shell_command:ordinary';

async function runShellTurn(input: {
  id: string;
  prompt: string;
  command: string;
  requirementId: string;
}) {
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(capabilityCatalogs.createHostCapabilityCatalogFactory());
  capabilityManifestStores.installCapabilityManifestStore(capabilityManifestStores.createCapabilityManifestStore());
  const session = eventlog.createSession({ id: input.id, kind: 'chat', userId: 'shell-fixture-owner' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: input.prompt, taskMode: { version: 1, kind: 'normal' } } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.ok(primed.ok);
  if (!primed.ok) throw new Error(primed.reason);
  const workCall = brackets.wrapToolForHarness(workCallTools.buildWorkCall({ requireHostPlan: true,
    reachableBuiltinNames: new Set([SHELL]), firstClassNames: new Set(), catalogIdentifiers: [SHELL],
    settlementLane: 'byo', hostPlanningReady: () => true }) as never);
  const model = stubModel([[toolCall(`${input.id}-call`, 'work_call', {
    requirement_id: input.requirementId, source_call_ids: null, source_record_ids: null,
    universe_item_id: null, universe_selector: null, seal_amendment: null,
    name: SHELL, args_json: JSON.stringify({ command: input.command, cwd: WORK, timeout_ms: 20_000 }),
  })], [textMessage('Done.')]]);
  const agent = { model, tools: [workCall] };
  localPreparation.bindHostLocalCallPreparation(agent, { planning: primed.planning, configuredNames: new Set([SHELL]) });
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({ sessionId: session.id,
    universeTools: [workCall], activeToolNames: ['work_call'], policyHash: input.id,
    budget: { maxUncachedTokens: 20_000, maxModelCalls: 4, maxToolCalls: 4, maxElapsedMs: 60_000 } });
  assert.ok(sealed.ok);
  if (!sealed.ok) throw new Error('native envelope unavailable');
  capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const result = await brackets.withHarnessRunContext({ ...identity, counter: new brackets.ToolCallsCounter(4),
    behaviorScopeId: `${session.id}::turn:1` }, () => hostRunRunner(throwingRunner() as never, agent as never,
    [{ type: 'message', role: 'user', content: input.prompt }] as never,
    { maxTurns: 3, hostTurnEngine: 'host_v1', context: identity } as never));
  const db = eventlog.openEventLog();
  return {
    history: JSON.stringify(result.history),
    interrupted: Boolean(result.hasInterruptions),
    dispatches: db.prepare('SELECT tool_name, state FROM physical_dispatches WHERE session_id = ? ORDER BY rowid').all(session.id) as Array<{ tool_name: string; state: string }>,
    approvals: (db.prepare('SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = ?').get(session.id) as { n: number }).n,
    bindings: db.prepare('SELECT tool_name, binding_kind, capability_id, effect FROM host_call_capability_bindings WHERE session_id = ?').all(session.id) as Array<Record<string, unknown>>,
    plans: eventlog.listEvents(session.id, { types: ['tool_called'] }).filter((event) => event.data.tool === 'plan_task').length,
  };
}

const WORK = path.join(TEST_HOME, 'work');
mkdirSync(path.join(WORK, 'assets'), { recursive: true });
writeFileSync(path.join(WORK, 'assets', 'brand.css'), 'body{color:#123}\n', 'utf8');

test('the shell declares one ordinary local capability and nothing that opens another door', async () => {
  const { TOOL_REGISTRY } = await import('../../tools/tool-registry.js');
  const row = TOOL_REGISTRY.find((candidate) => candidate.name === SHELL)!;
  assert.equal(row.localPlanning?.reversibility, 'ordinary_non_destructive');
  assert.equal(row.localPlanning?.consequence, 'local_execution');
  assert.equal(row.localPlanning?.destructive, false);
  assert.equal(row.localPlanning?.destinationPosture, null);
  assert.equal(row.localPlanningVariants, undefined);
  assert.equal(row.localExecution, undefined, 'the workflow kernel does not gain the shell');
  assert.equal(row.localPlanningRead, undefined);
  assert.equal(row.projectEffect, undefined);
  const observed = await localDefinitions.observeCurrentLocalPlanningDefinitions({ name: SHELL, carrier: 'work_call' });
  assert.equal(observed.ok, true, JSON.stringify(observed));
  if (!observed.ok) return;
  assert.deepEqual(observed.definitions.map((definition) => [definition.capabilityRef, definition.reversibility, definition.descriptor.effect]),
    [[ORDINARY, 'ordinary_non_destructive', 'local_write']]);
});

test('a command that changes local files runs as ordinary accepted work, with no plan and no card', async () => {
  const run = await runShellTurn({
    id: 'shell-local-copy',
    prompt: 'Copy assets/brand.css into out/brand.css in the work folder.',
    command: 'mkdir -p out && cp assets/brand.css out/brand.css',
    requirementId: ORDINARY,
  });
  assert.doesNotMatch(run.history, /work_contract_required|not yet published|binding is absent or changed/, run.history);
  assert.equal(readFileSync(path.join(WORK, 'out', 'brand.css'), 'utf8'), 'body{color:#123}\n');
  assert.deepEqual(run.dispatches, [{ tool_name: SHELL, state: 'returned' }]);
  assert.deepEqual(run.bindings.map((row) => [row.tool_name, row.binding_kind, row.capability_id, row.effect]),
    [[SHELL, 'local_envelope', ORDINARY, 'local_write']]);
  assert.equal(run.approvals, 0);
  assert.equal(run.interrupted, false);
  assert.equal(run.plans, 0);
});

test('a command that only reads still runs under its own envelope, by its label', async () => {
  const run = await runShellTurn({
    id: 'shell-local-read',
    prompt: 'List the assets folder.',
    command: 'ls -1 assets',
    requirementId: SHELL,
  });
  assert.match(run.history, /brand\.css/);
  assert.deepEqual(run.dispatches, [{ tool_name: SHELL, state: 'returned' }]);
  assert.equal(run.approvals, 0);
});

test('a read carried under the local-change capability does not borrow it', async () => {
  const run = await runShellTurn({
    id: 'shell-read-under-write-ref',
    prompt: 'List the assets folder.',
    command: 'ls -1 assets',
    requirementId: ORDINARY,
  });
  // Whatever the label, the command's own effect decides: it is a read.
  assert.match(run.history, /brand\.css/);
  assert.ok(run.bindings.every((row) => row.effect !== 'local_write'), JSON.stringify(run.bindings));
});

for (const [name, command, said] of [
  ['privilege', 'sudo -n true', /denied by Clementine safety policy/],
  ['credentials', 'cat .env', /reads credential material/],
  ['a long wait', 'sleep 30', /just waits 30s/],
] as const) {
  test(`the guards inside the shell still refuse ${name}, whatever consent decided`, async () => {
    const run = await runShellTurn({
      id: `shell-guard-${name.replace(/[^a-z]+/g, '-')}`,
      prompt: `Run ${command} in the work folder.`,
      command,
      requirementId: command.startsWith('cat') || command.startsWith('sleep') ? SHELL : ORDINARY,
    });
    assert.match(run.history, said, run.history);
    assert.equal(run.approvals, 0);
  });
}

test('a command that leaves the machine is not carried as local work', async () => {
  const run = await runShellTurn({
    id: 'shell-off-machine',
    prompt: 'Post the form to the endpoint.',
    command: 'curl -X POST https://example.com/hook -d x=1',
    requirementId: ORDINARY,
  });
  assert.deepEqual(run.dispatches, [], run.history);
  assert.ok(run.bindings.every((row) => row.effect !== 'local_write' || row.capability_id !== ORDINARY), JSON.stringify(run.bindings));
});
