/**
 * A learned calendar read.
 *
 * The calendar watch reads "what is on the calendar in this window" from
 * whatever calendar the owner connected. No operation is named here: for
 * each connected provider, a model reads the provider's own current
 * definitions once and writes down a recipe — which operation lists events
 * in a time window, which arguments carry the window, and where in one
 * returned event the id, title, times, status and response live. The recipe
 * is remembered against the definition it was read from (its fingerprint is
 * the receipt) and is derived again when that definition changes. Everything
 * the watch then does with the recipe is deterministic.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BASE_DIR } from '../tools/shared.js';
import { wallClockToUtcMs, type CalEvent } from './calendar-watch.js';

export const CALENDAR_READ_RECIPE_VERSION = 1 as const;

/** A dot path into one returned event (`start.dateTime`). */
const pathString = z.string().min(1).max(200);
// Structured output wants every property present: absent means null, never
// undefined, so each optional part of a recipe is nullable.
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const flagRule = z.object({ path: pathString, equals: scalar.nullable() });

export const CalendarReadRecipeV1Schema = z.object({
  version: z.literal(CALENDAR_READ_RECIPE_VERSION),
  /** The operation id exactly as the provider's definition spells it. */
  operationId: z.string().min(1),
  window: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
    limit: z.string().min(1).nullable(),
    timezone: z.string().min(1).nullable(),
    /** Arguments the read always sends (expand recurrences, order by start). */
    fixed: z.array(z.object({ name: z.string().min(1), value: scalar })).nullable(),
  }),
  fields: z.object({
    id: pathString,
    title: pathString,
    start: pathString,
    end: pathString,
    allDay: flagRule.nullable(),
    cancelled: flagRule.nullable(),
    showAs: z.object({ path: pathString, free: z.array(scalar).nullable(), tentative: z.array(scalar).nullable() }).nullable(),
    /** The owner's own response: a path on the event, or found on the
     * attendee flagged as the owner. */
    myResponse: pathString.nullable(),
    myResponseFromAttendee: z.object({ self: pathString, response: pathString }).nullable(),
    attendees: pathString.nullable(),
    organizer: z.array(pathString).max(4).nullable(),
    location: z.array(pathString).max(4).nullable(),
  }),
});
export type CalendarReadRecipeV1 = z.infer<typeof CalendarReadRecipeV1Schema>;

export interface LearnedCalendarRead {
  recipe: CalendarReadRecipeV1;
  /** The connected provider the read belongs to, as the connection names it. */
  toolkit: string;
  /** The definition the recipe was read from. A different fingerprint means
   * the recipe is no longer evidence and is derived again. */
  definitionFingerprint: string;
  basis: { learnedAt: string; modelIdentity: string; fromSample?: boolean };
}

// ── deterministic use of a recipe ─────────────────────────────────────────────
function at(value: unknown, dotPath: string): unknown {
  let cur: unknown = value;
  for (const key of dotPath.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Providers return a time three ways: an ISO string, a wall-clock string
 * with a zone label beside it, or a date alone (all day). Each is read as
 * what it is; a wall clock with no usable label is read in the zone the read
 * asked for, unless the provider labelled it UTC or left the label out. */
function timeOf(value: unknown, requestedZone: string): { ms: number; allDay: boolean } {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const dateTime = str(record.dateTime);
    if (dateTime) return { ms: wallClockOrInstant(dateTime, zoneLabel(str(record.timeZone), requestedZone)), allDay: false };
    const date = str(record.date);
    if (date) return { ms: Date.parse(`${date}T00:00:00Z`), allDay: true };
    return { ms: Number.NaN, allDay: false };
  }
  const text = str(value);
  if (!text) return { ms: Number.NaN, allDay: false };
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return { ms: Date.parse(`${text}T00:00:00Z`), allDay: true };
  return { ms: wallClockOrInstant(text, requestedZone), allDay: false };
}
function wallClockOrInstant(text: string, zone: string): number {
  // An instant carries its own offset; a wall clock does not.
  if (/(?:z|[+-]\d{2}:?\d{2})$/i.test(text)) return Date.parse(text);
  return wallClockToUtcMs(text, zone);
}
function zoneLabel(label: string, requested: string): string {
  const trimmed = label.trim();
  if (!trimmed) return 'UTC';
  if (trimmed.toUpperCase() === 'UTC') return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return trimmed;
  } catch {
    return requested;
  }
}
function flag(event: unknown, rule: { path: string; equals?: unknown } | null | undefined): boolean {
  if (!rule) return false;
  const value = at(event, rule.path);
  return rule.equals === undefined || rule.equals === null ? value === true : value === rule.equals;
}
function firstString(event: unknown, paths: readonly string[] | null | undefined): string {
  for (const p of paths ?? []) {
    const value = str(at(event, p));
    if (value) return value;
  }
  return '';
}

/** Where providers put the list: a common set of envelope keys, or the
 * payload itself when it is already the list. Not provider-specific. */
