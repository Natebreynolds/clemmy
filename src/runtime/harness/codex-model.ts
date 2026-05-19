/**
 * CodexResponsesModel — native `Model` adapter for the ChatGPT codex
 * backend (https://chatgpt.com/backend-api/codex/responses).
 *
 * The OpenAI Agents SDK exposes a small `Model` interface (two methods
 * — getResponse and getStreamedResponse). This file implements that
 * interface end-to-end against codex's wire protocol — hand-rolled
 * HTTP + SSE, no OpenAI SDK in the request path.
 *
 * Why not just point the OpenAI SDK at codex?
 *   The OpenAI SDK assumes the standard Responses API contract. Codex
 *   diverges in ~6 places: it requires `instructions`, forces
 *   `store: false`, forces `stream: true`, rejects
 *   `previous_response_id` (because it doesn't persist responses),
 *   requires JWT-derived `chatgpt-account-id` + `OpenAI-Beta` +
 *   `originator` headers, and emits `response.completed` with an
 *   empty `output: []` array (items live only in `output_item.done`
 *   events). Patching the SDK via a fetch adapter is whack-a-mole;
 *   every new agent shape finds a new mismatch.
 *
 * This adapter mirrors what pi-ai
 * (@earendil-works/pi-ai/packages/ai/src/providers/openai-codex-responses.ts)
 * and the v0.2 codex-native-runtime.ts both do: speak codex natively.
 *
 * What we plug into the SDK:
 *   - CodexResponsesModel implements `Model.getResponse` and
 *     `Model.getStreamedResponse`. It receives the SDK's `ModelRequest`
 *     and returns `ModelResponse` / `AsyncIterable<StreamEvent>`.
 *   - CodexModelProvider implements `ModelProvider.getModel(name)`.
 *     Register via `setDefaultModelProvider(new CodexModelProvider())`
 *     and every Agent that names a model string by string lookup gets
 *     a CodexResponsesModel back.
 *
 * Auth: each request resolves a fresh codex OAuth access token via
 * `loadFreshCodexAccessToken()`. Token rotation is handled in
 * codex-client.ts (the OAuth wallet); this file just consumes it.
 */

import { Usage } from '@openai/agents-core';
import type {
  Model,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  SerializedTool,
  SerializedHandoff,
  SerializedOutputType,
} from '@openai/agents-core';
import type { AgentInputItem, AgentOutputItem } from '@openai/agents-core';
import type { StreamEvent } from '@openai/agents-core/types';
import { MODELS } from '../../config.js';
import { loadFreshCodexAccessToken, extractAccountIdFromJwt } from './codex-client.js';
import { BoundaryError } from '../boundary-error.js';

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_USER_AGENT = 'Codex/0.118.0';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';

// ----------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------

export class CodexResponsesModel implements Model {
  constructor(public readonly modelId: string) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const events: AnyCodexEvent[] = [];
    for await (const evt of this.#streamCodex(request)) {
      events.push(evt);
    }
    return assembleModelResponse(events);
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const seenOutputItems: CodexOutputItem[] = [];
    let responseId: string | undefined;
    let completedEvent: AnyCodexEvent | undefined;

