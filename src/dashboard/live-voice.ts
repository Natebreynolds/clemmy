/**
 * Live voice: a full-duplex spoken conversation with Clem.
 *
 * A voice model listens and speaks at the same time (short acknowledgements,
 * interruptions, natural turn-taking) and hands every request to Clem. The
 * device sends that request as an ordinary spoken turn of the conversation on
 * screen, so the same brain, tools, memory and approvals run, and passes her
 * words back for the voice to say. The voice never decides or answers for her.
 *
 * The OpenAI key never leaves this computer: the device posts its WebRTC offer
 * here, this module exchanges it with the voice service for an answer, and the
 * audio then flows directly between the device and the service.
 */

import pino from 'pino';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR, getOpenAiApiKey, getRuntimeEnv } from '../config.js';
import { redactSensitiveText } from '../runtime/security.js';

const logger = pino({ name: 'clementine.live-voice' });

const DEFAULT_LIVE_MODEL = 'gpt-live-1';
const DEFAULT_LIVE_VOICE = 'marin';
const SESSION_REQUEST_TIMEOUT_MS = 15_000;
const SDP_MAX_CHARS = 60_000;
/** Recent conversation the voice starts with, so "yes" or "the second one"
 *  means something. The service accepts 128 messages and 8,192 tokens. */
export const LIVE_HISTORY_MAX_MESSAGES = 24;
export const LIVE_HISTORY_MAX_CHARS = 12_000;
const LIVE_HISTORY_MESSAGE_MAX_CHARS = 1_500;

/** The voice's standing instructions: who it is, how it talks, and that every
 *  request goes to Clem. Clem's own words come back through the session. */
export function liveVoiceInstructions(): string {
  return [
    'You are the voice of Clem (Clementine), the owner\'s assistant, in a live spoken conversation. To the owner you are simply Clem. Clem\'s mind works behind you: her memory, tools, connected apps, files, Spaces, workflows and judgment. You hand each request to it, and it sends back what Clem says.',
    '',
    'Speak warmly and naturally, at an easy conversational pace: brisk and plain, never an announcer. Keep each turn short; the full answer is also on the owner\'s screen. If the owner sounds frustrated, acknowledge it briefly and move to the next helpful step.',
    '',
    'Backchannel policy: Use light backchannels such as "mm-hmm" or "okay" while the owner is talking. Never compete with them for the turn.',
    '',
    'Interruption policy: Stop speaking as soon as the owner interrupts, and listen. Stopping your speech does not stop work already handed over; when the owner wants that work stopped or changed, hand that over as a new request.',
    '',
    'Delegation policy:',
    'Backend tools:',
    '- Clem: everything the owner asks of their assistant. Answers, facts about their work and life, memory, email, calendar, files, connected apps, Spaces, workflows, drafting, sending, scheduling, and any action anywhere.',
    'Delegate to the backend when:',
    '- The owner asks a question, asks for anything, gives an instruction, answers a question Clem asked, approves or declines something Clem prepared, or corrects or cancels work already requested.',
    '- You are unsure whether a request needs Clem.',
    'Do not delegate to the backend when:',
    '- The owner only greets you, thanks you, or makes a passing remark that needs no answer.',
    '- The owner asks you to repeat, or say more slowly, something Clem already said.',
    '- The owner is still mid-thought; wait for them to finish.',
    'Delegate before giving an answer that depends on backend work.',
    'Do not guess the result while waiting.',
    '',
    'Answers and outcomes come only from Clem\'s words sent back to you. Never answer a question, state a fact, or say something was done from your own knowledge. While Clem works, a brief natural acknowledgement is fine; then wait quietly. When Clem\'s words arrive, say them in your own natural spoken words and keep every name, number, date, amount and question exactly as given; add no offers, suggestions or questions of your own. When Clem asks the owner something or asks them to approve something, ask it plainly and wait for their answer. Notes about Clem\'s progress may arrive silently: mention the latest one briefly only when the owner asks how it is going or the wait runs long. Never mention handing off, a backend, delegation, tools, or another assistant.',
  ].join('\n');
}

export interface LiveVoiceHistoryItem {
  type: 'message';
  role: 'user' | 'assistant';
  content: [{ type: 'input_text' | 'output_text'; text: string }];
}

/** The recent conversation, newest kept first within the bounds, in order. */
export function liveVoiceHistory(raw: unknown): LiveVoiceHistoryItem[] {
  if (!Array.isArray(raw)) return [];
  const kept: LiveVoiceHistoryItem[] = [];
  let chars = 0;
  for (let index = raw.length - 1; index >= 0 && kept.length < LIVE_HISTORY_MAX_MESSAGES; index -= 1) {
    const entry = raw[index] as { role?: unknown; text?: unknown } | null;
    if (!entry || (entry.role !== 'user' && entry.role !== 'assistant') || typeof entry.text !== 'string') continue;
    const text = entry.text.replace(/\s+/g, ' ').trim().slice(0, LIVE_HISTORY_MESSAGE_MAX_CHARS);
    if (!text) continue;
    if (chars + text.length > LIVE_HISTORY_MAX_CHARS) break;
    chars += text.length;
    kept.push({
      type: 'message',
      role: entry.role,
      content: [{ type: entry.role === 'user' ? 'input_text' : 'output_text', text }],
    });
  }
  return kept.reverse();
}

