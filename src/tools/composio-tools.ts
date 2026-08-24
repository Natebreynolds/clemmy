import { readHarnessCapabilityHealth, recordHarnessCapabilityHealth } from '../runtime/harness/capability-health.js';
import { hasActiveStructuralProcedureForIdentifier } from '../memory/procedure-receipts.js';
import { settleVerifiedComposioRead } from './composio-read-settlement.js';
import { createHash } from 'node:crypto';

import {
  describeCarrierRefusal,
  normalizeComposioArgsPayload,
} from './composio-carrier.js';
import { existsSync, writeFileSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tool, type Tool } from '@openai/agents';
import { BASE_DIR, getRuntimeEnv } from '../config.js';
import { z } from 'zod';
import type { RuntimeContextValue } from '../types.js';
import { needsApprovalFromTaxonomy } from '../agents/tool-taxonomy.js';
import {
  executeComposioTool,
  executePreparedComposioTool,
  prepareComposioOneShotDispatch,
  composioCliErrorProvesNoDispatch,
  composioExecutionUsesCliOnlyLane,
  CURATED_TOOLKITS,
  getComposioCredentialStatus,
  getComposioExecutionBackend,
  getComposioRuntimeStatus,
  searchComposioToolsViaCli,
  composioToolSchemaObservedAt,
  composioToolOperationVersion,
  ComposioSearchProviderContractError,
  COMPOSIO_LIVE_SEARCH_OVERSAMPLE_LIMIT,
  COMPOSIO_LIVE_SEARCH_RETURN_LIMIT,
  listCachedToolkits,
  listComposioToolkitTools,
  searchConnectedComposioTools,
  listUsableConnectedToolkits,
  peekCurrentConnectedToolkits,
  peekCurrentComposioCliExecutionStatus,
  filterSuppressedConnectedToolkits,
  listSuppressedConnectedToolkits,
  isComposioReconnectRequiredError,
  readComposioConnectionSuppressionState,
  saveComposioConnectionSuppressionState,
  listAllToolkits,
  selectToolkitConnection,
  type ConnectedToolkit,
  type PreparedComposioOneShotDispatch,
} from '../integrations/composio/client.js';
import { isIrreversibleSendSlug } from '../runtime/harness/execution-gate.js';
import {
  irreversibleSendRequiresExplicitTarget,
  validateIrreversibleSendPayload,
} from '../runtime/harness/grounding-gate.js';
import { recallComposioAccountIdentity } from '../memory/tool-choice-store.js';
import { detectJobReceipt, asyncReceiptBanner, type JobReceipt } from '../integrations/composio/async-job.js';
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
import { maybeDiscoveryAdvisory, isDescribeSlug, describeSignature } from '../runtime/harness/discovery-advisory.js';
import { discoveryGovernor } from '../runtime/harness/discovery-governor.js';
import {
  settleToolAttempt,
  ToolAttemptSettlementAuthorityError,
} from '../runtime/harness/attempt-settlement.js';
import {
  authorizeResolvedLogicalCallContract,
  currentLogicalCall,
  PhysicalDispatchPreDispatchError,
  withLogicalToolCall,
  withPhysicalDispatch,
} from '../runtime/harness/attempt-identity.js';
import { attestTerminalPhysicalDispatchOwner } from '../runtime/harness/terminal-physical-dispatch-owner.js';
import { trustedRuntimeEffectCarrier } from '../runtime/harness/tool-effect.js';
import { toolOutputContextStorage } from '../runtime/harness/tool-output-context.js';
import type { AttemptSignals } from '../runtime/harness/attempt-outcome.js';
import { classifyDiscoveryCall } from '../runtime/harness/discovery-boundary.js';
import { isTransientStepError } from '../execution/transient-error.js';
import { asyncJobTimeoutCorrective } from '../runtime/harness/tool-error-corrective.js';
import {
  checkConstraintViolation,
  formatConstraintEscalation,
  findEmailDraftAuthoringPreference,
  findEmailSendConstraint,
  findOutlookCalendarReadConstraint,
  renderToolkitConstraintBanner,
} from '../runtime/harness/constraint-guard.js';
import { resolveCompliantSenderConnection, extractMailboxEmails } from '../runtime/harness/sender-verify.js';
import { rememberAccountAlias, resolveAccountAlias, aliasLabelFor } from '../memory/account-alias-store.js';
import { cachedIdentityEmail, identityProbeAttempted, recordIdentityProbe } from '../integrations/composio/identity-cache.js';
import { validateComposioArgs, formatBatchValidationError, applyEmailRecipientAliases, repairUnambiguousFieldRename } from './composio-batch-validator.js';
import {
  rememberToolSchema,
  getCachedToolSchema,
  ensureToolSchema,
  liveComposioSchemaFingerprint,
  liveComposioOperationVersion,
} from './composio-schema-cache.js';
import {
  digestSchema,
  fingerprintSchema,
  saveToolContractExample,
} from './tool-contract-store.js';
import { appendEvent, listEvents } from '../runtime/harness/eventlog.js';
import { shouldRetryToolCall, delayMs } from '../runtime/harness/retry-handler.js';
import {
  classifyComposioActionConsequence,
  classifyComposioSlugEffect,
  composioSlugIsReadOnly,
} from '../integrations/composio/slug-effect.js';
import {
  documentedAtomicInputContentCommit,
  documentedComposioOperationSemantic,
} from '../integrations/composio/operation-semantics.js';
import { currentHostCallAttestation } from '../runtime/harness/accepted-turn-call-authority.js';
import { currentExpectedWorkBinding } from '../runtime/harness/expected-work-admission.js';
import { durableLogicalCallContract } from '../runtime/harness/logical-call-contract.js';
import {
  admitDocumentedCreateResultProjection,
  projectDocumentedCreateResult,
  type DocumentedCreateResultAdmission,
} from '../runtime/harness/documented-create-result-evidence.js';
import {
  compileGoogleSheetsSheetFromJsonContract,
  parseGoogleSheetsSheetFromJsonContract,
} from '../runtime/harness/sheet-from-json-content-contract.js';
import { suggestNextSteps, type FailureType as FallbackFailureType } from '../runtime/fallback-chain-store.js';
import { getCapabilitiesForIntent } from '../runtime/capability-registry.js';
import { recordExecution } from '../runtime/graceful-degradation-engine.js';
import {
  suppressConnectionAfterHardAuthFailure,
  type ComposioConnectionSuppressionState,
} from '../agents/composio-connection-suppression.js';
import { ExternalWritePreDispatchError, ExternalWritePreDispatchResult } from '../runtime/harness/external-write-admission.js';
import { getComposioCliDefaultAccountAuthority } from '../integrations/composio/cli-default-account-authority.js';
import { registeredToolkitOfSlug } from '../integrations/composio/toolkit-slug.js';
import { formatComposioCliDefaultReadAccountRoute } from '../integrations/composio/account-route.js';
import { normalizeProcedureAccountIdentity } from '../runtime/read-path/procedure-scope.js';

export { registeredToolkitOfSlug } from '../integrations/composio/toolkit-slug.js';

function trustedComposioPhysicalEffectCarrier(
  toolSlug: string,
  args: Record<string, unknown>,
) {
  return trustedRuntimeEffectCarrier('composio_execute_tool', {
    tool_slug: toolSlug,
    arguments: args,
  });
}

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
  // Some OpenAI-compatible providers encode an omitted optional string as
  // "". Accept it at the SDK boundary so normalizeOptionalToolkitSlug can
  // collapse it to null; rejecting before execute burns the one discovery
  // allowance without ever reaching a provider (observed on the GLM lane).
  toolkit_slug: z.string().nullable(),
  limit: z.number().int().positive().max(50).nullable(),
} satisfies z.ZodRawShape;

/** Some OpenAI-compatible providers serialize an optional JSON null as the
 * literal string "null"/"none". Those sentinel spellings are absence, not a
 * real Composio toolkit constraint; forwarding them as `--toolkits null`
 * turns a valid broad search into a false zero-match result. */
function normalizeOptionalToolkitSlug(value: string | null): string | null {
  const normalized = value?.trim() ?? '';
  return !normalized || /^(?:null|none|undefined)$/i.test(normalized)
    ? null
    : normalized;
}

export const COMPOSIO_EXECUTE_TOOL_PARAMS = {
  tool_slug: z.string().min(1),
  arguments: z.string().nullable(),
  connected_account_id: z.string().nullable(),
} satisfies z.ZodRawShape;

export interface ComposioCliSearchMatch {
  toolkit: string;
  slug: string;
  name: string;
  description?: string;
  score: number;
  inputParameters?: unknown;
}

type SuppressedConnectedToolkit = ConnectedToolkit & { suppression: { reason?: string; suppressUntil: string } };

// Composio slug effects live in integrations/composio/slug-effect.ts. Approval,
// retries, connection repair, and runtime guardrails all consume that one pure
// classifier so a provider action cannot change meaning between layers.

