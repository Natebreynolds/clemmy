/**
 * Resumable progress for long memory passes.
 *
 * A sliced pass commits one slice at a time. After each commit it records
 * how far it got (the last unit it finished, the finished parts of the unit
 * in progress, and its running stats) through a PassCursorIO. If the process
 * dies, the next attempt the same day skips what was done and continues with
 * the same stats. Every unit is idempotent, so redoing the little that
 * happened after the last recorded point only repeats work.
 *
 *   - A pass resumes at most once per day: the attempt number is written
 *     before the first unit runs, and a third attempt the same day starts
 *     from the beginning, so a pass that kills the process cannot loop on it.
 *   - The cursor is written at most every `minWriteIntervalMs` (tmp file and
 *     rename, no fsync: losing the last write only means redoing idempotent
 *     units), and always when the pass fails.
 *   - A completed pass clears its cursor.
 *
 * No DB or config imports: the caller owns where cursors are stored.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** A position in a pass's own processing order (a fact id, or an order key tuple). */
export type PassCursorKey = number | string | ReadonlyArray<number | string>;

export interface PassPartialUnit {
  /** The unit in progress. */
  key: PassCursorKey;
  /** The ids of its sub-units that were finished and committed. */
  done: number[];
}

export interface PassCursor<S = Record<string, number>> {
  /** Local day (YYYY-MM-DD) the pass's first attempt started. */
  day: string;
  /** The last unit finished and committed; null before the first. */
  after: PassCursorKey | null;
  /** The unit that was in progress when the cursor was written, if any. */
  partial: PassPartialUnit | null;
  /** Stats covering exactly what `after` and `partial` say is done. */
  stats: S | null;
  startedAt: string;
  /** Attempts so far today, including the one that wrote this cursor. */
  attempts: number;
}

export interface PassCursorIO {
  read(passId: string): PassCursor<unknown> | null;
  write(passId: string, cursor: PassCursor<unknown>): void;
  clear(passId: string): void;
}

/** At most this many attempts per pass per day; the last one is the only resume. */
export const MAX_PASS_ATTEMPTS_PER_DAY = 2;

/** How often a running pass writes its cursor, at most. */
export const PASS_CURSOR_WRITE_INTERVAL_MS = 2_000;

export function localDayKey(at: Date = new Date()): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/** Cursors kept in this process only (tests, or a caller that needs no restart resume). */
export function memoryPassCursorIO(): PassCursorIO & { readonly cursors: Map<string, PassCursor<unknown>> } {
  const cursors = new Map<string, PassCursor<unknown>>();
  return {
    cursors,
    read: (passId) => {
      const cursor = cursors.get(passId);
      return cursor ? structuredClone(cursor) : null;
    },
    write: (passId, cursor) => { cursors.set(passId, structuredClone(cursor)); },
    clear: (passId) => { cursors.delete(passId); },
  };
}

function isCursor(value: unknown): value is PassCursor<unknown> {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Partial<PassCursor<unknown>>;
  return typeof cursor.day === 'string'
    && typeof cursor.startedAt === 'string'
    && typeof cursor.attempts === 'number' && Number.isFinite(cursor.attempts);
}

/**
 * Cursors in one JSON file, `{ "passes": { "<passId>": cursor } }`. Reads
 * treat a missing or unreadable file as empty; writes go to a temp file and
 * are renamed into place.
 */
export function filePassCursorIO(filePath: string): PassCursorIO {
  const readAll = (): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { passes?: unknown };
      return parsed && typeof parsed.passes === 'object' && parsed.passes !== null
        ? { ...(parsed.passes as Record<string, unknown>) }
        : {};
    } catch {
      return {};
    }
  };
  const writeAll = (passes: Record<string, unknown>): void => {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ passes }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, filePath);
  };
  return {
    read: (passId) => {
      const cursor = readAll()[passId];
      return isCursor(cursor) ? cursor : null;
    },
    write: (passId, cursor) => {
      const passes = readAll();
      passes[passId] = cursor;
      writeAll(passes);
    },
    clear: (passId) => {
      const passes = readAll();
      if (!(passId in passes)) return;
      delete passes[passId];
      writeAll(passes);
    },
  };
}

export interface PassProgressOptions {
  io?: PassCursorIO;
  passId: string;
  /** Local day key; default today. */
  day?: string;
  /** Clock for the write throttle. Default `Date.now`. */
  now?: () => number;
  minWriteIntervalMs?: number;
}

