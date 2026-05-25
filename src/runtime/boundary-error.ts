/**
 * BoundaryError — the single error envelope every Clementine boundary
 * throws (SDK / codex / MCP / notification / OAuth / state writes).
 *
 * Why this exists: prior to this module, each boundary caught errors
 * locally and either logged-and-dropped or returned a degraded shape
 * that downstream code couldn't distinguish from success. The audit on
 * 2026-05-18 found ~12 ad-hoc try/catch sites where errors disappeared:
 * SSE truncation returning "successful empty response", MCP server
 * connect failures silently removing tools from the model's surface,
 * Codex 400 clusters with no diagnostic surface, OAuth refresh-failed
 * notification swallowed, usage-log appendFileSync silenced on ENOSPC.
 *
 * The fix is structural: every boundary throws (or wraps) into a
 * BoundaryError. The harness's top-level catch reads `userMessage` to
 * tell the user, `operatorMessage` to write supervisor.log, and `kind`
 * to decide retry / fallback / surface. Subscribers to the action bus
 * see a `runtime.failed` event carrying this envelope — so a failure
 * becomes visible in three places (chat, dashboard, ops log) by
 * construction, never silently.
 *
 * NOT a replacement for SDK-defined error classes (CodexRuntimeError,
 * ToolTimeout, KillRequested) — those stay as-is at their throw sites;
 * BoundaryError.from(err) wraps them at the catch site where the
 * boundary surfaces. Keep narrow errors narrow; only widen at the
 * boundary edge.
 */

export type BoundaryErrorKind =
  // Codex backend
  | 'codex.http_4xx'
  | 'codex.http_5xx'
  | 'codex.sse_truncated'
  | 'codex.auth_expired'
  | 'codex.wall_clock'
  | 'codex.transport_timeout'
  | 'codex.grace_turn_failed'
  // MCP fleet
  | 'mcp.server_unavailable'
  | 'mcp.tool_call_failed'
  | 'mcp.approval_blocked'
  | 'mcp.unknown_tool'
  // User-facing delivery
  | 'notification.delivery_failed'
  | 'notification.partial_chunk'
  // Local state / disk
  | 'state.write_failed'
  | 'state.read_corrupted'
  // Runtime / loop
  | 'runtime.deserialize'
  | 'runtime.unknown';

export interface BoundaryErrorInit {
  kind: BoundaryErrorKind;
  /** True when the operation might succeed if retried with backoff.
   *  Callers use this to decide auto-retry vs. surface-and-give-up. */
  retryable: boolean;
  /** Plain-language one-liner safe to show in Discord / chat-dock /
   *  electron toast. NO secrets, NO stack frames. End with an action
   *  hint when one exists ("Re-authenticate in Settings → Auth"). */
  userMessage: string;
  /** Structured detail for supervisor.log + the Recent Errors panel.
   *  Operator-facing; can include slugs, status codes, request hashes,
   *  but still never raw credentials. */
  operatorMessage: string;
  /** Free-form structured payload — request id, session id, slug,
   *  body excerpt, etc. Logged and rendered as JSON. */
  context?: Record<string, unknown>;
  /** Optional cause chain — preserved so a top-level handler can
   *  unwrap to the original SDK / fetch error for diagnostics. */
  cause?: unknown;
}

export class BoundaryError extends Error {
  readonly kind: BoundaryErrorKind;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly operatorMessage: string;
  readonly context: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(init: BoundaryErrorInit) {
    // The Error.message is the operator message — `console.error(err)`
    // and `err.toString()` both reach for it, so this gives ops the
    // structured detail without forcing a renderer call.
    super(init.operatorMessage);
    this.name = 'BoundaryError';
    this.kind = init.kind;
    this.retryable = init.retryable;
    this.userMessage = init.userMessage;
    this.operatorMessage = init.operatorMessage;
    this.context = init.context ?? {};
    this.cause = init.cause;
    // Preserve prototype across the `super()` boundary so `instanceof
    // BoundaryError` works under transpilation targets that downlevel
    // class inheritance.
    Object.setPrototypeOf(this, BoundaryError.prototype);
  }

  /**
   * Wrap an unknown error caught at a boundary. If the caught value
   * is already a BoundaryError we pass it through — boundaries should
   * not re-wrap each other (the inner boundary already classified).
   *
   * The `hint` lets the catch site name the kind it expects when it
   * has no other classifier (e.g. an MCP shim catching anything from
   * a server-side call → 'mcp.tool_call_failed' is the safe default).
   */
  static from(
    err: unknown,
    hint: {
      kind: BoundaryErrorKind;
      userMessage: string;
      operatorMessage?: string;
      retryable?: boolean;
      context?: Record<string, unknown>;
    },
  ): BoundaryError {
    if (err instanceof BoundaryError) return err;
    const rawMsg = err instanceof Error ? err.message : String(err);
    return new BoundaryError({
      kind: hint.kind,
      retryable: hint.retryable ?? false,
      userMessage: hint.userMessage,
      operatorMessage: hint.operatorMessage ?? `${hint.kind}: ${rawMsg}`,
      context: { ...(hint.context ?? {}), rawMessage: rawMsg },
      cause: err,
    });
  }

  /**
   * Quick predicate for "should a retry loop retry this?". Used by the
   * Codex backoff path and the MCP reconnect helper. Distinct from the
   * `retryable` field so a CALLER can also infer transience from kind
   * alone (e.g. SSE truncation is always worth one more attempt).
   */
  static isTransient(err: unknown): boolean {
    if (!(err instanceof BoundaryError)) return false;
    if (err.retryable) return true;
    switch (err.kind) {
      case 'codex.http_5xx':
      case 'codex.sse_truncated':
      case 'codex.wall_clock':
      case 'codex.transport_timeout':
      case 'mcp.server_unavailable':
      case 'notification.delivery_failed':
        return true;
      default:
        return false;
    }
  }

  /**
   * Render for structured logging. Pino picks this up via its
   * `.toJSON()` convention.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      retryable: this.retryable,
      userMessage: this.userMessage,
      operatorMessage: this.operatorMessage,
      context: this.context,
      cause: this.cause instanceof Error
        ? { name: this.cause.name, message: this.cause.message }
        : this.cause,
    };
  }
}
