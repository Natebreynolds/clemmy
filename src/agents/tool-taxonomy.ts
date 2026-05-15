/**
 * Tool taxonomy — one classifier and one approval decision used by every
 * tool family (MCP, Composio, computer-use, local runtime, etc.).
 *
 * Why this file exists:
 *   The agent had four separate approval functions before — each tool
 *   family decided gating its own way, so YOLO mode honored some
 *   surfaces and not others, and the model couldn't predict when it
 *   would be asked vs. allowed. With one classifier driving one
 *   decision function, the trust gradient is global:
 *
 *     strict     → every non-read action asks
 *     workspace  → writes/executes auto inside the workspace, else ask;
 *                  network 'send' always asks (no workspace concept for
 *                  external mutations)
 *     yolo       → auto on read/write/execute/send;
 *                  'admin' still asks (account-level / structural);
 *                  hard denylist in `assertCommandAllowed` is absolute
 *
 *   The Plan-Scope override (a user pre-approved a plan that includes
 *   the tool) takes priority over scope, exactly as before.
 *
 * Adding a new tool family:
 *   Wire the family's per-tool `needsApproval` hook to
 *   `needsApprovalFromTaxonomy(toolName, { kindHint, destructiveHint })`.
 *   That's the only thing the family needs to do. The classifier and
 *   the scope policy take care of the rest.
 */

import { evaluateAutoApprove, recordAutoApproval, summarizeToolArgs } from './plan-scope.js';
import { loadProactivityPolicy } from './proactivity-policy.js';
import type { AutoApproveScope } from './proactivity-policy.js';

export type ToolKind =
  | 'read'      // pure lookup; never asks
  | 'write'     // local mutation (filesystem, memory, plan store)
  | 'execute'   // spawn subprocess / run shell
  | 'send'      // external mutation (network) — Composio writes, MCP POSTs, DMs
  | 'admin';    // account-level / structural — always asks, even in YOLO

export interface ClassifyOptions {
  /** Caller can override the inferred kind for tools whose name is misleading. */
  kindHint?: ToolKind;
  /** Composio `composio_execute_tool` passes the args so we can read the slug. */
  args?: unknown;
}

/**
 * Tools that must always ask, regardless of policy. Account-level
 * changes, plugin install, agent deletion, anything that reshapes the
 * runtime itself. Yes, even in YOLO. Yes, even with a plan-scope.
 *
 * If you find yourself wanting to add a "but in yolo this should
 * auto-approve" exception here: don't. Make the tool less powerful or
 * split it into a read+confirm pair.
 */
const ALWAYS_ADMIN = new Set<string>([
  'create_tool',
  'delete_agent',
  'workspace_config',
  'credentials_set',
  'credentials_migrate',
  'credentials_repair_keychain',
  'credentials_reset',
  'credentials_delete',
  'plugin_install',
  'plugin_uninstall',
  'request_destructive_action',
]);

/**
 * Tool-name prefixes/needles. Order matters: we test admin first
 * (highest gate), then send (network mutation), execute (subprocess),
 * write (local mutation), read (lookup).
 *
 * Patterns are matched against a normalized name where uppercase is
 * lowered and `__` (the MCP namespace shim separator) is collapsed —
 * so `dataforseo__serp_organic_live_advanced` is still seen as
 * `serp_organic_live_advanced` for classification.
 */
