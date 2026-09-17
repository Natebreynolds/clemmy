import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withTrace } from '@openai/agents';
import { aisdk } from '@openai/agents-extensions/ai-sdk';
import { createAnthropic } from '@ai-sdk/anthropic';
import { PROVIDER_TOOL_IMAGES_PER_REQUEST, providerPromptWithToolMedia, withProviderToolMedia } from './ai-sdk-tool-media.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function anthropicRequestFor(wrap: boolean): Promise<{ messages: Array<{ role: string; content: Array<Record<string, unknown>> }> }> {
  let body: unknown = null;
  const fetch = async (_url: unknown, init: { body: string }) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({
      id: 'msg_probe', type: 'message', role: 'assistant', model: 'claude-probe',
      content: [{ type: 'text', text: 'seen' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const languageModel = createAnthropic({ apiKey: 'probe', fetch: fetch as never })('claude-probe');
  const model = aisdk(wrap ? withProviderToolMedia(languageModel) : languageModel);
  await withTrace('tool-media-probe', () => model.getResponse({
    systemInstructions: 'probe',
    input: [
      { role: 'user', content: 'look at the workspace' },
      { type: 'function_call', callId: 'call_preview', name: 'space_preview', arguments: '{}', status: 'completed' },
      {
        type: 'function_call_result', callId: 'call_preview', name: 'space_preview', status: 'completed',
        output: [
          { type: 'input_text', text: 'Preview of "Board"' },
          { type: 'input_image', image: `data:image/png;base64,${PNG}` },
        ],
      },
    ],
    modelSettings: {},
    tools: [{ type: 'function', name: 'space_preview', description: 'preview', parameters: { type: 'object', properties: {} }, strict: false }],
    outputType: 'text',
    handoffs: [],
    tracing: false,
  } as never));
  return body as never;
}

function toolResultBlocks(request: Awaited<ReturnType<typeof anthropicRequestFor>>): Array<Record<string, unknown>> {
  const block = request.messages.flatMap((message) => message.content).find((part) => part.type === 'tool_result');
  return (block?.content ?? []) as Array<Record<string, unknown>>;
}

test('a tool result image reaches the Claude Messages request as an image block', async () => {
  const blocks = toolResultBlocks(await anthropicRequestFor(true));
  assert.deepEqual(blocks.map((block) => block.type), ['text', 'image']);
  assert.deepEqual(blocks[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });
});

test('without the rename the provider drops the image, which is the failure this guards', async () => {
  const blocks = toolResultBlocks(await anthropicRequestFor(false));
  assert.deepEqual(blocks.map((block) => block.type), ['text']);
});

test('prompts without tool media are returned unchanged', () => {
  const prompt = [{ role: 'tool', content: [{ type: 'tool-result', output: { type: 'text', value: 'plain' } }] }];
  assert.equal(providerPromptWithToolMedia(prompt), prompt);
  const urlPrompt = [{ role: 'tool', content: [{ type: 'tool-result', output: { type: 'content', value: [{ type: 'media', data: 'https://img.test/a.png', mediaType: 'image/*' }] } }] }];
  const rewritten = providerPromptWithToolMedia(urlPrompt) as typeof urlPrompt;
  assert.deepEqual(rewritten[0]!.content[0]!.output, { type: 'content', value: [{ type: 'image-url', url: 'https://img.test/a.png' }] });
});

test('only the most recent tool-result images are attached to one request', () => {
  const toolResult = (id: string) => ({
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: id, output: { type: 'content', value: [
      { type: 'text', value: `render ${id}` },
      { type: 'media', data: `data-${id}`, mediaType: 'image/png' },
    ] } }],
  });
  const prompt = Array.from({ length: PROVIDER_TOOL_IMAGES_PER_REQUEST + 3 }, (_, index) => toolResult(`r${index}`));
  const rewritten = providerPromptWithToolMedia(prompt) as typeof prompt;
  const parts = rewritten.flatMap((message) => message.content.flatMap((part) => part.output.value)) as Array<Record<string, unknown>>;
  const images = parts.filter((part) => part.type === 'image-data');
  assert.equal(images.length, PROVIDER_TOOL_IMAGES_PER_REQUEST);
  assert.deepEqual(images.map((part) => part.data), prompt.slice(-PROVIDER_TOOL_IMAGES_PER_REQUEST).map((_, index) => `data-r${index + 3}`));
  assert.equal(parts.filter((part) => part.type === 'text' && /no longer attached/.test(String(part.text))).length, 3);
  assert.ok(!parts.some((part) => part.type === 'media'), 'no provider-unknown part survives');
});
