import type { WorkflowStepInput } from '../../memory/workflow-store.js';
import { getRuntimeEnv } from '../../config.js';
import { codeModeMandateDirective } from '../../tools/code-mode-tool.js';
import { resolveEffectiveProviderForModel } from './byo-providers.js';
import { recordSubagentRun } from '../../agents/subagent-runs.js';
import { AgentRuntimeCancelledError } from '../provider.js';
import { textTargetsConfiguredUserRecipient } from '../user-profile.js';
import { workflowStateSummaryLine } from '../../execution/workflow-run-state.js';
import {
  ClaudeAgentSdkToolSurfaceError,
  defaultClaudeAgentSdkAllowedLocalTools,
  runClaudeAgentSdk,
  type ClaudeAgentSdkRunOptions,
  type ClaudeAgentSdkRunResult,
} from './claude-agent-sdk.js';

type ClaudeAgentSdkRunFn = (options: ClaudeAgentSdkRunOptions) => Promise<ClaudeAgentSdkRunResult>;
let runClaudeAgentSdkImpl: ClaudeAgentSdkRunFn = runClaudeAgentSdk;

export function setClaudeAgentSdkWorkflowStepRunForTest(fn: ClaudeAgentSdkRunFn | null): void {
  runClaudeAgentSdkImpl = fn ?? runClaudeAgentSdk;
}

function flagEnabled(): boolean {
  const raw = (getRuntimeEnv('CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP', 'on') ?? 'on').trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no');
}

export function claudeAgentSdkWorkflowStepEnabled(modelId: string | undefined | null): boolean {
  if (!flagEnabled() || typeof modelId !== 'string' || !modelId.trim()) return false;
  try {
    return resolveEffectiveProviderForModel(modelId) === 'claude';
  } catch {
    return false;
  }
}

function maxTurns(step: WorkflowStepInput, fullLane: boolean): number {
  if (typeof step.maxTurns === 'number' && Number.isFinite(step.maxTurns) && step.maxTurns >= 1) {
    return Math.floor(step.maxTurns);
  }
  // The full gated lane does real multi-tool work (scrape → analyze, write,
  // send) and needs the same headroom the agentic brain gets (24). The
  // read-only lane stays tight (6) — it only reads/recalls. A too-low cap here
  // hard-failed scrape-class steps with "Reached maximum number of turns".
  const fallback = fullLane ? '24' : '6';
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP_MAX_TURNS', fallback) ?? fallback, 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : (fullLane ? 24 : 6);
}

/** DEFAULT ON. When a workflow step hits its per-query turn budget while STILL making
 *  forward progress, auto-continue instead of BLOCKING the step (parity with the chat
 *  brain's F1). Off (CLEMMY_CLAUDE_SDK_WORKFLOW_STEP_AUTO_CONTINUE=off) ⇒ prior
 *  block-on-budget behavior (the runner's self-heal/retry then handles it). */
function workflowStepAutoContinueEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CLAUDE_SDK_WORKFLOW_STEP_AUTO_CONTINUE', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}
function maxWorkflowStepAutoContinues(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_CLAUDE_SDK_WORKFLOW_STEP_AUTO_CONTINUE_MAX', '4') ?? '4', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 4;
}
function workflowStepAutoContinueWallMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_CLAUDE_SDK_WORKFLOW_STEP_AUTO_CONTINUE_WALL_MS', '900000') ?? '900000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 900_000;
}

