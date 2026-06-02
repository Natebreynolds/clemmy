import { createHash } from 'node:crypto';
import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import type { RuntimeContextValue } from '../types.js';
import { needsApprovalFromTaxonomy } from '../agents/tool-taxonomy.js';
import {
  executeComposioTool,
  getComposioCredentialStatus,
  getComposioRuntimeStatus,
  listComposioToolkitTools,
  listConnectedToolkits,
} from '../integrations/composio/client.js';
import { formatRecallableToolText } from '../runtime/harness/tool-output-format.js';
import { callIdFromToolDetails, sessionIdFromRunContext } from '../runtime/harness/tool-output-context.js';
import { rememberToolChoice, peekToolChoice, stripBakedConnectionId } from '../memory/tool-choice-store.js';

const DYNAMIC_TOOL_PREFIX = 'cx_';
const MAX_TOOL_NAME_LENGTH = 64;
// First-class preload — kept small so the agent's tool surface stays
// tight at startup. The model finds anything beyond this set via the
// composio_search_tools → composio_execute_tool flow.
const DEFAULT_DYNAMIC_TOOLKIT_LIMIT = 25;
const DEFAULT_DYNAMIC_TOTAL_LIMIT = 120;
// Search-time limits — used ONLY when the model explicitly calls
// composio_search_tools. Looking across a larger window is fine because
// these tools never enter the persistent surface; results are returned
// once and discarded. Bumped so list/read/search actions that sit past
// the alphabetical first page (e.g. outlook_list_messages) are findable.
const DEFAULT_SEARCH_TOOLKIT_LIMIT = 250;
const DEFAULT_SEARCH_TOTAL_LIMIT = 25;

// Composio slug → ToolKind classification lives in agents/tool-taxonomy.ts
// (classifyComposioSlug). The previous ad-hoc READ_ONLY_PREFIXES /
// MUTATING_WORDS heuristic was deleted along with composioToolNeedsApproval.

export interface FormatComposioToolOutputOptions {
  context?: unknown;
  details?: unknown;
  toolName?: string;
  maxChars?: number;
  /** The Composio action slug, when this output is a real tool execution.
   *  Used to make a failure corrective specific (`slug=…`). */
  toolSlug?: string;
}

/**
 * Detect whether a Composio EXECUTION result is actually a failure.
 *
 * Composio returns API errors as a normal result payload (it does NOT throw):
 *   { successful: false, error: "…", data: { http_error: "400 …",
 *     status_code: 400, message: "…" } }
 * The model, seeing bland JSON, reads this as a retryable "result" and calls
 * the SAME slug with the SAME args again — the composio-thrash that grinds into
 * the loop guard. We classify strictly off Composio's own error markers so
 * synthesized outputs (status/search/list) never false-positive.
 */
/** A failure whose cause is "the thing you referenced doesn't exist" — a wrong
 *  table/object/record/field id, not a permissions or connection problem. The
 *  cure is to DISCOVER the valid ids (list/schema), not to guess another name.
 *  Note: Airtable fuses both into INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND, so we
 *  treat that as not-found-capable and tell the model to list options first. */
const COMPOSIO_NOT_FOUND_RE =
  /INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND|model[_\s-]?not[_\s-]?found|not[_\s-]?found|no such (?:table|object|record|model|view|base|field|column)|unknown (?:table|object|record|field|column)|does\s*n.?t exist|could not be found|NOT_FOUND/i;