const NAME_PATTERNS: Array<{ kind: ToolKind; needles: string[] }> = [
  {
    kind: 'admin',
    needles: [
      '_admin_', 'admin_', '_install', '_uninstall', '_migrate', '_repair_keychain',
      '_reset_credentials',
    ],
  },
  {
    kind: 'send',
    // External network-touching mutations. Composio cx_* lives here when
    // the slug mutates state; we resolve that via Composio-aware override
    // below in classifyTool().
    needles: [
      'send_', '_send_', 'post_', '_post_', 'publish_', 'deliver_', 'dispatch_',
      'notify_', '_notify_', 'dm_', '_dm_', 'email_', '_email_', 'sms_', '_sms_',
      'reply_', 'forward_', 'invite_', '_invite_', 'upload_', '_upload_',
      'webhook_', '_announce_', '_broadcast_',
    ],
  },
  {
    kind: 'execute',
    needles: [
      'run_shell_command', 'exec_', '_exec_', 'execute_', '_execute_',
      'spawn_', 'launch_', 'run_workflow', 'run_plan', 'run_task',
      'run_agent', 'invoke_workflow',
    ],
  },
  {
    kind: 'write',
    needles: [
      'write_', '_write_', 'save_', '_save_', 'create_', '_create_', 'update_',
      '_update_', 'delete_', '_delete_', 'remove_', '_remove_', 'patch_', '_patch_',
      'set_', '_set_', 'edit_', '_edit_', 'modify_', 'append_', 'prepend_',
      'archive_', 'unarchive_', 'restore_', 'add_', '_add_', 'put_', '_put_',
      'remember', 'forget', 'tag_', 'untag_', 'star_', 'unstar_',
      'attach_', 'detach_', 'register_', 'unregister_', 'mark_', '_log_',
      'draft_', 'propose_', 'plan_',
    ],
  },
  {
    kind: 'read',
    // Anything that didn't trip a write/execute/send needle is treated
    // as read by default. We still keep an explicit read list so this
    // file documents the universe rather than relying on the catch-all.
    needles: [
      'get_', 'list_', 'search_', 'find_', 'fetch_', 'read_', 'query_',
      'lookup_', 'retrieve_', 'describe_', 'browse_', 'scan_', 'view_',
      'inspect_', 'status_', 'head_', 'peek_', 'count_', 'summarize_',
      'recall', 'observe', 'capture_', 'ping', 'snapshot_', 'preview_',
      'show_', 'check_',
    ],
  },
];

function normalizeForMatch(name: string): string {
  // Drop the MCP namespace shim prefix so classification looks at the
  // underlying tool name. We classify by the action verb, not by who
  // hosts it.
  const sep = '__';
  const idx = name.indexOf(sep);
  const local = idx > 0 ? name.slice(idx + sep.length) : name;
  return local.toLowerCase();
}

/**
 * Composio slugs are SCREAMING_CASE and read like `GOOGLESHEETS_BATCH_GET`
 * or `GMAIL_SEND_EMAIL`. The `cx_` first-class wrappers lowercase them
 * but keep the structure, so we can classify the same way for both.
 */
function classifyComposioSlug(slug: string): ToolKind {
  const upper = slug.toUpperCase();
  // Read prefixes / contains
  if (
    /^(GET|LIST|SEARCH|FIND|FETCH|READ|QUERY|LOOKUP|RETRIEVE)_/.test(upper) ||
    /_(GET|LIST|SEARCH|FIND|FETCH|READ|QUERY|LOOKUP)_/.test(upper) ||
    upper.endsWith('_GET') ||
    upper.endsWith('_LIST')
  ) {
    return 'read';
  }
  // Anything else from a Composio toolkit hits the network and mutates
  // external state — by definition `send`.
  return 'send';
}

/** Public — used by every tool family's `needsApproval` factory. */
export function classifyTool(name: string, options: ClassifyOptions = {}): ToolKind {
  if (options.kindHint) return options.kindHint;

  // Hard admin list — always ask.
  if (ALWAYS_ADMIN.has(name)) return 'admin';

  // Composio broker: composio_execute_tool's "real kind" depends on the
  // slug it was asked to invoke. Pull it out of args when available.
  if (name === 'composio_execute_tool' && options.args && typeof options.args === 'object') {
    const slug = (options.args as { tool_slug?: unknown }).tool_slug;
    if (typeof slug === 'string' && slug.trim()) {
      return classifyComposioSlug(slug);
    }
    // Slug missing → conservative: treat as send.
    return 'send';
  }

  // Composio first-class tools: `cx_<lowercased_slug>`. Strip the prefix
  // and re-uppercase to reuse the slug classifier.
  if (name.startsWith('cx_')) {
    return classifyComposioSlug(name.slice('cx_'.length));
  }

  const norm = normalizeForMatch(name);
  for (const { kind, needles } of NAME_PATTERNS) {
    for (const needle of needles) {
      if (norm.includes(needle)) return kind;
    }
  }

  // No pattern matched — conservative default. Untyped tools should
  // ask, not silently run. Once a name lands in this branch in the
  // wild, add an explicit pattern (and a test).
  return 'write';
}

