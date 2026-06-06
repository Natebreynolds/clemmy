import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { getOpenAiApiKey } from '../config.js';

/**
 * Audio transcription + image understanding via the OpenAI API — the
 * cost-efficient path for "analyze this audio/video/screenshot".
 *
 * Cost model (only ever incurred per-use, $0 baseline):
 *   - audio/video → whisper-1 ≈ $0.006/min (flat, predictable). We send only
 *     the audio; VIDEO must have its audio extracted first (ffmpeg) — not
 *     wired yet, so video returns a clean "not supported" message upstream.
 *   - images → gpt-4o-mini vision ≈ a fraction of a cent each (real OCR +
 *     description, vs markitdown's metadata-only base path).
 *
 * Everything degrades to a structured { ok:false, error } when no API key is
 * configured, so the daemon never breaks — it just explains what's missing.
 */

const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'whisper-1';
const VISION_MODEL = process.env.VISION_MODEL || 'gpt-4o-mini';
const REQUEST_TIMEOUT_MS = 180_000;
/** Whisper's own hard upload limit. */
const WHISPER_MAX_BYTES = 25 * 1024 * 1024;

export type MediaResult = { ok: true; text: string } | { ok: false; error: string };

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.oga', '.aac', '.mpga', '.mpeg', '.weba']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.tif', '.webp']);

export function isAudioExtension(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
export function isImageExtension(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
export function hasOpenAiKey(): boolean {
  return getOpenAiApiKey().length > 0;
}

const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.mpga': 'audio/mpeg', '.mpeg': 'audio/mpeg',
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.aac': 'audio/aac', '.weba': 'audio/webm',
};
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.tif': 'image/tiff', '.webp': 'image/webp',
};

function withTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}

/** Transcribe a local audio file with whisper-1. Caller ensures it's audio. */
export async function transcribeAudio(filePath: string): Promise<MediaResult> {
  const key = getOpenAiApiKey();
  if (!key) return { ok: false, error: 'Audio transcription needs an OpenAI API key. Set OPENAI_API_KEY to enable it.' };
  let bytes: Buffer;
  try {
    if (statSync(filePath).size > WHISPER_MAX_BYTES) {
      return { ok: false, error: `Audio is larger than ${Math.round(WHISPER_MAX_BYTES / 1_000_000)}MB (Whisper's limit). Trim or compress it first.` };
    }
    bytes = readFileSync(filePath);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const ext = path.extname(filePath).toLowerCase();
  const { signal, cancel } = withTimeout(REQUEST_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append('file', new Blob([Uint8Array.from(bytes)], { type: AUDIO_MIME[ext] || 'application/octet-stream' }), path.basename(filePath));
    form.append('model', TRANSCRIBE_MODEL);
    const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      return { ok: false, error: `Transcription failed (HTTP ${res.status}): ${detail || res.statusText}` };
    }
    const json = (await res.json()) as { text?: string };
    const text = (json.text || '').trim();
    return text ? { ok: true, text } : { ok: false, error: 'Transcription returned no text (the audio may be silent or unintelligible).' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: signal.aborted ? `Transcription timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s.` : msg };
  } finally {
    cancel();
  }
}

const DEFAULT_IMAGE_PROMPT =
  'Extract ALL text visible in this image verbatim (preserve structure where possible). Then add a one-line description of what the image shows. If there is no text, just describe the image concisely.';

/** Describe / OCR a local image with a cheap vision model. */
export async function describeImage(filePath: string, prompt = DEFAULT_IMAGE_PROMPT): Promise<MediaResult> {
  const key = getOpenAiApiKey();
  if (!key) return { ok: false, error: 'Image text extraction needs an OpenAI API key. Set OPENAI_API_KEY to enable it.' };
  let dataUrl: string;
  try {
    const ext = path.extname(filePath).toLowerCase();
    const bytes = readFileSync(filePath);
    dataUrl = `data:${IMAGE_MIME[ext] || 'image/png'};base64,${bytes.toString('base64')}`;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const { signal, cancel } = withTimeout(REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
      }),
      signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      return { ok: false, error: `Image analysis failed (HTTP ${res.status}): ${detail || res.statusText}` };
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = (json.choices?.[0]?.message?.content || '').trim();
    return text ? { ok: true, text } : { ok: false, error: 'Image analysis returned no content.' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: signal.aborted ? `Image analysis timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s.` : msg };
  } finally {
    cancel();
  }
}
