import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { Usage } from '@openai/agents-core';
import type { AgentInputItem, AgentOutputItem, Model, ModelRequest, ModelResponse } from '@openai/agents-core';
import type { StreamEvent } from '@openai/agents-core/types';
import { getRuntimeEnv } from '../../config.js';
import { augmentPath } from '../spawn-env.js';
import { loadFreshClaudeAccessToken } from '../claude-oauth.js';
import pino from 'pino';

const logger = pino({ name: 'clementine.claude-headless-model' });

type SpawnLike = typeof spawn;
let spawnImpl: SpawnLike = spawn;

export function setClaudeHeadlessSpawnForTest(fn: SpawnLike | null): void {
  spawnImpl = fn ?? spawn;
}

let cliAvailableOverride: boolean | null = null;
/** Test seam — force claudeHeadlessCliAvailable() to a fixed value (null = real PATH scan). */
export function setClaudeHeadlessCliAvailableForTest(value: boolean | null): void {
  cliAvailableOverride = value;
}

/** Whether the `claude` CLI is resolvable on PATH. The headless transport
 *  spawns it directly (`claude -p …`); if it's absent the caller must fall back
 *  to the raw Messages adapter (same oat01 subscription token) instead of
 *  hard-failing every Claude-brain turn with spawn ENOENT — which is NOT a
 *  fallover error, so nothing auto-recovers from it. */
export function claudeHeadlessCliAvailable(): boolean {
  if (cliAvailableOverride !== null) return cliAvailableOverride;
  return resolveClaudeCliPath() !== null;
}

/**
 * Resolve the absolute path to the `claude` CLI binary, or null if absent.
 * Scans the AUGMENTED PATH (so a /Applications Electron launch — whose inherited
 * PATH lacks ~/.local/bin where the native installer drops the launcher — still
 * finds it). An explicit CLAUDE_CLI_PATH env override wins. Used by the headless
 * transport (spawn `claude -p`) AND the Agent SDK lane (pathToClaudeCodeExecutable),
 * so both run the user's real, subscription-authed, auto-updating Claude Code.
 */
export function resolveClaudeCliPath(): string | null {
  const override = (process.env.CLAUDE_CLI_PATH || '').trim();
  if (override && existsSync(override)) return override;
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  const dirs = augmentPath(process.env.PATH).split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        const candidate = path.join(dir, `claude${ext}`);
        if (existsSync(candidate)) return candidate;
      } catch {
        /* unreadable PATH entry — keep scanning */
      }
    }
  }
  return null;
}

export type ClaudeSubscriptionTransport = 'headless' | 'raw_messages';

/** Default to the official Claude Code print-mode path. The raw Messages adapter
 *  can authenticate with an oat01 token, but live usage proved it does not draw
 *  from the user's Claude subscription quota the way Claude Code / Agent SDK do. */
export function claudeSubscriptionTransport(): ClaudeSubscriptionTransport {
  const raw = (getRuntimeEnv('CLEMMY_CLAUDE_TRANSPORT', 'headless') || 'headless').trim().toLowerCase();
  return raw === 'raw' || raw === 'raw_messages' || raw === 'messages' ? 'raw_messages' : 'headless';
}

export function claudeCliModelArg(modelId: string): string {
  const id = (modelId || '').trim().toLowerCase();
  if (/\bopus\b|claude-opus/.test(id)) return 'opus';
  if (/\bfable\b|claude-fable/.test(id)) return 'fable';
  if (/\bhaiku\b|claude-haiku/.test(id)) return 'haiku';
  if (/\bsonnet\b|claude-sonnet|^claude-/.test(id)) return 'sonnet';
  return modelId || 'sonnet';
}

