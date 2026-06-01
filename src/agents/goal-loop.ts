/**
 * /goal mode — Ralph loop for long-running objectives.
 *
 * Why this exists:
 *   The normal chat path caps tool-call turns inside ONE assistant
 *   response (the codex-native-runtime's `runToolLoop`). For genuinely
 *   long objectives — "audit this domain", "build me a research report"
 *   — one assistant response isn't enough even at the 75-turn cap. The
 *   Ralph loop chains multiple assistant responses, asking a cheap
 *   judge model between each whether the objective is done.
 *
 * Pattern (lifted from Hermes' `/goal` and Codex CLI 0.128.0):
 *   1. User says `/goal <objective>`.
 *   2. We persist a `GoalState` to disk keyed by sessionId.
 *   3. Loop: ask the main assistant to make progress, then ask the
 *      judge model "done?". Judge JSON: { done: boolean, reason: string }.
 *      Fail-OPEN: if the judge errors we treat it as "not done" so a
 *      flaky judge can't wedge progress.
 *   4. Budget exhaustion → mark `paused`, user can `/goal resume`.
 *   5. Judge says done → mark `done`.
 *   6. User cancels at any time → mark `aborted`.
 *
 * State persistence: one JSON file per sessionId so multiple sessions
 * can run goals concurrently and a daemon restart resumes from disk.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR, MODELS } from '../config.js';
import type { AgentRuntime } from '../runtime/provider.js';

const logger = pino({ name: 'clementine-next.goal-loop' });

const STATE_DIR = path.join(BASE_DIR, 'state', 'goals');
const DEFAULT_TURNS_LIMIT = 20;
const DEFAULT_JUDGE_PARSE_FAILURE_LIMIT = 3;

/**
 * Terminal + intermediate states for a goal run.
 *
 * Vocabulary aligned with OpenAI Codex CLI 0.128.0's /goal slash command
 * (https://developers.openai.com/codex/cli/slash-commands) so users
 * switching between Clementine and Codex have one mental model:
 *
 *   pursuing       — the loop is in flight, currently making progress
 *   paused         — explicit pause: user said /goal pause, judge wedged,
 *                    or an error during the loop forced a halt that the
 *                    user can resume from
 *   achieved       — the judge confirmed the objective is complete
 *   unmet          — the loop ended without completing the objective
 *                    (user aborted, or terminal failure)
 *   budget-limited — turns budget was exhausted before the judge said done
 *
 * Older on-disk states used: active/done/aborted. The reader maps those
 * forward on load so existing goal files keep working.
 */
export type GoalStatus = 'pursuing' | 'paused' | 'achieved' | 'unmet' | 'budget-limited';

export interface GoalState {
  sessionId: string;
  objective: string;
  status: GoalStatus;
  startedAt: string;
  updatedAt: string;
  pausedAt?: string;
  turnsUsed: number;
  turnsLimit: number;
  /** Consecutive judge JSON-parse failures. Trips the safety pause. */
  judgeParseFailures: number;
  /** Last summary the assistant produced — used to inform the next continuation prompt. */
  lastSummary?: string;
  /** When `achieved`, the judge's reason text. When budget-limited or
   *  unmet, a short note describing why the loop stopped. */
  doneReason?: string;
}

/**
 * Legacy → current status remap. Goal state files written before the
 * Codex-aligned vocabulary used these names; map them forward so users
 * don't lose in-flight goals across the upgrade.
 */
const LEGACY_STATUS_MAP: Record<string, GoalStatus> = {
  active: 'pursuing',
  done: 'achieved',
  aborted: 'unmet',
};

function normalizeStatus(raw: unknown): GoalStatus {
  if (typeof raw === 'string') {
    if (LEGACY_STATUS_MAP[raw]) return LEGACY_STATUS_MAP[raw];
    if (raw === 'pursuing' || raw === 'paused' || raw === 'achieved' || raw === 'unmet' || raw === 'budget-limited') {
      return raw;
    }
  }
  // Unknown / missing → safest assumption is paused so the user can
  // inspect and either resume or clear.
  return 'paused';
}

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

function goalFile(sessionId: string): string {
  // Slug the sessionId to keep it filesystem-safe.
  const safe = sessionId.replace(/[^A-Za-z0-9_.:-]+/g, '_').slice(0, 200) || 'session';
  return path.join(STATE_DIR, `${safe}.json`);
}