export interface FormatComposioToolOutputOptions {
  context?: unknown;
  details?: unknown;
  toolName?: string;
  maxChars?: number;
  /** The Composio action slug, when this output is a real tool execution.
   *  Used to make a failure corrective specific (`slug=…`). */
  toolSlug?: string;
  /** Immutable provider args when effect semantics require more authority than
   * the slug alone (kept out of user-facing formatting). */
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

export interface ComposioFailureVerdict {
  failed: boolean;
  summary: string;
  notFound: boolean;
  notConnected: boolean;
  /** Provider-neutral HTTP-shaped status used only after a provider adapter has
   *  reduced its own machine code. */
  providerStatus?: number;
  /** Original provider code retained for evidence/debugging. */
  providerCode?: number | string;
  /** True only when provider-owned machine fields prove rejection happened
   *  before the requested external effect was created. */
  provesNoCommit?: boolean;
}

/**
 * Reduce DataForSEO's nested task envelope before the generic Composio
 * envelope is interpreted. Composio reports the transport wrapper as
 * `successful:true`, while DataForSEO reports the actual task verdict inside
 * `data.tasks[*].status_code`. The outer flag is transport success, not
 * business success.
 *
 * Keep this adapter structural and deliberately narrow. Five-digit success
 * codes (20000/20100) remain successes; only a nested 4xxxx task code is a
 * failure. Two exact rejection codes observed at the provider boundary are
 * mapped into the shared attempt vocabulary:
 *   - 40501 Invalid Field -> HTTP-shaped 400, proven pre-effect rejection;
 *   - 40401 Task Not Found -> HTTP-shaped 404.
 */
function nestedDataForSeoFailure(value: Record<string, unknown>): Omit<ComposioFailureVerdict, 'failed' | 'notConnected'> | null {
  const data = isRecord(value.data) ? value.data : null;
  const tasks = data && Array.isArray(data.tasks) ? data.tasks : [];
  const failedTask = tasks
    .map((task) => isRecord(task) ? task : null)
    .find((task) => typeof task?.status_code === 'number'
      && task.status_code >= 40_000
      && task.status_code < 50_000);
  if (!failedTask) return null;

  const providerCode = failedTask.status_code as number;
  const statusMessage = typeof failedTask.status_message === 'string'
    ? failedTask.status_message.replace(/\s+/g, ' ').trim().slice(0, 240)
    : `provider task status ${providerCode}`;
  const notFound = providerCode === 40_401;
  const invalidFieldRejection = providerCode === 40_501
    && failedTask.result == null
    && (failedTask.result_count === undefined || failedTask.result_count === 0);
  return {
    summary: statusMessage,
    notFound,
    providerCode,
    ...(invalidFieldRejection ? { providerStatus: 400, provesNoCommit: true } : {}),
    ...(notFound ? { providerStatus: 404 } : {}),
  };
}

export function detectComposioFailure(value: unknown): ComposioFailureVerdict {
  const none = { failed: false, summary: '', notFound: false, notConnected: false } as const;
  if (!isRecord(value)) return { ...none };
  const nestedTaskFailure = nestedDataForSeoFailure(value);
  if (nestedTaskFailure) {
    return {
      failed: true,
      notConnected: false,
      ...nestedTaskFailure,
    };
  }
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

/** Canonical settlement projection. The raw provider payload remains intact in
 * `data`; only the transport-level verdict is corrected so the one settlement
 * reducer, receipts, and learning all observe the same failure. */
export function canonicalComposioSettlementResult(
  value: unknown,
  verdict: ComposioFailureVerdict = detectComposioFailure(value),
): unknown {
  if (!verdict.failed || verdict.providerCode === undefined || !isRecord(value)) return value;
  return {
    ...value,
    successful: false,
    error: verdict.summary,
    ...(verdict.providerStatus !== undefined ? { status: verdict.providerStatus } : {}),
    provider_error_code: verdict.providerCode,
    ...(verdict.provesNoCommit === true ? { provider_rejected_before_effect: true } : {}),
  };
}

/** A provider-returned failure envelope almost never proves a mutation did not commit.
 *
 * Even a structured 4xx, `notConnected`, or not-found result was produced on
 * the far side of our dispatch boundary. Providers can partially commit,
 * execute a downstream sub-call, or lose/replace the original response before
 * returning those shapes. Treating any of them as replay authority can
 * duplicate an external write.
 *
 * Local pre-dispatch refusals do not enter this function: the gateway returns
 * a typed block before the workflow receipt boundary, and thrown local
 * preflight failures are classified by composioDispatchErrorProvesNoCommit.
 * The sole exception is a provider adapter that recognizes an exact,
 * machine-readable pre-effect rejection code and verifies the task produced no
 * result. Generic provider prose and ordinary HTTP-looking fields remain
 * commit-ambiguous. */
export function composioFailureProvesNoCommit(value: unknown): boolean {
  return detectComposioFailure(value).provesNoCommit === true;
}

/** Narrow nominal thrown-error proof owned by trusted host/client code.
 * Provider-returned prose/JSON cannot forge either class; everything not
 * recognized here crossed an uncertain boundary and must park as ambiguous. */
export function composioDispatchErrorProvesNoCommit(error: unknown): boolean {
  return error instanceof ExternalWritePreDispatchError
    || composioCliErrorProvesNoDispatch(error);
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
 *  the header format (check-first regression review: evidenceLooksFailedOrBlocked
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
  // the toolkit. Resolve against the registered longest prefix so multiword
  // providers such as OneDrive never collapse to a generic "ONE".
  if (opts.notConnected) {
    const toolkit = opts.toolSlug
      ? registeredToolkitOfSlug(opts.toolSlug).toUpperCase()
      : 'this toolkit';
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
    // acme 44→4 / 'itr2' bug).
    return [
      `⚠️ ${label} FAILED${where}: ${summary}`,
      `An offset/page token must be the EXACT opaque value returned in a prior response's \`offset\` field — never a guessed one. Most likely your previous list call returned everything but its result was CLIPPED for size: the FULL payload is stored.`,
      `Do this: call \`recall_tool_result\` on your previous list call to get the COMPLETE set in one shot — do NOT pass a guessed offset. Only paginate if a prior response actually returned a verbatim \`offset\` token.`,
    ].join('\n');
  }
  // A HARNESS-AUTHORITY refusal is not a broken capability. The action is
  // fine; this call lacked permission/binding, so "use a different action or
  // tool" is exactly the wrong advice — following it sent a run hunting for
  // another modality (a browser workaround for a question one API read
  // answers) and then parking on the user (live 2026-08-12).
  if (/work_binding_required|work_contract|expected[- ]work|not bound to the frozen contract/i.test(summary)) {
    return [
      `⚠️ ${label} was not dispatched${where}: ${summary}`,
      'This is an AUTHORITY refusal, not a capability failure — the action itself is fine and switching tools will not help.',
      'Do ONE of these: (1) if this call is part of the accepted work, propose it through `work_call` with the requirement it satisfies; (2) if it is an irreversible send, get the user\'s approval first; (3) if you cannot resolve it, STOP and tell the user the exact blocker. Do NOT go looking for a different tool to do the same thing.',
    ].join('\n\n');
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
 * written before clipping, so recall_tool_result by call_id can
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
  const failure = detectComposioFailure(value);
  const { failed, summary, notFound, notConnected } = failure;
  if (!failed) return body; // success: the GLOBAL id-index (formatRecallableToolText) handles resource lists
  if (options.toolSlug && !composioSlugIsReadOnly(options.toolSlug)) {
    const label = options.toolName || 'composio_execute_tool';
    const where = ` (slug=${options.toolSlug})`;
    const toolkit = registeredToolkitOfSlug(options.toolSlug).toUpperCase();
    if (failure.provesNoCommit === true) {
      return [
        '[provider-dispatch:rejected]',
        `⚠️ ${label} FAILED${where}: ${summary}. The provider rejected this request before creating the requested external effect.`,
        'Do not repeat the same arguments. Correct them from the exact schema or choose another equivalent provider candidate already inside the confirmed source strategy.',
        body,
      ].join('\n\n');
    }
    return [
      '[provider-dispatch:uncertain]',
      `⚠️ ${label} ${notConnected ? 'NOT CONNECTED' : 'FAILED'}${where}: ${summary}. Dispatch may have started; the external change MAY already exist or be partial.`,
      'Do NOT repeat this mutation from the failure envelope. Verify with the matching list/get/search action and reuse or repair the existing resource. If verification is impossible, tell the user the outcome is uncertain.',
      ...(notConnected
        ? [`The connection also appears unavailable. Open Connect and reconnect ${toolkit} before further work, but reconnecting does not make replay of this unverified mutation safe.`]
        : []),
      body,
    ].join('\n\n');
  }
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
  if (
    options.toolSlug
    && !composioSlugIsReadOnly(options.toolSlug)
    && !composioDispatchErrorProvesNoCommit(err)
  ) {
    return composioUncertainMutationOutput(err, options);
  }
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

/** A remote mutation that threw after dispatch may already have committed.
 * Retrying it on a timeout/5xx can duplicate a document, message, event, or
 * record. Keep this corrective distinct from the read-safe transient copy: the
 * next action is verification/read-back, never blind replay. */
export function composioUncertainMutationOutput(
  err: unknown,
  options: FormatComposioToolOutputOptions = {},
): string {
  const rawMessage = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  const message = enrichComposioErrorMessage(err, rawMessage).replace(/\s+/g, ' ').trim();
  const label = options.toolName || 'composio_execute_tool';
  const where = options.toolSlug ? ` (slug=${options.toolSlug})` : '';
  const notConnected = COMPOSIO_NOT_CONNECTED_RE.test(message) || isComposioReconnectRequiredError(err);
  const toolkit = options.toolSlug ? registeredToolkitOfSlug(options.toolSlug).toUpperCase() : 'this toolkit';
  const body = formatComposioToolOutput({
    error: message || 'unknown provider error',
    toolSlug: options.toolSlug ?? null,
    dispatch: 'uncertain',
  }, options);
  return [
    '[provider-dispatch:uncertain]',
    `⚠️ ${label} ${notConnected ? 'NOT CONNECTED' : 'FAILED'}${where}: an ambiguous error returned after dispatch may have started. The external change MAY already exist.`,
    'Do NOT repeat this mutation. Verify with the matching list/get/search action and reuse or repair the existing resource. If verification is impossible, tell the user the outcome is uncertain.',
    ...(notConnected
      ? [`Open Connect and reconnect ${toolkit} before further work, but reconnecting does not make replay of this unverified mutation safe.`]
      : []),
    body,
  ].join('\n\n');
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
/**
 * Attribution belongs to the accepted TASK, not the conversation.
 *
 * Keyed by session alone, a search issued for one request could be credited to
 * the execution of the next one — two tasks in the same chat shared a single
 * slot, so the later task learned the earlier task's answer. The accepted user
 * sequence is the task identity everything else here already uses.
 */
export function composioSearchAttributionKey(
  sessionId: string,
  sourceUserSeq?: number,
): string {
  const seq = Number.isSafeInteger(sourceUserSeq) && (sourceUserSeq ?? 0) > 0
    ? sourceUserSeq
    : harnessRunContextStorage.getStore()?.sourceUserSeq;
  return Number.isSafeInteger(seq) && (seq ?? 0) > 0 ? `${sessionId}#${seq}` : sessionId;
}

interface ComposioSearchRecord {
  /** Distinguishes concurrent searches within one accepted task. */
  searchId: string;
  query: string;
  at: number;
  slugs?: string[];
  fromMemory?: boolean;
  useIdsBySlug?: Record<string, string>;
}

/** How many in-flight searches one accepted task may keep correlatable. */
const MAX_TRACKED_SEARCHES_PER_TASK = 8;

const lastComposioSearchBySession = new Map<string, ComposioSearchRecord[]>();

// F2 — cross-call reconnect breaker. 90870d8c stops the WITHIN-call retry, but the
// 15-call thrash was the MODEL re-calling composio_execute_tool for the same dead
// toolkit across separate runs (each with no connection resolved, so the
// connection-keyed suppression short-returned ''). Keyed by toolkit (not
// connectionId) so it fires even when nothing resolved. Once a toolkit has failed
// reconnect-required this session, later attempts short-circuit deterministically
// (no network) until a successful execute or a cache invalidation clears it.
/**
 * Ground truth appended to a NOT-CONNECTED failure (live 2026-08-04: an invite
 * blast parked on "no active Outlook connection" while the user's Connect
 * screen showed Outlook ACTIVE — the model relayed a jargon dead-end and the
 * user had to ask HOW to reconnect). The daemon can simply look: fetch the
 * account list FRESH and state what it says, so the model tells the user the
 * true story in plain words instead of guessing between "you never connected"
 * and "something in my session broke".
 */
let connectedToolkitsForGroundTruth: typeof listUsableConnectedToolkits = listUsableConnectedToolkits;
/** Test seam (ESM modules are frozen; mirrors setRuntimeStatusLoader). */
export function _setConnectedToolkitsLoaderForTests(loader: typeof listUsableConnectedToolkits | null): void {
  connectedToolkitsForGroundTruth = loader ?? listUsableConnectedToolkits;
}

export async function connectionGroundTruthNote(toolSlug: string): Promise<string> {
  try {
    const toolkit = registeredToolkitOfSlug(toolSlug).toUpperCase();
    const conns = await connectedToolkitsForGroundTruth({ requireFresh: true });
    const toolLower = toolSlug.toLowerCase();
    const matched = conns.filter((c) => c.slug && c.connectionId && toolLower.startsWith(c.slug.toLowerCase()));
    const active = matched.filter((c) => /active|enabled/i.test(c.status ?? ''));
    if (active.length > 0) {
      const who = active.map((c) => c.accountEmail || c.connectionId).slice(0, 3).join(', ');
      return `\n\n[connection-ground-truth] Composio DOES list an ACTIVE ${toolkit} connection (${who}), but executing under it failed with a connection error — the stored login has likely expired server-side even though the Connect screen shows Active. Tell the user in plain words: open the Connect screen (left sidebar), reconnect ${toolkit} even though it looks connected, then reply "continue" — the saved work resumes where it left off. Never describe this in API or lane terms.`;
    }
    return `\n\n[connection-ground-truth] Composio currently lists NO usable ${toolkit} connection for this assistant. Tell the user in plain words: open the Connect screen (left sidebar), connect ${toolkit}, then reply "continue" — the saved work resumes where it left off. Never describe this in API or lane terms.`;
  } catch {
    return ''; // the probe is best-effort; the base corrective still stands
  }
}

/** Execution-safe counterpart to connectionGroundTruthNote. The business
 * logical call may explain a returned connection failure only from the exact
 * current snapshot prepared before dispatch; it must never hide a fresh
 * account-list provider call after the main crossing. */
function preparedConnectionGroundTruthNote(toolSlug: string): string {
  try {
    const toolkit = registeredToolkitOfSlug(toolSlug).toUpperCase();
    const snapshot = peekCurrentConnectedToolkits();
    if (snapshot === null) {
      return `\n\n[connection-ground-truth] The prepared ${toolkit} account observation is no longer current. Refresh the Connect account/action definition, then reply "continue" — no hidden account refresh was attempted inside this call.`;
    }
    const conns = filterSuppressedConnectedToolkits(
      snapshot,
      readComposioConnectionSuppressionState(),
    );
    const toolLower = toolSlug.toLowerCase();
    const matched = conns.filter((connection) =>
      connection.slug
      && connection.connectionId
      && toolLower.startsWith(connection.slug.toLowerCase()));
    const active = matched.filter((connection) => /active|enabled/i.test(connection.status ?? ''));
    if (active.length > 0) {
      const who = active
        .map((connection) => connection.accountEmail || connection.connectionId)
        .slice(0, 3)
        .join(', ');
      return `\n\n[connection-ground-truth] The current prepared account observation lists an ACTIVE ${toolkit} connection (${who}), but this execution returned a connection error. Tell the user in plain words to reconnect ${toolkit} in Connect, then reply "continue". No hidden account refresh was attempted inside this call.`;
    }
    return `\n\n[connection-ground-truth] The current prepared account observation contains no usable ${toolkit} connection. Tell the user in plain words to connect ${toolkit} in Connect, then reply "continue". No hidden account refresh was attempted inside this call.`;
  } catch {
    return '';
  }
}

const RECONNECT_BREAKER_TTL_MS = 3 * 60 * 1000;
const reconnectBreakerBySession = new Map<string, number>();
type ComposioRuntimeStatus = Awaited<ReturnType<typeof getComposioRuntimeStatus>>;
let composioRuntimeStatusLoader: () => Promise<ComposioRuntimeStatus> = getComposioRuntimeStatus;

function reconnectBreakerEnabled(): boolean {
  return (process.env.CLEMMY_COMPOSIO_RECONNECT_BREAKER ?? 'on').toLowerCase() !== 'off';
}
function reconnectBreakerKey(sid: string, toolSlug: string): string {
  return `${sid}::${registeredToolkitOfSlug(toolSlug)}`;
}
/**
 * The provider half of a gateway slug: AIRTABLE_CREATE_RECORDS → "airtable".
 * Derived, never listed, so a provider connected tomorrow is covered on arrival.
 */
function providerOfSlug(toolSlug: string): string {
  return (toolSlug.split('_')[0] ?? '').trim().toLowerCase();
}

/**
 * Mirror a connection's health into the DURABLE capability registry.
 *
 * The breaker below already knows exactly which toolkit is broken and when it
 * recovers — and then throws that away: it is in-memory, per-session, and
 * TTL'd. Nothing outside the failing turn ever learns. Measured on this machine
 * (2026-08-01), the capability registry held exactly ONE record,
 * `claude_sdk_local_mcp_surface`, because the only two callers of
 * recordHarnessCapabilityHealth both watch the brain's own MCP surface. No
 * provider, connection, or account state had ever been written.
 *
 * That is why a plan could promise "read-only via the Salesforce CLI" while the
 * saved login was expired, and die on it mid-run eight minutes later. The story
 * was never "the harness knew and did not say" — for providers, the harness did
 * not know either. Every consumer of capability health was reading an empty
 * table and correctly reporting nothing wrong.
 *
 * Only STATE CHANGES are written. recordHarnessCapabilityHealth persists on
 * every call and the success path here runs on every gateway hit, so recording
 * unconditionally would put a file write in the hot path. A transition is also
 * the honest unit: health is a state machine, not a counter.
 */
function noteProviderHealth(toolSlug: string, state: 'healthy' | 'unavailable', reason?: string): void {
  try {
    const provider = providerOfSlug(toolSlug);
    if (!provider) return;
    if (readHarnessCapabilityHealth(provider)?.state === state) return;
    recordHarnessCapabilityHealth({
      id: provider,
      state,
      summary: state === 'healthy'
        ? `${provider} is connected and answering`
        : `${provider} needs reconnecting`,
      reason: reason ?? null,
    });
  } catch { /* health telemetry must never break a tool call */ }
}

function recordReconnectBreaker(sid: string | undefined, toolSlug: string): void {
  // Durable first, and independent of the session: a connection is broken for
  // everything, not just for the turn that happened to discover it.
  noteProviderHealth(toolSlug, 'unavailable', 'a gateway call returned a reconnect-required error');
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
  // A successful call is the only honest proof a connection recovered, so the
  // registry clears from the same evidence the breaker does.
  noteProviderHealth(toolSlug, 'healthy');
  if (sid) reconnectBreakerBySession.delete(reconnectBreakerKey(sid, toolSlug));
}

/** Test seam for the gateway's breaker (module-private state). */
export const __gatewayTest__ = {
  recordReconnectBreaker,
  reconnectBreakerTripped,
  clearReconnectBreaker,
  setRuntimeStatusLoader(loader: (() => Promise<ComposioRuntimeStatus>) | null): void {
    composioRuntimeStatusLoader = loader ?? getComposioRuntimeStatus;
  },
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
      const live = v.filter((entry) => entry.at >= cutoff);
      if (live.length > 0) lastComposioSearchBySession.set(k, live);
      else lastComposioSearchBySession.delete(k);
    }
  }
  const key = composioSearchAttributionKey(sessionId);
  // Many searches, not one slot. A long task legitimately searches more than
  // once, and the single-slot store meant the second search silently cancelled
  // the first — so an execute could be credited to a search that never
  // surfaced its slug. Searches now coexist and are matched by what they found.
  const searches = lastComposioSearchBySession.get(key) ?? [];
  searches.push({
    searchId: `search-${searches.length + 1}-${Date.now().toString(36)}`,
    query: query.trim(),
    at: Date.now(),
    slugs: slugs && slugs.length > 0 ? slugs.slice(0, 60) : undefined,
    fromMemory: options.fromMemory,
    useIdsBySlug: options.useIdsBySlug,
  });
  // Bounded per task; the oldest search is the one least likely to be credited.
  while (searches.length > MAX_TRACKED_SEARCHES_PER_TASK) {
    const dropped = searches.shift();
    for (const useId of Object.values(dropped?.useIdsBySlug ?? {})) cancelToolProcedureUse(useId);
  }
  lastComposioSearchBySession.set(key, searches);
}

/**
 * The search that actually surfaced this slug.
 *
 * Correlation is by RESULT, not recency: when two searches are in flight for
 * one task, crediting the newest would teach the wrong query for the slug. A
 * search that named the slug wins; only when none did does the most recent
 * stand in, and then only for a search that recorded no candidates at all.
 */
function composioSearchForSlug(
  key: string,
  toolSlug: string,
): ComposioSearchRecord | undefined {
  const searches = lastComposioSearchBySession.get(key) ?? [];
  const slug = toolSlug.trim().toUpperCase();
  const surfaced = searches.filter(
    (candidate) => candidate.slugs?.some((entry) => entry.trim().toUpperCase() === slug),
  );
  // Exactly one search surfaced this slug — that search owns the execution.
  if (surfaced.length === 1) return surfaced[0];
  // Two outstanding searches both surfaced it: which query taught this slug is
  // genuinely unknown, and guessing would write the wrong intent into memory
  // for good. Decline to attribute; the call still runs, it just teaches
  // nothing.
  if (surfaced.length > 1) return undefined;
  const untargeted = searches.filter((candidate) => !candidate.slugs);
  return untargeted.length === 1 ? untargeted[0] : undefined;
}

function forgetComposioSearch(key: string, record: ComposioSearchRecord): void {
  const searches = lastComposioSearchBySession.get(key) ?? [];
  const remaining = searches.filter((entry) => entry.searchId !== record.searchId);
  if (remaining.length > 0) lastComposioSearchBySession.set(key, remaining);
  else lastComposioSearchBySession.delete(key);
}

/** Persist only the bounded, schema-backed result of discovery for the exact
 * accepted source. A later clarification answer may reuse these identifiers
 * after restart, but never the search query, arguments, or execution rights. */
/**
 * A candidate failed, so the task may search again.
 *
 * The trigger is an OBSERVED failed dispatch, never anything the model claims,
 * and the governor still refuses to advance an epoch that has budget left. So
 * this reopens discovery exactly once per dead end, which is the number of
 * times a dead end is worth reopening it.
 */
/**
 * A thrown Composio failure, settled once through the shared kernel.
 *
 * These exits used to return a rendered banner and nothing else — the typed
 * reason existed for one stack frame and then became prose, so a dead candidate
 * never gave its discovery budget back and a reconnect never became a
 * conversational blocker.
 */
/**
 * The exact callable contract, rendered for repair.
 *
 * Bounded on purpose — required fields, their types, and the accepted keys.
 * Enough to correct the call, not so much that a schema dump displaces the
 * work. Returns '' when no schema is available, so this can never make an
 * error message worse.
 */
function renderCallableContract(toolSlug: string, schema: unknown): string {
  const shape = schema && typeof schema === 'object' ? schema as Record<string, unknown> : null;
  const properties = shape?.properties && typeof shape.properties === 'object'
    ? shape.properties as Record<string, Record<string, unknown>>
    : null;
  if (!properties) return '';
  const required = new Set(Array.isArray(shape?.required) ? shape.required as string[] : []);
  const lines = Object.entries(properties).slice(0, 24).map(([name, spec]) => {
    const type = typeof spec?.type === 'string' ? spec.type : 'any';
    return `  ${name}${required.has(name) ? '*' : ''}: ${type}`;
  });
  if (lines.length === 0) return '';
  return `\n\nCallable contract for ${toolSlug} (* = required):\n${lines.join('\n')}`
    + '\nCorrect the arguments and call it again; this attempt never dispatched.';
}

/** A typed gateway refusal that never reached the provider. The reason decides
 *  recovery structurally; provider prose is never parsed to recover it. */
function settleComposioPreDispatchRefusal(
  toolSlug: string,
  reason: ComposioGatewayBlockReason,
  args: Record<string, unknown>,
  schema?: unknown,
): void {
  const run = harnessRunContextStorage.getStore();
  const invocation = toolOutputContextStorage.getStore();
  const reasonSignals: AttemptSignals = reason === 'invalid-args'
    ? { argumentValidationFailed: true, schemaAvailable: Boolean(schema) }
    : reason === 'ambiguous-account' || reason === 'identity-absent'
      ? { needsUserInput: true }
      : reason === 'not-connected'
        ? { connectionMissing: true }
        : { policyRefused: true };
  try {
    settleToolAttempt({
      sessionId: run?.sessionId,
      sourceUserSeq: run?.sourceUserSeq,
      turn: run?.turn,
      lane: 'composio',
      toolName: toolSlug,
      ...(invocation?.settlementNonce ? { callId: invocation.settlementNonce } : {}),
      args,
      // Nothing dispatched, so nothing is uncertain — even for a write.
      mutating: false,
      businessCall: classifyDiscoveryCall(toolSlug, args) === null,
      signals: {
        preDispatch: true,
        ...reasonSignals,
      },
    });
  } catch (error) {
    if (error instanceof ToolAttemptSettlementAuthorityError) throw error;
    // Classification/telemetry defects remain secondary to the typed refusal.
  }
}

/** Settlement is runtime truth, so it lives on the synchronous dispatch path—
 * never inside best-effort procedural learning. */
function settleComposioReturned(
  toolSlug: string,
  args: Record<string, unknown>,
  result: unknown,
  continuesRequirement = false,
  signals: AttemptSignals = {},
): void {
  const run = harnessRunContextStorage.getStore();
  const invocation = toolOutputContextStorage.getStore();
  // Reaching this function IS the backend's success contract: errors and
  // non-zero exits settle through settleComposioThrown, and refusals settle
  // pre-dispatch. A provider action that echoes its resource (a bare record,
  // an array page) carries no `successful` flag, and without this stamp it
  // settled 'unknown' — the settlement audit then held a fully verified
  // workflow run as unrecovered business failure (platform49 proof,
  // 2026-08-12). A payload that DOES carry its own envelope keeps its own
  // verdict, and the contradicted-envelope downgrade still runs either way.
  const record = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : null;
  const carriesOwnEnvelope = record !== null && (
    'successful' in record || 'success' in record || 'error' in record || 'errors' in record
  );
  try {
    settleToolAttempt({
      sessionId: run?.sessionId,
      sourceUserSeq: run?.sourceUserSeq,
      turn: run?.turn,
      lane: 'composio',
      toolName: toolSlug,
      args,
      ...(invocation?.settlementNonce ? { callId: invocation.settlementNonce } : {}),
      mutating: classifyComposioSlugEffect(toolSlug) !== 'read',
      businessCall: classifyDiscoveryCall(toolSlug, args) === null,
      result,
      signals: {
        ...(carriesOwnEnvelope ? {} : { envelopeSuccessful: true }),
        ...signals,
      },
      ...(continuesRequirement ? { continuesRequirement: true } : {}),
    });
  } catch (error) {
    if (error instanceof ToolAttemptSettlementAuthorityError) throw error;
    // Non-authority bookkeeping remains fail-open for the provider result.
  }
}

type RuntimeDocumentedCreateProjection =
  | { status: 'not_applicable' }
  | { status: 'refused'; reason: string }
  | {
      status: 'ready';
      admission: Extract<DocumentedCreateResultAdmission, { status: 'ready' }>;
    };

/**
 * Bind the one documented-create response projector to the exact live host
 * call before provider I/O.  An ordinary/legacy Composio create with neither
 * host attestation nor expected-work binding keeps its historical raw lane;
 * a half-present or mismatched planned lane fails closed before crossing.
 */
function currentDocumentedCreateProjection(input: {
  toolSlug: string;
  args: Record<string, unknown>;
  connectionId: string | undefined;
  providerSchemaLeaseFingerprint: string | undefined;
  providerInputSchemaDigest: string | undefined;
}): RuntimeDocumentedCreateProjection {
  if (!documentedAtomicInputContentCommit(input.toolSlug)) return { status: 'not_applicable' };

  const attestation = currentHostCallAttestation();
  const work = currentExpectedWorkBinding();
  const logical = currentLogicalCall();
  // Preserve every historical provider lane.  Projection is available only
  // to a current host-owned planned call, never inferred from a slug alone.
  if (!attestation && !work) return { status: 'not_applicable' };
  if (!attestation) return { status: 'refused', reason: 'host call attestation is missing' };
  if (!work) return { status: 'refused', reason: 'expected-work binding is missing' };
  if (!logical) return { status: 'refused', reason: 'logical call identity is missing' };
  const contract = durableLogicalCallContract(
    logical.acceptedTaskId,
    input.toolSlug,
    input.args,
  );
  if (!contract) return { status: 'refused', reason: 'provider-ready argument contract is unreadable' };
  if (attestation.bindingKind !== 'catalog_manifest') {
    return { status: 'refused', reason: 'documented create lacks catalog-manifest authority' };
  }
  if (
    attestation.acceptedTaskId !== logical.acceptedTaskId
    || attestation.logicalToolCallId !== logical.logicalToolCallId
    || attestation.operationId !== input.toolSlug
    || attestation.toolName !== contract.toolName
    || attestation.argumentDigest !== contract.argumentDigest
    || attestation.effect !== 'external_write'
  ) return { status: 'refused', reason: 'host call attestation conflicts with the exact provider call' };
  if (
    work.acceptedTaskId !== logical.acceptedTaskId
    || work.logicalToolCallId !== logical.logicalToolCallId
    || work.effect !== 'external_write'
    || !work.requirementId.trim()
  ) return { status: 'refused', reason: 'expected-work binding conflicts with the exact provider call' };
  if (!input.connectionId || attestation.accountId !== input.connectionId) {
    return { status: 'refused', reason: 'resolved provider account conflicts with the catalog manifest' };
  }
  if (
    !input.providerSchemaLeaseFingerprint
    || !input.providerInputSchemaDigest
    || attestation.providerInputSchemaDigest !== input.providerInputSchemaDigest
    || work.schemaFingerprint !== undefined
    || work.schemaDigest !== undefined
  ) return {
    status: 'refused',
    reason: 'resolved provider schema conflicts with planned work',
  };
  const submitted = compileGoogleSheetsSheetFromJsonContract(input.toolSlug, input.args);
  const frozenSubmitted = parseGoogleSheetsSheetFromJsonContract(work.generatedArtifactContentContract);
  if (
    !submitted
    || !frozenSubmitted
    || submitted.submittedContentDigest !== frozenSubmitted.submittedContentDigest
    || JSON.stringify(submitted) !== JSON.stringify(frozenSubmitted)
  ) return {
    status: 'refused',
    reason: 'provider-ready submitted content conflicts with the frozen work contract',
  };

  const admitted = admitDocumentedCreateResultProjection({
    authority: {
      version: 1,
      acceptedTaskId: logical.acceptedTaskId,
      logicalToolCallId: logical.logicalToolCallId,
      requirementId: work.requirementId,
      operationId: attestation.operationId,
      accountId: attestation.accountId,
      providerInputSchemaDigest: attestation.providerInputSchemaDigest,
      argumentDigest: attestation.argumentDigest,
      submittedContentDigest: submitted.submittedContentDigest,
      effect: 'external_write',
    },
    actual: {
      acceptedTaskId: logical.acceptedTaskId,
      logicalToolCallId: logical.logicalToolCallId,
      operationId: input.toolSlug,
      accountId: input.connectionId,
      providerInputSchemaDigest: input.providerInputSchemaDigest,
      argumentDigest: contract.argumentDigest,
      submittedContentDigest: submitted.submittedContentDigest,
      effect: 'external_write',
    },
  });
  return admitted.status === 'ready'
    ? { status: 'ready', admission: admitted }
    : admitted.status === 'not_applicable'
      ? { status: 'not_applicable' }
      : { status: 'refused', reason: admitted.reason };
}

function settleComposioThrown(
  toolSlug: string,
  args: Record<string, unknown>,
  thrown: unknown,
  signals: AttemptSignals = {},
): void {
  const run = harnessRunContextStorage.getStore();
  try {
    settleToolAttempt({
      sessionId: run?.sessionId,
      sourceUserSeq: run?.sourceUserSeq,
      turn: run?.turn,
      lane: 'composio',
      toolName: toolSlug,
      args,
      ...(toolOutputContextStorage.getStore()?.settlementNonce
        ? { callId: toolOutputContextStorage.getStore()!.settlementNonce }
        : {}),
      mutating: classifyComposioSlugEffect(toolSlug) !== 'read',
      businessCall: classifyDiscoveryCall(toolSlug, args) === null,
      thrown,
      signals,
    });
  } catch (error) {
    if (error instanceof ToolAttemptSettlementAuthorityError) throw error;
    // Non-authority bookkeeping remains fail-open for the provider error.
  }
}

function recordDiscoveredComposioCapabilities(
  matches: ReadonlyArray<{ slug: string }>,
): void {
  const run = harnessRunContextStorage.getStore();
  if (!run?.sessionId || !Number.isSafeInteger(run.sourceUserSeq) || (run.sourceUserSeq ?? 0) <= 0) return;
  const capabilities = matches
    .filter((match) => match.slug && match.slug !== '__toolkit_error__')
    .slice(0, 10)
    .map((match) => {
      const schemaFingerprint = liveComposioSchemaFingerprint(match.slug);
      return {
        kind: 'composio',
        identifier: match.slug,
        effectClass: classifyComposioSlugEffect(match.slug) === 'read' ? 'read' : 'write',
        ...(schemaFingerprint ? { schemaFingerprint } : {}),
      };
    })
    // A search hint without an executable schema is not continuity evidence.
    .filter((capability) => Boolean(capability.schemaFingerprint));
  if (capabilities.length === 0) return;
  try {
    appendEvent({
      sessionId: run.sessionId,
      turn: Number.isSafeInteger(run.turn) && (run.turn ?? 0) > 0 ? run.turn as number : 0,
      role: 'system',
      type: 'capability_discovered',
      data: {
        sourceUserSeq: run.sourceUserSeq,
        ...(run.runAttemptId ? { attemptId: run.runAttemptId } : {}),
        capabilities,
      },
    });
  } catch { /* continuation evidence must never break discovery */ }
}

/** The honest intent behind an execute, for outcome learning: the session's
 *  fresh search query when that search actually surfaced this slug, else a
 *  readable seed from the slug. The surfaced-slug gate is the synchronous twin
 *  of auto-remember's semantic gate — a stale query about a DIFFERENT toolkit
 *  must never label this slug's outcome stats. Read-only — never consumes the
 *  session entry (auto-remember owns deletion). */
export function executionIntentForSession(sessionId: string | undefined, toolSlug: string): string {
  // The search that surfaced THIS slug — not merely the latest one.
  const pending = sessionId
    ? composioSearchForSlug(composioSearchAttributionKey(sessionId), toolSlug)
    : undefined;
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
  const slugToolkit = registeredToolkitOfSlug(slug);
  if (!slugToolkit) return false;
  const q = query.toLowerCase().replace(/[-\s]+/g, '_');
  const qCompact = q.replace(/_/g, '');
  const queryNamesToolkit = (toolkit: string): boolean => {
    const normalized = toolkit.toLowerCase().replace(/[-\s]+/g, '_');
    return q.includes(normalized) || qCompact.includes(normalized.replace(/_/g, ''));
  };
  if (queryNamesToolkit(slugToolkit)) return false; // names its own toolkit → consistent
  return knownToolkits.some((t) => {
    const tk = (t ?? '').toLowerCase().replace(/[-\s]+/g, '_');
    return tk.length > 0 && tk !== slugToolkit && queryNamesToolkit(tk);
  });
}

/**
 * The STABLE account identity behind a dispatch: the connected account's
 * email, never the rotating ca_ connection id. Single-account toolkits bind
 * the same stable identity too: re-auth rotates the connection, not the
 * mailbox. Zero extra discovery — the connections snapshot is the gateway's
 * SWR source. Fail-open: identity capture must never break the tool call.
 */
export function stableComposioAccountIdentityFromSnapshot(
  toolSlug: string,
  connectionId: string | undefined,
  resolvedIdentity: string | undefined,
  connections: readonly ConnectedToolkit[],
): string | undefined {
  if (!connectionId) return undefined;
  try {
    const lower = toolSlug.toLowerCase();
    const forToolkit = connections.filter((c) => {
      const s = (c.slug ?? '').toLowerCase();
      return s && (lower === s || lower.startsWith(`${s}_`));
    });
    const raw = forToolkit.find((c) => c.connectionId === connectionId)?.accountEmail;
    const email = normalizeProcedureAccountIdentity(raw);
    if (!email.includes('@')) return undefined;
    const routed = resolvedIdentity === undefined
      ? ''
      : normalizeProcedureAccountIdentity(resolvedIdentity);
    return routed && routed !== email ? undefined : email;
  } catch {
    return undefined;
  }
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
    if (!failed && detectJobReceipt(toolSlug, result)) return;
    // A call that WORKED is the only honest example of how to call this tool.
    // Recorded before every learning guard below, and independent of them: those
    // guards decide whether this slug becomes the proven answer for an INTENT,
    // which is a different and much stricter question than "what does a valid
    // payload for this slug look like". Live 2026-08-07: an OUTLOOK update failed
    // with invalid arguments on a tool already used successfully in the same run —
    // the schema said what was legal, and nothing said what had worked. Shape
    // only; the store redacts every value that could carry content.
    if (!failed) {
      try {
        saveToolContractExample({
          identifier: toolSlug,
          exampleArgs: args,
        });
      } catch { /* learning an example must never affect the call that succeeded */ }
    }
    const sid = sessionId;
    // Consume only the search this slug actually came from; a sibling search
    // still in flight for the same task keeps its own attribution.
    const attributionKey = sid ? composioSearchAttributionKey(sid) : '';
    const pending = sid ? composioSearchForSlug(attributionKey, toolSlug) : undefined;
    const pendingFresh = Boolean(pending && Date.now() - pending.at <= AUTO_REMEMBER_WINDOW_MS);
    if (sid && pending) forgetComposioSearch(attributionKey, pending);
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
    // pollution). Learning after a paid call is cache-only: starting an account
    // refresh here would create an unowned provider crossing after settlement.
    try {
      const current = peekCurrentConnectedToolkits();
      if (current === null) return;
      const known = filterSuppressedConnectedToolkits(
        current,
        readComposioConnectionSuppressionState(),
      ).map((t) => t.slug).filter((s): s is string => Boolean(s));
      if (isCrossServiceToolkitMismatch(pending.query, toolSlug, known)) return;
    } catch {
      // fail-open: a guard error must never break learning
    }
    const intent = pending.query.trim();
    if (!intent) return;
    // R2/A: this path no longer WRITES memory. Outcome accounting above
    // (procedure-use attribution) is preserved; procedures, schemas, aliases
    // and invocation templates are created by exactly one path — the
    // settlement → pending-learning → worker pipeline — which never persists
    // a historical argument. A discovery-followed-by-success turn teaches
    // through that same pipeline or not at all.
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

/**
 * The ROUTE half of the standing-constraint gate: pure, no I/O, no resolved
 * account. It answers "is this tool allowed to be reached at all", which is a
 * question about the RULE, not about the provider's health.
 *
 * Separated so it can run before any connection or identity probe. Live
 * 2026-08-08: a pinned dispatch constraint forbids Composio Salesforce and names
 * the local sf CLI as the only route — and the user's rule says in terms never
 * to ask for a Composio reconnect. The gate never got to speak: the connection
 * probe found the (deliberately) dead connector first and emitted exactly the
 * forbidden sentence. A rule that forbids a route makes that route's health and
 * its account ambiguity irrelevant, so the rule must be asked first.
 *
 * Sender resolution stays behind in enforceStandingConstraints — it needs live
 * connections and a profile probe, so it cannot move and does not need to.
 */
function routeConstraintBlock(
  toolSlug: string,
  args: Record<string, unknown>,
): string | null {
  // `emailHandledExternally` stays true: the mailbox rule is resolved by
  // findEmailSendConstraint during sender resolution, exactly as before. This
  // call is only the pattern-based ROUTE prohibition.
  const violation = checkConstraintViolation('composio_execute_tool', {
    ...args,
    action: toolSlug,
  }, { emailHandledExternally: true });
  return violation ? formatConstraintEscalation(violation) : null;
}

async function enforceStandingConstraints(
  toolSlug: string,
  args: Record<string, unknown>,
  connectedAccountId: string | undefined,
  options: {
    /** Current provider snapshot prepared by an admitted discovery/planning
     * read. When present, sender resolution is forbidden from performing any
     * account-list or profile I/O inside the business logical call. */
    preparedConnections?: ConnectedToolkit[];
    providerProfileProbeAllowed?: boolean;
  } = {},
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
      if (options.preparedConnections) {
        connections = options.preparedConnections
          .map((c) => ({ connectionId: c.connectionId, accountEmail: c.accountEmail, status: c.status }));
      } else try {
        const toolkit = registeredToolkitOfSlug(toolSlug);
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
        fetchProfile: options.providerProfileProbeAllowed === false
          ? async () => {
              throw new Error(
                'current sender profile identity is not prepared; run the exact profile read first',
              );
            }
          : (slug, profileArgs, connectionId) => executeComposioTool(slug, profileArgs, connectionId),
      });
      if (!resolution.ok) return { block: resolution.message ?? 'Blocked by standing sender constraint.' };
      routeConnectedAccountId = resolution.routeConnectionId;
    }
  }

  // The route prohibition already ran at the top of resolveComposioDispatch,
  // before any connection probe. Re-checking here is harmless but redundant —
  // and leaving it as the ONLY check is what let a dead connector answer first.
  const routeBlock = routeConstraintBlock(toolSlug, args);
  if (routeBlock) return { block: routeBlock };

  return { block: null, routeConnectedAccountId };
}

export function normalizeInlineConnectedAccountId(
  args: Record<string, unknown>,
  connectedAccountId: string | undefined,
): { args: Record<string, unknown>; connectedAccountId: string | undefined } {
  const inline = args.connected_account_id ?? args.connectedAccountId;
  const normalizeOptionalConnection = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed && !/^(?:null|none|undefined)$/i.test(trimmed)
      ? trimmed
      : undefined;
  };
  // OpenAI-compatible providers sometimes stringify an optional JSON null on
  // the outer broker argument. Treat those spellings exactly like an omitted
  // selector; they are never a real Composio connection id.
  let effectiveConnectionId = normalizeOptionalConnection(connectedAccountId);
  if (!effectiveConnectionId && typeof inline === 'string') {
    effectiveConnectionId = normalizeOptionalConnection(inline);
  }
  delete args.connected_account_id;
  delete args.connectedAccountId;
  // Clementine-only artifact transaction keys select an intentional output
  // slot (for example `proposal` and `appendix`) but are not provider fields.
  // The harness reads them before dispatch; never leak them into a Composio
  // schema where they would turn a legitimate multi-document request into an
  // invalid-arguments failure.
  delete args.artifact_key;
  delete args.artifactKey;
  delete args.output_key;
  delete args.outputKey;
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
  const toolkit = registeredToolkitOfSlug(toolSlug).toUpperCase();
  const mutating = classifyComposioSlugEffect(toolSlug) !== 'read';
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

/** A receipt is already accepted work. Keep it moving under the authority that
 * started it instead of manufacturing a foreground/background permission beat. */
export function formatComposioBudgetExceededOutput(
  receipt: JobReceipt,
  output: string,
  _context?: unknown,
): string {
  return `${asyncReceiptBanner(receipt)}\n\nThis is a LONG-running job (still going after the auto-poll window). Continue autonomously from this receipt and its job id under the user's existing authority: either follow its polling guidance at a sensible cadence, or dispatch_background_task to monitor/finish it and report back here. Do not ask the user to choose a lane or stop for routing permission; do not restart or re-invoke the job, and do not fire back-to-back polls.\n\n${output}`;
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
  const toolkit = registeredToolkitOfSlug(toolSlug);
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
    + `If the user NAMES the account (e.g. "that's my acme email"), ALSO pass \`account_alias\` (e.g. "acme") with the pinned re-call — the name is then remembered permanently, and future calls can use \`account_alias\` alone instead of asking again. Do NOT guess — acting on the wrong account is exactly the mistake this guard prevents.`
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
  | 'worker-compose-only' // run_worker may read/compose; only its parent commits the immutable batch
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
  /** Immutable contract fingerprint captured at gateway validation, before
   * provider I/O. */
  schemaFingerprint?: string;
  /** Full canonical digest of the exact schema captured above. Present only
   * while that schema also owns the current provider-observation lease. */
  providerInputSchemaDigest?: string;
  /** Exact provider operation version observed with the schema lease. */
  providerOperationVersion?: string;
  /** Opaque terminal one-shot prepared before the physical row opens. */
  preparedDispatch?: PreparedComposioOneShotDispatch;
  /** Final addressable owner↔stable-identity proof from the same gateway
   * snapshot. Absent means learning must remain unbound/non-executable. */
  accountIdentityProof?: { connectionId: string; identity: string };
  /** True when a standing sender rule verified the route (surface the sender-verify note). */
  senderVerified: boolean;
  /** Human-readable route notes to append to the tool output. */
  notes: string[];
}

export type ComposioGatewayResolution = ComposioGatewayResolved | ComposioGatewayBlocked;

/** Bind the historical selector/cache fingerprint and the full authority
 * digest to one exact provider-observed schema. A durable validation cache
 * without a current provider lease can validate args, but cannot mint this
 * execution identity. */
function exactProviderInputSchemaIdentity(
  toolSlug: string,
  schema: unknown,
): Pick<ComposioGatewayResolved, 'schemaFingerprint' | 'providerInputSchemaDigest'> {
  const schemaFingerprint = liveComposioSchemaFingerprint(toolSlug);
  if (!schemaFingerprint || !schema || typeof schema !== 'object' || Array.isArray(schema)) return {};
  try {
    if (fingerprintSchema(schema) !== schemaFingerprint) return {};
    return {
      schemaFingerprint,
      providerInputSchemaDigest: digestSchema(schema),
    };
  } catch {
    return {};
  }
}

function schemaRequiresComposioFileUpload(schema: unknown): boolean {
  const queue: unknown[] = [schema];
  const seen = new Set<object>();
  let visited = 0;
  while (queue.length > 0 && visited < 4_000) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value as object)) continue;
    seen.add(value as object);
    visited += 1;
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    const record = value as Record<string, unknown>;
    if (record.file_uploadable === true) return true;
    queue.push(...Object.values(record));
  }
  return false;
}

