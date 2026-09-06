/**
 * A run, presented — the console's half of "a run is a page".
 *
 * THE DEFECT THIS EXISTS TO FIX. `GET /api/console/sessions` has always
 * returned workflow / execution / agent runs beside chats, with pin, rename,
 * tag, archive and server-side search working for every one of them
 * (sessions-api.ts patchUnifiedSession walks the whole collapsed workflow run).
 * The console then threw them away in one `select` and painted the few a user
 * reached by URL as chat bubbles behind a lock. So the unit of work in this
 * product had no page, and the console read as a chat app.
 *
 * Everything here is pure so it can be tested without a DOM: which kinds are
 * runs, how a run row reads in the rail, how long it has been going, and — the
 * one that matters — how a write row reads. That last one is a lie waiting to
 * happen in both directions, so the rules are stated once, here:
 *
 *   · a RESERVED write has not happened. It renders as live work in the
 *     ledger's own present tense, never as a receipt with a tick.
 *   · `irreversible: null` means the public bus did not say. Silence is not
 *     "can't be undone" — an omitted phrase is the only honest rendering.
 *
 * Both rules already live in @clem/chat-engine's write ledger; this module
 * consumes it rather than re-deriving it, and its tests pin that it stays
 * consumed.
 */
import type { Tone } from '@/components/ui/StatusPill';
import {
  foldWriteLedger,
  narrateActivity,
  reduceActivity,
  sealOpenWrites,
  settleTerminalActivity,
  writeReversibilityLabel,
  writeRowLabel,
  writeRowStatus,
  writeRowTone,
  type ActivityItem,
  type ActivityTerminalOutcome,
  type HarnessEvent as EngineHarnessEvent,
  type WriteLedgerRow,
} from '@clem/chat-engine';
import { serverElapsedLabel } from './running-tasks';

/** The three session kinds the harness gives a run. `chat` is the fourth. */
const RUN_KINDS: ReadonlySet<string> = new Set(['workflow', 'execution', 'agent']);

export function isRunKind(kind: string): boolean {
  return RUN_KINDS.has(kind);
}

// ─── the rail's segmented filter ────────────────────────────────────────────

export type ConversationKindFilter = 'all' | 'chats' | 'runs';

export const CONVERSATION_KIND_FILTERS: ReadonlyArray<{
  id: ConversationKindFilter;
  label: string;
}> = [
  { id: 'all', label: 'All' },
  { id: 'chats', label: 'Chats' },
  { id: 'runs', label: 'Runs' },
];

/** Anything unrecognised — a kind from a newer daemon — reads as a
 *  conversation rather than vanishing from both segments. A row shown in the
 *  wrong place is noise; a row shown nowhere is a disappearance. */
export function matchesKindFilter(kind: string, filter: ConversationKindFilter): boolean {
  if (filter === 'runs') return isRunKind(kind);
  if (filter === 'chats') return !isRunKind(kind);
  return true;
}

/** Preserves input order, which is the server's: pinned first, then updatedAt
 *  descending. The rail's date grouping depends on that order surviving. */
export function filterSessionsByKind<T extends { kind: string }>(
  sessions: readonly T[],
  filter: ConversationKindFilter,
): T[] {
  return sessions.filter((s) => matchesKindFilter(s.kind, filter));
}

export function parseConversationKindFilter(raw: string | null | undefined): ConversationKindFilter {
  return CONVERSATION_KIND_FILTERS.some((f) => f.id === raw)
    ? (raw as ConversationKindFilter)
    : 'all';
}

/**
 * The rail's empty state.
 *
 * "No conversations yet" is a claim about everything, and the rail has not
 * seen everything: the server returns ONE page ordered across chats and runs
 * together, and there is no per-kind filter on the route. A busy morning of
 * workflow runs can fill that page and hide every chat behind it. When the
 * page came back full, the honest sentence is about the page.
 */
export function conversationEmptyStateText(input: {
  filter: ConversationKindFilter;
  query: string;
  /** Rows the server returned before the kind segment sliced them. */
  fetched: number;
  pageSize: number;
}): string {
  if (input.query) return `Nothing matches “${input.query}”.`;
  const sawEverything = input.fetched < input.pageSize;
  if (input.filter === 'runs') {
    return sawEverything
      ? 'No runs yet. Workflow, background and agent runs land here.'
      : `No runs among the ${input.pageSize} most recent conversations — search to look further back.`;
  }
  if (input.filter === 'chats') {
    return sawEverything
      ? 'No conversations yet.'
      : `No chats among the ${input.pageSize} most recent conversations — search to look further back.`;
  }
  return 'Nothing here yet.';
}