export function loadGoalState(sessionId: string): GoalState | null {
  ensureStateDir();
  const file = goalFile(sessionId);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<GoalState> & { status?: unknown };
    // Forward-map legacy status names. Save the normalized state back
    // to disk lazily on the next saveGoalState so over time the legacy
    // strings disappear from the vault.
    return { ...parsed, status: normalizeStatus(parsed.status) } as GoalState;
  } catch {
    return null;
  }
}

export function saveGoalState(state: GoalState): void {
  ensureStateDir();
  state.updatedAt = new Date().toISOString();
  writeFileSync(goalFile(state.sessionId), JSON.stringify(state, null, 2), 'utf-8');
}

export function clearGoalState(sessionId: string): void {
  const file = goalFile(sessionId);
  if (existsSync(file)) {
    try { unlinkSync(file); } catch { /* best-effort */ }
  }
}

/** List every active goal across all sessions — used by `/goal status`.
 *  Returns states that haven't reached a terminal kind (achieved /
 *  unmet / budget-limited); pursuing + paused are both "still in play". */
export function listActiveGoals(): GoalState[] {
  ensureStateDir();
  if (!existsSync(STATE_DIR)) return [];
  const out: GoalState[] = [];
  for (const name of readdirSync(STATE_DIR)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(path.join(STATE_DIR, name), 'utf-8')) as Partial<GoalState>;
      const state = { ...parsed, status: normalizeStatus(parsed.status) } as GoalState;
      if (state.status === 'pursuing' || state.status === 'paused') {
        out.push(state);
      }
    } catch { /* skip corrupt entries */ }
  }
  return out;
}

// ─── Judge ─────────────────────────────────────────────────────────

interface JudgeResult {
  done: boolean;
  reason: string;
  /** True when JSON parsing failed and we defaulted to not-done. */
  parseFailed: boolean;
}

/**
 * Judge system prompt — modeled on OpenAI Codex's continuation.md
 * auditor pattern (Codex CLI 0.128.0, April 2026). The Codex prompt
 * explicitly tells the agent: "Do not accept proxy signals as
 * completion by themselves. Build an audit checklist mapping
 * requirements → verifiable evidence before marking done."
 *
 * The audit-checklist framing is meaningfully stronger than a generic
 * "is this done?" because it forces the judge to enumerate concrete
 * deliverables and check evidence for each — which is the dimension
 * a confident-sounding but incomplete assistant response usually
 * fails on.
 */
export const JUDGE_SYSTEM_PROMPT = [
  'You are a goal-completion judge. You receive (1) a user objective and (2) the most recent assistant response.',
  '',
  'Use an AUDIT CHECKLIST: enumerate the concrete, verifiable deliverables the objective implies, then check each one against the assistant\'s response.',
  '',
  'Rules:',
  '- A deliverable counts as complete only when the response contains VERIFIABLE EVIDENCE (a URL, a file path, a quoted result, an emitted artifact) — not a promise or summary of what was done.',
  '- Do NOT accept proxy signals (e.g. "I have updated the records", "task complete", "✓") as completion by themselves. Require the artifact or its output.',
  '- A plan, intention, or "I will work on this next" is NOT complete.',
  '- Partial completion of multiple deliverables is NOT complete unless the objective only asked for one.',
  '- HONEST BLOCKER: if the response delivers the results it COULD produce AND explicitly names the specific part it could not, with a concrete reason that part is genuinely blocked (a named tool/endpoint unavailable, a record/field that does not exist, access denied), treat that as DONE — do NOT demand it retry a capability that is genuinely unavailable. Mark not-done ONLY when the assistant could plausibly still finish with the tools it has (it punted, guessed, promised, or stopped without actually trying).',
  '- If the objective is ambiguous, lean toward not-done so the user can clarify rather than the loop terminating prematurely.',
  '',
  'Output ONLY a JSON object on one line with no prose: {"done": <boolean>, "reason": "<one short sentence naming the missing evidence or the artifact that satisfied the objective>"}.',
  '',
  'Examples:',
  '  {"done": true, "reason": "Spreadsheet created at /Users/me/Q3.xlsx with URL returned"}',
  '  {"done": false, "reason": "Assistant proposed steps but no artifact or URL was produced"}',
  '  {"done": false, "reason": "Two of three deliverables remain — emails drafted but no send confirmation evidence"}',
].join('\n');

