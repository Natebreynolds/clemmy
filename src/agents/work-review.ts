/**
 * The work-review heartbeat, the pure half: what Clementine notices about the
 * work that ran while the owner was away, and which of it is worth a line.
 *
 * Same contract as the calendar watch: a deterministic read of the state the
 * runtime already keeps (run records, conversations waiting on an answer,
 * drafts nobody sent), a diff against what was raised last time, one item per
 * thing, the owner's plain-language rules applied by Jev before anything
 * surfaces, and items that retire themselves when the thing they point at
 * resolves. A quiet tick costs reads and no model call.
 *
 * What it does NOT do: repeat what the runs themselves already said. A run
 * that finished cleanly told the owner so when it finished. A wait is raised
 * only once it has been waiting a while ("still waiting since yesterday"),
 * because the fresh wait already has its own card.
 */
import { STALLED_WORK_REAP_MS } from '../dashboard/working-now-policy.js';
import type { NotificationRecord } from '../runtime/notifications.js';

export interface WorkRunObservation {
  runId: string;
  workflow: string;
  status: string;
  createdAt?: string;
  finishedAt?: string;
  error?: string;
  needsAttention?: boolean;
  source?: string;
  /** A one-step try; never the workflow's real work. */
  targetStepId?: string | null;
}

export interface ChatWaitObservation {
  runId: string;
  sessionId: string;
  title: string;
  status: string;
  updatedAt: string;
  /** The approval or question the conversation is waiting on. */
  waitingOn: 'approval' | 'input';
}

export interface DraftObservation {
  name: string;
  dir: string;
  modifiedAt: string;
  bytes: number;
}

export interface WorkObservation {
  runs: WorkRunObservation[];
  chats: ChatWaitObservation[];
  drafts: DraftObservation[];
}

export type WorkReviewKind = 'run_failed' | 'run_waiting' | 'chat_waiting' | 'draft_unsent';

export interface WorkReviewCandidate {
  key: string;
  kind: WorkReviewKind;
  subject: string;
  /** Plain facts for the owner and for Jev; never a guess. */
  detail: string;
  /** What the item points at, so it can retire when that resolves. Several
   *  runs or conversations about one thing are one item with several refs. */
  ref: { type: 'workflow_run' | 'chat_run' | 'draft'; id: string };
  refs: string[];
  count: number;
  /** Where Clementine could help, in one line. Model voice comes later; this is the fact. */
  offer: string;
  observedAt: string;
}

export interface WorkReviewItem extends WorkReviewCandidate {
  createdAt: string;
  tickId: string;
  notificationId?: string;
  acknowledgedAt?: string;
  /** When Jev last applied the owner's rules to this item. Older than the
   *  rules' last change means the item is judged again next tick. */
  judgedAt?: string;
  retiredAt?: string;
  retiredReason?: 'resolved' | 'jev_skip' | 'superseded';
}

export interface WorkReviewMetrics {
  ticks: number;
  quietTicks: number;
  changedTicks: number;
  reads: number;
  readFailures: number;
  modelCalls: number;
  modelVetoes: number;
  modelFailures: number;
  itemsProduced: number;
  itemsAcknowledged: number;
  itemsRetired: number;
  duplicatesSuppressed: number;
  /** Candidates held back because the per-tick judge budget ran out. */
  heldForBudget: number;
}

export interface WorkReviewFinding {
  tickId: string;
  at: string;
  source: string;
  durationMs: number;
  observed: { runs: number; chats: number; drafts: number };
  candidates: number;
  produced: number;
  vetoed: number;
  held: number;
  retired: number;
  /** Live items judged again because the rules changed since they were judged. */
  reconsidered: number;
  quiet: boolean;
  readFailures: number;
  summary: string;
}

export interface WorkReviewState {
  version: 1;
  lastTickAt?: string;
  lastTickId?: string;
  items: Record<string, WorkReviewItem>;
  metrics: WorkReviewMetrics;
  lastFinding?: WorkReviewFinding;
  lastError?: { at: string; reason: string };
}

