/**
 * Chat → workflow PROMOTION (Journey 2): turn a chat session's execution
 * trace into a workflow DRAFT.
 *
 * Strategic foundation (per the consolidation audit): a chat run and a
 * workflow run are the same thing — an executed sequence of tool calls — and
 * the harness already records both to ONE substrate (harness.db event log:
 * `tool_called` carries {tool, callId, arguments}; `tool_outputs` holds the
 * full results). So promotion is a THIN READER over that substrate, not a new
 * subsystem.
 *
 * This module is the reader: it reconstructs the substantive tool sequence a
 * user ran ad-hoc and emits a draft (steps with the EXACT tool slug locked
 * into `allowedTools` + the observed args captured — that's the determinism
 * lever: the promoted workflow runs the same path, it doesn't re-decide). The
 * draft is intentionally a SKELETON: prompt polish, input parameterization,
 * and data-flow refinement are the job of the confirm/refine loop
 * (`workflow_from_session`) + the canonical write path (auto-repair + gap
 * test). The `notes` make those follow-ups explicit so a draft is never
 * mistaken for a finished, trusted workflow.
 */
import { listEvents, getToolOutput } from '../runtime/harness/eventlog.js';
import { WORKFLOW_STEP_BLOCKED_TOOL_NAMES } from '../agents/workflow-step-agent.js';

/** One substantive tool invocation pulled from the trace. */
export interface TraceToolCall {
  /** Harness tool name, e.g. "composio_execute_tool", "run_shell_command". */
  tool: string;
  /** For the composio gateway: the concrete action slug from the args. */
  slug?: string;
  /** Raw JSON arguments string as recorded. */
  args: string;
  /** SDK call id (links to tool_outputs for the full result). */
  callId: string;
}

export interface WorkflowDraftStep {
  id: string;
  prompt: string;
  /** Locked to the tool family actually used — the determinism lever. */
  allowedTools: string[];
  dependsOn?: string[];
  /** Set when a request_approval preceded this step in the trace — the run
   *  gated this action, so the promoted workflow gates it declaratively too. */
  requiresApproval?: boolean;
  approvalPreview?: string;
  /** What was observed in the trace (for transparency + refinement). */
  observed: { tool: string; slug?: string; args: string; calls: number };
}

export interface WorkflowDraft {
  steps: WorkflowDraftStep[];
  /** Honest caveats — what the author must review before trusting this. */
  notes: string[];
  sourceSessionId?: string;
  /** Count of substantive (non-meta) tool calls considered. */
  toolCallCount: number;
}

/**
 * Discovery / plumbing tools that are NOT workflow steps — reads the agent did
 * to orient, not actions to reproduce. Small, stable set (distinct from the
 * meta/recursion blocklist we reuse from the step agent). This is NOT a
 * curated WORK-tool allowlist — every real action tool flows through.
 */
const PROMOTION_PLUMBING_TOOLS = new Set<string>([
  'composio_search_tools', 'composio_status',
  'skill_list', 'skill_read', 'tool_choice_forget',
  'workflow_get', 'workflow_list', 'workflow_run_status', 'workflow_import_status',
  'workflow_from_session',
]);
// Note: workflow_schedule / workflow_unschedule are authoring/mutation tools,
// not plumbing reads — they live in WORKFLOW_STEP_BLOCKED_TOOL_NAMES (reused
// above), which already excludes them here.

/** A tool call is promotable to a step unless it's a meta/recursion vector
 *  (reused step-agent blocklist), pure discovery/plumbing/memory, the
 *  execution-tracking scaffolding (the agent's own progress bookkeeping, never
 *  a workflow action), or `request_approval` (which becomes a declarative
 *  `requiresApproval` GATE on the next step, not a step of its own). */
export function isPromotableTool(name: string): boolean {
  if (!name) return false;
  if (name === 'request_approval') return false; // handled as a gate, not a step
  if (WORKFLOW_STEP_BLOCKED_TOOL_NAMES.has(name)) return false;
  if (PROMOTION_PLUMBING_TOOLS.has(name)) return false;
  // Stable scaffolding/plumbing families: memory, recall, active-task,
  // execution-tracking (execution_create/update_step/complete/list/get), and
  // tool-choice memory. None are workflow ACTIONS.
  if (/^(memory_|recall|execution_|tool_choice)/.test(name)) return false;
  return true;
}

