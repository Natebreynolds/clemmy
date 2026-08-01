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
 * The grace decision is a durable mini-outbox. A terminal is persisted before
 * its timer is armed; viewer arrivals mark that row seen; and watcher startup
 * reconciles rows whose timer belonged to a previous process. Notification ids
 * are source-owned, so a crash after notification persistence but before
 * outbox deletion repairs/reuses the same delivery instead of paging twice.
 *
 * Kill-switch: CLEMMY_FOREGROUND_REPORT_BACK=off.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BASE_DIR } from '../../config.js';
import { actionBus } from '../action-bus.js';
import { addNotification, getNotification } from '../notifications.js';
import { listEvents, type EventRow, type HarnessSessionSignal } from './eventlog.js';
import { publicCompletionText } from './public-presentation.js';
import {
  sessionViewerSeenSince,
  subscribeSessionViewerAttaches,
} from './session-viewers.js';
import {
  presentationEventFromCompletionData,
  type PresentationEvent,
  type TurnOutcomeStatus,
} from './turn-outcome.js';
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
  /** Exact typed terminal state. Publication labels must never infer success
   * from the generic conversation_completed event type. */
  outcome: TurnOutcomeStatus;
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

const TERMINAL_TYPES: ReadonlySet<string> = new Set(['conversation_completed']);

/**
 * Everything the decision needs about the run that just ended, read from the
 * durable log. The run's window opens at the exact source identity carried by
 * the typed terminal, so a later accepted request never steals an older run's
 * work, body, or delivery id.
 */
export function readTerminalRunFacts(input: {
  sessionId: string;
  sessionKind: string;
  channel: string | null;
  terminalSeq: number;
  terminalAt: string;
  /** Exact accepted user event from the validated typed presentation. This is
   * the run boundary even when a newer user turn was accepted before this
   * terminal arrived. */
  sourceUserSeq: number;
  outcome: TurnOutcomeStatus;
  seenByViewer: boolean;
}): TerminalRunFacts | null {
  if (!Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq <= 0) return null;
  // Resolve exactly one durable source row. `sinceSeq` is exclusive, so starting
  // one sequence earlier makes this a bounded point lookup without adding an
  // eventlog API. Never fall back to "latest before terminal": late completion A
  // may legitimately arrive after accepted turn B and must still own A's work.
  let source: EventRow | undefined;
  try {
    [source] = listEvents(input.sessionId, {
      types: ['user_input_received'],
      sinceSeq: input.sourceUserSeq - 1,
      limit: 1,
    });
  } catch {
    return null;
  }
  if (!source || source.seq !== input.sourceUserSeq || source.seq >= input.terminalSeq) return null;
  const startSeq = source.seq;

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

  const startedMs = Date.parse(source.createdAt);
  const terminalMs = Date.parse(input.terminalAt);
  const elapsedMs = Number.isFinite(startedMs) && Number.isFinite(terminalMs)
    ? Math.max(0, terminalMs - startedMs)
    : 0;

  return {
    sessionId: input.sessionId,
    sessionKind: input.sessionKind,
    channel: input.channel,
    elapsedMs,
    toolCalls,
    externalWrites,
    seenByViewer: input.seenByViewer,
    outcome: input.outcome,
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
  const reply = publicCompletionText(input.terminalData ?? {}, '');
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
  const titlePrefix: Record<TurnOutcomeStatus, string> = {
    done: 'Chat run completed',
    needs_input: 'Chat run needs you',
    blocked: 'Chat run blocked',
    failed: 'Chat run failed',
    cancelled: 'Chat run cancelled',
  };
  const title = `${titlePrefix[facts.outcome]}: ${label}`;
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
      needsAttention: facts.outcome !== 'done',
    },
  });
}

// ── Durable pending-report outbox ───────────────────────────────────────────

interface PendingTerminalReport {
  version: 1;
  /** Stable logical source key, not a physical terminal/attempt key. */
  id: string;
  sessionId: string;
  sessionKind: string;
  channel: string | null;
  userId: string | null;
  title: string | null;
  terminalSeq: number;
  terminalAt: string;
  sourceUserSeq: number;
  outcome: TurnOutcomeStatus;
  presentationText: string;
  terminatedAtMs: number;
  dueAtMs: number;
  /** Persisted so a viewer who saw the result before a crash stays "seen". */
  seenAtMs?: number;
}