export function buildClaudeHeadlessArgs(modelId: string): string[] {
  return [
    '-p',
    '--safe-mode',
    '--disable-slash-commands',
    '--tools',
    '',
    '--model',
    claudeCliModelArg(modelId),
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
}

export async function buildClaudeHeadlessEnv(): Promise<NodeJS.ProcessEnv> {
  const token = await loadFreshClaudeAccessToken();
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  // A /Applications Electron launch inherits a minimal PATH; widen it so the
  // spawned `claude` CLI (and anything it shells out to) resolves the same dirs
  // the rest of the harness uses.
  env.PATH = augmentPath(env.PATH);
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = env.CLAUDE_AGENT_SDK_CLIENT_APP || 'clementine';
  return env;
}

export function renderClaudeHeadlessPrompt(request: ModelRequest): string {
  const sections: string[] = [];
  const system = (request.systemInstructions ?? '').trim();
  if (system) sections.push(`System instructions:\n${system}`);

  const toolCount = Array.isArray(request.tools) ? request.tools.length : 0;
  const handoffCount = Array.isArray(request.handoffs) ? request.handoffs.length : 0;
  if (toolCount > 0 || handoffCount > 0) {
    sections.push([
      'Runtime note:',
      'This Claude subscription transport is running through Claude Code print mode as a text specialist.',
      'Clementine native tools and handoffs are not exposed inside this subprocess.',
      'Answer from the supplied context; do not claim you used tools you did not use.',
    ].join(' '));
  }

  if (request.outputType && request.outputType !== 'text') {
    sections.push([
      'Output contract:',
      'Return only valid JSON for this schema or contract.',
      'Do not wrap the JSON in markdown fences. Do not include prose before or after the JSON.',
      safeJson(request.outputType),
    ].join('\n'));
  }

  const input = renderAgentInput(request.input);
  if (input) sections.push(`Conversation/input:\n${input}`);
  return sections.join('\n\n').trim() || 'Respond to the user.';
}

function renderAgentInput(input: string | AgentInputItem[]): string {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  const parts: string[] = [];
  for (const item of input) {
    const it = item as Record<string, unknown>;
    const type = typeof it.type === 'string' ? it.type : 'message';
    const role = typeof it.role === 'string' ? it.role : type;
    if (type === 'function_call') {
      parts.push(`[assistant tool call: ${String(it.name ?? 'tool')} ${String(it.arguments ?? '')}]`);
      continue;
    }
    if (type === 'function_call_result') {
      parts.push(`[tool result ${String(it.callId ?? it.call_id ?? '')}]\n${renderContent(it.output ?? it.content)}`);
      continue;
    }
    if (type === 'reasoning' || type === 'compaction') continue;
    const text = renderContent(it.content ?? it.text ?? it.output);
    if (text) parts.push(`${role}:\n${text}`);
  }
  return parts.join('\n\n').trim();
}

function renderContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content.map(renderContentPart).filter(Boolean).join('\n').trim();
  }
  if (typeof content === 'object') return renderContentPart(content);
  return String(content);
}

function renderContentPart(part: unknown): string {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  const p = part as Record<string, unknown>;
  if (typeof p.text === 'string') return p.text;
  if (typeof p.refusal === 'string') return p.refusal;
  if (typeof p.output === 'string') return p.output;
  if (typeof p.image === 'string') return `[image: ${p.image.slice(0, 120)}]`;
  if (typeof p.file === 'string') return `[file: ${p.file.slice(0, 120)}]`;
  if (p.file && typeof p.file === 'object') return `[file: ${safeJson(p.file).slice(0, 240)}]`;
  return '';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

type ClaudeHeadlessEvent = {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: {
    id?: string;
    model?: string;
    content?: unknown;
    usage?: ClaudeUsageShape;
  };
  result?: string;
  usage?: ClaudeUsageShape;
  total_cost_usd?: number;
  [key: string]: unknown;
};

type ClaudeUsageShape = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: unknown;
};

