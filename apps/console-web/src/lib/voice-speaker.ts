/**
 * Voice mode's speaker: plays Clem's replies one after another.
 *
 * Each reply goes to /api/console/voice/speak, which streams the speech
 * service's audio; playback starts on the first bytes. Without a usable key
 * the daemon hands back the words and this computer's own voice says them.
 * The audio plays through the page, so the microphone's echo cancellation
 * hears it as Clem, not as the owner.
 */
import { getAuthToken } from './bootstrap';

export interface VoiceSpeakerHandlers {
  /** Clem started saying something. */
  onSpeaking?: () => void;
  /** Nothing left to say (finished, stopped, or failed). */
  onIdle?: () => void;
  /** A reply could not be spoken; the words are still on screen. */
  onError?: (message: string) => void;
}

const MP3 = 'audio/mpeg';

export class VoiceSpeaker {
  private queue: string[] = [];
  private active = false;
  private generation = 0;
  private controller: AbortController | null = null;
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private settleCurrent: (() => void) | null = null;

  constructor(private handlers: VoiceSpeakerHandlers = {}) {}

  get speaking(): boolean { return this.active; }

  /** Say `text` after anything already queued. */
  say(text: string): void {
    const words = text.trim();
    if (!words) return;
    this.queue.push(words);
    if (!this.active) void this.drain(this.generation);
  }

  /** Stop now and forget what was queued. */
  stop(): void {
    this.generation += 1;
    this.queue = [];
    this.controller?.abort();
    this.controller = null;
    this.releaseAudio();
    try { window.speechSynthesis?.cancel(); } catch { /* not available */ }
    if (this.active) {
      this.active = false;
      this.handlers.onIdle?.();
    }
  }

  private async drain(generation: number): Promise<void> {
    this.active = true;
    this.handlers.onSpeaking?.();
    while (generation === this.generation) {
      const next = this.queue.shift();
      if (next === undefined) break;
      try {
        await this.speakOne(next, generation);
      } catch (error) {
        if (generation !== this.generation) return;
        this.handlers.onError?.(error instanceof Error ? error.message : 'Could not speak the reply.');
      }
    }
    if (generation !== this.generation) return;
    this.active = false;
    this.handlers.onIdle?.();
  }

  private async speakOne(text: string, generation: number): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const token = getAuthToken();
    const res = await fetch(`/api/console/voice/speak${token ? `?token=${encodeURIComponent(token)}` : ''}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (generation !== this.generation) return;
    if (!res.ok) {
      const payload = await res.json().catch(() => ({})) as { error?: string; fallback?: string; text?: string };
      if (res.status === 400) return;
      if (payload.fallback === 'system' && payload.text) {
        await this.sayWithSystemVoice(payload.text, generation);
        return;
      }
      throw new Error(payload.error || 'Could not speak the reply.');
    }
    if (res.body && typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(MP3)) {
      await this.playStream(res.body, generation);
    } else {
      await this.playUrl(URL.createObjectURL(await res.blob()), generation);
    }
  }

  /** Play mp3 bytes as they arrive. */
  private playStream(body: ReadableStream<Uint8Array>, generation: number): Promise<void> {
    const source = new MediaSource();
    const url = URL.createObjectURL(source);
    const played = this.playUrl(url, generation);
    source.addEventListener('sourceopen', () => {
      const buffer = source.addSourceBuffer(MP3);
      const reader = body.getReader();
      const appendNext = async (): Promise<void> => {
        if (generation !== this.generation) { void reader.cancel().catch(() => undefined); return; }
        const { done, value } = await reader.read();
        if (done) {
          if (source.readyState === 'open') source.endOfStream();
          return;
        }
        buffer.appendBuffer(value as Uint8Array<ArrayBuffer>);
      };
      buffer.addEventListener('updateend', () => { void appendNext().catch(() => this.endQuietly(source)); });
      void appendNext().catch(() => this.endQuietly(source));
    }, { once: true });
    return played;
  }

  private endQuietly(source: MediaSource): void {
    try { if (source.readyState === 'open') source.endOfStream(); } catch { /* already closed */ }
  }

  private playUrl(url: string, generation: number): Promise<void> {
    this.releaseAudio();
    const audio = new Audio();
    this.audio = audio;
    this.objectUrl = url;
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        audio.onended = null; audio.onerror = null;
        if (this.settleCurrent) this.settleCurrent = null;
        if (this.audio === audio) this.releaseAudio();
        if (error && generation === this.generation) reject(error); else resolve();
      };
      this.settleCurrent = () => finish();
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error('The reply audio could not be played.'));
      audio.src = url;
      void audio.play().catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
    });
  }

  private releaseAudio(): void {
    const settle = this.settleCurrent;
    this.settleCurrent = null;
    const audio = this.audio;
    this.audio = null;
    if (audio) {
      audio.onended = null; audio.onerror = null;
      try { audio.pause(); } catch { /* already stopped */ }
      audio.removeAttribute('src');
      try { audio.load(); } catch { /* detached */ }
    }
    if (this.objectUrl) { URL.revokeObjectURL(this.objectUrl); this.objectUrl = null; }
    settle?.();
  }

  /** This computer's own voice, when the speech service is not available. */
  private sayWithSystemVoice(text: string, generation: number): Promise<void> {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return Promise.resolve();
    return new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.05;
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      if (generation !== this.generation) { resolve(); return; }
      synth.speak(utterance);
    });
  }
}
