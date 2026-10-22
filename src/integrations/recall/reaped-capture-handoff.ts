/**
 * What happens after the stuck-recording reaper finalizes a capture: the
 * same handoff the recording-ended route makes, so a capture that lost its
 * ended event is finished the same way.
 *
 * An SDK upload id is polled to its recording before anything else; only a
 * capture with a recording id and no upload id goes straight to canonical
 * backfill. A timed-retention upload is analyzed once its canonical
 * transcript lands; any other capture is analyzed from what was captured.
 *
 * Live 2026-10-21: an interview capture lost its ended event across two
 * service restarts. The reaper finalized it with its upload id but no
 * recording id, started neither the upload poll nor backfill, and the
 * capture sat at "upload pending" for good while Recall held the finished
 * recording.
 */
import type { RecallMeetingRecord, RecallRegion } from './meeting-capture.js';

export interface ReapedCaptureHandoffDeps {
  startSdkUpload: (input: { meetingId: string }) => void;
  startBackfill: (input: { windowId: string; recordingId: string; region?: RecallRegion }) => void;
  queueAnalysis: () => Promise<void>;
}

export type ReapedCaptureHandoff = {
  transcript: 'sdk_upload' | 'canonical_backfill' | 'none';
  analysis: 'now' | 'after_canonical' | 'none';
};

export async function handOffReapedCapture(
  record: Pick<RecallMeetingRecord, 'id' | 'windowId' | 'recordingId' | 'sdkUploadId' | 'sdkUploadRegion' | 'recallRetentionMode'>,
  artifactPath: string | undefined,
  settings: { analyzeOnComplete?: boolean },
  deps: ReapedCaptureHandoffDeps,
): Promise<ReapedCaptureHandoff> {
  const retention = record.recallRetentionMode;
  let transcript: ReapedCaptureHandoff['transcript'] = 'none';
  if (record.sdkUploadId) {
    deps.startSdkUpload({ meetingId: record.id });
    transcript = 'sdk_upload';
  } else if (retention !== 'zero' && record.recordingId) {
    deps.startBackfill({ windowId: record.windowId, recordingId: record.recordingId, region: record.sdkUploadRegion });
    transcript = 'canonical_backfill';
  }
  const deferUntilCanonical = Boolean(record.sdkUploadId) && retention === 'timed';
  let analysis: ReapedCaptureHandoff['analysis'] = 'none';
  if (artifactPath && settings.analyzeOnComplete) {
    if (deferUntilCanonical) {
      analysis = 'after_canonical';
    } else {
      await deps.queueAnalysis();
      analysis = 'now';
    }
  }
  return { transcript, analysis };
}
