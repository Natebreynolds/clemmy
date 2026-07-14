import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';
import { VAULT_DIR } from '../../memory/vault.js';
import { readSecret } from '../../runtime/secrets/index.js';

export type RecallRegion = 'us-west-2' | 'us-east-1' | 'eu-central-1' | 'ap-northeast-1';

export interface RecallMeetingSettings {
  enabled: boolean;
  region: RecallRegion;
  autoRecord: boolean;
  liveTranscript: boolean;
  analyzeOnComplete: boolean;
  /** Explicit cloud-media retention. `zero` never stores media on Recall. */
  retentionMode: 'zero' | 'timed';
  /** Used only when retentionMode is `timed`. */
  retentionHours: number;
}

export interface RecallTranscriptSegment {
  id: string;
  windowId: string;
  recordingId?: string;
  event: string;
  speaker?: string;
  text: string;
  timestamp: string;
  isFinal?: boolean;
}

export interface RecallMeetingRecord {
  id: string;
  windowId: string;
  /** Capture provider. Absent on records created before local capture shipped. */
  provider?: 'recall' | 'local';
  source?: 'recall-desktop-sdk' | 'local-audio';
  /** Create SDK Upload id. This is not Recall's eventual recording id. */
  sdkUploadId?: string;
  /** Recall data region used to create sdkUploadId. It must remain pinned
   * even if the user changes their default region before reconciliation. */
  sdkUploadRegion?: RecallRegion;
  /** Durable reconciliation state for sdkUploadId → recordingId. */
  sdkUploadStatus?: 'pending' | 'complete' | 'failed' | 'timed_out';
  sdkUploadUpdatedAt?: string;
  sdkUploadError?: string;
  sdkUploadAttempts?: number;
  sdkUploadNextAttemptAt?: string;
  sdkUploadDeadlineAt?: string;
  recordingId?: string;
  /** Retention stamped when this recording completed; protects against a
   * settings change while upload reconciliation is still pending. */
  recallRetentionMode?: RecallMeetingSettings['retentionMode'];
  recallRetentionHours?: number;
  platform?: string;
  title?: string;
  /** Who set `title`. 'user' titles are locked — the analyzer / auto-filing
   *  never overwrites them. Absent/'analyzer' means auto-generated and
   *  safe to refine. */
  titleSource?: 'user' | 'analyzer';
  status: 'detected' | 'recording' | 'completed' | 'cancelled';
  startedAt: string;
  endedAt?: string;
  segments: RecallTranscriptSegment[];
  artifactPath?: string;
  /** Path to the JSON sidecar written by the post-meeting analyzer,
   *  populated lazily after recording-ended when analyzeOnComplete is
   *  on. The dashboard reads this to surface summary + actions. */
  analysisPath?: string;
  /**
   * State of the post-recording canonical-transcript backfill (see
   * backfillCanonicalTranscript). The streamed segments captured during
   * the meeting label speakers generically (Host / Speaker 2) and can
   * drop mid-recording; the canonical transcript fetched from Recall's
   * async API has real participant names AND is gap-free. We always
   * keep the streamed segments visible immediately when the recording
   * ends, then upgrade once the canonical lands.
   *
   *   not_started — recording too short / no recordingId / no API key
   *   pending     — backfill kicked off; poller still running
   *   ready       — canonical transcript landed; segments + artifact
   *                  have been rewritten using participant.name
   *   timed_out   — gave up after the poll window expired
   *   failed      — Recall API error or download failed; streamed
   *                  segments remain (no regression vs. today)
   */
  canonicalStatus?: 'not_started' | 'pending' | 'ready' | 'timed_out' | 'failed';
  /** ISO timestamp of the last canonicalStatus transition. */
  canonicalUpdatedAt?: string;
  /** Last error message from a failed backfill attempt, surfaced in
   *  the dashboard so users know why it's stuck on streamed data. */
  canonicalError?: string;
  /** Local-audio fields are intentionally optional for old Recall records. */
  audioPath?: string;
  audioDurationSeconds?: number;
  audioBytes?: number;
  audioSampleRate?: number;
  audioChannels?: number;
  transcriptionStatus?: 'not_started' | 'queued' | 'transcribing' | 'ready' | 'failed' | 'cancelled';
  transcriptionUpdatedAt?: string;
  transcriptionError?: string;
  transcriptionModel?: string;
  transcriptionLanguage?: string;
  /** Durable cleanup state when local settings request that source audio not
   * be retained after a successful transcription. */
  audioDeletionStatus?: 'pending' | 'deleted' | 'failed';
  audioDeletionUpdatedAt?: string;
  audioDeletionError?: string;
  audioDeletionAttempts?: number;
  analysisTaskId?: string;
  /** Analysis is optional; scheduling failures must not downgrade a ready
   * transcript, but are retained so the dashboard can explain the absence. */
  analysisError?: string;
  analysisUpdatedAt?: string;
}

export interface RecallMeetingAnalysis {
  /** Short, human-readable title derived from the transcript by the
   *  analyzer (e.g. "Clementine onboarding walkthrough"). Used to retitle
   *  the meeting in the dashboard list + the filed vault note, replacing
   *  the generic platform/type label. */
  title?: string;
  summary?: string;
  decisions?: string[];
  actionItems?: Array<{
    text: string;
    owner?: string;
    dueDate?: string;
  }>;
  topics?: string[];
  participants?: string[];
  generatedAt: string;
  source: 'agent' | 'manual';
}

export interface RecallUploadInput {
  liveTranscript?: boolean;
  /** Region already initialized by the Desktop SDK for this capture. This is
   * capture-scoped and must not mutate the user's persisted default. */
  region?: RecallRegion;
}

export interface RecallUploadToken {
  /** @deprecated This is an SDK upload id, not a recording id. */
  id: string;
  sdkUploadId: string;
  region: RecallRegion;
  retentionMode: RecallMeetingSettings['retentionMode'];
  retentionHours: number;
  uploadToken: string;
  apiUrl: string;
}

const SETTINGS_FILE = path.join(BASE_DIR, 'state', 'meeting-capture', 'recall-settings.json');
const RECORDS_DIR = path.join(BASE_DIR, 'state', 'meeting-capture', 'recall-recordings');
const ANALYSIS_DIR = path.join(BASE_DIR, 'state', 'meeting-capture', 'analysis');
const VAULT_MEETINGS_DIR = path.join(VAULT_DIR, '04-Meetings');

export const RECALL_REGIONS: Record<RecallRegion, string> = {
  'us-west-2': 'https://us-west-2.recall.ai',
  'us-east-1': 'https://us-east-1.recall.ai',
  'eu-central-1': 'https://eu-central-1.recall.ai',
  'ap-northeast-1': 'https://ap-northeast-1.recall.ai',
};

export function isRecallRegion(value: unknown): value is RecallRegion {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RECALL_REGIONS, value);
}

