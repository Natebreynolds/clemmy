/**
 * Durable Desktop SDK upload reconciliation.
 *
 * The SDK's create-upload id is not a recording id. In webhook-backed apps,
 * `sdk_upload.complete` supplies the eventual recording id; Clementine has no
 * public webhook, so it polls Recall's authenticated retrieve endpoint after
 * the desktop reports recording completion. Progress/deadline live on the
 * meeting record so daemon restarts resume rather than lose the handoff.
 */
import pino from 'pino';
import { createBackgroundTask } from '../../execution/background-tasks.js';
import { reindexVault } from '../../memory/indexer.js';
import { getSdkUpload, type RecallSdkUpload } from './api.js';
import {
  backfillCanonicalTranscript,
  type BackfillInput,
  type BackfillResult,
} from './backfill.js';
import {
  buildAnalyzerPrompt,
  findRecallMeetingRecord,
  listAllRecallMeetingRecords,
  loadRecallMeetingAnalysis,
  loadRecallMeetingById,
  loadRecallMeetingSettings,
  patchMeetingRecord,
  type RecallMeetingRecord,
  type RecallRegion,
} from './meeting-capture.js';

const logger = pino({ name: 'clementine-next.recall.sdk-upload-reconcile' });

export const SDK_UPLOAD_POLL_INTERVAL_MS = 5_000;
export const SDK_UPLOAD_RECONCILE_TIMEOUT_MS = 15 * 60_000;
export const SDK_UPLOAD_MAX_ATTEMPTS = 180;

type GetSdkUpload = (sdkUploadId: string, options?: { region?: RecallRegion }) => Promise<RecallSdkUpload>;
type Backfill = (input: BackfillInput) => Promise<BackfillResult>;

