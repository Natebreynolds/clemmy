import { randomUUID } from 'node:crypto';
import pino from 'pino';
import type { ApprovalResolutionResult, PendingApproval, RunRequest, RunResult } from '../types.js';
import { AgentRuntimeCancelledError, ASSISTANT_PAUSED_PLACEHOLDER, type AgentRuntime, type AgentRuntimeCallbacks } from './provider.js';
import { ApprovalStore } from './approval-store.js';
import { addNotification, getNotification } from './notifications.js';
import { BASE_DIR, DEFAULT_CODEX_MODEL } from '../config.js';
import {
  assertCodexAccessTokenCanCoverCall,
  getStoredCodexOAuthTokens,
  refreshStoredNativeOAuth,
  isCodexAuthDead,
  getCodexAuthDead,
} from './auth-store.js';
import { recordToolEvent } from '../agents/tool-observability.js';
import { recordModelUsage } from './usage-log.js';
import type { ToolActivity } from '../types.js';
import { codexDispatcher, detectUndiciTimeout, buildTransportTimeoutError } from './codex-dispatcher.js';

const logger = pino({ name: 'clementine-next.codex-native-runtime' });

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_USER_AGENT = 'Codex/0.118.0';

interface CodexSseEvent {
  event?: string;
  data?: string;
}

export interface CodexFunctionCall {
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  phase?: unknown;
}

interface CodexResponseResult {
  text: string;
  toolCalls: CodexFunctionCall[];
  responseId?: string;
}

interface CodexInputMessage {
  [key: string]: unknown;
}

class CodexRuntimeError extends Error {
  /** P0-A — discriminant for the per-call wall-clock abort so the tool
   *  loop can recognize it without string-matching and auto-recover.
   *  Set after construction at the two wall-clock throw sites. */
  reason?: 'wall_clock';
  constructor(
    message: string,
    readonly status?: number,
    /** T2.4 — extra structured context. When set, the top-level
     *  handler can route to a BoundaryError(codex.http_4xx | http_5xx)
     *  with this data attached. Backwards-compatible: existing
     *  call sites that just construct with (message, status) still
     *  work; the new fields are optional. */
    readonly bodyText?: string,
    readonly elapsedMs?: number,
    readonly retriesAttempted?: number,
  ) {
    super(message);
    this.name = 'CodexRuntimeError';
  }
}

/**
 * P0-A — true when an error is a per-call wall-clock abort (the model
 * backend streamed past `maxWallClockMs` and was aborted mid-stream).
 * Checks the typed discriminant first and falls back to the message so
 * a wrapped/re-thrown abort is still recognized. Exported for tests and
 * for the tool loop's auto-recovery branch.
 */
export function isWallClockAbort(err: unknown): boolean {
  if (err instanceof CodexRuntimeError && err.reason === 'wall_clock') return true;
  return err instanceof Error && /exceeded the wall-clock budget/i.test(err.message);
}

/**
 * P0-A — deterministically shrink the input sent on a wall-clock retry.
 * A heavy synthesis turn that aborts is usually carrying large historical
 * tool outputs; trimming them makes the retried call lighter and faster
 * without an LLM summary (which could itself wall-clock). We only truncate
 * the `output` string of OLD `function_call_output` items — never remove
 * any item — so every function_call/output pairing the Codex API requires
 * stays intact. The original prompt (index 0) and the most recent
 * `keepRecent` items are preserved verbatim. Pure + exported for tests.
 */
export function trimNativeInputForRetry(
  input: CodexInputMessage[],
  opts?: { keepRecent?: number; perOutputCap?: number },
): CodexInputMessage[] {
  const keepRecent = opts?.keepRecent ?? 6;
  const perOutputCap = opts?.perOutputCap ?? 2000;
  if (input.length <= keepRecent + 1) return input;
  const recentCutoff = input.length - keepRecent;
  return input.map((item, i) => {
    if (i === 0 || i >= recentCutoff) return item;
    const rec = item as Record<string, unknown>;
    if (rec?.type === 'function_call_output' && typeof rec.output === 'string' && rec.output.length > perOutputCap) {
      const head = rec.output.slice(0, perOutputCap);
      return {
        ...item,
        output: `${head}\n…[${rec.output.length - perOutputCap} chars trimmed for wall-clock retry — call recall_tool_result for the full output]`,
      };
    }
    return item;
  });
}

/** P0-A — ephemeral directive appended to the retried turn only (never to
 *  the persisted history) telling the model to take a smaller, durable
 *  step instead of re-attempting the all-at-once synthesis that aborted. */
function wallClockRecoveryDirective(): CodexInputMessage {
  return {
    type: 'message',
    role: 'developer',
    content: [
      {
        type: 'input_text',
        text: [
          '[WALL-CLOCK RECOVERY] Your previous step ran too long and was aborted before it finished.',
          'Do NOT try to produce or synthesize the entire deliverable in one step.',
          'Take ONE concrete, smaller action now: either (a) write your intermediate findings / partial draft to a durable artifact (a file or working memory) so nothing is lost, or (b) complete just the next single sub-step.',
          'Checkpoint as you go. A short, concrete step that persists progress is required — a large all-at-once synthesis will fail again.',
        ].join('\n'),
      },
    ],
  } as unknown as CodexInputMessage;
}

/** P0-A — wall-clock auto-recovery kill-switch (default on). */
function wallClockRecoveryEnabled(): boolean {
  return process.env.CLEMENTINE_WALL_CLOCK_RECOVERY !== 'off';
}

/** P0-A — number of wall-clock retries allowed per runToolLoop invocation
 *  (default 1, clamped 0–2). 0 when recovery is disabled. */
function wallClockRetryBudget(): number {
  if (!wallClockRecoveryEnabled()) return 0;
  const raw = parseInt(process.env.CLEMENTINE_WALL_CLOCK_RETRY_BUDGET || '', 10);
  if (Number.isNaN(raw)) return 1;
  return Math.max(0, Math.min(2, raw));
}

