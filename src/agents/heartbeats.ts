/**
 * Every heartbeat Clementine runs, in one list, with the owner's contract for
 * each beside its runtime status.
 *
 * The watches (calendar, workflow suggestions) and the work review each own
 * their read, their state and their cadence. This module is the registry the
 * console and the chat tool talk to: list them, change what the owner can
 * change (on/off, cadence, how items reach them, the rules in their words),
 * and run one now. Nothing here reads a provider.
 */
import {
  addHeartbeatRule,
  loadHeartbeatContract,
  removeHeartbeatRule,
  setHeartbeatNotify,
  type AddHeartbeatRuleResult,
  type HeartbeatContract,
  type HeartbeatNotifyMode,
} from './heartbeat-contracts.js';
import { phonePushReadiness, type PhonePushReadiness } from './phone-push-readiness.js';

export const HEARTBEAT_IDS = ['work-review', 'calendar', 'workflow-suggestions', 'noticing'] as const;
export type HeartbeatId = (typeof HEARTBEAT_IDS)[number];

export function isHeartbeatId(value: string): value is HeartbeatId {
  return (HEARTBEAT_IDS as readonly string[]).includes(value);
}

/** One item a heartbeat raised, in the shape every heartbeat can fill. */
export interface HeartbeatItem {
  key: string;
  kind: string;
  subject: string;
  detail?: string;
  createdAt: string;
  acknowledgedAt?: string;
  retiredAt?: string;
  retiredReason?: string;
  /** An accepted proposal's handoff progress, not execution authority. */
  handoff?: { state: 'not_started' | 'dispatched' | 'needs_attention' | 'settled'; sessionId?: string; reason?: string };
}

/** Presentation of retained observations, never execution or approval authority.
 * A recorded tick may have found no source or had nothing worth surfacing;
 * neither `quiet` nor `enabled` establishes a successful underlying read. */
export interface HeartbeatPresentation {
  state: 'off' | 'quiet_hours' | 'checking' | 'scheduled' | 'due' | 'never' | 'failed' | 'partial' | 'unknown';
  nextCheckAt?: string;
  lastCheck: {
    state: 'never' | 'recorded' | 'partial' | 'failed' | 'unknown';
    at?: string;
    readFailures?: number;
    successfulReads?: number;
  };
}

