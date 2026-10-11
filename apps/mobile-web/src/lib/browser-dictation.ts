import { microphoneProblem } from './dictation-support';

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing';
export interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onstart: (() => void) | null;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>>; resultIndex: number }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string; message?: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

/** Existing browser-speech fallback; never chosen after Mac capture fails. */
export class BrowserDictationSession {
  private active = false;
  private words = '';
  constructor(private readonly recognition: SpeechRecognitionLike, private readonly callbacks: {
    state: (phase: DictationPhase) => void;
    words: (text: string) => void;
    error: (message: string) => void;
    end: () => void;
  }) {}

  start(language: string): void {
    if (this.active) return;
    this.active = true;
    this.words = '';
    const rec = this.recognition;
    rec.lang = language;
    rec.interimResults = true;
    rec.continuous = false;
    rec.onstart = () => { if (this.active) this.callbacks.state('recording'); };
    rec.onresult = event => {
      if (!this.active) return;
      // results contains the entire utterance; resultIndex only names what changed.
      const parts: string[] = [];
      for (let index = 0; index < event.results.length; index += 1) {
        const words = event.results[index][0]?.transcript?.trim();
        if (words) parts.push(words);
      }
      this.words = parts.join(' ');
    };
    rec.onend = () => {
      if (!this.active) return;
      this.active = false;
      this.detach();
      if (this.words) this.callbacks.words(this.words);
      else this.callbacks.error(microphoneProblem({ error: 'no-speech' }));
      this.callbacks.state('idle');
      this.callbacks.end();
    };
    rec.onerror = error => { if (this.active) this.fail(error); };
    this.callbacks.state('starting');
    try { rec.start(); } catch (error) { this.fail(error); }
  }

  stop(): void {
    if (!this.active) return;
    this.callbacks.state('transcribing');
    try { this.recognition.stop(); } catch (error) { this.fail(error); }
  }

  cancel(): void {
    this.active = false;
    this.detach();
    try { this.recognition.abort(); } catch { /* already ended */ }
  }

  private detach(): void {
    this.recognition.onstart = null;
    this.recognition.onresult = null;
    this.recognition.onend = null;
    this.recognition.onerror = null;
  }

  private fail(error: unknown): void {
    this.cancel();
    this.callbacks.error(microphoneProblem(error));
    this.callbacks.state('idle');
    this.callbacks.end();
  }
}
