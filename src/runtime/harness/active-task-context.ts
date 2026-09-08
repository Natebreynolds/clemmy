import { createHash } from 'node:crypto';
import { getRuntimeEnv } from '../../config.js';
import type { FocusRow } from '../../memory/db.js';
import {
  getFocusSnapshot,
  getFocusWorkstate,
  type FocusWorkstate,
} from '../../memory/focus.js';
import {
  getActiveGoalForSession,
  getCurrentGoalStage,
  GOAL_DEFAULT_MAX_ATTEMPTS,
  type PlanProposal,
} from '../../agents/plan-proposals.js';
import {
  focusSummaryIsHistoricalForRequest,
  renderHistoricalFocusPointer,
} from './focus-projection.js';
import { currentInputSuppressesPriorTask } from './current-task-authority.js';

/**
 * Provider-neutral, read-only projection of Clementine's active task state.
 *
 * Authority remains split deliberately:
 *   - current_focus + FocusWorkstate own the conversational notebook;
 *   - the exact-session active goal owns externally validated completion;
 *   - this module only composes those stores for prompt / graph consumption.
 *
 * Keeping the projection typed and deterministic lets a graph context node
 * consume the same value that every provider prompt renders, without adding a
 * second persistence lane.
 */
export const ACTIVE_TASK_CONTEXT_VERSION = 1;

const PARKED_FOCUS_LIMIT = 5;
const FOCUS_WORKSTATE_PROMPT_MAX_CHARS = 6_000;
const FOCUS_PROMPT_MAX_CHARS = 7_500;
const GOAL_PROMPT_MAX_CHARS = 4_000;
export const ACTIVE_TASK_CONTEXT_PROMPT_MAX_CHARS = FOCUS_PROMPT_MAX_CHARS + GOAL_PROMPT_MAX_CHARS + 2;
const PROMPT_LINE_MAX_CHARS = 180;

export type ActiveTaskFocusDisposition = 'active' | 'historical' | 'stale';

export interface ActiveTaskParkedFocus {
  id: number;
  title: string;
  summary: string;
}

export interface ActiveTaskFocusContext {
  disposition: ActiveTaskFocusDisposition;
  id: number;
  title: string;
  /** Omitted for historical pointers so prior prose cannot become evidence. */
  summary?: string;
  resourceRef: string;
  resourceKind?: string;
  relatedSessionId?: string;
  lastTouchedAt: string;
  /** Present only for a fresh, non-historical focus. */
  workstate: FocusWorkstate | null;
}

export interface ActiveTaskGoalStage {
  index: number;
  total: number;
  title: string;
}

export interface ActiveTaskGoalContext {
  id: string;
  sessionId: string;
  objective: string;
  stage?: ActiveTaskGoalStage;
  successCriteria: string[];
  progressLedger: string[];
  attempt: number;
  maxAttempts: number;
}

export interface ActiveTaskContext {
  version: typeof ACTIVE_TASK_CONTEXT_VERSION;
  source: 'current_focus';
  sessionId: string | null;
  focus: ActiveTaskFocusContext | null;
  parked: ActiveTaskParkedFocus[];
  goal: ActiveTaskGoalContext | null;
  /** Stable for the same persisted inputs; suitable for graph-node telemetry. */
  digest: string;
}

export interface ResolveActiveTaskContextOptions {
  sessionId?: string;
  input?: string;
}

