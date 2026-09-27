/**
 * Memory at work, as the phone shows it.
 *
 * Pure view models over the daemon's `MemoryWorkSnapshot` (GET
 * /m/api/memory/work, the builder desktop Memory reads too). Every sentence
 * about the work comes from the shared presenter in @clem/chat-engine, so the
 * phone and the Mac say the same thing; this module only fits those words to
 * a 358 px column, formats time and counts, and decides what may move.
 *
 * Honesty rules kept here (pinned in memory-work.test.ts):
 *  - motion only while the LATEST read says a job is running right now; a
 *    failed or old read never pulses;
 *  - a count the daemon could not read shows "—", never 0;
 *  - a failed read shows before an empty one;
 *  - ages run on the Mac's clock (the snapshot's generatedAt), not the phone's;
 *  - model names come from the connected catalog, never from this source.
 */
import {
  MEMORY_JOB_ORDER,
  MEMORY_JOB_WORDS,
  formatBalance,
  formatTokenCount,
  memoryEventSentence,
  memoryJobModelOwnerText,
  memoryModelProblemText,
  memoryNextText,
  memoryPipeline,
  memoryRoleAutomaticText,
  memoryUndoResultText,
  memoryUndoText,
  memoryWorkHeadline,
  memoryWorkReadIsLive,
  MEMORY_JOB_NO_RUN,
  type MemoryJobId,
  type MemoryJobStatus,
  type MemoryPipelineStage,
  type MemoryTimeFormat,
  type MemoryWorkEvent,
  type MemoryWorkFact,
  type MemoryWorkQueue,
  type MemoryWorkSnapshot,
  type MemoryWorkState,
  type MemoryWorkToday,
  type MemoryWorkUndoResult,
} from '@clem/chat-engine';

/** Matches Activity: often enough that a finished run appears while you look,
 *  rare enough to be nothing over the relay. Only while Memory is on screen. */
export const MEMORY_WORK_POLL_MS = 8_000;

/** A read older than this cannot certify that a job is running now (about
 *  three missed polls): the words stay, the motion stops. The Mac's rule too. */
export { MEMORY_WORK_LIVE_MS } from '@clem/chat-engine';

/** How many runs the card shows before "See all". */
export const MEMORY_WORK_CARD_EVENTS = 3;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Joins a number to its unit so a narrow line never breaks between them. */
const NB = '\u00a0';

/** Names a model id the way the Models card does. */
export type ModelNamer = (modelId: string) => string;

/** The snapshot as the phone renders it. A field the daemon left out is null
 *  here rather than a made-up zero, so the view can say "—". */
export type MemoryWorkView = Omit<MemoryWorkSnapshot, 'today' | 'retention'> & {
  today: MemoryWorkToday | null;
  retention: MemoryWorkSnapshot['retention'] | null;
};

const STATES: readonly MemoryWorkState[] = ['working', 'resting', 'waiting', 'off', 'unknown'];

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function record<T extends object>(value: unknown): T | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : null;
}

/**
 * Accept whatever the daemon answered without letting a missing field crash
 * the Memory screen. Arrays default to empty (nothing to list), objects and
 * counts to null (not read), and an unrecognised state to `unknown`.
 */
export function normalizeMemoryWork(raw: unknown): MemoryWorkView | null {
  const snapshot = record<Partial<MemoryWorkSnapshot>>(raw);
  if (!snapshot) return null;
  const queue = record<MemoryWorkQueue>(snapshot.queue);
  const model = record<MemoryWorkSnapshot['model']>(snapshot.model);
  return {
    ...snapshot,
    generatedAt: typeof snapshot.generatedAt === 'string' ? snapshot.generatedAt : '',
    state: STATES.includes(snapshot.state as MemoryWorkState) ? (snapshot.state as MemoryWorkState) : 'unknown',
    running: list(snapshot.running),
    queue: {
      toLearn: queue?.toLearn ?? null,
      setAside: queue?.setAside ?? null,
      failed: queue?.failed ?? null,
    },
    model: model
      ? { ...model, source: model.source === 'chosen' ? 'chosen' : 'automatic', modelId: model.modelId ?? null }
      : { source: 'automatic', modelId: null },
    jobs: list(snapshot.jobs),
    today: record<MemoryWorkToday>(snapshot.today),
    hourly: list(snapshot.hourly),
    daily: list(snapshot.daily),
    recent: list(snapshot.recent),
    retention: record<MemoryWorkSnapshot['retention']>(snapshot.retention),
  };
}

