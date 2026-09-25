/**
 * The one contract every delegated coding agent is driven through.
 *
 * Clem does not care whether Claude Code or Codex is doing the work: each CLI
 * gets an adapter that turns its native stream into these events and exposes
 * the same controls (steer mid-turn, follow up in the same session, interrupt,
 * close). Everything above the adapter — the run store, the permission policy,
 * the receipt, the live view — is shared, so "the same experience for every
 * agent" is a property of the code, not a promise.
 */
import type { CodingAgentId } from './coding-run-store.js';
import type { CodingToolDecision } from './coding-run-policy.js';

export interface CodingPlanItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface CodingAgentUsage {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
}

export type CodingAgentEvent =
  | { kind: 'session'; agentSessionId: string; model: string | null }
  | { kind: 'message'; text: string; nested: boolean }
  | { kind: 'plan'; items: CodingPlanItem[] }
  | { kind: 'step_started'; stepId: string; tool: string; detail: string; nested: boolean }
  | { kind: 'step_finished'; stepId: string; ok: boolean; output: string }
  | {
      kind: 'permission';
      stepId: string | null;
      tool: string;
      detail: string;
      decision: CodingToolDecision['decision'];
      effect: CodingToolDecision['effect'];
      reason: string;
    }
  | {
      kind: 'turn_completed';
      ok: boolean;
      finalMessage: string;
      /** Cumulative for the agent session so far, per model. */
      usage: CodingAgentUsage[];
      costUsd: number | null;
    }
  | { kind: 'error'; message: string };

export interface CodingAgentStartInput {
  cwd: string;
  /** The brief on a fresh start; the resume note when re-attaching. */
  message: string;
  /** Minted by Clem and persisted before the agent starts, so a crash at any
   *  point still leaves a session id to resume. */
  agentSessionId: string;
  resume: boolean;
  model: string | null;
  env: Record<string, string>;
  /** Clem's standing instructions for the agent (role, boundaries, finish). */
  instructions: string;
  decide: (tool: string, input: Record<string, unknown>) => CodingToolDecision;
}

export interface CodingAgentSession {
  readonly events: AsyncIterable<CodingAgentEvent>;
  /** `steer` lands inside the current turn; `follow_up` starts the next one. */
  send(text: string, mode: 'steer' | 'follow_up'): void;
  interrupt(): Promise<void>;
  /** End the session and its process. Safe to call more than once. */
  close(): void;
}

export interface CodingAgentBridge {
  id: CodingAgentId;
  start(input: CodingAgentStartInput): CodingAgentSession;
}

/** A single-consumer async queue: producers push, one `for await` drains. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

/** Structural pick of the most telling argument — no per-tool knowledge
 *  beyond common argument names, so new tools narrate without a code change. */
export function describeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  const preferred = [record.command, record.file_path, record.notebook_path, record.path, record.pattern,
    record.url, record.query, record.description, record.prompt]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const fallback = Object.values(record).find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return String(preferred ?? fallback ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
}