interface ClosedNoArgReadRepair {
  args: Record<string, unknown>;
  note: string;
}

/** A current, closed no-argument READ contract has one useful projection: {}.
 *
 * This is deliberately narrower than generic argument coercion. It does not
 * touch writes, schemas with any declared property/pattern, stale validation-
 * only contracts, or contracts whose other keywords could make the empty
 * object invalid. In that exact lane, retaining an invented field can only buy
 * a deterministic provider rejection and another model/tool turn; removing it
 * preserves the requested fresh read while making the repair visible in the
 * returned tool note. */
function repairClosedNoArgRead(
  toolSlug: string,
  args: Record<string, unknown>,
  schema: Record<string, unknown> | null,
): ClosedNoArgReadRepair | null {
  if (classifyComposioSlugEffect(toolSlug) !== 'read'
    || !schema
    || !liveComposioSchemaFingerprint(toolSlug)
    || schema.type !== 'object'
    || schema.additionalProperties !== false
    || !isRecord(schema.properties)
    || Object.keys(schema.properties).length !== 0
    || Object.keys(args).length === 0) return null;

  const required = schema.required;
  if (required !== undefined && (!Array.isArray(required) || required.length > 0)) return null;
  const patterns = schema.patternProperties;
  if (patterns !== undefined && (!isRecord(patterns) || Object.keys(patterns).length > 0)) return null;
  const minProperties = schema.minProperties;
  if (minProperties !== undefined && minProperties !== 0) return null;
  // These applicators can reject {} even though the local object surface is
  // closed. Without a full schema evaluator, abstaining is the safe choice.
  if (['$ref', 'const', 'enum', 'not', 'allOf', 'anyOf', 'oneOf', 'if', 'then', 'else']
    .some((key) => Object.prototype.hasOwnProperty.call(schema, key))) return null;

  const removed = Object.keys(args).sort();
  return {
    args: {},
    note:
      `[argument-repair] ${toolSlug} is a read whose current provider schema accepts exactly {}. `
      + `Removed unsupported argument field(s) before dispatch: ${removed.join(', ')}. `
      + 'A fresh provider read was still dispatched; no earlier result was replayed.',
  };
}