export const DEFAULT_RECALL_MEETING_SETTINGS: RecallMeetingSettings = {
  enabled: false,
  region: 'us-west-2',
  autoRecord: false,
  liveTranscript: false,
  analyzeOnComplete: true,
  // One day keeps canonical-backfill available while preventing the
  // post-2025 Recall default of retaining media forever.
  retentionMode: 'timed',
  retentionHours: 24,
};

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
  renameSync(tmp, filePath);
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || `recall-${randomBytes(4).toString('hex')}`;
}

function recordPath(recordKey: string): string {
  return path.join(RECORDS_DIR, `${safeId(recordKey)}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function isSyntheticRecallCapture(record: Pick<RecallMeetingRecord, 'windowId' | 'platform' | 'title'>): boolean {
  return [record.windowId, record.platform, record.title]
    .filter(Boolean)
    .some((value) => /\b(smoke|synthetic|test-fixture|fixture)\b/i.test(String(value)));
}

function normalizeSettings(input: Partial<RecallMeetingSettings> | undefined): RecallMeetingSettings {
  const region = isRecallRegion(input?.region) ? input.region : DEFAULT_RECALL_MEETING_SETTINGS.region;
  const retentionMode = input?.retentionMode === 'zero' ? 'zero' : 'timed';
  const retentionHours = Number.isFinite(input?.retentionHours)
    ? Math.max(1, Math.min(24 * 30, Math.round(input?.retentionHours as number)))
    : DEFAULT_RECALL_MEETING_SETTINGS.retentionHours;
  return {
    enabled: Boolean(input?.enabled),
    region,
    autoRecord: Boolean(input?.autoRecord),
    // Zero retention has no post-call media to recover. Realtime transcript
    // delivery is therefore mandatory or the meeting is guaranteed to end
    // without any transcript at all.
    liveTranscript: retentionMode === 'zero' ? true : Boolean(input?.liveTranscript),
    analyzeOnComplete: input?.analyzeOnComplete !== false,
    retentionMode,
    retentionHours,
  };
}

export function loadRecallMeetingSettings(): RecallMeetingSettings {
  if (!existsSync(SETTINGS_FILE)) return DEFAULT_RECALL_MEETING_SETTINGS;
  try {
    return normalizeSettings(JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')) as Partial<RecallMeetingSettings>);
  } catch {
    return DEFAULT_RECALL_MEETING_SETTINGS;
  }
}

export function saveRecallMeetingSettings(patch: Partial<RecallMeetingSettings>): RecallMeetingSettings {
  const current = loadRecallMeetingSettings();
  const next = normalizeSettings({ ...current, ...patch });
  writeJsonAtomic(SETTINGS_FILE, next);
  return next;
}

export function recallApiUrl(region: RecallRegion): string {
  return RECALL_REGIONS[region] ?? RECALL_REGIONS['us-west-2'];
}

export function recallAuthorizationHeader(apiKey: string): string {
  if (/^(token|bearer)\s+/i.test(apiKey)) return apiKey;
  return `Token ${apiKey}`;
}

export function buildRecallSdkUploadBody(input: RecallUploadInput, settings: RecallMeetingSettings): Record<string, unknown> {
  const recordingConfig: Record<string, unknown> = {
    retention: settings.retentionMode === 'zero'
      ? null
      : { type: 'timed', hours: settings.retentionHours },
  };
  if (input.liveTranscript || settings.retentionMode === 'zero') {
    Object.assign(recordingConfig, {
      transcript: {
        provider: {
          recallai_streaming: {
            mode: 'prioritize_low_latency',
            language_code: 'en',
          },
        },
      },
      realtime_endpoints: [
        {
          type: 'desktop_sdk_callback',
          events: ['participant_events.join', 'participant_events.update', 'transcript.data', 'transcript.partial_data'],
        },
      ],
    });
  }
  return { recording_config: recordingConfig };
}

export async function createRecallSdkUpload(input: RecallUploadInput = {}): Promise<RecallUploadToken> {
  if (input.region !== undefined && !isRecallRegion(input.region)) {
    throw new Error(`Unsupported Recall region "${String(input.region)}".`);
  }
  const apiKey = await readSecret('recall_api_key');
  if (!apiKey) {
    throw new Error('Recall.ai API key is not configured.');
  }

  const persistedSettings = loadRecallMeetingSettings();
  // A region change can race SDK reinitialization. Use the exact region the
  // desktop initialized for this upload without rewriting the persisted
  // default, so token creation and the native SDK always agree atomically.
  const settings: RecallMeetingSettings = input.region
    ? { ...persistedSettings, region: input.region }
    : persistedSettings;
  const apiUrl = recallApiUrl(settings.region);
  const response = await fetch(`${apiUrl}/api/v1/sdk_upload/`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: recallAuthorizationHeader(apiKey),
    },
    body: JSON.stringify(buildRecallSdkUploadBody(input, settings)),
  });

  const payload = await response.json().catch(() => ({})) as { id?: string; upload_token?: string; uploadToken?: string; detail?: unknown; error?: unknown };
  if (!response.ok) {
    const reason = typeof payload.detail === 'string'
      ? payload.detail
      : typeof payload.error === 'string'
        ? payload.error
        : `${response.status} ${response.statusText}`;
    throw new Error(`Recall.ai upload token request failed: ${reason}`);
  }

  const uploadToken = payload.upload_token ?? payload.uploadToken;
  if (!uploadToken) {
    throw new Error('Recall.ai upload token response did not include upload_token.');
  }
  if (!payload.id) {
    throw new Error('Recall.ai upload token response did not include its SDK upload id.');
  }

  return {
    id: payload.id,
    sdkUploadId: payload.id,
    region: settings.region,
    retentionMode: settings.retentionMode,
    retentionHours: settings.retentionHours,
    uploadToken,
    apiUrl,
  };
}

function readMeetingRecordFile(filePath: string): RecallMeetingRecord | null {
  if (!existsSync(filePath)) return null;
  try { return JSON.parse(readFileSync(filePath, 'utf-8')) as RecallMeetingRecord; }
  catch { return null; }
}

function readStoredMeetingRecords(): Array<{ filePath: string; record: RecallMeetingRecord }> {
  if (!existsSync(RECORDS_DIR)) return [];
  const records: Array<{ filePath: string; record: RecallMeetingRecord }> = [];
  try {
    for (const entry of readdirSync(RECORDS_DIR)) {
      if (!entry.endsWith('.json')) continue;
      const filePath = path.join(RECORDS_DIR, entry);
      const record = readMeetingRecordFile(filePath);
      if (record?.id) records.push({ filePath, record });
    }
  } catch { /* directory may disappear during shutdown */ }
  return records;
}

function loadMeetingRecord(windowId: string, recordingId?: string, sdkUploadId?: string): RecallMeetingRecord | null {
  if (recordingId) {
    const byRecording = readMeetingRecordFile(recordPath(recordingId));
    if (byRecording) return byRecording;
  }
  if (sdkUploadId) {
    const byUpload = readMeetingRecordFile(recordPath(sdkUploadId));
    if (byUpload) return byUpload;
  }

  const stored = readStoredMeetingRecords();
  if (recordingId) {
    const byRecording = stored.find(({ record }) => record.recordingId === recordingId)?.record;
    if (byRecording) return byRecording;
  }
  if (sdkUploadId) {
    const byUpload = stored.find(({ record }) => record.sdkUploadId === sdkUploadId)?.record;
    if (byUpload) return byUpload;
  }

  const legacyWindowRecord = readMeetingRecordFile(recordPath(windowId));
  if (legacyWindowRecord) {
    // A window-keyed record from an older Clementine build may be adopted only
    // when it has no conflicting capture identity. Never merge a second SDK
    // upload merely because Zoom/Meet reused the same native window id.
    const recordingMatches = !recordingId
      || !legacyWindowRecord.recordingId
      || legacyWindowRecord.recordingId === recordingId;
    const uploadMatches = !sdkUploadId
      || !legacyWindowRecord.sdkUploadId
      || legacyWindowRecord.sdkUploadId === sdkUploadId;
    if (recordingMatches && uploadMatches) return legacyWindowRecord;
  }

  // Legacy/id-less realtime events still need a deterministic active record.
  // Exact recording/sdk identities above remain authoritative; this fallback
  // never reuses a completed meeting for a new identified capture.
  if (!recordingId && !sdkUploadId) {
    return stored
      .map(({ record }) => record)
      .filter((record) => record.windowId === windowId && record.status === 'recording')
      .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))[0] ?? null;
  }
  if (recordingId && !sdkUploadId) {
    const sameWindow = stored
      .map(({ record }) => record)
      .filter((record) => record.windowId === windowId)
      .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    const active = sameWindow.filter((record) => record.status === 'recording');
    // Older desktop payloads did not include sdkUploadId on realtime/final
    // events. Adopt only an unambiguous window session; two completed pending
    // uploads are deliberately left separate rather than guessed/merged.
    if (active.length === 1) return active[0];
    if (sameWindow.length === 1) return sameWindow[0];
  }
  return null;
}

function saveMeetingRecord(record: RecallMeetingRecord): RecallMeetingRecord {
  const targetPath = recordPath(record.recordingId || record.sdkUploadId || record.windowId);
  writeJsonAtomic(targetPath, record);
  // recordingId arrival migrates an SDK-keyed record, while upgrades may
  // migrate a legacy window-keyed placeholder. Remove only aliases for this
  // exact meeting id so another session in the same window is never deleted.
  for (const stored of readStoredMeetingRecords()) {
    if (stored.filePath === targetPath || stored.record.id !== record.id) continue;
    try { unlinkSync(stored.filePath); } catch { /* best-effort alias cleanup */ }
  }
  return record;
}

export function noteRecallMeetingDetected(input: {
  windowId: string;
  provider?: RecallMeetingRecord['provider'];
  source?: RecallMeetingRecord['source'];
  sdkUploadId?: string;
  sdkUploadRegion?: RecallRegion;
  recordingId?: string;
  platform?: string;
  title?: string;
  status?: RecallMeetingRecord['status'];
  startedAt?: string;
  endedAt?: string;
  audioPath?: string;
  audioDurationSeconds?: number;
  audioBytes?: number;
  transcriptionStatus?: RecallMeetingRecord['transcriptionStatus'];
  transcriptionModel?: string;
  transcriptionLanguage?: string;
  recallRetentionMode?: RecallMeetingSettings['retentionMode'];
  recallRetentionHours?: number;
}): RecallMeetingRecord {
  const existing = loadMeetingRecord(input.windowId, input.recordingId, input.sdkUploadId);
  const record: RecallMeetingRecord = {
    id: existing?.id ?? `${input.provider === 'local' ? 'local' : 'recall'}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    windowId: input.windowId,
    provider: input.provider ?? existing?.provider ?? 'recall',
    source: input.source ?? existing?.source ?? 'recall-desktop-sdk',
    sdkUploadId: input.sdkUploadId ?? existing?.sdkUploadId,
    // Once an upload is created its data region is immutable. Later
    // completion/UI payloads may reflect a newly selected default region and
    // must not retarget this already-created SDK upload.
    sdkUploadRegion: existing?.sdkUploadRegion ?? input.sdkUploadRegion,
    sdkUploadStatus: existing?.sdkUploadStatus,
    sdkUploadUpdatedAt: existing?.sdkUploadUpdatedAt,
    sdkUploadError: existing?.sdkUploadError,
    sdkUploadAttempts: existing?.sdkUploadAttempts,
    sdkUploadNextAttemptAt: existing?.sdkUploadNextAttemptAt,
    sdkUploadDeadlineAt: existing?.sdkUploadDeadlineAt,
    recordingId: input.recordingId ?? existing?.recordingId,
    // Like region, retention is fixed in the Create SDK Upload request. A
    // settings change later in the meeting must not rewrite that contract.
    recallRetentionMode: existing?.recallRetentionMode ?? input.recallRetentionMode,
    recallRetentionHours: existing?.recallRetentionHours ?? input.recallRetentionHours,
    platform: input.platform ?? existing?.platform,
    title: input.title ?? existing?.title,
    titleSource: existing?.titleSource,
    status: input.status ?? existing?.status ?? 'detected',
    startedAt: existing?.startedAt ?? input.startedAt ?? nowIso(),
    endedAt: input.endedAt ?? existing?.endedAt,
    segments: existing?.segments ?? [],
    artifactPath: existing?.artifactPath,
    analysisPath: existing?.analysisPath,
    canonicalStatus: existing?.canonicalStatus,
    canonicalUpdatedAt: existing?.canonicalUpdatedAt,
    canonicalError: existing?.canonicalError,
    audioPath: input.audioPath ?? existing?.audioPath,
    audioDurationSeconds: input.audioDurationSeconds ?? existing?.audioDurationSeconds,
    audioBytes: input.audioBytes ?? existing?.audioBytes,
    transcriptionStatus: input.transcriptionStatus ?? existing?.transcriptionStatus,
    transcriptionUpdatedAt: existing?.transcriptionUpdatedAt,
    transcriptionError: existing?.transcriptionError,
    transcriptionModel: input.transcriptionModel ?? existing?.transcriptionModel,
    transcriptionLanguage: input.transcriptionLanguage ?? existing?.transcriptionLanguage,
    audioDeletionStatus: existing?.audioDeletionStatus,
    audioDeletionUpdatedAt: existing?.audioDeletionUpdatedAt,
    audioDeletionError: existing?.audioDeletionError,
    audioDeletionAttempts: existing?.audioDeletionAttempts,
    analysisTaskId: existing?.analysisTaskId,
    analysisError: existing?.analysisError,
    analysisUpdatedAt: existing?.analysisUpdatedAt,
  };
  return saveMeetingRecord(record);
}

