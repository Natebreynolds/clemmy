/**
 * Single Tool Registry.
 *
 * This file is the one place that records, for every built-in tool, which
 * surfaces advertise it and how it is classified. The conformance test
 * (`tool-registry.test.ts`) pins the derived surfaces so drift fails CI.
 *
 * Design constraints carried from the plan's risk list:
 *   - Everything is lazily evaluated: the registry is a self-contained array of
 *     plain string/enum literals with NO cross-module imports, so it can never
 *     participate in the sub-agents ← orchestrator ← workflow-step-agent import
 *     cycle or hit a TDZ (risk #5). Derivations are plain functions.
 *   - Unknown/absent side-effect must never ungate: `deriveNeedsApproval` defaults
 *     anything that is not a pure `read` to "ask" (risk #2).
 *   - Blocklists stay NEGATIVE: `blockedFor` is a subtractive property over the
 *     derived full surface, never an allowlist (risk #1).
 *
 * FIELD PROVENANCE (where each value was transcribed from, 2026-07-07):
 *   - name .......... the registered MCP tool name.
 *   - sideEffect .... `classifyTool(name)` from tool-taxonomy.ts, with its
 *                     `'execute'` kind folded into `'write'` (both gate identically).
 *                     This is the CURRENT taxonomy verdict, quirks and all — it is a
 *                     mirror, not a proposal.
 *   - tier .......... `'core'` iff the name is in TOOL_JIT_MANDATED (tool-jit.ts);
 *                     else `'discoverable'`. core = never JIT-pruned.
 *   - lanes ......... which advertise surfaces list the name TODAY:
 *                       orchestrator = orchestrator.ts discoveryTools (deduped)
 *                       sdk-brain    = CLAUDE_AGENT_SDK_FULL_TOOLS
 *                       sdk-worker   = CLAUDE_AGENT_SDK_WORKER_TOOLS
 *                       code-mode    = code-mode-tool.ts READ_ONLY_TOOLS ∪ WRITE_TOOLS
 *                       cli          = catalog.ts LOCAL_MCP_TOOL_NAMES
 *                     (A tool can be MANDATED/core yet have empty lanes — e.g.
 *                     draft_plan/goal_stale/request_approval are structural or
 *                     added outside these allowlists.)
 *   - sdkLayer ...... the FINEST Claude-Agent-SDK profile layer the name belongs to
 *                     (claude-agent-sdk.ts). Profiles nest, so the four layers
 *                     compose the four exported profiles — see deriveSdkProfile.
 *   - codeMode ...... `'read'` (READ_ONLY_TOOLS) or `'write'` (WRITE_TOOLS) for the
 *                     code-mode program allowlist; absent otherwise.
 *   - featureGroup .. `'spaces-dock'` for WORKSPACE_DOCK_TOOLS (workspace-context.ts).
 *   - blockedFor .... F1/F2 subtractive filters: `'workflow-step'` iff in
 *                     WORKFLOW_STEP_BLOCKED_TOOL_NAMES; `'worker'` iff in that set
 *                     OR the name is `notify_user` (workerBlockedToolNames = F1 ∪
 *                     {notify_user}).
 *   - loopClass ..... B1 guardrail loop-threshold class (tool-guardrail.ts):
 *                     `'idempotent'` iff in IDEMPOTENT_TOOLS (safe-to-retry read →
 *                     loose thresholds); `'mutating'` iff in MUTATING_TOOLS (looping
 *                     CAN corrupt state → tight thresholds). Absent = neither set
 *                     (default thresholds). This is NOT derivable from sideEffect —
 *                     MUTATING_TOOLS deliberately includes read-sideEffect tools
 *                     whose REPEAT is harmful (notify_user, ask_user_question,
 *                     request_approval, workflow_run, workflow_rerun_failed_items),
 *                     so it is transcribed as its own axis.
 *   - cacheSafeRead . B1 CACHE_SAFE_READS (tool-guardrail.ts): a read whose result
 *                     is stable for a task's life absent an observable in-session
 *                     mutation → the within-task recall nudge may point at a cached
 *                     copy. A NARROWER allowlist than idempotent (idempotent ≠ static).
 *                     Every cacheSafeRead is also loopClass 'idempotent'.
 *   - readMutatedBy . B1 READ_MUTATORS[name] (tool-guardrail.ts): the in-session
 *                     mutator tool names that invalidate this read's cache. Only set
 *                     on cache-safe reads that HAVE a mapped invalidator (the
 *                     skill_* and composio_*_tools reads have none → never invalidate →
 *                     no readMutatedBy). Recorded VERBATIM including the phantom
 *                     mutator `replace_file` (documented drift, not fixed).
 */

export type ToolLane = 'orchestrator' | 'sdk-brain' | 'sdk-worker' | 'workflow-step' | 'code-mode' | 'cli';
export type ToolSideEffect = 'read' | 'write' | 'send' | 'admin';
export type ToolTier = 'core' | 'discoverable';
/** Finest SDK profile layer. Profiles nest: read-only ⊂ authoring; worker =
 *  read-only ∪ agentic; full = read-only ∪ authoring ∪ agentic ∪ full-extra. */
export type SdkLayer = 'read-only' | 'authoring' | 'agentic' | 'full-extra';
export type ToolFeatureGroup = 'spaces-dock';

