import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelRequest } from '@openai/agents-core';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-prompt-cache-observation-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'prompt-cache-observation-machine\n');

const {
  CACHE_BREAK_SENTINEL,
  CACHE_MEMORY_CONTEXT_SENTINEL,
} = await import('./model-wire-registry.js');
const {
  comparePromptCacheRequests,
  observePromptCacheRequest,
  parseProviderPromptCacheUsage,
} = await import('./prompt-cache-observation.js');

after(() => rmSync(HOME, { recursive: true, force: true }));

function request(input: {
  policy?: string;
  turn?: string;
  memory?: string;
  catalog?: string;
  task?: string;
  temperature?: number;
} = {}): ModelRequest {
  const policy = input.policy ?? 'POLICY-A';
  const turn = input.turn ?? 'TURN-A';
  const memory = input.memory ?? 'MEMORY-A';
  return {
    systemInstructions: [
      policy,
      CACHE_BREAK_SENTINEL,
      turn,
      CACHE_MEMORY_CONTEXT_SENTINEL,
      memory,
    ].join('\n\n'),
    input: [{ role: 'user', content: input.task ?? 'TASK-A' }],
    modelSettings: input.temperature === undefined ? {} : { temperature: input.temperature },
    tools: [{
      type: 'function',
      name: input.catalog ?? 'catalog_a',
      description: 'fixture',
      parameters: { type: 'object', properties: {} },
      strict: true,
    }],
    outputType: 'text',
    handoffs: [],
    tracing: { disabled: true },
  } as ModelRequest;
}

test('request observation records exact content-free layers and rejects marker ambiguity', () => {
  const observed = observePromptCacheRequest(request());
  assert.equal(observed.boundary, 'layered');
  assert.equal(observed.cacheEligible, true);
  assert.equal(observed.policyRevision, observed.layers.stablePolicy.sha256);
  assert.ok(observed.layers.stablePolicy.bytes > 0);
  assert.ok(observed.layers.transport.bytes > 0);
  assert.ok(observed.layers.turnContext.bytes > 0);
  assert.ok(observed.layers.memoryContext.bytes > 0);
  assert.ok(observed.layers.catalog.bytes > 0);
  assert.ok(observed.layers.task.bytes > 0);
  const persisted = JSON.stringify(observed);
  for (const raw of ['POLICY-A', 'TURN-A', 'MEMORY-A', 'catalog_a', 'TASK-A']) {
    assert.equal(persisted.includes(raw), false, `receipt must not persist raw ${raw}`);
  }

  const ambiguous = observePromptCacheRequest({
    ...request(),
    systemInstructions: `POLICY${CACHE_BREAK_SENTINEL}A${CACHE_BREAK_SENTINEL}B`,
  });
  assert.equal(ambiguous.cacheEligible, false);
  assert.ok(ambiguous.issues.includes('multiple_cache_breaks'));
});

test('transition invalidates the first changed normalized request layer only', () => {
  const base = observePromptCacheRequest(request());
  assert.deepEqual(comparePromptCacheRequests(null, base), {
    version: 1,
    invalidatedAt: 'cold',
    stablePrefixReusable: false,
    reusableLayers: [],
    changedLayers: ['transport', 'stablePolicy', 'turnContext', 'memoryContext', 'catalog', 'task'],
    reusableInputBytes: 0,
  });
  assert.equal(comparePromptCacheRequests(base, observePromptCacheRequest(request())).invalidatedAt, 'none');

  const task = comparePromptCacheRequests(base, observePromptCacheRequest(request({ task: 'TASK-B' })));
  assert.equal(task.invalidatedAt, 'task');
  assert.deepEqual(task.reusableLayers, ['transport', 'stablePolicy', 'turnContext', 'memoryContext', 'catalog']);

  const catalog = comparePromptCacheRequests(base, observePromptCacheRequest(request({ catalog: 'catalog_b' })));
  assert.equal(catalog.invalidatedAt, 'catalog');
  assert.deepEqual(catalog.reusableLayers, ['transport', 'stablePolicy', 'turnContext', 'memoryContext']);

  const memory = comparePromptCacheRequests(base, observePromptCacheRequest(request({ memory: 'MEMORY-B' })));
  assert.equal(memory.invalidatedAt, 'memory_context');
  assert.deepEqual(memory.reusableLayers, ['transport', 'stablePolicy', 'turnContext']);

  const turn = comparePromptCacheRequests(base, observePromptCacheRequest(request({ turn: 'TURN-B' })));
  assert.equal(turn.invalidatedAt, 'turn_context');
  assert.deepEqual(turn.reusableLayers, ['transport', 'stablePolicy']);

  const transport = comparePromptCacheRequests(base, observePromptCacheRequest(request({ temperature: 0.4 })));
  assert.equal(transport.invalidatedAt, 'transport');
  assert.equal(transport.stablePrefixReusable, false);
  assert.deepEqual(transport.reusableLayers, []);

  const policy = comparePromptCacheRequests(base, observePromptCacheRequest(request({ policy: 'POLICY-B' })));
  assert.equal(policy.invalidatedAt, 'policy');
  assert.equal(policy.stablePrefixReusable, false);
  assert.deepEqual(policy.reusableLayers, []);
});

test('provider cache usage is certified only with an explicit consistent dialect', () => {
  assert.deepEqual(parseProviderPromptCacheUsage({
    version: 1,
    cacheDialect: 'inclusive',
    inputTokens: 100,
    cachedInputTokens: 75,
    uncachedInputTokens: 25,
  }), {
    version: 1,
    cacheDialect: 'inclusive',
    inputTokens: 100,
    cachedInputTokens: 75,
    uncachedInputTokens: 25,
  });
  assert.equal(parseProviderPromptCacheUsage({
    version: 1,
    cacheDialect: 'inclusive',
    inputTokens: 100,
    cachedInputTokens: 75,
    uncachedInputTokens: 75,
  }), null, 'inconsistent favorable usage is not evidence');
  assert.equal(parseProviderPromptCacheUsage({
    version: 1,
    inputTokens: 100,
    cachedInputTokens: 75,
    uncachedInputTokens: 25,
  }), null, 'dialect may not be inferred from token magnitudes');
});
