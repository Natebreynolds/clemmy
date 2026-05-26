/**
 * Execution-wrap gate (v0.5.20 audit + safety).
 *
 * Forces Clem to wrap mutating external writes in an execution lane
 * BEFORE the write fires. Rationale (from real failure 2026-05-24,
 * sess-mpk63r99): a multi-step Google Sheets selection wrote 123 cells
 * across two composio_execute_tool calls with no execution wrapping.
 * Audit trail of "why was row 51 dropped?" lived only in a python
 * heredoc in run_shell_command. Mid-session resume would have lost
 * the work; querying "what did Clem do this week?" against the
 * execution registry returned nothing.
 *
 * Decision model:
 *   1. Is the tool call a mutating external write? (defined below)
 *   2. Is there an active execution for this session?
 *   3. Is this an exempt tool (execution_*, planner, approval helpers)?
 *
 * If (1) is true AND (2) is false AND (3) is false → throw
 * `MissingExecutionWrapError`. The harness surfaces this as a tool
 * error; Clem sees the message + the suggested fix (call execution_create
 * first) and the loop continues with that recovery hint.
 *
 * Hard-block design (per Nathan 2026-05-24): a soft warning is
 * ignorable; the model can keep writing without wrapping. A hard
 * block forces the audit trail to exist.
 *
 * Env flag (escape hatch): `CLEMMY_EXECUTION_GATE=off` bypasses
 * the gate entirely. Useful for debugging or for users who explicitly
 * want the prior behavior. Default ON.
 *
 * Tested as pure logic in execution-gate.test.ts (no SDK, no DB).
 */

/**
 * Verbs in a Composio tool_slug that indicate external state mutation.
 * Conservative: when a tool slug contains any of these as a path
 * segment, treat as a write. False positives are acceptable (creates
 * a slightly-unnecessary audit trail); false negatives are not
 * (lets an un-audited write slip past the gate).
 */
const MUTATING_VERBS: ReadonlySet<string> = new Set([
  'UPDATE',
  'CREATE',
  'INSERT',
  'DELETE',
  'REPLACE',
  'APPEND',
  'SEND',
  'PATCH',
  'POST',
  'WRITE',
  'REMOVE',
  'PUBLISH',
  'BATCH', // BATCH_UPDATE, BATCH_DELETE, etc — slug starts with BATCH
]);

/**
 * Composio tool slugs that LOOK mutating by verb but aren't actually
 * user-data mutations. Today this is just DataForSEO's task creation
 * (queueing a SERP/backlinks job is read-only from the user's
 * perspective — it doesn't write to any persistent user store).
 */
const EXEMPT_COMPOSIO_SLUG_PATTERNS: RegExp[] = [
  // DataForSEO uses CREATE/POST for queueing scans, not for user data writes.
  /^DATAFORSEO_/,
  // Firecrawl search/scrape/map/crawl are reads from external URLs,
  // not writes to the user's data. BATCH_SCRAPE still only creates a
  // provider-side read job.
  /^FIRECRAWL_(BATCH_)?(SCRAPE|MAP|SEARCH|CRAWL)/,
];

/**
 * Internal harness tools that must NEVER trigger the gate — they're
 * either how Clem creates the execution to satisfy the gate, or they
 * are explicitly designed to be callable without execution wrapping
 * (approval/notification/planning primitives).
 */
const EXEMPT_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Execution-lifecycle tools — these are the ESCAPE from the gate.
  'execution_create',
  'execution_update_step',
  'execution_complete',
  'execution_mark_blocked',
  'execution_get',
  'execution_list',
  // Planning primitives — pre-execution scaffolding.
  'draft_plan',
  'create_plan',
  'list_plans',
  'update_plan_step',
  // Approval + user-input — must always be callable.
  'request_approval',
  'ask_user_question',
  'notify_user',
  // Tool-choice memoization — pure cache, never external mutation.
  'tool_choice_recall',
  'tool_choice_remember',
  'tool_choice_invalidate',
  // Recall full prior tool output — pure read.
  'recall_tool_result',
]);

