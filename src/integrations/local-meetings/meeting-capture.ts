import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { addNotification } from '../../runtime/notifications.js';
import { clearLiveTranscript, noteLiveTranscriptOpportunity, type LiveTranscriptSnapshot } from './live-transcript.js';
import { BASE_DIR } from '../../config.js';
import { createBackgroundTask } from '../../execution/background-tasks.js';
import { reindexVault } from '../../memory/indexer.js';
import {
  applyLocalMeetingTranscript,
  buildAnalyzerPrompt,
  deleteMeetingRecord,
  findRecallMeetingRecord,
  listAllRecallMeetingRecords,
  loadRecallMeetingById,
  noteRecallMeetingDetected,
  patchMeetingRecord,
  type RecallMeetingRecord,
} from '../recall/meeting-capture.js';
import {
  getLocalTranscriptionRuntimeStatus,
  transcribeLocalMeetingAudio,
} from './whisper-runtime.js';

export type LocalMeetingModel = 'base.en';

export interface LocalMeetingSettings {
  enabled: boolean;
  analyzeOnComplete: boolean;
  model: LocalMeetingModel;
  language: string;
  keepAudio: boolean;
}

export const DEFAULT_LOCAL_MEETING_SETTINGS: LocalMeetingSettings = {
  enabled: false,
  analyzeOnComplete: true,
  model: 'base.en',
  language: 'en',
  // Transcript-only by DEFAULT (product decision 2026-07-14): an in-person
  // recording keeps the TRANSCRIPT; the raw audio is deleted as soon as
  // transcription succeeds. Retaining audio is the explicit opt-in — recorded
  // people's raw voices should not persist on disk unless the user chose that.
  keepAudio: false,
};

const SETTINGS_FILE = path.join(BASE_DIR, 'state', 'meeting-capture', 'local-settings.json');
export const LOCAL_MEETING_AUDIO_DIR = path.join(BASE_DIR, 'state', 'meeting-capture', 'local-audio');
const SUPPORTED_AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.ogg']);

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
  renameSync(tmp, filePath);
}

function normalizeSettings(input: Partial<LocalMeetingSettings> | undefined): LocalMeetingSettings {
  const requestedLanguage = typeof input?.language === 'string'
    ? input.language.trim().toLowerCase().replace('_', '-')
    : '';
  // base.en is intentionally the only first-release model. Keep this field
  // for future multilingual models, but never persist a configuration the
  // current runtime is guaranteed to reject.
  const language = requestedLanguage === 'en'
    || requestedLanguage === 'english'
    || requestedLanguage === 'auto'
    || /^en-[a-z]{2}$/.test(requestedLanguage)
    ? 'en'
    : DEFAULT_LOCAL_MEETING_SETTINGS.language;
  return {
    enabled: input?.enabled === true,
    analyzeOnComplete: input?.analyzeOnComplete !== false,
    model: input?.model === 'base.en' ? input.model : DEFAULT_LOCAL_MEETING_SETTINGS.model,
    language,
    // Absent = transcript-only (matches DEFAULT_LOCAL_MEETING_SETTINGS);
    // keeping raw audio requires the explicit true.
    keepAudio: input?.keepAudio === true,
  };
}

export function loadLocalMeetingSettings(): LocalMeetingSettings {
  if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_LOCAL_MEETING_SETTINGS };
  try {
    return normalizeSettings(JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')) as Partial<LocalMeetingSettings>);
  } catch {
    return { ...DEFAULT_LOCAL_MEETING_SETTINGS };
  }
}

export function saveLocalMeetingSettings(patch: Partial<LocalMeetingSettings>): LocalMeetingSettings {
  const settings = normalizeSettings({ ...loadLocalMeetingSettings(), ...patch });
  writeJsonAtomic(SETTINGS_FILE, settings);
  return settings;
}

export class LocalMeetingCaptureError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'LocalMeetingCaptureError';
  }
}

function safeSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed || trimmed.length > 200) {
    throw new LocalMeetingCaptureError('sessionId must be a non-empty string of at most 200 characters.');
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

function assertSupportedExtension(filePath: string): void {
  const extension = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_AUDIO_EXTENSIONS.has(extension)) {
    throw new LocalMeetingCaptureError('Unsupported audio format. Use WAV, MP3, FLAC, or OGG.');
  }
}

function isInsideAudioRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function realpathWithMissingTail(candidate: string): string {
  let existing = path.resolve(candidate);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('No readable ancestor for audio path.');
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...missing);
}

/**
 * Resolve a path under Clementine's private local-audio directory. Existing
 * ancestors are realpathed in both reservation and ingest modes, closing
 * symlink traversal while still allowing a not-yet-created WAV filename.
 */
export function validateLocalAudioPath(candidate: string, mustExist: boolean): string {
  if (!candidate || typeof candidate !== 'string') {
    throw new LocalMeetingCaptureError('audioPath is required.');
  }
  ensureDir(LOCAL_MEETING_AUDIO_DIR);
  let root: string;
  let resolved: string;
  try {
    root = realpathSync(LOCAL_MEETING_AUDIO_DIR);
    // Even reservation paths may contain a symlinked ancestor. Resolve the
    // nearest existing ancestor and append only the missing tail so both
    // macOS /var → /private/var aliases and actual escapes are handled.
    resolved = mustExist ? realpathSync(path.resolve(candidate)) : realpathWithMissingTail(candidate);
  } catch {
    throw new LocalMeetingCaptureError('audioPath does not reference a readable local recording.');
  }
  if (!isInsideAudioRoot(resolved, root)) {
    throw new LocalMeetingCaptureError('audioPath must remain inside Clementine local-audio storage.');
  }
  assertSupportedExtension(resolved);
  if (mustExist) {
    const stats = statSync(resolved);
    if (!stats.isFile()) throw new LocalMeetingCaptureError('audioPath must reference a regular file.');
    if (stats.size === 0) throw new LocalMeetingCaptureError('The local recording is empty.');
  }
  return resolved;
}

function validIsoOrNow(value?: string): string {
  if (value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}

function localWindowId(sessionId: string): string {
  return `local:${sessionId}`;
}

export function startLocalMeeting(input: {
  sessionId: string;
  title?: string;
  audioPath?: string;
  startedAt?: string;
  sampleRate?: number;
  channels?: number;
}): { record: RecallMeetingRecord; audioPath: string; settings: LocalMeetingSettings } {
  const settings = loadLocalMeetingSettings();
  if (!settings.enabled) throw new LocalMeetingCaptureError('Local meeting recording is disabled.', 409);
  const sessionId = safeSessionId(input.sessionId);
  const windowId = localWindowId(sessionId);
  const existing = findRecallMeetingRecord({ windowId });
  if (existing) {
    if (existing.provider !== 'local') throw new LocalMeetingCaptureError('sessionId collides with another meeting.', 409);
    if (!existing.audioPath) throw new LocalMeetingCaptureError('Existing local session has no reserved audio path.', 409);
    if (input.audioPath) {
      const requestedPath = validateLocalAudioPath(input.audioPath, false);
      if (validateLocalAudioPath(existing.audioPath, false) !== requestedPath) {
        throw new LocalMeetingCaptureError('sessionId is already reserved for a different audio path.', 409);
      }
    }
    return { record: existing, audioPath: existing.audioPath, settings };
  }
  ensureDir(LOCAL_MEETING_AUDIO_DIR);
  const generatedPath = path.join(LOCAL_MEETING_AUDIO_DIR, `local-${sessionId}-${Date.now().toString(36)}.wav`);
  const audioPath = validateLocalAudioPath(input.audioPath?.trim() || generatedPath, false);
  const sampleRate = Number.isFinite(input.sampleRate) ? Math.max(8_000, Math.min(192_000, Math.round(input.sampleRate as number))) : undefined;
  const channels = Number.isFinite(input.channels) ? Math.max(1, Math.min(8, Math.round(input.channels as number))) : undefined;
  const record = noteRecallMeetingDetected({
    windowId,
    provider: 'local',
    source: 'local-audio',
    platform: 'in-person',
    title: typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 240) : 'In-person meeting',
    status: 'recording',
    startedAt: validIsoOrNow(input.startedAt),
    audioPath,
    transcriptionStatus: 'not_started',
    transcriptionModel: settings.model,
    transcriptionLanguage: settings.language,
  });
  // These optional capture facts are deliberately assigned through the
  // generic patch so older records remain readable without migration.
  const withCaptureMetadata = patchMeetingRecord(record.id, {
    ...(sampleRate ? { audioSampleRate: sampleRate } : {}),
    ...(channels ? { audioChannels: channels } : {}),
  }) ?? record;
  return { record: withCaptureMetadata, audioPath, settings };
}

