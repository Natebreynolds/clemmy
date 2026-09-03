/**
 * Direct Anthropic Messages transport — Claude without the two vendored
 * adapters.
 *
 * WHY THIS EXISTS (2026-09-03). Today a Claude turn goes
 * agents-core → @openai/agents-extensions/ai-sdk → @ai-sdk/anthropic → wire.
 * Both adapters delete the frames that prove the brain is alive:
 *
 *   - @ai-sdk/anthropic 3.0.82:            `case "ping": return;`
 *   - @openai/agents-extensions ai-sdk:    `case 'reasoning-delta'` accumulates
 *                                          into a local block and emits NO
 *                                          stream event; there is no `'raw'`
 *                                          case, so `includeRawChunks` would
 *                                          fall through `default: break;` too.
 *
 * So an actively streaming Claude cannot tell the harness it is working, and
 * the first-content window benches it. Live: Sonnet 5 held a 200 open for
 * 152,146 ms producing ~190 output tokens, was benched, and the turn paid a
 * rate-limited Codex call and a full GLM re-run of finished work. Upgrading
 * does not help — 0.17.0 still swallows reasoning.
 *
 * We already own everything BELOW the adapters: makeClaudeFetch (auth, envelope,
 * cache breakpoints, error traces) and the usage extraction. This module owns
 * what is left — building the request and reading the stream — so ping,
 * thinking and content all arrive as first-class events.
 *
 * SELECTION: `CLEMMY_CLAUDE_TRANSPORT=direct`. Default OFF; the ai-sdk path is
 * untouched until parity is proven on the real assembled prompt.
 */
import type { AgentInputItem, ModelRequest } from '@openai/agents';
import type { ModelCapability } from './model-wire-registry.js';

/** An Anthropic content block on the request side. */
type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'thinking'; thinking: string; signature?: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

export interface AnthropicMessagesBody {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  tools?: Array<{ name: string; description: string; input_schema: unknown }>;
  output_config?: { effort: string };
  stream?: boolean;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      const row = part as { text?: unknown; type?: unknown };
      return typeof row.text === 'string' ? row.text : '';
    })
    .join('');
}

/** The signature Anthropic minted for a thinking block, echoed back verbatim.
 *  Anthropic REJECTS a thinking block whose signature does not round-trip, so
 *  this is load-bearing rather than metadata. */
function reasoningSignature(item: Record<string, unknown>): string | undefined {
  const provider = item.providerData as Record<string, unknown> | undefined;
  const direct = typeof provider?.signature === 'string' ? provider.signature : undefined;
  if (direct) return direct;
  const anthropic = provider?.anthropic as Record<string, unknown> | undefined;
  return typeof anthropic?.signature === 'string' ? anthropic.signature : undefined;
}

function resultText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    const row = output as { text?: unknown; type?: unknown };
    if (typeof row.text === 'string') return row.text;
    try { return JSON.stringify(output); } catch { return String(output); }
  }
  return output === undefined || output === null ? '' : String(output);
}

/**
 * Agents input items → Anthropic messages.
 *
 * The ordering rule is Anthropic's, not ours: within one assistant turn a
 * `thinking` block MUST precede the `tool_use` blocks it produced, and its
 * signature must round-trip. Consecutive assistant-side items are therefore
 * merged into ONE message with thinking first — emitting them as separate
 * messages, or after the tool_use, is rejected by the API.
 */
export function anthropicMessagesFromInput(input: string | AgentInputItem[]): AnthropicMessage[] {
  if (typeof input === 'string') {
    return input.trim() ? [{ role: 'user', content: [{ type: 'text', text: input }] }] : [];
  }
  const messages: AnthropicMessage[] = [];
  // Blocks for the assistant turn currently being assembled, kept in two piles
  // so thinking can be emitted ahead of the calls regardless of arrival order.
  let thinking: AnthropicBlock[] = [];
  let assistant: AnthropicBlock[] = [];

  const flushAssistant = (): void => {
    const content = [...thinking, ...assistant];
    thinking = [];
    assistant = [];
    if (content.length > 0) messages.push({ role: 'assistant', content });
  };
  const pushUser = (block: AnthropicBlock): void => {
    flushAssistant();
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') last.content.push(block);
    else messages.push({ role: 'user', content: [block] });
  };

  for (const raw of input) {
    const item = raw as unknown as Record<string, unknown>;
    const type = typeof item.type === 'string' ? item.type : 'message';
    if (type === 'message') {
      const role = item.role === 'assistant' ? 'assistant' : 'user';
      const text = textOf(item.content);
      if (!text) continue;
      if (role === 'assistant') assistant.push({ type: 'text', text });
      else pushUser({ type: 'text', text });
      continue;
    }
    if (type === 'reasoning') {
      const text = textOf(item.content) || textOf(item.rawContent);
      const signature = reasoningSignature(item);
      // A thinking block with no signature cannot be replayed; Anthropic only
      // accepts what it signed. Dropping it is correct — the alternative is a
      // 400 that kills the turn.
      if (text && signature) thinking.push({ type: 'thinking', thinking: text, signature });
      continue;
    }
    if (type === 'function_call') {
      const callId = typeof item.callId === 'string' ? item.callId : '';
      const name = typeof item.name === 'string' ? item.name : '';
      if (!callId || !name) continue;
      let parsed: unknown = {};
      try {
        parsed = typeof item.arguments === 'string' && item.arguments.trim()
          ? JSON.parse(item.arguments)
          : {};
      } catch {
        parsed = {};
      }
      assistant.push({ type: 'tool_use', id: callId, name, input: parsed });
      continue;
    }
    if (type === 'function_call_result') {
      const callId = typeof item.callId === 'string' ? item.callId : '';
      if (!callId) continue;
      pushUser({ type: 'tool_result', tool_use_id: callId, content: resultText(item.output) });
      continue;
    }
    // Unknown item kinds are dropped rather than guessed at: an invented block
    // shape is a 400 on the whole turn.
  }
  flushAssistant();
  return messages;
}