const REPORT_BACK_OUTBOX_FILE = path.join(
  BASE_DIR,
  'state',
  'terminal-report-back-outbox.json',
);

function pendingReportId(sessionId: string, sourceUserSeq: number): string {
  return `${sessionId}:${sourceUserSeq}`;
}

function notificationIdForPending(pending: PendingTerminalReport): string {
  return `foreground-report-back-${pending.sessionId}-${pending.sourceUserSeq}`;
}

function isTurnOutcomeStatus(value: unknown): value is TurnOutcomeStatus {
  return value === 'done'
    || value === 'needs_input'
    || value === 'blocked'
    || value === 'failed'
    || value === 'cancelled';
}

function isPendingTerminalReport(value: unknown): value is PendingTerminalReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<PendingTerminalReport>;
  return row.version === 1
    && typeof row.id === 'string'
    && typeof row.sessionId === 'string'
    && typeof row.sessionKind === 'string'
    && (row.channel === null || typeof row.channel === 'string')
    && (row.userId === null || typeof row.userId === 'string')
    && (row.title === null || typeof row.title === 'string')
    && Number.isSafeInteger(row.terminalSeq) && Number(row.terminalSeq) > 0
    && typeof row.terminalAt === 'string'
    && Number.isSafeInteger(row.sourceUserSeq) && Number(row.sourceUserSeq) > 0
    && isTurnOutcomeStatus(row.outcome)
    && typeof row.presentationText === 'string' && row.presentationText.trim().length > 0
    && typeof row.terminatedAtMs === 'number' && Number.isFinite(row.terminatedAtMs)
    && typeof row.dueAtMs === 'number' && Number.isFinite(row.dueAtMs)
    && (row.seenAtMs === undefined
      || (typeof row.seenAtMs === 'number' && Number.isFinite(row.seenAtMs)))
    && row.id === pendingReportId(row.sessionId, Number(row.sourceUserSeq));
}