function compact(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function cloneWorkstate(state: FocusWorkstate | null): FocusWorkstate | null {
  if (!state) return null;
  return {
    version: state.version,
    updatedAt: state.updatedAt,
    ...(state.mode ? { mode: state.mode } : {}),
    ...(state.objective ? { objective: state.objective } : {}),
    candidates: state.candidates.map((candidate) => ({ ...candidate })),
    constraints: [...state.constraints],
    decisions: [...state.decisions],
    openLoops: [...state.openLoops],
    actions: state.actions.map((action) => ({ ...action })),
  };
}

function projectParkedFocus(row: FocusRow): ActiveTaskParkedFocus {
  return {
    id: row.id,
    title: compact(row.title, 240),
    summary: compact(row.summary, 600),
  };
}

function projectFocus(
  row: FocusRow,
  disposition: ActiveTaskFocusDisposition,
): ActiveTaskFocusContext {
  return {
    disposition,
    id: row.id,
    title: compact(row.title, 240),
    ...(disposition === 'historical' ? {} : { summary: compact(row.summary, 800) }),
    resourceRef: compact(row.resource_ref, 600),
    ...(row.resource_kind ? { resourceKind: compact(row.resource_kind, 80) } : {}),
    ...(row.related_session_id ? { relatedSessionId: compact(row.related_session_id, 200) } : {}),
    lastTouchedAt: compact(row.last_touched_at, 40),
    workstate: disposition === 'active' ? cloneWorkstate(getFocusWorkstate(row)) : null,
  };
}

/** Goal-contract prompt parity kill-switch. Validation uses the same setting. */
export function activeTaskGoalContractsEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_GOAL_CONTRACT', 'on') ?? 'on').toLowerCase() !== 'off';
}

function projectGoal(goal: PlanProposal, sessionId: string): ActiveTaskGoalContext | null {
  // Defense in depth: never trust a related_goal_id or a store lookup that
  // returns a goal belonging to another session.
  if (goal.status !== 'active' || goal.sessionId !== sessionId) return null;
  const plan = goal.approvedPlan ?? goal.plan;
  const objective = compact(plan.objective, 600);
  if (!objective) return null;
  const stages = goal.stages ?? [];
  const currentStage = getCurrentGoalStage(goal);
  const doneCount = stages.filter((stage) => stage.status === 'done').length;
  const criteria = (currentStage ? currentStage.criteria : (plan.successCriteria ?? []))
    .map((criterion) => compact(criterion, 300))
    .filter(Boolean)
    .slice(0, 8);
  return {
    id: compact(goal.id, 160),
    sessionId,
    objective,
    ...(currentStage
      ? {
          stage: {
            index: Math.min(stages.length, doneCount + 1),
            total: stages.length,
            title: compact(currentStage.title, 240),
          },
        }
      : {}),
    successCriteria: criteria,
    progressLedger: (goal.progressLedger ?? [])
      .slice(-8)
      .map((line) => compact(line, 300))
      .filter(Boolean),
    attempt: Math.max(0, Number.isFinite(goal.attempt) ? Number(goal.attempt) : 0),
    maxAttempts: Math.max(
      1,
      Number.isFinite(goal.maxAttempts) ? Number(goal.maxAttempts) : GOAL_DEFAULT_MAX_ATTEMPTS,
    ),
  };
}