async function callJudge(
  runtime: AgentRuntime,
  objective: string,
  lastResponse: string,
  judgeModel: string,
): Promise<JudgeResult> {
  const prompt = [
    `Objective: ${objective}`,
    '',
    'Assistant\'s most recent response (truncated to 4000 chars):',
    lastResponse.slice(0, 4000),
    '',
    'Respond ONLY with the JSON object — no prose, no markdown fences.',
  ].join('\n');

  try {
    const result = await runtime.run({
      instructions: JUDGE_SYSTEM_PROMPT,
      model: judgeModel,
      prompt,
      sessionId: `goal-judge-${Date.now()}`,
    });
    const text = result.text.trim();
    // Strip possible markdown fence even though we told it not to.
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned) as { done?: boolean; reason?: string };
    if (typeof parsed.done !== 'boolean') throw new Error('done missing');
    return {
      done: parsed.done === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      parseFailed: false,
    };
  } catch (err) {
    // Fail-OPEN: a flaky judge cannot wedge progress.
    logger.warn({ err, judgeModel }, 'goal judge call failed — defaulting to not-done');
    return { done: false, reason: 'judge_error', parseFailed: true };
  }
}

// ─── The loop ──────────────────────────────────────────────────────

export interface GoalLoopOptions {
  sessionId: string;
  objective: string;
  runtime: AgentRuntime;
  /** Driver to invoke the main assistant for one turn. Caller supplies
   *  this so it can wire in its own callbacks (streaming, tool events). */
  driveAssistant: (message: string) => Promise<{ text: string }>;
  turnsLimit?: number;
  judgeModel?: string;
  /** Called once per turn before driving the assistant — useful for the
   *  channel to render a "Goal turn 3/20" indicator. */
  onTurnStart?: (info: { turn: number; total: number; objective: string }) => void;
  /** Called after each turn with the judge's decision. */
  onTurnEnd?: (info: { turn: number; done: boolean; reason: string }) => void;
  /** Caller-side cancellation. When this returns true the loop aborts. */
  shouldCancel?: () => boolean | Promise<boolean>;
}

/**
 * Drive the goal loop to completion / pause / abort. Persists state
 * to disk on every turn so a crash/restart can resume.
 */
