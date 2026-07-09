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
import { getCoreToolsAsync } from '../tools/registry.js';
import { getOrCreateExternalMcpServers } from '../runtime/mcp-servers.js';
import { codeModeMandateDirective } from '../tools/code-mode-tool.js';
import { detectMultiItemIntentFromConversation } from '../runtime/harness/context-packet.js';
import { resolveMcpToolScope, resolveMcpToolScopeWithRecall, type McpToolScope } from '../runtime/mcp-tool-scope.js';
import { pinnedCalendarRuleLabels } from '../runtime/harness/constraint-guard.js';
import type { Tool } from '@openai/agents';
import { appendEvent, listEvents } from '../runtime/harness/eventlog.js';
import { resolveRubricVariant, DEFAULT_RUBRIC_VARIANT } from './rubric-variant.js';
import { ORCHESTRATOR_INSTRUCTIONS, ORCHESTRATOR_INSTRUCTIONS_LEAN, ORCHESTRATOR_BEHAVIOR_NATIVE } from './clem-rubric.js';
import { resolveToolJitDecision, selectToolsForTurn, recallPinnedBuiltinTools } from './tool-jit.js';
import { resolveToolSearchDecision, resolveHotSet, buildToolCatalog, allRegistryNames } from './tool-catalog.js';
import { deriveOrchestratorDiscoveryNames } from '../tools/tool-registry.js';
import { buildCallTool } from '../tools/call-tool.js';
import { dynamicReasoningEnabled } from '../runtime/harness/reasoning-effort.js';
import { openPlanScope } from './plan-scope.js';
import { loadProactivityPolicy } from './proactivity-policy.js';
import { buildWorkerJobPrompt, resolveWorkerMaxTurns, WorkerToolInputSchema, type WorkerToolInput } from './worker-job-packet.js';
import { workerItemAlreadyCapped } from './worker-respawn-guard.js';
import { acquireWorkerSlot } from './worker-concurrency.js';
import { recordOperationalEvent } from '../runtime/operational-telemetry.js';
import { recordModelRouteDecision, recordModelRouteOutcome, type ModelRouteDecisionSource } from '../runtime/model-route-metrics.js';
import { resolveProvider } from '../runtime/harness/model-wire-registry.js';
import { recordSubagentRun, providerClassForModel } from './subagent-runs.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import {
  harnessInputGuardrails,
  harnessOutputGuardrails,
} from '../runtime/harness/guardrails.js';
import { DEFAULT_MAX_TURNS, wrapToolForHarness, workerThrashGuardEnabled, type WrappableTool } from '../runtime/harness/brackets.js';
import { claudeAgentSdkWorkerEnabled, runClaudeAgentSdkWorker } from '../runtime/harness/claude-agent-worker.js';
import { ClaudeSdkProviderOverloadError } from '../runtime/harness/claude-agent-sdk.js';
import { falloverBrainModelIds } from '../runtime/harness/model-role-options.js';
import { resolveEffectiveToolPolicy } from '../runtime/harness/tool-policy.js';

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
 * The turn output is PLAIN TEXT + an optional one-line marker (ASK: /
 * CONTINUE:), parsed by the loop (parseDecisionText). Worker fan-out happens
 * via parallel tool calls to run_worker, which IS parallelizable because
 * run_worker is a tool, not a handoff.
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
    .describe('The natural-language message to show the user IN THIS TURN. Write this FIRST. REQUIRED when nextAction=completed, including greetings, small talk, confirmations, and final results. Pass null ONLY when nextAction is awaiting_approval or awaiting_user_input because that approval/question text is already in front of the user. There is no separate executor, so "I am handing off" is NEVER a reason to pass null. Without a reply here, the harness treats the decision as invalid and retries.'),
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
  /**
   * Phase 1 Tool-RAG gate. JIT tool loading (CLEMMY_TOOL_JIT) only ever applies
   * when this is true AND there is a userInput. It MUST be set ONLY on interactive
   * chat lanes where a user is present turn-by-turn — never on autonomous lanes
   * (cron / background / workflow steps / goal-resume / outcome), which cannot
   * recover a JIT-dropped built-in tool (no mid-run acquisition exists yet) and
   * have no user to consult. Default (undefined/false) ⇒ full surface, so a new
   * caller is safe-by-omission.
   */
  allowToolJit?: boolean;
}

// ---------- internal helpers ----------

/** Intent-routed chat workers (default on). off => run_worker ignores the
 *  optional packet intent and uses the role-wide Worker binding. */
function workerIntentRoutingEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_WORKER_INTENT_ROUTING', 'on') || 'on').trim().toLowerCase() !== 'off';
}

/** Cross-provider worker fallover (shares the brain-fallover kill-switch,
 *  default on): a Claude SDK worker that overloads before committing re-runs
 *  the item on the next connected brain. */
function workerBrainFalloverEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_BRAIN_FALLOVER', 'on') ?? 'on').toLowerCase() !== 'off';
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
  pendingActionId: z.string()
    .nullable()
    .describe('Optional id from pending_action_queue. Use this when the exact action payload is already queued and the user is approving execution of that queued action.'),
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

const SEND_CLASS_TEXT_RE = /\b(send|sending|sends|email|emails|e-mail|sms|text message|post|posting|publish|tweet|dm)\b/i;

/**
 * YOLO must NOT auto-approve a BATCH of irreversible external sends
 * (2026-07-09, sess-mrds80fu: "Auto-approved by YOLO mode: Send market-leader
 * reactivation emails 1-10" put 10 unapproved emails on the wire). Detection
 * anchors on the queued pending action when one exists (kind external_send +
 * its plan's item count); otherwise falls back to send-vocabulary + an item
 * count parsed from the subject ("emails 1-10", "10 emails"). Single or
 * uncounted sends keep the YOLO contract unchanged.
 */