export function detectComposioFailure(value: unknown): { failed: boolean; summary: string; notFound: boolean } {
  const none = { failed: false, summary: '', notFound: false } as const;
  if (!isRecord(value)) return { ...none };
  const data = isRecord(value.data) ? value.data : undefined;
  // Authoritative markers: `successful === false` and `http_error` are
  // composio's own failure envelope. `status_code >= 400` and a bare top-level
  // `error` string are best-effort SECONDARY signals — the bare-error branch is
  // AND-gated on `successful !== true` so a successful action that carries a
  // non-empty advisory `error` string isn't mislabelled.
  const httpError = data && typeof data.http_error === 'string' ? data.http_error.trim() : '';
  const statusCode = data && typeof data.status_code === 'number' ? data.status_code : undefined;
  const topError = typeof value.error === 'string' ? value.error.trim() : '';
  const explicitSuccess = value.successful === true;
  const failed =
    value.successful === false ||
    httpError.length > 0 ||
    (statusCode !== undefined && statusCode >= 400) ||
    (topError.length > 0 && !explicitSuccess);
  if (!failed) return { ...none };
  const dataMessage = data && typeof data.message === 'string' ? data.message : '';
  const summary = (httpError || topError || dataMessage || `status ${statusCode ?? 'error'}`)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  // Test not-found against ALL the error fields, not just the one that won the
  // summary — Airtable puts http_error="403" but the not-found phrase in message.
  const notFound = COMPOSIO_NOT_FOUND_RE.test(`${httpError} ${topError} ${dataMessage}`);
  return { failed: true, summary, notFound };
}

/** Loud, self-correcting header prepended to a failed Composio execution so
 *  the model adapts on failure #1 instead of retrying identically. Names the
 *  tool the model actually called (`composio_execute_tool` or the dynamic
 *  `cx_<slug>`) and the slug, so the corrective is unambiguous on both paths. */
function composioFailureCorrective(
  summary: string,
  opts: { toolName?: string; toolSlug?: string; notFound?: boolean } = {},
): string {
  const label = opts.toolName || 'composio_execute_tool';
  const where = opts.toolSlug ? ` (slug=${opts.toolSlug})` : '';
  if (opts.notFound) {
    // The referenced resource (table/object/record/field id) doesn't exist or
    // wasn't matched — DISCOVER the valid ids, don't guess another name. This
    // is general: list/schema action exists for every toolkit.
    return [
      `⚠️ ${label} NOT FOUND${where}: ${summary}`,
      `This is almost certainly a WRONG identifier (table/object/record/field), NOT a permissions or connection problem — the connection works, the id you used doesn't exist.`,
      `Do this, in order: (1) DISCOVER the real options first — call the toolkit's schema/list action (e.g. AIRTABLE_GET_BASE_SCHEMA for a base's tables, GOOGLESHEETS list, SALESFORCE describe, or composio_search_tools) and read the EXACT ids it returns; (2) retry with one of those exact ids. Do NOT guess another table/field name — guessing returns the same not-found error.`,
    ].join('\n');
  }
  return [
    `⚠️ ${label} FAILED${where}: ${summary}`,
    `This is a HARD failure — calling it again with the SAME arguments will return the SAME error.`,
    `Do ONE of these instead: (1) fix the arguments — re-check the action's exact required field names/shape (a 4xx almost always means a wrong, missing, or misnamed field); (2) use a different action or tool for this (e.g. composio_search_tools to find the right slug); (3) if you can't resolve it, STOP and tell the user the specific blocker. Do NOT repeat this identical call.`,
  ].join('\n');
}

/**
 * Format a Composio result as prompt-safe JSON while preserving the
 * full payload for recall when the harness gives us a session + call id.
 *
 * The model-facing copy stays capped so long runs do not accumulate
 * megabytes of app data in Codex request bodies. The full JSON is
 * written before clipping, so `recall_tool_result("call_xxx")` can
 * recover details without re-running a side-effecting upstream tool.
 */
export function formatComposioToolOutput(
  value: unknown,
  options: FormatComposioToolOutputOptions = {},
): string {
  const text = JSON.stringify(value, null, 2);
  return formatRecallableToolText(text, {
    maxChars: options.maxChars,
    toolName: options.toolName ?? 'composio tool',
    sessionId: sessionIdFromRunContext(options.context),
    callId: callIdFromToolDetails(options.details),
  });
}

/**
 * Format the output of a real Composio tool EXECUTION. Identical to
 * formatComposioToolOutput on success; on a Composio-reported failure it
 * prepends a loud, actionable corrective (kept ABOVE the recall-clipped body
 * so it's never truncated) so the model fixes/abandons the call instead of
 * retrying identical args into the loop guard. Use this only for paths that
 * run executeComposioTool — NOT for synthesized status/search/list outputs.
 */
