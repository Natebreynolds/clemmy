/**
 * Provider-agnostic tool-failure correctives.
 *
 * Shell failures (annotateShellStderr / annotateSpawnError) and Composio
 * failures (detectComposioFailure / composioFailureCorrective) already turn a
 * raw error into a self-correcting next move. MCP — the open-ended plugin
 * boundary (ElevenLabs, Airtable, DataForSEO, n8n, Kernel, vapi, …) — was the
 * odd surface out: a failed MCP call returned a raw `MCP tool "x" failed: msg`
 * with no guidance, so the model couldn't adapt. This module is the GENERAL
 * (no per-vendor list) classifier + corrective copy that the MCP namespace shim
 * uses to bring MCP to parity with the other two surfaces.
 *
 * Deliberately vendor-agnostic: it classifies by the error TEXT/shape, never by
 * a curated toolkit list, so every MCP server inherits "discover valid ids /
 * retry-once-if-transient / fix the field" for free.
 */
import { isTransientStepError } from '../../execution/transient-error.js';
import { getRuntimeEnv } from '../../config.js';

export type ToolFailureKind =
  | 'permission_denied'
  | 'not_found'
  | 'rate_limit'
  | 'timeout'
  | 'transient'
  | 'pagination'
  | 'unknown';

const PERMISSION_RE = /\b401\b|\b403\b|permission|forbidden|unauthor|access\s+denied|not\s+authoriz/i;
const NOT_FOUND_RE = /\b404\b|not\s+found|does\s+not\s+exist|no\s+such|invalid[^.]{1,20}(?:id|name|key|table|record|field|voice|base|slug|model)/i;
const RATE_RE = /\b429\b|rate[\s-]?limit|quota|too\s+many\s+requests/i;
const TIMEOUT_RE = /timeout|timed\s+out|deadline|took\s+too\s+long/i;
const PAGINATION_RE = /\boffset\b|opaque token|pagination|next[\s-]?page/i;

/** Classify a failure from its text (and optionally the raw error object, which
 *  lets isTransientStepError see network/5xx/ECONNRESET shapes precisely). */
export function classifyToolError(text: string, raw?: unknown): ToolFailureKind {
  const t = (text || '').toLowerCase();
  if (PERMISSION_RE.test(t)) return 'permission_denied';
  if (NOT_FOUND_RE.test(t)) return 'not_found';
  if (RATE_RE.test(t)) return 'rate_limit';
  if (TIMEOUT_RE.test(t)) return 'timeout';
  if (PAGINATION_RE.test(t)) return 'pagination';
  // Transient infra (network / 5xx / ECONNRESET) is the ONE case where retrying
  // the SAME call is productive — checked last so a more specific kind wins.
  if (isTransientStepError(raw ?? text)) return 'transient';
  return 'unknown';
}

/**
 * Corrective for a TIMEOUT. A timeout is NOT a "retry the same call once"
 * situation when the call is a LONG-RUNNING JOB (an actor/agent run, a big
 * scrape/export, a blocking "sync get dataset items") — re-running the same
 * blocking call just times out again (the live 2026-06-24 Apify case: two sync
 * `APIFY_RUN_ACTOR_SYNC_*` calls each burned the full 5-min tool window before
 * the model pivoted to the async pattern on its own). Steer to async start+poll;
 * a brief network blip can still retry once. General — pattern names, no
 * per-vendor slug list. */
export function asyncJobTimeoutCorrective(label: string, summary: string, where = ''): string {
  return [
    `⚠️ ${label} TIMED OUT${where}: ${summary}`,
    `A timeout means the call exceeded its time budget. If this is a LONG-RUNNING JOB — an actor/agent run, a large scrape or export, or a blocking "sync get dataset items" call — do NOT retry the SAME blocking call; it will time out again. Use the ASYNC pattern: START the job with an action that returns a run/job id (e.g. a *_RUN / *_ACT_RUNS / *_CREATE / *_START action), then POLL its status/results (e.g. *_GET / *_RUNS_GET / dataset-items) until it finishes.`,
    `If that START call returns a QUEUED RECEIPT (a bare run/task/job id with no result yet), you do NOT need to hand-poll it in a loop: the harness auto-resolves or backgrounds a queued receipt for you and delivers the real result — just start it and continue.`,
    `Only if this was a brief network blip (NOT a long job) should you retry the identical call ONCE.`,
  ].join('\n\n');
}

