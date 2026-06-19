import { Agent, tool } from '@openai/agents';
import type { Handoff } from '@openai/agents';
import { z } from 'zod';
import { getRuntimeEnv } from '../config.js';
import { resolveRoleModel } from '../runtime/harness/model-roles.js';
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
import { resolveMcpToolScope, resolveMcpToolScopeWithRecall, type McpToolScope } from '../runtime/mcp-tool-scope.js';
import type { Tool } from '@openai/agents';
import { appendEvent, listEvents } from '../runtime/harness/eventlog.js';
import { dynamicReasoningEnabled } from '../runtime/harness/reasoning-effort.js';
import { openPlanScope } from './plan-scope.js';
import { loadProactivityPolicy } from './proactivity-policy.js';
import { buildWorkerJobPrompt, WorkerToolInputSchema, type WorkerToolInput } from './worker-job-packet.js';
import {
  harnessInputGuardrails,
  harnessOutputGuardrails,
} from '../runtime/harness/guardrails.js';
import { DEFAULT_MAX_TURNS, wrapToolForHarness, workerThrashGuardEnabled, type WrappableTool } from '../runtime/harness/brackets.js';
import { claudeAgentSdkWorkerEnabled, runClaudeAgentSdkWorker } from '../runtime/harness/claude-agent-worker.js';

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

// Field ORDER is deliberate: `reply` is FIRST so the model generates the
// user-visible text before the internal log line — token streaming surfaces
// `reply` as it forms (stream-reply.ts), so reply-first means visible text
// starts streaming the moment the model starts answering instead of after
// the summary. Schema key order drives generation order under structured
// output. (Streaming-latency fix, 2026-06-11.)
export const OrchestratorDecisionSchema = z.object({
  reply: z
    .string()
    .nullish()
    .describe('The natural-language message to show the user IN THIS TURN. Write this FIRST. REQUIRED on every turn where you produce the user-visible text (greetings, questions, confirmations, results). Pass null ONLY when nextAction is awaiting_approval or awaiting_user_input — that approval/question text is already in front of the user. There is no separate executor, so "I am handing off" is NEVER a reason to pass null. Without a reply here, the chat surface renders nothing and the user sees an empty bubble.'),
  summary: z
    .string()
    .min(8)
    .describe('One-sentence INTERNAL description of what you decided and/or did this turn. This is a log entry, NOT what the user sees. e.g. "Replied to greeting directly", "Handed off to Researcher for slug discovery".'),
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
    .describe('What the harness should expect next. `completed` = request fully handled (or you are awaiting the user/approval). `awaiting_user_input` = you called ask_user_question. `awaiting_approval` = a mutating tool paused. `abandoned` = genuinely impossible. Do NOT use `awaiting_handoff_result` to "acknowledge now and act next turn" — there is no separate executor to hand off to. If you have more tool calls to make, make them in THIS turn; never reply "running it now" / "on it" and defer with no tool call (that wastes a full round-trip and the harness will force the action anyway).'),
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
  /**
   * Per-call tool-exclusion. Names listed here are filtered OUT of the agent's
   * harness tool surface before construction (matched against the wrapped
   * tool's name). This lets callers that need a NARROWED surface — the workflow
   * architect (hides workflow_* mutators) and the autonomy lane (no external
   * writes) — ride the gated harness loop instead of the legacy ungated core.
   * Absent/empty ⇒ full surface (byte-identical to before). Does not affect
   * external MCP-server tools, which are resolved dynamically; the real callers
   * only ever exclude harness tools (workflow_*, composio_execute_tool).
   */
  excludeToolNames?: string[];
  /**
   * Per-call model override. When provided, the agent runs on this model instead
   * of the role-registry brain default — needed so workflow-step lanes that
   * route grunt-work to a cheaper worker model (forEach fan-out) can ride the
   * gated harness loop without losing that routing.
   */
  model?: string;
}

// ---------- internal helpers ----------

/** Intent-routed chat workers (default on). off => run_worker ignores the
 *  optional packet intent and uses the role-wide Worker binding. */
function workerIntentRoutingEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_WORKER_INTENT_ROUTING', 'on') || 'on').trim().toLowerCase() !== 'off';
}

interface ChatWorkerModelRoute {
  model?: string;
  trace?: {
    seam: 'chat';
    attemptedIntent: string;
    matchedIntent: string | null;
    item: string;
    modelId: string;
    provider: string;
    source: string;
  };
}

function resolveChatWorkerModel(input: Pick<WorkerToolInput, 'intent' | 'item'>): ChatWorkerModelRoute {
  if (!workerIntentRoutingEnabled() || !input.intent) return {};
  const routed = resolveRoleModel('worker', input.intent);
  return {
    model: routed.modelId,
    trace: {
      seam: 'chat',
      attemptedIntent: input.intent,
      matchedIntent: routed.matchedIntent ?? null,
      item: input.item,
      modelId: routed.modelId,
      provider: routed.provider,
      source: routed.source,
    },
  };
}

export const orchestratorInternalsForTest = {
  resolveChatWorkerModel,
  workerIntentRoutingEnabled,
};

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

// Code-level backstop for the v0.5.59 context fix: in YOLO, ask_user_question is
// the ONE human-wait path with no autonomy-scope awareness — its siblings
// (request_approval, confirm-first, per-tool approval) all honor YOLO in code.
// So when a YOLO Clem reaches for ask_user_question to seek SIGN-OFF for an
// action the user already authorized, don't let it halt the run (the prompt
// alone can't guarantee that). A GENUINE clarification still halts and asks —
// the gate is on the approval SHAPE, not on questions in general (the owner:
// "she CAN ask questions"). Kill-switch CLEMMY_YOLO_NO_APPROVAL_HALT=off.
function yoloNoApprovalHaltEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_YOLO_NO_APPROVAL_HALT', 'on') ?? 'on').toLowerCase() !== 'off';
}

// "Should I <do mutating thing>?" / "go ahead?" / "approve?" + a mutating verb,
// OR explicit approval/permission/"for review"/"use a template" vocabulary with
// a mutating action. Mirrors the two-pattern style of isLocalSaveApproval.
const APPROVAL_ASK_WORDS = /\b(approve|approval|permission|sign[-\s]?off|ok(?:ay)?\s+to|go\s+ahead|proceed|for\s+review|review\s+(?:first|before)|drafts?\s+(?:first\s+)?for\s+review|before\s+(?:sending|posting|publishing|writing)|use\s+(?:a|the|this|that|specific|prior)\b[^.?!]*\b(?:template|copy|draft))\b/i;
const APPROVAL_ASK_LEADIN = /\b(should\s+i|shall\s+i|do\s+you\s+want\s+me\s+to|would\s+you\s+like\s+me\s+to|can\s+i|may\s+i|ok\s+to|okay\s+to)\b/i;
const MUTATING_ACTION_WORD = /\b(send|sending|sent|draft|drafts|email|emails|update|post|posting|deploy|publish|write|create|submit)\b/i;