/**
 * Classify whether a single tool invocation counts as a mutating
 * external write that should require execution wrapping. Pure
 * function — no I/O, no SDK, exported for tests.
 *
 * The shape we look at:
 *   - `composio_execute_tool` with a tool_slug whose path contains a
 *     mutating verb (and isn't on the exempt-slug list)
 *   - Future: workflow_run (mutates external state by running other
 *     workflows). For now NOT gated to avoid second-order complexity;
 *     a workflow run is itself observable as an execution.
 *   - Future: run_shell_command for commands that touch external
 *     services (sf data update, gh api POST, etc). Not gated yet
 *     because static classification is unreliable; the user can opt
 *     in via env flag later.
 */
export function isMutatingExternalWrite(
  toolName: string,
  rawArgs: unknown,
): boolean {
  // Internal exempt tools never trigger the gate.
  if (EXEMPT_TOOL_NAMES.has(toolName)) return false;

  if (toolName === 'composio_execute_tool') {
    // Args shape: { tool_slug: 'GOOGLESHEETS_VALUES_UPDATE', arguments: '...', connected_account_id?: '...' }
    const slug = extractToolSlug(rawArgs);
    if (!slug) return false; // Can't classify → don't block. Fail-open.
    // Known-exempt slug patterns (DataForSEO task creation, Firecrawl reads).
    for (const pattern of EXEMPT_COMPOSIO_SLUG_PATTERNS) {
      if (pattern.test(slug)) return false;
    }
    // Mutating verb anywhere in the slug path?
    const parts = slug.split('_');
    for (const part of parts) {
      if (MUTATING_VERBS.has(part)) return true;
    }
    return false;
  }

  // Everything else is NOT gated for now. Extension points above.
  return false;
}

/**
 * Best-effort extract `tool_slug` from a composio_execute_tool args
 * object. The wire shape comes in as a JS object (the SDK already
 * parsed JSON from the model) but defensive-handle string inputs too.
 */
function extractToolSlug(rawArgs: unknown): string | undefined {
  if (!rawArgs) return undefined;
  if (typeof rawArgs === 'string') {
    try {
      return extractToolSlug(JSON.parse(rawArgs) as unknown);
    } catch {
      return undefined;
    }
  }
  if (typeof rawArgs !== 'object') return undefined;
  const candidate = (rawArgs as Record<string, unknown>).tool_slug;
  if (typeof candidate === 'string' && candidate.length > 0) {
    return candidate;
  }
  return undefined;
}

/** Error thrown when a mutating external write is attempted without
 *  an active execution wrap. The message is consumed by the SDK and
 *  surfaced to the model as a tool error, so it MUST clearly tell
 *  Clem how to recover (call execution_create first). */
export class MissingExecutionWrapError extends Error {
  public readonly toolName: string;
  public readonly toolSlug: string | undefined;
  public readonly sessionId: string;
  constructor(opts: {
    toolName: string;
    toolSlug: string | undefined;
    sessionId: string;
  }) {
    const slugPart = opts.toolSlug ? ` (${opts.toolSlug})` : '';
    super(
      `EXECUTION_WRAP_REQUIRED: \`${opts.toolName}\`${slugPart} is a mutating external write but this session has no active execution. ` +
        `Before retrying, call \`execution_create\` with a clear objective + criteria so the work is auditable + resumable. ` +
        `Once the execution exists, re-issue this tool call — it will pass through. Per-tool escape hatch: set env \`CLEMMY_EXECUTION_GATE=off\` if you genuinely need to bypass.`,
    );
    this.name = 'MissingExecutionWrapError';
    this.toolName = opts.toolName;
    this.toolSlug = opts.toolSlug;
    this.sessionId = opts.sessionId;
  }
}

/**
 * Read the env-flag mode. Defaults to 'on'. Set to 'off' to disable
 * the gate (debug / explicit-bypass). Anything else also disables —
 * be permissive on unrecognized values rather than risk blocking
 * legitimate work because of a typo.
 */
export function isGateEnabled(): boolean {
  const raw = (process.env.CLEMMY_EXECUTION_GATE ?? 'on').toLowerCase();
  return raw === 'on' || raw === 'strict' || raw === 'true' || raw === '1';
}

/** Convenience export for tests + brackets integration. */
export { MUTATING_VERBS, EXEMPT_TOOL_NAMES, EXEMPT_COMPOSIO_SLUG_PATTERNS };
