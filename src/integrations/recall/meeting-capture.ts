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
  /** Who set `title`. 'user' titles are locked — the analyzer / auto-filing
   *  never overwrites them. Absent/'analyzer' means auto-generated and
   *  safe to refine. */
  titleSource?: 'user' | 'analyzer';
  status: 'detected' | 'recording' | 'completed';
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
}

export interface RecallUploadToken {
  id?: string;
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

export function recallAuthorizationHeader(apiKey: string): string {
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

function readMeetingRecordFile(filePath: string): RecallMeetingRecord | null {
  if (!existsSync(filePath)) return null;
  try { return JSON.parse(readFileSync(filePath, 'utf-8')) as RecallMeetingRecord; }
  catch { return null; }
}

function loadMeetingRecord(windowId: string, recordingId?: string): RecallMeetingRecord | null {
  if (recordingId) {
    const byRecording = readMeetingRecordFile(recordPath(recordingId));
    if (byRecording) return byRecording;
  }
  return readMeetingRecordFile(recordPath(windowId));
}

function saveMeetingRecord(record: RecallMeetingRecord): RecallMeetingRecord {
  const targetPath = recordPath(record.recordingId || record.windowId);
  writeJsonAtomic(targetPath, record);
  if (record.recordingId) {
    const placeholderPath = recordPath(record.windowId);
    if (placeholderPath !== targetPath) {
      const placeholder = readMeetingRecordFile(placeholderPath);
      if (placeholder && (
        placeholder.id === record.id ||
        (placeholder.status === 'detected' && (placeholder.segments?.length ?? 0) === 0)
      )) {
        try { unlinkSync(placeholderPath); } catch { /* best-effort placeholder cleanup */ }
      }
    }
  }
  return record;
}

export function noteRecallMeetingDetected(input: {
  windowId: string;
  recordingId?: string;
  platform?: string;
  title?: string;
  status?: RecallMeetingRecord['status'];
}): RecallMeetingRecord {
  const existing = loadMeetingRecord(input.windowId, input.recordingId);
  const record: RecallMeetingRecord = {
    id: existing?.id ?? `recall-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    windowId: input.windowId,
    recordingId: input.recordingId ?? existing?.recordingId,
    platform: input.platform ?? existing?.platform,
    title: input.title ?? existing?.title,
    titleSource: existing?.titleSource,
    status: input.status ?? existing?.status ?? 'detected',
    startedAt: existing?.startedAt ?? nowIso(),
    endedAt: existing?.endedAt,
    segments: existing?.segments ?? [],
    artifactPath: existing?.artifactPath,
    analysisPath: existing?.analysisPath,
    canonicalStatus: existing?.canonicalStatus,
    canonicalUpdatedAt: existing?.canonicalUpdatedAt,
    canonicalError: existing?.canonicalError,
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
    `meeting_id: ${record.id}`,
    `window_id: ${record.windowId}`,
    record.recordingId ? `recording_id: ${record.recordingId}` : '',
    record.platform ? `platform: ${record.platform}` : '',
    record.title ? `title: ${record.title}` : '',
    `started_at: ${record.startedAt}`,
    record.endedAt ? `ended_at: ${record.endedAt}` : '',
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
    // Recordings with a recordingId qualify for a canonical-transcript
    // backfill. The actual backfill is kicked off by the
    // /api/console/meetings/recall/complete route after this function
    // returns, so we just stamp the intent here.
    canonicalStatus: input.recordingId ? 'pending' : 'not_started',
    canonicalUpdatedAt: nowIso(),
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
export function findRecallMeetingRecord(opts: { windowId?: string; recordingId?: string }): RecallMeetingRecord | null {
  if (opts.recordingId) {
    const byRec = readMeetingRecordFile(recordPath(opts.recordingId));
    if (byRec) return byRec;
  }
  if (opts.windowId) {
    return readMeetingRecordFile(recordPath(opts.windowId));
  }
  return null;
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
    'You just received a meeting transcript captured by the desktop SDK.',
    'Your job: produce a structured analysis the user can act on at a glance.',
    '',
    `Transcript file: ${artifactPath}`,
    `Meeting id: ${record.id}`,
    `Meeting title: ${record.title || '(unknown)'}`,
    `Platform: ${record.platform || '(unknown)'}`,
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
