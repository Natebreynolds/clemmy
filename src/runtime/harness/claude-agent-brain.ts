import { renderCanonicalMemoryContext } from './canonical-context.js';
import { CLAUDE_BRAIN_RUBRIC } from '../../agents/clem-rubric.js';
import { codeModeMandateDirective } from '../../tools/code-mode-tool.js';
import { getComposio } from '../../integrations/composio/client.js';
import { resolveToolJitDecision, selectToolsForTurn, recallPinnedBuiltinTools } from '../../agents/tool-jit.js';
import {
  buildWorkspaceContextPrimer, workspaceSlugFromSessionId, WORKSPACE_DOCK_TOOLS,
} from '../../spaces/workspace-context.js';
import { getCoreToolsAsync } from '../../tools/registry.js';
import { getActiveAuthMode, getRuntimeEnv } from '../../config.js';
import { isUnparseableToolCallError } from '../../execution/transient-error.js';
import { captureInteractionSignals } from '../../memory/auto-capture.js';
import { refreshWorkingMemoryForSession } from '../../memory/working-memory.js';
import { isUserFacingSession } from '../../execution/scope.js';
import { searchFactsHybrid } from '../../memory/facts.js';
import { recallMemory } from '../../memory/recall-memory.js';
import { isTemporalMeetingQuery } from '../../memory/recall.js';
import { crossStoreBreadcrumbs } from '../../memory/unified-recall.js';
import { scheduleRecallShadow } from '../../memory/recall-shadow.js';
import { _setUnifiedTurnPrimerRecallForTest, buildUnifiedTurnPrimer } from '../../memory/turn-primer.js';
import { autoCreditRecallRuns } from '../../memory/recall-auto-credit.js';
import { runTokenBudgetEnforcementEnabled } from './run-token-budget.js';
import {
  appendTerminalEventOnce,
  beginRunAttempt,
  clearKill,
  createSession,
  findUserInputEventForRun,
  getRunAttemptSourceUserEvent,
  finishRunAttempt,
  getSession,
  getLatestEventSeq,
  getSessionTokensUsed,
  isKillRequested,
  listEvents,
  openEventLog,
  preserveCurrentKillAndClearStale,
  recordRunAttemptUserInput,
  updateSession,
  type RunAttemptRef,
} from './eventlog.js';
import { AgentRuntimeCancelledError } from '../provider.js';
import type { AssistantRequest, AssistantResponse } from '../../types.js';
import { appendEvent } from './eventlog.js';
import { CONVERGENCE_STEER, convergenceSteerEnabled, priorTurnEndedAwaitingClarification, sessionHasBackgroundOffer } from './convergence-steer.js';
import {
  shouldOfferBackground,
  BACKGROUND_OFFER_TEXT,
  classifyTurnPreflight,
  effectiveTurnObjective,
  recordTurnPreflightDecision,
  CONFIRM_BEAT_TEXT,
} from './turn-control.js';
import {
  pullRecentTurnsForSession,
  renderRecentActionsForHarnessHistory,
  renderCrossSessionPrefixesForModel,
} from './session-transcript.js';
import { gatherSessionSkills } from './skill-execution.js';
import { renderRelevantSkillsForPrompt, renderSkillDiscoveryPrompt } from '../../memory/skill-store.js';
import { detectMultiItemIntent, fanoutDirectiveLine, knownPitfallLineForInput } from './context-packet.js';
import { looksLikeToolCallShape, looksLikeToolCallShapeStreaming } from './tool-narration-shapes.js';
import { createReplyStreamExtractor } from './reply-stream.js';
import { markRunInFlight } from './restart-recovery.js';
import { actionBus } from '../action-bus.js';
import {
  judgeObjectiveComplete,
  composeJudgedObjective,
  isPromiseShapedReply,
  isDirectionSeekingQuestion,
  type SkillExecutionContext,
  type ObjectiveJudgeFn,
} from './objective-judge.js';
import { resolveRoleModel } from './model-roles.js';
import {
  type ClaudeAgentSdkToolProfile,
  defaultClaudeAgentSdkAllowedLocalTools,
  claudeAgentSdkAdvertisableLocalTools,
  runClaudeAgentSdk,
  ClaudeSdkProviderOverloadError,
  ClaudeSdkContextOverflowError,
  type ClaudeAgentSdkRunOptions,
  type ClaudeAgentSdkRunResult,
} from './claude-agent-sdk.js';
import { resolveEffectiveToolNames, type ToolNamePolicyResult } from './tool-policy.js';
import { hasMeaningfulSuccessfulToolNames, objectiveMayRequireMultipleResults } from './tool-evidence.js';
import { renderHarnessCapabilityHealthForContext } from './capability-health.js';
import {
  listUnverifiedRunArtifacts,
  type RunArtifact,
} from './artifact-ledger.js';
import {
  createToolEconomyState,
  interactiveToolEconomyEnabled,
  interactiveToolEconomyPolicy,
} from './tool-economy.js';

type ClaudeAgentSdkRunFn = (options: ClaudeAgentSdkRunOptions) => Promise<ClaudeAgentSdkRunResult>;
let runClaudeAgentSdkImpl: ClaudeAgentSdkRunFn = runClaudeAgentSdk;

export function setClaudeAgentSdkBrainRunForTest(fn: ClaudeAgentSdkRunFn | null): void {
  runClaudeAgentSdkImpl = fn ?? runClaudeAgentSdk;
}

let judgeImpl: ObjectiveJudgeFn = judgeObjectiveComplete;
export function setClaudeAgentSdkBrainJudgeForTest(fn: ObjectiveJudgeFn | null): void {
  judgeImpl = fn ?? judgeObjectiveComplete;
}

let searchFactsHybridImpl: typeof searchFactsHybrid = searchFactsHybrid;
export function setClaudeAgentSdkBrainSearchFactsHybridForTest(fn: typeof searchFactsHybrid | null): void {
  searchFactsHybridImpl = fn ?? searchFactsHybrid;
}