interface ComposioDispatchLaneStatus {
  executionBackend: 'auto' | 'sdk' | 'cli';
  apiKeyPresent: boolean;
  cli: {
    installed: boolean;
    authenticated: boolean;
    authStatus: 'ok' | 'missing' | 'error' | 'unknown';
  };
}

/** Pure availability decision used by the gateway before the first provider
 * boundary. `unknown` CLI auth stays fail-open because a custom CLI build may
 * execute successfully even when `whoami` returns no identity text. */
export function composioDispatchLaneAvailable(status: ComposioDispatchLaneStatus): boolean {
  if (status.executionBackend === 'sdk') return status.apiKeyPresent;
  const cliMayRun = status.cli.installed
    && (status.cli.authenticated || status.cli.authStatus === 'unknown');
  if (status.executionBackend === 'cli') return cliMayRun;
  return status.apiKeyPresent || cliMayRun;
}

/**
 * An empty SDK connected-account snapshot is not proof that the CLI provider
 * default is unusable. Keep this narrower than generic lane availability:
 * provider-side default resolution is eligible only for an explicitly
 * CLI-backed configuration (or AUTO with no SDK key) whose harmless `whoami`
 * probe positively authenticated. The separate, toolkit-scoped authority gate
 * decides whether using that unidentified default account is permitted.
 */
export function composioCliCanResolveUnlistedConnectedAccount(
  status: ComposioDispatchLaneStatus,
): boolean {
  if (status.executionBackend === 'sdk') return false;
  if (status.executionBackend === 'auto' && status.apiKeyPresent) return false;
  return status.cli.installed && status.cli.authenticated;
}

function toolkitAuthMode(
  toolkit: string,
): 'managed' | 'byo' | 'none' | undefined {
  const normalized = toolkit.trim().toLowerCase();
  const known = [
    ...CURATED_TOOLKITS,
    ...listCachedToolkits(),
  ].find((entry) => entry.slug.trim().toLowerCase() === normalized);
  return known?.authMode;
}

function toolkitRequiresConnectedAccount(toolkit: string): boolean {
  const authMode = toolkitAuthMode(toolkit);
  return authMode === 'managed' || authMode === 'byo';
}

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
      data: { guardrail: 'composio_gateway', reason, toolSlug, toolkit: registeredToolkitOfSlug(toolSlug), ...extra },
    });
  } catch { /* ledger write must never break the block path */ }
}

export interface ComposioGatewayOptions {
  sessionId?: string;
  /** Latest user input, for standing calendar-read routing. */
  userInput?: string;
  /** Caller-supplied mailbox preference (email) — wins over recall. */
  preferredIdentity?: string;
  /** Exact-identity callers (the governed warm lane) may forbid profile-probe
   * enrichment and sticky fallback. Absence/mismatch then returns a typed
   * block instead of approaching a provider to discover another identity. */
  strictPreferredIdentity?: boolean;
  /** Execution adapters set this after discovery/planning. The resolver then
   * consumes only current connection/schema/identity observations and cannot
   * start account, profile, runtime-status, or schema provider I/O of its own. */
  preparedExecution?: boolean;
}

/** Exact gateway-resolved call handed to a correctness-critical dispatch
 * boundary. Resolution/validation has finished; invoking `dispatch` is the
 * first operation that can reach the provider. */
export interface ComposioDispatchBoundaryContext {
  toolSlug: string;
  args: Record<string, unknown>;
  connectionId?: string;
  identity?: string;
  schemaFingerprint?: string;
  providerInputSchemaDigest?: string;
}

export type ComposioDispatchBoundary = (
  context: ComposioDispatchBoundaryContext,
  dispatch: () => Promise<unknown>,
) => Promise<unknown>;

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
// ── Run-scoped account stickiness ─────────────────────────────────────────
// The account question is answered AT MOST ONCE per run. Once an account is
// positively resolved for a toolkit — explicit pin/alias, or an identity the
// selector resolved — later calls in the same run reuse it instead of
// re-interrogating. Two DISTINCT accounts used in one run disables reuse for
// that toolkit (never guess between proven alternatives for irreversible
// sends). Stored on the existing HarnessRunContext: no new persistence, and
// the memo dies with the run.
function recordRunToolkitAccountUse(
  toolkit: string,
  connectionId: string | undefined,
  identity: string | undefined,
  explicit: boolean,
): void {
  if (!connectionId) return;
  const ctx = harnessRunContextStorage.getStore();
  if (!ctx) return;
  ctx.resolvedToolkitAccounts ??= new Map();
  let uses = ctx.resolvedToolkitAccounts.get(toolkit);
  if (!uses) {
    uses = new Map();
    ctx.resolvedToolkitAccounts.set(toolkit, uses);
  }
  const prev = uses.get(connectionId);
  uses.set(connectionId, {
    identity: identity ?? prev?.identity,
    explicit: explicit || Boolean(prev?.explicit),
  });
}

function stickyRunAccount(
  toolkit: string,
  usable: ConnectedToolkit[],
): { connectionId: string; identity?: string } | undefined {
  const uses = harnessRunContextStorage.getStore()?.resolvedToolkitAccounts?.get(toolkit);
  if (!uses || uses.size !== 1) return undefined;
  const [connectionId, use] = [...uses.entries()][0]!;
  // The remembered connection must still be live in the CURRENT snapshot —
  // a disconnect mid-run falls back to the normal ask, never a stale route.
  if (!usable.some((c) => c.connectionId === connectionId)) return undefined;
  return { connectionId, identity: use.identity };
}


