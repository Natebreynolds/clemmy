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
 *                  except write_file to an allowed local workspace path,
 *                  which is treated as the file artifact the user requested
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
import { isIrreversibleSendSlug } from '../runtime/harness/execution-gate.js';
import { loadProactivityPolicy } from './proactivity-policy.js';
import type { AutoApproveScope } from './proactivity-policy.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { classifyComposioSlugEffect } from '../integrations/composio/slug-effect.js';

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
  'credentials_set',
  'credentials_migrate',
  'credentials_repair_keychain',
  'credentials_reset',
  'credentials_delete',
  'plugin_install',
  'plugin_uninstall',
  'request_destructive_action',
  // MCP self-heal: creating/editing an external MCP server config is a runtime
  // infra change — ALWAYS confirm-first (no secret VALUES pass through these).
  'mcp_add',
  'mcp_configure',
]);

/**
 * Pure local memory-bookkeeping tools. These mutate the agent's own
 * memory layer (per-machine tool-choice records, durable facts) but
 * NEVER touch external state or shared resources. The Orchestrator
 * prompt explicitly says "local writes are NOT gated" for these —
 * approval-prompting the agent for `tool_choice_remember` after it
 * just probed a tool to save us from re-discovering it every turn
 * is exactly the friction the prompt warns against.
 *
 * Match is exact-name only (no prefix sloppiness) so a new tool can't
 * accidentally land here by naming convention.
 */
const NEVER_GATE_LOCAL_MEMORY = new Set<string>([
  // Tool-choice memory (Phase A): per-machine record of "what tool
  // works for which intent." Pure local file I/O.
  'tool_choice_recall',
  'tool_choice_remember',
  'tool_choice_invalidate',
  // Model-role routing — local CLEMMY_MODEL_ROLES binding (reversible, no
  // external surface). "use DeepSeek for the workers" shouldn't pause for
  // approval; it's a local setting the user just asked for in chat.
  'set_model_role',
  // Durable facts + working memory.
  'memory_remember',
  'source_map_upsert',
  'memory_forget',
  'memory_embed_backfill',
  'working_memory',
  'note_create',
  // Task + goal bookkeeping — local JSON, no external surface.
  'task_add',
  'task_update',
  'task_hygiene',
  'goal_upsert',
  // Current focus — local SQLite attention pointer. Pure local writes,
  // no external surface. Pausing for approval on these would force the
  // user to confirm every "let's pin this as the current focus" — that's
  // exactly the friction the focus feature is meant to remove.
  'focus_get',
  'focus_set',
  'focus_update',
  'focus_touch',
  'focus_park',
  'focus_activate',
  'focus_clear',
  'focus_list',
  'focus_inspect',
  // Execution-tracking writes are local state. The Orchestrator was
  // pausing on `execution_update_step` after every tool call, which
  // is friction the user reads as "why does it keep asking?"
  'execution_create',
  'execution_update_step',
  'execution_complete',
  'execution_mark_blocked',
  // Plan surfacing — local write, the user approves the plan as a whole
  // via the plan-surface flow, not per-step.
  'surface_plan',
  // Session bookkeeping
  'session_pause',
  'session_resume',
  // Workflow step output channel — records THIS step's structured result
  // locally (keyed by sessionId), consumed by the next step. No external
  // surface. Gating it made every workflow step stop for "approve
  // workflow_step_result" in Discord — friction on the step's own output.
  'workflow_step_result',
  // Workspace authoring tools mutate Clementine's local workspace store
  // (manifest, view, local runner data, local publish snapshots). They are the
  // consented local artifact path when the user asks for a workspace. External
  // sends from a workspace action still gate inside runSpaceAction.
  'space_save',
  'space_edit_view',
  'space_edit_runner',
  'space_revert_runner',
  'space_refresh',
  'space_try_runner',
  'space_set_data',
  'space_publish',
  // Team-agent coordination writes are Clementine-local state: durable agent
  // definitions, local request/delegation queues, and the local comms log. They
  // do not contact external services; external sends still gate on their own.
  'team_message',
  'team_request',
  'team_reply',
  'agent_propose',
  'create_agent',
  'update_agent',
  'delegate_task',
  // Pending-action queue writes only Clementine-local state. It prepares an exact
  // external/local payload for later approval; the eventual execution tool still
  // passes through its own gates.
  'pending_action_queue',
  'pending_action_record_result',
]);

