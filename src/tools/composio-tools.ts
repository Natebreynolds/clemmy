import { createHash } from 'node:crypto';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { tool, type Tool } from '@openai/agents';
import { BASE_DIR } from '../config.js';
import { z } from 'zod';
import type { RuntimeContextValue } from '../types.js';
import { classifyTool, needsApprovalFromTaxonomy } from '../agents/tool-taxonomy.js';
import {
  executeComposioTool,
  getComposioCredentialStatus,
  getComposioRuntimeStatus,
  listComposioToolkitTools,
  listUsableConnectedToolkits,
  listSuppressedConnectedToolkits,
  isComposioReconnectRequiredError,
  readComposioConnectionSuppressionState,
  saveComposioConnectionSuppressionState,
  listAllToolkits,
  selectToolkitConnection,
  type ConnectedToolkit,
} from '../integrations/composio/client.js';
import { isIrreversibleSendSlug } from '../runtime/harness/execution-gate.js';
import { recallComposioAccountIdentity } from '../memory/tool-choice-store.js';
import { detectJobReceipt, asyncReceiptBanner, composioAsyncResolveEnabled, autoPollJob, recipeFor, resolveJobGetter, type JobReceipt } from '../integrations/composio/async-job.js';
import { parkComposioJob } from '../integrations/composio/job-watcher.js';
import { recordOperationalEvent } from '../runtime/operational-telemetry.js';
import { formatRecallableToolText } from '../runtime/harness/tool-output-format.js';
import { callIdFromToolDetails, runScopeIdFromRunContext, sessionIdFromRunContext } from '../runtime/harness/tool-output-context.js';
import {
  beginToolProcedureUseById,
  cancelToolProcedureUse,
  completeToolProcedureUse,
  recordToolProcedureImpression,
  rememberToolChoice,
  peekToolChoice,
  stripBakedConnectionId,
  updateToolChoiceOutcomeForIdentifier,
  recallComposioForSearch,
} from '../memory/tool-choice-store.js';
import { harnessRunContextStorage, workerThrashGuardEnabled } from '../runtime/harness/brackets.js';
import { appendFanoutAdvisory } from '../runtime/harness/fanout-advisory.js';
import { maybeDiscoveryAdvisory, isDescribeSlug, toolkitOfSlug, describeSignature } from '../runtime/harness/discovery-advisory.js';
import { isTransientStepError } from '../execution/transient-error.js';
import { asyncJobTimeoutCorrective } from '../runtime/harness/tool-error-corrective.js';
import { checkConstraintViolation, formatConstraintEscalation, findEmailSendConstraint, findOutlookCalendarReadConstraint, renderToolkitConstraintBanner } from '../runtime/harness/constraint-guard.js';
import { resolveCompliantSenderConnection, extractMailboxEmails } from '../runtime/harness/sender-verify.js';
import { rememberAccountAlias, resolveAccountAlias, aliasLabelFor } from '../memory/account-alias-store.js';
import { cachedIdentityEmail, identityProbeAttempted, recordIdentityProbe } from '../integrations/composio/identity-cache.js';
import { validateComposioArgs, formatBatchValidationError } from './composio-batch-validator.js';
import { rememberToolSchema, getCachedToolSchema } from './composio-schema-cache.js';
import { appendEvent, listEvents } from '../runtime/harness/eventlog.js';
import { sessionHasBackgroundOffer } from '../runtime/harness/convergence-steer.js';
import { shouldRetryToolCall, delayMs } from '../runtime/harness/retry-handler.js';
import { suggestNextSteps, type FailureType as FallbackFailureType } from '../runtime/fallback-chain-store.js';
import { getCapabilitiesForIntent } from '../runtime/capability-registry.js';
import { recordExecution } from '../runtime/graceful-degradation-engine.js';
import {
  suppressConnectionAfterHardAuthFailure,
  type ComposioConnectionSuppressionState,
} from '../agents/composio-connection-suppression.js';

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

/** Authoritative parameter shapes — the SINGLE SOURCE for the composio broker
 *  tools. The tool() defs below build their `parameters` from these, and the gated
 *  MCP lane (gated-mutating-tools.ts) derives its Claude-facing schema from them,
 *  so the two can never drift (TOOL-REGISTRY-PLAN C3). */
export const COMPOSIO_STATUS_PARAMS = {} satisfies z.ZodRawShape;

export const COMPOSIO_LIST_TOOLS_PARAMS = {
  toolkit_slug: z.string().min(1),
  limit: z.number().int().positive().max(200).nullable(),
} satisfies z.ZodRawShape;

export const COMPOSIO_SEARCH_TOOLS_PARAMS = {
  query: z.string().min(1),
  toolkit_slug: z.string().min(1).nullable(),
  limit: z.number().int().positive().max(50).nullable(),
} satisfies z.ZodRawShape;

export const COMPOSIO_EXECUTE_TOOL_PARAMS = {
  tool_slug: z.string().min(1),
  arguments: z.string().nullable(),
  connected_account_id: z.string().nullable(),
} satisfies z.ZodRawShape;

type SuppressedConnectedToolkit = ConnectedToolkit & { suppression: { reason?: string; suppressUntil: string } };

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

/** A failure whose cause is "this TOOLKIT isn't connected" — a missing/absent
 *  connected account, NOT a wrong id. This ALSO matches COMPOSIO_NOT_FOUND_RE
 *  ("… not found"), so it MUST be checked FIRST: the not-found corrective tells
 *  the model "the connection works, the id doesn't" and sends it hunting for
 *  table/field ids that will never resolve. The cure here is to connect the
 *  toolkit (composio_status / ask the user), not to discover ids. */
const COMPOSIO_NOT_CONNECTED_RE =
  /connected account[^.]{0,30}not found|no connected accounts?\s+found|ConnectedAccountNotFound|no connected account\b|ConnectedAccountEntityIdMismatch|ToolRouterV2[_-]?NoActiveConnection|\bNoActiveConnection\b|\bno active connection\b/i;

export function detectComposioFailure(value: unknown): { failed: boolean; summary: string; notFound: boolean; notConnected: boolean } {
  const none = { failed: false, summary: '', notFound: false, notConnected: false } as const;
  if (!isRecord(value)) return { ...none };
  const data = isRecord(value.data) ? value.data : undefined;
  // Authoritative markers: `successful === false` and `http_error` are
  // composio's own failure envelope. `status_code` (read as an HTTP status) and
  // a bare top-level `error` string are best-effort SECONDARY signals — BOTH are
  // AND-gated on `!explicitSuccess` so an authoritative `successful:true`
  // envelope wins and a successful action carrying an advisory `error`/odd code
  // isn't mislabelled. The status_code check is ALSO bounded to the real HTTP
  // error range (400–599): many toolkits nest a non-HTTP numeric `status_code`
  // in their payload — e.g. DataForSEO returns `status_code: 20000` ("Ok") on
  // SUCCESS. `20000 >= 400` is true, so an unbounded check flagged every
  // successful DataForSEO call as a HARD failure and made the model abandon good
  // data. The `< 600` bound ignores all 5-digit API codes (success AND error)
  // and defers their interpretation to `successful`/`error`/`http_error`, which
  // is correct and fully tool-agnostic.
  const httpError = data && typeof data.http_error === 'string' ? data.http_error.trim() : '';
  const statusCode = data && typeof data.status_code === 'number' ? data.status_code : undefined;
  const topError = typeof value.error === 'string' ? value.error.trim() : '';
  const explicitSuccess = value.successful === true;
  const failed =
    value.successful === false ||
    httpError.length > 0 ||
    (statusCode !== undefined && statusCode >= 400 && statusCode < 600 && !explicitSuccess) ||
    (topError.length > 0 && !explicitSuccess);
  if (!failed) return { ...none };
  const dataMessage = data && typeof data.message === 'string' ? data.message : '';
  const summary = (httpError || topError || dataMessage || `status ${statusCode ?? 'error'}`)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  // Test not-found/not-connected against ALL the error fields, not just the one
  // that won the summary — Airtable puts http_error="403" but the phrase in message.
  const allFields = `${httpError} ${topError} ${dataMessage}`;
  const notConnected = COMPOSIO_NOT_CONNECTED_RE.test(allFields) || isComposioReconnectRequiredError(value);
  const notFound = COMPOSIO_NOT_FOUND_RE.test(allFields);
  return { failed: true, summary, notFound, notConnected };
}

/**
 * Classify failure type for fallback chain lookup.
 */
function classifyFailureType(summary: string): 'permission_denied' | 'not_found' | 'rate_limit' | 'timeout' | 'unknown' {
  const lower = summary.toLowerCase();
  if (/403|permission|forbidden|unauthorized|deny|access\s+denied/i.test(lower)) return 'permission_denied';
  if (/404|not\s+found|does\s+not\s+exist|no\s+such|unknown|invalid.*(?:id|table|record|field)/i.test(lower))
    return 'not_found';
  if (/429|rate\s+limit|quota|too\s+many\s+requests/i.test(lower)) return 'rate_limit';
  if (/timeout|timed\s+out|deadline|took\s+too\s+long/i.test(lower)) return 'timeout';
  return 'unknown';
}

/**
 * Format fallback suggestions from capability registry and learned chains.
 */
function formatFallbackSuggestions(intent: string, failedTool: string, failureType: ReturnType<typeof classifyFailureType>): string {
  try {
    // Get learned fallback chains (from prior failures)
    const suggestion = suggestNextSteps(intent, failedTool, failureType);

    if (suggestion.fallback.length === 0) {
      // Fall back to capability registry for alternatives
      const caps = getCapabilitiesForIntent(intent);
      const alternatives = caps
        .filter((c) => c.toolName !== failedTool && c.score > 0.3) // Only viable alternatives
        .slice(0, 3); // Top 3 options

      if (alternatives.length === 0) {
        return '';
      }

      const lines = [`Your alternatives for "${intent}":`];
      for (const alt of alternatives) {
        lines.push(`  • ${alt.toolName} (${(alt.score * 100).toFixed(0)}% fit): ${alt.reason}`);
        if (alt.requirement) lines.push(`    Requires: ${alt.requirement}`);
      }
      return lines.join('\n');
    }

    // Use learned fallback chain
    const lines = [
      `Based on prior attempts, when ${intent} fails with ${failureType}, try these in order:`,
    ];
    for (const tool of suggestion.fallback.slice(0, 3)) {
      lines.push(`  • ${tool}`);
    }
    return lines.join('\n');
  } catch (err) {
    // Silently ignore fallback suggestion errors; never break error reporting
    return '';
  }
}

/** Loud, self-correcting header prepended to a failed Composio execution so
 *  the model adapts on failure #1 instead of retrying identically. Names the
 *  tool the model actually called (`composio_execute_tool` or the dynamic
 *  `cx_<slug>`) and the slug, so the corrective is unambiguous on both paths. */