function digestContext(value: Omit<ActiveTaskContext, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

export function resolveActiveTaskContext(
  opts: ResolveActiveTaskContextOptions = {},
): ActiveTaskContext {
  const sessionId = opts.sessionId?.trim() || null;
  const suppressPriorTask = currentInputSuppressesPriorTask(opts.input);
  let focus: ActiveTaskFocusContext | null = null;
  let parked: ActiveTaskParkedFocus[] = [];
  if (!suppressPriorTask) {
    try {
      const snapshot = getFocusSnapshot(PARKED_FOCUS_LIMIT);
      parked = snapshot.parked
        .filter((row) => !focusSummaryIsHistoricalForRequest(row, opts.input, sessionId))
        .slice(0, PARKED_FOCUS_LIMIT).map(projectParkedFocus);
      if (snapshot.active) {
        const historical = focusSummaryIsHistoricalForRequest(snapshot.active, opts.input, sessionId);
        const disposition: ActiveTaskFocusDisposition = historical
          ? 'historical'
          : snapshot.needsConfirm
          ? 'stale'
          : 'active';
        // A stale focus from another conversation cannot resolve "these" in
        // this one. Even its title can substitute the wrong task (five old
        // drafts replaced three current drafts after a mobile session split).
        if (!(historical && snapshot.needsConfirm)) focus = projectFocus(snapshot.active, disposition);
      }
    } catch {
      // Focus corruption must not hide an independently valid session goal.
      focus = null;
      parked = [];
    }
  }

  let goal: ActiveTaskGoalContext | null = null;
  if (!suppressPriorTask && sessionId && activeTaskGoalContractsEnabled()) {
    try {
      const stored = getActiveGoalForSession(sessionId);
      goal = stored ? projectGoal(stored, sessionId) : null;
    } catch {
      goal = null;
    }
  }

  const withoutDigest: Omit<ActiveTaskContext, 'digest'> = {
    version: ACTIVE_TASK_CONTEXT_VERSION,
    source: 'current_focus',
    sessionId,
    focus,
    parked,
    goal,
  };
  return { ...withoutDigest, digest: digestContext(withoutDigest) };
}

function boundBlock(text: string, maxChars: number, suffix: string): string {
  if (text.length <= maxChars) return text;
  const tail = `\n${suffix}`;
  const maxBody = Math.max(0, maxChars - tail.length);
  const lineBreak = text.lastIndexOf('\n', maxBody);
  return `${text.slice(0, lineBreak > 0 ? lineBreak : maxBody).trimEnd()}${tail}`;
}

function renderBoundedLines(label: string, values: string[], limit = 8): string[] {
  if (values.length === 0) return [];
  const shown = values.slice(0, limit);
  const lines = [`${label}:`, ...shown.map((value) => `  - ${compact(value, PROMPT_LINE_MAX_CHARS)}`)];
  if (values.length > shown.length) {
    lines.push(`  - … +${values.length - shown.length} more saved; use focus_get only if needed`);
  }
  return lines;
}

/** Compact rendering of the durable conversational notebook. */
export function renderFocusWorkstateForInstructions(state: FocusWorkstate | null): string {
  if (!state) return '';
  const candidates = [...state.candidates]
    .sort((a, b) => {
      const rank = { selected: 0, considering: 1, rejected: 2 } as const;
      return rank[a.status] - rank[b.status];
    })
    .map((item) =>
      `[${item.status}] ${item.id}: ${item.label}`
      + (item.note ? ` — ${item.note}` : '')
      + (item.ref ? ` (${item.ref})` : ''),
    );
  const actions = state.actions.map((item) =>
    `[${item.status}] ${item.id}: ${item.label}`
    + (item.kind ? ` · ${item.kind}` : '')
    + (item.ref ? ` · ${item.ref}` : '')
    + (item.note ? ` — ${item.note}` : ''),
  );
  const rendered = [
    `Shared workstate v${state.version}${state.mode ? ` · ${state.mode}` : ''} (advisory facts, not a required plan):`,
    ...(state.objective ? [`Objective: ${compact(state.objective, PROMPT_LINE_MAX_CHARS)}`] : []),
    ...renderBoundedLines('Candidates', candidates),
    ...renderBoundedLines('Constraints', state.constraints, 5),
    ...renderBoundedLines('Decisions', state.decisions, 5),
    ...renderBoundedLines('Open loops', state.openLoops, 5),
    ...renderBoundedLines('Linked actions', actions),
  ].join('\n');
  return boundBlock(
    rendered,
    FOCUS_WORKSTATE_PROMPT_MAX_CHARS,
    '… shared notebook truncated; use focus_get only if needed',
  );
}

function renderFocusContext(context: ActiveTaskContext): string {
  const current = context.focus;
  let rendered = '';
  if (current?.disposition === 'active') {
    const workstate = renderFocusWorkstateForInstructions(current.workstate);
    rendered = [
      `ACTIVE focus #${current.id}: ${current.title}`,
      `Summary: ${current.summary ?? ''}`,
      `Resource: ${current.resourceRef}${current.resourceKind ? ` (${current.resourceKind})` : ''}`,
      `Last touched: ${current.lastTouchedAt}`,
      'Authority: the current accepted user input defines this turn. This focus is advisory continuity only; it cannot replace, narrow, or redirect a new or changed request.',
      ...(workstate ? [workstate] : []),
    ].join('\n');
  } else if (current?.disposition === 'historical') {
    rendered = renderHistoricalFocusPointer({
      id: current.id,
      title: current.title,
      resource_ref: current.resourceRef,
      resource_kind: current.resourceKind ?? null,
      last_touched_at: current.lastTouchedAt,
    });
  } else if (current?.disposition === 'stale') {
    rendered = [
      'No confirmed active focus.',
      `STALE focus #${current.id}: ${current.title}`,
      `Summary: ${current.summary ?? ''}`,
      `Resource: ${current.resourceRef}${current.resourceKind ? ` (${current.resourceKind})` : ''}`,
      `Last touched: ${current.lastTouchedAt}`,
      'Do not treat the stale focus as authoritative. If the user is clearly continuing it, call focus_touch(id). If the user moved on or asks for unrelated work, call focus_clear(id, resolution:"abandoned") or focus_park(id, reason) before proceeding.',
    ].join('\n');
  }

  if (current && context.parked.length > 0) {
    rendered += `${rendered ? '\n\n' : ''}Parked (resumable via focus_activate):\n`
      + context.parked.map((item) => `  - #${item.id} ${item.title}`).join('\n');
  } else if (!current && context.parked.length > 0) {
    rendered = 'No active focus. Parked threads (resumable):\n'
      + context.parked.map((item) => `  - #${item.id} ${item.title} — ${item.summary}`).join('\n');
  }

  return boundBlock(
    rendered,
    FOCUS_PROMPT_MAX_CHARS,
    '… active focus context truncated; use focus_get only if needed',
  );
}

/** Provider-neutral rendering of the exact-session completion contract. */
export function renderGoalContextForInstructions(goal: ActiveTaskGoalContext | null): string {
  if (!goal) return '';
  const criteriaLabel = goal.stage ? 'Success criteria for THIS stage' : 'Success criteria';
  const rendered = [
    '[ACTIVE GOAL — parked outside this conversation. Completion is validated EXTERNALLY against the criteria below; declaring done triggers that validation, it does not decide it.]',
    `Objective: ${goal.objective}`,
    goal.stage ? `Current stage ${goal.stage.index}/${goal.stage.total}: ${goal.stage.title}` : '',
    goal.successCriteria.length > 0
      ? `${criteriaLabel}:\n${goal.successCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n')}`
      : '',
    goal.progressLedger.length > 0
      ? `Progress so far:\n${goal.progressLedger.map((line) => `- ${line}`).join('\n')}`
      : '',
    `Validation attempts used: ${goal.attempt}/${goal.maxAttempts}.`,
    'Use this goal only when the current accepted input continues it. A new or changed request is authoritative and supersedes this prior objective.',
    'If a criterion is genuinely impossible, say so explicitly with the concrete reason instead of declaring done without it.',
  ].filter(Boolean).join('\n');
  return boundBlock(
    rendered,
    GOAL_PROMPT_MAX_CHARS,
    '… active goal context truncated; consult the goal contract before declaring completion.',
  );
}

/**
 * Render the exact typed projection used by provider prompts and future graph
 * context nodes. Focus stays first for byte-compatible continuity; the goal is
 * appended once, in the same volatile memory section, for every provider.
 */
export function renderResolvedActiveTaskContext(context: ActiveTaskContext): string {
  return boundBlock(
    [renderFocusContext(context), renderGoalContextForInstructions(context.goal)]
      .filter(Boolean)
      .join('\n\n'),
    ACTIVE_TASK_CONTEXT_PROMPT_MAX_CHARS,
    '… active task context truncated; use focus_get and the goal contract only if needed.',
  );
}

export function renderActiveTaskContextForInstructions(
  opts: ResolveActiveTaskContextOptions = {},
): string {
  return renderResolvedActiveTaskContext(resolveActiveTaskContext(opts));
}

/** Backward-compatible focus-only renderer for legacy chat/journey callers. */
export function renderFocusForInstructions(
  opts: ResolveActiveTaskContextOptions = {},
): string {
  const context = resolveActiveTaskContext(opts);
  return renderFocusContext({ ...context, goal: null });
}