export interface PassResume<S> {
  after: PassCursorKey | null;
  partial: PassPartialUnit | null;
  stats: S | null;
}

/**
 * One attempt of one pass. Construct it before the pass's first unit: it
 * reads the cursor, decides whether this attempt resumes, and records the
 * attempt at once.
 */
export class PassProgress<S> {
  /** What an earlier attempt today finished, or null when this attempt starts fresh. */
  readonly resume: PassResume<S> | null;
  readonly attempt: number;
  private readonly io: PassCursorIO | undefined;
  private readonly passId: string;
  private readonly day: string;
  private readonly startedAt: string;
  private readonly now: () => number;
  private readonly minWriteIntervalMs: number;
  private pending: PassCursor<S> | null = null;
  private lastWriteAt = Number.NEGATIVE_INFINITY;

  constructor(options: PassProgressOptions) {
    this.io = options.io;
    this.passId = options.passId;
    this.day = options.day ?? localDayKey();
    this.now = options.now ?? Date.now;
    this.minWriteIntervalMs = Math.max(0, options.minWriteIntervalMs ?? PASS_CURSOR_WRITE_INTERVAL_MS);
    const previous = this.io ? safeRead(this.io, this.passId) : null;
    const resumable = previous !== null
      && previous.day === this.day
      && previous.attempts < MAX_PASS_ATTEMPTS_PER_DAY;
    if (resumable) {
      this.resume = {
        after: previous.after ?? null,
        partial: previous.partial ?? null,
        stats: (previous.stats ?? null) as S | null,
      };
      this.attempt = previous.attempts + 1;
      this.startedAt = previous.startedAt;
    } else {
      this.resume = null;
      this.attempt = previous !== null && previous.day === this.day ? previous.attempts + 1 : 1;
      this.startedAt = new Date(this.now()).toISOString();
    }
    // Record the attempt before any unit runs, so an attempt that kills the
    // process still counts against today's resume.
    this.write({
      day: this.day,
      after: this.resume?.after ?? null,
      partial: this.resume?.partial ?? null,
      stats: this.resume?.stats ?? null,
      startedAt: this.startedAt,
      attempts: this.attempt,
    });
  }

  /** Record what has committed so far; written when the throttle allows. */
  checkpoint(state: { after: PassCursorKey | null; partial: PassPartialUnit | null; stats: S | null }): void {
    if (!this.io) return;
    this.pending = {
      day: this.day,
      after: state.after,
      partial: state.partial ? { key: state.partial.key, done: [...state.partial.done] } : null,
      stats: state.stats === null ? null : structuredClone(state.stats),
      startedAt: this.startedAt,
      attempts: this.attempt,
    };
    if (this.now() - this.lastWriteAt >= this.minWriteIntervalMs) this.flush();
  }

  /** Write the last checkpoint now (a failing pass calls this before it rethrows). */
  flush(): void {
    if (!this.pending) return;
    const cursor = this.pending;
    this.pending = null;
    this.write(cursor);
  }

  /** The pass finished: nothing to resume. */
  complete(): void {
    this.pending = null;
    if (!this.io) return;
    try { this.io.clear(this.passId); } catch { /* a leftover cursor is ignored once its day is over */ }
  }

  private write(cursor: PassCursor<S>): void {
    if (!this.io) return;
    this.lastWriteAt = this.now();
    try { this.io.write(this.passId, cursor as PassCursor<unknown>); } catch { /* resume is best effort; the pass itself goes on */ }
  }
}

function safeRead(io: PassCursorIO, passId: string): PassCursor<unknown> | null {
  try { return io.read(passId); } catch { return null; }
}

/**
 * Compare two order keys component by component: numbers numerically,
 * strings by code unit. `directions[i]` is 1 (ascending, the default) or -1
 * (descending), so a pass can compare keys in its own processing order.
 */
export function comparePassKeys(
  a: PassCursorKey,
  b: PassCursorKey,
  directions: ReadonlyArray<1 | -1> = [],
): number {
  const left = Array.isArray(a) ? a : [a as number | string];
  const right = Array.isArray(b) ? b : [b as number | string];
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const x = left[i]!;
    const y = right[i]!;
    if (x === y) continue;
    const ascending = typeof x === 'number' && typeof y === 'number' ? (x < y ? -1 : 1) : (String(x) < String(y) ? -1 : 1);
    return ascending * (directions[i] ?? 1);
  }
  return left.length - right.length;
}
