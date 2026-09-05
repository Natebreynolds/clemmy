/**
 * The floating ask capsule — the app's one persistent control.
 *
 * It floats above the safe area on Home, Needs you, and the Chats list and
 * sends through the same path Home's ask box always used: the text opens a
 * new conversation and sends itself. Dictation is offered only where the
 * platform actually provides it; a microphone that does nothing is a lie.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { haptic } from '../lib/native-bridge';

interface Props {
  onAsk: (text: string) => void;
}

/** The minimal slice of the Web Speech API this component uses. */
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>>; resultIndex: number }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function AskCapsule({ onAsk }: Props) {
  const [draft, setDraft] = useState('');
  const [listening, setListening] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const [dictation] = useState(() => speechRecognitionCtor() !== null);
  // iOS Safari keeps a fixed element behind the keyboard; the visual
  // viewport says exactly how much of the layout viewport is covered.
  const [keyboardInset, setKeyboardInset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const measure = () => {
      const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKeyboardInset(Math.round(covered));
    };
    vv.addEventListener('resize', measure);
    vv.addEventListener('scroll', measure);
    return () => {
      vv.removeEventListener('resize', measure);
      vv.removeEventListener('scroll', measure);
    };
  }, []);

  useEffect(() => () => { recognition.current?.abort(); }, []);

  const submit = (event?: Event) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    haptic('medium');
    recognition.current?.stop();
    setDraft('');
    onAsk(text);
  };

  const toggleDictation = () => {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    const base = draft;
    rec.onresult = (event) => {
      let heard = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        heard += event.results[i][0]?.transcript ?? '';
      }
      setDraft(`${base}${base && !base.endsWith(' ') ? ' ' : ''}${heard}`);
    };
    rec.onend = () => {
      setListening(false);
      recognition.current = null;
      inputRef.current?.focus();
    };
    rec.onerror = () => {
      setListening(false);
      recognition.current = null;
    };
    recognition.current = rec;
    haptic('light');
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
      recognition.current = null;
    }
  };

  return (
    <>
      <div class="ask-capsule-fade" aria-hidden="true" style={keyboardInset ? { bottom: `${keyboardInset}px` } : undefined} />
      <form
        class={`ask-capsule${listening ? ' listening' : ''}`}
        style={keyboardInset ? { '--kb-inset': `${keyboardInset}px` } : undefined}
        onSubmit={submit}
      >
        {dictation ? (
          <button
            type="button"
            class="ask-capsule-mic"
            aria-label={listening ? 'Stop dictation' : 'Dictate'}
            aria-pressed={listening}
            onClick={toggleDictation}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
            </svg>
          </button>
        ) : null}
        <input
          ref={inputRef}
          class="ask-capsule-input"
          value={draft}
          onInput={(event) => setDraft((event.target as HTMLInputElement).value)}
          placeholder={listening ? 'Listening…' : 'Ask Clementine…'}
          aria-label="Ask Clementine"
          enterkeyhint="send"
          autocomplete="off"
        />
        <button class="ask-capsule-send" type="submit" disabled={!draft.trim()} aria-label="Send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </form>
    </>
  );
}