    for await (const evt of this.#streamCodex(request)) {
      // First codex event we ever see — surface a response_started.
      if (evt.type === 'response.created' && evt.response?.id) {
        responseId = evt.response.id;
        yield { type: 'response_started', providerData: { responseId } } as StreamEvent;
        continue;
      }
      if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') {
        yield {
          type: 'output_text_delta',
          delta: evt.delta,
          providerData: { sequence_number: evt.sequence_number },
        } as StreamEvent;
        continue;
      }
      if (evt.type === 'response.output_item.done' && evt.item) {
        seenOutputItems.push(evt.item);
        continue;
      }
      if (evt.type === 'response.completed' || evt.type === 'response.done') {
        completedEvent = evt;
        continue;
      }
      // Pass everything else through verbatim. The SDK doesn't act on
      // these but trace/observability code can inspect them.
      yield { type: 'model', event: evt } as StreamEvent;
    }

    // T1.4 — refuse to fabricate a clean "response_done" when the
    // upstream stream never emitted response.completed. The previous
    // behavior here synthesized response_done with empty usage,
    // letting the SDK proceed as if the model had finished cleanly;
    // the caller could not distinguish "model said nothing" from
    // "connection dropped mid-stream." Throw a structured boundary
    // error instead so the harness logs it as codex.sse_truncated +
    // surfaces a real message to the user.
    if (!completedEvent) {
      throw new BoundaryError({
        kind: 'codex.sse_truncated',
        retryable: true,
        userMessage: "Clementine's model backend dropped the connection before finishing this turn. Retry — if it persists, the Codex backend may be having an incident.",
        operatorMessage: `getStreamedResponse: SSE ended without response.completed (items=${seenOutputItems.length}, responseId=${responseId ?? 'none'})`,
        context: {
          itemCount: seenOutputItems.length,
          responseId: responseId ?? null,
        },
      });
    }

    // Codex's response.completed has output: []. Stuff in the items
    // we accumulated so the SDK builds the right ModelResponse.
    const finalOutput = seenOutputItems.map(convertCodexItemToSdkOutputItem);
    // The response_done event schema expects a *plain* usage object —
    // not a Usage class instance (which has Array<Record<>> for the
    // details fields). Mirror the OpenAIResponsesModel's streaming
    // shape: snake_case detail spreads, camelCase token counts.
    const u = completedEvent?.response?.usage ?? {};
    yield {
      type: 'response_done',
      response: {
        id: responseId ?? completedEvent?.response?.id ?? '',
        output: finalOutput,
        usage: {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          totalTokens: u.total_tokens ?? 0,
          inputTokensDetails: { ...(u.input_tokens_details ?? {}) },
          outputTokensDetails: { ...(u.output_tokens_details ?? {}) },
        },
        providerData: completedEvent?.response ?? {},
      },
      providerData: {},
    } as unknown as StreamEvent;
  }

  /**
   * Single source of truth for "make the codex request, yield SSE
   * events." Both getResponse and getStreamedResponse consume it.
   */
  async *#streamCodex(request: ModelRequest): AsyncGenerator<AnyCodexEvent> {
    const token = await loadFreshCodexAccessToken();
    const accountId = extractAccountIdFromJwt(token) ?? '';
    if (!accountId) {
      throw new CodexModelError(
        'Could not extract chatgpt_account_id from the codex OAuth token. ' +
          'Run `clementine auth login-native` to re-login.',
      );
    }

    const body = buildCodexRequestBody(this.modelId, request);
    const res = await fetch(CODEX_URL, {
      method: 'POST',
      headers: buildCodexHeaders(token, accountId),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) {
      const detail = await safeReadErrorBody(res);
      throw new CodexModelError(
        `Codex /responses returned ${res.status} ${res.statusText}${detail ? ': ' + detail : ''}`,
        res.status,
      );
    }
    if (!res.body) {
      throw new CodexModelError('Codex /responses returned an empty body.');
    }

    yield* parseCodexSse(res.body);
  }
}

export class CodexModelProvider implements ModelProvider {
  constructor(private readonly defaultModelId: string = MODELS.primary) {}
  getModel(modelName?: string): Model {
    return new CodexResponsesModel(resolveCodexModel(modelName ?? this.defaultModelId));
  }
}

export class CodexModelError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'CodexModelError';
  }
}

// ----------------------------------------------------------------------
// Request body construction
// ----------------------------------------------------------------------

function resolveCodexModel(name: string): string {
  // Codex only accepts gpt-5* model ids. Fall back to a known good one
  // so a stray model name (e.g. an experimental autonomous workflow)
  // doesn't take the harness down.
  return name && name.startsWith('gpt-5') ? name : 'gpt-5.4';
}

interface CodexRequestBody {
  model: string;
  instructions: string;
  store: false;
  stream: true;
  input: unknown[];
  tools: unknown[];
  tool_choice: 'auto' | 'required' | 'none' | string;
  parallel_tool_calls?: boolean;
  text?: unknown;
  include: string[];
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  truncation?: 'auto' | 'disabled';
  reasoning?: { effort?: string; summary?: string };
}

