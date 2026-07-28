import { classifyRuntimeToolEffect } from './tool-effect.js';
import { getRuntimeEnv } from '../../config.js';

/**
 * Run-level tool economy for interactive turns.
 *
 * The ordinary per-query ceiling protects against an infinite SDK loop, but it
 * was intentionally set high and reset on every continuation. In the July 16
 * incident that still allowed 87 real top-level calls while producing one
 * document. This state is owned by the logical brain attempt and shared by all
 * of its continuations. It counts provider call ids (not MCP mirrors or
 * code-mode children), shifts a single-deliverable turn into a bounded finish
 * phase, and leaves explicit batch/background execution on their own rails.
 */

export type ToolEconomyKind = 'single_deliverable' | 'artifact_build' | 'interactive' | 'deep' | 'multi_item';

export interface ToolEconomyPolicy {
  kind: ToolEconomyKind;
  /** After this many top-level attempts, exploratory reads are refused. */
  softLimit: number;
  /** After this many top-level calls, ordinary attempts are terminally
   * refused. A tiny, separately-counted artifact-completion reserve may admit
   * only terminal writes/exact verification. */
  hardLimit: number;
}

export interface ToolEconomyState {
  policy: ToolEconomyPolicy;
  attempts: number;
  allowed: number;
  softRefusals: number;
  /** Goal-advancing completion calls admitted after the ordinary hard limit.
   * This is deliberately a tiny reserve, not a second general-purpose runway. */
  completionReserveUsed: number;
  finishPhase: boolean;
  /** Canonical provider-call decisions. SDK permission callbacks can replay,
   * including after a deny. Keeping the decision (not only a seen bit) makes a
   * replay free without turning a prior refusal into an allow. */
  callDecisions: Map<string, {
    signature: string;
    verdict: ToolEconomyVerdict | null;
  }>;
}

export interface ToolEconomyVerdict {
  kind: 'finish_phase' | 'hard_stop';
  behavior: 'deny';
  interrupt: boolean;
  message: string;
  attempt: number;
  policy: ToolEconomyPolicy;
  /** Enforce cached denials, but do not emit canonical accounting twice. */
  replayed?: boolean;
}

const SINGLE_DELIVERABLE_RE =
  /\b(?:google\s+doc(?:ument)?|docx?|document|report|proposal|deck|presentation|pdf|spreadsheet|google\s+sheet|website|web\s*site|landing\s+page)\b/i;
const COMPLEX_ARTIFACT_RE =
  /\b(?:workspace|dashboard|portal|cockpit|command\s+center|interactive\s+(?:app|application|tracker|calendar|board))\b/i;
const ARTIFACT_EXPLORATION_RE =
  /\b(?:brainstorm|ideate|talk\s+through|discuss\s+(?:what|how|whether)|explore\s+(?:what|how|whether|options)|(?:how|whether)\s+(?:we|i|you)\s+(?:might|could|would))\b/i;
const EXECUTION_RE =
  /\b(?:create|make|build|write|draft|generate|turn|transform|convert|publish|deploy|host|prepare|produce|assemble)\b/i;
const DEEP_RE =
  /\b(?:deep(?:ly)?|exhaustive(?:ly)?|comprehensive(?:ly)?|everything|take\s+your\s+time|thorough(?:ly)?|all\s+available)\b/i;
