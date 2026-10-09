/**
 * Voice mode's mouth: Clem's reply, read aloud.
 *
 * The reply was written by the brain on the ordinary chat turn; this module
 * only decides what of it is heard and asks the speech service to say it.
 * Markdown is never read as punctuation, code is never read, and a long reply
 * is heard up to a bounded length while the whole of it stays on screen.
 *
 * Speech uses the owner's OpenAI key, metered per character, and only for
 * voice mode. Without a key the caller falls back to the computer's own voice.
 */

import { getOpenAiApiKey, getRuntimeEnv } from '../config.js';
import { toSpokenSentences } from './spoken-text.js';

/** The most a single spoken reply says aloud; the rest stays on screen. */
export const SPOKEN_REPLY_MAX_CHARS = 900;

/** How the speech model should sound: delivery only, never content. */
export const SPEECH_DELIVERY = 'Speak naturally and warmly, like a capable assistant talking with the person she works for. Brisk and conversational, never an announcer.';

const DEFAULT_SPEECH_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_SPEECH_VOICE = 'marin';

/** The part of a markdown reply that is heard: whole sentences, in order, up
 * to the bound. Tables and code are not read. */
export function spokenReplyText(markdown: string, maxChars = SPOKEN_REPLY_MAX_CHARS): string {
  const withoutTables = (markdown ?? '')
    .split('\n')
    .filter((line) => !/^\s*\|.*\|\s*$/.test(line))
    .join('\n');
  let heard = '';
  for (const sentence of toSpokenSentences(withoutTables)) {
    if (!heard) { heard = sentence.slice(0, maxChars); continue; }
    if (heard.length + 1 + sentence.length > maxChars) break;
    heard = `${heard} ${sentence}`;
  }
  return heard;
}

export type SpeechRequestResult =
  | { ok: true; response: Response; contentType: string }
  | { ok: false; status: number; error: string; fallback?: 'system' };

/** Ask the speech service to say `text`; the audio streams in the response. */
export async function requestSpeech(text: string, signal?: AbortSignal): Promise<SpeechRequestResult> {
  const key = getOpenAiApiKey();
  if (!key) return { ok: false, status: 409, error: 'Voice replies need an OpenAI key; using this computer’s voice.', fallback: 'system' };
  const base = getRuntimeEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, '');
  let response: Response;
  try {
    response = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: getRuntimeEnv('OPENAI_TTS_MODEL', DEFAULT_SPEECH_MODEL),
        voice: getRuntimeEnv('OPENAI_TTS_VOICE', DEFAULT_SPEECH_VOICE),
        input: text,
        instructions: SPEECH_DELIVERY,
        response_format: 'mp3',
      }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) return { ok: false, status: 499, error: 'Speech was stopped.' };
    return { ok: false, status: 502, error: `The speech service could not be reached (${error instanceof Error ? error.message : String(error)}).`, fallback: 'system' };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, status: 409, error: 'The saved OpenAI key was refused for speech; using this computer’s voice.', fallback: 'system' };
  }
  if (!response.ok || !response.body) {
    return { ok: false, status: 502, error: `The speech service answered HTTP ${response.status}.`, fallback: 'system' };
  }
  return { ok: true, response, contentType: response.headers.get('content-type') || 'audio/mpeg' };
}
