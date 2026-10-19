/** Calendar observations are context for a suggestion, never consent or tool
 * authority. No reads, models, timers, or execution occur in this module. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CalEvent, CalendarWatchState } from './calendar-watch.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';

const id = z.string().min(1).max(512);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.string().refine(value => Number.isFinite(Date.parse(value)));
export const MEETING_PREPARATION_MIN_LEAD_MS = 10 * 60_000;
export const MEETING_PREPARATION_MAX_LEAD_MS = 24 * 60 * 60_000;
export const MEETING_PREPARATION_MAX_OBSERVATION_AGE_MS = 20 * 60_000;
export const meetingPreparationMaxObservationAgeMs = (cadenceMinutes: number): number =>
  Number.isFinite(cadenceMinutes) && cadenceMinutes > 0 ? Math.min((2 * cadenceMinutes + 5) * 60_000, 90 * 60_000) : 0;
const MAX_CANDIDATES = 12;

export const CalendarPreparationReadSchema = z.object({
  version: z.literal(1), operationId: id, accountId: id, tickId: id,
  observedAt: time, windowStartMs: z.number().finite(), windowEndMs: z.number().finite(),
  activationId: id, authorityRootId: id, invocationPlanDigest: hash,
  bindingSnapshotDigest: hash, definitionFingerprint: id,
  resultRef: id, resultKind: z.enum(['single_read', 'paginated_read']),
}).strict();
export type CalendarPreparationRead = z.infer<typeof CalendarPreparationReadSchema>;
export const CalendarPreparationSnapshotSchema = CalendarPreparationReadSchema.extend({ eventsDigest: hash }).strict();
export type CalendarPreparationSnapshot = z.infer<typeof CalendarPreparationSnapshotSchema>;

const eventSchema = z.object({
  id, subject: z.string().max(2000), startMs: z.number().finite(), endMs: z.number().finite(),
  isAllDay: z.boolean(), isCancelled: z.boolean(), showAs: z.string().max(200),
  myResponse: z.string().max(200), attendeeCount: z.number().int().nonnegative(),
  organizer: z.string().max(2000).optional(), location: z.string().max(2000).optional(),
}).strict();

export const MeetingPreparationBindingSchema = z.object({ candidateId: hash, revision: hash }).strict();
export type MeetingPreparationBinding = z.infer<typeof MeetingPreparationBindingSchema>;
export const MeetingPreparationCandidateSchema = MeetingPreparationBindingSchema.extend({
  version: z.literal(1), operationId: id, accountId: id,
  event: eventSchema, observation: CalendarPreparationSnapshotSchema,
}).strict();
export type MeetingPreparationCandidate = z.infer<typeof MeetingPreparationCandidateSchema>;
export type MeetingPreparationOpportunity = Pick<MeetingPreparationCandidate, 'candidateId' | 'revision' | 'operationId' | 'accountId' | 'event'>;
export const meetingPreparationOpportunity = ({ candidateId, revision, operationId, accountId, event }: MeetingPreparationCandidate): MeetingPreparationOpportunity =>
  ({ candidateId, revision, operationId, accountId, event });

const digest = (domain: string, value: unknown): string => createHash('sha256')
  .update(closedCanonicalJson({ version: 1, domain, value })).digest('hex');
export const calendarPreparationConnectionKey = (operationId: string, accountId: string, definitionFingerprint: string): string =>
  JSON.stringify([operationId, accountId, definitionFingerprint]);

export function calendarPreparationEventsDigest(events: Record<string, CalEvent>): string {
  return digest('meeting-preparation-events', events);
}

/** A new read of unchanged event data does not rename its observed revision.
 * No provider ETag or recurring-series identity is invented here. */
export function meetingPreparationIdentity(operationId: string, accountId: string, event: CalEvent,
  definitionFingerprint: string): MeetingPreparationBinding {
  return {
    candidateId: digest('meeting-preparation-occurrence', [operationId, accountId, event.id, event.startMs]),
    revision: digest('meeting-preparation-observed-revision', { operationId, accountId, definitionFingerprint, event }),
  };
}

/** Legacy/global snapshotAt is deliberately irrelevant. Each account needs a
 * recent successful read, its own exact operation/account and event digest. */