export interface WorkReviewConfig {
  /** How long a run or chat has to have been waiting before it is "still waiting". */
  staleWaitMs: number;
  /** How old a draft has to be before it counts as sitting unsent. */
  staleDraftMs: number;
  /** Older than this, a wait or a draft is history, not an ask. */
  maxAgeMs: number;
  /** How far back a failure counts on the first tick, and after a long gap. */
  failureLookbackMs: number;
  maxJudgeCallsPerTick: number;
  maxItemsPerTick: number;
}

export const DEFAULT_WORK_REVIEW_CONFIG: WorkReviewConfig = {
  staleWaitMs: STALLED_WORK_REAP_MS,
  staleDraftMs: 60 * 60 * 1000,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  failureLookbackMs: 24 * 60 * 60 * 1000,
  maxJudgeCallsPerTick: 12,
  maxItemsPerTick: 8,
};

export interface WorkReviewJudgeVerdict {
  surface: boolean;
  confidence: number;
  model: string;
  durationMs: number;
}

export interface WorkReviewDeps {
  now: () => number;
  tickId: string;
  source: string;
  config: WorkReviewConfig;
  /** The owner's rules for this heartbeat, in their words. */
  rules: string[];
  /** When the rules last changed. Items judged before that are judged again. */
  rulesUpdatedAt?: string;
  notify: 'quiet' | 'push';
  observe: () => Promise<{ observation: WorkObservation; readFailures: number }>;
  /** Null = unavailable or unsure; the caller keeps the item (fail open, quiet). */
  judge?: (candidate: WorkReviewCandidate, rules: string[]) => Promise<WorkReviewJudgeVerdict | null>;
  publish: (n: NotificationRecord) => void;
  isNotificationRead: (id: string) => boolean;
  /** A resolved item's card leaves Needs you: the heartbeat marks it read. */
  markNotificationRead: (id: string) => void;
  loadState: () => WorkReviewState;
  saveState: (s: WorkReviewState) => void;
}

export interface WorkReviewTickResult extends WorkReviewFinding {
  items: WorkReviewItem[];
  retiredItems: WorkReviewItem[];
}

export function emptyWorkReviewState(): WorkReviewState {
  return {
    version: 1,
    items: {},
    metrics: {
      ticks: 0, quietTicks: 0, changedTicks: 0, reads: 0, readFailures: 0,
      modelCalls: 0, modelVetoes: 0, modelFailures: 0,
      itemsProduced: 0, itemsAcknowledged: 0, itemsRetired: 0, duplicatesSuppressed: 0, heldForBudget: 0,
    },
  };
}

/** The run statuses the product already reads as "stopped on a person"
 *  (dashboard/needs-you.ts), plus the two pauses. */
const WAITING_RUN_STATUSES = new Set(['blocked', 'blocked_capability', 'blocked_readiness', 'blocked_mutation', 'parked', 'paused', 'awaiting_approval', 'awaiting_input']);
/** A run record stores a failure as `error` (live 2026-09-26, 8 of 329 records); the API vocabulary says `failed`. */
const FAILED_RUN_STATUSES = new Set(['failed', 'error']);
/** A creation test is the daemon proving a workflow, never the owner's work. */
const IGNORED_RUN_STATUSES = new Set(['creation_test', 'completed', 'cancelled']);