export function projectHeartbeatPresentation(input: {
  enabled: boolean;
  quietHoursActive: boolean;
  running: boolean;
  cadenceMinutes: number;
  lastTickAt?: string;
  nextTickAt?: string;
  lastFinding?: { at: string };
  lastError?: { at: string };
  readFailures?: number;
  successfulReads?: number;
}, nowMs = Date.now()): HeartbeatPresentation {
  const timestamp = (value: string | undefined): number | undefined => {
    const ms = value === undefined ? NaN : Date.parse(value);
    return Number.isFinite(ms) && ms <= nowMs ? ms : undefined;
  };
  const findingAt = timestamp(input.lastFinding?.at);
  const tickAt = timestamp(input.lastTickAt);
  const errorAt = timestamp(input.lastError?.at);
  const count = (value: number | undefined): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const readFailures = count(input.readFailures);
  const successfulReads = count(input.successfulReads);
  const malformed = input.lastFinding !== undefined && findingAt === undefined
    || input.lastError !== undefined && errorAt === undefined
    || input.readFailures !== undefined && readFailures === undefined
    || input.successfulReads !== undefined && successfulReads === undefined;
  let lastCheck: HeartbeatPresentation['lastCheck'];
  if (malformed) {
    lastCheck = { state: 'unknown', ...(findingAt !== undefined ? { at: input.lastFinding!.at } : {}) };
  } else if (errorAt !== undefined && (findingAt === undefined || errorAt >= findingAt)) {
    lastCheck = { state: successfulReads && findingAt === errorAt ? 'partial' : 'failed', at: input.lastError!.at };
  } else if (tickAt !== undefined && (findingAt === undefined || tickAt > findingAt) && !input.running) {
    lastCheck = { state: 'unknown', at: input.lastTickAt };
  } else if (findingAt !== undefined) {
    lastCheck = { state: readFailures && successfulReads === 0 ? 'failed'
      : readFailures && successfulReads !== undefined ? 'partial'
      : readFailures ? 'unknown' : 'recorded', at: input.lastFinding!.at };
  } else if (input.lastTickAt !== undefined || input.lastFinding || input.lastError) {
    lastCheck = { state: 'unknown', ...(tickAt !== undefined ? { at: input.lastTickAt } : {}) };
  } else {
    lastCheck = { state: 'never' };
  }
  // Read coverage belongs to that finding, not a later failed attempt.
  if (lastCheck.at === input.lastFinding?.at) {
    if (readFailures !== undefined) lastCheck.readFailures = readFailures;
    if (successfulReads !== undefined) lastCheck.successfulReads = successfulReads;
  }
  const next = input.nextTickAt === undefined ? NaN : Date.parse(input.nextTickAt);
  const cadenceMs = Number.isFinite(input.cadenceMinutes) && input.cadenceMinutes > 0
    ? input.cadenceMinutes * 60_000 : NaN;
  const nextMs = Number.isFinite(next) ? next : tickAt === undefined ? NaN : tickAt + cadenceMs;
  const scheduled = input.enabled && !input.quietHoursActive && !input.running && Number.isFinite(nextMs) && nextMs > nowMs;
  const state: HeartbeatPresentation['state'] = input.running ? 'checking'
    : !input.enabled ? 'off'
    : input.quietHoursActive ? 'quiet_hours'
    : lastCheck.state === 'failed' || lastCheck.state === 'partial' ? lastCheck.state
    : lastCheck.state === 'never' ? 'never'
    : lastCheck.state === 'unknown' ? 'unknown'
    : scheduled ? 'scheduled'
    : Number.isFinite(nextMs) && nextMs <= nowMs ? 'due' : 'unknown';
  return { state, ...(scheduled ? { nextCheckAt: new Date(nextMs).toISOString() } : {}), lastCheck };
}

export interface HeartbeatStatus {
  id: HeartbeatId;
  title: string;
  purpose: string;
  enabled: boolean;
  cadenceMinutes: number;
  /** The cadence the owner may choose, in minutes. */
  cadenceRange: { min: number; max: number };
  quietHoursActive: boolean;
  running: boolean;
  lastTickAt?: string;
  nextTickAt?: string;
  lastFinding?: { at: string; summary: string; quiet: boolean; durationMs: number };
  lastError?: { at: string; reason: string };
  metrics: { ticks: number; quietTicks: number; itemsProduced: number; itemsAcknowledged: number; itemsRetired: number; modelCalls: number; modelVetoes: number };
  openItems: HeartbeatItem[];
  recentlyRetired: HeartbeatItem[];
  /** Whether this heartbeat's rules are applied to its items (the watches ship their own rules for now). */
  rulesApply: boolean;
  contract: HeartbeatContract;
  /** Whether "reach my phone" could reach one right now, and if not, why. */
  phonePush: PhonePushReadiness;
  presentation: HeartbeatPresentation;
}

export interface HeartbeatUnavailable {
  id: HeartbeatId;
  title: string;
  reason: 'status_unavailable';
}

export interface HeartbeatSnapshot {
  heartbeats: HeartbeatStatus[];
  unavailable: HeartbeatUnavailable[];
  generatedAt: string;
}

const HEARTBEAT_TITLES: Record<HeartbeatId, string> = {
  'work-review': 'Work review', calendar: 'Calendar watch', 'workflow-suggestions': 'Workflow suggestions', noticing: 'Noticing',
};

const CADENCE_RANGE: Record<HeartbeatId, { min: number; max: number }> = {
  'work-review': { min: 15, max: 1440 },
  calendar: { min: 5, max: 240 },
  'workflow-suggestions': { min: 30, max: 1440 },
  noticing: { min: 30, max: 1440 },
};

async function currentPhonePush(): Promise<PhonePushReadiness> {
  const [{ listNotificationDestinations }, { isApnsConfigured }] = await Promise.all([
    import('../runtime/notifications.js'),
    import('../runtime/apns.js'),
  ]);
  return phonePushReadiness(listNotificationDestinations(), isApnsConfigured());
}

