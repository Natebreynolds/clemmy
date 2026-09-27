/**
 * Memory at work, on the Mac: the client for `GET /api/console/memory/work`,
 * its poll, the undo door, and ONE pure view model the panel renders.
 *
 * The daemon builds a `MemoryWorkSnapshot` (the shared contract in
 * @clem/chat-engine) and the phone reads the same one. Everything the owner
 * reads here comes from that snapshot and the shared words, so the Mac and the
 * phone say the same thing about the same run. The view model adds only what a
 * desktop layout needs — bar heights, day groups, which connector carries
 * light — and keeps the contract's honesty:
 * - motion only while a job runs in the daemon right now, and never over data
 *   the panel could not refresh;
 * - a count the daemon could not read is "—", never 0;
 * - the model named is the one that answered, and a stand-in says so.
 */
import {
  formatTokenCount,
  memoryEventSentence,
  memoryJobModelOwnerText,
  memoryModelProblemText,
  memoryNextText,
  memoryPipeline,
  memoryRoleAutomaticText,
  memoryUndoText,
  memoryWorkHeadline,
  modelDisplayName,
  MEMORY_JOB_ORDER,
  MEMORY_JOB_WORDS,
  type MemoryJobId,
  type MemoryJobModelOwner,
  type MemoryJobStatus,
  type MemoryPipelineStage,
  type MemoryTimeFormat,
  type MemoryWorkEvent,
  type MemoryWorkFact,
  type MemoryWorkOutcome,
  type MemoryWorkSnapshot,
  type MemoryWorkState,
  type MemoryWorkToday,
  type MemoryWorkUndoResult,
} from '@clem/chat-engine';
import { apiGet, apiPost } from './api';
import { usePoll } from './poll';

export type {
  MemoryJobId,
  MemoryJobStatus,
  MemoryWorkEvent,
  MemoryWorkSnapshot,
  MemoryWorkState,
  MemoryWorkUndoResult,
} from '@clem/chat-engine';

// ─────────────────────────────── transport ───────────────────────────────

/** Desktop polls while the window is visible (react-query pauses a hidden
 *  window's interval). The route is a cheap, index-backed read. */
export const MEMORY_WORK_POLL_MS = 5_000;
export const MEMORY_WORK_QUERY_KEY = ['memory-work'] as const;

export const getMemoryWork = () => apiGet<MemoryWorkSnapshot>('/api/console/memory/work');

export const undoMemoryWork = (eventId: string) =>
  apiPost<MemoryWorkUndoResult>(`/api/console/memory/work/${encodeURIComponent(eventId)}/undo`);

export function useMemoryWork() {
  return usePoll(MEMORY_WORK_QUERY_KEY, getMemoryWork, MEMORY_WORK_POLL_MS);
}

/** What an undo did, said calmly. The next snapshot recomputes what is left. */
export function memoryUndoResultText(result: MemoryWorkUndoResult, kind: 'forget' | 'restore'): string {
  if (result.ok) {
    const n = result.changed;
    if (n <= 0) return 'Nothing left to change — it was already done.';
    const what = n === 1 ? 'memory' : 'memories';
    return kind === 'forget' ? `Forgot ${n} ${what}.` : `Brought back ${n} ${what}.`;
  }
  switch (result.reason) {
    case 'not_found': return 'That run is no longer in the history.';
    case 'expired': return 'That run is too old to undo now.';
    case 'nothing_to_undo': return 'Nothing left to undo — it was already changed.';
    default: return 'Couldn’t undo just now. Nothing was changed.';
  }
}

export interface MemoryUndoNotice {
  /** It changed something (drawn with a check). */
  ok: boolean;
  text: string;
  /** The daemon never got to try, or tried and failed: the owner may try again.
   *  A refusal (too old, already done, gone) is final. */
  retry: boolean;
}

/** The line a row shows after its undo. `result` null = the request never got
 *  an answer (network, daemon restarting). */
export function memoryUndoNotice(result: MemoryWorkUndoResult | null, kind: 'forget' | 'restore'): MemoryUndoNotice {
  if (!result) return { ok: false, text: 'Couldn’t undo just now. Nothing was changed.', retry: true };
  return {
    ok: result.ok && result.changed > 0,
    text: memoryUndoResultText(result, kind),
    retry: !result.ok && result.reason === 'failed',
  };
}