export function appendRecallTranscriptSegment(input: Omit<RecallTranscriptSegment, 'id' | 'timestamp'> & {
  timestamp?: string;
  sdkUploadId?: string;
}): RecallMeetingRecord {
  const record = noteRecallMeetingDetected({
    windowId: input.windowId,
    sdkUploadId: input.sdkUploadId,
    recordingId: input.recordingId,
    status: 'recording',
  });
  const text = input.text.replace(/\s+/g, ' ').trim();
  if (!text) return record;
  const segment: RecallTranscriptSegment = {
    id: `seg-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    windowId: input.windowId,
    recordingId: input.recordingId,
    event: input.event,
    speaker: input.speaker,
    text,
    timestamp: input.timestamp ?? nowIso(),
    isFinal: input.isFinal,
  };
  const updated: RecallMeetingRecord = {
    ...record,
    status: 'recording',
    segments: [...record.segments, segment],
  };
  return saveMeetingRecord(updated);
}

/**
 * Render the meeting's transcript markdown body from its current
 * segments. Exposed so the canonical-transcript backfill can rewrite
 * the file with real participant names once the async transcript lands,
 * using the exact same layout — keeps the dashboard / vault reader
 * stable across the streamed→canonical transition.
 */
// Delimiters for the analyzer-derived block folded into the vault note
// by fileMeetingFromAnalysis. Bumping the version forces the reconcile
// tick to re-file existing notes (e.g. when the rendered shape changes).
// The marker is what the reconcile tick greps for to decide "already
// filed?" without re-reading/parsing the whole analysis.
const ANALYSIS_BLOCK_START = '<!-- clem:analysis:start v1 -->';
const ANALYSIS_BLOCK_END = '<!-- clem:analysis:end -->';

/**
 * Render the analyzer-derived section (summary / decisions / action items
 * / topics / participants) as markdown lines, wrapped in the managed-block
 * markers. Returns [] when there's nothing worth folding in. Kept separate
 * so the indexer sees the SAME high-signal text the dashboard shows from
 * the analysis JSON — that's what makes meetings searchable by outcome,
 * not just by raw transcript.
 */
function renderAnalysisSection(analysis: RecallMeetingAnalysis | null | undefined): string[] {
  if (!analysis) return [];
  const lines: string[] = [ANALYSIS_BLOCK_START];
  if (analysis.summary) {
    lines.push('## Summary', analysis.summary);
  }
  if (analysis.decisions && analysis.decisions.length > 0) {
    lines.push('## Decisions', ...analysis.decisions.map((d) => `- ${d}`));
  }
  if (analysis.actionItems && analysis.actionItems.length > 0) {
    lines.push('## Action Items', ...analysis.actionItems.map((a) => {
      const meta = [a.owner ? `owner: ${a.owner}` : '', a.dueDate ? `due: ${a.dueDate}` : '']
        .filter(Boolean).join(', ');
      return `- ${a.text}${meta ? ` (${meta})` : ''}`;
    }));
  }
  if (analysis.topics && analysis.topics.length > 0) {
    lines.push('## Topics', analysis.topics.join(', '));
  }
  if (analysis.participants && analysis.participants.length > 0) {
    lines.push('## Participants', analysis.participants.join(', '));
  }
  lines.push(ANALYSIS_BLOCK_END);
  // Nothing but the markers ⇒ no analysis content worth folding in.
  return lines.length > 2 ? lines : [];
}

function renderTranscriptArtifactBody(
  record: RecallMeetingRecord,
  sourceLabel: string,
  analysis?: RecallMeetingAnalysis | null,
): string {
  const transcriptText = record.segments
    .map((segment) => `[${segment.timestamp}] ${segment.speaker ? `${segment.speaker}: ` : ''}${segment.text}`)
    .join('\n');
  return [
    '---',
    `type: meeting-transcript`,
    `source: ${sourceLabel}`,
    `provider: ${record.provider ?? 'recall'}`,
    `meeting_id: ${record.id}`,
    `window_id: ${record.windowId}`,
    record.sdkUploadId ? `sdk_upload_id: ${record.sdkUploadId}` : '',
    record.sdkUploadRegion ? `sdk_upload_region: ${record.sdkUploadRegion}` : '',
    record.recordingId ? `recording_id: ${record.recordingId}` : '',
    record.platform ? `platform: ${record.platform}` : '',
    record.title ? `title: ${record.title}` : '',
    `started_at: ${record.startedAt}`,
    record.endedAt ? `ended_at: ${record.endedAt}` : '',
    record.transcriptionModel ? `transcription_model: ${record.transcriptionModel}` : '',
    '---',
    '',
    `# ${record.title || 'Meeting Capture'}`,
    '',
    ...renderAnalysisSection(analysis),
    '## Capture',
    '',
    `- Source: ${sourceLabel}`,
    record.platform ? `- Platform: ${record.platform}` : '',
    `- Segments: ${record.segments.length}`,
    '- Note: synthetic/test captures are filtered before vault promotion.',
    '',
    '## Transcript',
    '',
    transcriptText,
    '',
  ].filter((line) => line !== '').join('\n');
}

