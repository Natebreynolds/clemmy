import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIChatCompletionsModel } from '@openai/agents-openai';
import { withTrace } from '@openai/agents-core';
import { projectChatToolImages, withChatToolImages } from './chat-tool-images.js';
import { withTracelessStep } from './traceless-step-model.js';
import { wrapCompletionsCreate } from './byo-model.js';

const image = 'data:image/png;base64,aW1hZ2U=';
const input: any[] = [
  { role: 'user', content: 'Read the attachment.' },
  { type: 'function_call', callId: 'image1', name: 'view_image', arguments: '{}' },
  { type: 'function_call', callId: 'text2', name: 'read_file', arguments: '{}' },
  { type: 'function_call_result', callId: 'image1', name: 'view_image', status: 'completed', output: [
    { type: 'input_text', text: 'Attached picture' }, { type: 'input_image', image },
  ] },
  { type: 'function_call_result', callId: 'text2', name: 'read_file', status: 'completed', output: { type: 'text', text: 'Second read' } },
];

test('image projection preserves canonical history, parallel pairing, and text-only identity', () => {
  const before = JSON.stringify(input);
  const projected = projectChatToolImages(input) as any[];
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(projected.slice(0, 3), input.slice(0, 3));
  assert.equal(projected[4], input[4]);
  assert.equal(projected[5].role, 'user');
  assert.equal(projected[5].content[1].image, image);
  assert.deepEqual(projectChatToolImages(projected), projected, 'idempotent at the transport boundary');
  const textOnly = [input[0], input[4]];
  assert.equal(projectChatToolImages(textOnly), textOnly);
  assert.equal(projectChatToolImages('hello'), 'hello');
});

for (const mode of ['response', 'stream'] as const) {
  test(`real Chat Completions SDK wire carries tool pixels (${mode})`, async () => {
    let body: any;
    const create = wrapCompletionsCreate(async (params: any) => {
      body = params;
      return { id: 'image-test', created: 1, model: 'fixture', object: 'chat.completion',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Read it.' } }] };
    });
    const client = { baseURL: 'http://fixture.invalid', chat: { completions: { create } } };
    const model = withChatToolImages(withTracelessStep(new OpenAIChatCompletionsModel(client as never, 'fixture')));
    const request: any = { input, modelSettings: {}, tools: [], handoffs: [], outputType: 'text', tracing: false };
    if (mode === 'response') await model.getResponse(request);
    else await withTrace('image-wire-test', async () => { for await (const _ of model.getStreamedResponse(request)) { /* drain */ } });
    assert.deepEqual(body.messages.map((row: any) => row.role), ['user', 'assistant', 'tool', 'tool', 'user']);
    assert.equal(body.messages[2].tool_call_id, 'image1');
    assert.match(body.messages[2].content, /Attached picture/);
    assert.equal(body.messages[3].tool_call_id, 'text2');
    assert.deepEqual(body.messages[4].content[1], { type: 'image_url', image_url: { url: image } });
    assert.equal(JSON.stringify(body).split(image).length - 1, 1, 'pixels appear exactly once, not as base64 text');
  });
}
