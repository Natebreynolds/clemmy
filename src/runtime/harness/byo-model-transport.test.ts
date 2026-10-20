/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/byo-model-transport.test.ts
 *
 * A BYO (OpenAI-compatible) brain's wire call is a dispatch of the model call
 * that owns it, like the Claude and Jev transports. Live 2026-10-20: the
 * approval-result wording a DeepSeek brain wrote was rejected as unbound
 * ("no_completed_receipt") because the BYO client's fetch never told the
 * transport observer anything, so its completed response had no dispatch and
 * no completion receipt; the card kept the fixed host line.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-byo-transport-'));

import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { withTrace } from '@openai/agents-core';

const { getByoModel, resetByoModelCache } = await import('./byo-model.js');
const { withModelTransportRecorder, completedStandaloneModelResponseReceipt } = await import('./model-transport-observation.js');
const { createStandaloneModelAccountingJob, withStandaloneModelAccountingJob, withModelUsageAttribution,
  standaloneModelAccountingJobBinding } = await import('../usage-log.js');

afterEach(() => { mock.restoreAll(); resetByoModelCache(); });

test('a BYO brain\'s wire call is observed as a dispatch, so its completed response earns a completion receipt', async () => {
  const completion = {
    id: 'chatcmpl-byo-transport-1', object: 'chat.completion', created: 1, model: 'fixture-chat',
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"message":"Done: the check printed port 22.","choices":null}' } }],
  };
  const sent: { url?: string; body?: string } = {};
  mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    sent.url = String(url); sent.body = typeof init?.body === 'string' ? init.body : undefined;
    return new Response(JSON.stringify(completion), { headers: { 'content-type': 'application/json' } });
  });
  const model = getByoModel('fixture-chat', { configured: true, baseURL: 'https://byo-transport-fixture.invalid/v1',
    apiKey: 'synthetic-no-auth', providerId: 'byo-transport-fixture', primaryId: 'fixture-chat', judgeId: 'fixture-chat' });

  const job = createStandaloneModelAccountingJob({ operation: 'approval_result_projection',
    operationId: 'approved-result:v1:fixture', revisionDigest: 'b'.repeat(64) });
  const rows: Readonly<Record<string, unknown>>[] = [];
  // Production shape: the resilient wrapper inside getByoModel owns the
  // transport attempt, binds the completed response and finishes the attempt;
  // the standalone job and the recorder are what the public call captures.
  const response = await withTrace('byo-transport-fixture', () => withModelUsageAttribution(
    { sessionId: 'byo-transport-session', sourceUserSeq: 1, attemptId: 'byo-transport-attempt', role: 'writer' },
    () => withModelTransportRecorder(row => rows.push(row), () => withStandaloneModelAccountingJob(job,
      () => model.getResponse({ systemInstructions: 'sys', input: 'synthetic', modelSettings: {},
        tools: [], handoffs: [], outputType: 'text', tracing: false } as never)))));

  assert.ok(sent.url?.includes('/chat/completions'), 'the stub answered the chat-completions call');
  const dispatch = rows.find(row => row.phase === 'dispatch_started');
  assert.ok(dispatch, `the wire call was reported as a dispatch; phases seen: ${JSON.stringify(rows.map(row => row.phase))}`);
  assert.equal(dispatch.transport, 'openai_compatible_chat');
  assert.equal(dispatch.requestedModel, 'fixture-chat', 'the model named in the request body is the requested model');
  assert.ok(rows.some(row => row.phase === 'headers_received' && row.status === 200));
  assert.ok(rows.some(row => row.phase === 'model_result_completed' && row.resultScope === 'original_sdk_response'),
    'the completed original response was observed after its dispatch');

  const receipt = completedStandaloneModelResponseReceipt(response);
  assert.ok(receipt, 'the standalone job can prove its completed response');
  assert.equal(receipt.operation, 'approval_result_projection');
  assert.equal(receipt.usageJobId, standaloneModelAccountingJobBinding(job)?.usageJobId);
});