const MULTI_ITEM_RE =
  /\b(?:batch|bulk|for\s+each|each\s+of|all\s+of\s+them|\d{1,3}\s+(?:[a-z][\w'-]*\s+){0,3}[a-z][a-z'-]*s)\b/i;
const COMPLETION_RESERVE = 4;

/** True only for an execution-ready complex artifact request. Mentioning or
 * brainstorming a Workspace does not widen either rail. */
export function isComplexArtifactExecutionObjective(
  text: string,
  recentContext: readonly string[] = [],
): boolean {
  if (!EXECUTION_RE.test(text) || ARTIFACT_EXPLORATION_RE.test(text)) return false;
  if (COMPLEX_ARTIFACT_RE.test(text)) return true;
  // A short execution follow-up ("build it", "create that now") can inherit
  // WHAT is being built, but not the execution decision, from recent user
  // context. Prior brainstorming language must not cancel today's explicit
  // command, and a prior artifact mention alone cannot widen a non-execution
  // turn.
  return recentContext.slice(0, 4).some((prior) => COMPLEX_ARTIFACT_RE.test(prior));
}

export function interactiveToolEconomyEnabled(): boolean {
  const value = (getRuntimeEnv('CLEMMY_INTERACTIVE_TOOL_ECONOMY', 'on') ?? 'on').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(value);
}

export function interactiveToolEconomyPolicy(input: {
  message: string;
  priorMessages?: readonly string[];
  multiItem?: boolean;
  /** The session's harness budget. On the `long`/`unlimited` presets the
   *  user explicitly bought a higher per-turn tool budget; the economy's
   *  text-shape limits must never hard-stop BELOW that ceiling (a guardrail
   *  informs, it does not override an explicit setting). `standard` keeps
   *  the tight text-shape limits unchanged. */
  budget?: { preset: 'standard' | 'long' | 'unlimited'; toolCallsPerTurn: number };
}): ToolEconomyPolicy {
  const text = [input.message, ...(input.priorMessages ?? []).slice(0, 4)].join('\n');
  const classified = ((): ToolEconomyPolicy => {
    if (input.multiItem || MULTI_ITEM_RE.test(text)) {
      // A multi-item chat should normally fan out or dispatch one approved batch.
      // Keep extra headroom for resolving that structure, without restoring the
      // old 300-call foreground runway.
      return { kind: 'multi_item', softLimit: 16, hardLimit: 28 };
    }
    if (DEEP_RE.test(text)) return { kind: 'deep', softLimit: 14, hardLimit: 24 };
    if (isComplexArtifactExecutionObjective(input.message, input.priorMessages ?? [])) {
      // Complex local artifacts normally require schema acquisition, source
      // authoring, a local proof, the durable save, and a refresh/read-back.
      // Keep that sequence bounded by the same 24-call ceiling used for deep
      // work, but begin steering only after enough room for acquisition.
      return { kind: 'artifact_build', softLimit: 16, hardLimit: 24 };
    }
    if (SINGLE_DELIVERABLE_RE.test(text) && EXECUTION_RE.test(text)) {
      return { kind: 'single_deliverable', softLimit: 10, hardLimit: 15 };
    }
    return { kind: 'interactive', softLimit: 12, hardLimit: 20 };
  })();
  const budget = input.budget;
  if (
    budget
    && (budget.preset === 'long' || budget.preset === 'unlimited')
    && Number.isFinite(budget.toolCallsPerTurn)
    && budget.toolCallsPerTurn > classified.hardLimit
  ) {
    // Lift, never lower: the finish-phase steer still starts early enough to
    // matter (60% of the ceiling), but the hard stop aligns with the per-turn
    // budget the user chose instead of firing at a quarter of it.
    return {
      kind: classified.kind,
      softLimit: Math.max(classified.softLimit, Math.floor(budget.toolCallsPerTurn * 0.6)),
      hardLimit: budget.toolCallsPerTurn,
    };
  }
  return classified;
}

export function createToolEconomyState(policy: ToolEconomyPolicy): ToolEconomyState {
  return {
    policy,
    attempts: 0,
    allowed: 0,
    softRefusals: 0,
    completionReserveUsed: 0,
    finishPhase: false,
    callDecisions: new Map(),
  };
}

function stableCallValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableCallValue).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableCallValue(record[key])}`).join(',')}}`;
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'undefined') return 'undefined';
  try { return JSON.stringify(value); } catch { return JSON.stringify(String(value)); }
}

function callSignature(toolName: string, args: unknown): string {
  return `${toolName.trim()}\n${stableCallValue(args)}`;
}

function cacheDecision(
  state: ToolEconomyState,
  callId: string | undefined,
  signature: string,
  verdict: ToolEconomyVerdict | null,
): void {
  const id = callId?.trim();
  if (id) state.callDecisions.set(id, { signature, verdict });
}

function toolTail(toolName: string): string {
  return toolName.replace(/^mcp__/, '').split('__').at(-1)?.toLowerCase() ?? toolName.toLowerCase();
}

function decodeJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try { return JSON.parse(trimmed) as unknown; } catch { return value; }
}