/** Harness effort tier → `output_config.effort`, via the registry's map. */
export function anthropicOutputConfig(
  request: ModelRequest,
  capability: ModelCapability,
): { effort: string } | undefined {
  if (capability.thinkingMode !== 'effort' || !capability.supportsEffort) return undefined;
  const settings = request.modelSettings ?? {};
  const provider = (settings.providerData ?? {}) as Record<string, unknown>;
  const options = (provider.providerOptions ?? {}) as Record<string, unknown>;
  const anthropic = (options.anthropic ?? {}) as Record<string, unknown>;
  // An explicit provider-level effort wins; it is how translateSettings speaks.
  if (typeof anthropic.effort === 'string' && anthropic.effort) {
    return { effort: anthropic.effort };
  }
  const tier = settings.reasoning?.effort as keyof ModelCapability['effortMap'] | undefined;
  if (!tier) return undefined;
  const mapped = capability.effortMap[tier];
  return mapped == null ? undefined : { effort: mapped };
}

/**
 * Build the Anthropic Messages body. Pure and offline-testable — the identity
 * prefix, system hoisting and cache breakpoints are added afterwards by
 * applyClaudeEnvelope inside makeClaudeFetch, exactly as they are for the
 * ai-sdk path, so this stays the only new wire surface.
 */
export function buildAnthropicMessagesBody(input: {
  request: ModelRequest;
  modelId: string;
  capability: ModelCapability;
  stream?: boolean;
}): AnthropicMessagesBody {
  const { request, modelId, capability } = input;
  const tools = Array.isArray(request.tools)
    ? request.tools.flatMap((tool) => {
        const row = tool as unknown as Record<string, unknown>;
        const name = typeof row.name === 'string' ? row.name : '';
        if (!name) return [];
        return [{
          name,
          description: typeof row.description === 'string' ? row.description : '',
          input_schema: row.parameters ?? { type: 'object', properties: {} },
        }];
      })
    : [];
  const effort = anthropicOutputConfig(request, capability);
  const maxOutput = Number.isFinite(capability.maxOutput) && capability.maxOutput > 0
    ? capability.maxOutput
    : 8_192;
  return {
    model: modelId,
    max_tokens: maxOutput,
    ...(request.systemInstructions ? { system: request.systemInstructions } : {}),
    messages: anthropicMessagesFromInput(request.input),
    ...(tools.length > 0 ? { tools } : {}),
    ...(effort ? { output_config: effort } : {}),
    ...(input.stream === false ? {} : { stream: true }),
  };
}

// ── SSE reading ─────────────────────────────────────────────────────────────

export interface AnthropicSseEvent {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Split a buffer of Anthropic SSE text into complete frames, returning the
 * frames plus the unconsumed tail. A frame is `event:`/`data:` lines terminated
 * by a blank line; anything after the last terminator is incomplete and is
 * carried to the next chunk.
 */
export function readAnthropicSseFrames(buffer: string): {
  events: AnthropicSseEvent[];
  rest: string;
} {
  const events: AnthropicSseEvent[] = [];
  let rest = buffer;
  for (;;) {
    const boundary = rest.indexOf('\n\n');
    if (boundary === -1) break;
    const frame = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    let eventType = '';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) {
      // A bare `event:` frame (Anthropic's ping arrives this way from some
      // proxies) still proves the socket is being written to.
      if (eventType) events.push({ type: eventType, data: {} });
      continue;
    }
    const payload = dataLines.join('\n');
    let data: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      // A malformed frame is not fatal: skip its payload, keep the type.
    }
    const type = typeof data.type === 'string' ? data.type : eventType;
    if (type) events.push({ type, data });
  }
  return { events, rest };
}