export function formatComposioExecuteOutput(
  value: unknown,
  options: FormatComposioToolOutputOptions = {},
): string {
  const body = formatComposioToolOutput(value, options);
  const { failed, summary, notFound } = detectComposioFailure(value);
  if (!failed) return body; // success: the GLOBAL id-index (formatRecallableToolText) handles resource lists
  return composioFailureCorrective(summary, { toolName: options.toolName, toolSlug: options.toolSlug, notFound }) + '\n\n' + body;
}

/**
 * The OTHER composio failure channel: executeComposioTool also THROWS — for a
 * not-found slug, an auth/connection error, or any non-2xx the SDK surfaces as
 * an APIError. Left to propagate, the SDK renders these as "An error occurred …
 * Please try again", which invites the exact identical-retry thrash. Catch the
 * throw at the execute wrapper and route it through the same loud corrective so
 * BOTH channels (returned error envelope + thrown error) make the model adapt.
 */
export function composioThrownErrorOutput(
  err: unknown,
  options: FormatComposioToolOutputOptions = {},
): string {
  const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  const summary = message.slice(0, 240) || 'unknown error';
  const notFound = COMPOSIO_NOT_FOUND_RE.test(message);
  const body = formatComposioToolOutput({ error: message, toolSlug: options.toolSlug ?? null }, options);
  return composioFailureCorrective(summary, { toolName: options.toolName, toolSlug: options.toolSlug, notFound }) + '\n\n' + body;
}

/** Run a Composio execution and format BOTH outcomes through the corrective
 *  path: returned error envelopes and thrown errors. */
// ─── Ever-learning: tool choices memorize THEMSELVES (north-star contract) ──
//
// The recall half of procedural memory is already always-on (proven choices
// are injected into context every turn). The COMMIT half was missing: nothing
// persisted a working (intent → slug) automatically, so the model had to
// manually `tool_choice_remember` (which it rarely did) and discovery re-ran
// every turn — the exact token leak the north star calls a "reliability bug".
//
// Close the loop in code: when `composio_search_tools(query)` is the thing that
// surfaced a slug and the subsequent `composio_execute_tool(slug)` SUCCEEDS,
// auto-persist `intent=query → slug`. Keyed by the SEARCH QUERY because that is
// the same string the model recalls by next time. This naturally fires only on
// FIRST discovery of an intent: once remembered, the choice is injected, the
// model stops re-searching it, and the hint goes quiet.
const AUTO_REMEMBER_WINDOW_MS = 5 * 60 * 1000;
const lastComposioSearchBySession = new Map<string, { query: string; at: number }>();

/** Record the discovery query so a following successful execute can learn from it.
 *  Exported for tests. */
export function noteComposioSearchIntent(sessionId: string | undefined, query: string): void {
  if (!sessionId || !query.trim()) return;
  // Bound the map — tiny entries, but don't leak across a long-lived daemon.
  if (lastComposioSearchBySession.size > 500) {
    const cutoff = Date.now() - AUTO_REMEMBER_WINDOW_MS;
    for (const [k, v] of lastComposioSearchBySession) {
      if (v.at < cutoff) lastComposioSearchBySession.delete(k);
    }
  }
  lastComposioSearchBySession.set(sessionId, { query: query.trim(), at: Date.now() });
}

/** On a SUCCESSFUL execute that followed a fresh discovery, memorize the choice.
 *  Exported for tests. */