export interface ToolDecl {
  name: string;
  /** Effect class from the taxonomy (execute folded into write). Advisory in step 1. */
  sideEffect: ToolSideEffect;
  /** core = in TOOL_JIT_MANDATED (never JIT-pruned); discoverable = JIT-able. */
  tier: ToolTier;
  /** Advertise surfaces that list this tool today. */
  lanes: ToolLane[];
  /** Claude-Agent-SDK profile layer this tool sits in, if any. */
  sdkLayer?: SdkLayer;
  /** Code-mode program allowlist membership + direction, if any. */
  codeMode?: 'read' | 'write';
  /** Feature-bundle membership (A6-style pins). */
  featureGroup?: ToolFeatureGroup;
  /** Subtractive filters — NEGATIVE properties over the derived full surface. */
  blockedFor?: Array<'worker' | 'workflow-step'>;
  /** B1 guardrail loop-threshold class. NOT derivable from sideEffect (see doc). */
  loopClass?: 'idempotent' | 'mutating';
  /** B1 CACHE_SAFE_READS membership (a narrower subset of idempotent reads). */
  cacheSafeRead?: true;
  /** B1 READ_MUTATORS[name] — in-session mutators that invalidate this read's cache. */
  readMutatedBy?: string[];
  /** Optional explicit approval override; default derives from sideEffect. */
  needsApproval?: boolean;
  /** One-line summary (first sentence of the registered tool description, capped
   *  ~90 chars) — the catalog line the Codex lane reads for schema-on-demand. */
  description?: string;
}

/**
 * CURRENT truth for every built-in tool that appears in any advertise / JIT /
 * code-mode surface (union of: catalog LOCAL_MCP_TOOL_NAMES, orchestrator
 * discoveryTools, the four SDK profiles, TOOL_JIT_MANDATED, code-mode
 * READ_ONLY_TOOLS/WRITE_TOOLS). Sorted by name. Generated by transcription from
 * the sources above and locked by tool-registry.test.ts.
 */
