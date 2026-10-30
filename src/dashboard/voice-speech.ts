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

import pino from 'pino';
import { getOpenAiApiKey, getRuntimeEnv } from '../config.js';
import { redactSensitiveText } from '../runtime/security.js';
import { toSpokenSentences } from './spoken-text.js';
import { noteSavedOpenAiKeyOutcome, openAiOutOfCredit, VOICE_KEY_WORDS, type VoiceKeyProblem } from './live-voice.js';

/** The most a single spoken reply says aloud; the rest stays on screen. */
export const SPOKEN_REPLY_MAX_CHARS = 900;

/** How the speech model should sound: delivery only, never content. */
export const SPEECH_DELIVERY = 'Speak naturally and warmly, like a capable assistant talking with the person she works for. Brisk and conversational, never an announcer.';

const logger = pino({ name: 'clementine.voice' });
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
  | { ok: false; status: number; error: string; fallback?: 'system'; code?: VoiceKeyProblem };

/** A key problem is said, never covered by the device's own voice (owner
 *  2026-10-30: "I would rather the user get something about the API"). */
function keyProblem(code: VoiceKeyProblem): SpeechRequestResult {
  return { ok: false, status: 409, error: VOICE_KEY_WORDS[code], code };
}

/** Ask the speech service to say `text`; the audio streams in the response. */
export async function requestSpeech(text: string, signal?: AbortSignal): Promise<SpeechRequestResult> {
  let key: string;
  let base: string;
  let model: string;
  let voice: string;
  try {
    key = getOpenAiApiKey();
    base = getRuntimeEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, '');
    model = getRuntimeEnv('OPENAI_TTS_MODEL', DEFAULT_SPEECH_MODEL);
    voice = getRuntimeEnv('OPENAI_TTS_VOICE', DEFAULT_SPEECH_VOICE);
  } catch (error) {
    // A saved key whose privacy cannot be verified is not read; the reply is
    // still heard, in the computer's own voice.
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn({ reason: redactSensitiveText(reason).slice(0, 300) }, 'voice speech could not read its saved key');
    return keyProblem('key_unreadable');
  }
  if (!key) return keyProblem('needs_key');
  let response: Response;
  try {
    response = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        voice,
        input: text,
        instructions: SPEECH_DELIVERY,
        response_format: 'mp3',
      }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) return { ok: false, status: 499, error: 'Speech was stopped.' };
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn({ reason: redactSensitiveText(reason).slice(0, 300), chars: text.length }, 'voice speech could not reach the speech service');
    return { ok: false, status: 502, error: `The speech service could not be reached (${reason}).` };
  }
  if (response.status === 401 || response.status === 403) {
    logger.warn({ status: response.status }, 'voice speech key refused; the computer voice speaks instead');
    // The same saved key serves live voice: its availability now says so
    // before the device starts a session that cannot work.
    noteSavedOpenAiKeyOutcome(key, { reason: VOICE_KEY_WORDS.key_refused });
    return keyProblem('key_refused');
  }
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    logger.warn({ status: response.status, detail: redactSensitiveText(detail).slice(0, 300), chars: text.length }, 'voice speech failed');
    if (response.status === 429 && openAiOutOfCredit(detail)) {
      return keyProblem('no_credit');
    }
    return { ok: false, status: 502, error: `The speech service answered HTTP ${response.status}.` };
  }
  noteSavedOpenAiKeyOutcome(key, null);
  return { ok: true, response, contentType: response.headers.get('content-type') || 'audio/mpeg' };
}
