import { renderHarnessMemoryContext } from '../../agents/harness-context.js';
import { CLAUDE_BRAIN_RUBRIC } from '../../agents/clem-rubric.js';
import { resolveToolJitDecision, selectToolsForTurn } from '../../agents/tool-jit.js';
import {
  buildWorkspaceContextPrimer, workspaceSlugFromSessionId, WORKSPACE_DOCK_TOOLS,
} from '../../spaces/workspace-context.js';
import { getCoreToolsAsync } from '../../tools/registry.js';
import { getActiveAuthMode, getRuntimeEnv } from '../../config.js';
import type { AssistantRequest, AssistantResponse } from '../../types.js';
import { appendEvent, clearKill, createSession, getSession, listEvents, openEventLog } from './eventlog.js';
import { pullRecentTurnsForSession } from './session-transcript.js';
import { actionBus } from '../action-bus.js';
import {
  judgeObjectiveComplete,
  composeJudgedObjective,
  isPromiseShapedReply,
  type SkillExecutionContext,
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
function sessionHistoryEnabled(): boolean {
  // Inject the session's prior turns into the Claude brain prompt so multi-turn
  // chat works (the SDK lane is stateless: persistSession:false). Kill-switch
  // CLEMMY_CLAUDE_SDK_SESSION_HISTORY=off → byte-identical bare-message prompt.
  return (getRuntimeEnv('CLEMMY_CLAUDE_SDK_SESSION_HISTORY', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}
export function sdkStreamingEnabled(): boolean {
  // DEFAULT OFF: raw SDK text deltas reproduce the model's tool-call XML
  // narration, which dumped into the dock bubble (live 2026-06-23). Clean live
  // progress now comes from tool_called events (parity with the Codex lane); the
  // full reply still delivers once via the final onChunk. Opt back into raw token
  // streaming with CLEMMY_CLAUDE_SDK_STREAMING=on.
  const raw = (getRuntimeEnv('CLEMMY_CLAUDE_SDK_STREAMING', 'off') ?? 'off').trim().toLowerCase();
  return raw === 'on' || raw === 'true' || raw === '1';
}
function narrationRetryEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CLAUDE_SDK_NARRATION_RETRY', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

function renderLimitHitReply(text: string): string {
  const base = text.trim() || 'I reached the turn budget before finishing.';
  if (/\bcontinue\b/i.test(base)) return base;
  return `${base}\n\nI hit the turn budget before finishing. Say "continue" and I will pick up where I left off.`;
}

function finalChunkDelta(text: string, streamedText: string, streamedAny: boolean): string | null {
  if (!text) return null;
  if (!streamedAny) return text;
  if (streamedText === text || streamedText.trim() === text.trim()) return null;
  if (text.startsWith(streamedText)) return text.slice(streamedText.length);
  if (streamedText.endsWith(text) || streamedText.trim().endsWith(text.trim())) return null;
  return `\n\n${text}`;
}

/** Detect the "narrate-instead-of-call" failure: the brain produced NO real tool
 *  calls, but its text reproduces the tool-call PROTOCOL in any of the shapes
 *  models reach for instead of actually invoking — a `Tool:`/`Tool call:` header
 *  (incl. markdown-bolded `**Tool call: x**`), a tagged `<tool_call>`/`[tool_call]`,
 *  a `function { … }` block, a fabricated `System: tool result …`, a bare
 *  tool-call-shaped JSON payload, OR the native tool-call XML
 *  (`<invoke name="…">` / `<parameter name="…">`, incl. `antml:` variants).
 *  Two REAL failures fed this: 2026-06-22 a Workspace build printed
 *  `<invoke name="run_shell_command">…</invoke>`; 2026-06-23 a dock turn (mode=full,
 *  42 tools exposed) printed `**Tool call: skill_read**` + a ```json args block.
 *  Detect the CLASS, not one format. Headers are line-anchored so a mid-sentence
 *  "…what each tool call does…" never trips it. */
export function looksLikeToolNarration(text: string, toolUses: string[]): boolean {
  if (toolUses.length > 0) return false;
  const t = (text || '').trim();
  if (!t) return false;
  return (
    // "Tool: x", "Tool call: x", "**Tool call: x**", "Tool_call: x" at line start.
    /(^|\n)\s*\*{0,2}\s*tool(?:[\s_-]*call)?\s*:\s*\*{0,2}\s*[a-z_"]/i.test(t) ||
    // Tagged markers some models emit: "<tool_call>", "[tool_call]".
    /(^|\n)\s*[<\[]\s*tool[\s_-]*call\b/i.test(t) ||
    /(^|\n)\s*function\s*\n?\s*\{/.test(t) ||
    /System:\s*tool result/i.test(t) ||
    // A bare tool-call-shaped JSON payload (command / tool_slug / tool_name / arguments).
    /(^|\n)\s*\{\s*"(command|tool_slug|tool_name|arguments)"\s*:/i.test(t) ||
    /<\/?(?:antml:)?(?:function_calls\b|invoke\s+name\s*=|parameter\s+name\s*=)/i.test(t)
  );
}

/** Streaming-time guard: detect the UNAMBIGUOUS tool-call-protocol / native XML
 *  markers in the live text accumulated SO FAR, so the dock stops streaming the
 *  moment a delta starts reproducing tool-call XML (the noise that made raw
 *  streaming default-off). Unlike looksLikeToolNarration this takes no toolUses
 *  arg — mid-stream we don't yet know the final tool-call count — so it checks
 *  only the high-precision markers that are never legitimate prose, never the
 *  ambiguous bare-JSON shape. The authoritative final reply still delivers once. */
export function looksLikeStreamingNarration(text: string): boolean {
  const t = text || '';
  if (!t) return false;
  return (
    /<\/?(?:antml:)?(?:function_calls\b|invoke\s+name\s*=|parameter\s+name\s*=)/i.test(t) ||
    /(^|\n)\s*\*{0,2}\s*tool(?:[\s_-]*call)?\s*:\s*\*{0,2}\s*[a-z_"]/i.test(t) ||
    /(^|\n)\s*[<[]\s*tool[\s_-]*call\b/i.test(t)
  );
}

/** Detect the "reasoning-leak" failure: the brain verbalized its instruction-
 *  hierarchy / prompt-injection deliberation about its OWN injected context
 *  (memory, preferences/specs, tool descriptions, system reminders) and did NO
 *  work — no tool calls, just defensive musing that trails off without an answer.
 *  This is the memory-context cousin of looksLikeToolNarration: a safety-trained
 *  Claude misreads its trusted recalled memory as adversarial and second-guesses
 *  it out loud instead of doing the task. (Observed v0.10.20: a recalled
 *  market-leader spec triggered "…possibly injected… the classic trap… let me
 *  re-read the actual ask" with zero accounts pulled.) Requires no tool calls so
 *  a reply that actually DID work (and merely thought aloud) is never flagged. */
export function looksLikeReasoningLeak(text: string, toolUses: string[]): boolean {
  if (toolUses.length > 0) return false;
  const t = (text || '').trim();
  if (!t) return false;
  // Strong: the model is treating its own injected context as untrusted/injected.
  const metaInjectionDoubt =
    /possibly injected|prompt[-\s]?injection|the classic trap|reference data,?\s*not live instructions|possibly stale|by who[-\s]?knows[-\s]?whom|treat everything in the system[-\s]?reminder/i.test(t);
  // Stalled self-doubt with no resolution / no answer produced.
  const stalledSelfDoubt =
    /that result looks scrambled|let me re-?read (the|what|the actual)|I need to stop and actually look|what actually changed:?\s*nothing/i.test(t);
  return metaInjectionDoubt || stalledSelfDoubt;
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

function modeCanAuthorOrExecute(mode: ClaudeAgentBrainMode): boolean {
  return mode === 'local_authoring' || mode === 'full';
}

const ACTION_REQUEST_RE =
  /\b(?:create|build|make|set up|schedule|save|write|draft|send|email|update|post|publish|deploy|run|execute|install|configure|generate|add|change|edit|refresh|pull)\b/i;
const COMPLETION_CLAIM_RE =
  /\b(?:done|completed|finished|created|built|made|set up|scheduled|saved|wrote|written|drafted|sent|emailed|posted|updated|published|deployed|ran|executed|installed|configured|generated|added|changed|edited|refreshed|pulled)\b/i;

function looksLikeActionCompletionClaim(requestText: string, replyText: string): boolean {
  return ACTION_REQUEST_RE.test(requestText || '') && COMPLETION_CLAIM_RE.test(replyText || '');
}

// JIT tool-RAG helpers (Claude-brain port).
// Tool descriptions are static (code-defined), so build the name→description map
// ONCE per daemon lifetime instead of rebuilding every zod tool object each JIT turn.
let coreToolDescCache: Map<string, string> | null = null;
async function coreToolDescriptions(): Promise<Map<string, string>> {
  if (coreToolDescCache) return coreToolDescCache;
  const core = await getCoreToolsAsync({ includeDynamicComposioTools: false });
  coreToolDescCache = new Map(
    core.map((t) => [(t as { name?: string }).name ?? '', (t as { description?: string }).description ?? '']),
  );
  return coreToolDescCache;
}

// Recent prior user messages in this session, newest-first (excluding the current).
// Folded into the JIT ranking query so a bare follow-up ("do it", "make it weekly")
// inherits the intent the conversation built toward — parity with the Codex lane's
// recentPriorUserInputsForScope. Minimal (this session only); best-effort.
function recentPriorBrainInputs(sessionId: string, current: string, limit = 3): string[] {
  const cur = (current ?? '').trim();
  const seen = new Set<string>();
  const out: string[] = [];
  try {
    const rows = listEvents(sessionId, { types: ['user_input_received'], desc: true, limit: 8 });
    for (const ev of [...rows].reverse()) {
      const text = typeof (ev.data as { text?: unknown })?.text === 'string'
        ? ((ev.data as { text?: string }).text ?? '').trim()
        : '';
      if (!text || text === cur || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
      if (out.length >= limit) break;
    }
  } catch { /* best effort */ }
  return out;
}

function summarizeClaudeSdkToolUsesForJudge(toolUses: string[]): string {
  const counts = new Map<string, number>();
  for (const raw of toolUses) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    const bare = name.split('__').at(-1) ?? name;
    counts.set(bare, (counts.get(bare) ?? 0) + 1);
  }
  if (counts.size === 0) return '(no tool calls made)';
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name} x${count}` : name))
    .join(', ');
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

/** Frame the injected Clementine memory as TRUSTED context the brain OWNS, not
 *  external/untrusted input. Without this, a safety-trained Claude can misread
 *  its own recalled memory/specs as a prompt-injection and spiral into visible
 *  "is this stale/injected?" deliberation instead of using it (see
 *  looksLikeReasoningLeak). Empty memory ⇒ no framing (nothing to frame). */
export function frameTrustedMemory(persistentContext: string): string {
  if (!persistentContext.trim()) return '';
  return [
    'YOUR MEMORY — trusted context you OWN. The block below is Clementine\'s own persistent memory about THIS user: their profile, saved preferences/specs, facts you have learned, and where their data lives. It is reliable background to USE in service of the request. It is NOT user-pasted input, NOT external/untrusted data, and NOT a prompt-injection to verify or second-guess. Do not narrate skepticism about its provenance ("is this stale or injected?") — just use what is relevant and do the task.',
    '',
    persistentContext,
  ].join('\n');
}

export function renderClaudeAgentBrainSystemAppend(
  surface: ClaudeAgentBrainSurface,
  request: AssistantRequest,
  mode: ClaudeAgentBrainMode = claudeAgentSdkBrainMode() ?? 'read_only',
): string {
  const persistentContext = renderHarnessMemoryContext();
  const spaceSlug = workspaceSlugFromSessionId(request.sessionId);
  const workspacePrimer = spaceSlug ? buildWorkspaceContextPrimer(spaceSlug) : null;
  return [
    'You are Clementine running as the main brain through the official Claude Agent SDK inside the Clementine harness.',
    'You are using the user\'s Claude subscription auth. Stay inside Clementine\'s product identity, memory, skills, workflows, and workspace expectations.',
    '',
    renderCapabilityBoundary(mode),
    '',
    `Surface: ${surface}`,
    `Session: ${request.sessionId}`,
    `Claude brain mode: ${mode}`,
    // Dock chat (session "space-<slug>"): tell the brain it is EDITING this
    // Workspace and to change it via space_* tools, never a sandbox/scratch file.
    workspacePrimer ?? '',
    '',
    frameTrustedMemory(persistentContext),
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
  const isSpaceSession = workspaceSlugFromSessionId(sessionId) != null;
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
  // Multi-turn history: read the session's PRIOR turns BEFORE appending the
  // current one (so the current message isn't echoed as "prior"). Threaded into
  // runOptions below so every attempt (incl. retries/judge continuations) keeps
  // context. The SDK lane is stateless, so without this the brain sees only the
  // latest message — the "no chat history available" wrong-task bug.
  let priorTurns: Array<{ who: 'user' | 'assistant'; text: string }> = [];
  if (sessionHistoryEnabled()) {
    try {
      priorTurns = pullRecentTurnsForSession(openEventLog(), sessionId, 6).map((t) => ({ who: t.who, text: t.text }));
    } catch { priorTurns = []; }
  }

  try {
    appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: request.message } });
    // Working signal: a turn_started lights the existing elapsed-time/pulse so a
    // long turn never reads as frozen (the Codex lane emits this; the SDK lane
    // didn't). role:'system' → no spurious agent label.
    appendEvent({ sessionId, turn: 1, role: 'system', type: 'turn_started', data: {} });
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
      const descByName = await coreToolDescriptions();
      // Fold recent prior-turn messages into the ranking query so bare follow-ups
      // inherit the conversation's intent (parity with the Codex lane).
      const jitQuery = [request.message, ...recentPriorBrainInputs(sessionId, request.message)]
        .filter((s) => s.trim().length > 0)
        .join('\n');
      const selection = await selectToolsForTurn({
        userInput: jitQuery,
        tools: fullAllowed.map((name) => ({ name, description: descByName.get(name) ?? '' })),
      });
      // H1c: a dock chat IS editing a Workspace — pin the space tools so the JIT
      // never drops them (else the model can't persist the edit and sandboxes it).
      if (isSpaceSession) {
        for (const t of WORKSPACE_DOCK_TOOLS) if (fullAllowed.includes(t)) selection.exposed.add(t);
      }
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

  // Streaming: forward each SDK text delta to the caller's onChunk so a long turn
  // shows live progress (the SDK lane was silent — includePartialMessages off). The
  // final reply still renders authoritatively (Discord: the conversation_completed
  // event; desktop: the guarded final onChunk below) — streaming can't garble it.
  let streamedAny = false;
  let streamedText = '';
  // Once the live text starts reproducing tool-call XML/protocol (the
  // narrate-instead-of-call failure), stop forwarding deltas for the rest of the
  // turn so the dock never shows that noise. streamedAny/streamedText track only
  // what was ACTUALLY shown, so a turn that ONLY narrated still streams its clean
  // narration-retry answer and the final reply delivers authoritatively.
  let narrationStream = false;
  const runOptions = {
    sessionId,
    modelId,
    systemAppend: renderClaudeAgentBrainSystemAppend(surface, request, mode),
    allowedLocalMcpTools: jitAllowed,
    mcpToolAllowlist,
    agentic: mode === 'full',
    maxTurns: maxTurns(),
    priorTurns,
    onDelta: (request.onChunk && sdkStreamingEnabled())
      ? async (d: string): Promise<void> => {
        if (narrationStream) return;
        const candidate = streamedText + d;
        if (looksLikeStreamingNarration(candidate)) { narrationStream = true; return; }
        streamedText = candidate;
        streamedAny = true;
        await request.onChunk?.(d);
      }
      : undefined,
  };
  const cleanContinuationRunOptions = (): typeof runOptions => {
    // If an earlier attempt already streamed visible text, do not stream raw
    // retry/judge-continuation deltas into the same bubble. The guarded final
    // chunk below will append the authoritative corrected answer once.
    if (streamedAny) return { ...runOptions, onDelta: undefined };
    return runOptions;
  };
  let result = await runClaudeAgentSdkImpl({ prompt: request.message, ...runOptions });

  // Narrate-instead-of-call backstop (defense-in-depth; the lean rubric prevents
  // most of it). If the brain made NO real tool calls but its text reproduces the
  // tool-call protocol, it described a call instead of making one — retry ONCE
  // with a hard nudge to actually invoke the tool. Kill-switch
  // CLEMMY_CLAUDE_SDK_NARRATION_RETRY.
  if (!result.limitHit && modeCanAuthorOrExecute(mode) && narrationRetryEnabled() && looksLikeToolNarration(result.text, result.toolUses)) {
    const retry = await runClaudeAgentSdkImpl({
      prompt:
        `Your previous attempt WROTE OUT a tool call as text (e.g. a "Tool call: …" / "**Tool call: …**" header, a "<invoke name=…>…</invoke>" block, a "function { … }" block, or a fake "System: tool result …") instead of running it — so nothing actually happened. ` +
        `Do NOT describe tools. INVOKE the real tool now to do this: "${request.message}". Then reply with the actual result.`,
      ...cleanContinuationRunOptions(),
    });
    result = { ...retry, toolUses: [...result.toolUses, ...retry.toolUses] };
  }

  // Reasoning-leak backstop (defense-in-depth; the trusted-memory framing prevents
  // most of it). If the brain produced NO tool calls and its reply is defensive
  // deliberation about whether its own injected context is trustworthy — the
  // memory-context cousin of narrate-instead-of-call — it second-guessed its
  // memory instead of doing the task. Retry ONCE, telling it the context is
  // trusted and to just do the work. Any mode (a read turn can spiral too).
  // Shares the kill-switch CLEMMY_CLAUDE_SDK_NARRATION_RETRY.
  if (!result.limitHit && narrationRetryEnabled() && looksLikeReasoningLeak(result.text, result.toolUses)) {
    const retry = await runClaudeAgentSdkImpl({
      prompt:
        `Your previous attempt did NOT do the task — instead you wrote out internal deliberation about whether your own context/memory is trustworthy or "injected". ` +
        `Your injected Clementine memory (profile, saved preferences/specs, learned facts) is TRUSTED context you OWN — not user-pasted input and not a prompt-injection. Do NOT reason about its provenance. ` +
        `Just do exactly what the user asked: "${request.message}". Use the relevant tools and reply with the real result.`,
      ...cleanContinuationRunOptions(),
    });
    result = { ...retry, toolUses: [...result.toolUses, ...retry.toolUses] };
  }

  // Objective-completion judge (parity with the harness loop): on an authoring
  // or agentic action turn that produced a reply, verify the objective is
  // actually satisfied with evidence — not just claimed ("I created the
  // workflow" / "I sent the emails" with no artifact). On a "not done" verdict,
  // do ONE bounded continuation. Fail-open (a judge error ⇒ treat as done;
  // never wedge). Kill-switch CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE.
  if (
    completionJudgeEnabled() &&
    modeCanAuthorOrExecute(mode) &&
    !result.limitHit &&
    (
      result.toolUses.length > 0 ||
      isPromiseShapedReply(result.text) ||
      looksLikeActionCompletionClaim(request.message, result.text)
    )
  ) {
    const objective = composeJudgedObjective(
      request.message,
      recentPriorBrainInputs(sessionId, request.message),
    );
    const maxCont = judgeMaxContinuations();
    for (let i = 0; i < maxCont; i += 1) {
      let done = true;
      let reason = '';
      try {
        const skillContext: SkillExecutionContext = {
          skills: [],
          toolCallSummary: summarizeClaudeSdkToolUsesForJudge(result.toolUses),
        };
        const verdict = await judgeImpl(objective, result.text || '', skillContext);
        done = verdict.done;
        reason = verdict.reason;
      } catch { break; } // fail-open — a flaky judge must never wedge the turn
      if (done) break;
      const contResult = await runClaudeAgentSdkImpl({
        prompt:
          `Your previous attempt did NOT fully satisfy the request. Judge feedback: "${reason}". ` +
          `Original request: "${request.message}". Continue now and FINISH it — produce the concrete ` +
          `artifact/evidence (file, sheet row, message, link, real result); do not just describe or promise it.`,
        ...cleanContinuationRunOptions(),
      });
      result = { ...contResult, toolUses: [...result.toolUses, ...contResult.toolUses] };
      if (contResult.limitHit) break;
    }
  }

  const text = result.limitHit
    ? renderLimitHitReply(result.text)
    : (result.text.trim() || '(no reply produced)');
  // Deliver only the missing final chunk. If the exact final already streamed,
  // avoid a double-render. If a judge/retry replaced the answer, append the
  // authoritative final reply so direct callers are not left with stale partial
  // text while SSE/Discord still settle via conversation_completed.
  const finalDelta = finalChunkDelta(text, streamedText, streamedAny);
  if (request.onChunk && finalDelta) await request.onChunk(finalDelta);
  // Long-running parity: a turn-budget stop surfaces as a graceful
  // "say continue", not a failure (claude-agent-sdk.ts returns limitHit).
  const stoppedReason: AssistantResponse['stoppedReason'] = result.limitHit ? 'max-turns-with-grace' : 'success';
  // Report-back / observability parity (gap analysis): the harness loop emits
  // conversation_completed + runtime.completed on a clean terminal so the Tasks
  // board, report-back, and watchdog see the run. The Agent SDK lane runs its
  // own loop, so emit the same terminal events here. A turn-budget stop is NOT
  // a clean completion: emit limit telemetry first, then the user-facing
  // conversation_completed continue prompt, matching the main harness loop.
  try {
    if (result.limitHit) {
      appendEvent({
        sessionId,
        turn: 0,
        role: 'system',
        type: 'conversation_limit_exceeded',
        data: { reason: 'max_turns', maxTurns: maxTurns(), transport: 'claude_agent_sdk_brain' },
      });
    }
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type: 'conversation_completed',
      data: {
        reason: result.limitHit ? 'awaiting_continue' : 'claude_agent_sdk_brain',
        summary: text.slice(0, 400),
        reply: text,
        ...(result.limitHit ? { transport: 'claude_agent_sdk_brain', maxTurns: maxTurns() } : {}),
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
