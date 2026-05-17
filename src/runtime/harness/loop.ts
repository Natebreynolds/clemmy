import type { Agent, AgentInputItem } from '@openai/agents';
import { Runner } from '@openai/agents';
import { HarnessSession } from './session.js';
import { appendEvent, getSession, updateSession, type SessionRow } from './eventlog.js';
import {
  assertNotKilled,
  KillRequested,
  ToolCallsCounter,
  ToolCallsLimitExceeded,
  DEFAULT_MAX_TURNS,
  DEFAULT_TOOL_CALLS_PER_TURN,
} from './brackets.js';
import { attachEventLogHooks, extractSessionIdFromContext, type RunHooksLike } from './hooks.js';

/**
 * The harness loop — `runTurn(options)`.
 *
 * One call:
 *   1. Loads the session and computes the next turn number.
 *   2. Checks the kill switch (pre-flight).
 *   3. Records the user input as an event + HarnessSession update.
 *   4. Wires brackets (tool-calls counter, future token budget) and
 *      hooks (event-log writer) onto a Runner.
 *   5. Calls `runner.run(agent, items, opts)` with the replayed
 *      history and any `previousResponseId` for Responses-API state
 *      reuse.
 *   6. If the run completes: snapshots history + lastResponseId on
 *      the session, emits `run_completed`, marks status `completed`.
 *   7. If the run hits an interruption (approval): saves a serialized
 *      RunState to the session and returns `awaiting_approval`; the
 *      caller resumes via `resumeTurn` after the approval is resolved.
 *   8. If the run throws a bracket error (kill, tool cap): emits
 *      `guardrail_tripped`, marks status, returns the appropriate
 *      terminal kind.
 *
 * The Runner factory and the run executor are both injection points
 * so unit tests can drive the loop without spending tokens.
 */

export interface RunOutcome {
  history: AgentInputItem[];
  lastResponseId: string | undefined;
  finalOutput: unknown;
  /** Serialized RunState for interrupt-resume; only set when paused. */
  serializedState?: string;
  /** True when the underlying RunResult had interruptions[]. */
  hasInterruptions?: boolean;
}

export type RunRunnerFn = (
  runner: Runner,
  agent: Agent<any, any>,
  items: AgentInputItem[],
  opts: Record<string, unknown>,
) => Promise<RunOutcome>;

export interface RunTurnOptions {
  agent: Agent<any, any>;
  sessionId: string;
  input: string;
  maxTurns?: number;
  toolCallsPerTurn?: number;
  /** Test injection: build the Runner. Defaults to a fresh real Runner. */
  makeRunner?: () => Runner;
  /** Test injection: run the Runner. Defaults to a real runner.run(). */
  runRunner?: RunRunnerFn;
}

export type RunTurnStatus = 'completed' | 'awaiting_approval' | 'killed' | 'limit_exceeded' | 'failed';

export interface RunTurnResult {
  sessionId: string;
  turn: number;
  status: RunTurnStatus;
  finalOutput?: unknown;
  error?: string;
}

// ---------- public API ----------

export async function runTurn(options: RunTurnOptions): Promise<RunTurnResult> {
  const row = getSession(options.sessionId);
  if (!row) throw new Error(`unknown session: ${options.sessionId}`);
  const session = HarnessSession.load(options.sessionId);
  if (!session) throw new Error(`unable to load session: ${options.sessionId}`);

  const turn = nextTurnNumber(row);

  if (isKillBeforeStart(options.sessionId, turn, session)) {
    return { sessionId: options.sessionId, turn, status: 'killed' };
  }

  appendEvent({
    sessionId: options.sessionId,
    turn,
    role: 'system',
    type: 'turn_started',
    data: { input: clip(options.input, 200) },
  });
  session.recordUserInput(options.input, turn);

  const toolCounter = new ToolCallsCounter(
    options.toolCallsPerTurn ?? DEFAULT_TOOL_CALLS_PER_TURN,
  );

  const makeRunner =
    options.makeRunner ??
    (() =>
      new Runner({
        workflowName: 'clementine-harness',
        groupId: options.sessionId,
      }));
  const runner = makeRunner();

  const detachLogHooks = attachEventLogHooks(runner as unknown as RunHooksLike, {
    getSessionId: extractSessionIdFromContext,
    getTurn: () => turn,
  });
  const onToolStart = (): void => {
    toolCounter.increment();
  };
  (runner as unknown as RunHooksLike).on(
    'agent_tool_start',
    onToolStart as (...args: unknown[]) => void,
  );

  const items: AgentInputItem[] = [
    ...session.toInputItems(),
    { role: 'user', content: options.input },
  ];

  const opts: Record<string, unknown> = {
    context: { sessionId: options.sessionId, turn },
    maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS.orchestrator,
  };
  const prevResp = session.previousResponseId();
  if (prevResp) opts.previousResponseId = prevResp;

  try {
    const run = options.runRunner ?? defaultRunRunner;
    const outcome = await run(runner, options.agent, items, opts);

    if (outcome.hasInterruptions && outcome.serializedState) {
      session.saveInterruptState(outcome.serializedState);
      bumpTurnNumber(options.sessionId, turn);
      return { sessionId: options.sessionId, turn, status: 'awaiting_approval' };
    }

    session.recordTurnResult({
      history: outcome.history,
      lastResponseId: outcome.lastResponseId,
      turn,
    });
    appendEvent({
      sessionId: options.sessionId,
      turn,
      role: 'system',
      type: 'run_completed',
      data: {
        finalOutputPreview: previewOutput(outcome.finalOutput),
        toolCalls: toolCounter.currentCount,
      },
    });
    session.markStatus('completed');
    bumpTurnNumber(options.sessionId, turn);
    return {
      sessionId: options.sessionId,
      turn,
      status: 'completed',
      finalOutput: outcome.finalOutput,
    };
  } catch (err) {
    return handleRunError(options.sessionId, turn, session, err);
  } finally {
    detachLogHooks();
    (runner as unknown as RunHooksLike).off(
      'agent_tool_start',
      onToolStart as (...args: unknown[]) => void,
    );
  }
}