/** Pull a human-meaningful preview from a request_approval call's args. */
function approvalPreviewFrom(args: string): string {
  try {
    const p = JSON.parse(args) as Record<string, unknown>;
    for (const key of ['preview', 'subject', 'reason']) {
      const v = p[key];
      if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 120);
    }
  } catch { /* no preview */ }
  return '';
}

/** Best-effort: pull the concrete composio action slug from the gateway args. */
export function composioSlug(tool: string, args: string): string | undefined {
  if (tool !== 'composio_execute_tool') return undefined;
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    for (const key of ['tool', 'slug', 'action', 'toolSlug', 'tool_slug']) {
      const v = parsed[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  } catch { /* unparseable args — no slug */ }
  return undefined;
}

function slugifyId(raw: string, index: number, used: Set<string>): string {
  let base = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (!base) base = `step-${index + 1}`;
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

function argKeySummary(args: string): string {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const inner = (parsed.arguments && typeof parsed.arguments === 'object')
      ? parsed.arguments as Record<string, unknown>
      : parsed;
    const keys = Object.keys(inner).filter((k) => !['tool', 'slug', 'action'].includes(k));
    return keys.length ? ` with: ${keys.slice(0, 8).join(', ')}` : '';
  } catch { return ''; }
}

function shellCommand(args: string): string | undefined {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const cmd = parsed.command ?? parsed.cmd;
    return typeof cmd === 'string' && cmd.trim() ? cmd.trim() : undefined;
  } catch { return undefined; }
}

interface DraftGroup { calls: TraceToolCall[]; approvalPreview?: string }

function buildStep(grp: DraftGroup, index: number, usedIds: Set<string>): WorkflowDraftStep {
  const group = grp.calls;
  const head = group[0];
  const calls = group.length;
  const gate = grp.approvalPreview !== undefined
    ? { requiresApproval: true, approvalPreview: grp.approvalPreview || 'Review before this step runs.' }
    : {};
  const repeated = calls > 1
    ? ` (this ran ${calls}× in the session — if it was once per item, refine into a forEach over the upstream list).`
    : '.';

  if (head.tool === 'composio_execute_tool' && head.slug) {
    const id = slugifyId(head.slug, index, usedIds);
    return {
      id,
      prompt: `Run the ${head.slug} action via composio_execute_tool${argKeySummary(head.args)}${repeated}`,
      allowedTools: ['composio_execute_tool'],
      ...gate,
      observed: { tool: head.tool, slug: head.slug, args: head.args.slice(0, 600), calls },
    };
  }
  if (head.tool === 'run_shell_command') {
    const cmd = shellCommand(head.args);
    const id = slugifyId(cmd ? cmd.split(/\s+/)[0] : 'shell', index, usedIds);
    return {
      id,
      prompt: cmd ? `Run the shell command: \`${cmd.slice(0, 200)}\`${repeated}` : `Run a shell command${repeated}`,
      allowedTools: ['run_shell_command'],
      ...gate,
      observed: { tool: head.tool, args: head.args.slice(0, 600), calls },
    };
  }
  if (head.tool === 'composio_execute_tool') {
    // Gateway call whose action slug couldn't be parsed from the args — make
    // the gap explicit so the author names the concrete action when refining.
    const id = slugifyId('composio-action', index, usedIds);
    return {
      id,
      prompt: `Run a composio_execute_tool action (the specific action slug couldn't be detected from the recorded args${argKeySummary(head.args)} — name it, e.g. GMAIL_SEND_EMAIL, when you refine this step)${repeated}`,
      allowedTools: ['composio_execute_tool'],
      ...gate,
      observed: { tool: head.tool, args: head.args.slice(0, 600), calls },
    };
  }
  const id = slugifyId(head.tool, index, usedIds);
  return {
    id,
    prompt: `Use ${head.tool}${argKeySummary(head.args)}${repeated}`,
    allowedTools: [head.tool],
    ...gate,
    observed: { tool: head.tool, args: head.args.slice(0, 600), calls },
  };
}

/**
 * Pure reconstruction: substantive tool calls → a workflow draft. Coalesces
 * consecutive calls to the SAME (tool, slug) into one step, locks each step's
 * tools to the family used, and chains steps linearly (preserves order +
 * structured handoff). Deterministic + dependency-free → fully unit-testable.
 */
