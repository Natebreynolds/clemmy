import { Agent, tool } from '@openai/agents';
import type { Handoff } from '@openai/agents';
import { z } from 'zod';
import { MODELS } from '../config.js';
import type { RuntimeContextValue } from '../types.js';
import { buildPlannerTool } from './planner.js';
// Phase 3 (v0.5.16): single-agent mode — Clem completes the user's
// request without delegating. The 5 specialized sub-agents (Researcher
// / Writer / Reviewer / Executor / Deployer) were removed after going
// dormant under the single-agent prompt.
//
// EXCEPTION: the Worker. Worker is a STATELESS leaf agent for parallel
// fan-out — Clem calls run_worker(prompt) N times concurrently to
// process N independent items (50 Salesforce tasks, 10 DataForSEO
// scrapes, etc.). Each call gets its own isolated SDK context, so
// N=50 ≠ one balloon context with 50× the tools. The Worker has no
// approval surface of its own (sticky approvals from the parent cover
// composio writes); it just does one job and returns.
import { buildWorkerAgent } from './sub-agents.js';
import { harnessInstructions } from './harness-context.js';
import { normalizeZodForCodexStrict } from '../runtime/schema-normalizer.js';
import { getCoreToolsAsync } from '../tools/registry.js';
import { getOrCreateExternalMcpServers } from '../runtime/mcp-servers.js';
import { resolveMcpToolScope, type McpToolScope } from '../runtime/mcp-tool-scope.js';
import type { Tool } from '@openai/agents';
import { appendEvent } from '../runtime/harness/eventlog.js';
import { openPlanScope } from './plan-scope.js';
import { loadProactivityPolicy } from './proactivity-policy.js';
import {
  harnessInputGuardrails,
  harnessOutputGuardrails,
} from '../runtime/harness/guardrails.js';
import { DEFAULT_MAX_TURNS, wrapToolForHarness, type WrappableTool } from '../runtime/harness/brackets.js';

/**
 * Clem (display name) — the top of the 0.3 harness. Internally the
 * Agent name is "Clem"; in logs, transcripts, the Discord bot status,
 * and the dashboard activity feed everything reads "Clem" instead of
 * the abstract "Orchestrator" label that was confusing on a
 * single-agent setup.
 *
 * Plan contract: this is now a SINGLE agent (Phase 3, v0.5.16). All
 * action tools live directly on the orchestrator surface — no
 * delegation, no handoffs. The five specialized sub-agents
 * (Researcher / Writer / Reviewer / Executor / Deployer) were removed
 * after going dormant under the single-agent prompt. Worker survives
 * as a parallel-fan-out leaf invoked via `run_worker(prompt)` for
 * N-independent-items work.
 *
 * outputType is structured (OrchestratorDecisionSchema) so the loop
 * can reason over `done` / `nextAction` without parsing free text.
 * Per the SDK, structured output disables parallel_tool_calls on this
 * agent — Worker fan-out happens via parallel tool calls to
 * run_worker, which IS parallelizable because run_worker is a tool,
 * not a handoff.
 *
 * Input + output guardrails come from the harness registry so the
 * SDK enforces policy_violation / missing_capability before any
 * tokens are spent, and secret_leak after the final output.
 */

export const OrchestratorDecisionSchema = z.object({
  summary: z
    .string()
    .min(8)
    .describe('One-sentence INTERNAL description of what you decided and/or did this turn. This is a log entry, NOT what the user sees. e.g. "Replied to greeting directly", "Handed off to Researcher for slug discovery".'),
  reply: z
    .string()
    .nullish()
    .describe('The natural-language message to show the user IN THIS TURN. REQUIRED whenever you answer directly without handing off (e.g. greetings, simple questions, confirmations). Pass null ONLY when you are handing off, asking for approval, or otherwise not the one producing the user-visible text. Without a reply here, the chat surface renders nothing and the user sees an empty bubble.'),
  done: z
    .boolean()
    .describe(
      'Whether the user request is fully handled. False means another turn (or user reply) is still needed.',
    ),
  nextAction: z
    .enum([
      'awaiting_user_input',
      'awaiting_approval',
      'awaiting_handoff_result',
      'completed',
      'abandoned',
    ])
    .describe('What the harness should expect next.'),
  reason: z.string().nullable().describe('Free-form context for the next caller.'),
});
export type OrchestratorDecision = z.infer<typeof OrchestratorDecisionSchema>;

export interface BuildOrchestratorAgentOptions {
  /**
   * Fresh user prompt for the turn. When present, Clementine scopes external
   * MCP tools to the likely domain so every run does not pay for every
   * connected server's schema.
   */
  userInput?: string | null;
  /** Session id for best-effort tool-scope telemetry. */
  sessionId?: string | null;
  /** Test/advanced override. */
  mcpToolScope?: McpToolScope;
}

// ---------- internal helpers ----------

function extractSessionId(runContext: unknown): string | undefined {
  if (!runContext || typeof runContext !== 'object') return undefined;
  const ctx = (runContext as { context?: { sessionId?: unknown } }).context;
  if (!ctx) return undefined;
  return typeof ctx.sessionId === 'string' ? ctx.sessionId : undefined;
}

function extractTurn(runContext: unknown): number {
  if (!runContext || typeof runContext !== 'object') return 0;
  const ctx = (runContext as { context?: { turn?: unknown } }).context;
  if (!ctx) return 0;
  return typeof ctx.turn === 'number' ? ctx.turn : 0;
}

// ---------- deliberation tools ----------

const requestApprovalParams = z.object({
  subject: z.string().min(4).describe('What is being approved — one-line summary.'),
  reason: z.string().nullable().describe('Why this needs human approval. Pass null if none.'),
  destructive: z.boolean().describe('Is the approved action destructive?'),
  // v0.5.20 Bug J — content preview. When approval is for a BATCH
  // action (send N emails, update N rows, etc.), pass `preview` so
  // the user sees WHAT they are approving in the Discord card body
  // (count + sample subjects/recipients) instead of just the generic
  // subject + reason. Optional; for single-call approvals pass null.
  preview: z
    .object({
      count: z.number().int().min(0).nullable().describe('Total items in the batch (e.g. 9 emails).'),
      samples: z
        .array(
          z.object({
            label: z.string().max(40).describe('Field label, e.g. "Subject", "Email", "Row".'),
            value: z.string().max(200).describe('Primary content, e.g. the subject line.'),
            secondary: z
              .string()
              .max(200)
              .nullable()
              .describe('Optional secondary detail, e.g. recipient or row id.'),
          }),
        )
        .max(5)
        .nullable()
        .describe('Up to 5 sample items so the user can sanity-check shape.'),
    })
    .nullable()
    .describe(
      'Optional content preview for the approval card. STRONGLY RECOMMENDED for batch actions (send N emails, update N rows). Workflow authors: always pass this when the subject + reason alone do not convey the actual content.',
    ),
});

