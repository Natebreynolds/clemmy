/**
 * ALWAYS REPORTS BACK — for foreground chat runs too.
 *
 * A background task that finishes emits a loud terminal notification which the
 * delivery worker fans out to the user's real channels (their own push devices
 * for an in-app task, the Discord/Slack DM for one born there). A FOREGROUND
 * chat run — the same work, started by typing it into the chat instead of
 * handing it off — had no out-of-band delivery at all. Its only path back was
 * the transcript, which reaches the user only while they are sitting in front of
 * it, plus a prompt directive that fires on their NEXT message. So a ten-minute
 * scrape that the user walked away from finished into silence: the work was
 * done, the result was written, and the only way to learn either was to come
 * back and ask (live, 2026-07-31).
 *
 * That made "does Clementine tell me when she's finished" a property of WHICH
 * BUTTON the user pressed before the work started — a choice they have to make
 * in advance, correctly, about a run whose length they cannot yet know. The
 * north star says delivery is identical whether a run was foreground,
 * backgrounded, or dispatched: same signal, same channels.
 *
 * So this closes the gap at the only place that generalizes — the run TERMINUS
 * in the event log, which every brain (Codex loop, Claude Agent SDK, BYO) and
 * every surface writes through. When a chat run terminates, if it did real work
 * and nobody was in the room to see it land, it emits the SAME notification
 * shape a background task emits, with the SAME report-back metadata, so it rides
 * the SAME delivery machinery. Nothing here invents a second notification path.
 *
 * Three conditions, all deterministic, all for the same reason — a notification
 * the user does not need is worse than none, because it teaches them to ignore
 * the ones they do:
 *
 *   1. SUBSTANTIVE. The run either changed something in the world, or took long
 *      enough / did enough work that the user plausibly stopped waiting on it.
 *      "hey" does not page anyone.
 *   2. UNSEEN. No live viewer was attached to the session between the moment the
 *      run finished and the end of a short grace window. Someone who watched the
 *      result arrive has already been reported to.
 *   3. VIEWER-DEPENDENT SURFACE. Discord, Slack and the CLI already deliver the
 *      reply out-of-band by construction — the message lands in the channel
 *      whether or not the user is looking. Pinging them again is a duplicate,
 *      not parity. Only surfaces whose delivery depends on an open view (the
 *      desktop dock, mobile, the Workspace dock) can leave a result stranded.
 *
 * KNOWN BOUND: the grace window is an in-memory timer, so a daemon restart in
 * the ~45s between a run finishing and the decision being made loses that one
 * report. Making it durable would mean persisting a pending-report record and
 * reconciling it at boot — and a boot sweep cannot tell "nobody saw it" from
 * "the timer already decided somebody did", so it would have to re-derive that
 * too. Deliberately not built: the hole is one narrow window against a bug that
 * used to swallow EVERY foreground run, and the machinery would cost more than
 * it returns. Recorded here so the next person weighs it with the same numbers.
 *
 * Kill-switch: CLEMMY_FOREGROUND_REPORT_BACK=off.
 */
import { actionBus } from '../action-bus.js';
import { addNotification } from '../notifications.js';
import { listEvents, type EventRow, type HarnessSessionSignal } from './eventlog.js';
import { sessionViewerSeenSince } from './session-viewers.js';
import { synthesizeWorkReport } from './work-report.js';

export function foregroundReportBackEnabled(): boolean {
  return (process.env.CLEMMY_FOREGROUND_REPORT_BACK ?? 'on').toLowerCase() !== 'off';
}

/**
 * Channels that put the reply in front of the user without an open view. A run
 * on one of these is already reported back the moment it finishes; a second
 * signal would be a duplicate. Everything else — the desktop dock, mobile, a
 * Workspace dock, a session with no channel at all — renders through a live
 * subscription and can therefore finish into an empty room.
 */
const OUT_OF_BAND_CHANNELS: ReadonlySet<string> = new Set(['discord', 'slack', 'cli', 'smoke']);

