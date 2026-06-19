import { renderHarnessMemoryContext } from '../../agents/harness-context.js';
import { CLAUDE_BRAIN_RUBRIC } from '../../agents/clem-rubric.js';
import { resolveToolJitDecision, selectToolsForTurn } from '../../agents/tool-jit.js';
import { getCoreToolsAsync } from '../../tools/registry.js';
import { getActiveAuthMode, getRuntimeEnv } from '../../config.js';
import type { AssistantRequest, AssistantResponse } from '../../types.js';
import { appendEvent, clearKill, createSession, getSession } from './eventlog.js';
import { actionBus } from '../action-bus.js';
import {
  judgeObjectiveComplete,
  composeJudgedObjective,
  isPromiseShapedReply,
  type ObjectiveJudgeFn,
} from './objective-judge.js';
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

let judgeImpl: ObjectiveJudgeFn = judgeObjectiveComplete;
export function setClaudeAgentSdkBrainJudgeForTest(fn: ObjectiveJudgeFn | null): void {
  judgeImpl = fn ?? judgeObjectiveComplete;
}

/** Completion-judge kill-switch (default ON). Off ⇒ the SDK brain trusts its own
 *  "done" (legacy). On ⇒ parity with the harness loop's objective judge. */
function completionJudgeEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}
function narrationRetryEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CLAUDE_SDK_NARRATION_RETRY', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

/** Detect the "narrate-instead-of-call" failure: the brain produced NO real tool
 *  calls, but its text reproduces the tool-call protocol — a `Tool: <name>` line,
 *  a `function { … }` block, a fabricated `System: tool result …`, or a bare
 *  `{"command": …}` payload. That means it DESCRIBED a tool call instead of making
 *  one, so nothing actually ran. */
