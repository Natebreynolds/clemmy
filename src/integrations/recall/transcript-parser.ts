/**
 * Convert Recall's canonical async-transcript payload into the in-memory
 * RecallTranscriptSegment shape that Clementine's meeting-capture
 * pipeline already understands.
 *
 * Ported from breakthrough-coaching-zoombot-app/worker/index.ts:511
 * `parseTranscriptToSegments`. Behavior preserved:
 *
 *   - One Map per participant.id → participant.name, captured once so
 *     every word from the same speaker gets the same display name
 *     even if Recall's payload re-orders blocks.
 *   - Falls back to `Speaker N` when `participant.name` is empty
 *     (rare, but Recall can produce this for unnamed Zoom guests).
 *   - Groups words into segments that flush at the LATER of:
 *       (a) the last word for that participant, OR
 *       (b) every ~10 seconds of continuous speech.
 *     The 10s cap keeps any one segment scannable in the searchable
 *     UI without losing word-level timing.
 *   - startTime/endTime in MILLISECONDS (zoombot multiplies the
 *     relative seconds by 1000 here too).
 *
 * Adapted (vs zoombot): no DB rows, no organizationId, no sentiment.
 * The output is a flat array Clementine slots straight into
 * `record.segments`, replacing the streamed-segment array verbatim
 * once the canonical transcript lands.
 */

import { randomBytes } from 'node:crypto';
import type { TranscriptData } from './api.js';
import type { RecallTranscriptSegment } from './meeting-capture.js';

const SEGMENT_FLUSH_SECONDS = 10;

function newSegmentId(): string {
  return `recall-seg-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

export interface ParseTranscriptOptions {
  /** windowId of the Clementine meeting record. Stamped on every
   *  segment so they sort with the streamed segments before they get
   *  replaced. */
  windowId: string;
  /** recordingId for the meeting — included on each segment for
   *  cross-reference. */
  recordingId?: string;
  /** ISO timestamp of when the recording started. Each segment's
   *  `timestamp` field is computed as startedAt + start_timestamp.relative
   *  so segments still sort correctly when displayed alongside other
   *  meetings. Falls back to the current time if omitted. */
  startedAt?: string;
}

/**
 * Walk the participant-grouped canonical transcript and emit a flat
 * segment list. Output is sorted by absolute timestamp ascending so
 * the dashboard's transcript view doesn't have to sort it again.
 */
export function parseTranscriptToSegments(
  data: TranscriptData[],
  opts: ParseTranscriptOptions,
): RecallTranscriptSegment[] {
  // participant.id → display name, captured once per participant so
  // every block for that speaker uses the same name even when the
  // download isn't strictly grouped (Recall is usually grouped but
  // we don't rely on it).
  const speakerNames = new Map<number, string>();
  for (const participant of data) {
    const pid = participant.participant.id;
    if (!speakerNames.has(pid)) {
      const name = participant.participant.name?.trim();
      speakerNames.set(pid, name && name.length > 0 ? name : `Speaker ${speakerNames.size + 1}`);
    }
  }

  const startedMs = opts.startedAt
    ? Date.parse(opts.startedAt)
    : Date.now();
  const startedAnchor = Number.isFinite(startedMs) ? startedMs : Date.now();

  const segments: RecallTranscriptSegment[] = [];

  for (const participant of data) {
    if (!participant.words || participant.words.length === 0) continue;
    const pid = participant.participant.id;
    const speakerName = speakerNames.get(pid)!;

    let buffer: string[] = [];
    let segmentStartSec: number | null = null;
    let segmentEndSec = 0;

    for (let i = 0; i < participant.words.length; i += 1) {
      const word = participant.words[i];
      buffer.push(word.text);
      if (segmentStartSec === null) segmentStartSec = word.start_timestamp.relative;
      segmentEndSec = word.end_timestamp.relative;

      const isLast = i === participant.words.length - 1;
      const flush = isLast || segmentEndSec - (segmentStartSec ?? 0) >= SEGMENT_FLUSH_SECONDS;
      if (flush) {
        const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
        if (text.length > 0) {
          const segStartMs = Math.floor((segmentStartSec ?? 0) * 1000);
          segments.push({
            id: newSegmentId(),
            windowId: opts.windowId,
            recordingId: opts.recordingId,
            event: 'transcript.canonical',
            speaker: speakerName,
            text,
            // Absolute ISO timestamp so the UI sorts chronologically
            // even when canonical lands alongside streamed segments
            // mid-transition.
            timestamp: new Date(startedAnchor + segStartMs).toISOString(),
            isFinal: true,
          });
        }
        buffer = [];
        segmentStartSec = null;
      }
    }
  }

  // Recall's payload is participant-grouped; once we flatten, segments
  // for two speakers could end up interleaved out-of-order. Sort by
  // absolute timestamp so the UI doesn't have to.
  segments.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return segments;
}