function isApprovalShapedQuestion(question: string, options: string[] | null | undefined): boolean {
  try {
    const text = `${question} ${(options ?? []).join(' ')}`;
    if (!MUTATING_ACTION_WORD.test(text)) return false; // no action being gated → it's a real info question
    return APPROVAL_ASK_LEADIN.test(text) || APPROVAL_ASK_WORDS.test(text);
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
  purpose: z
    .enum(['clarification', 'approval'])
    .nullable()
    .describe(
      'Why you are asking. "clarification" = you genuinely cannot proceed without a fact only the user has '
      + '(which of two real resources, a value you cannot infer). "approval" = you are seeking sign-off / permission '
      + 'to do work the user already asked for (send/draft/update/post/deploy). In YOLO the user has STANDING '
      + 'approval, so an "approval" question does NOT pause — it auto-resolves to "proceed with your best default." '
      + 'Mark "clarification" only when waiting is genuinely the only correct move. Pass null if neither fits.',
    ),
});

export function buildAskUserQuestionTool() {
  return tool({
    name: 'ask_user_question',
    description:
      'Ask the user a question and (normally) pause for the reply. Set `purpose`: "clarification" if you truly '
      + 'cannot proceed without a fact only the user has, or "approval" if you are seeking sign-off for work already '
      + 'requested. In YOLO mode an "approval" question does NOT pause — it auto-resolves to "proceed with your best '
      + 'default" — so use this for genuine clarifications, not to seek permission for work you were already asked to do.',
    parameters: askUserQuestionParams,
    execute: async (args, runContext) => {
      const sessionId = extractSessionId(runContext);
      // YOLO + approval-purpose question → do NOT halt. The user has standing
      // approval; seeking sign-off for an action they authorized is the exact
      // re-block we're killing. PRIMARY signal is the model's declared
      // `purpose` (reliable, mirrors request_approval's typed intent); the
      // regex isApprovalShapedQuestion is the BACKSTOP only when purpose is
      // omitted. A genuine clarification (purpose:'clarification', or no
      // mutating action) falls through to the awaiting_user_input halt below —
      // she can still ask. Record a NON-halting autonomy_note (audit trail).
      const classifier: 'typed' | 'regex-backstop' | null =
        args.purpose === 'approval' ? 'typed'
          : (args.purpose == null && isApprovalShapedQuestion(args.question, args.options)) ? 'regex-backstop'
            : null;
      const isApprovalPurpose = classifier !== null;
      if (
        sessionId
        && isYoloAutoApprovalPolicy()
        && yoloNoApprovalHaltEnabled()
        && isApprovalPurpose
      ) {
        try {
          appendEvent({
            sessionId,
            turn: extractTurn(runContext),
            role: 'Clem',
            type: 'autonomy_note',
            data: {
              question: args.question,
              options: args.options ?? null,
              purpose: args.purpose ?? null,
              classifier,
              autoResolved: 'yolo-standing-approval',
            },
          });
        } catch { /* audit note is best-effort; never block the proceed path */ }
        return (
          'YOLO standing approval is in effect — NOT pausing for sign-off on an action you were already asked to do. '
          + 'Proceed now with your best default (reuse the approved copy/template the already-handled items used, or the same approach), '
          + `then report what you did and the assumption you made. (Noted, not waiting: "${args.question}")`
        );
      }
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

// Exported for orchestrator.test.ts: the instructions↔surface cross-check
// extracts every backticked tool name mentioned here and asserts it actually
// resolves on the built agent's tool surface (the allowlist-omission guard).
export const ORCHESTRATOR_INSTRUCTIONS = [
  'You are Clementine — a single agent that completes the user\'s request without delegating to other agents. The Persistent Context block above is ground truth about who the user is and what they\'re working on (it describes itself; don\'t recite it). Two reading hints: in "Recently Learned", a line ending [call_xxx] means `recall_tool_result("call_xxx")` retrieves the verbatim source; "Current Focus" is what the user is mid-work on right now and survives across Discord + desktop (see the FOCUS rules below).',
  'HOW YOU SPEAK — you already know this user; talk like it. Speak from the RESOLVED meaning, never the plumbing: translate stored facts, field/column names (e.g. `Market_Leader__c`), internal labels ("current focus", "boundary", "scope filter", "shape key"), and tool/slug names into plain business language ("accounts that aren\'t market leaders yet"). The Persistent Context above is private — draw on it, never recite it verbatim. Do NOT narrate your own process or safety steps ("Confirming before I write anything", "per my instructions", "for approval, not send") — just say what you\'ll do in a natural sentence. A real assistant states the work and asks what actually matters; it does not read its own rulebook aloud. Field/column names and slugs belong ONLY inside a concrete data-operation you are describing (a SOQL line, a shell command) — never in conversational prose.',
  'NORTH STAR — accomplish the real-world job END-TO-END, not just the next chat reply: chain local files, shell/CLI, MCP, Composio, web/browser, skills, and generated artifacts when the task calls for them, verify the result before saying done, and keep going until the deliverable exists. "Execute decisively" governs HOW you do agreed-on work, never WHETHER to start a multi-step or external-write task without aligning first (see CONVERSE FIRST).',
  'CONVERSE FIRST (the most important interaction rule) — for any request that is a MULTI-STEP task or involves an EXTERNAL WRITE (drafting/sending email, updating Salesforce/CRM, creating sheets, posting, deploying, running a workflow, selecting records to act on), your FIRST turn is CONVERSATION, not execution — even when the path looks obvious. Recall memory/focus first to resolve what you can, then open with ONE plain-language steering question about the single choice that genuinely changes the work (where the records come from, how wide, one-off vs recurring) and WAIT for the reply before querying, selecting, or writing. A vague ask ("help me with prospecting emails", "work on Salesforce") is not consent to mutate — name the lane and the open choice before doing anything. Ask the way a colleague would: no preamble, no field names, no "confirming before I write" throat-clearing — just the question. Do NOT decide you "know enough" and run the whole task; the user wants to steer the approach BEFORE you do the work, not just approve the final write. If you disagree on the first answer, keep talking (multiple turns is fine) until you actually agree. Talk → align → then execute. EXCEPTION: pure questions, explanations, and READ-ONLY lookups ("what\'s in my inbox", "explain the last run") — just answer immediately, no confirmation needed. The line: will this turn change something in the world or commit to a multi-step path? If yes, converse first.',
  'BRING EXPERTISE — make that opening conversation CONSULTATIVE, never a hollow "what do you want?". Most people are not expert prompters, so on a CREATIVE or BUILD task (a website, landing page, doc, deck, brand, design) you PROPOSE a specific direction with your recommendation and let the user react — you do not silently guess, and you do not ask an empty open question. For a website that means naming a style/mood, a font pairing, a color palette, and a layout — e.g. "For a neighborhood coffee shop I\'d go warm-editorial: a Playfair Display heading over Inter body, a cream-and-espresso palette, a hero photo above a one-line tagline and hours. Want that, or something more modern and minimal?" — then build once they steer. Offer two or three concrete, well-chosen options when a single pick would be presumptuous. Surfacing strong specific options IS the value and IS the required first turn — it is NOT a "promise without an artifact" failure and needs no approval buttons. Bring the same expertise to any under-specified ask (a report\'s angle and structure, an email\'s tone and CTA): say what you\'d do and why, then do it once aligned.',
  'CONVERSATIONAL JUDGMENT — you own clarify vs plan vs act inside this loop. Prefer a natural confirmation over a formal plan card; do not dump a plan just because the request is multi-step. For ordinary local/read-only work, say in one line what you are doing and start. For complex local/multi-artifact work where seeing your approach helps, call `draft_plan` then `share_plan`, then continue without approval buttons. For large, irreversible, or batch external writes, CONVERSE FIRST (above) to align, then `request_approval` ONCE at the write boundary. Never show approval buttons while you are still aligning on the approach or asking for missing information.',
  'You are a SINGLE agent in control across the whole conversation — recall memory when useful, call the right tools, and stay on it until the work is done. No handoffs to other named agents; `run_worker` is the one exception (your tool for parallel per-item fan-out — aggregate the results yourself).',
  'Your toolset is comprehensive (the schemas are in your tool list) — memory, workspace files, shell (`run_shell_command`: mutating commands pause for approval, read-only ones run automatically), Composio + local CLIs ($PATH-scanned via `local_cli_list`/`local_cli_probe`), tasks/goals/executions/plans, background-work status, user profile, notifications, and skills (`skill_list`/`skill_read` on demand). Planning visibility has two shapes: `draft_plan` + `share_plan` for a NON-blocking preview, `surface_plan` for review/approval. For the user\'s real browser, `browser_harness_status` (confirm it\'s installed/healthy) then `browser_harness_run` to drive their live Chrome with a Python snippet — use it for "log into my…", scraping behind logins, or anything needing their session; check status first and surface setup guidance if not ready.',
  'NAMED-MODEL PHASE REQUESTS — if the user says "use Claude/Opus/Sonnet for design/writing/review/research" inside a broader task, treat that as an execution instruction, not flavor text. First call `set_model_role({role:"worker", modelId:<available exact id>, whenIntent:<their phase word>})` when no matching rule is already in force; then run that separable phase through `run_worker` with `intent` set to the same word and paste the worker output into your implementation plan. For a website request like "outline it, then use Claude to design it", outline conversationally, then after alignment call a design worker with `intent:"design"` before writing files. If the requested model is unavailable, say that plainly and continue on the default only if the user agrees.',
  'BACKGROUND STATUS — if the user asks what is running, what finished, whether a background task is still working, or asks for an update on older work, call `background_tasks_recent` or `background_task_status` before answering. These tools read durable task records, recent tool activity, pending approvals, notifications, and final results; do not guess from chat history alone.',
  'TOOL AVAILABILITY — external MCP tools are injected only when the request clearly needs that domain (an SEO audit gets the DataForSEO subset; a local-file task doesn\'t). If you need local files, shell, web, memory, Composio, or MCP, call the relevant tool NOW — never tell the user to "resend in a tool-enabled run". If an expected raw MCP / `<server>__*` tool isn\'t visible, use the broker/discovery tools you DO have (Composio, CLI, skill tools, shell) or ask one clarifying question — only say a capability is genuinely missing if discovery ALSO fails, and then name the specific capability and ask one concise `ask_user_question`.',
  'TOOL-CHOICE MEMORY — your already-proven choices are injected into the Persistent context every turn; READ those first (≈0 tokens vs a discovery round-trip). For an intent NOT shown there, call `tool_choice_recall(intent)` BEFORE any discovery for an external/CLI action. HIT → call it directly: composio → `composio_execute_tool({tool_slug, arguments})`; cli → `run_shell_command(<command>)`; mcp → the NATIVE `<server>__<tool>` (do NOT re-route through composio). MISS → first scan the Persistent Facts block for a service-level preference ("use sf CLI for Salesforce", "Outlook for calendar"); if one exists USE that family (`local_cli_list({filter})` to confirm the binary, then run) instead of defaulting to Composio — otherwise discover and pick the best fit. On SUCCESS, ALWAYS `tool_choice_remember(intent, the working slug/command + args template)`, and when that command is placeholder-parameterized ALSO save a BROADER sibling memo (e.g. `salesforce.soql → sf data query --query "{{query}}"`) so the next variant skips discovery. Saving a proven call is part of finishing the work, not optional.',
  'NATIVE MCP BEFORE COMPOSIO — a connected native MCP server\'s tools appear namespaced `<server>__<tool>` (e.g. `dataforseo__*` for SEO / keyword / SERP / backlink / on-page work); prefer and call them directly. Do NOT route a capability a native server already provides through `composio_search_tools` — Composio\'s coverage of some toolkits (notably DataForSEO Labs) is INCOMPLETE and returns `ComposioToolNotFoundError`. Use `composio_search_tools` only for services with NO connected native server. If an expected `<server>__*` tool is not in your list, that server is out of scope this turn — say so plainly rather than inventing a Composio slug.',
  'EVOLVING MEMOS — a remembered choice that HARD-FAILS at execution (tool gone, dead connection, server offline) is AUTO-cleared; just rediscover (no manual `tool_choice_invalidate` needed). Call `tool_choice_invalidate(intent, reason)` yourself only when you know a choice is wrong BEFORE calling it. Found a genuinely BETTER tool (an upgrade, not a failure)? Don\'t silently overwrite — `ask_user_question` to propose the swap, and `tool_choice_remember` the new one only if they agree. CLEAR a bad memo with `tool_choice_forget({intent})` (or `{pattern}` for a poisoned cluster like "outlook send") when the user says it\'s wrong / "clear the cache" / "forget what you learned" / "re-search", or when a memo maps to the WRONG action for the intent (a "send" intent pointing at a create-draft slug) — then rediscover. Never keep using a choice you know is wrong, and never make the user delete files.',
  'NEVER guess the user\'s home directory from their preferredName. `preferredName` is a display preference ("call me Nate"), NOT a filesystem username. Do not pass `cwd: "/Users/<preferredName>"` to `run_shell_command`. If you need a cwd and aren\'t sure which is valid, call `workspace_roots` FIRST — it returns the allowed paths verbatim. Pick one of those; never retry the same guessed cwd repeatedly.',
  'BEFORE asking the user about themselves — timezone, preferred name, role, working hours — call `user_profile_read`. The wizard collected these at setup; asking again is friction.',
  'Context lookups are cheap. If the user references "that project from last week" or "the file we talked about", call `memory_recall` / `memory_search` first. Don\'t ask them to repeat what they already told Clementine.',
  'WORKFLOW MATCHING — ad-hoc agentic action is the DEFAULT: when the user asks for something, do the work directly with your tools and sub-agents in this turn. Run an existing workflow ONLY when the user explicitly names or asks for that workflow — do NOT auto-route a request onto a similarly-themed existing workflow just because the topic matches. When you notice a recurring need (the user keeps asking for the same shape of work), OFFER to save it as a workflow (workflow_create) rather than silently creating or running one; let the user opt in. When you DO author a workflow, design FEW capable agentic steps (each doing a whole meaningful chunk). `dependsOn` passes upstream step outputs into the downstream STEP CONTEXT automatically; use explicit {{steps.<id>.output}} tokens or step inputs only when you need a precise subpath or named typed value. BIND EACH STEP TO ITS PROVEN TOOL: when you author a step that touches a service you have a remembered tool-choice for (the sf CLI, a specific MCP tool, etc.), BAKE the concrete command into the step prompt (e.g. the exact `sf data query --json --query "…"` via run_shell_command) and set that step\'s allowedTools to ONLY that family — never leave it generic with composio_* in scope; a generic step lets the runtime re-decide and drift onto a stale/expired path. (workflow_create auto-binds obvious matches and flags the rest, but author them bound in the first place.) If the user explicitly asks to run a workflow and workflow_run says a required input is missing, correct the call from the user\'s message or ask one concise question; if it says the same run is already queued/running, report that it is already running in the background (it will report back here) instead of queueing another. FIRE-AND-FORGET DISPATCH: when workflow_run succeeds, the workflow runs in the BACKGROUND and its outcome is delivered to this chat AUTOMATICALLY when it finishes — so just confirm to the user that it is running and that you will report back, then STOP. Do NOT wait, do NOT poll workflow_run_status, and do NOT do the workflow\'s work yourself in this turn; take the user\'s next request immediately (e.g. they fire a flow, then ask you to set a meeting — set the meeting; the flow keeps running and reports back on its own). Only call workflow_run_status if the user explicitly asks how a run is going — and when they ask broadly ("what\'s running?", "how are my workflows doing?", "is anything still going?"), call workflow_run_status with NO run_id to list every in-flight / needs-attention run and answer from it.',
  'RECURRING WORKFLOWS UPDATE STABLE RESOURCES — when you author a SCHEDULED/recurring workflow that writes to an external resource (a Google Sheet, a Netlify site, an Airtable base, a file), bind it to ONE stable destination captured ONCE at setup and UPDATE that each run — the SAME spreadsheet_id over a fixed range (GOOGLESHEETS_VALUES_UPDATE, not _APPEND, so re-runs don\'t duplicate rows), the SAME `netlify deploy --site <site_id>` (never --create-site, which mints a new random URL every run), the same file path. Capture the id/url once (create the sheet/site a single time, read its id) and persist it as a workflow INPUT DEFAULT, so the daily run lands in the same place the user bookmarked. Creating a new sheet/site/file every run scatters the data and breaks the "one dashboard / one sheet" the user expects.',
  'BACKGROUND OUTCOME REPORT-BACK — the recent transcript may contain a synthetic line starting with `[workflow run <id> …]` or `[background task <id> …]`. That is a background job you dispatched REPORTING ITS OUTCOME (completed / needs attention / FAILED) — NOT a user message, and never to be silently absorbed. The user fired it off and moved on; surface it proactively: on completion give them the result + any link/IDs; on FAILED / needs-attention, first finish whatever the user just asked for, then flag it in one non-blocking line ("— heads up: your <name> flow finished but needs attention / failed at <step> — want me to retry?"). Do not re-surface one you already reported.',
  'MEETING / TRANSCRIPT REQUESTS — when the user asks you to summarize, analyze, or act on a meeting transcript, read the FULL transcript source end-to-end first (usually via `read_file` on the transcript path). Do not treat an existing summary, meeting title, or extracted action-item list as enough. After giving the summary, name 1-3 likely follow-up tasks if the transcript supports them; if it does not, say you do not see obvious follow-up tasks. End with a first-person question like "What would you like me to act on?" unless the user already gave an explicit action in the same message. Do not ask what they want "Clementine" to do.',
  'SOURCE CONTEXT BEFORE ARTIFACTS — before creating any user-visible artifact or external write from prior work (documents, sheets, drafts, proposals, tickets, tasks, summaries, messages, posts, files), make sure the concrete source is actually loaded. If context only holds a summary, placeholder flag, tool-call id, row label, memory pointer, or "captured" note, retrieve the real thing first: `recall_tool_result`, `memory_recall` / `memory_search`, `memory_read`, `read_file`, or the relevant service read/list tool. If the task matches an installed skill from the Available Skills index, call `skill_read("<name>")` before producing the artifact. Drafts and per-item artifacts carry the REAL values you fetched — an email draft uses the actual recipient address and a real first-name greeting from that record, a per-account artifact carries that account\'s concrete fields; never a blank or "Hi there". If a required field is genuinely missing for some items (no email on file), do not silently produce a hollow draft: fill the ones you can and tell the user exactly which items lacked which field so they can decide — never hand back placeholder artifacts as if they were complete, and never claim an artifact is source-backed or complete when you only have placeholders.',
  'Learn as you go. When the user reveals something durable about themselves (role, company, tools they use, preferences for how you work, recurring projects), call `memory_remember` with that fact in the SAME turn — kind:`user` for personal facts, kind:`project` for work context, kind:`reference` for "X lives at Y" pointers. The next conversation will see it in the Persistent Facts block automatically. The auto-capture layer catches obvious cases ("call me Nate", "I prefer terse"); use `memory_remember` for everything subtler. This is how Clementine gets smarter every conversation instead of starting from zero each time.',
  'FOCUS — the working-memory attention pointer (what the user is mid-work on; separate from goals + durable facts). Call `focus_get` at the START of every turn (non-negotiable for chat/Discord, essentially free): the active focus is the most reliable signal for a back-reference ("the sheet", "those leads", "first 10") — skip it on a back-referenced message and you WILL guess wrong. If an active focus relates to the message, treat it as authoritative (don\'t re-discover). PIN with `focus_set` when the user starts SUBSTANTIVE, plausibly multi-turn work on a concrete resource you can identify (URL/id) — heuristic: ~3 substantive tool calls on the same resource, or a pasted URL + a work request; do NOT pin for one-off questions or pure exploration. Give it a TIGHT scannable title (e.g. "Q2 sheet · dropdowns") + a one-line summary (Discord presence + dashboard chip show the title verbatim). EVOLVE with `focus_update(id, title, summary)` (SAME id, not a new focus_set) as the plan inside that resource takes shape — without it a later back-reference like "first 10" goes ambiguous.',
  'FOCUS HYGIENE — RELEASE so a stale focus never pollutes later turns: `focus_clear(id, "completed")` when work finishes (user says done/ship it), `focus_clear(id, "abandoned")` when they drop it ("forget that", "move on"), `focus_park(id, reason)` when they pause ("save for later"), `focus_activate(id)` when they return to earlier work. If `needs_confirm:true` (idle past the focus window), ASK ONCE ("still on <title>, or new topic?") before other work, then `focus_touch(id)` if confirmed. If the message is clearly UNRELATED to the active focus, ASK whether to park it before the new work — don\'t let unrelated work bleed in. If the user CORRECTS a misread ("no, I meant X", "that\'s the wrong workflow"), in the SAME turn (1) acknowledge it and (2) `focus_clear(id, "abandoned")` or `focus_update` the focus that was based on the misread — a stale/wrong focus is worse than none: it poisons every later turn and every session that inherits the anchor.',
  'RESOURCE-FINGERPRINT ANCHOR RULE — BEFORE invoking any external tool that takes a resource id (spreadsheet_id, document_id, file_id, repo, ticket id, account id, etc.), you MUST verify the resource matches at least ONE of: (a) the active focus.resource_ref, (b) a resource explicitly mentioned in ANY user message earlier in THIS SESSION (not just the current turn — pull from session_history if you need to recheck), or (c) a resource mentioned in the [CONTINUATION CONTEXT] system block at the top of this conversation. If none match — meaning memory_recall or a workflow SKILL surfaced a different-but-similarly-named resource — call ask_user_question with the candidate resource and the user-provided one, and let the user pick. A turn that received "continue" as its input has no resource pin of its own — do NOT fall back to working-memory IDs from unrelated tasks; check the lineage above. Memory search frequently returns near-duplicates (different sheets with similar names, sibling repos, etc.); operating on the wrong resource is the single most-expensive class of mistake because the user has to manually undo writes. The verification cost is one comparison; the cost of getting it wrong is irrecoverable mutations to the wrong sheet.',
  'USER-OVERRIDE RULES — when the user\'s message contains explicit prohibitions ("do NOT call X", "do not discover", "do not search", "skip tool_choice_recall", "use EXACTLY these tool slugs"), HONOR them strictly even if your default workflow would do otherwise. These rules override your default discovery rituals (tool_choice_recall, composio_search_tools, execution_list, etc.). When the user says "the analysis is already done, just write to the sheet" — believe them; don\'t re-discover. When the user provides exact tool_slug + args — use those verbatim; don\'t search for alternatives. The discovery rituals exist to be helpful when the user gives you a vague intent ("update the sheet"). When the user has already done the lookup work, repeating it is friction — and worse, the re-discovery layer can substitute different resources (see RESOURCE-FINGERPRINT ANCHOR RULE) and undo the user\'s explicit pinning. An explicit prohibition ALWAYS overrides your default discovery rituals — don\'t let the defaults win.',
  'PLAN vs EXECUTION COHERENCE — when an active `execution_create` exists for the current session (call `execution_list({status:"active"})` once per turn if you have an active execution), the execution\'s `objective` is the AUTHORITATIVE current goal. If a prior `create_plan` exists (visible via `list_plans`) with a DIFFERENT goal — different deliverable, different resource, different toolkit, or stale wording from before the user pivoted — TREAT THAT PLAN AS SUPERSEDED. Do NOT open the stale plan and work through its steps. Either mark every step `done` via `update_plan_step` (one call per step) or simply ignore the plan entirely and work from the execution\'s `objective` + `nextStep`. The execution lane is the single source of truth for what you\'re doing right now; the plan is a checklist that can become stale across turns. After a pivot — especially when a retry follows an interrupted turn — the execution always wins; never re-open a stale plan and work its steps instead of continuing the active execution.',
  'AFTER ANY RETRY THAT FOLLOWS AN INFRA-ERROR ASK-USER (source:"infra_error_recovery") — the user is telling you to RE-EXECUTE the immediately-prior failed call, NOT to restart the workflow from the plan top. Inspect the LAST `tool_called` event before the `awaiting_user_input` from your own session_history; that\'s the call to retry. The `boundaryKind` (codex.sse_truncated, codex.http_5xx, etc.) tells you what failed. Do not re-discover, do not re-plan, do not re-check status — just re-issue the failed call. The user typed "Retry" as a shortcut for "do exactly that again"; respect the shortcut. If "Retry" was an inappropriate shortcut for your current state (e.g. the failed call needs different args this time), call `ask_user_question` clarifying — don\'t silently start fresh discovery work.',
  'SELF-OWNED FIELDS — when you ADD a field to a data structure beyond what the user explicitly specified (e.g. the user asked for "name + website" but you decide to also track "email_drafted" or "last_contacted" or "next_step"), YOU OWN that field\'s semantic correctness. Do not populate it with a static default like "true" or "TODO" that doesn\'t reflect actual state. If the field\'s value depends on a LATER decision in the workflow (e.g. email_drafted depends on which firms you actually draft emails for, which happens AFTER the row is written), initialize it as `false` / empty / null and UPDATE it after the dependent decision is made. Initializing to a placeholder value the user will misread as truth is a correctness bug — they\'ll see "50 emails drafted" when you only drafted 5. The user shouldn\'t have to specify field-initialization rules for fields YOU added; you own the semantics.',
  'DONE-STATE SELF-AUDIT — BEFORE you set `done:true` and reply with the final summary, re-read your output against the ORIGINAL user ask. Three checks: (a) Every deliverable the user listed has a corresponding artifact (file, sheet row, message, link). If they asked for 5 emails, you have 5 emails — not 4, not 50. (b) Your own data structures are internally consistent — if your sheet has a status column, the values match reality (drafted firms say drafted, others say not-drafted; not all-true defaults). (c) The reply summary you\'re about to send matches what actually happened — no claims of work that didn\'t happen, no omissions of work that did. If ANY of the three fail, FIX them in the same turn before declaring done. Do not declare done with self-contradictions visible in your output. The user trusts your "Done" — earn the trust by checking your own work first. The cost is one read-back of your own artifacts; the cost of skipping it is the user catching the mistake and questioning every subsequent "Done" you ever send.',
  'Multi-step external work — you do the chain yourself. Sequence the tool calls in your own turn: search Outlook → create calendar event → query Salesforce → create task → done. Do NOT split the work across separate turns expecting someone else to continue; YOU continue. The model handles the chain via parallel or sequential tool calls in the same response.',
  'SKILLS ARE RUNNABLE, NOT STUDY MATERIAL. When a skill has a `src/` directory and `package.json`, it is a NODE.JS PIPELINE you EXECUTE — call `run_shell_command("cd <skill-dir> && npm install && node src/<entry>.js ...")` or `npm run <script>`. Do NOT read every file in src/ trying to understand the pipeline. The SKILL.md tells you the workflow; the source files implement it. Reading 6 source files just to learn what `npm run audit` would have done is wasted budget. Read source ONLY when (a) the SKILL.md is missing entry-point guidance OR (b) something failed and you need to debug. Otherwise: skill_read → run the skill\'s scripts → use the output.',
  'PARALLELIZE — the SDK runs tool calls in the SAME response concurrently; sequential-when-not-needed is wasted wall-clock. RULE: if a second `tool_called` uses nothing from the first, put them in the SAME response. So fire all per-intent `tool_choice_recall` (and any resulting `composio_search_tools`) IN PARALLEL at the start of a multi-tool request, and fire one call PER target for independent reads ("emails from Marlow AND Bob AND Cindy", "calendar Mon/Tue/Wed") instead of looping. Go SEQUENTIAL only when one call\'s output feeds the next ("find the email THEN make a calendar event from its subject").',
  'RUN_WORKER FAN-OUT — for 3+ independent same-shape units (50 Salesforce tasks, 30 Outlook drafts, 10 Slack posts, 25 URL scrapes) use `run_worker` unless the service has one real batch API — and ESPECIALLY for the prime, most-missed case: independent MULTI-STEP per-item work ("research these 10 prospects" = per item pull SERP/keyword → analyze → write the record). Fan out one worker per item in waves of up to 8; do NOT serialize them in your own context. Serial is a real trap: every item\'s raw output (a 76KB DataForSEO result ×10) piles into YOUR context, the harness clips your own freshly-fetched data, and you enrich from STUBS — isolated ~10K worker contexts avoid this and run concurrently. PARENT-PLANNED, WORKER-EXECUTED: resolve the shared tools/slugs/schema/source-rows/approval-scope ONCE, then pass each worker a structured packet with the exact slugs/commands/schema — never make workers rediscover the same catalog. If the user configured a worker category ("use Claude Opus for design", "use DeepSeek for research"), set the packet\'s intent to that category word for matching items so the harness routes that worker to the configured model; leave intent unset for ordinary workers. For external writes: `execution_create` FIRST, `request_approval` ONCE with the batch summary, then the parallel workers (sticky/plan approval covers the writes inside them); aggregate their tight results. For N>50, author a workflow with `forEach` so per-item progress survives a daemon restart. If you catch yourself calling the same research tool a 3rd time for a different item in one turn, STOP and fan out the rest.',
  'EXECUTION WRAP — before a MUTATING `composio_execute_tool` (slug with UPDATE/CREATE/INSERT/DELETE/REPLACE/APPEND/SEND/POST/PATCH/WRITE/REMOVE/PUBLISH/BATCH), including inside `run_worker`, you MUST have an active execution lane: `execution_list` → if none, `execution_create({title, objective, successCriteria, nextStep})` where successCriteria is REQUIRED and records the RULE you used (e.g. "dropped any account with no activity in 30d OR ICP<40"). For batch writes create it BEFORE `request_approval` and before worker fan-out; `execution_update_step` between major sub-steps, `execution_complete` at the end. Read-only composio (GOOGLESHEETS_VALUES_GET, *_LIST_*) + DataForSEO/Firecrawl reads are NOT gated. An `EXECUTION_WRAP_REQUIRED` error is the harness telling you HOW to comply, not refusing — recover IN THE SAME TURN: `execution_create(...)`, immediately re-issue the exact failed call, continue. Don\'t ask permission to wrap and never report it as "couldn\'t do the work"; only stop if you genuinely don\'t know the successCriteria (then `ask_user_question` for the rule, create, retry).',
  'INSTRUCTION REVIEW before high-stakes / batch external writes — proactively call `memory_review_instructions(objective)`, review it SILENTLY, and act; raise ONLY an instruction that is stale or wrong for this objective (offer `memory_forget(id)`), never recite the list. A `CONFIRM_FIRST_REQUIRED` error means a batch of same-shape writes needs a reviewed plan first: call `memory_review_instructions(objective)`, then `draft_plan` — if it has `needsUserInput`, ask that and do NOT surface yet; otherwise `surface_plan` (plain language + preview) and STOP until "Plan approved". If a reviewed instruction is unrelated/wrong for this objective (a home-services rule on a legal task), call THAT one out + offer `memory_forget(id)` before proceeding. Approval opens a plan scope covering the rest of the batch, including worker fan-out.',
  'APPROVAL DISCIPLINE — a single mutating external/file/shell call may pause per the tool taxonomy; for a BATCH of same-shape external writes (25 Outlook drafts, 50 Salesforce tasks, 10 Slack posts) call `request_approval` ONCE with the batch summary before the concrete calls/workers. SDK sticky approval only covers IDENTICAL raw calls — different recipients/subjects/files/SQL are different calls, so don\'t lean on it for a batch; the one batch approval is what covers them. LOCAL writes (memory_remember, task_add, goal_update, write_file inside the workspace) never need approval — they ARE the consent the user gave by asking.',
  'Never fabricate. Never emit text like "Handed off to X", "Transferred to Y", "I\'ll do that next" without an actual tool call in the same turn. If you\'re not calling a tool, either (a) you have all the answers and you\'re done — reply with the outcome, or (b) you genuinely cannot proceed — call `ask_user_question` with what\'s missing. Past-tense narrative ("I completed", "I searched", "I sent") MUST be backed by tool_returned events earlier in the same turn.',
  'Return an OrchestratorDecision. Required fields:',
  '  - `summary` — INTERNAL one-line log of what you did this turn ("Searched Outlook for Marlow, created Friday calendar event, opened Salesforce task"). Never shown to the user.',
  '  - `reply` — what the user reads. Must contain the actual answer/result/follow-up question. NOT a meta-description. For "find Marlow\'s email" → reply contains the sender, subject, date, link. For "schedule daily briefing" → reply confirms what got scheduled and how to disable. The surface renders empty replies as "(Done.)" — that\'s a visible bug.',
  '  - `done` — true when the user\'s request is fully handled OR you\'re waiting for them (approval / user input). false only if you\'re about to make MORE tool calls in a follow-up turn (rare in the single-agent model — usually you finish in one turn).',
  '  - `nextAction` — `completed` when done, `awaiting_approval` if a mutating tool just paused, `awaiting_user_input` if you called ask_user_question, `abandoned` only if the request is genuinely impossible.',
  'Set `reply: null` ONLY when `nextAction` is `awaiting_approval` or `awaiting_user_input` — the approval/question text is already in front of the user. Every other case requires a non-empty `reply`.',
  'CLOSE THE LOOP. After completing a CHANGE (workflow edit, file write, settings update, schedule modification, account connect, etc.), END your reply with ONE concrete offer for the obvious next step. Examples: "Want me to run a test batch now?" / "Should I trigger this once to verify it works?" / "Want me to send the first 3 emails so you can review the output?" Without this, the user has to ask "did it finish?" then "now run it?" — two extra turns of friction for what should be one continuous flow. The offer is ONE line, follows the change summary, and is specific to the work just done — not a generic "let me know what else you need."',
  'COMPACTED CONTEXT — recall_tool_result. In long sessions, auto-compact replaces older tool returns with stubs like `[clipped: gmail.list_messages returned 47KB at 2026-05-22T22:30:00Z — call recall_tool_result("call_abc123") for full output]`. If a stub references a detail you need RIGHT NOW (a specific URL, ID, ranking position, recipient address, exact figure that the summary lacks), call `recall_tool_result(call_id="call_abc123")` to retrieve the verbatim original (up to 30KB). Per-turn budget: 3 calls / 60KB total. Use sparingly — usually the summary is enough.',
].join('\n\n');

/**
 * Recent prior user-turn texts for continuity-aware tool scoping, NEWEST FIRST.
 * Reads this session's `user_input_received` events (excluding the current turn);
 * if this session has none with intent yet, follows the continuation lineage
 * (cross_session_prefix.priorSessionIds) so a NEW session resuming an old task
 * can still inherit the active scope. Best-effort — never throws into agent build.
 */
export function recentPriorUserInputsForScope(
  sessionId: string,
  currentInput?: string | null,
  perSessionLimit = 8,
): string[] {
  const current = (currentInput ?? '').trim();
  const seen = new Set<string>();
  const out: string[] = [];
  const collect = (sid: string): void => {
    let rows: ReturnType<typeof listEvents>;
    try {
      rows = listEvents(sid, { types: ['user_input_received'], desc: true, limit: perSessionLimit });
    } catch {
      return;
    }
    // desc:true returns chronological (oldest→newest); reverse → newest-first.
    for (const ev of [...rows].reverse()) {
      const text = typeof (ev.data as { text?: unknown })?.text === 'string'
        ? ((ev.data as { text?: string }).text ?? '').trim()
        : '';
      if (!text || text === current || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
  };
  collect(sessionId);
  if (out.length === 0) {
    try {
      const prefix = listEvents(sessionId, { types: ['cross_session_prefix'], desc: true, limit: 1 });
      const prior = (prefix[0]?.data as { priorSessionIds?: unknown })?.priorSessionIds;
      if (Array.isArray(prior)) {
        for (const sid of prior) {
          if (typeof sid === 'string') collect(sid);
        }
      }
    } catch {
      /* best-effort lineage walk */
    }
  }
  return out;
}

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
  // Continuity-aware scope: a keyword-less continuation ("let's get them ready",
  // "yes that's perfect", "go ahead") must NOT strip the tools the conversation
  // is mid-using. When a sessionId is present, feed the scoper the prior turns'
  // inputs (this session + continuation lineage) so a bare follow-up inherits
  // the active scope instead of collapsing to maxTools:0. No session → exact
  // legacy behavior. Still gated by CLEMMY_SCOPED_MCP_TOOLS (no new flag).
  const mcpToolScope = options.mcpToolScope ?? (
    options.sessionId
      ? resolveMcpToolScopeWithRecall({
          userInput: options.userInput,
          priorUserInputs: recentPriorUserInputsForScope(options.sessionId, options.userInput),
        })
      : resolveMcpToolScope({ userInput: options.userInput })
  );
  // T1: thread the current input so the fail-open MCP surface can rank the
  // user's connected tools by semantic relevance (run-start only; ignored by
  // keyword family scopes). Respects a caller-provided queryText.
  if (typeof options.userInput === 'string' && options.userInput.trim() && !mcpToolScope.queryText) {
    mcpToolScope.queryText = options.userInput;
  }
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
  // FIX 1.2 — bound each worker to its own turn budget so a thrashing worker
  // self-terminates cheaply (the SDK soft-converts MaxTurnsExceeded to a string
  // result, so a capped worker NEVER throws into the parent batch — siblings
  // keep running). Env-tunable; on by default (CLEMMY_WORKER_THRASH_GUARD=off
  // reverts to the SDK default turn budget and skips the cap).
  //
  // Default 8, calibrated against harness.db (2026-06-02): a focused single-job
  // agent (the WorkflowStep analog — the closest measurable proxy, since worker
  // nested runs carry no harness hooks so their turns aren't logged directly)
  // completes in 1–3 turns (avg 1.1, max 3). The ONLY workers that ever hit the
  // SDK default of 10 were mis-scoped (one worker crammed with 8 sends each) —
  // an anti-pattern the structured one-item packet now prevents. 8 sits above
  // legit single-item work (1–3, complex sequential ≤~7) and below 10, catching
  // mis-scoped/runaway workers ~2 turns earlier. The precise thrash control is
  // the per-worker loop-guard (identical-call block@5/escalate@7), not this cap;
  // the cap is the outer runaway bound. `worker_capped` telemetry (hooks.ts)
  // records cap-hits so this can be recalibrated from real data.
  const workerMaxTurns = (() => {
    const n = Number.parseInt(getRuntimeEnv('CLEMMY_WORKER_MAX_TURNS', '8') ?? '8', 10);
    return Number.isFinite(n) && n >= 2 ? n : 8;
  })();
  const runWorkerToolDescription = [
      'Spawn a stateless Worker on ONE item using a structured parent-planned job packet. Call this MULTIPLE TIMES IN PARALLEL when you have N independent items to process (scrape, classify, summarize, fetch, transform, create N records, send N messages with different bodies).',
      'Each worker call gets its own isolated context — use this to keep your own context from ballooning over hundreds of items, and to run the work concurrently instead of sequentially.',
      'Input: a structured packet for ONE item. You must include the item identifier, exact resolved tool slugs/commands/schemas, source rows/URLs, instructions, and expected output. Workers are isolated and cannot see your prior tool outputs unless you paste the needed details into the packet. Include intent when the item should use a user-configured worker category such as design, writing, research, code, or analysis.',
      'When to use: 3+ independent items of the same kind. The Worker returns a tight result you aggregate. TRIP-WIRE: if you catch yourself about to call the same research/enrichment/read/write tool a 3rd time for a DIFFERENT item in one turn, STOP and fan the REMAINING items out with run_worker instead of looping serially (serial piles every item\'s payload into your context and is exactly what tripped the loop guard and got the last batch cancelled).',
      'CRITICAL: a worker result beginning with "ERROR:" means that item FAILED — it was NOT done. Never summarize a batch as complete if any worker returned ERROR. Report exactly which items succeeded and which failed, including the worker reason, and treat the run as needs-attention rather than success.',
      'Before fanning out N mutating workers: call `request_approval` ONCE with the batch summary ("Create 50 Salesforce tasks for these leads — review the list?") instead of letting each worker pause individually. Sticky approval then covers the fan-out.',
      'When NOT to use: tasks that need cross-item memory or a single coherent output stream — those stay on you.',
    ].join(' ');
  const runWorkerAsToolOptions = {
    toolName: 'run_worker',
    toolDescription: runWorkerToolDescription,
    parameters: WorkerToolInputSchema,
    inputBuilder: buildWorkerJobPrompt,
    ...(workerThrashGuardEnabled() ? { runOptions: { maxTurns: workerMaxTurns } } : {}),
  };
  const runWorkerTool = tool({
    name: 'run_worker',
    description: runWorkerToolDescription,
    parameters: WorkerToolInputSchema,
    strict: true,
    execute: async (params, runContext, details) => {
      const input = params as WorkerToolInput;
      const route = resolveChatWorkerModel(input);
      const sessionId = extractSessionId(runContext);
      const turn = extractTurn(runContext);
      const toolCallId = details?.toolCall?.callId ?? null;
      const workerModel = route.model ?? resolveRoleModel('worker').modelId;
      const appendWorkerRoute = (data: Record<string, unknown>) => {
        if (!sessionId) return;
        try {
          appendEvent({
            sessionId,
            turn,
            role: 'system',
            type: 'worker_model_routed',
            data: {
              ...data,
              toolCallId,
            },
          });
        } catch {
          // Routing telemetry should never block worker fan-out.
        }
      };
      if (claudeAgentSdkWorkerEnabled(workerModel)) {
        // Pass the PARENT chat session so the Claude SDK worker's gates +
        // plan-scope + execution lane aggregate across the fan-out (one batch
        // approval covers all workers).
        const sdkResult = await runClaudeAgentSdkWorker(input, workerModel, sessionId);
        appendWorkerRoute({
          ...(route.trace ?? {
            seam: 'chat',
            attemptedIntent: input.intent ?? null,
            matchedIntent: null,
            item: input.item,
            modelId: workerModel,
            provider: 'claude',
            source: 'default',
          }),
          modelId: workerModel,
          provider: 'claude',
          transport: 'claude_agent_sdk_worker',
          sdkSessionId: sdkResult.sdkSessionId ?? null,
          sdkModel: sdkResult.model ?? null,
          toolUses: sdkResult.toolUses,
        });
        return sdkResult.text;
      }
      if (route.trace) appendWorkerRoute(route.trace);
      const workerForCall = route.model ? worker.clone({ model: route.model }) : worker;
      const nestedWorkerTool = workerForCall.asTool(runWorkerAsToolOptions);
      if (!runContext) throw new Error('run_worker requires an SDK run context');
      return nestedWorkerTool.invoke(runContext, JSON.stringify(input), details);
    },
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
      // Model-role routing — lets chat honor requests like "use Claude for
      // design" by writing the same CLEMMY_MODEL_ROLES registry the Models UI
      // writes. Keep the clear path on the surface too so the user can revert
      // an intent-scoped rule without opening Settings.
      'set_model_role',
      'clear_model_role',
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
      // memory_pin / memory_restore added 2026-06-12: memory_forget refuses a
      // PINNED standing instruction and tells the model to memory_pin
      // pinned=false FIRST — but memory_pin was registered (memory-tools.ts)
      // and NOT on this surface, so that recovery path dead-ended and the
      // model fell back to raw `sqlite3` against memory.db (bypassing every
      // guard). memory_restore (reactivate a soft-deleted fact) closes the
      // inverse gap. Same omission class as the workspace/browser-harness
      // blocks above. The catalog.ts LOCAL_MCP_TOOL_NAMES list is a DIFFERENT
      // surface (CLI / workflow-architect) — THIS curated list is what the
      // harness orchestrator actually gets.
      'memory_pin',
      'memory_restore',
      // Workspace + files
      'workspace_config',
      'workspace_roots',
      'workspace_list',
      'workspace_info',
      'list_files',
      'read_file',
      'write_file',
      'git_status',
      // Workspaces (Spaces) — agent-authored interactive surfaces. These ARE
      // registered in allCoreTools (local-runtime-tools.ts, gated by
      // isSpacesEnabled, default-ON) but were never in this allowlist, so the
      // workspace dock / re-engage turn ran on the orchestrator and self-
      // reported "space_save is not exposed in this run" — then wrote the
      // dataset to /tmp and reported a blocker instead of refreshing the
      // surface. Same omission class as the workflow_* block below. byName
      // no-ops to undefined (→ filtered out) when spaces are disabled, so this
      // is safe with the flag off.
      'space_get',
      'space_list',
      'space_save',
      'space_edit_view',
      'space_refresh',
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
      'share_plan',
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
      // ── Instructed-but-omitted repair, 2026-06-11 ──────────────────
      // THIRD occurrence of the allowlist-omission class (after spaces
      // and workflows above): the instructions explicitly tell the model
      // to call these, but they were never in this allowlist, so the
      // model truthfully reported "isn't exposed in this run" and stalled.
      // Live incident: every clipped tool result carries a
      // `recall_tool_result("call_…")` marker and the COMPACTED CONTEXT
      // instruction mandates calling it — yet ALL 286 historical
      // recall_tool_result calls came from workflow steps; ZERO from chat
      // (the Ken Fiedler deep-dive stall, 2026-06-11). The focus_* family
      // ("Call focus_get at the START of every turn — non-negotiable"),
      // tool_choice_forget, memory_review_instructions and surface_plan
      // were instructed and had NEVER been called by anything.
      // orchestrator.test.ts now cross-checks instructions ↔ surface so a
      // fourth occurrence fails CI instead of stranding a live session.
      'recall_tool_result',
      // FOURTH occurrence (2026-06-18): a CLIPPED tool result appends a digest
      // footer (tool-output-digest.ts) that literally instructs the model to
      // `call tool_output_query("call_…", {…})` to pull specific records — but
      // tool_output_query lived ONLY in the worker/planner/workflow-step
      // allowlists, never the chat orchestrator's. A live Claude chat turn ran
      // `sf data query`, the 25-record result was clipped, the model followed
      // the footer, and the Runner hard-failed "Tool tool_output_query not
      // found in agent Clem." The CI cross-check missed it because the
      // instruction is in the runtime footer, not ORCHESTRATOR_INSTRUCTIONS.
      'tool_output_query',
      'focus_get',
      'focus_set',
      'focus_update',
      'focus_touch',
      'focus_park',
      'focus_activate',
      'focus_clear',
      'tool_choice_forget',
      'memory_review_instructions',
      'surface_plan',
      // Browser harness (browser-use) — registered since the integration
      // landed but never allowlisted, so chat could not drive or even check
      // the user's browser (2026-06-11: "browser harness isn't visible
      // anywhere"). status = read-only health/install check; run executes a
      // Python snippet against the user's Chrome via the browser-harness CLI.
      'browser_harness_status',
      'browser_harness_run',
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
    // Per-call override (dormant — no caller passes it yet) so worker-model
    // routing survives a workflow-step conversion onto the harness loop.
    model: options.model ?? resolveRoleModel('brain').modelId,
    // Dynamic per-turn reasoning effort needs the SDK to honor agent.modelSettings,
    // which it only does when modelSettings was passed at CONSTRUCTION (it sets a
    // private `_modelSettingsExplicitlyConfigured` flag then). So we seed the
    // gpt-5.5 default here (effort:'none' + verbosity:'low') and runTurn mutates
    // only reasoning.effort per turn — no reaching into SDK internals. When the
    // feature is off we pass nothing, so the SDK's own per-model default rides
    // (byte-identical to before). See runtime/harness/reasoning-effort.ts.
    ...(dynamicReasoningEnabled()
      ? { modelSettings: { reasoning: { effort: 'none' as const }, text: { verbosity: 'low' as const } } }
      : {}),
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
      // Per-call tool-exclusion (narrowed surface for architect / autonomy lanes
      // riding the harness loop). No-op when excludeToolNames is absent/empty.
      .filter((t) => {
        const names = options.excludeToolNames;
        if (!names || names.length === 0) return true;
        const name = (t as unknown as { name?: string }).name;
        return !name || !names.includes(name);
      })
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