/** P0-A — the wall-clock RETRY is gated to non-interactive channels. On an
 *  interactive surface the aborted turn's deltas were already forwarded to
 *  onChunk, so a fresh retried call would re-stream a duplicate/garbled partial
 *  to the user. Autonomous channels don't surface onChunk deltas as the
 *  deliverable, so the retry is invisible there — and that's exactly where the
 *  recovery is needed (the 2026-06-04 background email-audit incident).
 *  Interactive chat just re-sends if it stalls. */
const WALL_CLOCK_RETRY_CHANNELS = new Set(['background', 'workflow', 'execution', 'controller', 'cron', 'agent', 'autonomy']);
function wallClockRetryAllowed(channel?: string): boolean {
  return !!channel && WALL_CLOCK_RETRY_CHANNELS.has(channel);
}

// One actionable user-facing notification per calendar day when the
// Codex OAuth token has expired AND the auto-refresh attempt failed.
// Without this, the 401 throws unwind to a logger.error stack trace
// in the caller (cron, autonomy, controller) and the user never sees
// the "re-authenticate" prompt — observed 35 silent 401s in a row in
// production logs. Bucket id by date so we never spam.
export function notifyCodexAuthExpired(refreshError?: string): void {
  const id = `system-codex-auth-expired-${new Date().toISOString().slice(0, 10)}`;
  if (getNotification(id)) return;
  const detail = refreshError ? `Refresh attempt failed: ${refreshError}\n\n` : '';
  addNotification({
    id,
    kind: 'system',
    title: 'Codex authentication expired — re-authenticate to resume agent work',
    body: `${detail}Clementine's model backend rejected the stored OAuth token and the auto-refresh attempt failed. Open the Clementine desktop app and click "Re-authenticate Codex" in Settings, or run \`clementine auth login\` in a terminal. Background jobs, cron triggers, and chat will keep failing until this is resolved.`,
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { errorCategory: 'auth_expired', provider: 'codex' },
  });
}

async function throwIfCancelled(callbacks?: AgentRuntimeCallbacks): Promise<void> {
  if (await callbacks?.shouldCancel?.()) {
    throw new AgentRuntimeCancelledError();
  }
}

/**
 * Tool surface presented to the Codex Responses API.
 *
 * This compatibility runtime talks to the Codex Responses endpoint directly,
 * but it is model-only. The shared host harness owns every executable tool,
 * handoff, approval, lease, settlement, and evidence boundary.
 */
/** Exported so the zero-surface provider contract can be pinned directly. */
export async function createCodexToolDefinitions(
  _excludeToolNames?: string[],
): Promise<Array<{ type: 'function'; name: string }>> {
  // Model text only. All executable capabilities belong to the shared host
  // harness, irrespective of the historical per-call exclusion list.
  return [];
}

function parseSseChunk(buffer: string): { events: CodexSseEvent[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const events: CodexSseEvent[] = [];

  for (const rawPart of parts) {
    const lines = rawPart.split('\n');
    let eventName = '';
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (eventName || dataLines.length > 0) {
      events.push({
        event: eventName || undefined,
        data: dataLines.join('\n'),
      });
    }
  }

  return { events, rest };
}

function safeJsonParse(value?: string): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildInput(prompt: string): CodexInputMessage[] {
  return [
    {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: prompt,
        },
      ],
    },
  ];
}

/**
 * The Codex API enforces tool names match `^[a-zA-Z0-9_-]+$`. Models
 * occasionally hallucinate names with dots, colons, slashes, or
 * spaces — and the API rejects the *next* request (status 400) that
 * echoes the bad name back as part of conversation history. Slugify
 * any non-allowed characters to `_` and collapse runs of `_`. This is
 * the LAST-RESORT belt; the primary fix for the most common
 * hallucination (`multi_tool_use.parallel`) is the expander below.
 */
function sanitizeToolName(rawName: string): string {
  const safe = rawName.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (safe && safe !== rawName) {
    logger.warn({ rawName, safe }, 'sanitized hallucinated tool name for Codex API regex');
  }
  return safe || 'unknown_tool';
}

/**
 * GPT models periodically emit a SYNTHETIC tool call named
 * `multi_tool_use.parallel` (or just `parallel`) when they want to run
 * multiple tools in one turn. This isn't a real tool — it's the
 * model's internal representation leaking through. The arguments
 * object has the shape:
 *
 *   { "tool_uses": [
 *       { "recipient_name": "functions.<real_tool>", "parameters": {...} },
 *       { "recipient_name": "functions.<real_tool_2>", "parameters": {...} }
 *     ] }
 *
 * The canonical fix (per the OpenAI community + the
 * openai_multi_tool_use_parallel_patch reference impl) is to detect
 * the synthetic call and expand it into N real tool calls before any
 * dispatch happens. This preserves the model's *intent* (parallel
 * execution of real tools) without losing a round trip to the
 * "unknown tool" error path, and keeps the system prompt unchanged.
 *
 * Falls through to the sanitizer + normal failure path if the
 * arguments don't decode cleanly — we never want this expander to
 * THROW and kill the whole turn.
 */