export const _yoloBlockedForSendBatchForTests = (args: RequestApprovalArgs): Promise<boolean> => yoloBlockedForSendBatch(args);

async function yoloBlockedForSendBatch(args: RequestApprovalArgs): Promise<boolean> {
  const { sendBatchApprovalFloor } = await import('./proactivity-policy.js');
  const floor = sendBatchApprovalFloor();
  const id = args.pendingActionId?.trim();
  if (id) {
    try {
      const { getPendingAction } = await import('../runtime/harness/pending-actions.js');
      const { IRREVERSIBLE_VERBS } = await import('../runtime/harness/confirm-first-gate.js');
      const record = getPendingAction(id);
      if (record) {
        // Send-ness anchors on BOTH the queue kind AND the plan's own slug —
        // the kind derives from the MODEL-declared sideEffect, so a send batch
        // the model labeled 'write' must not slip the gate (adversarial-review
        // blocker, 2026-07-09).
        const payload = record.payload as { items?: unknown[]; composioSlug?: string } | undefined;
        const slugIrreversible = typeof payload?.composioSlug === 'string'
          && payload.composioSlug.split('_').some((part) => IRREVERSIBLE_VERBS.has(part.toUpperCase()));
        if (record.kind !== 'external_send' && !slugIrreversible) return false;
        // Unknown count on a queued SEND batch → conservative: require a human.
        return !Array.isArray(payload?.items) || payload.items.length >= floor;
      }
    } catch { return true; /* fail-closed on the safety path */ }
  }
  const text = `${args.subject} ${args.reason ?? ''}`;
  if (!SEND_CLASS_TEXT_RE.test(text)) return false;
  // Count only numbers that plausibly denote batch size: an explicit range
  // ("emails 1-10") or a number adjacent to a send-noun ("25 outreach emails").
  // A bare number ("July 10 newsletter") must not block a single daily send.
  const range = /(\d{1,4})\s*[-–]\s*(\d{1,4})/.exec(text);
  const counted = /\b(\d{1,4})\s+(?:[a-z-]+\s+){0,2}?(?:emails?|e-mails?|messages?|recipients?|contacts?|prospects?|sends?|posts?|dms?|sms)\b/i.exec(text);
  const count = range ? Math.abs(Number(range[2]) - Number(range[1])) + 1 : counted ? Number(counted[1]) : undefined;
  return typeof count === 'number' && Number.isFinite(count) && count >= floor;
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

async function pendingActionApprovedSlugs(args: RequestApprovalArgs): Promise<string[]> {
  const id = args.pendingActionId?.trim();
  if (!id) return [];
  try {
    const { getPendingAction } = await import('../runtime/harness/pending-actions.js');
    const record = getPendingAction(id);
    const slug = (record?.payload as { composioSlug?: string } | undefined)?.composioSlug;
    return typeof slug === 'string' && slug.trim() ? [slug.trim()] : [];
  } catch {
    return [];
  }
}

async function openRequestApprovalScope(args: RequestApprovalArgs, runContext: unknown): Promise<string[]> {
  if (args.destructive) return [];
  const sessionId = extractSessionId(runContext);
  if (!sessionId) return [];
  // Approve-once-then-run: a HUMAN approval of a queued action IS the reviewed
  // plan — open the scope for the plan's own slug so the confirm-first gate
  // doesn't re-refuse the approved batch at the threshold (adversarial review,
  // 2026-07-09). The text-inference fallback keeps the old draft-batch shape.
  const fromPendingAction = await pendingActionApprovedSlugs(args);
  const allowedComposioSlugs = fromPendingAction.length > 0 ? fromPendingAction : inferApprovedComposioSlugs(args);
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

async function markPendingActionApprovedFromRequest(args: RequestApprovalArgs): Promise<string> {
  const pendingActionId = args.pendingActionId?.trim();
  if (!pendingActionId) return '';
  try {
    const { getPendingAction, markPendingActionApprovalResolved } = await import('../runtime/harness/pending-actions.js');
    markPendingActionApprovalResolved(pendingActionId, 'approved');
    const record = getPendingAction(pendingActionId);
    if (!record) {
      return ` Queued action ${pendingActionId} is approved, but the queue record could not be read; do not reconstruct it from memory.`;
    }
    return [
      ` Queued action ${record.id} is approved.`,
      `Execute ONLY the exact queued payload for ${record.toolName} (payload hash ${record.payloadHash}); do not reconstruct it from memory.`,
      `Call pending_action_get if the payload is not already in context, then call pending_action_record_result after execution.`,
    ].join(' ');
  } catch {
    // Approval is authoritative; pending-action status mirroring is best-effort.
    return '';
  }
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
      // Send-batch check FIRST: a queued external_send whose subject happens
      // to read like a local save ("save these emails to memory then send")
      // must never ride the local-save shortcut past the gate (adversarial-
      // review blocker, 2026-07-09).
      if (await yoloBlockedForSendBatch(args)) return true;
      if (isLocalSaveApproval(args)) return false;
      if (isYoloAutoApprovalPolicy()) return false;
      return true;
    },
    execute: async (args, runContext) => {
      const sendBatchBlocked = await yoloBlockedForSendBatch(args);
      if (!sendBatchBlocked && isLocalSaveApproval(args)) {
        const pendingActionText = await markPendingActionApprovedFromRequest(args);
        return `Auto-approved (local save — no external mutation): ${args.subject}. Proceed with the save and report back what landed.${pendingActionText}`;
      }
      if (!sendBatchBlocked && isYoloAutoApprovalPolicy()) {
        const pendingActionText = await markPendingActionApprovedFromRequest(args);
        return `Auto-approved by YOLO mode: ${args.subject}. Proceed with the action you described.${pendingActionText}`;
      }
      const pendingActionText = await markPendingActionApprovedFromRequest(args);
      const scopedSlugs = await openRequestApprovalScope(args, runContext);
      const scopeText = scopedSlugs.length > 0
        ? ` Approved scope opened for ${scopedSlugs.join(', ')} in this session, so matching concrete tool calls should not ask again.`
        : '';
      return `Approved: ${args.subject}. Proceed with the action you described.${pendingActionText}${scopeText}`;
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

const offerBackgroundParams = z.object({
  objective: z.string().min(4).describe('The agreed task you are offering to run — one line, e.g. "scrape 100 net-new Salesforce accounts".'),
});

/** The canonical, consistent "run it in the background / hold / now" offer. A
 *  structured beat (not free-form prose) so the choice is always the same and
 *  routes cleanly. Mirrors ask_user_question's halt: posts the choice + pauses
 *  for the reply, which the model routes next turn. */
export function buildOfferBackgroundTool() {
  return tool({
    name: 'offer_background',
    description:
      'Offer to run an AGREED multi-step or longer task in the BACKGROUND — call this AFTER you and the user have aligned on what to do, INSTEAD of grinding it out in the foreground and blocking the chat. It posts a 3-way choice and pauses for the reply. On their answer next turn: "Run it in the background" → call dispatch_background_task (the run is goal-bound and reports back HERE); "Hold it for later" → call hold_task_for_later; "Do it now here" → just do it in the chat. Do NOT use this for a quick task, a pure question, or a read-only lookup. After calling it, STOP this turn — do not also start the work.',
    parameters: offerBackgroundParams,
    execute: async (args, runContext) => {
      const sessionId = extractSessionId(runContext);
      const question = `Want me to run "${args.objective}" in the background and report back here when it's done, hold it for later, or just do it now here?`;
      const options = ['Run it in the background', 'Hold it for later', 'Do it now here'];
      if (sessionId) {
        appendEvent({
          sessionId,
          turn: extractTurn(runContext),
          role: 'Clem',
          type: 'awaiting_user_input',
          data: { question, options, source: 'offer_background' },
        });
      }
      return (
        `Offer posted (background / hold / now) for "${args.objective}". STOP now — on the user's pick next turn: `
        + '"Run it in the background" → dispatch_background_task; "Hold it for later" → hold_task_for_later; '
        + '"Do it now here" → do it in the chat. Do NOT start the work this turn.'
      );
    },
  });
}

// ---------- orchestrator factory ----------

// Brain rubric CONTENT now lives in ./clem-rubric.ts (Phase 3 — ONE shared source
// both flagship lanes consume; the Phase-5 prune happens there, in one place).
// Imported above for local use (the variant map below) and RE-EXPORTED here so
// existing importers (orchestrator.test.ts cross-check, claude-wire-capture.test,
// rubric-characterization.test.ts byte-snapshots) keep working unchanged.
export { ORCHESTRATOR_INSTRUCTIONS, ORCHESTRATOR_BEHAVIOR_NATIVE };

// Engine-over-prompt A/B substrate (Phase 0c). The variant→instructions map for
// the @openai/agents (Codex/headless) lane. Today only 'legacy' is implemented,
// so the DEFAULT is byte-identical to before — the switch and telemetry land now;
// Phase 5 registers a characterization-tested 'lean' variant here and A/B's it.
// resolveRubricVariant() falls back to legacy (observably) on any unknown value.
export const RUBRIC_INSTRUCTIONS_BY_VARIANT: Record<string, string> = {
  legacy: ORCHESTRATOR_INSTRUCTIONS,
  // Phase-5 surgical prune (~1/4 the tokens) — composed of proven text (the
  // lean Claude-brain rubric + Codex essentials + the decision contract +
  // tail). Opt in with CLEMMY_RUBRIC_VARIANT=lean to A/B; default stays legacy
  // until a live A/B shows reliability ≥ legacy. See clem-rubric.ts.
  lean: ORCHESTRATOR_INSTRUCTIONS_LEAN,
};

/** Resolve the Codex-lane rubric (instructions string) + the chosen variant for
 *  telemetry. Bounded by what RUBRIC_INSTRUCTIONS_BY_VARIANT actually implements. */
export function selectOrchestratorRubric(sessionId?: string | null): {
  variant: string;
  requested: string;
  fellBack: boolean;
  experiment: boolean;
  arm: 'lean' | 'legacy' | null;
  instructions: string;
} {
  // sessionId enables the per-session live A/B (CLEMMY_RUBRIC_VARIANT_AB) — without
  // it, the global CLEMMY_RUBRIC_VARIANT governs (byte-identical to before).
  const choice = resolveRubricVariant(Object.keys(RUBRIC_INSTRUCTIONS_BY_VARIANT), sessionId);
  const mapped = RUBRIC_INSTRUCTIONS_BY_VARIANT[choice.variant];
  // fellBack reflects "did we actually serve the proven legacy rubric instead of
  // the requested one" — true if resolveRubricVariant fell back OR the resolved
  // variant has no real instructions registered (a future mis-registration).
  if (mapped == null) {
    return { variant: DEFAULT_RUBRIC_VARIANT, requested: choice.requested, fellBack: true, experiment: choice.experiment, arm: choice.arm, instructions: ORCHESTRATOR_INSTRUCTIONS };
  }
  return { ...choice, instructions: mapped };
}

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

/**
 * Recent conversation texts (BOTH roles, newest first) for multi-item/fan-out
 * detection. The item count usually lives in the ASSISTANT's own proposal
 * ("run research on these 18 email-ready firms?"), so user inputs alone miss
 * it — read `user_input_received` texts AND `conversation_step` replies from
 * this session's eventlog. Best-effort: any failure returns [].
 */
export function recentConversationTextsForFanout(
  sessionId: string,
  currentInput?: string | null,
  limit = 6,
): string[] {
  try {
    const rows = listEvents(sessionId, {
      types: ['user_input_received', 'conversation_step'],
      desc: true,
      limit: 16,
    });
    const current = (currentInput ?? '').trim();
    const out: string[] = [];
    // desc:true returns chronological (oldest→newest); walk backwards → newest-first.
    for (const ev of [...rows].reverse()) {
      const data = ev.data as { text?: unknown; decision?: { reply?: unknown; summary?: unknown } };
      const text = typeof data?.text === 'string'
        ? data.text.trim()
        : typeof data?.decision?.reply === 'string'
          ? data.decision.reply.trim()
          : typeof data?.decision?.summary === 'string'
            ? data.decision.summary.trim()
            : '';
      if (!text || text === current) continue;
      out.push(text);
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

export async function buildOrchestratorAgent(options: BuildOrchestratorAgentOptions = {}): Promise<
  Agent<RuntimeContextValue, any>
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
  // Prior-turn texts (this session + continuation lineage), newest-first. Reused by
  // BOTH the MCP scope (continuity) and the JIT ranking query, so a bare follow-up
  // ("do it", "schedule it") ranks against the work the conversation built toward.
  const priorUserInputs = options.sessionId
    ? recentPriorUserInputsForScope(options.sessionId, options.userInput)
    : [];
  const mcpToolScope = options.mcpToolScope ?? (
    options.sessionId
      ? resolveMcpToolScopeWithRecall({
          userInput: options.userInput,
          priorUserInputs,
          pinnedCalendarLabels: pinnedCalendarRuleLabels(),
        })
      : resolveMcpToolScope({ userInput: options.userInput, pinnedCalendarLabels: pinnedCalendarRuleLabels() })
  );
  // T1: thread the current input so the fail-open MCP surface can rank the
  // user's connected tools by semantic relevance (run-start only; ignored by
  // keyword family scopes). Respects a caller-provided queryText.
  if (typeof options.userInput === 'string' && options.userInput.trim() && !mcpToolScope.queryText) {
    mcpToolScope.queryText = options.userInput;
  }
  // Batch-shape directive: on a data-heavy turn (MCP data servers in scope)
  // inject the standing lane rule (run_worker per item / run_tool_program /
  // direct read). Multi-item detection reads the CONVERSATION, not just the
  // current message — the count usually lives in the assistant's own prior
  // proposal ("research these 18 firms?") answered with a bare "yes"
  // (live 2026-07-07: current-message-only detection serialized 18 firms).
  // '' (byte-identical prompt) on non-data turns or when the kill-switch is off.
  const multiItem = typeof options.userInput === 'string'
    ? detectMultiItemIntentFromConversation(
        options.userInput,
        options.sessionId ? recentConversationTextsForFanout(options.sessionId, options.userInput) : priorUserInputs,
      )
    : undefined;
  const codeModeMandate = codeModeMandateDirective({
    mcpServersInScope: mcpToolScope.allowedServerSlugs?.length ?? 0,
    allowAllMcp: !!mcpToolScope.allowAll,
    fanoutPreferred: options.allowToolJit === true && !!multiItem?.isMultiItem,
    multiItem: multiItem?.isMultiItem
      ? { count: multiItem.itemCount, kind: multiItem.itemKind, carried: !!multiItem.carriedFromPrior }
      : undefined,
  });
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
          // Adoption-measurement hook: did the Code Mode mandate fire this turn?
          codeModeMandate: !!codeModeMandate,
        },
      });
    } catch {
      // Scope telemetry should never block agent construction.
    }
  }

  // Engine-over-prompt A/B substrate (Phase 0c): pick the rubric variant in force
  // and tag the run so it is attributable to an arm. Emitted at agent construction
  // (i.e. PER TURN, like mcp_tool_scope) — A/B aggregation should dedupe to one row
  // per session. Default 'legacy' → byte-identical to before. The extra row on the
  // default path is intended telemetry. Must never block construction.
  const rubricChoice = selectOrchestratorRubric(options.sessionId);
  if (options.sessionId) {
    try {
      appendEvent({
        sessionId: options.sessionId,
        turn: 0,
        role: 'system',
        type: 'rubric_variant',
        data: {
          variant: rubricChoice.variant,
          requested: rubricChoice.requested,
          fellBack: rubricChoice.fellBack,
          // A/B attribution: `arm` + `experiment` let scripts/measure-rubric-ab.ts
          // segment real traffic; `lane` scopes the readout (this is the codex/
          // native orchestrator lane — the Claude brain runs its own lean rubric).
          experiment: rubricChoice.experiment,
          arm: rubricChoice.arm,
          lane: 'codex',
        },
      });
    } catch {
      // Variant telemetry should never block agent construction.
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
  // the per-worker loop-guard (identical-call soft block@5..11, escalate@12), not this cap;
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
      const workerModel = route.model ?? resolveRoleModel('worker').modelId;
      const workerProvider = resolveProvider(workerModel);
      // P6: throttle concurrent worker fan-out per session so N parallel run_worker
      // calls can't open N provider calls at once and storm a rate limit. Bounds BOTH
      // worker lanes (this wraps before the route branch). Released in the finally.
      // worker_queued/worker_spawned mirror the SDK lane's emits (worker-tools.ts)
      // so Codex-brain swarms are just as visible on the NowStrip/Slack/Discord.
      const releaseWorkerSlot = await acquireWorkerSlot(sessionId ?? '', (info) => {
        try {
          recordOperationalEvent({
            source: 'harness',
            type: 'worker_queued',
            sessionId: sessionId ?? undefined,
            actor: 'run_worker',
            payload: { item: input.item, lane: 'orchestrator', ...info },
          });
        } catch { /* telemetry is best-effort */ }
      }, { modelId: workerModel, provider: workerProvider });
      try {
      try {
        recordOperationalEvent({
          source: 'harness',
          type: 'worker_spawned',
          sessionId: sessionId ?? undefined,
          actor: 'run_worker',
          payload: { item: input.item, model: workerModel, provider: workerProvider, lane: 'orchestrator' },
        });
      } catch { /* telemetry is best-effort */ }
      // Live-visibility: announce the agent STARTING so the chat activity strip
      // renders a running specialist immediately (parity with worker-tools.ts's SDK
      // lane — this @openai/agents lane emitted worker_spawned telemetry but never
      // the worker_started event the NowStrip/Slack/Discord read). Fail-open.
      if (sessionId) {
        try {
          appendEvent({ sessionId, turn: 0, role: 'system', type: 'worker_started', data: { item: input.item, model: workerModel, provider: workerProvider, role: input.intent || undefined, lane: 'orchestrator' } });
        } catch { /* telemetry is best-effort */ }
      }
      const turn = extractTurn(runContext);
      const toolCallId = details?.toolCall?.callId ?? null;
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
      // Move 5: durable per-worker completion record — restart-surviving coverage
      // + spend for a long 100-subagent run (the in-memory fanout ledger is lost
      // on a daemon restart). Best-effort; never blocks fan-out.
      const workerRouteStartedAt = Date.now();
      const appendWorkerResult = (data: { item: string; ok: boolean; model?: string | null; toolUses?: string[]; tokens?: number; reason?: string; preRun?: boolean }): void => {
        if (!sessionId) return;
        const { preRun, ...eventData } = data;
        try {
          appendEvent({ sessionId, turn, role: 'system', type: 'worker_result', data: { ...eventData, toolCallId } });
        } catch { /* durable trace is best-effort */ }
        // Route-outcome capture (adaptive routing evidence): score WORKER models,
        // not just the brain. Skipped for pre-run refusals (respawn guard) — those
        // are not the model's outcome. Fail-open.
        if (preRun) return;
        try {
          const ranModel = data.model || workerModel;
          const traceSource = route.trace?.source;
          const source: ModelRouteDecisionSource = traceSource === 'default' || !traceSource
            ? 'default'
            : traceSource === 'policy'
              ? 'policy'
              : route.trace?.matchedIntent
                ? 'intent_binding'
                : 'binding';
          const decisionId = recordModelRouteDecision({
            sessionId,
            role: 'worker',
            intent: input.intent || undefined,
            resolvedModel: ranModel,
            provider: resolveProvider(ranModel),
            source,
            reason: { lane: 'orchestrator', item: input.item },
          });
          recordModelRouteOutcome({
            decisionId,
            status: data.ok ? 'success' : 'failed',
            latencyMs: Date.now() - workerRouteStartedAt,
            totalTokens: data.tokens,
            toolSuccess: data.ok,
          });
        } catch { /* metrics must never block fan-out */ }
      };
      const workerResultReason = (value: unknown): string => {
        const raw = value instanceof Error ? value.message : typeof value === 'string' ? value : String(value ?? '');
        return raw.split('\n')[0].slice(0, 400);
      };
      const appendWorkerResultFromOutput = (
        output: unknown,
        data: { model?: string | null; toolUses?: string[]; tokens?: number } = {},
      ): void => {
        const text = typeof output === 'string' ? output : String(output ?? '');
        const ok = !/^\s*ERROR:/i.test(text);
        appendWorkerResult({
          item: input.item,
          ok,
          ...data,
          ...(ok ? {} : { reason: workerResultReason(text) }),
        });
      };
      const workerResultTokens = (usage: unknown): number => {
        const u = usage as Record<string, unknown> | undefined;
        if (!u || typeof u !== 'object') return 0;
        const n = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0);
        return n('input_tokens') + n('output_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens');
      };
      // Subagent-runs visibility spine (parity with worker-tools.ts's SDK-brain
      // lane): record WHO ran (provider+model+role), WHAT they did (task +
      // work-product), OUTCOME — attributed to the workflow run when spawned inside
      // a step, else the chat session. This @openai/agents (Codex/GLM-BYO) lane
      // never recorded, so the Agents panel was empty on those brains. Fail-open;
      // never blocks fan-out. Derives ok/capped from the worker output text (the
      // same "ERROR:" / turn-cap signals the in-memory ledger reads).
      const recordWorkerSubagent = (outputText: string, ranModel: string | null | undefined): void => {
        try {
          const ctx = getToolOutputContext();
          const parentRunId = ctx?.workflowRunId || sessionId;
          if (!parentRunId) return;
          const text = outputText ?? '';
          const ok = !/^\s*ERROR:/i.test(text);
          const capped = !ok && /MaxTurnsExceeded|hit its turn cap/i.test(text);
          const model = ranModel || workerModel;
          recordSubagentRun({
            id: `w-${workerRouteStartedAt}-${Math.random().toString(36).slice(2, 8)}`,
            parentRunId,
            parentKind: ctx?.workflowRunId ? 'workflow' : 'session',
            workflowName: ctx?.workflowName,
            stepId: ctx?.stepId,
            role: input.intent || undefined,
            provider: providerClassForModel(model),
            model,
            task: input.item,
            status: capped ? 'capped' : ok ? 'ok' : 'error',
            output: text,
            startedAt: new Date(workerRouteStartedAt).toISOString(),
            finishedAt: new Date().toISOString(),
          });
        } catch { /* visibility trace is best-effort */ }
      };
      // HARD respawn guard (covers BOTH worker lanes — placed before the route
      // branch). If THIS item already hit its turn cap (worker_capped) earlier in
      // this run, refuse to re-spawn it: a re-run with the same packet just caps
      // again, which is the non-converging loop observed live 2026-06-22 (N=3
      // research fan-out, 12+ min, manual cancel). The ERROR: prefix routes the
      // item into the EXISTING fanout-ledger ok=false -> N-of-M honest-partial
      // path (hooks.ts:362, background-tasks.ts fanoutCoverageBlock). The wording
      // MUST NOT contain "hit its turn cap" / "MaxTurnsExceeded" or hooks.ts:380
      // would self-fire a spurious worker_capped. Gated under the existing thrash
      // guard; workerItemAlreadyCapped is fail-open so it can never block fan-out.
      if (workerThrashGuardEnabled() && sessionId && workerItemAlreadyCapped(sessionId, input.item)) {
        const message = `ERROR: worker for "${input.item}" already exhausted its worker turn budget on a prior attempt this run and was NOT re-spawned (a re-run with the same packet would exhaust again). Report this item as failed / needs-attention; do not retry it.`;
        appendWorkerResult({ item: input.item, ok: false, model: workerModel, toolUses: [], reason: workerResultReason(message), preRun: true });
        return message;
      }
      if (claudeAgentSdkWorkerEnabled(workerModel)) {
        // Pass the PARENT chat session so the Claude SDK worker's gates +
        // plan-scope + execution lane aggregate across the fan-out (one batch
        // approval covers all workers).
        try {
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
          // Derive ok from the result, NOT hard-coded — a capped/blocked/empty
          // worker returns an "ERROR:" envelope NORMALLY (the same signal the
          // in-memory honest-partial ledger reads), so the durable coverage map
          // must agree or it would over-report success after a restart.
          const workerOk = !/^\s*ERROR:/i.test(sdkResult.text ?? '');
          appendWorkerResult({
            item: input.item,
            ok: workerOk,
            reason: workerOk ? undefined : (sdkResult.text ?? '').split('\n')[0]?.slice(0, 200),
            model: sdkResult.model ?? workerModel,
            toolUses: sdkResult.toolUses,
            tokens: workerResultTokens(sdkResult.usage),
          });
          recordWorkerSubagent(sdkResult.text ?? '', sdkResult.model ?? workerModel);
          return sdkResult.text;
        } catch (err) {
          // Claude SDK worker overloaded BEFORE committing anything (no tool ran,
          // nothing streamed) → fall THIS item over to the nested worker lane on
          // the next brain (Codex→GLM via RouterModelProvider, which handles any
          // further hop). committed=true → rethrow (a re-run could double-act).
          // Kill-switch CLEMMY_BRAIN_FALLOVER.
          const next = (workerBrainFalloverEnabled() && err instanceof ClaudeSdkProviderOverloadError && !err.committed)
            ? falloverBrainModelIds('claude')[0]
            : undefined;
          if (!next) {
            appendWorkerResult({ item: input.item, ok: false, model: workerModel, toolUses: [], reason: workerResultReason(err) });
            recordWorkerSubagent(`ERROR: ${workerResultReason(err)}`, workerModel);
            throw err;
          }
          appendWorkerRoute({
            seam: 'chat', item: input.item, attemptedIntent: input.intent ?? null,
            modelId: next.modelId, provider: next.provider,
            transport: 'worker_fallover_from_claude', source: 'fallover', toolUses: [],
          });
          const fbOptions = workerThrashGuardEnabled()
            ? { ...runWorkerAsToolOptions, runOptions: { maxTurns: resolveWorkerMaxTurns(input.intent, workerMaxTurns) } }
            : runWorkerAsToolOptions;
          if (!runContext) throw new Error('run_worker requires an SDK run context');
          try {
            const output = await worker.clone({ model: next.modelId }).asTool(fbOptions).invoke(runContext, JSON.stringify(input), details);
            appendWorkerResultFromOutput(output, { model: next.modelId, toolUses: [] });
            recordWorkerSubagent(typeof output === 'string' ? output : String(output ?? ''), next.modelId);
            return output;
          } catch (fallbackErr) {
            appendWorkerResult({ item: input.item, ok: false, model: next.modelId, toolUses: [], reason: workerResultReason(fallbackErr) });
            recordWorkerSubagent(`ERROR: ${workerResultReason(fallbackErr)}`, next.modelId);
            throw fallbackErr;
          }
        }
      }
      if (route.trace) appendWorkerRoute(route.trace);
      const workerForCall = route.model ? worker.clone({ model: route.model }) : worker;
      // Intent-aware cap on the nested lane too (non-Claude worker setups). asTool
      // captures runOptions at BUILD time, so rebuild per-call with the resolved
      // cap rather than reusing the build-time-baked runWorkerAsToolOptions.
      const nestedAsToolOptions = workerThrashGuardEnabled()
        ? { ...runWorkerAsToolOptions, runOptions: { maxTurns: resolveWorkerMaxTurns(input.intent, workerMaxTurns) } }
        : runWorkerAsToolOptions;
      const nestedWorkerTool = workerForCall.asTool(nestedAsToolOptions);
      if (!runContext) throw new Error('run_worker requires an SDK run context');
      try {
        const output = await nestedWorkerTool.invoke(runContext, JSON.stringify(input), details);
        appendWorkerResultFromOutput(output, { model: route.model ?? workerModel, toolUses: [] });
        recordWorkerSubagent(typeof output === 'string' ? output : String(output ?? ''), route.model ?? workerModel);
        return output;
      } catch (err) {
        appendWorkerResult({ item: input.item, ok: false, model: route.model ?? workerModel, toolUses: [], reason: workerResultReason(err) });
        recordWorkerSubagent(`ERROR: ${workerResultReason(err)}`, route.model ?? workerModel);
        // Infra-shaped failure (credentials/auth/provider config): every sibling
        // dies identically — return an actionable envelope instead of a raw
        // throw so the model stops fanning out, finishes inline, and TELLS the
        // user the run degraded to sequential (mirrors worker-tools.ts).
        const reason = workerResultReason(err);
        if (/missing credentials|no default model provider|api key|apikey|unauthorized|invalid_grant|token_revoked|sign-?in expired/i.test(reason)) {
          return `ERROR: worker for "${input.item}" failed before starting: ${reason} `
            + 'PARALLEL FAN-OUT IS UNAVAILABLE this run (worker model backend has no usable credentials — this will fail identically for every item). '
            + 'Do NOT call run_worker again this turn. Process the remaining items inline instead, and TELL THE USER in your reply that parallel fan-out was unavailable (and why).';
        }
        throw err;
      }
      } finally {
        releaseWorkerSlot();
      }
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
  // DERIVED from the single tool registry (TOOL-REGISTRY-PLAN-2026-07-07, step 2):
  // the curated ~130-name array was deleted — membership is now every registry
  // tool whose lanes include 'orchestrator' (deriveOrchestratorDiscoveryNames).
  // Per-tool provenance (the incident history that grew this list) now lives in
  // tool-registry.ts. byName still resolves each name to its live Tool and no-ops
  // to undefined for flag-gated tools (spaces / code-mode off ⇒ absent from
  // getCoreTools ⇒ filtered out), so the surface stays byte-identical under a flag
  // exactly as before. Order is the registry's deterministic (alphabetical)
  // declaration order; the dedup below and the JIT ranker treat this as a
  // membership set, and a conformance test pins the SET.
  const discoveryTools: Tool<RuntimeContextValue>[] = [...deriveOrchestratorDiscoveryNames()]
    .map(byName)
    .filter((t): t is Tool<RuntimeContextValue> => Boolean(t));

  // De-duplicate. The registry derivation already yields a unique set, so this is
  // now a defensive no-op kept to preserve the downstream contract.
  const seenDiscoveryNames = new Set<string>();
  const dedupedDiscoveryTools = discoveryTools.filter((t) => {
    const name = (t as { name?: string }).name;
    if (!name || seenDiscoveryNames.has(name)) return false;
    seenDiscoveryNames.add(name);
    return true;
  });

  // Phase 1 Tool-RAG: retrieve only the built-in discovery tools this turn plausibly
  // needs (CORE + semantic top-K). Structural tools (planner/approval/question/worker)
  // are ALWAYS kept (added below). Gated to INTERACTIVE chat lanes only
  // (options.allowToolJit) — autonomous lanes can't recover a dropped built-in (no
  // mid-run acquisition yet) and have no user. The decision is the global flag OR, when
  // the live A/B is on, the session's deterministic arm (control = full surface, jit =
  // reduced) — so both arms are attributable. Off / no-query / no-embeddings / no-signal
  // → full surface (byte-identical). The ranking query folds in recent prior-turn texts
  // so bare follow-ups inherit intent. Never throws into construction.
  // Resolved EARLY so JIT can stand down when the deferred surface governs: with
  // tool-search active, first-class = structural + hot set and everything else is
  // catalog-reachable — JIT's semantic top-K over the same tools is pure waste
  // (measured 10.5s cold on 2026-07-08: it embedded+ranked 127 built-ins, dropped
  // 61, and the switch then rebuilt the surface its own way) and can even prune a
  // session-LRU tool the hot set wanted first-class.
  const searchDecision = resolveToolSearchDecision({ allowLane: options.allowToolJit === true, sessionId: options.sessionId });
  const jitDecision = resolveToolJitDecision({ allowLane: options.allowToolJit === true && !searchDecision.active, sessionId: options.sessionId });
  let jitDiscoveryTools = dedupedDiscoveryTools;
  let jitDropped = 0;
  let jitReason = searchDecision.active ? 'jit-superseded-by-tool-search' : jitDecision.active ? 'jit-active-no-reduction' : 'jit-inactive';
  if (jitDecision.active && typeof options.userInput === 'string' && options.userInput.trim()) {
    try {
      const jitQuery = [options.userInput, ...priorUserInputs.slice(0, 3)]
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .join('\n');
      const selection = await selectToolsForTurn({
        userInput: jitQuery,
        tools: dedupedDiscoveryTools.map((t) => ({
          name: (t as { name?: string }).name ?? '',
          description: (t as { description?: string }).description ?? '',
        })),
        recallPinned: recallPinnedBuiltinTools(jitQuery),
      });
      jitReason = selection.reason;
      if (selection.reduced) {
        jitDiscoveryTools = dedupedDiscoveryTools.filter((t) =>
          selection.exposed.has((t as { name?: string }).name ?? ''),
        );
        jitDropped = selection.droppedCount;
      }
    } catch {
      // JIT selection must never break construction — fall back to the full surface.
      jitDiscoveryTools = dedupedDiscoveryTools;
      jitReason = 'jit-error-fellback';
    }
  }
  // Telemetry. Emit when there was a real reduction (legacy behavior) OR whenever the
  // A/B is running (so the CONTROL arm — which never reduces — is still attributable).
  if (options.sessionId && (jitDropped > 0 || jitDecision.experiment)) {
    try {
      appendEvent({
        sessionId: options.sessionId,
        turn: 0,
        role: 'system',
        type: 'tool_jit_scope',
        data: {
          arm: jitDecision.arm,
          experiment: jitDecision.experiment,
          jitActive: jitDecision.active,
          droppedCount: jitDropped,
          exposedCount: jitDiscoveryTools.length,
          reason: jitReason,
        },
      });
    } catch {
      // JIT telemetry should never block agent construction.
    }
  }

  const baseInstructions = harnessInstructions(rubricChoice.instructions, { sessionId: options.sessionId ?? undefined });

  // Schema-on-demand (SCHEMA-ON-DEMAND-PLAN-2026-07-07, Phase 1), behind
  // CLEMMY_CODEX_TOOL_SEARCH (default OFF → this whole block is inert and the
  // surface is byte-identical to before). When active on an interactive chat lane:
  // first-class tools = structural + the session HOT SET (TOOL_JIT_MANDATED ∪ recall
  // pins ∪ session LRU); every other discovery tool leaves the schema surface and
  // appears only in the catalog block, reachable THIS turn via call_tool. The catalog
  // is injected via the SAME instructions-trailer mechanism as codeModeMandate (a
  // per-turn re-render), not baked into a separate cacheable prefix.
  let firstClassDiscovery = jitDiscoveryTools;
  let callTool: Tool<RuntimeContextValue> | null = null;
  let catalogBlock: string | null = null;
  let searchFirstClassCount = 0;
  let searchCatalogCount = 0;
  let searchFirstClassTokens = 0;
  let searchCatalogTokens = 0;
  if (searchDecision.active) {
    try {
      const excludes = new Set(options.excludeToolNames ?? []);
      const policyAllowed = new Set([...allRegistryNames()].filter((n) => !excludes.has(n)));
      const searchQuery = [options.userInput, ...priorUserInputs.slice(0, 3)]
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .join('\n');
      const hot = resolveHotSet(options.sessionId, searchQuery, { allowedNames: policyAllowed });
      firstClassDiscovery = dedupedDiscoveryTools.filter((t) => hot.has((t as { name?: string }).name ?? ''));
      callTool = buildCallTool();
      const catalogText = buildToolCatalog({ allowedNames: policyAllowed });
      searchCatalogCount = catalogText ? catalogText.split('\n').length : 0;
      searchCatalogTokens = Math.round(catalogText.length / 4);
      catalogBlock = [
        // Leads with an unambiguous "you HAVE access" — live 2026-07-08 a model
        // read the name-only listing as evidence it had NO tool access and
        // refused the task outright (A_zero_tools stall). The catalog must be
        // impossible to misread as a capability restriction.
        '[tool-catalog] You HAVE FULL TOOL ACCESS this turn: your first-class tools (loaded above — call them directly), every built-in below, and your connected external MCP/composio tools. NEVER claim you lack tool access. The tools below are simply not schema-loaded yet (to save context): invoke one with `call_tool(name, args_json)` using its exact name and a JSON args string — or `tool_search(query)` first if unsure of the name or arguments. External MCP tools are callable the same way: `call_tool("<server>__<tool>", args_json)`. call_tool never prompts on its own: a read runs immediately, a write/send target gates for approval exactly as a direct call would.',
        catalogText,
      ].join('\n');
    } catch {
      // Never break construction — fall back to the full first-class surface.
      firstClassDiscovery = jitDiscoveryTools;
      callTool = null;
      catalogBlock = null;
    }
  }

  const instructionsTrailer = [codeModeMandate, catalogBlock].filter(Boolean).join('\n\n');
  const instructions = instructionsTrailer
    ? () => `${baseInstructions()}\n\n${instructionsTrailer}`
    : baseInstructions;
  const assembledTools = [
    plannerTool,
    buildRequestApprovalTool(),
    buildAskUserQuestionTool(),
    buildOfferBackgroundTool(),
    runWorkerTool,
    ...(callTool ? [callTool] : []),
    ...firstClassDiscovery,
  ];
  searchFirstClassCount = assembledTools.length;
  searchFirstClassTokens = Math.round(
    assembledTools.reduce((sum, t) => {
      const anyT = t as { name?: string; parameters?: unknown };
      return sum + JSON.stringify(anyT.parameters ?? {}).length + (anyT.name?.length ?? 0);
    }, 0) / 4,
  );
  if (options.sessionId && (searchDecision.active || searchDecision.experiment)) {
    try {
      appendEvent({
        sessionId: options.sessionId,
        turn: 0,
        role: 'system',
        type: 'tool_search_scope',
        data: {
          arm: searchDecision.arm,
          experiment: searchDecision.experiment,
          active: searchDecision.active,
          firstClassCount: searchFirstClassCount,
          catalogCount: searchCatalogCount,
          estFirstClassTokens: searchFirstClassTokens,
          estCatalogTokens: searchCatalogTokens,
        },
      });
    } catch {
      // Telemetry never blocks agent construction.
    }
  }
  const toolPolicy = resolveEffectiveToolPolicy({
    surface: 'orchestrator',
    lane: options.allowToolJit === true ? 'chat' : 'execution',
    tools: assembledTools.map((toolRef) => toolRef as Tool<RuntimeContextValue>),
    excludeToolNames: options.excludeToolNames,
    reason: 'orchestrator local harness tools',
  });
  if (options.sessionId) {
    try {
      appendEvent({
        sessionId: options.sessionId,
        turn: 0,
        role: 'system',
        type: 'tool_policy_resolved',
        data: { ...toolPolicy.diagnostics },
      });
    } catch {
      // Tool policy telemetry is diagnostic only.
    }
  }

  return new Agent<RuntimeContextValue, any>({
    name: 'Clem',
    handoffDescription:
      'Routes work. Plans, decides, and hands off to sub-agents. Cannot mutate state directly.',
    // Function form so the SDK re-renders persistent memory context
    // (SOUL, MEMORY, IDENTITY, working memory, facts, goals) each
    // turn — vault edits and new facts surface immediately without
    // restarting the daemon.
    instructions,
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
    // Plain-text DECISION contract: no SDK structured outputType. The model
    // ends its turn with prose plus an optional marker, and the loop parses or
    // repairs that. Reintroducing response_format here recreates the observed
    // D_decision_unparsed/schema-validation failures where useful work was
    // discarded because the final envelope was not perfect JSON.
    // T2.1 — wrapToolForHarness adds the per-tool timeout + mid-turn
    // kill check + pre-increment limit check. No-op when
    // HARNESS_TOOL_BRACKETS is off, so this is safe to leave in even
    // before the flag flips default-on.
    tools: toolPolicy.tools
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
