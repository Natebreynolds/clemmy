/**
 * Live canary for a provider-declared model/plan capacity boundary.
 *
 * It intentionally starts on the requested Claude model, asks for no tools or
 * external writes, and verifies that a pre-content capacity failure falls over
 * to another connected brain instead of becoming a generic HTTP 400.
 *
 * Run while the selected Claude model is known to be capped:
 *   CLEMMY_REQUIRE_CAPACITY_FALLOVER=1 \
 *   CLEMMY_CAPACITY_SMOKE_MODEL=claude-sonnet-5 \
 *   npx tsx scripts/smoke-capacity-fallover-live.ts
 *
 * If the provider is accepting calls again, inject the exact observed
 * pre-content response while keeping the rescue brain live:
 *   CLEMMY_SIMULATE_CAPACITY_ERROR=1 CLEMMY_REQUIRE_CAPACITY_FALLOVER=1 \
 *   npx tsx scripts/smoke-capacity-fallover-live.ts
 */
process.env.AUTH_MODE = 'claude_oauth';
process.env.MODEL_ROUTING_MODE = 'off';
process.env.CLEMMY_BRAIN_FALLOVER = 'on';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_FUSION_MODE = 'off';

const modelId = (process.env.CLEMMY_CAPACITY_SMOKE_MODEL || 'claude-sonnet-5').trim();
const requireFallover = process.env.CLEMMY_REQUIRE_CAPACITY_FALLOVER === '1';
const simulateCapacityError = process.env.CLEMMY_SIMULATE_CAPACITY_ERROR === '1';
const sentinel = `CAPACITY_FALLOVER_OK_${Date.now()}`;

const { Agent, Runner } = await import('@openai/agents');
type Model = import('@openai/agents-core').Model;
const { configureHarnessRuntime } = await import('../src/runtime/harness/codex-client.js');
const { createSession } = await import('../src/runtime/harness/eventlog.js');
const { ToolCallsCounter, withHarnessRunContext } = await import('../src/runtime/harness/brackets.js');
const { listOperationalEvents } = await import('../src/runtime/operational-telemetry.js');
const { withModelFallback } = await import('../src/runtime/harness/fallback-model.js');
const { CodexModelProvider } = await import('../src/runtime/harness/codex-model.js');

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

const configured = await configureHarnessRuntime();
if (!configured.ok) fail(configured.reason ?? 'harness runtime did not configure');

const session = createSession({
  kind: 'chat',
  title: 'live capacity fallover canary',
  metadata: { smoke: 'capacity-fallover-live', requestedModel: modelId },
});
const selectedModel: string | Model = simulateCapacityError
  ? withModelFallback([
      {
        label: modelId,
        getModel: () => ({
          async getResponse() {
            throw {
              status: 400,
              message: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
            };
          },
          async *getStreamedResponse() {
            throw {
              status: 400,
              message: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
            };
          },
        }) as Model,
      },
      {
        label: 'codex:live-rescue',
        getModel: () => new CodexModelProvider().getModel(),
      },
    ], {
      falloverOn429: true,
      sessionId: session.id,
    })
  : modelId;

const result = await withHarnessRunContext(
  { sessionId: session.id, counter: new ToolCallsCounter(2) },
  async () => {
    const agent = new Agent({
      name: 'Capacity Fallover Canary',
      model: selectedModel,
      instructions: `Do not call tools. Reply with exactly ${sentinel}`,
      modelSettings: { reasoning: { effort: 'low' } },
    });
    return new Runner({ workflowName: 'capacity-fallover-live' }).run(
      agent,
      `Reply with exactly ${sentinel}.`,
      { maxTurns: 2 },
    );
  },
);

const text = typeof result.finalOutput === 'string'
  ? result.finalOutput
  : JSON.stringify(result.finalOutput ?? null);
const fallovers = listOperationalEvents({
  sessionId: session.id,
  type: 'model_fallover',
  limit: 20,
});

console.log(`session=${session.id}`);
console.log(`requested_model=${modelId}`);
console.log(`simulated_capacity_error=${simulateCapacityError}`);
console.log(`fallovers=${JSON.stringify(fallovers.map((event) => event.payload))}`);
console.log(`result=${JSON.stringify(text)}`);

if (!text.includes(sentinel)) fail('the recovered brain did not return the sentinel');
if (/out of extra usage|unexpected error \(HTTP 400\)/i.test(text)) {
  fail(`provider capacity leaked to the user instead of being recovered: ${text}`);
}
if (requireFallover && fallovers.length === 0) {
  fail('the selected model was expected to be capped, but no model_fallover event was recorded');
}
if (fallovers.length > 0) {
  const capacityFallover = fallovers.find((event) =>
    event.payload.reason === 'model.rate_limited'
    && String(event.payload.from ?? '').includes(modelId),
  );
  if (!capacityFallover) {
    fail(`fallover occurred, but not from ${modelId} for model.rate_limited capacity`);
  }
}

console.log(`PASS ${fallovers.length > 0 ? 'capacity was classified and recovered by brain fallover' : 'selected model answered without needing fallover'}`);