export function traceToWorkflowDraft(
  calls: TraceToolCall[],
  opts: { sessionId?: string } = {},
): WorkflowDraft {
  // Walk the RAW calls so a request_approval can attach as a GATE to the next
  // substantive step (rather than becoming a bogus step of its own).
  const groups: DraftGroup[] = [];
  let pendingApproval: string | undefined;
  let approvalActive = false;
  let substantiveCount = 0;
  for (const c of calls) {
    if (c.tool === 'request_approval') {
      approvalActive = true;
      pendingApproval = approvalPreviewFrom(c.args);
      continue;
    }
    if (!isPromotableTool(c.tool)) continue;
    substantiveCount += 1;
    const last = groups[groups.length - 1];
    // Coalesce only when the current call has a KNOWN slug that matches the
    // group's — so repeated same-action composio calls (the forEach case) merge,
    // but distinct shell commands / unknown-slug calls each stay their own step.
    const coalesces = !approvalActive && Boolean(c.slug)
      && last && last.calls[0].tool === c.tool && last.calls[0].slug === c.slug;
    if (coalesces) {
      last.calls.push(c);
    } else {
      groups.push({ calls: [c], approvalPreview: approvalActive ? (pendingApproval ?? '') : undefined });
      approvalActive = false;
      pendingApproval = undefined;
    }
  }
  const usedIds = new Set<string>();
  const steps = groups.map((g, i) => buildStep(g, i, usedIds));
  for (let i = 1; i < steps.length; i++) steps[i].dependsOn = [steps[i - 1].id];

  const notes: string[] = [];
  if (steps.length === 0) {
    notes.push('No substantive actions found in this session to turn into a workflow (only reads/exploration/chat).');
  } else {
    notes.push('Draft is a skeleton: step prompts are auto-generated from the tools you used — review and sharpen them before saving.');
    notes.push('Inputs are not parameterized yet: the observed values are baked in. Replace run-specific values (URLs, names) with {{input.X}} so the workflow is reusable.');
    notes.push('Steps are chained in run order; if a step actually depends on an earlier step\'s OUTPUT, reference it with {{steps.<id>.output}} (the canonical write path will auto-wire the dependency).');
    if (steps.some((s) => s.requiresApproval)) {
      notes.push('An approval gate from the original run was preserved (requiresApproval on the step that followed it) — keep it so the workflow pauses before that action.');
    }
    // A request_approval as the LAST call has no following action to gate.
    // Don't attach it to the prior step (that action already ran ungated) and
    // don't drop it silently — surface it so the author decides.
    if (approvalActive) {
      notes.push('The original run ended with an approval request that had no following action — no gate was added. If a step here should pause for approval, set requiresApproval on it.');
    }
    // Shell commands are captured verbatim into the step prompt — flag the
    // secret-leak risk before this draft is enabled or exported.
    if (steps.some((s) => s.observed.tool === 'run_shell_command')) {
      notes.push('A shell command was captured verbatim into a step — review it and remove any secrets/tokens (or move them to inputs) before enabling or exporting this workflow.');
    }
  }
  return {
    steps,
    notes,
    sourceSessionId: opts.sessionId,
    toolCallCount: substantiveCount,
  };
}

/**
 * I/O wrapper: read a session's trace from harness.db and draft a workflow.
 * Thin — all logic is in the pure `traceToWorkflowDraft`.
 */
/**
 * Reconstruct a session's substantive tool sequence from the event log. The
 * ONE reader shared by workflow promotion AND the skill distiller (C2) — a chat
 * run and a successful task are the same thing, an executed tool sequence, so
 * both read from this single substrate seam.
 */
export function readSessionTrace(sessionId: string): TraceToolCall[] {
  const events = listEvents(sessionId, { types: ['tool_called'] });
  return events
    .map((e) => {
      const tool = typeof e.data.tool === 'string' ? e.data.tool : '';
      const args = typeof e.data.arguments === 'string'
        ? e.data.arguments
        : JSON.stringify(e.data.arguments ?? {});
      const callId = typeof e.data.callId === 'string' ? e.data.callId : e.id;
      return { tool, args, callId, slug: composioSlug(tool, args) };
    })
    .filter((c) => c.tool);
}

export function draftWorkflowFromSession(sessionId: string): WorkflowDraft {
  const calls = readSessionTrace(sessionId);
  // getToolOutput is available for a future data-flow pass (match an upstream
  // output to a downstream arg); v1 keeps the linear chain.
  void getToolOutput;
  return traceToWorkflowDraft(calls, { sessionId });
}