function loadPendingTerminalReports(): PendingTerminalReport[] {
  if (!existsSync(REPORT_BACK_OUTBOX_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(REPORT_BACK_OUTBOX_FILE, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) throw new Error('terminal report-back outbox is not an array');
    return parsed.filter(isPendingTerminalReport);
  } catch {
    // Never replace an unreadable canonical file in place. Preserve it for
    // diagnosis; future terminals can start a fresh valid outbox.
    const quarantined = `${REPORT_BACK_OUTBOX_FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { renameSync(REPORT_BACK_OUTBOX_FILE, quarantined); } catch { /* best effort */ }
    return [];
  }
}

function savePendingTerminalReports(items: PendingTerminalReport[]): void {
  mkdirSync(path.dirname(REPORT_BACK_OUTBOX_FILE), { recursive: true });
  const tmp = `${REPORT_BACK_OUTBOX_FILE}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, JSON.stringify(items, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, REPORT_BACK_OUTBOX_FILE);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

function persistPendingTerminalReport(pending: PendingTerminalReport): PendingTerminalReport | null {
  // Notification persistence won a previous crash boundary. Reusing its stable
  // id is the delivery receipt; never arm a second outbound signal.
  if (getNotification(notificationIdForPending(pending))) return null;
  const items = loadPendingTerminalReports();
  const existing = items.find((item) => item.id === pending.id);
  if (existing) return existing;
  items.push(pending);
  savePendingTerminalReports(items);
  return pending;
}

function removePendingTerminalReport(id: string): void {
  const items = loadPendingTerminalReports();
  const next = items.filter((item) => item.id !== id);
  if (next.length !== items.length) savePendingTerminalReports(next);
}

function markPendingReportsSeen(sessionId: string, seenAtMs: number): void {
  const items = loadPendingTerminalReports();
  let changed = false;
  for (const item of items) {
    if (item.sessionId !== sessionId || seenAtMs < item.terminatedAtMs) continue;
    if (item.seenAtMs !== undefined && item.seenAtMs >= seenAtMs) continue;
    item.seenAtMs = seenAtMs;
    changed = true;
  }
  if (changed) savePendingTerminalReports(items);
}

type Timer = ReturnType<typeof setTimeout>;
const armed = new Map<string, Timer>();

function processPendingTerminalReport(id: string): void {
  const pending = loadPendingTerminalReports().find((item) => item.id === id);
  if (!pending) return;
  try {
    if (getNotification(notificationIdForPending(pending))) {
      removePendingTerminalReport(id);
      return;
    }
    const seenByViewer = pending.seenAtMs !== undefined
      || sessionViewerSeenSince(pending.sessionId, pending.terminatedAtMs);
    const facts = readTerminalRunFacts({
      sessionId: pending.sessionId,
      sessionKind: pending.sessionKind,
      channel: pending.channel,
      terminalSeq: pending.terminalSeq,
      terminalAt: pending.terminalAt,
      sourceUserSeq: pending.sourceUserSeq,
      outcome: pending.outcome,
      seenByViewer,
    });
    if (!facts || !decideTerminalReportBack(facts).deliver) {
      removePendingTerminalReport(id);
      return;
    }
    emitTerminalReportBack(
      facts,
      { title: pending.title, userId: pending.userId },
      pending.presentationText,
    );
    // Notification first, then outbox acknowledgement. A crash between these
    // writes replays the stable notification id and cannot duplicate delivery.
    removePendingTerminalReport(id);
  } catch {
    // Keep the durable row. Watcher startup will reconcile it after restart.
  }
}

function armPendingTerminalReport(pending: PendingTerminalReport, now: () => number): void {
  if (armed.has(pending.id)) return;
  const delay = Math.max(0, Math.min(2_147_483_647, pending.dueAtMs - now()));
  const timer = setTimeout(() => {
    armed.delete(pending.id);
    processPendingTerminalReport(pending.id);
  }, delay);
  timer.unref?.();
  armed.set(pending.id, timer);
}

function decodeOwnedPresentation(event: EventRow): PresentationEvent | null {
  try {
    const presentation = presentationEventFromCompletionData(event.data);
    if (!presentation || presentation.identity.sessionId !== event.sessionId) return null;
    if (presentation.identity.turn !== event.turn) return null;
    return presentation;
  } catch {
    return null;
  }
}

/** Test-only reset for the file-backed outbox. Watchers must be stopped first. */
export function resetTerminalReportBackOutboxForTest(): void {
  try { unlinkSync(REPORT_BACK_OUTBOX_FILE); } catch { /* absent is already reset */ }
}

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
  // Viewer observations are persisted while a row is pending, which keeps the
  // no-duplicate decision truthful if the process dies inside the grace window.
  const unsubscribeViewers = subscribeSessionViewerAttaches((sessionId, attachedAt) => {
    try { markPendingReportsSeen(sessionId, attachedAt); } catch { /* best effort */ }
  });
  // This is the boot drain: the daemon's existing watcher registration is the
  // only hook required. Rows whose old timer died are re-armed at their original
  // deadline (or immediately when already due).
  for (const pending of loadPendingTerminalReports()) {
    armPendingTerminalReport(pending, now);
  }
  const unsubscribe = actionBus.subscribe((busEvent) => {
    if (busEvent.kind !== 'harness.public_event') return;
    if (!foregroundReportBackEnabled()) return;
    const event = busEvent.event as EventRow;
    if (!TERMINAL_TYPES.has(event.type)) return;
    const session = busEvent.session as HarnessSessionSignal | undefined;
    if (!session || session.kind !== 'chat') return;
    if (OUT_OF_BAND_CHANNELS.has((session.channel ?? '').toLowerCase())) return;

    const presentation = decodeOwnedPresentation(event);
    if (!presentation) return;
    const key = pendingReportId(event.sessionId, presentation.identity.sourceUserSeq);
    if (armed.has(key)) return;
    const terminatedAtMs = now();
    const pending = persistPendingTerminalReport({
      version: 1,
      id: key,
      sessionId: event.sessionId,
      sessionKind: session.kind,
      channel: session.channel,
      userId: session.userId,
      title: session.title,
      terminalSeq: event.seq,
      terminalAt: event.createdAt,
      sourceUserSeq: presentation.identity.sourceUserSeq,
      outcome: presentation.status,
      presentationText: presentation.text,
      terminatedAtMs,
      dueAtMs: terminatedAtMs + Math.max(0, graceMs),
      ...(sessionViewerSeenSince(event.sessionId, terminatedAtMs)
        ? { seenAtMs: terminatedAtMs }
        : {}),
    });
    if (pending) armPendingTerminalReport(pending, now);
  });
  return () => {
    for (const timer of armed.values()) clearTimeout(timer);
    armed.clear();
    unsubscribe();
    unsubscribeViewers();
  };
}
