import type { WorkflowStepInput } from '../../memory/workflow-store.js';
import { getRuntimeEnv } from '../../config.js';
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
  return flagEnabled() && typeof modelId === 'string' && modelId.startsWith('claude-');
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

function addIfKnown(out: Set<string>, tool: string): void {
  const trimmed = tool.trim();
  if (!trimmed || trimmed === '*') return;
  const tail = trimmed.split('__').at(-1) ?? trimmed;
  if (tail === 'run_shell_command') out.add('run_shell_command');
  else if (tail === 'write_file') out.add('write_file');
  else if (tail === 'notify_user') out.add('notify_user');
  else if (tail === 'local_cli_list') out.add('local_cli_list');
  else if (tail === 'local_cli_probe') out.add('local_cli_probe');
  else if (tail === 'composio_execute_tool') out.add('composio_execute_tool');
  else if (tail === 'composio_search_tools') out.add('composio_search_tools');
  else if (tail === 'composio_list_tools') out.add('composio_list_tools');
  else if (tail === 'composio_*') {
    out.add('composio_search_tools');
    out.add('composio_execute_tool');
  }
}

export function requiredLocalMcpToolsForWorkflowStep(step: WorkflowStepInput, fullLane: boolean): string[] {
  if (!fullLane) return [];
  const out = new Set<string>();
  for (const tool of step.allowedTools ?? []) addIfKnown(out, tool);

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
  if (text.includes('composio_execute_tool')) out.add('composio_execute_tool');
  if (text.includes('composio_search_tools')) out.add('composio_search_tools');
  if (text.includes('composio_list_tools')) out.add('composio_list_tools');
  if (/\bnotify\b|\bdm\b|\bsend nate\b|\bsend (?:the )?(?:summary|notification|message)\b/.test(text) || step.sideEffect === 'send') {
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
    '',
    `Workflow: ${workflowName}`,
    `Step id: ${step.id}`,
    step.intent ? `Step intent: ${step.intent}` : '',
    step.usesSkill ? `Declared skill: ${step.usesSkill}` : '',
  ].filter(Boolean).join('\n');
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
  /** Tool-capable gated lane (read + write/send through the harness gate chain)
   *  rather than the read-only profile. */
  fullLane?: boolean;
}): Promise<ClaudeAgentSdkWorkflowStepResult> {
  const fullLane = Boolean(args.fullLane);
  let result: ClaudeAgentSdkRunResult;
  try {
    result = await runClaudeAgentSdkImpl({
      prompt: args.prompt,
      modelId: args.modelId,
      sessionId: args.sessionId,
      systemAppend: renderClaudeAgentWorkflowStepSystemAppend({ workflowName: args.workflowName, step: args.step, fullLane }),
      allowedLocalMcpTools: defaultClaudeAgentSdkAllowedLocalTools(fullLane ? 'worker' : 'read_only'),
      requiredLocalMcpTools: requiredLocalMcpToolsForWorkflowStep(args.step, fullLane),
      agentic: fullLane,
      maxTurns: maxTurns(args.step, fullLane),
      outputSchema: claudeWorkflowStepOutputSchema(),
    });
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
      // workspace_roots/list_files/read_file) regardless of gated-mutations, so
      // their ABSENCE means the child never finished initializing.
      const tail = (t: string): string => t.split('__').at(-1) ?? t;
      const BASELINE = new Set(['ping', 'memory_search', 'memory_read', 'workspace_roots', 'list_files', 'read_file']);
      const surfaceInitialized = err.availableTools.some((t) => BASELINE.has(tail(t)));
      if (!surfaceInitialized) {
        // Transient phrasing so isTransientStepError() classifies it retryable
        // (TRANSIENT_RE matches "temporarily unavailable"); NON_RETRYABLE_RE does
        // not match this string, so the runner WILL retry with a fresh MCP child.
        throw new Error(
          `Workflow-step local MCP tool surface temporarily unavailable: the per-step MCP server advertised ${err.availableTools.length} tools and none of the always-registered baseline tools, so it had not finished initializing. A fresh-server retry should recover. Needed: ${err.missingTools.join(', ')}.`,
        );
      }
      return {
        output: {
          blocked: true,
          reason: `Clementine workflow runtime did not expose required local MCP tool${err.missingTools.length === 1 ? '' : 's'}: ${err.missingTools.join(', ')}. This is a runtime/tool-surface issue, not a service credential issue.`,
        },
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
    return {
      output: { blocked: true, reason: 'Claude reached the workflow-step turn budget before finishing this step.' },
      sdkSessionId: result.sessionId,
      model: result.model,
      toolUses: result.toolUses,
      usage: result.usage,
      modelUsage: result.modelUsage,
      structured: true,
    };
  }
  const normalized = normalizeWorkflowStepOutput(result);
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