/** Long enough that the user has plausibly stopped watching and gone elsewhere. */
const SUBSTANTIVE_ELAPSED_MS = 90_000;
/** Enough tool work that this was a job, not an answer — even if it ran fast. */
const SUBSTANTIVE_TOOL_CALLS = 8;
/**
 * Breathing room after the terminal event before we decide nobody saw it. Covers
 * an SSE reconnect (sleeping tab, network blip, app switch) and the moment
 * between a user reading the reply and closing the window.
 */
export const REPORT_BACK_GRACE_MS = 45_000;

export interface TerminalRunFacts {
  sessionId: string;
  /** Session kind from the event log: only 'chat' runs are in scope here. */
  sessionKind: string;
  /** Origin channel, or null/'' for the desktop dock. */
  channel: string | null;
  /** User input → terminal event. */
  elapsedMs: number;
  /** Tool calls the run made. */
  toolCalls: number;
  /** External writes it landed (confirmed only — a reservation is not a fact). */
  externalWrites: number;
  /** Was a live viewer attached at any point since the run terminated? */
  seenByViewer: boolean;
  outcome: 'completed' | 'failed' | 'awaiting';
  /** Seq of the user input that opened this run — the window's lower bound. */
  startSeq: number;
}

export interface TerminalReportBackDecision {
  deliver: boolean;
  reason:
    | 'disabled'
    | 'not_a_chat_run'
    | 'out_of_band_channel'
    | 'seen_by_viewer'
    | 'not_substantive'
    | 'report_back';
}

/**
 * Pure. Given what a finished run actually did and whether anyone watched it
 * land, decide whether it still owes the user an out-of-band report.
 *
 * Note the ORDER: the surface and viewer checks come before the substance
 * check, because they are statements about delivery already having happened.
 * A run whose result reached the user is finished regardless of how big it was.
 */
export function decideTerminalReportBack(facts: TerminalRunFacts): TerminalReportBackDecision {
  if (!foregroundReportBackEnabled()) return { deliver: false, reason: 'disabled' };
  // Workflow / worker / execution sessions each have their own report-back and
  // would double-signal; background tasks notify from their own terminus.
  if (facts.sessionKind !== 'chat') return { deliver: false, reason: 'not_a_chat_run' };
  if (OUT_OF_BAND_CHANNELS.has((facts.channel ?? '').toLowerCase())) {
    return { deliver: false, reason: 'out_of_band_channel' };
  }
  if (facts.seenByViewer) return { deliver: false, reason: 'seen_by_viewer' };
  // An external write is substantive at ANY duration: if she sent an email or
  // wrote a row on the user's behalf, they need to know it happened even if it
  // took four seconds.
  const substantive = facts.externalWrites > 0
    || facts.elapsedMs >= SUBSTANTIVE_ELAPSED_MS
    || facts.toolCalls >= SUBSTANTIVE_TOOL_CALLS;
  if (!substantive) return { deliver: false, reason: 'not_substantive' };
  return { deliver: true, reason: 'report_back' };
}

// ── Reading the run out of the event log ────────────────────────────────────

const TERMINAL_TYPES: ReadonlySet<string> = new Set(['conversation_completed', 'run_failed']);