/** Derive a natural-language intent seed from a Composio slug so the cross-surface
 *  alternatives machinery (getCapabilitiesForIntent) can actually match a pattern.
 *  GMAIL_SEND_EMAIL → "gmail send email". Without this the callers passed no intent,
 *  it defaulted to a placeholder, and the whole "here are your alternatives (incl. a
 *  native MCP / CLI for the same capability)" path was inert. */
/** Best-effort count of items in an auto-resolved async dataset (Apify GET_DATASET_ITEMS
 *  and friends), for the requested-vs-returned partial-scrape check. null when unknown. */
export function asyncResultItemCount(result: unknown): number | null {
  const seen: unknown[] = [result];
  for (let i = 0; i < seen.length && i < 6; i += 1) {
    const v = seen[i];
    if (Array.isArray(v)) return v.length;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const key of ['items', 'data', 'results', 'records']) {
        if (key in o) seen.push(o[key]);
      }
    }
  }
  return null;
}

function intentSeedFromSlug(toolSlug?: string): string | undefined {
  if (!toolSlug) return undefined;
  const seed = toolSlug.replace(/[_\-]+/g, ' ').trim().toLowerCase();
  return seed || undefined;
}

/** True when a rendered composio_execute_tool result is a failure corrective.
 *  composioFailureCorrective ALWAYS emits a first line
 *  '⚠️ <label> FAILED|NOT CONNECTED|NOT FOUND (slug=…): …' and result clipping
 *  never removes the head, so the first line is authoritative. ONE owner for
 *  the header format (fold-3 review wf_8e927519-d43: evidenceLooksFailedOrBlocked
 *  targets memo prose and let every real composio failure through the pin filter). */
export function renderedComposioResultLooksFailed(resultStr: string | undefined): boolean {
  if (!resultStr) return false;
  const nl = resultStr.indexOf('\n');
  const head = nl === -1 ? resultStr : resultStr.slice(0, nl);
  return head.startsWith('⚠️') && /\b(FAILED|NOT CONNECTED|NOT FOUND)\b/.test(head);
}