function buildCodexRequestBody(modelId: string, request: ModelRequest): CodexRequestBody {
  const tools = serializeTools(request.tools, request.handoffs);
  const body: CodexRequestBody = {
    model: resolveCodexModel(modelId),
    instructions: request.systemInstructions || 'You are a helpful assistant.',
    store: false,
    stream: true,
    input: serializeInput(request.input),
    tools,
    tool_choice: normalizeToolChoice(request.modelSettings?.toolChoice, tools.length > 0),
    include: ['reasoning.encrypted_content'],
  };

  if (tools.length > 0 && typeof request.modelSettings?.parallelToolCalls === 'boolean') {
    body.parallel_tool_calls = request.modelSettings.parallelToolCalls;
  }
  if (typeof request.modelSettings?.temperature === 'number') {
    body.temperature = request.modelSettings.temperature;
  }
  if (typeof request.modelSettings?.topP === 'number') {
    body.top_p = request.modelSettings.topP;
  }
  if (typeof request.modelSettings?.maxTokens === 'number') {
    body.max_output_tokens = request.modelSettings.maxTokens;
  }
  if (request.modelSettings?.truncation) {
    body.truncation = request.modelSettings.truncation;
  }
  if (request.modelSettings?.reasoning?.effort || request.modelSettings?.reasoning?.summary) {
    body.reasoning = {
      effort: request.modelSettings.reasoning.effort ?? undefined,
      summary: request.modelSettings.reasoning.summary ?? 'auto',
    };
  }

  const responseFormat = buildResponseFormat(request.outputType, request.modelSettings?.text);
  if (responseFormat) {
    body.text = responseFormat;
  }

  return body;
}

function normalizeToolChoice(
  choice: ModelRequest['modelSettings']['toolChoice'],
  hasTools: boolean,
): CodexRequestBody['tool_choice'] {
  if (!hasTools) return 'none';
  if (!choice) return 'auto';
  if (choice === 'auto' || choice === 'required' || choice === 'none') return choice;
  return choice;
}

function buildResponseFormat(
  outputType: SerializedOutputType | undefined,
  text: ModelRequest['modelSettings']['text'] | undefined,
): unknown {
  const textVerbosity = text?.verbosity;
  if (!outputType || outputType === 'text') {
    return textVerbosity ? { verbosity: textVerbosity } : undefined;
  }
  // Structured output. The SDK serializes Zod schemas into a
  // JsonSchemaDefinition with { name, type: 'json_schema', schema, strict }.
  const def = outputType as { type?: string; name?: string; schema?: unknown; strict?: boolean };
  return {
    format: {
      type: 'json_schema',
      name: def.name ?? 'output',
      schema: def.schema,
      strict: def.strict !== false,
    },
    ...(textVerbosity ? { verbosity: textVerbosity } : {}),
  };
}

// ----------------------------------------------------------------------
// Input + tool serialization
// ----------------------------------------------------------------------

/**
 * Convert the SDK's AgentInputItem[] into the codex Responses API wire
 * format. Codex needs `function_call` items to carry both `id` and
 * `call_id`, and the matching `function_call_output` must share the
 * `call_id` value. Cross-turn omission of the `function_call` is what
 * caused the "No tool call found for function call output" 400s — we
 * preserve everything verbatim.
 */
function serializeInput(input: ModelRequest['input']): unknown[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  const out: unknown[] = [];
  for (const item of input) {
    const serialized = serializeInputItem(item);
    if (serialized) out.push(serialized);
  }
  return out;
}