/** Whether an OpenAI error body says the account has no credit left. */
export function openAiOutOfCredit(body: string): boolean {
  try {
    const error = (JSON.parse(body) as { error?: { type?: unknown; code?: unknown } }).error;
    return error?.type === 'insufficient_quota' || error?.code === 'insufficient_quota' || error?.code === 'credit_balance_exhausted';
  } catch {
    return false;
  }
}

/** What Clem's voice says when the OpenAI key behind it cannot be used, on the
 *  desktop and the phone alike. Owner 2026-10-30: never fall back to the
 *  device's own voice; tell the owner about the key and how to fix it. */
export const VOICE_KEY_WORDS = {
  key_unreadable: 'Clem couldn’t read the OpenAI key saved for her voice. Save it again in Settings → Keys & accounts on your computer.',
  needs_key: 'Clem’s voice needs an OpenAI key. Add one in Settings → Keys & accounts on your computer.',
  key_refused: 'OpenAI refused the key saved for Clem’s voice. Save a working key in Settings → Keys & accounts on your computer.',
  no_credit: 'The OpenAI account behind Clem’s voice is out of credit. Add credit there, or save another key in Settings → Keys & accounts on your computer.',
} as const;
export type VoiceKeyProblem = keyof typeof VOICE_KEY_WORDS;

export interface LiveVoiceStatus {
  available: boolean;
  reason?: string;
}

/** What the voice service last said about the saved key, so availability
 *  tells the truth before the device starts a session that cannot work. Live
 *  2026-10-27: the saved key had been refused (401) for speech and for live
 *  voice, and the status still said available; the mic would start and fail.
 *  Remembered by the key's digest, never the key; a different saved key, or a
 *  later success with the same key, clears it. Kept on disk: held only in
 *  memory, every restart forgot it and the next voice session failed again
 *  (live 2026-10-30). */
