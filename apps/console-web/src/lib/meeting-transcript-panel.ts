import type { LiveMeetingCapture } from './meeting-live-transcript';

export interface MeetingTranscriptSegment {
  id?: string; eventId?: string; text: string; speaker?: string; timestamp?: string; isFinal?: boolean;
}
export interface MeetingTranscriptPreview {
  key: string; segmentId?: string; eventId?: string; text: string; speaker?: string; at: string; expiresAt: number;
}
export interface MeetingTranscriptStreamState {
  partial?: MeetingTranscriptPreview;
  acknowledged: MeetingTranscriptPreview[];
  unconfirmed: Pick<MeetingTranscriptPreview, 'key' | 'segmentId' | 'eventId'>[];
  seenFinalKeys: string[];
}
export const MEETING_TRANSCRIPT_PREVIEW_TTL = 20_000;
const MAX_ACKNOWLEDGED = 24;
const MAX_SEEN_FINALS = 128;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
export const emptyMeetingTranscriptStream = (): MeetingTranscriptStreamState => ({ acknowledged: [], unconfirmed: [], seenFinalKeys: [] });
export const meetingTranscriptCaptureKey = (capture: LiveMeetingCapture): string => JSON.stringify([capture.windowId, capture.sdkUploadId ?? null, capture.recordingId ?? null]);

export function meetingTranscriptEventMatches(capture: LiveMeetingCapture, event: Record<string, unknown>): boolean {
  if (!capture.windowId || event.windowId !== capture.windowId) return false;
  if (capture.sdkUploadId ? event.sdkUploadId !== capture.sdkUploadId : !capture.recordingId || event.recordingId !== capture.recordingId) return false;
  return !(capture.recordingId && event.recordingId && capture.recordingId !== event.recordingId);
}
const readBack = (preview: Pick<MeetingTranscriptPreview, 'segmentId' | 'eventId'>, segments: readonly MeetingTranscriptSegment[]) =>
  segments.some(segment => segment.isFinal !== false && ((preview.segmentId && segment.id === preview.segmentId)
    || (preview.eventId && segment.eventId === preview.eventId))
    && !(preview.segmentId && segment.id && preview.segmentId !== segment.id)
    && !(preview.eventId && segment.eventId && preview.eventId !== segment.eventId));

/** A final acknowledgement bridges the next saved-record read, never becomes a
 * saved transcript by itself. Repeated words with distinct ids stay distinct. */
export function acceptMeetingTranscriptEvent(state: MeetingTranscriptStreamState, capture: LiveMeetingCapture,
  event: Record<string, unknown>, now: number): { state: MeetingTranscriptStreamState; refresh: boolean } {
  if (!meetingTranscriptEventMatches(capture, event) || (event.type !== 'transcript-partial' && event.type !== 'transcript')) return { state, refresh: false };
  if (event.type === 'transcript-partial') {
    if (!text(event.text, 128_000) || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) return { state, refresh: false };
    return { state: { ...state, partial: { key: 'partial', text: event.text,
      ...(text(event.speaker, 200) ? { speaker: event.speaker } : {}), at: event.at, expiresAt: now + MEETING_TRANSCRIPT_PREVIEW_TTL } }, refresh: false };
  }
  const segmentId = text(event.segmentId, 512) ? event.segmentId : undefined;
  const eventId = text(event.eventId, 512) ? event.eventId : undefined;
  const key = segmentId ? `segment:${segmentId}` : eventId ? `event:${eventId}` : undefined;
  if (!key) return { state, refresh: true };
  const aliases = [segmentId ? `segment:${segmentId}` : undefined, eventId ? `event:${eventId}` : undefined].filter((value): value is string => !!value);
  if (aliases.some(alias => state.seenFinalKeys.includes(alias))) return { state, refresh: false };
  const seenFinalKeys = [...state.seenFinalKeys, ...aliases].slice(-MAX_SEEN_FINALS);
  if (!text(event.text, 128_000) || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) {
    return { state: { ...state, partial: undefined, seenFinalKeys,
      unconfirmed: [...state.unconfirmed, { key, segmentId, eventId }].slice(-MAX_SEEN_FINALS) }, refresh: true };
  }
  const preview: MeetingTranscriptPreview = { key, segmentId, eventId, text: event.text,
    ...(text(event.speaker, 200) ? { speaker: event.speaker } : {}), at: event.at, expiresAt: now + MEETING_TRANSCRIPT_PREVIEW_TTL };
  const all = [...state.acknowledged, preview];
  return { state: { ...state, partial: undefined, seenFinalKeys, acknowledged: all.slice(-MAX_ACKNOWLEDGED),
    unconfirmed: [...state.unconfirmed, ...all.slice(0, -MAX_ACKNOWLEDGED).map(({ key, segmentId, eventId }) => ({ key, segmentId, eventId }))].slice(-MAX_SEEN_FINALS) }, refresh: true };
}

