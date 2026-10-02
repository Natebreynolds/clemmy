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
const callTools = await import('../../tools/call-tool.js');
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
  /** How the model spells the call. `call_tool` and `direct` are the lean
   * chat surface: the shell is off the surface and only the work carrier
   * takes it, so the host carries the call onto work_call itself. */
  authored?: 'work_call' | 'call_tool' | 'direct';
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
  const authored = input.authored ?? 'work_call';
  // The lean surface: call_tool carries only controls; the shell belongs to
  // work_call, exactly as the orchestrator builds them.
  const callTool = authored === 'work_call' ? null : brackets.wrapToolForHarness(callTools.buildCallTool({
    reachableBuiltinNames: new Set(), firstClassNames: new Set(), workCarrierNames: new Set([SHELL]),
    deniedNames: new Set(), controlOnlyBuiltins: true, admitBuiltinAcquisition: async () => ({ ok: true }),
    mcpToolScope: { authority: 'none', reason: 'fixture', allowedServerSlugs: [], toolPatterns: [], maxTools: 0 },
  } as never) as never);
  // The model's own spelling: no cwd or timeout, as the live call had none.
  const shellArgs = authored === 'work_call'
    ? { command: input.command, cwd: WORK, timeout_ms: 20_000 }
    : { command: `cd ${JSON.stringify(WORK)} && ${input.command}` };
  const authoredCall = authored === 'work_call'
    ? toolCall(`${input.id}-call`, 'work_call', {
        requirement_id: input.requirementId, source_call_ids: null, source_record_ids: null,
        universe_item_id: null, universe_selector: null, seal_amendment: null,
        name: SHELL, args_json: JSON.stringify(shellArgs),
      })
    : authored === 'call_tool'
      ? toolCall(`${input.id}-call`, 'call_tool', { name: SHELL, args_json: JSON.stringify(shellArgs) })
      : toolCall(`${input.id}-call`, SHELL, shellArgs);
  const model = stubModel([[authoredCall], [textMessage('Done.')]]);
  const surface = callTool ? [callTool, workCall] : [workCall];
  const agent = { model, tools: surface };
  localPreparation.bindHostLocalCallPreparation(agent, { planning: primed.planning, configuredNames: new Set([SHELL]) });
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({ sessionId: session.id,
    universeTools: surface, activeToolNames: surface.map((entry) => (entry as { name: string }).name), policyHash: input.id,
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
    finalOutput: String((result as { finalOutput?: unknown }).finalOutput ?? ''),
    authority: db.prepare('SELECT state, close_reason FROM accepted_turn_call_authorities WHERE session_id = ?')
      .get(session.id) as { state: string; close_reason: string | null } | undefined,
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

// Live 10-02: on the lean chat surface the model spelled a read-only shell
// command through call_tool (or by its own name), the host carried it onto
// work_call under the local-change requirement with the shell's
// schema-completed arguments, and then admitted the call under the model's
// original bytes. The attested call and the admitted call differed, the
// whole accepted turn was poisoned, and the user saw "I could not reopen the
// saved checkpoint".
for (const authored of ['call_tool', 'direct'] as const) {
  test(`a read the host carries onto the local-change requirement (${authored}) runs as a read and keeps the turn`, async () => {
    const run = await runShellTurn({
      id: `shell-carried-read-${authored}`,
      prompt: 'List the assets folder.',
      command: 'ls -1 assets',
      requirementId: ORDINARY,
      authored,
    });
    assert.doesNotMatch(run.history + run.finalOutput, /could not reopen the saved checkpoint/, run.finalOutput);
    assert.notEqual(run.authority?.state, 'conflict', run.authority?.close_reason ?? '');
    assert.match(run.history, /brand\.css/, run.history);
    assert.match(run.history, /Done\./, 'the next model step ran');
    assert.deepEqual(run.dispatches, [{ tool_name: SHELL, state: 'returned' }]);
    // The read does not borrow the local-change capability it was carried under.
    assert.ok(run.bindings.length > 0 && run.bindings.every((row) => row.effect !== 'local_write'), JSON.stringify(run.bindings));
    assert.equal(run.approvals, 0);
  });
}

test('a local change the host carries onto the local-change requirement still runs as ordinary local work', async () => {
  const run = await runShellTurn({
    id: 'shell-carried-copy',
    prompt: 'Copy assets/brand.css into out-carried/brand.css in the work folder.',
    command: 'mkdir -p out-carried && cp assets/brand.css out-carried/brand.css',
    requirementId: ORDINARY,
    authored: 'call_tool',
  });
  assert.doesNotMatch(run.history + run.finalOutput, /could not reopen the saved checkpoint/, run.finalOutput);
  assert.notEqual(run.authority?.state, 'conflict', run.authority?.close_reason ?? '');
  assert.equal(readFileSync(path.join(WORK, 'out-carried', 'brand.css'), 'utf8'), 'body{color:#123}\n');
  assert.deepEqual(run.dispatches, [{ tool_name: SHELL, state: 'returned' }]);
  assert.deepEqual(run.bindings.map((row) => [row.tool_name, row.capability_id, row.effect]),
    [[SHELL, ORDINARY, 'local_write']]);
  assert.equal(run.approvals, 0);
});

test('a carried command that leaves the machine is still not run', async () => {
  const run = await runShellTurn({
    id: 'shell-carried-off-machine',
    prompt: 'Post the form to the endpoint.',
    command: 'curl -X POST https://example.com/hook -d x=1',
    requirementId: ORDINARY,
    authored: 'call_tool',
  });
  assert.deepEqual(run.dispatches, [], run.history);
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

test('a local command that changes files and then exits non-zero returns its exact result and the turn goes on', async () => {
  // The first steps land; the last one fails. That is a known result, not an
  // uncertain effect: the model gets the exit code and output and answers.
  const run = await runShellTurn({
    id: 'shell-partial-nonzero',
    prompt: 'Make out-partial, copy assets/brand.css into it, then report its size.',
    command: "mkdir -p out-partial && cp assets/brand.css out-partial/brand.css && sh -c 'exit 3'",
    requirementId: ORDINARY,
  });
  assert.match(run.history, /exit_code: 3/);
  assert.match(run.history, /Earlier steps of this command may already have taken effect/);
  assert.match(run.history, /Done\./, 'the next model step ran');
  assert.doesNotMatch(run.history, /could not reopen the saved checkpoint/);
  assert.equal(readFileSync(path.join(WORK, 'out-partial', 'brand.css'), 'utf8'), 'body{color:#123}\n');
  assert.deepEqual(run.dispatches.map((row) => row.state), ['returned'], 'the command body ran once');
  assert.equal(run.approvals, 0);
  assert.equal(run.interrupted, false);
});
