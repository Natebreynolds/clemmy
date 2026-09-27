/**
 * Long memory passes run in slices and give the event loop a turn between
 * them.
 *
 * A nightly pass over thousands of facts used to be one synchronous block:
 * nothing else (HTTP, timers, the liveness stamp) ran until it returned. A
 * sliced pass does the same work in small pieces:
 *
 *   - a slice opens ONE transaction and runs steps until the clock says the
 *     slice's budget is spent (work time, units of work, or row writes);
 *   - it commits, and only then awaits one macrotask turn;
 *   - it never awaits inside a transaction (better-sqlite3 transactions are
 *     synchronous, and a half-open transaction across a turn would expose
 *     partial work to every other statement on the connection).
 *
 * The budget is checked after every step, and a pass makes a step of every
 * unit of work and every row write, so the longest stretch is about one budget
 * plus one step. Tests run with `maxMs: Infinity`, so slicing depends only on
 * counted units and writes, never on wall time.
 *
 * This module has no DB, config, or daemon imports. It yields with
 * `setImmediate` itself; a daemon can register a resume hook (for example to
 * re-stamp the running phase after every turn) through `setSliceResumeHook`,
 * or a caller can pass its own `yieldTurn`/`resume` hooks per clock.
 */
import type Database from 'better-sqlite3';
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

export interface SliceBudget {
  /** Work time per slice, in milliseconds (the time spent waiting for a turn is not counted). */
  maxMs: number;
  /** Units of work per slice (a fact matched, a candidate decided, an evidence row read). */
  maxUnits: number;
  /** Row writes per slice. */
  maxWrites: number;
}

/** The nightly budget: about 25 ms of work, at most 50 units or 100 row writes, then a turn. */
export const NIGHTLY_SLICE: Readonly<SliceBudget> = Object.freeze({ maxMs: 25, maxUnits: 50, maxWrites: 100 });

export interface SliceReport {
  /** Units counted in the slice that just ended. */
  units: number;
  /** Row writes counted in the slice that just ended. */
  writes: number;
  /** Turns taken before this slice ended (0 for the first slice). */
  turn: number;
  /** True for the pass's final slice, which ends without a turn. */
  final: boolean;
}

export interface SliceHooks {
  /** How a slice hands the loop a turn. Default: one `setImmediate` macrotask. */
  yieldTurn?: () => Promise<void>;
  /** Called after every turn, as the pass starts running again. Default: the process-wide hook from `setSliceResumeHook`. */
  resume?: () => void;
  /** Clock for the time budget. Default: `performance.now`. */
  now?: () => number;
  /** Called at every slice boundary with what the slice did. */
  onSlice?: (slice: SliceReport) => void;
}

let processResumeHook: (() => void) | null = null;

/**
 * Register what every sliced pass calls after it gets the loop back (unless a
 * clock was given its own `resume` hook). Pass `null` to remove it. The hook
 * must be cheap and must not throw; a throw is swallowed so it can never stop
 * a pass.
 */
export function setSliceResumeHook(hook: (() => void) | null): void {
  processResumeHook = hook;
}

/** One macrotask turn: lets pending I/O callbacks, timers and HTTP handlers run. */
export async function yieldTurn(): Promise<void> {
  await nextMacrotask();
}

function positiveBudget(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (Number.isNaN(value) || value <= 0) throw new RangeError(`slice budget must be positive, got ${value}`);
  return value;
}

/**
 * Counts one slice's work and decides when the slice is over.
 *
 * A pass calls `unit()` after each unit of work and `wrote(n)` after each row
 * write; `due` turns true once any budget is spent. `boundary()` ends the
 * slice after the current step regardless of the counts, so a setup statement
 * (an index build, a page of a selection) gets a slice of its own.
 */
export class SliceClock {
  readonly budget: Readonly<SliceBudget>;
  private readonly hooks: SliceHooks;
  private readonly clockNow: () => number;
  private sliceUnits = 0;
  private sliceWrites = 0;
  private sliceStartedAt: number;
  private split = false;
  private turnCount = 0;
  private totalUnits = 0;
  private totalWrites = 0;

