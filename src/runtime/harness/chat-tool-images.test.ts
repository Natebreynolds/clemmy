import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIChatCompletionsModel } from '@openai/agents-openai';
import { withTrace } from '@openai/agents-core';
import { CHAT_TOOL_IMAGES_PER_REQUEST, projectChatToolImages, UNSEEN_IMAGE_NOTE, withChatToolImages } from './chat-tool-images.js';
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

function imageTurn(count: number): any[] {
  const rows: any[] = [{ role: 'user', content: 'Check the slides.' }];
  for (let index = 1; index <= count; index += 1) {
    rows.push({ type: 'function_call', callId: `shot${index}`, name: 'http_read', arguments: '{}' });
    rows.push({ type: 'function_call_result', callId: `shot${index}`, name: 'http_read', status: 'completed', output: [
      { type: 'input_text', text: `slide ${index}` }, { type: 'input_image', image: `data:image/png;base64,${index}` },
    ] });
  }
  return rows;
}

function attachedImages(projected: any): string[] {
  return (projected as any[]).filter((row) => row.role === 'user' && Array.isArray(row.content))
    .flatMap((row) => row.content.filter((part: any) => part.type === 'input_image').map((part: any) => part.image));
}

test('only the latest tool images ride along; earlier ones leave a note naming how to see them again', () => {
  const turn = imageTurn(CHAT_TOOL_IMAGES_PER_REQUEST + 2);
  const projected = projectChatToolImages(turn) as any[];
  assert.deepEqual(attachedImages(projected), [3, 4, 5, 6].map((index) => `data:image/png;base64,${index}`));
  const first = projected.find((row) => row.type === 'function_call_result' && row.callId === 'shot1');
  assert.match(JSON.stringify(first.output), /no longer attached\. Call the tool again/);
  assert.equal(JSON.stringify(turn).includes('no longer attached'), false, 'canonical history is untouched');
});

test('without images, every image becomes a note that it was not seen', () => {
  const projected = projectChatToolImages(imageTurn(2), { withoutImages: true }) as any[];
  assert.deepEqual(attachedImages(projected), []);
  assert.equal(projected.filter((row) => row.role === 'user').length, 1, 'no image message is sent');
  for (const callId of ['shot1', 'shot2']) {
    const row = projected.find((item) => item.type === 'function_call_result' && item.callId === callId);
    assert.ok(row.output.some((part: any) => part.text === UNSEEN_IMAGE_NOTE), callId);
  }
});

function refusingModel(status: number) {
  const seen: any[] = [];
  const carries = (request: any) => attachedImages(request.input).length > 0;
  const fail = () => Object.assign(new Error(`${status} image_url is not supported`), { status });
  const answer = { output: [], usage: {}, responseId: 'ok' } as any;
  return {
    seen,
    model: {
      async getResponse(request: any) { seen.push(request); if (carries(request)) throw fail(); return answer; },
      async *getStreamedResponse(request: any) {
        seen.push(request);
        if (carries(request)) throw fail();
        yield { type: 'response_done', response: answer } as any;
      },
    },
  };
}

for (const mode of ['response', 'stream'] as const) {
  test(`a model that refuses images is asked once more with notes in their place, and that is remembered (${mode})`, async () => {
    let clock = 1_000;
    const { seen, model: inner } = refusingModel(400);
    const model = withChatToolImages(inner as never, () => clock);
    const run = async (request: any) => {
      if (mode === 'response') return model.getResponse(request);
      for await (const _ of model.getStreamedResponse(request)) { /* drain */ }
    };
    const request: any = { input: imageTurn(1), modelSettings: {}, tools: [], handoffs: [], outputType: 'text', tracing: false };
    await run(request);
    assert.equal(seen.length, 2);
    assert.equal(attachedImages(seen[0].input).length, 1);
    assert.equal(attachedImages(seen[1].input).length, 0);
    assert.match(JSON.stringify(seen[1].input), /was not seen/);
    await run(request);
    assert.equal(seen.length, 3, 'the next request goes without images straight away');
    clock += 16 * 60_000;
    await run(request);
    assert.equal(seen.length, 5, 'after a while the model is offered images again');
  });
}

test('a refusal that is about the moment, the account or the quota is not answered by dropping images', async () => {
  for (const status of [429, 401, 500]) {
    const { seen, model: inner } = refusingModel(status);
    const model = withChatToolImages(inner as never);
    await assert.rejects(model.getResponse({ input: imageTurn(1) } as any));
    assert.equal(seen.length, 1, String(status));
  }
  const { seen, model: inner } = refusingModel(400);
  const model = withChatToolImages(inner as never);
  await model.getResponse({ input: [{ role: 'user', content: 'no images here' }] } as any);
  assert.equal(seen.length, 1);
});