function defaultArtifactPath(record: RecallMeetingRecord): string {
  ensureDir(VAULT_MEETINGS_DIR);
  const date = record.startedAt.slice(0, 10);
  const label = safeId((record.title || record.platform || record.id).toLowerCase()).slice(0, 60);
  return path.join(VAULT_MEETINGS_DIR, `${date}-${label}-${safeId(record.id)}.md`);
}

export function finalizeRecallMeeting(input: {
  windowId: string;
  sdkUploadId?: string;
  sdkUploadRegion?: RecallRegion;
  recordingId?: string;
  platform?: string;
  title?: string;
  retentionMode?: RecallMeetingSettings['retentionMode'];
  retentionHours?: number;
  /** False for zero-retention uploads, whose media cannot be backfilled. */
  canonicalBackfill?: boolean;
}): { record: RecallMeetingRecord; artifactPath?: string; segmentCount: number; transcriptText: string } {
  const record = noteRecallMeetingDetected({
    windowId: input.windowId,
    sdkUploadId: input.sdkUploadId,
    sdkUploadRegion: input.sdkUploadRegion,
    recordingId: input.recordingId,
    platform: input.platform,
    title: input.title,
    status: 'completed',
    recallRetentionMode: input.retentionMode,
    recallRetentionHours: input.retentionHours,
  });
  const hasRecordingId = Boolean(input.recordingId ?? record.recordingId);
  const hasSdkUploadId = Boolean(input.sdkUploadId ?? record.sdkUploadId);
  const canonicalBackfill = record.recallRetentionMode !== 'zero' && input.canonicalBackfill !== false;
  const completed: RecallMeetingRecord = {
    ...record,
    endedAt: nowIso(),
    status: 'completed',
    // Recordings with a recordingId qualify for a canonical-transcript
    // backfill. The actual backfill is kicked off by the
    // /api/console/meetings/recall/complete route after this function
    // returns, so we just stamp the intent here.
    canonicalStatus: hasRecordingId && canonicalBackfill ? 'pending' : 'not_started',
    canonicalUpdatedAt: nowIso(),
    // A recording id can surface in realtime events before the upload itself
    // is terminal. The authenticated SDK-upload reconciler is the sole owner
    // of transitioning this to `complete`.
    sdkUploadStatus: hasSdkUploadId ? 'pending' : record.sdkUploadStatus,
    sdkUploadUpdatedAt: hasSdkUploadId ? nowIso() : record.sdkUploadUpdatedAt,
    sdkUploadError: undefined,
  };

  const transcriptText = completed.segments
    .map((segment) => `[${segment.timestamp}] ${segment.speaker ? `${segment.speaker}: ` : ''}${segment.text}`)
    .join('\n');

  let artifactPath: string | undefined;
  if (completed.segments.length > 0 && !isSyntheticRecallCapture(completed)) {
    artifactPath = defaultArtifactPath(completed);
    const body = renderTranscriptArtifactBody(completed, 'recall.ai-desktop-sdk (streamed)');
    writeFileSync(artifactPath, body, 'utf-8');
  }

  const saved = saveMeetingRecord({ ...completed, artifactPath });
  return { record: saved, artifactPath, segmentCount: saved.segments.length, transcriptText };
}