export function requiredLocalMcpToolsForWorkflowStep(step: WorkflowStepInput, fullLane: boolean): string[] {
  if (!fullLane) return [];
  const out = new Set<string>();

  const text = `${step.prompt ?? ''}\n${step.intent ?? ''}`.toLowerCase();
  if (
    text.includes('run_shell_command')
    || /\bsf\s+data\s+query\b/.test(text)
    || /\bsalesforce\s+cli\b/.test(text)
    || /\blocal\s+cli\b/.test(text)
  ) {
    out.add('run_shell_command');
  }
  if (text.includes('write_file') || /\bwrite\s+(?:a\s+)?file\b/.test(text)) out.add('write_file');
  if (text.includes('local_cli_list')) out.add('local_cli_list');
  if (text.includes('local_cli_probe')) out.add('local_cli_probe');
  if (
    text.includes('composio_execute_tool')
    || /\bcomposio\s+(?:tool|action)\b/.test(text)
    || /\b(?:AIRTABLE|APIFY|DATAFORSEO|FIRECRAWL|GMAIL|GOOGLE(?:DOCS|DRIVE|SHEETS)?|HUBSPOT|NOTION|OUTLOOK|SALESFORCE|SLACK)_[A-Z0-9_]{3,}\b/.test(`${step.prompt ?? ''}\n${step.intent ?? ''}`)
  ) {
    out.add('composio_execute_tool');
  }
  if (text.includes('composio_search_tools') || /\bcomposio\s+(?:search|discover|lookup|look up|find)\b/.test(text)) {
    out.add('composio_search_tools');
  }
  if (text.includes('composio_list_tools')) out.add('composio_list_tools');
  if (
    /\bnotify\b|\bdm\b|\bsend (?:me|myself|owner|the user)\b|\bsend (?:the )?(?:summary|notification|message)\b/.test(text)
    || textTargetsConfiguredUserRecipient(text)
  ) {
    out.add('notify_user');
  }

  return [...out];
}

export function renderClaudeAgentWorkflowStepSystemAppend(args: {
  workflowName: string;
  step: WorkflowStepInput;
  fullLane?: boolean;
}): string {
  const { workflowName, step, fullLane } = args;
  const boundary = fullLane
    ? [
        'Current capability boundary (FULL gated lane — Claude is the active brain):',
        '- You may use the exposed Clementine MCP tools for read/recall AND the gated execution tools: run_shell_command, write_file, and composio_search_tools / composio_list_tools / composio_execute_tool, plus local_cli_list / local_cli_probe.',
        '- Every mutating/external call is routed through the harness gate chain (grounding, goal-fidelity, confirm-first, and async approval) and the workflow\'s pre-authorized tool grants — so do the real work the step asks for; do not fabricate or merely describe it.',
        '- If a required tool is genuinely unavailable or a gate blocks you, return status "blocked" with a concrete reason rather than claiming completion.',
      ]
    : [
        'Current capability boundary:',
        '- This Claude SDK workflow-step lane is READ-ONLY/local-context only.',
        '- You may use exposed Clementine MCP tools for memory, skill, profile, session, workspace, status, and read-only file/context lookup.',
        '- Do not write files, run shell commands, create workflows, send messages, update external systems, or perform any mutation in this lane.',
        '- If the step requires mutation or external writes, return status "blocked" with a concrete reason rather than fabricating completion.',
      ];
  return [
    'You are a Clementine workflow-step specialist running through the official Claude Agent SDK under the user\'s Claude subscription auth.',
    'Your scope is exactly ONE workflow step. Do the step task, keep the result compact, and do not converse with the user.',
    '',
    ...boundary,
    '- If the step declares a skill, names a taste/design/style skill, or says to use installed skill rules, call `skill_read` for that skill before producing the result.',
    '- Finish by returning the structured output requested by the schema. Do not call `workflow_step_result`; this SDK lane returns the step result directly.',
    // Code-mode BATCH-SHAPE RULE (Move 3 / adoption): a full-lane step with data
    // tools in scope should aggregate several fetches through ONE run_tool_program
    // instead of grinding discrete calls. Only on the full (write-capable) lane —
    // the read-only lane's rule mentions send/write tools it doesn't have.
    fullLane ? codeModeMandateDirective({ composioInScope: true }) : '',
    '',
    `Workflow: ${workflowName}`,
    `Step id: ${step.id}`,
    step.intent ? `Step intent: ${step.intent}` : '',
    step.usesSkill ? `Declared skill: ${step.usesSkill}` : '',
    // Employee-memory priming (2026-07-21): when durable cross-run state
    // exists for this workflow, tell the step up front — otherwise a recurring
    // run rediscovers (or forgets to check) the processed-ledger and redoes
    // prior runs' work. Rendered ONLY when state exists (lean by default).
    safeWorkflowStateLine(workflowName),
  ].filter(Boolean).join('\n');
}

function safeWorkflowStateLine(workflowName: string): string {
  try {
    return workflowStateSummaryLine(workflowName) ?? '';
  } catch {
    return '';
  }
}