type LocalTranscriber = typeof transcribeLocalMeetingAudio;
type LocalAudioDeleter = typeof unlinkSync;
type LocalAnalysisTaskCreator = typeof createBackgroundTask;
let transcriber: LocalTranscriber = transcribeLocalMeetingAudio;
let audioDeleter: LocalAudioDeleter = unlinkSync;
let analysisTaskCreator: LocalAnalysisTaskCreator = createBackgroundTask;
const queuedMeetingIds: string[] = [];
let activeMeetingId: string | undefined;
let drainPromise: Promise<void> | null = null;
const audioDeletionsAttemptedThisProcess = new Set<string>();

export function _setLocalMeetingTranscriberForTests(next: LocalTranscriber | null): void {
  transcriber = next ?? transcribeLocalMeetingAudio;
}

export function _setLocalMeetingAudioDeleterForTests(next: LocalAudioDeleter | null): void {
  audioDeleter = next ?? unlinkSync;
}

export function _setLocalMeetingAnalysisTaskCreatorForTests(next: LocalAnalysisTaskCreator | null): void {
  analysisTaskCreator = next ?? createBackgroundTask;
}

export interface LocalMeetingQueueSnapshot {
  activeMeetingId?: string;
  queuedMeetingIds: string[];
}

export function getLocalMeetingQueueSnapshot(): LocalMeetingQueueSnapshot {
  return { activeMeetingId, queuedMeetingIds: [...queuedMeetingIds] };
}

function queueAnalysis(record: RecallMeetingRecord, artifactPath?: string): RecallMeetingRecord {
  if (!artifactPath || !loadLocalMeetingSettings().analyzeOnComplete || record.analysisTaskId) return record;
  const task = analysisTaskCreator({
    title: `Analyze meeting transcript: ${record.title || record.id}`,
    prompt: buildAnalyzerPrompt(record, artifactPath),
    source: 'daemon',
    channel: 'electron:meeting-capture',
    maxMinutes: 30,
  });
  return patchMeetingRecord(record.id, {
    analysisTaskId: task.id,
    analysisError: undefined,
    analysisUpdatedAt: new Date().toISOString(),
  }) ?? record;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === code;
}

function patchAudioDeletion(
  meetingId: string,
  patch: Pick<RecallMeetingRecord,
    | 'audioPath'
    | 'audioBytes'
    | 'audioDeletionStatus'
    | 'audioDeletionUpdatedAt'
    | 'audioDeletionError'
    | 'audioDeletionAttempts'>,
  fallback: RecallMeetingRecord,
): RecallMeetingRecord {
  try {
    return patchMeetingRecord(meetingId, patch) ?? fallback;
  } catch {
    // The pending state is written before unlinking. If a later persistence
    // write fails, leaving it pending guarantees another daemon can recover.
    return fallback;
  }
}

/**
 * Persist deletion intent before touching the WAV. A crash after unlink but
 * before the terminal write is recovered as a successful, already-missing
 * deletion on the next daemon start.
 */
function deleteLocalMeetingAudio(record: RecallMeetingRecord, force = false): RecallMeetingRecord {
  if (record.provider !== 'local' || !record.audioPath) return record;
  if (!force && audioDeletionsAttemptedThisProcess.has(record.id)) return record;
  audioDeletionsAttemptedThisProcess.add(record.id);

  const pendingAt = new Date().toISOString();
  let pending: RecallMeetingRecord;
  try {
    pending = patchMeetingRecord(record.id, {
      audioDeletionStatus: 'pending',
      audioDeletionUpdatedAt: pendingAt,
      audioDeletionError: undefined,
      audioDeletionAttempts: (record.audioDeletionAttempts ?? 0) + 1,
    }) ?? record;
  } catch {
    // Never delete unless the intent is durable first. Transcription remains
    // ready and a future request can attempt persistence again.
    return record;
  }
  if (pending.audioDeletionStatus !== 'pending') return pending;

  let audioPath: string;
  try {
    audioPath = validateLocalAudioPath(pending.audioPath!, false);
    const stats = lstatSync(audioPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error('Refusing to delete a non-regular local audio file.');
    }
    audioDeleter(validateLocalAudioPath(audioPath, true));
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      return patchAudioDeletion(record.id, {
        audioPath: pending.audioPath,
        audioBytes: pending.audioBytes,
        audioDeletionStatus: 'failed',
        audioDeletionUpdatedAt: new Date().toISOString(),
        audioDeletionError: errorMessage(error),
        audioDeletionAttempts: pending.audioDeletionAttempts,
      }, pending);
    }
    // ENOENT means a prior attempt unlinked the file but crashed before its
    // terminal record write. Treat that as completed cleanup.
  }

  return patchAudioDeletion(record.id, {
    audioPath: undefined,
    audioBytes: undefined,
    audioDeletionStatus: 'deleted',
    audioDeletionUpdatedAt: new Date().toISOString(),
    audioDeletionError: undefined,
    audioDeletionAttempts: pending.audioDeletionAttempts,
  }, pending);
}

