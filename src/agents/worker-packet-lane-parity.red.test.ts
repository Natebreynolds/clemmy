/**
 * Run: npx tsx --test src/agents/worker-packet-lane-parity.red.test.ts
 *
 * RED PIN — one shared worker packet builder across the three dispatch lanes.
 *
 * The same contracted fan-out item can be dispatched to a worker from three
 * production entry points: the SDK-brain run_worker MCP tool (worker-tools),
 * the orchestrator's inline run_worker, and code-mode's clem.run_worker. The
 * packet a worker receives is its ONLY authority: under a frozen work
 * contract a worker with no expectedWork binding sees no first-class business
 * tool and quits with zero calls (live 2026-08-11: five workers, twice each).
 *
 * The invariant: whichever lane dispatches, the worker packet carries the
 * SAME contracted binding (expectedWork.requirementId/universeId) and the
 * same authority envelope — the binding must never depend on which brain
 * happened to fan out. Today only the worker-tools lane derives expectedWork;
 * the orchestrator and code-mode lanes forward the packet blind, so those two
 * lane tests fail until packet assembly is shared.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Agent, Tool } from '@openai/agents';
import type { WorkerToolInput } from './worker-job-packet.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-worker-packet-parity-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.AUTH_MODE = 'claude_oauth';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-worker-parity\n', 'utf8');

const eventlog = await import('../runtime/harness/eventlog.js');
const shadow = await import('../runtime/graph/turn-graph-shadow.js');
const identities = await import('../runtime/harness/attempt-identity.js');
const admissionModule = await import('../runtime/harness/expected-work-admission.js');
const dispatch = await import('../runtime/harness/dispatch-ledger.js');
const settlement = await import('../runtime/harness/attempt-settlement.js');
const { setClaudeAgentSdkWorkerRunForTest } = await import('../runtime/harness/claude-agent-worker.js');
const { registerWorkerTools } = await import('../tools/worker-tools.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { ToolCallsCounter, withHarnessRunContext } = await import('../runtime/harness/brackets.js');
const { buildOrchestratorAgent } = await import('./orchestrator.js');
const { dispatchCodeModeTool, _setCodeModeWorkerRunnerForTests } = await import('../tools/code-mode-tool.js');
const { workerPacketKey } = await import('./worker-job-packet.js');
const { activateDispatchLease } = await import('../runtime/harness/dispatch-lease.js');

test.after(() => {
  setClaudeAgentSdkWorkerRunForTest(null);
  _setCodeModeWorkerRunnerForTests(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const ASK = 'Read every open lead and write a local follow-up draft file for each one.';
const EXPECTED_BINDING = { requirementId: 'write_draft', universeId: 'leads' };
let serial = 0;

interface ArmedTask {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  acceptedTaskId: string;
}

function proposal() {
  return {
    version: 1 as const,
    operations: [
      {
        id: 'read_leads',
        effect: 'read' as const,
        coverage: 'complete_set' as const,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' as const },
      },
      {
        id: 'write_draft',
        effect: 'local_write' as const,
        dependsOn: ['read_leads'],
        dataFrom: ['read_leads'],
        cardinality: { kind: 'each' as const, universeId: 'leads' },
      },
    ],
    universes: [{
      id: 'leads',
      seal: 'complete_source_receipt' as const,
      producedBy: 'read_leads',
      memberIdPointer: '/id',
    }],
  };
}

/** Arm one contracted task with the producer read discharged and the leads
 * universe sealable — the exact state deriveWorkerPacketExpectedWork needs. */