export function setClaudeAgentSdkBrainUnifiedPrimerForTest(
  fn: Parameters<typeof _setUnifiedTurnPrimerRecallForTest>[0],
): void {
  _setUnifiedTurnPrimerRecallForTest(fn);
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
function contextSplitEnabled(): boolean {
  // Phase 3 #1 (token): keep the STABLE memory in the cacheable system append and
  // move the VOLATILE tail (Now / query-recall / focus / goals / held / working-
  // memory / this-session actions) into the user turn, so the big stable context
  // stops re-billing every turn (the Claude SDK lane re-billed ~5-15K tok/turn
  // because volatile fields led the append and busted the cached prefix). Kill-
  // switch CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT=off → old single-append behavior.
  return (getRuntimeEnv('CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}
function queryRecallTimeoutMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_BRAIN_QUERY_RECALL_TIMEOUT_MS', '1500') ?? '1500', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1500;
}
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function jitMonotonicEnabled(): boolean {
  // The cache lever: make the per-session advertised tool set MONOTONIC (only
  // grows) so once it converges the tools block is byte-identical turn-to-turn →
  // the SDK prompt cache holds for the rest of the run. The cache breakpoint sits
  // at the END of the system-prompt + tool-definitions layer, so a stable
  // system+tools prefix cache-HITS on turns 2+ EVEN as the user message varies;
  // per-turn JIT variance is the one thing that busts it (Anthropic docs, verified
  // 2026-06-29: code.claude.com/docs/en/prompt-caching · platform.claude.com/docs/
  // en/agents-and-tools/tool-use/tool-use-with-prompt-caching). This corrects the
  // earlier worry that "headless caching matches the full prompt" — it does not;
  // it matches the system+tools prefix. On a Claude subscription (this lane) the
  // cache TTL is automatically 1h, so the growth-phase cost amortizes over a long
  // window. DEFAULT ON: it is starvation-safe (the floor only GROWS, never drops
  // below the per-turn JIT selection; core/search tools are always present) and
  // never worse than the no-JIT baseline in steady state — a heavily-varied
  // session simply grows the floor until it advertises ALL tools, which the
  // jitDropped<=0 branch already detects and which is itself cache-stable. Only
  // the convergence transient (each growth busts once) is a cost. Kill-switch
  // CLEMMY_JIT_MONOTONIC=off → per-turn JIT (prior behavior).
  return (getRuntimeEnv('CLEMMY_JIT_MONOTONIC', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}
// Per-session growing tool FLOOR for monotonic JIT. Bounded so a long-lived daemon
// never accumulates unboundedly (oldest session evicted past the cap; each value
// is ≤|tools| short strings). Keyed by chat session id.
const SESSION_TOOL_FLOOR_MAX = 500;
const sessionToolFloor = new Map<string, Set<string>>();
export function bumpSessionToolFloor(sessionId: string, exposed: Iterable<string>): Set<string> {
  let floor = sessionToolFloor.get(sessionId);
  if (floor) sessionToolFloor.delete(sessionId); // re-insert to keep LRU recency
  else floor = new Set<string>();
  for (const t of exposed) floor.add(t);
  sessionToolFloor.set(sessionId, floor);
  if (sessionToolFloor.size > SESSION_TOOL_FLOOR_MAX) {
    const oldest = sessionToolFloor.keys().next().value;
    if (oldest !== undefined) sessionToolFloor.delete(oldest);
  }
  return floor;
}
export function sdkStreamingEnabled(): boolean {
  // DEFAULT ON (2026-07-01): the two reasons it was off are both fixed — tool-call narration
  // is now suppressed mid-stream (looksLikeStreamingNarration) AND the {"reply":"…"} envelope
  // is unwrapped by the reply-stream extractor, so the dock streams CLEAN prose token-by-token
  // (parity with the Codex lane) instead of raw JSON/tool-call syntax. Kill-switch =off reverts
  // to progress-chips-only (the final reply still delivers once via the guarded final onChunk).
  const raw = (getRuntimeEnv('CLEMMY_CLAUDE_SDK_STREAMING', 'on') ?? 'on').trim().toLowerCase();
  return raw !== 'off' && raw !== 'false' && raw !== '0';
}
function claudeSdkSalvageEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CLAUDE_SDK_SALVAGE', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}
/** SDK-named alias for the SHARED fallover classifier (transient-error.ts), so the
 *  chat lane and the workflow step-boundary fallover classify a parse-failure
 *  identically. The SDK's `query()` throws this — its own parse-retry already failed
 *  — when the model emits a tool call whose JSON can't be parsed. */
export const isClaudeSdkUnparseableToolCall = isUnparseableToolCallError;
/** When the SDK throws AFTER side effects already committed this turn (the work is
 *  done — only the SDK's final wrap-up failed), synthesize a SUCCESS result from
 *  the turn's own external_write ledger so the normal terminal block delivers a
 *  grounded confirmation instead of a hard "Didn't finish". NEVER re-runs (that
 *  would double-act). Returns null when nothing committed (let the caller retry). */
function salvageCommittedResult(sessionId: string, sinceSeq = 0): ClaudeAgentSdkRunResult | null {
  type WriteTruth = {
    seq: number;
    callId?: string;
    toolName?: string;
    shapeKey?: string;
    targets?: string[];
  };
  let writes: WriteTruth[] = [];
  let failed: WriteTruth[] = [];
  let orphaned: WriteTruth[] = [];
  try {
    const events = listEvents(sessionId, {
      types: ['external_write', 'external_write_failed', 'external_write_orphaned'],
      ...(sinceSeq > 0 ? { sinceSeq } : {}),
    });
    const mapped = events.map((event) => ({ seq: event.seq, ...(event.data as Omit<WriteTruth, 'seq'>) }));
    writes = mapped.filter((_row, index) => events[index]?.type === 'external_write');
    failed = mapped.filter((_row, index) => events[index]?.type === 'external_write_failed');
    orphaned = mapped.filter((_row, index) => events[index]?.type === 'external_write_orphaned');
  } catch { return null; }
  if (writes.length === 0) return null;

  const matches = (write: WriteTruth, resolution: WriteTruth): boolean => {
    if (write.seq >= resolution.seq) return false;
    if (write.callId && resolution.callId) return write.callId === resolution.callId;
    if (write.shapeKey !== resolution.shapeKey) return false;
    const left = new Set((write.targets ?? []).map((target) => String(target).toLowerCase()));
    const right = (resolution.targets ?? []).map((target) => String(target).toLowerCase());
    return left.size === 0 || right.length === 0 || right.some((target) => left.has(target));
  };
  const consumed = new Set<number>();
  const consumePrior = (resolution: WriteTruth): WriteTruth | null => {
    for (let index = writes.length - 1; index >= 0; index -= 1) {
      if (consumed.has(index) || !matches(writes[index], resolution)) continue;
      consumed.add(index);
      return writes[index];
    }
    return null;
  };
  for (const row of failed) consumePrior(row);
  const uncertain: WriteTruth[] = [];
  for (const row of orphaned) {
    const write = consumePrior(row);
    if (write) uncertain.push(write);
  }
  const landed = writes.filter((_write, index) => !consumed.has(index));
  if (landed.length === 0 && uncertain.length === 0) return null;
  const relevant = [...landed, ...uncertain];
  const targets = [...new Set(relevant.flatMap((w) => (w.targets ?? []).filter((t): t is string => typeof t === 'string')))];
  const allEmail = relevant.every((w) => /SEND_EMAIL|SEND_MAIL/i.test(w.shapeKey ?? ''));
  const noun = allEmail ? (relevant.length === 1 ? 'email' : 'emails') : (relevant.length === 1 ? 'action' : 'actions');
  const targetList = targets.length > 0 ? ` (${targets.slice(0, 8).join(', ')})` : '';
  if (uncertain.length > 0) {
    const completedPrefix = landed.length > 0 ? `${landed.length} completed; ` : '';
    const text = `⚠️ The model errored after external work started. ${completedPrefix}${uncertain.length} ${noun} may have gone through${targetList}, but its provider result was lost. I did not replay it because that could duplicate the action. Please verify the target; then tell me what remains.`;
    return { text, toolUses: relevant.map((w) => w.toolName ?? 'tool'), limitHit: false, sessionId };
  }
  // HONEST salvage: we know N writes LANDED, but NOT whether the task was fully
  // complete (the model errored before confirming). Do not over-claim "Done" — say
  // what ran, that nothing was duplicated, and ask the user to verify / offer to
  // finish. Reporting partial completion as success would be its own bug.
  const text = `⚠️ The model errored before it could confirm completion, but ${landed.length} ${noun} already went through${targetList} — nothing was duplicated. Please check these are what you intended; if anything's still missing, tell me and I'll finish it.`;
  return { text, toolUses: landed.map((w) => w.toolName ?? 'tool'), limitHit: false, sessionId };
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
  // A REAL tool fired ⇒ this text is a legitimate reply, not narration.
  if (toolUses.length > 0) return false;
  return looksLikeToolCallShape(text);
}

/** Streaming-time guard: detect the tool-call-protocol markers in the live text
 *  accumulated SO FAR, so the dock stops streaming the moment a delta starts reproducing
 *  tool-call syntax. No toolUses arg (mid-stream the final count is unknown), so it uses the
 *  streaming-safe subset of the shared shapes. The authoritative final reply still delivers. */
export function looksLikeStreamingNarration(text: string): boolean {
  return looksLikeToolCallShapeStreaming(text);
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
/**
 * Phase 1.3 (token + reliability): a SINGLE budget for the post-result corrective
 * continuations — narration-retry, reasoning-leak-retry, and the objective-judge
 * loop ALL draw from it. Each continuation is a full-context query(), so without a
 * shared cap they compound multiplicatively (narration + reasoning + judge×N =
 * up to 4-5 full re-runs of one turn). A healthy turn fires NONE; this only bounds
 * the pathological stack. Default 2; CLEMMY_CLAUDE_SDK_MAX_CONTINUATIONS=0 disables
 * all correctives, higher re-widens.
 */
function maxTurnContinuations(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_CLAUDE_SDK_MAX_CONTINUATIONS', '2') ?? '2', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2;
}

/** DEFAULT ON. When the SDK brain hits its per-query turn budget (maxTurns) on a run
 *  that is STILL making forward progress, auto-continue instead of PARKING on "say
 *  continue" — a per-query turn cap must not stop an autonomous multi-item run (the
 *  2026-07-01 Sonnet 5 stress: 5-firm SEO parked at 2/5 on maxTurns=24). Mirrors the
 *  main loop's auto-continue-on-limit ratchet. Off (CLEMMY_CLAUDE_SDK_AUTO_CONTINUE=off)
 *  ⇒ the prior park-on-limit behavior. */
function sdkAutoContinueEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CLAUDE_SDK_AUTO_CONTINUE', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}
/** Max auto-continues per run (each re-runs with a fresh turn budget). The per-query
 *  tool-ceiling + wall-clock remain the hard backstops. */
function maxSdkAutoContinues(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_CLAUDE_SDK_AUTO_CONTINUE_MAX', '8') ?? '8', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 8;
}
/** Total wall-clock budget across all auto-continues (a hard stop against a run that
 *  keeps making token progress without ever finishing). Default 30 min. */
function sdkAutoContinueWallMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_CLAUDE_SDK_AUTO_CONTINUE_WALL_MS', '1800000') ?? '1800000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1_800_000;
}

export type ClaudeAgentBrainSurface = 'webhook' | 'cron' | 'cli' | 'dashboard' | 'home' | 'discord' | 'slack' | 'background';
export type ClaudeAgentBrainMode = 'read_only' | 'local_authoring' | 'full';

function configuredMode(): ClaudeAgentBrainMode | null {
  // Claude chat and unattended execution surfaces use the tool-capable Agent
  // SDK lane by default.
  // The standard `claude -p` transport is intentionally text-only. Full-mode
  // writes still pass through Clementine's approval and tool-boundary gates.
  const raw = (getRuntimeEnv('CLEMMY_CLAUDE_AGENT_SDK_BRAIN', 'full') ?? 'full').trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') return null;
  if (raw === 'read_only' || raw === 'readonly') return 'read_only';
  // Full agentic: Claude executes gated tools (shell/composio/sends) under the
  // approval gate.
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
  return surface === 'webhook' || surface === 'cron' || surface === 'cli' || surface === 'dashboard' || surface === 'home' || surface === 'discord' || surface === 'slack' || surface === 'background';
}

export function claudeAgentSdkBrainEnabled(surface: string): surface is ClaudeAgentBrainSurface {
  if (configuredMode() === null || getActiveAuthMode() !== 'claude_oauth' || !isClaudeAgentBrainSurface(surface)) return false;
  try {
    return resolveRoleModel('brain').provider === 'claude';
  } catch {
    return false;
  }
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

/** The SDK brain's final reply was SHAPED like a printed tool call with zero
 *  real tool uses and the retry corrective didn't fix it — a dead turn unless
 *  another brain takes it. Zero side effects by definition ⇒ safe to re-run.
 *  message carries the graceful user-facing fallback copy. */
export class ClaudeSdkNarrationGiveUpError extends Error {
  readonly narrationGiveUp = true;
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeSdkNarrationGiveUpError';
  }
}

/** A2 reduced-context retry: drop the query-recall block from a turn context.
 *  Recall is re-derivable (the model can search memory); constraints, session
 *  actions (the double-send guard) and continuation context are NOT — keep them. */
function stripRecallFromTurnContext(turnContext: string | undefined): string | undefined {
  if (!turnContext) return turnContext;
  return turnContext
    .split('\n\n')
    .filter((block) => !block.startsWith('[MEMORY PRIMER]') && !block.startsWith('## Relevant To Your Request'))
    .join('\n\n');
}

function toolProfileForMode(mode: ClaudeAgentBrainMode): ClaudeAgentSdkToolProfile {
  if (mode === 'full') return 'full';
  if (mode === 'local_authoring') return 'local_authoring';
  return 'read_only';
}

function toolPolicyForRequest(request: AssistantRequest, mode: ClaudeAgentBrainMode): ToolNamePolicyResult {
  return resolveEffectiveToolNames({
    surface: 'claude_agent_sdk_brain',
    lane: mode,
    toolNames: defaultClaudeAgentSdkAllowedLocalTools(toolProfileForMode(mode)),
    excludeToolNames: request.excludeToolNames,
    reason: 'claude-agent-sdk allowed local MCP tools',
  });
}

/**
 * In full/agentic mode the SDK permission profile is only the fast-allow set.
 * The local MCP server intentionally advertises the broader catalog so tools
 * outside that profile can still reach canUseTool and the shared taxonomy gate.
 * JIT must preserve that distinction instead of turning permission into reachability.
 */
export function claudeAgentSdkAdvertisedToolUniverse(
  mode: ClaudeAgentBrainMode,
  fastAllowNames: readonly string[],
  excludeNames: readonly string[] = [],
): string[] {
  const excluded = new Set(excludeNames);
  const names = mode === 'full'
    ? claudeAgentSdkAdvertisableLocalTools()
    : [...fastAllowNames];
  return [...new Set(names)].filter((name) => !excluded.has(name));
}

export function partitionClaudeAgentSdkJitSurface(
  fastAllowNames: readonly string[],
  advertisedUniverse: readonly string[],
  exposed: ReadonlySet<string>,
): { fastAllowNames: string[]; advertisedNames: string[] } {
  return {
    fastAllowNames: fastAllowNames.filter((name) => exposed.has(name)),
    advertisedNames: advertisedUniverse.filter((name) => exposed.has(name)),
  };
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

/** The completion judge is a recovery path for suspicious text, not a tax on
 * successful tool execution. Concrete tool-backed runs already carry durable
 * tool/result evidence; bouncing them through another full model run adds
 * latency and can repeat side effects. A promise remains suspicious even when a
 * partial tool call happened, while a zero-tool action claim still needs proof. */
export function shouldJudgeClaudeCompletion(
  requestText: string,
  replyText: string,
  successfulToolUses: string[],
): boolean {
  return isPromiseShapedReply(replyText)
    || ((!hasMeaningfulSuccessfulToolNames(successfulToolUses, requestText)
      || objectiveMayRequireMultipleResults(requestText))
      && looksLikeActionCompletionClaim(requestText, replyText));
}

function mergeClaudeRunEvidence(
  previous: ClaudeAgentSdkRunResult,
  next: ClaudeAgentSdkRunResult,
): ClaudeAgentSdkRunResult {
  const hasSuccessfulEvidence = previous.successfulToolUses !== undefined
    || next.successfulToolUses !== undefined;
  return {
    ...next,
    toolUses: [...previous.toolUses, ...next.toolUses],
    artifactRunScopeId: next.artifactRunScopeId ?? previous.artifactRunScopeId,
    ...(hasSuccessfulEvidence
      ? { successfulToolUses: [...(previous.successfulToolUses ?? []), ...(next.successfulToolUses ?? [])] }
      : {}),
  };
}

function artifactPointer(artifact: RunArtifact): string {
  return artifact.uri ?? artifact.resourceId ?? artifact.sourceCallId ?? artifact.id;
}

/** One deterministic repair query for resources whose create response yielded
 * an id but whose exact provider binding has not yet been read back. This text
 * is deliberately generated from ledger state—not from the model's prose. */
function renderArtifactVerificationPrompt(artifacts: readonly RunArtifact[]): string {
  const rows = artifacts.map((artifact) => {
    if (artifact.kind === 'google_doc') {
      return `- Google Doc document_id=${artifact.resourceId}: call GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT (or the connected exact get-document-by-id equivalent) with exactly that document_id.`;
    }
    return `- Netlify site_id=${artifact.resourceId}: call run_shell_command once with netlify api getSite --data '{"site_id":"${artifact.resourceId}"}'.`;
  });
  return [
    'Before reporting success, independently read back the exact resource pointer(s) created in this run.',
    'Do NOT create, deploy, publish, search, or list anything. Do NOT substitute a title match. Make at most one exact-ID getter call per row:',
    ...rows,
    'Then report only whether those exact bindings were readable. Reuse the existing resource; never create a replacement.',
  ].join('\n');
}

function renderUnverifiedArtifactReply(artifacts: readonly RunArtifact[]): string {
  const rows = artifacts.map((artifact) => {
    const pointer = artifactPointer(artifact);
    const state = artifact.status === 'bound'
      ? 'the resource pointer was found, but the provider read-back did not verify it'
      : artifact.status === 'uncertain'
        ? 'the create outcome is uncertain'
        : 'the create attempt is still unresolved';
    return `- ${artifact.provider} ${artifact.title || artifact.slotKey}: ${pointer} — ${state}.`;
  });
  return [
    'I stopped before claiming this deliverable was finished because I could not independently verify the exact provider resource:',
    ...rows,
    'I did not create a replacement, so this did not duplicate the document or site. Please restore the provider connection (if needed) and tell me to retry verification of this exact resource.',
  ].join('\n');
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
      '- CONVERSE FIRST on an AMBIGUOUS or big multi-step request: recall what you can, then ask ONE plain clarifying question with `ask_user_question` about the choice that genuinely changes the work (e.g. new topic vs. resume prior work, which source/destination) and WAIT for the answer. Do NOT decide you "know enough" and run the whole task unasked. Once aligned — or when the request is already unambiguous — proceed AUTONOMOUSLY to completion; do not stop again mid-run. (A pure question or a read-only lookup: just do it, no clarifying question.)',
      '- Every tool call runs through Clementine\'s safety gates (grounding, goal-fidelity, execution-wrap, destination, duplicate-write, loop-guard). Irreversible/external actions (sends, batch external writes) PAUSE for the user\'s approval BEFORE they run. Do the work — the gates + approval protect it; you do not need to ask permission in prose first.',
      '- SURFACE NOTE: the intent-matched native vendor MCP servers for THIS turn (e.g. a native dataforseo/firecrawl/supabase MCP) ARE attached on this lane — their tool schemas load on demand via tool search (surfaced by name, fetched when you call them). When a skill or instruction says "use the <X> MCP", use that native server/tool directly. Fall back to composio_search_tools → composio_execute_tool (e.g. a DATAFORSEO_* slug) or run_shell_command (the vendor CLI) only when no native server is attached for the need. Use ONE surface per capability — do not pull the same data from two surfaces in the same run.',
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

// Win 2 (freeze-stable-prefix): the STABLE memory block (profile, saved specs,
// learned facts, data locations) is embedded in the CACHEABLE system append.
// Re-rendering it every turn meant a single reflection-written fact changed the
// block and busted the whole prompt-prefix cache (measured ~28% hit rate). We
// snapshot it PER SESSION so the system append stays byte-stable across turns.
// This remains opt-in until every explicit memory/profile/connection mutation
// shares a production invalidation generation; otherwise Claude can carry stale
// preferences and capabilities for the rest of a live session.
const stableMemorySnapshots = new Map<string, string>();
const STABLE_SNAPSHOT_MAX = 256;

function stableSnapshotEnabled(): boolean {
  return /^(1|true|on|yes)$/i.test((getRuntimeEnv('CLEMMY_BRAIN_STABLE_SNAPSHOT', 'off') ?? 'off').trim());
}

/** Invalidate a session's frozen stable-memory snapshot so the next turn
 *  re-renders it. Call after an EXPLICIT profile/spec/memory edit (not after
 *  automatic reflection — that churn is exactly what the snapshot defers). Pass
 *  no id to clear all (e.g. a global profile change). Also used by tests. */
export function invalidateStableMemorySnapshot(sessionId?: string): void {
  if (!sessionId?.trim()) { stableMemorySnapshots.clear(); return; }
  stableMemorySnapshots.delete(sessionId.trim());
}

/** The STABLE memory block, frozen to a per-session snapshot (see above). Falls
 *  back to a live render when the kill-switch is off or the session is unknown. */
function renderStableMemoryFrozen(request: AssistantRequest): string {
  const render = (): string => renderCanonicalMemoryContext({
    sessionId: request.sessionId,
    partition: 'stable',
    includeSessionActions: false,
  });
  const key = request.sessionId?.trim();
  if (!key || !stableSnapshotEnabled()) return render();
  const cached = stableMemorySnapshots.get(key);
  if (cached !== undefined) return cached;
  const fresh = render();
  // Bounded FIFO eviction so long-lived daemons don't leak snapshots.
  if (stableMemorySnapshots.size >= STABLE_SNAPSHOT_MAX) {
    const oldest = stableMemorySnapshots.keys().next().value;
    if (oldest !== undefined) stableMemorySnapshots.delete(oldest);
  }
  stableMemorySnapshots.set(key, fresh);
  return fresh;
}

export function renderClaudeAgentBrainSystemAppend(
  surface: ClaudeAgentBrainSurface,
  request: AssistantRequest,
  mode: ClaudeAgentBrainMode = claudeAgentSdkBrainMode() ?? 'read_only',
): string {
  const split = contextSplitEnabled();
  // Split ON: the system append carries ONLY the STABLE memory (cacheable across
  // turns); the volatile tail + this-session actions move to the user turn (see
  // renderClaudeAgentBrainTurnContext). Split OFF: the old single-append behavior
  // (full context + query recall + sessionActions here) — byte-identical.
  // Split ON: the STABLE block is frozen to a per-session snapshot so the system
  // append stays byte-stable and the prompt-prefix cache hits (Win 2). Split OFF:
  // the old single-append render (full context + query recall) — byte-identical.
  const persistentContext = split
    ? renderStableMemoryFrozen(request)
    : renderCanonicalMemoryContext({
        sessionId: request.sessionId,
        query: request.message,
        partition: 'all',
        includeSessionActions: false,
      });
  const spaceSlug = workspaceSlugFromSessionId(request.sessionId);
  const workspacePrimer = spaceSlug ? buildWorkspaceContextPrimer(spaceSlug) : null;
  // Visibility into THIS session's completed irreversible actions. The text
  // transcript doesn't carry tool results, so without this the brain is blind to
  // its own prior sends and can re-run them (the 2026-06-29 double-send). Gated by
  // the same session-history kill-switch. Split ON → this rides the user turn
  // instead (it grows each action, so it's volatile and must not bust the cache).
  let sessionActions = '';
  if (!split && sessionHistoryEnabled()) {
    try { sessionActions = renderRecentActionsForHarnessHistory(openEventLog(), request.sessionId); } catch { sessionActions = ''; }
  }
  return [
    'You are Clementine running as the main brain through the official Claude Agent SDK inside the Clementine harness.',
    'You are using the user\'s Claude subscription auth. Stay inside Clementine\'s product identity, memory, skills, workflows, and workspace expectations.',
    '',
    renderCapabilityBoundary(mode),
    '',
    sessionActions,
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
    // Canonical memory normally carries this compact discovery contract. Keep a
    // fallback only when that block is unavailable; never duplicate or enumerate
    // the installed catalog in the cacheable system prefix.
    renderClaudeBrainSkillsBlock(persistentContext),
    '',
    // Code-mode BATCH-SHAPE RULE (Move 3 / adoption): the brain lane had the
    // run_tool_program tool but NO steer, so it ground multi-fetch turns through
    // discrete calls (live: 6 discrete Outlook calls, 0 programs). The base rule
    // is a constant and getComposio() is session-stable, so this stays in the
    // cacheable stable append. Fires whenever composio data tools are in scope
    // (the common chat case) — the per-turn fan-out sharpening stays in the
    // turn context. '' (dropped by filter) when composio isn't configured.
    codeModeMandateDirective({ composioInScope: getComposio() != null }),
    '',
    'How you operate here:',
    CLAUDE_BRAIN_RUBRIC,
  ].filter(Boolean).join('\n\n');
}

/** Fixed-size fallback for a missing canonical skill-discovery block. Installed
 * names/descriptions are selected against the current query in turn context. */
function renderClaudeBrainSkillsBlock(persistentContext: string): string {
  if (persistentContext.includes('## Skill Discovery')) return '';
  try {
    return `SKILL DISCOVERY:\n${renderSkillDiscoveryPrompt()}`;
  } catch {
    return '';
  }
}

/**
 * The VOLATILE per-turn context for the Claude SDK brain — the bits that change
 * turn-to-turn (current time, query recall, live focus/goals/held/working-memory)
 * plus THIS session's completed irreversible actions. Returned separately from
 * the (stable, cacheable) system append so the caller can inject it into the user
 * turn, where uncached content belongs. When context splitting is off, the
 * persistent/volatile blocks remain in the system append but unified recall
 * still rides here: a prompt-placement kill-switch must not change memory.
 */
interface ClaudeTurnMemoryPrimerTelemetry {
  enabled: boolean;
  hitCount: number;
  omittedCount: number;
  candidateCount: number;
  source: string | null;
  recallId: string | null;
  answerability: 'supported' | 'partial' | 'insufficient' | null;
  stores: string[];
  recallElapsedMs: number | null;
  skippedReason: string | null;
}

async function buildClaudeAgentBrainTurnContext(
  request: AssistantRequest,
  opts?: { sourceUserSeq?: number },
): Promise<{
  text: string;
  memoryPrimer: ClaudeTurnMemoryPrimerTelemetry;
}> {
  const q = (request.message ?? '').replace(/\s+/g, ' ').trim();
  const splitContext = contextSplitEnabled();
  let relevantSkills = '';
  if (splitContext && q) {
    try {
      const rendered = renderRelevantSkillsForPrompt(q);
      if (rendered) relevantSkills = `## Relevant Skills\n${rendered}`;
    } catch { relevantSkills = ''; }
  }
  // Render the volatile tail WITHOUT the query so its FTS-only recall block is
  // omitted — we replace it below with HYBRID recall (FTS ∪ semantic) so the
  // Claude lane stops knowledge-starving on paraphrased requests (Phase 4).
  const volatile = splitContext
    ? renderCanonicalMemoryContext({
        sessionId: request.sessionId,
        partition: 'volatile',
        includeSessionActions: false,
      })
    : '';
  let recall = '';
  let unifiedPrimerStatus: 'ok' | 'empty' | 'timeout' | 'error' | 'disabled' | null = null;
  const recallOn = (getRuntimeEnv('CLEMMY_BRAIN_QUERY_RECALL', 'on') ?? 'on').trim().toLowerCase() !== 'off';
  let memoryPrimer: ClaudeTurnMemoryPrimerTelemetry = {
    enabled: recallOn,
    hitCount: 0,
    omittedCount: 0,
    candidateCount: 0,
    source: recallOn ? 'unified' : null,
    recallId: null,
    answerability: null,
    stores: [],
    recallElapsedMs: null,
    skippedReason: !recallOn ? 'disabled' : !q ? 'empty_input' : 'no_hits',
  };
  if (q && recallOn) {
    scheduleRecallShadow({ query: q, surface: 'claude_primer', limit: 6 });
    try {
      const timeoutMs = queryRecallTimeoutMs();
      const unified = await buildUnifiedTurnPrimer({
        query: q,
        surface: 'claude_primer',
        limit: 8,
        maxChars: 1_800,
        timeoutMs,
        sessionId: request.sessionId,
      });
      unifiedPrimerStatus = unified.status;
      memoryPrimer = {
        enabled: true,
        hitCount: unified.hitCount,
        omittedCount: unified.omittedHitCount,
        candidateCount: unified.diagnostics?.candidates ?? unified.retrievedHitCount,
        source: 'unified',
        recallId: unified.recallId ?? null,
        answerability: unified.answerability ?? null,
        stores: unified.diagnostics?.stores ?? [],
        recallElapsedMs: unified.diagnostics?.elapsedMs ?? null,
        skippedReason: unified.status === 'ok' ? null : unified.status === 'empty' ? 'no_hits' : unified.status,
      };
      if (unified.status === 'ok') {
        recall = unified.text ?? '';
      } else if (unified.status !== 'empty') {
        // Degraded fallback only: preserve the prior bounded fact/meeting path
        // when the unified ranker is killed, times out, or fails.
        const [hits, meetingRecall] = await Promise.all([
          withTimeout(searchFactsHybridImpl(q, 6), timeoutMs, []),
          isTemporalMeetingQuery(q)
            ? withTimeout(recallMemory(q, { stores: ['note'], graphDepth: 0, limit: 4 }), timeoutMs, null)
            : Promise.resolve(null),
        ]);
        const meetingBullets = (meetingRecall?.hits ?? []).map((hit) => {
          const source = hit.evidence[0]?.sourceUri;
          const content = String(hit.text ?? '').trim();
          const bounded = content.length <= 1000 ? content : `${content.slice(0, 1000)} …[truncated — load the source for the full meeting]`;
          return `- [RECORDED MEETING · ${hit.whyRecalled.join(', ')}] ${hit.title ?? 'Meeting'}: ${bounded}${source ? ` (source: ${source})` : ''}`;
        });
        const factBullets = hits
          .map((f) => {
            const content = String(f.content ?? '').trim();
            return `- ${content.length <= 1000 ? content : `${content.slice(0, 1000)} …[truncated — search memory for the full fact]`}`;
          })
          .filter((line) => line.length > 2);
        const bullets = [...meetingBullets, ...factBullets].join('\n');
        if (bullets) recall = `## Relevant To Your Request\n${bullets}`;
        memoryPrimer = {
          ...memoryPrimer,
          hitCount: meetingBullets.length + factBullets.length,
          omittedCount: 0,
          candidateCount: meetingBullets.length + hits.length,
          source: `legacy_fallback_${unified.status}`,
          recallId: null,
          answerability: recall ? 'partial' : 'insufficient',
          stores: [...new Set([
            ...(meetingBullets.length > 0 ? ['note'] : []),
            ...(factBullets.length > 0 ? ['fact'] : []),
          ])],
          skippedReason: recall ? null : `unified_${unified.status}_no_fallback_hits`,
        };
      }
    } catch {
      recall = '';
      unifiedPrimerStatus = 'error';
      memoryPrimer = { ...memoryPrimer, source: 'legacy_fallback_error', skippedReason: 'error' };
    }
  }
  if (!splitContext) {
    return { text: recall, memoryPrimer };
  }
  // Legacy cross-store breadcrumbs are retained only when the unified primer is
  // explicitly disabled or unavailable. The primary result already contains
  // entities, resources, episodes, policies, notes, facts, and procedures.
  let breadcrumbs = '';
  if (q && unifiedPrimerStatus !== 'ok' && unifiedPrimerStatus !== 'empty') {
    try { breadcrumbs = await crossStoreBreadcrumbs(q); } catch { breadcrumbs = ''; }
  }
  let sessionActions = '';
  if (sessionHistoryEnabled()) {
    try { sessionActions = renderRecentActionsForHarnessHistory(openEventLog(), request.sessionId); } catch { sessionActions = ''; }
  }
  let continuationContext = '';
  if (sessionHistoryEnabled()) {
    try { continuationContext = renderCrossSessionPrefixesForModel(openEventLog(), request.sessionId); } catch { continuationContext = ''; }
  }
  // Fan-out directive (parity with the Codex/orchestrator lane, which builds this in
  // buildAgentContextPacket). The Claude brain used to be BLIND to it — it hardcoded
  // multiItem detected=false and its rubric never mentioned run_worker — so a big same-shape
  // job ("scrape 100 accounts, analyze each") was ground through SEQUENTIALLY until it hit the
  // step cap and parked at ~item #15. Now a detected multi-item turn gets the loud
  // "do NOT serialize — run_worker in parallel waves" directive so she actually swarms.
  let fanoutDirective = '';
  // Confirm beat (parity with the context packet's confirm-first line — this
  // lane doesn't consume the packet): a FRESH chat session opening with an
  // execution-shaped request gets one conversational confirm/capability/
  // background beat before the work starts. The 2026-07-16 incident lane.
  let confirmBeat = '';
  const sourceBoundTurn = Number.isSafeInteger(opts?.sourceUserSeq)
    && Number(opts?.sourceUserSeq) > 0;
  let preflightSessionKind: NonNullable<ReturnType<typeof getSession>>['kind'] | undefined;
  try {
    preflightSessionKind = getSession(request.sessionId)?.kind;
  } catch (error) {
    // A source-bound dispatch whose durable session cannot be read cannot prove
    // whether confirm-first authority applies, so it must stop before the model.
    if (sourceBoundTurn) throw error;
  }
  try {
    const multi = detectMultiItemIntent(request.message ?? '');
    if (multi.isMultiItem) fanoutDirective = fanoutDirectiveLine(multi);
    const preflight = classifyTurnPreflight({
      message: request.message ?? '',
      sessionId: request.sessionId,
      sessionKind: preflightSessionKind,
      isMultiItem: multi.isMultiItem,
      itemCount: multi.itemCount,
      sourceUserSeq: opts?.sourceUserSeq,
    });
    // Persist only for a real durable chat session. Render-only probes commonly
    // use display ids with no session row and stay pure; the live SDK path also
    // supplies the exact accepted source row before model/tool dispatch.
    if (preflightSessionKind === 'chat') {
      recordTurnPreflightDecision(request.sessionId, preflight, opts?.sourceUserSeq);
    }
    confirmBeat = preflight.phase === 'align' ? CONFIRM_BEAT_TEXT : '';
  } catch {
    // (fold 2026-07-17) Preflight state is directive/telemetry, not execution
    // authority — a classify/persist failure degrades to no beat, never a
    // failed turn. Consent enforcement lives in plan-scope/approvals.
    fanoutDirective = '';
    confirmBeat = '';
  }
  // Pre-flight error library (parity with the context packet's Known-pitfalls
  // line — this lane doesn't consume the packet): the freshest distilled
  // lessons for the skills this turn will likely use, so a known failure mode
  // isn't repeated. Bounded to a couple of lines; empty for most turns.
  let pitfalls = '';
  try { pitfalls = knownPitfallLineForInput(request.message ?? '') ?? ''; } catch { pitfalls = ''; }
  let harnessHealth = '';
  try { harnessHealth = renderHarnessCapabilityHealthForContext({ limit: 3 }); } catch { harnessHealth = ''; }
  // CONVERGENCE (one beat, then execute): if Clem's PREVIOUS turn asked the user a
  // clarifying question and they just answered it, bias hard toward EXECUTION this
  // turn — the enforceable backstop to the "back-to-back questions" friction where
  // the brain drips a second/third separate question turn-by-turn instead of
  // planning once and acting (2026-07-09). Kill-switch CLEMMY_BRAIN_CONVERGE=off.
  let convergenceSteer = '';
  if (convergenceSteerEnabled() && priorTurnEndedAwaitingClarification(request.sessionId)) {
    convergenceSteer = CONVERGENCE_STEER;
  }
  return {
    text: [convergenceSteer, volatile, relevantSkills, continuationContext, harnessHealth, recall, breadcrumbs, sessionActions, fanoutDirective, confirmBeat, pitfalls].filter(Boolean).join('\n\n'),
    memoryPrimer,
  };
}

export async function renderClaudeAgentBrainTurnContext(
  request: AssistantRequest,
  opts?: { sourceUserSeq?: number },
): Promise<string> {
  return (await buildClaudeAgentBrainTurnContext(request, opts)).text;
}

function emitClaudeAgentSdkBrainContextTelemetry(
  sessionId: string,
  request: AssistantRequest,
  turnContext: string,
  primer?: ClaudeTurnMemoryPrimerTelemetry,
): void {
  const query = (request.message ?? '').replace(/\s+/g, ' ').trim();
  const recallBlocks = turnContext.split('\n\n').filter((block) =>
    block.startsWith('[MEMORY PRIMER]')
    || block.startsWith('## Relevant To Your Request')
    || block.startsWith('[ALSO IN MEMORY'),
  );
  const recallText = recallBlocks.join('\n\n');
  const injectedBytes = Buffer.byteLength(recallText, 'utf-8');
  const injected = injectedBytes > 0;
  const unified = recallBlocks.some((block) => block.startsWith('[MEMORY PRIMER]'));
  const refs = unified ? [...recallText.matchAll(/\[ref\s+(?:fact|note|entity|resource|episode|policy|procedure):[^\]]+\]/g)].length : null;
  const recallId = recallText.match(/recall:\s*([^;\]\s]+)/i)?.[1] ?? null;
  const answerability = recallText.match(/answerability:\s*(supported|partial|insufficient)/i)?.[1] ?? null;
  const includedCount = primer?.hitCount ?? refs ?? 0;
  const omittedCount = primer?.omittedCount ?? 0;
  try {
    appendEvent({
      sessionId,
      turn: 1,
      role: 'system',
      type: 'turn_memory_primer',
      data: {
        enabled: primer?.enabled ?? true,
        queryPreview: query.slice(0, 160),
        hitCount: includedCount,
        includedCount,
        omittedCount,
        candidateCount: primer?.candidateCount ?? includedCount + omittedCount,
        injected,
        injectedBytes,
        source: primer?.source ?? (unified ? 'unified' : injected ? 'legacy_fallback' : null),
        recallId: primer?.recallId ?? recallId,
        answerability: primer?.answerability ?? answerability,
        stores: primer?.stores ?? [],
        recallElapsedMs: primer?.recallElapsedMs ?? null,
        skippedReason: primer?.skippedReason ?? (injected ? null : 'no_hits'),
      },
    });
  } catch { /* telemetry must never block the turn */ }
  try {
    appendEvent({
      sessionId,
      turn: 1,
      role: 'system',
      type: 'agent_context_packet',
      data: {
        inputPreview: query.slice(0, 160),
        complexity: 'provider_managed',
        memory: {
          enabled: true,
          injected,
          source: unified ? 'unified' : injected ? 'legacy_fallback' : null,
        },
        skills: { detected: false },
        workflows: { detected: false },
        toolScope: { lane: 'claude_agent_sdk_brain' },
        mcp: { lane: 'claude_agent_sdk_brain' },
        healthWarnings: [],
        agentSystem: { lane: 'claude_agent_sdk_brain' },
        multiItem: { detected: (() => { try { return detectMultiItemIntent(request.message ?? '').isMultiItem; } catch { return false; } })() },
        injectedBytes,
      },
    });
  } catch { /* telemetry must never block the turn */ }
  try {
    appendEvent({
      sessionId,
      turn: 1,
      role: 'system',
      type: 'reasoning_effort',
      data: {
        effort: 'provider_default',
        reason: 'claude_agent_sdk_brain_provider_managed',
        kind: 'chat',
        transport: 'claude_agent_sdk_brain',
      },
    });
  } catch { /* telemetry must never block the turn */ }
}

function cancelledBrainResponse(
  sessionId: string,
  attempt: Pick<RunAttemptRef, 'attemptId' | 'runId'>,
  text = 'Stopped — you asked me to halt this run. Nothing further will execute; tell me how you\'d like to proceed.',
): AssistantResponse {
  try { clearKill(sessionId, attempt); } catch { /* one-shot latch cleanup */ }
  let inserted = false;
  try {
    const terminal = appendTerminalEventOnce({
      sessionId,
      turn: 0,
      role: 'system',
      data: {
        attemptId: attempt.attemptId,
        ...(attempt.runId ? { runId: attempt.runId } : {}),
        reason: 'cancelled',
        summary: text.slice(0, 400),
        reply: text,
        transport: 'claude_agent_sdk_brain',
      },
    }, `brain:${attempt.attemptId}`);
    inserted = terminal.inserted;
  } catch { /* terminal telemetry is best-effort */ }
  // Only the process that won the durable terminal append may broadcast the
  // runtime terminal. This prevents the Tasks board/report-back from settling
  // twice when cancellation races the SDK's final stream message.
  if (inserted) {
    try { actionBus.emit({ kind: 'runtime.completed', sessionId }); } catch { /* best-effort */ }
  }
  try { updateSession(sessionId, { status: 'cancelled' }); } catch { /* observability metadata */ }
  markRunInFlight(sessionId, false);
  return {
    text,
    sessionId,
    stoppedReason: 'cancelled',
    turnsUsed: 0,
    raw: { transport: 'claude_agent_sdk_brain', cancelled: 'run_attempt' },
  };
}

/**
 * Run-attempt wrapper around the SDK brain. Interactive channels can
 * pre-register the same `request.runId` before dispatch; beginning it again is
 * idempotent. A stop aimed at that attempt survives startup, while a kill row
 * aimed at a superseded attempt is cleared before any model/tool work begins.
 */
export async function respondViaClaudeAgentSdkBrain(
  surface: ClaudeAgentBrainSurface,
  request: AssistantRequest,
): Promise<AssistantResponse> {
  const sessionId = request.sessionId;
  const mode = claudeAgentSdkBrainMode() ?? 'read_only';
  if (!getSession(sessionId)) {
    const titleSeed = request.message.trim().replace(/\s+/g, ' ');
    const sessionKind = surface === 'background' || surface === 'cron' ? 'execution' : 'chat';
    createSession({
      id: sessionId,
      kind: sessionKind,
      channel: request.channel,
      userId: request.userId,
      title: titleSeed.length > 80 ? `${titleSeed.slice(0, 77)}...` : titleSeed,
      metadata: { source: `claude-agent-sdk-brain:${surface}`, readOnly: mode === 'read_only', mode },
    });
  }

  const attempt = beginRunAttempt(sessionId, { runId: request.runId });
  preserveCurrentKillAndClearStale(sessionId, attempt);
  const callerShouldCancel = request.shouldCancel;
  const scopedRequest: AssistantRequest = {
    ...request,
    // Give no-run-id callers a stable attempt identity for terminal de-dupe.
    runId: request.runId ?? attempt.attemptId,
    shouldCancel: async () => {
      if (isKillRequested(sessionId, attempt)) return true;
      return callerShouldCancel ? Boolean(await callerShouldCancel()) : false;
    },
  };
  let status: 'completed' | 'cancelled' | 'failed' = 'failed';
  try {
    const response = await respondViaClaudeAgentSdkBrainAttempt(surface, scopedRequest, attempt);
    status = response.stoppedReason === 'cancelled' ? 'cancelled' : 'completed';
    return response;
  } finally {
    try { finishRunAttempt(attempt, status); } catch { /* attempt telemetry must not mask the response */ }
    if (status === 'cancelled') {
      try { clearKill(sessionId, attempt); } catch { /* best effort */ }
    }
  }
}

async function respondViaClaudeAgentSdkBrainAttempt(
  surface: ClaudeAgentBrainSurface,
  request: AssistantRequest,
  attempt: RunAttemptRef,
): Promise<AssistantResponse> {
  const sessionId = request.sessionId;
  const mode = claudeAgentSdkBrainMode() ?? 'read_only';
  const completionJudgeForSurface = surface !== 'background' && surface !== 'cron' && completionJudgeEnabled();
  const isSpaceSession = workspaceSlugFromSessionId(sessionId) != null;
  if (!getSession(sessionId)) {
    const titleSeed = request.message.trim().replace(/\s+/g, ' ');
    const sessionKind = surface === 'background' || surface === 'cron' ? 'execution' : 'chat';
    createSession({
      id: sessionId,
      kind: sessionKind,
      channel: request.channel,
      userId: request.userId,
      title: titleSeed.length > 80 ? `${titleSeed.slice(0, 77)}...` : titleSeed,
      metadata: { source: `claude-agent-sdk-brain:${surface}`, readOnly: mode === 'read_only', mode },
    });
  }

  // Record the user's turn so the SDK brain is a proper session citizen: the
  // workflow-run boundary guard, session history, recall, and report-back all
  // read `user_input_received`. Without it the brain's tools (e.g. workflow_run)
  // can't see what the user actually asked for.
  // Multi-turn history: read the session's PRIOR turns BEFORE appending the
  // current one (so the current message isn't echoed as "prior"). Threaded into
  // runOptions below so every attempt (incl. retries/judge continuations) keeps
  // context. The SDK lane is stateless, so without this the brain sees only the
  // latest message — the "no chat history available" wrong-task bug.
  // The desktop may have durably recorded this input before selecting a brain.
  // Reuse only an exact, unsettled request match; background/workflow run ids
  // can intentionally span distinct messages and must never be a dedupe key.
  const boundUserInput = getRunAttemptSourceUserEvent(attempt);
  const preRecordedUserInput = boundUserInput ?? (
    request.channel === 'desktop' && request.runId
      ? findUserInputEventForRun(sessionId, request.runId, request.message)
      : null
  );
  const preRecordedText = typeof preRecordedUserInput?.data.text === 'string'
    ? preRecordedUserInput.data.text
    : '';
  let priorTurns: Array<{ who: 'user' | 'assistant'; text: string }> = [];
  if (sessionHistoryEnabled()) {
    try {
      priorTurns = pullRecentTurnsForSession(openEventLog(), sessionId, 6).map((t) => ({ who: t.who, text: t.text }));
      if (
        preRecordedUserInput
        && priorTurns.at(-1)?.who === 'user'
        && priorTurns.at(-1)?.text === preRecordedText
      ) {
        priorTurns.pop();
      }
    } catch { priorTurns = []; }
  }

  // Source identity is execution-critical, not best-effort telemetry. Insert
  // and bind in one transaction (or consume the route's existing binding)
  // before any agentic tool can dispatch.
  const userInputEvent = recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: request.message, ...(request.runId ? { runId: request.runId } : {}) },
  }, { existingEventSeq: preRecordedUserInput?.seq });
  try {
    // Working signal: a turn_started lights the existing elapsed-time/pulse so a
    // long turn never reads as frozen (the Codex lane emits this; the SDK lane
    // didn't). role:'system' → no spurious agent label.
    appendEvent({ sessionId, turn: 1, role: 'system', type: 'turn_started', data: {} });
  } catch { /* best effort — never block the turn */ }

  // Memory writeback parity with the main harness loop. The Claude Agent SDK
  // brain can truthfully answer a "remember this" turn without calling
  // memory_remember, so run the same deterministic auto-capture fallback here
  // for real chat turns. Errors are swallowed: memory capture must not block the
  // model turn, but the trace records candidate signals when it does engage.
  try {
    const session = getSession(sessionId);
    const shouldCapture = session?.kind === 'chat';
    const captured = shouldCapture
      ? captureInteractionSignals({
          message: request.message,
          sessionId,
          sourceEventId: request.runId ? `run:${request.runId}` : undefined,
        })
      : { candidates: [], facts: [], profilePatch: undefined, profile: undefined };
    if (captured.candidates.length > 0 || captured.profilePatch) {
      appendEvent({
        sessionId,
        turn: 1,
        role: 'system',
        type: 'memory_signals_captured',
        data: {
          factCount: captured.candidates.length,
          profilePatch: captured.profilePatch ?? null,
          reasons: captured.candidates.map((candidate) => candidate.reason),
        },
      });
    }
  } catch { /* auto-capture is opportunistic and must never block a turn */ }

  if (request.shouldCancel && await request.shouldCancel()) {
    try {
      appendEvent({ sessionId, turn: 0, role: 'system', type: 'kill_requested', data: { reason: 'before model dispatch', attemptId: attempt.attemptId } });
    } catch { /* telemetry best-effort */ }
    return cancelledBrainResponse(sessionId, attempt, 'Stopped — the run was cancelled before model dispatch. Nothing executed.');
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
  const fullToolPolicy = toolPolicyForRequest(request, mode);
  const fullAllowed = fullToolPolicy.names;
  const advertisedUniverse = claudeAgentSdkAdvertisedToolUniverse(
    mode,
    fullAllowed,
    request.excludeToolNames,
  );
  try {
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type: 'tool_policy_resolved',
      data: { ...fullToolPolicy.diagnostics },
    });
  } catch { /* tool policy telemetry must never block the turn */ }
  const jitDecision = resolveToolJitDecision({ allowLane: true, sessionId });
  let jitAllowed = fullAllowed;
  let jitAdvertised = advertisedUniverse;
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
        tools: advertisedUniverse.map((name) => ({ name, description: descByName.get(name) ?? '' })),
        recallPinned: recallPinnedBuiltinTools(jitQuery),
      });
      // H1c: a dock chat IS editing a Workspace — pin the space tools so the JIT
      // never drops them (else the model can't persist the edit and sandboxes it).
      if (isSpaceSession) {
        for (const t of WORKSPACE_DOCK_TOOLS) if (fullAllowed.includes(t)) selection.exposed.add(t);
      }
      jitReason = selection.reason;
      if (selection.reduced) {
        // Monotonic JIT (cache lever): union this turn's selection into the
        // session's growing floor so the advertised set stabilizes and the SDK
        // prompt cache stops busting on per-turn tool variance.
        const exposed = (jitMonotonicEnabled() && sessionId)
          ? bumpSessionToolFloor(sessionId, selection.exposed)
          : selection.exposed;
        const partitioned = partitionClaudeAgentSdkJitSurface(fullAllowed, advertisedUniverse, exposed);
        jitAllowed = partitioned.fastAllowNames;
        jitAdvertised = partitioned.advertisedNames;
        mcpToolAllowlist = jitAdvertised;
        jitDropped = advertisedUniverse.length - jitAdvertised.length;
        if (jitDropped <= 0) {
          // Floor converged to the whole surface — advertise all (still cache-stable).
          mcpToolAllowlist = undefined;
          jitReason = 'jit-monotonic-converged-full';
        }
      }
    } catch {
      jitAllowed = fullAllowed; jitAdvertised = advertisedUniverse; mcpToolAllowlist = undefined; jitReason = 'jit-error-fellback';
    }
  }
  // Telemetry — emit on a real reduction. Tagged lane:'claude_sdk' to distinguish
  // from the Codex orchestrator lane in the readout.
  if (sessionId && jitDropped > 0) {
    try {
      appendEvent({
        sessionId, turn: 0, role: 'system', type: 'tool_jit_scope',
        data: {
          lane: 'claude_sdk',
          jitActive: jitDecision.active,
          droppedCount: jitDropped,
          exposedCount: jitAdvertised.length,
          fastAllowCount: jitAllowed.length,
          reason: jitReason,
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
  // Raw SDK deltas so far (for the narration check); the CLEAN reply text goes to the dock via
  // the reply-envelope extractor so the user sees prose, not `{"reply":"…"}` JSON.
  let rawStreamText = '';
  const replyExtractor = createReplyStreamExtractor();
  const renderedTurnContext = await buildClaudeAgentBrainTurnContext(request, { sourceUserSeq: userInputEvent.seq });
  const turnContext = renderedTurnContext.text;
  emitClaudeAgentSdkBrainContextTelemetry(sessionId, request, turnContext, renderedTurnContext.memoryPrimer);
  const attemptTrackerScopeId = `${sessionId}::brain:${attempt.runId ?? attempt.attemptId}`;
  const turnObjective = effectiveTurnObjective(sessionId, request.message, userInputEvent.seq);
  const toolEconomyState = (() => {
    if (surface === 'background' || surface === 'cron' || !interactiveToolEconomyEnabled()) return undefined;
    let multiItem = false;
    try { multiItem = detectMultiItemIntent(turnObjective).isMultiItem; } catch { /* policy falls back to text shape */ }
    return createToolEconomyState(interactiveToolEconomyPolicy({
      message: turnObjective,
      priorMessages: priorTurns.filter((turn) => turn.who === 'user').map((turn) => turn.text),
      multiItem,
    }));
  })();
  const runOptions = {
    sessionId,
    // Stable for the whole durable attempt: retries/continuations must share
    // one guardrail + artifact scope even though each retry appends another
    // user_input_received event.
    trackerScopeId: attemptTrackerScopeId,
    // Candidate attempt scope only. The SDK persists/resolves artifact lineage
    // lazily on the first create or exact-id verification.
    artifactRunScopeId: attemptTrackerScopeId,
    sourceUserSeq: userInputEvent.seq,
    artifactObjective: turnObjective,
    modelId,
    systemAppend: renderClaudeAgentBrainSystemAppend(surface, request, mode),
    turnContext,
    allowedLocalMcpTools: jitAllowed,
    mcpToolAllowlist,
    agentic: mode === 'full',
    // Mount the read-fanout block on native external MCP: the orchestrator brain
    // is the ONE lane with run_tool_program (the recovery), so serial native-MCP
    // reads here get refused + steered to a program; workers/steps opt out.
    readFanoutGuard: mode === 'full',
    // TOOL-STARVATION GUARD (live 2026-07-01: the local MCP server's ~13s cold
    // boot intermittently missed the CLI's startup window under load — the brain
    // then ran with ONLY external MCP tools and narrated/refused local actions,
    // silently). If the local server didn't attach, these sentinels are absent
    // from the SDK init → typed ClaudeAgentSdkToolSurfaceError → the bridge's
    // cross-brain fallover completes the turn on Codex instead of a blind run.
    requiredLocalMcpTools: ['memory_recall_all'],
    // Scope the native external MCP servers to THIS turn's intent (the user's message)
    // so the Claude brain reaches native capabilities (dataforseo, browsermcp, …) like
    // the Codex lane, without attaching all of them.
    nativeMcpScopeInput: turnObjective,
    maxTurns: maxTurns(),
    maxWallClockMs: request.maxWallClockMs,
    shouldCancel: request.shouldCancel,
    // One object for the whole logical foreground run. Corrective retries and
    // max-turn continuations cannot reset the budget that the user experiences.
    toolEconomyState,
    priorTurns,
    onDelta: (request.onChunk && sdkStreamingEnabled())
      ? async (d: string): Promise<void> => {
        if (narrationStream) return;
        rawStreamText += d;
        // Narration guard on the RAW stream: if the model starts printing tool-call syntax,
        // stop forwarding for the rest of the turn (the final reply still delivers).
        if (looksLikeStreamingNarration(rawStreamText)) { narrationStream = true; return; }
        // Emit only the CLEAN reply text (extracted from the {"reply":"…"} envelope), so the
        // dock streams prose, not JSON. streamedText tracks what was ACTUALLY shown (clean) so
        // the final-chunk dedup below doesn't re-render the answer.
        const cleanDelta = replyExtractor(d);
        if (!cleanDelta) return;
        streamedText += cleanDelta;
        streamedAny = true;
        await request.onChunk?.(cleanDelta);
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
  // Salvage authority is THIS logical attempt, never old session history. A
  // reusable chat can contain many prior sends; without this boundary a parse
  // failure on a later read-only turn could falsely report those old sends as
  // work that "just went through".
  const salvageSinceSeq = getLatestEventSeq(sessionId);
  // Salvage/recover wrapper for the SDK dispatch. On an unparseable-tool-call
  // throw (the SDK's own parse-retry already failed): (A) if side effects already
  // committed this turn → return a grounded SUCCESS confirmation (NEVER re-run —
  // would double-act, e.g. re-send emails); (B) if nothing committed → ONE fresh
  // retry (a fresh query() usually re-derives a clean tool call). Kill-switch
  // CLEMMY_CLAUDE_SDK_SALVAGE. Healthy turns are byte-identical.
  // Stage 4 — the SDK-brain lane's slice of the run token budget: when the
  // caller (the background drain) threads a ceiling+baseline, exhaustion
  // stops the INTERNAL auto-continue chain and surfaces as a budget park
  // instead of silently burning past the window (review F2).
  const budgetWindowExhausted = (): boolean => {
    try {
      if (!runTokenBudgetEnforcementEnabled()) return false;
      const ceiling = typeof request.maxRunTokens === 'number' ? request.maxRunTokens : 0;
      if (ceiling <= 0) return false;
      const baseline = typeof request.runTokenBaseline === 'number' ? request.runTokenBaseline : 0;
      return getSessionTokensUsed(sessionId) - baseline >= ceiling;
    } catch { return false; }
  };
  const runWithSalvage = async (opts: Parameters<typeof runClaudeAgentSdkImpl>[0]): Promise<ClaudeAgentSdkRunResult> => {
    try {
      return await runClaudeAgentSdkImpl(opts);
    } catch (err) {
      // P4: a COMMITTED provider overload (the model hit 429/529 AFTER side effects
      // landed, 21-min-in) used to dead-end as a raw "overloaded" error. If writes
      // committed, salvage an HONEST partial from the ledger instead of the raw error
      // — the user gets "N actions went through, nothing duplicated, I hit capacity"
      // rather than a bare failure. NEVER re-runs (would double-act). An UNCOMMITTED
      // overload still propagates so the existing transplant to another brain runs.
      if (claudeSdkSalvageEnabled() && err instanceof ClaudeSdkProviderOverloadError && err.committed) {
        const salvagedOverload = salvageCommittedResult(sessionId, salvageSinceSeq);
        if (salvagedOverload) {
          try { appendEvent({ sessionId, turn: 0, role: 'system', type: 'guardrail_tripped', data: { kind: 'claude_sdk_salvaged', reason: 'provider_overload_after_commit' } }); } catch { /* best-effort */ }
          return salvagedOverload;
        }
        throw err; // committed but no external write to salvage — surface for the caller
      }
      // A2: context-window overflow (typed by the SDK wrapper). Committed ⇒
      // salvage an honest partial exactly like the overload branch (NEVER
      // re-run — would double-act). Uncommitted ⇒ ONE retry with reduced
      // context: recall dropped, prior turns halved to the last 2 — but the
      // session-actions block KEPT (it is the double-send guard).
      if (claudeSdkSalvageEnabled() && err instanceof ClaudeSdkContextOverflowError) {
        // err.committed counts ANY tool call (incl. reads) — but re-running is
        // only unsafe when external WRITES landed. Salvage when they did; when
        // the ledger shows none (read-heavy research run — the common overflow),
        // fall through to the reduced-context retry: re-running reads is safe.
        if (err.committed) {
          const salvagedOverflow = salvageCommittedResult(sessionId, salvageSinceSeq);
          if (salvagedOverflow) {
            try { appendEvent({ sessionId, turn: 0, role: 'system', type: 'guardrail_tripped', data: { kind: 'claude_sdk_salvaged', reason: 'context_overflow_after_commit' } }); } catch { /* best-effort */ }
            return salvagedOverflow;
          }
        }
        try { appendEvent({ sessionId, turn: 0, role: 'system', type: 'guardrail_tripped', data: { kind: 'claude_sdk_overflow_retry', reason: 'context_overflow_reduced_retry' } }); } catch { /* best-effort */ }
        return await runClaudeAgentSdkImpl({
          ...opts,
          priorTurns: opts.priorTurns?.slice(-2),
          turnContext: stripRecallFromTurnContext(opts.turnContext),
        });
      }
      if (!claudeSdkSalvageEnabled() || !isClaudeSdkUnparseableToolCall(err)) throw err;
      const salvaged = salvageCommittedResult(sessionId, salvageSinceSeq);
      if (salvaged) {
        try { appendEvent({ sessionId, turn: 0, role: 'system', type: 'guardrail_tripped', data: { kind: 'claude_sdk_salvaged', reason: 'unparseable_tool_call_after_commit' } }); } catch { /* best-effort */ }
        return salvaged;
      }
      // Nothing committed yet — safe to retry once.
      try {
        return await runClaudeAgentSdkImpl(opts);
      } catch (err2) {
        if (isClaudeSdkUnparseableToolCall(err2)) {
          const s2 = salvageCommittedResult(sessionId, salvageSinceSeq); // the retry may have committed before failing
          if (s2) return s2;
        }
        throw err2;
      }
    }
  };
  // A best-effort CONTINUATION (narration/reasoning/judge retry) runs only after a
  // GOOD result. If it hits the same parse stumble, keep the prior good result
  // rather than turning a finished turn into a failure. Returns null ⇒ keep prior.
  const runContinuation = async (opts: Parameters<typeof runClaudeAgentSdkImpl>[0]): Promise<ClaudeAgentSdkRunResult | null> => {
    try {
      return await runClaudeAgentSdkImpl(opts);
    } catch (err) {
      if (claudeSdkSalvageEnabled() && isClaudeSdkUnparseableToolCall(err)) return null;
      throw err;
    }
  };
  // Move 1 (report-back WITHOUT FAIL): arm the in-flight marker around the WHOLE
  // model-work span (initial run + every corrective continuation), so a daemon
  // crash during this possibly-30-60min run is surfaced by the boot scan — the
  // active SDK brain now keeps the same promise the Codex lane (runConversation)
  // already had. Model-run exceptions clear it immediately; final delivery clears
  // it only after the terminal conversation_completed event is durable, so a
  // marker that survives a restart unambiguously means "killed or lost before
  // report-back completed".
  markRunInFlight(sessionId, true);
  // Move 4 (defeat silent success): when the completion judge ACCEPTS a turn via
  // a degraded verification — it failed open (timed out / errored) or self-judged
  // (same-family, the model graded its own homework) — record that so the
  // completion is tagged "not independently verified", never a silent green check.
  let completionVerification: { failedOpen?: boolean; selfJudge?: boolean } | null = null;
  let artifactVerificationPending: RunArtifact[] = [];
  let logicalRunScopeId: string | undefined;
  let result: ClaudeAgentSdkRunResult;
  try {
    result = await runWithSalvage({ prompt: request.message, ...runOptions });
    logicalRunScopeId = result.artifactRunScopeId;
    const resultIsAwaitingInput = (): boolean => result.stoppedReason === 'awaiting-input';

    // Phase 1.3: ONE shared budget across all post-result corrective continuations
    // (narration, reasoning-leak, judge) so they can't compound into 4-5 full-context
    // re-runs of a single turn. Healthy turns spend 0.
    let continuationsUsed = 0;
    const continuationBudget = maxTurnContinuations();

    // Narrate-instead-of-call backstop (defense-in-depth; the lean rubric prevents
    // most of it). If the brain made NO real tool calls but its text reproduces the
    // tool-call protocol, it described a call instead of making one — retry ONCE
    // with a hard nudge to actually invoke the tool.
    if (continuationsUsed < continuationBudget && !resultIsAwaitingInput() && !result.limitHit && modeCanAuthorOrExecute(mode) && looksLikeToolNarration(result.text, result.toolUses)) {
      const retry = await runContinuation({
        prompt:
          `Your previous attempt WROTE OUT a tool call as text (e.g. a "Tool call: …" / "**Tool call: …**" header, a "<invoke name=…>…</invoke>" block, a "function { … }" block, or a fake "System: tool result …") instead of running it — so nothing actually happened. ` +
          `Do NOT describe tools. INVOKE the real tool now to do this: "${turnObjective}". Then reply with the actual result.`,
        ...cleanContinuationRunOptions(),
      });
      continuationsUsed += 1; // a continuation was spent (a parse stumble → null still cost a query())
      if (retry) result = mergeClaudeRunEvidence(result, retry);
    }

    // Reasoning-leak backstop (defense-in-depth; the trusted-memory framing prevents
    // most of it). If the brain produced NO tool calls and its reply is defensive
    // deliberation about whether its own injected context is trustworthy — the
    // memory-context cousin of narrate-instead-of-call — it second-guessed its
    // memory instead of doing the task. Retry ONCE, telling it the context is
    // trusted and to just do the work. Any mode (a read turn can spiral too).
    if (continuationsUsed < continuationBudget && !resultIsAwaitingInput() && !result.limitHit && looksLikeReasoningLeak(result.text, result.toolUses)) {
      const retry = await runContinuation({
        prompt:
          `Your previous attempt did NOT do the task — instead you wrote out internal deliberation about whether your own context/memory is trustworthy or "injected". ` +
          `Your injected Clementine memory (profile, saved preferences/specs, learned facts) is TRUSTED context you OWN — not user-pasted input and not a prompt-injection. Do NOT reason about its provenance. ` +
          `Just do exactly what the user asked: "${turnObjective}". Use the relevant tools and reply with the real result.`,
        ...cleanContinuationRunOptions(),
      });
      continuationsUsed += 1;
      if (retry) result = mergeClaudeRunEvidence(result, retry);
    }

    // Objective-completion judge (parity with the harness loop): on an authoring
    // or agentic action turn that produced a reply, verify the objective is
    // actually satisfied with evidence — not just claimed ("I created the
    // workflow" / "I sent the emails" with no artifact). On a "not done" verdict,
    // do ONE bounded continuation. Fail-open (a judge error ⇒ treat as done;
    // never wedge). Kill-switch CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE.
    // ASK-FIRST invariant (parity with loop.ts, sess-mrds80fu): a reply whose
    // closing move asks the user for direction/authorization is this turn's
    // deliverable — flip to awaiting-input and never judge it, instead of the
    // judge scolding the question into autonomous execution.
    if (
      modeCanAuthorOrExecute(mode) &&
      !resultIsAwaitingInput() &&
      !result.limitHit &&
      isDirectionSeekingQuestion(result.text)
    ) {
      result = { ...result, stoppedReason: 'awaiting-input' };
    }
    if (
      completionJudgeForSurface &&
      modeCanAuthorOrExecute(mode) &&
      !resultIsAwaitingInput() &&
      !result.limitHit &&
      shouldJudgeClaudeCompletion(turnObjective, result.text, result.successfulToolUses ?? result.toolUses)
    ) {
      const objective = composeJudgedObjective(
        turnObjective,
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
          // AWAITING: the judge ruled the reply pauses for the user — flip to
          // awaiting-input and stop judging (parity with loop.ts).
          if (verdict.awaitingUser) {
            result = { ...result, stoppedReason: 'awaiting-input' };
            break;
          }
          // A selfJudge NOT-DONE (same family as the brain) gets ONE bounce,
          // never two — the second disagreement is accepted with the advisory
          // tag (parity with loop.ts; sess-mrds80fu).
          if (!done && verdict.selfJudge && i >= 1) {
            completionVerification = { selfJudge: true };
            break;
          }
          // Tag the completion's verification confidence (only when accepting).
          if (verdict.done && (verdict.failedOpen || verdict.selfJudge)) {
            completionVerification = { failedOpen: verdict.failedOpen, selfJudge: verdict.selfJudge };
          }
        } catch {
          completionVerification = { failedOpen: true };
          break;
        }
        if (done) break;
        // The cheap judge eval still runs/logs, but the EXPENSIVE full continuation
        // draws from the shared turn budget — so narration+reasoning+judge can't
        // stack into 4-5 full re-runs (Phase 1.3).
        if (continuationsUsed >= continuationBudget) break;
        const contResult = await runContinuation({
          prompt:
            `Your previous attempt did NOT fully satisfy the request. Judge feedback: "${reason}". ` +
            `Original request: "${turnObjective}". ` +
            `IMPORTANT: if finishing requires the USER'S decision or authorization — sending, posting, or deleting something external, or scope left open — do NOT proceed on your own; end your reply with the concrete question for the user. That is a correct, complete answer. ` +
            `Otherwise continue now and FINISH it — produce the concrete artifact/evidence (file, sheet row, message, link, real result); do not just describe or promise it.`,
          ...cleanContinuationRunOptions(),
        });
        continuationsUsed += 1;
        if (!contResult) break; // parse stumble on a continuation → keep the prior good result
        result = mergeClaudeRunEvidence(result, contResult);
        if (contResult.limitHit) break;
      }
    }

    // F1 — auto-continue past a MAX-TURNS budget stop instead of PARKING on "say
    // continue". A per-query turn cap must not stop an autonomous run that is STILL
    // making forward progress (toolUses > 0). Each continuation re-runs with the
    // progress-so-far in the prompt + a fresh turn budget; the stateless SDK lane
    // (persistSession:false) tracks progress in its own reply, so we hand that back
    // and tell it to finish the REST without redoing. Bounded by count + total
    // wall-clock; the per-query tool-ceiling/wall-clock stay the hard backstops.
    if (result.limitHit && !result.selfStopped && sdkAutoContinueEnabled()) {
      // !selfStopped: an anti-thrash loop-stop must not auto-continue (re-running
      // it just re-loops — restores the guard the 33-shell-call incident added).
      const autoStart = Date.now();
      let autoContinues = 0;
      // TURN-CONTROL SPINE (policy 2026-07-16): an auto-continue means a full
      // turn budget is gone and we're about to grind on while a chat user
      // waits — the exact boundary where the loop lane's mid-turn nudge fires.
      // The SDK lane's wrapped tools get that nudge too, but the native-MCP
      // tier never does, so a run grinding on external tools reaches this
      // point un-nudged. One-shot per run; skipped when an offer already
      // stands or the session isn't an interactive chat.
      let backgroundOfferNudged = false;
      // Re-inject any SKILL bodies loaded this run into the continuation. The stateless
      // SDK lane rebuilds each query from the transcript, which EXCLUDES tool results —
      // so a `skill_read` from turn 1 is LOST on the continuation, and the model would
      // hand-roll the back half (then get bounced by the skill-execution gate → oscillate).
      // Carry the procedure forward so a skill-driven multi-tool run survives the turn cap.
      const reinjectedSkills = (() => {
        try {
          const skills = gatherSessionSkills(sessionId);
          if (skills.length === 0) return '';
          const bodies = skills.map((s) => `## Skill you already loaded: ${s.name} — KEEP FOLLOWING it\n${s.body.slice(0, 8000)}`).join('\n\n');
          return `\n\nThese are the skill procedure(s) you loaded earlier this run (their content is not in this fresh context) — FOLLOW them for the remaining work; you do NOT need to skill_read again:\n${bodies}\n`;
        } catch { return ''; }
      })();
      // A3 recall ledger: continuations run in FRESH context (tool RESULTS from
      // earlier segments are lost) — hand the model each earlier call's id so it
      // can tool_output_query(callId) the stored result instead of re-fetching.
      // Lossless-recall parity with the Codex lane's clip stubs.
      let continuationLedger = [...(result.toolCallLedger ?? [])];
      const renderLedger = (): string => {
        if (continuationLedger.length === 0) return '';
        const lines: string[] = [];
        let bytes = 0;
        for (const entry of continuationLedger) {
          const line = `- ${entry.name} [${entry.callId}] ${entry.argsPreview}`;
          bytes += line.length + 1;
          if (bytes > 4000) { lines.push(`- …(+${continuationLedger.length - lines.length} more calls)`); break; }
          lines.push(line);
        }
        return `\n\nTool calls you already made this run (their FULL results are stored — pull any of them with tool_output_query("<call id>") instead of re-running the tool):\n${lines.join('\n')}\n`;
      };
      while (
        result.limitHit
        && !result.selfStopped // a continuation that anti-thrash loop-STOPPED must NOT be re-run (would re-loop)
        && result.toolUses.length > 0
        && autoContinues < maxSdkAutoContinues()
        && (Date.now() - autoStart) < sdkAutoContinueWallMs()
        && !budgetWindowExhausted() // Stage 4: never auto-continue past the token window
      ) {
        const progress = (result.text || '').trim().slice(0, 1500);
        const offerBackground = !backgroundOfferNudged
          && !sessionHasBackgroundOffer(sessionId)
          && shouldOfferBackground({
            sessionId,
            toolCalls: result.toolUses.length,
            elapsedMs: Date.now() - autoStart,
            alreadyNudged: false,
          });
        if (offerBackground) {
          backgroundOfferNudged = true;
          try {
            appendEvent({ sessionId, turn: 0, role: 'system', type: 'heartbeat', data: { kind: 'background_offer_nudge', boundary: 'sdk_auto_continue', attempt: autoContinues + 1 } });
          } catch { /* telemetry best-effort */ }
        }
        const cont = await runContinuation({
          prompt:
            `You hit the per-turn tool budget but the task is NOT finished. Your progress so far:\n${progress}${reinjectedSkills}${renderLedger()}\n\n`
            + `Continue from where you left off and FINISH ALL remaining items from the original request: "${turnObjective}". `
            + (offerBackground
              ? `Do NOT redo items already completed above. ${BACKGROUND_OFFER_TEXT}`
              : `Do NOT redo items already completed above — do the REMAINING ones. Produce the concrete results (data/artifact), and do not stop to ask.`),
          ...cleanContinuationRunOptions(),
        });
        autoContinues += 1;
        if (!cont) break; // a parse stumble on a continuation → keep the prior partial
        continuationLedger = [...continuationLedger, ...(cont.toolCallLedger ?? [])];
        result = mergeClaudeRunEvidence(result, cont);
        try {
          appendEvent({ sessionId, turn: 0, role: 'system', type: 'sdk_auto_continue', data: { attempt: autoContinues, stillLimited: Boolean(cont.limitHit) } });
        } catch { /* telemetry best-effort */ }
      }
    }

    // A parsed create response is not enough to claim a document/site exists.
    // Give bound-but-unverified pointers ONE deterministic exact-ID read-back
    // query after all ordinary continuations. This query cannot create or list;
    // the durable ledger prevents a retry from duplicating the resource.
    if (!result.limitHit && !resultIsAwaitingInput()) {
      let unresolved = logicalRunScopeId
        ? listUnverifiedRunArtifacts(sessionId, logicalRunScopeId)
        : [];
      const repairable = unresolved.filter(
        (artifact) => artifact.status === 'bound'
          && Boolean(artifact.resourceId)
          && (artifact.kind === 'google_doc' || artifact.kind === 'site'),
      );
      if (repairable.length > 0) {
        try {
          appendEvent({
            sessionId,
            turn: 0,
            role: 'system',
            type: 'heartbeat',
            data: { kind: 'artifact_verification_repair', count: repairable.length },
          });
        } catch { /* telemetry best-effort */ }
        const priorResult = result;
        let verification: ClaudeAgentSdkRunResult | null = null;
        try {
          verification = await runContinuation({
            prompt: renderArtifactVerificationPrompt(repairable),
            ...cleanContinuationRunOptions(),
            artifactVerificationOnly: repairable.flatMap((artifact) =>
              artifact.resourceId && (artifact.kind === 'google_doc' || artifact.kind === 'site')
                ? [{ kind: artifact.kind, resourceId: artifact.resourceId }]
                : []),
          });
        } catch (error) {
          try {
            appendEvent({
              sessionId,
              turn: 0,
              role: 'system',
              type: 'guardrail_tripped',
              data: {
                kind: 'artifact_verification_unavailable',
                reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
              },
            });
          } catch { /* telemetry best-effort */ }
        }
        if (verification) {
          const merged = mergeClaudeRunEvidence(priorResult, verification);
          // Verification is internal QA. Keep the original user-facing result
          // while retaining the getter's durable tool evidence.
          result = {
            ...merged,
            text: priorResult.text,
            limitHit: priorResult.limitHit,
            selfStopped: priorResult.selfStopped,
            stoppedReason: priorResult.stoppedReason,
          };
        }
        unresolved = logicalRunScopeId
          ? listUnverifiedRunArtifacts(sessionId, logicalRunScopeId)
          : [];
      }
      if (unresolved.length > 0) {
        artifactVerificationPending = unresolved;
        result = {
          ...result,
          text: renderUnverifiedArtifactReply(unresolved),
          limitHit: false,
          selfStopped: false,
          stoppedReason: 'awaiting-input',
        };
      }
    }
    // Snapshot unresolved artifact state for every terminal disposition. A
    // provider-backed resource can be created before the model asks a material
    // question; that pause must carry the binding forward rather than letting
    // the user's answer start a fresh root and create a duplicate. Verification
    // itself remains deferred while awaiting input.
    logicalRunScopeId = result.artifactRunScopeId ?? logicalRunScopeId;
    artifactVerificationPending = logicalRunScopeId
      ? listUnverifiedRunArtifacts(sessionId, logicalRunScopeId)
      : [];
  } catch (err) {
    // Model-work failures are live exceptions, not silent report-back losses, so
    // preserve the pre-existing behavior: clear the marker and let the caller see
    // the error. Final-delivery/report-back failures below intentionally leave the
    // marker armed until durable terminal reporting succeeds.
    markRunInFlight(sessionId, false);
    // TURN-CONTROL SPINE: a kill-switch cancellation is a USER action, not a
    // failure — return a clean stopped reply instead of a raw error bubbling
    // to the chat surface. Only when the kill row is actually set (a caller's
    // own shouldCancel keeps its existing propagation semantics).
    if (err instanceof AgentRuntimeCancelledError) {
      try {
        appendEvent({ sessionId, turn: 0, role: 'system', type: 'kill_requested', data: { reason: 'during run (sdk lane)', attemptId: attempt.attemptId } });
      } catch { /* telemetry best-effort */ }
      const stoppedText = 'Stopped — you asked me to halt this run. Nothing further will execute; tell me how you\'d like to proceed.';
      return { ...cancelledBrainResponse(sessionId, attempt, stoppedText), turnsUsed: 1 };
    }
    throw err;
  }

  let text = result.limitHit
    ? renderLimitHitReply(result.text)
    : (result.text.trim() || '(no reply produced)');
  // ROOT-CAUSE guard (2026-07-01 Scorpion-calendar): if the FINAL reply is itself SHAPED like
  // a printed tool call — the model narrated instead of invoking, and the retry corrective
  // didn't fix it (or `limitHit` short-circuited it) — do NOT show the user raw
  // `{"tool_call":…}`/`[Tool: X]` and, critically, do NOT persist it as the durable reply
  // (which would replay next turn as a `YOU:` exemplar and TEACH the model to keep narrating —
  // the self-reinforcing loop). Replace with a neutral, honest fallback. Only when no real tool
  // fired (a legitimate summary that mentions a tool is fine).
  if (!result.limitHit && result.toolUses.length === 0 && looksLikeToolCallShape(text)) {
    // SELF-HEAL, not apology (live 2026-07-01 Discord calendar): a narration
    // give-up means ZERO tools ran, so re-dispatching the whole turn on the
    // OTHER brain is side-effect-safe — throw a typed error so the bridge's
    // cross-brain fallover completes the ask for real. The bridge falls back
    // to this error's graceful message when fallover is off/unavailable.
    markRunInFlight(sessionId, false);
    try {
      appendEvent({ sessionId, turn: 0, role: 'system', type: 'guardrail_tripped', data: { kind: 'narration_giveup_fallover', preview: text.slice(0, 120) } });
    } catch { /* telemetry best-effort */ }
    throw new ClaudeSdkNarrationGiveUpError(
      'I started to turn that into an action but it did not go through as a real tool call. Say the word and I will run it properly.',
    );
  }
  // Deliver only the missing final chunk. If the exact final already streamed,
  // avoid a double-render. If a judge/retry replaced the answer, append the
  // authoritative final reply so direct callers are not left with stale partial
  // text while SSE/Discord still settle via conversation_completed.
  const finalDelta = finalChunkDelta(text, streamedText, streamedAny);
  if (request.onChunk && finalDelta) await request.onChunk(finalDelta);
  // Long-running parity: a turn-budget stop surfaces as a graceful
  // "say continue", not a failure (claude-agent-sdk.ts returns limitHit).
  const stoppedReason: AssistantResponse['stoppedReason'] =
    result.stoppedReason
    ?? (result.limitHit
      ? (budgetWindowExhausted() ? 'token-budget' : 'max-turns-with-grace')
      : 'success');
  const awaitingInput = stoppedReason === 'awaiting-input';
  // Report-back / observability parity (gap analysis): the harness loop emits
  // conversation_completed + runtime.completed on a clean terminal so the Tasks
  // board, report-back, and watchdog see the run. The Agent SDK lane runs its
  // own loop, so emit the same terminal events here. A turn-budget stop is NOT
  // a clean completion: emit limit telemetry first, then the user-facing
  // conversation_completed continue prompt, matching the main harness loop.
  if (result.limitHit) {
    try {
      appendEvent({
        sessionId,
        turn: 0,
        role: 'system',
        type: 'conversation_limit_exceeded',
        data: { reason: 'max_turns', maxTurns: maxTurns(), transport: 'claude_agent_sdk_brain' },
      });
    } catch { /* limit telemetry is best-effort */ }
  }
  // `ask_user_question` normally records this inside the local tool itself,
  // but the SDK can also classify a direction-seeking plain-text reply as
  // awaiting input. Persist the canonical pause in either case so restart,
  // transcript replay, and the next-turn convergence steer all observe the
  // same state. Do not duplicate a tool-recorded ask from this user turn.
  if (awaitingInput) {
    try {
      const recent = listEvents(sessionId, {
        types: ['user_input_received', 'awaiting_user_input'],
        desc: true,
        limit: 40,
      });
      const latestUser = recent.filter((event) => event.type === 'user_input_received').at(-1);
      const latestAsk = recent.filter((event) => event.type === 'awaiting_user_input').at(-1);
      if (!latestAsk || (latestUser && latestAsk.seq < latestUser.seq)) {
        appendEvent({
          sessionId,
          turn: 0,
          role: 'Clem',
          type: 'awaiting_user_input',
          data: { question: text, source: 'decision_awaiting' },
        });
      }
    } catch { /* pause telemetry is best-effort; completion below remains authoritative */ }
  }
  let terminalEventRecorded = false;
  let terminalEventInserted = false;
  try {
    const terminal = appendTerminalEventOnce({
      sessionId,
      turn: 0,
      role: 'system',
      data: {
        attemptId: attempt.attemptId,
        ...(attempt.runId ? { runId: attempt.runId } : {}),
        reason: result.limitHit
          ? 'awaiting_continue'
          : awaitingInput
            ? 'awaiting_user_input'
            : 'claude_agent_sdk_brain',
        summary: text.slice(0, 400),
        reply: text,
        ...(logicalRunScopeId ? { artifactRunScopeId: logicalRunScopeId } : {}),
        ...(awaitingInput ? { awaitingUser: true } : {}),
        ...(artifactVerificationPending.length > 0
          ? {
              artifactVerification: {
                status: 'pending',
                count: artifactVerificationPending.length,
                resources: artifactVerificationPending.map((artifact) => ({
                  kind: artifact.kind,
                  provider: artifact.provider,
                  resourceId: artifact.resourceId,
                  uri: artifact.uri,
                  state: artifact.status,
                })),
              },
            }
          : {}),
        // Move 4: surface degraded verification so a self-judged / judge-failed-open
        // completion is distinguishable from an independently-verified one.
        ...(completionVerification ? { verification: completionVerification } : {}),
        ...(result.limitHit ? { transport: 'claude_agent_sdk_brain', maxTurns: maxTurns() } : {}),
      },
    }, `brain:${attempt.attemptId}`);
    terminalEventRecorded = true;
    terminalEventInserted = terminal.inserted;
  } catch { /* terminal telemetry is best-effort, but controls recovery marker clearing */ }
  if (terminalEventInserted) {
    try { actionBus.emit({ kind: 'runtime.completed', sessionId }); } catch { /* best-effort */ }
  }
  if (terminalEventRecorded) markRunInFlight(sessionId, false);
  // The transcript reader consumes conversation_completed, so refresh only
  // after that terminal row is durable. The old pre-dispatch hook always wrote
  // a user-only snapshot and lagged the assistant by one turn. Keep this
  // per-session-only so the model-authored global scratchpad is never clobbered.
  if (terminalEventRecorded) {
    try {
      const wmSession = getSession(sessionId);
      const wmChannel = wmSession?.channel ?? undefined;
      if (wmSession?.kind === 'chat' && isUserFacingSession(sessionId, wmChannel)) {
        refreshWorkingMemoryForSession(sessionId, wmChannel);
      }
    } catch { /* working-memory observability must never affect delivery */ }
  }
  // Post-turn memory credit: match this turn's primer recall run against the
  // reply + tool-use record and credit demonstrable use (code-level
  // replacement for the never-called memory_mark_used prompt rule).
  try {
    const credited = autoCreditRecallRuns({
      recallIds: [renderedTurnContext.memoryPrimer.recallId],
      replyText: text,
      toolArgTexts: result.toolUses,
    });
    if (credited.length > 0) {
      appendEvent({
        sessionId, turn: 0, role: 'system', type: 'recall_auto_credit',
        data: {
          runs: credited.map((o) => ({
            recallId: o.recallId,
            refs: o.credited.map((d) => ({ ref: `${d.ref.type}:${d.ref.id}`, evidence: d.evidence })),
          })),
        },
      });
    }
  } catch { /* crediting is bookkeeping; it must never break the turn */ }
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
      stoppedReason,
      ...(logicalRunScopeId ? { artifactRunScopeId: logicalRunScopeId } : {}),
      ...(toolEconomyState
        ? {
            toolEconomy: {
              policy: toolEconomyState.policy.kind,
              softLimit: toolEconomyState.policy.softLimit,
              hardLimit: toolEconomyState.policy.hardLimit,
              attempts: toolEconomyState.attempts,
              allowed: toolEconomyState.allowed,
              finishPhase: toolEconomyState.finishPhase,
            },
          }
        : {}),
      ...(artifactVerificationPending.length > 0
        ? { artifactVerification: 'pending' }
        : {}),
    },
  };
}