// ---------- helpers ----------

function isKillBeforeStart(
  sessionId: string,
  turn: number,
  session: HarnessSession,
): boolean {
  try {
    assertNotKilled(sessionId);
    return false;
  } catch (err) {
    if (!(err instanceof KillRequested)) throw err;
    appendEvent({
      sessionId,
      turn,
      role: 'system',
      type: 'kill_requested',
      data: { reason: 'pre-flight check' },
    });
    session.markStatus('cancelled');
    return true;
  }
}

function handleRunError(
  sessionId: string,
  turn: number,
  session: HarnessSession,
  err: unknown,
): RunTurnResult {
  if (err instanceof KillRequested) {
    appendEvent({
      sessionId,
      turn,
      role: 'system',
      type: 'kill_requested',
      data: { reason: 'during run' },
    });
    session.markStatus('cancelled');
    bumpTurnNumber(sessionId, turn);
    return { sessionId, turn, status: 'killed' };
  }
  if (err instanceof ToolCallsLimitExceeded) {
    appendEvent({
      sessionId,
      turn,
      role: 'system',
      type: 'guardrail_tripped',
      data: { kind: 'tool_calls_limit', limit: err.limit },
    });
    session.markStatus('failed');
    bumpTurnNumber(sessionId, turn);
    return { sessionId, turn, status: 'limit_exceeded', error: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  appendEvent({
    sessionId,
    turn,
    role: 'system',
    type: 'run_failed',
    data: { error: clip(message, 400) },
  });
  session.markStatus('failed');
  bumpTurnNumber(sessionId, turn);
  return { sessionId, turn, status: 'failed', error: message };
}

function bumpTurnNumber(sessionId: string, turn: number): void {
  const row = getSession(sessionId);
  if (!row) return;
  updateSession(sessionId, {
    metadata: { ...row.metadata, __turn: turn },
  });
}

function nextTurnNumber(row: SessionRow): number {
  const t = (row.metadata as { __turn?: unknown }).__turn;
  return (typeof t === 'number' ? t : 0) + 1;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[+${text.length - max} chars]`;
}

function previewOutput(out: unknown): string {
  if (typeof out === 'string') return out.slice(0, 200);
  try {
    return JSON.stringify(out).slice(0, 200);
  } catch {
    return String(out).slice(0, 200);
  }
}

// ---------- default Runner adapter ----------

const defaultRunRunner: RunRunnerFn = async (runner, agent, items, opts) => {
  // Cast through unknown because the SDK's overloads make TS unhappy
  // about a generic-erased agent type. The adapter sees only the
  // result fields we care about.
  type RunMethod = (
    a: typeof agent,
    i: typeof items,
    o: typeof opts,
  ) => Promise<{
    history: AgentInputItem[];
    lastResponseId: string | undefined;
    finalOutput: unknown;
    interruptions?: unknown[];
    state?: { toString(): string };
  }>;
  const run = runner.run.bind(runner) as unknown as RunMethod;
  const result = await run(agent, items, opts);
  const hasInterruptions = Array.isArray(result.interruptions) && result.interruptions.length > 0;
  return {
    history: result.history,
    lastResponseId: result.lastResponseId,
    finalOutput: result.finalOutput,
    hasInterruptions,
    serializedState: hasInterruptions ? result.state?.toString() : undefined,
  };
};