/**
 * What the kebab's delete actually does. The console sends no `hard` flag, and
 * without it the server ARCHIVES a harness row (sessions-api.ts
 * deleteUnifiedSession) — so promising a person that it "cannot be undone" is
 * both wrong and, for a run whose ledger is the record of what happened, the
 * scarier of the two errors.
 */
export function deleteConfirmText(session: { store: string; kind: string }): string {
  const noun = isRunKind(session.kind) ? 'run' : 'conversation';
  return session.store === 'harness'
    ? `Remove this ${noun}? It is archived rather than erased — “Show archived” brings it back.`
    : `Delete this ${noun}? This cannot be undone.`;
}

// ─── status, liveness, elapsed ──────────────────────────────────────────────

/**
 * The unified summary carries the harness `SessionRow.status` verbatim
 * ('active' | 'paused' | 'completed' | 'failed' | 'cancelled'), so 'active' is
 * the only value that means work is happening RIGHT NOW. Liveness is read from
 * that one field and nowhere else — a pulse is a claim about this instant and
 * may not be inferred from a recent timestamp.
 */
export function runIsLive(status: string): boolean {
  return status === 'active';
}

/**
 * Whether the run REACHED A TERMINAL — a different question from "is it working
 * right now", and the one that governs sealing, Stop, and whether the page can
 * stop watching.
 *
 * A run parked on an approval is neither: no work is happening, and it is
 * emphatically not finished. Conflating the two is what removed Stop at the
 * exact moment a blocked run most needed it, and what let a page seal a
 * still-pending write as "couldn't confirm". Anything unrecognised is treated
 * as NOT over: keeping a watch on a dead run costs a poll, dropping one on a
 * live run loses the run.
 */
const RUN_OVER_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'superseded',
  'interrupted',
]);

export function runIsOver(status: string): boolean {
  return RUN_OVER_STATUSES.has(status);
}

/**
 * The events that genuinely END a run, as opposed to the ones that merely end
 * a STREAM.
 *
 * `isTerminalEvent` (lib/chat.ts) is a COMPOSER predicate — "re-enable the
 * input" — and it resolves on `approval_requested`, `awaiting_user_input` and
 * `async_work_dispatched`. None of those is the run finishing: the first two
 * are the run asking for something and the third is it handing work onward.
 * An observer that treats them as the end freezes the page at the exact moment
 * the run most needs watching.
 */
const RUN_FINAL_EVENTS: ReadonlySet<string> = new Set(['conversation_completed', 'run_failed']);

export function endsTheRun(eventType: string): boolean {
  return RUN_FINAL_EVENTS.has(eventType);
}

export function runStatusMeta(status: string): { label: string; tone: Tone } {
  switch (status) {
    case 'active': return { label: 'Running', tone: 'live' };
    // Parked, not finished — a warning tone, because it is waiting on someone.
    case 'paused': return { label: 'Paused', tone: 'warning' };
    case 'completed': return { label: 'Completed', tone: 'success' };
    case 'failed': return { label: 'Failed', tone: 'danger' };
    case 'cancelled': return { label: 'Stopped', tone: 'warning' };
    case 'interrupted': return { label: 'Interrupted', tone: 'warning' };
    case 'superseded': return { label: 'Superseded', tone: 'neutral' };
    default: return { label: status.replace(/_/g, ' ') || 'Unknown', tone: 'neutral' };
  }
}

// ─── a run is N sessions ────────────────────────────────────────────────────

/**
 * One step of a collapsed workflow run, as the server hands it over
 * (sessions-api.ts UnifiedRunStep).
 */
