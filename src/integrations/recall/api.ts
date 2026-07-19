/**
 * Recall.ai REST API client — the bits Clementine needs to fetch the
 * authoritative async transcript after a Desktop SDK recording finishes
 * streaming.
 *
 * Adapted from an existing production meeting integration. The proven function
 * shapes are retained while the integration glue is rewritten for Clementine:
 *
 *   - reads the API key from the SecretStore (file vault / env) instead
 *     of expecting process.env.RECALL_API_KEY directly;
 *   - reads region from Clementine's RecallMeetingSettings file (the
 *     same file the desktop SDK init uses), so a region change in the
 *     Integrations panel propagates to the REST client automatically;
 *   - drops the zoombot's CircuitBreaker + withRetry helpers in favor
 *     of a small in-module retry on 429/503 (Clementine's call volume
 *     is per-meeting, not per-org).
 *
 * The streamed transcript (live preview during the recording) labels
 * speakers as "Host" / "Speaker 2" — generic. The CANONICAL transcript
 * returned by this API includes `participant.name`, which is what the
 * meeting attendees actually called themselves. Using that as the
 * persisted artifact source is what makes speaker recognition accurate.
 */

import { readSecret } from '../../runtime/secrets/index.js';
import {
  loadRecallMeetingSettings,
  recallApiUrl,
  recallAuthorizationHeader,
  type RecallRegion,
} from './meeting-capture.js';

const MIN_REQUEST_INTERVAL_MS = 1200;
let lastRequestTime = 0;

async function paceRequests(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

interface RecallApiOptions {
  /** Override the region — defaults to whatever's in recall-settings.json. */
  region?: RecallRegion;
  /** Override the API key — defaults to the SecretStore lookup. Useful
   *  for tests; in production callers should rely on the default. */
  apiKey?: string;
  /** HTTP method, headers, body, abort signal. Same shape as fetch. */
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  body?: unknown;
  signal?: AbortSignal;
}

/** Resolved `Token <key>` header value, or null when no key is configured. */
async function resolveAuthorizationHeader(override?: string): Promise<string | null> {
  if (override) return recallAuthorizationHeader(override);
  const key = await readSecret('recall_api_key');
  if (!key) return null;
  return recallAuthorizationHeader(key);
}

/**
 * Authenticated request to Recall's REST API. Retries once on 429/503
 * with a 2s delay (the zoombot retries twice; once is enough for our
 * call cadence since the canonical-transcript poll itself is the
 * retry loop). Throws on any other non-2xx with the response body in
 * the error message so the caller can surface it.
 */
async function recallApiRequest<T>(endpoint: string, opts: RecallApiOptions = {}): Promise<T> {
  const auth = await resolveAuthorizationHeader(opts.apiKey);
  if (!auth) throw new Error('RECALL_API_KEY is not configured');
  const settings = loadRecallMeetingSettings();
  const region = opts.region ?? settings.region;
  const baseUrl = recallApiUrl(region);
  const url = `${baseUrl}/api/v1${endpoint}`;

  const doFetch = async (): Promise<Response> => {
    await paceRequests();
    return fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: auth,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  };

  let response = await doFetch();
  if (response.status === 429 || response.status === 503) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    response = await doFetch();
  }
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    const err = new Error(`Recall API error (${response.status}): ${bodyText.slice(0, 300)}`);
    (err as Error & { status?: number }).status = response.status;
    throw err;
  }
  return response.json() as Promise<T>;
}

/**
 * Shape returned by GET /recording/<id>/. We only declare the fields
 * we read; Recall returns much more (participant metadata, media URLs,
 * status timestamps). `media_shortcuts.transcript.data.download_url`
 * is present once Recall finishes transcribing the upload — it stays
 * undefined while the recording is still being processed, which is
 * the signal we poll for in the backfill.
 */
export interface RecallRecording {
  id: string;
  status?: { code?: string; sub_code?: string | null; updated_at?: string };
  media_shortcuts?: {
    transcript?: {
      id?: string;
      data?: { download_url?: string };
      status?: { code?: string };
    };
    audio_mixed?: {
      data?: { download_url?: string };
      status?: { code?: string };
    };
  };
  metadata?: Record<string, unknown>;
}

/**
 * Retrieve Desktop SDK Upload response. Recall has returned both the newer
 * nested `recording: { id }` shape (matching sdk_upload webhooks) and older
 * `recording_id`/string variants, so reconciliation accepts all of them.
 */