function serializeInputItem(item: AgentInputItem): unknown {
  const anyItem = item as Record<string, unknown> & { type?: string; role?: string };
  // Plain message items pass through with content normalized.
  if (anyItem.role && (anyItem.type === 'message' || 'content' in anyItem)) {
    const content = anyItem.content;
    if (typeof content === 'string') {
      return { role: anyItem.role, content };
    }
    if (Array.isArray(content)) {
      return {
        role: anyItem.role,
        content: content.map(normalizeContentPart),
      };
    }
    return { role: anyItem.role, content: '' };
  }
  // Tool call → emitted by a previous assistant turn.
  if (anyItem.type === 'function_call') {
    return {
      type: 'function_call',
      id: anyItem.id,
      call_id: anyItem.callId,
      name: anyItem.name,
      arguments: anyItem.arguments,
      status: anyItem.status,
    };
  }
  // Tool result paired with a prior function_call.
  if (anyItem.type === 'function_call_result') {
    const output = anyItem.output as { type?: string; text?: string } | undefined;
    return {
      type: 'function_call_output',
      id: anyItem.id,
      call_id: anyItem.callId,
      output: output?.type === 'text' ? output.text ?? '' : JSON.stringify(output ?? null),
      status: anyItem.status,
    };
  }
  // Reasoning items — pass the encrypted_content blob through so codex
  // can resume reasoning state without re-deriving it.
  if (anyItem.type === 'reasoning') {
    const reasoningContent = anyItem.content as Array<{ text: string }> | undefined;
    const providerData = anyItem.providerData as { encryptedContent?: string } | undefined;
    return {
      id: anyItem.id,
      type: 'reasoning',
      summary: reasoningContent?.map((c) => ({ type: 'summary_text', text: c.text })) ?? [],
      encrypted_content: providerData?.encryptedContent,
    };
  }
  // Anything else (computer calls, hosted tools, etc.) we don't
  // currently use in the harness; pass through as-is and let codex
  // tell us if it doesn't like the shape.
  return item;
}

function normalizeContentPart(part: unknown): unknown {
  if (!part || typeof part !== 'object') return part;
  const p = part as { type?: string; text?: string };
  if (p.type === 'input_text' || p.type === 'output_text') {
    return { type: p.type, text: p.text ?? '' };
  }
  return part;
}

function serializeTools(
  tools: SerializedTool[],
  handoffs: SerializedHandoff[],
): unknown[] {
  const out: unknown[] = [];
  for (const tool of tools) {
    const t = tool as { type: string };
    if (t.type === 'function') {
      const f = tool as {
        type: 'function';
        name: string;
        description?: string;
        parameters: unknown;
        strict?: boolean;
      };
      out.push({
        type: 'function',
        name: f.name,
        description: f.description,
        parameters: f.parameters,
        strict: f.strict,
      });
      continue;
    }
    // Hosted/computer tools — pass providerData if present so codex
    // can match the canonical shape. Today's harness doesn't lean on
    // these; the local function tools are the primary path.
    out.push(tool);
  }
  for (const handoff of handoffs) {
    out.push({
      type: 'function',
      name: handoff.toolName,
      description: handoff.toolDescription,
      parameters: handoff.inputJsonSchema,
      strict: handoff.strictJsonSchema,
    });
  }
  return out;
}

// ----------------------------------------------------------------------
// Headers + auth
// ----------------------------------------------------------------------

function buildCodexHeaders(token: string, accountId: string): Headers {
  const h = new Headers();
  h.set('Authorization', `Bearer ${token}`);
  h.set('Content-Type', 'application/json');
  h.set('Accept', 'text/event-stream');
  h.set('User-Agent', CODEX_USER_AGENT);
  h.set('chatgpt-account-id', accountId);
  h.set('OpenAI-Beta', 'responses=experimental');
  h.set('originator', 'codex_cli_rs');
  return h;
}

// ----------------------------------------------------------------------
// SSE parsing + codex event types
// ----------------------------------------------------------------------

interface CodexOutputItem {
  id?: string;
  type: string;
  role?: string;
  status?: string;
  content?: Array<{
    type: string;
    text?: string;
    annotations?: unknown[];
    logprobs?: unknown[];
  }>;
  call_id?: string;
  name?: string;
  arguments?: string;
  summary?: Array<{ type: string; text: string }>;
  encrypted_content?: string;
  [key: string]: unknown;
}

interface AnyCodexEvent {
  type?: string;
  item?: CodexOutputItem;
  delta?: string;
  sequence_number?: number;
  response?: {
    id?: string;
    output?: unknown[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      input_tokens_details?: Record<string, unknown>;
      output_tokens_details?: Record<string, unknown>;
    };
    error?: { code?: string; message?: string };
  };
  [key: string]: unknown;
}

async function* parseCodexSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<AnyCodexEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf('\n\n');
      while (idx !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseCodexBlock(block);
        if (ev) yield ev;
        idx = buf.indexOf('\n\n');
      }
    }
    if (buf.trim()) {
      const ev = parseCodexBlock(buf);
      if (ev) yield ev;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* best effort */
    }
  }
}