/**
 * Explicit read-only tools whose names do not carry a reliable lookup
 * verb. `workspace_info` was falling through to the conservative write
 * default, which made the desktop ask for approval before merely
 * inspecting a local project. Keep this exact-name list small and
 * intentional.
 */
const ALWAYS_READ = new Set<string>([
  // Deterministic local table algebra (2026-07-21): pure computation over
  // rows already fetched; its only side channel is a transient staged spill
  // file. Never needs approval — reconciliation is the middle of every
  // employee loop and must not stop the run.
  'table_ops',
  // Deterministic retrieval + interval algebra (2026-07-21): pure local
  // compute, same rationale as table_ops.
  'file_query',
  'time_slots',
  // Schema-guided extraction (2026-07-21): model-assisted but mutates
  // nothing — the gated CREATE that consumes the payload is where approval
  // lives.
  'extract_structured',
  'workspace_roots',
  'workspace_list',
  'workspace_info',
  'git_status',
  'session_history',
  'skill_list',
  'skill_read',
  'composio_status',
  'composio_search_tools',
  'composio_list_tools',
  'mcp_status',
  'mcp_list_tools',
  'mcp_reconnect',
  'local_cli_probe',
  'ping',
  // 2026-05-21: explicit reads that previously fell through to the
  // conservative 'write' default and approval-prompted the user on
  // pure inspection. None of these mutate anything — they just list
  // / fetch metadata.
  'agent_runs_recent',
  'agent_run_get',
  'background_tasks_recent',
  'background_task_status',
  // dispatch_background_task is a WRITE (it queues autonomous work), but the
  // user just AGREED to it in conversation — the conversation IS the consent, so
  // it must not re-prompt for approval (same rationale as execution_create /
  // task_add below). The work it dispatches is still gated normally inside the
  // background run.
  'dispatch_background_task',
  // hold_task_for_later saves an agreed plan locally (reversible, no external
  // effect); resume_held_task queues work the user EXPLICITLY asked to pick back
  // up — both are consent-given like dispatch_background_task. Work stays gated
  // inside the resulting background run.
  'hold_task_for_later',
  'resume_held_task',
  'memory_list_facts',
  'memory_search_facts',
  'memory_read',
  'memory_recall',
  'memory_search',
  // 2026-06-17: memory_review_instructions is a PURE READ — it returns the
  // standing instructions in play (relevance-sorted text) so Clem can show the
  // user what she's following before a batch write. It mutates nothing. It was
  // falling through to the conservative 'write' default and PARKING FOR APPROVAL
  // — which is doubly wrong: the confirm-first gate (confirm-first-gate.ts)
  // REQUIRES the model to call this tool as the prescribed recovery for a batch
  // of same-shape external writes, so the misclassification injected a spurious
  // approval interrupt right in the middle of the "surface a plan" flow (a real
  // user-observed double-approval on an outbound email batch, 2026-06-17).
  'memory_review_instructions',
  'task_list',
  'execution_list',
  'execution_get',
  'execution_create',
  'goal_list',
  'tool_choice_recall',
  'user_profile_read',
  'desktop_status',
  'local_cli_list',
  'list_files',
  'read_file',
  // Team-agent inspection tools are pure local reads.
  'team_list',
  'team_pending_requests',
  'check_delegation',
  // Pending-action inspection is a pure local read.
  'pending_action_list',
  'pending_action_get',
  // 2026-05-22: notify_user is a local-only side effect (desktop
  // notification + Discord ping). It does NOT mutate external state.
  // The verb-match pattern below classifies it as 'send' because of
  // the `notify` verb, which (incorrectly) gates it on approval. Real
  // failure mode: every workflow run that ends with notify_user (e.g.
  // "Outlook triage complete", "End of day summary", scheduled
  // synthesis steps) parks waiting for approval; the proactive brief
  // then pings the user about it; the user dismisses but the pending
  // approval lingers, creating a noise loop. Observed across 4+
  // workflow runs on 2026-05-22.
  //
  // The same logic applies to a small set of "the agent tells the user
  // something" affordances that have only local side effects:
  'notify_user',
  // ask_user_question — asks for clarifying input, doesn't mutate.
  // The QUESTION itself isn't the approval gate; the AGENT's response
  // to the user's answer might be, and that's a separate tool call.
  'ask_user_question',
  // offer_background just posts the run-in-bg/hold/now choice and pauses — a
  // question, no side effect; never needs approval.
  'offer_background',
  // draft_plan / share_plan / propose_check_in_template / surface_plan — planning
  // surfaces, agent-internal. Not network mutations.
  'draft_plan',
  'share_plan',
  'surface_plan',
  'propose_check_in_template',
  // workflow_run only queues a local workflow run record. The workflow
  // runner still gates external writes/sends inside the workflow, so
  // approving the queue action itself created duplicate approval noise
  // without adding safety.
  'workflow_run',
  'workflow_rerun_failed_items',
]);

