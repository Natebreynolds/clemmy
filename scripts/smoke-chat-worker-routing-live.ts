/**
 * Live smoke for chat run_worker intent routing.
 *
 * This spends one real model call through the user's configured Clementine auth.
 * It invokes the built chat `run_worker` tool directly with intent:"design" and
 * verifies the nested Worker is routed to the configured Claude model.
 *
 * Run:
 *   AUTH_MODE=codex_oauth npx tsx scripts/smoke-chat-worker-routing-live.ts
 *
 * Optional:
 *   CLEMMY_LIVE_WORKER_MODEL=claude-sonnet-4-6
 */

const workerModel = (process.env.CLEMMY_LIVE_WORKER_MODEL || 'claude-opus-4-8').trim();
const authMode = (process.env.CLEMMY_LIVE_SMOKE_AUTH_MODE || process.env.AUTH_MODE || 'codex_oauth').trim();

process.env.AUTH_MODE = authMode;
process.env.CLEMMY_MODEL_ROLES_REGISTRY = 'on';
process.env.CLEMMY_WORKER_INTENT_ROUTING = 'on';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_MODEL_ROLES = JSON.stringify([
  {
    role: 'worker',
    modelId: workerModel,
    whenIntent: 'design',
    scope: 'durable',
    source: 'chat-rule',
  },
]);

const { RunContext } = await import('@openai/agents');
const { configureHarnessRuntime } = await import('../src/runtime/harness/codex-client.js');
const { buildOrchestratorAgent } = await import('../src/agents/orchestrator.js');
const { createSession, listEvents } = await import('../src/runtime/harness/eventlog.js');
const { ToolCallsCounter, withHarnessRunContext } = await import('../src/runtime/harness/brackets.js');

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

console.log('=== Chat run_worker intent routing live smoke ===');
console.log(`AUTH_MODE=${process.env.AUTH_MODE}`);
console.log(`worker/design=${workerModel}`);

const cfg = await configureHarnessRuntime();
if (!cfg.ok) fail(`configureHarnessRuntime failed: ${cfg.reason ?? 'unknown reason'}`);

const session = createSession({
  kind: 'chat',
  title: 'live chat worker routing smoke',
  metadata: { smoke: 'chat-worker-routing-live', workerModel },
});

const agent = await buildOrchestratorAgent({
  sessionId: session.id,
  userInput: 'Live smoke: route a design worker to the configured Claude model.',
  mcpToolScope: {
    reason: 'live smoke: no external MCP tools required',
    allowedServerSlugs: [],
    maxTools: 0,
  },
});

const runWorker = (agent.tools ?? []).find((t) => (t as { name?: string }).name === 'run_worker') as
  | { invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown> }
  | undefined;
if (!runWorker) fail('run_worker was not present on the orchestrator tool surface');

const packet = {
  objective: 'Produce one compact design direction for a live routing smoke test.',
  item: 'design-smoke-item',
  resolvedTools: 'none needed',
  context: 'No external data is needed. This is a routing smoke only.',
  instructions: 'Do not call tools. Reply with exactly: ROUTED_DESIGN_WORKER_OK',
  expectedOutput: 'Exactly ROUTED_DESIGN_WORKER_OK, or ERROR: <reason>.',
  intent: 'design',
};
const input = JSON.stringify(packet);
const callId = `call_live_worker_design_${Date.now()}`;

const result = await withHarnessRunContext(
  { sessionId: session.id, counter: new ToolCallsCounter(20) },
  () =>
    runWorker.invoke(
      new RunContext({ sessionId: session.id }),
      input,
      {
        toolCall: {
          type: 'function_call',
          id: `fc_${callId}`,
          name: 'run_worker',
          callId,
          arguments: input,
          status: 'completed',
        },
      },
    ),
);

const text = typeof result === 'string' ? result : JSON.stringify(result);
console.log(`result=${JSON.stringify(text)}`);

const routed = listEvents(session.id, { types: ['worker_model_routed'] });
if (routed.length !== 1) fail(`expected one worker_model_routed event, got ${routed.length}`);

const route = routed[0].data as Record<string, unknown>;
console.log(`route=${JSON.stringify(route)}`);
if (route.seam !== 'chat') fail(`expected seam=chat, got ${String(route.seam)}`);
if (route.modelId !== workerModel) fail(`expected modelId=${workerModel}, got ${String(route.modelId)}`);
if (route.provider !== 'claude') fail(`expected provider=claude, got ${String(route.provider)}`);
if (route.matchedIntent !== 'design') fail(`expected matchedIntent=design, got ${String(route.matchedIntent)}`);

if (/^\s*ERROR:/i.test(text)) fail(`worker returned an error result: ${text}`);
if (/out of extra usage/i.test(text)) {
  fail(`Claude OAuth dispatch succeeded but the subscription rejected the call for usage: ${text}`);
}
if (!/ROUTED_DESIGN_WORKER_OK/i.test(text)) {
  fail(`worker completed but did not return the expected sentinel; result=${JSON.stringify(text)}`);
}

console.log(`PASS chat run_worker intent routing dispatched to ${workerModel}`);