export function maybeAutoRememberComposioChoice(
  toolSlug: string,
  args: Record<string, unknown>,
  result: unknown,
  sessionId: string | undefined,
): void {
  try {
    if (detectComposioFailure(result).failed) return; // only learn from successes
    const sid = sessionId;
    if (!sid) return;
    const pending = lastComposioSearchBySession.get(sid);
    if (!pending) return; // slug wasn't just discovered — nothing new to learn
    // Single-use + freshness: a search only teaches the execute that closely
    // follows it, so a much-later unrelated execute can't be mis-keyed.
    lastComposioSearchBySession.delete(sid);
    if (Date.now() - pending.at > AUTO_REMEMBER_WINDOW_MS) return;
    const intent = pending.query.trim();
    if (!intent) return;
    // Additive only (north star: "propose before update"). Never silently
    // overwrite an ACTIVE choice — a curated or already-proven one. We fill an
    // empty intent (first discovery) or a just-invalidated one (choice===null,
    // post-failure re-learn). A genuinely BETTER option for an already-active
    // intent is the model's call: it proposes the swap and only the user's
    // approval triggers a manual tool_choice_remember. Non-emitting peek so
    // this existence check doesn't skew recall-hit-rate telemetry.
    const existingChoice = peekToolChoice(intent);
    if (existingChoice?.choice) return;
    // Compact, connection-free args example as the invocation hint. NEVER bake a
    // connected_account_id into the memo (stale-connection class bug, v0.5.47).
    let template: string | undefined;
    try {
      const compact = JSON.stringify(args ?? {});
      template = compact && compact.length <= 600 ? stripBakedConnectionId(compact) : undefined;
    } catch {
      template = undefined;
    }
    rememberToolChoice({
      intent,
      description: 'Auto-remembered: this Composio slug satisfied the searched intent.',
      choice: {
        kind: 'composio',
        identifier: toolSlug,
        invocationTemplate: template,
        testEvidence: 'auto-remembered after a successful composio_execute_tool call',
      },
    });
  } catch {
    // North star: learning is ADDITIVE — a memory-write failure must never
    // break the tool call. Silent here is correct (the call already succeeded).
  }
}

// ─── Fan-out nudge: catch serial same-shape work and suggest run_worker ─────
//
// Observed live (sess-mpvujlni 2026-06-01): the agent researched 10 prospects
// SERIALLY in one context (run_worker=0) instead of fanning out — slower, and
// it piles every item's raw tool output into one context, which then forces the
// harness to clip the freshly-fetched data mid-run. The orchestrator already
// instructs fan-out, but a buried rule got ignored. So nudge at the MOMENT it's
// happening: when the same slug has been executed for N distinct items in one
// session, append a ONE-TIME advisory to the tool result. Soft + informs (never
// blocks); fires once per session.
const FANOUT_ADVICE_THRESHOLD = 3;
const fanoutTrackerBySession = new Map<string, { distinctBySlug: Map<string, Set<string>>; advised: boolean }>();

export function maybeFanoutAdvisory(toolSlug: string, args: Record<string, unknown>, sessionId: string | undefined): string | null {
  try {
    if (!sessionId || !toolSlug) return null;
    let t = fanoutTrackerBySession.get(sessionId);
    if (!t) {
      if (fanoutTrackerBySession.size > 500) fanoutTrackerBySession.clear(); // crude bound for a long-lived daemon
      t = { distinctBySlug: new Map(), advised: false };
      fanoutTrackerBySession.set(sessionId, t);
    }
    if (t.advised) return null;
    let set = t.distinctBySlug.get(toolSlug);
    if (!set) { set = new Set(); t.distinctBySlug.set(toolSlug, set); }
    let argHash = '';
    try { argHash = JSON.stringify(args ?? {}); } catch { argHash = String(Math.random()); }
    set.add(argHash);
    if (set.size < FANOUT_ADVICE_THRESHOLD) return null;
    t.advised = true;
    return (
      `\n\n↗ Fan-out tip: you've now called ${toolSlug} for ${set.size} different items in series. `
      + `For 3+ independent same-shape items, call run_worker once per item (in parallel waves of up to 8) `
      + `instead of looping here — it runs them concurrently AND keeps this context lean so the harness `
      + `doesn't clip your freshly-fetched data mid-run. Fan out the remaining items.`
    );
  } catch {
    return null; // a nudge must never break the tool call
  }
}

async function runComposioExecute(
  toolSlug: string,
  args: Record<string, unknown>,
  connectedAccountId: string | undefined,
  options: FormatComposioToolOutputOptions,
): Promise<string> {
  try {
    const result = await executeComposioTool(toolSlug, args, connectedAccountId);
    const output = formatComposioExecuteOutput(result, { ...options, toolSlug });
    const sid = sessionIdFromRunContext(options.context);
    maybeAutoRememberComposioChoice(toolSlug, args, result, sid);
    // Only count/advise on SUCCESS — a failed call isn't "an item processed".
    if (!detectComposioFailure(result).failed) {
      const advisory = maybeFanoutAdvisory(toolSlug, args, sid);
      if (advisory) return output + advisory;
    }
    return output;
  } catch (err) {
    return composioThrownErrorOutput(err, { ...options, toolSlug });
  }
}