export interface LocalAudioDeletionRecoveryResult {
  discovered: number;
  deleted: number;
  failed: number;
  /** Records that newly crossed the retry cap THIS scan — the caller surfaces
   *  these to the user ONCE (the durable marker prevents re-surfacing). */
  exhausted: Array<{ meetingId: string; title?: string; audioPath?: string }>;
}

// Bounded privacy-deletion retries (2026-07-14 review: the maintenance tick
// retried a failed deletion FOREVER every cycle with no cap — a permanently
// locked file meant an infinite silent loop). After this many attempts the
// record is durably marked exhausted and surfaced to the user instead:
// honest "I couldn't delete it, here's the path" beats silent retry-forever.
export const MAX_LOCAL_AUDIO_DELETION_ATTEMPTS = 12;
const AUDIO_DELETION_EXHAUSTED_PREFIX = 'retries exhausted: ';

/** Retry a persisted privacy cleanup, bounded by MAX_LOCAL_AUDIO_DELETION_ATTEMPTS. */
export function recoverPendingLocalAudioDeletions(
  options: { force?: boolean } = {},
): LocalAudioDeletionRecoveryResult {
  const result: LocalAudioDeletionRecoveryResult = { discovered: 0, deleted: 0, failed: 0, exhausted: [] };
  const keepAudio = loadLocalMeetingSettings().keepAudio;
  for (const record of listAllRecallMeetingRecords()) {
    if (record.provider !== 'local' || !record.audioPath) continue;
    // CRASH-WINDOW sweep (2026-07-14 review): a crash between transcription-
    // ready and the deletion's durable intent write leaves a READY record with
    // audio and NO deletion status — invisible to the pending/failed filter, so
    // the audio would be retained forever against the transcript-only promise.
    const crashOrphan = !keepAudio
      && record.transcriptionStatus === 'ready'
      && record.audioDeletionStatus === undefined;
    if (record.audioDeletionStatus !== 'pending' && record.audioDeletionStatus !== 'failed' && !crashOrphan) continue;
    result.discovered += 1;
    if ((record.audioDeletionAttempts ?? 0) >= MAX_LOCAL_AUDIO_DELETION_ATTEMPTS) {
      // Already surfaced (durable marker) → stay silent; else mark + notify ONCE.
      // The notification is sent HERE (not by the caller) because MULTIPLE
      // callers run this scan (maintenance tick, transcription recovery) — a
      // caller-side notify let whichever caller crossed the cap first consume
      // the one-shot marker and silently swallow the surfacing (review repro).
      if (!(record.audioDeletionError ?? '').startsWith(AUDIO_DELETION_EXHAUSTED_PREFIX)) {
        try {
          patchMeetingRecord(record.id, {
            audioDeletionError: `${AUDIO_DELETION_EXHAUSTED_PREFIX}${record.audioDeletionError ?? 'file could not be deleted'}`,
            audioDeletionUpdatedAt: new Date().toISOString(),
          });
          result.exhausted.push({ meetingId: record.id, title: record.title, audioPath: record.audioPath });
          try {
            addNotification({
              id: `local-audio-delete-exhausted-${record.id}`,
              kind: 'system',
              read: false,
              createdAt: new Date().toISOString(),
              title: 'Could not delete a meeting recording',
              body: `The audio for "${record.title ?? 'a recorded meeting'}" could not be deleted after repeated tries (the file may be locked). Remove it manually: ${record.audioPath}`,
            });
          } catch { /* notification is best-effort; the durable marker + record error remain */ }
        } catch { /* marker write failed — retry surfacing next scan */ }
      }
      result.failed += 1;
      continue;
    }
    const updated = deleteLocalMeetingAudio(record, options.force === true);
    if (updated.audioDeletionStatus === 'deleted') result.deleted += 1;
    else result.failed += 1;
  }
  return result;
}

