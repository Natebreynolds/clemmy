import { getRuntimeEnv } from '../config.js';
import { listEvents } from '../runtime/harness/eventlog.js';

/**
 * First-fan-out alignment beat (v2.2.2): launching a large parallel fleet as
 * the FIRST action of a fresh request skips the conversational beat that
 * makes Clementine feel like a colleague instead of a cannon (live
 * 2026-07-22: 30 agents fanned out on turn one; the offer-background beat
 * arrived AFTER the work; the user: "this is amazing but i would love more
 * conversation to validate before kicking off").
 *
 * Deterministic, bounded, fail-open — the same contract as self-serve-gate:
 * the first run_worker call with items ≥ threshold in a session where the
 * user has only spoken ONCE (the initiating prompt — no conversation has
 * happened yet) bounces ONCE with a present-the-plan steer. A session where
 * the user has already exchanged messages is already aligned — no bounce.
 * The retry always goes through. Kill-switch CLEMMY_FANOUT_ALIGNMENT_BEAT.
 *
 * This narrows, not widens, "a precise request IS alignment": ordinary work
 * still starts immediately; only a first-contact MASS fan-out earns one beat.
 */

const DEFAULT_ITEM_THRESHOLD = 10;

export function fanoutAlignmentBeatEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_FANOUT_ALIGNMENT_BEAT', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

function itemThreshold(): number {
  const n = Number.parseInt(getRuntimeEnv('CLEMMY_FANOUT_ALIGNMENT_ITEMS', '') || '', 10);
  return Number.isFinite(n) && n >= 2 ? n : DEFAULT_ITEM_THRESHOLD;
}

// In-memory one-shot (turn-flow control, not durable state).
const bouncedSessions = new Set<string>();
// Sessions ARMED by the policy classifier: first-contact chat turn whose work
// shape classified as mass/multi-item. The bounce then fires at the first
// MASS-EXECUTION tool call regardless of which door the work takes —
// run_worker OR the code-mode batch dispatch (the acceptance run walked
// through code-mode and made a run_worker-only gate vacuous, 2026-07-22).
// Read-only research stays free so the plan the model presents is informed.
const armedSessions = new Map<string, number>(); // sessionId -> itemCount

export function clearFanoutAlignmentBouncesForTest(): void {
  bouncedSessions.clear();
  armedSessions.clear();
}

/** Called at the policy-classification site (loop context assembly): arm the
 *  beat for a first-contact chat session with mass-shaped work. Fail-open. */
export function armFirstContactBeat(opts: {
  sessionId: string | undefined;
  sessionKind: string | undefined;
  itemCount: number;
  userMessageCount: number;
}): void {
  try {
    if (!fanoutAlignmentBeatEnabled()) return;
    const sessionId = (opts.sessionId ?? '').trim();
    if (!sessionId || bouncedSessions.has(sessionId) || armedSessions.has(sessionId)) return;
    if (opts.sessionKind && opts.sessionKind !== 'chat') return;
    if (sessionId.startsWith('background:') || sessionId.startsWith('workflow:')) return;
    if (!classifyFanoutAlignmentBounce({ itemCount: opts.itemCount, userMessageCount: opts.userMessageCount })) return;
    armedSessions.set(sessionId, opts.itemCount);
  } catch { /* fail-open */ }
}

/** Consulted at MASS-EXECUTION tool boundaries (run_worker, code-mode batch):
 *  when the session is armed, bounce ONCE with the plan-beat steer. */
export function maybeBounceMassExecution(sessionId: string | undefined): { bounce: boolean; steer?: string } {
  try {
    if (!fanoutAlignmentBeatEnabled()) return { bounce: false };
    const id = (sessionId ?? '').trim();
    if (!id) return { bounce: false };
    const itemCount = armedSessions.get(id);
    if (itemCount === undefined) return { bounce: false };
    armedSessions.delete(id);
    bouncedSessions.add(id);
    return { bounce: true, steer: fanoutAlignmentSteer(itemCount) };
  } catch {
    return { bounce: false };
  }
}