export function expandParallelHallucination(toolCalls: CodexFunctionCall[]): CodexFunctionCall[] {
  const expanded: CodexFunctionCall[] = [];
  let synthetic = 0;
  for (const call of toolCalls) {
    const name = call.name;
    const isParallel = name === 'multi_tool_use.parallel' || name === 'parallel';
    if (!isParallel) {
      expanded.push(call);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.arguments ?? '{}');
    } catch {
      // Couldn't decode — fall back to sanitizer-only behavior (push
      // through; the next-turn 400 protection still catches it).
      expanded.push(call);
      continue;
    }
    const toolUses = (parsed as { tool_uses?: unknown }).tool_uses;
    if (!Array.isArray(toolUses) || toolUses.length === 0) {
      expanded.push(call);
      continue;
    }
    const baseId = call.id ?? call.call_id ?? randomUUID();
    let kept = 0;
    for (let i = 0; i < toolUses.length; i++) {
      const entry = toolUses[i];
      if (!entry || typeof entry !== 'object') continue;
      const recipient = (entry as { recipient_name?: unknown }).recipient_name;
      const parameters = (entry as { parameters?: unknown }).parameters;
      if (typeof recipient !== 'string' || !recipient) continue;
      // Models prefix the real tool name with `functions.` in the
      // synthetic envelope — strip it so the dispatcher sees the
      // actual registered tool name.
      const realName = recipient.replace(/^functions\./, '');
      expanded.push({
        id: `${baseId}_p${i}`,
        call_id: `${baseId}_p${i}`,
        name: realName,
        arguments: typeof parameters === 'string'
          ? parameters
          : JSON.stringify(parameters ?? {}),
      });
      kept += 1;
    }
    if (kept > 0) {
      synthetic += 1;
    } else {
      // Decoded but the structure didn't yield any real calls; let
      // the next-turn path handle it.
      expanded.push(call);
    }
  }
  if (synthetic > 0) {
    logger.info(
      { synthetic, expandedTo: expanded.length, originalCount: toolCalls.length },
      'expanded multi_tool_use.parallel hallucination into real tool calls',
    );
  }
  return expanded;
}

/** A genuine Codex-issued function_call item id begins with 'fc'. History
 *  replayed from another provider (GLM/Claude) or a harness-synthesized id (a
 *  timestamp/uuid, or a parallel-expansion `<base>_p<n>`) is NOT a valid Codex
 *  item id, and Codex /responses 400s on it ("Invalid input[n].id: Expected an
 *  ID that begins with 'fc'"). The `id` is OPTIONAL on input — call_id does the
 *  function_call↔output correlation — so we include it ONLY when it is real. */
export function isCodexFunctionCallItemId(id: string | undefined): boolean {
  return typeof id === 'string' && id.startsWith('fc') && !/_p\d+$/.test(id);
}

export function functionCallInput(toolCall: CodexFunctionCall): CodexInputMessage {
  const callId = toolCall.call_id ?? toolCall.id ?? randomUUID();
  const item: CodexInputMessage = {
    type: 'function_call',
    call_id: callId,
    name: sanitizeToolName(toolCall.name ?? 'unknown_tool'),
    arguments: toolCall.arguments ?? '{}',
    status: 'completed',
  };
  // Only forward a genuine Codex item id; a non-fc id (cross-provider history,
  // synthetic) makes Codex reject the whole request with a 400.
  if (isCodexFunctionCallItemId(toolCall.id)) {
    item.id = toolCall.id;
  }
  if (toolCall.phase !== undefined) {
    item.phase = toolCall.phase;
  }
  return item;
}

/**
 * Belt-and-suspenders: strip any non-fc id off function_call items across the
 * ENTIRE input right before it is sent. A non-fc function_call id — from
 * cross-provider history (a Claude/GLM turn replayed on Codex), a pre-fix
 * persisted approval inputHistory, or any path that bypassed functionCallInput —
 * makes Codex /responses 400 the WHOLE request ("Invalid input[n].id … Expected
 * an ID that begins with 'fc'"; live failure 2026-06-24, deep in a mixed-brain
 * thread). call_id does the function_call↔output correlation, so dropping the id
 * is safe. Catches the leak no matter how it got into the input.
 */
export function sanitizeCodexInputIds(input: CodexInputMessage[]): CodexInputMessage[] {
  return input.map((item) => {
    const it = item as { type?: string; id?: string };
    if (it.type === 'function_call' && it.id !== undefined && !isCodexFunctionCallItemId(it.id)) {
      const { id: _drop, ...rest } = item as Record<string, unknown>;
      return rest as CodexInputMessage;
    }
    if (it.type === 'function_call_output' && it.id !== undefined) {
      const { id: _drop, ...rest } = item as Record<string, unknown>;
      return rest as CodexInputMessage;
    }
    return item;
  });
}

function resolveCodexModel(model?: string): string {
  if (!model) return DEFAULT_CODEX_MODEL;
  if (model.startsWith('gpt-5')) return model;
  return DEFAULT_CODEX_MODEL;
}

function formatCodexApiError(status: number, bodyText: string): string {
  const parsed = safeJsonParse(bodyText);
  const errorObject = parsed?.error;
  if (errorObject && typeof errorObject === 'object') {
    const message = (errorObject as Record<string, unknown>).message;
    const resetsAt = (errorObject as Record<string, unknown>).resets_at;
    if (typeof message === 'string' && message) {
      if (typeof resetsAt === 'number') {
        return `${message}. Reset at ${new Date(resetsAt * 1000).toISOString()}.`;
      }
      return message;
    }
  }

  const detail = parsed?.detail;
  if (typeof detail === 'string' && detail) {
    return detail;
  }

  return `Clementine's model backend request failed (HTTP ${status}).`;
}

/**
 * Parse a Codex/Responses `usage` object into token counts. Handles BOTH the
 * Responses API shape (`input_tokens`/`output_tokens`, cached under
 * `input_tokens_details.cached_tokens`) and the chat-completions shape
 * (`prompt_tokens`/`completion_tokens`, cached under
 * `prompt_tokens_details.cached_tokens`).
 *
 * BUG FIX (2026-06-04): the previous inline reader used a FLAT lookup
 * `usage['input_tokens_details.cached_tokens']` for the nested paths, so cached
 * + reasoning tokens were ALWAYS read as 0 — making prompt-cache hit-rate and
 * reasoning cost invisible in the usage log (observed: 0% cache across 27M
 * input tokens, which was a measurement artifact, not necessarily reality).
 * Exported for tests.
 */
