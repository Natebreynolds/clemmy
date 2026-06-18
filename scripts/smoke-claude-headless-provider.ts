#!/usr/bin/env tsx
import { getClaudeModel, resetClaudeModelCache } from '../src/runtime/harness/claude-model.js';

function extractText(output: unknown): string {
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const item of output) {
    const it = item as { type?: string; content?: unknown };
    if (it.type !== 'message' || !Array.isArray(it.content)) continue;
    for (const part of it.content) {
      const p = part as { type?: string; text?: unknown };
      if (p.type === 'output_text' && typeof p.text === 'string') parts.push(p.text);
    }
  }
  return parts.join('');
}

resetClaudeModelCache();
process.env.CLEMMY_CLAUDE_TRANSPORT = process.env.CLEMMY_CLAUDE_TRANSPORT || 'headless';

const modelId = process.env.CLEMMY_LIVE_CLAUDE_MODEL || 'claude-sonnet-4-6';
const expected = 'CLEMENTINE_CLAUDE_HEADLESS_OK';
const model = getClaudeModel(modelId);
const response = await model.getResponse({
  systemInstructions: 'You are verifying a transport. Return only the requested sentinel text.',
  input: `Reply with exactly: ${expected}`,
  modelSettings: {},
  tools: [],
  outputType: 'text',
  handoffs: [],
  tracing: false,
});

const text = extractText(response.output).trim();
if (text !== expected) {
  throw new Error(`unexpected Claude headless response: ${JSON.stringify(text)}`);
}

const provider = (response as { providerData?: Record<string, unknown> }).providerData ?? {};
if (provider.transport !== 'claude_code_headless') {
  throw new Error(`unexpected Claude transport: ${JSON.stringify(provider.transport)}`);
}

console.log(JSON.stringify({
  ok: true,
  sentinel: text,
  modelId,
  transport: provider.transport,
  responseId: response.responseId,
  usage: {
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    totalTokens: response.usage.totalTokens,
  },
}, null, 2));
