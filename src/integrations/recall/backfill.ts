/**
 * Canonical-transcript backfill for finalized Recall.ai meetings.
 *
 * Why this exists: Clementine's desktop SDK streams transcript segments
 * live during a meeting (instant feedback, generic speaker labels like
 * "Host"). If streaming drops mid-recording — which it did, repeatedly,
 * on May 21 — the persisted artifact ends up partial. Recall's
 * server-side recording is complete regardless; this module fetches
 * that authoritative async transcript and replaces the streamed
 * segments with it (real participant names, gap-free).
 *
 * Lifecycle, per recording:
 *   1. /api/console/meetings/recall/complete fires after the desktop
 *      finishes uploading. It calls finalizeRecallMeeting() which
 *      writes the streamed artifact immediately + stamps
 *      canonicalStatus='pending'.
 *   2. The same route then fire-and-forgets startCanonicalTranscriptBackfill()
 *      with the recordingId. We do NOT block the HTTP response on
 *      this — the streamed transcript is already on disk.
 *   3. This module: requestAsyncTranscript → poll getTranscript every
 *      30s up to 10min → downloadTranscriptData → parseTranscriptToSegments
 *      → applyCanonicalTranscript (rewrites segments + artifact).
 *   4. On terminal state we update canonicalStatus on the record so
 *      the dashboard can show ready / timed_out / failed.
 *
 * Ported from breakthrough-coaching-zoombot-app/worker/index.ts's
 * recall-transcript-done job (which does the same dance via BullMQ +
 * webhooks). Clementine has no public webhook URL, so we poll instead.
 */

import pino from 'pino';
import { requestAsyncTranscript, getTranscript, downloadTranscriptData } from './api.js';
import { parseTranscriptToSegments } from './transcript-parser.js';
import {
  applyCanonicalTranscript,
  findRecallMeetingRecord,
  markCanonicalTranscriptIncomplete,
  type RecallMeetingRecord,
} from './meeting-capture.js';

const logger = pino({ name: 'clementine-next.recall.backfill' });

const POLL_INTERVAL_MS = 30_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

export interface BackfillResult {
  status: 'ready' | 'timed_out' | 'failed' | 'skipped';
  reason?: string;
  segmentCount?: number;
}

/**
 * Top-level entry point. Resolves to a result describing how the
 * backfill ended. Safe to fire-and-forget: errors are logged + reflected
 * in the meeting record's canonicalStatus, never propagated.
 */
export async function backfillCanonicalTranscript(input: {
  windowId?: string;
  recordingId?: string;
}): Promise<BackfillResult> {
  const startedAt = Date.now();
  const record = findRecallMeetingRecord(input);
  if (!record) {
    logger.warn({ input }, 'backfill: meeting record not found');
    return { status: 'skipped', reason: 'meeting record not found' };
  }
  if (!record.recordingId) {
    logger.info({ id: record.id }, 'backfill: no recordingId, leaving streamed transcript as-is');
    return { status: 'skipped', reason: 'no recordingId on record' };
  }

  try {
    const job = await requestAsyncTranscript(record.recordingId);
    logger.info({ id: record.id, transcriptId: job.id }, 'backfill: async transcript job created');

    const ready = await pollForTranscriptReady(job.id, startedAt);
    if (!ready.downloadUrl) {
      const updated = markCanonicalTranscriptIncomplete(record, 'timed_out', ready.lastStatus);
      logger.warn({ id: updated.id, lastStatus: ready.lastStatus }, 'backfill: poll timed out before transcript ready');
      return { status: 'timed_out', reason: ready.lastStatus };
    }

    const data = await downloadTranscriptData(ready.downloadUrl);
    const canonical = parseTranscriptToSegments(data, {
      windowId: record.windowId,
      recordingId: record.recordingId,
      startedAt: record.startedAt,
    });

    // Guard against the canonical coming back empty — if Recall's
    // transcription produced zero words (e.g. recording was muted),
    // keep the streamed transcript so the user has SOMETHING rather
    // than silently nuking their partial.
    if (canonical.length === 0) {
      const updated = markCanonicalTranscriptIncomplete(record, 'failed', 'canonical transcript came back empty');
      logger.warn({ id: updated.id }, 'backfill: canonical transcript empty; keeping streamed');
      return { status: 'failed', reason: 'canonical transcript empty' };
    }

    const result = applyCanonicalTranscript(record, canonical);
    logger.info(
      { id: result.record.id, segments: canonical.length, artifactPath: result.artifactPath },
      'backfill: canonical transcript applied',
    );
    return { status: 'ready', segmentCount: canonical.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const updated = markCanonicalTranscriptIncomplete(record, 'failed', message);
    logger.error({ err: message, id: updated.id }, 'backfill: failed; keeping streamed transcript');
    return { status: 'failed', reason: message };
  }
}

/**
 * Poll getTranscript every POLL_INTERVAL_MS until either status.code
 * indicates done (with a download_url) OR we exceed POLL_TIMEOUT_MS.
 * Returns `downloadUrl` when ready, `lastStatus` on timeout so the
 * caller can record what state we gave up in.
 */
async function pollForTranscriptReady(
  transcriptId: string,
  startedAt: number,
): Promise<{ downloadUrl?: string; lastStatus: string }> {
  let lastStatus = 'unknown';
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    let snapshot: Awaited<ReturnType<typeof getTranscript>>;
    try {
      snapshot = await getTranscript(transcriptId);
    } catch (err) {
      // Transient API errors during polling shouldn't fail the whole
      // backfill — sleep and retry until the timeout window closes.
      const message = err instanceof Error ? err.message : String(err);
      lastStatus = `poll error: ${message.slice(0, 120)}`;
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    lastStatus = snapshot.status?.code ?? 'unknown';
    if (lastStatus === 'done' && snapshot.download_url) {
      return { downloadUrl: snapshot.download_url, lastStatus };
    }
    if (lastStatus === 'failed' || lastStatus === 'error') {
      throw new Error(`Recall transcript job ended with status=${lastStatus}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { lastStatus };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fire-and-forget wrapper used by HTTP handlers. Catches all errors
 * so it never rejects — useful when called from inside `res.json()`
 * paths where a stray reject would crash the response.
 */
export function startCanonicalTranscriptBackfill(input: { windowId?: string; recordingId?: string }): void {
  backfillCanonicalTranscript(input).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, input }, 'backfill: unexpected unhandled error');
  });
}
