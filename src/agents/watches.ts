/**
 * Watches: what the owner handed Clem to keep an eye on.
 *
 * Owner, 2026-10-17: "if I were to give a real personal assistant access to
 * my email or a Google Drive or a Slack channel, the area from which Clem gets
 * her information outside of the chat starts compounding based on the user."
 *
 * A watch is a saved, read-only workflow with a `watch` declaration (source,
 * what to look for, purpose). The workflow owns the read and its schedule, on
 * the same admitted path as every other tool call; this module owns what the
 * host does with what it saw:
 *   - every run's report is retained per watch, with an age and a cap;
 *   - each NEW finding is checked against the owner's rules for that watch
 *     (their words, read by a model) and, for `tell_me`, raised as a From Clem
 *     item titled by its source;
 *   - each new thing it learned becomes a memory fact tagged with the watch,
 *     which Noticing and every conversation already read.
 * Nothing here reads a provider or sends anything.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import type { WorkflowWatch } from '../memory/workflow-watch.js';
import { loadHeartbeatContract, type HeartbeatContract } from './heartbeat-contracts.js';

const logger = pino({ name: 'clementine.watches' });

export const WATCHES_DIR = path.join(BASE_DIR, 'state', 'watches');
const MAX_FINDINGS_PER_REPORT = 20;
const MAX_LEARNED_PER_REPORT = 10;
const MAX_RUNS_KEPT = 30;
const MAX_FINDINGS_KEPT = 100;
const MAX_LEARNED_KEPT = 60;
const RETENTION_MS = 60 * 24 * 60 * 60_000;
const TEXT_MAX = 600;

export interface WatchFinding {
  key: string;
  title: string;
  detail?: string;
  link?: string;
}

export interface WatchReport {
  findings: WatchFinding[];
  learned: string[];
}

export interface WatchRunEntry {
  runId: string;
  at: string;
  /** `missing`: the run finished without a findings list to read. */
  report: 'ok' | 'missing';
  findings: number;
  surfaced: number;
  learned: number;
}

export interface WatchFindingEntry extends WatchFinding {
  at: string;
  runId: string;
  surfaced: boolean;
  /** Why it was not raised: the owner's rules skipped it, or the watch only learns. */
  heldBy?: 'rule' | 'learn_only';
}

export interface WatchLearnedEntry {
  text: string;
  at: string;
  runId: string;
  factId?: number;
}

export interface WatchState {
  version: 1;
  runs: WatchRunEntry[];
  findings: WatchFindingEntry[];
  learned: WatchLearnedEntry[];
}

export function watchIdFor(workflowSlug: string): string {
  return `watch:${workflowSlug}`;
}

export function watchSourceTitle(watch: Pick<WorkflowWatch, 'source'>): string {
  return `Your ${watch.source} watch`;
}

function bounded(value: unknown, max = TEXT_MAX): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) {
    // A model step may wrap its JSON in a fence; read the fenced object only.
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    if (!fenced) return value;
    try { return JSON.parse(fenced[1]!.trim()); } catch { return value; }
  }
  try { return JSON.parse(text); } catch { return value; }
}

function normalizeFinding(raw: unknown): WatchFinding | null {
  if (typeof raw === 'string') {
    const title = bounded(raw, 200);
    return title ? { key: digest(title), title } : null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const title = bounded(row.title ?? row.subject ?? row.summary ?? row.headline, 200);
  if (!title) return null;
  const detail = bounded(row.detail ?? row.why ?? row.body ?? row.description);
  const link = bounded(row.link ?? row.url, 500);
  const stated = bounded(row.key ?? row.id, 200);
  return {
    key: stated || digest(`${title}\u0000${link}`),
    title,
    ...(detail ? { detail } : {}),
    ...(link ? { link } : {}),
  };
}

/** The report in one value: an object with a `findings` list (and, optionally, `learned`). */
export function watchReportFromValue(value: unknown): WatchReport | null {
  const parsed = parseMaybeJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (!Array.isArray(row.findings)) return null;
  const findings: WatchFinding[] = [];
  const keys = new Set<string>();
  for (const entry of row.findings) {
    const finding = normalizeFinding(entry);
    if (!finding || keys.has(finding.key)) continue;
    keys.add(finding.key);
    findings.push(finding);
    if (findings.length >= MAX_FINDINGS_PER_REPORT) break;
  }
  const learned = Array.isArray(row.learned)
    ? [...new Set(row.learned.map((entry) => bounded(entry, 300)).filter(Boolean))].slice(0, MAX_LEARNED_PER_REPORT)
    : [];
  return { findings, learned };
}

/**
 * Read a watch run's report from its result: the last step (in authored
 * order) whose output carries a findings list, else the run's final output.
 */
export function extractWatchReport(input: {
  steps: ReadonlyArray<{ id: string }>;
  stepOutputs: Record<string, unknown>;
  finalOutput?: unknown;
}): WatchReport | null {
  for (const step of [...input.steps].reverse()) {
    if (!(step.id in input.stepOutputs)) continue;
    const report = watchReportFromValue(input.stepOutputs[step.id]);
    if (report) return report;
  }
  return input.finalOutput === undefined ? null : watchReportFromValue(input.finalOutput);
}

function stateFile(workflowSlug: string): string {
  const safe = workflowSlug.replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safe || safe !== workflowSlug) throw new Error('Invalid watch workflow slug.');
  return path.join(WATCHES_DIR, `${safe}.json`);
}