export function claudeWorkflowStepOutputSchema(): Record<string, unknown> {
  const anyJson = {
    anyOf: [
      { type: 'object' },
      { type: 'array' },
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'null' },
    ],
  };
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: ['completed', 'blocked'] },
      output: anyJson,
      reason: { type: 'string' },
    },
    required: ['status', 'output'],
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates: string[] = [];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  candidates.push(trimmed);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function normalizeWorkflowStepOutput(result: ClaudeAgentSdkRunResult): { output: unknown; structured: boolean } {
  const structured = result.structuredOutput;
  const payload = structured && typeof structured === 'object' && !Array.isArray(structured)
    ? structured as Record<string, unknown>
    : parseJsonObject(result.text);

  if (!payload) return { output: result.text.trim() || 'ERROR: Claude SDK workflow step produced no output.', structured: false };

  const status = typeof payload.status === 'string' ? payload.status : 'completed';
  if (status === 'blocked') {
    const reason = typeof payload.reason === 'string' && payload.reason.trim()
      ? payload.reason.trim()
      : 'Claude SDK workflow step reported a block.';
    return { output: { blocked: true, reason }, structured: true };
  }
  return { output: payload.output, structured: true };
}

export interface ClaudeAgentSdkWorkflowStepResult {
  output: unknown;
  sdkSessionId?: string;
  model?: string;
  toolUses: string[];
  usage?: unknown;
  modelUsage?: unknown;
  structured: boolean;
}

