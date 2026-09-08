import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-worker-route-'));
process.env.AUTH_MODE = 'api_key';
process.env.MODEL_ROUTING_MODE = 'all_in';
process.env.OPENAI_MODEL_PRIMARY = 'gpt-5.6-terra';
process.env.OPENAI_MODEL_WORKER = '';
process.env.BYO_MODEL_BASE_URL = 'https://legacy.example.test/v1';
process.env.BYO_MODEL_ID = 'legacy-model';
process.env.BYO_MODEL_API_KEY = 'test-only-legacy-key';
process.env.BYO_PROVIDERS = JSON.stringify([
  { id: 'selected', label: 'Selected', baseURL: 'https://selected.example.test/v1', modelIds: ['selected-worker', 'intent-worker'] },
]);
process.env.BYO_PROVIDER_SELECTED_API_KEY = 'test-only-selected-key';
process.env.CLEMMY_MODEL_ROLES_REGISTRY = 'on';
process.env.CLEMMY_WORKER_INTENT_ROUTING = 'on';
process.env.CLEMMY_BRAIN_FALLOVER = 'off';

const { workflowRunnerInternalsForTest } = await import('./workflow-runner.js');
const { buildWorkflowStepAgent } = await import('../agents/workflow-step-agent.js');
const { RouterModelProvider } = await import('../runtime/harness/router-model.js');
const { resetByoModelCache } = await import('../runtime/harness/byo-model.js');
const resolve = workflowRunnerInternalsForTest.resolveWorkflowStepModel;
const ordinary = { id: 'summary', prompt: 'Summarize the supplied text.', sideEffect: 'read' as const };
const binding = (extra: Record<string, unknown> = {}) => ({
  role: 'worker', modelId: 'selected-worker', scope: 'durable', source: 'settings', ...extra,
});
function bindings(...rows: ReturnType<typeof binding>[]): void {
  process.env.CLEMMY_MODEL_ROLES = JSON.stringify(rows);
  process.env.CLEMMY_MODEL_ROLES_REGISTRY = 'on';
  resetByoModelCache();
}

test('ordinary workflow child honors the durable worker through the actual agent and model factory', async () => {
  bindings(binding());
  const route = resolve(ordinary);
  const agent = await buildWorkflowStepAgent({ userInput: ordinary.prompt, model: route.model, resultOnlyTools: true });
  const model = new RouterModelProvider().getModel(agent.model as string) as unknown as {
    context: { requestedModel: string; resolvedModel: string; provider: string };
  };
  assert.equal(model.context.requestedModel, 'selected-worker');
  assert.equal(model.context.resolvedModel, 'selected-worker', 'must not collapse the untagged child to the unrelated legacy BYO primary');
  assert.equal(model.context.provider, 'byo');
  assert.equal(route.trace?.source, 'settings');
});

test('ordinary workflow child also honors an exact durable chat-rule worker binding', () => {
  bindings(binding({ source: 'chat-rule' }));
  const route = resolve(ordinary);
  assert.equal(route.model, 'selected-worker');
  assert.equal(route.trace?.source, 'chat-rule');
  assert.equal(route.trace?.matchedIntent, null);
});

test('absent or intent-only worker bindings preserve the ordinary legacy default', () => {
  bindings();
  assert.deepEqual(resolve(ordinary), {});
  bindings(binding({ whenIntent: 'design' }));
  assert.deepEqual(resolve(ordinary), {});
});

test('inactive worker binding does not turn a fallback into an explicit selection', () => {
  bindings(binding({ modelId: 'unconnected-worker' }));
  assert.deepEqual(resolve(ordinary), {});
});

test('step model and workflow brain pins retain precedence over an ordinary worker binding', () => {
  bindings(binding());
  assert.deepEqual(resolve({ ...ordinary, model: 'explicit-step' }), { model: 'explicit-step' });
  assert.deepEqual(resolve(ordinary, { models: { brain: 'workflow-brain' } } as never), { model: 'workflow-brain' });
});

test('existing intent-scoped worker selection retains precedence', () => {
  bindings(binding(), binding({ modelId: 'intent-worker', whenIntent: 'design', source: 'chat-rule' }));
  const route = resolve({ ...ordinary, intent: 'design' });
  assert.equal(route.model, 'intent-worker');
  assert.equal(route.trace?.matchedIntent, 'design');
});

test('authenticated specialist and convergence roles retain their model policies', () => {
  bindings(binding());
  const workflow = { models: { worker: 'workflow-specialist' } } as never;
  assert.equal(resolve({ ...ordinary, __graphRuntimeRole: 'specialist' } as never, workflow).model, 'workflow-specialist');
  for (const executionRole of ['brain', 'reducer']) {
    assert.deepEqual(resolve({ ...ordinary, __compiledProjectRuntime: true, executionRole } as never), {});
  }
});

test('registry-off and session-scoped entries cannot acquire new durable child ownership', () => {
  bindings(binding());
  process.env.CLEMMY_MODEL_ROLES_REGISTRY = 'off';
  assert.deepEqual(resolve(ordinary), {});
  bindings(binding({ scope: 'session' }));
  assert.deepEqual(resolve(ordinary), {});
});