function parseCodexBlock(block: string): AnyCodexEvent | null {
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return null;
  const joined = dataLines.join('\n').trim();
  if (!joined || joined === '[DONE]') return null;
  try {
    return JSON.parse(joined) as AnyCodexEvent;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------
// Codex item → SDK AgentOutputItem
// ----------------------------------------------------------------------

function convertCodexItemToSdkOutputItem(item: CodexOutputItem): AgentOutputItem {
  if (item.type === 'message') {
    const { id, type, role, status, content, ...providerData } = item;
    return {
      id,
      type,
      role,
      status,
      content: (content ?? []).map((c) => {
        if (c.type === 'output_text') {
          return {
            type: 'output_text',
            text: c.text ?? '',
            providerData: { annotations: c.annotations, logprobs: c.logprobs },
          };
        }
        return c as unknown;
      }),
      providerData,
    } as AgentOutputItem;
  }
  if (item.type === 'function_call') {
    const { id, type, call_id, name, arguments: args, status, ...providerData } = item;
    return {
      id,
      type: 'function_call',
      callId: call_id ?? '',
      name: name ?? '',
      arguments: args ?? '',
      status: status,
      providerData,
    } as unknown as AgentOutputItem;
  }
  if (item.type === 'reasoning') {
    const { id, type, summary, encrypted_content, ...providerData } = item;
    return {
      id,
      type: 'reasoning',
      content: (summary ?? []).map((s) => ({ type: 'summary_text', text: s.text })),
      providerData: { ...providerData, encryptedContent: encrypted_content },
    } as unknown as AgentOutputItem;
  }
  // Unknown item — keep as-is so the SDK can decide what to do.
  return item as unknown as AgentOutputItem;
}

// ----------------------------------------------------------------------
// Aggregation helpers
// ----------------------------------------------------------------------

function assembleModelResponse(events: AnyCodexEvent[]): ModelResponse {
  const items: CodexOutputItem[] = [];
  let responseId: string | undefined;
  let completed: AnyCodexEvent | undefined;
  for (const evt of events) {
    if (evt.type === 'response.created' && evt.response?.id) {
      responseId = evt.response.id;
    } else if (evt.type === 'response.output_item.done' && evt.item) {
      items.push(evt.item);
    } else if (evt.type === 'response.completed' || evt.type === 'response.done') {
      completed = evt;
    }
  }
  // T1.4 — SSE truncation honesty. If we processed the entire event
  // stream and never saw a `response.completed` (or `response.done`),
  // the upstream connection dropped mid-response. Before this throw,
  // we returned a ModelResponse with empty usage and partial items;
  // the SDK then treated that as "the model finished cleanly with no
  // work to do" and the harness emitted an empty conversation_completed
  // — observed on the 2026-05-17 cluster of 15 sessions that died
  // with no diagnostic surface. Now we throw a structured error the
  // top-level handler can retry on (`retryable: true`) and surface
  // to the user as "Model response was cut short."
  if (!completed) {
    throw new BoundaryError({
      kind: 'codex.sse_truncated',
      retryable: true,
      userMessage: "Clementine's model backend dropped the connection before finishing this turn. Retry — if it persists, the Codex backend may be having an incident.",
      operatorMessage: `assembleModelResponse: SSE ended without response.completed (events=${events.length}, items=${items.length}, responseId=${responseId ?? 'none'})`,
      context: {
        eventCount: events.length,
        itemCount: items.length,
        responseId: responseId ?? null,
        lastEventType: events[events.length - 1]?.type ?? null,
      },
    });
  }
  return {
    output: items.map(convertCodexItemToSdkOutputItem),
    usage: extractUsage(completed),
    responseId: responseId ?? completed?.response?.id,
    providerData: completed?.response ?? {},
  };
}

function extractUsage(event: AnyCodexEvent | undefined): Usage {
  const u = event?.response?.usage ?? {};
  // The Usage constructor accepts snake_case fields. Codex's response
  // shape is already snake_case so we pass it through directly.
  return new Usage({
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? 0,
    input_tokens_details: u.input_tokens_details ?? {},
    output_tokens_details: u.output_tokens_details ?? {},
  });
}

async function safeReadErrorBody(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    return text.length > 500 ? text.slice(0, 500) + '…' : text;
  } catch {
    return undefined;
  }
}