let savedKeyRefusal: { digest: string; reason: string } | null | undefined;
const refusalFile = () => path.join(BASE_DIR, 'state', 'voice-key-refusal.json');
function keyDigest(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}
function rememberedRefusal(): { digest: string; reason: string } | null {
  if (savedKeyRefusal !== undefined) return savedKeyRefusal;
  try {
    const stored = JSON.parse(readFileSync(refusalFile(), 'utf8')) as { digest?: unknown; reason?: unknown };
    savedKeyRefusal = typeof stored.digest === 'string' && typeof stored.reason === 'string'
      ? { digest: stored.digest, reason: stored.reason } : null;
  } catch {
    savedKeyRefusal = null;
  }
  return savedKeyRefusal;
}
export function noteSavedOpenAiKeyOutcome(key: string, refusal: { reason: string } | null): void {
  if (!key) return;
  const next = refusal ? { digest: keyDigest(key), reason: refusal.reason } : null;
  const prior = rememberedRefusal();
  savedKeyRefusal = next;
  if (prior?.digest === next?.digest && prior?.reason === next?.reason) return;
  try {
    if (!next) { rmSync(refusalFile(), { force: true }); return; }
    mkdirSync(path.dirname(refusalFile()), { recursive: true });
    const temp = `${refusalFile()}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ ...next, at: new Date().toISOString() }), { mode: 0o600 });
    renameSync(temp, refusalFile());
  } catch (error) {
    logger.warn({ reason: error instanceof Error ? error.message : String(error) }, 'voice key outcome could not be saved; it holds until the next restart');
  }
}
function savedKeyRefusedReason(key: string): string | null {
  const refusal = rememberedRefusal();
  return refusal && refusal.digest === keyDigest(key) ? refusal.reason : null;
}
/** A fresh daemon process: what is held in memory is gone, what is on disk stays. */
export function _forgetSavedOpenAiKeyMemoryForTests(): void {
  savedKeyRefusal = undefined;
}
export function _resetSavedOpenAiKeyMemoryForTests(): void {
  savedKeyRefusal = undefined;
  rmSync(refusalFile(), { force: true });
}

/** The key and settings the session needs. Reading saved credentials can be
 *  refused (on Windows when their privacy cannot be verified); that is an
 *  answer for the device, never an exception that reaches the daemon. */
export interface LiveVoiceConfigReader { openAiKey: () => string; env: (key: string, fallback: string) => string }
const savedConfig: LiveVoiceConfigReader = { openAiKey: getOpenAiApiKey, env: getRuntimeEnv };

function liveVoiceSettings(config: LiveVoiceConfigReader = savedConfig): { ok: true; key: string; base: string; model: string; voice: string } | { ok: false; reason: string } {
  try {
    return {
      ok: true,
      key: config.openAiKey(),
      base: config.env('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
      model: config.env('OPENAI_LIVE_MODEL', DEFAULT_LIVE_MODEL),
      voice: config.env('OPENAI_LIVE_VOICE', config.env('OPENAI_TTS_VOICE', DEFAULT_LIVE_VOICE)),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn({ reason: redactSensitiveText(reason).slice(0, 300) }, 'live voice could not read its saved settings');
    return { ok: false, reason };
  }
}

export function liveVoiceStatus(config: LiveVoiceConfigReader = savedConfig): LiveVoiceStatus {
  const settings = liveVoiceSettings(config);
  if (!settings.ok) return { available: false, reason: VOICE_KEY_WORDS.key_unreadable };
  if (!settings.key) return { available: false, reason: VOICE_KEY_WORDS.needs_key };
  const refused = savedKeyRefusedReason(settings.key);
  return refused ? { available: false, reason: refused } : { available: true };
}

export type LiveVoiceSessionResult =
  | { ok: true; sessionId: string; sdp: string }
  | {
    ok: false;
    status: number;
    code: 'LIVE_VOICE_BAD_OFFER' | 'LIVE_VOICE_NEEDS_KEY' | 'LIVE_VOICE_KEY_UNREADABLE' | 'LIVE_VOICE_KEY_REFUSED' | 'LIVE_VOICE_UNAVAILABLE' | 'LIVE_VOICE_NO_CREDIT' | 'LIVE_VOICE_BUSY' | 'LIVE_VOICE_FAILED';
    error: string;
  };

/** Exchange the device's SDP offer for the voice service's answer. */
export async function createLiveVoiceSession(
  input: { sdp?: unknown; history?: unknown },
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  config: LiveVoiceConfigReader = savedConfig,
): Promise<LiveVoiceSessionResult> {
  const sdp = typeof input.sdp === 'string' ? input.sdp : '';
  if (!sdp.trim() || sdp.length > SDP_MAX_CHARS) {
    return { ok: false, status: 400, code: 'LIVE_VOICE_BAD_OFFER', error: 'A WebRTC offer is required.' };
  }
  const settings = liveVoiceSettings(config);
  if (!settings.ok) {
    return { ok: false, status: 503, code: 'LIVE_VOICE_KEY_UNREADABLE', error: 'The saved OpenAI key could not be read safely, so live voice did not start.' };
  }
  const { key, base, model, voice } = settings;
  if (!key) return { ok: false, status: 409, code: 'LIVE_VOICE_NEEDS_KEY', error: 'Live voice needs an OpenAI key.' };
  const history = liveVoiceHistory(input.history);
  const timeout = AbortSignal.timeout(SESSION_REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetchImpl(`${base}/live/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: {
          model,
          instructions: liveVoiceInstructions(),
          ...(history.length > 0 ? { input: history } : {}),
          audio: { output: { voice } },
          delegation: { type: 'client' },
        },
        transport: { type: 'webrtc', sdp },
      }),
      signal: combined,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn({ reason: redactSensitiveText(reason).slice(0, 300) }, 'live voice could not reach the voice service');
    return { ok: false, status: 502, code: 'LIVE_VOICE_FAILED', error: `The voice service could not be reached (${reason}).` };
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    const detail = redactSensitiveText(raw).slice(0, 400);
    logger.warn({ status: response.status, detail }, 'live voice session was refused');
    if (response.status === 429) {
      // The service answers 429 both for an account with no credit left and
      // for a momentary rate limit; the error type tells them apart.
      if (openAiOutOfCredit(raw)) {
        const error = 'The OpenAI account is out of credit. Add credit in the OpenAI billing settings to use live voice.';
        noteSavedOpenAiKeyOutcome(key, { reason: error });
        return { ok: false, status: 409, code: 'LIVE_VOICE_NO_CREDIT', error };
      }
      return { ok: false, status: 503, code: 'LIVE_VOICE_BUSY', error: 'The voice service is busy right now. Try again in a moment.' };
    }
    if (response.status === 401) {
      const error = VOICE_KEY_WORDS.key_refused;
      noteSavedOpenAiKeyOutcome(key, { reason: error });
      return { ok: false, status: 409, code: 'LIVE_VOICE_KEY_REFUSED', error };
    }
    if (response.status === 403 || response.status === 404) {
      const error = 'This OpenAI key does not have live voice yet.';
      noteSavedOpenAiKeyOutcome(key, { reason: error });
      return { ok: false, status: 409, code: 'LIVE_VOICE_UNAVAILABLE', error };
    }
    return { ok: false, status: 502, code: 'LIVE_VOICE_FAILED', error: `The voice service answered HTTP ${response.status}.` };
  }
  const body = await response.json().catch(() => null) as { session?: { id?: unknown }; transport?: { sdp?: unknown } } | null;
  const sessionId = typeof body?.session?.id === 'string' ? body.session.id : '';
  const answer = typeof body?.transport?.sdp === 'string' ? body.transport.sdp : '';
  if (!sessionId || !answer) {
    logger.warn({ status: response.status }, 'live voice session answer was incomplete');
    return { ok: false, status: 502, code: 'LIVE_VOICE_FAILED', error: 'The voice service did not return a session.' };
  }
  logger.info({ sessionId, history: history.length }, 'live voice session started');
  noteSavedOpenAiKeyOutcome(key, null);
  return { ok: true, sessionId, sdp: answer };
}