/**
 * Tool-name prefixes/needles. Order matters: we test admin first
 * (highest gate), then send (network mutation), execute (subprocess),
 * write (local mutation), read (lookup).
 *
 * Patterns are matched as WHOLE WORDS in the underscore-separated name
 * — so `search` matches `memory_search`, `search_files`, and `db_search_v2`
 * but NOT `searcher_bot`. This catches both the older `verb_noun` style
 * (`search_files`) and the local-tool `noun_verb` style (`memory_search`)
 * that previously fell through to the catch-all `write` classification.
 *
 * Normalization: uppercase lowered, `__` (the MCP namespace shim
 * separator) collapsed — so `dataforseo__serp_organic_live_advanced`
 * is matched as `serp_organic_live_advanced`.
 */
const NAME_PATTERNS: Array<{ kind: ToolKind; verbs: string[] }> = [
  {
    kind: 'admin',
    verbs: [
      'admin', 'install', 'uninstall', 'migrate',
      'repair_keychain', 'reset_credentials',
      // Credential / secret / auth-connection management (e.g. native MCP
      // `manage_credentials`, `manage_api_keys`, `manage_auth_connections`).
      // Writing secrets is account-level and must ALWAYS ask, even in YOLO /
      // under a plan-scope — the in-process `credentials_*` tools are already
      // in ALWAYS_ADMIN; this extends the same floor to MCP-hosted ones.
      // (Over-gating a credential LIST to "ask" is acceptably conservative.)
      'credentials', 'api_keys', 'apikeys', 'auth_connections', 'secret', 'secrets',
    ],
  },
  {
    kind: 'send',
    // External network-touching mutations. Composio cx_* lives here when
    // the slug mutates state; we resolve that via Composio-aware override
    // below in classifyTool().
    verbs: [
      'send', 'post', 'publish', 'deliver', 'dispatch', 'notify',
      'dm', 'email', 'sms', 'reply', 'forward', 'invite', 'upload',
      'webhook', 'announce', 'broadcast',
      // Telephony: placing a real phone call is an irreversible external
      // action. These were falling through to `write` (vapi `create_call`,
      // ElevenLabs `make_outbound_call`), which defeated the goal-scope
      // send-lock and let YOLO/scope auto-approve a phone call. Specific
      // compounds (not bare `call`) so reads like `get_call`/`list_calls`
      // are untouched.
      'dial', 'outbound_call', 'create_call', 'place_call', 'start_call',
    ],
  },
  {
    kind: 'execute',
    verbs: [
      'exec', 'execute', 'spawn', 'launch',
      'run_shell_command', 'run_workflow', 'run_plan', 'run_task',
      'run_agent', 'invoke_workflow', 'browser_harness_run',
    ],
  },
  {
    kind: 'write',
    verbs: [
      'write', 'save', 'create', 'update', 'delete', 'remove', 'patch',
      'set', 'edit', 'modify', 'append', 'prepend', 'archive', 'unarchive',
      'restore', 'add', 'put', 'remember', 'forget', 'tag', 'untag',
      'star', 'unstar', 'attach', 'detach', 'register', 'unregister',
      'mark', 'log', 'draft', 'propose', 'plan',
    ],
  },
  {
    kind: 'read',
    verbs: [
      'get', 'list', 'search', 'find', 'fetch', 'read', 'query', 'lookup',
      'retrieve', 'describe', 'browse', 'scan', 'view', 'inspect', 'status',
      'head', 'peek', 'count', 'summarize', 'recall', 'observe', 'capture',
      'ping', 'snapshot', 'preview', 'show', 'check', 'discover',
      // Discovery verbs added 2026-05-19 to stop the Orchestrator from
      // approval-gating on read-only discovery surfaces (local_cli_probe,
      // composio_status, mcp_status, etc.). These never mutate — they
      // run --version/--help, query connection state, list catalog
      // entries. Gating them is friction the user reads as a bug.
      'probe', 'detect', 'enumerate', 'audit', 'introspect',
      'browser_harness_status',
    ],
  },
];

