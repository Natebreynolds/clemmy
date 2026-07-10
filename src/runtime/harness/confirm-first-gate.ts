/**
 * Confirm-first gate (Move 2 — "Clementine checks herself before she
 * acts on a batch").
 *
 * The execution-wrap gate (execution-gate.ts) forces a mutating external
 * write to live inside a tracked execution. This gate adds a STRICTER
 * requirement for high-blast-radius work: before a *batch* of same-shape
 * external writes fires (e.g. "write 25 emails", "fill 50 Salesforce
 * rows"), the session must have an active, instruction-reviewed plan
 * scope — i.e. Clementine surfaced "here's what I'll do + the
 * instructions I'm following" and the user approved.
 *
 * Why at the tool boundary, in code (not a prompt rule): the model can
 * fan out workers via `run_worker`, and a worker doing the actual
 * composio_execute_tool batch-send would sail past any prompt-level
 * "surface a plan first" instruction. The gate runs inside
 * `wrapToolForHarness`, which wraps EVERY tool call — parent and worker
 * — and workers inherit the parent session via AsyncLocalStorage. So the
 * batch count aggregates across workers by construction.
 *
 * "Same-shape" = same Composio slug (the unit the model fans out on).
 * The count is sourced from durable `external_write` events the gate
 * itself emits per allowed write, so it survives across turns and
 * across worker sub-agents.
 *
 * Env flag (escape hatch / soak control): `CLEMMY_CONFIRM_FIRST`.
 * Defaults ON. Set `CLEMMY_CONFIRM_FIRST=off` to temporarily return to
 * execution-wrap-only behavior while debugging a false positive.
 *
 * Pure logic (classification + threshold decision) is exported and
 * tested in confirm-first-gate.test.ts with no SDK / DB / eventlog.
 */
import { getRuntimeEnv } from '../../config.js';
import { isMutatingExternalWrite, looksLikeNativeMcpSend, isIrreversibleSendSlug, IRREVERSIBLE_SEND_VERBS } from './execution-gate.js';
// Re-export so existing importers keep working; the canonical predicate is
// isIrreversibleSendSlug.
export { isIrreversibleSendSlug };

/** Back-compat re-export; the canonical predicate is isIrreversibleSendSlug. */
export const IRREVERSIBLE_VERBS = IRREVERSIBLE_SEND_VERBS;

export interface ExternalWriteShape {
  /** Whether this call is a mutating external write at all. */
  mutating: boolean;
  /** Whether the write is irreversible (SEND/PUBLISH). */
  irreversible: boolean;
  /** Stable key the model fans out on — the Composio slug. Undefined
   *  when we can't classify (→ gate stays out of the way, fail-open). */
  shapeKey: string | undefined;
}

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
  const slug = (rawArgs as Record<string, unknown>).tool_slug;
  return typeof slug === 'string' && slug.length > 0 ? slug : undefined;
}

/**
 * Classify a tool call for the confirm-first gate. Reuses the
 * execution-gate's mutating-write classifier so the two gates agree on
 * what "external write" means, and adds the shape key + irreversibility.
 */
export function classifyExternalWrite(toolName: string, rawArgs: unknown): ExternalWriteShape {
  const mutating = isMutatingExternalWrite(toolName, rawArgs);
  if (!mutating) return { mutating: false, irreversible: false, shapeKey: undefined };
  const slug = extractToolSlug(rawArgs);
  // One classifier, everywhere: a send-verb/comm-object slug OR a native-MCP
  // send-shaped tool name is irreversible.
  const irreversible = slug ? isIrreversibleSendSlug(slug) : looksLikeNativeMcpSend(toolName);
  // shapeKey is the slug for composio writes; fall back to the tool name
  // so non-composio writes (native MCP sends) still batch coherently.
  return { mutating: true, irreversible, shapeKey: slug ?? toolName };
}

export interface InstructionReviewDecision {
  /** True → the write must wait for an instruction-reviewed plan scope. */
  required: boolean;
  /** The 1-based count of this same-shape write in the session. */
  count: number;
  reason: 'batch_threshold' | 'below_threshold';
}

/**
 * Given how many same-shape external writes already happened this
 * session, decide whether THIS one (count = prior + 1) crosses the batch
 * threshold and therefore needs an instruction-reviewed plan scope.
 *
 * Pure + deterministic. Threshold is floored at 2 (a "batch" is at least
 * two), so a misconfigured 0/1 can't force review on every single write.
 */
export function decideInstructionReview(opts: {
  priorSameShapeCount: number;
  threshold: number;
}): InstructionReviewDecision {
  const count = Math.max(0, opts.priorSameShapeCount) + 1;
  const threshold = Math.max(2, Math.floor(opts.threshold));
  const required = count >= threshold;
  return { required, count, reason: required ? 'batch_threshold' : 'below_threshold' };
}

export function isConfirmFirstEnabled(): boolean {
  const raw = (getRuntimeEnv('CLEMMY_CONFIRM_FIRST', 'on') ?? 'on').toLowerCase();
  return raw === 'on' || raw === 'strict' || raw === 'true' || raw === '1';
}

/**
 * Thrown when a batch external write is attempted without an active
 * instruction-reviewed plan scope. Surfaced to the model as a SOFT tool
 * error (same handling as MissingExecutionWrapError) so it can recover by
 * surfacing a plan and waiting for approval — never a hard run abort.
 */
export class ConfirmFirstRequiredError extends Error {
  public readonly toolName: string;
  public readonly shapeKey: string | undefined;
  public readonly count: number;
  public readonly threshold: number;
  public readonly sessionId: string;
  constructor(opts: {
    toolName: string;
    shapeKey: string | undefined;
    count: number;
    threshold: number;
    sessionId: string;
  }) {
    const shapePart = opts.shapeKey ? ` (${opts.shapeKey})` : '';
    super(
      `CONFIRM_FIRST_REQUIRED: this is same-shape external write #${opts.count}${shapePart} — a batch (threshold ${opts.threshold}) with no instruction-reviewed plan for this session. ` +
        `Before continuing the batch, surface the plan for approval (\`draft_plan\` then \`surface_plan\`) and STOP until the user approves ("Plan approved: <objective>"). ` +
        `State what you'll do as you'd say it to a colleague — a plain one-line summary plus a short preview; do NOT recite this message or list the instructions you reviewed. ` +
        `Approval opens a plan scope that covers the rest of the batch (including worker fan-out). If a stored instruction looks wrong for this objective, flag that one and offer to remove it before proceeding.`,
    );
    this.name = 'ConfirmFirstRequiredError';
    this.toolName = opts.toolName;
    this.shapeKey = opts.shapeKey;
    this.count = opts.count;
    this.threshold = opts.threshold;
    this.sessionId = opts.sessionId;
  }
}