export interface RunStep {
  id: string;
  label: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunSessionLike {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  runSteps?: readonly RunStep[] | null;
}

/**
 * The sessions whose events make up this run.
 *
 * A workflow run is one row in the rail and N sessions in the eventlog. Reading
 * only the row's own id gives the ledger of whichever step was the collapse
 * representative and presents it as the run's — the email sent in step 2
 * silently absent from a page titled with the workflow's name. Anything that
 * is not a collapsed run is its own single step.
 */
export function runStepsFor(session: RunSessionLike): RunStep[] {
  const steps = (session.runSteps ?? []).filter((step) => step && typeof step.id === 'string' && step.id);
  if (steps.length > 0) return steps.map((step) => ({ ...step }));
  return [{
    id: session.id,
    label: session.title || 'This run',
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  }];
}

/** What the page has directly observed, which outranks a row fetched seconds
 *  ago. `over` is only true once EVERY step reached a terminal. */
export interface RunLiveness {
  live: boolean;
  over: boolean;
  /** The status the header shows. */
  status: string;
}

export function runLivenessFromSteps(
  steps: readonly RunStep[],
  observed: Readonly<Record<string, string>> = {},
  sessionStatus?: string,
): RunLiveness {
  const statuses = steps.map((step) => observed[step.id] ?? step.status);
  const live = statuses.some(runIsLive);
  const rowStatus = sessionStatus ?? (statuses[statuses.length - 1] ?? '');
  // `over` is a conjunction on purpose. Every step session reaching a terminal
  // is NOT the run reaching one: a workflow between step 3 and step 4 has no
  // active session at all, and sealing there would call a write that is about
  // to be dispatched "couldn't confirm". The run row is the second witness —
  // it sees the workflow's own run log — and both must agree.
  const over = statuses.length > 0
    && statuses.every(runIsOver)
    && (sessionStatus === undefined || runIsOver(sessionStatus));
  // A step we can SEE is active is never reported as finished, whatever the
  // row said when it was fetched. The reverse is deliberately not done: this
  // may not invent a terminal the server has not recorded.
  return { live, over, status: live && !runIsLive(rowStatus) ? 'active' : rowStatus };
}

/** "4 steps · 1 still running" — how many sessions this page just read. Null
 *  for a run that is a single session, where there is nothing to disclose. */
export function runStepsLabel(steps: readonly RunStep[]): string | null {
  if (steps.length < 2) return null;
  const running = steps.filter((step) => runIsLive(step.status)).length;
  return running > 0 ? `${steps.length} steps · ${running} still running` : `${steps.length} steps`;
}

function toMillis(value: number | string | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * How long the run has been going: to now while it is live, frozen at its last
 * event once it settles. Formatting is delegated to the Tasks board's label so
 * a run reads the same duration in the rail, the drawer and here.
 */
export function runElapsedLabel(
  startedAt: number | string | null | undefined,
  lastEventAt: number | string | null | undefined,
  live: boolean,
  now: number,
): string {
  const started = toMillis(startedAt);
  if (started === null) return '';
  const ended = live ? now : (toMillis(lastEventAt) ?? now);
  return serverElapsedLabel(
    new Date(started).toISOString(),
    new Date(Math.max(started, ended)).toISOString(),
  );
}

/** The one line of timing a run row shows in the rail. A live run reports how
 *  long it has been working; a settled one reports when it stopped, because
 *  "4m" next to a finished run reads as "still going". */
export function runRowTiming(
  session: { status: string; createdAt: string; updatedAt: string },
  now: number,
): { text: string; live: boolean } {
  const live = runIsLive(session.status);
  if (live) {
    const elapsed = runElapsedLabel(session.createdAt, null, true, now);
    return { text: elapsed ? `running ${elapsed}` : 'running', live: true };
  }
  const settled = toMillis(session.updatedAt);
  if (settled === null) return { text: '', live: false };
  return { text: `settled ${agoLabel(now - settled)}`, live: false };
}

function agoLabel(ms: number): string {
  const mins = Math.round(Math.max(0, ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days < 7 ? `${days}d ago` : `${Math.round(days / 7)}w ago`;
}

// ─── what changed out there ─────────────────────────────────────────────────

export interface RunWriteRow {
  key: string;
  /** The ledger's own sentence. Present tense while reserved; the past tense
   *  is a claim about the world and only a terminal earns it. */
  what: string;
  /** "reversible" / "can't be undone", or null when the bus did not carry it. */
  reversibility: string | null;
  /** Said out loud only for a reservation, so an intention cannot be read as
   *  a receipt when the row is skimmed. */
  note: string | null;
  state: 'running' | 'done' | 'failed' | 'interrupted';
  tone: Tone;
  /** False for a reservation. The section heading counts only these. */
  settled: boolean;
}

export function presentRunWrite(row: WriteLedgerRow): RunWriteRow {
  const state = writeRowStatus(row);
  return {
    key: row.callId,
    what: writeRowLabel(row),
    reversibility: writeReversibilityLabel(row),
    note: state === 'running' ? 'not confirmed yet' : null,
    state,
    tone: writeRowTone(row),
    settled: state !== 'running',
  };
}

/**
 * The run's write ledger, sealed once the run is over.
 *
 * THE REGRESSION THIS CLOSES. `foldWriteLedger` alone leaves a pre-dispatch
 * reservation in `reserved` forever, so a run that appended `external_write`
 * and died before its terminal renders, an hour later, as an in-flight send:
 * italic present tense, a live tone, "not confirmed yet". A finished run
 * cannot have a send in flight. The engine ships `sealOpenWrites` for exactly
 * this and says why (write-ledger.ts): a reservation still open when the run
 * ends never received an answer — genuinely unknown, not a failure and
 * emphatically not a success.
 *
 * Sealing keys off `over`, not off `live`: a run parked on an approval is not
 * working, but its reservation may still be genuinely in flight, and calling
 * that "couldn't confirm" would be its own small lie.
 */
export function runWriteRows(events: readonly RunEventInput[], run: RunLiveness): RunWriteRow[] {
  const folded = foldWriteLedger(events);
  return [...(run.over ? sealOpenWrites(folded) : folded).values()].map(presentRunWrite);
}

/**
 * The narrated timeline, with unfinished steps settled once the run is over.
 *
 * `RunTimeline` paints a pulse on any `running` row, and a pulse is a claim
 * that work is happening right now. Without this the timeline of a run that
 * died mid-step pulses forever. Same seam the console's own ActivityFeed uses.
 */
export function runActivityItems(events: readonly RunEventInput[], run: RunLiveness): ActivityItem[] {
  let acc: ActivityItem[] = [];
  for (const event of events) acc = reduceActivity(acc, toEngineEvent(event));
  return settleTerminalActivity(narrateActivity(acc, { live: run.live }), runTerminalOutcome(run));
}

/** How the engine should close rows the run never closed itself. Undefined
 *  while the run can still close them. */
export function runTerminalOutcome(run: RunLiveness): ActivityTerminalOutcome | undefined {
  if (!run.over) return undefined;
  if (run.status === 'completed') return 'completed';
  if (run.status === 'failed') return 'failed';
  return 'interrupted';
}

// ─── how much of this run the page actually read ────────────────────────────

/**
 * A ledger is only as honest as its coverage. "3 changes" over a partial read
 * is a count the data does not support, and "nothing was changed" over a
 * failed read is the alarming-direction version of the same lie.
 */
export interface RunReadCoverage {
  /** Sessions this run is made of. */
  steps: number;
  /** Sessions whose events were actually read. */
  read: number;
  /** True when a session's log was longer than the page could fetch. */
  truncated: boolean;
}

export const EMPTY_RUN_COVERAGE: RunReadCoverage = { steps: 0, read: 0, truncated: false };

/** Said out loud above the ledger when the page could not read the whole run.
 *  Null — silence — when it could. */
export function runCoverageNotice(coverage: RunReadCoverage): string | null {
  if (coverage.read > 0 && coverage.read < coverage.steps) {
    return `Showing ${coverage.read} of ${coverage.steps} steps — the rest of this run could not be read, so what it changed may be incomplete.`;
  }
  if (coverage.truncated) {
    return 'This run recorded more events than this page can show, so what is listed below is only part of it.';
  }
  return null;
}

/**
 * Whether the page read the WHOLE run and the run is finished — the only state
 * in which an empty ledger may be read out loud as "it changed nothing". A
 * partial or truncated read cannot support that sentence any more than a
 * failed one can.
 */
export function runLedgerIsComplete(run: RunLiveness, coverage: RunReadCoverage): boolean {
  return run.over
    && coverage.steps > 0
    && coverage.read === coverage.steps
    && !coverage.truncated;
}

/**
 * The sentence for a run with nothing to show.
 *
 * "Nothing was changed, produced or reported" is a claim about the world, and
 * a failed or partial read cannot support it — a daemon restarting mid-fetch
 * must never be rendered as proof that no email went out.
 */
export function runEmptyStateText(input: {
  loading: boolean;
  failed: boolean;
  eventCount: number;
  coverage: RunReadCoverage;
}): string | null {
  if (input.loading || input.eventCount > 0) return null;
  if (input.failed || input.coverage.read < input.coverage.steps) {
    return 'This run’s history could not be read, so what it changed is not known.';
  }
  return 'This run recorded no events. Nothing was changed, produced or reported.';
}

/** "3 changes · 1 still unconfirmed" — the count a person can act on, with the
 *  unsettled ones called out rather than folded into the total. */
export function runWriteSummary(rows: readonly RunWriteRow[]): string {
  if (rows.length === 0) return '';
  const pending = rows.filter((r) => !r.settled).length;
  const noun = rows.length === 1 ? 'change' : 'changes';
  return pending > 0 ? `${rows.length} ${noun} · ${pending} still unconfirmed` : `${rows.length} ${noun}`;
}

// ─── what it produced, and what it reported ─────────────────────────────────

/** The ledger reads three fields off an event; the activity reducer reads a
 *  few more. The console's HarnessEvent satisfies this structurally. */
export interface RunEventInput {
  seq: number;
  type: string;
  data?: Record<string, unknown>;
  id?: string;
  turn?: number;
  role?: string;
  createdAt?: number | string;
  sessionId?: string;
}

/**
 * The console's transport declares `createdAt` as `string | number`; the shared
 * engine's event declares a number. That drift is real and already documented
 * in the engine (write-ledger.ts asks for three fields precisely so it does not
 * import it). The run page normalises at this one boundary rather than widening
 * the engine's type or keeping a second reducer in step with it.
 */
export function toEngineEvent(ev: RunEventInput): EngineHarnessEvent {
  const at = toMillis(ev.createdAt);
  return { ...ev, createdAt: at ?? undefined };
}

export interface RunDeliverable {
  key: string;
  name: string;
  dir: string | null;
  excerpt: string | null;
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Files the run left behind, newest last, deduped by path so a file rewritten
 *  three times is one deliverable rather than three. */
export function foldRunDeliverables(events: readonly RunEventInput[]): RunDeliverable[] {
  const rows = new Map<string, RunDeliverable>();
  for (const ev of events) {
    if (ev.type !== 'deliverable_saved') continue;
    const data = ev.data ?? {};
    const name = stringOf(data.name).trim();
    if (!name) continue;
    const dir = stringOf(data.dir).trim();
    const excerpt = stringOf(data.excerpt).trim();
    const key = dir ? `${dir}/${name}` : name;
    rows.set(key, {
      key,
      name,
      dir: dir || null,
      excerpt: excerpt ? excerpt.slice(0, 400) : null,
    });
  }
  return [...rows.values()];
}

/** The last thing the run actually said. An empty or whitespace reply is no
 *  reply — the section is omitted rather than showing an empty quote. */
export function runFinalReply(events: readonly RunEventInput[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev.type !== 'conversation_completed') continue;
    const reply = stringOf(ev.data?.reply).trim();
    if (reply) return reply;
  }
  return '';
}

// ─── where a run leads ──────────────────────────────────────────────────────

const HARNESS_PREFIX = 'harness:';
const BACKGROUND_PREFIX = 'background:';

/**
 * A background task's run session is created as `background:<taskId>`
 * (execution/background-tasks.ts), so the task id — and through it the origin
 * chat the task was dispatched from — is recoverable from the session id
 * alone. Workflow and agent runs carry no origin on the public plane, so this
 * returns null for them rather than guessing.
 */
export function backgroundTaskIdForRun(unifiedSessionId: string): string | null {
  const raw = unifiedSessionId.startsWith(HARNESS_PREFIX)
    ? unifiedSessionId.slice(HARNESS_PREFIX.length)
    : unifiedSessionId;
  if (!raw.startsWith(BACKGROUND_PREFIX)) return null;
  const taskId = raw.slice(BACKGROUND_PREFIX.length).trim();
  return taskId || null;
}

/** The console address of a harness session id, as the rail spells it. */
export function conversationHref(harnessSessionId: string): string {
  const id = harnessSessionId.startsWith(HARNESS_PREFIX)
    ? harnessSessionId
    : `${HARNESS_PREFIX}${harnessSessionId}`;
  return `/chat/${encodeURIComponent(id)}`;
}

/** The board fields a Stop decision is allowed to read. */
export interface StoppableCardLike {
  id: string;
  sourceKind: string;
  sessionId: string | null;
  actions: string[];
}

/**
 * The Stop authority for a run page — resolved by exact identity, or not at
 * all. Offering a Stop that cancels a neighbouring attempt is worse than
 * offering none, so this refuses every convenience match the Tasks board
 * already refuses (running-tasks.ts: a `run` card may not be resolved by
 * session, because one chat session serves many attempts).
 *
 * A background run is matched on its task id, which its session id carries by
 * construction. Everything else must own the session outright.
 */
export function stoppableRunCard<T extends StoppableCardLike>(
  unifiedSessionId: string,
  cards: readonly T[],
): T | undefined {
  const cancellable = cards.filter((card) => card.actions.includes('cancel'));
  const taskId = backgroundTaskIdForRun(unifiedSessionId);
  if (taskId) {
    return cancellable.find((card) => card.sourceKind === 'background' && card.id === taskId);
  }
  const rawSessionId = unifiedSessionId.startsWith(HARNESS_PREFIX)
    ? unifiedSessionId.slice(HARNESS_PREFIX.length)
    : unifiedSessionId;
  return cancellable.find((card) => card.sourceKind !== 'run' && card.sessionId === rawSessionId);
}