async function statusFor(id: HeartbeatId): Promise<HeartbeatStatus> {
  const contract = loadHeartbeatContract(id);
  const phonePush = await currentPhonePush();
  if (id === 'work-review') {
    const { workReviewStatus } = await import('./work-review-runtime.js');
    const s = workReviewStatus();
    return {
      id, title: s.title, purpose: s.purpose, enabled: s.enabled, cadenceMinutes: s.cadenceMinutes, cadenceRange: CADENCE_RANGE[id],
      quietHoursActive: s.quietHoursActive, running: s.running,
      ...(s.lastTickAt ? { lastTickAt: s.lastTickAt } : {}), ...(s.nextTickAt ? { nextTickAt: s.nextTickAt } : {}),
      ...(s.lastFinding ? { lastFinding: { at: s.lastFinding.at, summary: s.lastFinding.summary, quiet: s.lastFinding.quiet, durationMs: s.lastFinding.durationMs } } : {}),
      ...(s.lastError ? { lastError: s.lastError } : {}),
      metrics: pickMetrics(s.metrics),
      openItems: s.openItems.map((i) => ({ key: i.key, kind: i.kind, subject: i.subject, detail: i.detail, createdAt: i.createdAt, acknowledgedAt: i.acknowledgedAt })),
      recentlyRetired: s.recentlyRetired.map((i) => ({ key: i.key, kind: i.kind, subject: i.subject, detail: i.detail, createdAt: i.createdAt, retiredAt: i.retiredAt, retiredReason: i.retiredReason })),
      rulesApply: true,
      contract,
      phonePush,
      presentation: projectHeartbeatPresentation({ ...s, readFailures: s.lastFinding?.readFailures }),
    };
  }
  if (id === 'noticing') {
    const { noticingStatus } = await import('./noticing-runtime.js');
    const s = noticingStatus();
    const item = (p: typeof s.openItems[number], retired: boolean): HeartbeatItem => ({
      key: p.id, kind: p.goalId ? 'proposal_for_goal' : 'proposal', subject: p.title, detail: p.why, createdAt: p.createdAt,
      ...(p.answer ? { acknowledgedAt: p.answer.at } : {}),
      ...(retired ? { retiredAt: p.answer?.at ?? p.createdAt, retiredReason: p.answer ? `${p.answer.decision}: ${p.answer.text}` : p.retiredReason ?? p.status } : {}),
      ...(p.handoff ? { handoff: { state: p.handoff.state,
        ...(p.handoff.sessionId ? { sessionId: p.handoff.sessionId } : {}),
        ...(p.handoff.reason ? { reason: p.handoff.reason } : {}) } } : {}),
    });
    return {
      id, title: s.title, purpose: s.purpose, enabled: s.enabled, cadenceMinutes: s.cadenceMinutes, cadenceRange: CADENCE_RANGE[id],
      quietHoursActive: s.quietHoursActive, running: s.running,
      ...(s.lastTickAt ? { lastTickAt: s.lastTickAt } : {}), ...(s.nextTickAt ? { nextTickAt: s.nextTickAt } : {}),
      ...(s.lastFinding ? { lastFinding: s.lastFinding } : {}),
      ...(s.lastError ? { lastError: s.lastError } : {}),
      metrics: pickMetrics(s.metrics),
      openItems: s.openItems.map(p => item(p, false)),
      recentlyRetired: s.recentlyRetired.map(p => item(p, true)),
      rulesApply: true,
      contract,
      phonePush,
      presentation: projectHeartbeatPresentation(s),
    };
  }
  if (id === 'calendar') {
    const { calendarWatchStatus } = await import('./calendar-watch-runtime.js');
    const s = calendarWatchStatus();
    return {
      id, title: s.title, purpose: s.purpose, enabled: s.enabled, cadenceMinutes: s.cadenceMinutes, cadenceRange: CADENCE_RANGE[id],
      quietHoursActive: s.quietHoursActive, running: s.running,
      ...(s.lastTickAt ? { lastTickAt: s.lastTickAt } : {}), ...(s.nextTickAt ? { nextTickAt: s.nextTickAt } : {}),
      ...(s.lastFinding ? { lastFinding: { at: s.lastFinding.at, summary: s.lastFinding.summary, quiet: s.lastFinding.quiet, durationMs: s.lastFinding.durationMs } } : {}),
      ...(s.lastError ? { lastError: s.lastError } : {}),
      metrics: pickMetrics(s.metrics),
      openItems: s.openItems.map((i) => ({ key: i.key, kind: i.kind, subject: i.subject, createdAt: i.createdAt, acknowledgedAt: i.acknowledgedAt })),
      recentlyRetired: s.recentlyRetired.map((i) => ({ key: i.key, kind: i.kind, subject: i.subject, createdAt: i.createdAt, retiredAt: i.retiredAt, retiredReason: i.retiredReason })),
      rulesApply: false,
      contract,
      phonePush,
      presentation: projectHeartbeatPresentation({ ...s, readFailures: s.lastFinding?.readFailures, successfulReads: s.lastFinding?.accounts }),
    };
  }
  const { workflowSuggestionsStatus } = await import('./workflow-suggestions.js');
  const s = workflowSuggestionsStatus();
  const finding = s.lastFinding as { at?: string; summary?: string; quiet?: boolean; durationMs?: number } | undefined;
  const metrics = (s.metrics ?? {}) as Record<string, number>;
  const items = (list: unknown): HeartbeatItem[] => (Array.isArray(list) ? list : []).map((raw) => {
    const i = raw as Record<string, unknown>;
    return {
      key: String(i.key ?? i.id ?? ''),
      kind: String(i.kind ?? 'suggestion'),
      subject: String(i.subject ?? i.label ?? i.title ?? ''),
      createdAt: String(i.createdAt ?? ''),
      ...(typeof i.acknowledgedAt === 'string' ? { acknowledgedAt: i.acknowledgedAt } : {}),
      ...(typeof i.retiredAt === 'string' ? { retiredAt: i.retiredAt } : {}),
      ...(typeof i.retiredReason === 'string' ? { retiredReason: i.retiredReason } : {}),
    };
  });
  return {
    id,
    title: String(s.title ?? 'Workflow suggestions'),
    purpose: String(s.purpose ?? ''),
    enabled: s.enabled === true,
    cadenceMinutes: Number(s.cadenceMinutes ?? 0),
    cadenceRange: CADENCE_RANGE[id],
    quietHoursActive: s.quietHoursActive === true,
    running: s.running === true,
    ...(typeof s.lastTickAt === 'string' ? { lastTickAt: s.lastTickAt } : {}),
    ...(typeof s.nextTickAt === 'string' ? { nextTickAt: s.nextTickAt } : {}),
    ...(finding && finding.at && finding.summary ? { lastFinding: { at: finding.at, summary: finding.summary, quiet: finding.quiet === true, durationMs: Number(finding.durationMs ?? 0) } } : {}),
    ...(s.lastError && typeof s.lastError === 'object' ? { lastError: s.lastError as { at: string; reason: string } } : {}),
    metrics: pickMetrics(metrics),
    openItems: items(s.openItems),
    recentlyRetired: items(s.recentlyRetired),
    rulesApply: false,
    contract,
    phonePush,
    presentation: projectHeartbeatPresentation({ ...s, readFailures: s.lastFinding?.readFailures }),
  };
}