export interface SdkUploadReconcileOptions {
  getUpload?: GetSdkUpload;
  backfill?: Backfill;
  pollIntervalMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SdkUploadReconcileResult {
  status: 'complete' | 'failed' | 'timed_out' | 'skipped';
  recordingId?: string;
  backfillStatus?: BackfillResult['status'];
  reason?: string;
}

function normalizedCode(upload: RecallSdkUpload): string {
  const status = typeof upload.status === 'string' ? upload.status : upload.status?.code;
  const changes = upload.status_changes;
  const latest = Array.isArray(changes) && changes.length > 0 ? changes[changes.length - 1]?.code : undefined;
  return String(status ?? upload.data?.code ?? latest ?? 'unknown').trim().toLowerCase();
}

function recordingIdFromUpload(upload: RecallSdkUpload): string | undefined {
  const nested = upload.recording && typeof upload.recording === 'object' ? upload.recording.id : undefined;
  const direct = typeof upload.recording === 'string' ? upload.recording : undefined;
  const candidate = upload.recording_id ?? nested ?? direct ?? upload.recordings?.[0]?.id;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

function isCompleteCode(code: string): boolean {
  return code === 'complete' || code === 'completed' || code === 'done';
}

function isFailedCode(code: string): boolean {
  return code === 'failed' || code === 'fatal' || code === 'error';
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function recordForInput(input: { meetingId?: string; sdkUploadId?: string }): RecallMeetingRecord | null {
  if (input.meetingId) return loadRecallMeetingById(input.meetingId);
  if (input.sdkUploadId) return findRecallMeetingRecord({ sdkUploadId: input.sdkUploadId });
  return null;
}

function retentionModeFor(record: RecallMeetingRecord): 'zero' | 'timed' {
  return record.recallRetentionMode ?? loadRecallMeetingSettings().retentionMode;
}

function queueAnalysisIfReady(record: RecallMeetingRecord): RecallMeetingRecord {
  if (!record.artifactPath || record.analysisTaskId || loadRecallMeetingAnalysis(record.id)) return record;
  if (!loadRecallMeetingSettings().analyzeOnComplete) return record;
  try { reindexVault(); } catch { /* maintenance will retry indexing */ }
  const task = createBackgroundTask({
    title: `Analyze meeting transcript: ${record.title || record.platform || record.id}`,
    prompt: buildAnalyzerPrompt(record, record.artifactPath),
    source: 'daemon',
    channel: 'electron:meeting-capture',
    maxMinutes: 30,
  });
  return patchMeetingRecord(record.id, { analysisTaskId: task.id }) ?? record;
}

async function finishTimedRetentionFlow(
  record: RecallMeetingRecord,
  backfill: Backfill,
): Promise<SdkUploadReconcileResult> {
  if (!record.recordingId) return { status: 'failed', reason: 'SDK upload completed without recording id' };
  if (record.canonicalStatus === 'ready') {
    queueAnalysisIfReady(record);
    return { status: 'complete', recordingId: record.recordingId, backfillStatus: 'ready' };
  }
  const result = await backfill({
    windowId: record.windowId,
    recordingId: record.recordingId,
    region: record.sdkUploadRegion,
  });
  // Prefer the canonical artifact, but preserve the previous graceful
  // fallback: if canonical retrieval fails and streamed segments produced an
  // artifact, analysis can still run against that partial transcript.
  const refreshed = loadRecallMeetingById(record.id);
  if (refreshed) queueAnalysisIfReady(refreshed);
  return {
    status: 'complete',
    recordingId: record.recordingId,
    backfillStatus: result.status,
    reason: result.reason,
  };
}

/** Reconcile one completed Clementine meeting with Recall's SDK upload. */
export async function reconcileRecallSdkUpload(
  input: { meetingId?: string; sdkUploadId?: string },
  options: SdkUploadReconcileOptions = {},
): Promise<SdkUploadReconcileResult> {
  let record = recordForInput(input);
  if (!record || record.provider === 'local') return { status: 'skipped', reason: 'Recall meeting record not found' };
  if (!record.sdkUploadId) return { status: 'skipped', reason: 'meeting has no sdkUploadId' };
  const sdkUploadId = record.sdkUploadId;
  const sdkUploadRegion = record.sdkUploadRegion;

  const getUpload = options.getUpload ?? getSdkUpload;
  const backfill = options.backfill ?? backfillCanonicalTranscript;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepDefault;
  const intervalMs = Math.max(1, options.pollIntervalMs ?? SDK_UPLOAD_POLL_INTERVAL_MS);
  const timeoutMs = Math.max(intervalMs, options.timeoutMs ?? SDK_UPLOAD_RECONCILE_TIMEOUT_MS);
  const maxAttempts = Math.max(1, options.maxAttempts ?? SDK_UPLOAD_MAX_ATTEMPTS);

  // Crash could happen after recording-id migration but before canonical
  // backfill/analysis. A completed durable upload resumes directly here.
  if (record.sdkUploadStatus === 'complete' && record.recordingId) {
    if (retentionModeFor(record) === 'timed') return finishTimedRetentionFlow(record, backfill);
    return { status: 'complete', recordingId: record.recordingId };
  }
  if (record.sdkUploadStatus === 'failed') return { status: 'failed', reason: record.sdkUploadError };
  if (record.sdkUploadStatus === 'timed_out') return { status: 'timed_out', reason: record.sdkUploadError };

  const startedAt = now();
  const persistedDeadline = parseTimestamp(record.sdkUploadDeadlineAt);
  const deadlineAt = persistedDeadline ?? (startedAt + timeoutMs);
  record = patchMeetingRecord(record.id, {
    sdkUploadStatus: 'pending',
    sdkUploadUpdatedAt: new Date(startedAt).toISOString(),
    sdkUploadDeadlineAt: new Date(deadlineAt).toISOString(),
    sdkUploadError: undefined,
  }) ?? record;

  while (now() < deadlineAt && (record.sdkUploadAttempts ?? 0) < maxAttempts) {
    const nextAt = parseTimestamp(record.sdkUploadNextAttemptAt);
    if (nextAt && nextAt > now()) {
      await sleep(Math.min(nextAt, deadlineAt) - now());
      if (now() >= deadlineAt) break;
    }

    const attempt: number = (record.sdkUploadAttempts ?? 0) + 1;
    let upload: RecallSdkUpload | undefined;
    let transientError: string | undefined;
    try {
      upload = await getUpload(sdkUploadId, { region: sdkUploadRegion });
    } catch (error) {
      transientError = error instanceof Error ? error.message : String(error);
    }
    const code = upload ? normalizedCode(upload) : 'poll_error';
    const recordingId = upload ? recordingIdFromUpload(upload) : undefined;
    const updatedAt = now();

    if (upload && isFailedCode(code)) {
      const reason = `Recall SDK upload failed${upload.status && typeof upload.status !== 'string' && upload.status.sub_code ? `: ${upload.status.sub_code}` : ''}`;
      patchMeetingRecord(record.id, {
        sdkUploadStatus: 'failed',
        sdkUploadUpdatedAt: new Date(updatedAt).toISOString(),
        sdkUploadAttempts: attempt,
        sdkUploadNextAttemptAt: undefined,
        sdkUploadError: reason,
        canonicalStatus: 'failed',
        canonicalUpdatedAt: new Date(updatedAt).toISOString(),
        canonicalError: reason,
      });
      return { status: 'failed', reason };
    }

    if (upload && isCompleteCode(code) && recordingId) {
      const canonicalStatus = retentionModeFor(record) === 'timed' ? 'pending' : 'not_started';
      const migrated = patchMeetingRecord(record.id, {
        recordingId,
        sdkUploadStatus: 'complete',
        sdkUploadUpdatedAt: new Date(updatedAt).toISOString(),
        sdkUploadAttempts: attempt,
        sdkUploadNextAttemptAt: undefined,
        sdkUploadError: undefined,
        canonicalStatus,
        canonicalUpdatedAt: new Date(updatedAt).toISOString(),
        canonicalError: undefined,
      });
      if (!migrated) return { status: 'failed', reason: 'meeting disappeared during SDK upload reconciliation' };
      if (retentionModeFor(migrated) === 'timed') return finishTimedRetentionFlow(migrated, backfill);
      return { status: 'complete', recordingId };
    }

    const lastState = transientError
      ? `SDK upload poll error: ${transientError.slice(0, 200)}`
      : isCompleteCode(code)
        ? 'SDK upload completed without recording id'
        : `SDK upload status: ${code}`;
    const nextAttemptAt = Math.min(deadlineAt, updatedAt + intervalMs);
    record = patchMeetingRecord(record.id, {
      sdkUploadStatus: 'pending',
      sdkUploadUpdatedAt: new Date(updatedAt).toISOString(),
      sdkUploadAttempts: attempt,
      sdkUploadNextAttemptAt: new Date(nextAttemptAt).toISOString(),
      sdkUploadError: lastState,
    }) ?? record;
    if (nextAttemptAt > now()) await sleep(nextAttemptAt - now());
  }

  const reason = `Recall SDK upload reconciliation timed out after ${record.sdkUploadAttempts ?? 0} attempts`;
  patchMeetingRecord(record.id, {
    sdkUploadStatus: 'timed_out',
    sdkUploadUpdatedAt: new Date(now()).toISOString(),
    sdkUploadNextAttemptAt: undefined,
    sdkUploadError: reason,
    canonicalStatus: 'timed_out',
    canonicalUpdatedAt: new Date(now()).toISOString(),
    canonicalError: reason,
  });
  return { status: 'timed_out', reason };
}

const activeReconciliations = new Map<string, Promise<SdkUploadReconcileResult>>();

/** Fire-and-forget entry used by HTTP completion and startup recovery. */
export function startRecallSdkUploadReconciliation(input: { meetingId?: string; sdkUploadId?: string }): void {
  const record = recordForInput(input);
  if (!record?.sdkUploadId) return;
  if (activeReconciliations.has(record.id)) return;
  const running = reconcileRecallSdkUpload({ meetingId: record.id })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ meetingId: record.id, err: message }, 'SDK upload reconciliation crashed');
      return { status: 'failed', reason: message } as SdkUploadReconcileResult;
    })
    .finally(() => activeReconciliations.delete(record.id));
  activeReconciliations.set(record.id, running);
}

/** Resume pending upload handoffs and post-upload backfills on daemon start. */
export function recoverPendingRecallSdkUploads(options: {
  start?: (input: { meetingId: string }) => void;
} = {}): string[] {
  const start = options.start ?? startRecallSdkUploadReconciliation;
  const recovered: string[] = [];
  for (const record of listAllRecallMeetingRecords()) {
    if (record.provider === 'local' || record.status !== 'completed' || !record.sdkUploadId) continue;
    const needsUpload = !record.recordingId
      && record.sdkUploadStatus !== 'failed'
      && record.sdkUploadStatus !== 'timed_out';
    const needsPostUpload = Boolean(record.recordingId)
      && record.sdkUploadStatus === 'complete'
      && retentionModeFor(record) === 'timed'
      && (record.canonicalStatus === 'pending' || (record.canonicalStatus === 'ready' && !record.analysisTaskId));
    if (!needsUpload && !needsPostUpload) continue;
    recovered.push(record.id);
    start({ meetingId: record.id });
  }
  return recovered;
}
