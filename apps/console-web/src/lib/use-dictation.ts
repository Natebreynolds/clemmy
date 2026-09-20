/**
 * Dictation for the desktop composer.
 *
 * The phone has had this since it shipped (apps/mobile-web/src/lib/use-dictation.ts)
 * while the desktop's only microphone lived in the notch meeting surface — so
 * the owner could talk to Clem from the couch but not from the machine the work
 * actually happens on. This is that hook for React.
 *
 * It is a deliberate copy rather than a shared module: @clem/chat-engine is
 * framework-agnostic with no DOM types, and the Web Speech API is nothing but
 * DOM. The two copies differ only in which `useState` they import and in the
 * phone's haptic tap.
 */
import { useEffect, useRef, useState } from 'react';

/** The minimal slice of the Web Speech API this hook uses. */
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

/**
 * Dictation is offered only where the platform actually provides it.
 * A microphone that does nothing is a lie.
 */
export function useDictation(draft: string, setDraft: (next: string) => void, onEnd?: () => void) {
  const [listening, setListening] = useState(false);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const [available] = useState(() => speechRecognitionCtor() !== null);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  useEffect(() => () => { recognition.current?.abort(); }, []);

  const stop = () => {
    recognition.current?.stop();
  };

  const toggle = () => {
    if (listening) {
      stop();
      return;
    }
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    // Captured once, so interim results replace each other instead of
    // stacking onto a draft that is already growing.
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
      onEndRef.current?.();
    };
    rec.onerror = () => {
      setListening(false);
      recognition.current = null;
    };
    recognition.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
      recognition.current = null;
    }
  };

  return { available, listening, toggle, stop };
}
