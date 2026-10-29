/**
 * Backup brains: the owner's ordered list of models that answer when the
 * chosen brain stops answering, and the outage record that moves every chat
 * onto the backups until the owner decides.
 *
 * Only models the owner lists are ever used for the brain. An empty list
 * means no switch: the chosen brain is tried every time and its failure is
 * the turn's outcome.
 *
 * Outage. Two no-answer failures of a brain (overload, 5xx, timeout, nothing
 * came) within ten minutes, while a backup is listed, open one outage for
 * that model. While it is recorded, brain requests skip it and go to the
 * backups in the owner's order; a background check asks the down model one
 * short question with back-off. When it answers, the outage is marked
 * recovered and the backups keep answering until the owner chooses: switch
 * back, or stay on the backup. One outage at a time; it survives a restart.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import pino from 'pino';
import { BASE_DIR, getRuntimeEnv } from '../../config.js';
import { updateEnvKey } from '../../tools/shared.js';
import { recordOperationalEvent } from '../operational-telemetry.js';
import { brainOptions, type BrainOption } from './model-role-options.js';
import { labelForModelId } from './model-discovery.js';

const logger = pino({ name: 'clementine.brain-backups' });

export const BRAIN_BACKUPS_ENV = 'CLEMMY_BRAIN_BACKUPS';
export const BRAIN_BACKUPS_MAX = 3;

/** Failure classes that mean the model did not answer. A pace wall, a
 *  rate limit, an auth failure and a caller's stop are not outages. */
const NO_ANSWER_REASONS = new Set([
  'model.overloaded',
  'model.http_5xx',
  'model.transport_timeout',
  'model.empty_completion',
  'first-content-timeout',
  'response-wall-exceeded',
  'host-stall-watchdog',
]);
const OUTAGE_THRESHOLD = 2;
const OUTAGE_WINDOW_MS = 10 * 60_000;
const PROBE_FIRST_MS = 2 * 60_000;
const PROBE_MAX_MS = 30 * 60_000;

export interface BrainOutageV1 {
  v: 1;
  id: string;
  /** The model that stopped answering. */
  downModelId: string;
  /** The first listed backup that could serve when the outage opened. */
  standInModelId: string;
  openedAt: number;
  /** The no-answer class of the failure that opened it. */
  reason: string;
  status: 'open' | 'recovered';
  recoveredAt?: number;
  probe: { attempts: number; nextAt: number; lastAt?: number; lastReason?: string };
}

export class BrainBackupsSettingError extends Error {
  constructor(public readonly code: 'INVALID_SETTING' | 'MODEL_UNAVAILABLE', message: string) {
    super(message);
    this.name = 'BrainBackupsSettingError';
  }
}

// ───────────────────────────── the list ─────────────────────────────