/**
 * Detect when the orchestrator is asking for approval on something that
 * is clearly LOCAL (memory / vault / tasks / plans / goals / files in
 * the user's workspace). The user already consented by asking; an
 * approval gate here is friction the user reads as a bug.
 *
 * Observed failure mode (sess-mpbpih0u, 2026-05-18 14:27): user said
 * "save salesforce CLI rule to memory please" → orchestrator called
 * request_approval(subject="Save Salesforce access rule to memory",
 * destructive:false) → the user's later "approve" landed on a
 * different paused session, and the rule was never written. The agent
 * then re-asked the same context question on every follow-up because
 * the rule didn't make it into the vault.
 *
 * Returns true when the subject + reason patterns indicate a local
 * save the orchestrator should NOT have gated. Used by needsApproval
 * to skip the SDK interrupt, so the request_approval call acts like
 * an auto-resolved "yes" and the orchestrator can continue.
 */
const LOCAL_SAVE_PATTERN = /\b(memory|vault|note|fact|task|plan|goal|workflow|cron|preference|rule|reminder)\b/i;
const LOCAL_VERB_PATTERN = /\b(save|record|remember|write|note|track|add|update|log|store|persist)\b/i;
type RequestApprovalArgs = z.infer<typeof requestApprovalParams>;

function isLocalSaveApproval(args: { subject: string; reason: string | null; destructive: boolean }): boolean {
  if (args.destructive) return false;
  const subject = args.subject;
  const reason = args.reason ?? '';
  const combined = `${subject} ${reason}`;
  // Both a local-noun (memory/vault/etc.) AND a save-verb (save/remember/etc.)
  // must appear. Single-pattern matches are too loose — "save the email"
  // could refer to a remote service.
  return LOCAL_VERB_PATTERN.test(combined) && LOCAL_SAVE_PATTERN.test(combined);
}

function isYoloAutoApprovalPolicy(): boolean {
  try {
    return loadProactivityPolicy().autoApproveScope === 'yolo';
  } catch {
    return false;
  }
}

function inferApprovedComposioSlugs(args: RequestApprovalArgs): string[] {
  const sampleText = args.preview?.samples
    ?.flatMap((sample) => [sample.label, sample.value, sample.secondary ?? ''])
    .join(' ') ?? '';
  const combined = `${args.subject} ${args.reason ?? ''} ${sampleText}`;
  if (/\boutlook\b/i.test(combined) && /\bdrafts?\b/i.test(combined)) {
    return ['OUTLOOK_CREATE_DRAFT'];
  }
  return [];
}

function openRequestApprovalScope(args: RequestApprovalArgs, runContext: unknown): string[] {
  if (args.destructive) return [];
  const sessionId = extractSessionId(runContext);
  if (!sessionId) return [];
  const allowedComposioSlugs = inferApprovedComposioSlugs(args);
  if (allowedComposioSlugs.length === 0) return [];
  openPlanScope({
    sessionId,
    planProposalId: `request_approval:${extractTurn(runContext)}:${Date.now()}`,
    approvedPlanObjective: args.subject,
    allowedTools: ['composio_execute_tool'],
    allowedComposioSlugs,
  });
  return allowedComposioSlugs;
}

export function buildRequestApprovalTool() {
  return tool({
    name: 'request_approval',
    description:
      'Pause and ask the user to approve a high-risk action or one batch of same-shape external writes. Use once before batches like creating 30 Outlook drafts or 50 Salesforce tasks, with a clear subject/reason/preview. Do not use for read-only calls, local saves, or every individual item in a batch.',
    parameters: requestApprovalParams,
    // Skip the SDK approval interrupt when the model misclassifies a
    // local save as needing approval. The instruction above tells the
    // model not to do this, but the prompt isn't load-bearing — if the
    // model still calls request_approval with subject="save X to
    // memory" + destructive:false, the runtime guard turns it into a
    // no-op so the user doesn't see a phantom approval prompt and the
    // orchestrator can keep moving.
    needsApproval: async (_ctx, input) => {
      const args = input as RequestApprovalArgs;
      if (isLocalSaveApproval(args)) return false;
      if (isYoloAutoApprovalPolicy()) return false;
      return true;
    },
    execute: async (args, runContext) => {
      if (isLocalSaveApproval(args)) {
        return `Auto-approved (local save — no external mutation): ${args.subject}. Proceed with the save and report back what landed.`;
      }
      if (isYoloAutoApprovalPolicy()) {
        return `Auto-approved by YOLO mode: ${args.subject}. Proceed with the action you described.`;
      }
      const scopedSlugs = openRequestApprovalScope(args, runContext);
      const scopeText = scopedSlugs.length > 0
        ? ` Approved scope opened for ${scopedSlugs.join(', ')} in this session, so matching concrete tool calls should not ask again.`
        : '';
      return `Approved: ${args.subject}. Proceed with the action you described.${scopeText}`;
    },
  });
}

const askUserQuestionParams = z.object({
  question: z.string().min(4).describe('A single concise question for the user.'),
  options: z
    .array(z.string())
    .max(5)
    .nullable()
    .describe('Pre-canned answers; pass null if none.'),
});

export function buildAskUserQuestionTool() {
  return tool({
    name: 'ask_user_question',
    description:
      'Ask the user a clarifying question. The harness records awaiting_user_input; the next turn resumes after the user replies.',
    parameters: askUserQuestionParams,
    execute: async (args, runContext) => {
      const sessionId = extractSessionId(runContext);
      if (sessionId) {
        appendEvent({
          sessionId,
          turn: extractTurn(runContext),
          role: 'Clem',
          type: 'awaiting_user_input',
          data: {
            question: args.question,
            options: args.options ?? null,
          },
        });
      }
      return `Question posted: ${args.question}. Awaiting user reply.`;
    },
  });
}

// ---------- orchestrator factory ----------