export async function runGoalLoop(opts: GoalLoopOptions): Promise<GoalState> {
  const turnsLimit = Math.max(1, opts.turnsLimit ?? DEFAULT_TURNS_LIMIT);
  const judgeModel = opts.judgeModel ?? MODELS.fast;
  const sessionId = opts.sessionId;

  // Pick up an existing state OR create fresh.
  let state = loadGoalState(sessionId);
  if (!state || state.objective !== opts.objective) {
    state = {
      sessionId,
      objective: opts.objective,
      status: 'pursuing',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turnsUsed: 0,
      turnsLimit,
      judgeParseFailures: 0,
    };
  } else {
    state.status = 'pursuing';
    state.turnsLimit = turnsLimit;
    state.judgeParseFailures = 0;
  }
  saveGoalState(state);

  while (state.turnsUsed < state.turnsLimit) {
    if (await opts.shouldCancel?.()) {
      // Codex vocabulary: explicit user cancellation maps to `unmet` —
      // the loop ended without satisfying the objective.
      state.status = 'unmet';
      state.pausedAt = new Date().toISOString();
      state.doneReason = state.doneReason ?? 'Cancelled by user before completion.';
      saveGoalState(state);
      return state;
    }

    const turn = state.turnsUsed + 1;
    opts.onTurnStart?.({ turn, total: state.turnsLimit, objective: state.objective });

    // Continuation message: on the first turn it's the bare objective,
    // afterwards it includes a brief reminder + remaining budget. The
    // assistant's own context still has the prior turns via the session.
    const message = turn === 1
      ? state.objective
      : [
          `Continue working toward: ${state.objective}`,
          '',
          `(Goal-loop turn ${turn}/${state.turnsLimit}. Last summary you produced is in this session's transcript. Build on it; don't restart from scratch.)`,
        ].join('\n');

    let assistantText: string;
    try {
      const result = await opts.driveAssistant(message);
      assistantText = result.text || '';
    } catch (err) {
      logger.warn({ err, turn, objective: state.objective }, 'goal loop turn errored — pausing');
      state.status = 'paused';
      state.pausedAt = new Date().toISOString();
      saveGoalState(state);
      return state;
    }

    state.turnsUsed = turn;
    state.lastSummary = assistantText.slice(0, 2000);
    saveGoalState(state);

    // Cancellation between assistant + judge.
    if (await opts.shouldCancel?.()) {
      state.status = 'unmet';
      state.pausedAt = new Date().toISOString();
      state.doneReason = state.doneReason ?? 'Cancelled by user between turn and judge.';
      saveGoalState(state);
      return state;
    }

    const judgement = await callJudge(opts.runtime, state.objective, assistantText, judgeModel);
    opts.onTurnEnd?.({ turn, done: judgement.done, reason: judgement.reason });

    if (judgement.parseFailed) {
      state.judgeParseFailures += 1;
      if (state.judgeParseFailures >= DEFAULT_JUDGE_PARSE_FAILURE_LIMIT) {
        // The judge has failed 3 turns in a row. Pause so the user
        // can intervene (maybe switch to a stronger judge model).
        state.status = 'paused';
        state.pausedAt = new Date().toISOString();
        state.doneReason = `Judge model failed to parse JSON ${DEFAULT_JUDGE_PARSE_FAILURE_LIMIT} times in a row.`;
        saveGoalState(state);
        return state;
      }
    } else {
      state.judgeParseFailures = 0;
    }

    if (judgement.done) {
      state.status = 'achieved';
      state.doneReason = judgement.reason;
      saveGoalState(state);
      return state;
    }
  }

  // Turn budget exhausted without the judge marking the objective
  // achieved. Codex distinguishes this from a user pause — it's
  // `budget-limited` so the surface can offer "extend budget" vs
  // the generic "resume" treatment. The doneReason captures the
  // exact stop condition for the UI.
  state.status = 'budget-limited';
  state.pausedAt = new Date().toISOString();
  state.doneReason = `Turn budget (${state.turnsLimit}) exhausted before judge marked the objective achieved.`;
  saveGoalState(state);
  return state;
}

// ─── Slash command parsing ──────────────────────────────────────────

export type GoalCommand =
  | { kind: 'start'; objective: string }
  | { kind: 'resume' }
  | { kind: 'clear' }
  | { kind: 'status' }
  | { kind: 'unknown'; text: string };

/**
 * Parse a slash command. Returns null if the message isn't a goal
 * command at all (the chat path should handle it normally).
 */
export function parseGoalCommand(message: string): GoalCommand | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith('/goal')) return null;
  const rest = trimmed.slice('/goal'.length).trim();
  if (!rest) return { kind: 'status' };
  const lower = rest.toLowerCase();
  if (lower === 'resume') return { kind: 'resume' };
  if (lower === 'clear' || lower === 'stop' || lower === 'abort') return { kind: 'clear' };
  if (lower === 'status' || lower === 'state') return { kind: 'status' };
  // Treat anything else as the objective text.
  return { kind: 'start', objective: rest };
}

/**
 * Human-readable status line for `/goal status` and similar surfaces.
 */
export function describeGoalState(state: GoalState | null): string {
  if (!state) return 'No goal active in this session. Use `/goal <objective>` to start one.';
  const pct = `${state.turnsUsed}/${state.turnsLimit}`;
  switch (state.status) {
    case 'pursuing':
      return `Goal pursuing (${pct}): ${state.objective}`;
    case 'paused':
      return `Goal paused at ${pct} — "${state.objective}". Use \`/goal resume\` to continue or \`/goal clear\` to drop it.`;
    case 'achieved':
      return `Goal achieved (${pct}): ${state.objective}${state.doneReason ? ` — ${state.doneReason}` : ''}`;
    case 'unmet':
      return `Goal unmet at ${pct}: ${state.objective}${state.doneReason ? ` — ${state.doneReason}` : ''}`;
    case 'budget-limited':
      return `Goal budget-limited at ${pct} — "${state.objective}". Hit the turn cap before the audit checklist was complete; \`/goal resume\` to extend, or \`/goal clear\` to drop it.`;
  }
}