/**
 * Corrective for a TIMEOUT on a WRITE/mutating call. A write that timed out is
 * DANGEROUS to re-issue: the harness abandons the call but does NOT cancel the
 * underlying request, so the write MAY HAVE LANDED server-side. Blindly retrying
 * (or "switching to async start+poll" as for a read) risks a DUPLICATE record.
 * Steer to verify-before-retry instead. Banner is "WRITE TIMED OUT" — NOT a
 * "FAILED" banner — on purpose: a FAILED banner would trip compensateFailedExternalWrite
 * into decrementing the external-write ledger for a write that may have succeeded.
 * General — pattern names, no per-vendor slug list. */
export function writeJobTimeoutCorrective(label: string, summary: string, where = ''): string {
  return [
    `⚠️ ${label} WRITE TIMED OUT${where}: ${summary}`,
    `This was a WRITE that exceeded its time budget. The call was ABANDONED but NOT cancelled — it may still have completed server-side. Do NOT blindly re-issue it; you could create a DUPLICATE.`,
    `FIRST verify whether the write landed: READ THE TARGET BACK with a *_GET / *_LIST / *_SEARCH action for this same record/object. Only write again if it is confirmed ABSENT. If the toolkit supports an idempotency key or an UPSERT action, prefer that over a plain create.`,
  ].join('\n\n');
}

/** A loud, self-correcting header for a failed tool call. Names the tool and
 *  tells the model the specific recovery move for the failure kind, so it adapts
 *  on failure #1 instead of retrying identically into the loop guard. */
export function toolFailureCorrective(
  summary: string,
  opts: { toolName?: string; kind?: ToolFailureKind } = {},
): string {
  const label = opts.toolName || 'the tool';
  const kind = opts.kind ?? classifyToolError(summary);

  // Timeout is its OWN move: a long-running job must switch to async start+poll,
  // not retry the blocking call (which times out again). Split out of the
  // transient branch below — they share a symptom but need OPPOSITE advice.
  if (kind === 'timeout') {
    return asyncJobTimeoutCorrective(label, summary);
  }
  if (kind === 'transient' || kind === 'rate_limit') {
    return [
      `⚠️ ${label} FAILED: ${summary}`,
      `This looks TRANSIENT (rate-limit / 5xx / network) — NOT a bad request. A SINGLE retry of the SAME call after a brief pause may succeed.`,
      `Retry this EXACT call ONCE. If it fails again, switch approach (different action/tool) or report the specific blocker to the user. Do NOT retry more than once.`,
    ].join('\n\n');
  }
  if (kind === 'not_found') {
    return [
      `⚠️ ${label} NOT FOUND: ${summary}`,
      `This is almost certainly a WRONG identifier (an id / name / key that doesn't exist), NOT a permissions or connection problem — the connection works, the value you passed doesn't.`,
      `Do this, in order: (1) DISCOVER the real options first — call this tool's own list/search/schema action (or list MCP resources / the server's discovery tool) and read the EXACT values it returns; (2) retry with one of those exact values. Do NOT guess another name — guessing returns the same not-found error.`,
    ].join('\n');
  }
  if (kind === 'permission_denied') {
    return [
      `⚠️ ${label} DENIED: ${summary}`,
      `This is an AUTH / permission problem (401/403), not a bad identifier — the token may be missing scopes or expired, or the resource isn't shared with this account.`,
      `Do this: confirm the integration is connected with the right account + scopes (e.g. check mcp_status or the toolkit's auth), or use a different tool/account that has access. Do NOT repeat the identical call — it will be denied again.`,
    ].join('\n');
  }
  if (kind === 'pagination') {
    return [
      `⚠️ ${label} FAILED: ${summary}`,
      `An offset/page token must be the EXACT opaque value returned in a prior response — never a guessed one. Most likely your previous list call returned everything but its result was CLIPPED for size: the FULL payload is stored.`,
      `Call recall_tool_result on your previous list call to get the COMPLETE set in one shot — do NOT pass a guessed offset.`,
    ].join('\n');
  }
  return [
    `⚠️ ${label} FAILED: ${summary}`,
    `This is a HARD failure — calling it again with the SAME arguments will return the SAME error.`,
    `Do ONE of these instead: (1) fix the arguments — re-check the action's exact required field names/shape (a 4xx almost always means a wrong, missing, or misnamed field); (2) use a different action or tool; (3) if you can't resolve it, STOP and tell the user the specific blocker. Do NOT repeat this identical call.`,
  ].join('\n\n');
}