export interface RecallSdkUpload {
  id: string;
  status?: { code?: string; sub_code?: string | null; updated_at?: string } | string;
  status_changes?: Array<{ code?: string; sub_code?: string | null; updated_at?: string }>;
  data?: { code?: string; sub_code?: string | null; updated_at?: string };
  recording_id?: string | null;
  recording?: { id?: string } | string | null;
  recordings?: Array<{ id?: string }>;
  metadata?: Record<string, unknown>;
}

/** Fetch one Desktop SDK upload while it materializes its recording. */
export async function getSdkUpload(
  sdkUploadId: string,
  options?: { apiKey?: string; region?: RecallRegion },
): Promise<RecallSdkUpload> {
  return recallApiRequest<RecallSdkUpload>(
    `/sdk_upload/${sdkUploadId}/`,
    options,
  );
}

/**
 * Fetch the recording metadata for a desktop SDK upload. For Recall's
 * desktop SDK, transcription is automatic — you DON'T POST to
 * /recording/<id>/create_transcript/ (that's the bot path and returns
 * 404 here). Instead you poll this endpoint until
 * `media_shortcuts.transcript.data.download_url` is populated.
 *
 * Mirrors the zoombot's `recall-desktop-transcript-done` worker job
 * at legacy-meeting-bot/worker/index.ts:728.
 */
export async function getRecording(
  recordingId: string,
  options?: { apiKey?: string; region?: RecallRegion },
): Promise<RecallRecording> {
  return recallApiRequest<RecallRecording>(
    `/recording/${recordingId}/`,
    options,
  );
}

/**
 * BOT-MODE ONLY: kick off an async transcript job for a recording
 * made by a Recall bot (one that joined a meeting via meeting URL).
 * For desktop SDK uploads this returns 404 — those are transcribed
 * automatically via the realtime endpoints configured at upload time.
 * Use `getRecording()` for desktop SDK paths.
 */
export async function requestAsyncTranscript(
  recordingId: string,
  options?: {
    provider?: 'recallai_async' | 'assembly_ai' | 'deepgram';
    languageCode?: string;
    useSeparateStreams?: boolean;
    apiKey?: string;
    region?: RecallRegion;
  },
): Promise<{ id: string; status: string }> {
  const body = {
    provider: options?.provider ?? 'recallai_async',
    language_code: options?.languageCode ?? 'en',
    diarization: {
      use_separate_streams_when_available: options?.useSeparateStreams ?? true,
    },
  };
  return recallApiRequest<{ id: string; status: string }>(
    `/recording/${recordingId}/create_transcript/`,
    { method: 'POST', body, apiKey: options?.apiKey, region: options?.region },
  );
}

/**
 * BOT-MODE ONLY: poll a transcript job until it terminates. Pairs
 * with `requestAsyncTranscript`. See getRecording() for the desktop
 * SDK path.
 */
export async function getTranscript(
  transcriptId: string,
  options?: { apiKey?: string; region?: RecallRegion },
): Promise<{
  id: string;
  download_url?: string;
  status: { code: string };
  created_at: string;
}> {
  return recallApiRequest(`/transcript/${transcriptId}/`, options);
}

/**
 * Fetch the canonical transcript payload from the pre-signed S3 URL
 * returned by `getTranscript`. Note: this URL is on s3, NOT on the
 * Recall API, so we don't authenticate (the URL itself is the auth)
 * and we don't go through `recallApiRequest`.
 */
export async function downloadTranscriptData(downloadUrl: string): Promise<TranscriptData[]> {
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download transcript: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<TranscriptData[]>;
}

/**
 * Shape of a single participant's words block from Recall's async
 * transcript download. `start_timestamp.relative` is seconds from the
 * recording start, NOT epoch ms — that's why parseTranscriptToSegments
 * multiplies by 1000.
 *
 * (Ported verbatim from the zoombot — keep field names identical so
 * the parser can be the same on both sides.)
 */
export interface TranscriptData {
  participant: {
    id: number;
    name: string;
    is_host?: boolean;
    platform?: string;
  };
  words: Array<{
    text: string;
    start_timestamp: {
      relative: number; // seconds
      absolute?: string;
    };
    end_timestamp: {
      relative: number; // seconds
      absolute?: string;
    };
  }>;
}
