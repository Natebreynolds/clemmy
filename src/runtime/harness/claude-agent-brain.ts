import { renderHarnessMemoryContext } from '../../agents/harness-context.js';
import { ORCHESTRATOR_INSTRUCTIONS } from '../../agents/orchestrator.js';
import { getActiveAuthMode, getRuntimeEnv } from '../../config.js';
import type { AssistantRequest, AssistantResponse } from '../../types.js';
import { clearKill, createSession, getSession } from './eventlog.js';
import { resolveRoleModel } from './model-roles.js';
import {
  type ClaudeAgentSdkToolProfile,
  defaultClaudeAgentSdkAllowedLocalTools,
  runClaudeAgentSdk,
  type ClaudeAgentSdkRunOptions,
  type ClaudeAgentSdkRunResult,
} from './claude-agent-sdk.js';

type ClaudeAgentSdkRunFn = (options: ClaudeAgentSdkRunOptions) => Promise<ClaudeAgentSdkRunResult>;
let runClaudeAgentSdkImpl: ClaudeAgentSdkRunFn = runClaudeAgentSdk;

export function setClaudeAgentSdkBrainRunForTest(fn: ClaudeAgentSdkRunFn | null): void {
  runClaudeAgentSdkImpl = fn ?? runClaudeAgentSdk;
}

export type ClaudeAgentBrainSurface = 'webhook' | 'cli' | 'dashboard' | 'home';
export type ClaudeAgentBrainMode = 'read_only' | 'local_authoring';

function configuredMode(): ClaudeAgentBrainMode | null {
  const raw = (getRuntimeEnv('CLEMMY_CLAUDE_AGENT_SDK_BRAIN', 'off') ?? 'off').trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') return null;
  if (raw === 'read_only' || raw === 'readonly') return 'read_only';
  if (
    raw === 'on'
    || raw === '1'
    || raw === 'true'
    || raw === 'yes'
    || raw === 'local'
    || raw === 'local_authoring'
    || raw === 'authoring'
    || raw === 'write'
    || raw === 'writes'
  ) return 'local_authoring';
  return null;
}

export function claudeAgentSdkBrainMode(): ClaudeAgentBrainMode | null {
  return configuredMode();
}

export function isClaudeAgentBrainSurface(surface: string): surface is ClaudeAgentBrainSurface {
  return surface === 'webhook' || surface === 'cli' || surface === 'dashboard' || surface === 'home';
}

export function claudeAgentSdkBrainEnabled(surface: string): surface is ClaudeAgentBrainSurface {
  return configuredMode() !== null && getActiveAuthMode() === 'claude_oauth' && isClaudeAgentBrainSurface(surface);
}

function maxTurns(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_CLAUDE_AGENT_SDK_BRAIN_MAX_TURNS', '6') ?? '6', 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 6;
}

function toolProfileForMode(mode: ClaudeAgentBrainMode): ClaudeAgentSdkToolProfile {
  return mode === 'local_authoring' ? 'local_authoring' : 'read_only';
}

function allowedToolsForRequest(request: AssistantRequest, mode: ClaudeAgentBrainMode): string[] {
  const excluded = new Set(request.excludeToolNames ?? []);
  return defaultClaudeAgentSdkAllowedLocalTools(toolProfileForMode(mode)).filter((toolName) => !excluded.has(toolName));
}