function armContractedTask(label: string): ArmedTask {
  const id = ++serial;
  const session = eventlog.createSession({ id: `worker-parity-${label}-${id}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: ASK },
  });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }), 'fixture graph persisted');
  const activated = admissionModule.activateActionExpectedWork(task);
  assert.ok(activated.status === 'activated' || activated.status === 'replayed', JSON.stringify(activated));
  const acceptedTaskId = identities.acceptedTaskIdFor(session.id, source.seq);
  const sourceCall = `logical:worker-parity-${label}-${id}:source`;
  const args = { path: 'leads.json' };
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, acceptedTaskId, logicalToolCallId: sourceCall },
    tool: 'read_file',
    args,
  }).status, 'inserted');
  assert.equal(admissionModule.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: sourceCall,
    proposal: proposal(),
    requirementId: 'read_leads',
    tool: 'read_file',
    args,
  }).status, 'bound');
  const settled = settlement.settleToolAttempt({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
    lane: 'agents_runner',
    toolName: 'read_file',
    callId: sourceCall,
    args,
    mutating: false,
    businessCall: true,
    requirementId: 'read_leads',
    result: { records: [{ id: 'lead-001' }, { id: 'lead-002' }], complete: true },
  });
  assert.equal(settled.outcome.kind, 'succeeded', JSON.stringify(settled.outcome));

  // Fixture sanity: the binding is derivable at dispatch time for this item,
  // so a lane that omits it can only be failing to ASK.
  assert.deepEqual(
    admissionModule.deriveWorkerPacketExpectedWork({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      items: ['lead-001'],
    }),
    EXPECTED_BINDING,
  );
  return { ...task, acceptedTaskId };
}

function packetFor(): Record<string, unknown> {
  return {
    objective: 'Write the follow-up draft file for one open lead from the sealed lead list.',
    item: 'lead-001',
    resolvedTools: 'none needed',
    externalMcpToolNames: null,
    context: 'Lead lead-001 (Harbor & Vale LLP): asked for pricing two weeks ago. Source read complete.',
    instructions: 'Write drafts/lead-001.md through your bound business call, then return the receipt line.',
    expectedOutput: 'One line: DRAFTED lead-001 | <path>',
    intent: null,
  };
}

interface CapturedDispatch {
  packet: WorkerToolInput;
  options: Record<string, unknown>;
}

/** Capture what the Claude SDK worker adapter is actually handed: the packet
 * (parsed back out of the job prompt it renders) plus the authority options. */
function captureClaudeWorkerDispatches(): { captured: CapturedDispatch[]; restore: () => void } {
  const captured: CapturedDispatch[] = [];
  setClaudeAgentSdkWorkerRunForTest((async (options: Record<string, unknown>) => {
    const prompt = String(options.prompt ?? '');
    const packetJson = prompt.split('\nPacket JSON:\n')[1];
    assert.ok(packetJson, 'the worker prompt carries the packet JSON');
    captured.push({ packet: JSON.parse(packetJson) as WorkerToolInput, options });
    return { text: 'DRAFTED lead-001 | drafts/lead-001.md', toolUses: [] };
  }) as never);
  return { captured, restore: () => setClaudeAgentSdkWorkerRunForTest(null) };
}

function captureRunWorkerHandler(): (params: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  let handler: ((params: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>) | undefined;
  const stubServer = {
    tool: (name: string, _desc: string, _schema: unknown, cb: never) => {
      if (name === 'run_worker') handler = cb;
    },
  };
  registerWorkerTools(stubServer as never);
  if (!handler) throw new Error('run_worker handler was not registered');
  return handler;
}

function leaseFor(task: ArmedTask) {
  // A REAL activated lease: the orchestrator lane's bracket battery validates
  // the lease against the durable store before any dispatch.
  return activateDispatchLease({
    sessionId: task.sessionId,
    scopeId: `${task.sessionId}::parity-turn`,
  });
}

async function dispatchViaWorkerTools(task: ArmedTask): Promise<CapturedDispatch> {
  const handler = captureRunWorkerHandler();
  const { captured, restore } = captureClaudeWorkerDispatches();
  try {
    const res = await withHarnessRunContext(
      {
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        counter: new ToolCallsCounter(50),
        dispatchLease: leaseFor(task),
      },
      () => withToolOutputContext({ sessionId: task.sessionId }, () => handler(packetFor())),
    );
    assert.equal(captured.length, 1, `worker-tools lane dispatched one worker: ${JSON.stringify(res)}`);
    return captured[0];
  } finally {
    restore();
  }
}

type Invokable = Tool<unknown> & {
  invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
};

async function dispatchViaOrchestrator(task: ArmedTask): Promise<CapturedDispatch> {
  const agent = await buildOrchestratorAgent({
    userInput: ASK,
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedRoute: 'act',
    allowedToolNames: ['tool_search', 'run_worker', 'read_file', 'write_file'],
    allowToolJit: true,
  }) as unknown as Agent<unknown, never>;
  const runWorker = (agent.tools ?? []).find((toolRef) => toolRef.name === 'run_worker') as Invokable | undefined;
  assert.ok(runWorker, 'the production act surface exposes run_worker');
  const { captured, restore } = captureClaudeWorkerDispatches();
  try {
    const out = await withHarnessRunContext(
      {
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        counter: new ToolCallsCounter(50),
        dispatchLease: leaseFor(task),
      },
      () => runWorker!.invoke(
        { context: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, turn: 1 } },
        JSON.stringify(packetFor()),
        { toolCall: { callId: 'parity-orchestrator-run-worker' } },
      ),
    );
    assert.equal(captured.length, 1, `orchestrator lane dispatched one worker: ${JSON.stringify(out).slice(0, 300)}`);
    return captured[0];
  } finally {
    restore();
  }
}

async function dispatchViaCodeMode(task: ArmedTask): Promise<WorkerToolInput> {
  const captured: WorkerToolInput[] = [];
  _setCodeModeWorkerRunnerForTests(async (input) => {
    captured.push(input);
    return { text: 'DRAFTED lead-001 | drafts/lead-001.md', model: 'test' };
  });
  try {
    const out = await withHarnessRunContext(
      { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, counter: new ToolCallsCounter(50) },
      () => dispatchCodeModeTool('run_worker', packetFor(), task.sessionId, new ToolCallsCounter(50)),
    ) as { ok: boolean; error?: string };
    assert.equal(out.ok, true, `code-mode lane dispatched one worker: ${JSON.stringify(out)}`);
    assert.equal(captured.length, 1);
    return captured[0];
  } finally {
    _setCodeModeWorkerRunnerForTests(null);
  }
}

test('the worker-tools lane hands its worker the contracted binding (the reference lane)', async () => {
  const task = armContractedTask('sdk-brain');
  const dispatched = await dispatchViaWorkerTools(task);
  assert.deepEqual(
    dispatched.packet.expectedWork,
    EXPECTED_BINDING,
    'the SDK-brain lane worker packet names its frozen-contract binding',
  );
});

test('the orchestrator inline lane hands its worker the same contracted binding', async () => {
  const task = armContractedTask('orchestrator');
  const dispatched = await dispatchViaOrchestrator(task);
  assert.deepEqual(
    dispatched.packet.expectedWork,
    EXPECTED_BINDING,
    'a contracted fan-out from the orchestrator lane must carry the same expectedWork binding '
      + 'the worker-tools lane derives — a worker dispatched blind sees no business surface and quits',
  );
});

test('the code-mode lane hands its worker the same contracted binding', async () => {
  const task = armContractedTask('code-mode');
  const packet = await dispatchViaCodeMode(task);
  assert.deepEqual(
    packet.expectedWork,
    EXPECTED_BINDING,
    'a contracted fan-out from clem.run_worker must carry the same expectedWork binding '
      + 'the worker-tools lane derives — a worker dispatched blind sees no business surface and quits',
  );
});

test('GUARD: the two Claude SDK dispatch lanes hand the adapter one authority envelope shape', async () => {
  const sdkBrain = armContractedTask('authority-sdk');
  const orchestrator = armContractedTask('authority-orch');
  const a = await dispatchViaWorkerTools(sdkBrain);
  const b = await dispatchViaOrchestrator(orchestrator);
  assert.equal(typeof a.options.sourceUserSeq, 'number', 'worker-tools lane forwards the accepted source');
  assert.equal(typeof b.options.sourceUserSeq, 'number', 'orchestrator lane forwards the accepted source');
  assert.equal(
    Boolean(a.options.dispatchLease),
    Boolean(b.options.dispatchLease),
    'dispatch-lease presence must not depend on the dispatch lane',
  );
  assert.match(String(a.options.trackerScopeId ?? ''), /::worker:/, 'packet-stable isolation scope');
  assert.match(String(b.options.trackerScopeId ?? ''), /::worker:/, 'packet-stable isolation scope');
});

test('GUARD: harness-derived expectedWork must not fork the worker packet idempotency key', async () => {
  // The packet key is durable idempotency authority for resumed runs; a lane
  // that enriches the packet (deriving expectedWork) must map to the SAME key
  // as a lane that forwarded it bare, or a resume could re-execute completed
  // external work under a "different" packet.
  const bare = { ...packetFor() } as unknown as WorkerToolInput;
  const enriched = { ...bare, expectedWork: EXPECTED_BINDING } as WorkerToolInput;
  assert.equal(workerPacketKey(bare), workerPacketKey(enriched));

  const task = armContractedTask('key-stability');
  const dispatched = await dispatchViaWorkerTools(task);
  const scope = String(dispatched.options.trackerScopeId ?? '');
  assert.equal(
    scope,
    `${task.sessionId}::worker:${workerPacketKey(bare)}`,
    'the dispatched isolation scope still derives from the bare packet identity',
  );
});