function resolvedInvocation(toolName: string, args: unknown): { toolName: string; args: unknown } {
  if (toolTail(toolName) !== 'call_tool') return { toolName, args };
  const decoded = decodeJsonValue(args);
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return { toolName, args };
  const input = decoded as Record<string, unknown>;
  const target = typeof input.name === 'string' ? input.name.trim() : '';
  if (!target || toolTail(target) === 'call_tool') return { toolName, args };
  return { toolName: target, args: decodeJsonValue(input.args_json ?? input.arguments ?? {}) };
}

function shellCommand(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const command = (args as Record<string, unknown>).command;
  return typeof command === 'string' ? command : '';
}

function argumentRecord(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const record = args as Record<string, unknown>;
  const nested = record.arguments;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  if (typeof nested === 'string' && nested.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(nested) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* malformed provider arguments are not an exact read-back */ }
  }
  return record;
}

function dispatchedAction(toolName: string, args: unknown): string {
  const resolved = resolvedInvocation(toolName, args);
  const tail = toolTail(resolved.toolName);
  if (tail === 'composio_execute_tool' && resolved.args && typeof resolved.args === 'object' && !Array.isArray(resolved.args)) {
    const slug = (resolved.args as Record<string, unknown>).tool_slug;
    return typeof slug === 'string' ? slug.toLowerCase() : tail;
  }
  return tail.startsWith('cx_') ? tail.slice(3) : tail;
}

function hasExactResourceId(args: unknown, keys: readonly string[]): boolean {
  const values = argumentRecord(args);
  return keys.some((key) => typeof values[key] === 'string' && (values[key] as string).trim().length > 0);
}

/** A finish-phase read must name the resource it is proving. Broad list,
 * search, and discovery tools are deliberately excluded even when their name
 * happens to contain `get_document`. */
function isExactReadBack(toolName: string, args: unknown): boolean {
  const action = dispatchedAction(toolName, args);
  if (/^(?:googledocs_)?get_document(?:_plaintext|_by_id)?$/i.test(action)) {
    return hasExactResourceId(args, ['document_id', 'documentId', 'id']);
  }
  if (/^(?:netlify_)?get_?site$/i.test(action)) {
    return hasExactResourceId(args, ['site_id', 'siteId', 'id']);
  }
  if (/^(?:artifact_)?(?:verify|readback|read_back)$/i.test(action)) {
    return hasExactResourceId(args, ['resource_id', 'resourceId', 'document_id', 'documentId', 'site_id', 'siteId', 'id']);
  }
  return false;
}

/** Calls still useful after exploration ends: create/update the deliverable,
 * verify/read it back, synthesize cached results in one program, render/test the
 * local artifact, ask the blocking question, or move the work to background. */
export function isFinishPhaseTool(toolName: string, args: unknown): boolean {
  const resolved = resolvedInvocation(toolName, args);
  const tail = toolTail(resolved.toolName);
  if (tail === 'run_worker') return false;
  if (
    /^(?:run_tool_program|run_batch|recall_tool_result|tool_output_query|workspace_artifact_query|ask_user_question|offer_background|dispatch_background_task)$/.test(tail)
  ) return true;
  if (isExactReadBack(resolved.toolName, resolved.args)) return true;
  const effect = classifyRuntimeToolEffect(toolName, args);
  if (effect.effect === 'local_write' || effect.effect === 'external_write') return true;
  if (tail === 'run_shell_command') {
    const command = shellCommand(resolved.args);
    return /\b(?:build|render|test|typecheck|lint|pandoc|libreoffice|ffmpeg|playwright|netlify\s+api\s+getSite)\b/i.test(command)
      || /(?:^|[;&|\n]\s*)(?:node|tsx|python3?|bash|sh)\s+(?:--[\w-]+(?:=\S+)?\s+)*[^\s;&|]+\.(?:[cm]?js|ts|py|sh)(?:\s|$)/i.test(command);
  }
  return false;
}

/** Narrow subset allowed to consume the post-limit completion reserve. It
 * covers durable artifact authoring and exact verification, but not sends,
 * publishing, deletion, broad discovery, or arbitrary external mutations. */