function renderCapabilityBoundary(mode: ClaudeAgentBrainMode): string {
  if (mode === 'read_only') {
    return [
      'IMPORTANT CURRENT CAPABILITY BOUNDARY:',
      '- This Claude Agent SDK brain lane is currently READ-ONLY/local-context only.',
      '- You may use exposed Clementine MCP tools for memory, profile, session, skill, workspace, status, and read-only file/context lookup.',
      '- Do not claim you created workflows, wrote files, ran shell commands, sent messages, updated external systems, or performed any mutation unless a tool result in this run proves it.',
      '- If the user asks for a mutation or full workflow execution, answer with the best design/analysis you can and say that the mutating execution should run through the guarded Codex harness until Claude SDK local-authoring mode is enabled.',
      '- For design/report/writing guidance, use memory and skills when relevant, then produce the user-facing output directly.',
    ].join('\n');
  }
  return [
    'IMPORTANT CURRENT CAPABILITY BOUNDARY:',
    '- This Claude Agent SDK brain lane may use Clementine local-authoring tools: memory writes, task/goal bookkeeping, model-role routing, workflow authoring, workflow enable/disable, workflow scheduling, and workflow_run queueing.',
    '- workflow_run only queues a local Clementine run. The workflow runner still owns per-step execution, model routing, approvals, write/send gates, retries, and report-back.',
    '- You may set model-role rules when the user asks for routing such as "use Claude for design"; use set_model_role(role:"worker", modelId:"claude-opus-4-8" or the available Claude model, whenIntent:"design").',
    '- You may create workflows with steps tagged by intent and usesSkill. For design/report requests, prefer a read-only design/report step with intent:"design" and usesSkill set to the requested skill name.',
    '- Do not call shell, file-write, external Composio execution, external sends, admin, credential, plugin, or deletion tools. Those are intentionally not exposed here.',
    '- Do not claim you ran a workflow, created a workflow, changed model routing, or saved memory unless the corresponding tool result in this run proves it.',
    '- Keep talking first for ambiguous multi-step or external-write requests. Ask one steering question when the next action would commit the user to a workflow shape or external side effect.',
  ].join('\n');
}

export function renderClaudeAgentBrainSystemAppend(
  surface: ClaudeAgentBrainSurface,
  request: AssistantRequest,
  mode: ClaudeAgentBrainMode = claudeAgentSdkBrainMode() ?? 'read_only',
): string {
  const persistentContext = renderHarnessMemoryContext();
  return [
    'You are Clementine running as the main brain through the official Claude Agent SDK inside the Clementine harness.',
    'You are using the user\'s Claude subscription auth. Stay inside Clementine\'s product identity, memory, skills, workflows, and workspace expectations.',
    '',
    renderCapabilityBoundary(mode),
    '',
    `Surface: ${surface}`,
    `Session: ${request.sessionId}`,
    `Claude brain mode: ${mode}`,
    '',
    persistentContext,
    '',
    'Core Clementine operating rubric:',
    ORCHESTRATOR_INSTRUCTIONS,
  ].filter(Boolean).join('\n\n');
}

export async function respondViaClaudeAgentSdkBrain(
  surface: ClaudeAgentBrainSurface,
  request: AssistantRequest,
): Promise<AssistantResponse> {
  const sessionId = request.sessionId;
  const mode = claudeAgentSdkBrainMode() ?? 'read_only';
  if (!getSession(sessionId)) {
    const titleSeed = request.message.trim().replace(/\s+/g, ' ');
    createSession({
      id: sessionId,
      kind: 'chat',
      channel: request.channel,
      userId: request.userId,
      title: titleSeed.length > 80 ? `${titleSeed.slice(0, 77)}...` : titleSeed,
      metadata: { source: `claude-agent-sdk-brain:${surface}`, readOnly: mode === 'read_only', mode },
    });
  }

  try { clearKill(sessionId); } catch { /* best effort */ }

  if (request.shouldCancel && await request.shouldCancel()) {
    return {
      text: 'Run was cancelled.',
      sessionId,
      stoppedReason: 'cancelled',
      turnsUsed: 0,
    };
  }

  const modelId = request.model && request.model.startsWith('claude-')
    ? request.model
    : resolveRoleModel('brain').modelId;
  const result = await runClaudeAgentSdkImpl({
    prompt: request.message,
    sessionId,
    modelId,
    systemAppend: renderClaudeAgentBrainSystemAppend(surface, request, mode),
    allowedLocalMcpTools: allowedToolsForRequest(request, mode),
    maxTurns: maxTurns(),
  });

  const text = result.text.trim() || '(no reply produced)';
  if (request.onChunk) await request.onChunk(text);
  return {
    text,
    sessionId,
    stoppedReason: 'success',
    turnsUsed: result.toolUses.length > 0 ? result.toolUses.length : 1,
    raw: {
      transport: 'claude_agent_sdk_brain',
      mode,
      sessionId: result.sessionId,
      model: result.model,
      toolUses: result.toolUses,
      usage: result.usage,
      modelUsage: result.modelUsage,
    },
  };
}