/**
 * Replace a meeting's streamed segments with the canonical, real-name
 * segments parsed from Recall's async transcript download. Rewrites
 * the markdown artifact in place using the same layout so downstream
 * readers don't notice the swap beyond "speakers now have real names
 * and there's no gap where streaming dropped."
 *
 * Returns the updated record + the artifact path so the caller (the
 * background backfill task) can log it.
 */
export function applyCanonicalTranscript(
  record: RecallMeetingRecord,
  canonicalSegments: RecallTranscriptSegment[],
): { record: RecallMeetingRecord; artifactPath?: string } {
  const updated: RecallMeetingRecord = {
    ...record,
    segments: canonicalSegments,
    canonicalStatus: 'ready',
    canonicalUpdatedAt: nowIso(),
    canonicalError: undefined,
  };

  let artifactPath = record.artifactPath;
  if (canonicalSegments.length > 0 && !isSyntheticRecallCapture(updated)) {
    if (!artifactPath) artifactPath = defaultArtifactPath(updated);
    // Preserve any already-filed analysis block when the canonical
    // transcript rewrites the note — otherwise the title + summary would
    // vanish until the next reconcile tick re-files it.
    const body = renderTranscriptArtifactBody(
      updated,
      'recall.ai async transcript (canonical)',
      loadRecallMeetingAnalysis(updated.id),
    );
    writeFileSync(artifactPath, body, 'utf-8');
    updated.artifactPath = artifactPath;
  }

  const saved = saveMeetingRecord(updated);
  return { record: saved, artifactPath };
}

/**
 * Internal helper: mark a meeting record's canonical-transcript backfill
 * as failed or timed out without touching its segments. The streamed
 * transcript stays as the persisted artifact — no regression vs. today.
 */
export function markCanonicalTranscriptIncomplete(
  record: RecallMeetingRecord,
  status: 'timed_out' | 'failed',
  errorMessage?: string,
): RecallMeetingRecord {
  return saveMeetingRecord({
    ...record,
    canonicalStatus: status,
    canonicalUpdatedAt: nowIso(),
    canonicalError: errorMessage,
  });
}

/** Load a meeting record by windowId or recordingId. Exported so the
 *  backfill background task and the dashboard route can both find a
 *  record without knowing which key matched. */
export function findRecallMeetingRecord(opts: { windowId?: string; recordingId?: string; sdkUploadId?: string }): RecallMeetingRecord | null {
  if (opts.recordingId) {
    const byRec = readMeetingRecordFile(recordPath(opts.recordingId));
    if (byRec) return byRec;
    const migrated = readStoredMeetingRecords().find(({ record }) => record.recordingId === opts.recordingId)?.record;
    if (migrated) return migrated;
  }
  if (opts.sdkUploadId) {
    const byUpload = readMeetingRecordFile(recordPath(opts.sdkUploadId));
    if (byUpload) return byUpload;
    const migrated = readStoredMeetingRecords().find(({ record }) => record.sdkUploadId === opts.sdkUploadId)?.record;
    if (migrated) return migrated;
  }
  if (opts.windowId) {
    const byWindow = readMeetingRecordFile(recordPath(opts.windowId));
    if (byWindow) return byWindow;
  }
  return null;
}

function findMeetingRecordByIdIncludingHidden(meetingId: string): RecallMeetingRecord | null {
  return readStoredMeetingRecords().find(({ record }) => record.id === meetingId)?.record ?? null;
}

/** Internal shared-record update used by the local transcription queue. */
export function patchMeetingRecord(
  meetingId: string,
  patch: Partial<Omit<RecallMeetingRecord, 'id' | 'windowId' | 'segments'>> & { segments?: RecallTranscriptSegment[] },
): RecallMeetingRecord | null {
  const existing = findMeetingRecordByIdIncludingHidden(meetingId);
  if (!existing) return null;
  return saveMeetingRecord({ ...existing, ...patch, id: existing.id, windowId: existing.windowId });
}

/** Remove an unneeded/cancelled meeting record from the shared history. */
export function deleteMeetingRecord(meetingId: string): boolean {
  let removed = false;
  for (const stored of readStoredMeetingRecords()) {
    if (stored.record.id !== meetingId) continue;
    try {
      unlinkSync(stored.filePath);
      removed = true;
    } catch { /* report false only when no alias could be removed */ }
  }
  return removed;
}

export interface LocalTranscriptResultSegment {
  text: string;
  startSeconds?: number;
  endSeconds?: number;
  speaker?: string;
}

/**
 * Replace a local meeting's pending audio with its completed Whisper
 * transcript, write the same vault artifact used by Recall meetings, and
 * persist the ready state atomically. No Recall canonical backfill applies.
 */