function isCompletionReserveTool(toolName: string, args: unknown): boolean {
  const resolved = resolvedInvocation(toolName, args);
  const tail = toolTail(resolved.toolName);
  if (isExactReadBack(resolved.toolName, resolved.args)) return true;
  if (
    /^(?:write_file|space_(?:save|refresh|set_data|edit_view|edit_runner|try_runner)|workflow_(?:create|update))$/.test(tail)
  ) return true;
  if (tail === 'run_shell_command') {
    const effect = classifyRuntimeToolEffect(toolName, args);
    if (effect.effect === 'local_write') return true;
    return isFinishPhaseTool(toolName, args);
  }
  const action = dispatchedAction(resolved.toolName, resolved.args);
  return /^(?:create|update|write|save|edit|append|replace)_(?:document|doc|spreadsheet|sheet|presentation|deck|pdf|site|page|file|artifact)$/i.test(action)
    || /^(?:(?:google)?docs?|sheets?|netlify)_(?:create|update|write|save|edit|append|replace)_(?:document|doc|spreadsheet|sheet|presentation|deck|pdf|site|page|file|artifact)$/i.test(action);
}

/** One permission-boundary decision. The provider call id makes replayed SDK
 * frames/accounting callbacks free; mirrors and code-mode children never call
 * this logical-run state in the first place. */
export function evaluateToolEconomy(input: {
  state: ToolEconomyState;
  toolName: string;
  args: unknown;
  callId?: string;
}): ToolEconomyVerdict | null {
  const { state } = input;
  const id = input.callId?.trim();
  const signature = callSignature(input.toolName, input.args);
  if (id) {
    const prior = state.callDecisions.get(id);
    if (prior) {
      if (prior.signature !== signature) {
        state.finishPhase = true;
        return {
          kind: 'hard_stop',
          behavior: 'deny',
          interrupt: true,
          attempt: state.attempts,
          policy: state.policy,
          replayed: true,
          message:
            'A provider tool-call id was replayed with a different tool or payload. Stop this foreground turn: the altered replay is denied and must not be dispatched or counted as a fresh call.',
        };
      }
      return prior.verdict ? { ...prior.verdict, replayed: true } : null;
    }
  }
  state.attempts += 1;
  const finishTool = isFinishPhaseTool(input.toolName, input.args);
  if (state.attempts > state.policy.hardLimit) {
    state.finishPhase = true;
    if (finishTool && isCompletionReserveTool(input.toolName, input.args) && state.completionReserveUsed < COMPLETION_RESERVE) {
      state.completionReserveUsed += 1;
      state.softRefusals = 0;
      state.allowed += 1;
      cacheDecision(state, id, signature, null);
      return null;
    }
    const verdict: ToolEconomyVerdict = {
      kind: 'hard_stop',
      behavior: 'deny',
      interrupt: true,
      attempt: state.attempts,
      policy: state.policy,
      message:
        `This foreground run reached its ${state.policy.hardLimit}-call top-level budget. Stop now and report the concrete results already gathered, including any bound artifact id; do not retry or create a replacement. Offer background execution if substantial work remains.`,
    };
    cacheDecision(state, id, signature, verdict);
    return verdict;
  }
  if (state.attempts > state.policy.softLimit) {
    state.finishPhase = true;
    if (!finishTool) {
      state.softRefusals += 1;
      const terminal = state.softRefusals >= 3;
      const verdict: ToolEconomyVerdict = {
        kind: terminal ? 'hard_stop' : 'finish_phase',
        behavior: 'deny',
        interrupt: terminal,
        attempt: state.attempts,
        policy: state.policy,
        message: terminal
          ? 'The finish-phase steer was ignored three times. End this foreground turn with the evidence already collected; do not make another exploratory call.'
          : 'Finish phase: stop exploring. Synthesize from existing tool results (use tool_output_query/recall_tool_result if needed). Only the requested artifact write, one exact read-back verification, a batched run_tool_program, or a blocking/background handoff may run now.',
      };
      cacheDecision(state, id, signature, verdict);
      return verdict;
    }
    // A successful transition from exploration into concrete execution means
    // the model followed the steer. Old refusals must not later combine with a
    // verification call to manufacture a "three ignored steers" interrupt.
    state.softRefusals = 0;
  }
  state.allowed += 1;
  cacheDecision(state, id, signature, null);
  return null;
}