interface HeadlessRunState {
  responseId: string;
  requestId?: string;
  sessionId?: string;
  model?: string;
  text: string;
  emittedText: string;
  usage?: ClaudeUsageShape;
  resultEvent?: ClaudeHeadlessEvent;
  rawEvents: number;
}

function textFromClaudeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown };
    if (typeof b.text === 'string' && (b.type === 'text' || b.type === 'output_text' || b.type == null)) {
      out.push(b.text);
    }
  }
  return out.join('');
}

function deltaFromAssistantMessage(state: HeadlessRunState, evt: ClaudeHeadlessEvent): string {
  const text = textFromClaudeContent(evt.message?.content);
  if (!text) return '';
  state.text = text;
  if (evt.message?.usage) state.usage = evt.message.usage;
  if (evt.message?.model) state.model = evt.message.model;
  if (evt.message?.id) state.requestId = evt.message.id;
  if (text.startsWith(state.emittedText)) {
    const delta = text.slice(state.emittedText.length);
    state.emittedText = text;
    return delta;
  }
  state.emittedText = text;
  return text;
}

function applyResultEvent(state: HeadlessRunState, evt: ClaudeHeadlessEvent): void {
  state.resultEvent = evt;
  if (typeof evt.result === 'string') state.text = evt.result;
  if (evt.usage) state.usage = evt.usage;
  if (typeof evt.session_id === 'string') state.sessionId = evt.session_id;
}

function usageFromClaude(u: ClaudeUsageShape | undefined): Usage {
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const inputTokens = n(u?.input_tokens) + n(u?.cache_creation_input_tokens) + n(u?.cache_read_input_tokens);
  const outputTokens = n(u?.output_tokens);
  return new Usage({
    requests: 1,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    input_tokens_details: {
      cacheCreationInputTokens: n(u?.cache_creation_input_tokens),
      cacheReadInputTokens: n(u?.cache_read_input_tokens),
    },
  });
}