export function applyLocalMeetingTranscript(input: {
  meetingId: string;
  text: string;
  segments?: LocalTranscriptResultSegment[];
  model: string;
  language?: string;
}): { record: RecallMeetingRecord; artifactPath?: string; transcriptText: string } {
  const existing = findMeetingRecordByIdIncludingHidden(input.meetingId);
  if (!existing || existing.provider !== 'local') {
    throw new Error('Local meeting record not found.');
  }
  const startedMs = Date.parse(existing.startedAt);
  const rawSegments = input.segments && input.segments.length > 0
    ? input.segments
    : (input.text.trim() ? [{ text: input.text.trim(), startSeconds: 0 }] : []);
  const segments: RecallTranscriptSegment[] = rawSegments.flatMap((segment, index) => {
    const text = segment.text.replace(/\s+/g, ' ').trim();
    if (!text) return [];
    const offsetMs = Number.isFinite(segment.startSeconds) ? Math.max(0, segment.startSeconds as number) * 1000 : index;
    return [{
      id: `seg-${Date.now().toString(36)}-${index.toString(36)}-${randomBytes(2).toString('hex')}`,
      windowId: existing.windowId,
      event: 'local.whisper.transcript',
      speaker: segment.speaker,
      text,
      timestamp: Number.isFinite(startedMs) ? new Date(startedMs + offsetMs).toISOString() : nowIso(),
      isFinal: true,
    }];
  });
  const ready: RecallMeetingRecord = {
    ...existing,
    provider: 'local',
    source: 'local-audio',
    status: 'completed',
    endedAt: existing.endedAt ?? nowIso(),
    segments,
    canonicalStatus: 'not_started',
    canonicalUpdatedAt: nowIso(),
    transcriptionStatus: 'ready',
    transcriptionUpdatedAt: nowIso(),
    transcriptionError: undefined,
    transcriptionModel: input.model,
    transcriptionLanguage: input.language ?? existing.transcriptionLanguage,
  };
  let artifactPath = existing.artifactPath;
  if (segments.length > 0 && !isSyntheticRecallCapture(ready)) {
    artifactPath = artifactPath ?? defaultArtifactPath(ready);
    writeFileSync(artifactPath, renderTranscriptArtifactBody(ready, `local whisper (${input.model})`), 'utf-8');
  }
  const record = saveMeetingRecord({ ...ready, artifactPath });
  const transcriptText = segments
    .map((segment) => `[${segment.timestamp}] ${segment.speaker ? `${segment.speaker}: ` : ''}${segment.text}`)
    .join('\n');
  return { record, artifactPath, transcriptText };
}

/**
 * Path the post-meeting analyzer should write its JSON sidecar to.
 * Stable, derived from the meeting id so the dashboard can poll it
 * without coordinating with the background-task runner.
 */
export function analysisPathFor(meetingId: string): string {
  return path.join(ANALYSIS_DIR, `${safeId(meetingId)}.analysis.json`);
}

/**
 * Idempotent — records the analysis path on the meeting record so
 * future reads from the dashboard can find it without filesystem
 * walking. Called by the analyzer prompt's writeback step.
 */
export function recordAnalysisPath(meetingId: string, analysisPath: string): RecallMeetingRecord | null {
  const allRecords = listAllRecallMeetingRecords();
  const target = allRecords.find((r) => r.id === meetingId);
  if (!target) return null;
  return saveMeetingRecord({ ...target, analysisPath });
}

/**
 * Idempotent — set the human-readable title on the meeting record so the
 * dashboard list + filed vault note stop showing the generic
 * platform/type label. Mirrors recordAnalysisPath.
 *
 * `source` records who set it: a 'user' rename is locked (see
 * fileMeetingFromAnalysis), an 'analyzer' title is auto-generated and may
 * be refined later — but never downgrades a 'user' title back to
 * 'analyzer'.
 */
export function recordMeetingTitle(
  meetingId: string,
  title: string,
  source: 'user' | 'analyzer' = 'analyzer',
): RecallMeetingRecord | null {
  const trimmed = title.trim();
  if (!trimmed) return null;
  const target = listAllRecallMeetingRecords().find((r) => r.id === meetingId);
  if (!target) return null;
  // Never let an analyzer pass downgrade or overwrite a user-set title.
  if (source === 'analyzer' && target.titleSource === 'user') return target;
  if (target.title === trimmed && target.titleSource === source) return target;
  return saveMeetingRecord({ ...target, title: trimmed, titleSource: source });
}

/**
 * Re-render a meeting's vault note from its record + (optional) analysis
 * via the shared renderer and write it back if the content changed. The
 * file PATH never changes — only its contents — so the vault index stays
 * consistent (reindex re-chunks by mtime; no orphaned rows). Returns true
 * when it wrote a changed file (caller can trigger a reindex).
 */
function rewriteMeetingArtifact(meetingId: string): boolean {
  const record = loadRecallMeetingById(meetingId);
  if (!record) return false;
  const artifactPath = record.artifactPath && existsSync(record.artifactPath)
    ? record.artifactPath
    : (existsSync(defaultArtifactPath(record)) ? defaultArtifactPath(record) : undefined);
  if (!artifactPath) return false;
  const sourceLabel = record.canonicalStatus === 'ready'
    ? 'recall.ai async transcript (canonical)'
    : record.provider === 'local'
      ? `local whisper (${record.transcriptionModel ?? 'unknown model'})`
      : 'recall.ai-desktop-sdk (streamed)';
  const body = renderTranscriptArtifactBody(record, sourceLabel, loadRecallMeetingAnalysis(meetingId));
  const existing = readFileSync(artifactPath, 'utf-8');
  if (existing === body) return false;
  writeFileSync(artifactPath, body, 'utf-8');
  return true;
}

/**
 * "File" a meeting: fold its analyzer-derived title + summary into the
 * vault note so the existing indexer (reindexVault → embeddings) makes
 * the high-signal content searchable, not just the raw transcript.
 *
 * Deterministic + idempotent: re-renders the whole note from the record +
 * analysis, so re-running produces byte-identical output. A user-set title
 * is never overwritten by the analyzer's title.
 *
 * Returns true when it wrote a changed file (caller can trigger a reindex).
 */
export function fileMeetingFromAnalysis(meetingId: string): boolean {
  const record = loadRecallMeetingById(meetingId);
  if (!record) return false;
  const analysis = loadRecallMeetingAnalysis(meetingId);
  if (!analysis) return false;

  // Adopt the analyzer's title onto the record (recordMeetingTitle refuses
  // to overwrite a user-locked title), then re-render from the record.
  if (analysis.title && analysis.title.trim()) {
    recordMeetingTitle(meetingId, analysis.title, 'analyzer');
  }
  return rewriteMeetingArtifact(meetingId);
}

/**
 * User-driven rename: set a locked 'user' title and re-file the note so
 * the new title shows in the vault frontmatter + heading immediately.
 * Memory-safe — the file path is unchanged, so search/index stay correct.
 * Returns true when the note content changed.
 */
export function renameMeeting(meetingId: string, title: string): boolean {
  if (!recordMeetingTitle(meetingId, title, 'user')) return false;
  return rewriteMeetingArtifact(meetingId);
}

/**
 * Persist a structured analysis (summary, decisions, actions) for a
 * captured meeting. Atomic write; idempotent; updates the meeting
 * record's `analysisPath` so the UI can find it.
 */