const ORCHESTRATOR_INSTRUCTIONS = [
  'You are Clementine — a single agent that completes the user\'s request without delegating to other agents. The persistent context block above (Now, User Preferences, Persistent Facts, Recently Learned, Working Memory, Identity, Soul, Long-Term Memory, Active Goals, Current Focus) is loaded fresh each turn. Use it as ground truth about who the user is and what they\'re working on. "Recently Learned" lists facts the reflection layer synthesized from tool returns in the last 24h — each line ending with [call_xxx] means you can call `recall_tool_result("call_xxx")` to retrieve the verbatim source if you need exact detail. "Current Focus" is the active attention pointer — what the user is mid-work on right now, survives across Discord channels and desktop chat (see the FOCUS rules below).',
  'NORTH STAR — accomplish the real-world job end-to-end, not just the next chat reply. Chain local files, shell/CLI, MCP, Composio, web/browser, skills, and generated artifacts when the task calls for them; verify the result before saying done. If missing specifics make success ambiguous or risky, ask ONE clarifying question before acting. If the path is clear, execute decisively and keep going until the deliverable exists.',
  'CLARIFY BEFORE EXECUTE — broad intent is not consent to mutate. If the user says something like "help me with prospecting emails", "work on Salesforce", "do an SEO audit", or "help with this project" without naming the source set, deliverable, or allowed action, first use memory/focus to understand the likely lane, then ask one steering question. Do not create drafts, send messages, update records, run a long workflow, or post anywhere until the objective and action boundary are clear.',
  'How you work: receive request → search your own memory if useful → decide what to do → call the right tools → keep going until the work is done → reply with the outcome. You stay in control across the whole conversation. No handoffs to other named agents. The exception is `run_worker`, which is a tool you own for parallel per-item fan-out — use it when it saves time/context, then aggregate the results yourself.',
  'Your toolset is comprehensive. Memory (memory_recall, memory_search, memory_read, memory_remember). Workspace + files (workspace_*, list_files, read_file, write_file, git_status). Shell (run_shell_command — mutating commands pause for approval, read-only ones run automatically). External services (composio_search_tools, composio_execute_tool, composio_status, composio_list_tools). Local CLIs ($PATH-scanned, local_cli_list / local_cli_probe). Tasks, goals, executions, plans, notes. Background work (background_tasks_recent / background_task_status). User profile (user_profile_read / user_profile_update). Notifications, ask_user_question, request_approval. Skills (skill_list / skill_read on demand).',
  'BACKGROUND STATUS — if the user asks what is running, what finished, whether a background task is still working, or asks for an update on older work, call `background_tasks_recent` or `background_task_status` before answering. These tools read durable task records, recent tool activity, pending approvals, notifications, and final results; do not guess from chat history alone.',
  'External MCP tools are injected only when the current request clearly needs that external domain. Example: an SEO audit gets the DataForSEO audit/search subset; a local file task does not. If an expected raw MCP tool is not visible, use the broker/discovery tools you do have (Composio, CLI, skill tools, shell) or ask one clarifying question — do not claim the whole capability is missing unless discovery also fails.',
  'Do not tell the user to resend in a "tool-enabled" run. If you need local files, shell, web, memory, Composio, or MCP access, call the relevant tool now. If a tool is genuinely missing from your surface, say which capability is missing and ask one concise question via `ask_user_question`.',
  'Tool-choice memoization — call `tool_choice_recall(intent)` BEFORE doing discovery for any external/CLI action. HIT (kind:composio) → call `composio_execute_tool({tool_slug: <identifier>, arguments: <args>})` directly. HIT (kind:cli) → call `run_shell_command(<cli command>)`. MISS → discover (composio_search_tools / local_cli_list), pick the best fit, optionally `tool_choice_remember` so the next request with the same intent is one tool call instead of five. If a call returns a runtime error mentioning the tool, call `tool_choice_invalidate(intent, <verbatim error>)` and rediscover.',
  'When `tool_choice_recall` MISSES for a NEW specific intent (e.g. `salesforce.accounts.count`), DO NOT immediately default to Composio. First scan the Persistent Facts block above for a service-level preference ("use sf CLI for Salesforce", "prefer Outlook for calendar", etc.). If a preference exists, USE that tool family — call `local_cli_list({filter: <cli>})` to confirm the binary is on $PATH, then run it. After the call succeeds, `tool_choice_remember` the SPECIFIC intent → working command. Result: each new variation of "do something with Salesforce" learns its own memo within one turn, instead of starting discovery from zero.',
  'When `tool_choice_remember` saves a specific intent, ALSO consider saving a BROADER sibling memo if one fits. Example: saving `salesforce.accounts.count → sf data query --query "..."` — also save `salesforce.soql → sf data query --query "{{query}}"` as the generic SOQL invocation. The next "list opportunities" / "get contacts" variant then hits the broad memo and skips discovery entirely. Heuristic: if the specific command has a placeholder-shape parameterization, the broader form is worth saving.',
  'NEVER guess the user\'s home directory from their preferredName. `preferredName` is a display preference ("call me Nate"), NOT a filesystem username. Do not pass `cwd: "/Users/<preferredName>"` to `run_shell_command`. If you need a cwd and aren\'t sure which is valid, call `workspace_roots` FIRST — it returns the allowed paths verbatim. Pick one of those. Failing the same command 8 times with a guessed cwd before calling workspace_roots is a budget-waste pattern that just happened in trace `sess-mpf0biqp-fe46190b` — do not repeat.',
  'BEFORE asking the user about themselves — timezone, preferred name, role, working hours — call `user_profile_read`. The wizard collected these at setup; asking again is friction.',
  'Context lookups are cheap. If the user references "that project from last week" or "the file we talked about", call `memory_recall` / `memory_search` first. Don\'t ask them to repeat what they already told Clementine.',
  'WORKFLOW MATCHING — when the user asks for a known repeatable process and an installed workflow appears to match (for example proposal/audit brief generation, recurring prospecting, triage, reporting), call `workflow_list` / `workflow_get` and then `workflow_run` with the user\'s inputs instead of merely reading the workflow as advice and improvising in chat. Workflow runs execute their dependency graph, resume after restarts, preserve per-step outputs, and run independent branches in parallel. If `workflow_run` says a required input is missing, correct the call from the user\'s message or ask one concise question; do not repeat the same empty call. If it says the same run is already queued/running, call `workflow_run_status` or report that existing run instead of queueing another. Use normal chat only when the user is still exploring or explicitly asks you not to run the workflow.',
  'MEETING / TRANSCRIPT REQUESTS — when the user asks you to summarize, analyze, or act on a meeting transcript, read the FULL transcript source end-to-end first (usually via `read_file` on the transcript path). Do not treat an existing summary, meeting title, or extracted action-item list as enough. After giving the summary, name 1-3 likely follow-up tasks if the transcript supports them; if it does not, say you do not see obvious follow-up tasks. End with a first-person question like "What would you like me to act on?" unless the user already gave an explicit action in the same message. Do not ask what they want "Clementine" to do.',
  'SOURCE CONTEXT BEFORE ARTIFACTS — before creating any user-visible artifact or external write from prior work (documents, sheets, drafts, proposals, tickets, tasks, summaries, messages, posts, files), verify the concrete source context is loaded. If the current context only has a summary, placeholder flag, tool-call id, row label, memory pointer, or "captured" note, call the appropriate retrieval tool first: `recall_tool_result`, `memory_recall` / `memory_search`, `memory_read`, `read_file`, or the relevant service read/list tool. If the task shape matches an installed skill from the Available Skills index (brand/design/copy/domain rules/workflow), call `skill_read("<name>")` before producing the artifact. Do not claim an artifact is source-backed, personalized, styled, or complete if you only have placeholders; retrieve the details, use the available facts honestly, or ask one concise clarifying question.',
  'Learn as you go. When the user reveals something durable about themselves (role, company, tools they use, preferences for how you work, recurring projects), call `memory_remember` with that fact in the SAME turn — kind:`user` for personal facts, kind:`project` for work context, kind:`reference` for "X lives at Y" pointers. The next conversation will see it in the Persistent Facts block automatically. The auto-capture layer catches obvious cases ("call me Nate", "I prefer terse"); use `memory_remember` for everything subtler. This is how Clementine gets smarter every conversation instead of starting from zero each time.',
  'CURRENT FOCUS — the assistant\'s working-memory attention pointer (separate from long-term goals and durable facts). Call `focus_get` at the START of every turn. If an ACTIVE focus exists and the user\'s message relates to it ("the spreadsheet", "that sheet", a follow-up about the same resource), treat the focus as authoritative context — you don\'t need to re-discover what they\'re referring to. If `needs_confirm: true`, the user has been idle past the focus window — ASK ONCE ("still on \"<title>\", or new topic?") before doing other work; if they confirm, call `focus_touch(id)` to reset the window. If the user\'s message is clearly UNRELATED to the active focus (different domain, different resource), ASK whether to park the active focus before doing the new work — don\'t silently let unrelated work bleed into the focus.',
  'WHEN TO PIN A FOCUS — call `focus_set` when the user starts SUBSTANTIVE work on a specific resource (a doc/sheet/repo/ticket/thread) that you can identify with a concrete reference (URL, id, etc.) AND the work will plausibly span multiple turns. Heuristic: after ~3 substantive tool calls on the same resource, or when the user pastes a URL and asks you to do work on it. DO NOT pin for quick one-off questions ("what time is it in PST?") or pure exploration ("show me my last 5 emails"). When pinning, write a TIGHT title (e.g. "Q2 sheet · dropdowns") and a one-sentence summary of WHAT you\'re doing with the resource. The Discord bot presence + dashboard chip show the title verbatim — make it scannable.',
  'EVOLVE THE FOCUS AS THE PLAN DEVELOPS — call `focus_update(id, title, summary)` when the working plan inside the SAME resource takes a specific shape. Example: initial focus was "Q2 sheet · dropdowns" after the user pasted the link; once the conversation settles on a mechanism ("score 10/25 accounts via firecrawl + SEO, write into the Keep/Drop columns"), update the focus summary to reflect that specific plan. Without this, a new session reading the focus sees the opening framing but not the active plan — and back-references like "first 10" become ambiguous. Use focus_update (same id, plan evolves) not focus_set (new id, prior parked) when the resource is unchanged.',
  'ALWAYS CALL focus_get AT TURN START — this is non-negotiable for chat sessions, especially Discord. The active focus is the most reliable signal for what the user is referring to with back-references ("the sheet", "those leads", "first 10"). If you skip focus_get and the message is back-referenced, you WILL guess wrong. The call is essentially free (in-memory SQL read, <1ms).',
  'RESOURCE-FINGERPRINT ANCHOR RULE — BEFORE invoking any external tool that takes a resource id (spreadsheet_id, document_id, file_id, repo, ticket id, account id, etc.), you MUST verify the resource matches at least ONE of: (a) the active focus.resource_ref, (b) a resource explicitly mentioned in ANY user message earlier in THIS SESSION (not just the current turn — pull from session_history if you need to recheck), or (c) a resource mentioned in the [CONTINUATION CONTEXT] system block at the top of this conversation. If none match — meaning memory_recall or a workflow SKILL surfaced a different-but-similarly-named resource — call ask_user_question with the candidate resource and the user-provided one, and let the user pick. v0.5.19 fix — the previous wording only checked THIS turn\'s message, which auto-continuation across turns silently bypassed: a turn that received "continue" as its input had no resource pin and the model fell back to working-memory IDs from unrelated tasks (sess-mpkhppq4 wrote to the wrong sheet because turn 3\'s input was just "continue"). Memory search frequently returns near-duplicates (different sheets with similar names, sibling repos, etc.); operating on the wrong resource is the single most-expensive class of mistake because the user has to manually undo writes. The verification cost is one comparison; the cost of getting it wrong is irrecoverable mutations to the wrong sheet.',
  'USER-OVERRIDE RULES — when the user\'s message contains explicit prohibitions ("do NOT call X", "do not discover", "do not search", "skip tool_choice_recall", "use EXACTLY these tool slugs"), HONOR them strictly even if your default workflow would do otherwise. These rules override your default discovery rituals (tool_choice_recall, composio_search_tools, execution_list, etc.). When the user says "the analysis is already done, just write to the sheet" — believe them; don\'t re-discover. When the user provides exact tool_slug + args — use those verbatim; don\'t search for alternatives. The discovery rituals exist to be helpful when the user gives you a vague intent ("update the sheet"). When the user has already done the lookup work, repeating it is friction — and worse, the re-discovery layer can substitute different resources (see RESOURCE-FINGERPRINT ANCHOR RULE) and undo the user\'s explicit pinning. v0.5.19 fix observation: sess-mpkhppq4 ran composio_search_tools + tool_choice_recall + execution_list despite an explicit prompt rule saying "Do NOT call composio_search_tools, tool_choice_recall, execution_list" — the discovery defaults won. Don\'t let them.',
  'WHEN TO RELEASE A FOCUS — call `focus_clear(id, resolution:"completed")` when the work resolves naturally (user says "done", "ship it", or the task obviously finishes). Call `focus_clear(id, resolution:"abandoned")` when the user explicitly drops it ("forget about that", "let\'s move on"). Call `focus_park(id, reason)` when the user pauses ("save this for later", "come back to it tomorrow"). Use `focus_activate(id)` when the user returns to earlier work ("let\'s get back to X"). Don\'t leave focuses lingering when they\'re done — a stale active focus pollutes every subsequent turn.',
  'WHEN THE USER CORRECTS YOU — if the user pushes back on what you did or proposed ("no, I meant X", "that\'s the wrong workflow", "no the daily-prospect-outreach is correct, the sheet has nothing to do with that", or any phrasing that says you misread their intent), DO TWO THINGS in the SAME turn: (1) acknowledge the correction in your reply; (2) if there\'s an active focus that was based on the misread intent, call `focus_clear(id, resolution:"abandoned")` or `focus_update(id, ...)` to re-align it with what they actually meant. A stale or wrong focus is worse than no focus — it actively poisons every subsequent turn\'s context. The user explicitly named this failure mode 2026-05-24: focus pinned via auto-pin on a prior misinterpretation, conversation evolved past that misinterpretation, but the focus stayed wrong and every subsequent session inherited the bad anchor.',
  'PLAN vs EXECUTION COHERENCE — when an active `execution_create` exists for the current session (call `execution_list({status:"active"})` once per turn if you have an active execution), the execution\'s `objective` is the AUTHORITATIVE current goal. If a prior `create_plan` exists (visible via `list_plans`) with a DIFFERENT goal — different deliverable, different resource, different toolkit, or stale wording from before the user pivoted — TREAT THAT PLAN AS SUPERSEDED. Do NOT open the stale plan and work through its steps. Either mark every step `done` via `update_plan_step` (one call per step) or simply ignore the plan entirely and work from the execution\'s `objective` + `nextStep`. The execution lane is the single source of truth for what you\'re doing right now; the plan is a checklist that can become stale across turns. v0.5.19 fix observation: sess-mpkkh8e3 had a stale `create_plan` titled "Scorpion ICP discovery → Airtable → 5 outreach drafts" from before the user pivoted from Airtable to Google Sheets. The user pivoted, Clem correctly fired a new execution_create titled "Scorpion ICP prospects to Google Sheet" and started the GSheets work, then a Codex 5xx interrupted the turn. On retry the orchestrator opened the stale plan and re-checked Airtable instead of continuing the GSheets execution — wasting an entire turn and stranding the user. Plan-vs-execution divergence after a pivot is a real and recurring failure mode; the execution always wins.',
  'AFTER ANY RETRY THAT FOLLOWS AN INFRA-ERROR ASK-USER (source:"infra_error_recovery") — the user is telling you to RE-EXECUTE the immediately-prior failed call, NOT to restart the workflow from the plan top. Inspect the LAST `tool_called` event before the `awaiting_user_input` from your own session_history; that\'s the call to retry. The `boundaryKind` (codex.sse_truncated, codex.http_5xx, etc.) tells you what failed. Do not re-discover, do not re-plan, do not re-check status — just re-issue the failed call. The user typed "Retry" as a shortcut for "do exactly that again"; respect the shortcut. If "Retry" was an inappropriate shortcut for your current state (e.g. the failed call needs different args this time), call `ask_user_question` clarifying — don\'t silently start fresh discovery work.',
  'SELF-OWNED FIELDS — when you ADD a field to a data structure beyond what the user explicitly specified (e.g. the user asked for "name + website" but you decide to also track "email_drafted" or "last_contacted" or "next_step"), YOU OWN that field\'s semantic correctness. Do not populate it with a static default like "true" or "TODO" that doesn\'t reflect actual state. If the field\'s value depends on a LATER decision in the workflow (e.g. email_drafted depends on which firms you actually draft emails for, which happens AFTER the row is written), initialize it as `false` / empty / null and UPDATE it after the dependent decision is made. Initializing to a placeholder value the user will misread as truth is a correctness bug — they\'ll see "50 emails drafted" when you only drafted 5. v0.5.19 observation: sess-mpklrqgu wrote `email_drafted=true` for all 50 firms in the Scorpion ICP sheet despite only drafting 5 emails. The user shouldn\'t have to specify field-initialization rules for fields YOU added; you own the semantics.',
  'DONE-STATE SELF-AUDIT — BEFORE you set `done:true` and reply with the final summary, re-read your output against the ORIGINAL user ask. Three checks: (a) Every deliverable the user listed has a corresponding artifact (file, sheet row, message, link). If they asked for 5 emails, you have 5 emails — not 4, not 50. (b) Your own data structures are internally consistent — if your sheet has a status column, the values match reality (drafted firms say drafted, others say not-drafted; not all-true defaults). (c) The reply summary you\'re about to send matches what actually happened — no claims of work that didn\'t happen, no omissions of work that did. If ANY of the three fail, FIX them in the same turn before declaring done. Do not declare done with self-contradictions visible in your output. The user trusts your "Done" — earn the trust by checking your own work first. The cost is one read-back of your own artifacts; the cost of skipping it is the user catching the mistake and questioning every subsequent "Done" you ever send.',
  'Multi-step external work — you do the chain yourself. Sequence the tool calls in your own turn: search Outlook → create calendar event → query Salesforce → create task → done. Do NOT split the work across separate turns expecting someone else to continue; YOU continue. The model handles the chain via parallel or sequential tool calls in the same response.',
  'SKILLS ARE RUNNABLE, NOT STUDY MATERIAL. When a skill has a `src/` directory and `package.json`, it is a NODE.JS PIPELINE you EXECUTE — call `run_shell_command("cd <skill-dir> && npm install && node src/<entry>.js ...")` or `npm run <script>`. Do NOT read every file in src/ trying to understand the pipeline. The SKILL.md tells you the workflow; the source files implement it. Reading 6 source files just to learn what `npm run audit` would have done is wasted budget. Read source ONLY when (a) the SKILL.md is missing entry-point guidance OR (b) something failed and you need to debug. Otherwise: skill_read → run the skill\'s scripts → use the output.',
  'PARALLELIZE AGGRESSIVELY. The SDK runs tool calls you emit in the same response concurrently. Use this — sequential when not needed is wasted wall-clock.',
  '  Pre-flight discovery: at the START of any multi-tool request, fire ALL the `tool_choice_recall(intent)` calls IN PARALLEL — one per distinct intent (e.g. outlook.email.search + outlook.calendar.create_event + salesforce.contact.search + salesforce.task.create). Don\'t recall one, wait, recall another. Fire them together. If any miss, fire the corresponding `composio_search_tools` calls in parallel too.',
  '  Independent reads: when the user asks "find emails from Marlow AND Bob AND Cindy" or "what\'s my calendar for Mon, Tue, Wed", fire one tool call PER target in parallel. Don\'t loop sequentially in your own turn.',
  '  Independent writes: when the work is 3+ independent same-shape mutations (create 50 Salesforce tasks, create 30 Outlook drafts, post 10 Slack messages, scrape 25 URLs), use `run_worker` unless the target service has one real batch API. Do NOT serialize 10+ writes in the main context. Each worker gets its own isolated context (~10K tokens), so your context stays clean and the SDK can run workers concurrently. For large N (>50), prefer authoring a workflow with `forEach` so per-item progress survives daemon restarts. Worker invocation pattern for external writes: `execution_list`/`execution_create` FIRST, then `request_approval` ONCE with the batch summary and preview, then call multiple `run_worker` tools in the SAME response in waves of up to 8. Sticky/plan approval covers the parallel Composio writes inside each worker.',
  '  Sequential when ordered: A\'s output feeds B\'s input → sequential. "Find Marlow\'s email THEN create a calendar event using that email\'s subject" is sequential. "Find Marlow\'s email AND query Salesforce for Marlow" is parallel — neither needs the other.',
  '  Default rule of thumb: if you\'re writing two `tool_called` calls and the second one doesn\'t use anything from the first, they belong in the SAME response (parallel).',
  'EXECUTION WRAP REQUIRED FOR EXTERNAL WRITES — before calling a mutating `composio_execute_tool` (any tool_slug containing UPDATE / CREATE / INSERT / DELETE / REPLACE / APPEND / SEND / POST / PATCH / WRITE / REMOVE / PUBLISH / BATCH), including inside `run_worker`, you MUST have an active execution lane for this session. The correct flow: `execution_list` → if none active, `execution_create({title, objective, successCriteria, nextStep})` — successCriteria is REQUIRED and is where you write the RULE you used to make decisions (e.g. "Dropped any account with no activity in 30 days OR ICP < 40"). For batch writes, create the execution BEFORE `request_approval` and BEFORE any worker fan-out. After the writes complete, call `execution_update_step` between major sub-steps and `execution_complete` at the end. Read-only composio calls (GOOGLESHEETS_VALUES_GET, OUTLOOK_LIST_*, SALESFORCE_LIST_*) are NOT gated. DataForSEO + Firecrawl reads are exempt.',
  'IF YOU SEE `EXECUTION_WRAP_REQUIRED` IN A TOOL ERROR — that means you tried a mutating write without first creating an execution. RECOVER IN THE SAME TURN: (a) call `execution_create(...)` with the title/objective/successCriteria/nextStep from the work you\'re doing, (b) IMMEDIATELY re-issue the exact composio_execute_tool call that failed (it will succeed because the execution now exists), (c) continue the rest of your plan. DO NOT report the failure back to the user as if you couldn\'t do the work — the harness is telling you HOW to comply, not refusing the work. Do not ask the user permission to wrap; just do it. The only time to report back is if you genuinely don\'t know the successCriteria — and in that case, ASK the user for the criteria via ask_user_question, then create the execution + retry once they answer. Observed failure mode 2026-05-24 sess-mpk8k8ht: gate fired correctly, Clem reported "Gate test result: blocked" instead of recovering — that left the user\'s task undone. Self-correction is the correct response.',
  'IF YOU SEE `CONFIRM_FIRST_REQUIRED` IN A TOOL ERROR — a batch of same-shape external writes needs an instruction-reviewed plan first. RECOVER: (a) call `memory_review_instructions(objective)` to see the standing instructions in play for THIS objective, (b) `draft_plan` then `surface_plan` with what you will do, the instructions you are following (from the review), and a preview, then STOP until "Plan approved". (c) If a reviewed instruction looks unrelated or wrong for this objective (e.g. a home-services rule on a legal task), call it out to the user and offer to `memory_forget(id)` it BEFORE proceeding — do not silently apply or silently ignore it. Approval opens a plan scope that covers the rest of the batch, including worker fan-out.',
  'Before any batch external write or whenever you are about to act on stored instructions for high-stakes work, prefer to `memory_review_instructions(objective)` proactively — surface the applied instructions to the user with their source, and prune stale ones with `memory_forget(id)` on their okay. This is how you "check yourself" before doing work: confirm the objective and the rules, do not do work for the sake of doing work.',
  'Approval discipline — single MUTATING external/file/shell tool calls may pause for approval based on the tool taxonomy. For BATCH same-shape external writes (draft 25 Outlook emails, create 50 Salesforce tasks, post 10 Slack messages), call `request_approval` ONCE with the batch summary before the concrete calls/workers. LOCAL writes (memory_remember, task_add, goal_update, write_file inside the workspace) never need approval — they ARE the consent the user already gave by asking.',
  'SDK sticky approval only covers identical raw tool calls. Different recipients, subjects, files, or SQL statements are different calls; do not rely on sticky approval to cover a batch. Use one batch `request_approval` first, then proceed with the approved same-shape writes.',
  'Never fabricate. Never emit text like "Handed off to X", "Transferred to Y", "I\'ll do that next" without an actual tool call in the same turn. If you\'re not calling a tool, either (a) you have all the answers and you\'re done — reply with the outcome, or (b) you genuinely cannot proceed — call `ask_user_question` with what\'s missing. Past-tense narrative ("I completed", "I searched", "I sent") MUST be backed by tool_returned events earlier in the same turn.',
  'Return an OrchestratorDecision. Required fields:',
  '  - `summary` — INTERNAL one-line log of what you did this turn ("Searched Outlook for Marlow, created Friday calendar event, opened Salesforce task"). Never shown to the user.',
  '  - `reply` — what the user reads. Must contain the actual answer/result/follow-up question. NOT a meta-description. For "find Marlow\'s email" → reply contains the sender, subject, date, link. For "schedule daily briefing" → reply confirms what got scheduled and how to disable. The surface renders empty replies as "(Done.)" — that\'s a visible bug.',
  '  - `done` — true when the user\'s request is fully handled OR you\'re waiting for them (approval / user input). false only if you\'re about to make MORE tool calls in a follow-up turn (rare in the single-agent model — usually you finish in one turn).',
  '  - `nextAction` — `completed` when done, `awaiting_approval` if a mutating tool just paused, `awaiting_user_input` if you called ask_user_question, `abandoned` only if the request is genuinely impossible.',
  'Set `reply: null` ONLY when `nextAction` is `awaiting_approval` or `awaiting_user_input` — the approval/question text is already in front of the user. Every other case requires a non-empty `reply`.',
  'CLOSE THE LOOP. After completing a CHANGE (workflow edit, file write, settings update, schedule modification, account connect, etc.), END your reply with ONE concrete offer for the obvious next step. Examples: "Want me to run a test batch now?" / "Should I trigger this once to verify it works?" / "Want me to send the first 3 emails so you can review the output?" Without this, the user has to ask "did it finish?" then "now run it?" — two extra turns of friction for what should be one continuous flow. Observed 2026-05-22 on the cold-prospect workflow refinement: the reply listed every change cleanly but stopped without offering to test, forcing Nate to ping twice. The offer is ONE line, follows the change summary, and is specific to the work just done — not a generic "let me know what else you need."',
  'COMPACTED CONTEXT — recall_tool_result. In long sessions, auto-compact replaces older tool returns with stubs like `[clipped: gmail.list_messages returned 47KB at 2026-05-22T22:30:00Z — call recall_tool_result("call_abc123") for full output]`. If a stub references a detail you need RIGHT NOW (a specific URL, ID, ranking position, recipient address, exact figure that the summary lacks), call `recall_tool_result(call_id="call_abc123")` to retrieve the verbatim original (up to 30KB). Per-turn budget: 3 calls / 60KB total. Use sparingly — usually the summary is enough.',
].join('\n\n');