export async function runClaudeAgentSdkWorkflowStep(args: {
  step: WorkflowStepInput;
  workflowName: string;
  prompt: string;
  modelId: string;
  /** The step's REAL harness session id. Required for the full lane so the gated
   *  tools + async approval read/write the workflow session's plan-scope grants. */
  sessionId?: string;
  /** The workflow RUN id — so a fan-out (run_worker) spawned inside this step is
   *  attributed to the run in the subagent-runs visibility store. */
  runId?: string;
  /** Exact accepted child-step user event. Keeps kill/preflight authority on
   * this physical attempt even if the stable workflow session is reused. */
  sourceUserSeq?: number;
  /** Durable workflow-run cancellation (dashboard or generic Tasks board). */
  shouldCancel?: () => boolean | Promise<boolean>;
  /** Tool-capable gated lane (read + write/send through the harness gate chain)
   *  rather than the read-only profile. */
  fullLane?: boolean;
  /** Release the SDK child + workflow drain slot on a concrete human approval.
   *  The durable exact-payload decision is claimed once on the rerun. */
  parkApprovals?: boolean;
}): Promise<ClaudeAgentSdkWorkflowStepResult> {
  const fullLane = Boolean(args.fullLane);
  // Subagent visibility: a workflow STEP (and each forEach item — this runs per
  // item) IS a specialized agent. Workflow steps run the 'worker' tool profile,
  // which deliberately EXCLUDES run_worker, so the run_worker choke-point never
  // sees them — record the step here so the Agents panel populates for workflows.
  // Fail-open. (Codex/BYO-lane steps that don't take the SDK path are a follow-up.)
  const stepStartedMs = Date.now();
  // Collision-proof id: a parallel forEach fans out N items of the SAME step id at
  // the SAME ms, so `step-<id>-<ms>` alone overwrote siblings' work-products (default
  // concurrency 5). The random suffix keeps each item's row + output distinct.
  const stepAgentId = `step-${args.step.id}-${stepStartedMs}-${Math.random().toString(36).slice(2, 8)}`;
  // A readable task label — the first line of the actual prompt (minus the
  // "Workflow: …\nStep: …\n\n" preamble), not the raw step id (which made rows read
  // "seo_fanout: seo_fanout" since role === task). Falls back to the step id.
  const taskLabel = ((): string => {
    const stripped = args.prompt.replace(/^Workflow:[^\n]*\nStep:[^\n]*\n\n/, '');
    const firstLine = stripped.split('\n').find((l) => l.trim()) ?? '';
    return firstLine.trim().slice(0, 80) || args.step.id;
  })();
  const recordStepAgent = (output: unknown, status: 'ok' | 'error' | 'capped', model?: string): void => {
    try {
      const parentRunId = args.runId || args.sessionId;
      if (!parentRunId) return;
      const resolvedModel = model ?? args.modelId;
      recordSubagentRun({
        id: stepAgentId,
        parentRunId,
        parentKind: args.runId ? 'workflow' : 'session',
        workflowName: args.workflowName,
        stepId: args.step.id,
        role: (args.step as { intent?: string }).intent || args.step.id,
        provider: 'claude',
        model: resolvedModel,
        task: taskLabel,
        status,
        output: typeof output === 'string' ? output : JSON.stringify(output ?? ''),
        startedAt: new Date(stepStartedMs).toISOString(),
        finishedAt: new Date().toISOString(),
      });
    } catch { /* visibility trace is best-effort */ }
  };
  const stepRunOptions = {
    modelId: args.modelId,
    sessionId: args.sessionId,
    sourceUserSeq: args.sourceUserSeq,
    shouldCancel: args.shouldCancel,
    workflowRunId: args.runId,
    workflowName: args.workflowName,
    stepId: args.step.id,
    systemAppend: renderClaudeAgentWorkflowStepSystemAppend({ workflowName: args.workflowName, step: args.step, fullLane }),
    allowedLocalMcpTools: defaultClaudeAgentSdkAllowedLocalTools(fullLane ? 'worker' : 'read_only'),
    requiredLocalMcpTools: requiredLocalMcpToolsForWorkflowStep(args.step, fullLane),
    // Scope the step's NATIVE external MCP surface to what the step actually names
    // (mirrors the chat brain's request.message scoping). Without this the step
    // defaulted to allowAll → every external MCP child cold-started per step and
    // its tool schemas bloated the step's input context. Spreads into the
    // auto-continue call below too, so the continuation keeps the same scope.
    nativeMcpScopeInput: args.prompt,
    agentic: fullLane,
    approvalMode: args.parkApprovals ? 'park' as const : 'wait' as const,
    maxTurns: maxTurns(args.step, fullLane),
    outputSchema: claudeWorkflowStepOutputSchema(),
  };
  let result: ClaudeAgentSdkRunResult;
  try {
    result = await runClaudeAgentSdkImpl({ prompt: args.prompt, ...stepRunOptions });
    // F3 — auto-continue past the per-query turn budget on a forward-progressing step
    // instead of BLOCKING it (parity with the chat brain's F1). A heavy / multi-item
    // step must not halt just because it hit the per-query turn cap while still making
    // tool progress. Bounded by count + wall-clock; a continuation error keeps the prior
    // partial (which then blocks honestly below).
    if (result.limitHit && !result.selfStopped && workflowStepAutoContinueEnabled()) {
      // !selfStopped: never auto-continue an anti-thrash loop-stop (re-running it
      // just re-loops — the exact thrash the ceiling exists to prevent).
      const autoStart = Date.now();
      let autos = 0;
      while (
        result.limitHit
        && !result.selfStopped // a continuation that anti-thrash loop-STOPPED must NOT be re-run
        && result.toolUses.length > 0
        && autos < maxWorkflowStepAutoContinues()
        && (Date.now() - autoStart) < workflowStepAutoContinueWallMs()
      ) {
        let cont: ClaudeAgentSdkRunResult;
        try {
          cont = await runClaudeAgentSdkImpl({
            // Re-include the step's ORIGINAL instructions (which carry any skill body
            // prepended by applySkillToPrompt) — the stateless SDK lane would otherwise
            // lose the skill procedure on the continuation and hand-roll the deliverable.
            prompt:
              `You hit the per-turn tool budget but this step is NOT finished. The step's ORIGINAL instructions (INCLUDING any skill procedure) — KEEP FOLLOWING them:\n\n${args.prompt.slice(0, 12000)}\n\n---\nYour progress so far:\n${(result.text || '').trim().slice(0, 1200)}\n\n`
              + `Continue and FINISH the step — do NOT redo completed work. When done, call workflow_step_result exactly once.`,
            ...stepRunOptions,
          });
        } catch (err) {
          // Cancellation is control flow, never a recoverable provider blip.
          // Swallowing it here resurrected the previous partial result and let
          // the workflow advance after the user pressed Stop.
          if (err instanceof AgentRuntimeCancelledError) throw err;
          break; // a continuation error → keep the prior partial (it blocks honestly below)
        }
        autos += 1;
        result = { ...cont, toolUses: [...result.toolUses, ...cont.toolUses] };
      }
    }
  } catch (err) {
    if (err instanceof ClaudeAgentSdkToolSurfaceError) {
      // A tool-surface miss has TWO causes that must be handled differently:
      //   (1) the per-step MCP child had not finished registering its tools when
      //       the SDK init was checked — TRANSIENT. Each workflow step spawns a
      //       FRESH stdio MCP child; a slow/racey startup advertises an empty (or
      //       partial) surface, and the step then "blocks" on tools that ARE in
      //       its profile. Observed 2026-06-30: an entire facebook-scrape workflow
      //       blocked EVERY step on composio_execute_tool not being advertised,
      //       while sibling workflows the same hour used composio fine. A fresh
      //       child on retry recovers — so re-throw a transient error and let the
      //       runner's bounded step-retry re-run with a new server (self-heal).
      //   (2) the surface initialized fine but the required tool genuinely is not
      //       in this step's profile — a real config error. Hard-blocking is right
      //       there (no thrash on an unfixable miss).
      // Tell them apart by whether the surface came back initialized at all: the
      // MCP server ALWAYS registers the baseline read tools (ping/memory_search/
      // workspace_roots/list_files/read_file/workspace_artifact_query) regardless
      // of gated-mutations, so
      // their ABSENCE means the child never finished initializing.
      const tail = (t: string): string => t.split('__').at(-1) ?? t;
      const BASELINE = new Set(['ping', 'memory_search', 'memory_read', 'workspace_roots', 'list_files', 'read_file', 'workspace_artifact_query']);
      const surfaceInitialized = err.availableTools.some((t) => BASELINE.has(tail(t)));
      if (!surfaceInitialized) {
        // Transient phrasing so isTransientStepError() classifies it retryable
        // (TRANSIENT_RE matches "temporarily unavailable"); NON_RETRYABLE_RE does
        // not match this string, so the runner WILL retry with a fresh MCP child.
        throw new Error(
          `Workflow-step local MCP tool surface temporarily unavailable: the per-step MCP server advertised ${err.availableTools.length} tools and none of the always-registered baseline tools, so it had not finished initializing. A fresh-server retry should recover. Needed: ${err.missingTools.join(', ')}.`,
        );
      }
      const reason = `Clementine workflow runtime did not expose required local MCP tool${err.missingTools.length === 1 ? '' : 's'}: ${err.missingTools.join(', ')}. This is a runtime/tool-surface issue, not a service credential issue.`;
      // A hard-blocked step IS a failed specialist — record it so the Agents panel
      // shows the block (red), not an empty row (this path never recorded before).
      recordStepAgent(reason, 'error');
      return {
        output: { blocked: true, reason },
        toolUses: [],
        structured: true,
      };
    }
    throw err;
  }
  // A turn-budget stop is NOT a clean completion. Surface it as a BLOCKED step so
  // the runner's self-heal / retry handles it honestly, rather than reporting the
  // partial text as a finished result (or hard-failing the whole workflow run).
  if (result.limitHit) {
    // Honest reason: an anti-thrash loop-stop is NOT a plain budget exhaustion —
    // say so, so the runner's self-heal sees the real cause (was hardcoded generic).
    const reason = result.selfStopped
      ? 'Claude stopped this step early: it began repeating actions that looked like a loop (anti-thrash safeguard) before finishing.'
      : 'Claude reached the workflow-step turn budget before finishing this step.';
    recordStepAgent(reason, 'capped', result.model);
    return {
      output: { blocked: true, reason },
      sdkSessionId: result.sessionId,
      model: result.model,
      toolUses: result.toolUses,
      usage: result.usage,
      modelUsage: result.modelUsage,
      structured: true,
    };
  }
  const normalized = normalizeWorkflowStepOutput(result);
  // A step whose output is a { blocked:true } envelope (the SDK reported status
  // "blocked") is a FAILED specialist, not a green ✓ — record it as 'error' so the
  // Agents panel doesn't paint a self-declared block as success.
  const outputBlocked = typeof normalized.output === 'object'
    && normalized.output !== null
    && (normalized.output as { blocked?: unknown }).blocked === true;
  recordStepAgent(normalized.output, outputBlocked ? 'error' : 'ok', result.model);
  return {
    output: normalized.output,
    sdkSessionId: result.sessionId,
    model: result.model,
    toolUses: result.toolUses,
    usage: result.usage,
    modelUsage: result.modelUsage,
    structured: normalized.structured,
  };
}