export function reconcileMeetingTranscript(state: MeetingTranscriptStreamState, segments: readonly MeetingTranscriptSegment[], now: number): MeetingTranscriptStreamState {
  const partial = state.partial && state.partial.expiresAt > now ? state.partial : undefined;
  const acknowledged = state.acknowledged.filter(preview => preview.expiresAt > now && !readBack(preview, segments));
  const unconfirmed = [...state.unconfirmed, ...state.acknowledged.filter(preview => preview.expiresAt <= now)
    .map(({ key, segmentId, eventId }) => ({ key, segmentId, eventId }))].filter(ref => !readBack(ref, segments)).slice(-MAX_SEEN_FINALS);
  if (partial === state.partial && acknowledged.length === state.acknowledged.length
    && unconfirmed.length === state.unconfirmed.length) return state;
  return { ...state, partial, acknowledged, unconfirmed };
}

export function meetingTranscriptAtBottom(view: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean {
  return [view.scrollTop, view.scrollHeight, view.clientHeight].every(Number.isFinite)
    && view.scrollHeight - view.clientHeight - Math.max(0, view.scrollTop) <= 48;
}

/** One bounded refresh per burst of final acknowledgements. Partials never
 * trigger reads. Disposal cancels pending refresh/expiry and exact listeners. */
export function createMeetingTranscriptStream(options: {
  capture: LiveMeetingCapture;
  subscribe(listener: (event: Record<string, unknown>) => void): (() => void) | void;
  onState(state: MeetingTranscriptStreamState): void;
  onFinal(): void;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  let state = emptyMeetingTranscriptStream();
  let segments: readonly MeetingTranscriptSegment[] = [];
  let disposed = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let refresh: ReturnType<typeof setTimeout> | undefined;
  const publish = (next: MeetingTranscriptStreamState) => {
    if (disposed) return;
    if (next !== state) { state = next; options.onState(state); }
    if (expiry !== undefined) cancel(expiry);
    const deadlines = [...state.acknowledged.map(preview => preview.expiresAt), ...(state.partial ? [state.partial.expiresAt] : [])];
    expiry = deadlines.length ? schedule(() => {
      expiry = undefined;
      if (!disposed) publish(reconcileMeetingTranscript(state, segments, now()));
    }, Math.max(1, Math.min(...deadlines) - now())) : undefined;
  };
  const unsubscribe = options.subscribe(event => {
    if (disposed) return;
    const next = acceptMeetingTranscriptEvent(state, options.capture, event, now());
    if (next.state === state && !next.refresh) return;
    // Persisted rows were already reconciled when their snapshot changed.
    // Every partial need not scan a long saved conversation again.
    publish(next.refresh ? reconcileMeetingTranscript(next.state, segments, now()) : next.state);
    if (next.refresh && refresh === undefined) refresh = schedule(() => {
      refresh = undefined;
      if (!disposed) options.onFinal();
    }, 180);
  });
  return {
    reconcile(next: readonly MeetingTranscriptSegment[]) { segments = next; publish(reconcileMeetingTranscript(state, segments, now())); },
    dispose() {
      disposed = true; if (expiry !== undefined) cancel(expiry); if (refresh !== undefined) cancel(refresh);
      unsubscribe?.(); state = emptyMeetingTranscriptStream(); segments = [];
    },
  };
}