// ───────────────────────────────── time ──────────────────────────────────

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function parse(iso: string | null | undefined): number {
  if (!iso) return NaN;
  return Date.parse(iso);
}

function localDayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfLocalDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function timeOfDay(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function hourOfDay(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric' });
}

/** Whole local days between two instants (0 = same day, 1 = yesterday). */
function daysApart(earlier: number, later: number): number {
  return Math.round((startOfLocalDay(later) - startOfLocalDay(earlier)) / DAY_MS);
}

/** The `MemoryTimeFormat` the shared words take: "4 min ago", "3:00 AM",
 *  "Tue 3:00 AM" when the moment is not today. */
export function memoryTimeFormat(now: number): MemoryTimeFormat {
  return {
    age(iso) {
      const t = parse(iso);
      if (!Number.isFinite(t)) return '';
      const diff = now - t;
      if (diff < 60_000) return 'just now';
      const min = Math.floor(diff / 60_000);
      if (min < 60) return `${min} min ago`;
      const days = daysApart(t, now);
      if (days === 0 || min < 6 * 60) return `${Math.floor(min / 60)} h ago`;
      if (days === 1) return 'yesterday';
      return `${days} days ago`;
    },
    clock(iso) {
      const t = parse(iso);
      if (!Number.isFinite(t)) return '';
      if (localDayKey(t) === localDayKey(now)) return timeOfDay(t);
      const weekday = new Date(t).toLocaleDateString([], { weekday: 'short' });
      return `${weekday} ${timeOfDay(t)}`;
    },
  };
}

function dayLabel(t: number, now: number): string {
  const days = daysApart(t, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function shortDate(t: number): string {
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** "8s", "1m 4s", "under a second". */
export function durationWords(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1_000) return 'under a second';
  const s = Math.round(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** "0:12" since a moment, for the running line. */
export function elapsedClock(startedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ──────────────────────────────── numbers ────────────────────────────────

/** A finite count, or null. The daemon sends null for what it could not read,
 *  and an older build may leave a field out: both are unknown, never zero. */
function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export const UNKNOWN = '—';

export function countText(v: number | null | undefined): string {
  const n = count(v);
  return n === null ? UNKNOWN : n.toLocaleString();
}

function tokensText(v: number | null | undefined): string {
  const n = count(v);
  return n === null ? UNKNOWN : formatTokenCount(n);
}

function costText(v: number | null | undefined): string | null {
  const n = count(v);
  if (n === null) return null;
  if (n > 0 && n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

// ──────────────────────────────── the view ───────────────────────────────

export interface MemoryModelChipView {
  /** Display name of the model the next memory job asks for; null = none available. */
  name: string | null;
  modelId: string | null;
  source: 'chosen' | 'automatic';
  sourceLabel: 'Chosen' | 'Automatic';
  /** Automatic only: whose model memory work borrows, in the shared words. */
  automaticText: string | null;
  /** The model that answered last, when it is worth saying: it stood in, or
   *  it is not the one the next job asks for. */
  served: { name: string; standIn: boolean; age: string } | null;
  /** "is out of credit" — the model cannot serve right now. */
  problem: string | null;
  /** The read failed, so which model keeps the memory is not known: "—",
   *  never "no model available". */
  unknown: boolean;
}

export interface PipelineStageView extends MemoryPipelineStage {
  text: string;
  /** The job that lights this stage is running right now. */
  active: boolean;
}

/** Which connectors carry light: the one INTO each running stage. */
export interface PipelineFlows {
  readToFound: boolean;
  foundToKept: boolean;
  foundToAside: boolean;
  keptToFaded: boolean;
}

export interface ActivityBarView {
  key: string;
  label: string;
  value: number;
  /** 0–100, share of the busiest bar; a bar with any work is at least visible. */
  height: number;
  learned: number;
  current: boolean;
  /** Axis tick under this bar ("6 AM"), when it gets one. */
  tick: string | null;
  /** Everything the bar stands for, in words (hover, focus, screen readers). */
  readout: string;
}

export interface TotalView { label: string; value: string }

/** `unrecorded`: the journal holds no run for this job (it keeps 90 days and
 *  began at install, so that is not "never ran"). `unknown`: the read failed. */
export type JobDot = 'running' | 'waiting' | 'off' | 'ok' | 'failed' | 'unrecorded' | 'unknown';

export interface JobView {
  id: MemoryJobId;
  group: 'learning' | 'upkeep';
  title: string;
  blurb: string;
  doing: string;
  state: MemoryJobStatus['state'];
  dot: JobDot;
  /** Said next to the title when the job is not simply idle. */
  stateLabel: string | null;
  modelOwner: MemoryJobModelOwner;
  /** Display name of the model the snapshot names for this job; null when it names none. */
  modelName: string | null;
  /** What the Model cell says: the name; "No model" (rules only); "None
   *  available" (a memory job whose route resolved to nothing); or "—" when
   *  it is not known (the read failed, or a checker/local job with no run
   *  recorded — the daemon reports their model only from a recorded run). */
  modelText: string;
  /** For screen readers, why the model is "—". */
  modelHint: string | null;
  modelOwnerText: string;
  /** "Last ran 4 min ago · done · 8s" — the whole line; "No run recorded
   *  yet", or "—" when the read failed. */
  lastText: string;
  /** The same in two parts, for a column: "4 min ago" / "done · 8s"; null
   *  when there is no run to show. */
  lastWhen: string | null;
  lastDetail: string | null;
  lastFailed: boolean;
  nextText: string;
  /** "3 runs · 12k tokens"; "—" when the read failed; null when no run is
   *  recorded today. */
  todayText: string | null;
  /** The read that built this row failed: its model, last run and today are
   *  "—" unless the daemon still said them. */
  unknown: boolean;
}

export interface TimelineFactView {
  id: string;
  text: string;
  change: MemoryWorkFact['change'];
  changeLabel: string;
  active: boolean;
}

export interface TimelineRowView {
  id: string;
  job: MemoryJobId;
  time: string;
  at: string;
  sentence: string;
  outcome: MemoryWorkOutcome;
  failed: boolean;
  modelName: string | null;
  standIn: boolean;
  /** "12.4k tokens" when the run made model calls. */
  tokens: string | null;
  duration: string | null;
  /** Details line for the expanded row. */
  usage: string | null;
  source: string | null;
  facts: TimelineFactView[];
  /** Changes the run made beyond the memories listed. */
  factsMore: number;
  undo: { label: string; kind: 'forget' | 'restore' } | null;
  /** "Ages out of this history Oct 3". */
  expires: string | null;
}

export interface TimelineDayView {
  key: string;
  label: string;
  rows: TimelineRowView[];
}

export interface MemoryWorkView {
  state: MemoryWorkState;
  /** How the status line is drawn. A stale read is drawn as unknown: the line
   *  is about NOW, and now is exactly what could not be read. */
  band: MemoryWorkState;
  /** Resting with nothing left to read. */
  upToDate: boolean;
  /** Something is running in the daemon right now AND this read is fresh. The
   *  only thing that may move on the panel. */
  live: boolean;
  headline: string;
  detail: string | null;
  /** When the first running job started, for the running clock. */
  runningSince: number | null;
  runningJobs: MemoryJobId[];
  /** Showing the last good read after a failed one. */
  stale: boolean;
  model: MemoryModelChipView;
  pipeline: PipelineStageView[];
  flows: PipelineFlows;
  hourly: ActivityBarView[];
  /** What the 24-hour bars measure. */
  hourlyUnit: 'model calls' | 'runs';
  hourlyEmpty: boolean;
  /** The 24 hours in one line, shown until a bar is pointed at. */
  hourlySummary: string;
  daily: ActivityBarView[];
  dailyUnit: 'model calls' | 'runs';
  dailyMissing: number;
  totals: TotalView[];
  jobs: { learning: JobView[]; upkeep: JobView[] };
  timeline: TimelineDayView[];
  eventCount: number;
  queueLine: string | null;
  retentionText: string;
}

const LEARNING_JOBS: ReadonlySet<MemoryJobId> = new Set(['learn', 'reconcile', 'patterns', 'skills', 'identity', 'import']);

const CHANGE_LABEL: Record<MemoryWorkFact['change'], string> = {
  learned: 'New',
  updated: 'Updated',
  reinforced: 'Confirmed',
  faded: 'Faded',
  restored: 'Back',
};

const OUTCOME_WORDS: Record<MemoryWorkOutcome, string> = {
  ok: 'done',
  nothing_new: 'nothing new',
  failed: 'didn’t finish',
  waiting: 'waiting',
};

function modelChip(snapshot: MemoryWorkSnapshot, fmt: MemoryTimeFormat, unknown: boolean): MemoryModelChipView {
  const m = snapshot.model ?? { source: 'automatic', modelId: null };
  const modelId = typeof m.modelId === 'string' && m.modelId.trim() ? m.modelId : null;
  const name = modelId ? modelDisplayName(modelId) : null;
  const source = m.source === 'chosen' ? 'chosen' : 'automatic';
  const last = m.lastServed ?? null;
  let served: MemoryModelChipView['served'] = null;
  if (last && typeof last.modelId === 'string' && last.modelId) {
    const servedName = modelDisplayName(last.modelId);
    // Said when it matters: a stand-in (the daemon's route evidence decides
    // that, not a spelling), or a different model than the next job asks for.
    if (last.standIn || servedName !== name) served = { name: servedName, standIn: Boolean(last.standIn), age: fmt.age(last.at) };
  }
  return {
    name,
    modelId,
    source,
    sourceLabel: source === 'chosen' ? 'Chosen' : 'Automatic',
    automaticText: source === 'automatic' ? memoryRoleAutomaticText(m.follows ?? null) : null,
    served,
    problem: m.unavailable?.problem ? memoryModelProblemText(m.unavailable.problem) : null,
    unknown: unknown && !modelId,
  };
}

/** The shared pipeline, with one correction for honesty: a combined stage
 *  whose every part is unknown is unknown, not zero. */
function pipeline(today: MemoryWorkToday | null | undefined, unknown: boolean, running: ReadonlySet<MemoryJobId>): PipelineStageView[] {
  const stages = memoryPipeline(unknown ? null : today);
  return stages.map((stage) => {
    let value = stage.value;
    if (!unknown && today) {
      if (stage.id === 'kept' && count(today.learned) === null && count(today.updated) === null) value = null;
      if (stage.id === 'aside' && count(today.leftOut) === null && count(today.setAside) === null) value = null;
    }
    return { ...stage, value, text: countText(value), active: running.has(stage.job) };
  });
}

function flows(stages: readonly PipelineStageView[]): PipelineFlows {
  const on = (id: PipelineStageView['id']) => stages.find((s) => s.id === id)?.active ?? false;
  return { readToFound: on('found'), foundToKept: on('kept'), foundToAside: on('aside'), keptToFaded: on('faded') };
}

function hourlyBars(snapshot: MemoryWorkSnapshot, now: number): { bars: ActivityBarView[]; unit: 'model calls' | 'runs'; empty: boolean; summary: string } {
  const hours = Array.isArray(snapshot.hourly) ? snapshot.hourly : [];
  const useCalls = hours.some((h) => (count(h.modelCalls) ?? 0) > 0) || !hours.some((h) => (count(h.runs) ?? 0) > 0);
  const unit = useCalls ? 'model calls' : 'runs';
  const values = hours.map((h) => count(useCalls ? h.modelCalls : h.runs) ?? 0);
  const max = Math.max(0, ...values);
  const bars = hours.map((h, i) => {
    const start = parse(h.hourStart);
    const value = values[i] ?? 0;
    const learned = count(h.learned) ?? 0;
    const runs = count(h.runs) ?? 0;
    const calls = count(h.modelCalls) ?? 0;
    const current = Number.isFinite(start) && now >= start && now < start + HOUR_MS;
    const label = Number.isFinite(start) ? hourOfDay(start) : '';
    const tick = Number.isFinite(start) && new Date(start).getHours() % 6 === 0 && !current ? label : null;
    const parts = runs + calls === 0
      ? ['no memory work']
      : [plural(calls, 'model call', 'model calls'), plural(runs, 'run', 'runs'), ...(learned ? [`${learned.toLocaleString()} learned`] : [])];
    return {
      key: h.hourStart || String(i),
      label,
      value,
      height: max > 0 && value > 0 ? Math.max(8, Math.round((value / max) * 100)) : 0,
      learned,
      current,
      tick,
      readout: `${current ? 'This hour' : label} · ${parts.join(' · ')}`,
    };
  });
  const empty = bars.every((b) => b.value === 0 && b.learned === 0);
  const total = values.reduce((n, v) => n + v, 0);
  const learned = bars.reduce((n, b) => n + b.learned, 0);
  const lead = useCalls ? plural(total, 'model call', 'model calls') : plural(total, 'run', 'runs');
  const summary = empty
    ? 'No memory work in the last 24 hours.'
    : `${lead}${learned ? ` · ${learned.toLocaleString()} learned` : ''} in the last 24 hours. Point at a bar for its hour.`;
  return { bars, unit, empty, summary };
}

function dailyBars(snapshot: MemoryWorkSnapshot, now: number): { bars: ActivityBarView[]; unit: 'model calls' | 'runs'; missing: number } {
  const days = Array.isArray(snapshot.daily) ? snapshot.daily.slice(-30) : [];
  const useCalls = days.some((d) => (count(d.modelCalls) ?? 0) > 0) || !days.some((d) => (count(d.runs) ?? 0) > 0);
  const values = days.map((d) => count(useCalls ? d.modelCalls : d.runs) ?? 0);
  const max = Math.max(0, ...values);
  const todayKey = localDayKey(now);
  const bars = days.map((d, i) => {
    // `day` is a local calendar day ("2026-09-26"); read it as local noon so
    // no timezone can move it to the neighbouring date.
    const t = /^\d{4}-\d{2}-\d{2}$/.test(d.day) ? new Date(`${d.day}T12:00:00`).getTime() : parse(d.day);
    const value = values[i] ?? 0;
    const learned = count(d.learned) ?? 0;
    const calls = count(d.modelCalls) ?? 0;
    const runs = count(d.runs) ?? 0;
    const tokens = (count(d.inputTokens) ?? 0) + (count(d.outputTokens) ?? 0);
    const current = Number.isFinite(t) && localDayKey(t) === todayKey;
    const label = Number.isFinite(t) ? (current ? 'Today' : shortDate(t)) : d.day;
    const parts = runs + calls === 0
      ? ['no memory work']
      : [plural(calls, 'model call', 'model calls'), plural(runs, 'run', 'runs'), ...(learned ? [`${learned.toLocaleString()} learned`] : []), ...(tokens ? [`${formatTokenCount(tokens)} tokens`] : [])];
    return {
      key: d.day || String(i),
      label,
      value,
      height: max > 0 && value > 0 ? Math.max(8, Math.round((value / max) * 100)) : 0,
      learned,
      current,
      tick: null,
      readout: `${label} · ${parts.join(' · ')}`,
    };
  });
  return { bars, unit: useCalls ? 'model calls' : 'runs', missing: Math.max(0, 30 - bars.length) };
}

function totals(today: MemoryWorkToday | null | undefined, unknown: boolean): TotalView[] {
  const t = unknown ? null : today ?? null;
  const rows: TotalView[] = [
    { label: 'Model calls', value: countText(t?.modelCalls) },
    { label: 'Tokens in', value: tokensText(t?.inputTokens) },
    { label: 'Tokens out', value: tokensText(t?.outputTokens) },
    { label: 'Runs', value: countText(t?.runs) },
  ];
  const cost = costText(t?.costUsd);
  if (cost) rows.push({ label: 'Cost', value: cost });
  return rows;
}

function jobDot(job: MemoryJobStatus, unknown: boolean): JobDot {
  if (job.state === 'running') return 'running';
  if (job.state === 'waiting') return 'waiting';
  if (job.state === 'off') return 'off';
  if (!job.lastRun) return unknown ? 'unknown' : 'unrecorded';
  return job.lastRun.outcome === 'failed' ? 'failed' : 'ok';
}

/** The Model cell. A null model id means different things by owner: for a
 *  memory job the route resolved to nothing; for a checker or local job the
 *  daemon names the model only from a recorded run, so null is "not reported". */
function jobModel(owner: MemoryJobModelOwner, modelId: string | null, unknown: boolean): { name: string | null; text: string; hint: string | null } {
  if (owner === 'none') return { name: null, text: 'No model', hint: null };
  if (modelId) {
    const name = modelDisplayName(modelId);
    return { name, text: name, hint: null };
  }
  if (unknown) return { name: null, text: UNKNOWN, hint: 'couldn’t be read' };
  if (owner === 'memory') return { name: null, text: 'None available', hint: null };
  return { name: null, text: UNKNOWN, hint: owner === 'checker' ? 'named once a run is recorded' : 'not reported' };
}

function jobView(job: MemoryJobStatus, snapshot: MemoryWorkSnapshot, fmt: MemoryTimeFormat, stale: boolean, unknown: boolean): JobView {
  const words = MEMORY_JOB_WORDS[job.id];
  const owner = job.modelOwner;
  const modelId = typeof job.modelId === 'string' && job.modelId ? job.modelId : null;
  const model = jobModel(owner, modelId, unknown);
  const last = job.lastRun ?? null;
  const lastWhen = last ? fmt.age(last.at) : '';
  const lastDetail = last ? `${OUTCOME_WORDS[last.outcome] ?? last.outcome}${last.durationMs ? ` · ${durationWords(last.durationMs)}` : ''}` : null;
  // The journal keeps 90 days and began at install, and an in-process "last
  // checked" resets on restart: no record is not "never ran".
  const lastText = last ? `Last ran ${lastWhen || 'at an unknown time'} · ${lastDetail}` : unknown ? UNKNOWN : 'No run recorded yet';
  const runs = count(job.today?.runs) ?? 0;
  const tokens = (count(job.today?.inputTokens) ?? 0) + (count(job.today?.outputTokens) ?? 0);
  const calls = count(job.today?.modelCalls) ?? 0;
  const todayParts = runs > 0 ? [plural(runs, 'run', 'runs')] : [];
  if (runs > 0 && calls > 0) todayParts.push(tokens > 0 ? `${formatTokenCount(tokens)} tokens` : plural(calls, 'model call', 'model calls'));
  // An unknown read sends zeros for a job's day (the contract types them as
  // numbers); they are not a quiet day.
  const todayText = unknown ? UNKNOWN : todayParts.length ? todayParts.join(' · ') : null;
  // "Working now" is a claim about now; a read that failed cannot make it.
  const state: MemoryJobStatus['state'] = stale && job.state === 'running' ? 'idle' : job.state;
  let stateLabel: string | null = null;
  if (state === 'running') stateLabel = 'Working now';
  else if (state === 'waiting') stateLabel = snapshot.waiting?.reason === 'busy' ? 'Waiting its turn' : 'Waiting for the model';
  else if (state === 'off') stateLabel = 'Off';
  return {
    id: job.id,
    group: LEARNING_JOBS.has(job.id) ? 'learning' : 'upkeep',
    title: words?.title ?? job.id,
    blurb: words?.blurb ?? '',
    doing: words?.doing ?? '',
    state,
    dot: jobDot({ ...job, state }, unknown),
    stateLabel,
    modelOwner: owner,
    modelName: model.name,
    modelText: model.text,
    modelHint: model.hint,
    modelOwnerText: memoryJobModelOwnerText(owner),
    lastText,
    lastWhen: last ? lastWhen || 'unknown time' : null,
    lastDetail,
    lastFailed: last?.outcome === 'failed',
    nextText: memoryNextText(job.next ?? null, fmt),
    todayText,
    unknown,
  };
}

/** The daemon's running list is read in process even when the rest of the
 *  snapshot is not, so a job said to be running stays running when unknown. */
function jobs(snapshot: MemoryWorkSnapshot, fmt: MemoryTimeFormat, stale: boolean, unknown: boolean): MemoryWorkView['jobs'] {
  const byId = new Map((Array.isArray(snapshot.jobs) ? snapshot.jobs : []).map((j) => [j.id, j] as const));
  const learning: JobView[] = [];
  const upkeep: JobView[] = [];
  for (const id of MEMORY_JOB_ORDER) {
    const job = byId.get(id);
    if (!job) continue;
    // Importing is something the owner starts; until it has, it is not work
    // Clem does, and a card for it would read as an idle chore.
    if (id === 'import' && !job.lastRun && job.state !== 'running' && !(count(job.today?.runs) ?? 0)) continue;
    const view = jobView(job, snapshot, fmt, stale, unknown);
    (view.group === 'learning' ? learning : upkeep).push(view);
  }
  return { learning, upkeep };
}

function timelineRow(event: MemoryWorkEvent): TimelineRowView {
  const at = parse(event.at);
  const facts = (Array.isArray(event.facts) ? event.facts : []).map((f) => ({
    id: String(f.id),
    text: f.text,
    change: f.change,
    changeLabel: CHANGE_LABEL[f.change] ?? f.change,
    active: f.active !== false,
  }));
  const p = event.produced ?? {};
  const changed = (count(p.learned) ?? 0) + (count(p.updated) ?? 0) + (count(p.reinforced) ?? 0) + (count(p.faded) ?? 0) + (count(p.restored) ?? 0);
  const usage = event.usage ?? null;
  const calls = count(usage?.calls) ?? 0;
  const inTok = count(usage?.inputTokens) ?? 0;
  const outTok = count(usage?.outputTokens) ?? 0;
  const tokens = calls > 0 || inTok + outTok > 0 ? `${formatTokenCount(inTok + outTok)} tokens` : null;
  const duration = durationWords(usage?.durationMs) || null;
  const usageParts: string[] = [];
  if (calls > 0) usageParts.push(plural(calls, 'model call', 'model calls'));
  if (inTok + outTok > 0) usageParts.push(`${formatTokenCount(inTok)} in · ${formatTokenCount(outTok)} out`);
  const cached = count(usage?.cachedInputTokens) ?? 0;
  if (cached > 0) usageParts.push(`${formatTokenCount(cached)} reused from cache`);
  if (duration) usageParts.push(duration);
  const undoLabel = memoryUndoText(event);
  const expiresAt = parse(event.expiresAt);
  const title = event.source?.title?.trim();
  const source = event.source
    ? title
      ? `From “${title}”`
      : SOURCE_WORDS[event.source.kind] ?? null
    : null;
  return {
    id: event.id,
    job: event.job,
    time: Number.isFinite(at) ? timeOfDay(at) : '',
    at: event.at,
    sentence: memoryEventSentence(event),
    outcome: event.outcome,
    failed: event.outcome === 'failed',
    modelName: event.model?.modelId ? modelDisplayName(event.model.modelId) : null,
    standIn: Boolean(event.model?.standIn),
    tokens,
    duration,
    usage: usageParts.length ? usageParts.join(' · ') : null,
    source,
    facts,
    factsMore: Math.max(0, changed - facts.length),
    undo: undoLabel && event.undo ? { label: undoLabel, kind: event.undo.kind } : null,
    expires: Number.isFinite(expiresAt) ? `Ages out of this history ${shortDate(expiresAt)}` : null,
  };
}

const SOURCE_WORDS: Record<NonNullable<MemoryWorkEvent['source']>['kind'], string> = {
  conversation: 'From a conversation',
  workflow: 'From a workflow',
  owner: 'Started by you',
  schedule: 'On its schedule',
  tool: 'From a tool',
};

function timeline(snapshot: MemoryWorkSnapshot, now: number): TimelineDayView[] {
  const events = Array.isArray(snapshot.recent) ? snapshot.recent : [];
  const days: TimelineDayView[] = [];
  for (const event of events) {
    const t = parse(event.at);
    const key = Number.isFinite(t) ? localDayKey(t) : 'unknown';
    let day = days.find((d) => d.key === key);
    if (!day) {
      day = { key, label: Number.isFinite(t) ? dayLabel(t, now) : 'Earlier', rows: [] };
      days.push(day);
    }
    day.rows.push(timelineRow(event));
  }
  return days;
}

function queueLine(snapshot: MemoryWorkSnapshot): string | null {
  const parts: string[] = [];
  const aside = count(snapshot.queue?.setAside);
  const failed = count(snapshot.queue?.failed);
  if (aside !== null && aside > 0) parts.push(`${plural(aside, 'claim', 'claims')} set aside for a second look`);
  if (failed !== null && failed > 0) parts.push(`${plural(failed, 'part', 'parts')} of conversations couldn’t be read after every retry`);
  return parts.length ? parts.join(' · ') : null;
}

export interface MemoryWorkViewOptions {
  /** The last read failed and this snapshot is the previous good one. */
  stale?: boolean;
  /** When the shown snapshot was read (for "as of" wording while stale). */
  readAt?: number;
}

/** Everything the panel shows, from one snapshot. Pure: `now` is passed in. */
export function memoryWorkViewModel(snapshot: MemoryWorkSnapshot, now: number, opts: MemoryWorkViewOptions = {}): MemoryWorkView {
  const fmt = memoryTimeFormat(now);
  const stale = Boolean(opts.stale);
  const state: MemoryWorkState = snapshot.state ?? 'unknown';
  const unknown = state === 'unknown';
  const runningList = Array.isArray(snapshot.running) ? snapshot.running : [];
  const working = state === 'working' && runningList.length > 0;
  // A job read as running in a snapshot that could not be refreshed may have
  // finished since. Nothing moves on stale data.
  const live = working && !stale;
  const running = new Set<MemoryJobId>(live ? runningList.map((r) => r.job) : []);
  const headline = memoryWorkHeadline(
    {
      state,
      running: runningList,
      waiting: snapshot.waiting ?? null,
      lastWorkAt: snapshot.lastWorkAt ?? null,
      queue: snapshot.queue ?? { toLearn: null, setAside: null, failed: null },
      model: snapshot.model ?? { source: 'automatic', modelId: null },
    },
    fmt,
    modelDisplayName,
  );
  const firstStart = working ? parse(runningList[0]?.startedAt) : NaN;
  const stages = pipeline(snapshot.today, unknown, running);
  const hourly = hourlyBars(snapshot, now);
  const daily = dailyBars(snapshot, now);
  const tl = timeline(snapshot, now);
  const retention = snapshot.retention ?? { detailDays: 7, summaryDays: 90 };
  const toLearn = count(snapshot.queue?.toLearn);
  const readAge = opts.readAt ? fmt.age(new Date(opts.readAt).toISOString()) : '';
  const band: MemoryWorkState = stale ? 'unknown' : state === 'working' && !live ? 'resting' : state;
  // Resting with a queue that could not be read: nothing is running, but
  // "up to date" would be a claim about a count nobody read. (The shared
  // headline says "up to date" here; the Mac says what it knows instead.)
  const queueUnread = !stale && band === 'resting' && toLearn === null;
  return {
    state,
    band,
    upToDate: !stale && band === 'resting' && toLearn === 0,
    live,
    // The status line speaks about now. After a failed read it says so, and
    // everything below it is the last good read, labelled as such.
    headline: stale ? 'Couldn’t read memory work just now' : queueUnread ? 'No memory work running right now' : headline.text,
    detail: stale
      ? `Showing what Clem reported${readAge ? ` ${readAge}` : ' earlier'}. Nothing has been lost; this checks again in a few seconds.`
      : queueUnread
        ? `Couldn’t read what is left to learn${headline.detail ? ` · ${headline.detail}` : ''}`
        : headline.detail ?? null,
    runningSince: live && Number.isFinite(firstStart) ? firstStart : null,
    runningJobs: [...running],
    stale,
    model: modelChip(snapshot, fmt, unknown),
    pipeline: stages,
    flows: flows(stages),
    hourly: hourly.bars,
    hourlyUnit: hourly.unit,
    hourlyEmpty: hourly.empty,
    hourlySummary: hourly.summary,
    daily: daily.bars,
    dailyUnit: daily.unit,
    dailyMissing: daily.missing,
    totals: totals(snapshot.today, unknown),
    jobs: jobs(snapshot, fmt, stale, unknown),
    timeline: tl,
    eventCount: tl.reduce((n, d) => n + d.rows.length, 0),
    queueLine: queueLine(snapshot),
    retentionText: `Clem keeps this detail for ${plural(retention.detailDays, 'day', 'days')} and daily totals for ${plural(retention.summaryDays, 'day', 'days')}, then deletes them.`,
  };
}