export function saveRecallMeetingAnalysis(meetingId: string, analysis: RecallMeetingAnalysis): { path: string } {
  ensureDir(ANALYSIS_DIR);
  const filePath = analysisPathFor(meetingId);
  writeJsonAtomic(filePath, analysis);
  recordAnalysisPath(meetingId, filePath);
  return { path: filePath };
}

export function loadRecallMeetingAnalysis(meetingId: string): RecallMeetingAnalysis | null {
  const filePath = analysisPathFor(meetingId);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as RecallMeetingAnalysis;
  } catch {
    return null;
  }
}

/**
 * Walk the recordings dir and return every captured meeting, newest
 * first. Used by the dashboard's "recent meetings" list. Cheap — even
 * 100 meetings is ~100 small JSON reads.
 */
export function listAllRecallMeetingRecords(): RecallMeetingRecord[] {
  if (!existsSync(RECORDS_DIR)) return [];
  const out: RecallMeetingRecord[] = [];
  try {
    for (const entry of readdirSync(RECORDS_DIR)) {
      if (!entry.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(path.join(RECORDS_DIR, entry), 'utf-8')) as RecallMeetingRecord;
        if (!parsed || !parsed.id) continue;
        // Drop "detected but never recorded" stubs entirely. The SDK
        // fires meeting-detected as soon as Zoom/Meet/Teams opens — even
        // if the user never records — so these stubs accumulate (one per
        // call window the SDK ever saw) and bury the meetings that
        // actually have content. They carry no transcript and aren't
        // actionable from the list (the floating prompt is what offers
        // recording), so the dashboard never shows them. The on-disk
        // file is left alone so a bug investigation can still find them.
        const isEmptyDetected = parsed.status === 'detected' && (parsed.segments?.length ?? 0) === 0;
        if (isEmptyDetected) continue;
        out.push(parsed);
      } catch { /* skip corrupt entries */ }
    }
  } catch { /* dir disappeared between checks */ }
  return out.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
}

export interface RecallMeetingSummary {
  id: string;
  windowId: string;
  provider?: RecallMeetingRecord['provider'];
  source?: RecallMeetingRecord['source'];
  platform?: string;
  title?: string;
  status: RecallMeetingRecord['status'];
  startedAt: string;
  endedAt?: string;
  segmentCount: number;
  artifactPath?: string;
  analysisPath?: string;
  hasAnalysis: boolean;
  durationSeconds?: number;
  audioPath?: string;
  transcriptionStatus?: RecallMeetingRecord['transcriptionStatus'];
  transcriptionError?: string;
  transcriptionModel?: string;
  audioDeletionStatus?: RecallMeetingRecord['audioDeletionStatus'];
  audioDeletionError?: string;
  analysisTaskId?: string;
  analysisError?: string;
  sdkUploadStatus?: RecallMeetingRecord['sdkUploadStatus'];
  sdkUploadError?: string;
}

/**
 * Snapshot of existing analysis JSON files in ANALYSIS_DIR. Cached for
 * 30s so we don't hammer the FS with 70 disk stats every time the
 * dashboard re-renders the meetings list — readdirSync once is much
 * cheaper than 2N existsSync calls where N=meeting count. 30s is short
 * enough that a freshly-written analysis appears in the dashboard's
 * next-but-one render, which is the same latency the polling already
 * has, so no visible regression.
 */
let analysisExistsCache: { at: number; set: Set<string> } | null = null;
const ANALYSIS_CACHE_TTL_MS = 30_000;
function loadAnalysisFileSet(): Set<string> {
  const now = Date.now();
  if (analysisExistsCache && now - analysisExistsCache.at < ANALYSIS_CACHE_TTL_MS) {
    return analysisExistsCache.set;
  }
  const set = new Set<string>();
  try {
    if (existsSync(ANALYSIS_DIR)) {
      for (const entry of readdirSync(ANALYSIS_DIR)) {
        set.add(path.join(ANALYSIS_DIR, entry));
      }
    }
  } catch { /* dir disappeared mid-read */ }
  analysisExistsCache = { at: now, set };
  return set;
}

export function summarizeRecallMeeting(record: RecallMeetingRecord): RecallMeetingSummary {
  let durationSeconds: number | undefined;
  if (record.startedAt && record.endedAt) {
    const ms = Date.parse(record.endedAt) - Date.parse(record.startedAt);
    if (Number.isFinite(ms) && ms > 0) durationSeconds = Math.round(ms / 1000);
  }
  // Analysis path resolution: the agent writes via write_file directly to
  // the canonical path (analysisPathFor(id)) — it doesn't go through
  // saveRecallMeetingAnalysis, so the record itself won't have
  // analysisPath set. Use the cached file set to avoid 2N existsSync
  // calls when rendering the meetings list.
  const canonical = analysisPathFor(record.id);
  const fileSet = loadAnalysisFileSet();
  const resolvedAnalysisPath = record.analysisPath && fileSet.has(record.analysisPath)
    ? record.analysisPath
    : (fileSet.has(canonical) ? canonical : undefined);
  return {
    id: record.id,
    windowId: record.windowId,
    provider: record.provider ?? 'recall',
    source: record.source ?? 'recall-desktop-sdk',
    platform: record.platform,
    title: record.title,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    segmentCount: record.segments?.length ?? 0,
    artifactPath: record.artifactPath,
    analysisPath: resolvedAnalysisPath,
    hasAnalysis: Boolean(resolvedAnalysisPath),
    durationSeconds,
    audioPath: record.audioPath,
    transcriptionStatus: record.transcriptionStatus,
    transcriptionError: record.transcriptionError,
    transcriptionModel: record.transcriptionModel,
    audioDeletionStatus: record.audioDeletionStatus,
    audioDeletionError: record.audioDeletionError,
    analysisTaskId: record.analysisTaskId,
    analysisError: record.analysisError,
    sdkUploadStatus: record.sdkUploadStatus,
    sdkUploadError: record.sdkUploadError,
  };
}

export function listRecentRecallMeetingSummaries(limit = 20): RecallMeetingSummary[] {
  return listAllRecallMeetingRecords().slice(0, Math.max(1, limit)).map(summarizeRecallMeeting);
}

export function loadRecallMeetingById(meetingId: string): RecallMeetingRecord | null {
  return listAllRecallMeetingRecords().find((r) => r.id === meetingId) ?? null;
}

/**
 * Newest activity timestamp for a record — the last segment's timestamp
 * if any segments exist, else startedAt. Used by the stuck-recording
 * reaper to tell an abandoned capture from a live one.
 */
function lastActivityMs(record: RecallMeetingRecord): number {
  const segs = record.segments ?? [];
  const lastSeg = segs.length > 0 ? Date.parse(segs[segs.length - 1]?.timestamp ?? '') : NaN;
  if (Number.isFinite(lastSeg)) return lastSeg;
  const started = Date.parse(record.startedAt ?? '');
  return Number.isFinite(started) ? started : 0;
}