export function projectMeetingPreparationCandidates(input: {
  state: Pick<CalendarWatchState, 'snapshot' | 'snapshotEvidence'>;
  enabled: boolean; now: number; connected: ReadonlySet<string>; maxObservationAgeMs?: number; phase?: 'offer' | 'answer';
}): MeetingPreparationCandidate[] {
  if (!input.enabled || !Number.isFinite(input.now)) return [];
  const maxAge = input.maxObservationAgeMs ?? MEETING_PREPARATION_MAX_OBSERVATION_AGE_MS;
  if (!Number.isFinite(maxAge) || maxAge <= 0 || maxAge > 90 * 60_000) return [];
  const candidates: MeetingPreparationCandidate[] = [];
  for (const [accountId, raw] of Object.entries(input.state.snapshotEvidence ?? {})) {
    const parsed = CalendarPreparationSnapshotSchema.safeParse(raw);
    if (!parsed.success) continue;
    const observation = parsed.data;
    const observed = Date.parse(observation.observedAt);
    if (observation.accountId !== accountId || observed > input.now
      || input.now - observed > maxAge
      || observation.windowEndMs <= observation.windowStartMs
      || !input.connected.has(calendarPreparationConnectionKey(observation.operationId, accountId, observation.definitionFingerprint))) continue;
    const events = input.state.snapshot[accountId];
    if (!events || typeof events !== 'object' || Array.isArray(events)) continue;
    let eventsDigest: string;
    try { eventsDigest = calendarPreparationEventsDigest(events); } catch { continue; }
    if (eventsDigest !== observation.eventsDigest) continue;
    for (const [eventId, value] of Object.entries(events)) {
      const parsedEvent = eventSchema.safeParse(value);
      if (!parsedEvent.success || parsedEvent.data.id !== eventId) continue;
      const event = parsedEvent.data;
      const lead = event.startMs - input.now;
      if (event.isCancelled || event.isAllDay || event.endMs <= event.startMs
        || (input.phase === 'answer' ? lead <= 0 : lead < MEETING_PREPARATION_MIN_LEAD_MS)
        || lead > MEETING_PREPARATION_MAX_LEAD_MS || event.startMs < observation.windowStartMs
        || event.endMs > observation.windowEndMs || event.myResponse.toLowerCase() === 'declined'
        || event.showAs.toLowerCase() === 'free') continue;
      candidates.push({ version: 1, operationId: observation.operationId, accountId, event, observation,
        ...meetingPreparationIdentity(observation.operationId, accountId, event, observation.definitionFingerprint) });
    }
  }
  return candidates.sort((a, b) => a.event.startMs - b.event.startMs || a.candidateId.localeCompare(b.candidateId)).slice(0, MAX_CANDIDATES);
}

/** Exact lookup only; titles, clocks and a later calendar observation never
 * substitute for an origin whose event/revision has changed. */
export function resolveMeetingPreparation<T extends MeetingPreparationBinding>(binding: unknown, candidates: readonly T[]): T | null {
  const parsed = MeetingPreparationBindingSchema.safeParse(binding);
  if (!parsed.success) return null;
  return candidates.find(candidate => candidate.candidateId === parsed.data.candidateId && candidate.revision === parsed.data.revision) ?? null;
}

export function validMeetingPreparationOrigin(origin: unknown, binding: unknown): boolean {
  const parsed = MeetingPreparationCandidateSchema.safeParse(origin);
  const selected = MeetingPreparationBindingSchema.safeParse(binding);
  if (!parsed.success || !selected.success) return false;
  const row = parsed.data;
  const expected = meetingPreparationIdentity(row.operationId, row.accountId, row.event, row.observation.definitionFingerprint);
  return row.candidateId === selected.data.candidateId && row.revision === selected.data.revision
    && expected.candidateId === row.candidateId && expected.revision === row.revision
    && row.observation.accountId === row.accountId && row.observation.operationId === row.operationId;
}

export interface MeetingPreparationReadiness {
  state: 'ready' | 'calendar_needed' | 'watch_off' | 'suggestions_off' | 'waiting_for_calendar' | 'unavailable';
  message: string;
}
export function projectMeetingPreparationReadiness(input: {
  optedIn: boolean; noticingEnabled: boolean; quietHours: boolean; watchEnabled: boolean;
  connection: 'unknown' | 'none' | 'present'; calendarReadKnown: boolean; candidates: number;
}): MeetingPreparationReadiness {
  if (!input.optedIn) return { state: 'suggestions_off', message: 'Meeting preparation suggestions are off.' };
  if (!input.noticingEnabled) return { state: 'suggestions_off', message: 'Turn on Clem’s suggestions in Settings to receive meeting preparation offers.' };
  if (input.quietHours) return { state: 'suggestions_off', message: 'Meeting preparation suggestions wait during your quiet hours.' };
  if (!input.watchEnabled) return { state: 'watch_off', message: 'Turn on Calendar watch in Settings so Clem can notice upcoming meetings.' };
  if (input.connection === 'none') return { state: 'calendar_needed', message: 'Connect a calendar so Clem can offer to help you prepare.' };
  if (input.connection === 'unknown' || !input.calendarReadKnown) return { state: 'waiting_for_calendar', message: 'Waiting for Calendar watch to confirm a current connected calendar read.' };
  if (input.candidates === 0) return { state: 'waiting_for_calendar', message: 'No eligible upcoming meeting has a current calendar observation yet. Clem will check through Calendar watch.' };
  return { state: 'ready', message: 'Clem can offer a preparation brief for recently observed meetings. She will ask before starting.' };
}

export const meetingPreparationWakeFingerprint = (candidates: readonly MeetingPreparationCandidate[]): string | null =>
  candidates.length ? digest('meeting-preparation-noticing-wake', candidates.map(({ candidateId, revision }) => [candidateId, revision]).sort()) : null;

/** Coalesce into the existing Noticing pass. Only a successful admitted pass
 * can retain the fingerprint; observing a candidate or a failed model call
 * cannot consume its opportunity. The caller supplies the existing cooldown. */
export function createMeetingPreparationWake(deps: {
  now: () => number;
  read: () => { enabled: boolean; fingerprint: string | null; admittedFingerprint?: string; retryAt?: number };
  run: () => Promise<boolean>;
  retain: (fingerprint: string) => void;
}): () => Promise<boolean> {
  let inFlight: Promise<boolean> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const work = async (): Promise<boolean> => {
      const before = deps.read();
      if (!before.enabled || !before.fingerprint || before.fingerprint === before.admittedFingerprint
        || (before.retryAt ?? 0) > deps.now()) return false;
      const admitted = await deps.run();
      if (!admitted) return false;
      const after = deps.read();
      if (after.enabled && after.fingerprint === before.fingerprint) deps.retain(before.fingerprint);
      return true;
    };
    inFlight = work().finally(() => { inFlight = null; });
    return inFlight;
  };
}
