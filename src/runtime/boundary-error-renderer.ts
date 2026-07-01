/**
 * Boundary-error renderer — the single switch statement that turns a
 * BoundaryError into per-surface user copy and per-severity ops fields.
 *
 * Every channel handler (Discord, chat dock, electron toast, CLI) goes
 * through this so the same kind reads identically everywhere. Adding a
 * new BoundaryErrorKind without updating this file fails the snapshot
 * test in boundary-error-renderer.test.ts — that's intentional: the
 * type system can't enforce exhaustiveness across a string-literal
 * union without help, so CI does it instead.
 */

import type { BoundaryError, BoundaryErrorKind } from './boundary-error.js';

export type RenderSurface = 'discord' | 'dashboard' | 'electron' | 'cli';

export interface RenderedForUser {
  /** Short headline; chat clients render bold. */
  title: string;
  /** Multi-line body. Includes the BoundaryError.userMessage verbatim
   *  plus the suggested next action when one exists. */
  body: string;
  /** Optional "what should I do next" hint surfaced under the body —
   *  typically a Settings link or a one-line command. */
  actionHint?: string;
}

export interface RenderedForOps {
  /** Structured fields suitable as pino's bag-of-pairs. */
  logFields: Record<string, unknown>;
  /** Map to pino levels: warn = transient, error = persistent failure,
   *  critical = user-blocking (auth gone, disk full, all retries gone). */
  severity: 'warn' | 'error' | 'critical';
}

/**
 * Render for a user-facing surface. The renderer reads
 * `err.userMessage` and adds a per-kind action hint — never invents
 * new copy. The boundary author owns the message; this layer just
 * formats and decorates.
 */
export function renderBoundaryErrorForUser(
  err: BoundaryError,
  surface: RenderSurface,
): RenderedForUser {
  const action = actionHintForKind(err.kind, surface);
  return {
    title: titleForKind(err.kind),
    body: err.userMessage,
    actionHint: action,
  };
}

/**
 * Render for supervisor.log + the Recent Errors dashboard panel.
 */
export function renderBoundaryErrorForOps(err: BoundaryError): RenderedForOps {
  return {
    logFields: {
      kind: err.kind,
      retryable: err.retryable,
      msg: err.operatorMessage,
      context: err.context,
      cause: err.cause instanceof Error
        ? { name: err.cause.name, message: err.cause.message }
        : err.cause,
    },
    severity: severityForKind(err.kind),
  };
}

function titleForKind(kind: BoundaryErrorKind): string {
  switch (kind) {
    case 'codex.http_4xx':
      return 'Model backend rejected the request';
    case 'codex.http_5xx':
      return 'Model backend is having trouble';
    case 'codex.sse_truncated':
      return 'Model response was cut short';
    case 'codex.auth_expired':
      return 'Codex auth expired';
    case 'codex.wall_clock':
      return 'Hit the time budget on this turn';
    case 'codex.transport_timeout':
      return 'Model backend stopped responding';
    case 'codex.grace_turn_failed':
      return "Couldn't write a recap after hitting the budget";
    case 'model.rate_limited':
      return 'Model backend is rate-limiting';
    case 'model.overloaded':
      return 'Model backend is overloaded';
    case 'model.transport_timeout':
      return 'Model backend stopped responding';
    case 'model.empty_completion':
      return 'Model returned an empty response';
    case 'model.auth_expired':
      return 'Model auth expired';
    case 'model.http_5xx':
      return 'Model backend is having trouble';
    case 'model.unknown':
      return 'Model backend hit an unexpected error';
    case 'mcp.server_unavailable':
      return 'Tool server is unavailable';
    case 'mcp.tool_call_failed':
      return 'Tool call failed';
    case 'mcp.approval_blocked':
      return 'Tool requires approval';
    case 'mcp.unknown_tool':
      return 'Tool not found';
    case 'notification.delivery_failed':
      return 'Could not deliver the notification';
    case 'notification.partial_chunk':
      return 'Notification only partly delivered';
    case 'state.write_failed':
      return 'Could not save state to disk';
    case 'state.read_corrupted':
      return 'A state file was corrupted';
    case 'runtime.deserialize':
      return "Couldn't resume the paused session";
    case 'runtime.unknown':
      return 'Clementine hit an unexpected error';
  }
}

function actionHintForKind(
  kind: BoundaryErrorKind,
  surface: RenderSurface,
): string | undefined {
  switch (kind) {
    case 'codex.http_4xx':
      // Often a malformed request shape — usually our bug, not the
      // user's; surface the trace path so the operator can investigate.
      return surface === 'dashboard'
        ? 'See state/codex-4xx-trace/ for the request body.'
        : undefined;
    case 'codex.http_5xx':
    case 'codex.sse_truncated':
    case 'codex.wall_clock':
    case 'codex.transport_timeout':
      return 'Try again in a minute. If it persists, check status.openai.com.';
    case 'model.rate_limited':
    case 'model.overloaded':
    case 'model.transport_timeout':
    case 'model.http_5xx':
      return 'Try again in a minute. If it persists, check the provider status page.';
    case 'model.empty_completion':
      return undefined;
    case 'codex.auth_expired':
    case 'model.auth_expired':
      return surface === 'cli'
        ? 'Run: clementine auth login'
        : 'Re-authenticate in Settings → Auth.';
    case 'codex.grace_turn_failed':
      // The work-so-far hint is the meaningful action — the body
      // already explains what happened.
      return 'Your work so far is in the vault; you can ask me to keep going.';
    case 'mcp.server_unavailable':
      return 'Reconnect or disable the server in Settings → MCP Servers.';
    case 'mcp.unknown_tool':
      return 'Available servers are listed in the error context.';
    case 'mcp.approval_blocked':
    case 'mcp.tool_call_failed':
      return undefined;
    case 'notification.delivery_failed':
    case 'notification.partial_chunk':
      return 'Check the Delivery Queue panel for retry options.';
    case 'state.write_failed':
      return 'Disk may be full or read-only. Check ~/.clementine-next/ permissions.';
    case 'state.read_corrupted':
      return 'The corrupted file was preserved with a `.corrupt-<ts>` suffix.';
    case 'runtime.deserialize':
      return 'The paused state was quarantined. Re-send your request to start fresh.';
    case 'runtime.unknown':
      return undefined;
  }
}

function severityForKind(kind: BoundaryErrorKind): 'warn' | 'error' | 'critical' {
  switch (kind) {
    // Transient — usually resolves on retry.
    case 'codex.http_5xx':
    case 'codex.sse_truncated':
    case 'codex.wall_clock':
    case 'codex.transport_timeout':
    case 'model.rate_limited':
    case 'model.overloaded':
    case 'model.transport_timeout':
    case 'model.empty_completion':
    case 'model.http_5xx':
    case 'model.unknown':
    case 'mcp.server_unavailable':
    case 'notification.delivery_failed':
    case 'notification.partial_chunk':
      return 'warn';
    // Likely user-blocking; needs operator attention soon.
    case 'codex.http_4xx':
    case 'codex.grace_turn_failed':
    case 'mcp.tool_call_failed':
    case 'mcp.unknown_tool':
    case 'mcp.approval_blocked':
    case 'runtime.deserialize':
    case 'runtime.unknown':
      return 'error';
    // Hard-blocks the agent until human intervention.
    case 'codex.auth_expired':
    case 'model.auth_expired':
    case 'state.write_failed':
    case 'state.read_corrupted':
      return 'critical';
  }
}
