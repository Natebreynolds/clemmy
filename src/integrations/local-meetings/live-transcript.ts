/**
 * Live in-person transcription (2026-07-14, Nathan: "transcripts live in person
 * could use much improvements").
 *
 * A VIEW, not the record: while a local meeting is recording, the daemon
 * incrementally transcribes the GROWING WAV part-file the desktop recorder is
 * streaming to disk — a slice of new audio every ~20s through the SAME vendored
 * whisper-cli the batch pass uses. The at-stop full-file pass remains the
 * UNCHANGED authoritative transcript (contract, vault artifact, transcript-only
 * deletion) — if the live view lags or errs, nothing downstream changes.
 *
 * Mechanics: the part-file is a WAV whose header still claims 0 data bytes
 * (finalized only at stop), so each pass copies the NEW PCM slice (plus a 2s
 * overlap for word boundaries) into a small standalone temp WAV with a correct
 * header, transcribes it, offsets the segment timestamps by the slice start,
 * and drops overlap-region duplicates. Passes are serialized per session and
 * piggyback on the dashboard's existing 5s status poll — no idle timers, no
 * work when nobody is watching.
 *
 * Kill-switch: CLEMMY_LIVE_TRANSCRIPT=off (default on — validated behavior is
 * the default; the cost is local-only whisper on already-captured audio).
 */
import { closeSync, openSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getRuntimeEnv } from '../../config.js';
import {
  DEFAULT_LOCAL_WHISPER_MODEL,
  getLocalTranscriptionRuntimeStatus,
  transcribeLocalMeetingAudio,
  type LocalWhisperSegment,
  type LocalWhisperTranscription,
} from './whisper-runtime.js';

const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // 16-bit mono PCM
const WAV_HEADER_BYTES = 44;
/** Minimum NEW audio before a pass runs — the live cadence. */
const MIN_SLICE_SECONDS = 15;
/** Re-transcribed tail so words split across slice boundaries aren't lost. */
const OVERLAP_SECONDS = 2;
/** Never feed a pathological slice to whisper (a stalled poll then a burst). */
const MAX_SLICE_SECONDS = 180;

export interface LiveTranscriptSegment {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface LiveTranscriptSnapshot {
  segments: LiveTranscriptSegment[];
  /** Audio time (seconds) the live view has transcribed through. */
  throughSeconds: number;
  updatedAt?: string;
  lastError?: string;
}

interface LiveState {
  partPath: string;
  transcribedBytes: number; // PCM bytes covered (absolute, excl. header)
  segments: LiveTranscriptSegment[];
  inFlight: boolean;
  passCounter: number;
  updatedAt?: string;
  lastError?: string;
}

const states = new Map<string, LiveState>();

// getLocalTranscriptionRuntimeStatus checksums the model file — cache readiness
// briefly so the 5s poll doesn't hash 148MB every tick.
let runtimeReadyCache: { ready: boolean; atMs: number } | null = null;
const RUNTIME_READY_TTL_MS = 60_000;

type LiveTranscriber = (input: {
  audioPath: string;
  durationSeconds: number;
}) => Promise<LocalWhisperTranscription>;

let transcriber: LiveTranscriber = ({ audioPath, durationSeconds }) =>
  transcribeLocalMeetingAudio({ audioPath, model: DEFAULT_LOCAL_WHISPER_MODEL, durationSeconds });

/** Test seam, mirroring meeting-capture's transcriber seam. */
export function _setLiveTranscriberForTests(fn: LiveTranscriber | null): void {
  transcriber = fn ?? (({ audioPath, durationSeconds }) =>
    transcribeLocalMeetingAudio({ audioPath, model: DEFAULT_LOCAL_WHISPER_MODEL, durationSeconds }));
  runtimeReadyCache = fn ? { ready: true, atMs: Date.now() } : null;
}

export function liveTranscriptEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_LIVE_TRANSCRIPT', 'on') ?? 'on').toLowerCase() !== 'off';
}

function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

async function runtimeReady(): Promise<boolean> {
  const now = Date.now();
  if (runtimeReadyCache && now - runtimeReadyCache.atMs < RUNTIME_READY_TTL_MS) {
    return runtimeReadyCache.ready;
  }
  try {
    const status = await getLocalTranscriptionRuntimeStatus();
    // modelReady REQUIRED: the live view must never trigger a 148MB model
    // download mid-meeting; the batch pass at stop owns first-time downloads.
    runtimeReadyCache = { ready: status.available && status.modelReady, atMs: now };
  } catch {
    runtimeReadyCache = { ready: false, atMs: now };
  }
  return runtimeReadyCache.ready;
}

