import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  recordingId?: string;
  platform?: string;
  title?: string;
  status: 'detected' | 'recording' | 'completed';
  startedAt: string;
  endedAt?: string;
  segments: RecallTranscriptSegment[];
  artifactPath?: string;
}

export interface RecallUploadInput {
  liveTranscript?: boolean;
}

export interface RecallUploadToken {
  id?: string;
  uploadToken: string;
  apiUrl: string;
}

const SETTINGS_FILE = path.join(BASE_DIR, 'state', 'meeting-capture', 'recall-settings.json');
const RECORDS_DIR = path.join(BASE_DIR, 'state', 'meeting-capture', 'recall-recordings');
const VAULT_MEETINGS_DIR = path.join(VAULT_DIR, '04-Meetings');

export const RECALL_REGIONS: Record<RecallRegion, string> = {
  'us-west-2': 'https://us-west-2.recall.ai',
  'us-east-1': 'https://us-east-1.recall.ai',
  'eu-central-1': 'https://eu-central-1.recall.ai',
  'ap-northeast-1': 'https://ap-northeast-1.recall.ai',
};

export const DEFAULT_RECALL_MEETING_SETTINGS: RecallMeetingSettings = {
  enabled: false,
  region: 'us-west-2',
  autoRecord: false,
  liveTranscript: false,
  analyzeOnComplete: true,
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

function recordPath(windowId: string): string {
  return path.join(RECORDS_DIR, `${safeId(windowId)}.json`);
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
  const region = input?.region && input.region in RECALL_REGIONS ? input.region : DEFAULT_RECALL_MEETING_SETTINGS.region;
  return {
    enabled: Boolean(input?.enabled),
    region,
    autoRecord: Boolean(input?.autoRecord),
    liveTranscript: Boolean(input?.liveTranscript),
    analyzeOnComplete: input?.analyzeOnComplete !== false,
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

function recallAuthorizationHeader(apiKey: string): string {
  if (/^(token|bearer)\s+/i.test(apiKey)) return apiKey;
  return `Token ${apiKey}`;
}

function buildUploadBody(input: RecallUploadInput): Record<string, unknown> {
  if (!input.liveTranscript) return {};
  return {
    recording_config: {
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
    },
  };
}

export async function createRecallSdkUpload(input: RecallUploadInput = {}): Promise<RecallUploadToken> {
  const apiKey = await readSecret('recall_api_key');
  if (!apiKey) {
    throw new Error('Recall.ai API key is not configured.');
  }

  const settings = loadRecallMeetingSettings();
  const apiUrl = recallApiUrl(settings.region);
  const response = await fetch(`${apiUrl}/api/v1/sdk_upload/`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: recallAuthorizationHeader(apiKey),
    },
    body: JSON.stringify(buildUploadBody(input)),
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

  return { id: payload.id, uploadToken, apiUrl };
}

function loadMeetingRecord(windowId: string): RecallMeetingRecord | null {
  const filePath = recordPath(windowId);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as RecallMeetingRecord;
  } catch {
    return null;
  }
}

function saveMeetingRecord(record: RecallMeetingRecord): RecallMeetingRecord {
  writeJsonAtomic(recordPath(record.windowId), record);
  return record;
}

export function noteRecallMeetingDetected(input: {
  windowId: string;
  recordingId?: string;
  platform?: string;
  title?: string;
  status?: RecallMeetingRecord['status'];
}): RecallMeetingRecord {
  const existing = loadMeetingRecord(input.windowId);
  const record: RecallMeetingRecord = {
    id: existing?.id ?? `recall-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    windowId: input.windowId,
    recordingId: input.recordingId ?? existing?.recordingId,
    platform: input.platform ?? existing?.platform,
    title: input.title ?? existing?.title,
    status: input.status ?? existing?.status ?? 'detected',
    startedAt: existing?.startedAt ?? nowIso(),
    endedAt: existing?.endedAt,
    segments: existing?.segments ?? [],
    artifactPath: existing?.artifactPath,
  };
  return saveMeetingRecord(record);
}

export function appendRecallTranscriptSegment(input: Omit<RecallTranscriptSegment, 'id' | 'timestamp'> & { timestamp?: string }): RecallMeetingRecord {
  const record = noteRecallMeetingDetected({ windowId: input.windowId, recordingId: input.recordingId, status: 'recording' });
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

export function finalizeRecallMeeting(input: {
  windowId: string;
  recordingId?: string;
  platform?: string;
  title?: string;
}): { record: RecallMeetingRecord; artifactPath?: string; segmentCount: number; transcriptText: string } {
  const record = noteRecallMeetingDetected({
    windowId: input.windowId,
    recordingId: input.recordingId,
    platform: input.platform,
    title: input.title,
    status: 'completed',
  });
  const completed: RecallMeetingRecord = {
    ...record,
    endedAt: nowIso(),
    status: 'completed',
  };

  const transcriptText = completed.segments
    .map((segment) => `[${segment.timestamp}] ${segment.speaker ? `${segment.speaker}: ` : ''}${segment.text}`)
    .join('\n');

  let artifactPath: string | undefined;
  if (completed.segments.length > 0 && !isSyntheticRecallCapture(completed)) {
    ensureDir(VAULT_MEETINGS_DIR);
    const date = completed.startedAt.slice(0, 10);
    const label = safeId((completed.title || completed.platform || completed.id).toLowerCase()).slice(0, 60);
    artifactPath = path.join(VAULT_MEETINGS_DIR, `${date}-${label}-${safeId(completed.id)}.md`);
    const body = [
      '---',
      `type: meeting-transcript`,
      `source: recall.ai-desktop-sdk`,
      `meeting_id: ${completed.id}`,
      `window_id: ${completed.windowId}`,
      completed.recordingId ? `recording_id: ${completed.recordingId}` : '',
      completed.platform ? `platform: ${completed.platform}` : '',
      `started_at: ${completed.startedAt}`,
      `ended_at: ${completed.endedAt}`,
      '---',
      '',
      `# ${completed.title || 'Meeting Capture'}`,
      '',
      '## Capture',
      '',
      `- Source: Recall.ai Desktop Recording SDK`,
      completed.platform ? `- Platform: ${completed.platform}` : '',
      `- Segments: ${completed.segments.length}`,
      '- Note: synthetic/test captures are filtered before vault promotion.',
      '',
      '## Transcript',
      '',
      transcriptText,
      '',
    ].filter((line) => line !== '').join('\n');
    writeFileSync(artifactPath, body, 'utf-8');
  }

  const saved = saveMeetingRecord({ ...completed, artifactPath });
  return { record: saved, artifactPath, segmentCount: saved.segments.length, transcriptText };
}