/** Pure-ish: should THIS run_worker call pause for one alignment beat?
 *  userMessageCount lets tests drive it without an event log. */
export function classifyFanoutAlignmentBounce(opts: {
  itemCount: number;
  userMessageCount: number;
}): boolean {
  if (opts.itemCount < itemThreshold()) return false;
  // ≥2 user messages = a conversation already happened = aligned.
  return opts.userMessageCount <= 1;
}

export function fanoutAlignmentSteer(itemCount: number): string {
  return [
    `PAUSE before fan-out: this would launch ${itemCount} parallel workers as the first action of a fresh request, with no conversational beat yet.`,
    'FIRST, reply to the user in ONE short, plain-words message: what you found, your per-item plan, what gets written where, and that nothing irreversible happens without their say — then offer: run it in the background, hold it, or do it now.',
    'After the user answers (any reply counts), call run_worker again with the SAME items — it will go through.',
  ].join(' ');
}

/** One-shot session gate. Fail-open everywhere: errors, repeat calls, the
 *  kill-switch, and already-conversing sessions all resolve to "proceed". */
export function maybeFanoutAlignmentBounce(opts: {
  sessionId: string | undefined;
  itemCount: number;
}): { bounce: boolean; steer?: string } {
  try {
    if (!fanoutAlignmentBeatEnabled()) return { bounce: false };
    const sessionId = (opts.sessionId ?? '').trim();
    if (!sessionId || bouncedSessions.has(sessionId)) return { bounce: false };
    // Background/workflow sessions carry a single seeded prompt by design —
    // their alignment beat happened in the ORIGIN chat before the handoff.
    if (sessionId.startsWith('background:') || sessionId.startsWith('workflow:')) return { bounce: false };
    let userMessageCount = 0;
    try {
      userMessageCount = listEvents(sessionId, { types: ['user_input_received'] })
        .filter((e) => !(e.data as { synthetic?: boolean } | undefined)?.synthetic).length;
    } catch {
      return { bounce: false };
    }
    if (!classifyFanoutAlignmentBounce({ itemCount: opts.itemCount, userMessageCount })) return { bounce: false };
    bouncedSessions.add(sessionId);
    return { bounce: true, steer: fanoutAlignmentSteer(opts.itemCount) };
  } catch {
    return { bounce: false };
  }
}

/** Heavy per-item tool advisory (live 2026-07-23): a 120-account run planned a
 *  BROWSER SESSION per item — the most expensive per-item path there is — and
 *  only a mid-run human steer ("skip the screenshots") saved it. Deterministic
 *  and advisory-only (inform, never block): when a large fan-out's packet
 *  names browser/screenshot-class tools, the FIRST batch result carries one
 *  cost note nudging toward a batch API or a single reused session. */
const HEAVY_PER_ITEM_TOOL_RE = /\b(?:browser_harness_run|browser_harness|screenshot|playwright|puppeteer)\b/i;
const HEAVY_ADVISORY_MIN_ITEMS = 10;
const heavyAdvisorySessions = new Set<string>();

export function maybeHeavyPerItemToolAdvisory(
  sessionId: string | undefined,
  itemCount: number,
  packetText: string,
): string | null {
  if (!sessionId || itemCount < HEAVY_ADVISORY_MIN_ITEMS) return null;
  if (!HEAVY_PER_ITEM_TOOL_RE.test(packetText)) return null;
  if (heavyAdvisorySessions.has(sessionId)) return null;
  heavyAdvisorySessions.add(sessionId);
  return `[cost advisory] This fan-out runs a browser/screenshot-class tool PER ITEM (${itemCount} items) — the most expensive per-item path. If the goal is page content, a batch scrape API (one call for all items) or a single reused browser session is dramatically cheaper and faster. Proceeding is fine if per-item browser rendering is genuinely required; otherwise re-plan the packet now, before the batch runs.`;
}

export function _resetHeavyAdvisoryForTests(): void {
  heavyAdvisorySessions.clear();
}