function parseArgumentsJson(value: string | null | undefined): Record<string, unknown> {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Composio tool arguments must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid Composio arguments JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hashSuffix(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8);
}

function sanitizeToolName(toolSlug: string): string {
  const cleaned = toolSlug
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_') || 'tool';
  const prefixed = `${DYNAMIC_TOOL_PREFIX}${cleaned}`;
  if (prefixed.length <= MAX_TOOL_NAME_LENGTH) return prefixed;
  const suffix = hashSuffix(toolSlug);
  return `${prefixed.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length - 1)}_${suffix}`;
}

function normalizeJsonSchemaObject(schema: unknown): Record<string, unknown> {
  if (isRecord(schema) && (schema.type === 'object' || isRecord(schema.properties))) {
    return {
      type: 'object',
      ...schema,
      additionalProperties: schema.additionalProperties ?? true,
    };
  }
  return {
    type: 'object',
    description: 'Arguments for the connected app action. Use the exact fields requested by the action.',
    additionalProperties: true,
  };
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return {};
  return input;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

function scoreComposioTool(toolkitSlug: string, toolSlug: string, name: string, description: string | undefined, queryTerms: string[]): number {
  const haystack = `${toolkitSlug} ${toolSlug} ${name} ${description ?? ''}`.toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    if (toolSlug.toLowerCase().includes(term)) score += 5;
    if (name.toLowerCase().includes(term)) score += 4;
    if (description?.toLowerCase().includes(term)) score += 2;
    if (toolkitSlug.toLowerCase().includes(term)) score += 1;
    if (!haystack.includes(term)) score -= 1;
  }
  return score;
}

function describeDynamicTool(toolkitSlug: string, toolSlug: string, description?: string): string {
  // Lead with Composio's own description if it exists — that's the
  // model's primary signal of "what this does". Our scaffolding goes
  // at the end so it doesn't push the operational text below the
  // model's attention budget. Origin tag `[toolkit]` stays first so
  // the model can disambiguate same-named actions across toolkits.
  const real = description?.trim();
  const tag = `[${toolkitSlug}]`;
  if (real) return `${tag} ${real} (Composio action: ${toolSlug})`;
  return `${tag} Composio action ${toolSlug}. Call this directly when the fields are clear; use composio_list_tools first if you need to inspect the schema.`;
}

export async function getDynamicComposioRuntimeTools(options: {
  perToolkitLimit?: number;
  totalLimit?: number;
} = {}): Promise<Tool<RuntimeContextValue>[]> {
  const credentials = getComposioCredentialStatus();
  if (!credentials.enabled) return [];

  const perToolkitLimit = Math.max(1, Math.min(options.perToolkitLimit ?? DEFAULT_DYNAMIC_TOOLKIT_LIMIT, 100));
  const totalLimit = Math.max(1, Math.min(options.totalLimit ?? DEFAULT_DYNAMIC_TOTAL_LIMIT, 300));
  // Load cx_* tools for ALL connected toolkits, not just status=ACTIVE.
  // Composio's status flag is unreliable (lags, false EXPIRED) and we
  // were silently hiding working tools from the agent's surface. If
  // a connection is truly dead, the execute call will surface a real
  // error — the user gets actionable feedback instead of "tool not
  // available".
  const connections = await listConnectedToolkits();
  if (connections.length === 0) return [];

  const connectionsByToolkit = new Map<string, typeof connections>();
  for (const connection of connections) {
    const current = connectionsByToolkit.get(connection.slug) ?? [];
    current.push(connection);
    connectionsByToolkit.set(connection.slug, current);
  }

  const out: Tool<RuntimeContextValue>[] = [];
  const seenNames = new Set<string>();

  for (const [toolkitSlug, toolkitConnections] of connectionsByToolkit) {
    if (out.length >= totalLimit) break;

    let toolkitTools;
    try {
      toolkitTools = await listComposioToolkitTools(toolkitSlug, perToolkitLimit);
    } catch {
      continue;
    }

    const defaultConnectionId = toolkitConnections.length === 1 ? toolkitConnections[0]?.connectionId : undefined;
    for (const toolkitTool of toolkitTools) {
      if (out.length >= totalLimit) break;
      const name = sanitizeToolName(toolkitTool.slug);
      if (seenNames.has(name)) continue;
      seenNames.add(name);

      const toolSlug = toolkitTool.slug;
      out.push(tool({
        name,
        description: describeDynamicTool(toolkitSlug, toolSlug, toolkitTool.description),
        parameters: normalizeJsonSchemaObject(toolkitTool.inputParameters) as any,
        strict: false,
        // Unified taxonomy: cx_<slug> classifies via the Composio slug
        // (read for GET/LIST/etc., send for everything else), then
        // consults the scope policy (yolo → auto, strict → ask, etc.).
        needsApproval: needsApprovalFromTaxonomy(name),
        execute: async (input, context, details) => runComposioExecute(
          toolSlug,
          normalizeToolInput(input),
          defaultConnectionId,
          { context, details, toolName: name },
        ),
      }));
    }
  }

  return out;
}