function composioFailureCorrective(
  summary: string,
  opts: { toolName?: string; toolSlug?: string; notFound?: boolean; notConnected?: boolean; transient?: boolean; intent?: string } = {},
): string {
  const label = opts.toolName || 'composio_execute_tool';
  const where = opts.toolSlug ? ` (slug=${opts.toolSlug})` : '';

  // Classify failure for fallback chain lookup
  const failureType = classifyFailureType(summary);
  const failedTool = opts.toolSlug || 'unknown_tool';
  const intent = opts.intent || 'accomplish this task';
  const fallbackSuggestions = formatFallbackSuggestions(intent, failedTool, failureType);

  // NOT-CONNECTED FIRST (before not-found): "Connected account not found for
  // toolkit X" ALSO matches the not-found regex, but the not-found corrective
  // ("the connection works, the id doesn't") is WRONG here and sends the model
  // hunting for table/field ids that never resolve. The real cure is to connect
  // the toolkit. Derive the toolkit from the slug's first segment when present.
  if (opts.notConnected) {
    const toolkit = (opts.toolSlug?.split('_')[0] || '').toUpperCase() || 'this toolkit';
    return [
      `⚠️ ${label} NOT CONNECTED${where}: ${summary}`,
      `The saved ${toolkit} connection is missing or belongs to a different Composio user. This is NOT an argument or schema problem.`,
      `Open Connect and reconnect ${toolkit}. Do NOT retry this action until the app has been reconnected.`,
    ].join('\n');
  }
  // Timeout FIRST (before the transient branch): a long-running job (an actor
  // run, a big scrape/export, a blocking sync "get dataset items") that exceeded
  // its window must switch to the async start+poll pattern — retrying the SAME
  // blocking call just times out again (live 2026-06-24: two sync Apify actor
  // calls each burned the full 5-min window). Shares the symptom with transient
  // but needs the OPPOSITE move, so it can't ride the "retry once" copy below.
  if (failureType === 'timeout' && !opts.notFound) {
    return [
      asyncJobTimeoutCorrective(label, summary, where),
      fallbackSuggestions && `If async doesn't fit, alternatives:\n${fallbackSuggestions}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  if (opts.transient && !opts.notFound) {
    // FIX 1.4 — a transient infra error (rate-limit / 5xx / network) is the ONE
    // case where repeating the SAME call is productive. Tell the model to retry
    // ONCE so we preserve legitimate recovery — but cap it so a persistent
    // outage doesn't become thrash. (Distinct from the deterministic "do NOT
    // repeat" copy below, and from the timeout async-steer above.)
    return [
      `⚠️ ${label} FAILED${where}: ${summary}`,
      `This looks like a TRANSIENT infrastructure error (rate-limit / 5xx / network) — NOT a bad request. A SINGLE retry of the SAME call after a brief pause may succeed.`,
      `Retry this EXACT call ONCE. If it fails again, treat it as a hard blocker: switch approach (different action/tool) or report the specific blocker to the user. Do NOT retry more than once.`,
      fallbackSuggestions && `If retry fails, here are your alternatives:\n${fallbackSuggestions}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
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
  if (/\boffset\b|opaque token|pagination|next[- ]?page/i.test(summary)) {
    // Pagination/offset error — almost always because the PREVIOUS list result
    // was clipped for size (full payload is stored) and the model then GUESSED
    // an offset to "get the rest". The fix is to RECALL, not paginate (the
    // scorpion 44→4 / 'itr2' bug).
    return [
      `⚠️ ${label} FAILED${where}: ${summary}`,
      `An offset/page token must be the EXACT opaque value returned in a prior response's \`offset\` field — never a guessed one. Most likely your previous list call returned everything but its result was CLIPPED for size: the FULL payload is stored.`,
      `Do this: call \`recall_tool_result\` on your previous list call to get the COMPLETE set in one shot — do NOT pass a guessed offset. Only paginate if a prior response actually returned a verbatim \`offset\` token.`,
    ].join('\n');
  }
  return [
    `⚠️ ${label} FAILED${where}: ${summary}`,
    `This is a HARD failure — calling it again with the SAME arguments will return the SAME error.`,
    `Do ONE of these instead: (1) fix the arguments — re-check the action's exact required field names/shape (a 4xx almost always means a wrong, missing, or misnamed field); (2) use a different action or tool for this (e.g. composio_search_tools to find the right slug); (3) if you can't resolve it, STOP and tell the user the specific blocker. Do NOT repeat this identical call.`,
    fallbackSuggestions && `If you need alternatives for "${intent}", here are your options:\n${fallbackSuggestions}`,
  ]
    .filter(Boolean)
    .join('\n\n');
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
  const { failed, summary, notFound, notConnected } = detectComposioFailure(value);
  if (!failed) return body; // success: the GLOBAL id-index (formatRecallableToolText) handles resource lists
  const transient = workerThrashGuardEnabled() && !notFound && isTransientStepError(summary);
  return composioFailureCorrective(summary, { toolName: options.toolName, toolSlug: options.toolSlug, notFound, notConnected, transient, intent: intentSeedFromSlug(options.toolSlug) }) + '\n\n' + body;
}

/**
 * The OTHER composio failure channel: executeComposioTool also THROWS — for a
 * not-found slug, an auth/connection error, or any non-2xx the SDK surfaces as
 * an APIError. Left to propagate, the SDK renders these as "An error occurred …
 * Please try again", which invites the exact identical-retry thrash. Catch the
 * throw at the execute wrapper and route it through the same loud corrective so
 * BOTH channels (returned error envelope + thrown error) make the model adapt.
 */
/**
 * Composio's SDK collapses real dispatch failures to a hardcoded generic
 * `message` ("Error executing the tool <SLUG>") and hangs the actual upstream
 * detail (HTTP status, response body, fix hints) off `.cause` / `.statusCode` /
 * `.possibleFixes` / `getErrorData()`. Reading only `.message` discards all of
 * it — which is how the 2026-06-29 Apify failure reached the user as a fabricated
 * "re-authorize Apify" auth diagnosis. Fold the hidden detail back into the
 * message so the corrective classifier AND the model see the true cause.
 */
function enrichComposioErrorMessage(err: unknown, fallback: string): string {
  if (!err || typeof err !== 'object') return fallback;
  const e = err as Record<string, unknown> & { getErrorData?: () => unknown };
  let data: Record<string, unknown> | undefined;
  try {
    if (typeof e.getErrorData === 'function') {
      const d = e.getErrorData();
      if (d && typeof d === 'object') data = d as Record<string, unknown>;
    }
  } catch { /* getErrorData is best-effort */ }
  const parts: string[] = [];
  const statusCode = e.statusCode ?? data?.statusCode;
  if (statusCode) parts.push(`HTTP ${String(statusCode)}`);
  const cause = e.cause ?? data?.cause;
  let causeMsg: string | undefined;
  if (cause instanceof Error) causeMsg = cause.message;
  else if (typeof cause === 'string') causeMsg = cause;
  else if (cause && typeof cause === 'object') {
    const c = cause as Record<string, unknown>;
    causeMsg = typeof c.message === 'string' ? c.message
      : typeof c.error === 'string' ? c.error
      : JSON.stringify(c);
  }
  if (causeMsg && causeMsg.trim() && causeMsg.trim() !== fallback) parts.push(causeMsg.trim().slice(0, 600));
  const fixes = e.possibleFixes ?? data?.possibleFixes;
  if (Array.isArray(fixes) && fixes.length) parts.push(`fixes: ${fixes.map(String).join('; ').slice(0, 300)}`);
  const enriched = parts.join(' — ');
  return enriched ? `${fallback} (${enriched})` : fallback;
}

export function composioThrownErrorOutput(
  err: unknown,
  options: FormatComposioToolOutputOptions = {},
): string {
  const rawMessage = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  const message = enrichComposioErrorMessage(err, rawMessage).replace(/\s+/g, ' ').trim();
  const summary = message.slice(0, 240) || 'unknown error';
  const notConnected = COMPOSIO_NOT_CONNECTED_RE.test(message) || isComposioReconnectRequiredError(err);
  const notFound = COMPOSIO_NOT_FOUND_RE.test(message);
  const body = formatComposioToolOutput({ error: message, toolSlug: options.toolSlug ?? null }, options);
  // The thrown path carries the real error object (status/cause) — classify on
  // it directly so undici `fetch failed`→ECONNRESET is correctly transient.
  const transient = workerThrashGuardEnabled() && !notFound && isTransientStepError(err);
  return composioFailureCorrective(summary, { toolName: options.toolName, toolSlug: options.toolSlug, notFound, notConnected, transient, intent: intentSeedFromSlug(options.toolSlug) }) + '\n\n' + body;
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
const lastComposioSearchBySession = new Map<string, {
  query: string;
  at: number;
  slugs?: string[];
  fromMemory?: boolean;
  useIdsBySlug?: Record<string, string>;
}>();

// F2 — cross-call reconnect breaker. 90870d8c stops the WITHIN-call retry, but the
// 15-call thrash was the MODEL re-calling composio_execute_tool for the same dead
// toolkit across separate runs (each with no connection resolved, so the
// connection-keyed suppression short-returned ''). Keyed by toolkit (not
// connectionId) so it fires even when nothing resolved. Once a toolkit has failed
// reconnect-required this session, later attempts short-circuit deterministically
// (no network) until a successful execute or a cache invalidation clears it.
const RECONNECT_BREAKER_TTL_MS = 3 * 60 * 1000;
const reconnectBreakerBySession = new Map<string, number>();
function reconnectBreakerEnabled(): boolean {
  return (process.env.CLEMMY_COMPOSIO_RECONNECT_BREAKER ?? 'on').toLowerCase() !== 'off';
}
function reconnectBreakerKey(sid: string, toolSlug: string): string {
  return `${sid}::${toolkitOfSlug(toolSlug)}`;
}
function recordReconnectBreaker(sid: string | undefined, toolSlug: string): void {
  if (!sid) return;
  reconnectBreakerBySession.set(reconnectBreakerKey(sid, toolSlug), Date.now());
  if (reconnectBreakerBySession.size > 500) reconnectBreakerBySession.clear(); // crude bound
}
function reconnectBreakerTripped(sid: string | undefined, toolSlug: string): boolean {
  if (!sid || !reconnectBreakerEnabled()) return false;
  const at = reconnectBreakerBySession.get(reconnectBreakerKey(sid, toolSlug));
  if (at === undefined) return false;
  if (Date.now() - at > RECONNECT_BREAKER_TTL_MS) { reconnectBreakerBySession.delete(reconnectBreakerKey(sid, toolSlug)); return false; }
  return true;
}
function clearReconnectBreaker(sid: string | undefined, toolSlug: string): void {
  if (sid) reconnectBreakerBySession.delete(reconnectBreakerKey(sid, toolSlug));
}

/** Test seam for the gateway's breaker (module-private state). */
export const __gatewayTest__ = {
  recordReconnectBreaker,
  reconnectBreakerTripped,
  clearReconnectBreaker,
};

/** Record the discovery query (and, when known, the candidate slugs the search
 *  surfaced) so a following successful execute can learn from it — and only
 *  learn a slug the search actually returned. Exported for tests. */
export function noteComposioSearchIntent(
  sessionId: string | undefined,
  query: string,
  slugs?: string[],
  options: { fromMemory?: boolean; useIdsBySlug?: Record<string, string> } = {},
): void {
  if (!sessionId || !query.trim()) return;
  // Bound the map — tiny entries, but don't leak across a long-lived daemon.
  if (lastComposioSearchBySession.size > 500) {
    const cutoff = Date.now() - AUTO_REMEMBER_WINDOW_MS;
    for (const [k, v] of lastComposioSearchBySession) {
      if (v.at < cutoff) lastComposioSearchBySession.delete(k);
    }
  }
  const replaced = lastComposioSearchBySession.get(sessionId);
  if (replaced?.useIdsBySlug) {
    for (const useId of Object.values(replaced.useIdsBySlug)) cancelToolProcedureUse(useId);
  }
  lastComposioSearchBySession.set(sessionId, {
    query: query.trim(),
    at: Date.now(),
    slugs: slugs && slugs.length > 0 ? slugs.slice(0, 60) : undefined,
    fromMemory: options.fromMemory,
    useIdsBySlug: options.useIdsBySlug,
  });
}

/** The honest intent behind an execute, for outcome learning: the session's
 *  fresh search query when that search actually surfaced this slug, else a
 *  readable seed from the slug. The surfaced-slug gate is the synchronous twin
 *  of auto-remember's semantic gate — a stale query about a DIFFERENT toolkit
 *  must never label this slug's outcome stats. Read-only — never consumes the
 *  session entry (auto-remember owns deletion). */
export function executionIntentForSession(sessionId: string | undefined, toolSlug: string): string {
  const pending = sessionId ? lastComposioSearchBySession.get(sessionId) : undefined;
  const fresh = Boolean(pending && Date.now() - pending.at <= AUTO_REMEMBER_WINDOW_MS);
  const surfacedThisSlug = Boolean(pending?.slugs?.includes(toolSlug));
  return (fresh && surfacedThisSlug ? pending?.query.trim() : undefined)
    || intentSeedFromSlug(toolSlug)
    || 'composio_execute';
}

/** Cross-service mis-binding guard. A (possibly stale/loose) search query about
 *  toolkit X must never be bound to a slug from a DIFFERENT toolkit Y. Observed
 *  2026-06-22: a "DataForSEO ranked keywords" search whose auto-remember window
 *  caught an AIRTABLE_LIST_RECORDS execute bound the DataForSEO intent to the
 *  Airtable slug — workers then honored it and "hard-errored." Returns true (=
 *  refuse the bind) when the slug's OWN toolkit is not named in the query AND a
 *  different KNOWN toolkit IS named (an explicit contradiction). A query that
 *  names the slug's own toolkit — including a multi-toolkit query — is allowed;
 *  a query that names NO known toolkit falls through (learning unchanged).
 *  knownToolkits are runtime-discovered (connected accounts), never hardcoded.
 *  Exported for tests. */
export function isCrossServiceToolkitMismatch(query: string, slug: string, knownToolkits: string[]): boolean {
  const slugToolkit = (slug.split('_')[0] ?? '').toLowerCase();
  if (!slugToolkit) return false;
  const q = query.toLowerCase();
  if (q.includes(slugToolkit)) return false; // names its own toolkit → consistent
  return knownToolkits.some((t) => {
    const tk = (t ?? '').toLowerCase();
    return tk.length > 0 && tk !== slugToolkit && q.includes(tk);
  });
}

/** On a SUCCESSFUL execute that followed a fresh discovery, memorize the choice.
 *  Exported for tests. */
export async function maybeAutoRememberComposioChoice(
  toolSlug: string,
  args: Record<string, unknown>,
  result: unknown,
  sessionId: string | undefined,
  connectionId?: string,
): Promise<void> {
  try {
    const failed = detectComposioFailure(result).failed;
    // Async-aware learning: a queued RECEIPT (a DataForSEO task_post handle, an Apify
    // run handle) is NOT a completed outcome — the job hasn't produced a result yet.
    // Neither credit it as a success nor learn it as the proven tool for the intent
    // (that would teach "task_post = the answer" when it only QUEUES). The real
    // outcome is decided when the result is fetched. Guarded by the same kill-switch.
    if (!failed && composioAsyncResolveEnabled() && detectJobReceipt(toolSlug, result)) return;
    const sid = sessionId;
    const pending = sid ? lastComposioSearchBySession.get(sid) : undefined;
    const pendingFresh = Boolean(pending && Date.now() - pending.at <= AUTO_REMEMBER_WINDOW_MS);
    if (sid && pending) lastComposioSearchBySession.delete(sid);
    const selectedUseId = pendingFresh ? pending?.useIdsBySlug?.[toolSlug] : undefined;
    if (pending?.useIdsBySlug) {
      for (const useId of Object.values(pending.useIdsBySlug)) {
        if (useId !== selectedUseId) cancelToolProcedureUse(useId);
      }
    }
    if (selectedUseId) {
      // Exact one-shot attribution from remembered search → execute.
      completeToolProcedureUse(selectedUseId, failed ? 'failure' : 'success');
    } else {
      // Compatibility fallback: credit only when the identifier resolves to ONE
      // canonical procedure. Ambiguous account/operation matches credit nothing.
      updateToolChoiceOutcomeForIdentifier(toolSlug, failed ? 'failure' : 'success');
    }
    if (failed) return; // only LEARN a new choice from successes
    if (!sid) return;
    if (!pending) return; // slug wasn't just discovered — nothing new to learn
    if (!pendingFresh) return;
    // A memory hit is an impression/use of an existing procedure, not a new
    // search-query alias. Do not fragment it with another phrasing.
    if (pending.fromMemory) return;
    // (A) v0.5.64 — semantic gate: only auto-remember a slug the SEARCH actually
    // surfaced for this intent. Before this, ANY successful execute keyed to the
    // last search query got cached — so a fallback the model reached for (a
    // create-draft tool for a "send" intent, or even a different toolkit's slug)
    // became THE cached answer and poisoned the intent. We only enforce when the
    // search recorded candidates (legacy/no-candidate path falls back to prior
    // behavior so existing learning still works).
    if (pending.slugs && pending.slugs.length > 0 && !pending.slugs.includes(toolSlug)) return;
    // (A2) Cross-service guard — closes the no-candidate fallback hole: even when
    // the search recorded no candidates, never bind a query about toolkit X to a
    // slug from toolkit Y (the 2026-06-22 "DataForSEO intent → AIRTABLE_LIST_RECORDS"
    // pollution). Runtime-discovered toolkits; fail-open so a lookup error never
    // blocks legitimate learning.
    try {
      const known = (await listUsableConnectedToolkits()).map((t) => t.slug).filter((s): s is string => Boolean(s));
      if (isCrossServiceToolkitMismatch(pending.query, toolSlug, known)) return;
    } catch {
      // fail-open: a guard error must never break learning
    }
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
    // C4 — learn the MAILBOX (stable email, never the ca_ id): only when a
    // specific connection was used AND the toolkit has >1 connection (so the
    // binding actually disambiguates). Single-account toolkits stay byte-
    // identical; a genuinely-ambiguous execute never reaches here with a pinned
    // connectionId. Zero network (SWR cache in hand).
    let accountIdentity: string | undefined;
    if (connectionId) {
      try {
        const conns = await listUsableConnectedToolkits();
        const lower = toolSlug.toLowerCase();
        const forToolkit = conns.filter((c) => {
          const s = (c.slug ?? '').toLowerCase();
          return s && (lower === s || lower.startsWith(`${s}_`));
        });
        if (forToolkit.length > 1) {
          const email = forToolkit.find((c) => c.connectionId === connectionId)?.accountEmail?.trim().toLowerCase();
          if (email && email.includes('@')) accountIdentity = email;
        }
      } catch { /* fail-open: identity capture must never break learning */ }
    }
    rememberToolChoice({
      intent,
      description: 'Auto-remembered: this Composio slug satisfied the searched intent.',
      aliasSource: 'composio_search',
      choice: {
        kind: 'composio',
        identifier: toolSlug,
        invocationTemplate: template,
        accountIdentity,
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
// The detector itself now lives in src/runtime/harness/fanout-advisory.ts so it
// can be shared with the MCP namespace shim (native dataforseo__*/firecrawl__*
// reads were previously invisible to this composio-only nudge). This wrapper
// keeps the original 3-arg signature for the composio path + existing tests;
// passing `resultText` additionally enables the data-flow independence guard.
export function maybeFanoutAdvisory(
  toolSlug: string,
  args: Record<string, unknown>,
  sessionId: string | undefined,
  resultText?: string,
): string | null {
  return appendFanoutAdvisory({ toolName: toolSlug, args, sessionId, resultText });
}

/**
 * Standing-constraint gate for EVERY composio dispatch path (both
 * `composio_execute_tool` and the dynamic first-class `cx_*` tools route
 * through runComposioExecute). Returns a model-facing block message when the
 * call must not execute, null when clear to proceed.
 *
 * The email-sender rule is enforced with a REAL mailbox lookup
 * (OUTLOOK_GET_PROFILE), not arg pattern-matching — `user_id: 'me'` is
 * resolved to the actual connected mailbox before any send leaves
 * (2026-06-11 wrong-mailbox incident). Fail-closed.
 */
interface ConstraintGateResult {
  block: string | null;
  /** When set, dispatch through THIS connection instead of the caller's
   *  (constraint-directed routing across multiple connected accounts). */
  routeConnectedAccountId?: string;
}

async function enforceStandingConstraints(
  toolSlug: string,
  args: Record<string, unknown>,
  connectedAccountId: string | undefined,
): Promise<ConstraintGateResult> {
  const senderOverride = args.sender_override_confirmed === true;
  delete args.sender_override_confirmed; // meta-arg — never reaches the provider API

  let routeConnectedAccountId: string | undefined;
  const emailRule = findEmailSendConstraint(toolSlug, args);
  if (emailRule) {
    if (senderOverride) {
      console.error(`[sender-verify] OVERRIDE used for ${toolSlug} — user-directed alternate sender (constraint #${emailRule.constraint.id})`);
    } else {
      // Multiple accounts of one toolkit can be connected on purpose (read
      // from all, send from one). Resolve the send to the connection whose
      // VERIFIED mailbox matches the rule; block only when none complies.
      let connections: { connectionId: string; accountEmail?: string; status?: string }[] = [];
      try {
        const toolkit = toolkitOfSlug(toolSlug);
        connections = (await listUsableConnectedToolkits())
          .filter((c) => c.slug.toLowerCase() === toolkit)
          .map((c) => ({ connectionId: c.connectionId, accountEmail: c.accountEmail, status: c.status }));
      } catch { /* connection listing failure → resolution probes nothing and fails closed */ }
      const resolution = await resolveCompliantSenderConnection({
        rule: emailRule,
        toolSlug,
        userId: String(args.user_id ?? 'me'),
        explicitConnectionId: connectedAccountId,
        connections,
        fetchProfile: (slug, profileArgs, connectionId) => executeComposioTool(slug, profileArgs, connectionId),
      });
      if (!resolution.ok) return { block: resolution.message ?? 'Blocked by standing sender constraint.' };
      routeConnectedAccountId = resolution.routeConnectionId;
    }
  }

  const violation = checkConstraintViolation('composio_execute_tool', {
    ...args,
    action: toolSlug,
  }, { emailHandledExternally: true });
  if (violation) return { block: formatConstraintEscalation(violation) };

  return { block: null, routeConnectedAccountId };
}

export function normalizeInlineConnectedAccountId(
  args: Record<string, unknown>,
  connectedAccountId: string | undefined,
): { args: Record<string, unknown>; connectedAccountId: string | undefined } {
  const inline = args.connected_account_id ?? args.connectedAccountId;
  let effectiveConnectionId = connectedAccountId;
  if (!effectiveConnectionId && typeof inline === 'string') {
    const trimmed = inline.trim();
    if (trimmed && !['null', 'undefined', 'none'].includes(trimmed.toLowerCase())) {
      effectiveConnectionId = trimmed;
    }
  }
  delete args.connected_account_id;
  delete args.connectedAccountId;
  return { args, connectedAccountId: effectiveConnectionId };
}

export function applySuppressedComposioConnectionPolicy(
  toolSlug: string,
  connectedAccountId: string | undefined,
  state: ComposioConnectionSuppressionState,
  nowMs: number = Date.now(),
): { connectedAccountId: string | undefined; note?: string; block?: string } {
  if (!connectedAccountId) return { connectedAccountId };
  const suppression = state.suppressedConnections?.[connectedAccountId];
  if (!suppression) return { connectedAccountId };
  const untilMs = Date.parse(suppression.suppressUntil);
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) return { connectedAccountId };

  const reason = suppression.reason ?? 'suppressed';
  const toolkit = toolkitOfSlug(toolSlug).toUpperCase();
  const mutating = classifyTool('composio_execute_tool', { args: { tool_slug: toolSlug } }) !== 'read';
  if (mutating) {
    return {
      connectedAccountId,
      block:
        `COMPOSIO_CONNECTION_SUPPRESSED: \`${toolSlug}\` was pinned to connection \`${connectedAccountId}\`, ` +
        `but Clementine has already quarantined that ${toolkit} connection as ${reason} until ${suppression.suppressUntil}. ` +
        `Do NOT retry this connection id. Call \`composio_status\` to inspect usable connections; if this exact account is required, ask the user to reconnect it. ` +
        `For external writes/sends, do not silently switch accounts unless a standing account rule or explicit user instruction verifies the replacement.`,
    };
  }

  return {
    connectedAccountId: undefined,
    note:
      `[connection-repair] Ignored suppressed ${toolkit} connection ${connectedAccountId} (${reason} until ${suppression.suppressUntil}) ` +
      `and retried without the stale pin so live connection resolution can choose a usable account.`,
  };
}

function latestUserInputForContext(context: unknown): string {
  const sessionId = sessionIdFromRunContext(context);
  if (!sessionId) return '';
  try {
    const [latest] = listEvents(sessionId, { types: ['user_input_received'], limit: 1, desc: true });
    const text = latest?.data && typeof latest.data.text === 'string' ? latest.data.text : '';
    return text.slice(0, 2000);
  } catch {
    return '';
  }
}

function backgroundOfferSuppressedForContext(context: unknown): boolean {
  const outer = context && typeof context === 'object' ? context as Record<string, unknown> : undefined;
  const inner = outer?.context && typeof outer.context === 'object'
    ? outer.context as Record<string, unknown>
    : undefined;
  const sessionId = sessionIdFromRunContext(context);
  return outer?.suppressBackgroundOffer === true
    || inner?.suppressBackgroundOffer === true
    || harnessRunContextStorage.getStore()?.suppressBackgroundOffer === true
    || sessionHasBackgroundOffer(sessionId);
}

/** Keep the default long-job guidance byte-identical, but do not create a
 * second conversational gate while executing the answer to a clarification. */
export function formatComposioBudgetExceededOutput(
  receipt: JobReceipt,
  output: string,
  context?: unknown,
): string {
  if (!backgroundOfferSuppressedForContext(context)) {
    return `${asyncReceiptBanner(receipt)}\n\nThis is a LONG-running job (still going after the auto-poll window). Prefer handing it to the background (offer_background / dispatch_background_task) so it finishes and reports back on its own — do NOT sit here firing back-to-back polls.\n\n${output}`;
  }
  return `${asyncReceiptBanner(receipt)}\n\nThis is the existing LONG-running job from the direction the user just clarified. Continue from this receipt and its job id; do not add another background-choice gate, do not restart or re-invoke the job, and do not fire back-to-back polls.\n\n${output}`;
}

function suppressComposioConnectionAfterHardFailure(connectionId: string | undefined, err: unknown): string {
  if (!connectionId) return '';
  try {
    const state = readComposioConnectionSuppressionState() as unknown as ComposioConnectionSuppressionState;
    const suppression = suppressConnectionAfterHardAuthFailure(state, connectionId, err, Date.now());
    if (!suppression) return '';
    saveComposioConnectionSuppressionState(state);
    return `\n\n[connection-suppressed] Suppressed connection ${connectionId} for ${suppression.reason} until ${suppression.suppressUntil}; future Composio status/search surfaces will avoid it.`;
  } catch {
    return '';
  }
}

function isActiveConnectionStatus(status: string | undefined): boolean {
  return /active|enabled|initiat/i.test(status ?? '');
}

function countByToolkit(connections: Array<{ slug?: string; toolkit?: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const connection of connections) {
    const slug = (connection.slug ?? connection.toolkit ?? '').toLowerCase();
    if (!slug) continue;
    counts[slug] = (counts[slug] ?? 0) + 1;
  }
  return counts;
}

export function buildComposioStatusPayload(
  credentials: Record<string, unknown>,
  connections: ConnectedToolkit[],
  suppressedConnections: SuppressedConnectedToolkit[],
  exposeSuppressedIds = ['1', 'true', 'yes'].includes((process.env.CLEMMY_COMPOSIO_STATUS_EXPOSE_SUPPRESSED_IDS ?? '').toLowerCase()),
): Record<string, unknown> {
  const connectionList = connections.map((connection) => ({
    toolkit: connection.slug,
    slug: connection.slug,
    connectionId: connection.connectionId,
    status: connection.status,
    account: connection.accountLabel ?? connection.alias ?? null,
  }));
  const usableConnections = connectionList.filter((connection) => isActiveConnectionStatus(connection.status));
  const suppressedConnectionList = suppressedConnections.map((connection) => {
    const base = {
      toolkit: connection.slug,
      slug: connection.slug,
      status: connection.status,
      account: connection.accountLabel ?? connection.alias ?? null,
      reason: connection.suppression.reason ?? 'suppressed',
      suppressUntil: connection.suppression.suppressUntil,
    };
    return exposeSuppressedIds ? { ...base, connectionId: connection.connectionId } : base;
  });

  return {
    ...credentials,
    statusGuidance:
      'For usable/active connection summaries, count only usableConnections. ' +
      'Never count suppressedConnections as usable; suppressed connection ids are hidden by default because they are stale/expired/mismatched.',
    counts: {
      nonSuppressedConnections: connectionList.length,
      usableConnections: usableConnections.length,
      suppressedConnections: suppressedConnectionList.length,
      usableByToolkit: countByToolkit(usableConnections),
      suppressedByToolkit: countByToolkit(suppressedConnectionList),
    },
    usableConnections,
    connections: connectionList,
    connectedAccounts: connectionList,
    suppressedConnections: suppressedConnectionList,
    note: suppressedConnectionList.length > 0
      ? 'Suppressed connections are known stale/expired/mismatched and are intentionally omitted from usableConnections. Do not use or mention their connected_account_id unless the user explicitly asks to reconnect/test that account.'
      : undefined,
  };
}

/** Deterministic ASK for a genuinely-ambiguous multi-mailbox toolkit — never
 *  dispatch under a guessed/default account. Lists the candidate mailboxes WITH
 *  their saved names and connection ids so the model can pin the named one on
 *  the retry (connected_account_id), and TEACHES the naming gesture: passing
 *  `account_alias` with the pin makes the binding permanent. */
function composioMultiAccountAskMessage(
  toolSlug: string,
  outcome: { kind: 'ambiguous' | 'identity-absent'; want?: string; candidates: Array<{ email?: string; wordId?: string; connectionId: string }> },
): string {
  const toolkit = toolkitOfSlug(toolSlug);
  const mailboxes = outcome.candidates
    .map((c, i) => {
      const label = aliasLabelFor(toolkit, c.email, c.connectionId);
      const display = [label ? `"${label}"` : undefined, c.email ?? c.wordId ?? c.connectionId].filter(Boolean).join(' — ');
      return `  ${i + 1}. ${display} (connected_account_id: ${c.connectionId})`;
    })
    .join('\n');
  const lead = outcome.kind === 'identity-absent'
    ? `The ${toolkit} account this action expects (${outcome.want}) is no longer connected.`
    : `You have ${outcome.candidates.length} ${toolkit} accounts connected, so I need to know WHICH account to use for this action.`;
  return (
    `⚠️ NEEDS-YOUR-CHOICE (${toolkit}): ${lead}\n\n`
    + `Connected ${toolkit} accounts:\n${mailboxes}\n\n`
    + `Nothing was dispatched. Ask the user which account to use, then re-call this tool with \`connected_account_id\` set to the chosen connection id. `
    + `If the user NAMES the account (e.g. "that's my scorpion email"), ALSO pass \`account_alias\` (e.g. "scorpion") with the pinned re-call — the name is then remembered permanently, and future calls can use \`account_alias\` alone instead of asking again. Do NOT guess — acting on the wrong account is exactly the mistake this guard prevents.`
  );
}

// ─── Account identity enrichment (probe-once) + named aliases ────────────────
// Some listings expose NO mailbox identity (Microsoft tokens carry no email),
// so same-mailbox re-auths can't merge and names can't bind. On the first
// ambiguous encounter the gateway probes each candidate's profile ONCE (pinned
// read; owner-pair dispatch), caches connection→email durably, and re-resolves.
// Toolkits without a known profile slug are skipped (and never re-probed).
const PROFILE_SLUG_BY_TOOLKIT: Record<string, string> = {
  outlook: 'OUTLOOK_GET_PROFILE',
  gmail: 'GMAIL_GET_PROFILE',
};

async function enrichToolkitIdentities(toolkit: string, candidates: ConnectedToolkit[]): Promise<number> {
  const profileSlug = PROFILE_SLUG_BY_TOOLKIT[toolkit];
  if (!profileSlug) return 0;
  const targets = candidates
    .filter((c) => !c.accountEmail && c.connectionId && !identityProbeAttempted(c.connectionId))
    .slice(0, 4); // bounded — one-time cost per connection, cached forever
  if (targets.length === 0) return 0;
  let learned = 0;
  await Promise.all(targets.map(async (c) => {
    try {
      // user_id:'me' matches sender-verify's probe (a bare {} can mis-scope).
      const profile = await executeComposioTool(profileSlug, { user_id: 'me' }, c.connectionId);
      // A Composio FAILURE envelope is returned as data (it does not throw); its
      // error text can contain a stray email literal (e.g. support@composio.dev)
      // that extractMailboxEmails' regex fallback would scavenge and cache as the
      // mailbox — merging DISTINCT accounts under a bogus identity. Guard exactly
      // as sender-verify does, and extract from STRUCTURED fields only (no
      // whole-JSON regex) so even a success envelope can't leak a stray address.
      if (detectComposioFailure(profile).failed) return; // transient/not-connected — leave unprobed, retry later
      const email = extractMailboxEmails(profile, { structuredOnly: true })[0] ?? null;
      recordIdentityProbe(c.connectionId, email); // email, or a DEFINITIVE no-email (probe succeeded)
      if (email) learned += 1;
    } catch {
      // Transient throw (network blip, 429, abort) — do NOT negative-cache, or a
      // one-off failure would permanently blind a real mailbox (no re-probe).
    }
  }));
  return learned;
}

/** Re-serve a conns array with any newly-learned identities filled in. */
function withEnrichedIdentities(conns: ConnectedToolkit[]): ConnectedToolkit[] {
  return conns.map((c) => {
    if (c.accountEmail) return c;
    const learned = cachedIdentityEmail(c.connectionId);
    return learned ? { ...c, accountEmail: learned } : c;
  });
}

// ─── Composio dispatch gateway ────────────────────────────────────────────────
// THE single front door for every Composio dispatch — chat (all brain lanes),
// workflow exact-call steps, Space sources/actions, batch, and background all
// resolve here. Owner (which connected account) is resolved FIRST — before
// sender constraints validate it and before CLI/SDK backend selection — and
// ambiguity or resolution failure returns a TYPED blocked result with zero
// CLI/SDK dispatch. Every block is ledgered (guardrail_tripped:composio_gateway).

export type ComposioGatewayBlockReason =
  | 'ambiguous-account'  // >1 distinct mailbox, no disambiguator → ASK
  | 'identity-absent'    // required/remembered mailbox no longer connected → ASK
  | 'constraint'         // standing-rule block (sender mismatch etc.)
  | 'suppressed'         // suppression policy blocked the only route
  | 'invalid-args'       // provably-incomplete args (schema/heuristic gate)
  | 'not-connected';     // toolkit provably dead (breaker + zero usable connections)

export interface ComposioGatewayBlocked {
  ok: false;
  reason: ComposioGatewayBlockReason;
  /** Deterministic model/user-facing corrective (the ASK / reconnect guidance). */
  message: string;
  toolkit: string;
  candidates?: Array<{ email?: string; connectionId: string }>;
}

export interface ComposioGatewayResolved {
  ok: true;
  /** Args with inline connection junk normalized + meta-args stripped. */
  args: Record<string, unknown>;
  /** The resolved owner connection — undefined = defer to composio's default entity. */
  connectionId?: string;
  /** Normalized mailbox identity of the owner, when known. */
  identity?: string;
  /** True when a standing sender rule verified the route (surface the sender-verify note). */
  senderVerified: boolean;
  /** Human-readable route notes to append to the tool output. */
  notes: string[];
}

export type ComposioGatewayResolution = ComposioGatewayResolved | ComposioGatewayBlocked;

function emitComposioGatewayBlock(
  sessionId: string | undefined,
  toolSlug: string,
  reason: ComposioGatewayBlockReason,
  extra?: Record<string, unknown>,
): void {
  try {
    if (!sessionId) return;
    appendEvent({
      sessionId,
      turn: 0,
      role: 'tool',
      type: 'guardrail_tripped',
      data: { guardrail: 'composio_gateway', reason, toolSlug, toolkit: toolkitOfSlug(toolSlug), ...extra },
    });
  } catch { /* ledger write must never break the block path */ }
}

export interface ComposioGatewayOptions {
  sessionId?: string;
  /** Latest user input, for standing calendar-read routing. */
  userInput?: string;
  /** Caller-supplied mailbox preference (email) — wins over recall. */
  preferredIdentity?: string;
}

// One-shot suppression revalidation: the pre-gateway user-routing bug (querying
// under the wrong Composio user_id) MANUFACTURED entity-mismatch failures, and
// their suppressions bench healthy connections for 7-30 days. Routing is fixed,
// so entity-mismatch entries recorded before this build are presumed
// bug-artifacts and dropped ONCE (a genuinely-mismatched connection re-records
// within one call). Real OAuth expiry ('expired') suppressions are kept.
// v2: re-cleared after the OWNER-PAIR dispatch fix (dispatch userId = the
// entity that owns the pinned connection) — v1-era dispatches could still
// record artifact mismatches between the identity fix and the owner-pair fix.
let suppressionsRevalidated = false;
function revalidateStaleSuppressionsOnce(): void {
  if (suppressionsRevalidated) return;
  suppressionsRevalidated = true;
  try {
    const stateDir = path.join(BASE_DIR, 'state');
    const marker = path.join(stateDir, 'composio-suppressions-revalidated-v2');
    if (existsSync(marker)) return;
    const state = readComposioConnectionSuppressionState() as unknown as ComposioConnectionSuppressionState;
    const entries = state.suppressedConnections ?? {};
    let changed = false;
    for (const [id, rec] of Object.entries(entries)) {
      if (rec.reason === 'entity-mismatch') {
        delete entries[id];
        changed = true;
      }
    }
    if (changed) {
      saveComposioConnectionSuppressionState(state as unknown as Parameters<typeof saveComposioConnectionSuppressionState>[0]);
    }
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(marker, `${new Date().toISOString()}\n`, 'utf-8');
  } catch { /* best-effort — revalidation must never break a dispatch */ }
}

/**
 * Stages: normalize pin → breaker (verified-dead only) → owner resolution
 * (pin > standing calendar route > rule-owned send (constraint stage resolves,
 * probe-verified) > identity: preferred/recalled email > single distinct
 * mailbox) → constraint validation of the owner → suppression policy →
 * arg validation. Pure resolution: NO dispatch happens here.
 */
export async function resolveComposioDispatch(
  toolSlug: string,
  rawArgs: Record<string, unknown>,
  connectedAccountId: string | undefined,
  opts: ComposioGatewayOptions = {},
): Promise<ComposioGatewayResolution> {
  revalidateStaleSuppressionsOnce();
  const toolkit = toolkitOfSlug(toolSlug);
  const normalized = normalizeInlineConnectedAccountId(rawArgs, connectedAccountId);
  let args = normalized.args;
  const pinned = normalized.connectedAccountId;
  const sid = opts.sessionId;
  const notes: string[] = [];

  // `account_alias` meta-arg (never reaches the provider): WITH a pinned
  // connection it is the "remember this one by name" gesture; alone it means
  // "use the account I named" and resolves through the alias store.
  const aliasArg = typeof (args as Record<string, unknown>).account_alias === 'string'
    ? String((args as Record<string, unknown>).account_alias).trim()
    : undefined;
  delete (args as Record<string, unknown>).account_alias;

  // One SWR snapshot reused by every stage below (breaker verify + identity).
  let conns: ConnectedToolkit[] = [];
  try { conns = await listUsableConnectedToolkits(); } catch { conns = []; }
  const toolkitConns = conns.filter((c) => {
    const s = (c.slug ?? '').toLowerCase();
    const t = toolSlug.toLowerCase();
    return s && (t === s || t.startsWith(`${s}_`));
  });
  const usable = toolkitConns.filter((c) => /active|enabled|initiat/i.test(c.status ?? ''));

  // Breaker — SHARPLY NARROWED: only when this session already saw a
  // reconnect-required failure for the toolkit AND the current snapshot
  // confirms zero usable connections (provably dead). A reconnect (snapshot
  // shows a usable connection again) disarms it without waiting for TTL.
  if (!pinned && usable.length === 0 && reconnectBreakerTripped(sid, toolSlug)) {
    const message = `⚠️ ${toolkit} is not connected (a call already failed this session with "no connected account", and no usable ${toolkit} connection exists right now). Not retrying — reconnect ${toolkit} in Connect first, then try again. Tell the user rather than re-calling ${toolkit} tools.`;
    emitComposioGatewayBlock(sid, toolSlug, 'not-connected');
    return { ok: false, reason: 'not-connected', message, toolkit };
  }

  // OWNER RESOLUTION (before constraints validate it, before backend selection).
  let owner = pinned;
  let identity: string | undefined;

  // "Remember this one by name": pin + alias → bind the name to the pinned
  // connection's stable identity (probing its profile once if the email isn't
  // known yet) so future calls resolve by name with no ask.
  if (owner && aliasArg) {
    let email = cachedIdentityEmail(owner) ?? usable.find((c) => c.connectionId === owner)?.accountEmail;
    if (!email && PROFILE_SLUG_BY_TOOLKIT[toolkit] && !identityProbeAttempted(owner)) {
      try {
        // Same failure-envelope guard as enrichToolkitIdentities: never bind an
        // alias to an email scavenged from an error payload.
        const profile = await executeComposioTool(PROFILE_SLUG_BY_TOOLKIT[toolkit], { user_id: 'me' }, owner);
        if (!detectComposioFailure(profile).failed) {
          email = extractMailboxEmails(profile, { structuredOnly: true })[0];
          recordIdentityProbe(owner, email ?? null);
        }
      } catch { /* transient — don't negative-cache; the alias still saves by connectionId */ }
    }
    const saved = rememberAccountAlias({ toolkit, label: aliasArg, email, connectionId: owner });
    if (saved) {
      identity = saved.email ?? identity;
      notes.push(`[account-memory] Saved: "${saved.label}" is your ${toolkit} account${saved.email ? ` ${saved.email}` : ''}. Future calls can pass account_alias:"${saved.label}" — no need to ask again.`);
    }
  }

  // "Use the account I named": alias alone resolves through the alias store —
  // by stable email when known, else by its last-known live connection. A raw
  // EMAIL is accepted directly as the identity hint (the model often knows the
  // address from a memory fact before a name binding exists).
  let aliasHint: string | undefined;
  if (!owner && aliasArg) {
    if (aliasArg.includes('@')) {
      aliasHint = aliasArg.toLowerCase();
    } else {
      const alias = resolveAccountAlias(aliasArg, toolkit);
      if (alias?.email) {
        aliasHint = alias.email;
      } else if (alias?.connectionId && usable.some((c) => c.connectionId === alias.connectionId)) {
        owner = alias.connectionId;
        notes.push(`[account-route] Routed to your saved "${alias.label}" ${toolkit} account.`);
      } else {
        notes.push(`[account-memory] No saved ${toolkit} account named "${aliasArg}" — resolving normally. To save it: re-call with connected_account_id + account_alias.`);
      }
    }
  }

  if (!owner) {
    const calendarRoute = findOutlookCalendarReadConstraint(toolSlug, args, opts.userInput);
    if (calendarRoute) {
      owner = calendarRoute.routeConnectionId;
      notes.push(`[account-route] Routed Outlook calendar read to connection ${calendarRoute.routeConnectionId} from standing rule #${calendarRoute.constraint.id}.`);
    }
  }
  // A send governed by a standing sender rule is RULE-owned: the constraint
  // stage below resolves it probe-verified (snapshot emails can be stale/absent,
  // the profile probe is authoritative) — so identity resolution must not
  // pre-block it. Everything else resolves by identity here.
  const ruleOwnedSend = !owner && isIrreversibleSendSlug(toolSlug) && Boolean(findEmailSendConstraint(toolSlug, args));
  if (!owner && !ruleOwnedSend) {
    const hint = opts.preferredIdentity ?? aliasHint ?? recallComposioAccountIdentity(toolSlug);
    let outcome = selectToolkitConnection(toolSlug, conns, hint);
    if (outcome.kind === 'ambiguous' || outcome.kind === 'identity-absent') {
      // Identity enrichment before blocking: probe unidentified candidates ONCE
      // (cached durably) — same-mailbox re-auths then merge, and a named/
      // recalled mailbox can match. Only then is a residual ambiguity real.
      const learned = await enrichToolkitIdentities(toolkit, usable);
      if (learned > 0) {
        conns = withEnrichedIdentities(conns);
        outcome = selectToolkitConnection(toolSlug, conns, hint);
      }
    }
    if (outcome.kind === 'resolved') {
      owner = outcome.connectionId;
      identity = outcome.identity;
      if (hint && outcome.identity === hint) {
        const label = aliasLabelFor(toolkit, hint);
        notes.push(`[account-route] Routed to your ${label ? `"${label}" (${hint})` : `remembered ${hint}`} ${toolkit} account.`);
      }
    } else if (outcome.kind === 'ambiguous' || outcome.kind === 'identity-absent') {
      // Ambiguity → typed block for ALL operations (reads included: reading the
      // wrong mailbox produces confidently-wrong answers). Zero dispatch.
      const message = composioMultiAccountAskMessage(toolSlug, outcome);
      emitComposioGatewayBlock(sid, toolSlug, outcome.kind === 'ambiguous' ? 'ambiguous-account' : 'identity-absent', {
        candidates: outcome.candidates.map((c) => c.email ?? c.connectionId),
      });
      return {
        ok: false,
        reason: outcome.kind === 'ambiguous' ? 'ambiguous-account' : 'identity-absent',
        message,
        toolkit,
        candidates: outcome.candidates.map((c) => ({ email: c.email, connectionId: c.connectionId })),
      };
    }
    // 'defer' → owner stays undefined (composio default entity).
  }

  // CONSTRAINT VALIDATION of the resolved owner (sender rules verify the
  // mailbox by live profile probe; a rule route OVERRIDES the identity pick).
  const gate = await enforceStandingConstraints(toolSlug, args, owner);
  if (gate.block) {
    emitComposioGatewayBlock(sid, toolSlug, 'constraint');
    return { ok: false, reason: 'constraint', message: gate.block, toolkit };
  }
  let senderVerified = false;
  if (gate.routeConnectedAccountId) {
    owner = gate.routeConnectedAccountId;
    senderVerified = true;
  }

  // Suppression policy (skipped when the sender rule owns the route, as before).
  if (!gate.routeConnectedAccountId) {
    const route = applySuppressedComposioConnectionPolicy(
      toolSlug,
      owner,
      readComposioConnectionSuppressionState() as unknown as ComposioConnectionSuppressionState,
    );
    if (route.block) {
      emitComposioGatewayBlock(sid, toolSlug, 'suppressed');
      return { ok: false, reason: 'suppressed', message: route.block, toolkit };
    }
    owner = route.connectedAccountId;
    if (route.note) notes.push(route.note);
  }

  // SEND SAFETY NET: an irreversible send must NEVER dispatch with an unresolved
  // owner when multiple accounts exist — Composio's default entity would pick an
  // arbitrary mailbox (the 2026-06-11 wrong-mailbox incident class). This backs
  // up the paths that legitimately skip identity resolution: sender_override
  // without a pin, rule-owned sends the constraint stage couldn't route, and the
  // 'defer' fall-through. A wrong-account READ is recoverable and allowed to
  // defer; a wrong-account SEND is not.
  if (!owner && isIrreversibleSendSlug(toolSlug) && usable.length > 1) {
    const outcome = selectToolkitConnection(toolSlug, conns);
    if (outcome.kind === 'resolved') {
      owner = outcome.connectionId; // one distinct mailbox (e.g. duplicate re-auths) — safe
    } else {
      const candidates = outcome.kind === 'ambiguous' || outcome.kind === 'identity-absent'
        ? outcome.candidates
        : usable.map((c) => ({ email: c.accountEmail, connectionId: c.connectionId, wordId: c.wordId }));
      const message = composioMultiAccountAskMessage(toolSlug, { kind: 'ambiguous', candidates });
      emitComposioGatewayBlock(sid, toolSlug, 'ambiguous-account', {
        candidates: candidates.map((c) => c.email ?? c.connectionId),
        guard: 'send-safety-net',
      });
      return {
        ok: false,
        reason: 'ambiguous-account',
        message,
        toolkit,
        candidates: candidates.map((c) => ({ email: c.email, connectionId: c.connectionId })),
      };
    }
  }

  // Arg validation — provably-incomplete args never dispatch (any path).
  const validation = validateComposioArgs(toolSlug, args, getCachedToolSchema(toolSlug));
  if (validation.error) {
    const message = formatBatchValidationError(validation.error, toolSlug, validation.mode);
    emitComposioGatewayBlock(sid, toolSlug, 'invalid-args', {
      mode: validation.mode,
      field: validation.error.field,
      validationReason: validation.error.reason,
    });
    return { ok: false, reason: 'invalid-args', message, toolkit };
  }

  return { ok: true, args, connectionId: owner, identity, senderVerified, notes };
}

/**
 * One-shot gateway dispatch for non-chat paths (workflow exact-call steps,
 * Space sources/actions, batch/background helpers): resolve through the SAME
 * gateway, return the typed block untouched, otherwise dispatch exactly once.
 */
export async function dispatchComposioTool(
  toolSlug: string,
  args: Record<string, unknown>,
  opts: ComposioGatewayOptions & { connectedAccountId?: string } = {},
): Promise<{ ok: true; result: unknown; connectionId?: string; identity?: string } | ComposioGatewayBlocked> {
  const resolved = await resolveComposioDispatch(toolSlug, args, opts.connectedAccountId, opts);
  if (!resolved.ok) return resolved;
  try {
    const result = await executeComposioTool(toolSlug, resolved.args, resolved.connectionId, resolved.identity);
    clearReconnectBreaker(opts.sessionId, toolSlug);
    return { ok: true, result, connectionId: resolved.connectionId, identity: resolved.identity };
  } catch (err) {
    if (isComposioReconnectRequiredError(err)) recordReconnectBreaker(opts.sessionId, toolSlug);
    throw err;
  }
}

async function runComposioExecute(
  toolSlug: string,
  args: Record<string, unknown>,
  connectedAccountId: string | undefined,
  options: FormatComposioToolOutputOptions,
): Promise<string> {
  const runSid = sessionIdFromRunContext(options.context);

  // THE gateway: owner-first resolution + typed blocks (ledgered). A block is
  // returned verbatim as the tool output — deterministic, zero dispatch.
  const resolved = await resolveComposioDispatch(toolSlug, args, connectedAccountId, {
    sessionId: runSid,
    userInput: latestUserInputForContext(options.context),
  });
  if (!resolved.ok) return resolved.message;
  args = resolved.args;
  const effectiveConnectionId = resolved.connectionId;
  let accountRouteNote = resolved.notes.join('\n');
  const gate = { routeConnectedAccountId: resolved.senderVerified ? resolved.connectionId : undefined };

  // Tool-bound standing rules ride with EVERY call's output — the model
  // re-reads them at the moment it acts on this toolkit, independent of
  // whether memory recall surfaced them this turn.
  const constraintBanner = renderToolkitConstraintBanner(toolkitOfSlug(toolSlug));

  const recentErrors: string[] = [];
  let lastError: unknown;

  // Retry loop with exponential backoff for transient errors
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await executeComposioTool(toolSlug, args, effectiveConnectionId);
      let output = formatComposioExecuteOutput(result, { ...options, toolSlug });
      if (gate.routeConnectedAccountId) {
        output += `\n\n[sender-verify] Routed to connection ${gate.routeConnectedAccountId} — its mailbox verified against the standing sender rule.`;
      }
      if (accountRouteNote) output += `\n\n${accountRouteNote}`;
      if (constraintBanner) output += `\n${constraintBanner}`;
      const sid = runSid;
      // Capture the intent BEFORE auto-remember consumes (deletes) the session's
      // search entry — the fresh search query is the honest intent behind this execute.
      const executionIntent = executionIntentForSession(sid, toolSlug);
      maybeAutoRememberComposioChoice(toolSlug, args, result, sid, effectiveConnectionId);

      // PHASE 5: Record outcome for adaptive tool selection & learning
      const failure = detectComposioFailure(result);
      if (failure.failed) {
        output += suppressComposioConnectionAfterHardFailure(effectiveConnectionId, result);
        // F2: a not-connected RESULT (returned, not thrown) also trips the breaker.
        if (isComposioReconnectRequiredError(result)) recordReconnectBreaker(sid, toolSlug);
      } else {
        // F2: a genuine success proves the toolkit is reachable again → reset.
        clearReconnectBreaker(sid, toolSlug);
      }
      try {
        recordExecution({
          toolName: options.toolName || toolSlug,
          intent: executionIntent,
          succeeded: !failure.failed,
          errorType: failure.failed ? (failure.notFound ? 'not_found' : 'unknown') : undefined,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Outcome recording failure must never break tool execution
      }

      // ASYNC job-receipt awareness: a call can SUCCEED but only return a QUEUED
      // RECEIPT (a DataForSEO task id, an Apify run handle) — NOT the result. Make
      // that explicit with an id-bearing poll directive so the model fetches the
      // real result instead of mistaking the receipt for the answer. Shape-detected;
      // inert on a normal result. Kill-switch CLEMMY_COMPOSIO_ASYNC_RESOLVE.
      if (!failure.failed && composioAsyncResolveEnabled()) {
        const receipt = detectJobReceipt(toolSlug, result);
        if (receipt) {
          // For the one UNAMBIGUOUS case (an Apify async run), the harness polls to
          // completion itself and returns the REAL output — the model never has to
          // know it was async. Any other family / a poll overrun falls back to the
          // id-bearing corrective (never worse than model-driven). Bounded latency.
          // parkAvailable = we have an origin session to report a parked result back
          // to. When true the inline poll caps SHORT and overflow parks (turn keeps
          // moving); when false it blocks the full budget (better than losing the result).
          const poll = await autoPollJob(
            receipt,
            (slug, a) => executeComposioTool(slug, a, effectiveConnectionId),
            { parkAvailable: Boolean(sid) },
          );
          const reason = poll.reason ?? '';
          if (poll.resolved) {
            const n = asyncResultItemCount(poll.result);
            // Requested-vs-returned nudge: a "SUCCEEDED but only 40 of the 100 you wanted"
            // partial scrape must NOT silently read as complete. We can't know the requested
            // count generically, so surface the returned count + tell her to verify it.
            const countNote = n !== null
              ? ` It returned ${n} item${n === 1 ? '' : 's'} — VERIFY this matches how many you asked for; if it's short, the run under-delivered (partial scrape) — do not treat a partial as complete.`
              : '';
            output = `${formatComposioExecuteOutput(poll.result, { ...options, toolSlug })}\n\n[auto-resolved] Polled the ${receipt.family} job (${poll.polls} check${poll.polls === 1 ? '' : 's'}) and fetched the real result — this IS the final output.${countNote}`;
          } else if (/^run\s+(FAILED|ABORTED|TIMED)/i.test(reason)) {
            // The run TERMINALLY FAILED — do NOT steer her to keep polling a dead run.
            output = `⚠️ The ${receipt.family} run ${receipt.jobId} ${reason.replace(/^run\s+/i, '')} — it did NOT produce results. Do NOT poll it again. Start a FRESH run (re-invoke the actor, optionally with a smaller scope) or report the failure (with the run id) to the user.\n\n${output}`;
          } else {
            // Not resolved inline: a genuinely-long Apify run (budget-exceeded) or a
            // family whose result-getter needs a live lookup (DataForSEO/Firecrawl,
            // reason 'family-not-auto-pollable'). If this family HAS a poll recipe and
            // we have an origin session to report back to, hand it to the background
            // job-watcher — it polls deterministically to completion and delivers the
            // REAL result to this conversation, so the model never grinds manual polls.
            // Parking is FAIL-OPEN: any miss (flag off, no session, error) keeps the
            // id-bearing banner (never worse than today).
            // Park ONLY when the job is genuinely pollable-but-not-inline: a long
            // Apify run (budget-exceeded, always has its ids) or a family whose
            // getter needs a live lookup (DataForSEO/Firecrawl → 'family-not-auto-
            // pollable' WITH a poll recipe). A missing-ids Apify, a transient
            // poll error, or auto-poll disabled keeps the immediate banner.
            const hasPollRecipe = Boolean(recipeFor(receipt.family)?.poll);
            const shouldPark = reason === 'budget-exceeded'
              || (reason === 'family-not-auto-pollable' && hasPollRecipe);
            let parked: ReturnType<typeof parkComposioJob> = null;
            if (sid && shouldPark) {
              try {
                // Park only if the result-getter actually RESOLVES (review
                // finding: a DataForSEO endpoint with no matching *_TASK_GET*
                // would otherwise sit in the watcher heartbeating for 60min
                // before blocking — the banner is more honest). The resolved
                // slug rides into the record so the watcher never re-discovers.
                const plan = await resolveJobGetter(receipt, (slug, a) => executeComposioTool(slug, a, effectiveConnectionId));
                if (plan) {
                  parked = parkComposioJob(
                    {
                      ...receipt,
                      ...(plan.getterSlug ? { getterSlug: plan.getterSlug } : {}),
                      ...(plan.idArg ? { idArg: plan.idArg } : {}),
                    } as typeof receipt,
                    { toolSlug, connectionId: effectiveConnectionId, originSessionId: sid },
                  );
                }
              } catch {
                parked = null; // fail-open to the banner
              }
            }
            if (parked) {
              const verb = parked.deduped ? 'is already being watched as' : 'is now handled by';
              output = `⏳ This ${receipt.family} job (id "${receipt.jobId}") ${verb} background task ${parked.taskId}. The harness will poll it to completion and report the REAL result back to this conversation automatically — do NOT poll it yourself or wait here. Continue with other work; the finished output will arrive as a background-task completion.\n\n${output}`;
            } else if (reason === 'budget-exceeded') {
              // No session / parking off — steer to backgrounding rather than grinding
              // manual polls in-chat with no wait primitive.
              output = formatComposioBudgetExceededOutput(receipt, output, options.context);
            } else {
              output = `${asyncReceiptBanner(receipt)}\n\n${output}`;
            }
            // Observability for the family-agnostic detector: emit only when the
            // GENERIC shape-detector fired (never for the known families), so a spike
            // of these on normal completes is a visible false-positive signal. A
            // generic receipt always reaches this else (it is never inline-resolved).
            if (receipt.generic) {
              recordOperationalEvent({
                source: 'tool',
                type: 'composio_async_generic_detected',
                severity: 'info',
                sessionId: sid,
                payload: {
                  slug: toolSlug,
                  toolkit: toolkitOfSlug(toolSlug),
                  jobId: receipt.jobId,
                  status: receipt.status,
                  outcome: parked ? 'parked' : 'banner',
                },
              });
            }
          }
        }
      }

      // Only count/advise on SUCCESS — a failed call isn't "an item processed".
      if (!failure.failed) {
        // P1-D — a schema/describe execute is DISCOVERY, not per-item work. Route
        // it to the discovery advisory (which counts repeated describes of one
        // toolkit) and skip the fan-out advisory so the two never double-fire on
        // the same call. All other executes keep the fan-out advisory unchanged.
        if (isDescribeSlug(toolSlug)) {
          const advisory = maybeDiscoveryAdvisory({
            kind: 'describe',
            toolkit: toolkitOfSlug(toolSlug),
            signature: describeSignature(toolSlug, args),
            sessionId: runScopeIdFromRunContext(options.context) ?? sid,
          });
          return advisory ? output + advisory : output;
        }
        const advisory = maybeFanoutAdvisory(
          toolSlug,
          args,
          runScopeIdFromRunContext(options.context) ?? sid,
          output,
        );
        if (advisory) return output + advisory;
      }
      return output;
    } catch (err) {
      lastError = err;
      const errorMsg = err instanceof Error ? err.message : String(err ?? '');
      recentErrors.push(errorMsg);

      // Entity/user mismatches and NoActiveConnection are deterministic. In
      // particular, do not spend the generic retry budget repeating a call
      // that can only be repaired by reconnecting the app under this user.
      if (isComposioReconnectRequiredError(err)) {
        recordReconnectBreaker(runSid, toolSlug); // F2: trip the cross-call breaker
        return composioThrownErrorOutput(err, { ...options, toolSlug })
          + suppressComposioConnectionAfterHardFailure(effectiveConnectionId, err);
      }

      // Check if we should retry
      const decision = shouldRetryToolCall(err, attempt, recentErrors);
      if (!decision.shouldRetry) {
        // Terminal error or circuit-breaker triggered: return error immediately
        return composioThrownErrorOutput(err, { ...options, toolSlug })
          + suppressComposioConnectionAfterHardFailure(effectiveConnectionId, err);
      }

      // Transient error: wait and retry
      if (attempt < 3) {
        await delayMs(decision.delayMs);
      }
    }
  }

  // Max retries exhausted: return last error
  return composioThrownErrorOutput(lastError, { ...options, toolSlug });
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
  const base = real
    ? `${tag} ${real} (Composio action: ${toolSlug})`
    : `${tag} Composio action ${toolSlug}. Call this directly when the fields are clear; use composio_list_tools first if you need to inspect the schema.`;
  // Tool-bound standing rules live IN the tool description: the model cannot
  // form a call to this tool without the rule in view, every single turn.
  const banner = renderToolkitConstraintBanner(toolkitSlug);
  return banner ? `${base}\n${banner}` : base;
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
  const connections = await listUsableConnectedToolkits();
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
      // Deposit the real schema for schema-grounded pre-dispatch validation.
      rememberToolSchema(toolSlug, toolkitTool.inputParameters);
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
    parameters: z.object(COMPOSIO_STATUS_PARAMS),
    execute: async (_input, context, details) => {
      const credentials = await getComposioRuntimeStatus();
      const connections = credentials.enabled ? await listUsableConnectedToolkits() : [];
      const suppressedConnections = credentials.enabled ? await listSuppressedConnectedToolkits() : [];
      return formatComposioToolOutput(
        buildComposioStatusPayload(credentials as unknown as Record<string, unknown>, connections, suppressedConnections),
        { context, details, toolName: 'composio_status' },
      );
    },
  });

  const composio_list_tools = tool({
    name: 'composio_list_tools',
    description: 'List available Composio tools for one connected toolkit slug, such as gmail, slack, notion, github, or googlecalendar.',
    parameters: z.object(COMPOSIO_LIST_TOOLS_PARAMS),
    execute: async ({ toolkit_slug, limit }, context, details) => {
      const tools = await listComposioToolkitTools(toolkit_slug, limit ?? 80);
      // Deposit real schemas — upgrades pre-dispatch validation to
      // schema-grounded for every listed action (self-healing loop).
      for (const item of tools) rememberToolSchema(item.slug, item.inputParameters);
      const output = formatComposioToolOutput({
        toolkit: toolkit_slug,
        count: tools.length,
        tools: tools.map((item) => ({
          slug: item.slug,
          name: item.name,
          description: item.description,
          inputParameters: item.inputParameters,
        })),
      }, { context, details, toolName: 'composio_list_tools' });
      // P1-D — a list counts toward the toolkit's discovery FIND lane.
      const advisory = maybeDiscoveryAdvisory({
        kind: 'list',
        toolkit: toolkit_slug,
        signature: `list ${toolkit_slug}`,
        sessionId: runScopeIdFromRunContext(context) ?? sessionIdFromRunContext(context),
      });
      return advisory ? output + advisory : output;
    },
  });

  const composio_search_tools = tool({
    name: 'composio_search_tools',
    description: 'Search Composio for the right action slug. Use this BEFORE concluding an action is unavailable — Composio exposes hundreds of actions per toolkit and Clementine intentionally does not inject every action schema into every call. Query with plain English ("outlook list unread messages today", "drive search by name", "gmail mark as read"). Returns slugs to pass to `composio_execute_tool`.',
    parameters: z.object(COMPOSIO_SEARCH_TOOLS_PARAMS),
    execute: async ({ query, toolkit_slug, limit }, context, details) => {
      // Searching is exposure/uncertainty, never evidence of failure. The old
      // path auto-invalidated an exact memo simply because the model searched
      // again, creating churn and relearning loops. Only a real execute outcome
      // may change confidence or invalidate a procedure.
      // DISCOVERY-TAX short-circuit (2026-07-08): a task family that has run many
      // times (facebook scrape → sheets) re-ran composio_search_tools 4-5× across
      // toolkits (~2 min) even though tool-choice memory already held the proven
      // slug — recall missed because auto-remember fragments intents by search
      // query. Consult the store FIRST: on a confident remembered match, return the
      // slug(s) instantly with a "remembered from N successes" note and SKIP the
      // live toolkit discovery entirely (zero network). Only for a general (no
      // explicit toolkit) search — a targeted toolkit lookup is deliberate. Search
      // still runs when there's no confident memory. Kill-switch:
      // CLEMMY_COMPOSIO_SEARCH_RECALL=off restores the always-discover behavior.
      if (!toolkit_slug && (process.env.CLEMMY_COMPOSIO_SEARCH_RECALL ?? 'on').toLowerCase() !== 'off') {
        try {
          const remembered = recallComposioForSearch(query);
          if (remembered.length > 0) {
            const sid = sessionIdFromRunContext(context);
            const useIdsBySlug: Record<string, string> = {};
            for (const match of remembered) {
              if (!match.procedureId) continue;
              recordToolProcedureImpression(match.procedureId);
              const use = beginToolProcedureUseById(match.procedureId, match.intent, sid);
              if (use) useIdsBySlug[match.slug] = use.useId;
            }
            // Carry exact procedure-use IDs to the following execute without
            // teaching this query as another physical procedure/alias.
            noteComposioSearchIntent(
              sid,
              query,
              remembered.map((match) => match.slug),
              { fromMemory: true, useIdsBySlug },
            );
            return formatComposioToolOutput({
              configured: true,
              query,
              fromMemory: true,
              count: remembered.length,
              matches: remembered.map((m) => ({
                toolkit: m.slug.split('_')[0]?.toLowerCase() ?? '',
                slug: m.slug,
                name: m.slug,
                score: 1,
                description: `Remembered from ${m.successCount} prior success${m.successCount === 1 ? '' : 'es'} on this machine (matched intent "${m.intent}"). Call composio_execute_tool with this slug — no rediscovery needed.${m.invocationTemplate ? ` Prior args template: ${m.invocationTemplate.slice(0, 400)}` : ''}`,
              })),
              message:
                `Matched ${remembered.length} tool(s) from tool-choice memory — skipped Composio discovery (saved a multi-call search). ` +
                'If a remembered slug fails on execute, call composio_search_tools again with a more specific query, or tool_choice_invalidate to force fresh discovery.',
            }, { context, details, toolName: 'composio_search_tools' });
          }
        } catch { /* memory consult is best-effort — fall through to live search */ }
      }

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
      const allConnections = await listUsableConnectedToolkits();
      // Cold-start nudge: a configured key with ZERO connected apps returns a
      // guidance-free empty result that the model reads as "no such tool".
      // Say what's actually wrong and how to fix it. (Skipped when an explicit
      // toolkit_slug was given — that's a deliberate targeted lookup.)
      if (allConnections.length === 0 && !toolkit_slug) {
        return formatComposioToolOutput({
          configured: true,
          connectedToolkits: [],
          query,
          count: 0,
          matches: [],
          message:
            'Composio is configured, but NO apps are connected yet — so there are no toolkits to search. ' +
            'A tool only becomes searchable after its app is connected. Connect the app you need from the ' +
            'dashboard (Integrations → connect), then retry. Do not conclude the capability is unavailable.',
          nextStep:
            'Tell the user which app to connect (or point them to the dashboard Integrations page), then retry ' +
            'composio_search_tools once it is connected.',
        }, { context, details, toolName: 'composio_search_tools' });
      }
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
          // Deposit real schemas — upgrades pre-dispatch validation to
          // schema-grounded for every searched action (self-healing loop).
          rememberToolSchema(item.slug, item.inputParameters);
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
      // (A) v0.5.64 — record this discovery query AND the candidate slugs it
      // surfaced, so a following successful execute only auto-remembers a slug
      // the search actually returned (see maybeAutoRememberComposioChoice). This
      // is what prevents an unrelated fallback from poisoning the intent.
      noteComposioSearchIntent(
        sessionIdFromRunContext(context),
        query,
        matches.filter((m) => m.slug && m.slug !== '__toolkit_error__').map((m) => m.slug),
      );
      // Empty-with-connections: the query matched nothing in the CONNECTED
      // toolkits. One bounded catalog check tells the user whether the app they
      // want is supported-but-unconnected (the common cold-start confusion)
      // instead of letting an empty result read as "no such capability".
      const realMatchCount = matches.filter(
        (m) => m.slug && m.slug !== '__toolkit_error__' && m.score > 0,
      ).length;
      let unconnectedHint: string | undefined;
      if (realMatchCount === 0 && !toolkit_slug) {
        try {
          const connectedSlugs = new Set(allConnections.map((c) => c.slug));
          const supported = (await listAllToolkits())
            .filter((tk) => !connectedSlugs.has(tk.slug))
            .filter((tk) => {
              const hay = `${tk.slug} ${tk.name ?? ''}`.toLowerCase();
              return queryTerms.some((term) => term.length >= 3 && hay.includes(term));
            })
            .slice(0, 5)
            .map((tk) => tk.name ?? tk.slug);
          if (supported.length > 0) {
            unconnectedHint =
              `No CONNECTED toolkit matched "${query}". These supported apps look relevant but are NOT connected yet: ` +
              `${supported.join(', ')}. Connect one from the dashboard (Integrations) and retry — don't conclude it's unavailable.`;
          }
        } catch { /* best-effort hint — a catalog hiccup must never break search */ }
      }
      let output = formatComposioToolOutput({
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
        totalMatches: matches.length,
        ...(matches.length > maxResults
          ? { truncatedNote: `Showing the top ${maxResults} of ${matches.length} ranked matches — if the tool you need isn't listed, narrow the query or pass toolkit_slug.` }
          : {}),
        matches: matches.slice(0, maxResults),
        ...(unconnectedHint ? { message: unconnectedHint } : {}),
        nextStep: 'Pick the best match, then call `composio_execute_tool` with `tool_slug` set to the exact slug from this result and `arguments` as a JSON object string built from the action\'s `inputParameters` schema.',
      }, { context, details, toolName: 'composio_search_tools' });
      // Tool-bound standing rules surface at DISCOVERY time — the moment the
      // model picks a slug, right before it forms the execute call.
      const matchedToolkits = new Set(
        matches
          .filter((m) => m.slug !== '__toolkit_error__')
          .map((m) => (m.toolkit ?? '').toLowerCase())
          .filter(Boolean),
      );
      let constraintBanners = '';
      for (const toolkit of matchedToolkits) {
        const banner = renderToolkitConstraintBanner(toolkit);
        if (banner) constraintBanners += `\n${banner}`;
      }
      if (constraintBanners) output += constraintBanners;
      // P1-D — catch the search-loop: repeated overlapping searches of one
      // toolkit (the 2026-06-04 Google Sheets ×4 thrash) get nudged to commit.
      const advisory = maybeDiscoveryAdvisory({
        kind: 'search',
        toolkit: toolkit_slug ?? matches.find((m) => m.slug !== '__toolkit_error__')?.toolkit ?? '*',
        signature: query,
        sessionId: runScopeIdFromRunContext(context) ?? sessionIdFromRunContext(context),
      });
      return advisory ? output + advisory : output;
    },
  });

  const composio_execute_tool = tool({
    name: 'composio_execute_tool',
    description: 'Execute any Composio action by exact slug (Outlook list-mail, Gmail search, Drive search, Salesforce query, etc.). Never invent slugs — always call `composio_search_tools` first with a plain-English query, then pass the returned slug here. Arguments must be a JSON object string. Uses the connected OAuth account and approval policy.',
    parameters: z.object(COMPOSIO_EXECUTE_TOOL_PARAMS),
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

      // Standing-constraint enforcement (incl. the hard sender gate) lives in
      // runComposioExecute so the dynamic cx_* tool path is covered too.

      // Pre-dispatch arg validation lives in runComposioExecute (schema-
      // grounded when cached, heuristic fallback) so the dynamic cx_*
      // path gets identical coverage.
      return runComposioExecute(tool_slug, parsedArgs, connected_account_id ?? undefined, {
        context,
        details,
        toolName: 'composio_execute_tool',
      });
    },
  });

  return [composio_status, composio_search_tools, composio_list_tools, composio_execute_tool];
}