function pickMetrics(source: object): HeartbeatStatus['metrics'] {
  const m = source as Record<string, unknown>;
  const n = (k: string): number => (typeof m[k] === 'number' && Number.isFinite(m[k] as number) ? (m[k] as number) : 0);
  return {
    ticks: n('ticks'), quietTicks: n('quietTicks'), itemsProduced: n('itemsProduced'), itemsAcknowledged: n('itemsAcknowledged'),
    itemsRetired: n('itemsRetired'), modelCalls: n('modelCalls'), modelVetoes: n('modelVetoes'),
  };
}

export async function readHeartbeatSnapshot(
  readStatus: (id: HeartbeatId) => Promise<HeartbeatStatus> = statusFor,
  now = new Date(),
): Promise<HeartbeatSnapshot> {
  const snapshot: HeartbeatSnapshot = { heartbeats: [], unavailable: [], generatedAt: now.toISOString() };
  for (const id of HEARTBEAT_IDS) {
    try {
      const status = await readStatus(id);
      if (status.id !== id) throw new Error('heartbeat identity changed');
      snapshot.heartbeats.push(status);
    }
    catch { snapshot.unavailable.push({ id, title: HEARTBEAT_TITLES[id], reason: 'status_unavailable' }); }
  }
  return snapshot;
}