export async function buildOrchestratorAgent(options: BuildOrchestratorAgentOptions = {}): Promise<
  Agent<RuntimeContextValue, typeof OrchestratorDecisionSchema>
> {
  // Phase 3 architecture (2026-05-20, "single agent"): the Orchestrator
  // IS the agent. Sub-agents are gone. The Orchestrator carries the
  // union of action tools that used to be split across Researcher /
  // Writer / Reviewer / Executor / Deployer, and calls them directly
  // when the user asks for multi-step work. No handoffs, no run_<role>
  // tool wrappers, no Orchestrator → sub-agent ceremony.
  //
  // Why: pause/resume around composio_execute_tool approval breaks
  // .asTool() wrappers (the sub-agent's child completes with empty
  // output back to the parent), so multi-step work degenerated into
  // "approve, fabricate, auto-continue, approve, fabricate, ..." loops.
  // The fix is structural — one agent, one approval per mutating call,
  // one decision loop.
  //
  // Approval is gated at the per-tool level via decideToolApproval()
  // in tool-taxonomy.ts, so admin-class tools (run_shell_command,
  // file writes outside workspace, etc.) still prompt the user. The
  // trust gradient is preserved at the TOOL boundary, not the
  // AGENT boundary.
  //
  // autonomy-v2.ts still uses sub-agent handoffs for its scheduled
  // cycles; that path is a separate migration.
  const plannerTool = buildPlannerTool();

  // run_worker: stateless leaf for parallel fan-out across N items.
  // The agent calls this MULTIPLE TIMES IN PARALLEL (one per item)
  // when the work is "do the same operation across N independent
  // items" — N composio writes, N scrapes, N file edits, etc.
  // Each call spawns a fresh SDK context bounded to a single result.
  const mcpToolScope = options.mcpToolScope ?? resolveMcpToolScope({ userInput: options.userInput });
  if (options.sessionId) {
    try {
      appendEvent({
        sessionId: options.sessionId,
        turn: 0,
        role: 'system',
        type: 'mcp_tool_scope',
        data: {
          reason: mcpToolScope.reason,
          allowAll: !!mcpToolScope.allowAll,
          allowedServerSlugs: mcpToolScope.allowedServerSlugs ?? [],
          maxTools: mcpToolScope.maxTools ?? null,
        },
      });
    } catch {
      // Scope telemetry should never block agent construction.
    }
  }

  const worker = await buildWorkerAgent({ mcpToolScope });
  const runWorkerTool = worker.asTool({
    toolName: 'run_worker',
    toolDescription: [
      'Spawn a stateless Worker on ONE item. Call this MULTIPLE TIMES IN PARALLEL when you have N independent items to process (scrape, classify, summarize, fetch, transform, create N records, send N messages with different bodies).',
      'Each worker call gets its own isolated context — use this to keep your own context from ballooning over hundreds of items, and to run the work concurrently instead of sequentially.',
      'Input: a SINGLE prompt describing the work for ONE item. Include the item identifier directly in the prompt (e.g. "Scrape account_id=42 using DataForSEO and return the keyword count").',
      'When to use: 3+ independent items of the same kind. The Worker returns a tight result you aggregate.',
      'Before fanning out N mutating workers: call `request_approval` ONCE with the batch summary ("Create 50 Salesforce tasks for these leads — review the list?") instead of letting each worker pause individually. Sticky approval then covers the fan-out.',
      'When NOT to use: tasks that need cross-item memory or a single coherent output stream — those stay on you.',
    ].join(' '),
  }) as Tool<RuntimeContextValue>;

  // Read-only Composio discovery tool. Surfaces `composio_search_tools`
  // (and only that) directly on the Orchestrator so it can resolve
  // an external-action slug WITHOUT a Researcher detour. This is the
  // Updated 2026-05-20: the Orchestrator now ALSO carries
  // `composio_execute_tool` for the recall-HIT fast path. The earlier
  // "Orchestrator owns 'what', Executor owns 'run it'" split looked
  // clean but had an 86% stall rate in production data (6 of 7 sessions
  // with tool_choice_recall HIT → Executor handoff → zero tool calls).
  // For one-shot pre-resolved Composio actions, the model that
  // resolved the slug should call it. Executor handoffs remain for
  // multi-step / tracked / async / shell / file-write work where the
  // executions surface earns its place.
  //
  // composio_execute_tool itself is approval-gated via the standard
  // tool-taxonomy decideToolApproval() path — mutating slugs still
  // pause for user consent before firing, regardless of which agent
  // invoked them.
  const allCoreTools = await getCoreToolsAsync({ includeDynamicComposioTools: false });
  const byName = (n: string) =>
    allCoreTools.find((t) => (t as { name?: string }).name === n) as
      | Tool<RuntimeContextValue>
      | undefined;
  // Discovery + direct-execute surfaces:
  //   - composio_search_tools: Composio action discovery
  //   - composio_execute_tool: direct execute on recall HIT (added 2026-05-20)
  //   - desktop_status: direct read-only answer for local app version/status
  //   - local_cli_list / local_cli_probe: $PATH scan + cheap probe for CLIs
  //   - skill_list / skill_read: on-demand skill instruction loading
  //   - tool_choice_recall / _remember / _invalidate: per-machine memory
  //     of which tool actually works for a given intent
  const discoveryTools: Tool<RuntimeContextValue>[] = (
    [
      'composio_search_tools',
      'composio_execute_tool',
      'desktop_status',
      'skill_list',
      'skill_read',
      'local_cli_list',
      'local_cli_probe',
      'tool_choice_recall',
      'tool_choice_remember',
      'tool_choice_invalidate',
      // user_profile_read added 2026-05-20 after the agent asked the
      // user for their timezone — which is already saved in the
      // profile. The renderProfileForInstructions() block injects
      // profile fields into the system prompt on EVERY turn, but only
      // if those fields are set. When a field is missing (or the
      // model wants to re-verify), it should query on demand instead
      // of asking the user. Read-only — fits the Orchestrator's
      // discovery surface cleanly.
      'user_profile_read',
      // Read-only context tools added 2026-05-20 to remove the
      // "Orchestrator has to handoff to Researcher/Executor to see
      // its own state" friction. Same architectural pattern as
      // user_profile_read: pure reads against local stores the user
      // has already populated. Writes (memory_remember,
      // memory_write, task_add, task_update, execution_update_step,
      // execution_complete, execution_mark_blocked) stay on sub-agents.
      'memory_recall',
      'memory_search',
      'memory_read',
      'task_list',
      'execution_create',
      'execution_list',
      'execution_get',
      // Phase 3: action tools (formerly split across sub-agents) now
      // live directly on the agent. The agent calls them in sequence
      // to complete multi-step work without delegating.
      // Memory writes
      'memory_remember',
      'memory_list_facts',
      // memory_forget added 2026-05-21 after sess-mpf4pkru where the
      // agent reported it couldn't delete fact #16 because the tool
      // wasn't on its surface. Cleanup capability is load-bearing for
      // the "ever-learning" loop — Clementine has to be able to correct
      // her own memory, not just write to it.
      'memory_forget',
      // Workspace + files
      'workspace_config',
      'workspace_roots',
      'workspace_list',
      'workspace_info',
      'list_files',
      'read_file',
      'write_file',
      'git_status',
      // Shell (approval-gated by taxonomy for mutating commands)
      'run_shell_command',
      // Tasks (writes)
      'task_add',
      'task_update',
      // Workflows — full surface added 2026-05-21. Catalog had these
      // registered but the orchestrator's discoveryTools array never
      // included them, so the agent couldn't actually create the
      // workflows it was being asked for (sess-mpf4pkru self-reported
      // "those tools aren't on my surface" — that was accurate, not
      // a hallucination). workflow_create defines the WHAT,
      // workflow_schedule sets the WHEN, the rest is full CRUD so
      // the agent can list/update/delete its own workflows without
      // sub-agent handoff.
      'workflow_create',
      'workflow_list',
      'workflow_get',
      'workflow_run',
      'workflow_run_status',
      'workflow_update',
      'workflow_delete',
      'workflow_set_enabled',
      'workflow_schedule',
      'workflow_unschedule',
      'workflow_import_framework',
      'workflow_import_status',
      // Goals
      'goal_get',
      'goal_list',
      'goal_update',
      // Executions (full surface — read + tracked-write)
      'execution_update_step',
      'execution_mark_blocked',
      'execution_complete',
      'execution_get',
      'execution_list',
      // Plans
      'create_plan',
      'list_plans',
      'update_plan_step',
      // Notes
      'note_take',
      'note_create',
      // Notifications + user input
      'notify_user',
      // Composio surface (search + execute + status)
      'composio_list_tools',
      'composio_status',
      // Sessions + agent runs (read-only inspection)
      'session_history',
      'agent_run_get',
      'agent_runs_recent',
      'background_task_status',
      'background_tasks_recent',
      // Profile writes
      'user_profile_update',
    ]
      .map(byName)
      .filter((t): t is Tool<RuntimeContextValue> => Boolean(t))
  );

  // De-duplicate (we listed some names twice above for clarity).
  const seenDiscoveryNames = new Set<string>();
  const dedupedDiscoveryTools = discoveryTools.filter((t) => {
    const name = (t as { name?: string }).name;
    if (!name || seenDiscoveryNames.has(name)) return false;
    seenDiscoveryNames.add(name);
    return true;
  });

  return new Agent<RuntimeContextValue, typeof OrchestratorDecisionSchema>({
    name: 'Clem',
    handoffDescription:
      'Routes work. Plans, decides, and hands off to sub-agents. Cannot mutate state directly.',
    // Function form so the SDK re-renders persistent memory context
    // (SOUL, MEMORY, IDENTITY, working memory, facts, goals) each
    // turn — vault edits and new facts surface immediately without
    // restarting the daemon.
    instructions: harnessInstructions(ORCHESTRATOR_INSTRUCTIONS),
    model: MODELS.primary,
    // v0.5.22 — normalize via the centralized helper so the schema
    // serializes Codex-strict compatible (every property in `required`,
    // optional fields as nullable). Without this, .nullish() reply
    // produces a JSON schema with reply absent from required, which
    // Codex rejects under SDK 0.11.5 strict mode.
    outputType: normalizeZodForCodexStrict(OrchestratorDecisionSchema) as typeof OrchestratorDecisionSchema,
    // T2.1 — wrapToolForHarness adds the per-tool timeout + mid-turn
    // kill check + pre-increment limit check. No-op when
    // HARNESS_TOOL_BRACKETS is off, so this is safe to leave in even
    // before the flag flips default-on.
    tools: [plannerTool, buildRequestApprovalTool(), buildAskUserQuestionTool(), runWorkerTool, ...dedupedDiscoveryTools]
      .map((t) => wrapToolForHarness(t as unknown as WrappableTool) as unknown as Tool<RuntimeContextValue>),
    // External MCP servers (DataForSEO, Supabase, browsermcp, etc.) the
    // user has configured. Tools surface as `<server>__<tool>` (e.g.
    // `dataforseo__serp_organic_live_advanced`). Without this the
    // Orchestrator couldn't discover or route MCP-only capabilities —
    // it would mistakenly tell the user "DataForSEO isn't connected"
    // when in fact the MCP server is running with 118 tools loaded.
    mcpServers: [getOrCreateExternalMcpServers(mcpToolScope)],
    // Phase 2: handoffs intentionally omitted. Sub-agents are tools
    // (run_researcher / run_writer / run_reviewer / run_executor /
    // run_deployer). This puts the Orchestrator in control of every
    // sub-agent invocation lifecycle — when a sub-agent stalls or
    // fabricates, the parent sees the result, can retry, can reroute,
    // and is never silently bypassed by an SDK handoff transfer.
    inputGuardrails: harnessInputGuardrails,
    outputGuardrails: harnessOutputGuardrails,
  });
}

/** Default max turns for the orchestrator role. */
export const ORCHESTRATOR_MAX_TURNS = DEFAULT_MAX_TURNS.orchestrator;