/**
 * True when `verb` appears as a whole underscore-delimited word in `name`.
 * Examples:
 *   matchesVerb('memory_search', 'search') → true
 *   matchesVerb('search_files', 'search') → true
 *   matchesVerb('db_search_v2', 'search') → true
 *   matchesVerb('searcher_bot', 'search') → false
 *   matchesVerb('run_shell_command', 'run_shell_command') → true (multi-word verb)
 */
function matchesVerb(name: string, verb: string): boolean {
  if (name === verb) return true;
  if (name.startsWith(verb + '_')) return true;
  if (name.endsWith('_' + verb)) return true;
  if (name.includes('_' + verb + '_')) return true;
  return false;
}

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
  return classifyComposioSlugEffect(slug) === 'read' ? 'read' : 'send';
}

/** Public — used by every tool family's `needsApproval` factory. */
export function classifyTool(name: string, options: ClassifyOptions = {}): ToolKind {
  if (options.kindHint) return options.kindHint;

  if (ALWAYS_READ.has(name)) return 'read';

  // DataForSEO MCP endpoints are read-only SEO data lookups. They do
  // hit an external service, but they do not mutate third-party state.
  // Treating every `dataforseo__*` call as "write" caused SEO audits to
  // stop for approval on every lookup.
  const rawLower = name.toLowerCase();
  if (rawLower.startsWith('dataforseo__') || rawLower.startsWith('dataforseo-mcp-server__')) {
    return 'read';
  }

  // memory_self_heal is mixed-mode: list/dry_run only inspect proposed
  // reversible fixes; run/apply/revert mutate memory importance/activity via
  // the audited self-heal path. Missing/unknown action stays conservative.
  if (name === 'memory_self_heal' || name.endsWith('__memory_self_heal')) {
    const action = options.args && typeof options.args === 'object'
      ? (options.args as { action?: unknown }).action
      : undefined;
    if (action === 'list' || action === 'dry_run') return 'read';
    return 'write';
  }

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
  let patternKind: ToolKind | undefined;
  for (const { kind, verbs } of NAME_PATTERNS) {
    for (const verb of verbs) {
      if (matchesVerb(norm, verb)) { patternKind = kind; break; }
    }
    if (patternKind) break;
  }

  // A native (non-composio) comm-object send that the send-verb list MISSES —
  // create_event (emails invitees), respond_to_event (RSVP email),
  // create_message, create_invite — matches the 'write' verb (create/respond)
  // and would classify as 'write', slipping past the send lock under a wildcard
  // scope (2026-07-09 re-hunt: native MCP shim lane). Route through the ONE
  // canonical predicate to UPGRADE write→send. Guarded to only touch a WRITE (or
  // unmatched default) — never a read/execute/admin — so `get_call`/`list_calls`
  // (CALL as a noun, not the verb) stay reads.
  if ((patternKind === undefined || patternKind === 'write') && isIrreversibleSendSlug(name)) {
    return 'send';
  }
  if (patternKind) return patternKind;

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
   * Optional: caller already computed whether the args resolve to a
   * path inside the agent's OWN data directory (~/.clementine-next/).
   * When true, the call auto-approves regardless of scope — the agent
   * writing to its own vault/state/analysis dirs is bookkeeping, not a
   * user-visible action. Not relevant for `send` (network).
   */
  insideAgentOwnedDirHint?: boolean;
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
    | 'agent-owned-dir'
    | 'local-workspace-write'
    | 'plan-scope'
    | 'workspace-policy'
    | 'yolo-policy'
    | 'send-trust'
    | 'strict-policy'
    | 'pending-action-owned'
    | 'unknown';
  kind: ToolKind;
}