export function parseCodexUsage(usage: Record<string, unknown> | undefined): {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
} {
  const flat = (key: string): number | undefined => {
    const v = usage?.[key];
    return typeof v === 'number' ? v : undefined;
  };
  const nested = (path: string): number | undefined => {
    let cur: unknown = usage;
    for (const part of path.split('.')) {
      if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    return typeof cur === 'number' ? cur : undefined;
  };
  const inputTokens = flat('input_tokens') ?? flat('prompt_tokens') ?? 0;
  const outputTokens = flat('output_tokens') ?? flat('completion_tokens') ?? 0;
  const totalTokens = flat('total_tokens') ?? (inputTokens + outputTokens);
  const cachedInputTokens =
    flat('cached_tokens')
    ?? nested('input_tokens_details.cached_tokens')
    ?? nested('prompt_tokens_details.cached_tokens');
  const reasoningTokens =
    flat('reasoning_tokens')
    ?? nested('output_tokens_details.reasoning_tokens');
  return { inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens };
}

// classifyUsageKind moved to ./usage-log.ts (shared across all model lanes so
// segmented cache-hit-rate is comparable across Codex / Claude / BYO brains).

/**
 * Estimate the token share of an assembled Codex request by component, so the
 * efficiency readout can answer "where do my tokens go each turn?". Token est.
 * ≈ utf8 bytes / 4 (good enough for a relative breakdown; exact billing comes
 * from the wire usage). `instructions` lumps the rubric + harness context (they
 * arrive as one assembled string on this lane); `tools` is the tool schemas;
 * `history` is the input items. Pure, never throws.
 */
function estimatePromptComponents(body: Record<string, unknown>): Record<string, number> {
  try {
    const tok = (v: unknown): number => Math.round(Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v ?? '') || '', 'utf8') / 4);
    return {
      instructions: tok(body.instructions),
      tools: tok(body.tools),
      history: tok(body.input),
    };
  } catch {
    return {};
  }
}