function parseList(raw: string): string[] {
  const text = raw.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const item of parsed) {
      const id = typeof item === 'string' ? item.trim() : '';
      if (id && !out.includes(id)) out.push(id);
      if (out.length >= BRAIN_BACKUPS_MAX) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** The owner's backup brains, in order. */
export function readBrainBackups(): string[] {
  return parseList(getRuntimeEnv(BRAIN_BACKUPS_ENV, '') || '');
}

export function brainBackupsConfigured(): boolean {
  return readBrainBackups().length > 0;
}

let optionsForTest: (() => BrainOption[]) | null = null;
function currentBrainOptions(): BrainOption[] {
  return (optionsForTest ?? brainOptions)();
}

function availableBrainModelIds(): Set<string> {
  const ids = new Set<string>();
  try {
    for (const option of currentBrainOptions()) {
      if (option.available && option.modelId) ids.add(option.modelId);
    }
  } catch { /* an unreadable catalog serves no backup */ }
  return ids;
}

/** A model as the picker names it, without its provider prefix. A picker
 *  entry that only repeats the raw model id reads as the model's name. */
export function brainModelLabel(modelId: string): string {
  try {
    const option = currentBrainOptions().find((o) => o.modelId === modelId);
    const named = option?.label ? option.label.replace(/^[^—]+—\s*/, '').trim() : '';
    if (named && named !== modelId) return named;
  } catch { /* the id is named from itself */ }
  return labelForModelId(modelId);
}

/** The listed backups that can serve now, in order, without `exceptModelId`. */
export function brainBackupModelIds(exceptModelId?: string): string[] {
  const listed = readBrainBackups();
  if (listed.length === 0) return [];
  const available = availableBrainModelIds();
  return listed.filter((id) => id !== exceptModelId && available.has(id));
}

export interface BrainBackupsSnapshot {
  modelIds: string[];
  /** Listed models no connected account serves right now. */
  unavailable: string[];
  outage: BrainOutageV1 | null;
}

export function brainBackupsSnapshot(): BrainBackupsSnapshot {
  const modelIds = readBrainBackups();
  let options: BrainOption[] = [];
  try { options = currentBrainOptions(); } catch { options = []; }
  const available = new Set(options.filter((o) => o.available && o.modelId).map((o) => o.modelId as string));
  return {
    modelIds,
    unavailable: modelIds.filter((id) => !available.has(id)),
    outage: currentBrainOutage(),
  };
}

/** Desktop and mobile share one validated, restart-safe list. An empty list
 *  turns backups off. */
export function persistBrainBackups(value: unknown): BrainBackupsSnapshot {
  const raw = (value && typeof value === 'object' && !Array.isArray(value))
    ? (value as { modelIds?: unknown }).modelIds
    : value;
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
    throw new BrainBackupsSettingError('INVALID_SETTING', 'Send modelIds as a list of model ids, in the order to try them.');
  }
  const list = parseList(JSON.stringify(raw));
  if (raw.filter((item) => String(item).trim()).length > BRAIN_BACKUPS_MAX) {
    throw new BrainBackupsSettingError('INVALID_SETTING', `List at most ${BRAIN_BACKUPS_MAX} backup brains.`);
  }
  const available = availableBrainModelIds();
  const missing = list.filter((id) => !available.has(id));
  if (missing.length > 0) {
    throw new BrainBackupsSettingError('MODEL_UNAVAILABLE',
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not a model a connected account serves. Connect it under Settings → Models first.`);
  }
  updateEnvKey(BRAIN_BACKUPS_ENV, JSON.stringify(list));
  // A list without the stand-in cannot carry an outage on.
  const outage = currentBrainOutage();
  if (outage && brainBackupModelIds(outage.downModelId).length === 0) closeBrainOutage('backups_removed');
  return brainBackupsSnapshot();
}

// ───────────────────────────── the outage ─────────────────────────────

const OUTAGE_FILE = path.join(BASE_DIR, 'state', 'brain-outage.json');
let outageFile = OUTAGE_FILE;
let outage: BrainOutageV1 | null = null;
let outageLoaded = false;
const failures = new Map<string, { count: number; firstAt: number; reason: string }>();

export type BrainOutageChange =
  | { kind: 'opened'; outage: BrainOutageV1 }
  | { kind: 'recovered'; outage: BrainOutageV1 }
  | { kind: 'closed'; outage: BrainOutageV1; why: string };
const listeners = new Set<(change: BrainOutageChange) => void>();

/** Home and Settings follow the outage through one listener each. */
export function onBrainOutageChange(listener: (change: BrainOutageChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function emit(change: BrainOutageChange): void {
  for (const listener of listeners) {
    try { listener(change); } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'brain outage listener failed');
    }
  }
}

function validOutage(value: unknown): value is BrainOutageV1 {
  const o = value as Partial<BrainOutageV1> | null;
  return !!o && o.v === 1 && typeof o.id === 'string' && typeof o.downModelId === 'string'
    && typeof o.standInModelId === 'string' && typeof o.openedAt === 'number' && typeof o.reason === 'string'
    && (o.status === 'open' || o.status === 'recovered')
    && !!o.probe && typeof o.probe.attempts === 'number' && typeof o.probe.nextAt === 'number';
}

function loadOutage(): void {
  if (outageLoaded) return;
  outageLoaded = true;
  if (!existsSync(outageFile)) return;
  try {
    const parsed = JSON.parse(readFileSync(outageFile, 'utf-8')) as unknown;
    outage = validOutage(parsed) ? parsed : null;
    if (!outage) rmSync(outageFile, { force: true });
  } catch {
    outage = null;
    try { rmSync(outageFile, { force: true }); } catch { /* ignore */ }
  }
}

function persistOutage(): void {
  try {
    if (!outage) {
      rmSync(outageFile, { force: true });
      return;
    }
    mkdirSync(path.dirname(outageFile), { recursive: true });
    writeFileSync(outageFile, JSON.stringify(outage, null, 2), { encoding: 'utf-8', mode: 0o600 });
    try { chmodSync(outageFile, 0o600); } catch { /* best-effort */ }
  } catch { /* the in-memory record still routes this process */ }
}

export function currentBrainOutage(): BrainOutageV1 | null {
  loadOutage();
  return outage ? { ...outage, probe: { ...outage.probe } } : null;
}

/** True while brain requests for this model go to the backups instead. */
export function brainOutageSkips(modelId: string): boolean {
  loadOutage();
  return !!outage && outage.downModelId === modelId && brainBackupModelIds(modelId).length > 0;
}

/** A brain attempt failed. `reason` is the chain's failure class. */
export function noteBrainNoAnswer(modelId: string, reason: string, correlation: { sessionId?: string } = {}): void {
  if (!NO_ANSWER_REASONS.has(reason)) return;
  loadOutage();
  if (outage) return; // one outage at a time; the open one is already routing
  const now = Date.now();
  const prior = failures.get(modelId);
  const inWindow = prior ? now - prior.firstAt <= OUTAGE_WINDOW_MS : false;
  const entry = { count: inWindow && prior ? prior.count + 1 : 1, firstAt: inWindow && prior ? prior.firstAt : now, reason };
  failures.set(modelId, entry);
  if (entry.count < OUTAGE_THRESHOLD) return;
  const standIn = brainBackupModelIds(modelId)[0];
  if (!standIn) return;
  failures.delete(modelId);
  outage = {
    v: 1,
    id: `bo_${now.toString(36)}${randomBytes(3).toString('hex')}`,
    downModelId: modelId,
    standInModelId: standIn,
    openedAt: now,
    reason,
    status: 'open',
    probe: { attempts: 0, nextAt: now + PROBE_FIRST_MS },
  };
  persistOutage();
  logger.warn({ down: modelId, standIn, reason }, 'brain stopped answering — backups serve until it answers again');
  recordOperationalEvent({
    source: 'model', type: 'brain_outage_opened', severity: 'warn', actor: 'brain-backups',
    sessionId: correlation.sessionId,
    payload: { outageId: outage.id, down: modelId, standIn, reason, failures: entry.count },
  });
  emit({ kind: 'opened', outage: currentBrainOutage() as BrainOutageV1 });
  scheduleProbe();
}

/** A brain attempt answered: its failure count starts over. */
export function noteBrainAnswered(modelId: string): void {
  failures.delete(modelId);
}

/** End the outage. `switch_back` and `stay` are the owner's answers; the
 *  caller that honors `stay` moves the active brain first. */
export function closeBrainOutage(why: 'switch_back' | 'stay' | 'backups_removed' | 'brain_changed'): BrainOutageV1 | null {
  loadOutage();
  if (!outage) return null;
  const closed = currentBrainOutage() as BrainOutageV1;
  outage = null;
  persistOutage();
  stopProbe();
  recordOperationalEvent({
    source: 'model', type: 'brain_outage_closed', severity: 'info', actor: 'brain-backups',
    payload: { outageId: closed.id, down: closed.downModelId, standIn: closed.standInModelId, why },
  });
  emit({ kind: 'closed', outage: closed, why });
  return closed;
}

// ───────────────────────────── the check ─────────────────────────────

/** One short question to exactly this model, no backups: resolves when it
 *  answers, throws with the failure otherwise. The router's by default. */
export type BrainProber = (modelId: string) => Promise<void>;
let prober: BrainProber | null = null;

async function activeProber(): Promise<BrainProber> {
  return prober ?? (await import('./router-model.js')).probeBrainModel;
}
let probeTimer: ReturnType<typeof setTimeout> | null = null;
let probing = false;

export function setBrainOutageProber(fn: BrainProber | null): void {
  prober = fn;
}

function stopProbe(): void {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = null;
}

function probesDisabled(): boolean {
  return process.env.NODE_ENV === 'test' && !probeTimersForTest;
}
let probeTimersForTest = false;

/** Keep the check running while an outage is open (after a restart too). */
export function scheduleProbe(): void {
  loadOutage();
  if (!outage || outage.status !== 'open' || probeTimer || probing || probesDisabled()) return;
  const delay = Math.max(1_000, outage.probe.nextAt - Date.now());
  probeTimer = setTimeout(() => { probeTimer = null; void runBrainOutageProbe(); }, delay);
  probeTimer.unref?.();
}

/** Ask the down model once. Exported for the scheduler and for tests. */
export async function runBrainOutageProbe(): Promise<'recovered' | 'still_down' | 'idle'> {
  loadOutage();
  if (!outage || outage.status !== 'open' || probing) return 'idle';
  probing = true;
  const target = outage.downModelId;
  const id = outage.id;
  let answered = false;
  let reason: string | undefined;
  try {
    await (await activeProber())(target);
    answered = true;
  } catch (err) {
    reason = (err instanceof Error ? err.message : String(err)).slice(0, 200);
  } finally {
    probing = false;
  }
  if (!outage || outage.id !== id) return 'idle';
  const now = Date.now();
  const attempts = outage.probe.attempts + 1;
  if (answered) {
    outage = { ...outage, status: 'recovered', recoveredAt: now, probe: { attempts, nextAt: 0, lastAt: now } };
    persistOutage();
    logger.info({ model: target }, 'brain answers again — waiting for the owner to switch back or stay');
    recordOperationalEvent({
      source: 'model', type: 'brain_outage_recovered', severity: 'info', actor: 'brain-backups',
      payload: { outageId: id, down: target, standIn: outage.standInModelId, attempts, downForMs: now - outage.openedAt },
    });
    emit({ kind: 'recovered', outage: currentBrainOutage() as BrainOutageV1 });
    return 'recovered';
  }
  const backoff = Math.min(PROBE_MAX_MS, PROBE_FIRST_MS * 2 ** Math.min(attempts, 4));
  outage = { ...outage, probe: { attempts, nextAt: now + backoff, lastAt: now, ...(reason ? { lastReason: reason } : {}) } };
  persistOutage();
  scheduleProbe();
  return 'still_down';
}

export const __brainBackupsTest__ = {
  reset(file?: string): void {
    stopProbe();
    outageFile = file ?? OUTAGE_FILE;
    outage = null;
    outageLoaded = false;
    failures.clear();
    listeners.clear();
    prober = null;
    probing = false;
    optionsForTest = null;
    probeTimersForTest = false;
  },
  setOptions(fn: (() => BrainOption[]) | null): void {
    optionsForTest = fn;
  },
};