export interface ApprovalDecisionInput {
  sessionId?: string;
  toolName: string;
  /** Caller can pre-classify if it knows better. */
  kindHint?: ToolKind;
  /** Args for slug-aware classification (composio_execute_tool). */
  args?: unknown;
  /**
   * Optional: caller already computed whether the args resolve to a
   * path inside a workspace dir. Used by computer-use tools that take
   * an explicit `path` or `cwd`. Not relevant for `send` (network).
   */
  insideWorkspaceHint?: boolean;
  /**
   * Optional: even with auto-approve eligibility, force a prompt if the
   * caller has determined this specific invocation is destructive
   * (e.g. a recursive delete or a public broadcast).
   */
  isDestructiveHint?: boolean;
}

export interface ApprovalDecision {
  /** SDK semantics: true = pause for human approval. */
  needsApproval: boolean;
  /** Why we made this call. Used for the audit log. */
  reason:
    | 'admin'
    | 'destructive-hint'
    | 'read-always-auto'
    | 'plan-scope'
    | 'workspace-policy'
    | 'yolo-policy'
    | 'strict-policy'
    | 'unknown';
  kind: ToolKind;
}

export function decideToolApproval(input: ApprovalDecisionInput): ApprovalDecision {
  const kind = classifyTool(input.toolName, {
    kindHint: input.kindHint,
    args: input.args,
  });

  if (kind === 'admin') {
    return { needsApproval: true, reason: 'admin', kind };
  }
  if (input.isDestructiveHint) {
    return { needsApproval: true, reason: 'destructive-hint', kind };
  }
  if (kind === 'read') {
    return { needsApproval: false, reason: 'read-always-auto', kind };
  }

  const policy = loadProactivityPolicy();
  // `evaluateAutoApprove` already knows about plan-scope, yolo, and
  // workspace. For 'send' (network mutations) there's no workspace
  // concept — pass insideWorkspace=false so the workspace branch never
  // fires.
  const decision = evaluateAutoApprove({
    sessionId: input.sessionId,
    toolName: input.toolName,
    scope: policy.autoApproveScope satisfies AutoApproveScope,
    insideWorkspace: kind === 'send' ? false : Boolean(input.insideWorkspaceHint),
  });

  if (decision.autoApproved) {
    if (input.sessionId) {
      recordAutoApproval(
        input.sessionId,
        input.toolName,
        `[${decision.reason}] kind=${kind} ${summarizeToolArgs(input.toolName, input.args)}`,
      );
    }
    const reason =
      decision.reason === 'plan-scope' ? 'plan-scope'
      : decision.reason === 'workspace-policy' ? 'workspace-policy'
      : decision.reason === 'yolo-policy' ? 'yolo-policy'
      : 'unknown';
    return { needsApproval: false, reason, kind };
  }

  return { needsApproval: true, reason: 'strict-policy', kind };
}

/**
 * Factory that returns an SDK-shaped `needsApproval` callback. Every
 * tool family wires its `tool({ needsApproval })` slot to the result
 * of this function and gets the unified taxonomy for free.
 *
 * Usage:
 *   tool({
 *     name: 'write_file',
 *     // ...
 *     needsApproval: needsApprovalFromTaxonomy('write_file', {
 *       computeInsideWorkspace: (input) => isInsideWorkspace(input.path),
 *     }),
 *   });
 */
export function needsApprovalFromTaxonomy(
  toolName: string,
  options: {
    kindHint?: ToolKind;
    computeInsideWorkspace?: (input: unknown) => boolean;
    isDestructive?: (input: unknown) => boolean;
  } = {},
): (runContext: unknown, input: unknown) => Promise<boolean> {
  return async (runContext, input) => {
    const sessionId = extractSessionId(runContext);
    const insideWorkspaceHint = options.computeInsideWorkspace?.(input);
    const isDestructiveHint = options.isDestructive?.(input);
    const { needsApproval } = decideToolApproval({
      sessionId,
      toolName,
      kindHint: options.kindHint,
      args: input,
      insideWorkspaceHint,
      isDestructiveHint,
    });
    return needsApproval;
  };
}

function extractSessionId(runContext: unknown): string | undefined {
  if (!runContext || typeof runContext !== 'object') return undefined;
  const ctx = (runContext as { context?: unknown }).context;
  if (!ctx || typeof ctx !== 'object') return undefined;
  const sid = (ctx as { sessionId?: unknown }).sessionId;
  return typeof sid === 'string' ? sid : undefined;
}
