import type { WorkflowStepInput } from '../../memory/workflow-store.js';
import { getRuntimeEnv } from '../../config.js';
import {
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

function maxTurns(step: WorkflowStepInput): number {
  if (typeof step.maxTurns === 'number' && Number.isFinite(step.maxTurns) && step.maxTurns >= 1) {
    return Math.floor(step.maxTurns);
  }
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP_MAX_TURNS', '6') ?? '6', 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 6;
}

export function renderClaudeAgentWorkflowStepSystemAppend(args: {
  workflowName: string;
  step: WorkflowStepInput;
}): string {
  const { workflowName, step } = args;
  return [
    'You are a Clementine workflow-step specialist running through the official Claude Agent SDK under the user\'s Claude subscription auth.',
    'Your scope is exactly ONE workflow step. Do the step task, keep the result compact, and do not converse with the user.',
    '',
    'Current capability boundary:',
    '- This Claude SDK workflow-step lane is READ-ONLY/local-context only.',
    '- You may use exposed Clementine MCP tools for memory, skill, profile, session, workspace, status, and read-only file/context lookup.',
    '- Do not write files, run shell commands, create workflows, send messages, update external systems, or perform any mutation in this lane.',
    '- If the step requires mutation or external writes, return status "blocked" with a concrete reason rather than fabricating completion.',
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
}): Promise<ClaudeAgentSdkWorkflowStepResult> {
  const result = await runClaudeAgentSdkImpl({
    prompt: args.prompt,
    modelId: args.modelId,
    systemAppend: renderClaudeAgentWorkflowStepSystemAppend({ workflowName: args.workflowName, step: args.step }),
    allowedLocalMcpTools: defaultClaudeAgentSdkAllowedLocalTools(),
    maxTurns: maxTurns(args.step),
    outputSchema: claudeWorkflowStepOutputSchema(),
  });
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