async function transcribeOne(meetingId: string): Promise<void> {
  const record = loadRecallMeetingById(meetingId);
  if (!record || record.provider !== 'local' || !record.audioPath) return;
  const settings = loadLocalMeetingSettings();
  patchMeetingRecord(meetingId, {
    transcriptionStatus: 'transcribing',
    transcriptionUpdatedAt: new Date().toISOString(),
    transcriptionError: undefined,
    transcriptionModel: settings.model,
    transcriptionLanguage: settings.language,
  });
  try {
    const output = await transcriber({
      audioPath: record.audioPath,
      model: settings.model,
      language: settings.language,
      durationSeconds: record.audioDurationSeconds,
    });
    const applied = applyLocalMeetingTranscript({
      meetingId,
      text: output.text,
      segments: output.segments,
      model: output.model,
      language: output.language ?? settings.language,
    });
    const duration = Number.isFinite(output.durationSeconds) ? output.durationSeconds : record.audioDurationSeconds;
    let ready = duration !== undefined
      ? (patchMeetingRecord(meetingId, { audioDurationSeconds: duration }) ?? applied.record)
      : applied.record;
    if (applied.artifactPath) {
      try { reindexVault(); } catch { /* maintenance will retry */ }
    }
    try {
      ready = queueAnalysis(ready, applied.artifactPath);
    } catch (error) {
      // Analysis is an optional follow-on. Preserve the ready transcript and
      // surface the scheduling error independently for diagnosis/retry.
      try {
        ready = patchMeetingRecord(meetingId, {
          analysisError: errorMessage(error),
          analysisUpdatedAt: new Date().toISOString(),
        }) ?? ready;
      } catch { /* transcript readiness is already durable */ }
    }
    if (!settings.keepAudio && ready.audioPath) {
      ready = deleteLocalMeetingAudio(ready);
    }
    // The transcript is durable ('ready' persisted above) — the crash-recovery
    // sidecar has served its purpose. Without this, local-<session>.json files
    // accumulated forever (2026-07-14 review).
    if (ready.windowId?.startsWith('local:')) {
      const sidecarPath = path.join(LOCAL_MEETING_AUDIO_DIR, `local-${ready.windowId.slice('local:'.length)}.json`);
      try { unlinkSync(sidecarPath); } catch { /* absent or locked — recovery skips ready records anyway */ }
    }
  } catch (error) {
    patchMeetingRecord(meetingId, {
      status: 'completed',
      transcriptionStatus: 'failed',
      transcriptionUpdatedAt: new Date().toISOString(),
      transcriptionError: error instanceof Error ? error.message : String(error),
    });
  }
}

async function drainQueue(): Promise<void> {
  while (queuedMeetingIds.length > 0) {
    const meetingId = queuedMeetingIds.shift();
    if (!meetingId) continue;
    activeMeetingId = meetingId;
    try {
      await transcribeOne(meetingId);
    } catch (error) {
      // transcribeOne contains model/process errors itself. This outer guard
      // also contains unexpected synchronous FS/settings failures so one bad
      // record cannot wedge the serialized queue or reject it unobserved.
      try {
        patchMeetingRecord(meetingId, {
          status: 'completed',
          transcriptionStatus: 'failed',
          transcriptionUpdatedAt: new Date().toISOString(),
          transcriptionError: error instanceof Error ? error.message : String(error),
        });
      } catch { /* record may itself be unreadable */ }
    } finally {
      activeMeetingId = undefined;
    }
  }
}

function ensureQueueDraining(): void {
  if (drainPromise) return;
  drainPromise = drainQueue().finally(() => {
    drainPromise = null;
    if (queuedMeetingIds.length > 0) ensureQueueDraining();
  });
}