export function decideToolApproval(input: ApprovalDecisionInput): ApprovalDecision {
  const kind = classifyTool(input.toolName, {
    kindHint: input.kindHint,
    args: input.args,
  });

  // Local memory bookkeeping is the cheapest possible write — no
  // network, no external mutation, no shared state. Treat as read
  // for approval purposes regardless of the kind classifier's word
  // matching (e.g. `tool_choice_remember` matches the `remember`
  // verb and would otherwise count as `write`).
  if (NEVER_GATE_LOCAL_MEMORY.has(input.toolName)) {
    return { needsApproval: false, reason: 'read-always-auto', kind };
  }

  // run_batch's approval contract lives on the QUEUED PENDING ACTION, never
  // on the tool call: propose/status only validate + certify + queue (no
  // external effect), and execute refuses server-side unless the pending
  // action is already APPROVED (byte-pinned payload). A per-tool interrupt
  // here is the DOUBLE-approval users hit on send batches — one card to
  // propose, a second to approve the queued plan (live 2026-07-09
  // double-approval regression: four cards for one 10-email batch). Same class as the
  // 2026-06-17 double-approval fix above.
  if (input.toolName === 'run_batch') {
    return { needsApproval: false, reason: 'pending-action-owned', kind };
  }

  if (kind === 'admin') {
    return { needsApproval: true, reason: 'admin', kind };
  }
  if (input.isDestructiveHint) {
    return { needsApproval: true, reason: 'destructive-hint', kind };
  }
  if (kind === 'read') {
    return { needsApproval: false, reason: 'read-always-auto', kind };
  }

  // Writes inside the agent's OWN data directory auto-approve regardless
  // of scope. Admin + destructive checks above still gate; this only
  // applies to write/execute on agent-managed paths (vault, state, logs,
  // meeting-capture/analysis/, etc.). For 'send' (network) there's no
  // path concept, so the hint is meaningless and ignored.
  if (kind !== 'send' && input.insideAgentOwnedDirHint) {
    if (input.sessionId) {
      recordAutoApproval(
        input.sessionId,
        input.toolName,
        `[agent-owned-dir] kind=${kind} ${summarizeToolArgs(input.toolName, input.args)}`,
      );
    }
    return { needsApproval: false, reason: 'agent-owned-dir', kind };
  }

  const policy = loadProactivityPolicy();
  // `evaluateAutoApprove` already knows about plan-scope, yolo, and
  // workspace. For 'send' (network mutations) there's no workspace
  // concept — pass insideWorkspace=false so the workspace branch never
  // fires.
  const decision = evaluateAutoApprove({
    sessionId: input.sessionId,
    toolName: input.toolName,
    args: input.args,
    scope: policy.autoApproveScope satisfies AutoApproveScope,
    insideWorkspace: kind === 'send' ? false : Boolean(input.insideWorkspaceHint),
    // The goal-scoped send lock keys on whether this is an irreversible send.
    kindHint: kind === 'send' ? 'send' : 'other',
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
      : decision.reason === 'send-trust' ? 'send-trust'
      : 'unknown';
    return { needsApproval: false, reason, kind };
  }

  // `write_file` is Clementine's local artifact surface. If the path
  // resolved inside the same allowed roots that the tool can write to,
  // do not interrupt the turn for an approval: the user already gave
  // consent by asking for a report, proposal, CSV, draft, etc. Network
  // sends, shell commands, admin ops, and destructive hints still use
  // the normal approval gates above/below.
  if (input.toolName === 'write_file' && input.insideWorkspaceHint) {
    if (input.sessionId) {
      recordAutoApproval(
        input.sessionId,
        input.toolName,
        `[local-workspace-write] kind=${kind} ${summarizeToolArgs(input.toolName, input.args)}`,
      );
    }
    return { needsApproval: false, reason: 'local-workspace-write', kind };
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
    computeInsideAgentOwnedDir?: (input: unknown) => boolean;
    isDestructive?: (input: unknown) => boolean;
  } = {},
): (runContext: unknown, input: unknown) => Promise<boolean> {
  return async (runContext, input) => {
    const sessionId = extractSessionId(runContext);
    const insideWorkspaceHint = options.computeInsideWorkspace?.(input);
    const insideAgentOwnedDirHint = options.computeInsideAgentOwnedDir?.(input);
    const isDestructiveHint = options.isDestructive?.(input);
    const { needsApproval } = decideToolApproval({
      sessionId,
      toolName,
      kindHint: options.kindHint,
      args: input,
      insideWorkspaceHint,
      insideAgentOwnedDirHint,
      isDestructiveHint,
    });
    return needsApproval;
  };
}

function extractSessionId(runContext: unknown): string | undefined {
  if (runContext && typeof runContext === 'object') {
    const ctx = (runContext as { context?: unknown }).context;
    if (ctx && typeof ctx === 'object') {
      const sid = (ctx as { sessionId?: unknown }).sessionId;
      if (typeof sid === 'string' && sid) return sid;
    }
  }
  // Worker/asTool sub-runs do not always carry the SDK context object
  // through needsApproval, but they still execute under the harness
  // AsyncLocalStorage. Fall back to that session so batch plan-scopes
  // cover child-worker Composio writes too.
  return harnessRunContextStorage.getStore()?.sessionId;
}