/**
 * Conservatively duck-type a SUCCESS-path tool result (returned, not thrown) as
 * a failure envelope. Only fires on a PARSEABLE JSON error shape
 * ({isError:true} / {successful:false} / {success:false} / a top-level error
 * string) so a successful result that merely mentions the word "error" in prose
 * is never misflagged. An explicit success marker always wins.
 */
export function detectStructuredToolFailure(text: string): { failed: boolean; summary: string; notFound: boolean } {
  const none = { failed: false, summary: '', notFound: false };
  const trimmed = (text || '').trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return none;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return none; }
  const obj = Array.isArray(parsed)
    ? parsed.find((x) => x && typeof x === 'object')
    : parsed;
  if (!obj || typeof obj !== 'object') return none;
  const r = obj as Record<string, unknown>;
  const explicitSuccess = r.successful === true || r.success === true || r.isError === false || r.ok === true;
  const errObj = r.error;
  const errStr = typeof errObj === 'string'
    ? errObj.trim()
    : (errObj && typeof errObj === 'object' && typeof (errObj as { message?: unknown }).message === 'string')
      ? (errObj as { message: string }).message.trim()
      : '';
  const failed =
    r.isError === true
    || r.successful === false
    || r.success === false
    || (errStr.length > 0 && !explicitSuccess);
  if (!failed) return none;
  const message = typeof r.message === 'string' ? r.message : '';
  const summary = (errStr || message || 'the tool reported an error').replace(/\s+/g, ' ').trim().slice(0, 240);
  return { failed: true, summary, notFound: classifyToolError(summary) === 'not_found' };
}

/** Kill-switch. Validated-default-ON (set CLEMMY_MCP_ERROR_CORRECTIVE=off to disable). */
export function mcpErrorCorrectiveEnabled(): boolean {
  return (process.env.CLEMMY_MCP_ERROR_CORRECTIVE ?? 'on').toLowerCase() !== 'off';
}

/** Kill-switch. Validated-default-ON (set CLEMMY_TOOL_TIMEOUT_SELF_CORRECT=off to disable).
 *  When ON, a withTimeout kill of a long-job EXTERNAL tool (Composio / external_api / MCP)
 *  returns the async start+poll corrective (reads) or the verify-before-retry corrective
 *  (writes) as the tool RESULT — so the model self-corrects within the same run instead of
 *  the run parking on the loop's ask-user "retry/switch/stop" card. Read via getRuntimeEnv
 *  (not raw process.env) so the value applies under launchd, matching the brackets.ts
 *  kill-switch convention. */
export function toolTimeoutSelfCorrectEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_TOOL_TIMEOUT_SELF_CORRECT', 'on') ?? 'on').toLowerCase() !== 'off';
}

/** Kill-switch. Validated-default-ON (set CLEMMY_TOOL_ABORT_ON_TIMEOUT=off to disable).
 *  When ON, a withTimeout kill of a wrapped tool call ALSO aborts the per-invocation
 *  AbortController (brackets.ts), which the Composio fetch layer merges into the live
 *  request — so a timed-out call is actually CANCELLED at the network layer instead of
 *  running on and burning provider credits. Off ⇒ no abort() call + the fetch merge is
 *  inert (no ALS signal is ever set), i.e. behavior identical to before S3. Read via
 *  getRuntimeEnv so the value applies under launchd, matching the other kill-switches. */
export function toolAbortOnTimeoutEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_TOOL_ABORT_ON_TIMEOUT', 'on') ?? 'on').toLowerCase() !== 'off';
}
