/** Attention preferences for exact questions. Hiding a question is never an
 * answer, permission, cancellation or continuation of its paused work. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../tools/shared.js';
import { listInboxQuestions, type InboxQuestionItem } from '../execution/inbox-questions.js';

const FILE = path.join(BASE_DIR, 'state', 'question-presentation.json');
interface Entry { fingerprint: string; action: 'dismiss' | 'defer' | 'restore'; mutationToken?: string; until?: string }
type Entries = Record<string, Entry>;
const logger = pino({ name: 'clementine.question-presentation' });
let warnedUnavailable = false;

function validEntries(value: unknown): value is Entries {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const row = entry as Partial<Entry>;
    return typeof row.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(row.fingerprint)
      && (row.action === 'dismiss' || row.action === 'defer' || row.action === 'restore')
      && (row.mutationToken === undefined || (typeof row.mutationToken === 'string' && row.mutationToken.length > 0))
      && (row.until === undefined || (typeof row.until === 'string' && Number.isFinite(Date.parse(row.until))))
      && (row.action !== 'defer' || row.until !== undefined);
  });
}

function load(requireValidPreferences = false): Entries {
  try {
    const stored: unknown = JSON.parse(readFileSync(FILE, 'utf8'));
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)
      || (stored as { version?: unknown }).version !== 1
      || !validEntries((stored as { entries?: unknown }).entries)) {
      throw new Error('Invalid question preferences.');
    }
    warnedUnavailable = false;
    return (stored as { entries: Entries }).entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      warnedUnavailable = false;
      return {};
    }
    // Preferences must never take the questions down with them. Keep damaged
    // bytes intact and show every question until their owner repairs the file.
    if (!warnedUnavailable) {
      logger.warn('Saved question attention settings are unavailable; all pending questions remain visible and preference changes are disabled.');
      warnedUnavailable = true;
    }
    if (requireValidPreferences) throw new Error('Saved question settings are unavailable. Your questions remain visible; no attention settings were changed.');
    return {};
  }
}
function fingerprint(row: InboxQuestionItem): string {
  return createHash('sha256').update(JSON.stringify([row.id, row.askedAt, row.question])).digest('hex');
}
function entryToken(entry: Entry): string {
  // Earlier preview entries had no token. Their exact persisted bytes provide
  // a deterministic fence without mutating the preference during a list read.
  return entry.mutationToken ?? `legacy-${createHash('sha256').update(JSON.stringify([
    entry.fingerprint, entry.action, entry.until ?? null,
  ])).digest('hex')}`;
}
export function questionHidden(row: InboxQuestionItem, nowMs = Date.now(), entries = load()): boolean {
  const entry = entries[row.id];
  return entry?.fingerprint === fingerprint(row)
    && (entry.action === 'dismiss' || (entry.action === 'defer' && Date.parse(entry.until ?? '') > nowMs));
}
export function visibleInboxQuestions(rows = listInboxQuestions(), nowMs = Date.now()): InboxQuestionItem[] {
  const entries = load();
  return rows.filter((row) => !questionHidden(row, nowMs, entries));
}
export function projectInboxQuestion(row: InboxQuestionItem) {
  return { ...row, attentionKey: row.id, lifecycle: {
    canDismiss: true, canDefer: true, dismissLabel: 'Dismiss', deferLabel: 'Tomorrow', effect: 'hide_only',
    generation: fingerprint(row),
    explanation: 'This only clears the question from your attention list. The work stays paused.',
  } as const };
}
export type QuestionPresentationItem = ReturnType<typeof projectInboxQuestion> & {
  action: 'dismiss' | 'defer'; generation: string; mutationToken: string; until?: string;
};

/** Recoverable attention preferences, joined to the owning live question.
 * Never returns answered/stale generations or expired deferrals. */
export function listQuestionPresentations(nowMs = Date.now()): QuestionPresentationItem[] {
  // Unlike the active question list, recovery cannot claim there are no saved
  // preferences when the saved record is unavailable. Its surface can retry.
  const entries = load(true);
  return listInboxQuestions().flatMap((row): QuestionPresentationItem[] => {
    const entry = entries[row.id];
    if (!entry || !questionHidden(row, nowMs, entries) || (entry.action !== 'dismiss' && entry.action !== 'defer')) return [];
    return [{ ...projectInboxQuestion(row), action: entry.action, generation: fingerprint(row), mutationToken: entryToken(entry),
      ...(entry.action === 'defer' && entry.until ? { until: entry.until } : {}) }];
  });
}
export function presentInboxQuestion(id: string, action: 'dismiss' | 'defer' | 'restore', nowMs = Date.now(), generation?: string, mutationToken?: string) {
  const row = listInboxQuestions().find((question) => question.id === id);
  if (!row) return { ok: false as const, id, action, error: 'This question is no longer pending.' };
  const currentGeneration = fingerprint(row);
  if ((action === 'restore' && !generation) || (generation && generation !== currentGeneration)) {
    return { ok: false as const, id, action, error: 'This question has changed. Refresh before changing its attention setting.' };
  }
  const entries = load(true);
  const previous = entries[id];
  if (action === 'restore' && (!mutationToken || !previous || entryToken(previous) !== mutationToken || previous.fingerprint !== currentGeneration)) {
    return { ok: false as const, id, action, error: 'The attention setting changed after this action. Refresh before changing it again.' };
  }
  const tomorrow = new Date(nowMs);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);
  const until = action === 'defer' ? tomorrow.toISOString() : undefined;
  // Retain only preferences for exact pending generations, keeping this file bounded.
  const live = new Set(listInboxQuestions().map((question) => question.id));
  for (const key of Object.keys(entries)) if (!live.has(key)) delete entries[key];
  const nextToken = action === 'restore' ? mutationToken! : randomUUID();
  // A visible restore tombstone retains the token for idempotent Undo replay.
  // Any newer dismissal/defer gets a fresh token and fences older receipts.
  entries[id] = { fingerprint: currentGeneration, action, mutationToken: nextToken, ...(until ? { until } : {}) };
  mkdirSync(path.dirname(FILE), { recursive: true });
  const temporary = `${FILE}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, entries }, null, 2));
  renameSync(temporary, FILE);
  return { ok: true as const, id, action, generation: currentGeneration, mutationToken: nextToken, ...(until ? { until } : {}) };
}