async function performCodexRequest(
  request: RunRequest,
  input: CodexInputMessage[],
  callbacks?: AgentRuntimeCallbacks,
): Promise<CodexResponseResult> {
  const startedAt = Date.now();
  await throwIfCancelled(callbacks);
  const tokens = getStoredCodexOAuthTokens();
  if (!tokens?.accessToken) {
    throw new CodexRuntimeError('No ChatGPT/Codex sign-in is available. Open Settings → Models & routing → Re-authenticate (or run `clementine auth login-device`) to finish signing in.');
  }
  assertCodexAccessTokenCanCoverCall(tokens, request.maxWallClockMs);

  // `prompt_cache_key` lets Codex re-use a cached prefix across calls
  // in the same session. The Codex backend ignores `previous_response_id`
  // (it enforces `store: false`), so this is the only token-cost lever
  // we have for multi-turn chains. Hermes does the same thing.
  const body: Record<string, unknown> = {
    model: resolveCodexModel(request.model),
    instructions: request.instructions || 'You are Clementine, a persistent executive assistant. Be concise, accurate, and action-oriented.',
    store: false,
    stream: true,
    input: sanitizeCodexInputIds(input),
    tools: await createCodexToolDefinitions(request.excludeToolNames),
  };
  if (request.sessionId) {
    body.prompt_cache_key = request.sessionId;
  }

  // Two reasons to want an abort handle:
  //   1) caller-driven cancellation via shouldCancel polling
  //   2) wall-clock budget exceeded
  // If either applies we wire the AbortController. wallClockTimer is
  // separate from cancelPoll so each cleans up independently in the
  // finally block.
  const wantsAbort = Boolean(callbacks?.shouldCancel) || typeof request.maxWallClockMs === 'number';
  const abortController = wantsAbort ? new AbortController() : undefined;
  let cancelPoll: ReturnType<typeof setInterval> | undefined;
  let wallClockTimer: ReturnType<typeof setTimeout> | undefined;
  let wallClockTimedOut = false;
	  if (abortController && callbacks?.shouldCancel) {
	    cancelPoll = setInterval(() => {
	      void Promise.resolve(callbacks.shouldCancel?.())
	        .then((cancelled) => {
	          if (cancelled) abortController.abort();
	        })
        .catch(() => undefined);
    }, 2000);
  }
  if (abortController && typeof request.maxWallClockMs === 'number' && request.maxWallClockMs > 0) {
    wallClockTimer = setTimeout(() => {
      wallClockTimedOut = true;
      abortController.abort();
    }, request.maxWallClockMs);
    // unref so a stray timer doesn't keep Node alive past shutdown.
    wallClockTimer.unref?.();
  }

  let response: Response;
  try {
    response = await fetch(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': CODEX_USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: abortController?.signal,
      // Opt out of undici's keep-alive pool. After hours of daemon
      // uptime the pool fills with stale Cloudflare-edge IPs and
      // every reused connection times out at 10s. Fresh DNS + TCP
      // connect per call costs a few ms; the alternative is a
      // multi-hour outage of every chat run. Same fix as embeddings.
      keepalive: false,
      // v0.5.21 Phase 2 — scoped undici Agent with 15s headersTimeout
      // and 30s bodyTimeout. Catches Cloudflare-edge stalls that
      // wouldn't otherwise fire until undici's 5min defaults expired.
      dispatcher: codexDispatcher,
    } as RequestInit & { dispatcher?: unknown });
	  } catch (error) {
	    if (abortController?.signal.aborted) {
	      if (wallClockTimedOut) {
	        const wallClockErr = new CodexRuntimeError(
	          `Clementine's model backend exceeded the wall-clock budget of ${request.maxWallClockMs}ms and was aborted.`,
	        );
	        wallClockErr.reason = 'wall_clock';
	        throw wallClockErr;
	      }
	      throw new AgentRuntimeCancelledError();
	    }
	    // v0.5.21 Phase 2 — detect undici headers-timeout and throw a
	    // BoundaryError so loop.ts F4 routing turns it into Retry/Switch/Stop.
	    const undiciCode = detectUndiciTimeout(error);
	    if (undiciCode) {
	      throw buildTransportTimeoutError(undiciCode, {
	        sessionId: request.sessionId,
	        model: request.model,
	        phase: 'headers',
	      }, error);
	    }
	    throw error;
	  }

  if (!response.ok) {
    const errorText = await response.text();
    const elapsedMs = Date.now() - startedAt;
    // T2.4 — persist 4xx traces for the operator. The 2026-05-17
    // cluster of 15 silent fails on 16:49-17:19 had a Codex 400 burst
    // with no diagnostic surface — there was no record of what the
    // requests looked like. Now every 4xx writes a trace file the
    // Recent Errors panel + ops grep can use.
    if (response.status >= 400 && response.status < 500) {
      try {
        const { atomicJsonMutate } = await import('./atomic-json.js');
        const path = await import('node:path');
        const safeSessionId = (request.sessionId ?? 'no-session').replace(/[^a-zA-Z0-9_-]/g, '_');
        const tracePath = path.join(
          BASE_DIR,
          'state',
          'codex-4xx-trace',
          `${safeSessionId}-${Date.now()}.json`,
        );
        await atomicJsonMutate(
          tracePath,
          () => ({
            ts: new Date().toISOString(),
            sessionId: request.sessionId,
            status: response.status,
            model: request.model,
            elapsedMs,
            bodyExcerpt: errorText.slice(0, 4096),
            inputTokenEstimate: input.length,
          }),
          {} as Record<string, unknown>,
        );
      } catch (writeErr) {
        // Trace write is best-effort; never block the main error path.
        logger.warn(
          { err: writeErr instanceof Error ? writeErr.message : String(writeErr) },
          'codex-4xx-trace write failed (continuing)',
        );
      }
    }
    throw new CodexRuntimeError(
      formatCodexApiError(response.status, errorText),
      response.status,
      errorText.slice(0, 2048),
      elapsedMs,
    );
  }

  if (!response.body) {
    throw new CodexRuntimeError('Clementine\'s model backend returned an empty response.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalText = '';
  let responseId: string | undefined;
  const toolCalls: CodexFunctionCall[] = [];

	  try {
	    while (true) {
	      await throwIfCancelled(callbacks);
	      let done: boolean;
	      let value: Uint8Array | undefined;
	      try {
	        const read = await reader.read();
	        done = read.done;
	        value = read.value;
	      } catch (error) {
	        if (abortController?.signal.aborted) {
	          if (wallClockTimedOut) {
	            const wallClockErr = new CodexRuntimeError(
	              `Clementine's model backend exceeded the wall-clock budget of ${request.maxWallClockMs}ms and was aborted mid-stream.`,
	            );
	            wallClockErr.reason = 'wall_clock';
	            throw wallClockErr;
	          }
	          throw new AgentRuntimeCancelledError();
	        }
	        // v0.5.21 Phase 2 — undici body-timeout during SSE read.
	        const undiciCode = detectUndiciTimeout(error);
	        if (undiciCode) {
	          throw buildTransportTimeoutError(undiciCode, {
	            sessionId: request.sessionId,
	            model: request.model,
	            phase: 'body',
	          }, error);
	        }
	        throw error;
	      }
	      if (done) break;
	      buffer += decoder.decode(value, { stream: true });
	      const parsed = parseSseChunk(buffer);
	      buffer = parsed.rest;

	      for (const event of parsed.events) {
	        const payload = safeJsonParse(event.data);
	        if (!payload) continue;
	        const type = payload.type;
	        responseId = extractResponseId(payload) ?? responseId;

	        if (type === 'response.output_text.delta') {
	          const delta = payload.delta;
	          if (typeof delta === 'string' && delta) {
	            finalText += delta;
	            if (callbacks?.onChunk) {
	              await callbacks.onChunk(delta);
	            }
	          }
	          continue;
	        }

	        if (type === 'response.output_item.done') {
	          const item = payload.item;
	          if (item && typeof item === 'object') {
	            const typedItem = item as Record<string, unknown>;
	            if (typedItem.type === 'function_call') {
	              toolCalls.push({
	                id: typeof typedItem.id === 'string' ? typedItem.id : undefined,
	                call_id: typeof typedItem.call_id === 'string' ? typedItem.call_id : undefined,
	                name: typeof typedItem.name === 'string' ? typedItem.name : undefined,
		              arguments: typeof typedItem.arguments === 'string'
		                ? typedItem.arguments
		                : typedItem.arguments !== undefined
		                  ? JSON.stringify(typedItem.arguments)
		                  : undefined,
		              phase: typedItem.phase,
		            });
	            }
	          }
	          continue;
	        }

	        if (type === 'response.completed') {
	          if (callbacks?.onText && finalText.trim()) {
	            await callbacks.onText(finalText.trim());
	          }
	          // Capture token usage for the dashboard's Usage panel.
	          // The codex responses API reports usage on the completed
	          // event when available. We swallow any extraction errors —
	          // observability must never break the response path.
	          try {
	            const responseObj = (payload as { response?: Record<string, unknown> }).response;
	            const usage = responseObj && (responseObj.usage as Record<string, unknown> | undefined);
	            if (usage && typeof usage === 'object') {
	              const { inputTokens, outputTokens, totalTokens, cachedInputTokens, reasoningTokens } = parseCodexUsage(usage);
	              recordModelUsage({
	                sessionId: request.sessionId ?? 'unknown',
	                sourceUserSeq: request.sourceUserSeq,
	                channel: request.channel,
	                model: resolveCodexModel(request.model),
	                cacheDialect: 'inclusive', // OpenAI Responses wire: input_tokens ⊇ cached
	                inputTokens,
	                cachedInputTokens,
	                outputTokens,
	                reasoningTokens,
	                totalTokens,
	                durationMs: Date.now() - startedAt,
	                responseId,
	                promptComponents: estimatePromptComponents(body),
	              });
	            }
	          } catch { /* ignore */ }
	        }
	      }
	    }
	  } finally {
	    if (cancelPoll) clearInterval(cancelPoll);
	    if (wallClockTimer) clearTimeout(wallClockTimer);
	  }

  return {
    text: finalText.trim(),
    toolCalls: expandParallelHallucination(toolCalls),
    responseId,
  };
}

function extractResponseId(payload: Record<string, unknown>): string | undefined {
  const response = payload.response;
  if (response && typeof response === 'object') {
    const id = (response as Record<string, unknown>).id;
    if (typeof id === 'string') return id;
  }
  const responseId = payload.response_id;
  if (typeof responseId === 'string') return responseId;
  return undefined;
}

function parseToolArguments(toolCall: CodexFunctionCall): Record<string, unknown> {
  const parsed = safeJsonParse(toolCall.arguments);
  return parsed ?? {};
}

function toolActivityFor(toolCall: CodexFunctionCall): ToolActivity {
  return {
    toolName: toolCall.name ?? 'unknown_tool',
    input: parseToolArguments(toolCall),
  };
}

function isTransientCodexStatus(status?: number): boolean {
  return status === 408 || status === 409 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

// A usage/plan QUOTA is exhausted (often surfaced as a 429). Retrying the SAME provider is
// futile — it burns the retry budget and delays the brain fallover. Detect it so the retry
// loop skips straight to throwing (→ classifyModelError tags it rate_limited → fallover).
function isCodexUsageLimitError(error: unknown): boolean {
  if (!(error instanceof CodexRuntimeError)) return false;
  const text = `${error.message ?? ''} ${(error as { bodyText?: string }).bodyText ?? ''}`;
  return /usage[_ ]?limit|plan[_ ]?limit|usage_limit_reached|quota (?:exceeded|reached)/i.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CodexNativeRuntime implements AgentRuntime {
  private readonly approvals = new ApprovalStore();

  constructor() {
    // Preserve historical rows, but remove every opaque legacy approval from
    // the executable queue. Only the shared host registry can resume work.
    this.approvals.retirePending();
  }

  listPendingApprovals(): PendingApproval[] {
    return this.approvals.listPending();
  }

  private async performWithRefresh(
    request: RunRequest,
    input: CodexInputMessage[],
    callbacks?: AgentRuntimeCallbacks,
  ): Promise<CodexResponseResult> {
    let refreshed = false;
    let transientAttempts = 0;

    // DEAD latch: a prior terminal revoke means this request is doomed and a
    // refresh would just replay the dead token. Skip the round-trip, surface the
    // re-auth pointer (daily-bucketed), and throw a terminal error so the caller
    // parks instead of hammering. Cleared automatically when a re-auth lands.
    if (isCodexAuthDead()) {
      notifyCodexAuthExpired(getCodexAuthDead()?.reason);
      throw new CodexRuntimeError('Codex sign-in is revoked or expired — re-authenticate to resume.', 401);
    }

    while (true) {
      try {
        return await performCodexRequest(request, input, callbacks);
      } catch (error) {
        if (!refreshed && error instanceof CodexRuntimeError && error.status === 401) {
          const refreshResult = await refreshStoredNativeOAuth();
          if (refreshResult.ok) {
            refreshed = true;
            continue;
          }
          // Refresh failed. The previous behavior was to throw and let
          // the caller swallow the stack trace into a log line —
          // 35-in-a-row 401s went by without a user-visible signal.
          // Emit one daily-bucketed notification so the user has a
          // clear "re-authenticate" pointer the first time they
          // open the dashboard / check Discord.
          notifyCodexAuthExpired(refreshResult.message);
        }
        if (
          error instanceof CodexRuntimeError &&
          isTransientCodexStatus(error.status) &&
          !isCodexUsageLimitError(error) &&
          transientAttempts < 3
        ) {
          const delayMs = 750 * 2 ** transientAttempts;
          transientAttempts += 1;
          logger.warn({ status: error.status, attempt: transientAttempts, delayMs }, 'Retrying transient native Codex request failure');
          // T2.4 — surface a liveness chunk so the user sees the
          // retry happening instead of a 5+ second gap. Without
          // this, a 503 burst looked exactly like the chat hung.
          try {
            callbacks?.onChunk?.(
              `_(Backend hiccup — retrying in ${Math.round(delayMs / 1000)}s…)_`,
            );
          } catch { /* onChunk is best-effort */ }
          await sleep(delayMs);
          continue;
        }
        // T2.4 — final-failure paths: when retries are exhausted on a
        // 5xx (or a 4xx outside the auth-refresh window), fire ONE
        // rate-limited alert so a Codex incident shows up as a single
        // actionable user notification instead of N silent stack
        // traces per minute. The original exception still throws so
        // the caller's existing handling fires.
        if (error instanceof CodexRuntimeError && typeof error.status === 'number') {
          if (error.status === 429) {
            try {
              const { recordCodexUsageExhausted } = await import('./harness/rate-limit-store.js');
              recordCodexUsageExhausted();
            } catch { /* latch is best-effort */ }
          }
          try {
            const { rateLimitedAlert } = await import('./rate-limited-alert.js');
            const bucket =
              error.status >= 500 ? 'codex-5xx-cluster' :
              error.status === 429 ? 'codex-rate-limit' :
              `codex-${error.status}`;
            await rateLimitedAlert(bucket, {
              title: `Codex backend returned ${error.status}`,
              body:
                `Clementine's model backend failed with HTTP ${error.status} ` +
                `after ${transientAttempts} retr${transientAttempts === 1 ? 'y' : 'ies'}. ` +
                `${error.message.slice(0, 200)}. ` +
                (error.status >= 500
                  ? 'Likely a backend incident — check status.openai.com.'
                  : 'Likely a request/auth issue — see state/codex-4xx-trace/.'),
              kind: 'system',
              metadata: { status: error.status, retries: transientAttempts },
            });
          } catch { /* alert is best-effort */ }
        }
        throw error;
      }
    }
  }

  private async refuseToolCall(
    toolCall: CodexFunctionCall,
    callbacks?: AgentRuntimeCallbacks,
  ): Promise<string> {
    await throwIfCancelled(callbacks);
    if (callbacks?.onToolActivity) {
      await callbacks.onToolActivity(toolActivityFor(toolCall));
    }
    const name = toolCall.name || 'unknown_tool';
    return `Tool "${name}" was not started. The retired direct runtime is model-only; re-submit this work through Clementine's shared host tool lane.`;
  }

  private async runToolLoop(
    request: RunRequest,
    sessionId: string,
    input: CodexInputMessage[],
    callbacks?: AgentRuntimeCallbacks,
	  ): Promise<RunResult> {
	    let currentInput = [...input];
	    let latestResult: CodexResponseResult | null = null;
	    let toolCallsTotal = 0;

	    // Maximum back-and-forth turns of (model → tool calls → tool outputs
	    // → model). One turn = one model completion + the tool dispatches
	    // it asks for. Default 75 — matches Hermes' "assistant doing real
	    // work" tier (their default is 90; we trim slightly because our
	    // orchestrator has sub-agent handoffs that each get their own
	    // budget). The OpenAI Agents SDK default of 10 is unusably tight
	    // for any multi-tool task.
	    //
	    // Override via env: `CLEMENTINE_MAX_TOOL_TURNS=120 npm run daemon`.
	    const maxTurns = Math.max(
	      1,
	      parseInt(process.env.CLEMENTINE_MAX_TOOL_TURNS || '', 10) || 75,
	    );
	    let wallClockRetriesUsed = 0;
	    // Gated to non-interactive channels — see wallClockRetryAllowed. 0 on
	    // interactive surfaces so a retried turn can't re-stream a partial.
	    const maxWallClockRetries = wallClockRetryAllowed(request.channel) ? wallClockRetryBudget() : 0;
	    for (let turn = 0; turn < maxTurns; turn++) {
	      await throwIfCancelled(callbacks);
	      // P0-A wall-clock recovery (autonomous channels only): a single
	      // overloaded turn that streamed past the per-call wall-clock used to
	      // abort the whole run with no retry. Re-run the SAME turn once after
	      // trimming context + injecting a smaller-step directive. The retried
	      // call re-sends currentInput (which never carries mid-stream text), so
	      // the model CONTEXT never double-counts; channel-gating (above) prevents
	      // a user-visible re-stream of onChunk deltas. A retry does NOT consume a
	      // tool-turn.
	      let attemptInput = currentInput;
	      while (true) {
	        try {
	          latestResult = await this.performWithRefresh(
	            { ...request, sessionId },
	            attemptInput,
	            callbacks,
	          );
	          break;
	        } catch (err) {
	          if (isWallClockAbort(err) && wallClockRetriesUsed < maxWallClockRetries) {
	            wallClockRetriesUsed += 1;
	            recordToolEvent({
	              at: new Date().toISOString(),
	              sessionId,
	              toolName: '__runtime__',
	              kind: 'execute',
	              phase: 'error',
	              outcome: 'error',
	              errorMessage: `wall_clock_recovery: turn ${turn + 1} aborted at the per-call wall-clock; retry ${wallClockRetriesUsed}/${maxWallClockRetries} with trimmed context + smaller-step directive`,
	            });
	            try {
	              await callbacks?.onChunk?.('\n_(That step ran long — restarting it with a smaller plan…)_\n');
	            } catch { /* onChunk best-effort */ }
	            attemptInput = [...trimNativeInputForRetry(currentInput), wallClockRecoveryDirective()];
	            continue;
	          }
	          throw err;
	        }
	      }

      if (latestResult.toolCalls.length === 0) {
        const finalText = latestResult.text || ASSISTANT_PAUSED_PLACEHOLDER;
        if (callbacks?.onText) {
          await callbacks.onText(finalText);
        }
        return {
          text: finalText,
          sessionId,
          stoppedReason: latestResult.text ? 'success' : 'error',
          turnsUsed: turn + 1,
          raw: latestResult,
        };
      }

      // No tool was advertised, so a provider-emitted function call is stale or
      // malformed. Stop immediately: do not execute it, serialize it for later,
      // or spend another model turn trying to continue an ownerless call.
      toolCallsTotal += latestResult.toolCalls.length;
      const refusal = await this.refuseToolCall(latestResult.toolCalls[0]!, callbacks);
      if (callbacks?.onText) await callbacks.onText(refusal);
      return {
        text: refusal,
        sessionId,
        stoppedReason: 'blocked',
        turnsUsed: turn + 1,
        raw: latestResult,
      };
    }

    // Hit the tool-turn cap. Instead of returning a static "ran out of
    // cycles" string, do what Hermes does: run ONE grace turn with an
    // injected budget-exhausted notice that asks the model to summarize
    // what it accomplished and what's pending. The model produces a real
    // recap + an explicit "continue?" prompt instead of a dead-end error.
    //
    // The grace turn is forbidden from calling tools — we override the
    // tools list to empty so the model can only respond with text. This
    // is the Hermes `_budget_grace_call` pattern, simplified.
    recordToolEvent({
      at: new Date().toISOString(),
      sessionId,
      toolName: '__runtime__',
      kind: 'execute',
      phase: 'error',
      outcome: 'error',
      errorMessage: `stopped at max tool-call turns (${maxTurns}) — running grace turn`,
    });

    const graceText = await this.runGraceTurn(request, sessionId, currentInput, maxTurns, toolCallsTotal, callbacks)
      .catch((err) => {
        logger.warn({ err }, 'grace turn failed; falling back to static message');
        return null;
      });

    const finalText = graceText
      || `Clementine reached her tool-call budget (${maxTurns} turns, ${toolCallsTotal} tools fired) before finishing. The work so far is in your vault. Reply "continue" to pick up where she left off.`;

    if (callbacks?.onText) {
      await callbacks.onText(finalText);
    }

    return {
      text: finalText,
      sessionId,
      stoppedReason: 'max-turns-with-grace',
      turnsUsed: maxTurns,
      raw: latestResult,
    };
  }

  /**
   * Run ONE final model call after the tool-turn cap has been hit.
   * No tools available — the model can only produce text. Inject a
   * notice telling it the budget is exhausted and ask it to:
   *
   *   1. Summarize what it accomplished
   *   2. Name what's still pending
   *   3. End with an explicit "continue?" prompt
   *
   * Streams chunks to the caller via `onChunk` exactly like a normal
   * turn so the user sees the summary appear in real time instead of
   * waiting for the whole grace turn.
   */
  private async runGraceTurn(
    request: RunRequest,
    sessionId: string,
    input: CodexInputMessage[],
    maxTurns: number,
    toolCallsFired: number,
    callbacks?: AgentRuntimeCallbacks,
  ): Promise<string | null> {
    const graceNotice: CodexInputMessage = {
      type: 'message',
      role: 'developer',
      content: [
        {
          type: 'input_text',
          text: [
            `You have reached your tool-call budget for this turn (${maxTurns} model→tool cycles, ${toolCallsFired} total tools fired).`,
            `STOP calling tools. Do NOT request more tools.`,
            `Write a short response that:`,
            `  1. Summarizes what you accomplished in this run (be specific — name the tools/files/queries that succeeded).`,
            `  2. Lists what's still pending or unfinished.`,
            `  3. Ends with: "Want me to continue?" so the user has a clear path to resume.`,
            `If you produced any artifacts (files, notes, plans, drafts), reference them by path/title so the user can find them.`,
          ].join('\n'),
        },
      ],
    } as unknown as CodexInputMessage;

    // The grace turn replaces the tool surface with an empty list so
    // the model has no choice but to write text. We construct the
    // body manually instead of calling performCodexRequest so we can
    // override `tools` cleanly.
    const tokens = getStoredCodexOAuthTokens();
    if (!tokens?.accessToken) return null;

    const graceInput = [...input, graceNotice];
    const body: Record<string, unknown> = {
      model: resolveCodexModel(request.model),
      instructions: request.instructions
        || 'You are Clementine, a persistent executive assistant. Be concise, accurate, and action-oriented.',
      store: false,
      stream: true,
      input: sanitizeCodexInputIds(graceInput),
      tools: [], // critical — no tools available on the grace turn
    };
    if (sessionId) body.prompt_cache_key = sessionId;

    let response: Response;
    try {
      response = await fetch(CODEX_RESPONSES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': CODEX_USER_AGENT,
        },
        body: JSON.stringify(body),
        // See note above on the main fetch site — avoid the long-
        // uptime keep-alive pool poisoning that breaks chat.
        keepalive: false,
        // v0.5.21 Phase 2 — share the scoped Codex dispatcher so the
        // grace turn also fast-fails on Cloudflare-edge stalls. The
        // catch below already returns null on any failure; tighter
        // timeouts just mean the failure is detected sooner.
        dispatcher: codexDispatcher,
      } as RequestInit & { dispatcher?: unknown });
    } catch (err) {
      logger.warn({ err }, 'grace turn fetch failed');
      return null;
    }

    if (!response.ok || !response.body) {
      logger.warn({ status: response.status }, 'grace turn returned non-OK');
      return null;
    }

    // Reuse the same SSE parser the main loop uses. We don't need to
    // track tool calls (the model has none); we just collect text.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulated = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseChunk(buffer);
      buffer = rest;
      for (const evt of events) {
        if (!evt.data) continue;
        const payload = safeJsonParse(evt.data) as
          | { type?: string; delta?: string; response?: { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> } }
          | null;
        if (!payload) continue;
        if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
          accumulated += payload.delta;
          if (callbacks?.onChunk) {
            await callbacks.onChunk(payload.delta);
          }
        } else if (payload.type === 'response.completed' && payload.response?.output) {
          // Defensive: if streaming deltas were missed for any reason,
          // reconstruct the final text from the completed output.
          if (!accumulated) {
            for (const item of payload.response.output) {
              if (item.type === 'message' && Array.isArray(item.content)) {
                for (const part of item.content) {
                  if (part.type === 'output_text' && typeof part.text === 'string') {
                    accumulated += part.text;
                  }
                }
              }
            }
          }
        }
      }
    }

    return accumulated.trim() || null;
  }

  async resolveApproval(approvalId: string, approved: boolean): Promise<ApprovalResolutionResult> {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      throw new Error(`Approval ${approvalId} not found.`);
    }

    if (approval.status === 'pending') {
      this.approvals.updateStatus(approvalId, 'rejected');
    }
    const outcome: ApprovalResolutionResult = {
      approvalId,
      status: 'rejected',
      sessionId: approval.sessionId,
      text: approved
        ? `Legacy approval ${approvalId} was retired and was not executed. Re-submit the action through Clementine's shared harness so it can receive current authority.`
        : `Approval ${approvalId} rejected. Its legacy runtime state was not executed.`,
    };

    addNotification({
      id: `${Date.now()}-approval-${approvalId}-${outcome.status}`,
      kind: 'approval',
      title: `Approval ${outcome.status}: ${approval.toolName}`,
      body: outcome.text,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: {
        approvalId,
        sessionId: approval.sessionId,
        toolName: approval.toolName,
        userId: approval.userId,
        channel: approval.channel,
        discordUserId: approval.channel?.startsWith('discord:') ? approval.userId : undefined,
      },
    });

    return outcome;
  }

  async run(request: RunRequest, callbacks?: AgentRuntimeCallbacks): Promise<RunResult> {
    const sessionId = request.sessionId ?? randomUUID();

    try {
      return await this.runToolLoop(request, sessionId, buildInput(request.prompt), callbacks);
    } catch (error) {
      logger.error({ err: error, sessionId }, 'Native Codex run failed');
      throw error;
    }
  }
}