export function locateEventList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  for (const key of ['data', 'response_data', 'result']) {
    const inner = record[key];
    if (Array.isArray(inner)) return inner;
    if (inner && typeof inner === 'object') {
      const found = locateEventList(inner);
      if (found.length > 0) return found;
    }
  }
  for (const key of ['value', 'items', 'events', 'records', 'results']) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

export function recipeArgs(recipe: CalendarReadRecipeV1, window: { startIso: string; endIso: string; top: number; timezone: string }): Record<string, unknown> {
  const w = recipe.window;
  return {
    ...Object.fromEntries((w.fixed ?? []).map((entry) => [entry.name, entry.value])),
    [w.start]: window.startIso,
    [w.end]: window.endIso,
    ...(w.limit ? { [w.limit]: window.top } : {}),
    ...(w.timezone ? { [w.timezone]: window.timezone } : {}),
  };
}

export function recipeParse(recipe: CalendarReadRecipeV1, payload: unknown, context: { timezone: string }): CalEvent[] {
  const f = recipe.fields;
  return locateEventList(payload).map((e): CalEvent => {
    const start = timeOf(at(e, f.start), context.timezone);
    const end = timeOf(at(e, f.end), context.timezone);
    const title = str(at(e, f.title));
    const attendees = asArray(f.attendees ? at(e, f.attendees) : undefined);
    const self = f.myResponseFromAttendee
      ? attendees.find((a) => at(a, f.myResponseFromAttendee!.self) === true)
      : undefined;
    const showAsRaw = f.showAs ? at(e, f.showAs.path) : undefined;
    const showAs = !f.showAs ? ''
      : (f.showAs.free ?? []).some((v) => v === showAsRaw) ? 'free'
      : (f.showAs.tentative ?? []).some((v) => v === showAsRaw) ? 'tentative'
      : str(showAsRaw) || 'busy';
    const organizer = firstString(e, f.organizer);
    const location = firstString(e, f.location);
    return {
      id: str(at(e, f.id)),
      subject: title || '(no title)',
      startMs: start.ms,
      endMs: end.ms,
      isAllDay: start.allDay || flag(e, f.allDay),
      isCancelled: flag(e, f.cancelled) || /^cancell?ed:/i.test(title),
      showAs,
      myResponse: f.myResponse ? str(at(e, f.myResponse)) : self ? str(at(self, f.myResponseFromAttendee!.response)) : '',
      attendeeCount: attendees.length,
      ...(organizer ? { organizer } : {}),
      ...(location ? { location } : {}),
    };
  }).filter((e) => e.id && Number.isFinite(e.startMs));
}

/** A recipe is usable evidence only when it reads events out of what the
 * provider actually returned. An empty window proves nothing either way. */
export function recipeReadsPayload(recipe: CalendarReadRecipeV1, payload: unknown, timezone: string): 'reads' | 'misses' | 'empty' {
  const list = locateEventList(payload);
  if (list.length === 0) return 'empty';
  return recipeParse(recipe, payload, { timezone }).length > 0 ? 'reads' : 'misses';
}

// ── the store: one recipe per operation, receipted by its definition ─────────
const FILE = path.join(BASE_DIR, 'state', 'calendar-read-recipes.json');
interface RecipeFileV1 { version: 1; reads: Record<string, LearnedCalendarRead> }

function readFile(): RecipeFileV1 {
  try {
    if (!existsSync(FILE)) return { version: 1, reads: {} };
    const raw = JSON.parse(readFileSync(FILE, 'utf-8')) as Partial<RecipeFileV1>;
    if (raw.version !== 1 || !raw.reads || typeof raw.reads !== 'object') return { version: 1, reads: {} };
    const reads: Record<string, LearnedCalendarRead> = {};
    for (const [key, value] of Object.entries(raw.reads)) {
      const parsed = CalendarReadRecipeV1Schema.safeParse((value as LearnedCalendarRead | undefined)?.recipe);
      const row = value as LearnedCalendarRead;
      if (!parsed.success || typeof row.definitionFingerprint !== 'string' || typeof row.toolkit !== 'string') continue;
      reads[key] = { recipe: parsed.data, toolkit: row.toolkit, definitionFingerprint: row.definitionFingerprint, basis: row.basis };
    }
    return { version: 1, reads };
  } catch {
    return { version: 1, reads: {} };
  }
}
function writeFile(file: RecipeFileV1): void {
  mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2));
  renameSync(tmp, FILE);
}

export function learnedCalendarRead(operationId: string, definitionFingerprint: string): LearnedCalendarRead | null {
  const row = readFile().reads[operationId.trim().toLowerCase()];
  return row && row.definitionFingerprint === definitionFingerprint ? row : null;
}
export function listLearnedCalendarReads(): LearnedCalendarRead[] {
  return Object.values(readFile().reads);
}
export function rememberCalendarRead(row: LearnedCalendarRead): void {
  const file = readFile();
  file.reads[row.recipe.operationId.trim().toLowerCase()] = row;
  writeFile(file);
}
export function forgetCalendarRead(operationId: string): boolean {
  const file = readFile();
  const key = operationId.trim().toLowerCase();
  if (!file.reads[key]) return false;
  delete file.reads[key];
  writeFile(file);
  return true;
}