export async function resolveComposioDispatch(
  toolSlug: string,
  rawArgs: Record<string, unknown>,
  connectedAccountId: string | undefined,
  opts: ComposioGatewayOptions = {},
): Promise<ComposioGatewayResolution> {
  const activeRun = harnessRunContextStorage.getStore();
  const sid = opts.sessionId ?? activeRun?.sessionId;
  // COMPOSE -> COMMIT: a run_worker child may gather provider data and reason
  // about one item, but it never owns the external commit. Refuse a mutation at
  // THE shared Composio gateway before connection lookup, schema hydration, or
  // provider I/O. The explicit workerScope bit survives both the nested
  // @openai/agents lane and Claude SDK's in-process/stdio MCP transport; it is
  // deliberately independent of the optional thrash-guard scope and does not
  // conflate workflow steps with workers.
  if (activeRun?.workerScope === true && classifyComposioSlugEffect(toolSlug) !== 'read') {
    const toolkit = registeredToolkitOfSlug(toolSlug);
    const message = [
      `WORKER_COMPOSE_ONLY: ${toolSlug} is a mutating Composio action, so this worker did not dispatch it.`,
      'No provider dispatch was started. Finish any required reads/reasoning, then return the parent one exact per-item payload shaped as {"id":"<stable item id>","composioSlug":"<exact slug>","args":{...},"account_alias":"<stable email or saved alias, only when supplied>"}.',
      'The parent must validate and aggregate the worker payloads, call run_batch action="propose" once, and execute that one immutable pending batch only after its single approval. Do not call run_batch or pending-action commit tools from the worker.',
    ].join(' ');
    emitComposioGatewayBlock(sid, toolSlug, 'worker-compose-only', {
      guard: 'worker-compose-then-parent-commit',
    });
    return { ok: false, reason: 'worker-compose-only', message, toolkit };
  }
  revalidateStaleSuppressionsOnce();
  const toolkit = registeredToolkitOfSlug(toolSlug);
  const normalized = normalizeInlineConnectedAccountId(rawArgs, connectedAccountId);
  let args = normalized.args;
  const pinned = normalized.connectedAccountId;
  const notes: string[] = [];
  const credentials = getComposioCredentialStatus();
  const cliOnlyLane = composioExecutionUsesCliOnlyLane(credentials);
  const cliDefaultAuthority = getComposioCliDefaultAccountAuthority(toolkit);
  const cliDefaultWrite = classifyComposioSlugEffect(toolSlug) !== 'read';

  // `account_alias` meta-arg (never reaches the provider): WITH a pinned
  // connection it is the "remember this one by name" gesture; alone it means
  // "use the account I named" and resolves through the alias store.
  const aliasArg = typeof (args as Record<string, unknown>).account_alias === 'string'
    ? String((args as Record<string, unknown>).account_alias).trim()
    : undefined;
  delete (args as Record<string, unknown>).account_alias;

  // ROUTE PROHIBITION FIRST — before connection health, before identity.
  //
  // Every gateway answer below this line describes the state of a PROVIDER:
  // not connected, ambiguous account, unauthorized CLI default. None of those
  // are true answers when a standing rule says this provider is not the route
  // at all. Asked in the wrong order, a deliberately-dead connector reports
  // itself as the blocker and asks the user to revive it — which is the one
  // thing the rule that would have redirected the call explicitly forbids.
  //
  // Pure and I/O-free, so it costs nothing to ask first, and it covers the
  // nested call_tool path because every dispatch funnels through here.
  const routeBlock = routeConstraintBlock(toolSlug, args as Record<string, unknown>);
  if (routeBlock) {
    emitComposioGatewayBlock(sid, toolSlug, 'constraint');
    return { ok: false, reason: 'constraint', message: routeBlock, toolkit };
  }

  // The published CLI has no connected-account selector on execute. Its
  // `whoami` response proves only that a CLI session exists; it proves neither
  // which mailbox/account is the provider-side default nor that an SDK-visible
  // connection id can be targeted. Therefore:
  //   - an explicit account-specific route can never be claimed as honored;
  //   - writes to the unidentified default need durable operator authority;
  //   - reads may use the authenticated CLI default without turning that
  //     convenience into write authority;
  //   - only a positively cataloged authMode:none toolkit may use CLI auth
  //     without that account authority.
  // Standard SDK and AUTO-with-key routing does not enter this branch.
  const recalledIdentity = recallComposioAccountIdentity(toolSlug);
  const preferredIdentity = opts.preferredIdentity?.trim();
  const draftPreference = findEmailDraftAuthoringPreference(toolSlug);
  const draftPreferredIdentity = draftPreference?.preferredAccount;
  const cliAccountRoute = pinned
    ? {
      description: `connected_account_id "${pinned}"`,
      recovery: 'remove connected_account_id and retry',
    }
    : aliasArg
      ? {
        description: `account_alias "${aliasArg}"`,
        recovery: 'remove account_alias and retry',
      }
      : preferredIdentity
        ? {
          description: `preferred account identity "${preferredIdentity}"`,
          recovery: 'clear the preferred identity for this request and retry without it',
        }
        : draftPreferredIdentity
          ? {
            description: `standing Outlook draft mailbox preference "${draftPreferredIdentity}"`,
            recovery: 'use an account-addressable SDK route or explicitly name another account for this draft',
          }
          : recalledIdentity
            ? {
              description: `remembered account identity "${recalledIdentity}" from Tool Memory`,
              recovery:
                'remove this action route from Tool Memory (for example, use tool_choice_forget for the matching intent) and retry',
            }
            : undefined;
  if (cliOnlyLane && cliAccountRoute) {
    const message =
      `⚠️ NEEDS-YOUR-CHOICE: ${toolkit} was not started because this call selected ${cliAccountRoute.description}. ` +
      `The Composio CLI can execute only against its provider-side default account; it cannot honor connected_account_id, ` +
      `account_alias, or a remembered/preferred identity, and therefore cannot prove or honor that selector. ` +
      `To target that specific account, use COMPOSIO_BACKEND=sdk (or AUTO) with COMPOSIO_API_KEY. If the CLI default is ` +
      `intended instead, ${cliAccountRoute.recovery}; writes also require an operator to authorize the named ${toolkit} ` +
      `CLI default in Connect. No provider dispatch was started.`;
    emitComposioGatewayBlock(sid, toolSlug, 'ambiguous-account', {
      guard: 'cli-cannot-target-connected-account',
    });
    return { ok: false, reason: 'ambiguous-account', message, toolkit };
  }
  if (cliOnlyLane && cliDefaultWrite && toolkitAuthMode(toolkit) !== 'none' && !cliDefaultAuthority) {
    const message =
      `⚠️ NEEDS-CONFIGURATION: ${toolkit} was not started. Composio CLI authentication does not identify which ` +
      `provider-side account its default route will mutate. An operator must first verify and authorize that named ` +
      `${toolkit} CLI default in Connect, or use COMPOSIO_BACKEND=sdk (or AUTO) with COMPOSIO_API_KEY for ` +
      `account-addressable routing. Reads remain available through the authenticated CLI default; this write does not. ` +
      `No provider dispatch was started.`;
    emitComposioGatewayBlock(sid, toolSlug, 'ambiguous-account', {
      guard: 'cli-default-account-authority-required',
    });
    return { ok: false, reason: 'ambiguous-account', message, toolkit };
  }
  if (cliOnlyLane && cliDefaultWrite && cliDefaultAuthority) {
    notes.push(
      `[account-route] Using the Composio CLI default "${cliDefaultAuthority.label}" under operator authority scoped specifically to ${toolkit}; the CLI cannot target a connected_account_id.`,
    );
  } else if (cliOnlyLane && !cliDefaultWrite) {
    notes.push(formatComposioCliDefaultReadAccountRoute(toolkit));
  }

  // Execution consumes the exact provider observations prepared by discovery
  // or plan publication. It must never hide an account-list request inside the
  // business logical call before that call owns a physical provider attempt.
  const preparedConnectionSnapshot = opts.preparedExecution
    ? peekCurrentConnectedToolkits()
    : undefined;
  let conns: ConnectedToolkit[] = [];
  if (opts.preparedExecution) {
    conns = preparedConnectionSnapshot === null
      ? []
      : filterSuppressedConnectedToolkits(
          preparedConnectionSnapshot ?? [],
          readComposioConnectionSuppressionState(),
        );
  } else {
    try { conns = await listUsableConnectedToolkits(); } catch { conns = []; }
  }
  // SDK inventory is not a routable account map for a CLI-only execute. Keep it
  // out of owner selection so a lone SDK row can never produce a false
  // `connectionId` that executeComposioTool cannot honor.
  if (cliOnlyLane) conns = [];
  const toolkitConns = conns.filter((c) => {
    const s = (c.slug ?? '').toLowerCase();
    const t = toolSlug.toLowerCase();
    return s && (t === s || t.startsWith(`${s}_`));
  });
  const usable = toolkitConns.filter((c) => opts.strictPreferredIdentity
    ? /^(active|enabled)$/i.test((c.status ?? '').trim())
    : /active|enabled|initiat/i.test(c.status ?? ''));
  let emptySnapshotRuntime: Awaited<ReturnType<typeof getComposioRuntimeStatus>> | null = null;

  if (opts.preparedExecution && !cliOnlyLane && pinned) {
    if (preparedConnectionSnapshot === null) {
      const message =
        `⚠️ PREPARATION-REQUIRED: ${toolkit} was not started because connected account ${pinned} `
        + 'has no current prepared account observation. Refresh the exact Composio account/action '
        + 'definition and retry this same call. No provider dispatch was started.';
      emitComposioGatewayBlock(sid, toolSlug, 'identity-absent', {
        guard: 'current-pinned-account-observation-required',
      });
      return { ok: false, reason: 'identity-absent', message, toolkit };
    }
    if (!usable.some((connection) => connection.connectionId === pinned)) {
      const message =
        `⚠️ NEEDS-YOUR-CHOICE: connected account ${pinned} is not present as a current usable ${toolkit} `
        + 'account. Refresh/select a live account and retry; no provider dispatch was started.';
      emitComposioGatewayBlock(sid, toolSlug, 'identity-absent', {
        guard: 'pinned-account-not-current',
      });
      return { ok: false, reason: 'identity-absent', message, toolkit };
    }
  }

  // FIRST-CALL connection gate. A managed/BYO toolkit with no usable account is
  // provably unable to dispatch only when the configured lane owns an
  // authoritative account inventory. A CLI-only installation has no SDK
  // snapshot by design, so a positive CLI auth probe plus the scoped authority
  // checked above may use its provider-side default. Do not conflate "not
  // visible to the SDK" with "not connected."
  if (!pinned && usable.length === 0 && toolkitRequiresConnectedAccount(toolkit)) {
    if (opts.preparedExecution && !cliOnlyLane && preparedConnectionSnapshot === null) {
      const message =
        `⚠️ PREPARATION-REQUIRED: ${toolkit} was not started because this accepted call has no current `
        + 'connected-account observation. Run one exact Composio status/search preparation read, then retry '
        + 'this same action from the returned current account and schema. No provider dispatch was started.';
      emitComposioGatewayBlock(sid, toolSlug, 'identity-absent', {
        guard: 'current-account-observation-required',
      });
      return { ok: false, reason: 'identity-absent', message, toolkit };
    }
    const cliOwnsConnectionInventory = credentials.executionBackend === 'cli'
      || (credentials.executionBackend === 'auto' && !credentials.apiKeyPresent);
    if (cliOwnsConnectionInventory && !opts.preparedExecution) {
      emptySnapshotRuntime = await composioRuntimeStatusLoader();
    }
    if (
      !cliOwnsConnectionInventory
      || (!opts.preparedExecution && (
        !emptySnapshotRuntime
        || !composioCliCanResolveUnlistedConnectedAccount(emptySnapshotRuntime)
      ))
    ) {
      const message = `⚠️ ${toolkit} is not connected: no usable ${toolkit} account is available. Reconnect ${toolkit} in Connect, then resume this same task. No provider dispatch was started.`;
      emitComposioGatewayBlock(sid, toolSlug, 'not-connected');
      return { ok: false, reason: 'not-connected', message, toolkit };
    }
    if (cliDefaultWrite) {
      notes.push(`[account-route] The authenticated Composio CLI will use the operator-authorized ${toolkit} default; no targetable SDK account snapshot is configured.`);
    } else {
      // The CLI-only read lane already emitted this exact harness-owned route
      // above. Keep one canonical line so downstream authority parsing is
      // identical for no-auth proof toolkits and account-bearing providers.
      const readRoute = formatComposioCliDefaultReadAccountRoute(toolkit);
      if (!notes.includes(readRoute)) notes.push(readRoute);
    }
  }

  // Unknown/no-auth toolkits can still run through an authenticated CLI or SDK
  // without a connected-account row. When neither execution lane is usable,
  // that absence is also structurally pre-dispatch and recoverable immediately.
  if (!pinned && usable.length === 0) {
    const laneUnavailable = opts.preparedExecution
      ? !cliOnlyLane && !credentials.apiKeyPresent
      : !composioDispatchLaneAvailable({
          executionBackend: getComposioExecutionBackend(),
          apiKeyPresent: (emptySnapshotRuntime ?? await composioRuntimeStatusLoader()).apiKeyPresent,
          cli: (emptySnapshotRuntime ?? await composioRuntimeStatusLoader()).cli,
        });
    if (laneUnavailable) {
      const message = `⚠️ ${toolkit} cannot run because neither the Composio SDK nor CLI is authenticated. Connect Composio, then resume this same task. No provider dispatch was started.`;
      emitComposioGatewayBlock(sid, toolSlug, 'not-connected');
      return { ok: false, reason: 'not-connected', message, toolkit };
    }
  }

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
    if (
      !opts.preparedExecution
      && !email
      && PROFILE_SLUG_BY_TOOLKIT[toolkit]
      && !identityProbeAttempted(owner)
    ) {
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
  let unresolvedAlias: string | undefined;
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
        unresolvedAlias = aliasArg;
      }
    }
  }

  // `account_alias` is an explicit current-turn selector. If it cannot resolve,
  // do not silently fall through to a standing rule, sticky choice, or provider
  // default — that would make the user's named account lose to older memory.
  if (!owner && unresolvedAlias) {
    const candidates = usable.map((candidate) => ({
      email: candidate.accountEmail,
      connectionId: candidate.connectionId,
    }));
    const message =
      `⚠️ NEEDS-YOUR-CHOICE: no saved ${toolkit} account named "${unresolvedAlias}" is attached to a live connection. `
      + 'Choose a live connected_account_id and re-call it together with this account_alias to bind the stable name. '
      + 'No provider dispatch was started.';
    emitComposioGatewayBlock(sid, toolSlug, 'identity-absent', {
      candidates: candidates.map((candidate) => candidate.email ?? candidate.connectionId),
      guard: 'explicit-account-alias-unresolved',
    });
    return {
      ok: false,
      reason: 'identity-absent',
      message,
      toolkit,
      candidates,
    };
  }

  if (!owner) {
    const calendarRoute = findOutlookCalendarReadConstraint(toolSlug, args, opts.userInput);
    if (calendarRoute) {
      owner = calendarRoute.routeConnectionId;
      notes.push(`[account-route] Routed Outlook calendar read to connection ${calendarRoute.routeConnectionId} from standing rule #${calendarRoute.constraint.id}.`);
    }
  }
  if (cliOnlyLane && owner) {
    const message =
      `⚠️ NEEDS-YOUR-CHOICE: ${toolkit} was not started. A standing rule selected connected account ${owner}, ` +
      `but the Composio CLI cannot target connected_account_id. Use COMPOSIO_BACKEND=sdk (or AUTO) with ` +
      `COMPOSIO_API_KEY to honor this route. The configured CLI default account was not substituted. ` +
      `No provider dispatch was started.`;
    emitComposioGatewayBlock(sid, toolSlug, 'ambiguous-account', {
      guard: 'cli-cannot-honor-standing-account-route',
    });
    return { ok: false, reason: 'ambiguous-account', message, toolkit };
  }
  // A send governed by a standing sender rule is RULE-owned: the constraint
  // stage below resolves it probe-verified (snapshot emails can be stale/absent,
  // the profile probe is authoritative) — so identity resolution must not
  // pre-block it. Everything else resolves by identity here.
  const ruleOwnedSend = !owner && isIrreversibleSendSlug(toolSlug) && Boolean(findEmailSendConstraint(toolSlug, args));
  if (cliOnlyLane && ruleOwnedSend && args.sender_override_confirmed !== true) {
    const message =
      `⚠️ NEEDS-YOUR-CHOICE: ${toolkit} was not started. A standing sender rule requires a specific verified ` +
      `account, but the Composio CLI cannot target or prove a connected_account_id. Use COMPOSIO_BACKEND=sdk ` +
      `(or AUTO) with COMPOSIO_API_KEY to honor that sender rule. The configured CLI default account was not ` +
      `substituted. No provider dispatch was started.`;
    emitComposioGatewayBlock(sid, toolSlug, 'constraint', {
      guard: 'cli-cannot-honor-standing-sender-route',
    });
    return { ok: false, reason: 'constraint', message, toolkit };
  }
  if (!owner && !ruleOwnedSend) {
    // Current-turn routing always wins. For reversible Outlook draft creation,
    // the standing sender mailbox is then a stable preference ahead of generic
    // per-slug recall; this avoids re-asking without granting send authority.
    const hint = opts.preferredIdentity ?? aliasHint ?? draftPreferredIdentity ?? recalledIdentity;
    const draftPreferenceOwnsHint = Boolean(
      draftPreference
      && draftPreferredIdentity
      && !opts.preferredIdentity
      && !aliasHint,
    );
    let outcome = selectToolkitConnection(toolSlug, conns, hint);
    if (!opts.preparedExecution
      && !opts.strictPreferredIdentity
      && (outcome.kind === 'ambiguous' || outcome.kind === 'identity-absent')) {
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
        if (draftPreferenceOwnsHint) {
          notes.push(
            `[account-route] Routed reversible Outlook draft authoring to ${hint} from standing rule #${draftPreference!.constraint.id}; sending remains separately verified.`,
          );
        } else {
          const label = aliasLabelFor(toolkit, hint);
          notes.push(`[account-route] Routed to your ${label ? `"${label}" (${hint})` : `remembered ${hint}`} ${toolkit} account.`);
        }
      }
    } else if (outcome.kind === 'ambiguous' || outcome.kind === 'identity-absent') {
      // Ask-at-most-once: an account already chosen for this toolkit IN THIS
      // RUN answers the question — the user should never be re-interrogated
      // per call for a choice they already made.
      // Stickiness answers an otherwise-open account question; it must never
      // override an exact selector. A current-turn alias and the standing
      // Outlook draft mailbox preference both own their identity hint even
      // when that mailbox is no longer live, so absence stays a typed block.
      const sticky = opts.strictPreferredIdentity || aliasArg || draftPreferenceOwnsHint
        ? undefined
        : stickyRunAccount(toolkit, usable);
      if (sticky) {
        owner = sticky.connectionId;
        identity = sticky.identity ?? identity;
        notes.push(
          `[account-route] Reusing the ${sticky.identity ?? 'account'} already chosen for ${toolkit} in this run.`,
        );
      } else {
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
    }
    // 'defer' → owner stays undefined (composio default entity).
  }

  // CONSTRAINT VALIDATION of the resolved owner (sender rules verify the
  // mailbox by live profile probe; a rule route OVERRIDES the identity pick).
  const gate = await enforceStandingConstraints(toolSlug, args, owner, {
    ...(opts.preparedExecution ? { preparedConnections: usable } : {}),
    providerProfileProbeAllowed: !opts.preparedExecution,
  });
  if (gate.block) {
    emitComposioGatewayBlock(sid, toolSlug, 'constraint');
    return { ok: false, reason: 'constraint', message: gate.block, toolkit };
  }
  let senderVerified = false;
  if (gate.routeConnectedAccountId) {
    owner = gate.routeConnectedAccountId;
    senderVerified = true;
  }
  if (cliOnlyLane && owner) {
    const message =
      `⚠️ NEEDS-YOUR-CHOICE: ${toolkit} was not started. Account policy selected connected account ${owner}, ` +
      `but the Composio CLI cannot target connected_account_id. Use COMPOSIO_BACKEND=sdk (or AUTO) with ` +
      `COMPOSIO_API_KEY to honor the verified route. No provider dispatch was started.`;
    emitComposioGatewayBlock(sid, toolSlug, 'constraint', {
      guard: 'cli-cannot-honor-verified-account-route',
    });
    return { ok: false, reason: 'constraint', message, toolkit };
  }

  // Suppression policy (skipped when the sender rule owns the route, as before).
  if (!gate.routeConnectedAccountId) {
    const ownerBeforeSuppression = owner;
    const route = applySuppressedComposioConnectionPolicy(
      toolSlug,
      owner,
      readComposioConnectionSuppressionState() as unknown as ComposioConnectionSuppressionState,
      Date.now(),
    );
    if (route.block) {
      emitComposioGatewayBlock(sid, toolSlug, 'suppressed');
      return { ok: false, reason: 'suppressed', message: route.block, toolkit };
    }
    if (opts.strictPreferredIdentity && ownerBeforeSuppression
      && route.connectedAccountId !== ownerBeforeSuppression) {
      const message = `The exact ${toolkit} account selected for this read is suppressed and cannot be replaced by a provider default. Reconnect that account and retry.`;
      emitComposioGatewayBlock(sid, toolSlug, 'suppressed', {
        guard: 'strict-preferred-identity-suppressed',
      });
      return { ok: false, reason: 'suppressed', message, toolkit };
    }
    owner = route.connectedAccountId;
    if (route.note) notes.push(route.note);
  }

  // The governed warm lane requires an addressable, exact account all the way
  // through resolution. No default, sticky, unidentified, suppressed, or
  // policy-rewritten owner may inherit the requested identity string.
  if (opts.strictPreferredIdentity) {
    let wanted = '';
    try { wanted = normalizeProcedureAccountIdentity(opts.preferredIdentity); } catch { /* block below */ }
    const selected = owner ? usable.find((connection) => connection.connectionId === owner) : undefined;
    let selectedIdentity = '';
    try { selectedIdentity = normalizeProcedureAccountIdentity(selected?.accountEmail); } catch { /* block below */ }
    if (!wanted || !owner || !selected || selectedIdentity !== wanted) {
      const message = `The exact preferred ${toolkit} account is not currently available as an active, addressable connection. No provider dispatch was started.`;
      emitComposioGatewayBlock(sid, toolSlug, 'identity-absent', {
        guard: 'strict-preferred-identity-unresolved',
      });
      return { ok: false, reason: 'identity-absent', message, toolkit };
    }
    identity = selectedIdentity;
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
    const sticky = outcome.kind === 'resolved' ? undefined : stickyRunAccount(toolkit, usable);
    if (outcome.kind === 'resolved') {
      owner = outcome.connectionId; // one distinct mailbox (e.g. duplicate re-auths) — safe
    } else if (sticky) {
      // Ask-at-most-once, send edition: exactly ONE account was chosen for
      // this toolkit in this run — a proven choice, not a guess.
      owner = sticky.connectionId;
      identity = sticky.identity ?? identity;
      notes.push(
        `[account-route] Reusing the ${sticky.identity ?? 'account'} already chosen for ${toolkit} in this run.`,
      );
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

  // Recipient normalization — CENTRAL for EVERY send lane (chat single-send,
  // workflow exact-call, batch, background — all resolve through here). The model's
  // natural `to` is mapped onto the provider's required `to_email`. This used to run
  // ONLY on the batch item path, so a single-send Outlook email dispatched with no
  // recognized recipient key and Graph fell back to the authenticated mailbox —
  // sending to the SENDER'S OWN address (2026-07-20 live incident: "sent 0 of 20,
  // misrouting every recipient as your own address"). One step here, not per-lane.
  const recipientAlias = applyEmailRecipientAliases(toolSlug, args, getCachedToolSchema(toolSlug));
  args = recipientAlias.args;
  if (recipientAlias.repairs.length > 0) notes.push(...recipientAlias.repairs);
  // Directed sends (email/SMS/chat/DM/call) require a recipient/channel. Social
  // broadcasts are different: the positively resolved SDK owner, or a deliberate
  // CLI default-account authority, IS the destination. Do not invent a synthetic
  // `target` field that the provider schema does not accept.
  const accountScopedBroadcastDestination =
    !irreversibleSendRequiresExplicitTarget(toolSlug)
    && (Boolean(owner) || (cliOnlyLane && Boolean(cliDefaultAuthority)));
  if (isIrreversibleSendSlug(toolSlug)) {
    const sendValidation = validateIrreversibleSendPayload(toolSlug, args);
    if (!sendValidation.ok) {
      const message = sendValidation.reason === 'target_missing'
        ? `⚠️ Not sent: this send has no resolvable recipient/target in its arguments. I won't dispatch a target-less send — it can't be validated and would misroute (with no target the provider falls back to your own account). Add the recipient/target and retry.`
        : `⚠️ Not sent: ${sendValidation.detail ?? 'this account-scoped publish has no meaningful provider payload.'}`;
      emitComposioGatewayBlock(sid, toolSlug, 'invalid-args', {
        field: sendValidation.reason === 'target_missing' ? 'recipient' : 'arguments',
        validationReason: sendValidation.reason === 'target_missing'
          ? 'missing-send-target'
          : 'missing-send-arguments',
      });
      return { ok: false, reason: 'invalid-args', message, toolkit };
    }
    if (!irreversibleSendRequiresExplicitTarget(toolSlug) && !accountScopedBroadcastDestination) {
      const message = `⚠️ Not sent: this account-scoped publish has no positively resolved owner account. Connect or select the destination account and retry; no provider dispatch was started.`;
      emitComposioGatewayBlock(sid, toolSlug, 'invalid-args', {
        field: 'account',
        validationReason: 'missing-account-scoped-destination',
      });
      return { ok: false, reason: 'invalid-args', message, toolkit };
    }
  }

  // Arg validation — provably-incomplete args never dispatch (any path).
  // Schema-FIRST: load this action's real contract once per session when it is
  // not cached yet, so a first-use slug is validated against the provider's own
  // required fields instead of a heuristic (live 2026-08-07: two paid 400s for
  // an APIFY_RUN_ACTOR with no actorId). Fail-open — an unavailable schema
  // simply keeps the previous heuristic behavior.
  const dispatchSchema = opts.preparedExecution
    ? getCachedToolSchema(toolSlug)
    : await ensureToolSchema(toolSlug);
  const preparedSchemaIdentity = exactProviderInputSchemaIdentity(toolSlug, dispatchSchema);
  const preparedOperationVersion = opts.preparedExecution && !cliOnlyLane
    ? liveComposioOperationVersion(toolSlug)
    : undefined;
  if (
    opts.preparedExecution
    && (
      !dispatchSchema
      || !preparedSchemaIdentity.schemaFingerprint
      || !preparedSchemaIdentity.providerInputSchemaDigest
      || (!cliOnlyLane && !preparedOperationVersion)
    )
  ) {
    const message =
      `⚠️ PREPARATION-REQUIRED: ${toolSlug} was not started because its exact current provider input `
      + 'definition is not prepared for this accepted call. Run one exact Composio search/list/describe read '
      + 'for this action, rebuild the arguments from that returned schema, then retry. No provider dispatch was started.';
    emitComposioGatewayBlock(sid, toolSlug, 'invalid-args', {
      guard: 'current-provider-definition-required',
    });
    return { ok: false, reason: 'invalid-args', message, toolkit };
  }
  if (opts.preparedExecution && !cliOnlyLane && schemaRequiresComposioFileUpload(dispatchSchema)) {
    const message =
      `⚠️ PREPARATION-REQUIRED: ${toolSlug} was not started because this action requires a file upload, `
      + 'and no separately admitted/staged upload plan is attached. Prepare the exact file transfer first, '
      + 'then retry the business action. No provider dispatch was started.';
    emitComposioGatewayBlock(sid, toolSlug, 'invalid-args', {
      guard: 'prepared-file-upload-plan-required',
    });
    return { ok: false, reason: 'invalid-args', message, toolkit };
  }
  const noArgReadRepair = repairClosedNoArgRead(toolSlug, args, dispatchSchema);
  if (noArgReadRepair) {
    args = noArgReadRepair.args;
    notes.push(noArgReadRepair.note);
  }
  const renameRepair = repairUnambiguousFieldRename(toolSlug, args, dispatchSchema);
  if (renameRepair) {
    args = renameRepair.args;
    notes.push(renameRepair.note);
  }
  const validation = validateComposioArgs(toolSlug, args, dispatchSchema);
  if (validation.error) {
    const message = formatBatchValidationError(validation.error, toolSlug, validation.mode);
    emitComposioGatewayBlock(sid, toolSlug, 'invalid-args', {
      mode: validation.mode,
      field: validation.error.field,
      validationReason: validation.error.reason,
    });
    // A refusal that never dispatched is the most repairable failure there is,
    // and the contract that would repair it is already loaded above. Handing
    // back only a banner is what turned one wrong argument into a hunt for a
    // different tool: the model could tell the call failed and not what to fix.
    return {
      ok: false,
      reason: 'invalid-args',
      message: `${message}${renderCallableContract(toolSlug, dispatchSchema)}`,
      toolkit,
    };
  }

  let accountIdentityProof: ComposioGatewayResolved['accountIdentityProof'];
  if (owner) {
    const finalConnection = usable.find((connection) => connection.connectionId === owner);
    let snapshotIdentity = '';
    let routedIdentity = '';
    try { snapshotIdentity = normalizeProcedureAccountIdentity(finalConnection?.accountEmail); } catch { /* unbound */ }
    try { routedIdentity = normalizeProcedureAccountIdentity(identity); } catch { /* unbound */ }
    if (finalConnection && snapshotIdentity
      && (!routedIdentity || routedIdentity === snapshotIdentity)) {
      identity = snapshotIdentity;
      accountIdentityProof = { connectionId: owner, identity: snapshotIdentity };
    }
  }

  // A positively resolved account is this run's answer to the account
  // question — remember it so the question is asked at most once per run.
  // CLI-only lanes are excluded (no targetable connectionId exists there).
  if (owner && !cliOnlyLane) {
    recordRunToolkitAccountUse(toolkit, owner, identity, Boolean(pinned) || Boolean(aliasArg));
  }

  // No await between validation and this capture: this is the exact contract
  // the dispatch attempt validated, not whatever happens to be live after the
  // provider returns.
  const schemaIdentity = opts.preparedExecution
    ? preparedSchemaIdentity
    : exactProviderInputSchemaIdentity(toolSlug, dispatchSchema);
  let preparedDispatch: PreparedComposioOneShotDispatch | undefined;
  if (opts.preparedExecution) {
    try {
      preparedDispatch = prepareComposioOneShotDispatch({
        toolSlug,
        args,
        connectedAccountId: owner,
        providerOperationVersion: preparedOperationVersion,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `⚠️ PREPARATION-REQUIRED: ${toolSlug} was not started. ${detail} Refresh the exact account/action readiness and retry. No provider dispatch was started.`;
      emitComposioGatewayBlock(sid, toolSlug, 'invalid-args', {
        guard: 'terminal-one-shot-preparation-required',
      });
      return { ok: false, reason: 'invalid-args', message, toolkit };
    }
  }
  return {
    ok: true,
    args,
    connectionId: owner,
    identity,
    ...schemaIdentity,
    ...(preparedOperationVersion ? { providerOperationVersion: preparedOperationVersion } : {}),
    ...(preparedDispatch ? { preparedDispatch } : {}),
    ...(accountIdentityProof ? { accountIdentityProof } : {}),
    senderVerified,
    notes,
  };
}

/**
 * One-shot gateway dispatch for non-chat paths (workflow exact-call steps,
 * Space sources/actions, batch/background helpers): resolve through the SAME
 * gateway, return the typed block untouched, otherwise dispatch exactly once.
 */
export async function dispatchComposioTool(
  toolSlug: string,
  args: Record<string, unknown>,
  opts: ComposioGatewayOptions & {
    connectedAccountId?: string;
    /** Optional exact-dispatch transaction wrapper. Used by structured
     * workflow mutations to persist intent/receipt/commit around the raw call. */
    dispatchBoundary?: ComposioDispatchBoundary;
  } = {},
): Promise<{ ok: true; result: unknown; connectionId?: string; identity?: string } | ComposioGatewayBlocked> {
  const run = harnessRunContextStorage.getStore();
  const dispatchOnce = async (): Promise<{
    ok: true; result: unknown; connectionId?: string; identity?: string;
  } | ComposioGatewayBlocked> => {
    const admittedArgs = args;
    // The gateway removes host-only routing keys in place. Keep the exact raw
    // logical input immutable for a zero-crossing refusal; successful calls
    // refine to the returned provider-ready object below.
    const resolved = await resolveComposioDispatch(
      toolSlug,
      { ...args },
      opts.connectedAccountId,
      { ...opts, preparedExecution: true },
    );
    if (!resolved.ok) {
      settleComposioPreDispatchRefusal(toolSlug, resolved.reason, admittedArgs);
      return resolved;
    }
    // Account selectors and other routing-only metadata belong to the raw
    // audit contract, not the provider payload. Freeze the gateway's exact
    // provider-ready args before the first paid crossing. Non-harness callers
    // have no ambient logical call and keep their established behavior.
    if (
      currentLogicalCall()
      && run?.sessionId
      && Number.isSafeInteger(run.sourceUserSeq)
      && (run.sourceUserSeq ?? 0) > 0
    ) {
      authorizeResolvedLogicalCallContract({
        sessionId: run.sessionId,
        sourceUserSeq: run.sourceUserSeq as number,
        turn: run.turn,
        tool: toolSlug,
        effectiveArgs: resolved.args,
      });
    }
    let providerOutcomeSettled = false;
    try {
      const providerDispatch = (): Promise<unknown> => {
        if (run?.sessionId && Number.isSafeInteger(run.sourceUserSeq) && (run.sourceUserSeq ?? 0) > 0) {
          return withPhysicalDispatch(
            {
              sessionId: run.sessionId,
              sourceUserSeq: run.sourceUserSeq as number,
              turn: run.turn,
              tool: toolSlug,
              args: resolved.args,
              trustedEffectCarrier: trustedComposioPhysicalEffectCarrier(toolSlug, resolved.args),
              sourceCapability: {
                capabilityId: `capability:composio:${toolSlug}`,
                ...(resolved.accountIdentityProof?.identity
                  ? { accountIdentity: resolved.accountIdentityProof.identity }
                  : {}),
                ...(resolved.schemaFingerprint
                  ? { schemaFingerprint: resolved.schemaFingerprint }
                  : {}),
              },
            },
            () => executePreparedComposioTool(resolved.preparedDispatch!),
          );
        }
        return executePreparedComposioTool(resolved.preparedDispatch!);
      };
      const result = opts.dispatchBoundary
        ? await opts.dispatchBoundary({
          toolSlug,
          args: resolved.args,
          connectionId: resolved.connectionId,
          identity: resolved.identity,
          schemaFingerprint: resolved.schemaFingerprint,
          providerInputSchemaDigest: resolved.providerInputSchemaDigest,
        }, providerDispatch)
        : await providerDispatch();
      const failure = detectComposioFailure(result);
      settleComposioReturned(
        toolSlug,
        resolved.args,
        canonicalComposioSettlementResult(result, failure),
      );
      providerOutcomeSettled = true;
      if (failure.failed) {
        throw new Error(`Composio tool ${toolSlug} failed: ${failure.summary || 'provider reported failure'}`);
      }
      clearReconnectBreaker(opts.sessionId, toolSlug);
      return { ok: true, result, connectionId: resolved.connectionId, identity: resolved.identity };
    } catch (err) {
      if (err instanceof ToolAttemptSettlementAuthorityError) throw err;
      // A returned failure was already settled from its structured provider
      // envelope. The Error below is only this adapter's outward disposition,
      // not a second outcome for the same logical call.
      if (!providerOutcomeSettled) {
        settleComposioThrown(
          toolSlug,
          resolved.args,
          err,
          err instanceof ExternalWritePreDispatchError
            ? { preDispatch: true, policyRefused: true }
            : {},
        );
      }
      if (isComposioReconnectRequiredError(err)) recordReconnectBreaker(opts.sessionId, toolSlug);
      throw err;
    }
  };

  if (run?.sessionId && Number.isSafeInteger(run.sourceUserSeq) && (run.sourceUserSeq ?? 0) > 0) {
    return withLogicalToolCall(
      {
        sessionId: run.sessionId,
        sourceUserSeq: run.sourceUserSeq as number,
        tool: toolSlug,
        args,
        trustedEffectCarrier: trustedComposioPhysicalEffectCarrier(toolSlug, args),
      },
      dispatchOnce,
    );
  }
  return dispatchOnce();
}

// Uniform-empty advisory (2026-07-22 Phoenix intel audit): 14 Apify calls all
// returned `{"items": []}` (successful:true) and the model reported "no Google
// Ads found" as a market finding for 5 heavy advertisers — tool silence
// presented as truth. N same-slug reads returning empty across DIFFERENT
// inputs is a QUERY-SHAPE signal, not a finding. Advisory only (guardrails
// inform, never override): the appended note steers the model to re-check the
// query and to label unverifiable absence honestly.
const emptyResultStreaks = new Map<string, number>();

export function composioResultLooksEmpty(result: unknown): boolean {
  const data = (result as { data?: unknown } | null)?.data;
  if (data == null) return false; // no data envelope ≠ an empty result
  const inner = (data as { data?: unknown }).data ?? data;
  if (inner == null) return true;
  if (Array.isArray(inner)) return inner.length === 0;
  if (typeof inner === 'object') {
    const values = Object.values(inner as Record<string, unknown>);
    if (values.length === 0) return true;
    return values.every((v) => v == null || (Array.isArray(v) && v.length === 0));
  }
  return false;
}

const EMPTY_STREAK_ADVISORY_AT = 3;

// Per-session data-quality ledger (2026-07-22, "real assistant" checkpoint):
// every read records empty-vs-total per slug, so at the WRITE boundary an
// autonomous run can be confronted with its own evidence ("Apify: 14/14
// empty") instead of shipping a deliverable with hollow columns.
interface SlugQuality { empty: number; total: number }
const dataQualityLedgers = new Map<string, Map<string, SlugQuality>>();
const dataQualityCheckpointFired = new Set<string>();

function recordDataQualityRead(sessionId: string | undefined, toolSlug: string, empty: boolean): void {
  if (!sessionId) return;
  let ledger = dataQualityLedgers.get(sessionId);
  if (!ledger) { ledger = new Map(); dataQualityLedgers.set(sessionId, ledger); }
  const entry = ledger.get(toolSlug) ?? { empty: 0, total: 0 };
  entry.total += 1;
  if (empty) entry.empty += 1;
  ledger.set(toolSlug, entry);
}

/** Slugs whose reads came back mostly empty in this session — the evidence a
 *  checkpoint confronts the model with. */
function hollowDimensions(sessionId: string | undefined): Array<{ slug: string; empty: number; total: number }> {
  const ledger = sessionId ? dataQualityLedgers.get(sessionId) : undefined;
  if (!ledger) return [];
  const hollow: Array<{ slug: string; empty: number; total: number }> = [];
  for (const [slug, q] of ledger) {
    if (q.empty >= EMPTY_STREAK_ADVISORY_AT && q.empty / q.total >= 0.5) hollow.push({ slug, ...q });
  }
  return hollow;
}

function dataQualityCheckpointEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_DATA_QUALITY_CHECKPOINT', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

/**
 * The write-boundary checkpoint for AUTONOMOUS (background) runs. When the
 * run's own ledger shows a hollow data dimension, the FIRST external write is
 * deferred with the evidence and the real-assistant fork: fix the queries, or
 * write with the gaps honestly labeled unverified. It never sends the model to
 * ask the user for search bookkeeping — a hollow read is not a user-owned edge
 * (gate-reason.ts owns those), and the read-exploration budget already permits
 * differently-shaped retries. Fires ONCE per session — a repeated write
 * attempt proceeds (with an honest-labeling note), so autonomy is redirected,
 * never dead-ended (guardrails inform, don't override).
 * Kill-switch CLEMMY_DATA_QUALITY_CHECKPOINT.
 */
function dataQualityWriteCheckpoint(
  sessionId: string | undefined,
  toolSlug: string,
): string | null {
  if (!dataQualityCheckpointEnabled()) return null;
  if (!sessionId || !sessionId.startsWith('background:')) return null;
  if (composioSlugIsReadOnly(toolSlug)) return null;
  const hollow = hollowDimensions(sessionId);
  if (hollow.length === 0) return null;
  if (dataQualityCheckpointFired.has(sessionId)) return null;
  dataQualityCheckpointFired.add(sessionId);
  const evidence = hollow.map((h) => `${h.slug}: ${h.empty}/${h.total} reads returned empty`).join('; ');
  return [
    `DATA-QUALITY CHECKPOINT — this ${toolSlug} write was NOT executed yet.`,
    `Your own read ledger for this run shows hollow data: ${evidence}. Uniform emptiness usually means the query shape was wrong, not that every subject genuinely has nothing — writing it out would ship a deliverable with false negatives.`,
    'Do ONE of the following before writing — do NOT ask the user to authorize a retry or choose for you; a hollow read is your problem to fix or label:',
    '1. Fix the source: retry the empty data source with an alternate query shape (different identifier form, head terms instead of long-tails, corrected actor input). A differently-shaped read is within your budget. If the retry returns real data, redo the affected parts and then write.',
    '2. Write honestly: proceed now with every hollow dimension explicitly labeled "unverified (tool returned empty)" in the written data — never presented as a confirmed negative — and say so plainly in your report.',
    'If you retry this exact write again it WILL proceed — the honest-labeling requirement above still applies.',
  ].join('\n');
}

/** Test-only: reset checkpoint + ledger state between cases. */
export function resetDataQualityForTest(): void {
  dataQualityLedgers.clear();
  dataQualityCheckpointFired.clear();
  emptyResultStreaks.clear();
}

function emptyStreakAdvisory(
  sessionId: string | undefined,
  toolSlug: string,
  result: unknown,
): string {
  const key = `${sessionId ?? 'nosession'}::${toolSlug}`;
  const empty = composioResultLooksEmpty(result);
  if (composioSlugIsReadOnly(toolSlug)) recordDataQualityRead(sessionId, toolSlug, empty);
  if (!empty) {
    emptyResultStreaks.delete(key);
    return '';
  }
  const streak = (emptyResultStreaks.get(key) ?? 0) + 1;
  emptyResultStreaks.set(key, streak);
  if (streak < EMPTY_STREAK_ADVISORY_AT) return '';
  return `\n\n[empty-result advisory] ${streak} consecutive ${toolSlug} calls in this session returned EMPTY results across different inputs. Uniform emptiness usually means the query shape is wrong (wrong parameter form, wrong identifier, wrong actor input) — not that every subject genuinely has nothing. Re-check the tool schema or try an alternate query form before reporting absence; if you still report it, label it "unverified (tool returned empty)" rather than a confirmed negative.`;
}

async function runComposioExecute(
  toolSlug: string,
  args: Record<string, unknown>,
  connectedAccountId: string | undefined,
  options: FormatComposioToolOutputOptions,
  hooks: {
    execute?: typeof executeComposioTool;
    delay?: (ms: number) => Promise<void>;
    skipGateway?: boolean;
    /** Narrow test authority: simulate the stable identity already resolved by
     * the gateway while still exercising the real execute→settlement path. */
    resolvedIdentityForTest?: string;
    /** Test-only seam immediately before the physical-dispatch authority gate. */
    beforePhysicalDispatchForTest?: () => void;
  } = {},
): Promise<string> {
  const runSid = sessionIdFromRunContext(options.context);
  // Open the physical attempt BEFORE validation and before the gateway, so a
  // refusal that never crossed the boundary is still correlated to something.
  // Nested carriers inherit this rather than minting a second identity.
  const attemptCtx = harnessRunContextStorage.getStore();
  if (attemptCtx?.sessionId && attemptCtx.sourceUserSeq) {
    return withLogicalToolCall(
      {
        sessionId: attemptCtx.sessionId,
        sourceUserSeq: attemptCtx.sourceUserSeq,
        tool: toolSlug,
        args,
        trustedEffectCarrier: trustedComposioPhysicalEffectCarrier(toolSlug, args),
      },
      () => runComposioExecuteInner(toolSlug, args, connectedAccountId, options, hooks),
    );
  }
  return runComposioExecuteInner(toolSlug, args, connectedAccountId, options, hooks);
}

async function runComposioExecuteInner(
  toolSlug: string,
  args: Record<string, unknown>,
  connectedAccountId: string | undefined,
  options: FormatComposioToolOutputOptions,
  hooks: {
    execute?: typeof executeComposioTool;
    delay?: (ms: number) => Promise<void>;
    skipGateway?: boolean;
    resolvedIdentityForTest?: string;
    beforePhysicalDispatchForTest?: () => void;
  } = {},
): Promise<string> {
  const runSid = sessionIdFromRunContext(options.context);
  const admittedArgs = args;
  const gatewayArgs = { ...args };
  const wait = hooks.delay ?? delayMs;
  const testSchemaIdentity = hooks.skipGateway
    ? exactProviderInputSchemaIdentity(toolSlug, getCachedToolSchema(toolSlug))
    : {};

  // THE gateway: owner-first resolution + typed blocks (ledgered). Preserve a
  // nominal in-process error so the shared write boundary can prove that no
  // provider dispatch started and release the exact reservation safely.
  const testConnectionId = hooks.resolvedIdentityForTest
    ? (connectedAccountId ?? 'ca_test_resolved_identity')
    : connectedAccountId;
  const resolved: ComposioGatewayResolution = hooks.skipGateway
    ? {
        ok: true,
        args: gatewayArgs,
        connectionId: testConnectionId,
        ...(hooks.resolvedIdentityForTest ? { identity: hooks.resolvedIdentityForTest } : {}),
        ...(hooks.resolvedIdentityForTest && testConnectionId
          ? {
              accountIdentityProof: {
                connectionId: testConnectionId,
                identity: normalizeProcedureAccountIdentity(hooks.resolvedIdentityForTest),
              },
            }
          : {}),
        ...testSchemaIdentity,
        senderVerified: false,
        notes: [],
      }
    : await resolveComposioDispatch(toolSlug, gatewayArgs, connectedAccountId, {
      sessionId: runSid,
      userInput: latestUserInputForContext(options.context),
      preparedExecution: true,
    });
  if (!resolved.ok) {
    settleComposioPreDispatchRefusal(toolSlug, resolved.reason, admittedArgs);
    // RETURN the typed refusal instead of throwing (call-tool.ts precedent):
    // a throw inside execute is swallowed by the SDK's error_as_result into
    // prose BEFORE the harness bracket can classify it, so a provably
    // never-started refusal settled `external_write_orphaned` ("may have
    // landed") and the orphan-retry gate then blocked the corrected retry —
    // the live 2026-08-06 draft-batch gauntlet (5/5 refusals orphaned, 43% of
    // the turn's tool budget burned on harness refusals, 0 drafts). A
    // resolved instance survives to settlement, `trustedNotStarted` fires,
    // and the ledger records the honest `external_write_failed` (retryable).
    return new ExternalWritePreDispatchResult(
      `[provider-dispatch:not-started:${resolved.reason}] ${resolved.message}`,
      `provider-dispatch:not-started:${resolved.reason}`,
    ) as unknown as string;
  }
  args = resolved.args;
  const resolvedRun = harnessRunContextStorage.getStore();
  if (
    currentLogicalCall()
    && resolvedRun?.sessionId
    && Number.isSafeInteger(resolvedRun.sourceUserSeq)
    && (resolvedRun.sourceUserSeq ?? 0) > 0
  ) {
    authorizeResolvedLogicalCallContract({
      sessionId: resolvedRun.sessionId,
      sourceUserSeq: resolvedRun.sourceUserSeq as number,
      turn: resolvedRun.turn,
      tool: toolSlug,
      effectiveArgs: args,
    });
  }
  const effectiveConnectionId = resolved.connectionId;
  let accountRouteNote = resolved.notes.join('\n');
  const gate = { routeConnectedAccountId: resolved.senderVerified ? resolved.connectionId : undefined };
  const documentedCreateProjection = currentDocumentedCreateProjection({
    toolSlug,
    args,
    connectionId: effectiveConnectionId,
    providerSchemaLeaseFingerprint: resolved.schemaFingerprint,
    providerInputSchemaDigest: resolved.providerInputSchemaDigest,
  });
  if (documentedCreateProjection.status === 'refused') {
    settleComposioPreDispatchRefusal(toolSlug, 'constraint', args);
    return new ExternalWritePreDispatchResult(
      `[provider-dispatch:not-started:constraint] ${documentedCreateProjection.reason}`,
      'provider-dispatch:not-started:documented-create-authority',
    ) as unknown as string;
  }

  // Real-assistant checkpoint: an autonomous run whose reads came back hollow
  // is confronted with its own ledger BEFORE its first external write, instead
  // of shipping false negatives (2026-07-22 Phoenix Airtable audit). Fires
  // once; a deliberate second attempt proceeds.
  const checkpoint = dataQualityWriteCheckpoint(runSid, toolSlug);
  // Same typed-return rule as the gateway refusal above: never started ⇒
  // settle `failed`, never `orphaned`.
  if (checkpoint) {
    // Resolution has already frozen the provider-ready contract. Settle this
    // zero-crossing policy refusal here with those exact args so an outer SDK
    // carrier neither re-settles the raw payload nor leaves the logical call
    // open.
    settleComposioPreDispatchRefusal(toolSlug, 'constraint', args);
    return new ExternalWritePreDispatchResult(
      checkpoint,
      'provider-dispatch:not-started:data-quality-checkpoint',
    ) as unknown as string;
  }

  // Tool-bound standing rules ride with EVERY call's output — the model
  // re-reads them at the moment it acts on this toolkit, independent of
  // whether memory recall surfaced them this turn.
  const constraintBanner = renderToolkitConstraintBanner(registeredToolkitOfSlug(toolSlug));

  const recentErrors: string[] = [];
  let lastError: unknown;
  // Reads are safe to retry after ambiguous transport failures. Mutations are
  // not: a timeout/5xx can arrive after the provider committed the change.
  const maxDispatchAttempts = composioSlugIsReadOnly(toolSlug) ? 3 : 1;

  // Retry loop with exponential backoff for transient errors
  let priorDispatchId: string | undefined;
  let attemptStartedAt = Date.now();
  for (let attempt = 1; attempt <= maxDispatchAttempts; attempt++) {
    attemptStartedAt = Date.now();
    try {
      hooks.beforePhysicalDispatchForTest?.();
      const preparedAttempt = hooks.execute
        ? undefined
        : attempt === 1
          ? resolved.preparedDispatch
          : prepareComposioOneShotDispatch({
              toolSlug,
              args,
              connectedAccountId: effectiveConnectionId,
              providerOperationVersion: resolved.providerOperationVersion,
            });
      if (!hooks.execute && !preparedAttempt) {
        throw new Error(`${toolSlug} terminal one-shot preparation is absent.`);
      }
      // Each pass through this loop is a PAID provider crossing. One identity
      // spanning the whole loop reported "one tool call" for up to three
      // charges, which is precisely the cost a release comparison must see.
      const result = await withPhysicalDispatch(
        {
          sessionId: runSid ?? '',
          sourceUserSeq: harnessRunContextStorage.getStore()?.sourceUserSeq ?? 0,
          turn: harnessRunContextStorage.getStore()?.turn,
          tool: toolSlug,
          args,
          trustedEffectCarrier: trustedComposioPhysicalEffectCarrier(toolSlug, args),
          sourceCapability: {
            capabilityId: `capability:composio:${toolSlug}`,
            ...(resolved.accountIdentityProof?.identity
              ? { accountIdentity: resolved.accountIdentityProof.identity }
              : {}),
            ...(resolved.schemaFingerprint
              ? { schemaFingerprint: resolved.schemaFingerprint }
              : {}),
          },
          ...(priorDispatchId ? { retryOf: priorDispatchId } : {}),
        },
        async (crossing) => {
          priorDispatchId = crossing.physicalDispatchId;
          if (hooks.execute) return hooks.execute(toolSlug, args, effectiveConnectionId);
          return executePreparedComposioTool(preparedAttempt!);
        },
      );
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

      // PHASE 5: Record outcome for adaptive tool selection & learning
      const failure = detectComposioFailure(result);
      // What (if anything) this dispatch SETTLED to. Learning consumes only
      // this, and only after failure detection and async resolution have had
      // their say — a wire result is not a settlement.
      let settledForLearning: unknown = failure.failed ? null : result;
      const canonicalSettlementResult = canonicalComposioSettlementResult(result, failure);
      if (failure.failed) {
        output += suppressComposioConnectionAfterHardFailure(effectiveConnectionId, result);
        // F2: a not-connected RESULT (returned, not thrown) also trips the breaker.
        if (isComposioReconnectRequiredError(result)) recordReconnectBreaker(sid, toolSlug);
        if (failure.notConnected) output += preparedConnectionGroundTruthNote(toolSlug);
      } else {
        // F2: a genuine success proves the toolkit is reachable again → reset.
        clearReconnectBreaker(sid, toolSlug);
        output += emptyStreakAdvisory(sid, toolSlug, result);
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

      // A queued receipt is continuation evidence, never permission for hidden
      // provider work. Polling/getter discovery used to call the raw dispatcher
      // again under this same logical call, so N paid polls appeared as one
      // physical attempt (and a mid-poll crash had no exact row to reconcile).
      // Surface the exact id-bearing receipt now. A later poll must be admitted
      // as its own normal logical call; a background watcher needs its own
      // separately authorized kernel before it may resume automatically.
      if (!failure.failed) {
        const receipt = detectJobReceipt(toolSlug, result);
        if (receipt) {
          settledForLearning = null;
          output = `${asyncReceiptBanner(receipt)}\n\n${output}`;
          if (receipt.generic) {
            recordOperationalEvent({
              source: 'tool',
              type: 'composio_async_generic_detected',
              severity: 'info',
              sessionId: sid,
              payload: {
                slug: toolSlug,
                toolkit: registeredToolkitOfSlug(toolSlug),
                jobId: receipt.jobId,
                status: receipt.status,
                outcome: 'banner',
              },
            });
          }
        }
      }

      // Verified-read settlement (A-series): learning happens HERE — after
      // canonical failure detection and receipt classification — from the
      // FINAL settled payload, through a durable receipt. A receipt shape that
      // slipped past the resolve gate (flag off, unknown family) still never
      // reads as data. Best-effort: learning never affects the tool result.
      try {
        if (sid && settledForLearning !== null && settledForLearning !== undefined
          && !detectJobReceipt(toolSlug, settledForLearning)) {
          const runContext = harnessRunContextStorage.getStore();
          settleVerifiedComposioRead({
            toolSlug,
            sessionId: sid,
            result: settledForLearning,
            // The run context's sequence is authoritative when this dispatch
            // runs inside the accepted turn. Without it, the session's LIVE
            // attempt row supplies its own durably bound source.
            ...(runContext?.sessionId === sid && typeof runContext.sourceUserSeq === 'number'
              ? { sourceUserSeq: runContext.sourceUserSeq }
              : {}),
            accountIdentity: resolved.accountIdentityProof?.identity,
            schemaFingerprint: resolved.schemaFingerprint,
            normalizedArgs: args,
          });
        }
      } catch { /* learning never breaks a tool call */ }

      // Settle after async receipt handling has determined whether this logical
      // call produced final data or only a continuation. Runtime truth remains
      // synchronous with dispatch; procedural learning is deliberately not on
      // the authority path.
      const finalSettlementResult = settledForLearning ?? canonicalSettlementResult;
      let settlementResult = finalSettlementResult;
      let settlementSignals: AttemptSignals = {};
      if (documentedCreateProjection.status === 'ready' && !failure.failed) {
        const projected = projectDocumentedCreateResult(
          documentedCreateProjection.admission,
          finalSettlementResult,
        );
        if (projected.status === 'projected') {
          settlementResult = projected.value;
        } else {
          // The paid mutation returned, but the response cannot identify one
          // exact created artifact. Retain those raw bytes while classifying
          // the effect as uncertain; never redispatch the same create.
          settlementResult = projected.rawProviderResult;
          settlementSignals = { acknowledged: false };
        }
      }
      settleComposioReturned(
        toolSlug,
        args,
        settlementResult,
        !failure.failed && settledForLearning == null,
        settlementSignals,
      );
      void maybeAutoRememberComposioChoice(
        toolSlug,
        args,
        finalSettlementResult,
        sid,
        effectiveConnectionId,
      );

      // Only count/advise on SUCCESS — a failed call isn't "an item processed".
      //
      // A nested carrier already owns its result shape. Appending
      // prose to its machine-readable JSON corrupts the return shape (the
      // caller receives a string instead of the provider object) and can turn
      // a successful batch read into a blocked workflow step. Keep every
      // advisory out-of-band for that lane by not producing one here at all.
      if (!failure.failed && harnessRunContextStorage.getStore()?.nestedDispatch !== true) {
        // P1-D — a schema/describe execute is DISCOVERY, not per-item work. Route
        // it to the discovery advisory (which counts repeated describes of one
        // toolkit) and skip the fan-out advisory so the two never double-fire on
        // the same call. All other executes keep the fan-out advisory unchanged.
        if (isDescribeSlug(toolSlug)) {
          const advisory = maybeDiscoveryAdvisory({
            kind: 'describe',
            toolkit: registeredToolkitOfSlug(toolSlug),
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
      if (err instanceof ToolAttemptSettlementAuthorityError) throw err;

      // beginPhysicalDispatch is an authority boundary. Its nominal refusal
      // proves the provider callback was never entered, but this class used to
      // fall through to generic corrective prose. Across work_call that prose
      // looked like a successful host return and minted a false result handle.
      if (err instanceof PhysicalDispatchPreDispatchError) {
        const reason = err.reason.startsWith('work_binding_required')
          ? 'work-binding'
          : 'dispatch-authority';
        settleComposioThrown(toolSlug, args, err, {
          preDispatch: true,
          policyRefused: true,
        });
        return new ExternalWritePreDispatchResult(
          `[provider-dispatch:not-started:${reason}] ${err.message}`,
          `provider-dispatch:not-started:${reason}`,
        ) as unknown as string;
      }
      lastError = err;
      const errorMsg = err instanceof Error ? err.message : String(err ?? '');
      recentErrors.push(errorMsg);

      // Preserve nominal pre-dispatch provenance for the shared write boundary
      // as a RETURNED typed result — a rethrow here is swallowed into prose by
      // the SDK's error_as_result BEFORE the bracket can see it (the exact
      // mechanism that orphaned the 2026-08-06 draft batch), while a resolved
      // instance survives to settlement and records the honest `failed`.
      if (err instanceof ExternalWritePreDispatchError) {
        return new ExternalWritePreDispatchResult(
          err.message,
          'local_pre_dispatch_refusal',
        ) as unknown as string;
      }

      // Entity/user mismatches and NoActiveConnection are deterministic. In
      // particular, do not spend the generic retry budget repeating a call
      // that can only be repaired by reconnecting the app under this user.
      if (isComposioReconnectRequiredError(err)) {
        recordReconnectBreaker(runSid, toolSlug); // F2: trip the cross-call breaker
        // Nominal: this lane KNOWS the connection is the problem, so the shared
        // kernel is told rather than left to infer it from the message.
        settleComposioThrown(toolSlug, args, err, { connectionMissing: true });
        return composioThrownErrorOutput(err, { ...options, toolSlug })
          + suppressComposioConnectionAfterHardFailure(effectiveConnectionId, err);
      }

      if (!composioSlugIsReadOnly(toolSlug)) {
        settleComposioThrown(toolSlug, args, err, { mutating: true, acknowledged: false });
        return composioUncertainMutationOutput(err, { ...options, toolSlug });
      }

      // Check if we should retry
      const decision = shouldRetryToolCall(err, attempt, recentErrors, Date.now() - attemptStartedAt);
      if (!decision.shouldRetry) {
        // Terminal error or circuit-breaker triggered: return error immediately
        settleComposioThrown(
          toolSlug,
          args,
          err,
          // A long timeout leaves the remote work UNRESOLVED, not failed: the
          // job it started may still be running. Say so in the settlement so
          // recovery never reads it as a proven miss.
          decision.remoteMayStillBeRunning ? { acknowledged: false } : {},
        );
        return composioThrownErrorOutput(err, { ...options, toolSlug })
          // The refusal carries the fix: check what it started, or switch to
          // an async start + poll — never repeat the identical wait.
          + (decision.remoteMayStillBeRunning ? `\n\n[retry-policy] ${decision.reason}` : '')
          + suppressComposioConnectionAfterHardFailure(effectiveConnectionId, err);
      }

      // Transient error: wait and retry
      if (attempt < maxDispatchAttempts) {
        await wait(decision.delayMs);
      }
    }
  }

  // Max retries exhausted: return last error
  settleComposioThrown(toolSlug, args, lastError);
  return composioThrownErrorOutput(lastError, { ...options, toolSlug });
}

/** Narrow dispatch harness for the ambiguity regression test. It deliberately
 * bypasses account resolution (which is proven pre-dispatch) and exercises the
 * same production retry loop with an injected provider executor. */
export function runComposioExecuteForTest(
  toolSlug: string,
  args: Record<string, unknown>,
  execute: typeof executeComposioTool,
): Promise<string> {
  return runComposioExecute(toolSlug, args, undefined, { toolName: 'composio_execute_tool', toolSlug }, {
    execute,
    delay: async () => {},
    skipGateway: true,
  });
}

/** Test twin that pins the run-context session — for behaviors keyed on the
 *  session lane (data-quality checkpoint, per-session ledgers). */
export function runComposioExecuteForTestInSession(
  toolSlug: string,
  args: Record<string, unknown>,
  execute: typeof executeComposioTool,
  sessionId: string,
  resolvedIdentityForTest?: string,
  beforePhysicalDispatchForTest?: () => void,
): Promise<string> {
  return runComposioExecute(
    toolSlug,
    args,
    undefined,
    { toolName: 'composio_execute_tool', toolSlug, context: { context: { sessionId } } as never },
    {
      execute,
      delay: async () => {},
      skipGateway: true,
      resolvedIdentityForTest,
      beforePhysicalDispatchForTest,
    },
  );
}

/** Test twin that keeps the real owner/connection gateway enabled. */
export function runComposioExecuteWithGatewayForTest(
  toolSlug: string,
  args: Record<string, unknown>,
  execute: typeof executeComposioTool,
  sessionId: string,
): Promise<string> {
  return runComposioExecute(
    toolSlug,
    args,
    undefined,
    { toolName: 'composio_execute_tool', toolSlug, context: { context: { sessionId } } as never },
    { execute, delay: async () => {} },
  );
}

/**
 * Read the carrier's `arguments` payload through the ONE canonical adapter.
 *
 * The 2026-08-02 calendar incident spent four pre-dispatch failures on
 * representation rather than meaning — `arguments` as an object, `slug` for
 * `tool_slug`, an `arguments_json` nesting, an object again. Those are the same
 * call written four ways, and re-teaching the transport each time is what made
 * a 2.1s provider read cost 52s.
 *
 * So drift is repaired here, deterministically, and a genuine mistake is
 * refused with the authoritative contract attached rather than a bare
 * "invalid" the caller can only respond to by guessing again.
 */
function parseArgumentsJson(value: string | null | undefined): Record<string, unknown> {
  const normalized = normalizeComposioArgsPayload(value ?? null);
  if (!normalized.ok) {
    throw new Error(describeCarrierRefusal(normalized));
  }
  return normalized.args;
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

/**
 * Normalize the published CLI's search response into the same compact match
 * shape as the SDK catalog. CLI releases have used both arrays and nested
 * `{items|tools|results}` envelopes, so this walks data rather than binding the
 * runtime to one presentation wrapper. Only action-shaped slugs are admitted;
 * toolkit/catalog rows such as `{slug:"gmail"}` are never executable matches.
 */
export function normalizeComposioCliSearchMatches(
  value: unknown,
  query: string,
  limit = DEFAULT_SEARCH_TOTAL_LIMIT,
): ComposioCliSearchMatch[] {
  const queryTerms = tokenize(query);
  const bySlug = new Map<string, ComposioCliSearchMatch>();
  const seenObjects = new Set<object>();
  let visited = 0;

  const actionSlug = (candidate: unknown): string | undefined => {
    if (typeof candidate !== 'string') return undefined;
    const normalized = candidate.trim();
    return /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/.test(normalized)
      ? normalized.toUpperCase()
      : undefined;
  };
  const stringField = (record: Record<string, unknown>, ...keys: string[]): string | undefined => {
    for (const key of keys) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return undefined;
  };
  const ingest = (record: Record<string, unknown>): void => {
    const explicitSlug = record.tool_slug ?? record.toolSlug;
    const carriesInlineSchema = record.inputParameters !== undefined
      || record.input_parameters !== undefined
      || record.parameters !== undefined
      || record.schema !== undefined;
    const legacySlug = carriesInlineSchema
      && typeof record.slug === 'string'
      && record.slug.trim() === record.slug.trim().toUpperCase()
      ? record.slug
      : undefined;
    const slug = actionSlug(explicitSlug ?? legacySlug);
    if (!slug) return;
    const toolkitRecord = isRecord(record.toolkit) ? record.toolkit : undefined;
    const toolkit = (
      stringField(record, 'toolkit_slug', 'toolkitSlug')
      ?? (toolkitRecord ? stringField(toolkitRecord, 'slug', 'name') : undefined)
      ?? registeredToolkitOfSlug(slug)
    ).toLowerCase();
    const name = stringField(record, 'name', 'display_name', 'displayName') ?? slug;
    const description = stringField(record, 'description', 'summary');
    const inputParameters = record.inputParameters
      ?? record.input_parameters
      ?? record.parameters
      ?? record.schema;
    const providerScore = typeof record.score === 'number' && Number.isFinite(record.score)
      ? record.score
      : undefined;
    const match: ComposioCliSearchMatch = {
      toolkit,
      slug,
      name,
      ...(description ? { description } : {}),
      score: providerScore ?? Math.max(1, scoreComposioTool(toolkit, slug, name, description, queryTerms)),
      ...(inputParameters !== undefined ? { inputParameters } : {}),
    };
    const prior = bySlug.get(slug);
    if (!prior || match.score > prior.score || (prior.inputParameters === undefined && match.inputParameters !== undefined)) {
      bySlug.set(slug, match);
    }
  };
  const visit = (node: unknown, depth: number): void => {
    if (depth > 8 || visited >= 2_000 || node === null || node === undefined) return;
    visited += 1;
    if (typeof node === 'string') {
      const trimmed = node.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { visit(JSON.parse(trimmed), depth + 1); } catch { /* plain CLI text below */ }
      }
      return;
    }
    if (typeof node !== 'object') return;
    if (seenObjects.has(node)) return;
    seenObjects.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    ingest(record);
    for (const key of ['primary_tool_slugs', 'related_tool_slugs']) {
      const slugs = record[key];
      if (!Array.isArray(slugs)) continue;
      for (const slug of slugs) ingest({ tool_slug: slug });
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === 'primary_tool_slugs' || key === 'related_tool_slugs') continue;
      if (child && (typeof child === 'object' || typeof child === 'string')) visit(child, depth + 1);
    }
  };

  visit(value, 0);
  return [...bySlug.values()]
    .slice(0, Math.max(1, Math.min(limit, 50)));
}

/**
 * The current published CLI returns primary slugs plus schema-file paths under
 * `~/.composio/tool_definitions`; it does not inline `inputParameters` in the
 * search JSON. Hydrate only paths explicitly mapped to returned slugs, and
 * only after both the schema root and file resolve inside that root. This
 * keeps CLI output from becoming an arbitrary local-file read primitive.
 */
export function hydrateComposioCliSearchSchemas(
  value: unknown,
  matches: readonly ComposioCliSearchMatch[],
  homeDir = os.homedir(),
): ComposioCliSearchMatch[] {
  const wanted = new Set(matches.map((match) => match.slug));
  const paths = new Map<string, string>();
  const actionSlug = (candidate: string): string | undefined => {
    const normalized = candidate.trim();
    return /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/.test(normalized)
      ? normalized.toUpperCase()
      : undefined;
  };
  let root = value;
  if (typeof root === 'string') {
    try { root = JSON.parse(root) as unknown; } catch { root = null; }
  }
  const toolSchemas = isRecord(root) && isRecord(root.tool_schemas) ? root.tool_schemas : undefined;
  const primary = toolSchemas && isRecord(toolSchemas.primary) ? toolSchemas.primary : undefined;
  for (const [key, child] of Object.entries(primary ?? {})) {
    const slug = actionSlug(key);
    if (slug && wanted.has(slug) && typeof child === 'string') paths.set(slug, child);
  }

  let schemaRoot: string;
  try {
    schemaRoot = realpathSync(path.resolve(homeDir, '.composio', 'tool_definitions'));
  } catch {
    return matches.map((match) => ({ ...match }));
  }
  const hydrated = new Map<string, unknown>();
  for (const [slug, rawPath] of paths) {
    const expanded = rawPath === '~'
      ? homeDir
      : rawPath.startsWith('~/') || rawPath.startsWith(`~${path.sep}`)
        ? path.join(homeDir, rawPath.slice(2))
        : rawPath;
    if (!path.isAbsolute(expanded)) continue;
    let file: string;
    try {
      file = realpathSync(path.resolve(expanded));
      if (file !== schemaRoot && !file.startsWith(`${schemaRoot}${path.sep}`)) continue;
      if (path.basename(file).toUpperCase() !== `${slug}.JSON`) continue;
      const stat = statSync(file);
      if (!stat.isFile() || stat.size <= 0 || stat.size > 1_000_000) continue;
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (!isRecord(parsed)) continue;
      const schema = parsed.inputSchema
        ?? parsed.input_schema
        ?? parsed.inputParameters
        ?? parsed.input_parameters
        ?? ((parsed.type === 'object' || isRecord(parsed.properties)) ? parsed : undefined);
      if (isRecord(schema)) hydrated.set(slug, schema);
    } catch {
      // A missing, malformed, oversized, or escaped schema stays unavailable.
    }
  }
  return matches.map((match) => {
    const schema = hydrated.get(match.slug) ?? match.inputParameters;
    return schema === undefined ? { ...match } : { ...match, inputParameters: schema };
  });
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
    : `${tag} Composio action ${toolSlug}. Call this directly when the fields are clear. If its exact schema is missing or validation rejects the call, inspect this exact action once and repair the arguments; do not run broad discovery.`;
  // Tool-bound standing rules live IN the tool description: the model cannot
  // form a call to this tool without the rule in view, every single turn.
  const banner = renderToolkitConstraintBanner(toolkitSlug);
  return banner ? `${base}\n${banner}` : base;
}

export interface ComposioBrokerCandidate {
  toolkit: string;
  slug: string;
  name: string;
  description?: string;
  score: number;
  inputParameters: unknown;
}

/** Read-only provider adapter for the federated tool_search broker. It returns
 * only schema-backed actions from the user's live connected Composio catalog;
 * the broker remains provider-neutral and execution still goes through the
 * ordinary composio_execute_tool/work_call boundary. */
export async function searchComposioBrokerCandidates(
  query: string,
  limit = DEFAULT_SEARCH_TOTAL_LIMIT,
): Promise<ComposioBrokerCandidate[]> {
  const maxResults = Math.max(1, Math.min(
    limit,
    COMPOSIO_LIVE_SEARCH_RETURN_LIMIT,
  ));
  const credentials = getComposioCredentialStatus();
  if (composioExecutionUsesCliOnlyLane(credentials)) {
    const runtime = await getComposioRuntimeStatus();
    if (!runtime.cli.installed || !runtime.cli.authenticated) return [];
    const raw = await searchComposioToolsViaCli(query, { limit: maxResults });
    const hydrated = hydrateComposioCliSearchSchemas(
      raw,
      normalizeComposioCliSearchMatches(raw, query, maxResults),
    ).filter((candidate) => candidate.inputParameters !== undefined);
    const observedAt = Date.now();
    for (const candidate of hydrated) {
      rememberToolSchema(candidate.slug, candidate.inputParameters, observedAt);
    }
    return hydrated
      .map((candidate) => ({
        toolkit: candidate.toolkit,
        slug: candidate.slug,
        name: candidate.name,
        ...(candidate.description ? { description: candidate.description } : {}),
        score: candidate.score,
        inputParameters: candidate.inputParameters,
      }));
  }
  if (!credentials.enabled) return [];

  const connections = await listUsableConnectedToolkits();
  const toolkits = [...new Set(connections.map((connection) => connection.slug).filter(Boolean))];
  if (toolkits.length === 0) return [];
  const queryTerms = tokenize(query);
  let searched;
  try {
    searched = await searchConnectedComposioTools(
      toolkits,
      query,
      COMPOSIO_LIVE_SEARCH_OVERSAMPLE_LIMIT,
    );
  } catch (error) {
    // A failed filtered search is a failed discovery attempt. Falling back to
    // an unfiltered toolkit page both misses large-catalog tails and turns one
    // bounded role lookup into foreground enumeration.
    if (error instanceof ComposioSearchProviderContractError) throw error;
    return [];
  }
  for (const candidate of searched) {
    if (candidate.inputParameters === undefined) continue;
    rememberToolSchema(
      candidate.slug,
      candidate.inputParameters,
      composioToolSchemaObservedAt(candidate) ?? Date.now(),
      composioToolOperationVersion(candidate),
      ...(Object.prototype.hasOwnProperty.call(candidate, 'outputParameters')
        && candidate.outputParameters !== undefined
        ? [candidate.outputParameters]
        : []),
    );
  }
  return searched
    .map((candidate) => ({
      toolkit: candidate.toolkitSlug ?? registeredToolkitOfSlug(candidate.slug),
      slug: candidate.slug,
      name: candidate.name,
      ...(candidate.description ? { description: candidate.description } : {}),
      score: scoreComposioTool(
        candidate.toolkitSlug ?? registeredToolkitOfSlug(candidate.slug),
        candidate.slug,
        candidate.name,
        candidate.description,
        queryTerms,
      ),
      inputParameters: candidate.inputParameters,
    }))
    .filter((candidate) => queryTerms.length === 0 || candidate.score > 0)
    .filter((candidate) => candidate.slug && candidate.inputParameters !== undefined)
    .sort((left, right) => right.score - left.score || left.slug.localeCompare(right.slug))
    .slice(0, maxResults);
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
      rememberToolSchema(
        toolSlug,
        toolkitTool.inputParameters,
        composioToolSchemaObservedAt(toolkitTool) ?? Number.NaN,
        composioToolOperationVersion(toolkitTool),
        ...(Object.prototype.hasOwnProperty.call(toolkitTool, 'outputParameters')
          && toolkitTool.outputParameters !== undefined
          ? [toolkitTool.outputParameters]
          : []),
      );
      out.push(attestTerminalPhysicalDispatchOwner(tool({
        name,
        description: describeDynamicTool(toolkitSlug, toolSlug, toolkitTool.description),
        parameters: normalizeJsonSchemaObject(toolkitTool.inputParameters) as any,
        strict: false,
        // Unified taxonomy: cx_<slug> classifies via the Composio slug
        // (read for GET/LIST/etc., send for everything else), then
        // consults the scope policy (yolo → auto, strict → ask, etc.).
        needsApproval: needsApprovalFromTaxonomy(name),
        // Same typed-refusal safety net as composio_execute_tool.
        errorFunction: (_context, error) => {
          if (error instanceof ExternalWritePreDispatchError) throw error;
          const details = error instanceof Error ? error.toString() : String(error);
          return `An error occurred while running the tool. Please try again. Error: ${details}`;
        },
        execute: async (input, context, details) => runComposioExecute(
          toolSlug,
          normalizeToolInput(input),
          defaultConnectionId,
          { context, details, toolName: name },
        ),
      })));
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
      for (const item of tools) {
        rememberToolSchema(
          item.slug,
          item.inputParameters,
          composioToolSchemaObservedAt(item) ?? Number.NaN,
          composioToolOperationVersion(item),
          ...(Object.prototype.hasOwnProperty.call(item, 'outputParameters')
            && item.outputParameters !== undefined
            ? [item.outputParameters]
            : []),
        );
      }
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
      toolkit_slug = normalizeOptionalToolkitSlug(toolkit_slug);
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
          const remembered = recallComposioForSearch(query, { limit: limit ?? undefined });
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
              matches: remembered.map((m) => {
                // E4 subtraction: a slug with an ACTIVE structural procedure
                // artifact is owned by the verified read lane — the prose
                // args-template advisory is subtracted for that key so two
                // authorities never serve one eligible operation. Slugs
                // without a proven artifact keep the historical advisory.
                const structurallyOwned = hasActiveStructuralProcedureForIdentifier(m.slug);
                const template = !structurallyOwned && m.invocationTemplate
                  ? ` Prior args template: ${m.invocationTemplate.slice(0, 400)}`
                  : '';
                return {
                  toolkit: registeredToolkitOfSlug(m.slug),
                  slug: m.slug,
                  name: m.slug,
                  score: 1,
                  description: `Remembered from ${m.successCount} prior success${m.successCount === 1 ? '' : 'es'} on this machine (matched intent "${m.intent}"). Call composio_execute_tool with this slug — no rediscovery needed.${template}`,
                };
              }),
              message:
                `Matched ${remembered.length} tool(s) from tool-choice memory — skipped Composio discovery (saved a multi-call search). ` +
                'If a remembered slug fails on execute, call composio_search_tools again with a more specific query, or tool_choice_invalidate to force fresh discovery.',
            }, { context, details, toolName: 'composio_search_tools' });
          }
        } catch { /* memory consult is best-effort — fall through to live search */ }
      }

      const credentials = getComposioCredentialStatus();
      const cliOnlyLane = composioExecutionUsesCliOnlyLane(credentials);
      if (cliOnlyLane) {
        const runtime = await getComposioRuntimeStatus();
        if (runtime.cli.installed && runtime.cli.authenticated) {
          const maxResults = Math.max(1, Math.min(
            limit ?? DEFAULT_SEARCH_TOTAL_LIMIT,
            COMPOSIO_LIVE_SEARCH_RETURN_LIMIT,
          ));
          // Order authority by request start, not response completion. An older
          // slow search must never finish last and look newer than a later one.
          const observedAt = Date.now();
          const raw = await searchComposioToolsViaCli(query, {
            ...(toolkit_slug ? { toolkitSlug: toolkit_slug } : {}),
            limit: maxResults,
          });
          const discoveredMatches = hydrateComposioCliSearchSchemas(
            raw,
            normalizeComposioCliSearchMatches(raw, query, maxResults),
          );
          // The published CLI guarantees local schema files for PRIMARY
          // results only. Related slugs are useful search hints, but without a
          // hydrated contract they are not executable authority and must not
          // enter tool-choice memory as if the model could safely build args.
          const matches = discoveredMatches.filter((match) => match.inputParameters !== undefined);
          const schemaLessCandidates = discoveredMatches
            .filter((match) => match.inputParameters === undefined)
            .map(({ toolkit, slug, name, description, score }) => ({
              toolkit, slug, name, ...(description ? { description } : {}), score,
              status: 'schema_unavailable',
            }));
          for (const match of matches) {
            if (match.inputParameters !== undefined) {
              rememberToolSchema(match.slug, match.inputParameters, observedAt);
            }
          }
          noteComposioSearchIntent(
            sessionIdFromRunContext(context),
            query,
            matches.map((match) => match.slug),
          );
          recordDiscoveredComposioCapabilities(matches);
          const output = formatComposioToolOutput({
            configured: true,
            discoveryBackend: 'cli',
            accountRoute: 'provider_default',
            query,
            count: matches.length,
            // CONSEQUENCE, as data. A caller who asked to change something and
            // is offered only a way to create something new is being offered a
            // materially different outcome; surfacing each candidate's declared
            // consequence lets that be noticed and raised with the user rather
            // than discovered after the fact. Derived from the action's own
            // verb — no provider names, no slug lists.
            matches: matches.map((match) => ({
              ...match,
              consequence: classifyComposioActionConsequence(match.slug),
            })),
            ...(schemaLessCandidates.length > 0 ? { schemaLessCandidates } : {}),
            nextStep: matches.length > 0
              ? 'Pick the best match, then call `composio_execute_tool` with its exact slug and arguments built from `inputParameters`.'
              : schemaLessCandidates.length > 0
                ? 'The CLI returned related candidates without executable schemas. Refine this one search until a primary schema-backed match appears; do not execute or memorize a schema-less slug.'
                : 'No CLI action matched. Refine this one query or connect the required app; do not invent a slug.',
          }, { context, details, toolName: 'composio_search_tools' });
          const advisory = maybeDiscoveryAdvisory({
            kind: 'search',
            toolkit: toolkit_slug ?? matches[0]?.toolkit ?? schemaLessCandidates[0]?.toolkit ?? '*',
            signature: query,
            sessionId: runScopeIdFromRunContext(context) ?? sessionIdFromRunContext(context),
          });
          return advisory ? output + advisory : output;
        }
        if (credentials.executionBackend === 'cli') {
          return formatComposioToolOutput({
            configured: false,
            discoveryBackend: 'cli',
            query,
            matches: [],
            message: runtime.cli.installed
              ? 'The Composio CLI is installed but not authenticated. Run `composio login`, then retry this same search.'
              : 'The Composio CLI backend is selected but the CLI is not installed.',
          }, { context, details, toolName: 'composio_search_tools' });
        }
      }
      if (!credentials.enabled) {
        return formatComposioToolOutput({
          configured: false,
          message: cliOnlyLane
            ? 'Neither an authenticated Composio CLI session nor COMPOSIO_API_KEY is available. Connect Composio first.'
            : 'COMPOSIO_API_KEY is not configured. Connect Composio in the dashboard first.',
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
        ? allConnections
            .map((connection) => connection.slug)
            .filter((slug) => slug.toLowerCase() === toolkit_slug!.toLowerCase())
        : [...new Set(allConnections.map((connection) => connection.slug))];
      if (targetToolkits.length === 0) {
        return formatComposioToolOutput({
          configured: true,
          connectedToolkits: [...new Set(allConnections.map((connection) => connection.slug))],
          query,
          count: 0,
          matches: [],
          message: `Toolkit ${toolkit_slug ?? '(unknown)'} is not connected for this user. Connect it before searching its actions.`,
        }, { context, details, toolName: 'composio_search_tools' });
      }
      const queryTerms = tokenize(query);
      const maxResults = Math.max(1, Math.min(
        limit ?? DEFAULT_SEARCH_TOTAL_LIMIT,
        COMPOSIO_LIVE_SEARCH_RETURN_LIMIT,
      ));
      const matches: Array<{
        toolkit: string;
        slug: string;
        name: string;
        description?: string;
        score: number;
        inputParameters?: unknown;
      }> = [];
      let filteredSearchError: string | undefined;

      try {
        const tools = await searchConnectedComposioTools(
          targetToolkits,
          query,
          COMPOSIO_LIVE_SEARCH_OVERSAMPLE_LIMIT,
        );
        for (const item of tools) {
          if (item.inputParameters === undefined) continue;
          rememberToolSchema(
            item.slug,
            item.inputParameters,
            composioToolSchemaObservedAt(item) ?? Number.NaN,
            composioToolOperationVersion(item),
            ...(Object.prototype.hasOwnProperty.call(item, 'outputParameters')
              && item.outputParameters !== undefined
              ? [item.outputParameters]
              : []),
          );
          const toolkit = item.toolkitSlug ?? registeredToolkitOfSlug(item.slug);
          const score = scoreComposioTool(
            toolkit,
            item.slug,
            item.name,
            item.description,
            queryTerms,
          );
          if (queryTerms.length > 0 && score <= 0) continue;
          matches.push({
            toolkit,
            slug: item.slug,
            name: item.name,
            description: item.description,
            score,
            inputParameters: item.inputParameters,
          });
        }
      } catch (error) {
        filteredSearchError = error instanceof Error ? error.message : String(error);
      }

      matches.sort((left, right) => right.score - left.score || left.slug.localeCompare(right.slug));
      const visibleMatches = matches.slice(0, maxResults);
      // (A) v0.5.64 — record this discovery query AND the candidate slugs it
      // surfaced, so a following successful execute only auto-remembers a slug
      // the search actually returned (see maybeAutoRememberComposioChoice). This
      // is what prevents an unrelated fallback from poisoning the intent.
      noteComposioSearchIntent(
        sessionIdFromRunContext(context),
        query,
        visibleMatches.map((m) => m.slug),
      );
      recordDiscoveredComposioCapabilities(visibleMatches);
      const realMatchCount = matches.filter(
        (m) => m.slug && m.score > 0,
      ).length;
      const searchMessage = filteredSearchError
        ? `The bounded live Composio search failed before returning candidates: ${filteredSearchError}`
        : realMatchCount === 0
          ? `No action in the connected toolkits matched "${query}". Refine this one role search or connect the required app; do not invent a slug.`
          : undefined;
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
        count: visibleMatches.length,
        totalMatches: matches.length,
        ...(matches.length > maxResults
          ? { truncatedNote: `Showing the top ${maxResults} of ${matches.length} ranked matches — if the tool you need isn't listed, narrow the query or pass toolkit_slug.` }
          : {}),
        matches: visibleMatches,
        ...(searchMessage ? { message: searchMessage } : {}),
        nextStep: 'Pick the best match, then call `composio_execute_tool` with `tool_slug` set to the exact slug from this result and `arguments` as a JSON object string built from the action\'s `inputParameters` schema.',
      }, { context, details, toolName: 'composio_search_tools' });
      // Tool-bound standing rules surface at DISCOVERY time — the moment the
      // model picks a slug, right before it forms the execute call.
      const matchedToolkits = new Set(
        visibleMatches
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
        toolkit: toolkit_slug ?? visibleMatches[0]?.toolkit ?? '*',
        signature: query,
        sessionId: runScopeIdFromRunContext(context) ?? sessionIdFromRunContext(context),
      });
      return advisory ? output + advisory : output;
    },
  });

  const composio_execute_tool = attestTerminalPhysicalDispatchOwner(tool({
    name: 'composio_execute_tool',
    description: 'Execute any Composio action by exact slug (Outlook list-mail, Gmail search, Drive search, Salesforce query, etc.). Use an exact slug already supplied by the runtime or a proven capability directly. Never invent a slug: when this requirement is unresolved, use the single discovery broker once, then pass its exact result here. If the slug is known but its arguments fail validation, inspect that exact action once and repair the call instead of broad-searching again. Arguments must be a JSON object string. Uses the connected OAuth account and approval policy. FILES: actions that return files (attachment/export downloads) save them locally and include the local `filePath` in the result — pass that exact path onward; file-input params (uploads, attachments) accept a local file path string, so download→upload flows (e.g. Outlook attachment → Drive) chain the returned filePath directly.',
    parameters: z.object(COMPOSIO_EXECUTE_TOOL_PARAMS),
    // Taxonomy reads `tool_slug` from args to decide read-vs-send, so
    // GOOGLESHEETS_BATCH_GET autos through while GMAIL_SEND_EMAIL pauses
    // (or autos in YOLO).
    needsApproval: needsApprovalFromTaxonomy('composio_execute_tool'),
    // Safety net (call-tool.ts precedent): any FUTURE code path that still
    // throws the typed pre-dispatch refusal from inside execute must escape
    // the SDK's error_as_result so the bracket settles it `failed`, never
    // `orphaned`. Ordinary errors keep the SDK's exact default prose.
    errorFunction: (_context, error) => {
      if (error instanceof ExternalWritePreDispatchError) throw error;
      const details = error instanceof Error ? error.toString() : String(error);
      return `An error occurred while running the tool. Please try again. Error: ${details}`;
    },
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
  }));

  return [composio_status, composio_search_tools, composio_list_tools, composio_execute_tool];
}

/**
 * Test twin for the settlement seam itself: identical to the production call
 * above except the stable account identity is supplied by the test (the
 * connections snapshot behind stableComposioAccountIdentity is provider
 * state the test already owns).
 */
export function _settleVerifiedComposioReadForTest(input: {
  toolSlug: string;
  sessionId: string;
  result: unknown;
  sourceUserSeq?: number;
  accountIdentity?: string;
  schemaFingerprint?: string;
  normalizedArgs?: unknown;
}): ReturnType<typeof settleVerifiedComposioRead> {
  return settleVerifiedComposioRead(input);
}