export async function listHeartbeats(): Promise<HeartbeatStatus[]> {
  return (await readHeartbeatSnapshot()).heartbeats;
}

export async function heartbeatStatus(id: HeartbeatId): Promise<HeartbeatStatus> {
  return statusFor(id);
}

export interface HeartbeatPatch {
  enabled?: boolean;
  cadenceMinutes?: number;
  notify?: HeartbeatNotifyMode;
}

export async function patchHeartbeat(id: HeartbeatId, patch: HeartbeatPatch): Promise<HeartbeatStatus> {
  const range = CADENCE_RANGE[id];
  const cadence = patch.cadenceMinutes !== undefined
    ? Math.min(range.max, Math.max(range.min, Math.round(patch.cadenceMinutes)))
    : undefined;
  const policyPatch = { ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}), ...(cadence !== undefined ? { cadenceMinutes: cadence } : {}) };
  if (Object.keys(policyPatch).length > 0) {
    if (id === 'work-review') {
      const { setWorkReviewPolicy } = await import('./work-review-runtime.js');
      setWorkReviewPolicy(policyPatch);
    } else if (id === 'calendar') {
      const { setCalendarWatchPolicy } = await import('./calendar-watch-runtime.js');
      setCalendarWatchPolicy(policyPatch);
    } else if (id === 'noticing') {
      const { setNoticingPolicy } = await import('./noticing-runtime.js');
      setNoticingPolicy(policyPatch);
    } else {
      const { setWorkflowSuggestionsPolicy } = await import('./workflow-suggestions.js');
      setWorkflowSuggestionsPolicy(policyPatch);
    }
  }
  if (patch.notify) setHeartbeatNotify(id, patch.notify);
  return statusFor(id);
}

export async function tickHeartbeat(id: HeartbeatId, source: 'heartbeat' | 'manual' | 'boot' = 'manual'): Promise<{ summary: string; produced: number; quiet: boolean; status: HeartbeatStatus }> {
  let summary = '';
  let produced = 0;
  let quiet = true;
  if (id === 'work-review') {
    const { runWorkReviewTickNow } = await import('./work-review-runtime.js');
    const tick = await runWorkReviewTickNow({ source });
    summary = tick.summary; produced = tick.produced; quiet = tick.quiet;
  } else if (id === 'calendar') {
    const { runCalendarWatchTick } = await import('./calendar-watch-runtime.js');
    const tick = await runCalendarWatchTick({ source, force: true });
    summary = tick.summary; produced = tick.produced; quiet = tick.quiet;
  } else if (id === 'noticing') {
    const { runNoticingTickNow } = await import('./noticing-runtime.js');
    const tick = await runNoticingTickNow({ source });
    summary = tick.summary; produced = tick.produced; quiet = tick.quiet;
  } else {
    const { runWorkflowSuggestionsTick } = await import('./workflow-suggestions.js');
    const tick = await runWorkflowSuggestionsTick({ source, force: true });
    summary = tick.summary; produced = tick.proposed; quiet = tick.quiet;
  }
  return { summary, produced, quiet, status: await statusFor(id) };
}

export function addRule(id: HeartbeatId, text: string, by: 'owner' | 'clementine'): AddHeartbeatRuleResult {
  return addHeartbeatRule(id, text, by);
}

export function removeRule(id: HeartbeatId, ruleId: string): HeartbeatContract | null {
  return removeHeartbeatRule(id, ruleId);
}
