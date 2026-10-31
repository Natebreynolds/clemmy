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
 * that finished cleanly told the owner so when it finished. A wait is never
 * raised here: the run or conversation waiting on the owner already has its
 * own card in Needs you, and a second card about that card ("still waiting
 * on you") is noise (owner 2026-10-18). Earlier wait items retire on the
 * next tick, which marks their notices read.
 */
import { STALLED_WORK_REAP_MS } from '../dashboard/working-now-policy.js';
import { readableWorkflowName } from '../execution/workflow-diagnosis.js';
import type { NotificationRecord } from '../runtime/notifications.js';
import { isProviderCapacityExhausted, isProviderCreditRefusal } from '../shared/provider-capacity.js';

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
  /** The workflows the owner has now, by name and folder. A run of one
   *  deleted since is history: there is nothing left to fix or run again.
   *  Absent when the list could not be read, and then every run counts. */
  workflowsNow?: ReadonlySet<string>;
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
  ref: { type: 'workflow_run' | 'chat_run' | 'draft' | 'account_cause'; id: string };
  refs: string[];
  count: number;
  /** For failures that share one cause in an account they use: the
   *  workflows it has stopped right now (their latest real run failed on it). */
  workflows?: string[];
  /** A cause still stopping workflows with no new failure since the last look:
   *  it keeps an open item current and raises none. */
  keepsOnly?: boolean;
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
/** A run record stores a failure as `error` (live 2026-09-26, 8 of 329 records); the API vocabulary says `failed`. */
const FAILED_RUN_STATUSES = new Set(['failed', 'error']);
/** A creation test is the daemon proving a workflow, never the owner's work. */
const IGNORED_RUN_STATUSES = new Set(['creation_test', 'completed', 'cancelled']);

function ms(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * When something happened, in words that stay true after they are stored: a
 * clock time today, a weekday within the week, a date before that. An age
 * ("2 h ago", "just now") is wrong the moment the text is read later.
 */
export function formatWhen(thenMs: number, nowMs: number, mode: 'at' | 'since'): string {
  const then = new Date(thenMs);
  const now = new Date(nowMs);
  const time = then.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (then.toDateString() === now.toDateString()) return `${mode} ${time}`;
  if (nowMs - thenMs < 6 * 86_400_000 && thenMs <= nowMs) {
    const day = then.toLocaleDateString('en-US', { weekday: 'long' });
    return mode === 'at' ? `on ${day} at ${time}` : `since ${day}`;
  }
  const date = then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return mode === 'at' ? `on ${date}` : `since ${date}`;
}

/** Where an account refusal came from, when the provider's words link to
 *  it: the place the owner goes to fix the account. */
function refusingHost(error: string | undefined): string | null {
  const host = error?.match(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i)?.[1]?.toLowerCase();
  return host ? host.replace(/^(?:api|www)\./, '') : null;
}

function short(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export type AccountFailureCause = 'out_of_credit' | 'usage_used_up';

const ACCOUNT_FAILURE_WORDS: Record<AccountFailureCause, { subject: string; why: string; offer: string }> = {
  out_of_credit: {
    subject: 'An account is out of credit',
    why: 'an account they use is out of credit',
    offer: 'Add credit on that account and run them again; if it is the model they run on, a backup model in Settings lets them switch on their own.',
  },
  usage_used_up: {
    subject: 'An account used up its usage',
    why: 'an account they use has used up its usage',
    offer: 'Wait for the limit to reset or add usage, then run them again; if it is the model they run on, a backup model in Settings lets them switch on their own.',
  },
};

/** A run's failure whose cause sits outside the workflow, in an account it
 *  uses, read from the provider's own refusal words. A bare status number or a
 *  sign-in error is not enough: a run's error text carries tool output too,
 *  and a tool's sign-in is not the account every workflow shares. */
export function accountFailureCause(error: string | undefined): AccountFailureCause | null {
  if (!error) return null;
  if (isProviderCreditRefusal(undefined, error)) return 'out_of_credit';
  if (isProviderCapacityExhausted(error)) return 'usage_used_up';
  return null;
}

export function accountCauseKey(cause: AccountFailureCause): string {
  return `run_failed:cause:${cause}`;
}

function isAccountCauseKey(key: string): boolean {
  return key.startsWith('run_failed:cause:');
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
  const gone = (run: WorkRunObservation) => observation.workflowsNow !== undefined && !observation.workflowsNow.has(run.workflow);

  for (const run of observation.runs) {
    if (run.targetStepId) continue; // a one-step try is the owner testing, not work
    if (gone(run)) continue;
    if (IGNORED_RUN_STATUSES.has(run.status)) continue;
    const finished = ms(run.finishedAt) ?? ms(run.createdAt);
    if (FAILED_RUN_STATUSES.has(run.status)) {
      if (finished === null || finished < failureSince) continue;
      if (accountFailureCause(run.error)) continue; // one item per cause, below
      out.push({
        key: `run_failed:${run.runId}`,
        kind: 'run_failed',
        subject: run.workflow,
        detail: `${readableWorkflowName(run.workflow)} failed ${formatWhen(finished, nowMs, 'at')}${run.error ? `: ${short(run.error, 160)}` : '.'}`,
        ref: { type: 'workflow_run', id: run.runId },
        refs: [run.runId],
        count: 1,
        offer: 'I can look at what went wrong, or run it again.',
        observedAt,
      });
    }
  }

  // Workflows stopped on one cause in an account they use (out of credit,
  // usage used up) are one thing for the owner to fix: one item per cause,
  // naming every workflow whose latest real run failed on it.
  const latestByWorkflow = new Map<string, { run: WorkRunObservation; finished: number }>();
  for (const run of observation.runs) {
    if (run.targetStepId || gone(run) || (run.status !== 'completed' && !FAILED_RUN_STATUSES.has(run.status))) continue;
    const finished = ms(run.finishedAt) ?? ms(run.createdAt);
    if (finished === null) continue;
    const seen = latestByWorkflow.get(run.workflow);
    if (!seen || finished > seen.finished) latestByWorkflow.set(run.workflow, { run, finished });
  }
  const byCause = new Map<AccountFailureCause, Array<{ run: WorkRunObservation; finished: number }>>();
  for (const latest of latestByWorkflow.values()) {
    if (!FAILED_RUN_STATUSES.has(latest.run.status) || latest.finished < tooOld) continue;
    const cause = accountFailureCause(latest.run.error);
    if (cause) byCause.set(cause, [...(byCause.get(cause) ?? []), latest]);
  }
  for (const [cause, group] of byCause) {
    group.sort((a, b) => b.finished - a.finished);
    const words = ACCOUNT_FAILURE_WORDS[cause];
    const workflows = group.map(({ run }) => run.workflow);
    const names = workflows.map((workflow) => readableWorkflowName(workflow));
    const latest = group[0]!;
    // The card says why in plain words and where the refusal came from; the
    // run's own error text is a diagnostic, not something to read the owner.
    const host = refusingHost(latest.run.error);
    out.push({
      key: accountCauseKey(cause),
      kind: 'run_failed',
      subject: words.subject,
      detail: `${names.length === 1 ? `${names[0]} stopped` : `${names.length} workflows stopped`} because ${words.why}`
        + `${names.length === 1 ? '' : `: ${names.join(', ')}`}. Latest ${formatWhen(latest.finished, nowMs, 'at')}${host ? `, refused by ${host}` : ''}.`,
      ref: { type: 'account_cause', id: cause },
      refs: group.map(({ run }) => run.runId).slice(0, 20),
      count: group.length,
      offer: words.offer,
      observedAt,
      workflows,
      ...(group.some(({ finished }) => finished >= failureSince) ? {} : { keepsOnly: true }),
    });
  }

  for (const draft of observation.drafts) {
    const at = ms(draft.modifiedAt);
    if (at === null || nowMs - at < config.staleDraftMs || at < tooOld) continue;
    out.push({
      key: `draft_unsent:${draft.dir}/${draft.name}`,
      kind: 'draft_unsent',
      subject: draft.name,
      detail: `${draft.name} has been sitting in ${draft.dir} ${formatWhen(at, nowMs, 'since')}, unsent.`,
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
  return items.filter((item) => !item.retiredAt && !live.has(item.key) && (item.kind !== 'run_failed' || isAccountCauseKey(item.key)));
}

/** Failures a later completed run of the same workflow has superseded.
 *  "Want me to run it again?" is no longer a question once it ran again and
 *  worked; the failure stays on record, the ask leaves. A one-step try is not
 *  a real run and supersedes nothing. */
export function supersededFailures(items: WorkReviewItem[], observation: WorkObservation): WorkReviewItem[] {
  return items.filter((item) => {
    if (item.retiredAt || item.kind !== 'run_failed') return false;
    const raised = ms(item.createdAt);
    if (raised === null) return false;
    // A cause's item leaves when nothing is stopped on it (retirableItems).
    if (isAccountCauseKey(item.key)) return false;
    return observation.runs.some((run) => run.workflow === item.subject && run.status === 'completed' && !run.targetStepId
      && (ms(run.finishedAt) ?? -Infinity) > raised);
  });
}

export function workReviewNotificationId(key: string, at: string): string {
  return `work-review:${key}:${at}`;
}

export function buildWorkReviewNotification(
  candidate: WorkReviewCandidate,
  at: string,
  notify: 'quiet' | 'push',
): NotificationRecord {
  // A workflow's subject is its slug; the owner reads its name (2026-10-18).
  const title = candidate.kind === 'run_failed' && candidate.workflows?.length
    ? `${candidate.workflows.length === 1 ? `${short(readableWorkflowName(candidate.workflows[0]!), 50)} stopped` : `${candidate.workflows.length} workflows stopped`}: ${short(candidate.subject, 60)}`
    : candidate.kind === 'run_failed' ? `Something went wrong: ${short(readableWorkflowName(candidate.subject), 60)}`
    : candidate.kind === 'run_waiting' ? `Still waiting on you: ${short(readableWorkflowName(candidate.subject), 60)}`
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
  const superseded = supersededFailures(open, observation);
  const retired = [...retirableItems(open, candidates), ...superseded];
  const at = new Date(nowMs).toISOString();
  for (const item of retired) {
    item.retiredAt = at;
    item.retiredReason = superseded.includes(item) ? 'superseded' : 'resolved';
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

  // Cards raised one per run for a failure whose cause is now read as one
  // in an account fold into that cause's card.
  const runsById = new Map(observation.runs.map((run) => [run.runId, run]));
  const folding: Array<{ item: WorkReviewItem; causeKey: string }> = [];
  for (const c of candidates) {
    if (!c.workflows) continue;
    for (const item of Object.values(state.items)) {
      if (item.retiredAt || item.kind !== 'run_failed' || item.ref.type !== 'workflow_run') continue;
      const run = runsById.get(item.ref.id);
      if (run && c.workflows.includes(run.workflow) && accountFailureCause(run.error) === c.ref.id) folding.push({ item, causeKey: c.key });
    }
  }
  const takesOver = new Set(folding.map(({ causeKey }) => causeKey));

  // 3. New candidates only; an item raised before is not raised again. A
  //    cause that stops workflows again after its item left is raised again.
  const fresh = candidates.filter((c) => {
    const raises = !c.keepsOnly || takesOver.has(c.key);
    const earlier = state.items[c.key];
    if (!earlier) return raises;
    return isAccountCauseKey(c.key) && Boolean(earlier.retiredAt) && earlier.retiredReason !== 'jev_skip' && raises;
  });
  // An open cause item follows what the cause stops now. A workflow newly
  // stopped on it replaces the card, quietly, so one cause stays one card.
  // One that left (it ran cleanly, or was deleted) corrects a card the owner
  // still has open, and never brings back a card they put away.
  const refreshed: WorkReviewItem[] = [];
  for (const c of candidates) {
    const item = state.items[c.key];
    if (!item || item.retiredAt || !c.workflows) continue;
    const joined = c.workflows.filter((workflow) => !item.workflows?.includes(workflow));
    const left = (item.workflows ?? []).filter((workflow) => !c.workflows!.includes(workflow));
    const now = { subject: c.subject, detail: c.detail, refs: c.refs, count: c.count, workflows: c.workflows, observedAt: c.observedAt };
    if (joined.length === 0 && (left.length === 0 || item.acknowledgedAt)) { Object.assign(item, now); continue; }
    const notification = buildWorkReviewNotification({ ...item, ...now }, at, 'quiet');
    try { deps.publish(notification); } catch { continue; } // the next tick tries again
    if (item.notificationId) { try { deps.markNotificationRead(item.notificationId); } catch { /* the new card stands */ } }
    Object.assign(item, now);
    item.notificationId = notification.id;
    delete item.acknowledgedAt;
    refreshed.push(item);
  }
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
  // The per-run cards leave once their cause holds them (or the owner's rules skip it).
  for (const { item, causeKey } of folding) {
    const cause = state.items[causeKey];
    if (!cause || (cause.retiredAt && cause.retiredReason !== 'jev_skip') || item.retiredAt) continue;
    item.retiredAt = at;
    item.retiredReason = 'superseded';
    state.metrics.itemsRetired += 1;
    if (item.notificationId) { try { deps.markNotificationRead(item.notificationId); } catch { /* the state still says folded */ } }
    retired.push(item);
  }
  produced.push(...reopened);
  retired.push(...quieted);

  // 6. Record the tick.
  const quiet = produced.length === 0 && retired.length === 0 && refreshed.length === 0;
  if (quiet) state.metrics.quietTicks += 1; else state.metrics.changedTicks += 1;
  const observed = { runs: observation.runs.length, chats: observation.chats.length, drafts: observation.drafts.length };
  const resolved = retired.length - quieted.length;
  const raised = produced.length - reopened.length;
  const parts = [
    raised ? `${raised} raised` : '',
    vetoed - quieted.length ? `${vetoed - quieted.length} judged routine` : '',
    quieted.length ? `${quieted.length} now skipped by your rules` : '',
    reopened.length ? `${reopened.length} back after a rule change` : '',
    refreshed.length ? `${refreshed.length} updated with newly stopped workflows` : '',
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