export function getComposioRuntimeTools(): Tool<RuntimeContextValue>[] {
  const composio_status = tool({
    name: 'composio_status',
    description: 'Inspect whether Composio is configured and list active third-party app connections available to Clementine.',
    parameters: z.object({}),
    execute: async (_input, context, details) => {
      const credentials = await getComposioRuntimeStatus();
      const connections = credentials.enabled ? await listConnectedToolkits() : [];
      return formatComposioToolOutput({
        ...credentials,
        connections: connections.map((connection) => ({
          toolkit: connection.slug,
          connectionId: connection.connectionId,
          status: connection.status,
          account: connection.accountLabel ?? connection.alias ?? null,
        })),
      }, { context, details, toolName: 'composio_status' });
    },
  });

  const composio_list_tools = tool({
    name: 'composio_list_tools',
    description: 'List available Composio tools for one connected toolkit slug, such as gmail, slack, notion, github, or googlecalendar.',
    parameters: z.object({
      toolkit_slug: z.string().min(1),
      limit: z.number().int().positive().max(200).nullable(),
    }),
    execute: async ({ toolkit_slug, limit }, context, details) => {
      const tools = await listComposioToolkitTools(toolkit_slug, limit ?? 80);
      return formatComposioToolOutput({
        toolkit: toolkit_slug,
        count: tools.length,
        tools: tools.map((item) => ({
          slug: item.slug,
          name: item.name,
          description: item.description,
          inputParameters: item.inputParameters,
        })),
      }, { context, details, toolName: 'composio_list_tools' });
    },
  });

  const composio_search_tools = tool({
    name: 'composio_search_tools',
    description: 'Search Composio for the right action slug. Use this BEFORE concluding an action is unavailable — Composio exposes hundreds of actions per toolkit and Clementine intentionally does not inject every action schema into every call. Query with plain English ("outlook list unread messages today", "drive search by name", "gmail mark as read"). Returns slugs to pass to `composio_execute_tool`.',
    parameters: z.object({
      query: z.string().min(1),
      toolkit_slug: z.string().min(1).nullable(),
      limit: z.number().int().positive().max(50).nullable(),
    }),
    execute: async ({ query, toolkit_slug, limit }, context, details) => {
      // Remember this discovery query so a successful execute that follows can
      // auto-memorize the proven (intent → slug). See maybeAutoRememberComposioChoice.
      noteComposioSearchIntent(sessionIdFromRunContext(context), query);
      const credentials = getComposioCredentialStatus();
      if (!credentials.enabled) {
        return formatComposioToolOutput({
          configured: false,
          message: 'COMPOSIO_API_KEY is not configured. Connect Composio in the dashboard first.',
          matches: [],
        }, { context, details, toolName: 'composio_search_tools' });
      }

      // DO NOT filter by `status === 'ACTIVE'` here. Composio's
      // status flag is unreliable — connections that genuinely work
      // can show as EXPIRED if the toolkit hasn't been hit recently,
      // and Clementine users have hit this filtering out Instagram /
      // TikTok / etc. that were perfectly usable. We search against
      // every connected toolkit and let the actual execute call
      // surface a real error if the connection truly is dead. That
      // gives the agent (and the user) accurate, actionable feedback
      // instead of "tool not available" when the tool IS available.
      const allConnections = await listConnectedToolkits();
      const targetToolkits = toolkit_slug
        ? [toolkit_slug]
        : [...new Set(allConnections.map((connection) => connection.slug))];
      const queryTerms = tokenize(query);
      const maxResults = Math.max(1, Math.min(limit ?? DEFAULT_SEARCH_TOTAL_LIMIT, 50));
      const matches: Array<{
        toolkit: string;
        slug: string;
        name: string;
        description?: string;
        score: number;
        inputParameters?: unknown;
      }> = [];

      for (const slug of targetToolkits) {
        let tools;
        try {
          tools = await listComposioToolkitTools(slug, DEFAULT_SEARCH_TOOLKIT_LIMIT);
        } catch (error) {
          matches.push({
            toolkit: slug,
            slug: '__toolkit_error__',
            name: 'Toolkit lookup failed',
            description: error instanceof Error ? error.message : String(error),
            score: -999,
          });
          continue;
        }

        for (const item of tools) {
          const score = scoreComposioTool(slug, item.slug, item.name, item.description, queryTerms);
          if (score <= 0 && queryTerms.length > 0) continue;
          matches.push({
            toolkit: slug,
            slug: item.slug,
            name: item.name,
            description: item.description,
            score,
            inputParameters: item.inputParameters,
          });
        }
      }

      matches.sort((left, right) => right.score - left.score || left.slug.localeCompare(right.slug));
      return formatComposioToolOutput({
        configured: true,
        connectedToolkits: allConnections.map((connection) => ({
          toolkit: connection.slug,
          account: connection.accountLabel ?? connection.alias ?? null,
          connectionId: connection.connectionId,
          // status is reported for visibility but search no longer
          // filters by it — Composio's "ACTIVE"/"EXPIRED" reporting
          // lags reality, so the agent should attempt execution and
          // surface a real error if the connection is truly dead.
          status: connection.status ?? 'unknown',
        })),
        searchedToolkits: targetToolkits,
        query,
        count: Math.min(matches.length, maxResults),
        matches: matches.slice(0, maxResults),
        nextStep: 'Pick the best match, then call `composio_execute_tool` with `tool_slug` set to the exact slug from this result and `arguments` as a JSON object string built from the action\'s `inputParameters` schema.',
      }, { context, details, toolName: 'composio_search_tools' });
    },
  });

  const composio_execute_tool = tool({
    name: 'composio_execute_tool',
    description: 'Execute any Composio action by exact slug (Outlook list-mail, Gmail search, Drive search, Salesforce query, etc.). Never invent slugs — always call `composio_search_tools` first with a plain-English query, then pass the returned slug here. Arguments must be a JSON object string. Uses the connected OAuth account and approval policy.',
    parameters: z.object({
      tool_slug: z.string().min(1),
      arguments: z.string().nullable(),
      connected_account_id: z.string().nullable(),
    }),
    // Taxonomy reads `tool_slug` from args to decide read-vs-send, so
    // GOOGLESHEETS_BATCH_GET autos through while GMAIL_SEND_EMAIL pauses
    // (or autos in YOLO).
    needsApproval: needsApprovalFromTaxonomy('composio_execute_tool'),
    execute: async ({ tool_slug, arguments: args, connected_account_id }, context, details) => {
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = parseArgumentsJson(args);
      } catch (err) {
        // Malformed JSON args is its own retry-inviting failure — make it a
        // corrective so the model fixes the JSON instead of resending it.
        return composioThrownErrorOutput(err, { context, details, toolName: 'composio_execute_tool', toolSlug: tool_slug });
      }
      return runComposioExecute(tool_slug, parsedArgs, connected_account_id ?? undefined, {
        context,
        details,
        toolName: 'composio_execute_tool',
      });
    },
  });

  return [composio_status, composio_search_tools, composio_list_tools, composio_execute_tool];
}