export const TOOL_REGISTRY: ToolDecl[] = [
  { name: 'agent_propose', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', blockedFor: ['workflow-step', 'worker'], description: 'Draft a reusable team-agent proposal for user review.' },
  { name: 'agent_run_get', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', loopClass: 'idempotent', description: 'Fetch the full event timeline of a single autonomy cycle by runId.' },
  { name: 'agent_runs_recent', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', loopClass: 'idempotent', description: 'List recent autonomy cycles (daemon-source runs).' },
  { name: 'answer_check_in', sideEffect: 'read', tier: 'discoverable', lanes: ['cli'], description: 'Resolve an open check-in with an answer.' },
  { name: 'ask_user_question', sideEffect: 'read', tier: 'core', lanes: ['sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', blockedFor: ['workflow-step', 'worker'], loopClass: 'mutating', description: 'Pause and ask the user a clarifying question.' },
  { name: 'background_task_status', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', loopClass: 'idempotent', description: 'Inspect a durable background task by task id, run id, or session id.' },
  { name: 'background_tasks_recent', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', loopClass: 'idempotent', description: 'List recent durable background tasks with status, latest activity, approvals, and result…' },
  { name: 'browser_harness_run', sideEffect: 'write', tier: 'core', lanes: ['orchestrator', 'cli'], description: 'Run a Browser Harness Python snippet against the user browser through the browser-harness…' },
  { name: 'browser_harness_status', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'cli'], description: 'Check Browser Harness availability and setup state.' },
  // Generic gated dispatcher for schema-on-demand (SCHEMA-ON-DEMAND-PLAN-2026-07-07,
  // Phase 1). Structural, orchestrator-lane only, added to assembledTools ONLY when
  // CLEMMY_CODEX_TOOL_SEARCH is on (lanes [] like request_approval/run_worker).
  // sideEffect 'write' = documented default-ask, but needsApproval is FALSE: the
  // runtime gate keys on the INNER tool (dispatchBatchItemTool), not call_tool.
  { name: 'call_tool', sideEffect: 'write', tier: 'core', lanes: [], needsApproval: false, description: 'Invoke a catalog-only built-in tool by name with a JSON args string; effects and gates key on the inner tool.' },
  { name: 'check_capability', sideEffect: 'read', tier: 'discoverable', lanes: ['cli'], description: 'Check whether a CLI / binary is available on this machine.' },
  { name: 'check_delegation', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', description: 'Check a delegated task by ID or list delegations for an agent.' },
  { name: 'composio_execute_tool', sideEffect: 'write', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode', 'cli'], sdkLayer: 'agentic', codeMode: 'write', loopClass: 'mutating', description: 'Execute any Composio action by exact slug (Outlook list-mail, Gmail search, Drive search,…' },
  { name: 'composio_list_tools', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'agentic', loopClass: 'idempotent', cacheSafeRead: true, description: 'List available Composio tools for one connected toolkit slug, such as gmail, slack, notio…' },
  { name: 'composio_search_tools', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode', 'cli'], sdkLayer: 'agentic', codeMode: 'read', loopClass: 'idempotent', cacheSafeRead: true, description: 'Search Composio for the right action slug.' },
  { name: 'composio_status', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode', 'cli'], sdkLayer: 'read-only', codeMode: 'read', loopClass: 'idempotent', description: 'Inspect whether Composio is configured and list active third-party app connections availa…' },
  { name: 'convert_to_markdown', sideEffect: 'write', tier: 'discoverable', lanes: ['cli'], description: 'Extract a non-text file (PDF, Word/Excel/PowerPoint, EPub, image, audio, …) into Markdown…' },
  { name: 'create_agent', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', blockedFor: ['workflow-step', 'worker'], description: 'Create a new active team agent with its own personality, tools, and project binding.' },
  { name: 'create_tool', sideEffect: 'admin', tier: 'discoverable', lanes: ['cli'], blockedFor: ['workflow-step', 'worker'], description: 'Create a reusable shell or python tool script in ~/.clementine-next/tools.' },
  { name: 'cron_progress_read', sideEffect: 'read', tier: 'discoverable', lanes: ['cli'], description: 'Read saved progress state for a cron job.' },
  { name: 'delegate_task', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', blockedFor: ['workflow-step', 'worker'], description: 'Delegate a task to another team agent using local delegation state.' },
  { name: 'delete_agent', sideEffect: 'admin', tier: 'discoverable', lanes: ['cli'], blockedFor: ['workflow-step', 'worker'], description: 'Delete an agent definition.' },
  { name: 'desktop_status', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator'], description: 'Read-only status for the locally installed Clementine desktop app, including installed bu…' },
  { name: 'discover_work', sideEffect: 'read', tier: 'discoverable', lanes: ['cli'], loopClass: 'idempotent', description: 'Scan handoffs, plans, goals, tasks, and inbox items to find prioritized work that should…' },
  { name: 'dispatch_background_task', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', description: 'Hand an AGREED, multi-step task to the reliable background runner (fire-and-forget).' },
  { name: 'draft_plan', sideEffect: 'read', tier: 'core', lanes: [], description: 'Draft a structured plan for multi-step work before executing it.' },
  { name: 'execution_complete', sideEffect: 'write', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'full-extra', loopClass: 'mutating', description: 'Mark an execution as completed.' },
  { name: 'execution_create', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain'], sdkLayer: 'full-extra', description: 'Create a tracked execution lane for multi-step or mutating external work.' },
  { name: 'execution_get', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'full-extra', description: 'Fetch one execution by id with full context (objective, plan, next step, success criteria…' },
  { name: 'execution_list', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'full-extra', description: 'List executions for inspection.' },
  { name: 'execution_mark_blocked', sideEffect: 'write', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'full-extra', loopClass: 'mutating', description: 'Mark an execution as blocked with a concrete blocker description.' },
  { name: 'execution_update_step', sideEffect: 'write', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'full-extra', loopClass: 'mutating', description: 'Advance an execution: record the next concrete step and an optional summary of what just…' },
  { name: 'focus_activate', sideEffect: 'write', tier: 'core', lanes: ['orchestrator'], loopClass: 'mutating', description: 'Resume a previously parked focus.' },
  { name: 'focus_clear', sideEffect: 'write', tier: 'core', lanes: ['orchestrator'], loopClass: 'mutating', description: 'Mark a focus as done.' },
  { name: 'focus_get', sideEffect: 'read', tier: 'core', lanes: ['orchestrator'], loopClass: 'idempotent', cacheSafeRead: true, readMutatedBy: ['focus_set', 'focus_update', 'focus_touch', 'focus_park', 'focus_activate', 'focus_clear'], description: 'Read the assistant\'s current attention pointer.' },
  { name: 'focus_park', sideEffect: 'write', tier: 'core', lanes: ['orchestrator'], loopClass: 'mutating', description: 'Park the active focus — flips it from active to paused so it stays resumable but no longe…' },
  { name: 'focus_set', sideEffect: 'write', tier: 'core', lanes: ['orchestrator'], loopClass: 'mutating', description: 'Pin a NEW current focus.' },
  { name: 'focus_touch', sideEffect: 'write', tier: 'core', lanes: ['orchestrator'], loopClass: 'mutating', description: 'Bump the last-touched time + reset the idle-confirm window for an active focus.' },
  { name: 'focus_update', sideEffect: 'write', tier: 'core', lanes: ['orchestrator'], loopClass: 'mutating', description: 'Evolve an existing focus IN PLACE — same id, same active status, but updated title and/or…' },
  { name: 'git_status', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', loopClass: 'idempotent', description: 'Run a read-only git status in an allowed workspace directory.' },
  { name: 'goal_list', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'cli'], loopClass: 'idempotent', description: 'List persistent goals, optionally filtered by owner or status.' },
  { name: 'goal_stale', sideEffect: 'write', tier: 'core', lanes: [], description: 'Detect or mark long-running goals that have gone stale (not updated in a while).' },
  { name: 'goal_upsert', sideEffect: 'write', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', loopClass: 'mutating', description: 'Create a persistent goal when no id matches, or update the existing goal when one does — the single durable-goal write tool.' },
  { name: 'harness_status', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', loopClass: 'idempotent', description: 'Inspect Clementine harness-internal capability health.' },
  { name: 'hold_task_for_later', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', description: 'HOLD an agreed multi-step task for later instead of running it now — the "or you can ask…' },
  { name: 'list_files', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode', 'cli'], sdkLayer: 'read-only', codeMode: 'read', loopClass: 'idempotent', cacheSafeRead: true, readMutatedBy: ['write_file', 'replace_file', 'run_shell_command'], description: 'List files in an allowed workspace directory.' },
  { name: 'list_pending_check_ins', sideEffect: 'read', tier: 'discoverable', lanes: ['cli'], description: 'List open check-ins waiting for a user answer.' },
  { name: 'local_cli_list', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode', 'cli'], sdkLayer: 'agentic', codeMode: 'read', description: 'List CLIs installed on the local machine and detected on $PATH.' },
  { name: 'local_cli_probe', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode', 'cli'], sdkLayer: 'agentic', codeMode: 'read', description: 'Probe a specific local CLI by running `<command> --version` and `<command> --help`.' },
  { name: 'mcp_add', sideEffect: 'admin', tier: 'discoverable', lanes: ['orchestrator', 'cli'], description: 'Create a NEW external MCP server configuration.' },
  { name: 'mcp_configure', sideEffect: 'admin', tier: 'discoverable', lanes: ['orchestrator', 'cli'], description: 'Edit an EXISTING external MCP server\'s NON-SECRET fields (description/command/args/url/he…' },
  { name: 'mcp_reconnect', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'cli'], description: 'Recover an external MCP server that is degraded/unavailable (stuck in the connection back…' },
  { name: 'mcp_status', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', description: 'Inspect configured external MCP servers available to Clementine.' },
  { name: 'memory_embed_backfill', sideEffect: 'write', tier: 'discoverable', lanes: ['cli'], description: 'Compute embeddings for vault chunks and/or durable facts using the active embedding provi…' },
  { name: 'memory_forget', sideEffect: 'write', tier: 'core', lanes: ['orchestrator', 'cli'], loopClass: 'mutating', description: 'Soft-delete a fact by id (sets active=0).' },
  { name: 'memory_import', sideEffect: 'write', tier: 'discoverable', lanes: ['cli'], description: 'Import ANOTHER agent\'s memory files (Claude Code memories, OpenClaw/Fermis stores, bare m…' },
  { name: 'memory_list_facts', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', loopClass: 'idempotent', description: 'List or query durable facts as filterable JSON. Pass query for targeted lookup.' },
  { name: 'memory_pin', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'cli'], description: 'Pin a fact as a STANDING INSTRUCTION (always injected into context, exempt from the recen…' },
  { name: 'memory_read', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode', 'cli'], sdkLayer: 'read-only', codeMode: 'read', loopClass: 'idempotent', description: 'Read a durable memory reference (fact:<id> or policy:<id>), a key memory file, or a vault-relative markdown path.' },
  { name: 'memory_recall', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode', 'cli'], sdkLayer: 'read-only', codeMode: 'read', loopClass: 'idempotent', cacheSafeRead: true, readMutatedBy: ['memory_remember', 'memory_forget'], description: 'Recall vault chunks.' },
  { name: 'memory_recall_all', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode', 'cli'], sdkLayer: 'read-only', codeMode: 'read', loopClass: 'idempotent', cacheSafeRead: true, readMutatedBy: ['memory_remember', 'memory_forget'], description: 'Recall relevant facts, notes, entities, resources, episodes, policies, and proven tools through one evidence-backed pipeline.' },
  { name: 'memory_remember', sideEffect: 'write', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', loopClass: 'mutating', description: 'Record a durable fact in long-term memory.' },
  { name: 'memory_restore', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'cli'], description: 'Restore (reactivate) a soft-deleted fact by id — the inverse of memory_forget.' },
  { name: 'memory_review_instructions', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'cli'], description: 'Before a batch/irreversible external write, review the standing instructions in play.' },
  { name: 'memory_search', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode', 'cli'], sdkLayer: 'read-only', codeMode: 'read', loopClass: 'idempotent', cacheSafeRead: true, readMutatedBy: ['memory_remember', 'memory_forget'], description: 'Search the local Clementine vault for relevant notes and memories.' },
  { name: 'memory_search_facts', sideEffect: 'read', tier: 'discoverable', lanes: ['sdk-brain', 'sdk-worker', 'code-mode', 'cli'], sdkLayer: 'read-only', codeMode: 'read', description: 'Semantically search durable FACTS (your long-term memory of the user, projects, standing…' },
  { name: 'memory_self_heal', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'cli'], description: 'Inspect or run the audited long-term-memory self-heal loop.' },
  { name: 'note_create', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', loopClass: 'mutating', description: 'Create a new note in the vault.' },
  { name: 'notify_user', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'agentic', blockedFor: ['worker'], loopClass: 'mutating', description: 'Send a notification to the user via the notification queue.' },
  { name: 'offer_background', sideEffect: 'read', tier: 'core', lanes: ['cli'], description: 'Offer to run an agreed multi-step or longer task in the background instead of blocking th…' },
  { name: 'pending_action_get', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', description: 'Read one queued action with its exact payload, status, approval id, preview, and result h…' },
  { name: 'pending_action_list', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', description: 'List durable pending actions.' },
  { name: 'pending_action_queue', sideEffect: 'write', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', description: 'Queue a fully prepared action payload before an irreversible external write/send/deploy o…' },
  { name: 'pending_action_record_result', sideEffect: 'write', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', description: 'After executing or cancelling a queued action, record the outcome so Clementine can repor…' },
  { name: 'ping', sideEffect: 'read', tier: 'discoverable', lanes: ['sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', description: 'Basic health-check tool for the local Clementine tool runtime.' },
  { name: 'propose_check_in_template', sideEffect: 'read', tier: 'discoverable', lanes: ['cli'], description: 'Propose a NEW autonomous check-in template the user can approve.' },
  { name: 'read_file', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode', 'cli'], sdkLayer: 'read-only', codeMode: 'read', loopClass: 'idempotent', cacheSafeRead: true, readMutatedBy: ['write_file', 'replace_file', 'run_shell_command'], description: 'Read a file from an allowed workspace path.' },
  { name: 'recall_tool_result', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode'], sdkLayer: 'read-only', codeMode: 'read', loopClass: 'idempotent', description: 'Retrieve the full verbatim output of a prior tool call by its call_id.' },
  { name: 'request_approval', sideEffect: 'write', tier: 'core', lanes: [], loopClass: 'mutating', description: 'Pause and ask the user to approve a high-risk action or one batch of same-shape external…' },
  { name: 'resume_held_task', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', description: 'Resume a task the user previously asked you to HOLD (see your Current Focus "Held" list),…' },
  { name: 'run_batch', sideEffect: 'write', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'full-extra', description: 'Deterministic batch executor for N same-shape tool calls: reason ONCE (bake every item\'s…' },
  { name: 'run_shell_command', sideEffect: 'write', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode', 'cli'], sdkLayer: 'agentic', codeMode: 'write', loopClass: 'mutating', description: 'Run a shell command in an allowed workspace directory.' },
  { name: 'run_tool_program', sideEffect: 'write', tier: 'core', lanes: ['orchestrator'], description: 'Run ONE short JavaScript program (the body of an async function — use `return` for the re…' },
  { name: 'run_worker', sideEffect: 'write', tier: 'core', lanes: ['sdk-brain'], sdkLayer: 'full-extra', blockedFor: ['workflow-step', 'worker'], description: 'Spawn a stateless Worker on ONE item using a structured parent-planned job packet.' },
  { name: 'session_history', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode', 'cli'], sdkLayer: 'read-only', codeMode: 'read', loopClass: 'idempotent', description: 'Read recent conversation history for a session.' },
  { name: 'session_pause', sideEffect: 'write', tier: 'discoverable', lanes: ['cli'], description: 'Save a structured handoff for a session so work can resume cleanly after context drift, a…' },
  { name: 'session_resume', sideEffect: 'write', tier: 'discoverable', lanes: ['cli'], description: 'Summarize a session using its continuity brief and recent transcript so work can resume c…' },
  { name: 'set_model_role', sideEffect: 'write', tier: 'core', lanes: ['orchestrator', 'sdk-brain'], sdkLayer: 'authoring', description: 'Route a model ROLE to a specific model, when the user asks in chat (e.g.' },
  { name: 'set_timer', sideEffect: 'write', tier: 'discoverable', lanes: ['cli'], description: 'Set a short-term reminder.' },
  { name: 'share_plan', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'cli'], description: 'Share a non-blocking working plan in the current chat before continuing.' },
  { name: 'skill_list', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode', 'cli'], sdkLayer: 'read-only', codeMode: 'read', loopClass: 'idempotent', cacheSafeRead: true, description: 'List installed SKILL.md skills (Anthropic Skills format) with name + one-line description.' },
  { name: 'skill_read', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode', 'cli'], sdkLayer: 'read-only', codeMode: 'read', loopClass: 'idempotent', cacheSafeRead: true, description: 'Load the full body of an installed SKILL.md skill into context.' },
  { name: 'source_map_upsert', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', description: 'Record WHERE a resource lives in one of the user\'s connected sources — a Drive folder, an…' },
  { name: 'space_edit_runner', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain'], sdkLayer: 'authoring', featureGroup: 'spaces-dock', description: 'Make a TARGETED, reversible edit to a Workspace runner\'s SOURCE — FAST, for changing what…' },
  { name: 'space_edit_view', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain'], sdkLayer: 'authoring', featureGroup: 'spaces-dock', description: 'Make a TARGETED edit to an existing Workspace view — FAST, for small tweaks (a button, la…' },
  { name: 'space_get', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker'], sdkLayer: 'read-only', featureGroup: 'spaces-dock', description: 'Read a Workspace: its manifest (title, status, data sources, re-engage contract), a snaps…' },
  { name: 'space_get_runner', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker'], sdkLayer: 'read-only', featureGroup: 'spaces-dock', description: 'Read the SOURCE of a Workspace data/action RUNNER (the .mjs/.py/.sh script under data/ th…' },
  { name: 'space_get_view', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker'], sdkLayer: 'read-only', featureGroup: 'spaces-dock', description: 'Read the CURRENT view HTML of a Workspace, line-numbered — this is the EXACT text you nee…' },
  { name: 'space_list', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker'], sdkLayer: 'read-only', featureGroup: 'spaces-dock', description: 'List the user\'s Workspaces (persistent interactive surfaces you built).' },
  { name: 'space_publish', sideEffect: 'send', tier: 'discoverable', lanes: ['sdk-brain'], sdkLayer: 'authoring', featureGroup: 'spaces-dock', description: 'Export a Workspace as a STATIC, share-ready snapshot — the shareable counterpart to the l…' },
  { name: 'space_refresh', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain'], sdkLayer: 'authoring', featureGroup: 'spaces-dock', description: 'Re-run a Workspace\'s data source(s) NOW (server-side, no LLM) and persist the fresh datas…' },
  { name: 'space_revert_runner', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain'], sdkLayer: 'authoring', featureGroup: 'spaces-dock', description: 'Undo the most recent space_edit_runner on a runner, restoring its prior source from the s…' },
  { name: 'space_save', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain'], sdkLayer: 'authoring', featureGroup: 'spaces-dock', description: 'Create or update a Workspace — a persistent, interactive HTML surface you build for the u…' },
  { name: 'space_set_data', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain'], sdkLayer: 'authoring', featureGroup: 'spaces-dock', description: 'Commit a dataset you ALREADY HAVE IN HAND directly into the workspace under a source id —…' },
  { name: 'space_try_runner', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain'], sdkLayer: 'authoring', featureGroup: 'spaces-dock', description: 'DRY-RUN a data runner you wrote (a .mjs/.js/.ts/.py/.sh under the workspace data/ dir) an…' },
  { name: 'surface_plan', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'cli'], blockedFor: ['workflow-step', 'worker'], description: 'Surface a Plan you just received from `draft_plan` to the user for review.' },
  { name: 'task_add', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', loopClass: 'mutating', description: 'Add a SINGLE one-shot task to the user\'s TODO list.' },
  { name: 'task_hygiene', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'cli'], description: 'Repair and compact the task ledger so completed execution-owned tasks do not remain in th…' },
  { name: 'task_list', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', loopClass: 'idempotent', description: 'List tasks from the master task list.' },
  { name: 'task_update', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', loopClass: 'mutating', description: 'Update a task by ID and optionally move it between pending and completed.' },
  { name: 'team_list', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', description: 'List all team agents and their messaging permissions.' },
  { name: 'team_message', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', description: 'Queue a message to another team agent.' },
  { name: 'team_pending_requests', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', description: 'List pending requests assigned to the current team agent.' },
  { name: 'team_reply', sideEffect: 'send', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', description: 'Reply to a queued team request and mark it completed.' },
  { name: 'team_request', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', description: 'Create a structured request for another team agent and queue it locally.' },
  { name: 'tool_choice_forget', sideEffect: 'write', tier: 'core', lanes: ['orchestrator'], description: 'HARD-clear a remembered tool choice so the next request fully re-discovers it.' },
  { name: 'tool_choice_invalidate', sideEffect: 'write', tier: 'core', lanes: ['orchestrator', 'cli'], loopClass: 'mutating', description: 'Mark the currently-recorded tool choice for an intent as broken.' },
  { name: 'tool_choice_recall', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', loopClass: 'idempotent', description: 'Look up the previously-recorded tool choice for an intent (per-machine memory).' },
  { name: 'tool_choice_remember', sideEffect: 'write', tier: 'core', lanes: ['orchestrator', 'cli'], loopClass: 'mutating', description: 'Save the tool that worked for an intent so future runs skip discovery.' },
  { name: 'tool_output_query', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode'], sdkLayer: 'read-only', codeMode: 'read', description: 'Query a slice of a large prior tool output by its call_id, without loading the whole payl…' },
  { name: 'tool_search', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', description: 'Search the full built-in tool catalog by intent and get matching names, summaries, and sc…' },
  { name: 'update_agent', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', blockedFor: ['workflow-step', 'worker'], description: 'Update an existing team agent.' },
  { name: 'user_profile_read', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode', 'cli'], sdkLayer: 'read-only', codeMode: 'read', loopClass: 'idempotent', description: 'Read the user\'s current profile (name, role, timezone, working hours, communication prefe…' },
  { name: 'workflow_apply_contract_fixes', sideEffect: 'write', tier: 'discoverable', lanes: ['cli'], description: 'Apply safe, machine-readable fixes from a workflow visual contract.' },
  { name: 'workflow_create', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', blockedFor: ['workflow-step', 'worker'], description: 'Create a workflow.' },
  { name: 'workflow_delete', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'cli'], blockedFor: ['workflow-step', 'worker'], description: 'Permanently delete a workflow definition file.' },
  { name: 'workflow_edit_step', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', description: 'Make a TARGETED, reversible edit to ONE step\'s prompt in an existing workflow — the FAST,…' },
  { name: 'workflow_from_session', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', description: 'Turn what you JUST did in this chat into a reusable, repeatable workflow.' },
  { name: 'workflow_get', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', loopClass: 'idempotent', description: 'Fetch the full definition of a single workflow by name.' },
  { name: 'workflow_import_framework', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'cli'], blockedFor: ['workflow-step', 'worker'], description: 'Import workflow framework packages from a local folder or GitHub repo.' },
  { name: 'workflow_import_status', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'cli'], description: 'Check a workflow framework import job.' },
  { name: 'workflow_list', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', loopClass: 'idempotent', description: 'List all workflows with description, steps, and trigger metadata.' },
  { name: 'workflow_rerun_failed_items', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', loopClass: 'mutating', description: 'Re-run only the failed forEach items from a prior workflow run.' },
  { name: 'workflow_run', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', blockedFor: ['workflow-step', 'worker'], loopClass: 'mutating', description: 'Dispatch a workflow to run in the BACKGROUND (fire-and-forget) — it runs in the daemon an…' },
  { name: 'workflow_run_status', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', loopClass: 'idempotent', description: 'Check workflow runs.' },
  { name: 'workflow_schedule', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', blockedFor: ['workflow-step', 'worker'], description: 'Schedule a workflow to fire on a cron expression.' },
  { name: 'workflow_set_enabled', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', blockedFor: ['workflow-step', 'worker'], description: 'Approve or disable a workflow.' },
  // Data-operation primitive (2026-07-21 capability audit #1): deterministic
  // reconcile/transform — the "spreadsheet brain". Pure read-class compute
  // (its only write is a transient staged spill file). Available everywhere
  // including workflow-step/worker/code-mode: reconciliation is the middle of
  // the employee loop and must never require a bigger lane.
  { name: 'table_ops', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'workflow-step', 'code-mode', 'cli'], sdkLayer: 'read-only', codeMode: 'read', loopClass: 'idempotent', description: 'Deterministic table algebra over lists/sheets: diff, intersect, join, dedupe, aggregate, select — sourced from inline rows, a prior tool call id (full parked output), or a staged file.' },
  // Document production (2026-07-21 capability audit #4): render→PDF/DOCX +
  // template merge. A local reversible file write (the artifact chains into
  // uploads via the file pipeline); the SEND of that artifact stays gated at
  // the send tool as always.
  { name: 'produce_document', sideEffect: 'write', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'workflow-step', 'cli'], sdkLayer: 'read-only', loopClass: 'mutating', description: 'Produce a real PDF/DOCX/HTML file from markdown or HTML with {{var}} template merge — returns a local filePath that chains into uploads/attachments.' },
  // Large-input retrieval (2026-07-21 capability audit #2 v1): deterministic
  // chunk-and-retrieve over big files (auto-converted) and parked outputs.
  { name: 'file_query', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'workflow-step', 'code-mode', 'cli'], sdkLayer: 'read-only', codeMode: 'read', loopClass: 'idempotent', description: 'Query a big document or prior tool output for relevant passages (heading-aware chunks, deterministic ranking) instead of reading a byte-clipped preview.' },
  // Mutual availability (2026-07-21 capability audit #6): pure interval
  // algebra over attendee busy windows fetched via the calendar actions.
  { name: 'time_slots', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'workflow-step', 'code-mode', 'cli'], sdkLayer: 'read-only', codeMode: 'read', loopClass: 'idempotent', description: 'Compute mutual free meeting slots from attendees\' busy intervals — exact interval algebra with working-hours/duration constraints.' },
  // Employee-memory primitive (2026-07-21): durable cross-RUN state. Core +
  // available in the workflow-step/worker lanes — that's exactly where the
  // amnesia lived (an hourly scrape re-processed the same items every run).
  // sdkLayer read-only mirrors memory_remember: a LOCAL durable write is
  // allowed even on the read-only step lane (it mutates nothing external).
  { name: 'workflow_state', sideEffect: 'write', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'workflow-step', 'cli'], sdkLayer: 'read-only', loopClass: 'mutating', description: 'Durable per-workflow memory across runs: watermarks/cursors + a processed-item ledger (filter_unprocessed / mark_processed) so recurring runs never redo work.' },
  { name: 'workflow_unschedule', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', blockedFor: ['workflow-step', 'worker'], description: 'Disable a scheduled workflow so it stops firing, without deleting it.' },
  { name: 'workflow_update', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', blockedFor: ['workflow-step', 'worker'], description: 'Modify an existing workflow: update description, trigger schedule, steps, inputs, or synt…' },
  { name: 'working_memory', sideEffect: 'write', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'cli'], sdkLayer: 'authoring', description: 'Read, append, replace, or clear the working-memory scratchpad.' },
  { name: 'workspace_artifact_query', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode', 'cli'], sdkLayer: 'read-only', codeMode: 'read', loopClass: 'idempotent', description: 'Query exact rows, fields, and pages from a JSON/JSONL run-workspace artifact.' },
  { name: 'workspace_info', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', loopClass: 'idempotent', description: 'Get detailed info about a local project including README, CLAUDE.md, manifest, and struct…' },
  { name: 'workspace_list', sideEffect: 'read', tier: 'discoverable', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'cli'], sdkLayer: 'read-only', loopClass: 'idempotent', description: 'List local projects found in configured workspace directories.' },
  { name: 'workspace_roots', sideEffect: 'read', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode', 'cli'], sdkLayer: 'read-only', codeMode: 'read', loopClass: 'idempotent', description: 'List directories Clementine is allowed to inspect or operate in.' },
  { name: 'write_file', sideEffect: 'write', tier: 'core', lanes: ['orchestrator', 'sdk-brain', 'sdk-worker', 'code-mode', 'cli'], sdkLayer: 'agentic', codeMode: 'write', loopClass: 'mutating', description: 'Create, append to, or overwrite a UTF-8 file inside an allowed local workspace path (content capped ~24KB/call — write big files in append:true chunks).' },
];

// ── Derivations (advisory in step 1; the conformance test locks them to reality) ──

/** Lazily map over the registry so no module-eval-time constant graph forms. */
function names(pred: (d: ToolDecl) => boolean): Set<string> {
  const out = new Set<string>();
  for (const d of TOOL_REGISTRY) if (pred(d)) out.add(d.name);
  return out;
}

/** catalog.ts LOCAL_MCP_TOOL_NAMES (the CLI / workflow-architect allowlist). */
export function deriveCatalogNames(): Set<string> {
  return names((d) => d.lanes.includes('cli'));
}

/** orchestrator.ts deduped discoveryTools (the live-chat surface). */
export function deriveOrchestratorDiscoveryNames(): Set<string> {
  return names((d) => d.lanes.includes('orchestrator'));
}

/**
 * One of the Claude-Agent-SDK tool profiles, reconstructed from sdkLayer.
 * The profiles NEST exactly as the source lists spread into one another:
 *   read-only : layer read-only
 *   authoring : read-only ∪ authoring
 *   agentic   : the shared execution bundle (layer agentic) — a sub-profile, not
 *               a full brain surface; equals WORKER \ READ_ONLY in the source
 *   worker    : read-only ∪ agentic
 *   full      : read-only ∪ authoring ∪ agentic ∪ full-extra (every SDK tool)
 */
export function deriveSdkProfile(profile: 'read-only' | 'authoring' | 'agentic' | 'full' | 'worker'): Set<string> {
  const inLayers = (layers: SdkLayer[]) => names((d) => d.sdkLayer != null && layers.includes(d.sdkLayer));
  switch (profile) {
    case 'read-only':
      return inLayers(['read-only']);
    case 'authoring':
      return inLayers(['read-only', 'authoring']);
    case 'agentic':
      return inLayers(['agentic']);
    case 'worker':
      return inLayers(['read-only', 'agentic']);
    case 'full':
      return inLayers(['read-only', 'authoring', 'agentic', 'full-extra']);
  }
}

/** TOOL_JIT_MANDATED / TOOL_JIT_CORE — never JIT-pruned. */
export function deriveJitCore(): Set<string> {
  return names((d) => d.tier === 'core');
}

/** code-mode-tool.ts READ_ONLY_TOOLS + WRITE_TOOLS. */
export function deriveCodeModeSets(): { readOnly: Set<string>; write: Set<string> } {
  return {
    readOnly: names((d) => d.codeMode === 'read'),
    write: names((d) => d.codeMode === 'write'),
  };
}

/** workspace-context.ts WORKSPACE_DOCK_TOOLS (A6 feature bundle). */
export function deriveWorkspaceDockNames(): Set<string> {
  return names((d) => d.featureGroup === 'spaces-dock');
}

/** F1 — WORKFLOW_STEP_BLOCKED_TOOL_NAMES (registry-registered members only). */
export function deriveWorkflowStepBlocked(): Set<string> {
  return names((d) => (d.blockedFor ?? []).includes('workflow-step'));
}

/** F2 — workerBlockedToolNames = F1 ∪ {notify_user} (registry members only). */
export function deriveWorkerBlocked(): Set<string> {
  return names((d) => (d.blockedFor ?? []).includes('worker'));
}

/** Approval default (risk #2): anything not a pure read asks unless overridden. */
export function deriveNeedsApproval(decl: ToolDecl): boolean {
  if (decl.needsApproval != null) return decl.needsApproval;
  return decl.sideEffect !== 'read';
}

/** B1 — tool-guardrail IDEMPOTENT_TOOLS (safe-to-retry reads → loose thresholds). */
export function deriveGuardrailIdempotent(): Set<string> {
  return names((d) => d.loopClass === 'idempotent');
}

/** B1 — tool-guardrail MUTATING_TOOLS (looping CAN corrupt state → tight thresholds).
 *  NOT the sideEffect==write set: it deliberately includes read-sideEffect tools
 *  whose REPEAT is harmful (notify_user, ask_user_question, request_approval,
 *  workflow_run, workflow_rerun_failed_items). Transcribed from loopClass. */
export function deriveGuardrailMutating(): Set<string> {
  return names((d) => d.loopClass === 'mutating');
}

/** B1 — tool-guardrail CACHE_SAFE_READS (a narrower subset of idempotent reads). */
export function deriveGuardrailCacheSafeReads(): Set<string> {
  return names((d) => d.cacheSafeRead === true);
}

/** B1 — tool-guardrail READ_MUTATORS: per-read the in-session mutators that
 *  invalidate its cache. Only reads with a mapped invalidator carry readMutatedBy;
 *  reads with no in-session writer (skill_*, composio_*_tools) are cache-safe but
 *  absent from this map (their cache never invalidates). */
export function deriveGuardrailReadMutators(): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  for (const d of TOOL_REGISTRY) {
    if (d.readMutatedBy && d.readMutatedBy.length > 0) out[d.name] = new Set(d.readMutatedBy);
  }
  return out;
}
