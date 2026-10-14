/**
 * Main-loop holds, named.
 *
 * The liveness beacon tells "starved" from "frozen" and journals a stall once
 * the main thread has been gone for ten seconds. Shorter holds were invisible,
 * yet a second-long hold delays every timer, request and turn behind it: a
 * fast classifier with a two-second deadline came back after five, and a
 * trivial request waited behind a list projection. This monitor measures how
 * late a short interval fires; a late tick means the loop was busy the whole
 * time, and the phase transitions recorded at known points name the code that
 * held it. One line per hold over the threshold, beside the beacon.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

export interface LoopKnownPoint {
  /** performance.now() when the phase took the main thread at a known point. */
  at: number;
  name: string;
  detail?: string;
}

export interface LoopHoldSegment {
  name: string;
  detail?: string;
  ms: number;
}

const TICK_MS = 200;
const HOLD_THRESHOLD_MS = 750;
const KEEP_LINES = 1_000;
const TRIM_SLACK = 100;
const MAX_SEGMENTS = 5;

/**
 * Split a busy stretch [startAt, endAt] into the slices each phase owned. The
 * owner at the start is the last known point before it; each later known
 * point inside the stretch hands the thread to its phase.
 */
export function attributeLoopHold(points: readonly LoopKnownPoint[], startAt: number, endAt: number): LoopHoldSegment[] {
  if (!(endAt > startAt)) return [];
  const sorted = [...points].sort((left, right) => left.at - right.at);
  let owner: LoopKnownPoint | undefined;
  const inside: LoopKnownPoint[] = [];
  for (const point of sorted) {
    if (point.at <= startAt) owner = point;
    else if (point.at < endAt) inside.push(point);
  }
  const totals = new Map<string, LoopHoldSegment>();
  const add = (point: LoopKnownPoint | undefined, from: number, to: number) => {
    const ms = Math.max(0, to - from);
    if (ms <= 0) return;
    const name = point?.name ?? 'unattributed';
    const key = `${name}\u0000${point?.detail ?? ''}`;
    const existing = totals.get(key);
    if (existing) existing.ms += ms;
    else totals.set(key, { name, ...(point?.detail ? { detail: point.detail } : {}), ms });
  };
  let cursor = startAt;
  let current = owner;
  for (const point of inside) {
    add(current, cursor, point.at);
    cursor = point.at;
    current = point;
  }
  add(current, cursor, endAt);
  return [...totals.values()]
    .sort((left, right) => right.ms - left.ms)
    .slice(0, MAX_SEGMENTS)
    .map((segment) => ({ ...segment, ms: Math.round(segment.ms) }));
}

function lineCount(file: string): number {
  try { return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).length : 0; }
  catch { return 0; }
}

/** Start the monitor once. The journal is a diagnostic: every failure to write
 *  it is swallowed, and the interval never holds the process open. */
export function startLoopHoldMonitor(input: {
  file: string;
  readPoints: () => readonly LoopKnownPoint[];
  pid?: number;
}): () => void {
  let lines = lineCount(input.file);
  let expected = performance.now() + TICK_MS;
  const timer = setInterval(() => {
    const now = performance.now();
    const lateMs = now - expected;
    expected = now + TICK_MS;
    if (lateMs < HOLD_THRESHOLD_MS) return;
    try {
      const startAt = now - lateMs;
      const record = {
        at: new Date().toISOString(),
        pid: input.pid ?? process.pid,
        heldMs: Math.round(lateMs),
        segments: attributeLoopHold(input.readPoints(), startAt, now),
      };
      appendFileSync(input.file, `${JSON.stringify(record)}\n`);
      lines += 1;
      if (lines > KEEP_LINES + TRIM_SLACK) {
        const kept = readFileSync(input.file, 'utf8').split('\n').filter((line) => line.trim()).slice(-KEEP_LINES);
        const tmp = `${input.file}.tmp`;
        writeFileSync(tmp, `${kept.join('\n')}\n`);
        renameSync(tmp, input.file);
        lines = kept.length;
      }
    } catch { /* a diagnostic never disturbs the daemon */ }
  }, TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
