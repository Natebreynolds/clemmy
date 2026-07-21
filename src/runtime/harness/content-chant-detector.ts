/**
 * Content-chanting detector (2026-07-20) — ADVISORY-first port of Gemini CLI's
 * content-loop detection (loopDetectionService.ts), the one runaway class our
 * control plane did not cover: a model emitting the SAME text over and over
 * (no tool calls, so the grind ladder never sees it; still streaming, so the
 * stall watchdog never fires; bounded only by the turn/token ceilings).
 *
 * Detection: the stream is cut into fixed-size chunks on a half-chunk stride
 * (overlapping windows); a chunk repeating `threshold` times trips ONCE per
 * turn. Chunks without enough distinct alphanumeric characters never count —
 * markdown table rules, ASCII art, and indentation runs legitimately repeat
 * (Gemini's unique-variation check, simplified).
 *
 * ADVISORY ONLY, by design: a trip emits a `guardrail_tripped` event
 * (kind 'content_chanting') and a log line — it never halts the stream.
 * Gemini shipped theirs authoritative and its false positives became their
 * top loop-detection complaint (session-disable escape hatch, issues
 * #20106/#8928); our own scar says an authoritative check turns latent
 * false-positives into live fail-closed bugs. Telemetry first; enforcement
 * only after the advisory proves quiet in the field.
 */

export interface ChantTrip {
  /** The repeating chunk (verbatim, chunkSize chars). */
  chunk: string;
  /** How many times it had repeated when the detector tripped. */
  repeats: number;
}

/** Kill-switch: CLEMMY_CONTENT_CHANT=off silences detection entirely. */
export function contentChantDetectionEnabled(): boolean {
  const v = (process.env.CLEMMY_CONTENT_CHANT ?? 'on').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false');
}

/** Minimum distinct alphanumeric characters for a chunk to count. */
const MIN_DISTINCT_ALNUM = 8;

function isDiverseEnough(chunk: string): boolean {
  const distinct = new Set<string>();
  for (const ch of chunk) {
    if (/[a-zA-Z0-9]/.test(ch)) {
      distinct.add(ch.toLowerCase());
      if (distinct.size >= MIN_DISTINCT_ALNUM) return true;
    }
  }
  return false;
}

export class ContentChantDetector {
  private carry = '';
  private readonly counts = new Map<string, number>();
  private tripped: ChantTrip | null = null;

  constructor(
    private readonly chunkSize = 50,
    private readonly threshold = 10,
    /** Bounded memory: when the tracked-window map exceeds this, count-1
     *  windows are pruned (prose is almost entirely count-1; a chanting
     *  window's count only grows, so pruning never loses a real chant). */
    private readonly maxTracked = 4000,
  ) {}

  /** Feed one streamed delta. Returns the trip exactly ONCE (first crossing);
   *  every later call returns null. Never throws.
   *
   *  Stride is FINE (5 chars), not half-chunk: a periodic chant with period P
   *  produces windows at gcd(stride, P) phase classes — a coarse stride spreads
   *  the repeats across many phases and no single window ever reaches the
   *  threshold (the exact miss the first cut of this detector shipped with).
   *  Memory stays bounded by pruning count-1 windows (prose is almost entirely
   *  count-1; a chanting window's count only grows, so pruning never loses it). */
  feed(delta: string): ChantTrip | null {
    try {
      if (this.tripped || !delta) return null;
      this.carry += delta;
      const stride = 5;
      while (this.carry.length >= this.chunkSize) {
        const chunk = this.carry.slice(0, this.chunkSize);
        this.carry = this.carry.slice(stride);
        if (!isDiverseEnough(chunk)) continue;
        const n = (this.counts.get(chunk) ?? 0) + 1;
        this.counts.set(chunk, n);
        if (n >= this.threshold) {
          this.tripped = { chunk, repeats: n };
          return this.tripped;
        }
        if (this.counts.size > this.maxTracked) {
          for (const [key, count] of this.counts) {
            if (count === 1) this.counts.delete(key);
          }
        }
      }
      return null;
    } catch {
      return null; // detection must never break a healthy stream
    }
  }

  get hasTripped(): boolean {
    return this.tripped !== null;
  }
}
