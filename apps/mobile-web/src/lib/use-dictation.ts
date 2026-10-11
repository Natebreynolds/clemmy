import { useEffect, useRef, useState } from 'preact/hooks';
import { haptic } from './native-bridge';
import { BrowserDictationSession, type DictationPhase, type SpeechRecognitionLike } from './browser-dictation';
import { appendDictationText, microphoneProblem } from './dictation-support';

function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Platform speech is used only on the existing fallback path, never on failure. */
export function useDictation(draft: string, setDraft: (next: string) => void, onEnd?: () => void, isCurrent: () => boolean = () => true) {
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const recognition = useRef<BrowserDictationSession | null>(null);
  const [available] = useState(() => speechRecognitionCtor() !== null);
  const current = useRef({ draft, setDraft, onEnd, isCurrent });
  current.current = { draft, setDraft, onEnd, isCurrent };
  const mounted = useRef(true);

  const cancel = () => {
    recognition.current?.cancel();
    recognition.current = null;
    if (mounted.current) { setPhase('idle'); setError(null); }
  };
  useEffect(() => () => { mounted.current = false; recognition.current?.cancel(); recognition.current = null; }, []);
  const stop = () => { recognition.current?.stop(); };
  const toggle = () => {
    if (recognition.current) { stop(); return; }
    const Ctor = speechRecognitionCtor();
    if (!Ctor || !current.current.isCurrent()) return;
    setError(null);
    let session: BrowserDictationSession;
    const startedInOwner = current.current.isCurrent;
    const owns = () => mounted.current && recognition.current === session && startedInOwner() && current.current.isCurrent();
    try {
      session = new BrowserDictationSession(new Ctor(), {
        state: next => { if (owns()) setPhase(next); },
        words: words => { if (owns()) current.current.setDraft(appendDictationText(current.current.draft, words)); },
        error: message => { if (owns()) setError(message); },
        end: () => { if (owns()) { recognition.current = null; current.current.onEnd?.(); } },
      });
      recognition.current = session;
      haptic('light');
      session.start(navigator.language || 'en-US');
    } catch (failure) {
      cancel();
      setError(microphoneProblem(failure));
    }
  };
  return { available, listening: phase === 'recording', starting: phase === 'starting', transcribing: phase === 'transcribing', error, toggle, stop, cancel };
}
