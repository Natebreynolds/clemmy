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
  /** What the item points at, so it can retire when that resolves. */
  ref: { type: 'workflow_run' | 'chat_run' | 'draft'; id: string };
  /** Where Clementine could help, in one line. Model voice comes later; this is the fact. */
  offer: string;
  observedAt: string;
}

export interface WorkReviewItem extends WorkReviewCandidate {
  createdAt: string;
  tickId: string;
  notificationId?: string;
  acknowledgedAt?: string;
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
  /** How far back a failure counts on the first tick, and after a long gap. */
  failureLookbackMs: number;
  maxJudgeCallsPerTick: number;
  maxItemsPerTick: number;
}

export const DEFAULT_WORK_REVIEW_CONFIG: WorkReviewConfig = {
  staleWaitMs: 2 * 60 * 60 * 1000,
  staleDraftMs: 60 * 60 * 1000,
  failureLookbackMs: 24 * 60 * 60 * 1000,
  maxJudgeCallsPerTick: 6,
  maxItemsPerTick: 6,
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
  notify: 'quiet' | 'push';
  observe: () => Promise<{ observation: WorkObservation; readFailures: number }>;
  /** Null = unavailable or unsure; the caller keeps the item (fail open, quiet). */
  judge?: (candidate: WorkReviewCandidate, rules: string[]) => Promise<WorkReviewJudgeVerdict | null>;
  publish: (n: NotificationRecord) => void;
  isNotificationRead: (id: string) => boolean;
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

const WAITING_RUN_STATUSES = new Set(['parked', 'blocked_capability', 'blocked_mutation', 'awaiting_approval', 'awaiting_input', 'paused']);
const FAILED_RUN_STATUSES = new Set(['failed']);

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

  for (const run of observation.runs) {
    if (run.targetStepId) continue; // a one-step try is the owner testing, not work
    const finished = ms(run.finishedAt) ?? ms(run.createdAt);
    if (FAILED_RUN_STATUSES.has(run.status)) {
      if (finished === null || finished < failureSince) continue;
      out.push({
        key: `run_failed:${run.runId}`,
        kind: 'run_failed',
        subject: run.workflow,
        detail: `${run.workflow} failed ${formatAgo(finished, nowMs)}${run.error ? `: ${short(run.error, 160)}` : '.'}`,
        ref: { type: 'workflow_run', id: run.runId },
        offer: 'I can look at what went wrong, or run it again.',
        observedAt,
      });
      continue;
    }
    if (WAITING_RUN_STATUSES.has(run.status)) {
      const since = ms(run.createdAt);
      if (since === null || nowMs - since < config.staleWaitMs) continue;
      out.push({
        key: `run_waiting:${run.runId}`,
        kind: 'run_waiting',
        subject: run.workflow,
        detail: `${run.workflow} has been waiting on you since ${formatAgo(since, nowMs)}${run.status === 'blocked_capability' ? ' for a connection' : ''}.`,
        ref: { type: 'workflow_run', id: run.runId },
        offer: run.status === 'blocked_capability' ? 'I can walk you through reconnecting it.' : 'I can show you what it is asking, or cancel it.',
        observedAt,
      });
    }
  }

  for (const chat of observation.chats) {
    const since = ms(chat.updatedAt);
    if (since === null || nowMs - since < config.staleWaitMs) continue;
    out.push({
      key: `chat_waiting:${chat.runId}`,
      kind: 'chat_waiting',
      subject: chat.title,
      detail: `"${short(chat.title, 80)}" has been waiting for your ${chat.waitingOn === 'approval' ? 'approval' : 'answer'} since ${formatAgo(since, nowMs)}.`,
      ref: { type: 'chat_run', id: chat.runId },
      offer: 'I can bring it back up, or drop it if it no longer matters.',
      observedAt,
    });
  }

  for (const draft of observation.drafts) {
    const at = ms(draft.modifiedAt);
    if (at === null || nowMs - at < config.staleDraftMs) continue;
    out.push({
      key: `draft_unsent:${draft.dir}/${draft.name}`,
      kind: 'draft_unsent',
      subject: draft.name,
      detail: `${draft.name} has been sitting in ${draft.dir} since ${formatAgo(at, nowMs)}, unsent.`,
      ref: { type: 'draft', id: `${draft.dir}/${draft.name}` },
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
      heartbeat: 'work-review',
      itemKey: candidate.key,
      changeKind: candidate.kind,
      refType: candidate.ref.type,
      refId: candidate.ref.id,
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
      observed: { runs: 0, chats: 0, drafts: 0 }, candidates: 0, produced: 0, vetoed: 0, held: 0, retired: 0, quiet: true, readFailures: 1,
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

  // 4. The owner's rules, applied by Jev, within a budget. What the budget
  //    cannot judge waits for the next tick rather than surfacing unjudged.
  const surfaced: WorkReviewCandidate[] = [];
  let vetoed = 0;
  let held = 0;
  let judgeCalls = 0;
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
        state.items[candidate.key] = { ...candidate, createdAt: at, tickId: deps.tickId, retiredAt: at, retiredReason: 'jev_skip' };
        continue;
      }
    }
    surfaced.push(candidate);
  }
  state.metrics.heldForBudget += held;

  // 5. Surface, failures first, bounded per tick.
  const rank = (c: WorkReviewCandidate): number => (c.kind === 'run_failed' ? 0 : c.kind === 'run_waiting' ? 1 : c.kind === 'chat_waiting' ? 2 : 3);
  surfaced.sort((a, b) => rank(a) - rank(b) || a.subject.localeCompare(b.subject));
  const produced: WorkReviewItem[] = [];
  for (const candidate of surfaced.slice(0, cfg.maxItemsPerTick)) {
    const notification = buildWorkReviewNotification(candidate, at, deps.notify);
    try {
      deps.publish(notification);
    } catch {
      continue; // nothing recorded, so the next tick can try again
    }
    const item: WorkReviewItem = { ...candidate, createdAt: at, tickId: deps.tickId, notificationId: notification.id };
    state.items[candidate.key] = item;
    produced.push(item);
    state.metrics.itemsProduced += 1;
  }
  held += Math.max(0, surfaced.length - cfg.maxItemsPerTick);

  // 6. Record the tick.
  const quiet = produced.length === 0 && retired.length === 0;
  if (quiet) state.metrics.quietTicks += 1; else state.metrics.changedTicks += 1;
  const observed = { runs: observation.runs.length, chats: observation.chats.length, drafts: observation.drafts.length };
  const summary = quiet
    ? `work review: quiet (${observed.runs} runs, ${observed.chats} waiting chats, ${observed.drafts} drafts looked at)`
    : `work review: ${produced.length} raised${vetoed ? `, ${vetoed} judged routine` : ''}${held ? `, ${held} held` : ''}${retired.length ? `, ${retired.length} resolved` : ''}`;
  const finding: WorkReviewFinding = {
    tickId: deps.tickId, at, source: deps.source, durationMs: deps.now() - started,
    observed, candidates: candidates.length, produced: produced.length, vetoed, held, retired: retired.length, quiet, readFailures, summary,
  };
  state.lastTickAt = at;
  state.lastTickId = deps.tickId;
  state.lastFinding = finding;
  delete state.lastError;
  deps.saveState(state);
  return { ...finding, items: produced, retiredItems: retired };
}