export function looksLikeToolNarration(text: string, toolUses: string[]): boolean {
  if (toolUses.length > 0) return false;
  const t = (text || '').trim();
  if (!t) return false;
  return (
    /(^|\n)\s*Tool:\s*[a-z_][a-z0-9_]*/i.test(t) ||
    /(^|\n)\s*function\s*\n?\s*\{/.test(t) ||
    /System:\s*tool result/i.test(t) ||
    /(^|\n)\s*\{\s*"command"\s*:/.test(t)
  );
}
function judgeMaxContinuations(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_CLAUDE_SDK_JUDGE_MAX_CONTINUATIONS', '1') ?? '1', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1;
}

export type ClaudeAgentBrainSurface = 'webhook' | 'cli' | 'dashboard' | 'home' | 'discord';
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
  return surface === 'webhook' || surface === 'cli' || surface === 'dashboard' || surface === 'home' || surface === 'discord';
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

// The lean CLAUDE_BRAIN_RUBRIC now lives in ../../agents/clem-rubric.ts (Phase 3 —
// one shared rubric source for both flagship lanes). Imported above. Rationale for
// why this lane is LEAN (vs the 34KB Codex rubric) is documented at its definition
// and in the narrate-instead-of-call history; runtime safety is enforced in CODE at
// the tool boundary, not in this prose.

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
    'How you operate here:',
    CLAUDE_BRAIN_RUBRIC,
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

  // Record the user's turn so the SDK brain is a proper session citizen: the
  // workflow-run boundary guard, session history, recall, and report-back all
  // read `user_input_received`. Without it the brain's tools (e.g. workflow_run)
  // can't see what the user actually asked for.
  try {
    appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: request.message } });
  } catch { /* best effort — never block the turn */ }

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

  // JIT tool-RAG for the Claude Agent SDK brain (Phase 1, Claude-brain port). The
  // brain runs the SAME decision as the Codex lane (resolveToolJitDecision — global
  // flag OR the per-session A/B arm). When active, retrieve only the tools this turn
  // plausibly needs (CORE + semantic top-K of the profile tools) and advertise ONLY
  // those on the MCP surface, so the model receives fewer tool schemas. Brain lanes
  // are interactive (a user is present), so allowLane=true. Off / no-signal / no
  // embeddings → the full profile (byte-identical). Never throws into the turn.
  const fullAllowed = allowedToolsForRequest(request, mode);
  const jitDecision = resolveToolJitDecision({ allowLane: true, sessionId });
  let jitAllowed = fullAllowed;
  let mcpToolAllowlist: string[] | undefined;
  let jitDropped = 0;
  let jitReason = jitDecision.active ? 'jit-active-no-reduction' : 'jit-inactive';
  if (jitDecision.active && request.message.trim()) {
    try {
      const core = await getCoreToolsAsync({ includeDynamicComposioTools: false });
      const descByName = new Map(
        core.map((t) => [(t as { name?: string }).name ?? '', (t as { description?: string }).description ?? '']),
      );
      const selection = await selectToolsForTurn({
        userInput: request.message,
        tools: fullAllowed.map((name) => ({ name, description: descByName.get(name) ?? '' })),
      });
      jitReason = selection.reason;
      if (selection.reduced) {
        jitAllowed = fullAllowed.filter((n) => selection.exposed.has(n));
        mcpToolAllowlist = jitAllowed;
        jitDropped = fullAllowed.length - jitAllowed.length;
      }
    } catch {
      jitAllowed = fullAllowed; mcpToolAllowlist = undefined; jitReason = 'jit-error-fellback';
    }
  }
  // Telemetry — emit on a real reduction OR whenever the A/B is running (so the
  // control arm is attributable too). Tagged lane:'claude_sdk' to distinguish from
  // the Codex orchestrator lane in the readout.
  if (sessionId && (jitDropped > 0 || jitDecision.experiment)) {
    try {
      appendEvent({
        sessionId, turn: 0, role: 'system', type: 'tool_jit_scope',
        data: {
          lane: 'claude_sdk', arm: jitDecision.arm, experiment: jitDecision.experiment,
          jitActive: jitDecision.active, droppedCount: jitDropped, exposedCount: jitAllowed.length, reason: jitReason,
        },
      });
    } catch { /* JIT telemetry must never block the turn */ }
  }

  const runOptions = {
    sessionId,
    modelId,
    systemAppend: renderClaudeAgentBrainSystemAppend(surface, request, mode),
    allowedLocalMcpTools: jitAllowed,
    mcpToolAllowlist,
    agentic: mode === 'full',
    maxTurns: maxTurns(),
  };
  let result = await runClaudeAgentSdkImpl({ prompt: request.message, ...runOptions });

  // Narrate-instead-of-call backstop (defense-in-depth; the lean rubric prevents
  // most of it). If the brain made NO real tool calls but its text reproduces the
  // tool-call protocol, it described a call instead of making one — retry ONCE
  // with a hard nudge to actually invoke the tool. Kill-switch
  // CLEMMY_CLAUDE_SDK_NARRATION_RETRY.
  if (mode === 'full' && narrationRetryEnabled() && looksLikeToolNarration(result.text, result.toolUses)) {
    const retry = await runClaudeAgentSdkImpl({
      prompt:
        `Your previous attempt WROTE OUT a tool call as text (e.g. "Tool: …", "function { … }", a fake "System: tool result …") instead of running it — so nothing actually happened. ` +
        `Do NOT describe tools. INVOKE the real tool now to do this: "${request.message}". Then reply with the actual result.`,
      ...runOptions,
    });
    result = { ...retry, toolUses: [...result.toolUses, ...retry.toolUses] };
  }

  // Objective-completion judge (parity with the harness loop): on an agentic
  // action turn that produced a reply, verify the objective is actually
  // satisfied with evidence — not just claimed ("I sent the emails" with no
  // artifact). On a "not done" verdict, do ONE bounded continuation. Fail-open
  // (a judge error ⇒ treat as done; never wedge). Kill-switch
  // CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE.
  if (
    completionJudgeEnabled() &&
    mode === 'full' &&
    !result.limitHit &&
    (result.toolUses.length > 0 || isPromiseShapedReply(result.text))
  ) {
    const objective = composeJudgedObjective(request.message, []);
    const maxCont = judgeMaxContinuations();
    for (let i = 0; i < maxCont; i += 1) {
      let done = true;
      let reason = '';
      try {
        const verdict = await judgeImpl(objective, result.text || '');
        done = verdict.done;
        reason = verdict.reason;
      } catch { break; } // fail-open — a flaky judge must never wedge the turn
      if (done) break;
      const contResult = await runClaudeAgentSdkImpl({
        prompt:
          `Your previous attempt did NOT fully satisfy the request. Judge feedback: "${reason}". ` +
          `Original request: "${request.message}". Continue now and FINISH it — produce the concrete ` +
          `artifact/evidence (file, sheet row, message, link, real result); do not just describe or promise it.`,
        ...runOptions,
      });
      result = { ...contResult, toolUses: [...result.toolUses, ...contResult.toolUses] };
      if (contResult.limitHit) break;
    }
  }

  const text = result.text.trim() || '(no reply produced)';
  if (request.onChunk) await request.onChunk(text);
  // Long-running parity: a turn-budget stop surfaces as a graceful
  // "say continue", not a failure (claude-agent-sdk.ts returns limitHit).
  const stoppedReason: AssistantResponse['stoppedReason'] = result.limitHit ? 'max-turns-with-grace' : 'success';
  // Report-back / observability parity (gap analysis): the harness loop emits
  // conversation_completed + runtime.completed on a clean terminal so the Tasks
  // board, report-back, and watchdog see the run. The Agent SDK lane runs its
  // own loop, so emit the same terminal events here.
  try {
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type: 'conversation_completed',
      data: {
        reason: result.limitHit ? 'limit_exceeded' : 'claude_agent_sdk_brain',
        summary: text.slice(0, 400),
        reply: text,
      },
    });
  } catch { /* telemetry best-effort — never block the reply */ }
  try { actionBus.emit({ kind: 'runtime.completed', sessionId }); } catch { /* best-effort */ }
  return {
    text,
    sessionId,
    stoppedReason,
    turnsUsed: result.toolUses.length > 0 ? result.toolUses.length : 1,
    raw: {
      transport: 'claude_agent_sdk_brain',
      mode,
      sessionId: result.sessionId,
      model: result.model,
      toolUses: result.toolUses,
      usage: result.usage,
      modelUsage: result.modelUsage,
      limitHit: result.limitHit ?? false,
    },
  };
}