/**
 * Finalize meeting records stuck in `recording` with no transcript
 * activity for a long idle window. Some captures never receive the
 * SDK's `recording-ended`/`meeting-closed` event — notably the
 * desktop-audio fallback, which isn't tied to a meeting window — so
 * they linger in `recording` forever, showing as a perpetual "LIVE"
 * ghost and never producing analysis. A live meeting streams segments
 * continuously, so a long activity gap is a near-certain abandoned
 * capture. We finalize via the normal path (writes the artifact +
 * lets the caller queue analysis), reusing finalizeRecallMeeting.
 *
 * Conservative by design: the idle threshold is long enough that we
 * won't cut off a genuinely active call. If a stray segment arrives
 * after finalize, appendRecallTranscriptSegment simply re-opens the
 * record — no data loss.
 *
 * Returns the finalized records so the daemon tick can queue analysis
 * + reindex for each, mirroring the /complete route.
 */
export function reapStuckRecallRecordings(opts: { idleMs?: number } = {}): Array<{
  record: RecallMeetingRecord;
  artifactPath?: string;
  segmentCount: number;
}> {
  const idleMs = opts.idleMs ?? 60 * 60 * 1000; // 60 min of no transcript activity
  const now = Date.now();
  const finalized: Array<{ record: RecallMeetingRecord; artifactPath?: string; segmentCount: number }> = [];
  for (const record of listAllRecallMeetingRecords()) {
    if (record.status !== 'recording') continue;
    // Local in-person capture has no live transcript heartbeat; a healthy
    // two-hour recording would otherwise look "stuck" after 60 minutes and
    // be finalized underneath Electron while audio is still being written.
    if (record.provider === 'local') continue;
    if (now - lastActivityMs(record) < idleMs) continue;
    const result = finalizeRecallMeeting({
      windowId: record.windowId,
      recordingId: record.recordingId,
      platform: record.platform,
      title: record.title,
    });
    finalized.push({ record: result.record, artifactPath: result.artifactPath, segmentCount: result.segmentCount });
  }
  return finalized;
}

/**
 * The post-meeting analyzer prompt — produces a strict JSON shape we
 * can persist and surface in the UI. Kept here (not in the dashboard
 * route) so the analyzer prompt evolves with the data model.
 */
export function buildAnalyzerPrompt(record: RecallMeetingRecord, artifactPath: string): string {
  const expectedAnalysisPath = analysisPathFor(record.id);
  return [
    record.provider === 'local'
      ? 'You just received a locally recorded and locally transcribed meeting transcript.'
      : 'You just received a meeting transcript captured by the desktop SDK.',
    'Your job: produce a structured analysis the user can act on at a glance.',
    '',
    `Transcript file: ${artifactPath}`,
    `Meeting id: ${record.id}`,
    `Meeting title: ${record.title || '(unknown)'}`,
    `Platform: ${record.platform || '(unknown)'}`,
    `Provider: ${record.provider ?? 'recall'}`,
    `Started: ${record.startedAt}`,
    record.endedAt ? `Ended: ${record.endedAt}` : '',
    '',
    'Steps:',
    '1. Read the transcript file end-to-end.',
    '2. Produce a single JSON object with exactly these keys:',
    '   {',
    '     "title": "concise 4–8 word descriptive title of what the meeting was about",',
    '     "summary": "3–5 sentence overview, neutral tone",',
    '     "decisions": ["decision 1", ...],            // empty array if none',
    '     "actionItems": [                             // empty array if none',
    '       { "text": "what needs to happen", "owner": "person if named, else null", "dueDate": "ISO date or null" }',
    '     ],',
    '     "topics": ["short tag", ...],                // 3–8 topic tags',
    '     "participants": ["name", ...]                // people who spoke',
    '   }',
    `3. Save that JSON to ${expectedAnalysisPath} via write_file.`,
    '4. After saving, return a one-line confirmation message — do NOT include the JSON in your response.',
    '',
    'Hard rules:',
    '- No external API calls, no sending messages, no scheduling — analysis only.',
    '- If the transcript is empty or unintelligible, save a JSON with summary: "Transcript too short to analyze." and empty arrays.',
    '- The JSON must be valid (no trailing commas, no comments).',
  ].filter((line) => line !== '').join('\n');
}

export function buildMeetingChatPrompt(
  record: RecallMeetingRecord,
  analysis: RecallMeetingAnalysis | null = loadRecallMeetingAnalysis(record.id),
): string {
  const transcriptText = record.segments
    .map((segment) => `[${segment.timestamp}] ${segment.speaker ? `${segment.speaker}: ` : ''}${segment.text}`)
    .join('\n');
  const lines = [
    'Please summarize this captured meeting for me, then ask what I want you to act on from it.',
    '',
    'Important rules:',
    '- Read the FULL transcript end-to-end before summarizing. Do not rely only on the analysis summary or meeting title.',
    '- Use the transcript as the source of truth if the summary and transcript disagree.',
    '- After the summary, name 1-3 likely follow-up tasks if the transcript supports them. If it does not, say you do not see obvious follow-up tasks.',
    '- End with one first-person follow-up question: "What would you like me to act on?" Do not refer to yourself as Clementine in that question.',
    '- Do not send messages, schedule events, update sheets, or create tasks unless I explicitly ask for those actions after the summary.',
    '',
    `Meeting id: ${record.id}`,
    `Meeting title: ${record.title || '(untitled meeting)'}`,
    `Platform: ${record.platform || '(unknown)'}`,
    `Provider: ${record.provider ?? 'recall'}`,
    record.startedAt ? `Started: ${record.startedAt}` : '',
    record.endedAt ? `Ended: ${record.endedAt}` : '',
    record.artifactPath
      ? `Full transcript file: ${record.artifactPath}`
      : 'Full transcript file: (not available; use the inline transcript below)',
    '',
    analysis?.summary
      ? [
        'Existing machine summary for context only; verify against the full transcript:',
        analysis.summary,
      ].join('\n')
      : '',
    analysis?.decisions?.length
      ? ['Existing extracted decisions for context only:', ...analysis.decisions.map((item) => `- ${item}`)].join('\n')
      : '',
    analysis?.actionItems?.length
      ? [
        'Existing extracted action items for context only:',
        ...analysis.actionItems.map((item) => {
          const meta = [item.owner ? `owner: ${item.owner}` : '', item.dueDate ? `due: ${item.dueDate}` : '']
            .filter(Boolean)
            .join(', ');
          return `- ${item.text}${meta ? ` (${meta})` : ''}`;
        }),
      ].join('\n')
      : '',
    record.artifactPath ? '' : ['Inline full transcript:', transcriptText || '(empty transcript)'].join('\n'),
  ];
  return lines.filter((line) => line !== '').join('\n');
}