function emptyState(): WatchState {
  return { version: 1, runs: [], findings: [], learned: [] };
}

export function loadWatchState(workflowSlug: string): WatchState {
  const file = stateFile(workflowSlug);
  if (!existsSync(file)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<WatchState>;
    return {
      version: 1,
      runs: Array.isArray(raw.runs) ? raw.runs : [],
      findings: Array.isArray(raw.findings) ? raw.findings : [],
      learned: Array.isArray(raw.learned) ? raw.learned : [],
    };
  } catch {
    return emptyState();
  }
}

function saveWatchState(workflowSlug: string, state: WatchState, nowMs: number): void {
  const fresh = (at: string): boolean => {
    const ms = Date.parse(at);
    return Number.isFinite(ms) && nowMs - ms <= RETENTION_MS;
  };
  const kept: WatchState = {
    version: 1,
    runs: state.runs.filter((run) => fresh(run.at)).slice(-MAX_RUNS_KEPT),
    findings: state.findings.filter((finding) => fresh(finding.at)).slice(-MAX_FINDINGS_KEPT),
    learned: state.learned.filter((entry) => fresh(entry.at)).slice(-MAX_LEARNED_KEPT),
  };
  mkdirSync(WATCHES_DIR, { recursive: true });
  const file = stateFile(workflowSlug);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(kept, null, 2)}\n`, 'utf-8');
  renameSync(tmp, file);
}

function normalizedLearned(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export interface WatchRunDeps {
  now: () => number;
  contract: (watchId: string) => HeartbeatContract;
  /** The owner's rules for this watch, read by a model; null = no verdict (surface). */
  judge: (input: { watch: WorkflowWatch; watchId: string; rules: string[]; finding: WatchFinding }) => Promise<{ surface: boolean } | null>;
  publish: (input: { watch: WorkflowWatch; watchId: string; workflowSlug: string; workflowName: string; runId: string; finding: WatchFinding; quiet: boolean; at: string }) => void;
  remember: (input: { watch: WorkflowWatch; watchId: string; text: string }) => number | undefined;
}

export interface WatchRunResult {
  recorded: boolean;
  report: 'ok' | 'missing';
  newFindings: number;
  surfaced: number;
  learned: number;
}

/**
 * Record one finished watch run. Idempotent per run id: a replayed completion
 * records and raises nothing twice.
 */
export async function recordWatchRun(input: {
  workflowSlug: string;
  workflowName: string;
  watch: WorkflowWatch;
  runId: string;
  report: WatchReport | null;
}, deps: WatchRunDeps): Promise<WatchRunResult> {
  const nowMs = deps.now();
  const at = new Date(nowMs).toISOString();
  const state = loadWatchState(input.workflowSlug);
  if (state.runs.some((run) => run.runId === input.runId)) {
    return { recorded: false, report: 'ok', newFindings: 0, surfaced: 0, learned: 0 };
  }
  if (!input.report) {
    state.runs.push({ runId: input.runId, at, report: 'missing', findings: 0, surfaced: 0, learned: 0 });
    saveWatchState(input.workflowSlug, state, nowMs);
    return { recorded: true, report: 'missing', newFindings: 0, surfaced: 0, learned: 0 };
  }
  const watchId = watchIdFor(input.workflowSlug);
  const contract = deps.contract(watchId);
  const rules = contract.rules.map((rule) => rule.text);
  const seen = new Set(state.findings.map((finding) => finding.key));
  let newFindings = 0;
  let surfaced = 0;
  for (const finding of input.report.findings) {
    if (seen.has(finding.key)) continue;
    seen.add(finding.key);
    newFindings += 1;
    let raise = input.watch.purpose === 'tell_me';
    let heldBy: WatchFindingEntry['heldBy'];
    if (!raise) heldBy = 'learn_only';
    if (raise && rules.length > 0) {
      let verdict: { surface: boolean } | null = null;
      try { verdict = await deps.judge({ watch: input.watch, watchId, rules, finding }); } catch { verdict = null; }
      if (verdict && !verdict.surface) { raise = false; heldBy = 'rule'; }
    }
    if (raise) {
      try {
        deps.publish({
          watch: input.watch, watchId, workflowSlug: input.workflowSlug, workflowName: input.workflowName,
          runId: input.runId, finding, quiet: contract.notify !== 'push', at,
        });
        surfaced += 1;
      } catch (error) {
        logger.warn({ watchId, err: error instanceof Error ? error.message : String(error) }, 'watch finding could not be raised');
        raise = false;
      }
    }
    state.findings.push({ ...finding, at, runId: input.runId, surfaced: raise, ...(heldBy ? { heldBy } : {}) });
  }
  const known = new Set(state.learned.map((entry) => normalizedLearned(entry.text)));
  let learned = 0;
  for (const text of input.report.learned) {
    const normal = normalizedLearned(text);
    if (!normal || known.has(normal)) continue;
    known.add(normal);
    let factId: number | undefined;
    try { factId = deps.remember({ watch: input.watch, watchId, text }); } catch (error) {
      logger.warn({ watchId, err: error instanceof Error ? error.message : String(error) }, 'watch learning could not be remembered');
    }
    state.learned.push({ text, at, runId: input.runId, ...(factId !== undefined ? { factId } : {}) });
    learned += 1;
  }
  state.runs.push({ runId: input.runId, at, report: 'ok', findings: input.report.findings.length, surfaced, learned });
  saveWatchState(input.workflowSlug, state, nowMs);
  return { recorded: true, report: 'ok', newFindings, surfaced, learned };
}

/** The production wiring: the owner's rules by Jev, From Clem items, memory facts. */
export async function productionWatchRunDeps(): Promise<WatchRunDeps> {
  const [{ tryJevHeartbeatItemVerdict }, { addNotification }, { rememberFact }] = await Promise.all([
    import('../runtime/jev/control-plane.js'),
    import('../runtime/notifications.js'),
    import('../memory/facts.js'),
  ]);
  return {
    now: () => Date.now(),
    contract: (watchId) => loadHeartbeatContract(watchId),
    judge: ({ watch, watchId, rules, finding }) => tryJevHeartbeatItemVerdict({
      heartbeat: `${watch.source} watch`,
      rules,
      sessionId: watchId,
      item: { kind: 'finding', subject: finding.title, detail: finding.detail ?? '', ref: finding.link ?? '' },
    }),
    publish: ({ watch, watchId, workflowSlug, workflowName, runId, finding, quiet, at }) => addNotification({
      id: `watch-${workflowSlug}-${digest(finding.key)}`,
      kind: 'workflow',
      title: finding.title,
      body: [finding.detail ?? '', finding.link ?? ''].filter(Boolean).join('\n\n'),
      createdAt: at,
      read: false,
      silent: quiet,
      metadata: {
        watch: watchId,
        itemKey: finding.key,
        sourceTitle: watchSourceTitle(watch),
        workflow: workflowName,
        watchRunId: runId,
        ...(finding.link ? { link: finding.link } : {}),
      },
    }),
    remember: ({ watch, watchId, text }) => rememberFact({
      kind: 'reference',
      content: `From the ${watch.source} watch: ${text}`,
      derivedFrom: { tool: watchId },
      trustLevel: 0.6,
      importance: 4,
    }).id,
  };
}

export interface WatchView {
  slug: string;
  name: string;
  source: string;
  lookFor: string;
  purpose: WorkflowWatch['purpose'];
  enabled: boolean;
  schedule?: string;
  timezone?: string;
  onEvents: boolean;
  lastRun?: WatchRunEntry;
  findings: WatchFindingEntry[];
  learned: Array<Pick<WatchLearnedEntry, 'text' | 'at'>>;
  notify: HeartbeatContract['notify'];
  rules: Array<{ id: string; text: string }>;
  totals: { runs: number; findings: number; raised: number; learned: number };
}

const VIEW_ITEMS = 10;

/** Every watch the owner has, newest activity first, for "What Clem can see". */
export async function listWatchViews(): Promise<WatchView[]> {
  const { listWorkflows } = await import('../memory/workflow-store.js');
  const views: WatchView[] = [];
  for (const entry of listWorkflows()) {
    const watch = entry.data.watch;
    if (!watch || entry.data.origin === 'dev') continue;
    let state: WatchState;
    try { state = loadWatchState(entry.name); } catch { state = emptyState(); }
    const contract = loadHeartbeatContract(watchIdFor(entry.name));
    const trigger = entry.data.trigger ?? {};
    views.push({
      slug: entry.name,
      name: entry.data.name,
      source: watch.source,
      lookFor: watch.lookFor,
      purpose: watch.purpose,
      enabled: entry.data.enabled !== false,
      ...(typeof trigger.schedule === 'string' && trigger.schedule.trim() ? { schedule: trigger.schedule.trim() } : {}),
      ...(typeof trigger.timezone === 'string' && trigger.timezone.trim() ? { timezone: trigger.timezone.trim() } : {}),
      onEvents: Array.isArray(trigger.events) && trigger.events.length > 0,
      ...(state.runs.length ? { lastRun: state.runs[state.runs.length - 1] } : {}),
      findings: state.findings.slice(-VIEW_ITEMS).reverse(),
      learned: state.learned.slice(-VIEW_ITEMS).reverse().map(({ text, at }) => ({ text, at })),
      notify: contract.notify,
      rules: contract.rules.map((rule) => ({ id: rule.id, text: rule.text })),
      totals: {
        runs: state.runs.length,
        findings: state.findings.length,
        raised: state.findings.filter((finding) => finding.surfaced).length,
        learned: state.learned.length,
      },
    });
  }
  const lastActivity = (view: WatchView): number => Date.parse(view.lastRun?.at ?? '') || 0;
  return views.sort((a, b) => lastActivity(b) - lastActivity(a) || a.name.localeCompare(b.name));
}