function textOf(data: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Everything the decision needs about the run that just ended, read from the
 * durable log. The run's window is "since the user's last input" — the same
 * boundary every other per-request projection in the harness uses, so a long
 * conversation's earlier turns never inflate this one's work count.
 */
export function readTerminalRunFacts(input: {
  sessionId: string;
  sessionKind: string;
  channel: string | null;
  terminalSeq: number;
  terminalType: string;
  terminalAt: string;
  /** The terminal event's own payload — supplied by the caller, which already
   *  has it, so finding the run's outcome never costs a query. */
  terminalData?: Record<string, unknown>;
  seenByViewer: boolean;
}): TerminalRunFacts | null {
  // The run's lower bound is the user's most recent input BEFORE the terminal.
  // Ask for exactly that, rather than reading a slice of the session and
  // scanning it: the first cut read the newest 2000 events and looked for the
  // input inside them, which fails on precisely the runs this feature exists
  // for. A scrape that makes two thousand tool calls pushes its own opening
  // message out of that window, so startSeq stayed 0, the facts came back null,
  // and the LONGEST runs — the ones nobody is still watching — were the only
  // ones that never reported. Found by probing the new code against a
  // 2200-event run before it shipped.
  let startSeq = 0;
  let startedAt = input.terminalAt;
  try {
    for (const event of listEvents(input.sessionId, {
      types: ['user_input_received'],
      desc: true,
      limit: 20,
    })) {
      if (event.seq < input.terminalSeq && event.seq > startSeq) {
        startSeq = event.seq;
        startedAt = event.createdAt;
      }
    }
  } catch {
    return null;
  }
  // No user input before this terminal means it is not a user-facing run at all
  // (a synthetic ack, a resumed system beat) — nothing to report.
  if (startSeq === 0) return null;

  // Only the event types the decision actually counts, and only from the run's
  // own boundary forward. Bounded by the run's real work, not by the session.
  let toolCalls = 0;
  let confirmedWrites = 0;
  let legacyWrites = 0;
  try {
    for (const event of listEvents(input.sessionId, {
      types: ['tool_called', 'external_write', 'external_write_succeeded'],
      sinceSeq: startSeq,
    })) {
      if (event.seq > input.terminalSeq) break;
      if (event.type === 'tool_called') toolCalls += 1;
      else if (event.type === 'external_write_succeeded') confirmedWrites += 1;
      else if (event.data.preDispatch !== true) legacyWrites += 1;
    }
  } catch { /* counts stay at zero — the decision simply reads as less substantive */ }
  const externalWrites = confirmedWrites || legacyWrites;

  const startedMs = Date.parse(startedAt);
  const terminalMs = Date.parse(input.terminalAt);
  const elapsedMs = Number.isFinite(startedMs) && Number.isFinite(terminalMs)
    ? Math.max(0, terminalMs - startedMs)
    : 0;

  const reason = textOf(input.terminalData ?? {}, 'reason');
  const outcome: TerminalRunFacts['outcome'] = input.terminalType === 'run_failed'
    ? 'failed'
    : reason.startsWith('awaiting')
      ? 'awaiting'
      : 'completed';

  return {
    sessionId: input.sessionId,
    sessionKind: input.sessionKind,
    channel: input.channel,
    elapsedMs,
    toolCalls,
    externalWrites,
    seenByViewer: input.seenByViewer,
    outcome,
    startSeq,
  };
}

/**
 * The words the user gets. Prefer what she actually said — the reply IS the
 * report — and fall back to the durable write ledger when a turn finished
 * without prose, which is exactly what work-report.ts exists for.
 */
export function buildTerminalReportBody(input: {
  sessionId: string;
  terminalSeq: number;
  startSeq: number;
  /** The terminal event's payload. Her own words ARE the report, and the caller
   *  already holds them — so the common case costs no query at all. The first
   *  cut re-read the session to find this event and used an OLDEST-first slice,
   *  so on a long run the terminal was not in the rows fetched and the real
   *  reply was replaced by a generic line. */
  terminalData?: Record<string, unknown>;
}): string {
  const reply = textOf(input.terminalData ?? {}, 'reply', 'summary');
  if (reply) return reply;
  // No prose: fall back to the durable write ledger for this run's window only.
  let evidence: EventRow[] = [];
  try {
    evidence = listEvents(input.sessionId, {
      types: ['external_write', 'external_write_succeeded', 'external_write_failed', 'external_write_orphaned'],
      sinceSeq: input.startSeq,
    }).filter((event) => event.seq <= input.terminalSeq);
  } catch { /* fall through to the generic line */ }
  return synthesizeWorkReport(evidence) ?? 'This run finished. Open the conversation for the result.';
}

// ── Arming ──────────────────────────────────────────────────────────────────

/**
 * Deliver the report through the SAME path a background task's completion takes:
 * an `execution` notification carrying `reportBackTargetType: 'origin_chat'` and
 * `terminalReportBack: true`. That metadata pair is what
 * getNotificationDestinationsForRecord reads to resolve the user's OWN push
 * devices, and what the delivery worker rides.
 *
 * The id is keyed on the USER INPUT that opened the run, not on the terminal
 * event — because the unit the user cares about is "I asked for a thing", and a
 * single request can write more than one terminal event (an approval resolution
 * followed by the real completion, a limit-exceeded prompt, a resumed turn).
 * Keyed per terminal event, each of those would have been a separate page for
 * one piece of work. The stable-id dedup inside addNotification then makes every
 * later arm for the same request a no-op.
 */
function emitTerminalReportBack(
  facts: TerminalRunFacts,
  session: { title: string | null; userId: string | null },
  body: string,
): void {
  const label = (session.title ?? '').trim() || 'your request';
  const title = facts.outcome === 'failed'
    ? `Chat run failed: ${label}`
    : facts.outcome === 'awaiting'
      ? `Chat run needs you: ${label}`
      : `Chat run completed: ${label}`;
  addNotification({
    id: `foreground-report-back-${facts.sessionId}-${facts.startSeq}`,
    kind: 'execution',
    title,
    body,
    createdAt: new Date().toISOString(),
    read: false,
    metadata: {
      sessionId: facts.sessionId,
      userId: session.userId ?? undefined,
      channel: facts.channel ?? undefined,
      reportBackTargetType: 'origin_chat',
      reportBackTargetId: 'origin-chat',
      terminalReportBack: true,
      foregroundRun: true,
      status: facts.outcome,
      needsAttention: facts.outcome !== 'completed',
    },
  });
}

type Timer = ReturnType<typeof setTimeout>;
const armed = new Map<string, Timer>();

/**
 * Watch the event log for chat-run terminals and arm a report-back for each.
 * Returns an unsubscribe. Called once at daemon boot.
 *
 * The grace window is the whole trick: the decision cannot be made at the
 * terminal event itself, because "nobody is watching" a millisecond after a run
 * ends is indistinguishable from "the client is mid-reconnect". So we arm, wait,
 * and only then ask whether anyone showed up.
 */
export function startTerminalReportBackWatcher(options: {
  graceMs?: number;
  now?: () => number;
} = {}): () => void {
  const graceMs = options.graceMs ?? REPORT_BACK_GRACE_MS;
  const now = options.now ?? Date.now;
  const unsubscribe = actionBus.subscribe((busEvent) => {
    if (busEvent.kind !== 'harness.event') return;
    if (!foregroundReportBackEnabled()) return;
    const event = busEvent.event as EventRow;
    if (!TERMINAL_TYPES.has(event.type)) return;
    const session = busEvent.session as HarnessSessionSignal | undefined;
    if (!session || session.kind !== 'chat') return;
    if (OUT_OF_BAND_CHANNELS.has((session.channel ?? '').toLowerCase())) return;

    const key = `${event.sessionId}:${event.seq}`;
    if (armed.has(key)) return;
    const terminatedAtMs = now();
    const timer = setTimeout(() => {
      armed.delete(key);
      try {
        const facts = readTerminalRunFacts({
          sessionId: event.sessionId,
          sessionKind: session.kind,
          channel: session.channel,
          terminalSeq: event.seq,
          terminalType: event.type,
          terminalAt: event.createdAt,
          terminalData: event.data,
          seenByViewer: sessionViewerSeenSince(event.sessionId, terminatedAtMs),
        });
        if (!facts) return;
        if (!decideTerminalReportBack(facts).deliver) return;
        emitTerminalReportBack(
          facts,
          { title: session.title, userId: session.userId },
          buildTerminalReportBody({
            sessionId: event.sessionId,
            terminalSeq: event.seq,
            startSeq: facts.startSeq,
            terminalData: event.data,
          }),
        );
      } catch { /* report-back is best-effort; never break the event bus */ }
    }, graceMs);
    timer.unref?.();
    armed.set(key, timer);
  });
  return () => {
    for (const timer of armed.values()) clearTimeout(timer);
    armed.clear();
    unsubscribe();
  };
}
