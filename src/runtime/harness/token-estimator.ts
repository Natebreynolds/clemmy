import type { AgentInputItem } from '@openai/agents';

/**
 * Lightweight token estimator for AgentInputItem[] arrays.
 *
 * Why a heuristic, not js-tiktoken: compaction decisions trigger at
 * 70% / 90% of budget — there's 10-30% margin baked in by design, so a
 * heuristic that's within ±20% of the true count is sufficient. Avoiding
 * the tiktoken WASM dep keeps the daemon cold-start fast and the bundle
 * lean.
 *
 * Approach: chars / 4 for natural-language text (well-known approximation
 * for GPT-family tokenizers on English), with a 1.3× multiplier for JSON
 * payloads (tool args + tool outputs) since structural tokens are denser.
 * Reasoning blobs are treated as natural-language text.
 *
 * If we ever need higher accuracy (e.g. to drive a billing surface or a
 * truly tight budget), swap this for js-tiktoken with the o200k_base
 * encoder — the public API of `estimateInputTokens` stays the same.
 */

const CHARS_PER_TOKEN_TEXT = 4;
const JSON_DENSITY_MULTIPLIER = 1.3;

function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN_TEXT);
}

function estimateJsonTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil((text.length / CHARS_PER_TOKEN_TEXT) * JSON_DENSITY_MULTIPLIER);
}

/**
 * Estimate the input tokens for an AgentInputItem[] in the shape the
 * codex backend sees after serialization. Walks each item by type:
 *
 *   - message items     : tokenize the content (string or content parts)
 *   - function_call     : args is JSON, count denser; name + status + id
 *                         add a small fixed overhead
 *   - function_call_result : output.text is the tool return (natural text
 *                         most often, but JSON sometimes — use JSON
 *                         multiplier defensively)
 *   - reasoning         : summary text + encrypted_content (the encrypted
 *                         blob doesn't tokenize in the model's view but
 *                         we still pass it through; count it as text for
 *                         budget purposes)
 *
 * A small constant overhead (~6 tokens) is added per item to account for
 * delimiters and role markers in the serialized form.
 */
export function estimateInputTokens(items: AgentInputItem[]): number {
  let total = 0;
  for (const item of items) {
    const any = item as Record<string, unknown> & { type?: string; role?: string };
    total += 6; // per-item structural overhead

    if (any.role && (any.type === 'message' || 'content' in any)) {
      const content = any.content;
      if (typeof content === 'string') {
        total += estimateTextTokens(content);
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (part && typeof part === 'object') {
            const p = part as { text?: unknown };
            if (typeof p.text === 'string') total += estimateTextTokens(p.text);
          }
        }
      }
      continue;
    }

    if (any.type === 'function_call') {
      const args = typeof any.arguments === 'string' ? any.arguments : '';
      const name = typeof any.name === 'string' ? any.name : '';
      total += estimateJsonTokens(args) + estimateTextTokens(name);
      continue;
    }

    if (any.type === 'function_call_result') {
      const output = any.output as { type?: string; text?: string } | string | undefined;
      if (typeof output === 'string') {
        total += estimateJsonTokens(output);
      } else if (output && typeof output === 'object' && typeof output.text === 'string') {
        total += estimateJsonTokens(output.text);
      }
      continue;
    }

    if (any.type === 'reasoning') {
      const content = any.content as Array<{ text?: string }> | undefined;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part?.text === 'string') total += estimateTextTokens(part.text);
        }
      }
      const provider = any.providerData as { encryptedContent?: string } | undefined;
      if (typeof provider?.encryptedContent === 'string') {
        total += estimateTextTokens(provider.encryptedContent);
      }
      continue;
    }

    // Unknown shape: fall back to a stringified estimate so we don't
    // silently under-count and trigger compaction late.
    try {
      total += estimateJsonTokens(JSON.stringify(item));
    } catch {
      // ignore
    }
  }
  return total;
}

/** Cheap helper for a single string — used by Discord footer / dashboard. */
export function estimateTextOnlyTokens(text: string): number {
  return estimateTextTokens(text);
}