function assistantMessage(text: string): AgentOutputItem {
  return {
    id: `claude-headless-message-${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  } as AgentOutputItem;
}

export function normalizeClaudeHeadlessOutputText(text: string, outputType: ModelRequest['outputType']): string {
  if (outputType === 'text') return text;
  let out = text.trim();
  const fenced = out.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenced?.[1]) out = fenced[1].trim();
  if ((out.startsWith('{') && out.endsWith('}')) || (out.startsWith('[') && out.endsWith(']'))) return out;
  const objStart = out.indexOf('{');
  const arrStart = out.indexOf('[');
  const starts = [objStart, arrStart].filter((i) => i >= 0);
  if (starts.length === 0) return out;
  const start = Math.min(...starts);
  const open = out[start];
  const close = open === '{' ? '}' : ']';
  const end = out.lastIndexOf(close);
  return end > start ? out.slice(start, end + 1).trim() : out;
}

function modelResponseFromState(state: HeadlessRunState, outputType: ModelRequest['outputType']): ModelResponse {
  const text = normalizeClaudeHeadlessOutputText(state.text || state.emittedText, outputType);
  return {
    output: text ? [assistantMessage(text)] : [],
    usage: usageFromClaude(state.usage),
    responseId: state.sessionId || state.requestId || state.responseId,
    requestId: state.requestId,
    providerData: {
      transport: 'claude_code_headless',
      sessionId: state.sessionId,
      model: state.model,
      rawEvents: state.rawEvents,
      resultSubtype: state.resultEvent?.subtype,
      totalCostUsd: state.resultEvent?.total_cost_usd,
    },
  };
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function* parseJsonLines(stream: NodeJS.ReadableStream): AsyncGenerator<ClaudeHeadlessEvent> {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    for (;;) {
      const idx = buffer.indexOf('\n');
      if (idx < 0) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line) as ClaudeHeadlessEvent;
      } catch {
        logger.debug({ line: line.slice(0, 240) }, 'ignored non-json line from claude headless stdout');
      }
    }
  }
  const tail = buffer.trim();
  if (tail) {
    try {
      yield JSON.parse(tail) as ClaudeHeadlessEvent;
    } catch {
      logger.debug({ line: tail.slice(0, 240) }, 'ignored trailing non-json from claude headless stdout');
    }
  }
}

function collectStderr(child: ChildProcessWithoutNullStreams): () => string {
  const chunks: Buffer[] = [];
  child.stderr.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
  return () => Buffer.concat(chunks).toString('utf8').trim();
}

async function* runClaudeHeadless(request: ModelRequest, modelId: string): AsyncGenerator<{ kind: 'delta'; delta: string } | { kind: 'done'; response: ModelResponse }> {
  const env = await buildClaudeHeadlessEnv();
  const args = buildClaudeHeadlessArgs(modelId);
  const prompt = renderClaudeHeadlessPrompt(request);
  const state: HeadlessRunState = {
    responseId: `claude-headless-${randomUUID()}`,
    text: '',
    emittedText: '',
    rawEvents: 0,
  };
  const command = resolveClaudeCliPath() ?? 'claude';
  const child = spawnImpl(command, args, {
    env,
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  const stderr = collectStderr(child);
  const exit = waitForExit(child);
  const abort = () => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  };
  if (request.signal?.aborted) abort();
  request.signal?.addEventListener('abort', abort, { once: true });
  try {
    child.stdin.end(prompt);
    for await (const evt of parseJsonLines(child.stdout)) {
      state.rawEvents += 1;
      if (typeof evt.session_id === 'string') state.sessionId = evt.session_id;
      if (evt.type === 'assistant') {
        const delta = deltaFromAssistantMessage(state, evt);
        if (delta) yield { kind: 'delta', delta };
      } else if (evt.type === 'result') {
        applyResultEvent(state, evt);
      }
    }
    const { code, signal } = await exit;
    if (code !== 0) {
      throw new Error(`Claude Code headless exited ${code ?? signal ?? 'unknown'}: ${stderr().slice(0, 2000)}`);
    }
    if (state.text && state.text.startsWith(state.emittedText)) {
      const delta = state.text.slice(state.emittedText.length);
      state.emittedText = state.text;
      if (delta) yield { kind: 'delta', delta };
    } else if (state.text && !state.emittedText) {
      state.emittedText = state.text;
      yield { kind: 'delta', delta: state.text };
    }
    yield { kind: 'done', response: modelResponseFromState(state, request.outputType) };
  } finally {
    request.signal?.removeEventListener('abort', abort);
  }
}

export class ClaudeHeadlessModel implements Model {
  constructor(private readonly modelId: string) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    let response: ModelResponse | null = null;
    for await (const event of runClaudeHeadless(request, this.modelId)) {
      if (event.kind === 'done') response = event.response;
    }
    if (!response) throw new Error('Claude Code headless finished without a response.');
    return response;
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    yield { type: 'response_started' } as StreamEvent;
    for await (const event of runClaudeHeadless(request, this.modelId)) {
      if (event.kind === 'delta') {
        yield { type: 'output_text_delta', delta: event.delta } as StreamEvent;
      } else {
        const usage = event.response.usage;
        yield {
          type: 'response_done',
          response: {
            id: event.response.responseId || `claude-headless-${randomUUID()}`,
            requestId: event.response.requestId,
            output: event.response.output,
            usage: {
              requests: usage.requests,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
            },
            providerData: event.response.providerData,
          },
        } as unknown as StreamEvent;
      }
    }
  }
}

const headlessModelCache = new Map<string, Model>();

export function getClaudeHeadlessModel(modelId: string): Model {
  const cached = headlessModelCache.get(modelId);
  if (cached) return cached;
  const model = new ClaudeHeadlessModel(modelId);
  headlessModelCache.set(modelId, model);
  return model;
}

export function resetClaudeHeadlessModelCache(): void {
  headlessModelCache.clear();
  spawnImpl = spawn;
}
