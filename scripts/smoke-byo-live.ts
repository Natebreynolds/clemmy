#!/usr/bin/env tsx
/**
 * Live smoke for the configured BYO OpenAI-compatible backend.
 *
 * Uses Clementine's BYO model adapter (request relaxation, JSON repair hooks,
 * usage logging, and resilience wrapper), not a raw curl, so this verifies the
 * same path the harness uses for BYO worker/all-in routing.
 */
import { getByoBackendConfig } from '../src/config.js';
import { getByoModel, resetByoModelCache } from '../src/runtime/harness/byo-model.js';
import { withTrace } from '@openai/agents-core';

const expected = 'CLEMENTINE_BYO_LIVE_OK';

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

function safeHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value.replace(/\/\/[^/@]+@/, '//[redacted]@');
  }
}

resetByoModelCache();
const byo = getByoBackendConfig();
if (!byo.configured || !byo.primaryId) {
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: 'No configured BYO backend found.',
    hasBaseURL: Boolean(byo.baseURL),
    hasKey: Boolean(byo.apiKey),
    modelId: byo.primaryId || null,
  }, null, 2));
  process.exit(0);
}

const model = getByoModel(byo.primaryId, byo);
const response = await withTrace('byo-live-smoke', async () => model.getResponse({
  systemInstructions: 'You are verifying a BYO model backend. Return only the requested sentinel text.',
  input: `Reply with exactly: ${expected}`,
  modelSettings: {},
  tools: [],
  outputType: 'text',
  handoffs: [],
  tracing: false,
}));

const text = extractText(response.output).trim();
if (text !== expected) {
  throw new Error(`unexpected BYO response: ${JSON.stringify(text)}`);
}

console.log(JSON.stringify({
  ok: true,
  sentinel: text,
  modelId: byo.primaryId,
  provider: byo.providerLabel || 'custom',
  baseHost: safeHost(byo.baseURL),
  responseId: response.responseId,
  usage: {
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    totalTokens: response.usage.totalTokens,
  },
}, null, 2));
