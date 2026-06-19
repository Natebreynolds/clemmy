import { renderHarnessMemoryContext } from '../../agents/harness-context.js';
import { ORCHESTRATOR_BEHAVIOR_NATIVE } from '../../agents/orchestrator.js';
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
export type ClaudeAgentBrainMode = 'read_only' | 'local_authoring' | 'full';

function configuredMode(): ClaudeAgentBrainMode | null {
  const raw = (getRuntimeEnv('CLEMMY_CLAUDE_AGENT_SDK_BRAIN', 'off') ?? 'off').trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') return null;
  if (raw === 'read_only' || raw === 'readonly') return 'read_only';
  // Full agentic: Claude executes gated tools (shell/composio/sends) under the
  // approval gate. (Step 5 will make this the default for claude_oauth.)
  if (raw === 'full' || raw === 'agentic' || raw === 'all') return 'full';
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
  // Each SDK "turn" is one assistant message (which may carry tool calls). Real
  // agentic work needs headroom: a single gated send alone is execution_create →
  // composio_execute_tool → execution_complete → final (~5 turns), and a
  // multi-step read/transform/report is more. The old default of 6 starved
  // legitimate flows — they hit the cap mid-task, returned a hard "Reached
  // maximum number of turns" error, and the brain thrashed (retrying the same
  // send) trying to finish in time. The loop-guard + duplicate-write gates bound
  // any runaway, so a generous cap is safe.
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_CLAUDE_AGENT_SDK_BRAIN_MAX_TURNS', '24') ?? '24', 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 24;
}

function toolProfileForMode(mode: ClaudeAgentBrainMode): ClaudeAgentSdkToolProfile {
  if (mode === 'full') return 'full';
  if (mode === 'local_authoring') return 'local_authoring';
  return 'read_only';
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
  if (mode === 'full') {
    return [
      'CAPABILITY — you are the AGENTIC Clementine brain on the user\'s Claude subscription. You CAN execute tools to complete the request: run shell commands (run_shell_command), discover + execute Composio actions (composio_search_tools → composio_execute_tool), write files, and chain multi-step work — exactly like the Codex harness.',
      '- Every tool call runs through Clementine\'s safety gates (grounding, goal-fidelity, execution-wrap, destination, duplicate-write, loop-guard). Irreversible/external actions (sends, batch external writes) PAUSE for the user\'s approval BEFORE they run. Do the work — the gates + approval protect it; you do not need to ask permission in prose first.',
      '- Before a MUTATING external write (a composio send/create, a batch), call execution_create FIRST (title, objective, successCriteria), then proceed — the harness requires an active execution lane for those.',
      '- A large tool result may be clipped with a `[digest: … tool_output_query("call_…")]` footer — call tool_output_query or recall_tool_result to pull the records. Never report stored data as unavailable.',
      '- Do NOT claim you ran a command, sent a message, or wrote a file unless a tool result in THIS run proves it. If a tool result begins with `ERROR:`, treat that item as failed and say so.',
      '- If an installed skill applies (design/report/audit), call skill_read for it before producing the artifact.',
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
    'HOW YOU OPERATE HERE — you are a native tool-calling agent. When the work needs a tool, CALL it directly and let the result come back, then reply to the user in plain language once the work is done. There is no decision JSON, output schema, or reply/done/nextAction envelope to produce on this lane — just do the work with real tool calls and answer naturally.',
    '',
    'Core Clementine operating rubric:',
    ORCHESTRATOR_BEHAVIOR_NATIVE,
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
    agentic: mode === 'full',
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