export function queueLocalMeetingTranscription(meetingId: string): LocalMeetingQueueSnapshot {
  const record = loadRecallMeetingById(meetingId);
  if (!record || record.provider !== 'local') throw new LocalMeetingCaptureError('Local meeting not found.', 404);
  if (record.transcriptionStatus === 'ready') return getLocalMeetingQueueSnapshot();
  if (activeMeetingId !== meetingId && !queuedMeetingIds.includes(meetingId)) queuedMeetingIds.push(meetingId);
  if (activeMeetingId !== meetingId) {
    patchMeetingRecord(meetingId, {
      transcriptionStatus: 'queued',
      transcriptionUpdatedAt: new Date().toISOString(),
      transcriptionError: undefined,
    });
  }
  ensureQueueDraining();
  return getLocalMeetingQueueSnapshot();
}

export function ingestLocalMeeting(input: {
  sessionId: string;
  audioPath: string;
  endedAt?: string;
  durationSeconds?: number;
  bytes?: number;
}): { record: RecallMeetingRecord; queue: LocalMeetingQueueSnapshot } {
  const sessionId = safeSessionId(input.sessionId);
  // The recording is final — the batch transcription owns the truth from here.
  clearLiveTranscript(sessionId);
  const existing = findRecallMeetingRecord({ windowId: localWindowId(sessionId) });
  if (!existing || existing.provider !== 'local') throw new LocalMeetingCaptureError('Local meeting session not found.', 404);
  const audioPath = validateLocalAudioPath(input.audioPath, true);
  const reservedAudioPath = existing.audioPath ? validateLocalAudioPath(existing.audioPath, true) : undefined;
  if (reservedAudioPath && reservedAudioPath !== audioPath) {
    throw new LocalMeetingCaptureError('audioPath does not match the path reserved for this session.');
  }
  const stats = statSync(audioPath);
  const durationSeconds = Number.isFinite(input.durationSeconds)
    ? Math.max(0, input.durationSeconds as number)
    : existing.audioDurationSeconds;
  let record = patchMeetingRecord(existing.id, {
    audioPath,
    audioBytes: stats.size,
    audioDurationSeconds: durationSeconds,
    endedAt: validIsoOrNow(input.endedAt),
    status: 'completed',
    canonicalStatus: 'not_started',
    canonicalUpdatedAt: new Date().toISOString(),
  }) ?? existing;
  const queue = queueLocalMeetingTranscription(record.id);
  record = loadRecallMeetingById(record.id) ?? record;
  return { record, queue };
}

export function retryLocalMeetingTranscription(input: {
  meetingId?: string;
  sessionId?: string;
}): { record: RecallMeetingRecord; queue: LocalMeetingQueueSnapshot } {
  const record = input.meetingId
    ? loadRecallMeetingById(input.meetingId)
    : input.sessionId
      ? findRecallMeetingRecord({ windowId: localWindowId(safeSessionId(input.sessionId)) })
      : null;
  if (!record || record.provider !== 'local') throw new LocalMeetingCaptureError('Local meeting not found.', 404);
  if (record.status === 'recording') throw new LocalMeetingCaptureError('Stop the recording before retrying transcription.', 409);
  if (record.transcriptionStatus === 'ready') return { record, queue: getLocalMeetingQueueSnapshot() };
  if (!record.audioPath) throw new LocalMeetingCaptureError('This meeting has no retained local audio to retry.', 409);
  validateLocalAudioPath(record.audioPath, true);
  const queue = queueLocalMeetingTranscription(record.id);
  return { record: loadRecallMeetingById(record.id) ?? record, queue };
}

/** Retry work persisted before a daemon restart. Failed work is retained for
 * an explicit ingest retry so a bad model install cannot create a boot loop. */