function ms(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function formatAgo(thenMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - thenMs);
  const min = Math.round(diff / 60_000);
  if (min < 2) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

function short(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * The candidates this observation supports. Pure: the same observation at the
 * same time always yields the same keys, so the diff against state is exact.
 */
export function deriveWorkReviewCandidates(
  observation: WorkObservation,
  config: WorkReviewConfig,
  nowMs: number,
  lastTickMs: number | null,
): WorkReviewCandidate[] {
  const out: WorkReviewCandidate[] = [];
  const observedAt = new Date(nowMs).toISOString();
  const failureSince = lastTickMs === null ? nowMs - config.failureLookbackMs : Math.max(lastTickMs, nowMs - config.failureLookbackMs);
  const tooOld = nowMs - config.maxAgeMs;

  // Waits group by workflow: three runs of one workflow parked on the same
  // question are one thing the owner has to settle, not three.
  const waitingByWorkflow = new Map<string, { runs: WorkRunObservation[]; oldest: number; connection: boolean }>();
  for (const run of observation.runs) {
    if (run.targetStepId) continue; // a one-step try is the owner testing, not work
    if (IGNORED_RUN_STATUSES.has(run.status)) continue;
    const finished = ms(run.finishedAt) ?? ms(run.createdAt);
    if (FAILED_RUN_STATUSES.has(run.status)) {
      if (finished === null || finished < failureSince) continue;
      out.push({
        key: `run_failed:${run.runId}`,
        kind: 'run_failed',
        subject: run.workflow,
        detail: `${run.workflow} failed ${formatAgo(finished, nowMs)}${run.error ? `: ${short(run.error, 160)}` : '.'}`,
        ref: { type: 'workflow_run', id: run.runId },
        refs: [run.runId],
        count: 1,
        offer: 'I can look at what went wrong, or run it again.',
        observedAt,
      });
      continue;
    }
    if (WAITING_RUN_STATUSES.has(run.status)) {
      const since = ms(run.createdAt);
      if (since === null || nowMs - since < config.staleWaitMs || since < tooOld) continue;
      const group = waitingByWorkflow.get(run.workflow) ?? { runs: [], oldest: since, connection: false };
      group.runs.push(run);
      group.oldest = Math.min(group.oldest, since);
      if (run.status === 'blocked_capability') group.connection = true;
      waitingByWorkflow.set(run.workflow, group);
    }
  }
  for (const [workflow, group] of waitingByWorkflow) {
    const n = group.runs.length;
    out.push({
      key: `run_waiting:${workflow}`,
      kind: 'run_waiting',
      subject: workflow,
      detail: n === 1
        ? `${workflow} has been waiting on you since ${formatAgo(group.oldest, nowMs)}${group.connection ? ' for a connection' : ''}.`
        : `${n} runs of ${workflow} are waiting on you, the oldest since ${formatAgo(group.oldest, nowMs)}${group.connection ? ', one for a connection' : ''}.`,
      ref: { type: 'workflow_run', id: group.runs[0].runId },
      refs: group.runs.map((r) => r.runId),
      count: n,
      offer: group.connection ? 'I can walk you through reconnecting it.' : 'I can show you what it is asking, or cancel the old ones.',
      observedAt,
    });
  }

  // Conversations group by what they are about.
  const chatsByTitle = new Map<string, { chats: ChatWaitObservation[]; oldest: number; approval: boolean }>();
  for (const chat of observation.chats) {
    const since = ms(chat.updatedAt);
    if (since === null || nowMs - since < config.staleWaitMs || since < tooOld) continue;
    const titleKey = chat.title.replace(/\s+/g, ' ').trim().toLowerCase();
    const group = chatsByTitle.get(titleKey) ?? { chats: [], oldest: since, approval: false };
    group.chats.push(chat);
    group.oldest = Math.min(group.oldest, since);
    if (chat.waitingOn === 'approval') group.approval = true;
    chatsByTitle.set(titleKey, group);
  }
  for (const [titleKey, group] of chatsByTitle) {
    const n = group.chats.length;
    const title = short(group.chats[0].title, 80);
    const what = group.approval ? 'approval' : 'answer';
    out.push({
      key: `chat_waiting:${titleKey}`,
      kind: 'chat_waiting',
      subject: group.chats[0].title,
      detail: n === 1
        ? `"${title}" has been waiting for your ${what} since ${formatAgo(group.oldest, nowMs)}.`
        : `${n} conversations about "${title}" are waiting for your ${what}, the oldest since ${formatAgo(group.oldest, nowMs)}.`,
      ref: { type: 'chat_run', id: group.chats[0].runId },
      refs: group.chats.map((c) => c.runId),
      count: n,
      offer: n === 1 ? 'I can bring it back up, or drop it if it no longer matters.' : 'I can bring the newest back up and close the rest.',
      observedAt,
    });
  }

  for (const draft of observation.drafts) {
    const at = ms(draft.modifiedAt);
    if (at === null || nowMs - at < config.staleDraftMs || at < tooOld) continue;
    out.push({
      key: `draft_unsent:${draft.dir}/${draft.name}`,
      kind: 'draft_unsent',
      subject: draft.name,
      detail: `${draft.name} has been sitting in ${draft.dir} since ${formatAgo(at, nowMs)}, unsent.`,
      ref: { type: 'draft', id: `${draft.dir}/${draft.name}` },
      refs: [`${draft.dir}/${draft.name}`],
      count: 1,
      offer: 'I can send it, revise it, or file it away.',
      observedAt,
    });
  }

  return out;
}

/** Open items whose referent no longer needs anything. */
export function retirableItems(items: WorkReviewItem[], candidates: WorkReviewCandidate[]): WorkReviewItem[] {
  const live = new Set(candidates.map((c) => c.key));
  return items.filter((item) => !item.retiredAt && !live.has(item.key) && item.kind !== 'run_failed');
}

export function workReviewNotificationId(key: string, at: string): string {
  return `work-review:${key}:${at}`;
}

export function buildWorkReviewNotification(
  candidate: WorkReviewCandidate,
  at: string,
  notify: 'quiet' | 'push',
): NotificationRecord {
  const title = candidate.kind === 'run_failed' ? `Run failed: ${short(candidate.subject, 60)}`
    : candidate.kind === 'run_waiting' ? `Still waiting on you: ${short(candidate.subject, 60)}`
      : candidate.kind === 'chat_waiting' ? `Still waiting: ${short(candidate.subject, 60)}`
        : `Unsent draft: ${short(candidate.subject, 60)}`;
  return {
    id: workReviewNotificationId(candidate.key, at),
    kind: 'execution',
    title,
    body: `${candidate.detail}\n${candidate.offer}`,
    createdAt: at,
    read: false,
    // needsAttention puts it on the desktop and phone Needs-you feeds. Quiet
    // mode keeps it there and off the push path; push mode lets it travel
    // like anything else waiting on the owner.
    metadata: {
      needsAttention: true,
      ...(notify === 'quiet' ? { inboxOnly: true } : {}),
      source: 'work-review',
      watch: 'work-review',
      heartbeatId: 'work-review',
      itemKey: candidate.key,
      changeKind: candidate.kind,
      refType: candidate.ref.type,
      refId: candidate.ref.id,
      refs: candidate.refs.slice(0, 20),
      count: candidate.count,
    },
  };
}

export async function runWorkReviewTick(deps: WorkReviewDeps): Promise<WorkReviewTickResult> {
  const started = deps.now();
  const state = deps.loadState();
  const cfg = deps.config;
  state.metrics.ticks += 1;
  const lastTickMs = ms(state.lastTickAt);

  // 1. Observe, deterministically.
  let observation: WorkObservation = { runs: [], chats: [], drafts: [] };
  let readFailures = 0;
  try {
    const read = await deps.observe();
    observation = read.observation;
    readFailures = read.readFailures;
    state.metrics.reads += 1;
    state.metrics.readFailures += readFailures;
  } catch (error) {
    state.metrics.readFailures += 1;
    state.lastError = { at: new Date(started).toISOString(), reason: error instanceof Error ? error.message : String(error) };
    deps.saveState(state);
    const finding: WorkReviewFinding = {
      tickId: deps.tickId, at: new Date(started).toISOString(), source: deps.source, durationMs: deps.now() - started,
      observed: { runs: 0, chats: 0, drafts: 0 }, candidates: 0, produced: 0, vetoed: 0, held: 0, retired: 0, reconsidered: 0, quiet: true, readFailures: 1,
      summary: `work review: read failed (${state.lastError.reason})`,
    };
    state.lastFinding = finding;
    deps.saveState(state);
    return { ...finding, items: [], retiredItems: [] };
  }

  // 2. Candidates, and what they say about earlier items.
  const nowMs = deps.now();
  const candidates = deriveWorkReviewCandidates(observation, cfg, nowMs, lastTickMs);
  const open = Object.values(state.items).filter((i) => !i.retiredAt);
  const retired = retirableItems(open, candidates);
  const at = new Date(nowMs).toISOString();
  for (const item of retired) {
    item.retiredAt = at;
    item.retiredReason = 'resolved';
    state.metrics.itemsRetired += 1;
    // The card leaves Needs you with the thing it pointed at.
    if (item.notificationId) { try { deps.markNotificationRead(item.notificationId); } catch { /* the state still says resolved */ } }
  }
  for (const item of open) {
    if (item.notificationId && !item.acknowledgedAt && deps.isNotificationRead(item.notificationId)) {
      item.acknowledgedAt = at;
      state.metrics.itemsAcknowledged += 1;
    }
  }

  // 3. New candidates only; an item raised before is not raised again.
  const fresh = candidates.filter((c) => !state.items[c.key]);
  const duplicates = candidates.length - fresh.length;
  state.metrics.duplicatesSuppressed += duplicates;

  // 3b. The rules changed since an item was judged, and the item is still
  //     live: judge it again. A new rule quiets an open item; a removed rule
  //     brings back one it had skipped. Same budget as new candidates, and
  //     Jev unavailable leaves the item as it is until a later tick.
  let vetoed = 0;
  let held = 0;
  let judgeCalls = 0;
  let reconsidered = 0;
  const quieted: WorkReviewItem[] = [];
  const reopened: WorkReviewItem[] = [];
  const rulesChangedMs = ms(deps.rulesUpdatedAt);
  if (rulesChangedMs !== null) {
    const live = new Set(candidates.map((c) => c.key));
    for (const item of Object.values(state.items)) {
      if (!live.has(item.key)) continue;
      if (item.retiredAt && item.retiredReason !== 'jev_skip') continue;
      if ((ms(item.judgedAt) ?? ms(item.createdAt) ?? 0) >= rulesChangedMs) continue;
      let verdict: WorkReviewJudgeVerdict | null = { surface: true, confidence: 1, model: 'none', durationMs: 0 };
      if (deps.rules.length > 0) {
        if (!deps.judge) continue;
        if (judgeCalls >= cfg.maxJudgeCallsPerTick) { held += 1; continue; }
        judgeCalls += 1;
        state.metrics.modelCalls += 1;
        verdict = null;
        try { verdict = await deps.judge(item, deps.rules); } catch { state.metrics.modelFailures += 1; }
        if (!verdict) continue;
      }
      reconsidered += 1;
      item.judgedAt = at;
      if (!verdict.surface && !item.retiredAt) {
        vetoed += 1;
        state.metrics.modelVetoes += 1;
        item.retiredAt = at;
        item.retiredReason = 'jev_skip';
        state.metrics.itemsRetired += 1;
        if (item.notificationId) { try { deps.markNotificationRead(item.notificationId); } catch { /* the state still says skipped */ } }
        quieted.push(item);
      } else if (verdict.surface && item.retiredAt) {
        const notification = buildWorkReviewNotification(item, at, deps.notify);
        try { deps.publish(notification); } catch { continue; }
        delete item.retiredAt;
        delete item.retiredReason;
        delete item.acknowledgedAt;
        item.notificationId = notification.id;
        state.metrics.itemsProduced += 1;
        reopened.push(item);
      }
    }
  }

  // 4. The owner's rules, applied by Jev, within a budget. What the budget
  //    cannot judge waits for the next tick rather than surfacing unjudged.
  const surfaced: WorkReviewCandidate[] = [];
  const judged = new Set<string>();
  const rank = (c: WorkReviewCandidate): number => (c.kind === 'run_failed' ? 0 : c.kind === 'run_waiting' ? 1 : c.kind === 'chat_waiting' ? 2 : 3);
  fresh.sort((a, b) => rank(a) - rank(b) || a.subject.localeCompare(b.subject));
  for (const candidate of fresh) {
    if (deps.rules.length > 0 && deps.judge) {
      if (judgeCalls >= cfg.maxJudgeCallsPerTick) { held += 1; continue; }
      judgeCalls += 1;
      state.metrics.modelCalls += 1;
      let verdict: WorkReviewJudgeVerdict | null = null;
      try { verdict = await deps.judge(candidate, deps.rules); } catch { state.metrics.modelFailures += 1; }
      if (verdict && !verdict.surface) {
        vetoed += 1;
        state.metrics.modelVetoes += 1;
        state.items[candidate.key] = { ...candidate, createdAt: at, tickId: deps.tickId, judgedAt: at, retiredAt: at, retiredReason: 'jev_skip' };
        continue;
      }
      if (verdict) judged.add(candidate.key);
    }
    surfaced.push(candidate);
  }
  state.metrics.heldForBudget += held;

  // 5. Surface, failures first (already in rank order), bounded per tick.
  const produced: WorkReviewItem[] = [];
  for (const candidate of surfaced.slice(0, cfg.maxItemsPerTick)) {
    const notification = buildWorkReviewNotification(candidate, at, deps.notify);
    try {
      deps.publish(notification);
    } catch {
      continue; // nothing recorded, so the next tick can try again
    }
    const item: WorkReviewItem = { ...candidate, createdAt: at, tickId: deps.tickId, notificationId: notification.id, ...(judged.has(candidate.key) ? { judgedAt: at } : {}) };
    state.items[candidate.key] = item;
    produced.push(item);
    state.metrics.itemsProduced += 1;
  }
  held += Math.max(0, surfaced.length - cfg.maxItemsPerTick);
  produced.push(...reopened);
  retired.push(...quieted);

  // 6. Record the tick.
  const quiet = produced.length === 0 && retired.length === 0;
  if (quiet) state.metrics.quietTicks += 1; else state.metrics.changedTicks += 1;
  const observed = { runs: observation.runs.length, chats: observation.chats.length, drafts: observation.drafts.length };
  const resolved = retired.length - quieted.length;
  const raised = produced.length - reopened.length;
  const parts = [
    raised ? `${raised} raised` : '',
    vetoed - quieted.length ? `${vetoed - quieted.length} judged routine` : '',
    quieted.length ? `${quieted.length} now skipped by your rules` : '',
    reopened.length ? `${reopened.length} back after a rule change` : '',
    held ? `${held} held` : '',
    resolved ? `${resolved} resolved` : '',
  ].filter(Boolean);
  const summary = quiet
    ? `work review: quiet (${observed.runs} runs, ${observed.chats} waiting chats, ${observed.drafts} drafts looked at)`
    : `work review: ${parts.join(', ')}`;
  const finding: WorkReviewFinding = {
    tickId: deps.tickId, at, source: deps.source, durationMs: deps.now() - started,
    observed, candidates: candidates.length, produced: produced.length, vetoed, held, retired: retired.length, reconsidered, quiet, readFailures, summary,
  };
  state.lastTickAt = at;
  state.lastTickId = deps.tickId;
  state.lastFinding = finding;
  delete state.lastError;
  deps.saveState(state);
  return { ...finding, items: produced, retiredItems: retired };
}
