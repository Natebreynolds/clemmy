import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';

const priorHome = process.env.CLEMENTINE_HOME;
const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-judge-effort-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
mkdirSync(path.join(testHome, 'state'), { recursive: true });
const { Usage, setDefaultModelProvider } = await import('@openai/agents');
const { runRoutedJudgeAttempt, parseCompletionVerdict } = await import('./objective-judge.js');
const { buildCodexRequestBody, CodexModelProvider } = await import('./codex-model.js');
const { getByoModel, resetByoModelCache } = await import('./byo-model.js');
const { closeEventLog } = await import('./eventlog.js');

after(() => {
  mock.restoreAll();
  resetByoModelCache();
  setDefaultModelProvider(new CodexModelProvider());
  closeEventLog();
  rmSync(testHome, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = priorHome;
});

for (const route of ['concrete', 'string_fallback'] as const) {
  test(`actual completion Runner leaves Terra wire reasoning to provider for ${route}`, async () => {
    const requests: ModelRequest[] = [];
    const model: Model = {
      async getResponse(request): Promise<ModelResponse> {
        requests.push(request);
        return { output: [{ type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'DONE: exact deliverable checked', providerData: {} }] }],
          usage: new Usage(), responseId: 'effort-fixture' };
      },
      async *getStreamedResponse() { throw Error('ordinary judge must not stream'); },
    };
    setDefaultModelProvider({ getModel: async modelId => {
      assert.equal(modelId, 'gpt-5.6-terra');
      return model;
    } });
    const verdict = await runRoutedJudgeAttempt({ model: route === 'concrete' ? model : null,
      modelId: 'gpt-5.6-terra', judgeFamily: 'codex', brainFamily: 'codex',
      selfJudge: true, ownerSelectedJudge: true }, 'Audit the accepted objective.',
      'Objective: read this report. Delivered: the report was read.', parseCompletionVerdict);
    assert.equal(verdict.done, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.modelSettings.reasoning?.effort, undefined);
    const wire = JSON.parse(JSON.stringify(buildCodexRequestBody('gpt-5.6-terra', requests[0]!)));
    assert.equal(wire.model, 'gpt-5.6-terra');
    assert.equal(Object.hasOwn(wire, 'reasoning'), false, 'neither forced low nor SDK implicit none reaches wire');
  });
}

test('actual Grok completion adapter preserves its existing provider-default reasoning wire', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.url, 'https://judge-effort.invalid/v1/chat/completions');
    bodies.push(await request.json() as Record<string, unknown>);
    return new Response(JSON.stringify({ id: 'grok-effort-fixture', object: 'chat.completion', created: 1,
      model: 'grok-4.6', choices: [{ index: 0, message: { role: 'assistant', content: 'DONE: exact deliverable checked' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const model = getByoModel('grok-4.6', { configured: true,
      baseURL: 'https://judge-effort.invalid/v1', apiKey: 'fixture-key-never-real',
      primaryId: 'grok-4.6', judgeId: 'grok-4.6', providerLabel: 'xAI' });
    const verdict = await runRoutedJudgeAttempt({ model, modelId: 'grok-4.6', judgeFamily: 'byo',
      judgeProviderId: 'xai', brainFamily: 'byo', selfJudge: true, ownerSelectedJudge: true },
      'Audit the accepted objective.', 'Objective: read this report. Delivered: the report was read.', parseCompletionVerdict);
    assert.equal(verdict.done, true);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]!.model, 'grok-4.6');
    assert.equal(Object.hasOwn(bodies[0]!, 'reasoning_effort'), false);
    assert.equal(Object.hasOwn(bodies[0]!, 'thinking'), false);
  } finally { mock.restoreAll(); resetByoModelCache(); }
});