async function runPass(sessionId: string, state: LiveState): Promise<void> {
  let tempPath: string | undefined;
  try {
    if (!(await runtimeReady())) return;
    const info = statSync(state.partPath); // throws when finalized/renamed — pass ends silently
    const pcmBytes = Math.max(0, info.size - WAV_HEADER_BYTES);
    const newBytes = pcmBytes - state.transcribedBytes;
    if (newBytes < MIN_SLICE_SECONDS * BYTES_PER_SECOND) return;
    const overlapBytes = Math.min(state.transcribedBytes, OVERLAP_SECONDS * BYTES_PER_SECOND);
    let sliceStartByte = state.transcribedBytes - overlapBytes;
    let sliceBytes = pcmBytes - sliceStartByte;
    const maxBytes = MAX_SLICE_SECONDS * BYTES_PER_SECOND;
    if (sliceBytes > maxBytes) {
      // A long-unobserved recording: transcribe the newest window and skip the
      // middle honestly — the batch pass covers the full audio at stop.
      sliceStartByte = pcmBytes - maxBytes;
      sliceBytes = maxBytes;
    }
    // Read the slice from the part-file (16-bit alignment preserved: all
    // constants are even) and wrap it in a correct standalone header.
    const buf = Buffer.alloc(sliceBytes);
    const fd = openSync(state.partPath, 'r');
    try {
      const read = readSync(fd, buf, 0, sliceBytes, WAV_HEADER_BYTES + sliceStartByte);
      if (read < sliceBytes) { sliceBytes = read - (read % 2); }
    } finally {
      closeSync(fd);
    }
    if (sliceBytes <= 0) return;
    state.passCounter += 1;
    tempPath = path.join(
      path.dirname(state.partPath),
      `live-slice-${sessionId}-${state.passCounter}.wav`,
    );
    writeFileSync(tempPath, Buffer.concat([wavHeader(sliceBytes), buf.subarray(0, sliceBytes)]), { mode: 0o600 });
    const sliceStartSec = sliceStartByte / BYTES_PER_SECOND;
    const coveredThroughSec = state.transcribedBytes / BYTES_PER_SECOND;
    const result = await transcriber({ audioPath: tempPath, durationSeconds: sliceBytes / BYTES_PER_SECOND });
    for (const seg of result.segments as LocalWhisperSegment[]) {
      const startSeconds = seg.startSeconds + sliceStartSec;
      const endSeconds = seg.endSeconds + sliceStartSec;
      // Drop segments fully inside the already-covered overlap region.
      if (endSeconds <= coveredThroughSec + 0.25) continue;
      const text = seg.text.trim();
      if (text) state.segments.push({ text, startSeconds, endSeconds });
    }
    state.transcribedBytes = sliceStartByte + sliceBytes;
    state.updatedAt = new Date().toISOString();
    state.lastError = undefined;
  } catch (error) {
    // The live view must NEVER break the status poll or the recording.
    state.lastError = error instanceof Error ? error.message : String(error);
    state.updatedAt = new Date().toISOString();
  } finally {
    if (tempPath) { try { unlinkSync(tempPath); } catch { /* already gone */ } }
    state.inFlight = false;
  }
}

/**
 * Called from the status poll while a local meeting is RECORDING. Non-blocking:
 * kicks an async incremental pass when enough new audio exists, and returns the
 * current snapshot immediately.
 */
export function noteLiveTranscriptOpportunity(sessionId: string, finalAudioPath: string): LiveTranscriptSnapshot {
  if (!liveTranscriptEnabled()) return { segments: [], throughSeconds: 0 };
  let state = states.get(sessionId);
  if (!state) {
    // The desktop recorder streams into `<final>.part` and renames at stop.
    state = {
      partPath: `${finalAudioPath}.part`,
      transcribedBytes: 0,
      segments: [],
      inFlight: false,
      passCounter: 0,
    };
    // Crude bound for a long-lived daemon (sessions are cleared on stop/cancel,
    // but a crashed renderer may orphan one).
    if (states.size > 20) states.clear();
    states.set(sessionId, state);
  }
  if (!state.inFlight) {
    state.inFlight = true;
    void runPass(sessionId, state);
  }
  return getLiveTranscriptSnapshot(sessionId);
}

export function getLiveTranscriptSnapshot(sessionId: string): LiveTranscriptSnapshot {
  const state = states.get(sessionId);
  if (!state) return { segments: [], throughSeconds: 0 };
  return {
    segments: state.segments,
    throughSeconds: state.transcribedBytes / BYTES_PER_SECOND,
    updatedAt: state.updatedAt,
    lastError: state.lastError,
  };
}

/** The recording ended (stop/ingest/cancel) — the batch pass owns the truth. */
export function clearLiveTranscript(sessionId: string): void {
  states.delete(sessionId);
}