export function recoverPendingLocalMeetingTranscriptions(): LocalMeetingQueueSnapshot {
  recoverPendingLocalAudioDeletions();
  for (const record of listAllRecallMeetingRecords()) {
    if (record.provider !== 'local' || !record.audioPath) continue;
    if (record.transcriptionStatus !== 'queued' && record.transcriptionStatus !== 'transcribing') continue;
    try {
      validateLocalAudioPath(record.audioPath, true);
      queueLocalMeetingTranscription(record.id);
    } catch (error) {
      patchMeetingRecord(record.id, {
        transcriptionStatus: 'failed',
        transcriptionUpdatedAt: new Date().toISOString(),
        transcriptionError: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return getLocalMeetingQueueSnapshot();
}

export interface LocalMeetingSidecarRecoveryResult {
  discovered: number;
  queued: number;
  errors: number;
}

let lastSidecarRecoveryAt = 0;
const sidecarsAttemptedThisProcess = new Set<string>();

/**
 * Recover finalized Electron recordings whose `/ingest` request never reached
 * the daemon. Electron deliberately leaves `local-<session>.json` beside the
 * WAV; the daemon trusts only the filename-derived sibling WAV and validates
 * its real path before registering or queueing anything.
 */
export function recoverFinalizedLocalMeetingSidecars(options: { force?: boolean } = {}): LocalMeetingSidecarRecoveryResult {
  const now = Date.now();
  if (!options.force && now - lastSidecarRecoveryAt < 5_000) {
    return { discovered: 0, queued: 0, errors: 0 };
  }
  lastSidecarRecoveryAt = now;
  // Consent gate (2026-07-14 review): recovery auto-transcribes found audio and
  // files it into permanent memory — that must never happen while the feature
  // is OFF. A user who disabled local capture has withdrawn that consent; the
  // sidecars stay untouched and recover normally if the feature is re-enabled.
  if (!loadLocalMeetingSettings().enabled) {
    return { discovered: 0, queued: 0, errors: 0 };
  }
  ensureDir(LOCAL_MEETING_AUDIO_DIR);
  const result: LocalMeetingSidecarRecoveryResult = { discovered: 0, queued: 0, errors: 0 };
  let entries: string[] = [];
  try { entries = readdirSync(LOCAL_MEETING_AUDIO_DIR); } catch { return result; }
  for (const entry of entries.slice(0, 10_000)) {
    const match = /^local-([a-zA-Z0-9_-]{8,80})\.json$/.exec(entry);
    if (!match) continue;
    result.discovered += 1;
    const sessionId = match[1];
    const sidecarPath = path.join(LOCAL_MEETING_AUDIO_DIR, entry);
    const audioPath = path.join(LOCAL_MEETING_AUDIO_DIR, `local-${sessionId}.wav`);
    try {
      const sidecarStats = lstatSync(sidecarPath);
      if (!sidecarStats.isFile() || sidecarStats.size > 64 * 1024) throw new Error('invalid recording sidecar');
      const metadata = JSON.parse(readFileSync(sidecarPath, 'utf-8')) as {
        sessionId?: unknown;
        title?: unknown;
        startedAt?: unknown;
        endedAt?: unknown;
        durationSeconds?: unknown;
        status?: unknown;
      };
      if (metadata.sessionId !== sessionId || metadata.status !== 'recorded') throw new Error('recording sidecar mismatch');
      let record = findRecallMeetingRecord({ windowId: localWindowId(sessionId) });
      // A ready meeting may intentionally have no WAV when keepAudio=false;
      // recognize terminal/pending state before requiring the media file.
      if (record?.provider === 'local' && record.transcriptionStatus === 'ready') {
        continue;
      }
      if (record?.provider === 'local' && (
        record.transcriptionStatus === 'queued' || record.transcriptionStatus === 'transcribing'
      )) {
        continue;
      }
      // A cancelled meeting is a terminal USER decision — never resurrect it
      // (belt to the sidecar unlink in cancelLocalMeeting; this catches a
      // cancel whose sidecar unlink failed on a locked file).
      if (record?.provider === 'local' && record.transcriptionStatus === 'cancelled') {
        continue;
      }
      // Retry a persisted failure once per daemon process. This lets an app
      // update or repaired model recover old audio without turning every
      // status poll into a tight failure loop.
      if (sidecarsAttemptedThisProcess.has(sessionId)) continue;
      sidecarsAttemptedThisProcess.add(sessionId);
      const validatedAudioPath = validateLocalAudioPath(audioPath, true);
      if (!record) {
        const settings = loadLocalMeetingSettings();
        record = noteRecallMeetingDetected({
          windowId: localWindowId(sessionId),
          provider: 'local',
          source: 'local-audio',
          platform: 'in-person',
          title: typeof metadata.title === 'string' && metadata.title.trim()
            ? metadata.title.trim().slice(0, 240)
            : 'Recovered in-person meeting',
          status: 'recording',
          startedAt: typeof metadata.startedAt === 'string' ? validIsoOrNow(metadata.startedAt) : undefined,
          audioPath: validatedAudioPath,
          transcriptionStatus: 'not_started',
          transcriptionModel: settings.model,
          transcriptionLanguage: settings.language,
        });
      }
      ingestLocalMeeting({
        sessionId,
        audioPath: validatedAudioPath,
        endedAt: typeof metadata.endedAt === 'string' ? metadata.endedAt : undefined,
        durationSeconds: typeof metadata.durationSeconds === 'number' ? metadata.durationSeconds : undefined,
      });
      result.queued += 1;
    } catch {
      result.errors += 1;
    }
  }
  return result;
}

export function cancelLocalMeeting(sessionIdInput: string): { cancelled: true; meetingId?: string } {
  const sessionId = safeSessionId(sessionIdInput);
  const record = findRecallMeetingRecord({ windowId: localWindowId(sessionId) });
  if (!record || record.provider !== 'local') return { cancelled: true };
  if (activeMeetingId === record.id) throw new LocalMeetingCaptureError('Transcription is already active.', 409);
  const queueIndex = queuedMeetingIds.indexOf(record.id);
  if (queueIndex >= 0) queuedMeetingIds.splice(queueIndex, 1);
  // Delete the crash-recovery sidecar FIRST — it is what sidecar recovery keys
  // on. Without this, a cancel whose WAV unlink failed (locked file) left
  // sidecar+WAV behind with the record deleted, and the next recovery scan
  // resurrected the discarded meeting into permanent memory (2026-07-14 review).
  clearLiveTranscript(sessionId);
  const sidecarPath = path.join(LOCAL_MEETING_AUDIO_DIR, `local-${sessionId}.json`);
  try { unlinkSync(sidecarPath); } catch { /* absent or locked — the cancelled-record skip below still guards */ }
  if (record.audioPath && existsSync(record.audioPath)) {
    try { unlinkSync(validateLocalAudioPath(record.audioPath, true)); } catch { /* never delete outside the audio root */ }
  }
  patchMeetingRecord(record.id, {
    status: 'cancelled',
    transcriptionStatus: 'cancelled',
    transcriptionUpdatedAt: new Date().toISOString(),
  });
  if (record.audioPath && existsSync(record.audioPath)) {
    // The WAV survived the unlink (e.g. locked). Keep the CANCELLED record as a
    // durable tombstone — recovery skips cancelled records, and the maintenance
    // privacy loop keeps retrying the deletion (bounded) via the failed status.
    patchMeetingRecord(record.id, {
      audioDeletionStatus: 'failed',
      audioDeletionUpdatedAt: new Date().toISOString(),
      audioDeletionError: 'cancel could not delete the audio file (locked?) — retried by maintenance',
    });
    return { cancelled: true, meetingId: record.id };
  }
  deleteMeetingRecord(record.id);
  return { cancelled: true, meetingId: record.id };
}

export async function getLocalMeetingStatus(sessionIdInput?: string): Promise<{
  liveTranscript?: LiveTranscriptSnapshot;
  settings: LocalMeetingSettings;
  runtime: Awaited<ReturnType<typeof getLocalTranscriptionRuntimeStatus>>;
  audioRoot: string;
  queue: LocalMeetingQueueSnapshot;
  record?: RecallMeetingRecord;
}> {
  recoverFinalizedLocalMeetingSidecars();
  recoverPendingLocalMeetingTranscriptions();
  const record = sessionIdInput
    ? findRecallMeetingRecord({ windowId: localWindowId(safeSessionId(sessionIdInput)) }) ?? undefined
    : undefined;
  // Live in-person transcription (a VIEW — the batch pass at stop stays the
  // authoritative transcript): while this session is actively recording, each
  // status poll kicks an incremental whisper pass over the new audio and
  // returns what's been heard so far.
  let liveTranscript: LiveTranscriptSnapshot | undefined;
  if (record?.provider === 'local' && record.status === 'recording' && record.audioPath && sessionIdInput) {
    liveTranscript = noteLiveTranscriptOpportunity(safeSessionId(sessionIdInput), record.audioPath);
  }
  return {
    liveTranscript,
    settings: loadLocalMeetingSettings(),
    runtime: await getLocalTranscriptionRuntimeStatus(),
    audioRoot: LOCAL_MEETING_AUDIO_DIR,
    queue: getLocalMeetingQueueSnapshot(),
    record,
  };
}