  constructor(budget: Partial<SliceBudget> = {}, hooks: SliceHooks = {}) {
    this.budget = Object.freeze({
      maxMs: positiveBudget(budget.maxMs, NIGHTLY_SLICE.maxMs),
      maxUnits: positiveBudget(budget.maxUnits, NIGHTLY_SLICE.maxUnits),
      maxWrites: positiveBudget(budget.maxWrites, NIGHTLY_SLICE.maxWrites),
    });
    this.hooks = hooks;
    this.clockNow = hooks.now ?? (() => performance.now());
    this.sliceStartedAt = this.clockNow();
  }

  /** Count units of work done in this slice. */
  unit(n = 1): void {
    if (n <= 0) return;
    this.sliceUnits += n;
    this.totalUnits += n;
  }

  /** Count row writes made in this slice. */
  wrote(n: number): void {
    if (!(n > 0)) return;
    this.sliceWrites += n;
    this.totalWrites += n;
  }

  /** End the slice after the current step, whatever the counts say. */
  boundary(): void {
    this.split = true;
  }

  /** True once any budget of this slice is spent (or a boundary was asked for). */
  get due(): boolean {
    return this.split
      || this.sliceUnits >= this.budget.maxUnits
      || this.sliceWrites >= this.budget.maxWrites
      || this.clockNow() - this.sliceStartedAt >= this.budget.maxMs;
  }

  /** Turns taken so far. */
  get turns(): number {
    return this.turnCount;
  }

  /** Units and writes counted over the clock's whole life. */
  get totals(): { units: number; writes: number } {
    return { units: this.totalUnits, writes: this.totalWrites };
  }

  /**
   * End the slice and take one turn if the slice is due (always, with
   * `force`). Resets the slice's counters and time after the turn. Call it
   * only outside a transaction.
   */
  async next(force = false): Promise<void> {
    if (!force && !this.due) return;
    this.report(false);
    await (this.hooks.yieldTurn ?? yieldTurn)();
    this.turnCount += 1;
    const resume = this.hooks.resume ?? processResumeHook;
    if (resume) {
      try { resume(); } catch { /* a resume hook never stops a pass */ }
    }
    this.reset();
  }

  /** Report the final slice, which ends without a turn. */
  finish(): void {
    if (this.sliceUnits > 0 || this.sliceWrites > 0) this.report(true);
    this.reset();
  }

  private report(final: boolean): void {
    this.hooks.onSlice?.({ units: this.sliceUnits, writes: this.sliceWrites, turn: this.turnCount, final });
  }

  private reset(): void {
    this.sliceUnits = 0;
    this.sliceWrites = 0;
    this.split = false;
    this.sliceStartedAt = this.clockNow();
  }
}

/** One step of a pass: a bounded piece of work. Say 'done' when nothing is left. */
export type SliceStep = () => 'more' | 'done';

export interface RunSlicedOptions {
  /** Called after every slice commits, before the turn (and after the final slice). */
  afterSlice?: () => void;
}

/**
 * Run `step` repeatedly inside ONE transaction until the clock is due or the
 * step says done; commit; await a turn; repeat. Never awaits inside a
 * transaction. A step that throws rolls back only the slice it ran in; slices
 * committed before it stay committed.
 */
export async function runSliced(
  db: Database.Database,
  clock: SliceClock,
  step: SliceStep,
  options: RunSlicedOptions = {},
): Promise<void> {
  if (db.inTransaction) throw new Error('a sliced pass cannot start inside an open transaction');
  const slice = db.transaction((): boolean => {
    for (;;) {
      if (step() === 'done') return true;
      if (clock.due) return false;
    }
  });
  for (;;) {
    const done = slice();
    options.afterSlice?.();
    if (done) {
      clock.finish();
      return;
    }
    await clock.next(true);
  }
}

/**
 * The same steps, all in one transaction and without a turn: what the
 * synchronous exports (boot finalizers, tests, rehearsal on a clone) use, so
 * the sliced and unsliced passes cannot drift apart.
 */
export function runUnsliced(db: Database.Database, step: SliceStep): void {
  db.transaction(() => {
    while (step() !== 'done') { /* keep stepping */ }
  })();
}

/**
 * Adapt a generator to a step: each `yield` is a step boundary, so a pass
 * can be written as straight-line code that yields after every unit and every
 * row write. The generator must not yield from inside a nested transaction
 * callback (it cannot: a callback is not the generator's own frame).
 */
export function stepsOf(iterator: Iterator<unknown, unknown, undefined>): SliceStep {
  return () => (iterator.next().done ? 'done' : 'more');
}