// ───────────────────────────── time ─────────────────────────────

/** The Mac's clock now: when the snapshot was built, plus the time since it
 *  arrived. Falls back to the phone's clock when either is missing. */
export function serverNow(generatedAt: string | null | undefined, receivedAt: number | null, deviceNow: number): number {
  const generated = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  if (!Number.isFinite(generated) || receivedAt === null) return deviceNow;
  return generated + Math.max(0, deviceNow - receivedAt);
}

function localDayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole calendar days from `earlier` to `later` on this phone's calendar
 *  (rounded, so a daylight-saving day still counts as one). */
export function calendarDaysBetween(earlier: number, later: number): number {
  return Math.round((localDayStart(later) - localDayStart(earlier)) / DAY);
}

function agoFromMs(ms: number): string {
  if (ms < 45_000) return 'just now';
  if (ms < HOUR) return `${Math.max(1, Math.floor(ms / MINUTE))}${NB}min ago`;
  return `${Math.floor(ms / HOUR)}${NB}h ago`;
}

/** "just now", "4 min ago", "3 h ago", "yesterday", "3 days ago", "Sep 23". */
export function ageText(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const ms = now - t;
  if (ms < DAY) return agoFromMs(ms);
  const days = calendarDaysBetween(t, now);
  if (days <= 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "3:00 AM" today, "Tue 3:00 AM" within a week either side, else a date. */
export function clockText(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const days = Math.abs(calendarDaysBetween(t, now));
  if (days === 0) return time;
  if (days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/** "3:04 PM": the time of day alone, for a row already under its day. */
export function timeOfDayText(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
}

export function memoryTimeFormat(now: number): MemoryTimeFormat {
  return { age: (iso) => ageText(iso, now), clock: (iso) => clockText(iso, now) };
}

/** "under 1 s", "8 s", "2 min", "1 h 5 min" (unit spaces do not break). */
export function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1_000) return `under 1${NB}s`;
  if (ms < MINUTE) return `${Math.round(ms / 1_000)}${NB}s`;
  if (ms < HOUR) return `${Math.round(ms / MINUTE)}${NB}min`;
  const minutes = Math.round((ms % HOUR) / MINUTE);
  return minutes ? `${Math.floor(ms / HOUR)}${NB}h ${minutes}${NB}min` : `${Math.floor(ms / HOUR)}${NB}h`;
}

// ───────────────────────────── counts ─────────────────────────────

function known(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A number the daemon read, or "—" for one it could not. Never a made-up 0. */
export function countText(value: number | null | undefined): string {
  return known(value) ? value.toLocaleString() : '—';
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "$0.42"; spend under a cent reads as such instead of rounding to "$0.00". */
export function costText(usd: number): string {
  if (!known(usd) || usd < 0) return '—';
  if (usd > 0 && usd < 0.01) return 'under $0.01';
  return formatBalance({ amount: usd, currency: 'USD' });
}

// ───────────────────────────── status ─────────────────────────────

/** One read of the snapshot, with the transport facts useScreenData knows. */
export interface MemoryWorkRead {
  snapshot: MemoryWorkView | null;
  error: string | null;
  offline: boolean;
  /** The phone's clock when the snapshot arrived (useScreenData.updatedAt). */
  receivedAt: number | null;
  /** The phone's clock now. */
  now: number;
}

/** True only when the latest read succeeded, is recent, and says a job is
 *  running in the daemon right now. This is the only thing that may animate. */
export function memoryWorkLive(read: MemoryWorkRead): boolean {
  if (read.error || read.offline) return false;
  return memoryWorkReadIsLive(read.snapshot, read.receivedAt, read.now);
}

export interface MemoryWorkStatus {
  tone: MemoryWorkState;
  pulse: boolean;
  text: string;
  detail?: string;
  /** A failed refresh while older data stays on screen. */
  stale: string | null;
}

/** The headline, or null while the first read is still loading. */
export function memoryWorkStatus(read: MemoryWorkRead, modelName: ModelNamer): MemoryWorkStatus | null {
  const { snapshot } = read;
  if (!snapshot) {
    if (read.offline) return { tone: 'unknown', pulse: false, text: 'Can’t reach your Mac right now', stale: null };
    if (read.error) return { tone: 'unknown', pulse: false, text: 'Couldn’t read memory work just now', stale: null };
    return null;
  }
  const now = serverNow(snapshot.generatedAt, read.receivedAt, read.now);
  const headline = memoryWorkHeadline(snapshot, memoryTimeFormat(now), modelName);
  const failed = read.offline ? 'Can’t reach your Mac' : read.error ? 'Couldn’t refresh' : null;
  const stale = failed
    ? (read.receivedAt === null ? failed : `${failed} · as of ${agoFromMs(Math.max(0, read.now - read.receivedAt))}`)
    : null;
  return { tone: headline.tone, pulse: memoryWorkLive(read), text: headline.text, detail: headline.detail, stale };
}

// ───────────────────────────── model ─────────────────────────────

export interface MemoryModelView {
  /** "Provider — Model", or a plain statement when there is none. */
  name: string;
  hasModel: boolean;
  chosen: boolean;
  /** "Chosen" or "Automatic · Uses the same model as Checks the work." */
  source: string;
  /** The model that answered last, when it stood in or is not the one named. */
  served: { text: string; standIn: boolean } | null;
  /** Why the model cannot run, unless the headline already says so. */
  problem: string | null;
}

export function memoryModelView(snapshot: MemoryWorkView | null, modelName: ModelNamer, now: number): MemoryModelView | null {
  if (!snapshot) return null;
  const model = snapshot.model;
  const fmt = memoryTimeFormat(now);
  const chosen = model.source === 'chosen';
  // No model id in a read that failed says nothing about the model.
  const none = snapshot.state === 'unknown' ? '—' : 'No model available right now';
  const last = model.lastServed;
  let served: MemoryModelView['served'] = null;
  if (last?.modelId && last.standIn) {
    served = { text: `Last run used a stand-in: ${modelName(last.modelId)}`, standIn: true };
  } else if (last?.modelId && last.modelId !== model.modelId) {
    served = { text: `Last run used ${modelName(last.modelId)}, ${fmt.age(last.at)}`, standIn: false };
  }
  // A model-side wait is already the headline; saying it twice is noise.
  const headlineSaysIt = snapshot.state === 'waiting' && snapshot.waiting != null && snapshot.waiting.reason !== 'busy';
  const unavailable = model.unavailable;
  const problem = unavailable && !headlineSaysIt
    ? `This model ${memoryModelProblemText(unavailable.problem)}${unavailable.until ? ` until about ${fmt.clock(unavailable.until)}` : ''}`
    : null;
  return {
    name: model.modelId ? modelName(model.modelId) : none,
    hasModel: Boolean(model.modelId),
    chosen,
    source: chosen ? 'Chosen' : `Automatic · ${memoryRoleAutomaticText(model.follows ?? null, model.modelId)}`,
    served,
    problem,
  };
}

// ───────────────────────────── today ─────────────────────────────

const STAGE_SHORT: Record<MemoryPipelineStage['id'], string> = {
  read: 'read',
  found: 'noticed',
  kept: 'kept',
  aside: 'left out',
  faded: 'faded',
};

export interface PipelineStageView {
  id: MemoryPipelineStage['id'];
  /** The shared words ("Kept or updated"), for assistive tech. */
  label: string;
  /** The same stage in a word that fits a 358 px row ("kept"). */
  short: string;
  value: string;
  known: boolean;
  /** Its job is running right now (certified by a live read). */
  lit: boolean;
}

/** Today's learning, left to right. An unread day reads "—" at every stage,
 *  and the shared pipeline reads a sum of two unread counts as unread. */
export function pipelineView(snapshot: MemoryWorkView | null, live: boolean): PipelineStageView[] {
  const today = snapshot && snapshot.state !== 'unknown' ? snapshot.today : null;
  const running = new Set<MemoryJobId>(live && snapshot ? snapshot.running.map((r) => r.job) : []);
  return memoryPipeline(today).map((stage) => ({
    id: stage.id,
    label: stage.label,
    short: STAGE_SHORT[stage.id],
    value: countText(stage.value),
    known: known(stage.value),
    lit: running.has(stage.job),
  }));
}

/** Today's spend as a row of small figures (at most four, one row at 358 px);
 *  cost only when every call today had a known price. Empty when the day
 *  could not be read. */
export function todayFigures(snapshot: MemoryWorkView | null): Array<{ value: string; label: string }> {
  const today = snapshot && snapshot.state !== 'unknown' ? snapshot.today : null;
  if (!today) return [];
  const tokens = (n: unknown) => (known(n) ? formatTokenCount(n) : '—');
  const figures = [
    { value: countText(today.runs), label: today.runs === 1 ? 'run' : 'runs' },
    { value: countText(today.modelCalls), label: today.modelCalls === 1 ? 'model call' : 'model calls' },
    { value: `${tokens(today.inputTokens)} / ${tokens(today.outputTokens)}`, label: 'tokens in / out' },
  ];
  if (known(today.costUsd)) figures.push({ value: costText(today.costUsd), label: 'spent' });
  return figures;
}

// ───────────────────────────── activity strips ─────────────────────────────

export interface HourBar {
  hourStart: string;
  runs: number;
  modelCalls: number;
  learned: number;
  /** 0..1 of the busiest hour in the strip. */
  height: number;
  /** The hour the Mac's clock is in now. */
  current: boolean;
  /** Its place on the strip, 0 = 23 hours ago: each bar sits in its own
   *  hour, and an hour never measured stays blank. */
  slot: number;
}

export const HOUR_SLOTS = 24;
export const DAY_SLOTS = 30;

export interface HourStrip {
  bars: HourBar[];
  slots: number;
  /** What a bar's height measures: model calls, or runs on a day without any. */
  metric: 'modelCalls' | 'runs';
  totals: { runs: number; modelCalls: number; learned: number };
  /** When fewer hours than the strip were measured (the journal began
   *  inside it): the instant counting began. */
  since: string | null;
}

function count(value: unknown): number {
  return known(value) && value > 0 ? value : 0;
}

/** When the journal began, if that falls in `[from, to)`. */
function measuredSinceWithin(snapshot: MemoryWorkView, from: number, to: number): string | null {
  const t = snapshot.measuredSince ? Date.parse(snapshot.measuredSince) : Number.NaN;
  return Number.isFinite(t) && t >= from && t < to ? new Date(t).toISOString() : null;
}

/** The last 24 hours as bars, oldest first, each in its own hour's slot
 *  (counted back from the Mac's current hour), so a young journal's one hour
 *  is one bar at the right, never a bar across the day. Null when there is
 *  nothing the daemon could read, so the view shows "—" instead of a flat
 *  line of zeros. */
export function hourStrip(snapshot: MemoryWorkView | null, now: number): HourStrip | null {
  if (!snapshot || snapshot.state === 'unknown') return null;
  const hours = snapshot.hourly.filter((h) => Number.isFinite(Date.parse(h.hourStart)));
  if (hours.length === 0) return null;
  const newest = Math.max(...hours.map((h) => Date.parse(h.hourStart)));
  const anchor = newest + Math.max(0, Math.floor((now - newest) / HOUR)) * HOUR;
  const placed = hours
    .map((hour) => ({ hour, start: Date.parse(hour.hourStart), slot: HOUR_SLOTS - 1 - Math.round((anchor - Date.parse(hour.hourStart)) / HOUR) }))
    .filter((p) => p.slot >= 0 && p.slot < HOUR_SLOTS);
  const metric: HourStrip['metric'] = placed.some(({ hour }) => count(hour.modelCalls) > 0) ? 'modelCalls' : 'runs';
  const max = Math.max(0, ...placed.map(({ hour }) => count(hour[metric])));
  const totals = { runs: 0, modelCalls: 0, learned: 0 };
  const bars = placed.map(({ hour, start, slot }) => {
    const bar: HourBar = {
      hourStart: hour.hourStart,
      runs: count(hour.runs),
      modelCalls: count(hour.modelCalls),
      learned: count(hour.learned),
      height: max > 0 ? count(hour[metric]) / max : 0,
      current: now >= start && now < start + HOUR,
      slot,
    };
    totals.runs += bar.runs;
    totals.modelCalls += bar.modelCalls;
    totals.learned += bar.learned;
    return bar;
  });
  const first = placed[0]?.start;
  const since = bars.length < HOUR_SLOTS && first !== undefined
    ? measuredSinceWithin(snapshot, first, first + HOUR) ?? new Date(first).toISOString()
    : null;
  return { bars, slots: HOUR_SLOTS, metric, totals, since };
}

function workFigures(parts: { runs: number; modelCalls: number; learned: number }): string {
  if (parts.runs === 0 && parts.modelCalls === 0 && parts.learned === 0) return 'no memory work';
  const out = [plural(parts.runs, 'run', 'runs')];
  if (parts.modelCalls > 0) out.push(plural(parts.modelCalls, 'model call', 'model calls'));
  if (parts.learned > 0) out.push(`${parts.learned.toLocaleString()} learned`);
  return out.join(' · ');
}

/** "Last 24 hours · …", or the span measured ("Since 9:12 AM · …") while the
 *  journal is younger than the strip. */
export function hourStripSummary(strip: HourStrip | null): string {
  if (!strip) return 'Last 24 hours · —';
  const span = strip.since ? `Since ${timeOfDayText(strip.since)}` : 'Last 24 hours';
  return `${span} · ${workFigures(strip.totals)}`;
}

/** "3 PM · 2 runs · 9 model calls · 2 learned", or "This hour · …". */
export function hourCaption(bar: HourBar): string {
  const start = Date.parse(bar.hourStart);
  const label = bar.current
    ? 'This hour'
    : Number.isFinite(start) ? new Date(start).toLocaleTimeString(undefined, { hour: 'numeric' }) : '';
  return `${label} · ${workFigures(bar)}`;
}

export interface DayBar {
  day: string;
  learned: number;
  runs: number;
  modelCalls: number;
  tokens: number;
  height: number;
  today: boolean;
  /** Its place on the strip, 0 = 29 days ago; a day with no record stays blank. */
  slot: number;
}

/** A calendar day ("2026-09-26") at noon, so no time zone moves it. */
function dayNoon(day: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T12:00:00`).getTime() : Number.NaN;
}

/** The daily totals the daemon keeps, oldest first, each in its own day's
 *  slot. A day it has no row for is blank, not a zero. */
export function dayStrip(snapshot: MemoryWorkView | null, now: number): { bars: DayBar[]; slots: number; summary: string } | null {
  if (!snapshot || snapshot.state === 'unknown') return null;
  const days = snapshot.daily.filter((d) => Number.isFinite(dayNoon(d.day)));
  if (days.length === 0) return null;
  const newest = Math.max(...days.map((d) => dayNoon(d.day)));
  const placed = days
    .map((day) => ({ day, slot: DAY_SLOTS - 1 - Math.round((newest - dayNoon(day.day)) / DAY) }))
    .filter((p) => p.slot >= 0 && p.slot < DAY_SLOTS);
  const metric = placed.some(({ day }) => count(day.modelCalls) > 0) ? 'modelCalls' : 'runs';
  const max = Math.max(0, ...placed.map(({ day }) => count(day[metric])));
  const todayKey = dayKey(now);
  let learned = 0;
  let calls = 0;
  const bars = placed.map(({ day, slot }) => {
    learned += count(day.learned);
    calls += count(day.modelCalls);
    return {
      day: day.day,
      learned: count(day.learned),
      runs: count(day.runs),
      modelCalls: count(day.modelCalls),
      tokens: count(day.inputTokens) + count(day.outputTokens),
      height: max > 0 ? count(day[metric]) / max : 0,
      today: day.day === todayKey,
      slot,
    };
  });
  const span = bars.length === 1 ? 'Today' : `Last ${bars.length} days`;
  const figures = [plural(calls, 'model call', 'model calls'), `${learned.toLocaleString()} learned`];
  return { bars, slots: DAY_SLOTS, summary: `${span} · ${figures.join(' · ')}` };
}

/** "since 9:12 AM" when the journal began today (on the Mac's clock): the
 *  day's zeros count only from then. Null on a full day. */
export function todaySinceText(snapshot: MemoryWorkView | null, now: number): string | null {
  if (!snapshot || snapshot.state === 'unknown') return null;
  const since = measuredSinceWithin(snapshot, localDayStart(now), now + 1);
  return since ? `since ${timeOfDayText(since)}` : null;
}

/** "2026-09-26" on this phone's calendar. */
export function dayKey(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ───────────────────────────── runs ─────────────────────────────

const CHANGE_WORDS: Record<MemoryWorkFact['change'], string> = {
  learned: 'learned',
  updated: 'updated',
  reinforced: 'confirmed',
  faded: 'faded',
  restored: 'restored',
};

export interface MemoryFactView {
  id: string;
  /** A number the fact screen can open, when the id is one. */
  factId: number | null;
  text: string;
  change: string;
  /** "no longer in use" / "back in use" when its state moved since the run. */
  state: string | null;
  active: boolean;
}

export interface MemoryEventView {
  id: string;
  job: MemoryJobId;
  sentence: string;
  tone: 'ok' | 'quiet' | 'waiting' | 'failed';
  age: string;
  /** Time of day, for a row listed under its day. */
  time: string;
  /** The model that served, named from the catalog; null when no model ran. */
  model: string | null;
  standIn: boolean;
  /** "3 model calls", "12k tokens", "8 s": only what was measured. */
  meta: string[];
  undo: { kind: 'forget' | 'restore'; count: number; text: string } | null;
  facts: MemoryFactView[];
  /** Changes this run made beyond the ones listed. */
  moreFacts: number;
  /** When this record of the run ages out. The memories it changed stay. */
  kept: string;
}

function factView(fact: MemoryWorkFact): MemoryFactView {
  const id = String(fact.id);
  const numeric = Number(id);
  let state: string | null = null;
  if (fact.change === 'faded') state = fact.active ? 'back in use' : null;
  else if (!fact.active) state = 'no longer in use';
  return {
    id,
    factId: Number.isInteger(numeric) && numeric > 0 ? numeric : null,
    text: fact.text,
    change: CHANGE_WORDS[fact.change] ?? fact.change,
    state,
    active: fact.active,
  };
}

/** How long this record of a run stays: "This record is kept 6 more days".
 *  Only the record ages out; the memories the run changed stay. */
export function keptText(expiresAt: string | undefined, now: number): string {
  const t = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(t)) return '';
  if (t <= now) return 'This record is ageing out now';
  const days = calendarDaysBetween(now, t);
  if (days <= 0) return 'This record ages out today';
  if (days === 1) return 'This record ages out tomorrow';
  return `This record is kept ${days} more days`;
}

export function memoryEventView(event: MemoryWorkEvent, modelName: ModelNamer, now: number): MemoryEventView {
  const tone: MemoryEventView['tone'] = event.outcome === 'failed' ? 'failed'
    : event.outcome === 'waiting' ? 'waiting'
    : event.outcome === 'nothing_new' ? 'quiet'
    : 'ok';
  const meta: string[] = [];
  const usage = event.usage ?? null;
  if (usage && count(usage.calls) > 0) meta.push(plural(usage.calls, 'model call', 'model calls'));
  const tokens = usage ? count(usage.inputTokens) + count(usage.outputTokens) : 0;
  if (tokens > 0) meta.push(`${formatTokenCount(tokens)} tokens`);
  const started = event.startedAt ? Date.parse(event.startedAt) : Number.NaN;
  const ended = Date.parse(event.at);
  const duration = known(usage?.durationMs) ? usage!.durationMs! : Number.isFinite(started) && Number.isFinite(ended) ? ended - started : Number.NaN;
  const took = durationText(duration);
  if (took) meta.push(took);

  const undoWords = memoryUndoText(event);
  const facts = list<MemoryWorkFact>(event.facts).map(factView);
  const p = event.produced ?? {};
  const changed = count(p.learned) + count(p.updated) + count(p.reinforced) + count(p.faded) + count(p.restored);
  return {
    id: event.id,
    job: event.job,
    sentence: memoryEventSentence(event),
    tone,
    age: ageText(event.at, now),
    time: timeOfDayText(event.at),
    model: event.model?.modelId ? modelName(event.model.modelId) : null,
    standIn: Boolean(event.model?.standIn),
    meta,
    undo: undoWords && event.undo ? { kind: event.undo.kind, count: event.undo.count, text: undoWords } : null,
    facts,
    moreFacts: facts.length > 0 ? Math.max(0, changed - facts.length) : 0,
    kept: keptText(event.expiresAt, now),
  };
}

/** Before forgetting, one plain question; bringing a memory back needs none. */
export function undoConfirmText(undo: NonNullable<MemoryEventView['undo']>): string | null {
  if (undo.kind !== 'forget') return null;
  return undo.count === 1
    ? 'Forget the memory this run learned?'
    : `Forget the ${undo.count} memories this run learned?`;
}

/** What an undo did, in the Mac's words too (@clem/chat-engine). `null` =
 *  the request never got an answer. Already undone is not a failure. */
export function undoOutcomeText(result: MemoryWorkUndoResult | null, kind: 'forget' | 'restore'): { ok: boolean; text: string } {
  const ok = Boolean(result && (result.ok || result.reason === 'nothing_to_undo'));
  return { ok, text: memoryUndoResultText(result, kind) };
}

/** Newest first, grouped under "Today", "Yesterday", a weekday, or a date. */
export function groupByDay<T extends { at: string }>(items: readonly T[], now: number): Array<{ key: string; label: string; items: T[] }> {
  const groups: Array<{ key: string; label: string; items: T[] }> = [];
  for (const item of items) {
    const t = Date.parse(item.at);
    const key = Number.isFinite(t) ? dayKey(t) : 'unknown';
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, label: Number.isFinite(t) ? dayLabel(t, now) : 'Earlier', items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

export function dayLabel(t: number, now: number): string {
  const days = calendarDaysBetween(t, now);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return new Date(t).toLocaleDateString(undefined, { weekday: 'long' });
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The quiet line under the runs: only counts that are above zero, as words,
 *  never a call to action. */
export function queueLine(queue: MemoryWorkQueue | null | undefined): string | null {
  const parts: string[] = [];
  if (count(queue?.setAside) > 0) parts.push(`${queue!.setAside!.toLocaleString()} set aside for a second look`);
  if (count(queue?.failed) > 0) parts.push(`${plural(queue!.failed!, 'part', 'parts')} could not be read after every retry`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function retentionText(retention: MemoryWorkView['retention']): string | null {
  if (!retention || !known(retention.detailDays) || !known(retention.summaryDays)) return null;
  return `Clem keeps the detail of each run for ${plural(retention.detailDays, 'day', 'days')} and daily totals for ${plural(retention.summaryDays, 'day', 'days')}, then deletes them.`;
}

/** What the card says when there is no run to list. Null while the headline
 *  already carries a failed read. */
export function recentEmptyText(snapshot: MemoryWorkView | null): string | null {
  if (!snapshot || snapshot.state === 'unknown' || snapshot.recent.length > 0) return null;
  const days = snapshot.retention && known(snapshot.retention.detailDays) ? snapshot.retention.detailDays : null;
  return days
    ? `Nothing in the last ${plural(days, 'day', 'days')}. What Clem learns in the background shows up here.`
    : 'Nothing yet. What Clem learns in the background shows up here.';
}

// ───────────────────────────── jobs ─────────────────────────────

const LEARNING_JOBS: ReadonlySet<MemoryJobId> = new Set(['learn', 'reconcile', 'patterns', 'skills', 'identity', 'import']);

const OUTCOME_WORDS: Record<NonNullable<MemoryJobStatus['lastRun']>['outcome'], string> = {
  ok: 'done',
  nothing_new: 'nothing new',
  failed: 'did not finish',
  waiting: 'waiting',
};

export interface MemoryJobView {
  id: MemoryJobId;
  title: string;
  blurb: string;
  state: MemoryJobStatus['state'];
  pulse: boolean;
  /** "Reading a finished conversation", "Waiting", "Off"; empty when idle. */
  stateText: string;
  /** "Provider — Model · Keeps your memory", "Runs on this Mac". */
  model: string;
  /** "Last ran 4 min ago · done", "No run recorded yet", or "Last run —"
   *  when the journal could not be read. */
  last: string;
  next: string;
  /** "2 runs today · 9 model calls · 12k tokens"; null on a day it did not
   *  run, or on one the daemon could not read. */
  today: string | null;
}

export interface MemoryJobGroup {
  id: 'learning' | 'upkeep';
  label: string;
  jobs: MemoryJobView[];
}

function jobView(job: MemoryJobStatus, snapshot: MemoryWorkView, modelName: ModelNamer, now: number, live: boolean): MemoryJobView {
  const words = MEMORY_JOB_WORDS[job.id];
  const fmt = memoryTimeFormat(now);
  const owner = memoryJobModelOwnerText(job.modelOwner);
  // A journal the daemon could not read says nothing about when a job ran:
  // its last run and today's figures are unknown, never "no run" or none.
  const unread = snapshot.state === 'unknown';
  let model: string;
  if (job.modelOwner === 'none') model = owner;
  else if (job.modelOwner === 'local') {
    // The local index model is a file on this Mac, not a catalog entry.
    const id = job.modelId ?? snapshot.embedder?.modelId ?? null;
    model = id ? `${id} · ${owner}` : owner;
  } else {
    // The model the job asks for now; none named means none is available.
    model = `${job.modelId ? modelName(job.modelId) : unread ? '—' : 'None available'} · ${owner}`;
  }
  const running = job.state === 'running';
  const stateText = running
    ? (live ? words.doing : 'Running at the last check')
    : job.state === 'waiting' ? 'Waiting'
    : job.state === 'off' ? 'Off'
    : '';
  const lastRun = job.lastRun;
  const last = unread ? 'Last run —'
    : lastRun ? `Last ran ${fmt.age(lastRun.at)} · ${OUTCOME_WORDS[lastRun.outcome] ?? lastRun.outcome}`
    : MEMORY_JOB_NO_RUN;
  const today = unread ? null : job.today;
  let todayLine: string | null = null;
  if (today && count(today.runs) > 0) {
    const parts = [`${plural(today.runs, 'run', 'runs')} today`];
    if (count(today.modelCalls) > 0) parts.push(plural(today.modelCalls, 'model call', 'model calls'));
    const tokens = count(today.inputTokens) + count(today.outputTokens);
    if (tokens > 0) parts.push(`${formatTokenCount(tokens)} tokens`);
    todayLine = parts.join(' · ');
  }
  return {
    id: job.id,
    title: words?.title ?? job.id,
    blurb: words?.blurb ?? '',
    state: job.state,
    pulse: running && live,
    stateText,
    model,
    last,
    next: memoryNextText(job.next ?? null, fmt),
    today: todayLine,
  };
}

/** Every job the daemon reported, in the shared order, split into the work
 *  that learns and the work that keeps memory tidy. Importing stays out of
 *  the list until it has run: it only happens when you ask. */
export function memoryJobGroups(snapshot: MemoryWorkView | null, modelName: ModelNamer, now: number, live: boolean): MemoryJobGroup[] {
  if (!snapshot) return [];
  const byId = new Map(snapshot.jobs.map((job) => [job.id, job] as const));
  const learning: MemoryJobView[] = [];
  const upkeep: MemoryJobView[] = [];
  for (const id of MEMORY_JOB_ORDER) {
    const job = byId.get(id);
    if (!job) continue;
    if (id === 'import' && !job.lastRun && count(job.today?.runs) === 0 && job.state !== 'running') continue;
    (LEARNING_JOBS.has(id) ? learning : upkeep).push(jobView(job, snapshot, modelName, now, live));
  }
  const groups: MemoryJobGroup[] = [];
  if (learning.length > 0) groups.push({ id: 'learning', label: 'Learning', jobs: learning });
  if (upkeep.length > 0) groups.push({ id: 'upkeep', label: 'Upkeep', jobs: upkeep });
  return groups;
}
