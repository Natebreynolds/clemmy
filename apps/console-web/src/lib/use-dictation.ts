/**
 * Dictation for the desktop composer.
 *
 * The microphone is recorded and transcribed ON THIS COMPUTER: the notch's
 * recorder captures 16 kHz mono audio and /api/console/voice/transcribe runs
 * the same local whisper model Meetings uses (an OpenAI key is only its
 * fallback). The words land in the draft; nothing is sent until the owner
 * sends it.
 *
 * It used the browser's Web Speech API. Electron exposes
 * webkitSpeechRecognition, but it cannot work there (the speech service is
 * keyed into Google Chrome builds only), so the Mac and Windows apps showed a
 * microphone that did nothing (owner, 2026-10-08). The phone keeps its own
 * copy, where the system speech recognizer does work.
 *
 * The final transcription only, no live interim: each interim pass re-runs
 * whisper over the whole clip, which costs a loaded machine more than the
 * words appearing a second earlier is worth.
 */
import { useEffect, useRef, useState } from 'react';
import { NotchVoice } from './notch-voice';
import { dictatedDraft } from './dictation-text';

function microphoneRecordingAvailable(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const audio = typeof AudioContext !== 'undefined' || 'webkitAudioContext' in window;
  return Boolean(navigator.mediaDevices?.getUserMedia) && audio;
}

export function useDictation(draft: string, setDraft: (next: string) => void, onEnd?: () => void) {
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available] = useState(microphoneRecordingAvailable);
  const voice = useRef<NotchVoice | null>(null);
  const base = useRef('');
  const setDraftRef = useRef(setDraft);
  setDraftRef.current = setDraft;
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  useEffect(() => () => { voice.current?.cancel(); voice.current = null; }, []);

  const stop = () => {
    const active = voice.current;
    if (!active || !listening) return;
    setListening(false);
    setTranscribing(true);
    void active.stopAndTranscribe()
      .then((heard) => {
        if (voice.current !== active) return;
        if (heard.trim()) setDraftRef.current(dictatedDraft(base.current, heard));
        else setError("I didn't catch that. Try again a little closer to the microphone.");
      })
      .catch((failure: unknown) => {
        if (voice.current === active) setError(failure instanceof Error && failure.message ? failure.message : 'Dictation could not be transcribed.');
      })
      .finally(() => {
        if (voice.current !== active) return;
        voice.current = null;
        setTranscribing(false);
        onEndRef.current?.();
      });
  };

  const toggle = () => {
    if (listening) { stop(); return; }
    if (transcribing) return;
    setError(null);
    base.current = draft;
    const active = new NotchVoice({ onStatus: () => undefined }, { autoSend: false, interim: false });
    voice.current = active;
    setListening(true);
    void active.startRecording().catch((failure: unknown) => {
      if (voice.current !== active) return;
      voice.current = null;
      setListening(false);
      setError(failure instanceof Error && failure.message ? failure.message : 'The microphone could not be opened.');
    });
  };

  return { available, listening, transcribing, error, toggle, stop };
}
