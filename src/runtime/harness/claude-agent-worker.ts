import { buildWorkerJobPrompt, type WorkerToolInput } from '../../agents/worker-job-packet.js';
import { getRuntimeEnv } from '../../config.js';
import {
  defaultClaudeAgentSdkAllowedLocalTools,
  runClaudeAgentSdk,
  type ClaudeAgentSdkRunOptions,
  type ClaudeAgentSdkRunResult,
} from './claude-agent-sdk.js';

type ClaudeAgentSdkRunFn = (options: ClaudeAgentSdkRunOptions) => Promise<ClaudeAgentSdkRunResult>;
let runClaudeAgentSdkImpl: ClaudeAgentSdkRunFn = runClaudeAgentSdk;

export function setClaudeAgentSdkWorkerRunForTest(fn: ClaudeAgentSdkRunFn | null): void {
  runClaudeAgentSdkImpl = fn ?? runClaudeAgentSdk;
}

function flagEnabled(): boolean {
  const raw = (getRuntimeEnv('CLEMMY_CLAUDE_AGENT_SDK_WORKER', 'on') ?? 'on').trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no');
}

export function claudeAgentSdkWorkerEnabled(modelId: string | undefined | null): boolean {
  return flagEnabled() && typeof modelId === 'string' && modelId.startsWith('claude-');
}

function maxTurns(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_CLAUDE_AGENT_SDK_WORKER_MAX_TURNS', '5') ?? '5', 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 5;
}

export function renderClaudeAgentWorkerSystemAppend(input: WorkerToolInput, agentic = false): string {
  const boundary = agentic
    ? [
        'Current capability — you CAN execute the gated tools for THIS item:',
        '- run_shell_command, composio discovery + composio_execute_tool, write_file, plus read/recall tools.',
        '- Every call runs through Clementine\'s safety gates; irreversible/external actions pause for the user\'s approval. The PARENT already opened the execution lane and the batch approval, so just do the item — do not call execution_create or request_approval yourself.',
        '- Do NOT claim a mutation happened unless the tool result proves it. If a tool result begins with `ERROR:`, return `ERROR: <reason>` for this item instead of fabricating completion.',
        '- If the packet names a skill, a style guide, or installed skill rules, call `skill_read` for it before producing the output.',
      ]
    : [
        'Current capability boundary:',
        '- This Claude SDK worker lane is READ-ONLY/local-context only.',
        '- You may use exposed Clementine MCP tools for memory, skill, profile, session, workspace, status, and read-only file/context lookup.',
        '- Do not claim you wrote files, ran shell commands, created workflows, sent messages, updated external systems, or performed any mutation unless this lane later exposes a guarded mutating tool and its tool result proves it.',
        '- If the packet requires a mutating or external-write action, return `ERROR: Claude SDK worker needs guarded mutating tool <tool/action>` rather than fabricating completion.',
        '- If the packet names a skill, a style guide, a taste/design skill, or says to use installed skill rules, call `skill_read` for that skill before producing the output.',
      ];
  return [
    'You are a Clementine Worker running through the official Claude Agent SDK under the user\'s Claude subscription auth.',
    'Your scope is ONE parent-planned item. Do exactly the packet, keep the result compact, and do not converse with the user.',
    '',
    ...boundary,
    '',
    `Worker item: ${input.item}`,
    input.intent ? `Worker intent: ${input.intent}` : '',
  ].filter(Boolean).join('\n');
}

export interface ClaudeAgentSdkWorkerResult {
  text: string;
  sdkSessionId?: string;
  model?: string;
  toolUses: string[];
  usage?: unknown;
  modelUsage?: unknown;
}

export async function runClaudeAgentSdkWorker(
  input: WorkerToolInput,
  modelId: string,
  sessionId?: string,
): Promise<ClaudeAgentSdkWorkerResult> {
  // Agentic only with the PARENT session id — the gates + plan-scope + execution
  // lane aggregate across the worker fan-out via the shared session (one batch
  // approval covers them all). Without a parent session, fall back to the
  // read-only worker (safe; mutations return ERROR rather than running ungated).
  const sid = sessionId?.trim();
  const agentic = Boolean(sid);
  const result = await runClaudeAgentSdkImpl({
    prompt: buildWorkerJobPrompt(input),
    sessionId: sid,
    modelId,
    systemAppend: renderClaudeAgentWorkerSystemAppend(input, agentic),
    allowedLocalMcpTools: defaultClaudeAgentSdkAllowedLocalTools(agentic ? 'worker' : 'read_only'),
    agentic,
    maxTurns: maxTurns(),
  });
  return {
    text: result.text.trim() || 'ERROR: Claude SDK worker produced no output.',
    sdkSessionId: result.sessionId,
    model: result.model,
    toolUses: result.toolUses,
    usage: result.usage,
    modelUsage: result.modelUsage,
  };
}
