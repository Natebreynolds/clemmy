/** Keep capture failures actionable without changing the transcription provider. */
export function microphoneUnavailableReason(): string {
  if (globalThis.isSecureContext === false) return 'The microphone needs a secure connection. Open Clem in the paired app or over HTTPS, then try again.';
  return 'Dictation is not available in this browser. Open Clem in the paired app or a browser that supports microphone recording.';
}

export function microphoneProblem(error: unknown): string {
  const detail = error as { name?: string; error?: string; message?: string } | null;
  const code = detail?.error ?? detail?.name;
  if (code === 'NotAllowedError' || code === 'PermissionDeniedError' || code === 'not-allowed' || code === 'service-not-allowed') {
    if (globalThis.isSecureContext === false) return microphoneUnavailableReason();
    return 'Microphone access was not allowed. Allow microphone access for Clem in your device or browser settings, then tap Dictate again.';
  }
  if (code === 'NotFoundError' || code === 'DevicesNotFoundError' || code === 'audio-capture') return 'No microphone is available. Connect or enable a microphone, then try again.';
  if (code === 'NotReadableError' || code === 'TrackStartError') return 'The microphone could not start. Close any other app using it, then try again.';
  if (code === 'SecurityError') return microphoneUnavailableReason();
  if (code === 'no-speech') return 'No speech was heard. Tap Dictate and speak, then tap Finish dictation.';
  if (code === 'network') return 'The browser’s speech service could not connect. Check your connection, then try again.';
  if (code === 'language-not-supported') return 'The browser’s speech service does not support your device language.';
  return detail?.message || 'Dictation could not finish. Your draft is still here. Try again.';
}

export function appendDictationText(current: string, words: string): string {
  const spoken = words.trim();
  if (!spoken) return current;
  return current.trim() ? `${current.replace(/\s+$/, '')} ${spoken}` : spoken;
}
